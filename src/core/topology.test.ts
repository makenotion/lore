import { describe, expect, it } from "vitest"
import {
  DEFAULT_UPSTREAM_PRIORITY,
  buildVaultTopology,
  hasConfiguredTopology,
} from "./topology.js"
import type { LoreConfig } from "../types.js"

describe("buildVaultTopology", () => {
  it("returns only the primary vault for single-vault configs", () => {
    const config: LoreConfig = { vault: { pageId: "primary-page" } }

    const topology = buildVaultTopology(config)

    expect(hasConfiguredTopology(config)).toBe(false)
    expect(topology).toEqual({
      primary: {
        role: "primary",
        label: "Primary",
        pageId: "primary-page",
      },
      upstreams: [],
      promotionTargets: [],
    })
  })

  it("normalizes read-only upstreams and sorts them by priority", () => {
    const topology = buildVaultTopology({
      vault: { pageId: "primary-page" },
      upstreamVaults: [
        { name: "Default Priority", pageId: "default-page" },
        { name: "Engineering", pageId: "engineering-page", priority: 10 },
        { name: "Infra", pageId: "infra-page", priority: 20 },
      ],
    })

    expect(topology.upstreams.map((vault) => vault.label)).toEqual([
      "Engineering",
      "Infra",
      "Default Priority",
    ])
    expect(topology.upstreams[0]).toMatchObject({
      role: "upstream",
      priority: 10,
    })
    expect(topology.upstreams[2]?.priority).toBe(DEFAULT_UPSTREAM_PRIORITY)
  })

  it("normalizes promotion targets", () => {
    const config: LoreConfig = {
      vault: { pageId: "primary-page" },
      promotionTargets: [
        { name: "Team", pageId: "team-page", requireReview: true },
        { name: "Org", pageId: "org-page" },
      ],
    }

    const topology = buildVaultTopology(config)

    expect(hasConfiguredTopology(config)).toBe(true)
    expect(topology.promotionTargets).toEqual([
      {
        role: "promotion-target",
        label: "Team",
        pageId: "team-page",
        requireReview: true,
      },
      {
        role: "promotion-target",
        label: "Org",
        pageId: "org-page",
        requireReview: false,
      },
    ])
  })

  it("keeps config order when upstream priorities tie", () => {
    const topology = buildVaultTopology({
      vault: { pageId: "primary-page" },
      upstreamVaults: [
        { name: "First", pageId: "first-page", priority: 10 },
        { name: "Second", pageId: "second-page", priority: 10 },
      ],
    })

    expect(topology.upstreams.map((vault) => vault.label)).toEqual(["First", "Second"])
  })
})
