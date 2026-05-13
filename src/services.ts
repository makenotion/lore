/**
 * Shared service initialization.
 *
 * The LoreServices interface and initServices() function are used by both
 * the MCP server and CLI commands. Extracted here to avoid a dependency
 * from CLI → MCP layer.
 */

import { access } from "node:fs/promises"
import { resolve } from "node:path"
import type { Client } from "@notionhq/client"
import {
  findConfigFile,
  loadConfig,
  resolveAuth,
  type AuthSource,
  type ResolvedAuth,
} from "./config.js"
import {
  createAuthRefreshingClient,
  createClient,
  type ClientAuthSnapshot,
  type ClientAuthRefreshOutcome,
  type RefreshClientAuth,
} from "./notion/client.js"
import { createLimitedClient } from "./notion/rate-limit.js"
import {
  isRunToolBlockEditEnabled,
  isRunToolEnabled,
  isRunToolFilterSqlEnabled,
} from "./notion/runtool/index.js"
import { warnRunToolIntegrationSecretOnce } from "./notion/runtool/error-helpers.js"
import { VaultManager } from "./core/vault.js"
import { ProjectService } from "./core/project.js"
import { TopicService } from "./core/topic.js"
import { MemoryService } from "./core/memory.js"
import { FactService } from "./core/fact.js"
import { DecisionService } from "./core/decision.js"
import { TaskService } from "./core/task.js"
import { EntityService } from "./core/entity.js"
import { resolveProject } from "./core/context.js"
import { WakeUpCache } from "./core/wakeup-cache.js"
import {
  buildUpstreamVaultBundles,
  type UpstreamVaultBundle,
} from "./core/topology-readers.js"
import {
  createAuthorIdentityResolver,
  type AuthorIdentityResolver,
} from "./auth/identity.js"
import {
  DRIFT_DEBOUNCE_DAYS,
  driftMarkerAgeDays,
  touchDriftMarker,
} from "./hooks/drift-marker.js"
import { SessionMemoryTracker } from "./session-memory-tracker.js"
import type {
  LoreConfig,
  MemoryScopeContext,
  ResolvedContext,
  VaultDatabases,
} from "./types.js"
import { FACT_PROPS, MEMORY_PROPS } from "./notion/schema.js"

/**
 * Build the per-process `MemoryScopeContext` that `MemoryService` and
 * `FactService` use to filter narrow-scope rows out of default reads.
 *
 * Slots are populated from environment variables exported by the
 * caller — the same env-driven posture as the existing
 * `LORE_AGENT_NAME` / `LORE_USER_NAME` resolution. Slots not exported
 * remain undefined, which means "no narrow-scope row of that kind
 * surfaces in default retrieval" — consistent with the no-identity
 * branch of the scope filter.
 *
 * | Env var               | Slot          |
 * | --------------------- | ------------- |
 * | `LORE_USER_NAME`      | `userId`      |
 * | `LORE_AGENT_NAME`     | `agent`       |
 * | `LORE_ROLE`           | `role`        |
 * | `LORE_SESSION_ID`     | `session`     |
 * | `LORE_RUN_ID`         | `run`         |
 * | `LORE_ENVIRONMENT`    | `environment` |
 *
 * Empty / whitespace-only env values normalize to undefined so a
 * caller that exports `LORE_SESSION_ID=""` doesn't accidentally
 * surface every session-scoped row whose `Scope Key` is also empty.
 *
 * Pure function over `process.env` — no Notion calls, no async work.
 * Tests can override by passing a populated context to the
 * `MemoryService` / `FactService` constructors directly or via
 * `setScopeContext`.
 */
/**
 * Probe the live Memories and Facts data sources for the scope
 * columns. Returns `true` when both DBs declare `Scope Kind` and
 * `Expires At`; returns `false` when either column is missing on
 * either DB.
 *
 * Used at services init to decide whether the default scope filter
 * is safe to enable. A vault that hasn't yet run `lore migrate` has
 * no scope columns, so threading the filter through every read would
 * fail with `validation_error` on the first call; the probe lets us
 * gracefully degrade to unscoped retrieval shape until migration
 * runs.
 *
 * The probe is one fan-out of `dataSources.retrieve` calls (already
 * gated by the rate-limit middleware) — single round-trip cost paid
 * once per process. Failure (transient 5xx, rate-limit blip) is
 * caught at the call site; on probe failure the caller falls back to
 * the optimistic "columns exist" branch so a transient blip at
 * startup doesn't disable scope filtering for the entire process.
 */
