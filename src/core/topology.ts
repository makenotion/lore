// ABOUTME: Owns normalized vault topology references for primary, upstream, and promotion-target vaults.
// ABOUTME: Edit when config roles, defaults, or topology validation rules change.

import type { LoreConfig } from "../types.js"

export const DEFAULT_UPSTREAM_PRIORITY = 100

export interface PrimaryVaultTopologyRef {
  role: "primary"
  label: string
  pageId: string
}

export interface UpstreamVaultTopologyRef {
  role: "upstream"
  label: string
  pageId: string
  priority: number
}

export interface PromotionTargetTopologyRef {
  role: "promotion-target"
  label: string
  pageId: string
  requireReview: boolean
}

export interface VaultTopology {
  primary: PrimaryVaultTopologyRef
  upstreams: UpstreamVaultTopologyRef[]
  promotionTargets: PromotionTargetTopologyRef[]
}

export function buildVaultTopology(config: LoreConfig): VaultTopology {
  const upstreams = (config.upstreamVaults ?? [])
    .map((vault, index) => ({
      vault: {
        role: "upstream" as const,
        label: vault.name,
        pageId: vault.pageId,
        priority: vault.priority ?? DEFAULT_UPSTREAM_PRIORITY,
      },
      index,
    }))
    .sort((a, b) => a.vault.priority - b.vault.priority || a.index - b.index)
    .map((entry) => entry.vault)

  const promotionTargets = (config.promotionTargets ?? []).map((vault) => ({
    role: "promotion-target" as const,
    label: vault.name,
    pageId: vault.pageId,
    requireReview: vault.requireReview ?? false,
  }))

  return {
    primary: {
      role: "primary",
      label: "Primary",
      pageId: config.vault.pageId,
    },
    upstreams,
    promotionTargets,
  }
}

export function hasConfiguredTopology(config: LoreConfig): boolean {
  return (
    (config.upstreamVaults?.length ?? 0) > 0 || (config.promotionTargets?.length ?? 0) > 0
  )
}
