import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isInsideSandboxScope, runBenchCleanupOrphans } from "./bench-cleanup.js"
import { generateUlid } from "./bench-runner.js"

describe("isInsideSandboxScope", () => {
  it("accepts a sub-project whose path is prefixed by the parent path", () => {
    expect(isInsideSandboxScope("Bench/lme-x-Y", "Bench")).toBe(true)
  })

  it("rejects a sub-project under a different parent", () => {
    expect(isInsideSandboxScope("OtherSandbox/lme-x-Y", "Bench")).toBe(false)
  })

  it("rejects a sub-project at vault root when parent is not vault-wide", () => {
    expect(isInsideSandboxScope("lme-x-Y", "Bench")).toBe(false)
  })

  it("admits everything when parent path is `.` (vault-wide sandbox)", () => {
    expect(isInsideSandboxScope("anywhere", ".")).toBe(true)
  })
})

describe("runBenchCleanupOrphans", () => {
  let originalEnv: string | undefined
  beforeEach(() => {
    originalEnv = process.env["LORE_EVAL_BENCH_REAL"]
    process.env["LORE_EVAL_BENCH_REAL"] = "1"
  })
  afterEach(() => {
    if (originalEnv === undefined) delete process.env["LORE_EVAL_BENCH_REAL"]
    else process.env["LORE_EVAL_BENCH_REAL"] = originalEnv
  })

  it("refuses to archive without LORE_EVAL_BENCH_REAL", async () => {
    delete process.env["LORE_EVAL_BENCH_REAL"]
    await expect(
      runBenchCleanupOrphans({ olderThanHours: 24, dryRun: false })
    ).rejects.toThrow(/LORE_EVAL_BENCH_REAL/)
  })

  it.each([0, 1.5, Number.NaN])("rejects invalid --older-than %j", async (value) => {
    await expect(
      runBenchCleanupOrphans({
        olderThanHours: value,
        dryRun: false,
        services: {
          sandboxParentPath: ".",
          async listAllProjects() {
            return []
          },
          async archive() {},
        },
      })
    ).rejects.toThrow(/positive integer/)
  })

  it("does NOT archive a stale lme-* project that lives outside the sandbox", async () => {
    // ULID at timestamp 0 — the cutoff (`now - olderThanHours`)
    // must be strictly greater than the ULID's embedded timestamp
    // for the project to count as stale.
    const oldUlid = generateUlid(0)
    const archivedIds: string[] = []
    const report = await runBenchCleanupOrphans({
      olderThanHours: 1,
      dryRun: false,
      now: () => new Date(1_000_000_000),
      services: {
        sandboxParentPath: "Bench",
        async listAllProjects() {
          return [
            // Inside the sandbox — should be archived.
            {
              id: "id-in",
              name: `lme-good-${oldUlid}`,
              path: `Bench/lme-good-${oldUlid}`,
              archived: false,
            },
            // Outside the sandbox — must NOT be archived.
            {
              id: "id-out",
              name: `lme-rogue-${oldUlid}`,
              path: `OtherProject/lme-rogue-${oldUlid}`,
              archived: false,
            },
          ]
        },
        async archive(id) {
          archivedIds.push(id)
        },
      },
    })
    expect(archivedIds).toEqual(["id-in"])
    expect(report.archivedCount).toBe(1)
    expect(report.archived[0]?.name).toContain("lme-good")
  })

  it("dry-run reports the orphan without archiving", async () => {
    // ULID at timestamp 0 — the cutoff (`now - olderThanHours`)
    // must be strictly greater than the ULID's embedded timestamp
    // for the project to count as stale.
    const oldUlid = generateUlid(0)
    let archived = false
    const report = await runBenchCleanupOrphans({
      olderThanHours: 1,
      dryRun: true,
      now: () => new Date(1_000_000_000),
      services: {
        sandboxParentPath: "Bench",
        async listAllProjects() {
          return [
            {
              id: "id-1",
              name: `lme-x-${oldUlid}`,
              path: `Bench/lme-x-${oldUlid}`,
              archived: false,
            },
          ]
        },
        async archive() {
          archived = true
        },
      },
    })
    expect(archived).toBe(false)
    expect(report.archivedCount).toBe(0)
    expect(report.skipped[0]?.reason).toBe("dry-run")
  })

  it("skips already-archived rows (idempotent)", async () => {
    // ULID at timestamp 0 — the cutoff (`now - olderThanHours`)
    // must be strictly greater than the ULID's embedded timestamp
    // for the project to count as stale.
    const oldUlid = generateUlid(0)
    const archivedIds: string[] = []
    await runBenchCleanupOrphans({
      olderThanHours: 1,
      dryRun: false,
      now: () => new Date(1_000_000_000),
      services: {
        sandboxParentPath: "Bench",
        async listAllProjects() {
          return [
            {
              id: "id-arch",
              name: `lme-x-${oldUlid}`,
              path: `Bench/lme-x-${oldUlid}`,
              archived: true,
            },
          ]
        },
        async archive(id) {
          archivedIds.push(id)
        },
      },
    })
    expect(archivedIds).toEqual([])
  })
})
