import { describe, expect, it } from "vitest"
import {
  collectProfileThresholdFailures,
  scoreProfileExtraction,
  type ProfileExtractionOutput,
  type ProfileMetricThresholds,
} from "./profile-scorer.js"
import { resolveProfileFromConfig } from "../profile/index.js"

const thresholds: ProfileMetricThresholds = {
  entityKindRecallMin: 0.8,
  predicatePrecisionMin: 0.85,
  hallucinatedFactRateMax: 0.05,
  requiredFieldCompletenessMin: 0.9,
  invalidTaxonomyRateMax: 0,
}

function supportOutput(overrides: Partial<ProfileExtractionOutput> = {}) {
  const base: ProfileExtractionOutput = {
    memories: [
      {
        title: "Acme API export timeout escalation",
        synopsis: "Acme Workspace reports API export timeouts.",
        tags: ["customer-report", "api", "latency"],
        content: "SUP-1024 affects API export and is owned by API Platform.",
        entities: [
          { name: "SUP-1024", kind: "support-ticket" },
          { name: "API Platform", kind: "team" },
        ],
        facts: [
          {
            subject: "SUP-1024",
            predicate: "affects",
            object: "API export",
            evidence: "Ticket reports API export requests timing out.",
          },
          {
            subject: "SUP-1024",
            predicate: "owned_by",
            object: "API Platform",
            evidence: "API Platform owns the escalation.",
          },
        ],
      },
    ],
  }
  return { ...base, ...overrides }
}

describe("scoreProfileExtraction", () => {
  it("passes all support thresholds for a matching extraction", () => {
    const profile = resolveProfileFromConfig({ profile: "support@1.0.0" })
    const metrics = scoreProfileExtraction({
      expected: supportOutput(),
      actual: supportOutput(),
      taxonomy: profile.taxonomy,
      writableFactPredicates: profile.taxonomy.writableFactPredicates,
    })

    expect(metrics.entityKindRecall).toBe(1)
    expect(metrics.predicatePrecision).toBe(1)
    expect(metrics.hallucinatedFactRate).toBe(0)
    expect(metrics.requiredFieldCompleteness).toBe(1)
    expect(metrics.invalidTaxonomyRate).toBe(0)
    expect(collectProfileThresholdFailures(metrics, thresholds)).toEqual([])
  })

  it("fails loudly for wrong entity kinds, hallucinated facts, and invalid taxonomy", () => {
    const profile = resolveProfileFromConfig({ profile: "support@1.0.0" })
    const actual = supportOutput({
      memories: [
        {
          ...supportOutput().memories[0]!,
          tags: ["customer-report", "engineering"],
          entities: [
            { name: "SUP-1024", kind: "task-id" },
            { name: "API Platform", kind: "team" },
          ],
          facts: [
            {
              subject: "SUP-1024",
              predicate: "affects",
              object: "API export",
              evidence: "Ticket reports API export requests timing out.",
            },
            {
              subject: "SUP-1024",
              predicate: "blocked_by",
              object: "Release train",
              evidence: "",
            },
          ],
        },
      ],
    })

    const metrics = scoreProfileExtraction({
      expected: supportOutput(),
      actual,
      taxonomy: profile.taxonomy,
      writableFactPredicates: profile.taxonomy.writableFactPredicates,
    })
    const failures = collectProfileThresholdFailures(metrics, thresholds)

    expect(metrics.entityKindRecall).toBe(0.5)
    expect(metrics.hallucinatedFactRate).toBe(0.5)
    expect(metrics.invalidTaxonomyRate).toBeGreaterThan(0)
    expect(failures.join("\n")).toContain("Entity-kind recall")
    expect(failures.join("\n")).toContain("Hallucinated-fact rate")
    expect(failures.join("\n")).toContain("Invalid-taxonomy rate")
  })
})
