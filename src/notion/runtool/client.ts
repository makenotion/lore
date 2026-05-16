/**
 * Narrow `runTool` client wrapping the undocumented `POST /v1/tools/run`
 * endpoint via the Notion SDK's public `Client.request()` method.
 *
 * Why route through `client.request()` rather than a fresh `fetch()`:
 * the existing `createLimitedClient` Proxy
 * recursively wraps every method on the SDK client, including
 * `request`, so calls dispatched here automatically inherit the same
 * token-bucket pacing, concurrency cap, and shared 429 backoff every
 * other Notion call observes. Likewise the auth-refreshing Proxy
 * (`createAuthRefreshingClient`) walks `request` as a top-level method
 * and applies its 401-retry hook, so a stale ntn-resolved token rotates
 * here exactly the way it does for `pages.create`.
 *
 * That composition is the load-bearing reason this wrapper does NOT
 * open its own fetch path or its own rate-limit gate. The RunTool
 * quarantine contract pins it: "RunTool calls must compose with the
 * same configured request pacing/backoff used by the Notion client
 * wrapper. No parallel rate-limit gate." A future contributor reaching
 * for `axios` / `node:https` directly would silently double the
 * effective outbound rps and is forbidden.
 *
 * The wrapper is intentionally narrow. Three consumers are wired today:
 *
 * - `create_pages` — `runTool(client,
 *   "create_pages", params)` consumed by `FactService.createBatchWithDedup`
 *   for batched auto-`mentions` fact emission. Implementation in the
 *   create-pages wrapper.
 * - `update_page` — `runTool(client, "update_page",
 *   params)` consumed by `MemoryService.upsertByTopicKey`,
 *   `MemoryService.rekeyTopicKey`, and the anchored large-body memory
 *   encoding fix. Implementation in `runUpdatePageContent` below
 *   (with `RunToolBlockEditError` and the once-per-process
 *   `restricted_resource` warning); high-level wrapper in the
 *   update-page module.
 * - `query_data_sources` — `runTool(client,
 *   "query_data_sources", params)` consumed by `EntityService.findByName`
 *   / `findByAlias`, `MemoryService.listForNearDuplicates`, and
 *   `lore conflicts scan`'s already-judged pre-filter. Implementation in
 *   the query module (with `SqlPartialResultError` for saturated
 *   `has_more` windows and `isSqlValidationError` to escalate
 *   query-shape drift).
 *
 * Additional consumers (`search`, future write tools) extend
 * `RunToolRequestMap` / `RunToolResponseMap` without touching this
 * dispatcher.
 */

import type { Client } from "@notionhq/client"
import { APIErrorCode, isNotionClientError } from "@notionhq/client"
import {
  __resetWarnRunToolRestrictedResourceOnceForTest,
  warnRunToolRestrictedResourceOnce,
} from "./error-helpers.js"
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
 * The integration test instantiates a real
 * `Client` with a stub `fetch` and asserts the URL the SDK actually
 * builds, so a future regression that re-introduces the leading
 * `/v1/` (or any other path-prefix mistake) fails loudly.
 *
 * The operator-facing wire form is `POST /v1/tools/run`; the SDK
 * constant is necessarily relative.
 */
export const RUNTOOL_PATH = "tools/run"

/**
 * Backwards-compatible alias for `RUNTOOL_PATH`. Retained because an
 * earlier wrapper used this spelling before the cross-consumer
 * normalization — preserved as an export so any external
 * consumer reading the constant doesn't break on the rename. The
 * canonical spelling is `RUNTOOL_PATH`.
 */
export const RUN_TOOL_PATH = RUNTOOL_PATH

