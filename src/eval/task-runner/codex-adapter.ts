import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { chmod, cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { appendCappedChunk, joinCappedCapture, makeCappedCapture } from "./capture.js"
import type { AgentAdapter, AgentRunInput, AgentRunResult } from "./schema.js"

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
 * --skip-git-repo-check <prompt>`. The full `mcp_servers.lore` block
 * (transport, command, args, env including the bench bearer) lives
 * on disk at `<workspace>/.codex/config.toml` (mode 0600); the
 * Codex argv carries zero secrets. See `buildBenchSpawnArgs` and
 * `buildBenchWorkspace` (`eval/bench-runner.ts`) for the on-disk
 * shape and the threat-model trade-off vs argv routing.
 */
export const BENCH_AGENT_MODEL = "gpt-4o-mini-2024-07-18"

/**
 * Env vars the bench-runner reads to populate the workspace
 * `.codex/config.toml`'s `[mcp_servers.lore.env]` block. The bench-
 * runner is responsible for setting them per example.
 */
export const BENCH_RUNTIME_NOTION_TOKEN_ENV = "LORE_BENCH_NOTION_TOKEN"
export const BENCH_RUNTIME_CONFIG_ROOT_ENV = "LORE_BENCH_CONFIG_ROOT"
export const BENCH_RUNTIME_OPENAI_KEY_ENV = "LORE_BENCH_OPENAI_API_KEY"

/**
 * Env keys cleared from the operator's parent env before the bench
 * Codex child is spawned. Operator-day-to-day Notion / GitHub /
 * Anthropic tokens must not reach the Codex parent process; the
 * bench's MCP-child Notion auth comes from the on-disk
 * `<workspace>/.codex/config.toml` `[mcp_servers.lore.env]` block
 * (see `buildBenchWorkspace`), not from inheritance. Clearing the
 * day-to-day token from Codex's parent env is defense-in-depth so a
 * future Codex env-passthrough behavior change cannot accidentally
 * route the wrong token into the MCP child.
 */
export const BENCH_CHILD_CLEARED_ENV_KEYS = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "NOTION_API_TOKEN",
  "GITHUB_TOKEN",
] as const

/**
 * Build the bench-mode Codex child env. The allowlist below mirrors
 * `CODEX_FORWARDED_ENV_KEYS` minus secrets that must come from the
 * bench-runner's controlled env, plus the explicit
 * `LORE_BENCH_OPENAI_API_KEY → OPENAI_API_KEY` mapping.
 */
export function buildBenchCodexChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "HOME", "TMPDIR", "TZ", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = parentEnv[key]
    if (value !== undefined) out[key] = value
  }
  for (const [key, value] of Object.entries(parentEnv)) {
    if (value === undefined) continue
    if (key.startsWith("CODEX_")) out[key] = value
  }
  // Explicit child OPENAI_API_KEY comes ONLY from
  // LORE_BENCH_OPENAI_API_KEY; the operator's day-to-day
  // OPENAI_API_KEY is in BENCH_CHILD_CLEARED_ENV_KEYS so it doesn't
  // reach the child via inheritance.
  const benchOpenAI = parentEnv[BENCH_RUNTIME_OPENAI_KEY_ENV]
  if (benchOpenAI) out["OPENAI_API_KEY"] = benchOpenAI
  return out
}

/**
 * Build the Codex `exec` argv for a bench-mode run. The entire
 * bench MCP config (transport, command, args, env including the
 * bench bearer) lives on disk at `<workspace>/.codex/config.toml`
 * (mode `0o600`) — see `buildBenchWorkspace` in
 * `eval/bench-runner.ts`. The spawn argv carries ZERO secrets;
 * `args.join(" ")` is safe to log.
 *
 * Exported so the regression test can assert "the rendered argv
 * contains no bearer-shaped substring." The invariant: token
 * routing happens via on-disk config, never via Codex argv.
 */
export function buildBenchSpawnArgs(workspace: string, prompt: string): string[] {
  return [
    "exec",
    "--json",
    "--output-last-message",
    join(workspace, "answer.txt"),
    "-m",
    BENCH_AGENT_MODEL,
    "--cd",
    workspace,
    "--sandbox",
    "workspace-write",
    "--skip-git-repo-check",
    prompt,
  ]
}

export class CodexAgentAdapter implements AgentAdapter {
  readonly id: string = "codex"

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
    const args = buildBenchSpawnArgs(input.workspace, input.prompt)
    return new Promise<AgentRunResult>((resolveRun) => {
      const child = spawn("codex", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: buildBenchCodexChildEnv(),
        detached: true,
      })
      const stdoutCapture = makeCappedCapture()
      const stderrCapture = makeCappedCapture()
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL")
          else child.kill("SIGKILL")
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
      const env = buildCodexChildEnv(process.env, { codexHome })
      const child = spawn("codex", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env,
        // Detached so we can kill the entire process group on timeout
        // (codex may have spawned subprocesses inside `workspace-write`
        // — test watchers, package installs — that we need to clean up).
        detached: true,
      })
      const stdoutCapture = makeCappedCapture()
      const stderrCapture = makeCappedCapture()
      let timedOut = false
      let settled = false
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
}

export function defaultAdapters(): Map<string, AgentAdapter> {
  // Note: no `mock` entry. A committed YAML cannot reference an agent
  // without a production adapter; tests build their own adapter map.
  return new Map<string, AgentAdapter>([["codex", new CodexAgentAdapter()]])
}
