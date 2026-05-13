/**
 * End-to-end task-eval runner — the agent-execution half of the eval
 * spec, gated by deterministic verifiers. Distinct from the retrieval
 * runner: where retrieval mode scores which memories surface, task mode
 * scores whether an agent actually produced the desired workspace state
 * after the run. Layout:
 *
 * - `TaskEvalSuite`: a separate YAML file format from retrieval suites.
 *   Each task names a workspace fixture, a prompt, an agent, a memory-
 *   condition matrix, and a list of verifiers.
 * - `AgentAdapter`: pluggable interface. `CodexAgentAdapter` shells out
 *   to `codex exec --cd <workspace> --sandbox workspace-write`; tests
 *   inject a mock adapter directly.
 * - `Verifier`: pluggable interface. The shipped verifiers cover file
 *   existence, regex match (with optional forbid mode), and exact
 *   file-unchanged checks against the workspace fixture.
 *
 * The runner copies the workspace fixture into a tmp directory, seeds
 * the chosen memory condition's fixture file, hands the workspace to
 * the agent, executes verifiers against the post-run state, and cleans
 * the tmp directory. Workspace fixtures stay read-only on disk so a
 * concurrent run cannot corrupt them.
 *
 * Production safety:
 * - Real Codex invocation is gated behind `LORE_EVAL_TASK_REAL=1`. The
 *   default `CodexAgentAdapter.run` refuses to spawn without that env
 *   var, so a misconfigured CI job cannot rack up unbounded model
 *   spend.
 * - Codex spawns inherit a scrubbed env (only `PATH` / `HOME` / `TZ` /
 *   `LANG` / `LC_*` / `CODEX_*` / `OPENAI_API_KEY` are forwarded);
 *   `NOTION_API_TOKEN`, `LORE_NOTION_TOKEN`, `GITHUB_TOKEN` and
 *   anything else stays out of the child env and the artifact.
 * - The Codex child runs in a detached process group; timeout
 *   cancellation kills `-pgid` so subprocesses Codex spawned (test
 *   watchers, dev servers, package installs) terminate too.
 */
import {
  cp,
  readFile,
  rm,
  stat,
  writeFile,
  mkdir,
  mkdtemp,
} from "node:fs/promises"
import { join, dirname, resolve, relative } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import { performance } from "node:perf_hooks"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import {
  TASK_EVAL_AGENTS,
  TASK_EVAL_MEMORY_CONDITIONS,
  TASK_EVAL_SUITE_VERSION,
  type TaskEvalMemoryCondition,
} from "./schema.js"

const verifierSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("file-exists"),
      path: z.string().min(1),
    })
    .strict(),
  z
    .object({
      type: z.literal("file-contents-match"),
      path: z.string().min(1),
      pattern: z
        .string()
        .min(1)
        // Reject malformed regexes at parse time so the runner never
        // throws SyntaxError mid-trial. Synthesizing a per-verifier
        // failure inside `runVerifier` would still leave the rest of
        // the suite running on the bad pattern; failing fast at parse
        // time matches every other lore validation discipline.
        .refine((p) => {
          try {
            new RegExp(p)
            return true
          } catch {
            return false
          }
        }, "must be a valid JavaScript regex"),
      mode: z.enum(["match", "forbid"]).default("match"),
    })
    .strict(),
  z
    .object({
      // Asserts the workspace file is byte-identical to the source
      // fixture. Used to pin "the agent must not modify this file"
      // contracts that the prompt declares but the agent could
      // otherwise violate without tripping a content-match verifier.
      type: z.literal("file-unchanged"),
      path: z.string().min(1),
    })
    .strict(),
])

const memoryConditionSchema = z.enum(TASK_EVAL_MEMORY_CONDITIONS)

const taskEvalTaskSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    prompt: z.string().min(1),
    agent: z.enum(TASK_EVAL_AGENTS).default("codex"),
    workspace: z.string().min(1),
    /**
     * Map from memory condition (`no-lore`, `helpful`, `noisy`,
     * `stale`) to a fixture path. Each condition listed here runs
     * the task once with that condition's fixture seeded into the
     * workspace's .lore-memories.json. Empty matrix means the task
     * runs once with no memory seeded — the agent's tools see whatever
     * the workspace fixture itself includes (typically nothing).
     */
    memoryConditions: z
      .record(memoryConditionSchema, z.string().min(1))
      .default({}),
    verifiers: z.array(verifierSchema).min(1),
    /** Per-task timeout cap on the agent invocation, in milliseconds. */
    timeoutMs: z.number().int().positive().default(300_000),
  })
  .strict()

