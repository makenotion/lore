import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Command } from "commander"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { initServices, type LoreServices } from "../../services.js"
import { resolveFeatureFlags } from "../../feature-flags.js"
import {
  PROJECT_SCOPE_MIGRATION_DOC,
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import { mergeHookDefaults, type BackgroundAgentConfig } from "../../hooks/config.js"
import { redactDebugMessage } from "../../debug-redact.js"
import type { MemoryTagPlan } from "../../core/tag-migration.js"
import { classifyTags, planMemoryMigration } from "../../core/tag-migration.js"
import { BODY_SIZE_CAP_BYTES, type EncodedMemoryRow } from "../../core/memory-encoding.js"
import type {
  TopicAliasMergePlan,
  TopicAliasMergeResult,
} from "../../core/topic-merge.js"
import type { Fact, Memory } from "../../types.js"
import type { NormalizableAgentRow } from "../../core/agent-normalization.js"
import {
  buildEntities,
  computeOrphanRateFromAggregateRows,
  computeOrphanRateFromFacts,
  type EntityMigrationResult,
  type OrphanRateReport,
} from "../../core/entity-migration.js"
import { querySubjectGroupCountsViaRunTool } from "../../notion/runtool/index.js"
import {
  isSqlValidationError,
  logRunToolFallback,
} from "../../notion/runtool/error-helpers.js"
import type { BackfillReport, SynopsisBackend } from "../../core/synopsis-backfill.js"
import { DEFAULT_SYNOPSIS_BATCH_SIZE } from "../../core/synopsis-backfill.js"
import {
  runBuildConfidenceScoresMigration,
  type BuildConfidenceScoresPlan,
  type BuildConfidenceScoresResult,
} from "../../core/confidence-migration.js"
import {
  runBuildFactConfidenceScoresMigration,
  type BuildFactConfidenceScoresPlan,
  type BuildFactConfidenceScoresResult,
} from "../../core/fact-confidence-migration.js"
import {
  runBackfillFactObservedAtMigration,
  type BackfillFactObservedAtResult,
} from "../../core/fact-observed-at-migration.js"
import {
  releaseMigrationLock,
  tryAcquireMigrationLock,
  type MigrationLock,
} from "../migration-lock.js"
import { FACT_PROPS, MEMORY_PROPS } from "../../notion/schema.js"

export const migrateCommand = new Command("migrate")
  .description(
    "Add missing schema properties to the vault's data sources. " +
      "The schema-additive scan is idempotent — re-running after a partial " +
      "failure (e.g. options merged but properties did not land due to a " +
      "transient Notion error) is safe and resumes where the last run left " +
      "off. Per-DB error attribution surfaces in the partial-failure message " +
      "so the operator can identify which DB needs to retry."
  )
  .option("--dry-run", "Show what would be added without writing")
  .option(
    "--upgrade-decision-tags",
    "Upgrade memories tagged 'decision' to Kind: decision and strip the tag. Auto-runs schema migration first."
  )
  .option(
    "--merge-duplicate-topics",
    "Merge duplicate-name topic rows into one canonical topic (union projects, re-point memories, archive losers). Required when the vault has legacy duplicate topics before the schema upgrade."
  )
  .option(
    "--merge-similar-topics",
    "Collapse normalized-equivalent topic groups (issue #109): rows with different stored names that match after lowercase + decode + `&`↔`and` + plural-strip + punctuation-strip. Each group's oldest row wins; siblings are archived and their memories re-pointed onto the canonical. Plan-only by default — re-run with `--yes` to apply."
  )
  .option(
    "--fix-topic-encoding",
    "Decode HTML entities (`&amp;`, `&lt;`, …) in topic names so rows like `Build &amp;amp; Tooling` become `Build & Tooling`. Runs before duplicate detection, so pair with `--merge-duplicate-topics` to collapse cross-encoding duplicates."
  )
  .option(
    "--fix-fact-encoding",
    "Decode HTML entities in fact Subject/Object columns and recompute DedupKey so pre-PF1-06 rows stop carrying `Foo &amp;amp; Bar` payloads. Refuses to rewrite any row whose post-decode dedup key would collide with another live fact; pair with `--dedup-keys --merge --yes` first to resolve those. Plan-only by default — re-run with `--yes` to apply. Combine with `--dry-run` for a plan preview."
  )
  .option(
    "--fix-memory-encoding",
    "Decode HTML entities in memory Title and body markdown for every non-archived memory. Body rewrite is skipped by default for pages larger than 100 KB; under LORE_USE_RUNTOOL_BLOCK_EDIT=1 those bodies route through RunTool's anchored `update_content` per-entity substitutions when the row's local guards predict success (single-pass entity body with non-empty substitutions — issue #534 AC #5). Multi-pass entity bodies fall back to the canonical path. Title is always fixed, because Title is the value driver for downstream near-duplicate / embedding surfaces. Plan-only by default — re-run with `--yes` to apply. Combine with `--dry-run` for a plan preview."
  )
  .option(
    "--merge-topics <file>",
    "Apply operator-curated alias → canonical topic merges from a YAML file. Memories under each alias are re-pointed onto the canonical; alias topic rows are archived. Read-only by default — combine with --apply to write. Idempotent once applied."
  )
  .option(
    "--tags",
    "Reclassify out-of-vocabulary tags. Obvious free-form tokens (PR numbers, ticket IDs, file names, class names) move to Keywords; ambiguous tags are reported for manual triage. Combine with --dry-run for a preview."
  )
  .option(
    "--backfill-fact-sources",
    "Find facts with empty Source relations, propose supporting memories via conservative title-word-boundary match. Prints a report; add --apply to write. A wrong Source distorts `lore-query action='ask'` outputs for the lifetime of the fact, so matching is deliberately narrow — unmatched orphans stay orphan until an operator reviews."
  )
  .option(
    "--apply",
    "Commit gate for the two plan-only passes. With --backfill-fact-sources, writes the proposed Source relations (assumes a quiet window — matches can shift if autosave runs concurrently). With --merge-topics, archives the alias topic rows and re-points the memories listed in the plan."
  )
  .option(
    "--dedup-keys",
    "Backfill the DedupKey and SubjectKey columns on every fact. Auto-runs schema migration first. SubjectKey rides on the same pass because P3-03 Part A's case-insensitive `queryBySubject` depends on every row having it populated."
  )
  .option(
    "--merge",
    "With --dedup-keys, show the survivor/loser plan for collapsing live duplicate triples. Re-run with --yes to execute."
  )
  .option(
    "--build-entities",
    "Group every fact's Subject and Object strings by their normalized key, propose one canonical Entity row per group with the remaining raw forms as aliases, and fill empty SubjectEntity/ObjectEntity relations without overwriting populated relations. Plan-only by default — re-run with --yes to apply. Apply mode takes a vault-scoped lock and still expects a quiet vault with no concurrent autosaves writing facts. PF3-01."
  )
  .option(
    "--report-orphan-rate",
    "Pair with `--build-entities` to print the PF3-01 orphan-rate metric (`subjects appearing in exactly 1 fact`). On `--build-entities --yes` (apply) the report measures the post-pass fact graph; on bare `--build-entities` (plan-only) or `--dry-run` it measures the pre-pass graph and labels the output `pre-pass` accordingly so the operator can read the canonicalization baseline before committing. Routes through RunTool's server-side `GROUP BY` aggregate by default (#543 Phase 4: `LORE_USE_RUNTOOL_AGGREGATE` defaults ON, inheriting from the parent `LORE_USE_RUNTOOL` kill-switch); set either env var to `0` to force JS enumeration. Falls back per-call to the JS path on capability gate (403), saturated `has_more: true` aggregate windows, malformed responses, or transient transport-class failures. Read-only — does not affect plan/apply behavior."
  )
  .option(
    "--normalize-agents",
    "Collapse free-form `Agent` strings on every memory onto their canonical form. The seven Claude variants observed in the PF3-02 internal-vault audit (`Claude Code`, `claude-code`, `Claude Opus 4.7 (1M context)`, `Claude Code (Opus 4.7)`, `claude-opus-4.7`, `claude-opus-4-7`, `claude-code-opus-4-7`) plus the bare-version cousin (`Claude Opus 4.7`) all rewrite to `Claude Code`; explicit third-party names (`Codex`, `Cline`, `Cursor`) pass through unchanged. Plan-only by default — re-run with `--yes` to apply. Idempotent."
  )
  .option(
    "--backfill-synopses",
    "Synthesize a 1–2 sentence synopsis for every memory whose Synopsis property is empty (the pre-0.7.0 historical corpus). Plan-only by default — re-run with `--yes` to apply. `--dry-run` suppresses the write regardless of `--yes`. Synthesis goes through a pluggable backend selected by `--synopsis-backend` (default: `claude`)."
  )
  .option(
    "--synopsis-backend <name>",
    "Backend for `--backfill-synopses`. `claude` shells out to `claude -p` per row (requires the claude CLI installed and authenticated; PATH preflight runs only on the apply path). `placeholder` writes the SYNOPSIS_PLACEHOLDER_SENTINEL constant without consulting body content — intended for test infrastructure and for operators flagging legacy rows on a large vault. Defaults to `claude`.",
    "claude"
  )
  .option(
    "--synopsis-batch-size <n>",
    "How many memories to process concurrently on the `--backfill-synopses` apply path. The synthesizer is the slow part on the `claude` backend; chunking via this knob cuts wallclock by ~Nx. Notion-side write fan-out is additionally capped by the rate-limited client. Defaults to 4. Ignored on plan-only runs.",
    "4"
  )
  .option(
    "--build-confidence-scores",
    "Seed every memory's Confidence Score from its categorical Confidence (certain → 0.9, likely → 0.6, speculative → 0.3) and write Last Referenced At = created_time, then realize any neglect-decay accrued since creation. Plan-only by default — re-run with `--yes` to apply. Pair with `--project <name>` to scope to a single project. Idempotent: rows whose Confidence Score is already non-null (touched by a Phase 2 read path or a prior backfill) are skipped."
  )
  .option(
    "--build-fact-confidence-scores",
    "Mirror of `--build-confidence-scores` for the Facts DB (DEFERRED-02). Seeds every fact's Confidence Score from its categorical Confidence (certain → 0.9, likely → 0.6, speculative → 0.3) and writes Last Referenced At = created_time, then realizes any decay accrued since creation. Plan-only by default — re-run with `--yes` to apply. Pair with `--project <name>` to scope. Idempotent: rows already scored are skipped. The Last Referenced At column ships alongside Confidence Score because decay needs a per-fact reference timestamp distinct from Notion's last_edited_time. Last Referenced At = created_time is a fiction (the fact wasn't actually 'referenced' at creation) — operators who want a true read-citation anchor re-run after read traffic naturally bumps the column via touchOnRead."
  )
  .option(
    "--backfill-fact-observed-at",
    "Backfill issue #284 transaction-time columns (`Observed At`, `Invalidated At`) on pre-#284 fact rows. Plan-only by default; pair with `--yes` to apply, `--project <name>` to scope. Idempotent. See `docs/cli.md` for the full backfill contract (including why `Invalidated By` is not auto-seeded)."
  )
  .option(
    "--project <name>",
    "Scope project-capable migrations to a single project. Unknown / typo'd names abort before any plan or write; see docs/memory-workflows.md#migrating-from-unscoped-writes."
  )
  .option(
    "--include-archived",
    "Allow --project to resolve archived projects for operator migrations of retired data. Requires --project."
  )
  .option(
    "--allow-unscoped",
    "Explicitly permit project-capable migrations to run vault-wide when --project is omitted; see docs/memory-workflows.md#migrating-from-unscoped-writes."
  )
  .option(
    "--yes",
    "Execute the plan for `--merge`, `--fix-fact-encoding`, `--fix-memory-encoding`, `--normalize-agents`, `--build-entities`, `--merge-similar-topics`, `--backfill-synopses`, `--build-confidence-scores`, `--build-fact-confidence-scores`, or `--backfill-fact-observed-at`. Without `--yes`, those flags are plan-only."
  )
  .action(
    async (opts: {
      dryRun?: boolean
      upgradeDecisionTags?: boolean
      mergeDuplicateTopics?: boolean
      mergeSimilarTopics?: boolean
      fixTopicEncoding?: boolean
      fixFactEncoding?: boolean
      fixMemoryEncoding?: boolean
      mergeTopics?: string
      tags?: boolean
      backfillFactSources?: boolean
      apply?: boolean
      dedupKeys?: boolean
      merge?: boolean
      yes?: boolean
      normalizeAgents?: boolean
      buildEntities?: boolean
      reportOrphanRate?: boolean
      backfillSynopses?: boolean
      synopsisBackend?: string
      synopsisBatchSize?: string
      buildConfidenceScores?: boolean
      buildFactConfidenceScores?: boolean
      backfillFactObservedAt?: boolean
      project?: string
      includeArchived?: boolean
      allowUnscoped?: boolean
    }) => {
      let buildEntitiesLock: MigrationLock | null = null
      try {
        // Validate flag combinations BEFORE running the schema migration so
        // a misuse (e.g. `--merge` without `--dedup-keys`) does not leave
        // the vault half-migrated.
        if (opts.merge && !opts.dedupKeys) {
          console.error(
            "--merge requires --dedup-keys. Re-run with `--dedup-keys --merge` to collapse duplicate triples."
          )
          process.exit(1)
        }
        if (
          opts.yes &&
          !opts.merge &&
          !opts.fixFactEncoding &&
          !opts.fixMemoryEncoding &&
          !opts.normalizeAgents &&
          !opts.buildEntities &&
          !opts.mergeSimilarTopics &&
          !opts.backfillSynopses &&
          !opts.buildConfidenceScores &&
          !opts.buildFactConfidenceScores &&
          !opts.backfillFactObservedAt
        ) {
          console.error(
            "--yes only applies together with --merge, --fix-fact-encoding, --fix-memory-encoding, --normalize-agents, --build-entities, --merge-similar-topics, --backfill-synopses, --build-confidence-scores, --build-fact-confidence-scores, or --backfill-fact-observed-at."
          )
          process.exit(1)
        }
        const scopedMigration = isProjectScopedMigrationRequested(opts)
        if (opts.project !== undefined && !scopedMigration) {
          console.error(
            "--project only applies together with --fix-fact-encoding, --fix-memory-encoding, --normalize-agents, --build-entities, --backfill-fact-sources, --backfill-synopses, --build-confidence-scores, --build-fact-confidence-scores, or --backfill-fact-observed-at."
          )
          process.exit(1)
        }
        if (opts.includeArchived && opts.project === undefined) {
          console.error("--include-archived requires --project <name>.")
          process.exit(1)
        }
        if (opts.allowUnscoped && opts.project !== undefined) {
          console.error("--allow-unscoped cannot be combined with --project.")
          process.exit(1)
        }
        if (opts.reportOrphanRate && !opts.buildEntities) {
          // The metric is only meaningful alongside `--build-entities`:
          // a bare `--report-orphan-rate` would need to share
          // scope-resolution and project-validation gates with the
          // migration anyway, and on plan-only / `--dry-run` the
          // report's `pre-pass` label is the baseline an operator
          // reads BEFORE deciding to apply, while on `--yes` the
          // `post-pass` label confirms the migration's effect.
          // Either context requires the pair; require it explicitly.
          console.error(
            "--report-orphan-rate must be combined with --build-entities. " +
              "The metric only makes sense in the context of that migration's " +
              "fact-graph snapshot."
          )
          process.exit(1)
        }
        if (scopedMigration && opts.project === undefined && !opts.allowUnscoped) {
          console.error(
            "Refusing to run project-capable migrations without an explicit scope. " +
              "Pass --project <name> to target one project, or --allow-unscoped " +
              "to run vault-wide intentionally. See " +
              `${PROJECT_SCOPE_MIGRATION_DOC}.`
          )
          process.exit(1)
        }
        const synopsisBackend: SynopsisBackend = parseSynopsisBackend(
          opts.synopsisBackend
        )
        const synopsisBatchSize: number = parseSynopsisBatchSize(opts.synopsisBatchSize)

        // Load & validate merge-topics YAML before initializing services so
        // a malformed file fails fast, without a Notion round-trip.
        let aliasMergePlans: TopicAliasMergePlan[] | null = null
        if (opts.mergeTopics) {
          aliasMergePlans = await loadTopicAliasMerges(opts.mergeTopics)
        }

        // `lore migrate` is an operator-facing drift surface — always run
        // the read-only drift check on init, bypassing the debounce, even
        // though the migrate logic itself re-runs the same diff. The
        // stderr nudge is informational; the foreground migrate report is
        // the authoritative output.
        const services = await initServices(undefined, { driftCheck: true })
        const migrationScope = await resolveMigrationProjectScope(services, opts)

        if (opts.buildEntities && opts.yes && !opts.dryRun) {
          buildEntitiesLock = acquireBuildEntitiesMigrationLock(services, {
            apply: true,
            dryRun: opts.dryRun,
          })
        }

        // When `--upgrade-decision-tags` is combined with `--dry-run`, we still
        // want to report schema drift but NOT apply anything. So dry-run always
        // suppresses writes; `--upgrade-decision-tags` without `--dry-run`
        // triggers the tag upgrade after the schema migration completes.
        const {
          diffs,
          duplicateTopics,
          mergeResults,
          encodedTopics,
          encodingFixResults,
        } = await services.vault.migrate({
          dryRun: opts.dryRun,
          mergeDuplicateTopics: opts.mergeDuplicateTopics,
          fixTopicEncoding: opts.fixTopicEncoding,
        })

        const totalMissing = diffs.reduce((n, d) => n + d.missing.length, 0)
        const totalAddedOptions = diffs.reduce(
          (n, d) => n + d.addedOptions.reduce((m, a) => m + a.options.length, 0),
          0
        )
        const totalBlockedOptions = diffs.reduce(
          (n, d) => n + d.blockedOptions.reduce((m, a) => m + a.options.length, 0),
          0
        )
        const totalRelationConfig = diffs.reduce(
          (n, d) => n + d.addedRelationConfig.length,
          0
        )

        const verb = opts.dryRun ? "Would add" : "Added"
        const blockedVerb = opts.dryRun ? "Cannot add" : "Skipped"
        const upgradeVerb = opts.dryRun ? "Would upgrade" : "Upgraded"
        const mergeVerb = opts.dryRun ? "Would merge" : "Merged"

        if (encodedTopics.length > 0) {
          // The write happened iff `migrate()` actually ran fixTopicEncoding;
          // dry-run or flag-omitted both leave encodingFixResults empty, and
          // both should preview the rows as "would decode" rather than claim
          // a decode that never ran.
          const didWrite = encodingFixResults.length > 0
          const rows = didWrite ? encodingFixResults : encodedTopics
          const decodeVerb = didWrite ? "Decoded" : "Would decode"
          console.log(
            `${decodeVerb} ${rows.length} HTML-encoded topic name${rows.length === 1 ? "" : "s"}:`
          )
          for (const row of rows) {
            console.log(`  "${row.rawName}" → "${row.decodedName}"`)
          }
        }

        if (duplicateTopics.length > 0) {
          const rowCount = duplicateTopics.reduce((n, g) => n + g.topicIds.length, 0)
          if (mergeResults.length > 0) {
            console.log(
              `${mergeVerb} ${mergeResults.length} duplicate-name topic group${mergeResults.length === 1 ? "" : "s"} (${rowCount} rows):`
            )
            for (const result of mergeResults) {
              console.log(
                `  "${result.name}" → canonical ${result.canonicalId}: ` +
                  `${result.canonicalProjectIds.length} projects; ` +
                  `archived ${result.archivedIds.length}; ` +
                  `re-pointed ${result.reassignedMemoryIds.length} memor${result.reassignedMemoryIds.length === 1 ? "y" : "ies"}`
              )
            }
          } else {
            console.log(
              `${mergeVerb} ${duplicateTopics.length} duplicate-name topic group${duplicateTopics.length === 1 ? "" : "s"} (${rowCount} rows):`
            )
            for (const group of duplicateTopics) {
              console.log(
                `  "${group.name}": ${group.topicIds.length} rows (${group.topicIds.join(", ")})`
              )
            }
          }
        }

        if (totalMissing > 0) {
          console.log(
            `${verb} ${totalMissing} missing propert${totalMissing === 1 ? "y" : "ies"}:`
          )
          for (const diff of diffs) {
            if (diff.missing.length === 0) continue
            console.log(`  ${diff.database}: ${diff.missing.join(", ")}`)
          }
        }

        if (totalAddedOptions > 0) {
          console.log(
            `${verb} ${totalAddedOptions} new select option${totalAddedOptions === 1 ? "" : "s"}:`
          )
          for (const diff of diffs) {
            if (diff.addedOptions.length === 0) continue
            for (const added of diff.addedOptions) {
              console.log(
                `  ${diff.database}.${added.property}: ${added.options.join(", ")}`
              )
            }
          }
        }

        if (totalBlockedOptions > 0) {
          console.log(
            `${blockedVerb} ${totalBlockedOptions} select option${totalBlockedOptions === 1 ? "" : "s"} because Notion caps property options at 100:`
          )
          for (const diff of diffs) {
            if (diff.blockedOptions.length === 0) continue
            for (const blocked of diff.blockedOptions) {
              console.log(
                `  ${diff.database}.${blocked.property} (${blocked.type}): ` +
                  `live=${blocked.liveCount}, attempted=${blocked.attemptedCount}, ` +
                  `limit=${blocked.limit}; ${blocked.options.join(", ")}`
              )
            }
          }
          console.log(
            "Prune options from the listed properties or reduce the active profile vocabulary, then rerun `lore migrate`."
          )
        }

        if (totalRelationConfig > 0) {
          console.log(
            `${upgradeVerb} ${totalRelationConfig} relation config${totalRelationConfig === 1 ? "" : "s"}:`
          )
          for (const diff of diffs) {
            if (diff.addedRelationConfig.length === 0) continue
            for (const upgrade of diff.addedRelationConfig) {
              console.log(
                `  ${diff.database}.${upgrade.property}: ${upgrade.from} → ${upgrade.to}`
              )
            }
          }
        }

        if (
          totalMissing === 0 &&
          totalAddedOptions === 0 &&
          totalBlockedOptions === 0 &&
          totalRelationConfig === 0 &&
          duplicateTopics.length === 0 &&
          encodedTopics.length === 0 &&
          !opts.upgradeDecisionTags &&
          !opts.tags &&
          !opts.dedupKeys &&
          !aliasMergePlans
        ) {
          console.log("Vault schema is up to date. Nothing to migrate.")
        }

        if (totalBlockedOptions > 0 && !opts.dryRun) {
          console.error(
            "Migrate failed: one or more select option updates exceed Notion's option limit."
          )
          process.exit(1)
          return
        }

        if (opts.upgradeDecisionTags) {
          if (opts.dryRun) {
            console.log(
              "\n--upgrade-decision-tags with --dry-run is a no-op (schema diff above)."
            )
          } else {
            const upgraded = await upgradeLegacyDecisionTags(services)
            console.log(
              `\nUpgraded ${upgraded} memor${upgraded === 1 ? "y" : "ies"} from legacy 'decision' tag to Kind: decision.`
            )
          }
        }

        if (opts.tags) {
          // Pre-flight: the --tags pass writes the `Keywords` column, which
          // is itself a schema addition in this release. On --dry-run the
          // schema pass above is also a dry-run, so Keywords may still be
          // missing live; abort with a directive error rather than letting
          // a later, non-dry-run --tags pass fail mid-loop against Notion.
          const memoriesDiff = diffs.find((d) => d.database === "memories")
          const keywordsMissing =
            memoriesDiff?.missing.includes(MEMORY_PROPS.KEYWORDS) ?? false
          if (keywordsMissing && opts.dryRun) {
            console.log(
              "\n--tags requires the `Keywords` property, which the live schema is missing. " +
                "Re-run `lore migrate` (no --dry-run) first to add it, then re-run `lore migrate --tags --dry-run`."
            )
          } else if (keywordsMissing) {
            throw new Error(
              "Cannot reclassify tags: the Memories database is missing the `Keywords` property. " +
                "The schema migration above should have added it — inspect that output and retry."
            )
          } else {
            await migrateOutOfVocabTags(services, { dryRun: opts.dryRun })
          }
        }

        if (opts.dedupKeys) {
          const result = await services.facts.backfillDedupKeys({
            merge: opts.merge,
            dryRun: opts.dryRun,
            yes: opts.yes,
          })
          const dedupVerb = opts.dryRun ? "Would backfill" : "Backfilled"
          // "key columns" instead of naming both: `result.backfilled`
          // counts rows where *either* DedupKey or SubjectKey drifted, so
          // a partially-migrated vault where only SubjectKey needed
          // writing would otherwise show "Backfilled DedupKey +
          // SubjectKey on N facts" and have the operator wondering why
          // DedupKey got rewritten. The aggregate phrasing matches the
          // trigger semantics without needing per-column counters.
          console.log(
            `\n${dedupVerb} key columns on ${result.backfilled} fact${result.backfilled === 1 ? "" : "s"} (${result.skipped} already up to date).`
          )
          if (opts.merge) {
            const plannedLosers = result.plans.reduce((n, p) => n + p.loserIds.length, 0)
            const headerVerb = opts.dryRun
              ? "Would merge"
              : result.mergePreviewOnly
                ? "Proposed merge"
                : "Merged"
            console.log(
              `${headerVerb} ${result.mergedGroups} duplicate group${result.mergedGroups === 1 ? "" : "s"}; ${result.mergePreviewOnly || opts.dryRun ? "would invalidate" : "invalidated"} ${result.mergePreviewOnly ? plannedLosers : result.invalidated} loser${(result.mergePreviewOnly ? plannedLosers : result.invalidated) === 1 ? "" : "s"}.`
            )
            // Preview table — capped at 10 rows so a vault with hundreds of
            // duplicates doesn't flood the terminal. The full plan is the
            // return value for anyone scripting against this.
            const PREVIEW_LIMIT = 10
            for (const plan of result.plans.slice(0, PREVIEW_LIMIT)) {
              console.log(
                `  "${plan.triple.subject}" ${plan.triple.predicate} "${plan.triple.object}"`
              )
              console.log(
                `    survivor: ${plan.survivorId} | invalidate: ${plan.loserIds.join(", ")}`
              )
            }
            if (result.plans.length > PREVIEW_LIMIT) {
              console.log(`  … and ${result.plans.length - PREVIEW_LIMIT} more groups.`)
            }
            if (result.mergePreviewOnly && result.mergedGroups > 0) {
              console.log(
                "\nPlan only — no invalidations written. Re-run with `--yes` to execute."
              )
            }
          }
        }

        if (opts.backfillFactSources) {
          await backfillFactSources(services, {
            apply: opts.apply === true && !opts.dryRun,
            projectId: migrationScope.projectId,
          })
        }

        if (opts.fixFactEncoding) {
          // Plan-then-execute: apply only when `--yes` is set. Bare
          // invocation prints the plan and a "re-run with --yes" footer,
          // matching the `--dedup-keys --merge --yes` pattern. `--dry-run`
          // is also plan-only and takes precedence over `--yes` so
          // `--dry-run --yes` still writes nothing.
          await runFactEncodingFix(services, {
            apply: Boolean(opts.yes) && !opts.dryRun,
            dryRun: opts.dryRun,
            projectId: migrationScope.projectId,
          })
        }

        if (opts.fixMemoryEncoding) {
          await runMemoryEncodingFix(services, {
            apply: Boolean(opts.yes) && !opts.dryRun,
            dryRun: opts.dryRun,
            projectId: migrationScope.projectId,
          })
        }

        if (opts.normalizeAgents) {
          await runAgentNormalization(services, {
            apply: Boolean(opts.yes) && !opts.dryRun,
            dryRun: opts.dryRun,
            projectId: migrationScope.projectId,
          })
        }

        if (opts.buildEntities) {
          await runBuildEntitiesMigration(services, {
            apply: Boolean(opts.yes) && !opts.dryRun,
            dryRun: opts.dryRun,
            lock: buildEntitiesLock ?? undefined,
            projectId: migrationScope.projectId,
          })
          // Release the migration lock BEFORE running the read-only
          // orphan-rate report. The lock exists to serialize the
          // apply window against concurrent autosaves writing facts;
          // it must not also serialize a report that walks every
          // fact via `queryBySubject` (or, on the SQL aggregate path,
          // a single `query_data_sources` call). The catch handler
          // below covers double-release safely via the
          // `if (buildEntitiesLock)` guard paired with the `null`
          // assignment.
          if (buildEntitiesLock) {
            releaseMigrationLock(buildEntitiesLock)
            buildEntitiesLock = null
          }
          if (opts.reportOrphanRate) {
            await runOrphanRateReport(services, {
              apply: Boolean(opts.yes) && !opts.dryRun,
              projectId: migrationScope.projectId,
              projectName: migrationScope.projectName,
            })
          }
        }

        if (opts.mergeSimilarTopics) {
          await runSimilarTopicsMigration(services, {
            apply: Boolean(opts.yes) && !opts.dryRun,
            dryRun: opts.dryRun,
          })
        }

        if (opts.backfillSynopses) {
          // Thread the operator-configured background agent
          // through the synopsis synthesizer so a Codex-only operator
          // running `--backfill-synopses` (without `--synopsis-backend
          // placeholder`) gets the same redirected binary the autosave /
          // digest paths use.
          const hookConfig = mergeHookDefaults(services.config.hooks)
          await runSynopsisBackfill(services, {
            apply: Boolean(opts.yes) && !opts.dryRun,
            dryRun: opts.dryRun,
            backend: synopsisBackend,
            batchSize: synopsisBatchSize,
            agent: hookConfig.backgroundAgent,
            projectId: migrationScope.projectId,
          })
        }

        if (opts.buildConfidenceScores) {
          await runBuildConfidenceScores(services, {
            apply: Boolean(opts.yes) && !opts.dryRun,
            dryRun: Boolean(opts.dryRun),
            projectName: opts.project,
            projectId: migrationScope.projectId,
          })
        }

        if (opts.buildFactConfidenceScores) {
          await runBuildFactConfidenceScores(services, {
            apply: Boolean(opts.yes) && !opts.dryRun,
            dryRun: Boolean(opts.dryRun),
            projectName: opts.project,
            projectId: migrationScope.projectId,
          })
        }

        if (opts.backfillFactObservedAt) {
          await runBackfillFactObservedAt(services, {
            apply: Boolean(opts.yes) && !opts.dryRun,
            dryRun: Boolean(opts.dryRun),
            projectName: opts.project,
            projectId: migrationScope.projectId,
          })
        }

        if (aliasMergePlans) {
          // Dry-run is opt-in via the flag *or* implicit when --apply is
          // omitted: operators who forget a flag get a preview, never a
          // silent archive. --dry-run + --apply would be ambiguous, so we
          // honor dry-run whenever it's set regardless of --apply.
          //
          // Posture: --apply (not --yes). Encoding migrations use --yes
          // as the commit gate because the rewrite rewrites every fact
          // body (bigger blast radius than one rename); this path is
          // one rename per group and matches `--backfill-fact-sources`'s
          // --apply posture. The irreversibility caveat below closes
          // the gap that --yes would otherwise have signalled.
          const writing = opts.apply === true && !opts.dryRun
          const results = await services.vault.migrateAliasMerges(aliasMergePlans, {
            dryRun: !writing,
          })
          printAliasMergeResults(results, { writing })
          if (!writing && results.some((r) => !r.noop)) {
            // Only warn when there's something to commit. On an all-noop
            // preview the plan is already satisfied and the warning is
            // actively misleading.
            console.log(
              "\nIrreversible: archived topic rows can be un-archived in Notion, " +
                "but the memory→topic reassignments overwrite the prior Topic " +
                "relation and cannot be rolled back by unarchiving. If the " +
                "canonical choice turns out to be wrong, re-point memories via " +
                "a second merge plan."
            )
          }
          if (!writing) {
            console.log(
              "\nRead-only pass — no changes written. Re-run with `--apply` to commit the plan above."
            )
          }
        }

        if (opts.dryRun) {
          const flagHints: string[] = []
          if (encodedTopics.length > 0 && !opts.fixTopicEncoding) {
            flagHints.push("`--fix-topic-encoding`")
          }
          if (duplicateTopics.length > 0 && !opts.mergeDuplicateTopics) {
            flagHints.push("`--merge-duplicate-topics`")
          }
          // Fact / memory encoding and the agent-identity normalizer are
          // all plan-then-execute: `--yes` applies, not "re-run without
          // --dry-run". Suppress the generic footer when the user
          // explicitly asked for one of those flags — the dispatcher's
          // own output already tells them how to apply.
          const encodingFlagUsed =
            opts.fixFactEncoding ||
            opts.fixMemoryEncoding ||
            opts.normalizeAgents ||
            opts.buildEntities ||
            opts.mergeSimilarTopics ||
            opts.backfillSynopses ||
            opts.buildConfidenceScores ||
            opts.buildFactConfidenceScores ||
            opts.backfillFactObservedAt
          if (flagHints.length > 0) {
            console.log(
              `\nDry run — no changes written. Re-run without --dry-run and with ${flagHints.join(" and ")} to apply.`
            )
          } else if (!encodingFlagUsed && !aliasMergePlans) {
            // Skip the generic schema-side dry-run line when an encoding
            // dispatcher (`--fix-fact-encoding` / `--fix-memory-encoding`)
            // or `--merge-topics` already emitted its own context-aware
            // "Plan only … re-run with `--yes`" / "Read-only pass …
            // re-run with `--apply`" message a few lines up. Two dry-run
            // signals stacked on the same run train operators to ignore
            // them both.
            console.log(
              "\nDry run — no changes written. Re-run without --dry-run to apply."
            )
          }
        } else if (encodedTopics.length > 0 && !opts.fixTopicEncoding) {
          // Duplicate-name topics throw in `migrate()` when the flag is
          // omitted, but encoded names proceed silently — surface a nudge so
          // the user doesn't assume the listed rows were decoded.
          console.log(
            "\nRe-run with `--fix-topic-encoding` to decode the topic names listed above."
          )
        }
      } catch (err) {
        if (buildEntitiesLock) releaseMigrationLock(buildEntitiesLock)
        console.error("Migrate failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

interface MigrationScopeIntent {
  fixFactEncoding?: boolean
  fixMemoryEncoding?: boolean
  normalizeAgents?: boolean
  buildEntities?: boolean
  backfillFactSources?: boolean
  backfillSynopses?: boolean
  buildConfidenceScores?: boolean
  buildFactConfidenceScores?: boolean
  backfillFactObservedAt?: boolean
  project?: string
  includeArchived?: boolean
}

export interface MigrationProjectScope {
  projectId?: string
  projectName?: string
}

function isProjectScopedMigrationRequested(opts: MigrationScopeIntent): boolean {
  return Boolean(
    opts.fixFactEncoding ||
    opts.fixMemoryEncoding ||
    opts.normalizeAgents ||
    opts.buildEntities ||
    opts.backfillFactSources ||
    opts.backfillSynopses ||
    opts.buildConfidenceScores ||
    opts.buildFactConfidenceScores ||
    opts.backfillFactObservedAt
  )
}

export async function resolveMigrationProjectScope(
  services: LoreServices,
  opts: MigrationScopeIntent
): Promise<MigrationProjectScope> {
  if (!isProjectScopedMigrationRequested(opts) || opts.project === undefined) {
    return {}
  }

  const explicitProjectName = validateExplicitProjectScopeName(
    opts.project,
    "--project",
    {
      listHint: "run `lore status projects` to list configured projects",
      omittedScopeLabel: "vault-wide scope",
      includeArchivedHint:
        "If this is an archived project migration, pass --include-archived",
      docsHint: PROJECT_SCOPE_MIGRATION_DOC,
    }
  )
  if (explicitProjectName === undefined) return {}

  const project = await resolveProjectScopeName(
    services.projects,
    explicitProjectName,
    "--project",
    {
      listHint: "run `lore status projects` to list configured projects",
      omittedScopeLabel: "vault-wide scope",
      includeArchivedHint:
        "If this is an archived project migration, pass --include-archived",
      docsHint: PROJECT_SCOPE_MIGRATION_DOC,
      includeArchived: opts.includeArchived,
    }
  )
  return { projectId: project.id, projectName: project.name }
}

/**
 * Scan every memory, reclassify obvious free-form tags into `Keywords`, and
 * report ambiguous out-of-vocab tags for manual triage.
 *
 * Two-phase: snapshot every memory across all cursor pages first, then
 * apply updates. `MemoryService.list()` sorts by `last_edited_time desc`,
 * which the update step mutates — iterating and writing in the same loop
 * would shuffle memories between cursor pages and either double-process or
 * skip rows. Snapshot-then-apply eliminates that correctness hazard and
 * lets the final totals be authoritative.
 *
 * Idempotent: after running, the surviving out-of-vocab tags are exactly
 * the ambiguous ones, and re-running the migration moves nothing further
 * (the heuristic is deterministic per tag string).
 */
async function migrateOutOfVocabTags(
  services: LoreServices,
  options: { dryRun?: boolean }
): Promise<void> {
  const PAGE_SIZE = 100
  let cursor: string | undefined
  let scanned = 0
  const plans: MemoryTagPlan[] = []
  const ambiguousFreq = new Map<string, number>()

  // Scan pass — collect plans across every cursor page without
  // writing. No update() call inside this loop, so the sort order is
  // stable for the duration of pagination.
  //
  // `includeProposed: true` opts out of the `Status != proposed`
  // default-recall filter. This is a maintenance path that promises
  // a full-vault scan ("Reclassified N memories ... M memories
  // scanned"); silently skipping proposed rows would mis-report the
  // scanned total and break idempotency (a follow-up run after a row
  // leaves proposed state would suddenly find it).
  for (;;) {
    const { items, nextCursor } = await services.memories.list({
      limit: PAGE_SIZE,
      includeContent: false,
      includeProposed: true,
      startCursor: cursor,
    })
    if (items.length === 0 && !nextCursor) break

    for (const memory of items) {
      scanned++
      if (memory.tags.length === 0) continue

      const classification = classifyTags(memory.tags, services.profile.taxonomy.tags)
      for (const tag of classification.ambiguous) {
        ambiguousFreq.set(tag, (ambiguousFreq.get(tag) ?? 0) + 1)
      }

      const plan = planMemoryMigration(memory, services.profile.taxonomy.tags)
      if (plan) plans.push(plan)
    }

    cursor = nextCursor
    if (!cursor) break
  }

  const movedTotal = plans.reduce((n, p) => n + p.moved.length, 0)
  const verb = options.dryRun ? "Would reclassify" : "Reclassified"
  console.log(
    `\n${verb} ${plans.length} memor${plans.length === 1 ? "y" : "ies"} ` +
      `(${movedTotal} token${movedTotal === 1 ? "" : "s"} moved to Keywords, ` +
      `${scanned} memor${scanned === 1 ? "y" : "ies"} scanned).`
  )

  if (plans.length > 0) {
    console.log("\nSample reclassifications:")
    for (const plan of plans.slice(0, 10)) {
      console.log(
        `  ${plan.memoryId} — "${plan.title}"\n` +
          `    moved: ${plan.moved.join(", ") || "(none — case-drift normalization only)"}\n` +
          `    tags:  [${plan.before.tags.join(", ")}] → [${plan.after.tags.join(", ")}]`
      )
    }
    if (plans.length > 10) {
      console.log(`  … and ${plans.length - 10} more.`)
    }
  }

  // Apply pass — one update per snapshotted plan. Sequential writes
  // match the Notion API's rate ceiling and keep the per-memory error
  // blast radius contained.
  if (!options.dryRun && plans.length > 0) {
    let failed = 0
    for (const plan of plans) {
      try {
        await services.memories.update(plan.memoryId, {
          tags: plan.after.tags,
          keywords: plan.after.keywords,
        })
      } catch (err) {
        failed++
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`  failed ${plan.memoryId}: ${msg}`)
      }
    }
    if (failed > 0) {
      console.log(
        `(Applied ${plans.length - failed} of ${plans.length}; ${failed} failed — see errors above.)`
      )
    }
  }

  if (ambiguousFreq.size > 0) {
    const ranked = Array.from(ambiguousFreq.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 25)
    console.log(
      `\nAmbiguous tags left in place (top ${ranked.length} of ${ambiguousFreq.size}):`
    )
    for (const [tag, count] of ranked) {
      console.log(`  ${tag.padEnd(40)} ${count}`)
    }
    console.log(
      "\nTriage manually: rename to a vocabulary term, move into Keywords, or accept as-is."
    )
  }
}

/**
 * Upgrade legacy memories tagged `decision` to `Kind: decision`, stripping
 * the tag in the process. Idempotent: after upgrade, the query returns no
 * results and re-running is a no-op.
 *
 * Iterates in a loop calling `list({ tags: ["decision"] })` — since each
 * iteration upgrades the matched pages (removing the tag), subsequent
 * iterations only see remaining un-upgraded memories.
 */
async function upgradeLegacyDecisionTags(services: LoreServices): Promise<number> {
  const BATCH_SIZE = 100
  let upgraded = 0

  while (true) {
    // `includeProposed: true` opts out of the `Status != proposed`
    // default-recall filter. Pre-`Kind` legacy
    // rows tagged `decision` may carry any status — including
    // proposed — and the upgrade-then-strip contract must catch
    // every such row to be idempotent. Without the opt-in, a
    // proposed-status legacy `decision`-tagged row would persist
    // across the migration and resurface only after the row's
    // status changes.
    const { items: batch } = await services.memories.list({
      tags: ["decision"],
      limit: BATCH_SIZE,
      includeContent: false,
      includeProposed: true,
    })

    // Defensive filter in case a memory is already Kind=decision but still
    // has the tag for some reason — we still strip the tag in that case.
    const toUpgrade = batch.filter((m) => m.tags.includes("decision"))
    if (toUpgrade.length === 0) break

    for (const m of toUpgrade) {
      const newTags = m.tags.filter((t) => t !== "decision")
      await services.memories.update(m.id, {
        kind: "decision",
        tags: newTags,
      })
      upgraded++
    }
  }

  return upgraded
}

export interface FactMatchCandidate {
  fact: Fact
  memory: Memory | null
  /** Normalized description of how the candidate was chosen. */
  reason: string
}

/**
 * Find facts with an empty `Source` relation and propose a supporting
 * memory for each. Matching heuristic is deliberately conservative: we
 * require a search hit whose title contains the fact's subject or object.
 * Operator reviews the printed report and re-runs with `--apply` to commit.
 *
 * This is best-effort triage for the orphan backlog surfaced in the
 * internal vault audit — not a substitute for the write-side `sourceMemoryId`
 * discipline now enforced on `lore-fact action='create'`.
 */
export async function backfillFactSources(
  services: LoreServices,
  opts: { apply: boolean; projectId?: string }
): Promise<void> {
  const orphans = opts.projectId
    ? await services.facts.queryOrphans({ projectId: opts.projectId })
    : await services.facts.queryOrphans()

  if (orphans.length === 0) {
    console.log(
      "\nNo orphan facts found — every current fact already links to a source memory."
    )
    return
  }

  console.log(
    `\nFound ${orphans.length} orphan fact${orphans.length === 1 ? "" : "s"} (no Source relation).`
  )

  const candidates: FactMatchCandidate[] = []
  for (const fact of orphans) {
    const candidate = await proposeSourceMemory(services, fact)
    candidates.push(candidate)
  }

  const matched = candidates.filter((c) => c.memory !== null)
  const unmatched = candidates.filter((c) => c.memory === null)

  const verb = opts.apply ? "Linking" : "Proposed"
  console.log(`\n${verb} ${matched.length} match${matched.length === 1 ? "" : "es"}:`)
  for (const { fact, memory, reason } of matched) {
    if (!memory) continue
    console.log(
      `  ${fact.subject} → ${fact.predicate.replace(/_/g, " ")} → ${fact.object}`
    )
    console.log(
      `    fact ${fact.id} → memory "${memory.title}" (${memory.id}) [${reason}]`
    )
  }

  if (unmatched.length > 0) {
    console.log(
      `\n${unmatched.length} fact${unmatched.length === 1 ? "" : "s"} without a candidate memory (will remain orphan):`
    )
    for (const { fact } of unmatched) {
      console.log(
        `  fact ${fact.id}: ${fact.subject} ${fact.predicate.replace(/_/g, " ")} ${fact.object}`
      )
    }
  }

  if (opts.apply) {
    let applied = 0
    for (const { fact, memory } of matched) {
      if (!memory) continue
      await services.facts.setSource(fact.id, memory.id)
      applied++
    }
    console.log(
      `\nLinked ${applied} orphan fact${applied === 1 ? "" : "s"} to proposed source memor${applied === 1 ? "y" : "ies"}.`
    )
  } else {
    console.log(
      "\nRead-only pass — no Source relations written. Re-run with `--apply` to commit the matches above."
    )
  }
}

/**
 * Propose a supporting memory for an orphan fact via semantic search. Uses
 * the fact's subject as the primary query (most facts are structured
 * "Entity → predicate → Value" where the Subject is the central concept),
 * and falls back to the object if the subject search turns up nothing.
 *
 * Returns `null` memory when no candidate survives the title-match check.
 * False positives are more damaging than false negatives here — an orphan
 * fact is recoverable; a mis-linked Source distorts
 * `lore-query action='ask'` outputs for the lifetime of the fact.
 *
 * Assumes autosave is not creating facts concurrently. `setSource` at the
 * call site in `backfillFactSources` overwrites without re-checking, which
 * is safe when the backfill is operator-run during a quiet window.
 */
export async function proposeSourceMemory(
  services: Pick<LoreServices, "memories">,
  fact: Fact
): Promise<FactMatchCandidate> {
  const search = async (query: string): Promise<Memory | null> => {
    if (!matchableQuery(query)) return null

    // Scope to every project the fact is in, not just the first. A fact on
    // [A, B] should match memories in either project, not just in A.
    const projectIds = fact.projectIds.length > 0 ? fact.projectIds : [undefined]
    for (const projectId of projectIds) {
      const results = await services.memories.search({
        query,
        projectId,
        limit: 5,
        includeContent: false,
      })
      for (const memory of results) {
        if (titleMatches(memory.title, query)) return memory
      }
    }
    return null
  }

  const bySubject = await search(fact.subject)
  if (bySubject) {
    return { fact, memory: bySubject, reason: `title matches subject "${fact.subject}"` }
  }

  const byObject = await search(fact.object)
  if (byObject) {
    return { fact, memory: byObject, reason: `title matches object "${fact.object}"` }
  }

  return { fact, memory: null, reason: "no title match" }
}

/**
 * A query must be long enough to be discriminating, or multi-word so a
 * substring hit is unlikely to be incidental. Three-letter common tokens
 * ("API", "DB", "Widget") would otherwise false-positive against half the
 * workspace.
 */
function matchableQuery(query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length >= 4) return true
  return /\s/.test(trimmed)
}

/**
 * Accept a candidate only when the query appears as a whole word in the
 * title. `"API" → uses → "JSON"` must not match "rapid-fire" (contains
 * "api" as a substring) but should match "API design checklist".
 */
function titleMatches(title: string, query: string): boolean {
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(^|\\W)${escaped}($|\\W)`, "i")
  return pattern.test(title)
}

/** Max rows printed inline before the preview is truncated with a tally. */
const ENCODING_FIX_PREVIEW_LIMIT = 10

/**
 * Render a byte count in a scannable unit. Sub-1 KB values stay in
 * bytes (`512 B`), KB through sub-1 MB render as KB with one decimal
 * (`152.3 KB`), larger values render as MB. The oversize-body preview
 * compares these against `BODY_SIZE_CAP_BYTES` (100 KB), so operator
 * scanning `152.3 KB > 100 KB` is clearer than `155955 bytes > 102400`.
 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  const mb = kb / 1024
  return `${mb.toFixed(1)} MB`
}

/**
 * Stderr breadcrumb fired before a paginating discovery call so the
 * operator sees activity before the first (potentially long-blocking)
 * Notion query lands. The Notion SDK absorbs 429s with `Retry-After`-
 * driven sleeps capped at `DEFAULT_MAX_RETRY_DELAY_MS` (60s), and the
 * sleep happens inside a single `await` — without this breadcrumb, a
 * stalled discovery is indistinguishable from a hang.
 *
 * `label` is the noun phrase describing the rows being discovered
 * ("memories with empty Synopsis"). The helper appends a fixed
 * `LORE_DEBUG=1` pointer so every discovery surface points at the
 * same retry-trace switch — operators only have to remember the one
 * env var.
 *
 * Exported so the migrate-dispatcher tests can pin the breadcrumb
 * fragments without going through commander.
 */
export function printDiscoveryBreadcrumb(label: string): void {
  process.stderr.write(
    `Discovering ${label} (paginating Notion; set LORE_DEBUG=1 to trace retries)...\n`
  )
}

/**
 * Scan the Facts DB for rows carrying HTML-encoded Subject/Object payloads,
 * print a plan-then-apply report, and — when not a dry run and no collisions
 * block the row — rewrite Subject/Object/DedupKey in one atomic
 * `pages.update`. The collision gate matches the posture
 * `--fix-topic-encoding` / `--merge-duplicate-topics` established.
 */
export async function runFactEncodingFix(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean; projectId?: string }
): Promise<void> {
  // Plan-only means the underlying helper must not write. `apply` is the
  // single-truth bit for the write path; `dryRun` is a caller-intent
  // signal the helper still honors to keep the report shape consistent
  // with every other `--dry-run` surface.
  const planOnly = !options.apply
  const report = await services.facts.fixEncoding({
    dryRun: planOnly,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  })

  if (report.encoded.length === 0) {
    console.log(
      "\nNo HTML-encoded fact rows found — Subject and Object are already clean."
    )
    return
  }

  const blocked = new Set(report.collisions.flatMap((c) => c.factIds))
  const rewritable = report.encoded.filter((r) => !blocked.has(r.id))

  const verb = planOnly ? "Would decode" : "Decoded"
  const applied = planOnly ? rewritable.length : report.fixes.length
  console.log(
    `\n${verb} ${applied} HTML-encoded fact row${applied === 1 ? "" : "s"} ` +
      `(${report.encoded.length} total encoded; ${report.collisions.length} collision group${report.collisions.length === 1 ? "" : "s"} gated).`
  )

  const preview = planOnly ? rewritable : report.fixes
  for (const row of preview.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
    console.log(`  "${row.rawSubject}" ${row.predicate} "${row.rawObject}"`)
    console.log(`    → "${row.decodedSubject}" ${row.predicate} "${row.decodedObject}"`)
  }
  if (preview.length > ENCODING_FIX_PREVIEW_LIMIT) {
    console.log(`  … and ${preview.length - ENCODING_FIX_PREVIEW_LIMIT} more rows.`)
  }

  if (report.collisions.length > 0) {
    console.log(
      `\nGated by post-decode dedup-key collisions ` +
        `(${report.collisions.length} group${report.collisions.length === 1 ? "" : "s"} — ` +
        `rewrite refused to avoid silently creating a duplicate):`
    )
    for (const c of report.collisions.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
      console.log(`  "${c.triple.subject}" ${c.triple.predicate} "${c.triple.object}"`)
      console.log(`    factIds: ${c.factIds.join(", ")}`)
    }
    if (report.collisions.length > ENCODING_FIX_PREVIEW_LIMIT) {
      console.log(
        `  … and ${report.collisions.length - ENCODING_FIX_PREVIEW_LIMIT} more groups.`
      )
    }
    console.log(
      "\nRun `lore migrate --dedup-keys --merge --yes` to collapse the duplicates first, then re-run `lore migrate --fix-fact-encoding --yes`."
    )
  }

  // Plan-then-execute footer. Always prints in plan-only mode —
  // `--dry-run` and the bare default both want the `--yes` directive.
  // The global migrate action suppresses its generic "Re-run without
  // --dry-run" footer when an encoding flag is present, so there's no
  // double-footer.
  if (planOnly && rewritable.length > 0) {
    console.log("\nPlan only — no rewrites written. Re-run with `--yes` to execute.")
  }
}

/**
 * Scan the Memories DB for non-archived rows whose Title or body
 * markdown carry HTML entities, print a plan-then-apply report, and
 * — when not a dry run — rewrite Title via `pages.update` and body
 * via one of two paths:
 *
 * - **Default-off / flag-on within 100 KB cap**:
 *   `pages.updateMarkdown` full-body `replace_content`.
 * - **Flag-on (`LORE_USE_RUNTOOL_BLOCK_EDIT=1`) above the cap, row
 *   eligible**: RunTool `update_content` with deterministic
 *   per-entity substitutions. Multi-pass /
 *   no-substitutions oversized rows still surface in
 *   `oversizedSkipped`.
 *
 * Plan-mode preview reads `EncodedMemoryRow.anchoredPathPlanned`
 * (computed during scan with the same local guards as the apply
 * path) so per-row labels and the bucket counters reflect what
 * apply mode will do — the `fixMemoryEncoding` docstring carries the
 * predict/apply parity contract.
 */
export async function runMemoryEncodingFix(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean; projectId?: string }
): Promise<void> {
  const planOnly = !options.apply
  printDiscoveryBreadcrumb("memories with HTML-encoded Title or body")
  const report = await services.memories.fixEncoding({
    dryRun: planOnly,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  })

  if (report.encoded.length === 0) {
    console.log(
      "\nNo HTML-encoded memory rows found — Title and body markdown are already clean."
    )
    return
  }

  const verb = planOnly ? "Would decode" : "Decoded"
  // Plan-mode counters now route oversized rows through
  // `anchoredPathPlanned`: a row labeled `contentTooLargeToFix` is
  // still fixable when the RunTool flag is on AND the local guards
  // predict the anchored path will land. Without this gate, plan
  // output would say "body fixes: 0 (1 skipped)" while apply mode
  // would actually fix the row — breaking the plan-then-execute
  // contract under `LORE_USE_RUNTOOL_BLOCK_EDIT`.
  const isBodyFixablePlanned = (r: EncodedMemoryRow): boolean =>
    r.contentNeedsFix && (!r.contentTooLargeToFix || r.anchoredPathPlanned)
  const fixableRows = planOnly
    ? report.encoded.filter((r) => r.titleNeedsFix || isBodyFixablePlanned(r)).length
    : report.fixes.length
  const titlePlanned = planOnly
    ? report.encoded.filter((r) => r.titleNeedsFix).length
    : report.fixes.filter((f) => f.titleFixed).length
  const bodyPlanned = planOnly
    ? report.encoded.filter(isBodyFixablePlanned).length
    : report.fixes.filter((f) => f.contentFixed).length

  console.log(
    `\n${verb} ${fixableRows} HTML-encoded memor${fixableRows === 1 ? "y" : "ies"} ` +
      `(Title fixes: ${titlePlanned}; body fixes: ${bodyPlanned}).`
  )

  // Two distinct preview shapes: plan-only renders `EncodedMemoryRow`
  // (pre-write intent with `*NeedsFix` / `*TooLargeToFix` flags), apply
  // renders `MemoryEncodingFixResult` (post-write outcome with
  // `*Fixed` flags). Keeping the loops separate is more durable than
  // structural narrowing — a future field rename on either type stays
  // type-checked without the `"titleFixed" in row` branch becoming
  // silently wrong.
  const previewLength = planOnly ? report.encoded.length : report.fixes.length
  if (planOnly) {
    for (const row of report.encoded.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
      const parts: string[] = []
      if (row.titleNeedsFix) parts.push("title")
      // Three body-state shapes for the per-row preview:
      //   - non-oversized AND content needs fix → "body" (canonical path)
      //   - oversized AND anchored path planned → "body via anchored
      //     RunTool patterns"
      //   - oversized AND anchored path NOT planned → "body skipped"
      // The middle case is what was missing pre-review: plan output
      // labeled every oversized row as "skipped" regardless of whether
      // apply mode would actually fix it. The `anchoredPathPlanned`
      // flag is the apply-path guard fingerprint, so plan and apply
      // cannot drift.
      if (row.contentNeedsFix && !row.contentTooLargeToFix) {
        parts.push("body")
      } else if (row.contentTooLargeToFix && row.anchoredPathPlanned) {
        parts.push(
          `body via anchored RunTool patterns (${formatBytes(row.contentBytes)} > ${formatBytes(BODY_SIZE_CAP_BYTES)})`
        )
      } else if (row.contentTooLargeToFix) {
        parts.push(
          `body skipped (${formatBytes(row.contentBytes)} > ${formatBytes(BODY_SIZE_CAP_BYTES)})`
        )
      }
      console.log(
        `  ${row.id} — "${row.rawTitle}" → "${row.decodedTitle}" (${parts.join(", ")})`
      )
    }
  } else {
    for (const fix of report.fixes.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
      const parts: string[] = []
      if (fix.titleFixed) parts.push("title")
      if (fix.contentFixed) parts.push("body")
      console.log(
        `  ${fix.id} — "${fix.rawTitle}" → "${fix.decodedTitle}" (${parts.join(", ")})`
      )
    }
  }
  if (previewLength > ENCODING_FIX_PREVIEW_LIMIT) {
    console.log(`  … and ${previewLength - ENCODING_FIX_PREVIEW_LIMIT} more rows.`)
  }

  if (report.oversizedAnchoredPlanned.length > 0) {
    // New section under `LORE_USE_RUNTOOL_BLOCK_EDIT`: oversized
    // rows that DO get fixed via RunTool's
    // anchored `update_content` path. Distinguishing them from
    // `oversizedSkipped` is what keeps plan output truthful — the
    // pre-review version conflated both into a single "skipped"
    // bucket and silently understated what apply mode would do.
    const noun = report.oversizedAnchoredPlanned.length === 1 ? "memory" : "memories"
    const verbPhrase = planOnly
      ? "Will fix oversized body via anchored RunTool patterns on"
      : "Fixed oversized body via anchored RunTool patterns on"
    console.log(
      `\n${verbPhrase} ${report.oversizedAnchoredPlanned.length} ${noun} ` +
        `(body > ${formatBytes(BODY_SIZE_CAP_BYTES)}):`
    )
    for (const row of report.oversizedAnchoredPlanned.slice(
      0,
      ENCODING_FIX_PREVIEW_LIMIT
    )) {
      console.log(
        `  ${row.id} — "${row.decodedTitle}" (${formatBytes(row.contentBytes)})`
      )
    }
    if (report.oversizedAnchoredPlanned.length > ENCODING_FIX_PREVIEW_LIMIT) {
      console.log(
        `  … and ${report.oversizedAnchoredPlanned.length - ENCODING_FIX_PREVIEW_LIMIT} more rows.`
      )
    }
  }

  if (report.oversizedSkipped.length > 0) {
    console.log(
      `\nSkipped body rewrite on ${report.oversizedSkipped.length} memor${report.oversizedSkipped.length === 1 ? "y" : "ies"} ` +
        `(body exceeded ${formatBytes(BODY_SIZE_CAP_BYTES)} — Title fixes still apply when present):`
    )
    for (const row of report.oversizedSkipped.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
      console.log(
        `  ${row.id} — "${row.decodedTitle}" (${formatBytes(row.contentBytes)})`
      )
    }
    if (report.oversizedSkipped.length > ENCODING_FIX_PREVIEW_LIMIT) {
      console.log(
        `  … and ${report.oversizedSkipped.length - ENCODING_FIX_PREVIEW_LIMIT} more rows.`
      )
    }
  }

  if (report.contentFetchFailures.length > 0) {
    console.log(
      `\nBody fetch failed on ${report.contentFetchFailures.length} memor${report.contentFetchFailures.length === 1 ? "y" : "ies"} ` +
        "(transient Notion API error — Title fix still applied; re-run to retry the body):"
    )
    for (const row of report.contentFetchFailures.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
      console.log(`  ${row.id} — "${row.decodedTitle}"`)
    }
    if (report.contentFetchFailures.length > ENCODING_FIX_PREVIEW_LIMIT) {
      console.log(
        `  … and ${report.contentFetchFailures.length - ENCODING_FIX_PREVIEW_LIMIT} more rows.`
      )
    }
  }

  // Plan-then-execute footer. See `runFactEncodingFix` for rationale.
  if (planOnly && fixableRows > 0) {
    console.log("\nPlan only — no rewrites written. Re-run with `--yes` to execute.")
  }
}

const topicAliasMergesFileSchema = z.object({
  merges: z
    .array(
      z.object({
        canonical: z.string().min(1, "canonical must be non-empty"),
        aliases: z
          .array(z.string().min(1, "alias must be non-empty"))
          .min(1, "each merge must list at least one alias"),
      })
    )
    .min(1, "merges must contain at least one plan"),
})

/**
 * Load a topic-alias merges YAML file, parse it, and surface friendly
 * errors for the common mistakes (file missing, invalid YAML, wrong
 * shape). Resolves relative paths against the operator's cwd.
 */
export async function loadTopicAliasMerges(path: string): Promise<TopicAliasMergePlan[]> {
  const absolute = resolve(process.cwd(), path)
  let raw: string
  try {
    raw = await readFile(absolute, "utf-8")
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined
    if (code === "ENOENT") {
      throw new Error(`Merge file not found: ${absolute}`, { cause: err })
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse YAML in ${absolute}: ${msg}`, { cause: err })
  }

  const result = topicAliasMergesFileSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""
    throw new Error(`Invalid merge file ${absolute}${where}: ${issue.message}`)
  }

  return result.data.merges
}

