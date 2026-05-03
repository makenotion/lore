import {
  APIErrorCode,
  Client,
  LogLevel,
  isNotionClientError,
  type Logger,
} from "@notionhq/client"

const USER_AGENT = "lore/0.11.0"

export interface ClientAuthSnapshot {
  token: string
  baseUrl?: string
}

export type ClientAuthRefreshOutcome =
  | { kind: "refreshed"; auth: ClientAuthSnapshot; source: string }
  | { kind: "unchanged" }
  | { kind: "unavailable"; errorMessage?: string }

export type RefreshClientAuth = (
  current: ClientAuthSnapshot,
) => Promise<ClientAuthRefreshOutcome>

export type AuthRefreshEvent =
  | { kind: "refreshed"; source: string }
  | {
      kind: "skipped"
      reason: "unchanged" | "unavailable"
      errorMessage?: string
    }

export interface AuthRefreshingClientDeps {
  createClient?: (token: string, baseUrl?: string) => Client
  onRefresh?: (event: AuthRefreshEvent) => void
  onAuthChange?: (auth: ClientAuthSnapshot) => void
}

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
  env: NodeJS.ProcessEnv = process.env,
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

/**
 * Wrap a Notion client in a stable Proxy that can rebuild the underlying
 * SDK client after a 401. The retry is intentionally one-shot per call:
 * if refreshed auth is unavailable, unchanged, or the retried request is
 * still unauthorized, the caller receives the surfaced SDK error.
 */
export function createAuthRefreshingClient(
  initialAuth: ClientAuthSnapshot,
  refreshAuth: RefreshClientAuth,
  deps: AuthRefreshingClientDeps = {},
): Client {
  const makeClient = deps.createClient ?? createClient
  const onRefresh = deps.onRefresh ?? defaultOnRefresh
  const onAuthChange = deps.onAuthChange
  let currentAuth = initialAuth
  let currentClient = makeClient(initialAuth.token, initialAuth.baseUrl)
  let refreshInFlight: Promise<boolean> | null = null
  // Bounded by the finite Notion SDK namespace/method surface, not by call count.
  const levelCache = new Map<string, object>()
  const methodCache = new Map<string, (...args: unknown[]) => Promise<unknown>>()

  const getAtPath = (root: unknown, path: PropertyKey[]): unknown => {
    let value = root
    for (const prop of path) {
      if (value === null || value === undefined) return undefined
      value = Reflect.get(value as object, prop)
    }
    return value
  }

  const invoke = async (path: PropertyKey[], args: unknown[]) => {
    const fn = getAtPath(currentClient, path)
    if (typeof fn !== "function") {
      throw new Error(`Notion client path ${formatPath(path)} is not callable`)
    }
    const thisArg = getAtPath(currentClient, path.slice(0, -1))
    return await (fn.apply(thisArg, args) as Promise<unknown>)
  }

  const refreshAfterUnauthorized = async (
    seenAuth: ClientAuthSnapshot,
  ): Promise<boolean> => {
    if (!sameAuth(currentAuth, seenAuth)) return true
    if (refreshInFlight) return refreshInFlight

    refreshInFlight = (async () => {
      let outcome: ClientAuthRefreshOutcome
      try {
        outcome = await refreshAuth(currentAuth)
      } catch (err) {
        emitRefreshEvent(onRefresh, {
          kind: "skipped",
          reason: "unavailable",
          errorMessage: errorMessage(err),
        })
        return false
      }

      if (outcome.kind === "unavailable") {
        emitRefreshEvent(onRefresh, {
          kind: "skipped",
          reason: "unavailable",
          errorMessage: outcome.errorMessage,
        })
        return false
      }
      if (outcome.kind === "unchanged" || sameAuth(outcome.auth, currentAuth)) {
        emitRefreshEvent(onRefresh, { kind: "skipped", reason: "unchanged" })
        return false
      }

      currentAuth = outcome.auth
      currentClient = makeClient(outcome.auth.token, outcome.auth.baseUrl)
      emitAuthChange(onAuthChange, outcome.auth)
      emitRefreshEvent(onRefresh, { kind: "refreshed", source: outcome.source })
      return true
    })().finally(() => {
      refreshInFlight = null
    })

    return refreshInFlight
  }

  const wrapMethod = (path: PropertyKey[]) => {
    const key = pathKey(path)
    const existing = methodCache.get(key)
    if (existing) return existing

    const method = async (...args: unknown[]) => {
      const seenAuth = currentAuth
      try {
        return await invoke(path, args)
      } catch (err) {
        if (!isUnauthorizedError(err)) throw err
        const refreshed = await refreshAfterUnauthorized(seenAuth)
        if (!refreshed) throw err
        return await invoke(path, args)
      }
    }
    methodCache.set(key, method)
    return method
  }

  const wrapLevel = <T extends object>(path: PropertyKey[] = []): T => {
    const key = pathKey(path)
    const existing = levelCache.get(key) as T | undefined
    if (existing) return existing

    const proxy = new Proxy({} as T, {
      get(_target, prop) {
        const nextPath = [...path, prop]
        const value = getAtPath(currentClient, nextPath)
        if (typeof value === "function") return wrapMethod(nextPath)
        if (typeof value === "object" && value !== null) return wrapLevel(nextPath)
        return value
      },
    })
    levelCache.set(key, proxy)
    return proxy
  }

  return wrapLevel<Client>()
}

function sameAuth(a: ClientAuthSnapshot, b: ClientAuthSnapshot): boolean {
  return a.token === b.token && a.baseUrl === b.baseUrl
}

function formatPath(path: PropertyKey[]): string {
  return path.map((prop) => String(prop)).join(".")
}

function pathKey(path: PropertyKey[]): string {
  return path.map((prop) => String(prop)).join("\u0000")
}

function isUnauthorizedError(err: unknown): boolean {
  return isNotionClientError(err) && err.code === APIErrorCode.Unauthorized
}

function defaultOnRefresh(event: AuthRefreshEvent): void {
  if (event.kind === "refreshed") {
    process.stderr.write(
      `[lore] auth: refreshed ntn token after 401 (source=${event.source})\n`,
    )
    return
  }

  if (process.env["LORE_DEBUG"] !== "1") return

  const reason = event.reason === "unchanged" ? "token unchanged" : "auth unavailable"
  const suffix = event.errorMessage ? `: ${event.errorMessage}` : ""
  process.stderr.write(`[lore] auth: 401 refresh skipped (${reason})${suffix}\n`)
}

function emitRefreshEvent(
  onRefresh: (event: AuthRefreshEvent) => void,
  event: AuthRefreshEvent,
): void {
  try {
    onRefresh(event)
  } catch {
    // Observability hooks must not mask the original Notion error.
  }
}

function emitAuthChange(
  onAuthChange: ((auth: ClientAuthSnapshot) => void) | undefined,
  auth: ClientAuthSnapshot
): void {
  if (!onAuthChange) return
  try {
    onAuthChange(auth)
  } catch {
    // Cache-update observers must not mask the original Notion request.
  }
}

function errorMessage(err: unknown): string | undefined {
  if (err instanceof Error && err.message) return err.message
  if (typeof err === "string" && err.length > 0) return err
  return undefined
}
