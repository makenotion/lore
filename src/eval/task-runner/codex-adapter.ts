import { spawn } from "node:child_process"
import { once } from "node:events"
import { createWriteStream, existsSync, type WriteStream } from "node:fs"
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, delimiter, dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parseCodexUsage } from "../bench-cost.js"
import { appendCappedChunk, joinCappedCapture, makeCappedCapture } from "./capture.js"
import type {
  AgentAdapter,
  AgentRunInput,
  AgentRunResult,
  AgentRunTranscript,
  AgentRunUsage,
} from "./schema.js"

/**
 * Allowlist of env vars forwarded to the Codex child. Anything not
 * listed here stays out of the child env (and out of the JSON artifact's
 * captured stdout/stderr if the model echoes its env). Secrets like
 * `NOTION_API_TOKEN` and `GITHUB_TOKEN` are
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
const CODEX_HOME_CONFIG_KEYS = new Set([
  "model",
  "model_provider",
  "model_reasoning_effort",
])

export async function createIsolatedCodexHome(
  parentEnv: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const codexHome = await mkdtemp(join(tmpdir(), "lore-eval-codex-home-"))
  try {
    await chmod(codexHome, 0o700)
    const sourceHome = resolveSourceCodexHome(parentEnv)
    if (sourceHome !== null) {
      const sourceAuth = join(sourceHome, "auth.json")
      if (existsSync(sourceAuth)) {
        const targetAuth = join(codexHome, "auth.json")
        await cp(sourceAuth, targetAuth)
        await chmod(targetAuth, 0o600).catch(() => undefined)
      }
      const sourceConfig = join(sourceHome, "config.toml")
      if (existsSync(sourceConfig)) {
        const configText = renderIsolatedCodexConfig(
          await readFile(sourceConfig, "utf-8")
        )
        if (configText.length > 0) {
          await writeFile(join(codexHome, "config.toml"), configText, { mode: 0o600 })
        }
      }
    }
    return codexHome
  } catch (err) {
    await removeIsolatedCodexHome(codexHome)
    throw err
  }
}

function resolveSourceCodexHome(parentEnv: NodeJS.ProcessEnv): string | null {
  const explicit = parentEnv["CODEX_HOME"]
  if (typeof explicit === "string" && explicit.length > 0) return explicit
  const home = parentEnv["HOME"]
  if (typeof home === "string" && home.length > 0) return join(home, ".codex")
  return null
}

function renderIsolatedCodexConfig(source: string): string {
  const lines: string[] = []
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    if (trimmed.startsWith("[")) break
    const match = /^([A-Za-z0-9_]+)\s*=/.exec(trimmed)
    if (match && CODEX_HOME_CONFIG_KEYS.has(match[1]!)) {
      lines.push(trimmed)
    }
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

export async function readConfiguredCodexModel(
  parentEnv: NodeJS.ProcessEnv = process.env
): Promise<string | undefined> {
  const sourceHome = resolveSourceCodexHome(parentEnv)
  if (sourceHome === null) return undefined
  try {
    return parseCodexConfigModel(await readFile(join(sourceHome, "config.toml"), "utf-8"))
  } catch {
    return undefined
  }
}

export function parseCodexConfigModel(source: string): string | undefined {
  for (const line of source.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    if (trimmed.startsWith("[")) break
    const match = /^model\s*=\s*"([^"]+)"/u.exec(trimmed)
    if (match?.[1]?.trim()) return match[1].trim()
  }
  return undefined
}

export async function removeIsolatedCodexHome(codexHome: string): Promise<void> {
  await rm(codexHome, { recursive: true, force: true })
}

export function buildCodexChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
  options: { codexHome?: string } = {}
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
  if (options.codexHome !== undefined) {
    out["CODEX_HOME"] = options.codexHome
    out["HOME"] = options.codexHome
    out["GOMODCACHE"] =
      parentEnv["GOMODCACHE"] ?? join(tmpdir(), "lore-eval-go-mod-cache")
    out["GOCACHE"] = parentEnv["GOCACHE"] ?? join(tmpdir(), "lore-eval-go-build-cache")
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
/**
 * Production agent adapter. Shells out to `codex exec --cd <workspace>
 * --sandbox workspace-write --skip-git-repo-check <prompt>` with a
 * scrubbed env and an isolated Codex runtime home, in a detached
 * process group so timeout cancellation kills the whole tree.
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
/**
 * Sentinel file the bench-runner drops into a per-example workspace
 * to opt the adapter into bench-mode invocation. Task-mode workspaces
 * never carry this file, so `CodexAgentAdapter.run()` branches purely
 * on its presence and the task-mode path stays byte-stable.
 *
 * The sentinel name is intentionally hyphen-prefixed so a careless
 * directory listing surfaces it as a hidden config file rather than
 * blending with task fixtures.
 */