/**
 * Print one block per merge plan: header line names the canonical + its
 * status (existing / would-be-created / no-op), followed by one indented
 * line per archived alias row and one summary line when projects change.
 * Kept compact so a YAML listing twenty plans doesn't scroll off-screen.
 */
export function printAliasMergeResults(
  results: TopicAliasMergeResult[],
  opts: { writing: boolean }
): void {
  const workingVerb = opts.writing ? "Merged" : "Would merge"
  const workingResults = results.filter((r) => !r.noop)

  if (workingResults.length === 0) {
    console.log(
      "\nNothing to merge — every alias in the plan already resolved to its canonical."
    )
  } else {
    console.log(
      `\n${workingVerb} ${workingResults.length} topic alias group${workingResults.length === 1 ? "" : "s"}:`
    )
    for (const result of workingResults) {
      const canonicalLabel = result.canonicalCreated
        ? opts.writing
          ? "canonical created"
          : "canonical would be created"
        : "existing canonical"
      console.log(`  "${result.canonical}" (${canonicalLabel})`)
      for (const { name, id } of result.archivedAliases) {
        console.log(`    archived alias "${name}" (${id})`)
      }
      // Collapse the memory clause when the only effect is a Project
      // union extension. Otherwise "re-pointed 0 memories; 4 projects on
      // canonical" reads like something was moved, when nothing was.
      const memories = result.reassignedMemoryIds.length
      const projects = result.canonicalProjectIds.length
      const verb = opts.writing ? "re-pointed" : "would re-point"
      if (memories > 0) {
        console.log(
          `    ${verb} ${memories} memor${memories === 1 ? "y" : "ies"}; ` +
            `${projects} project${projects === 1 ? "" : "s"} on canonical`
        )
      } else {
        console.log(
          `    canonical Project relation covers ${projects} project${projects === 1 ? "" : "s"}`
        )
      }
      if (result.unmatchedAliases.length > 0) {
        console.log(
          `    no match for: ${result.unmatchedAliases.map((a) => `"${a}"`).join(", ")}`
        )
      }
    }
  }

  const noops = results.filter((r) => r.noop)
  if (noops.length > 0) {
    console.log(
      `\n${noops.length} plan${noops.length === 1 ? "" : "s"} already merged (no aliases to collapse):`
    )
    for (const noop of noops) {
      const extra =
        noop.unmatchedAliases.length > 0
          ? ` (no match for: ${noop.unmatchedAliases.map((a) => `"${a}"`).join(", ")})`
          : ""
      console.log(`  "${noop.canonical}"${extra}`)
    }
  }
}

