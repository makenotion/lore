import { createHash } from "node:crypto"
import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { resolveProfileFromConfig, type ProfilePromptKey } from "../profile/index.js"
import { loadProfileEvalSuite, type ProfileEvalSuite } from "./schema.js"
import {
  collectProfileThresholdFailures,
  mergeProfileMetricCounts,
  profileMetricsFromCounts,
  scoreProfileExtraction,
  type ProfileMetricBreakdown,
  type ProfileMetricThresholds,
} from "./profile-scorer.js"

export interface ProfileEvalCaseResult {
  id: string
  metrics: ProfileMetricBreakdown
  failures: string[]
}

export interface ProfileEvalArtifact {
  suite: string
  runner: "profile"
  profile: {
    selector: string
    name: string
    version: string
    source: string
    manifestDigest: string
    promptHashes: Record<ProfilePromptKey, string>
  }
  startedAt: string
  finishedAt: string
  thresholds: ProfileMetricThresholds
  results: ProfileEvalCaseResult[]
  summary: {
    cases: number
    passedCases: number
    failedCases: number
    metrics: ProfileMetricBreakdown
    failures: string[]
  }
}

export interface RunProfileEvalOptions {
  outPath?: string
  now?: () => Date
}

export async function runProfileEvalSuite(
  suitePath: string,
  options: RunProfileEvalOptions = {}
): Promise<{ artifact: ProfileEvalArtifact; outPath: string }> {
  const loaded = await loadProfileEvalSuite(suitePath)
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const profile = resolveProfileFromConfig({ profile: loaded.suite.profile })
  const thresholds = loaded.suite.thresholds

  const results = loaded.suite.cases.map((testCase) => {
    const metrics = scoreProfileExtraction({
      expected: testCase.expected,
      actual: testCase.actual,
      taxonomy: profile.taxonomy,
      writableFactPredicates: profile.taxonomy.writableFactPredicates,
    })
    return {
      id: testCase.id,
      metrics,
      failures: collectProfileThresholdFailures(metrics, thresholds),
    }
  })

  const summaryMetrics = profileMetricsFromCounts(
    mergeProfileMetricCounts(results.map((result) => result.metrics.counts))
  )
  const failures = collectProfileThresholdFailures(summaryMetrics, thresholds)
  const finishedAt = now().toISOString()
  const artifact: ProfileEvalArtifact = {
    suite: loaded.suite.suite,
    runner: "profile",
    profile: {
      selector: profile.selector,
      name: profile.name,
      version: profile.version,
      source: profile.source,
      manifestDigest: profile.manifestDigest,
      promptHashes: promptHashes(profile.prompts),
    },
    startedAt,
    finishedAt,
    thresholds,
    results,
    summary: {
      cases: results.length,
      passedCases: results.filter((result) => result.failures.length === 0).length,
      failedCases: results.filter((result) => result.failures.length > 0).length,
      metrics: summaryMetrics,
      failures,
    },
  }

  const outPath = resolve(
    options.outPath ?? `evals/results/profile-${loaded.suite.suite}.json`
  )
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")
  return { artifact, outPath }
}

export function buildProfileEvalConfig(input: { suite: ProfileEvalSuite }): {
  profile: string
  thresholds: ProfileMetricThresholds
} {
  return {
    profile: input.suite.profile,
    thresholds: input.suite.thresholds,
  }
}

function promptHashes(
  prompts: ReturnType<typeof resolveProfileFromConfig>["prompts"]
): Record<ProfilePromptKey, string> {
  const out = {} as Record<ProfilePromptKey, string>
  for (const [key, prompt] of Object.entries(prompts) as Array<
    [ProfilePromptKey, { text: string }]
  >) {
    out[key] = sha256(prompt.text)
  }
  return out
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex")
}
