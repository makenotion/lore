#!/usr/bin/env node

import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const defaultCorpus = path.join(__dirname, "corpus.json")
const defaultThresholds = {
  candidateAccuracy: { min: 0.8 },
  keepPrecision: { min: 0.75 },
  keepRecall: { min: 0.8 },
  rejectRecall: { min: 0.8 },
  falseKeepRate: { max: 0.2 },
}

function parseArgs(argv) {
  const args = {
    corpus: defaultCorpus,
    provider: "fixture",
    seeds: ["1", "2", "3"],
    json: true,
    thresholds: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--corpus") args.corpus = argv[++i]
    else if (arg === "--provider") args.provider = argv[++i]
    else if (arg === "--seeds") args.seeds = argv[++i].split(",").filter(Boolean)
    else if (arg === "--text") args.json = false
    else if (arg === "--no-thresholds") args.thresholds = false
    else if (arg === "--help") {
      console.log(
        `Usage: node evals/memory-quality/run.mjs [--corpus path] [--provider fixture|claude] [--seeds 1,2,3] [--text] [--no-thresholds]`
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return args
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex")
}

function normalize(text) {
  return String(text).toLowerCase().replace(/\s+/g, " ").trim()
}

function matched(output, candidate) {
  const haystack = normalize(output)
  if (candidate.matchAll?.length) {
    return candidate.matchAll.every((term) => haystack.includes(normalize(term)))
  }
  return candidate.matchAny.some((term) => haystack.includes(normalize(term)))
}

function divide(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator
}

function scoreCase(output, testCase) {
  const candidateResults = testCase.candidates.map((candidate) => {
    const emitted = matched(output, candidate)
    return {
      id: candidate.id,
      expected: candidate.expected,
      emitted,
      correct:
        (candidate.expected === "keep" && emitted) ||
        (candidate.expected === "reject" && !emitted),
    }
  })
  return candidateResults
}

function assertPromptQualityGate(prompt, caseId) {
  const required = [
    "inferability test",
    "learned by doing",
    "Non-inferable / experiential",
    "exact trigger and the exact rule",
  ]
  const missing = required.filter((term) => !prompt.includes(term))
  if (missing.length > 0) {
    throw new Error(
      `Case ${caseId} prompt is missing quality gates: ${missing.join(", ")}`
    )
  }
}

function buildReadOnlyPrompt(prompt) {
  return `${prompt}

[Memory-quality replay mode]
Do not call tools. Do not mutate any Lore vault. Output the exact lore-* calls you would make as plain text, or exactly "No Lore context to save."`
}

function scoreRun(caseResults) {
  const totals = {
    trueKeep: 0,
    falseDrop: 0,
    trueReject: 0,
    falseKeep: 0,
  }
  for (const result of caseResults.flatMap((testCase) => testCase.candidates)) {
    if (result.expected === "keep" && result.emitted) totals.trueKeep++
    else if (result.expected === "keep" && !result.emitted) totals.falseDrop++
    else if (result.expected === "reject" && !result.emitted) totals.trueReject++
    else if (result.expected === "reject" && result.emitted) totals.falseKeep++
  }
  const total = totals.trueKeep + totals.falseDrop + totals.trueReject + totals.falseKeep
  return {
    totals,
    metrics: {
      candidateAccuracy: divide(totals.trueKeep + totals.trueReject, total),
      keepPrecision: divide(totals.trueKeep, totals.trueKeep + totals.falseKeep),
      keepRecall: divide(totals.trueKeep, totals.trueKeep + totals.falseDrop),
      rejectRecall: divide(totals.trueReject, totals.trueReject + totals.falseKeep),
      falseKeepRate: divide(totals.falseKeep, totals.trueReject + totals.falseKeep),
    },
  }
}

function mean(values) {
  const filtered = values.filter((value) => value !== null)
  if (filtered.length === 0) return null
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length
}

function stddev(values) {
  const filtered = values.filter((value) => value !== null)
  if (filtered.length <= 1) return 0
  const avg = mean(filtered)
  const variance =
    filtered.reduce((sum, value) => sum + Math.pow(value - avg, 2), 0) / filtered.length
  return Math.sqrt(variance)
}

function summarize(runs) {
  const metricNames = Object.keys(runs[0]?.metrics ?? {})
  const aggregate = {}
  for (const metric of metricNames) {
    const values = runs.map((run) => run.metrics[metric])
    aggregate[metric] = {
      mean: mean(values),
      stddev: stddev(values),
    }
  }
  return aggregate
}

function checkThresholds(aggregate) {
  const failures = []
  for (const [metric, threshold] of Object.entries(defaultThresholds)) {
    const value = aggregate[metric]?.mean
    if (value === null || value === undefined) {
      failures.push(`${metric} had no mean value`)
      continue
    }
    if (threshold.min !== undefined && value < threshold.min) {
      failures.push(`${metric} mean ${value.toFixed(3)} < ${threshold.min}`)
    }
    if (threshold.max !== undefined && value > threshold.max) {
      failures.push(`${metric} mean ${value.toFixed(3)} > ${threshold.max}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`Memory-quality thresholds failed: ${failures.join("; ")}`)
  }
}

async function resolveTranscript(testCase) {
  if (typeof testCase.transcript === "string") return testCase.transcript
  if (typeof testCase.transcriptPath === "string") {
    return readFile(testCase.transcriptPath, "utf8")
  }
  throw new Error(`Case ${testCase.id} has no transcript or transcriptPath`)
}

function runProvider(provider, prompt, testCase, seed) {
  if (provider === "fixture") {
    const output = testCase.fixtureOutputs?.[seed] ?? testCase.fixtureOutputs?.default
    if (typeof output !== "string") {
      throw new Error(`Case ${testCase.id} has no fixture output for seed ${seed}`)
    }
    return output
  }
  if (provider === "claude") {
    const replayPrompt = buildReadOnlyPrompt(prompt)
    const result = spawnSync(
      "claude",
      [
        "--disallowedTools",
        "Bash,Edit,MultiEdit,Write,Read,Glob,Grep,LS,NotebookEdit,WebFetch,WebSearch",
        "--strict-mcp-config",
        "--mcp-config",
        '{"mcpServers":{}}',
        "--no-session-persistence",
        "--input-format",
        "text",
        "-p",
      ],
      {
        input: replayPrompt,
        encoding: "utf8",
        maxBuffer: 1024 * 1024 * 20,
        timeout: 120_000,
      }
    )
    if (result.error) {
      throw result.error
    }
    if (result.status !== 0) {
      throw new Error(result.stderr || `claude -p exited with status ${result.status}`)
    }
    return result.stdout
  }
  throw new Error(`Unsupported provider: ${provider}`)
}

async function loadPromptBuilder() {
  const builtPath = path.resolve(__dirname, "../../dist/hooks/prompts.js")
  try {
    return await import(pathToFileURL(builtPath).href)
  } catch (error) {
    throw new Error(
      `Could not load ${builtPath}. Run npm run build before this benchmark. ${error.message}`
    )
  }
}

const args = parseArgs(process.argv.slice(2))
const corpus = JSON.parse(await readFile(args.corpus, "utf8"))
const { buildBackgroundSavePrompt } = await loadPromptBuilder()

const runs = []
for (const seed of args.seeds) {
  const caseResults = []
  for (const testCase of corpus.cases) {
    const transcript = await resolveTranscript(testCase)
    const prompt = buildBackgroundSavePrompt(
      testCase.subProjects ?? corpus.subProjects ?? [],
      testCase.catchAllName ?? corpus.catchAllName ?? null,
      transcript,
      `memory-quality-${testCase.id}-${seed}`,
      "memory-quality-eval",
      { extractLearnings: true, proposeLearnings: false }
    )
    assertPromptQualityGate(prompt, testCase.id)
    if (!prompt.includes("[Lore autosave]")) {
      throw new Error(`Case ${testCase.id} did not render an autosave prompt`)
    }
    const output = runProvider(args.provider, prompt, testCase, seed)
    caseResults.push({
      id: testCase.id,
      promptSha256: sha256(prompt),
      outputSha256: sha256(output),
      candidates: scoreCase(output, testCase),
    })
  }
  const scored = scoreRun(caseResults)
  runs.push({
    seed,
    ...scored,
    cases: caseResults,
  })
}

const result = {
  corpus: path.relative(process.cwd(), path.resolve(args.corpus)),
  provider: args.provider,
  seeds: args.seeds,
  aggregate: summarize(runs),
  runs,
}

if (args.thresholds) {
  checkThresholds(result.aggregate)
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`provider=${result.provider} corpus=${result.corpus}`)
  for (const [metric, values] of Object.entries(result.aggregate)) {
    const avg = values.mean === null ? "n/a" : values.mean.toFixed(3)
    const sd = values.stddev === null ? "n/a" : values.stddev.toFixed(3)
    console.log(`${metric}: mean=${avg} stddev=${sd}`)
  }
}
