import { afterEach, describe, expect, it, vi } from "vitest"
import type { JSONRPCMessage, JSONRPCResponse } from "@modelcontextprotocol/sdk/types.js"

type PendingResponse = {
  resolve: (message: JSONRPCMessage) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

interface FakeTransport {
  sent: JSONRPCMessage[]
  start: ReturnType<typeof vi.fn>
  send: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
  onmessage?: (message: JSONRPCMessage) => void
  receive: (message: JSONRPCMessage) => void
  waitForResponse: (id: string | number) => Promise<JSONRPCMessage>
}

const mocks = vi.hoisted(() => ({
  initServices: vi.fn(),
  transports: [] as FakeTransport[],
}))

vi.mock("../services.js", () => ({
  initServices: mocks.initServices,
}))

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => {
    const waiters = new Map<string | number, PendingResponse>()
    const transport: FakeTransport = {
      sent: [],
      start: vi.fn(async () => undefined),
      send: vi.fn(async (message: JSONRPCMessage) => {
        transport.sent.push(message)
        if ("id" in message && message.id !== undefined) {
          const waiter = waiters.get(message.id)
          if (waiter) {
            clearTimeout(waiter.timer)
            waiters.delete(message.id)
            waiter.resolve(message)
          }
        }
      }),
      close: vi.fn(async () => undefined),
      receive: (message: JSONRPCMessage) => {
        transport.onmessage?.(message)
      },
      waitForResponse: (id: string | number) => {
        const existing = transport.sent.find(
          (message) => "id" in message && message.id === id
        )
        if (existing) return Promise.resolve(existing)

        return new Promise<JSONRPCMessage>((resolve, reject) => {
          const timer = setTimeout(() => {
            waiters.delete(id)
            reject(new Error(`Timed out waiting for response ${id}`))
          }, 5_000)
          waiters.set(id, { resolve, reject, timer })
        })
      },
    }
    mocks.transports.push(transport)
    return transport
  }),
}))

import { startServer } from "./server.js"

afterEach(() => {
  vi.clearAllMocks()
  mocks.initServices.mockReset()
  mocks.transports.length = 0
})

describe("diagnostic MCP SDK schema", () => {
  it("advertises passthrough diagnostic input and validates reflexive calls with extra arguments", async () => {
    mocks.initServices.mockRejectedValue(new Error("No .lore.yaml found."))
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)

    try {
      await startServer()

      const transport = mocks.transports[0]
      expect(transport).toBeDefined()

      transport!.receive({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "vitest", version: "0" },
        },
      })
      await expectJsonRpcResult(transport!.waitForResponse(1))

      transport!.receive({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {},
      })

      transport!.receive({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      })
      const toolsResponse = await expectJsonRpcResult(transport!.waitForResponse(2))
      const tools = (
        toolsResponse.result as {
          tools: Array<{ name: string; inputSchema: Record<string, unknown> }>
        }
      ).tools
      const memoryTool = tools.find((tool) => tool.name === "lore-memory")
      expect(memoryTool).toBeDefined()
      expect(memoryTool!.inputSchema).toMatchObject({
        type: "object",
        properties: expect.objectContaining({ action: expect.any(Object) }),
      })
      expect(memoryTool!.inputSchema["additionalProperties"]).not.toBe(false)

      transport!.receive({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "lore-memory",
          arguments: {
            action: "save",
            title: "extra argument should not be rejected",
            body: "ignored in diagnostic mode",
          },
        },
      })
      const callResponse = await expectJsonRpcResult(transport!.waitForResponse(3))
      const result = callResponse.result as {
        isError?: boolean
        content: Array<{ type: string; text: string }>
      }

      expect(result.isError).toBe(true)
      expect(result.content[0]?.text).toContain("Lore MCP Startup Diagnostic")
    } finally {
      stderr.mockRestore()
    }
  })
})

describe("MCP help resources", () => {
  it("lists and reads the help index and action recipes on initialized startup", async () => {
    mocks.initServices.mockResolvedValue({
      profile: undefined,
      costTracking: { enabled: false },
    } as never)

    await startServer()

    const transport = mocks.transports[0]
    expect(transport).toBeDefined()

    transport!.receive({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "vitest", version: "0" },
      },
    })
    await expectJsonRpcResult(transport!.waitForResponse(1))

    transport!.receive({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    })

    transport!.receive({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/list",
      params: {},
    })
    const listResponse = await expectJsonRpcResult(transport!.waitForResponse(2))
    const resources = (
      listResponse.result as {
        resources: Array<{ uri: string; mimeType?: string }>
      }
    ).resources
    expect(resources).toContainEqual(
      expect.objectContaining({ uri: "lore://help", mimeType: "text/markdown" })
    )
    expect(resources).toContainEqual(
      expect.objectContaining({
        uri: "lore://help/lore-memory/save",
        mimeType: "text/markdown",
      })
    )

    transport!.receive({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/templates/list",
      params: {},
    })
    const templatesResponse = await expectJsonRpcResult(transport!.waitForResponse(3))
    const templates = (
      templatesResponse.result as {
        resourceTemplates: Array<{ name: string; uriTemplate: string }>
      }
    ).resourceTemplates
    expect(templates).toContainEqual(
      expect.objectContaining({
        name: "lore-help-action",
        uriTemplate: "lore://help/{tool}/{action}",
      })
    )

    transport!.receive({
      jsonrpc: "2.0",
      id: 4,
      method: "resources/read",
      params: { uri: "lore://help/lore-query/search" },
    })
    const readResponse = await expectJsonRpcResult(transport!.waitForResponse(4))
    const contents = (
      readResponse.result as {
        contents: Array<{ uri: string; mimeType?: string; text?: string }>
      }
    ).contents
    expect(contents[0]).toMatchObject({
      uri: "lore://help/lore-query/search",
      mimeType: "text/markdown",
    })
    expect(contents[0]?.text).toContain("# lore-query action='search'")
    expect(contents[0]?.text).toContain("```json")
  })
})

async function expectJsonRpcResult(
  response: Promise<JSONRPCMessage>
): Promise<JSONRPCResponse & { result: unknown }> {
  const message = await response
  expect("error" in message ? message.error : undefined).toBeUndefined()
  expect("result" in message).toBe(true)
  return message as JSONRPCResponse & { result: unknown }
}
