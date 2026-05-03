import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LoreServices } from "../services.js"
import type { Memory } from "../types.js"
import {
  runBuildConfidenceScoresMigration,
  type BuildConfidenceScoresPlan,
} from "./confidence-migration.js"

/**
 * Deterministic `today` anchor for plan/decay assertions. The migration
 * itself reads `todayUtc()` internally, so tests pin the system clock
 * via `vi.useFakeTimers({ toFake: ['Date'] })` rather than threading a
 * `today` parameter through the public surface. Faking only `Date`
 * keeps `setTimeout` real so the concurrency test below can assert
 * wall-clock behavior.
 */
const TODAY = "2026-04-29"

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m-default",
    title: "Default memory",
    projectIds: [],
    topicId: null,
    source: "manual",
    kind: "note",
    status: "informational",
    confidence: "certain",
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
    keywords: "",
    synopsis: "",
    session: "",
    content: "",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    createdAt: `${TODAY}T00:00:00.000Z`,
    updatedAt: `${TODAY}T00:00:00.000Z`,
    ...overrides,
  }
}

async function* asyncIterableOf(memories: Memory[]): AsyncGenerator<Memory> {
  for (const m of memories) yield m
}

interface FakeServicesArgs {
  memories: Memory[]
  applyBackfillScore?: (
    id: string,
    score: number,
    lastReferencedAt: string
  ) => Promise<void>
  findByName?: (name: string) => Promise<{ id: string; name: string } | null>
  concurrency?: number
}

function makeServices(args: FakeServicesArgs) {
  const listSpy = vi.fn((_opts?: { projectId?: string }) =>
    asyncIterableOf(args.memories)
  )
  const applySpy = vi.fn(args.applyBackfillScore ?? (async () => undefined))
  const findByNameSpy = vi.fn(args.findByName ?? (async () => null))
  const services = {
    config: {
      notion: { rateLimit: { concurrency: args.concurrency ?? 5 } },
    },
    memories: {
      listAllForBackfill: listSpy,
      applyBackfillScore: applySpy,
    },
    projects: {
      findByName: findByNameSpy,
    },
  } as unknown as LoreServices
  return { services, listSpy, applySpy, findByNameSpy }
}

