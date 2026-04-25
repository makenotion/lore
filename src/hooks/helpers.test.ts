/**
 * Tests for the Stop hook's non-blocking save path.
 *
 * The Stop hook used to emit `{"decision": "block"}` and force an extra
 * agent turn; P2-05 replaced that with a detached background spawn that
 * never blocks the main agent. These tests pin that contract:
 *   - Stop stdout never contains `"decision": "block"`
 *   - A spawn fires at the interval
 *   - The per-session lock prevents an overlapping second spawn
 *
 * `helpers.ts` is now import-safe: its entry-point guard skips `main()`
 * when invoked from a test runner, so we can exercise `handleStop` directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Isolate from sibling test files that also touch the lock dir. Each test
// file gets its own subtree under $TMPDIR via `LORE_HOOK_STATE_DIR`. The
// assignment is in `vi.hoisted` because ES modules evaluate imports before
// top-level statements; without hoisting, `./lock.js` would pin `STATE_DIR`
// to the default before this override ran. `getStateDir()` re-reads
// the env var on every call so function-side usage picks up the override.
vi.hoisted(() => {
  process.env["LORE_HOOK_STATE_DIR"] =
    `${process.env["TMPDIR"] ?? "/tmp"}/lore-helpers-state-${process.pid}-${Date.now()}`
})

// Hoisted mocks — `vi.spyOn` can't redefine native ESM exports, so the
// mocks must be set up via `vi.mock` + `vi.hoisted`.
//
// `execFileSyncMock` stands in for the `which claude` probe inside
// `findClaudeBinary`: on CI runners `claude` isn't on PATH and the real probe
// would return null, short-circuiting `spawnBackgroundSave` before the
// spawn-path assertions fire. The mock always resolves to a fake path so
// the rest of the hook runs as if `claude` were installed.
const { spawnMock, execFileSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(() => "/mock/bin/claude\n"),
}))

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, spawn: spawnMock, execFileSync: execFileSyncMock }
})

import type { HookConfig } from "./config.js"
import {
  getStateDir,
  lockPath,
  releaseSessionLock,
  tryAcquireSessionLock,
} from "./lock.js"
import { handleStop, handleSessionEnd } from "./helpers.js"

// Stand-in for a spawned `claude -p` process. Returning a live PID (this
// process) means subsequent lock-aliveness checks see it as "still running",
// which is exactly the condition we want when asserting overlap rejection.
// `kill` is stubbed because the race-loss code path SIGTERMs the child when
// a concurrent hook wins the lock.
function fakeLiveChild(): {
  pid: number
  unref: () => void
  kill: (signal?: string) => boolean
} {
  return {
    pid: process.pid,
    unref: () => {},
    kill: () => true,
  }
}

function defaultConfig(overrides: Partial<HookConfig> = {}): HookConfig {
  return {
    saveInterval: 2,
    autoSave: true,
    wakeUp: true,
    autoDigest: true,
    catchAllName: null,
    subProjects: [],
    ...overrides,
  }
}

/** Write a minimal Claude Code transcript with N user messages. */
function writeTranscript(path: string, userMessages: number): void {
  const lines: string[] = []
  for (let i = 0; i < userMessages; i++) {
    lines.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: `user ${i}` }] },
      })
    )
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `assistant ${i}` }],
        },
      })
    )
  }
  writeFileSync(path, lines.join("\n"))
}

