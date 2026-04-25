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
  }

  function makeFactsService(facts: Fact[]): FactsServiceMock {
    return {
      queryBySubject: vi.fn().mockResolvedValue(facts),
      invalidate: vi.fn().mockResolvedValue(undefined),
    }
  }

  function makeTaskService(idPrefix = "task"): TaskServiceMock {
    let counter = 0
    return {
      create: vi.fn().mockImplementation(async () => {
        counter += 1
        return { id: `${idPrefix}-${counter}` } as unknown as Task
      }),
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
})
