/**
 * Narrow `runTool` client wrapping the undocumented `POST /v1/tools/run`
 * endpoint via the Notion SDK's public `Client.request()` method.
 *
 * Why route through `client.request()` rather than a fresh `fetch()`:
 * the existing `createLimitedClient` Proxy in `src/notion/rate-limit.ts`
 * recursively wraps every method on the SDK client, including
 * `request`, so calls dispatched here automatically inherit the same
 * token-bucket pacing, concurrency cap, and shared 429 backoff every
 * other Notion call observes. Likewise the auth-refreshing Proxy in
 * `src/notion/client.ts:createAuthRefreshingClient` walks `request` as
 * a top-level method and applies its 401-retry hook, so a stale
 * ntn-resolved token rotates here exactly the way it does for
 * `pages.create`.
 *
 * That composition is the load-bearing reason this wrapper does NOT
 * open its own fetch path or its own rate-limit gate. Issue #532's
 * non-goals list pins it: "RunTool calls must compose with the same
 * configured request pacing/backoff used by the Notion client wrapper.
 * No parallel rate-limit gate." A future contributor reaching for
 * `axios` / `node:https` directly would silently double the effective
 * outbound rps and is forbidden.
 *
 * The wrapper is intentionally narrow. Two consumers are wired today:
 *
 * - `create_pages` (issue #533, PR #538) — `runTool(client,
 *   "create_pages", params)` consumed by `FactService.createBatchWithDedup`
 *   for batched auto-`mentions` fact emission. Implementation in
 *   `create-pages.ts`.
 * - `update_page` (issue #534, PR #537) — `runTool(client, "update_page",
 *   params)` consumed by `MemoryService.upsertByTopicKey`,
 *   `MemoryService.rekeyTopicKey`, and `memory-encoding.ts`'s anchored
 *   large-body fix. Implementation in `runUpdatePageContent` below
 *   (with `RunToolBlockEditError` and the once-per-process
 *   `restricted_resource` warning); high-level wrapper in
 *   `update-page.ts`.
 *
 * Phase 1 of issue #532 will extend `RunToolRequestMap` /
 * `RunToolResponseMap` with `search` and `query_data_sources`; this
 * module is the one diff point.
 */

import type { Client } from "@notionhq/client"
import { APIErrorCode, isNotionClientError } from "@notionhq/client"
import { redactDebugMessage } from "../../debug-redact.js"
import type {
  RunToolName,
  RunToolRequestMap,
  RunToolResponseMap,
  RunToolUpdatePageResponse,
} from "./types.js"

/**
 * Path passed to `client.request()` for the RunTool dispatcher.
 *
 * The Notion v5 SDK's `Client.request()` builds the URL as
 * `${prefixUrl}${path}` where `prefixUrl = ${baseUrl}/v1/` — so paths
 * are SDK-relative, NOT absolute. Concretely:
 * `client.request({ path: "pages" })` hits
 * `https://api.notion.com/v1/pages`. Passing `"/v1/tools/run"` would
 * produce `https://api.notion.com/v1//v1/tools/run` (double `/v1/`)
 * and miss the endpoint entirely; the resulting 404 is not
 * fall-back-able via `RunToolBlockEditError`, so flagged-on calls
 * would hard-fail end-to-end.
 *
 * The integration test in `update-page.test.ts` instantiates a real
 * `Client` with a stub `fetch` and asserts the URL the SDK actually
 * builds, so a future regression that re-introduces the leading
 * `/v1/` (or any other path-prefix mistake) fails loudly.
 *
 * The `runtool/README.md` documents the HTTP endpoint as
 * `POST /v1/tools/run` because that's the operator-facing wire form;
 * the SDK constant is necessarily relative.
 */
export const RUNTOOL_PATH = "tools/run"

/**
 * Backwards-compatible alias for `RUNTOOL_PATH`. Retained because
 * issue #534's wrapper landed with this spelling before the cross-PR
 * normalization with #538 — preserved as an export so any external
 * consumer reading the constant doesn't break on the rename. The
 * canonical spelling is `RUNTOOL_PATH`.
 */
export const RUN_TOOL_PATH = RUNTOOL_PATH

/**
 * Issue a RunTool request against the shared Notion SDK client.
 *
 * The body envelope is built here (`{ type, [type]: params }`) so
 * callers cannot mis-spell the discriminator or the inner key. The
 * response is returned bare — per the Phase 0 README's "asymmetric
 * envelope" rule, the response is the per-tool resource directly,
 * NOT wrapped in `{ type, [type]: ... }`.
 *
 * Errors propagate verbatim from the SDK so the caller can branch on
 * the surfaced status / code (a 403 actor-type rejection vs a 429
 * vs a 5xx) and decide whether to fall back to the legacy REST
 * path. Per issue #532's "fallback contract": if a RunTool call
 * fails while the flag is on, fall back per-call to the existing
 * REST/SDK path and increment a fallback counter. Default-off
 * behavior remains canonical, so a RunTool failure never harms a
 * non-flagged caller.
 *
 * @param client The shared rate-limited, auth-refreshing Notion client.
 * @param tool The RunTool API tool name (`"create_pages"` for #533).
 * @param params The per-tool request shape from `RunToolRequestMap`.
 */
