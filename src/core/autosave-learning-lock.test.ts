import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { dirname, join } from "node:path"
import { tmpdir } from "node:os"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __autosaveLearningLockPathForTests,
  withAutosaveLearningLock,
} from "./autosave-learning-lock.js"

function writeLock(path: string, pid: number, createdAt = Date.now()): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify({
      token: `token-${createdAt}`,
      pid,
      createdAt,
    }),
    { mode: 0o600 }
  )
}

describe("withAutosaveLearningLock", () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "lore-autosave-lock-"))
    vi.stubEnv("LORE_HOOK_STATE_DIR", stateDir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(stateDir, { recursive: true, force: true })
  })

  it("serializes callers for the same learning key", async () => {
    let releaseFirst: () => void = () => undefined
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstEntered: () => void = () => undefined
    const firstEnteredPromise = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    let secondEntered = false

    const first = withAutosaveLearningLock("same-key", async () => {
      firstEntered()
      await firstRelease
      return "first"
    })
    await firstEnteredPromise

    const second = withAutosaveLearningLock("same-key", async () => {
      secondEntered = true
      return "second"
    })

    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(secondEntered).toBe(false)
    releaseFirst()

    await expect(Promise.all([first, second])).resolves.toEqual(["first", "second"])
    expect(secondEntered).toBe(true)
  })

  it("takes over a stale dead-process lock", async () => {
    const dir = __autosaveLearningLockPathForTests("stale-key")
    const path = join(dir, "stale.json")
    const staleTime = new Date(Date.now() - 20 * 60 * 1000)
    writeLock(path, 999_999_999, staleTime.getTime())
    utimesSync(path, staleTime, staleTime)

    await expect(
      withAutosaveLearningLock("stale-key", async () => {
        expect(existsSync(path)).toBe(false)
        return "created"
      })
    ).resolves.toBe("created")
    expect(existsSync(path)).toBe(false)
  })

  it("does not delete a fresh holder when stale contenders exist", async () => {
    const dir = __autosaveLearningLockPathForTests("cleanup-key")
    const stalePath = join(dir, "stale.json")
    const freshPath = join(dir, "fresh.json")
    const staleTime = new Date(Date.now() - 20 * 60 * 1000)
    writeLock(stalePath, 999_999_999, staleTime.getTime())
    utimesSync(stalePath, staleTime, staleTime)
    writeLock(freshPath, process.pid, Date.now() - 1000)

    let entered = false
    const waiter = withAutosaveLearningLock("cleanup-key", async () => {
      entered = true
      return "waiter"
    })

    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(entered).toBe(false)
    expect(existsSync(freshPath)).toBe(true)

    unlinkSync(freshPath)
    await expect(waiter).resolves.toBe("waiter")
  })
})