export const BENCH_MODE_SENTINEL = ".lore-bench-mode"
const TASK_TIMEOUT_KILL_GRACE_MS = 5_000

/**
 * Detect whether a workspace was prepared for bench-mode. The bench
 * runner writes this sentinel at workspace construction; the file is
 * zero bytes and exists only as a flag.
 */
function isBenchWorkspace(workspace: string): boolean {
  return existsSync(join(workspace, BENCH_MODE_SENTINEL))
}

/**
 * Bench-mode argv: `codex exec --json --output-last-message
 * <answer-file> -m <model> --cd <workspace> --sandbox workspace-write
 * --skip-git-repo-check <prompt>`. The Codex argv carries zero
 * secrets. Tool-driven runs get read commands through a broker
 * socket rather than a workspace-readable bearer.
 */
export const BENCH_AGENT_MODEL = "gpt-4o-mini-2024-07-18"

/**
 * Env vars the bench-runner reads to configure live Notion access.
 * Tool-driven runs keep these in the broker process; non-shim
 * workspaces may still thread them through Codex MCP config.
 */
export const BENCH_RUNTIME_NOTION_TOKEN_ENV = "LORE_BENCH_NOTION_TOKEN"
export const BENCH_RUNTIME_CONFIG_ROOT_ENV = "LORE_BENCH_CONFIG_ROOT"
export const BENCH_RUNTIME_OPENAI_KEY_ENV = "LORE_BENCH_OPENAI_API_KEY"

/**
 * Env keys cleared from the operator's parent env before the bench
 * Codex child is spawned. Operator-day-to-day Notion / GitHub /
 * Anthropic tokens must not reach the Codex parent process; the
 * bench's Notion auth is routed by the bench runner, not inherited
 * through the Codex parent env. Clearing the day-to-day token from
 * Codex's parent env is defense-in-depth so a future Codex
 * env-passthrough behavior change cannot accidentally route the
 * wrong token into the child.
 */
export const BENCH_CHILD_CLEARED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "NOTION_API_TOKEN",
  "NOTION_DEV_PAT",
  "GITHUB_TOKEN",
] as const

export const BENCH_TOOL_SHIM_DIR = ".lore-tools"
export const BENCH_TOOL_TRACE_FILE = "lore-tool-trace.jsonl"
export const BENCH_TOOL_CLI_JS_ENV = "LORE_BENCH_TOOL_CLI_JS"
export const BENCH_TOOL_NODE_ENV = "LORE_BENCH_TOOL_NODE"
export const BENCH_SHELL_ENV_EXCLUDES = [
  "OPENAI_API_KEY",
  "LORE_BENCH_OPENAI_API_KEY",
  "NOTION_API_TOKEN",
  "LORE_BENCH_NOTION_TOKEN",
  "NOTION_DEV_PAT",
  "GITHUB_TOKEN",
  "ANTHROPIC_API_KEY",
] as const

/**
 * Build the bench-mode Codex child env. The allowlist below mirrors
 * `CODEX_FORWARDED_ENV_KEYS` minus secrets that must come from the
 * bench-runner's controlled env, plus the explicit
 * `LORE_BENCH_OPENAI_API_KEY → OPENAI_API_KEY` mapping.
 */
