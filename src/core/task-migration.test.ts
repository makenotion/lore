import { describe, expect, it, vi } from "vitest"
import {
  migrateTrackingFactsToTasks,
  planTaskFromFact,
  trackingPredicateToTaskState,
} from "./task-migration.js"
import type { Fact, FactPredicate, Task } from "../types.js"

function makeFact(overrides: Partial<Fact> & { predicate: FactPredicate }): Fact {
  const base: Fact = {
    id: `fact-${Math.random().toString(36).slice(2, 8)}`,
    subject: "AuthService",
    predicate: overrides.predicate,
    object: "Rotate signing keys",
    projectIds: ["proj-a"],
    validFrom: "2026-04-01",
    validUntil: null,
    reviewBy: "2026-04-15",
    sourceMemoryId: "mem-source",
    confidence: "certain",
  }
  return { ...base, ...overrides }
}

describe("trackingPredicateToTaskState", () => {
  it("maps blocked_by → blocked, others → open", () => {
    expect(trackingPredicateToTaskState("blocked_by")).toBe("blocked")
    expect(trackingPredicateToTaskState("needs_action")).toBe("open")
    expect(trackingPredicateToTaskState("waiting_on")).toBe("open")
  })
})

describe("planTaskFromFact", () => {
  it("preserves source memory provenance via affectsIds", () => {
    const fact = makeFact({ predicate: "needs_action", sourceMemoryId: "mem-x" })
    const plan = planTaskFromFact(fact)
    expect(plan.task.affectsIds).toEqual(["mem-x"])
  })

  it("emits an empty affectsIds for orphan facts (no source memory)", () => {
    const fact = makeFact({ predicate: "needs_action", sourceMemoryId: null })
    const plan = planTaskFromFact(fact)
    expect(plan.task.affectsIds).toEqual([])
  })

  it("moves Object into Blocked By for blocked_by facts (column purpose match)", () => {
    const fact = makeFact({
      predicate: "blocked_by",
      object: "PR #25750 review",
    })
    const plan = planTaskFromFact(fact)
    expect(plan.task.state).toBe("blocked")
    expect(plan.task.blockedBy).toBe("PR #25750 review")
  })

  it("uses Blocked By for waiting_on too — the Object names what we wait on", () => {
    const fact = makeFact({
      predicate: "waiting_on",
      object: "Legal review",
    })
    const plan = planTaskFromFact(fact)
    expect(plan.task.state).toBe("open")
    expect(plan.task.blockedBy).toBe("Legal review")
  })

  it("leaves Blocked By empty for needs_action — Object is the work itself", () => {
    const fact = makeFact({
      predicate: "needs_action",
      object: "Audit secret rotation policy",
    })
    const plan = planTaskFromFact(fact)
    expect(plan.task.state).toBe("open")
    expect(plan.task.blockedBy).toBeUndefined()
  })

  it("entity defaults to subject so lore-ask routes through it post-migration", () => {
    const fact = makeFact({
      predicate: "needs_action",
      subject: "AuthService",
    })
    const plan = planTaskFromFact(fact)
    expect(plan.task.entity).toBe("AuthService")
  })

  it("dueDate carries the fact's reviewBy forward — overdue rows stay overdue", () => {
    const fact = makeFact({ predicate: "needs_action", reviewBy: "2026-03-01" })
    const plan = planTaskFromFact(fact)
    expect(plan.task.dueDate).toBe("2026-03-01")
  })
})

