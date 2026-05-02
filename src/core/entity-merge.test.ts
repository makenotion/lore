import { describe, expect, it, vi } from "vitest"
import type { Entity } from "../types.js"
import { aliasesForEntityMerge, mergeEntities } from "./entity-merge.js"
import type { FactEntityRepointResult } from "./fact.js"

function makeEntity(id: string, overrides: Partial<Entity> = {}): Entity {
  return {
    id,
    name: id === "ent-winner" ? "AuthService" : "AuthSvc",
    aliases: [],
    kind: null,
    description: "",
    projectIds: [],
    ...overrides,
  }
}

function makeRepointResult(
  overrides: Partial<FactEntityRepointResult> = {}
): FactEntityRepointResult {
  return {
    plans: [],
    factsMatched: 0,
    factsRepointed: 0,
    subjectRelationsRepointed: 0,
    objectRelationsRepointed: 0,
    errors: [],
    planOnly: false,
    ...overrides,
  }
}

function makeHarness(
  repoint: FactEntityRepointResult,
  postArchiveRepoint: FactEntityRepointResult = makeRepointResult()
) {
  const winner = makeEntity("ent-winner", {
    name: "AuthService",
    aliases: ["Authentication Service"],
  })
  const loser = makeEntity("ent-loser", {
    name: "AuthSvc",
    aliases: ["authservice", "Auth service"],
  })
  const entities = {
    getById: vi.fn(async (id: string) => {
      if (id === winner.id) return winner
      if (id === loser.id) return loser
      throw new Error(`unknown entity ${id}`)
    }),
    addAliases: vi.fn(),
    archive: vi.fn(),
  }
  const facts = {
    repointEntity: vi.fn()
      .mockResolvedValueOnce(repoint)
      .mockResolvedValueOnce(postArchiveRepoint),
  }
  return { winner, loser, entities, facts }
}

describe("aliasesForEntityMerge", () => {
  it("adds loser name and aliases while deduping against winner forms", () => {
    const aliases = aliasesForEntityMerge(
      makeEntity("ent-winner", {
        name: "AuthService",
        aliases: ["Authentication Service"],
      }),
      makeEntity("ent-loser", {
        name: "authservice",
        aliases: ["AuthSvc", "Authentication Service", " Auth "],
      })
    )

    expect(aliases).toEqual(["AuthSvc", "Auth"])
  })
})

