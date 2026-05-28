import { readFile } from "node:fs/promises"
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
import {
  isLongitudinalTaskArtifact,
  runTaskEvalSuite,
  type AnyTaskEvalArtifact,
  type LongitudinalTaskArtifact,
  type LongitudinalTaskCondition,
  type LongitudinalScenarioSampleRequest,
  type LongitudinalScenarioDifficulty,
  type TaskEvalProgressEvent,
} from "../../eval/task-runner.js"
import { buildLongitudinalBenchmarkPlan } from "../../eval/longitudinal-plan.js"
import { resolveProjectByName } from "../../core/project-scope.js"
import { EVAL_RUNNERS, peekSuiteRunner, type EvalRunner } from "../../eval/schema.js"
import {
  EVAL_VAULT_REGISTRY_PATH,
  findEvalVault,
  loadEvalVaultRegistry,
  renderEvalVaultEnv,
  renderEvalVaultLoreConfig,
  type EvalVault,
} from "../../eval/vaults.js"
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
  costKillSwitchUsd?: number
  difficulty?: LongitudinalScenarioDifficulty
  sample?: LongitudinalScenarioSampleRequest
  scenarioIds?: string[]
  conditions?: LongitudinalTaskCondition[]
  parallelism?: number
  /**
   * Prefix slice for sample runs. Bench-only — rejected on every
   * other runner mode. Refuses to land when `--out` writes under an
   * `evals/baselines/` directory so a smoke run cannot accidentally
   * baseline.
   */
  limit?: number
  json: boolean
}

export interface EvalRunRawCliOptions {
  runner?: string
  trials?: string
  out?: string
  minLift?: string
  maxHarm?: string
  baseline?: string
  project?: string
  costKillSwitchUsd?: string
  difficulty?: string
  sample?: string
  sampleSeed?: string
  scenarioId?: string[]
  condition?: string[]
  parallel?: string
  limit?: string
  json?: boolean
}

export function parseEvalRunCliOptions(
  raw: EvalRunRawCliOptions
): CliParseResult<EvalRunCliOptions> {
  // When `raw.runner` is omitted on the CLI, leave `runner` undefined so
  // the suite YAML's `runner` field wins inside `runEvalSuite`. Default
  // only applies when neither CLI nor YAML specifies one (handled in
  // runner.ts via `loaded.suite.runner`'s schema default).
  if (raw.runner !== undefined && !isEvalRunner(raw.runner)) {
    return {
      ok: false,
      message: `--runner must be one of: ${EVAL_RUNNERS.join(", ")}, got "${raw.runner}"`,
    }
  }
  const runner = raw.runner

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

  const compatibility = validateEvalRunRunnerCompatibility(runner, raw)
  if (!compatibility.ok) return compatibility

  let limit: number | undefined
  if (raw.limit !== undefined) {
    // Bench-only gate is enforced AFTER `peekSuiteRunner` resolves
    // the effective runner in the action handler — a YAML-declared
    // `runner: bench` should accept `--limit` even when the CLI
    // flag is omitted. Here we only validate the integer shape.
    const parsedLimit = parsePositiveDecimalInteger("--limit", raw.limit)
    if (!parsedLimit.ok) return parsedLimit
    limit = parsedLimit.value
  }

  const costKillSwitchUsd = parseOptionalPositiveNumber(
    "--cost-kill-switch-usd",
    raw.costKillSwitchUsd
  )
  if (!costKillSwitchUsd.ok) return costKillSwitchUsd
  if (costKillSwitchUsd.value !== undefined && costKillSwitchUsd.value <= 0) {
    return { ok: false, message: "--cost-kill-switch-usd must be greater than 0." }
  }

  const difficulty = parseOptionalLongitudinalDifficulty(raw.difficulty)
  if (!difficulty.ok) return difficulty

  const sample = parseOptionalLongitudinalSample(raw.sample, raw.sampleSeed)
  if (!sample.ok) return sample
  if (
    sample.value !== undefined &&
    (difficulty.value !== undefined || (raw.scenarioId?.length ?? 0) > 0)
  ) {
    return {
      ok: false,
      message: "--sample cannot be combined with --difficulty or --scenario-id.",
    }
  }

  const parallelism = parseOptionalPositiveInteger("--parallel", raw.parallel)
  if (!parallelism.ok) return parallelism
  const conditions = parseOptionalLongitudinalConditions(raw.condition)
  if (!conditions.ok) return conditions

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
      costKillSwitchUsd: costKillSwitchUsd.value,
      difficulty: difficulty.value,
      sample: sample.value,
      scenarioIds: raw.scenarioId,
      conditions: conditions.value,
      parallelism: parallelism.value,
      limit,
      json: !!raw.json,
    },
  }
}