/**
 * Drive the agent-identity normalization pass and render the report.
 * Plan-only by default; `--yes` flips to apply mode. Mirrors the report
 * shape `runFactEncodingFix` / `runMemoryEncodingFix` use.
 *
 * Exported so the migrate CLI tests can exercise it without invoking
 * commander's argv plumbing.
 */
export async function runAgentNormalization(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean; projectId?: string }
): Promise<void> {
  const planOnly = !options.apply
  printDiscoveryBreadcrumb("memories with non-canonical Agent strings")
  const report = await services.memories.normalizeAgents({
    dryRun: planOnly,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  })

  if (report.encoded.length === 0) {
    console.log(
      "\nNo memories with non-canonical Agent strings found — every Agent value is already in its canonical form."
    )
    return
  }

  // Group by canonical destination so the operator sees, at a glance, how
  // many fragmented variants are collapsing onto each canonical string.
  // The "8 → Claude Code" framing is the value driver of this migration;
  // a flat per-row list buries it under prefix repetition.
  const byCanonical = new Map<string, NormalizableAgentRow[]>()
  for (const row of report.encoded) {
    const bucket = byCanonical.get(row.canonicalAgent) ?? []
    bucket.push(row)
    byCanonical.set(row.canonicalAgent, bucket)
  }

  const verb = planOnly ? "Would normalize" : "Normalized"
  const written = planOnly ? report.encoded.length : report.fixes.length
  console.log(
    `\n${verb} ${written} memor${written === 1 ? "y" : "ies"} ` +
      `(${byCanonical.size} canonical bucket${byCanonical.size === 1 ? "" : "s"}).`
  )

  for (const [canonical, rows] of byCanonical) {
    const variants = new Map<string, number>()
    for (const row of rows) {
      variants.set(row.rawAgent, (variants.get(row.rawAgent) ?? 0) + 1)
    }
    const ordered = Array.from(variants.entries()).sort((a, b) => b[1] - a[1])
    console.log(
      `  → "${canonical}" (${rows.length} memor${rows.length === 1 ? "y" : "ies"})`
    )
    for (const [variant, count] of ordered) {
      console.log(`     "${variant}" × ${count}`)
    }
  }

  if (report.errors.length > 0) {
    console.log(
      `\nFailed to rewrite ${report.errors.length} row${report.errors.length === 1 ? "" : "s"} (re-run to retry — the apply step is idempotent):`
    )
    const PREVIEW_LIMIT = 10
    for (const e of report.errors.slice(0, PREVIEW_LIMIT)) {
      console.log(`  ${e.id}: ${e.message}`)
    }
    if (report.errors.length > PREVIEW_LIMIT) {
      console.log(`  … and ${report.errors.length - PREVIEW_LIMIT} more failures.`)
    }
  }

  if (planOnly) {
    console.log(
      "\nPlan only — no rewrites written. Re-run with `--yes` to canonicalize the Agent column."
    )
  }
}

