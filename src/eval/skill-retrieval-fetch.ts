import { mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { z } from "zod"
import { sha256Hex } from "./bench-corpus.js"

const fileChecksumSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex chars"),
    path: z.string().min(1),
  })
  .strict()

export const skillRetrievalCorpusManifestSchema = z
  .object({
    source: z.literal("huggingface"),
    repository: z.string().min(1),
    revision: z.string().min(1),
    license: z.string().min(1),
    files: z.record(z.string().min(1), fileChecksumSchema),
  })
  .strict()

export type SkillRetrievalCorpusManifest = z.infer<
  typeof skillRetrievalCorpusManifestSchema
>

export interface SkillRetrievalFetchFileReport {
  path: string
  sha256: string
  skipped: boolean
}

export interface SkillRetrievalFetchReport {
  root: string
  revision: string
  files: SkillRetrievalFetchFileReport[]
}

export interface SkillRetrievalFetchOptions {
  outRoot?: string
  manifestPath?: string
  download?: (input: {
    repository: string
    revision: string
    filename: string
  }) => Promise<Buffer>
}

export const SKILLRET_FETCH_TIMEOUT_MS = 5 * 60 * 1000
export const SKILLRET_MAX_FILE_BYTES = 400 * 1024 * 1024

function huggingFaceUrl(repository: string, revision: string, filename: string): string {
  return `https://huggingface.co/datasets/${repository}/resolve/${revision}/${filename}`
}

async function defaultDownload(input: {
  repository: string
  revision: string
  filename: string
}): Promise<Buffer> {
  const url = huggingFaceUrl(input.repository, input.revision, input.filename)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), SKILLRET_FETCH_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) {
      throw new Error(
        `HuggingFace fetch failed: HTTP ${response.status} ${response.statusText} for ${url}`
      )
    }
    const contentLength = response.headers.get("content-length")
    if (contentLength) {
      const declared = Number.parseInt(contentLength, 10)
      if (Number.isFinite(declared) && declared > SKILLRET_MAX_FILE_BYTES) {
        throw new Error(
          `HuggingFace download rejected: declared content-length ${declared} ` +
            `exceeds cap ${SKILLRET_MAX_FILE_BYTES} bytes for ${url}`
        )
      }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > SKILLRET_MAX_FILE_BYTES) {
      throw new Error(
        `HuggingFace download rejected: actual ${buffer.length} bytes ` +
          `exceeds cap ${SKILLRET_MAX_FILE_BYTES} bytes for ${url}`
      )
    }
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

export async function readSkillRetrievalCorpusManifest(
  path: string
): Promise<SkillRetrievalCorpusManifest> {
  const raw = await readFile(path, "utf-8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse skill-retrieval manifest at ${path}: ${message}`, {
      cause: err,
    })
  }
  return skillRetrievalCorpusManifestSchema.parse(parsed)
}

export async function fetchSkillRetrievalCorpus(
  options: SkillRetrievalFetchOptions = {}
): Promise<SkillRetrievalFetchReport> {
  const manifestPath = resolve(
    options.manifestPath ?? "evals/skill-retrieval/skillret-checksums.json"
  )
  const manifest = await readSkillRetrievalCorpusManifest(manifestPath)
  if (manifest.revision === "pending-bootstrap-fetch") {
    throw new Error(
      `skill-retrieval manifest at ${manifestPath} carries the placeholder ` +
        `revision "pending-bootstrap-fetch". Pin a HuggingFace revision before fetching.`
    )
  }
  const outRoot = resolve(options.outRoot ?? "evals/skill-retrieval/corpora/skillret")
  const download = options.download ?? defaultDownload
  const reports: SkillRetrievalFetchFileReport[] = []

  for (const [filename, file] of Object.entries(manifest.files)) {
    const outPath = resolve(outRoot, file.path)
    if (await fileMatchesSha(outPath, file.sha256)) {
      reports.push({ path: outPath, sha256: file.sha256, skipped: true })
      continue
    }
    const buffer = await download({
      repository: manifest.repository,
      revision: manifest.revision,
      filename,
    })
    const actual = sha256Hex(buffer)
    if (actual !== file.sha256) {
      throw new Error(
        `Downloaded ${filename} sha256 mismatch: expected ${file.sha256}, got ${actual}.`
      )
    }
    await mkdir(dirname(outPath), { recursive: true })
    await writeFile(outPath, buffer)
    reports.push({ path: outPath, sha256: actual, skipped: false })
  }

  return {
    root: outRoot,
    revision: manifest.revision,
    files: reports,
  }
}

async function fileMatchesSha(path: string, expected: string): Promise<boolean> {
  try {
    await stat(path)
  } catch {
    return false
  }
  const buffer = await readFile(path)
  return sha256Hex(buffer) === expected
}
