import { fireTouchOnRead, paginationFooter, toolError } from "../../helpers.js"
import { resolveReadProjectScope } from "../../resolve.js"
import { defaultMemoryMetaBuilder, formatMemoryListItem } from "../../render.js"
import type { LoreServices } from "../../server.js"
import type {
  Memory,
  MemoryKind,
  MemoryStatus,
  SearchExplain,
  SearchMode,
} from "../../../types.js"
import type { ToolResult } from "./types.js"
import { KINDS, READABLE_SOURCES, STATUSES } from "./types.js"

export interface RecallArgs {
  projectName?: string
  topicName?: string
  source?: (typeof READABLE_SOURCES)[number]
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  reviewBefore?: string
  limit?: number
  startCursor?: string
  includeContent?: boolean
  includeSynopsis?: boolean
}

export async function handleRecall(
  services: LoreServices,
  args: RecallArgs
): Promise<ToolResult> {
  try {
    const { projectId } = await resolveReadProjectScope(services, args.projectName)
    let topicId: string | undefined

    if (args.topicName) {
      const found = await services.topics.findByName(args.topicName)
      if (!found) {
        return {
          content: [{ type: "text", text: `No topic named "${args.topicName}" found.` }],
          costOutputs: { memoriesReturned: 0 },
        }
      }
      topicId = found.id
    }

    const withContent = args.includeContent === true

    const {
      items: memories,
      nextCursor,
      capped,
    } = await services.memories.list({
      projectId,
      topicId,
      source: args.source,
      kind: args.kind as MemoryKind | undefined,
      status: args.status as MemoryStatus | undefined,
      reviewBefore: args.reviewBefore,
      limit: args.limit ?? 10,
      includeContent: withContent,
      startCursor: args.startCursor,
    })

    if (memories.length === 0) {
      const header = nextCursor
        ? "No matching memories on this page."
        : "No recent memories found."
      return {
        content: [
          {
            type: "text",
            text: `${header}${paginationFooter(nextCursor, { truncated: capped })}`,
          },
        ],
        costOutputs: { memoriesReturned: 0 },
      }
    }

    const includeSynopsis = args.includeSynopsis !== false

    const text = memories
      .map((m) =>
        formatMemoryListItem(m, {
          meta: defaultMemoryMetaBuilder,
          body: withContent ? m.content : undefined,
          includeSynopsis,
        })
      )
      .join("\n\n---\n\n")

    const bodiesFooter = withContent
      ? ""
      : `\n\n_Bodies omitted — re-call with \`includeContent: true\` to fetch them._`

    const response: ToolResult = {
      content: [
        {
          type: "text",
          text: `${memories.length} recent memories:\n\n${text}${bodiesFooter}${paginationFooter(nextCursor, { truncated: capped })}`,
        },
      ],
      costOutputs: { memoriesReturned: memories.length },
    }

    // Citation-as-evidence. Touch fires AFTER the
    // response is composed — write latency cannot block the agent's
    // read. Failure handling and contract details live in
    // `fireTouchOnRead`'s docstring.
    await fireTouchOnRead(services.memories, memories, "lore-query (recall)")

    return response
  } catch (err) {
    return toolError(err)
  }
}

export interface SearchArgs {
  query: string
  projectName?: string
  topicName?: string
  tags?: string[]
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  limit?: number
  includeContent?: boolean
  includeSynopsis?: boolean
  mode?: SearchMode
  explain?: boolean
  intent?: string
}

