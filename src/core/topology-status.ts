// ABOUTME: Owns health probing, cache freshness, and status aggregation for configured vault topology.
// ABOUTME: Edit when topology health states, probe concurrency, or status cache behavior change.

import { createHash } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import type { Client } from "@notionhq/client"
import pLimit from "p-limit"
import { getStateDir } from "../hooks/lock.js"
import { MissingVaultDatabasesError } from "../notion/setup.js"
import { VaultManager } from "./vault.js"
import {
  buildVaultTopology,
  hasConfiguredTopology,
  type PromotionTargetTopologyRef,
  type UpstreamVaultTopologyRef,
} from "./topology.js"
import type { LoreConfig } from "../types.js"

export const TOPOLOGY_STATUS_PROBE_CONCURRENCY = 2
export const TOPOLOGY_STATUS_CACHE_TTL_MS = 60_000

export type VaultHealthKind = "ok" | "missing-databases" | "unavailable"
export type VaultHealthFreshness = "checked" | "cached" | "debounced"

export interface VaultHealthStatus {
  kind: VaultHealthKind
  message?: string
  missing?: string[]
  checkedAt?: string
  freshness?: VaultHealthFreshness
}

export interface TopologyStatusRow {
  role: "primary" | "upstream" | "promotion-target"
  label: string
  pageId: string
  mode: string
  priority?: number
  requireReview?: boolean
  health: VaultHealthStatus
}

export interface VaultTopologyStatusReport {
  configured: boolean
  primary: TopologyStatusRow
  upstreams: TopologyStatusRow[]
  promotionTargets: TopologyStatusRow[]
}

export interface VaultTopologyStatusDeps {
  probeVault?: (pageId: string) => Promise<VaultHealthStatus>
  cache?:
    | false
    | {
        ttlMs?: number
        cacheDir?: string
        now?: () => Date
      }
}

export interface TopologyStatusServices {
  config: LoreConfig
  configRoot?: string | null
  /**
   * Shared service client from `initServices()`. It already carries auth
   * refresh and the process-wide rate-limit bucket, so topology probes must
   * route through it rather than creating a second Notion client.
   */
  client: Client
}

/**
 * Build the topology status report for CLI and MCP status surfaces.
 *
 * The primary row is presentational: `initServices()` already loaded the
 * primary vault before callers reach this function, so its health means
 * "the current status request is connected". Every upstream or promotion
 * target is verified by loading its Lore child databases with the shared
 * client. That verification costs a child-block walk plus database retrieve
 * calls per configured vault. Results are cached for a short TTL by
 * config-root + page id, and probes are bounded to two concurrent vaults so
 * large topologies do not stampede the shared Notion rate-limit bucket.
 */
export async function loadVaultTopologyStatus(
  services: TopologyStatusServices,
  deps: VaultTopologyStatusDeps = {}
): Promise<VaultTopologyStatusReport> {
  const configured = hasConfiguredTopology(services.config)
  const primary: TopologyStatusRow = {
    role: "primary",
    label: "Primary",
    pageId: services.config.vault.pageId,
    mode: "read-write",
    health: { kind: "ok", message: "loaded by current status request" },
  }

  if (!configured) {
    return { configured, primary, upstreams: [], promotionTargets: [] }
  }

  const topology = buildVaultTopology(services.config)

  const rawProbe =
    deps.probeVault ?? ((pageId: string) => checkVaultHealth(services.client, pageId))
  const cacheOptions = resolveCacheOptions(services, deps)
  const probe = cacheOptions
    ? (pageId: string) => cachedProbeVaultHealth(services, pageId, rawProbe, cacheOptions)
    : (pageId: string) => safeProbeVault(pageId, rawProbe)
  const schedule = pLimit(TOPOLOGY_STATUS_PROBE_CONCURRENCY)

  const [upstreams, promotionTargets] = await Promise.all([
    Promise.all(
      topology.upstreams.map((vault) => schedule(() => upstreamStatusRow(vault, probe)))
    ),
    Promise.all(
      topology.promotionTargets.map((vault) =>
        schedule(() => promotionTargetStatusRow(vault, probe))
      )
    ),
  ])

  return { configured, primary, upstreams, promotionTargets }
}

export function formatVaultTopologyStatus(
  report: VaultTopologyStatusReport,
  options: { now?: Date } = {}
): string[] {
  if (!report.configured) return []

  const lines = ["Vault topology:"]
  const now = options.now ?? new Date()
  lines.push(`  primary: ${formatTopologyRow(report.primary, now)}`)

  if (report.upstreams.length > 0) {
    lines.push("  upstreams:")
    for (const row of report.upstreams) {
      lines.push(`    - ${formatTopologyRow(row, now)}`)
    }
  }

  if (report.promotionTargets.length > 0) {
    lines.push("  promotion targets:")
    for (const row of report.promotionTargets) {
      lines.push(`    - ${formatTopologyRow(row, now)}`)
    }
  }

  return lines
}

