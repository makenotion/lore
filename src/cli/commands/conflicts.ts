/**
 * `lore conflicts scan`.
 *
 * Walks the vault, runs candidate generation per project (delegated to
 * `findConflictCandidates`), filters out pairs already judged via
 * `Compared With`, and emits *prompt-ready* output the calling agent can
 * read and act on. The CLI does NOT call any LLM and does NOT call
 * `lore-memory action='compare'` — it produces structured material that
 * the agent reads and dispatches back via the compare tool.
 *
 * Engram's analog (`engram conflicts scan`) shells out to the user's
 * agent CLI via `ENGRAM_AGENT_CLI`. Lore's MCP server is invoked *by*
 * Claude Code already; the natural judge is the *current* Claude
 * session, not a fresh subprocess. So the design is inverted: the
 * scanner produces output the calling agent reads, judges, and
 * dispatches back via `lore-memory action='compare'`.
 */

import { Command } from "commander"
import { randomUUID } from "node:crypto"
import { initServices, type LoreServices } from "../../services.js"
import {
  CONFLICT_PAIR_LIMIT,
  findConflictCandidates,
  type ConflictCandidate,
} from "../../core/conflict.js"
import { dynamicCodeFence } from "../../core/markdown.js"
import {
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import { CONFLICT_JUDGE_PROMPT_VERSION } from "../../core/prompts/conflict-judge.js"
import { MEMORY_PROPS } from "../../notion/schema.js"
import {
  comparedPairKey,
  fetchAlreadyComparedPairKeys,
  isRunToolFilterSqlEnabled,
} from "../../notion/runtool/index.js"
import {
  isSqlValidationError,
  logRunToolFallback,
} from "../../notion/runtool/error-helpers.js"
import type { Memory } from "../../types.js"
import { parsePositiveDecimalInteger } from "../parse.js"

/**
 * Default raw-candidate cap passed into `findConflictCandidates`.
 * INTENTIONALLY larger than `--limit` / `CONFLICT_PAIR_LIMIT` so the
 * generator returns enough raw candidates to survive dedup +
 * already-judged filtering with `--limit` worth of survivors. If the
 * generator is given the same `--limit` the CLI surfaces, the post-filter
 * set could be < `--limit` even when more useful candidates exist — the
 * bug an earlier draft of this issue had.
 *
 * 500 is a starting point: comfortable above any realistic `--limit`
 * value while bounded enough that the per-project candidate accumulator
 * stays cheap. `findConflictCandidates` honors the cap as a true
 * top-K bound (see its docstring) so a high-overlap project allocates
 * O(raw-limit) `ConflictCandidate` objects, NOT O(N²) — the per-pair
 * similarity computation is still O(N²) (inherent to lexical-pair
 * comparison) but the memory blow-up is closed. Operators can raise this
 * with `--raw-limit` without going fully `--exhaustive`.
 */
export const SCAN_RAW_CANDIDATE_CAP = 500

/** Parsed and validated CLI flags. */
export interface ScanCliOptions {
  projectName: string | undefined
  limit: number
  rawLimit?: number
  includeBodies: boolean
  json: boolean
  exhaustive: boolean
}

/**
 * Validate CLI inputs. `--limit` must be a positive integer; `parseInt`'s
 * silent NaN fallback would otherwise let a malformed flag degrade to
 * `findConflictCandidates`'s default cap with no surface error.
 */
export function parseScanCliOptions(raw: {
  project?: string
  limit?: string
  rawLimit?: string
  includeBodies?: boolean
  json?: boolean
  exhaustive?: boolean
}): { ok: true; value: ScanCliOptions } | { ok: false; message: string } {
  let limit = CONFLICT_PAIR_LIMIT
  if (raw.limit !== undefined) {
    const parsedLimit = parsePositiveDecimalInteger("--limit", raw.limit)
    if (!parsedLimit.ok) return parsedLimit
    limit = parsedLimit.value
  }

  let rawLimit: number | undefined
  if (raw.rawLimit !== undefined) {
    const parsedRawLimit = parsePositiveDecimalInteger("--raw-limit", raw.rawLimit)
    if (!parsedRawLimit.ok) return parsedRawLimit
    rawLimit = parsedRawLimit.value
  }
  return {
    ok: true,
    value: {
      projectName: raw.project,
      limit,
      rawLimit,
      includeBodies: !!raw.includeBodies,
      json: !!raw.json,
      exhaustive: !!raw.exhaustive,
    },
  }
}

/** Per-pair output shape, shared by markdown and JSON renderers. */
export interface ScanPair {
  memoryA: ScanPairMemory
  memoryB: ScanPairMemory
  similarity: number
  signals: string[]
}

export interface ScanPairMemory {
  id: string
  title: string
  project: string
  kind: string
  confidence: string
  confidenceScore: number | null
  synopsis: string
  keywords: string[]
  /** Present only when --include-bodies. */
  body?: string
}

export interface ScanReport {
  scanId: string
  scannedAt: string
  promptVersion: string
  stats: ScanStats
  pairs: ScanPair[]
}

export interface ScanStats {
  rawCandidateLimit: number | null
  rawCandidateLimitReached: boolean
  rawCandidateLimitReachedProjects: string[]
  rawCandidates: number
  dedupedCandidates: number
  alreadyJudgedCandidates: number
  survivingCandidates: number
}

/**
 * Project context attached to each candidate so the renderer can name a
 * specific project per pair. `findConflictCandidates` produces pairs
 * scoped to a single project's memory list, so we stamp the project
 * label at generation time and carry it through dedup / filter / sort.
 */
interface ProjectScopedCandidate {
  candidate: ConflictCandidate
  projectLabel: string
}

/**
 * Project resolution for the scan: `projects[i].id` aligns with
 * `projects[i].label`. Resolved by `resolveScanProjects` from the CLI
 * options against `services.projects.list()`. Exported so the unit test
 * can assert on the project-mismatch error path without standing up a
 * full Notion stub for the scan pipeline.
 */
export interface ScanProjectRef {
  id: string
  label: string
}

export async function resolveScanProjects(
  services: LoreServices,
  projectName: string | undefined
): Promise<ScanProjectRef[]> {
  const explicitProjectName = validateExplicitProjectScopeName(projectName, "--project", {
    listHint: "run `lore status projects` to list configured projects",
  })
  if (explicitProjectName !== undefined) {
    const found = await resolveProjectScopeName(
      services.projects,
      explicitProjectName,
      "--project",
      {
        listHint: "run `lore status projects` to list configured projects",
      }
    )
    return [{ id: found.id, label: found.name }]
  }
  // Scope all-projects scans to active projects. `lore status projects`
  // uses `-a` to *opt in* to archived projects — the inverted default
  // is the established convention; archived projects walking through
  // the conflict-scan pipeline pays for paginated `Memory` walks
  // against retired contexts that produce zero useful candidates.
  const all = await services.projects.list("active")
  return all.map((p) => ({ id: p.id, label: p.name }))
}

/**
 * Run the scan pipeline end-to-end.
 *
 * Pipeline: `list → generate → dedup → filter → sort → truncate → render`.
 *
 * Order matters: filtering before truncation ensures `--limit` budgets
 * the *useful* candidate set, not the raw set. An earlier draft of this
 * issue documented the filter in prose but never folded it into the
 * primary pipeline, leaving the runScan implementation incorrect.
 */
export async function runScan(
  services: LoreServices,
  opts: ScanCliOptions,
  log: (msg: string) => void = (msg) => process.stderr.write(msg + "\n")
): Promise<ScanReport> {
  if (opts.exhaustive && opts.rawLimit !== undefined) {
    log("--raw-limit is ignored when --exhaustive is set; using exhaustive scan.")
  }

  const projects = await resolveScanProjects(services, opts.projectName)

  // 1. List memories per project. `listForScan` strict-scopes by project
  //    (an unscoped repo-wide row is NOT a candidate for "conflicts in
  //    project X" because it doesn't carry X's identity); the candidate
  //    generator then intersects projectIds per-pair anyway, so dropping
  //    unscoped rows here costs nothing.
  const memoriesByProject = await services.memories.listForScan({
    projectIds: projects.map((p) => p.id),
    projectLabels: projects.map((p) => p.label),
    includeBodies: opts.includeBodies,
    onProgress: ({ projectLabel, pageIndex, runningTotal }) => {
      log(
        `Scanning project '${projectLabel}': page ${pageIndex}, ${runningTotal} memories…`
      )
    },
  })

  // 2. For each project, run findConflictCandidates with the raw
  //    coverage cap (NOT --limit). The generator's pairLimit is its
  //    internal sort+truncate budget; passing --limit here would
  //    pre-truncate before dedup and the already-judged filter run,
  //    leaving the final surfaced set too small.
  //
  //    Under `--exhaustive`, pass `pairLimit: Number.POSITIVE_INFINITY`
  //    — the explicit unbounded sentinel per `findConflictCandidates`'s
  //    contract. Omitting the option entirely would default to
  //    CONFLICT_PAIR_LIMIT = 50 — explicitly the wrong behavior for
  //    `--exhaustive`. The cap exists for CPU/memory safety on large
  //    vaults; `--raw-limit` lets operators raise that bounded window
  //    after already-judged pairs consume the default 500. Bounded
  //    scans request one extra sentinel candidate so the renderer can
  //    distinguish exact exhaustion from "more candidates exist past
  //    this window"; the sentinel is dropped before dedup/filter/render.
  const rawCandidateLimit = opts.rawLimit ?? SCAN_RAW_CANDIDATE_CAP
  const generatorPairLimit = opts.exhaustive
    ? Number.POSITIVE_INFINITY
    : sentinelPairLimit(rawCandidateLimit)
  const rawCandidates: ProjectScopedCandidate[] = []
  const rawCandidateLimitReachedProjects: string[] = []
  for (let i = 0; i < memoriesByProject.length; i++) {
    const memories = memoriesByProject[i]!
    const projectLabel = projects[i]!.label
    const projectCandidatesWithSentinel = findConflictCandidates(memories, {
      pairLimit: generatorPairLimit,
    })
    const rawLimitReached =
      !opts.exhaustive && projectCandidatesWithSentinel.length > rawCandidateLimit
    if (rawLimitReached) {
      rawCandidateLimitReachedProjects.push(projectLabel)
    }
    const projectCandidates = rawLimitReached
      ? projectCandidatesWithSentinel.slice(0, rawCandidateLimit)
      : projectCandidatesWithSentinel
    // The extra candidate is a sentinel only: dropping it preserves the
    // requested bounded memory window. The cap-hit stats tell operators
    // to raise `--raw-limit` when that next candidate might matter.
    for (const c of projectCandidates) {
      rawCandidates.push({ candidate: c, projectLabel })
    }
  }

  // 3. Dedup pairs across projects. `listForScan` groups by project, so
  //    a pair of memories sharing TWO projects (memory A in [X, Y] and
  //    memory B in [X, Y]) gets paired once under X's group AND once
  //    under Y's group — producing two ConflictCandidate entries for
  //    the same pair. Dedup by unordered pair key so each pair appears
  //    at most once in the output.
  const seen = new Set<string>()
  const dedupedCandidates: ProjectScopedCandidate[] = []
  for (const entry of rawCandidates) {
    const { memoryA, memoryB } = entry.candidate
    const [lo, hi] =
      memoryA.id < memoryB.id ? [memoryA.id, memoryB.id] : [memoryB.id, memoryA.id]
    const key = `${lo}::${hi}`
    if (seen.has(key)) continue
    seen.add(key)
    dedupedCandidates.push(entry)
  }

  // 4. Apply the already-judged filter: drop pairs where either side
  //    names the other in `comparedWith`. The candidate generator
  //    deliberately does NOT filter here — state-aware filtering
  //    belongs to the caller (this CLI).
  //
  //    SQL path: when `LORE_USE_RUNTOOL_FILTER_SQL=1` and a
  //    RunTool wrapper is wired, pre-build the set of already-compared
  //    pair-keys via one targeted SQL query per project that
  //    server-side narrows to rows whose `Compared With` is non-empty
  //    (typically a small subset of the project's memories), then
  //    O(1) Set lookup in JS. The structural win is the SQL query
  //    pulls only judged rows instead of inheriting `comparedWith`
  //    data via the broader `listForScan` walk; on a vault where
  //    most memories have never been compared, this drops the judged-
  //    pair fetch from O(N) to O(K) where K is the count of judged
  //    rows. Pair-key membership uses unordered keys
  //    (`<lo>::<hi>`) so it agrees with the JS `comparedWith.includes`
  //    check on both sides.
  //
  //    Failure model is identical to the entity / near-dup paths:
  //    validation errors propagate to the operator (query-shape
  //    drift); transient kinds fall back to JS comparedWith-includes
  //    silently. `Compared With` data is loaded eagerly by
  //    `pageToMemory` via `listForScan` regardless, so the JS
  //    fallback always has the data it needs.
  const sqlPairs = isRunToolFilterSqlEnabled() ? new Set<string>() : null
  if (sqlPairs) {
    for (const project of projects) {
      try {
        const projectPairs = await fetchAlreadyComparedPairKeys(services.client, {
          dataSourceId: services.vault.databases.memories.dataSourceId,
          projectProperty: MEMORY_PROPS.PROJECT,
          comparedWithProperty: MEMORY_PROPS.COMPARED_WITH,
          projectId: project.id,
        })
        for (const key of projectPairs) sqlPairs.add(key)
      } catch (err) {
        if (isSqlValidationError(err)) throw err
        logRunToolFallback("conflict-already-compared", err)
        // SQL pre-fetch failed for this project; rely on the JS
        // fallback below for every pair under any project.
        sqlPairs.clear()
        // Mark sqlPairs as invalid so the JS fallback runs uniformly
        // across projects (mixing SQL-backed and JS-backed lookups
        // within a single scan would be inconsistent under a
        // partial 5xx).
        break
      }
    }
  }

  const filteredCandidates = dedupedCandidates.filter(({ candidate }) => {
    if (sqlPairs && sqlPairs.size > 0) {
      const key = comparedPairKey(candidate.memoryA.id, candidate.memoryB.id)
      if (sqlPairs.has(key)) return false
    }
    return (
      !candidate.memoryA.comparedWith.includes(candidate.memoryB.id) &&
      !candidate.memoryB.comparedWith.includes(candidate.memoryA.id)
    )
  })
  const alreadyJudgedCandidates = dedupedCandidates.length - filteredCandidates.length

  // 5. Sort across projects by similarity desc; truncate to `--limit`
  //    (the surfaced cap, distinct from SCAN_RAW_CANDIDATE_CAP). This
  //    is the only place the operator-facing limit applies — by the
  //    time we get here, the candidate set is post-dedup, post-filter,
  //    so `--limit` budgets the *useful* candidates.
  filteredCandidates.sort((a, b) => b.candidate.similarity - a.candidate.similarity)
  const surfaced = filteredCandidates.slice(0, opts.limit)

  // 6. Build the wire-shape report.
  const pairs: ScanPair[] = surfaced.map(({ candidate, projectLabel }) => ({
    memoryA: toScanPairMemory(candidate.memoryA, projectLabel, opts.includeBodies),
    memoryB: toScanPairMemory(candidate.memoryB, projectLabel, opts.includeBodies),
    similarity: candidate.similarity,
    signals: candidate.signals,
  }))

  return {
    scanId: randomUUID(),
    scannedAt: new Date().toISOString(),
    promptVersion: CONFLICT_JUDGE_PROMPT_VERSION,
    stats: {
      rawCandidateLimit: opts.exhaustive ? null : rawCandidateLimit,
      rawCandidateLimitReached: rawCandidateLimitReachedProjects.length > 0,
      rawCandidateLimitReachedProjects,
      rawCandidates: rawCandidates.length,
      dedupedCandidates: dedupedCandidates.length,
      alreadyJudgedCandidates,
      survivingCandidates: filteredCandidates.length,
    },
    pairs,
  }
}

function sentinelPairLimit(rawLimit: number): number {
  // Defend against overflow if a non-CLI caller bypasses parse validation.
  return rawLimit >= Number.MAX_SAFE_INTEGER ? rawLimit : rawLimit + 1
}

function toScanPairMemory(
  m: Memory,
  projectLabel: string,
  includeBody: boolean
): ScanPairMemory {
  const out: ScanPairMemory = {
    id: m.id,
    title: m.title,
    project: projectLabel,
    kind: m.kind,
    confidence: m.confidence,
    confidenceScore: m.confidenceScore,
    synopsis: m.synopsis,
    keywords: m.keywords ? m.keywords.split(/\s+/).filter(Boolean) : [],
  }
  if (includeBody) out.body = m.content
  return out
}

/**
 * Render the scan as prompt-ready markdown for the calling agent. The
 * header explicitly tells the agent the next move (call
 * `lore-memory action='compare'`) and references the verdict
 * vocabulary by name. The scan does NOT inline the locked prompt
 * verbatim — the verdict-vocabulary contract lives in the lore
 * conflict-detection workflow doc.
 */
export function renderScanMarkdown(report: ScanReport): string {
  const lines: string[] = []
  const pluralizedPairs = report.pairs.length === 1 ? "pair" : "pairs"
  lines.push(`# Conflict scan — ${report.pairs.length} ${pluralizedPairs} surfaced`)
  lines.push("")
  lines.push(`**Scan ID:** \`${report.scanId}\``)
  lines.push(`**Scanned at:** ${report.scannedAt}`)
  lines.push(`**Prompt version:** ${report.promptVersion}`)
  lines.push("")
  lines.push(`**Verdict vocabulary:** see docs/memory-workflows.md#conflict-verdicts.`)
  // One line for each prose paragraph rather than splitting mid-
  // sentence: backtick boundaries inside soft wraps read awkwardly,
  // and Markdown collapses the soft break into a space at render time
  // anyway, so there's no width budget being saved.
  lines.push(
    "**Action:** judge each pair below; call `lore-memory action='compare'` once per pair with one of the six verdicts."
  )
  lines.push("")
  lines.push(
    "**Direction:** for `conflicts_with` and `supersedes`, pass `affectedMemoryId` naming the loser memory whose Confidence Score should halve. For symmetric verdicts (`scoped`, `related`, `compatible`, `not_conflict`), omit `affectedMemoryId`. The A/B labels below are unordered — order does NOT encode direction."
  )
  lines.push("")
  lines.push(...renderScanStatsMarkdown(report.stats))
  lines.push("")

  if (report.pairs.length === 0) {
    lines.push("---")
    lines.push("")
    lines.push("No candidate pairs to surface.")
    lines.push("")
    if (report.stats.rawCandidateLimitReached) {
      const limit = report.stats.rawCandidateLimit ?? SCAN_RAW_CANDIDATE_CAP
      const projects = report.stats.rawCandidateLimitReachedProjects.join(", ")
      lines.push(
        `The bounded scan hit the raw-candidate limit (${limit})` +
          (projects ? ` for: ${projects}.` : ".")
      )
      lines.push(
        `${report.stats.alreadyJudgedCandidates} candidate pairs were filtered as already judged before any useful pair survived.`
      )
      lines.push("Later unjudged pairs may exist beyond this window. Re-run with")
      lines.push("`--raw-limit <higher n>` to continue bounded scanning, or use")
      lines.push("`--exhaustive` to lift the raw-candidate ceiling.")
    } else {
      lines.push("The raw candidate generator exhausted the scan scope; no")
      lines.push("bounded raw-candidate ceiling was reached. Within this scope,")
      lines.push("no similarity-overlapping unjudged pairs remain.")
    }
    return lines.join("\n") + "\n"
  }

  lines.push("---")
  lines.push("")

  let i = 1
  for (const pair of report.pairs) {
    lines.push(`## Pair ${i} — similarity ${pair.similarity.toFixed(2)}`)
    lines.push("")
    lines.push(...renderPairMemoryMarkdown("A", pair.memoryA))
    lines.push("")
    lines.push(...renderPairMemoryMarkdown("B", pair.memoryB))
    lines.push("")
    // Render signals as a bulleted list. `findConflictCandidates`
    // produces fixed-shape signal strings today (`"title trigram:
    // 0.78"`, `"shared tags: auth, jwt"`), but rendering one signal
    // per bullet line means a future caller-controlled signal carrying
    // a literal `;` (e.g., a phrase like `"refs auth-svc; api-gateway"`)
    // can't ambiguate the inline `"; "` separator we'd otherwise use.
    lines.push("**Signals:**")
    for (const signal of pair.signals) {
      lines.push(`- ${signal}`)
    }
    lines.push("")
    lines.push("---")
    lines.push("")
    i++
  }

  // Trailing newline matches the 0-pair branch above so stdout output
  // always ends `\n` regardless of pair count.
  return lines.join("\n") + "\n"
}

function renderScanStatsMarkdown(stats: ScanStats): string[] {
  const limit =
    stats.rawCandidateLimit === null ? "exhaustive" : stats.rawCandidateLimit.toString()
  const reachedProjects = stats.rawCandidateLimitReachedProjects.join(", ")
  return [
    "**Scan stats:**",
    `- **Raw candidate limit:** ${limit}`,
    `- **Raw candidates retained:** ${stats.rawCandidates} (after sentinel slice)`,
    `- **Deduped candidates:** ${stats.dedupedCandidates}`,
    `- **Already judged filtered:** ${stats.alreadyJudgedCandidates}`,
    `- **Unjudged candidates after filtering:** ${stats.survivingCandidates}`,
    `- **Raw limit reached:** ${
      stats.rawCandidateLimitReached
        ? `yes${reachedProjects ? ` (${reachedProjects})` : ""}`
        : "no"
    }`,
  ]
}

function renderPairMemoryMarkdown(label: "A" | "B", m: ScanPairMemory): string[] {
  const lines: string[] = []
  lines.push(`### Memory ${label}: "${m.title}"`)
  lines.push(`- **ID:** \`${m.id}\``)
  lines.push(`- **Project:** ${m.project}`)
  lines.push(`- **Kind:** ${m.kind}`)
  const scoreSuffix =
    m.confidenceScore !== null ? ` (score ${m.confidenceScore.toFixed(2)})` : ""
  lines.push(`- **Confidence:** ${m.confidence}${scoreSuffix}`)
  if (m.synopsis) {
    lines.push(`- **Synopsis:** ${m.synopsis}`)
  }
  if (m.keywords.length > 0) {
    lines.push(`- **Keywords:** ${m.keywords.join(", ")}`)
  }
  if (m.body !== undefined) {
    // Memory bodies can themselves contain fenced code blocks. A fixed
    // triple-backtick fence around an arbitrary markdown body lets a
    // body line containing ``` close the outer fence early and corrupt
    // the prompt-ready report. Compute a fence one backtick longer
    // than the longest backtick run in the body — CommonMark allows
    // fences of any length ≥ 3, and the closing fence must match the
    // opening fence's length, so an `n+1`-backtick outer fence
    // safely contains any `n`-backtick inner content.
    const fence = dynamicCodeFence(m.body)
    lines.push("")
    lines.push(`${fence}markdown`)
    lines.push(m.body)
    lines.push(fence)
  }
  return lines
}

/**
 * Render the scan as JSON for programmatic consumers. The JSON variant
 * carries a `compareContract` block so an agent piping `--json` into
 * another lore tool doesn't have to consult separate prose to figure
 * out which ID is which. ~400 bytes per run; negligible cost for the
 * contract clarity it buys.
 */
export function renderScanJson(report: ScanReport): string {
  return (
    JSON.stringify(
      {
        scanId: report.scanId,
        scannedAt: report.scannedAt,
        promptVersion: report.promptVersion,
        stats: report.stats,
        compareContract: {
          tool: "lore-memory",
          action: "compare",
          verdicts: {
            asymmetric: ["conflicts_with", "supersedes"],
            symmetric: ["scoped", "related", "compatible", "not_conflict"],
          },
          directionRules: [
            "memoryA.id and memoryB.id are unordered labels — order does NOT encode direction.",
            "For asymmetric verdicts, set `affectedMemoryId` to the loser memory whose Confidence Score should halve.",
            "For symmetric verdicts, omit `affectedMemoryId` (rejected if set).",
            "verdict='supersedes' requires the affectedMemoryId memory to have kind='decision'.",
          ],
          verdictDefinitions:
            "see docs/memory-workflows.md#conflict-verdicts for the canonical definitions",
        },
        pairs: report.pairs,
      },
      null,
      2
    ) + "\n"
  )
}

const scanSubcommand = new Command("scan")
  .description(
    "Walk the vault and surface candidate conflict pairs for in-context judgment"
  )
  .option(
    "-p, --project <name>",
    "Restrict scan to one project (defaults to all projects)"
  )
  .option("-n, --limit <n>", `Max pairs to surface (default ${CONFLICT_PAIR_LIMIT})`)
  .option(
    "--raw-limit <n>",
    `Raw candidates to inspect per project before filtering (default ${SCAN_RAW_CANDIDATE_CAP}; ignored by --exhaustive)`
  )
  .option("--include-bodies", "Include each memory's full body in the output")
  .option("--json", "Emit JSON instead of human-readable markdown")
  .option(
    "--exhaustive",
    `Bypass SCAN_RAW_CANDIDATE_CAP (${SCAN_RAW_CANDIDATE_CAP}) for full O(n²) coverage`
  )
  .action(
    async (raw: {
      project?: string
      limit?: string
      rawLimit?: string
      includeBodies?: boolean
      json?: boolean
      exhaustive?: boolean
    }) => {
      try {
        const parsed = parseScanCliOptions(raw)
        if (!parsed.ok) {
          console.error(`Conflict scan failed: ${parsed.message}`)
          process.exit(1)
          // Defensive `return` after `process.exit` so TypeScript's
          // control-flow narrowing of `parsed.ok` doesn't lean on
          // `process.exit`'s `never` return type — that narrowing
          // works today but is fragile across tsconfig changes.
          return
        }
        const services = await initServices()
        const report = await runScan(services, parsed.value)
        if (parsed.value.json) {
          process.stdout.write(renderScanJson(report))
        } else {
          process.stdout.write(renderScanMarkdown(report))
        }
      } catch (err) {
        console.error("Conflict scan failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

export const conflictsCommand = new Command("conflicts")
  .description("Conflict-detection workflow")
  .addCommand(scanSubcommand)
