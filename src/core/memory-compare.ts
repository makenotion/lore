// ABOUTME: Owns compare-note audit writes and retry ledgers for memory conflict and supersession verdicts.
// ABOUTME: Edit when compare NDJSON shape, per-side idempotency, or actionable verdict dispatch changes.

import type { Client } from "@notionhq/client"
import type { Memory, MemoryScopeInput } from "../types.js"
import { pairScopeForFactEmission } from "../types.js"
import {
  COMPARE_NOTES_MAX_CHARS,
  encodeCompareNotesRichText,
  MEMORY_PROPS,
  type CompareNotesTextChunk,
} from "../notion/schema.js"
import { LoreError, errorCauseMessage } from "../errors.js"

export { COMPARE_NOTES_MAX_CHARS, encodeCompareNotesRichText }
export type { CompareNotesTextChunk }

export interface RecordComparedResult {
  wroteA: boolean
  wroteB: boolean
}

export interface RecordComparedInput {
  memoryA: Pick<Memory, "id" | "comparedWith" | "compareNotes">
  memoryB: Pick<Memory, "id" | "comparedWith" | "compareNotes">
  verdict: string
  /**
   * Loser memory's id for asymmetric verdicts; `null` for symmetric.
   * Persisted in each side's NDJSON entry so direction is part of
   * the idempotency key.
   */
  affected: string | null
  reason: string
  judgedAt: string
  promptVersion: string
  /**
   * Force a side's `pages.update` even when the final audit line
   * already exists. Used only by legacy asymmetric partial-repair.
   */
  forceWriteA?: boolean
  forceWriteB?: boolean
}

/**
 * Structured partial-state error raised by `MemoryCompare.recordCompared`
 * when exactly one of the symmetric `pages.update` writes rejected and
 * the other landed or was skipped via per-side idempotency.
 */
export class RecordComparedPartialWriteError extends LoreError<"record-compared-partial-write"> {
  readonly result: RecordComparedResult
  readonly failedSide: "A" | "B"
  readonly cause: unknown

  constructor(args: {
    message: string
    result: RecordComparedResult
    failedSide: "A" | "B"
    cause: unknown
  }) {
    super(
      "record-compared-partial-write",
      args.message,
      {
        result: args.result,
        failedSide: args.failedSide,
        causeMessage: errorCauseMessage(args.cause),
      },
      { cause: args.cause }
    )
    this.name = "RecordComparedPartialWriteError"
    this.result = args.result
    this.failedSide = args.failedSide
    this.cause = args.cause
  }
}

export interface CompareNoteEntry {
  verdict: string
  target: string
  /**
   * The loser memory's id for asymmetric verdicts (`conflicts_with`,
   * `supersedes`); `null` for symmetric verdicts.
   */
  affected: string | null
  reason: string
  judgedAt: string
  promptVersion: string
}

type CompareDispatchVerdict = "conflicts_with" | "supersedes"

export interface CompareDispatchLedgerEntry {
  entryType: "compare_dispatch"
  dispatchKey: string
  step: "confidence_decrement"
  verdict: CompareDispatchVerdict
  source: string
  affected: string
}

function appendCompareNotesEntry(existing: string, entry: unknown): string {
  const line = JSON.stringify(entry)
  const next = existing.length === 0 ? line : existing + "\n" + line
  if (next.length > COMPARE_NOTES_MAX_CHARS) {
    throw new Error(
      `Compare Notes overflow: appending this entry would push ` +
        `total length to ${next.length} chars (cap ` +
        `${COMPARE_NOTES_MAX_CHARS}). The memory is over-compared; ` +
        `consolidate via lore-memory action='archive' on duplicate ` +
        `pairs or split the topic.`
    )
  }
  return next
}

export function appendCompareNote(existing: string, entry: CompareNoteEntry): string {
  return appendCompareNotesEntry(existing, entry)
}

export function compareDispatchKey(input: {
  verdict: CompareDispatchVerdict
  sourceMemoryId: string
  affectedMemoryId: string
}): string {
  return [
    "compare-dispatch",
    input.verdict,
    input.sourceMemoryId,
    input.affectedMemoryId,
    "confidence_decrement",
  ].join("\u001f")
}