async function checkVaultHealth(
  client: Client,
  pageId: string
): Promise<VaultHealthStatus> {
  try {
    const vault = new VaultManager(client, pageId)
    await vault.load({ driftCheck: false })
    return { kind: "ok" }
  } catch (err) {
    if (err instanceof MissingVaultDatabasesError) {
      return {
        kind: "missing-databases",
        missing: err.missing,
        message: `missing ${err.missing.join(", ")}`,
      }
    }
    return {
      kind: "unavailable",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

async function upstreamStatusRow(
  vault: UpstreamVaultTopologyRef,
  probe: (pageId: string) => Promise<VaultHealthStatus>
): Promise<TopologyStatusRow> {
  return {
    role: vault.role,
    label: vault.label,
    pageId: vault.pageId,
    mode: "read-only",
    priority: vault.priority,
    health: await probe(vault.pageId),
  }
}

async function promotionTargetStatusRow(
  vault: PromotionTargetTopologyRef,
  probe: (pageId: string) => Promise<VaultHealthStatus>
): Promise<TopologyStatusRow> {
  return {
    role: vault.role,
    label: vault.label,
    pageId: vault.pageId,
    mode: vault.requireReview ? "promotion (review required)" : "promotion",
    requireReview: vault.requireReview,
    health: await probe(vault.pageId),
  }
}

// The non-cached probe path. Returns a status with no `checkedAt` /
// `freshness` so `formatHealthFreshness` emits no marker — direct
// callers (CLI/MCP one-shot probes) deliberately render markerless
// because they have no cache to anchor a freshness timestamp on.
async function safeProbeVault(
  pageId: string,
  probe: (pageId: string) => Promise<VaultHealthStatus>
): Promise<VaultHealthStatus> {
  try {
    return await probe(pageId)
  } catch (err) {
    return {
      kind: "unavailable",
      message: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Operator-facing health string contract for `lore status`'s topology
 * section. This function and the two it delegates to
 * (`formatVaultHealth`, `formatHealthFreshness`) compose the line
 * shape operators triage by — change either the field separator, field
 * order, or any health-prefix string and the operator-facing topology
 * documentation must move in the same patch.
 */
function formatTopologyRow(row: TopologyStatusRow, now: Date): string {
  const parts = [row.label, `mode ${row.mode}`]
  if (row.priority !== undefined) parts.push(`priority ${row.priority}`)
  parts.push(`page ${row.pageId}`, `health ${formatVaultHealth(row.health, now)}`)
  return parts.join(" · ")
}

// Operator-contract. The three prefixes (`ok`, `missing databases`,
// `unavailable`) are grepped by operators triaging degraded vaults —
// any prefix or parenthetical-shape change is a breaking surface
// change to that grep contract.
function formatVaultHealth(health: VaultHealthStatus, now: Date): string {
  const freshness = formatHealthFreshness(health, now)
  if (health.kind === "ok") {
    const details = [health.message, freshness].filter(Boolean)
    return details.length > 0 ? `ok (${details.join("; ")})` : "ok"
  }
  if (health.kind === "missing-databases") {
    const missing = health.missing?.join(", ") ?? health.message
    const details = [missing, freshness].filter(Boolean)
    return details.length > 0
      ? `missing databases (${details.join("; ")})`
      : "missing databases"
  }
  const details = [health.message, freshness].filter(Boolean)
  return details.length > 0 ? `unavailable (${details.join("; ")})` : "unavailable"
}

interface TopologyStatusCacheOptions {
  ttlMs: number
  cacheDir: string
  now: () => Date
}

interface CachedVaultHealthStatus {
  version: 1
  pageId: string
  checkedAt: string
  health: VaultHealthStatus
}

const inFlightHealthProbes = new Map<string, Promise<VaultHealthStatus>>()

function resolveCacheOptions(
  services: TopologyStatusServices,
  deps: VaultTopologyStatusDeps
): TopologyStatusCacheOptions | null {
  if (deps.cache === false) return null
  if (deps.probeVault && deps.cache === undefined) return null
  if (!services.configRoot && deps.cache === undefined) return null

  return {
    ttlMs: deps.cache?.ttlMs ?? TOPOLOGY_STATUS_CACHE_TTL_MS,
    cacheDir: deps.cache?.cacheDir ?? getStateDir(),
    now: deps.cache?.now ?? (() => new Date()),
  }
}

async function cachedProbeVaultHealth(
  services: TopologyStatusServices,
  pageId: string,
  probe: (pageId: string) => Promise<VaultHealthStatus>,
  cache: TopologyStatusCacheOptions
): Promise<VaultHealthStatus> {
  const cacheKey = topologyStatusCacheKey(services.configRoot ?? "", pageId)
  const cached = await readCachedVaultHealth(cache.cacheDir, cacheKey, pageId)
  const now = cache.now()

  if (cached) {
    const ageMs = now.getTime() - Date.parse(cached.checkedAt)
    if (Number.isFinite(ageMs) && ageMs <= cache.ttlMs) {
      return withFreshness(cached.health, cached.checkedAt, "cached")
    }
  }

  const inFlight = inFlightHealthProbes.get(cacheKey)
  if (inFlight) {
    const health = await inFlight
    return { ...health, freshness: "debounced" }
  }

  const pending = (async () => {
    const health = await safeProbeVault(pageId, probe)
    const checkedAt = cache.now().toISOString()
    await writeCachedVaultHealth(cache.cacheDir, cacheKey, {
      version: 1,
      pageId,
      checkedAt,
      health: stripFreshness(health),
    })
    return withFreshness(health, checkedAt, "checked")
  })()

  inFlightHealthProbes.set(cacheKey, pending)
  try {
    return await pending
  } finally {
    inFlightHealthProbes.delete(cacheKey)
  }
}

function topologyStatusCacheKey(configRoot: string, pageId: string): string {
  return createHash("sha256")
    .update(`${configRoot}\0${pageId}`)
    .digest("hex")
    .slice(0, 16)
}

function topologyStatusCachePath(cacheDir: string, cacheKey: string): string {
  return join(cacheDir, `topology-status.${cacheKey}.json`)
}

async function readCachedVaultHealth(
  cacheDir: string,
  cacheKey: string,
  pageId: string
): Promise<CachedVaultHealthStatus | null> {
  try {
    const raw = await readFile(topologyStatusCachePath(cacheDir, cacheKey), "utf8")
    const parsed = JSON.parse(raw) as Partial<CachedVaultHealthStatus>
    if (
      parsed.version !== 1 ||
      parsed.pageId !== pageId ||
      typeof parsed.checkedAt !== "string" ||
      !isVaultHealthStatus(parsed.health)
    ) {
      return null
    }
    return {
      version: 1,
      pageId: parsed.pageId,
      checkedAt: parsed.checkedAt,
      health: stripFreshness(parsed.health),
    }
  } catch {
    return null
  }
}

async function writeCachedVaultHealth(
  cacheDir: string,
  cacheKey: string,
  entry: CachedVaultHealthStatus
): Promise<void> {
  try {
    await mkdir(cacheDir, { recursive: true })
    const path = topologyStatusCachePath(cacheDir, cacheKey)
    const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmpPath, `${JSON.stringify(entry)}\n`)
    await rename(tmpPath, path)
  } catch {
    // Status should stay best-effort: cache I/O failures must not hide vault health.
  }
}

function isVaultHealthStatus(value: unknown): value is VaultHealthStatus {
  if (!value || typeof value !== "object") return false
  const health = value as Partial<VaultHealthStatus>
  return (
    health.kind === "ok" ||
    health.kind === "missing-databases" ||
    health.kind === "unavailable"
  )
}

function stripFreshness(health: VaultHealthStatus): VaultHealthStatus {
  return {
    kind: health.kind,
    ...(health.message !== undefined ? { message: health.message } : {}),
    ...(health.missing !== undefined ? { missing: health.missing } : {}),
  }
}

function withFreshness(
  health: VaultHealthStatus,
  checkedAt: string,
  freshness: VaultHealthFreshness
): VaultHealthStatus {
  return { ...stripFreshness(health), checkedAt, freshness }
}

// Operator-contract. The three markers (`checked`, `cached`,
// `debounced`) and the missing-marker case (no `checkedAt`) are
// the visible vocabulary operators key off when triaging vault
// freshness — any marker addition, removal, or rename is a
// breaking change to that surface.
function formatHealthFreshness(health: VaultHealthStatus, now: Date): string | undefined {
  if (!health.checkedAt) return undefined
  const age = formatCheckedAge(health.checkedAt, now)
  switch (health.freshness) {
    case "cached":
      return `cached ${age}`
    case "debounced":
      return `debounced ${age}`
    case "checked":
    default:
      return `checked ${age}`
  }
}

function formatCheckedAge(checkedAt: string, now: Date): string {
  const checkedMs = Date.parse(checkedAt)
  if (!Number.isFinite(checkedMs)) return "at unknown time"
  const ageMs = Math.max(0, now.getTime() - checkedMs)
  if (ageMs < 1_000) return "just now"
  if (ageMs < 60_000) return `${Math.floor(ageMs / 1_000)}s ago`
  if (ageMs < 3_600_000) return `${Math.floor(ageMs / 60_000)}m ago`
  if (ageMs < 86_400_000) return `${Math.floor(ageMs / 3_600_000)}h ago`
  return `${Math.floor(ageMs / 86_400_000)}d ago`
}
