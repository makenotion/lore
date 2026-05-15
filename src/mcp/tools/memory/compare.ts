import type { LoreServices } from "../../server.js"
import { toolError } from "../../helpers.js"
import {
  appendCompareDispatchLedgerEntry,
  appendCompareNote,
  buildCompareDispatchLedgerEntry,
  hasCompareDispatchLedgerEntry,
  hasMatchingCompareNote,
  recordContradiction,
  recordSupersedence,
  RecordComparedPartialWriteError,
  type RecordComparedResult,
} from "../../../core/memory.js"
import { CONFLICT_JUDGE_PROMPT_VERSION } from "../../../core/prompts/conflict-judge.js"
import type { ToolResult } from "./types.js"
import { ASYMMETRIC_VERDICTS, type CompareVerdict } from "./types.js"

export interface CompareArgs {
  memoryIdA: string
  memoryIdB: string
  verdict: CompareVerdict
  affectedMemoryId?: string
  reason: string
  judgeConfidence?: number
  promptVersion?: string
}

/**
 * Cross-field validation for `affectedMemoryId`. Asymmetric verdicts
 * (`conflicts_with`, `supersedes`) name a loser; symmetric verdicts
 * don't. Throws BEFORE any Notion read so a direction mismatch is
 * caught with zero side effects — `services.memories.getById` must
 * not fire when this throws.
 */
function validateAffectedMemoryId(input: CompareArgs): void {
  const isAsymmetric = ASYMMETRIC_VERDICTS.has(input.verdict)
  if (isAsymmetric) {
    if (!input.affectedMemoryId) {
      throw new Error(
        `verdict='${input.verdict}' requires affectedMemoryId ` +
          "naming the loser memory (memoryIdA or memoryIdB)."
      )
    }
    if (
      input.affectedMemoryId !== input.memoryIdA &&
      input.affectedMemoryId !== input.memoryIdB
    ) {
      throw new Error("affectedMemoryId must equal memoryIdA or memoryIdB.")
    }
  } else {
    if (input.affectedMemoryId) {
      throw new Error(
        `verdict='${input.verdict}' is symmetric; ` + "affectedMemoryId must be omitted."
      )
    }
  }
}

/**
 * Compose the tool-error message body for a post-dispatch
 * `recordCompared` failure. `toolError` only
 * forwards `error.message`, so every diagnostic field the operator
 * needs to manually reconcile lives in the message text itself —
 * structured `readonly` properties on a custom Error class would be
 * dropped before the agent ever sees them.
 *
 * Fields embedded in the message:
 * - `dispatchedFactId` — the fact that landed on the actionable path
 *   (the operator can `lore-fact action='invalidate'` it during
 *   manual cleanup if needed).
 * - `decrementedMemoryId` — the loser whose Confidence Score was
 *   halved.
 * - `compareNotesEntryToWriteA/B` — the NDJSON lines that should
 *   have been appended to each side's Compare Notes.
 * - `comparedWithRelationToWrite` — the pair ids that should appear
 *   in each other's Compared With relation.
 * - `inconsistentState: true` — sentinel marker the operator can
 *   `grep` for in agent transcripts.
 *
 * The agent surfaces this back to the operator instead of pretending
 * the call succeeded. A same-input retry is safe because the
 * confidence decrement now carries an atomic compare-dispatch ledger;
 * the embedded fields remain useful when repeated retries hit the
 * same Notion-side failure and an operator needs to inspect manually.
 */
function inconsistentCompareStateMessage(args: {
  // `null` is the "pair-scope rejected emission" sentinel; same render
  // as the legacy `undefined` ("not-yet-set"). Both collapse to
  // `"(none)"` in the message.
  dispatchedFactId: string | null | undefined
  decrementedMemoryId: string
  compareNotesEntryToWriteA: string
  compareNotesEntryToWriteB: string
  comparedWithRelationToWrite: { memoryIdA: string; memoryIdB: string }
}): string {
  return (
    "Compare dispatch landed but recordCompared failed (inconsistentState: true). " +
    "Compare dispatch state landed or was already present, but the " +
    "audit-marker write (Compare Notes + Compared With on both sides, " +
    "issued via Promise.all) failed. " +
    "Possible states: NEITHER side received its updates; OR one side succeeded " +
    "and the other failed. Retrying the same lore-memory action='compare' is " +
    "safe: the affected memory carries a compare_dispatch ledger marker when " +
    "the confidence update lands, and recordCompared skips any side whose " +
    "final audit entry is already present. If repeated retries fail, INSPECT " +
    "both sides first, then write only the missing audit pieces (do NOT blindly " +
    "apply four updates — appending an NDJSON line that already landed creates " +
    "a duplicate audit entry; re-adding to Compared With is harmless because " +
    "Notion's relation set is set-semantic).\n" +
    `dispatchedFactId=${args.dispatchedFactId ?? "(none)"}\n` +
    `decrementedMemoryId=${args.decrementedMemoryId}\n` +
    `compareNotesEntryToWriteA=${args.compareNotesEntryToWriteA}\n` +
    `compareNotesEntryToWriteB=${args.compareNotesEntryToWriteB}\n` +
    `comparedWithRelationToWrite=${JSON.stringify(args.comparedWithRelationToWrite)}`
  )
}