export const taskEvalSuiteSchema = z
  .object({
    version: z.literal(TASK_EVAL_SUITE_VERSION),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    description: z.string().default(""),
    tasks: z.array(taskEvalTaskSchema).min(1),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const seen = new Set<string>()
    for (let i = 0; i < suite.tasks.length; i++) {
      const id = suite.tasks[i]!.id
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["tasks", i, "id"],
          message: `duplicate task id "${id}"; ids must be unique within a suite`,
        })
      }
      seen.add(id)
    }
  })

export type TaskEvalVerifier = z.infer<typeof verifierSchema>
export type TaskEvalTask = z.infer<typeof taskEvalTaskSchema>
export type TaskEvalSuite = z.infer<typeof taskEvalSuiteSchema>

export interface AgentRunInput {
  prompt: string
  workspace: string
  timeoutMs: number
}

export interface AgentRunResult {
  exitCode: number
  stdout: string
  stderr: string
  /** True when the run was forcibly terminated by the timeout. */
  timedOut: boolean
  /**
   * Set by an adapter that declined to invoke the underlying agent
   * (e.g., `CodexAgentAdapter` refusing without `LORE_EVAL_TASK_REAL=1`).
   * The runner reads this directly to set `failureReason: "adapter-refused"`,
   * so future adapters (Claude headless, etc.) get the same refusal
   * semantics without keying off a Codex-specific stderr substring.
   * Default false on all paths that actually invoked the agent.
   */
  refused?: boolean
}

/**
 * Adapter id is broadened to plain `string` (not `TaskEvalAgent`) so
 * tests can inject a mock adapter under any id without widening the
 * production agent enum. The runner consults `task.agent` (validated
 * against `TaskEvalAgent`) and looks up an adapter by that string in
 * the `adapters` map; a matching mock entry under id `"mock"` works in
 * tests because tests build their own `adapters` map.
 */
export interface AgentAdapter {
  readonly id: string
  run(input: AgentRunInput): Promise<AgentRunResult>
}

export interface VerifierResult {
  verifier: TaskEvalVerifier
  passed: boolean
  message: string
}

/**
 * Discriminator for failed trials so artifact consumers don't have to
 * re-derive the disambiguation between adapter refusal, timeouts,
 * spawn errors, agent-exit failure, and verifier failure. `null` on
 * successful trials.
 */
export type TaskFailureReason =
  | "adapter-refused"
  | "timeout"
  | "spawn-error"
  | "agent-exit"
  | "verifiers"

export interface TaskEvalResult {
  taskId: string
  agent: string
  /** Memory condition this trial was run under, or null when the task has no matrix. */
  memoryCondition: TaskEvalMemoryCondition | null
  workspaceSource: string
  /** Tmp workspace path during the run; null after cleanup. */
  workspace: string | null
  success: boolean
  /** Disambiguates the failure mode; null on success. */
  failureReason: TaskFailureReason | null
  agentRun: AgentRunResult
  verifiers: VerifierResult[]
  metrics: {
    elapsedMs: number
  }
}

export interface TaskEvalArtifact {
  suite: string
  description: string
  startedAt: string
  runner: { mode: "task" }
  results: TaskEvalResult[]
  summary: {
    tasks: number
    passedTasks: number
    failedTasks: number
    /** Trials = tasks × matrix-size; matches `results.length`. */
    totalTrials: number
    passedTrials: number
    failedTrials: number
  }
}

export interface RunTaskEvalOptions {
  outPath?: string
  now?: Date
  /**
   * Map of agent id → adapter. The runner looks up `task.agent` in this
   * map. Defaults inject the `codex` adapter; tests inject the `mock`
   * adapter so they don't shell out to a real model.
   */
  adapters?: Map<string, AgentAdapter>
  /**
   * Skip workspace-tmpdir cleanup. Useful for debugging — operators
   * who want to inspect the post-run workspace state pass `true`.
   * Defaults to `false`; the runner removes every tmp workspace it
   * creates to avoid filling the disk with model-generated content.
   */
  keepWorkspaces?: boolean
}

