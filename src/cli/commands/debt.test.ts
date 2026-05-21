/**
 * Tests for `lore debt scan` / `lore debt create-tasks` (issue #288).
 *
 * Three surfaces:
 *
 *  1. `findExistingDebtTask` — the idempotency probe powering Phase 2's
 *     non-duplicate-creation contract. Pinned in isolation so the probe's
 *     behavior is testable without spinning up a full Commander parse.
 *  2. `debtTaskMarker` — the stable token glued to the probe; pinned for
 *     byte-stability across runs.
 *  3. CLI exit paths — `trapProcessExit` regression coverage for every
 *     `process.exit(1)` call site in both subcommands, per the
 *     "Testing exit paths" rule in `src/cli/AGENTS.md`. Without these,
 *     a refactor that drops a defensive `return` after `process.exit(1)`
 *     could let the action fall through to the outer try/catch and
 *     double-emit the exit/error, silently breaking shell-script
 *     callers (`if ! lore debt scan; then …`).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { debtCommand, findExistingDebtTask, renderDebtMarkdown } from "./debt.js"
import {
  debtTaskMarker,
  type DebtItem,
  type DebtReport,
  type DebtStats,
} from "../../core/memory-debt.js"
import { initServices, type LoreServices } from "../../services.js"
import { trapProcessExit } from "../test-helpers.js"
import type { Memory } from "../../types.js"

vi.mock("../../services.js", async (importOriginal) => {
  // Preserve every real export so consumers other than the action
  // — e.g. `memory-debt.ts`'s `probeScopeColumnsPresent` import —
  // still see the live implementation. Override only `initServices`.
  const actual = await importOriginal<typeof import("../../services.js")>()
  return {
    ...actual,
    initServices: vi.fn(),
  }
})

function makeDebtItem(overrides: Partial<DebtItem> & { id: string }): DebtItem {
  return {
    priority: "P1",
    category: "orphan_fact",
    entityType: "fact",
    entityId: "fact-1",
    title: "AuthService depends_on SessionStore",
    score: 80,
    reasons: ["Source relation is empty"],
    suggestedActions: ["attach_source"],
    safeToAutoFix: false,
    ...overrides,
  }
}

function makeMemory(
  overrides: Partial<Memory> & { id: string; title: string; keywords: string }
): Memory {
  return {
    projectIds: ["proj-a"],
    topicId: null,
    source: "manual",
    kind: "task",
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
    synopsis: "",
    session: "",
    content: "",
    taskState: "open",
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

/**
 * Stub `services.memories.search` that faithfully simulates Notion's
 * server-side `Status` select-filter behavior:
 *
 *  - **Explicit `status: X`** → Notion's `select.equals X` only matches
 *    rows whose Status value is exactly `X`. Empty `Status` (the shape
 *    `TaskService.create` produces — see `src/core/task.ts:206-264`) is
 *    NOT matched by any explicit equals filter.
 *  - **No `status:` filter** → Notion applies the
 *    `reviewTerminalStatusExclusionFilters` (`does_not_equal:
 *    "proposed"` AND `does_not_equal: "rejected"`). `does_not_equal`
 *    is permissive on null/empty selects, so empty `Status` rows
 *    pass and are returned.
 *
 * The previous stub returned every result on every call, masking the
 * unset-Status bug the principal review surfaced. This shape proves
 * the probe finds debt tasks even though `TaskService.create` leaves
 * `Status` empty.
 *
 * Memories carrying a `status` value not in `MemoryStatus` (specifically
 * the empty string `""`) are typed via cast — the stub treats them as
 * Notion's empty-select shape.
 */
function makeServices(opts: { searchResults?: Memory[] }): LoreServices {
  return {
    memories: {
      search: vi.fn(async (input: { status?: string }) => {
        const all = opts.searchResults ?? []
        if (input.status === undefined) {
          // Default: exclude proposed + rejected, include everything
          // else INCLUDING empty / unset Status rows.
          return all.filter((m) => m.status !== "proposed" && m.status !== "rejected")
        }
        // Explicit equals: only exact-match rows.
        return all.filter((m) => m.status === input.status)
      }),
    },
  } as unknown as LoreServices
}

