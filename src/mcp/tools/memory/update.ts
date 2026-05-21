import type { LoreServices } from "../../server.js"
import { debugLogAutoFactFailure, toolError } from "../../helpers.js"
import { debugLogPartialFailures } from "../../../observability/partial-failure.js"
import { resolveProjectIds } from "../../resolve.js"
import { scopesMatchForMerge } from "../../../core/fact.js"
import {
  MemoryUpdatePartialFailureError,
  PartialUpdateError,
  RekeyAuditError,
} from "../../../core/memory.js"
import { extractEntityCandidates } from "../../../core/near-duplicate.js"
import { resolveFeatureFlags } from "../../../feature-flags.js"
import { decodeTextEntities } from "../../../notion/html-entities.js"
import type {
  Fact,
  Memory,
  MemoryConfidence,
  MemoryKind,
  MemoryStatus,
} from "../../../types.js"
import { memoryScopeToInput } from "../../../types.js"
import type { ToolResult } from "./types.js"
import { CONFIDENCES, KINDS, STATUSES } from "./types.js"

// Required Markdown section headings on a `kind: 'procedure'` row's
// body. Mirrors the sections `composeProcedureBody` produces at
// propose-time. A content update that drops any of these leaves the
// row a procedure-in-name-only; the `handleUpdate` body-shape gate
// rejects such updates so the structural contract holds across the
// row's lifetime.
const PROCEDURE_REQUIRED_SECTIONS = [
  "## Activation Conditions",
  "## Steps",
  "## Sources",
] as const

// Sections whose body must contain at least one nonblank line.
// Mirrors the propose-time contract: `## Steps` is `min(1)` of
// `nonBlankString` at the schema layer and `## Sources` is
// `min(PROCEDURE_MIN_SOURCES)` page ids — so an accepted procedure
// always has real content under both. A content update that empties
// either section leaves a structurally-valid-but-meaningless
// procedure row; the gate rejects so update parity with propose
// holds end-to-end.
const PROCEDURE_NONEMPTY_SECTIONS = ["## Steps", "## Sources"] as const

/**
 * Return the body of a procedure section — every line after the
 * matching `## <heading>` line until the next `## ` heading or end
 * of body. Returned text retains intra-section newlines but is
 * trimmed at both ends so a section containing only whitespace
 * returns the empty string.
 */
function extractProcedureSectionBody(body: string, heading: string): string {
  const headingPattern = new RegExp(`^${heading}\\s*$`, "m")
  const headingMatch = headingPattern.exec(body)
  if (!headingMatch) return ""
  const afterHeadingIdx = headingMatch.index + headingMatch[0].length
  const remainder = body.slice(afterHeadingIdx)
  const nextHeadingMatch = /^## /m.exec(remainder)
  const section =
    nextHeadingMatch !== null ? remainder.slice(0, nextHeadingMatch.index) : remainder
  return section.trim()
}

export interface UpdateArgs {
  memoryId: string
  title?: string
  content?: string
  tags?: string[]
  keywords?: string
  synopsis?: string
  projectName?: string
  projectNames?: string[]
  topicName?: string
  forceNewTopic?: boolean
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  confidence?: (typeof CONFIDENCES)[number]
  reviewBy?: string | null
  decidedAt?: string | null
  supersedesIds?: string[]
  affectsIds?: string[]
  alternatives?: string
  consequences?: string
  topicKey?: string
  scope?: import("../../../types.js").MemoryScopeInput
}

