import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe("withAutosaveLearningLock", () => {
  let stateDir: string

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "lore-autosave-lock-"))
    vi.stubEnv("LORE_HOOK_STATE_DIR", stateDir)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
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

  it("serializes a storm of contenders for the same learning key", async () => {
    let active = 0
    let maxActive = 0
    const completed: number[] = []

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        withAutosaveLearningLock("storm-key", async () => {
          active += 1
          try {
            maxActive = Math.max(maxActive, active)
            expect(active).toBe(1)
            await delay(5)
            completed.push(index)
            return index
          } finally {
            active -= 1
          }
        })
      )
    )

    expect(results).toHaveLength(10)
    expect(new Set(completed).size).toBe(10)
    expect(maxActive).toBe(1)
  })

  it("uses wall-clock time for contender creation timestamps", async () => {
    const createdAt = 1_725_000_000_123
    let calls = 0
    vi.spyOn(Date, "now").mockImplementation(() =>
      calls++ === 0 ? createdAt : createdAt + 1
    )

    await withAutosaveLearningLock("clock-key", async () => {
      const dir = __autosaveLearningLockPathForTests("clock-key")
      const contenders = readdirSync(dir).filter((name) => name.endsWith(".json"))
      expect(contenders).toHaveLength(1)
      const record = JSON.parse(readFileSync(join(dir, contenders[0]!), "utf-8")) as {
        createdAt: number
      }
      expect(record.createdAt).toBe(createdAt)
    })
  })

  it("samples contender creation time after the contender file is visible", async () => {
    const createdAt = 1_725_000_000_123
    const dir = __autosaveLearningLockPathForTests("visibility-key")
    let firstNow = true
    vi.spyOn(Date, "now").mockImplementation(() => {
      if (firstNow) {
        firstNow = false
        expect(readdirSync(dir).filter((name) => name.endsWith(".json"))).toHaveLength(1)
        return createdAt
      }
      return createdAt + 1
    })

    await withAutosaveLearningLock("visibility-key", async () => {
      const contenders = readdirSync(dir).filter((name) => name.endsWith(".json"))
      expect(contenders).toHaveLength(1)
      const record = JSON.parse(readFileSync(join(dir, contenders[0]!), "utf-8")) as {
        createdAt: number
      }
      expect(record.createdAt).toBe(createdAt)
    })
  })

  it("waits behind a fresh contender that has not finalized its timestamp", async () => {
    const dir = __autosaveLearningLockPathForTests("placeholder-key")
    mkdirSync(dir, { recursive: true })
    const placeholderPath = join(dir, "placeholder.json")
    writeFileSync(placeholderPath, "", { mode: 0o600 })

    let entered = false
    const waiter = withAutosaveLearningLock("placeholder-key", async () => {
      entered = true
      return "waiter"
    })

    await delay(120)
    expect(entered).toBe(false)
    expect(existsSync(placeholderPath)).toBe(true)

    unlinkSync(placeholderPath)
    await expect(waiter).resolves.toBe("waiter")
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
