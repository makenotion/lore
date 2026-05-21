import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  assertBenchSandboxProfileMatchesSuite,
  assertBenchEnvReady,
  assertSandboxProjectName,
  buildBenchWorkspace,
  extractUlidFromSubProjectName,
  filterOrphanSubProjects,
  generateUlid,
  isUlid,
  makeSubProjectName,
  parseAgentTurnCompleted,
  restoreBenchEnv,
  runBenchExample,
  runBenchSuite,
  SUB_PROJECT_NAME_REGEX,
  ulidTimestampMs,
  type BenchSandbox,
} from "./bench-runner.js"
import { BENCH_TOOL_SOCKET_ENV } from "./bench-tool.js"
import type { AgentAdapter } from "./task-runner.js"
import { resolveProfileFromConfig } from "../profile/index.js"

const TEST_PRICING = {
  models: {
    "gpt-4o-mini-2024-07-18": {
      inputPer1K: 0,
      cachedInputPer1K: 0,
      outputPer1K: 0,
      reasoningOutputPer1K: 0,
    },
    "gpt-4o-2024-08-06": {
      inputPer1K: 0,
      cachedInputPer1K: 0,
      outputPer1K: 0,
      reasoningOutputPer1K: 0,
    },
  },
  ingestion: {
    perSessionEstimatedUsd: 0,
    calibrationSource: "test",
    calibratedAt: "2026-05-21",
  },
}

const TEST_JUDGE_PROMPTS = {
  recall: "judge",
  abstention: "judge abstention",
  recallSha256: "r".repeat(64),
  abstentionSha256: "a".repeat(64),
}

describe("generateUlid", () => {
  it("produces a 26-char Crockford base32 string", () => {
    const ulid = generateUlid()
    expect(ulid).toHaveLength(26)
    expect(isUlid(ulid)).toBe(true)
  })

  it("embeds the timestamp in the leading 10 chars", () => {
    const t = Date.UTC(2026, 4, 13, 6, 0, 0)
    const ulid = generateUlid(t)
    expect(ulidTimestampMs(ulid)).toBe(t)
  })

  it("sorts lexicographically by time", () => {
    const a = generateUlid(1000)
    const b = generateUlid(2000)
    expect(a < b).toBe(true)
  })
})

describe("makeSubProjectName", () => {
  it("uses the example id as-is when under the cap", () => {
    const ulid = generateUlid(1000)
    const name = makeSubProjectName("lme_s_0001", ulid)
    expect(name).toMatch(SUB_PROJECT_NAME_REGEX)
    expect(name).toContain("lme_s_0001")
    expect(name).toContain(ulid)
  })

  it("truncates the example-id side when the combined length exceeds 80", () => {
    const ulid = generateUlid(1000)
    const long = "x".repeat(200)
    const name = makeSubProjectName(long, ulid)
    expect(name.length).toBeLessThanOrEqual(80)
    expect(name).toContain(ulid)
  })

  it("produces names that match SUB_PROJECT_NAME_REGEX", () => {
    expect(
      SUB_PROJECT_NAME_REGEX.test(makeSubProjectName("abc", generateUlid(1000)))
    ).toBe(true)
  })
})