export function buildBenchCodexChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
  options: {
    workspace?: string
    extraEnv?: Record<string, string>
    codexHome?: string
  } = {}
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "TMPDIR", "TZ", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = parentEnv[key]
    if (value !== undefined) out[key] = value
  }
  // Explicit child OPENAI_API_KEY comes ONLY from
  // LORE_BENCH_OPENAI_API_KEY; the operator's day-to-day
  // OPENAI_API_KEY is in BENCH_CHILD_CLEARED_ENV_KEYS so it doesn't
  // reach the child via inheritance.
  const benchOpenAI = parentEnv[BENCH_RUNTIME_OPENAI_KEY_ENV]
  if (benchOpenAI) out["OPENAI_API_KEY"] = benchOpenAI
  if (options.workspace) {
    const shimDir = join(options.workspace, BENCH_TOOL_SHIM_DIR)
    if (existsSync(shimDir)) {
      out["PATH"] = out["PATH"] ? `${shimDir}${delimiter}${out["PATH"]}` : shimDir
      out[BENCH_TOOL_NODE_ENV] = process.execPath
      const cliJs = resolveBenchToolCliJs()
      if (cliJs) out[BENCH_TOOL_CLI_JS_ENV] = cliJs
    }
  }
  if (options.extraEnv) {
    for (const [key, value] of Object.entries(options.extraEnv)) {
      out[key] = value
    }
  }
  if (options.codexHome !== undefined) {
    out["CODEX_HOME"] = options.codexHome
    out["HOME"] = options.codexHome
  }
  return out
}

function resolveBenchToolCliJs(): string | null {
  const current = fileURLToPath(import.meta.url)
  if (basename(current) === "cli.js") return current
  const distCli = resolve(process.cwd(), "dist", "cli.js")
  return existsSync(distCli) ? distCli : null
}

/**
 * Build the Codex `exec` argv for a bench-mode run. Workspace config
 * lives at `<workspace>/.codex/config.toml` (mode `0o600`) — see
 * `buildBenchWorkspace` in `eval/bench-runner.ts`. Tool-driven runs
 * use runner-owned broker shims, so the spawn argv carries ZERO
 * secrets and no bench Notion auth is readable from the workspace.
 * Network is enabled for bench shell behavior, while
 * `shell_environment_policy.exclude` strips bearer env keys from
 * model-generated shell commands.
 *
 * Exported so the regression test can assert "the rendered argv
 * contains no bearer-shaped substring." The invariant: token
 * routing never happens via Codex argv.
 */
export function buildBenchSpawnArgs(workspace: string, prompt: string): string[] {
  return [
    "exec",
    "--json",
    "--output-last-message",
    join(workspace, "answer.txt"),
    "-m",
    BENCH_AGENT_MODEL,
    "-c",
    "sandbox_workspace_write.network_access=true",
    "-c",
    `shell_environment_policy.exclude=${JSON.stringify([...BENCH_SHELL_ENV_EXCLUDES])}`,
    "--cd",
    workspace,
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    prompt,
  ]
}

/**
 * Task-mode argv keeps Codex's rich JSONL event stream on stdout and writes the
 * final assistant message to an out-of-workspace file. The runner stores the
 * JSONL stream as a sidecar transcript, while `AgentRunResult.stdout` remains
 * the final answer text expected by existing artifact consumers.
 */
export function buildTaskSpawnArgs(input: {
  workspace: string
  prompt: string
  lastMessagePath: string
}): string[] {
  return [
    "exec",
    "--json",
    "--output-last-message",
    input.lastMessagePath,
    "--cd",
    input.workspace,
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    input.prompt,
  ]
}

interface TranscriptWriter {
  path: string
  bytes: number
  writeChunk(chunk: Buffer): void
  finish(event: Record<string, unknown>): Promise<AgentRunTranscript>
}

