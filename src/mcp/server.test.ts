import { afterEach, describe, expect, it, vi } from "vitest"

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}>

interface MockServer {
  registerTool: ReturnType<typeof vi.fn>
  connect: ReturnType<typeof vi.fn>
  tools: Map<string, { config: unknown; handler: ToolHandler }>
}

const mocks = vi.hoisted(() => ({
  initServices: vi.fn(),
  registerContextTools: vi.fn(),
  registerMemoryTools: vi.fn(),
  registerPinnedTools: vi.fn(),
  registerQueryTools: vi.fn(),
  registerProjectTools: vi.fn(),
  registerKnowledgeTools: vi.fn(),
  registerDecisionTools: vi.fn(),
  registerTaskTools: vi.fn(),
  registerProcedureTools: vi.fn(),
  servers: [] as MockServer[],
  transports: [] as Array<{ kind: "stdio" }>,
}))

vi.mock("../services.js", () => ({
  initServices: mocks.initServices,
}))

vi.mock("./tools/context.js", () => ({
  registerContextTools: mocks.registerContextTools,
}))

vi.mock("./tools/memory.js", () => ({
  registerMemoryTools: mocks.registerMemoryTools,
}))

vi.mock("./tools/pinned.js", () => ({
  registerPinnedTools: mocks.registerPinnedTools,
}))

vi.mock("./tools/query.js", () => ({
  registerQueryTools: mocks.registerQueryTools,
}))

vi.mock("./tools/project.js", () => ({
  registerProjectTools: mocks.registerProjectTools,
}))

vi.mock("./tools/knowledge.js", () => ({
  registerKnowledgeTools: mocks.registerKnowledgeTools,
}))

vi.mock("./tools/decisions.js", () => ({
  registerDecisionTools: mocks.registerDecisionTools,
}))

vi.mock("./tools/tasks.js", () => ({
  registerTaskTools: mocks.registerTaskTools,
}))

vi.mock("./tools/procedures.js", () => ({
  registerProcedureTools: mocks.registerProcedureTools,
}))

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => {
    const server: MockServer = {
      tools: new Map(),
      registerTool: vi.fn((name: string, config: unknown, handler: ToolHandler) => {
        server.tools.set(name, { config, handler })
      }),
      connect: vi.fn(async () => undefined),
    }
    mocks.servers.push(server)
    return server
  }),
}))

vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn().mockImplementation(() => {
    const transport = { kind: "stdio" as const }
    mocks.transports.push(transport)
    return transport
  }),
}))

import { startServer } from "./server.js"
import { InvalidNotionBaseUrlError } from "../auth/oauth.js"

const DIAGNOSTIC_TOOL_NAMES = [
  "lore-context",
  "lore-decision",
  "lore-fact",
  "lore-memory",
  "lore-pinned",
  "lore-procedure",
  "lore-project",
  "lore-query",
  "lore-task",
]

afterEach(() => {
  vi.clearAllMocks()
  mocks.initServices.mockReset()
  mocks.registerContextTools.mockReset()
  mocks.registerMemoryTools.mockReset()
  mocks.registerPinnedTools.mockReset()
  mocks.registerQueryTools.mockReset()
  mocks.registerProjectTools.mockReset()
  mocks.registerKnowledgeTools.mockReset()
  mocks.registerDecisionTools.mockReset()
  mocks.registerTaskTools.mockReset()
  mocks.registerProcedureTools.mockReset()
  mocks.servers.length = 0
  mocks.transports.length = 0
})

