import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"
import {
  reconcileActiveTasks,
  formatReconcileOutput,
  DEFAULT_RECONCILE_LIMIT,
  DEFAULT_RECONCILE_MIN_SCORE,
  MAX_RECONCILE_LIMIT,
} from "../../core/task-reconcile.js"
import {
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import { parsePositiveDecimalInteger, parseUnitIntervalDecimal } from "../parse.js"

/**
 * Parsed reconcile options after CLI-boundary validation. The action
 * body builds this shape (or a numeric error) before touching services
 * — separating parse-validate from execution lets the unit test exercise
 * the boundary checks without standing up a Notion stub.
 */
export interface ReconcileCliOptions {
  projectName: string | undefined
  minScore: number
  limit: number
}

/**
 * Validate `--min-score` and `--limit` raw string inputs. Default
 * `parseFloat` / `parseInt` silently coerce malformed input
 * (`--min-score 0.5abc` → 0.5, `--limit 3.7` → 3). Shared strict parsers
 * make the boundary loud: a malformed flag fails the parse, the action body
 * surfaces a clear error, and the operator knows to retry. Same shape for
 * over-cap `--limit` so the CLI doesn't silently coerce 9999 → 100 via the
 * orchestrator's clamp without telling the operator they tripped the cap.
 *
 * Returns a discriminated union: `{ ok: true, value }` on success or
 * `{ ok: false, message }` on failure. The action body short-circuits
 * on `ok: false` and the unit test asserts on `message` content.
 */
export function parseReconcileCliOptions(raw: {
  project?: string
  minScore: string
  limit: string
}): { ok: true; value: ReconcileCliOptions } | { ok: false; message: string } {
  const parsedMinScore = parseUnitIntervalDecimal("--min-score", raw.minScore)
  if (!parsedMinScore.ok) return parsedMinScore

  const parsedLimit = parsePositiveDecimalInteger("--limit", raw.limit)
  if (!parsedLimit.ok) return parsedLimit
  if (parsedLimit.value > MAX_RECONCILE_LIMIT) {
    return {
      ok: false,
      message: `--limit must be between 1 and ${MAX_RECONCILE_LIMIT}, got ${parsedLimit.value}`,
    }
  }
  return {
    ok: true,
    value: {
      projectName: raw.project,
      minScore: parsedMinScore.value,
      limit: parsedLimit.value,
    },
  }
}

/**
 * Run the reconcile pass and return the rendered markdown output.
 * Pure-ish helper: takes `services` + parsed options so the unit test can
 * assert project resolution without standing up a CLI process.
 */
export async function runReconcile(
  services: LoreServices,
  opts: ReconcileCliOptions
): Promise<string> {
  let projectId: string | undefined

  const explicitProjectName = validateExplicitProjectScopeName(
    opts.projectName,
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
  }
  if (!projectId && services.context.project) {
    projectId = services.context.project.id
  }

  const today = new Date().toISOString().split("T")[0]!
  const { candidates, activeTasksScanned } = await reconcileActiveTasks(services, {
    projectId,
    minScore: opts.minScore,
    limit: opts.limit,
    today,
  })

  return formatReconcileOutput(candidates, activeTasksScanned, today)
}

const reconcileCommand = new Command("reconcile")
  .description("Scan active tasks for resolution-shaped memory matches")
  .option(
    "-p, --project <name>",
    "Project to scope the scan to (defaults to cwd-resolved project)"
  )
  .option(
    "--min-score <n>",
    `Minimum candidate score (0–1) to surface (default ${DEFAULT_RECONCILE_MIN_SCORE})`,
    String(DEFAULT_RECONCILE_MIN_SCORE)
  )
  .option(
    "-n, --limit <n>",
    `Maximum candidate closures to surface (default ${DEFAULT_RECONCILE_LIMIT}, capped at ${MAX_RECONCILE_LIMIT})`,
    String(DEFAULT_RECONCILE_LIMIT)
  )
  .action(async (opts: { project?: string; minScore: string; limit: string }) => {
    try {
      const parsed = parseReconcileCliOptions(opts)
      if (!parsed.ok) {
        console.error(`Reconcile failed: ${parsed.message}`)
        process.exit(1)
        // Defensive `return` after `process.exit` — same posture as
        // `commands/mine.ts` and `commands/search.ts`. In production
        // `process.exit(1)` actually terminates, so this line is
        // unreachable. Under the shared no-throw `trapProcessExit`
        // mock in `src/cli/test-helpers.ts`, `process.exit(1)` records
        // the code and returns; without the explicit `return` here,
        // execution would fall through to `await initServices()` and
        // the rest of the action body in tests. The `return` also
        // narrows `parsed.ok` to `true` for the body below — TS's
        // own narrowing through `process.exit`'s `never` return is
        // fragile across tsconfig changes.
        return
      }
      const services = await initServices()
      const output = await runReconcile(services, parsed.value)
      console.log(output)
    } catch (err) {
      console.error("Reconcile failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

export const tasksCommand = new Command("tasks")
  .description("Task lifecycle operations")
  .addCommand(reconcileCommand)