/**
 * Drive `--build-entities`. Plan-only by default; `--yes` flips to
 * apply. Mirrors the structure of `runFactEncodingFix` and friends so
 * the operator-facing language is consistent across the encoding /
 * task / entity migration family.
 *
 * Requires the standard five-database vault shape. `initServices` performs
 * that verification before this function runs, so this pass only
 * canonicalizes existing Fact rows.
 */
export async function runBuildEntitiesMigration(
  services: LoreServices,
  options: {
    apply: boolean
    dryRun?: boolean
    lock?: MigrationLock
    projectId?: string
  }
): Promise<EntityMigrationResult | null> {
  const ownsLock = options.lock === undefined
  const lock = options.lock ?? acquireBuildEntitiesMigrationLock(services, options)
  try {
    const planOnly = !options.apply
    const result = await buildEntities(services.facts, services.entities, {
      apply: options.apply,
      dryRun: options.dryRun,
      projectId: options.projectId,
    })

    if (result.plans.length === 0) {
      console.log("\nNo fact subjects/objects found — nothing to canonicalize.")
      return result
    }

    const verb = planOnly ? "Would canonicalize" : "Canonicalized"
    const newRows = result.entitiesCreated
    const aliasRows = result.aliasesAdded
    console.log(
      `\n${verb} ${result.plans.length} entity group${result.plans.length === 1 ? "" : "s"} ` +
        `(${planOnly ? "would create" : "created"} ${newRows} new entit${newRows === 1 ? "y" : "ies"}, ` +
        `${planOnly ? "would extend" : "extended"} ${aliasRows} alias${aliasRows === 1 ? "" : "es"} on existing rows; ` +
        `${planOnly ? "would fill" : "filled"} ${result.factsRepointed} fact row${result.factsRepointed === 1 ? "" : "s"} with empty entity relations).`
    )

    // Preview — surface the largest collapses first so the operator can
    // sanity-check the canonical/alias picks. Cap at 15 so a vault with
    // hundreds of groups doesn't flood the terminal.
    const PREVIEW_LIMIT = 15
    for (const plan of result.plans.slice(0, PREVIEW_LIMIT)) {
      const status = plan.existing ? " (existing)" : " (new)"
      const aliasPreview =
        plan.aliases.length === 0
          ? ""
          : `\n    aliases: ${plan.aliases
              .slice(0, 5)
              .map((a) => `"${a}"`)
              .join(
                ", "
              )}${plan.aliases.length > 5 ? `, …${plan.aliases.length - 5} more` : ""}`
      console.log(
        `  "${plan.canonical}"${status} — ${plan.factCount} fact${plan.factCount === 1 ? "" : "s"}${aliasPreview}`
      )
    }
    if (result.plans.length > PREVIEW_LIMIT) {
      console.log(`  … and ${result.plans.length - PREVIEW_LIMIT} more groups.`)
    }

    if (result.errors.length > 0) {
      console.log(
        `\nFailed on ${result.errors.length} item${result.errors.length === 1 ? "" : "s"}:`
      )
      for (const e of result.errors.slice(0, PREVIEW_LIMIT)) {
        const where = e.factId ? `fact ${e.factId}` : `entity "${e.entityKey ?? "?"}"`
        console.log(`  ${where}: ${e.message}`)
      }
      if (result.errors.length > PREVIEW_LIMIT) {
        console.log(`  … and ${result.errors.length - PREVIEW_LIMIT} more failures.`)
      }
    }

    if (planOnly) {
      console.log(
        "\nPlan only — no changes written. Re-run with `--yes` to create entity rows and fill empty fact relations."
      )
    }

    return result
  } finally {
    if (ownsLock && lock) releaseMigrationLock(lock)
  }
}

