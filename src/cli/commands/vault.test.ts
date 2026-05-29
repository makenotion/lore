import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { migrateAgentDiaryMemories } from "../../core/agent-diary-migration.js"
import { initServices } from "../../services.js"
import { ensureConfiguredEntitiesDatabase } from "../vault-repair.js"
import { trapProcessExit } from "../test-helpers.js"
import {
  ensureEntitiesCommand,
  formatAgentDiaryMigrationResult,
  formatEnsureEntitiesResult,
  migrateAgentDiaryCommand,
} from "./vault.js"

vi.mock("../vault-repair.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vault-repair.js")>()
  return {
    ...actual,
    ensureConfiguredEntitiesDatabase: vi.fn(),
  }
})

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

vi.mock("../../core/agent-diary-migration.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../core/agent-diary-migration.js")>()
  return {
    ...actual,
    migrateAgentDiaryMemories: vi.fn(),
  }
})

describe("formatEnsureEntitiesResult", () => {
  it("reports a dry-run creation plan without pretending schema drift was computed", () => {
    expect(
      formatEnsureEntitiesResult({
        pageId: "page-1",
        ensure: { status: "would-create" },
        diffs: [],
      })
    ).toEqual([
      "Would create the Entities database on the configured vault page.",
      "Would run schema migration after creation so Facts gains SubjectEntity/ObjectEntity relation columns.",
    ])
  })

  it("reports created Entities and the follow-up Facts relation columns", () => {
    const output = formatEnsureEntitiesResult({
      pageId: "page-1",
      ensure: {
        status: "created",
        ref: { databaseId: "entities-db", dataSourceId: "entities-ds" },
      },
      diffs: [
        {
          database: "facts",
          missing: ["SubjectEntity", "ObjectEntity"],
          addedOptions: [],
          blockedOptions: [],
          addedRelationConfig: [],
        },
      ],
    }).join("\n")

    expect(output).toContain("Created Entities database: entities-db")
    expect(output).toContain("Added 2 missing properties")
    expect(output).toContain("facts: SubjectEntity, ObjectEntity")
  })

  it("reports an already-up-to-date vault", () => {
    expect(
      formatEnsureEntitiesResult({
        pageId: "page-1",
        ensure: {
          status: "present",
          ref: { databaseId: "entities-db", dataSourceId: "entities-ds" },
        },
        diffs: [
          {
            database: "projects",
            missing: [],
            addedOptions: [],
            blockedOptions: [],
            addedRelationConfig: [],
          },
        ],
      })
    ).toEqual([
      "Entities database already exists: entities-db",
      "Vault schema is up to date.",
    ])
  })
})

describe("formatAgentDiaryMigrationResult", () => {
  it("renders dry-run counts and samples", () => {
    const output = formatAgentDiaryMigrationResult({
      mode: "dry-run",
      total: 3,
      rejectNullKind: [
        { id: "null-kind", title: "Null kind", kind: null, status: "informational" },
      ],
      alreadyRejectedNullKind: [],
      resourceNotes: [
        { id: "note", title: "Genuine note", kind: "note", status: "accepted" },
      ],
      manualReview: [
        { id: "runbook", title: "Runbook", kind: "runbook", status: "accepted" },
      ],
      samples: {
        rejectNullKind: [
          {
            id: "null-kind",
            title: "Null kind",
            kind: null,
            status: "informational",
          },
        ],
        alreadyRejectedNullKind: [],
        resourceNotes: [
          { id: "note", title: "Genuine note", kind: "note", status: "accepted" },
        ],
        manualReview: [
          { id: "runbook", title: "Runbook", kind: "runbook", status: "accepted" },
        ],
      },
      applied: { rejected: 0, resourced: 0, failures: [] },
    }).join("\n")

    expect(output).toContain("Agent diary migration dry run.")
    expect(output).toContain("Would reject 1 null-kind narration row")
    expect(output).toContain("Would re-source 1 note row")
    expect(output).toContain("1 source=agent_diary row needs manual review")
    expect(output).toContain("Null kind (null-kind, kind=null, status=informational)")
    expect(output).toContain("No changes written")
  })
})

