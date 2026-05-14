/**
 * Tests for the `LockPathTooLongError` defense in `tryAcquireSessionLock`
 * (issue #485).
 *
 * Even with `safeFilenameSegment`'s 128-char cap, a `LORE_HOOK_STATE_DIR`
 * close to `PATH_MAX` (~1024 bytes on darwin, 4096 on Linux) can still
 * push the rendered lock path over the syscall limit. Without this
 * defense the resulting error rethrows out of every Stop hook for the
 * affected session and indefinitely skips autosave with no operator
 * surface; the fix throws a classified `LockPathTooLongError` that
 * `spawnBackgroundSave` catches and maps to a `lock-path-too-long`
 * `SpawnResult` kind — distinct from the benign-race / capacity returns
 * so digest-marker rollback, background-failure markers, and CLI
 * messaging all see the genuine-failure shape.
 *
 * These tests live in their own file because they mock `node:fs`'s
 * `writeFileSync` / `mkdirSync` to deterministically inject the syscall
 * error — `lock.test.ts` exercises the lock against a real state dir
 * and must not be globally fs-mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  process.env["LORE_HOOK_STATE_DIR"] =
    `${process.env["TMPDIR"] ?? "/tmp"}/lore-lock-name-too-long-${process.pid}-${Date.now()}`
})

const { writeFileSyncMock, mkdirSyncMock } = vi.hoisted(() => ({
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
}))

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  return {
    ...actual,
    writeFileSync: writeFileSyncMock,
    mkdirSync: mkdirSyncMock,
  }
})

import { LockPathTooLongError, tryAcquireSessionLock } from "./lock.js"

function makeFsError(code: "ENAMETOOLONG" | "ENOENT" | "ENOSPC"): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException
  err.code = code
  return err
}

/**
 * Override `process.platform` for the duration of a test. Vitest does
 * not ship a built-in helper for this; `vi.stubGlobal` works on globals
 * but `process.platform` is a getter on a host object. The standard
 * darwin/linux gate the production code uses is the simplest knob to
 * test. Restore is pinned to whatever the host reported at module
 * load time so we don't accidentally hardcode a value across files.
 */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const desc = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  })
  try {
    return fn()
  } finally {
    // `desc` is always defined for `process.platform` on every Node version
    // the hooks layer targets — if a future Node release ever drops the
    // descriptor, the platform-gated branches in production code would
    // already misbehave for a wider reason than this test cleanup.
    if (desc) {
      Object.defineProperty(process, "platform", desc)
    }
  }
}

