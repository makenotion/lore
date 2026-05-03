import { Command } from "commander"
import { initServices } from "../../services.js"
import {
  runEvalSuite,
  type EvalRunArtifact,
  type RunEvalOptions,
} from "../../eval/runner.js"
import {
  buildEvalBaselineSnapshot,
  compareToEvalBaseline,
  formatBaselineDriftReport,
  readEvalBaselineSnapshot,
  writeEvalBaselineSnapshot,
} from "../../eval/baseline.js"
import { resolveProjectByName } from "../../core/project-scope.js"
import { EVAL_RUNNERS, type EvalRunner } from "../../eval/schema.js"
import { parsePositiveDecimalInteger, type CliParseResult } from "../parse.js"

export interface EvalRunCliOptions {
  /**
   * Selected runner mode. `undefined` means the CLI did not specify
   * `--runner` and the eval suite YAML's `runner` field should win.
   */
  runner?: EvalRunner
  trials?: number
  outPath?: string
  minLift?: number
  maxHarm?: number
  baselinePath?: string
  projectName?: string
  json: boolean
}

export function parseEvalRunCliOptions(raw: {
  runner?: string
  trials?: string
  out?: string
  minLift?: string
  maxHarm?: string
  baseline?: string
  project?: string
  json?: boolean
}): CliParseResult<EvalRunCliOptions> {
  // When `raw.runner` is omitted on the CLI, leave `runner` undefined so
  // the suite YAML's `runner` field wins inside `runEvalSuite`. Default
  // only applies when neither CLI nor YAML specifies one (handled in
  // runner.ts via `loaded.suite.runner`'s schema default).
  const runner = raw.runner === undefined ? undefined : raw.runner
  if (runner !== undefined && !isEvalRunner(runner)) {
    return {
      ok: false,
      message: `--runner must be one of: ${EVAL_RUNNERS.join(", ")}, got "${runner}"`,
    }
  }

  let trials: number | undefined
  if (raw.trials !== undefined) {
    const parsedTrials = parsePositiveDecimalInteger("--trials", raw.trials)
    if (!parsedTrials.ok) return parsedTrials
    if (parsedTrials.value !== 1) {
      const modeLabel = runner !== undefined ? `${runner} mode` : "this runner"
      return {
        ok: false,
        message: `--trials must be 1 for ${modeLabel}, got ${parsedTrials.value}`,
      }
    }
    trials = parsedTrials.value
  }

  const minLift = parseOptionalUnitInterval("--min-lift", raw.minLift)
  if (!minLift.ok) return minLift

  const maxHarm = parseOptionalUnitInterval("--max-harm", raw.maxHarm)
  if (!maxHarm.ok) return maxHarm

  if (runner === "notion" && (raw.project === undefined || raw.project.length === 0)) {
    return {
      ok: false,
      message:
        '--project is required when --runner notion is set; the live vault has many projects.',
    }
  }

  return {
    ok: true,
    value: {
      runner,
      trials,
      outPath: raw.out,
      minLift: minLift.value,
      maxHarm: maxHarm.value,
      baselinePath: raw.baseline,
      projectName: raw.project,
      json: !!raw.json,
    },
  }
}

export function collectEvalThresholdFailures(
  artifact: EvalRunArtifact,
  thresholds: Pick<EvalRunCliOptions, "minLift" | "maxHarm">
): string[] {
  const failures: string[] = []
  const memoryLift = artifact.summary.retrieval.memoryLift
  if (thresholds.minLift !== undefined) {
    if (memoryLift === null) {
      failures.push(`Memory lift is unavailable; expected >= ${thresholds.minLift}.`)
    } else if (memoryLift < thresholds.minLift) {
      failures.push(`Memory lift ${memoryLift} is below ${thresholds.minLift}.`)
    }
  }

  const memoryHarm = artifact.summary.retrieval.memoryHarm
  if (thresholds.maxHarm !== undefined) {
    if (memoryHarm === null) {
      failures.push(`Memory harm is unavailable; expected <= ${thresholds.maxHarm}.`)
    } else if (memoryHarm > thresholds.maxHarm) {
      failures.push(`Memory harm ${memoryHarm} exceeds ${thresholds.maxHarm}.`)
    }
  }

  return failures
}

function isEvalRunner(value: string): value is EvalRunner {
  return (EVAL_RUNNERS as readonly string[]).includes(value)
}

