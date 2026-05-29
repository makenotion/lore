import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initServices } from "../../services.js"
import { migrationLockPath } from "../migration-lock.js"
import { migrateCommand } from "./migrate.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

const configRoot = "/tmp/lore-migrate-command-test"
const vaultPageId = "vault-page-command-test"
const lockStateDir = join(
  tmpdir(),
  `lore-migrate-command-action-lock-test-${process.pid}`
)

function entityLockPath(): string {
  return migrationLockPath({
    name: "build-entities",
    configRoot,
    vaultPageId,
  })
}

function seedEntityLock(pid: number): string {
  const path = entityLockPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, pid.toString())
  return path
}

function makeServices() {
  return {
    configRoot,
    config: { vault: { pageId: vaultPageId } },
    vault: {
      migrate: vi.fn().mockResolvedValue({
        diffs: [],
        duplicateTopics: [],
        mergeResults: [],
        encodedTopics: [],
        encodingFixResults: [],
      }),
      getClient: vi.fn(),
    },
    facts: {
      queryBySubject: vi.fn().mockResolvedValue([]),
      listAllForBackfill: vi.fn(async function* () {}),
      applyBackfillScore: vi.fn(),
      setSource: vi.fn(),
    },
    entities: {
      listAll: vi.fn().mockResolvedValue([]),
    },
  }
}

describe("migrateCommand build-entities locking", () => {
  let originalStateDir: string | undefined
  let errorSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    originalStateDir = process.env["LORE_HOOK_STATE_DIR"]
    process.env["LORE_HOOK_STATE_DIR"] = lockStateDir
    rmSync(lockStateDir, { recursive: true, force: true })
    vi.mocked(initServices).mockReset()
    vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit-called")
    }) as never)
    errorSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(lockStateDir, { recursive: true, force: true })
    if (originalStateDir === undefined) {
      delete process.env["LORE_HOOK_STATE_DIR"]
    } else {
      process.env["LORE_HOOK_STATE_DIR"] = originalStateDir
    }
  })

  it("fails before schema migration when the build-entities apply lock is held", async () => {
    const services = makeServices()
    vi.mocked(initServices).mockResolvedValue(services as never)
    const lockPath = seedEntityLock(process.pid)

    await expect(
      migrateCommand.parseAsync(["--build-entities", "--yes", "--allow-unscoped"], {
        from: "user",
      })
    ).rejects.toThrow("exit-called")

    expect(existsSync(lockPath)).toBe(true)
    expect(services.vault.migrate).not.toHaveBeenCalled()
    expect(services.facts.queryBySubject).not.toHaveBeenCalled()
    expect(errorSpy.mock.calls.join("\n")).toContain(
      "Another build-entities migration is already active"
    )
    expect(errorSpy.mock.calls.join("\n")).toContain(`rm ${lockPath}`)
  })

  it("exits non-zero after reporting skipped over-limit option updates", async () => {
    const services = makeServices()
    services.vault.migrate.mockResolvedValue({
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
      duplicateTopics: [],
      mergeResults: [],
      encodedTopics: [],
      encodingFixResults: [],
    })
    const logSpy = vi.fn()
    vi.spyOn(console, "log").mockImplementation(logSpy)
    vi.mocked(initServices).mockResolvedValue(services as never)

    await expect(
      migrateCommand.parseAsync([], {
        from: "user",
      })
    ).rejects.toThrow("exit-called")

    const output = logSpy.mock.calls.flat().join("\n")
    expect(output).toContain("Added 1 missing property")
    expect(output).toContain("Skipped 1 select option")
    expect(output).toContain(
      "memories.Tags (multi_select): live=100, attempted=101, limit=100; android"
    )
    expect(errorSpy.mock.calls.join("\n")).toContain(
      "Migrate failed: one or more select option updates exceed Notion's option limit."
    )
  })

  it("runs audit-only fact confidence checks with schema writes disabled", async () => {
    const services = makeServices()
    const logSpy = vi.fn()
    vi.spyOn(console, "log").mockImplementation(logSpy)
    vi.mocked(initServices).mockResolvedValue(services as never)

    await migrateCommand.parseAsync(["--audit-fact-confidence", "--allow-unscoped"], {
      from: "user",
    })

    expect(services.vault.migrate).toHaveBeenCalledWith({
      dryRun: true,
      mergeDuplicateTopics: undefined,
      fixTopicEncoding: undefined,
    })
    expect(services.facts.listAllForBackfill).toHaveBeenCalledWith({
      projectId: undefined,
    })
    expect(services.facts.applyBackfillScore).not.toHaveBeenCalled()
    expect(services.facts.setSource).not.toHaveBeenCalled()
    const output = logSpy.mock.calls.flat().join("\n")
    expect(output).toContain("Vault schema is up to date. Nothing to migrate.")
    expect(output).toContain("[lore] audit-fact-confidence: scanned 0 live facts")
  })
})
