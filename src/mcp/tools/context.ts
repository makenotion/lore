import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import {
  fireTouchOnRead,
  formatDispatchError,
  toolError,
} from "../helpers.js"
import {
  DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT,
  DEFAULT_WAKEUP_MEMORY_LIMIT,
  DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT,
  DEFAULT_WAKEUP_TASK_LIMIT,
  DEFAULT_WAKEUP_TASK_MEMORY_LIMIT,
  RANKED_WAKEUP_LIMITS,
  computeTasksFetchLimit,
  dateBucket,
  loadWakeUpData,
} from "../../core/wakeup.js"
import { gatherDigestData } from "../../core/digest.js"
import {
  composeProjectContext,
  renderProjectContextLines,
} from "../../core/project-context.js"
import {
  formatTaskSummary,
  taskDaysOverdue,
  taskDaysStale,
  taskStats,
  todayUtc,
} from "../../core/task.js"
import { STALE_TASK_DAYS, type Memory, type TaskSummary } from "../../types.js"
import {
  type CollapsedMemoryGroup,
  type MemoryListItem,
  collapseOverlappingMemories,
  formatMemoryListItem,
  renderFact,
  resolveReferencedTitles,
  truncateSynopsis,
} from "../render.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/**
 * Multiplier applied to each memory-section cap when we over-fetch to
 * leave room for topical collapse. Without this, collapse would *shrink*
 * the visible section (10 memories, 3 collapse into 1 cluster → agent
 * sees 8 rows instead of 10). With it we fetch 3× the cap, collapse,
 * and then slice by cluster count so `limit` bounds the number of
 * distinct topics the agent sees — which is the intent. Three is the
 * smallest multiple that absorbs realistic dedup rates on the Mail
 * vault (observed 3× duplication on hot debugging sessions) without
 * over-stuffing the body-off payload, and the tracking/knowledge fact
 * queries are unaffected.
 */
const COLLAPSE_OVERFETCH_MULTIPLIER = 3

/**
 * Render one memory entry for wake-up output. Shared between the
 * Recent and Related sections so both share the same collapse trailer
 * format (`(related: <uuid>, <uuid>)`) and the same body-rendering
 * discipline (bodies only when the caller opted into `expand: true`).
 *
 * `headingLevel` is the markdown heading depth (number of leading `#`).
 * Recent Memories sits under date-bucket `###` sub-heads, so entries
 * use `####`; Related to Open Loops has no intermediate heading, so
 * entries stay at `###` to keep the tree balanced. The date field uses
 * `createdAt` for both sections — wake-up prioritizes when a memory
 * was captured over when it was last re-edited.
 *
 * The collapse trailer emits full Notion page UUIDs so an agent can
 * `lore-query action='recall'` / `lore-decision action='get'` the
 * collapsed peers directly — the spec treats the representative as
 * "enough signal" but an agent that wants the peer's body must have an
 * actionable ID, not a truncated hint.
 */
function renderMemoryEntry(
  mem: Memory,
  group: CollapsedMemoryGroup | undefined,
  expand: boolean,
  headingLevel: 3 | 4,
): string[] {
  // Wake-up's leaner meta shape — source | tags | createdAt — diverges
  // from recall/search's kind/status-conditional pipe chain on purpose
  // (different audiences, different signal density). The shared helper
  // takes a builder so both formats compose into the same envelope.
  const rendered = formatMemoryListItem(mem, {
    headingLevel,
    meta: wakeUpMemoryMetaBuilder,
  })
  // The splice below assumes `formatMemoryListItem` returns lines joined
  // by a single `\n` with no internal blank lines (heading, optional
  // `_{trust}_` line, optional synopsis, optional `*meta*` — that's it;
  // body lives off the structural type and we never pass it here). If a
  // future helper change introduces an internal `\n\n` (e.g. spec
  // extension wrapping synopsis as a blockquote with surrounding
  // blanks), the `(related:)` trailer would land in the wrong slot.
  // The render-side test suite pins the no-body envelope shape; keep
  // this comment in sync if the contract widens.
  const lines: string[] = rendered.split("\n")
  if (group && group.collapsedIds.length > 0) {
    lines.push(`(related: ${group.collapsedIds.join(", ")})`)
  }
  lines.push("")
  // In the title-only default path, we intentionally skip body rendering
  // — the header + metadata are the payload. When `expand: true` the
  // caller opted into bodies and we stitch the markdown inline, after
  // the metadata + collapse trailer so the trailer reads as a header
  // annotation rather than a body footnote. Collapsed peers' bodies
  // stay suppressed even in expand mode — the representative is the
  // signal; agents that want a peer's body call `lore-query
  // action='recall'` with its ID from the trailer.
  if (expand && mem.content) {
    lines.push(mem.content, "")
  }
  return lines
}

