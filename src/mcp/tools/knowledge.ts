import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import {
  formatDispatchError,
  paginationFooter,
  toolError,
  debugLogPartialFailures,
  debugLogContradictionFailure,
  fireTouchOnRead,
  fireFactTouchOnRead,
  withWakeUpCacheBump,
} from "../helpers.js"
import { confidenceFactor } from "../../core/decay.js"
import { resolveProjectIds, resolveReadProjectScope } from "../resolve.js"
import { resolveCanonicalDecisionLinks } from "../decision-graph.js"
import {
  groupFactsByClass,
  renderFact,
  renderTrustLine,
  resolveReferencedTitles,
} from "../render.js"
import { clearableYmdDateSchema } from "./date-schema.js"
import { nonBlankString } from "./text-schema.js"
import { scopeInputSchema } from "./scope-schema.js"
import { isTransientNotionError } from "../../notion/errors.js"

import type { Decision, Fact, TaskSummary } from "../../types.js"
import { taskDaysOverdue } from "../../core/task.js"
import { expandEntityQueryVariants } from "../../core/entity.js"
import {
  composeProjectContext,
  renderProjectContextLines,
} from "../../core/project-context.js"
import { FACT_PROPS } from "../../notion/schema.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/**
 * Default per-bucket cap for `lore-query action='ask'`'s grouped display.
 * A well-connected entity with 20+ facts compresses down to 15 visible
 * rows at this cap (5 × 3 buckets). Callers can raise via the `limit`
 * param when they really do need the full list.
 */
const DEFAULT_ASK_BUCKET_CAP = 5

/**
 * Advertised value in the overflow hint (`(pass limit to raise the cap;
 * e.g. limit=20)`). Pinned rather than derived so a future bump to
 * `DEFAULT_ASK_BUCKET_CAP` doesn't silently shift the suggestion into a
 * number the user didn't expect. Roughly 4× the default cap — large
 * enough that raising here shows the tail of most hot entities without
 * dumping the whole graph.
 */
const SUGGESTED_OVERFLOW_LIMIT = 20

/**
 * Predicates accepted on `lore-fact action='create'`. Tracked work lives
 * on `lore-task action='create'`; the tracking predicates that the Tasks
 * surface superseded (`needs_action` / `waiting_on` / `blocked_by`) are
 * not part of the `FactPredicate` union and are not accepted here.
 *
 * Decision-graph predicates (`decided_by`, `supersedes_decision`,
 * `informs`) stay internal-only — created by `DecisionService` and
 * never via `lore-fact`.
 *
 * `mentions` is also internal-only — auto-emitted by
 * `lore-memory action='save'`. Agents that want to assert a richer
 * relationship (`uses`, `depends_on`, etc.) call `lore-fact
 * action='create'` directly; the auto-emitted `mentions` shape is the
 * lowest-quality fallback and is intentionally not addressable as an
 * agent-curated value.
 */
const PREDICATE_VALUES = [
  "is_a",
  "has_a",
  "uses",
  "depends_on",
  "related_to",
  "created_by",
  "owned_by",
  "replaces",
  "extends",
  "conflicts_with",
] as const

const CONFIDENCES = ["certain", "likely", "speculative"] as const

/**
 * Return true when the auto-link candidate's project scope is compatible
 * with the fact's. Rules:
 *
 * - Either side empty (vault-wide) → compatible. A vault-wide memory can
 *   support a scoped fact, and a vault-wide fact can accept any scoped
 *   memory as source.
 * - Both sides scoped → require at least one shared project.
 *
 * Anything else is a durable cross-project mis-link risk and must be
 * declined. Mirror of the conservative stance in the backfill heuristic.
 */
function projectsCompatible(
  factProjectIds: string[],
  memoryProjectIds: string[]
): boolean {
  if (factProjectIds.length === 0 || memoryProjectIds.length === 0) return true
  const memoryScope = new Set(memoryProjectIds)
  return factProjectIds.some((id) => memoryScope.has(id))
}

/**
 * LORE_DEBUG parser contract: one rejected provenance precheck emits one
 * newline-delimited `[lore] fact-precheck-rejected:` event.
 */
function debugLogFactPrecheckRejected(
  reason:
    | "provenance-unresolved"
    | "provenance-cross-project"
    | "provenance-source-unresolved"
    | "provenance-source-cross-project",
  args: Pick<LearnArgs, "agent" | "session" | "sourceMemoryId">,
  factProjectIds: string[],
): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  const clean = (value: string | undefined): string =>
    Array.from(value ?? "<unset>", (char) => {
      const code = char.charCodeAt(0)
      return code <= 31 || code === 127 ? " " : char
    }).join("")
  const projectScope = factProjectIds.length > 0 ? factProjectIds.join(",") : "<vault-wide>"
  process.stderr.write(
    `[lore] fact-precheck-rejected: reason=${reason} ` +
      `agent=${clean(args.agent)} session=${clean(args.session)} ` +
      `sourceMemoryId=${clean(args.sourceMemoryId)} project=${projectScope}\n`,
  )
}

function renderDecidedByLine(fact: Fact, decision: Decision, today: string): string {
  const review = decision.reviewBy
    ? decision.reviewBy <= today
      ? ` **(DECISION REVIEW OVERDUE — ${decision.reviewBy})**`
      : ` (decision review by ${decision.reviewBy})`
    : ""
  const decided = decision.decidedAt ? ` (decided ${decision.decidedAt})` : ""
  // DEFERRED-02 — surface the FACT's numeric trust label between the
  // title row and the ID footer when the fact's `confidenceScore` has
  // decayed below `CONFIDENCE_DISPLAY_THRESHOLD`. The decision's own
  // categorical confidence is already in the heading line; this trust
  // line reflects the EDGE's accumulated evidence (how often the
  // entity-decision link has been cited), which is a separate signal
  // from the decision's stance. Same envelope as `renderGenericTrailing`
  // and the audit Overdue Facts surface — a `decided_by` fact that's
  // been heavily decayed should not render as a normal trusted
  // governance row. Pre-migration / above-threshold rows render
  // byte-identically to pre-DEFERRED-02.
  const trustLine = renderTrustLine(fact.confidenceScore ?? null, "  ")
  const trustSegment = trustLine !== null ? `\n${trustLine}` : ""
  return `- **${fact.subject}** decided by **${decision.title}** [${decision.status}, ${decision.confidence}]${decided}${review}${trustSegment}\n  Decision ID: ${decision.id} | Fact ID: ${fact.id}`
}

