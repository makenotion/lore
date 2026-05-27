import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { EventEmitter } from "node:events"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}))

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, spawn: spawnMock }
})

import { BENCH_MODE_SENTINEL, CodexAgentAdapter } from "./task-runner.js"

let tempDirs: string[] = []
const savedEnv: Record<string, string | undefined> = {}
const envKeys = [
  "LORE_EVAL_BENCH_REAL",
  "LORE_EVAL_TASK_REAL",
  "LORE_EVAL_TASK_TIMEOUT_KILL_GRACE_MS",
  "LORE_BENCH_OPENAI_API_KEY",
  "CODEX_HOME",
  "HOME",
] as const

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  spawnMock.mockReset()
  for (const key of envKeys) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  savedEnv["LORE_EVAL_BENCH_REAL"] = undefined
  savedEnv["LORE_EVAL_TASK_REAL"] = undefined
  savedEnv["LORE_EVAL_TASK_TIMEOUT_KILL_GRACE_MS"] = undefined
  savedEnv["LORE_BENCH_OPENAI_API_KEY"] = undefined
  savedEnv["CODEX_HOME"] = undefined
  savedEnv["HOME"] = undefined
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true })
  }
  tempDirs = []
})

describe("CodexAgentAdapter bench isolation", () => {
  it("removes the isolated Codex home after a bench child closes", async () => {
    const { workspace } = await setupBenchRunEnv()
    const child = fakeChild()
    let codexHome: string | undefined
    spawnMock.mockImplementation((_cmd, _args, options) => {
      codexHome = (options as { env?: NodeJS.ProcessEnv }).env?.["CODEX_HOME"]
      setImmediate(() => child.emit("close", 0))
      return child
    })

    const result = await new CodexAgentAdapter().run({
      workspace,
      prompt: "Answer from Lore.",
      timeoutMs: 1_000,
    })

    expect(result.exitCode).toBe(0)
    expect(codexHome).toBeDefined()
    expect(existsSync(codexHome!)).toBe(false)
  })

  it("removes the isolated Codex home after a bench child spawn error", async () => {
    const { workspace } = await setupBenchRunEnv()
    const child = fakeChild()
    let codexHome: string | undefined
    spawnMock.mockImplementation((_cmd, _args, options) => {
      codexHome = (options as { env?: NodeJS.ProcessEnv }).env?.["CODEX_HOME"]
      setImmediate(() => child.emit("error", new Error("spawn failed")))
      return child
    })

    const result = await new CodexAgentAdapter().run({
      workspace,
      prompt: "Answer from Lore.",
      timeoutMs: 1_000,
    })

    expect(result.exitCode).toBe(-1)
    expect(result.stderr).toContain("spawn failed")
    expect(codexHome).toBeDefined()
    expect(existsSync(codexHome!)).toBe(false)
  })

  it("removes the isolated Codex home after a timed-out bench child closes", async () => {
    const { workspace } = await setupBenchRunEnv()
    const child = fakeChild()
    let codexHome: string | undefined
    spawnMock.mockImplementation((_cmd, _args, options) => {
      codexHome = (options as { env?: NodeJS.ProcessEnv }).env?.["CODEX_HOME"]
      setTimeout(() => child.emit("close", null), 10)
      return child
    })

    const result = await new CodexAgentAdapter().run({
      workspace,
      prompt: "Answer from Lore.",
      timeoutMs: 1,
    })

    expect(result.timedOut).toBe(true)
    expect(codexHome).toBeDefined()
    expect(existsSync(codexHome!)).toBe(false)
  })
})

describe("CodexAgentAdapter task isolation", () => {
  it("resolves task timeouts after a grace period even when the child never closes", async () => {
    const { workspace } = await setupTaskRunEnv()
    const child = fakeChild()
    let codexHome: string | undefined
    spawnMock.mockImplementation((_cmd, _args, options) => {
      codexHome = (options as { env?: NodeJS.ProcessEnv }).env?.["CODEX_HOME"]
      return child
    })

    const resultPromise = new CodexAgentAdapter().run({
      workspace,
      prompt: "Edit the repo.",
      timeoutMs: 1,
    })
    const result = await resultPromise

    expect(result.timedOut).toBe(true)
    expect(result.stderr).toContain("Codex task invocation exceeded its timeout")
    expect(codexHome).toBeDefined()
    expect(existsSync(codexHome!)).toBe(false)
  })
})

async function setupBenchRunEnv(): Promise<{ workspace: string }> {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key]
  }
  const sourceCodexHome = await mkdtemp(join(tmpdir(), "lore-codex-source-home-"))
  const workspace = await mkdtemp(join(tmpdir(), "lore-bench-adapter-test-"))
  tempDirs.push(sourceCodexHome, workspace)
  await writeFile(join(workspace, BENCH_MODE_SENTINEL), "")
  process.env["LORE_EVAL_BENCH_REAL"] = "1"
  process.env["LORE_BENCH_OPENAI_API_KEY"] = "sk-bench-only"
  process.env["CODEX_HOME"] = sourceCodexHome
  process.env["HOME"] = sourceCodexHome
  return { workspace }
}

async function setupTaskRunEnv(): Promise<{ workspace: string }> {
  for (const key of envKeys) {
    savedEnv[key] = process.env[key]
  }
  const sourceCodexHome = await mkdtemp(join(tmpdir(), "lore-codex-source-home-"))
  const workspace = await mkdtemp(join(tmpdir(), "lore-task-adapter-test-"))
  tempDirs.push(sourceCodexHome, workspace)
  process.env["LORE_EVAL_TASK_REAL"] = "1"
  process.env["LORE_EVAL_TASK_TIMEOUT_KILL_GRACE_MS"] = "1"
  process.env["CODEX_HOME"] = sourceCodexHome
  process.env["HOME"] = sourceCodexHome
  return { workspace }
}

function fakeChild(): EventEmitter & {
  stdout: EventEmitter
  stderr: EventEmitter
  pid: number
  kill: ReturnType<typeof vi.fn>
} {
  return Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    pid: 123_456,
    kill: vi.fn(),
  })
}
