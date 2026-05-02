import { get } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const oauthFlowMocks = vi.hoisted(() => ({
  exec: vi.fn(),
  execWaiters: [] as Array<(command: string) => void>,
  mkdir: vi.fn(async () => undefined),
  openedCommands: [] as string[],
  writeFile: vi.fn(async () => undefined),
}))

vi.mock("node:child_process", () => ({
  exec: oauthFlowMocks.exec,
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    mkdir: oauthFlowMocks.mkdir,
    writeFile: oauthFlowMocks.writeFile,
  }
})

import { runOAuthFlow } from "./oauth.js"

const ORIGINAL_ENV_CLIENT_ID = process.env["LORE_OAUTH_CLIENT_ID"]

beforeEach(() => {
  oauthFlowMocks.openedCommands.length = 0
  oauthFlowMocks.execWaiters.length = 0
  oauthFlowMocks.exec.mockImplementation((command: string) => {
    oauthFlowMocks.openedCommands.push(command)
    oauthFlowMocks.execWaiters.shift()?.(command)
  })
})

afterEach(() => {
  oauthFlowMocks.exec.mockReset()
  oauthFlowMocks.openedCommands.length = 0
  oauthFlowMocks.execWaiters.length = 0
  oauthFlowMocks.mkdir.mockClear()
  oauthFlowMocks.writeFile.mockClear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (ORIGINAL_ENV_CLIENT_ID === undefined) {
    delete process.env["LORE_OAUTH_CLIENT_ID"]
  } else {
    process.env["LORE_OAUTH_CLIENT_ID"] = ORIGINAL_ENV_CLIENT_ID
  }
})

describe("runOAuthFlow", () => {
  it("opens the browser authorization URL with the configured client id", async () => {
    // This stale external value proves the OAuth flow is config-driven end to end.
    process.env["LORE_OAUTH_CLIENT_ID"] = "stale-env-client-id"
    const { authUrl, clearTimeoutSpy, credentials, fetchMock } = await completeOAuthFlow({
      clientId: "passed-client-id",
      clientSecret: "passed-client-secret",
    })
    const parsedAuthUrl = new URL(authUrl)
    const redirectUri = parsedAuthUrl.searchParams.get("redirect_uri")

    expect(parsedAuthUrl.searchParams.get("client_id")).toBe("passed-client-id")
    expect(parsedAuthUrl.searchParams.get("client_id")).not.toBe(
      process.env["LORE_OAUTH_CLIENT_ID"]
    )
    if (!redirectUri) {
      throw new Error("Authorization URL did not include a redirect_uri")
    }
    expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/)

    expect(credentials.access_token).toBe("token")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fetchMock.mock.calls[0]![1]!.body as string)).toMatchObject({
      grant_type: "authorization_code",
      code: "callback-code",
      redirect_uri: redirectUri,
    })
    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(oauthFlowMocks.writeFile).toHaveBeenCalledTimes(1)
  })

  it("uses the configured client id when the legacy env var is unset", async () => {
    delete process.env["LORE_OAUTH_CLIENT_ID"]
    const { authUrl, fetchMock } = await completeOAuthFlow({
      clientId: "unset-env-client-id",
      clientSecret: "unset-env-client-secret",
    })

    expect(new URL(authUrl).searchParams.get("client_id")).toBe("unset-env-client-id")
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      Authorization: `Basic ${Buffer.from(
        "unset-env-client-id:unset-env-client-secret"
      ).toString("base64")}`,
    })
  })

  it("clears the callback timeout when authorization returns an error", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const flow = runOAuthFlow({
      clientId: "error-client-id",
      clientSecret: "error-client-secret",
    })
    const flowError = flow.catch((error: unknown) => error)
    const authUrl = await waitForOpenedAuthorizationUrl()
    const redirectUri = getRedirectUri(authUrl)

    await requestCallback(`${redirectUri}?error=access_denied`)
    const error = await flowError

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("OAuth authorization denied: access_denied")
    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

async function completeOAuthFlow(config: {
  clientId: string
  clientSecret: string
}): Promise<{
  authUrl: string
  clearTimeoutSpy: ReturnType<typeof vi.spyOn>
  credentials: Awaited<ReturnType<typeof runOAuthFlow>>
  fetchMock: ReturnType<typeof mockTokenExchange>
}> {
  const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
  const fetchMock = mockTokenExchange(config)
  vi.stubGlobal("fetch", fetchMock)

  const flow = runOAuthFlow(config)
  const authUrl = await waitForOpenedAuthorizationUrl()
  const redirectUri = getRedirectUri(authUrl)

  await requestCallback(`${redirectUri}?code=callback-code`)
  const credentials = await flow

  return { authUrl, clearTimeoutSpy, credentials, fetchMock }
}

function mockTokenExchange(config: {
  clientId: string
  clientSecret: string
}): ReturnType<typeof vi.fn> {
  return vi.fn(async (_input: unknown, init?: RequestInit) => {
    const authHeader = init?.headers
      ? new Headers(init.headers).get("Authorization")
      : null
    expect(authHeader).toBe(
      `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString(
        "base64"
      )}`
    )
    return new Response(
      JSON.stringify({
        access_token: "token",
        workspace_id: "workspace",
        workspace_name: "Workspace",
        bot_id: "bot",
        owner: { type: "user" },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    )
  })
}

function getRedirectUri(authUrl: string): string {
  const redirectUri = new URL(authUrl).searchParams.get("redirect_uri")
  if (!redirectUri) {
    throw new Error("Authorization URL did not include a redirect_uri")
  }
  return redirectUri
}

async function waitForOpenedAuthorizationUrl(): Promise<string> {
  const openedCommand = oauthFlowMocks.openedCommands[0]
  if (openedCommand) {
    return extractAuthorizationUrl(openedCommand)
  }
  return new Promise((resolve) => {
    oauthFlowMocks.execWaiters.push((command) => {
      resolve(extractAuthorizationUrl(command))
    })
  })
}

function extractAuthorizationUrl(command: string): string {
  const match = command.match(/https?:\/\/[^"]+/)
  if (!match) {
    throw new Error(`Browser command did not include an authorization URL: ${command}`)
  }
  return match[0]
}

function requestCallback(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      res.resume()
      res.on("end", () => resolve())
    }).on("error", reject)
  })
}