function renderGenericTrailing(
  fact: Fact,
  today: string,
  opts: { asOf?: string } = {}
): string {
  const validity = fact.validFrom ? ` (since ${fact.validFrom})` : ""
  // Transaction-time invalidation surfaces when the row was
  // invalidated. Distinct from `Valid Until` (domain-truth end); the
  // bitemporal axis renders inline so callers using `asOf` /
  // `includeHistory` can read provenance directly from the response.
  //
  // On an `asOf` recall, suppress the INVALIDATED
  // segment when the invalidation date is AFTER the cutoff. The
  // server-side filter (`asOfFilterClauses`) deliberately includes
  // rows whose `Invalidated At > asOf` (they were live from Lore's
  // perspective at asOf), but rendering the post-cutoff invalidation
  // date would leak future knowledge into the as-of answer and
  // contradict the snapshot mental model. Without this gate, an
  // operator asking "what did Lore know at 2026-04-01?" sees facts
  // marked `INVALIDATED on 2026-05-01` — even though those facts
  // were live from Lore's perspective at the requested date.
  const suppressInvalidatedAt =
    opts.asOf !== undefined &&
    fact.invalidatedAt != null &&
    fact.invalidatedAt > opts.asOf
  const invalidated =
    fact.invalidatedAt && !suppressInvalidatedAt
      ? ` **(INVALIDATED on ${fact.invalidatedAt})**`
      : ""
  const review = fact.reviewBy
    ? fact.reviewBy <= today
      ? ` **(OVERDUE — review by ${fact.reviewBy})**`
      : ` (review by ${fact.reviewBy})`
    : ""
  // DEFERRED-02 — surface the numeric trust label as a separate
  // indented italic line between the validity/review tail and the
  // ID footer when the fact's `confidenceScore` has decayed below
  // `CONFIDENCE_DISPLAY_THRESHOLD`. Same shape as the decision/task
  // list surfaces (DEFERRED-07) so the visual rhythm stays
  // consistent. Pre-migration / above-threshold rows: `renderTrustLine`
  // returns null (null score short-circuits, above-threshold returns
  // null via `formatTrustLabel`), and the conditional collapses to
  // the pre-DEFERRED-02 byte-identical output.
  const trustLine = renderTrustLine(fact.confidenceScore ?? null, "  ")
  const trustSegment = trustLine !== null ? `\n${trustLine}` : ""
  return `[${fact.confidence}]${validity}${invalidated}${review}${trustSegment}\n  ID: ${fact.id}`
}

function compareSortKeyDesc(
  a: { sortKey: string | null },
  b: { sortKey: string | null }
): number {
  if (a.sortKey === b.sortKey) return 0
  if (!a.sortKey) return 1
  if (!b.sortKey) return -1
  return a.sortKey < b.sortKey ? 1 : -1
}

/**
 * RRF constant for the fact-side single-branch ranking (DEFERRED-02).
 * Smaller than memory-side `RRF_K = 60` because lore-ask buckets cap
 * at ~5–20 visible rows: a constant calibrated for 100-row search
 * results would compress all per-fact scores into a tiny range and
 * starve the confidence multiplier of effect at the head of the
 * list. `RRF_K = 4` keeps the rank-1 / rank-2 score ratio meaningful
 * (1/5 vs 1/6 ≈ 0.83) so a confidenceFactor of 0.5 can pull a
 * higher-ranked but heavily-decayed row below a lower-ranked
 * fully-trusted one.
 */
const FACT_RRF_K = 4

/**
 * Confidence-weighted recency ranking for fact-bucket rendering
 * (DEFERRED-02). Matches memory-side RRF: assign each item a
 * recency-rank by `validFrom` desc, then compute
 * `1 / (FACT_RRF_K + rank + 1) * confidenceFactor(score)`, then sort
 * by composite score desc.
 *
 * Why a real RRF pass and not a `validFrom`-tiebreaker. The first
 * draft used confidence as a same-day tiebreaker only; the score
 * was inert when `validFrom` differed, so a low-confidence newer fact
 * always outranked a high-confidence older fact. DEFERRED-02 calls
 * for `confidenceFactor` to weight ranking per fact, not just on
 * collisions — a frequently-cited 3-month-old fact should beat a
 * never-cited 2-week-old fact that's been heavily decayed. The RRF
 * pass implements that.
 *
 * Pre-DEFERRED-02 / un-backfilled vaults preserve byte-identical
 * recency ordering: `confidenceFactor(null) === 1.0`, so every
 * composite score collapses to `1 / (FACT_RRF_K + rank + 1)`, which
 * is monotonically decreasing in rank — i.e. the recency order from
 * `compareSortKeyDesc`. Once the migration runs, the multiplier
 * activates and reorders by confidence-weighted recency.
 *
 * Stable-sort properties: `Array.prototype.sort` is stable since
 * ES2019. On exact-tie composite scores (same validFrom AND same
 * confidence score / both null), the recency-sorted input order is
 * preserved. The recency sort itself is `compareSortKeyDesc`'s
 * established discipline.
 *
 * The kill switch (`LORE_DISABLE_CONFIDENCE_FACTOR=1`) lives inside
 * `confidenceFactor`, so a sustained-failure rollback to pre-DEFERRED-02
 * ordering is one env var away — same posture as memory-side RRF
 * applied on the memory side. With the kill switch active, every score collapses to 1.0
 * and the RRF pass devolves to monotonic-by-rank == byte-identical
 * pre-DEFERRED-02 recency ordering.
 */
function applyConfidenceWeightedRrf<T extends { sortKey: string | null; fact?: Fact }>(
  items: T[]
): T[] {
  if (items.length <= 1) return items
  // Recency-sort first to assign deterministic ranks. This is the
  // same shape `compareSortKeyDesc` already produces; we run it
  // explicitly so the rank index is captured for the RRF score.
  const recencyRanked = [...items].sort(compareSortKeyDesc)
  type Scored = { item: T; score: number }
  const scored: Scored[] = recencyRanked.map((item, rank) => {
    const factor = confidenceFactor(item.fact?.confidenceScore ?? null)
    const score = (1 / (FACT_RRF_K + rank + 1)) * factor
    return { item, score }
  })
  scored.sort((a, b) => {
    if (a.score === b.score) return 0
    return a.score < b.score ? 1 : -1
  })
  return scored.map((s) => s.item)
}

/**
 * Dedup-collect the source-memory IDs visible in a `lore-query
 * action='ask'` response. Walks the post-cap
 * **visible** slices, not the raw input arrays — rows past the
 * per-bucket cap render as `(N hidden)` and the agent never sees
 * them, so touching their backing memories would inflate
 * `Confidence Score` against rows that were never cited. Two cite
 * channels per visible row:
 *
 * - `decision.id` — `decided_by` governance rows cite a canonical
 *   decision page (decisions are memories via `Kind = decision`).
 * - `fact.sourceMemoryId` — every visible fact carries an optional
 *   pointer to the memory backing the assertion; a cite of the fact
 *   IS a cite of the source memory it rests on.
 *
 * Insertion order keeps decisions-first then fact-sources-second so
 * the resulting `getManyById` fan-out matches the response's reading
 * order — useful for `LORE_DEBUG=1` triage where touch-failure lines
 * land in the same sequence the response surfaced the rows.
 */
function collectAskSourceMemoryIds(
  visibleGovernance: ReadonlyArray<{ decision?: Decision; fact?: Fact }>,
  visibleStructure: ReadonlyArray<{ fact: Fact }>
): string[] {
  const ids = new Set<string>()
  for (const item of visibleGovernance) {
    if (item.decision) ids.add(item.decision.id)
    if (item.fact?.sourceMemoryId) ids.add(item.fact.sourceMemoryId)
  }
  for (const item of visibleStructure) {
    if (item.fact.sourceMemoryId) ids.add(item.fact.sourceMemoryId)
  }
  return Array.from(ids)
}

