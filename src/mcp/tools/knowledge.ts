import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError, debugLogPartialFailures } from "../helpers.js"
import { resolveProjectIds } from "../resolve.js"
import { resolveCanonicalDecisionLinks } from "../decision-graph.js"
import { groupFactsByClass, renderFact, resolveReferencedTitles } from "../render.js"

import type { Decision, Fact } from "../../types.js"

/**
 * Default per-bucket cap for `lore-ask`'s grouped display (P2-06).
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
 * Default per-bucket cap for `lore-open-loops`. The Mail vault has 271 open
 * loops; returning all of them on every ambient call floods the agent
 * context. Ten per bucket matches how humans scan a triage list — enough
 * to see the urgency spread, short enough to act on.
 */
const DEFAULT_OPEN_LOOPS_LIMIT = 10

/** Days-overdue threshold for the `⚠⚠` marker. At or above this, the row is
 * flagged as severely overdue. */
const OVERDUE_SEVERE_DAYS = 14

/** Days-overdue threshold for the `⚠` marker. At or above this (but below
 * `OVERDUE_SEVERE_DAYS`), the row gets a single warning. Zero-day rows
 * (reviewBy === today) are in the overdue bucket but unmarked. */
const OVERDUE_MILD_DAYS = 1

/**
 * Ranking contract for `lore-open-loops`.
 *
 * **Overdue** (`rankOverdue`): sort by days-overdue **descending** — the
 * most-overdue row floats to the top. Tiebreakers, in order:
 * 1. `validFrom` **descending** — newer assertions of the same-age open
 *    loop appear above dormant ones.
 * 2. `id` ascending (lex) — ultimate deterministic tiebreaker so two rows
 *    with identical age and `validFrom` (same-day assertions of identical
 *    triples) still sort in a stable, test-pinnable order regardless of
 *    Notion's result-page ordering.
 *
 * **Active** (`rankActive`): sort by `reviewBy` **ascending** — the row
 * closest to its review date floats to the top. Null `reviewBy` sinks to
 * the bottom via an explicit-null comparator (no sentinel string). Within
 * equal `reviewBy`:
 * 1. `validFrom` **descending** — see above.
 * 2. `id` ascending (lex) — see above.
 *
 * Urgency markers (`rankOverdue` only): `⚠⚠` at >= `OVERDUE_SEVERE_DAYS`,
 * `⚠` at >= `OVERDUE_MILD_DAYS`, empty below.
 *
 * This contract is pinned by tests in `knowledge.test.ts` under the
 * `lore-open-loops` describe block. Changes here are observable to agents
 * and require a coordinated spec revision.
 */

/** Ordering function for the Overdue bucket. See ranking contract above. */
function rankOverdue(a: Fact, b: Fact, daysOverdue: (f: Fact) => number): number {
  const byDays = daysOverdue(b) - daysOverdue(a)
  if (byDays !== 0) return byDays
  const byValidFrom = (b.validFrom ?? "").localeCompare(a.validFrom ?? "")
  if (byValidFrom !== 0) return byValidFrom
  return a.id.localeCompare(b.id)
}

/** Ordering function for the Active bucket. See ranking contract above. */
function rankActive(a: Fact, b: Fact): number {
  // Null reviewBy sinks to the bottom via explicit comparison — a sentinel
  // string ("9999-12-31") would work today but would silently break if the
  // type ever accepts ISO datetimes or a locale-aware format.
  if (a.reviewBy === null && b.reviewBy !== null) return 1
  if (a.reviewBy !== null && b.reviewBy === null) return -1
  if (a.reviewBy !== null && b.reviewBy !== null) {
    const byReview = a.reviewBy.localeCompare(b.reviewBy)
    if (byReview !== 0) return byReview
  }
  const byValidFrom = (b.validFrom ?? "").localeCompare(a.validFrom ?? "")
  if (byValidFrom !== 0) return byValidFrom
  return a.id.localeCompare(b.id)
}

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
  "needs_action",
  "waiting_on",
  "blocked_by",
] as const

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
function projectsCompatible(factProjectIds: string[], memoryProjectIds: string[]): boolean {
  if (factProjectIds.length === 0 || memoryProjectIds.length === 0) return true
  const memoryScope = new Set(memoryProjectIds)
  return factProjectIds.some((id) => memoryScope.has(id))
}