export function buildCompareDispatchLedgerEntry(input: {
  verdict: CompareDispatchVerdict
  sourceMemoryId: string
  affectedMemoryId: string
}): CompareDispatchLedgerEntry {
  return {
    entryType: "compare_dispatch",
    dispatchKey: compareDispatchKey(input),
    step: "confidence_decrement",
    verdict: input.verdict,
    source: input.sourceMemoryId,
    affected: input.affectedMemoryId,
  }
}

export function appendCompareDispatchLedgerEntry(
  existing: string,
  entry: CompareDispatchLedgerEntry
): string {
  return appendCompareNotesEntry(existing, entry)
}

export function hasMatchingCompareNote(
  notesNdjson: string,
  match: { target: string; verdict: string; affected: string | null }
): boolean {
  if (notesNdjson.length === 0) return false
  for (const line of notesNdjson.split("\n")) {
    if (line.trim().length === 0) continue
    try {
      const entry = JSON.parse(line) as {
        entryType?: string
        target?: string
        verdict?: string
        affected?: string | null
      }
      if (entry.entryType === "compare_dispatch") continue
      const entryAffected = entry.affected ?? null
      if (
        entry.target === match.target &&
        entry.verdict === match.verdict &&
        entryAffected === match.affected
      ) {
        return true
      }
    } catch {
      // Malformed lines cannot prove that this comparison already landed.
    }
  }
  return false
}

export function hasCompareDispatchLedgerEntry(
  notesNdjson: string,
  match: { dispatchKey: string; step: "confidence_decrement" }
): boolean {
  if (notesNdjson.length === 0) return false
  for (const line of notesNdjson.split("\n")) {
    if (line.trim().length === 0) continue
    try {
      const entry = JSON.parse(line) as {
        entryType?: string
        dispatchKey?: string
        step?: string
      }
      if (
        entry.entryType === "compare_dispatch" &&
        entry.dispatchKey === match.dispatchKey &&
        entry.step === match.step
      ) {
        return true
      }
    } catch {
      // Malformed lines cannot prove that the non-idempotent step landed.
    }
  }
  return false
}

function factConfidenceFromJudge(
  score: number | undefined
): "certain" | "likely" | "speculative" {
  if (score === undefined) return "likely"
  if (score >= 0.85) return "certain"
  if (score >= 0.6) return "likely"
  return "speculative"
}

export interface CompareDispatchServices {
  memories: {
    decrementConfidence(
      memory: Pick<
        Memory,
        "id" | "confidence" | "confidenceScore" | "lastReferencedAt" | "createdAt"
      >,
      opts?: { today?: string; compareNotes?: string }
    ): Promise<number>
  }
  facts: {
    createWithDedup(input: {
      subject: string
      predicate:
        | "is_a"
        | "has_a"
        | "uses"
        | "depends_on"
        | "related_to"
        | "created_by"
        | "owned_by"
        | "replaces"
        | "extends"
        | "conflicts_with"
        | "decided_by"
        | "supersedes_decision"
        | "informs"
        | "mentions"
      object: string
      projectIds?: string[]
      sourceMemoryId?: string
      confidence?: "certain" | "likely" | "speculative"
      scope?: MemoryScopeInput
    }): Promise<{ fact: { id: string }; deduped: boolean }>
  }
  decisions: {
    supersede(newId: string, oldId: string): Promise<void>
  }
}

export class CompareDispatchPartialFailureError extends LoreError<"compare-dispatch-partial"> {
  readonly step: "fact" | "supersede"
  readonly affectedMemoryId: string
  readonly factId: string | undefined
  readonly cause: unknown

  constructor(args: {
    message: string
    step: "fact" | "supersede"
    affectedMemoryId: string
    factId: string | undefined
    cause: unknown
  }) {
    super(
      "compare-dispatch-partial",
      args.message,
      {
        step: args.step,
        affectedMemoryId: args.affectedMemoryId,
        ...(args.factId === undefined ? {} : { factId: args.factId }),
        causeMessage: errorCauseMessage(args.cause),
      },
      { cause: args.cause }
    )
    this.name = "CompareDispatchPartialFailureError"
    this.step = args.step
    this.affectedMemoryId = args.affectedMemoryId
    this.factId = args.factId
    this.cause = args.cause
  }
}