export async function handleUpdate(
  services: LoreServices,
  args: UpdateArgs
): Promise<ToolResult> {
  try {
    const features = services.features ?? resolveFeatureFlags()
    // Reject illegal combinations BEFORE any I/O. Re-keying preserves
    // identity (kind is part of identity); a combined `topicKey + kind`
    // update would smuggle a kind change through the residual update
    // path and silently split an upsert chain across two kinds.
    // Operators that genuinely need both issue two separate calls.
    if (args.topicKey !== undefined && args.kind !== undefined) {
      throw new Error(
        "Cannot combine `topicKey` (re-key) with `kind` change in a " +
          "single update. Re-keying preserves identity; the kind belongs " +
          "to the upsert chain. Issue two separate updates if you need " +
          "both, or rethink whether the chain should change kind at all " +
          "(it usually shouldn't)."
      )
    }
    if (args.topicKey?.startsWith("state/")) {
      throw new Error(
        "Cannot re-key a memory into the reserved `state/` namespace. " +
          "State topic keys are derived from subject-canonical saves with subject and replace=true."
      )
    }

    // Detect whether anything beyond the framing fields (`action`,
    // `memoryId`, `topicKey`) was passed. A topicKey-only update is a
    // pure re-key and must NOT call `services.memories.update` —
    // pinned by the re-key acceptance criteria. Stripping via
    // destructure keeps the gate honest: adding a future field to
    // `UpdateArgs` automatically counts toward the content-delta
    // check without re-listing every key. `action` is included in
    // the strip set because Zod's discriminated-union output carries
    // the discriminator literal verbatim, and a non-undefined value
    // would otherwise flip the gate to true on every update call.
    const argsRecord = args as unknown as Record<string, unknown>
    const { action: _a, memoryId: _m, topicKey: _t, ...contentDelta } = argsRecord
    void _a
    void _m
    void _t
    const hasContentDelta = Object.values(contentDelta).some((v) => v !== undefined)

    let projectIds: string[] | undefined
    const warnings: string[] = []

    // Lazy memo for the pre-mutation memory snapshot. Three handler
    // branches need it on the worst-case path: the procedure-kind
    // update gate (pre-mutation kind/status check), the topicName
    // scope fallback (pre-mutation projectIds), and the empty-args
    // return shape. Without this, the worst-case update issued three
    // `pages.retrieve` round-trips against Notion for the same id.
    // The re-key preflight below seeds the memo when it runs, so a
    // combined topicKey + kind/status update collapses to a single
    // Notion read. Storing the in-flight promise (not the resolved
    // value) also collapses concurrent reads if a future branch
    // awaits it from multiple call sites.
    let currentMemo: Promise<Memory> | undefined
    const loadCurrent = (): Promise<Memory> => {
      if (!currentMemo) currentMemo = services.memories.getById(args.memoryId)
      return currentMemo
    }
    const primeCurrent = (memory: Memory): void => {
      if (!currentMemo) currentMemo = Promise.resolve(memory)
    }

    // Explicit project scope is strict even on update. Resolve it before
    // re-key preflight because `validateRekey` reads the target Memory and
    // collision candidates; an invalid explicit project must win the
    // error-ordering race before any scoped read or write starts.
    if (args.projectNames !== undefined || args.projectName !== undefined) {
      const resolved = await resolveProjectIds(
        services,
        args.projectName,
        args.projectNames
      )
      projectIds = resolved.ids.length > 0 ? resolved.ids : undefined
      warnings.push(...resolved.warnings)
    }

    // Preflight the re-key BEFORE any content-delta mutation. If the
    // re-key would reject (collision against current state, empty
    // `projectIds`), we throw cleanly without leaving an update
    // half-persisted. The validation is non-mutating — it loads the
    // memory and runs the collision query against the current
    // project-set, but writes nothing.
    //
    // The race window between preflight and the actual mutation is
    // documented in `MemoryService.validateRekey`'s docstring: a
    // concurrent grab of the new key, or a content-delta that
    // changes `projectIds` and exposes a fresh collision under the
    // post-update set, both fall through to the `try/catch` around
    // the actual `rekeyTopicKey` call below — which surfaces a
    // `PartialUpdateError` when content has already landed.
    let preflight: { oldTopicKey: string; willRekey: boolean } | undefined
    if (args.topicKey !== undefined) {
      const result = await services.memories.validateRekey({
        memoryId: args.memoryId,
        newTopicKey: args.topicKey,
      })
      if (result.memory.kind === "state") {
        throw new Error(
          "Cannot re-key a state memory through lore-memory action='update'. " +
            "State topic keys are derived from subject-canonical saves with subject and replace=true."
        )
      }
      preflight = {
        oldTopicKey: result.oldTopicKey,
        willRekey: result.willRekey,
      }
      // `validateRekey` already loaded the pre-mutation memory to
      // check the old key, project-set, and collision candidates.
      // Seed the handler-level memo so the procedure-kind gate and
      // the topicName scope fallback don't re-issue a second Notion
      // read for the same id.
      primeCurrent(result.memory)
    }

    const stateGuardedFields: string[] = []
    if (args.content !== undefined) {
      stateGuardedFields.push("content")
    }
    if (args.projectName !== undefined || args.projectNames !== undefined) {
      stateGuardedFields.push("project scope")
    }
    if (stateGuardedFields.length > 0) {
      const current = await loadCurrent()
      if (current?.kind === "state") {
        throw new Error(
          `lore-memory action='update' cannot change a state memory's ${stateGuardedFields.join(
            " and "
          )}. ` +
            "State memories are subject-canonical current-state rows; use lore-memory action='save' " +
            "with subject and replace=true so Lore appends a revision and preserves the exact project scope used for future history lookups."
        )
      }
    }

    let topicId: string | undefined
    let topicLabel: string | undefined
    let updated: Memory | undefined

    // Procedure-kind update gate. The procedure lifecycle has audit
    // blocks on every transition, and the generic update path would
    // erase them. Seven failure modes the propose-path / approve /
    // reject / deprecate contracts exist to prevent:
    //
    // 1. Cross-kind promotion to `procedure` via update — bypasses
    //    `resolveProcedureSources`, `PROCEDURE_MIN_SOURCES`, the
    //    body composer, and `recordReview`'s audit block. Same
    //    failure mode as the `kind: procedure` save-path block.
    //
    // 2. proposed → accepted on a procedure row via update —
    //    `lore-memory action='approve'` (`recordReview`) is the
    //    only path that writes the `## Reviewed (YYYY-MM-DD)`
    //    audit with the reviewer identity. A bare status flip
    //    erases that audit.
    //
    // 3. proposed → rejected on a procedure row via update —
    //    `lore-memory action='reject'` (`recordReview`) is the
    //    symmetric path; same audit-erasure concern.
    //
    // 4. accepted → deprecated on a procedure row via update —
    //    `lore-procedure action='deprecate'` composes the
    //    `## Deprecated (YYYY-MM-DD)` audit block AND enforces the
    //    status-boundary gate (rejects proposed/superseded/rejected
    //    rows so they don't accidentally hit deprecated). A bare
    //    update would skip both.
    //
    // 5. procedure → other-kind demotion via update — the row
    //    keeps its `## Steps` / `## Sources` body but loses its
    //    Kind classification, dropping out of procedure-specific
    //    recall / wake-up rendering. Reject any kind change on an
    //    existing procedure row.
    //
    // 6. accepted → superseded on a procedure row via update —
    //    same audit-bypass class as deprecated: drops the row out
    //    of accepted recall without a `## Deprecated` audit and
    //    without guaranteeing a replacement relation.
    //
    // 7. terminal/accepted → proposed reset via update — would
    //    let an operator flip a deprecated / superseded / rejected
    //    procedure back into the inbox and re-approve it via
    //    `recordReview`, bypassing every audit block that
    //    documented the terminal transition.
    //
    // Only fire the gate when the request actually touches kind or
    // status; content-only updates on existing procedure rows
    // (body edits, keyword adjustments) flow through unchanged.
    //
    // `hasContentDelta` is implied — `contentDelta` strips only
    // `action`/`memoryId`/`topicKey`, so any `args.kind` or
    // `args.status` value automatically flips `hasContentDelta` to
    // true. Gating purely on the guarded fields is equivalent and
    // reads more directly.
    if (args.kind !== undefined || args.status !== undefined) {
      const current = await loadCurrent()
      if (args.kind === "state" && current.kind !== "state") {
        throw new Error(
          `lore-memory action='update' cannot promote kind='${current.kind}' to kind='state'. ` +
            "State memories must be created through subject-canonical saves with subject and replace=true, " +
            "so Lore derives one stable state topic key and preserves history in the revision chain."
        )
      }
      if (current.kind === "state" && args.kind !== undefined && args.kind !== "state") {
        throw new Error(
          `lore-memory action='update' cannot demote a state memory to kind='${args.kind}'. ` +
            "State memory identity is tied to its subject-canonical topic key; changing kind would corrupt the current-state chain."
        )
      }
      // (1) Cross-kind promotion to procedure.
      if (args.kind === "procedure" && current.kind !== "procedure") {
        throw new Error(
          `lore-memory action='update' cannot promote kind='${current.kind}' to kind='procedure'. ` +
            "Procedures must be created via lore-procedure action='propose', which validates " +
            "supporting source memories, enforces the minimum-sources gate, probes the topic-key " +
            "slot for idempotency, and lands the row at Status: proposed for inbox review. " +
            "Cross-kind promotion via update would bypass every one of those gates."
        )
      }
      if (current.kind === "procedure") {
        // (5) Demotion away from procedure.
        if (args.kind !== undefined && args.kind !== "procedure") {
          throw new Error(
            `lore-memory action='update' cannot demote a procedure to kind='${args.kind}'. ` +
              "The row's body carries procedure-specific `## Activation Conditions` / " +
              "`## Steps` / `## Sources` sections that would be orphaned by a kind change; " +
              "the row would also drop out of procedure-specific recall and wake-up rendering. " +
              `If the procedure is no longer current, use lore-procedure action='deprecate' ` +
              `with memoryId='${args.memoryId}' instead.`
          )
        }
        // (2) proposed → accepted.
        if (args.status === "accepted" && current.status !== "accepted") {
          throw new Error(
            `lore-memory action='update' cannot flip a procedure to status='accepted'. ` +
              "Approval is the inbox-review path — use lore-memory action='approve' " +
              `with memoryId='${args.memoryId}' so the \`## Reviewed (YYYY-MM-DD)\` audit ` +
              "block lands with the reviewer's identity. Bare status flips erase that audit."
          )
        }
        // (3) proposed → rejected. The `current.status === "proposed"`
        // check implies `current.status !== "rejected"`; a separate
        // clause would be dead code.
        if (args.status === "rejected" && current.status === "proposed") {
          throw new Error(
            `lore-memory action='update' cannot flip a proposed procedure to status='rejected'. ` +
              "Rejection is the inbox-review path — use lore-memory action='reject' " +
              `with memoryId='${args.memoryId}' so the \`## Reviewed (YYYY-MM-DD)\` audit ` +
              "block lands with the reviewer's identity."
          )
        }
        // (7) terminal/accepted → proposed reset. An operator could
        // otherwise flip a deprecated / superseded / rejected /
        // accepted procedure back to `Status: proposed` via update,
        // then run `lore-memory action='approve'` and resurrect the
        // row as accepted — bypassing both `## Deprecated` and
        // `## Reviewed` audit history on the resurrection path
        // (`recordReview` only requires `current.status === 'proposed'`).
        // No legitimate workflow needs a procedure to go backwards
        // in the lifecycle; revisions ship as fresh proposals with
        // `supersedesIds` instead.
        if (args.status === "proposed" && current.status !== "proposed") {
          throw new Error(
            `lore-memory action='update' cannot reset a procedure to status='proposed' (current: ${current.status}). ` +
              "Procedures don't go backwards in the lifecycle — a deprecate / supersede / reject / accept transition " +
              "is terminal for that row. Ship a revision as a fresh proposal via " +
              `lore-procedure action='propose' with \`supersedesIds: [${args.memoryId}]\` so the audit chain stays intact.`
          )
        }
        // (4) accepted/informational → deprecated.
        if (args.status === "deprecated" && current.status !== "deprecated") {
          throw new Error(
            `lore-memory action='update' cannot flip a procedure to status='deprecated'. ` +
              "Procedure deprecation has its own audit surface — use " +
              `lore-procedure action='deprecate' memoryId='${args.memoryId}' so the ` +
              "`## Deprecated (YYYY-MM-DD)` audit block lands and the status-boundary " +
              "gate (rejects proposed / superseded / rejected rows) enforces correctness."
          )
        }
        // (6) accepted/informational → superseded. Same audit-bypass
        // class as the deprecated path: drops the procedure out of
        // accepted recall without a `## Deprecated` audit block AND
        // without guaranteeing a replacement relation. The procedure
        // supersession workflow is propose-replacement-with-
        // `supersedesIds` → approve → deprecate-predecessor; a bare
        // status flip skips every step.
        if (args.status === "superseded" && current.status !== "superseded") {
          throw new Error(
            `lore-memory action='update' cannot flip a procedure to status='superseded'. ` +
              "Procedure replacement is a two-step workflow: propose the replacement via " +
              "lore-procedure action='propose' with `supersedesIds: [" +
              args.memoryId +
              "]`, approve it through the inbox, then deprecate this row via " +
              `lore-procedure action='deprecate' memoryId='${args.memoryId}'. ` +
              "A bare status flip drops this row out of accepted recall without a " +
              "`## Deprecated` audit block and without guaranteeing a replacement relation."
          )
        }
      }
    }

    // Body-shape invariant on procedure rows. A content update on a
    // kind='procedure' row replaces the full body, and the structured
    // `## Activation Conditions` / `## Steps` / `## Sources` sections
    // are what makes the row a procedure (not just a note tagged
    // `procedure`). Without this check, an agent calling
    // `lore-memory action='update'` with `{ memoryId, content: "lol" }`
    // would silently blank those sections and leave the row a
    // procedure-in-name-only. The kind/status gate above doesn't fire
    // on a pure content update, so this is the chokepoint.
    //
    // The check fires only when `args.content` is being written; other
    // content fields (`title`, `keywords`, `synopsis`) don't touch the
    // body, and a content-untouched update leaves the body's existing
    // sections intact.
    if (args.content !== undefined) {
      const current = await loadCurrent()
      if (current?.kind === "procedure") {
        const newContent = args.content
        const missingHeaders = PROCEDURE_REQUIRED_SECTIONS.filter(
          (heading) => !new RegExp(`^${heading}\\s*$`, "m").test(newContent)
        )
        if (missingHeaders.length > 0) {
          throw new Error(
            `lore-memory action='update' cannot blank the procedure body's required sections. ` +
              `The new content is missing: ${missingHeaders.join(", ")}. ` +
              "Procedures render under structured sections; an update that drops them leaves " +
              "a procedure-in-name-only row. Pass content that retains the three section headers " +
              "(`## Activation Conditions`, `## Steps`, `## Sources`), or deprecate the procedure " +
              `via lore-procedure action='deprecate' memoryId='${args.memoryId}' if it's no longer current.`
          )
        }
        // Headers alone aren't enough — a body like `## Activation
        // Conditions\n## Steps\n## Sources` would pass the
        // presence check while wiping every step and source line.
        // Mirror the propose-time minimum-content contract: at
        // least one nonblank line under `## Steps` and at least
        // one nonblank line under `## Sources`.
        const emptySections = PROCEDURE_NONEMPTY_SECTIONS.filter(
          (heading) => extractProcedureSectionBody(newContent, heading).length === 0
        )
        if (emptySections.length > 0) {
          throw new Error(
            `lore-memory action='update' cannot leave a procedure's structural section${
              emptySections.length === 1 ? "" : "s"
            } empty. ` +
              `The new content has the header${
                emptySections.length === 1 ? "" : "s"
              } but no body under: ${emptySections.join(", ")}. ` +
              "Procedures require at least one nonblank step under `## Steps` and at least one " +
              "nonblank source line under `## Sources` (same contract `lore-procedure action='propose'` " +
              "enforces at create time). Pass content with usable body under each required section, " +
              `or deprecate the procedure via lore-procedure action='deprecate' memoryId='${args.memoryId}'.`
          )
        }
      }
    }

    // Apply content delta FIRST. Re-key (when present) runs AFTER so
    // the audit-block append is the LAST write to the body —
    // otherwise `MemoryService.update`'s full-body `replace_content`
    // would clobber the audit block that `rekeyTopicKey` just
    // appended. Reversing the dispatch order here is what makes a
    // combined `topicKey + content` call land both writes durably.
    if (hasContentDelta) {
      if (args.topicName) {
        let topicScope = projectIds
        if (!topicScope || topicScope.length === 0) {
          const current = await loadCurrent()
          if (current.projectIds.length > 0) {
            topicScope = current.projectIds
          } else if (services.context.project) {
            topicScope = [services.context.project.id]
          }
        }
        if (!topicScope || topicScope.length === 0) {
          warnings.push(
            `Topic "${args.topicName}" skipped (requires at least one project)`
          )
        } else {
          const topic = await services.topics.getOrCreate(args.topicName, topicScope, {
            forceNew: args.forceNewTopic,
          })
          topicId = topic.id
          topicLabel = topic.name
        }
      }

      try {
        updated = await services.memories.update(args.memoryId, {
          title: args.title,
          content: args.content,
          tags: args.tags,
          keywords: args.keywords,
          synopsis: args.synopsis,
          projectIds,
          topicId,
          kind: args.kind as MemoryKind | undefined,
          status: args.status as MemoryStatus | undefined,
          confidence: args.confidence as MemoryConfidence | undefined,
          reviewBy: args.reviewBy,
          decidedAt: args.decidedAt,
          supersedesIds: args.supersedesIds,
          affectsIds: args.affectsIds,
          alternatives: args.alternatives,
          consequences: args.consequences,
          // Scope / lifetime update. Same `MemoryScopeInput`
          // shape as save; absent fields leave columns untouched, explicit
          // `null` clears select / date columns, empty strings clear
          // rich_text columns.
          scope: args.scope,
        })
      } catch (err) {
        if (
          err instanceof MemoryUpdatePartialFailureError &&
          args.topicKey !== undefined &&
          preflight?.willRekey !== false
        ) {
          throw new MemoryUpdatePartialFailureError(
            `${err.message} The requested re-key to '${args.topicKey}' ` +
              `was not attempted because the body write failed before ` +
              `the re-key step. Re-issue the re-key separately after ` +
              `repairing the body update.`,
            {
              memoryId: err.memoryId,
              bodyWriteError: err.bodyWriteError,
            }
          )
        }
        throw err
      }
    }

    // Re-key SECOND. `rekeyTopicKey` reads the post-content body
    // (via its internal `getById`) so the audit block is appended on
    // top of any content the prior `MemoryService.update` wrote.
    // Short-circuits as a no-op when the new key matches existing —
    // pin verified by `MemoryService.rekeyTopicKey`'s tests.
    //
    // `PartialUpdateError` wraps the re-key failure when the
    // content delta has already landed, so the operator gets a
    // clear signal that part of the requested mutation persisted.
    // The preflight above catches the most common failure modes
    // (collision, empty-projectIds) before this point — a
    // `PartialUpdateError` here means the preflight passed but
    // the actual mutation rejected (race, transient Notion
    // failure, post-update projectIds change exposing a fresh
    // collision). When no content delta accompanied the re-key,
    // the underlying error propagates unchanged because nothing
    // was partially applied.
    let rekeyed = false
    let oldTopicKey: string | undefined
    let topicKeyUnchanged = false
    if (args.topicKey !== undefined) {
      if (preflight && !preflight.willRekey) {
        // No-op short-circuit path: the new key matches the
        // existing one, so `rekeyTopicKey` would do nothing. Track
        // the no-op state so the response can acknowledge the
        // intent rather than silently dropping it. Skip the
        // service call entirely — the preflight already loaded
        // the memory and confirmed equality.
        topicKeyUnchanged = true
        oldTopicKey = preflight.oldTopicKey
      } else {
        try {
          const result = await services.memories.rekeyTopicKey({
            memoryId: args.memoryId,
            newTopicKey: args.topicKey,
          })
          updated = result.memory
          if (result.oldTopicKey !== args.topicKey) {
            rekeyed = true
            oldTopicKey = result.oldTopicKey
          }
        } catch (err) {
          // `RekeyAuditError` describes a DIFFERENT partial state
          // from `PartialUpdateError`: the Topic Key property
          // already persisted (the load-bearing identity change
          // landed) and only the audit-block append failed.
          // Wrapping it in `PartialUpdateError` would falsely
          // claim "the topic key is unchanged" and instruct an
          // unnecessary retry — but a retry would short-circuit
          // through `validateRekey`'s no-op guard because the new
          // key now matches the stored value. Propagate
          // `RekeyAuditError` unchanged; its own message
          // accurately describes the rekey-side state, and the
          // operator who issued the combined call already knows
          // the content delta was attempted in the same request.
          if (err instanceof RekeyAuditError) {
            throw err
          }
          if (hasContentDelta) {
            const cause = err instanceof Error ? err.message : String(err)
            throw new PartialUpdateError(
              `Content update for memory ${args.memoryId} persisted, ` +
                `but the subsequent re-key to '${args.topicKey}' failed: ` +
                `${cause}. The title/body/tags/etc. you supplied are now ` +
                `on Notion; the topic key is unchanged. Inspect the row ` +
                `and re-issue the re-key (without the content delta) once ` +
                `the underlying issue is resolved.`,
              {
                memoryId: args.memoryId,
                rekeyError: err,
              }
            )
          }
          throw err
        }
      }
    }

    if (!updated) {
      // Degenerate input: neither a content delta nor a topicKey
      // was passed (e.g. just `{ memoryId }`). Surface current
      // state so the tool returns a sensible shape rather than
      // throwing. Both content-update and re-key branches assign
      // `updated` when they run, so this path only fires for the
      // empty-args case. Reuse `loadCurrent`'s cached snapshot so
      // a caller passing `{ memoryId, kind, status }` plus a no-op
      // gate doesn't pay a second round-trip here.
      updated = await loadCurrent()
    }

    // Diff-driven re-emission of `mentions` facts. An update that
    // surfaces a fresh entity in title / keywords / synopsis emits a
    // new `mentions` fact for it; an update that REMOVES an entity
    // invalidates the corresponding existing fact. Symmetric contract
    // — without invalidate-on-remove, every entity rename (e.g.
    // `MemoryService` → `MemoryService.create`) would ratchet up the
    // orphan-fact count for the source memory, polluting `lore-query
    // action='ask'` and the entity-graph wake-up surface with labels
    // the memory does not reference.
    //
    // Pre-query existing `mentions` facts sourced from this memory
    // so per-entity `createWithDedup` only fires for entities the
    // graph doesn't already cover (current − previous), and
    // `services.facts.invalidate` only fires for facts whose Object
    // is missing from the current surface (previous − current). The
    // covered / stale check is by Object alone, deliberately: a
    // title-only update that leaves the entity set untouched changes
    // every existing fact's subject text but emits zero new rows AND
    // zero invalidates. `createWithDedup`'s dedup-key probe is the
    // second-line defense against a concurrent autosave landing
    // the same triple between our pre-query and our writes.
    //
    // Gate the whole branch on at least one extraction-relevant arg
    // being defined: title, keywords, or synopsis. An update that
    // only mutates `confidence` / `status` / `reviewBy` /
    // `decidedAt` / `tags` / `projectIds` / `topicId` /
    // `supersedesIds` / `affectsIds` / `alternatives` /
    // `consequences` cannot change the extraction surface, so the
    // pre-query and per-entity writes would be pure waste — every
    // candidate would resolve to "already covered" and no fact
    // would be stale. The gate checks arg presence, not
    // arg-vs-resolved-value diff, so an agent that re-supplies an
    // unchanged title still pays the pre-query; that noise case is
    // the agent's choice and bounded by the kill switch.
    //
    // The query runs unconditionally inside the gate (no
    // `mentionedEntities.length > 0` short-circuit), because an
    // update that drops every entity from the extraction surface
    // (e.g. retitling `Investigated auth-service latency regression`
    // to `Generic refactor notes`) must still invalidate the now-
    // stale facts, and we cannot know whether existing facts are
    // present without querying.
    const autoMentionsDisabled = !features.autoMentions
    const extractionInputsTouched =
      args.title !== undefined ||
      args.keywords !== undefined ||
      args.synopsis !== undefined
    let autoMentionsCount = 0
    let autoMentionsAttempted = 0
    let staleInvalidatedCount = 0
    let staleInvalidatedAttempted = 0
    if (!autoMentionsDisabled && extractionInputsTouched) {
      // Decode candidates to match `createWithDedup`'s internal
      // decode-at-write-boundary step. Without this, an entity
      // surfaced as `Foo &amp; Bar` would compare raw against an
      // already-decoded `Foo & Bar` in the covered-set Set,
      // triggering a wasted round-trip per affected entity per
      // update. Idempotent.
      const mentionedEntities = extractEntityCandidates(
        updated.title,
        updated.keywords,
        updated.synopsis
      ).map(decodeTextEntities)
      let existing: Fact[]
      try {
        existing = await services.facts.queryBySourceMemory(updated.id, {
          predicates: ["mentions"],
          // Auto-mentions diff must see every mentions fact this
          // memory has emitted, regardless of scope context — this is
          // a write-side reconciliation, not an agent-facing read.
          // Filtering by reader scope here would silently leave
          // out-of-scope mentions facts orphaned when the memory is
          // re-titled, defeating the whole point of the invalidate
          // half of the auto-mentions diff.
          includeOutOfScope: true,
        })
      } catch (err) {
        // Probe failure must not block the update response.
        // Degrade to "assume nothing covered, nothing stale" —
        // `createWithDedup`'s own probe still absorbs same-triple
        // duplicates downstream so the worst case on the create
        // side is one wasted round-trip per entity. The invalidate
        // side silently drifts on this run (existing facts stay
        // live); the next extraction-touching update on this memory
        // re-runs the probe and re-derives the diff, or an operator
        // can invalidate the orphan rows directly via
        // `lore-fact action='invalidate'`.
        debugLogPartialFailures("lore-memory", [
          { rootId: `${updated.id}: existing-mentions-probe`, error: err },
        ])
        existing = []
      }
      // Decode each existing fact's Object exactly once into a
      // tuple aligned with the source fact, then derive both sides
      // of the diff from the decoded namespace. Pre-`lore migrate
      // --fix-fact-encoding` vaults still carry rows whose `Object`
      // is HTML-entity-encoded on disk (e.g. `Café &amp; Bar`); the
      // post-update extraction is decoded by `mentionedEntities`'s
      // trailing `.map(decodeTextEntities)` above. Without
      // this normalization, an encoded existing row would be
      // simultaneously absent from the (decoded) `covered` set AND
      // from the (decoded) `currentSet`, so the same entity would
      // be CREATED in decoded form AND INVALIDATED in encoded form
      // — silent invalidate-and-replace churn on a memory that
      // still mentions the same entity, decrementing the encoded
      // row's `Confidence Score` for no operator-visible reason.
      // Decoding here keeps the diff in one namespace and lets the
      // create-side `createWithDedup` triple-hash absorb the
      // migrated row naturally rather than via destructive
      // replacement. `decodeTextEntities` is idempotent so already-
      // decoded rows pass through unchanged.
      const decodedExisting = existing.map((fact) => ({
        fact,
        decodedObject: decodeTextEntities(fact.object),
      }))
      // Covered/stale must split on BOTH Object identity AND scope
      // match. An existing fact whose decoded Object is still
      // surfaced but whose scope does not match the post-update
      // memory scope (because the operator re-scoped the source
      // memory via `lore-memory action='update'` with `scope: { ... }`)
      // needs to be invalidated AND re-emitted under the new scope,
      // otherwise the fact stays at its original scope indefinitely
      // and either leaks or hides under the new reader context.
      // Without this branch, scope-only updates produce zero fact
      // writes for Object-stable entities and the source memory's
      // mentions facts become structurally desynchronized from the
      // memory's identity slot.
      const updatedScopeBundle = memoryScopeToInput(updated.scope)
      // Reuse `scopesMatchForMerge` directly so the auto-mentions
      // diff and `createWithDedup` cannot drift on the equality
      // rule. A duplicate local helper would silently diverge from
      // the shared contract; sharing the helper keeps the rule in
      // lockstep.
      const factScopeMatchesUpdate = (fact: import("../../../types.js").Fact): boolean =>
        scopesMatchForMerge(fact.scope ?? null, updatedScopeBundle)
      const covered = new Set(
        decodedExisting
          .filter((e) => factScopeMatchesUpdate(e.fact))
          .map((e) => e.decodedObject)
      )
      const currentSet = new Set(mentionedEntities)
      const newCandidates = mentionedEntities.filter((entity) => !covered.has(entity))
      // Stale = existing facts whose decoded Object isn't surfaced
      // by the post-update extraction OR whose scope does not
      // match the post-update memory scope. The set difference is
      // structurally the inverse of the new-candidate filter; both
      // are derived from the same `covered` / `currentSet` pair —
      // both built in the decoded namespace — so a future refactor
      // can't desync them OR re-introduce the encoding asymmetry
      // across the two filters. The scope-mismatch branch invalidates
      // the existing fact so the create branch above re-emits it
      // under the new scope.
      const staleFacts = decodedExisting
        .filter(
          (e) => !currentSet.has(e.decodedObject) || !factScopeMatchesUpdate(e.fact)
        )
        .map((e) => e.fact)
      const autoProjectIds =
        updated.projectIds.length > 0 ? updated.projectIds : undefined
      // Per-entity `.then(success, failure)` — same shape as
      // the save-time emission: convert every rejection into a
      // resolved boolean BEFORE `Promise.all` ever sees it so a
      // single per-entity 400 cannot sink the surviving creates
      // or invalidates. See `handleSave`'s comment for the full
      // rationale on the create side; the invalidate side adopts
      // the same posture so a transient 5xx on one stale fact
      // doesn't mask an otherwise-successful diff. Creates and
      // invalidates fan out together via one `Promise.all` so
      // the writes overlap on the wire — the shared Notion client
      // wrapper's rate-limit middleware
      // bounds in-flight count to `notion.rateLimit.concurrency`
      // (default 3) regardless of which branch the call came from.
      // An aggressive rename (e.g. 5 stale facts + 3 fresh
      // candidates = 8 simultaneous SDK calls) is paced by the
      // middleware, not by handler-side throttling — a future
      // contributor reusing this branch under a parallelism-
      // uncapped client (e.g. a one-shot migration script) would
      // need to add explicit pacing.
      autoMentionsAttempted = newCandidates.length
      staleInvalidatedAttempted = staleFacts.length
      if (newCandidates.length > 0 || staleFacts.length > 0) {
        // Propagate the post-update scope onto newly-emitted mentions
        // facts. A `lore-memory action='update'`
        // call that re-titles a session-scoped memory must produce
        // mentions facts with the SAME session scope; otherwise the
        // re-emit would land broadcast facts that leak across
        // sessions.
        //
        // Re-scoping reconciliation: when scope itself changes on
        // update, the diff branch above already invalidates every
        // existing mentions fact whose Object is missing from the
        // post-update extraction and re-emits with the post-update
        // scope. For Object-stable entities, the dedup probe below
        // sees the existing (broadcast or otherwise-scoped) fact
        // and falls through to a fresh row under the new scope —
        // `scopesMatchForMerge` is the predicate that gates this.
        // The invalidate+create pair is what makes this work without
        // an explicit "re-scope existing facts" pass.
        const updatedFactScope = memoryScopeToInput(updated.scope)
        // Split the create branch onto `createBatchWithDedup` so
        // flag-on saves issue one `create_pages` call instead of N.
        // Run the batched creates and the per-fact invalidates in
        // parallel (`Promise.all` of a tagged tuple) so the wall-clock
        // parity is preserved when the flag is off — the rate-limit
        // middleware paces the union without the handler choosing
        // ordering. Failure isolation per entity is preserved: the
        // batch wrapper returns `PromiseSettledResult[]` and the
        // invalidate side still wraps each call in `.then(success,
        // failure)`.
        const createBatchPromise = services.facts
          .createBatchWithDedup(
            newCandidates.map((entity) => ({
              subject: updated.title,
              predicate: "mentions",
              object: entity,
              sourceMemoryId: updated.id,
              projectIds: autoProjectIds,
              confidence: "speculative",
              scope: updatedFactScope,
            }))
          )
          .then((settled) =>
            settled.map((r, idx) => {
              if (r.status === "rejected") {
                debugLogAutoFactFailure(
                  "update",
                  updated.id,
                  newCandidates[idx]!,
                  r.reason
                )
                return { kind: "create" as const, ok: false }
              }
              return { kind: "create" as const, ok: true }
            })
          )
        const invalidatePromises = staleFacts.map((fact) =>
          services.facts.invalidate(fact.id, { sourceMemoryId: updated.id }).then(
            () => ({ kind: "invalidate" as const, ok: true }),
            (err: unknown) => {
              debugLogAutoFactFailure(
                "update",
                updated.id,
                fact.object,
                err,
                "invalidate"
              )
              return { kind: "invalidate" as const, ok: false }
            }
          )
        )
        const [createResults, ...invalidateResults] = await Promise.all([
          createBatchPromise,
          ...invalidatePromises,
        ])
        const results = [...createResults, ...invalidateResults]
        for (const r of results) {
          if (r.kind === "create" && r.ok) autoMentionsCount += 1
          if (r.kind === "invalidate" && r.ok) staleInvalidatedCount += 1
        }
      }
    }

    const lines = [`Updated memory: "${updated.title}" (${updated.id})`]
    if (rekeyed && oldTopicKey !== undefined && args.topicKey !== undefined) {
      lines.push(`Re-keyed: '${oldTopicKey || "(unset)"}' → '${args.topicKey}'`)
      lines.push(`Audit block appended to body.`)
    } else if (topicKeyUnchanged && args.topicKey !== undefined) {
      // Acknowledge the no-op so the operator can see the call was
      // received and recognized as a no-op (the new key matched the
      // existing one). Silent suppression would leave the operator
      // wondering whether the re-key was honored or dropped.
      lines.push(`Topic key unchanged: '${args.topicKey}' (no-op).`)
    }
    if (topicLabel) {
      lines.push(`Topic: ${topicLabel}`)
    }
    if (warnings.length > 0) {
      lines.push(`Warnings: ${warnings.join("; ")}`)
    }
    // Footer fires only when the diff produced at least one
    // create or one invalidate — the steady state (every entity
    // already covered, no stale facts) renders no footer, matching
    // save's silent-on-no-tokenizer-output posture. The "new" /
    // "stale invalidated" suffixes distinguish update-time
    // emission from save-time emission ("Auto-mentions: 2" on
    // save vs. "Auto-mentions: 2 new" / "Auto-mentions: 1 stale
    // invalidated" on update) so an operator triaging response
    // output can tell which surface produced the count and which
    // half of the diff drove the work. Both halves render in the
    // same line when both fired (`Auto-mentions: 2 new, 1 stale
    // invalidated`) so an agent can branch on the leading
    // `Auto-mentions:` token without parsing two separate footers.
    if (autoMentionsAttempted > 0 || staleInvalidatedAttempted > 0) {
      const parts: string[] = []
      if (autoMentionsAttempted > 0) {
        parts.push(
          autoMentionsCount === autoMentionsAttempted
            ? `${autoMentionsCount} new`
            : `${autoMentionsCount}/${autoMentionsAttempted} new attempted`
        )
      }
      if (staleInvalidatedAttempted > 0) {
        parts.push(
          staleInvalidatedCount === staleInvalidatedAttempted
            ? `${staleInvalidatedCount} stale invalidated`
            : `${staleInvalidatedCount}/${staleInvalidatedAttempted} stale invalidated attempted`
        )
      }
      lines.push(`Auto-mentions: ${parts.join(", ")}`)
      const staleInvalidationFailures = staleInvalidatedAttempted - staleInvalidatedCount
      if (staleInvalidationFailures > 0) {
        lines.push(
          `Auto-mentions warning: ${staleInvalidationFailures} stale mention ` +
            `invalidation${staleInvalidationFailures === 1 ? "" : "s"} failed; ` +
            `stale mention facts may remain live.`
        )
      }
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
      costOutputs: { memoriesUpdated: 1 },
    }
  } catch (err) {
    return toolError(err)
  }
}
