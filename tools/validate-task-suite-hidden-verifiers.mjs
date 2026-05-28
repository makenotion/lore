#!/usr/bin/env node
import { spawn } from "node:child_process"
import { cp, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, relative, resolve } from "node:path"
import { parse as parseYaml } from "yaml"

const args = process.argv.slice(2)
const suitePath = args.shift()
if (!suitePath) {
  usage("missing suite path")
}

let workspace = ""
let scenarioFilter = null
let expect = "fail"
let keepWorkspaces = false

for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === "--workspace") {
    workspace = args[++i] ?? ""
  } else if (arg === "--scenario") {
    scenarioFilter = args[++i] ?? ""
  } else if (arg === "--expect") {
    expect = args[++i] ?? ""
  } else if (arg === "--keep-workspaces") {
    keepWorkspaces = true
  } else {
    usage(`unknown argument: ${arg}`)
  }
}

if (!workspace) usage("--workspace is required")
if (expect !== "fail" && expect !== "pass") usage('--expect must be "fail" or "pass"')

const suite = parseYaml(await readFile(resolve(suitePath), "utf8"))
const scenarios = (suite.scenarios ?? []).filter((scenario) =>
  scenarioFilter ? scenario.id === scenarioFilter : true
)
if (scenarios.length === 0) {
  usage(scenarioFilter ? `scenario not found: ${scenarioFilter}` : "suite has no scenarios")
}

const results = []
for (const scenario of scenarios) {
  for (const [index, verifier] of (scenario.verifiers ?? []).entries()) {
    if (verifier.type !== "patched-command") continue
    const scratch = await mkdtemp(resolve(tmpdir(), "lore-hidden-verifier-"))
    try {
      await cp(resolve(workspace), scratch, { recursive: true, preserveTimestamps: true })
      const apply = await runCommand("git", ["apply", "--recount", "--whitespace=nowarn", "-"], {
        cwd: scratch,
        stdin: verifier.patch,
        timeoutMs: verifier.patchTimeoutMs ?? 30000,
      })
      if (apply.timedOut || apply.exitCode !== 0) {
        results.push({
          scenarioId: scenario.id,
          verifier: index,
          ok: false,
          reason: apply.timedOut ? "patch-timeout" : "patch-failed",
          output: firstOutput(apply),
          scratch,
        })
        continue
      }

      const cwd = resolveVerifierCwd(scratch, verifier.cwd ?? ".")
      if (!cwd.ok) {
        results.push({
          scenarioId: scenario.id,
          verifier: index,
          ok: false,
          reason: "invalid-cwd",
          output: cwd.reason,
          scratch,
        })
        continue
      }

      const command = await runCommand(verifier.command, verifier.args ?? [], {
        cwd: cwd.path,
        timeoutMs: verifier.timeoutMs ?? 120000,
      })
      const commandPassed = !command.timedOut && command.exitCode === 0
      const output = firstOutput(command)
      const ok =
        expect === "pass"
          ? commandPassed
          : !commandPassed &&
            !command.timedOut &&
            failureOutputLooksIntentional(verifier, output)
      results.push({
        scenarioId: scenario.id,
        verifier: index,
        ok,
        reason: command.timedOut
          ? "command-timeout"
          : commandPassed
            ? "command-passed"
            : "command-failed",
        output,
        scratch,
      })
    } finally {
      if (!keepWorkspaces) await rm(scratch, { recursive: true, force: true })
    }
  }
}

if (results.length === 0) {
  usage("no patched-command verifiers matched")
}

let failed = 0
for (const result of results) {
  if (!result.ok) failed += 1
  const status = result.ok ? "ok" : "not-ok"
  console.log(
    `${status} ${result.scenarioId} verifier ${result.verifier}: ${result.reason}`
  )
  if (!result.ok && result.output) {
    console.log(indent(result.output))
  }
  if (keepWorkspaces) {
    console.log(`  scratch: ${result.scratch}`)
  }
}

if (failed > 0) {
  console.error(
    `Hidden verifier validation failed: ${failed}/${results.length} verifier(s) did not meet expect=${expect}.`
  )
  process.exit(1)
}

console.log(
  `Hidden verifier validation passed: ${results.length}/${results.length} verifier(s) met expect=${expect}.`
)

function usage(message) {
  console.error(`validate-task-suite-hidden-verifiers: ${message}`)
  console.error(
    "usage: node tools/validate-task-suite-hidden-verifiers.mjs <suite.yaml> --workspace <checkout> [--scenario <id>] [--expect fail|pass] [--keep-workspaces]"
  )
  process.exit(2)
}

function runCommand(command, commandArgs, { cwd, stdin = "", timeoutMs }) {
  return new Promise((resolveCommand) => {
    const child = spawn(command, commandArgs, {
      cwd,
      detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, "SIGTERM")
      } catch {}
      setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL")
        } catch {}
      }, 2000).unref()
    }, timeoutMs)
    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout = cap(stdout + chunk)
    })
    child.stderr.on("data", (chunk) => {
      stderr = cap(stderr + chunk)
    })
    child.once("error", (err) => {
      clearTimeout(timer)
      resolveCommand({
        exitCode: -1,
        timedOut,
        stdout,
        stderr: stderr || err.message,
      })
    })
    child.once("close", (code, signal) => {
      clearTimeout(timer)
      resolveCommand({
        exitCode: signal ? -1 : (code ?? 0),
        timedOut,
        stdout,
        stderr,
      })
    })
    child.stdin.end(stdin)
  })
}

function cap(value) {
  const max = 8192
  return value.length <= max ? value : value.slice(value.length - max)
}

function firstOutput(result) {
  return (result.stderr || result.stdout).trim().slice(0, 2000)
}

function resolveVerifierCwd(scratch, cwd) {
  if (isAbsolute(cwd)) {
    return { ok: false, reason: `verifier cwd must be relative to the scratch workspace: ${cwd}` }
  }
  const resolved = resolve(scratch, cwd)
  const rel = relative(scratch, resolved)
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) {
    return { ok: true, path: resolved }
  }
  return { ok: false, reason: `verifier cwd escapes the scratch workspace: ${cwd}` }
}

function failureOutputLooksIntentional(verifier, output) {
  if (failureOutputLooksLikeSetupFailure(output)) return false
  if (verifier.command === "go" && (verifier.args ?? []).includes("test")) {
    return (
      /--- FAIL: TestHidden/.test(output) &&
      !/(undefined:|no required module provides package)/.test(output)
    )
  }
  if (
    verifier.command === "bash" &&
    (verifier.args ?? []).some((arg) => arg.includes("go test"))
  ) {
    return /--- FAIL: TestHidden|Error: /.test(output)
  }
  return output.length > 0
}

function failureOutputLooksLikeSetupFailure(output) {
  return /\[(build|setup) failed\]/.test(output) ||
    /(syntax error|Cannot find module|node: command not found|go: go\.mod file not found)/.test(output)
}

function indent(value) {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n")
}