export class MemoryCompare {
  constructor(private client: Client) {}

  async recordCompared(input: RecordComparedInput): Promise<RecordComparedResult> {
    const {
      memoryA,
      memoryB,
      verdict,
      affected,
      reason,
      judgedAt,
      promptVersion,
      forceWriteA = false,
      forceWriteB = false,
    } = input
    const entryA: CompareNoteEntry = {
      verdict,
      target: memoryB.id,
      affected,
      reason,
      judgedAt,
      promptVersion,
    }
    const entryB: CompareNoteEntry = {
      verdict,
      target: memoryA.id,
      affected,
      reason,
      judgedAt,
      promptVersion,
    }

    const aHasEntry = hasMatchingCompareNote(memoryA.compareNotes, {
      target: memoryB.id,
      verdict,
      affected,
    })
    const bHasEntry = hasMatchingCompareNote(memoryB.compareNotes, {
      target: memoryA.id,
      verdict,
      affected,
    })

    const writes: Array<{ side: "A" | "B"; promise: Promise<unknown> }> = []
    const shouldWriteA = !aHasEntry || forceWriteA
    const shouldWriteB = !bHasEntry || forceWriteB
    if (shouldWriteA) {
      const nextNotesA = aHasEntry
        ? memoryA.compareNotes
        : appendCompareNote(memoryA.compareNotes, entryA)
      const nextComparedWithA = memoryA.comparedWith.includes(memoryB.id)
        ? memoryA.comparedWith
        : [...memoryA.comparedWith, memoryB.id]
      writes.push({
        side: "A",
        promise: this.client.pages.update({
          page_id: memoryA.id,
          properties: {
            [MEMORY_PROPS.COMPARED_WITH]: {
              relation: nextComparedWithA.map((id) => ({ id })),
            },
            [MEMORY_PROPS.COMPARE_NOTES]: {
              rich_text: encodeCompareNotesRichText(nextNotesA),
            },
          },
        }),
      })
    }
    if (shouldWriteB) {
      const nextNotesB = bHasEntry
        ? memoryB.compareNotes
        : appendCompareNote(memoryB.compareNotes, entryB)
      const nextComparedWithB = memoryB.comparedWith.includes(memoryA.id)
        ? memoryB.comparedWith
        : [...memoryB.comparedWith, memoryA.id]
      writes.push({
        side: "B",
        promise: this.client.pages.update({
          page_id: memoryB.id,
          properties: {
            [MEMORY_PROPS.COMPARED_WITH]: {
              relation: nextComparedWithB.map((id) => ({ id })),
            },
            [MEMORY_PROPS.COMPARE_NOTES]: {
              rich_text: encodeCompareNotesRichText(nextNotesB),
            },
          },
        }),
      })
    }

    const settled = await Promise.allSettled(writes.map((w) => w.promise))
    let aFailed = false
    let bFailed = false
    let aFailure: unknown = undefined
    let bFailure: unknown = undefined
    let aWrote = false
    let bWrote = false
    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i]!
      const side = writes[i]!.side
      if (outcome.status === "fulfilled") {
        if (side === "A") aWrote = true
        else bWrote = true
      } else if (side === "A") {
        aFailed = true
        aFailure = outcome.reason
      } else {
        bFailed = true
        bFailure = outcome.reason
      }
    }

    if (!aFailed && !bFailed) {
      return { wroteA: aWrote, wroteB: bWrote }
    }

    if (aFailed && bFailed) {
      throw aFailure
    }

    const failedSide: "A" | "B" = aFailed ? "A" : "B"
    const cause = aFailed ? aFailure : bFailure
    const survivorWasSkipped = failedSide === "A" ? !shouldWriteB : !shouldWriteA
    const survivorState = survivorWasSkipped
      ? "was already present (skipped via per-side idempotency)"
      : "landed"
    throw new RecordComparedPartialWriteError({
      message:
        `recordCompared partial write — side ${failedSide} rejected; ` +
        `the other side ${survivorState}. ` +
        `Retry with a reloaded snapshot will skip the side already audited ` +
        `and write only the missing side.`,
      result: { wroteA: aWrote, wroteB: bWrote },
      failedSide,
      cause,
    })
  }
}