function wakeUpMemoryMetaBuilder(mem: MemoryListItem): string {
  const tagPart = mem.tags.length > 0 ? mem.tags.join(", ") : "no tags"
  const date = mem.createdAt.split("T")[0]
  return `${mem.source} | ${tagPart} | ${date}`
}

/**
 * Render one task row for the wake-up Tasks section. The row carries
 * the urgency marker, state, blocker, due-date phrasing, and an inline
 * closure CTA so the agent triaging the section never has to remember
 * the `lore-task` dispatcher signature.
 *
 * Mutually-exclusive bucketing is enforced upstream (Overdue > Stale >
 * Active); this helper renders any single row identically regardless
 * of which bucket it lives in. The urgency marker fires only on overdue
 * rows — the Stale section heading already conveys staleness, so plain
 * rows in that bucket keep the visual noise down.
 *
 * A non-empty `synopsis` is rendered as an indented line between the
 * title row and the `ID:` line — same shape as `lore-task action='list'`'s
 * row formatter. Wake-up does NOT expose an `includeSynopsis` toggle:
 * the section is the agent's primary triage view, and the synopsis
 * line materially improves the matching surface for the closure-nudge
 * mechanisms that frame the rest of 0.7.0.
 *
 * `overdueDays` is threaded in from the bucketing pass in `handleWakeUp`
 * rather than recomputed here — `taskDaysOverdue(task, today)` is the
 * load-bearing signal for both bucketing precedence and row-format
 * urgency, and computing it twice is a drift footgun if a future change
 * to the bucketing pass diverges from the row format. Caller owns the
 * computation, formatter consumes the cached value.
 */
function formatWakeUpTaskRow(
  task: TaskSummary,
  today: string,
  overdueDays: number | null,
): string {
  const stateLabel = task.taskState ?? "open"
  const blocker = task.blockedBy ? ` — blocked by ${task.blockedBy}` : ""
  const due =
    overdueDays !== null && task.reviewBy
      ? overdueDays === 0
        ? " **(due today)**"
        : ` **(${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue — review by ${task.reviewBy})**`
      : task.reviewBy
        ? ` (due ${task.reviewBy})`
        : ""
  const prefix = overdueDays !== null ? "⚠ " : ""
  const closeCta = `lore-task({ action: 'close', taskId: '${task.id}' })`
  const synopsisLine = task.synopsis.trim() ? `  ${truncateSynopsis(task.synopsis)}\n` : ""
  return (
    `- ${prefix}**${task.title}** [${stateLabel}]${blocker}${due}\n` +
    synopsisLine +
    `  ID: ${task.id} — close if resolved: ${closeCta}`
  )
}

// -------------------------------------------------------------------------
// Handlers — one per `lore-context` action (status | wake-up | digest).
// Routed by the polymorphic dispatcher's discriminated union.
// -------------------------------------------------------------------------

