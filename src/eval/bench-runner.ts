/**
 * LongMemEval bench-runner orchestration (issue #595).
 *
 * Per-example flow:
 *  1. Project create — sub-project `lme-<exampleId>-<runId>` under the
 *     sandbox vault.
 *  2. Spawn a write-budget-capped Lore MCP server child via
 *     `lore mcp --write-budget <N> --budget-state-file <path>`.
 *  3. Replay the haystack's sessions through `runConversationMining`.
 *  4. Invoke the bench-mode CodexAgentAdapter (sentinel-marked
 *     workspace) to answer the question against the seeded vault.
 *  5. Parse the agent's `turn.completed` usage off the JSONL stdout.
 *  6. Score the answer via the judge (recall vs abstention prompt).
 *  7. Tear down — archive (not delete) the sub-project, remove the
 *     workspace, free the MCP child.
 *
 * Aggregates results into a `BenchRunArtifact` with per-category
 * accuracy, failure breakdown, cost summary, cleanup-failure list,
 * and the temporalFidelity + diagnosticCount caveats verbatim.
 *
 * Safety gates: `LORE_EVAL_BENCH_REAL=1`, sandbox-name regex, required
 * env vars (`LORE_BENCH_NOTION_TOKEN` / `LORE_BENCH_OPENAI_API_KEY` /
 * `LORE_BENCH_CONFIG_ROOT` / `LORE_BENCH_SANDBOX_PROJECT_NAME`),
 * per-example + per-suite write caps, cost cap.
 */

import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { basename, join, resolve } from "node:path"
import { tmpdir } from "node:os"
import { performance } from "node:perf_hooks"

import {
  LONGMEMEVAL_CATEGORIES,
  loadBenchCorpus,
  sha256Hex,
  type LoadedBenchCorpus,
  type LongMemEvalCategory,
  type LongMemEvalExample,
} from "./bench-corpus.js"
import {
  computeAgentCostUsd,
  computeExtractionCostUsd,
  computeJudgeCostUsd,
  estimateIngestionCostUsd,
  getModelPricing,
  loadBenchPricing,
  parseCodexUsage,
  projectedTotalUsd,
  type BenchPricing,
} from "./bench-cost.js"
import {
  FetchOpenAIChatClient,
  JUDGE_MAX_TOKENS,
  JUDGE_MODEL,
  JUDGE_SEED,
  JUDGE_TEMPERATURE,
  loadJudgePrompts,
  runJudge,
  selectJudgePromptKind,
  type LoadedJudgePrompts,
  type OpenAIChatClient,
} from "./bench-judge.js"
import {
  runBenchIngest,
  runBenchRawTranscriptIngest,
  runBenchSimulatedAutosaveIngest,
  type BenchIngestResult,
} from "./bench-ingest.js"
import type { EmitAutoMentionsResult } from "../core/auto-mentions.js"
import type { CreateMemoryInput } from "../types.js"
import {
  FetchBenchExtractionClient,
  SIMULATED_AUTOSAVE_EXTRACTION_MAX_TOKENS,
  SIMULATED_AUTOSAVE_EXTRACTION_MODEL,
  SIMULATED_AUTOSAVE_EXTRACTION_SCHEMA_VERSION,
  SIMULATED_AUTOSAVE_EXTRACTION_TEMPERATURE,
  type BenchExtractionClient,
} from "./bench-simulated-autosave.js"
import {
  COST_MEASUREMENT_CODEX_REPORTED,
  DIAGNOSTIC_COUNT_CAVEAT,
  EXTRACTION_COST_MEASUREMENT_NOT_APPLICABLE,
  EXTRACTION_COST_MEASUREMENT_OPENAI_REPORTED,
  TEMPORAL_FIDELITY_CAVEAT,
  type BenchExampleResult,
  type BenchFailureReason,
  type BenchRunArtifact,
  type BenchSummary,
  type BenchSummaryCategoryStat,
} from "./bench-runner-types.js"
import { canonicalJsonStringify, computeConfigHash } from "./bench-baseline.js"
import {
  BENCH_AGENT_MODEL,
  BENCH_MODE_SENTINEL,
  CodexAgentAdapter,
  type AgentAdapter,
  type AgentRunResult,
} from "./task-runner.js"
import {
  benchSuiteSchema,
  loadBenchSuite,
  type BenchIngestionStrategy,
} from "./schema.js"
import { resolveProfileFromConfig, type ResolvedProfile } from "../profile/index.js"

const SANDBOX_NAME_REGEX = /\b(sandbox|eval|test|scratch|staging|dev|playground)\b/i
const PRODUCTION_NAME_REGEX = /\bproduction\b|\bprod\b/i

/**
 * Bearer-shaped-prefix patterns redacted from any agent / judge
 * output that flows into the artifact. The bench's threat model
 * acknowledges that the evaluated Codex agent runs with shell access
 * (`--sandbox workspace-write` permits arbitrary shell commands) and
 * therefore CAN read the per-example workspace's
 * `.codex/config.toml` (mode 0600, holding the bench bearer in its
 * `[mcp_servers.lore.env]` table) from inside its sandbox. A prompt-
 * injected adversarial corpus row could exfiltrate the bench token
 * via `answer.txt`. This pre-judge / pre-artifact filter is
 * defense-in-depth: it cannot stop an agent that base64-encodes or
 * scrambles the token, but it catches the trivial verbatim copy
 * path, and forces the leak through a deliberately obfuscated
 * channel that's no longer publishable next to a Zep-comparable
 * headline number.
 *
 * Operators should ALSO use a per-run, easily-revoked bench token
 * (the `LORE_BENCH_NOTION_TOKEN` env name is deliberately distinct
 * from `NOTION_API_TOKEN` for that reason); this filter is a second
 * layer.
 */