describe("handleStop", () => {
  let tmpDir: string
  let transcriptPath: string
  let stdoutWrites: string[]
  let stderrWrites: string[]
  // Loose type because `vi.spyOn` on stream.write has an overloaded signature
  // that doesn't match MockInstance's default constraint cleanly.
  let stdoutSpy: { mockRestore: () => void }
  let stderrSpy: { mockRestore: () => void }

  beforeEach(() => {
    // Fresh state dir per test — the lock module writes real files here.
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }

    tmpDir = mkdtempSync(join(tmpdir(), "lore-helpers-test-"))
    transcriptPath = join(tmpDir, "transcript.jsonl")

    stdoutWrites = []
    stderrWrites = []
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk))
      return true
    })
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk))
      return true
    })

    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeLiveChild())
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
  })

  it("never emits decision: block when the interval is reached", async () => {
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-no-block",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig()
    )

    const stdout = stdoutWrites.join("")
    expect(stdout).not.toContain('"decision"')
    expect(stdout).not.toContain("block")
    expect(stdout.trim()).toBe("{}")
  })

  it("spawns a background save when the interval is reached", async () => {
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-spawn",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig()
    )

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(typeof bin).toBe("string")
    expect(args).toContain("-p")
    // Background saves allowlist the three non-deprecated lore write tools.
    const allowedIdx = args.indexOf("--allowedTools")
    expect(allowedIdx).toBeGreaterThan(-1)
    const allowed = args[allowedIdx + 1]
    expect(allowed).toContain("lore-remember")
    expect(allowed).toContain("lore-learn")
    expect(allowed).toContain("lore-decide")
    // lore-journal is soft-deprecated and no longer invited from the prompt;
    // drop it from the allowlist too so implementation and prompt agree.
    expect(allowed).not.toContain("lore-journal")
  })

  it("does not spawn when the interval has not been reached", async () => {
    writeTranscript(transcriptPath, 1)
    await handleStop(
      {
        session_id: "sess-under-threshold",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig({ saveInterval: 5 })
    )

    expect(spawnMock).not.toHaveBeenCalled()
    expect(stdoutWrites.join("").trim()).toBe("{}")
  })

  it("leaves only one process running when two Stop hooks race on the same session", async () => {
    writeTranscript(transcriptPath, 10)
    const sessionId = "sess-lock-overlap"

    // First fire: reaches threshold, acquires lock, spawns once. Because our
    // fake child reports process.pid (guaranteed alive), the lock stays live
    // across the second call.
    await handleStop(
      {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig()
    )

    // Second fire: interval would again say "spawn", but the lock is still
    // held by the "previous" child → no second spawn.
    await handleStop(
      {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig({ saveInterval: 1 })
    )

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it("still serializes spawns when two Stop hooks fire concurrently (Promise.all)", async () => {
    writeTranscript(transcriptPath, 10)
    const sessionId = "sess-lock-concurrent"

    // Both hooks start simultaneously. Only one can acquire the lock; the
    // other must skip spawn even though it also clears the interval check.
    await Promise.all([
      handleStop(
        { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
        defaultConfig()
      ),
      handleStop(
        { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
        defaultConfig()
      ),
    ])

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it("still responds {} and exits cleanly when the lock rejects the spawn", async () => {
    writeTranscript(transcriptPath, 10)
    const sessionId = "sess-lock-output"
    await handleStop(
      { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
      defaultConfig()
    )
    stdoutWrites.length = 0
    await handleStop(
      { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
      defaultConfig({ saveInterval: 1 })
    )
    expect(stdoutWrites.join("").trim()).toBe("{}")
    expect(stdoutWrites.join("")).not.toContain('"decision"')
  })

  it("does not advance the save counter when a peer holds the session lock", async () => {
    // PF2-03 invariant: handleStop only advances the save counter on
    // `result.kind === "spawned"`. When `spawnBackgroundSave` returns
    // `lock-held` (because a peer is still in flight), the counter must
    // stay where it is so the next Stop or the SessionEnd recovery path
    // can retry. A regression here would re-introduce the bug PR #66 fixed.
    writeTranscript(transcriptPath, 5)
    const sessionId = "sess-counter-invariant"

    // Pre-acquire the session lock with this process's PID so it's seen as
    // "alive" — `spawnBackgroundSave` will short-circuit on its fast-path
    // `hasActiveSessionLock` check and return `lock-held` without firing
    // child_process.spawn at all.
    const heldLock = tryAcquireSessionLock(sessionId, process.pid)
    expect(heldLock).not.toBeNull()

    await handleStop(
      { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
      defaultConfig()
    )

    // No child spawn should have happened — the fast-path lock-held check
    // returns before child_process.spawn is invoked.
    expect(spawnMock).not.toHaveBeenCalled()

    // Counter must remain at 0 — proving the SessionEnd recovery path will
    // see currentCount > lastSaveCount and re-fire on session close.
    const { readFileSync, existsSync } = await import("node:fs")
    const counterPath = join(getStateDir(), `${sessionId}.count`)
    if (existsSync(counterPath)) {
      const contents = readFileSync(counterPath, "utf-8")
      expect(contents).toBe("0")
    }

    releaseSessionLock(heldLock!)
  })

  it("acquires the session lock with the child's PID", async () => {
    writeTranscript(transcriptPath, 3)
    const sessionId = "sess-pid-lock"
    await handleStop(
      { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
      defaultConfig()
    )
    // The fake child returns process.pid. The hook acquires the lock with
    // that PID directly, so staleness probes keep returning "alive" after
    // the hook exits.
    const { readFileSync } = await import("node:fs")
    const lockContent = readFileSync(lockPath(sessionId), "utf-8").trim()
    expect(lockContent).toBe(process.pid.toString())
  })
})

describe("handleSessionEnd", () => {
  let tmpDir: string
  let transcriptPath: string
  let stdoutSpy: { mockRestore: () => void }
  let stderrSpy: { mockRestore: () => void }
  const savedEnv = { ...process.env }

  beforeEach(() => {
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
    tmpDir = mkdtempSync(join(tmpdir(), "lore-session-end-test-"))
    transcriptPath = join(tmpDir, "transcript.jsonl")

    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    spawnMock.mockReset()
    spawnMock.mockImplementation(() => ({
      pid: process.pid,
      unref: () => {},
      kill: () => true,
    }))
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
    // Restore env vars our tests mutated.
    process.env = { ...savedEnv }
  })

  function writeTranscriptAt(path: string, userMessages: number): void {
    const lines: string[] = []
    for (let i = 0; i < userMessages; i++) {
      lines.push(
        JSON.stringify({
          type: "user",
          message: { role: "user", content: [{ type: "text", text: `user ${i}` }] },
        })
      )
      lines.push(
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: `assistant ${i}` }],
          },
        })
      )
    }
    writeFileSync(path, lines.join("\n"))
  }

  it("spawns a background save with the session-end prompt allowlist", async () => {
    writeTranscriptAt(transcriptPath, 3)
    process.env["LORE_SESSION_END_CONTENT"] = JSON.stringify({
      session_id: "sess-end",
      transcript_path: transcriptPath,
      cwd: tmpDir,
    })
    delete process.env["LORE_AUTOSAVE"]

    await handleSessionEnd()

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(typeof bin).toBe("string")
    expect(args).toContain("-p")
    const allowedIdx = args.indexOf("--allowedTools")
    const allowed = args[allowedIdx + 1]
    expect(allowed).toContain("lore-remember")
    expect(allowed).not.toContain("lore-journal")
  })

  it("skips when fewer than two user messages are present", async () => {
    writeTranscriptAt(transcriptPath, 1)
    process.env["LORE_SESSION_END_CONTENT"] = JSON.stringify({
      session_id: "sess-tiny",
      transcript_path: transcriptPath,
      cwd: tmpDir,
    })
    delete process.env["LORE_AUTOSAVE"]

    await handleSessionEnd()

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it("respects LORE_AUTOSAVE=false and returns immediately", async () => {
    writeTranscriptAt(transcriptPath, 10)
    process.env["LORE_SESSION_END_CONTENT"] = JSON.stringify({
      session_id: "sess-disabled",
      transcript_path: transcriptPath,
      cwd: tmpDir,
    })
    process.env["LORE_AUTOSAVE"] = "false"

    await handleSessionEnd()

    expect(spawnMock).not.toHaveBeenCalled()
  })

  // End-to-end pin of acceptance criterion (d) "no regression in session-end
  // save reliability". Three pieces of code conspire to make recovery work
  // after a mid-session spawn rejection: spawnBackgroundSave returning a
  // non-`spawned` SpawnResult, handleStop conditionally bumping the counter
  // only when `result.kind === "spawned"`, and handleSessionEnd's
  // currentCount > lastSaveCount guard. A future refactor could quietly
  // break any one of them — this test fails loudly if it does.
  it("recovers a rejected mid-session spawn via the SessionEnd path", async () => {
    writeTranscriptAt(transcriptPath, 3)
    const sessionId = "sess-recovery"

    // Pre-acquire the lock with a known-alive PID (this process), so the
    // first handleStop sees an in-flight save and rejects before spawn.
    const heldLock = tryAcquireSessionLock(sessionId, process.pid)
    expect(heldLock).not.toBeNull()

    await handleStop(
      { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
      // 2-message threshold matches the helpers default; the transcript has
      // 3 user messages so the threshold is reached on this call.
      {
        saveInterval: 2,
        autoSave: true,
        wakeUp: true,
        autoDigest: true,
        catchAllName: null,
        subProjects: [],
      }
    )

    // Stop's spawn was blocked by the held lock — counter must NOT have
    // advanced, otherwise SessionEnd's recovery guard would skip.
    expect(spawnMock).not.toHaveBeenCalled()

    // Clear the artificial block so SessionEnd's own spawn can land.
    releaseSessionLock(heldLock!)

    // Now drive SessionEnd. With the save counter still at 0 and the
    // transcript holding 3 user messages, currentCount - lastSaveCount = 3
    // > 0, so the recovery path fires.
    process.env["LORE_SESSION_END_CONTENT"] = JSON.stringify({
      session_id: sessionId,
      transcript_path: transcriptPath,
      cwd: tmpDir,
    })
    delete process.env["LORE_AUTOSAVE"]

    await handleSessionEnd()

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })
})
