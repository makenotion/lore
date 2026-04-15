/**
 * OAuth 2.0 authentication flow for Notion.
 *
 * Implements the standard Authorization Code flow:
 * 1. Spin up a temporary localhost server
 * 2. Open browser to Notion's OAuth consent page
 * 3. Catch the redirect with the authorization code
 * 4. Exchange code for access token
 * 5. Persist token to ~/.lore/credentials.json
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { exec } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

const CREDENTIALS_DIR = join(homedir(), ".lore")
const CREDENTIALS_FILE = join(CREDENTIALS_DIR, "credentials.json")

/**
 * Resolve the Notion API base URL.
 * Set LORE_NOTION_BASE_URL to override (e.g., "https://api.dev.notion.com").
 */
export function getBaseUrl(): string {
  return process.env["LORE_NOTION_BASE_URL"] ?? "https://api.notion.so"
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
    const body = await response.text()
    throw new Error(`OAuth token exchange failed (${response.status}): ${body}`)
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