export async function loadTaskEvalSuite(path: string): Promise<{
  suite: TaskEvalSuite
  root: string
  path: string
}> {
  const absolute = resolve(path)
  const raw = await readFile(absolute, "utf-8")
  const parsed = parseYaml(raw) as unknown
  const suite = taskEvalSuiteSchema.parse(parsed)
  return { suite, root: dirname(absolute), path: absolute }
}

export async function runTaskEvalSuite(
  suitePath: string,
  options: RunTaskEvalOptions = {}
): Promise<{ artifact: TaskEvalArtifact; outPath: string }> {
  const loaded = await loadTaskEvalSuite(suitePath)
  const adapters = options.adapters ?? defaultAdapters()
  const startedAt = (options.now ?? new Date()).toISOString()

  const results: TaskEvalResult[] = []
  for (const task of loaded.suite.tasks) {
    const conditions = Object.entries(task.memoryConditions) as Array<
      [TaskEvalMemoryCondition, string]
    >
    if (conditions.length === 0) {
      results.push(
        await runTaskEvalTrial({
          task,
          condition: null,
          conditionFixture: null,
          suiteRoot: loaded.root,
          adapters,
          keepWorkspaces: options.keepWorkspaces ?? false,
        })
      )
      continue
    }
    for (const [condition, fixturePath] of conditions) {
      results.push(
        await runTaskEvalTrial({
          task,
          condition,
          conditionFixture: fixturePath,
          suiteRoot: loaded.root,
          adapters,
          keepWorkspaces: options.keepWorkspaces ?? false,
        })
      )
    }
  }

  const passedTrials = results.filter((r) => r.success).length
  const taskIds = new Set(results.map((r) => r.taskId))
  const passedTasks = countTasksAllPassed(results)
  const artifact: TaskEvalArtifact = {
    suite: loaded.suite.name,
    description: loaded.suite.description,
    startedAt,
    runner: { mode: "task" },
    results,
    summary: {
      tasks: taskIds.size,
      passedTasks,
      failedTasks: taskIds.size - passedTasks,
      totalTrials: results.length,
      passedTrials,
      failedTrials: results.length - passedTrials,
    },
  }

  const outPath = resolve(
    options.outPath ?? defaultArtifactPath(loaded.suite.name, startedAt)
  )
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")
  return { artifact, outPath }
}

function countTasksAllPassed(results: TaskEvalResult[]): number {
  const successByTask = new Map<string, boolean>()
  for (const result of results) {
    const prior = successByTask.get(result.taskId)
    successByTask.set(result.taskId, (prior ?? true) && result.success)
  }
  let passed = 0
  for (const value of successByTask.values()) if (value) passed++
  return passed
}

async function runTaskEvalTrial(input: {
  task: TaskEvalTask
  condition: TaskEvalMemoryCondition | null
  conditionFixture: string | null
  suiteRoot: string
  adapters: Map<string, AgentAdapter>
  keepWorkspaces: boolean
}): Promise<TaskEvalResult> {
  const adapter = input.adapters.get(input.task.agent)
  if (!adapter) {
    throw new Error(
      `No adapter registered for agent "${input.task.agent}"; pass one via RunTaskEvalOptions.adapters.`
    )
  }
  const before = performance.now()
  const workspaceSource = resolve(input.suiteRoot, input.task.workspace)
  const workspace = await prepareWorkspace({
    source: workspaceSource,
    suiteRoot: input.suiteRoot,
    declaredPath: input.task.workspace,
  })
  try {
    if (input.conditionFixture) {
      await seedMemoryCondition({
        suiteRoot: input.suiteRoot,
        fixturePath: input.conditionFixture,
        workspace,
      })
    }
    const agentRun = await adapter.run({
      prompt: input.task.prompt,
      workspace,
      timeoutMs: input.task.timeoutMs,
    })
    const verifierResults: VerifierResult[] = []
    for (const verifier of input.task.verifiers) {
      verifierResults.push(await runVerifier(verifier, workspace, workspaceSource))
    }
    const success =
      agentRun.exitCode === 0 &&
      !agentRun.timedOut &&
      verifierResults.every((r) => r.passed)
    return {
      taskId: input.task.id,
      agent: input.task.agent,
      memoryCondition: input.condition,
      workspaceSource,
      workspace: input.keepWorkspaces ? workspace : null,
      success,
      failureReason: deriveFailureReason(success, agentRun, verifierResults),
      agentRun,
      verifiers: verifierResults,
      metrics: { elapsedMs: roundMs(performance.now() - before) },
    }
  } finally {
    if (!input.keepWorkspaces) {
      await rm(workspace, { recursive: true, force: true })
    }
  }
}

