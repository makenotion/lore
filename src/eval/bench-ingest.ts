/**
 * Bench-mode ingestion: replay one haystack's sessions through the
 * production conversation-mining seam.
 *
 * Each session is mined sequentially against a write-budget-capped
 * MCP server. The seam reports `writeBudgetExceeded` via a state file
 * the MCP server's `wrapWithWriteBudget` proxy writes once when the
 * counter exceeds the cap. On `writeBudgetExceeded: true`, the ingest
 * loop halts replay of further sessions for the example and surfaces
 * the signal to the bench-runner via `IngestResult.failureReason =
 * "write-cap-exceeded"`. On `exitSignal: "SIGKILL"` from the wall-clock
 * cap, the runner records `failureReason: "mining-timeout"`.
 *
 * **`notionWrites` is authoritative from the write-budget proxy's
 * counter.** The MCP server installs a `process.on(exit|SIGTERM|SIGINT)`
 * shutdown handler (`installWriteBudgetShutdownHooks` in
 * `services.ts`) that flushes the counter on every shutdown path —
 * cap-exceeded, steady-state, or signal — so the state file always
 * exists post-run. `BenchIngestResult.notionWritesIsAuthoritative`
 * reports `true` when the count came from the proxy.
 *
 * The fallback path (`memoriesCreated + factsCreated` from
 * `listAllForBackfill` walks) only fires when the MCP child died
 * before the shutdown hook ran (SIGKILL of the child process, OOM,
 * process-tree race). In that case `notionWritesIsAuthoritative`
 * is `false` and the diagnostic count stands in approximately.
 * Diagnostic counts (memoriesCreated / factsCreated) are surfaced
 * separately for triage.
 */

import { existsSync, readFileSync } from "node:fs"
import type { AuthSource } from "../config.js"
import type { MemoryCaptureMode } from "../memory-capture-mode.js"
import {
  runConversationMining,
  type MiningResult,
  type RunConversationMiningOptions,
} from "../hooks/conversation-mining.js"
import type { LongMemEvalExample, LongMemEvalSessionTurn } from "./bench-corpus.js"
import { renderSessionTranscript } from "./bench-corpus.js"
import type { EmitAutoMentionsResult } from "../core/auto-mentions.js"
import { SIMULATED_AUTOSAVE_MAX_MUTATIONS_PER_MEMORY } from "../core/auto-mentions.js"
import type { CreateMemoryInput } from "../types.js"
import {
  addExtractionUsage,
  extractSimulatedAutosaveMemories,
  normalizeSimulatedAutosaveMemories,
  SimulatedAutosaveExtractionError,
  SIMULATED_AUTOSAVE_EXTRACTION_MAX_TOKENS,
  SIMULATED_AUTOSAVE_EXTRACTION_MODEL,
  zeroExtractionUsage,
  type BenchExtractionClient,
  type BenchExtractionUsage,
} from "./bench-simulated-autosave.js"

export type BenchIngestFailureReason =
  | "write-cap-exceeded"
  | "mining-timeout"
  | "mining-error"
  | "ingestion-error"

export interface BenchIngestResult {
  /** Total wall-clock for the entire haystack replay. */
  elapsedMs: number
  /** Number of sessions actually replayed (may be < example.sessions). */
  sessionsReplayed: number
  extractionUsage: BenchExtractionUsage
  /**
   * Best-effort count of Notion mutations the ingest performed. Source
   * varies by strategy and shutdown path — read
   * `notionWritesIsAuthoritative` to know whether to trust the value
   * exactly or as an approximation.
   */
  notionWrites: number
  /**
   * `true` when `notionWrites` came from the write-budget proxy's
   * counter (`lore-mine` path with a clean shutdown, OR the
   * `raw-transcript` path where the loop counts per-call mutations
   * directly). `false` when it fell back to `memoriesCreated +
   * factsCreated` — the unhappy `lore-mine` case where the MCP child
   * died before the shutdown flush ran (SIGKILL, OOM, process tree
   * race). Downstream comparisons that need byte-exact equality (a
   * baseline drift check, a cap-vs-spend audit) must read this flag
   * and skip when false; downstream comparisons that just need
   * order-of-magnitude can ignore it.
   */
  notionWritesIsAuthoritative: boolean
  /** Post-run iterator count under the example's project filter. */
  memoriesCreated: number
  /** Post-run iterator count under the example's project filter. */
  factsCreated: number
  /** True when the write-budget proxy fired during one of the sessions. */
  writeBudgetExceeded: boolean
  /** Set when ingestion halted before all sessions completed. */
  failureReason: BenchIngestFailureReason | null
  /** Last mining-child diagnostic if a failure happened. */
  failureMessage: string | null
}

