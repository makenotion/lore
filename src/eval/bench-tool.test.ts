import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Memory } from "../types.js"

const mocks = vi.hoisted(() => ({
  initServices: vi.fn(),
  runAsk: vi.fn(),
}))

vi.mock("../services.js", () => ({
  initServices: mocks.initServices,
}))

vi.mock("../core/ask.js", () => ({
  runAsk: mocks.runAsk,
}))

import {
  BENCH_TOOL_PROJECT_ID_ENV,
  BENCH_TOOL_SOCKET_ENV,
  BENCH_TOOL_TRACE_ENV,
  runBenchToolCli,
  startBenchToolBroker,
} from "./bench-tool.js"

function testMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-1",
    title: "Color preference",
    projectIds: ["project-1"],
    topicId: null,
    source: "conversation",
    kind: "note",
    status: "informational",
    pinned: null,
    synopsis: "The preferred color is blue.",
    content: "I like blue.",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    scope: { kind: "project", projectIds: ["project-1"], audience: [] },
    ...overrides,
  } as Memory
}

describe("runBenchToolCli", () => {
  let stdoutSpy: { mockRestore: () => void }
  let stderrSpy: { mockRestore: () => void }
  let stdoutOutput: string[] = []
  let stderrOutput: string[] = []
  let tempDirs: string[] = []
  let savedToken: string | undefined
  let savedConfigRoot: string | undefined
  let savedNotionEnv: string | undefined

  beforeEach(() => {
    mocks.initServices.mockReset()
    mocks.runAsk.mockReset()
    stdoutOutput = []
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdoutOutput.push(String(chunk))
      return true
    })
    stderrOutput = []
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderrOutput.push(String(chunk))
      return true
    })
    tempDirs = []
    savedToken = process.env["NOTION_API_TOKEN"]
    savedConfigRoot = process.env["LORE_CONFIG_ROOT"]
    savedNotionEnv = process.env["NOTION_ENV"]
    delete process.env["NOTION_API_TOKEN"]
    delete process.env["LORE_CONFIG_ROOT"]
    delete process.env["NOTION_ENV"]
  })

  afterEach(async () => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    if (savedToken === undefined) delete process.env["NOTION_API_TOKEN"]
    else process.env["NOTION_API_TOKEN"] = savedToken
    if (savedConfigRoot === undefined) delete process.env["LORE_CONFIG_ROOT"]
    else process.env["LORE_CONFIG_ROOT"] = savedConfigRoot
    if (savedNotionEnv === undefined) delete process.env["NOTION_ENV"]
    else process.env["NOTION_ENV"] = savedNotionEnv
    for (const dir of tempDirs) {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("loads bench auth from the workspace Codex config for shim commands", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-tool-test-"))
    tempDirs.push(workspace)
    await mkdir(join(workspace, ".codex"))
    await writeFile(
      join(workspace, ".codex", "config.toml"),
      [
        "[mcp_servers.lore.env]",
        'NOTION_API_TOKEN = "ntn_FROM_CONFIG_FOR_BENCH_TOOL_TEST_1234567890"',
        'LORE_CONFIG_ROOT = "/tmp/lore-bench-config"',
        'NOTION_ENV = "dev"',
        "",
      ].join("\n")
    )
    const search = vi.fn(async () => [testMemory()])
    mocks.initServices.mockImplementation(async () => {
      expect(process.env["NOTION_API_TOKEN"]).toBe(
        "ntn_FROM_CONFIG_FOR_BENCH_TOOL_TEST_1234567890"
      )
      expect(process.env["LORE_CONFIG_ROOT"]).toBe("/tmp/lore-bench-config")
      expect(process.env["NOTION_ENV"]).toBe("dev")
      return { memories: { search } }
    })

    const traceFile = join(workspace, "lore-tool-trace.jsonl")
    const exitCode = await runBenchToolCli(
      "lore-query",
      ["action=search", "query=blue"],
      {
        [BENCH_TOOL_TRACE_ENV]: traceFile,
        [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
      }
    )

    expect(exitCode).toBe(0)
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({ query: "blue", projectId: "project-1" })
    )
    const trace = JSON.parse(await readFile(traceFile, "utf-8"))
    expect(trace).toMatchObject({
      tool: "lore-query",
      action: "search",
      status: "success",
      surfacedMemoryIds: ["mem-1"],
    })
    expect(process.env["NOTION_API_TOKEN"]).toBeUndefined()
    expect(process.env["LORE_CONFIG_ROOT"]).toBeUndefined()
    expect(process.env["NOTION_ENV"]).toBeUndefined()
  })

  it("routes shim calls through a broker without client-visible auth env", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-tool-test-"))
    tempDirs.push(workspace)
    const savedWriteBudget = process.env["LORE_MCP_WRITE_BUDGET"]
    const savedBudgetState = process.env["LORE_MCP_BUDGET_STATE_FILE"]
    process.env["LORE_MCP_WRITE_BUDGET"] = "500"
    process.env["LORE_MCP_BUDGET_STATE_FILE"] = "/tmp/should-not-reach-broker.json"
    const search = vi.fn(async () => [testMemory()])
    mocks.initServices.mockImplementation(async () => {
      expect(process.env["NOTION_API_TOKEN"]).toBe("ntn_BROKER_TOKEN")
      expect(process.env["LORE_CONFIG_ROOT"]).toBe("/tmp/lore-broker-config")
      expect(process.env["NOTION_ENV"]).toBe("dev")
      expect(process.env["LORE_MCP_WRITE_BUDGET"]).toBeUndefined()
      expect(process.env["LORE_MCP_BUDGET_STATE_FILE"]).toBeUndefined()
      return { memories: { search } }
    })
    const traceFile = join(workspace, "trace.jsonl")
    const broker = await startBenchToolBroker({
      socketPath: join(workspace, "broker.sock"),
      traceFile,
      projectId: "project-1",
      projectName: "Bench Project",
      runtimeEnv: {
        NOTION_API_TOKEN: "ntn_BROKER_TOKEN",
        LORE_CONFIG_ROOT: "/tmp/lore-broker-config",
        NOTION_ENV: "dev",
      },
    })

    try {
      const exitCode = await runBenchToolCli(
        "lore-query",
        ["action=search", "query=blue"],
        { [BENCH_TOOL_SOCKET_ENV]: broker.socketPath }
      )

      expect(exitCode, stderrOutput.join("")).toBe(0)
      expect(search).toHaveBeenCalledWith(
        expect.objectContaining({ query: "blue", projectId: "project-1" })
      )
      const trace = JSON.parse(await readFile(traceFile, "utf-8"))
      expect(trace).toMatchObject({
        tool: "lore-query",
        action: "search",
        status: "success",
        surfacedMemoryIds: ["mem-1"],
      })
      expect(process.env["NOTION_API_TOKEN"]).toBeUndefined()
      expect(process.env["LORE_CONFIG_ROOT"]).toBeUndefined()
      expect(process.env["NOTION_ENV"]).toBeUndefined()
      expect(process.env["LORE_MCP_WRITE_BUDGET"]).toBe("500")
      expect(process.env["LORE_MCP_BUDGET_STATE_FILE"]).toBe(
        "/tmp/should-not-reach-broker.json"
      )
    } finally {
      await broker.close()
      if (savedWriteBudget === undefined) delete process.env["LORE_MCP_WRITE_BUDGET"]
      else process.env["LORE_MCP_WRITE_BUDGET"] = savedWriteBudget
      if (savedBudgetState === undefined) delete process.env["LORE_MCP_BUDGET_STATE_FILE"]
      else process.env["LORE_MCP_BUDGET_STATE_FILE"] = savedBudgetState
    }
  })

  it("requires a bench project boundary for retrieval", async () => {
    mocks.initServices.mockResolvedValue({
      memories: { search: vi.fn(async () => [testMemory()]) },
    })
    const exitCode = await runBenchToolCli("lore-query", ["action=search", "query=blue"])

    expect(exitCode).toBe(1)
    expect(stderrOutput.join("")).toContain("LORE_BENCH_TOOL_PROJECT_ID is required")
  })

  it("filters search results to the bench project before rendering or tracing", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-tool-test-"))
    tempDirs.push(workspace)
    const traceFile = join(workspace, "trace.jsonl")
    const search = vi.fn(async () => [
      testMemory({ id: "mem-project", title: "Project color" }),
      testMemory({
        id: "mem-unscoped",
        title: "Unscoped secret",
        projectIds: [],
        synopsis: "This should not render.",
        content: "Unscoped body should not render.",
      }),
    ])
    mocks.initServices.mockResolvedValue({
      memories: { search },
    })

    const exitCode = await runBenchToolCli(
      "lore-query",
      ["action=search", "query=blue", "includeContent=true"],
      {
        [BENCH_TOOL_TRACE_ENV]: traceFile,
        [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
      }
    )

    expect(exitCode, stderrOutput.join("")).toBe(0)
    const stdout = stdoutOutput.join("")
    expect(stdout).toContain("mem-project")
    expect(stdout).not.toContain("mem-unscoped")
    expect(stdout).not.toContain("Unscoped body should not render.")
    const trace = JSON.parse(await readFile(traceFile, "utf-8"))
    expect(trace).toMatchObject({
      tool: "lore-query",
      action: "search",
      status: "success",
      surfacedMemoryIds: ["mem-project"],
    })
  })

  it("recalls only scoped project memories and disables unscoped reads", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-tool-test-"))
    tempDirs.push(workspace)
    const traceFile = join(workspace, "trace.jsonl")
    const list = vi.fn(async () => ({
      items: [
        testMemory({ id: "mem-project", title: "Project color" }),
        testMemory({
          id: "mem-unscoped",
          title: "Unscoped secret",
          projectIds: [],
          synopsis: "This should not render.",
          content: "Unscoped body should not render.",
        }),
      ],
    }))
    mocks.initServices.mockResolvedValue({
      memories: { list },
    })

    const exitCode = await runBenchToolCli(
      "lore-query",
      ["action=recall", "includeContent=true"],
      {
        [BENCH_TOOL_TRACE_ENV]: traceFile,
        [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
      }
    )

    expect(exitCode, stderrOutput.join("")).toBe(0)
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        includeUnscoped: false,
      })
    )
    const stdout = stdoutOutput.join("")
    expect(stdout).toContain("mem-project")
    expect(stdout).not.toContain("mem-unscoped")
    expect(stdout).not.toContain("Unscoped body should not render.")
    const trace = JSON.parse(await readFile(traceFile, "utf-8"))
    expect(trace).toMatchObject({
      tool: "lore-query",
      action: "recall",
      status: "success",
      surfacedMemoryIds: ["mem-project"],
    })
  })

  it("does not expose ask through the bench shim", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-tool-test-"))
    tempDirs.push(workspace)
    const traceFile = join(workspace, "trace.jsonl")
    mocks.runAsk.mockResolvedValue({
      text: "Unscoped fact should not render.",
      data: {
        facts: {
          governance: [{ sourceMemoryId: "mem-unscoped" }],
          structure: [],
        },
      },
    })
    mocks.initServices.mockResolvedValue({})

    const exitCode = await runBenchToolCli("lore-query", ["action=ask", "entity=Color"], {
      [BENCH_TOOL_TRACE_ENV]: traceFile,
    })

    expect(exitCode).toBe(1)
    expect(mocks.runAsk).not.toHaveBeenCalled()
    expect(stdoutOutput.join("")).not.toContain("Unscoped fact should not render.")
    expect(stderrOutput.join("")).toContain("supported actions: search, recall")
    const trace = JSON.parse(await readFile(traceFile, "utf-8"))
    expect(trace).toMatchObject({
      tool: "lore-query",
      action: "ask",
      status: "error",
      surfacedMemoryIds: [],
      expandedMemoryIds: [],
    })
    expect(trace.error).toContain("supported actions: search, recall")
  })

  it("refuses to expand memories outside the bench project", async () => {
    mocks.initServices.mockResolvedValue({
      memories: {
        getById: vi.fn(async () => testMemory({ projectIds: ["other-project"] })),
      },
    })
    const exitCode = await runBenchToolCli(
      "lore-memory",
      ["action=expand", "ids=mem-1"],
      { [BENCH_TOOL_PROJECT_ID_ENV]: "project-1" }
    )

    expect(exitCode).toBe(1)
    expect(stderrOutput.join("")).toContain("outside bench project project-1")
  })

  it("redacts bearer-shaped values from trace errors", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-tool-test-"))
    tempDirs.push(workspace)
    const traceFile = join(workspace, "trace.jsonl")
    mocks.initServices.mockResolvedValue({
      memories: {
        search: vi.fn(async () => {
          throw new Error("failed with ntn_SECRET_VALUE_SHOULD_NOT_LEAK_1234567890")
        }),
      },
    })

    const exitCode = await runBenchToolCli(
      "lore-query",
      ["action=search", "query=blue"],
      {
        [BENCH_TOOL_TRACE_ENV]: traceFile,
        [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
      }
    )

    expect(exitCode).toBe(1)
    const trace = JSON.parse(await readFile(traceFile, "utf-8"))
    expect(trace.error).toContain("<redacted-token>")
    expect(trace.error).not.toContain("ntn_SECRET_VALUE")
    expect(stderrOutput.join("")).toContain("<redacted-token>")
  })
})
