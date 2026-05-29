/**
 * Notion database property schemas for Lore's five databases.
 *
 * These definitions are used by setup.ts to create databases and by
 * core operations to read/write property values.
 */

import type { CreatePageParameters } from "@notionhq/client"
import {
  factPredicateSchemaOptions,
  profilePropertyAdditions,
  type ResolvedProfile,
  type ResolvedProfileSchema,
} from "../profile/index.js"

// ---------------------------------------------------------------------------
// Shared types for convenience
// ---------------------------------------------------------------------------

type PageProperties = CreatePageParameters["properties"]

/**
 * Property configuration for database creation.
 * Uses the new initial_data_source.properties shape.
 */
export type PropertyConfig = Record<string, Record<string, unknown>>

type ProfileArg = ResolvedProfile | ResolvedProfileSchema | undefined

function withProfileAdditions(
  key: Parameters<typeof profilePropertyAdditions>[1],
  core: PropertyConfig,
  profile: ProfileArg
): PropertyConfig {
  return { ...core, ...profilePropertyAdditions(profile, key) }
}

function taxonomyOptions(
  values: readonly string[],
  color: string = "default"
): Array<{ name: string; color: string }> {
  return values.map((name) => ({ name, color }))
}

// ---------------------------------------------------------------------------
// Projects Database
// ---------------------------------------------------------------------------

export const PROJECTS_DB_TITLE = "Projects"
export const PROJECTS_DB_ICON = "🗂️"

/**
 * Notion property names for the Projects DB. The single source of truth for
 * every read and write on this database. Renaming Notion properties
 * is forbidden; centralizing the names here turns that social rule
 * into a compile-time invariant — a future rename touches one
 * declaration and TypeScript surfaces every drifted call site.
 */
export const PROJECT_PROPS = {
  NAME: "Name",
  TYPE: "Type",
  PATH: "Path",
  STATUS: "Status",
  DESCRIPTION: "Description",
} as const

export function projectsProperties(profile?: ProfileArg): PropertyConfig {
  return withProfileAdditions(
    "projects",
    {
      [PROJECT_PROPS.NAME]: { title: {} },
      [PROJECT_PROPS.TYPE]: {
        select: {
          options: [
            { name: "project", color: "blue" },
            { name: "person", color: "green" },
            { name: "agent", color: "purple" },
          ],
        },
      },
      [PROJECT_PROPS.PATH]: { rich_text: {} },
      [PROJECT_PROPS.STATUS]: {
        select: {
          options: [
            { name: "active", color: "green" },
            { name: "archived", color: "gray" },
          ],
        },
      },
      [PROJECT_PROPS.DESCRIPTION]: { rich_text: {} },
    },
    profile
  )
}

// ---------------------------------------------------------------------------
// Topics Database
// ---------------------------------------------------------------------------

export const TOPICS_DB_TITLE = "Topics"
export const TOPICS_DB_ICON = "📑"

/** Notion property names for the Topics DB. See `PROJECT_PROPS` doc. */
export const TOPIC_PROPS = {
  NAME: "Name",
  PROJECT: "Project",
  DESCRIPTION: "Description",
} as const

export function topicsProperties(
  projectsDbId: string,
  profile?: ProfileArg
): PropertyConfig {
  return withProfileAdditions(
    "topics",
    {
      [TOPIC_PROPS.NAME]: { title: {} },
      [TOPIC_PROPS.PROJECT]: {
        relation: {
          // Many-to-many: a topic can span multiple projects so cross-cutting
          // concerns (e.g. "GraphQL federation" in a monorepo) accumulate one
          // topic rather than fragmenting into per-project duplicates.
          dual_property: {},
          data_source_id: projectsDbId,
        },
      },
      [TOPIC_PROPS.DESCRIPTION]: { rich_text: {} },
    },
    profile
  )
}

// ---------------------------------------------------------------------------
// Memories Database
// ---------------------------------------------------------------------------

export const MEMORIES_DB_TITLE = "Memories"
export const MEMORIES_DB_ICON = "🧠"

/** Notion property names for the Memories DB. See `PROJECT_PROPS` doc. */
export const MEMORY_PROPS = {
  TITLE: "Title",
  PROJECT: "Project",
  TOPIC: "Topic",
  SOURCE: "Source",
  KIND: "Kind",
  TASK_STATE: "Task State",
  BLOCKED_BY: "Blocked By",
  ENTITY: "Entity",
  STATUS: "Status",
  CONFIDENCE: "Confidence",
  CONFIDENCE_SCORE: "Confidence Score",
  TOPIC_KEY: "Topic Key",
  REVISION_COUNT: "Revision Count",
  COMPARE_NOTES: "Compare Notes",
  PROMOTION_SOURCE_KEY: "Promotion Source Key",
  REVIEW_BY: "Review By",
  DONE_AT: "Done At",
  DECIDED_AT: "Decided At",
  LAST_REFERENCED_AT: "Last Referenced At",
  ALTERNATIVES: "Alternatives",
  CONSEQUENCES: "Consequences",
  AUTHOR: "Author",
  AGENT: "Agent",
  TAGS: "Tags",
  KEYWORDS: "Keywords",
  SYNOPSIS: "Synopsis",
  EXPIRES_ON: "Expires On",
  SESSION: "Session",
  SUPERSEDES: "Supersedes",
  AFFECTS: "Affects",
  COMPARED_WITH: "Compared With",
  // Scope / lifetime. Five columns added together so a
  // schema-drift caller sees the whole feature land or none of it.
  // `Scope Kind` and `Lifetime` are select columns whose options match
  // the `MEMORY_SCOPE_KINDS` / `MEMORY_LIFETIMES` enums. `Scope Key`
  // and `Audience` are free-form rich_text
  // (scope keys are session ids, agent canonical names, role labels —
  // a closed select would force a schema migration on every new
  // session). `Expires At` is a Notion `date` so the retrieval filter
  // can use `on_or_after` semantics without parsing.
  SCOPE_KIND: "Scope Kind",
  SCOPE_KEY: "Scope Key",
  AUDIENCE: "Audience",
  LIFETIME: "Lifetime",
  EXPIRES_AT: "Expires At",
  // Pinned context blocks. Three columns added together
  // so a schema-drift caller sees the whole feature land or none of
  // it — same posture as the scope/lifetime cluster above.
  // `Pinned` discriminates pinned blocks from normal memories;
  // `Pinned Priority` orders them in the wake-up Pinned Context
  // section (higher first); `Mutability` enforces the read-only
  // contract. Audience targeting reuses the existing
  // `Audience` rich_text column — pinned blocks ride
  // atop the same audience plumbing rather than duplicating it.
  PINNED: "Pinned",
  PINNED_PRIORITY: "Pinned Priority",
  MUTABILITY: "Mutability",
} as const

/**
 * Build Memories DB property config.
 *
 * `memoriesDsId` is optional: during initial database creation, self-relations
 * cannot reference a data source that doesn't exist yet, so the Memories DB is
 * first created without `Supersedes`/`Affects`, then patched post-creation with
 * those properties. During schema migration the DS ID is always available.
 */