export interface RunBenchIngestInput {
  example: LongMemEvalExample
  /** Working directory for the spawned mining child. */
  cwd: string
  /** Project name list to thread into the mining prompt. */
  subProjects: string[]
  catchAllName: string | null
  /** Path the MCP server's write-budget proxy writes its state file to. */
  budgetStateFile: string
  /** Wall-clock cap for each session's mining child. */
  perSessionTimeoutMs?: number
  /** Authoritative-write count source. Overridable for tests. */
  readBudgetCount?: (statePath: string) => number | null
  /** Mining-seam adapter. Overridable for tests. */
  runMining?: (
    transcript: string,
    options: RunConversationMiningOptions
  ) => Promise<MiningResult>
  /** Post-run diagnostic count source. Required in production. */
  countMemoriesForProject: (projectId: string) => Promise<number>
  countFactsForProject: (projectId: string) => Promise<number>
  /** Project the per-example sub-project was created under. */
  projectId: string
  /** Test seam — overrides `Date.now` for elapsed measurement. */
  now?: () => number
  /** Optional agentName threaded into the mining prompt. */
  agentName?: string
  /**
   * Auth source the bench-runner resolved through. Threaded into
   * `runConversationMining` so the mining child's `buildSafeEnv`
   * applies the same auth-token partition the production hook
   * applies — preserves the partition contract under `ntn-auth-json`
   * where forwarded auth-token env keys would silently win over a
   * disk-resident `.lore.yaml`.
   */
  authSource?: AuthSource
  /** Autosave capture policy for the mining prompt. Defaults to durable. */
  memoryCaptureMode?: MemoryCaptureMode
  /** Override proposed-memory routing for autosave learning saves. */
  proposeLearnings?: boolean
}

/**
 * Read the budget state file's `count` field. Returns `null` when the
 * file is absent / unreadable / malformed. The bench-runner falls back
 * to the post-run iterator count when this returns null AND the cap
 * was not exceeded.
 */
