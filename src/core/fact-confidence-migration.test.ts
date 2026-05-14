import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { LoreServices } from "../services.js"
import type { Fact, Project } from "../types.js"
import {
  runBuildFactConfidenceScoresMigration,
  type BuildFactConfidenceScoresPlan,
} from "./fact-confidence-migration.js"

const TODAY = "2026-04-29"

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-default",
    name: "Default",
    type: "project",
    path: ".",
    status: "active",
    description: "",
    ...overrides,
  }
}

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-default",
    subject: "MemoryService",
    predicate: "uses",
    object: "DataSourceQuery",
    projectIds: [],
    validFrom: "2026-01-01",
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: null,
    confidence: "certain",
    confidenceScore: null,
    lastReferencedAt: null,
    createdAt: `${TODAY}T00:00:00.000Z`,
    ...overrides,
  }
}

async function* factsForScope(
  facts: Fact[],
  opts: { projectId?: string } = {}
): AsyncGenerator<Fact> {
  for (const fact of facts) {
    if (fact.validUntil !== null) continue
    if (
      opts.projectId !== undefined &&
      fact.projectIds.length > 0 &&
      !fact.projectIds.includes(opts.projectId)
    ) {
      continue
    }
    yield fact
  }
}

interface FakeServicesArgs {
  facts: Fact[]
  applyBackfillScore?: (
    id: string,
    score: number,
    lastReferencedAt: string
  ) => Promise<void>
  findByName?: (name: string) => Promise<Project | null>
  concurrency?: number
}