/**
 * Issue a RunTool request against the shared Notion SDK client.
 *
 * The body envelope is built here (`{ type, [type]: params }`) so
 * callers cannot mis-spell the discriminator or the inner key. The
 * response is returned bare: RunTool responses are per-tool
 * resources directly, NOT wrapped in `{ type, [type]: ... }`.
 *
 * Errors propagate verbatim from the SDK so the caller can branch on
 * the surfaced status / code (a 403 actor-type rejection vs a 429
 * vs a 5xx) and decide whether to fall back to the legacy REST
 * path. The "fallback contract": if a RunTool call
 * fails while the flag is on, fall back per-call to the existing
 * REST/SDK path and increment a fallback counter. Default-off
 * behavior remains canonical, so a RunTool failure never harms a
 * non-flagged caller.
 *
 * @param client The shared rate-limited, auth-refreshing Notion client.
 * @param tool The RunTool API tool name (`"create_pages"`, etc.).
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
  const body = buildRunToolBody(tool, params)

  // 200-wrapped `{ object: "error" }` bodies surfaced by the `tools/run`
  // gateway are normalized into a thrown `APIResponseError` inside
  // `wrapWithRunToolEnvelopeNormalizer`, which
  // sits BELOW the rate-limit and auth-refresh proxies. Throwing at the
  // SDK-`request` layer is what lets `createLimitedClient`'s 429 catch
  // pause the shared bucket and `createAuthRefreshingClient`'s 401 catch
  // run its one-shot retry. A guard at this seam (after the proxy
  // chain has already resolved) would skip both. Tests pin the layering
  // (envelope-rejection contract and proxy composition under envelope
  // errors).
  return await client.request<RunToolResponseMap[T] & object>({
    method: "post",
    path: RUNTOOL_PATH,
    body,
  })
}

function buildRunToolBody<T extends RunToolName>(
  tool: T,
  params: RunToolRequestMap[T]
): Record<string, unknown> {
  return {
    type: tool,
    [tool]: params,
  } as Record<string, unknown>
}

/**
 * Issue a RunTool request whose params are rebuilt whenever the SDK
 * reads the `client.request()` body.
 *
 * Most tools should use `runTool()` above. This narrow helper exists for
 * request bodies that must track mutable process state across an auth-refresh
 * retry. The auth-refreshing client retries the exact same request object
 * after rebuilding the inner SDK client; a getter lets the retried call
 * rebuild host-coupled params from the current auth snapshot instead of
 * replaying stale serialized values.
 */
export async function runToolWithParamsFactory<T extends RunToolName>(
  client: Client,
  tool: T,
  paramsFactory: () => RunToolRequestMap[T]
): Promise<RunToolResponseMap[T]> {
  return await client.request<RunToolResponseMap[T] & object>({
    method: "post",
    path: RUNTOOL_PATH,
    get body(): Record<string, unknown> {
      return buildRunToolBody(tool, paramsFactory())
    },
  })
}

// ---------------------------------------------------------------------------
// `update_page` / `update_content` block-edit wrapper
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
 *   operator sees why the flagged-on call is silently downgrading.
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
 * because the fallback contract draws the line at "RunTool
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
    // hand can, so classify as fall-back-able. The once-per-process
    // warning makes the degrade observable.
    if (isRestrictedResourceError(err)) {
      warnRunToolRestrictedResourceOnce("update_page", err)
      throw new RunToolBlockEditError(
        "restricted_resource",
        "RunTool rejected this token (RestrictedResource). Falling back " +
          "to the REST/SDK path. RunTool requires an ntn-issued user-actor " +
          "token; a public OAuth integration secret cannot pass the " +
          "actor-type check.",
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
    (params as { allow_deleting_content?: boolean }).allow_deleting_content !== true &&
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

/** Test seam — reset the once-per-process warning latch so individual
 *  test cases can independently exercise the warning path. NOT for
 *  production use; production callers want the once-per-process
 *  semantics so a sustained 403 doesn't spam stderr. The latch itself
 *  lives so every RunTool consumer shares a
 *  single warning per process. */
export function __resetRunToolWarningsForTest(): void {
  __resetWarnRunToolRestrictedResourceOnceForTest()
}

function hasDeletionWarning(response: RunToolUpdatePageResponse): boolean {
  const warning = response.deletion_warning
  if (!warning) return false
  if (Array.isArray(warning)) return warning.length > 0
  return true
}
