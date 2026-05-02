/**
 * OAuth 2.0 authentication flow for Notion.
 *
 * Implements the standard Authorization Code flow:
 * 1. Spin up a temporary localhost server
 * 2. Open browser to Notion's OAuth consent page
 * 3. Catch the redirect with the authorization code
 * 4. Exchange code for access token
 * 5. Persist token to ~/.lore/credentials.json
 *
 * Also exports `verifyVaultAccess`, the post-auth-resolution preflight
 * that confirms a freshly-resolved token can read the configured vault
 * page. The helper is auth-mode-agnostic — works against any
 * `Client`, regardless of whether the token came from OAuth, ntn, or
 * the legacy `LORE_NOTION_TOKEN` path.
 */

import type { Client } from "@notionhq/client"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { exec } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import type { NtnEnv } from "./ntn.js"

const CREDENTIALS_DIR = join(homedir(), ".lore")
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json")

/**
 * Canonical Notion API base URLs per ntn environment selector. ntn's
 * own `config.json` records env as `prod` / `dev` / `stg`, and these
 * are the URLs ntn itself routes against. Mapping is shared between
 * `resolveOperatorBaseUrl` (NOTION_ENV → URL) and ntn's own
 * `resolveNtnBaseUrl` (config.json env → URL) so the two surfaces
 * stay in lockstep — a future canonical-URL change lands in one
 * place.
 */
const NTN_ENV_BASE_URLS: Record<NtnEnv, string> = {
  prod: "https://api.notion.so",
  dev: "https://api-dev.notion.com",
  stg: "https://api-stg.notion.com",
}

/**
 * Map a `NOTION_ENV` selector to its canonical base URL. Returns
 * `undefined` for unrecognized values (including empty string) so
 * the caller can fall through to the next priority level. Exported
 * for unit tests and for `auth/ntn.ts` to share the mapping table.
 */
export function ntnEnvBaseUrl(env: string | undefined): string | undefined {
  if (!env) return undefined
  if (env === "prod" || env === "dev" || env === "stg") {
    return NTN_ENV_BASE_URLS[env]
  }
  return undefined
}

/**
 * Aliases beyond the canonical `NTN_ENV_BASE_URLS` table that resolve
 * to the same env. Notion is migrating public surfaces from `.so` to
 * `.com`; both forms hit prod, so a `.lore.yaml` carrying either one
 * must infer prod. The alias lives in its own table (rather than
 * duplicating values inside `NTN_ENV_BASE_URLS`) so `ntnEnvBaseUrl`
 * keeps returning ONE canonical URL per env — the inverse direction
 * is the only one that needs many-to-one resolution.
 */
const NTN_ENV_BASE_URL_ALIASES: Record<string, NtnEnv> = {
  "https://api.notion.com": "prod",
}

/**
 * Inverse of `ntnEnvBaseUrl` — map a Notion API base URL back to its
 * ntn env selector (`prod` / `dev` / `stg`). Recognizes the canonical
 * URLs in `NTN_ENV_BASE_URLS` plus the aliases in
 * `NTN_ENV_BASE_URL_ALIASES`. Returns `undefined` for unknown URLs
 * (e.g., a corporate proxy or a future env Lore doesn't know about).
 *
 * Single canonical helper for every Lore-managed ntn login surface
 * (#06 `lore auth --login`, #07 `lore auth --migrate`, #08 `lore
 * install`, #09 `lore init`). Centralized here so a future
 * canonical-URL change (Notion shipping a new env, retiring an old
 * one, adding another `.com` alias) lands in one place — surfaces
 * MUST NOT hand-roll their own URL → env mapping.
 *
 * Used to derive the ntn-login env target from `.lore.yaml`'s
 * `auth.baseUrl` when the operator hasn't set `NOTION_ENV` in their
 * shell — without this inference, an `lore install -y` (or
 * `lore auth --login`) against a dev project would mint a prod token
 * (ntn's default) and the post-login preflight would fail with a
 * confusing "vault not accessible" error.
 */
export function ntnEnvFromBaseUrl(url: string | undefined): NtnEnv | undefined {
  if (!url) return undefined
  for (const [env, canonicalUrl] of Object.entries(NTN_ENV_BASE_URLS) as Array<
    [NtnEnv, string]
  >) {
    if (canonicalUrl === url) return env
  }
  return NTN_ENV_BASE_URL_ALIASES[url]
}