function makeServices(args: FakeServicesArgs) {
  const listSpy = vi.fn((opts?: { projectId?: string }) =>
    factsForScope(args.facts, opts)
  )
  const applySpy = vi.fn(
    args.applyBackfillScore ??
      (async (id: string, score: number, lastReferencedAt: string) => {
        const fact = args.facts.find((candidate) => candidate.id === id)
        if (fact === undefined) throw new Error(`unknown fact ${id}`)
        fact.confidenceScore = score
        fact.lastReferencedAt = lastReferencedAt
      })
  )
  const findByNameSpy = vi.fn(args.findByName ?? (async () => null))
  const services = {
    config: {
      notion: { rateLimit: { concurrency: args.concurrency ?? 5 } },
    },
    facts: {
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
  vi.useFakeTimers({ toFake: ["Date"] })
  vi.setSystemTime(new Date(`${TODAY}T12:00:00.000Z`))
})

afterEach(() => {
  vi.useRealTimers()
})

describe("runBuildFactConfidenceScoresMigration — plan/apply parity", () => {
  it("reports the same to-seed count that apply writes", async () => {
    const facts = [
      makeFact({
        id: "f-fresh",
        confidence: "certain",
        createdAt: `${TODAY}T00:00:00.000Z`,
      }),
      makeFact({
        id: "f-old",
        confidence: "likely",
        createdAt: "2025-10-11T00:00:00.000Z",
      }),
      makeFact({
        id: "f-scored",
        confidenceScore: 0.77,
        lastReferencedAt: "2026-01-01",
      }),
    ]
    const planOnly = makeServices({ facts: facts.map((fact) => ({ ...fact })) })

    const planned = await runBuildFactConfidenceScoresMigration({
      services: planOnly.services,
      apply: false,
      dryRun: false,
    })

    expect(planned.plan.totalFactsScanned).toBe(3)
    expect(planned.plan.rowsAlreadyScored).toBe(1)
    expect(planned.plan.rowsToSeed).toHaveLength(2)
    expect(planned.written).toBe(0)
    expect(planOnly.applySpy).not.toHaveBeenCalled()

    const applyFacts = facts.map((fact) => ({ ...fact }))
    const apply = makeServices({ facts: applyFacts })
    const applied = await runBuildFactConfidenceScoresMigration({
      services: apply.services,
      apply: true,
      dryRun: false,
    })

    expect(applied.plan.rowsToSeed).toHaveLength(planned.plan.rowsToSeed.length)
    expect(applied.written).toBe(planned.plan.rowsToSeed.length)
    expect(apply.applySpy).toHaveBeenCalledTimes(planned.plan.rowsToSeed.length)

    const fresh = applied.plan.rowsToSeed.find((row) => row.factId === "f-fresh")!
    expect(fresh.seededScore).toBeCloseTo(0.9, 6)
    expect(fresh.decayedScore).toBeCloseTo(0.9, 6)

    const old = applied.plan.rowsToSeed.find((row) => row.factId === "f-old")!
    expect(old.seededScore).toBeCloseTo(0.6, 6)
    expect(old.decayedScore).toBeCloseTo(0.6 * Math.pow(0.99, 140), 6)
  })

  it("exposes the plan shape used by command renderers", async () => {
    const { services } = makeServices({
      facts: [
        makeFact({
          id: "f1",
          subject: "FactService",
          predicate: "invalidates",
          object: "stale fact",
          confidence: "speculative",
          createdAt: "2026-03-30T00:00:00.000Z",
        }),
      ],
    })

    const { plan } = await runBuildFactConfidenceScoresMigration({
      services,
      apply: false,
      dryRun: false,
    })

    expect(plan.rowsToSeed[0]).toMatchObject<
      Partial<BuildFactConfidenceScoresPlan["rowsToSeed"][number]>
    >({
      factId: "f1",
      subject: "FactService",
      predicate: "invalidates",
      object: "stale fact",
      fromConfidence: "speculative",
    })
    expect(typeof plan.rowsToSeed[0]!.seededScore).toBe("number")
    expect(typeof plan.rowsToSeed[0]!.decayedScore).toBe("number")
    expect(plan.rowsToSeed[0]!.createdDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(typeof plan.rowsToSeed[0]!.daysSinceCreation).toBe("number")
  })
})

describe("runBuildFactConfidenceScoresMigration — idempotency and resume", () => {
  it("a second run after apply finds zero rows to update", async () => {
    const facts = [
      makeFact({ id: "f1", confidence: "certain" }),
      makeFact({ id: "f2", confidence: "likely" }),
    ]
    const { services, applySpy } = makeServices({ facts })

    const first = await runBuildFactConfidenceScoresMigration({
      services,
      apply: true,
      dryRun: false,
    })
    expect(first.written).toBe(2)
    expect(applySpy).toHaveBeenCalledTimes(2)

    const second = await runBuildFactConfidenceScoresMigration({
      services,
      apply: true,
      dryRun: false,
    })
    expect(second.plan.rowsAlreadyScored).toBe(2)
    expect(second.plan.rowsToSeed).toHaveLength(0)
    expect(second.written).toBe(0)
    expect(applySpy).toHaveBeenCalledTimes(2)
  })

  it("resumes after a failed batch without re-touching rows that already wrote", async () => {
    const facts = Array.from({ length: 5 }, (_, index) =>
      makeFact({ id: `f${index + 1}`, confidence: "certain" })
    )
    const writtenIds: string[] = []
    const { services } = makeServices({
      facts,
      concurrency: 2,
      applyBackfillScore: async (id, score, lastReferencedAt) => {
        if (id === "f3") {
          await Promise.resolve()
          throw new Error("notion 429")
        }
        const fact = facts.find((candidate) => candidate.id === id)!
        fact.confidenceScore = score
        fact.lastReferencedAt = lastReferencedAt
        writtenIds.push(id)
      },
    })

    await expect(
      runBuildFactConfidenceScoresMigration({
        services,
        apply: true,
        dryRun: false,
      })
    ).rejects.toThrow("notion 429")

    expect(writtenIds).toEqual(["f1", "f2", "f4"])
    expect(facts.find((fact) => fact.id === "f5")!.confidenceScore).toBeNull()

    const resume = makeServices({ facts, concurrency: 2 })
    const result = await runBuildFactConfidenceScoresMigration({
      services: resume.services,
      apply: true,
      dryRun: false,
    })

    expect(result.plan.rowsAlreadyScored).toBe(3)
    expect(result.plan.rowsToSeed.map((row) => row.factId)).toEqual(["f3", "f5"])
    expect(resume.applySpy).toHaveBeenCalledTimes(2)
    expect(result.written).toBe(2)
  })
})

describe("runBuildFactConfidenceScoresMigration — project scoping", () => {
  it("strict-resolves --project and touches only scoped or unscoped facts", async () => {
    const facts = [
      makeFact({ id: "f-widget", projectIds: ["project-widget"] }),
      makeFact({ id: "f-shared", projectIds: [] }),
      makeFact({ id: "f-other", projectIds: ["project-other"] }),
    ]
    const { services, listSpy, findByNameSpy, applySpy } = makeServices({
      facts,
      findByName: async (name) =>
        name === "Widget" ? makeProject({ id: "project-widget", name }) : null,
    })

    const result = await runBuildFactConfidenceScoresMigration({
      services,
      apply: true,
      dryRun: false,
      projectName: "Widget",
    })

    expect(findByNameSpy).toHaveBeenCalledWith("Widget")
    expect(listSpy).toHaveBeenCalledWith({ projectId: "project-widget" })
    expect(result.plan.rowsToSeed.map((row) => row.factId)).toEqual([
      "f-widget",
      "f-shared",
    ])
    expect(applySpy).toHaveBeenCalledTimes(2)
    expect(facts.find((fact) => fact.id === "f-other")!.confidenceScore).toBeNull()
  })

  it("aborts before scanning or writing when --project does not resolve", async () => {
    const { services, listSpy, applySpy, findByNameSpy } = makeServices({
      facts: [makeFact({ id: "f1" })],
      findByName: async () => null,
    })

    await expect(
      runBuildFactConfidenceScoresMigration({
        services,
        apply: true,
        dryRun: false,
        projectName: "Typo",
      })
    ).rejects.toThrow(/Project "Typo" could not be resolved/)

    expect(findByNameSpy).toHaveBeenCalledWith("Typo")
    expect(listSpy).not.toHaveBeenCalled()
    expect(applySpy).not.toHaveBeenCalled()
  })
})

describe("runBuildFactConfidenceScoresMigration — compatibility guards", () => {
  it("runs against rows with no scope bundle", async () => {
    const fact = makeFact({ id: "f-no-scope" })
    delete fact.scope
    const { services } = makeServices({ facts: [fact] })

    const result = await runBuildFactConfidenceScoresMigration({
      services,
      apply: true,
      dryRun: false,
    })

    expect(result.written).toBe(1)
    expect(fact.confidenceScore).toBeCloseTo(0.9, 6)
  })

  it("rejects unsupported Fact.confidence values before writing", async () => {
    const { services, applySpy } = makeServices({
      facts: [
        makeFact({
          id: "f-bad-confidence",
          confidence: "unsupported" as Fact["confidence"],
        }),
      ],
    })

    await expect(
      runBuildFactConfidenceScoresMigration({
        services,
        apply: true,
        dryRun: false,
      })
    ).rejects.toThrow(/unsupported Fact\.confidence "unsupported"/)
    expect(applySpy).not.toHaveBeenCalled()
  })
})
