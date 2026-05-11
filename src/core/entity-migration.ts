/**
 * Build-entities migration (PF3-01).
 *
 * Walks every live fact, groups distinct Subject + Object strings by
 * `computeSubjectKey`, proposes one canonical Entity per group with the
 * remaining raw forms as aliases, and re-points each fact's
 * `SubjectEntity` / `ObjectEntity` relation at the surviving row.
 *
 * Two-phase. Plan-only by default — operators inspect the proposed
 * canonical/alias split before any writes land. Re-running with
 * `apply: true` creates Entity rows and rewrites Fact relations in
 * place; original Subject / Object text stays unchanged so the
 * substring-fallback path keeps working for any callers that bypass
 * the relation.
 *
 * Idempotent. A second run on a post-migration vault sees existing
 * Entity rows for every key and either no-ops (everything already
 * pointed) or extends aliases for stray strings the first pass didn't
 * see. The migration never demotes — an entity that's been manually
 * edited inside Notion is left alone except for additive alias
 * append.
 */

import type { Entity, Fact } from "../types.js"
import { computeSubjectKey } from "../notion/normalize.js"
import {
  extractFirstRelationId,
  type SqlSubjectGroupCount,
} from "../notion/runtool/query.js"
import type { FactService } from "./fact.js"
import type { EntityService } from "./entity.js"

/**
 * Side of the triple a string was found on. Surfaces in plan output so
 * an operator inspecting the report can tell whether a particular
 * canonical proposal is dominated by Subject or Object hits.
 */
export type EntitySide = "subject" | "object"

/**
 * One observation of a raw string in the fact graph. Multiple
 * observations from different facts (or sides) collapse into one
 * `EntityGroup` keyed by the normalized form.
 */
interface RawObservation {
  raw: string
  factId: string
  side: EntitySide
}

/**
 * Proposed Entity row plus the raw strings (and their fact provenances)
 * that map onto it. The first plan element (`canonical`) becomes the
 * `Name` cell; every other element joins the `Aliases` rich_text.
 */
export interface EntityGroupPlan {
  /** Normalized form. Stable identifier across runs. */
  key: string
  /**
   * The canonical raw form. The migration picks the longest raw
   * observation as canonical so a richer-handle variant
   * (`MemoryService.create`) survives over the bare form
   * (`MemoryService`). When ≥2 forms tie on length, the lexicographically
   * smallest form wins so the choice is deterministic across runs.
   */
  canonical: string
  /**
   * Other raw observations that fold onto the canonical. Each appears
   * exactly once in the alias list even if it was observed many times.
   */
  aliases: string[]
  /** Number of facts that referenced any form in this group. */
  factCount: number
  /** Up to 5 sample fact IDs for operator inspection. */
  sampleFactIds: string[]
  /**
   * Existing Entity row that already covers this key (matched by Name
   * or Alias). When set, the migration extends the row's alias list
   * rather than creating a fresh row. Null on a vault that hasn't been
   * migrated yet.
   */
  existing: Entity | null
}

export interface EntityMigrationResult {
  /** Per-group plan. Always populated regardless of apply mode. */
  plans: EntityGroupPlan[]
  /** Total distinct entity groups discovered. */
  groupCount: number
  /**
   * Number of Entity rows the migration would create on apply. Excludes
   * groups whose key already has an existing Entity (those land as
   * alias appends, counted in `aliasesAdded`).
   */
  entitiesCreated: number
  /**
   * Number of alias values appended across existing entity rows.
   * Counted by aliases not already present on the entity at start of
   * run.
   */
  aliasesAdded: number
  /**
   * Fact rows whose `SubjectEntity` and/or `ObjectEntity` relation was
   * rewritten. A row that gets both relations updated counts once.
   */
  factsRepointed: number
  /** Per-fact errors during the apply phase — bounds the blast radius. */
  errors: Array<{ factId?: string; entityKey?: string; message: string }>
  /** True when the run was plan-only. */
  planOnly: boolean
}

