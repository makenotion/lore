import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import type { PatchEvidence, PatchStats } from "./schema.js"

const PATCH_EVIDENCE_MAX_BYTES = 2_000_000
const COMMAND_CAPTURE_MAX_BYTES = PATCH_EVIDENCE_MAX_BYTES + 512_000

interface PatchText {
  text: string
  truncated: boolean
}

interface CommandOutput {
  stdout: string
  stderr: string
  stdoutTruncated: boolean
  stderrTruncated: boolean
}

export async function computePatchStats(
  sourceRoot: string,
  workspaceRoot: string
): Promise<PatchStats> {
  const [sourceFiles, workspaceFiles] = await Promise.all([
    listRelativeFiles(sourceRoot),
    listRelativeFiles(workspaceRoot),
  ])
  const allFiles = new Set([...sourceFiles, ...workspaceFiles])
  let filesChanged = 0
  let linesAdded = 0
  let linesRemoved = 0
  for (const file of [...allFiles].sort()) {
    const sourcePath = join(sourceRoot, file)
    const workspacePath = join(workspaceRoot, file)
    const sourceExists = sourceFiles.includes(file)
    const workspaceExists = workspaceFiles.includes(file)
    const sourceText = sourceExists ? await readTextForStats(sourcePath) : null
    const workspaceText = workspaceExists ? await readTextForStats(workspacePath) : null
    if (sourceText === workspaceText) continue
    filesChanged += 1
    const diff = diffLineCounts(sourceText, workspaceText)
    linesAdded += diff.added
    linesRemoved += diff.removed
  }
  return { filesChanged, linesAdded, linesRemoved }
}

export async function writePatchEvidence(input: {
  sourceRoot: string
  workspaceRoot: string
  outPath: string | undefined
}): Promise<PatchEvidence | null> {
  if (input.outPath === undefined) return null
  const patch = await workspacePatch(input.sourceRoot, input.workspaceRoot)
  const capped = capPatchEvidence(patch.text, patch.truncated)
  await mkdir(dirname(input.outPath), { recursive: true })
  await writeFile(input.outPath, capped.text, "utf-8")
  return {
    path: input.outPath,
    format: "git-diff",
    bytes: Buffer.byteLength(capped.text),
    truncated: capped.truncated,
  }
}

const PATCH_STATS_IGNORED_NAMES = new Set([
  ".codex",
  ".git",
  ".lore-memories.json",
  ".lore.yaml",
  ".mcp.json",
  "node_modules",
])

async function listRelativeFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (PATCH_STATS_IGNORED_NAMES.has(entry.name)) continue
      const absolute = join(dir, entry.name)
      const rel = relative(root, absolute)
      if (entry.isDirectory()) {
        await walk(absolute)
      } else if (entry.isFile()) {
        files.push(rel)
      }
    }
  }
  await walk(root)
  return files.sort()
}

async function workspacePatch(
  sourceRoot: string,
  workspaceRoot: string
): Promise<PatchText> {
  if (await isGitWorktree(workspaceRoot)) {
    const baseRef = await gitBaseRef(sourceRoot, workspaceRoot)
    const trackedDiff = await gitOutputRaw(workspaceRoot, [
      "diff",
      baseRef ?? "HEAD",
      "--no-ext-diff",
      "--binary",
      "--no-color",
      "--",
      ".",
    ])
    const untrackedFiles = await gitOutput(workspaceRoot, [
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
    ])
    const untrackedDiffs = await renderUntrackedFileDiffs(
      workspaceRoot,
      untrackedFiles.split("\0").filter(Boolean)
    )
    return {
      text: [trackedDiff.text, untrackedDiffs.text].filter(Boolean).join("\n"),
      truncated: trackedDiff.truncated || untrackedDiffs.truncated,
    }
  }

  return diffOutput(sourceRoot, workspaceRoot)
}

async function gitBaseRef(
  sourceRoot: string,
  workspaceRoot: string
): Promise<string | null> {
  if (!(await isGitWorktree(sourceRoot))) return null
  try {
    const sourceHead = (await gitOutput(sourceRoot, ["rev-parse", "HEAD"])).trim()
    if (sourceHead.length === 0) return null
    await gitOutput(workspaceRoot, ["cat-file", "-e", `${sourceHead}^{commit}`])
    return sourceHead
  } catch {
    return null
  }
}

async function isGitWorktree(root: string): Promise<boolean> {
  try {
    const out = await gitOutput(root, ["rev-parse", "--is-inside-work-tree"])
    return out.trim() === "true"
  } catch {
    return false
  }
}

function gitOutput(cwd: string, args: string[]): Promise<string> {
  return gitOutputRaw(cwd, args).then((output) => output.text)
}

async function gitOutputRaw(cwd: string, args: string[]): Promise<PatchText> {
  const output = await execOutput("git", args, cwd, [0])
  return { text: output.stdout, truncated: output.stdoutTruncated }
}

async function diffOutput(sourceRoot: string, workspaceRoot: string): Promise<PatchText> {
  const output = await execOutput(
    "diff",
    ["-ruN", sourceRoot, workspaceRoot],
    undefined,
    [0, 1]
  )
  return { text: output.stdout, truncated: output.stdoutTruncated }
}

function execOutput(
  command: string,
  args: string[],
  cwd: string | undefined,
  okCodes: number[]
): Promise<CommandOutput> {
  return new Promise((resolveOutput, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const stdout = makeCappedBuffer()
    const stderr = makeCappedBuffer()
    child.stdout?.on("data", (chunk: Buffer) => appendCappedBuffer(stdout, chunk))
    child.stderr?.on("data", (chunk: Buffer) => appendCappedBuffer(stderr, chunk))
    child.once("error", reject)
    child.once("close", (code) => {
      if (!okCodes.includes(code ?? -1)) {
        reject(
          new Error(
            bufferToText(stderr).trim() || `${command} exited with ${code ?? "signal"}`
          )
        )
        return
      }
      resolveOutput({
        stdout: bufferToText(stdout),
        stderr: bufferToText(stderr),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      })
    })
  })
}

