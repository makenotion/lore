/**
 * Env-var resolution for the RunTool feature flags.
 *
 * `LORE_USE_RUNTOOL` is the parent kill-switch / opt-out. Sub-flags
 * inherit from it unless the operator sets them explicitly:
 *
 * - `LORE_USE_RUNTOOL_BLOCK_EDIT` (#534) — gates anchored markdown
 *   edits via `update_page` / `update_content`. Inherits from parent.
 * - `LORE_USE_RUNTOOL_FILTER_SQL` (#535) — gates `query_data_sources`
 *   SQL filter helpers. Inherits from parent.
 * - `LORE_USE_RUNTOOL_SEARCH` (#541) — gates the semantic-lane
 *   `search` consumer in `MemoryService.search` /
 *   `searchWithMeta` / `searchWithExplain`. Inherits from parent.
 * - `LORE_USE_RUNTOOL_AGGREGATE` (#542) — gates `query_data_sources`
 *   SQL-mode aggregate helpers (server-side `GROUP BY` / `COUNT(*)`).
 *   Inherits from parent.
 *
 * **Default state is ON** for the parent kill-switch and every
 * inheriting sub-flag. The `LORE_USE_RUNTOOL_BATCH_CREATES` (#533)
 * sub-flag does NOT inherit and stays default-OFF — see its file for
 * the partial-commit security carve-out. Flipped to default-ON in
 * issue #543 (Phase 4) per the human lead's directive overriding the
 * 4-week-harness / 3-dogfood-operator gate from the original #532
 * "Default-On Criteria"; see `src/notion/runtool/README.md` "Issue
 * #543 Phase 4 evidence log" for the recorded decision.
 *
 * Operators can disable any consumer with an explicit `=0` (parent
 * disables every inheriting sub-flag at once; per-consumer disable
 * leaves the others on). Every flagged-on consumer falls back to the
 * REST/SDK path on a per-call basis when the RunTool dispatch
 * rejects, so a degraded vault sees no functional regression — only
 * the loss of the RunTool-only optimizations (server-side filter
 * pushdown, semantic search, aggregate `GROUP BY`).
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

/**
 * Tracks `(name, raw)` pairs we've already warned about so the
 * stderr spam stays at one line per typo per process. Test code
 * resets via `__resetRunToolFlagWarningsForTest`.
 */
const warnedUnrecognizedValues = new Set<string>()

/**
 * Names the documented default for a given flag so the warning
 * line is self-contained — an incident operator at 3 AM doesn't
 * need to consult the README to know whether their typo'd disable
 * landed on the safe path. Per PR #549 review iteration 2 nit.
 *
 * Every flag in `RUNTOOL_FLAGS` (the test-side hermetic list)
 * defaults ON post-#543, EXCEPT `LORE_USE_RUNTOOL_BATCH_CREATES`
 * which carves out per #533's security review.
 */
function describeFlagDefault(name: string): string {
  if (name === "LORE_USE_RUNTOOL_BATCH_CREATES") {
    return "default OFF (security carve-out, does not inherit from LORE_USE_RUNTOOL)"
  }
  return "default ON post-#543; use =0 to disable"
}

function emitUnrecognizedValueWarning(name: string, raw: string): void {
  // Per-process key so a typo'd LORE_USE_RUNTOOL=fasle and a
  // typo'd LORE_USE_RUNTOOL_SEARCH=fasle each produce one line —
  // they're different operator mistakes that warrant independent
  // surfacing.
  const key = `${name}=${raw}`
  if (warnedUnrecognizedValues.has(key)) return
  warnedUnrecognizedValues.add(key)
  // Post-#543 the unrecognized-value resolution silently changed
  // (was OFF, now ON) for the parent and inheriting sub-flags.
  // The warning fires on the first read so an incident-time
  // rollback that types `LORE_USE_RUNTOOL=fasle` doesn't quietly
  // leave the operator on the default-on path. Mirrors
  // `error-helpers.ts:warnRunToolIntegrationSecretOnce` posture.
  process.stderr.write(
    `[lore] notion-runtool warn: ignoring unrecognized ${name} value ` +
      `${JSON.stringify(raw)}; falling through to ${describeFlagDefault(name)}. ` +
      `Use ${name}=0 or ${name}=1 to set explicitly.\n`,
  )
}