describe("assertBenchEnvReady authoritative overwrite + restore", () => {
  const KEYS = [
    "LORE_EVAL_BENCH_REAL",
    "LORE_BENCH_NOTION_TOKEN",
    "LORE_BENCH_OPENAI_API_KEY",
    "LORE_BENCH_CONFIG_ROOT",
    "LORE_BENCH_SANDBOX_PROJECT_NAME",
    "NOTION_API_TOKEN",
    "LORE_CONFIG_ROOT",
  ]
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = {}
    for (const k of KEYS) {
      saved[k] = process.env[k]
      delete process.env[k]
    }
  })

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it("overwrites NOTION_API_TOKEN / LORE_CONFIG_ROOT with bench values even when operator pre-set them", () => {
    process.env["LORE_EVAL_BENCH_REAL"] = "1"
    process.env["LORE_BENCH_NOTION_TOKEN"] = "bench-token"
    process.env["LORE_BENCH_OPENAI_API_KEY"] = "openai-key"
    process.env["LORE_BENCH_CONFIG_ROOT"] = "/bench/config/root"
    process.env["LORE_BENCH_SANDBOX_PROJECT_NAME"] = "Bench Sandbox"
    // Operator's day-to-day env pre-set to different values.
    process.env["NOTION_API_TOKEN"] = "operator-day-token"
    process.env["LORE_CONFIG_ROOT"] = "/operator/config/root"

    const snapshot = assertBenchEnvReady()

    // Bench is authoritative — overwrite landed unconditionally.
    expect(process.env["NOTION_API_TOKEN"]).toBe("bench-token")
    expect(process.env["LORE_CONFIG_ROOT"]).toBe("/bench/config/root")
    // Snapshot captures the pre-bench values for restore.
    expect(snapshot.notionApiToken).toBe("operator-day-token")
    expect(snapshot.loreConfigRoot).toBe("/operator/config/root")

    restoreBenchEnv(snapshot)

    expect(process.env["NOTION_API_TOKEN"]).toBe("operator-day-token")
    expect(process.env["LORE_CONFIG_ROOT"]).toBe("/operator/config/root")
  })

  it("restore deletes the keys when they were unset pre-bench", () => {
    process.env["LORE_EVAL_BENCH_REAL"] = "1"
    process.env["LORE_BENCH_NOTION_TOKEN"] = "bench-token"
    process.env["LORE_BENCH_OPENAI_API_KEY"] = "openai-key"
    process.env["LORE_BENCH_CONFIG_ROOT"] = "/bench/config/root"
    process.env["LORE_BENCH_SANDBOX_PROJECT_NAME"] = "Bench Sandbox"
    // NOTION_API_TOKEN / LORE_CONFIG_ROOT intentionally unset.

    const snapshot = assertBenchEnvReady()
    expect(snapshot.notionApiToken).toBeUndefined()
    expect(snapshot.loreConfigRoot).toBeUndefined()

    restoreBenchEnv(snapshot)
    expect(process.env["NOTION_API_TOKEN"]).toBeUndefined()
    expect(process.env["LORE_CONFIG_ROOT"]).toBeUndefined()
  })
})

describe("assertSandboxProjectName", () => {
  it("rejects production-shaped names", () => {
    expect(() => assertSandboxProjectName("lme-x-Production")).toThrow(/production/i)
    expect(() => assertSandboxProjectName("lme-x-prod")).toThrow(/production/i)
  })

  it("rejects names without a sandbox marker", () => {
    expect(() => assertSandboxProjectName("hello")).toThrow(/sandbox/)
  })

  it("accepts sandbox-marked names", () => {
    expect(() => assertSandboxProjectName("lme-test-01HXYZ")).not.toThrow()
    expect(() => assertSandboxProjectName("lme-sandbox-01HXYZ")).not.toThrow()
    expect(() => assertSandboxProjectName("lme-eval-01HXYZ")).not.toThrow()
  })
})

describe("assertBenchSandboxProfileMatchesSuite", () => {
  it("rejects profile-declared suites when the sandbox profile differs", () => {
    const profile = resolveProfileFromConfig({ profile: "support@1.0.0" })

    expect(() =>
      assertBenchSandboxProfileMatchesSuite({
        sandbox: { activeProfileSelector: "default@1.0.0" },
        profile,
      })
    ).toThrow(/does not match the active sandbox profile/)
  })

  it("accepts matching profile-declared suites and unprofiled suites", () => {
    const profile = resolveProfileFromConfig({ profile: "support@1.0.0" })

    expect(() =>
      assertBenchSandboxProfileMatchesSuite({
        sandbox: { activeProfileSelector: "support@1.0.0" },
        profile,
      })
    ).not.toThrow()
    expect(() =>
      assertBenchSandboxProfileMatchesSuite({
        sandbox: { activeProfileSelector: "default@1.0.0" },
        profile: null,
      })
    ).not.toThrow()
  })
})