async function prepareWorkspace(input: {
  source: string
  suiteRoot: string
  declaredPath: string
}): Promise<string> {
  // Path-escape guard. `task.workspace` is operator-controlled YAML; a
  // malicious or careless `../../../etc` could otherwise turn `fs.cp`
  // into a recursive read of arbitrary host filesystem directories
  // (and write them into a tmpdir handed to the agent). The legitimate
  // boundary is the suite root's parent — sibling directories like
  // `evals/workspaces/<name>` are valid, anything that climbs above
  // `evals/` is not. Mirrors the `seedMemoryCondition` boundary.
  const evalsRoot = dirname(input.suiteRoot)
  const rel = relative(evalsRoot, input.source)
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(
      `Workspace fixture path "${input.declaredPath}" escapes the eval-suite parent directory`
    )
  }
  const dir = await mkdtemp(join(tmpdir(), "lore-eval-task-"))
  // `fs.cp` (Node 16.7+) preserves modes and handles symlinks/dotfiles
  // out of the box. The recursive flag walks subdirectories; verbatim
  // mode preservation matters when a fixture commits an executable
  // script (e.g. `scripts/setup.sh`) whose +x bit must survive the copy.
  await cp(input.source, dir, { recursive: true, preserveTimestamps: true })
  return dir
}

async function seedMemoryCondition(input: {
  suiteRoot: string
  fixturePath: string
  workspace: string
}): Promise<void> {
  const absolute = resolve(input.suiteRoot, input.fixturePath)
  // Path-escape guard. Production memory fixtures live next to the
  // suite root in a sibling directory (e.g., a YAML suite reading a
  // JSON memory fixture in a peer subdirectory), so the legitimate
  // read scope is
  // "under the suite root's parent" — NOT the suite root itself, and
  // NOT a broader `evals/` ancestor. The boundary intentionally allows
  // sibling-directory reads (task-memory/, baselines/) but rejects
  // anything that escapes via `../../../etc/...`. If org policy ever
  // requires pinning an `evals/baselines/` subtree as untouchable
  // read-only, tighten this boundary in lockstep with the new
  // contract.
  const evalsRoot = dirname(input.suiteRoot)
  const rel = relative(evalsRoot, absolute)
  // `rel.startsWith("/")` is a Windows-port hedge; `path.relative` on
  // POSIX never returns an absolute path, but on win32 it can return
  // a drive-letter path (`C:\...`) that no `..` prefix would catch.
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(
      `Memory-condition fixture path "${input.fixturePath}" escapes the eval-suite parent directory`
    )
  }
  const contents = await readFile(absolute, "utf-8")
  // Conventional drop point: .lore-memories.json at the workspace
  // root. Agent prompts that are matrix-aware reference this path.
  await writeFile(
    join(input.workspace, ".lore-memories.json"),
    contents,
    "utf-8"
  )
}

function deriveFailureReason(
  success: boolean,
  agentRun: AgentRunResult,
  verifierResults: VerifierResult[]
): TaskFailureReason | null {
  if (success) return null
  // Adapter-side refusal is a structural field on AgentRunResult,
  // not a Codex-specific stderr substring. Future adapters set
  // `refused: true` on their own opt-out paths.
  if (agentRun.refused) return "adapter-refused"
  if (agentRun.timedOut) return "timeout"
  if (agentRun.exitCode < 0) return "spawn-error"
  if (agentRun.exitCode !== 0) return "agent-exit"
  if (verifierResults.some((v) => !v.passed)) return "verifiers"
  // Defensive: if `success` is false but no axis says so, treat as
  // verifiers (the only remaining contributor to the success calc).
  return "verifiers"
}