export async function probeScopeColumnsPresent(
  client: Client,
  db: VaultDatabases
): Promise<boolean> {
  const [memoriesDs, factsDs] = await Promise.all([
    client.dataSources.retrieve({ data_source_id: db.memories.dataSourceId }),
    client.dataSources.retrieve({ data_source_id: db.facts.dataSourceId }),
  ])
  const memProps = (memoriesDs as { properties: Record<string, unknown> }).properties
  const factProps = (factsDs as { properties: Record<string, unknown> }).properties
  // Check the two load-bearing columns on each DB. The other three
  // (`Scope Key`, `Audience`, `Lifetime`) ride along — Notion's
  // schema migration is per-DB additive, so the migration adds all
  // five columns in lockstep on each DB. Checking two per DB is
  // enough to detect "migration has not run on this DB."
  return (
    MEMORY_PROPS.SCOPE_KIND in memProps &&
    MEMORY_PROPS.EXPIRES_AT in memProps &&
    FACT_PROPS.SCOPE_KIND in factProps &&
    FACT_PROPS.EXPIRES_AT in factProps
  )
}

/**
 * Resolve the batch-creates feature flag from the
 * environment.
 *
 * **The write-path flag does NOT inherit from the parent
 * `LORE_USE_RUNTOOL` quarantine knob.** Parity with the read-path
 * sub-flags (search / aggregate) would be a footgun: an operator
 * setting `LORE_USE_RUNTOOL=1` to dogfood a future read path would
 * silently enable a write-path experiment with a partial-commit
 * failure mode. The runtool quarantine framing also paints the
 * parent flag as a read-path knob ("two read-path cleanup wins"),
 * which is at odds with implicit write-path enablement. Write-path
 * sub-flags should be loud — operators must opt in explicitly with
 * `LORE_USE_RUNTOOL_BATCH_CREATES=1`.
 *
 * Resolution table:
 *
 * | `LORE_USE_RUNTOOL_BATCH_CREATES` | `LORE_USE_RUNTOOL` | Result |
 * | -------------------------------- | ------------------ | ------ |
 * | `"1"`                            | (any)              | true   |
 * | (anything else)                  | (any)              | false  |
 *
 * Default-off is the safety contract: an operator with no env vars
 * set sees the non-batched auto-mention emission path, and
 * `lore migrate --dedup-keys --merge` is the authoritative collapse
 * path for any duplicates a future flag-on rollout might leak.
 *
 * The fail-loud-on-typo posture matters here because malformed
 * sub-flag strings (`"true"`, `"yes"`, `"on"`) would silently
 * fall through to the parent flag if accepted. The sub-flag reads
 * strictly: any value other than `"1"` is treated as "off."
 *
 * Read the env once at services-init time so the flag does not flip
 * mid-process. Tests that need to flip should call
 * `services.facts.setUseRunToolBatchCreates(true)` directly rather
 * than mutating `process.env`.
 */
export function resolveRunToolBatchCreatesFlag(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env["LORE_USE_RUNTOOL_BATCH_CREATES"] === "1"
}

/**
 * Derive the user-facing host root that RunTool's `create_pages`
 * relation property values must use, given the resolved API host.
 *
 * **Empirical findings (live verification):**
 * the server validates the relation URL host against the
 * workspace's user-facing domain and rejects mismatches with
 * `400 validation_error: Invalid page URL ... for property X`.
 * Bare ids and the wrong host (`www.notion.so` against a dev
 * workspace, `notion.com` anywhere) all produce that error.
 * The mapping below was verified live:
 *
 * | API host (`auth.baseUrl`)            | User-facing relation URL base |
 * | ------------------------------------ | ----------------------------- |
 * | `https://api-dev.notion.com`         | `https://dev.notion.so/`      |
 * | `https://api.notion.com` (default)   | `https://www.notion.so/`      |
 * | undefined / unknown                  | `https://www.notion.so/`      |
 *
 * The unknown-host fallback to `www.notion.so` matches the
 * production default — operators on bespoke configurations who
 * need a different mapping should override `auth.baseUrl` to
 * something this helper recognizes (or fall back to the per-input
 * REST `pages.create` path, which accepts plain page ids
 * regardless of host).
 */