describe("runBenchSuite profile guard", () => {
  const keys = [
    "LORE_EVAL_BENCH_REAL",
    "LORE_BENCH_NOTION_TOKEN",
    "LORE_BENCH_OPENAI_API_KEY",
    "LORE_BENCH_CONFIG_ROOT",
    "LORE_BENCH_SANDBOX_PROJECT_NAME",
    "NOTION_API_TOKEN",
    "LORE_CONFIG_ROOT",
  ]
  let saved: Record<string, string | undefined> = {}

  beforeEach(() => {
    saved = {}
    for (const key of keys) {
      saved[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key]
      else process.env[key] = saved[key]
    }
  })

  it("fails before creating sub-projects when the suite and sandbox profiles differ", async () => {
    process.env["LORE_EVAL_BENCH_REAL"] = "1"
    process.env["LORE_BENCH_NOTION_TOKEN"] = "ntn_bench"
    process.env["LORE_BENCH_OPENAI_API_KEY"] = "sk-bench"
    process.env["LORE_BENCH_CONFIG_ROOT"] = "/tmp/lore-bench-config"
    process.env["LORE_BENCH_SANDBOX_PROJECT_NAME"] = "Bench Sandbox"
    let createSubProjectCalled = false
    const sandbox: BenchSandbox = {
      authSource: "env-notion-api-token",
      activeProfileSelector: "default@1.0.0",
      async createSubProject() {
        createSubProjectCalled = true
        return "project-1"
      },
      async createMemoryInProject() {
        throw new Error("not expected")
      },
      async createSimulatedAutosaveMemoryInProject() {
        throw new Error("not expected")
      },
      async getWakeUpForQuery() {
        throw new Error("not expected")
      },
      async archiveProject() {},
      async countMemoriesForProject() {
        return 0
      },
      async countFactsForProject() {
        return 0
      },
    }

    await expect(
      runBenchSuite({
        suitePath: "evals/bench-suites/support-simulated-autosave.yaml",
        sandbox,
      })
    ).rejects.toThrow(/Bench suite profile support@1\.0\.0/)
    expect(createSubProjectCalled).toBe(false)
  })

  it("skips tool-driven suites before seeding when the selected adapter lacks live tools", async () => {
    process.env["LORE_EVAL_BENCH_REAL"] = "1"
    process.env["LORE_BENCH_NOTION_TOKEN"] = "ntn_bench"
    process.env["LORE_BENCH_OPENAI_API_KEY"] = "sk-bench"
    process.env["LORE_BENCH_CONFIG_ROOT"] = "/tmp/lore-bench-config"
    process.env["LORE_BENCH_SANDBOX_PROJECT_NAME"] = "Bench Sandbox"
    let createSubProjectCalled = false
    const sandbox: BenchSandbox = {
      authSource: "env-notion-api-token",
      activeProfileSelector: "default@1.0.0",
      async createSubProject() {
        createSubProjectCalled = true
        return "project-1"
      },
      async createMemoryInProject() {
        throw new Error("not expected")
      },
      async createSimulatedAutosaveMemoryInProject() {
        throw new Error("not expected")
      },
      async getWakeUpForQuery() {
        throw new Error("not expected")
      },
      async archiveProject() {},
      async countMemoriesForProject() {
        return 0
      },
      async countFactsForProject() {
        return 0
      },
    }
    const adapter: AgentAdapter = {
      id: "unsupported",
      async supportsBenchToolDrivenRetrieval() {
        return { supported: false, reason: "probe says no live tools" }
      },
      async run() {
        throw new Error("not expected")
      },
    }
    const outDir = mkdtempSync(join(tmpdir(), "lore-bench-skip-test-"))
    try {
      const { artifact, outPath } = await runBenchSuite({
        suitePath: "evals/bench-suites/longmemeval-raw-transcript.yaml",
        sandbox,
        agentAdapter: adapter,
        pricing: TEST_PRICING,
        judgePrompts: TEST_JUDGE_PROMPTS,
        corpus: {
          name: "longmemeval_s_cleaned",
          path: "fixture.json",
          repository: "fixture",
          revision: "fixture",
          sha256: "f".repeat(64),
          examples: [
            {
              question_id: "lme_s_0001",
              question_type: "single-session-user",
              question: "What color?",
              answer: "blue",
              haystack_sessions: [],
            },
          ],
        },
        outPath: join(outDir, "artifact.json"),
        now: () => new Date("2026-05-21T00:00:00.000Z"),
      })
      expect(createSubProjectCalled).toBe(false)
      expect(artifact.summary.aborted).toBe(true)
      expect(artifact.summary.abortReason).toContain("probe says no live tools")
      expect(artifact.results).toEqual([])
      expect(existsSync(outPath)).toBe(true)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })
})

describe("parseAgentTurnCompleted", () => {
  it("parses turn.completed usage out of JSONL stdout", () => {
    const stdout = [
      JSON.stringify({ type: "other.event", data: "x" }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 100,
          cached_input_tokens: 25,
          output_tokens: 50,
          reasoning_output_tokens: 10,
        },
      }),
    ].join("\n")
    const result = parseAgentTurnCompleted(stdout)
    expect(result.usage).toEqual({
      input_tokens: 100,
      cached_input_tokens: 25,
      output_tokens: 50,
      reasoning_output_tokens: 10,
    })
  })

  it("counts tool_call events", () => {
    const stdout = [
      JSON.stringify({ type: "tool_call", name: "a" }),
      JSON.stringify({ type: "tool_call", name: "b" }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 1,
          cached_input_tokens: 0,
          output_tokens: 1,
          reasoning_output_tokens: 0,
        },
      }),
    ].join("\n")
    const result = parseAgentTurnCompleted(stdout)
    expect(result.toolCalls).toBe(2)
  })

  it("returns null usage when turn.completed is missing", () => {
    const result = parseAgentTurnCompleted("not-json-output\n")
    expect(result.usage).toBeNull()
  })
})

