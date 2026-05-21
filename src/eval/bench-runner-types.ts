/**
 * Shared type definitions for the LongMemEval bench runner.
 *
 * The artifact shape, per-result types, and failure-reason union are
 * the wire contract between the runner, the baseline module, the
 * tests, and any downstream CI workflow. Keeping them in a separate
 * file avoids cyclic imports between `bench-runner.ts` and
 * `bench-baseline.ts`.
 */

import type { JudgePromptKind, JudgeVerdict } from "./bench-judge.js"
import type { LongMemEvalCategory } from "./bench-corpus.js"

/**
 * Scoring-relevant per-result failure reasons.
 *
 * Cleanup / archive failures do NOT live here — those land in
 * `BenchExampleResult.cleanupFailure`. A correctly-scored example with
 * a cleanup failure stays `success: true, failureReason: null`.
 */
export type BenchFailureReason =
  | "ingestion-error"
  | "write-cap-exceeded"
  | "adapter-refused"
  | "agent-timeout"
  | "agent-exit"
  | "empty-answer"
  | "agent-token-usage-missing"
  | "judge-error"
  | "notion-rate-limit"
  | "cost-cap"
  | "mining-timeout"

export const COST_MEASUREMENT_CODEX_REPORTED = "codex-reported" as const
export type CostMeasurement = typeof COST_MEASUREMENT_CODEX_REPORTED
export const EXTRACTION_COST_MEASUREMENT_OPENAI_REPORTED = "openai-reported" as const
export const EXTRACTION_COST_MEASUREMENT_NOT_APPLICABLE = "not-applicable" as const
export type ExtractionCostMeasurement =
  | typeof EXTRACTION_COST_MEASUREMENT_OPENAI_REPORTED
  | typeof EXTRACTION_COST_MEASUREMENT_NOT_APPLICABLE

export interface BenchExampleIngestion {
  tokensInput: number
  extractionTokensPrompt: number
  extractionTokensPromptCached: number
  extractionTokensCompletion: number
  extractionCostUsd: number
  extractionCostMeasurement: ExtractionCostMeasurement
  memoriesCreated: number
  factsCreated: number
  notionWrites: number
  writeBudgetExceeded: boolean
  elapsedMs: number
}

export interface BenchExampleAgent {
  elapsedMs: number
  tokensPrompt: number
  /**
   * Cached portion of `tokensPrompt` per Codex `turn.completed`
   * `usage.cached_input_tokens`. The cost module charges this at
   * `cachedInputPer1K` and the remainder at `inputPer1K`. Pinning a
   * separate field keeps the artifact stable when an example's cached
   * fraction shifts; the legacy artifact shape would silently shift
   * `cost.agentUsd` while showing the same `tokensPrompt`.
   */
  tokensCachedPrompt: number
  tokensCompletion: number
  /**
   * Reasoning-output tokens from Codex `turn.completed`
   * `usage.reasoning_output_tokens`. Priced at `reasoningOutputPer1K`,
   * distinct from regular output tokens (some models charge them at
   * a higher rate).
   */
  tokensReasoningOutput: number
  toolCalls: number
  answer: string
  costMeasurement: CostMeasurement
}

export interface BenchExampleJudge {
  promptKind: JudgePromptKind
  verdict: JudgeVerdict | null
  rationale: string
  elapsedMs: number
  tokensPrompt: number
  tokensPromptCached: number
  tokensCompletion: number
}

export interface BenchExampleResult {
  exampleId: string
  category: LongMemEvalCategory
  success: boolean
  failureReason: BenchFailureReason | null
  cleanupFailure: string | null
  ingestion: BenchExampleIngestion
  agent: BenchExampleAgent
  judge: BenchExampleJudge
}

export interface BenchSummaryCategoryStat {
  n: number
  correct: number
  accuracy: number
}

export interface BenchSummaryCost {
  agentUsd: number
  judgeUsd: number
  extractionUsd: number
  runnerMeasuredUsd: number
  ingestionEstimatedUsd: number
  totalEstimatedUsd: number
}