export async function recordContradiction(
  services: CompareDispatchServices,
  input: {
    contradictedMemory: Pick<
      Memory,
      | "id"
      | "title"
      | "projectIds"
      | "confidence"
      | "confidenceScore"
      | "lastReferencedAt"
      | "createdAt"
    > &
      Partial<Pick<Memory, "compareNotes" | "scope">>
    sourceMemory: Pick<Memory, "id" | "title" | "projectIds"> &
      Partial<Pick<Memory, "scope">>
    judgeConfidence: number | undefined
  }
): Promise<{
  factId: string | null
  affectedCompareNotes: string
  decremented: boolean
  factEmissionSkippedReason?: string
}> {
  const ledgerEntry = buildCompareDispatchLedgerEntry({
    verdict: "conflicts_with",
    sourceMemoryId: input.sourceMemory.id,
    affectedMemoryId: input.contradictedMemory.id,
  })
  const currentCompareNotes = input.contradictedMemory.compareNotes ?? ""
  const alreadyDecremented = hasCompareDispatchLedgerEntry(currentCompareNotes, {
    dispatchKey: ledgerEntry.dispatchKey,
    step: "confidence_decrement",
  })
  const affectedCompareNotes = alreadyDecremented
    ? currentCompareNotes
    : appendCompareDispatchLedgerEntry(currentCompareNotes, ledgerEntry)

  const sharedProjects = intersectProjects(
    input.sourceMemory.projectIds,
    input.contradictedMemory.projectIds
  )
  const pairScope = pairScopeForFactEmission(
    input.sourceMemory.scope,
    input.contradictedMemory.scope
  )

  let factId: string | null = null
  if (pairScope.ok) {
    const result = await services.facts.createWithDedup({
      subject: input.sourceMemory.title,
      predicate: "conflicts_with",
      object: input.contradictedMemory.title,
      projectIds: sharedProjects.length > 0 ? sharedProjects : undefined,
      sourceMemoryId: input.sourceMemory.id,
      confidence: factConfidenceFromJudge(input.judgeConfidence),
      scope: pairScope.scope,
    })
    factId = result.fact.id
  }

  if (!alreadyDecremented) {
    try {
      await services.memories.decrementConfidence(input.contradictedMemory, {
        compareNotes: affectedCompareNotes,
      })
    } catch (err) {
      throw new CompareDispatchPartialFailureError({
        message:
          "conflicts_with dispatch: fact emitted but decrementConfidence " +
          "failed (inconsistentState: true). Retry the same " +
          "lore-memory action='compare' after the transient failure is " +
          "cleared; if the confidence update landed, the compare_dispatch " +
          "ledger marker on the affected memory will prevent a second " +
          "decrement. Diagnostic fields:\n" +
          `step=fact\n` +
          `affectedMemoryId=${input.contradictedMemory.id}\n` +
          `factId=${factId ?? "(pair-scope-skipped)"}\n` +
          `dispatchKey=${ledgerEntry.dispatchKey}`,
        step: "fact",
        affectedMemoryId: input.contradictedMemory.id,
        factId: factId ?? "(pair-scope-skipped)",
        cause: err,
      })
    }
  }
  return {
    factId,
    affectedCompareNotes,
    decremented: !alreadyDecremented,
    ...(pairScope.ok ? {} : { factEmissionSkippedReason: pairScope.reason }),
  }
}