export async function runTool<T extends RunToolName>(
  client: Client,
  tool: T,
  params: RunToolRequestMap[T]
): Promise<RunToolResponseMap[T]> {
  // The discriminated union shape `{ type, [type]: params }` is built
  // here rather than at the call site so a future contributor cannot
  // accidentally invert the discriminator and the body key (e.g. ship
  // `{ type: "create_pages", search: { ... } }`). The cast is the
  // narrow one needed because TypeScript can't infer that
  // `params` literally types the value at key `tool` — every call
  // site narrows `T` to a single literal so the runtime shape is
  // always correct.
  const body = {
    type: tool,
    [tool]: params,
  } as Record<string, unknown>

  return await client.request<RunToolResponseMap[T] & object>({
    method: "post",
    path: RUNTOOL_PATH,
    body,
  })
}

// ---------------------------------------------------------------------------
// Issue #534 — `update_page` / `update_content` block-edit wrapper
// ---------------------------------------------------------------------------

/**
 * Structured error indicating the RunTool dispatch failed in a way the
 * caller should fall back from rather than surface as a hard error. The
 * server returned an actionable signal (no match, multiple matches,
 * deletion warning we declined, restricted resource) — not a server
 * outage, not an authentication failure that the auth-refresh proxy
 * could repair — and the existing REST/SDK path remains available.
 *
 * `kind` carries the disambiguator so upstream callers can branch:
 *
 * - `"no_match"` — the supplied `old_str` did not occur in the page body.
 *   Caller falls back to the full-body path; the anchor was stale or the
 *   body changed underneath.
 * - `"multiple_matches"` — `old_str` occurred more than once and
 *   `replace_all_matches` was unset (the safe default). Caller falls
 *   back; picking one implicitly is the failure mode the contract is
 *   structured to prevent.
 * - `"deletion_warning"` — the edit would remove child pages or
 *   databases and `allow_deleting_content` was not opted in. Caller
 *   surfaces or falls back; the wrapper does not silently bypass the
 *   warning.
 * - `"restricted_resource"` — the workspace, MCP-client allowlist, or
 *   actor-type check rejected the call (typically because the caller's
 *   token is an integration secret rather than an ntn-issued user-actor
 *   token). The auth-refresh proxy CANNOT repair this — it only refreshes
 *   on `Unauthorized` (401), and a `RestrictedResource` (403) is a
 *   capability decision, not a credential one. Falling back to the REST
 *   path is the correct response: the existing SDK call site has a
 *   different capability surface and is already known to work for the
 *   operator. The wrapper emits a single once-per-process warning so the
 *   operator sees why the flagged-on call is silently downgrading; the
 *   `runtool/README.md`'s "silently degrade … but loud enough" mandate
 *   pins this posture.
 */
export type RunToolBlockEditFailureKind =
  | "no_match"
  | "multiple_matches"
  | "deletion_warning"
  | "restricted_resource"

export class RunToolBlockEditError extends Error {
  readonly kind: RunToolBlockEditFailureKind

  constructor(kind: RunToolBlockEditFailureKind, message: string, cause?: unknown) {
    // Use the ES2022 native `cause` channel so error-chain walkers
    // (`util.inspect`, Node's default formatter, structured logging)
    // pick up the original SDK error without a custom field.
    super(message, cause !== undefined ? { cause } : undefined)
    this.name = "RunToolBlockEditError"
    this.kind = kind
  }
}

/**
 * Issue a RunTool `update_page` / `update_content` request through the
 * passed-in Notion client. Returns the bare per-tool response on success;
 * throws a `RunToolBlockEditError` for the fall-back-able cases above and
 * re-throws every other error verbatim so 401/429/5xx surface to the
 * caller's normal error path (and — for 401 — the auth-refresh proxy
 * gets its retry attempt before the error reaches user code).
 *
 * Network-shaped failures (transport errors, malformed JSON) are also
 * re-thrown verbatim. The wrapper does not classify them as "fall back"
 * because issue #532's fallback contract draws the line at "RunTool
 * call failed for any reason while the flag is on" — the consumer's
 * try/catch decides whether to escalate or use the REST/SDK path.
 */