async function renderUntrackedFileDiffs(
  workspaceRoot: string,
  files: string[]
): Promise<PatchText> {
  const chunks: string[] = []
  let truncated = false
  for (const file of files.sort()) {
    if (isIgnoredPatchEvidencePath(file)) continue
    const absolute = join(workspaceRoot, file)
    let buffer: Buffer
    try {
      await access(absolute, constants.R_OK)
      buffer = await readFile(absolute)
    } catch {
      continue
    }
    if (buffer.includes(0)) {
      truncated =
        appendPatchChunk(
          chunks,
          [
            `diff --git a/${file} b/${file}`,
            "new file mode 100644",
            "index 0000000..0000000",
            "--- /dev/null",
            `+++ b/${file}`,
            "@@ binary file omitted from eval evidence @@",
            "",
          ].join("\n")
        ) || truncated
      continue
    }
    const text = buffer.toString("utf-8")
    const lines = splitDiffLines(text)
    truncated =
      appendPatchChunk(
        chunks,
        [
          `diff --git a/${file} b/${file}`,
          "new file mode 100644",
          "index 0000000..0000000",
          "--- /dev/null",
          `+++ b/${file}`,
          `@@ -0,0 +1,${lines.length} @@`,
          ...lines.map((line) => `+${line}`),
          "",
        ].join("\n")
      ) || truncated
    if (truncated) break
  }
  return { text: chunks.join("\n"), truncated }
}

function isIgnoredPatchEvidencePath(path: string): boolean {
  return path.split("/").some((part) => PATCH_STATS_IGNORED_NAMES.has(part))
}

function capPatchEvidence(
  text: string,
  alreadyTruncated = false
): { text: string; truncated: boolean } {
  const maxBytes = PATCH_EVIDENCE_MAX_BYTES
  const bytes = Buffer.byteLength(text)
  if (bytes <= maxBytes) return { text, truncated: alreadyTruncated }
  const suffix = "\n[patch-evidence-truncated]\n"
  const keepBytes = maxBytes - Buffer.byteLength(suffix)
  return {
    text:
      Buffer.from(text).subarray(0, Math.max(0, keepBytes)).toString("utf-8") + suffix,
    truncated: true,
  }
}

function appendPatchChunk(chunks: string[], chunk: string): boolean {
  const currentBytes = Buffer.byteLength(chunks.join("\n"))
  if (currentBytes >= COMMAND_CAPTURE_MAX_BYTES) return true
  const remaining = COMMAND_CAPTURE_MAX_BYTES - currentBytes
  const chunkBytes = Buffer.byteLength(chunk)
  if (chunkBytes <= remaining) {
    chunks.push(chunk)
    return false
  }
  chunks.push(
    `${Buffer.from(chunk).subarray(0, Math.max(0, remaining)).toString("utf-8")}\n[patch-evidence-truncated]\n`
  )
  return true
}

function makeCappedBuffer(): { chunks: Buffer[]; bytes: number; truncated: boolean } {
  return { chunks: [], bytes: 0, truncated: false }
}

function appendCappedBuffer(
  capture: { chunks: Buffer[]; bytes: number; truncated: boolean },
  chunk: Buffer
): void {
  if (capture.truncated) return
  const remaining = COMMAND_CAPTURE_MAX_BYTES - capture.bytes
  if (chunk.byteLength <= remaining) {
    capture.chunks.push(chunk)
    capture.bytes += chunk.byteLength
    return
  }
  capture.chunks.push(chunk.subarray(0, Math.max(0, remaining)))
  capture.bytes += Math.max(0, remaining)
  capture.truncated = true
}

function bufferToText(capture: { chunks: Buffer[]; truncated: boolean }): string {
  const text = Buffer.concat(capture.chunks).toString("utf-8")
  return capture.truncated ? `${text}\n[command-output-truncated]\n` : text
}

async function readTextForStats(path: string): Promise<string> {
  const buffer = await readFile(path)
  if (buffer.includes(0)) return ""
  return buffer.toString("utf-8")
}

function diffLineCounts(
  before: string | null,
  after: string | null
): { added: number; removed: number } {
  const beforeLines = splitDiffLines(before ?? "")
  const afterLines = splitDiffLines(after ?? "")
  if (before === null) return { added: afterLines.length, removed: 0 }
  if (after === null) return { added: 0, removed: beforeLines.length }
  const lcs = longestCommonSubsequenceLength(beforeLines, afterLines)
  return {
    added: Math.max(0, afterLines.length - lcs),
    removed: Math.max(0, beforeLines.length - lcs),
  }
}

function splitDiffLines(text: string): string[] {
  if (text.length === 0) return []
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text
  if (normalized.length === 0) return []
  return normalized.split(/\r?\n/)
}

function longestCommonSubsequenceLength(a: string[], b: string[]): number {
  if (a.length * b.length > 1_000_000) {
    const shared = new Set(a)
    return b.filter((line) => shared.has(line)).length
  }
  const row = new Array<number>(b.length + 1).fill(0)
  for (let i = 1; i <= a.length; i++) {
    let prev = 0
    for (let j = 1; j <= b.length; j++) {
      const temp = row[j]!
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j]!, row[j - 1]!)
      prev = temp
    }
  }
  return row[b.length]!
}

export function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}

export function roundRate(value: number): number {
  return Math.round(value * 10_000) / 10_000
}