/**
 * Resolve the Notion API base URL from the operator's environment.
 *
 * Priority order (highest first):
 *   1. `LORE_NOTION_BASE_URL` — Lore-namespaced explicit override
 *   2. `NOTION_BASE_URL` — ntn-native override; respected so a dev
 *      operator who has the ntn-shaped env state in their shell
 *      doesn't have to also export the Lore-namespaced alias
 *   3. `NOTION_API_BASE_URL` — legacy ntn name; same posture
 *   4. `NOTION_ENV` mapped via `ntnEnvBaseUrl` — covers operators
 *      who set the env selector without an explicit URL var (the
 *      ntn-native shorthand `NOTION_ENV=dev` should "just work" for
 *      direct-token resolution paths, not just for ntn-auth-json
 *      where ntn's own config.json carries the env).
 *
 * Returns `undefined` when no recognized signal is present so
 * callers can apply their own fallback (`getBaseUrl` defaults to
 * prod; `loadNtnToken` reads ntn's `config.json` for the env-derived
 * default).
 *
 * Why so many fallbacks? `ntn login` writes auth.json based on
 * `NOTION_ENV` at login time, so the env state IS encoded in
 * `~/.config/notion/config.json` for the ntn-resolved path. But
 * operators on the direct `NOTION_API_TOKEN` path bypass ntn
 * entirely, and they frequently use the ntn-native names because
 * that's what `ntn --help` documents — so any of the four signals
 * has to land them on the right URL.
 */
export function resolveOperatorBaseUrl(
  envSource: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    envSource["LORE_NOTION_BASE_URL"] ||
    envSource["NOTION_BASE_URL"] ||
    envSource["NOTION_API_BASE_URL"] ||
    ntnEnvBaseUrl(envSource["NOTION_ENV"]) ||
    undefined
  )
}

/**
 * Resolve the Notion API base URL with a prod default.
 *
 * Set `LORE_NOTION_BASE_URL`, `NOTION_BASE_URL`, or
 * `NOTION_API_BASE_URL` to override (e.g.,
 * `"https://api.dev.notion.com"`).
 */
export function getBaseUrl(): string {
  return resolveOperatorBaseUrl() ?? "https://api.notion.so"
}

export interface OAuthCredentials {
  access_token: string
  workspace_id: string
  workspace_name: string | null
  bot_id: string
  owner_type: string
  base_url: string
  created_at: string
}

export interface OAuthConfig {
  clientId: string
  clientSecret: string
  redirectPort?: number
}

/**
 * Run the interactive OAuth flow. Opens a browser, waits for the callback,
 * exchanges the code, and persists credentials.
 */
export async function runOAuthFlow(config: OAuthConfig): Promise<OAuthCredentials> {
  const port = config.redirectPort ?? 0 // 0 = OS picks a free port
  const { code, actualPort } = await startCallbackServer(port)

  const redirectUri = `http://localhost:${actualPort}/callback`

  // Exchange authorization code for access token
  const credentials = await exchangeCode({
    code,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    redirectUri,
  })

  // Persist to disk
  await saveCredentials(credentials)

  return credentials
}

/**
 * Get the OAuth authorization URL that the user should open in their browser.
 */
export function getAuthorizationUrl(clientId: string, redirectUri: string): string {
  const base = getBaseUrl()
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    owner: "user",
    redirect_uri: redirectUri,
  })
  return `${base}/v1/oauth/authorize?${params}`
}

/**
 * Load saved OAuth credentials from disk.
 * Returns null if no credentials are saved.
 */
export async function loadCredentials(): Promise<OAuthCredentials | null> {
  try {
    const raw = await readFile(CREDENTIALS_FILE, "utf-8")
    return JSON.parse(raw) as OAuthCredentials
  } catch {
    return null
  }
}

/**
 * Save OAuth credentials to disk.
 */
async function saveCredentials(credentials: OAuthCredentials): Promise<void> {
  await mkdir(CREDENTIALS_DIR, { recursive: true })
  await writeFile(
    CREDENTIALS_FILE,
    JSON.stringify(credentials, null, 2),
    { mode: 0o600 } // Read/write only for owner
  )
}

/**
 * Exchange an authorization code for an access token.
 */