const BEARER_REDACTION_PATTERNS: readonly RegExp[] = [
  /ntn_[A-Za-z0-9_-]{20,}/g,
  /development_ntn_[A-Za-z0-9_-]{20,}/g,
  /secret_[A-Za-z0-9_-]{20,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
]

export function redactBearerTokens(text: string): string {
  let out = text
  for (const re of BEARER_REDACTION_PATTERNS) {
    out = out.replace(re, "<redacted-token>")
  }
  return out
}

/**
 * Crockford base32 alphabet for ULIDs. No `I`, `L`, `O`, `U` so
 * lexical sort matches numeric sort and ambiguous characters are
 * out. ULIDs are 26 chars: 10 timestamp + 16 randomness.
 */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
/**
 * Regex character class matching the Crockford base32 alphabet
 * Lore's ULIDs use. Single source of truth so the `CROCKFORD` lookup
 * table, the standalone-ULID matcher, and the sub-project-name
 * regex don't drift independently.
 */
const CROCKFORD_CHAR_CLASS = "[0-9A-HJKMNP-TV-Z]"
const ULID_REGEX = new RegExp(`^${CROCKFORD_CHAR_CLASS}{26}$`)

export function generateUlid(now: number = Date.now()): string {
  let timestamp = now
  let ts = ""
  for (let i = 0; i < 10; i += 1) {
    ts = CROCKFORD[timestamp % 32] + ts
    timestamp = Math.floor(timestamp / 32)
  }
  // `crypto.randomBytes` matches the rest of the codebase's
  // id-generation posture (entity ids, session ids). For ULID
  // uniqueness within a single bench run, Math.random would suffice;
  // crypto-strength randomness eliminates a future "two runs in
  // parallel collide on a sub-project name" failure mode we wouldn't
  // notice until the second run failed `createSubProject` with a
  // name collision.
  const bytes = randomBytes(16)
  let rand = ""
  for (let i = 0; i < 16; i += 1) {
    rand += CROCKFORD[bytes[i]! % 32]
  }
  return ts + rand
}

export function isUlid(value: string): boolean {
  return ULID_REGEX.test(value)
}

const PROJECT_NAME_MAX_LENGTH = 80

/**
 * Build the per-example sub-project name. Trailing-side truncation
 * preserves the ULID suffix (load-bearing for cleanup / sort / grep).
 */
export function makeSubProjectName(exampleId: string, runId: string): string {
  const baseSuffix = `-${runId}`
  if (baseSuffix.length + 4 > PROJECT_NAME_MAX_LENGTH) {
    // Pathological: runId alone exceeds budget. ULID is 26 chars so
    // this can't happen for the standard case; defensive throw.
    throw new Error(`Run id length ${runId.length} exceeds project name budget`)
  }
  const exampleBudget = PROJECT_NAME_MAX_LENGTH - baseSuffix.length - "lme-".length
  const safeExampleId =
    exampleId.length <= exampleBudget ? exampleId : exampleId.slice(0, exampleBudget)
  return `lme-${safeExampleId}${baseSuffix}`
}

export interface BenchSandbox {
  /**
   * Auth source the sandbox's services resolved through. Threaded
   * into `runConversationMining` via `runBenchIngest` so the mining
   * child's `buildSafeEnv` applies the right auth-token partition.
   */
  readonly authSource: import("../config.js").AuthSource
  /**
   * Profile selector resolved by the sandbox's live Lore services.
   * Profile-declared bench suites must match this before they write.
   */
  readonly activeProfileSelector: string
  /** Create a sub-project under the sandbox vault; returns its id. */
  createSubProject(name: string): Promise<string>
  /**
   * Create one memory directly in the named sub-project. Used by the
   * `raw-transcript` ingestion strategy (one memory per session,
   * verbatim transcript as body) which bypasses
   * `runConversationMining`. Returns the new memory's id PLUS the
   * count of Notion mutations the create performed.
   *
   * `MemoryService.createFresh` always issues `pages.create` for
   * properties; non-empty content adds a second `pages.updateMarkdown`
   * call. The per-example write cap is enforced against the SDK's
   * actual mutation count, not the per-memory count — without
   * surfacing the 2× cost here, the raw-transcript path could land
   * up to 2× the advertised cap with the artifact reporting half the
   * actual writes.
   */
  createMemoryInProject(input: {
    projectId: string
    title: string
    content: string
  }): Promise<{ id: string; mutationCount: number }>
  createSimulatedAutosaveMemoryInProject(input: {
    projectId: string
    createInput: CreateMemoryInput
    mentionEntities: string[]
  }): Promise<{
    id: string
    memoryMutationCount: number
    mentionFacts: EmitAutoMentionsResult
    notionMutationCount: number
  }>
  /**
   * Fetch the wake-up-prefetch retrieval bundle for a single bench
   * question. Used by the `wake-up-prefetch` agent retrieval strategy:
   * the bench-runner calls this BEFORE invoking the agent and injects
   * the rendered output as a system-prompt addendum so the agent
   * answers from pre-retrieved context, no MCP tool calls required.
   * Mirrors how Lore's wake-up hook works at session start.
   *
   * Production impl calls `loadWakeUpData({ mode: "task-only",
   * projectId, userQuery, includeMemoryContent: true })` against the
   * just-seeded sub-project and renders the relevance-ranked top memories
   * with bodies. Returns an empty string when no relevant memories surface
   * (the agent will abstain honestly).
   */
  getWakeUpForQuery(input: { projectId: string; userQuery: string }): Promise<string>
  /** Archive (not delete) a project — used in the cleanup teardown. */
  archiveProject(id: string): Promise<void>
  /**
   * Count post-run memories under the example's project (diagnostic).
   * Implementations route through `services.memories.listAllForBackfill({ projectId })`.
   */
  countMemoriesForProject(projectId: string): Promise<number>
  /**
   * Count post-run live facts under the example's project (diagnostic).
   * Implementations route through `services.facts.listAllForBackfill({ projectId, includeInvalidated: false })`.
   */
  countFactsForProject(projectId: string): Promise<number>
}

export interface RunBenchOptions {
  /** Path the bench-suite YAML lives at. */
  suitePath: string
  /** Optional output artifact path. Defaults to `evals/results/bench-<runId>.json`. */
  outPath?: string
  /** Optional baseline path; presence runs the drift comparison post-run. */
  baselinePath?: string
  /** Programmatic-only — keeps per-example workspaces around for triage. Defaults false. */
  keepWorkspaces?: boolean
  /**
   * Optional limit override for smoke runs. Slice is currently a
   * prefix slice — seeded sampling is a follow-up; the CLI rejects
   * this when `--out` writes to `evals/baselines/` so a smoke run
   * cannot accidentally baseline.
   */
  limit?: number
  /** Sandbox accessor — production wires this to Notion-backed services. */
  sandbox: BenchSandbox
  /** Agent adapter — defaults to the bench-mode CodexAgentAdapter. */
  agentAdapter?: AgentAdapter
  /** OpenAI client for the judge — defaults to the FetchOpenAIChatClient. */
  judgeClient?: OpenAIChatClient
  /** OpenAI client for simulated-autosave extraction. */
  extractionClient?: BenchExtractionClient
  /** Pricing override for tests. */
  pricing?: BenchPricing
  /** Judge prompts override for tests. */
  judgePrompts?: LoadedJudgePrompts
  /** Corpus override for tests. */
  corpus?: LoadedBenchCorpus
  /** Wall-clock cap per mining child. */
  perSessionMiningTimeoutMs?: number
  /** Wall-clock cap per agent answer call. */
  agentTimeoutMs?: number
  /** Clock override for tests. */
  now?: () => Date
}

export interface RunBenchResult {
  artifact: BenchRunArtifact
  outPath: string
}

/**
 * Snapshot of the operator's `NOTION_API_TOKEN` / `LORE_CONFIG_ROOT`
 * env state captured at bench entry. The bench is authoritative for
 * the duration of the run — `assertBenchEnvReady` overwrites both
 * keys with their `LORE_BENCH_*` counterparts, and the caller
 * (`runBenchSuite`) restores this snapshot in a `finally` so a local
 * operator's day-to-day token does NOT participate in the run AND
 * does NOT survive past it. Without this, the in-process services
 * could run under the operator's day-to-day auth while the spawned
 * MCP child (reading auth from the per-example workspace's
 * `.codex/config.toml` `[mcp_servers.lore.env]` block) ran under
 * the bench token — two Notion identities, two rate-limit buckets,
 * one artifact.
 */
export interface BenchEnvRestore {
  notionApiToken: string | undefined
  loreConfigRoot: string | undefined
}

/**
 * Read and validate the required bench env vars at entry, then
 * authoritatively overwrite `NOTION_API_TOKEN` and `LORE_CONFIG_ROOT`
 * with the bench-scoped values. Returns the captured pre-bench state
 * so `runBenchSuite` can restore on exit.
 *
 * Snapshot capture happens BEFORE any required-var check below so a
 * caller's `try { assertBenchEnvReady() } finally { restoreBenchEnv() }`
 * pattern stays safe even if a future check inserted between the
 * snapshot and the overwrite throws. The snapshot is cheap (two env
 * reads, two property assignments); capturing it unconditionally is
 * the structural defense against partial-state env mutation.
 */
export function assertBenchEnvReady(): BenchEnvRestore {
  // Capture the pre-bench state BEFORE any throw path. Even if every
  // check below throws, this snapshot remains valid — the only env
  // mutation happens at the very end of this function. The caller is
  // expected to call `restoreBenchEnv(snapshot)` in a `finally`.
  const snapshot: BenchEnvRestore = {
    notionApiToken: process.env["NOTION_API_TOKEN"],
    loreConfigRoot: process.env["LORE_CONFIG_ROOT"],
  }
  if (process.env["LORE_EVAL_BENCH_REAL"] !== "1") {
    throw new Error(
      "LORE_EVAL_BENCH_REAL=1 is required to run the bench against real APIs. " +
        "Set it explicitly when invoking the runner — never default it on."
    )
  }
  const required = [
    "LORE_BENCH_NOTION_TOKEN",
    "LORE_BENCH_OPENAI_API_KEY",
    "LORE_BENCH_CONFIG_ROOT",
    "LORE_BENCH_SANDBOX_PROJECT_NAME",
  ]
  const missing = required.filter((key) => !process.env[key])
  if (missing.length > 0) {
    throw new Error(
      `Bench missing required env: ${missing.join(", ")}. Set every ` +
        `LORE_BENCH_* secret before running the bench.`
    )
  }
  // Bench mode is authoritative — overwrite regardless of whether
  // the operator has their day-to-day token set. The pre-bench state
  // was captured above (before any throw path) so the operator's
  // shell env survives. **No throw paths exist between this point
  // and the return below**: every required-var check has already
  // run, and the two property writes can't throw. A future
  // contributor adding a check between here and the return MUST
  // move it above the snapshot capture, or accept that a throw
  // there will leave env partially mutated with no way for the
  // caller to recover — neither shape is desirable.
  // Without this authoritative overwrite, the in-process services
  // (which `buildBenchSandbox` initializes via `initServices`) would
  // run under the operator's day-to-day auth while the spawned bench
  // MCP child runs under the bench token (read from the workspace
  // `.codex/config.toml`'s `[mcp_servers.lore.env]` block) —
  // split-brain auth on a single artifact, potentially targeting
  // the wrong vault for sandbox create / archive.
  process.env["NOTION_API_TOKEN"] = process.env["LORE_BENCH_NOTION_TOKEN"]
  process.env["LORE_CONFIG_ROOT"] = process.env["LORE_BENCH_CONFIG_ROOT"]
  return snapshot
}

/**
 * Restore the pre-bench env captured by `assertBenchEnvReady`.
 * Idempotent — `undefined` snapshot fields delete the key, defined
 * fields write back the captured value.
 */
export function restoreBenchEnv(snapshot: BenchEnvRestore): void {
  if (snapshot.notionApiToken === undefined) {
    delete process.env["NOTION_API_TOKEN"]
  } else {
    process.env["NOTION_API_TOKEN"] = snapshot.notionApiToken
  }
  if (snapshot.loreConfigRoot === undefined) {
    delete process.env["LORE_CONFIG_ROOT"]
  } else {
    process.env["LORE_CONFIG_ROOT"] = snapshot.loreConfigRoot
  }
}

/**
 * Reject project names that don't smell like sandboxes. The runner
 * never operates against production projects; the regex matches the
 * existing `assertSandboxProjectName` posture in `commands/eval.ts`.
 */
export function assertSandboxProjectName(name: string): void {
  if (PRODUCTION_NAME_REGEX.test(name)) {
    throw new Error(
      `Project "${name}" matches the production-name regex. Refusing to run bench.`
    )
  }
  if (!SANDBOX_NAME_REGEX.test(name)) {
    throw new Error(
      `Project "${name}" does not look like a sandbox (no word-bounded match for ` +
        `sandbox/eval/test/scratch/staging/dev/playground). Refusing to run bench.`
    )
  }
}

export function assertBenchSandboxProfileMatchesSuite(input: {
  sandbox: Pick<BenchSandbox, "activeProfileSelector">
  profile: ResolvedProfile | null
}): void {
  if (!input.profile) return
  if (input.sandbox.activeProfileSelector === input.profile.selector) return
  throw new Error(
    `Bench suite profile ${input.profile.selector} does not match the active sandbox profile ${input.sandbox.activeProfileSelector}. ` +
      "Run the bench against a vault initialized with the suite profile before any bench sub-projects are created."
  )
}

/**
 * Build a per-example workspace dir with the bench-mode sentinel and
 * a `.codex/config.toml` carrying the full bench config — model
 * literal AND the `[mcp_servers.lore]` block with transport, command,
 * args, and the auth env. File mode `0600`, directory chain mode
 * `0700`. The bench token lives ONLY on disk inside this
 * workspace-private mkdtemp; Codex's argv carries zero secrets.
 *
 * Threat model:
 * - Other processes on the same machine cannot read the workspace
 *   contents (mode 0700 directory chain) or the config file (mode
 *   0600). Process snapshots (`ps -wwwE`, `/proc/<codex-pid>/cmdline`,
 *   GHA runner accounting) capture argv; argv carries no secrets, so
 *   those channels surface nothing.
 * - Residual surface: an adversarial corpus-row prompt-injection
 *   reaching the agent could `cat <workspace>/.codex/config.toml` and
 *   read the token (the agent's `--sandbox workspace-write` permits
 *   reads of the workspace it executes in). LongMemEval mitigates this
 *   at the supply-chain layer: the corpus is HF-pinned and sha256-
 *   verified at fetch time, so injecting a malicious row requires
 *   compromising the pinned revision. Bearer redaction in
 *   `redactBearerTokens` is the defense-in-depth layer for the
 *   verbatim-copy exfil path.
 *
 * `--write-budget` and `--budget-state-file` flow through the MCP
 * server's CLI flags inside `mcp_servers.lore.args` so the spawned
 * MCP child installs `wrapWithWriteBudget` between the rate-limit
 * proxy and the Notion SDK. Without this, the 500-per-example safety
 * gate is inert: the proxy would never fire and `writeBudgetExceeded`
 * would stay false regardless of how many writes the agent's tools
 * issued.
 */
export async function buildBenchWorkspace(input: {
  workspace: string
  budgetStateFile: string
  perExampleWrites: number
}): Promise<void> {
  const workspace = input.workspace
  const token = process.env["NOTION_API_TOKEN"]
  const configRoot = process.env["LORE_CONFIG_ROOT"]
  if (!token || token.length === 0 || !configRoot || configRoot.length === 0) {
    throw new Error(
      "buildBenchWorkspace: NOTION_API_TOKEN and LORE_CONFIG_ROOT must be set " +
        "in process.env (assertBenchEnvReady writes both from the LORE_BENCH_* sources). " +
        "Refusing to build a bench workspace without auth."
    )
  }
  if (!Number.isInteger(input.perExampleWrites) || input.perExampleWrites <= 0) {
    throw new Error(
      `buildBenchWorkspace: perExampleWrites must be a positive integer, got ${input.perExampleWrites}`
    )
  }
  // Tighten the perms — mkdtemp on POSIX is already 0700 but be
  // explicit so the contract is reviewable.
  await mkdir(workspace, { recursive: true, mode: 0o700 })
  await writeFile(join(workspace, BENCH_MODE_SENTINEL), "")
  await mkdir(join(workspace, ".codex"), { mode: 0o700, recursive: true })
  // `transport = "stdio"` is required as of Codex 0.128.0; older
  // versions tolerated its absence. Without it Codex aborts with
  // `Error loading config.toml: invalid transport in mcp_servers.lore`
  // before any model call. The whole `mcp_servers.lore` table —
  // transport, command, args, env — lives in this on-disk config
  // file. No `-c mcp_servers.lore.*` overrides are passed at spawn
  // time: Codex 0.128.0 collapses an entire table when any of its
  // leaf overrides is passed (a partial table + one leaf override
  // would silently lose `transport`, `command`, `args`), so the
  // on-disk single-source-of-truth shape is the structural
  // workaround.
  //
  // `tomlEscape` covers backslash and double-quote (the two
  // characters TOML double-quoted strings require escaping). Its
  // scope is "make the value safe for the TOML parser", NOT
  // "transport-safe" — literal newlines and other control
  // characters would also break TOML parsing but are not handled
  // here. Notion PAT shapes (`ntn_*`, `secret_*`, `development_ntn_*`)
  // are alphanumeric + underscore + hyphen by construction; the
  // bench config root path doesn't carry newlines either. The two
  // call sites below (`NOTION_API_TOKEN` and `LORE_CONFIG_ROOT`)
  // are the only writers — a future caller threading arbitrary
  // text through this helper would need to widen the escape set.
  const tomlEscape = (value: string): string =>
    value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')
  const configToml = [
    `model = "${BENCH_AGENT_MODEL}"`,
    ``,
    `[mcp_servers.lore]`,
    `transport = "stdio"`,
    `command = "lore"`,
    `args = ["mcp", "--write-budget", "${input.perExampleWrites}", "--budget-state-file", "${tomlEscape(input.budgetStateFile)}"]`,
    ``,
    `[mcp_servers.lore.env]`,
    `NOTION_API_TOKEN = "${tomlEscape(token)}"`,
    `LORE_CONFIG_ROOT = "${tomlEscape(configRoot)}"`,
    ``,
  ].join("\n")
  await writeFile(join(workspace, ".codex", "config.toml"), configToml, {
    mode: 0o600,
  })
}

/**
 * Parse the agent's `turn.completed` event off the JSONL stdout the
 * `--json` Codex run emits. Returns null when the event is missing or
 * malformed.
 */
export function parseAgentTurnCompleted(stdout: string): {
  usage: ReturnType<typeof parseCodexUsage>
  toolCalls: number
} {
  const lines = stdout.split("\n")
  let toolCalls = 0
  let lastUsage: ReturnType<typeof parseCodexUsage> = null
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith("{")) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      continue
    }
    if (!parsed || typeof parsed !== "object") continue
    const obj = parsed as { type?: unknown; usage?: unknown }
    if (obj.type === "turn.completed") {
      const usage = parseCodexUsage(obj.usage)
      if (usage) lastUsage = usage
    }
    if (obj.type === "tool_call" || obj.type === "tool_use") toolCalls += 1
  }
  return { usage: lastUsage, toolCalls }
}