describe("mergeEntities", () => {
  it("returns a plan without mutating in plan-only mode", async () => {
    const { entities, facts } = makeHarness(
      makeRepointResult({
        plans: [{ factId: "fact-1", subject: true, object: false }],
        factsMatched: 1,
        factsRepointed: 1,
        subjectRelationsRepointed: 1,
        planOnly: true,
      })
    )

    const result = await mergeEntities(entities as never, facts as never, {
      winnerId: "ent-winner",
      loserId: "ent-loser",
      apply: false,
    })

    expect(result.planOnly).toBe(true)
    expect(result.aliasesPlanned).toBe(2)
    expect(result.aliasesAdded).toBe(0)
    expect(facts.repointEntity).toHaveBeenCalledWith({
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: false,
      includeInvalidated: true,
    })
    expect(entities.addAliases).not.toHaveBeenCalled()
    expect(entities.archive).not.toHaveBeenCalled()
  })

  it("repoints facts, appends aliases, and archives the loser in apply mode", async () => {
    const { entities, facts, loser, winner } = makeHarness(
      makeRepointResult({
        plans: [{ factId: "fact-1", subject: false, object: true }],
        factsMatched: 1,
        factsRepointed: 1,
        objectRelationsRepointed: 1,
      })
    )

    const result = await mergeEntities(entities as never, facts as never, {
      winnerId: "ent-winner",
      loserId: "ent-loser",
      apply: true,
      today: "2026-05-02",
    })

    expect(result.errors).toEqual([])
    expect(result.aliasesPlanned).toBe(2)
    expect(result.aliasesAdded).toBe(2)
    expect(result.loserArchived).toBe(true)
    expect(entities.addAliases).toHaveBeenCalledWith("ent-winner", [
      "AuthSvc",
      "Auth service",
    ])
    expect(entities.archive).toHaveBeenCalledWith(loser, {
      mergedInto: winner,
      mergedAt: "2026-05-02",
    })
    expect(facts.repointEntity).toHaveBeenNthCalledWith(2, {
      fromEntityId: "ent-loser",
      toEntityId: "ent-winner",
      apply: true,
      includeInvalidated: true,
    })
  })

  it("runs a post-archive scan and reports late fact writes separately", async () => {
    const { entities, facts } = makeHarness(
      makeRepointResult(),
      makeRepointResult({
        plans: [{ factId: "fact-late", subject: true, object: false }],
        factsMatched: 1,
        factsRepointed: 1,
        subjectRelationsRepointed: 1,
      })
    )

    const result = await mergeEntities(entities as never, facts as never, {
      winnerId: "ent-winner",
      loserId: "ent-loser",
      apply: true,
      today: "2026-05-02",
    })

    expect(result.errors).toEqual([])
    expect(result.loserArchived).toBe(true)
    expect(result.postArchiveRepoint?.plans).toEqual([
      { factId: "fact-late", subject: true, object: false },
    ])
    expect(result.repoint.factsMatched).toBe(0)
    expect(result.repoint.factsRepointed).toBe(0)
    expect(facts.repointEntity).toHaveBeenCalledTimes(2)
  })

  it("does not append aliases or archive the loser after a repoint failure", async () => {
    const { entities, facts } = makeHarness(
      makeRepointResult({
        plans: [
          { factId: "fact-ok", subject: true, object: false },
          { factId: "fact-fail", subject: true, object: false },
        ],
        factsMatched: 2,
        factsRepointed: 1,
        subjectRelationsRepointed: 1,
        errors: [{ factId: "fact-fail", message: "notion 429" }],
      })
    )

    const result = await mergeEntities(entities as never, facts as never, {
      winnerId: "ent-winner",
      loserId: "ent-loser",
      apply: true,
    })

    expect(result.errors).toEqual([
      { phase: "repoint", factId: "fact-fail", message: "notion 429" },
    ])
    expect(result.loserArchived).toBe(false)
    expect(entities.addAliases).not.toHaveBeenCalled()
    expect(entities.archive).not.toHaveBeenCalled()
    expect(facts.repointEntity).toHaveBeenCalledTimes(1)
  })

  it("reports alias failures without archiving the loser", async () => {
    const { entities, facts } = makeHarness(makeRepointResult())
    entities.addAliases.mockRejectedValueOnce(new Error("alias write failed"))

    const result = await mergeEntities(entities as never, facts as never, {
      winnerId: "ent-winner",
      loserId: "ent-loser",
      apply: true,
    })

    expect(result.errors).toEqual([{ phase: "aliases", message: "alias write failed" }])
    expect(result.loserArchived).toBe(false)
    expect(entities.archive).not.toHaveBeenCalled()
    expect(facts.repointEntity).toHaveBeenCalledTimes(1)
  })

  it("reports archive failures without claiming full success", async () => {
    const { entities, facts } = makeHarness(makeRepointResult())
    entities.archive.mockRejectedValueOnce(new Error("archive failed"))

    const result = await mergeEntities(entities as never, facts as never, {
      winnerId: "ent-winner",
      loserId: "ent-loser",
      apply: true,
    })

    expect(result.errors).toEqual([
      { phase: "archive", message: "archive failed" },
    ])
    expect(result.aliasesAdded).toBe(2)
    expect(result.loserArchived).toBe(false)
    expect(facts.repointEntity).toHaveBeenCalledTimes(1)
  })

  it("reports a post-archive scan failure as partial state", async () => {
    const { entities, facts } = makeHarness(makeRepointResult())
    facts.repointEntity
      .mockReset()
      .mockResolvedValueOnce(makeRepointResult())
      .mockRejectedValueOnce(new Error("scan failed"))

    const result = await mergeEntities(entities as never, facts as never, {
      winnerId: "ent-winner",
      loserId: "ent-loser",
      apply: true,
      today: "2026-05-02",
    })

    expect(result.loserArchived).toBe(true)
    expect(result.errors).toEqual([
      { phase: "repoint", message: "post-archive scan failed: scan failed" },
    ])
  })
})
