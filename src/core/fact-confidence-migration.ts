/**
 * Baseline backfill for the fact-side dynamic-confidence workstream
 * (DEFERRED-02).
 *
 * `lore migrate --build-fact-confidence-scores` seeds every pre-DEFERRED-02
 * fact's `Confidence Score` from its categorical `Confidence` column and
 * writes `Last Referenced At = created_time`, then realizes any decay
 * accrued since creation. Operator-pulled, plan-then-execute, idempotent
 * — the skip-rule is `confidenceScore != null`, so a row touched by a
 * read-side `touchOnRead` (or by a prior run of this migration) is left
 * alone.
 *
 * Mirrors the memory-side confidence-baseline migration line-for-line.
 * The two workstreams are structurally identical because the decay
 * algebra is shared — only the I/O wrapper changes
 * (`FactService` vs `MemoryService`).
 */

import type { LoreServices } from "../services.js"
import type { FactConfidence, MemoryConfidence } from "../types.js"
import { DEFAULT_NOTION_CONCURRENCY } from "../notion/rate-limit.js"
import {
  PROJECT_SCOPE_MIGRATION_DOC,
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "./project-scope.js"
import { decayConfidenceScore, seedConfidenceScore } from "./decay.js"
import { todayUtc } from "./task.js"

const DAY_MS = 1000 * 60 * 60 * 24

function daysBetween(later: string, earlier: string): number {
  const a = new Date(later).getTime()
  const b = new Date(earlier).getTime()
  if (Number.isNaN(a) || Number.isNaN(b)) return 0
  return Math.max(0, Math.floor((a - b) / DAY_MS))
}

export interface BuildFactConfidenceScoresOptions {
  services: LoreServices
  /** When false, builds and prints the plan but does not write. */
  apply: boolean
  /** When true, suppresses writes regardless of `apply`. */
  dryRun: boolean
  /** Optional project name to scope the migration. Unknown names abort
   *  before any plan or write fires. */
  projectName?: string
  /** Pre-resolved project ID from the CLI dispatcher. Takes precedence
   *  over `projectName` so archived-project migrations can resolve once
   *  with `--include-archived` and avoid an active-only re-lookup. */
  projectId?: string
}

export interface BuildFactConfidenceScoresPlanRow {
  factId: string
  subject: string
  predicate: string
  object: string
  fromConfidence: FactConfidence
  /** `seedConfidenceScore(fromConfidence)` — categorical-mapped seed
   *  before decay. */
  seededScore: number
  /** `decayConfidenceScore(seededScore, createdDate, today)` — what
   *  `executePlan` writes. */
  decayedScore: number
  /** YYYY-MM-DD form of the row's Notion `created_time`. */
  createdDate: string
  /** Days between `today` and `createdDate`. */
  daysSinceCreation: number
}

export interface BuildFactConfidenceScoresPlan {
  totalFactsScanned: number
  rowsToSeed: BuildFactConfidenceScoresPlanRow[]
  rowsAlreadyScored: number
}

export interface BuildFactConfidenceScoresResult {
  plan: BuildFactConfidenceScoresPlan
  /** Number of `pages.update` writes that succeeded. Zero on dry-run /
   *  plan-only paths. */
  written: number
}

export async function runBuildFactConfidenceScoresMigration(
  opts: BuildFactConfidenceScoresOptions
): Promise<BuildFactConfidenceScoresResult> {
  const plan = await buildPlan(opts)
  let written = 0
  if (opts.apply && !opts.dryRun) {
    written = await executePlan(plan, opts)
  }
  return { plan, written }
}

async function buildPlan(
  opts: BuildFactConfidenceScoresOptions
): Promise<BuildFactConfidenceScoresPlan> {
  const { services, projectName } = opts

  // Strict-resolve the project name. A typo'd / unknown name must NOT
  // silently fall through to vault-wide migration — same posture as the
  // memory-side migration.
  let projectId = opts.projectId
  const explicitProjectName = validateExplicitProjectScopeName(projectName, "--project", {
    listHint: "run `lore status projects` to list configured projects",
    omittedScopeLabel: "vault-wide scope",
    docsHint: PROJECT_SCOPE_MIGRATION_DOC,
  })
  if (explicitProjectName !== undefined && projectId === undefined) {
    const project = await resolveProjectScopeName(
      services.projects,
      explicitProjectName,
      "--project",
      {
        listHint: "run `lore status projects` to list configured projects",
        omittedScopeLabel: "vault-wide scope",
        docsHint: PROJECT_SCOPE_MIGRATION_DOC,
      }
    )
    projectId = project.id
  }

  const rowsToSeed: BuildFactConfidenceScoresPlanRow[] = []
  let rowsAlreadyScored = 0
  let totalFactsScanned = 0
  const today = todayUtc()

  for await (const fact of services.facts.listAllForBackfill({ projectId })) {
    totalFactsScanned += 1

    if (fact.confidenceScore != null) {
      rowsAlreadyScored += 1
      continue
    }

    // `FactConfidence` is structurally identical to `MemoryConfidence`
    // (`certain | likely | speculative`), so the shared `CONFIDENCE_SEED`
    // table backing `seedConfidenceScore` works without translation.
    const seeded = seedConfidenceScore(fact.confidence as unknown as MemoryConfidence)
    // `Fact.createdAt` is typed optional on the public boundary
    // (DEFERRED-02) so adding the field doesn't break external
    // consumers. Internally, every Fact yielded by
    // `listAllForBackfill` came from `pageToFact`, which always
    // populates `createdAt` from Notion's built-in `created_time`.
    // The explicit guard names the migration in the error message
    // so a future fixture violation surfaces at the right call site.
    if (fact.createdAt === undefined) {
      throw new Error(
        `lore migrate --build-fact-confidence-scores: Fact.createdAt is ` +
          `unexpectedly undefined (fact id=${fact.id}). listAllForBackfill ` +
          `routes through pageToFact which always populates the field; a ` +
          `missing value indicates a partial Fact reached the migration ` +
          `walker.`
      )
    }
    const createdDate = fact.createdAt.slice(0, 10)
    const decayed = decayConfidenceScore(seeded, createdDate, today)
    rowsToSeed.push({
      factId: fact.id,
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      fromConfidence: fact.confidence,
      seededScore: seeded,
      decayedScore: decayed,
      createdDate,
      daysSinceCreation: daysBetween(today, createdDate),
    })
  }

  return { totalFactsScanned, rowsToSeed, rowsAlreadyScored }
}

async function executePlan(
  plan: BuildFactConfidenceScoresPlan,
  opts: BuildFactConfidenceScoresOptions
): Promise<number> {
  const concurrency =
    opts.services.config.notion?.rateLimit?.concurrency ?? DEFAULT_NOTION_CONCURRENCY
  let processed = 0
  let nextProgressMark = 100
  for (let i = 0; i < plan.rowsToSeed.length; i += concurrency) {
    const batch = plan.rowsToSeed.slice(i, i + concurrency)
    await Promise.all(
      batch.map((row) =>
        opts.services.facts.applyBackfillScore(
          row.factId,
          row.decayedScore,
          row.createdDate
        )
      )
    )
    processed += batch.length
    if (processed >= nextProgressMark) {
      process.stderr.write(
        `[lore] build-fact-confidence-scores: ${processed}/${plan.rowsToSeed.length}\n`
      )
      nextProgressMark = Math.floor(processed / 100) * 100 + 100
    }
  }
  return processed
}