describe("migrateTrackingFactsToTasks", () => {
  type FactsServiceMock = {
    queryBySubject: ReturnType<typeof vi.fn>
    invalidate: ReturnType<typeof vi.fn>
  }
  type TaskServiceMock = {
    create: ReturnType<typeof vi.fn>
    findMigratedFactIds: ReturnType<typeof vi.fn>
  }

  function makeFactsService(facts: Fact[]): FactsServiceMock {
    return {
      queryBySubject: vi.fn().mockResolvedValue(facts),
      invalidate: vi.fn().mockResolvedValue(undefined),
    }
  }

  function makeTaskService(
    idPrefix = "task",
    migrationMap: Map<string, string> = new Map()
  ): TaskServiceMock {
    let counter = 0
    return {
      create: vi.fn().mockImplementation(async () => {
        counter += 1
        return { id: `${idPrefix}-${counter}` } as unknown as Task
      }),
      findMigratedFactIds: vi.fn().mockResolvedValue(migrationMap),
    }
  }

  it("plan-only mode does not invalidate or create — every plan has taskId=null", async () => {
    const facts = [
      makeFact({ predicate: "needs_action" }),
      makeFact({ predicate: "blocked_by" }),
    ]
    const factsService = makeFactsService(facts)
    const taskService = makeTaskService()

    const result = await migrateTrackingFactsToTasks(factsService as never, taskService as never, {
      apply: false,
    })

    expect(result.planOnly).toBe(true)
    expect(result.plans).toHaveLength(2)
    expect(result.plans.every((p) => p.taskId === null)).toBe(true)
    expect(taskService.create).not.toHaveBeenCalled()
    expect(factsService.invalidate).not.toHaveBeenCalled()
  })

  it("apply mode creates each task and invalidates the source fact", async () => {
    const facts = [
      makeFact({ id: "fact-1", predicate: "needs_action" }),
      makeFact({ id: "fact-2", predicate: "blocked_by", object: "PR #25700" }),
    ]
    const factsService = makeFactsService(facts)
    const taskService = makeTaskService()

    const result = await migrateTrackingFactsToTasks(factsService as never, taskService as never, {
      apply: true,
    })

    expect(result.planOnly).toBe(false)
    expect(result.invalidated).toBe(2)
    expect(result.plans.every((p) => p.taskId !== null)).toBe(true)
    expect(factsService.invalidate).toHaveBeenCalledWith("fact-1")
    expect(factsService.invalidate).toHaveBeenCalledWith("fact-2")
    // Provenance: source memory survives as affectsIds.
    expect(taskService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "AuthService",
        affectsIds: ["mem-source"],
        keywords: expect.stringContaining("migrated-from-fact fact-1"),
      })
    )
    // blocked_by Object lands in Blocked By.
    expect(taskService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        state: "blocked",
        blockedBy: "PR #25700",
      })
    )
  })

  it("isolates per-fact failures so one bad row doesn't sink the run", async () => {
    const facts = [
      makeFact({ id: "fact-good", predicate: "needs_action" }),
      makeFact({ id: "fact-bad", predicate: "needs_action" }),
    ]
    const factsService = makeFactsService(facts)
    const taskService: TaskServiceMock = {
      create: vi
        .fn()
        .mockResolvedValueOnce({ id: "task-1" } as unknown as Task)
        .mockRejectedValueOnce(new Error("notion 5xx")),
      findMigratedFactIds: vi.fn().mockResolvedValue(new Map()),
    }

    const result = await migrateTrackingFactsToTasks(factsService as never, taskService as never, {
      apply: true,
    })

    // First task succeeded, second failed — the run completed.
    expect(result.invalidated).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toEqual({
      factId: "fact-bad",
      message: "notion 5xx",
    })
    // Plans array still records the failed row but with taskId=null.
    expect(result.plans.find((p) => p.fact.id === "fact-bad")?.taskId).toBeNull()
  })

  it("writes the migrated-from-fact keyword so reruns can find the row", async () => {
    // The keyword token is the idempotency hinge — without it, a
    // partial-failure rerun has nothing to look up. Pin the format so
    // a future refactor of `buildMigrationKeyword` doesn't silently
    // break heal-path detection.
    const facts = [makeFact({ id: "fact-1", predicate: "needs_action" })]
    const factsService = makeFactsService(facts)
    const taskService = makeTaskService()

    await migrateTrackingFactsToTasks(factsService as never, taskService as never, {
      apply: true,
    })

    expect(taskService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        keywords: "migrated-from-fact fact-1",
      })
    )
  })

  it("rerun with a migrated-fact map skips create, retries invalidate, and tags rows already-migrated", async () => {
    // Simulates the failure mode the issue calls out:
    //   1. Prior apply pass: created task-existing-1 for fact-1 +
    //      task-existing-2 for fact-2.
    //   2. Both invalidate steps failed (network blip), so both facts
    //      remain live and re-surface as candidates this pass.
    //   3. This pass must not re-create — the existing tasks are
    //      bound via the migration map — but it must retry both
    //      invalidations to converge on a clean state.
    const facts = [
      makeFact({ id: "fact-1", predicate: "needs_action" }),
      makeFact({ id: "fact-2", predicate: "blocked_by" }),
    ]
    const factsService = makeFactsService(facts)
    const taskService = makeTaskService(
      "task",
      new Map([
        ["fact-1", "task-existing-1"],
        ["fact-2", "task-existing-2"],
      ])
    )

    const result = await migrateTrackingFactsToTasks(factsService as never, taskService as never, {
      apply: true,
    })

    expect(taskService.create).not.toHaveBeenCalled()
    expect(factsService.invalidate).toHaveBeenCalledWith("fact-1")
    expect(factsService.invalidate).toHaveBeenCalledWith("fact-2")
    expect(result.alreadyMigrated).toBe(2)
    expect(result.invalidated).toBe(2)
    expect(result.plans).toEqual([
      expect.objectContaining({
        taskId: "task-existing-1",
        alreadyMigrated: true,
      }),
      expect.objectContaining({
        taskId: "task-existing-2",
        alreadyMigrated: true,
      }),
    ])
  })

  it("plan-only rerun surfaces already-migrated rows without writing anything", async () => {
    // Mirrors the previous test but with apply: false. The plan output
    // must still show the existing taskId so an operator running with
    // --dry-run can see what would be skipped.
    const facts = [makeFact({ id: "fact-1", predicate: "needs_action" })]
    const factsService = makeFactsService(facts)
    const taskService = makeTaskService(
      "task",
      new Map([["fact-1", "task-existing-1"]])
    )

    const result = await migrateTrackingFactsToTasks(factsService as never, taskService as never, {
      apply: false,
    })

    expect(taskService.create).not.toHaveBeenCalled()
    expect(factsService.invalidate).not.toHaveBeenCalled()
    expect(result.planOnly).toBe(true)
    expect(result.alreadyMigrated).toBe(1)
    expect(result.invalidated).toBe(0)
    expect(result.plans[0]).toMatchObject({
      taskId: "task-existing-1",
      alreadyMigrated: true,
    })
  })

  it("rerun heal path tolerates a still-failing invalidate without re-creating the task", async () => {
    // The third failure mode: the marker exists, the heal path retries
    // the invalidate, and that retry *also* fails. The migration must
    // not create a duplicate task — it must surface the error and
    // leave the next run to try once more. The whole point of this
    // change is "no duplicate tasks ever," even when retries fail.
    const facts = [makeFact({ id: "fact-1", predicate: "needs_action" })]
    const factsService: FactsServiceMock = {
      queryBySubject: vi.fn().mockResolvedValue(facts),
      invalidate: vi.fn().mockRejectedValue(new Error("notion 5xx")),
    }
    const taskService = makeTaskService(
      "task",
      new Map([["fact-1", "task-existing-1"]])
    )

    const result = await migrateTrackingFactsToTasks(factsService as never, taskService as never, {
      apply: true,
    })

    expect(taskService.create).not.toHaveBeenCalled()
    expect(result.invalidated).toBe(0)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0].factId).toBe("fact-1")
    expect(result.plans[0]).toMatchObject({
      taskId: "task-existing-1",
      alreadyMigrated: true,
    })
  })

  it("falls back to empty map when findMigratedFactIds rejects with the missing-task-option validation error", async () => {
    // Pre-schema-migration vault: no `task` option exists yet, so
    // `findMigratedFactIds` rejects with a validation_error pointing at
    // the missing option. The migration must proceed (empty map is
    // correct — no migrated tasks can exist), not crash with an
    // unhelpful error in the middle of an `--migrate-tracking-to-tasks`
    // dry run that the operator was using to preview before applying.
    const facts = [makeFact({ id: "fact-1", predicate: "needs_action" })]
    const factsService = makeFactsService(facts)
    const taskService: TaskServiceMock = {
      create: vi.fn().mockResolvedValue({ id: "task-1" } as unknown as Task),
      findMigratedFactIds: vi.fn().mockRejectedValue(
        Object.assign(
          new Error('select option "task" not found for property "Kind"'),
          { code: "validation_error" }
        )
      ),
    }

    const result = await migrateTrackingFactsToTasks(
      factsService as never,
      taskService as never,
      { apply: false }
    )

    expect(result.alreadyMigrated).toBe(0)
    expect(result.plans).toHaveLength(1)
    expect(result.plans[0].alreadyMigrated).toBe(false)
  })

  it("re-throws non-validation errors from findMigratedFactIds so the caller hears about transient failures", async () => {
    // The narrow fallback above must NOT swallow rate_limited / network
    // / any-other errors. Otherwise a transient failure would degrade
    // into "no idempotency, may double-create" — the very bug this
    // change is meant to close.
    const facts = [makeFact({ id: "fact-1", predicate: "needs_action" })]
    const factsService = makeFactsService(facts)
    const taskService: TaskServiceMock = {
      create: vi.fn(),
      findMigratedFactIds: vi.fn().mockRejectedValue(
        Object.assign(new Error("rate limited"), { code: "rate_limited" })
      ),
    }

    await expect(
      migrateTrackingFactsToTasks(factsService as never, taskService as never, {
        apply: true,
      })
    ).rejects.toThrow("rate limited")
    expect(taskService.create).not.toHaveBeenCalled()
  })

  it("skips the migration-map lookup entirely when there are no candidates", async () => {
    // Clean vault — no tracking facts. The bulk pre-fetch should not
    // fire because there's nothing to look up; saves one round-trip on
    // every "nothing to migrate" run.
    const factsService = makeFactsService([])
    const taskService = makeTaskService()

    const result = await migrateTrackingFactsToTasks(factsService as never, taskService as never, {
      apply: true,
    })

    expect(taskService.findMigratedFactIds).not.toHaveBeenCalled()
    expect(result.plans).toHaveLength(0)
  })
})