export function deriveRelationUrlBase(apiBaseUrl: string | undefined): string {
  if (apiBaseUrl === undefined || apiBaseUrl === null) {
    return "https://www.notion.so/"
  }
  const lower = apiBaseUrl.toLowerCase()
  if (lower.includes("api-dev.notion.com") || lower.includes("api.dev.notion")) {
    return "https://dev.notion.so/"
  }
  return "https://www.notion.so/"
}

export function resolveMemoryScopeContext(): MemoryScopeContext {
  const ctx: MemoryScopeContext = {}
  const slot = (env: string): string | undefined => {
    const raw = process.env[env]
    if (raw === undefined) return undefined
    const trimmed = raw.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  const userId = slot("LORE_USER_NAME")
  if (userId !== undefined) ctx.userId = userId
  const agent = slot("LORE_AGENT_NAME")
  if (agent !== undefined) ctx.agent = agent
  const role = slot("LORE_ROLE")
  if (role !== undefined) ctx.role = role
  const session = slot("LORE_SESSION_ID")
  if (session !== undefined) ctx.session = session
  const run = slot("LORE_RUN_ID")
  if (run !== undefined) ctx.run = run
  const environment = slot("LORE_ENVIRONMENT")
  if (environment !== undefined) ctx.environment = environment
  return ctx
}

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
  /**
   * Shared Notion SDK client for this process. This is the same
   * auth-refreshing, rate-limited Proxy used by every service below; callers
   * that need vault-adjacent reads should reuse it instead of creating a
   * second limiter/token-refresh island.
   */
  client: Client
  vault: VaultManager
  projects: ProjectService
  topics: TopicService
  memories: MemoryService
  facts: FactService
  decisions: DecisionService
  tasks: TaskService
  /**
   * Canonical-entity registry. Required because vault verification now
   * requires the Entities database alongside Projects, Topics, Memories,
   * and Facts.
   */
  entities: EntityService
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
   * Lazy engineer identity resolver for Memory `Author` attribution
   * (DEFERRED-ATTRIBUTION). Write paths call it only when the caller
   * omitted an explicit author. `LORE_USER_NAME` resolves synchronously;
   * otherwise it falls back to `users.me().bot.owner.user.name` and
   * caches that best-effort result by the active Notion token/base URL.
   *
   * Required (not optional) so a future refactor that forgets to
   * populate it in a new init seam fails the typecheck rather than
   * silently no-opping attribution.
   */
  identity: AuthorIdentityResolver
  /**
   * Which source produced the resolved token.
   * Surfaced here so downstream paths — notably the autosave / digest
   * background spawns — can apply the auth-source-aware env partition
   * (skip bearer-token forwarding when the child can re-resolve from
   * ~/.config/notion/auth.json directly) without re-running
   * `resolveAuth`. Matches the install-path partition in
   * `buildMcpEnv`.
   *
   * Required (not optional) so a future refactor that forgets to
   * populate it in a new init seam fails the typecheck rather than
   * silently no-opping the partition. Same posture as the
   * `identity` field above: the typecheck is the load-bearing
   * defense against silent regressions of cross-cutting contracts.
   */
  authSource: AuthSource
  /**
   * Process-local wake-up aggregator cache. The
   * long-running MCP server threads this into `loadWakeUpData` so
   * back-to-back wake-ups within one user turn skip the ~10-call
   * fan-out. Every MCP write action calls `wakeupCache.bumpEpoch()`
   * so a save followed by a wake-up re-fetches; the 30s TTL is the
   * cross-process staleness ceiling.
   *
   * Hooks and CLI commands construct
   * services per invocation and exit, so they never observe a cache
   * hit. They still thread the cache for type uniformity. See
   * `WakeUpCache`'s header docstring for the surface picture and the
   * cross-process follow-up.
   *
   * Required (not optional) so a future refactor that forgets to
   * populate it in a new init seam fails the typecheck rather than
   * silently degrading caching to per-call fan-out.
   */
  wakeupCache: WakeUpCache
  /**
   * Resolved scope context for the current process.
   * `MemoryService` and `FactService` already hold their own copies
   * via `setScopeContext`; this snapshot is exposed on the services
   * bundle so MCP audit responses, the `lore status` rendering, and
   * a future operator-facing CLI can surface "which identity slots
   * are populated for this session." Empty when no `LORE_*` env vars
   * are set.
   */
  scopeContext: MemoryScopeContext
  /**
   * Per-upstream read-only service bundles ("Read
   * inheritance"). One entry per configured `upstreamVaults` row in
   * .lore.yaml, sorted by priority ascending. `[]` on single-vault
   * configs — single-vault behavior collapses to the unchanged
   * single-vault read path because no fan-out branch reaches this
   * surface when the list is empty.
   *
   * Each bundle lazy-loads the upstream on first access via
   * `loadReaders()`, returning `{ memories }` for read paths to fan
   * out across. (A future fact-side inheritance surface would
   * extend the readers shape — `UpstreamReaders` is the canonical type
   * today.) The shared primary client is reused so the process-wide
   * rate-limit bucket governs the combined fan-out.
   * Load failures degrade gracefully: `loadReaders()` returns `null`
   * and `bundle.lastError` carries the error; wake-up renders only
   * the surviving upstreams.
   *
   * Promotion targets are NOT exposed here. Promotion is a deliberate
   * write surface (`lore promote`, `lore-memory action='promote'`),
   * not a read-orchestration surface. Including promotion targets in
   * `upstreams` would let read paths silently fan out to vaults the
   * operator designated for review-gated writes only.
   *
   * `readonly` on the array is defense-in-depth — callers that
   * mutate the upstream list at runtime would silently re-shape
   * inheritance for every subsequent `loadWakeUpData` call.
   */
  upstreams: readonly UpstreamVaultBundle[]
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
  const authSnapshotRef = { current: toClientAuth(auth) }
  const identityRef: { current?: AuthorIdentityResolver } = {}
  const rateLimitOptions = config.notion?.rateLimit ?? {}
  // Every downstream service shares the same rate-limited Proxy so fan-out
  // stays under Notion's per-token rps ceiling without per-call-site work.
  // The wrapper governs concurrency (fan-out memory), request rate (token
  // bucket), and 429 shared backoff; defaults match Notion's ~3 rps
  // public guidance. The RunTool wrapper
  // dispatches through `client.request()`, which IS proxied here, so
  // RunTool calls automatically share this gate.
  const client = authRefresh
    ? createAuthRefreshingClient(authSnapshotRef.current, authRefresh, {
        createClient: (token, baseUrl) =>
          createLimitedClient(createClient(token, baseUrl), rateLimitOptions),
        onAuthChange: (nextAuth) => {
          authSnapshotRef.current = nextAuth
          identityRef.current?.clearCache()
        },
      })
    : createLimitedClient(createClient(auth.token, auth.baseUrl), rateLimitOptions)

  // Warn-once if a RunTool feature flag is on AND the resolved auth
  // source is a known integration-secret path that RunTool will
  // reject with 403. Without this, every flagged-on call silently
  // falls back to REST and the operator sees zero RunTool traffic.
  if (
    isRunToolEnabled() ||
    isRunToolBlockEditEnabled() ||
    isRunToolFilterSqlEnabled()
  ) {
    warnRunToolIntegrationSecretOnce(auth.source)
  }

  // When authRefresh is absent, the auth snapshot is intentionally static:
  // env/config token sources do not rotate within one process. Any future
  // non-refreshing token-rotation path must update authSnapshotRef and clear
  // the identity resolver cache just like the onAuthChange branch above.

  const vault = new VaultManager(client, config.vault.pageId)
  const driftCheck = await resolveDriftCheck(configRoot, options.driftCheck)
  await vault.load({ driftCheck })

  const db = vault.databases
  const projects = new ProjectService(client, db.projects)
  const topics = new TopicService(client, db.topics)
  // Resolve the per-process scope context. Populated from environment
  // variables that callers (CLI commands, MCP host wrappers, hooks)
  // export deliberately. Empty defaults are safe — the default scope
  // filter falls back to "broadcast-only" when an identity slot is
  // missing, so retrieval is consistent on a vault that never declares
  // scope.
  //
  // Migration safety: the scope filter references `Scope Kind` and
  // `Expires At` columns. If those columns are missing on a legacy
  // vault that hasn't yet run `lore migrate`, every default read
  // would fail with a `validation_error`. We probe the live schema
  // once at startup and disable the filter when the columns are
  // absent — recall on legacy vaults stays byte-identical to the
  // non-scoped retrieval shape until the operator runs migration. A
  // one-line stderr notice surfaces the gap so the operator knows to
  // run `lore migrate`.
  const scopeCtx = resolveMemoryScopeContext()
  const scopeColumnsReady = await probeScopeColumnsPresent(client, db).catch(
    () => {
      // Probe failure (transient 5xx, rate-limit blip) is the
      // conservative branch: assume the columns exist and let any
      // genuine missing-property error surface from the first read.
      // The alternative (assume missing, disable scope) would silently
      // turn off the filter on a working vault for the entire process
      // lifetime when one transient retrieve blip happens at startup.
      return true
    }
  )
  if (!scopeColumnsReady) {
    process.stderr.write(
      "[lore] scope/lifetime columns missing on this vault — recall " +
        "is using pre-#283 retrieval shape. Run `lore migrate` " +
        "to add Scope Kind / Scope Key / Audience / Lifetime / Expires " +
        "At and enable scope-aware retrieval.\n"
    )
  }
  const effectiveScopeCtx = scopeColumnsReady ? scopeCtx : undefined
  // MemoryService and EntityService route through
  // `runTool(client, "query_data_sources", params)` — the same shared
  // SDK client they already hold, dispatched via `client.request()`
  // which is proxied by `createLimitedClient` and (when applicable)
  // `createAuthRefreshingClient`. No separate runtool object, no
  // parallel rate-limit gate.
  const memories = new MemoryService(client, db.memories, effectiveScopeCtx)
  const facts = new FactService(client, db.facts, effectiveScopeCtx, {
    useRunToolBatchCreates: resolveRunToolBatchCreatesFlag(),
    relationUrlBase: deriveRelationUrlBase(auth.baseUrl),
  })
  // Decisions are backed by the Memories DB — same DatabaseRef, different
  // business logic (Kind = decision discriminator, supersession chains,
  // index-tier listings without body fetch). Scope context threads
  // through so `lore-decision action='list'` and the wake-up
  // Decisions Requiring Attention section apply the same default
  // scope filter as `lore-memory` reads.
  const decisions = new DecisionService(client, db.memories, effectiveScopeCtx)
  // Tasks are likewise Memories-DB backed via the `Kind = task`
  // discriminator. Tasks are the canonical surface for tracked work.
  // Scope context threads through so `lore-task action='list'`
  // applies the same default scope filter.
  const tasks = new TaskService(client, db.memories, effectiveScopeCtx)
  const entities = new EntityService(client, db.entities)

  const resolution = await resolveProject(cwd, configRoot, config, projects)

  // Keep service initialization read-only with respect to author identity:
  // writes lazily resolve a default author only when the caller omitted
  // one. The resolver keys its users.me cache by the active auth snapshot
  // so in-process ntn refreshes do not leak attribution across tokens.
  const identity = createAuthorIdentityResolver(client, () => authSnapshotRef.current)
  identityRef.current = identity

  return {
    client,
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
    authSource: auth.source,
    wakeupCache: new WakeUpCache(),
    scopeContext: scopeCtx,
    upstreams: Object.freeze(buildUpstreamVaultBundles(client, config)),
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
 * fires; the `DriftCheckMode` union enumerates the modes. Defaults to
 * skipping the scan, which keeps narrow CLI surfaces (search / mine /
 * digest) off the scan path.
 */
export async function initServices(
  cwd?: string,
  options: InitServicesOptions = {}
): Promise<LoreServices> {
  const workDir = cwd ?? process.cwd()

  // 0.10.0: honor LORE_CONFIG_ROOT for MCP-spawned children.
  // The install path (`buildMcpEnv`)
  // forwards this static value into the MCP entry so the spawned
  // child resolves the right .lore.yaml without re-walking up
  // from the host's spawn-time cwd (which may not match the
  // operator's vault directory). Falls back to the upward search
  // when the env var is unset, preserving the original CLI /
  // hooks paths.
  //
  // Surface a friendly error when the env var points at a
  // directory that lacks .lore.yaml so the operator sees
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
  services.entities.clearNameCache()
  services.identity.clearCache()
}
