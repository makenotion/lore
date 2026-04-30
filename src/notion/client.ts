import { Client, LogLevel, type Logger } from "@notionhq/client"

const USER_AGENT = "lore/0.8.0"

/**
 * Routes Notion SDK log lines through stderr instead of the default
 * `console[level]` logger.
 *
 * The SDK's `makeConsoleLogger` writes INFO-level messages via
 * `console.info`, which lands on stdout in Node — that would silently
 * pollute the stdout of any CLI command piped into a parser when
 * `LORE_DEBUG=1` is set. Routing to stderr keeps the report on stdout
 * and the diagnostics on stderr, matching the `[lore] partial-failure:`
 * shape used elsewhere in the codebase so existing log-aggregation
 * patterns keep working.
 *
 * The `JSON.stringify` is wrapped in a try/catch so a future SDK
 * extra-info shape carrying a circular reference (an error with a
 * `cause` chain pointing back at itself, a request object holding a
 * reference to its own response) cannot turn the diagnostic logger
 * into the source of a CLI crash. Today's "retrying request" path
 * passes a flat `{ method, path, attempt, delayMs }` and never trips
 * this branch — the guard is for SDK evolution.
 *
 * Exported so `client.test.ts` can pin the format without instantiating
 * a real `Client`.
 */
export const stderrSdkLogger: Logger = (level, message, extraInfo) => {
  const hasExtra = Object.keys(extraInfo).length > 0
  let suffix = ""
  if (hasExtra) {
    try {
      suffix = ` ${JSON.stringify(extraInfo)}`
    } catch {
      suffix = " [unserializable extraInfo]"
    }
  }
  process.stderr.write(`[lore] notion-sdk ${level}: ${message}${suffix}\n`)
}

/**
 * Resolve the SDK debug-logging options from the current environment.
 * `LORE_DEBUG=1` opts in to `LogLevel.INFO`, which exposes the SDK's
 * per-retry trace ("retrying request" with `{ method, path, attempt,
 * delayMs }`) — the diagnostic that distinguishes a quiet
 * `Retry-After`-induced sleep from a genuine hang. Any other value (or
 * unset) returns `null` so the SDK keeps its default `LogLevel.WARN`.
 *
 * Exported so `client.test.ts` can drive the env-resolution branch
 * without constructing a `Client`.
 */
export function resolveSdkDebugOptions(
  env: NodeJS.ProcessEnv = process.env
): { logLevel: LogLevel; logger: Logger } | null {
  if (env["LORE_DEBUG"] !== "1") return null
  return { logLevel: LogLevel.INFO, logger: stderrSdkLogger }
}

/**
 * Create a configured Notion client.
 *
 * Base URL is resolved from (in order):
 * 1. Explicit `baseUrl` parameter
 * 2. `LORE_NOTION_BASE_URL` env var
 * 3. Default (api.notion.so)
 *
 * `LORE_DEBUG=1` enables the SDK's INFO-level log stream over stderr —
 * use this when a Notion call appears to hang. The most common cause is
 * the SDK absorbing 429s with a `Retry-After`-driven sleep (capped at
 * the SDK's `DEFAULT_MAX_RETRY_DELAY_MS` of 60s); without the trace
 * the sleep is indistinguishable from a deadlock.
 */
export function createClient(token: string, baseUrl?: string): Client {
  const resolvedBaseUrl = baseUrl ?? process.env["LORE_NOTION_BASE_URL"] ?? undefined
  const debugOptions = resolveSdkDebugOptions()

  return new Client({
    auth: token,
    ...(resolvedBaseUrl ? { baseUrl: resolvedBaseUrl } : {}),
    timeoutMs: 30_000,
    ...(debugOptions ?? {}),
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