export async function runUpdatePageContent(
  client: Client,
  params: RunToolRequestMap["update_page"]
): Promise<RunToolUpdatePageResponse> {
  let response: RunToolUpdatePageResponse
  try {
    response = await runTool(client, "update_page", params)
  } catch (err) {
    // 403 RestrictedResource — actor-type / MCP-client allowlist /
    // workflow-bot capability gate. The auth-refresh proxy cannot
    // repair this, but the REST/SDK path the caller already has on
    // hand can, so classify as fall-back-able. The README pins the
    // "silently degrade … but loud enough" rule; the once-per-process
    // warning is what makes the degrade observable.
    if (isRestrictedResourceError(err)) {
      warnRestrictedResourceOnce(err)
      throw new RunToolBlockEditError(
        "restricted_resource",
        "RunTool rejected this token (RestrictedResource). Falling back " +
          "to the REST/SDK path. RunTool requires an ntn-issued user-actor " +
          "token; a public OAuth integration secret cannot pass the " +
          "actor-type check (see src/notion/runtool/README.md).",
        err
      )
    }
    // Translate the structured-validation 400s ("no match found", "multiple
    // matches") into the fall-back-able error shape so consumers can branch
    // deterministically. Anything else (auth, rate limit, server outage,
    // network) re-throws so the existing SDK error handling and the
    // auth-refresh proxy keep working.
    const classified = classifyValidationFailure(err)
    if (classified) {
      throw new RunToolBlockEditError(classified.kind, classified.message, err)
    }
    throw err
  }

  // The server may return a deletion warning even on a 200 when
  // `allow_deleting_content` is false — surfacing that as a structured
  // failure preserves the "fail closed on possible data loss" contract.
  // When the caller explicitly opts into deletion, the warning is
  // informational and tolerated.
  if (
    (params as { allow_deleting_content?: boolean }).allow_deleting_content !==
      true &&
    hasDeletionWarning(response)
  ) {
    throw new RunToolBlockEditError(
      "deletion_warning",
      "RunTool update_content reported a deletion warning; the caller did " +
        "not opt into allow_deleting_content. Falling back to preserve " +
        "child pages/databases."
    )
  }

  return response
}

interface ClassifiedValidationFailure {
  kind: RunToolBlockEditFailureKind
  message: string
}

/**
 * Pattern-match a Notion SDK error against the well-known
 * `update_content` validation failure shapes.
 *
 * Tightened to phrases that the `update_content` 400 path emits
 * specifically (`old_str did not match`, `old_str was not found`,
 * `old_str matches more than once`). Generic 400s like
 * `"User not found in workspace"` or
 * `"Could not find page with ID: ... did not match a valid Notion ID"`
 * are NOT caught — they propagate verbatim so the caller sees the
 * actual server complaint.
 *
 * Validation-error gating: requires `err.code === ValidationError`
 * before any string match. Restricted-resource (403), unauthorized
 * (401), and rate-limit (429) failures cannot satisfy this guard;
 * each has its own surface.
 */
function classifyValidationFailure(err: unknown): ClassifiedValidationFailure | null {
  if (!isNotionClientError(err)) return null
  if (err.code !== APIErrorCode.ValidationError) return null
  const message = err.message ?? ""
  const lower = message.toLowerCase()

  if (
    lower.includes("old_str did not match") ||
    lower.includes("old_str was not found") ||
    lower.includes("old_str not found")
  ) {
    return { kind: "no_match", message }
  }
  if (
    lower.includes("old_str matches more than once") ||
    lower.includes("old_str matched multiple") ||
    lower.includes("multiple matches for old_str")
  ) {
    return { kind: "multiple_matches", message }
  }
  return null
}

function isRestrictedResourceError(err: unknown): boolean {
  return isNotionClientError(err) && err.code === APIErrorCode.RestrictedResource
}

let warnedRestrictedResource = false
function warnRestrictedResourceOnce(err: unknown): void {
  if (warnedRestrictedResource) return
  warnedRestrictedResource = true
  const message = err instanceof Error ? err.message : ""
  // Route through the shared redactor — auth-shaped error messages can
  // surface workspace ids / paths under uncommon scenarios, and the
  // existing emitters in src/notion/client.ts and src/notion/rate-limit.ts
  // route through this same helper. Defense-in-depth.
  const detail = message ? `: ${redactDebugMessage(message)}` : ""
  process.stderr.write(
    "[lore] runtool: 403 RestrictedResource on token; falling back to " +
      "REST/SDK path. RunTool requires an ntn-issued user-actor token; " +
      "see src/notion/runtool/README.md" +
      detail +
      "\n"
  )
}

/** Test seam — reset the once-per-process warning latch so individual
 *  test cases can independently exercise the warning path. NOT for
 *  production use; production callers want the once-per-process
 *  semantics so a sustained 403 doesn't spam stderr. */
export function __resetRunToolWarningsForTest(): void {
  warnedRestrictedResource = false
}

function hasDeletionWarning(response: RunToolUpdatePageResponse): boolean {
  const warning = response.deletion_warning
  if (!warning) return false
  if (Array.isArray(warning)) return warning.length > 0
  return true
}
