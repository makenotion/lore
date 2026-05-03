import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Client } from "@notionhq/client"
import { describe, expect, it, vi } from "vitest"
import {
  formatVaultTopologyStatus,
  loadVaultTopologyStatus,
  TOPOLOGY_STATUS_CACHE_TTL_MS,
  type TopologyStatusServices,
  type VaultHealthStatus,
  type VaultTopologyStatusReport,
} from "./topology-status.js"
import type { LoreConfig } from "../types.js"

function makeServices(
  config: LoreConfig,
  overrides: { client?: unknown; configRoot?: string | null } = {}
): TopologyStatusServices {
  return {
    config,
    configRoot: overrides.configRoot ?? "/repo",
    client: (overrides.client ?? {}) as Client,
  }
}

describe("formatVaultTopologyStatus", () => {
  it("returns no lines for single-vault configs so status stays byte-identical", () => {
    const report: VaultTopologyStatusReport = {
      configured: false,
      primary: {
        role: "primary",
        label: "Primary",
        pageId: "primary-page",
        mode: "read-write",
        health: { kind: "ok" },
      },
      upstreams: [],
      promotionTargets: [],
    }

    expect(formatVaultTopologyStatus(report)).toEqual([])
  })

  it("renders primary, upstream, promotion target, mode, page id, health, and freshness", () => {
    const report: VaultTopologyStatusReport = {
      configured: true,
      primary: {
        role: "primary",
        label: "Primary",
        pageId: "primary-page",
        mode: "read-write",
        health: { kind: "ok", message: "loaded by current status request" },
      },
      upstreams: [
        {
          role: "upstream",
          label: "Engineering",
          pageId: "engineering-page",
          mode: "read-only",
          priority: 10,
          health: {
            kind: "ok",
            checkedAt: "2026-05-03T12:00:00.000Z",
            freshness: "checked",
          },
        },
      ],
      promotionTargets: [
        {
          role: "promotion-target",
          label: "Team",
          pageId: "team-page",
          mode: "promotion (review required)",
          requireReview: true,
          health: {
            kind: "missing-databases",
            missing: ["Entities"],
            checkedAt: "2026-05-03T11:59:30.000Z",
            freshness: "cached",
          },
        },
      ],
    }

    const text = formatVaultTopologyStatus(report, {
      now: new Date("2026-05-03T12:00:00.000Z"),
    }).join("\n")
    expect(text).toContain("Vault topology:")
    expect(text).toContain("primary: Primary")
    expect(text).toContain("mode read-write")
    expect(text).toContain("health ok (loaded by current status request)")
    expect(text).toContain("Engineering")
    expect(text).toContain("mode read-only")
    expect(text).toContain("priority 10")
    expect(text).toContain("page engineering-page")
    expect(text).toContain("health ok (checked just now)")
    expect(text).toContain("Team")
    expect(text).toContain("promotion (review required)")
    expect(text).toContain("missing databases (Entities; cached 30s ago)")
  })

  it("surfaces upstream access failures without dropping other topology rows", () => {
    const report: VaultTopologyStatusReport = {
      configured: true,
      primary: {
        role: "primary",
        label: "Primary",
        pageId: "primary-page",
        mode: "read-write",
        health: { kind: "ok" },
      },
      upstreams: [
        {
          role: "upstream",
          label: "Policy",
          pageId: "policy-page",
          mode: "read-only",
          priority: 100,
          health: { kind: "unavailable", message: "404 not found" },
        },
      ],
      promotionTargets: [],
    }

    const text = formatVaultTopologyStatus(report).join("\n")
    expect(text).toContain("Policy")
    expect(text).toContain("unavailable (404 not found)")
    expect(text).toContain("primary: Primary")
  })
})

