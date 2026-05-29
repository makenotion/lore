import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import {
  chmod,
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  readdir,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { delimiter, dirname, join, posix } from "node:path"
import { describe, expect, it } from "vitest"
import {
  BENCH_CHILD_CLEARED_ENV_KEYS,
  BENCH_SHELL_ENV_EXCLUDES,
  BENCH_TOOL_SHIM_DIR,
  buildBenchCodexChildEnv,
  buildBenchSpawnArgs,
  buildTaskSpawnArgs,
  buildCodexChildEnv,
  CODEX_FORWARDED_ENV_KEYS,
  createIsolatedCodexHome,
  isLongitudinalTaskArtifact,
  LongitudinalAdapterRefusedError,
  longitudinalMiningAgentForScenario,
  parseCodexConfigModel,
  resolveCodexExecutable,
  resolveExecutableOnPath,
  selectExpectedContextIds,
  type LongitudinalAgentConfigServices,
  type LongitudinalLoreAdapter,
  loadTaskEvalSuite,
  runTaskEvalSuite,
  taskEvalSuiteSchema,
  withTemporaryLongitudinalAgentConfig,
  type AgentAdapter,
  type AgentRunInput,
  type AgentRunResult,
} from "./task-runner.js"
import {
  assertLongitudinalShardResultsComplete,
  completeLongitudinalShardResults,
  filterShardResultsForTerminatedRun,
} from "./task-runner/longitudinal-runner.js"
import { writePatchEvidence } from "./task-runner/patch-stats.js"
import { loadSeedCorpus } from "./seed-corpus.js"

describe("task-runner", () => {
  it("loads the committed GitHub CLI longitudinal pilot suite", async () => {
    const loaded = await loadTaskEvalSuite(
      "evals/task-suites/longitudinal-github-cli-pilot.yaml"
    )

    if (!("longitudinal" in loaded.suite) || loaded.suite.longitudinal !== true) {
      throw new Error("expected longitudinal suite")
    }
    expect(loaded.suite.conditions).toEqual([
      "no-memory",
      "seeded-lore",
      "lore-full-loop",
    ])
    expect(loaded.suite.seededCorpus).toBe("../vault-seeds/github-cli-pilot.yaml")
    expect(loaded.suite.scenarios).toHaveLength(5)
    expect(loaded.suite.scenarios.every((scenario) => scenario.seededContext)).toBe(true)
  })

  it("loads the GitHub CLI powered candidate suite", async () => {
    const loaded = await loadTaskEvalSuite(
      "evals/task-suites/longitudinal-github-cli-powered-candidates.yaml"
    )

    if (!("longitudinal" in loaded.suite) || loaded.suite.longitudinal !== true) {
      throw new Error("expected longitudinal suite")
    }
    expect(loaded.suite.conditions).toEqual([
      "no-memory",
      "seeded-lore",
      "lore-full-loop",
    ])
    expect(loaded.suite.seededCorpus).toBe("../vault-seeds/github-cli-powered.yaml")
    expect(loaded.suite.scenarios).toHaveLength(202)
    expect(loaded.suite.scenarios.every((scenario) => scenario.seededContext)).toBe(true)
    expect(countByDifficulty(loaded.suite.scenarios)).toEqual({
      easy: 66,
      medium: 114,
      hard: 22,
    })

    const corpus = await loadSeedCorpus("evals/vault-seeds/github-cli-powered.yaml")
    const memoryById = new Map(corpus.vault.memories.map((memory) => [memory.id, memory]))
    const corpusContextIds = new Set([
      ...corpus.vault.memories.map((memory) => memory.id),
      ...corpus.vault.decisions.map((decision) => decision.id),
      ...corpus.vault.facts.map((fact) => fact.id),
    ])
    const scenarioIds = new Set(loaded.suite.scenarios.map((scenario) => scenario.id))
    for (const memory of corpus.vault.memories) {
      for (const scenarioId of memory.scenarios) {
        expect(scenarioIds.has(scenarioId)).toBe(true)
      }
    }
    for (const scenario of loaded.suite.scenarios) {
      const contextIds = scenario.seededContext?.contextIds ?? []
      expect(contextIds.length).toBeGreaterThan(0)
      for (const contextId of contextIds)
        expect(corpusContextIds.has(contextId)).toBe(true)
      const testName = poweredScenarioTestName(scenario.id)
      if (
        scenario.difficulty !== "hard" &&
        !POWERED_SCENARIOS_WITH_PROMPT_SAFE_TEST_NAME_OMISSION.has(scenario.id)
      ) {
        expect(scenario.phaseB.prompt).toContain(testName)
        expect(verifiersIncludeTestName(scenario.verifiers, testName)).toBe(true)
      }
      for (const packageDir of goPackageDirsForFileVerifiers(scenario.verifiers)) {
        expect(
          scenario.verifiers.some(
            (verifier) =>
              verifier.type === "command" &&
              verifier.command === "go" &&
              goTestArgsCoverPackage(verifier.args, packageDir)
          )
        ).toBe(true)
      }
      expect(
        contextIds.some((contextId) => {
          const memory = memoryById.get(contextId)
          return memory?.scenarios.includes(scenario.id) ?? false
        })
      ).toBe(true)
    }
  })

  it("keeps the GitHub CLI capability-edge v3 seeded context tied to the corpus", async () => {
    const loaded = await loadTaskEvalSuite(
      "evals/task-suites/longitudinal-github-cli-capability-edge-v3.yaml"
    )

    if (!("longitudinal" in loaded.suite) || loaded.suite.longitudinal !== true) {
      throw new Error("expected longitudinal suite")
    }

    expect(loaded.suite.conditions).toEqual([
      "no-memory",
      "seeded-lore",
      "lore-full-loop",
    ])
    expect(loaded.suite.seededCorpus).toBe(
      "../vault-seeds/github-cli-capability-edge-v3.yaml"
    )

    const corpus = await loadSeedCorpus(
      "evals/vault-seeds/github-cli-capability-edge-v3.yaml"
    )
    const memoryById = new Map(corpus.vault.memories.map((memory) => [memory.id, memory]))
    const scenarioIds = new Set(loaded.suite.scenarios.map((scenario) => scenario.id))

    expect(countByDifficulty(loaded.suite.scenarios)).toEqual({
      easy: 1,
      medium: 1,
      hard: 5,
    })
    expect(corpus.vault.memories.length).toBeGreaterThanOrEqual(
      loaded.suite.scenarios.length
    )

    for (const memory of corpus.vault.memories) {
      for (const scenarioId of memory.scenarios) {
        expect(scenarioIds.has(scenarioId)).toBe(true)
      }
    }
    for (const scenario of loaded.suite.scenarios) {
      const seededContext = scenario.seededContext
      expect(seededContext).toBeDefined()
      const renderedContext = seededContext?.renderedContext ?? ""
      expect(renderedContext).not.toMatch(/TestHidden|hidden verifier|verifier patch/i)
      for (const contextId of seededContext?.contextIds ?? []) {
        const memory = memoryById.get(contextId)
        expect(memory).toBeDefined()
        expect(memory?.scenarios).toContain(scenario.id)
      }
    }
  })

  it("loads the GitHub CLI public-spec suite with realistic neighboring context", async () => {
    const loaded = await loadTaskEvalSuite(
      "evals/task-suites/longitudinal-github-cli-public-spec-v1.yaml"
    )

    if (!("longitudinal" in loaded.suite) || loaded.suite.longitudinal !== true) {
      throw new Error("expected longitudinal suite")
    }

    expect(loaded.suite.name).toBe("lore-longitudinal-github-cli-public-spec-v1")
    expect(loaded.suite.seededCorpus).toBe(
      "../vault-seeds/github-cli-public-spec-v1.yaml"
    )
    const corpus = await loadSeedCorpus(
      "evals/vault-seeds/github-cli-public-spec-v1.yaml"
    )
    const memoryIds = new Set(corpus.vault.memories.map((memory) => memory.id))
    expect(memoryIds).toContain("gh-cli/ref-validation-shared-boundary")
    expect(memoryIds).toContain("gh-cli/auth-token-source-boundaries")

    for (const scenario of loaded.suite.scenarios) {
      expect(scenario.phaseB.prompt).not.toContain("exactly as planned")
      const contextIds = scenario.seededContext?.contextIds ?? []
      expect(contextIds.length).toBeGreaterThanOrEqual(2)
      for (const contextId of contextIds) {
        expect(memoryIds.has(contextId)).toBe(true)
      }
    }
  })

  it("keeps GitHub CLI memory-contract verifier patches internally consistent", async () => {
    const loaded = await loadTaskEvalSuite(
      "evals/task-suites/longitudinal-github-cli-memory-contract-v2.yaml"
    )

    if (!("longitudinal" in loaded.suite) || loaded.suite.longitudinal !== true) {
      throw new Error("expected longitudinal suite")
    }

    let patchedVerifierCount = 0
    for (const scenario of loaded.suite.scenarios) {
      for (const verifier of scenario.verifiers) {
        if (verifier.type !== "patched-command") continue
        patchedVerifierCount += 1
        expectPatchHunksToMatchLineCounts(verifier.patch, scenario.id)

        const dir = await mkdtemp(join(tmpdir(), "lore-eval-patch-check-"))
        try {
          git(dir, ["init", "--quiet"])
          const patchPath = join(dir, "verifier.patch")
          await writeFile(patchPath, verifier.patch, "utf-8")
          expect(() =>
            execFileSync("git", ["apply", "--check", patchPath], {
              cwd: dir,
              stdio: "pipe",
            })
          ).not.toThrow()
          execFileSync("git", ["apply", patchPath], {
            cwd: dir,
            stdio: "pipe",
          })
          execFileSync(process.execPath, ["--check", ".lore-hidden-verify.mjs"], {
            cwd: dir,
            stdio: "pipe",
          })
        } finally {
          await rm(dir, { recursive: true, force: true })
        }
      }
    }
    expect(patchedVerifierCount).toBe(17)
  }, 15_000)

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

    let observedTranscriptPath: string | undefined
    const adapter = mockAdapter("codex", async ({ workspace, transcriptPath }) => {
      observedTranscriptPath = transcriptPath
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
    expect(observedTranscriptPath).toMatch(
      /result-transcripts[/\\]001-agent-creates-readme\.codex\.jsonl$/
    )
    expect(JSON.parse(await readFile(outPath, "utf-8"))).toMatchObject({
      runner: { mode: "task" },
      summary: { passedTasks: 1 },
    })
  })

  it("does not pass verifier answer keys to the task agent prompt or workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "lore-task-answer-key-test-"))
    try {
      const suiteDir = join(root, "evals", "task-suites")
      const workspaceDir = join(root, "evals", "workspaces", "answer-key")
      await mkdir(suiteDir, { recursive: true })
      await mkdir(workspaceDir, { recursive: true })
      await writeFile(join(workspaceDir, "README.md"), "fixture\n", "utf-8")

      const answerKey = "ANSWER_KEY_SENTINEL_DO_NOT_SHOW_AGENT"
      const suitePath = join(suiteDir, "suite.yaml")
      await writeFile(
        suitePath,
        `
version: 1
name: answer-key-boundary
tasks:
  - id: answer-key-hidden
    prompt: Create ok.txt with the expected final content.
    agent: codex
    workspace: ../workspaces/answer-key
    verifiers:
      - type: file-contents-match
        path: ok.txt
        pattern: ${answerKey}
`.trimStart(),
        "utf-8"
      )

      const observedPrompts: string[] = []
      const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
        observedPrompts.push(prompt)
        expect(prompt).not.toContain(answerKey)
        expect(existsSync(join(workspace, "suite.yaml"))).toBe(false)
        expect(existsSync(join(workspace, "task-suite.yaml"))).toBe(false)
        await writeFile(join(workspace, "ok.txt"), answerKey, "utf-8")
        return successResult()
      })

      const { artifact } = await runTaskEvalSuite(suitePath, {
        adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      })

      expect(observedPrompts).toEqual(["Create ok.txt with the expected final content."])
      expect(artifact.summary).toMatchObject({
        passedTasks: 1,
        failedTasks: 0,
        passedTrials: 1,
        failedTrials: 0,
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("materializes git workspaces from a pinned SHA and records metadata", async () => {
    const remoteBase = await mkdtemp(join(tmpdir(), "lore-eval-git-remotes-"))
    const cacheDir = await mkdtemp(join(tmpdir(), "lore-eval-git-cache-"))
    const sourceRepo = await mkdtemp(join(tmpdir(), "lore-eval-git-source-"))
    await writeFile(join(sourceRepo, "README.md"), "# Fixture repo\n", "utf-8")
    git(sourceRepo, ["init", "--quiet"])
    git(sourceRepo, ["add", "README.md"])
    git(sourceRepo, [
      "-c",
      "user.name=Lore Eval",
      "-c",
      "user.email=lore-eval@example.com",
      "commit",
      "--quiet",
      "-m",
      "init",
    ])
    const sha = git(sourceRepo, ["rev-parse", "HEAD"])
    await mkdir(join(remoteBase, "cli"), { recursive: true })
    git(remoteBase, [
      "clone",
      "--quiet",
      "--bare",
      sourceRepo,
      join(remoteBase, "cli", "cli.git"),
    ])

    const suiteDir = await mkdtemp(join(tmpdir(), "lore-eval-git-suite-"))
    const suitesDir = join(suiteDir, "task-suites")
    await mkdir(suitesDir, { recursive: true })
    const suitePath = join(suitesDir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
name: git-workspace
tasks:
  - id: git-workspace
    prompt: Touch the git workspace.
    agent: codex
    workspace:
      kind: git
      repo: cli/cli
      sha: ${sha}
      sparseCheckout:
        - README.md
    verifiers:
      - type: file-exists
        path: DONE.md
`,
      "utf-8"
    )

    const priorRemoteBase = process.env["LORE_EVAL_GIT_REMOTE_BASE_URL"]
    const priorCacheDir = process.env["LORE_EVAL_WORKSPACE_CACHE_DIR"]
    process.env["LORE_EVAL_GIT_REMOTE_BASE_URL"] = remoteBase
    process.env["LORE_EVAL_WORKSPACE_CACHE_DIR"] = cacheDir
    try {
      const adapter = mockAdapter("codex", async ({ workspace }) => {
        expect(await readFile(join(workspace, "README.md"), "utf-8")).toContain(
          "Fixture repo"
        )
        await writeFile(join(workspace, "DONE.md"), "done\n", "utf-8")
        return successResult()
      })

      const { artifact } = await runTaskEvalSuite(suitePath, {
        outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
        adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      })

      const result = artifact.results[0]!
      expect(result.workspaceSource).toBe(`git:cli/cli@${sha}`)
      expect(result.workspaceMaterialization).toMatchObject({
        kind: "git",
        repo: "cli/cli",
        sha,
        sparseCheckout: ["README.md"],
      })
    } finally {
      if (priorRemoteBase === undefined)
        delete process.env["LORE_EVAL_GIT_REMOTE_BASE_URL"]
      else process.env["LORE_EVAL_GIT_REMOTE_BASE_URL"] = priorRemoteBase
      if (priorCacheDir === undefined) delete process.env["LORE_EVAL_WORKSPACE_CACHE_DIR"]
      else process.env["LORE_EVAL_WORKSPACE_CACHE_DIR"] = priorCacheDir
    }
  }, 15_000)

  it("writes staged git changes into patch evidence", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-eval-git-patch-"))
    try {
      git(workspace, ["init", "--quiet"])
      await writeFile(join(workspace, "tracked.txt"), "before\n", "utf-8")
      git(workspace, ["add", "tracked.txt"])
      git(workspace, [
        "-c",
        "user.name=Lore Eval",
        "-c",
        "user.email=lore-eval@example.com",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ])

      await writeFile(join(workspace, "tracked.txt"), "after\n", "utf-8")
      git(workspace, ["add", "tracked.txt"])

      const patchPath = join(workspace, "evidence.patch")
      const patch = await writePatchEvidence({
        sourceRoot: workspace,
        workspaceRoot: workspace,
        outPath: patchPath,
      })

      expect(patch?.bytes).toBeGreaterThan(0)
      await expect(readFile(patchPath, "utf-8")).resolves.toContain("+after")
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("writes committed git changes into patch evidence", async () => {
    const source = await mkdtemp(join(tmpdir(), "lore-eval-git-source-"))
    const workspace = await mkdtemp(join(tmpdir(), "lore-eval-git-workspace-"))
    try {
      git(source, ["init", "--quiet"])
      await writeFile(join(source, "tracked.txt"), "before\n", "utf-8")
      git(source, ["add", "tracked.txt"])
      git(source, [
        "-c",
        "user.name=Lore Eval",
        "-c",
        "user.email=lore-eval@example.com",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ])
      await rm(workspace, { recursive: true, force: true })
      execFileSync("git", ["clone", "--quiet", source, workspace])
      await writeFile(join(workspace, "tracked.txt"), "after\n", "utf-8")
      git(workspace, ["add", "tracked.txt"])
      git(workspace, [
        "-c",
        "user.name=Lore Eval",
        "-c",
        "user.email=lore-eval@example.com",
        "commit",
        "--quiet",
        "-m",
        "agent change",
      ])

      const patchPath = join(workspace, "evidence.patch")
      const patch = await writePatchEvidence({
        sourceRoot: source,
        workspaceRoot: workspace,
        outPath: patchPath,
      })

      expect(patch?.bytes).toBeGreaterThan(0)
      await expect(readFile(patchPath, "utf-8")).resolves.toContain("+after")
    } finally {
      await rm(source, { recursive: true, force: true })
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("truncates large patch evidence without dropping the sidecar", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-eval-git-large-patch-"))
    try {
      git(workspace, ["init", "--quiet"])
      await writeFile(join(workspace, "tracked.txt"), "before\n", "utf-8")
      git(workspace, ["add", "tracked.txt"])
      git(workspace, [
        "-c",
        "user.name=Lore Eval",
        "-c",
        "user.email=lore-eval@example.com",
        "commit",
        "--quiet",
        "-m",
        "baseline",
      ])

      await writeFile(
        join(workspace, "tracked.txt"),
        `${"x".repeat(2_200_000)}\n`,
        "utf-8"
      )

      const patchPath = join(workspace, "evidence.patch")
      const patch = await writePatchEvidence({
        sourceRoot: workspace,
        workspaceRoot: workspace,
        outPath: patchPath,
      })

      expect(patch?.truncated).toBe(true)
      expect(patch?.bytes).toBeLessThanOrEqual(2_000_000)
      await expect(readFile(patchPath, "utf-8")).resolves.toContain(
        "patch-evidence-truncated"
      )
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
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

  it("passes any-file content verifiers when one allowed path matches", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: {
        "primary.go": "package main\n",
      },
      suite: `version: 1
name: any-file-verifier
tasks:
  - id: agent-uses-shared-helper
    prompt: Add display name handling.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: any-file-contents-match
        paths:
          - primary.go
          - shared/helper.go
        pattern: DisplayName
`,
    })

    const adapter = mockAdapter("codex", async ({ workspace }) => {
      await mkdir(join(workspace, "shared"), { recursive: true })
      await writeFile(
        join(workspace, "shared", "helper.go"),
        'package shared\n\nfunc DisplayName() string { return "ok" }\n',
        "utf-8"
      )
      return successResult()
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.summary.failedTrials).toBe(0)
    expect(artifact.results[0]!.verifiers[0]!.message).toContain(
      "Pattern matched in shared/helper.go"
    )
  })

  it("expands globs in any-file content verifiers", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: {},
      suite: `version: 1
name: any-file-glob-verifier
tasks:
  - id: agent-adds-test
    prompt: Add a regression test.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: any-file-contents-match
        paths:
          - pkg/example/*_test.go
        pattern: TestNewBehavior
`,
    })

    const adapter = mockAdapter("codex", async ({ workspace }) => {
      await mkdir(join(workspace, "pkg", "example"), { recursive: true })
      await writeFile(
        join(workspace, "pkg", "example", "bar_test.go"),
        "package example\n\nfunc TestNewBehavior(t *testing.T) {}\n",
        "utf-8"
      )
      return successResult()
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(artifact.summary.failedTrials).toBe(0)
    expect(artifact.results[0]!.verifiers[0]!.message).toContain(
      "Pattern matched in pkg/example/bar_test.go"
    )
  })

  it("rejects escaping glob paths in any-file content verifiers", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: {},
      suite: `version: 1
name: any-file-escaping-glob-verifier
tasks:
  - id: verifier-escape
    prompt: Leave files alone.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: any-file-contents-match
        paths:
          - ../*.go
        pattern: SENTINEL
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
      'Verifier path "../*.go" escapes the workspace'
    )
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
    expect(artifact.results[0]!.verifiers[0]!.message).toContain("escapes the workspace")
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
        outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
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
    await writeFile(join(workspaceDir, "package.json"), '{"name": "x"}\n', "utf-8")
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
      observedSeed = await readFile(join(workspace, ".lore-memories.json"), "utf-8")
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
    expect(artifact.results[0]!.verifiers[0]!.message).toContain("Command passed")
  })

  it("runs patched-command verifiers in an isolated verifier workspace", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: {
        "impl.js": "module.exports = () => 'fixture'\n",
        "package.json": '{"name": "x"}\n',
      },
      suite: `version: 1
name: patched-command-verifier
tasks:
  - id: patched-command-checks-agent-output
    prompt: Update impl.js to return ok.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: patched-command
        patch: |
          diff --git a/hidden-test.js b/hidden-test.js
          new file mode 100644
          index 0000000..1191247
          --- /dev/null
          +++ b/hidden-test.js
          @@ -0,0 +1,3 @@
          +const actual = require('./impl.js')()
          +if (actual !== 'ok') {
          +  throw new Error('expected ok, got ' + actual)
          +}
        command: node
        args:
          - hidden-test.js
`,
    })

    const adapter = mockAdapter("codex", async ({ workspace }) => {
      await writeFile(
        join(workspace, "impl.js"),
        "module.exports = () => 'ok'\n",
        "utf-8"
      )
      return successResult()
    })

    const outPath = join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json")
    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath,
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      keepWorkspaces: true,
    })

    const result = artifact.results[0]!
    expect(result.success).toBe(true)
    expect(result.verifiers[0]!.message).toContain("Patched command passed")
    expect(result.verifiers[0]!.verifier).toMatchObject({
      type: "patched-command",
      command: "node",
      patchBytes: expect.any(Number),
      patchSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    })
    const persisted = await readFile(outPath, "utf-8")
    expect(persisted).not.toContain("diff --git")
    expect(persisted).not.toContain("expected ok")
    const workspace = result.workspace
    expect(workspace).not.toBeNull()
    await expect(stat(join(workspace as string, "hidden-test.js"))).rejects.toThrow()
  })

  it("omits patched-command failure output from artifacts", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: {
        "impl.js": "module.exports = () => 'fixture'\n",
        "package.json": '{"name": "x"}\n',
      },
      suite: `version: 1
name: patched-command-output-redaction
tasks:
  - id: patched-command-redacts-hidden-output
    prompt: Leave impl.js unchanged.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: patched-command
        patch: |
          diff --git a/hidden-test.js b/hidden-test.js
          new file mode 100644
          index 0000000..a5c20fd
          --- /dev/null
          +++ b/hidden-test.js
          @@ -0,0 +1 @@
          +throw new Error('HIDDEN_OUTPUT_SHOULD_NOT_LEAK')
        command: node
        args:
          - hidden-test.js
`,
    })

    const outPath = join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json")
    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath,
      adapters: new Map<string, AgentAdapter>([
        ["codex", mockAdapter("codex", async () => successResult())],
      ]),
    })

    const message = artifact.results[0]!.verifiers[0]!.message
    const persisted = await readFile(outPath, "utf-8")
    expect(artifact.results[0]!.failureReason).toBe("verifiers")
    expect(message).toContain("hidden verifier output omitted")
    expect(message).not.toContain("HIDDEN_OUTPUT_SHOULD_NOT_LEAK")
    expect(persisted).not.toContain("HIDDEN_OUTPUT_SHOULD_NOT_LEAK")

    const output = artifact.results[0]!.verifiers[0]!.output
    expect(output).toMatchObject({
      format: "verifier-output-json",
      truncated: false,
    })
    const outputJson = JSON.parse(await readFile(output!.path, "utf-8")) as {
      stage: string
      command: string
      args: string[]
      exitCode: number
      timedOut: boolean
      stdoutTruncated: boolean
      stderrTruncated: boolean
      stdout: string
      stderr: string
    }
    expect(outputJson).toMatchObject({
      stage: "command",
      command: "node",
      args: ["hidden-test.js"],
      exitCode: 1,
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
    })
    expect(`${outputJson.stdout}\n${outputJson.stderr}`).toContain(
      "HIDDEN_OUTPUT_SHOULD_NOT_LEAK"
    )
  })

  it("keeps multi-line command verifier output for adjudication", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: command-output-verifier
tasks:
  - id: command-output-is-captured
    prompt: Leave workspace unchanged.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: command
        command: node
        args:
          - -e
          - "console.error('first line'); console.error('second line'); process.exit(1)"
`,
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([
        ["codex", mockAdapter("codex", async () => successResult())],
      ]),
    })

    const message = artifact.results[0]!.verifiers[0]!.message
    expect(artifact.summary.failedTrials).toBe(1)
    expect(message).toContain("first line")
    expect(message).toContain("second line")
  })

  it("runs command verifiers with shared Go cache env", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "package.json": '{"name": "x"}\n' },
      suite: `version: 1
name: command-env-verifier
tasks:
  - id: command-env-has-go-caches
    prompt: Leave workspace unchanged.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: command
        command: node
        args:
          - -e
          - "if (!process.env.GOMODCACHE || !process.env.GOCACHE) process.exit(1)"
`,
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([
        ["codex", mockAdapter("codex", async () => successResult())],
      ]),
    })

    expect(artifact.summary.failedTrials).toBe(0)
  })

  it("rejects the cost kill-switch for non-longitudinal task suites", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "README.md": "fixture\n" },
      suite: `version: 1
name: standard-cost-kill
tasks:
  - id: one-task
    prompt: Write a file.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: done.txt
`,
    })

    await expect(
      runTaskEvalSuite(suitePath, {
        costKillSwitchUsd: 1,
        adapters: new Map<string, AgentAdapter>([
          ["codex", mockAdapter("codex", async () => successResult())],
        ]),
      })
    ).rejects.toThrow("--cost-kill-switch-usd is only supported")
  })

  it("rejects longitudinal filters for non-longitudinal task suites", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "README.md": "fixture\n" },
      suite: `version: 1
name: standard-longitudinal-filters
tasks:
  - id: one-task
    prompt: Write a file.
    agent: codex
    workspace: ../workspaces/x
    verifiers:
      - type: file-exists
        path: done.txt
`,
    })

    await expect(
      runTaskEvalSuite(suitePath, {
        difficulty: "hard",
        sample: { seed: "sample", counts: { hard: 1 } },
        scenarioIds: ["one-task"],
        conditions: ["no-memory"],
        parallelism: 2,
        adapters: new Map<string, AgentAdapter>([
          ["codex", mockAdapter("codex", async () => successResult())],
        ]),
      })
    ).rejects.toThrow(
      "--difficulty, --sample, --scenario-id, --condition, and --parallel"
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

    const phaseWorkspaces: Array<{
      prompt: string
      workspace: string
      hasCreateUserProfileAtStart: boolean
    }> = []
    const adapter = mockAdapter(
      "codex",
      async ({ prompt, workspace, transcriptPath }) => {
        const servicePath = join(workspace, "profile-service.js")
        phaseWorkspaces.push({
          prompt,
          workspace,
          hasCreateUserProfileAtStart: (await readFile(servicePath, "utf-8")).includes(
            "createUserProfile"
          ),
        })
        if (prompt.includes("createUserProfile")) {
          if (transcriptPath) {
            await mkdir(dirname(transcriptPath), { recursive: true })
            await writeFile(
              transcriptPath,
              [
                JSON.stringify({
                  type: "lore.eval.agent_run.started",
                  prompt,
                }),
                JSON.stringify({
                  type: "item.completed",
                  item: {
                    type: "command_execution",
                    command: "rg -n 'function ok|function err' profile-service.js",
                    aggregated_output:
                      "profile-service.js:1:export function ok(value)\n" +
                      "profile-service.js:2:export function err(error)\n",
                    exit_code: 0,
                  },
                }),
              ].join("\n") + "\n",
              "utf-8"
            )
          }
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
      }
    )

    let cleanupCalls = 0
    let formationTranscript = ""
    const progressEvents: string[] = []
    const loreAdapter: LongitudinalLoreAdapter = {
      async createRun({ workspace }) {
        await mkdir(join(workspace, ".codex"), { recursive: true })
        await writeFile(join(workspace, ".mcp.json"), "{}\n", "utf-8")
        await writeFile(
          join(workspace, ".lore.yaml"),
          "vault:\n  pageId: test\n",
          "utf-8"
        )
        await writeFile(
          join(workspace, ".codex", "config.toml"),
          "[mcp_servers.lore]\n",
          "utf-8"
        )
        return {
          projectId: "project-1",
          projectName: "Eval Sandbox/result-boundary",
          async formContext({ transcript }) {
            formationTranscript = transcript
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
      onProgress(event) {
        if (event.type !== "run-stop") {
          progressEvents.push(
            `${event.type}:${event.index}/${event.total}:${event.condition}`
          )
        }
      },
    })

    expect(cleanupCalls).toBe(1)
    expect(progressEvents).toEqual([
      "trial-start:1/2:no-memory",
      "trial-finish:1/2:no-memory",
      "trial-start:2/2:lore-full-loop",
      "trial-finish:2/2:lore-full-loop",
    ])
    expect(phaseWorkspaces[1]?.workspace).not.toBe(phaseWorkspaces[2]?.workspace)
    expect(phaseWorkspaces[0]?.hasCreateUserProfileAtStart).toBe(false)
    expect(phaseWorkspaces[2]?.hasCreateUserProfileAtStart).toBe(false)
    expect(formationTranscript).toContain("Command: rg -n")
    expect(formationTranscript).toContain("export function err(error)")
    expect(artifact.runner).toMatchObject({ mode: "task", kind: "longitudinal" })
    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(artifact.runner.conditions).toEqual(["no-memory", "lore-full-loop"])
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
        result.scenarioId === "result-boundary" && result.condition === "lore-full-loop"
    )
    expect(fullLoop?.phases[0]?.lore.decisionsCreated).toBe(1)
    expect(fullLoop?.phases[1]?.lore.surfacedContextIds).toEqual(["ctx-result"])
    expect(fullLoop?.phases[1]?.patchStats.filesChanged).toBe(1)
  })

  it("filters longitudinal runs to selected memory conditions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-condition-filter-"))
    const suitesDir = join(dir, "task-suites")
    const workspaceDir = join(dir, "workspaces", "condition-filter")
    await mkdir(suitesDir, { recursive: true })
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, "feature.txt"), "base\n", "utf-8")
    const suitePath = join(suitesDir, "longitudinal.yaml")
    await writeFile(
      suitePath,
      `version: 1
runner: task
longitudinal: true
name: longitudinal-condition-filter
conditions:
  - no-memory
  - seeded-lore
  - lore-full-loop
scenarios:
  - id: condition-filter
    agent: codex
    workspace: ../workspaces/condition-filter
    phaseA:
      prompt: Inspect the feature surface and capture a plan only.
    phaseB:
      prompt: Implement the feature.
    seededContext:
      renderedContext: "- [memory] ctx-condition: Prior plan."
      contextIds: ["ctx-condition"]
    verifiers:
      - type: file-contents-match
        path: feature.txt
        pattern: implemented
`,
      "utf-8"
    )

    const progressEvents: string[] = []
    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      conditions: ["no-memory"],
      adapters: new Map<string, AgentAdapter>([
        [
          "codex",
          mockAdapter("codex", async ({ prompt, workspace }) => {
            if (prompt.includes("Implement")) {
              await writeFile(join(workspace, "feature.txt"), "implemented\n", "utf-8")
            }
            return successResult()
          }),
        ],
      ]),
      onProgress(event) {
        if (event.type !== "run-stop") {
          progressEvents.push(
            `${event.type}:${event.index}/${event.total}:${event.condition}`
          )
        }
      },
    })

    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(progressEvents).toEqual([
      "trial-start:1/1:no-memory",
      "trial-finish:1/1:no-memory",
    ])
    expect(artifact.runner.conditions).toEqual(["no-memory"])
    expect(artifact.results.map((result) => result.condition)).toEqual(["no-memory"])
    expect(artifact.summary.conditions["no-memory"].trials).toBe(1)
    expect(artifact.summary.conditions["seeded-lore"].trials).toBe(0)
    expect(artifact.summary.conditions["lore-full-loop"].trials).toBe(0)
    expect(artifact.summary.passedTasks).toBe(1)
  })

  it("falls back to the final agent response when the transcript has no assistant content", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "notes.js": "export const notes = []\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-transcript-fallback
conditions:
  - lore-full-loop
scenarios:
  - id: transcript-fallback
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect notes.js and summarize the useful convention.
    phaseB:
      prompt: Add rememberedNote using the previous convention.
    expectedContext:
      keywords: ["rememberedNote"]
    verifiers:
      - type: file-contents-match
        path: notes.js
        pattern: 'rememberedNote'
`,
    })

    const adapter = mockAdapter(
      "codex",
      async ({ prompt, workspace, transcriptPath }) => {
        if (prompt.includes("summarize")) {
          if (transcriptPath) {
            await mkdir(dirname(transcriptPath), { recursive: true })
            await writeFile(
              transcriptPath,
              `${JSON.stringify({
                type: "lore.eval.agent_run.started",
                prompt,
              })}\n`,
              "utf-8"
            )
          }
          return {
            ...successResult(),
            stdout: "Assistant found that rememberedNote should be appended to notes.",
          }
        }
        await writeFile(
          join(workspace, "notes.js"),
          "export const notes = ['rememberedNote']\n",
          "utf-8"
        )
        return successResult()
      }
    )

    let formationTranscript = ""
    const loreAdapter: LongitudinalLoreAdapter = {
      async createRun() {
        return {
          projectId: "project-1",
          projectName: "Eval Sandbox/transcript-fallback",
          async formContext({ transcript }) {
            formationTranscript = transcript
            return {
              projectId: "project-1",
              projectName: "Eval Sandbox/transcript-fallback",
              mining: null,
              memoriesCreated: 1,
              factsCreated: 0,
              decisionsCreated: 0,
              tasksCreated: 0,
              createdContextIds: ["ctx-note"],
              expectedContextIds: ["ctx-note"],
            }
          },
          async loadContext() {
            return {
              renderedContext: "- [memory] ctx-note: rememberedNote should be appended.",
              surfacedContextIds: ["ctx-note"],
              harmfulContextIds: [],
              failureMessage: null,
            }
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

    expect(formationTranscript).toContain("Assistant found")
    expect(artifact.summary.passedTasks).toBe(1)
  })

  it("fails longitudinal formation when Phase A edits the workspace", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "notes.js": "export const notes = []\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-read-only-formation
conditions:
  - lore-full-loop
scenarios:
  - id: read-only-formation
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect notes.js and do not edit files.
    phaseB:
      prompt: Add rememberedNote using the previous convention.
    expectedContext:
      keywords: ["rememberedNote"]
    verifiers:
      - type: file-contents-match
        path: notes.js
        pattern: 'rememberedNote'
`,
    })

    let formContextCalls = 0
    const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
      if (prompt.includes("do not edit files")) {
        await writeFile(
          join(workspace, "notes.js"),
          "export const notes = ['phase-a-leak']\n",
          "utf-8"
        )
      }
      return successResult()
    })
    const loreAdapter: LongitudinalLoreAdapter = {
      async createRun() {
        return {
          projectId: "project-1",
          projectName: "Eval Sandbox/read-only-formation",
          async formContext() {
            formContextCalls += 1
            return {
              projectId: "project-1",
              projectName: "Eval Sandbox/read-only-formation",
              mining: null,
              memoriesCreated: 1,
              factsCreated: 0,
              decisionsCreated: 0,
              tasksCreated: 0,
              createdContextIds: ["ctx-note"],
              expectedContextIds: ["ctx-note"],
            }
          },
          async loadContext() {
            return {
              renderedContext: "- [memory] ctx-note: rememberedNote should be appended.",
              surfacedContextIds: ["ctx-note"],
              harmfulContextIds: [],
              failureMessage: null,
            }
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
    expect(formContextCalls).toBe(0)
    expect(artifact.results[0]?.failureReason).toBe("formation")
    expect(artifact.results[0]?.phases[0]?.failureMessage).toContain(
      "Phase A must be read-only"
    )
    expect(artifact.results[0]?.phases[1]?.agentRun).toBeNull()
  })

  it("allows longitudinal formation when Phase A only normalizes whitespace", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "notes.js": "export const notes = []\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-read-only-whitespace
conditions:
  - lore-full-loop
scenarios:
  - id: read-only-whitespace
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect notes.js and do not edit files.
    phaseB:
      prompt: Add rememberedNote using the previous convention.
    expectedContext:
      keywords: ["rememberedNote"]
    verifiers:
      - type: file-contents-match
        path: notes.js
        pattern: 'rememberedNote'
`,
    })

    let formContextCalls = 0
    const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
      if (prompt.includes("do not edit files")) {
        // Incidental read-only touch: rewrite with identical content but no
        // trailing newline. Raw bytes differ (filesChanged > 0) yet no content
        // line changed, so the read-only gate must not fire.
        await writeFile(join(workspace, "notes.js"), "export const notes = []", "utf-8")
      } else {
        await writeFile(
          join(workspace, "notes.js"),
          "export const notes = []\nexport const rememberedNote = true\n",
          "utf-8"
        )
      }
      return successResult()
    })
    const loreAdapter: LongitudinalLoreAdapter = {
      async createRun() {
        return {
          projectId: "project-1",
          projectName: "Eval Sandbox/read-only-whitespace",
          async formContext() {
            formContextCalls += 1
            return {
              projectId: "project-1",
              projectName: "Eval Sandbox/read-only-whitespace",
              mining: null,
              memoriesCreated: 1,
              factsCreated: 0,
              decisionsCreated: 0,
              tasksCreated: 0,
              createdContextIds: ["ctx-note"],
              expectedContextIds: ["ctx-note"],
            }
          },
          async loadContext() {
            return {
              renderedContext: "- [memory] ctx-note: rememberedNote should be appended.",
              surfacedContextIds: ["ctx-note"],
              harmfulContextIds: [],
              failureMessage: null,
            }
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
    // Formation proceeded (gate did not fire on the zero-line touch) and Phase B ran.
    expect(formContextCalls).toBe(1)
    expect(artifact.results[0]?.phases[0]?.failureReason).toBeNull()
    expect(artifact.results[0]?.phases[0]?.patchStats.linesAdded).toBe(0)
    expect(artifact.results[0]?.phases[0]?.patchStats.linesRemoved).toBe(0)
    expect(artifact.results[0]?.phases[1]?.agentRun).not.toBeNull()
    expect(artifact.results[0]?.success).toBe(true)
  })

  it("skips no-memory formation and scores Phase B directly", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "notes.js": "export const notes = []\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-no-memory-formation-diagnostic
conditions:
  - no-memory
scenarios:
  - id: no-memory-formation-diagnostic
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect notes.js and do not edit files.
    phaseB:
      prompt: Add rememberedNote.
    expectedContext:
      keywords: ["rememberedNote"]
    verifiers:
      - type: file-contents-match
        path: notes.js
        pattern: 'rememberedNote'
`,
    })

    const prompts: string[] = []
    const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
      prompts.push(prompt)
      if (prompt.includes("do not edit files")) {
        await writeFile(
          join(workspace, "notes.js"),
          "export const notes = ['phase-a-edit']\n",
          "utf-8"
        )
      }
      if (prompt.includes("rememberedNote")) {
        await writeFile(
          join(workspace, "notes.js"),
          "export const rememberedNote = true\n",
          "utf-8"
        )
      }
      return successResult()
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    const result = artifact.results[0]!
    expect(result.success).toBe(true)
    expect(result.failureReason).toBeNull()
    expect(prompts).toEqual(["Add rememberedNote."])
    expect(result.phases).toHaveLength(1)
    expect(result.phases[0]?.phase).toBe("use")
    expect(result.phases[0]?.success).toBe(true)
    expect(result.phases[0]?.agentRun).not.toBeNull()
  })

  it("records expected context misses without failing full-loop success", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "status.js": "export function status() { return 'ok' }\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-expected-context-diagnostics
conditions:
  - lore-full-loop
scenarios:
  - id: formation-keyword-miss
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the status helper and remember anything useful.
    phaseB:
      prompt: Add completeStatus using whatever prior context is available.
    expectedContext:
      description: Status completion should be remembered.
      keywords: ["completeStatus"]
    verifiers:
      - type: file-contents-match
        path: status.js
        pattern: 'export\\s+function\\s+completeStatus'
  - id: wakeup-surface-miss
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the status helper and capture the completion convention.
    phaseB:
      prompt: Add readyStatus using whatever prior context is available.
    expectedContext:
      description: Status readiness should be remembered.
      keywords: ["readyStatus"]
    verifiers:
      - type: file-contents-match
        path: status.js
        pattern: 'export\\s+function\\s+readyStatus'
`,
    })

    const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
      if (prompt.includes("completeStatus")) {
        await writeFile(
          join(workspace, "status.js"),
          "export function status() { return 'ok' }\n" +
            "export function completeStatus() { return 'done' }\n",
          "utf-8"
        )
      }
      if (prompt.includes("readyStatus")) {
        await writeFile(
          join(workspace, "status.js"),
          "export function status() { return 'ok' }\n" +
            "export function readyStatus() { return 'ready' }\n",
          "utf-8"
        )
      }
      return successResult()
    })

    const loreAdapter: LongitudinalLoreAdapter = {
      async createRun({ scenario }) {
        return {
          projectId: "project-1",
          projectName: `Eval Sandbox/${scenario.id}`,
          async formContext() {
            return {
              projectId: "project-1",
              projectName: `Eval Sandbox/${scenario.id}`,
              mining: null,
              memoriesCreated: 1,
              factsCreated: 0,
              decisionsCreated: 0,
              tasksCreated: 0,
              createdContextIds: ["ctx-status"],
              expectedContextIds:
                scenario.id === "formation-keyword-miss" ? [] : ["ctx-status"],
            }
          },
          async loadContext() {
            return {
              renderedContext: "",
              surfacedContextIds: [],
              harmfulContextIds: [],
              failureMessage: null,
            }
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
    expect(artifact.summary.conditions["lore-full-loop"]).toMatchObject({
      trials: 2,
      passed: 2,
      failed: 0,
    })
    expect(artifact.results.map((result) => result.failureReason)).toEqual([null, null])
    const formationMiss = artifact.results.find(
      (result) => result.scenarioId === "formation-keyword-miss"
    )
    const wakeupMiss = artifact.results.find(
      (result) => result.scenarioId === "wakeup-surface-miss"
    )
    expect(formationMiss?.phases[0]?.lore.expectedContextIds).toEqual([])
    expect(wakeupMiss?.phases[0]?.lore.expectedContextIds).toEqual(["ctx-status"])
    expect(wakeupMiss?.phases[1]?.lore.surfacedContextIds).toEqual([])
  })

  it("stops longitudinal suites on the cost kill-switch and preserves partial results", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "README.md": "fixture\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-cost-kill
costKillSwitchUsd: 0.002
conditions:
  - no-memory
scenarios:
  - id: first-task
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the first task.
    phaseB:
      prompt: Finish the first task.
    verifiers:
      - type: file-exists
        path: first.txt
  - id: second-task
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the second task.
    phaseB:
      prompt: Finish the second task.
    verifiers:
      - type: file-exists
        path: second.txt
`,
    })

    const prompts: string[] = []
    const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
      prompts.push(prompt)
      if (prompt.includes("Finish the first task")) {
        await writeFile(join(workspace, "first.txt"), "done\n", "utf-8")
      }
      if (prompt.includes("Finish the second task")) {
        await writeFile(join(workspace, "second.txt"), "done\n", "utf-8")
      }
      return successResultWithUsage({
        promptTokens: 3000,
        cachedPromptTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
      })
    })

    const progressEvents: string[] = []
    const outPath = join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json")
    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath,
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      onProgress(event) {
        progressEvents.push(event.type)
      },
    })

    expect(prompts).toHaveLength(1)
    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(artifact.results).toHaveLength(1)
    expect(artifact.results[0]?.scenarioId).toBe("first-task")
    expect(artifact.termination).toMatchObject({
      reason: "cost-kill-switch",
      limitUsd: 0.002,
      completedTrials: 1,
      totalPlannedTrials: 2,
    })
    expect(artifact.termination?.observedUsd).toBeGreaterThanOrEqual(0.002)
    expect(progressEvents).toEqual(["trial-start", "trial-finish", "run-stop"])

    const persisted = JSON.parse(await readFile(outPath, "utf-8")) as typeof artifact
    expect(persisted.results).toHaveLength(1)
    expect(persisted.termination?.reason).toBe("cost-kill-switch")
  })

  it("stops longitudinal suites when cost is unknown under a kill-switch", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "README.md": "fixture\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-cost-unknown
costKillSwitchUsd: 10
conditions:
  - no-memory
scenarios:
  - id: first-task
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the first task.
    phaseB:
      prompt: Finish the first task.
    verifiers:
      - type: file-exists
        path: first.txt
  - id: second-task
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the second task.
    phaseB:
      prompt: Finish the second task.
    verifiers:
      - type: file-exists
        path: second.txt
`,
    })

    const prompts: string[] = []
    const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
      prompts.push(prompt)
      if (prompt.includes("Finish the first task")) {
        await writeFile(join(workspace, "first.txt"), "done\n", "utf-8")
      }
      return successResult()
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    expect(prompts).toHaveLength(1)
    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(artifact.results).toHaveLength(1)
    expect(artifact.termination).toMatchObject({
      reason: "cost-unknown",
      completedTrials: 1,
      totalPlannedTrials: 2,
    })
  })

  it("ignores Lore ledger rows when selected conditions do not include full-loop", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "lore-eval-cost-root-"))
    const ledgerPath = join(configRoot, "eval-costs.jsonl")
    await writeFile(
      join(configRoot, ".lore.yaml"),
      `vault:
  pageId: abc123
costTracking:
  enabled: true
  ledgerPath: ${JSON.stringify(ledgerPath)}
`,
      "utf-8"
    )
    const failedMiningCostRow = `${JSON.stringify({
      schemaVersion: 1,
      timestamp: "2026-05-27T00:00:01.000Z",
      eventType: "eval.mining.background_model",
      source: "cli",
      status: "error",
      payload: {
        redacted: true,
        tokenEstimator: "chars_per_token_4",
        inputBytes: 4,
        estimatedInputTokens: 1,
      },
      modelUsage: {
        provider: "openai",
        model: "gpt-5.5",
        inputTokens: 1,
        estimated: true,
        source: "prompt_estimate",
      },
      estimatedCost: {
        usd: 1,
        pricingSource: "test",
        estimated: true,
      },
    })}\n`
    const previousConfigRoot = process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
    process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"] = configRoot
    try {
      const { suitePath } = await writeTaskSuite({
        workspace: { "README.md": "fixture\n" },
        suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-lore-cost-error
costKillSwitchUsd: 0.5
conditions:
  - no-memory
scenarios:
  - id: first-task
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the first task.
    phaseB:
      prompt: Finish the first task.
    verifiers:
      - type: file-exists
        path: first.txt
  - id: second-task
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the second task.
    phaseB:
      prompt: Finish the second task.
    verifiers:
      - type: file-exists
        path: second.txt
`,
      })

      const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
        if (prompt.includes("Finish the first task")) {
          await writeFile(join(workspace, "first.txt"), "done\n", "utf-8")
          await writeFile(ledgerPath, failedMiningCostRow, "utf-8")
        }
        return successResultWithUsage({
          promptTokens: 0,
          cachedPromptTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        })
      })

      const { artifact } = await runTaskEvalSuite(suitePath, {
        now: new Date("2026-05-27T00:00:00.000Z"),
        outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
        adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      })

      if (!isLongitudinalTaskArtifact(artifact)) {
        throw new Error("expected longitudinal artifact")
      }
      expect(artifact.results).toHaveLength(2)
      expect(artifact.termination).toBeNull()
      expect(artifact.summary.conditions["no-memory"]).toMatchObject({
        trials: 2,
        passed: 1,
        failed: 1,
      })
    } finally {
      if (previousConfigRoot === undefined) {
        delete process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
      } else {
        process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"] = previousConfigRoot
      }
    }
  })

  it("requires a sandbox project prefix for full-loop cost kill-switch accounting", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "lore-eval-cost-root-"))
    const ledgerPath = join(configRoot, "eval-costs.jsonl")
    await writeFile(
      join(configRoot, ".lore.yaml"),
      `vault:
  pageId: abc123
costTracking:
  enabled: true
  ledgerPath: ${JSON.stringify(ledgerPath)}
`,
      "utf-8"
    )
    const previousConfigRoot = process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
    const previousSandbox = process.env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"]
    process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"] = configRoot
    delete process.env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"]
    try {
      const { suitePath } = await writeTaskSuite({
        workspace: { "README.md": "fixture\n" },
        suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-lore-cost-sandbox-required
costKillSwitchUsd: 10
conditions:
  - lore-full-loop
scenarios:
  - id: first-task
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the first task.
    phaseB:
      prompt: Finish the first task.
    expectedContext:
      description: First task context.
      keywords: ["first"]
    verifiers:
      - type: file-exists
        path: first.txt
`,
      })

      const prompts: string[] = []
      const adapter = mockAdapter("codex", async ({ prompt }) => {
        prompts.push(prompt)
        return successResult()
      })

      const { artifact } = await runTaskEvalSuite(suitePath, {
        now: new Date("2026-05-27T00:00:00.000Z"),
        outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
        adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      })

      if (!isLongitudinalTaskArtifact(artifact)) {
        throw new Error("expected longitudinal artifact")
      }
      expect(prompts).toEqual([])
      expect(artifact.results).toEqual([])
      expect(artifact.termination).toMatchObject({
        reason: "cost-unknown",
        completedTrials: 0,
        totalPlannedTrials: 1,
      })
      expect(artifact.termination?.message).toContain(
        "LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"
      )
    } finally {
      if (previousConfigRoot === undefined) {
        delete process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
      } else {
        process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"] = previousConfigRoot
      }
      if (previousSandbox === undefined) {
        delete process.env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"]
      } else {
        process.env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"] = previousSandbox
      }
    }
  })

  it("scopes full-loop Lore cost kill-switch accounting to the sandbox project", async () => {
    const configRoot = await mkdtemp(join(tmpdir(), "lore-eval-cost-root-"))
    const ledgerPath = join(configRoot, "eval-costs.jsonl")
    await writeFile(
      join(configRoot, ".lore.yaml"),
      `vault:
  pageId: abc123
costTracking:
  enabled: true
  ledgerPath: ${JSON.stringify(ledgerPath)}
`,
      "utf-8"
    )
    const miningCostRow = (projectName: string, usd: number) =>
      `${JSON.stringify({
        schemaVersion: 1,
        timestamp: "2026-05-27T00:00:01.000Z",
        eventType: "eval.mining.background_model",
        source: "cli",
        projectName,
        status: "success",
        payload: {
          redacted: true,
          tokenEstimator: "chars_per_token_4",
          inputBytes: 4,
          estimatedInputTokens: 1,
        },
        modelUsage: {
          provider: "openai",
          model: "gpt-5.5",
          inputTokens: 1,
          estimated: true,
          source: "prompt_estimate",
        },
        estimatedCost: {
          usd,
          pricingSource: "test",
          estimated: true,
        },
      })}\n`
    await writeFile(
      ledgerPath,
      miningCostRow("Other Sandbox/longitudinal-other", 100) +
        miningCostRow("Eval Sandbox/longitudinal-current", 0.25),
      "utf-8"
    )

    const previousConfigRoot = process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
    const previousSandbox = process.env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"]
    process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"] = configRoot
    process.env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"] = "Eval Sandbox"
    try {
      const { suitePath } = await writeTaskSuite({
        workspace: { "README.md": "fixture\n" },
        suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-lore-cost-sandbox-scope
costKillSwitchUsd: 0.5
conditions:
  - lore-full-loop
scenarios:
  - id: first-task
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect the first task.
    phaseB:
      prompt: Finish the first task.
    expectedContext:
      description: First task context.
      keywords: ["first"]
    verifiers:
      - type: file-exists
        path: first.txt
`,
      })

      const prompts: string[] = []
      const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
        prompts.push(prompt)
        if (prompt.includes("Retrieved Lore context")) {
          await writeFile(join(workspace, "first.txt"), "done\n", "utf-8")
        }
        return successResultWithUsage({
          promptTokens: 0,
          cachedPromptTokens: 0,
          outputTokens: 0,
          reasoningOutputTokens: 0,
        })
      })
      const loreAdapter: LongitudinalLoreAdapter = {
        async createRun() {
          return {
            projectId: "project-1",
            projectName: "Eval Sandbox/longitudinal-current",
            async formContext() {
              return {
                projectId: "project-1",
                projectName: "Eval Sandbox/longitudinal-current",
                mining: null,
                memoriesCreated: 1,
                factsCreated: 0,
                decisionsCreated: 0,
                tasksCreated: 0,
                createdContextIds: ["ctx-first"],
                expectedContextIds: ["ctx-first"],
              }
            },
            async loadContext() {
              return {
                renderedContext: "- [memory] ctx-first: Finish the first task.",
                surfacedContextIds: ["ctx-first"],
                harmfulContextIds: [],
                failureMessage: null,
              }
            },
            async cleanup() {},
          }
        },
      }

      const { artifact } = await runTaskEvalSuite(suitePath, {
        now: new Date("2026-05-27T00:00:00.000Z"),
        outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
        adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
        longitudinalLoreAdapter: loreAdapter,
      })

      if (!isLongitudinalTaskArtifact(artifact)) {
        throw new Error("expected longitudinal artifact")
      }
      expect(prompts).toHaveLength(2)
      expect(artifact.results).toHaveLength(1)
      expect(artifact.results[0]?.success).toBe(true)
      expect(artifact.termination).toBeNull()
    } finally {
      if (previousConfigRoot === undefined) {
        delete process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
      } else {
        process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"] = previousConfigRoot
      }
      if (previousSandbox === undefined) {
        delete process.env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"]
      } else {
        process.env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"] = previousSandbox
      }
    }
  })

  it("injects seeded context for seeded-lore longitudinal runs", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "cache.js": "export function cacheKey(name) { return name }\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-seeded
conditions:
  - no-memory
  - seeded-lore
scenarios:
  - id: seeded-cache-prefix
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Decide the cache prefix and preserve it for later.
    phaseB:
      prompt: Implement cacheKey using the remembered prefix.
    expectedContext:
      description: Cache keys use the gh-cli-pilot prefix.
      keywords: ["gh-cli-pilot:"]
    seededContext:
      renderedContext: "- [memory] ctx-cache: Cache keys use the exact prefix gh-cli-pilot:."
      contextIds: ["ctx-cache"]
    verifiers:
      - type: file-contents-match
        path: cache.js
        pattern: 'gh-cli-pilot:'
`,
    })

    const transcriptPaths: Array<string | undefined> = []
    const adapter = mockAdapter(
      "codex",
      async ({ prompt, workspace, transcriptPath }) => {
        transcriptPaths.push(transcriptPath)
        if (prompt.includes("Retrieved Lore context")) {
          await writeFile(
            join(workspace, "cache.js"),
            "export function cacheKey(name) { return `gh-cli-pilot:${name}` }\n",
            "utf-8"
          )
        }
        return successResult()
      }
    )

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
    })

    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(artifact.summary.conditions["no-memory"]).toMatchObject({
      trials: 1,
      passed: 0,
      failed: 1,
    })
    expect(artifact.summary.conditions["seeded-lore"]).toMatchObject({
      trials: 1,
      passed: 1,
      failed: 0,
    })
    expect(artifact.summary.lift).toMatchObject({
      toCondition: "seeded-lore",
      successRateDelta: 1,
      liftedScenarioIds: ["seeded-cache-prefix"],
    })
    const seeded = artifact.results.find((r) => r.condition === "seeded-lore")
    expect(seeded?.phases[0]?.lore.wakeUpEnabled).toBe(true)
    expect(seeded?.phases[0]?.lore.surfacedContextIds).toEqual(["ctx-cache"])
    expect(seeded?.phases[0]?.patch?.path.split(/[\\/]/u).pop()).toBe(
      "002-seeded-cache-prefix-seeded-lore-use.patch"
    )
    expect(await readFile(seeded?.phases[0]?.patch?.path ?? "", "utf-8")).toContain(
      "cache.js"
    )
    expect(transcriptPaths.map((p) => p?.split(/[\\/]/u).pop())).toEqual([
      "001-seeded-cache-prefix-no-memory-use.codex.jsonl",
      "002-seeded-cache-prefix-seeded-lore-use.codex.jsonl",
    ])
  })

  it("rejects custom transcript directories for longitudinal runs", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "status.js": "export const status = 'ok'\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-transcript-dir-guard
conditions:
  - no-memory
scenarios:
  - id: transcript-dir-guard
    difficulty: easy
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect status.
    phaseB:
      prompt: Write status.
    expectedContext:
      description: status stays ok.
      keywords: ["status"]
    verifiers:
      - type: file-contents-match
        path: status.js
        pattern: ok
`,
    })

    const adapter = mockAdapter("codex", async () => successResult())

    await expect(
      runTaskEvalSuite(suitePath, {
        outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
        transcriptsDir: join(
          await mkdtemp(join(tmpdir(), "lore-eval-transcripts-")),
          "custom"
        ),
        adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      })
    ).rejects.toThrow(/artifact-adjacent/)
  })

  it("filters longitudinal suites by difficulty and scenario id", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "status.js": "export function status() { return 'ok' }\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-filtered
conditions:
  - no-memory
scenarios:
  - id: easy-one
    difficulty: easy
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect easy one.
    phaseB:
      prompt: Finish easy one.
    verifiers:
      - type: file-exists
        path: easy-one.txt
  - id: hard-one
    difficulty: hard
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect hard one.
    phaseB:
      prompt: Finish hard one.
    verifiers:
      - type: file-exists
        path: hard-one.txt
`,
    })

    const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
      if (prompt.includes("hard one")) {
        await writeFile(join(workspace, "hard-one.txt"), "done\n", "utf-8")
      }
      return successResult()
    })

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      difficulty: "hard",
      scenarioIds: ["hard-one"],
    })

    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(artifact.results.map((result) => result.scenarioId)).toEqual(["hard-one"])
    expect(artifact.results[0]?.difficulty).toBe("hard")
    expect(artifact.summary.tasks).toBe(1)
  })

  it("samples longitudinal suites deterministically by difficulty", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "status.js": "export function status() { return 'ok' }\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-sampled
conditions:
  - no-memory
scenarios:
  - id: easy-one
    difficulty: easy
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect easy-one.
    phaseB:
      prompt: Finish easy-one.
    verifiers:
      - type: file-exists
        path: easy-one.txt
  - id: easy-two
    difficulty: easy
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect easy-two.
    phaseB:
      prompt: Finish easy-two.
    verifiers:
      - type: file-exists
        path: easy-two.txt
  - id: easy-three
    difficulty: easy
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect easy-three.
    phaseB:
      prompt: Finish easy-three.
    verifiers:
      - type: file-exists
        path: easy-three.txt
  - id: hard-one
    difficulty: hard
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect hard-one.
    phaseB:
      prompt: Finish hard-one.
    verifiers:
      - type: file-exists
        path: hard-one.txt
  - id: hard-two
    difficulty: hard
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect hard-two.
    phaseB:
      prompt: Finish hard-two.
    verifiers:
      - type: file-exists
        path: hard-two.txt
`,
    })

    const scenarioIds = ["easy-one", "easy-two", "easy-three", "hard-one", "hard-two"]
    const adapter = mockAdapter("codex", async ({ prompt, workspace }) => {
      const id = scenarioIds.find((candidate) => prompt.includes(candidate))
      if (id) await writeFile(join(workspace, `${id}.txt`), "done\n", "utf-8")
      return successResult()
    })
    const run = async () =>
      runTaskEvalSuite(suitePath, {
        outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
        adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
        sample: {
          seed: "seed-one",
          counts: { easy: 2, hard: 1 },
        },
      })

    const first = await run()
    const second = await run()
    if (!isLongitudinalTaskArtifact(first.artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    if (!isLongitudinalTaskArtifact(second.artifact)) {
      throw new Error("expected longitudinal artifact")
    }

    const selected = first.artifact.runner.sample?.selectedScenarioIds ?? []
    expect(first.artifact.runner.sample).toMatchObject({
      seed: "seed-one",
      requested: { easy: 2, hard: 1 },
    })
    expect(selected).toEqual(["easy-one", "hard-one", "easy-two"])
    expect(second.artifact.runner.sample?.selectedScenarioIds).toEqual(selected)
    expect(first.artifact.results.map((result) => result.scenarioId)).toEqual(selected)
    expect(first.artifact.summary.tasks).toBe(3)

    const differentSeed = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      sample: {
        seed: "seed-two",
        counts: { easy: 2, hard: 1 },
      },
    })
    if (!isLongitudinalTaskArtifact(differentSeed.artifact)) {
      throw new Error("expected longitudinal artifact")
    }
    expect(differentSeed.artifact.runner.sample?.selectedScenarioIds).toEqual([
      "hard-two",
      "easy-two",
      "easy-three",
    ])
  })

  it("rejects invalid programmatic longitudinal sample counts", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "status.js": "export function status() { return 'ok' }\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-invalid-sample
conditions:
  - no-memory
scenarios:
  - id: hard-one
    difficulty: hard
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect hard-one.
    phaseB:
      prompt: Finish hard-one.
    verifiers:
      - type: file-exists
        path: hard-one.txt
`,
    })

    await expect(
      runTaskEvalSuite(suitePath, {
        outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
        adapters: new Map<string, AgentAdapter>([
          ["codex", mockAdapter("codex", async () => successResult())],
        ]),
        sample: {
          seed: "seed-one",
          counts: { hard: 0 },
        },
      })
    ).rejects.toThrow("positive safe integer")
  })

  it("rejects injected adapters for parallel longitudinal child-process runs", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "status.js": "export function status() { return 'ok' }\n" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-parallel-rejects-injected-adapters
conditions:
  - no-memory
scenarios:
  - id: first
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect first.
    phaseB:
      prompt: Finish first.
    verifiers:
      - type: file-exists
        path: first.txt
  - id: second
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect second.
    phaseB:
      prompt: Finish second.
    verifiers:
      - type: file-exists
        path: second.txt
`,
    })

    await expect(
      runTaskEvalSuite(suitePath, {
        outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
        adapters: new Map<string, AgentAdapter>([
          ["codex", mockAdapter("codex", async () => successResult())],
        ]),
        parallelism: 2,
      })
    ).rejects.toThrow("child processes")
  })

  it("rejects incomplete longitudinal shard condition results", () => {
    expect(() =>
      assertLongitudinalShardResultsComplete({
        scenarioId: "first",
        results: [
          {
            scenarioId: "first",
            condition: "no-memory",
          } as never,
        ],
        expectedConditions: ["no-memory", "seeded-lore", "lore-full-loop"],
      })
    ).toThrow("missing=seeded-lore,lore-full-loop")
  })

  it("fills missing longitudinal shard condition results with harness-error rows", () => {
    const results = completeLongitudinalShardResults({
      scenario: {
        id: "first",
        difficulty: "hard",
        agent: "codex",
        timeoutMs: 300_000,
        workspace: {
          kind: "git",
          repo: "cli/cli",
          sha: "9a593ce81b593dee752cc11737d1a3ef768e52b3",
        },
        phaseA: { prompt: "Inspect first." },
        phaseB: { prompt: "Finish first." },
        expectedContext: {
          description: "Expected context",
          keywords: ["context"],
        },
        verifiers: [],
      } as never,
      results: [
        {
          scenarioId: "first",
          condition: "no-memory",
        } as never,
      ],
      expectedConditions: ["no-memory", "seeded-lore", "lore-full-loop"],
      harnessErrorMessage: "shard exited before writing all conditions",
    })

    expect(results.map((result) => result.condition)).toEqual([
      "no-memory",
      "seeded-lore",
      "lore-full-loop",
    ])
    expect(results.slice(1).map((result) => result.failureReason)).toEqual([
      "harness-error",
      "harness-error",
    ])
    expect(results[1]?.phases[0]?.failureMessage).toContain("shard exited")
  })

  it("keeps completed late shard rows after a cost stop but drops killed placeholders", () => {
    const completed = {
      scenarioId: "first",
      condition: "no-memory",
      failureReason: null,
      phases: [],
    } as never
    const killedPlaceholder = {
      scenarioId: "first",
      condition: "seeded-lore",
      failureReason: "harness-error",
      agentRun: null,
      verifiers: [],
      phases: [
        {
          agentRun: null,
          cost: null,
          patch: null,
          verifierResults: [],
          failureReason: "harness-error",
          failureMessage:
            "Longitudinal shard first returned an incomplete artifact (exit signal).",
        },
      ],
    } as never

    expect(
      filterShardResultsForTerminatedRun([completed, killedPlaceholder], {
        reason: "cost-kill-switch",
      } as never)
    ).toEqual([completed])
    expect(filterShardResultsForTerminatedRun([killedPlaceholder], null)).toEqual([
      killedPlaceholder,
    ])
  })

  it("requires every selected longitudinal condition before a task counts as passed", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "done.txt": "" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-partial-cost-stop
conditions:
  - no-memory
  - seeded-lore
scenarios:
  - id: partial
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect partial.
    phaseB:
      prompt: Finish partial.
    expectedContext:
      keywords: ["partial"]
    seededContext:
      renderedContext: "- [memory] ctx-partial: partial"
      contextIds: ["ctx-partial"]
    verifiers:
      - type: file-exists
        path: done.txt
`,
    })

    const adapter = mockAdapter("codex", async () =>
      successResultWithUsage({
        promptTokens: 1_000_000,
        cachedPromptTokens: 0,
        outputTokens: 1_000,
        reasoningOutputTokens: 0,
      })
    )

    const { artifact } = await runTaskEvalSuite(suitePath, {
      outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
      adapters: new Map<string, AgentAdapter>([["codex", adapter]]),
      costKillSwitchUsd: 0.0001,
    })
    if (!isLongitudinalTaskArtifact(artifact)) {
      throw new Error("expected longitudinal artifact")
    }

    expect(artifact.results).toHaveLength(1)
    expect(artifact.results[0]?.success).toBe(true)
    expect(artifact.termination?.reason).toBe("cost-kill-switch")
    expect(artifact.summary.passedTrials).toBe(1)
    expect(artifact.summary.passedTasks).toBe(0)
    expect(artifact.summary.failedTasks).toBe(1)
  })

  it("does not require Lore cost config when full-loop is not selected", async () => {
    const { suitePath } = await writeTaskSuite({
      workspace: { "done.txt": "" },
      suite: `version: 1
runner: task
longitudinal: true
name: longitudinal-cost-config-missing
conditions:
  - no-memory
scenarios:
  - id: cost-config-missing
    agent: codex
    workspace: ../workspaces/x
    phaseA:
      prompt: Inspect cost.
    phaseB:
      prompt: Finish cost.
    verifiers:
      - type: file-exists
        path: done.txt
`,
    })

    const prior = process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
    process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"] = await mkdtemp(
      join(tmpdir(), "lore-eval-missing-config-")
    )
    try {
      const { artifact } = await runTaskEvalSuite(suitePath, {
        outPath: join(await mkdtemp(join(tmpdir(), "lore-eval-task-")), "out.json"),
        adapters: new Map<string, AgentAdapter>([
          [
            "codex",
            mockAdapter("codex", async () =>
              successResultWithUsage({
                promptTokens: 1,
                cachedPromptTokens: 0,
                outputTokens: 1,
                reasoningOutputTokens: 0,
              })
            ),
          ],
        ]),
        costKillSwitchUsd: 1,
      })
      if (!isLongitudinalTaskArtifact(artifact)) {
        throw new Error("expected longitudinal artifact")
      }

      expect(artifact.results).toHaveLength(1)
      expect(artifact.results[0]?.success).toBe(true)
      expect(artifact.termination).toBeNull()
    } finally {
      if (prior === undefined) delete process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
      else process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"] = prior
    }
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
                expect(codexConfig).toContain('default_tools_approval_mode = "approve"')
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
    expect(artifact.results[0]!.phases[1]?.failureMessage).toContain("Skipped Phase B")
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
    expect(artifact.results[0]!.phases[1]?.failureMessage).toContain("formation refused")
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
          verifiers: [{ type: "file-contents-match", path: "x", pattern: "[" }],
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
    const { artifact } = await runTaskEvalSuite("evals/task-suites/starter.yaml", {
      adapters: new Map<string, AgentAdapter>([["codex", noopAdapter]]),
    })

    const targetTaskIds = new Set([
      "fix-broken-import-path",
      "returns-result-from-service-boundary",
    ])
    const targetTrials = artifact.results.filter((r) => targetTaskIds.has(r.taskId))
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
        (v) => v.verifier.type === "file-contents-match" && v.verifier.mode !== "forbid"
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
    const { artifact } = await runTaskEvalSuite("evals/task-suites/starter.yaml", {
      adapters: new Map<string, AgentAdapter>([["codex", fixingAdapter]]),
    })

    const fixTrials = artifact.results.filter(
      (r) => r.taskId === "fix-broken-import-path"
    )
    expect(fixTrials.length).toBeGreaterThan(0)
    for (const trial of fixTrials) {
      expect({
        taskId: trial.taskId,
        condition: trial.memoryCondition,
        success: trial.success,
        failed: trial.verifiers.filter((v) => !v.passed).map((v) => v.message),
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
    const { artifact } = await runTaskEvalSuite("evals/task-suites/starter.yaml", {
      adapters: new Map<string, AgentAdapter>([["codex", deletingAdapter]]),
    })

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
      { codexHome: "/tmp/lore-eval-codex-home-test" }
    )
    expect(env["PATH"]).toBe("/usr/bin")
    expect(env["HOME"]).toBe("/tmp/lore-eval-codex-home-test")
    expect(env["CODEX_HOME"]).toBe("/tmp/lore-eval-codex-home-test")
    expect(env["GOMODCACHE"]).toContain("lore-eval-go-mod-cache")
    expect(env["GOCACHE"]).toContain("lore-eval-go-build-cache")
  })

  it("strips mise shims when HOME is isolated for eval subprocesses", () => {
    const env = buildCodexChildEnv(
      {
        PATH: [
          "/Users/example/.local/share/mise/shims",
          "/opt/mise/shims/",
          "/usr/local/bin",
          "/custom/other-shims",
          "/usr/bin",
        ].join(delimiter),
        HOME: "/Users/example",
      },
      { codexHome: "/tmp/lore-eval-codex-home-test" }
    )

    expect(env["PATH"]).toBe(
      ["/usr/local/bin", "/custom/other-shims", "/usr/bin"].join(delimiter)
    )
  })

  it("resolves codex from a non-mise PATH entry for isolated eval subprocesses", async () => {
    const root = await mkdtemp(join(tmpdir(), "lore-codex-path-test-"))
    try {
      const shimDir = join(root, "mise", "shims")
      const binDir = join(root, "bin")
      await mkdir(shimDir, { recursive: true })
      await mkdir(binDir)
      const shimCodexPath = join(shimDir, "codex")
      const codexPath = join(binDir, "codex")
      await writeFile(shimCodexPath, "#!/bin/sh\nexit 1\n")
      await chmod(shimCodexPath, 0o755)
      await writeFile(codexPath, "#!/bin/sh\nexit 0\n")
      await chmod(codexPath, 0o755)

      const pathValue = [shimDir, binDir].join(delimiter)
      expect(resolveExecutableOnPath("codex", pathValue)).toBe(shimCodexPath)
      expect(resolveCodexExecutable({ PATH: pathValue })).toBe(codexPath)
      const env = buildCodexChildEnv(
        {
          PATH: pathValue,
          HOME: "/Users/example",
        },
        { codexHome: "/tmp/lore-eval-codex-home-test" }
      )
      expect(env["PATH"]).toBe(binDir)
      expect(resolveCodexExecutable({ PATH: shimDir })).toBeNull()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("preserves explicit Go cache paths for eval subprocesses", () => {
    const env = buildCodexChildEnv(
      {
        HOME: "/Users/example",
        GOMODCACHE: "/tmp/custom-mod-cache",
        GOCACHE: "/tmp/custom-build-cache",
      },
      { codexHome: "/tmp/lore-eval-codex-home-test" }
    )

    expect(env["GOMODCACHE"]).toBe("/tmp/custom-mod-cache")
    expect(env["GOCACHE"]).toBe("/tmp/custom-build-cache")
  })
})

describe("createIsolatedCodexHome", () => {
  it("reads only the top-level Codex model setting", () => {
    expect(
      parseCodexConfigModel(
        [
          "# comment",
          'model = "gpt-5.5"',
          "",
          "[profiles.other]",
          'model = "gpt-4o"',
        ].join("\n")
      )
    ).toBe("gpt-5.5")
  })

  it("copies auth and top-level model settings without global MCP or memories", async () => {
    const sourceHome = await mkdtemp(join(tmpdir(), "lore-codex-source-home-"))
    const isolatedHomes: string[] = []
    try {
      await mkdir(join(sourceHome, "memories"), { recursive: true })
      await writeFile(
        join(sourceHome, "auth.json"),
        '{"OPENAI_API_KEY":"sk-test-sentinel"}\n',
        "utf-8"
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
        "utf-8"
      )

      const codexHome = await createIsolatedCodexHome({ CODEX_HOME: sourceHome })
      isolatedHomes.push(codexHome)

      expect(await readFile(join(codexHome, "auth.json"), "utf-8")).toBe(
        '{"OPENAI_API_KEY":"sk-test-sentinel"}\n'
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
        "utf-8"
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

function goPackageDirsForFileVerifiers(
  verifiers: Array<{ type: string; path?: string; paths?: string[] }>
): string[] {
  const dirs = new Set<string>()
  for (const verifier of verifiers) {
    if (verifier.type === "file-contents-match") {
      if (verifier.path !== undefined && verifier.path.endsWith(".go")) {
        dirs.add(posix.dirname(verifier.path))
      }
    }
    if (verifier.type === "any-file-contents-match") {
      for (const path of verifier.paths ?? []) {
        if (path.endsWith(".go")) dirs.add(posix.dirname(path))
      }
    }
  }
  return [...dirs]
}

function goTestArgsCoverPackage(args: string[], packageDir: string): boolean {
  for (const arg of args.slice(1)) {
    if (!arg.startsWith("./")) continue
    const packagePattern = arg.slice(2)
    if (packagePattern.endsWith("/...")) {
      const base = packagePattern.slice(0, -4)
      if (packageDir === base || packageDir.startsWith(`${base}/`)) return true
      continue
    }
    if (packageDir === packagePattern) return true
  }
  return false
}

function countByDifficulty(
  scenarios: Array<{ difficulty?: "easy" | "medium" | "hard" }>
): Record<"easy" | "medium" | "hard", number> {
  return {
    easy: scenarios.filter((scenario) => scenario.difficulty === "easy").length,
    medium: scenarios.filter((scenario) => scenario.difficulty === "medium").length,
    hard: scenarios.filter((scenario) => scenario.difficulty === "hard").length,
  }
}

const POWERED_SCENARIOS_WITH_PROMPT_SAFE_TEST_NAME_OMISSION = new Set([
  "gh-cli-variable-ambiguous-remote-scope",
  "gh-cli-api-graphql-paginate-field",
  "gh-cli-skills-install-transactional-lockfile",
  "gh-cli-pr-status-head-repo-disambiguation",
  "gh-cli-release-create-generated-notes-target-rollback",
  "gh-cli-agent-task-create-wait-exit-status",
])

function poweredScenarioTestName(scenarioId: string): string {
  return `Test${scenarioId
    .split("-")
    .filter((part) => part !== "gh" && part !== "cli")
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join("")}`
}

function verifiersIncludeTestName(
  verifiers: Array<{ type: string; path?: string; paths?: string[]; pattern?: string }>,
  testName: string
): boolean {
  return verifiers.some((verifier) => {
    if (verifier.pattern !== testName) return false
    if (verifier.type === "file-contents-match") {
      return verifier.path?.endsWith("_test.go") ?? false
    }
    if (verifier.type === "any-file-contents-match") {
      return verifier.paths?.some((path) => path.endsWith("_test.go")) ?? false
    }
    return false
  })
}

describe("selectExpectedContextIds", () => {
  it("uses Codex for longitudinal mining when the evaluated scenario agent is Codex", async () => {
    const agent = await longitudinalMiningAgentForScenario(
      {
        id: "mining-agent",
        agent: "codex",
        workspace: "../w/x",
        phaseA: { prompt: "learn" },
        phaseB: { prompt: "use" },
        expectedContext: { description: "", keywords: [], harmfulKeywords: [] },
        verifiers: [{ type: "file-exists", path: "x" }],
        timeoutMs: 300_000,
      },
      { model: "gpt-5.5" }
    )

    expect(agent.command).toBe("codex")
    expect(agent.args).toContain("gpt-5.5")
  })

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
      ]
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
      ]
    )

    expect(ids).toEqual([])
  })
})

function expectPatchHunksToMatchLineCounts(patch: string, label: string): void {
  const lines = patch.split("\n")
  for (let index = 0; index < lines.length; index += 1) {
    const header = lines[index]
    if (!header.startsWith("@@ ")) continue
    const match = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(header)
    expect(match, `${label}: malformed patch hunk header ${header}`).not.toBeNull()
    const expectedOld = match?.[1] === undefined ? 1 : Number(match[1])
    const expectedNew = match?.[2] === undefined ? 1 : Number(match[2])
    let actualOld = 0
    let actualNew = 0
    for (index += 1; index < lines.length; index += 1) {
      const line = lines[index]
      if (index === lines.length - 1 && line === "") continue
      if (line.startsWith("@@ ")) {
        index -= 1
        break
      }
      if (line.startsWith("\\ No newline")) continue
      if (line.startsWith("+")) {
        actualNew += 1
      } else if (line.startsWith("-")) {
        actualOld += 1
      } else {
        actualOld += 1
        actualNew += 1
      }
    }
    expect(
      { old: actualOld, new: actualNew },
      `${label}: patch hunk ${header} line count mismatch`
    ).toEqual({ old: expectedOld, new: expectedNew })
  }
}

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

function successResultWithUsage(
  usage: NonNullable<AgentRunResult["usage"]>
): AgentRunResult {
  return { ...successResult(), usage: { provider: "openai", model: "gpt-5", ...usage } }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim()
}

describe("bench spawn argv carries NO secrets", () => {
  it("buildTaskSpawnArgs enables JSONL transcripts without writing the final message into the workspace", () => {
    const args = buildTaskSpawnArgs({
      workspace: "/tmp/workspace",
      prompt: "Do the task",
      lastMessagePath: "/tmp/codex-home/last-message.txt",
    })

    expect(args).toEqual([
      "exec",
      "--json",
      "--output-last-message",
      "/tmp/codex-home/last-message.txt",
      "--cd",
      "/tmp/workspace",
      "--sandbox",
      "workspace-write",
      "--skip-git-repo-check",
      "Do the task",
    ])
  })

  it("buildBenchSpawnArgs does not contain bearer-shaped substrings", () => {
    // Invariant: bench Notion auth is routed outside argv. The spawn
    // argv carries ZERO bearer-shaped values or `-c mcp_servers.lore.*`
    // overrides. Any future refactor that re-introduces auth in argv
    // would fail this test loudly.
    //
    // The assertion uses sentinel bearer-shaped tokens that the
    // operator's real env may or may not contain. They flow through
    // process.env in the test's setup; `buildBenchSpawnArgs` ignores
    // env entirely (the workspace path and prompt are its only inputs)
    // so the assertion is structural, not env-dependent.
    process.env["LORE_BENCH_NOTION_TOKEN"] =
      "ntn_SENTINEL_BENCH_TOKEN_MUST_NEVER_REACH_ARGV"
    process.env["NOTION_API_TOKEN"] = "ntn_OPERATOR_DAY_TO_DAY_MUST_NEVER_REACH_ARGV"
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
      expect(joined).toContain("-c sandbox_workspace_write.network_access=true")
      expect(joined).toContain(
        `-c shell_environment_policy.exclude=${JSON.stringify([...BENCH_SHELL_ENV_EXCLUDES])}`
      )
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
    // NOT carry the Notion bearer. Bench auth is routed by the runner,
    // not from Codex's parent env. Clearing Notion-shaped keys from
    // the Codex parent env is defense-in-depth so a future Codex
    // env-passthrough behavior change cannot accidentally route the
    // wrong token into the child.
    const parent: NodeJS.ProcessEnv = {
      PATH: "/usr/bin",
      HOME: "/tmp/home",
      CODEX_HOME: "/tmp/home/.codex",
      CODEX_TRACE: "1",
      OPENAI_API_KEY: "sk-operator-day-to-day",
      LORE_BENCH_OPENAI_API_KEY: "sk-bench-only",
      NOTION_API_TOKEN: "ntn_OPERATOR_DAY_TO_DAY_TOKEN_MUST_NOT_LEAK",
      NOTION_DEV_PAT: "development_ntn_OPERATOR_DEV_PAT_MUST_NOT_LEAK",
      LORE_BENCH_NOTION_TOKEN: "ntn_BENCH_TOKEN_ALSO_NOT_FORWARDED_VIA_ENV",
      GITHUB_TOKEN: "ghp_must_not_leak",
      ANTHROPIC_API_KEY: "sk-ant-must-not-leak",
    }
    const childEnv = buildBenchCodexChildEnv(parent)
    // OPENAI_API_KEY is sourced from LORE_BENCH_OPENAI_API_KEY, not
    // the operator's day-to-day value.
    expect(childEnv["OPENAI_API_KEY"]).toBe("sk-bench-only")
    // Every Notion-bearer-shaped key must be absent from the child
    // env partition. Bench auth is routed by the runner, not from
    // env inheritance — the Codex parent env carries nothing
    // Notion-shaped.
    expect(childEnv["NOTION_API_TOKEN"]).toBeUndefined()
    expect(childEnv["NOTION_DEV_PAT"]).toBeUndefined()
    expect(childEnv["LORE_BENCH_NOTION_TOKEN"]).toBeUndefined()
    expect(childEnv["GITHUB_TOKEN"]).toBeUndefined()
    expect(childEnv["ANTHROPIC_API_KEY"]).toBeUndefined()
    expect(childEnv["HOME"]).toBeUndefined()
    expect(childEnv["CODEX_HOME"]).toBeUndefined()
    expect(childEnv["CODEX_TRACE"]).toBeUndefined()
    // No bearer-shaped substring appears anywhere in the child env
    // (defense-in-depth against a future allowlist that admits the
    // wrong key).
    const joined = JSON.stringify(childEnv)
    expect(joined).not.toMatch(/ntn_OPERATOR/)
    expect(joined).not.toMatch(/development_ntn_OPERATOR/)
    expect(joined).not.toMatch(/ntn_BENCH/)
    expect(joined).not.toMatch(/ghp_/)
    expect(joined).not.toMatch(/sk-ant/)
  })

  it("pins bench HOME and CODEX_HOME to an isolated config home", () => {
    const childEnv = buildBenchCodexChildEnv(
      {
        PATH: [
          "/Users/example/.local/share/mise/shims",
          "/opt/mise/shims/",
          "/usr/bin",
        ].join(delimiter),
        HOME: "/Users/example",
        CODEX_HOME: "/Users/example/.codex",
        CODEX_TRACE: "1",
        LORE_BENCH_OPENAI_API_KEY: "sk-bench-only",
      },
      {
        extraEnv: {
          HOME: "/tmp/attacker-home",
          CODEX_HOME: "/tmp/attacker-codex-home",
        },
        codexHome: "/tmp/lore-eval-codex-home-bench",
      }
    )

    expect(childEnv["HOME"]).toBe("/tmp/lore-eval-codex-home-bench")
    expect(childEnv["CODEX_HOME"]).toBe("/tmp/lore-eval-codex-home-bench")
    expect(childEnv["PATH"]).toBe("/usr/bin")
    expect(childEnv["CODEX_TRACE"]).toBeUndefined()
    expect(childEnv["OPENAI_API_KEY"]).toBe("sk-bench-only")
  })

  it("exposes bench tool shims only when the workspace opted into them", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "lore-bench-env-test-"))
    try {
      const withoutShims = buildBenchCodexChildEnv(
        { PATH: "/usr/bin", LORE_BENCH_OPENAI_API_KEY: "sk-bench-only" },
        { workspace }
      )
      expect(withoutShims["PATH"]).toBe("/usr/bin")
      expect(withoutShims["LORE_BENCH_TOOL_NODE"]).toBeUndefined()
      expect(withoutShims["LORE_BENCH_TOOL_CLI_JS"]).toBeUndefined()

      await mkdir(join(workspace, BENCH_TOOL_SHIM_DIR))
      const withShims = buildBenchCodexChildEnv(
        { PATH: "/usr/bin", LORE_BENCH_OPENAI_API_KEY: "sk-bench-only" },
        { workspace }
      )
      expect(withShims["PATH"]?.split(delimiter)[0]).toBe(
        join(workspace, BENCH_TOOL_SHIM_DIR)
      )
      expect(withShims["LORE_BENCH_TOOL_NODE"]).toBe(process.execPath)
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it("BENCH_CHILD_CLEARED_ENV_KEYS lists every Notion-bearer key", () => {
    // Regression guard: if a future contributor adds a new bearer
    // key without listing it here, this test fails. The set must
    // include canonical Notion auth plus any other operator-day-to-day
    // secrets the bench needs to clear.
    expect(BENCH_CHILD_CLEARED_ENV_KEYS).toContain("NOTION_API_TOKEN")
    expect(BENCH_CHILD_CLEARED_ENV_KEYS).toContain("NOTION_DEV_PAT")
    expect(BENCH_CHILD_CLEARED_ENV_KEYS).toContain("GITHUB_TOKEN")
    expect(BENCH_CHILD_CLEARED_ENV_KEYS).toContain("ANTHROPIC_API_KEY")
  })
})