function parseOptionalUnitInterval(
  flag: string,
  raw: string | undefined
): CliParseResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (!/^(?:0|1|0?\.[0-9]+|1\.0+)$/.test(raw)) {
    return {
      ok: false,
      message: `${flag} must be a decimal between 0 and 1, got "${raw}"`,
    }
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return {
      ok: false,
      message: `${flag} must be a decimal between 0 and 1, got "${raw}"`,
    }
  }
  return { ok: true, value: n }
}

/**
 * Vault-isolation guard. Notion-mode reads are technically read-only,
 * but the docs target nightly CI: a misconfigured CI job pointing at a
 * production vault would still hammer rate limits and surface misleading
 * "drift" against fixture-shaped expectations. Reject project names
 * that don't smell like a sandbox unless the operator explicitly opts
 * in via env var.
 *
 * The match uses **word-boundary** regex (not substring) so
 * production names that incidentally embed `eval` / `test` / `sandbox`
 * substrings (e.g., "Evaluations Q1") don't slip through as
 * sandboxes — and a project named "Greatest hits" is no longer falsely
 * accepted because of `eval` matching `evaluations` `greate`. The
 * accepted markers are the conventional internal sandbox names.
 *
 * @throws when the project name lacks a sandbox marker and the
 *   `LORE_EVAL_NOTION_ALLOW_PRODUCTION` env var is unset.
 */
const SANDBOX_NAME_MARKERS = /\b(?:sandbox|eval|test|scratch|staging|dev|playground)\b/i

export function assertSandboxProjectName(projectName: string): void {
  if (SANDBOX_NAME_MARKERS.test(projectName)) return
  const allowProd = process.env["LORE_EVAL_NOTION_ALLOW_PRODUCTION"]
  if (allowProd === "1" || allowProd === "true") return
  throw new Error(
    `Project "${projectName}" does not look like a sandbox (no word-bounded match for sandbox/eval/test/scratch/staging/dev/playground). ` +
      `Set LORE_EVAL_NOTION_ALLOW_PRODUCTION=1 to confirm pointing notion-mode at this project on purpose.`
  )
}

/**
 * Build the `notionServices` factory from a `--project` value. Returns
 * undefined when no project name was supplied. The factory is wired
 * unconditionally whenever `--project` is set so a YAML-declared
 * `runner: notion` suite (with `--project` on the CLI but no
 * `--runner notion` flag) gets the factory it needs. `runEvalSuite`
 * ignores the factory when the resolved runner is `retrieval`, so the
 * sandbox-name check is moved INTO the async factory body — that way
 * `lore eval baseline suite.yaml --project Mail` for a retrieval-mode
 * suite does not surprise the operator with a sandbox-name throw on a
 * factory that's never invoked.
 */
export function buildNotionServicesFactory(
  projectName: string | undefined
): RunEvalOptions["notionServices"] | undefined {
  if (!projectName) return undefined
  return async () => {
    // Sandbox-name guard runs at factory invocation time so it only
    // fires when the resolved runner actually needs notion services.
    assertSandboxProjectName(projectName)
    const services = await initServices(undefined, { driftCheck: false })
    const project = await resolveProjectByName(
      services.projects,
      projectName,
      "eval --project"
    )
    return { services, projectId: project.id }
  }
}

export const evalCommand = new Command("eval").description("Run Lore evaluation suites")

