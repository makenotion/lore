/**
 * Engineer-identity resolution for the per-user attribution path
 * (DEFERRED-ATTRIBUTION). Resolves a human-readable name to stamp on
 * the `Author` column of every Memory row Lore writes.
 *
 * Two sources, in priority order:
 *
 * 1. **`LORE_USER_NAME` env var** — operator-controlled escape hatch,
 *    parallel to `LORE_AGENT_NAME` (see `src/hooks/agent-identity.ts`).
 *    Synchronous, no API call. Wins over `users.me` so an engineer
 *    who wants a different display name than their Notion identity —
 *    or who is running against a workspace bot whose `users.me`
 *    response carries no usable name — has a stable explicit override.
 * 2. **`client.users.me().bot.owner.user.name`** — the engineer's
 *    Notion identity for ntn-issued tokens. Same shape as the OAuth
 *    response and as the bot identity surfaced by `lore auth
 *    --whoami` (see `src/cli/commands/auth.ts:renderWhoamiIdentity`);
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
 * Per-process memoization: `users.me` is a single Notion round-trip
 * we'd otherwise pay on every save. The cache key is "this process,
 * this env state" — `LORE_USER_NAME` is read at first call and cached
 * for the lifetime of the process. Tests reset via
 * `resetIdentityCache()`.
 *
 * Failures (network, 4xx, unexpected response shape) all collapse to
 * `{ author: null }` and never throw. The Author column is advisory:
 * an unattributed memory is strictly better than a save that fails
 * because identity resolution hit a transient blip.
 */

import type { Client } from "@notionhq/client"

export interface ResolvedIdentity {
  /**
   * Human-readable display name to stamp on Memory `Author`. `null`
   * when neither the env override nor `users.me` produced a usable
   * value; callers omit the `Author` write rather than stamping a
   * confident-but-wrong placeholder (mirrors `deriveAgentName`'s
   * undefined-on-no-signal contract).
   */
  author: string | null
}

let cached: ResolvedIdentity | undefined

/**
 * Resolve the engineer-identity to stamp on every Lore-written memory's
 * `Author` column.
 *
 * Returns the same value on every call within one process (memoized).
 * Best-effort against `users.me` failures; never throws.
 */
export async function resolveAuthorIdentity(
  client: Client,
): Promise<ResolvedIdentity> {
  if (cached !== undefined) return cached

  // Env override wins. Synchronous, no API call. Trim defensively so
  // a `LORE_USER_NAME=" "` shell-rc misconfiguration doesn't stamp
  // whitespace as the author name.
  const override = process.env["LORE_USER_NAME"]
  if (override && override.trim()) {
    cached = { author: override.trim() }
    return cached
  }

  try {
    const me = await client.users.me({})
    cached = { author: extractOwnerUserName(me) }
    return cached
  } catch {
    // Any failure — network, 4xx, response-shape change — degrades to
    // null. The Author column stays empty for this session; the next
    // process restart will retry. Operators who want deterministic
    // attribution under unstable network conditions set
    // LORE_USER_NAME explicitly.
    cached = { author: null }
    return cached
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
 * through its public surface, keeping the module's external API to
 * `resolveAuthorIdentity` + `resetIdentityCache`.
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
 * Drop the per-process identity cache. Tests call this between
 * fixtures so a stub returning a different `users.me` shape doesn't
 * see the previous run's cached value.
 */
export function resetIdentityCache(): void {
  cached = undefined
}
