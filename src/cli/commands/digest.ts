import { Command, Option } from "commander"
import { resolve } from "node:path"
import { existsSync } from "node:fs"
import { initServices } from "../../services.js"
import { gatherDigestData, isoDate } from "../../core/digest.js"
import {
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import { buildDigestPrompt } from "../../hooks/prompts.js"
import {
  DIGEST_ALLOWLIST,
  isBenignRace,
  spawnBackgroundSave,
} from "../../hooks/background.js"
import { mergeHookDefaults } from "../../hooks/config.js"
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
  warn: (msg: string) => void = (msg) => console.error(msg)
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
      `Spawning from ${process.cwd()} instead — child context resolution may diverge.`
  )
  return process.cwd()
}

export const digestCommand = new Command("digest")
  .description("Gather digest data and spawn a background synthesizer")
  .option("-p, --project <name>", "Project to digest (defaults to cwd-resolved project)")
  .addOption(
    new Option("--period <period>", "Time window")
      .choices(["day", "week"])
      .default("week")
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

        const explicitProjectName = validateExplicitProjectScopeName(
          opts.project,
          "--project",
          {
            listHint: "run `lore status projects` to list configured projects",
          }
        )
        if (explicitProjectName !== undefined) {
          const found = await resolveProjectScopeName(
            services.projects,
            explicitProjectName,
            "--project",
            {
              listHint: "run `lore status projects` to list configured projects",
            }
          )
          projectId = found.id
          projectLabel = found.name
          // Find the matching `.lore.yaml` entry so we can spawn from the
          // project's configured path rather than whatever cwd the operator
          // happens to be in.
          projectConfigPath = services.config.projects?.find(
            (p) => p.name === found.name
          )?.path
        } else if (services.context.project) {
          projectId = services.context.project.id
          projectLabel = services.context.project.name
          projectConfigPath = services.config.projects?.find(
            (p) => p.name === services.context.project!.name
          )?.path
        }

        if (!projectLabel) {
          console.error(
            "No project resolved. Pass --project <name> or run from a directory " +
              "inside a configured project path."
          )
          process.exit(1)
          // Defensive `return` after `process.exit` — same posture as
          // `commands/mine.ts` and `commands/search.ts`. In production
          // `process.exit(1)` actually terminates, so this line is
          // unreachable. Under the shared no-throw `trapProcessExit`
          // mock in `src/cli/test-helpers.ts`, execution continues
          // after `process.exit(1)` records the code; without the
          // explicit `return` here, `gatherDigestData(... projectLabel)`
          // would run with a `null` projectLabel and corrupt the
          // test bed.
          return
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
            `No activity in window for "${projectLabel}" — skipping digest spawn.`
          )
          return
        }

        const prompt = buildDigestPrompt(
          digest.raw,
          projectLabel,
          isoDate(new Date()),
          digest.lastDigestDate
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
        const hookConfig = mergeHookDefaults(services.config.hooks)
        const result = spawnBackgroundSave(spawnCwd, prompt, lockKey, {
          logLabel: "digest",
          allowedTools: DIGEST_ALLOWLIST,
          agent: hookConfig.backgroundAgent,
          // Apply the ntn-source env partition (issue #475). `services`
          // is the same in-process bundle whose `resolveAuth` produced
          // `authSource`, so the synthesizer's env matches the source
          // the foreground gather call already authenticated against.
          authSource: services.authSource,
        })
        if (result.kind !== "spawned") {
          // Benign races (lock-held, cap-hit, race-lost) mean a peer is
          // already producing the digest; reporting failure would mislead
          // the operator. Surface that distinctly, but still non-zero exit
          // for genuine failures so scripts can branch on it.
          if (isBenignRace(result)) {
            console.log(
              `Digest already in flight for "${projectLabel}" — skipping spawn.`
            )
            return
          }
          if (result.kind === "lock-path-too-long") {
            // Distinct from "Digest already in flight": there is no peer
            // doing the work. Pointing the operator at LORE_HOOK_STATE_DIR
            // is the actionable knob (see issue #485).
            console.error(
              `Failed to spawn digest synthesizer: lock path too long (${result.code}). ` +
                `Shorten LORE_HOOK_STATE_DIR.`
            )
            process.exit(1)
            // Defensive `return` so the no-throw `trapProcessExit`
            // mock in `src/cli/test-helpers.ts` doesn't fall through
            // to the generic `Failed to spawn digest synthesizer.`
            // line below and stack a misleading message on top of
            // the actionable lock-path-too-long diagnostic.
            // Production `process.exit(1)` actually terminates, so
            // this line is unreachable there.
            return
          }
          console.error("Failed to spawn digest synthesizer.")
          process.exit(1)
          // Defensive `return` after `process.exit` — same posture as
          // `commands/mine.ts` and `commands/search.ts`. In production
          // `process.exit(1)` actually terminates, so this line is
          // unreachable. Under the shared no-throw `trapProcessExit`
          // mock, execution continues after `process.exit(1)` records
          // the code; without the explicit `return` here, the
          // marker-touch call below would run despite the failed
          // spawn and corrupt the test bed.
          return
        }

        // Touch the shared marker so the Stop-triggered auto-digest path
        // debounces around a freshly-run manual digest — don't
        // re-synthesize on the next Stop hook in the same week.
        await touchDigestMarker(services.configRoot, projectLabel)

        console.log(
          `Spawned digest synthesizer for "${projectLabel}" (cwd: ${spawnCwd}).`
        )
        console.log("The memory will appear in ~60s.")
      } catch (err) {
        console.error("Digest failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )
