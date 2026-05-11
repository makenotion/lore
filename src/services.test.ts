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

const serviceClientUsersMe = vi.hoisted(() => vi.fn())

// Mock config.js so initServices' loadConfig / findConfigFile calls
// route through controllable stubs. The resolveDriftCheck tests don't
// touch these, so the mock is inert for that block.
vi.mock("./config.js", async () => {
  const actual = await vi.importActual<typeof import("./config.js")>("./config.js")
  return {
    ...actual,
    findConfigFile: vi.fn(actual.findConfigFile),
    loadConfig: vi.fn(actual.loadConfig),
    resolveAuth: vi.fn(actual.resolveAuth),
  }
})

vi.mock("./notion/client.js", async () => {
  const actual =
    await vi.importActual<typeof import("./notion/client.js")>("./notion/client.js")
  return {
    ...actual,
    createClient: vi.fn(() => ({ users: { me: serviceClientUsersMe } })),
  }
})

vi.mock("./core/context.js", async () => {
  const actual =
    await vi.importActual<typeof import("./core/context.js")>("./core/context.js")
  return {
    ...actual,
    resolveProject: vi.fn(async () => ({
      project: null,
      isCatchAllFallback: false,
      candidates: [],
    })),
  }
})

import {
  AUTH_REFRESH_UNAVAILABLE_CACHE_MS,
  createNtnAuthRefresh,
  deriveRelationUrlBase,
  initServicesFromConfig,
  resolveDriftCheck,
  resolveRunToolBatchCreatesFlag,
} from "./services.js"
import { findConfigFile, loadConfig, resolveAuth } from "./config.js"
import { resolveProject } from "./core/context.js"
import { VaultManager } from "./core/vault.js"
import {
  driftMarkerPath,
  driftMarkerAgeDays,
  touchDriftMarker,
} from "./hooks/drift-marker.js"
import type { LoreConfig, Vault } from "./types.js"

const TEST_ROOTS: string[] = []
function uniqueRoot(label: string): string {
  const root = `/tmp/test-services-drift-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`
  TEST_ROOTS.push(root)
  return root
}

afterAll(async () => {
  await Promise.all(TEST_ROOTS.map((root) => rm(driftMarkerPath(root), { force: true })))
})

describe("deriveRelationUrlBase (PR #538 live-verification host-coupling)", () => {
  // Empirical findings from PR #538 live verification: the server
  // validates the relation URL host against the workspace's
  // user-facing domain and rejects mismatches with
  // `400 validation_error: Invalid page URL`. Each test below
  // captures one of the live-verified cases so a future
  // contributor cannot hardcode a default that silently breaks
  // either environment.
  it("api-dev.notion.com → dev.notion.so (verified live against internal vault)", () => {
    expect(deriveRelationUrlBase("https://api-dev.notion.com")).toBe(
      "https://dev.notion.so/"
    )
  })

  it("default API host (undefined) → www.notion.so (production default)", () => {
    expect(deriveRelationUrlBase(undefined)).toBe("https://www.notion.so/")
  })

  it("api.notion.com → www.notion.so", () => {
    expect(deriveRelationUrlBase("https://api.notion.com")).toBe(
      "https://www.notion.so/"
    )
  })

  it("unknown / custom hosts fall back to www.notion.so", () => {
    // Operators on bespoke configurations who need a different
    // mapping must override `auth.baseUrl` to a recognized host.
    expect(deriveRelationUrlBase("https://api-staging.notion.com")).toBe(
      "https://www.notion.so/"
    )
  })

  it("case-insensitive host matching (defends against shell-rc capitalization)", () => {
    expect(deriveRelationUrlBase("https://API-DEV.NOTION.COM")).toBe(
      "https://dev.notion.so/"
    )
  })
})

