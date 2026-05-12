import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { describe, expect, it } from "vitest"
import type { WakeUpServices } from "../core/wakeup.js"
import { STALE_CONFIDENCE_LIMIT } from "../types.js"
import { runEvalSuite, type EvalRunArtifact } from "./runner.js"

describe("runEvalSuite", () => {
  it("runs the starter retrieval suite and writes a JSON artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-"))
    const outPath = join(dir, "result.json")

    const { artifact, outPath: writtenPath } = await runEvalSuite(
      "evals/suites/lore-core.yaml",
      {
        outPath,
        now: new Date("2026-05-03T12:00:00.000Z"),
      }
    )

    expect(writtenPath).toBe(outPath)
    expect(artifact.summary).toMatchObject({
      tasks: 21,
      trials: 1,
      totalResults: 69,
      passedResults: 69,
      failedResults: 0,
    })
    expect(artifact.summary.scenarios).toEqual([
      "empty-lore",
      "helpful-memory",
      "no-lore",
      "noisy-memory",
      "stale-memory",
    ])
    expect(artifact.runner).toMatchObject({
      mode: "retrieval",
      surfaces: [
        "wake-up.memories",
        "wake-up.relatedMemories",
        "wake-up.staleConfidence",
        "wake-up.taskMemories",
      ],
      requestedTrials: 1,
      executedTrials: 1,
    })
    expect(artifact.summary.retrieval.memoryLift).toBe(1)
    expect(artifact.summary.retrieval.memoryHarm).toBe(0)

    const persisted = JSON.parse(await readFile(outPath, "utf-8")) as EvalRunArtifact
    expect(persisted.startedAt).toBe("2026-05-03T12:00:00.000Z")
    expect(
      persisted.results.find(
        (result) =>
          result.taskId === "respects-governing-auth-decision" &&
          result.scenario === "helpful-memory"
      )
    ).toMatchObject({
      expectedMemoriesSurfaced: ["decision/auth-model"],
      missingExpectedMemories: [],
    })
    expect(
      persisted.results.find(
        (result) =>
          result.taskId === "respects-governing-auth-decision" &&
          result.scenario === "stale-memory"
      )
    ).toMatchObject({
      success: true,
      missingExpectedMemories: [],
      unexpectedMemoriesSurfaced: [],
    })
  })

  it("rejects trial overrides for deterministic retrieval mode", async () => {
    await expect(
      runEvalSuite("evals/suites/lore-core.yaml", {
        trials: 3,
      })
    ).rejects.toThrow("requires trials to be 1")
  })

  it("flags missing expected memories and surfaced forbidden memories", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": `name: helpful-memory
memories:
  - id: decision/expected
    title: Zeta orchard policy
    synopsis: Legacy context only.
  - id: note/billing-danger
    title: Billing token implementation note
    synopsis: A tempting but unrelated billing token path.
`,
      },
      suite: `version: 1
name: failure-suite
runner: retrieval
tasks:
  - id: fails-when-expected-memory-is-missing
    prompt: Implement the billing token flow.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/expected
        shouldNotSurface:
          - note/billing-danger
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.summary.failedResults).toBe(1)
    expect(
      artifact.results.find((result) => result.scenario === "helpful-memory")
    ).toMatchObject({
      success: false,
      missingExpectedMemories: ["decision/expected"],
      unexpectedMemoriesSurfaced: ["note/billing-danger"],
    })
  })

  it("reports zero lift when the noisy baseline also surfaces the expected memory", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "noisy.yaml": authDecisionScenario("noisy-memory"),
        "helpful.yaml": authDecisionScenario("helpful-memory"),
      },
      suite: `version: 1
name: zero-lift-suite
runner: retrieval
tasks:
  - id: noisy-baseline-finds-same-memory
    prompt: Follow the auth model decision.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      noisy-memory: ../memory/noisy.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/auth-model
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.summary.retrieval.memoryLift).toBe(0)
  })

  it("reports harm when noisy memory surfaces forbidden guidance", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "noisy.yaml": `name: noisy-memory
memories:
  - id: note/deprecated-auth
    title: Deprecated auth path
    synopsis: Use the retired auth path.
`,
        "helpful.yaml": authDecisionScenario("helpful-memory"),
      },
      suite: `version: 1
