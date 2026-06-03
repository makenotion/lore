import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { LoreServices } from "../services.js"
import {
  runSkillAgentSuite,
  skillAgentSuiteSchema,
  type SkillAgentAnswer,
} from "./skill-agent.js"
import {
  BENCH_TOOL_TRACE_FILE,
  type AgentAdapter,
  type AgentRunInput,
  type AgentRunResult,
} from "./task-runner.js"

describe("skill-agent runner", () => {
  it("scores read-only Lore tool use, selection, and application", async () => {
    const dir = await writeSkillAgentFixture()
    const adapter = mockSkillAgentAdapter({
      answer: "Use alpha routing for tenant metadata decisions.",
      usedMemoryIds: ["memory-alpha"],
      usedSkillIds: ["skill-alpha"],
      reason: "Expanded the matching Lore procedure.",
      toolTrace: [
        {
          tool: "lore-query",
          action: "search",
          status: "success",
          surfacedMemoryIds: ["memory-alpha"],
          expandedMemoryIds: [],
          error: null,
        },
        {
          tool: "lore-memory",
          action: "expand",
          status: "success",
          surfacedMemoryIds: ["memory-alpha"],
          expandedMemoryIds: ["memory-alpha"],
          error: null,
        },
      ],
    })

    const { artifact } = await runSkillAgentSuite(join(dir, "skill-agent.yaml"), {
      agentAdapter: adapter,
      servicesFactory: async () => testServices(),
      now: new Date("2026-06-04T12:00:00.000Z"),
    })

    expect(artifact.runner.readOnly).toBe(true)
    expect(artifact.summary.failedRequiredResults).toBe(0)
    expect(artifact.summary.conditions["tool-driven-lore"]).toMatchObject({
      results: 1,
      passed: 1,
      toolUseRate: 1,
      targetSurfacedRate: 1,
      targetExpandedRate: 1,
      targetSelectedRate: 1,
      answerAppliedRate: 1,
      writeAttemptsBlocked: 0,
    })
    expect(artifact.results[0]).toMatchObject({
      condition: "tool-driven-lore",
      success: true,
      expectedSkillIds: ["skill-alpha"],
      expectedMemoryIds: ["memory-alpha"],
      surfacedMemoryIds: ["memory-alpha"],
      expandedMemoryIds: ["memory-alpha"],
      usedSkillIds: ["skill-alpha"],
      failureReasons: [],
    })
  })

  it("normalizes SkillRet IDs returned in the memory citation field", async () => {
    const dir = await writeSkillAgentFixture()
    const adapter = mockSkillAgentAdapter({
      answer: "Use alpha routing for tenant metadata decisions.",
      usedMemoryIds: ["skill-alpha"],
      usedSkillIds: [],
      reason: "Returned the SkillRet ID in the memory field.",
      toolTrace: [
        {
          tool: "lore-query",
          action: "search",
          status: "success",
          surfacedMemoryIds: ["memory-alpha"],
          expandedMemoryIds: [],
          error: null,
        },
        {
          tool: "lore-memory",
          action: "expand",
          status: "success",
          surfacedMemoryIds: ["memory-alpha"],
          expandedMemoryIds: ["memory-alpha"],
          error: null,
        },
      ],
    })

    const { artifact } = await runSkillAgentSuite(join(dir, "skill-agent.yaml"), {
      agentAdapter: adapter,
      servicesFactory: async () => testServices(),
    })

    expect(artifact.summary.failedRequiredResults).toBe(0)
    expect(artifact.results[0]).toMatchObject({
      success: true,
      usedMemoryIds: [],
      usedSkillIds: ["skill-alpha"],
      citationNormalization: {
        rawUsedMemoryIds: ["skill-alpha"],
        rawUsedSkillIds: [],
        skillIdsFromMemoryField: ["skill-alpha"],
        memoryIdsFromSkillField: [],
        normalized: true,
      },
      failureReasons: [],
    })
  })

  it("does not score model-supplied tool trace as Lore tool evidence", async () => {
    const dir = await writeSkillAgentFixture()
    const adapter = mockSkillAgentAdapter(
      {
        answer: "Use alpha routing for tenant metadata decisions.",
        usedMemoryIds: ["memory-alpha"],
        usedSkillIds: ["skill-alpha"],
        reason: "Claimed to have expanded the matching Lore procedure.",
        toolTrace: [
          {
            tool: "lore-query",
            action: "search",
            status: "success",
            surfacedMemoryIds: ["memory-alpha"],
            expandedMemoryIds: [],
            error: null,
          },
          {
            tool: "lore-memory",
            action: "expand",
            status: "success",
            surfacedMemoryIds: ["memory-alpha"],
            expandedMemoryIds: ["memory-alpha"],
            error: null,
          },
        ],
      },
      []
    )

    const { artifact } = await runSkillAgentSuite(join(dir, "skill-agent.yaml"), {
      agentAdapter: adapter,
      servicesFactory: async () => testServices(),
    })

    expect(artifact.summary.failedRequiredResults).toBe(1)
    expect(artifact.results[0]).toMatchObject({
      success: false,
      toolUse: false,
      targetSurfaced: false,
      targetExpanded: false,
      surfacedMemoryIds: [],
      expandedMemoryIds: [],
      toolTrace: [],
    })
    expect(artifact.results[0]?.failureReasons).toEqual(
      expect.arrayContaining([
        "lore-tool-not-used",
        "target-not-surfaced",
        "target-not-expanded",
      ])
    )
  })

  it("fails a read-only trial when the agent attempts to write through Lore", async () => {
    const dir = await writeSkillAgentFixture()
    const adapter = mockSkillAgentAdapter({
      answer: "Use alpha routing for tenant metadata decisions.",
      usedMemoryIds: ["memory-alpha"],
      usedSkillIds: ["skill-alpha"],
      reason: "Tried to save a note after reading the procedure.",
      toolTrace: [
        {
          tool: "lore-query",
          action: "search",
          status: "success",
          surfacedMemoryIds: ["memory-alpha"],
          expandedMemoryIds: [],
          error: null,
        },
        {
          tool: "lore-memory",
          action: "expand",
          status: "success",
          surfacedMemoryIds: ["memory-alpha"],
          expandedMemoryIds: ["memory-alpha"],
          error: null,
        },
        {
          tool: "lore-memory",
          action: "save",
          status: "error",
          surfacedMemoryIds: [],
          expandedMemoryIds: [],
          error: "unsupported lore-memory action",
        },
      ],
    })

    const { artifact } = await runSkillAgentSuite(join(dir, "skill-agent.yaml"), {
      agentAdapter: adapter,
      servicesFactory: async () => testServices(),
    })

    expect(artifact.summary.failedRequiredResults).toBe(1)
    expect(artifact.summary.writeAttemptsBlocked).toBe(1)
    expect(artifact.results[0]?.failureReasons).toContain("write-attempt-blocked")
  })

  it("parses structured answers from Codex JSONL agent messages", async () => {
    const dir = await writeSkillAgentFixture()
    const answer: SkillAgentAnswer = {
      answer: "Use alpha routing for tenant metadata decisions.",
      usedMemoryIds: ["memory-alpha"],
      usedSkillIds: ["skill-alpha"],
      reason: "Expanded the matching Lore procedure.",
      toolTrace: [
        {
          tool: "lore-query",
          action: "search",
          status: "success",
          surfacedMemoryIds: ["memory-alpha"],
          expandedMemoryIds: [],
          error: null,
        },
        {
          tool: "lore-memory",
          action: "expand",
          status: "success",
          surfacedMemoryIds: ["memory-alpha"],
          expandedMemoryIds: ["memory-alpha"],
          error: null,
        },
      ],
    }
    const adapter = mockSkillAgentStdoutAdapter(
      [
        JSON.stringify({ type: "thread.started", thread_id: "thread-fixture" }),
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: JSON.stringify(answer),
          },
        }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n"),
      answer.toolTrace
    )

    const { artifact } = await runSkillAgentSuite(join(dir, "skill-agent.yaml"), {
      agentAdapter: adapter,
      servicesFactory: async () => testServices(),
    })

    expect(artifact.summary.failedRequiredResults).toBe(0)
    expect(artifact.results[0]).toMatchObject({
      success: true,
      usedMemoryIds: ["memory-alpha"],
      usedSkillIds: ["skill-alpha"],
      failureReasons: [],
    })
  })

  it("rejects required conditions that are not listed", () => {
    const parsed = skillAgentSuiteSchema.safeParse({
      version: 1,
      runner: "skill-agent",
      name: "bad-skill-agent",
      skillRetrievalSuite: "skillret.yaml",
      conditions: ["no-lore"],
      requiredConditions: ["tool-driven-lore"],
    })

    expect(parsed.success).toBe(false)
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toContain(
        'required condition "tool-driven-lore" is not present in conditions'
      )
    }
  })
})