export function validateEvalRunRunnerCompatibility(
  runner: EvalRunner | undefined,
  raw: Pick<
    EvalRunRawCliOptions,
    "baseline" | "minLift" | "maxHarm" | "project" | "condition"
  >
): CliParseResult<void> {
  if (runner === "notion" && (raw.project === undefined || raw.project.length === 0)) {
    return {
      ok: false,
      message:
        "--project is required when --runner notion is set; the live vault has many projects.",
    }
  }

  if (runner === "task") {
    // Task mode short-circuits to runTaskEvalSuite and does not consume
    // any of these flags. Silently dropping them would let an operator
    // wire `--baseline` into a CI gate that never gates anything; reject
    // up front so the misconfiguration is loud.
    const taskIncompatible: Array<{ flag: string; raw: string | undefined }> = [
      { flag: "--baseline", raw: raw.baseline },
      { flag: "--min-lift", raw: raw.minLift },
      { flag: "--max-harm", raw: raw.maxHarm },
      { flag: "--project", raw: raw.project },
    ]
    for (const { flag, raw: value } of taskIncompatible) {
      if (value !== undefined) {
        return {
          ok: false,
          message: `${flag} is not supported with --runner task; task-mode artifacts are scored by deterministic verifiers, not retrieval metrics.`,
        }
      }
    }
  }

  if (runner === "bench") {
    // Bench mode has its own baseline shape (`bench-baseline.ts`) and
    // a single judge-driven correctness signal — the retrieval lift /
    // harm thresholds and the per-vault project scope don't apply.
    const benchIncompatible: Array<{ flag: string; raw: string | undefined }> = [
      { flag: "--min-lift", raw: raw.minLift },
      { flag: "--max-harm", raw: raw.maxHarm },
      { flag: "--project", raw: raw.project },
    ]
    for (const { flag, raw: value } of benchIncompatible) {
      if (value !== undefined) {
        return {
          ok: false,
          message: `${flag} is not supported with --runner bench; bench drift gating runs through --baseline against the bench-specific snapshot.`,
        }
      }
    }
  }

  if (runner === "profile") {
    const profileIncompatible: Array<{ flag: string; raw: string | undefined }> = [
      { flag: "--baseline", raw: raw.baseline },
      { flag: "--min-lift", raw: raw.minLift },
      { flag: "--max-harm", raw: raw.maxHarm },
      { flag: "--project", raw: raw.project },
    ]
    for (const { flag, raw: value } of profileIncompatible) {
      if (value !== undefined) {
        return {
          ok: false,
          message: `${flag} is not supported with --runner profile; profile suites declare their taxonomy thresholds in YAML.`,
        }
      }
    }
  }

  return { ok: true, value: undefined }
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

export function hasLongitudinalTaskGateFailures(
  artifact: LongitudinalTaskArtifact
): boolean {
  if (artifact.termination) return true
  const fullLoop = artifact.summary.conditions["lore-full-loop"]
  if (fullLoop.trials > 0) return fullLoop.failed > 0
  const seededLore = artifact.summary.conditions["seeded-lore"]
  if (seededLore && seededLore.trials > 0) return seededLore.failed > 0
  return artifact.summary.failedTrials > 0
}

function isEvalRunner(value: string): value is EvalRunner {
  return (EVAL_RUNNERS as readonly string[]).includes(value)
}

/**
 * Reject `--runner task` for the `eval baseline` subcommand. Task-mode
 * artifacts are scored by deterministic verifiers, not retrieval
 * metrics, so a baseline snapshot has nothing to compare. Without this
 * gate, `eval baseline ... --runner task` falls through to
 * `runEvalSuite` and surfaces a retrieval-suite Zod error — useless to
 * the operator. Extracted for unit testing the contract; the action
 * body just propagates the message.
 */
export function validateBaselineRunnerSupport(
  runner: EvalRunner | undefined
): CliParseResult<void> {
  if (runner === "task") {
    return {
      ok: false,
      message:
        "--runner task is not supported by the baseline subcommand. Task-mode artifacts are scored by deterministic verifiers, not retrieval metrics, so baseline comparisons do not apply.",
    }
  }
  if (runner === "profile") {
    return {
      ok: false,
      message:
        "--runner profile is not supported by the baseline subcommand. Profile-mode artifacts are deterministic threshold checks, so baseline comparisons do not apply.",
    }
  }
  return { ok: true, value: undefined }
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
 * sandboxes — and a project named "Greatest hits" does not falsely
 * accept because of `eval` matching `evaluations` `greate`. The
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
 * `lore eval baseline suite.yaml --project Widget` for a retrieval-mode
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

function parseOptionalPositiveNumber(
  flag: string,
  raw: string | undefined
): CliParseResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/u.test(raw)) {
    return { ok: false, message: `${flag} must be a non-negative decimal, got "${raw}"` }
  }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) {
    return { ok: false, message: `${flag} must be a non-negative decimal, got "${raw}"` }
  }
  return { ok: true, value: n }
}

function parseOptionalPositiveInteger(
  flag: string,
  raw: string | undefined
): CliParseResult<number | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  const parsed = parsePositiveDecimalInteger(flag, raw)
  if (!parsed.ok) return parsed
  return { ok: true, value: parsed.value }
}

function parseOptionalLongitudinalDifficulty(
  raw: string | undefined
): CliParseResult<LongitudinalScenarioDifficulty | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === "easy" || raw === "medium" || raw === "hard") {
    return { ok: true, value: raw }
  }
  return {
    ok: false,
    message: `--difficulty must be one of: easy, medium, hard; got "${raw}"`,
  }
}

function parseOptionalLongitudinalConditions(
  raw: string[] | undefined
): CliParseResult<LongitudinalTaskCondition[] | undefined> {
  if (raw === undefined || raw.length === 0) return { ok: true, value: undefined }
  const valid = new Set(["no-memory", "seeded-lore", "lore-full-loop"])
  const seen = new Set<string>()
  const conditions: LongitudinalTaskCondition[] = []
  for (const condition of raw) {
    if (!valid.has(condition)) {
      return {
        ok: false,
        message:
          '--condition must be one of: no-memory, seeded-lore, lore-full-loop; got "' +
          condition +
          '"',
      }
    }
    if (seen.has(condition)) {
      return { ok: false, message: `--condition includes duplicate ${condition}.` }
    }
    seen.add(condition)
    conditions.push(condition as LongitudinalTaskCondition)
  }
  return { ok: true, value: conditions }
}