function acquireBuildEntitiesMigrationLock(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean }
): MigrationLock | null {
  if (!options.apply || options.dryRun === true) return null

  const result = tryAcquireMigrationLock({
    name: "build-entities",
    configRoot: services.configRoot,
    vaultPageId: services.config.vault.pageId,
  })
  if (result.acquired) return result.lock

  const owner = result.ownerPid ? `PID ${result.ownerPid}` : "an unknown process"
  throw new Error(
    "Another build-entities migration is already active for this vault " +
      `(${owner}). Wait for it to finish, then retry. If the process is no ` +
      `longer running or this lock is clearly stale, clear it with ` +
      `\`rm ${result.path}\`.`
  )
}

/**
 * Drive the orphan-rate report after `--build-entities`.
 *
 * Two execution paths, gated by `LORE_USE_RUNTOOL_AGGREGATE` (defaults
 * to the parent `LORE_USE_RUNTOOL`, which itself defaults ON):
 *
 * 1. **RunTool aggregate path.** Issues a single
 *    `query_data_sources` SQL query that groups facts by
 *    `(SubjectEntity, Subject)` and counts per group, then folds the
 *    rows through `computeOrphanRateFromAggregateRows`. **Default
 *    path** when neither flag is explicitly disabled.
 * 2. **JS enumeration path.** Walks every fact via
 *    `FactService.queryBySubject("", { allowUnfiltered: true,
 *    includeInvalidated: true })`, folds through
 *    `computeOrphanRateFromFacts`. Runs when either flag is set to
 *    `=0`, or when the RunTool path falls back per-call (capability
 *    gate / saturation / transient transport / malformed response).
 *    Serves every workspace tier including those below
 *    `hasAdvancedTools`.
 *
 * The flagged-on path falls back to the JS path **per call** on a
 * non-`validation_error` SDK error (403 / 429 / 5xx / network blip /
 * `SqlPartialResultError` / malformed response). A 400 /
 * `validation_error` re-throws so query-shape drift surfaces as an
 * operator-actionable failure rather than silently masking. The
 * fallback emits a one-line `[lore] partial-failure` notice under
 * `LORE_DEBUG=1`.
 *
 * **Pre/post-pass labeling**. `apply` is the canonical signal for
 * which graph the metric measured. On `apply === true` (i.e.
 * `--yes` and not `--dry-run`) the helper labels the output
 * `post-pass` because `runBuildEntitiesMigration` filled empty Fact
 * relations before this report ran. On `apply === false`
 * (plan-only, including `--dry-run`) the helper labels `pre-pass`
 * because the migration printed the plan without rewriting any
 * rows. Without this distinction an operator running the
 * operator-friendly preview (`--build-entities --report-orphan-rate
 * --dry-run`) would read the metric as if the migration had landed;
 * the silent mislabel was rejected during review.
 *
 * Read-only and best-effort — a failed report does NOT abort the
 * migration, since the migration's apply path has already landed by
 * the time this runs.
 */