export interface BenchSummaryOverall {
  n: number
  scoredN: number
  correct: number
  accuracy: number
  ingestion: {
    p50Ms: number
    p95Ms: number
    totalNotionWrites: number
  }
  agent: { p50Ms: number; p95Ms: number }
  judge: { p50Ms: number; p95Ms: number }
  cost: BenchSummaryCost
}

export interface BenchSummary {
  configHash: string
  totalExamples: number
  scoredExamples: number
  temporalFidelityCaveat: string
  diagnosticCountCaveat: string
  byCategory: Record<string, BenchSummaryCategoryStat>
  overall: BenchSummaryOverall
  failureBreakdown: Record<BenchFailureReason | "no-failure", number>
  cleanupFailures: string[]
  aborted: boolean
  abortReason: string | null
}

export interface BenchArtifactConfig {
  profile?: {
    selector: string
    name: string
    version: string
    source: string
    manifestDigest: string
    promptHashes: Record<string, string>
  }
  corpus: {
    name: string
    source: string
    repository: string
    revision: string
    sha256: string
  }
  agent: {
    model: string
    adapter: string
    systemPromptSha256: string
    /**
     * Which retrieval surface the agent had at run time. `tool-driven`
     * exposes MCP tools; `wake-up-prefetch` injects a pre-fetched
     * task-only relevance bundle into the prompt and does not require MCP.
     * See `BENCH_AGENT_RETRIEVAL_STRATEGIES` in `eval/schema.ts`.
     */
    retrieval: string
  }
  judge: {
    model: string
    temperature: number
    /**
     * Deterministic-judge seed forwarded to OpenAI on every call.
     * Participates in `configHash` because a seed bump changes the
     * verdict distribution and must force a baseline re-capture.
     */
    seed: number
    /**
     * Per-judge-call output cap forwarded to OpenAI. Participates in
     * `configHash` because raising the cap can let the judge emit a
     * longer rationale that flips a borderline verdict; lowering can
     * truncate JSON output and surface judge-error failures.
     */
    maxTokens: number
    promptShas: {
      recall: string
      abstention: string
    }
  }
  ingestion: {
    strategy: string
    seam: string
    temporalApproach: string
    vault: string
    extractionModel?: string
    extractionPromptSha256?: string
    extractionTemperature?: number
    extractionMaxTokens?: number
    extractionSchemaVersion?: number
  }
  /**
   * Suite write caps. `perExampleWrites` installs the MCP-child
   * write-budget cap AND the raw-transcript loop's per-example halt
   * threshold; `perSuiteWrites` controls when the runner aborts
   * mid-suite. Both shape run behavior, so both participate in
   * `configHash` — a cap retune that changes ingestion completeness
   * or abort behavior must force a baseline re-capture.
   */
  caps: {
    perExampleWrites: number
    perSuiteWrites: number
  }
}

export interface BenchRunArtifact {
  suite: string
  benchmark: "longmemeval"
  runner: "bench"
  runId: string
  config: BenchArtifactConfig
  startedAt: string
  finishedAt: string
  results: BenchExampleResult[]
  summary: BenchSummary
}

/**
 * The two caveat strings live as exported constants so the artifact
 * surface (`summary.temporalFidelityCaveat` / `diagnosticCountCaveat`)
 * and any downstream renderer share one source. The strings are
 * self-contained: a reader landing on the artifact's caveat field
 * must understand the contract without chasing a docs URL. Adding a
 * doc-path suffix would silently rot if the docs file moved or its
 * sections renamed.
 */
export const TEMPORAL_FIDELITY_CAVEAT =
  "Lore's Memory schema has no caller-writable session-timestamp column, " +
  "so the temporal-reasoning and knowledge-update scores measure " +
  "agent-recovers-temporal-context-from-body-text, not Lore-ranks-by-event-time."

export const DIAGNOSTIC_COUNT_CAVEAT =
  "ingestion.memoriesCreated and ingestion.factsCreated are diagnostic counts " +
  "via listAllForBackfill({ projectId }); the iterator may include vault-wide " +
  "unscoped rows. The authoritative per-example write count is ingestion.notionWrites."