export function memoriesProperties(
  projectsDbId: string,
  topicsDbId: string,
  memoriesDsId?: string,
  profile?: ProfileArg
): PropertyConfig {
  const base: PropertyConfig = {
    [MEMORY_PROPS.TITLE]: { title: {} },
    [MEMORY_PROPS.PROJECT]: {
      relation: {
        single_property: {},
        data_source_id: projectsDbId,
      },
    },
    [MEMORY_PROPS.TOPIC]: {
      relation: {
        single_property: {},
        data_source_id: topicsDbId,
      },
    },
    [MEMORY_PROPS.SOURCE]: {
      select: {
        options: [
          { name: "conversation", color: "blue" },
          { name: "autosave_learning", color: "pink" },
          { name: "file", color: "yellow" },
          { name: "manual", color: "green" },
          { name: "agent_diary", color: "purple" },
          { name: "digest", color: "brown" },
        ],
      },
    },
    [MEMORY_PROPS.KIND]: {
      select: {
        options: [
          { name: "note", color: "default" },
          { name: "decision", color: "blue" },
          { name: "incident", color: "red" },
          { name: "runbook", color: "green" },
          { name: "postmortem", color: "orange" },
          { name: "policy", color: "purple" },
          { name: "state", color: "gray" },
          { name: "operational", color: "gray" },
          { name: "task", color: "yellow" },
          { name: "procedure", color: "pink" },
        ],
      },
    },
    [MEMORY_PROPS.TASK_STATE]: {
      select: {
        options: [
          { name: "open", color: "yellow" },
          { name: "in-progress", color: "blue" },
          { name: "blocked", color: "red" },
          { name: "done", color: "green" },
          { name: "cancelled", color: "gray" },
        ],
      },
    },
    [MEMORY_PROPS.BLOCKED_BY]: { rich_text: {} },
    [MEMORY_PROPS.ENTITY]: { rich_text: {} },
    [MEMORY_PROPS.STATUS]: {
      select: {
        options: [
          { name: "informational", color: "default" },
          { name: "proposed", color: "yellow" },
          { name: "accepted", color: "green" },
          { name: "superseded", color: "gray" },
          { name: "deprecated", color: "brown" },
          { name: "rejected", color: "red" },
        ],
      },
    },
    // Retained for schema compatibility with existing vaults. Memory write and
    // read paths do not use this column.
    [MEMORY_PROPS.CONFIDENCE]: {
      select: {
        options: [
          { name: "certain", color: "green" },
          { name: "likely", color: "yellow" },
          { name: "speculative", color: "orange" },
        ],
      },
    },
    // Retained for schema compatibility with existing vaults. Memory write and
    // read paths do not use this column.
    [MEMORY_PROPS.CONFIDENCE_SCORE]: { number: { format: "number" } },
    // 0.9.0+ scalar cluster between `Confidence Score` and `Review By`:
    //   Confidence Score → Topic Key → Revision Count → Compare Notes →
    //   Promotion Source Key → Review By
    // `Topic Key` and `Revision Count` are part of the Topic-key
    // upsert workstream. `Compare Notes` lands after them. Tests pin
    // `Compare Notes` precedes `Review By` (loose) rather than
    // "immediately before" (rigid) so a future scalar addition between
    // the two columns doesn't force a test churn.
    //
    // Stable identifier for upsert grouping. Distinct from the `Topic`
    // relation column above (which links to the Topics DB for faceted
    // browsing) — `Topic Key` is *operationally* a per-row identifier
    // used by `lore-memory action='save'` to dispatch between
    // fresh-create and append-revision. Format constraint is
    // kebab-case path like `decision/jwt-auth`, enforced at the save-
    // path validation; stored verbatim. Empty string and missing
    // both mean "no upsert grouping" (the 0.8.x save behavior).
    [MEMORY_PROPS.TOPIC_KEY]: { rich_text: {} },
    // System-managed counter tracking how many times the memory has
    // been touched via the topic-key upsert path. Default for new rows
    // is 1 (the create itself counts as revision 1). Rows from before
    // the revision-counter column have a null `Revision Count` —
    // `extractNumber` returns null, which `pageToMemory` coalesces to
    // 1 so `formatMemoryListItem` treats legacy rows as single-revision.
    [MEMORY_PROPS.REVISION_COUNT]: { number: { format: "number" } },
    // Append-only NDJSON audit trail for `lore-memory action='compare'`.
    // One JSON line per verdict — `{"verdict": ..., "target": ...,
    // "reason": ..., "judgedAt": ..., "promptVersion": ...}`. Capped
    // via `COMPARE_NOTES_MAX_CHARS`; append-past-cap throws so
    // over-compared rows surface to the operator instead of silently
    // truncating. Empty for legacy rows and for memories that have
    // never been compared.
    [MEMORY_PROPS.COMPARE_NOTES]: { rich_text: {} },
    // System-managed idempotency key for deliberate cross-vault promotion.
    // Populated only by `promoteMemory` on target-vault rows, and probed
    // before create to make retries reuse the original promoted row.
    [MEMORY_PROPS.PROMOTION_SOURCE_KEY]: { rich_text: {} },
    [MEMORY_PROPS.REVIEW_BY]: { date: {} },
    // Most recent close timestamp for tasks. Stamped whenever a task
    // transitions to a terminal state — either via `TaskService.close()`
    // or via `TaskService.update({ state: 'done' | 'cancelled' })` —
    // in the same `pages.update` atom as the state write. Preserved
    // across `update({ state: 'open' })` re-opens as historical fact;
    // null on non-task memories and on tasks that have never reached a
    // terminal state. Read by `lore status` for closure-rate metrics.
    [MEMORY_PROPS.DONE_AT]: { date: {} },
    [MEMORY_PROPS.DECIDED_AT]: { date: {} },
    // System-managed read-citation timestamp; distinct from
    // `last_edited_time` which tracks writes. Written by
    // `MemoryService.touchOnRead` for citation-recency surfaces.
    [MEMORY_PROPS.LAST_REFERENCED_AT]: { date: {} },
    [MEMORY_PROPS.ALTERNATIVES]: { rich_text: {} },
    [MEMORY_PROPS.CONSEQUENCES]: { rich_text: {} },
    [MEMORY_PROPS.AUTHOR]: { rich_text: {} },
    [MEMORY_PROPS.AGENT]: { rich_text: {} },
    [MEMORY_PROPS.TAGS]: {
      multi_select: {
        options:
          profile && "taxonomy" in profile ? taxonomyOptions(profile.taxonomy.tags) : [],
      },
    },
    // Free-form companion to Tags: PR numbers, ticket IDs, file paths, class
    // or function names — anything too point-in-time to belong in the closed
    // tag vocabulary. Indexed by Notion's text search.
    [MEMORY_PROPS.KEYWORDS]: { rich_text: {} },
    // Free-form 1–2 sentence synopsis surfaced inline on title-tier
    // rendering (recall, search, wake-up). Lives in page properties so
    // listings return synopses without a per-row retrieveMarkdown call.
    // Soft-capped at 500 chars at the MCP boundary; Notion rich_text
    // caps at 2000 per block which is the hard ceiling.
    [MEMORY_PROPS.SYNOPSIS]: { rich_text: {} },
    // Optional event-bound expiry marker for operational rows. Date-based
    // hiding stays on `Expires At`; this marker lets debt scan report rows
    // whose linked closure event has happened before a date expiry was applied.
    [MEMORY_PROPS.EXPIRES_ON]: { rich_text: {} },
    [MEMORY_PROPS.SESSION]: { rich_text: {} },
    // Scope / lifetime. Select option lists must stay in
    // lockstep with the canonical `MEMORY_SCOPE_KINDS` / `MEMORY_LIFETIMES`
    // enums — the schema-drift test pins the enum-to-options
    // mapping. Adding a new value requires updating both files in the
    // same change so an option missing from Notion doesn't surface as
    // a `validation_error` on first write.
    [MEMORY_PROPS.SCOPE_KIND]: {
      select: {
        options: [
          { name: "team", color: "blue" },
          { name: "project", color: "green" },
          { name: "user", color: "yellow" },
          { name: "agent", color: "purple" },
          { name: "role", color: "orange" },
          { name: "session", color: "pink" },
          { name: "run", color: "red" },
          { name: "environment", color: "brown" },
          { name: "global", color: "gray" },
        ],
      },
    },
    [MEMORY_PROPS.SCOPE_KEY]: { rich_text: {} },
    [MEMORY_PROPS.AUDIENCE]: { rich_text: {} },
    [MEMORY_PROPS.LIFETIME]: {
      select: {
        options: [
          { name: "persistent", color: "default" },
          { name: "expires", color: "yellow" },
          { name: "session-only", color: "pink" },
          { name: "until-task-closed", color: "orange" },
          { name: "until-decision-superseded", color: "blue" },
        ],
      },
    },
    [MEMORY_PROPS.EXPIRES_AT]: { date: {} },
    // Pinned context blocks. Three columns land in
    // lockstep with the schema-drift contract `migrateVaultSchema`
    // enforces. `Pinned` is a plain checkbox (cheap server-side
    // filter for `listPinnedBlocks`). `Pinned Priority` is an
    // unconstrained `number`; the service-layer write boundary
    // clamps to `[PINNED_PRIORITY_MIN, PINNED_PRIORITY_MAX]` so a
    // malformed caller can't blow Notion's display formatting.
    // `Mutability` select options must stay in lockstep with the
    // `MEMORY_MUTABILITIES` enum — the schema-drift test pins the
    // enum-to-options mapping. A new value requires updating both
    // declarations in the same change so an option missing from
    // Notion doesn't surface as a `validation_error` on first write.
    [MEMORY_PROPS.PINNED]: { checkbox: {} },
    [MEMORY_PROPS.PINNED_PRIORITY]: { number: { format: "number" } },
    [MEMORY_PROPS.MUTABILITY]: {
      select: {
        options: [
          { name: "mutable", color: "default" },
          { name: "read-only", color: "red" },
        ],
      },
    },
  }

  if (memoriesDsId) {
    base[MEMORY_PROPS.SUPERSEDES] = {
      relation: {
        single_property: {},
        data_source_id: memoriesDsId,
      },
    }
    base[MEMORY_PROPS.AFFECTS] = {
      relation: {
        single_property: {},
        data_source_id: memoriesDsId,
      },
    }
    base[MEMORY_PROPS.COMPARED_WITH] = {
      relation: {
        single_property: {},
        data_source_id: memoriesDsId,
      },
    }
  }

  return withProfileAdditions("memories", base, profile)
}

