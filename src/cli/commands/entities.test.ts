import { describe, expect, it, vi } from "vitest"
import type { EntityMergeResult } from "../../core/entity-merge.js"
import type { Entity } from "../../types.js"
import {
  formatEntityMergeResult,
  parseEntityMergeCliOptions,
  runEntityMerge,
} from "./entities.js"

function makeEntity(id: string, name: string): Entity {
  return {
    id,
    name,
    aliases: [],
    kind: null,
    description: "",
    projectIds: [],
  }
}

function makeResult(overrides: Partial<EntityMergeResult> = {}): EntityMergeResult {
  return {
    winner: makeEntity("ent-winner", "AuthService"),
    loser: makeEntity("ent-loser", "AuthSvc"),
    aliasesToAdd: ["AuthSvc"],
    aliasesPlanned: 1,
    aliasesAdded: 1,
    repoint: {
      plans: [{ factId: "fact-1", subject: true, object: false }],
      factsMatched: 1,
      factsRepointed: 1,
      subjectRelationsRepointed: 1,
      objectRelationsRepointed: 0,
      errors: [],
      planOnly: true,
    },
    postArchiveRepoint: null,
    loserArchived: false,
    errors: [],
    planOnly: true,
    ...overrides,
  }
}

describe("formatEntityMergeResult", () => {
  it("renders a plan-only report with the --yes footer", () => {
    const output = formatEntityMergeResult(makeResult())

    expect(output).toContain("Entity merge plan:")
    expect(output).toContain('Winner: "AuthService" (ent-winner)')
    expect(output).toContain('Would add 1 alias: "AuthSvc"')
    expect(output).toContain("Would re-point 1 fact row")
    expect(output).toContain("Would archive loser entity")
    expect(output).toContain("Plan only -- no changes written")
  })

  it("renders partial failures without claiming the loser was archived", () => {
    const output = formatEntityMergeResult(
      makeResult({
        planOnly: false,
        aliasesAdded: 0,
        repoint: {
          plans: [
            { factId: "fact-ok", subject: true, object: false },
            { factId: "fact-fail", subject: false, object: true },
          ],
          factsMatched: 2,
          factsRepointed: 1,
          subjectRelationsRepointed: 1,
          objectRelationsRepointed: 0,
          errors: [{ factId: "fact-fail", message: "notion 429" }],
          planOnly: false,
        },
        errors: [{ phase: "repoint", factId: "fact-fail", message: "notion 429" }],
      })
    )

    expect(output).toContain("Entity merge partially applied:")
    expect(output).toContain('Aliases not written: 1 alias still pending ("AuthSvc").')
    expect(output).toContain("Loser entity not archived")
    expect(output).toContain("repoint fact fact-fail: notion 429")
  })

  it("renders post-archive scan work separately", () => {
    const output = formatEntityMergeResult(
      makeResult({
        planOnly: false,
        loserArchived: true,
        repoint: {
          plans: [{ factId: "fact-1", subject: false, object: true }],
          factsMatched: 1,
          factsRepointed: 1,
          subjectRelationsRepointed: 0,
          objectRelationsRepointed: 1,
          errors: [],
          planOnly: false,
        },
        postArchiveRepoint: {
          plans: [{ factId: "fact-late", subject: true, object: false }],
          factsMatched: 1,
          factsRepointed: 1,
          subjectRelationsRepointed: 1,
          objectRelationsRepointed: 0,
          errors: [],
          planOnly: false,
        },
      })
    )

    expect(output).toContain("Archived loser entity.")
    expect(output).toContain("Re-pointed 1 fact row")
    expect(output).toContain("Post-archive scan re-pointed 1 late fact row.")
  })
})

describe("parseEntityMergeCliOptions", () => {
  it("prefers named --from/--into flags for destructive merges", () => {
    const parsed = parseEntityMergeCliOptions(undefined, undefined, {
      from: "ent-loser",
      into: "ent-winner",
      yes: true,
    })

    expect(parsed).toEqual({
      ok: true,
      value: {
        winnerId: "ent-winner",
        loserId: "ent-loser",
        apply: true,
        dryRun: undefined,
      },
    })
  })

  it("keeps legacy positional ids available", () => {
    const parsed = parseEntityMergeCliOptions("ent-winner", "ent-loser", {
      yes: true,
      dryRun: true,
    })

    expect(parsed).toEqual({
      ok: true,
      value: {
        winnerId: "ent-winner",
        loserId: "ent-loser",
        apply: false,
        dryRun: true,
      },
    })
  })

  it("rejects mixed named and positional ids", () => {
    const parsed = parseEntityMergeCliOptions("ent-winner", undefined, {
      from: "ent-loser",
      into: "ent-winner",
    })

    expect(parsed).toEqual({
      ok: false,
      message: "Use either --from/--into or positional ids, not both.",
    })
  })

  it("requires --from and --into as a pair", () => {
    const parsed = parseEntityMergeCliOptions(undefined, undefined, {
      from: "ent-loser",
    })

    expect(parsed).toEqual({
      ok: false,
      message: "--from and --into must be passed together.",
    })
  })
})

describe("runEntityMerge", () => {
  it("throws a directive error when the vault has no Entities DB", async () => {
    await expect(
      runEntityMerge(
        {
          entities: null,
          facts: {},
        } as never,
        {
          winnerId: "ent-winner",
          loserId: "ent-loser",
          apply: false,
        }
      )
    ).rejects.toThrow(/migrate --build-entities --yes/)
  })

  it("passes the parsed ids and apply flag to the merge orchestrator", async () => {
    const services = {
      entities: {
        getById: vi.fn(async (id: string) =>
          id === "ent-winner"
            ? makeEntity("ent-winner", "AuthService")
            : makeEntity("ent-loser", "AuthSvc")
        ),
        addAliases: vi.fn(),
        archive: vi.fn(),
      },
      facts: {
        repointEntity: vi.fn().mockResolvedValue({
          plans: [],
          factsMatched: 0,
          factsRepointed: 0,
          subjectRelationsRepointed: 0,
          objectRelationsRepointed: 0,
          errors: [],
          planOnly: true,
        }),
      },
    }

    const result = await runEntityMerge(services as never, {
      winnerId: "ent-winner",
      loserId: "ent-loser",
      apply: false,
    })

    expect(result.winner.id).toBe("ent-winner")
    expect(services.facts.repointEntity).toHaveBeenCalledWith(
      expect.objectContaining({
        fromEntityId: "ent-loser",
        toEntityId: "ent-winner",
        apply: false,
      })
    )
  })
})