async function exchangeCode(params: {
  code: string
  clientId: string
  clientSecret: string
  redirectUri: string
}): Promise<OAuthCredentials> {
  const basicAuth = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString(
    "base64"
  )

  const base = getBaseUrl()
  const response = await fetch(`${base}/v1/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicAuth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
    }),
  })

  if (!response.ok) {
    throw new Error(
      `OAuth token exchange failed (${response.status}). Check the OAuth client configuration and retry.`
    )
  }

  const data = (await response.json()) as Record<string, unknown>

  return {
    access_token: data.access_token as string,
    workspace_id: data.workspace_id as string,
    workspace_name: (data.workspace_name as string) ?? null,
    bot_id: data.bot_id as string,
    owner_type: (data.owner as Record<string, string>)?.type ?? "unknown",
    base_url: base,
    created_at: new Date().toISOString(),
  }
}

/**
 * Start a temporary HTTP server to receive the OAuth callback.
 * Returns a promise that resolves with the authorization code.
 */
function startCallbackServer(
  port: number
): Promise<{ code: string; actualPort: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`)

      if (url.pathname === "/callback") {
        const code = url.searchParams.get("code")
        const error = url.searchParams.get("error")

        if (error) {
          res.writeHead(200, { "Content-Type": "text/html" })
          res.end(
            `<html><body><h2>Authorization failed</h2><p>${error}</p><p>You can close this tab.</p></body></html>`
          )
          server.close()
          reject(new Error(`OAuth authorization denied: ${error}`))
          return
        }

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html" })
          res.end(
            "<html><body><h2>Authorized</h2><p>Lore has been authorized. You can close this tab.</p></body></html>"
          )
          server.close()
          const addr = server.address()
          const actualPort = typeof addr === "object" && addr ? addr.port : port
          resolve({ code, actualPort })
          return
        }
      }

      res.writeHead(404)
      res.end("Not found")
    })

    server.listen(port, "127.0.0.1", () => {
      const addr = server.address()
      if (typeof addr === "object" && addr) {
        // Open browser to the authorization URL
        const redirectUri = `http://localhost:${addr.port}/callback`
        const authUrl = getAuthorizationUrl(
          process.env["LORE_OAUTH_CLIENT_ID"] ?? "",
          redirectUri
        )
        openBrowser(authUrl)
        console.log(`\nOpening browser for Notion authorization...`)
        console.log(`If the browser doesn't open, visit:\n  ${authUrl}\n`)
      }
    })

    server.on("error", reject)

    // Timeout after 5 minutes
    setTimeout(
      () => {
        server.close()
        reject(new Error("OAuth callback timed out after 5 minutes"))
      },
      5 * 60 * 1000
    )
  })
}

/**
 * Open a URL in the default browser.
 */
