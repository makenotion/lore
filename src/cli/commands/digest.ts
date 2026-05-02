import { Command, Option } from "commander"
import { resolve } from "node:path"
import { existsSync } from "node:fs"
import { initServices } from "../../services.js"
import { gatherDigestData, isoDate } from "../../core/digest.js"
import { buildDigestPrompt } from "../../hooks/prompts.js"
import {
  DIGEST_ALLOWLIST,
  isBenignRace,
  spawnBackgroundSave,
} from "../../hooks/background.js"
import { touchDigestMarker } from "../../hooks/digest-marker.js"
import { safeFilenameSegment } from "../../hooks/marker-key.js"

/**
 * Resolve the absolute path configured for a project in `.lore.yaml`. When
 * the operator runs `lore digest --project Mail` from outside the Mail
 * subtree, we'd rather spawn the synthesizer inside Mail's configured path
 * so the child's own cwd-based context resolution agrees with the prompt's
 * explicit `projectName`. Falls back to `process.cwd()` when we can't find
 * a safe path (e.g., catch-all projects at `"."` or a stale config entry).
 *
 * Exported only for testing the path-resolution contract.
 */
export function resolveSpawnCwd(
  configRoot: string,
  projectPath: string | undefined,
  warn: (msg: string) => void = (msg) => console.error(msg),
): string {
  if (!projectPath) return process.cwd()
  const normalized = projectPath === "." ? "" : projectPath.replace(/^\//, "")
  if (normalized === "") return configRoot
  const absolute = resolve(configRoot, normalized)
  if (existsSync(absolute)) return absolute
  // Stale .lore.yaml entry — the configured project path doesn't exist on
  // disk anymore. Surface the misconfig instead of silently falling back,
  // because the synthesizer's own cwd-based project resolution will then
  // diverge from the prompt's explicit projectName.
  warn(
    `Warning: project path "${projectPath}" does not exist relative to ${configRoot}. ` +
      `Spawning from ${process.cwd()} instead — child context resolution may diverge.`,
  )
  return process.cwd()
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
        // Routes through `safeFilenameSegment` for the same reason
        // `digest-scheduler.ts` does — one shared sanitization +
        // length-cap policy across every hook-state filename builder
        // (see `src/hooks/marker-key.ts`). Two parallel `digest-` lock
        // builders inlining the regex would drift the moment one is
        // tweaked; this CLI surface and the auto-digest scheduler must
        // produce byte-identical lock keys for the same `projectLabel`
        // so a manual `lore digest` and a Stop-fired auto-digest race
        // through the same `MAX_CONCURRENT_SAVES` gate.
        const lockKey = `digest-${safeFilenameSegment(projectLabel)}`
        const result = spawnBackgroundSave(spawnCwd, prompt, lockKey, {
          logLabel: "digest",
          allowedTools: DIGEST_ALLOWLIST,
        })
        if (result.kind !== "spawned") {
          // Benign races (lock-held, cap-hit, race-lost) mean a peer is
          // already producing the digest; reporting failure would mislead
          // the operator. Surface that distinctly, but still non-zero exit
          // for genuine failures so scripts can branch on it.
          if (isBenignRace(result)) {
            console.log(
              `Digest already in flight for "${projectLabel}" — skipping spawn.`,
            )
            return
          }
          console.error("Failed to spawn digest synthesizer.")
          process.exit(1)
        }

        // Touch the shared marker so the Stop-triggered auto-digest path
        // debounces around a freshly-run manual digest — don't
        // re-synthesize on the next Stop hook in the same week.
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