/**
 * Type-narrow `affectedMemoryId` to a definitely-defined string for
 * the actionable verdict branches. `validateAffectedMemoryId` runs
 * upstream and rejects asymmetric verdicts that omit this field, so
 * this helper is an assertion: it throws with a clear "internal
 * invariant violated" message if a future refactor reorders guards
 * such that an asymmetric branch reaches here without the field set.
 *
 * Cheaper than non-null assertions (`input.affectedMemoryId!`) because
 * a future contributor reading the throw sees what went wrong rather
 * than a TypeError on an undefined property access.
 */
function requireAffectedMemoryId(args: {
  affectedMemoryId?: string
  verdict: string
}): string {
  if (args.affectedMemoryId === undefined) {
    throw new Error(
      "Internal: requireAffectedMemoryId called without " +
        `affectedMemoryId set (verdict='${args.verdict}'). ` +
        "validateAffectedMemoryId should have caught this upstream."
    )
  }
  return args.affectedMemoryId
}

/**
 * Project-set intersection check for the cross-project compare guard.
 * `Project` is a multi-relation on Memories, so a pair is comparable
 * when their project sets intersect — `[P, Q]` and `[Q, R]` share Q
 * → allowed. A vault-wide memory (empty `projectIds`) intersects
 * with NO project set; the guard rejects pairs with no shared
 * project so the dispatch surface stays scoped.
 */
function shareProject(a: { projectIds: string[] }, b: { projectIds: string[] }): boolean {
  if (a.projectIds.length === 0 || b.projectIds.length === 0) return false
  const setB = new Set(b.projectIds)
  return a.projectIds.some((id) => setB.has(id))
}

interface CompareResultInput {
  verdict: CompareVerdict
  memoryA: { id: string; title: string }
  memoryB: { id: string; title: string }
  affectedMemoryId?: string
  /**
   * `null` is the "pair-scope rejected fact emission" signal.
   * The compare verdict landed in Compare
   * Notes on both rows but no broadcast-able derived fact was
   * created. The renderer surfaces a one-line note when this
   * fires so the operator knows the audit state is intact even
   * though the fact graph wasn't updated.
   */
  factId?: string | null
  decremented?: boolean
  alreadyJudged: boolean
  /**
   * `"A"` or `"B"` when this call was a partial-failure recovery
   * (only that side's audit-marker write actually fired this time
   * because the other side already carried the entry from a prior
   * partial-success). `null` for fresh judgments where both sides
   * wrote. Surfaces in the response text so the agent can tell the
   * operator that the pair's audit state is now consistent (rather
   * than silently treating the recovery like a fresh judgment).
   */
  recoveredSide?: "A" | "B" | null
}

/**
 * Render the tool response for `lore-memory action='compare'`. The
 * shape distinguishes the cases the agent needs to branch on:
 * idempotent skip (`alreadyJudged: true`), symmetric verdict
 * (compared-with updated only), actionable verdict with fact id,
 * `supersedes` (which surfaces the same fields as `conflicts_with`
 * but with the supersession framing), and partial-failure recovery
 * (one side caught up to the other after a prior partial-success).
 */