async function openTranscriptWriter(input: {
  path: string | undefined
  args: string[]
  prompt: string
  workspace: string
}): Promise<TranscriptWriter | null> {
  if (!input.path) return null
  await mkdir(dirname(input.path), { recursive: true })
  const stream = createWriteStream(input.path, { flags: "w", mode: 0o600 })
  let bytes = 0
  let lastByteWasNewline = true
  const writeString = (text: string): void => {
    bytes += Buffer.byteLength(text)
    if (text.length > 0) lastByteWasNewline = text.endsWith("\n")
    stream.write(text)
  }
  writeString(
    `${JSON.stringify({
      type: "lore.eval.agent_run.started",
      timestamp: new Date().toISOString(),
      agent: "codex",
      argv: ["codex", ...redactPromptArg(input.args)],
      workspace: input.workspace,
      prompt: input.prompt,
    })}\n`
  )
  return {
    path: input.path,
    get bytes() {
      return bytes
    },
    writeChunk(chunk: Buffer): void {
      bytes += chunk.length
      if (chunk.length > 0) lastByteWasNewline = chunk[chunk.length - 1] === 10
      stream.write(chunk)
    },
    async finish(event: Record<string, unknown>): Promise<AgentRunTranscript> {
      if (!lastByteWasNewline) writeString("\n")
      writeString(
        `${JSON.stringify({
          type: "lore.eval.agent_run.finished",
          timestamp: new Date().toISOString(),
          ...event,
        })}\n`
      )
      stream.end()
      await waitForStreamFinish(stream)
      return { path: input.path!, format: "codex-jsonl", bytes }
    },
  }
}

function redactPromptArg(args: string[]): string[] {
  if (args.length === 0) return args
  return [...args.slice(0, -1), "<prompt>"]
}

async function waitForStreamFinish(stream: WriteStream): Promise<void> {
  if (stream.closed || stream.destroyed) return
  await once(stream, "finish")
}

function parseCodexJsonlUsage(
  stdout: string,
  fallbackModel: string | undefined
): AgentRunUsage | null {
  let lastUsage: AgentRunUsage | null = null
  for (const line of stdout.split("\n")) {
    const usage = parseCodexJsonlUsageLine(line, fallbackModel)
    if (usage) lastUsage = usage
  }
  return lastUsage
}

function parseCodexJsonlUsageLine(
  line: string,
  fallbackModel: string | undefined
): AgentRunUsage | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const event = parsed as { type?: unknown; usage?: unknown; model?: unknown }
  if (event.type !== "turn.completed") return null
  const usage = parseCodexUsage(event.usage)
  if (!usage) return null
  const model = eventModel(event) ?? fallbackModel
  return {
    provider: "openai",
    ...(model ? { model } : {}),
    promptTokens: usage.input_tokens,
    cachedPromptTokens: usage.cached_input_tokens,
    outputTokens: usage.output_tokens,
    reasoningOutputTokens: usage.reasoning_output_tokens,
  }
}

function eventModel(event: { model?: unknown }): string | undefined {
  return typeof event.model === "string" && event.model.trim()
    ? event.model.trim()
    : undefined
}

export class CodexAgentAdapter implements AgentAdapter {
  readonly id: string = "codex"

