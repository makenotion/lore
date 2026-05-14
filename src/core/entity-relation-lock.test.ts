import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  __entityRelationLockPathForTests,
  __removeStaleEntityRelationLockForTests,
  withEntityRelationLocks,
} from "./entity-relation-lock.js"

let stateDir: string

beforeEach(() => {
  stateDir = mkdtempSync(join(process.env["TMPDIR"] ?? "/tmp", "lore-entity-lock-test-"))
  vi.stubEnv("HOME", stateDir)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
  rmSync(stateDir, { recursive: true, force: true })
})

describe("withEntityRelationLocks", () => {
  it("serializes callers for the same entity id", async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = withEntityRelationLocks(["ent-a"], async () => {
      order.push("first-start")
      await firstRelease
      order.push("first-end")
    })
    await vi.waitFor(() => {
      expect(order).toEqual(["first-start"])
    })

    const second = withEntityRelationLocks(["ent-a"], async () => {
      order.push("second-start")
    })
    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(order).toEqual(["first-start"])

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second-start"])
  })

  it("normalizes hyphenated and compact Notion id forms to the same lock", async () => {
    const compact = "0123456789abcdef0123456789abcdef"
    const hyphenated = "01234567-89ab-cdef-0123-456789abcdef"
    expect(__entityRelationLockPathForTests(hyphenated)).toBe(
      __entityRelationLockPathForTests(compact)
    )

    const order: string[] = []
    let releaseFirst!: () => void
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = withEntityRelationLocks([hyphenated], async () => {
      order.push("first-start")
      await firstRelease
      order.push("first-end")
    })
    await vi.waitFor(() => {
      expect(order).toEqual(["first-start"])
    })

    const second = withEntityRelationLocks([compact], async () => {
      order.push("second-start")
    })
    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(order).toEqual(["first-start"])

    releaseFirst()
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second-start"])
  })

  it("dedupes normalized duplicate ids before acquiring locks", async () => {
    const compact = "0123456789abcdef0123456789abcdef"
    const hyphenated = "01234567-89ab-cdef-0123-456789abcdef"

    await expect(
      withEntityRelationLocks([compact, hyphenated], async () => "ok")
    ).resolves.toBe("ok")
  })

  it("does not steal an old lock whose owner pid is still alive", async () => {
    vi.useFakeTimers()
    const path = __entityRelationLockPathForTests("ent-live")
    mkdirSync(join(stateDir, ".lore", "entity-relation-locks"), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        token: "token",
        pid: process.pid,
        createdAt: Date.now() - 20 * 60 * 1000,
      })
    )

    __removeStaleEntityRelationLockForTests(path)

    expect(existsSync(path)).toBe(true)
  })

  it("removes a stale live-pid lock whose heartbeat stopped", () => {
    const path = __entityRelationLockPathForTests("ent-reused-pid")
    mkdirSync(join(stateDir, ".lore", "entity-relation-locks"), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        token: "token",
        pid: process.pid,
        createdAt: Date.now() - 20 * 60 * 1000,
      })
    )
    const old = new Date(Date.now() - 20 * 60 * 1000)
    utimesSync(path, old, old)

    __removeStaleEntityRelationLockForTests(path)

    expect(existsSync(path)).toBe(false)
  })

  it("removes an old lock whose owner pid is dead", () => {
    const path = __entityRelationLockPathForTests("ent-dead")
    mkdirSync(join(stateDir, ".lore", "entity-relation-locks"), { recursive: true })
    writeFileSync(
      path,
      JSON.stringify({
        token: "token",
        pid: 9_999_999,
        createdAt: Date.now() - 20 * 60 * 1000,
      })
    )

    __removeStaleEntityRelationLockForTests(path)

    expect(existsSync(path)).toBe(false)
  })

  it("waits on a fresh malformed lock instead of deleting it immediately", () => {
    const lockRoot = join(stateDir, ".lore", "entity-relation-locks")
    mkdirSync(lockRoot, { recursive: true })
    const path = __entityRelationLockPathForTests("ent-malformed")
    writeFileSync(path, "{", { flag: "w" })

    __removeStaleEntityRelationLockForTests(path)

    expect(existsSync(path)).toBe(true)
  })

  it("removes an old malformed lock", () => {
    const lockRoot = join(stateDir, ".lore", "entity-relation-locks")
    mkdirSync(lockRoot, { recursive: true })
    const path = __entityRelationLockPathForTests("ent-malformed-old")
    writeFileSync(path, "{", { flag: "w" })
    const old = new Date(Date.now() - 20 * 60 * 1000)
    utimesSync(path, old, old)

    __removeStaleEntityRelationLockForTests(path)

    expect(existsSync(path)).toBe(false)
  })
})
