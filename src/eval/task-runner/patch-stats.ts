import { readFile, readdir } from "node:fs/promises"
import { join, relative } from "node:path"
import type { PatchStats } from "./schema.js"

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