export interface BuildEntitiesOptions {
  /**
   * Apply gate. When false, the migration computes the plan and returns
   * without writing. The CLI default mirrors the dedup-merge / fact-
   * encoding posture: bare invocation prints the plan; `--yes` applies.
   */
  apply: boolean
  /** Plan-only signal that takes precedence over `apply`. */
  dryRun?: boolean
  /** Optional project scope. Omit to scan vault-wide. */
  projectId?: string
}

/**
 * Pick the canonical raw form from a group's observations. Tie-breaker
 * is lexicographically smallest so two runs on the same input agree.
 *
 * Exported for tests.
 */
export function pickCanonical(rawForms: string[]): string {
  if (rawForms.length === 0) return ""
  let best = rawForms[0]
  for (const candidate of rawForms.slice(1)) {
    if (
      candidate.length > best.length ||
      (candidate.length === best.length && candidate < best)
    ) {
      best = candidate
    }
  }
  return best
}

/**
 * Group raw observations by `computeSubjectKey`. Empty / whitespace-only
 * keys are dropped — they would otherwise collapse every punctuation-
 * only string into one degenerate "everything" entity.
 */
export function groupObservationsByKey(
  observations: RawObservation[]
): Map<string, { rawForms: Set<string>; factIds: string[] }> {
  const groups = new Map<
    string,
    { rawForms: Set<string>; factIds: string[] }
  >()
  for (const obs of observations) {
    const key = computeSubjectKey(obs.raw)
    if (!key) continue
    let group = groups.get(key)
    if (!group) {
      group = { rawForms: new Set(), factIds: [] }
      groups.set(key, group)
    }
    group.rawForms.add(obs.raw)
    group.factIds.push(obs.factId)
  }
  return groups
}

/**
 * Build entity plan from a list of facts and an existing-entity index.
 * Pure — no Notion calls. Exported so tests can pin the grouping logic
 * without spinning up the migration's plumbing.
 */
export function planEntityMigration(
  facts: Fact[],
  existingByKey: Map<string, Entity>
): EntityGroupPlan[] {
  const observations: RawObservation[] = []
  for (const fact of facts) {
    if (fact.subject) {
      observations.push({ raw: fact.subject, factId: fact.id, side: "subject" })
    }
    if (fact.object) {
      observations.push({ raw: fact.object, factId: fact.id, side: "object" })
    }
  }

  const groups = groupObservationsByKey(observations)
  const plans: EntityGroupPlan[] = []

  for (const [key, group] of groups) {
    const rawForms = Array.from(group.rawForms)
    const canonical = pickCanonical(rawForms)
    const aliases = rawForms.filter((r) => r !== canonical)
    // Dedupe fact ids preserving observation order so the sample is
    // representative of the earliest-discovered facts.
    const uniqueFactIds: string[] = []
    const seen = new Set<string>()
    for (const id of group.factIds) {
      if (seen.has(id)) continue
      seen.add(id)
      uniqueFactIds.push(id)
      if (uniqueFactIds.length >= 5) break
    }

    plans.push({
      key,
      canonical,
      aliases: aliases.sort(),
      factCount: new Set(group.factIds).size,
      sampleFactIds: uniqueFactIds,
      existing: existingByKey.get(key) ?? null,
    })
  }

  // Stable sort: most-referenced groups first, then by key for
  // tie-breaking. Operator scanning the plan sees the largest collapse
  // wins at the top.
  plans.sort((a, b) => {
    if (b.factCount !== a.factCount) return b.factCount - a.factCount
    return a.key.localeCompare(b.key)
  })

  return plans
}

/**
 * Index every existing entity by every form it could be looked up
 * under (canonical Name and each alias), all under their normalized
 * keys. Used to detect "this group already has a row" in the plan
 * phase so the migration extends rather than re-creates.
 */