/**
 * Self-relation properties for the Memories DB. Used by `createVaultDatabases`
 * to patch `Supersedes` and `Affects` in as a second step once the database
 * (and its data source ID) exists.
 */
export function memoriesSelfRelationProperties(memoriesDsId: string): PropertyConfig {
  return {
    [MEMORY_PROPS.SUPERSEDES]: {
      relation: {
        single_property: {},
        data_source_id: memoriesDsId,
      },
    },
    [MEMORY_PROPS.AFFECTS]: {
      relation: {
        single_property: {},
        data_source_id: memoriesDsId,
      },
    },
    // Pairs a memory with every other memory it has been judged against
    // by `lore-memory action='compare'`. `single_property` (not
    // `dual_property`) matches the existing self-relations — the
    // calling code takes responsibility for symmetric writes (when
    // memory A names B, the helper issues a parallel update so B
    // names A). Set membership encodes "have these two been judged?"
    // and the `lore conflicts scan` candidate filter consults it to
    // skip already-judged pairs.
    [MEMORY_PROPS.COMPARED_WITH]: {
      relation: {
        single_property: {},
        data_source_id: memoriesDsId,
      },
    },
  }
}

// ---------------------------------------------------------------------------
// Entities Database (PF3-01 — canonical entity registry)
// ---------------------------------------------------------------------------

export const ENTITIES_DB_TITLE = "Entities"
export const ENTITIES_DB_ICON = "🪪"

/** Notion property names for the Entities DB. See `PROJECT_PROPS` doc. */
export const ENTITY_PROPS = {
  NAME: "Name",
  ALIASES: "Aliases",
  KIND: "Kind",
  DESCRIPTION: "Description",
  PROJECT: "Project",
  SOURCE: "Source",
} as const

/**
 * `Aliases` is a single rich_text cell holding a comma-separated list
 * rather than a `multi_select`. Multi-select option lists require a
 * schema migration whenever a new alias appears, but aliases are
 * deeply free-form (case variants, "MemoryService.create" alongside
 * "MemoryService", legacy spellings) — every new fact would force a
 * `dataSources.update` round-trip.
 *
 * `Kind` defaults to a small open vocabulary mirroring `EntityKind`.
 * The migration leaves it blank when it can't infer a kind, so reads
 * MUST treat the column as optional.
 */
export function entitiesProperties(
  projectsDbId: string,
  memoriesDbId: string,
  profile?: ProfileArg
): PropertyConfig {
  return withProfileAdditions(
    "entities",
    {
      [ENTITY_PROPS.NAME]: { title: {} },
      [ENTITY_PROPS.ALIASES]: { rich_text: {} },
      [ENTITY_PROPS.KIND]: {
        select: {
          options:
            profile && "taxonomy" in profile
              ? taxonomyOptions(profile.taxonomy.entityKinds)
              : [
                  { name: "class", color: "blue" },
                  { name: "function", color: "green" },
                  { name: "file", color: "yellow" },
                  { name: "workflow", color: "purple" },
                  { name: "pr", color: "orange" },
                  { name: "task-id", color: "red" },
                  { name: "person", color: "pink" },
                  { name: "system", color: "gray" },
                ],
        },
      },
      [ENTITY_PROPS.DESCRIPTION]: { rich_text: {} },
      [ENTITY_PROPS.PROJECT]: {
        relation: {
          // Many-to-many: a class or workflow may span the same set of
          // projects its referencing facts span (e.g. "AuthMiddleware"
          // touches every project that imports it). Mirroring Topics'
          // dual-property keeps cross-project entities reachable from
          // either side without fragmenting the graph.
          dual_property: {},
          data_source_id: projectsDbId,
        },
      },
      /**
       * Memory rows that defined or first introduced this entity. Optional
       * — the migration leaves it empty because the source memory for
       * pre-PF3-01 rows lives on the Fact's Source relation. Used by future
       * tools that want to surface "where did this entity first appear"
       * without walking every fact.
       */
      [ENTITY_PROPS.SOURCE]: {
        relation: {
          single_property: {},
          data_source_id: memoriesDbId,
        },
      },
    },
    profile
  )
}

// ---------------------------------------------------------------------------
// Facts Database (Knowledge Graph)
// ---------------------------------------------------------------------------

export const FACTS_DB_TITLE = "Facts"
export const FACTS_DB_ICON = "🔗"