describe("debtTaskMarker", () => {
  it("flattens :: separators so the marker is one search-friendly token", () => {
    expect(debtTaskMarker("orphan_fact::abc-123")).toBe(
      "lore-debt-id-orphan_fact-abc-123"
    )
    expect(debtTaskMarker("duplicate_cluster::aaa::bbb")).toBe(
      "lore-debt-id-duplicate_cluster-aaa-bbb"
    )
    expect(debtTaskMarker("scope_anomaly::expired")).toBe(
      "lore-debt-id-scope_anomaly-expired"
    )
  })

  it("is byte-stable across calls (idempotency contract pin)", () => {
    const id = "orphan_fact::abc-123"
    expect(debtTaskMarker(id)).toBe(debtTaskMarker(id))
  })
})

describe("findExistingDebtTask (idempotency probe)", () => {
  it("returns null when no task contains the debt marker", async () => {
    const services = makeServices({ searchResults: [] })
    const result = await findExistingDebtTask(
      services,
      makeDebtItem({ id: "orphan_fact::abc-123" }),
      "proj-a"
    )
    expect(result).toBeNull()
  })

  it("returns the task id when a search result carries the marker in keywords", async () => {
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const marker = debtTaskMarker(item.id)
    const matched = makeMemory({
      id: "task-1",
      title: "[debt:orphan_fact] AuthService depends_on SessionStore",
      keywords: `${marker} debt-orphan_fact fact-1`,
    })
    const services = makeServices({ searchResults: [matched] })
    const result = await findExistingDebtTask(services, item, "proj-a")
    expect(result).toBe("task-1")
  })

  it("rejects a search match that lacks the marker substring (defense in depth)", async () => {
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    // A task whose title literally contains the word "lore-debt-id"
    // but does NOT have the canonical marker in keywords. The contains
    // search might surface it; the post-filter must reject it.
    const decoy = makeMemory({
      id: "task-decoy",
      title: "lore-debt-id documentation patterns",
      keywords: "documentation",
    })
    const services = makeServices({ searchResults: [decoy] })
    const result = await findExistingDebtTask(services, item, "proj-a")
    expect(result).toBeNull()
  })

  it("returns the existing id even for closed tasks (honors operator's prior close)", async () => {
    // The reviewer's intent: re-running create-tasks must not re-mint
    // a task the operator deliberately closed. A done task carrying
    // the marker is still a match.
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const marker = debtTaskMarker(item.id)
    const doneTask = makeMemory({
      id: "task-closed",
      title: "closed audit task",
      taskState: "done",
      doneAt: "2026-05-01",
      keywords: `${marker} debt-orphan_fact fact-1`,
    })
    const services = makeServices({ searchResults: [doneTask] })
    const result = await findExistingDebtTask(services, item, "proj-a")
    expect(result).toBe("task-closed")
  })

  it("scopes the probe to the requested project when provided", async () => {
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const services = makeServices({ searchResults: [] })
    await findExistingDebtTask(services, item, "proj-a")
    expect(services.memories.search).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj-a",
        kind: "task",
        mode: "contains",
      })
    )
  })

  it("issues the search with project filter omitted when no project is set", async () => {
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const services = makeServices({ searchResults: [] })
    await findExistingDebtTask(services, item, undefined)
    const firstCall = vi.mocked(services.memories.search).mock.calls[0]?.[0]
    // Omit (rather than `projectId: undefined`) so the search doesn't
    // accidentally narrow on a stringified undefined.
    expect(firstCall).not.toHaveProperty("projectId")
  })

  it("returns a marker-bearing task whose projectIds are empty when probed under --project", async () => {
    // Cross-scope reuse: task was created during a vault-wide
    // `lore debt create-tasks` (no `--project`), so its `projectIds`
    // is empty. A subsequent `lore debt create-tasks --project Mail`
    // probes with `projectId: "proj-a"`. `MemoryService.search`
    // applies `projectOrUnscopedFilter` (`Project relation contains
    // proj-a OR Project is_empty`), so the unscoped task surfaces
    // server-side. The probe itself does NOT filter further on
    // `projectIds` — defense in depth lives only on the marker
    // substring. Pin that contract here.
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const marker = debtTaskMarker(item.id)
    const unscoped = makeMemory({
      id: "task-unscoped",
      title: "[debt:orphan_fact] vault-wide audit",
      keywords: marker,
      projectIds: [],
    })
    const services = makeServices({ searchResults: [unscoped] })
    const result = await findExistingDebtTask(services, item, "proj-a")
    expect(result).toBe("task-unscoped")
  })

  it("returns a marker-bearing task whose projectIds is scoped when probed vault-wide", async () => {
    // Inverse cross-scope: task was created under `--project Mail`
    // with `projectIds: ["proj-a"]`. A vault-wide rerun (no
    // `--project`) passes `projectId: undefined`, so the search
    // applies no project filter and the scoped task surfaces.
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const marker = debtTaskMarker(item.id)
    const scoped = makeMemory({
      id: "task-scoped",
      title: "[debt:orphan_fact] Mail audit",
      keywords: marker,
      projectIds: ["proj-a"],
    })
    const services = makeServices({ searchResults: [scoped] })
    const result = await findExistingDebtTask(services, item, undefined)
    expect(result).toBe("task-scoped")
  })

  it("matches a marker-bearing task with status='superseded' via the default-no-status pass", async () => {
    // Operator workflow: a debt task gets superseded by a follow-up
    // task. The status flips to `superseded` (still active reach
    // semantically — the row hasn't been archived). The probe's
    // default-no-status pass excludes `proposed` and `rejected` but
    // matches every other Status value INCLUDING `superseded`, so
    // the rerun honors the supersession and skips re-mint.
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const marker = debtTaskMarker(item.id)
    const superseded = makeMemory({
      id: "task-superseded",
      title: "[debt:orphan_fact] superseded by newer audit",
      keywords: marker,
      status: "superseded",
    })
    const services = makeServices({ searchResults: [superseded] })
    const result = await findExistingDebtTask(services, item, "proj-a")
    expect(result).toBe("task-superseded")
  })

  it("matches a marker-bearing task with status='rejected' via the explicit rejected pass", async () => {
    // The default pass excludes rejected rows server-side via
    // `does_not_equal: "rejected"`. The explicit `status: "rejected"`
    // probe catches them so the operator's prior "do not re-create"
    // decision is honored on rerun.
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const marker = debtTaskMarker(item.id)
    const rejected = makeMemory({
      id: "task-rejected",
      title: "[debt:orphan_fact] rejected audit",
      keywords: marker,
      status: "rejected",
    })
    const services = makeServices({ searchResults: [rejected] })
    const result = await findExistingDebtTask(services, item, "proj-a")
    expect(result).toBe("task-rejected")
  })

  it("finds a debt task created via TaskService.create (Status is unset)", async () => {
    // Mirrors the real write path: `TaskService.create` does NOT
    // write the `Status` select (see `src/core/task.ts:206-264`), so
    // the row's Notion Status column stays empty. An earlier
    // iteration of the probe queried each include-eligible status
    // via `select.equals`, which does not match empty selects — so
    // a rerun missed the just-created task and minted a duplicate.
    // The current probe runs a default-no-status pass first; this
    // test pins that behavior.
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const marker = debtTaskMarker(item.id)
    const created = makeMemory({
      id: "task-just-created",
      title: "[debt:orphan_fact] AuthService depends_on SessionStore",
      keywords: `${marker} debt-orphan_fact fact-1`,
      // The stub simulates Notion's empty-select shape via the
      // empty-string sentinel — `MemoryStatus` is a closed union, so
      // the cast is the only way to express "no status set" without
      // changing the public type for one fixture.
      status: "" as Memory["status"],
    })
    const services = makeServices({ searchResults: [created] })
    const result = await findExistingDebtTask(services, item, "proj-a")
    expect(result).toBe("task-just-created")
  })

  it("issues exactly three coverage passes when no result is found", async () => {
    // Three probes cover the full Status space: default (no filter,
    // matches empty + informational + accepted + deprecated +
    // superseded), explicit `proposed`, explicit `rejected`. Pinned
    // exactly (`.toBe(3)`) rather than `toBeLessThanOrEqual(3)` so a
    // future regression that drops the `proposed` or `rejected` pass
    // is caught — the looser inequality would silently accept a
    // smaller probe set.
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const services = makeServices({ searchResults: [] })
    await findExistingDebtTask(services, item, "proj-a")
    expect(vi.mocked(services.memories.search).mock.calls.length).toBe(3)
  })

  it("short-circuits on the first marker-bearing hit in the default pass", async () => {
    // Load-bearing latency optimization: a marker-bearing row that
    // the default-no-status pass surfaces does NOT trigger the
    // proposed / rejected probes. Exactly one search call.
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const marker = debtTaskMarker(item.id)
    const matched = makeMemory({
      id: "task-1",
      title: "matched once",
      keywords: marker,
    })
    const services = makeServices({ searchResults: [matched] })
    const result = await findExistingDebtTask(services, item, "proj-a")
    expect(result).toBe("task-1")
    expect(vi.mocked(services.memories.search).mock.calls.length).toBe(1)
  })

  it("runs all three passes when no row carries the marker substring", async () => {
    // Non-matching decoy: surfaces in the default-no-status pass
    // (status `informational` is included by the stub's
    // default-exclude shape) but lacks the marker token in keywords.
    // The probe sees the row, post-filter rejects it (no marker),
    // and the loop continues to the explicit `proposed` and
    // `rejected` passes — both return empty under the status stub.
    // Asserts no short-circuit on a non-matching row.
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const decoy = makeMemory({
      id: "task-decoy",
      title: "lore-debt-id documentation patterns",
      keywords: "no-marker-here",
      status: "informational",
    })
    const services = makeServices({ searchResults: [decoy] })
    const result = await findExistingDebtTask(services, item, "proj-a")
    expect(result).toBeNull()
    expect(vi.mocked(services.memories.search).mock.calls.length).toBe(3)
  })

  it("dedupes by page id when the same row surfaces under multiple passes", async () => {
    // Construct an adversarial stub where the SAME row id is
    // returned under multiple coverage passes. Real Notion never
    // does this — `select.equals "proposed"` and the default
    // `does_not_equal "proposed"` are mutually exclusive — but a
    // future refactor that loosens the probe's status segmentation
    // (or a hypothetical Notion change that lets explicit + default
    // filters overlap on the same row) would let one row appear in
    // two pass results. The `seen` Set guard in `findExistingDebtTask`
    // protects against re-running the post-filter on a re-seen id.
    //
    // To prove the guard works, we wire a tracked `keywords` getter
    // that counts post-filter invocations. The post-filter accesses
    // `keywords` TWICE per iteration (`typeof m.keywords === "string"`
    // + `m.keywords.includes(marker)`), so:
    //  - With dedupe: 1 iteration × 2 reads = 2 accesses total.
    //  - Without dedupe: 3 iterations × 2 reads = 6 accesses total.
    // Asserting exactly 2 catches the regression in either direction.
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    let keywordsAccessCount = 0
    const sharedRow = {
      ...makeMemory({
        id: "task-shared",
        title: "non-matching row that surfaces twice",
        keywords: "", // placeholder; real value below
      }),
    } as Memory & { keywords: string }
    Object.defineProperty(sharedRow, "keywords", {
      get() {
        keywordsAccessCount++
        return "no-marker-here"
      },
    })
    // Custom services: every search call returns the same shared row
    // regardless of `status` filter — simulates the cross-pass-
    // overlap shape the dedupe guard exists to handle.
    const services = {
      memories: {
        search: vi.fn(async () => [sharedRow]),
      },
    } as unknown as LoreServices
    const result = await findExistingDebtTask(services, item, "proj-a")
    expect(result).toBeNull()
    // All three passes ran (no marker-bearing short-circuit).
    expect(vi.mocked(services.memories.search).mock.calls.length).toBe(3)
    // Dedupe guard fired: post-filter accessed `keywords` exactly
    // twice (typeof check + includes call on the same iteration).
    // Without `seen.has(m.id) → continue`, three iterations would
    // produce 6 accesses.
    expect(keywordsAccessCount).toBe(2)
  })

  it("issues server-side searches with limit >= 1 per pass", async () => {
    // Pin the per-pass `limit` so a future refactor that sets it to
    // 0 (or drops the field entirely, letting MemoryService default
    // to 10 and pay an unnecessary round-trip) is caught. The exact
    // value is implementation detail (currently 5 — enough headroom
    // for the rare case of multiple marker-bearing tasks per debt id
    // produced by historical buggy runs); the contract is that it's
    // a positive integer ≥ 1.
    const item = makeDebtItem({ id: "orphan_fact::abc-123" })
    const services = makeServices({ searchResults: [] })
    await findExistingDebtTask(services, item, "proj-a")
    for (const call of vi.mocked(services.memories.search).mock.calls) {
      const arg = call[0] as { limit?: number }
      expect(arg.limit).toBeGreaterThanOrEqual(1)
    }
  })
})

