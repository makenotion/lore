import type { LoreServices } from "../../server.js"
import { toolError } from "../../helpers.js"
import { defaultProfileSelector } from "../../../profile/index.js"
import { formatTaskSummary, taskStats, todayUtc } from "../../../core/task.js"
import {
  formatProposedInboxStatus,
  loadProposedInboxStatus,
} from "../../../core/proposed-inbox.js"
import {
  formatExpiringScopedSummary,
  loadExpiringScopedStatus,
} from "../../../core/expiring-scoped.js"
import {
  formatBackgroundFailureStatusObject,
  loadBackgroundFailureStatus,
} from "../../../hooks/background-failure-status.js"
import {
  formatVaultTopologyStatus,
  loadVaultTopologyStatus,
} from "../../../core/topology-status.js"
import { formatWakeUpCoverageReport, loadWakeUpData } from "../../../core/wakeup.js"
import type { ToolResult } from "./types.js"

export async function handleStatus(services: LoreServices): Promise<ToolResult> {
  try {
    const stats = await services.vault.stats()
    const project = services.context.project
    const profileLine = services.profile
      ? `Profile: ${services.profile.name}@${services.profile.version} (${services.profile.source})`
      : `Profile: ${defaultProfileSelector()} (built-in)`

    const lines = [
      `Vault: ${services.context.vault.pageId}`,
      profileLine,
      `Current project: ${project ? `${project.name} (${project.path || "no path"})` : "none (vault-wide scope)"}`,
      "",
      "Database counts:",
      ` Projects: ${stats.projects}`,
      ` Topics: ${stats.topics}`,
      ` Memories: ${stats.memories}`,
      ` Facts: ${stats.facts}`,
    ]

    const topologyLines = formatVaultTopologyStatus(
      await loadVaultTopologyStatus(services)
    )
    if (topologyLines.length > 0) {
      lines.push("", ...topologyLines)
    }

    // Task summary and proposed-memory inbox count.
    // Same `taskStats` / `loadProposedInboxStatus` orchestrators the
    // CLI calls — `formatTaskSummary` and `formatProposedInboxStatus`
    // are the single renderers so the emitted lines are byte-identical
    // between MCP and CLI for the same vault state. The `Kind !=
    // decision` exclusion that defines the inbox is documented at
    // `proposedMemoryFilter()` — single authoritative explanation site.
    const [tasks, proposedInbox, expiringScoped, wakeUp] = await Promise.all([
      taskStats(services.tasks, {
        projectId: project?.id,
        today: todayUtc(),
      }),
      loadProposedInboxStatus(services, { projectId: project?.id }),
      // Surfaces expired/expiring/out-of-context scoped rows for
      // cleanup. Mirrors the CLI `lore status` line so MCP callers
      // (`lore-context action='status'`) get the same triage signal.
      loadExpiringScopedStatus(services, { projectId: project?.id }),
      loadWakeUpData(services, {
        projectId: project?.id,
        includeMemoryContent: false,
        includeCoverage: true,
        cache: services.wakeupCache,
      }),
    ])
    lines.push(...formatTaskSummary(tasks))
    lines.push(...formatProposedInboxStatus(proposedInbox))
    lines.push(...formatExpiringScopedSummary(expiringScoped))
    if (wakeUp.coverage) {
      lines.push(...formatWakeUpCoverageReport(wakeUp.coverage))
    }

    const backgroundFailureStatus = formatBackgroundFailureStatusObject(
      await loadBackgroundFailureStatus(services.configRoot)
    )
    lines.push(
      "",
      "Background hooks:",
      "```json",
      JSON.stringify(backgroundFailureStatus, null, 2),
      "```"
    )

    if (services.config.projects?.length) {
      lines.push("", "Configured projects:")
      for (const p of services.config.projects) {
        lines.push(` - ${p.name} (${p.path})`)
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] }
  } catch (err) {
    return toolError(err)
  }
}