name: harm-suite
runner: retrieval
tasks:
  - id: noisy-memory-harms-task
    prompt: Follow the auth path decision.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      noisy-memory: ../memory/noisy.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      noisy-memory:
        shouldNotSurface:
          - note/deprecated-auth
      helpful-memory:
        shouldSurface:
          - decision/auth-model
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.summary.retrieval.memoryHarm).toBe(1)
    expect(
      artifact.results.find((result) => result.scenario === "noisy-memory")
    ).toMatchObject({
      success: false,
      unexpectedMemoriesSurfaced: ["note/deprecated-auth"],
    })
  })

  it("counts stale-memory in the harm aggregation when stale guidance surfaces", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "stale.yaml": `name: stale-memory
memories:
  # Status is intentionally not 'superseded' here so the fixture runner's
  # status filter does not drop it; the test pins that taskMemoryHarm
  # aggregates the stale-memory scenario, not that status filtering works.
  - id: decision/auth-jwt-pre-filter
    title: Bearer JWT auth path
    synopsis: Earlier auth path; tokens may still match a query.
    keywords: auth path bearer
`,
        "helpful.yaml": authDecisionScenario("helpful-memory"),
      },
      suite: `version: 1
name: stale-harm-suite
runner: retrieval
tasks:
  - id: stale-memory-harms-task
    prompt: Follow the auth path decision.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      stale-memory: ../memory/stale.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      stale-memory:
        shouldNotSurface:
          - decision/auth-jwt-pre-filter
      helpful-memory:
        shouldSurface:
          - decision/auth-model
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.summary.retrieval.memoryHarm).toBe(1)
    expect(
      artifact.results.find((result) => result.scenario === "stale-memory")
    ).toMatchObject({
      success: false,
      unexpectedMemoriesSurfaced: ["decision/auth-jwt-pre-filter"],
    })
  })

  it("suppresses superseded rows from fixture retrieval", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "stale.yaml": `name: stale-memory
memories:
  - id: decision/superseded-row
    title: Auth path decision
    status: superseded
    synopsis: Superseded; should be suppressed by the status filter.
    keywords: auth path decision
`,
        "helpful.yaml": authDecisionScenario("helpful-memory"),
      },
      suite: `version: 1
