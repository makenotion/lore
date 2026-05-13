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
import { runTaskEvalSuite } from "../../eval/task-runner.js"
import { resolveProjectByName } from "../../core/project-scope.js"
import { EVAL_RUNNERS, peekSuiteRunner, type EvalRunner } from "../../eval/schema.js"
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
  /**
   * Prefix slice for sample runs. Bench-only — rejected on every
   * other runner mode. Refuses to land when `--out` writes under an
   * `evals/baselines/` directory so a smoke run cannot accidentally
   * baseline.
   */
  limit?: number
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
  limit?: string
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
      limit,
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

export const evalCommand = new Command("eval").description("Run Lore evaluation suites")

evalCommand.addCommand(
  new Command("run")
    .description("Run a local eval suite and emit a JSON artifact")
    .argument("<suite>", "Path to an eval suite YAML file")
    .option(
      "--runner <mode>",
      "Runner mode (retrieval|notion|task); defaults to the suite YAML's `runner` field, or `retrieval` if absent"
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
          // Post-peek `--limit` gate. The parser only validates the
          // integer shape because peek may flip `parsed.value.runner`
          // from undefined → "bench" via the YAML's runner field; an
          // earlier `runner === "bench"` check in the parser would
          // reject the legitimate YAML-routed bench-with-limit case.
          if (parsed.value.limit !== undefined && parsed.value.runner !== "bench") {
            console.error(
              "Eval failed: --limit is only supported with --runner bench (or a suite YAML with `runner: bench`); retrieval / task / notion runners consume the whole suite.",
            )
            process.exit(1)
            return
          }
          if (parsed.value.runner === "task") {
            const { artifact, outPath } = await runTaskEvalSuite(suite, {
              outPath: parsed.value.outPath,
            })
            if (parsed.value.json) {
              console.log(JSON.stringify(artifact, null, 2))
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
            if (artifact.summary.failedTasks > 0) process.exit(1)
            return
          }

          if (parsed.value.runner === "bench") {
            const { runBenchSuite, assertBenchEnvReady, restoreBenchEnv } = await import(
              "../../eval/bench-runner.js"
            )
            const { buildBenchSandbox } = await import("../../eval/bench-sandbox.js")
            const {
              compareBenchBaseline,
              readBenchBaselineSnapshot,
            } = await import("../../eval/bench-baseline.js")
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
                  parsed.value.baselinePath,
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
                          : ""),
                    )
                  }
                }
              }
              if (parsed.value.json) {
                console.log(JSON.stringify(artifact, null, 2))
              } else {
                console.log(
                  `Bench finished: ${artifact.summary.overall.correct}/${artifact.summary.scoredExamples} correct ` +
                    `(${(artifact.summary.overall.accuracy * 100).toFixed(2)}%).`,
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
            const { runBenchSuite, assertBenchEnvReady, restoreBenchEnv } = await import(
              "../../eval/bench-runner.js"
            )
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
                `Bench baseline written: ${opts.out} (runner=bench, examples=${snapshot.summary.totalExamples})`,
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
          console.error(
            "Eval baseline failed:",
            err instanceof Error ? err.message : err
          )
          process.exit(1)
        }
      }
    )
)

// ---------------------------------------------------------------------------
// `lore eval bench` — LongMemEval bench-runner CLI surface (issue #595).
// Sub-actions: `fetch`, `cleanup-orphans`. The `run` and `baseline` entries
// reuse the top-level `lore eval run` / `lore eval baseline` commands with
// `--runner bench`; this group hosts only the bench-specific helpers.
// ---------------------------------------------------------------------------

const benchCommand = new Command("bench").description(
  "LongMemEval bench-runner helpers (corpus fetch, orphan-cleanup)",
)

benchCommand.addCommand(
  new Command("fetch")
    .description(
      "Download the LongMemEval corpus from the HF revision pinned by checksums.json. Idempotent — re-running does not overwrite a sha-matched file.",
    )
    .argument("<benchmark>", "Bench name; currently only `longmemeval`")
    .option(
      "--out <path>",
      "Override the corpus output path. Defaults to evals/bench-corpora/<benchmark>/<corpus-name>.json next to checksums.json.",
    )
    .action(
      async (benchmark: string, opts: { out?: string }) => {
        if (benchmark !== "longmemeval") {
          console.error(
            `lore eval bench fetch: only "longmemeval" is supported (got "${benchmark}").`,
          )
          process.exit(1)
          return
        }
        try {
          const { fetchLongMemEvalCorpus } = await import(
            "../../eval/bench-fetch.js"
          )
          const report = await fetchLongMemEvalCorpus({ outPath: opts.out })
          if (report.skipped) {
            console.log(
              `Corpus already up to date (sha256 match): ${report.path}`,
            )
            return
          }
          console.log(
            `Corpus written: ${report.path}\n` +
              `  HF revision: ${report.revision}\n` +
              `  sha256: ${report.sha256}`,
          )
        } catch (err) {
          console.error(
            "lore eval bench fetch failed:",
            err instanceof Error ? err.message : err,
          )
          process.exit(1)
        }
      },
    ),
)

benchCommand.addCommand(
  new Command("cleanup-orphans")
    .description(
      "Archive bench sub-projects under the sandbox vault whose ULID-embedded timestamp is older than --older-than hours. Idempotent. Requires LORE_EVAL_BENCH_REAL=1.",
    )
    .option("--dry-run", "List matching projects without archiving")
    .option(
      "--older-than <hours>",
      "Minimum age in hours; defaults to 24",
      "24",
    )
    .action(async (opts: { dryRun?: boolean; olderThan?: string }) => {
      try {
        const { runBenchCleanupOrphans } = await import(
          "../../eval/bench-cleanup.js"
        )
        const result = await runBenchCleanupOrphans({
          olderThanHours: Number.parseInt(opts.olderThan ?? "24", 10),
          dryRun: opts.dryRun === true,
        })
        console.log(
          `Cleanup-orphans: ${result.archivedCount} archived, ${result.skippedCount} skipped (already archived / too fresh).`,
        )
        for (const orphan of result.archived) {
          console.log(`  - archived: ${orphan.name}`)
        }
      } catch (err) {
        console.error(
          "lore eval bench cleanup-orphans failed:",
          err instanceof Error ? err.message : err,
        )
        process.exit(1)
      }
    }),
)

evalCommand.addCommand(benchCommand)
