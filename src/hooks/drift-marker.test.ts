import { describe, expect, it, afterAll, vi } from "vitest"
import { rm, stat, utimes } from "node:fs/promises"

// Same isolation hoist as digest-marker.test.ts: the env override has to
// land before `getStateDir` resolves on first import. `getStateDir`
// re-reads the env var on every call so the override flows through to
// downstream callers.
vi.hoisted(() => {
  process.env["LORE_HOOK_STATE_DIR"] =
    `${process.env["TMPDIR"] ?? "/tmp"}/lore-drift-marker-test-${process.pid}-${Date.now()}`
})

import {
  DRIFT_DEBOUNCE_DAYS,
  driftMarkerAgeDays,
  driftMarkerPath,
  touchDriftMarker,
} from "./drift-marker.js"
import { getStateDir } from "./lock.js"
import { HOOK_STATE_DIR_MODE, HOOK_STATE_FILE_MODE } from "./marker-key.js"

function modeBits(mode: number): number {
  return mode & 0o777
}

async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
  const previous = process.umask(mask)
  try {
    return await fn()
  } finally {
    process.umask(previous)
  }
}

const TEST_MARKERS: string[] = []
function uniqueRoot(label: string): string {
  const root = `/tmp/test-drift-config-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  TEST_MARKERS.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(
    TEST_MARKERS.map((root) => rm(driftMarkerPath(root), { force: true }))
  )
})

describe("drift-marker", () => {
  it("returns Infinity for a missing marker so first runs always trigger drift", async () => {
    const root = uniqueRoot("missing")
    expect(await driftMarkerAgeDays(root)).toBe(Infinity)
  })

  it("keys the marker on a configRoot hash so two worktrees of the same vault share suppression", () => {
    // The risk note in 0.6.0 issue 02 explicitly calls for worktree
    // sharing — without it, every parallel worktree would rediscover
    // drift independently and the debounce would be useless for stacked
    // PR work. Two roots produce two distinct marker paths, but two
    // calls with the same root produce identical paths.
    const a = driftMarkerPath("/repo/main")
    const b = driftMarkerPath("/repo/feature")
    const aTwice = driftMarkerPath("/repo/main")
    expect(a).not.toBe(b)
    expect(a).toBe(aTwice)
  })

  it("touchDriftMarker creates the marker, then refreshes mtime on subsequent calls", async () => {
    const root = uniqueRoot("refresh")
    await touchDriftMarker(root)
    const initial = await driftMarkerAgeDays(root)
    expect(initial).toBeLessThan(1)

    // Backdate via utimes so we can prove a follow-up touch resets mtime.
    const past = new Date(Date.now() - 10 * 86_400_000)
    await utimes(driftMarkerPath(root), past, past)
    const aged = await driftMarkerAgeDays(root)
    expect(aged).toBeGreaterThanOrEqual(9)

    await touchDriftMarker(root)
    const refreshed = await driftMarkerAgeDays(root)
    expect(refreshed).toBeLessThan(1)
  })

  it("touchDriftMarker creates the state dir if it does not exist yet", async () => {
    const root = uniqueRoot("mkdir")
    const stateDir = getStateDir()
    await rm(stateDir, { recursive: true, force: true })
    await expect(touchDriftMarker(root)).resolves.toBeUndefined()
    await expect(stat(stateDir)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    })
  })

  it("creates the state dir and marker file private even under umask 000", async () => {
    const root = uniqueRoot("mode")
    const stateDir = getStateDir()
    await rm(stateDir, { recursive: true, force: true })

    await withUmask(0o000, async () => {
      await touchDriftMarker(root)
    })

    expect(modeBits((await stat(stateDir)).mode)).toBe(HOOK_STATE_DIR_MODE)
    expect(modeBits((await stat(driftMarkerPath(root))).mode)).toBe(HOOK_STATE_FILE_MODE)
  })

  it("DRIFT_DEBOUNCE_DAYS matches the auto-digest cadence so the two filesystem markers behave the same", () => {
    // Pin the value so a future change becomes a deliberate edit, not a
    // silent one-line tweak. 7d is long enough that hot-path callers
    // don't pay the drift tax on every fire and short enough that a
    // schema-extending change still surfaces within one workweek.
    expect(DRIFT_DEBOUNCE_DAYS).toBe(7)
  })
})