/** Notion property names for the Facts DB. See `PROJECT_PROPS` doc. */
export const FACT_PROPS = {
  SUBJECT: "Subject",
  PREDICATE: "Predicate",
  OBJECT: "Object",
  PROJECT: "Project",
  SOURCE: "Source",
  CONFIDENCE: "Confidence",
  CONFIDENCE_SCORE: "Confidence Score",
  VALID_FROM: "Valid From",
  VALID_UNTIL: "Valid Until",
  // Transaction-time provenance. `Valid From` / `Valid Until`
  // model domain truth (when the fact was true in the world); `Observed At`
  // and `Invalidated At` model what Lore knew and when. Together they
  // implement the bitemporal axis used for as-of recall.
  // `Observed At` is written by `FactService.create` at write time;
  // `Invalidated At` is written by `FactService.invalidate` alongside the
  // existing `Valid Until` flip so a single atomic update carries both
  // signals. `Invalidated By` points at the source memory that prompted
  // the invalidation — distinct from `Source` (the supporting memory at
  // creation time).
  OBSERVED_AT: "Observed At",
  INVALIDATED_AT: "Invalidated At",
  INVALIDATED_BY: "Invalidated By",
  REVIEW_BY: "Review By",
  LAST_REFERENCED_AT: "Last Referenced At",
  DEDUP_KEY: "DedupKey",
  SUBJECT_KEY: "SubjectKey",
  SUBJECT_ENTITY: "SubjectEntity",
  OBJECT_ENTITY: "ObjectEntity",
  // Scope / lifetime. Mirrors the Memories DB columns so
  // facts about a session-scoped piece of work can carry the same
  // identity slot — `lore-fact action='create'` accepts a scope bundle
  // that matches the source memory's scope.
  SCOPE_KIND: "Scope Kind",
  SCOPE_KEY: "Scope Key",
  AUDIENCE: "Audience",
  LIFETIME: "Lifetime",
  EXPIRES_AT: "Expires At",
} as const

/**
 * Build the Facts DB property config. The Entities DB is part of the
 * supported vault shape, so the canonical relation columns are always in
 * the expected schema even while individual Fact rows are still
 * unbackfilled.
 */
export function factsProperties(
  projectsDbId: string,
  memoriesDbId: string,
  entitiesDsId: string,
  profile?: ProfileArg
): PropertyConfig {
  return withProfileAdditions(
    "facts",
    {
      [FACT_PROPS.SUBJECT]: { title: {} },
      [FACT_PROPS.PREDICATE]: {
        select: {
          options:
            profile && "taxonomy" in profile
              ? taxonomyOptions(factPredicateSchemaOptions(profile))
              : [
                  { name: "is_a", color: "blue" },
                  { name: "has_a", color: "green" },
                  { name: "uses", color: "yellow" },
                  { name: "depends_on", color: "orange" },
                  { name: "related_to", color: "pink" },
                  { name: "created_by", color: "purple" },
                  { name: "owned_by", color: "red" },
                  { name: "replaces", color: "gray" },
                  { name: "extends", color: "brown" },
                  { name: "conflicts_with", color: "red" },
                  { name: "needs_action", color: "red" },
                  { name: "waiting_on", color: "orange" },
                  { name: "blocked_by", color: "red" },
                  // Decision-graph predicates. Created exclusively by
                  // DecisionService / `lore-decision action='create'` — not
                  // exposed through `lore-fact action='create'`.
                  { name: "decided_by", color: "blue" },
                  { name: "supersedes_decision", color: "gray" },
                  { name: "informs", color: "pink" },
                  // Auto-emitted by `lore-memory action='save'`.
                  // System-managed, regex-derived; not exposed through
                  // `lore-fact action='create'`. Distinguished from the
                  // agent-curated relationship predicates (uses / depends_on /
                  // is_a / etc.) so retrieval can prefer the higher-quality
                  // explicit edges when both exist.
                  { name: "mentions", color: "gray" },
                ],
        },
      },
      [FACT_PROPS.OBJECT]: { rich_text: {} },
      [FACT_PROPS.PROJECT]: {
        relation: {
          single_property: {},
          data_source_id: projectsDbId,
        },
      },
      [FACT_PROPS.VALID_FROM]: { date: {} },
      [FACT_PROPS.VALID_UNTIL]: { date: {} },
      // Transaction-time provenance columns. System-managed at
      // write boundaries (`FactService.create` seeds `Observed At` from `today`;
      // `FactService.invalidate` writes `Invalidated At` alongside the
      // `Valid Until` flip). Read paths can use these for as-of recall
      // (`lore-query action='ask'` with `asOf` / `includeHistory`).
      [FACT_PROPS.OBSERVED_AT]: { date: {} },
      [FACT_PROPS.INVALIDATED_AT]: { date: {} },
      [FACT_PROPS.INVALIDATED_BY]: {
        relation: {
          single_property: {},
          data_source_id: memoriesDbId,
        },
      },
      [FACT_PROPS.REVIEW_BY]: { date: {} },
      [FACT_PROPS.SOURCE]: {
        relation: {
          single_property: {},
          data_source_id: memoriesDbId,
        },
      },
      [FACT_PROPS.CONFIDENCE]: {
        select: {
          options: [
            { name: "certain", color: "green" },
            { name: "likely", color: "yellow" },
            { name: "speculative", color: "orange" },
          ],
        },
      },
      // System-managed numeric fact confidence in [0, 1]. Distinct from the
      // categorical `Confidence` select above (agent-curated semantic stance).
      // Bumped on read-citation via `FactService.touchOnRead`; decremented
      // inside `FactService.invalidate` alongside the `Valid Until` flip so the
      // same atomic write closes the contradiction signal. Empty until first
      // touch — `pageToFact` returns `null` when missing so `lore-ask`
      // distinguishes "never scored" from "scored zero."
      [FACT_PROPS.CONFIDENCE_SCORE]: { number: { format: "number" } },
      // System-managed read-citation timestamp; distinct from
      // `last_edited_time` which tracks writes. Written by
      // `FactService.touchOnRead` and `FactService.invalidate` (via
      // `decrementConfidence`), read by the decay function.
      [FACT_PROPS.LAST_REFERENCED_AT]: { date: {} },
      // Normalized `subject␟predicate␟object` key used by `FactService.create`
      // to coalesce cosmetic duplicates (case, whitespace, trailing punctuation)
      // into a single row. Pre-migration pages have this blank; the migrate
      // command backfills it.
      [FACT_PROPS.DEDUP_KEY]: { rich_text: {} },
      // Lowercased + whitespace-collapsed form of `Subject`, used by
      // `FactService.queryBySubject` for case-insensitive matching.
      // Pre-migration rows have this blank; `lore migrate --dedup-keys`
      // backfills it. Distinct from `DedupKey` (a hash) because we need
      // `contains` substring matching, which Notion doesn't run against
      // hashed values.
      [FACT_PROPS.SUBJECT_KEY]: { rich_text: {} },
      // Canonical entity relation columns. Filled by the build-entities
      // migration and by `lore-fact action='create'` after the resolver
      // picks an Entity row. Unbackfilled rows have empty relations; queries
      // that filter by entity ID fall back to the SubjectKey path on those
      // rows.
      [FACT_PROPS.SUBJECT_ENTITY]: {
        relation: {
          single_property: {},
          data_source_id: entitiesDsId,
        },
      },
      [FACT_PROPS.OBJECT_ENTITY]: {
        relation: {
          single_property: {},
          data_source_id: entitiesDsId,
        },
      },
      // Scope / lifetime. Select option lists mirror the
      // Memories DB columns one-for-one — a scope expansion in
      // `MEMORY_SCOPE_KINDS` / `MEMORY_LIFETIMES` flows to both DBs by
      // updating both schema builders in lockstep. The schema-drift test
      // pins the option set against the enums.
      [FACT_PROPS.SCOPE_KIND]: {
        select: {
          options: [
            { name: "team", color: "blue" },
            { name: "project", color: "green" },
            { name: "user", color: "yellow" },
            { name: "agent", color: "purple" },
            { name: "role", color: "orange" },
            { name: "session", color: "pink" },
            { name: "run", color: "red" },
            { name: "environment", color: "brown" },
            { name: "global", color: "gray" },
          ],
        },
      },
      [FACT_PROPS.SCOPE_KEY]: { rich_text: {} },
      [FACT_PROPS.AUDIENCE]: { rich_text: {} },
      [FACT_PROPS.LIFETIME]: {
        select: {
          options: [
            { name: "persistent", color: "default" },
            { name: "expires", color: "yellow" },
            { name: "session-only", color: "pink" },
            { name: "until-task-closed", color: "orange" },
            { name: "until-decision-superseded", color: "blue" },
          ],
        },
      },
      [FACT_PROPS.EXPIRES_AT]: { date: {} },
    },
    profile
  )
}