// -------------------------------------------------------------------------
// Handlers — one per fact action. Write-side actions (`create`,
// `invalidate`, `extend`) route via `lore-fact`'s discriminated union;
// read-side actions (`ask`, `audit`) are exported for reuse by `lore-query`.
// -------------------------------------------------------------------------

interface LearnArgs {
  subject: string
  predicate: (typeof PREDICATE_VALUES)[number]
  object: string
  projectName?: string
  projectNames?: string[]
  reviewBy?: string | null
  confidence?: (typeof CONFIDENCES)[number]
  sourceMemoryId?: string
  session?: string
  agent?: string
  scope?: import("../../types.js").MemoryScopeInput
}

export async function handleLearn(
  services: LoreServices,
  args: LearnArgs
): Promise<ToolResult> {
  try {
    const resolved = await resolveProjectIds(
      services,
      args.projectName,
      args.projectNames
    )
    const factProjectIds = resolved.ids

    // Dispatcher schema already rejects blank sources; keep this for direct handler callers.
    let effectiveSource: string | undefined = args.sourceMemoryId?.trim() || undefined
    let autoLinkedFromSession = false
    const toolWarnings: string[] = [...resolved.warnings]

    if (effectiveSource) {
      let sourceProjectIds: string[]
      try {
        const sourceMemory = await services.memories.getPropertiesById(effectiveSource)
        sourceProjectIds = sourceMemory.projectIds
      } catch {
        debugLogFactPrecheckRejected("provenance-source-unresolved", args, factProjectIds)
        return toolError(
          new Error(
            `provenance-source-unresolved: sourceMemoryId ${effectiveSource} did not resolve to a live Memories row. ` +
              `Pass an existing supporting memory ID, or pass agent+session for session auto-link.`,
          ),
        )
      }
      if (!projectsCompatible(factProjectIds, sourceProjectIds)) {
        debugLogFactPrecheckRejected("provenance-source-cross-project", args, factProjectIds)
        return toolError(
          new Error(
            `provenance-source-cross-project: sourceMemoryId ${effectiveSource} is scoped to a different project than this fact. ` +
              `Use a source memory from the same project, or a vault-wide source memory.`,
          ),
        )
      }
    } else {
      const candidate = services.sessionMemories.get({ agent: args.agent, session: args.session })
      if (candidate) {
        if (projectsCompatible(factProjectIds, candidate.projectIds)) {
          effectiveSource = candidate.memoryId
          autoLinkedFromSession = true
        } else {
          debugLogFactPrecheckRejected("provenance-cross-project", args, factProjectIds)
          return toolError(
            new Error(
              `provenance-cross-project: lore-fact create requires a compatible source memory. ` +
                `Session memory ${candidate.memoryId} is scoped to a different project than this fact. ` +
                `Pass sourceMemoryId explicitly to override the session candidate.`,
            ),
          )
        }
      }
    }

    if (!effectiveSource) {
      debugLogFactPrecheckRejected("provenance-unresolved", args, factProjectIds)
      return toolError(
        new Error(
          "provenance-unresolved: agent+session did not resolve to a compatible session memory. " +
            "Pass sourceMemoryId with an existing supporting memory, or save a memory/decision " +
            "under the same agent+session before creating the fact.",
        ),
      )
    }

    // PF3-01 — resolve subject and object to canonical Entity rows.
    // Auto-creates on miss (default), surfaces ambiguity candidates
    // back to the agent on multi-match.
    let subjectEntityId: string | undefined
    let objectEntityId: string | undefined
    const ambiguous: Array<{
      side: "subject" | "object"
      input: string
      candidates: string[]
    }> = []
    // Per-side `.catch(() => null)` instead of `Promise.all`: a
    // transient Notion 5xx on either resolver must NOT sink the
    // whole `lore-fact action='create'` call. Autosave callers have
    // no human in the loop; the fact is more valuable than the
    // relation. Treat a rejected resolution as "couldn't resolve,
    // omit the relation, surface a warning" — the substring-fallback
    // path in `queryByEntity` still finds the row later.
    //
    // Mirrors the resilience posture `lore-query action='ask'`'s tasks
    // lookup (further down in this file) already uses for the same
    // reason.
    const [subjectResolution, objectResolution] = await Promise.all([
      services.entities
        .resolveOrCreateEntity(args.subject, {
          autoCreate: true,
          projectIds: factProjectIds,
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          toolWarnings.push(
            `Subject entity resolution failed: ${message}. Fact written without SubjectEntity relation.`
          )
          return null
        }),
      services.entities
        .resolveOrCreateEntity(args.object, {
          autoCreate: true,
          projectIds: factProjectIds,
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          toolWarnings.push(
            `Object entity resolution failed: ${message}. Fact written without ObjectEntity relation.`
          )
          return null
        }),
    ])
    if (subjectResolution?.ambiguous) {
      ambiguous.push({
        side: "subject",
        input: args.subject,
        candidates: subjectResolution.candidates.map((c) => `${c.name} (${c.id})`),
      })
    } else if (subjectResolution?.entity) {
      subjectEntityId = subjectResolution.entity.id
    }
    if (objectResolution?.ambiguous) {
      ambiguous.push({
        side: "object",
        input: args.object,
        candidates: objectResolution.candidates.map((c) => `${c.name} (${c.id})`),
      })
    } else if (objectResolution?.entity) {
      objectEntityId = objectResolution.entity.id
    }

    // On ambiguity, surface candidates as a warning and write the fact
    // with the entity relation OMITTED on the ambiguous side. This
    // protects two contracts that would otherwise conflict:
    //
    // 1. Autosave-driven `lore-fact action='create'` calls have no human
    //    in the loop to disambiguate. Refusing to write would silently
    //    drop the fact from the autosave stream — worse than a
    //    half-canonical fact, which the substring-fallback
    //    `queryByEntity` path can still surface.
    //
    // 2. We must not guess and bind the fact to the wrong canonical
    //    row. Omitting the relation lets the operator (or a future
    //    `lore migrate --build-entities` re-run) attach the right
    //    entity later via `setEntityRelations`.
    //
    // The candidate list goes into `toolWarnings` so the agent sees it
    // alongside other tool diagnostics and can re-issue the call with
    // a more-specific name. Tracked by spec line 30 ("tool surfaces
    // candidates back to the caller; no auto-create") — surfacing
    // does not require refusing.
    if (ambiguous.length > 0) {
      for (const a of ambiguous) {
        toolWarnings.push(
          `Ambiguous ${a.side} "${a.input}" — matched ${a.candidates.length} entities (${a.candidates.join(", ")}). ` +
            `Fact written without ${a.side === "subject" ? FACT_PROPS.SUBJECT_ENTITY : FACT_PROPS.OBJECT_ENTITY} relation. ` +
            `Re-issue with the canonical name to attach the relation.`
        )
      }
    }

    const { fact, deduped, enriched } = await services.facts.createWithDedup({
      subject: args.subject,
      predicate: args.predicate,
      object: args.object,
      projectIds: factProjectIds.length > 0 ? factProjectIds : undefined,
      reviewBy: args.reviewBy ?? undefined,
      confidence: args.confidence,
      sourceMemoryId: effectiveSource,
      subjectEntityId,
      objectEntityId,
      // Scope / lifetime.
      scope: args.scope,
    })

    const verb = !deduped
      ? "Learned"
      : enriched.length > 0
        ? "Enriched existing fact"
        : "Matched existing fact"
    const lines = [
      `${verb}: "${fact.subject}" ${fact.predicate.replace(/_/g, " ")} "${fact.object}" (${fact.confidence}) — ID: ${fact.id}`,
    ]
    if (fact.reviewBy) {
      lines.push(`Review by: ${fact.reviewBy}`)
    }
    if (autoLinkedFromSession) {
      lines.push(`Source (auto-linked from session): ${effectiveSource}`)
    } else {
      lines.push(`Source: ${effectiveSource}`)
    }
    if (enriched.length > 0) {
      lines.push(`Merged: ${enriched.join("; ")}`)
    }
    if (toolWarnings.length > 0) {
      lines.push(`Warnings: ${toolWarnings.join("; ")}`)
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    }
  } catch (err) {
    return toolError(err)
  }
}

