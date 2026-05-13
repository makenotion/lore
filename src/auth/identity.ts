/**
 * Engineer-identity resolution for the per-user attribution path
 * (DEFERRED-ATTRIBUTION). Resolves a human-readable name to stamp on
 * the `Author` column of every Memory row Lore writes.
 *
 * Two sources, in priority order:
 *
 * 1. **`LORE_USER_NAME` env var** — operator-controlled escape hatch,
 *    parallel to `LORE_AGENT_NAME`.
 *    Synchronous, no API call. Wins over `users.me` so an engineer
 *    who wants a different display name than their Notion identity —
 *    or who is running against a workspace bot whose `users.me`
 *    response carries no usable name — has a stable explicit override.
 *    Because this override is process-wide, operators should only set
 *    it in single-engineer processes; it intentionally wins even when
 *    the underlying Notion token rotates.
 * 2. **`client.users.me().bot.owner.user.name`** — the engineer's
 *    Notion identity for ntn-issued tokens. Same shape as the OAuth
 *    response and as the bot identity surfaced by `lore auth
 *    --whoami` via `renderWhoamiIdentity`;
 *    we walk to the deeper `bot.owner.user.name` field rather than
 *    short-circuiting on `bot.workspace_name`, because the workspace
 *    name is the same for every engineer in a team and would
 *    re-fragment attribution. When the response shape doesn't carry
 *    an owner identity at all (rare; non-ntn / non-OAuth tokens),
 *    `resolveAuthorIdentity` returns `null` for the `author` field —
 *    we don't fall back to a workspace-level label because doing so
 *    would defeat the per-engineer signal the `Author` column exists
 *    to provide.
 *
 * Resolver-scoped memoization: `users.me` is a Notion round-trip we'd
 * otherwise pay on every unattributed write. The cache key includes a
 * hash of the active Notion token plus the API base URL so long-lived
 * processes do not reuse attribution across auth changes. Only the
 * latest settled auth snapshot is cached; older in-flight snapshots
 * remain visible just long enough for same-snapshot concurrent callers
 * to share one `users.me` request. In-flight results are not moved to a
 * new key when auth changes underneath them. The raw token is never
 * stored in the cache key. The cache can briefly hold multiple keys
 * (one settled key plus in-flight keys for other auth snapshots) until
 * those in-flight lookups settle and stale settled siblings are evicted.
 *
 * Failures (network, 4xx, unexpected response shape) all collapse to
 * `{ author: null }` and never throw. The Author column is advisory:
 * an unattributed memory is strictly better than a save that fails
 * because identity resolution hit a transient blip. Thrown `users.me`
 * failures are not cached so the next unattributed write can retry;
 * recognized responses with no owner name are cached for the current
 * auth snapshot.
 */

import { createHash } from "node:crypto"
import type { Client } from "@notionhq/client"
import { redactDebugMessage } from "../debug-redact.js"

export interface ResolvedIdentity {
  /**
   * Human-readable display name to stamp on Memory `Author`. `null`
   * when neither the env override nor `users.me` produced a usable
   * value; callers omit the `Author` write rather than stamping a
   * confident-but-wrong placeholder (matches `deriveAgentName`'s
   * undefined-on-no-signal contract).
   */
  author: string | null
}

export interface AuthorIdentityAuthSnapshot {
  token: string
  baseUrl?: string
}

export interface AuthorIdentityResolver {
  /**
   * Resolve the engineer-author name for a write that omitted an explicit
   * `author`. Returns `null` when no trusted signal is available.
   */
  resolveAuthor(): Promise<string | null>
  /** Clear resolver-owned caches. Used by tests and service cache resets. */
  clearCache(): void
}

interface AuthorIdentityLookup {
  identity: ResolvedIdentity
  cacheable: boolean
  errorMessage?: string
}

interface CachedAuthorIdentityLookup {
  promise: Promise<ResolvedIdentity>
  pending: boolean
}

const resolverCaches = new Set<WeakRef<Map<string, CachedAuthorIdentityLookup>>>()

/**
 * Build a lazy author resolver scoped to the active Notion auth context.
 *
 * `getAuthSnapshot` is called on every cache lookup so auth-refreshing
 * clients can move to a new token/base URL without reusing an author
 * resolved under the previous context.
 */
export function createAuthorIdentityResolver(
  client: Client,
  getAuthSnapshot: () => AuthorIdentityAuthSnapshot
): AuthorIdentityResolver {
  const cache = new Map<string, CachedAuthorIdentityLookup>()
  resolverCaches.add(new WeakRef(cache))
  let loggedEnvOverride = false

  return {
    async resolveAuthor() {
      const override = envAuthorOverride()
      if (override) {
        if (!loggedEnvOverride) {
          logIdentityDebug("resolved author (source=env)")
          loggedEnvOverride = true
        }
        return override
      }

      const key = authCacheKey(getAuthSnapshot())
      const cached = cache.get(key)
      if (cached) return (await cached.promise).author

      const lookupPromise = resolveAuthorFromUsersMe(client)
      const entry: CachedAuthorIdentityLookup = {
        pending: true,
        promise: lookupPromise.then((lookup) => {
          entry.pending = false
          if (!lookup.cacheable) {
            if (cache.get(key) === entry) cache.delete(key)
            logIdentityFailure(lookup.errorMessage)
            return lookup.identity
          }

          if (authCacheKey(getAuthSnapshot()) !== key) {
            if (cache.get(key) === entry) cache.delete(key)
            logIdentityDebug(
              `resolved author (source=users.me, author=${authorPresence(
                lookup.identity.author
              )}, cache=skipped-auth-changed)`
            )
            return lookup.identity
          }

          logIdentityDebug(
            `resolved author (source=users.me, author=${authorPresence(
              lookup.identity.author
            )})`
          )
          evictSettledOtherSnapshots(cache, key)
          return lookup.identity
        }),
      }

      // Keep the resolver bounded to the current auth snapshot. Older
      // in-flight lookups remain visible for same-snapshot concurrent
      // callers, but settled stale snapshots cannot accumulate.
      cache.set(key, entry)
      evictSettledOtherSnapshots(cache, key)
      return (await entry.promise).author
    },
    clearCache() {
      cache.clear()
    },
  }
}

