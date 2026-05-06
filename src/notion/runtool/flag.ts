/**
 * Env-var resolution for the RunTool feature flags.
 *
 * `LORE_USE_RUNTOOL` is the parent kill-switch / opt-in. Sub-flags
 * inherit from it unless the operator sets them explicitly. The
 * block-edit sub-flag (`LORE_USE_RUNTOOL_BLOCK_EDIT`) gates issue
 * #534's anchored markdown edits via `update_page` /
 * `update_content`. Default state is off.
 *
 * Flagged-on consumers fall back to the existing REST/SDK path
 * **only on the structured `RunToolBlockEditError` kinds**:
 * `no_match` / `multiple_matches` / `deletion_warning` /
 * `restricted_resource`. Transient transport errors — 401, 429,
 * 5xx, malformed responses — propagate verbatim so the
 * auth-refresh proxy gets its retry attempt and
 * `createLimitedClient`'s shared 429 backoff stays authoritative.
 * See `src/notion/runtool/client.ts` and the
 * "Canonical Error-Classification Vocabulary" section in
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
