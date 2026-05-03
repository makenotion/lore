import { Command } from "commander"
import {
  runEvalSuite,
  type EvalRunArtifact,
  type RunEvalOptions,
} from "../../eval/runner.js"
import { EVAL_RUNNERS, type EvalRunner } from "../../eval/schema.js"
import { parsePositiveDecimalInteger, type CliParseResult } from "../parse.js"

export interface EvalRunCliOptions {
  runner: EvalRunner
  trials?: number
  outPath?: string
  minLift?: number
  maxHarm?: number
  json: boolean
}

export function parseEvalRunCliOptions(raw: {
  runner?: string
  trials?: string
  out?: string
  minLift?: string
  maxHarm?: string
  json?: boolean
}): CliParseResult<EvalRunCliOptions> {
  const runner = raw.runner ?? "retrieval"
  if (!isEvalRunner(runner)) {
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
      return {
        ok: false,
        message: `--trials must be 1 for retrieval mode, got ${parsedTrials.value}`,
      }
    }
    trials = parsedTrials.value
  }

  const minLift = parseOptionalUnitInterval("--min-lift", raw.minLift)
  if (!minLift.ok) return minLift

  const maxHarm = parseOptionalUnitInterval("--max-harm", raw.maxHarm)
  if (!maxHarm.ok) return maxHarm

  return {
    ok: true,
    value: {
      runner,
      trials,
      outPath: raw.out,
      minLift: minLift.value,
      maxHarm: maxHarm.value,
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

export const evalCommand = new Command("eval").description("Run Lore evaluation suites")

evalCommand.addCommand(
  new Command("run")
    .description("Run a local eval suite and emit a JSON artifact")
    .argument("<suite>", "Path to an eval suite YAML file")
    .option("--runner <mode>", "Runner mode", "retrieval")
    .option("--trials <n>", "Trial count; retrieval mode requires 1")
    .option("--out <path>", "Write the JSON artifact to a specific path")
    .option("--min-lift <n>", "Fail when memory lift is below this 0..1 threshold")
    .option("--max-harm <n>", "Fail when memory harm is above this 0..1 threshold")
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
          }
          const { artifact, outPath } = await runEvalSuite(suite, runOptions)
          const thresholdFailures = collectEvalThresholdFailures(artifact, {
            minLift: parsed.value.minLift,
            maxHarm: parsed.value.maxHarm,
          })
          if (parsed.value.json) {
            console.log(JSON.stringify(artifact, null, 2))
            for (const failure of thresholdFailures) {
              console.error(`Eval threshold failed: ${failure}`)
            }
            if (artifact.summary.failedResults > 0 || thresholdFailures.length > 0) {
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
          if (failed > 0 || thresholdFailures.length > 0) process.exit(1)
        } catch (err) {
          console.error("Eval failed:", err instanceof Error ? err.message : err)
          process.exit(1)
        }
      }
    )
)
