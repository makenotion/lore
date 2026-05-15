import { Command } from "commander"
import { initServices } from "../../services.js"
import type { TopicAliasMergePlan } from "../../core/topic-merge.js"
import { mergeHookDefaults } from "../../hooks/config.js"
import { releaseMigrationLock, type MigrationLock } from "../migration-lock.js"
import { runAgentNormalization } from "./migrate/agent-normalization.js"
import {
  runBuildConfidenceScores,
  runBuildFactConfidenceScores,
} from "./migrate/confidence.js"
import { runDedupKeysMigration } from "./migrate/dedup-keys.js"
import { upgradeLegacyDecisionTags } from "./migrate/decision-tags.js"
import {
  acquireBuildEntitiesMigrationLock,
  runBuildEntitiesMigration,
} from "./migrate/entities.js"
import { runFactEncodingFix, runMemoryEncodingFix } from "./migrate/encoding.js"
import { runBackfillFactObservedAt } from "./migrate/fact-observed-at.js"
import { backfillFactSources } from "./migrate/fact-sources.js"
import { runOrphanRateReport } from "./migrate/orphan-rate.js"
import { runSchemaMigration } from "./migrate/schema.js"
import {
  PROJECT_SCOPE_MIGRATION_DOC,
  isProjectScopedMigrationRequested,
  resolveMigrationProjectScope,
} from "./migrate/shared.js"
import {
  parseSynopsisBackend,
  parseSynopsisBatchSize,
  runSynopsisBackfill,
} from "./migrate/synopsis.js"
import { runOutOfVocabTagMigration } from "./migrate/tags.js"
import {
  loadTopicAliasMerges,
  printAliasMergeResults,
  runSimilarTopicsMigration,
} from "./migrate/topic-merge.js"

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
        const synopsisBackend = parseSynopsisBackend(opts.synopsisBackend)
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

        const schemaResult = await runSchemaMigration(services, {
          dryRun: opts.dryRun,
          mergeDuplicateTopics: opts.mergeDuplicateTopics,
          fixTopicEncoding: opts.fixTopicEncoding,
          upgradeDecisionTags: opts.upgradeDecisionTags,
          tags: opts.tags,
          dedupKeys: opts.dedupKeys,
          hasAliasMergePlans: aliasMergePlans !== null,
        })
        const { diffs, duplicateTopics, encodedTopics, totalBlockedOptions } =
          schemaResult

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
          await runOutOfVocabTagMigration(services, {
            dryRun: opts.dryRun,
            diffs,
          })
        }

        if (opts.dedupKeys) {
          await runDedupKeysMigration(services, {
            merge: opts.merge,
            dryRun: opts.dryRun,
            yes: opts.yes,
          })
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
