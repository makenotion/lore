import { Client } from "@notionhq/client"

const USER_AGENT = "lore/0.5.0"

/**
 * Create a configured Notion client.
 *
 * Base URL is resolved from (in order):
 * 1. Explicit `baseUrl` parameter
 * 2. `LORE_NOTION_BASE_URL` env var
 * 3. Default (api.notion.so)
 */
export function createClient(token: string, baseUrl?: string): Client {
  const resolvedBaseUrl = baseUrl ?? process.env["LORE_NOTION_BASE_URL"] ?? undefined

  return new Client({
    auth: token,
    ...(resolvedBaseUrl ? { baseUrl: resolvedBaseUrl } : {}),
    timeoutMs: 30_000,
    fetch: async (url, init) => {
      return fetch(url, {
        ...init,
        headers: {
          ...(init?.headers ?? {}),
          "User-Agent": USER_AGENT,
        },
      })
    },
  })
}
