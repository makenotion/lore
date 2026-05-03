import type { LoreConfig, UpstreamVaultMode } from "../types.js"

export const DEFAULT_UPSTREAM_PRIORITY = 100
export const DEFAULT_UPSTREAM_MODE: UpstreamVaultMode = "read-only"

export interface PrimaryVaultTopologyRef {
  role: "primary"
  label: "Primary"
  pageId: string
  originKey: string
}

export interface UpstreamVaultTopologyRef {
  role: "upstream"
  label: string
  pageId: string
  mode: UpstreamVaultMode
  priority: number
  originKey: string
}

export interface PromotionTargetTopologyRef {
  role: "promotion-target"
  label: string
  pageId: string
  requireReview: boolean
  originKey: string
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
        mode: vault.mode ?? DEFAULT_UPSTREAM_MODE,
        priority: vault.priority ?? DEFAULT_UPSTREAM_PRIORITY,
        originKey: originKey("upstream", vault.pageId),
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
    originKey: originKey("promotion-target", vault.pageId),
  }))

  return {
    primary: {
      role: "primary",
      label: "Primary",
      pageId: config.vault.pageId,
      originKey: originKey("primary", config.vault.pageId),
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

function originKey(role: string, pageId: string): string {
  return `${role}:${pageId}`
}
