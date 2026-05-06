/**
 * Env-var resolution for the RunTool feature flags.
 *
 * `LORE_USE_RUNTOOL` is the parent kill-switch / opt-in. Sub-flags
 * inherit from it unless the operator sets them explicitly:
 *
 * - `LORE_USE_RUNTOOL_BLOCK_EDIT` (#534) — gates anchored markdown
 *   edits via `update_page` / `update_content`. Inherits from parent.
 * - `LORE_USE_RUNTOOL_FILTER_SQL` (#535) — gates `query_data_sources`
 *   SQL filter helpers. Inherits from parent.
 *
 * Default state is off for every flag.
 *
 * Each consumer has its own fall-back-shape contract:
 *
 * - **Block-edit (#534)** — flagged-on consumers fall back to the
 *   existing REST/SDK path on the structured `RunToolBlockEditError`
 *   kinds (`no_match` / `multiple_matches` / `deletion_warning` /
 *   `restricted_resource`). Transient transport errors propagate.
 * - **Filter-SQL (#535)** — flagged-on consumers fall back per-call
 *   on `SqlPartialResultError` (saturated `has_more: true` window)
 *   and on every non-`isSqlValidationError(err)` SDK error (401,
 *   429, 5xx, network blip, malformed body). Validation errors
 *   (400 / `validation_error`) escalate to the operator so query-
 *   shape drift surfaces instead of silently masking. Transient
 *   transport errors propagate up through the proxy chain so
 *   `createLimitedClient`'s 429 backoff and
 *   `createAuthRefreshingClient`'s 401 retry stay authoritative.
 *
 * 200-wrapped `{ object: "error" }` envelopes from the `tools/run`
 * gateway are normalized into thrown `APIResponseError`s at the
 * SDK-`request` layer (`wrapWithRunToolEnvelopeNormalizer` in
 * `src/notion/client.ts`) so the proxy chain catches the throw
 * exactly as it would a native non-2xx error. Without that
 * normalization, the rate-limit and auth-refresh hooks would never
 * engage on gateway-shaped errors. See
 * `src/notion/runtool/client.ts` and the "Canonical
 * Error-Classification Vocabulary" section in
 * `src/notion/runtool/README.md` for the full contract.
 *
 * Same posture as the existing `LORE_DISABLE_*` switches in
 * `src/core/` — env-var checked at the call site, not threaded
 * through `.lore.yaml`, so an operator can flip behavior without
 * editing config.
 */

const FLAG_TRUTHY = new Set(["1", "true", "yes", "on"])
const FLAG_FALSY = new Set(["0", "false", "no", "off", ""])

function readFlag(env: NodeJS.ProcessEnv, name: string): boolean | null {
  const raw = env[name]
  if (raw === undefined) return null
  const normalized = raw.trim().toLowerCase()
  if (FLAG_TRUTHY.has(normalized)) return true
  if (FLAG_FALSY.has(normalized)) return false
  return null
}

/** True when `LORE_USE_RUNTOOL` is opted in. Default off. */
export function isRunToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readFlag(env, "LORE_USE_RUNTOOL") === true
}

/**
 * True when the block-edit sub-flag is on. An explicit
 * `LORE_USE_RUNTOOL_BLOCK_EDIT` setting wins; otherwise the value
 * inherits from `LORE_USE_RUNTOOL`. Off by default.
 *
 * The inheritance lets an operator rolling out RunTool flip the parent
 * once and pick up the block-edit branch automatically, while still
 * leaving the per-feature switch available for narrower experiments
 * (e.g. on for search but off for block edits during dogfood).
 */
export function isRunToolBlockEditEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const explicit = readFlag(env, "LORE_USE_RUNTOOL_BLOCK_EDIT")
  if (explicit !== null) return explicit
  return isRunToolEnabled(env)
}

/**
 * True when the issue #535 SQL filter sub-flag is on. An explicit
 * `LORE_USE_RUNTOOL_FILTER_SQL` setting wins; otherwise the value
 * inherits from `LORE_USE_RUNTOOL`. Off by default.
 *
 * Gates the `query_data_sources` SQL filter helpers in
 * `EntityService.findByName` / `findByAlias`,
 * `MemoryService.listForNearDuplicates`, and
 * `lore conflicts scan`'s already-judged pre-filter. Same
 * inheritance posture as the block-edit sub-flag.
 */
export function isRunToolFilterSqlEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const explicit = readFlag(env, "LORE_USE_RUNTOOL_FILTER_SQL")
  if (explicit !== null) return explicit
  return isRunToolEnabled(env)
}