/**
 * Read the answer file written by Codex `--output-last-message`. Returns
 * an empty string when the file is missing — the runner classifies this
 * as `failureReason: "empty-answer"`.
 */
async function readAnswerFile(workspace: string): Promise<string> {
  const answerPath = join(workspace, "answer.txt")
  if (!existsSync(answerPath)) return ""
  try {
    return await readFile(answerPath, "utf-8")
  } catch {
    return ""
  }
}

/**
 * Compute percentile from an array of numbers — small enough for
 * inline use rather than an external dep.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))
  return sorted[rank] ?? 0
}

function buildEmptyByCategory(): Record<string, BenchSummaryCategoryStat> {
  const out: Record<string, BenchSummaryCategoryStat> = {}
  for (const category of LONGMEMEVAL_CATEGORIES) {
    out[category] = { n: 0, correct: 0, accuracy: 0 }
  }
  return out
}

function emptyFailureBreakdown(): BenchSummary["failureBreakdown"] {
  return {
    "no-failure": 0,
    "ingestion-error": 0,
    "write-cap-exceeded": 0,
    "adapter-refused": 0,
    "agent-timeout": 0,
    "agent-exit": 0,
    "empty-answer": 0,
    "agent-token-usage-missing": 0,
    "judge-error": 0,
    "notion-rate-limit": 0,
    "cost-cap": 0,
    "mining-timeout": 0,
  }
}

/**
 * Classify a mining/ingest failure into the runner's failure
 * vocabulary. Cleanup failures route to `cleanupFailure`, NOT here.
 */
