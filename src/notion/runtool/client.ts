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
 * The wrapper is intentionally narrow: only `create_pages` is wired
 * here for issue #533. Phase 1 of issue #532 extends `RunToolRequestMap`
 * / `RunToolResponseMap` and the `runTool` overload set with `search`
 * and `query_data_sources`; this module is the one diff point.
 */

import type { Client } from "@notionhq/client"
import type {
  RunToolName,
  RunToolRequestMap,
  RunToolResponseMap,
} from "./types.js"

/** Wire path for the RunTool endpoint. Pinned in Phase 0 README. */
export const RUNTOOL_PATH = "/v1/tools/run"

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
