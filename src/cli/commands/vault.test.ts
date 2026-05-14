import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ensureConfiguredEntitiesDatabase } from "../vault-repair.js"
import { trapProcessExit } from "../test-helpers.js"
import { ensureEntitiesCommand, formatEnsureEntitiesResult } from "./vault.js"

vi.mock("../vault-repair.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../vault-repair.js")>()
  return {
    ...actual,
    ensureConfiguredEntitiesDatabase: vi.fn(),
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