async function handleStatus(services: LoreServices): Promise<ToolResult> {
  try {
    const stats = await services.vault.stats()
    const project = services.context.project

    const lines = [
      `Vault: ${services.context.vault.pageId}`,
      `Current project: ${project ? `${project.name} (${project.path || "no path"})` : "none (vault-wide scope)"}`,
      "",
      "Database counts:",
      `  Projects: ${stats.projects}`,
      `  Topics:   ${stats.topics}`,
      `  Memories: ${stats.memories}`,
      `  Facts:    ${stats.facts}`,
    ]

    // Task summary (issue 0.7.0/13). Same `taskStats` orchestrator the
    // CLI calls — `formatTaskSummary` is the single renderer so the
    // emitted Tasks line is byte-identical between MCP and CLI for the
    // same vault state.
    const tasks = await taskStats(services.tasks, {
      projectId: project?.id,
      today: todayUtc(),
    })
    lines.push(...formatTaskSummary(tasks))

    if (services.config.projects?.length) {
      lines.push("", "Configured projects:")
      for (const p of services.config.projects) {
        lines.push(`  - ${p.name} (${p.path})`)
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] }
  } catch (err) {
    return toolError(err)
  }
}

async function handleWakeUp(
  services: LoreServices,
  args: {
    projectName?: string
    expand?: boolean
    limit?: number
    knowledgeFactLimit?: number
    taskLimit?: number
    userQuery?: string
    taskMemoryLimit?: number
  },
): Promise<ToolResult> {
  try {
    let projectId = services.context.project?.id
    // The framing block (Fix 2 in issue 0.6.0/18) describes whichever
    // project the rest of the wake-up output is filtered to. When the
    // caller passes an explicit `projectName`, that branch is NOT a
    // catch-all fallback — explicit picks win over auto-detection. When
    // `projectName` is unset, mirror `services.context` directly.
    let resolvedProject = services.context.project
    let resolvedCatchAllFallback = services.context.isCatchAllFallback
    const warnings: string[] = []

    if (args.projectName) {
      const found = await services.projects.findByName(args.projectName)
      if (found) {
        projectId = found.id
        resolvedProject = found
        resolvedCatchAllFallback = false
      } else {
        warnings.push(
          `Project "${args.projectName}" not found — falling back to auto-detected project.`,
        )
      }
    }

    const includeContent = args.expand === true
    // PF3-04: when `userQuery` is set the MCP surface mirrors the shell
    // hook's `RANKED_WAKEUP_LIMITS` for the per-section defaults, so the
    // prompt-budget contract for ranked wake-up is identical regardless of
    // which surface fired. An explicit caller-supplied cap still wins —
    // these defaults only apply when the corresponding arg is absent.
    const ranked = typeof args.userQuery === "string" && args.userQuery.trim().length > 0
    const recentDefault = ranked
      ? RANKED_WAKEUP_LIMITS.memoryLimit
      : DEFAULT_WAKEUP_MEMORY_LIMIT
    const relatedDefault = ranked
      ? RANKED_WAKEUP_LIMITS.relatedMemoryLimit
      : DEFAULT_WAKEUP_RELATED_MEMORY_LIMIT
    const recentCap = args.limit ?? recentDefault
    const relatedCap = args.limit ?? relatedDefault
    const recentOverfetch = recentCap * COLLAPSE_OVERFETCH_MULTIPLIER
    const relatedOverfetch = relatedCap * COLLAPSE_OVERFETCH_MULTIPLIER
    // Task-memory section: relevance hits seeded by `userQuery`. Routes
    // through the same `ranked ? RANKED : DEFAULT` ternary as the other
    // sections so a future tightening of `RANKED_WAKEUP_LIMITS.taskMemoryLimit`
    // doesn't silently desync the surfaces. Today the two constants are
    // equal by construction (3) — that equality is documented in
    // `RANKED_WAKEUP_LIMITS` itself — but mirroring the structure removes
    // the silent-divergence trap and makes the section's policy obvious
    // at the call site. Over-fetch by the collapse multiplier so the
    // visible-cluster slice has headroom — same discipline as Recent and
    // Related, since this section also runs through `collapseOverlappingMemories`.
    const taskCap =
      args.taskMemoryLimit ??
      (ranked ? RANKED_WAKEUP_LIMITS.taskMemoryLimit : DEFAULT_WAKEUP_TASK_MEMORY_LIMIT)
    const taskOverfetch = taskCap * COLLAPSE_OVERFETCH_MULTIPLIER
    // The knowledge-fact section doesn't run through topical collapse,
    // so the ranked default flows straight through to the data layer
    // without an over-fetch step. Caller-supplied values win as before;
    // absent values fall to the ranked cap when `userQuery` is set,
    // otherwise to the data-layer constants resolved here at the call
    // site rather than relying on `loadWakeUpData`'s internal `??`
    // defaulting. Self-contained resolution keeps the MCP call's policy
    // visible in this file — a future change to the data-layer defaulting
    // discipline (e.g. switching to required params) can't silently shift
    // the MCP path.
    const knowledgeFactLimit =
      args.knowledgeFactLimit ??
      (ranked ? RANKED_WAKEUP_LIMITS.knowledgeFactLimit : DEFAULT_WAKEUP_KNOWLEDGE_FACT_LIMIT)
    // Resolve the task-bucket cap here so the renderer can size
    // `computeTasksFetchLimit`'s saturation gate against the same
    // value the data layer used. `loadWakeUpData` applies the same
    // `?? DEFAULT_WAKEUP_TASK_LIMIT` internally, so the value passed
    // through is structurally a no-op for the data-layer call —
    // resolving it once just makes it visible to the post-fetch
    // renderer below.
    const bucketedTaskLimit = args.taskLimit ?? DEFAULT_WAKEUP_TASK_LIMIT
    const {
      digest,
      memories,
      knowledgeFacts,
      proposedDecisions,
      overdueDecisions,
      relatedMemories,
      tasks,
      taskMemories,
    } = await loadWakeUpData(services, {
      projectId: projectId ?? undefined,
      memoryLimit: recentOverfetch,
      memoryLimitWithDigest: recentOverfetch,
      relatedMemoryLimit: relatedOverfetch,
      knowledgeFactLimit,
      taskLimit: bucketedTaskLimit,
      userQuery: args.userQuery,
      taskMemoryLimit: taskOverfetch,
      includeMemoryContent: includeContent,
    })

    const sections: string[] = []

    const projectContext = composeProjectContext(
      resolvedProject,
      services.config,
      resolvedCatchAllFallback,
    )
    const projectLines = renderProjectContextLines(projectContext)
    if (projectLines.length > 0) {
      sections.push(`${projectLines.join("\n")}\n`)
    }

    if (warnings.length > 0) {
      sections.push(`> ${warnings.join("\n> ")}\n`)
    }

    if (digest) {
      // The digest section bypasses `formatMemoryListItem` and therefore
      // does NOT render a trust indicator (#09). Intentional: the digest
      // is a synthesis surface (one bold-title row + a body paragraph),
      // not a triage row in a list. A trust indicator would imply per-row
      // ranking — which Recent / For-Your-Current-Task / Related need
      // because they're scrollable lists of competing memories — but the
      // digest is a single block summarizing recent activity. The
      // synthesizer's own `Confidence Score` is system-managed like any
      // other memory's, and a heavily-decayed digest IS a real signal
      // worth flagging, but the canonical surface for that is
      // `lore-context action='wake-up'` Recent Memories / For Your
      // Current Task picking the digest up as just another memory if
      // the agent's context warrants it.
      sections.push(`## Latest Digest — ${digest.createdAt.split("T")[0]}\n`)
      sections.push(`**${digest.title}**\n`)
      if (digest.content) {
        sections.push(digest.content.trim(), "")
      }
    }

    // Citation-as-evidence (issue 0.8.0/05). Wake-up over-fetches by
    // `COLLAPSE_OVERFETCH_MULTIPLIER` to leave the topical-collapse pass
    // headroom; the touch batch must NOT see those over-fetched rows
    // (they were never rendered). Each section captures its rendered
    // cluster-rep + collapsed-peer IDs into `surfacedIds`; at the end
    // those IDs are resolved to Memory shapes via the over-fetched
    // input arrays. This keeps the touch surface aligned with what the
    // agent actually sees, not what the data layer fetched.
    const surfacedIds = new Set<string>()
    const inputMemoriesById = new Map<string, Memory>()
    if (digest) inputMemoriesById.set(digest.id, digest)
    for (const m of memories) inputMemoriesById.set(m.id, m)
    for (const m of relatedMemories) inputMemoriesById.set(m.id, m)
    for (const m of taskMemories) inputMemoriesById.set(m.id, m)
    if (digest) surfacedIds.add(digest.id)
    const recordSurfaced = (group: CollapsedMemoryGroup): void => {
      surfacedIds.add(group.keep.id)
      for (const id of group.collapsedIds) surfacedIds.add(id)
    }

    // P3-05: relevance hits seeded by the caller's `userQuery`. Surfaced
    // directly under the digest (densest single signal about what the
    // user is asking about) and above timestamp-ordered Recent Memories.
    // Section is omitted when no `userQuery` was passed so legacy callers
    // see byte-identical pre-P3-05 output. Runs through the same
    // collapse + cluster-slice as Recent / Related so a near-duplicate
    // task hit doesn't shrink the visible row count.
    if (taskMemories.length > 0) {
      sections.push("## For Your Current Task\n")
      sections.push(
        "*Memories ranked by relevance to your `userQuery`. Deduped against the digest, Recent Memories, and Related sections so the same page never renders twice.*\n",
      )
      const groups = collapseOverlappingMemories(taskMemories).slice(0, taskCap)
      for (const group of groups) {
        sections.push(...renderMemoryEntry(group.keep, group, includeContent, 3))
        recordSurfaced(group)
      }
    }

    if (memories.length > 0) {
      const heading = digest
        ? "## Recent Memories (since digest)\n"
        : "## Recent Memories\n"
      sections.push(heading)
      const groups = collapseOverlappingMemories(memories).slice(0, recentCap)
      const groupsByKeepId = new Map(groups.map((g) => [g.keep.id, g]))
      const buckets = new Map<string, Memory[]>()
      for (const group of groups) {
        const bucket = dateBucket(group.keep.createdAt)
        if (!buckets.has(bucket)) buckets.set(bucket, [])
        buckets.get(bucket)!.push(group.keep)
        recordSurfaced(group)
      }
      for (const label of ["Today", "Yesterday", "Earlier"] as const) {
        const mems = buckets.get(label)
        if (!mems) continue
        sections.push(`### ${label}\n`)
        for (const mem of mems) {
          const group = groupsByKeepId.get(mem.id)
          sections.push(...renderMemoryEntry(mem, group, includeContent, 4))
        }
      }
    } else if (!digest) {
      sections.push("No memories found for this context.\n")
    }

    if (relatedMemories.length > 0) {
      sections.push("## Related to Active Tasks\n")
      sections.push(
        "*Memories surfaced by a relevance query seeded from your active task entities. Deduped against the digest and Recent Memories above, so these are the *next* most relevant pages the recents didn't already cover.*\n",
      )
      const groups = collapseOverlappingMemories(relatedMemories).slice(0, relatedCap)
      for (const group of groups) {
        sections.push(...renderMemoryEntry(group.keep, group, includeContent, 3))
        recordSurfaced(group)
      }
    }

    if (proposedDecisions.length > 0 || overdueDecisions.length > 0) {
      const today = new Date().toISOString().split("T")[0]
      sections.push("## Decisions Requiring Attention\n")
      if (proposedDecisions.length > 0) {
        sections.push(`### Proposed (${proposedDecisions.length})\n`)
        for (const d of proposedDecisions) {
          sections.push(
            `- **${d.title}** — proposed${d.decidedAt ? ` ${d.decidedAt}` : ""} | ID: ${d.id}`,
          )
        }
        sections.push("")
      }
      if (overdueDecisions.length > 0) {
        sections.push(`### Overdue for Review (${overdueDecisions.length})\n`)
        for (const d of overdueDecisions) {
          const days = d.reviewBy
            ? Math.floor(
                (new Date(today).getTime() - new Date(d.reviewBy).getTime()) /
                  86_400_000,
              )
            : 0
          sections.push(
            `- **${d.title}** [${d.status}] — review by ${d.reviewBy ?? "?"} (${days} day${days === 1 ? "" : "s"} overdue) | ID: ${d.id}`,
          )
        }
        sections.push("")
      }
    }

    const factTitleMap = await resolveReferencedTitles(knowledgeFacts, services)

    if (tasks.length > 0) {
      const today = new Date().toISOString().split("T")[0]
      // Mutually-exclusive bucketing: Overdue > Stale > Active. An
      // overdue task is by definition not stale (overdue is the
      // stronger urgency signal); a stale task is by definition not
      // overdue (no due date or due-after-today). A row lands in
      // exactly one bucket. `loadWakeUpData` over-fetches by 4× so
      // each bucket has headroom to apply its own `taskLimit` slice
      // without one bucket starving the others.
      //
      // The `overdueDays` value is computed once per row here and
      // threaded through to `formatWakeUpTaskRow` so bucketing
      // precedence and row-format urgency can never drift apart —
      // they read the same cached signal.
      type BucketedTask = { task: TaskSummary; overdueDays: number | null }
      const overdueBucket: BucketedTask[] = []
      const staleBucket: BucketedTask[] = []
      const activeBucket: BucketedTask[] = []
      for (const task of tasks) {
        const overdueDays = taskDaysOverdue(task, today)
        if (overdueDays !== null) {
          overdueBucket.push({ task, overdueDays })
          continue
        }
        const staleDays = taskDaysStale(task, today)
        if (staleDays !== null && staleDays >= STALE_TASK_DAYS) {
          staleBucket.push({ task, overdueDays })
          continue
        }
        activeBucket.push({ task, overdueDays })
      }

      const overdueShown = overdueBucket.slice(0, bucketedTaskLimit)
      const staleShown = staleBucket.slice(0, bucketedTaskLimit)
      const activeShown = activeBucket.slice(0, bucketedTaskLimit)

      // Saturation marker. When the resolved row count fills the
      // over-fetch window computed by `computeTasksFetchLimit`, both
      // bucket totals and hidden counts are lower bounds, not
      // inventory claims. Prefix with `≥` so the heading signals the
      // over-fetch bound rather than overstating coverage.
      // `lore-task action='reconcile'` is the proper audit surface;
      // the wake-up Tasks section is the triage view, and the marker
      // is its claim to that scope.
      const tasksFetchLimit = computeTasksFetchLimit(bucketedTaskLimit)
      const saturated =
        tasksFetchLimit > 0 && tasks.length >= tasksFetchLimit

      // Heading-suffix count: when the bucket is truncated, surface
      // shown / total / hiding in the heading itself rather than as a
      // separate trailing line. Single signal, matches the precedent
      // in `lore-task action='list'`'s bucket headings (`src/mcp/tools/
      // tasks.ts`'s `handleList` — search for "shown of") so the
      // operator-facing format stays consistent across the two
      // surfaces that render task buckets. The optional `descriptor`
      // (e.g. "active tasks untouched ≥30 days" for the Stale bucket)
      // stays attached to the total count so the truncated heading
      // reads as "10 shown of 12 active tasks untouched ≥30 days,
      // hiding 2" — descriptor qualifies the bucket total, not the
      // hidden count.
      //
      // Shown is exact — we know what we rendered. Total and hidden
      // are lower bounds under saturation — we know we hit the
      // over-fetch ceiling, not what's beyond it — so the `bound`
      // prefix attaches to those two and not to shown.
      const bound = saturated ? "≥" : ""
      const countLabel = (
        bucket: BucketedTask[],
        rows: BucketedTask[],
        descriptor: string,
      ): string => {
        const total = `${bound}${bucket.length}${descriptor ? ` ${descriptor}` : ""}`
        const hidden = bucket.length - rows.length
        return hidden > 0
          ? `${rows.length} shown of ${total}, hiding ${bound}${hidden}`
          : total
      }

      const renderBucket = (
        rows: BucketedTask[],
        heading: string,
      ): void => {
        if (rows.length === 0) return
        sections.push(heading)
        for (const { task, overdueDays } of rows) {
          sections.push(formatWakeUpTaskRow(task, today, overdueDays))
        }
        sections.push("")
      }

      if (
        overdueShown.length > 0 ||
        staleShown.length > 0 ||
        activeShown.length > 0
      ) {
        sections.push("## Tasks\n")
        renderBucket(
          overdueShown,
          `### Overdue (${countLabel(overdueBucket, overdueShown, "")})\n`,
        )
        const staleDescriptor =
          `active task${staleBucket.length === 1 ? "" : "s"} ` +
          `untouched ≥${STALE_TASK_DAYS} days`
        renderBucket(
          staleShown,
          `### Stale (${countLabel(staleBucket, staleShown, staleDescriptor)}) — consider closing if resolved\n`,
        )
        renderBucket(
          activeShown,
          `### Active (${countLabel(activeBucket, activeShown, "")})\n`,
        )
      }
    }

    if (knowledgeFacts.length > 0) {
      sections.push("## Active Facts\n")
      for (const fact of knowledgeFacts) {
        sections.push(
          renderFact(fact, {
            titleMap: factTitleMap,
            trailing: `(${fact.confidence})`,
          }),
        )
      }
    }

    const response: ToolResult = {
      content: [{ type: "text", text: sections.join("\n") }],
    }

    // Resolve surfaced IDs to Memory shapes from the input pool. A
    // collapsed peer's id reaches `surfacedIds` via the cluster's
    // `collapsedIds` field — its full Memory shape lives in the
    // over-fetched input array (`memories` / `relatedMemories` /
    // `taskMemories`), so the lookup map covers both cluster reps and
    // collapsed peers. IDs missing from the map (shouldn't happen
    // structurally, but defensive against a future change to
    // collapseOverlappingMemories that injects synthesized ids) are
    // silently dropped — touch is advisory.
    //
    // **"Decisions Requiring Attention" memories are deliberately NOT
    // touched.** That section surfaces decisions BECAUSE they need
    // human review (proposed waiting for acceptance, or accepted but
    // past their `Review By` date). Bumping `Confidence Score` on
    // every wake-up that lists an overdue decision would (a) push the
    // score upward despite the decision being neglected, and (b) reset
    // the decay clock via `Last Referenced At`, masking the staleness
    // signal that put the decision in the section in the first place.
    // The cite-as-evidence model treats agent attention as evidence;
    // a review-reminder section is the opposite of evidence — it is
    // the system flagging something as needing attention. Skipping
    // these rows preserves the staleness signal that drives them.
    const surfacedMemories: Memory[] = []
    for (const id of surfacedIds) {
      const memory = inputMemoriesById.get(id)
      if (memory) surfacedMemories.push(memory)
    }
    await fireTouchOnRead(services.memories, surfacedMemories, "lore-context (wake-up)")

    return response
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return toolError(new Error(`lore-context action='wake-up' failed to load context: ${message}`))
  }
}

