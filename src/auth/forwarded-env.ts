/**
 * Canonical list of operator-controlled env vars that Lore-spawned
 * children must see in order to resolve auth and the target Notion
 * environment identically to the foreground CLI.
 *
 * Two consumers share this list:
 *
 * - `lore install` writes each key as a
 *   `${VAR}` placeholder into committed MCP entries (Claude / Cursor
 *   .mcp.json, Codex config.toml). The MCP host substitutes the
 *   placeholders from the operator's environment at MCP-spawn time, so
 *   the spawned MCP server's `resolveAuth` lands on the same source as
 *   the operator's foreground shell.
 * - `spawnBackgroundSave` builds a minimal
 *   `safeEnv` for the detached `claude -p` child it spawns from the
 *   Stop-hook autosave / digest paths. Each key forwards conditionally
 *   from `process.env` so the spawned `claude -p` and the MCP child it
 *   in turn launches both reach the right Notion workspace and
 *   environment.
 *
 * Both surfaces serve the same intent — "thread the operator's
 * auth-relevant env into the spawned child" — and the failure mode of
 * drift between them is a silent auth/workspace divergence between
 * foreground and hook-worker code paths. Adding a new key here
 * propagates to both surfaces; removal must be triaged across both.
 *
 * Three families:
 *
 * - **Auth tokens** (`NOTION_API_TOKEN`, `LORE_NOTION_TOKEN`) — the
 *   canonical and legacy bearer-token sources `resolveAuth` walks.
 * - **Workspace + environment selectors** (`NOTION_WORKSPACE_ID`,
 *   `NOTION_ENV`, `NOTION_BASE_URL`, `NOTION_API_BASE_URL`,
 *   `LORE_NOTION_BASE_URL`) — every input `loadNtnToken` and
 *   `resolveOperatorBaseUrl` honor. `NOTION_WORKSPACE_ID` selects the
 *   right workspace from a multi-workspace auth.json; the four
 *   base-URL names map to the dev / staging / prod environment the
 *   spawned child must talk to.
 * - **Per-user attribution override** (`LORE_USER_NAME`) — engineer
 *   display name stamped on Memory `Author` (DEFERRED-ATTRIBUTION).
 *   Forwarded so an operator with the override set keeps the override
 *   on the spawned MCP child without paying a `users.me` round-trip.
 *
 * Static-value forwards (`LORE_CONFIG_ROOT`, `LORE_SUPPRESS_DEPRECATIONS`)
 * do NOT live here — they're literal strings or install-time-derived
 * paths, not references to the operator's env.
 *
 * `LORE_AGENT_NAME` is also intentionally absent. The agent-name flow
 * carries the value through prompt text (`Agent: <name>` line +
 * `Pass agent: "..." verbatim` instruction) for the hook-spawned save
 * agent, and the install path threads it through Codex hook-command
 * prefixes via `buildCodexHookCommand`. Adding it here would
 * double-forward and conflict with the prompt-text path.
 */
/**
 * Declaration order is observable: `lore install` emits Codex
 * `env_vars = [...]` entries in this order, so a refactor that
 * reorders the array will reorder the committed TOML output. Tests
 * pin the current order; reorder deliberately.
 *
 * Multi-workspace correctness depends on `NOTION_WORKSPACE_ID` being
 * set in the operator's foreground shell — forwarding only carries
 * the value across the fork, it does not synthesize one. An ntn user
 * with multiple workspaces in auth.json who relies on
 * single-workspace auto-pick in the foreground will hit the same
 * auto-pick in the spawned child; if the operator runs `ntn login`
 * against a second workspace mid-session, the child's
 * `loadNtnToken` re-reads auth.json and may select a different
 * workspace from the foreground's cached one.
 */
