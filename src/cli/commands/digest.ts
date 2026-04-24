import { Command, Option } from "commander"
import { resolve } from "node:path"
import { existsSync } from "node:fs"
import { initServices } from "../../services.js"
import { gatherDigestData, isoDate } from "../../core/digest.js"
import { buildDigestPrompt } from "../../hooks/prompts.js"
import { DIGEST_ALLOWLIST, spawnBackgroundSave } from "../../hooks/background.js"
import { touchDigestMarker } from "../../hooks/digest-marker.js"

/**
 * Resolve the absolute path configured for a project in `.lore.yaml`. When
 * the operator runs `lore digest --project Mail` from outside the Mail
 * subtree, we'd rather spawn the synthesizer inside Mail's configured path
 * so the child's own cwd-based context resolution agrees with the prompt's
 * explicit `projectName`. Falls back to `process.cwd()` when we can't find
 * a safe path (e.g., catch-all projects at `"."` or a stale config entry).
 */
function resolveSpawnCwd(
  configRoot: string,
  projectPath: string | undefined,
): string {
  if (!projectPath) return process.cwd()
  const normalized = projectPath === "." ? "" : projectPath.replace(/^\//, "")
  if (normalized === "") return configRoot
  const absolute = resolve(configRoot, normalized)
  return existsSync(absolute) ? absolute : process.cwd()
}

export const digestCommand = new Command("digest")
  .description("Gather digest data and spawn a background synthesizer")
  .option("-p, --project <name>", "Project to digest (defaults to cwd-resolved project)")
  .addOption(
    new Option("--period <period>", "Time window")
      .choices(["day", "week"])
      .default("week"),
  )
  .option("--since <iso>", "Explicit window start (ISO datetime)")
  .option("--until <iso>", "Explicit window end (ISO datetime)")
  .option("--dry-run", "Print the raw digest data without spawning the synthesizer")
  .action(
    async (opts: {
      project?: string
      period: "day" | "week"
      since?: string
      until?: string
      dryRun?: boolean
    }) => {
      try {
        const services = await initServices()

        let projectId: string | undefined
        let projectLabel: string | null = null
        let projectConfigPath: string | undefined

        if (opts.project) {
          const found = await services.projects.findByName(opts.project)
          if (!found) {
            console.error(`Project "${opts.project}" not found.`)
            process.exit(1)
          }
          projectId = found.id
          projectLabel = found.name
          // Find the matching `.lore.yaml` entry so we can spawn from the
          // project's configured path rather than whatever cwd the operator
          // happens to be in.
          projectConfigPath = services.config.projects?.find(
            (p) => p.name === found.name,
          )?.path
        } else if (services.context.project) {
          projectId = services.context.project.id
          projectLabel = services.context.project.name
          projectConfigPath = services.config.projects?.find(
            (p) => p.name === services.context.project!.name,
          )?.path
        }

        if (!projectLabel) {
          console.error(
            "No project resolved. Pass --project <name> or run from a directory " +
              "inside a configured project path.",
          )
          process.exit(1)
        }

        const digest = await gatherDigestData(services, {
          projectId,
          projectLabel,
          since: opts.since,
          until: opts.until,
          period: opts.period,
        })

        if (opts.dryRun) {
          console.log(digest.raw)
          return
        }

        if (digest.recentMemoryCount === 0) {
          console.log(
            `No activity in window for "${projectLabel}" — skipping digest spawn.`,
          )
          return
        }

        const prompt = buildDigestPrompt(
          digest.raw,
          projectLabel,
          isoDate(new Date()),
          digest.lastDigestDate,
        )

        const spawnCwd = resolveSpawnCwd(services.configRoot, projectConfigPath)
        const lockKey = `digest-${projectLabel.replace(/[^A-Za-z0-9_.-]/g, "_")}`
        const spawned = spawnBackgroundSave(spawnCwd, prompt, lockKey, {
          logLabel: "digest",
          allowedTools: DIGEST_ALLOWLIST,
        })
        if (!spawned) {
          console.error("Failed to spawn digest synthesizer.")
          process.exit(1)
        }

        // Touch the shared marker so the session-end auto-digest path debounces
        // around a freshly-run manual digest — don't re-synthesize at the end
        // of the next session in the same week.
        await touchDigestMarker(services.configRoot, projectLabel)

        console.log(
          `Spawned digest synthesizer for "${projectLabel}" (cwd: ${spawnCwd}).`,
        )
        console.log("The memory will appear in ~60s.")
      } catch (err) {
        console.error("Digest failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    },
  )
