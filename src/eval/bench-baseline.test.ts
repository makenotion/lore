import { describe, expect, it } from "vitest"
import {
  BenchBaselineConfigMismatchError,
  buildBenchBaselineSnapshot,
  canonicalJsonStringify,
  compareBenchBaseline,
  computeConfigHash,
} from "./bench-baseline.js"
import type { BenchRunArtifact } from "./bench-runner-types.js"

function buildArtifact(overrides: Partial<BenchRunArtifact> = {}): BenchRunArtifact {
  const base: BenchRunArtifact = {
    suite: "longmemeval-baseline",
    benchmark: "longmemeval",
    runner: "bench",
    runId: "01HXYZ4QK7Z2P8E3K0R5T9N1WM",
    config: {
      corpus: {
        name: "longmemeval_s_cleaned",
        source: "huggingface",
        repository: "xiaowu0162/longmemeval-cleaned",
        revision: "abc",
        sha256: "f".repeat(64),
      },
      agent: {
        model: "gpt-4o-mini-2024-07-18",
        adapter: "codex",
        systemPromptSha256: "a".repeat(64),
        retrieval: "tool-driven",
      },
      judge: {
        model: "gpt-4o-2024-08-06",
        temperature: 0,
        seed: 17,
        maxTokens: 256,
        promptShas: { recall: "b".repeat(64), abstention: "c".repeat(64) },
      },
      ingestion: {
        strategy: "lore-mine",
        memoryCaptureMode: "durable",
        seam: "runConversationMining",
        temporalApproach: "C-caveat-only",
        vault: "bench-sandbox",
      },
      caps: {
        perExampleWrites: 500,
        perSuiteWrites: 250000,
      },
    },
    startedAt: "2026-05-13T06:00:00Z",
    finishedAt: "2026-05-13T08:00:00Z",
    results: [
      {
        exampleId: "lme_s_0001",
        category: "single-session-user",
        success: true,
        failureReason: null,
        cleanupFailure: null,
        ingestion: {
          tokensInput: 0,
          extractionTokensPrompt: 0,
          extractionTokensPromptCached: 0,
          extractionTokensCompletion: 0,
          extractionCostUsd: 0,
          extractionCostMeasurement: "not-applicable",
          memoriesCreated: 1,
          factsCreated: 0,
          notionWrites: 1,
          writeBudgetExceeded: false,
          elapsedMs: 1000,
        },
        agent: {
          elapsedMs: 100,
          tokensPrompt: 100,
          tokensCachedPrompt: 0,
          tokensCompletion: 50,
          tokensReasoningOutput: 0,
          toolCalls: 1,
          retrieval: {
            strategy: "tool-driven",
            surface: "codex-shell-shim",
            firstRetrievalTiming: "during-agent-run",
            calls: [],
          },
          answer: "x",
          costMeasurement: "codex-reported",
        },
        judge: {
          promptKind: "recall",
          verdict: "correct",
          rationale: "ok",
          elapsedMs: 100,
          tokensPrompt: 100,
          tokensPromptCached: 0,
          tokensCompletion: 20,
        },
      },
    ],
    summary: {
      configHash: "REPLACED-BELOW",
      totalExamples: 1,
      scoredExamples: 1,
      temporalFidelityCaveat: "...",
      diagnosticCountCaveat: "...",
      byCategory: {
        "single-session-user": { n: 1, correct: 1, accuracy: 1.0 },
        "single-session-assistant": { n: 0, correct: 0, accuracy: 0 },
        "single-session-preference": { n: 0, correct: 0, accuracy: 0 },
        "multi-session": { n: 0, correct: 0, accuracy: 0 },
        "knowledge-update": { n: 0, correct: 0, accuracy: 0 },
        "temporal-reasoning": { n: 0, correct: 0, accuracy: 0 },
        abstention: { n: 0, correct: 0, accuracy: 0 },
      },
      overall: {
        n: 1,
        scoredN: 1,
        correct: 1,
        accuracy: 1.0,
        ingestion: { p50Ms: 1000, p95Ms: 1000, totalNotionWrites: 1 },
        agent: { p50Ms: 100, p95Ms: 100 },
        judge: { p50Ms: 100, p95Ms: 100 },
        cost: {
          agentUsd: 0,
          judgeUsd: 0,
          extractionUsd: 0,
          runnerMeasuredUsd: 0,
          ingestionEstimatedUsd: 0,
          totalEstimatedUsd: 0,
        },
      },
      failureBreakdown: {
        "no-failure": 1,
        "ingestion-error": 0,
        "write-cap-exceeded": 0,
        "adapter-refused": 0,
        "agent-timeout": 0,
        "agent-exit": 0,
        "empty-answer": 0,
        "agent-token-usage-missing": 0,
        "judge-error": 0,
        "notion-rate-limit": 0,
        "cost-cap": 0,
        "mining-timeout": 0,
      },
      cleanupFailures: [],
      aborted: false,
      abortReason: null,
    },
    ...overrides,
  }
  base.summary.configHash = computeConfigHash(base.config)
  return base
}