export async function handleInvalidate(
  services: LoreServices,
  args: { factId: string; sourceMemoryId?: string }
): Promise<ToolResult> {
  try {
    // Read first so we capture `sourceMemoryId` before the invalidate write —
    // `pageToFact`'s historical-tracking-predicate filter races against
    // `Valid Until` updates if the read happens after invalidation, and
    // `FactService.invalidate` returns `void`. A `null` from `getById`
    // can mean three things: the page came back partial (Notion `is_full_page`
    // guard fails), the row is archived (`getById` returns
    // null for archived rows so callers stay symmetric across "row missing"
    // and "row archived"), or the row is one of the historical tracking
    // predicates that `pageToFact` filters out. In all three cases there is
    // no provenance link to penalize. The archived case ALSO short-circuits
    // inside `FactService.invalidate` itself — no `Valid Until` write lands
    // on archived rows.
    const fact = await services.facts.getById(args.factId)
    // When the caller threads `sourceMemoryId`, that becomes
    // the `Invalidated By` relation: the memory that prompted the
    // invalidation. Distinct from the fact's existing `Source` link
    // (`fact.sourceMemoryId`), which names the *supporting* memory at
    // creation time. Both axes can coexist on one row.
    //
    // Precheck matches `handleLearn`'s provenance contract: the
    // invalidating memory must resolve to a live (non-archived)
    // Memories row, and its project scope must be compatible with
    // the fact's. Without this gate the relation accepts any
    // same-workspace id the token can see — including archived
    // memories and memories scoped to an unrelated project — which
    // pollutes the audit trail the `Invalidated By` column exists to
    // provide. Omit the second argument entirely when no provenance
    // is threaded so the single-arg call site stays byte-stable.
    if (args.sourceMemoryId) {
      let invalidatingProjectIds: string[]
      try {
        const invalidatingMemory = await services.memories.getPropertiesById(
          args.sourceMemoryId
        )
        invalidatingProjectIds = invalidatingMemory.projectIds
      } catch (err) {
        // R5 nit fix: distinguish "memory truly missing/inaccessible"
        // (the user-facing `invalidation-source-unresolved` failure
        // class — surfaced to the agent so it can pick a different
        // sourceMemoryId or drop the argument) from transient
        // 429 / 5xx / network errors (the operator-facing failure
        // class — surfaced to the outer `toolError` with the raw
        // Notion error so the agent sees the transient and can
        // retry). The bare-catch shape earlier collapsed every
        // failure into the unresolved error, degrading the
        // operator's mental model during rate-limit blips.
        if (isTransientNotionError(err)) {
          throw err
        }
        return toolError(
          new Error(
            `invalidation-source-unresolved: sourceMemoryId ${args.sourceMemoryId} did not resolve to a live Memories row. ` +
              `Pass an existing memory ID for the invalidation provenance, or omit sourceMemoryId to skip the audit link.`
          )
        )
      }
      // Compatibility is one-sided here: the fact may have no projectIds
      // (vault-wide), in which case any source memory is compatible.
      // Otherwise the source must share at least one project, or be
      // vault-wide itself. Mirrors `handleLearn`'s projectsCompatible
      // shape so the audit-link policy and the create-time provenance
      // policy stay aligned.
      const factProjectIds = fact?.projectIds ?? []
      if (!projectsCompatible(factProjectIds, invalidatingProjectIds)) {
        return toolError(
          new Error(
            `invalidation-source-cross-project: sourceMemoryId ${args.sourceMemoryId} is scoped to a different project than this fact. ` +
              `Use a memory from the same project, or a vault-wide memory.`
          )
        )
      }
      await services.facts.invalidate(args.factId, {
        sourceMemoryId: args.sourceMemoryId,
      })
    } else {
      await services.facts.invalidate(args.factId)
    }

    const sourceMemoryId = fact?.sourceMemoryId ?? null
    if (sourceMemoryId !== null) {
      // Contradiction decrement is advisory: a transient 429 on the
      // source-memory read OR the `pages.update` write must not fail
      // the surrounding `lore-fact` response. The user already got the
      // contradiction write they asked for (the fact IS invalidated).
      // Both calls live under the same `try/catch` so a future
      // contributor can't accidentally narrow the advisory scope by
      // moving one out — collapsing the inner `.catch` away here would
      // let the decrement throw propagate to `toolError`.
      // `getPropertiesById` skips the `retrieveMarkdown` round-trip
      // because the decrement algebra reads only `id`, `confidence`,
      // `confidenceScore`, `lastReferencedAt`, `createdAt`.
      try {
        const sourceMemory = await services.memories.getPropertiesById(sourceMemoryId)
        await services.memories.decrementConfidence(sourceMemory)
      } catch (err) {
        debugLogContradictionFailure("invalidate", sourceMemoryId, err)
      }
    }

    return {
      content: [{ type: "text", text: `Invalidated fact ${args.factId}` }],
    }
  } catch (err) {
    return toolError(err)
  }
}

