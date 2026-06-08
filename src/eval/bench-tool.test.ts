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
  BENCH_TOOL_PROJECT_NAME_ENV,
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

  it("renders SkillRet search results as skill candidate cards", async () => {
    const search = vi.fn(async () => [
      testMemory({
        id: "mem-skill-alpha",
        title: "Alpha Skill",
        source: "manual",
        kind: "procedure",
        synopsis:
          "Skill: Alpha Skill. Use when: route tenant metadata requests. Category: architecture / routing.",
        tags: [
          "skillret",
          "skillret-split-test",
          "skillret-kind-procedure",
          "skillret-major-architecture",
          "skillret-sub-routing",
        ],
        keywords:
          "skillret skillret:fixture skillret:skill-alpha skillret/test/fixture/architecture/routing/skill-alpha",
      }),
    ])
    mocks.initServices.mockResolvedValue({
      memories: { search },
    })

    const exitCode = await runBenchToolCli(
      "lore-query",
      ["action=search", "query=tenant metadata routing"],
      {
        [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
        [BENCH_TOOL_PROJECT_NAME_ENV]: "SkillRet Eval",
      }
    )

    expect(exitCode, stderrOutput.join("")).toBe(0)
    const stdout = stdoutOutput.join("")
    expect(stdout).toContain("### Skill Candidate: Alpha Skill")
    expect(stdout).toContain("Rank: 1")
    expect(stdout).toContain("Expand Candidate: lore-memory action=expand ids=m1")
    expect(stdout).toContain("Cite IDs from expanded output only.")
    expect(stdout).toContain("Skill Name: Alpha Skill")
    expect(stdout).toContain("Short Summary: Skill: Alpha Skill.")
    expect(stdout).toContain("SkillRet Category: Architecture / Routing")
    expect(stdout).not.toContain("Memory ID:")
    expect(stdout).not.toContain("skillret-kind-procedure")
    expect(stdout).not.toContain("SkillRet Search Keys:")
    expect(stdout).toContain("Compare rank, Skill Name, Short Summary, category")
    expect(stdout).toContain("latest` is replaced by every search")
  })

  it("mirrors planned search metadata from the Lore search service", async () => {
    const searchWithMeta = vi.fn(async () => ({
      memories: [
        testMemory({
          id: "mem-skill-alpha",
          title: "Alpha Skill",
          source: "manual",
          kind: "procedure",
          synopsis: "Skill: Alpha Skill. Use when: route tenant metadata requests.",
          tags: ["skillret", "skillret-major-architecture"],
        }),
      ],
      capped: false,
      queryPlan: {
        originalQuery: "tenant metadata routing",
        variants: [
          { kind: "original", query: "tenant metadata routing" },
          { kind: "facets", query: "routing tenant metadata" },
        ],
      },
    }))
    mocks.initServices.mockResolvedValue({
      memories: { search: vi.fn(), searchWithMeta },
    })

    const exitCode = await runBenchToolCli(
      "lore-query",
      ["action=search", "query=tenant metadata routing"],
      {
        [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
        [BENCH_TOOL_PROJECT_NAME_ENV]: "SkillRet Eval",
      }
    )

    expect(exitCode, stderrOutput.join("")).toBe(0)
    expect(searchWithMeta).toHaveBeenCalledWith(
      expect.objectContaining({ strategy: "planned" })
    )
    const stdout = stdoutOutput.join("")
    expect(stdout).toContain("## Query plan")
    expect(stdout).toContain("1. original: tenant metadata routing")
    expect(stdout).toContain("### Skill Candidate: Alpha Skill")
  })

  it("redacts bearer-shaped query text from rendered search output", async () => {
    const token = "ntn_abcdefghijklmnopqrstuvwxyz1234567890"
    const searchWithMeta = vi.fn(async () => ({
      memories: [],
      capped: false,
      queryPlan: {
        originalQuery: `debug ${token}`,
        variants: [
          { kind: "original", query: `debug ${token}` },
          { kind: "facets", query: `debug token ${token}` },
        ],
      },
    }))
    mocks.initServices.mockResolvedValue({
      memories: { search: vi.fn(), searchWithMeta },
    })

    const exitCode = await runBenchToolCli(
      "lore-query",
      ["action=search", `query=debug ${token}`],
      { [BENCH_TOOL_PROJECT_ID_ENV]: "project-1" }
    )

    expect(exitCode, stderrOutput.join("")).toBe(0)
    expect(searchWithMeta).toHaveBeenCalledWith(
      expect.objectContaining({ query: `debug ${token}` })
    )
    const stdout = stdoutOutput.join("")
    expect(stdout).not.toContain(token)
    expect(stdout).toContain("<redacted-token>")
    expect(stdout).toContain("## Query plan")
  })

  it("resolves listed memory handles when expanding search results", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-tool-test-"))
    tempDirs.push(workspace)
    const traceFile = join(workspace, "trace.jsonl")
    const memory = testMemory({ id: "mem-project", title: "Project color" })
    const search = vi.fn(async () => [memory])
    const getById = vi.fn(async (id: string) => {
      expect(id).toBe("mem-project")
      return memory
    })
    mocks.initServices.mockResolvedValue({
      memories: { search, getById },
    })
    const env = {
      [BENCH_TOOL_TRACE_ENV]: traceFile,
      [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
    }

    const searchExitCode = await runBenchToolCli(
      "lore-query",
      ["action=search", "query=blue"],
      env
    )
    const expandExitCode = await runBenchToolCli(
      "lore-memory",
      ["action=expand", "ids=m1"],
      env
    )

    expect(searchExitCode, stderrOutput.join("")).toBe(0)
    expect(expandExitCode, stderrOutput.join("")).toBe(0)
    expect(stdoutOutput.join("")).toContain("Handle: m1")
    expect(stdoutOutput.join("")).toContain("Expanded 1 memory")
    const trace = (await readFile(traceFile, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown)
    expect(trace).toEqual([
      expect.objectContaining({
        tool: "lore-query",
        action: "search",
        surfacedMemoryIds: ["mem-project"],
      }),
      expect.objectContaining({
        tool: "lore-memory",
        action: "expand",
        surfacedMemoryIds: ["mem-project"],
        expandedMemoryIds: ["mem-project"],
      }),
    ])
  })

  it("renders expanded SkillRet memories with memory-id and skill-id guidance", async () => {
    const memory = testMemory({
      id: "mem-skill-alpha",
      title: "Alpha Skill",
      source: "manual",
      kind: "procedure",
      tags: ["skillret", "skillret-kind-procedure"],
      content: [
        "# Alpha Skill",
        "",
        "SkillRet ID: f6986dea-bb4c-4442-b0d0-3c960e732767",
        "",
        "## Skill",
        "",
        "Prefer alpha routing when tenant metadata is authoritative.",
      ].join("\n"),
    })
    const getById = vi.fn(async () => memory)
    mocks.initServices.mockResolvedValue({
      memories: { getById },
    })

    const exitCode = await runBenchToolCli(
      "lore-memory",
      ["action=expand", "ids=mem-skill-alpha"],
      { [BENCH_TOOL_PROJECT_ID_ENV]: "project-1" }
    )

    expect(exitCode, stderrOutput.join("")).toBe(0)
    const stdout = stdoutOutput.join("")
    expect(stdout).toContain("### Skill Candidate Expanded: Alpha Skill")
    expect(stdout).toContain(
      "Use in usedMemoryIds and lore-memory expand: mem-skill-alpha"
    )
    expect(stdout).toContain(
      "Use in usedSkillIds only: f6986dea-bb4c-4442-b0d0-3c960e732767"
    )
    expect(stdout).toContain("Do not pass SkillRet IDs to lore-memory expand.")
  })

  it("keeps memory handles stable across multiple searches", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-tool-test-"))
    tempDirs.push(workspace)
    const traceFile = join(workspace, "trace.jsonl")
    const first = testMemory({ id: "mem-first", title: "First memory" })
    const second = testMemory({ id: "mem-second", title: "Second memory" })
    const search = vi
      .fn()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second, first])
    const getById = vi.fn(async (id: string) => (id === "mem-first" ? first : second))
    mocks.initServices.mockResolvedValue({
      memories: { search, getById },
    })
    const env = {
      [BENCH_TOOL_TRACE_ENV]: traceFile,
      [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
    }

    expect(
      await runBenchToolCli("lore-query", ["action=search", "query=first"], env)
    ).toBe(0)
    expect(
      await runBenchToolCli("lore-query", ["action=search", "query=second"], env)
    ).toBe(0)
    expect(
      await runBenchToolCli("lore-memory", ["action=expand", "ids=m1,m2"], env)
    ).toBe(0)

    const stdout = stdoutOutput.join("")
    expect(stdout).toContain("### First memory\n*Handle: m1")
    expect(stdout).toContain("### Second memory\n*Handle: m2")
    expect(getById).toHaveBeenCalledWith("mem-first")
    expect(getById).toHaveBeenCalledWith("mem-second")
  })

  it("expands the latest surfaced result set with the latest token", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-tool-test-"))
    tempDirs.push(workspace)
    const traceFile = join(workspace, "trace.jsonl")
    const first = testMemory({ id: "mem-first", title: "First memory" })
    const second = testMemory({ id: "mem-second", title: "Second memory" })
    const search = vi
      .fn()
      .mockResolvedValueOnce([first])
      .mockResolvedValueOnce([second, first])
    const getById = vi.fn(async (id: string) => (id === "mem-first" ? first : second))
    mocks.initServices.mockResolvedValue({
      memories: { search, getById },
    })
    const env = {
      [BENCH_TOOL_TRACE_ENV]: traceFile,
      [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
    }

    expect(
      await runBenchToolCli("lore-query", ["action=search", "query=first"], env)
    ).toBe(0)
    expect(
      await runBenchToolCli("lore-query", ["action=search", "query=second"], env)
    ).toBe(0)
    expect(
      await runBenchToolCli("lore-memory", ["action=expand", "ids=latest"], env)
    ).toBe(0)

    expect(stdoutOutput.join("")).toContain("Expanded 2 memories")
    expect(getById.mock.calls.map(([id]) => id)).toEqual(["mem-second", "mem-first"])
    const trace = (await readFile(traceFile, "utf-8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown)
    expect(trace.at(-1)).toMatchObject({
      tool: "lore-memory",
      action: "expand",
      surfacedMemoryIds: ["mem-second", "mem-first"],
      expandedMemoryIds: ["mem-second", "mem-first"],
    })
  })

  it("resolves recall handles and supports m2", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-tool-test-"))
    tempDirs.push(workspace)
    const traceFile = join(workspace, "trace.jsonl")
    const first = testMemory({ id: "mem-first", title: "First memory" })
    const second = testMemory({ id: "mem-second", title: "Second memory" })
    const list = vi.fn(async () => ({ items: [first, second] }))
    const getById = vi.fn(async (id: string) => (id === "mem-first" ? first : second))
    mocks.initServices.mockResolvedValue({
      memories: { list, getById },
    })
    const env = {
      [BENCH_TOOL_TRACE_ENV]: traceFile,
      [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
    }

    expect(await runBenchToolCli("lore-query", ["action=recall"], env)).toBe(0)
    expect(await runBenchToolCli("lore-memory", ["action=expand", "ids=m2"], env)).toBe(0)

    expect(stdoutOutput.join("")).toContain("### Second memory")
    expect(getById).toHaveBeenCalledWith("mem-second")
  })

  it("rejects memory handles before any surfaced results exist", async () => {
    mocks.initServices.mockResolvedValue({
      memories: { getById: vi.fn() },
    })

    const exitCode = await runBenchToolCli("lore-memory", ["action=expand", "ids=m1"], {
      [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
    })

    expect(exitCode).toBe(1)
    expect(stderrOutput.join("")).toContain("run lore-query search or recall first")
  })

  it("rejects the latest token before any surfaced results exist", async () => {
    mocks.initServices.mockResolvedValue({
      memories: { getById: vi.fn() },
    })

    const exitCode = await runBenchToolCli(
      "lore-memory",
      ["action=expand", "ids=latest"],
      { [BENCH_TOOL_PROJECT_ID_ENV]: "project-1" }
    )

    expect(exitCode).toBe(1)
    expect(stderrOutput.join("")).toContain("run lore-query search or recall first")
  })

  it("rejects memory handles outside the known handle range", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-tool-test-"))
    tempDirs.push(workspace)
    const traceFile = join(workspace, "trace.jsonl")
    const memory = testMemory({ id: "mem-project", title: "Project color" })
    mocks.initServices.mockResolvedValue({
      memories: {
        search: vi.fn(async () => [memory]),
        getById: vi.fn(),
      },
    })
    const env = {
      [BENCH_TOOL_TRACE_ENV]: traceFile,
      [BENCH_TOOL_PROJECT_ID_ENV]: "project-1",
    }

    expect(
      await runBenchToolCli("lore-query", ["action=search", "query=blue"], env)
    ).toBe(0)
    const exitCode = await runBenchToolCli(
      "lore-memory",
      ["action=expand", "ids=m2"],
      env
    )

    expect(exitCode).toBe(1)
    expect(stderrOutput.join("")).toContain("known handles: m1..m1")
  })

  it("rejects abbreviated hex memory ids before expanding", async () => {
    const getById = vi.fn()
    mocks.initServices.mockResolvedValue({
      memories: { getById },
    })

    const exitCode = await runBenchToolCli(
      "lore-memory",
      ["action=expand", "ids=27fa8a"],
      { [BENCH_TOOL_PROJECT_ID_ENV]: "project-1" }
    )

    expect(exitCode).toBe(1)
    expect(getById).not.toHaveBeenCalled()
    expect(stderrOutput.join("")).toContain("looks abbreviated")
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
