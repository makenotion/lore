import { describe, expect, it, afterAll, vi } from "vitest"
import { rm } from "node:fs/promises"

// Same isolation hoist as digest-marker.test.ts and drift-marker.test.ts.
// The env override has to land before `getStateDir` resolves, and
// `resolveDriftCheck` reaches into the filesystem via `driftMarkerAgeDays`
// / `touchDriftMarker`.
vi.hoisted(() => {
  process.env["LORE_HOOK_STATE_DIR"] =
    `${process.env["TMPDIR"] ?? "/tmp"}/lore-services-test-${process.pid}-${Date.now()}`
})

import { resolveDriftCheck } from "./services.js"
import {
  driftMarkerPath,
  driftMarkerAgeDays,
  touchDriftMarker,
} from "./hooks/drift-marker.js"

const TEST_ROOTS: string[] = []
function uniqueRoot(label: string): string {
  const root = `/tmp/test-services-drift-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  TEST_ROOTS.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(
    TEST_ROOTS.map((root) => rm(driftMarkerPath(root), { force: true })),
  )
})

describe("resolveDriftCheck", () => {
  it("returns false when mode is undefined and never consults the marker", async () => {
    // Default behavior — narrow CLI surfaces (search / mine / digest) and
    // any caller that omits the option should NOT pay the drift tax. The
    // marker stays untouched so the next "debounced" caller still sees
    // its own freshness state.
    const root = uniqueRoot("undefined")
    expect(await resolveDriftCheck(root, undefined)).toBe(false)
    expect(await driftMarkerAgeDays(root)).toBe(Infinity)
  })

  it("returns false when mode is explicit false and never consults the marker", async () => {
    const root = uniqueRoot("explicit-false")
    expect(await resolveDriftCheck(root, false)).toBe(false)
    expect(await driftMarkerAgeDays(root)).toBe(Infinity)
  })

  it("returns true when mode is explicit true; marker is touched so a concurrent debounced caller skips", async () => {
    // Precedence rule: explicit true wins over the marker. Marker is
    // touched as a side-effect so a sibling debounced caller starting
    // right after this one doesn't redo the same scan.
    const root = uniqueRoot("explicit-true")
    expect(await resolveDriftCheck(root, true)).toBe(true)
    const age = await driftMarkerAgeDays(root)
    expect(age).toBeLessThan(1)
  })

  it("returns true when mode is debounced and the marker is stale (Infinity = missing)", async () => {
    const root = uniqueRoot("debounced-stale")
    // No prior marker → age=Infinity → must fire.
    expect(await driftMarkerAgeDays(root)).toBe(Infinity)
    expect(await resolveDriftCheck(root, "debounced")).toBe(true)
    // Marker is now fresh — proves the debounced path touches before
    // returning so concurrent siblings see fresh state.
    const age = await driftMarkerAgeDays(root)
    expect(age).toBeLessThan(1)
  })

  it("returns false when mode is debounced and the marker is fresh", async () => {
    const root = uniqueRoot("debounced-fresh")
    // Pre-touch so the marker is < DRIFT_DEBOUNCE_DAYS old.
    await touchDriftMarker(root)
    expect(await resolveDriftCheck(root, "debounced")).toBe(false)
  })
})