export async function handleExtendFact(
  services: LoreServices,
  args: { factId: string; reviewBy: string | null }
): Promise<ToolResult> {
  try {
    await services.facts.extendReview(args.factId, args.reviewBy)
    if (args.reviewBy === null) {
      return {
        content: [{ type: "text", text: `Cleared review date for ${args.factId}` }],
      }
    }
    return {
      content: [
        {
          type: "text",
          text: `Extended review date for ${args.factId} to ${args.reviewBy}`,
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

interface AskArgs {
  entity: string
  projectName?: string
  limit?: number
  includeContext?: boolean
  /**
   * Transaction-time recall cutoff. YYYY-MM-DD form. Returns
   * the slice of facts Lore knew about by this date and had not yet
   * invalidated by this date.
   */
  asOf?: string
  /**
   * Include invalidated facts in the result. Default false
   * — only live facts surface. Useful for tracing how knowledge about an
   * entity changed over time.
   */
  includeHistory?: boolean
}

export async function handleAsk(
  services: LoreServices,
  args: AskArgs,
  toolName: string
): Promise<ToolResult> {
  try {
    // Matches `handleWakeUp`'s explicit-projectName rule: the framing
    // block describes the project the rest of the response is filtered
    // to. Explicit picks are strict and never catch-all fallbacks;
    // omitted scope reads from `services.context`.
    const {
      projectId,
      project: resolvedProject,
      isCatchAllFallback: resolvedCatchAllFallback,
    } = await resolveReadProjectScope(services, args.projectName)
    const warnings: string[] = []

    // PF3-01 — resolve the entity name to a canonical row first so the
    // fact lookup can ride the relation join. Strict mode (no
    // auto-create): the read path must not mint canonical rows just by
    // looking up an unknown entity. Ambiguity surfaces as a warning;
    // the substring-fallback query still runs underneath so the agent
    // sees something useful even when the user's input maps to two
    // distinct canonical entities (e.g. `User (auth context)` and
    // `User (db schema)`).
    let entityId: string | null = null
    let resolvedEntity: { name: string; aliases: string[] } | null = null
    const resolution = await services.entities
      .resolveOrCreateEntity(args.entity, { autoCreate: false })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`Entity lookup failed: ${message}`)
        return null
      })
    if (resolution) {
      if (resolution.ambiguous) {
        const candidateLabels = resolution.candidates
          .map((c) => `"${c.name}" (${c.id})`)
          .join(", ")
        warnings.push(
          `"${args.entity}" matches ${resolution.candidates.length} entities — falling back to substring search. ` +
            `Disambiguate by passing one of: ${candidateLabels}.`
        )
      } else if (resolution.entity) {
        entityId = resolution.entity.id
        resolvedEntity = {
          name: resolution.entity.name,
          aliases: resolution.entity.aliases,
        }
      }
    }

    // Fact recall already rides the canonical relation when the entity
    // resolves; tasks are still a free-form text column, so mirror the
    // fact side's alias awareness by expanding the resolved entity into
    // a deduped variant set. Ambiguous / unresolved paths collapse to
    // the raw input and behave like the substring
    // contract. The cap warning surfaces only when an alias drift
    // would have clipped recall; under the cap the lookup is silent.
    const taskVariants = expandEntityQueryVariants(args.entity, resolvedEntity)
    if (taskVariants.hitCap) {
      const droppedLabel = taskVariants.dropped
        .slice(0, 3)
        .map((d) => `"${d}"`)
        .join(", ")
      const remainder =
        taskVariants.dropped.length > 3
          ? `, +${taskVariants.dropped.length - 3} more`
          : ""
      warnings.push(
        `Task recall capped at ${taskVariants.variants.length} alias variants for "${args.entity}" — ` +
          `dropped ${droppedLabel}${remainder}. Tasks written under the dropped aliases may be missed.`
      )
    }

    // Fetch facts and tasks in parallel — they're independent queries
    // and `lore-query action='ask'` is on the agent hot path. Failures
    // on the tasks side
    // surface as a warning rather than collapsing the call so a transient
    // 5xx on the tasks query does not nuke the facts response.
    //
    // `expandEntityQueryVariants` returns the raw input as the first
    // variant whenever the input is non-empty, so the fallback to
    // `[args.entity]` only fires for the degenerate empty / whitespace
    // case (preserves the legacy `entity: args.entity` contract there
    // — Notion's substring filter against `""` is a vault-wide match
    // and the call is degenerate either way).
    const taskListEntities =
      taskVariants.variants.length > 0 ? taskVariants.variants : [args.entity]
    const [facts, taskListing] = await Promise.all([
      services.facts.queryByEntity(args.entity, {
        projectId,
        entityId,
        // Temporal recall controls. `asOf` switches the
        // domain-truth `Valid Until is_empty` filter for a transaction-
        // time pair (Observed At ≤ asOf AND (Invalidated At empty OR
        // > asOf)). `includeHistory` drops the live-only gate entirely
        // so invalidated facts surface alongside live ones. The two are
        // independent — combine them when you want "what Lore knew at
        // T, including rows it had already invalidated by T" (rare;
        // typically callers pick one).
        asOf: args.asOf,
        includeInvalidated: args.includeHistory,
      }),
      services.tasks
        .list({ projectId, entities: taskListEntities, limit: 50 })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          warnings.push(`Tasks lookup failed: ${message}`)
          return { items: [] as TaskSummary[] }
        }),
    ])
    const tasks = taskListing.items

    // Single-paragraph framing block. Defaults
    // to `includeContext !== false` so cold-start agents and monorepo
    // hops see project + siblings + catch-all warnings without a
    // separate `lore-context action='wake-up'` round-trip. Agents with
    // system-prompt framing pass `includeContext: false` to suppress.
    const includeContextBlock = args.includeContext !== false
    const projectContextLines = includeContextBlock
      ? renderProjectContextLines(
          composeProjectContext(
            resolvedProject,
            services.config,
            resolvedCatchAllFallback
          )
        )
      : []
    const framingPrefix =
      projectContextLines.length > 0 ? `${projectContextLines.join("\n")}\n\n` : ""

    const formatWarnings = () =>
      warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

    if (facts.length === 0 && tasks.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `${framingPrefix}No facts or tasks found about "${args.entity}".${formatWarnings()}`,
          },
        ],
      }
    }

    const today = new Date().toISOString().split("T")[0]
    const cap = args.limit ?? DEFAULT_ASK_BUCKET_CAP
    const { governance, structure } = groupFactsByClass(facts)

    const decidedByFacts = governance.filter((fact) => fact.predicate === "decided_by")
    const supersedesFacts = governance.filter(
      (fact) => fact.predicate === "supersedes_decision"
    )

    // Dispatch the canonical-decision-link walk and the title-resolution
    // pass in parallel — they're data-independent (different fact subsets
    // in, disjoint outputs out) and both ride the shared rate-limited
    // Notion client, so concurrency here cuts wall-clock to the slower
    // of the two without raising peak Notion load.
    //
    // Failure-semantics note: `Promise.all` short-circuits on the first
    // rejection, which would lose `debugLogPartialFailures` observability
    // if either callee threw. Neither does under normal Notion error
    // paths — `resolveCanonicalDecisionLinks` surfaces failures through
    // a structured `failures` array via `settleAll`, and
    // `MemoryService.getTitleById` catches `titleCache.getOrLoad(id, () =>
    // fetchTitle(id))` rejections and returns `null`. `fetchTitle`
    // returns `null` for known-absent
    // ids (404 / RestrictedResource / archived) so `getOrLoad` commits a
    // tombstone, and throws for transient errors (429 / 5xx / network)
    // so `getOrLoad` rejects without caching — `getTitleById`'s catch
    // converts the rejection into a `null` render. If a future change
    // makes either callee throw, swap to `Promise.allSettled` here so
    // the failures bucket is still drained.
    const [{ links: decisionLinks, failures: decisionFailures }, titleMap] =
      await Promise.all([
        resolveCanonicalDecisionLinks(services, decidedByFacts, { projectId }),
        resolveReferencedTitles([...supersedesFacts, ...structure], services),
      ])

    if (decisionFailures.length > 0) {
      debugLogPartialFailures(toolName, decisionFailures)
      const rootIds = decisionFailures.map(({ rootId }) => rootId).join(", ")
      warnings.push(
        `Could not resolve ${decisionFailures.length} decision root${decisionFailures.length === 1 ? "" : "s"} (${rootIds}) — retry before relying on this result.`
      )
    }

    // Each governance row carries its underlying cite reference (a
    // Decision for `decided_by` links, a Fact for `supersedes_decision`)
    // so the post-cap touch collector can walk the visible slice
    // without re-deriving the partition. See `collectAskSourceMemoryIds`.
    type Governed = {
      sortKey: string | null
      line: string
      decision?: Decision
      fact?: Fact
    }
    const governanceItems: Governed[] = [
      ...decisionLinks.map(({ fact, decision }) => ({
        sortKey: fact.validFrom,
        line: renderDecidedByLine(fact, decision, today),
        decision,
        fact,
      })),
      ...supersedesFacts.map((fact) => ({
        sortKey: fact.validFrom,
        line: renderFact(fact, {
          titleMap,
          trailing: renderGenericTrailing(fact, today, { asOf: args.asOf }),
        }),
        fact,
      })),
    ]
    // DEFERRED-02 — confidence-weighted RRF over the recency order.
    // Primary signal is recency (rank by `validFrom` desc); the
    // per-fact `confidenceFactor` multiplies the rank score so a
    // frequently-cited older fact can outrank a low-confidence newer
    // fact, not just break ties at the same `validFrom`. Pre-migration
    // vaults (every score `null`) collapse to `factor === 1.0` and the
    // RRF pass becomes monotonic-by-rank == identical to the
    // recency-only sort.
    const rankedGovernance = applyConfidenceWeightedRrf(governanceItems)

    type Structured = { fact: Fact; line: string; sortKey: string | null }
    const structureItems: Structured[] = structure.map((fact) => ({
      fact,
      line: renderFact(fact, {
        titleMap,
        trailing: renderGenericTrailing(fact, today, { asOf: args.asOf }),
      }),
      sortKey: fact.validFrom,
    }))
    const rankedStructure = applyConfidenceWeightedRrf(structureItems)

    const sections: string[] = []
    let anyOverflow = false

    // Visible-slice tracking for the touch collector: only rows the
    // agent actually sees count as cites. Hidden-overflow rows are
    // suppressed via `(N hidden)` and bumping their `Confidence Score`
    // would inflate RRF's confidence factor against rows that were
    // never displayed.
    let visibleGovernance: Governed[] = []
    let visibleStructure: Structured[] = []

    // Slicing pulls from the RRF-ranked arrays (DEFERRED-02) so the
    // visible cap shows the highest-scoring rows; section counts stay
    // on the unranked arrays so `### Governance (N)` reports the true
    // total. Rank only changes WHICH rows make the cap, not how many.
    if (governanceItems.length > 0) {
      visibleGovernance = rankedGovernance.slice(0, cap)
      const hidden = governanceItems.length - visibleGovernance.length
      if (hidden > 0) anyOverflow = true
      const hiddenSuffix = hidden > 0 ? ` (${hidden} hidden)` : ""
      sections.push(
        `### Governance (${governanceItems.length})${hiddenSuffix}\n${visibleGovernance
          .map((item) => item.line)
          .join("\n")}`
      )
    }

    if (structureItems.length > 0) {
      visibleStructure = rankedStructure.slice(0, cap)
      const hidden = structureItems.length - visibleStructure.length
      if (hidden > 0) anyOverflow = true
      const hiddenSuffix = hidden > 0 ? ` (${hidden} hidden)` : ""
      sections.push(
        `### Structure (${structureItems.length})${hiddenSuffix}\n${visibleStructure
          .map((item) => item.line)
          .join("\n")}`
      )
    }

    // Tasks bucket — surfaces tracked work touching the entity. The
    // legacy open-loops view was a fact partition; tasks are the
    // canonical surface now and this section is what
    // `lore-query action='ask'` callers see in its place.
    type Tasked = { sortKey: string | null; line: string }
    const taskItems: Tasked[] = tasks.map((t) => {
      const overdueDays = taskDaysOverdue(t, today)
      const stateLabel = t.taskState ?? "open"
      const blocker = t.blockedBy ? `, blocked by ${t.blockedBy}` : ""
      const due =
        overdueDays !== null && t.reviewBy
          ? overdueDays === 0
            ? " **(due today)**"
            : ` **(${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue — review by ${t.reviewBy})**`
          : t.reviewBy
            ? ` (due ${t.reviewBy})`
            : ""
      const prefix = overdueDays !== null ? "⚠ " : ""
      return {
        // Tasks have no `validFrom` — the agent-relevant ordering is
        // most-pressing-first. Sort by `Review By` ascending; fall back
        // to `decidedAt` when no due date is set so newer-but-undated
        // tasks order before truly stale ones; null sinks to the bottom.
        sortKey: t.reviewBy ?? t.decidedAt ?? null,
        line: `- ${prefix}**${t.title}** [${stateLabel}${blocker}]${due}\n  Task ID: ${t.id}`,
      }
    })
    taskItems.sort((a, b) => {
      if (a.sortKey === b.sortKey) return 0
      if (!a.sortKey) return 1
      if (!b.sortKey) return -1
      return a.sortKey < b.sortKey ? -1 : 1
    })

    if (taskItems.length > 0) {
      const visible = taskItems.slice(0, cap)
      const hidden = taskItems.length - visible.length
      if (hidden > 0) anyOverflow = true
      const hiddenSuffix = hidden > 0 ? ` (${hidden} hidden)` : ""
      sections.push(
        `### Tasks (${taskItems.length})${hiddenSuffix}\n${visible
          .map((item) => item.line)
          .join("\n")}`
      )
    }

    if (sections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `${framingPrefix}No current facts or tasks found about "${args.entity}".${formatWarnings()}`,
          },
        ],
      }
    }

    const totalFacts = governanceItems.length + structureItems.length + taskItems.length
    const overflowHint =
      anyOverflow && args.limit === undefined
        ? `\n\n(pass limit to raise the cap; e.g. limit=${SUGGESTED_OVERFLOW_LIMIT})`
        : ""

    // Header noun: tasks become first-class in the same response, so a
    // vault with only tasks (and sparse facts after the migration)
    // doesn't misreport "0 facts" when the section actually rendered.
    const noun = taskItems.length > 0 && facts.length === 0 ? "results" : "facts"
    const response: ToolResult = {
      content: [
        {
          type: "text",
          text: `${framingPrefix}${totalFacts} ${noun} about "${args.entity}":\n\n${sections.join("\n\n")}${overflowHint}${formatWarnings()}`,
        },
      ],
    }

    // Citation-as-evidence. The ask response surfaces
    // canonical decisions (decisions are memories) and the source
    // memories backing each fact; both are cites and both bump the
    // confidence column. The IDs are surfaced but the full memories
    // aren't materialized in this handler — `getManyById` refreshes
    // them so `touchOnRead`'s short-circuit / seed branches read
    // current `confidenceScore` / `lastReferencedAt` / `confidence`.
    // The cost (one `pages.retrieve` per cited row, properties-only)
    // is the seam the spec accepts.
    //
    // Scoped to **visible** slices: rows past the per-bucket cap
    // (`(N hidden)`) are not surfaced to the agent, so touching their
    // backing memories would inflate RRF's confidence factor against
    // rows that were never cited. See `collectAskSourceMemoryIds`.
    const sourceMemoryIds = collectAskSourceMemoryIds(visibleGovernance, visibleStructure)
    if (sourceMemoryIds.length > 0) {
      try {
        const cited = await services.memories.getManyById(sourceMemoryIds)
        await fireTouchOnRead(services.memories, cited, "lore-query (ask)")
      } catch {
        // advisory — never block the response on a getManyById throw
      }
    }

    // DEFERRED-02 — fact-side touch-on-read. Mirrors the memory-side
    // citation-as-evidence wiring above: every fact actually displayed
    // (visible governance + visible structure, NOT the hidden-overflow
    // tail) counts as cited and bumps `Confidence Score` +
    // `Last Referenced At`. The fact objects are already in-memory from
    // the `queryByEntity` call, so no extra round-trip is needed before
    // the touch.
    const visibleFacts: Fact[] = [
      ...visibleGovernance.flatMap((g) => (g.fact ? [g.fact] : [])),
      ...visibleStructure.map((s) => s.fact),
    ]
    await fireFactTouchOnRead(services.facts, visibleFacts, "lore-query (ask)")

    return response
  } catch (err) {
    return toolError(err)
  }
}