export async function recordSupersedence(
  services: CompareDispatchServices,
  input: {
    supersedingMemory: Pick<Memory, "id" | "title" | "projectIds" | "confidence"> &
      Partial<Pick<Memory, "scope">>
    supersededMemory: Pick<
      Memory,
      | "id"
      | "title"
      | "projectIds"
      | "confidence"
      | "confidenceScore"
      | "lastReferencedAt"
      | "createdAt"
    > &
      Partial<Pick<Memory, "compareNotes" | "scope">>
    judgeConfidence: number | undefined
  }
): Promise<{
  factId: string | null
  affectedCompareNotes: string
  decremented: boolean
  factEmissionSkippedReason?: string
}> {
  const ledgerEntry = buildCompareDispatchLedgerEntry({
    verdict: "supersedes",
    sourceMemoryId: input.supersedingMemory.id,
    affectedMemoryId: input.supersededMemory.id,
  })
  const currentCompareNotes = input.supersededMemory.compareNotes ?? ""
  const alreadyDecremented = hasCompareDispatchLedgerEntry(currentCompareNotes, {
    dispatchKey: ledgerEntry.dispatchKey,
    step: "confidence_decrement",
  })
  const affectedCompareNotes = alreadyDecremented
    ? currentCompareNotes
    : appendCompareDispatchLedgerEntry(currentCompareNotes, ledgerEntry)

  await services.decisions.supersede(
    input.supersedingMemory.id,
    input.supersededMemory.id
  )

  const sharedProjects = intersectProjects(
    input.supersedingMemory.projectIds,
    input.supersededMemory.projectIds
  )
  const pairScope = pairScopeForFactEmission(
    input.supersedingMemory.scope,
    input.supersededMemory.scope
  )

  let factId: string | null = null
  if (pairScope.ok) {
    try {
      const result = await services.facts.createWithDedup({
        subject: input.supersedingMemory.id,
        predicate: "supersedes_decision",
        object: input.supersededMemory.id,
        projectIds: sharedProjects.length > 0 ? sharedProjects : undefined,
        sourceMemoryId: input.supersedingMemory.id,
        confidence: factConfidenceFromJudge(input.judgeConfidence),
        scope: pairScope.scope,
      })
      factId = result.fact.id
    } catch (err) {
      throw new CompareDispatchPartialFailureError({
        message:
          "supersedes dispatch: decisions.supersede landed (Supersedes " +
          "relation + Status updated) but the supersedes_decision fact " +
          "create failed (inconsistentState: true). The graph edge is " +
          "missing; lore-query action='ask' won't surface the " +
          "supersession on the affected entity yet. Retry the same " +
          "lore-memory action='compare' after the transient failure is " +
          "cleared; decisions.supersede is idempotent on relation-set " +
          "semantics, so the retry can complete the fact and confidence " +
          "work safely. Diagnostic fields:\n" +
          `step=supersede\n` +
          `affectedMemoryId=${input.supersededMemory.id}\n` +
          `supersedingMemoryId=${input.supersedingMemory.id}\n` +
          `factId=(none)`,
        step: "supersede",
        affectedMemoryId: input.supersededMemory.id,
        factId: undefined,
        cause: err,
      })
    }
  }

  if (!alreadyDecremented) {
    try {
      await services.memories.decrementConfidence(input.supersededMemory, {
        compareNotes: affectedCompareNotes,
      })
    } catch (err) {
      throw new CompareDispatchPartialFailureError({
        message:
          "supersedes dispatch: decisions.supersede and the " +
          "supersedes_decision fact landed, but decrementConfidence on " +
          "the superseded memory failed (inconsistentState: true). Retry " +
          "the same lore-memory action='compare' after the transient " +
          "failure is cleared; if the confidence update landed, the " +
          "compare_dispatch ledger marker on the affected memory will " +
          "prevent a second decrement. Diagnostic fields:\n" +
          `step=fact\n` +
          `affectedMemoryId=${input.supersededMemory.id}\n` +
          `factId=${factId ?? "(pair-scope-skipped)"}\n` +
          `dispatchKey=${ledgerEntry.dispatchKey}`,
        step: "fact",
        affectedMemoryId: input.supersededMemory.id,
        factId: factId ?? "(pair-scope-skipped)",
        cause: err,
      })
    }
  }
  return {
    factId,
    affectedCompareNotes,
    decremented: !alreadyDecremented,
    ...(pairScope.ok ? {} : { factEmissionSkippedReason: pairScope.reason }),
  }
}

function intersectProjects(a: string[], b: string[]): string[] {
  if (a.length === 0 || b.length === 0) return []
  const setB = new Set(b)
  return a.filter((id) => setB.has(id))
}
