/**
 * Shared service initialization.
 *
 * The LoreServices interface and initServices() function are used by both
 * the MCP server and CLI commands. Extracted here to avoid a dependency
 * from CLI → MCP layer.
 */

import { access } from "node:fs/promises"
import { resolve } from "node:path"
import { findConfigFile, loadConfig, resolveAuth, type ResolvedAuth } from "./config.js"
import {
  createAuthRefreshingClient,
  createClient,
  type ClientAuthSnapshot,
  type ClientAuthRefreshOutcome,
  type RefreshClientAuth,
} from "./notion/client.js"
import { createLimitedClient } from "./notion/rate-limit.js"
import { VaultManager } from "./core/vault.js"
import { ProjectService } from "./core/project.js"
import { TopicService } from "./core/topic.js"
import { MemoryService } from "./core/memory.js"
import { FactService } from "./core/fact.js"
import { DecisionService } from "./core/decision.js"
import { TaskService } from "./core/task.js"
import { EntityService } from "./core/entity.js"
import { resolveProject } from "./core/context.js"
import { resolveAuthorIdentity, type ResolvedIdentity } from "./auth/identity.js"
import {
  DRIFT_DEBOUNCE_DAYS,
  driftMarkerAgeDays,
  touchDriftMarker,
} from "./hooks/drift-marker.js"
import { SessionMemoryTracker } from "./session-memory-tracker.js"
import type { LoreConfig, ResolvedContext } from "./types.js"

/**
 * Drift-check policy for `initServices` / `initServicesFromConfig`.
 *
 * - `true` — run the schema drift check unconditionally; bypass the
 *   per-config-root debounce. Use for explicit operator-facing surfaces
 *   (`lore status`, `lore migrate`) where the user expects drift output.
 * - `false` (default) — skip the drift check entirely. Use for narrow
 *   CLI commands (`lore search`, `lore mine`, `lore digest`) and any
 *   path that does not surface drift; this also applies when no policy
 *   is provided, to keep the safest default.
 * - `"debounced"` — run the drift check at most once per config root per
 *   `DRIFT_DEBOUNCE_DAYS`. Use for hot startup paths (MCP server, shell
 *   hooks) so an operator on a stale vault still gets occasional nudges
 *   without paying the multi-page scan on every fire.
 *
 * Precedence (matches the 0.6.0 issue 02 contract):
 * - explicit `true` always runs; bypasses the marker
 * - explicit `false` always skips; ignores the marker
 * - the marker only suppresses the implicit/`"debounced"` path
 */
export type DriftCheckMode = boolean | "debounced"

export interface InitServicesOptions {
  driftCheck?: DriftCheckMode
}

export interface LoreServices {
  vault: VaultManager
  projects: ProjectService
  topics: TopicService
  memories: MemoryService
  facts: FactService
  decisions: DecisionService
  tasks: TaskService
  /**
   * Canonical-entity registry (PF3-01). `null` on vaults that pre-date
   * the migration — the Entities DB doesn't exist yet, so the service
   * can't be wired up. Code paths that read `services.entities` must
   * guard against null and fall back to substring queries on the
   * Subject/Object text.
   */
  entities: EntityService | null
  context: ResolvedContext
  config: LoreConfig
  configRoot: string
  /**
   * Per-process map of session_id → last-created memory id. MCP save tools
   * record into it; `lore-fact action='create'` reads it to auto-link
   * `sourceMemoryId` when the caller omits it. Empty (and unused) in
   * one-shot CLI/hook contexts.
   */
  sessionMemories: SessionMemoryTracker
  /**
   * Engineer identity to stamp on every Memory `Author` column
   * (DEFERRED-ATTRIBUTION). Resolved once at startup via
   * `resolveAuthorIdentity` — `LORE_USER_NAME` env override first, then
   * `users.me().bot.owner.user.name` as the fallback for ntn-issued
   * tokens. `author === null` when neither source produced a usable
   * value; tools that read it default to omitting the Author write
   * rather than stamping an empty string.
   *
   * Required (not optional) so a future refactor that forgets to
   * populate it in a new init seam fails the typecheck rather than
   * silently no-opping attribution. Test fixtures using
   * `as unknown as LoreServices` casts must supply
   * `{ author: null }` (or an explicit value) at construction; the
   * cast pattern itself doesn't preclude the requirement.
   */
  identity: ResolvedIdentity
}

export const AUTH_REFRESH_UNAVAILABLE_CACHE_MS = 1_000