describe("resolveRunToolBatchCreatesFlag", () => {
  // Issue #533, hardened by PR #538 review (security S2 + principal
  // strong rec #2): the write-path sub-flag does NOT inherit from
  // the parent `LORE_USE_RUNTOOL` quarantine knob. Operators must
  // opt in explicitly with `LORE_USE_RUNTOOL_BATCH_CREATES=1`.
  // Read-path sub-flags (search / aggregate, parked under #532)
  // can keep inheriting; write-path ones must be loud because of
  // the partial-commit failure mode.
  it("defaults to false when no env vars are set", () => {
    expect(resolveRunToolBatchCreatesFlag({})).toBe(false)
  })

  it("returns true ONLY when LORE_USE_RUNTOOL_BATCH_CREATES=1", () => {
    expect(
      resolveRunToolBatchCreatesFlag({ LORE_USE_RUNTOOL_BATCH_CREATES: "1" })
    ).toBe(true)
  })

  it("does NOT inherit from LORE_USE_RUNTOOL even when the parent flag is on (S2)", () => {
    // The parent flag is a read-path quarantine knob; an operator
    // dogfooding Phase-2 search must not silently enable write-path
    // batch creates as a side-effect.
    expect(
      resolveRunToolBatchCreatesFlag({ LORE_USE_RUNTOOL: "1" })
    ).toBe(false)
  })

  it("returns false when LORE_USE_RUNTOOL_BATCH_CREATES=0 (explicit disable)", () => {
    expect(
      resolveRunToolBatchCreatesFlag({
        LORE_USE_RUNTOOL_BATCH_CREATES: "0",
        LORE_USE_RUNTOOL: "1",
      })
    ).toBe(false)
  })

  it("rejects malformed sub-flag strings (fail-loud on typos)", () => {
    // Strict-equality on `"1"`: anything else (`"true"`, `"yes"`,
    // `"on"`, leading/trailing whitespace) is treated as "off" so
    // a typo in a shell-rc never silently flips the write path.
    for (const malformed of ["true", "yes", "on", " 1", "1 ", "TRUE"]) {
      expect(
        resolveRunToolBatchCreatesFlag({
          LORE_USE_RUNTOOL_BATCH_CREATES: malformed,
        })
      ).toBe(false)
    }
  })
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
      /sentinel-loadConfig-called/
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
    await expect(services.initServices(workDir)).rejects.toThrow(
      /sentinel-fallback-fired/
    )
    expect(findConfigFile).toHaveBeenCalledWith(workDir)
    expect(loadConfig).toHaveBeenCalledWith(join(workDir, ".lore.yaml"))
  })

  it("throws the No-.lore.yaml-found error when neither path resolves", async () => {
    vi.mocked(findConfigFile).mockResolvedValue(null)
    const services = await import("./services.js")
    await expect(services.initServices("/tmp/no-config")).rejects.toThrow(
      /No \.lore\.yaml found/
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
      /sentinel-fallback-took/
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
      /LORE_CONFIG_ROOT=.* but no \.lore\.yaml exists there/
    )
    expect(loadConfig).not.toHaveBeenCalled()
  })
})

describe("initServicesFromConfig — lazy author identity", () => {
  const config = { vault: { pageId: "vault" }, projects: [] } as LoreConfig
  const databaseRef = (name: string) => ({
    databaseId: `db-${name}`,
    dataSourceId: `ds-${name}`,
  })
  const vault: Vault = {
    pageId: "vault",
    databases: {
      projects: databaseRef("projects"),
      topics: databaseRef("topics"),
      memories: databaseRef("memories"),
      facts: databaseRef("facts"),
      entities: databaseRef("entities"),
    },
  }

  afterEach(() => {
    vi.mocked(resolveAuth).mockReset()
    vi.mocked(resolveProject).mockReset()
    serviceClientUsersMe.mockReset()
  })

  it("does not call users.me during read-only service initialization", async () => {
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "init-token",
      source: "env-notion-api-token",
    })
    vi.mocked(resolveProject).mockResolvedValue({
      project: null,
      isCatchAllFallback: false,
      candidates: [],
    })
    const loadSpy = vi
      .spyOn(VaultManager.prototype, "load")
      .mockImplementation(async function (this: VaultManager) {
        ;(this as unknown as { vault: Vault }).vault = vault
        return vault
      })

    try {
      const services = await initServicesFromConfig("/tmp/cwd", "/tmp/config", config)

      expect(serviceClientUsersMe).not.toHaveBeenCalled()
      expect(services.identity.resolveAuthor).toEqual(expect.any(Function))

      await expect(services.identity.resolveAuthor()).resolves.toBeNull()
      expect(serviceClientUsersMe).toHaveBeenCalledOnce()
    } finally {
      loadSpy.mockRestore()
    }
  })
})

