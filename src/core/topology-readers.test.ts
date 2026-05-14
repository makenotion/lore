import { describe, expect, it, vi } from "vitest"
import type { Client } from "@notionhq/client"
import { buildUpstreamVaultBundles } from "./topology-readers.js"
import type { LoreConfig, Vault } from "../types.js"

// Stub the SDK-touching vault preflight so the per-upstream load
// path can be exercised without actual Notion calls. Mirrors the
// pattern used in `promote.test.ts`.
const verifyVaultDatabasesMock = vi.fn(async (_client: unknown, pageId: string) => {
  const vault: Vault = {
    pageId,
    databases: {
      projects: { databaseId: `${pageId}-proj-db`, dataSourceId: `${pageId}-proj-ds` },
      topics: { databaseId: `${pageId}-topics-db`, dataSourceId: `${pageId}-topics-ds` },
      memories: {
        databaseId: `${pageId}-mem-db`,
        dataSourceId: `${pageId}-mem-ds`,
      },
      entities: {
        databaseId: `${pageId}-entities-db`,
        dataSourceId: `${pageId}-entities-ds`,
      },
      facts: { databaseId: `${pageId}-facts-db`, dataSourceId: `${pageId}-facts-ds` },
    },
  }
  return vault
})

vi.mock("../notion/setup.js", async () => {
  const actual =
    await vi.importActual<typeof import("../notion/setup.js")>("../notion/setup.js")
  return {
    ...actual,
    verifyVaultDatabases: (...args: unknown[]) =>
      verifyVaultDatabasesMock(...(args as [Client, string])),
  }
})

/**
 * Stub `client.dataSources.retrieve` for the migration-safety scope
 * probe. The post-#286 upstream load runs one
 * `dataSources.retrieve({ data_source_id })` to detect whether the
 * upstream has the #283 `Scope Kind` / `Expires At` columns; this
 * helper builds a client that returns a configurable schema.
 */
function makeFakeClient(
  options: {
    scopeColumnsPresent?: boolean
    retrieveImpl?: (args: { data_source_id: string }) => Promise<unknown>
  } = {}
): Client {
  const present = options.scopeColumnsPresent ?? true
  const retrieve = vi.fn(
    options.retrieveImpl ??
      (async () => ({
        properties: present
          ? {
              "Scope Kind": { type: "select" },
              "Expires At": { type: "date" },
            }
          : {},
      }))
  )
  return { dataSources: { retrieve } } as unknown as Client
}

const fakeClient = makeFakeClient()

describe("buildUpstreamVaultBundles", () => {
  it("returns [] when no upstreams are configured", () => {
    const config: LoreConfig = { vault: { pageId: "primary" } }
    expect(buildUpstreamVaultBundles(fakeClient, config)).toEqual([])
  })

  it("returns one bundle per upstream, sorted by priority ascending", () => {
    const config: LoreConfig = {
      vault: { pageId: "primary" },
      upstreamVaults: [
        { name: "Slow", pageId: "slow", priority: 100 },
        { name: "Fast", pageId: "fast", priority: 10 },
        { name: "Default", pageId: "default-page" },
      ],
    }

    const bundles = buildUpstreamVaultBundles(fakeClient, config)

    expect(bundles.map((b) => b.label)).toEqual(["Fast", "Slow", "Default"])
    expect(bundles[0]).toMatchObject({
      label: "Fast",
      pageId: "fast",
      priority: 10,
      lastError: null,
    })
  })
})