export async function handleSearch(
  services: LoreServices,
  args: SearchArgs
): Promise<ToolResult> {
  try {
    const { projectId } = await resolveReadProjectScope(services, args.projectName)
    let topicId: string | undefined
    const warnings: string[] = []

    // Topics span projects (many-to-many Topic.Project), so resolve
    // globally rather than scoping by project — same posture as
    // `handleRecall`'s topic resolution.
    if (args.topicName) {
      const found = await services.topics.findByName(args.topicName)
      if (!found) {
        return {
          content: [{ type: "text", text: `No topic named "${args.topicName}" found.` }],
          costOutputs: { memoriesReturned: 0 },
        }
      }
      topicId = found.id
    }

    const withContent = args.includeContent === true
    const resolvedMode: SearchMode = args.mode ?? "hybrid"
    const wantExplain = args.explain === true

    // Over-fetch slightly only when post-filters are still active — i.e.
    // semantic mode, which can't apply kind/status server-side. Contains
    // and hybrid push kind/status/tags/topicName into the Notion query, so
    // the requested limit is already authoritative there.
    const searchInput = {
      query: args.query,
      projectId,
      topicId,
      tags: args.tags,
      kind: args.kind as MemoryKind | undefined,
      status: args.status as MemoryStatus | undefined,
      limit:
        resolvedMode === "semantic"
          ? Math.min((args.limit ?? 10) * 2, 50)
          : (args.limit ?? 10),
      includeContent: withContent,
      mode: resolvedMode,
      intent: args.intent,
    }

    let searchResults: Memory[]
    let explain: SearchExplain[] = []
    let searchCapped = false
    if (wantExplain && typeof services.memories.searchWithExplain === "function") {
      const out = await services.memories.searchWithExplain(searchInput)
      searchResults = out.memories
      explain = out.explain
      searchCapped = out.capped ?? false
    } else if (typeof services.memories.searchWithMeta === "function") {
      const out = await services.memories.searchWithMeta(searchInput)
      searchResults = out.memories
      searchCapped = out.capped ?? false
    } else {
      searchResults = await services.memories.search(searchInput)
    }

    // The service applies kind/status server-side in contains/hybrid and
    // post-filter in semantic, so the result set is already correctly
    // narrowed by mode. The final slice protects against the semantic
    // over-fetch above leaking extra rows past the caller's limit.
    const finalLimit = args.limit ?? 10
    const results = searchResults.slice(0, finalLimit)
    const explainSlice = explain.slice(0, finalLimit)

    if (searchCapped) {
      warnings.push(
        "Search scan reached the live-row refill cap; more matching memories may exist."
      )
    }
    const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""
    const cappedFooter = paginationFooter(undefined, { truncated: searchCapped })

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No memories found for: "${args.query}"${warn}${cappedFooter}`,
          },
        ],
        costOutputs: { memoriesReturned: 0 },
      }
    }

    const includeSynopsis = args.includeSynopsis !== false

    const text = results
      .map((m) =>
        formatMemoryListItem(m, {
          meta: defaultMemoryMetaBuilder,
          body: withContent ? m.content : undefined,
          includeSynopsis,
        })
      )
      .join("\n\n---\n\n")

    const bodiesFooter = withContent
      ? ""
      : `\n\n_Bodies omitted — re-call with \`includeContent: true\` to fetch them._`

    const explainFooter = wantExplain ? formatScoreTrace(explainSlice) : ""

    const response: ToolResult = {
      content: [
        {
          type: "text",
          text: `Found ${results.length} memories for "${args.query}":\n\n${text}${bodiesFooter}${explainFooter}${warn}${cappedFooter}`,
        },
      ],
      costOutputs: { memoriesReturned: results.length },
    }

    // Citation-as-evidence. Touches every surfaced
    // row, not just the slice the agent might read — surfacing alone
    // is the signal that the row passed the filter and is contextually
    // relevant. Fires post-response composition.
    await fireTouchOnRead(services.memories, results, "lore-query (search)")

    return response
  } catch (err) {
    return toolError(err)
  }
}

/**
 * Render a `## Score trace` footer for `lore-query action='search'` when
 * the caller passes `explain: true`. One row per result; null fields
 * render as `—` (em dash) uniformly so the format is grep-friendly across
 * branches.
 *
 * The `branch` field is the canonical signal; `containsRank` /
 * `semanticRank` / `rrfScore` carry rank/score detail when applicable.
 * Stored and effective confidence factors render side by side so ranking-time
 * decay is diagnosable without reading the Notion row. Agents that don't pass
 * `explain` pay zero output-token cost.
 */
function formatScoreTrace(explain: SearchExplain[]): string {
  if (explain.length === 0) return ""
  const lines = explain.map((e) => {
    const contains = e.containsRank === null ? "—" : String(e.containsRank)
    const semantic = e.semanticRank === null ? "—" : String(e.semanticRank)
    // Six decimals (rather than four) keeps the rendered score
    // information-bearing across the plausible RRF_K range. With the
    // current RRF_K=60, scores are in the 0.01–0.04 range and four
    // decimals would suffice. A future env knob (`LORE_HYBRID_RRF_K`)
    // pushing RRF_K toward 1000+ would crush scores below the four-
    // decimal threshold and silently render them as `0.0000`. Six
    // decimals covers RRF_K up to ~100000 without information loss.
    const rrf = e.rrfScore === null ? "—" : e.rrfScore.toFixed(6)
    // Three decimals matches the resolution of `confidenceFactor`'s
    // [0.5, 1.0] range (the floor controlled by `CONFIDENCE_FACTOR_MIN`).
    // 0.500 / 0.750 / 1.000 are the operationally meaningful values;
    // deeper precision would surface arithmetic noise without
    // diagnostic value.
    const cf = e.confidenceFactor.toFixed(3)
    const storedCf = (e.storedConfidenceFactor ?? e.confidenceFactor).toFixed(3)
    const effectiveCf = (e.effectiveConfidenceFactor ?? e.confidenceFactor).toFixed(3)
    return `${e.memoryId} branch=${e.branch} contains=${contains} semantic=${semantic} rrf=${rrf} confidenceFactor=${cf} storedConfidenceFactor=${storedCf} effectiveConfidenceFactor=${effectiveCf}`
  })
  return `\n\n## Score trace\n\n${lines.join("\n")}`
}