export const RUNTIME_FORWARDED_KEYS = [
  // Auth tokens (canonical first, soft-deprecated second) match
  // `resolveAuth`'s priority chain so an operator reading the array
  // sees the same precedence the runtime applies.
  "NOTION_API_TOKEN",
  "LORE_NOTION_TOKEN",
  // Workspace + environment selectors. `NOTION_WORKSPACE_ID` lives
  // here — not next to the auth tokens — because it picks the
  // workspace from a multi-workspace auth.json, which is an
  // *environment* concern (the same way `NOTION_ENV` selects which
  // Notion deployment the child talks to). The four base-URL names
  // follow `resolveOperatorBaseUrl`'s priority order.
  "LORE_NOTION_BASE_URL",
  "NOTION_WORKSPACE_ID",
  "NOTION_ENV",
  "NOTION_BASE_URL",
  "NOTION_API_BASE_URL",
  // Per-user attribution override (DEFERRED-ATTRIBUTION). Last
  // because it's orthogonal to auth + environment — Memory `Author`
  // affects what gets stamped, not whether the call succeeds.
  "LORE_USER_NAME",
  // Bench-mode write-budget pair (#595). Forwarded so the mining
  // child's `claude -p` inherits them, which in turn inherits them
  // into the `lore mcp` child the agent CLI spawns from `.mcp.json`.
  // Empty / unset in production runs — non-bench callers see no
  // behavior change.
  //
  // **Production callers MUST NOT export these variables in their
  // shell rc.** They opt the in-process Notion client into
  // `wrapWithWriteBudget` against EVERY mutation; the production hook
  // path's autosave / digest children would then install the proxy
  // too and bounce real writes once the (operator-mistaken) cap is
  // hit. The bench-runner exports them per-example and restores them
  // in a `finally`; no other code path should set them.
  "LORE_MCP_WRITE_BUDGET",
  "LORE_MCP_BUDGET_STATE_FILE",
] as const

/**
 * Derived from the array so reorder/extend operations update the
 * type automatically — eliminates the dual-source-of-truth a
 * hand-maintained string-literal union would otherwise require.
 */
export type RuntimeForwardedKey = (typeof RUNTIME_FORWARDED_KEYS)[number]

/**
 * Subset of `RUNTIME_FORWARDED_KEYS` that carry **auth tokens**
 * (`resolveAuth` paths 1 and 3). These are the keys an ntn-source
 * spawn does not need to forward — under `ntn-auth-json` the
 * spawned child's `resolveAuth` resolves the token directly from
 * ~/.config/notion/auth.json at startup (path 2), so the bearer
 * never needs to cross any fork or land in any committed config.
 *
 * Workspace / base-URL selectors and `LORE_USER_NAME` stay
 * conditionally forwarded regardless of auth source — they're
 * still operator-controlled inputs the spawned child needs
 * visibility into to land on the same workspace and environment.
 *
 * **Three consumers read this**, with two distinct motivations:
 *
 * - `buildMcpEnv` ( when `authSource:
 *   "ntn-auth-json"`) skips these keys when assembling the MCP
 *   entry's `env` block. Motivation: a `${NOTION_API_TOKEN}` /
 *   `${LORE_NOTION_TOKEN}` placeholder in a committed .mcp.json
 *   is dead weight that fingerprints the operator's install-time
 *   shell, and hosts whose config validators (e.g. Claude Code's
 *   `/doctor`) check referenced env vars at load time emit
 *   per-key warnings on every startup once those vars are unset,
 *   even though the MCP server itself never needed them.
 * - `spawnBackgroundSave` ( when its
 *   caller passes `authSource: "ntn-auth-json"`) skips these keys
 *   from the detached child's `safeEnv`. Motivation:
 *   bearer-token blast-radius reduction. The child inherits
 *   `process.env` only through the explicit `safeEnv` allowlist,
 *   so dropping the auth-token subset prevents the bearer from
 *   landing in `/proc/<pid>/environ` (Linux) / `ps -wwwE` (macOS)
 *   / debug logs of the third-party agent CLI Lore does not
 *   control. The host-validator warning class doesn't apply here
 *   because the hook-spawn path doesn't write committed config.
 * - `scheduleAutoDigestSpawn` (
 *   when its caller passes `authSource: "ntn-auth-json"`) drops
 *   these keys from the detached `helpers.js auto-digest` child's
 *   inherited env. Same blast-radius motivation as
 *   `spawnBackgroundSave`; closes the parent → auto-digest helper
 *   hop that would otherwise leak the token before the inner
 *   synthesizer spawn's partition runs.
 */
