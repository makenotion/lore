import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { mkdtemp, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, normalize } from "node:path"
import {
  appendObservation,
  rawObservationDir,
  rawObservationPath,
  readRecentObservations,
  type RawObservationRecord,
} from "./raw-observation-store.js"

function makeRecord(overrides: Partial<RawObservationRecord> = {}): RawObservationRecord {
  return {
    v: 1,
    observedAt: new Date().toISOString(),
    sessionId: "test-session",
    cwd: "/tmp",
    toolName: "Bash",
    contentHash: "abc123",
    input: { cmd: "ls" },
    output: "file.txt",
    event: {},
    ...overrides,
  }
}

describe("rawObservationDir", () => {
  it("uses LORE_RAW_OBSERVATION_DIR when set", () => {
    const env = { LORE_RAW_OBSERVATION_DIR: "/custom/path" }
    expect(rawObservationDir(env)).toBe("/custom/path")
  })

  it("uses XDG_STATE_HOME when set", () => {
    const env = { XDG_STATE_HOME: "/xdg/state" }
    expect(normalize(rawObservationDir(env))).toBe(
      normalize("/xdg/state/lore/raw-observations")
    )
  })

  it("falls back to ~/.local/state when neither env is set", () => {
    const dir = rawObservationDir({})
    expect(dir).toMatch(/raw-observations$/)
    expect(dir).toContain("lore")
  })
})

describe("rawObservationPath", () => {
  it("returns a .jsonl file path under the raw-observation dir", () => {
    // Use tmpdir() so the base path is valid on the current platform.
    const obsBase = join(tmpdir(), "lore-obs-path-test")
    const env = { LORE_RAW_OBSERVATION_DIR: obsBase }
    const p = rawObservationPath("/my/config/root", env)
    expect(p).toMatch(/\.jsonl$/)
    expect(p.startsWith(obsBase)).toBe(true)
  })

  it("produces distinct paths for distinct config roots", () => {
    const obsBase = join(tmpdir(), "lore-obs-distinct-test")
    const env = { LORE_RAW_OBSERVATION_DIR: obsBase }
    const a = rawObservationPath("/root/a", env)
    const b = rawObservationPath("/root/b", env)
    expect(a).not.toBe(b)
  })
})

describe("appendObservation + readRecentObservations", () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lore-obs-test-"))
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("creates the file and appends a readable JSONL record", async () => {
    const filePath = join(tmpDir, "test.jsonl")
    const record = makeRecord()
    await appendObservation(filePath, record)

    const records = await readRecentObservations(filePath)
    expect(records).toHaveLength(1)
    expect(records[0].toolName).toBe("Bash")
    expect(records[0].v).toBe(1)
  })

  it("creates the file with owner-only permissions (0o600)", async () => {
    const filePath = join(tmpDir, "perms.jsonl")
    await appendObservation(filePath, makeRecord())
    const s = await stat(filePath)
    // On Windows stat mode may differ; skip permission check there
    if (process.platform !== "win32") {
      expect(s.mode & 0o777).toBe(0o600)
    }
  })

  it("appends multiple records and reads all of them", async () => {
    const filePath = join(tmpDir, "multi.jsonl")
    await appendObservation(filePath, makeRecord({ toolName: "Read" }))
    await appendObservation(filePath, makeRecord({ toolName: "Write" }))
    await appendObservation(filePath, makeRecord({ toolName: "Bash" }))

    const records = await readRecentObservations(filePath)
    expect(records).toHaveLength(3)
    expect(records.map((r) => r.toolName)).toEqual(["Read", "Write", "Bash"])
  })

  it("returns [] for a non-existent file", async () => {
    const records = await readRecentObservations(join(tmpDir, "missing.jsonl"))
    expect(records).toEqual([])
  })

  it("filters by sessionId when provided", async () => {
    const filePath = join(tmpDir, "session.jsonl")
    await appendObservation(filePath, makeRecord({ sessionId: "sess-A" }))
    await appendObservation(filePath, makeRecord({ sessionId: "sess-B" }))

    const records = await readRecentObservations(filePath, { sessionId: "sess-A" })
    expect(records).toHaveLength(1)
    expect(records[0].sessionId).toBe("sess-A")
  })

  it("filters by windowMs and excludes old records", async () => {
    const filePath = join(tmpDir, "window.jsonl")
    const old = makeRecord({
      observedAt: new Date(Date.now() - 10 * 60 * 1_000).toISOString(),
    })
    const recent = makeRecord({ observedAt: new Date().toISOString() })
    await appendObservation(filePath, old)
    await appendObservation(filePath, recent)

    const records = await readRecentObservations(filePath, { windowMs: 5 * 60 * 1_000 })
    expect(records).toHaveLength(1)
    expect(records[0].observedAt).toBe(recent.observedAt)
  })

  it("skips malformed JSON lines", async () => {
    const filePath = join(tmpDir, "bad.jsonl")
    await appendObservation(filePath, makeRecord())
    // Append a raw malformed line
    const { writeFile } = await import("node:fs/promises")
    await writeFile(filePath, "not-json\n", { flag: "a" })
    await appendObservation(filePath, makeRecord({ toolName: "Write" }))

    const records = await readRecentObservations(filePath)
    expect(records).toHaveLength(2)
  })
})
