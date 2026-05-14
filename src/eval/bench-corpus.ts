/**
 * LongMemEval bench corpus loader.
 *
 * Loads the `longmemeval_s_cleaned` corpus from
 * `evals/bench-corpora/longmemeval/longmemeval_s_cleaned.json`, verifies
 * the sha256 against the committed `checksums.json` manifest, and
 * parses every example into a strict-typed shape downstream modules
 * (bench-runner, bench-ingest, bench-judge) consume.
 *
 * The HuggingFace revision is pinned in `checksums.json`; the runner
 * recomputes sha256 on first read and aborts on mismatch so a
 * partially-downloaded or substituted corpus cannot silently change
 * the headline number.
 */

import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { z } from "zod"

/**
 * Seven LongMemEval categories: six recall categories plus abstention.
 *
 * The tuple is the single source of truth for category names across
 * the bench-baseline schema, the judge dispatcher, per-category
 * aggregation in `summary.byCategory`, and the abstention judge route.
 * Adding a category (or renaming one) is a one-line tuple edit plus
 * the type errors that fan out from it.
 */
export const LONGMEMEVAL_CATEGORIES = [
  "single-session-user",
  "single-session-assistant",
  "single-session-preference",
  "multi-session",
  "knowledge-update",
  "temporal-reasoning",
  "abstention",
] as const

export type LongMemEvalCategory = (typeof LONGMEMEVAL_CATEGORIES)[number]

export const ABSTENTION_CATEGORY: LongMemEvalCategory = "abstention"

/**
 * A single haystack session: chronological list of role+content turns.
 *
 * The cleaned dataset variant flattens each session into an array of
 * `{ role: "user" | "assistant", content: string }`. Sessions are
 * replayed by `bench-ingest` in declaration order; per-session
 * timestamps are not present in the cleaned dataset (the
 * temporal-fidelity caveat C-only approach pinned by V1).
 */
const sessionTurnSchema = z
  .object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
  })
  .passthrough()

/**
 * One LongMemEval example: a target question, the haystack of past
 * conversation sessions, the category label, and (when present) the
 * reference answer. Abstention examples may omit `answer`.
 */
/**
 * Coerce a corpus `answer` field to a string. LongMemEval rows are
 * authored by hand and a handful of entries (e.g. `s_cleaned` index
 * 70) carry a bare number where a string would be canonical. Coercing
 * via `String(...)` keeps the judge's `Reference answer: {reference}`
 * slot well-formed without losing the numeric value.
 *
 * **Source-token preservation caveat.** `String(1e21)` returns
 * `"1e+21"` — not the literal an operator might have authored as
 * `"1000000000000000000000"`. Today's `longmemeval_s_cleaned` answer
 * values are small integers and short text strings, so this never
 * fires. A future corpus revision that adds large floats would lose
 * source-token fidelity; the right fix at that point is reading the
 * raw JSON value as text before Zod parses, which is out of scope
 * for V1.
 */
const stringOrNumberAnswer = z
  .union([z.string(), z.number()])
  .transform((v) => (typeof v === "number" ? String(v) : v))
  .optional()

const exampleSchema = z
  .object({
    question_id: z.string().min(1),
    question_type: z.enum(LONGMEMEVAL_CATEGORIES),
    question: z.string().min(1),
    answer: stringOrNumberAnswer,
    haystack_sessions: z.array(z.array(sessionTurnSchema)).default([]),
    haystack_session_ids: z.array(z.string()).optional(),
    haystack_dates: z.array(z.string()).optional(),
    answer_session_ids: z.array(z.string()).optional(),
  })
  .passthrough()

export type LongMemEvalSessionTurn = z.infer<typeof sessionTurnSchema>
export type LongMemEvalExample = z.infer<typeof exampleSchema>

const fileChecksumSchema = z
  .object({
    sha256: z.string().regex(/^[a-f0-9]{64}$/, "sha256 must be 64 lowercase hex chars"),
  })
  .strict()

export const benchCorpusChecksumsSchema = z
  .object({
    source: z.literal("huggingface"),
    repository: z.string().min(1),
    revision: z.string().min(1),
    files: z.record(z.string().min(1), fileChecksumSchema),
    license: z.string().default("MIT"),
  })
  .strict()

export type BenchCorpusChecksums = z.infer<typeof benchCorpusChecksumsSchema>

export interface LoadedBenchCorpus {
  /** Corpus name as declared in the suite YAML (`longmemeval_s_cleaned`). */
  name: string
  /** Absolute path the corpus JSON was read from. */
  path: string
  /** Verified sha256 — equal to the value in `checksums.json`. */
  sha256: string
  /** HF repository the corpus was originally downloaded from. */
  repository: string
  /** HF commit SHA pinning the dataset revision. */
  revision: string
  /** Parsed examples, in declaration order. */
  examples: LongMemEvalExample[]
}

