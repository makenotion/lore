import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { readFile, stat } from "node:fs/promises"
import { relative, resolve } from "node:path"
import { appendCappedChunk, joinCappedCapture, makeCappedCapture } from "./capture.js"
import type {
  AgentRunResult,
  TaskEvalVerifier,
  TaskFailureReason,
  VerifierResult,
} from "./schema.js"

export function deriveFailureReason(
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

export async function runVerifier(
  verifier: TaskEvalVerifier,
  workspace: string,
  workspaceSource: string
): Promise<VerifierResult> {
  if (verifier.type === "command") {
    return runCommandVerifier(verifier, workspace)
  }
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

async function runCommandVerifier(
  verifier: Extract<TaskEvalVerifier, { type: "command" }>,
  workspace: string
): Promise<VerifierResult> {
  const cwd = resolve(workspace, verifier.cwd ?? ".")
  if (!isInsideWorkspace(cwd, workspace)) {
    return {
      verifier,
      passed: false,
      message: `Command cwd "${verifier.cwd ?? "."}" escapes the workspace`,
    }
  }

  const result = await runVerifierCommand({
    command: verifier.command,
    args: verifier.args,
    cwd,
    timeoutMs: verifier.timeoutMs,
  })
  if (result.timedOut) {
    return {
      verifier,
      passed: false,
      message: `Command timed out after ${verifier.timeoutMs}ms: ${formatCommand(verifier)}`,
    }
  }
  if (result.exitCode !== 0) {
    return {
      verifier,
      passed: false,
      message:
        `Command failed (${result.exitCode}): ${formatCommand(verifier)}` +
        firstCommandOutput(result),
    }
  }
  return {
    verifier,
    passed: true,
    message: `Command passed: ${formatCommand(verifier)}`,
  }
}

function runVerifierCommand(input: {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
}): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolveRun) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildVerifierChildEnv(),
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
        // Process already exited.
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

function buildVerifierChildEnv(
  parentEnv: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "HOME", "TMPDIR", "TZ", "LANG", "LC_ALL", "LC_CTYPE"]) {
    const value = parentEnv[key]
    if (value !== undefined) out[key] = value
  }
  out["CI"] = parentEnv["CI"] ?? "1"
  return out
}

function formatCommand(verifier: Extract<TaskEvalVerifier, { type: "command" }>): string {
  return [verifier.command, ...verifier.args].join(" ")
}

function firstCommandOutput(input: { stdout: string; stderr: string }): string {
  const firstLine = `${input.stderr}\n${input.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  return firstLine ? `; ${firstLine}` : ""
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash("sha256").update(buf).digest("hex")
}

function isInsideWorkspace(target: string, workspace: string): boolean {
  const rel = relative(workspace, target)
  return !rel.startsWith("..") && !rel.startsWith("/")
}
