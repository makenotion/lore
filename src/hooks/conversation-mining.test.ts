/**
 * Tests for `runConversationMining`.
 *
 * The fake child shimmed in for `node:child_process.spawn` is rich
 * enough to drive every settle path the helper has to handle:
 *
 *   - Child `exit` event with a normal exit code.
 *   - Child `exit` event with a non-null signal (caller-driven kill).
 *   - Child `error` event (spawn-level failure).
 *   - Child `stdin` `error` event (EPIPE: child closes its read end
 *     before draining the prompt).
 *   - Wall-clock timeout firing (SIGTERM, grace period, SIGKILL,
 *     synthetic resolve regardless of whether the child emits its
 *     own `exit`).
 *   - Wall-clock timeout fires, but the child cooperates and exits
 *     before the SIGKILL grace runs out.
 *
 * Operator-debug stderr surface (binary-missing hint) is also pinned
 * so a future change to the wording is caught by the test.
 *
 * The shared env partition's contract is exercised at the helper
 * layer where the partition lives, so duplicating the partition
 * assertions here would just create a drift surface.
 */
import { EventEmitter } from "node:events"
import { writeFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { spawnMock, execFileSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(() => "/mock/bin/claude\n"),
}))

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, spawn: spawnMock, execFileSync: execFileSyncMock }
})

const { openSyncMock, closeSyncMock } = vi.hoisted(() => ({
  openSyncMock: vi.fn(),
  closeSyncMock: vi.fn(),
}))

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    openSync: openSyncMock,
    closeSync: closeSyncMock,
  }
})

import {
  DEFAULT_MINING_TIMEOUT_MS,
  TIMEOUT_KILLED_SIGNAL,
  TIMEOUT_KILL_GRACE_MS,
  runConversationMining,
} from "./conversation-mining.js"

interface FakeChildHandle {
  emit: (event: "exit" | "error", ...args: unknown[]) => void
  emitStdinError: (err: Error) => void
  stdinWrites: string[]
  stdinEnded: boolean
  killSignals: NodeJS.Signals[]
}

function fakeChild(): { child: EventEmitter; handle: FakeChildHandle } {
  const stdinEmitter = new EventEmitter() as EventEmitter & {
    write: (chunk: string) => void
    end: () => void
  }
  const ee = new EventEmitter() as EventEmitter & {
    stdin: typeof stdinEmitter
    stderr: { resume: () => void }
    kill: (signal?: NodeJS.Signals) => boolean
  }
  const handle: FakeChildHandle = {
    emit: (event, ...args) => ee.emit(event, ...args),
    emitStdinError: (err) => stdinEmitter.emit("error", err),
    stdinWrites: [],
    stdinEnded: false,
    killSignals: [],
  }
  stdinEmitter.write = (chunk: string) => {
    handle.stdinWrites.push(chunk)
  }
  stdinEmitter.end = () => {
    handle.stdinEnded = true
  }
  ee.stdin = stdinEmitter
  ee.stderr = { resume: () => {} }
  ee.kill = (signal?: NodeJS.Signals) => {
    if (signal) handle.killSignals.push(signal)
    return true
  }
  return { child: ee, handle }
}

