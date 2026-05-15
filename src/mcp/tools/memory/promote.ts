import type { LoreServices } from "../../server.js"
import { toolError } from "../../helpers.js"
import { buildVaultTopology } from "../../../core/topology.js"
import { preparePromotion, promoteMemory } from "../../../core/promote.js"
import { notionPageUrl } from "../../../notion/url.js"
import type { ToolResult } from "./types.js"

export interface PromoteArgs {
  memoryId: string
  targetName: string
  reason?: string
  dryRun?: boolean
}

/**
 * MCP equivalent of `lore promote`. Resolves the named
 * promotion target from `config.promotionTargets`, resolves the
 * promoter identity via the standard `LORE_USER_NAME` → `users.me`
 * chain (NO client-supplied override on this surface — see below),
 * and delegates to the shared `promoteMemory` service helper.
 *
 * **No client-supplied promoter.** The MCP surface is agent-driven;
 * a client-supplied `promoter` string would let any caller forge
 * the `**Promoter:**` line of the cross-vault audit block,
 * defeating the audit gap the topology design exists to close.
 * The promoter is the server-resolved identity exclusively;
 * operators wanting an override use
 * the CLI's `--promoter` flag instead.
 *
 * **`dryRun: true`** matches the CLI's `--dry-run` flag. Returns a
 * preview of the audit block + resolved status without paying any
 * target-vault round-trip. Mis-resolved targets, missing identity,
 * and same-vault rejection all surface BEFORE the source read so a
 * runaway loop cannot burn target-vault quota before discovering
 * its inputs are wrong.
 *
 * Defaults match the CLI for surface parity: targets with
 * `requireReview: true` land the promoted row as `Status: proposed`,
 * the source's status passes through otherwise. The MCP action is
 * the agent-facing equivalent of the CLI; both call into the same
 * helper so the audit-block format, source live-page validation,
 * same-vault rejection, and tags/projectIds drop are byte-stable
 * across surfaces.
 */
export async function handlePromote(
  services: LoreServices,
  args: PromoteArgs
): Promise<ToolResult> {
  try {
    const topology = buildVaultTopology(services.config)
    const target = topology.promotionTargets.find(
      (entry) => entry.label === args.targetName
    )
    if (!target) {
      const configured =
        topology.promotionTargets.length === 0
          ? "no promotion targets are configured — add a `promotionTargets:` block to .lore.yaml"
          : `configured targets: ${topology.promotionTargets
              .map((entry) => `"${entry.label}"`)
              .join(", ")}`
      return toolError(
        new Error(`No promotion target named "${args.targetName}" — ${configured}.`)
      )
    }

    // Server-resolved identity ONLY. See the function docstring for
    // the rationale — agent-supplied promoter strings would let any
    // caller forge the cross-vault audit block's promoter line.
    const resolved = (await services.identity.resolveAuthor())?.trim()
    if (!resolved || resolved.length === 0) {
      return toolError(
        new Error(
          `Cannot promote memory ${args.memoryId}: no promoter identity ` +
            `available. Set \`LORE_USER_NAME\` so the origin audit block ` +
            `can record who promoted the row, or use the CLI's ` +
            `\`lore promote --promoter <name>\` for operator-driven ` +
            `attribution.`
        )
      )
    }
    const promoter = resolved

    const helperServices = {
      client: services.client,
      memories: services.memories,
      primaryVaultPageId: services.config.vault.pageId,
      primaryVaultLabel: topology.primary.label,
    }
    const helperInput = {
      sourceMemoryId: args.memoryId,
      target,
      reason: args.reason,
      promoter,
      sourceMemoryUrl: notionPageUrl(args.memoryId),
    }

    if (args.dryRun === true) {
      // Mirrors the CLI's `--dry-run`: one source read, no target-
      // vault round-trips. Returns the audit-block preview + resolved
      // status so an agent can preview a cross-vault write before
      // committing.
      const preview = await preparePromotion(helperServices, helperInput)
      const reviewSuffix = target.requireReview ? " (awaiting review)" : ""
      const lines = [
        `[dry-run] Would promote memory ${args.memoryId} to ${target.label}${reviewSuffix}.`,
        `[dry-run] Source title: ${preview.source.title || "(untitled)"}`,
        `[dry-run] Resolved status: ${preview.status}`,
        `[dry-run] Promoter: ${promoter}`,
        "[dry-run] Audit block preview:",
        ...preview.auditBlock.split("\n").map((line) => `  ${line}`),
        "[dry-run] No target-vault write was issued. Re-run without dryRun to apply.",
      ]
      return {
        content: [{ type: "text", text: lines.join("\n") }],
      }
    }

    const result = await promoteMemory(helperServices, helperInput)

    const reviewSuffix = target.requireReview ? " (awaiting review)" : ""
    const lines = [
      `Promoted memory ${args.memoryId} to ${result.targetVaultLabel}${reviewSuffix}.`,
      `Target memory: ${result.promoted.title || "(untitled)"} (${result.promoted.id})`,
      `Status: ${result.status}`,
      `Promoter: ${promoter}`,
    ]
    if (args.reason && args.reason.trim().length > 0) {
      lines.push(`Reason: ${args.reason.trim()}`)
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    }
  } catch (err) {
    return toolError(err)
  }
}
