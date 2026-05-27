import { basename, dirname, extname, join, resolve } from "node:path"

export function defaultTranscriptDir(outPath: string): string {
  const ext = extname(outPath)
  const stem = basename(outPath, ext)
  return join(dirname(outPath), `${stem}-transcripts`)
}

export function resolveTranscriptDir(
  configured: string | false | undefined,
  outPath: string
): string | null {
  if (configured === false) return null
  return resolve(configured ?? defaultTranscriptDir(outPath))
}

export function taskTranscriptPath(input: {
  transcriptsDir: string | null
  index: number
  taskId: string
  condition: string | null
  phase?: "formation" | "use"
}): string | undefined {
  if (input.transcriptsDir === null) return undefined
  const parts = [
    input.index.toString().padStart(3, "0"),
    safeTranscriptSegment(input.taskId),
  ]
  if (input.condition) parts.push(safeTranscriptSegment(input.condition))
  if (input.phase) parts.push(input.phase)
  return join(input.transcriptsDir, `${parts.join("-")}.codex.jsonl`)
}

function safeTranscriptSegment(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "run"
  )
}