async function runVerifier(
  verifier: TaskEvalVerifier,
  workspace: string,
  workspaceSource: string
): Promise<VerifierResult> {
  const target = resolve(workspace, verifier.path)
  if (!isInsideWorkspace(target, workspace)) {
    return {
      verifier,
      passed: false,
      message: `Verifier path "${verifier.path}" escapes the workspace`,
    }
  }
  if (verifier.type === "file-exists") {
    try {
      await stat(target)
      return { verifier, passed: true, message: `File exists: ${verifier.path}` }
    } catch {
      return { verifier, passed: false, message: `File missing: ${verifier.path}` }
    }
  }
  if (verifier.type === "file-unchanged") {
    const sourcePath = resolve(workspaceSource, verifier.path)
    let sourceHash: string
    let workspaceHash: string
    try {
      sourceHash = await hashFile(sourcePath)
    } catch {
      return {
        verifier,
        passed: false,
        message: `Source fixture missing for unchanged check: ${verifier.path}`,
      }
    }
    try {
      workspaceHash = await hashFile(target)
    } catch {
      return {
        verifier,
        passed: false,
        message: `Workspace file missing for unchanged check: ${verifier.path}`,
      }
    }
    return sourceHash === workspaceHash
      ? {
          verifier,
          passed: true,
          message: `File unchanged from fixture: ${verifier.path}`,
        }
      : {
          verifier,
          passed: false,
          message: `File modified from fixture: ${verifier.path}`,
        }
  }
  // file-contents-match. The regex was already validated at schema-parse
  // time, so this construction cannot throw.
  let contents: string
  try {
    contents = await readFile(target, "utf-8")
  } catch {
    return {
      verifier,
      passed: false,
      message: `File missing for content check: ${verifier.path}`,
    }
  }
  const regex = new RegExp(verifier.pattern)
  const matched = regex.test(contents)
  if (verifier.mode === "match") {
    return {
      verifier,
      passed: matched,
      message: matched
        ? `Pattern matched in ${verifier.path}`
        : `Pattern did not match in ${verifier.path}`,
    }
  }
  return {
    verifier,
    passed: !matched,
    message: matched
      ? `Forbidden pattern matched in ${verifier.path}`
      : `Forbidden pattern not present in ${verifier.path}`,
  }
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash("sha256").update(buf).digest("hex")
}

function isInsideWorkspace(target: string, workspace: string): boolean {
  const rel = relative(workspace, target)
  return !rel.startsWith("..") && !rel.startsWith("/")
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}

function defaultArtifactPath(suiteName: string, startedAt: string): string {
  const safe = startedAt.replace(/[:.]/g, "-")
  return resolve(process.cwd(), "evals", "results", `${suiteName}-${safe}.json`)
}

function defaultAdapters(): Map<string, AgentAdapter> {
  // Note: no `mock` entry. A committed YAML cannot reference an agent
  // without a production adapter; tests build their own adapter map.
  return new Map<string, AgentAdapter>([["codex", new CodexAgentAdapter()]])
}

/**
 * Allowlist of env vars forwarded to the Codex child. Anything not
 * listed here stays out of the child env (and out of the JSON artifact's
 * captured stdout/stderr if the model echoes its env). Secrets like
 * `NOTION_API_TOKEN`, `LORE_NOTION_TOKEN`, and `GITHUB_TOKEN` are
 * deliberately absent.
 */
export const CODEX_FORWARDED_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "TZ",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "OPENAI_API_KEY",
] as const

const CODEX_FORWARDED_ENV_PREFIXES = ["CODEX_"]

export function buildCodexChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of CODEX_FORWARDED_ENV_KEYS) {
    const value = parentEnv[key]
    if (value !== undefined) out[key] = value
  }
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue
    for (const prefix of CODEX_FORWARDED_ENV_PREFIXES) {
      if (key.startsWith(prefix)) {
        out[key] = value
        break
      }
    }
  }
  return out
}

/**
 * Cap on the bytes captured per stream (stdout, stderr) from the Codex
 * child. Real Codex sessions can produce multi-MB stdout in long runs;
 * the in-memory concat would land the whole stream in the JSON
 * artifact. Bounded to 1 MiB per stream — enough to surface refusal
 * messages and short failure traces, small enough to keep the artifact
 * comparable in CI artifact-upload size limits.
 */
export const CODEX_CAPTURE_CAP_BYTES = 1024 * 1024

interface CappedCapture {
  chunks: Buffer[]
  truncated: boolean
}

