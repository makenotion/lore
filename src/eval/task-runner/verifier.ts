import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { appendCappedChunk, joinCappedCapture, makeCappedCapture } from "./capture.js"
import {
  killChildProcessGroup,
  registerDetachedChildProcessGroup,
} from "./process-groups.js"
import type {
  AgentRunResult,
  TaskEvalVerifierArtifact,
  TaskEvalVerifier,
  TaskFailureReason,
  VerifierOutputEvidence,
  VerifierResult,
} from "./schema.js"

type RawVerifierResult = Omit<VerifierResult, "verifier"> & {
  verifier: TaskEvalVerifier
}

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
  workspaceSource: string,
  outputPath?: string
): Promise<VerifierResult> {
  const result = await runVerifierRaw(verifier, workspace, workspaceSource, outputPath)
  return {
    ...result,
    verifier: sanitizeVerifierForArtifact(result.verifier),
  }
}

async function runVerifierRaw(
  verifier: TaskEvalVerifier,
  workspace: string,
  workspaceSource: string,
  outputPath?: string
): Promise<RawVerifierResult> {
  if (verifier.type === "command") {
    return runCommandVerifier(verifier, workspace, outputPath)
  }
  if (verifier.type === "patched-command") {
    return runPatchedCommandVerifier(verifier, workspace, outputPath)
  }
  if (verifier.type === "any-file-contents-match") {
    return runAnyFileContentsVerifier(verifier, workspace)
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

async function runAnyFileContentsVerifier(
  verifier: Extract<TaskEvalVerifier, { type: "any-file-contents-match" }>,
  workspace: string
): Promise<RawVerifierResult> {
  const regex = new RegExp(verifier.pattern)
  const missing: string[] = []
  const expanded = await expandVerifierPaths(workspace, verifier.paths)
  if (expanded.escapedPath) {
    return {
      verifier,
      passed: false,
      message: `Verifier path "${expanded.escapedPath}" escapes the workspace`,
    }
  }
  missing.push(...expanded.unmatchedPatterns)
  for (const path of expanded.paths) {
    const target = resolve(workspace, path)
    if (!isInsideWorkspace(target, workspace)) {
      return {
        verifier,
        passed: false,
        message: `Verifier path "${path}" escapes the workspace`,
      }
    }
    let contents: string
    try {
      contents = await readFile(target, "utf-8")
    } catch {
      missing.push(path)
      continue
    }
    if (regex.test(contents)) {
      if (verifier.mode === "forbid") {
        return {
          verifier,
          passed: false,
          message: `Forbidden pattern matched in ${path}`,
        }
      }
      return {
        verifier,
        passed: true,
        message: `Pattern matched in ${path}`,
      }
    }
  }

  if (verifier.mode === "forbid") {
    return {
      verifier,
      passed: true,
      message: `Forbidden pattern not present in any of ${verifier.paths.join(", ")}`,
    }
  }

  const suffix = missing.length > 0 ? `; missing files: ${missing.join(", ")}` : ""
  return {
    verifier,
    passed: false,
    message: `Pattern did not match in any of ${verifier.paths.join(", ")}${suffix}`,
  }
}

async function expandVerifierPaths(
  workspace: string,
  paths: string[]
): Promise<{ paths: string[]; unmatchedPatterns: string[]; escapedPath: string | null }> {
  const expanded = new Set<string>()
  const unmatchedPatterns: string[] = []
  for (const path of paths) {
    if (verifierPathEscapes(path)) {
      return { paths: [], unmatchedPatterns, escapedPath: path }
    }
    const matches = hasGlob(path)
      ? await expandVerifierPathPattern(workspace, path)
      : [path]
    if (
      matches.some((match) => !isInsideWorkspace(resolve(workspace, match), workspace))
    ) {
      return { paths: [], unmatchedPatterns, escapedPath: path }
    }
    if (matches.length === 0) {
      unmatchedPatterns.push(path)
      continue
    }
    for (const match of matches) expanded.add(match)
  }
  return { paths: [...expanded].sort(), unmatchedPatterns, escapedPath: null }
}

async function expandVerifierPathPattern(
  workspace: string,
  pattern: string
): Promise<string[]> {
  const segments = pattern.split("/")
  let current = [workspace]
  for (const segment of segments) {
    const next: string[] = []
    for (const base of current) {
      if (hasGlob(segment)) {
        let entries
        try {
          entries = await readdir(base, { withFileTypes: true })
        } catch {
          continue
        }
        const regex = globSegmentRegex(segment)
        for (const entry of entries) {
          if (regex.test(entry.name)) next.push(resolve(base, entry.name))
        }
      } else {
        next.push(resolve(base, segment))
      }
    }
    current = next.filter((candidate) => isInsideWorkspace(candidate, workspace))
    if (current.length === 0) break
  }
  const files: string[] = []
  for (const candidate of current) {
    try {
      const candidateStat = await stat(candidate)
      if (candidateStat.isFile()) files.push(relative(workspace, candidate))
    } catch {
      // Missing exact paths are reported by the caller.
    }
  }
  return files.sort()
}

function hasGlob(path: string): boolean {
  return /[*?]/u.test(path)
}

function verifierPathEscapes(path: string): boolean {
  return isAbsolute(path) || path.split(/[\\/]+/u).some((part) => part === "..")
}

function globSegmentRegex(segment: string): RegExp {
  const source = segment
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replace(/\*/gu, "[^/]*")
    .replace(/\?/gu, "[^/]")
  return new RegExp(`^${source}$`, "u")
}

async function runCommandVerifier(
  verifier: Extract<TaskEvalVerifier, { type: "command" }>,
  workspace: string,
  outputPath?: string
): Promise<RawVerifierResult> {
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
      output: await writeVerifierOutputEvidence(outputPath, {
        stage: "command",
        verifier,
        result,
      }),
    }
  }
  if (result.exitCode !== 0) {
    return {
      verifier,
      passed: false,
      message:
        `Command failed (${result.exitCode}): ${formatCommand(verifier)}` +
        firstCommandOutput(result),
      output: await writeVerifierOutputEvidence(outputPath, {
        stage: "command",
        verifier,
        result,
      }),
    }
  }
  return {
    verifier,
    passed: true,
    message: `Command passed: ${formatCommand(verifier)}`,
  }
}