name: status-filter-suite
runner: retrieval
tasks:
  - id: status-filter-suppresses-superseded
    prompt: Follow the auth path decision.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      stale-memory: ../memory/stale.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      stale-memory:
        shouldNotSurface:
          - decision/superseded-row
      helpful-memory:
        shouldSurface:
          - decision/auth-model
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.summary.retrieval.memoryHarm).toBe(0)
    const stale = artifact.results.find((r) => r.scenario === "stale-memory")!
    expect(stale.success).toBe(true)
    expect(stale.surfacedMemoryIds).toEqual([])
  })

  it("extracts surfaced ids from the wake-up.memories recents section", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": `name: helpful-memory
memories:
  - id: decision/recent-architecture
    title: Architecture decision in flight
    synopsis: Authoritative recent decision.
    keywords: architecture decision
`,
      },
      suite: `version: 1
name: memories-suite
runner: retrieval
tasks:
  - id: surfaces-recent-decision
    prompt: Catch up on recent architectural choices.
    surface: wake-up.memories
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/recent-architecture
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.runner.surfaces).toEqual(["wake-up.memories"])
    expect(
      artifact.results.find((result) => result.scenario === "helpful-memory")
    ).toMatchObject({
      success: true,
      surfacedMemoryIds: ["decision/recent-architecture"],
      retrieval: { surface: "wake-up.memories" },
    })
  })

  it("extracts surfaced ids from the wake-up.relatedMemories surface", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": `name: helpful-memory
memories:
  - id: decision/payments-retry-policy
    title: Payments retry policy decision
    synopsis: How to retry payment intent failures.
    keywords: payments retry policy decision
tasks:
  - id: task/active-payments-followup
    subject: Payments retry policy follow-up
    entity: payments retry
`,
      },
      suite: `version: 1
name: related-suite
runner: retrieval
tasks:
  - id: surfaces-related-memory-from-active-task
    prompt: |
      Pick up where the team left off on payments work.
    surface: wake-up.relatedMemories
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/payments-retry-policy
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.runner.surfaces).toEqual(["wake-up.relatedMemories"])
    expect(
      artifact.results.find((result) => result.scenario === "helpful-memory")
    ).toMatchObject({
      success: true,
      surfacedMemoryIds: ["decision/payments-retry-policy"],
      retrieval: { surface: "wake-up.relatedMemories" },
    })
  })

  it("wake-up.relatedMemories enforces shouldNotSurface for distractors", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": `name: helpful-memory
memories:
  - id: decision/payments-retry-policy
    title: Payments retry policy decision
    keywords: payments retry policy decision
  - id: note/payments-distractor
    title: Payments retry distractor
    keywords: payments retry distractor
tasks:
  - id: task/active-payments-followup
    subject: Payments retry policy follow-up
    entity: payments retry
`,
      },
      suite: `version: 1
name: related-distractor-suite
runner: retrieval
tasks:
  - id: relatedmemories-rejects-distractor
    prompt: Pick up payments work.
    surface: wake-up.relatedMemories
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    retrieval:
      limit: 5
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/payments-retry-policy
        shouldNotSurface:
          - note/payments-distractor
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })
    const result = artifact.results.find((r) => r.scenario === "helpful-memory")!
    // Distractor shares enough tokens with the entity-seeded query to
    // surface; the suite-side assertion catches it. The test pins that
    // `shouldNotSurface` actually fires through the relatedMemories
    // extract path, not just on taskMemories.
    expect(result.success).toBe(false)
    expect(result.unexpectedMemoriesSurfaced).toContain("note/payments-distractor")
  })

  it("wake-up.memories enforces shouldNotSurface for distractors", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": `name: helpful-memory
memories:
  - id: decision/recent-architecture
    title: Architecture decision in flight
  - id: note/recents-distractor
    title: Distractor row
`,
      },
      suite: `version: 1
name: recents-distractor-suite
runner: retrieval
tasks:
  - id: memories-rejects-distractor
    prompt: Catch up on recent architectural choices.
    surface: wake-up.memories
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    retrieval:
      limit: 5
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/recent-architecture
        shouldNotSurface:
          - note/recents-distractor
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })
    const result = artifact.results.find((r) => r.scenario === "helpful-memory")!
    // memories.list emits both rows in fixture order; the
    // shouldNotSurface assertion fires on the second one. Pins that
    // the recents extract path threads `shouldNotSurface` through to
    // `buildRetrievalResult` correctly.
    expect(result.success).toBe(false)
    expect(result.unexpectedMemoriesSurfaced).toContain("note/recents-distractor")
  })

  it("notion runner exercises real services and surfaces a single live-vault scenario", async () => {
    // Build a stubbed `WakeUpServices` that mimics what the live Notion
    // runner would see. The same fixture-search is fine for a unit test;
    // the integration value of the notion runner is exercised against
    // production read-only flows separately.
    const liveMemories = [
      {
        id: "decision/live-vault-row",
        title: "Live vault decision",
        synopsis: "Authoritative live decision.",
        keywords: "live vault decision",
      },
    ]
    const stubServices: WakeUpServices = {
      memories: {
        list: async () => ({ items: [] }),
        search: async (input) => {
          // Token-overlap fixture-search to keep the test deterministic.
          const tokens = (input.query.toLowerCase().match(/[a-z0-9]+/g) ?? []).join(" ")
          return tokens.includes("live")
            ? (liveMemories.map((m) => ({
                id: m.id,
                title: m.title,
                projectIds: ["project-live"],
                topicId: null,
                source: "manual" as const,
                kind: "decision" as const,
                status: "accepted" as const,
                confidence: "certain" as const,
                confidenceScore: null,
                reviewBy: null,
                doneAt: null,
                decidedAt: null,
                lastReferencedAt: null,
                supersedesIds: [],
                affectsIds: [],
                alternatives: "",
                consequences: "",
                author: "",
                agent: "",
                tags: [],
                keywords: m.keywords,
                synopsis: m.synopsis,
                session: "",
                content: "",
                taskState: null,
                blockedBy: "",
                entity: "",
                topicKey: "",
                revisionCount: 1,
                comparedWith: [],
                compareNotes: "",
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
              })) as never[])
            : []
        },
        queryStaleConfidence: async () => [],
        countProposed: async () => ({ total: 0, bySource: {}, byAgent: {} }),
        listPinnedBlocks: async () => [],
        countPinnedBlocks: async () => 0,
      },
      facts: { listRecent: async () => ({ items: [], hasMore: false }) },
      decisions: {
        list: async () => ({ items: [], nextCursor: undefined }),
        queryOverdue: async () => [],
      },
      tasks: { list: async () => ({ items: [], nextCursor: undefined }) },
    }

    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": `name: helpful-memory
memories:
  - id: decision/live-vault-row
    title: Live vault decision
    synopsis: Authoritative live decision.
    keywords: live vault decision
`,
      },
      suite: `version: 1
name: notion-suite
runner: retrieval
tasks:
  - id: live-vault-task
    prompt: Surface the live vault decision.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/live-vault-row
`,
    })

    const { artifact } = await runEvalSuite(suitePath, {
      runner: "notion",
      outPath,
      notionServices: async () => ({
        services: stubServices,
        projectId: "project-live",
      }),
    })

    expect(artifact.runner.mode).toBe("notion")
    expect(artifact.summary.scenarios).toEqual(["live-vault"])
    expect(artifact.results).toHaveLength(1)
    expect(artifact.results[0]).toMatchObject({
      taskId: "live-vault-task",
      scenario: "live-vault",
      success: true,
      surfacedMemoryIds: ["decision/live-vault-row"],
    })
  })

  it("YAML-declared runner: notion drives notion mode when CLI omits --runner", async () => {
    // Pins the orchestrator wiring fix: a suite with `runner: notion`
    // declared in YAML must dispatch to runNotionSuite when the caller
    // supplies a `notionServices` factory but leaves `options.runner`
    // undefined. A future regression that gates `notionServices` on
    // `options.runner === "notion"` would re-introduce the YAML UX
    // cliff the prior review flagged.
    const stubServices: WakeUpServices = {
      memories: {
        list: async () => ({ items: [] }),
        search: async () => [],
        queryStaleConfidence: async () => [],
        countProposed: async () => ({ total: 0, bySource: {}, byAgent: {} }),
        listPinnedBlocks: async () => [],
        countPinnedBlocks: async () => 0,
      },
      facts: { listRecent: async () => ({ items: [], hasMore: false }) },
      decisions: {
        list: async () => ({ items: [], nextCursor: undefined }),
        queryOverdue: async () => [],
      },
      tasks: { list: async () => ({ items: [], nextCursor: undefined }) },
    }
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": authDecisionScenario("helpful-memory"),
      },
      suite: `version: 1
name: yaml-driven-notion
runner: notion
tasks:
  - id: t
    prompt: p
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/auth-model
`,
    })

    const { artifact } = await runEvalSuite(suitePath, {
      // Note: NO `runner: "notion"` here — the YAML wins.
      outPath,
      notionServices: async () => ({
        services: stubServices,
        projectId: "project-live",
      }),
    })

    expect(artifact.runner.mode).toBe("notion")
    expect(artifact.summary.scenarios).toEqual(["live-vault"])
  })

  it("notion runner refuses to run without a notionServices factory", async () => {
    const { suitePath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": authDecisionScenario("helpful-memory"),
      },
      suite: `version: 1
name: notion-no-factory
runner: retrieval
tasks:
  - id: t
    prompt: p
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/auth-model
`,
    })

    await expect(runEvalSuite(suitePath, { runner: "notion" })).rejects.toThrow(
      "notionServices"
    )
  })

  it("extracts surfaced ids from the wake-up.staleConfidence surface", async () => {
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": `name: helpful-memory
memories:
  - id: decision/legacy-cache-eviction
    title: Legacy cache eviction decision
    synopsis: Marked for triage in stale-confidence.
    isStaleConfidence: true
  - id: note/coexisting-fresh-row
    title: Fresh row that should not surface
    synopsis: Not flagged for stale-confidence.
`,
      },
      suite: `version: 1
name: stale-confidence-suite
runner: retrieval
tasks:
  - id: surfaces-flagged-stale-confidence-row
    prompt: Show rows whose confidence has gone stale.
    surface: wake-up.staleConfidence
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/legacy-cache-eviction
        shouldNotSurface:
          - note/coexisting-fresh-row
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    expect(artifact.runner.surfaces).toEqual(["wake-up.staleConfidence"])
    expect(
      artifact.results.find((result) => result.scenario === "helpful-memory")
    ).toMatchObject({
      success: true,
      surfacedMemoryIds: ["decision/legacy-cache-eviction"],
      retrieval: { surface: "wake-up.staleConfidence" },
    })
  })

  it("wake-up.staleConfidence honors task.retrieval.limit at extract time", async () => {
    // Production wake-up hard-codes STALE_CONFIDENCE_LIMIT (15) for the
    // queryStaleConfidence call. The runner cannot tune that knob via
    // task.retrieval.limit, so the surface registry's `extract`
    // applies the limit AFTER fetch. This test pins the post-fetch
    // slice: a fixture with three flagged rows + retrieval.limit:1
    // must surface exactly one id.
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": `name: helpful-memory
memories:
  - id: decision/legacy-cache-1
    title: Legacy cache eviction decision 1
    isStaleConfidence: true
  - id: decision/legacy-cache-2
    title: Legacy cache eviction decision 2
    isStaleConfidence: true
  - id: decision/legacy-cache-3
    title: Legacy cache eviction decision 3
    isStaleConfidence: true
`,
      },
      suite: `version: 1
name: stale-confidence-limit-suite
runner: retrieval
tasks:
  - id: stale-confidence-limit-honored
    prompt: Show rows whose confidence has gone stale.
    surface: wake-up.staleConfidence
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    retrieval:
      limit: 1
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/legacy-cache-1
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })

    const result = artifact.results.find((r) => r.scenario === "helpful-memory")!
    expect(result.surfacedMemoryIds).toEqual(["decision/legacy-cache-1"])
    expect(result.retrieval.limit).toBe(1)
  })

  it("wake-up.staleConfidence is bounded by STALE_CONFIDENCE_LIMIT below an over-large task limit", async () => {
    // Production wake-up hard-codes STALE_CONFIDENCE_LIMIT for the
    // queryStaleConfidence call. The runner cannot tune that knob via
    // task.retrieval.limit, so a task that asks for more than the
    // production cap (`limit: 25`) still receives at most
    // STALE_CONFIDENCE_LIMIT-many ids. If the cap moves, this test
    // (importing the constant) is the trip wire.
    const memoryEntries = Array.from({ length: 20 }, (_, i) => i + 1)
      .map(
        (i) =>
          `  - id: decision/stale-${i}\n    title: Stale row ${i}\n    isStaleConfidence: true\n`
      )
      .join("")
    const expectedSurface = Array.from(
      { length: STALE_CONFIDENCE_LIMIT },
      (_, i) => `decision/stale-${i + 1}`
    )
    const { suitePath, outPath } = await writeTempEvalSuite({
      fixtures: {
        "no-lore.yaml": emptyScenario("no-lore"),
        "empty.yaml": emptyScenario("empty-lore"),
        "helpful.yaml": `name: helpful-memory\nmemories:\n${memoryEntries}`,
      },
      suite: `version: 1
name: stale-confidence-cap-suite
runner: retrieval
tasks:
  - id: stale-confidence-bounded-by-production-cap
    prompt: Show rows whose confidence has gone stale.
    surface: wake-up.staleConfidence
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      helpful-memory: ../memory/helpful.yaml
    retrieval:
      limit: 25
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/stale-1
`,
    })

    const { artifact } = await runEvalSuite(suitePath, { outPath })
    const result = artifact.results.find((r) => r.scenario === "helpful-memory")!
    expect(result.surfacedMemoryIds).toHaveLength(STALE_CONFIDENCE_LIMIT)
    expect(result.surfacedMemoryIds).toEqual(expectedSurface)
  })
})

async function writeTempEvalSuite(input: {
  suite: string
  fixtures: Record<string, string>
}): Promise<{ suitePath: string; outPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "lore-eval-"))
  const suitesDir = join(dir, "suites")
  const memoryDir = join(dir, "memory")
  await mkdir(suitesDir, { recursive: true })
  await mkdir(memoryDir, { recursive: true })

  for (const [name, contents] of Object.entries(input.fixtures)) {
    await writeFile(join(memoryDir, name), contents)
  }

  const suitePath = join(suitesDir, "suite.yaml")
  await writeFile(suitePath, input.suite)
  return { suitePath, outPath: join(dir, "result.json") }
}

function emptyScenario(name: string): string {
  return `name: ${name}
memories: []
`
}

function authDecisionScenario(name: string): string {
  return `name: ${name}
memories:
  - id: decision/auth-model
    title: Auth model decision
    synopsis: Follow the auth path decision.
    keywords: auth path decision
`
}
