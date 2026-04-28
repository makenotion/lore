/**
 * lore-query polymorphic dispatcher tests.
 *
 * Pins the wiring between the dispatcher's discriminated union and the
 * downstream handlers — adding `includeContext` to the `ask` arm in
 * issue 0.6.0/18 was the motivating coverage gap. Behavioural tests for
 * `handleAsk` itself live in `knowledge.test.ts`; this file pins the
 * dispatcher's forwarding contract.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { describe, expect, it, vi } from "vitest"
import { registerQueryTools } from "./query.js"
import { registerKnowledgeTools } from "./knowledge.js"

function createMockServer() {
  const handlers = new Map<string, (...args: never[]) => Promise<unknown>>()
  const server = {
    registerTool: vi.fn(
      (name: string, _config: unknown, handler: (...args: never[]) => Promise<unknown>) => {
        handlers.set(name, handler)
      },
    ),
  } as unknown as McpServer
  return {
    server,
    getActionHandler(toolName: string, action: string) {
      const handler = handlers.get(toolName)
      if (!handler) throw new Error(`missing handler ${toolName}`)
      return (args: Record<string, unknown>) =>
        handler({ ...args, action } as never)
    },
  }
}

function makeAskServices(overrides: Record<string, unknown> = {}) {
  return {
    projects: { findByName: vi.fn().mockResolvedValue(null) },
    facts: {
      queryByEntity: vi.fn().mockResolvedValue([]),
      queryByObject: vi.fn().mockResolvedValue([]),
    },
    decisions: { getById: vi.fn() },
    memories: { getTitleById: vi.fn().mockResolvedValue(null) },
    tasks: { list: vi.fn().mockResolvedValue({ items: [] }) },
    context: {
      project: {
        id: "proj-1",
        name: "Mail",
        path: "apps/mail",
        description: "Notion-backed mail client.",
      },
      isCatchAllFallback: false,
    },
    config: {
      vault: { pageId: "v1" },
      projects: [{ name: "Mail", path: "apps/mail" }],
    },
    ...overrides,
  }
}

describe("lore-query polymorphic dispatcher — ask arm forwards includeContext", () => {
  it("renders the framing block when includeContext is omitted (default true)", async () => {
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "AuthService" })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Project: Mail (apps/mail)")
  })

  it("renders the framing block when includeContext: true is explicit", async () => {
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "AuthService", includeContext: true })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).toContain("Project: Mail (apps/mail)")
  })

  it("suppresses the framing block when includeContext: false", async () => {
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({ entity: "AuthService", includeContext: false })
    const text = (result as { content: Array<{ text: string }> }).content[0].text
    expect(text).not.toContain("Project: Mail")
    expect(text).not.toContain("Siblings:")
  })

  it("rejects non-boolean includeContext at the dispatcher schema layer", async () => {
    // Discriminated-union validation is what pins the type contract. A
    // future contributor switching `z.boolean()` to `z.string()` should
    // see this test fail.
    const mockServer = createMockServer()
    const services = makeAskServices()
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)
    const ask = mockServer.getActionHandler("lore-query", "ask")

    const result = await ask({
      entity: "AuthService",
      includeContext: "yes",
    })
    expect((result as { isError?: boolean }).isError).toBe(true)
  })

  it("does not render the framing block on non-ask actions even when project resolves", async () => {
    // Acceptance criterion (#18): `recall`, `search`, `open-loops`, and
    // `audit` do NOT render the framing block. `includeContext` lives
    // only on the `ask` arm; other arms strip the field and never
    // reach the framing renderer. This pins the narrow scope so a
    // future contributor doesn't accidentally fan the block out across
    // every read-path action and inflate output tokens.
    const mockServer = createMockServer()
    const services = {
      ...makeAskServices(),
      memories: {
        list: vi.fn().mockResolvedValue({ items: [] }),
        search: vi.fn().mockResolvedValue([]),
        getTitleById: vi.fn().mockResolvedValue(null),
      },
      facts: {
        listTracking: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
        queryOverdue: vi.fn().mockResolvedValue([]),
      },
      decisions: {
        ...makeAskServices().decisions,
        queryOverdue: vi.fn().mockResolvedValue([]),
      },
    }
    registerKnowledgeTools(mockServer.server, services as never)
    registerQueryTools(mockServer.server, services as never)

    const cases = [
      { action: "recall", args: {} },
      { action: "search", args: { query: "auth" } },
      { action: "open-loops", args: {} },
      { action: "audit", args: {} },
    ] as const

    for (const { action, args } of cases) {
      const handler = mockServer.getActionHandler("lore-query", action)
      const result = await handler(args)
      const text = (result as { content: Array<{ text: string }> }).content[0].text
      expect(text, `action=${action} must not render framing block`).not.toContain(
        "Project: Mail",
      )
      expect(text, `action=${action} must not render Siblings line`).not.toContain(
        "Siblings:",
      )
    }
  })
})
