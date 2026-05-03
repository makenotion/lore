import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"
import { MemoryReviewAuditError } from "../../core/memory.js"
import {
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import { notionPageUrl, terminalLink } from "../output.js"

/**
 * `lore inbox` — operator-facing CLI for the proposed-memory review
 * inbox (issue #281, AC #3). Four subcommands:
 *
 * - `lore inbox list [--project <name>] [-n <limit>]` — list memories
 *   awaiting review.
 * - `lore inbox approve <memoryId> [--reason <text>]` — promote a
 *   `Status: proposed` memory to `accepted`.
 * - `lore inbox reject <memoryId> [--reason <text>]` — flip a
 *   `Status: proposed` memory to `rejected`.
 * - `lore inbox archive <memoryId>` — soft-delete via the existing
 *   archive path; provided here for symmetry with the
 *   approve / reject / archive vocabulary the issue specs.
 *
 * Reviewer identity is resolved via `services.identity.resolveAuthor()`
 * (the same lazy `LORE_USER_NAME` → `users.me` chain that authors
 * Memory writes). An unresolvable identity surfaces a clear error
 * rather than landing an audit row attributed to "(unknown)".
 *
 * The inbox surface is read-only and append-only — no destructive
 * paths past `archive`, which is already a soft-delete. A future
 * `lore inbox bulk-approve` is plausible follow-up but out of scope
 * for the initial Phase 4 ship.
 */

const DEFAULT_LIST_LIMIT = 50

export const inboxCommand = new Command("inbox")
  .description("Review the proposed-memory inbox: list, approve, reject, archive")

const listCmd = new Command("list")
  .description("List memories awaiting review (Status = proposed)")
  .option("--project <name>", "Scope to a single project")
  .option(
    "-n, --limit <number>",
    `Max rows to render (default ${DEFAULT_LIST_LIMIT}, max 100)`,
  )
  .action(async (opts: { project?: string; limit?: string }) => {
    try {
      const limit = parseListLimit(opts.limit)
      const services = await initServices(undefined, { driftCheck: false })
      const project = await resolveProject(services, opts.project)
      const projectId = project?.id

      const { items } = await services.memories.list({
        projectId,
        status: "proposed",
        // `excludeKinds: ["decision"]` mirrors `proposedMemoryFilter()`'s
        // `Kind != decision` clause so the listing surface and the
        // count surface (`lore status`'s Proposed memories line) agree
        // on what counts as inbox memories. Without this, a
        // proposed-state `decision` row would appear in `lore inbox list`
        // but not in the count, producing visible drift between the two
        // surfaces. The decision lifecycle action is
        // `lore-decision action='supersede'` / `'review'`, not the
        // memory inbox.
        excludeKinds: ["decision"],
        limit,
        includeContent: false,
        sortBy: "created_time",
        // `direction: "ascending"` aligns with the wake-up Proposed
        // Memories section so the same row is "first" in both
        // surfaces. The inbox is fundamentally a triage list — stale
        // review debt should surface ahead of recent additions, since
        // newer items will catch the next round.
        direction: "ascending",
      })

      if (items.length === 0) {
        const scope = project ? ` for project "${project.name}"` : ""
        console.log(`No proposed memories pending review${scope}.`)
        return
      }

      for (const m of items) {
        const tags = m.tags.length > 0 ? ` [${m.tags.join(", ")}]` : ""
        const date = m.createdAt.split("T")[0] ?? m.createdAt
        const linkedTitle = terminalLink(m.title || "(untitled)", notionPageUrl(m.id))
        const sourceAgent = [m.source, m.agent || null].filter(Boolean).join(" · ")
        console.log(`${linkedTitle}${tags}`)
        console.log(`  ${date} · ${sourceAgent} · ID: ${m.id}`)
        if (m.synopsis) {
          console.log(`  ${m.synopsis}`)
        }
        console.log()
      }
      const scope = project ? ` (${project.name})` : ""
      console.log(`${items.length} memor${items.length === 1 ? "y" : "ies"} awaiting review${scope}.`)
    } catch (err) {
      console.error("Inbox list failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

const approveCmd = new Command("approve")
  .description("Approve a proposed memory (Status: proposed → accepted)")
  .argument("<memoryId>", "Notion page ID of the proposed memory")
  .option("--reason <text>", "Optional reviewer rationale recorded in the audit block")
  .option(
    "--reviewer <name>",
    "Override the resolved reviewer name (defaults to LORE_USER_NAME → users.me)",
  )
  .action(async (memoryId: string, opts: { reason?: string; reviewer?: string }) => {
    await runReview("approve", memoryId, opts.reason, opts.reviewer)
  })

const rejectCmd = new Command("reject")
  .description("Reject a proposed memory (Status: proposed → rejected)")
  .argument("<memoryId>", "Notion page ID of the proposed memory")
  .option("--reason <text>", "Optional reviewer rationale recorded in the audit block")
  .option(
    "--reviewer <name>",
    "Override the resolved reviewer name (defaults to LORE_USER_NAME → users.me)",
  )
  .action(async (memoryId: string, opts: { reason?: string; reviewer?: string }) => {
    await runReview("reject", memoryId, opts.reason, opts.reviewer)
  })

const archiveCmd = new Command("archive")
  .description("Archive a proposed memory (soft-delete via Notion archive flag)")
  .argument("<memoryId>", "Notion page ID of the memory to archive")
  .action(async (memoryId: string) => {
    try {
      const services = await initServices(undefined, { driftCheck: false })
      // `lore inbox archive` is **inbox-only** — same contract as
      // `approve` / `reject`. Without a status guard, a fat-fingered
      // memoryId (or a copy/paste from the wrong scrollback) could
      // soft-delete an accepted decision / runbook / note from the
      // operator's review surface, with no preflight signal that
      // they were leaving inbox scope. Operators who genuinely want
      // to archive a non-proposed row use
      // `lore-memory action='archive'` directly.
      // Properties-only fetch for the Status guard.
      // `getPropertiesById` skips the per-row `pages.retrieveMarkdown`
      // round-trip that `getById` would pay for the body — the
      // archive guard only inspects `memory.status` (a Notion
      // select property), so the markdown fetch is pure waste.
      // Total cost: one `pages.retrieve` for the property read +
      // one `pages.update` for the archive flag. Mirrors the
      // documented `getPropertiesById` sibling contract for
      // property-only consumers.
      const memory = await services.memories.getPropertiesById(memoryId)
      if (memory.status !== "proposed") {
        console.error(
          `Cannot archive memory ${memoryId} via 'lore inbox archive': ` +
            `current status is "${memory.status}", expected "proposed". ` +
            `'lore inbox' subcommands are inbox-only — use ` +
            `\`lore-memory action='archive'\` (MCP) or update tooling ` +
            `for general archives.`,
        )
        process.exit(1)
        return
      }
      // Kind guard mirrors `proposedMemoryFilter()`'s `Kind != decision`
      // exclusion and the `MemoryService.recordReview` decision guard.
      // Without it, a pasted decision id with `Status: proposed` would
      // pass the status guard and soft-delete a proposed-state decision
      // through the memory inbox surface, bypassing the decision
      // lifecycle (`lore-decision action='supersede'` / `'review'`).
      // The list / count / wake-up / approve / reject surfaces all
      // exclude `Kind = decision`; archive must too, otherwise the
      // inbox boundary disagrees with itself and operators can
      // accidentally route governance state through the auto-learning
      // triage path.
      if (memory.kind === "decision") {
        console.error(
          `Cannot archive memory ${memoryId} via 'lore inbox archive': ` +
            `Kind is "decision". Decisions have their own lifecycle — ` +
            `use \`lore-decision action='supersede'\` to retire a ` +
            `decision or \`lore-decision action='review'\` to clear ` +
            `the proposed state. The memory-inbox archive action is ` +
            `limited to non-decision proposed memories.`,
        )
        process.exit(1)
        return
      }
      await services.memories.archive(memoryId)
      console.log(`Archived memory ${memoryId}`)
    } catch (err) {
      console.error("Inbox archive failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

inboxCommand.addCommand(listCmd)
inboxCommand.addCommand(approveCmd)
inboxCommand.addCommand(rejectCmd)
inboxCommand.addCommand(archiveCmd)

async function runReview(
  verdict: "approve" | "reject",
  memoryId: string,
  reason: string | undefined,
  explicitReviewer: string | undefined,
): Promise<void> {
  try {
    const services = await initServices(undefined, { driftCheck: false })
    const reviewer = await resolveReviewerIdentity(services, explicitReviewer)
    if (reviewer === null) {
      console.error(
        `Cannot ${verdict} memory ${memoryId}: no reviewer identity available.\n` +
          `Set LORE_USER_NAME in your shell, or pass \`--reviewer <name>\` ` +
          `directly so the audit trail can record who ` +
          `${verdict === "approve" ? "approved" : "rejected"} the row.`,
      )
      process.exit(1)
      return
    }

    const result = await services.memories.recordReview({
      memoryId,
      verdict,
      reviewer,
      reason,
    })

    const verdictLabel = verdict === "approve" ? "Approved" : "Rejected"
    console.log(
      `${verdictLabel} memory ${memoryId} (status: proposed → ${result.memory.status})`,
    )
    console.log(`  Reviewer: ${reviewer}`)
    if (reason && reason.trim().length > 0) {
      console.log(`  Reason: ${reason.trim()}`)
    }
  } catch (err) {
    // `MemoryReviewAuditError` signals a load-bearing partial state:
    // the Status flip persisted, only the cosmetic audit block is
    // missing. Exit code 2 (vs 1 for state errors) lets a wrapper
    // script distinguish "review didn't happen" from "review
    // happened but audit is missing" without parsing the message
    // string.
    if (err instanceof MemoryReviewAuditError) {
      console.error(
        `Inbox ${verdict} completed with audit-trail failure: ${err.message}`,
      )
      process.exit(2)
      return
    }
    console.error(
      `Inbox ${verdict} failed:`,
      err instanceof Error ? err.message : err,
    )
    process.exit(1)
  }
}

async function resolveReviewerIdentity(
  services: LoreServices,
  explicit: string | undefined,
): Promise<string | null> {
  const trimmedExplicit = explicit?.trim()
  if (trimmedExplicit && trimmedExplicit.length > 0) return trimmedExplicit
  const resolved = await services.identity.resolveAuthor()
  return resolved && resolved.trim().length > 0 ? resolved.trim() : null
}

async function resolveProject(
  services: LoreServices,
  raw: string | undefined,
) {
  const explicitName = validateExplicitProjectScopeName(raw, "--project", {
    listHint: "run `lore status projects` to list configured projects",
  })
  if (explicitName === undefined) return services.context.project
  return resolveProjectScopeName(services.projects, explicitName, "--project", {
    listHint: "run `lore status projects` to list configured projects",
  })
}

function parseListLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_LIST_LIMIT
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new Error(`--limit must be a positive integer, got "${raw}"`)
  }
  const value = Number(raw)
  if (value > 100) {
    throw new Error(`--limit must be between 1 and 100, got ${value}`)
  }
  return value
}