/** Test-only reset for the once-per-process warning latch. */
export function __resetRunToolFlagWarningsForTest(): void {
  warnedUnrecognizedValues.clear()
}

function readFlag(env: NodeJS.ProcessEnv, name: string): boolean | null {
  const raw = env[name]
  if (raw === undefined) return null
  const normalized = raw.trim().toLowerCase()
  if (FLAG_TRUTHY.has(normalized)) return true
  if (FLAG_FALSY.has(normalized)) return false
  // Unrecognized but non-empty value — emit a one-shot warning so
  // operators see typos (`fasle`, `disabled`) rather than silently
  // resolving to the documented default. Empty strings are in
  // FLAG_FALSY above so they don't warn.
  emitUnrecognizedValueWarning(name, raw)
  return null
}

/**
 * True when `LORE_USE_RUNTOOL` is opted in. **Default ON** as of
 * issue #543 Phase 4 (2026-05-06). An explicit `LORE_USE_RUNTOOL=0`
 * disables; an unrecognized value (e.g. `"maybe"`) falls back to the
 * default ON.
 */
export function isRunToolEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return readFlag(env, "LORE_USE_RUNTOOL") !== false
}

/**
 * True when the block-edit sub-flag is on. An explicit
 * `LORE_USE_RUNTOOL_BLOCK_EDIT` setting wins; otherwise the value
 * inherits from `LORE_USE_RUNTOOL`. **On by default** (#543 flip).
 *
 * The inheritance lets an operator opting out of RunTool flip the
 * parent once and disable every inheriting sub-flag, while leaving
 * the per-feature switch available for narrower experiments (e.g.
 * disable block edits but keep search and filter on).
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
 * inherits from `LORE_USE_RUNTOOL`. **On by default** (#543 flip).
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

/**
 * True when the issue #541 search sub-flag is on. An explicit
 * `LORE_USE_RUNTOOL_SEARCH` setting wins; otherwise the value
 * inherits from `LORE_USE_RUNTOOL`. **On by default** (#543 flip).
 *
 * Gates the RunTool `search` consumer in
 * `MemoryService.fetchSemanticPages`'s flag-on branch. The branch
 * structurally cannot serve every request shape `MemoryService`
 * accepts (empty composed query, `limit > 25`, raw-response
 * saturation under the 25-row no-cursor cap), so the flag-on path
 * falls back to REST per-call on those windows. Same parent-inherit
 * posture as the block-edit and filter-sql sub-flags.
 */
export function isRunToolSearchEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const explicit = readFlag(env, "LORE_USE_RUNTOOL_SEARCH")
  if (explicit !== null) return explicit
  return isRunToolEnabled(env)
}

/**
 * True when the issue #542 SQL aggregate sub-flag is on. An explicit
 * `LORE_USE_RUNTOOL_AGGREGATE` setting wins; otherwise the value
 * inherits from `LORE_USE_RUNTOOL`. **On by default** (#543 flip).
 *
 * Gates the `query_data_sources` SQL aggregate helpers — currently
 * the build-entities orphan-rate metric (`querySubjectGroupCountsViaRunTool`).
 * Same inheritance posture as the block-edit and filter-SQL sub-flags.
 *
 * **Why a separate sub-flag** even though it composes through the
 * same dispatcher as filter-SQL: aggregate queries traverse the
 * server-side `hasAdvancedTools` capability gate (Enterprise + AI
 * workspaces only) AND lack any cursor / offset / page-size knob,
 * so a degraded vault that successfully runs filter-SQL can still
 * see this flag silently fall back per-call. Operators rolling out
 * RunTool need to be able to flip filter-SQL on while leaving
 * aggregate off (and vice-versa) until both paths are independently
 * verified on their target workspace tier. See `README.md`'s
 * "Capability gate is the bigger risk" subsection.
 */
export function isRunToolAggregateEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const explicit = readFlag(env, "LORE_USE_RUNTOOL_AGGREGATE")
  if (explicit !== null) return explicit
  return isRunToolEnabled(env)
}