async function writeSkillAgentFixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lore-skill-agent-"))
  await writeFile(
    join(dir, "skills.jsonl"),
    `${JSON.stringify({
      id: "skill-alpha",
      name: "Alpha Skill",
      description: "Use alpha routing for tenant metadata decisions.",
      skill_md: "Prefer alpha routing when tenant metadata is authoritative.",
    })}\n`,
    "utf-8"
  )
  await writeFile(
    join(dir, "queries.jsonl"),
    `${JSON.stringify({
      id: "q-alpha",
      query: "tenant metadata routing",
      skill_ids: ["skill-alpha"],
    })}\n`,
    "utf-8"
  )
  await writeFile(
    join(dir, "qrels.jsonl"),
    `${JSON.stringify({
      query_id: "q-alpha",
      skill_id: "skill-alpha",
      relevance: 1,
    })}\n`,
    "utf-8"
  )
  await mkdir(join(dir, "manifests"), { recursive: true })
  await writeFile(
    join(dir, "manifests", "import.json"),
    `${JSON.stringify(
      {
        version: 1,
        corpusKind: "skillret",
        corpusRevision: "fixture",
        split: "test",
        documentFields: ["name", "description", "skill_md"],
        transformVersion: 4,
        projectName: "SkillRet Eval",
        projectId: "project-1",
        topicName: "SkillRet Test Split",
        topicId: "topic-1",
        importedAt: "2026-06-04T12:00:00.000Z",
        skills: {
          "skill-alpha": {
            skillId: "skill-alpha",
            memoryId: "memory-alpha",
            name: "Alpha Skill",
            contentSha256: "a".repeat(64),
            sourceSha256: "b".repeat(64),
            importedAt: "2026-06-04T12:00:00.000Z",
          },
        },
      },
      null,
      2
    )}\n`,
    "utf-8"
  )
  await writeFile(
    join(dir, "skillret.yaml"),
    `version: 1
runner: skill-retrieval
name: skillret-agent-source
corpus:
  kind: skillret
  root: .
  skillsPath: skills.jsonl
  queriesPath: queries.jsonl
  qrelsPath: qrels.jsonl
notion:
  projectName: SkillRet Eval
  topicName: SkillRet Test Split
  importManifestPath: manifests/import.json
  expectedVaultPageId: 374b35e6-e67f-8108-beb4-dec11f2f5d28
`,
    "utf-8"
  )
  await writeFile(
    join(dir, "skill-agent.yaml"),
    `version: 1
runner: skill-agent
name: skillret-agent-fixture
skillRetrievalSuite: skillret.yaml
queries:
  ids:
    - q-alpha
conditions:
  - tool-driven-lore
requiredConditions:
  - tool-driven-lore
agent:
  kind: codex
  timeoutMs: 300000
scoring:
  k: [1, 5, 10]
  requireLoreUse: true
  requireExpandedEvidence: true
`,
    "utf-8"
  )
  return dir
}

