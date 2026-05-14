/**
 * Per-upstream read-only service bundles for the vault topology
 * ("Read inheritance").
 *
 * `LoreServices.upstreams` is a list of `UpstreamVaultBundle` entries,
 * one per configured `upstreamVaults` row. Each bundle exposes a
 * single `loadReaders()` async method that lazy-loads the upstream
 * vault on first call, returning the upstream's `MemoryService` once.
 * (Today's only consumer is wake-up's inherited-memories fan-out;
 * a future fact-side inheritance surface would extend the readers
 * shape but the current type is intentionally narrow.) The shared
 * rate-limited / auth-refreshing Notion client from primary
 * `initServicesFromConfig` is reused — cross-vault fan-out stays
 * under the process-wide rate-limit bucket (the "reuse the
 * existing rate limiter posture per process/token" constraint).
 *
 * Load failures degrade gracefully: `loadReaders()` returns `null`
 * and the bundle's `lastError` carries the underlying error message
 * for the operator to inspect. The first **load** failure per bundle
 * also emits one stderr line (gated on `LORE_DEBUG=1`) so a wake-up
 * that successfully renders the primary section but silently lost an
 * upstream surfaces in operator-debug logs. Subsequent calls within
 * the same process neither retry nor re-emit — `loadReaders()`
 * returns the cached failure sentinel (`null` + the preserved
 * `lastError`). The explicit retry surface is `lore status`, which
 * constructs fresh bundles per invocation governed by the
 * `loadVaultTopologyStatus` short-TTL probe cache.
 *
 * Failures inside the consumer's read path (e.g. an `allSettled`
 * branch in `loadWakeUpData` that fires a `memories.list` against
 * a successfully-loaded readers bundle and gets a transient 429)
 * are NOT emitted here — they surface as the consumer's section
 * `error` field with no separate stderr line. This is deliberate:
 * a transient 429 on one wake-up does not invalidate the bundle's
 * load state, and an unconditional stderr-on-list-failure would
 * fire on every degraded wake-up.
 *
 * Promotion targets are intentionally NOT exposed here: promotion is
 * a deliberate write surface (the `lore promote` CLI / promotion MCP
 * action), not a read-orchestration surface. Promotion writes
 * construct their own `VaultManager` per call inside `promoteMemory`
 * — the `promoteMemory` helper owns that flow. Including promotion targets in
 * `services.upstreams` would invite read paths to silently fan out
 * to a vault the operator designated for review-gated writes only.
 */

import type { Client } from "@notionhq/client"
import { VaultManager } from "./vault.js"
import { MemoryService } from "./memory.js"
import { buildVaultTopology, type UpstreamVaultTopologyRef } from "./topology.js"
import type { LoreConfig, VaultDatabases } from "../types.js"
import { redactDebugError, redactDebugMessage } from "../debug-redact.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import type { LoreFeatureFlags } from "../feature-flags.js"

/**
 * Read-only service bundle for one upstream vault. Today's only
 * consumer is `loadWakeUpData`'s inherited-memories fan-out, which
 * needs the upstream `MemoryService`. A future fact-side
 * inheritance surface (the wake-up `Active Facts` section has a
 * natural slot) would extend this shape with `facts: FactService`,
 * but the type is intentionally narrow today so external consumers
 * cannot build against a field whose contract isn't yet committed to.
 */
export interface UpstreamReaders {
  memories: MemoryService
}

export interface UpstreamVaultBundle {
  /** Configured upstream label (display name from .lore.yaml). */
  readonly label: string
  /** Configured priority — lower fires first in fan-out. */
  readonly priority: number
  /** Configured page id (whatever shape .lore.yaml used). */
  readonly pageId: string
  /**
   * Lazy-load the upstream vault and return its read-only
   * `MemoryService` (`UpstreamReaders` is the canonical type).
   * Caches the result
   * across calls within one process — subsequent calls return the
   * same bundle without re-fetching the upstream vault's child
   * databases. Returns `null` on load failure (e.g. the upstream's
   * page was removed, the operator's auth token can't reach it,
   * the schema diverged past what `VaultManager` accepts);
   * failures degrade gracefully so wake-up keeps working when an
   * upstream is temporarily down.
   *
   * The first failure per bundle emits one stderr line (gated on
   * `LORE_DEBUG=1`); subsequent calls neither retry nor re-emit.
   */
  loadReaders(): Promise<UpstreamReaders | null>
  /**
   * Most recent load error, if any. `null` when the bundle has not
   * yet been loaded, or when the most recent load succeeded.
   * Surfaced for observability (wake-up debug counters, status
   * surfaces); operators triaging "why isn't the inherited section
   * showing up" can read this to see whether the upstream load
   * failed silently.
   */
  readonly lastError: string | null
}