describe("canonicalJsonStringify", () => {
  it("produces deterministic key ordering", () => {
    const a = { b: 1, a: 2, c: { y: 1, x: 2 } }
    const b = { c: { x: 2, y: 1 }, a: 2, b: 1 }
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b))
  })
})

describe("computeConfigHash", () => {
  it("returns a 64-char hex string", () => {
    const hash = computeConfigHash({ foo: "bar" })
    expect(hash).toMatch(/^[a-f0-9]{64}$/)
  })

  it("changes when judge.seed changes (forces baseline re-capture)", () => {
    // The judge seed is sent on every OpenAI call and determines
    // verdict reproducibility. A bump must force a baseline
    // re-capture, which is gated by `configHash` mismatch — so the
    // seed MUST participate in the hash.
    const baseline = buildArtifact().config
    const modified = {
      ...baseline,
      judge: { ...baseline.judge, seed: baseline.judge.seed + 1 },
    }
    expect(computeConfigHash(modified)).not.toBe(computeConfigHash(baseline))
  })

  it("changes when judge.maxTokens changes", () => {
    const baseline = buildArtifact().config
    const modified = {
      ...baseline,
      judge: { ...baseline.judge, maxTokens: baseline.judge.maxTokens * 2 },
    }
    expect(computeConfigHash(modified)).not.toBe(computeConfigHash(baseline))
  })

  it("changes when caps.perExampleWrites changes", () => {
    const baseline = buildArtifact().config
    const modified = {
      ...baseline,
      caps: { ...baseline.caps, perExampleWrites: baseline.caps.perExampleWrites + 1 },
    }
    expect(computeConfigHash(modified)).not.toBe(computeConfigHash(baseline))
  })

  it("changes when caps.perSuiteWrites changes", () => {
    const baseline = buildArtifact().config
    const modified = {
      ...baseline,
      caps: { ...baseline.caps, perSuiteWrites: baseline.caps.perSuiteWrites + 1 },
    }
    expect(computeConfigHash(modified)).not.toBe(computeConfigHash(baseline))
  })

  it("changes when ingestion memoryCaptureMode changes", () => {
    const baseline = buildArtifact().config
    const modified = {
      ...baseline,
      ingestion: { ...baseline.ingestion, memoryCaptureMode: "conversational" },
    }
    expect(computeConfigHash(modified)).not.toBe(computeConfigHash(baseline))
  })

  it("changes when simulated-autosave extraction config changes", () => {
    const baseline = {
      ...buildArtifact().config,
      ingestion: {
        strategy: "simulated-autosave",
        memoryCaptureMode: "durable",
        seam: "structured-extract-create-with-auto-mentions",
        temporalApproach: "C-caveat-only",
        vault: "bench-sandbox",
        extractionModel: "gpt-4o-mini-2024-07-18",
        extractionPromptSha256: "1".repeat(64),
        extractionTemperature: 0,
        extractionMaxTokens: 1000,
        extractionSchemaVersion: 1,
      },
    }
    const variants = [
      {
        ...baseline,
        ingestion: { ...baseline.ingestion, extractionModel: "other-model" },
      },
      {
        ...baseline,
        ingestion: { ...baseline.ingestion, extractionPromptSha256: "2".repeat(64) },
      },
      {
        ...baseline,
        ingestion: { ...baseline.ingestion, extractionTemperature: 0.1 },
      },
      {
        ...baseline,
        ingestion: { ...baseline.ingestion, extractionMaxTokens: 1001 },
      },
      {
        ...baseline,
        ingestion: { ...baseline.ingestion, extractionSchemaVersion: 2 },
      },
    ]
    const baselineHash = computeConfigHash(baseline)
    for (const variant of variants) {
      expect(computeConfigHash(variant)).not.toBe(baselineHash)
    }
  })
})