describe("ensureEntitiesCommand", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>
  let logSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.mocked(ensureConfiguredEntitiesDatabase).mockReset()
    exitTrap = trapProcessExit()
    errorSpy = vi.fn()
    logSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "log").mockImplementation(logSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("exits 1 once after reporting non-dry-run blocked option updates", async () => {
    vi.mocked(ensureConfiguredEntitiesDatabase).mockResolvedValue({
      pageId: "page-1",
      ensure: {
        status: "present",
        ref: { databaseId: "entities-db", dataSourceId: "entities-ds" },
      },
      diffs: [
        {
          database: "memories",
          missing: ["Pinned"],
          addedOptions: [],
          blockedOptions: [
            {
              property: "Tags",
              type: "multi_select",
              options: ["android"],
              liveCount: 100,
              attemptedCount: 101,
              limit: 100,
            },
          ],
          addedRelationConfig: [],
        },
      ],
    })

    await ensureEntitiesCommand.parseAsync([], { from: "user" })

    const output = logSpy.mock.calls.flat().join("\n")
    expect(output).toContain("Entities database already exists: entities-db")
    expect(output).toContain("Added 1 missing property")
    expect(output).toContain("Cannot add 1 select option")
    expect(output).toContain("memories.Tags: live=100, attempted=101, limit=100; android")
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "Vault ensure-entities failed: schema migration is incomplete"
    )
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})

describe("migrateAgentDiaryCommand", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>
  let logSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    vi.mocked(migrateAgentDiaryMemories).mockReset()
    exitTrap = trapProcessExit()
    errorSpy = vi.fn()
    logSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "log").mockImplementation(logSpy)
    vi.mocked(initServices).mockResolvedValue({
      client: { marker: "client" },
      context: {
        vault: {
          databases: {
            memories: { databaseId: "mem-db", dataSourceId: "mem-ds" },
          },
        },
      },
    } as never)
    vi.mocked(migrateAgentDiaryMemories).mockResolvedValue({
      mode: "dry-run",
      total: 0,
      rejectNullKind: [],
      alreadyRejectedNullKind: [],
      resourceNotes: [],
      manualReview: [],
      samples: {
        rejectNullKind: [],
        alreadyRejectedNullKind: [],
        resourceNotes: [],
        manualReview: [],
      },
      applied: { rejected: 0, resourced: 0, failures: [] },
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("runs the migration in dry-run mode by default", async () => {
    await migrateAgentDiaryCommand.parseAsync([], { from: "user" })

    expect(migrateAgentDiaryMemories).toHaveBeenCalledWith({
      client: { marker: "client" },
      memories: { databaseId: "mem-db", dataSourceId: "mem-ds" },
      apply: false,
      sampleLimit: 5,
    })
    expect(logSpy.mock.calls.flat().join("\n")).toContain(
      "Agent diary migration dry run."
    )
    expect(exitTrap.exitCodes).toEqual([])
  })

  it("passes apply and sample flags", async () => {
    await migrateAgentDiaryCommand.parseAsync(["--apply", "--sample", "2"], {
      from: "user",
    })

    expect(migrateAgentDiaryMemories).toHaveBeenCalledWith(
      expect.objectContaining({
        apply: true,
        sampleLimit: 2,
      })
    )
  })

  it("exits 1 on parse failure before service initialization", async () => {
    await migrateAgentDiaryCommand.parseAsync(["--sample", "nope"], { from: "user" })

    expect(initServices).not.toHaveBeenCalled()
    expect(migrateAgentDiaryMemories).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "Vault migrate-agent-diary failed:"
    )
    expect(exitTrap.exitCodes).toEqual([1])
  })

  it("emits JSON without human lines", async () => {
    await migrateAgentDiaryCommand.parseAsync(["--json"], { from: "user" })

    const output = logSpy.mock.calls.flat().join("\n")
    expect(JSON.parse(output)).toMatchObject({ mode: "dry-run", total: 0 })
  })

  it("exits 1 and renders failures when apply writes fail", async () => {
    vi.mocked(migrateAgentDiaryMemories).mockResolvedValue({
      mode: "apply",
      total: 1,
      rejectNullKind: [
        { id: "bad-row", title: "Bad row", kind: null, status: "informational" },
      ],
      alreadyRejectedNullKind: [],
      resourceNotes: [],
      manualReview: [],
      samples: {
        rejectNullKind: [
          { id: "bad-row", title: "Bad row", kind: null, status: "informational" },
        ],
        alreadyRejectedNullKind: [],
        resourceNotes: [],
        manualReview: [],
      },
      applied: {
        rejected: 0,
        resourced: 0,
        failures: [
          {
            id: "bad-row",
            title: "Bad row",
            kind: null,
            status: "informational",
            action: "reject-null-kind",
            message: "notion 503",
          },
        ],
      },
    })

    await migrateAgentDiaryCommand.parseAsync(["--apply"], { from: "user" })

    expect(logSpy.mock.calls.flat().join("\n")).toContain("Failed updates:")
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "Vault migrate-agent-diary failed: 1 update failed."
    )
    expect(exitTrap.exitCodes).toEqual([1])
  })
})
