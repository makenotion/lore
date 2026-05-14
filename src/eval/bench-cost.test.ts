import { describe, expect, it } from "vitest"
import {
  computeAgentCostUsd,
  computeExtractionCostUsd,
  computeJudgeCostUsd,
  estimateIngestionCostUsd,
  parseCodexUsage,
  projectedTotalUsd,
} from "./bench-cost.js"

describe("parseCodexUsage", () => {
  it("returns null for missing or non-object input", () => {
    expect(parseCodexUsage(null)).toBeNull()
    expect(parseCodexUsage(undefined)).toBeNull()
    expect(parseCodexUsage("not-an-object")).toBeNull()
  })

  it("returns null when any token field is missing", () => {
    expect(
      parseCodexUsage({
        input_tokens: 10,
        cached_input_tokens: 0,
        output_tokens: 20,
        // reasoning_output_tokens missing
      })
    ).toBeNull()
  })

  it("parses well-formed usage payload", () => {
    const result = parseCodexUsage({
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 200,
      reasoning_output_tokens: 25,
    })
    expect(result).toEqual({
      input_tokens: 100,
      cached_input_tokens: 50,
      output_tokens: 200,
      reasoning_output_tokens: 25,
    })
  })
})

describe("computeAgentCostUsd", () => {
  const pricing = {
    inputPer1K: 0.001,
    cachedInputPer1K: 0.0005,
    outputPer1K: 0.002,
    reasoningOutputPer1K: 0.004,
  }
  it("charges (input - cached) at input rate + cached at cached rate", () => {
    // Codex `input_tokens` is the TOTAL prompt count;
    // `cached_input_tokens` is the cached portion OF that total.
    // Charging both at full rates would double-bill the cached
    // portion. 3000 total with 1000 cached → 2000 uncached × input +
    // 1000 × cached.
    const cost = computeAgentCostUsd(
      {
        input_tokens: 3000,
        cached_input_tokens: 1000,
        output_tokens: 500,
        reasoning_output_tokens: 250,
      },
      pricing
    )
    expect(cost).toBeCloseTo(2 * 0.001 + 1 * 0.0005 + 0.5 * 0.002 + 0.25 * 0.004)
  })

  it("treats cached = 0 as 'no cached portion' (all input at input rate)", () => {
    const cost = computeAgentCostUsd(
      {
        input_tokens: 1000,
        cached_input_tokens: 0,
        output_tokens: 500,
        reasoning_output_tokens: 0,
      },
      pricing
    )
    expect(cost).toBeCloseTo(1 * 0.001 + 0.5 * 0.002)
  })

  it("clamps cached > input to 0 uncached (defensive — Codex contract is cached <= input)", () => {
    const cost = computeAgentCostUsd(
      {
        input_tokens: 100,
        cached_input_tokens: 200,
        output_tokens: 0,
        reasoning_output_tokens: 0,
      },
      pricing
    )
    // 0 uncached at full rate; 200 cached at cached rate. The clamp
    // prevents a malformed Codex usage from producing a negative
    // cost component.
    expect(cost).toBeCloseTo(0.2 * 0.0005)
  })
})

describe("computeJudgeCostUsd", () => {
  it("uses input rate for prompt and output rate for completion", () => {
    const pricing = {
      inputPer1K: 0.005,
      cachedInputPer1K: 0.0025,
      outputPer1K: 0.02,
      reasoningOutputPer1K: 0.02,
    }
    const cost = computeJudgeCostUsd(
      { promptTokens: 2000, completionTokens: 100 },
      pricing
    )
    expect(cost).toBeCloseTo(2 * 0.005 + 0.1 * 0.02)
  })
})

describe("computeExtractionCostUsd", () => {
  it("charges OpenAI-reported extraction usage with cached prompt discount", () => {
    const pricing = {
      inputPer1K: 0.001,
      cachedInputPer1K: 0.0005,
      outputPer1K: 0.002,
      reasoningOutputPer1K: 0.002,
    }
    const cost = computeExtractionCostUsd(
      {
        promptTokens: 3000,
        cachedPromptTokens: 1000,
        completionTokens: 500,
      },
      pricing
    )
    expect(cost).toBeCloseTo(2 * 0.001 + 1 * 0.0005 + 0.5 * 0.002)
  })
})

describe("estimateIngestionCostUsd", () => {
  it("scales sessions by per-session pricing", () => {
    const pricing = {
      models: {},
      ingestion: {
        perSessionEstimatedUsd: 0.02,
        calibrationSource: "committed-estimate",
        calibratedAt: "pending",
      },
    }
    expect(estimateIngestionCostUsd(40, pricing)).toBeCloseTo(0.8)
  })
})

describe("projectedTotalUsd", () => {
  it("sums all measured and estimated components", () => {
    expect(
      projectedTotalUsd({
        agentUsdSoFar: 1.2,
        judgeUsdSoFar: 0.4,
        extractionUsdSoFar: 0.3,
        ingestionEstimatedUsdSoFar: 2.0,
      })
    ).toBeCloseTo(3.9)
  })
})
