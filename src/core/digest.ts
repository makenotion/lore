/**
 * Digest data gathering — shared between the
 * `lore-context action='digest'` MCP tool, the `lore digest` CLI
 * command, and the Stop-triggered background synthesizer.
 *
 * Produces a project-scoped, markdown-formatted snapshot of recent activity
 * (memories grouped by source, active task subjects under "Open Work",
 * and the previous digest's title + date). The synthesizer agent consumes
 * the `raw` string as untrusted content and writes a distilled
 * `source: digest` memory back to the vault.
 *
 * Kept pure (no process state, no spawn) so it can be tested against
 * service stubs and reused in any interface.
 */

import type { Memory, TaskSummary } from "../types.js"

/**
 * Default staleness window matching `DEFAULT_DIGEST_FRESHNESS_DAYS`:
 * once a digest ages past this many days,
 * `lore-context action='wake-up'` stops surfacing it on the fast path.
 * The Stop-triggered auto-digest reuses the same threshold — re-synthesize
 * just in time for the next wake-up to pick it up.
 */
export const DIGEST_STALE_DAYS = 7

/** Cap on recent memories included in the raw digest data. Mirrors the
 *  original MCP tool's limit — larger windows blow the synthesizer's input
 *  context without improving signal. */
const MAX_RECENT_MEMORIES = 50

/** Truncate individual memory bodies in the raw data so one verbose memory
 *  doesn't monopolize the synthesizer's budget. */
const MEMORY_CONTENT_PREVIEW_CHARS = 300

export interface DigestServices {
  memories: {
    list(opts: {
      projectId?: string
      source?: "digest" | "conversation" | "agent_diary" | "manual" | "file"
      since?: string
      until?: string
      limit?: number
      sortBy?: "created_time" | "last_edited_time"
      includeContent?: boolean
    }): Promise<{ items: Memory[] }>
  }
  tasks: {
    list(opts?: {
      projectId?: string
      states?: import("../types.js").TaskState[]
      limit?: number
    }): Promise<{ items: TaskSummary[]; nextCursor?: string }>
  }
}

/**
 * Cap on the "Open Work" tasks section so prompt-budget impact stays
 * roughly neutral against the legacy tracking-fact section. The fetch
 * issues `limit: MAX_OPEN_WORK_TASKS + 1` so the renderer can detect
 * truncation locally; if Notion still reports `nextCursor` after that
 * fetch (i.e. the open-work population exceeds the local probe), the
 * heading and footer indicate "many more" rather than under-counting
 * a vault with 100+ open tasks as "+1 more".
 */
const MAX_OPEN_WORK_TASKS = 25

export interface GatherDigestOpts {
  /** Project to scope the digest to. `null` / omitted = vault-wide. */
  projectId?: string | null
  /** Human-readable label for the project, used in section headings. */
  projectLabel: string
  /** Window start (ISO datetime). Defaults to 24h before `until`. */
  since?: string
  /** Window end (ISO datetime). Defaults to now. */
  until?: string
  /** Preset shorthand for `since` when an explicit datetime isn't given. */
  period?: "day" | "week"
  /**
   * Injected clock for deterministic tests. Production callers omit this
   * and get `new Date()` under the hood.
   */
  now?: () => Date
}

export interface DigestData {
  /** Markdown blob the synthesizer consumes. */
  raw: string
  /** ISO date (YYYY-MM-DD) of the most recent existing digest, or null. */
  lastDigestDate: string | null
  /** Number of memories in the window — useful for "nothing to digest" checks. */
  recentMemoryCount: number
}

function computeWindow(
  opts: GatherDigestOpts,
  now: Date,
): { start: string; end: string } {
  const end = opts.until ?? now.toISOString()
  if (opts.since) return { start: opts.since, end }

  const dayMs = 86_400_000
  const days = opts.period === "week" ? 7 : 1
  const start = new Date(now.getTime() - days * dayMs).toISOString()
  return { start, end }
}

/**
 * Strip the time half off an ISO datetime so callers can compare / render
 * `YYYY-MM-DD`. Centralized so the CLI and hook surfaces share one
 * `.split("T")[0] ?? fallback` implementation.
 */
export function isoDate(input: string | Date): string {
  const iso = typeof input === "string" ? input : input.toISOString()
  return iso.split("T")[0] ?? iso
}

/**
 * Days between an ISO date and now, floor'd. Used by the Stop-triggered
 * auto-digest scheduler to decide whether to re-fire synthesis.
 */
export function daysSince(iso: string, now: Date = new Date()): number {
  const then = new Date(iso).getTime()
  return Math.floor((now.getTime() - then) / 86_400_000)
}