/**
 * Format a `decided_by` row with its canonical decision metadata. Kept as
 * a named helper (not inlined) because the Governance bucket interleaves
 * these rows with `supersedes_decision` rows and both need to feed the
 * same `{ sortKey, line }` pipeline.
 */
function renderDecidedByLine(fact: Fact, decision: Decision, today: string): string {
  const review = decision.reviewBy
    ? decision.reviewBy <= today
      ? ` **(DECISION REVIEW OVERDUE — ${decision.reviewBy})**`
      : ` (decision review by ${decision.reviewBy})`
    : ""
  const decided = decision.decidedAt ? ` (decided ${decision.decidedAt})` : ""
  return `- **${fact.subject}** decided by **${decision.title}** [${decision.status}, ${decision.confidence}]${decided}${review}\n  Decision ID: ${decision.id} | Fact ID: ${fact.id}`
}

/**
 * Trailing segment for a non-decision, non-tracking fact — the `[conf]
 * (since …) (review by …)` tail followed by the ID footer. Separated
 * from `renderTrackingTrailing` because tracking rows use the ⚠ prefix
 * plus a days-overdue marker instead of the generic `(OVERDUE — …)` text,
 * and collapsing both branches into one function obscures the intent.
 */
function renderGenericTrailing(fact: Fact, today: string): string {
  const validity = fact.validFrom ? ` (since ${fact.validFrom})` : ""
  const review = fact.reviewBy
    ? fact.reviewBy <= today
      ? ` **(OVERDUE — review by ${fact.reviewBy})**`
      : ` (review by ${fact.reviewBy})`
    : ""
  return `[${fact.confidence}]${validity}${review}\n  ID: ${fact.id}`
}

/**
 * Trailing segment for a tracking fact. Overdue rows get a
 * `(N days overdue — review by YYYY-MM-DD)` marker; rows due *today*
 * display "due today" rather than the misleading "0 days overdue" text.
 * Non-overdue rows use the plain review-by hint. The ⚠ prefix is
 * applied separately via `renderFact`'s `prefix` option.
 *
 * The overdue gate itself (`reviewBy <= today`) matches `core/fact.ts`
 * and the `lore-audit` handler — only the display differs for the
 * day-zero case.
 */
function renderTrackingTrailing(fact: Fact, overdueDays: number | null): string {
  const validity = fact.validFrom ? ` (since ${fact.validFrom})` : ""
  if (overdueDays !== null && fact.reviewBy) {
    const marker =
      overdueDays === 0
        ? "due today"
        : `${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue`
    return `[${fact.confidence}]${validity} **(${marker} — review by ${fact.reviewBy})**\n  ID: ${fact.id}`
  }
  const review = fact.reviewBy ? ` (review by ${fact.reviewBy})` : ""
  return `[${fact.confidence}]${validity}${review}\n  ID: ${fact.id}`
}

/**
 * Integer days a fact is past its `reviewBy` vs `today` (both
 * ISO-date strings). Returns `null` when the fact has no review date or
 * is still within its window — callers use that as the branch for
 * applying the ⚠ marker and overdue trailing.
 */
function daysOverdue(reviewBy: string | null, today: string): number | null {
  if (!reviewBy || reviewBy > today) return null
  const diff = new Date(today).getTime() - new Date(reviewBy).getTime()
  return Math.floor(diff / 86_400_000)
}

/**
 * Sort key comparator for `{ sortKey: string | null }` items, descending
 * (most recent first). Nulls sink to the end so rows without a validFrom
 * don't jump ahead of dated rows.
 */