async function runPatchedCommandVerifier(
  verifier: Extract<TaskEvalVerifier, { type: "patched-command" }>,
  workspace: string,
  outputPath?: string
): Promise<RawVerifierResult> {
  const verifierWorkspace = await mkdtemp(join(tmpdir(), "lore-eval-verifier-"))
  try {
    await cp(workspace, verifierWorkspace, {
      recursive: true,
      preserveTimestamps: true,
    })
    const applyResult = await runVerifierCommand({
      command: "git",
      args: ["apply", "--recount", "--whitespace=nowarn", "-"],
      cwd: verifierWorkspace,
      timeoutMs: verifier.patchTimeoutMs,
      stdin: verifier.patch,
    })
    if (applyResult.timedOut) {
      return {
        verifier,
        passed: false,
        message: `Patch application timed out after ${verifier.patchTimeoutMs}ms`,
        output: await writeVerifierOutputEvidence(outputPath, {
          stage: "patch-apply",
          verifier,
          result: applyResult,
        }),
      }
    }
    if (applyResult.exitCode !== 0) {
      return {
        verifier,
        passed: false,
        message: `Patch application failed (${applyResult.exitCode}); hidden verifier output omitted.`,
        output: await writeVerifierOutputEvidence(outputPath, {
          stage: "patch-apply",
          verifier,
          result: applyResult,
        }),
      }
    }

    const cwd = resolve(verifierWorkspace, verifier.cwd ?? ".")
    if (!isInsideWorkspace(cwd, verifierWorkspace)) {
      return {
        verifier,
        passed: false,
        message: `Command cwd "${verifier.cwd ?? "."}" escapes the verifier workspace`,
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
        message: `Patched command timed out after ${verifier.timeoutMs}ms: ${formatCommand(verifier)}`,
        output: await writeVerifierOutputEvidence(outputPath, {
          stage: "command",
          verifier,
          result,
        }),
      }
    }
    if (result.exitCode !== 0) {
      return {
        verifier,
        passed: false,
        message: `Patched command failed (${result.exitCode}): ${formatCommand(verifier)}; hidden verifier output omitted.`,
        output: await writeVerifierOutputEvidence(outputPath, {
          stage: "command",
          verifier,
          result,
        }),
      }
    }
    return {
      verifier,
      passed: true,
      message: `Patched command passed: ${formatCommand(verifier)}`,
    }
  } finally {
    await rm(verifierWorkspace, { recursive: true, force: true })
  }
}