async function handleDigest(
  services: LoreServices,
  args: {
    period?: "day" | "week"
    since?: string
    until?: string
    projectName?: string
  },
): Promise<ToolResult> {
  try {
    let projectId = services.context.project?.id
    let projectLabel = services.context.project?.name ?? "vault-wide"

    const warnings: string[] = []

    if (args.projectName) {
      const found = await services.projects.findByName(args.projectName)
      if (found) {
        projectId = found.id
        projectLabel = found.name
      } else {
        warnings.push(
          `Project "${args.projectName}" not found — falling back to auto-detected project.`,
        )
      }
    }

    const digest = await gatherDigestData(services, {
      projectId,
      projectLabel,
      since: args.since,
      until: args.until,
      period: args.period,
    })

    const parts: string[] = [digest.raw]
    if (warnings.length > 0) {
      parts.push(`## Warnings\n${warnings.join("\n")}`, "")
    }
    parts.push(
      "---\n" +
        "To save this digest, synthesize the above into a concise summary and call " +
        '`lore-memory` with `action: "save"` and `source: "digest"`.',
    )

    return { content: [{ type: "text", text: parts.join("\n") }] }
  } catch (err) {
    return toolError(err)
  }
}

const contextDispatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("status") }),
  z.object({
    action: z.literal("wake-up"),
    projectName: z.string().optional(),
    expand: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
    knowledgeFactLimit: z.number().int().min(0).max(50).optional(),
    taskLimit: z.number().int().min(0).max(50).optional(),
    userQuery: z.string().optional(),
    taskMemoryLimit: z.number().int().min(0).max(20).optional(),
  }),
  z.object({
    action: z.literal("digest"),
    period: z.enum(["day", "week"]).optional(),
    since: z.string().optional(),
    until: z.string().optional(),
    projectName: z.string().optional(),
  }),
])

