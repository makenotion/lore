import { get } from "node:http"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const oauthFlowMocks = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  openedBrowserInvocations: [] as Array<{ command: string; args: string[] }>,
  spawn: vi.fn(),
  spawnWaiters: [] as Array<(command: string, args: string[]) => void>,
  writeFile: vi.fn(async () => undefined),
}))

vi.mock("node:child_process", () => ({
  spawn: oauthFlowMocks.spawn,
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
  oauthFlowMocks.openedBrowserInvocations.length = 0
  oauthFlowMocks.spawnWaiters.length = 0
  oauthFlowMocks.spawn.mockImplementation((command: string, args: string[]) => {
    oauthFlowMocks.openedBrowserInvocations.push({ command, args })
    oauthFlowMocks.spawnWaiters.shift()?.(command, args)
    return {
      on: vi.fn(),
      unref: vi.fn(),
    }
  })
})

afterEach(() => {
  oauthFlowMocks.spawn.mockReset()
  oauthFlowMocks.openedBrowserInvocations.length = 0
  oauthFlowMocks.spawnWaiters.length = 0
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
    expect(redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(parsedAuthUrl.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]+$/)

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

  it("passes the full OAuth URL as one argv value on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32")

    const { authUrl } = await completeOAuthFlow({
      clientId: "windows-client-id",
      clientSecret: "windows-client-secret",
    })
    const invocation = oauthFlowMocks.openedBrowserInvocations[0]

    expect(invocation).toEqual({
      command: "rundll32",
      args: ["url.dll,FileProtocolHandler", authUrl],
    })
    expect(authUrl).toContain("&redirect_uri=")
    expect(authUrl).toContain("&state=")
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
    const state = getState(authUrl)

    await requestCallback(`${redirectUri}?error=access_denied&state=${state}`)
    const error = await flowError

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("OAuth authorization denied: access_denied")
    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("rejects callback codes whose state does not match the authorization URL", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const flow = runOAuthFlow({
      clientId: "state-client-id",
      clientSecret: "state-client-secret",
    })
    const flowError = flow.catch((error: unknown) => error)
    const authUrl = await waitForOpenedAuthorizationUrl()
    const redirectUri = getRedirectUri(authUrl)

    const response = await requestCallback(`${redirectUri}?code=callback-code`)
    const error = await flowError

    expect(response.statusCode).toBe(400)
    expect(response.body).toContain("could not be verified")
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      "OAuth callback state mismatch. Retry authorization."
    )
    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("checks state before trusting provider error callbacks", async () => {
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout")
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const flow = runOAuthFlow({
      clientId: "error-state-client-id",
      clientSecret: "error-state-client-secret",
    })
    const flowError = flow.catch((error: unknown) => error)
    const authUrl = await waitForOpenedAuthorizationUrl()
    const redirectUri = getRedirectUri(authUrl)

    const response = await requestCallback(
      `${redirectUri}?error=access_denied&state=wrong-state`
    )
    const error = await flowError

    expect(response.statusCode).toBe(400)
    expect(response.body).toContain("could not be verified")
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(
      "OAuth callback state mismatch. Retry authorization."
    )
    expect(clearTimeoutSpy).toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("escapes provider error text before rendering it in the callback response", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const flow = runOAuthFlow({
      clientId: "error-escape-client-id",
      clientSecret: "error-escape-client-secret",
    })
    const flowError = flow.catch((error: unknown) => error)
    const authUrl = await waitForOpenedAuthorizationUrl()
    const redirectUri = getRedirectUri(authUrl)
    const state = getState(authUrl)
    const errorText = `<script>alert("x")</script>&reason='bad'`

    const response = await requestCallback(
      `${redirectUri}?error=${encodeURIComponent(errorText)}&state=${encodeURIComponent(
        state
      )}`
    )
    const error = await flowError

    expect(response.statusCode).toBe(200)
    expect(response.body).not.toContain(errorText)
    expect(response.body).toContain(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;reason=&#39;bad&#39;"
    )
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe(`OAuth authorization denied: ${errorText}`)
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
  const state = getState(authUrl)

  await requestCallback(
    `${redirectUri}?code=callback-code&state=${encodeURIComponent(state)}`
  )
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

function getState(authUrl: string): string {
  const state = new URL(authUrl).searchParams.get("state")
  if (!state) {
    throw new Error("Authorization URL did not include a state")
  }
  return state
}

async function waitForOpenedAuthorizationUrl(): Promise<string> {
  const openedInvocation = oauthFlowMocks.openedBrowserInvocations[0]
  if (openedInvocation) {
    return extractAuthorizationUrl(openedInvocation)
  }
  return new Promise((resolve) => {
    oauthFlowMocks.spawnWaiters.push((command, args) => {
      resolve(extractAuthorizationUrl({ command, args }))
    })
  })
}

function extractAuthorizationUrl(invocation: {
  command: string
  args: string[]
}): string {
  const authUrl = invocation.args.find((arg) => arg.startsWith("http"))
  if (!authUrl) {
    throw new Error(
      `Browser command did not include an authorization URL: ${invocation.command} ${invocation.args.join(
        " "
      )}`
    )
  }
  return authUrl
}

function requestCallback(url: string): Promise<{ body: string; statusCode: number }> {
  return new Promise((resolve, reject) => {
    get(url, (res) => {
      const chunks: Buffer[] = []
      res.on("data", (chunk: Buffer) => chunks.push(chunk))
      res.on("end", () =>
        resolve({
          body: Buffer.concat(chunks).toString("utf-8"),
          statusCode: res.statusCode ?? 0,
        })
      )
    }).on("error", reject)
  })
}