async function writeVerifierOutputEvidence(
  outputPath: string | undefined,
  input: {
    stage: "patch-apply" | "command"
    verifier: { command: string; args: string[] }
    result: {
      exitCode: number
      stdout: string
      stderr: string
      timedOut: boolean
      stdoutTruncated: boolean
      stderrTruncated: boolean
    }
  }
): Promise<VerifierOutputEvidence | null> {
  if (!outputPath) return null
  const body = `${JSON.stringify(
    {
      stage: input.stage,
      command: input.verifier.command,
      args: input.verifier.args,
      exitCode: input.result.exitCode,
      timedOut: input.result.timedOut,
      stdoutTruncated: input.result.stdoutTruncated,
      stderrTruncated: input.result.stderrTruncated,
      stdout: input.result.stdout,
      stderr: input.result.stderr,
    },
    null,
    2
  )}\n`
  await mkdir(dirname(outputPath), { recursive: true })
  await writeFile(outputPath, body, "utf-8")
  return {
    path: outputPath,
    format: "verifier-output-json",
    bytes: Buffer.byteLength(body, "utf-8"),
    truncated: input.result.stdoutTruncated || input.result.stderrTruncated,
  }
}

function runVerifierCommand(input: {
  command: string
  args: string[]
  cwd: string
  timeoutMs: number
  stdin?: string
}): Promise<{
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  stdoutTruncated: boolean
  stderrTruncated: boolean
}> {
  return new Promise((resolveRun) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      stdio: [input.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      env: buildVerifierChildEnv(),
      detached: true,
    })
    const unregisterChild = registerDetachedChildProcessGroup(child)
    const stdoutCapture = makeCappedCapture()
    const stderrCapture = makeCappedCapture()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killChildProcessGroup(child, "SIGKILL")
    }, input.timeoutMs)
    if (input.stdin !== undefined) {
      child.stdin?.on("error", () => {
        // The child may exit before consuming stdin; close handling below
        // records the real verifier result.
      })
      child.stdin?.end(input.stdin)
    }
    child.stdout?.on("data", (c: Buffer) => appendCappedChunk(stdoutCapture, c))
    child.stderr?.on("data", (c: Buffer) => appendCappedChunk(stderrCapture, c))
    child.on("error", (err) => {
      clearTimeout(timer)
      unregisterChild()
      resolveRun({
        exitCode: -1,
        stdout: joinCappedCapture(stdoutCapture),
        stderr: joinCappedCapture(stderrCapture) + `\n[spawn-error] ${err}`,
        timedOut,
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
      })
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      unregisterChild()
      resolveRun({
        exitCode: code ?? -1,
        stdout: joinCappedCapture(stdoutCapture),
        stderr: joinCappedCapture(stderrCapture),
        timedOut,
        stdoutTruncated: stdoutCapture.truncated,
        stderrTruncated: stderrCapture.truncated,
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
  out["GOMODCACHE"] =
    parentEnv["GOMODCACHE"] ?? resolve(tmpdir(), "lore-eval-go-mod-cache")
  out["GOCACHE"] = parentEnv["GOCACHE"] ?? resolve(tmpdir(), "lore-eval-go-build-cache")
  return out
}

function formatCommand(verifier: { command: string; args: string[] }): string {
  return [verifier.command, ...verifier.args].join(" ")
}

function sanitizeVerifierForArtifact(
  verifier: TaskEvalVerifier
): TaskEvalVerifierArtifact {
  if (verifier.type !== "patched-command") return verifier
  const { patch, ...rest } = verifier
  return {
    ...rest,
    patchSha256: createHash("sha256").update(patch).digest("hex"),
    patchBytes: Buffer.byteLength(patch, "utf-8"),
  }
}

function firstCommandOutput(input: { stdout: string; stderr: string }): string {
  const lines = `${input.stderr}\n${input.stdout}`
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(0, 20)
  if (lines.length === 0) return ""
  const excerpt = lines.join("\n").slice(0, 4000)
  return `; output:\n${excerpt}`
}

async function hashFile(path: string): Promise<string> {
  const buf = await readFile(path)
  return createHash("sha256").update(buf).digest("hex")
}

function isInsideWorkspace(target: string, workspace: string): boolean {
  const rel = relative(workspace, target)
  return !rel.startsWith("..") && !rel.startsWith("/")
}
