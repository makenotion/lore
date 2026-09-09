import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { rawObservationPath } from "../../hooks/raw-observation-store.js"
import { trapProcessExit } from "../test-helpers.js"
import { observationsCommand } from "./observations.js"

describe("lore observations tail", () => {
  let dir: string
  let obsDir: string
  let logSpy: ReturnType<typeof vi.fn>
  let errorSpy: ReturnType<typeof vi.fn>
  let warnSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lore-obs-cmd-"))
    obsDir = join(dir, "obs-store")
    logSpy = vi.fn()
    errorSpy = vi.fn()
    warnSpy = vi.fn()
    vi.spyOn(console, "log").mockImplementation(logSpy)
    vi.spyOn(console, "error").mockImplementation(errorSpy)
    vi.spyOn(console, "warn").mockImplementation(warnSpy)
    vi.spyOn(process, "cwd").mockReturnValue(dir)
    exitTrap = trapProcessExit()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  function writeLoreConfig(extra = ""): void {
    writeFileSync(join(dir, ".lore.yaml"), `vault:\n  pageId: test-vault\n${extra}`)
  }

  function storePath(): string {
    return rawObservationPath(dir, { LORE_RAW_OBSERVATION_DIR: obsDir })
  }

  function writeRecord(record: object): void {
    const p = storePath()
    mkdirSync(join(p, ".."), { recursive: true })
    writeFileSync(p, JSON.stringify(record) + "\n", { flag: "a" })
  }

  function makeRecord(overrides: Partial<Record<string, unknown>> = {}): object {
    return {
      v: 1,
      observedAt: "2026-01-01T12:00:00.000Z",
      sessionId: "sess-abc",
      cwd: "/repo",
      toolName: "Bash",
      contentHash: "deadbeef".padEnd(64, "0"),
      input: { cmd: "ls" },
      output: "file.txt",
      event: {},
      ...overrides,
    }
  }

  it("exits 1 and errors when no .lore.yaml is found", async () => {
    await observationsCommand.parseAsync(["tail"], { from: "user" })
    expect(exitTrap.exitCodes).toContain(1)
    expect(errorSpy).toHaveBeenCalled()
  })

  it("warns when rawObservationCapture is disabled and no observations exist", async () => {
    writeLoreConfig()
    vi.stubEnv("LORE_RAW_OBSERVATION_DIR", obsDir)
    await observationsCommand.parseAsync(["tail"], { from: "user" })
    vi.unstubAllEnvs()
    const warnMessages = warnSpy.mock.calls.flat().join("\n")
    expect(warnMessages).toContain("disabled")
  })

  it("prints 'No observations found' when store is empty", async () => {
    writeLoreConfig("hooks:\n  rawObservationCapture: true\n")
    vi.stubEnv("LORE_RAW_OBSERVATION_DIR", obsDir)
    await observationsCommand.parseAsync(["tail"], { from: "user" })
    vi.unstubAllEnvs()
    const output = logSpy.mock.calls.flat().join("\n")
    expect(output).toContain("No observations found")
  })

  it("prints records in human-readable format when observations exist", async () => {
    writeLoreConfig("hooks:\n  rawObservationCapture: true\n")
    writeRecord(makeRecord({ toolName: "Bash", observedAt: "2026-01-01T12:00:00.000Z" }))

    vi.stubEnv("LORE_RAW_OBSERVATION_DIR", obsDir)
    await observationsCommand.parseAsync(["tail"], { from: "user" })
    vi.unstubAllEnvs()

    const output = logSpy.mock.calls.flat().join("\n")
    expect(output).toContain("Bash")
    expect(output).toContain("2026-01-01T12:00:00.000Z")
  })

  it("emits NDJSON when --json flag is set", async () => {
    writeLoreConfig("hooks:\n  rawObservationCapture: true\n")
    writeRecord(makeRecord({ toolName: "Read" }))

    vi.stubEnv("LORE_RAW_OBSERVATION_DIR", obsDir)
    await observationsCommand.parseAsync(["tail", "--json"], { from: "user" })
    vi.unstubAllEnvs()

    const lines = logSpy.mock.calls.flat()
    expect(lines.length).toBeGreaterThan(0)
    const parsed = JSON.parse(lines[0])
    expect(parsed.toolName).toBe("Read")
    expect(parsed.v).toBe(1)
  })

  it("filters by --session when provided", async () => {
    writeLoreConfig("hooks:\n  rawObservationCapture: true\n")
    writeRecord(makeRecord({ sessionId: "sess-A", toolName: "Bash" }))
    writeRecord(makeRecord({ sessionId: "sess-B", toolName: "Read" }))

    vi.stubEnv("LORE_RAW_OBSERVATION_DIR", obsDir)
    await observationsCommand.parseAsync(["tail", "--json", "--session", "sess-A"], {
      from: "user",
    })
    vi.unstubAllEnvs()

    const lines = logSpy.mock.calls.flat()
    expect(lines).toHaveLength(1)
    const parsed = JSON.parse(lines[0])
    expect(parsed.toolName).toBe("Bash")
  })

  it("respects --limit to cap the number of returned records", async () => {
    writeLoreConfig("hooks:\n  rawObservationCapture: true\n")
    for (let i = 0; i < 5; i++) {
      writeRecord(
        makeRecord({ toolName: `Tool${i}`, contentHash: `hash${i}`.padEnd(64, "0") })
      )
    }

    vi.stubEnv("LORE_RAW_OBSERVATION_DIR", obsDir)
    await observationsCommand.parseAsync(["tail", "--json", "--limit", "2"], {
      from: "user",
    })
    vi.unstubAllEnvs()

    const lines = logSpy.mock.calls.flat()
    expect(lines).toHaveLength(2)
  })
})