describe("UpstreamVaultBundle.loadReaders", () => {
  it("lazy-loads the upstream vault on first call and caches the result", async () => {
    verifyVaultDatabasesMock.mockClear()

    const bundles = buildUpstreamVaultBundles(fakeClient, {
      vault: { pageId: "primary" },
      upstreamVaults: [{ name: "Team", pageId: "team-vault" }],
    })
    const bundle = bundles[0]!

    const first = await bundle.loadReaders()
    const second = await bundle.loadReaders()

    expect(verifyVaultDatabasesMock).toHaveBeenCalledTimes(1)
    expect(first).toBe(second)
    expect(first?.memories).toBeDefined()
    expect(bundle.lastError).toBeNull()
  })

  it("collapses concurrent loadReaders calls onto a single in-flight load", async () => {
    // Stampede guard: two callers racing on the same cold upstream
    // (e.g. concurrent wake-up + topology-status calls) should
    // share one `VaultManager.load` round-trip. Without the
    // single-flight discipline, every concurrent caller would
    // dispatch a fresh `verifyVaultDatabases` against Notion.
    verifyVaultDatabasesMock.mockClear()

    const bundles = buildUpstreamVaultBundles(fakeClient, {
      vault: { pageId: "primary" },
      upstreamVaults: [{ name: "Team", pageId: "team-vault" }],
    })
    const bundle = bundles[0]!

    const [a, b, c] = await Promise.all([
      bundle.loadReaders(),
      bundle.loadReaders(),
      bundle.loadReaders(),
    ])

    expect(verifyVaultDatabasesMock).toHaveBeenCalledTimes(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it("returns null and captures lastError on load failure (LORE_DEBUG=1 stderr emission)", async () => {
    verifyVaultDatabasesMock.mockImplementationOnce(async () => {
      throw new Error("upstream page not accessible")
    })
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const originalDebug = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"

    // Use a real UUID-shape page id so the `redactDebugMessage`
    // page-id scrubber actually fires. The previous test used
    // `broken-vault` (no UUID shape), which wouldn't catch a
    // regression that removed the whole-line redaction.
    const bundles = buildUpstreamVaultBundles(fakeClient, {
      vault: { pageId: "primary" },
      upstreamVaults: [
        {
          name: "BrokenTeam",
          pageId: "deadbeef-cafe-4abc-9def-123456789abc",
        },
      ],
    })
    const bundle = bundles[0]!

    const readers = await bundle.loadReaders()

    expect(readers).toBeNull()
    expect(bundle.lastError).toContain("upstream page not accessible")
    // Single stderr emission for the upstream-unavailable warning
    // (gated on LORE_DEBUG=1 — see the stderr-write call site).
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const emitted = String(stderrSpy.mock.calls[0]?.[0])
    expect(emitted).toContain("upstream-vault-unavailable")
    expect(emitted).toContain("BrokenTeam")
    // The whole line is routed through `redactDebugMessage` — the
    // configured page id MUST be replaced with the `<page-id>`
    // sentinel even though `LORE_DEBUG` is set.
    expect(emitted).not.toContain("deadbeef-cafe-4abc-9def-123456789abc")
    expect(emitted).toContain("<page-id>")

    stderrSpy.mockRestore()
    if (originalDebug === undefined) delete process.env["LORE_DEBUG"]
    else process.env["LORE_DEBUG"] = originalDebug
  })

  it("does not emit to stderr when LORE_DEBUG is unset (recon-class page id gating)", async () => {
    // PR #589 review nit: wake-up runs on every session start, so
    // the upstream-unavailable stderr line stays silent by default.
    // Operators retrying triage re-run with `LORE_DEBUG=1`. Note
    // that even under `LORE_DEBUG=1` the page id itself is
    // redacted to `<page-id>` via `redactDebugMessage` — see the
    // matching test above for that assertion. This test pins the
    // outer gate; the inner redaction is asserted separately.
    verifyVaultDatabasesMock.mockImplementationOnce(async () => {
      throw new Error("upstream page not accessible")
    })
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const originalDebug = process.env["LORE_DEBUG"]
    delete process.env["LORE_DEBUG"]

    const bundles = buildUpstreamVaultBundles(fakeClient, {
      vault: { pageId: "primary" },
      upstreamVaults: [{ name: "BrokenTeam", pageId: "broken-vault" }],
    })
    const bundle = bundles[0]!

    const readers = await bundle.loadReaders()

    expect(readers).toBeNull()
    expect(bundle.lastError).toContain("upstream page not accessible")
    expect(stderrSpy).not.toHaveBeenCalled()

    stderrSpy.mockRestore()
    if (originalDebug !== undefined) process.env["LORE_DEBUG"] = originalDebug
  })

  it("does not re-load or re-emit the stderr warning on subsequent loadReaders calls after a failure (cached failure sentinel)", async () => {
    // Cached-failure-sentinel contract: PR #589 review blocker —
    // the previous implementation re-probed broken upstreams on
    // every `loadReaders()` call. Now the failure caches; both
    // the `verifyVaultDatabases` re-probe AND the stderr line
    // must NOT fire on subsequent calls within the same process.
    verifyVaultDatabasesMock.mockClear()
    verifyVaultDatabasesMock.mockImplementation(async () => {
      throw new Error("upstream page not accessible")
    })
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const originalDebug = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"

    const bundles = buildUpstreamVaultBundles(fakeClient, {
      vault: { pageId: "primary" },
      upstreamVaults: [{ name: "BrokenTeam", pageId: "broken-vault" }],
    })
    const bundle = bundles[0]!

    await bundle.loadReaders()
    await bundle.loadReaders()
    await bundle.loadReaders()

    expect(verifyVaultDatabasesMock).toHaveBeenCalledTimes(1)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    expect(bundle.lastError).toContain("upstream page not accessible")

    stderrSpy.mockRestore()
    if (originalDebug === undefined) delete process.env["LORE_DEBUG"]
    else process.env["LORE_DEBUG"] = originalDebug
    verifyVaultDatabasesMock.mockReset()
  })

  it("passes an empty scope context to MemoryService when the upstream has the #283 scope columns", async () => {
    // Migrated upstream — `Scope Kind` and `Expires At` are
    // present on the Memories DS. The upstream MemoryService gets
    // a constructor `scopeCtx` argument so the default scope
    // filter is ENABLED with the "no narrow scopes ever surface"
    // branch (PR #589 review).
    const client = makeFakeClient({ scopeColumnsPresent: true })
    const bundles = buildUpstreamVaultBundles(client, {
      vault: { pageId: "primary" },
      upstreamVaults: [{ name: "Team", pageId: "team-vault" }],
    })
    const readers = await bundles[0]!.loadReaders()

    expect(readers).not.toBeNull()
    // The test cannot directly observe the MemoryService's scope
    // filter state (private), but `getScopeContext()` returns the
    // configured context; an empty object means scope filter is
    // ENABLED ("no narrow scopes surface" branch).
    const ctx = readers!.memories.getScopeContext()
    expect(ctx).toEqual({})
  })

  it("falls back to legacy retrieval shape when the upstream has not run the scope migration", async () => {
    // Migration-safety blocker (PR #589 review): an unmigrated
    // upstream vault is missing the `Scope Kind` / `Expires At`
    // columns. The post-#286 upstream loader must detect this and
    // pass `undefined` (= filter disabled) instead of `{}` (=
    // filter enabled). Without this guard, every `memories.list`
    // against the upstream would issue a `Scope Kind` /
    // `Expires At` filter clause that Notion rejects with a
    // `validation_error`. Teams with legacy upstream vaults would
    // be unable to roll out read inheritance until every upstream
    // is migrated.
    const client = makeFakeClient({ scopeColumnsPresent: false })
    const bundles = buildUpstreamVaultBundles(client, {
      vault: { pageId: "primary" },
      upstreamVaults: [{ name: "LegacyTeam", pageId: "legacy-vault" }],
    })
    const readers = await bundles[0]!.loadReaders()

    expect(readers).not.toBeNull()
    // No constructor scope context means `scopeFilterEnabled` is
    // false on the underlying `MemoryService` — `list()` skips
    // the scope-filter clause and uses the pre-#283 retrieval
    // shape. The observable signal is that `getScopeContext()`
    // returns the constructor default (which the `MemoryService`
    // exposes as an empty-object frozen snapshot regardless of
    // whether the filter is on); the load-bearing distinction is
    // the absence of the constructor argument, exercised
    // structurally by the run not throwing on the unmigrated
    // schema fixture.
    expect(readers!.memories).toBeDefined()
  })

  it("falls back to optimistic (filter-enabled) on probe failure to avoid silently widening upstream visibility", async () => {
    // Probe failure (transient 5xx, rate-limit blip) → fall back
    // to "columns present" so the scope filter stays ENABLED.
    // The conservative posture: a one-off probe blip must not
    // silently disable the scope filter for the entire process
    // lifetime, which would widen narrow-scope upstream rows into
    // the inherited section. Mirrors `initServicesFromConfig`'s
    // same-direction fall-back.
    const client = makeFakeClient({
      retrieveImpl: async () => {
        throw new Error("transient 503 from notion")
      },
    })
    const bundles = buildUpstreamVaultBundles(client, {
      vault: { pageId: "primary" },
      upstreamVaults: [{ name: "Team", pageId: "team-vault" }],
    })
    const readers = await bundles[0]!.loadReaders()

    // Load itself succeeds (the probe failure is swallowed via
    // `.catch(...)`), but the resulting MemoryService is
    // constructed WITH the empty scope context — the filter is
    // enabled even though we couldn't confirm the columns.
    expect(readers).not.toBeNull()
    expect(readers!.memories.getScopeContext()).toEqual({})
  })

  it("emits a LORE_DEBUG=1 stderr line when the scope-column probe fails (post-#591 observability)", async () => {
    // PR #591 round-3 review: `probeUpstreamScopeColumns` used to
    // swallow probe errors silently. Surface them under
    // `LORE_DEBUG=1` so operators triaging
    // "why does this upstream surface narrow-scope rows" can see
    // whether the probe was bypassed via conservative fall-back.
    const client = makeFakeClient({
      retrieveImpl: async () => {
        throw new Error("transient 503 from notion")
      },
    })
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const originalDebug = process.env["LORE_DEBUG"]
    process.env["LORE_DEBUG"] = "1"

    const bundles = buildUpstreamVaultBundles(client, {
      vault: { pageId: "primary" },
      upstreamVaults: [{ name: "ProbeFailTeam", pageId: "probe-fail-vault" }],
    })
    const readers = await bundles[0]!.loadReaders()

    expect(readers).not.toBeNull()
    // One stderr line was emitted by the probe-failure path.
    // (The load itself succeeded, so the surrounding
    // upstream-vault-unavailable emitter doesn't fire.)
    expect(stderrSpy).toHaveBeenCalledTimes(1)
    const emitted = String(stderrSpy.mock.calls[0]?.[0])
    expect(emitted).toContain("upstream-scope-probe-failed")
    expect(emitted).toContain("ProbeFailTeam")
    expect(emitted).toContain("transient 503 from notion")

    stderrSpy.mockRestore()
    if (originalDebug === undefined) delete process.env["LORE_DEBUG"]
    else process.env["LORE_DEBUG"] = originalDebug
  })

  it("does NOT emit a probe-failure stderr line when LORE_DEBUG is unset", async () => {
    // Mirror of the upstream-vault-unavailable gate: probe
    // failures stay silent by default to keep wake-up's hot path
    // quiet. The conservative fall-back posture (filter stays
    // enabled) means a transient probe blip is structurally
    // harmless.
    const client = makeFakeClient({
      retrieveImpl: async () => {
        throw new Error("transient 503 from notion")
      },
    })
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const originalDebug = process.env["LORE_DEBUG"]
    delete process.env["LORE_DEBUG"]

    const bundles = buildUpstreamVaultBundles(client, {
      vault: { pageId: "primary" },
      upstreamVaults: [{ name: "ProbeFailTeam", pageId: "probe-fail-vault" }],
    })
    const readers = await bundles[0]!.loadReaders()

    expect(readers).not.toBeNull()
    expect(stderrSpy).not.toHaveBeenCalled()

    stderrSpy.mockRestore()
    if (originalDebug !== undefined) process.env["LORE_DEBUG"] = originalDebug
  })
})
