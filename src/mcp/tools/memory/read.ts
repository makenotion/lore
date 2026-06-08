import { fireTouchOnRead, paginationFooter, toolError } from "../../helpers.js"
import { resolveReadProjectScope } from "../../resolve.js"
import { defaultMemoryMetaBuilder, formatMemoryListItem } from "../../render.js"
import type { LoreServices } from "../../server.js"
import { redactDebugMessage } from "../../../debug-redact.js"
import type { MemoryResultSetRegistration } from "../../../memory-result-handles.js"
import type {
  Memory,
  MemoryKind,
  MemorySource,
  MemoryStatus,
  SearchExplain,
  SearchMode,
  SearchPlanResultTrace,
  SearchQueryPlan,
  SearchStrategy,
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
    const resultSet = registerMemoryResultSet(services, memories)

    const text = memories
      .map((m, index) =>
        formatMemoryListItem(m, {
          meta: defaultMemoryMetaBuilder,
          body: withContent ? m.content : undefined,
          includeSynopsis,
          detailLines: memoryHandleDetailLines(resultSet, index),
        })
      )
      .join("\n\n---\n\n")

    const resultSetHeader = formatResultSetHeader(resultSet)
    const bodiesFooter = formatBodiesFooter(withContent, resultSet)

    const response: ToolResult = {
      content: [
        {
          type: "text",
          text: `${memories.length} recent memories:\n\n${resultSetHeader}${text}${bodiesFooter}${paginationFooter(nextCursor, { truncated: capped })}`,
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
  source?: (typeof READABLE_SOURCES)[number]
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  limit?: number
  includeContent?: boolean
  includeSynopsis?: boolean
  mode?: SearchMode
  strategy?: SearchStrategy
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
    const resolvedMode: SearchMode = args.mode ?? "semantic"
    const resolvedStrategy: SearchStrategy = args.strategy ?? "planned"
    const wantExplain = args.explain === true
    const searchInput = {
      query: args.query,
      projectId,
      topicId,
      tags: args.tags,
      source: args.source as MemorySource | undefined,
      kind: args.kind as MemoryKind | undefined,
      status: args.status as MemoryStatus | undefined,
      limit: args.limit ?? 10,
      includeContent: withContent,
      mode: resolvedMode,
      strategy: resolvedStrategy,
      intent: args.intent,
    }

    let searchResults: Memory[]
    let explain: SearchExplain[] = []
    let searchCapped = false
    let queryPlan: SearchQueryPlan | undefined
    let planTrace: SearchPlanResultTrace[] | undefined
    if (wantExplain && typeof services.memories.searchWithExplain === "function") {
      const out = await services.memories.searchWithExplain(searchInput)
      searchResults = out.memories
      explain = out.explain
      searchCapped = out.capped ?? false
      queryPlan = out.queryPlan
      planTrace = out.planTrace
    } else if (typeof services.memories.searchWithMeta === "function") {
      const out = await services.memories.searchWithMeta(searchInput)
      searchResults = out.memories
      searchCapped = out.capped ?? false
      queryPlan = out.queryPlan
      planTrace = out.planTrace
    } else {
      searchResults = await services.memories.search(searchInput)
    }

    // The service applies kind/status server-side in contains/hybrid and
    // post-filter in semantic, so the result set is already correctly
    // narrowed by mode. The final slice is a boundary guard for older
    // service implementations and tests that return extra rows.
    const finalLimit = args.limit ?? 10
    const results = searchResults.slice(0, finalLimit)
    const explainSlice = explain.slice(0, finalLimit)

    if (searchCapped) {
      warnings.push(
        "Search reached a candidate-window cap; more matching memories may exist."
      )
    }
    const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""
    const cappedFooter = paginationFooter(undefined, { truncated: searchCapped })
    const displayQuery = redactSearchDisplayText(args.query)

    if (results.length === 0) {
      const queryPlanBlock = formatQueryPlan(queryPlan)
      return {
        content: [
          {
            type: "text",
            text: `No memories found for: "${displayQuery}"${queryPlanBlock}${warn}${cappedFooter}`,
          },
        ],
        costOutputs: { memoriesReturned: 0 },
      }
    }

    const includeSynopsis = args.includeSynopsis !== false
    const resultSet = registerMemoryResultSet(services, results)

    const text = results
      .map((m, index) =>
        formatMemoryListItem(m, {
          meta: defaultMemoryMetaBuilder,
          body: withContent ? m.content : undefined,
          includeSynopsis,
          detailLines: memoryHandleDetailLines(resultSet, index),
        })
      )
      .join("\n\n---\n\n")

    const resultSetHeader = formatResultSetHeader(resultSet)
    const queryPlanBlock = formatQueryPlan(queryPlan)
    const bodiesFooter = formatBodiesFooter(withContent, resultSet)

    const explainFooter = wantExplain
      ? `${formatScoreTrace(explainSlice)}${formatQueryPlanTrace(planTrace)}`
      : ""

    const response: ToolResult = {
      content: [
        {
          type: "text",
          text: `Found ${results.length} memories for "${displayQuery}":${queryPlanBlock}\n\n${resultSetHeader}${text}${bodiesFooter}${explainFooter}${warn}${cappedFooter}`,
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

function registerMemoryResultSet(
  services: LoreServices,
  memories: readonly Memory[]
): MemoryResultSetRegistration | null {
  const store = services.memoryResultHandles
  if (!store || memories.length === 0) return null
  return store.register(memories.map((memory) => memory.id))
}

function formatResultSetHeader(resultSet: MemoryResultSetRegistration | null): string {
  if (!resultSet) return ""
  return `Result set: \`${resultSet.resultSetId}\`\n\n`
}

function memoryHandleDetailLines(
  resultSet: MemoryResultSetRegistration | null,
  index: number
): string[] | undefined {
  const handle = resultSet?.handles[index]
  if (!handle) return undefined
  return [`Handle: \`${handle}\``]
}

function formatBodiesFooter(
  withContent: boolean,
  resultSet: MemoryResultSetRegistration | null
): string {
  if (withContent) return ""

  const firstHandle = resultSet?.handles[0]
  if (!firstHandle) {
    return `\n\n_Bodies omitted — re-call with \`includeContent: true\` to fetch them._`
  }

  return (
    "\n\n_Bodies omitted — expand selected rows with " +
    `\`lore-memory action='expand' ids=["${firstHandle}"]\`, ` +
    "or re-call with `includeContent: true` when you need every body._"
  )
}

function formatQueryPlan(queryPlan: SearchQueryPlan | undefined): string {
  if (!queryPlan || queryPlan.variants.length === 0) return ""
  const lines = queryPlan.variants.map(
    (variant, index) =>
      `${index + 1}. ${variant.kind}: ${redactSearchDisplayText(variant.query)}`
  )
  return `\n\n## Query plan\n\n${lines.join("\n")}`
}

function redactSearchDisplayText(value: string): string {
  return redactDebugMessage(value, { truncate: false })
}

function formatQueryPlanTrace(planTrace: SearchPlanResultTrace[] | undefined): string {
  if (!planTrace || planTrace.length === 0) return ""
  const lines = planTrace.map((trace) => {
    const hits = trace.variantHits
      .map((hit) => `v${hit.variantIndex + 1}@${hit.rank + 1}`)
      .join(",")
    return `${trace.memoryId} plannedScore=${trace.score.toFixed(6)} bestRank=${trace.bestRank + 1} variants=${hits}`
  })
  return `\n\n## Query plan trace\n\n${lines.join("\n")}`
}

/**
 * Render a `## Score trace` footer for `lore-query action='search'` when
 * the caller passes `explain: true`. One row per result; null fields
 * render as `—` (em dash) uniformly so the format is grep-friendly across
 * branches.
 *
 * The `branch` field is the canonical signal; `containsRank` /
 * `semanticRank` / `rrfScore` carry rank/score detail when applicable. Agents
 * that don't pass `explain` pay zero output-token cost.
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
    return `${e.memoryId} branch=${e.branch} contains=${contains} semantic=${semantic} rrf=${rrf}`
  })
  return `\n\n## Score trace\n\n${lines.join("\n")}`
}