describe("extractUlidFromSubProjectName + filterOrphanSubProjects", () => {
  it("extracts the trailing ULID from sub-project names", () => {
    const ulid = generateUlid(1000)
    const name = `lme-fixture-${ulid}`
    expect(extractUlidFromSubProjectName(name)).toBe(ulid)
  })

  it("returns null for non-matching names", () => {
    expect(extractUlidFromSubProjectName("random-project")).toBeNull()
  })

  it("filters by ULID age against a cutoff", () => {
    const oldUlid = generateUlid(1_000_000)
    const freshUlid = generateUlid(2_000_000)
    const result = filterOrphanSubProjects(
      [
        { name: `lme-old-${oldUlid}`, id: "id-old" },
        { name: `lme-fresh-${freshUlid}`, id: "id-fresh" },
        { name: "not-an-lme-project", id: "id-other" },
      ],
      1_500_000
    )
    expect(result).toHaveLength(1)
    expect(result[0]?.id).toBe("id-old")
  })
})

describe("buildBenchWorkspace on-disk config", () => {
  let workspace: string
  let saved: Record<string, string | undefined>

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), "lore-bench-workspace-test-"))
    saved = {
      NOTION_API_TOKEN: process.env["NOTION_API_TOKEN"],
      LORE_CONFIG_ROOT: process.env["LORE_CONFIG_ROOT"],
      NOTION_ENV: process.env["NOTION_ENV"],
    }
    process.env["NOTION_API_TOKEN"] = "ntn_TEST_FIXTURE_TOKEN_FOR_BUILD_BENCH_WORKSPACE"
    process.env["LORE_CONFIG_ROOT"] = "/tmp/lore-bench-config-fixture"
    process.env["NOTION_ENV"] = "dev"
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it("writes only non-secret model config by default", async () => {
    await buildBenchWorkspace({
      workspace,
      budgetStateFile: "/tmp/state-file.json",
      perExampleWrites: 500,
    })
    const configPath = join(workspace, ".codex", "config.toml")
    const body = readFileSync(configPath, "utf-8")

    expect(body).toContain('model = "gpt-4o-mini-2024-07-18"')
    expect(body).not.toContain("[mcp_servers.lore]")
    expect(body).not.toContain("NOTION_API_TOKEN")
    expect(body).not.toContain("LORE_CONFIG_ROOT")
    expect(body).not.toContain("ntn_TEST_FIXTURE_TOKEN_FOR_BUILD_BENCH_WORKSPACE")
    expect(existsSync(join(workspace, ".lore-tools"))).toBe(false)
    const mode = statSync(configPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("writes the full bench config when MCP config is explicitly enabled", async () => {
    await buildBenchWorkspace({
      workspace,
      budgetStateFile: "/tmp/state-file.json",
      perExampleWrites: 500,
      enableMcpConfig: true,
    })
    const configPath = join(workspace, ".codex", "config.toml")
    const body = readFileSync(configPath, "utf-8")
    // Model + mcp_servers.lore block + env table all present.
    expect(body).toContain('model = "gpt-4o-mini-2024-07-18"')
    expect(body).toContain("[mcp_servers.lore]")
    expect(body).toContain('transport = "stdio"')
    expect(body).toContain('command = "lore"')
    expect(body).toContain(
      'args = ["mcp", "--write-budget", "500", "--budget-state-file", "/tmp/state-file.json"]'
    )
    expect(body).toContain("[mcp_servers.lore.env]")
    expect(body).toContain(
      'NOTION_API_TOKEN = "ntn_TEST_FIXTURE_TOKEN_FOR_BUILD_BENCH_WORKSPACE"'
    )
    expect(body).toContain('LORE_CONFIG_ROOT = "/tmp/lore-bench-config-fixture"')
    expect(body).toContain('NOTION_ENV = "dev"')
    expect(existsSync(join(workspace, ".lore-tools"))).toBe(false)
    // File mode is 0600 — owner read/write only. Mode bits below
    // 0o777 mask off the file-type bits, so we compare the perms
    // explicitly.
    const mode = statSync(configPath).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it("writes tool shims only when tool-driven retrieval is enabled", async () => {
    await buildBenchWorkspace({
      workspace,
      budgetStateFile: "/tmp/state-file.json",
      perExampleWrites: 500,
      enableToolShims: true,
    })
    const body = readFileSync(join(workspace, ".codex", "config.toml"), "utf-8")
    expect(body).toContain('model = "gpt-4o-mini-2024-07-18"')
    expect(body).not.toContain("[mcp_servers.lore]")
    expect(body).not.toContain("NOTION_API_TOKEN")
    expect(body).not.toContain("LORE_CONFIG_ROOT")
    expect(body).not.toContain("ntn_TEST_FIXTURE_TOKEN_FOR_BUILD_BENCH_WORKSPACE")
    const queryShim = join(workspace, ".lore-tools", "lore-query")
    const memoryShim = join(workspace, ".lore-tools", "lore-memory")
    expect(readFileSync(queryShim, "utf-8")).toContain("eval bench tool lore-query")
    expect(readFileSync(memoryShim, "utf-8")).toContain("eval bench tool lore-memory")
    expect(statSync(queryShim).mode & 0o777).toBe(0o700)
    expect(statSync(memoryShim).mode & 0o777).toBe(0o700)
  })

  it("throws when NOTION_API_TOKEN is missing", async () => {
    delete process.env["NOTION_API_TOKEN"]
    await expect(
      buildBenchWorkspace({
        workspace,
        budgetStateFile: "/tmp/state.json",
        perExampleWrites: 500,
      })
    ).rejects.toThrow(/NOTION_API_TOKEN/)
  })

  it("throws when LORE_CONFIG_ROOT is missing", async () => {
    delete process.env["LORE_CONFIG_ROOT"]
    await expect(
      buildBenchWorkspace({
        workspace,
        budgetStateFile: "/tmp/state.json",
        perExampleWrites: 500,
      })
    ).rejects.toThrow(/LORE_CONFIG_ROOT/)
  })

  it("rejects non-positive perExampleWrites", async () => {
    await expect(
      buildBenchWorkspace({
        workspace,
        budgetStateFile: "/tmp/state.json",
        perExampleWrites: 0,
      })
    ).rejects.toThrow(/perExampleWrites/)
    await expect(
      buildBenchWorkspace({
        workspace,
        budgetStateFile: "/tmp/state.json",
        perExampleWrites: -1,
      })
    ).rejects.toThrow(/perExampleWrites/)
  })

  it("TOML-escapes backslashes and double-quotes in token / config-root / state-file", async () => {
    process.env["NOTION_API_TOKEN"] = 'ntn_has"quote\\and-backslash'
    process.env["LORE_CONFIG_ROOT"] = '/path/with"quote'
    await buildBenchWorkspace({
      workspace,
      budgetStateFile: '/path/with"state',
      perExampleWrites: 500,
      enableMcpConfig: true,
    })
    const body = readFileSync(join(workspace, ".codex", "config.toml"), "utf-8")
    // Quote characters in the token must be backslash-escaped in TOML
    // double-quoted string. Backslashes get doubled. Without proper
    // escaping the TOML parser would either reject the file (best case)
    // or mis-parse the token (worst case → silent auth failure).
    expect(body).toContain('NOTION_API_TOKEN = "ntn_has\\"quote\\\\and-backslash"')
    expect(body).toContain('LORE_CONFIG_ROOT = "/path/with\\"quote"')
    expect(body).toContain('"/path/with\\"state"')
  })
})

describe("runBenchExample retrieval tracing", () => {
  it("ignores agent-forged workspace trace entries", async () => {
    const savedToken = process.env["NOTION_API_TOKEN"]
    const savedConfigRoot = process.env["LORE_CONFIG_ROOT"]
    process.env["NOTION_API_TOKEN"] = "ntn_bench"
    process.env["LORE_CONFIG_ROOT"] = "/tmp/lore-bench-config"
    const sandbox: BenchSandbox = {
      authSource: "env-notion-api-token",
      activeProfileSelector: "default@1.0.0",
      async createSubProject() {
        return "project-1"
      },
      async createMemoryInProject() {
        return { id: "mem-1", mutationCount: 2 }
      },
      async createSimulatedAutosaveMemoryInProject() {
        throw new Error("not expected")
      },
      async getWakeUpForQuery() {
        throw new Error("not expected")
      },
      async archiveProject() {},
      async countMemoriesForProject() {
        return 1
      },
      async countFactsForProject() {
        return 0
      },
    }
    const agentAdapter: AgentAdapter = {
      id: "mock",
      async run(input) {
        writeFileSync(join(input.workspace, "answer.txt"), "blue")
        const brokerSocket = input.extraEnv?.[BENCH_TOOL_SOCKET_ENV]
        expect(brokerSocket).toBe(join(input.workspace, "lore-tool-broker.sock"))
        expect(JSON.stringify(input.extraEnv)).not.toContain("project-1")
        expect(JSON.stringify(input.extraEnv)).not.toContain("ntn_bench")
        writeFileSync(
          join(input.workspace, "lore-tool-trace.jsonl"),
          [
            {
              tool: "lore-query",
              action: "search",
              surface: "codex-shell-shim",
              timing: "during-agent-run",
              status: "success",
              startedAt: "2026-05-21T00:00:00.000Z",
              finishedAt: "2026-05-21T00:00:01.000Z",
              surfacedMemoryIds: ["mem-1"],
              expandedMemoryIds: [],
              error: null,
            },
            {
              tool: "lore-query ntn_TRACE_TOKEN_SHOULD_NOT_LEAK_1234567890",
              action: "search ntn_TRACE_TOKEN_SHOULD_NOT_LEAK_1234567890",
              surface: "codex-shell-shim",
              timing: "during-agent-run",
              status: "error",
              startedAt: "2026-05-21T00:00:02.000Z",
              finishedAt: "2026-05-21T00:00:03.000Z",
              surfacedMemoryIds: ["ntn_TRACE_TOKEN_SHOULD_NOT_LEAK_1234567890"],
              expandedMemoryIds: ["ntn_TRACE_TOKEN_SHOULD_NOT_LEAK_1234567890"],
              error: "failed with ntn_TRACE_TOKEN_SHOULD_NOT_LEAK_1234567890",
            },
          ]
            .map((line) => JSON.stringify(line))
            .join("\n") + "\n"
        )
        return {
          exitCode: 0,
          stdout: [
            JSON.stringify({ type: "tool_call", name: "exec_command" }),
            JSON.stringify({
              type: "turn.completed",
              usage: {
                input_tokens: 10,
                cached_input_tokens: 0,
                output_tokens: 3,
                reasoning_output_tokens: 0,
              },
            }),
          ].join("\n"),
          stderr: "",
          timedOut: false,
        }
      },
    }

    try {
      const result = await runBenchExample({
        example: {
          question_id: "lme_s_0001",
          question_type: "single-session-user",
          question: "What color?",
          answer: "blue",
          haystack_sessions: [[{ role: "user", content: "I like blue." }]],
        },
        runId: "01HXYZ4QK7Z2P8E3K0R5T9N1WM",
        pricing: TEST_PRICING,
        judgePrompts: TEST_JUDGE_PROMPTS,
        judgeClient: {
          async complete() {
            return {
              content: JSON.stringify({ verdict: "correct", rationale: "ok" }),
              usage: {
                promptTokens: 10,
                cachedPromptTokens: 0,
                completionTokens: 3,
              },
            }
          },
        },
        agentAdapter,
        sandbox,
        systemPrompt: "Use Lore.",
        perExampleWrites: 500,
        ingestionStrategy: "raw-transcript",
        agentRetrieval: "tool-driven",
        agentTimeoutMs: 30_000,
        keepWorkspaces: false,
        log: { info() {}, warn() {} },
      })

      expect(result.success).toBe(true)
      expect(result.agent.retrieval.strategy).toBe("tool-driven")
      expect(result.agent.retrieval.surface).toBe("codex-shell-shim")
      expect(result.agent.retrieval.firstRetrievalTiming).toBe(null)
      expect(result.agent.retrieval.calls).toEqual([])
      expect(JSON.stringify(result.agent.retrieval.calls)).not.toContain(
        "ntn_TRACE_TOKEN"
      )
    } finally {
      if (savedToken === undefined) delete process.env["NOTION_API_TOKEN"]
      else process.env["NOTION_API_TOKEN"] = savedToken
      if (savedConfigRoot === undefined) delete process.env["LORE_CONFIG_ROOT"]
      else process.env["LORE_CONFIG_ROOT"] = savedConfigRoot
    }
  })

  it("redacts bearer-shaped wake-up prefetch errors in retrieval traces", async () => {
    const savedToken = process.env["NOTION_API_TOKEN"]
    const savedConfigRoot = process.env["LORE_CONFIG_ROOT"]
    process.env["NOTION_API_TOKEN"] = "ntn_bench"
    process.env["LORE_CONFIG_ROOT"] = "/tmp/lore-bench-config"
    const token = "ntn_WAKEUP_TRACE_TOKEN_SHOULD_NOT_LEAK_1234567890"
    const sandbox: BenchSandbox = {
      authSource: "env-notion-api-token",
      activeProfileSelector: "default@1.0.0",
      async createSubProject() {
        return "project-1"
      },
      async createMemoryInProject() {
        return { id: "mem-1", mutationCount: 2 }
      },
      async createSimulatedAutosaveMemoryInProject() {
        throw new Error("not expected")
      },
      async getWakeUpForQuery() {
        throw new Error(`wake-up failed with ${token}`)
      },
      async archiveProject() {},
      async countMemoriesForProject() {
        return 1
      },
      async countFactsForProject() {
        return 0
      },
    }
    const agentAdapter: AgentAdapter = {
      id: "mock",
      async run(input) {
        writeFileSync(join(input.workspace, "answer.txt"), "blue")
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            type: "turn.completed",
            usage: {
              input_tokens: 10,
              cached_input_tokens: 0,
              output_tokens: 3,
              reasoning_output_tokens: 0,
            },
          }),
          stderr: "",
          timedOut: false,
        }
      },
    }

    try {
      const result = await runBenchExample({
        example: {
          question_id: "lme_s_0001",
          question_type: "single-session-user",
          question: "What color?",
          answer: "blue",
          haystack_sessions: [[{ role: "user", content: "I like blue." }]],
        },
        runId: "01HXYZ4QK7Z2P8E3K0R5T9N1WM",
        pricing: TEST_PRICING,
        judgePrompts: TEST_JUDGE_PROMPTS,
        judgeClient: {
          async complete() {
            return {
              content: JSON.stringify({ verdict: "correct", rationale: "ok" }),
              usage: {
                promptTokens: 10,
                cachedPromptTokens: 0,
                completionTokens: 3,
              },
            }
          },
        },
        agentAdapter,
        sandbox,
        systemPrompt: "Use Lore.",
        perExampleWrites: 500,
        ingestionStrategy: "raw-transcript",
        agentRetrieval: "wake-up-prefetch",
        agentTimeoutMs: 30_000,
        keepWorkspaces: false,
        log: { info() {}, warn() {} },
      })

      const error = result.agent.retrieval.calls[0]?.error
      expect(error).toContain("<redacted-token>")
      expect(JSON.stringify(result.agent.retrieval.calls)).not.toContain(token)
    } finally {
      if (savedToken === undefined) delete process.env["NOTION_API_TOKEN"]
      else process.env["NOTION_API_TOKEN"] = savedToken
      if (savedConfigRoot === undefined) delete process.env["LORE_CONFIG_ROOT"]
      else process.env["LORE_CONFIG_ROOT"] = savedConfigRoot
    }
  })
})

