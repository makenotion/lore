import { mkdtemp, mkdir, writeFile, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  buildCodexChildEnv,
  CODEX_FORWARDED_ENV_KEYS,
  runTaskEvalSuite,
  taskEvalSuiteSchema,
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
      LORE_NOTION_TOKEN: "secret-2",
      GITHUB_TOKEN: "secret-3",
      AWS_SECRET_ACCESS_KEY: "secret-4",
    })
    expect(env["PATH"]).toBe("/usr/bin")
    expect(env["HOME"]).toBe("/tmp/home")
    expect(env["LANG"]).toBe("en_US.UTF-8")
    expect(env["OPENAI_API_KEY"]).toBe("sk-test")
    expect(env["CODEX_TRACE"]).toBe("1")
    expect(env["NOTION_API_TOKEN"]).toBeUndefined()
    expect(env["LORE_NOTION_TOKEN"]).toBeUndefined()
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