describe("startServer", () => {
  it("starts diagnostic tools when service initialization fails", async () => {
    mocks.initServices.mockRejectedValue(
      new Error(
        "No .lore.yaml found. Run `lore init` to set up a vault. Wrapped snippet: ```shell\nlore init\n```"
      )
    )
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const stdoutLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit should not be called")
    }) as never)

    try {
      await startServer()

      expect(exit).not.toHaveBeenCalled()
      expect(mocks.initServices).toHaveBeenCalledWith(undefined, {
        driftCheck: "debounced",
      })
      expect(mocks.registerContextTools).not.toHaveBeenCalled()
      expect(mocks.registerMemoryTools).not.toHaveBeenCalled()
      expect(mocks.registerQueryTools).not.toHaveBeenCalled()
      expect(mocks.registerProjectTools).not.toHaveBeenCalled()
      expect(mocks.registerKnowledgeTools).not.toHaveBeenCalled()
      expect(mocks.registerDecisionTools).not.toHaveBeenCalled()
      expect(mocks.registerTaskTools).not.toHaveBeenCalled()

      const server = mocks.servers[0]
      expect([...server!.tools.keys()].sort()).toEqual(DIAGNOSTIC_TOOL_NAMES)
      const diagnostic = server?.tools.get("lore-context")
      expect(diagnostic).toBeDefined()
      const inputSchema = (
        diagnostic!.config as {
          inputSchema: { safeParse: (value: unknown) => { success: boolean } }
        }
      ).inputSchema
      expect(inputSchema.safeParse({}).success).toBe(true)
      expect(inputSchema.safeParse({ action: "status" }).success).toBe(true)
      expect(inputSchema.safeParse({ action: "wake-up" }).success).toBe(true)
      expect(inputSchema.safeParse({ action: "digest" }).success).toBe(true)
      expect(inputSchema.safeParse({ action: "anything-else" }).success).toBe(true)
      expect(inputSchema.safeParse({ action: 42 }).success).toBe(true)
      expect(inputSchema.safeParse({ action: "save", title: "extra arg" }).success).toBe(
        true
      )
      expect(server?.connect).toHaveBeenCalledWith(mocks.transports[0])

      const result = await diagnostic!.handler({ action: "status" })
      const wakeUpResult = await diagnostic!.handler({ action: "wake-up" })
      const memoryResult = await server!.tools.get("lore-memory")!.handler({
        action: "save",
        title: "ignored in diagnostic mode",
      })
      const text = result.content[0]?.text ?? ""
      expect(result.isError).toBe(true)
      expect(wakeUpResult.content[0]?.text).toBe(text)
      expect(memoryResult.content[0]?.text).toBe(text)
      expect(memoryResult.isError).toBe(true)
      expect(text).toContain("Lore MCP server started in diagnostic mode")
      expect(text).toContain("No .lore.yaml found")
      // Fenced block now opens on the canonical stack header
      // (`<Name>: <message>\n    at ...`) emitted by V8 — the rich
      // formatter routes through `error.stack` so a future generic
      // failure carries a frame line an operator can grep on.
      expect(text).toContain("````\nError: No .lore.yaml found")
      expect(text).toMatch(/\n {4}at .+:\d+:\d+/)
      expect(text).toContain("```shell\nlore init\n```")
      expect(text).toContain("lore init")
      expect(text).toContain("lore auth --login")
      expect(text).toContain("restart or reconnect the MCP client")
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("starting diagnostic MCP server")
      )
      expect(stderr).toHaveBeenCalledWith(expect.stringMatching(/\n {4}at .+:\d+:\d+/))
      expect(stdoutLog).not.toHaveBeenCalled()
      expect(stdoutWrite).not.toHaveBeenCalled()
    } finally {
      exit.mockRestore()
      stdoutWrite.mockRestore()
      stdoutLog.mockRestore()
      stderr.mockRestore()
    }
  })

  it("still serves diagnostics when only public autosave opt-out is disabled", async () => {
    const previousAutosave = process.env["LORE_AUTOSAVE"]
    const previousBackgroundAgent = process.env["LORE_BACKGROUND_AGENT"]
    process.env["LORE_AUTOSAVE"] = "false"
    delete process.env["LORE_BACKGROUND_AGENT"]
    mocks.initServices.mockRejectedValue(new Error("No Notion auth configured."))
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const stdoutLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    try {
      await startServer()

      expect([...mocks.servers[0]!.tools.keys()].sort()).toEqual(DIAGNOSTIC_TOOL_NAMES)
      expect(mocks.servers[0]?.connect).toHaveBeenCalledWith(mocks.transports[0])
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("starting diagnostic MCP server")
      )
      expect(stdoutLog).not.toHaveBeenCalled()
      expect(stdoutWrite).not.toHaveBeenCalled()
    } finally {
      if (previousAutosave === undefined) {
        delete process.env["LORE_AUTOSAVE"]
      } else {
        process.env["LORE_AUTOSAVE"] = previousAutosave
      }
      if (previousBackgroundAgent === undefined) {
        delete process.env["LORE_BACKGROUND_AGENT"]
      } else {
        process.env["LORE_BACKGROUND_AGENT"] = previousBackgroundAgent
      }
      stdoutWrite.mockRestore()
      stdoutLog.mockRestore()
      stderr.mockRestore()
    }
  })

  it("serves setup diagnostics for missing Entities instead of crashing", async () => {
    mocks.initServices.mockRejectedValue(
      new Error(
        "Vault at 343b...199f is missing databases: Entities. Found existing Lore databases: Projects, Topics, Memories, Facts."
      )
    )
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const stdoutLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    try {
      await startServer()

      const server = mocks.servers[0]
      expect([...server!.tools.keys()].sort()).toEqual(DIAGNOSTIC_TOOL_NAMES)
      expect(server?.connect).toHaveBeenCalledWith(mocks.transports[0])
      const result = await server!.tools.get("lore-context")!.handler({
        action: "status",
      })
      const text = result.content[0]?.text ?? ""
      expect(result.isError).toBe(true)
      expect(text).toContain("missing databases: Entities")
      expect(text).toContain("lore vault ensure-entities")
      expect(text).toContain("lore migrate --build-entities --yes")
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("starting diagnostic MCP server")
      )
      expect(stdoutLog).not.toHaveBeenCalled()
      expect(stdoutWrite).not.toHaveBeenCalled()
    } finally {
      stdoutWrite.mockRestore()
      stdoutLog.mockRestore()
      stderr.mockRestore()
    }
  })

  it("preserves error name, stack frames, and cause chain in startup diagnostics", async () => {
    // Simulates the historical "Invalid URL" failure where the bare
    // message carried no actionable trail. The diagnostic must surface
    // the error name, stack, and any wrapping `cause` so the next time
    // a generic message slips through, an operator (or agent) has a
    // frame to act on.
    const root = new TypeError("Invalid URL")
    const wrapped = new Error("failed to construct Notion client", { cause: root })
    mocks.initServices.mockRejectedValue(wrapped)
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)

    try {
      await startServer()

      const text =
        (
          await mocks.servers[0]!.tools.get("lore-context")!.handler({
            action: "status",
          })
        ).content[0]?.text ?? ""
      expect(text).toContain("Error: failed to construct Notion client")
      expect(text).toMatch(/\n {4}at .+:\d+:\d+/)
      expect(text).toContain("Caused by: TypeError: Invalid URL")
      // Both error stacks must appear — at least two frame lines after
      // chaining (one per Error in the chain). A single-frame match is
      // too weak; a regex that asserts the trail has at least the root
      // cause's frames closes the window where a future formatter
      // refactor accidentally drops the cause's stack.
      const frameMatches = text.match(/\n {4}at .+:\d+:\d+/g) ?? []
      expect(frameMatches.length).toBeGreaterThanOrEqual(2)
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("Caused by: TypeError: Invalid URL")
      )
    } finally {
      stderr.mockRestore()
    }
  })

  it("surfaces invalid base URL diagnostics with source-specific recovery", async () => {
    mocks.initServices.mockRejectedValue(
      new InvalidNotionBaseUrlError(
        "LORE_NOTION_BASE_URL",
        "value is missing a URL protocol"
      )
    )
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)

    try {
      await startServer()

      const text =
        (
          await mocks.servers[0]!.tools.get("lore-context")!.handler({
            action: "status",
          })
        ).content[0]?.text ?? ""
      expect(text).toContain("InvalidNotionBaseUrlError")
      expect(text).toContain("LORE_NOTION_BASE_URL")
      expect(text).toContain("absolute http(s) URL")
      expect(text).toContain("fix or unset the named base-URL environment variable")
      expect(text).not.toContain("TypeError: Invalid URL")
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("InvalidNotionBaseUrlError")
      )
    } finally {
      stderr.mockRestore()
    }
  })

  it("formats non-Error throwables and breaks cause cycles in startup diagnostics", async () => {
    // Two edge cases on the same path: a plain-string throw must not
    // crash the formatter, and a self-referential `cause` chain must
    // not loop. Both fall on the same `formatInitErrorDetails` code
    // path so one test exercises both.
    const cyclic = new Error("outer") as Error & { cause?: unknown }
    cyclic.cause = cyclic
    mocks.initServices.mockRejectedValue(cyclic)
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)

    try {
      await startServer()

      const text =
        (
          await mocks.servers[0]!.tools.get("lore-context")!.handler({
            action: "status",
          })
        ).content[0]?.text ?? ""
      expect(text).toContain("Error: outer")
      // Cycle protection — the outer error appears once, not twice or
      // more, despite `cause` pointing back at itself.
      const outerOccurrences = text.match(/Error: outer/g) ?? []
      expect(outerOccurrences.length).toBe(1)
    } finally {
      stderr.mockRestore()
    }
  })

  it("formats string throwables without crashing the diagnostic formatter", async () => {
    mocks.initServices.mockRejectedValue("plain string failure")
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)

    try {
      await startServer()

      const text =
        (
          await mocks.servers[0]!.tools.get("lore-context")!.handler({
            action: "status",
          })
        ).content[0]?.text ?? ""
      expect(text).toContain("plain string failure")
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("plain string failure"))
    } finally {
      stderr.mockRestore()
    }
  })

  it("does not convert tool registration failures into setup diagnostics", async () => {
    mocks.initServices.mockResolvedValue({} as never)
    mocks.registerMemoryTools.mockImplementation(() => {
      throw new Error("registration boom")
    })
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const stdoutLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    try {
      await expect(startServer()).rejects.toThrow("registration boom")

      expect(mocks.registerContextTools).toHaveBeenCalled()
      expect(mocks.registerMemoryTools).toHaveBeenCalled()
      expect(mocks.registerQueryTools).not.toHaveBeenCalled()
      expect(mocks.servers[0]?.tools.size).toBe(0)
      expect(mocks.servers[0]?.connect).not.toHaveBeenCalled()
      expect(stderr).not.toHaveBeenCalled()
      expect(stdoutLog).not.toHaveBeenCalled()
      expect(stdoutWrite).not.toHaveBeenCalled()
    } finally {
      stdoutWrite.mockRestore()
      stdoutLog.mockRestore()
      stderr.mockRestore()
    }
  })

  it("does not convert transport connection failures into setup diagnostics", async () => {
    mocks.initServices.mockImplementation(async () => {
      mocks.servers[0]!.connect.mockRejectedValue(new Error("connect boom"))
      return {} as never
    })
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const stdoutLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    try {
      await expect(startServer()).rejects.toThrow("connect boom")

      expect(mocks.registerContextTools).toHaveBeenCalled()
      expect(mocks.registerMemoryTools).toHaveBeenCalled()
      expect(mocks.registerQueryTools).toHaveBeenCalled()
      expect(mocks.registerProjectTools).toHaveBeenCalled()
      expect(mocks.registerKnowledgeTools).toHaveBeenCalled()
      expect(mocks.registerDecisionTools).toHaveBeenCalled()
      expect(mocks.registerTaskTools).toHaveBeenCalled()
      expect(mocks.servers[0]?.tools.size).toBe(0)
      expect(stderr).not.toHaveBeenCalled()
      expect(stdoutLog).not.toHaveBeenCalled()
      expect(stdoutWrite).not.toHaveBeenCalled()
    } finally {
      stdoutWrite.mockRestore()
      stdoutLog.mockRestore()
      stderr.mockRestore()
    }
  })

  it("fails fast instead of serving diagnostics inside background agent children", async () => {
    const previous = process.env["LORE_AUTOSAVE"]
    const previousBackgroundAgent = process.env["LORE_BACKGROUND_AGENT"]
    process.env["LORE_AUTOSAVE"] = "false"
    process.env["LORE_BACKGROUND_AGENT"] = "true"
    mocks.initServices.mockRejectedValue(new Error("No Notion auth configured."))
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    const stdoutLog = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockImplementation(() => true)

    try {
      await expect(startServer()).rejects.toThrow("No Notion auth configured.")

      expect(mocks.servers[0]?.tools.size).toBe(0)
      expect(mocks.servers[0]?.connect).not.toHaveBeenCalled()
      expect(stderr).not.toHaveBeenCalled()
      expect(stdoutLog).not.toHaveBeenCalled()
      expect(stdoutWrite).not.toHaveBeenCalled()
    } finally {
      if (previous === undefined) {
        delete process.env["LORE_AUTOSAVE"]
      } else {
        process.env["LORE_AUTOSAVE"] = previous
      }
      if (previousBackgroundAgent === undefined) {
        delete process.env["LORE_BACKGROUND_AGENT"]
      } else {
        process.env["LORE_BACKGROUND_AGENT"] = previousBackgroundAgent
      }
      stdoutWrite.mockRestore()
      stdoutLog.mockRestore()
      stderr.mockRestore()
    }
  })
})