describe("runConversationMining", () => {
  let tmpDir: string

  beforeEach(() => {
    spawnMock.mockReset()
    execFileSyncMock.mockReset()
    execFileSyncMock.mockReturnValue("/mock/bin/claude\n")
    openSyncMock.mockReset()
    closeSyncMock.mockReset()
    tmpDir = mkdtempSync(join(tmpdir(), "lore-mining-test-"))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("rejects when the background-agent binary is not findable", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("which: command not found")
    })
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    await expect(
      runConversationMining("transcript", {
        cwd: tmpDir,
        subProjects: [],
        catchAllName: null,
        agent: {
          command: "/nonexistent/path/to/binary",
          args: ["-p", "--allowedTools", "{{allowedTools}}"],
        },
      })
    ).rejects.toThrow(/binary "\/nonexistent\/path\/to\/binary" not found/)

    // Operator-debug hint matches the hook path's shape so engineers
    // triaging "lore can't find my agent" see one surface across paths.
    expect(stderrSpy).toHaveBeenCalled()
    const hintCall = stderrSpy.mock.calls
      .map((c) => String(c[0]))
      .find((s) => s.includes("[lore] conversation-mining:"))
    expect(hintCall).toBeDefined()
    expect(hintCall).toContain(
      'background command "/nonexistent/path/to/binary" not found on PATH'
    )

    stderrSpy.mockRestore()
  })

  it("returns clean-exit shape with elapsedMs and zero exitCode", async () => {
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("session transcript text", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
    })

    // Let the microtask that wires up exit handlers run.
    await new Promise((resolve) => setImmediate(resolve))
    handle.emit("exit", 0, null)
    const result = await promise

    expect(result.exitCode).toBe(0)
    expect(result.exitSignal).toBeNull()
    expect(result.writeBudgetExceeded).toBe(false)
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0)
    expect(handle.stdinEnded).toBe(true)
    expect(handle.stdinWrites.join("")).toContain("session transcript text")
  })

  it("surfaces writeBudgetExceeded: true when the budget-state file says so", async () => {
    const stateFile = join(tmpDir, "budget.json")
    writeFileSync(
      stateFile,
      JSON.stringify({ writeBudgetExceeded: true, count: 502, budget: 500 })
    )
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("transcript", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
      budgetStateFile: stateFile,
    })
    await new Promise((resolve) => setImmediate(resolve))
    handle.emit("exit", 1, null)
    const result = await promise

    expect(result.writeBudgetExceeded).toBe(true)
    expect(result.exitCode).toBe(1)
  })

  it("treats malformed budget-state file as not-exceeded", async () => {
    const stateFile = join(tmpDir, "budget.json")
    writeFileSync(stateFile, "not valid json {{{")
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("transcript", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
      budgetStateFile: stateFile,
    })
    await new Promise((resolve) => setImmediate(resolve))
    handle.emit("exit", 0, null)
    const result = await promise

    expect(result.writeBudgetExceeded).toBe(false)
  })

  it("treats missing budget-state file as not-exceeded", async () => {
    const stateFile = join(tmpDir, "missing.json")
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("transcript", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
      budgetStateFile: stateFile,
    })
    await new Promise((resolve) => setImmediate(resolve))
    handle.emit("exit", 0, null)
    const result = await promise

    expect(result.writeBudgetExceeded).toBe(false)
  })

  it("rejects on a stdin EPIPE error without crashing the parent", async () => {
    // A child that exits as soon as it's spawned (binary segfaults on
    // argv parse, agent CLI rejects on stdin shape, OS denies the
    // resource) closes its read end before draining the prompt. The
    // OS surfaces this on the parent's writable side as
    // `Error: write EPIPE`, emitted on `child.stdin` — a stream
    // distinct from the child process. Without a listener on the
    // stdin stream Node treats the event as unhandled and terminates
    // the parent.
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("transcript", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
    })

    // Let the helper attach all its listeners and start the write.
    await new Promise((resolve) => setImmediate(resolve))

    // Emit EPIPE on the stdin stream the same way Node's stream
    // layer would when the child has already closed its read end.
    const err = Object.assign(new Error("write EPIPE"), { code: "EPIPE" })
    handle.emitStdinError(err)

    await expect(promise).rejects.toThrow(/EPIPE/)
    // The error landed without the test runner itself crashing — the
    // assertion above already proves the listener was attached, but
    // the promise interface also pins the path through `settleReject`
    // rather than a synchronous throw.
  })

  it("rejects on child-emitted error before exit", async () => {
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("transcript", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
    })
    await new Promise((resolve) => setImmediate(resolve))
    handle.emit("error", new Error("ENOMEM"))

    await expect(promise).rejects.toThrow(/ENOMEM/)
  })

  it("surfaces exitSignal when the child is terminated", async () => {
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("transcript", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
    })
    await new Promise((resolve) => setImmediate(resolve))
    handle.emit("exit", null, "SIGTERM")
    const result = await promise

    expect(result.exitCode).toBeNull()
    expect(result.exitSignal).toBe("SIGTERM")
  })

  it("threads sessionId through into the prompt's identity block", async () => {
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("transcript text", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
      sessionId: "lme-session-42",
    })
    await new Promise((resolve) => setImmediate(resolve))
    handle.emit("exit", 0, null)
    await promise

    const promptWritten = handle.stdinWrites.join("")
    expect(promptWritten).toContain("Session ID: lme-session-42")
    expect(promptWritten).toContain('session: "lme-session-42"')
  })

  it("default timeoutMs is DEFAULT_MINING_TIMEOUT_MS", () => {
    expect(DEFAULT_MINING_TIMEOUT_MS).toBe(5 * 60 * 1000)
  })

  it("closes the parent's stderr-sink fd after a successful spawn", async () => {
    // Node's `spawn` duplicates the supplied fd into the child's
    // stdio when it accepts it; the parent still owns its own
    // descriptor. A caller invoking the helper once per session in
    // a loop with `stderrSinkPath` would leak one fd per run if
    // the parent's copy were never released, eventually tripping
    // `EMFILE` or holding unlinked log files open past cleanup.
    const FAKE_FD = 42
    openSyncMock.mockReturnValue(FAKE_FD)
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("transcript", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
      stderrSinkPath: join(tmpDir, "child-stderr.log"),
    })
    await new Promise((resolve) => setImmediate(resolve))
    handle.emit("exit", 0, null)
    await promise

    expect(openSyncMock).toHaveBeenCalledTimes(1)
    expect(openSyncMock).toHaveBeenCalledWith(
      join(tmpDir, "child-stderr.log"),
      "w",
      0o600
    )
    expect(closeSyncMock).toHaveBeenCalledWith(FAKE_FD)
  })

  it("closes the parent's stderr-sink fd when spawn itself throws", async () => {
    // If `openStderrSink` succeeds but `spawn` then throws (out-of-
    // resources, EAGAIN, ENOENT for the binary surviving the
    // findBackgroundBinary check but disappearing before exec), the
    // helper must still release the fd before rejecting.
    const FAKE_FD = 99
    openSyncMock.mockReturnValue(FAKE_FD)
    spawnMock.mockImplementation(() => {
      throw new Error("EAGAIN: resource temporarily unavailable")
    })

    await expect(
      runConversationMining("transcript", {
        cwd: tmpDir,
        subProjects: [],
        catchAllName: null,
        stderrSinkPath: join(tmpDir, "child-stderr.log"),
      })
    ).rejects.toThrow(/EAGAIN/)

    expect(openSyncMock).toHaveBeenCalledTimes(1)
    expect(closeSyncMock).toHaveBeenCalledWith(FAKE_FD)
  })

  it("does not call closeSync when no stderrSinkPath was passed", async () => {
    // The default internal-drain branch never opens an fd, so the
    // parent has nothing to release. A spurious `closeSync(null)`
    // or `closeSync(undefined)` would surface as a TypeError; the
    // guarded path returns early so the call is skipped entirely.
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("transcript", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
    })
    await new Promise((resolve) => setImmediate(resolve))
    handle.emit("exit", 0, null)
    await promise

    expect(openSyncMock).not.toHaveBeenCalled()
    expect(closeSyncMock).not.toHaveBeenCalled()
  })

  it("escalates SIGTERM → SIGKILL and resolves even when the child ignores both", async () => {
    vi.useFakeTimers()
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("transcript", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
      timeoutMs: 1_000,
    })

    // Let the microtask queue drain so listeners attach.
    await Promise.resolve()
    await Promise.resolve()

    // 1. Fire the wall-clock timeout. Helper sends SIGTERM.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(handle.killSignals).toContain("SIGTERM")
    // Child traps SIGTERM and refuses to exit — we deliberately do
    // NOT emit an 'exit' event here. The helper must still resolve.

    // 2. Advance through the grace period. Helper escalates to SIGKILL.
    await vi.advanceTimersByTimeAsync(TIMEOUT_KILL_GRACE_MS)
    expect(handle.killSignals).toContain("SIGKILL")

    // 3. The helper resolves with the synthetic killed signal regardless of
    //    whether the child ever emits its own 'exit' event. The terminal
    //    contract is: SIGTERM + grace period + SIGKILL + resolve.
    vi.useRealTimers()
    const result = await promise
    expect(result.exitCode).toBeNull()
    expect(result.exitSignal).toBe(TIMEOUT_KILLED_SIGNAL)
  })

  it("resolves cleanly on exit even after the wall-clock timer fires", async () => {
    vi.useFakeTimers()
    const { child, handle } = fakeChild()
    spawnMock.mockReturnValue(child)

    const promise = runConversationMining("transcript", {
      cwd: tmpDir,
      subProjects: [],
      catchAllName: null,
      timeoutMs: 1_000,
    })
    await Promise.resolve()
    await Promise.resolve()

    // Wall-clock fires; SIGTERM is sent. Child cooperates and exits
    // during the grace period before SIGKILL.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(handle.killSignals).toEqual(["SIGTERM"])
    handle.emit("exit", null, "SIGTERM")

    vi.useRealTimers()
    const result = await promise
    expect(result.exitSignal).toBe("SIGTERM")
    // The synthetic SIGKILL path is NOT taken when the child responds
    // to SIGTERM in time — pinned to distinguish the two terminal
    // shapes.
    expect(result.exitSignal).not.toBe(TIMEOUT_KILLED_SIGNAL)
  })
})
