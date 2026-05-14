import { existsSync } from "node:fs"
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  readdir,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  BENCH_CHILD_CLEARED_ENV_KEYS,
  buildBenchCodexChildEnv,
  buildBenchSpawnArgs,
  buildCodexChildEnv,
  CODEX_FORWARDED_ENV_KEYS,
  createIsolatedCodexHome,
  isLongitudinalTaskArtifact,
  LongitudinalAdapterRefusedError,
  selectExpectedContextIds,
  type LongitudinalAgentConfigServices,
  type LongitudinalLoreAdapter,
  runTaskEvalSuite,
  taskEvalSuiteSchema,
  withTemporaryLongitudinalAgentConfig,
  type AgentAdapter,
  type AgentRunInput,
  type AgentRunResult,
} from "./task-runner.js"

describe("task-runner", () => {
  it("copies the workspace, runs the agent, and reports verifier success", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: starter
tasks:
  - id: agent-creates-readme
    prompt: Add a README mentioning the package name "x".
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: README.md
      - type: file-contents-match
        path: README.md
        pattern: package name
`,
    })

    const adapter = mockAdapter("codex", async ({ workspace }) => {
      await writeFile(
        join(workspace, "README.md"),
        "This package's purpose is documented here. The package name is x.\n",
        "utf-8"
      )
      return successResult()
    })

    const dir = await mkdtemp(join(tmpdir(), "lore-eval-task-"))
    const outPath = join(dir, "result.json")
    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath,
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.summary).toMatchObject({
      tasks: 1,
      passedTasks: 1,
      failedTasks: 0,
      totalTrials: 1,
      passedTrials: 1,
    })
    const result = artifact.results[0]!
    expect(result.success).toBe(true)
    expect(result.failureReason).toBeNull()
    expect(result.verifiers.every((v) => v.passed)).toBe(true)
    expect(JSON.parse(await readFile(outPath, "utf-8"))).toMatchObject({
      runner: { mode: "task" },
      summary: { passedTasks: 1 },
    })
  })

  it("fails when verifiers don't pass after the agent run", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: starter
tasks:
  - id: agent-leaves-readme-missing
    prompt: Add a README.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: README.md
`,
    })

    const adapter = mockAdapter("codex", async () => successResult())

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.summary.failedTrials).toBe(1)
    const verifier = artifact.results[0]!.verifiers[0]!
    expect(verifier.passed).toBe(false)
    expect(verifier.message).toContain("File missing")
    expect(artifact.results[0]!.failureReason).toBe("verifiers")
  })

  it("flags forbid-mode verifiers when the pattern shows up", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "index.js": "throw new Error('legacy throw pattern')\n" },
      suite: `version: 1
name: starter
tasks:
  - id: agent-introduces-throw
    prompt: Update index.js without throwing.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-contents-match
        path: index.js
        pattern: throw new Error
        mode: forbid
`,
    })

    const adapter = mockAdapter("codex", async () => successResult())

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.summary.failedTrials).toBe(1)
    expect(artifact.results[0]!.verifiers[0]!.message).toContain(
      "Forbidden pattern matched"
    )
    expect(artifact.results[0]!.failureReason).toBe("verifiers")
  })

  it("file-unchanged passes when the workspace file matches the fixture", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "index.js": "export const VERSION = 1\n" },
      suite: `version: 1
name: starter
tasks:
  - id: agent-leaves-index-alone
    prompt: Add documentation.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-unchanged
        path: index.js
`,
    })

    const adapter = mockAdapter("codex", async ({ workspace }) => {
      // Simulate an agent that wrote a README without touching index.js.
      await writeFile(join(workspace, "README.md"), "doc\n", "utf-8")
      return successResult()
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.summary.failedTrials).toBe(0)
    expect(artifact.results[0]!.verifiers[0]!.passed).toBe(true)
  })

  it("file-unchanged fails when the agent modifies a fixture-pinned file", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "index.js": "export const VERSION = 1\n" },
      suite: `version: 1
name: starter
tasks:
  - id: agent-clobbers-index
    prompt: Add documentation.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-unchanged
        path: index.js
`,
    })

    const adapter = mockAdapter("codex", async ({ workspace }) => {
      await writeFile(join(workspace, "index.js"), "export const VERSION = 2\n", "utf-8")
      return successResult()
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.summary.failedTrials).toBe(1)
    expect(artifact.results[0]!.verifiers[0]!.message).toContain(
      "File modified from fixture"
    )
  })

  it("reports failure when the agent exits non-zero", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: starter
tasks:
  - id: agent-exits-nonzero
    prompt: Do something.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: package.json
`,
    })

    const adapter = mockAdapter("codex", async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "boom",
      timedOut: false,
    }))

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.summary.failedTrials).toBe(1)
    if (isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected standard artifact")
    }
    expect(artifact.results[0]!.agentRun.exitCode).toBe(1)
    expect(artifact.results[0]!.success).toBe(false)
    expect(artifact.results[0]!.failureReason).toBe("agent-exit")
  })

  it("flags adapter-refused failureReason when the adapter declines to run", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: starter
tasks:
  - id: agent-refuses
    prompt: Do something.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: package.json
`,
    })

    // Adapter that flags `refused: true` — same shape as
    // CodexAgentAdapter's cost-guardrail return when
    // LORE_EVAL_TASK_REAL is unset. The runner reads the structural
    // field (not a stderr substring) so future adapters get the same
    // discriminator without coupling to Codex-specific messages.
    const adapter = mockAdapter("codex", async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "[some-other-adapter] declined to run",
      timedOut: false,
      refused: true,
    }))

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.results[0]!.failureReason).toBe("adapter-refused")
    expect(artifact.results[0]!.success).toBe(false)
  })

  it("flags timeout failureReason when the agent run times out", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: starter
tasks:
  - id: agent-times-out
    prompt: Do something.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: package.json
`,
    })

    const adapter = mockAdapter("codex", async () => ({
      exitCode: 137,
      stdout: "",
      stderr: "killed",
      timedOut: true,
    }))

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.results[0]!.failureReason).toBe("timeout")
  })

  it("flags spawn-error failureReason when the adapter reports a negative exit code", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: starter
tasks:
  - id: agent-spawn-error
    prompt: Do something.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: package.json
`,
    })

    const adapter = mockAdapter("codex", async () => ({
      exitCode: -1,
      stdout: "",
      stderr: "spawn error: ENOENT",
      timedOut: false,
    }))

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.results[0]!.failureReason).toBe("spawn-error")
  })

  it("rejects verifier paths that escape the workspace", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: starter
tasks:
  - id: escapes-workspace
    prompt: Do something.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: ../../etc/passwd
`,
    })

    const adapter = mockAdapter("codex", async () => successResult())

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.results[0]!.verifiers[0]!.passed).toBe(false)
    expect(artifact.results[0]!.verifiers[0]!.message).toContain(
      "escapes the workspace"
    )
  })

  it("throws when no adapter is registered for the task's agent", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: starter
tasks:
  - id: no-adapter-for-agent
    prompt: Do something.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: package.json
`,
    })

    await expect(
      runTaskEvalSuite(suitePath, {
        outPath: join(
          await mkdtemp(join(tmpdir(), "lore-eval-task-")),
          "out.json"
        ),
        adapters: new Map<string, AgentAdapter>(),
      })
    ).rejects.toThrow("No adapter registered")
  })

  it("cleans up the workspace tmpdir by default", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: starter
tasks:
  - id: cleanup-default
    prompt: Do something.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: package.json
`,
    })

    let observedWorkspace: string | null = null
    const adapter = mockAdapter("codex", async ({ workspace }) => {
      observedWorkspace = workspace
      return successResult()
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(observedWorkspace).not.toBeNull()
    // The tmp workspace must be gone after the run; the artifact also
    // surfaces `workspace: null` to reflect that.
    await expect(stat(observedWorkspace as unknown as string)).rejects.toThrow()
    expect(artifact.results[0]!.workspace).toBeNull()
  })

  it("preserves the workspace tmpdir when keepWorkspaces is set", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: starter
tasks:
  - id: cleanup-skipped
    prompt: Do something.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: package.json
`,
    })

    const adapter = mockAdapter("codex", async () => successResult())

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      keepWorkspaces: true,
    })

    const workspace = artifact.results[0]!.workspace
    expect(workspace).not.toBeNull()
    await expect(stat(workspace as unknown as string)).resolves.toBeDefined()
  })

  it("seeds the memory condition fixture into the workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-task-suite-"))
    const suitesDir = join(dir, "task-suites")
    const memoryDir = join(dir, "memory")
    const workspaceDir = join(dir, "workspaces", "x")
    await mkdir(suitesDir, { recursive: true })
    await mkdir(memoryDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      join(workspaceDir, "package.json"),
      '{"name": "x"}\n',
      "utf-8"
    )
    await writeFile(
      join(memoryDir, "helpful.json"),
      '{"hint": "use Result types"}',
      "utf-8"
    )
    const suitePath = join(suitesDir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
name: matrix-suite
tasks:
  - id: matrix-helpful
    prompt: Do something with the seeded memory.
    agent: codex
    workspace: ../workspaces/x
    memoryConditions:
      helpful: ../memory/helpful.json
    verifiers:
      - type: file-exists
        path: package.json
`,
      "utf-8"
    )

    let observedSeed: string | null = null
    const adapter = mockAdapter("codex", async ({ workspace }) => {
      observedSeed = await readFile(
        join(workspace, ".lore-memories.json"),
        "utf-8"
      )
      return successResult()
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(observedSeed).toBe('{"hint": "use Result types"}')
    expect(artifact.results[0]!.memoryCondition).toBe("helpful")
  })

  it("runs command verifiers inside the copied workspace", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: command-verifier
tasks:
  - id: command-checks-agent-output
    prompt: Write ok.txt.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: command
        command: node
        args:
          - -e
          - require('node:fs').accessSync('ok.txt')
`,
    })

    const adapter = mockAdapter("codex", async ({ workspace }) => {
      await writeFile(join(workspace, "ok.txt"), "ok\n", "utf-8")
      return successResult()
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.summary.failedTrials).toBe(0)
    expect(artifact.results[0]!.verifiers[0]!.message).toContain(
      "Command passed"
    )
  })

  it("runs longitudinal suites across no-memory and lore-full-loop conditions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-longitudinal-suite-"))
    const suitesDir = join(dir, "task-suites")
    const workspaceDir = join(dir, "workspaces", "result-boundary")
    await mkdir(suitesDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(
      join(workspaceDir, "profile-service.js"),
      "export function ok(value) { return { ok: true, value } }\n" +
        "export function err(error) { return { ok: false, error } }\n",
      "utf-8"
    )
    const suitePath = join(suitesDir, "longitudinal.yaml")
    await writeFile(
      suitePath,
      `version: 1
runner: task
longitudinal: true
name: longitudinal-smoke
conditions:
  - no-memory
  - lore-full-loop
scenarios:
  - id: result-boundary
    agent: codex
    workspace: ../workspaces/result-boundary
    phaseA:
      prompt: Add createUserProfile using Result helpers.
    phaseB:
      prompt: Add fetchUserProfile consistently with the previous decision.
    expectedContext:
      description: Service boundaries use Result helpers.
      keywords: ["Result", "ok", "err"]
    verifiers:
      - type: file-contents-match
        path: profile-service.js
        pattern: 'export\\s+function\\s+fetchUserProfile'
      - type: file-contents-match
        path: profile-service.js
        pattern: 'return\\s+(?:ok|err)\\('
`,
      "utf-8"
    )

    const phaseWorkspaces: Array<{ prompt: string; workspace: string }> = []
    const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
      phaseWorkspaces.push({ prompt, workspace })
      const servicePath = join(workspace, "profile-service.js")
      if (prompt.includes("createUserProfile")) {
        await writeFile(
          servicePath,
          (await readFile(servicePath, "utf-8")) +
            "\nexport function createUserProfile(input) {\n" +
            "  if (!input || !input.name) return err('missing name')\n" +
            "  return ok({ id: 'u1', name: input.name })\n" +
            "}\n",
          "utf-8"
        )
      }
      if (prompt.includes("Retrieved Lore context")) {
        await writeFile(
          servicePath,
          (await readFile(servicePath, "utf-8")) +
            "\nexport function fetchUserProfile(userId) {\n" +
            "  if (!userId) return err('missing userId')\n" +
            "  return ok({ id: userId, name: 'Ada' })\n" +
            "}\n",
          "utf-8"
        )
      }
      return successResult()
    })

    let cleanupCalls = 0
    const loreAdapter: LongitudinalLoreAdapter = {
      async createRun({ workspace }) {
        await mkdir(join(workspace, ".codex"), { recursive: true })
        await writeFile(join(workspace, ".mcp.json"), "{}\n", "utf-8")
        await writeFile(join(workspace, ".lore.yaml"), "vault:\n  pageId: test\n", "utf-8")
        await writeFile(
          join(workspace, ".codex", "config.toml"),
          "[mcp_servers.lore]\n",
          "utf-8"
        )
        return {
          projectId: "project-1",
          projectName: "Eval Sandbox/result-boundary",
          async formContext() {
            return {
              projectId: "project-1",
              projectName: "Eval Sandbox/result-boundary",
              mining: null,
              memoriesCreated: 0,
              factsCreated: 0,
              decisionsCreated: 1,
              tasksCreated: 0,
              createdContextIds: ["ctx-result"],
              expectedContextIds: ["ctx-result"],
            }
          },
          async loadContext() {
            return {
              renderedContext:
                "- [decision] ctx-result: Service boundaries return Result values with ok and err helpers.",
              surfacedContextIds: ["ctx-result"],
              harmfulContextIds: [],
              failureMessage: null,
            }
          },
          async cleanup() {
            cleanupCalls += 1
          },
        }
      },
    }

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      longitudinalLoreAdapter: loreAdapter,
    })

    expect(cleanupCalls).toBe(1)
    expect(phaseWorkspaces[0]?.workspace).not.toBe(phaseWorkspaces[1]?.workspace)
    expect(phaseWorkspaces[2]?.workspace).not.toBe(phaseWorkspaces[3]?.workspace)
    expect(artifact.runner).toMatchObject({ mode: "task", kind: "longitudinal" })
    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(artifact.summary.conditions["no-memory"]).toMatchObject({
      trials: 1,
      passed: 0,
      failed: 1,
    })
    expect(artifact.summary.conditions["lore-full-loop"]).toMatchObject({
      trials: 1,
      passed: 1,
      failed: 0,
    })
    expect(artifact.summary.lift).toMatchObject({
      successRateDelta: 1,
      liftedScenarioIds: ["result-boundary"],
      harmedScenarioIds: [],
    })
    const fullLoop = artifact.results.find(
      (result) =>
        result.scenarioId === "result-boundary" &&
        result.condition === "lore-full-loop"
    )
    expect(fullLoop?.phases[0]?.lore.decisionsCreated).toBe(1)
    expect(fullLoop?.phases[1]?.lore.surfacedContextIds).toEqual(["ctx-result"])
    expect(fullLoop?.phases[1]?.patchStats.filesChanged).toBe(1)
  })

  it("keeps primary longitudinal agents Lore-tool-free while mining has MCP config", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "status.js": "export function status() { return 'ok' }\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-tool-free-primary
conditions:
  - lore-full-loop
scenarios:
  - id: tool-free-primary
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the status helper.
    phaseB:
      prompt: Add completeStatus using the remembered convention.
    expectedContext:
      keywords: ["completeStatus"]
    verifiers:
      - type: file-contents-match
        path: status.js
        pattern: 'export\\s+function\\s+completeStatus'
`,
    })

    const agentProbes: Array<{ codexConfig: boolean; mcpJson: boolean }> = []
    const adapter = mockAdapter("codex", async ({ workspace }) => {
      agentProbes.push({
        codexConfig: existsSync(join(workspace, ".codex", "config.toml")),
        mcpJson: existsSync(join(workspace, ".mcp.json")),
      })
      if (agentProbes.length === 2) {
        await writeFile(
          join(workspace, "status.js"),
          "export function status() { return 'ok' }\n" +
            "export function completeStatus() { return 'done' }\n",
          "utf-8"
        )
      }
      return successResult()
    })

    const configRoot = await mkdtemp(join(tmpdir(), "lore-eval-config-"))
    const services = {
      authSource: "env-notion-api-token",
      config: { vault: { pageId: "vault-page" }, hooks: {} },
    } as unknown as LongitudinalAgentConfigServices
    let miningSawConfig = false
    let cleanupCalls = 0
    const loreAdapter: LongitudinalLoreAdapter = {
      async createRun({ workspace }) {
        await mkdir(join(workspace, ".codex"), { recursive: true })
        await writeFile(
          join(workspace, ".codex", "config.toml"),
          "[mcp_servers.lore]\n",
          "utf-8"
        )
        await writeFile(join(workspace, ".mcp.json"), "{}\n", "utf-8")
        return {
          projectId: "project-1",
          projectName: "Eval Sandbox/tool-free-primary",
          async formContext({ workspace: phaseWorkspace }) {
            await withTemporaryLongitudinalAgentConfig(
              { workspace: phaseWorkspace, configRoot, services },
              async () => {
                miningSawConfig =
                  existsSync(join(phaseWorkspace, ".codex", "config.toml")) &&
                  existsSync(join(phaseWorkspace, ".mcp.json"))
                const codexConfig = await readFile(
                  join(phaseWorkspace, ".codex", "config.toml"),
                  "utf-8"
                )
                expect(codexConfig).toContain("mcp_servers.lore")
                expect(codexConfig).toContain(
                  'default_tools_approval_mode = "approve"'
                )
                expect(codexConfig).toContain('"lore-memory"')
                expect(codexConfig).toContain('"lore-decision"')
              }
            )
            return {
              projectId: "project-1",
              projectName: "Eval Sandbox/tool-free-primary",
              mining: null,
              memoriesCreated: 1,
              factsCreated: 0,
              decisionsCreated: 0,
              tasksCreated: 0,
              createdContextIds: ["ctx-complete"],
              expectedContextIds: ["ctx-complete"],
            }
          },
          async loadContext() {
            return {
              renderedContext:
                "- [memory] ctx-complete: Add completeStatus for status completion.",
              surfacedContextIds: ["ctx-complete"],
              harmfulContextIds: [],
              failureMessage: null,
            }
          },
          async cleanup() {
            cleanupCalls += 1
            await rm(configRoot, { recursive: true, force: true })
          },
        }
      },
    }

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      longitudinalLoreAdapter: loreAdapter,
    })

    expect(cleanupCalls).toBe(1)
    expect(miningSawConfig).toBe(true)
    expect(agentProbes).toEqual([
      { codexConfig: false, mcpJson: false },
      { codexConfig: false, mcpJson: false },
    ])
    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(artifact.results[0]).toMatchObject({
      success: true,
      failureReason: null,
    })
  })

  it("records wake-up load failures as lore-full-loop phase failures", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "status.js": "export function status() { return 'ok' }\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-wakeup-failure
conditions:
  - lore-full-loop
scenarios:
  - id: wakeup-fails-without-keywords
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the status helper and remember anything useful.
    phaseB:
      prompt: Continue the status helper using the prior session context.
    expectedContext:
      description: No expected keywords are required for this regression.
    verifiers:
      - type: file-contents-match
        path: status.js
        pattern: status
`,
    })

    let agentRuns = 0
    const adapter = mockAdapter("codex", async () => {
      agentRuns += 1
      return successResult()
    })
    const loreAdapter: LongitudinalLoreAdapter = {
      async createRun() {
        return {
          projectId: "project-1",
          projectName: "Eval Sandbox/wakeup-failure",
          async formContext() {
            return {
              projectId: "project-1",
              projectName: "Eval Sandbox/wakeup-failure",
              mining: null,
              memoriesCreated: 1,
              factsCreated: 0,
              decisionsCreated: 0,
              tasksCreated: 0,
              createdContextIds: ["ctx-any"],
              expectedContextIds: [],
            }
          },
          async loadContext() {
            throw new Error("wake-up prefetch exploded")
          },
          async cleanup() {},
        }
      },
    }

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      longitudinalLoreAdapter: loreAdapter,
    })

    expect(agentRuns).toBe(1)
    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(artifact.summary.conditions["lore-full-loop"]).toMatchObject({
      trials: 1,
      passed: 0,
      failed: 1,
    })
    const result = artifact.results[0]!
    expect(result.success).toBe(false)
    expect(result.failureReason).toBe("wake-up")
    expect(result.agentRun).toBeNull()
    const usePhase = result.phases.find((phase) => phase.phase === "use")
    expect(usePhase).toMatchObject({
      success: false,
      agentRun: null,
      verifierResults: [],
      failureReason: "wake-up",
    })
    expect(usePhase?.failureMessage).toContain("wake-up prefetch exploded")
  })

  it("does not form or load Lore context after Phase A agent refusal", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "status.js": "export function status() { return 'ok' }\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-phase-a-refusal
conditions:
  - lore-full-loop
scenarios:
  - id: phase-a-refusal
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the status helper.
    phaseB:
      prompt: Continue the status helper.
    verifiers:
      - type: file-contents-match
        path: status.js
        pattern: status
`,
    })

    let agentRuns = 0
    const adapter = mockAdapter("codex", async () => {
      agentRuns += 1
      return {
        exitCode: 1,
        stdout: "",
        stderr: "adapter refused",
        timedOut: false,
        refused: true,
      }
    })
    let formContextCalls = 0
    let loadContextCalls = 0
    const loreAdapter: LongitudinalLoreAdapter = {
      async createRun() {
        return {
          projectId: "project-1",
          projectName: "Eval Sandbox/phase-a-refusal",
          async formContext() {
            formContextCalls += 1
            throw new Error("formContext should not run")
          },
          async loadContext() {
            loadContextCalls += 1
            throw new Error("loadContext should not run")
          },
          async cleanup() {},
        }
      },
    }

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      longitudinalLoreAdapter: loreAdapter,
    })

    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(agentRuns).toBe(1)
    expect(formContextCalls).toBe(0)
    expect(loadContextCalls).toBe(0)
    expect(artifact.results[0]!.success).toBe(false)
    expect(artifact.results[0]!.failureReason).toBe("adapter-refused")
    expect(artifact.results[0]!.phases[0]).toMatchObject({
      phase: "formation",
      success: false,
      failureReason: "adapter-refused",
    })
    expect(artifact.results[0]!.phases[1]).toMatchObject({
      phase: "use",
      success: false,
      agentRun: null,
      verifierResults: [],
      failureReason: "adapter-refused",
    })
    expect(artifact.results[0]!.phases[1]?.failureMessage).toContain(
      "Skipped Phase B"
    )
  })

  it("does not run Phase B after Lore formation refusal", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "status.js": "export function status() { return 'ok' }\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-formation-refusal
conditions:
  - lore-full-loop
scenarios:
  - id: formation-refusal
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the status helper.
    phaseB:
      prompt: Continue the status helper.
    verifiers:
      - type: file-contents-match
        path: status.js
        pattern: status
`,
    })

    let agentRuns = 0
    const adapter = mockAdapter("codex", async () => {
      agentRuns += 1
      return successResult()
    })
    let formContextCalls = 0
    let loadContextCalls = 0
    const loreAdapter: LongitudinalLoreAdapter = {
      async createRun() {
        return {
          projectId: "project-1",
          projectName: "Eval Sandbox/formation-refusal",
          async formContext() {
            formContextCalls += 1
            throw new LongitudinalAdapterRefusedError("formation refused")
          },
          async loadContext() {
            loadContextCalls += 1
            throw new Error("loadContext should not run")
          },
          async cleanup() {},
        }
      },
    }

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      longitudinalLoreAdapter: loreAdapter,
    })

    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(agentRuns).toBe(1)
    expect(formContextCalls).toBe(1)
    expect(loadContextCalls).toBe(0)
    expect(artifact.results[0]!.success).toBe(false)
    expect(artifact.results[0]!.failureReason).toBe("adapter-refused")
    expect(artifact.results[0]!.phases[0]).toMatchObject({
      phase: "formation",
      success: false,
      failureReason: "adapter-refused",
    })
    expect(artifact.results[0]!.phases[1]).toMatchObject({
      phase: "use",
      success: false,
      agentRun: null,
      verifierResults: [],
      failureReason: "adapter-refused",
    })
    expect(artifact.results[0]!.phases[1]?.failureMessage).toContain(
      "formation refused"
    )
  })

  it("rejects task.workspace paths that escape the eval-suite parent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-task-suite-"))
    const suitesDir = join(dir, "task-suites")
    await mkdir(suitesDir, { recursive: true })
    const suitePath = join(suitesDir, "suite.yaml")
    // `workspace: ../../../../etc` would resolve outside the suite
    // parent. Without the guard, `prepareWorkspace` would `fs.cp` that
    // tree into the agent's tmpdir before the adapter runs.
    await writeFile(
      suitePath,
      `version: 1
name: workspace-escape
tasks:
  - id: workspace-escape-task
    prompt: Do something.
    agent: codex
    workspace: ../../../../etc
    verifiers:
      - type: file-exists
        path: passwd
`,
      "utf-8"
    )

    const adapter = mockAdapter("codex", async () => successResult())

    await expect(
      runTaskEvalSuite(suitePath, {
        adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      })
    ).rejects.toThrow(/escapes the eval-suite parent/)
  })

  it("rejects memoryConditions fixture paths that escape the eval-suite parent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-task-suite-"))
    const suitesDir = join(dir, "task-suites")
    const workspaceDir = join(dir, "workspaces", "x")
    await mkdir(suitesDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, "package.json"), '{"name": "x"}\n', "utf-8")
    const suitePath = join(suitesDir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
name: matrix-escape
tasks:
  - id: matrix-escape-task
    prompt: Do something.
    agent: codex
    workspace: ../workspaces/x
    memoryConditions:
      helpful: ../../../../etc/passwd
    verifiers:
      - type: file-exists
        path: package.json
`,
      "utf-8"
    )

    const adapter = mockAdapter("codex", async () => successResult())

    await expect(
      runTaskEvalSuite(suitePath, {
        adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      })
    ).rejects.toThrow(/escapes the eval-suite parent/)
  })

  it("rejects suites with duplicate task ids at parse time", () => {
    const result = taskEvalSuiteSchema.safeParse({
      version: 1,
      name: "dup-suite",
      tasks: [
        {
          id: "same-id",
          prompt: "p",
          workspace: "../w/x",
          verifiers: [{ type: "file-exists", path: "x" }],
        },
        {
          id: "same-id",
          prompt: "p",
          workspace: "../w/x",
          verifiers: [{ type: "file-exists", path: "x" }],
        },
      ],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        'duplicate task id "same-id"; ids must be unique within a suite'
      )
    }
  })

  it("rejects malformed regex patterns at schema parse time", () => {
    const result = taskEvalSuiteSchema.safeParse({
      version: 1,
      name: "bad-regex",
      tasks: [
        {
          id: "bad-pattern",
          prompt: "p",
          workspace: "../w/x",
          verifiers: [
            { type: "file-contents-match", path: "x", pattern: "[" },
          ],
        },
      ],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((i) => i.message)).toContain(
        "must be a valid JavaScript regex"
      )
    }
  })

  it("committed starter suite verifiers fail on the unchanged fixture for fix-import and typed-result", async () => {
    // Regression pin for the two false-pass closures landed in this PR:
    // a no-op agent (exit 0, no workspace edits) MUST fail both
    // `fix-broken-import-path` and `returns-result-from-service-boundary`
    // on the committed starter suite. If a future contributor reverts
    // the strengthened verifier patterns (`(?:^|\n)import\s+\{\s*greet…`
    // / `return\s+(?:ok|err)\(`) or re-adds verifier-target tokens to
    // the workspace fixtures' comments, a no-op agent could once again
    // satisfy every verifier — this test trips before that lands.
    const noopAdapter = mockAdapter("codex", async () => successResult())
    const { artifact } = await runTaskEvalSuite(
      "evals/task-suites/starter.yaml",
      { adapters: new Map<string, AgentAdapter>([["codex", noopAdapter]]) }
    )

    const targetTaskIds = new Set([
      "fix-broken-import-path",
      "returns-result-from-service-boundary",
    ])
    const targetTrials = artifact.results.filter((r) =>
      targetTaskIds.has(r.taskId)
    )
    expect(targetTrials.length).toBeGreaterThan(0)
    for (const trial of targetTrials) {
      expect({
        taskId: trial.taskId,
        condition: trial.memoryCondition,
        success: trial.success,
      }).toMatchObject({ success: false })
      // Every match-mode verifier must have failed for this to be a
      // genuine no-op-fails-task assertion. A `file-unchanged` check
      // can legitimately pass on the unchanged fixture; the
      // load-bearing claim is that the positive content patterns do
      // NOT match.
      const matchVerifiers = trial.verifiers.filter(
        (v) =>
          v.verifier.type === "file-contents-match" &&
          v.verifier.mode !== "forbid"
      )
      expect(matchVerifiers.length).toBeGreaterThan(0)
      expect(matchVerifiers.every((v) => !v.passed)).toBe(true)
    }
  })

  it("fix-broken-import-path passes a valid one-line import-only repair", async () => {
    // Regression pin: an agent that makes the correct minimal edit
    // (rewrite the broken import path, leave comments alone) MUST
    // succeed on `fix-broken-import-path`. The earlier round used a
    // bare `pattern: missing/helpers` forbid that matched the fixture
    // comment, false-failing this exact valid repair. The forbid is
    // now `(?:^|\n)import\b[^\n]*missing/helpers` so only an actual
    // import declaration trips it. Without this test, a future
    // contributor could revert the line-boundary anchor without
    // immediate signal.
    const fixingAdapter = mockAdapter("codex", async ({ workspace }) => {
      // The adapter runs across every task in the suite. Only the
      // fix-import workspace contains the broken-import line; other
      // tasks' fixtures are left untouched so their own verifiers
      // exercise their own contracts.
      const path = join(workspace, "index.js")
      const before = await readFile(path, "utf-8").catch(() => "")
      if (before.includes('"./missing/helpers.js"')) {
        const after = before.replace(
          'import { greet } from "./missing/helpers.js"',
          'import { greet } from "./helpers.js"'
        )
        expect(after).not.toBe(before)
        expect(after).toContain('from "./helpers.js"')
        await writeFile(path, after, "utf-8")
      }
      return successResult()
    })
    const { artifact } = await runTaskEvalSuite(
      "evals/task-suites/starter.yaml",
      { adapters: new Map<string, AgentAdapter>([["codex", fixingAdapter]]) }
    )

    const fixTrials = artifact.results.filter(
      (r) => r.taskId === "fix-broken-import-path"
    )
    expect(fixTrials.length).toBeGreaterThan(0)
    for (const trial of fixTrials) {
      expect({
        taskId: trial.taskId,
        condition: trial.memoryCondition,
        success: trial.success,
        failed: trial.verifiers
          .filter((v) => !v.passed)
          .map((v) => v.message),
      }).toMatchObject({ success: true, failed: [] })
    }
  })

  it("fix-broken-import-path fails when the agent deletes the import and leaves comments behind", async () => {
    // Companion regression: even if the broken import is gone, a
    // missing replacement (no `import { greet } from "./helpers.js"`)
    // must not pass. The strengthened positive verifier is the
    // load-bearing check here.
    const deletingAdapter = mockAdapter("codex", async ({ workspace }) => {
      const path = join(workspace, "index.js")
      const before = await readFile(path, "utf-8").catch(() => "")
      if (before.includes('"./missing/helpers.js"')) {
        const after = before.replace(
          /^import \{ greet \} from "\.\/missing\/helpers\.js"\n/m,
          ""
        )
        expect(after).not.toBe(before)
        expect(after).not.toMatch(/^import\b/m)
        await writeFile(path, after, "utf-8")
      }
      return successResult()
    })
    const { artifact } = await runTaskEvalSuite(
      "evals/task-suites/starter.yaml",
      { adapters: new Map<string, AgentAdapter>([["codex", deletingAdapter]]) }
    )

    const fixTrials = artifact.results.filter(
      (r) => r.taskId === "fix-broken-import-path"
    )
    expect(fixTrials.length).toBeGreaterThan(0)
    for (const trial of fixTrials) {
      expect({
        taskId: trial.taskId,
        condition: trial.memoryCondition,
        success: trial.success,
      }).toMatchObject({ success: false })
    }
  })

  it("rejects suites that reference an agent missing from TASK_EVAL_AGENTS", () => {
    const result = taskEvalSuiteSchema.safeParse({
      version: 1,
      name: "bad-agent",
      tasks: [
        {
          id: "uses-mock",
          prompt: "p",
          agent: "mock",
          workspace: "../w/x",
          verifiers: [{ type: "file-exists", path: "x" }],
        },
      ],
    })

    expect(result.success).toBe(false)
  })
})

describe("buildCodexChildEnv", () => {
  it("forwards only allowlisted vars", () => {
    const env = buildCodexChildEnv({
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "sk-test",
      CODEX_TRACE: "1",
      // Secrets that must be stripped:
      NOTION_API_TOKEN: "secret-1",
      GITHUB_TOKEN: "secret-3",
      AWS_SECRET_ACCESS_KEY: "secret-4",
    })
    expect(env["PATH"]).toBe("/usr/bin")
    expect(env["HOME"]).toBe("/tmp/home")
    expect(env["LANG"]).toBe("en_US.UTF-8")
    expect(env["OPENAI_API_KEY"]).toBe("sk-test")
    expect(env["CODEX_TRACE"]).toBe("1")
    expect(env["NOTION_API_TOKEN"]).toBeUndefined()
    expect(env["GITHUB_TOKEN"]).toBeUndefined()
    expect(env["AWS_SECRET_ACCESS_KEY"]).toBeUndefined()
  })

  it("ships an explicit allowlist of forwarded keys", () => {
    expect(CODEX_FORWARDED_ENV_KEYS).toEqual([
      "PATH",
      "HOME",
      "TMPDIR",
      "TZ",
      "LANG",
      "LC_ALL",
      "LC_CTYPE",
      "OPENAI_API_KEY",
    ])
  })

  it("pins HOME to the isolated Codex home for eval subprocesses", () => {
    const env = buildCodexChildEnv(
      {
        PATH: "/usr/bin",
        HOME: "/Users/example",
        CODEX_HOME: "/Users/example/.codex",
      },
      { codexHome: "/tmp/lore-eval-codex-home-test" },
    )
    expect(env["PATH"]).toBe("/usr/bin")
    expect(env["HOME"]).toBe("/tmp/lore-eval-codex-home-test")
    expect(env["CODEX_HOME"]).toBe("/tmp/lore-eval-codex-home-test")
  })
})

describe("createIsolatedCodexHome", () => {
  it("copies auth and top-level model settings without global MCP or memories", async () => {
    const sourceHome = await mkdtemp(join(tmpdir(), "lore-codex-source-home-"))
    const isolatedHomes: string[] = []
    try {
      await mkdir(join(sourceHome, "memories"), { recursive: true })
      await writeFile(
        join(sourceHome, "auth.json"),
        '{"OPENAI_API_KEY":"sk-test-sentinel"}\n',
        "utf-8",
      )
      await writeFile(
        join(sourceHome, "config.toml"),
        [
          'model = "gpt-5.5"',
          'model_reasoning_effort = "xhigh"',
          'sandbox_mode = "danger-full-access"',
          "",
          "[mcp_servers.lore]",
          'command = "node"',
          "",
        ].join("\n"),
        "utf-8",
      )

      const codexHome = await createIsolatedCodexHome({ CODEX_HOME: sourceHome })
      isolatedHomes.push(codexHome)

      expect(await readFile(join(codexHome, "auth.json"), "utf-8")).toBe(
        '{"OPENAI_API_KEY":"sk-test-sentinel"}\n',
      )
      const config = await readFile(join(codexHome, "config.toml"), "utf-8")
      expect(config).toContain('model = "gpt-5.5"')
      expect(config).toContain('model_reasoning_effort = "xhigh"')
      expect(config).not.toContain("sandbox_mode")
      expect(config).not.toContain("mcp_servers")
      expect(existsSync(join(codexHome, "memories"))).toBe(false)
    } finally {
      for (const codexHome of isolatedHomes) {
        await rm(codexHome, { recursive: true, force: true })
      }
      await rm(sourceHome, { recursive: true, force: true })
    }
  })

  it("removes copied auth if isolated setup fails", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "lore-codex-home-fail-"))
    const previousTmpdir = process.env["TMPDIR"]
    process.env["TMPDIR"] = tempRoot
    const sourceHome = await mkdtemp(join(tempRoot, "source-codex-home-"))
    try {
      await writeFile(
        join(sourceHome, "auth.json"),
        '{"OPENAI_API_KEY":"sk-test-sentinel"}\n',
        "utf-8",
      )
      await mkdir(join(sourceHome, "config.toml"))

      await expect(createIsolatedCodexHome({ CODEX_HOME: sourceHome })).rejects.toThrow()

      const leftovers = (await readdir(tempRoot)).filter((name) =>
        name.startsWith("lore-eval-codex-home-")
      )
      expect(leftovers).toEqual([])
    } finally {
      if (previousTmpdir === undefined) {
        delete process.env["TMPDIR"]
      } else {
        process.env["TMPDIR"] = previousTmpdir
      }
      await rm(tempRoot, { recursive: true, force: true })
    }
  })
})

describe("selectExpectedContextIds", () => {
  it("accepts expected keywords distributed across one formation's rows", () => {
    const ids = selectExpectedContextIds(
      ["Result", "ok", "err"],
      [
        {
          id: "decision-result",
          kind: "decision",
          text: "Service boundaries return Result values.",
        },
        {
          id: "fact-ok",
          kind: "fact",
          text: "createUserProfile uses ok helper",
        },
        {
          id: "fact-err",
          kind: "fact",
          text: "createUserProfile uses err helper",
        },
      ],
    )

    expect(ids).toEqual(["decision-result", "fact-ok", "fact-err"])
  })

  it("requires the formed context set to cover every expected keyword", () => {
    const ids = selectExpectedContextIds(
      ["--json", "status", "follow-up"],
      [
        {
          id: "task-json",
          kind: "task",
          text: "Add --json output for status automation consumers.",
        },
      ],
    )

    expect(ids).toEqual([])
  })
})

async function writeTaskSuite(input: {
  workspace: Record<string, string>
  suite: string
}): Promise<{ suitePath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "lore-eval-task-suite-"))
  const suitesDir = join(dir, "task-suites")
  const workspaceDir = join(dir, "workspaces", "x")
  await mkdir(suitesDir, { recursive: true })
  await mkdir(workspaceDir, { recursive: true })
  for (const [name, contents] of Object.entries(input.workspace)) {
    await writeFile(join(workspaceDir, name), contents)
  }
  const suitePath = join(suitesDir, "suite.yaml")
  await writeFile(suitePath, input.suite)
  return { suitePath }
}

function mockAdapter(
  id: string,
  run: (input: AgentRunInput) => Promise<AgentRunResult>
): AgentAdapter {
  return { id, run }
}

function successResult(): AgentRunResult {
  return { exitCode: 0, stdout: "", stderr: "", timedOut: false }
}

describe("bench spawn argv carries NO secrets", () => {
  it("buildBenchSpawnArgs does not contain bearer-shaped substrings", () => {
    // Invariant: the bench MCP config (transport, command, args, env
    // including the Notion bearer) lives entirely on disk at
    // `<workspace>/.codex/config.toml` (mode 0600). The spawn
    // argv carries ZERO `-c mcp_servers.lore.*` overrides. Any
    // future refactor that re-introduces `-c mcp_servers.lore.env=...`
    // would fail this test loudly.
    //
    // The assertion uses sentinel bearer-shaped tokens that the
    // operator's real env may or may not contain. They flow through
    // process.env in the test's setup; `buildBenchSpawnArgs` ignores
    // env entirely (the workspace path and prompt are its only inputs)
    // so the assertion is structural, not env-dependent.
    process.env["LORE_BENCH_NOTION_TOKEN"] =
      "ntn_SENTINEL_BENCH_TOKEN_MUST_NEVER_REACH_ARGV"
    process.env["NOTION_API_TOKEN"] =
      "ntn_OPERATOR_DAY_TO_DAY_MUST_NEVER_REACH_ARGV"
    try {
      const args = buildBenchSpawnArgs("/tmp/lore-bench-test-workspace", "Q?")
      const joined = args.join(" ")
      expect(joined).not.toMatch(/ntn_/)
      expect(joined).not.toMatch(/secret_/)
      expect(joined).not.toMatch(/development_ntn_/)
      expect(joined).not.toMatch(/sk-/)
      // Sanity: the args list still carries the expected non-secret
      // structural flags so a future revert that drops `--sandbox`
      // or `--json` fails LOUDLY here rather than at runtime.
      expect(joined).toContain("--json")
      expect(joined).toContain("--cd /tmp/lore-bench-test-workspace")
      expect(joined).toContain("--sandbox workspace-write")
      expect(joined).toContain("--skip-git-repo-check")
    } finally {
      delete process.env["LORE_BENCH_NOTION_TOKEN"]
      delete process.env["NOTION_API_TOKEN"]
    }
  })

  it("buildBenchCodexChildEnv strips Notion bearer from child env (bench partition contract)", () => {
    // Negative-contract pin: the Codex child's env partition MUST
    // NOT carry the Notion bearer. The MCP child reads its auth from
    // the on-disk `[mcp_servers.lore.env]` block in the workspace
    // `.codex/config.toml` (see `buildBenchWorkspace`), not from
    // Codex's parent env. Clearing Notion-shaped keys from the
    // Codex parent env is defense-in-depth so a future Codex
    // env-passthrough behavior change cannot accidentally route the
    // wrong token into the MCP child.
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      OPENAI_API_KEY: "sk-operator-day-to-day",
      LORE_BENCH_OPENAI_API_KEY: "sk-bench-only",
      NOTION_API_TOKEN: "ntn_OPERATOR_DAY_TO_DAY_TOKEN_MUST_NOT_LEAK",
      LORE_BENCH_NOTION_TOKEN: "ntn_BENCH_TOKEN_ALSO_NOT_FORWARDED_VIA_ENV",
      GITHUB_TOKEN: "ghp_must_not_leak",
      ANTHROPIC_API_KEY: "sk-ant-must-not-leak",
    }
    const childEnv = buildBenchCodexChildEnv(parent)
    // OPENAI_API_KEY is sourced from LORE_BENCH_OPENAI_API_KEY, not
    // the operator's day-to-day value.
    expect(childEnv["OPENAI_API_KEY"]).toBe("sk-bench-only")
    // Every Notion-bearer-shaped key must be absent from the child
    // env partition. The MCP child's auth comes from the on-disk
    // `.codex/config.toml`'s `[mcp_servers.lore.env]` block, not from
    // env inheritance — the Codex parent env carries nothing
    // Notion-shaped.
    expect(childEnv["NOTION_API_TOKEN"]).toBeUndefined()
    expect(childEnv["LORE_BENCH_NOTION_TOKEN"]).toBeUndefined()
    expect(childEnv["GITHUB_TOKEN"]).toBeUndefined()
    expect(childEnv["ANTHROPIC_API_KEY"]).toBeUndefined()
    // No bearer-shaped substring appears anywhere in the child env
    // (defense-in-depth against a future allowlist that admits the
    // wrong key).
    const joined = JSON.stringify(childEnv)
    expect(joined).not.toMatch(/ntn_OPERATOR/)
    expect(joined).not.toMatch(/ntn_BENCH/)
    expect(joined).not.toMatch(/ghp_/)
    expect(joined).not.toMatch(/sk-ant/)
  })

  it("BENCH_CHILD_CLEARED_ENV_KEYS lists every Notion-bearer key", () => {
    // Regression guard: if a future contributor adds a new bearer
    // key without listing it here, this test fails. The set must
    // include canonical Notion auth plus any other operator-day-to-day
    // secrets the bench needs to clear.
    expect(BENCH_CHILD_CLEARED_ENV_KEYS).toContain("NOTION_API_TOKEN")
    expect(BENCH_CHILD_CLEARED_ENV_KEYS).toContain("GITHUB_TOKEN")
    expect(BENCH_CHILD_CLEARED_ENV_KEYS).toContain("ANTHROPIC_API_KEY")
  })
})