beforeEach(() => {
  // Pin Date only — `setTimeout` and friends remain real so the
  // concurrency wall-clock test below can run normally.
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("runBuildConfidenceScoresMigration — plan", () => {
  it("builds a plan with seeded + decayed scores and skips already-scored rows", async () => {
    const memories = [
      makeMemory({
        id: "m-fresh",
        confidence: "certain",
        confidenceScore: null,
        createdAt: `${TODAY}T00:00:00.000Z`,
      }),
      makeMemory({
        id: "m-old",
        confidence: "likely",
        confidenceScore: null,
        createdAt: "2025-10-11T00:00:00.000Z", // 200 days ago
      }),
      makeMemory({
        id: "m-already-scored",
        confidence: "certain",
        confidenceScore: 0.85,
        createdAt: "2025-12-01T00:00:00.000Z",
      }),
    ]
    const { services, applySpy } = makeServices({ memories })
    const result = await runBuildConfidenceScoresMigration({
      services,
      apply: false,
      dryRun: false,
    })

    expect(result.plan.totalMemoriesScanned).toBe(3)
    expect(result.plan.rowsAlreadyScored).toBe(1)
    expect(result.plan.rowsToSeed).toHaveLength(2)
    expect(result.written).toBe(0)
    expect(applySpy).not.toHaveBeenCalled()

    const fresh = result.plan.rowsToSeed.find((r) => r.memoryId === "m-fresh")!
    // certain → 0.9; createdAt today → zero stale days → no decay.
    expect(fresh.seededScore).toBeCloseTo(0.9, 6)
    expect(fresh.decayedScore).toBeCloseTo(0.9, 6)
    expect(fresh.daysSinceCreation).toBe(0)
    expect(fresh.createdDate).toBe(TODAY)

    const old = result.plan.rowsToSeed.find((r) => r.memoryId === "m-old")!
    // likely → 0.6 seed; 200 days elapsed → 140 stale days past 60d grace.
    expect(old.seededScore).toBeCloseTo(0.6, 6)
    expect(old.decayedScore).toBeCloseTo(0.6 * Math.pow(0.99, 140), 6)
    expect(old.daysSinceCreation).toBe(200)
    expect(old.createdDate).toBe("2025-10-11")
  })

  it("decays a 90-day-old certain memory to ≈ 0.665", async () => {
    // Acceptance criterion from the spec: a memory created 90 days ago
    // with categorical certain ends up at 0.9 * 0.99^30 ≈ 0.665.
    const memories = [
      makeMemory({
        id: "m-90d",
        confidence: "certain",
        confidenceScore: null,
        createdAt: "2026-01-29T00:00:00.000Z", // exactly 90 days before TODAY
      }),
    ]
    const { services } = makeServices({ memories })
    const { plan } = await runBuildConfidenceScoresMigration({
      services,
      apply: false,
      dryRun: false,
    })
    expect(plan.rowsToSeed).toHaveLength(1)
    expect(plan.rowsToSeed[0]!.decayedScore).toBeCloseTo(0.9 * Math.pow(0.99, 30), 4)
    expect(plan.rowsToSeed[0]!.decayedScore).toBeCloseTo(0.665, 2)
  })

  it("leaves a within-grace memory at the seed value with no decay", async () => {
    const memories = [
      makeMemory({
        id: "m-30d",
        confidence: "certain",
        confidenceScore: null,
        createdAt: "2026-03-30T00:00:00.000Z", // 30 days before TODAY (within 60d grace)
      }),
    ]
    const { services } = makeServices({ memories })
    const { plan } = await runBuildConfidenceScoresMigration({
      services,
      apply: false,
      dryRun: false,
    })
    expect(plan.rowsToSeed[0]!.seededScore).toBeCloseTo(0.9, 6)
    expect(plan.rowsToSeed[0]!.decayedScore).toBeCloseTo(0.9, 6)
  })

  it("returns an empty plan when every row is already scored", async () => {
    const memories = [
      makeMemory({ id: "m1", confidenceScore: 0.5 }),
      makeMemory({ id: "m2", confidenceScore: 0.7 }),
    ]
    const { services, applySpy } = makeServices({ memories })
    const result = await runBuildConfidenceScoresMigration({
      services,
      apply: true,
      dryRun: false,
    })
    expect(result.plan.rowsToSeed).toHaveLength(0)
    expect(result.plan.rowsAlreadyScored).toBe(2)
    expect(result.written).toBe(0)
    expect(applySpy).not.toHaveBeenCalled()
  })
})

describe("runBuildConfidenceScoresMigration — execute", () => {
  it("writes Confidence Score + Last Referenced At for each unscored row when apply=true", async () => {
    const memories = [
      makeMemory({
        id: "m-fresh",
        confidence: "certain",
        confidenceScore: null,
        createdAt: `${TODAY}T00:00:00.000Z`,
      }),
      makeMemory({
        id: "m-old",
        confidence: "likely",
        confidenceScore: null,
        createdAt: "2025-10-11T00:00:00.000Z",
      }),
    ]
    const calls: Array<{ id: string; score: number; date: string }> = []
    const { services, applySpy } = makeServices({
      memories,
      applyBackfillScore: async (id, score, date) => {
        calls.push({ id, score, date })
      },
    })

    const result = await runBuildConfidenceScoresMigration({
      services,
      apply: true,
      dryRun: false,
    })

    expect(applySpy).toHaveBeenCalledTimes(2)
    expect(result.written).toBe(2)
    const fresh = calls.find((c) => c.id === "m-fresh")!
    expect(fresh.score).toBeCloseTo(0.9, 6)
    expect(fresh.date).toBe(TODAY)
    const old = calls.find((c) => c.id === "m-old")!
    expect(old.score).toBeCloseTo(0.6 * Math.pow(0.99, 140), 6)
    expect(old.date).toBe("2025-10-11")
  })

  it("dryRun=true takes precedence over apply=true (no writes)", async () => {
    const memories = [
      makeMemory({ id: "m-fresh", confidence: "certain", confidenceScore: null }),
    ]
    const { services, applySpy } = makeServices({ memories })
    const result = await runBuildConfidenceScoresMigration({
      services,
      apply: true,
      dryRun: true,
    })
    expect(result.plan.rowsToSeed).toHaveLength(1)
    expect(result.written).toBe(0)
    expect(applySpy).not.toHaveBeenCalled()
  })

  it("re-running after a successful apply is a no-op (idempotency)", async () => {
    // Simulate: the first run wrote scores; the second run sees those
    // rows reflect their stored Confidence Score and skips them.
    const memories = [
      makeMemory({ id: "m1", confidenceScore: 0.85 }),
      makeMemory({ id: "m2", confidenceScore: 0.6 }),
    ]
    const { services, applySpy } = makeServices({ memories })
    const result = await runBuildConfidenceScoresMigration({
      services,
      apply: true,
      dryRun: false,
    })
    expect(result.plan.rowsAlreadyScored).toBe(2)
    expect(result.plan.rowsToSeed).toHaveLength(0)
    expect(applySpy).not.toHaveBeenCalled()
    expect(result.written).toBe(0)
  })

  it("dispatches batches in parallel up to the configured concurrency", async () => {
    // Wall-clock guarantee: with 6 rows at concurrency 3, two batches of
    // 3 run sequentially. Each batch ≈ per-call-latency wide; total ≈
    // 2 × per-call-latency. Verifies the chunked-Promise.all shape over
    // the sequential `for await` shape (which would be 6 × per-call).
    const PER_CALL_MS = 50
    const memories = Array.from({ length: 6 }, (_, i) =>
      makeMemory({
        id: `m${i}`,
        confidence: "certain",
        confidenceScore: null,
      })
    )

    let inflight = 0
    let maxInflight = 0
    const { services, applySpy } = makeServices({
      memories,
      concurrency: 3,
      applyBackfillScore: async () => {
        inflight += 1
        if (inflight > maxInflight) maxInflight = inflight
        await new Promise((resolve) => setTimeout(resolve, PER_CALL_MS))
        inflight -= 1
      },
    })

    const start = Date.now()
    const result = await runBuildConfidenceScoresMigration({
      services,
      apply: true,
      dryRun: false,
    })
    const elapsed = Date.now() - start

    expect(result.written).toBe(6)
    expect(applySpy).toHaveBeenCalledTimes(6)
    // Up to 3 in-flight at a time, never 6 (would indicate one big
    // Promise.all without chunking — still acceptable per the spec but
    // the chunked shape produces a tighter peak).
    expect(maxInflight).toBeGreaterThanOrEqual(2)
    expect(maxInflight).toBeLessThanOrEqual(3)
    // Two batches of 3 should land ~2 × PER_CALL_MS, not 6 × PER_CALL_MS.
    // Allow generous wiggle for CI scheduling jitter.
    expect(elapsed).toBeLessThan(6 * PER_CALL_MS)
  })
})

describe("runBuildConfidenceScoresMigration — project scoping", () => {
  it("scopes via findByName when projectName is provided", async () => {
    const memories = [makeMemory({ id: "m1", confidenceScore: null })]
    const { services, listSpy, findByNameSpy, applySpy } = makeServices({
      memories,
      findByName: async (name) => (name === "Mail" ? { id: "project-mail", name } : null),
    })

    await runBuildConfidenceScoresMigration({
      services,
      apply: false,
      dryRun: false,
      projectName: "Mail",
    })

    expect(findByNameSpy).toHaveBeenCalledWith("Mail")
    expect(listSpy).toHaveBeenCalledWith({ projectId: "project-mail" })
    expect(applySpy).not.toHaveBeenCalled()
  })

  it("uses a pre-resolved projectId without looking up projectName again", async () => {
    const { services, listSpy, findByNameSpy } = makeServices({
      memories: [],
      findByName: async () => {
        throw new Error("should not resolve again")
      },
    })

    await runBuildConfidenceScoresMigration({
      services,
      apply: false,
      dryRun: false,
      projectName: "Archive",
      projectId: "project-archive",
    })

    expect(findByNameSpy).not.toHaveBeenCalled()
    expect(listSpy).toHaveBeenCalledWith({ projectId: "project-archive" })
  })

  it("aborts BEFORE any scan or write when projectName is unknown (safety property)", async () => {
    const { services, listSpy, findByNameSpy, applySpy } = makeServices({
      memories: [makeMemory({ confidenceScore: null })],
      findByName: async () => null,
    })

    await expect(
      runBuildConfidenceScoresMigration({
        services,
        apply: true,
        dryRun: false,
        projectName: "Typo",
      })
    ).rejects.toThrow(/Project "Typo" could not be resolved/)

    expect(findByNameSpy).toHaveBeenCalledWith("Typo")
    // Safety: no listAllForBackfill or applyBackfillScore call when the
    // project name fails to resolve. The error message names the offender
    // and points at `lore status projects`.
    expect(listSpy).not.toHaveBeenCalled()
    expect(applySpy).not.toHaveBeenCalled()
  })

  it("runs vault-wide when projectName is omitted (no findByName call)", async () => {
    const { services, listSpy, findByNameSpy } = makeServices({
      memories: [],
    })

    await runBuildConfidenceScoresMigration({
      services,
      apply: false,
      dryRun: false,
    })

    expect(findByNameSpy).not.toHaveBeenCalled()
    expect(listSpy).toHaveBeenCalledWith({ projectId: undefined })
  })
})

describe("runBuildConfidenceScoresMigration — partial-failure resumability", () => {
  it("propagates batch failures with chunked-Promise.all semantics; idempotent re-run completes the remainder", async () => {
    // Fixture: 10 rows at concurrency 3 — three full batches of 3 plus
    // a tail of 1. The 7th call throws (the first call of batch #3),
    // exercising the chunked semantics: prior batches (rows 1–6) all
    // wrote successfully; the failing batch rejects via `Promise.all`;
    // row 10 never dispatches. Concurrency &gt; 1 is load-bearing — at
    // concurrency 1 the chunked path collapses to sequential dispatch
    // and the reject-propagation behavior is no longer distinguishable
    // from a sequential `for await` loop.
    const memories = Array.from({ length: 10 }, (_, i) =>
      makeMemory({
        id: `m${i}`,
        confidence: "certain",
        confidenceScore: null,
      })
    )
    let calls = 0
    let preFailureCompleted = 0
    const { services } = makeServices({
      memories,
      concurrency: 3,
      applyBackfillScore: async () => {
        const callIndex = ++calls
        if (callIndex === 7) {
          throw new Error("notion 429")
        }
        // Tiny delay so the chunked dispatch's parallel siblings
        // observably overlap with the failing call. Without the await,
        // rejection from sibling 7 could propagate before sibling 8/9
        // even started — making "siblings of the failing row may have
        // written" a fixture artifact rather than a tested invariant.
        await Promise.resolve()
        preFailureCompleted += 1
      },
    })

    await expect(
      runBuildConfidenceScoresMigration({
        services,
        apply: true,
        dryRun: false,
      })
    ).rejects.toThrow("notion 429")

    // Two full pre-failure batches × 3 = 6 rows definitely completed.
    // The failing batch's siblings (rows 8 and 9) may or may not have
    // run before reject propagated — same posture as the spec's
    // "may have written (or may have been mid-flight when the
    // rejecting promise propagated)." Lower bound is the spec's
    // "at least 40 written rows (pre-batch survivors)" rule scaled
    // down: at least the count of completed pre-failure batches × N.
    expect(preFailureCompleted).toBeGreaterThanOrEqual(6)
    // Row 10's batch never started — `Promise.all` rejection on batch
    // 3 stops the outer for-loop before batch 4 dispatches.
    expect(calls).toBeLessThanOrEqual(9)

    // Re-run with the live state: rows that successfully wrote during
    // the first attempt now have scores; a re-run scans them as
    // "already scored" and only attempts the unwritten subset.
    const writtenIds = new Set(
      Array.from({ length: preFailureCompleted }, (_, i) => `m${i}`)
    )
    let secondRunCalls = 0
    const second = makeServices({
      memories: memories.map((m) => ({
        ...m,
        confidenceScore: writtenIds.has(m.id) ? 0.9 : null,
      })),
      concurrency: 3,
      applyBackfillScore: async () => {
        secondRunCalls += 1
      },
    })
    const result2 = await runBuildConfidenceScoresMigration({
      services: second.services,
      apply: true,
      dryRun: false,
    })
    expect(result2.plan.rowsAlreadyScored).toBe(preFailureCompleted)
    expect(result2.plan.rowsToSeed).toHaveLength(10 - preFailureCompleted)
    expect(secondRunCalls).toBe(10 - preFailureCompleted)
    expect(result2.written).toBe(10 - preFailureCompleted)
  })
})

describe("runBuildConfidenceScoresMigration — per-100-rows progress lines", () => {
  it("prints a stderr progress line at every 100-row boundary during apply", async () => {
    // Spec acceptance: "a fixture writing 250 rows at concurrency = 5
    // prints lines at 100 / 200." Verify by capturing stderr writes
    // across the apply pass.
    const memories = Array.from({ length: 250 }, (_, i) =>
      makeMemory({
        id: `m${i}`,
        confidence: "certain",
        confidenceScore: null,
      })
    )
    const { services } = makeServices({ memories, concurrency: 5 })

    const captured: string[] = []
    const originalWrite = process.stderr.write
    process.stderr.write = ((chunk: unknown) => {
      captured.push(String(chunk))
      return true
    }) as typeof process.stderr.write

    try {
      await runBuildConfidenceScoresMigration({
        services,
        apply: true,
        dryRun: false,
      })
    } finally {
      process.stderr.write = originalWrite
    }

    const progressLines = captured.filter((c) =>
      c.includes("[lore] build-confidence-scores:")
    )
    // 250 rows at concurrency 5 → 50 batches. Progress fires at the
    // 100-row boundary AND at the 200-row boundary. The trailing 50
    // rows do NOT trigger a third line because the next mark is 300,
    // and the loop exits before reaching it.
    expect(progressLines.length).toBe(2)
    expect(progressLines[0]).toMatch(/100\/250/)
    expect(progressLines[1]).toMatch(/200\/250/)
  })

  it("does not emit a progress line on the dry-run path", async () => {
    const memories = Array.from({ length: 150 }, (_, i) =>
      makeMemory({
        id: `m${i}`,
        confidence: "certain",
        confidenceScore: null,
      })
    )
    const { services } = makeServices({ memories, concurrency: 5 })

    const captured: string[] = []
    const originalWrite = process.stderr.write
    process.stderr.write = ((chunk: unknown) => {
      captured.push(String(chunk))
      return true
    }) as typeof process.stderr.write

    try {
      await runBuildConfidenceScoresMigration({
        services,
        apply: false, // plan-only
        dryRun: false,
      })
    } finally {
      process.stderr.write = originalWrite
    }

    expect(
      captured.filter((c) => c.includes("[lore] build-confidence-scores:"))
    ).toHaveLength(0)
  })
})

describe("runBuildConfidenceScoresMigration — plan shape contract", () => {
  it("exposes BuildConfidenceScoresPlan fields that downstream renderers depend on", async () => {
    const memories = [
      makeMemory({
        id: "m1",
        title: "Some title",
        confidence: "certain",
        confidenceScore: null,
        createdAt: "2025-10-11T00:00:00.000Z",
      }),
    ]
    const { services } = makeServices({ memories })
    const { plan } = await runBuildConfidenceScoresMigration({
      services,
      apply: false,
      dryRun: false,
    })
    const row = plan.rowsToSeed[0]!
    // Fields the CLI renderer reads — break this and the migrate output
    // breaks silently.
    expect(row).toMatchObject<Partial<BuildConfidenceScoresPlan["rowsToSeed"][number]>>({
      memoryId: "m1",
      title: "Some title",
      fromConfidence: "certain",
    })
    expect(typeof row.seededScore).toBe("number")
    expect(typeof row.decayedScore).toBe("number")
    expect(row.createdDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(typeof row.daysSinceCreation).toBe("number")
  })
})