// ---------------------------------------------------------------------------
// Compare Notes encoder + cap
// ---------------------------------------------------------------------------
//
// Notion-shape concerns live next to the property builders that consume
// them. The pure-NDJSON helpers (`appendCompareNote`, `CompareNoteEntry`)
// live alongside `MemoryService` because they have no Notion dependency,
// and re-export `COMPARE_NOTES_MAX_CHARS` and `encodeCompareNotesRichText`
// from there so the compare-write path has a single import surface for
// the entire compare-notes helper family.
//
// The cap lives here (alongside the property builder) so the encoder is
// the single chokepoint that enforces it. Both `appendCompareNote`
// (upstream validation on every append) AND any direct caller of
// `encodeCompareNotesRichText` (including `buildMemoryProps`) hit the
// same threshold — there is no path that produces an over-cap rich_text
// payload.

/**
 * Total serialized-NDJSON length cap for a single memory's `Compare Notes`
 * cell. Notion's rich_text columns hold ~20KB across multiple sub-blocks
 * but the exact total-cell ceiling is not a stable contract across SDK
 * versions, so the property's contract caps total length explicitly. At
 * ~150 chars per NDJSON entry, an 8000-char cap fits ~50 verdicts per
 * memory — well above any realistic comparison count for one row.
 *
 * Append-past-cap throws via `appendCompareNote`; encode-past-cap throws
 * via `encodeCompareNotesRichText`. Both throw rather than truncating so
 * over-compared memories surface to the operator as an explicit error
 * instead of silently corrupting the audit trail.
 */
export const COMPARE_NOTES_MAX_CHARS = 8000

/**
 * Per-block char budget when chunking the NDJSON string into Notion
 * `text` sub-blocks. Notion's hard limit is 2000 chars per block; the
 * 1900 budget leaves a 100-char defensive margin for any SDK-side
 * framing or BOM-style additions.
 */
const COMPARE_NOTES_CHUNK_CHARS = 1900

/** NDJSON entry separator — the only literal "\n" in a `Compare Notes`
 *  string. `JSON.stringify` always escapes embedded newlines inside
 *  values, so splitting on this constant is the natural per-entry
 *  boundary AND guarantees code-unit safety (a "\n" can never fall
 *  between the two halves of a UTF-16 surrogate pair).
 */
const NDJSON_LINE_SEPARATOR = "\n"

/**
 * One Notion `rich_text` sub-block carrying a plain-text payload. The
 * `@notionhq/client` package does not re-export the SDK-internal
 * `RichTextItemRequest` from its public surface in this codebase, so we
 * declare the narrow text-only variant inline. The shape matches what
 * other rich_text writes in `buildMemoryProps` consume verbatim, so a
 * Notion `pages.update` accepts the encoded array as the cell value.
 */
export interface CompareNotesTextChunk {
  type: "text"
  text: { content: string }
}

/**
 * Slice an NDJSON string into Notion `rich_text` sub-blocks, each
 * holding at most `COMPARE_NOTES_CHUNK_CHARS` (1900) characters. The
 * 1900 budget stays safely under Notion's per-block 2000-char limit
 * while leaving a defensive margin. Empty input → empty array (Notion
 * accepts an empty rich_text array as "clear cell"). The
 * `buildMemoryProps` `compareNotes` branch routes through this helper
 * so any caller passing a string up to `COMPARE_NOTES_MAX_CHARS`
 * produces a Notion-valid payload — the simple-write path
 * `[{ text: { content: notes } }]` would fail on Notion's per-block
 * 2000-char ceiling for any audit trail past ~13 entries.
 *
 * **Enforces `COMPARE_NOTES_MAX_CHARS` at the chokepoint.** Every
 * write path lands here — `buildMemoryProps({ compareNotes })`,
 * direct callers in the compare-write helper, anything else that
 * needs the chunked rich_text shape. Throwing on over-cap input here
 * means `appendCompareNote`'s 8000-char overflow check is not the
 * only line of defense; a future caller that builds an audit
 * trail outside `appendCompareNote` (e.g. a one-shot migration that
 * synthesizes a Compare Notes string from external data) is held to
 * the same cap.
 *
 * **Chunks on NDJSON line boundaries.** Splitting the input on the
 * `"\n"` separator that delimits NDJSON entries gives two
 * load-bearing benefits over a naive fixed-stride char-slice:
 *
 * 1. **UTF-16 surrogate pairs survive intact.** `JSON.stringify`
 *    never inserts a literal `"\n"` between the high and low
 *    halves of an astral codepoint (emoji, extended CJK,
 *    mathematical alphanumerics) inside a `reason` field, so
 *    splitting on `"\n"` cannot orphan a surrogate. A fixed-stride
 *    slice landing exactly on a surrogate pair would emit two
 *    sub-blocks each holding a lone surrogate — which Notion may
 *    normalize to U+FFFD or reject server-side, silently
 *    corrupting the audit trail.
 * 2. **Per-block atomicity for Notion-side full-text search.**
 *    Each emitted sub-block is a complete NDJSON fragment (one or
 *    more whole entries), so Notion's search index ranks per
 *    entry rather than against fragments split across an
 *    arbitrary character boundary.
 *
 * The fallback for a single NDJSON entry that exceeds the chunk
 * budget (rare in practice — `appendCompareNote`'s 8000-char total
 * cap puts hard limits on aggregate growth, and a single entry
 * would have to be near-pathologically large to overshoot 1900
 * chars) char-slices with a surrogate-pair-safe backoff: if the
 * chunk would end on a high surrogate (`U+D800..U+DBFF`), back off
 * one position so the pair stays intact at the start of the next
 * chunk.
 */
