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
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
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
//
// `fireDigestIfStaleMock` stands in for the digest scheduler so the
// session-end integration tests can assert wiring (was the call made? with
// what shape?) without firing real Notion or `claude -p` work.
const { spawnMock, execFileSyncMock, fireDigestIfStaleMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(() => "/mock/bin/claude\n"),
  fireDigestIfStaleMock: vi.fn(async () => "no-project" as const),
}))

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, spawn: spawnMock, execFileSync: execFileSyncMock }
})

vi.mock("./digest-scheduler.js", async () => {
  const actual =
    await vi.importActual<typeof import("./digest-scheduler.js")>("./digest-scheduler.js")
  return { ...actual, fireDigestIfStale: fireDigestIfStaleMock }
})

import type { HookConfig } from "./config.js"
import {
  getStateDir,
  lockPath,
  releaseSessionLock,
  tryAcquireSessionLock,
} from "./lock.js"
import { handleStop, handleSessionEnd, parseUserQueryFromEvent } from "./helpers.js"

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

describe("handleSessionEnd → fireDigestIfStale wiring", () => {
  let tmpDir: string
  let transcriptPath: string
  let stdoutSpy: { mockRestore: () => void }
  let stderrSpy: { mockRestore: () => void }
  const savedEnv = { ...process.env }
  const originalCwd = process.cwd()

  // Minimal `.lore.yaml` so `loadHookState` returns a populated `config` +
  // `configRoot`. Without these fields the digest block in `handleSessionEnd`
  // is gated off (`if (state.config && state.configRoot)`) — the wired path
  // would never run and the test would be vacuously green.
  const FIXTURE_YAML = `vault:
  pageId: vault-fixture-id
projects:
  - name: Mail
    path: .
hooks:
  autoDigest: true
`

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lore-session-end-digest-"))
    writeFileSync(join(tmpDir, ".lore.yaml"), FIXTURE_YAML)
    transcriptPath = join(tmpDir, "transcript.jsonl")
    writeTranscript(transcriptPath, 3)

    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeLiveChild())

    fireDigestIfStaleMock.mockReset()
    fireDigestIfStaleMock.mockResolvedValue("no-project")

    // chdir so `findConfigFile(process.cwd())` finds the fixture. The hook
    // event's `cwd` field is what `fireDigestIfStale` ultimately sees, but
    // `loadHookState` reads `process.cwd()` to find the config.
    process.chdir(tmpDir)

    // Default: enable digest path. Individual tests override.
    delete process.env["LORE_AUTO_DIGEST"]
    delete process.env["LORE_AUTOSAVE"]
  })

  afterEach(() => {
    process.chdir(originalCwd)
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
    process.env = { ...savedEnv }
  })

  it("calls fireDigestIfStale with the event cwd, loaded config, and autoDigest=true", async () => {
    process.env["LORE_SESSION_END_CONTENT"] = JSON.stringify({
      session_id: "sess-digest",
      transcript_path: transcriptPath,
      cwd: tmpDir,
    })

    await handleSessionEnd()

    expect(fireDigestIfStaleMock).toHaveBeenCalledTimes(1)
    const [cwdArg, stateArg] = fireDigestIfStaleMock.mock.calls[0] as unknown as [
      string,
      { config: { vault: { pageId: string } }; configRoot: string; autoDigest: boolean },
    ]
    expect(cwdArg).toBe(tmpDir)
    // findConfigFile canonicalizes via real-path resolution (`/var → /private/var`
    // on macOS), so compare canonical to canonical instead of the raw mkdtemp.
    expect(stateArg.configRoot).toBe(realpathSync(tmpDir))
    expect(stateArg.autoDigest).toBe(true)
    expect(stateArg.config.vault.pageId).toBe("vault-fixture-id")
  })

  it("threads autoDigest=false through to the scheduler when LORE_AUTO_DIGEST=false", async () => {
    process.env["LORE_AUTO_DIGEST"] = "false"
    process.env["LORE_SESSION_END_CONTENT"] = JSON.stringify({
      session_id: "sess-env-disabled",
      transcript_path: transcriptPath,
      cwd: tmpDir,
    })

    await handleSessionEnd()

    // The scheduler IS still called — it owns the disabled-short-circuit so
    // observability stays consistent. But it must see autoDigest=false.
    expect(fireDigestIfStaleMock).toHaveBeenCalledTimes(1)
    const stateArg = (fireDigestIfStaleMock.mock.calls[0] as unknown as [string, { autoDigest: boolean }])[1]
    expect(stateArg.autoDigest).toBe(false)
  })

  it("threads autoDigest=false when hooks.autoDigest is false in .lore.yaml", async () => {
    writeFileSync(
      join(tmpDir, ".lore.yaml"),
      FIXTURE_YAML.replace("autoDigest: true", "autoDigest: false")
    )
    process.env["LORE_SESSION_END_CONTENT"] = JSON.stringify({
      session_id: "sess-config-disabled",
      transcript_path: transcriptPath,
      cwd: tmpDir,
    })

    await handleSessionEnd()

    expect(fireDigestIfStaleMock).toHaveBeenCalledTimes(1)
    const stateArg = (fireDigestIfStaleMock.mock.calls[0] as unknown as [string, { autoDigest: boolean }])[1]
    expect(stateArg.autoDigest).toBe(false)
  })

  it("env override wins even when hooks.autoDigest is true (LORE_AUTO_DIGEST=false trumps config)", async () => {
    // FIXTURE_YAML has autoDigest: true; env override should still flip it.
    process.env["LORE_AUTO_DIGEST"] = "false"
    process.env["LORE_SESSION_END_CONTENT"] = JSON.stringify({
      session_id: "sess-env-overrides-config",
      transcript_path: transcriptPath,
      cwd: tmpDir,
    })

    await handleSessionEnd()

    const stateArg = (fireDigestIfStaleMock.mock.calls[0] as unknown as [string, { autoDigest: boolean }])[1]
    expect(stateArg.autoDigest).toBe(false)
  })

  it("swallows scheduler throws so session exit stays clean (fail-open contract)", async () => {
    fireDigestIfStaleMock.mockRejectedValueOnce(new Error("notion exploded"))
    process.env["LORE_SESSION_END_CONTENT"] = JSON.stringify({
      session_id: "sess-throws",
      transcript_path: transcriptPath,
      cwd: tmpDir,
    })

    // Must not throw — the inline try/catch around fireDigestIfStale at
    // helpers.ts:540-550 contains the error so session exit stays clean.
    await expect(handleSessionEnd()).resolves.toBeUndefined()
    expect(fireDigestIfStaleMock).toHaveBeenCalledTimes(1)
  })

  it("does not call fireDigestIfStale when no .lore.yaml is found in any ancestor of cwd", async () => {
    // The principal review on PR #68 named "drop the
    // `state.config && state.configRoot` guard" as a regression mode the
    // wiring tests must catch. The other cases all run with a populated
    // .lore.yaml so the guard is always satisfied; this case runs from a
    // directory whose ancestor chain has no .lore.yaml so loadHookState
    // returns { config: null, configRoot: null }. A regression that
    // dropped the guard would crash inside the un-mocked scheduler with
    // resolveProjectPathFromCwd(cwd, null, null).
    //
    // os.tmpdir() resolves to /var/folders/... on macOS and /tmp on Linux;
    // walking upward from a fresh subdirectory there hits / without
    // crossing any project's .lore.yaml on the runners we use.
    const noConfigDir = mkdtempSync(join(tmpdir(), "lore-no-config-"))
    try {
      process.chdir(noConfigDir)
      writeTranscript(join(noConfigDir, "transcript.jsonl"), 3)
      process.env["LORE_SESSION_END_CONTENT"] = JSON.stringify({
        session_id: "sess-no-config",
        transcript_path: join(noConfigDir, "transcript.jsonl"),
        cwd: noConfigDir,
      })

      await handleSessionEnd()

      expect(fireDigestIfStaleMock).not.toHaveBeenCalled()
    } finally {
      rmSync(noConfigDir, { recursive: true, force: true })
    }
  })
})