export async function runOrphanRateReport(
  services: LoreServices,
  options: { apply: boolean; projectId?: string; projectName?: string }
): Promise<void> {
  const aggregateEnabled = (services.features ?? resolveFeatureFlags()).runTool.aggregate
  let report: OrphanRateReport | null = null
  let path: "runtool-aggregate" | "js-enumeration" = "js-enumeration"

  if (aggregateEnabled) {
    try {
      const rows = await querySubjectGroupCountsViaRunTool(services.client, {
        factsDataSourceId: services.vault.databases.facts.dataSourceId,
        subjectProperty: FACT_PROPS.SUBJECT,
        subjectEntityProperty: FACT_PROPS.SUBJECT_ENTITY,
        projectProperty: FACT_PROPS.PROJECT,
        projectId: options.projectId,
      })
      report = computeOrphanRateFromAggregateRows(rows)
      path = "runtool-aggregate"
    } catch (err) {
      if (isSqlValidationError(err)) {
        // Query-shape drift — surface to the operator instead of
        // silently masking with the JS path.
        throw err
      }
      logRunToolFallback("orphan-rate-aggregate", err)
      // Fall through to the JS path below.
    }
  }

  if (report === null) {
    // `includeInvalidated: true` keeps both paths semantically
    // equivalent — Notion's SQL gateway does not expose date columns
    // (`Valid Until`, `validUntil`, `valid_until` all return
    // `no such column`), so the SQL aggregate path counts every
    // fact regardless of invalidation. Without the matching opt-in
    // here, the JS fallback would silently report a different (lower)
    // count than the SQL path on the same vault. See
    // `querySubjectGroupCountsViaRunTool`'s docstring for the
    // tradeoff rationale.
    const facts = await services.facts.queryBySubject("", {
      projectId: options.projectId,
      allowUnfiltered: true,
      includeInvalidated: true,
    })
    report = computeOrphanRateFromFacts(facts)
    path = "js-enumeration"
  }

  const pct = (report.orphanRate * 100).toFixed(1)
  // Scope label: prefer the resolved project name when present so the
  // operator sees the same label they passed via `--project`. Mirrors
  // `--build-confidence-scores`'s plan-output posture.
  const scopeLabel = options.projectName
    ? `project ${JSON.stringify(options.projectName)}`
    : options.projectId
      ? "project-scoped"
      : "vault-wide"
  const passLabel = options.apply ? "post-pass" : "pre-pass"
  console.log(
    `Orphan rate (${passLabel}, ${scopeLabel}, via ${path}): ${pct}% — ` +
      `${report.totalGroups - report.groupsWithPeer}/${report.totalGroups} ` +
      `entit${report.totalGroups - report.groupsWithPeer === 1 ? "y" : "ies"} ` +
      `appear in exactly 1 fact (${report.totalFacts} fact${report.totalFacts === 1 ? "" : "s"} inspected, including invalidated).`
  )
  if (report.totalGroups > 0 && report.orphanRate < 0.5) {
    console.log(
      "  Below the PF3-01 50% acceptance threshold — case-folding canonicalization was sufficient."
    )
  } else if (report.totalGroups > 0) {
    console.log(
      "  At or above the PF3-01 50% threshold — the deferred richer-clusterer follow-up may be needed; see `src/core/AGENTS.md`."
    )
  }
}