export function encodeCompareNotesRichText(notes: string): CompareNotesTextChunk[] {
  if (notes.length > COMPARE_NOTES_MAX_CHARS) {
    throw new Error(
      `Compare Notes overflow: input is ${notes.length} chars, exceeds cap ` +
        `${COMPARE_NOTES_MAX_CHARS}. Use \`appendCompareNote\` to grow the ` +
        `audit trail incrementally with overflow protection, or consolidate ` +
        `via lore-memory action='archive' on duplicate pairs before writing.`
    )
  }
  if (notes.length === 0) return []

  const lines = notes.split(NDJSON_LINE_SEPARATOR)
  const chunks: CompareNotesTextChunk[] = []
  let currentChunk = ""

  for (let i = 0; i < lines.length; i++) {
    // Each fragment carries the leading separator (when not the first
    // line) so the chunk-spanning `extractRichText` concatenation
    // reconstructs the original "\n"-delimited string verbatim —
    // `extractRichText` joins sub-blocks without inserting any
    // separator between them.
    const fragment = i === 0 ? lines[i] : NDJSON_LINE_SEPARATOR + lines[i]

    if (currentChunk.length + fragment.length <= COMPARE_NOTES_CHUNK_CHARS) {
      currentChunk += fragment
      continue
    }

    // Adding this entry would overflow the current chunk. Flush.
    if (currentChunk.length > 0) {
      chunks.push({ type: "text", text: { content: currentChunk } })
      currentChunk = ""
    }

    // Common case: the fragment fits in a fresh chunk. Start one.
    if (fragment.length <= COMPARE_NOTES_CHUNK_CHARS) {
      currentChunk = fragment
      continue
    }

    // Fallback: a single NDJSON entry exceeds the chunk budget.
    // Char-slice with a surrogate-pair-safe backoff so neither
    // emitted block holds a lone surrogate.
    let pos = 0
    while (pos < fragment.length) {
      let end = Math.min(pos + COMPARE_NOTES_CHUNK_CHARS, fragment.length)
      if (end < fragment.length) {
        const lastCode = fragment.charCodeAt(end - 1)
        if (lastCode >= 0xd800 && lastCode <= 0xdbff) {
          end -= 1
        }
      }
      chunks.push({ type: "text", text: { content: fragment.slice(pos, end) } })
      pos = end
    }
  }

  if (currentChunk.length > 0) {
    chunks.push({ type: "text", text: { content: currentChunk } })
  }

  return chunks
}

// ---------------------------------------------------------------------------
// Property builder helpers
// ---------------------------------------------------------------------------

export function buildProjectProps(input: {
  name: string
  type?: string
  path?: string
  description?: string
}): PageProperties {
  const props: PageProperties = {
    [PROJECT_PROPS.NAME]: { title: [{ text: { content: input.name } }] },
  }
  if (input.type) {
    props[PROJECT_PROPS.TYPE] = { select: { name: input.type } }
  }
  if (input.path) {
    props[PROJECT_PROPS.PATH] = { rich_text: [{ text: { content: input.path } }] }
  }
  if (input.description) {
    props[PROJECT_PROPS.DESCRIPTION] = {
      rich_text: [{ text: { content: input.description } }],
    }
  }
  props[PROJECT_PROPS.STATUS] = { select: { name: "active" } }
  return props
}

export function buildTopicProps(input: {
  name: string
  projectIds: string[]
  description?: string
}): PageProperties {
  const props: PageProperties = {
    [TOPIC_PROPS.NAME]: { title: [{ text: { content: input.name } }] },
    [TOPIC_PROPS.PROJECT]: { relation: input.projectIds.map((id) => ({ id })) },
  }
  if (input.description) {
    props[TOPIC_PROPS.DESCRIPTION] = {
      rich_text: [{ text: { content: input.description } }],
    }
  }
  return props
}