function makeCappedCapture(): CappedCapture {
  return { chunks: [], truncated: false }
}

function appendCappedChunk(capture: CappedCapture, chunk: Buffer): void {
  let captured = 0
  for (const c of capture.chunks) captured += c.length
  if (captured >= CODEX_CAPTURE_CAP_BYTES) {
    capture.truncated = true
    return
  }
  const remaining = CODEX_CAPTURE_CAP_BYTES - captured
  if (remaining >= chunk.length) {
    capture.chunks.push(chunk)
  } else {
    capture.chunks.push(chunk.subarray(0, remaining))
    // The chunk was clipped — mark truncated so the join() pass adds
    // the marker. Avoids the exact-fill false-positive that the prior
    // `>= CODEX_CAPTURE_CAP_BYTES` check produced when the last chunk
    // landed completely.
    capture.truncated = true
  }
}

function joinCappedCapture(capture: CappedCapture): string {
  const text = Buffer.concat(capture.chunks).toString("utf-8")
  if (capture.truncated) {
    return `${text}\n[capture-truncated at ${CODEX_CAPTURE_CAP_BYTES} bytes]`
  }
  return text
}

/**
 * Production agent adapter. Shells out to `codex exec --cd <workspace>
 * --sandbox workspace-write --skip-git-repo-check <prompt>` with a
 * scrubbed env, in a detached process group so timeout cancellation
 * kills the whole tree.
 *
 * Gated behind `LORE_EVAL_TASK_REAL=1` because real Codex invocations
 * incur model spend; without the env var the adapter exits cleanly with
 * a recognizable stderr line and a non-zero exit code so the runner
 * surfaces "we declined to actually run" rather than a misleading
 * success.
 *
 * **Platform**: POSIX (macOS / Linux). The detached process group +
 * `process.kill(-pid)` teardown is POSIX semantics. Windows' process-
 * group model differs and `process.kill(-pid)` will throw there; the
 * timer's catch swallows that throw and the SIGKILL never lands. The
 * eval runner's docs target nightly CI on Linux/Mac. A future Windows
 * port must reimplement the timeout teardown via `taskkill /T` or
 * equivalent.
 */
export class CodexAgentAdapter implements AgentAdapter {
  readonly id: string = "codex"

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const allowReal = process.env["LORE_EVAL_TASK_REAL"]
    if (allowReal !== "1" && allowReal !== "true") {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "[codex-adapter] real Codex invocation refused: set LORE_EVAL_TASK_REAL=1 to opt in. " +
          "This guard prevents misconfigured CI from racking up unbounded model spend.",
        timedOut: false,
        refused: true,
      }
    }
    return new Promise<AgentRunResult>((resolveRun) => {
      const args = [
        "exec",
        "--cd",
        input.workspace,
        "--sandbox",
        "workspace-write",
        "--skip-git-repo-check",
        input.prompt,
      ]
      const child = spawn("codex", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildCodexChildEnv(),
        // Detached so we can kill the entire process group on timeout
        // (codex may have spawned subprocesses inside `workspace-write`
        // — test watchers, package installs — that we need to clean up).
        detached: true,
      })
      const stdoutCapture = makeCappedCapture()
      const stderrCapture = makeCappedCapture()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid !== undefined) {
            // Negative pid kills the process group on POSIX. We hold
            // detached=true so the group is `child.pid`'s own.
            process.kill(-child.pid, "SIGKILL")
          } else {
            child.kill("SIGKILL")
          }
        } catch {
          // Process already gone; nothing to do.
        }
      }, input.timeoutMs)
      child.stdout?.on("data", (c: Buffer) => appendCappedChunk(stdoutCapture, c))
      child.stderr?.on("data", (c: Buffer) => appendCappedChunk(stderrCapture, c))
      child.on("error", (err) => {
        clearTimeout(timer)
        resolveRun({
          exitCode: -1,
          stdout: joinCappedCapture(stdoutCapture),
          stderr: joinCappedCapture(stderrCapture) + `\n[spawn-error] ${err}`,
          timedOut,
        })
      })
      child.on("close", (code) => {
        clearTimeout(timer)
        resolveRun({
          exitCode: code ?? -1,
          stdout: joinCappedCapture(stdoutCapture),
          stderr: joinCappedCapture(stderrCapture),
          timedOut,
        })
      })
    })
  }
}