evalCommand.addCommand(
  new Command("run")
    .description("Run a local eval suite and emit a JSON artifact")
    .argument("<suite>", "Path to an eval suite YAML file")
    .option(
      "--runner <mode>",
      "Runner mode (retrieval|notion); defaults to the suite YAML's `runner` field, or `retrieval` if absent"
    )
    .option("--trials <n>", "Trial count; retrieval mode requires 1")
    .option("--out <path>", "Write the JSON artifact to a specific path")
    .option("--min-lift <n>", "Fail when memory lift is below this 0..1 threshold")
    .option("--max-harm <n>", "Fail when memory harm is above this 0..1 threshold")
    .option(
      "--baseline <path>",
      "Compare results against a committed baseline snapshot and fail on regression"
    )
    .option(
      "--project <name>",
      "Sandbox project to scope retrieval against (required for --runner notion)"
    )
    .option("--json", "Print the full JSON artifact to stdout")
    .action(
      async (
        suite: string,
        opts: {
          runner?: string
          trials?: string
          out?: string
          minLift?: string
          maxHarm?: string
          baseline?: string
          project?: string
          json?: boolean
        }
      ) => {
        const parsed = parseEvalRunCliOptions(opts)
        if (!parsed.ok) {
          console.error(`Eval failed: ${parsed.message}`)
          process.exit(1)
          return
        }

        try {
          const runOptions: RunEvalOptions = {
            runner: parsed.value.runner,
            trials: parsed.value.trials,
            outPath: parsed.value.outPath,
            notionServices: buildNotionServicesFactory(parsed.value.projectName),
          }
          const { artifact, outPath } = await runEvalSuite(suite, runOptions)
          const thresholdFailures = collectEvalThresholdFailures(artifact, {
            minLift: parsed.value.minLift,
            maxHarm: parsed.value.maxHarm,
          })

          let driftReportText: string | null = null
          let driftRegressed = false
          if (parsed.value.baselinePath) {
            const baseline = await readEvalBaselineSnapshot(
              parsed.value.baselinePath
            )
            const drift = compareToEvalBaseline({
              artifact,
              baseline,
              baselinePath: parsed.value.baselinePath,
            })
            driftReportText = formatBaselineDriftReport(drift)
            driftRegressed = drift.regressed
          }

          if (parsed.value.json) {
            console.log(JSON.stringify(artifact, null, 2))
            for (const failure of thresholdFailures) {
              console.error(`Eval threshold failed: ${failure}`)
            }
            if (driftReportText) {
              console.error(driftReportText)
            }
            if (
              artifact.summary.failedResults > 0 ||
              thresholdFailures.length > 0 ||
              driftRegressed
            ) {
              process.exit(1)
            }
            return
          }

          const failed = artifact.summary.failedResults
          const status = failed === 0 ? "passed" : "failed"
          console.log(
            `Eval ${status}: ${artifact.summary.passedResults}/${artifact.summary.totalResults} checks passed.`
          )
          console.log(`Artifact: ${outPath}`)
          if (artifact.runner.requestedTrials !== artifact.runner.executedTrials) {
            console.log(
              `Trials: requested ${artifact.runner.requestedTrials}, executed ${artifact.runner.executedTrials} for deterministic retrieval mode.`
            )
          }
          if (artifact.summary.retrieval.memoryLift !== null) {
            console.log(`Memory lift: ${artifact.summary.retrieval.memoryLift}`)
          }
          if (artifact.summary.retrieval.memoryHarm !== null) {
            console.log(`Memory harm: ${artifact.summary.retrieval.memoryHarm}`)
          }
          for (const failure of thresholdFailures) {
            console.error(`Eval threshold failed: ${failure}`)
          }
          if (driftReportText) {
            console.log(driftReportText)
          }
          if (
            failed > 0 ||
            thresholdFailures.length > 0 ||
            driftRegressed
          ) {
            process.exit(1)
          }
        } catch (err) {
          console.error("Eval failed:", err instanceof Error ? err.message : err)
          process.exit(1)
        }
      }
    )
)

evalCommand.addCommand(
  new Command("baseline")
    .description(
      "Run an eval suite and write a comparison-stable baseline snapshot under evals/baselines/"
    )
    .argument("<suite>", "Path to an eval suite YAML file")
    .requiredOption(
      "--out <path>",
      "Write the baseline snapshot to this path (typically evals/baselines/<suite>.json)"
    )
    .option("--runner <mode>", "Runner mode (retrieval|notion)")
    .option(
      "--project <name>",
      "Sandbox project to scope retrieval against (required for --runner notion)"
    )
    .option("--notes <text>", "Optional human-readable annotation")
    .action(
      async (
        suite: string,
        opts: {
          out: string
          notes?: string
          runner?: string
          project?: string
        }
      ) => {
        const parsed = parseEvalRunCliOptions({
          runner: opts.runner,
          project: opts.project,
        })
        if (!parsed.ok) {
          console.error(`Eval baseline failed: ${parsed.message}`)
          process.exit(1)
          return
        }

        try {
          const runOptions: RunEvalOptions = {
            runner: parsed.value.runner,
            notionServices: buildNotionServicesFactory(parsed.value.projectName),
          }
          const { artifact } = await runEvalSuite(suite, runOptions)
          const snapshot = buildEvalBaselineSnapshot(artifact, {
            notes: opts.notes,
          })
          await writeEvalBaselineSnapshot(opts.out, snapshot)
          console.log(`Baseline written: ${opts.out} (runner=${snapshot.runner})`)
          console.log(
            `Captured ${snapshot.summary.totalResults} results across ${snapshot.summary.tasks} tasks.`
          )
        } catch (err) {
          console.error(
            "Eval baseline failed:",
            err instanceof Error ? err.message : err
          )
          process.exit(1)
        }
      }
    )
)