function parseOptionalLongitudinalSample(
  raw: string | undefined,
  seed: string | undefined
): CliParseResult<LongitudinalScenarioSampleRequest | undefined> {
  if (raw === undefined) {
    if (seed !== undefined) {
      return { ok: false, message: "--sample-seed requires --sample." }
    }
    return { ok: true, value: undefined }
  }
  const counts: Partial<Record<LongitudinalScenarioDifficulty, number>> = {}
  for (const part of raw.split(",")) {
    const trimmed = part.trim()
    if (trimmed.length === 0) {
      return {
        ok: false,
        message: `--sample entries must be difficulty=count pairs, got "${raw}"`,
      }
    }
    const [difficulty, count, extra] = trimmed.split("=")
    if (
      extra !== undefined ||
      (difficulty !== "easy" && difficulty !== "medium" && difficulty !== "hard")
    ) {
      return {
        ok: false,
        message: `--sample entries must use easy, medium, or hard counts; got "${trimmed}"`,
      }
    }
    if (counts[difficulty] !== undefined) {
      return {
        ok: false,
        message: `--sample includes duplicate ${difficulty} count.`,
      }
    }
    const parsed = parsePositiveDecimalInteger(`--sample ${difficulty}`, count ?? "")
    if (!parsed.ok) return parsed
    counts[difficulty] = parsed.value
  }
  return {
    ok: true,
    value: {
      seed: seed ?? "default",
      counts,
    },
  }
}

function parseLongitudinalToCondition(
  raw: string | undefined
): CliParseResult<Exclude<LongitudinalTaskCondition, "no-memory"> | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === "seeded-lore" || raw === "lore-full-loop") {
    return { ok: true, value: raw }
  }
  return {
    ok: false,
    message:
      '--to-condition must be one of: seeded-lore, lore-full-loop; got "' + raw + '"',
  }
}

function formatPercentagePoints(value: number | null): string {
  if (value === null) return "n/a"
  return `${(value * 100).toFixed(1)} pp`
}

function formatPercent(value: number | null): string {
  if (value === null) return "n/a"
  return `${(value * 100).toFixed(1)}%`
}

function formatUsd(value: number | null): string {
  if (value === null) return "n/a"
  return `$${value.toFixed(2)}`
}

function formatSignedNumber(value: number | null): string {
  if (value === null) return "n/a"
  const rounded = Math.round(value)
  return `${rounded >= 0 ? "+" : ""}${rounded.toLocaleString()}`
}