export async function gatherDigestData(
  services: DigestServices,
  opts: GatherDigestOpts,
): Promise<DigestData> {
  const now = opts.now ? opts.now() : new Date()
  const { start: windowStart, end: windowEnd } = computeWindow(opts, now)

  const [
    { items: recentMemories },
    { items: lastDigestList },
    { items: openTasks, nextCursor: openTasksNextCursor },
  ] = await Promise.all([
    services.memories.list({
      projectId: opts.projectId ?? undefined,
      since: windowStart,
      until: windowEnd,
      limit: MAX_RECENT_MEMORIES,
      // The synthesizer prompt renders a content preview per memory.
      includeContent: true,
    }),
    // Sort by creation so freshness aligns with "latest created digest":
    // an edit to an older digest must not mask a newer one. Mirrors the
    // same guard — keeping the two lookups consistent
    // is load-bearing for the wake-up fast path.
    services.memories.list({
      projectId: opts.projectId ?? undefined,
      source: "digest",
      limit: 1,
      sortBy: "created_time",
    }),
    // Open Work signal: active tasks (open + blocked). The synthesizer
    // prompt depends on a "what's open" cue, so this section is the
    // committed replacement for the legacy tracking-fact open-loops
    // grouping. Fetch one beyond the display cap so the renderer can
    // distinguish "exactly 25 visible, none truncated" from "25 visible
    // plus more behind the cap" — and trust Notion's `nextCursor` /
    // `has_more` signal for vaults whose open-task population exceeds
    // the local probe size.
    services.tasks.list({
      projectId: opts.projectId ?? undefined,
      states: ["open", "blocked"],
      limit: MAX_OPEN_WORK_TASKS + 1,
    }),
  ])

  const lastDigest = lastDigestList[0] ?? null
  const lastDigestDate = lastDigest ? isoDate(lastDigest.createdAt) : null

  const bySource = new Map<string, Memory[]>()
  for (const mem of recentMemories) {
    const bucket = bySource.get(mem.source) ?? []
    bucket.push(mem)
    bySource.set(mem.source, bucket)
  }

  const sections: string[] = []
  sections.push(`# Digest Data — ${opts.projectLabel}`)
  sections.push(
    `Window: ${windowStart.split("T")[0]} → ${windowEnd.split("T")[0]}`,
  )
  sections.push("")

  if (lastDigest) {
    sections.push(`## Previous Digest`)
    sections.push(`**${lastDigest.title}** (${lastDigest.createdAt.split("T")[0]})`)
    sections.push("")
  }

  if (recentMemories.length > 0) {
    sections.push(`## Activity (${recentMemories.length} memories)`)
    for (const [source, mems] of bySource) {
      sections.push(`\n### ${source} (${mems.length})`)
      for (const mem of mems) {
        const tags = mem.tags.length > 0 ? ` [${mem.tags.join(", ")}]` : ""
        const date = mem.createdAt.split("T")[0]
        sections.push(`- **${mem.title}** (${date})${tags}`)
        if (mem.content) {
          const preview =
            mem.content.length > MEMORY_CONTENT_PREVIEW_CHARS
              ? mem.content.slice(0, MEMORY_CONTENT_PREVIEW_CHARS) + "..."
              : mem.content
          sections.push(`  ${preview}`)
        }
      }
    }
    sections.push("")
  } else {
    sections.push("## Activity\nNo memories found in this window.\n")
  }

  if (openTasks.length > 0) {
    const today = isoDate(now)
    const visible = openTasks.slice(0, MAX_OPEN_WORK_TASKS)
    // Two truncation signals: a local one (more rows fetched than
    // displayed) and Notion's `nextCursor` / `has_more` (the
    // open-task population exceeds the local probe of
    // `MAX_OPEN_WORK_TASKS + 1`). When the latter fires, the exact
    // hidden count is unknown without paginating, so render
    // "many more" rather than under-counting against the local probe
    // — a vault with hundreds of open tasks would otherwise be
    // reported to the synthesizer as "+1 more".
    const localHidden = openTasks.length - visible.length
    const trulyTruncated = Boolean(openTasksNextCursor)
    const heading = trulyTruncated
      ? `## Open Work (${visible.length} shown; many more open beyond the cap)`
      : localHidden > 0
        ? `## Open Work (${visible.length} shown of ${openTasks.length})`
        : `## Open Work (${openTasks.length})`
    sections.push(heading)
    for (const task of visible) {
      const stateLabel = task.taskState ?? "open"
      const blocker = task.blockedBy ? `, blocked by ${task.blockedBy}` : ""
      const entityHint = task.entity && task.entity !== task.title ? ` — ${task.entity}` : ""
      const due = task.reviewBy
        ? task.reviewBy <= today
          ? ` (due ${task.reviewBy} **OVERDUE**)`
          : ` (due ${task.reviewBy})`
        : ""
      sections.push(
        `- **${task.title}**${entityHint} [${stateLabel}${blocker}]${due}`,
      )
    }
    if (trulyTruncated) {
      sections.push(
        `- … and many more open tasks not shown (call \`lore-task action='list'\` for the full picture).`,
      )
    } else if (localHidden > 0) {
      sections.push(`- … and ${localHidden} more.`)
    }
    sections.push("")
  }

  return {
    raw: sections.join("\n"),
    lastDigestDate,
    recentMemoryCount: recentMemories.length,
  }
}