/**
 * Resolve the engineer-identity to stamp on a Lore-written memory's
 * `Author` column.
 *
 * Best-effort against `users.me` failures; never throws. Production
 * callers that need caching should use `createAuthorIdentityResolver`.
 */
export async function resolveAuthorIdentity(client: Client): Promise<ResolvedIdentity> {
  const override = envAuthorOverride()
  if (override) return { author: override }

  return (await resolveAuthorFromUsersMe(client)).identity
}

export async function resolveAuthorForWrite(
  explicitAuthor: string | undefined,
  identity: AuthorIdentityResolver
): Promise<string | undefined> {
  if (explicitAuthor !== undefined) return explicitAuthor
  return (await identity.resolveAuthor()) ?? undefined
}

async function resolveAuthorFromUsersMe(client: Client): Promise<AuthorIdentityLookup> {
  try {
    const me = await client.users.me({})
    const author = extractOwnerUserName(me)
    return {
      identity: { author },
      cacheable: true,
    }
  } catch (err) {
    // Any failure — network, 4xx, response-shape change — degrades to
    // null. The resolver does not cache thrown failures, so the next
    // unattributed write under the same auth can retry. Operators who
    // want deterministic attribution under unstable network conditions
    // set LORE_USER_NAME explicitly.
    return {
      identity: { author: null },
      cacheable: false,
      errorMessage: errorMessage(err),
    }
  }
}

function envAuthorOverride(): string | null {
  // Env override wins. Synchronous, no API call. Trim defensively so
  // a `LORE_USER_NAME=" "` shell-rc misconfiguration doesn't stamp
  // whitespace as the author name.
  const override = process.env["LORE_USER_NAME"]
  if (override && override.trim()) return override.trim()
  return null
}

function authCacheKey(snapshot: AuthorIdentityAuthSnapshot): string {
  const tokenHash = createHash("sha256").update(snapshot.token).digest("hex")
  return `${snapshot.baseUrl ?? ""}\u0000${tokenHash}`
}

function authorPresence(author: string | null): "present" | "missing" {
  return author ? "present" : "missing"
}

function logIdentityFailure(message: string | undefined): void {
  // Route the SDK-derived message through the shared `LORE_DEBUG`
  // redactor before it lands in the operator's stderr.
  // `users.me` failures are exactly the path where the Notion SDK is
  // most likely to interpolate request-scoped detail (per-token
  // base-URL, response shape) into `Error.message`; the redactor
  // bounds length and scrubs page-id-shaped substrings before the
  // line is written.
  const suffix = message ? `: ${redactDebugMessage(message)}` : ""
  logIdentityDebug(`users.me failed${suffix}`)
}

function logIdentityDebug(message: string): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(`[lore] identity: ${message}\n`)
}

function errorMessage(err: unknown): string | undefined {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === "string" && err.length > 0) return err
  return undefined
}

function evictSettledOtherSnapshots(
  cache: Map<string, CachedAuthorIdentityLookup>,
  currentKey: string
): void {
  for (const [cachedKey, cached] of cache) {
    if (cachedKey !== currentKey && !cached.pending) cache.delete(cachedKey)
  }
}

/**
 * Walk the `users.me` response to the engineer's display name.
 *
 * For ntn-issued tokens (and the OAuth flow's bot tokens), `users.me`
 * returns a `Bot` object whose `bot.owner.user.{id, name}` carries the
 * engineer who authorized the integration. Workspace-owned bots and
 * legacy integrations may not have this nested shape; we return `null`
 * rather than substituting a workspace-level label so attribution
 * stays per-engineer.
 *
 * Internal helper — not exported. Tests reach the failure-mode branches
 * by mocking `client.users.me` and calling `resolveAuthorIdentity`
 * through its public surface, keeping the JSON walker private while the
 * module exposes resolver construction and the uncached probe helper.
 */
function extractOwnerUserName(me: unknown): string | null {
  if (typeof me !== "object" || me === null) return null
  const bot = (me as { bot?: unknown }).bot
  if (typeof bot !== "object" || bot === null) return null
  const owner = (bot as { owner?: unknown }).owner
  if (typeof owner !== "object" || owner === null) return null
  const user = (owner as { user?: unknown }).user
  if (typeof user !== "object" || user === null) return null
  const name = (user as { name?: unknown }).name
  if (typeof name === "string" && name.trim().length > 0) return name.trim()
  return null
}

/**
 * Drop resolver-owned identity caches. Passing a resolver clears that
 * resolver only; omitting it clears every live resolver created in this
 * process, preserving the pre-lazy public reset shape for external callers.
 */
export function resetIdentityCache(): void
export function resetIdentityCache(resolver: AuthorIdentityResolver): void
export function resetIdentityCache(resolver?: AuthorIdentityResolver): void {
  if (resolver) {
    resolver.clearCache()
    return
  }

  for (const ref of resolverCaches) {
    const cache = ref.deref()
    if (!cache) {
      resolverCaches.delete(ref)
      continue
    }
    cache.clear()
  }
}