function compareSortKeyDesc(
  a: { sortKey: string | null },
  b: { sortKey: string | null },
): number {
  if (a.sortKey === b.sortKey) return 0
  if (!a.sortKey) return 1
  if (!b.sortKey) return -1
  return a.sortKey < b.sortKey ? 1 : -1
}

export function registerKnowledgeTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-learn
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-learn",
    {
      title: "Add a fact",
      description:
        "Add a fact to the knowledge graph. Facts are entity-relationship " +
        "triples: Subject —predicate→ Object. Example: " +
        '"AuthService" uses "JWT" with confidence "certain".\n\n' +
        "Every fact SHOULD link back to a supporting memory via `sourceMemoryId` so `lore-ask` can " +
        "retrace the reasoning. Pass the memory ID directly, or pass `agent`+`session` matching an " +
        "earlier `lore-remember`/`lore-decide` call in the same process and `sourceMemoryId` " +
        "auto-links. If neither is available the fact is still created, but with a warning — this " +
        "will become a hard error in a future release.",
      inputSchema: {
        subject: z.string().describe("The entity this fact is about"),
        predicate: z.enum(PREDICATE_VALUES).describe("The relationship type"),
        object: z.string().describe("The related entity or value"),
        projectName: z.string().optional().describe("Scope to a project. Defaults to auto-detected project from cwd."),
        projectNames: z.array(z.string()).optional().describe("Multiple project names for cross-project facts."),
        reviewBy: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
          .optional()
          .describe(
            "Date (YYYY-MM-DD) by which this fact should be reviewed. " +
            "Tracking predicates (needs_action, waiting_on, blocked_by) auto-default to 7 days if omitted."
          ),
        confidence: z
          .enum(["certain", "likely", "speculative"])
          .optional()
          .describe("How confident is this fact (default: certain)"),
        sourceMemoryId: z
          .string()
          .optional()
          .describe("ID of the memory that supports this fact"),
        session: z
          .string()
          .optional()
          .describe(
            "Session ID. Combined with `agent`, used to auto-link `sourceMemoryId` to a memory saved " +
              "earlier in this process."
          ),
        agent: z
          .string()
          .optional()
          .describe("Agent name. Part of the composite session key used for auto-link."),
      },
    },
    async ({
      subject,
      predicate,
      object,
      projectName,
      projectNames,
      reviewBy,
      confidence,
      sourceMemoryId,
      session,
      agent,
    }) => {
      try {
        const resolved = await resolveProjectIds(services, projectName, projectNames)
        const factProjectIds = resolved.ids

        let effectiveSource: string | undefined = sourceMemoryId
        let autoLinkedFromSession = false
        const toolWarnings: string[] = [...resolved.warnings]

        if (!effectiveSource) {
          const candidate = services.sessionMemories.get({ agent, session })
          if (candidate) {
            if (projectsCompatible(factProjectIds, candidate.projectIds)) {
              effectiveSource = candidate.memoryId
              autoLinkedFromSession = true
            } else {
              // Scoped fact + scoped memory with disjoint projects: declining
              // the auto-link prevents a durable cross-project mis-link.
              // The caller can still pass `sourceMemoryId` explicitly if this
              // memory really is the right source.
              toolWarnings.push(
                `Declined auto-link: session memory ${candidate.memoryId} is scoped to a different project ` +
                  `than this fact. Pass sourceMemoryId explicitly to override.`
              )
            }
          }
        }

        const { fact, deduped, enriched } = await services.facts.createWithDedup({
          subject,
          predicate,
          object,
          projectIds: factProjectIds.length > 0 ? factProjectIds : undefined,
          reviewBy,
          confidence,
          sourceMemoryId: effectiveSource,
        })

        // "Learned" — new row. "Enriched" — dedup hit with metadata merged
        // (projects unioned, source linked, review extended). "Matched" —
        // dedup hit that was a genuine no-op, so the agent knows nothing
        // changed even though the ID survived.
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
        if (effectiveSource && autoLinkedFromSession) {
          // Surface the auto-pick: heuristics can be wrong, and the caller
          // needs visibility to retract if the supporting memory is not the
          // one they intended.
          lines.push(`Source (auto-linked from session): ${effectiveSource}`)
        } else if (effectiveSource) {
          lines.push(`Source: ${effectiveSource}`)
        } else {
          // Soft-phase. We create the fact but flag it loudly so deployed
          // agents have a window to adopt `sourceMemoryId` before the hard
          // error lands in a future minor. Existing callers are not broken
          // by this; new orphan facts are observable in the response.
          lines.push(
            "WARNING: No Source memory linked. Facts without a Source can't be retraced by `lore-ask`. " +
              "Pass `sourceMemoryId` with an existing supporting memory, or pass `agent`+`session` " +
              "matching an earlier `lore-remember`/`lore-decide` call for auto-link. This becomes a " +
              "hard error in a future release."
          )
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
  )

  // -------------------------------------------------------------------------
  // lore-ask
  // -------------------------------------------------------------------------
  // Single binding for both the MCP registration string and the operator
  // log's `tool=` field so a future rename can't desync the two surfaces.
  const loreAskName = "lore-ask"
  server.registerTool(
    loreAskName,
    {
      title: "Query facts",
      description:
        "Query the knowledge graph for facts about an entity. Returns all " +
        "current facts where the entity appears as either subject or object, " +
        "grouped into three buckets (Governance / Structure / Tracking) and " +
        `capped at ${DEFAULT_ASK_BUCKET_CAP} per bucket by default. Overdue ` +
        "tracking facts surface at the top of their bucket with a ⚠ marker. " +
        "Pass `limit` to raise the cap when the default hides relevant facts.",
      inputSchema: {
        entity: z
          .string()
          .describe("The entity to query (searched as both subject and object)"),
        projectName: z.string().optional().describe("Scope to a project"),
        limit: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe(
            "Per-bucket cap on the number of facts rendered. Default " +
              `${DEFAULT_ASK_BUCKET_CAP}. Raise when the default hides facts ` +
              "you need — the output surfaces an overflow hint when any bucket is trimmed.",
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ entity, projectName, limit }) => {
      try {
        let projectId: string | undefined
        const warnings: string[] = []

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) {
            projectId = found.id
          } else {
            warnings.push(
              `Project "${projectName}" not found — falling back to auto-detected project.`,
            )
          }
        }
        if (!projectId && services.context.project) {
          projectId = services.context.project.id
        }

        const facts = await services.facts.queryByEntity(entity, { projectId })

        // Built just-in-time at each return site so warnings added later (e.g.
        // decision-graph partial failures) aren't silently dropped.
        const formatWarnings = () =>
          warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

        if (facts.length === 0) {
          return {
            content: [
              { type: "text", text: `No facts found about "${entity}".${formatWarnings()}` },
            ],
          }
        }

        const today = new Date().toISOString().split("T")[0]
        const cap = limit ?? DEFAULT_ASK_BUCKET_CAP
        const { governance, structure, tracking } = groupFactsByClass(facts)

        // Split Governance into its two render paths. `decided_by` goes
        // through canonical-decision resolution (may dedupe legacy chains
        // down to one link per subject/decision); `supersedes_decision`
        // renders through the generic path, which is fine because both
        // sides are decision UUIDs the title resolver will fill in.
        const decidedByFacts = governance.filter((fact) => fact.predicate === "decided_by")
        const supersedesFacts = governance.filter(
          (fact) => fact.predicate === "supersedes_decision",
        )

        const { links: decisionLinks, failures: decisionFailures } =
          await resolveCanonicalDecisionLinks(services, decidedByFacts, {
            projectId,
          })

        if (decisionFailures.length > 0) {
          debugLogPartialFailures(loreAskName, decisionFailures)
          const rootIds = decisionFailures.map(({ rootId }) => rootId).join(", ")
          warnings.push(
            `Could not resolve ${decisionFailures.length} decision root${decisionFailures.length === 1 ? "" : "s"} (${rootIds}) — retry before relying on this result.`,
          )
        }

        // One batched title resolution across every non-decided_by fact —
        // `supersedes_decision` (both sides are decision UUIDs), structure,
        // and tracking — so a hot entity still pays at most one fan-out
        // regardless of bucket mix.
        const titleMap = await resolveReferencedTitles(
          [...supersedesFacts, ...structure, ...tracking],
          services,
        )

        // Governance bucket: interleaved resolved `decided_by` links and
        // generic `supersedes_decision` facts, sorted most-recent-first by
        // the underlying fact's `validFrom` so the ordering matches the
        // other buckets regardless of render path.
        type Governed = { sortKey: string | null; line: string }
        const governanceItems: Governed[] = [
          ...decisionLinks.map(({ fact, decision }) => ({
            sortKey: fact.validFrom,
            line: renderDecidedByLine(fact, decision, today),
          })),
          ...supersedesFacts.map((fact) => ({
            sortKey: fact.validFrom,
            line: renderFact(fact, {
              titleMap,
              trailing: renderGenericTrailing(fact, today),
            }),
          })),
        ]
        governanceItems.sort(compareSortKeyDesc)

        // Structure bucket: generic render, already sorted most-recent-first
        // by `groupFactsByClass`.
        const structureItems = structure.map((fact) =>
          renderFact(fact, {
            titleMap,
            trailing: renderGenericTrailing(fact, today),
          }),
        )

        // Tracking bucket: classify each row as overdue vs active, then
        // split-sort — overdue first (most-overdue-first), then active
        // (most-recent-first). The ⚠ prefix and "(N days overdue)" trailing
        // are only applied to rows actually past their review date.
        type Tracked = { overdueDays: number | null; sortKey: string | null; line: string }
        const trackingItems: Tracked[] = tracking.map((fact) => {
          const overdueDays = daysOverdue(fact.reviewBy, today)
          return {
            overdueDays,
            sortKey: fact.validFrom,
            line: renderFact(fact, {
              titleMap,
              prefix: overdueDays !== null ? "⚠ " : undefined,
              trailing: renderTrackingTrailing(fact, overdueDays),
            }),
          }
        })
        const overdueItems = trackingItems
          .filter((item) => item.overdueDays !== null)
          // Most-overdue-first so the longest-ignored row lands at the top
          // of the bucket.
          .sort((a, b) => (b.overdueDays ?? 0) - (a.overdueDays ?? 0))
        const activeItems = trackingItems
          .filter((item) => item.overdueDays === null)
          .sort((a, b) => compareSortKeyDesc(a, b))
        const trackingOrdered = [...overdueItems, ...activeItems]

        // Compose bucket sections. Empty buckets are skipped entirely so a
        // sparsely-linked entity doesn't render three empty headings just to
        // show three predicate classes exist.
        const sections: string[] = []
        let anyOverflow = false

        if (governanceItems.length > 0) {
          const visible = governanceItems.slice(0, cap)
          const hidden = governanceItems.length - visible.length
          if (hidden > 0) anyOverflow = true
          const hiddenSuffix = hidden > 0 ? ` (${hidden} hidden)` : ""
          sections.push(
            `### Governance (${governanceItems.length})${hiddenSuffix}\n${visible
              .map((item) => item.line)
              .join("\n")}`,
          )
        }

        if (structureItems.length > 0) {
          const visible = structureItems.slice(0, cap)
          const hidden = structureItems.length - visible.length
          if (hidden > 0) anyOverflow = true
          const hiddenSuffix = hidden > 0 ? ` (${hidden} hidden)` : ""
          sections.push(
            `### Structure (${structureItems.length})${hiddenSuffix}\n${visible.join("\n")}`,
          )
        }

        if (trackingOrdered.length > 0) {
          const visible = trackingOrdered.slice(0, cap)
          const hidden = trackingOrdered.length - visible.length
          if (hidden > 0) anyOverflow = true
          const hiddenSuffix = hidden > 0 ? `, ${hidden} hidden` : ""
          sections.push(
            `### Tracking (${overdueItems.length} overdue, ${activeItems.length} active${hiddenSuffix})\n${visible
              .map((item) => item.line)
              .join("\n")}`,
          )
        }

        if (sections.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No current facts found about "${entity}".${formatWarnings()}`,
              },
            ],
          }
        }

        const totalFacts =
          governanceItems.length + structureItems.length + trackingOrdered.length
        // Surfaced only when the caller is on the default cap AND something
        // was trimmed — an explicit `limit` means the caller already knows
        // the knob exists, and a clean fit has nothing to expand.
        const overflowHint =
          anyOverflow && limit === undefined
            ? `\n\n(pass limit to raise the cap; e.g. limit=${SUGGESTED_OVERFLOW_LIMIT})`
            : ""

        return {
          content: [
            {
              type: "text",
              text: `${totalFacts} facts about "${entity}":\n\n${sections.join("\n\n")}${overflowHint}${formatWarnings()}`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-correct
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-correct",
    {
      title: "Invalidate a fact",
      description:
        'Mark a fact as no longer true by setting its "Valid Until" date to today. ' +
        "The fact is preserved for historical reference but excluded from default queries.",
      inputSchema: {
        factId: z.string().describe("The fact ID to invalidate"),
      },
      annotations: { destructiveHint: true },
    },
    async ({ factId }) => {
      try {
        await services.facts.invalidate(factId)
        return {
          content: [{ type: "text", text: `Invalidated fact ${factId}` }],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-open-loops
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-open-loops",
    {
      title: "List open loops",
      description:
        "List active open loops — tracked items that need action, are waiting on something, " +
        "or are blocked. These are facts with tracking predicates (needs_action, waiting_on, " +
        "blocked_by) that haven't been resolved yet.\n\n" +
        "Tracking facts auto-expire for review after 7 days. Overdue items are shown first, " +
        `ranked by days overdue; Active items are ranked by soonest review date. Returns up to ` +
        `${DEFAULT_OPEN_LOOPS_LIMIT} per section by default — pass {all: true} for the full list ` +
        "or {entity: \"...\"} to narrow to loops touching a specific subject or object substring.\n\n" +
        "To create an open loop, use lore-learn with a tracking predicate. " +
        "To resolve one, use lore-correct to invalidate the fact.",
      inputSchema: {
        projectName: z
          .string()
          .optional()
          .describe("Override the auto-detected project."),
        entity: z
          .string()
          .optional()
          .describe(
            "Substring filter matched against Subject OR Object. " +
              "Use this to scope to a PR, service, or other entity."
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(
            `Max rows per section (Overdue / Active). Default ${DEFAULT_OPEN_LOOPS_LIMIT}. ` +
              "Ignored when `all: true`. Zero is rejected — use `{all: true}` for " +
              "full output or omit `limit` for the default cap."
          ),
        all: z
          .boolean()
          .optional()
          .describe(
            "Bypass the per-section cap and return every matching loop. " +
              "Use for triage sweeps; noisy on large vaults."
          ),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectName, entity, limit, all }) => {
      try {
        let projectId: string | undefined
        const warnings: string[] = []

        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (found) {
            projectId = found.id
          } else {
            warnings.push(`Project "${projectName}" not found — falling back to auto-detected project.`)
          }
        }
        if (!projectId && services.context.project) {
          projectId = services.context.project.id
        }

        // `all: true` takes precedence over `limit`. The tool-layer cap is
        // independent of the service-layer pagination safety valve, which
        // still clips inside `FactService.listTracking` on runaway walks.
        const perSectionCap = all
          ? undefined
          : limit !== undefined
            ? limit
            : DEFAULT_OPEN_LOOPS_LIMIT

        // Fetch the full candidate set so we can bucket + rank independently.
        // Capping at the service layer would bias toward one bucket on vaults
        // dominated by overdue rows (or vice versa). The service paginates
        // with its own safety cap.
        const { items: loops, hasMore: serviceClipped } =
          await services.facts.listTracking({ projectId, entity })

        if (serviceClipped) {
          warnings.push(
            "Result set was clipped by the service-layer safety cap. Narrow the query with " +
              "`entity` or `projectName` to see the remainder."
          )
        }

        if (loops.length === 0) {
          const filterHint = entity ? ` matching "${entity}"` : ""
          const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""
          return {
            content: [{ type: "text", text: `No open loops found${filterHint}.${warn}` }],
          }
        }

        const today = new Date().toISOString().split("T")[0]
        const todayMs = new Date(today).getTime()

        const daysOverdue = (f: Fact): number => {
          if (!f.reviewBy || f.reviewBy > today) return 0
          return Math.floor((todayMs - new Date(f.reviewBy).getTime()) / 86_400_000)
        }

        const overdueAll = loops
          .filter((f) => f.reviewBy !== null && f.reviewBy <= today)
          .sort((a, b) => rankOverdue(a, b, daysOverdue))

        const activeAll = loops
          .filter((f) => !f.reviewBy || f.reviewBy > today)
          .sort(rankActive)

        const overdue =
          perSectionCap === undefined ? overdueAll : overdueAll.slice(0, perSectionCap)
        const active =
          perSectionCap === undefined ? activeAll : activeAll.slice(0, perSectionCap)

        const urgencyMarker = (days: number): string => {
          if (days >= OVERDUE_SEVERE_DAYS) return "⚠⚠ "
          if (days >= OVERDUE_MILD_DAYS) return "⚠ "
          return ""
        }

        const formatOverdue = (f: Fact): string => {
          const days = daysOverdue(f)
          const marker = urgencyMarker(days)
          const daysLabel = days === 1 ? "1 day overdue" : `${days} days overdue`
          const since = f.validFrom ? ` (since ${f.validFrom})` : ""
          return (
            `- ${marker}${daysLabel}: **${f.subject}** → ${f.predicate.replace(/_/g, " ")} ` +
            `→ **${f.object}** [${f.confidence}]${since}\n  ID: ${f.id}`
          )
        }

        const formatActive = (f: Fact): string => {
          const since = f.validFrom ? ` (since ${f.validFrom})` : ""
          const review = f.reviewBy ? ` — review by ${f.reviewBy}` : " — no review date"
          return (
            `- **${f.subject}** → ${f.predicate.replace(/_/g, " ")} → ` +
            `**${f.object}** [${f.confidence}]${since}${review}\n  ID: ${f.id}`
          )
        }

        const buildHeader = (label: string, shown: number, total: number): string => {
          if (perSectionCap === undefined || shown >= total) return `### ${label} (${total})`
          const hidden = total - shown
          return `### ${label} (${shown} shown of ${total}, hiding ${hidden})`
        }

        const sections: string[] = []
        if (overdueAll.length > 0) {
          sections.push(
            `${buildHeader("Overdue", overdue.length, overdueAll.length)}\n\n` +
              overdue.map(formatOverdue).join("\n")
          )
        }
        if (activeAll.length > 0) {
          sections.push(
            `${buildHeader("Active", active.length, activeAll.length)}\n\n` +
              active.map(formatActive).join("\n")
          )
        }

        // Escape-hatch hint — only surfaced when the default cap actually
        // hid rows. Silent on narrow entity queries that fit inside the
        // cap, and silent on `all: true` because nothing was hidden.
        const anyTruncated =
          overdue.length < overdueAll.length || active.length < activeAll.length
        if (anyTruncated) {
          sections.push(
            "Pass `{all: true}` to see everything, `{limit: N}` for a different cap, " +
              "or `{entity: \"...\"}` to narrow further."
          )
        }

        const total = loops.length
        const filterSuffix = entity ? ` touching "${entity}"` : ""
        const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

        return {
          content: [
            {
              type: "text",
              text: `${total} open loop${total === 1 ? "" : "s"}${filterSuffix}:\n\n${sections.join("\n\n")}${warn}`,
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-audit
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-audit",
    {
      title: "Audit overdue facts",
      description:
        "List all facts past their review-by date that haven't been invalidated. " +
        "Use this to find stale knowledge that needs triage: either invalidate with " +
        "lore-correct or extend with lore-extend.\n\n" +
        "Facts with tracking predicates auto-default to a 7-day review window.",
      inputSchema: {
        projectName: z
          .string()
          .optional()
          .describe("Override the auto-detected project."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ projectName }) => {
      try {
        let projectId: string | undefined

        // Strict resolution: lore-audit suggests destructive actions
        // ("mark reviewed", "supersede") targeted at the surfaced items,
        // so silently falling back to the ambient project would put the
        // caller at risk of acting on the wrong project's overdue queue.
        if (projectName) {
          const found = await services.projects.findByName(projectName)
          if (!found) {
            return {
              content: [{ type: "text", text: `Project "${projectName}" not found.` }],
            }
          }
          projectId = found.id
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        const [overdueFacts, overdueDecisions] = await Promise.all([
          services.facts.queryOverdue({ projectId }),
          services.decisions.queryOverdue({ projectId }),
        ])

        if (overdueFacts.length === 0 && overdueDecisions.length === 0) {
          return {
            content: [{ type: "text", text: "No overdue facts or decisions found." }],
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
              return (
                `- **${f.subject}** ${f.predicate.replace(/_/g, " ")} **${f.object}** [${f.confidence}]${since}\n` +
                `  Review by: ${f.reviewBy} (${days} day${days === 1 ? "" : "s"} overdue)\n` +
                `  ID: ${f.id}`
              )
            })
            .join("\n")
          sections.push(
            `## Overdue Facts (${overdueFacts.length})\n\n${factLines}`
          )
        }

        if (overdueDecisions.length > 0) {
          const decisionLines = overdueDecisions
            .map((d) => {
              const days = d.reviewBy
                ? Math.floor(
                    (new Date(today).getTime() - new Date(d.reviewBy).getTime()) /
                      86_400_000
                  )
                : 0
              const decided = d.decidedAt ? ` | decided ${d.decidedAt}` : ""
              return (
                `- **${d.title}** [${d.status}]${decided}\n` +
                `  Review by: ${d.reviewBy} (${days} day${days === 1 ? "" : "s"} overdue)\n` +
                `  ID: ${d.id}`
              )
            })
            .join("\n")
          sections.push(
            `## Overdue Decisions (${overdueDecisions.length})\n\n${decisionLines}`
          )
        }

        const actions = [
          "",
          "Actions:",
          "- **Fact — invalidate**: `lore-correct` with the fact ID if no longer true",
          "- **Fact — extend**: `lore-extend` with the fact ID and a new review date",
          "- **Decision — mark reviewed**: `lore-review-decision` with the decision ID",
          "- **Decision — supersede**: `lore-supersede` with a replacement decision",
          "- **No change**: leave as-is if still under review",
        ]

        return {
          content: [
            {
              type: "text",
              text: sections.join("\n\n") + "\n" + actions.join("\n"),
            },
          ],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )

  // -------------------------------------------------------------------------
  // lore-extend
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-extend",
    {
      title: "Extend a fact's review date",
      description:
        "Push back the review-by date on a fact. Use when a fact is still valid " +
        "but needs more time before the next review.",
      inputSchema: {
        factId: z.string().describe("The fact ID to extend"),
        reviewBy: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, "Must be YYYY-MM-DD format")
          .describe("New review-by date (YYYY-MM-DD)"),
      },
    },
    async ({ factId, reviewBy }) => {
      try {
        await services.facts.extendReview(factId, reviewBy)
        return {
          content: [{ type: "text", text: `Extended review date for ${factId} to ${reviewBy}` }],
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
