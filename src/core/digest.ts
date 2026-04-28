/**
 * Digest data gathering — shared between the
 * `lore-context action='digest'` MCP tool, the `lore digest` CLI
 * command, and the session-end background synthesizer.
 *
 * Produces a project-scoped, markdown-formatted snapshot of recent activity
 * (memories grouped by source, tracking facts as open loops, and the
 * previous digest's title + date). The synthesizer agent consumes the
 * `raw` string as untrusted content and writes a distilled `source: digest`
 * memory back to the vault.
 *
 * Kept pure (no process state, no spawn) so it can be tested against
 * service stubs and reused in any interface.
 */

import type { Memory, Fact } from "../types.js"
import { TRACKING_PREDICATES } from "../types.js"

/**
 * Default staleness window matching `DEFAULT_DIGEST_FRESHNESS_DAYS` in
 * `wakeup.ts`: once a digest ages past this many days,
 * `lore-context action='wake-up'` stops surfacing it on the fast path.
 * The session-end auto-digest reuses the same
 * threshold — re-synthesize just in time for the next wake-up to pick it up.
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
    }): Promise<{ items: Memory[] }>
  }
  facts: {
    queryBySubject(
      subject: string,
      opts?: {
        projectId?: string
        predicates?: readonly string[]
        limit?: number
      },
    ): Promise<Fact[]>
  }
}

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
 * `YYYY-MM-DD`. Duplicates across the CLI and hook previously hand-rolled
 * `.split("T")[0] ?? fallback` for this; DRY it here.
 */
export function isoDate(input: string | Date): string {
  const iso = typeof input === "string" ? input : input.toISOString()
  return iso.split("T")[0] ?? iso
}

/**
 * Days between an ISO date and now, floor'd. Used by the session-end
 * scheduler to decide whether to re-fire synthesis.
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

  const [{ items: recentMemories }, { items: lastDigestList }, openLoops] =
    await Promise.all([
      services.memories.list({
        projectId: opts.projectId ?? undefined,
        since: windowStart,
        until: windowEnd,
        limit: MAX_RECENT_MEMORIES,
      }),
      // Sort by creation so freshness aligns with "latest created digest":
      // an edit to an older digest must not mask a newer one. Mirrors the
      // same guard in `core/wakeup.ts` — keeping the two lookups consistent
      // is load-bearing for the wake-up fast path.
      services.memories.list({
        projectId: opts.projectId ?? undefined,
        source: "digest",
        limit: 1,
        sortBy: "created_time",
      }),
      services.facts.queryBySubject("", {
        projectId: opts.projectId ?? undefined,
        predicates: TRACKING_PREDICATES,
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

  if (openLoops.length > 0) {
    const today = isoDate(now)
    sections.push(`## Open Loops (${openLoops.length})`)
    for (const fact of openLoops) {
      const since = fact.validFrom ? ` (since ${fact.validFrom})` : ""
      const overdue = fact.reviewBy && fact.reviewBy <= today ? " **(OVERDUE)**" : ""
      sections.push(
        `- **${fact.subject}** → ${fact.predicate.replace(/_/g, " ")} → **${fact.object}** [${fact.confidence}]${since}${overdue}`,
      )
    }
    sections.push("")
  }

  return {
    raw: sections.join("\n"),
    lastDigestDate,
    recentMemoryCount: recentMemories.length,
  }
}
