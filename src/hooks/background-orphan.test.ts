/**
 * Tests for the post-spawn-throw cleanup contract in
 * `spawnBackgroundSave`.
 *
 * `tryAcquireSessionLock` reclassifies `ENAMETOOLONG` / darwin `ENOENT`
 * into `LockPathTooLongError`, which `spawnBackgroundSave` catches inline
 * and maps to a `lock-path-too-long` `SpawnResult` (see issue #485 and
 * `lock.ts`). That branch is exercised in the dedicated tests below; this
 * suite pins the broader invariant for any *other* post-spawn pre-lock
 * failure: the detached child is killed before `spawn-error` is returned.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  process.env["LORE_HOOK_STATE_DIR"] =
    `${process.env["TMPDIR"] ?? "/tmp"}/lore-bg-state-${process.pid}-${Date.now()}`
})

const { spawnMock, execFileSyncMock, tryAcquireMock, killMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(() => "/mock/bin/claude\n"),
  tryAcquireMock: vi.fn(),
  killMock: vi.fn(() => true),
}))

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return {
    ...actual,
    spawn: spawnMock,
    execFileSync: execFileSyncMock,
  }
})

vi.mock("./lock.js", async () => {
  const actual = await vi.importActual<typeof import("./lock.js")>("./lock.js")
  return {
    ...actual,
    tryAcquireSessionLock: tryAcquireMock,
  }
})

import { spawnBackgroundSave } from "./background.js"
import { LockPathTooLongError } from "./lock.js"

function fakeChild(pid: number = process.pid) {
  return {
    pid,
    unref: () => {},
    kill: killMock,
  }
}

describe("spawnBackgroundSave orphan-child cleanup on post-spawn throw", () => {
  beforeEach(() => {
    spawnMock.mockReset()
    execFileSyncMock.mockReset()
    execFileSyncMock.mockImplementation(() => "/mock/bin/claude\n")
    tryAcquireMock.mockReset()
    killMock.mockReset()
    killMock.mockImplementation(() => true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("kills the spawned child when tryAcquireSessionLock throws an unclassified syscall error", () => {
    // ENOSPC stands in for any post-spawn lock-write failure the lock
    // layer does NOT classify. ENAMETOOLONG / darwin ENOENT are
    // reclassified to `LockPathTooLongError` inside
    // `tryAcquireSessionLock` (issue #485) and exercise a dedicated
    // catch branch in `spawnBackgroundSave`; ENOSPC and other
    // unclassified errors fall through to the outer `spawn-error` path.
    const enospc = Object.assign(new Error("ENOSPC"), {
      code: "ENOSPC",
    })
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child)
    tryAcquireMock.mockImplementationOnce(() => {
      throw enospc
    })

    const result = spawnBackgroundSave("/tmp", "prompt", "any-session-id")

    expect(result.kind).toBe("spawn-error")
    if (result.kind === "spawn-error") {
      expect(result.error).toBe(enospc)
    }
    expect(killMock).toHaveBeenCalledTimes(1)
    expect(killMock).toHaveBeenCalledWith("SIGTERM")
  })

  it("does not kill the child when tryAcquireSessionLock succeeded", () => {
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child)
    tryAcquireMock.mockReturnValueOnce("/tmp/state/foo.lock")

    const result = spawnBackgroundSave("/tmp", "prompt", "session-ok")

    expect(result.kind).toBe("spawned")
    expect(killMock).not.toHaveBeenCalled()
  })

  it("kills the child when spawn returned no PID", () => {
    const childWithoutPid = {
      ...fakeChild(),
      pid: undefined as unknown as number,
    }
    spawnMock.mockReturnValueOnce(childWithoutPid)

    const result = spawnBackgroundSave("/tmp", "prompt", "session-no-pid")

    expect(result.kind).toBe("spawn-error")
    expect(killMock).toHaveBeenCalledWith("SIGTERM")
    expect(tryAcquireMock).not.toHaveBeenCalled()
  })
})

describe("spawnBackgroundSave LockPathTooLongError mapping (#485)", () => {
  let stderrSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    spawnMock.mockReset()
    execFileSyncMock.mockReset()
    execFileSyncMock.mockImplementation(() => "/mock/bin/claude\n")
    tryAcquireMock.mockReset()
    killMock.mockReset()
    killMock.mockImplementation(() => true)
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true) as unknown as ReturnType<typeof vi.fn>
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("maps LockPathTooLongError to a non-benign lock-path-too-long SpawnResult", () => {
    // The classified throw is what lets digest-scheduler / CLI / autosave
    // paths distinguish the genuine path-too-long failure from a
    // peer-active race. Without this mapping, the path-too-long case
    // would fall through to the generic `spawn-error` branch — which
    // wouldn't be wrong, but would lose the structured `code` and
    // `lockKey` fields that downstream operators need.
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child)
    tryAcquireMock.mockImplementationOnce(() => {
      throw new LockPathTooLongError("hostile-session", "ENAMETOOLONG")
    })

    const result = spawnBackgroundSave("/tmp", "prompt", "hostile-session")

    expect(result.kind).toBe("lock-path-too-long")
    if (result.kind === "lock-path-too-long") {
      expect(result.code).toBe("ENAMETOOLONG")
      expect(result.lockKey).toBe("hostile-session")
    }
    // The detached child must be killed — leaving it running would
    // silently spend `claude -p` tokens with no lock to track it.
    expect(killMock).toHaveBeenCalledTimes(1)
    expect(killMock).toHaveBeenCalledWith("SIGTERM")
  })

  it("emits a logLabel-aware stderr warning (default 'background save' label)", () => {
    // Pre-#485 the warning lived inside lock.ts and was hardcoded to
    // `[lore] autosave: ...`. The digest path uses the same lock layer
    // but is rendered as `[lore] digest: ...` everywhere else; emitting
    // an "autosave" label on a digest spawn was the load-bearing bug
    // the reviewer flagged.
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child)
    tryAcquireMock.mockImplementationOnce(() => {
      throw new LockPathTooLongError("session", "ENAMETOOLONG")
    })

    spawnBackgroundSave("/tmp", "prompt", "session")

    const calls = stderrSpy.mock.calls
      .map(([msg]) => msg)
      .filter((msg): msg is string => typeof msg === "string")
    const warning = calls.find((msg) => msg.includes("lock path too long"))
    expect(warning).toBeDefined()
    expect(warning).toContain("[lore] background save:")
    expect(warning).toContain("ENAMETOOLONG")
    // Action knob must be the one operators can change.
    expect(warning).toContain("LORE_HOOK_STATE_DIR")
  })

  it("emits a logLabel-aware stderr warning under a custom logLabel (digest)", () => {
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child)
    tryAcquireMock.mockImplementationOnce(() => {
      throw new LockPathTooLongError("digest-Mail", "ENAMETOOLONG")
    })

    spawnBackgroundSave("/tmp", "prompt", "digest-Mail", { logLabel: "digest" })

    const calls = stderrSpy.mock.calls
      .map(([msg]) => msg)
      .filter((msg): msg is string => typeof msg === "string")
    const warning = calls.find((msg) => msg.includes("lock path too long"))
    expect(warning).toBeDefined()
    expect(warning).toContain("[lore] digest:")
    // The lockKey echoes through so an operator can distinguish digest
    // from autosave warnings even without the prefix.
    expect(warning).toContain("digest-Mail")
  })

  it("truncates a multi-kilobyte lockKey in the stderr warning", () => {
    // Same hostile-payload defense as the previous lock.ts implementation:
    // a 50KB lockKey must not produce a 50KB stderr line. Bound the
    // observable warning so log-pipeline tooling stays well-behaved.
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child)
    const huge = "x".repeat(50_000)
    tryAcquireMock.mockImplementationOnce(() => {
      throw new LockPathTooLongError(huge, "ENAMETOOLONG")
    })

    spawnBackgroundSave("/tmp", "prompt", "hostile")

    const calls = stderrSpy.mock.calls
      .map(([msg]) => msg)
      .filter((msg): msg is string => typeof msg === "string")
    const warning = calls.find((msg) => msg.includes("lock path too long"))
    expect(warning).toBeDefined()
    expect(warning!.length).toBeLessThan(1_000)
    // Truncation marker confirms preview was clipped, not just that the
    // warning happens to be short. ASCII `...` rather than U+2026 so log
    // aggregators expecting a pure-ASCII stream stay clean (R1 small note).
    expect(warning).toContain("...")
  })

  it("propagates the ENOENT code variant through the SpawnResult", () => {
    // The darwin ENOENT-via-segment variant is reclassified by the lock
    // layer with `code: "ENOENT"`. The caller must see that distinction
    // so a future operator-facing surface (e.g. `lore status`) can
    // disambiguate the platform path.
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child)
    tryAcquireMock.mockImplementationOnce(() => {
      throw new LockPathTooLongError("darwin-session", "ENOENT")
    })

    const result = spawnBackgroundSave("/tmp", "prompt", "darwin-session")

    expect(result.kind).toBe("lock-path-too-long")
    if (result.kind === "lock-path-too-long") {
      expect(result.code).toBe("ENOENT")
    }
  })
})