/**
 * Collapse normalized-equivalent topic groups whose stored
 * names differ but normalize to the same key. Plan-only by default; the
 * apply pass rewrites memory→topic relations onto the canonical and
 * archives the sibling rows. Idempotent.
 */
export async function runSimilarTopicsMigration(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean }
): Promise<void> {
  const planOnly = !options.apply
  const { groups, mergeResults } = await services.vault.migrateSimilarTopics({
    dryRun: planOnly || options.dryRun === true,
  })

  if (groups.length === 0) {
    console.log(
      "\nNo normalized-equivalent topic groups found — every distinct stored " +
        "name has its own normalized key."
    )
    return
  }

  const verb = planOnly ? "Would merge" : "Merged"
  const totalSiblings = groups.reduce((n, g) => n + g.siblingIds.length, 0)
  console.log(
    `\n${verb} ${groups.length} normalized-equivalent topic group${groups.length === 1 ? "" : "s"} ` +
      `(${totalSiblings} sibling row${totalSiblings === 1 ? "" : "s"} would ${planOnly ? "be" : "have been"} archived):`
  )

  // 10 groups inline keeps wide vaults readable; the rest summarized.
  const PREVIEW_LIMIT = 10
  const sourceForReassign = new Map(mergeResults.map((r) => [r.canonicalId, r] as const))
  for (const group of groups.slice(0, PREVIEW_LIMIT)) {
    const reassignment = sourceForReassign.get(group.canonicalId)
    const memCount = reassignment?.reassignedMemoryIds.length ?? 0
    const aliasNames = group.siblings.map((s) => `"${s.name}"`).join(", ")
    console.log(
      `  "${group.canonicalName}" ← ${aliasNames} ` +
        `(${planOnly ? "would re-point" : "re-pointed"} ${memCount} memor${memCount === 1 ? "y" : "ies"})`
    )
  }
  if (groups.length > PREVIEW_LIMIT) {
    console.log(`  … and ${groups.length - PREVIEW_LIMIT} more groups.`)
  }

  if (planOnly) {
    console.log(
      "\nPlan only — no changes written. Re-run with `--yes` to archive the sibling rows " +
        "and re-point their memories onto each canonical."
    )
  }
}

/**
 * Parse the `--synopsis-backend` raw value into the typed union. The
 * commander option carries a default of `"claude"` so the operator
 * never sees `undefined`; the validator rejects anything else with a
 * directive error before any Notion call.
 */
export function parseSynopsisBackend(raw: string | undefined): SynopsisBackend {
  const value = (raw ?? "claude").toLowerCase()
  if (value === "claude" || value === "placeholder") return value
  console.error(`--synopsis-backend must be 'claude' or 'placeholder' (got '${raw}').`)
  process.exit(1)
}

/**
 * Parse the `--synopsis-batch-size` raw value into a positive integer.
 * Commander hands us strings even for numeric flags. Rejects
 * non-integer / non-positive values with a directive error before any
 * Notion call. Default is `DEFAULT_SYNOPSIS_BATCH_SIZE` (4).
 */
export function parseSynopsisBatchSize(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SYNOPSIS_BATCH_SIZE
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    console.error(`--synopsis-batch-size must be a positive integer (got '${raw}').`)
    process.exit(1)
  }
  return value
}

/** Cap on the number of preview rows surfaced inline in the synopsis-
 *  backfill plan output. Mirrors the convention other dispatchers use. */
const SYNOPSIS_BACKFILL_PREVIEW_LIMIT = 5

/**
 * Drive the synopsis backfill migration and render the operator-facing
 * report. Plan-only by default; `--yes` flips to apply mode. The
 * placeholder-backend branch swaps the verbs and renders
 * `n/a (placeholder backend)` in place of the literal `0` for the two
 * fetch-time counters that the backend never computes — the typed
 * report stays numeric per the "Display vs. typed report" contract.
 *
 * Exported so the migrate CLI tests can exercise it without invoking
 * commander's argv plumbing.
 */
export async function runSynopsisBackfill(
  services: LoreServices,
  options: {
    apply: boolean
    dryRun?: boolean
    backend: SynopsisBackend
    batchSize?: number
    /**
     * Resolved background-agent shape. Forwarded to
     * `backfillSynopses` so the configured binary / args drive the
     * synthesizer spawn. When omitted, the synthesizer falls through
     * to the historical claude-shaped defaults.
     */
    agent?: BackgroundAgentConfig
    projectId?: string
  }
): Promise<BackfillReport> {
  const planOnly = !options.apply || options.dryRun === true
  printDiscoveryBreadcrumb("memories with empty Synopsis")
  const report = await services.memories.backfillSynopses({
    apply: options.apply,
    dryRun: options.dryRun,
    backend: options.backend,
    batchSize: options.batchSize,
    agent: options.agent,
    ...(options.projectId ? { projectId: options.projectId } : {}),
  })

  if (report.totalCandidates === 0 && report.archivedSkipped === 0) {
    console.log(
      "\nNo memories with empty Synopsis found — every memory already has a synopsis."
    )
    return report
  }

  const backendLabel = options.backend === "placeholder" ? "placeholder" : "claude"
  const verb = planOnly
    ? "Would backfill"
    : options.backend === "placeholder"
      ? "Flagged"
      : "Synthesized"

  const wrote =
    options.backend === "placeholder" ? report.placeholderWritten : report.synthesized

  const batchSize = options.batchSize ?? DEFAULT_SYNOPSIS_BATCH_SIZE
  const batchClause = !planOnly ? `; batch-size: ${batchSize}` : ""
  console.log(
    `\n${verb} ${planOnly ? report.totalCandidates : wrote} ` +
      `synops${(planOnly ? report.totalCandidates : wrote) === 1 ? "is" : "es"} ` +
      `(backend: ${backendLabel}; ${report.totalCandidates} candidate${report.totalCandidates === 1 ? "" : "s"}; ` +
      `${report.archivedSkipped} archived skipped${batchClause}).`
  )

  // Per-bucket tallies. The two fetch-time counters render as
  // `n/a (placeholder backend)` on the placeholder apply path because
  // the backend never fetches a body to evaluate — a literal `0`
  // would imply "checked and found zero" when the migration didn't
  // check at all. The typed report keeps numeric `0` per the
  // "Display vs. typed report" contract.
  const bodyOversizeStr = formatBackfillBucket(
    report.bodyOversizeSkipped,
    options.backend,
    planOnly
  )
  const emptyBodyStr = formatBackfillBucket(
    report.emptyBodySkipped,
    options.backend,
    planOnly
  )
  const lines: string[] = []
  if (planOnly) {
    lines.push(
      `  body-oversize: ${bodyOversizeStr} (estimated, exact counts require --yes)`
    )
    lines.push(`  empty-body:    ${emptyBodyStr} (estimated, exact counts require --yes)`)
  } else {
    lines.push(`  body-oversize: ${bodyOversizeStr}`)
    lines.push(`  empty-body:    ${emptyBodyStr}`)
    if (report.truncated > 0) {
      lines.push(`  truncated:     ${report.truncated}`)
    }
    if (report.bodyFetchFailed > 0) {
      lines.push(`  fetch failed:  ${report.bodyFetchFailed}`)
    }
    if (report.synthesisFailed > 0) {
      lines.push(`  synth failed:  ${report.synthesisFailed}`)
    }
    if (report.scaffoldingRejected > 0) {
      lines.push(`  scaffolding:   ${report.scaffoldingRejected}`)
    }
    if (report.writeFailed > 0) {
      lines.push(`  write failed:  ${report.writeFailed}`)
    }
  }
  for (const line of lines) console.log(line)

  if (report.examples.length > 0) {
    console.log("\nExamples:")
    for (const example of report.examples.slice(0, SYNOPSIS_BACKFILL_PREVIEW_LIMIT)) {
      console.log(`  [${example.bucket}] ${example.id} — "${example.title}"`)
    }
  }

  if (planOnly) {
    if (options.backend === "claude") {
      console.log(
        "\nPlan only — no changes written. Re-run with `--yes` to synthesize " +
          "synopses via `claude -p`. Each candidate row pays one body fetch " +
          "and one synthesizer round-trip — review the candidate count above " +
          "before paying. `--synopsis-backend placeholder` is the no-LLM " +
          "alternative for test infrastructure or large-vault flagging."
      )
    } else {
      console.log(
        "\nPlan only — no changes written. Re-run with `--yes` to write the " +
          "SYNOPSIS_PLACEHOLDER_SENTINEL constant to every candidate row. " +
          "One-way: once a row carries the sentinel, the discovery filter " +
          "excludes it on every subsequent run. Read the issue 0.7.0/05 " +
          "spec's 'Sentinel choice' section before applying on a real vault."
      )
    }
  }

  return report
}

/**
 * Pure renderer for one of the two fetch-time counters
 * (`bodyOversizeSkipped` / `emptyBodySkipped`). The placeholder apply
 * path renders `n/a (placeholder backend)` because the backend never
 * fetches a body, so a literal `0` would be operator-misleading.
 * Plan-only and the claude apply path render the numeric value
 * verbatim. Exported so tests can pin the rendering rules separately
 * from the typed report.
 */
export function formatBackfillBucket(
  count: number,
  backend: SynopsisBackend,
  planOnly: boolean
): string {
  if (backend === "placeholder" && !planOnly) {
    return "n/a (placeholder backend)"
  }
  return String(count)
}

/**
 * Drive the build-confidence-scores migration and render the report.
 * Plan-only by default; `--yes` flips to apply mode. Mirrors
 * `runFactEncodingFix` / `runBuildEntitiesMigration` posture.
 *
 * Exported so the migrate CLI tests can exercise it without invoking
 * commander's argv plumbing.
 */