export function indexEntitiesByKey(entities: Entity[]): Map<string, Entity> {
  const index = new Map<string, Entity>()
  for (const entity of entities) {
    const nameKey = computeSubjectKey(entity.name)
    if (nameKey) index.set(nameKey, entity)
    for (const alias of entity.aliases) {
      const aliasKey = computeSubjectKey(alias)
      if (aliasKey && !index.has(aliasKey)) index.set(aliasKey, entity)
    }
  }
  return index
}

/**
 * Drive the full plan + apply migration. Reads every live fact in
 * scope, indexes existing entities, computes the plan, and (when
 * `apply: true`) creates entities + repoints fact relations.
 */
export async function buildEntities(
  facts: FactService,
  entities: EntityService,
  options: BuildEntitiesOptions
): Promise<EntityMigrationResult> {
  const planOnly = !options.apply || options.dryRun === true

  // 1. Snapshot live facts in scope.
  const liveFacts = await facts.queryBySubject("", {
    projectId: options.projectId,
    // No limit — the migration is a one-shot, plan-then-apply pass and
    // needs the full graph to compute accurate alias coverage.

    // Vault-wide enumeration is the explicit point here; opt into the
    // `queryBySubject` empty-subject branch that the agent-facing
    // surface no longer reaches (issue #481).
    allowUnfiltered: true,
  })

  // 2. Snapshot existing entities so the plan distinguishes
  // create-vs-extend.
  const existingEntities = await entities.listAll()
  const existingByKey = indexEntitiesByKey(existingEntities)

  const plans = planEntityMigration(liveFacts, existingByKey)

  if (planOnly) {
    const wouldCreate = plans.filter((p) => p.existing === null).length
    const wouldAddAliases = plans
      .filter((p) => p.existing !== null)
      .reduce((n, p) => {
        const existingAliasKeys = new Set(
          p.existing!.aliases.map((a) => computeSubjectKey(a))
        )
        const nameKey = computeSubjectKey(p.existing!.name)
        const wouldAdd = [p.canonical, ...p.aliases].filter((a) => {
          const k = computeSubjectKey(a)
          return k !== "" && k !== nameKey && !existingAliasKeys.has(k)
        }).length
        return n + wouldAdd
      }, 0)

    // Estimate fact-repoint count: any fact whose Subject or Object
    // normalizes to a planned key AND whose corresponding entity
    // relation is currently empty.
    let wouldRepoint = 0
    const planKeys = new Set(plans.map((p) => p.key))
    for (const fact of liveFacts) {
      const sKey = computeSubjectKey(fact.subject)
      const oKey = computeSubjectKey(fact.object)
      const subjectNeeds = sKey && planKeys.has(sKey) && !fact.subjectEntityId
      const objectNeeds = oKey && planKeys.has(oKey) && !fact.objectEntityId
      if (subjectNeeds || objectNeeds) wouldRepoint += 1
    }

    return {
      plans,
      groupCount: plans.length,
      entitiesCreated: wouldCreate,
      aliasesAdded: wouldAddAliases,
      factsRepointed: wouldRepoint,
      errors: [],
      planOnly: true,
    }
  }

  // 3. Apply phase. Per-key error isolation: a transient Notion blip on
  // one entity create doesn't sink the whole migration, and a re-run
  // picks up where we left off because the indexer matches by key.
  const errors: Array<{
    factId?: string
    entityKey?: string
    message: string
  }> = []
  const entityByKey = new Map<string, Entity>(existingByKey)
  let entitiesCreated = 0
  let aliasesAdded = 0

  for (const plan of plans) {
    try {
      if (plan.existing) {
        const aliasesToAdd = [plan.canonical, ...plan.aliases].filter((a) => {
          const k = computeSubjectKey(a)
          if (!k) return false
          if (k === computeSubjectKey(plan.existing!.name)) return false
          return !plan.existing!.aliases.some(
            (existing) => computeSubjectKey(existing) === k
          )
        })
        if (aliasesToAdd.length > 0) {
          const updated = await entities.addAliases(plan.existing.id, aliasesToAdd)
          entityByKey.set(plan.key, updated)
          // Re-index aliases that were just added so subsequent groups
          // (rare — alias keys would also be plan keys here, but
          // defensive) see the same row.
          for (const alias of aliasesToAdd) {
            const aliasKey = computeSubjectKey(alias)
            if (aliasKey) entityByKey.set(aliasKey, updated)
          }
          aliasesAdded += aliasesToAdd.length
        } else {
          entityByKey.set(plan.key, plan.existing)
        }
      } else {
        const created = await entities.create({
          name: plan.canonical,
          aliases: plan.aliases,
        })
        entityByKey.set(plan.key, created)
        for (const alias of plan.aliases) {
          const aliasKey = computeSubjectKey(alias)
          if (aliasKey) entityByKey.set(aliasKey, created)
        }
        entitiesCreated += 1
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ entityKey: plan.key, message })
    }
  }

  // 4. Re-point fact relations. Per-fact try/catch so a single bad row
  // doesn't sink the rest.
  let factsRepointed = 0
  for (const fact of liveFacts) {
    const subjectKey = computeSubjectKey(fact.subject)
    const objectKey = computeSubjectKey(fact.object)
    const subjectEntity = subjectKey ? entityByKey.get(subjectKey) : null
    const objectEntity = objectKey ? entityByKey.get(objectKey) : null

    const updates: {
      subjectEntityId?: string | null
      objectEntityId?: string | null
    } = {}
    if (subjectEntity && fact.subjectEntityId !== subjectEntity.id) {
      updates.subjectEntityId = subjectEntity.id
    }
    if (objectEntity && fact.objectEntityId !== objectEntity.id) {
      updates.objectEntityId = objectEntity.id
    }
    if (
      updates.subjectEntityId === undefined &&
      updates.objectEntityId === undefined
    ) {
      continue
    }

    try {
      await facts.setEntityRelations(fact.id, updates)
      factsRepointed += 1
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ factId: fact.id, message })
    }
  }

  return {
    plans,
    groupCount: plans.length,
    entitiesCreated,
    aliasesAdded,
    factsRepointed,
    errors,
    planOnly: false,
  }
}