describe("parseUserQueryFromEvent", () => {
  // P3-05: the wake-up hook reads the JSON event Claude Code's
  // UserPromptSubmit emits on stdin (forwarded by wakeup.sh as
  // LORE_WAKEUP_EVENT). The parser is the only place where event-shape
  // assumptions live; pinning them here keeps a future Claude Code
  // event-shape change from silently degrading wake-up to the unranked
  // fallback path without us noticing.

  it("extracts the prompt field from a well-formed UserPromptSubmit event", () => {
    const raw = JSON.stringify({
      session_id: "abc",
      hook_event_name: "UserPromptSubmit",
      prompt: "How do I fix the auth bug?",
      cwd: "/tmp",
    })
    expect(parseUserQueryFromEvent(raw)).toBe("How do I fix the auth bug?")
  })

  it("trims surrounding whitespace from the prompt", () => {
    const raw = JSON.stringify({ prompt: "  fix auth bug  \n" })
    expect(parseUserQueryFromEvent(raw)).toBe("fix auth bug")
  })

  it("returns undefined for a whitespace-only prompt", () => {
    // Treated identically to an absent prompt — the data layer would
    // skip the search anyway, but degrading at the parser keeps the
    // log line accurate ("no user query" rather than "empty user query").
    const raw = JSON.stringify({ prompt: "   \n\t  " })
    expect(parseUserQueryFromEvent(raw)).toBeUndefined()
  })

  it.each([
    ["undefined env var", undefined],
    ["empty string", ""],
    ["whitespace only", "  \n  "],
  ])("returns undefined for %s (Codex SessionStart fallback)", (_label, raw) => {
    expect(parseUserQueryFromEvent(raw)).toBeUndefined()
  })

  it("returns undefined for malformed JSON (degrades to fallback path)", () => {
    // A misconfigured wakeup.sh forwarding non-JSON would otherwise
    // crash the helper. Falling back to unranked output is strictly
    // better than failing wake-up entirely.
    expect(parseUserQueryFromEvent("not-json-at-all")).toBeUndefined()
    expect(parseUserQueryFromEvent("{ unterminated")).toBeUndefined()
  })

  it("returns undefined for valid JSON that's not an object", () => {
    expect(parseUserQueryFromEvent("null")).toBeUndefined()
    expect(parseUserQueryFromEvent('"just a string"')).toBeUndefined()
    expect(parseUserQueryFromEvent("42")).toBeUndefined()
    expect(parseUserQueryFromEvent("[1, 2, 3]")).toBeUndefined()
  })

  it("returns undefined when the prompt field is missing", () => {
    // Future-proofing: if Claude Code renames `prompt` to `query` in a
    // later release, we want wake-up to fall back gracefully (and the
    // log under LORE_DEBUG=1 to surface it) rather than ship task-
    // memories seeded by `undefined`.
    const raw = JSON.stringify({
      session_id: "abc",
      hook_event_name: "UserPromptSubmit",
      cwd: "/tmp",
    })
    expect(parseUserQueryFromEvent(raw)).toBeUndefined()
  })

  it("returns undefined when the prompt field is not a string", () => {
    expect(parseUserQueryFromEvent(JSON.stringify({ prompt: 42 }))).toBeUndefined()
    expect(parseUserQueryFromEvent(JSON.stringify({ prompt: null }))).toBeUndefined()
    expect(parseUserQueryFromEvent(JSON.stringify({ prompt: { nested: "x" } }))).toBeUndefined()
  })

  it.each([
    ["plain slash command", "/clear"],
    ["with whitespace", "  /compact  "],
    ["with arguments", "/lore-wake-up --debug"],
    ["another tool slash", "/help"],
  ])("returns undefined for %s (slash commands are useless as search seeds)", (_label, prompt) => {
    // Slash commands are meta-instructions to the host assistant, not
    // task language. Seeding the relevance ranker with `/clear` would
    // produce noise hits (any memory mentioning "clear") and waste a
    // Notion round-trip. Drop to the fallback path instead.
    const raw = JSON.stringify({ prompt })
    expect(parseUserQueryFromEvent(raw)).toBeUndefined()
  })

  it("preserves prompts that incidentally contain a forward slash", () => {
    // Only LEADING `/` is the slash-command marker. A real task prompt
    // like "fix the path /etc/hosts handling" must still seed the search.
    const raw = JSON.stringify({ prompt: "fix the path /etc/hosts handling" })
    expect(parseUserQueryFromEvent(raw)).toBe("fix the path /etc/hosts handling")
  })

  it("falls back when a resumed Claude Code session fires SessionStart instead of UserPromptSubmit", () => {
    // Resumed sessions in Claude Code fire SessionStart, not
    // UserPromptSubmit — there's no user prompt yet. The wakeup.sh
    // script either receives an empty stdin or a SessionStart event
    // with no `prompt` field. Both shapes degrade to the unranked
    // fallback path. This pins that contract so a future Anthropic
    // event-shape change doesn't quietly degrade resumed sessions.
    const sessionStartEvent = JSON.stringify({
      session_id: "abc",
      hook_event_name: "SessionStart",
      cwd: "/tmp",
    })
    expect(parseUserQueryFromEvent(sessionStartEvent)).toBeUndefined()
    // Empty stdin (the more common Codex shape) also falls back.
    expect(parseUserQueryFromEvent("")).toBeUndefined()
    expect(parseUserQueryFromEvent(undefined)).toBeUndefined()
  })
})