function ingestFailureToReason(ingest: BenchIngestResult): BenchFailureReason | null {
  if (!ingest.failureReason) return null
  if (ingest.failureReason === "write-cap-exceeded") return "write-cap-exceeded"
  if (ingest.failureReason === "mining-timeout") return "mining-timeout"
  return "ingestion-error"
}

/**
 * Classify the agent's run result into a failure reason; null on
 * success. The agent answer + usage are parsed separately.
 */
function agentFailureToReason(
  result: AgentRunResult,
  parsed: { usage: ReturnType<typeof parseCodexUsage> },
  answer: string
): BenchFailureReason | null {
  if (result.refused) return "adapter-refused"
  if (result.timedOut) return "agent-timeout"
  if (result.exitCode !== 0) return "agent-exit"
  if (answer.length === 0) return "empty-answer"
  if (!parsed.usage) return "agent-token-usage-missing"
  return null
}

function emptyExampleIngestion(): BenchExampleResult["ingestion"] {
  return {
    tokensInput: 0,
    extractionTokensPrompt: 0,
    extractionTokensPromptCached: 0,
    extractionTokensCompletion: 0,
    extractionCostUsd: 0,
    extractionCostMeasurement: EXTRACTION_COST_MEASUREMENT_NOT_APPLICABLE,
    memoriesCreated: 0,
    factsCreated: 0,
    notionWrites: 0,
    writeBudgetExceeded: false,
    elapsedMs: 0,
  }
}

function exampleIngestionFromResult(input: {
  ingest: BenchIngestResult
  extractionCostUsd: number
  extractionMeasured: boolean
}): BenchExampleResult["ingestion"] {
  return {
    tokensInput: 0,
    extractionTokensPrompt: input.ingest.extractionUsage.promptTokens,
    extractionTokensPromptCached: input.ingest.extractionUsage.cachedPromptTokens,
    extractionTokensCompletion: input.ingest.extractionUsage.completionTokens,
    extractionCostUsd: input.extractionCostUsd,
    extractionCostMeasurement: input.extractionMeasured
      ? EXTRACTION_COST_MEASUREMENT_OPENAI_REPORTED
      : EXTRACTION_COST_MEASUREMENT_NOT_APPLICABLE,
    memoriesCreated: input.ingest.memoriesCreated,
    factsCreated: input.ingest.factsCreated,
    notionWrites: input.ingest.notionWrites,
    writeBudgetExceeded: input.ingest.writeBudgetExceeded,
    elapsedMs: input.ingest.elapsedMs,
  }
}

export interface BenchRunnerLogSink {
  info(message: string): void
  warn(message: string): void
}

const defaultLogSink: BenchRunnerLogSink = {
  info: (m) => process.stderr.write(`[bench] ${m}\n`),
  warn: (m) => process.stderr.write(`[bench] warn: ${m}\n`),
}

/**
 * Run one example end-to-end. Used by `runBenchSuite`; exported for
 * tests that drive single-example flows.
 */