/**
 * PF3-01 orphan-rate metric (issue #542).
 *
 * The PF3-01 spec's flagship acceptance criterion is "post-migration,
 * the orphan-rate metric (`subjects appearing in exactly 1 fact`)
 * drops from 79.6% to <50% on an internal vault." The methodology lives
 * in `src/core/AGENTS.md` ("Measuring whether `--build-entities`
 * collapsed the orphan graph"); this report is the wired computation
 * site.
 *
 * @field orphanRate The metric itself: `1 - (groupsWithPeer / totalGroups)`.
 *   Zero when every subject has at least one peer fact (no orphans).
 *   One when every subject is uniquely referenced (fully orphaned).
 * @field totalGroups Distinct canonical entity / SubjectKey groups
 *   surfaced in scope.
 * @field groupsWithPeer Subset of `totalGroups` where the row count
 *   is ≥ 2.
 * @field totalFacts Sum of group counts. Equal to the number of live
 *   in-scope facts inspected.
 */
export interface OrphanRateReport {
  orphanRate: number
  totalGroups: number
  groupsWithPeer: number
  totalFacts: number
}

/**
 * Canonical metric key per the PF3-01 spec: prefer the populated
 * `SubjectEntity` relation id; fall back to `computeSubjectKey(subject)`
 * for rows the migration hasn't re-pointed yet. The empty key (no
 * entity AND `computeSubjectKey` produced empty) falls out — those
 * are degenerate punctuation-only / whitespace-only Subjects that
 * the migration also drops via `groupObservationsByKey`.
 *
 * Exported for tests and for cross-call-site consistency. The
 * RunTool aggregate path and the JS enumeration path MUST resolve
 * the same key for the same `(subjectEntityId, subject)` pair —
 * otherwise the two paths produce different orphan counts on the
 * same fact corpus.
 */