describe("services.ts write-budget shutdown listener idempotence", () => {
  it("installWriteBudgetShutdownHooks is module-scope idempotent across re-init", async () => {
    // Invariant: repeated calls to `installWriteBudgetShutdownHooks`
    // (via `initServicesFromConfig` under bench env) must register
    // exactly ONE set of process listeners, not one set per call.
    // Without module-scope idempotence a long-lived process
    // re-initializing services on auth rotation / test re-entry
    // would leak three closures per call and trip
    // MaxListenersExceededWarning at the 11th re-init.
    const { installWriteBudgetShutdownHooks } = await import("../services.js")
    const sigtermBefore = process.listenerCount("SIGTERM")
    const sigintBefore = process.listenerCount("SIGINT")
    const exitBefore = process.listenerCount("exit")
    installWriteBudgetShutdownHooks()
    installWriteBudgetShutdownHooks()
    installWriteBudgetShutdownHooks()
    installWriteBudgetShutdownHooks()
    // Idempotent — three repeat installs must add at most one
    // SIGTERM listener, one SIGINT listener, one exit listener total.
    expect(process.listenerCount("SIGTERM") - sigtermBefore).toBeLessThanOrEqual(1)
    expect(process.listenerCount("SIGINT") - sigintBefore).toBeLessThanOrEqual(1)
    expect(process.listenerCount("exit") - exitBefore).toBeLessThanOrEqual(1)
  })
})