describe("buildBenchBaselineSnapshot + compareBenchBaseline", () => {
  it("round-trips through capture and compare with no drift", () => {
    const artifact = buildArtifact()
    const snapshot = buildBenchBaselineSnapshot(artifact)
    const drift = compareBenchBaseline({ artifact, baseline: snapshot })
    expect(drift.regressed).toBe(false)
    expect(drift.reasons).toHaveLength(0)
  })

  it("flags per-example regression when previously-correct turns incorrect", () => {
    const artifact = buildArtifact()
    const snapshot = buildBenchBaselineSnapshot(artifact)
    const regressed = buildArtifact({
      results: [
        {
          ...artifact.results[0]!,
          success: false,
          failureReason: "judge-error",
        },
      ],
    })
    // Force same configHash so the test isolates the per-example gate.
    regressed.summary.configHash = snapshot.configHash
    const drift = compareBenchBaseline({ artifact: regressed, baseline: snapshot })
    expect(drift.regressed).toBe(true)
    expect(drift.regressedExamples).toEqual(["lme_s_0001"])
  })

  it("throws BenchBaselineConfigMismatchError on config-hash drift", () => {
    const artifact = buildArtifact()
    const snapshot = buildBenchBaselineSnapshot(artifact)
    const driftedArtifact = buildArtifact()
    driftedArtifact.summary.configHash = "0".repeat(64)
    expect(() =>
      compareBenchBaseline({ artifact: driftedArtifact, baseline: snapshot })
    ).toThrow(BenchBaselineConfigMismatchError)
  })

  it("flags abort as regression", () => {
    const artifact = buildArtifact()
    const snapshot = buildBenchBaselineSnapshot(artifact)
    const aborted = buildArtifact()
    aborted.summary.aborted = true
    aborted.summary.abortReason = "cost cap reached"
    aborted.summary.configHash = snapshot.configHash
    const drift = compareBenchBaseline({ artifact: aborted, baseline: snapshot })
    expect(drift.regressed).toBe(true)
    expect(drift.reasons.some((r) => /abort/.test(r))).toBe(true)
  })

  it("flags per-category accuracy drop greater than tolerance", () => {
    const artifact = buildArtifact()
    artifact.summary.byCategory["single-session-user"] = {
      n: 100,
      correct: 90,
      accuracy: 0.9,
    }
    const snapshot = buildBenchBaselineSnapshot(artifact)
    const regressed = buildArtifact()
    regressed.summary.byCategory["single-session-user"] = {
      n: 100,
      correct: 80,
      accuracy: 0.8,
    }
    regressed.summary.configHash = snapshot.configHash
    const drift = compareBenchBaseline({ artifact: regressed, baseline: snapshot })
    expect(drift.regressed).toBe(true)
    expect(drift.reasons.some((r) => /single-session-user/.test(r))).toBe(true)
  })
})
