import { describe, expect, it, vi } from "vitest"
import type { LoreServices } from "../services.js"
import type { Fact, Project } from "../types.js"
import { runBackfillFactObservedAtMigration } from "./fact-observed-at-migration.js"

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
    observedAt: null,
    invalidatedAt: null,
    invalidatedBySourceMemoryId: null,
    createdAt: "2026-01-15T00:00:00.000Z",
    ...overrides,
  }
}

async function* factsForBackfill(
  facts: Fact[],
  opts: { projectId?: string; includeInvalidated?: boolean } = {}
): AsyncGenerator<Fact> {
  for (const fact of facts) {
    if (!opts.includeInvalidated && fact.validUntil !== null) continue
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
  applyObservedAtBackfill?: (
    id: string,
    values: { observedAt: string | null; invalidatedAt: string | null }
  ) => Promise<void>
  findByName?: (name: string) => Promise<Project | null>
  concurrency?: number
}

function makeServices(args: FakeServicesArgs) {
  const listSpy = vi.fn((opts?: { projectId?: string; includeInvalidated?: boolean }) =>
    factsForBackfill(args.facts, opts)
  )
  const applySpy = vi.fn(
    args.applyObservedAtBackfill ??
      (async (
        id: string,
        values: { observedAt: string | null; invalidatedAt: string | null }
      ) => {
        const fact = args.facts.find((candidate) => candidate.id === id)
        if (fact === undefined) throw new Error(`unknown fact ${id}`)
        if (values.observedAt !== null) fact.observedAt = values.observedAt
        if (values.invalidatedAt !== null) fact.invalidatedAt = values.invalidatedAt
      })
  )
  const findByNameSpy = vi.fn(args.findByName ?? (async () => null))
  const services = {
    config: {
      notion: { rateLimit: { concurrency: args.concurrency ?? 5 } },
    },
    facts: {
      listAllForBackfill: listSpy,
      applyObservedAtBackfill: applySpy,
    },
    projects: {
      findByName: findByNameSpy,
    },
  } as unknown as LoreServices
  return { services, listSpy, applySpy, findByNameSpy }
}

describe("runBackfillFactObservedAtMigration — plan/apply parity", () => {
  it("reports the same to-backfill count that apply writes", async () => {
    const facts = [
      makeFact({
        id: "f-live",
        createdAt: "2026-01-15T00:00:00.000Z",
      }),
      makeFact({
        id: "f-invalidated",
        validUntil: "2026-03-01",
        createdAt: "2026-01-10T00:00:00.000Z",
      }),
      makeFact({
        id: "f-invalidated-only",
        validUntil: "2026-03-05",
        observedAt: "2026-01-20",
        invalidatedAt: null,
        createdAt: "2026-01-20T00:00:00.000Z",
      }),
      makeFact({
        id: "f-ready",
        observedAt: "2026-01-15",
        invalidatedAt: null,
      }),
    ]
    const planOnly = makeServices({ facts: facts.map((fact) => ({ ...fact })) })

    const planned = await runBackfillFactObservedAtMigration({
      services: planOnly.services,
      apply: false,
      dryRun: false,
    })

    expect(planned.plan.totalFactsScanned).toBe(4)
    expect(planned.plan.rowsAlreadyBackfilled).toBe(1)
    expect(planned.plan.rowsToBackfill).toHaveLength(3)
    expect(planned.plan.observedAtRowsToWrite).toBe(2)
    expect(planned.plan.invalidatedAtRowsToWrite).toBe(2)
    expect(planned.written).toBe(0)
    expect(planOnly.applySpy).not.toHaveBeenCalled()

    const apply = makeServices({ facts: facts.map((fact) => ({ ...fact })) })
    const applied = await runBackfillFactObservedAtMigration({
      services: apply.services,
      apply: true,
      dryRun: false,
    })

    expect(applied.plan.rowsToBackfill).toHaveLength(planned.plan.rowsToBackfill.length)
    expect(applied.written).toBe(planned.plan.rowsToBackfill.length)
    expect(applied.failures).toHaveLength(0)
    expect(apply.applySpy).toHaveBeenCalledTimes(planned.plan.rowsToBackfill.length)

    expect(
      applied.plan.rowsToBackfill.find((row) => row.factId === "f-invalidated")
    ).toMatchObject({
      observedAtToWrite: "2026-01-10",
      invalidatedAtToWrite: "2026-03-01",
    })
  })

  it("dryRun=true suppresses writes even when apply=true", async () => {
    const { services, applySpy } = makeServices({
      facts: [makeFact({ id: "f1" })],
    })

    const result = await runBackfillFactObservedAtMigration({
      services,
      apply: true,
      dryRun: true,
    })

    expect(result.plan.rowsToBackfill).toHaveLength(1)
    expect(result.written).toBe(0)
    expect(result.failures).toHaveLength(0)
    expect(applySpy).not.toHaveBeenCalled()
  })
})

describe("runBackfillFactObservedAtMigration — idempotency and resume", () => {
  it("a second run after apply finds zero rows to update", async () => {
    const facts = [
      makeFact({ id: "f-live" }),
      makeFact({ id: "f-invalidated", validUntil: "2026-03-01" }),
    ]
    const { services, applySpy } = makeServices({ facts })

    const first = await runBackfillFactObservedAtMigration({
      services,
      apply: true,
      dryRun: false,
    })
    expect(first.written).toBe(2)
    expect(applySpy).toHaveBeenCalledTimes(2)

    const second = await runBackfillFactObservedAtMigration({
      services,
      apply: true,
      dryRun: false,
    })
    expect(second.plan.rowsAlreadyBackfilled).toBe(2)
    expect(second.plan.rowsToBackfill).toHaveLength(0)
    expect(second.written).toBe(0)
    expect(second.failures).toHaveLength(0)
    expect(applySpy).toHaveBeenCalledTimes(2)
  })

  it("resumes after per-row failures without re-touching rows that already wrote", async () => {
    const facts = [
      makeFact({ id: "f1" }),
      makeFact({ id: "f2" }),
      makeFact({ id: "f3", validUntil: "2026-02-01" }),
    ]
    const firstRunWrites: string[] = []
    const first = makeServices({
      facts,
      concurrency: 3,
      applyObservedAtBackfill: async (id, values) => {
        if (id === "f2") throw new Error("validation_error: property missing")
        const fact = facts.find((candidate) => candidate.id === id)!
        if (values.observedAt !== null) fact.observedAt = values.observedAt
        if (values.invalidatedAt !== null) fact.invalidatedAt = values.invalidatedAt
        firstRunWrites.push(id)
      },
    })

    const failed = await runBackfillFactObservedAtMigration({
      services: first.services,
      apply: true,
      dryRun: false,
    })

    expect(failed.written).toBe(2)
    expect(failed.failures).toEqual([
      { factId: "f2", message: "validation_error: property missing" },
    ])
    expect(firstRunWrites).toEqual(["f1", "f3"])

    const resume = makeServices({ facts, concurrency: 3 })
    const result = await runBackfillFactObservedAtMigration({
      services: resume.services,
      apply: true,
      dryRun: false,
    })

    expect(result.plan.rowsAlreadyBackfilled).toBe(2)
    expect(result.plan.rowsToBackfill.map((row) => row.factId)).toEqual(["f2"])
    expect(resume.applySpy).toHaveBeenCalledTimes(1)
    expect(result.written).toBe(1)
    expect(result.failures).toHaveLength(0)
  })
})

describe("runBackfillFactObservedAtMigration — project scoping", () => {
  it("strict-resolves --project and touches only scoped or unscoped facts", async () => {
    const facts = [
      makeFact({ id: "f-widget", projectIds: ["project-widget"] }),
      makeFact({ id: "f-shared", projectIds: [] }),
      makeFact({ id: "f-other", projectIds: ["project-other"] }),
    ]
    const { services, listSpy, applySpy, findByNameSpy } = makeServices({
      facts,
      findByName: async (name) =>
        name === "Widget" ? makeProject({ id: "project-widget", name }) : null,
    })

    const result = await runBackfillFactObservedAtMigration({
      services,
      apply: true,
      dryRun: false,
      projectName: "Widget",
    })

    expect(findByNameSpy).toHaveBeenCalledWith("Widget")
    expect(listSpy).toHaveBeenCalledWith({
      projectId: "project-widget",
      includeInvalidated: true,
    })
    expect(result.plan.rowsToBackfill.map((row) => row.factId)).toEqual([
      "f-widget",
      "f-shared",
    ])
    expect(applySpy).toHaveBeenCalledTimes(2)
    expect(facts.find((fact) => fact.id === "f-other")!.observedAt).toBeNull()
  })

  it("aborts before scanning or writing when --project does not resolve", async () => {
    const { services, listSpy, applySpy, findByNameSpy } = makeServices({
      facts: [makeFact({ id: "f1" })],
      findByName: async () => null,
    })

    await expect(
      runBackfillFactObservedAtMigration({
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

describe("runBackfillFactObservedAtMigration — compatibility guards", () => {
  it("walks invalidated rows and runs against rows without scope fields", async () => {
    const fact = makeFact({
      id: "f-no-scope",
      validUntil: "2026-03-01",
      createdAt: "2026-01-10T00:00:00.000Z",
    })
    delete fact.scope
    const { services, listSpy } = makeServices({ facts: [fact] })

    const result = await runBackfillFactObservedAtMigration({
      services,
      apply: true,
      dryRun: false,
    })

    expect(listSpy).toHaveBeenCalledWith({
      projectId: undefined,
      includeInvalidated: true,
    })
    expect(result.written).toBe(1)
    expect(fact.observedAt).toBe("2026-01-10")
    expect(fact.invalidatedAt).toBe("2026-03-01")
  })

  it("treats omitted transaction-time fields as missing values", async () => {
    const fact = makeFact({
      id: "f-omitted-fields",
      validUntil: "2026-03-01",
      createdAt: "2026-01-10T00:00:00.000Z",
    })
    delete fact.observedAt
    delete fact.invalidatedAt
    const { services } = makeServices({ facts: [fact] })

    const result = await runBackfillFactObservedAtMigration({
      services,
      apply: true,
      dryRun: false,
    })

    expect(result.plan.rowsToBackfill).toHaveLength(1)
    expect(fact.observedAt).toBe("2026-01-10")
    expect(fact.invalidatedAt).toBe("2026-03-01")
  })
})
