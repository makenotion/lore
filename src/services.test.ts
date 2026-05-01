import { describe, expect, it, afterAll, afterEach, vi } from "vitest"
import { rm, writeFile } from "node:fs/promises"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Same isolation hoist as digest-marker.test.ts and drift-marker.test.ts.
// The env override has to land before `getStateDir` resolves, and
// `resolveDriftCheck` reaches into the filesystem via `driftMarkerAgeDays`
// / `touchDriftMarker`.
vi.hoisted(() => {
  process.env["LORE_HOOK_STATE_DIR"] =
    `${process.env["TMPDIR"] ?? "/tmp"}/lore-services-test-${process.pid}-${Date.now()}`
})

// Mock config.js so initServices' loadConfig / findConfigFile calls
// route through controllable stubs. The resolveDriftCheck tests don't
// touch these, so the mock is inert for that block.
vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js")
  return {
    ...actual,
    findConfigFile: vi.fn(actual.findConfigFile),
    loadConfig: vi.fn(actual.loadConfig),
  }
})

import { resolveDriftCheck } from "./services.js"
import { findConfigFile, loadConfig } from "./config.js"
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

describe("initServices — LORE_CONFIG_ROOT honor (issue 0.10.0/08)", () => {
  // The MCP-entry env-forwarding rewrite (#08) writes
  // `LORE_CONFIG_ROOT=<path>` into the spawned MCP child's env so the
  // child resolves the right `.lore.yaml` even when its launch cwd
  // differs from the operator's vault directory. `initServices` honors
  // the env var by short-circuiting the upward findConfigFile walk.
  //
  // The downstream `initServicesFromConfig` call would talk to
  // Notion; tests stop short of that by making `loadConfig` throw a
  // sentinel error that proves which branch fired.

  const SCRATCH = mkdtempSync(join(tmpdir(), "lore-services-config-root-"))

  afterEach(() => {
    delete process.env["LORE_CONFIG_ROOT"]
    vi.mocked(findConfigFile).mockReset()
    vi.mocked(loadConfig).mockReset()
  })

  afterAll(async () => {
    await rm(SCRATCH, { recursive: true, force: true })
  })

  it("loads `.lore.yaml` from LORE_CONFIG_ROOT when set, bypassing the upward walk", async () => {
    const root = mkdtempSync(join(SCRATCH, "configroot-set-"))
    // Land a real `.lore.yaml` so the access() guard passes and the
    // call reaches the mocked loadConfig. Content is irrelevant —
    // the sentinel error throws before parse.
    await writeFile(join(root, ".lore.yaml"), "vault:\n  pageId: x\n", "utf-8")
    process.env["LORE_CONFIG_ROOT"] = root

    // Sentinel error from loadConfig proves the env-var branch fired
    // and routed through the configRoot path. findConfigFile must
    // NOT be called on this branch.
    vi.mocked(loadConfig).mockRejectedValue(new Error("sentinel-loadConfig-called"))

    const services = await import("./services.js")
    await expect(services.initServices("/tmp/some/unrelated/cwd")).rejects.toThrow(
      /sentinel-loadConfig-called/,
    )
    expect(loadConfig).toHaveBeenCalledWith(join(root, ".lore.yaml"))
    expect(findConfigFile).not.toHaveBeenCalled()
  })

  it("falls back to the upward findConfigFile walk when LORE_CONFIG_ROOT is unset", async () => {
    const workDir = mkdtempSync(join(SCRATCH, "no-config-"))
    // Simulate the walk landing on a config file (any path); the
    // sentinel from loadConfig proves the walk-then-load path fired.
    vi.mocked(findConfigFile).mockResolvedValue({
      path: join(workDir, ".lore.yaml"),
      root: workDir,
    })
    vi.mocked(loadConfig).mockRejectedValue(new Error("sentinel-fallback-fired"))

    const services = await import("./services.js")
    await expect(services.initServices(workDir)).rejects.toThrow(/sentinel-fallback-fired/)
    expect(findConfigFile).toHaveBeenCalledWith(workDir)
    expect(loadConfig).toHaveBeenCalledWith(join(workDir, ".lore.yaml"))
  })

  it("throws the No-.lore.yaml-found error when neither path resolves", async () => {
    vi.mocked(findConfigFile).mockResolvedValue(null)
    const services = await import("./services.js")
    await expect(services.initServices("/tmp/no-config")).rejects.toThrow(
      /No \.lore\.yaml found/,
    )
  })

  it("treats whitespace-only LORE_CONFIG_ROOT as unset and falls back to upward search", async () => {
    // A shell-rc misconfiguration like `export LORE_CONFIG_ROOT="   "`
    // is truthy in Node and would slip past a bare `if (envVar)` gate,
    // landing `resolve("   ")` which produces cwd-prefix garbage. The
    // trim guard normalizes that to "fall back to findConfigFile".
    process.env["LORE_CONFIG_ROOT"] = "   "
    vi.mocked(findConfigFile).mockResolvedValue({
      path: "/tmp/fallback-after-trim/.lore.yaml",
      root: "/tmp/fallback-after-trim",
    })
    vi.mocked(loadConfig).mockRejectedValue(new Error("sentinel-fallback-took"))

    const services = await import("./services.js")
    await expect(services.initServices("/tmp/fallback-after-trim")).rejects.toThrow(
      /sentinel-fallback-took/,
    )
    expect(findConfigFile).toHaveBeenCalledWith("/tmp/fallback-after-trim")
  })

  it("surfaces a friendly error when LORE_CONFIG_ROOT points at a directory that lacks .lore.yaml", async () => {
    // The MCP entry's static forwarding can drift from the
    // operator's vault directory when they move or rename the
    // project. Without this check, `loadConfig` would throw a raw
    // `ENOENT` that the host renders as a confusing error. The
    // friendly variant tells the operator the recovery is
    // `lore install` from the project directory (or unset the
    // env var).
    const root = mkdtempSync(join(SCRATCH, "no-config-here-"))
    process.env["LORE_CONFIG_ROOT"] = root

    const services = await import("./services.js")
    await expect(services.initServices("/tmp/some/other/cwd")).rejects.toThrow(
      /LORE_CONFIG_ROOT=.* but no \.lore\.yaml exists there/,
    )
    expect(loadConfig).not.toHaveBeenCalled()
  })
})