export function buildMemoryProps(input: {
  title: string
  projectIds?: string[]
  topicId?: string
  source?: string
  kind?: string
  status?: string
  reviewBy?: string | null
  doneAt?: string | null
  decidedAt?: string | null
  lastReferencedAt?: string | null
  supersedesIds?: string[]
  affectsIds?: string[]
  alternatives?: string
  consequences?: string
  author?: string
  agent?: string
  tags?: string[]
  keywords?: string
  synopsis?: string
  expiresOn?: string | null
  session?: string
  taskState?: string
  blockedBy?: string
  entity?: string
  topicKey?: string
  revisionCount?: number
  comparedWith?: string[]
  compareNotes?: string
  promotionSourceKey?: string
  /**
   * Scope / lifetime fields. Each carries clear-cell
   * semantics: `undefined` leaves the column untouched, `null` (for
   * select / date columns) clears the column, an empty string (for
   * rich_text columns) clears the column. Service-layer write paths
   * normalize the `MemoryScopeInput` shape into these primitives so
   * `buildMemoryProps` doesn't need to know about the bundle.
   */
  scopeKind?: string | null
  scopeKey?: string
  audience?: string
  lifetime?: string | null
  expiresAt?: string | null
  /**
   * Pinned context block fields. Each carries
   * clear-cell semantics aligned with the existing builder
   * contract: `undefined` leaves the column untouched, `null` (for
   * the number / select columns) clears, a value writes verbatim.
   * The boolean `pinned` column has no clear sentinel — `undefined`
   * leaves untouched, `true` / `false` write.
   */
  pinned?: boolean
  pinnedPriority?: number | null
  mutability?: string | null
}): PageProperties {
  const props: PageProperties = {
    [MEMORY_PROPS.TITLE]: { title: [{ text: { content: input.title } }] },
  }
  if (input.projectIds?.length) {
    props[MEMORY_PROPS.PROJECT] = { relation: input.projectIds.map((id) => ({ id })) }
  }
  if (input.topicId) {
    props[MEMORY_PROPS.TOPIC] = { relation: [{ id: input.topicId }] }
  }
  if (input.source) {
    props[MEMORY_PROPS.SOURCE] = { select: { name: input.source } }
  }
  if (input.kind) {
    props[MEMORY_PROPS.KIND] = { select: { name: input.kind } }
  }
  if (input.status) {
    props[MEMORY_PROPS.STATUS] = { select: { name: input.status } }
  }
  // `null` explicitly clears a date; `undefined` leaves it untouched.
  // Strict `=== null` (rather than bare-truthy) so the contract is exact:
  // a non-null string lands as `{ date: { start: <string> } }` verbatim,
  // including any malformed value the caller managed to slip past Zod —
  // surfacing as a Notion-side validation error instead of silently
  // collapsing to a column clear. Documented agent-facing inputs are
  // `null`, `undefined`, and `YYYY-MM-DD` (regex-enforced at the MCP
  // Zod boundary).
  if (input.reviewBy !== undefined) {
    props[MEMORY_PROPS.REVIEW_BY] =
      input.reviewBy === null ? { date: null } : { date: { start: input.reviewBy } }
  }
  if (input.doneAt !== undefined) {
    props[MEMORY_PROPS.DONE_AT] =
      input.doneAt === null ? { date: null } : { date: { start: input.doneAt } }
  }
  if (input.decidedAt !== undefined) {
    props[MEMORY_PROPS.DECIDED_AT] =
      input.decidedAt === null ? { date: null } : { date: { start: input.decidedAt } }
  }
  if (input.lastReferencedAt !== undefined) {
    props[MEMORY_PROPS.LAST_REFERENCED_AT] =
      input.lastReferencedAt === null
        ? { date: null }
        : { date: { start: input.lastReferencedAt } }
  }
  if (input.supersedesIds) {
    props[MEMORY_PROPS.SUPERSEDES] = {
      relation: input.supersedesIds.map((id) => ({ id })),
    }
  }
  if (input.affectsIds) {
    props[MEMORY_PROPS.AFFECTS] = { relation: input.affectsIds.map((id) => ({ id })) }
  }
  if (input.alternatives !== undefined) {
    props[MEMORY_PROPS.ALTERNATIVES] = {
      rich_text: [{ text: { content: input.alternatives } }],
    }
  }
  if (input.consequences !== undefined) {
    props[MEMORY_PROPS.CONSEQUENCES] = {
      rich_text: [{ text: { content: input.consequences } }],
    }
  }
  if (input.author) {
    props[MEMORY_PROPS.AUTHOR] = { rich_text: [{ text: { content: input.author } }] }
  }
  if (input.agent) {
    props[MEMORY_PROPS.AGENT] = { rich_text: [{ text: { content: input.agent } }] }
  }
  if (input.tags?.length) {
    props[MEMORY_PROPS.TAGS] = {
      multi_select: input.tags.map((t) => ({ name: t })),
    }
  }
  if (input.keywords !== undefined) {
    props[MEMORY_PROPS.KEYWORDS] = { rich_text: [{ text: { content: input.keywords } }] }
  }
  if (input.synopsis !== undefined) {
    props[MEMORY_PROPS.SYNOPSIS] = { rich_text: [{ text: { content: input.synopsis } }] }
  }
  if (input.expiresOn !== undefined) {
    props[MEMORY_PROPS.EXPIRES_ON] =
      input.expiresOn === null
        ? { rich_text: [] }
        : { rich_text: [{ text: { content: input.expiresOn } }] }
  }
  if (input.session) {
    props[MEMORY_PROPS.SESSION] = { rich_text: [{ text: { content: input.session } }] }
  }
  if (input.taskState) {
    props[MEMORY_PROPS.TASK_STATE] = { select: { name: input.taskState } }
  }
  if (input.blockedBy !== undefined) {
    props[MEMORY_PROPS.BLOCKED_BY] = {
      rich_text: [{ text: { content: input.blockedBy } }],
    }
  }
  if (input.entity !== undefined) {
    props[MEMORY_PROPS.ENTITY] = { rich_text: [{ text: { content: input.entity } }] }
  }
  // `undefined` leaves the column untouched; explicit empty-string
  // writes through (the agent-facing detach signal). Empty string is
  // structurally distinct from "never set" because vaults can ship
  // the schema before the upsert path is wired; until then every save
  // passes `topicKey: undefined` and the column stays null on new
  // rows.
  if (input.topicKey !== undefined) {
    props[MEMORY_PROPS.TOPIC_KEY] = { rich_text: [{ text: { content: input.topicKey } }] }
  }
  if (input.revisionCount !== undefined) {
    props[MEMORY_PROPS.REVISION_COUNT] = { number: input.revisionCount }
  }
  // Three-state semantics, matching `supersedesIds` / `affectsIds` /
  // `tags`: `undefined` leaves the column untouched, an empty array
  // explicitly writes an empty relation (clear-cell), a populated
  // array maps each id to a relation entry. The truthy gate matches
  // existing precedent — do not "normalize" to `!== undefined`, which
  // would silently change the clear semantics for callers that pass
  // an empty array intending a write.
  if (input.comparedWith) {
    props[MEMORY_PROPS.COMPARED_WITH] = {
      relation: input.comparedWith.map((id) => ({ id })),
    }
  }
  // Compare Notes is an append-only NDJSON cell. Routes
  // through `encodeCompareNotesRichText` so any string up to
  // `COMPARE_NOTES_MAX_CHARS` produces a Notion-valid chunked payload,
  // not a single text block that would fail Notion's per-block
  // 2000-char ceiling on any audit trail past ~13 entries. Empty
  // string emits `[]` (clear-cell), matching the encoder's
  // empty-input contract — a future caller diffing the property
  // write payloads sees one shape regardless of which path produced
  // it.
  if (input.compareNotes !== undefined) {
    props[MEMORY_PROPS.COMPARE_NOTES] = {
      rich_text: encodeCompareNotesRichText(input.compareNotes),
    }
  }
  if (input.promotionSourceKey !== undefined) {
    props[MEMORY_PROPS.PROMOTION_SOURCE_KEY] = {
      rich_text: [{ text: { content: input.promotionSourceKey } }],
    }
  }
  // Scope / lifetime. Tristate semantics on the select +
  // date columns mirror `confidenceScore` / `reviewBy` / `doneAt`:
  // `undefined` leaves the column untouched, `null` clears, a value
  // writes verbatim. Rich_text columns (`scopeKey`, `audience`) follow
  // the existing rich_text precedent on this builder — `undefined`
  // leaves untouched, an empty string writes through (the explicit
  // clear path on rich_text). Service-layer normalization in
  // `MemoryService` collapses the higher-level `MemoryScopeInput`
  // shape onto these primitives so the builder's surface stays one
  // primitive per Notion column.
  if (input.scopeKind !== undefined) {
    props[MEMORY_PROPS.SCOPE_KIND] =
      input.scopeKind === null ? { select: null } : { select: { name: input.scopeKind } }
  }
  if (input.scopeKey !== undefined) {
    props[MEMORY_PROPS.SCOPE_KEY] = { rich_text: [{ text: { content: input.scopeKey } }] }
  }
  if (input.audience !== undefined) {
    props[MEMORY_PROPS.AUDIENCE] = { rich_text: [{ text: { content: input.audience } }] }
  }
  if (input.lifetime !== undefined) {
    props[MEMORY_PROPS.LIFETIME] =
      input.lifetime === null ? { select: null } : { select: { name: input.lifetime } }
  }
  if (input.expiresAt !== undefined) {
    props[MEMORY_PROPS.EXPIRES_AT] =
      input.expiresAt === null ? { date: null } : { date: { start: input.expiresAt } }
  }
  // Pinned context blocks. Tristate semantics on the
  // number + select columns mirror `confidenceScore` / `lifetime`:
  // `undefined` leaves the column untouched, `null` clears, a value
  // writes verbatim. The checkbox column has no clear sentinel —
  // `undefined` leaves untouched, `true` / `false` write.
  if (input.pinned !== undefined) {
    props[MEMORY_PROPS.PINNED] = { checkbox: input.pinned }
  }
  if (input.pinnedPriority !== undefined) {
    props[MEMORY_PROPS.PINNED_PRIORITY] =
      input.pinnedPriority === null ? { number: null } : { number: input.pinnedPriority }
  }
  if (input.mutability !== undefined) {
    props[MEMORY_PROPS.MUTABILITY] =
      input.mutability === null
        ? { select: null }
        : { select: { name: input.mutability } }
  }
  return props
}

/**
 * Serialize an alias list to the rich_text format the Entities DB stores.
 * Joined with `, ` so a Notion-side `Aliases contains "foo"` filter can
 * find any single alias substring without the caller knowing the
 * delimiter.
 */