describe("loadVaultTopologyStatus", () => {
  it("does not probe anything for single-vault configs", async () => {
    const probeVault = vi.fn(async (): Promise<VaultHealthStatus> => ({ kind: "ok" }))
    const report = await loadVaultTopologyStatus(
      makeServices({ vault: { pageId: "primary-page" } }),
      { probeVault }
    )

    expect(report.configured).toBe(false)
    expect(report.primary.health).toEqual({
      kind: "ok",
      message: "loaded by current status request",
    })
    expect(probeVault).not.toHaveBeenCalled()
  })

  it("probes upstreams and promotion targets while preserving configured order", async () => {
    const probeVault = vi.fn(async (pageId: string): Promise<VaultHealthStatus> => {
      if (pageId === "broken-page") throw new Error("not shared")
      return { kind: "ok" }
    })

    const report = await loadVaultTopologyStatus(
      makeServices({
        vault: { pageId: "primary-page" },
        upstreamVaults: [
          { name: "Later", pageId: "later-page", priority: 50 },
          { name: "First", pageId: "first-page", priority: 10 },
        ],
        promotionTargets: [
          { name: "Team", pageId: "team-page", requireReview: true },
          { name: "Broken", pageId: "broken-page" },
        ],
      }),
      { probeVault }
    )

    expect(report.configured).toBe(true)
    expect(report.upstreams.map((row) => row.label)).toEqual(["First", "Later"])
    expect(report.upstreams.every((row) => row.health.kind === "ok")).toBe(true)
    expect(report.promotionTargets[0]?.mode).toBe("promotion (review required)")
    expect(report.promotionTargets[1]?.health).toEqual({
      kind: "unavailable",
      message: "not shared",
    })
    expect(probeVault).toHaveBeenCalledTimes(4)
  })

  it("maps MissingVaultDatabasesError into missing-databases health", async () => {
    const client = {
      blocks: {
        children: {
          list: vi.fn(async () => ({
            results: [],
            has_more: false,
            next_cursor: null,
          })),
        },
      },
      databases: {
        retrieve: vi.fn(),
      },
    }

    const report = await loadVaultTopologyStatus(
      makeServices(
        {
          vault: { pageId: "primary-page" },
          upstreamVaults: [{ name: "Partial", pageId: "partial-page" }],
        },
        { client }
      ),
      { cache: false }
    )

    expect(report.upstreams[0]?.health).toMatchObject({
      kind: "missing-databases",
      missing: ["Projects", "Topics", "Memories", "Entities", "Facts"],
    })
    expect(client.blocks.children.list).toHaveBeenCalledWith({
      block_id: "partial-page",
      page_size: 100,
    })
  })

  it("caches topology health probes for the TTL and refreshes stale entries", async () => {
    const cacheDir = await mkdtemp(join(tmpdir(), "lore-topology-status-"))
    try {
      let now = new Date("2026-05-03T12:00:00.000Z")
      const probeVault = vi.fn(async (): Promise<VaultHealthStatus> => ({ kind: "ok" }))
      const services = makeServices({
        vault: { pageId: "primary-page" },
        upstreamVaults: [{ name: "Engineering", pageId: "engineering-page" }],
      })

      const first = await loadVaultTopologyStatus(services, {
        probeVault,
        cache: { cacheDir, now: () => now },
      })
      expect(first.upstreams[0]?.health).toMatchObject({
        kind: "ok",
        checkedAt: "2026-05-03T12:00:00.000Z",
        freshness: "checked",
      })
      expect(probeVault).toHaveBeenCalledTimes(1)

      now = new Date("2026-05-03T12:00:30.000Z")
      const cached = await loadVaultTopologyStatus(services, {
        probeVault,
        cache: { cacheDir, now: () => now },
      })
      expect(cached.upstreams[0]?.health).toMatchObject({
        kind: "ok",
        checkedAt: "2026-05-03T12:00:00.000Z",
        freshness: "cached",
      })
      expect(probeVault).toHaveBeenCalledTimes(1)
      expect(formatVaultTopologyStatus(cached, { now }).join("\n")).toContain(
        "health ok (cached 30s ago)"
      )

      now = new Date(
        new Date("2026-05-03T12:00:00.000Z").getTime() + TOPOLOGY_STATUS_CACHE_TTL_MS + 1
      )
      await loadVaultTopologyStatus(services, {
        probeVault,
        cache: { cacheDir, now: () => now },
      })
      expect(probeVault).toHaveBeenCalledTimes(2)
    } finally {
      await rm(cacheDir, { recursive: true, force: true })
    }
  })
})
