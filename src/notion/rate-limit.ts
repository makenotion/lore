/**
 * Shared concurrency governor for outbound Notion SDK calls.
 *
 * Notion's public API is limited to roughly three requests per second. Every
 * tool that issues a `Promise.all` over Notion calls (decision graph walks,
 * batch fact fetches, render-layer title lookups, migration sweeps) has the
 * same fan-out shape: without a cap, a dense vault trivially exceeds the
 * limit and triggers 429 retry storms. Fixing each call site one at a time
 * leaves new sites unprotected.
 *
 * `createLimitedClient` wraps the real client in a Proxy so every outbound
 * method call — whether on a sub-object (`client.pages.retrieve`), on the
 * top-level client (`client.search`), on a three-level namespace
 * (`client.blocks.children.list`, `client.pages.properties.retrieve`), or via
 * a future SDK addition — is routed through a single `p-limit` gate. Call
 * sites are untouched.
 *
 * Tests that inject their own mock client are unaffected: the limiter only
 * wraps the real client inside `initServicesFromConfig` and `lore init`.
 * Tests which explicitly want to observe the limit wrap their mock manually.
 */
import type { Client } from "@notionhq/client"
import pLimit from "p-limit"

/** Matches Notion's public-API guidance of ~3 requests per second. */
export const DEFAULT_NOTION_CONCURRENCY = 3

/**
 * Wrap a Notion client so every outbound method call goes through a shared
 * concurrency gate. Returns a Proxy over `client` — structural type-identical
 * so consumers pass it around as a `Client` without casts.
 *
 * Property access is recursive: every level of the SDK's namespace tree gets
 * proxied until we hit a function (wrapped) or a primitive (passed through).
 * Method return values are NOT proxied — they're data, not further API calls.
 */
export function createLimitedClient(
  client: Client,
  concurrency: number = DEFAULT_NOTION_CONCURRENCY,
): Client {
  // Reject non-integers so `.lore.yaml: notion.rateLimit.concurrency: 2.5`
  // gets the clear error the message promises. Matches the Zod schema's
  // `z.number().int().positive()` — no silent float rounding.
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(
      `Notion rate-limit concurrency must be a positive integer (got ${concurrency})`,
    )
  }

  const limit = pLimit(concurrency)

  const wrapMethod =
    (fn: (...args: unknown[]) => unknown, thisArg: unknown) =>
    (...args: unknown[]) =>
      limit(() => fn.apply(thisArg, args))

  // Recursive wrapper. Works for any depth: `client.blocks.children.list` and
  // `client.pages.properties.retrieve` flow through two levels of sub-object
  // proxying before landing on the final method wrapper.
  const wrapLevel = <T extends object>(obj: T): T =>
    new Proxy(obj, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver)
        if (typeof value === "function") {
          return wrapMethod(value as (...args: unknown[]) => unknown, target)
        }
        if (typeof value === "object" && value !== null) {
          return wrapLevel(value as object)
        }
        return value
      },
    })

  return wrapLevel(client)
}