export function orphanMetricKey(
  subjectEntityId: string | null,
  subject: string,
): string {
  if (subjectEntityId) return `entity:${subjectEntityId}`
  const key = computeSubjectKey(subject)
  return key ? `key:${key}` : ""
}

/**
 * Fold a list of `(subjectEntityId, subject, count)` aggregate
 * rows into the PF3-01 orphan-rate report.
 *
 * Two pre-migration rows whose Subject text differs only in case
 * (`MemoryService` and `memoryservice`) arrive as two separate
 * input rows from the SQL aggregate — `GROUP BY` keys on the raw
 * Subject text, and SQLite's `LOWER()` cannot reproduce
 * `computeSubjectKey`'s NFC + whitespace-collapse + trailing-punct
 * pipeline. The fold collapses them onto the same canonical key,
 * matching the JS enumeration path's semantics.
 *
 * Empty / whitespace-only Subjects that produce no canonical key
 * AND have no `subjectEntityId` are dropped — they would otherwise
 * collapse onto the degenerate empty key, the same posture
 * `groupObservationsByKey` in the migration takes.
 *
 * Pure — no Notion calls.
 */
export function foldOrphanRateGroups(
  rows: ReadonlyArray<{
    subjectEntityId: string | null
    subject: string
    count: number
  }>,
): OrphanRateReport {
  const counts = new Map<string, number>()
  let totalFacts = 0
  for (const row of rows) {
    const key = orphanMetricKey(row.subjectEntityId, row.subject)
    if (!key) continue
    counts.set(key, (counts.get(key) ?? 0) + row.count)
    totalFacts += row.count
  }
  let groupsWithPeer = 0
  for (const value of counts.values()) {
    if (value >= 2) groupsWithPeer += 1
  }
  const totalGroups = counts.size
  const orphanRate = totalGroups === 0 ? 0 : 1 - groupsWithPeer / totalGroups
  return { orphanRate, totalGroups, groupsWithPeer, totalFacts }
}

/**
 * Compute the orphan rate from a `Fact[]` snapshot — the JS
 * enumeration path. Used as the canonical fallback when the
 * RunTool aggregate flag is off OR a per-call RunTool failure
 * routes through to REST.
 *
 * Each fact contributes ONE row to the underlying group counter,
 * matching the spec's "count rows by `SubjectEntity[0]?.id ??
 * computeSubjectKey(Subject)`" wording. Object-side relations are
 * NOT counted — the metric is subject-cardinality, not edge
 * cardinality.
 */
export function computeOrphanRateFromFacts(
  facts: ReadonlyArray<Fact>,
): OrphanRateReport {
  const rows = facts.map((fact) => ({
    subjectEntityId: fact.subjectEntityId ?? null,
    subject: fact.subject,
    count: 1,
  }))
  return foldOrphanRateGroups(rows)
}

/**
 * Compute the orphan rate from RunTool aggregate response rows —
 * the SQL pushdown path. The caller has already invoked
 * `querySubjectGroupCountsViaRunTool` and is folding its rows.
 *
 * `subjectEntityRaw` arrives as the raw SQL gateway value (a
 * JSON-stringified array of full URLs containing the undashed page
 * id form, or empty / null). `extractFirstRelationId` rehydrates
 * the canonical dashed id so the metric key matches what
 * `computeOrphanRateFromFacts` produces — both paths key entity-
 * present rows on `entity:<dashed-uuid>` and entity-absent rows on
 * `key:<computeSubjectKey(subject)>`. Equivalence is
 * fixture-pinned in `entity-migration.test.ts`.
 */
export function computeOrphanRateFromAggregateRows(
  rows: ReadonlyArray<SqlSubjectGroupCount>,
): OrphanRateReport {
  const folded = rows.map((row) => ({
    subjectEntityId: extractFirstRelationId(row.subjectEntityRaw),
    subject: row.subject ?? "",
    count: row.count,
  }))
  return foldOrphanRateGroups(folded)
}