describe("tryAcquireSessionLock — LockPathTooLongError defense (#485)", () => {
  beforeEach(() => {
    writeFileSyncMock.mockReset()
    mkdirSyncMock.mockReset()
    // mkdirSync is called via `ensureStateDirSync` at the top of every
    // acquire attempt; default to a benign no-op so only the test under
    // test gets to inject failure modes.
    mkdirSyncMock.mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("throws LockPathTooLongError when writeFileSync throws ENAMETOOLONG", () => {
    writeFileSyncMock.mockImplementationOnce(() => {
      throw makeFsError("ENAMETOOLONG")
    })

    let thrown: unknown = null
    try {
      tryAcquireSessionLock("session-with-too-long-path", process.pid)
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(LockPathTooLongError)
    if (thrown instanceof LockPathTooLongError) {
      // The classified throw — distinct from a coalesced `null` return —
      // is what lets `spawnBackgroundSave` map this to the non-benign
      // `lock-path-too-long` SpawnResult kind. A bare null return would
      // silently route through the `race-lost` peer-active branch.
      expect(thrown.code).toBe("ENAMETOOLONG")
      expect(thrown.lockKey).toBe("session-with-too-long-path")
    }
    // `mkdirSync` was called (ensureStateDirSync), then `writeFileSync`
    // was attempted exactly once. Pin the call order so a future refactor
    // that lazily creates the state dir doesn't silently change the
    // failure path.
    expect(mkdirSyncMock).toHaveBeenCalled()
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1)
    const mkdirOrder = mkdirSyncMock.mock.invocationCallOrder[0]
    const writeOrder = writeFileSyncMock.mock.invocationCallOrder[0]
    expect(mkdirOrder).toBeLessThan(writeOrder)
  })

  it("throws LockPathTooLongError on darwin when writeFileSync throws ENOENT", () => {
    // The darwin-specific variant where the kernel maps an over-NAME_MAX
    // segment to ENOENT after `ensureStateDirSync` has just created the
    // parent directory. Treated as path-too-long under the platform gate.
    writeFileSyncMock.mockImplementationOnce(() => {
      throw makeFsError("ENOENT")
    })

    const thrown = withPlatform("darwin", () => {
      try {
        tryAcquireSessionLock("session-with-darwin-enoent", process.pid)
        return null
      } catch (err) {
        return err
      }
    })

    expect(thrown).toBeInstanceOf(LockPathTooLongError)
    if (thrown instanceof LockPathTooLongError) {
      expect(thrown.code).toBe("ENOENT")
    }
  })

  it("propagates ENOENT verbatim on linux so TOCTOU and missing-dir bugs stay visible", () => {
    // The reviewer's load-bearing concern: on Linux, ENOENT only ever
    // means the parent directory disappeared between
    // `ensureStateDirSync()` and `writeFileSync` (TOCTOU — operator
    // running `rm -rf $TMPDIR/lore-hook-state` mid-session, or a second
    // hook racing a cleanup). Conflating that into "path too long" would
    // point the operator at the wrong knob (`LORE_HOOK_STATE_DIR`
    // length) and silently mask a real bug. Pin the platform gate.
    const enoent = makeFsError("ENOENT")
    writeFileSyncMock.mockImplementationOnce(() => {
      throw enoent
    })

    const thrown = withPlatform("linux", () => {
      try {
        tryAcquireSessionLock("session-linux-enoent", process.pid)
        return null
      } catch (err) {
        return err
      }
    })

    // On linux, ENOENT must propagate verbatim — neither a
    // `LockPathTooLongError` reclassification nor a benign `null` return.
    expect(thrown).toBe(enoent)
    expect(thrown).not.toBeInstanceOf(LockPathTooLongError)
  })

  it("includes the lockKey in the thrown error so callers can emit logLabel-aware warnings", () => {
    // The lock layer no longer emits stderr itself — the warning is the
    // caller's responsibility (in `spawnBackgroundSave`) so the
    // `[lore] background save:` vs `[lore] digest:` framing matches the
    // surface the failure occurred on. The error's `lockKey` field is
    // what makes that emission accurate.
    writeFileSyncMock.mockImplementationOnce(() => {
      throw makeFsError("ENAMETOOLONG")
    })

    let thrown: unknown = null
    try {
      tryAcquireSessionLock("digest-Widget", process.pid)
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(LockPathTooLongError)
    if (thrown instanceof LockPathTooLongError) {
      expect(thrown.lockKey).toBe("digest-Widget")
      // The `message` on the error includes the code and lockKey so
      // generic catch-and-log sites still surface useful context, even
      // if they don't pattern-match on the class.
      expect(thrown.message).toContain("ENAMETOOLONG")
      expect(thrown.message).toContain("digest-Widget")
    }
  })

  it("still rethrows ENOSPC and other unclassified write errors", () => {
    // The fix is narrow: only ENAMETOOLONG (always) and ENOENT (darwin
    // only) are reclassified. Anything else (disk full, IO error,
    // permission) must still propagate so the operator sees a real
    // failure rather than a silently-skipped autosave masquerading as a
    // benign race-loss.
    const enospc = makeFsError("ENOSPC")
    writeFileSyncMock.mockImplementationOnce(() => {
      throw enospc
    })

    expect(() => tryAcquireSessionLock("session-disk-full", process.pid)).toThrow(enospc)
  })

  it("throws LockPathTooLongError when ensureStateDirSync itself throws ENAMETOOLONG", () => {
    // A pathological LORE_HOOK_STATE_DIR can be too long for mkdirSync to
    // resolve; the lock layer must absorb that the same way it absorbs a
    // too-long lock-file write. Otherwise the Stop hook still rethrows
    // even though we never reached the writeFileSync branch.
    mkdirSyncMock.mockImplementationOnce(() => {
      throw makeFsError("ENAMETOOLONG")
    })

    let thrown: unknown = null
    try {
      tryAcquireSessionLock("session-too-long-state-dir", process.pid)
    } catch (err) {
      thrown = err
    }

    expect(thrown).toBeInstanceOf(LockPathTooLongError)
    if (thrown instanceof LockPathTooLongError) {
      expect(thrown.code).toBe("ENAMETOOLONG")
    }
    // The state-dir failure short-circuits before the writeFileSync
    // branch — pin that so a future refactor doesn't accidentally call
    // writeFileSync against a non-existent dir on this path.
    expect(writeFileSyncMock).not.toHaveBeenCalled()
  })

  it("succeeds on the happy path when neither syscall trips the absorbed-error branch", () => {
    // Sanity check: with the fs mocks in place but no errors injected,
    // tryAcquireSessionLock returns a path. Otherwise the absorbed-error
    // tests above could be passing because the function silently fails
    // for some unrelated reason.
    writeFileSyncMock.mockImplementationOnce(() => undefined)

    const result = tryAcquireSessionLock("happy-path-session", process.pid)

    expect(result).not.toBeNull()
    expect(result).toContain("happy-path-session.lock")
  })
})
