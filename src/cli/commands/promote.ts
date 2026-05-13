import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"
import { buildVaultTopology } from "../../core/topology.js"
import { preparePromotion, promoteMemory } from "../../core/promote.js"
import { notionPageUrl, terminalLink } from "../output.js"

/**
 * `lore promote <memoryId> --to <name>` — operator-facing CLI for the
 * cross-vault promotion path ("Promotion workflow").
 *
 * Copies a memory from the primary vault into a configured promotion
 * target defined in .lore.yaml's `promotionTargets`. The promoted
 * row carries an origin audit block in its body (per
 * `buildPromotionAuditBlock`) so the target-vault reader can trace
 * the copy back to its source without depending on cross-vault Notion
 * relations (Notion's `relation` column type is database-scoped, so
 * cross-vault links must be stable text/url metadata — the
 * `promoteMemory` helper carries the full rationale).
 *
 * Promoter identity is resolved via `services.identity.resolveAuthor()`
 * (the same lazy `LORE_USER_NAME` → `users.me` chain that authors
 * Memory writes). An unresolvable identity surfaces a clear error
 * rather than landing an audit block attributed to "(unknown)".
 *
 * Run `lore status` before promoting — the topology section's
 * `promotion (review required)` row health is the read-side preflight
 * for target reachability. `lore promote` itself skips drift checks
 * on init (`driftCheck: false`) for the same reason every other
 * write-path CLI does (`lore mine`, `lore tasks reconcile`); a target
 * that surfaces as `unavailable` or `missing databases` on
 * `lore status` will reject the promote at the `VaultManager.load`
 * step.
 *
 * The CLI is intentionally narrow — no `--status`, no `--keywords`,
 * no taxonomy mapping. Operators promoted-then-curate: this command
 * lands a faithful copy in the target vault; downstream
 * `lore-memory action='update'` calls in the target vault re-scope
 * or re-tag the row as needed. `--dry-run` previews the audit block
 * without touching the target vault (one source read, no target
 * round-trips).
 */

export const promoteCommand = new Command("promote")
  .description(
    "Copy a memory from the primary vault into a configured promotion target. " +
      "Skips schema drift checks on init (same posture as `lore mine`); " +
      "run `lore status` first to confirm target reachability.",
  )
  .argument("<memoryId>", "Notion page ID of the memory to promote")
  .requiredOption(
    "--to <name>",
    "Name of the promotion target as configured in `.lore.yaml`'s promotionTargets",
  )
  .option(
    "--reason <text>",
    "Optional rationale recorded in the promoted memory's origin audit block",
  )
  .option(
    "--promoter <name>",
    "Override the resolved promoter name (defaults to LORE_USER_NAME → users.me)",
  )
  .option(
    "--dry-run",
    "Preview the audit block and resolved status without writing to the target vault",
  )
  .action(
    async (
      memoryId: string,
      opts: {
        to: string
        reason?: string
        promoter?: string
        dryRun?: boolean
      },
    ) => {
      try {
        const services = await initServices(undefined, { driftCheck: false })
        const topology = buildVaultTopology(services.config)
        const target = topology.promotionTargets.find(
          (entry) => entry.label === opts.to,
        )
        if (!target) {
          const configured =
            topology.promotionTargets.length === 0
              ? "no promotion targets are configured — add a `promotionTargets:` block to .lore.yaml"
              : `configured targets: ${topology.promotionTargets
                  .map((entry) => `"${entry.label}"`)
                  .join(", ")}`
          console.error(
            `Promote failed: no promotion target named "${opts.to}" — ${configured}.`,
          )
          process.exit(1)
          return
        }

        const promoter = await resolvePromoterIdentity(services, opts.promoter)
        if (promoter === null) {
          console.error(
            `Promote failed: no promoter identity available. ` +
              `Set LORE_USER_NAME in your shell, or pass \`--promoter <name>\` ` +
              `directly so the origin audit block records who promoted the row.`,
          )
          process.exit(1)
          return
        }

        const helperServices = {
          client: services.client,
          memories: services.memories,
          primaryVaultPageId: services.config.vault.pageId,
          // The primary vault's literal label in topology rendering is
          // always `Primary` — matches `buildVaultTopology`'s primary
          // label so the audit block matches what `lore status` shows.
          primaryVaultLabel: topology.primary.label,
        }
        const helperInput = {
          sourceMemoryId: memoryId,
          target,
          reason: opts.reason,
          promoter,
          sourceMemoryUrl: notionPageUrl(memoryId),
        }

        if (opts.dryRun) {
          // Dry-run reads + composes the audit block but skips both
          // the target-vault load and the target-vault create. The
          // operator sees exactly what the apply path would write,
          // without the cross-boundary side effect. Cost: one
          // `pages.retrieve` + one `pages.retrieveMarkdown` on the
          // source vault (same as the apply path's source read).
          const preview = await preparePromotion(helperServices, helperInput)
          const reviewSuffix = target.requireReview ? " (awaiting review)" : ""
          console.log(
            `[dry-run] Would promote to ${target.label}: ${preview.source.title || "(untitled)"}${reviewSuffix}`,
          )
          console.log(`[dry-run] Resolved status: ${preview.status}`)
          console.log(`[dry-run] Promoter: ${preview.promoter}`)
          console.log("[dry-run] Audit block preview:")
          for (const line of preview.auditBlock.split("\n")) {
            console.log(`  ${line}`)
          }
          console.log(
            "[dry-run] No target-vault write was issued. Re-run without --dry-run to apply.",
          )
          return
        }

        const result = await promoteMemory(helperServices, helperInput)

        const linkedTitle = terminalLink(
          result.promoted.title || "(untitled)",
          notionPageUrl(result.promoted.id),
        )
        const reviewSuffix = target.requireReview ? " (awaiting review)" : ""
        console.log(`Promoted to ${result.targetVaultLabel}: ${linkedTitle}${reviewSuffix}`)
        console.log(`  Target memory ID: ${result.promoted.id}`)
        console.log(`  Status: ${result.status}`)
        console.log(`  Promoter: ${promoter}`)
        if (opts.reason && opts.reason.trim().length > 0) {
          console.log(`  Reason: ${opts.reason.trim()}`)
        }
      } catch (err) {
        console.error(
          "Promote failed:",
          err instanceof Error ? err.message : err,
        )
        process.exit(1)
      }
    },
  )

async function resolvePromoterIdentity(
  services: LoreServices,
  explicit: string | undefined,
): Promise<string | null> {
  const trimmedExplicit = explicit?.trim()
  if (trimmedExplicit && trimmedExplicit.length > 0) return trimmedExplicit
  const resolved = await services.identity.resolveAuthor()
  return resolved && resolved.trim().length > 0 ? resolved.trim() : null
}