function formatSignedPercent(value: number | null): string {
  if (value === null) return "n/a"
  const percent = value * 100
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`
}

function formatSignedMs(value: number | null): string {
  if (value === null) return "n/a"
  const rounded = Math.round(value)
  return `${rounded >= 0 ? "+" : ""}${rounded.toLocaleString()} ms`
}

function collectScenarioId(value: string, previous: string[]): string[] {
  return [...previous, value]
}

function collectCondition(value: string, previous: string[]): string[] {
  return [...previous, value]
}

export function formatTaskProgressEvent(event: TaskEvalProgressEvent): string {
  if (event.type === "run-stop") {
    const loreCost =
      event.loreUsd === null
        ? "lore cost unavailable"
        : `lore ${formatUsd(event.loreUsd)}`
    if (event.reason === "cost-unknown") {
      return (
        `  stopped after ${event.completedTrials}/${event.totalPlannedTrials}: ` +
        `cost unknown (${formatUsd(event.primaryAgentUsd)} known agent, ${loreCost})`
      )
    }
    return (
      `  stopped after ${event.completedTrials}/${event.totalPlannedTrials}: ` +
      `cost kill-switch observed ${formatUsd(event.observedUsd)} / ` +
      `${formatUsd(event.limitUsd)} (${formatUsd(event.primaryAgentUsd)} agent, ${loreCost})`
    )
  }
  const condition = event.condition ? ` [${event.condition}]` : ""
  const target = event.scenarioId ?? event.taskId
  if (event.type === "trial-start") {
    return `  running ${event.index}/${event.total}: ${target}${condition}`
  }
  const status = event.success ? "passed" : "failed"
  return `  finished ${event.index}/${event.total}: ${target}${condition} ${status}`
}

export const evalCommand = new Command("eval").description("Run Lore evaluation suites")

evalCommand.addCommand(
  new Command("run")
    .description("Run a local eval suite and emit a JSON artifact")
    .argument("<suite>", "Path to an eval suite YAML file")
    .option(
      "--runner <mode>",
      "Runner mode (retrieval|notion|task|bench|profile); defaults to the suite YAML's `runner` field, or `retrieval` if absent"
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
    .option(
      "--limit <n>",
      "Bench-only: run a prefix slice of the corpus (smoke / sample runs). Rejected when --out writes into evals/baselines/."
    )
    .option(
      "--cost-kill-switch-usd <n>",
      "Task longitudinal runs only: stop launching new condition runs once observed priced cost reaches this USD limit"
    )
    .option(
      "--difficulty <level>",
      "Task longitudinal runs only: run scenarios tagged easy, medium, or hard"
    )
    .option(
      "--sample <spec>",
      "Task longitudinal runs only: deterministic random sample such as easy=25,medium=15,hard=10"
    )
    .option(
      "--sample-seed <seed>",
      'Task longitudinal runs only: seed for --sample; defaults to "default"'
    )
    .option(
      "--scenario-id <id>",
      "Task longitudinal runs only: run a single scenario id; repeat for multiple scenarios",
      collectScenarioId,
      []
    )
    .option(
      "--condition <condition>",
      "Task longitudinal runs only: run a single memory condition; repeat for multiple conditions",
      collectCondition,
      []
    )
    .option(
      "--parallel <n>",
      "Task longitudinal runs only: run scenario triples in up to n child processes; cost guard checks between triples"
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
          costKillSwitchUsd?: string
          difficulty?: string
          sample?: string
          sampleSeed?: string
          scenarioId?: string[]
          condition?: string[]
          parallel?: string
          limit?: string
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
          // When `--runner` was omitted on the CLI, peek the suite
          // YAML's `runner` field and route accordingly. Without this,
          // a suite YAML declaring `runner: bench` would fall through
          // to `runEvalSuite` (retrieval default) and surface a
          // useless Zod error before the bench dispatcher could
          // claim it — contradicting the parser comment in
          // `parseEvalRunCliOptions` that the YAML runner field wins
          // when the CLI flag is omitted.
          if (parsed.value.runner === undefined) {
            try {
              const raw = await readFile(suite, "utf-8")
              const peeked = peekSuiteRunner(raw)
              if (peeked !== null) {
                parsed.value.runner = peeked
              }
            } catch {
              // Suite read failure flows through to the
              // runEvalSuite / runBenchSuite call below, which raises
              // the proper file-not-found error with full path
              // context. Suppressing here keeps a separate-error
              // path from clobbering the canonical one.
            }
          }
          const compatibility = validateEvalRunRunnerCompatibility(
            parsed.value.runner,
            opts
          )
          if (!compatibility.ok) {
            console.error(`Eval failed: ${compatibility.message}`)
            process.exit(1)
            return
          }
          // Post-peek `--limit` gate. The parser only validates the
          // integer shape because peek may flip `parsed.value.runner`
          // from undefined → "bench" via the YAML's runner field; an
          // earlier `runner === "bench"` check in the parser would
          // reject the legitimate YAML-routed bench-with-limit case.
          if (parsed.value.limit !== undefined && parsed.value.runner !== "bench") {
            console.error(
              "Eval failed: --limit is only supported with --runner bench (or a suite YAML with `runner: bench`); retrieval / task / notion runners consume the whole suite."
            )
            process.exit(1)
            return
          }
          if (
            parsed.value.costKillSwitchUsd !== undefined &&
            parsed.value.runner !== "task"
          ) {
            console.error(
              "Eval failed: --cost-kill-switch-usd is only supported with --runner task (or a suite YAML with `runner: task`)."
            )
            process.exit(1)
            return
          }
          if (
            (parsed.value.difficulty !== undefined ||
              (parsed.value.scenarioIds?.length ?? 0) > 0 ||
              (parsed.value.conditions?.length ?? 0) > 0 ||
              parsed.value.sample !== undefined ||
              parsed.value.parallelism !== undefined) &&
            parsed.value.runner !== "task"
          ) {
            console.error(
              "Eval failed: --difficulty, --sample, --scenario-id, --condition, and --parallel are only supported with --runner task (or a suite YAML with `runner: task`)."
            )
            process.exit(1)
            return
          }
          if (parsed.value.runner === "task") {
            const { artifact, outPath } = await runTaskEvalSuite(suite, {
              outPath: parsed.value.outPath,
              costKillSwitchUsd: parsed.value.costKillSwitchUsd,
              difficulty: parsed.value.difficulty,
              sample: parsed.value.sample,
              scenarioIds: parsed.value.scenarioIds,
              conditions: parsed.value.conditions,
              parallelism: parsed.value.parallelism,
              onProgress: parsed.value.json
                ? undefined
                : (event) => console.log(formatTaskProgressEvent(event)),
            })
            if (parsed.value.json) {
              console.log(JSON.stringify(artifact, null, 2))
            } else {
              if (isLongitudinalTaskArtifact(artifact)) {
                const seededLore = artifact.summary.conditions["seeded-lore"]
                const fullLoop = artifact.summary.conditions["lore-full-loop"]
                const status = hasLongitudinalTaskGateFailures(artifact)
                  ? "failed"
                  : "passed"
                const headline =
                  fullLoop.trials > 0
                    ? `lore-full-loop ${fullLoop.passed}/${fullLoop.trials} passed; overall ${artifact.summary.passedTrials}/${artifact.summary.totalTrials} condition runs passed`
                    : seededLore && seededLore.trials > 0
                      ? `seeded-lore ${seededLore.passed}/${seededLore.trials} passed; overall ${artifact.summary.passedTrials}/${artifact.summary.totalTrials} condition runs passed`
                      : `${artifact.summary.passedTrials}/${artifact.summary.totalTrials} condition runs passed`
                console.log(`Longitudinal task eval ${status}: ${headline}.`)
                if (artifact.termination) {
                  console.log(`  stopped: ${artifact.termination.message}`)
                }
                for (const [condition, summary] of Object.entries(
                  artifact.summary.conditions
                )) {
                  console.log(
                    `  ${condition}: ${summary.passed}/${summary.trials} passed (${(summary.successRate * 100).toFixed(1)}%).`
                  )
                }
                const delta = artifact.summary.lift.successRateDelta
                console.log(
                  `  ${artifact.summary.lift.toCondition} lift delta: ${delta === null ? "n/a" : `${(delta * 100).toFixed(1)} pp`}; ` +
                    `lifted=${artifact.summary.lift.liftedScenarioIds.length}, ` +
                    `harmed=${artifact.summary.lift.harmedScenarioIds.length}`
                )
                console.log(`Artifact: ${outPath}`)
                for (const result of artifact.results) {
                  if (!result.success) {
                    console.log(`  - ${result.scenarioId} [${result.condition}]:`)
                    for (const phase of result.phases.filter((p) => !p.success)) {
                      console.log(
                        `    ${phase.phase}: ${phase.failureMessage ?? phase.failureReason ?? "failed"}`
                      )
                    }
                    for (const v of result.verifiers.filter((v) => !v.passed)) {
                      console.log(`    - ${v.message}`)
                    }
                  }
                }
              } else {
                const status = artifact.summary.failedTasks === 0 ? "passed" : "failed"
                console.log(
                  `Task eval ${status}: ${artifact.summary.passedTasks}/${artifact.summary.tasks} tasks passed.`
                )
                console.log(`Artifact: ${outPath}`)
                for (const result of artifact.results) {
                  if (!result.success) {
                    const failed = result.verifiers.filter((v) => !v.passed)
                    const conditionTag = result.memoryCondition
                      ? ` [${result.memoryCondition}]`
                      : ""
                    console.log(`  - ${result.taskId}${conditionTag}:`)
                    if (result.agentRun.timedOut) {
                      console.log(`    agent timed out`)
                    }
                    if (result.agentRun.exitCode !== 0) {
                      console.log(`    agent exit code: ${result.agentRun.exitCode}`)
                      // Surface the first stderr line so the cost-guardrail
                      // refusal ("set LORE_EVAL_TASK_REAL=1 to opt in...")
                      // and other adapter-side messages reach the operator
                      // instead of disappearing into the artifact.
                      const firstStderrLine = result.agentRun.stderr
                        .split("\n")
                        .map((line) => line.trim())
                        .find((line) => line.length > 0)
                      if (firstStderrLine) {
                        console.log(`    stderr: ${firstStderrLine}`)
                      }
                    }
                    for (const v of failed) console.log(`    - ${v.message}`)
                  }
                }
              }
            }
            if (isLongitudinalTaskArtifact(artifact)) {
              if (hasLongitudinalTaskGateFailures(artifact)) process.exit(1)
            } else if (artifact.summary.failedTasks > 0) {
              process.exit(1)
            }
            return
          }

          if (parsed.value.runner === "bench") {
            const { runBenchSuite, assertBenchEnvReady, restoreBenchEnv } =
              await import("../../eval/bench-runner.js")
            const { buildBenchSandbox } = await import("../../eval/bench-sandbox.js")
            const { compareBenchBaseline, readBenchBaselineSnapshot } =
              await import("../../eval/bench-baseline.js")
            // Run the bench env preflight + LORE_BENCH_* → standard
            // Lore env remap BEFORE `buildBenchSandbox` calls
            // `initServices`, so the in-process service init sees
            // the remapped `NOTION_API_TOKEN` / `LORE_CONFIG_ROOT`.
            // Capture the snapshot here and restore in a `finally`
            // so an imported / test CLI execution doesn't leave env
            // mutated past the command's lifetime. `runBenchSuite`
            // calls `assertBenchEnvReady` again internally but its
            // restore is a no-op against the already-bench state —
            // this outer pair is the load-bearing one.
            const envSnapshot = assertBenchEnvReady()
            try {
              const sandbox = await buildBenchSandbox()
              const { artifact, outPath } = await runBenchSuite({
                suitePath: suite,
                outPath: parsed.value.outPath,
                limit: parsed.value.limit,
                sandbox,
              })
              let driftRegressed = false
              if (parsed.value.baselinePath) {
                const baseline = await readBenchBaselineSnapshot(
                  parsed.value.baselinePath
                )
                const drift = compareBenchBaseline({ artifact, baseline })
                driftRegressed = drift.regressed
                if (drift.regressed) {
                  console.error("Bench drift gate FAILED:")
                  for (const reason of drift.reasons) {
                    console.error(`  - ${reason}`)
                  }
                  if (drift.regressedExamples.length > 0) {
                    console.error(
                      `  Regressed examples: ${drift.regressedExamples.slice(0, 10).join(", ")}` +
                        (drift.regressedExamples.length > 10
                          ? ` (+${drift.regressedExamples.length - 10} more)`
                          : "")
                    )
                  }
                }
              }
              if (parsed.value.json) {
                console.log(JSON.stringify(artifact, null, 2))
              } else {
                console.log(
                  `Bench finished: ${artifact.summary.overall.correct}/${artifact.summary.scoredExamples} correct ` +
                    `(${(artifact.summary.overall.accuracy * 100).toFixed(2)}%).`
                )
                console.log(`Artifact: ${outPath}`)
                if (artifact.summary.aborted) {
                  console.error(`Aborted: ${artifact.summary.abortReason ?? "unknown"}`)
                }
              }
              if (artifact.summary.aborted || driftRegressed) {
                process.exit(1)
              }
              return
            } finally {
              restoreBenchEnv(envSnapshot)
            }
          }

          if (parsed.value.runner === "profile") {
            if (
              parsed.value.baselinePath ||
              parsed.value.minLift !== undefined ||
              parsed.value.maxHarm !== undefined ||
              parsed.value.projectName
            ) {
              console.error(
                "Eval failed: --baseline, --min-lift, --max-harm, and --project are not supported with runner profile; profile suites declare thresholds in YAML."
              )
              process.exit(1)
              return
            }
            const { runProfileEvalSuite } = await import("../../eval/profile-runner.js")
            const { artifact, outPath } = await runProfileEvalSuite(suite, {
              outPath: parsed.value.outPath,
            })
            if (parsed.value.json) {
              console.log(JSON.stringify(artifact, null, 2))
            } else {
              const status =
                artifact.summary.failedCases === 0 &&
                artifact.summary.failures.length === 0
                  ? "passed"
                  : "failed"
              console.log(
                `Profile eval ${status}: ${artifact.summary.passedCases}/${artifact.summary.cases} cases passed.`
              )
              console.log(`Artifact: ${outPath}`)
              for (const failure of artifact.summary.failures) {
                console.error(`Profile threshold failed: ${failure}`)
              }
              for (const result of artifact.results) {
                for (const failure of result.failures) {
                  console.error(`  - ${result.id}: ${failure}`)
                }
              }
            }
            if (
              artifact.summary.failedCases > 0 ||
              artifact.summary.failures.length > 0
            ) {
              process.exit(1)
            }
            return
          }

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
            const baseline = await readEvalBaselineSnapshot(parsed.value.baselinePath)
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
          if (failed > 0 || thresholdFailures.length > 0 || driftRegressed) {
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
          // When `--runner` was omitted on the CLI, peek the suite
          // YAML's `runner` field and route accordingly. Mirrors the
          // `lore eval run` dispatch path so a YAML-declared
          // `runner: bench` lands in the bench-baseline branch
          // without an explicit `--runner bench` flag.
          if (parsed.value.runner === undefined) {
            try {
              const raw = await readFile(suite, "utf-8")
              const peeked = peekSuiteRunner(raw)
              if (peeked !== null) {
                parsed.value.runner = peeked
              }
            } catch {
              // Suite read failure flows through to the runner call
              // below, which raises a clearer file-not-found error.
            }
          }
          const baselineRunnerCheck = validateBaselineRunnerSupport(parsed.value.runner)
          if (!baselineRunnerCheck.ok) {
            console.error(`Eval baseline failed: ${baselineRunnerCheck.message}`)
            process.exit(1)
            return
          }
          const runOptions: RunEvalOptions = {
            runner: parsed.value.runner,
            notionServices: buildNotionServicesFactory(parsed.value.projectName),
          }
          if (parsed.value.runner === "bench") {
            const { runBenchSuite, assertBenchEnvReady, restoreBenchEnv } =
              await import("../../eval/bench-runner.js")
            const { buildBenchBaselineSnapshot, writeBenchBaselineSnapshot } =
              await import("../../eval/bench-baseline.js")
            const { buildBenchSandbox } = await import("../../eval/bench-sandbox.js")
            // Capture the env snapshot here and restore in finally so
            // an imported / test CLI execution does not leak the
            // bench env-remap past the command's lifetime. Same
            // posture as the bench branch of `eval run`.
            const envSnapshot = assertBenchEnvReady()
            try {
              const sandbox = await buildBenchSandbox()
              const { artifact } = await runBenchSuite({
                suitePath: suite,
                sandbox,
              })
              const snapshot = buildBenchBaselineSnapshot(artifact, {
                notes: opts.notes,
              })
              await writeBenchBaselineSnapshot(opts.out, snapshot)
              console.log(
                `Bench baseline written: ${opts.out} (runner=bench, examples=${snapshot.summary.totalExamples})`
              )
              return
            } finally {
              restoreBenchEnv(envSnapshot)
            }
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
          console.error("Eval baseline failed:", err instanceof Error ? err.message : err)
          process.exit(1)
        }
      }
    )
)

const longitudinalCommand = new Command("longitudinal").description(
  "Longitudinal task eval planning helpers"
)

longitudinalCommand.addCommand(
  new Command("plan")
    .description("Estimate powered benchmark size and cost from a pilot artifact")
    .argument("<artifact>", "Path to a longitudinal task artifact JSON file")
    .option(
      "--to-condition <condition>",
      "Memory condition to compare against no-memory (seeded-lore|lore-full-loop)"
    )
    .option("--mde <n>", "Minimum detectable effect as a 0..1 lift", "0.15")
    .option("--power <n>", "Target statistical power as a 0..1 probability", "0.8")
    .option("--alpha <n>", "Type-I error rate as a 0..1 probability", "0.05")
    .option("--one-sided", "Use a one-sided alpha split instead of two-sided")
    .option("--budget-usd <n>", "Full benchmark API budget in USD", "1000")
    .option(
      "--cost-per-condition-run-usd <n>",
      "Override measured per-condition-run API cost in USD"
    )
    .option(
      "--conditions-per-scenario <n>",
      "Override condition runs per scenario; defaults to conditions present in the artifact"
    )
    .option("--json", "Print the plan as JSON")
    .action(
      async (
        artifactPath: string,
        opts: {
          toCondition?: string
          mde?: string
          power?: string
          alpha?: string
          oneSided?: boolean
          budgetUsd?: string
          costPerConditionRunUsd?: string
          conditionsPerScenario?: string
          json?: boolean
        }
      ) => {
        const toCondition = parseLongitudinalToCondition(opts.toCondition)
        if (!toCondition.ok) {
          console.error(`Longitudinal plan failed: ${toCondition.message}`)
          process.exit(1)
          return
        }
        const mde = parseOptionalUnitInterval("--mde", opts.mde)
        if (!mde.ok) {
          console.error(`Longitudinal plan failed: ${mde.message}`)
          process.exit(1)
          return
        }
        const power = parseOptionalUnitInterval("--power", opts.power)
        if (!power.ok) {
          console.error(`Longitudinal plan failed: ${power.message}`)
          process.exit(1)
          return
        }
        const alpha = parseOptionalUnitInterval("--alpha", opts.alpha)
        if (!alpha.ok) {
          console.error(`Longitudinal plan failed: ${alpha.message}`)
          process.exit(1)
          return
        }
        const budgetUsd = parseOptionalPositiveNumber("--budget-usd", opts.budgetUsd)
        if (!budgetUsd.ok) {
          console.error(`Longitudinal plan failed: ${budgetUsd.message}`)
          process.exit(1)
          return
        }
        const costPerConditionRunUsd = parseOptionalPositiveNumber(
          "--cost-per-condition-run-usd",
          opts.costPerConditionRunUsd
        )
        if (!costPerConditionRunUsd.ok) {
          console.error(`Longitudinal plan failed: ${costPerConditionRunUsd.message}`)
          process.exit(1)
          return
        }
        const conditionsPerScenario = parseOptionalPositiveInteger(
          "--conditions-per-scenario",
          opts.conditionsPerScenario
        )
        if (!conditionsPerScenario.ok) {
          console.error(`Longitudinal plan failed: ${conditionsPerScenario.message}`)
          process.exit(1)
          return
        }

        try {
          const raw = await readFile(artifactPath, "utf-8")
          const artifact = JSON.parse(raw) as unknown
          const candidate = artifact as AnyTaskEvalArtifact
          if (!isLongitudinalTaskArtifact(candidate)) {
            throw new Error("artifact is not a longitudinal task artifact")
          }
          const plan = buildLongitudinalBenchmarkPlan(candidate, {
            toCondition: toCondition.value,
            mde: mde.value,
            power: power.value,
            alpha: alpha.value,
            twoSided: opts.oneSided === true ? false : true,
            budgetUsd: budgetUsd.value,
            costPerConditionRunUsd: costPerConditionRunUsd.value,
            conditionsPerScenario: conditionsPerScenario.value,
          })
          if (opts.json) {
            console.log(JSON.stringify(plan, null, 2))
            return
          }
          console.log(`Longitudinal plan: ${plan.fromCondition} -> ${plan.toCondition}`)
          console.log(
            `  pilot pairs: ${plan.pairedOutcomes.pairs}; ` +
              `observed lift ${formatPercentagePoints(plan.pairedOutcomes.observedLift)}; ` +
              `discordance ${formatPercent(plan.pairedOutcomes.observedDiscordance)} ` +
              `(lifted=${plan.pairedOutcomes.lifted}, harmed=${plan.pairedOutcomes.harmed})`
          )
          console.log(
            `  target: ${formatPercentagePoints(plan.mde)} MDE, ` +
              `${formatPercent(plan.power)} power, alpha ${plan.alpha} ` +
              `${plan.twoSided ? "two-sided" : "one-sided"}`
          )
          console.log(
            `  estimate: ${plan.estimatedPairsRequired} paired scenarios, ` +
              `${plan.conditionRunsRequired} condition runs ` +
              `(${plan.conditionsPerScenario} conditions/scenario)`
          )
          console.log(
            `  efficiency: primary tokens ${formatSignedNumber(
              plan.efficiency.pairedDeltas.meanPrimaryTokenDelta
            )} ` +
              `(${formatSignedPercent(
                plan.efficiency.pairedDeltas.meanPrimaryTokenDeltaPct
              )}); ` +
              `runner phase elapsed ${formatSignedMs(
                plan.efficiency.pairedDeltas.meanElapsedMsDelta
              )} ` +
              `(${formatSignedPercent(plan.efficiency.pairedDeltas.meanElapsedDeltaPct)})`
          )
          if (plan.projectedCostUsd === null) {
            console.log(
              `  cost: n/a; measured cost coverage ${plan.measuredCostConditionRuns}/${plan.totalCostConditionRuns} condition runs; ` +
                "pass --cost-per-condition-run-usd after complete pilot cost is known"
            )
          } else {
            const covered = plan.budgetCoversPlan ? "covers" : "does not cover"
            console.log(
              `  cost: ${formatUsd(plan.projectedCostUsd)} projected; ` +
                `${formatUsd(plan.budgetUsd)} budget ${covered} this plan`
            )
            if (plan.measuredCostCoverage < 1) {
              console.log(
                `  measured cost coverage: ${plan.measuredCostConditionRuns}/${plan.totalCostConditionRuns} condition runs; projection uses override`
              )
            }
            console.log(`  budget capacity: ${plan.maxPairsAtBudget} paired scenarios`)
          }
        } catch (err) {
          console.error(
            "Longitudinal plan failed:",
            err instanceof Error ? err.message : err
          )
          process.exit(1)
        }
      }
    )
)

evalCommand.addCommand(longitudinalCommand)

const vaultsCommand = new Command("vaults").description(
  "List committed evaluation vaults and render local run config"
)

vaultsCommand
  .option("--json", "Print the registry as JSON")
  .option("--registry <path>", "Override the eval vault registry YAML path")
  .action(async (opts: { json?: boolean; registry?: string }) => {
    try {
      const registry = await loadEvalVaultRegistry(opts.registry)
      if (opts.json) {
        console.log(JSON.stringify(registry, null, 2))
        return
      }
      console.log(`Eval vaults (${EVAL_VAULT_REGISTRY_PATH}):`)
      for (const vault of registry.vaults) {
        console.log(`  ${vault.id} - ${vault.label} [${vault.notionEnv}]`)
        console.log(`    vault: ${vault.vaultPageId}`)
        if (vault.defaultProjectName) {
          console.log(`    default project: ${vault.defaultProjectName}`)
        }
      }
    } catch (err) {
      console.error("lore eval vaults failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

vaultsCommand.addCommand(
  new Command("show")
    .description("Show a committed evaluation vault by id")
    .argument("<id>", "Eval vault id from evals/vaults.yaml")
    .option("--json", "Print the vault entry as JSON")
    .option("--config", "Print a local .lore.yaml snippet for this vault")
    .option("--env", "Print shell exports for this vault")
    .option("--registry <path>", "Override the eval vault registry YAML path")
    .action(
      async (
        id: string,
        opts: { json?: boolean; config?: boolean; env?: boolean; registry?: string }
      ) => {
        try {
          const registry = await loadEvalVaultRegistry(opts.registry)
          const vault = findEvalVault(registry, id)
          if (!vault) {
            console.error(`lore eval vaults show failed: unknown vault "${id}".`)
            process.exit(1)
            return
          }
          if (opts.json) {
            console.log(JSON.stringify(vault, null, 2))
            return
          }
          if (opts.config) {
            process.stdout.write(renderEvalVaultLoreConfig(vault))
          }
          if (opts.env) {
            process.stdout.write(renderEvalVaultEnv(vault))
          }
          if (!opts.config && !opts.env) {
            printEvalVaultSummary(vault)
          }
        } catch (err) {
          console.error(
            "lore eval vaults show failed:",
            err instanceof Error ? err.message : err
          )
          process.exit(1)
        }
      }
    )
)

function printEvalVaultSummary(vault: EvalVault): void {
  console.log(`${vault.id} - ${vault.label}`)
  console.log(`  Notion env: ${vault.notionEnv}`)
  console.log(`  Workspace: ${vault.notionWorkspaceId}`)
  console.log(`  Vault page: ${vault.vaultPageId}`)
  if (vault.defaultProjectName) {
    console.log(`  Default project: ${vault.defaultProjectName}`)
  }
  if (vault.supportedRuns.length > 0) {
    console.log("  Supported runs:")
    for (const run of vault.supportedRuns) {
      const project = run.sandboxProjectName
        ? `, project="${run.sandboxProjectName}"`
        : ""
      console.log(`    - ${run.id}: runner=${run.runner}, suite=${run.suite}${project}`)
    }
  }
  if (vault.lastValidation) {
    const validation = vault.lastValidation
    console.log(
      `  Last validation: ${validation.date} ${validation.kind}, ` +
        `${validation.scenarios} scenarios / ${validation.conditionRuns} condition runs, ` +
        `no-memory ${validation.noMemory.passed}/${validation.noMemory.trials}, ` +
        `lore-full-loop ${validation.loreFullLoop.passed}/${validation.loreFullLoop.trials}, ` +
        `lift ${(validation.successRateDelta * 100).toFixed(1)} pp`
    )
  }
}

evalCommand.addCommand(vaultsCommand)

// ---------------------------------------------------------------------------
// `lore eval bench` — LongMemEval bench-runner CLI surface (issue #595).
// Sub-actions: `fetch`, `cleanup-orphans`. The `run` and `baseline` entries
// reuse the top-level `lore eval run` / `lore eval baseline` commands with
// `--runner bench`; this group hosts only the bench-specific helpers.
// ---------------------------------------------------------------------------

const benchCommand = new Command("bench").description(
  "LongMemEval bench-runner helpers (corpus fetch, orphan-cleanup)"
)

benchCommand.addCommand(
  new Command("fetch")
    .description(
      "Download the LongMemEval corpus from the HF revision pinned by checksums.json. Idempotent — re-running does not overwrite a sha-matched file."
    )
    .argument("<benchmark>", "Bench name; currently only `longmemeval`")
    .option(
      "--out <path>",
      "Override the corpus output path. Defaults to evals/bench-corpora/<benchmark>/<corpus-name>.json next to checksums.json."
    )
    .action(async (benchmark: string, opts: { out?: string }) => {
      if (benchmark !== "longmemeval") {
        console.error(
          `lore eval bench fetch: only "longmemeval" is supported (got "${benchmark}").`
        )
        process.exit(1)
        return
      }
      try {
        const { fetchLongMemEvalCorpus } = await import("../../eval/bench-fetch.js")
        const report = await fetchLongMemEvalCorpus({ outPath: opts.out })
        if (report.skipped) {
          console.log(`Corpus already up to date (sha256 match): ${report.path}`)
          return
        }
        console.log(
          `Corpus written: ${report.path}\n` +
            `  HF revision: ${report.revision}\n` +
            `  sha256: ${report.sha256}`
        )
      } catch (err) {
        console.error(
          "lore eval bench fetch failed:",
          err instanceof Error ? err.message : err
        )
        process.exit(1)
      }
    })
)

benchCommand.addCommand(
  new Command("cleanup-orphans")
    .description(
      "Archive bench sub-projects under the sandbox vault whose ULID-embedded timestamp is older than --older-than hours. Idempotent. Requires LORE_EVAL_BENCH_REAL=1."
    )
    .option("--dry-run", "List matching projects without archiving")
    .option("--older-than <hours>", "Minimum age in hours; defaults to 24", "24")
    .action(async (opts: { dryRun?: boolean; olderThan?: string }) => {
      try {
        const parsedOlderThan = parsePositiveDecimalInteger(
          "--older-than",
          opts.olderThan ?? "24"
        )
        if (!parsedOlderThan.ok) {
          console.error(
            "lore eval bench cleanup-orphans failed:",
            parsedOlderThan.message
          )
          process.exit(1)
          return
        }
        const { runBenchCleanupOrphans } = await import("../../eval/bench-cleanup.js")
        const result = await runBenchCleanupOrphans({
          olderThanHours: parsedOlderThan.value,
          dryRun: opts.dryRun === true,
        })
        console.log(
          `Cleanup-orphans: ${result.archivedCount} archived, ${result.skippedCount} skipped (already archived / too fresh).`
        )
        for (const orphan of result.archived) {
          console.log(`  - archived: ${orphan.name}`)
        }
      } catch (err) {
        console.error(
          "lore eval bench cleanup-orphans failed:",
          err instanceof Error ? err.message : err
        )
        process.exit(1)
      }
    })
)

benchCommand.addCommand(
  new Command("tool")
    .description("Internal bench-only Lore tool shim")
    .argument("<tool>", "Tool name, e.g. lore-query or lore-memory")
    .allowUnknownOption(true)
    .allowExcessArguments(true)
    .action(async (tool: string) => {
      try {
        const { runBenchToolCli } = await import("../../eval/bench-tool.js")
        const marker = process.argv.indexOf(tool)
        const argv = marker >= 0 ? process.argv.slice(marker + 1) : []
        const exitCode = await runBenchToolCli(tool, argv)
        if (exitCode !== 0) process.exit(exitCode)
      } catch (err) {
        console.error(
          "lore eval bench tool failed:",
          err instanceof Error ? err.message : err
        )
        process.exit(1)
      }
    }),
  { hidden: true }
)

evalCommand.addCommand(benchCommand)