export function readBudgetCount(statePath: string): number | null {
  if (!existsSync(statePath)) return null
  let raw: string
  try {
    raw = readFileSync(statePath, "utf-8")
  } catch {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const count = (parsed as { count?: unknown }).count
  if (typeof count !== "number" || !Number.isFinite(count)) return null
  return count
}

/**
 * Drive one haystack through `runConversationMining` session-by-session.
 * Stops early on `writeBudgetExceeded: true` or on terminal mining
 * exits.
 */
export async function runBenchIngest(
  input: RunBenchIngestInput
): Promise<BenchIngestResult> {
  const now = input.now ?? Date.now
  const readCount = input.readBudgetCount ?? readBudgetCount
  const runMining = input.runMining ?? runConversationMining
  const t0 = now()
  let sessionsReplayed = 0
  let writeBudgetExceeded = false
  let failureReason: BenchIngestFailureReason | null = null
  let failureMessage: string | null = null

  const sessions: LongMemEvalSessionTurn[][] = input.example.haystack_sessions
  const sessionIdRoot = input.example.question_id

  for (let i = 0; i < sessions.length; i += 1) {
    const session = sessions[i]
    if (!session || session.length === 0) {
      sessionsReplayed += 1
      continue
    }
    const transcript = renderSessionTranscript(session)
    if (transcript.length === 0) {
      sessionsReplayed += 1
      continue
    }
    const sessionId = `${sessionIdRoot}#s${i}`
    let miningResult: MiningResult
    try {
      miningResult = await runMining(transcript, {
        cwd: input.cwd,
        subProjects: input.subProjects,
        catchAllName: input.catchAllName,
        sessionId,
        agentName: input.agentName,
        authSource: input.authSource,
        memoryCaptureMode: input.memoryCaptureMode,
        proposeLearnings: input.proposeLearnings,
        budgetStateFile: input.budgetStateFile,
        timeoutMs: input.perSessionTimeoutMs,
      })
    } catch (err) {
      failureReason = "mining-error"
      failureMessage = err instanceof Error ? err.message : String(err)
      break
    }
    sessionsReplayed += 1
    if (miningResult.writeBudgetExceeded) {
      writeBudgetExceeded = true
      failureReason = "write-cap-exceeded"
      failureMessage = `Write budget exceeded after ${sessionsReplayed} session(s).`
      break
    }
    if (miningResult.exitSignal === "SIGKILL") {
      failureReason = "mining-timeout"
      failureMessage = `Mining child SIGKILL after ${miningResult.elapsedMs}ms.`
      break
    }
    if (miningResult.exitCode !== null && miningResult.exitCode !== 0) {
      failureReason = "mining-error"
      failureMessage = `Mining child exited with code ${miningResult.exitCode}.`
      break
    }
  }

  const [memoriesCreated, factsCreated] = await Promise.all([
    input.countMemoriesForProject(input.projectId).catch((err) => {
      logDiagnosticCountError("memories", input.projectId, err)
      return 0
    }),
    input.countFactsForProject(input.projectId).catch((err) => {
      logDiagnosticCountError("facts", input.projectId, err)
      return 0
    }),
  ])

  const budgetCount = readCount(input.budgetStateFile)
  // Authoritative write count comes from the proxy's counter via the
  // state file. The MCP server installs a process-exit handler that
  // flushes the counter on shutdown so every example — cap-exceeded
  // OR steady-state — leaves a state file behind. The fallback to
  // `memoriesCreated + factsCreated` covers the unhappy case where
  // the MCP child died before the shutdown hook ran (SIGKILL, OOM,
  // process tree race) so `notionWrites` is never silently zero on
  // a real ingest run. That fallback is approximate; the
  // diagnosticCountCaveat already documents it.
  const budgetCountAvailable = budgetCount !== null
  const notionWrites = budgetCount ?? memoriesCreated + factsCreated

  return {
    elapsedMs: now() - t0,
    sessionsReplayed,
    extractionUsage: zeroExtractionUsage(),
    notionWrites,
    notionWritesIsAuthoritative: budgetCountAvailable,
    memoriesCreated,
    factsCreated,
    writeBudgetExceeded,
    failureReason,
    failureMessage,
  }
}

/**
 * Raw-transcript ingestion: each session is written as ONE memory
 * containing the verbatim transcript. Bypasses `runConversationMining`
 * entirely — no `claude -p`, no MCP, no autosave-prompt filter. The
 * agent's `lore-query` retrieves transcript memories by question
 * relevance and reads the body via `lore-memory action='expand'`.
 *
 * Every conversational token is stored, so this lane isolates retrieval
 * over full-fidelity LongMemEval transcripts.
 *
 * The write-budget proxy is NOT installed in this path — there's no
 * MCP child process to wrap. The bench-runner enforces the
 * per-example cap by counting `notionWrites` directly here and
 * halting before the cap is breached.
 */
export interface RunBenchRawTranscriptInput {
  example: LongMemEvalExample
  projectId: string
  perExampleWrites: number
  /**
   * Returns `{ id, mutationCount }` so the loop can enforce the
   * per-example cap against the SDK-level mutation count, not the
   * per-memory count. `MemoryService.createFresh` issues 1 mutation
   * for a properties-only create and 2 for a properties + body
   * create — surfacing the actual count is what keeps the
   * "max N writes" contract honest under the raw-transcript path,
   * which writes non-empty bodies for every session memory.
   */
  createMemoryInProject: (input: {
    projectId: string
    title: string
    content: string
  }) => Promise<{ id: string; mutationCount: number }>
  countMemoriesForProject: (projectId: string) => Promise<number>
  countFactsForProject: (projectId: string) => Promise<number>
  now?: () => number
}

/**
 * Worst-case mutation count `createMemoryInProject` can emit per
 * session. `MemoryService.createFresh` always does 1
 * `pages.create`; a non-empty body adds 1 `pages.updateMarkdown`.
 * Used by the pre-write cap check below so the loop halts BEFORE a
 * write that would cross the cap. The cap is the contract surface
 * operators advertise as "max N writes per example"; the
 * worst-case headroom keeps the per-example total inclusive-bounded
 * by `perExampleWrites`.
 */
const RAW_TRANSCRIPT_MAX_MUTATIONS_PER_SESSION = 2

export async function runBenchRawTranscriptIngest(
  input: RunBenchRawTranscriptInput
): Promise<BenchIngestResult> {
  const now = input.now ?? Date.now
  const t0 = now()
  let sessionsReplayed = 0
  let notionWrites = 0
  let writeBudgetExceeded = false
  let failureReason: BenchIngestFailureReason | null = null
  let failureMessage: string | null = null

  const sessions: LongMemEvalSessionTurn[][] = input.example.haystack_sessions

  for (let i = 0; i < sessions.length; i += 1) {
    const session = sessions[i]
    if (!session || session.length === 0) {
      sessionsReplayed += 1
      continue
    }
    const transcript = renderSessionTranscript(session)
    if (transcript.length === 0) {
      sessionsReplayed += 1
      continue
    }
    // Pre-write cap check uses the worst-case mutation count (2)
    // so the loop halts BEFORE a write that could land us past the
    // cap. `createFresh`'s body write is the second mutation; a
    // session whose transcript is non-empty (the common case) is
    // worth 2 mutations. Optimistic accounting against
    // `notionWrites + 1` would let one bench session push the
    // counter from cap−1 to cap+1, breaking the inclusive-cap
    // contract operators advertise as "max N writes per example."
    if (
      notionWrites + RAW_TRANSCRIPT_MAX_MUTATIONS_PER_SESSION >
      input.perExampleWrites
    ) {
      writeBudgetExceeded = true
      failureReason = "write-cap-exceeded"
      failureMessage = `Write budget reached after ${sessionsReplayed} session(s).`
      break
    }
    const sessionId =
      input.example.haystack_session_ids?.[i] ?? `${input.example.question_id}#s${i}`
    try {
      const result = await input.createMemoryInProject({
        projectId: input.projectId,
        title: `Session ${i + 1}: ${sessionId}`,
        content: transcript,
      })
      notionWrites += result.mutationCount
    } catch (err) {
      failureReason = "ingestion-error"
      failureMessage = err instanceof Error ? err.message : String(err)
      break
    }
    sessionsReplayed += 1
  }

  const [memoriesCreated, factsCreated] = await Promise.all([
    input.countMemoriesForProject(input.projectId).catch((err) => {
      logDiagnosticCountError("memories", input.projectId, err)
      return 0
    }),
    input.countFactsForProject(input.projectId).catch((err) => {
      logDiagnosticCountError("facts", input.projectId, err)
      return 0
    }),
  ])

  return {
    elapsedMs: now() - t0,
    sessionsReplayed,
    extractionUsage: zeroExtractionUsage(),
    notionWrites,
    // Raw-transcript counts mutations directly per call site (no
    // out-of-process proxy involvement), so the value is exact by
    // construction.
    notionWritesIsAuthoritative: true,
    memoriesCreated,
    factsCreated,
    writeBudgetExceeded,
    failureReason,
    failureMessage,
  }
}

export interface RunBenchSimulatedAutosaveInput {
  example: LongMemEvalExample
  projectId: string
  perExampleWrites: number
  extractionPrompt: string
  extractionClient: BenchExtractionClient
  extractionModel?: string
  extractionMaxTokens?: number
  tagVocabulary?: readonly string[]
  createSimulatedAutosaveMemoryInProject: (input: {
    projectId: string
    createInput: CreateMemoryInput
    mentionEntities: string[]
  }) => Promise<{
    id: string
    memoryMutationCount: number
    mentionFacts: EmitAutoMentionsResult
    notionMutationCount: number
  }>
  countMemoriesForProject: (projectId: string) => Promise<number>
  countFactsForProject: (projectId: string) => Promise<number>
  now?: () => number
}

export async function runBenchSimulatedAutosaveIngest(
  input: RunBenchSimulatedAutosaveInput
): Promise<BenchIngestResult> {
  const now = input.now ?? Date.now
  const t0 = now()
  let sessionsReplayed = 0
  let notionWrites = 0
  let extractionUsage = zeroExtractionUsage()
  let writeBudgetExceeded = false
  let failureReason: BenchIngestFailureReason | null = null
  let failureMessage: string | null = null

  const sessions: LongMemEvalSessionTurn[][] = input.example.haystack_sessions

  sessionLoop: for (let i = 0; i < sessions.length; i += 1) {
    const session = sessions[i]
    sessionsReplayed += 1
    if (!session || session.length === 0) continue
    const transcript = renderSessionTranscript(session)
    if (transcript.length === 0) continue
    const sessionId =
      input.example.haystack_session_ids?.[i] ?? `${input.example.question_id}#s${i}`

    let extracted: Awaited<ReturnType<typeof extractSimulatedAutosaveMemories>>
    try {
      extracted = await extractSimulatedAutosaveMemories({
        client: input.extractionClient,
        extractionPrompt: input.extractionPrompt,
        transcript,
        model: input.extractionModel ?? SIMULATED_AUTOSAVE_EXTRACTION_MODEL,
        maxTokens: input.extractionMaxTokens ?? SIMULATED_AUTOSAVE_EXTRACTION_MAX_TOKENS,
        tagVocabulary: input.tagVocabulary,
      })
      extractionUsage = addExtractionUsage(extractionUsage, extracted.usage)
    } catch (err) {
      if (err instanceof SimulatedAutosaveExtractionError) {
        extractionUsage = addExtractionUsage(extractionUsage, err.usage)
      }
      failureReason = "ingestion-error"
      failureMessage = err instanceof Error ? err.message : String(err)
      break
    }

    const plans = normalizeSimulatedAutosaveMemories({
      raw: extracted.raw,
      projectId: input.projectId,
      sessionId,
      tagVocabulary: input.tagVocabulary,
    })

    for (const plan of plans) {
      if (
        notionWrites + SIMULATED_AUTOSAVE_MAX_MUTATIONS_PER_MEMORY >
        input.perExampleWrites
      ) {
        writeBudgetExceeded = true
        failureReason = "write-cap-exceeded"
        failureMessage = `Write budget reached after ${sessionsReplayed} session(s).`
        break sessionLoop
      }
      try {
        const result = await input.createSimulatedAutosaveMemoryInProject({
          projectId: input.projectId,
          createInput: plan.createInput,
          mentionEntities: plan.mentionEntities,
        })
        notionWrites += result.notionMutationCount
      } catch (err) {
        failureReason = "ingestion-error"
        failureMessage = err instanceof Error ? err.message : String(err)
        break sessionLoop
      }
    }
  }

  const [memoriesCreated, factsCreated] = await Promise.all([
    input.countMemoriesForProject(input.projectId).catch((err) => {
      logDiagnosticCountError("memories", input.projectId, err)
      return 0
    }),
    input.countFactsForProject(input.projectId).catch((err) => {
      logDiagnosticCountError("facts", input.projectId, err)
      return 0
    }),
  ])

  return {
    elapsedMs: now() - t0,
    sessionsReplayed,
    extractionUsage,
    notionWrites,
    notionWritesIsAuthoritative: true,
    memoriesCreated,
    factsCreated,
    writeBudgetExceeded,
    failureReason,
    failureMessage,
  }
}

/**
 * Surface diagnostic-count failures on stderr instead of silently
 * collapsing them to zero. A permission flip on `listAllForBackfill`
 * or a transient rate-limit response would otherwise yield
 * `memoriesCreated: 0` / `factsCreated: 0` in the artifact with no
 * signal that the count is bogus. The authoritative `notionWrites`
 * count from the write-budget proxy remains the right number;
 * `memoriesCreated` / `factsCreated` are diagnostic and reasonable
 * to degrade to zero on transient failure — but operators triaging
 * a "why are the diagnostic counts wrong?" report need the stderr
 * line.
 */
function logDiagnosticCountError(
  kind: "memories" | "facts",
  projectId: string,
  err: unknown
): void {
  const message = err instanceof Error ? err.message : String(err)
  process.stderr.write(
    `[bench] warn: diagnostic-count failure (${kind}, project=${projectId}): ${message}\n`
  )
}
