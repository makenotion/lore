import { describe, expect, it, afterAll } from "vitest"
import { rm, utimes } from "node:fs/promises"
import {
  clearDigestMarker,
  digestMarkerAgeDays,
  digestMarkerPath,
  touchDigestMarker,
} from "./digest-marker.js"

// Each test uses a unique project name so the tests are isolated without
// touching TMPDIR (which is read at module-load time in digest-marker.ts).
const TEST_MARKERS: Array<{ configRoot: string; name: string }> = []
function uniqueProject(label: string): { configRoot: string; name: string } {
  const name = `lore-marker-test-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  const entry = { configRoot: "/tmp/test-config-root-" + label, name }
  TEST_MARKERS.push(entry)
  return entry
}

afterAll(async () => {
  await Promise.all(
    TEST_MARKERS.map(({ configRoot, name }) =>
      rm(digestMarkerPath(configRoot, name), { force: true }),
    ),
  )
})

describe("digest-marker", () => {
  it("returns Infinity for a missing marker so callers treat first runs as stale", async () => {
    const { configRoot, name } = uniqueProject("missing")
    const age = await digestMarkerAgeDays(configRoot, name)
    expect(age).toBe(Infinity)
  })

  it("sanitizes project names with slashes / spaces into safe filenames", () => {
    const path = digestMarkerPath("/root-a", "My Project/Backend")
    expect(path).toContain("My_Project_Backend.last")
  })

  it("keys the marker on a configRoot hash so two vaults with the same project name do not collide", () => {
    const a = digestMarkerPath("/vault-a", "Mail")
    const b = digestMarkerPath("/vault-b", "Mail")
    expect(a).not.toBe(b)
  })

  it("touchDigestMarker creates then refreshes mtime", async () => {
    const { configRoot, name } = uniqueProject("refresh")
    await touchDigestMarker(configRoot, name)
    const initial = await digestMarkerAgeDays(configRoot, name)
    expect(initial).toBeLessThan(1)

    const past = new Date(Date.now() - 10 * 86_400_000)
    await utimes(digestMarkerPath(configRoot, name), past, past)
    const aged = await digestMarkerAgeDays(configRoot, name)
    expect(aged).toBeGreaterThanOrEqual(9)

    await touchDigestMarker(configRoot, name)
    const refreshed = await digestMarkerAgeDays(configRoot, name)
    expect(refreshed).toBeLessThan(1)
  })

  it("clearDigestMarker removes the marker so callers can roll back an optimistic touch", async () => {
    const { configRoot, name } = uniqueProject("rollback")
    await touchDigestMarker(configRoot, name)
    expect(await digestMarkerAgeDays(configRoot, name)).toBeLessThan(1)

    await clearDigestMarker(configRoot, name)
    expect(await digestMarkerAgeDays(configRoot, name)).toBe(Infinity)
  })

  it("clearDigestMarker is a no-op when the marker is already absent", async () => {
    const { configRoot, name } = uniqueProject("already-gone")
    await expect(clearDigestMarker(configRoot, name)).resolves.toBeUndefined()
  })
})