  async supportsBenchToolDrivenRetrieval(): Promise<{
    supported: boolean
    reason: string | null
  }> {
    let codexHome: string
    try {
      codexHome = await createIsolatedCodexHome()
    } catch (err) {
      return {
        supported: false,
        reason: `failed to create isolated Codex home: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }
    return new Promise((resolveSupport) => {
      let settled = false
      const finish = (result: { supported: boolean; reason: string | null }): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void removeIsolatedCodexHome(codexHome).finally(() => resolveSupport(result))
      }
      const child = spawn("codex", ["--version"], {
        stdio: ["ignore", "ignore", "pipe"],
        env: buildBenchCodexChildEnv(process.env, { codexHome }),
      })
      const stderrCapture = makeCappedCapture()
      const timer = setTimeout(() => {
        child.kill("SIGKILL")
        finish({
          supported: false,
          reason:
            "codex --version timed out while checking tool-driven retrieval support",
        })
      }, 10_000)
      child.stderr?.on("data", (c: Buffer) => appendCappedChunk(stderrCapture, c))
      child.on("error", (err) => {
        finish({
          supported: false,
          reason: `codex executable unavailable: ${err.message}`,
        })
      })
      child.on("close", (code) => {
        if (code === 0) {
          finish({ supported: true, reason: null })
          return
        }
        const detail = joinCappedCapture(stderrCapture).trim()
        finish({
          supported: false,
          reason:
            `codex --version exited with code ${code ?? -1}` +
            (detail ? `: ${detail}` : ""),
        })
      })
    })
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    if (isBenchWorkspace(input.workspace)) {
      return this.runBench(input)
    }
    return this.runTask(input)
  }

  private async runBench(input: AgentRunInput): Promise<AgentRunResult> {
    const allowReal = process.env["LORE_EVAL_BENCH_REAL"]
    if (allowReal !== "1" && allowReal !== "true") {
      return {
        exitCode: 1,
        stdout: "",
        stderr:
          "[codex-adapter] real bench Codex invocation refused: set LORE_EVAL_BENCH_REAL=1 to opt in. " +
          "This guard prevents misconfigured CI from racking up unbounded model spend.",
        timedOut: false,
        refused: true,
      }
    }
    const codexHome = await createIsolatedCodexHome()
    const args = buildBenchSpawnArgs(input.workspace, input.prompt)
    return new Promise<AgentRunResult>((resolveRun) => {
      const child = spawn("codex", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildBenchCodexChildEnv(process.env, {
          workspace: input.workspace,
          extraEnv: input.extraEnv,
          codexHome,
        }),
        detached: true,
      })
      const stdoutCapture = makeCappedCapture()
      const stderrCapture = makeCappedCapture()
      let timedOut = false
      let settled = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
          else child.kill("SIGKILL")
        } catch {
          // Process already gone; nothing to do.
        }
      }, input.timeoutMs)
      const finish = (result: AgentRunResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        void removeIsolatedCodexHome(codexHome).finally(() => resolveRun(result))
      }
      child.stdout?.on("data", (c: Buffer) => appendCappedChunk(stdoutCapture, c))
      child.stderr?.on("data", (c: Buffer) => appendCappedChunk(stderrCapture, c))
      child.on("error", (err) => {
        finish({
          exitCode: -1,
          stdout: joinCappedCapture(stdoutCapture),
          stderr: joinCappedCapture(stderrCapture) + `\n[spawn-error] ${err}`,
          timedOut,
        })
      })
      child.on("close", (code) => {
        finish({
          exitCode: code ?? -1,
          stdout: joinCappedCapture(stdoutCapture),
          stderr: joinCappedCapture(stderrCapture),
          timedOut,
        })
      })
    })
  }

  private async runTask(input: AgentRunInput): Promise<AgentRunResult> {
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
    const codexHome = await createIsolatedCodexHome()
    const configuredModel = await readConfiguredCodexModel({ CODEX_HOME: codexHome })
    const lastMessagePath = join(codexHome, "last-message.txt")
    return new Promise<AgentRunResult>((resolveRun) => {
      const args = buildTaskSpawnArgs({
        workspace: input.workspace,
        prompt: input.prompt,
        lastMessagePath,
      })
      const env = buildCodexChildEnv(process.env, { codexHome })
      const stdoutCapture = makeCappedCapture()
      const stderrCapture = makeCappedCapture()
      let timedOut = false
      let settled = false
      let transcriptWriter: TranscriptWriter | null = null
      let childStarted = false
      let child: ReturnType<typeof spawn> | null = null
      let killGraceTimer: NodeJS.Timeout | null = null
      let observedUsage: AgentRunUsage | null = null
      let pendingStdoutLine = ""
      const start = async (): Promise<void> => {
        transcriptWriter = await openTranscriptWriter({
          path: input.transcriptPath,
          args,
          prompt: input.prompt,
          workspace: input.workspace,
        })
        const spawned = spawn("codex", args, {
          stdio: ["ignore", "pipe", "pipe"],
          env,
          // Detached so we can kill the entire process group on timeout
          // (codex may have spawned subprocesses inside `workspace-write`
          // — test watchers, package installs — that we need to clean up).
          detached: true,
        })
        child = spawned
        childStarted = true
        wireChild(spawned)
      }
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child && child.pid !== undefined) {
            // Negative pid kills the process group on POSIX. We hold
            // detached=true so the group is `child.pid`'s own.
            process.kill(-child.pid, "SIGKILL")
          } else if (child) {
            child.kill("SIGKILL")
          }
        } catch {
          // Process already gone; nothing to do.
        }
        killGraceTimer = setTimeout(() => {
          void finish({
            exitCode: -1,
            stdout: joinCappedCapture(stdoutCapture),
            stderr:
              joinCappedCapture(stderrCapture) +
              "\n[timeout] Codex task invocation exceeded its timeout.",
            timedOut: true,
          })
        }, taskTimeoutKillGraceMs())
        killGraceTimer.unref()
      }, input.timeoutMs)
      const finish = async (result: AgentRunResult): Promise<void> => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (killGraceTimer !== null) clearTimeout(killGraceTimer)
        const jsonlStdout = joinCappedCapture(stdoutCapture)
        let stderr = result.stderr
        let stdout = result.stdout
        try {
          const lastMessage = await readFile(lastMessagePath, "utf-8")
          stdout = lastMessage
        } catch {
          stdout = stdout.length > 0 ? stdout : jsonlStdout
        }
        let transcript: AgentRunTranscript | null = null
        if (transcriptWriter) {
          try {
            transcript = await transcriptWriter.finish({
              exitCode: result.exitCode,
              timedOut: result.timedOut,
              stderr,
              lastMessage: stdout,
            })
          } catch (err) {
            stderr += `\n[transcript-error] ${err instanceof Error ? err.message : String(err)}`
          } finally {
            transcriptWriter = null
          }
        }
        const trailingUsage = parseCodexJsonlUsageLine(pendingStdoutLine, configuredModel)
        const usage =
          trailingUsage ??
          observedUsage ??
          parseCodexJsonlUsage(jsonlStdout, configuredModel)
        void removeIsolatedCodexHome(codexHome).finally(() =>
          resolveRun({
            ...result,
            stdout,
            stderr,
            transcript,
            usage,
          })
        )
      }
      const wireChild = (child: ReturnType<typeof spawn>): void => {
        child.stdout?.on("data", (c: Buffer) => {
          appendCappedChunk(stdoutCapture, c)
          const text = c.toString("utf-8")
          const lines = `${pendingStdoutLine}${text}`.split("\n")
          pendingStdoutLine = lines.pop() ?? ""
          for (const line of lines) {
            const usage = parseCodexJsonlUsageLine(line, configuredModel)
            if (usage) observedUsage = usage
          }
          transcriptWriter?.writeChunk(c)
        })
        child.stderr?.on("data", (c: Buffer) => appendCappedChunk(stderrCapture, c))
        child.on("error", (err) => {
          void finish({
            exitCode: -1,
            stdout: joinCappedCapture(stdoutCapture),
            stderr: joinCappedCapture(stderrCapture) + `\n[spawn-error] ${err}`,
            timedOut,
          })
        })
        child.on("close", (code) => {
          void finish({
            exitCode: code ?? -1,
            stdout: joinCappedCapture(stdoutCapture),
            stderr: joinCappedCapture(stderrCapture),
            timedOut,
          })
        })
      }
      void start().catch((err) => {
        if (!childStarted) {
          void finish({
            exitCode: -1,
            stdout: joinCappedCapture(stdoutCapture),
            stderr: joinCappedCapture(stderrCapture) + `\n[spawn-error] ${err}`,
            timedOut,
          })
        }
      })
    })
  }
}

function taskTimeoutKillGraceMs(): number {
  const raw = process.env["LORE_EVAL_TASK_TIMEOUT_KILL_GRACE_MS"]
  if (raw) {
    const parsed = Number.parseInt(raw, 10)
    if (Number.isFinite(parsed) && parsed > 0) return parsed
  }
  return TASK_TIMEOUT_KILL_GRACE_MS
}

export function defaultAdapters(): Map<string, AgentAdapter> {
  // Note: no `mock` entry. A committed YAML cannot reference an agent
  // without a production adapter; tests build their own adapter map.
  return new Map<string, AgentAdapter>([["codex", new CodexAgentAdapter()]])
}