describe("createNtnAuthRefresh", () => {
  const config = { vault: { pageId: "vault" } } as LoreConfig
  const configRoot = "/tmp/lore-config-root"

  afterEach(() => {
    vi.mocked(resolveAuth).mockReset()
  })

  it("returns refreshed ntn auth when auth.json resolves to a changed token", async () => {
    const refresh = createNtnAuthRefresh(
      {
        token: "old-token",
        source: "ntn-auth-json",
        workspaceId: "workspace",
      },
      configRoot,
      config
    )

    vi.mocked(resolveAuth).mockResolvedValue({
      token: "new-token",
      baseUrl: "https://api-dev.notion.com",
      source: "ntn-auth-json",
      workspaceId: "workspace",
    })

    await expect(refresh?.({ token: "old-token" })).resolves.toEqual({
      kind: "refreshed",
      auth: {
        token: "new-token",
        baseUrl: "https://api-dev.notion.com",
      },
      source: "ntn-auth-json",
    })
    expect(resolveAuth).toHaveBeenCalledWith(config, configRoot)
  })

  it("returns null when ntn auth re-resolution leaves the token unchanged", async () => {
    const refresh = createNtnAuthRefresh(
      {
        token: "same-token",
        source: "ntn-auth-json",
        workspaceId: "workspace",
      },
      configRoot,
      config
    )

    vi.mocked(resolveAuth).mockResolvedValue({
      token: "same-token",
      source: "ntn-auth-json",
      workspaceId: "workspace",
    })

    await expect(refresh?.({ token: "same-token" })).resolves.toEqual({
      kind: "unchanged",
    })
  })

  it("honors a higher-priority token source when an ntn session re-resolves auth", async () => {
    const refresh = createNtnAuthRefresh(
      {
        token: "old-ntn-token",
        source: "ntn-auth-json",
        workspaceId: "workspace",
      },
      configRoot,
      config
    )

    vi.mocked(resolveAuth).mockResolvedValue({
      token: "env-token",
      source: "env-notion-api-token",
    })

    await expect(refresh?.({ token: "old-ntn-token" })).resolves.toEqual({
      kind: "refreshed",
      auth: { token: "env-token" },
      source: "env-notion-api-token",
    })
  })

  it("does not cache unchanged refresh results so re-auth can recover immediately", async () => {
    const refresh = createNtnAuthRefresh(
      {
        token: "same-token",
        source: "ntn-auth-json",
        workspaceId: "workspace",
      },
      configRoot,
      config
    )

    vi.mocked(resolveAuth).mockResolvedValue({
      token: "same-token",
      source: "ntn-auth-json",
      workspaceId: "workspace",
    })

    await expect(refresh?.({ token: "same-token" })).resolves.toEqual({
      kind: "unchanged",
    })
    await expect(refresh?.({ token: "same-token" })).resolves.toEqual({
      kind: "unchanged",
    })
    expect(resolveAuth).toHaveBeenCalledTimes(2)
  })

  it("negative-caches unavailable refresh results briefly for the same current auth", async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date("2026-05-02T12:00:00.000Z"))
      const refresh = createNtnAuthRefresh(
        {
          token: "same-token",
          source: "ntn-auth-json",
          workspaceId: "workspace",
        },
        configRoot,
        config
      )

      vi.mocked(resolveAuth).mockRejectedValue(new Error("auth unavailable"))

      await expect(refresh?.({ token: "same-token" })).resolves.toEqual({
        kind: "unavailable",
        errorMessage: "auth unavailable",
      })
      await expect(refresh?.({ token: "same-token" })).resolves.toEqual({
        kind: "unavailable",
      })
      expect(resolveAuth).toHaveBeenCalledTimes(1)

      vi.setSystemTime(new Date(Date.now() + AUTH_REFRESH_UNAVAILABLE_CACHE_MS + 1))
      await expect(refresh?.({ token: "same-token" })).resolves.toEqual({
        kind: "unavailable",
        errorMessage: "auth unavailable",
      })
      expect(resolveAuth).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not install a refresh hook for static token sources", () => {
    expect(
      createNtnAuthRefresh(
        { token: "static", source: "env-notion-api-token" },
        configRoot,
        config
      )
    ).toBeUndefined()
    expect(resolveAuth).not.toHaveBeenCalled()
  })
})
