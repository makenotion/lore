/**
 * Classify a bearer token by its prefix.
 *
 * Three on-the-wire bearer shapes Lore can encounter:
 *
 * - `ntn_…` — prod personal-access tokens (PATs) issued at
 *   `notion.so/developers/tokens` AND prod `ntn`-issued bot tokens.
 *   Indistinguishable from each other by prefix or `users.me` shape;
 *   only the operator-named integration identity differs.
 * - `development_ntn_…` — dev-environment PATs and `ntn`-issued tokens.
 *   Same parity rule.
 * - `secret_…` — integration tokens from
 *   `notion.so/profile/integrations`. These are valid bearer tokens but
 *   are **integration-level rate-limited**, which re-collapses a team's
 *   isolation into one shared bucket. The 0.10.0 ntn-first move existed
 *   to escape that bucket; PATs preserve the per-user property.
 *
 * The classifier is display-only — it does NOT change `AuthSource` in
 * `src/config.ts`, does NOT route tokens through different code paths,
 * and does NOT influence rate-limit or retry semantics on the wire. It
 * exists so `lore auth --whoami` can surface a one-line label that
 * lets an operator self-diagnose the "I pasted an integration token
 * instead of a PAT" failure mode without reading the docs.
 *
 * Returns `"unknown"` for tokens that don't match any recognized shape
 * (a future Notion shape, a malformed paste, or a non-Notion bearer).
 * Callers render "unknown" as the bare empty-suffix label rather than
 * something alarming — Lore intentionally accepts any non-empty bearer
 * value to stay forward-compatible with future Notion changes.
 */
export type TokenPrefixKind =
  | "personal-prod" // ntn_… (prod PAT or prod ntn bot token)
  | "personal-dev" // development_ntn_… (dev PAT or dev ntn bot token)
  | "integration" // secret_… (integration token; integration-level rate-limited)
  | "unknown"

export function classifyTokenPrefix(token: string): TokenPrefixKind {
  // The order matters: `development_ntn_` must be checked before `ntn_`
  // because `development_ntn_` is not a `ntn_` prefix (the `ntn_` test
  // is anchored to start-of-string), but a future regression that
  // anchored differently could match `ntn_` against the substring.
  // Keep the order explicit so the dev-prefix branch can't be shadowed
  // by a refactor.
  if (token.startsWith("development_ntn_")) return "personal-dev"
  if (token.startsWith("ntn_")) return "personal-prod"
  if (token.startsWith("secret_")) return "integration"
  return "unknown"
}

/**
 * Render a token-prefix classification as a human-readable label, for
 * the parenthetical suffix in `lore auth --whoami` output.
 *
 * Examples (single-line, suitable for `(${label})` wrapping):
 *   `personal token — ntn_`
 *   `personal token — development_ntn_`
 *   `integration token — secret_`
 *
 * The label MUST NOT contain its own parens; `runWhoami` wraps the
 * label in `(…)` and any inner parens would produce nested-paren
 * output. The integration-token rate-limit hint is emitted as a
 * separate stderr advisory in `runWhoami`, not folded into the
 * identity line.
 *
 * Returns `""` (empty string) for the `"unknown"` case so the caller
 * can render a bare identity without an unhelpful "(unknown token)"
 * suffix when a non-Notion bearer (or a future Notion shape) is in
 * play. Stays forward-compatible with future Notion changes — a new
 * prefix Lore doesn't yet recognize falls back to the bare identity
 * rather than mislabelling.
 */
export function describeTokenPrefix(kind: TokenPrefixKind): string {
  switch (kind) {
    case "personal-prod":
      return "personal token — ntn_"
    case "personal-dev":
      return "personal token — development_ntn_"
    case "integration":
      return "integration token — secret_"
    case "unknown":
      return ""
  }
}

/**
 * Companion advisory for `integration`-classified tokens — emitted to
 * stderr by `runWhoami` after the identity line so the stdout
 * identity stays script-friendly (single line, no parenthetical
 * noise). Returns `null` for non-integration kinds so the caller can
 * `if (advisory)` and skip the write.
 */
export function tokenPrefixAdvisory(kind: TokenPrefixKind): string | null {
  if (kind !== "integration") return null
  return (
    "[lore] Heads up: `secret_…` integration tokens are rate-limited per integration. " +
    "For per-user isolation, rotate to a PAT at https://www.notion.so/developers/tokens."
  )
}
