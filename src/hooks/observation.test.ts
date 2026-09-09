import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { handleObservation } from "./observation.js"

// Stub config loading so tests don't need a real .lore.yaml
vi.mock("../config.js", () => ({
  findConfigFile: vi.fn(),
  loadConfigAllowingInvalidHooks: vi.fn(),
}))

import { findConfigFile, loadConfigAllowingInvalidHooks } from "../config.js"

const mockFindConfigFile = vi.mocked(findConfigFile)
const mockLoadConfig = vi.mocked(loadConfigAllowingInvalidHooks)

function makeConfigFound(root: string) {
  return { path: join(root, ".lore.yaml"), root }
}

function makeConfig(rawObservationCapture: boolean) {
  return {
    config: {
      hooks: { rawObservationCapture },
    },
    warnings: [],
  }
}

describe("handleObservation", () => {
  let tmpDir: string
  let storeDir: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "lore-obs-handler-test-"))
    storeDir = join(tmpDir, "store")
    vi.clearAllMocks()
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  const envSource = () => ({ LORE_RAW_OBSERVATION_DIR: storeDir })

  it("exits silently when stdin is empty", async () => {
    await expect(
      handleObservation({ event: "", envSource: envSource() })
    ).resolves.not.toThrow()
    mockFindConfigFile.mockResolvedValue(null)
  })

  it("fails open on malformed JSON (no throw)", async () => {
    mockFindConfigFile.mockResolvedValue(makeConfigFound(tmpDir))
    mockLoadConfig.mockResolvedValue(makeConfig(true) as never)

    await expect(
      handleObservation({ event: "not valid json", envSource: envSource() })
    ).resolves.not.toThrow()
  })

  it("no-ops when rawObservationCapture is false", async () => {
    mockFindConfigFile.mockResolvedValue(makeConfigFound(tmpDir))
    mockLoadConfig.mockResolvedValue(makeConfig(false) as never)

    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { cmd: "ls" },
      tool_response: "file.txt",
      session_id: "sess-1",
      cwd: "/tmp",
    })

    await handleObservation({ event: payload, envSource: envSource() })

    // Store dir should not have been created
    const { existsSync } = await import("node:fs")
    expect(existsSync(storeDir)).toBe(false)
  })

  it("no-ops when no config file is found", async () => {
    mockFindConfigFile.mockResolvedValue(null)

    const payload = JSON.stringify({ tool_name: "Bash" })
    await expect(
      handleObservation({ event: payload, envSource: envSource() })
    ).resolves.not.toThrow()
  })

  it("appends a JSONL record when enabled", async () => {
    mockFindConfigFile.mockResolvedValue(makeConfigFound(tmpDir))
    mockLoadConfig.mockResolvedValue(makeConfig(true) as never)

    const payload = JSON.stringify({
      tool_name: "Read",
      tool_input: { path: "/file.ts" },
      tool_response: "content",
      session_id: "sess-abc",
      cwd: "/repo",
    })

    await handleObservation({ event: payload, envSource: envSource() })

    // Find the JSONL file in the store directory
    const { readdirSync } = await import("node:fs")
    const files = readdirSync(storeDir)
    expect(files.length).toBeGreaterThan(0)

    const content = await readFile(join(storeDir, files[0]), "utf-8")
    const record = JSON.parse(content.trim())
    expect(record.v).toBe(1)
    expect(record.toolName).toBe("Read")
    expect(record.sessionId).toBe("sess-abc")
    expect(record.cwd).toBe("/repo")
    expect(typeof record.contentHash).toBe("string")
  })

  it("deduplicates identical payloads within the window", async () => {
    mockFindConfigFile.mockResolvedValue(makeConfigFound(tmpDir))
    mockLoadConfig.mockResolvedValue(makeConfig(true) as never)

    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: { cmd: "echo hello" },
      tool_response: "hello",
      session_id: "sess-dup",
    })

    await handleObservation({ event: payload, envSource: envSource() })
    await handleObservation({ event: payload, envSource: envSource() })

    const { readdirSync } = await import("node:fs")
    const files = readdirSync(storeDir)
    expect(files.length).toBe(1)

    const content = await readFile(join(storeDir, files[0]), "utf-8")
    const lines = content.trim().split("\n").filter(Boolean)
    expect(lines).toHaveLength(1)
  })

  it("redacts bearer tokens in payloads", async () => {
    mockFindConfigFile.mockResolvedValue(makeConfigFound(tmpDir))
    mockLoadConfig.mockResolvedValue(makeConfig(true) as never)

    const payload = JSON.stringify({
      tool_name: "WebFetch",
      tool_input: { headers: { Authorization: "Bearer ntn_abc123secret" } },
      tool_response: "ok",
    })

    await handleObservation({ event: payload, envSource: envSource() })

    const { readdirSync } = await import("node:fs")
    const files = readdirSync(storeDir)
    const content = await readFile(join(storeDir, files[0]), "utf-8")
    expect(content).not.toContain("ntn_abc123secret")
    expect(content).toContain("<redacted-token>")
  })

  it("respects LORE_RAW_OBSERVATIONS=1 env override", async () => {
    mockFindConfigFile.mockResolvedValue(makeConfigFound(tmpDir))
    // Config says false, but env override forces on
    mockLoadConfig.mockResolvedValue(makeConfig(false) as never)

    const envWithOverride = { ...envSource(), LORE_RAW_OBSERVATIONS: "1" }
    const payload = JSON.stringify({
      tool_name: "Bash",
      tool_input: {},
      tool_response: "x",
    })

    await handleObservation({ event: payload, envSource: envWithOverride })

    const { existsSync, readdirSync } = await import("node:fs")
    expect(existsSync(storeDir)).toBe(true)
    expect(readdirSync(storeDir).length).toBeGreaterThan(0)
  })
})