export function registerContextTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-context — polymorphic dispatcher (P3-01)
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-context",
    {
      title: "Vault context operations",
      description:
        "Vault status, session priming, and project digest in one polymorphic tool. Action-dispatched:\n\n" +
        "- `action: 'status'` — vault page id, database counts, active project, configured projects, and a task summary line (active / overdue / stale / in-progress / blocked, plus a closure-rate line on vaults with the `Done At` column).\n" +
        "- `action: 'wake-up'` — load digest + (when `userQuery` is set) For-Your-Current-Task ranked memories + recent memories + tasks + active facts + decisions requiring attention. Title-tier rows by default; `expand: true` for bodies. Pass `userQuery` after `/clear` or a session-pivot so wake-up ranks pages by the user's actual question.\n" +
        "- `action: 'digest'` — gather raw activity data for synthesis into a digest memory. Save the synthesis via `lore-memory` action='save' with source='digest'.",
      inputSchema: {
        action: z
          .enum(["status", "wake-up", "digest"])
          .describe("Operation: 'status', 'wake-up' (session priming), or 'digest' (raw data)."),
        // wake-up + digest
        projectName: z
          .string()
          .optional()
          .describe("(action='wake-up' or 'digest') Override the auto-detected project."),
        // wake-up
        expand: z
          .boolean()
          .optional()
          .describe(
            "(action='wake-up') Include each memory's markdown body inline (default false). Each body costs one extra Notion round-trip.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe(
            "(action='wake-up') Max distinct clusters per memory section after topical collapse.",
          ),
        knowledgeFactLimit: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe("(action='wake-up') Max active-facts rendered (default 25). 0 skips."),
        taskLimit: z
          .number()
          .int()
          .min(0)
          .max(50)
          .optional()
          .describe(
            `(action='wake-up') Max tasks rendered in the Tasks section (default ${DEFAULT_WAKEUP_TASK_LIMIT}). 0 skips the section entirely.`,
          ),
        userQuery: z
          .string()
          .optional()
          .describe(
            "(action='wake-up') Optional short description of the user's current task. When set, fires an additional relevance search seeded by this text and surfaces the hits as a 'For Your Current Task' section above Recent Memories. Truncated to 1000 chars before search. Mirrors the shell hook's P3-05 ranked path, so MCP-direct callers (e.g. after `/clear` or a session pivot) get the same query-aware output.",
          ),
        taskMemoryLimit: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe(
            `(action='wake-up') Max memories surfaced for the user's current task (default ${DEFAULT_WAKEUP_TASK_MEMORY_LIMIT}). Honored only when 'userQuery' is non-empty. Set 0 to skip the section entirely even when a query is provided.`,
          ),
        // digest
        period: z
          .enum(["day", "week"])
          .optional()
          .describe(
            "(action='digest') Time window: 'day' (last 24h) or 'week' (last 7 days). Ignored if since/until provided.",
          ),
        since: z
          .string()
          .optional()
          .describe(
            "(action='digest') Custom start (ISO datetime, e.g. 2025-04-14T00:00:00Z). Overrides period.",
          ),
        until: z
          .string()
          .optional()
          .describe("(action='digest') Custom end (ISO datetime). Defaults to now."),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const parsed = contextDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(
          new Error(formatDispatchError("lore-context", parsed.error)),
        )
      }
      switch (parsed.data.action) {
        case "status":
          return handleStatus(services)
        case "wake-up":
          return handleWakeUp(services, parsed.data)
        case "digest":
          return handleDigest(services, parsed.data)
      }
    },
  )
}