function renderCompareResult(input: CompareResultInput): ToolResult {
  const {
    verdict,
    memoryA,
    memoryB,
    factId,
    decremented,
    alreadyJudged,
    affectedMemoryId,
    recoveredSide,
  } = input
  if (alreadyJudged) {
    return {
      content: [
        {
          type: "text",
          text: [
            `Verdict: ${verdict} — already recorded for this pair (no-op).`,
            `  A: "${memoryA.title}" (${memoryA.id})`,
            `  B: "${memoryB.title}" (${memoryB.id})`,
          ].join("\n"),
        },
      ],
      // Idempotency gate short-circuited before any
      // `recordCompared` / dispatch path ran — Notion was not
      // mutated and the wake-up cache should NOT be invalidated.
      // See `withWakeUpCacheBump`'s docstring for the marker
      // contract.
      noopWrite: true,
    }
  }

  const lines: string[] = []
  if (verdict === "conflicts_with") {
    const loserId = affectedMemoryId
    const loser = loserId === memoryA.id ? memoryA : memoryB
    lines.push(
      `Verdict: conflicts_with — "${loser.title}" (${loser.id}) ${
        decremented === false ? "confidence already halved" : "confidence halved"
      }.`
    )
  } else if (verdict === "supersedes") {
    const loserId = affectedMemoryId
    const loser = loserId === memoryA.id ? memoryA : memoryB
    lines.push(
      `Verdict: supersedes — "${loser.title}" (${loser.id}) marked superseded; ${
        decremented === false ? "confidence already halved" : "confidence halved"
      }.`
    )
  } else {
    lines.push(
      `Verdict: ${verdict} — Compared With and Compare Notes updated on both sides.`
    )
  }
  lines.push(`  A: "${memoryA.title}" (${memoryA.id})`)
  lines.push(`  B: "${memoryB.title}" (${memoryB.id})`)
  if (factId) {
    lines.push(`Fact: ${factId}`)
  }
  if (recoveredSide) {
    const recoveredId = recoveredSide === "A" ? memoryA.id : memoryB.id
    const survivorSide = recoveredSide === "A" ? "B" : "A"
    lines.push(
      `Audit recovery: only side ${recoveredSide} (${recoveredId}) wrote this call (the survivor — side ${survivorSide} — was already audited from a prior partial-success). The pair's audit state is now consistent on both sides.`
    )
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
  }
}