export async function runBuildConfidenceScores(
  services: LoreServices,
  options: {
    apply: boolean
    dryRun: boolean
    projectName?: string
    projectId?: string
  }
): Promise<BuildConfidenceScoresResult> {
  const planOnly = !options.apply
  // Pre-resolve `--project <name>` so a typo'd / unknown name throws
  // BEFORE the discovery breadcrumb prints. Without this preflight,
  // the operator would see "Discovering memories without a Confidence
  // Score in project X..." then immediately a "project X not found"
  // error — the breadcrumb implies forward motion that didn't happen.
  //
  // The downstream `runBuildConfidenceScoresMigration` re-checks the
  // same name as a defense-in-depth layer (so a future refactor that
  // drops this preflight cannot accidentally break the safety AC).
  // For the success path, `LruCache.getOrLoad` collapses the second
  // resolve to a cache hit — one in-memory lookup. For the failure
  // path, `findByName` returns `null` and the LRU explicitly does
  // NOT cache negatives, so the duplicate query would
  // re-run if reached — but it never is, because this preflight's
  // throw aborts before the migration call. The redundant work is
  // bounded to the success path only.
  const explicitProjectName = validateExplicitProjectScopeName(
    options.projectName,
    "--project",
    {
      listHint: "run `lore status projects` to list configured projects",
      omittedScopeLabel: "vault-wide scope",
      docsHint: PROJECT_SCOPE_MIGRATION_DOC,
    }
  )
  let projectId = options.projectId
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

  printDiscoveryBreadcrumb(
    options.projectName
      ? `memories without a Confidence Score in project "${options.projectName}"`
      : "memories without a Confidence Score"
  )

  const result = await runBuildConfidenceScoresMigration({
    services,
    apply: options.apply,
    dryRun: options.dryRun,
    projectName: options.projectName,
    projectId,
  })
  const { plan, written } = result

  console.log(
    `\n[lore] build-confidence-scores: scanned ${plan.totalMemoriesScanned} ` +
      `memor${plan.totalMemoriesScanned === 1 ? "y" : "ies"}`
  )
  console.log(
    `       ${plan.rowsToSeed.length} to seed (${plan.rowsAlreadyScored} already scored)`
  )

  if (plan.rowsToSeed.length === 0) {
    if (planOnly) {
      console.log(
        "\nNo memories need seeding — every row already has a Confidence Score."
      )
    } else {
      console.log(
        "\nNo memories needed seeding — every row already had a Confidence Score."
      )
    }
    return result
  }

  const stats = summarizeConfidenceScorePlan(plan)
  console.log(`       avg seeded score:  ${stats.avgSeeded.toFixed(2)}`)
  // The "to-seed" qualifier is load-bearing on a vault that's mostly
  // already-scored — averaging only the unseeded subset describes
  // what `--yes` would write, NOT what the vault as a whole looks
  // like. A label of "vault avg neglect" would mislead operators
  // running the migration against a partly-populated vault.
  console.log(
    `       avg decayed score: ${stats.avgDecayed.toFixed(2)} ` +
      `(to-seed avg neglect: ${stats.avgNeglectPastGrace} day${stats.avgNeglectPastGrace === 1 ? "" : "s"} past grace)`
  )

  const PREVIEW_LIMIT = 10
  const sortedByDecay = [...plan.rowsToSeed].sort(
    (a, b) => a.decayedScore - b.decayedScore
  )
  const top = sortedByDecay.slice(0, PREVIEW_LIMIT)
  if (top.length > 0) {
    console.log(`\n       Top ${top.length} most-decayed (after seed + decay):`)
    top.forEach((row, i) => {
      console.log(
        `       ${i + 1}. (${row.decayedScore.toFixed(3)}) ${row.title}  —  ${row.daysSinceCreation}d ago`
      )
    })
  }

  if (planOnly) {
    console.log("\n[lore] dry-run: no writes performed. Re-run with --yes to apply.")
  } else {
    console.log(
      `\n[lore] build-confidence-scores: wrote ${written} row${written === 1 ? "" : "s"}.`
    )
  }
  return result
}

/**
 * Fact-side mirror of `runBuildConfidenceScores` (DEFERRED-02). Same
 * plan-then-execute discipline: strict-resolve `--project`, scan
 * unscored facts via `FactService.listAllForBackfill`, render plan
 * summary, optionally apply with progress lines.
 */
export async function runBuildFactConfidenceScores(
  services: LoreServices,
  options: {
    apply: boolean
    dryRun: boolean
    projectName?: string
    projectId?: string
  }
): Promise<BuildFactConfidenceScoresResult> {
  const planOnly = !options.apply
  const explicitProjectName = validateExplicitProjectScopeName(
    options.projectName,
    "--project",
    {
      listHint: "run `lore status projects` to list configured projects",
      omittedScopeLabel: "vault-wide scope",
      docsHint: PROJECT_SCOPE_MIGRATION_DOC,
    }
  )
  let projectId = options.projectId
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

  printDiscoveryBreadcrumb(
    options.projectName
      ? `facts without a Confidence Score in project "${options.projectName}"`
      : "facts without a Confidence Score"
  )

  const result = await runBuildFactConfidenceScoresMigration({
    services,
    apply: options.apply,
    dryRun: options.dryRun,
    projectName: options.projectName,
    projectId,
  })
  const { plan, written } = result

  console.log(
    `\n[lore] build-fact-confidence-scores: scanned ${plan.totalFactsScanned} ` +
      `fact${plan.totalFactsScanned === 1 ? "" : "s"}`
  )
  console.log(
    `       ${plan.rowsToSeed.length} to seed (${plan.rowsAlreadyScored} already scored)`
  )

  if (plan.rowsToSeed.length === 0) {
    if (planOnly) {
      console.log("\nNo facts need seeding — every row already has a Confidence Score.")
    } else {
      console.log("\nNo facts needed seeding — every row already had a Confidence Score.")
    }
    return result
  }

  const stats = summarizeFactConfidenceScorePlan(plan)
  console.log(`       avg seeded score:  ${stats.avgSeeded.toFixed(2)}`)
  console.log(
    `       avg decayed score: ${stats.avgDecayed.toFixed(2)} ` +
      `(to-seed avg neglect: ${stats.avgNeglectPastGrace} day${stats.avgNeglectPastGrace === 1 ? "" : "s"} past grace)`
  )

  const PREVIEW_LIMIT = 10
  const sortedByDecay = [...plan.rowsToSeed].sort(
    (a, b) => a.decayedScore - b.decayedScore
  )
  const top = sortedByDecay.slice(0, PREVIEW_LIMIT)
  if (top.length > 0) {
    console.log(`\n       Top ${top.length} most-decayed (after seed + decay):`)
    top.forEach((row, i) => {
      const triple = `${row.subject} ${row.predicate.replace(/_/g, " ")} ${row.object}`
      console.log(
        `       ${i + 1}. (${row.decayedScore.toFixed(3)}) ${triple}  —  ${row.daysSinceCreation}d ago`
      )
    })
  }

  if (planOnly) {
    console.log("\n[lore] dry-run: no writes performed. Re-run with --yes to apply.")
  } else {
    console.log(
      `\n[lore] build-fact-confidence-scores: wrote ${written} row${written === 1 ? "" : "s"}.`
    )
  }
  return result
}

/**
 * Driver for `--backfill-fact-observed-at`. Same
 * plan-then-execute discipline as the sibling fact-confidence
 * migration: strict-resolve `--project`, walk every fact via
 * `FactService.listAllForBackfill` (including invalidated rows so
 * historical `Valid Until` values can seed `Invalidated At`), render
 * the plan, optionally apply with progress lines.
 */
export async function runBackfillFactObservedAt(
  services: LoreServices,
  options: {
    apply: boolean
    dryRun: boolean
    projectName?: string
    projectId?: string
  }
): Promise<BackfillFactObservedAtResult> {
  const planOnly = !options.apply
  const explicitProjectName = validateExplicitProjectScopeName(
    options.projectName,
    "--project",
    {
      listHint: "run `lore status projects` to list configured projects",
      omittedScopeLabel: "vault-wide scope",
      docsHint: PROJECT_SCOPE_MIGRATION_DOC,
    }
  )
  let projectId = options.projectId
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

  printDiscoveryBreadcrumb(
    options.projectName
      ? `facts missing transaction-time provenance in project "${options.projectName}"`
      : "facts missing transaction-time provenance"
  )

  const result = await runBackfillFactObservedAtMigration({
    services,
    apply: options.apply,
    dryRun: options.dryRun,
    projectName: options.projectName,
    projectId,
  })
  const { plan, written, failures } = result

  console.log(
    `\n[lore] backfill-fact-observed-at: scanned ${plan.totalFactsScanned} ` +
      `fact${plan.totalFactsScanned === 1 ? "" : "s"}`
  )
  console.log(
    `       ${plan.rowsToBackfill.length} to backfill ` +
      `(${plan.observedAtRowsToWrite} Observed At, ` +
      `${plan.invalidatedAtRowsToWrite} Invalidated At from Valid Until)`
  )
  console.log(`       ${plan.rowsAlreadyBackfilled} already backfilled`)

  if (plan.rowsToBackfill.length === 0) {
    if (planOnly) {
      console.log(
        "\nNo facts need backfilling — every row already carries Observed At / Invalidated At."
      )
    } else {
      console.log(
        "\nNo facts needed backfilling — every row already had Observed At / Invalidated At."
      )
    }
    return result
  }

  if (planOnly) {
    console.log("\n[lore] dry-run: no writes performed. Re-run with --yes to apply.")
  } else {
    console.log(
      `\n[lore] backfill-fact-observed-at: wrote ${written} row${written === 1 ? "" : "s"}.`
    )
    // Per-row failure surface. Lets the
    // operator distinguish transient errors (likely re-runnable) from
    // schema mismatches (need their own remediation) without parsing
    // stderr progress lines.
    if (failures.length > 0) {
      console.log(
        `[lore] backfill-fact-observed-at: ${failures.length} row${failures.length === 1 ? "" : "s"} failed; re-run to retry`
      )
      const PREVIEW = 5
      for (const failure of failures.slice(0, PREVIEW)) {
        // Route SDK error messages through redactDebugMessage
        // before rendering to a user-visible channel. Today's Notion
        // SDK does not interpolate page bodies into Error.message;
        // the redactor is forward-compat hardening that matches the
        // posture every other operator-visible error surface in this
        // codebase already adopts.
        console.log(`       - ${failure.factId}: ${redactDebugMessage(failure.message)}`)
      }
      if (failures.length > PREVIEW) {
        console.log(`       ... and ${failures.length - PREVIEW} more`)
      }
    }
  }
  return result
}

/**
 * Pure summary stats for the build-fact-confidence-scores plan output.
 * Mirror of `summarizeConfidenceScorePlan` (DEFERRED-02).
 */
export function summarizeFactConfidenceScorePlan(plan: BuildFactConfidenceScoresPlan): {
  avgSeeded: number
  avgDecayed: number
  avgNeglectPastGrace: number
} {
  const n = plan.rowsToSeed.length
  if (n === 0) {
    return { avgSeeded: 0, avgDecayed: 0, avgNeglectPastGrace: 0 }
  }
  const STALE_GRACE_DAYS = 60
  let seededSum = 0
  let decayedSum = 0
  let neglectPastGraceSum = 0
  for (const row of plan.rowsToSeed) {
    seededSum += row.seededScore
    decayedSum += row.decayedScore
    neglectPastGraceSum += Math.max(0, row.daysSinceCreation - STALE_GRACE_DAYS)
  }
  return {
    avgSeeded: seededSum / n,
    avgDecayed: decayedSum / n,
    avgNeglectPastGrace: Math.round(neglectPastGraceSum / n),
  }
}

/**
 * Pure summary stats for the build-confidence-scores plan output.
 * Exported so tests pin the per-line numbers without re-deriving the
 * arithmetic.
 */
export function summarizeConfidenceScorePlan(plan: BuildConfidenceScoresPlan): {
  avgSeeded: number
  avgDecayed: number
  avgNeglectPastGrace: number
} {
  const n = plan.rowsToSeed.length
  if (n === 0) {
    return { avgSeeded: 0, avgDecayed: 0, avgNeglectPastGrace: 0 }
  }
  const STALE_GRACE_DAYS = 60
  let seededSum = 0
  let decayedSum = 0
  let neglectPastGraceSum = 0
  for (const row of plan.rowsToSeed) {
    seededSum += row.seededScore
    decayedSum += row.decayedScore
    neglectPastGraceSum += Math.max(0, row.daysSinceCreation - STALE_GRACE_DAYS)
  }
  return {
    avgSeeded: seededSum / n,
    avgDecayed: decayedSum / n,
    avgNeglectPastGrace: Math.round(neglectPastGraceSum / n),
  }
}