export function buildEntityProps(input: {
  name: string
  aliases?: string[]
  kind?: string
  description?: string
  projectIds?: string[]
  sourceMemoryId?: string
}): PageProperties {
  const props: PageProperties = {
    [ENTITY_PROPS.NAME]: { title: [{ text: { content: input.name } }] },
  }
  if (input.aliases !== undefined) {
    // Always emit, even on empty arrays, so a clear-aliases update can
    // wipe the cell. Notion ignores `rich_text: []` on missing fields,
    // so the explicit empty-string text block is the cleanest write path.
    const joined = input.aliases.join(", ")
    props[ENTITY_PROPS.ALIASES] = { rich_text: [{ text: { content: joined } }] }
  }
  if (input.kind) {
    props[ENTITY_PROPS.KIND] = { select: { name: input.kind } }
  }
  if (input.description !== undefined) {
    props[ENTITY_PROPS.DESCRIPTION] = {
      rich_text: [{ text: { content: input.description } }],
    }
  }
  if (input.projectIds?.length) {
    props[ENTITY_PROPS.PROJECT] = { relation: input.projectIds.map((id) => ({ id })) }
  }
  if (input.sourceMemoryId) {
    props[ENTITY_PROPS.SOURCE] = { relation: [{ id: input.sourceMemoryId }] }
  }
  return props
}

export function buildFactProps(input: {
  subject: string
  predicate: string
  object: string
  projectIds?: string[]
  validFrom?: string
  validUntil?: string | null
  reviewBy?: string
  sourceMemoryId?: string
  /**
   * Transaction-time observation timestamp. YYYY-MM-DD form.
   * `undefined` leaves the column untouched, `null` clears, a string writes
   * verbatim. `FactService.create` seeds this at the write boundary; the
   * backfill migration writes it from `created_time` on rows missing it.
   */
  observedAt?: string | null
  /**
   * Transaction-time invalidation timestamp. YYYY-MM-DD form.
   * `undefined` leaves the column untouched, `null` clears, a string writes
   * verbatim. `FactService.invalidate` writes this alongside `Valid Until`
   * so a single `pages.update` carries both the domain-truth-ended date
   * and the "Lore learned it stopped being true" date.
   */
  invalidatedAt?: string | null
  /**
   * Memory id that prompted the invalidation. Distinct from
   * `sourceMemoryId` (the supporting memory at creation time). Optional
   * even when invalidating — operators may invalidate without a structured
   * provenance link, in which case the column stays empty.
   */
  invalidatedBySourceMemoryId?: string
  confidence?: string
  /**
   * System-managed numeric confidence. `undefined` leaves the column
   * untouched, `null` clears the column ("never scored"), a number writes the
   * value verbatim. Production callers in `FactService` only emit numbers; the
   * `null` clear path is the test-fixture / migration path.
   */
  confidenceScore?: number | null
  /**
   * System-managed read-citation timestamp. YYYY-MM-DD form.
   * `undefined` leaves the column untouched, `null` clears, a string writes
   * verbatim.
   */
  lastReferencedAt?: string | null
  dedupKey?: string
  subjectKey?: string
  subjectEntityId?: string
  objectEntityId?: string
  /** Scope / lifetime. Same tristate semantics as `buildMemoryProps`. */
  scopeKind?: string | null
  scopeKey?: string
  audience?: string
  lifetime?: string | null
  expiresAt?: string | null
}): PageProperties {
  const props: PageProperties = {
    [FACT_PROPS.SUBJECT]: { title: [{ text: { content: input.subject } }] },
    [FACT_PROPS.PREDICATE]: { select: { name: input.predicate } },
    [FACT_PROPS.OBJECT]: { rich_text: [{ text: { content: input.object } }] },
  }
  if (input.projectIds?.length) {
    props[FACT_PROPS.PROJECT] = { relation: input.projectIds.map((id) => ({ id })) }
  }
  if (input.validFrom) {
    props[FACT_PROPS.VALID_FROM] = { date: { start: input.validFrom } }
  }
  if (input.validUntil !== undefined) {
    props[FACT_PROPS.VALID_UNTIL] =
      input.validUntil === null ? { date: null } : { date: { start: input.validUntil } }
  }
  // Transaction-time provenance. Same tristate semantics as
  // confidenceScore / lastReferencedAt above: undefined leaves untouched,
  // null clears, a string writes verbatim.
  if (input.observedAt !== undefined) {
    props[FACT_PROPS.OBSERVED_AT] =
      input.observedAt === null ? { date: null } : { date: { start: input.observedAt } }
  }
  if (input.invalidatedAt !== undefined) {
    props[FACT_PROPS.INVALIDATED_AT] =
      input.invalidatedAt === null
        ? { date: null }
        : { date: { start: input.invalidatedAt } }
  }
  if (input.invalidatedBySourceMemoryId) {
    props[FACT_PROPS.INVALIDATED_BY] = {
      relation: [{ id: input.invalidatedBySourceMemoryId }],
    }
  }
  if (input.reviewBy) {
    props[FACT_PROPS.REVIEW_BY] = { date: { start: input.reviewBy } }
  }
  if (input.sourceMemoryId) {
    props[FACT_PROPS.SOURCE] = { relation: [{ id: input.sourceMemoryId }] }
  }
  if (input.confidence) {
    props[FACT_PROPS.CONFIDENCE] = { select: { name: input.confidence } }
  }
  // `undefined` leaves the column untouched; `null` clears; a number writes.
  if (input.confidenceScore !== undefined) {
    props[FACT_PROPS.CONFIDENCE_SCORE] =
      input.confidenceScore === null
        ? { number: null }
        : { number: input.confidenceScore }
  }
  if (input.lastReferencedAt !== undefined) {
    props[FACT_PROPS.LAST_REFERENCED_AT] =
      input.lastReferencedAt === null
        ? { date: null }
        : { date: { start: input.lastReferencedAt } }
  }
  if (input.dedupKey) {
    props[FACT_PROPS.DEDUP_KEY] = { rich_text: [{ text: { content: input.dedupKey } }] }
  }
  // Truthy-gate would silently skip the column for punctuation-only subjects
  // (e.g. `"."` normalizes to `""`), creating rows that the dedup backfill
  // then has to re-pick-up. Write the empty string explicitly so the create
  // path is consistent with the backfill path's "always populate" contract.
  if (input.subjectKey !== undefined) {
    props[FACT_PROPS.SUBJECT_KEY] = {
      rich_text: [{ text: { content: input.subjectKey } }],
    }
  }
  if (input.subjectEntityId) {
    props[FACT_PROPS.SUBJECT_ENTITY] = {
      relation: [{ id: input.subjectEntityId }],
    }
  }
  if (input.objectEntityId) {
    props[FACT_PROPS.OBJECT_ENTITY] = {
      relation: [{ id: input.objectEntityId }],
    }
  }
  // Scope / lifetime. See `buildMemoryProps` for the
  // tristate semantics rationale; the Facts DB columns mirror Memories
  // one-for-one so the write path is identical.
  if (input.scopeKind !== undefined) {
    props[FACT_PROPS.SCOPE_KIND] =
      input.scopeKind === null ? { select: null } : { select: { name: input.scopeKind } }
  }
  if (input.scopeKey !== undefined) {
    props[FACT_PROPS.SCOPE_KEY] = { rich_text: [{ text: { content: input.scopeKey } }] }
  }
  if (input.audience !== undefined) {
    props[FACT_PROPS.AUDIENCE] = { rich_text: [{ text: { content: input.audience } }] }
  }
  if (input.lifetime !== undefined) {
    props[FACT_PROPS.LIFETIME] =
      input.lifetime === null ? { select: null } : { select: { name: input.lifetime } }
  }
  if (input.expiresAt !== undefined) {
    props[FACT_PROPS.EXPIRES_AT] =
      input.expiresAt === null ? { date: null } : { date: { start: input.expiresAt } }
  }
  return props
}