export async function handleCompare(
  services: LoreServices,
  args: CompareArgs
): Promise<ToolResult> {
  try {
    // 1. Self-pair guard. Pure input check, no I/O.
    if (args.memoryIdA === args.memoryIdB) {
      throw new Error("Cannot compare a memory to itself.")
    }

    // 2. Validate direction BEFORE any Notion read. Acceptance criteria
    //    require invalid affectedMemoryId to throw with zero side
    //    effects — direction validation runs immediately after the
    //    self-pair guard, before hydration.
    validateAffectedMemoryId(args)

    // 3. Hydrate both memories (parallel). Needed for project
    //    intersection check, fact subjects, and Compare Notes
    //    membership check.
    const [memoryA, memoryB] = await Promise.all([
      services.memories.getById(args.memoryIdA),
      services.memories.getById(args.memoryIdB),
    ])

    // 4. Cross-project guard. Project intersection required —
    //    pair-with-disjoint-projects has no shared scope to write the
    //    fact under.
    if (!shareProject(memoryA, memoryB)) {
      throw new Error(
        "Cannot compare memories with disjoint project sets. " +
          "Project intersection required."
      )
    }

    // 5. Resolve loser/winner pair. Symmetric verdicts have no loser;
    //    the actionable branches narrow via affectedMemoryId.
    const isAsymmetric = ASYMMETRIC_VERDICTS.has(args.verdict)
    const affectedId = isAsymmetric
      ? requireAffectedMemoryId({
          affectedMemoryId: args.affectedMemoryId,
          verdict: args.verdict,
        })
      : null
    const loser = isAsymmetric
      ? affectedId === args.memoryIdA
        ? memoryA
        : memoryB
      : null
    const winner = isAsymmetric ? (loser === memoryA ? memoryB : memoryA) : null

    const promptVersion = args.promptVersion ?? CONFLICT_JUDGE_PROMPT_VERSION

    // 6. Idempotency gate — pair-scoped via local NDJSON parse, with
    //    direction baked into the key for asymmetric verdicts. Both
    //    sides must carry the final audit entry before we no-op.
    //
    //    The `affected` field on the match is the load-bearing piece
    //    the prior design missed: a corrected judgment with the same
    //    pair/verdict but flipped `affectedMemoryId` (e.g.,
    //    `(A, B, conflicts_with, affected=A)` after
    //    `(A, B, conflicts_with, affected=B)`) MUST re-dispatch. With
    //    direction in the key, the prior entry's `affected=B` does
    //    not match the new query's `affected=A`, the gate clears, and
    //    A is decremented.
    //
    //    Same-verdict idempotent re-calls (same direction) still
    //    short-circuit here with zero side effects: no decrement,
    //    no fact write, no Compare Notes append. Different-verdict
    //    re-calls also fall through (a changed verdict is a
    //    deliberate signal — verdict change is allowed).
    //
    //    The destructive actionable branch is retry-safe because the
    //    affected memory gets a `compare_dispatch` ledger marker in
    //    the same update as the Confidence Score decrement. That lets
    //    actionable verdicts use the same both-sides audit gate as
    //    symmetric verdicts: a retry after one audit side landed
    //    catches up the missing side without double-decrementing.
    const aAlreadyHasEntry = hasMatchingCompareNote(memoryA.compareNotes, {
      target: memoryB.id,
      verdict: args.verdict,
      affected: affectedId,
    })
    const bAlreadyHasEntry = hasMatchingCompareNote(memoryB.compareNotes, {
      target: memoryA.id,
      verdict: args.verdict,
      affected: affectedId,
    })
    const gateHits = aAlreadyHasEntry && bAlreadyHasEntry
    if (gateHits) {
      return renderCompareResult({
        verdict: args.verdict,
        memoryA,
        memoryB,
        affectedMemoryId: args.affectedMemoryId,
        alreadyJudged: true,
      })
    }

    // 7. Compose audit-trail entries and PREFLIGHT only the sides
    //    that `recordCompared` would actually write. The preflight's
    //    job is to catch overflow BEFORE a destructive
    //    `recordContradiction` / `recordSupersedence` could fire and
    //    leave a halved memory with no audit marker. But preflight
    //    must mirror `recordCompared`'s per-side idempotent skip:
    //    a side whose loaded snapshot already carries the matching
    //    `(target, verdict, affected)` entry will be SKIPPED by
    //    `recordCompared` and so does NOT need overflow validation
    //    — and preflighting it on a near-cap side would erroneously
    //    throw on a partial-failure recovery, blocking the missing
    //    side's write even though `recordCompared` would have
    //    handled the safe case correctly.
    //
    //    The two side-presence flags computed here are reused by the
    //    response renderer (`recoveredSide`) so the agent can
    //    surface "only side X wrote this call" when the retry was
    //    a one-sided catch-up.
    const judgedAt = new Date().toISOString()
    const entryA = {
      verdict: args.verdict,
      target: args.memoryIdB,
      affected: affectedId,
      reason: args.reason,
      judgedAt,
      promptVersion,
    }
    const entryB = {
      verdict: args.verdict,
      target: args.memoryIdA,
      affected: affectedId,
      reason: args.reason,
      judgedAt,
      promptVersion,
    }
    let preflightNotesA = memoryA.compareNotes
    let preflightNotesB = memoryB.compareNotes
    let legacyPartialAuditWithoutLedger = false
    let forceRecordA = false
    let forceRecordB = false
    if (isAsymmetric) {
      const ledgerEntry = buildCompareDispatchLedgerEntry({
        verdict: args.verdict as "conflicts_with" | "supersedes",
        sourceMemoryId: winner!.id,
        affectedMemoryId: loser!.id,
      })
      const loserHasLedger = hasCompareDispatchLedgerEntry(loser!.compareNotes, {
        dispatchKey: ledgerEntry.dispatchKey,
        step: "confidence_decrement",
      })
      legacyPartialAuditWithoutLedger =
        (aAlreadyHasEntry || bAlreadyHasEntry) && !loserHasLedger
      if (!loserHasLedger) {
        if (loser!.id === memoryA.id) {
          preflightNotesA = appendCompareDispatchLedgerEntry(preflightNotesA, ledgerEntry)
          forceRecordA = aAlreadyHasEntry
        } else {
          preflightNotesB = appendCompareDispatchLedgerEntry(preflightNotesB, ledgerEntry)
          forceRecordB = bAlreadyHasEntry
        }
      }
    }
    if (!aAlreadyHasEntry) appendCompareNote(preflightNotesA, entryA)
    if (!bAlreadyHasEntry) appendCompareNote(preflightNotesB, entryB)

    // 8. Dispatch on actionable verdicts. Only fires after the
    //    overflow preflight clears, so a destructive decrement + fact
    //    write never lands without a corresponding audit-trail entry
    //    being writable.
    //
    //    The supersedes-non-decision guard is the spec's "non-decision
    //    affected target throws" — runs BEFORE the dispatch helper so
    //    a non-decision pair never hits `decisions.supersede`.
    let dispatchResult: {
      // `factId` may be `null` when the pair-scope rule rejected
      // fact emission. The compare verdict
      // still landed in Compare Notes; the broadcast-able derived
      // fact was skipped to avoid leaking the narrower row's title
      // across the broader reader context. `factEmissionSkippedReason`
      // carries an operator-facing description in that case.
      factId?: string | null
      affectedMemoryId?: string
      affectedCompareNotes?: string
      decremented?: boolean
      factEmissionSkippedReason?: string
    } = {}

    if (args.verdict === "supersedes" && loser!.kind !== "decision") {
      throw new Error(
        "verdict='supersedes' requires the affected (superseded) " +
          "memory to have kind='decision'. For non-decision pairs, " +
          "use 'compatible' + lore-memory action='update' to merge, " +
          "or promote via lore-decision action='create' supersedesIds."
      )
    }

    if (legacyPartialAuditWithoutLedger) {
      dispatchResult = {
        affectedMemoryId: loser!.id,
        affectedCompareNotes:
          loser!.id === memoryA.id ? preflightNotesA : preflightNotesB,
        decremented: false,
      }
    } else if (args.verdict === "conflicts_with") {
      const result = await recordContradiction(services, {
        contradictedMemory: loser!,
        sourceMemory: winner!,
        judgeConfidence: args.judgeConfidence,
      })
      dispatchResult = {
        ...result,
        affectedMemoryId: loser!.id,
      }
    } else if (args.verdict === "supersedes") {
      const result = await recordSupersedence(services, {
        supersedingMemory: winner!,
        supersededMemory: loser!,
        judgeConfidence: args.judgeConfidence,
      })
      dispatchResult = {
        ...result,
        affectedMemoryId: loser!.id,
      }
    }

    // 9. Audit-marker write (Compare Notes + Compared With on both
    //    sides). The preflight in step 7 already validated both sides
    //    will accept the append. `recordCompared` is per-side
    //    idempotent (skips a side whose loaded snapshot already
    //    carries the matching entry), so a partial-failure recovery
    //    retry writes only the missing side without duplicating the
    //    successful one. The returned `RecordComparedResult` tells us
    //    which sides actually landed a write so the response text
    //    can distinguish "fresh judgment" from "recovery completion."
    //
    //    Failure modes:
    //    - Actionable verdict + recordCompared throws → dispatch
    //      already landed, audit may be partial. The retry is safe
    //      because the affected memory now carries the dispatch ledger
    //      and `recordCompared` is per-side idempotent. The structured
    //      message still embeds the audit entries for operators who
    //      need to inspect repeated failures.
    //    - Symmetric verdict + recordCompared throws → no destructive
    //      dispatch happened, but the per-side write may have left
    //      one side updated and the other not. A naive retry is now
    //      safe: the per-side idempotent skip in `recordCompared` AND
    //      the both-sides gate at step 6 together ensure the retry
    //      writes only the missing side. Rethrow the underlying error
    //      so the operator (or agent) can see what failed and decide
    //      whether to retry.
    const memoryAForRecord =
      dispatchResult.affectedMemoryId === memoryA.id &&
      dispatchResult.affectedCompareNotes !== undefined
        ? { ...memoryA, compareNotes: dispatchResult.affectedCompareNotes }
        : memoryA
    const memoryBForRecord =
      dispatchResult.affectedMemoryId === memoryB.id &&
      dispatchResult.affectedCompareNotes !== undefined
        ? { ...memoryB, compareNotes: dispatchResult.affectedCompareNotes }
        : memoryB
    let recordResult: RecordComparedResult
    try {
      recordResult = await services.memories.recordCompared({
        memoryA: memoryAForRecord,
        memoryB: memoryBForRecord,
        verdict: args.verdict,
        affected: affectedId,
        reason: args.reason,
        judgedAt,
        promptVersion,
        forceWriteA: forceRecordA,
        forceWriteB: forceRecordB,
      })
    } catch (err) {
      // Single-shot self-heal for partial-success on the symmetric
      // audit-marker write: one side's `pages.update` landed, the
      // other rejected. `recordCompared` now surfaces this through
      // `RecordComparedPartialWriteError` instead of swallowing the
      // success behind an opaque `Promise.all` rejection. Reload both
      // memories so the per-side idempotency check sees the survivor's
      // newly-landed audit entry, then retry once. Per-side idempotent
      // skip + the structurally-fresh snapshot guarantee the retry
      // writes only the missing side without duplicating the audit
      // line on the survivor.
      //
      // Skipped under `legacyPartialAuditWithoutLedger`: that branch
      // appends the dispatch ledger to a side that already has the
      // final audit entry (legacy state from before the ledger
      // existed). The ledger append is composed locally and lives on
      // the patched `preflightNotes`, NOT in Notion. A reload-then-
      // retry without re-applying the local patch would write back
      // the loser's compareNotes WITHOUT the ledger — silently
      // dropping the ledger line. Re-deriving the patched notes from
      // a fresh snapshot is doable but expands the surface; the
      // legacy partial-audit path is rare enough that falling
      // through to the structured inconsistent-state error is the
      // right tradeoff for this fix.
      if (
        err instanceof RecordComparedPartialWriteError &&
        !legacyPartialAuditWithoutLedger
      ) {
        try {
          const [freshA, freshB] = await Promise.all([
            services.memories.getById(args.memoryIdA),
            services.memories.getById(args.memoryIdB),
          ])
          // Force-write flags are explicitly false on the retry path:
          // `forceRecordA`/`forceRecordB` are only ever assigned inside
          // the `legacyPartialAuditWithoutLedger` branch (steps 7's
          // `!loserHasLedger` arm), and this retry is gated on that
          // flag being false. Keeping the assignment textual rather
          // than relying on closure scope across two distant code
          // blocks defends against a future contributor moving a
          // `forceRecord*` assignment outside the legacy branch.
          recordResult = await services.memories.recordCompared({
            memoryA: freshA,
            memoryB: freshB,
            verdict: args.verdict,
            affected: affectedId,
            reason: args.reason,
            judgedAt,
            promptVersion,
            forceWriteA: false,
            forceWriteB: false,
          })
        } catch (retryErr) {
          // Reload or retry rejected. Fall through to the structured
          // inconsistent-state error so the operator can manually
          // reconcile. The original partial-success is referenced via
          // `cause` for diagnostic forensics; the retry rejection is
          // the proximate failure operators see in the message.
          if (isAsymmetric) {
            throw new Error(
              inconsistentCompareStateMessage({
                dispatchedFactId: dispatchResult.factId,
                decrementedMemoryId: loser!.id,
                compareNotesEntryToWriteA: JSON.stringify(entryA),
                compareNotesEntryToWriteB: JSON.stringify(entryB),
                comparedWithRelationToWrite: {
                  memoryIdA: args.memoryIdA,
                  memoryIdB: args.memoryIdB,
                },
              }),
              { cause: retryErr }
            )
          }
          throw retryErr
        }
      } else if (isAsymmetric) {
        throw new Error(
          inconsistentCompareStateMessage({
            dispatchedFactId: dispatchResult.factId,
            decrementedMemoryId: loser!.id,
            compareNotesEntryToWriteA: JSON.stringify(entryA),
            compareNotesEntryToWriteB: JSON.stringify(entryB),
            comparedWithRelationToWrite: {
              memoryIdA: args.memoryIdA,
              memoryIdB: args.memoryIdB,
            },
          }),
          { cause: err }
        )
      } else {
        // Symmetric verdict — no destructive dispatch happened. The
        // per-side idempotent recordCompared + both-sides gate at
        // step 6 make a retry safely repairing: the side that already
        // landed is skipped on retry, only the missing side writes.
        throw err
      }
    }

    return renderCompareResult({
      verdict: args.verdict,
      memoryA,
      memoryB,
      affectedMemoryId: args.affectedMemoryId,
      factId: dispatchResult.factId,
      decremented: dispatchResult.decremented,
      alreadyJudged: false,
      recoveredSide:
        recordResult.wroteA && recordResult.wroteB
          ? null
          : recordResult.wroteA
            ? "A"
            : recordResult.wroteB
              ? "B"
              : null,
    })
  } catch (err) {
    return toolError(err)
  }
}