export async function runBenchExample(input: {
  example: LongMemEvalExample
  runId: string
  pricing: BenchPricing
  judgePrompts: LoadedJudgePrompts
  judgeClient: OpenAIChatClient
  agentAdapter: AgentAdapter
  sandbox: BenchSandbox
  systemPrompt: string
  /**
   * Per-example write cap to install on the spawned MCP server.
   * `runBenchSuite` threads this from `suite.caps.perExampleWrites`
   * (default 500).
   */
  perExampleWrites: number
  /**
   * `lore-mine` (V1 default) routes through `runConversationMining`
   * — claude-p spawn → Lore MCP → autosave's durable-knowledge
   * filter. `raw-transcript` writes one verbatim memory per session
   * directly via the sandbox's `createMemoryInProject`, bypassing
   * the autosave filter for Zep-comparable apples-to-apples.
   */
  ingestionStrategy: BenchIngestionStrategy
  extractionPrompt?: string
  extractionClient?: BenchExtractionClient
  extractionModel?: string
  extractionMaxTokens?: number
  tagVocabulary?: readonly string[]
  /**
   * `tool-driven` (V1 default): agent has MCP tools registered and
   * decides when to call them. Structurally unavailable under
   * `codex exec` in Codex 0.128.0 (no MCP-in-exec) — the agent
   * sees no tools and falls back to shell-command attempts.
   * `wake-up-prefetch`: bench-runner calls
   * `sandbox.getWakeUpForQuery` before the agent runs and injects
   * the relevance-ranked memories into the user prompt. Mirrors
   * production wake-up semantics and works without MCP tool
   * registration. See `BENCH_AGENT_RETRIEVAL_STRATEGIES` in
   * `eval/schema.ts` for the full design rationale.
   */
  agentRetrieval: "tool-driven" | "wake-up-prefetch"
  perSessionMiningTimeoutMs?: number
  agentTimeoutMs: number
  keepWorkspaces: boolean
  log: BenchRunnerLogSink
}): Promise<BenchExampleResult> {
  // Sub-project names (`lme-<exampleId>-<ulid>`) do not carry a
  // sandbox marker themselves — the safety boundary is the *parent*
  // project, which `runBenchSuite` validates once at the top of the
  // run via `LORE_BENCH_SANDBOX_PROJECT_NAME`.
  const projectName = makeSubProjectName(input.example.question_id, input.runId)
  let projectId: string
  try {
    projectId = await input.sandbox.createSubProject(projectName)
  } catch (err) {
    input.log.warn(
      `createSubProject failed for ${projectName}: ${err instanceof Error ? err.message : String(err)}`
    )
    return {
      exampleId: input.example.question_id,
      category: input.example.question_type as LongMemEvalCategory,
      success: false,
      failureReason: "ingestion-error",
      cleanupFailure: null,
      ingestion: emptyExampleIngestion(),
      agent: {
        elapsedMs: 0,
        tokensPrompt: 0,
        tokensCachedPrompt: 0,
        tokensCompletion: 0,
        tokensReasoningOutput: 0,
        toolCalls: 0,
        answer: "",
        costMeasurement: COST_MEASUREMENT_CODEX_REPORTED,
      },
      judge: {
        promptKind: "recall",
        verdict: null,
        rationale: "",
        tokensPromptCached: 0,
        elapsedMs: 0,
        tokensPrompt: 0,
        tokensCompletion: 0,
      },
    }
  }

  let workspace: string | null = null
  let result: BenchExampleResult | undefined
  // Capture pre-example env so the finally below can restore the
  // operator's `process.env` state. Without this, a non-bench
  // consumer running in the same Node process after the bench loop
  // (an artifact-validation pass, a future test importing
  // `runBenchExample`, an embedded `initServices()` call) would
  // inherit `LORE_MCP_WRITE_BUDGET` / `LORE_MCP_BUDGET_STATE_FILE`
  // and silently install `wrapWithWriteBudget` against production
  // traffic.
  const priorBudgetEnv = process.env["LORE_MCP_WRITE_BUDGET"]
  const priorBudgetStateEnv = process.env["LORE_MCP_BUDGET_STATE_FILE"]
  try {
    workspace = await mkdtemp(join(tmpdir(), "lore-bench-"))
    // Compute the budget-state file path BEFORE writing
    // .codex/config.toml so the same path is baked into the MCP
    // child's argv AND read back by the mining seam / bench-runner.
    const budgetStateFile = join(workspace, "write-budget-state.json")
    // Export the write-budget pair into this process's env so the
    // mining child's `buildSafeEnv` forwards them through `claude -p`
    // → spawned `lore mcp`. Without this the MCP server the mining
    // child uses never installs the proxy and the cap is inert for
    // the ingest phase (the Codex agent gets the cap via its own
    // `.codex/config.toml` argv).
    process.env["LORE_MCP_WRITE_BUDGET"] = String(input.perExampleWrites)
    process.env["LORE_MCP_BUDGET_STATE_FILE"] = budgetStateFile
    await buildBenchWorkspace({
      workspace,
      budgetStateFile,
      perExampleWrites: input.perExampleWrites,
    })

    // Mining children cwd into LORE_BENCH_CONFIG_ROOT so their
    // upward `.lore.yaml` walk hits the bench config. `buildSafeEnv`
    // does not forward `LORE_CONFIG_ROOT`, so the cwd is the only
    // discovery channel for the mining child.
    const miningCwd = process.env["LORE_BENCH_CONFIG_ROOT"] ?? workspace
    let ingest: BenchIngestResult
    if (input.ingestionStrategy === "raw-transcript") {
      ingest = await runBenchRawTranscriptIngest({
        example: input.example,
        projectId,
        perExampleWrites: input.perExampleWrites,
        createMemoryInProject: input.sandbox.createMemoryInProject,
        countMemoriesForProject: input.sandbox.countMemoriesForProject,
        countFactsForProject: input.sandbox.countFactsForProject,
      })
    } else if (input.ingestionStrategy === "simulated-autosave") {
      if (!input.extractionPrompt || !input.extractionClient) {
        throw new Error(
          "simulated-autosave ingestion requires extractionPrompt and extractionClient"
        )
      }
      ingest = await runBenchSimulatedAutosaveIngest({
        example: input.example,
        projectId,
        perExampleWrites: input.perExampleWrites,
        extractionPrompt: input.extractionPrompt,
        extractionClient: input.extractionClient,
        extractionModel: input.extractionModel,
        extractionMaxTokens: input.extractionMaxTokens,
        tagVocabulary: input.tagVocabulary,
        createSimulatedAutosaveMemoryInProject:
          input.sandbox.createSimulatedAutosaveMemoryInProject,
        countMemoriesForProject: input.sandbox.countMemoriesForProject,
        countFactsForProject: input.sandbox.countFactsForProject,
      })
    } else {
      ingest = await runBenchIngest({
        example: input.example,
        cwd: miningCwd,
        subProjects: [projectName],
        catchAllName: null,
        budgetStateFile,
        projectId,
        authSource: input.sandbox.authSource,
        perSessionTimeoutMs: input.perSessionMiningTimeoutMs,
        countMemoriesForProject: input.sandbox.countMemoriesForProject,
        countFactsForProject: input.sandbox.countFactsForProject,
      })
    }

    const extractionMeasured = input.ingestionStrategy === "simulated-autosave"
    const extractionCostUsd = extractionMeasured
      ? computeExtractionCostUsd(
          ingest.extractionUsage,
          getModelPricing(
            input.pricing,
            input.extractionModel ?? SIMULATED_AUTOSAVE_EXTRACTION_MODEL
          )
        )
      : 0
    const ingestion = exampleIngestionFromResult({
      ingest,
      extractionCostUsd,
      extractionMeasured,
    })

    const ingestionFailureReason = ingestFailureToReason(ingest)
    if (ingestionFailureReason) {
      result = {
        exampleId: input.example.question_id,
        category: input.example.question_type as LongMemEvalCategory,
        success: false,
        failureReason: ingestionFailureReason,
        cleanupFailure: null,
        ingestion,
        agent: {
          elapsedMs: 0,
          tokensPrompt: 0,
          tokensCachedPrompt: 0,
          tokensCompletion: 0,
          tokensReasoningOutput: 0,
          toolCalls: 0,
          answer: "",
          costMeasurement: COST_MEASUREMENT_CODEX_REPORTED,
        },
        judge: {
          promptKind: "recall",
          verdict: null,
          rationale: "",
          tokensPromptCached: 0,
          elapsedMs: 0,
          tokensPrompt: 0,
          tokensCompletion: 0,
        },
      }
    } else {
      // `wake-up-prefetch` strategy: fetch the relevance-ranked
      // memory bundle BEFORE invoking the agent and inject it as a
      // prompt addendum the agent reads inline. No MCP tool calls
      // required, which sidesteps the Codex 0.128.0
      // MCP-not-loaded-in-exec gap. See `BenchSandbox.getWakeUpForQuery`
      // and `BENCH_AGENT_RETRIEVAL_STRATEGIES` for the full
      // rationale.
      let wakeUpContext = ""
      if (input.agentRetrieval === "wake-up-prefetch") {
        try {
          wakeUpContext = await input.sandbox.getWakeUpForQuery({
            projectId,
            userQuery: input.example.question,
          })
        } catch (err) {
          input.log.warn(
            `wake-up prefetch failed for ${input.example.question_id}: ${err instanceof Error ? err.message : String(err)}`
          )
          // Continue with empty context; the agent will see only the
          // system prompt + question and likely abstain. The
          // failure surfaces in the artifact via empty / abstain
          // answers rather than masking as a different failure mode.
        }
      }
      const promptSections = [
        input.systemPrompt,
        ...(wakeUpContext.length > 0 ? [wakeUpContext] : []),
        input.example.question,
      ]
      const agentT0 = performance.now()
      const agentResult = await input.agentAdapter.run({
        prompt: promptSections.join("\n\n"),
        workspace,
        timeoutMs: input.agentTimeoutMs,
      })
      const agentElapsedMs = Math.round(performance.now() - agentT0)
      const parsed = parseAgentTurnCompleted(agentResult.stdout)
      const rawAnswer = await readAnswerFile(workspace)
      // Strip bearer-shaped substrings BEFORE the judge sees the
      // answer, BEFORE the answer lands in the artifact, BEFORE any
      // downstream PR-comment renderer reads it. See
      // `redactBearerTokens` docstring for the threat model.
      const answer = redactBearerTokens(rawAnswer)
      const agentFailureReason = agentFailureToReason(agentResult, parsed, answer)
      if (agentFailureReason) {
        result = {
          exampleId: input.example.question_id,
          category: input.example.question_type as LongMemEvalCategory,
          success: false,
          failureReason: agentFailureReason,
          cleanupFailure: null,
          ingestion,
          agent: {
            elapsedMs: agentElapsedMs,
            tokensPrompt: parsed.usage?.input_tokens ?? 0,
            tokensCachedPrompt: parsed.usage?.cached_input_tokens ?? 0,
            tokensCompletion: parsed.usage?.output_tokens ?? 0,
            tokensReasoningOutput: parsed.usage?.reasoning_output_tokens ?? 0,
            toolCalls: parsed.toolCalls,
            answer,
            costMeasurement: COST_MEASUREMENT_CODEX_REPORTED,
          },
          judge: {
            promptKind: "recall",
            verdict: null,
            rationale: "",
            tokensPromptCached: 0,
            elapsedMs: 0,
            tokensPrompt: 0,
            tokensCompletion: 0,
          },
        }
      } else {
        const promptKind = selectJudgePromptKind(
          input.example.question_type as LongMemEvalCategory
        )
        const judgeResult = await runJudge({
          promptKind,
          prompts: input.judgePrompts,
          question: input.example.question,
          reference: input.example.answer,
          answer,
          client: input.judgeClient,
        })
        const judgeFailureReason: BenchFailureReason | null =
          judgeResult.verdict === null ? "judge-error" : null
        const success = judgeFailureReason === null && judgeResult.verdict === "correct"
        result = {
          exampleId: input.example.question_id,
          category: input.example.question_type as LongMemEvalCategory,
          success,
          failureReason: judgeFailureReason,
          cleanupFailure: null,
          ingestion,
          agent: {
            elapsedMs: agentElapsedMs,
            tokensPrompt: parsed.usage?.input_tokens ?? 0,
            tokensCachedPrompt: parsed.usage?.cached_input_tokens ?? 0,
            tokensCompletion: parsed.usage?.output_tokens ?? 0,
            tokensReasoningOutput: parsed.usage?.reasoning_output_tokens ?? 0,
            toolCalls: parsed.toolCalls,
            answer,
            costMeasurement: COST_MEASUREMENT_CODEX_REPORTED,
          },
          judge: {
            promptKind: judgeResult.promptKind,
            verdict: judgeResult.verdict,
            // Judge rationale can echo the model answer; redact at
            // the artifact boundary so a leaked-bearer answer
            // doesn't double-print into the rationale field.
            rationale: redactBearerTokens(judgeResult.rationale),
            elapsedMs: judgeResult.elapsedMs,
            tokensPrompt: judgeResult.tokensPrompt,
            tokensPromptCached: judgeResult.tokensPromptCached,
            tokensCompletion: judgeResult.tokensCompletion,
          },
        }
      }
    }
  } finally {
    // Restore the operator's pre-example env for the
    // LORE_MCP_WRITE_BUDGET / LORE_MCP_BUDGET_STATE_FILE pair so a
    // non-bench consumer running later in the same Node process
    // doesn't inherit them. The pair was intentionally mutated for
    // the mining child's `buildSafeEnv` forward; this restore puts
    // it back exactly.
    if (priorBudgetEnv === undefined) delete process.env["LORE_MCP_WRITE_BUDGET"]
    else process.env["LORE_MCP_WRITE_BUDGET"] = priorBudgetEnv
    if (priorBudgetStateEnv === undefined)
      delete process.env["LORE_MCP_BUDGET_STATE_FILE"]
    else process.env["LORE_MCP_BUDGET_STATE_FILE"] = priorBudgetStateEnv
    // BOTH workspace cleanup AND project archive belong in this
    // finally so a synchronous throw inside the work (e.g. a fault
    // between `createSubProject` and the `result` assignment) cannot
    // leave the per-example project orphaned. The cleanup-orphans CLI
    // exists for the residual case, but every example-throw that
    // reaches this `finally` archives the project promptly.
    if (workspace && !input.keepWorkspaces) {
      try {
        await rm(workspace, { recursive: true, force: true })
      } catch (err) {
        input.log.warn(
          `workspace cleanup failed for ${workspace}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
    try {
      await input.sandbox.archiveProject(projectId)
    } catch (err) {
      const message = `teardown-error: ${err instanceof Error ? err.message : String(err)}`
      if (result) {
        result.cleanupFailure = message
      } else {
        // No `result` yet means the inner work threw before assigning
        // one. The throw is about to propagate from `finally`; emit a
        // diagnostic so the orphaned-archive failure is observable
        // even when we cannot stamp it on a result.
        input.log.warn(
          `archive cleanup failed for ${projectId} after pre-result throw: ${message}`
        )
      }
    }
  }
  if (!result) {
    // Unreachable in steady-state: the inner work paths either set
    // `result` or throw (the throw propagates from `finally` above).
    // This branch covers the case where a finally cleanup *swallowed*
    // a synchronous throw — the function still needs to return
    // something typed.
    throw new Error(
      `runBenchExample: inner work did not set a result for example ${input.example.question_id}`
    )
  }
  return result
}

/**
 * Top-level entry — runs the full corpus end-to-end and emits a
 * `BenchRunArtifact` to disk.
 *
 * The function is intentionally sequential per example. Concurrent
 * examples would race on the suite-wide write cap and the cost cap;
 * sequencing keeps both caps interpretable.
 */
export async function runBenchSuite(options: RunBenchOptions): Promise<RunBenchResult> {
  const envSnapshot = assertBenchEnvReady()
  try {
    return await runBenchSuiteUnderBenchEnv(options)
  } finally {
    restoreBenchEnv(envSnapshot)
  }
}

async function runBenchSuiteUnderBenchEnv(
  options: RunBenchOptions
): Promise<RunBenchResult> {
  // Validate the parent sandbox project name once before any
  // per-example work. Sub-projects inherit the safety guarantee from
  // being created under this parent.
  assertSandboxProjectName(process.env["LORE_BENCH_SANDBOX_PROJECT_NAME"] ?? "")
  const loadedSuite = await loadBenchSuite(options.suitePath)
  const suite = loadedSuite.suite
  const profile = suite.profile
    ? resolveProfileFromConfig({ profile: suite.profile.selector })
    : null
  assertBenchSandboxProfileMatchesSuite({
    sandbox: options.sandbox,
    profile,
  })
  // Asset paths in the suite YAML may be absolute (operator-supplied
  // smoke suites) or repo-relative (the committed
  // evals/bench-suites/longmemeval.yaml). Absolute paths bypass the
  // base; relative paths resolve against the repo root inferred from
  // the suite's location (walk up until we find a sibling `evals/`
  // directory). Falls back to `process.cwd()` when the walk fails so
  // the production invocation from the repo root still works.
  const repoRoot = await findRepoRoot(loadedSuite.path)
  const resolveAsset = (assetPath: string): string => resolve(repoRoot, assetPath)
  const pricing =
    options.pricing ??
    (await loadBenchPricing(
      process.env["LORE_BENCH_PRICING_PATH"] ?? resolveAsset("evals/bench/pricing.json")
    ))
  const judgePrompts =
    options.judgePrompts ??
    (await loadJudgePrompts({
      recallPath: resolveAsset(suite.judge.recallPrompt),
      abstentionPath: resolveAsset(suite.judge.abstentionPrompt),
    }))
  const corpus =
    options.corpus ??
    (await loadBenchCorpus({
      name: suite.corpus.name,
      corpusPath: resolveAsset(suite.corpus.path),
    }))
  const systemPromptPath = resolveAsset(suite.agent.systemPrompt)
  const systemPrompt = await readFile(systemPromptPath, "utf-8")
  const systemPromptSha256 = sha256Hex(systemPrompt)
  const extractionPromptPath =
    suite.ingestion.strategy === "simulated-autosave"
      ? suite.ingestion.extractionPrompt
      : undefined
  const extractionPrompt = extractionPromptPath
    ? await readFile(resolveAsset(extractionPromptPath), "utf-8")
    : null
  const extractionPromptSha256 = extractionPrompt ? sha256Hex(extractionPrompt) : null
  const judgeClient =
    options.judgeClient ??
    new FetchOpenAIChatClient(process.env["LORE_BENCH_OPENAI_API_KEY"] ?? "")
  const extractionClient =
    options.extractionClient ??
    new FetchBenchExtractionClient(process.env["LORE_BENCH_OPENAI_API_KEY"] ?? "")
  const agentAdapter = options.agentAdapter ?? new CodexAgentAdapter()
  const now = options.now ?? (() => new Date())
  const startedAt = now().toISOString()
  const runId = generateUlid(now().getTime())
  const log = defaultLogSink

  let examples = corpus.examples
  if (typeof options.limit === "number" && options.limit < examples.length) {
    // Reject smoke writes landing under any `evals/baselines/` dir.
    // `includes("/baselines/")` admitted `/tmp/x/baselines2/foo.json`
    // and rejected `/tmp/baselines-experiment.json` based on substring
    // luck; pathname-aware check fires iff the immediate parent dir
    // basename is `baselines`. `path.basename` is the portable
    // equivalent — handles trailing-slash paths and Windows
    // separators identically; the prior `split("/").pop()` shape only
    // worked on POSIX.
    if (options.outPath) {
      // `resolve` already canonicalizes a trailing slash, but be
      // explicit so a future caller passing `<dir>/` doesn't
      // accidentally split into an empty basename.
      const parent = resolve(options.outPath, "..")
      if (basename(parent) === "baselines") {
        throw new Error(
          "--limit is rejected when --out writes into an evals/baselines/ directory; smoke runs cannot baseline."
        )
      }
    }
    // Deterministic seeded shuffle would be nice; for V1, prefix slice.
    examples = examples.slice(0, options.limit)
  }

  const config = {
    ...(profile ? { profile: benchProfileConfig(profile) } : {}),
    corpus: {
      name: corpus.name,
      source: "huggingface",
      repository: corpus.repository,
      revision: corpus.revision,
      sha256: corpus.sha256,
    },
    agent: {
      model: BENCH_AGENT_MODEL,
      adapter: "codex",
      systemPromptSha256,
      retrieval: suite.agent.retrieval,
    },
    judge: {
      model: JUDGE_MODEL,
      temperature: JUDGE_TEMPERATURE,
      // `seed` and `maxTokens` are sent on every judge call (see
      // `bench-judge.ts`'s OpenAI request body), so they alter the
      // judge's verdict distribution and MUST participate in the
      // config hash. A future bump to either forces a baseline
      // re-capture by design.
      seed: JUDGE_SEED,
      maxTokens: JUDGE_MAX_TOKENS,
      promptShas: {
        recall: judgePrompts.recallSha256,
        abstention: judgePrompts.abstentionSha256,
      },
    },
    ingestion: {
      strategy: suite.ingestion.strategy,
      // Seam name reflects the chosen strategy so artifact consumers
      // see exactly which path produced the row counts.
      seam:
        suite.ingestion.strategy === "raw-transcript"
          ? "raw-transcript"
          : suite.ingestion.strategy === "simulated-autosave"
            ? "structured-extract-create-with-auto-mentions"
            : "runConversationMining",
      temporalApproach: "C-caveat-only",
      vault: "bench-sandbox",
      ...(suite.ingestion.strategy === "simulated-autosave"
        ? {
            extractionModel:
              suite.ingestion.extractionModel ?? SIMULATED_AUTOSAVE_EXTRACTION_MODEL,
            extractionPromptSha256: extractionPromptSha256 ?? "",
            extractionTemperature: SIMULATED_AUTOSAVE_EXTRACTION_TEMPERATURE,
            extractionMaxTokens:
              suite.ingestion.extractionMaxTokens ??
              SIMULATED_AUTOSAVE_EXTRACTION_MAX_TOKENS,
            extractionSchemaVersion: SIMULATED_AUTOSAVE_EXTRACTION_SCHEMA_VERSION,
          }
        : {}),
    },
    // Suite write caps participate in the hash because they shape
    // run behavior: `perExampleWrites` installs the MCP-child write-
    // budget cap AND the raw-transcript loop's per-example halt
    // threshold (changing it shifts ingestion completeness on
    // examples whose haystack size approaches the cap); `perSuiteWrites`
    // controls when the runner aborts mid-suite. A future cap retune
    // can change scoring denominator and abort behavior — drift gate
    // #1 must catch that.
    caps: {
      perExampleWrites: suite.caps.perExampleWrites,
      perSuiteWrites: suite.caps.perSuiteWrites,
    },
  }
  const configHash = computeConfigHash(config)

  const results: BenchExampleResult[] = []
  const cleanupFailures: string[] = []
  const failureBreakdown = emptyFailureBreakdown()
  const byCategory = buildEmptyByCategory()
  let suiteWriteCount = 0
  let aborted = false
  let abortReason: string | null = null

  const agentPricing = getModelPricing(pricing, BENCH_AGENT_MODEL)
  const judgePricing = getModelPricing(pricing, JUDGE_MODEL)
  const costCapRaw = process.env["LORE_EVAL_BENCH_MAX_USD"] ?? "75"
  // Strict decimal-number parse. `Number.parseFloat` admits trailing
  // junk (`75oops` → `75`); the bench's cost gate must reject any
  // input that isn't entirely numeric so a typo doesn't silently
  // disable the cap.
  if (!/^\d+(\.\d+)?$/.test(costCapRaw)) {
    throw new Error(
      `LORE_EVAL_BENCH_MAX_USD must be a positive decimal number, got "${costCapRaw}"`
    )
  }
  const costCapUsd = Number.parseFloat(costCapRaw)
  if (!Number.isFinite(costCapUsd) || costCapUsd <= 0) {
    throw new Error(
      `LORE_EVAL_BENCH_MAX_USD must be a positive finite number, got "${costCapRaw}"`
    )
  }

  let agentUsdSoFar = 0
  let judgeUsdSoFar = 0
  let extractionUsdSoFar = 0
  let totalSessionsIngested = 0

  for (const example of examples) {
    // `perSuiteWrites` is the inclusive ceiling — a suite hitting
    // exactly the cap on the closing example proceeds to scoring but
    // the next example does NOT start. Strict-geq matches that
    // semantics; `>` would allow one more example past parity.
    if (suiteWriteCount >= suite.caps.perSuiteWrites) {
      aborted = true
      abortReason = `per-suite write cap ${suite.caps.perSuiteWrites} reached`
      log.warn(abortReason)
      break
    }
    const ingestionEstimatedUsd =
      suite.ingestion.strategy === "simulated-autosave"
        ? 0
        : estimateIngestionCostUsd(totalSessionsIngested, pricing)
    if (
      Number.isFinite(costCapUsd) &&
      projectedTotalUsd({
        agentUsdSoFar,
        judgeUsdSoFar,
        extractionUsdSoFar,
        ingestionEstimatedUsdSoFar: ingestionEstimatedUsd,
      }) >= costCapUsd
    ) {
      aborted = true
      abortReason = `cost cap ${costCapUsd} USD reached`
      log.warn(abortReason)
      break
    }
    log.info(
      `example ${example.question_id} (${example.question_type}) — ${results.length + 1}/${examples.length}`
    )
    const result = await runBenchExample({
      example,
      runId,
      pricing,
      judgePrompts,
      judgeClient,
      agentAdapter,
      sandbox: options.sandbox,
      perExampleWrites: suite.caps.perExampleWrites,
      ingestionStrategy: suite.ingestion.strategy,
      extractionPrompt: extractionPrompt ?? undefined,
      extractionClient,
      extractionModel: suite.ingestion.extractionModel,
      extractionMaxTokens: suite.ingestion.extractionMaxTokens,
      tagVocabulary: profile?.taxonomy.tags,
      agentRetrieval: suite.agent.retrieval,
      systemPrompt,
      perSessionMiningTimeoutMs: options.perSessionMiningTimeoutMs,
      agentTimeoutMs: options.agentTimeoutMs ?? 5 * 60 * 1000,
      keepWorkspaces: options.keepWorkspaces ?? false,
      log,
    })
    results.push(result)
    if (result.cleanupFailure) {
      cleanupFailures.push(`${result.exampleId}: ${result.cleanupFailure}`)
    }
    suiteWriteCount += result.ingestion.notionWrites
    totalSessionsIngested += example.haystack_sessions.length
    if (result.agent.tokensPrompt > 0 || result.agent.tokensCompletion > 0) {
      agentUsdSoFar += computeAgentCostUsd(
        {
          input_tokens: result.agent.tokensPrompt,
          cached_input_tokens: result.agent.tokensCachedPrompt,
          output_tokens: result.agent.tokensCompletion,
          reasoning_output_tokens: result.agent.tokensReasoningOutput,
        },
        agentPricing
      )
    }
    judgeUsdSoFar += computeJudgeCostUsd(
      {
        promptTokens: result.judge.tokensPrompt,
        cachedPromptTokens: result.judge.tokensPromptCached,
        completionTokens: result.judge.tokensCompletion,
      },
      judgePricing
    )
    extractionUsdSoFar += result.ingestion.extractionCostUsd
    const stat = byCategory[result.category]
    if (stat) {
      stat.n += 1
      if (result.success) stat.correct += 1
      stat.accuracy = stat.n > 0 ? stat.correct / stat.n : 0
    }
    const reason: BenchFailureReason | "no-failure" = result.failureReason ?? "no-failure"
    failureBreakdown[reason] = (failureBreakdown[reason] ?? 0) + 1
  }

  const totalExamples = examples.length
  const scoredExamples = results.filter(
    (r) => r.judge.verdict !== null && r.failureReason !== "judge-error"
  ).length
  const correct = results.filter((r) => r.success).length
  const accuracy = scoredExamples > 0 ? correct / scoredExamples : 0
  const finishedAt = now().toISOString()

  const agentElapsed = results.map((r) => r.agent.elapsedMs)
  const ingestionElapsed = results.map((r) => r.ingestion.elapsedMs)
  const judgeElapsed = results.map((r) => r.judge.elapsedMs)
  const ingestionEstimatedUsd =
    suite.ingestion.strategy === "simulated-autosave"
      ? 0
      : estimateIngestionCostUsd(totalSessionsIngested, pricing)

  const summary: BenchSummary = {
    configHash,
    totalExamples,
    scoredExamples,
    temporalFidelityCaveat: TEMPORAL_FIDELITY_CAVEAT,
    diagnosticCountCaveat: DIAGNOSTIC_COUNT_CAVEAT,
    byCategory,
    overall: {
      n: totalExamples,
      scoredN: scoredExamples,
      correct,
      accuracy,
      ingestion: {
        p50Ms: percentile(ingestionElapsed, 50),
        p95Ms: percentile(ingestionElapsed, 95),
        totalNotionWrites: suiteWriteCount,
      },
      agent: {
        p50Ms: percentile(agentElapsed, 50),
        p95Ms: percentile(agentElapsed, 95),
      },
      judge: {
        p50Ms: percentile(judgeElapsed, 50),
        p95Ms: percentile(judgeElapsed, 95),
      },
      cost: {
        agentUsd: round2(agentUsdSoFar),
        judgeUsd: round2(judgeUsdSoFar),
        extractionUsd: round2(extractionUsdSoFar),
        runnerMeasuredUsd: round2(agentUsdSoFar + judgeUsdSoFar + extractionUsdSoFar),
        ingestionEstimatedUsd: round2(ingestionEstimatedUsd),
        totalEstimatedUsd: round2(
          agentUsdSoFar + judgeUsdSoFar + extractionUsdSoFar + ingestionEstimatedUsd
        ),
      },
    },
    failureBreakdown,
    cleanupFailures,
    aborted,
    abortReason,
  }

  const artifact: BenchRunArtifact = {
    suite: suite.suite,
    benchmark: "longmemeval",
    runner: "bench",
    runId,
    config,
    startedAt,
    finishedAt,
    results,
    summary,
  }

  // Validate the runner has not silently drifted from the suite schema.
  // The cheap re-parse of the suite is a regression guard, not a write.
  benchSuiteSchema.parse(loadedSuite.suite)

  const outPath = resolve(
    options.outPath ?? resolveAsset(`evals/results/bench-${runId}.json`)
  )
  await mkdir(resolve(outPath, ".."), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")

  return { artifact, outPath }
}

function benchProfileConfig(profile: ResolvedProfile) {
  const promptHashes: Record<string, string> = {}
  for (const [key, prompt] of Object.entries(profile.prompts)) {
    promptHashes[key] = sha256Hex(prompt.text)
  }
  return {
    selector: profile.selector,
    name: profile.name,
    version: profile.version,
    source: profile.source,
    manifestDigest: profile.manifestDigest,
    promptHashes,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Walk upward from the suite path looking for the Lore repo root.
 * Found when the directory contains a `package.json` whose `name` is
 * `@makenotion/lore`. Falls back to `process.cwd()` so a suite YAML
 * authored outside the repo (smoke runs, ad-hoc operator runs) still
 * resolves its asset paths against the cwd if the cwd is the repo
 * root.
 */
async function findRepoRoot(suitePath: string): Promise<string> {
  let dir = resolve(suitePath)
  // First step up from the suite YAML file to its containing dir.
  dir = resolve(dir, "..")
  for (let i = 0; i < 12; i += 1) {
    const pkgPath = join(dir, "package.json")
    try {
      const text = await readFile(pkgPath, "utf-8")
      const parsed = JSON.parse(text) as { name?: unknown }
      if (parsed.name === "@makenotion/lore") return dir
    } catch {
      // keep walking
    }
    const parent = resolve(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

/**
 * Internal helper for tests / orphan-cleanup CLI — re-exports the
 * sub-project name regex so callers can scan for matching names.
 * Crockford base32, 26 char ULID suffix.
 */
export const SUB_PROJECT_NAME_REGEX = new RegExp(`^lme-.+-${CROCKFORD_CHAR_CLASS}{26}$`)

/**
 * Parse the embedded ULID timestamp from a sub-project name. Returns
 * null when the name doesn't match `SUB_PROJECT_NAME_REGEX`. ULIDs
 * embed a 48-bit ms timestamp in the leading 10 Crockford-base32
 * chars; reverse via repeated multiply+lookup.
 */
export function ulidTimestampMs(ulid: string): number | null {
  if (!isUlid(ulid)) return null
  let ms = 0
  for (let i = 0; i < 10; i += 1) {
    const idx = CROCKFORD.indexOf(ulid[i] ?? "")
    if (idx < 0) return null
    ms = ms * 32 + idx
  }
  return ms
}

export function extractUlidFromSubProjectName(name: string): string | null {
  // `SUB_PROJECT_NAME_REGEX` already requires the trailing 26 ULID
  // chars; if the match passes, the last 26 chars ARE the ULID. The
  // regex is checked here, not at the slice site, so an `lme-foo` or
  // a non-bench name without a ULID suffix returns null.
  if (!SUB_PROJECT_NAME_REGEX.test(name)) return null
  return name.slice(-26)
}

/**
 * Filter a list of (name, id) sub-projects to those whose embedded
 * ULID timestamp is older than `cutoffMs`. Used by the
 * `lore eval bench cleanup-orphans` CLI.
 */
export function filterOrphanSubProjects(
  projects: Array<{ name: string; id: string }>,
  cutoffMs: number
): Array<{ name: string; id: string; ageMs: number }> {
  const out: Array<{ name: string; id: string; ageMs: number }> = []
  for (const project of projects) {
    const ulid = extractUlidFromSubProjectName(project.name)
    if (!ulid) continue
    const created = ulidTimestampMs(ulid)
    if (created === null) continue
    const ageMs = cutoffMs - created
    if (ageMs > 0) out.push({ name: project.name, id: project.id, ageMs })
  }
  return out
}

/**
 * Surface the canonical-JSON serializer so a downstream baseline
 * capture command can produce byte-identical `configHash` values from
 * an externally-loaded artifact.
 */
export { canonicalJsonStringify }