function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "${url}"`
        : `xdg-open "${url}"`
  exec(cmd)
}

// ---------------------------------------------------------------------------
// verifyVaultAccess — post-auth-resolution preflight
// ---------------------------------------------------------------------------

/**
 * Outcome of a vault-access preflight. One success shape and four
 * failure shapes:
 *
 * - `ok` — the client successfully read the vault page.
 * - `not-found` — the page does not exist for this token (most
 *   common cause: operator authenticated against the wrong
 *   workspace, or their Notion identity hasn't been granted access
 *   to the team vault page).
 * - `unauthorized` — Notion returned 401 / 403 (`unauthorized` /
 *   `restricted_resource`). The token is invalid, expired, or
 *   revoked; a re-auth cycle is required. Distinct from `not-found`
 *   because the remediation differs: `not-found` points at workspace
 *   / share mismatch; `unauthorized` points at re-running
 *   `lore auth --login`.
 * - `rate-limited` — Notion returned 429 (`rate_limited`). Transient
 *   throttling; operator should wait and retry. Distinct from
 *   `unknown-error` because the remediation is "wait" rather than
 *   "investigate."
 * - `unknown-error` — Notion returned something other than the four
 *   recognized cases (5xx, network error, unparseable response,
 *   etc.). Caller surfaces the raw error.
 *
 * The split exists because `lore install` (and other consumers)
 * need to gate `ready` differently per failure mode: a 401/404
 * means MCP config writes would land an immediately-broken
 * install, while a 429/5xx is plausibly transient and shouldn't
 * block onboarding.
 */
export type VaultAccessResult =
  | { kind: "ok"; pageTitle: string | null }
  | { kind: "not-found"; pageId: string; message: string }
  | { kind: "unauthorized"; pageId: string; message: string }
  | { kind: "rate-limited"; pageId: string; message: string }
  | { kind: "unknown-error"; pageId: string; error: unknown }

/**
 * Probe whether the given client can read the given vault page.
 * Used post-auth-resolution to verify the operator authenticated
 * against the right workspace.
 *
 * Pure read — issues a single `pages.retrieve` call. Does not write,
 * does not iterate child blocks, does not touch any database. Cheap
 * enough to call on every login without being a startup-tax concern.
 *
 * The page title is returned on success so the caller can confirm the
 * operator picked the *right* vault. `lore init`'s no-arg flow (#09)
 * shows the title back so an operator who creates a vault in the
 * wrong workspace catches the discrepancy and can re-run.
 *
 * The helper takes a `Client`, not a token, matching the rest of
 * Lore's discipline: every Notion-touching path uses the rate-limited
 * proxy from `services.ts`. A caller with only a raw token wraps via
 * `createLimitedClient(createClient(token, baseUrl))` first.
 */
export async function verifyVaultAccess(
  client: Client,
  vaultPageId: string
): Promise<VaultAccessResult> {
  try {
    const page = await client.pages.retrieve({ page_id: vaultPageId })
    const title = extractPageTitle(page)
    return { kind: "ok", pageTitle: title }
  } catch (err) {
    const { status, code } = err as { status?: number; code?: string }

    // Notion's v5 SDK throws `APIResponseError` with a `code` field
    // drawn from the `APIErrorCode` enum. We check both `status` and
    // `code` so the helper is robust against future SDK shape
    // changes — the same defense pattern as
    // `notion/errors.ts:isMissingPropertyError`.
    if (status === 404 || code === "object_not_found") {
      return {
        kind: "not-found",
        pageId: vaultPageId,
        message:
          "Vault page not accessible. Most likely cause under " +
          "ntn-first auth: you authenticated against the wrong " +
          "workspace during ntn login, OR the vault page isn't " +
          "shared with you (your Notion identity) in this " +
          "workspace. ntn-issued tokens inherit your personal " +
          "Notion permissions; if you can't open the page in " +
          "Notion's UI, the token can't read it either.",
      }
    }

    if (
      status === 401 ||
      status === 403 ||
      code === "unauthorized" ||
      code === "restricted_resource"
    ) {
      return {
        kind: "unauthorized",
        pageId: vaultPageId,
        message:
          "Notion rejected the bearer token. The token is invalid, " +
          "expired, or revoked — re-run `lore auth --login` to issue " +
          "a fresh token. (`restricted_resource` / 403 also lands " +
          "here: the integration backing the token doesn't have " +
          "permission for this page; re-auth via the wrapper picks " +
          "up the engineer's current Notion identity.)",
      }
    }

    if (status === 429 || code === "rate_limited") {
      return {
        kind: "rate-limited",
        pageId: vaultPageId,
        message:
          "Notion's API throttled this preflight (429). Wait a few " +
          "seconds and retry — the bearer token is fine; the issue " +
          "is request-rate volume on this token's bucket.",
      }
    }

    return { kind: "unknown-error", pageId: vaultPageId, error: err }
  }
}

/**
 * Best-effort title extraction from a `pages.retrieve` response.
 * Returns null if the page object doesn't carry a title in the shape
 * the helper expects (e.g., a database-row page rather than a regular
 * page, where the title lives under a renamed property like "Name").
 *
 * Used for the success-branch message; not load-bearing — the
 * preflight already succeeded by the time we extract the title.
 *
 * Deliberately does NOT delegate to `notion/extractors.ts:extractTitle`.
 * That extractor expects a property under a *named* key (`Name`,
 * `Title`, etc.) inside a query-result row; `pages.retrieve` against a
 * regular page returns the title at the well-known key `title`. The
 * shapes diverge enough that sharing extraction logic would couple
 * unrelated concerns.
 */
export function extractPageTitle(page: unknown): string | null {
  if (!page || typeof page !== "object") return null
  const props = (page as { properties?: Record<string, unknown> }).properties
  if (!props || typeof props !== "object") return null
  const titleProp = (props as { title?: unknown }).title
  if (!titleProp || typeof titleProp !== "object") return null
  const titleArr = (titleProp as { title?: Array<{ plain_text?: string }> }).title
  if (!Array.isArray(titleArr) || titleArr.length === 0) return null
  return titleArr[0]?.plain_text ?? null
}
