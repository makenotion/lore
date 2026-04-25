import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { Command } from "commander"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { initServices, type LoreServices } from "../../services.js"
import type { MemoryTagPlan } from "../../core/tag-migration.js"
import { classifyTags, planMemoryMigration } from "../../core/tag-migration.js"
import { BODY_SIZE_CAP_BYTES } from "../../core/memory-encoding.js"
import type {
  TopicAliasMergePlan,
  TopicAliasMergeResult,
} from "../../core/topic-merge.js"
import type { Fact, Memory } from "../../types.js"

export const migrateCommand = new Command("migrate")
  .description("Add missing schema properties to the vault's data sources")
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
    "--fix-topic-encoding",
    "Decode HTML entities (`&amp;`, `&lt;`, …) in topic names so rows like `Build &amp;amp; Tooling` become `Build & Tooling`. Runs before duplicate detection, so pair with `--merge-duplicate-topics` to collapse cross-encoding duplicates."
  )
  .option(
    "--fix-fact-encoding",
    "Decode HTML entities in fact Subject/Object columns and recompute DedupKey so pre-PF1-06 rows stop carrying `Foo &amp;amp; Bar` payloads. Refuses to rewrite any row whose post-decode dedup key would collide with another live fact; pair with `--dedup-keys --merge --yes` first to resolve those. Plan-only by default — re-run with `--yes` to apply. Combine with `--dry-run` for a plan preview."
  )
  .option(
    "--fix-memory-encoding",
    "Decode HTML entities in memory Title and body markdown for every non-archived memory. Body rewrite is skipped for pages larger than 100 KB — Title is always fixed, because Title is the value driver for downstream near-duplicate / embedding surfaces. Plan-only by default — re-run with `--yes` to apply. Combine with `--dry-run` for a plan preview."
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
    "Find facts with empty Source relations, propose supporting memories via conservative title-word-boundary match. Prints a report; add --apply to write. A wrong Source distorts `lore-ask` outputs for the lifetime of the fact, so matching is deliberately narrow — unmatched orphans stay orphan until an operator reviews."
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
    "--yes",
    "Execute the plan for `--merge`, `--fix-fact-encoding`, or `--fix-memory-encoding`. Without `--yes`, those flags are plan-only."
  )
  .action(
    async (opts: {
      dryRun?: boolean
      upgradeDecisionTags?: boolean
      mergeDuplicateTopics?: boolean
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
    }) => {
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
          !opts.fixMemoryEncoding
        ) {
          console.error(
            "--yes only applies together with --merge, --fix-fact-encoding, or --fix-memory-encoding."
          )
          process.exit(1)
        }

        // Load & validate merge-topics YAML before initializing services so
        // a malformed file fails fast, without a Notion round-trip.
        let aliasMergePlans: TopicAliasMergePlan[] | null = null
        if (opts.mergeTopics) {
          aliasMergePlans = await loadTopicAliasMerges(opts.mergeTopics)
        }

        const services = await initServices()

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
        const totalRelationConfig = diffs.reduce(
          (n, d) => n + d.addedRelationConfig.length,
          0
        )

        const verb = opts.dryRun ? "Would add" : "Added"
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
              console.log(`  ${diff.database}.${added.property}: ${added.options.join(", ")}`)
            }
          }
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

        if (opts.upgradeDecisionTags) {
          if (opts.dryRun) {
            console.log("\n--upgrade-decision-tags with --dry-run is a no-op (schema diff above).")
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
          const keywordsMissing = memoriesDiff?.missing.includes("Keywords") ?? false
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
          // a P1-04-migrated vault where only SubjectKey needed writing
          // would otherwise show "Backfilled DedupKey + SubjectKey on N
          // facts" and have the operator wondering why DedupKey got
          // rewritten. The aggregate phrasing matches the trigger
          // semantics without needing per-column counters.
          console.log(
            `\n${dedupVerb} key columns on ${result.backfilled} fact${result.backfilled === 1 ? "" : "s"} (${result.skipped} already up to date).`
          )
          if (opts.merge) {
            const plannedLosers = result.plans.reduce(
              (n, p) => n + p.loserIds.length,
              0
            )
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
              console.log(
                `  … and ${result.plans.length - PREVIEW_LIMIT} more groups.`
              )
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
          })
        }

        if (opts.fixMemoryEncoding) {
          await runMemoryEncodingFix(services, {
            apply: Boolean(opts.yes) && !opts.dryRun,
            dryRun: opts.dryRun,
          })
        }

        if (aliasMergePlans) {
          // Dry-run is opt-in via the flag *or* implicit when --apply is
          // omitted: operators who forget a flag get a preview, never a
          // silent archive. --dry-run + --apply would be ambiguous, so we
          // honor dry-run whenever it's set regardless of --apply.
          //
          // Posture: --apply (not --yes). P1-10's encoding migrations use
          // --yes as the commit gate because the rewrite rewrites every
          // fact body (bigger blast radius than one rename). P2-08's spec
          // explicitly specifies --apply, matching --backfill-fact-sources.
          // Kept as-is per spec; the irreversibility caveat below closes
          // the gap that --yes would otherwise have signalled.
          const writing = opts.apply === true && !opts.dryRun
          const results = await services.vault.migrateAliasMerges(
            aliasMergePlans,
            { dryRun: !writing }
          )
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
          // Fact / memory encoding are plan-then-execute: `--yes` applies,
          // not "re-run without --dry-run". Suppress the generic footer
          // when the user explicitly asked for one of those flags — the
          // dispatcher's own output already tells them how to apply.
          const encodingFlagUsed =
            opts.fixFactEncoding || opts.fixMemoryEncoding
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
            console.log("\nDry run — no changes written. Re-run without --dry-run to apply.")
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
        console.error("Migrate failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

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

  // Phase 1 — scan: collect plans across every cursor page without
  // writing. No update() call inside this loop, so the sort order is
  // stable for the duration of pagination.
  for (;;) {
    const { items, nextCursor } = await services.memories.list({
      limit: PAGE_SIZE,
      includeContent: false,
      startCursor: cursor,
    })
    if (items.length === 0 && !nextCursor) break

    for (const memory of items) {
      scanned++
      if (memory.tags.length === 0) continue

      const classification = classifyTags(memory.tags)
      for (const tag of classification.ambiguous) {
        ambiguousFreq.set(tag, (ambiguousFreq.get(tag) ?? 0) + 1)
      }

      const plan = planMemoryMigration(memory)
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

  // Phase 2 — apply: one update per snapshotted plan. Sequential writes
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
    const { items: batch } = await services.memories.list({
      tags: ["decision"],
      limit: BATCH_SIZE,
      includeContent: false,
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
 * This is best-effort triage for the orphan backlog surfaced in the Mail
 * vault audit — not a substitute for the write-side `sourceMemoryId`
 * discipline now enforced on `lore-learn`.
 */
export async function backfillFactSources(
  services: LoreServices,
  opts: { apply: boolean }
): Promise<void> {
  const orphans = await services.facts.queryOrphans()

  if (orphans.length === 0) {
    console.log("\nNo orphan facts found — every current fact already links to a source memory.")
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
  console.log(
    `\n${verb} ${matched.length} match${matched.length === 1 ? "" : "es"}:`
  )
  for (const { fact, memory, reason } of matched) {
    if (!memory) continue
    console.log(
      `  ${fact.subject} → ${fact.predicate.replace(/_/g, " ")} → ${fact.object}`
    )
    console.log(`    fact ${fact.id} → memory "${memory.title}" (${memory.id}) [${reason}]`)
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
 * fact is recoverable; a mis-linked Source distorts `lore-ask` outputs for
 * the lifetime of the fact.
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
 * ("API", "DB", "Mail") would otherwise false-positive against half the
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
 * Scan the Facts DB for rows carrying HTML-encoded Subject/Object payloads,
 * print a plan-then-apply report, and — when not a dry run and no collisions
 * block the row — rewrite Subject/Object/DedupKey in one atomic
 * `pages.update`. The collision gate mirrors the posture P1-10 established
 * for `--fix-topic-encoding` / `--merge-duplicate-topics`.
 */
export async function runFactEncodingFix(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean }
): Promise<void> {
  // Plan-only means the underlying helper must not write. `apply` is the
  // single-truth bit for the write path; `dryRun` is a caller-intent
  // signal the helper still honors to keep the report shape consistent
  // with every other `--dry-run` surface.
  const planOnly = !options.apply
  const report = await services.facts.fixEncoding({ dryRun: planOnly })

  if (report.encoded.length === 0) {
    console.log("\nNo HTML-encoded fact rows found — Subject and Object are already clean.")
    return
  }

  const blocked = new Set(
    report.collisions.flatMap((c) => c.factIds)
  )
  const rewritable = report.encoded.filter((r) => !blocked.has(r.id))

  const verb = planOnly ? "Would decode" : "Decoded"
  const applied = planOnly ? rewritable.length : report.fixes.length
  console.log(
    `\n${verb} ${applied} HTML-encoded fact row${applied === 1 ? "" : "s"} ` +
      `(${report.encoded.length} total encoded; ${report.collisions.length} collision group${report.collisions.length === 1 ? "" : "s"} gated).`
  )

  const preview = planOnly ? rewritable : report.fixes
  for (const row of preview.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
    console.log(
      `  "${row.rawSubject}" ${row.predicate} "${row.rawObject}"`
    )
    console.log(
      `    → "${row.decodedSubject}" ${row.predicate} "${row.decodedObject}"`
    )
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
      console.log(
        `  "${c.triple.subject}" ${c.triple.predicate} "${c.triple.object}"`
      )
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
 * Scan the Memories DB for non-archived rows whose Title or body markdown
 * carry HTML entities, print a plan-then-apply report, and — when not a
 * dry run — rewrite Title via `pages.update` and body (if ≤100 KB) via
 * `pages.updateMarkdown`.
 */
export async function runMemoryEncodingFix(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean }
): Promise<void> {
  const planOnly = !options.apply
  const report = await services.memories.fixEncoding({ dryRun: planOnly })

  if (report.encoded.length === 0) {
    console.log(
      "\nNo HTML-encoded memory rows found — Title and body markdown are already clean."
    )
    return
  }

  const verb = planOnly ? "Would decode" : "Decoded"
  const fixableRows = planOnly
    ? report.encoded.filter(
        (r) => r.titleNeedsFix || (r.contentNeedsFix && !r.contentTooLargeToFix)
      ).length
    : report.fixes.length
  const titlePlanned = planOnly
    ? report.encoded.filter((r) => r.titleNeedsFix).length
    : report.fixes.filter((f) => f.titleFixed).length
  const bodyPlanned = planOnly
    ? report.encoded.filter((r) => r.contentNeedsFix && !r.contentTooLargeToFix).length
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
      if (row.contentNeedsFix && !row.contentTooLargeToFix) parts.push("body")
      else if (row.contentTooLargeToFix) {
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
    console.log(
      `  … and ${previewLength - ENCODING_FIX_PREVIEW_LIMIT} more rows.`
    )
  }

  if (report.oversizedSkipped.length > 0) {
    console.log(
      `\nSkipped body rewrite on ${report.oversizedSkipped.length} memor${report.oversizedSkipped.length === 1 ? "y" : "ies"} ` +
        `(body exceeded ${formatBytes(BODY_SIZE_CAP_BYTES)} — Title fixes still apply when present):`
    )
    for (const row of report.oversizedSkipped.slice(0, ENCODING_FIX_PREVIEW_LIMIT)) {
      console.log(`  ${row.id} — "${row.decodedTitle}" (${formatBytes(row.contentBytes)})`)
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
export async function loadTopicAliasMerges(
  path: string
): Promise<TopicAliasMergePlan[]> {
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