export async function initServicesFromConfig(
  cwd: string,
  configRoot: string,
  config: LoreConfig,
  options: InitServicesOptions = {}
): Promise<LoreServices> {
  const auth = await resolveAuth(config, configRoot)
  const authRefresh = createNtnAuthRefresh(auth, configRoot, config)
  const rateLimitOptions = config.notion?.rateLimit ?? {}
  // Every downstream service shares the same rate-limited Proxy so fan-out
  // stays under Notion's per-token rps ceiling without per-call-site work.
  // The wrapper governs concurrency (fan-out memory), request rate (token
  // bucket), and 429 shared backoff; defaults match Notion's ~3 rps
  // public guidance.
  const client = authRefresh
    ? createAuthRefreshingClient(toClientAuth(auth), authRefresh, {
        createClient: (token, baseUrl) =>
          createLimitedClient(createClient(token, baseUrl), rateLimitOptions),
      })
    : createLimitedClient(createClient(auth.token, auth.baseUrl), rateLimitOptions)

  const vault = new VaultManager(client, config.vault.pageId)
  const driftCheck = await resolveDriftCheck(configRoot, options.driftCheck)
  await vault.load({ driftCheck })

  const db = vault.databases
  const projects = new ProjectService(client, db.projects)
  const topics = new TopicService(client, db.topics)
  const memories = new MemoryService(client, db.memories)
  const facts = new FactService(client, db.facts)
  // Decisions are backed by the Memories DB — same DatabaseRef, different
  // business logic (Kind = decision discriminator, supersession chains,
  // index-tier listings without body fetch).
  const decisions = new DecisionService(client, db.memories)
  // Tasks (P3-02) are likewise Memories-DB backed via the `Kind = task`
  // discriminator. Tasks are the canonical surface for tracked work.
  const tasks = new TaskService(client, db.memories)
  // PF3-01 — Entities DB is optional on legacy vaults. Wire up the
  // service only when the database exists; downstream code paths
  // already null-check `services.entities` and fall back to the
  // SubjectKey/Subject substring path.
  const entities = db.entities ? new EntityService(client, db.entities) : null

  const resolution = await resolveProject(cwd, configRoot, config, projects)

  // Resolve engineer identity once at startup so every save in this
  // process stamps the same author. Best-effort — `resolveAuthorIdentity`
  // never throws; a `users.me` failure degrades to `{ author: null }`
  // and the Author column stays empty for this session.
  const identity = await resolveAuthorIdentity(client)

  return {
    vault,
    projects,
    topics,
    memories,
    facts,
    decisions,
    tasks,
    entities,
    context: {
      vault: vault.get(),
      project: resolution.project,
      cwd,
      isCatchAllFallback: resolution.isCatchAllFallback,
    },
    config,
    configRoot,
    sessionMemories: new SessionMemoryTracker(),
    identity,
  }
}

export function createNtnAuthRefresh(
  initialAuth: ResolvedAuth,
  configRoot: string,
  config: LoreConfig
): RefreshClientAuth | undefined {
  if (initialAuth.source !== "ntn-auth-json") return undefined

  let lastFailedAuth: ClientAuthSnapshot | null = null
  let lastFailureMs = 0

  function cacheRefreshFailure(
    auth: ClientAuthSnapshot,
    errorMessage?: string
  ): ClientAuthRefreshOutcome {
    lastFailedAuth = auth
    lastFailureMs = Date.now()
    return { kind: "unavailable", errorMessage }
  }

  return async (current) => {
    if (
      lastFailedAuth &&
      sameClientAuth(lastFailedAuth, current) &&
      Date.now() - lastFailureMs < AUTH_REFRESH_UNAVAILABLE_CACHE_MS
    ) {
      return { kind: "unavailable" }
    }

    let nextAuth: ResolvedAuth
    try {
      nextAuth = await resolveAuth(config, configRoot)
    } catch (err) {
      return cacheRefreshFailure(current, errorMessage(err))
    }

    const next = toClientAuth(nextAuth)
    lastFailedAuth = null
    if (sameClientAuth(next, current)) {
      return { kind: "unchanged" }
    }

    return { kind: "refreshed", auth: next, source: nextAuth.source }
  }
}

function toClientAuth(auth: Pick<ResolvedAuth, "token" | "baseUrl">): ClientAuthSnapshot {
  return { token: auth.token, baseUrl: auth.baseUrl }
}

