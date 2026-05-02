/**
 * Canonical list of operator-controlled env vars that Lore-spawned
 * children must see in order to resolve auth and the target Notion
 * environment identically to the foreground CLI.
 *
 * Two consumers share this list:
 *
 * - `lore install` (`src/cli/commands/install.ts`) writes each key as a
 *   `${VAR}` placeholder into committed MCP entries (Claude / Cursor
 *   `.mcp.json`, Codex `config.toml`). The MCP host substitutes the
 *   placeholders from the operator's environment at MCP-spawn time, so
 *   the spawned MCP server's `resolveAuth` lands on the same source as
 *   the operator's foreground shell.
 * - `spawnBackgroundSave` (`src/hooks/background.ts`) builds a minimal
 *   `safeEnv` for the detached `claude -p` child it spawns from the
 *   Stop-hook autosave / digest paths. Each key forwards conditionally
 *   from `process.env` so the spawned `claude -p` and the MCP child it
 *   in turn launches both reach the right Notion workspace and
 *   environment.
 *
 * Both surfaces serve the same intent — "thread the operator's
 * auth-relevant env into the spawned child" — and the failure mode of
 * drift between them is a silent auth/workspace divergence between
 * foreground and hook-worker code paths (#188). Adding a new key here
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
 *   right workspace from a multi-workspace `auth.json`; the four
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
 * prefixes (see `buildCodexHookCommand`). Adding it here would
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
 * with multiple workspaces in `auth.json` who relies on
 * single-workspace auto-pick in the foreground will hit the same
 * auto-pick in the spawned child; if the operator runs `ntn login`
 * against a second workspace mid-session, the child's
 * `loadNtnToken` re-reads `auth.json` and may select a different
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
  // workspace from a multi-workspace `auth.json`, which is an
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
] as const

/**
 * Derived from the array so reorder/extend operations update the
 * type automatically — eliminates the dual-source-of-truth a
 * hand-maintained string-literal union would otherwise require.
 */
export type RuntimeForwardedKey = (typeof RUNTIME_FORWARDED_KEYS)[number]