function mockSkillAgentAdapter(
  answer: SkillAgentAnswer,
  brokerTrace: readonly unknown[] = answer.toolTrace
): AgentAdapter {
  return mockSkillAgentStdoutAdapter(`${JSON.stringify(answer)}\n`, brokerTrace)
}

function mockSkillAgentStdoutAdapter(
  stdout: string,
  brokerTrace: readonly unknown[] = []
): AgentAdapter {
  return {
    id: "codex",
    async run(input: AgentRunInput): Promise<AgentRunResult> {
      const agents = await readFile(join(input.workspace, "AGENTS.md"), "utf-8")
      expect(agents).toContain("read-only")
      expect(agents).toContain("exact SkillRet ID UUIDs")
      expect(input.prompt).toContain("Return only JSON")
      expect(input.prompt).toContain("ids=latest")
      expect(input.prompt).toContain("SkillRet ID")
      expect(input.prompt).toContain(
        "capability, framework/tool, and action-intent facets"
      )
      expect(input.prompt).toContain(
        "Compare Skill Name, Short Summary, and SkillRet Tags"
      )
      await writeBrokerToolTrace(input.workspace, brokerTrace)
      return {
        exitCode: 0,
        stdout,
        stderr: "",
        timedOut: false,
      }
    },
  }
}

async function writeBrokerToolTrace(
  workspace: string,
  brokerTrace: readonly unknown[]
): Promise<void> {
  if (brokerTrace.length === 0) return
  await writeFile(
    join(workspace, BENCH_TOOL_TRACE_FILE),
    `${brokerTrace.map((call) => JSON.stringify(call)).join("\n")}\n`,
    "utf-8"
  )
}

function testServices(): LoreServices {
  return {
    config: {
      vault: {
        pageId: "374b35e6-e67f-8108-beb4-dec11f2f5d28",
      },
    },
  } as unknown as LoreServices
}