export async function handleAudit(
  services: LoreServices,
  args: { projectName?: string }
): Promise<ToolResult> {
  try {
    const { projectId } = await resolveReadProjectScope(services, args.projectName)

    const warnings: string[] = []
    const overdueDecisionQuery =
      typeof services.decisions.queryOverdueWindow === "function"
        ? services.decisions.queryOverdueWindow({ projectId })
        : services.decisions
            .queryOverdue({ projectId })
            .then((items) => ({ items, capped: false }))
    const overdueTaskQuery =
      typeof services.tasks.queryOverdueWindow === "function"
        ? services.tasks.queryOverdueWindow({ projectId })
        : services.tasks
            .queryOverdue({ projectId })
            .then((items) => ({ items, capped: false }))

    let taskLookupFailed = false
    const [overdueFacts, overdueDecisionWindow, overdueTaskWindow] = await Promise.all([
      services.facts.queryOverdue({ projectId }),
      overdueDecisionQuery,
      overdueTaskQuery.catch((err) => {
        taskLookupFailed = true
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`Tasks lookup failed: ${message}`)
        return { items: [] as TaskSummary[], capped: false }
      }),
    ])
    const overdueDecisions = overdueDecisionWindow.items
    const overdueTasks = overdueTaskWindow.items
    if (overdueDecisionWindow.capped) {
      warnings.push(
        "Overdue decision scan reached the live-row refill cap; more overdue decisions may exist."
      )
    }
    if (overdueTaskWindow.capped) {
      warnings.push(
        "Overdue task scan reached the live-row refill cap; more overdue tasks may exist."
      )
    }
    const cappedFooter = paginationFooter(undefined, {
      truncated: overdueDecisionWindow.capped || overdueTaskWindow.capped,
    })

    const formatWarnings = () =>
      warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

    if (
      overdueFacts.length === 0 &&
      overdueDecisions.length === 0 &&
      overdueTasks.length === 0
    ) {
      const text = taskLookupFailed
        ? "No overdue facts or decisions found. Overdue tasks could not be checked."
        : "No overdue facts, decisions, or tasks found."
      return {
        content: [
          {
            type: "text",
            text: text + formatWarnings() + cappedFooter,
          },
        ],
      }
    }

    const today = new Date().toISOString().split("T")[0]
    const sections: string[] = []

    if (overdueFacts.length > 0) {
      const factLines = overdueFacts
        .map((f) => {
          const days = Math.floor(
            (new Date(today).getTime() - new Date(f.reviewBy!).getTime()) / 86_400_000
          )
          const since = f.validFrom ? ` (since ${f.validFrom})` : ""
          // DEFERRED-02 — emit the trust line between the title row
          // and the Review by row when the fact's `confidenceScore`
          // has decayed below `CONFIDENCE_DISPLAY_THRESHOLD`. Same
          // shape as the symmetric Overdue Decisions block below
          // (DEFERRED-07) so an audit reader sees the trust signal
          // immediately under the title and BEFORE the staleness
          // detail. `renderTrustLine` returns null for null /
          // above-threshold scores, so unmigrated-vault audit output
          // is byte-identical to pre-DEFERRED-02.
          const trustLine = renderTrustLine(f.confidenceScore ?? null, "  ")
          const trustRow = trustLine !== null ? `${trustLine}\n` : ""
          return (
            `- **${f.subject}** ${f.predicate.replace(/_/g, " ")} **${f.object}** [${f.confidence}]${since}\n` +
            trustRow +
            `  Review by: ${f.reviewBy} (${days} day${days === 1 ? "" : "s"} overdue)\n` +
            `  ID: ${f.id}`
          )
        })
        .join("\n")
      sections.push(`## Overdue Facts (${overdueFacts.length})\n\n${factLines}`)
    }

    if (overdueDecisions.length > 0) {
      const decisionLines = overdueDecisions
        .map((d) => {
          const days = d.reviewBy
            ? Math.floor(
                (new Date(today).getTime() - new Date(d.reviewBy).getTime()) / 86_400_000
              )
            : 0
          const decided = d.decidedAt ? ` | decided ${d.decidedAt}` : ""
          // Trust indicator (0.9.0/DEFERRED-07). Bullet-shaped surface
          // with continuation lines — the trust line sits between the
          // title row and the Review By row so the audit reader sees
          // the signal before the staleness detail. Same indent as
          // the surrounding continuation lines.
          const trustLine = renderTrustLine(d.confidenceScore, "  ")
          const trustRow = trustLine !== null ? `${trustLine}\n` : ""
          return (
            `- **${d.title}** [${d.status}]${decided}\n` +
            trustRow +
            `  Review by: ${d.reviewBy} (${days} day${days === 1 ? "" : "s"} overdue)\n` +
            `  ID: ${d.id}`
          )
        })
        .join("\n")
      sections.push(
        `## Overdue Decisions (${overdueDecisions.length})\n\n${decisionLines}`
      )
    }

    if (overdueTasks.length > 0) {
      // Audit is the comprehensive overdue-review surface. Wake-up keeps its
      // smaller triage view via `tasks.list` and buckets overdue/stale/active.
      const taskRows = overdueTasks.flatMap((t) => {
        const days = taskDaysOverdue(t, today)
        if (days === null) {
          warnings.push(`Task ${t.id}: failed to compute overdue days, skipping`)
          return []
        }
        const stateLabel = t.taskState ?? "open"
        const blocked = t.blockedBy ? `, blocked by ${t.blockedBy}` : ""
        const entity = t.entity ? ` | entity ${t.entity}` : ""
        const trustLine = renderTrustLine(t.confidenceScore ?? null, "  ")
        const trustRow = trustLine !== null ? `${trustLine}\n` : ""
        return [
          `- **${t.title}** [${stateLabel}${blocked}]${entity}\n` +
            trustRow +
            `  Review by: ${t.reviewBy} (${days} day${days === 1 ? "" : "s"} overdue)\n` +
            `  ID: ${t.id}`,
        ]
      })
      if (taskRows.length > 0) {
        sections.push(`## Overdue Tasks (${taskRows.length})\n\n${taskRows.join("\n")}`)
      }
    }

    if (sections.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "No overdue facts or decisions found. Overdue tasks could not be rendered." +
              formatWarnings(),
          },
        ],
      }
    }

    const actions = [
      "",
      "Actions:",
      "- **Fact — invalidate**: `lore-fact` with `action: 'invalidate'` if no longer true",
      "- **Fact — extend**: `lore-fact` with `action: 'extend'` and a new review date",
      "- **Decision — mark reviewed**: `lore-decision` with `action: 'review'`",
      "- **Decision — supersede**: `lore-decision` with `action: 'supersede'` and a replacement",
      "- **Task — close**: `lore-task` with `action: 'close'` and `state: 'done'` if completed",
      "- **Task — update due date**: `lore-task` with `action: 'update'` and `dueDate`",
      "- **Task — unblock**: `lore-task` with `action: 'update'`, a non-blocked `state`, and `blockedBy: ''`",
      "- **Task — cancel**: `lore-task` with `action: 'close'` and `state: 'cancelled'` if abandoned",
      "- **No change**: leave as-is if still under review",
    ]

    return {
      content: [
        {
          type: "text",
          text:
            sections.join("\n\n") +
            "\n" +
            actions.join("\n") +
            formatWarnings() +
            cappedFooter,
        },
      ],
    }
  } catch (err) {
    return toolError(err)
  }
}

