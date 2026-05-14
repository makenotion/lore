/**
 * `lore eval bench fetch longmemeval` — download the LongMemEval
 * cleaned corpus from the HF revision pinned in `checksums.json`,
 * verify sha256, and write to `evals/bench-corpora/longmemeval/`.
 *
 * Idempotent: a file whose sha256 already matches is left in place
 * (no re-download). On mismatch the previous file is overwritten with
 * the newly-downloaded blob — the manifest is the source of truth.
 */

import { mkdir, readFile, writeFile, stat } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { readBenchCorpusChecksums, sha256Hex } from "./bench-corpus.js"

export interface FetchReport {
  path: string
  sha256: string
  revision: string
  skipped: boolean
}

export interface FetchOptions {
  /**
   * Override the corpus output path. Defaults to the manifest
   * filename in the same directory as `checksums.json`.
   */
  outPath?: string
  /**
   * Override the manifest path. Defaults to
   * `evals/bench-corpora/longmemeval/checksums.json`.
   */
  checksumsPath?: string
  /**
   * Internal seam — overrides the fetch implementation for tests.
   * Returns the raw bytes of the corpus file.
   */
  download?: (input: {
    repository: string
    revision: string
    filename: string
  }) => Promise<Buffer>
}

function huggingFaceUrl(repository: string, revision: string, filename: string): string {
  return `https://huggingface.co/datasets/${repository}/resolve/${revision}/${filename}`
}

/**
 * Per-request wall-clock cap. A hung HF endpoint without a timeout
 * would stall the workflow until the 360-minute job timeout. Five
 * minutes is generous for a 277MB download over a slow connection
 * and short enough that an unhealthy edge fails loudly.
 */
export const HF_FETCH_TIMEOUT_MS = 5 * 60 * 1000

/**
 * Cap on the corpus size accepted from HF. The cleaned `s` variant
 * is ~277MB; doubling that gives headroom for future revisions
 * without admitting an unbounded download from a compromised endpoint.
 */
export const HF_MAX_DOWNLOAD_BYTES = 600 * 1024 * 1024

async function defaultDownload(input: {
  repository: string
  revision: string
  filename: string
}): Promise<Buffer> {
  const url = huggingFaceUrl(input.repository, input.revision, input.filename)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), HF_FETCH_TIMEOUT_MS)
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
      if (Number.isFinite(declared) && declared > HF_MAX_DOWNLOAD_BYTES) {
        throw new Error(
          `HuggingFace download rejected: declared content-length ${declared} ` +
            `exceeds cap ${HF_MAX_DOWNLOAD_BYTES} bytes for ${url}`
        )
      }
    }
    const buffer = Buffer.from(await response.arrayBuffer())
    if (buffer.length > HF_MAX_DOWNLOAD_BYTES) {
      throw new Error(
        `HuggingFace download rejected: actual ${buffer.length} bytes ` +
          `exceeds cap ${HF_MAX_DOWNLOAD_BYTES} bytes for ${url}`
      )
    }
    return buffer
  } finally {
    clearTimeout(timer)
  }
}

export async function fetchLongMemEvalCorpus(
  options: FetchOptions = {}
): Promise<FetchReport> {
  const checksumsPath = resolve(
    options.checksumsPath ?? "evals/bench-corpora/longmemeval/checksums.json"
  )
  const checksums = await readBenchCorpusChecksums(checksumsPath)
  if (checksums.revision === "pending-bootstrap-fetch") {
    throw new Error(
      `checksums.json at ${checksumsPath} carries the placeholder revision ` +
        `"pending-bootstrap-fetch". Update the manifest to a real HF commit ` +
        `SHA before fetching — operator must pin a deliberate revision.`
    )
  }
  const entries = Object.entries(checksums.files)
  if (entries.length === 0) {
    throw new Error(`checksums.json has no files to fetch`)
  }
  // The manifest may list more than one file in the future; today the
  // corpus is one JSON. Process all entries.
  const corpusDir = dirname(checksumsPath)
  await mkdir(corpusDir, { recursive: true })

  let lastReport: FetchReport = {
    path: "",
    sha256: "",
    revision: checksums.revision,
    skipped: false,
  }
  const download = options.download ?? defaultDownload
  for (const [filename, manifest] of entries) {
    const out = resolve(options.outPath ?? resolve(corpusDir, filename))
    if (await fileMatchesSha(out, manifest.sha256)) {
      lastReport = {
        path: out,
        sha256: manifest.sha256,
        revision: checksums.revision,
        skipped: true,
      }
      continue
    }
    const buffer = await download({
      repository: checksums.repository,
      revision: checksums.revision,
      filename,
    })
    const actual = sha256Hex(buffer)
    if (actual !== manifest.sha256) {
      throw new Error(
        `Downloaded ${filename} sha256 mismatch: expected ${manifest.sha256}, ` +
          `got ${actual}. Either the HF revision drifted or the manifest is stale.`
      )
    }
    await writeFile(out, buffer)
    lastReport = {
      path: out,
      sha256: actual,
      revision: checksums.revision,
      skipped: false,
    }
  }
  return lastReport
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