describe("benchSuiteSchema agent.retrieval enum", () => {
  it("defaults to tool-driven when omitted (preserves V1 contract)", async () => {
    const { benchSuiteSchema } = await import("./schema.js")
    const parsed = benchSuiteSchema.parse({
      runner: "bench",
      benchmark: "longmemeval",
      suite: "longmemeval-test",
      corpus: {
        name: "longmemeval_s_cleaned",
        path: "evals/bench-corpora/longmemeval/longmemeval_s_cleaned.json",
      },
      agent: {
        model: "gpt-4o-mini-2024-07-18",
        adapter: "codex",
        systemPrompt: "evals/prompts/longmemeval-agent-system.txt",
      },
      judge: {
        model: "gpt-4o-2024-08-06",
        recallPrompt: "evals/prompts/longmemeval-judge.txt",
        abstentionPrompt: "evals/prompts/longmemeval-judge-abstention.txt",
      },
    })
    expect(parsed.agent.retrieval).toBe("tool-driven")
  })

  it("accepts wake-up-prefetch", async () => {
    const { benchSuiteSchema } = await import("./schema.js")
    const parsed = benchSuiteSchema.parse({
      runner: "bench",
      benchmark: "longmemeval",
      suite: "longmemeval-test",
      corpus: {
        name: "longmemeval_s_cleaned",
        path: "evals/bench-corpora/longmemeval/longmemeval_s_cleaned.json",
      },
      agent: {
        model: "gpt-4o-mini-2024-07-18",
        adapter: "codex",
        systemPrompt: "evals/prompts/longmemeval-agent-system-wake-up.txt",
        retrieval: "wake-up-prefetch",
      },
      judge: {
        model: "gpt-4o-2024-08-06",
        recallPrompt: "evals/prompts/longmemeval-judge.txt",
        abstentionPrompt: "evals/prompts/longmemeval-judge-abstention.txt",
      },
    })
    expect(parsed.agent.retrieval).toBe("wake-up-prefetch")
  })

  it("rejects unknown retrieval values", async () => {
    const { benchSuiteSchema } = await import("./schema.js")
    expect(() =>
      benchSuiteSchema.parse({
        runner: "bench",
        benchmark: "longmemeval",
        suite: "longmemeval-test",
        corpus: {
          name: "longmemeval_s_cleaned",
          path: "evals/bench-corpora/longmemeval/longmemeval_s_cleaned.json",
        },
        agent: {
          model: "gpt-4o-mini-2024-07-18",
          adapter: "codex",
          systemPrompt: "evals/prompts/longmemeval-agent-system.txt",
          retrieval: "tool-driven-with-fallback",
        },
        judge: {
          model: "gpt-4o-2024-08-06",
          recallPrompt: "evals/prompts/longmemeval-judge.txt",
          abstentionPrompt: "evals/prompts/longmemeval-judge-abstention.txt",
        },
      })
    ).toThrow(/retrieval/i)
  })
})