function sameClientAuth(a: ClientAuthSnapshot, b: ClientAuthSnapshot): boolean {
  return a.token === b.token && a.baseUrl === b.baseUrl
}

function errorMessage(err: unknown): string | undefined {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === "string" && err.length > 0) return err
  return undefined
}

/**
 * Initialize all services from config. Shared by both MCP server and CLI.
 *
 * `options.driftCheck` controls whether the post-load schema drift scan
 * fires; see `DriftCheckMode`. Defaults to skipping the scan, which keeps
 * narrow CLI surfaces (search / mine / digest) off the scan path.
 */
export async function initServices(
  cwd?: string,
  options: InitServicesOptions = {}
): Promise<LoreServices> {
  const workDir = cwd ?? process.cwd()

  // 0.10.0: honor LORE_CONFIG_ROOT for MCP-spawned children.
  // The install path (`buildMcpEnv` in `cli/commands/install.ts`)
  // forwards this static value into the MCP entry so the spawned
  // child resolves the right `.lore.yaml` without re-walking up
  // from the host's spawn-time cwd (which may not match the
  // operator's vault directory). Falls back to the upward search
  // when the env var is unset, preserving the original CLI /
  // hooks paths.
  //
  // Surface a friendly error when the env var points at a
  // directory that lacks `.lore.yaml` so the operator sees
  // guidance rather than the raw `ENOENT` from `loadConfig`.
  //
  // Whitespace-only values (e.g., `LORE_CONFIG_ROOT="   "` from a
  // shell-rc misconfiguration) fall through to the upward search
  // rather than `resolve("   ")` producing cwd-prefix garbage.
  const rawRoot = process.env["LORE_CONFIG_ROOT"]
  const explicitRoot = rawRoot?.trim() ? rawRoot.trim() : undefined
  if (explicitRoot) {
    const root = resolve(explicitRoot)
    const configPath = resolve(root, ".lore.yaml")
    try {
      await access(configPath)
    } catch {
      throw new Error(
        `LORE_CONFIG_ROOT=${root} but no .lore.yaml exists there. ` +
          "Re-run `lore install` from the project directory or unset " +
          "LORE_CONFIG_ROOT to fall back to the upward search."
      )
    }
    const config = await loadConfig(configPath)
    return initServicesFromConfig(workDir, root, config, options)
  }

  const found = await findConfigFile(workDir)
  if (!found) {
    throw new Error("No .lore.yaml found. Run `lore init` to set up a vault.")
  }

  const config = await loadConfig(found.path)
  return initServicesFromConfig(workDir, found.root, config, options)
}

/**
 * Resolve a `DriftCheckMode` into the concrete boolean passed to
 * `VaultManager.load`. Three branches:
 *
 * - explicit `true` → run; the marker is irrelevant (still touched so a
 *   sibling debounced caller starting concurrently sees a fresh marker
 *   and skips its own scan).
 * - explicit `false` (or undefined) → skip; the marker is left untouched.
 * - `"debounced"` → consult the marker. If it's stale (≥
 *   `DRIFT_DEBOUNCE_DAYS` old or missing), touch it now and run; if
 *   fresh, skip. The touch happens *before* the scan fires so a
 *   concurrent debounced caller can't double-fire — the scan itself is
 *   fire-and-forget and a transient failure does not get rolled back
 *   (next debounce window will retry naturally).
 *
 * Touching the marker on the explicit-`true` path keeps the cheap
 * "debounced caller racing against an explicit operator" case from
 * double-firing too.
 *
 * Exported for unit-test coverage; not part of the module's public
 * surface for production callers.
 */
export async function resolveDriftCheck(
  configRoot: string,
  mode: DriftCheckMode | undefined
): Promise<boolean> {
  if (mode === true) {
    await touchDriftMarker(configRoot)
    return true
  }
  if (mode === false || mode === undefined) return false
  // mode === "debounced"
  const ageDays = await driftMarkerAgeDays(configRoot)
  if (ageDays < DRIFT_DEBOUNCE_DAYS) return false
  await touchDriftMarker(configRoot)
  return true
}

/**
 * Drop every in-process resolver cache attached to `services`. Tests
 * call this to force-fresh reads between fixtures; production code
 * leaves the caches alone and lets TTLs do the work.
 */
export function clearServiceCaches(services: LoreServices): void {
  services.projects.clearNameCache()
  services.topics.clearNameCache()
  services.memories.clearTitleCache()
  services.decisions.clearCache()
  services.entities?.clearNameCache()
}