/**
 * Build the per-upstream bundle list from `config.upstreamVaults`.
 * Returns `[]` when no upstreams are configured — single-vault
 * configs see structurally byte-identical behavior across the
 * `services.upstreams` surface (no fan-out, no extra Notion calls,
 * no rendering branches).
 *
 * The shared `client` argument MUST be the primary `initServices`
 * client. Constructing a second `createLimitedClient` per upstream
 * would split the rate-limit bucket and let cross-vault fan-out
 * exceed the per-token Notion quota — exactly the regression issue
 * the "reuse the existing rate limiter posture" rule exists to
 * prevent.
 */
export function buildUpstreamVaultBundles(
  client: Client,
  config: LoreConfig,
  features?: LoreFeatureFlags
): UpstreamVaultBundle[] {
  const topology = buildVaultTopology(config)
  return topology.upstreams.map((upstream) =>
    createUpstreamVaultBundle(client, upstream, features)
  )
}

function createUpstreamVaultBundle(
  client: Client,
  upstream: UpstreamVaultTopologyRef,
  features?: LoreFeatureFlags
): UpstreamVaultBundle {
  // Three states:
  //   - `loaded === false`: never tried. First `loadReaders()`
  //     call dispatches the real load.
  //   - `loaded === true && readers !== null`: success cache.
  //     Subsequent calls return `readers` immediately.
  //   - `loaded === true && readers === null`: failure cache.
  //     Subsequent calls return `null` immediately — they do NOT
  //     re-probe a broken upstream. The retry surface is
  //     `lore status` (which builds its own per-call bundle), not
  //     long-lived MCP wake-up calls.
  let loaded = false
  let cachedReaders: UpstreamReaders | null = null
  let warningEmitted = false
  let lastError: string | null = null

  // The async path resolves at most one in-flight `loadReaders`
  // promise per bundle so concurrent wake-up + status callers
  // converging on the same upstream collapse onto one VaultManager
  // load — same posture as `LruCache.getOrLoad` for cache stampedes.
  let inFlight: Promise<UpstreamReaders | null> | null = null

  const bundle: UpstreamVaultBundle = {
    label: upstream.label,
    priority: upstream.priority,
    pageId: upstream.pageId,
    get lastError() {
      return lastError
    },
    async loadReaders(): Promise<UpstreamReaders | null> {
      if (loaded) return cachedReaders
      if (inFlight) return inFlight

      inFlight = (async () => {
        try {
          const vault = new VaultManager(client, upstream.pageId)
          // Skip drift check on upstream load — upstreams are
          // read-only inheritance, not a write surface, and the
          // operator's `lore migrate` posture is anchored against
          // their primary vault. Drift on an upstream is a signal
          // to surface in `lore status`, not to nudge the operator
          // on every wake-up.
          await vault.load({ driftCheck: false })

          // Migration-safety probe: the primary
          // `initServicesFromConfig` path runs the same probe and
          // passes `undefined` (= filter disabled, legacy retrieval
          // shape) when the vault hasn't yet run `lore migrate`.
          // Mirror that posture on the upstream so an unmigrated
          // upstream's wake-up read uses the legacy retrieval shape
          // instead of failing with a `validation_error` against the
          // missing `Scope Kind` / `Expires At` columns. Without this
          // gate, teams upgrading a fleet to read-inheritance cannot
          // roll out until every upstream vault is migrated —
          // upstream reads must be migration-safe per the same
          // posture as primary.
          //
          // Probe-failure (transient 5xx / rate-limit blip) falls
          // back to "columns present" — same conservative posture
          // as `initServicesFromConfig`. The alternative ("columns
          // missing on probe failure") would silently disable the
          // scope filter for an entire process lifetime on one
          // transient blip; this branch fails closed (filter
          // enabled) so a misconfigured probe doesn't widen the
          // visible upstream surface.
          const scopeColumnsReady = await probeUpstreamScopeColumns(
            client,
            vault.databases
          ).catch((probeErr) => {
            // Surface probe failures under `LORE_DEBUG=1` so an operator triaging
            // "why does this upstream surface narrow-scope rows"
            // can see whether the probe was bypassed via
            // conservative fall-back. Same pattern as the
            // upstream-load-failure emitter below. Defaults to
            // silent because the fall-back posture is
            // conservative (filter stays enabled) and a
            // transient probe blip should not noise stderr on
            // every wake-up.
            if (process.env["LORE_DEBUG"] === "1") {
              const rawLine =
                `[lore] upstream-scope-probe-failed: label=${upstream.label} ` +
                `page=${upstream.pageId} error=${redactDebugError(probeErr)}`
              process.stderr.write(redactDebugMessage(rawLine) + "\n")
            }
            return true
          })
          // Pass an empty `MemoryScopeContext{}` ONLY when the
          // upstream has the scope columns. Empty-context enables
          // the default-scope filter with the "no narrow scopes
          // ever surface" branch. Threading the PRIMARY's
          // scope context would be incorrect: scope keys are
          // vault-local, so a session/user/agent key resolved
          // against the operator's primary vault doesn't refer to
          // the same identity in the upstream.
          //
          // When the upstream is unmigrated, pass `undefined`
          // so the upstream `MemoryService` runs with
          // `scopeFilterEnabled === false` and the read paths
          // skip the scope filter clause entirely — same shape
          // primary reads use against a legacy vault.
          const scopeCtxArg = scopeColumnsReady ? {} : undefined
          const readers: UpstreamReaders = {
            memories: new MemoryService(client, vault.databases.memories, scopeCtxArg, {
              features,
            }),
          }
          loaded = true
          cachedReaders = readers
          lastError = null
          return readers
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          loaded = true
          cachedReaders = null
          lastError = message
          if (!warningEmitted) {
            warningEmitted = true
            // Two layers of protection on the stderr emission:
            //
            //   1. **`LORE_DEBUG=1` gate.** Wake-up runs on every
            //      session start; unconditional stderr would noise
            //      every session that touches a degraded upstream.
            //      Operators triaging a degraded upstream re-run
            //      with `LORE_DEBUG=1` to see the line.
            //
            //   2. **Whole-line redaction.** The line goes through
            //      `redactDebugMessage` (the same scrubber the
            //      capture-side renderer uses), so real Notion page
            //      ids are emitted as `<page-id>` regardless of
            //      whether the operator opted into LORE_DEBUG. Page
            //      ids are recon-class (operator-config locators,
            //      not bearer secrets) but redaction here is
            //      defense-in-depth against leaking vault structure
            //      into a centralized log aggregator. Operators who
            //      genuinely need the raw page id look it up via
            //      `lore status` — labels + page ids surface
            //      verbatim there as an explicit operator-invoked
            //      command, not a hot-path emitter.
            if (process.env["LORE_DEBUG"] === "1") {
              const rawLine =
                `[lore] upstream-vault-unavailable: label=${upstream.label} ` +
                `page=${upstream.pageId} error=${redactDebugError(err)}`
              process.stderr.write(redactDebugMessage(rawLine) + "\n")
            }
          }
          return null
        } finally {
          inFlight = null
        }
      })()

      return inFlight
    },
  }

  return bundle
}

/**
 * Memory-only equivalent of `probeScopeColumnsPresent`. The upstream
 * read path only constructs a `MemoryService` (via `UpstreamReaders`),
 * so probing the Facts DS here would be wasted work — a future
 * fact-side upstream surface can extend this probe with the
 * Facts-DS round-trip.
 *
 * Same migration-safety contract as the primary's probe: returns
 * `true` when the upstream Memories DS carries the load-bearing
 * scope columns (`Scope Kind` + `Expires At`), `false` otherwise.
 * The two columns are sufficient because Notion's per-DB schema
 * migration is additive-in-lockstep — all five scope columns land
 * or none of them do.
 *
 * Lives in this file rather than re-importing from the services
 * module to preserve the core → services import boundary (the
 * services layer is a higher-level init surface; this helper would
 * invert layers if it pulled from there).
 */
async function probeUpstreamScopeColumns(
  client: Client,
  db: VaultDatabases
): Promise<boolean> {
  const memoriesDs = await client.dataSources.retrieve({
    data_source_id: db.memories.dataSourceId,
  })
  const props = (memoriesDs as { properties: Record<string, unknown> }).properties
  return MEMORY_PROPS.SCOPE_KIND in props && MEMORY_PROPS.EXPIRES_AT in props
}