export const RUNTIME_FORWARDED_AUTH_TOKEN_KEYS = [
  "NOTION_API_TOKEN",
  "LORE_NOTION_TOKEN",
] as const satisfies readonly RuntimeForwardedKey[]

export type RuntimeForwardedAuthTokenKey =
  (typeof RUNTIME_FORWARDED_AUTH_TOKEN_KEYS)[number]

import type { AuthSource } from "../config.js"

/**
 * Build the env block a Lore-spawned child inherits when the parent
 * wants the child's `resolveAuth` to land on the same Notion
 * workspace and environment as the foreground process.
 *
 * Always sets the four child-policy keys regardless of `parentEnv`:
 * - `PATH` / `HOME` — minimum POSIX baseline so the child can find
 *   its binary and `os.homedir()` resolves.
 * - `LORE_AUTOSAVE = "false"` — prevents recursive autosave from
 *   the child's own Stop hook firing in turn.
 * - `LORE_BACKGROUND_AGENT = "true"` — opts the child's MCP server
 *   into the fail-fast init mode rather than the diagnostic-stay-up
 *   mode the foreground host wants.
 *
 * Conditionally forwards every key in `RUNTIME_FORWARDED_KEYS` whose
 * value in `parentEnv` is a non-empty string. Empty-string values are
 * dropped to mirror `resolveAuth`'s priority-chain semantics — a
 * declared-but-empty `NOTION_API_TOKEN` would otherwise short-circuit
 * the child's priority walk.
 *
 * Under `authSource === "ntn-auth-json"`, the auth-token subset
 * (`RUNTIME_FORWARDED_AUTH_TOKEN_KEYS`) is partitioned out of the
 * forward. The spawned child re-reads ntn's on-disk auth file
 * directly via `loadNtnToken` (resolveAuth priority 2) and lands on
 * the same token without the bearer crossing the fork boundary in
 * env. Workspace and base-URL selectors still forward — the child
 * needs them to select the same workspace as the foreground. The
 * partition tightens blast radius for the dual-shell-rc operator
 * class (`LORE_NOTION_TOKEN` set in shell while ntn login also
 * present); under any other source the partition is a no-op because
 * the auth-token forward is the only resolution path.
 *
 * Single source of truth shared by every Lore-spawned-child path:
 * detached fire-and-forget save spawn, synchronous awaitable mining
 * seam, future bench-runner-spawned MCP children. A future addition
 * to `RUNTIME_FORWARDED_KEYS` propagates to every caller through
 * this helper rather than requiring lockstep edits at multiple
 * sites.
 */
export function buildSafeEnv(
  authSource: AuthSource | undefined,
  parentEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const skipAuthTokens = authSource === "ntn-auth-json"
  const authTokenKeys: ReadonlySet<RuntimeForwardedKey> = new Set(
    RUNTIME_FORWARDED_AUTH_TOKEN_KEYS,
  )
  const env: Record<string, string> = {
    PATH: parentEnv["PATH"] ?? "",
    HOME: parentEnv["HOME"] ?? "",
    LORE_AUTOSAVE: "false",
    LORE_BACKGROUND_AGENT: "true",
  }
  for (const key of RUNTIME_FORWARDED_KEYS) {
    if (skipAuthTokens && authTokenKeys.has(key)) continue
    const value = parentEnv[key]
    if (typeof value === "string" && value.length > 0) {
      env[key] = value
    }
  }
  return env
}