export class BenchCorpusChecksumMismatchError extends Error {
  constructor(
    public readonly path: string,
    public readonly expected: string,
    public readonly actual: string
  ) {
    super(
      `Corpus checksum mismatch for ${path}: expected sha256 ${expected}, ` +
        `got ${actual}. The committed manifest pins a specific HF revision; ` +
        `re-download the dataset or update checksums.json deliberately.`
    )
    this.name = "BenchCorpusChecksumMismatchError"
  }
}

/**
 * Compute the sha256 of a buffer as lowercase hex.
 */
export function sha256Hex(buffer: Buffer | string): string {
  const hash = createHash("sha256")
  hash.update(buffer)
  return hash.digest("hex")
}

/**
 * Read and parse the `checksums.json` manifest sitting alongside the
 * corpus file. Errors loudly on shape mismatch so a hand-edited
 * manifest can't silently disable verification.
 */
export async function readBenchCorpusChecksums(
  checksumsPath: string
): Promise<BenchCorpusChecksums> {
  const raw = await readFile(checksumsPath, "utf-8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse checksums.json at ${checksumsPath}: ${message}`, {
      cause: err,
    })
  }
  return benchCorpusChecksumsSchema.parse(parsed)
}

/**
 * Load the corpus from `corpusPath`, verify sha256 against the
 * manifest entry for the corpus filename, and parse every example.
 *
 * Throws `BenchCorpusChecksumMismatchError` on sha256 drift so the
 * bench-runner can route the failure to a deterministic pre-flight
 * abort (no Notion / OpenAI calls have happened yet at this point).
 * The manifest must list the corpus filename under `files`; an
 * unknown filename is a programmer error and throws.
 */
export async function loadBenchCorpus(input: {
  name: string
  corpusPath: string
  checksumsPath?: string
}): Promise<LoadedBenchCorpus> {
  const corpusPath = resolve(input.corpusPath)
  const checksumsPath = resolve(
    input.checksumsPath ?? resolve(dirname(corpusPath), "checksums.json")
  )
  const checksums = await readBenchCorpusChecksums(checksumsPath)
  const filename = corpusPath.split("/").pop() ?? corpusPath
  const expected = checksums.files[filename]
  if (!expected) {
    throw new Error(
      `checksums.json at ${checksumsPath} has no entry for "${filename}". ` +
        `Known files: ${Object.keys(checksums.files).join(", ") || "(none)"}`
    )
  }
  const buffer = await readFile(corpusPath)
  const actual = sha256Hex(buffer)
  if (actual !== expected.sha256) {
    throw new BenchCorpusChecksumMismatchError(corpusPath, expected.sha256, actual)
  }
  let parsedJson: unknown
  try {
    parsedJson = JSON.parse(buffer.toString("utf-8"))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse corpus JSON at ${corpusPath}: ${message}`, {
      cause: err,
    })
  }
  if (!Array.isArray(parsedJson)) {
    throw new Error(
      `Corpus JSON at ${corpusPath} must be an array of examples; ` +
        `got ${typeof parsedJson}`
    )
  }
  const examples: LongMemEvalExample[] = []
  for (const [index, raw] of parsedJson.entries()) {
    const parsedExample = exampleSchema.safeParse(raw)
    if (!parsedExample.success) {
      throw new Error(
        `Corpus example at index ${index} failed schema validation: ` +
          parsedExample.error.issues.map((issue) => issue.message).join("; ")
      )
    }
    examples.push(parsedExample.data)
  }
  return {
    name: input.name,
    path: corpusPath,
    sha256: actual,
    repository: checksums.repository,
    revision: checksums.revision,
    examples,
  }
}

/**
 * Flatten one session's turns into a single transcript string the
 * conversation-mining seam can ingest. Each turn renders as a single
 * line of `Role: content`, with `\n` between turns so the mining
 * agent reads the session like a human-readable chat log. Empty
 * sessions render as an empty string and are skipped by the
 * ingest layer (zero transcript = nothing to mine).
 */
export function renderSessionTranscript(session: LongMemEvalSessionTurn[]): string {
  if (!Array.isArray(session) || session.length === 0) return ""
  return session
    .map((turn) => {
      const role =
        turn.role === "user" ? "User" : turn.role === "assistant" ? "Assistant" : "System"
      return `${role}: ${turn.content}`
    })
    .join("\n\n")
}
