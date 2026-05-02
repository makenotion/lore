/**
 * Tests for the post-spawn-throw cleanup contract in
 * `spawnBackgroundSave`.
 *
 * The specific path-sanitization fix caps lock/log filename segments so
 * pathological session keys do not throw `ENAMETOOLONG` after the child
 * process has already spawned. This suite pins the broader invariant:
 * if any post-spawn pre-lock failure still happens, the detached child is
 * killed before `spawn-error` is returned.
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

  it("kills the spawned child when tryAcquireSessionLock throws", () => {
    const enametoolong = Object.assign(new Error("ENAMETOOLONG"), {
      code: "ENAMETOOLONG",
    })
    const child = fakeChild()
    spawnMock.mockReturnValueOnce(child)
    tryAcquireMock.mockImplementationOnce(() => {
      throw enametoolong
    })

    const result = spawnBackgroundSave("/tmp", "prompt", "any-session-id")

    expect(result.kind).toBe("spawn-error")
    if (result.kind === "spawn-error") {
      expect(result.error).toBe(enametoolong)
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