const factDispatchSchema = z
  .discriminatedUnion("action", [
    z.object({
      action: z.literal("create"),
      // Reject empty / whitespace-only subject and object at the
      // boundary; write-path symmetric with the read-path guard. An empty
      // / whitespace-only triple would land in `createWithDedup`,
      // hash through `normalize("")` into `DedupKey`, and persist a
      // structurally degenerate fact row that confuses downstream
      // consumers: `queryBySubject` won't surface it, `repointEntity`
      // sees an empty key, and the dedup probe collides every empty-
      // subject fact onto one slot. Shared `nonBlankString` matches
      // the `.trim().min(1)` posture used by `lore-query action='ask'`'s
      // `entity` schema.
      subject: nonBlankString,
      predicate: z.enum(PREDICATE_VALUES),
      object: nonBlankString,
      projectName: z.string().optional(),
      projectNames: z.array(z.string()).optional(),
      reviewBy: clearableYmdDateSchema.optional(),
      confidence: z.enum(CONFIDENCES).optional(),
      sourceMemoryId: z.string().optional(),
      session: z.string().optional(),
      agent: z.string().optional(),
      scope: scopeInputSchema,
    }),
    z.object({
      action: z.literal("invalidate"),
      factId: z.string(),
      // Optional invalidation provenance. The memory id
      // recorded on the fact's `Invalidated By` relation, distinct from
      // `Source` (creation-time provenance). Optional because operators
      // sometimes invalidate without a memory to point at (e.g. an
      // ad-hoc cleanup pass).
      sourceMemoryId: z.string().optional(),
    }),
    z.object({
      action: z.literal("extend"),
      factId: z.string(),
      reviewBy: clearableYmdDateSchema,
    }),
  ])
  .superRefine((args, ctx) => {
    if (args.action !== "create") return
    const sourceMemoryId = args.sourceMemoryId?.trim()
    if (sourceMemoryId) return
    const agent = args.agent?.trim()
    const session = args.session?.trim()
    if (agent && session) return
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceMemoryId"],
      message:
        "provenance-missing: pass a non-empty sourceMemoryId, or pass both non-empty " +
        "agent and session so Lore can auto-link a compatible session memory.",
    })
  })

