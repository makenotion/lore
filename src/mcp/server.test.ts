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
  registerQueryTools: vi.fn(),
  registerProjectTools: vi.fn(),
  registerKnowledgeTools: vi.fn(),
  registerDecisionTools: vi.fn(),
  registerTaskTools: vi.fn(),
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

const DIAGNOSTIC_TOOL_NAMES = [
  "lore-context",
  "lore-decision",
  "lore-fact",
  "lore-memory",
  "lore-project",
  "lore-query",
  "lore-task",
]

afterEach(() => {
  vi.clearAllMocks()
  mocks.initServices.mockReset()
  mocks.registerContextTools.mockReset()
  mocks.registerMemoryTools.mockReset()
  mocks.registerQueryTools.mockReset()
  mocks.registerProjectTools.mockReset()
  mocks.registerKnowledgeTools.mockReset()
  mocks.registerDecisionTools.mockReset()
  mocks.registerTaskTools.mockReset()
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
      expect(text).toContain("````\nNo .lore.yaml found")
      expect(text).toContain("```shell\nlore init\n```")
      expect(text).toContain("lore init")
      expect(text).toContain("lore auth --login")
      expect(text).toContain("restart or reconnect the MCP client")
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining("starting diagnostic MCP server")
      )
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