describe("debtCommand exit paths", () => {
  // Pin every `process.exit(1)` site so a refactor that drops the
  // defensive `return` falls back to the outer try/catch path —
  // which would double-emit error + exit — and the test catches it
  // via `toEqual([1])` (not `toContain(1)`). See PR #512's review
  // for the rationale; `src/cli/AGENTS.md` § "Testing exit paths"
  // is the canonical contract.
  let errorSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    exitTrap = trapProcessExit()
    errorSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(process.stdout, "write").mockImplementation(
      ((..._a: unknown[]) => true) as never
    )
    vi.spyOn(process.stderr, "write").mockImplementation(
      ((..._a: unknown[]) => true) as never
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("scan: exits 1 when --project and --all-projects are combined", async () => {
    await debtCommand.parseAsync(["scan", "--project", "Mail", "--all-projects"], {
      from: "user",
    })
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Debt scan failed:")
    expect(errorText).toContain("--project and --all-projects are mutually exclusive")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("scan: exits 1 on malformed --limit", async () => {
    await debtCommand.parseAsync(["scan", "--limit", "banana"], { from: "user" })
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Debt scan failed:")
    expect(errorText).toContain("--limit")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("scan: exits 1 on unknown --category", async () => {
    await debtCommand.parseAsync(["scan", "--category", "not_a_real_category"], {
      from: "user",
    })
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Debt scan failed:")
    expect(errorText).toContain("unknown --category")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("scan: exits 1 when initServices throws", async () => {
    vi.mocked(initServices).mockRejectedValue(new Error("notion 503"))
    await debtCommand.parseAsync(["scan", "--all-projects"], { from: "user" })
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Debt scan failed:")
    expect(errorText).toContain("notion 503")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("create-tasks: exits 1 when --project and --all-projects are combined", async () => {
    await debtCommand.parseAsync(
      ["create-tasks", "--project", "Mail", "--all-projects"],
      { from: "user" }
    )
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Debt create-tasks failed:")
    expect(errorText).toContain("mutually exclusive")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
  })

  it("create-tasks: exits 1 on invalid --priority-floor", async () => {
    await debtCommand.parseAsync(["create-tasks", "--priority-floor", "P3"], {
      from: "user",
    })
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Debt create-tasks failed:")
    expect(errorText).toContain("--priority-floor")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("create-tasks: exits 1 on malformed --limit", async () => {
    await debtCommand.parseAsync(["create-tasks", "--limit", "3.7"], { from: "user" })
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("create-tasks: exits 1 when initServices throws", async () => {
    vi.mocked(initServices).mockRejectedValue(new Error("auth broken"))
    await debtCommand.parseAsync(["create-tasks", "--all-projects", "--dry-run"], {
      from: "user",
    })
    const errorText = errorSpy.mock.calls.flat().join("\n")
    expect(errorText).toContain("Debt create-tasks failed:")
    expect(errorText).toContain("auth broken")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it("create-tasks: exits 1 with partial-failure summary when one per-item create rejects", async () => {
    // Build a services stub that surfaces one orphan-fact debt item,
    // empty results for every other category, AND rejects the
    // `tasks.create` call. The action must:
    //  - emit the per-item `! failed to create task for <id>: …` stderr line
    //  - emit the `Debt create-tasks: N tasks failed to create; exit 1.` summary
    //  - exit non-zero so a script consumer can distinguish a clean
    //    pass from an incomplete one (the contract documented in
    //    `docs/memory-debt.md`'s "Partial-failure contract" section).
    const stderrSpy = vi.fn()
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderrSpy(typeof chunk === "string" ? chunk : String(chunk))
      return true
    }) as never)
    vi.mocked(initServices).mockResolvedValue({
      memories: {
        // First call: the eligibility scan (queryStaleConfidence etc.).
        // Subsequent calls: the preflight search returning empty (no
        // existing audit task). Both shapes covered by returning empty.
        queryStaleConfidence: vi.fn(async () => []),
        listForScan: vi.fn(async () => [[]]),
        list: vi.fn(async () => ({ items: [], capped: false })),
        expiringScopedStats: vi.fn(async () => ({
          expired: 0,
          expiringSoon: 0,
          narrowScopeOutOfContext: 0,
        })),
        search: vi.fn(async () => []),
      },
      facts: {
        queryOrphans: vi.fn(async () => [
          {
            id: "f1",
            subject: "AuthService",
            predicate: "depends_on",
            object: "SessionStore",
            projectIds: [],
            validFrom: null,
            validUntil: null,
            reviewBy: null,
            sourceMemoryId: null,
            confidence: "certain",
            confidenceScore: null,
            lastReferencedAt: null,
            createdAt: "2026-04-01T00:00:00.000Z",
            subjectEntityId: null,
            objectEntityId: null,
            scope: null,
          },
        ]),
        queryOverdue: vi.fn(async () => []),
        expiringScopedStats: vi.fn(async () => ({
          expired: 0,
          expiringSoon: 0,
          narrowScopeOutOfContext: 0,
        })),
      },
      decisions: { queryOverdue: vi.fn(async () => []) },
      tasks: {
        queryOverdue: vi.fn(async () => []),
        list: vi.fn(async () => ({ items: [], capped: false })),
        create: vi.fn(async () => {
          throw new Error("notion 429")
        }),
      },
      projects: { list: vi.fn(async () => []) },
      vault: {
        databases: {
          topics: { databaseId: "topics-db", dataSourceId: "topics-ds" },
          memories: { databaseId: "memories-db", dataSourceId: "memories-ds" },
          facts: { databaseId: "facts-db", dataSourceId: "facts-ds" },
        },
      },
      client: {
        dataSources: {
          query: vi.fn(async () => ({
            results: [],
            has_more: false,
            next_cursor: null,
          })),
          // Schema probe target — return properties with the #283
          // scope columns present so `safeLoadExpiringScopedStatus`
          // doesn't degrade to null on these CLI tests.
          retrieve: vi.fn(async ({ data_source_id }: { data_source_id: string }) => ({
            id: data_source_id,
            properties: {
              "Scope Kind": { type: "select" },
              "Expires At": { type: "date" },
            },
          })),
        },
      },
    } as never)

    await debtCommand.parseAsync(["create-tasks", "--all-projects"], { from: "user" })

    const stderrText = stderrSpy.mock.calls.flat().join("")
    // Per-item failure line.
    expect(stderrText).toContain("! failed to create task for f1")
    // Summary line + non-zero exit.
    expect(stderrText).toContain("Debt create-tasks: 1 task failed to create; exit 1.")
    expect(exitTrap.exitCodes).toEqual([1])
  })

  it("create-tasks --dry-run: plan-line prefix is 'DRY-RUN CREATE' for fresh items", async () => {
    // Pins the user-facing literal so a refactor that drops the verb
    // from the dry-run prefix (back to bare `DRY-RUN`) is caught.
    // Operators rely on the prefix carrying the action so they can
    // tell create from reuse at a glance in the plan output.
    const stdoutSpy = vi.fn()
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdoutSpy(typeof chunk === "string" ? chunk : String(chunk))
      return true
    }) as never)
    vi.mocked(initServices).mockResolvedValue({
      memories: {
        queryStaleConfidence: vi.fn(async () => []),
        listForScan: vi.fn(async () => [[]]),
        list: vi.fn(async () => ({ items: [], capped: false })),
        expiringScopedStats: vi.fn(async () => ({
          expired: 0,
          expiringSoon: 0,
          narrowScopeOutOfContext: 0,
        })),
        // Preflight finds nothing → debt items go to the CREATE branch.
        search: vi.fn(async () => []),
      },
      facts: {
        queryOrphans: vi.fn(async () => [
          {
            id: "f1",
            subject: "AuthService",
            predicate: "depends_on",
            object: "SessionStore",
            projectIds: [],
            validFrom: null,
            validUntil: null,
            reviewBy: null,
            sourceMemoryId: null,
            confidence: "certain",
            confidenceScore: null,
            lastReferencedAt: null,
            createdAt: "2026-04-01T00:00:00.000Z",
            subjectEntityId: null,
            objectEntityId: null,
            scope: null,
          },
        ]),
        queryOverdue: vi.fn(async () => []),
        expiringScopedStats: vi.fn(async () => ({
          expired: 0,
          expiringSoon: 0,
          narrowScopeOutOfContext: 0,
        })),
      },
      decisions: { queryOverdue: vi.fn(async () => []) },
      tasks: {
        queryOverdue: vi.fn(async () => []),
        list: vi.fn(async () => ({ items: [], capped: false })),
        create: vi.fn(async () => undefined),
      },
      projects: { list: vi.fn(async () => []) },
      vault: {
        databases: {
          topics: { databaseId: "topics-db", dataSourceId: "topics-ds" },
          memories: { databaseId: "memories-db", dataSourceId: "memories-ds" },
          facts: { databaseId: "facts-db", dataSourceId: "facts-ds" },
        },
      },
      client: {
        dataSources: {
          query: vi.fn(async () => ({
            results: [],
            has_more: false,
            next_cursor: null,
          })),
          // Schema probe target — return properties with the #283
          // scope columns present so `safeLoadExpiringScopedStatus`
          // doesn't degrade to null on these CLI tests.
          retrieve: vi.fn(async ({ data_source_id }: { data_source_id: string }) => ({
            id: data_source_id,
            properties: {
              "Scope Kind": { type: "select" },
              "Expires At": { type: "date" },
            },
          })),
        },
      },
    } as never)

    await debtCommand.parseAsync(["create-tasks", "--all-projects", "--dry-run"], {
      from: "user",
    })

    const stdoutText = stdoutSpy.mock.calls.flat().join("")
    expect(stdoutText).toContain("DRY-RUN CREATE task:")
    expect(stdoutText).toContain("would create 1 task")
    // Sanity: under --dry-run, the action MUST NOT call tasks.create.
    const services = vi.mocked(initServices).mock.results[0]!.value
    const tasksCreate = (await services).tasks.create as ReturnType<typeof vi.fn>
    expect(tasksCreate).not.toHaveBeenCalled()
  })
})

describe("renderDebtMarkdown", () => {
  // The principal-review blocker the round-5 fix closes: a partial
  // scan that found nothing in its inspected window must NOT render
  // as "the vault is clean." Otherwise an operator looks at the
  // green output and assumes there's nothing to do, while real debt
  // sits one paginated page past `--per-category-limit`. Pin both
  // shapes here.

  function makeStats(overrides: Partial<DebtStats> = {}): DebtStats {
    return {
      staleConfidenceCandidates: 0,
      orphanFacts: 0,
      orphanFactsCapped: false,
      overdueDecisions: 0,
      overdueFacts: 0,
      overdueTasks: 0,
      staleTasks: 0,
      staleTasksScanCapped: false,
      ownerlessMemories: 0,
      ownerlessScanCapped: false,
      duplicateClusterPairs: 0,
      similarTopicGroups: 0,
      scopeAnomalies: 0,
      scopeAnomalyProbeSkipped: false,
      operationalMemoriesInspected: 0,
      operationalExpiryIssues: 0,
      summaryQualityCandidates: 0,
      logShapedSummaries: 0,
      truncated: false,
      ...overrides,
    }
  }

  function makeReport(overrides: Partial<DebtReport> = {}): DebtReport {
    return {
      project: undefined,
      scannedAt: "2026-05-12T17:50:00.000Z",
      today: "2026-05-12",
      summary: {
        total: 0,
        p1: 0,
        p2: 0,
        p3: 0,
        byCategory: {
          low_trust: 0,
          orphan_fact: 0,
          ownerless: 0,
          duplicate_cluster: 0,
          topic_sprawl: 0,
          overdue_governance: 0,
          scope_anomaly: 0,
          operational_expiry: 0,
          summary_quality: 0,
        },
      },
      items: [],
      stats: makeStats(),
      ...overrides,
    }
  }

  it("says 'vault is clean' only when no probe was capped", () => {
    const report = makeReport()
    const markdown = renderDebtMarkdown(report)
    expect(markdown).toContain("No debt detected. The vault is clean.")
  })

  it("does NOT say 'vault is clean' when ownerlessScanCapped is true on an empty report", () => {
    // The load-bearing case the round-5 review surfaced: empty
    // result + capped probe must surface the capped warning, not
    // the cheerful "vault is clean" line.
    const report = makeReport({
      stats: makeStats({ ownerlessScanCapped: true }),
    })
    const markdown = renderDebtMarkdown(report)
    expect(markdown).not.toContain("The vault is clean.")
    expect(markdown).toContain("No debt detected in the inspected window")
    expect(markdown).toContain("ownerless")
    expect(markdown).toContain("--per-category-limit")
  })

  it("surfaces a capped staleTasksScanCapped warning on an empty report", () => {
    const report = makeReport({
      stats: makeStats({ staleTasksScanCapped: true }),
    })
    const markdown = renderDebtMarkdown(report)
    expect(markdown).not.toContain("The vault is clean.")
    expect(markdown).toContain("overdue_governance (stale-task probe)")
  })

  it("surfaces a capped orphanFactsCapped warning on an empty report", () => {
    const report = makeReport({
      stats: makeStats({ orphanFactsCapped: true }),
    })
    const markdown = renderDebtMarkdown(report)
    expect(markdown).not.toContain("The vault is clean.")
    expect(markdown).toContain("orphan_fact")
  })

  it("lists every capped category in the empty-report warning", () => {
    const report = makeReport({
      stats: makeStats({
        orphanFactsCapped: true,
        staleTasksScanCapped: true,
        ownerlessScanCapped: true,
      }),
    })
    const markdown = renderDebtMarkdown(report)
    expect(markdown).toContain("orphan_fact")
    expect(markdown).toContain("overdue_governance (stale-task probe)")
    expect(markdown).toContain("ownerless")
  })

  it("does NOT say 'vault is clean' when the scope-anomaly probe is degraded on an empty report", () => {
    // Same false-clean rationale as the capped-categories branch: a
    // pre-#283 vault that has zero non-scope debt must surface the
    // migration prerequisite, not greenwash as clean.
    const report = makeReport({
      stats: makeStats({ scopeAnomalies: null }),
    })
    const markdown = renderDebtMarkdown(report)
    expect(markdown).not.toContain("The vault is clean.")
    expect(markdown).toContain("scope-anomaly probe degraded")
    expect(markdown).toContain("pre-#283 vault")
    expect(markdown).toContain("lore migrate")
  })

  it("surfaces BOTH the capped warning AND the degraded note when both fire", () => {
    const report = makeReport({
      stats: makeStats({
        ownerlessScanCapped: true,
        scopeAnomalies: null,
      }),
    })
    const markdown = renderDebtMarkdown(report)
    expect(markdown).not.toContain("The vault is clean.")
    expect(markdown).toContain("scan was capped for: ownerless")
    expect(markdown).toContain("scope-anomaly probe degraded")
  })

  it("does NOT recommend `lore migrate` when the scope-anomaly category was filtered out", () => {
    // Issue #585 round-7 review blocker: a category-filtered empty
    // scan that excluded scope_anomaly is NOT a degraded probe; the
    // renderer must not surface the `lore migrate` prompt.
    // `scopeAnomalies: null` paired with `scopeAnomalyProbeSkipped:
    // true` is the disambiguator — the renderer keys on the boolean,
    // not on `null` alone.
    const report = makeReport({
      stats: makeStats({
        scopeAnomalies: null,
        scopeAnomalyProbeSkipped: true,
      }),
    })
    const markdown = renderDebtMarkdown(report)
    expect(markdown).toContain("The vault is clean.")
    expect(markdown).not.toContain("lore migrate")
    expect(markdown).not.toContain("pre-#283 vault")
  })

  it("recommends `lore migrate` when scope-anomaly was selected AND probe degraded", () => {
    // Companion to the test above: scopeAnomalyProbeSkipped = false
    // + scopeAnomalies = null IS the load-bearing degraded-probe
    // signal. The renderer must surface it.
    const report = makeReport({
      stats: makeStats({
        scopeAnomalies: null,
        scopeAnomalyProbeSkipped: false,
      }),
    })
    const markdown = renderDebtMarkdown(report)
    expect(markdown).not.toContain("The vault is clean.")
    expect(markdown).toContain("scope-anomaly probe degraded")
    expect(markdown).toContain("lore migrate")
  })
})