export function registerKnowledgeTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-fact — polymorphic dispatcher
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-fact",
    {
      title: "Knowledge graph fact mutations",
      description:
        "Create/invalidate facts; set or clear fact review dates. Action-dispatched:\n\n" +
        "- `action: 'create'` — add a Subject —predicate→ Object triple. Auto-dedupes against existing equivalent triples and merges metadata onto the survivor.\n" +
        "- `action: 'invalidate'` — mark a fact as no longer true (sets `Valid Until` and `Invalidated At` to today). Preserved for history. Pass `sourceMemoryId` to record which memory prompted the invalidation in the `Invalidated By` relation. Side effect: when the fact has a `Source` memory, that memory's `Confidence Score` is halved as a contradiction signal (DEFERRED-02 / 0.8.0/#06).\n" +
        "- `action: 'extend'` — set or clear a fact's review-by date.\n\n" +
        "Every created fact MUST link back to a supporting memory via `sourceMemoryId` so `lore-query action='ask'` can retrace the reasoning. Pass a live Memories row ID directly, or pass `agent`+`session` matching an earlier `lore-memory action='save'` / `lore-decision action='create'` call in the same process and `sourceMemoryId` auto-links. If neither path produces a compatible Source memory, the create call is rejected before writing.\n\n" +
        "Decision predicates (`decided_by`, `supersedes_decision`, `informs`) and the auto-emitted `mentions` predicate are internal-only and not accepted here — `decided_by` / `supersedes_decision` / `informs` are auto-created by the decision tool family; `mentions` is auto-emitted by `lore-memory action='save'`. Use richer relationship predicates (`uses`, `depends_on`, etc.) for agent-curated edges.",
      inputSchema: {
        action: z
          .enum(["create", "invalidate", "extend"])
          .describe("Operation: create, invalidate, or extend (set/clear review date)."),
        // create
        subject: z
          .string()
          .optional()
          .describe("(action='create') The entity this fact is about."),
        predicate: z
          .enum(PREDICATE_VALUES)
          .optional()
          .describe("(action='create') The relationship type."),
        object: z
          .string()
          .optional()
          .describe("(action='create') The related entity or value."),
        projectName: z
          .string()
          .optional()
          .describe("(action='create') Scope to a project."),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("(action='create') Multiple project names for cross-project facts."),
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe("(action='create') Confidence (default: certain)."),
        sourceMemoryId: z
          .string()
          .optional()
          .describe(
            "(action='create') ID of the memory that supports this fact. Required unless agent+session auto-links a compatible source memory. " +
              "(action='invalidate') Optional ID of the memory that prompted the invalidation; recorded in the fact's `Invalidated By` relation.",
          ),
        session: z
          .string()
          .optional()
          .describe(
            "(action='create') Session ID. With `agent`, used to auto-link `sourceMemoryId`."
          ),
        agent: z
          .string()
          .optional()
          .describe("(action='create') Agent name. Part of the session composite key."),
        // shared (create | extend)
        reviewBy: clearableYmdDateSchema
          .optional()
          .describe(
            "(action='create' optional, action='extend' required) Review-by date (YYYY-MM-DD). On create, null or empty string means no initial review date; on extend, null or empty string clears."
          ),
        // invalidate | extend
        factId: z
          .string()
          .optional()
          .describe(
            "Required for action='invalidate' and action='extend'. The fact's page ID."
          ),
        scope: scopeInputSchema,
      },
    },
    async (args) => {
      const parsed = factDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(new Error(formatDispatchError("lore-fact", parsed.error)))
      }
      const data = parsed.data
      switch (data.action) {
        case "create":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleLearn(services, data),
          )
        case "invalidate":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleInvalidate(services, data),
          )
        case "extend":
          return withWakeUpCacheBump(services.wakeupCache, () =>
            handleExtendFact(services, data),
          )
      }
    }
  )
}
