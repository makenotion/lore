# AGENTS.md -- src/core/

> Read the root `AGENTS.md` first. This file covers the domain logic layer only.

## Purpose

This directory contains Lore's business logic: CRUD operations for each entity
type, context resolution, and vault management. These services sit between the
interfaces (MCP, CLI, hooks) and the Notion SDK layer (`src/notion/`).

## Files

| File                                | Class/Function                                                                                                                               | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vault.ts`                          | `VaultManager`                                                                                                                               | Init/load vault, get database IDs, count stats, drift check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `topology.ts`, `topology-status.ts` | `buildVaultTopology()`, `loadVaultTopologyStatus()`                                                                                          | Multi-vault topology normalization and status probing. "Topology" means the configured relationship between the primary `vault.pageId`, read-only upstream vaults, and deliberate promotion targets; normal writes still target only the primary vault. The primary label defaults to the literal string `Primary`; upstreams are implicitly read-only; status probes must reuse the shared `initServices()` client so auth refresh and rate limiting stay process-wide. Operator-facing output contract (when the section renders, every health string the surface emits, recovery workflow per degraded state) lives in [`docs/topology.md`](../../docs/topology.md).                                                                                                                                                                                                                                                 |
| `promote.ts`                        | `promoteMemory()`, `buildPromotionAuditBlock()`                                                                                              | Cross-vault memory promotion (issue #286). Reads a source memory from the primary vault and creates a faithful copy in a configured promotion target via a fresh `VaultManager` on the same shared client. Origin metadata (source vault label, source memory id + URL, kind/status/confidence/synopsis, promoter, ISO timestamp, optional reason) ships as a leading `## Promoted from <vault>` audit block — not as Notion relations, because a relation column targets a specific database and a primary-vault memory id is not addressable from a target-vault relation. Rejects same-vault targets; forces `Status = proposed` when `target.requireReview`, otherwise passes through the source status. Project relations, agent / session attribution, and `source` provenance do NOT cross the vault boundary. Operator-facing surface contract lives in [`docs/topology.md`](../../docs/topology.md#promotion). |
| `project.ts`                        | `ProjectService`                                                                                                                             | CRUD for projects, findByPath, findByName                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `topic.ts`                          | `TopicService`                                                                                                                               | CRUD for topics, getOrCreate, listByProject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `memory.ts`                         | `MemoryService`                                                                                                                              | Public memory facade for CRUD, list, topic-key upsert/re-key, review-state changes, stale-confidence query, and compatibility exports. Delegates mapper, create, list, review, update, confidence score, pinned context block, topic-key, compare audit, and search/ranking workflows to focused collaborators while preserving the existing public `MemoryService` surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `memory-create.ts`                  | `MemoryCreate`, create helper exports                                                                                                        | Create implementation behind `MemoryService`: duplicate locking, autosave-learning duplicate/index-stability probes, fresh page creation, pinned-create preflight, body writes, cleanup-orphan partial-failure handling, and `MemoryCreatePartialFailureError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `memory-list.ts`                    | `MemoryList`, `ListMemoriesOptions`                                                                                                          | List implementation behind `MemoryService`: `list`, `listForNearDuplicates`, default review-state exclusion, scope filtering, cleanup-orphan exclusion, RunTool SQL near-duplicate candidate fetch, pagination, and optional body materialization.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `memory-mapper.ts`                  | `MemoryMapper`, `pageToMemory()`, relation hydration helpers                                                                                 | Mapping implementation behind `MemoryService`: Memories page relation hydration, `pageToMemory`, `extractMemoryScope`, and list/search materialization helpers. Re-exported through `memory.ts` for compatibility with task, decision, and test callers.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `memory-review.ts`                  | `MemoryReview`, review error exports                                                                                                         | Proposed-memory review implementation behind `MemoryService`: approve/reject state guards, decision-row rejection, audit-block append, and `MemoryReviewStateError` / `MemoryReviewAuditError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `memory-update.ts`                  | `MemoryUpdate`, update error exports                                                                                                         | Update implementation behind `MemoryService`: rich-text decode, partial property writes, content replacement, title-cache write-through, pinned-update preflight/cache invalidation, `MemoryUpdatePartialFailureError`, and `PartialUpdateError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `memory-compare.ts`                 | `MemoryCompare`, compare helper exports                                                                                                      | Compare-notes implementation behind `MemoryService`: pair-audit writes, per-side idempotent retry handling, dispatch ledger helpers, `recordContradiction`, `recordSupersedence`, and compare partial-failure errors. Owns the `Compare Notes` NDJSON append/ledger helpers while `memory.ts` re-exports the stable public surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `memory-confidence.ts`              | `MemoryConfidence`                                                                                                                           | Confidence dynamics I/O behind `MemoryService`: `touchOnRead`, `decrementConfidence`, `listAllForBackfill`, `applyBackfillScore`, and `confidenceStats`. Owns the Notion writes around `decay.ts` algebra and the paginated confidence-backfill walker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `memory-filters.ts`                 | `cleanupOrphanExclusionFilter()`, `withCleanupOrphanExclusion()`                                                                             | Shared Memories DB filter helpers for excluding cleanup-orphan sentinel rows from live read/write walkers without duplicating filter composition.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `memory-pinned.ts`                  | `MemoryPinned`                                                                                                                               | Pinned context block implementation behind `MemoryService`: read-only and hard-cap preflight, create/update pinned property mapping helpers, count cache, `listPinnedBlocks`, `countPinnedBlocks`, and the pinned helper exports (`MemoryReadOnlyError`, `MemoryPinCapExceededError`, `pinnedBlockAudienceMatches`, `clampPinnedPriority`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `memory-review-state.ts`            | `REVIEW_TERMINAL_STATUSES`, review filter helpers                                                                                            | Shared review-state predicates used by memory list/search recall paths. Centralizes the proposed/rejected default-exclusion clauses and the semantic-search post-filter predicate so the facade and `MemorySearch` do not duplicate terminal-status logic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `memory-search.ts`                  | `MemorySearch`, search helper exports                                                                                                        | Search implementation behind `MemoryService`: contains, semantic, hybrid/RRF, RunTool-backed semantic search, explain traces, semantic pagination caps, hybrid branch failure logging, and confidence-aware ranking helpers. Owns search constants such as `HYBRID_FALLBACK_THRESHOLD`, `SEMANTIC_SEARCH_MAX_PAGES`, and `tieBreakingRrfCompare` while `memory.ts` re-exports the stable public surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `memory-topic-key.ts`               | `MemoryTopicKey`                                                                                                                             | Topic-key implementation behind `MemoryService`: `findByTopicKey`, `upsertByTopicKey`, `validateRekey`, `rekeyTopicKey`, promotion advisory helpers, topic-upsert fingerprint parsing, and `RekeyAuditError`. Owns the Notion writes for revision append and re-key audit blocks while the facade keeps the stable public method surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `fact.ts`                           | `FactService`                                                                                                                                | Public fact facade for knowledge graph triples with temporal validity; delegates read queries, invalidation, and maintenance/backfill writes while keeping create/entity-merge behavior on the service                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `fact-queries.ts`                   | `FactQueries`                                                                                                                                | Read/query collaborator behind `FactService`: fact lookup, subject/object/source/entity queries, recent and overdue listings, scope filtering, pagination, and raw predicate counts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fact-invalidation.ts`              | `FactInvalidation`                                                                                                                           | Invalidation implementation behind `FactService`: fact-id locking, archived-row skip, confidence decrement, transaction-time invalidation writes, and missing-column retry behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fact-maintenance.ts`               | `FactMaintenance`                                                                                                                            | Maintenance and backfill I/O behind `FactService`: read-touch confidence bumps, review extension, source repair, expiring scoped stats, fact backfill walker, confidence-score writes, and observed/invalidated-at backfill writes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `decision.ts`                       | `DecisionService`                                                                                                                            | Decision lifecycle (Kind=decision memories): create, list (index tier), supersede, chain walk, review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `decision-graph.ts`                 | `resolveCanonicalDecisionLinks()`, `syncDecisionReachability()`                                                                              | Decision graph helpers for resolving supersession chains and retargeting `decided_by` facts when a decision is superseded. Shared by MCP and CLI decision/ask surfaces.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ask.ts`                            | `runAsk()`                                                                                                                                   | Shared entity ask orchestration for facts, governing decisions, tasks, project framing, JSON data, and touch-on-read side effects. Called by the MCP `lore-query action='ask'` handler and the `lore ask` CLI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `task.ts`                           | `TaskService`                                                                                                                                | Task CRUD (Kind=task memories): create, list (index tier), update, close, queryOverdue, countActive, countClosedSince. Hosts `taskDaysOverdue` / `taskDaysStale` helpers and the `taskStats` + `formatTaskSummary` pair shared by `lore status` and `lore-context action='status'`. Canonical surface for tracked work (P3-02).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `task-reconcile.ts`                 | `reconcileActiveTasks()` / `scoreCandidate()` / `formatReconcileOutput()`                                                                    | Operator-pulled batch reconciliation (issue 0.7.0/14): scan active tasks against recent memories with resolution-shaped cues, score by entity / cue / recency, surface ranked candidate closures. Read-only; one-shot vault cleanup. Hosts the `MAX_RECONCILE_TASKS` / `RECONCILE_PER_TASK_LIMIT` / cue-pattern constants and the `mapWithConcurrency` fan-out helper. Shared by `lore-task action='reconcile'` and `lore tasks reconcile`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `procedure.ts`                      | `findProcedureCandidates()` / `scoreCandidate()` / `composeProcedureBody()` / `buildProposeProcedureInput()`                                 | Procedural memory promotion. Read-only candidate scan walks resolved incidents / postmortems / runbooks plus closed tasks, clusters by entity, ranks by count + kind diversity + recency. Body composer renders structured `## Activation Conditions` / `## Steps` / `## Known Failure Modes` / `## Sources` sections; activation tokens replicated to `Keywords` for hybrid-search retrieval. Promotion writes `Kind = procedure, Status = proposed`; approval routes through existing `MemoryService.recordReview`. Shared by `lore-procedure` MCP tool and `lore procedures` CLI.                                                                                                                                                                                                                                                                                                                                    |
| `entity.ts`                         | `EntityService`                                                                                                                              | Canonical-entity registry (PF3-01): findByName, findByAlias, resolveOrCreateEntity (with ambiguity surface), addAliases, archive. Required service wired from the required Entities DB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `entity-merge.ts`                   | `mergeEntities()`                                                                                                                            | Operator-driven duplicate Entity merge: preview/apply plan, repoint facts from loser to winner, append loser lookup forms to winner aliases, write a merge note, archive loser only after earlier steps succeed, then re-scan for late fact writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `entity-migration.ts`               | `buildEntities()`                                                                                                                            | One-shot pass that groups every fact's Subject/Object strings by normalized key, picks longest-form canonical, and fills empty `SubjectEntity`/`ObjectEntity` relations without overwriting populated relations. Plan-then-execute via `lore migrate --build-entities --yes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `context.ts`                        | `resolveProject()`                                                                                                                           | Match cwd to a project via longest prefix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `wakeup.ts`                         | `loadWakeUpData()`                                                                                                                           | Aggregate digest + memories + facts + decisions + active-task-related memories for wake-up surfaces (MCP tool + shell hook)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `project-context.ts`                | `composeProjectContext()` / `renderProjectContextLines()`                                                                                    | Renders the per-project framing block (name + description + siblings + catch-all warning) for `lore-context action='wake-up'`, `lore-query action='ask'`, and the shell wake-up hook. Synchronous; takes an already-resolved `Project` so no Notion call. (Issue 0.6.0/18.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `cache.ts`                          | `LruCache<K, V>`                                                                                                                             | Minimal in-process LRU + TTL used by name→id resolvers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `fact-encoding.ts`                  | `fixFactEncoding()`                                                                                                                          | `lore migrate --fix-fact-encoding` — decode Subject/Object + recompute DedupKey, gated by post-decode collisions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `memory-encoding.ts`                | `fixMemoryEncoding()`                                                                                                                        | `lore migrate --fix-memory-encoding` — decode Title + body markdown; skips archived. Bodies >100 KB skip the canonical `replace_content` path by default; under `LORE_USE_RUNTOOL_BLOCK_EDIT=1` they're rewritten via RunTool's anchored `update_content` per-entity substitutions when the row's local guards predict success (issue #534 AC #5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `agent-normalization.ts`            | `normalizeAgents()`                                                                                                                          | `lore migrate --normalize-agents` — collapse fragmented `Agent` strings onto their canonical form (PF3-02)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `synopsis-backfill.ts`              | `backfillSynopses()`                                                                                                                         | `lore migrate --backfill-synopses` — synthesize a 1–2 sentence synopsis for memories whose `Synopsis` is empty; pluggable `claude` / `placeholder` backends (issue 0.7.0/05)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `confidence-migration.ts`           | `runBuildConfidenceScoresMigration()`                                                                                                        | `lore migrate --build-confidence-scores` — baseline-seed every memory's `Confidence Score` from its categorical `Confidence` and write `Last Referenced At = created_time`, then realize accrued decay. Plan-then-execute; `--yes` applies. Project-scoped via `--project <name>` (strict-resolve, fails fast on unknown names). (Issue 0.8.0/11.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `similarity.ts`                     | `titleTrigrams`, `trigramJaccard`, `tagOverlap`                                                                                              | Pure helpers for the write-path near-duplicate probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `near-duplicate.ts`                 | `findNearDuplicates()`                                                                                                                       | Advisory probe used by memory and decision write paths (`lore-memory action='save'`, `lore-decision action='create'`) to surface similar rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `conflict.ts`                       | `findConflictCandidates()`                                                                                                                   | Lexical conflict-candidate generator (0.9.0 issue #03). Pure function over a `Memory[]` snapshot — no Notion access. Consumed by #05 (`lore-memory action='compare'`) and #09 (`lore conflicts scan`). Returns pairs whose title-blob trigram OR tag overlap crosses threshold; the caller filters on `comparedWith` / archive state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `prompts/conflict-judge.ts`         | `renderConflictJudgePrompt()` + `CONFLICT_JUDGE_PROMPT_VERSION`                                                                              | Locked judgment-prompt template for the conflict-detection workflow (0.9.0 issue #03). Borrowed from engram's `internal/llm/prompt.go` discipline; see "Locked LLM prompts (`src/core/prompts/`)" below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `decay.ts`                          | `clampConfidenceScore`, `seedConfidenceScore`, `bumpConfidenceScore`, `decrementConfidenceScore`, `decayConfidenceScore`, `confidenceFactor` | Pure-algebra helpers for the dynamic-confidence workstream (0.8.0/#03). `MemoryConfidence` consumes the read/decrement helpers behind the `MemoryService` facade; #08's RRF reads `confidenceFactor`. The migration in `confidence-migration.ts` consumes `seedConfidenceScore` + `decayConfidenceScore` for baseline backfill                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `topic-key.ts`                      | `suggestTopicKey()`                                                                                                                          | Pure heuristic over (title, kind) → kebab-case `${family}/${noun-phrase}` key (issue 0.9.0/#07). No I/O, no Notion access. Backs `lore-memory action='suggest-topic-key'`. Family from a closed `Record<MemoryKind, string \| null>` — `note` and `task` map to `null`. Noun phrase is the title's first 4 tokens after NFKD ASCII fold + stoplist + preposition-break filtering, with `YYYY-MM-DD` dates pre-stripped, then truncated at a 48-char hyphen-aware boundary. Deterministic; same input always returns the same key                                                                                                                                                                                                                                                                                                                                                                                        |
| `memory-debt.ts`                    | `scanDebt()`, `priorityForScore()`, `debtTaskMarker()`, `DEBT_CATEGORIES`                                                                    | Read-only memory-debt audit (issue #288). Pure orchestrator over `queryStaleConfidence` / `queryOrphans` / `queryOverdue` / `findConflictCandidates` / `findSimilarTopicGroups` / `loadExpiringScopedStatus`. Categorizes findings into seven `DebtCategory` values, scores via `severity + retrieval + staleness + confidence + governance`, buckets P1/P2/P3, paginates bounded probes with `*Capped` flags. **Stable id-prefix contract** for JSON consumers: `low_trust::<id>`, `orphan_fact::<id>`, `overdue_fact::<id>`, `overdue_decision::<id>`, `overdue_task::<id>`, `stale_task::<id>` (fused under `category: "overdue_governance"`), `duplicate_cluster::<lo>::<hi>`, `topic_sprawl::<topicId>`, `scope_anomaly::<expired\|expiring_soon\|out_of_context>`, `ownerless::<memoryId>`. Tooling that consumes the JSON shape splits on these prefixes; do not rename without a coordinated bump.              |

## Detailed Contract Docs

| Area                      | Guide                                                    | Contract                                                                                                                                                                       |
| ------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Retrieval / memory search | [`docs/core/retrieval.md`](../../docs/core/retrieval.md) | `MemoryService.search()`, `MemorySearch`, contains / semantic / hybrid modes, RRF, intent, explain traces, materialization, confidence-aware ranking, and search kill switches |

## Service Class Pattern

All services follow the same constructor pattern:

```typescript
export class FooService {
  constructor(
    private client: Client, // @notionhq/client instance
    private databaseId: string // Notion database ID for this entity
  ) {}
}
```

Services are instantiated in `src/services.ts` via `initServices()`, which loads
the vault, reads database IDs, and creates all service instances.

**Rule**: Services should not instantiate other services. Cross-service calls
happen at the interface layer (MCP tools, CLI commands). Two exceptions compose
multiple services via dependency injection:

- `resolveProject()` takes a `ProjectService` parameter.
- `loadWakeUpData()` accepts a structural `WakeUpServices` (`{ memories, facts }`)
  so both the real `LoreServices` and lightweight test stubs satisfy it.

Prefer this "free-function orchestrator over injected services" shape when the
logic is coordination-only (no stored state, no Notion client ownership).

## Context Resolution

`context.ts` exports `resolveProject()`, which determines the active project
from the working directory. The algorithm:

1. Compute the relative path from the config root (directory containing
   `.lore.yaml`) to the current working directory.
2. If cwd is outside the config root (relative path starts with `..`), return
   `{ project: null, isCatchAllFallback: false }`.
3. Iterate over projects defined in `.lore.yaml`. For each, check if the
   project's `path` is a prefix of the relative path. A project with path
   `"."` or `""` is a **catch-all** — it matches every cwd inside the config
   root with length 0, so any sub-project prefix wins over it.
4. Select the project with the **longest matching prefix** (most specific match).
5. Look up the matched project in Notion by path first, then by name.

This supports monorepo layouts where projects map to subdirectories.

**Return shape**: `resolveProject()` returns `ProjectResolution`, not a bare
`Project | null`. Callers that care about scope accuracy read
`isCatchAllFallback` to detect when the auto-resolved project is the monorepo
catch-all, so they can surface a warning or prompt for explicit selection.
`candidates` holds the non-catch-all project names from the config for use in
those warnings. Two helpers expose these concepts independently:

- `isCatchAllProject(project)` — structural check on a single config entry.
- `subProjectNames(config)` / `catchAllProjectName(config)` — read directly
  from config without walking cwd.

The MCP save layer (`src/mcp/resolve.ts`) uses the cached
`services.context.isCatchAllFallback` flag to add a warning to any save that
falls back to the catch-all without an explicit `projectName`. Hook-local
prompt construction (`src/hooks/helpers.ts`) re-derives sub-projects from the
config without API calls for the same purpose.

### Explicit project-name misses

`project-scope.ts` exports `resolveProjectByName()` /
`resolveProjectsByNames()` and `formatUnresolvedProjectScopeError()` for
operator-facing errors when a caller explicitly names a project that cannot be
resolved. Boundary resolvers for explicit names (MCP, CLI, migrations, hooks)
must use these helpers so typo, archived, and inaccessible project failures
stay consistent and fatal instead of falling back to auto-detected or
vault-wide scope. Archived projects require an explicit opt-in
(`findByName(name, { includeArchived: true })`, normally surfaced as a
command-specific flag such as `--include-archived`) and should produce an
archived-specific diagnostic when rejected. `ProjectService.findByName()` owns
the separate duplicate-active-name error; do not catch and soften it at the
boundary.

## Memory Content Storage

Memory content is stored as Notion page body using the markdown API, not as a
page property. The workflow:

1. **Create**: `pages.create()` with properties only, then `pages.updateMarkdown()`
   with `type: "insert_content"` to write the body.
2. **Read**: `pages.retrieveMarkdown()` returns `{ markdown: string }`.
3. **Update**: `pages.updateMarkdown()` with `type: "replace_content"` and
   `replace_content.new_str`.

This keeps the database properties lightweight (metadata only) while page bodies
hold arbitrarily large content.

## Topic-key upsert (`MemoryService.upsertByTopicKey`, 0.9.0/#06)

`upsertByTopicKey` is the save-time upsert path: when an agent passes
`topicKey` to `lore-memory action='save'`, the handler dispatches here
instead of `create`. The match key is `(Topic Key, Project-set)` and
project equality is set-equal — `[A]` does not match `[A, B]`.
`findByTopicKey` (0.9.0/#01) is the shared lookup helper that resolves
the match.

**Two paths, one return shape**:

| Branch            | Behavior                                                                                                                               | `upserted` |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| No existing match | `create` with `revisionCount: 1` and the topic key seeded onto the new row                                                             | `false`    |
| Existing match    | Append `## Revision N (YYYY-MM-DD)` block to the page body via `replace_content`, then property update with new title + revision count | `true`     |

**Kind-mismatch validation runs BEFORE any Notion write.** The
acceptance criterion is "kind mismatch throws before any Notion
write" — the kind check fires immediately after `findByTopicKey`
returns, NOT after the body read/write. An earlier draft of this
spec had the validation after `retrieveMarkdown` + `updateMarkdown`
— a real correctness bug because a kind-mismatched upsert would
have appended a revision block to the page before rejecting. The
test `throws on kind mismatch BEFORE any Notion write` pins this.

**Project-set equality is enforced by `findByTopicKey`, not by a
defensive recheck.** The lookup post-filters candidates to exact
set-equality (`existing.projectIds.length === input.projectIds.length
&& existing.projectIds.every(id => inputSet.has(id))`) and returns
null on mismatch — so by construction the post-find row is set-equal
to the input. A second JS-side recheck against the same returned
value would be structurally tautological, and a true race detection
(a writer mutating the project relation between find and write on
the same process) would require a second `pages.retrieve` round-
trip whose worst-case consequence (one revision lands on a row
whose project set just expanded under a concurrent write) is
benign — not justified.

**Field policy on upsert**:

- **THROW on mismatch**: Kind (the upsert chain is per-kind).
  Project-set is handled by the lookup contract above; not a
  separate throw at this layer.
- **PRESERVE silently** (input dropped, no warning, no property write):
  Status, Topic relation. State transitions belong on
  `lore-memory action='update'`; the upsert path treats these as
  forgotten-to-omit envelopes.
- **REPLACE on every save** (latest write wins): Title, Synopsis,
  Keywords, Source. Confidence (categorical) bumps if input provides
  one; otherwise the existing categorical is written back.
- **UNTOUCHED**: Confidence Score (system-managed per 0.8.0/#01),
  Last Referenced At (read-citation signal per 0.8.0/#02). Bumping
  `Last Referenced At` on upsert would conflate writes with reads
  and break the staleness signal driving the wake-up Stale Confidence
  section.

**Title-cache write-through is load-bearing**. The upsert always bumps
Title, so the same `delete → pages.update → set` write-through
discipline that protects `MemoryService.update` from concurrent
`getTitleById` callers applies here. The pre-write
`titleCache.delete(existing.id)` clears the stored value AND drops
any in-flight `getOrLoad` pending slot (via `LruCache.delete`'s
pending-clearing discipline); the post-write
`titleCache.set(existing.id, decodedTitle || null)` installs the
authoritative new title AND drops any pending slot a second time
(via `LruCache.set`'s symmetric pending-clearing discipline). A
reader whose loader's `pages.retrieve` was in flight across either
boundary has its post-loader commit suppressed by `getOrLoad`'s
identity guard (`pending.get(id) === loaderPromise` → false on the
cleared slot). Without this, render-layer resolvers would keep
returning the pre-upsert title from `titleCache` until the 60s TTL
expired even though the new title has landed in Notion. Pre-PF1-09
this protection lived as a `writeEpoch` sandwich on `MemoryService`;
folding the invariant into `LruCache.set` / `delete` themselves
collapsed the bespoke counter onto the shared primitive.

**`topicKey` is rejected at the MCP boundary when kind is `note`**.
The MCP layer (`src/mcp/tools/memory.ts:handleSave`) throws before
calling `upsertByTopicKey` whenever the resolved save kind is `note`
— either explicitly passed or defaulted (omitted `kind` falls back to
`note`). The contract is symmetric with the suggester's
no-suggestion verdict on note/task: notes are the catch-all default
and don't form a recurring topic. Rejecting at the boundary catches
the omitted-kind path, where an agent passing only `topicKey` would
otherwise silently land in an upsert chain on a `note`-defaulted
memory. The service layer accepts any kind because internal
migrations may bypass the agent-facing contract; the kind-vocabulary
gate lives at the agent boundary, not in the service.

**Empty-project guard**. An upsert with `projectIds: []` is structurally
undefined — set-equality on the empty set matches every other
empty-project memory in the vault. Lore allows projectless saves via
the create path (catch-all), but those must NOT participate in
topic-key upsert. `findByTopicKey` returns null on empty projects, but
`upsertByTopicKey` throws here for a clearer error.

**Notion v5 markdown API has no append mode**. The SDK exposes
`insert_content` for fresh writes on a page with no body and
`replace_content` for full-body edits to an existing body. The upsert
path therefore reads existing markdown via `retrieveMarkdown` before
any append decision. When a new revision is needed, it writes back the
concatenation via `replace_content` with `allow_deleting_content: true`.

**Retry idempotency**. Calling upsert twice with identical effective
inputs does NOT append a second revision. The service compares the
caller input against the current row properties plus the latest stored
body/revision block; when title/content and replace-on-save metadata
(synopsis, keywords, source, confidence, author) already match, it
returns the existing revision without `pages.updateMarkdown` or
`pages.update` only when the body is not ahead of row properties. If a
previous attempt landed the markdown body append but failed before the
property update, the body can be ahead of the `Revision Count` column.
New revision blocks include a SHA-256 fingerprint of the effective
kind + title/content + replace-on-save metadata; a retry repairs the
row properties only when that fingerprint matches the incoming
effective input. Only fingerprinted revision blocks may advance the
append base beyond the stored `Revision Count`; legacy unfingerprinted
blocks are parsed at the stored count for no-op compatibility but
cannot make the count jump. Otherwise body-ahead saves append from the
markdown revision count, not the stale property count. A body, title,
synopsis, keywords, source, confidence, or author change on a complete
chain still appends a revision and preserves the existing
promotion-advisory behavior. Upsert does not throw a structured
partial-state error like update/re-key paths do because retry repairs
the landed markdown state idempotently.

**Returned memory shape carries post-write title / synopsis / keywords**.
The MCP layer's auto-mentions emitter reads `memory.title`,
`memory.keywords`, `memory.synopsis` to extract entities. The returned
memory shape spreads the existing row's untouched fields and overlays
the new title / synopsis / keywords / source / confidence so entity
extraction runs against the post-upsert content (per 0.9.0/#06's
"auto-mentions re-runs on upsert" acceptance criterion).

**Per-revision auto-mentions facts collapse via `createWithDedup`**.
Each revision re-runs the entity tokenizer over the new content and
attempts a `mentions` fact create per surfaced entity. Since the
emitter routes through `FactService.createWithDedup` (see
"Fact Write-Side Dedup" below) and the dedup-key hashes
`normalize(subject) ␟ predicate ␟ normalize(object)`, a stable entity
re-extracted across N revisions does NOT produce N duplicate fact
rows — the second-and-later attempts hit the live-match dedup path
and merge metadata onto the existing fact instead. Fresh entities
introduced by a revision land as new fact rows, and entities dropped
by a revision leave their previously-emitted fact in place (the
0.8.0/#07 staleness posture).

**Concurrent upserts**. Two parallel `lore-memory action='save'` calls
with the same `topicKey` can both find no existing match and both
create fresh — producing two memories with `Revision Count: 1`. Notion
has no per-key uniqueness enforcement. Single-agent serial usage is
the common case; if this becomes a real problem, a follow-up adds a
brief lock via `src/hooks/lock.ts` or via the existing rate-limit gate.

**Promotion advisory on the upsert response (0.9.0/#15)**. The
return shape carries `promotionAdvisory: PromotionAdvisory | null`
populated from `computePromotionAdvisory({ revisionCount,
bodyLength, kind })` over the post-write state already in memory
— no extra Notion calls. Two thresholds
(`PROMOTE_REVISION_THRESHOLD = 5`, `PROMOTE_BODY_LENGTH_THRESHOLD =
5000`) fire the advisory; either or both can land in `reasons`. The
advisory is informational — **never blocks the save and never
auto-promotes**. The MCP layer renders it as a response footer when
non-null; the agent decides whether to act on the suggestion.
Scoping discipline pins the advisory to the **append-revision
branch only**: fresh-create upserts (`upserted === false`) and
non-`topicKey` saves both return `promotionAdvisory: null`
regardless of body length. The advisory is specifically about
revision-chain accumulation — a one-shot write with a long body is
a different signal that warrants a different surface (out of scope
for 0.9.0). The 5KB body threshold is a _human-readability_
heuristic, NOT a Notion structural cap; resisting a precise
block-limit claim is deliberate because Notion's documented limits
drift between releases. Both thresholds are exported consts so a
future patch can tune without schema or behavioral changes.

**The suggestion wording is kind-aware.** Topic-key chains are
valid for `decision`, `runbook`, `incident`, `postmortem`, and
`policy` kinds, but only `kind: 'decision'` memories can be
referenced from `lore-decision action='create'` with
`supersedesIds`: that handler resolves every supersedesIds entry
through `DecisionService.getById`, which throws on non-decision
kinds. A footer that handed a runbook/incident/postmortem/policy
operator `supersedesIds: [<this-id>]` would be a ready-to-paste
broken command. The decision-kind branch keeps the
supersede-and-split wording (and embeds the `<this-memory-id>`
placeholder for MCP-boundary substitution); non-decision kinds get
the universally-valid split / archive path that doesn't depend on
a decision-only API and carries no placeholder. The
`upsertByTopicKey` flow forwards `input.kind` to the helper; the
kind-mismatch guard upstream guarantees `input.kind ===
existing.kind` so either is correct.

The MCP boundary (`formatPromotionAdvisory` in
`src/mcp/tools/memory.ts`) substitutes the just-saved memory's id
at render time via `replaceAll("<this-memory-id>", memoryId)`. For
the non-decision branch the call is a safe no-op because no
placeholder appears in the suggestion. The service-layer return is
id-agnostic by design — the kind / id split keeps the helper a
pure value computation; the rendering layer owns formatting.

## Memories self-relation columns: symmetric-write contract

The Memories DB exposes three `single_property` self-relations:
`Supersedes`, `Affects`, and `Compared With` (0.9.0/#02). Notion's
`single_property` does NOT auto-mirror writes — when memory A names B
in `Compared With`, the relation only points from A to B. The reverse
(B → A) only exists if a parallel write adds it.

**Calling code is responsible for symmetric writes** for any consumer
that depends on the bidirectional invariant. The compare workstream
(0.9.0/#05) is the canonical example: `lore conflicts scan`
(0.9.0/#09) checks whether **either side** names the other in
`Compared With` and skips the pair on a hit. So a half-written A → B
relation (A names B, but B does not name A) is enough to suppress the
next scan — re-judgment is not the failure mode. The actual harm is
**asymmetric audit visibility**: an operator inspecting B's Notion
page sees an empty `Compared With` and an empty `Compare Notes`,
gives no indication that B was ever judged, and a future `lore-memory
action='compare'` against the same pair produces a stale or
contradictory verdict that depends on which side the agent loaded
first. The two-write contract preserves audit symmetry (both pages
list the counterpart, both `Compare Notes` columns carry the verdict
line) so neither side surfaces as "never compared" when it has been.

The pattern: the consumer issues up to two `pages.update` calls, one
per side, with the rate-limit middleware (`src/notion/rate-limit.ts`)
governing concurrency. Failure of the second write leaves a visible,
re-runnable inconsistency rather than a silent half-state.

**Retry-safety is ledgered for actionable verdicts.** A
`lore-memory action='compare'` call runs three concerns:
idempotency gate → dispatch (fact emission + confidence decrement for
actionable verdicts) → audit-marker write. Final audit entries and
dispatch ledger entries both live in `Compare Notes`, but they are
different NDJSON shapes:

- Final audit line fields: `verdict`, `target`, `affected`, `reason`,
  `judgedAt`, and `promptVersion`.
- Dispatch ledger line fields: `entryType`, `dispatchKey`, `step`,
  `verdict`, `source`, and `affected`; `step` is `confidence_decrement`.

`hasMatchingCompareNote` ignores ledger lines, so only final audit
lines can make the pair "already judged." `hasCompareDispatchLedgerEntry`
is the proof that the non-idempotent confidence decrement already
landed.

`MemoryService.recordCompared` itself is **per-side idempotent**:
each side's `pages.update` is gated locally by
`hasMatchingCompareNote` against the loaded snapshot, so a side whose
final audit entry already landed on a prior call is skipped. The MCP
handler checks BOTH sides for every verdict (including
`conflicts_with` / `supersedes`) and short-circuits only when both
sides already carry the final audit entry. This lets one-sided
audit-marker failures repair on retry.

The retry matrix:

- **Symmetric verdict (`scoped` / `related` / `compatible` /
  `not_conflict`) — audit-marker only, no dispatch.** Safely
  retried by re-issuing `lore-memory action='compare'` with the
  same inputs. The handler-level gate checks BOTH sides for the
  matching `(target, verdict, affected=null)` entry; it
  short-circuits with `alreadyJudged: true` only when both sides
  already carry the entry. If only one side is present (the prior
  call's `Promise.all` had one success and one failure), the gate
  clears and `recordCompared` runs again — its per-side
  idempotency skips the side that already landed and writes the
  missing side. The handler's overflow preflight mirrors the
  per-side skip: a side that already carries the entry is NOT
  preflighted (it won't be written this call), so a near-cap
  already-written side cannot block the missing side's repair.
  The response surfaces `recoveredSide: "A" | "B"` so the agent
  can tell the operator that the pair's audit state is now
  consistent.
- **Actionable verdict (`conflicts_with` / `supersedes`) —
  dispatch landed, audit-marker failed.** Safely retried by
  re-issuing the same compare call. The affected memory's
  `compare_dispatch` ledger marker is written in the SAME
  `pages.update` as the `Confidence Score` decrement. If Notion
  applied that update but the SDK reported failure, the retry sees
  the marker and skips a second decrement. If the update never
  landed, the marker is absent and the retry applies the decrement
  once. `recordCompared` then catches up whichever final-audit side
  is missing.
- **Actionable verdict — legacy one-sided audit from before the
  dispatch ledger existed.** A final audit line on either side is
  treated as proof that the old destructive dispatch already landed,
  because `recordCompared` runs after fact emission and confidence
  decrement. If one final audit side exists but the affected memory
  lacks a `compare_dispatch` ledger, the handler repairs in place by
  appending the ledger without another decrement, then lets
  `recordCompared` catch up the missing final-audit side. If the
  affected side already had the final audit line, `recordCompared`
  uses its force-write path to persist only the ledger on that side
  and does NOT append a duplicate final audit line.
- **Actionable verdict — partial dispatch (helper raised
  `CompareDispatchPartialFailureError` mid-step).** The same-input
  retry is safe. For `step="supersede"` on a `supersedes` verdict,
  `decisions.supersede` is idempotent on relation-set semantics, so
  the retry completes the missing `supersedes_decision` fact and then
  the ledgered confidence decrement. For `step="fact"`, the fact
  create dedupes by triple hash and the confidence decrement is
  protected by the dispatch ledger. The error message still embeds
  `factId`, `affectedMemoryId`, and `dispatchKey` so repeated failures
  remain diagnosable.

Compare remains a single-agent serial workflow. Actionable verdicts
now write `Compare Notes` twice on the affected side (dispatch ledger,
then final audit), and both writes are still based on the snapshot
loaded at the start of `handleCompare`. A concurrent compare touching
the same memory can clobber a `Compare Notes` append in that window.
The lock posture is unchanged: no cross-process compare lock exists
today, so callers should keep compare writes on the same memory pair
serialized rather than weakening the retry ledger semantics.

Do not collapse to one write; do not switch to `dual_property`
without migrating every existing self-relation column in lockstep —
`Supersedes` and `Affects` follow the same `single_property`
posture, and a mixed-shape Memories DB would surprise every
consumer reading the relation.

A future Notion API addition of true `dual_property` self-relations
(auto-mirrored at the data layer) would let consumers drop the
explicit second-write call. Until then, two writes is correct.

## Topic-key re-keying (`MemoryService.rekeyTopicKey`)

`rekeyTopicKey` (0.9.0/#14) is the conservative repair path for
the topic-key upsert chain. An agent that picks the wrong topic
key on first save can switch to the canonical key without
abandoning the row. Re-keying is **identity surgery, not content
evolution** — the implementation pins three load-bearing
distinctions:

- **`Revision Count` is NOT bumped.** Revision Count tracks
  topic content evolution across `lore-memory action='save'`
  upserts. Re-keying changes the row's identity slot, not its
  content. Bumping the counter on re-key would conflate identity
  events with content events; downstream renderers that
  distinguish "this topic has been refined N times" from "this
  topic has been re-keyed once" would lose the signal.
- **`Last Referenced At` is NOT touched.** Re-keying is a write,
  not a read citation, same posture as #06's upsert. A re-key
  followed by a `lore-query action='recall'` should bump the
  read clock; the re-key alone should not.
- **Audit block prefix is `## Re-keyed (date)`**, distinct from
  #06's revision-block prefix `## Revision N (date)`. The two
  prefixes are the parseable signal that lets a future
  memory-history renderer separate identity events from content
  events without parsing body text. A future contributor
  tempted to "unify the prefixes" would silently break that
  signal.

**Validation is fail-fast and single-call-atomic.** Three guards
fire BEFORE any Notion mutation, so a rejected call leaves the
row entirely untouched:

1. **No-op short-circuit.** Re-keying to the existing value is
   a user-error, not an invariant violation. The helper
   responds truthfully (`oldTopicKey === newTopicKey` in the
   return shape) but issues zero Notion calls — no
   `dataSources.query` for collision check, no
   `pages.updateMarkdown`, no `pages.update`. Callers that
   want to render a "no-op" footer compare the two fields in
   the result.
2. **Empty-set guard.** A memory with no projects has no
   `(Topic Key, Project-set)` identity slot to re-key into.
   Topic-key identity is project-set-keyed (mirrors #06's
   upsert path); rejecting empty-projectIds is structurally
   correct rather than arbitrary.
3. **Collision check.** The new key must not already map to
   another live memory in the same project-set. The check
   delegates to `findByTopicKey` (which is deliberately
   Kind-agnostic — see its docstring), so a re-key onto a slot
   held by a task or decision under the same key surfaces as a
   collision. The error names the colliding memory's ID so the
   operator can act on it directly. Lore does NOT auto-merge
   two topic chains; merge policy is non-trivial. Which
   `Revision Count` survives? Whose title or `Confidence Score`?
   0.9.0 declines to invent that policy.

**Skip-self in collision check.** A memory whose `Topic Key`
already equals `newTopicKey` would otherwise self-collide. The
no-op short-circuit at step 1 catches the case where the OLD
key already matches; the explicit `collision.id !==
input.memoryId` guard inside step 3 catches the
eventual-consistency window where `findByTopicKey`'s post-write
index lag could surface the same row. Defense in depth —
neither guard alone covers both cases.

**Property write FIRST, audit-block append SECOND.** The
reverse order (audit then property) was the original spec but
creates a worse partial state on a transient failure: an
audit-write success followed by a property-write failure
leaves the body falsely claiming a re-key while the property
holds the old key, AND a retry would append a SECOND audit
block before the property write could succeed. With
property-first, the failure modes are:

1. **Property write fails.** Nothing was written. The memory
   is unchanged. A retry runs the full pipeline cleanly. The
   thrown error is the underlying Notion error, not a
   `RekeyAuditError`.
2. **Property write succeeds, audit append fails.** The
   re-key persisted (the load-bearing identity change). Only
   the cosmetic audit trail is missing. A retry observes
   `oldTopicKey === newTopicKey` and short-circuits through
   the no-op guard without re-attempting the audit. The audit
   block is permanently lost — but the row's structural state
   is correct and self-consistent. The thrown error is a
   `RekeyAuditError` carrying `memoryId`, `oldTopicKey`,
   `newTopicKey`, and `cause`, so callers can distinguish "re-key
   didn't happen" from "re-key happened but audit is missing."

`RekeyAuditError` is a named subclass of `Error` exported
alongside `MemoryService` from `src/core/memory.ts`. The MCP
layer's `toolError` rendering surfaces the message verbatim;
future operator tooling can `instanceof RekeyAuditError` to
branch on the partial-state case.

**Body write uses `replace_content` with `new_str`.** The
markdown is read first via `pages.retrieveMarkdown` (inside
`getById`), the audit block is concatenated, then the full
body is rewritten via the same `replace_content` path that
`MemoryService.update` uses for content edits. Concurrent
re-keys against the same memory could race past each other
and clobber each other's audit blocks — same posture as #06's
documented concurrent-upsert risk, fixed if real-vault data
shows the race matters.

**Property update is partial.** The `pages.update` call writes
ONLY `Topic Key` (not `Revision Count`, not `Last Referenced
At`, not `Title`). A direct partial-property update — not a
`buildMemoryProps`-mediated write — keeps the title cache
undisturbed and the system-managed columns untouched. Test
fixtures pin the exact key set so a future "always re-write all
properties" refactor can't silently bump the counter.

The MCP dispatch layer (`src/mcp/tools/memory.ts:handleUpdate`)
is responsible for five contract details that don't belong in
the service helper:

- **Reject `topicKey + kind` BEFORE any I/O.** Re-keying
  preserves the upsert-chain identity (kind is part of
  identity); a combined `topicKey + kind` update would smuggle
  a kind change through the residual update path and silently
  split the chain across two kinds. The handler throws at the
  boundary; the service helper never sees the combined input.
- **Preflight the re-key BEFORE applying any content delta.**
  Calls `MemoryService.validateRekey` to validate non-empty
  `projectIds` and no collision under the current project set
  against the pre-update memory state. If preflight rejects, it
  throws cleanly before the content update runs, so the operator
  never sees a half-persisted state for the common
  collision/empty-projectIds failure modes. The
  preflight is non-mutating: one `getById` plus (only when the
  new key differs from old) one `dataSources.query`.
  `validateRekey` is exported as a service method so direct
  callers (operator tooling, future MCP surfaces) can perform
  the same pre-flight check without duplicating the validation
  logic. The post-preflight `rekeyTopicKey` call still re-runs
  the same validation as the authoritative pass.
- **Apply content delta BEFORE re-key when both are present.**
  `MemoryService.update`'s body write is a full-body
  `replace_content`. Running re-key first and content update
  second would silently clobber the audit block the re-key
  just appended. The handler dispatches `services.memories.update`
  first, then `services.memories.rekeyTopicKey` — making the
  audit-block append the LAST write to the body and structurally
  immune to clobbering. The combined-update test pins this order
  via call-tracking AND a stateful integration fixture verifies
  the final body contains both writes.
- **Wrap post-update re-key failures in `PartialUpdateError`.**
  Even with the preflight, the post-content-update re-key can
  reject (a race with another agent grabbing the slot, a
  transient Notion property-write failure, or a content delta
  that changed `projectIds` and exposed a fresh collision under
  the post-update set). When that happens AND a content delta
  has already landed, the handler throws a `PartialUpdateError`
  whose message names the partial state explicitly — content
  update persisted, re-key did not. Operators get a clear
  signal rather than a generic failure; future tooling can
  branch via `instanceof PartialUpdateError`.
  `PartialUpdateError` is the inverse of `RekeyAuditError`
  (which signals "re-key persisted but audit missing"); the two
  errors describe two distinct partial-state shapes.
- **Skip `services.memories.update` on a pure re-key.** When
  `topicKey` is the only non-framing field (no title/body/tags
  /etc.), the handler must NOT call the general-purpose update
  service path — that would issue a no-op `pages.retrieve` and
  surface no signal but burn round-trips. The handler
  destructures the framing fields (`action`, `memoryId`, `topicKey`)
  and gates the residual update on whether `contentDelta` has any
  defined value.

**No-op acknowledgment in the response.** When the preflight
returns `willRekey: false` (the new key matches the existing
one), the handler skips `rekeyTopicKey` entirely and surfaces a
`Topic key unchanged: '<key>' (no-op).` line in the response.
Silent suppression would leave the operator wondering whether
the re-key was honored or dropped; the explicit acknowledgment
closes the audit gap without writing to Notion.

## Pinned context blocks (`MemoryService.listPinnedBlocks` / `countPinnedBlocks`, issue #282)

`MemoryService` is the public facade for pinned context blocks, but the
pinned-specific implementation lives in `src/core/memory-pinned.ts` as
`MemoryPinned`. Keep read-only update preflight, hard-cap enforcement,
the pinned-count cache, `listPinnedBlocks`, `countPinnedBlocks`, and
pinned helper exports (`MemoryReadOnlyError`, `MemoryPinCapExceededError`,
`pinnedBlockAudienceMatches`, `clampPinnedPriority`) on that sibling.
`src/core/memory.ts` re-exports the public helpers for existing callers.

Pinned context blocks are a constrained Memory facet that renders
in `lore-context action='wake-up'` BEFORE every relevance-ranked
section. Three additive Memory columns (`Pinned`, `Pinned Priority`,
`Mutability`) plus the reused `Audience` rich_text from #283 carry
the state; the wake-up renderer composes them into the `## Pinned
Context` section.

**`listPinnedBlocks` composes the #283 default scope filter.** The
server-side filter narrows to `Pinned = true` plus project
inclusion plus the #283 broadcast/narrow scope-kind OR-clause and
expiry-not-passed clause; the matching client-side
`matchesDefaultScope` mirror runs inside the `collectLivePages`
`extraFilter` so the kind+key binding (which Notion's 2-level
compound-filter cap can't express) is enforced row-by-row during
pagination. **Audience matching also runs inside `extraFilter`** so
the walker over-fetches and backfills when the top-priority slice
targets other audiences. Both filters live in the pagination loop,
NOT as post-materialization filters — the earlier shape that
applied audience after slicing to `limit` could starve matching
pins.

**Audience is render metadata, not authorization.** Lore writes
through one operator bearer token; `pinnedBlockAudienceMatches` is
the comma-split + case-fold + exact-match against the reader's
`MemoryScopeContext` slots (`agent` / `role` / `userId`). Universal
tokens (`all` / `*` / `everyone` / `agents`) bypass the slot check.
The MCP / CLI `audienceFilter` option (default `true`) is the
explicit opt-out for operator inspection across audiences — an
empty `readerContext` alone is NOT enough because the matcher
rejects narrow tokens when no reader slot is populated.

**Mutability enforcement is at the service-layer `update` preflight.**
`MemoryService.update()` runs one `pages.retrieve` on every call and
throws `MemoryReadOnlyError` when `Pinned = true` AND
`Mutability = read-only` AND `allowReadOnlyUpdate !== true`. The
extra round-trip per update is the cost; the alternative (gate only
at MCP) would let CLI / hooks / future surfaces bypass the contract.
The override is a stop-sign visible in the audit trail, NOT an
access-control gate — Lore uses one operator token so any MCP
caller can flip `force: true`; every forced write lands a
`> Forced read-only update` audit line on the memory body via
`appendPinAuditLine` in `src/mcp/tools/pinned.ts`.

**`countPinnedBlocks` backs both the abuse-warning gate and the
hard pin-creation cap.** Server-side count via `Pinned = true`
(no audience / scope filter — operators see the TOTAL pinned-row
count even when most are out-of-scope or out-of-audience for the
current reader). Two thresholds, two responses:

1. **Soft abuse warning at `PINNED_BLOCKS_ABUSE_THRESHOLD` (100).**
   The wake-up renderer compares the total against this constant
   and appends an inline operator warning when the count crosses.
   Pinning is NOT blocked at this threshold — the warning is the
   surface that exposes the abuse signal alongside the visible
   blocks.
2. **Hard pin-creation cap at `PINNED_BLOCKS_HARD_CAP` (200).**
   `handlePin` in `src/mcp/tools/pinned.ts` runs a precheck against
   the current total and rejects un-pinned → pinned transitions
   with `PinnedCapExceededError` when crossing the cap.
   `MemoryService.update` mirrors the gate (`MemoryPinCapExceededError`)
   so non-MCP callers (CLI, hooks) hit the same wall.
   `bypassPinCapCheck: true` opts the service-layer check out for
   the MCP handler's already-prechecked call to avoid double-counting.

A malicious caller pinning many rows pushes legitimate governance
out of the visible cap via priority pressure; the soft warning
surfaces the signal at 100 and the hard cap stops uncontrolled
growth at 200.

**Pre-migration vaults degrade gracefully.** `listPinnedBlocks` and
`countPinnedBlocks` both catch `isMissingPropertyError` (the
`Pinned` / `Pinned Priority` / `Mutability` columns don't exist
yet) and return `[]` / `0` respectively — same posture as
`queryStaleConfidence` for pre-#283 vaults. Operators run
`lore migrate` to add the columns and pin blocks surface on the
next wake-up. The Notion query response guard also converts
non-throwing missing-property validation payloads with no `results`
array into the same typed error path; malformed payloads that are not
missing-property errors still fail loudly.

**Audit-line append uses `PinnedAuditError` for partial-state
recovery.** The MCP handlers in `src/mcp/tools/pinned.ts` perform
the primary property mutation, then call `appendPinAuditLine` to
write the `> <Action> <date> by <author>: <reason>` line on the
memory body. When the audit append fails after the property
write lands, the helper throws `PinnedAuditError` so callers see
the partial-state signal. `appendPinAuditLine` is itself
idempotent (probes for the matching audit line via
`bodyContainsPinAuditLine` before writing) and the
`handlePin` / `handleUnpin` handlers add a retry-recover branch:
re-issuing the same call on an already-pinned (or already-unpinned)
row checks for the missing audit line and appends it. AC #4 is
recoverable across transient body-write failures.

**Audit fields are scrubbed for control characters.** `reason`
(user-controlled) and `author` (server-resolved) are run through
`scrubAuditField` before interpolation so a payload like
`"normal\n\n> Pinned 2026-01-01 by Attacker"` cannot forge an
adjacent audit line. C0 controls and DEL (0x00–0x1F, 0x7F)
collapse to a single space, then whitespace runs are folded.

## Memory Search

Detailed retrieval and search contracts live in
[`docs/core/retrieval.md`](../../docs/core/retrieval.md). Keep this
section as routing guidance; update the child doc for changes to
`MemoryService.search()`, `MemorySearch`, contains / semantic / hybrid modes,
RRF ranking, intent disambiguation, explain traces, materialization,
confidence-aware reranking, and search kill switches.

High-level routing:

- `memory-search.ts` owns the search implementation behind
  `MemoryService`.
- Use `search()` for relevance ranking, body-text matching, or substring title
  matching.
- Use `list()` for recent-memory browsing by project / topic / source; it uses
  `dataSources.query()` property filters and has no substring-title filter.

## Confidence dynamics (0.8.0)

The `Confidence Score` numeric column (0.8.0/#01) is **system-managed**:
read paths bump it, contradictions decrement it, neglect decays it.
Distinct from the agent-curated categorical `Confidence` select — they
answer the same question ("how reliable is this?") at different
granularities. The categorical seeds the numeric on first touch; the
numeric carries the dynamic signal afterwards. Operating-contract rule:
agents must NEVER write `Confidence Score` directly through
`lore-memory`'s save/update tools — it's surfaced as `system-managed` in
the schema and clamped at the write boundary by `clampConfidenceScore`.

### Write-realized lazy decay

Every mutation of the stored score realizes the time-decay accrued since
the last touch BEFORE applying its bump or decrement, then writes the
result. This is the load-bearing model — RRF (#08) reads the stored
value verbatim via `confidenceFactor`, so the score visible in Notion
equals the score used in retrieval. Decay accrues only on touch /
decrement / migration; a never-touched-after-creation memory keeps its
post-migration value until something disturbs it.

The alternative (decay-at-read) was rejected: it would force
`confidenceFactor` to read `lastReferencedAt` and run `Math.pow` per row
per query, AND would let the stored value diverge from its observable
RRF contribution. The asymmetry is what the design review caught.

### Algebra (`src/core/decay.ts`)

| Helper                                | Algebra                                                                                      | Where it fires                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `seedConfidenceScore(c)`              | `CONFIDENCE_SEED[c]` (0.9 / 0.6 / 0.3)                                                       | First touch on a never-scored row; bulk migration                                                        |
| `bumpConfidenceScore(s)`              | `s + (1 − s) * BUMP_RATE` (`BUMP_RATE = 0.05`)                                               | After decay realization, on every read-citation                                                          |
| `decrementConfidenceScore(s)`         | `s * DECREMENT_FACTOR` (`= 0.5`)                                                             | After decay realization, on `lore-memory action='compare'` asymmetric verdicts and decision supersession |
| `decayConfidenceScore(s, ref, today)` | `s * DECAY_RATE^max(0, days − STALE_CONFIDENCE_DAYS)` (`DECAY_RATE = 0.99`, grace = 60 days) | In-flight on every touch / decrement / migration                                                         |
| `confidenceFactor(s)`                 | `CONFIDENCE_FACTOR_MIN + (1 − CONFIDENCE_FACTOR_MIN) * s`, null → 1                          | Read-side, in RRF accumulator (#08)                                                                      |

The asymmetry — slow recovery (BUMP_RATE = 0.05), slow decay (DECAY_RATE
= 0.99 per stale day), aggressive contradiction (DECREMENT_FACTOR = 0.5)
— is deliberate and reflects relative signal quality. A single citation
is weaker evidence than 30 days of neglect; a contradiction is high-
quality negative evidence on a single explicit signal. All four
constants live in `src/types.ts` for cross-module visibility.

### I/O wrappers (`MemoryService.touchOnRead` / `decrementConfidence`)

Both wrappers seed-decay-then-mutate when `confidenceScore === null` so
a pre-migration read followed by a `lore migrate
--build-confidence-scores` re-run produces the same value as the
migration alone. Without this convergence, a never-scored 200-day-old
row read pre-migration would seed fresh at 0.9, the migration would
skip it as "already scored", and 200 days of accrued decay would be
permanently lost.

`touchOnRead` short-circuits per-row when `lastReferencedAt === today
&& confidenceScore !== null` — same gate as the column write,
intentionally bump-once-per-day. Failures route through `onError` and
degrade to a no-op for that row; the caller's read result is always
preserved. `touchOnRead` is advisory, never blocking.

`decrementConfidence` writes `Last Referenced At = today` alongside
the score decrement so a heavily-contradicted memory doesn't
double-count the negative signal: contradiction IS a form of cite
(negative cite), so it resets the decay clock; the explicit decrement
provides the negative signal.

Both wrappers issue exactly one `pages.update` per affected memory.
Notion has no batch-update primitive; per-call concurrency is bounded
by the rate-limit middleware (`src/notion/rate-limit.ts`), tunable via
`notion.rateLimit.concurrency` in `.lore.yaml`.

### Stale Confidence wake-up subsection (#10)

`MemoryService.queryStaleConfidence` backs the
`### Stale Confidence` subsection on `lore-context action='wake-up'`
— a triage view for memories that need attention, surfaced via either
of two OR-branches: `Confidence Score < CONFIDENCE_DISPLAY_THRESHOLD`
**OR** `Last Referenced At` past `STALE_CONFIDENCE_DAYS` days. The
neglect-OR clause is load-bearing under write-realized lazy decay
(see above): a memory cited 6 months ago at score 0.9 keeps stored 0.9
and ranks high in RRF until something disturbs it; the neglect branch
is what surfaces it for triage. Reading the row via `lore-memory
action='expand'` realizes the accrued decay through `touchOnRead`'s
decay-then-bump path.

**Pre-migration vaults render an empty section.** The query's
`Confidence Score is_not_empty` guard rules pre-0.8.0 rows out of
BOTH OR-branches (a null score can't satisfy `< threshold`, and the
AND-wrapped guard rules out the neglect branch too). The section
populates only after `lore migrate --build-confidence-scores` (#11)
seeds scores on existing rows, or after read paths organically touch
them via `touchOnRead`. This is the correct behavior — the section
flags "things the system has decided need triage," and "no scores
yet" is honestly an absence of decision, not a decision-of-stale.
Operators who want the section populated on day one run #11.

**Rows in this section are NOT touched.** The MCP renderer
(`handleWakeUp` in `src/mcp/tools/context.ts`) deliberately excludes
stale-confidence rows from the `touchOnRead` batch. Same posture as
Decisions Requiring Attention: the rows surface BECAUSE they need
triage, and bumping the score / resetting `Last Referenced At` on
every wake-up that lists them would mask the very signal that put
them here. The agent acts on a row by reading it via `lore-memory
action='expand'`, at which point `touchOnRead` fires through the
correct read-path wrapper.

## Fact Invalidation

Facts are never deleted. To mark a fact as no longer true:

```typescript
await factService.invalidate(factId)
```

This sets the `Valid Until` property to today's date. Default queries exclude
facts where `Valid Until` is set (the `is_empty` filter).

To include invalidated facts in a query, pass `includeInvalidated: true`:

```typescript
const allFacts = await factService.queryBySubject("AuthService", {
  projectId,
  includeInvalidated: true,
})
```

**Rule**: Never use `pages.update({ archived: true })` on facts. Archiving
removes the page from all queries. Invalidation preserves historical record.

## Fact Queries

The `FactService` exposes two families of reads: targeted retrieval
(paginates as needed) and hot-path listing (single page, returns saturation
signal). All methods exclude invalidated facts by default.

### Retrieval (paginating)

| Method                          | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `queryBySubject(subject, opts)` | Finds facts where `Subject` title contains the string; paginates until exhausted or `limit` is reached. Strict-empty `subject` (`""`) returns `[]` unless `opts.allowUnfiltered: true`; punctuation/whitespace-only inputs (`"."`, `"   "`, `"!!!"`) pass through as literal substring filters per the SubjectKey-suppression test (issue #481)                                                                                        |
| `queryByObject(object, opts)`   | Same shape as `queryBySubject` but matches the `Object` rich-text property. Same strict-empty `allowUnfiltered` gate                                                                                                                                                                                                                                                                                                                   |
| `queryBySourceMemory(id, opts)` | Finds facts whose `Source` relation points at a given memory page                                                                                                                                                                                                                                                                                                                                                                      |
| `queryByEntity(entity, opts)`   | Finds facts where the entity appears as either Subject or Object, deduplicates. `limit` is forwarded into both underlying branches as a `page_size` clamp + early-stop, then re-applied as a post-dedup slice so `limit: 25` never returns more than 25 rows. Empty / whitespace-only `entity` short-circuits to `[]` unconditionally (no `allowUnfiltered` opt-in — agents have no use case for whitespace-substring entity matching) |
| `queryOrphans(opts)`            | Returns current facts whose `Source` relation is empty. Used by `lore migrate --backfill-fact-sources`                                                                                                                                                                                                                                                                                                                                 |

All paginating retrieval methods derive their per-request `page_size`
via the shared `clampNotionPageSize(limit)` helper in `fact.ts` —
unlimited (`undefined`) → 100; bounded → `min(max(limit, 1), 100)`.
A new retrieval method should reuse it rather than re-inlining the
arithmetic; the verbose `Notion` prefix marks it as Notion-specific
and not a general clamp utility.

### Hot-path listing (single page)

| Method             | Behavior                                                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `listRecent(opts)` | Single-page, server-filtered `created_time desc`. Returns `{ items, hasMore }` so callers can detect truncation without a second round-trip. |

### Writes on existing facts

| Method                          | Behavior                                         |
| ------------------------------- | ------------------------------------------------ |
| `extendReview(id, reviewBy)`    | Set, advance, or clear the `Review By` date      |
| `invalidate(id)`                | Mark no-longer-true (sets `Valid Until` = today) |
| `setSource(id, sourceMemoryId)` | Overwrite the `Source` relation with one memory  |

### Recent knowledge facts on the wake-up hot path

`loadWakeUpData` calls `listRecent({ projectId, limit: knowledgeLimit })` to
populate the Active Facts section. The query is single-page and server-side
filtered by project scope + `Valid Until is_empty`, so wake-up never paginates
on session start.

Tracked work — open / blocked / done lifecycle — is served by `lore-task
action='list'` against the Memories DB rather than by a fact partition.
Pre-#23 (0.6.0) wake-up additionally split tracking-predicate facts off
into an Open Loops section; that surface is gone, the `FactPredicate` union
no longer carries those values, and `pageToFact` filters historical rows
in Notion so they cannot resurface as live `Fact` objects on read paths.

### `pageToFact` / `pageToFactSync` filter historical tracking-predicate rows

`pageToFactSync` returns `Fact | null`. It returns `null` when the row's
raw `Predicate` select value is one of the historical tracking strings
(`needs_action` / `waiting_on` / `blocked_by`). Notion's schema is
additive-only (`src/notion/setup.ts`), so those select options stay
registered and historical rows still exist for vaults that skipped the
`--migrate-tracking-to-tasks` migration before upgrading to 0.6.0.
Filtering at the deserialization boundary keeps the pre-#23 read shape
intact (`FactService.queryBySubject` etc. return `Fact[]`, not
`Fact | null[]`).

`pageToFact` (single-row, async) and `pageToFacts` (result-set, async)
both delegate to `pageToFactSync` after their hydration step. Result-set
callers route through `pageToFacts` so relation-property hydration runs
in one batched `p-limit(3)`-gated call (via
`hydrateRelationPropertiesForPages`) and the historical-tracking
`null`-drop happens once on the hydrated set. Single-row callers
(`getById`, `lookupByDedupKey`) and outer-loop iterators that genuinely
process one row per outer page (`queryOverdue`, `listAllForBackfill`)
keep the per-page `pageToFact` path — there is no result set to batch.

`FactService.countByPredicateRaw` deliberately bypasses this filter and
walks `response.results.length` directly so the `lore status` preflight
keeps counting the orphan rows after the typed-union contraction. See
its docstring for the double-back-door rationale.

## Entity Resolution and the SubjectKey / SubjectEntity coexistence (PF3-01)

The Facts DB carries two parallel canonicalization columns by design:

| Column                           | Type                | Role                                                                                                                                                                                                                                                           |
| -------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SubjectKey`                     | rich_text           | Lowercased + NFC + whitespace-collapsed + trailing-punct-stripped form of `Subject`. Populated by `FactService.create` and the `--dedup-keys` migration. Backs the substring-fallback path in `queryBySubject` for vaults that haven't run `--build-entities`. |
| `SubjectEntity` / `ObjectEntity` | relation → Entities | Canonical entity row IDs. Populated by `lore-fact action='create'` after `EntityService.resolveOrCreateEntity` and by the `--build-entities` migration. Backs exact `queryByEntityId` recall once a row has been re-pointed.                                   |

Why both columns coexist for one release cycle:

1. **Transition-window recall.** `queryByEntity` runs both paths in
   parallel when `entityId` resolves: the relation hit + the substring
   hit on rows whose entity relations are still empty (i.e. rows
   `--build-entities` hasn't re-pointed yet). Dropping `SubjectKey`
   immediately would silently lose every un-backfilled row from
   `lore-query action='ask'` results.
2. **Spec carve-out.** The PF3-01 spec explicitly says "Keep the
   column for one release cycle as a safety net, then drop in a
   follow-on cleanup." A separate issue tracks `SubjectKey` removal.

Read paths must therefore handle two row states: unbackfilled Facts with
empty entity relations and backfilled Facts with canonical relation ids.
`queryByEntity`'s union semantics cover both; `pageToFact` populates
`subjectEntityId`/`objectEntityId` from the relation column when present
and falls through to `null` otherwise.

`EntityService`'s name/alias cache is a performance cache, not an
authority. Cache hits re-read the cached page before returning it so a
long-lived MCP or hook process does not keep handing out an Entity row
that another process archived during `lore entities merge`. If the
cached row is archived (or no longer carries the lookup key), the
service evicts the stale keys and falls back to the normal Notion query
path, which lets the loser's alias resolve to the merge winner.

Entity merges and relation-bearing fact writes also share a filesystem
lock keyed by Entity id (`entity-relation-lock.ts`). `mergeEntities`
holds the loser lock from the first repoint through the post-archive
scan; `FactService.createWithDedup` holds locks for incoming
`SubjectEntity` / `ObjectEntity` ids and revalidates those pages while
inside the lock, dropping archived ids before it writes. That pair is
what closes the cross-process stale-cache window: a writer that
resolved the loser before the merge waits, then refuses to write the
archived loser relation after the merge releases the lock.

### Measuring whether `--build-entities` collapsed the orphan graph

The PF3-01 spec's flagship acceptance criterion is "post-migration,
the orphan-rate metric (`subjects appearing in exactly 1 fact`) drops
from 79.6% to <50% on an internal vault." The migration ships with
case-folding-only canonical clustering — `computeSubjectKey` collapses
case/whitespace/trailing-punct variants but does NOT recognize that
`MemoryService.create` is a richer-handle variant of `MemoryService`
or that `PR #1234 (SENTRY-APP-2E3)` is metadata-tagged onto the
same `PR #1234` entity. The next contributor evaluating whether to
ship a richer canonical clusterer needs to be able to compute this
metric without re-deriving the methodology.

**How to compute the metric** post-migration:

1. Snapshot every live fact:
   `dataSources.query` against the Facts DS, filter `Valid Until is_empty`,
   paginate to exhaustion. Project-scoped or vault-wide depending on
   what the spec criterion measures (internal vault is project-scoped).
2. Group by canonical entity. The post-migration row's
   `SubjectEntity` relation IS the canonical key — empty relations
   mean the row hasn't been re-pointed (either pre-migration or a
   transient migration miss). For the metric, **count rows by
   `SubjectEntity[0]?.id ?? computeSubjectKey(Subject)`** so
   un-migrated rows still cluster by their case-folded form.
3. Compute `1 - groups_with_count >= 2 / total_groups`. The
   numerator is groups with at least one peer; the denominator is
   total distinct entities/keys. Pre-PF3-01 baseline on an internal vault
   was 79.6% (560 facts → ~445 distinct subjects → ~89 had a peer).

The metric is wired through
`lore migrate --build-entities --report-orphan-rate` (issue #542).
Two execution paths share one fold:

- `src/core/entity-migration.ts:foldOrphanRateGroups` — the shared
  spec implementation (`subjectEntityId ?? computeSubjectKey(subject)`
  keying; `1 - groups_with_count >= 2 / total_groups`).
- `computeOrphanRateFromFacts` (default JS enumeration path —
  walks every fact via `FactService.queryBySubject`).
- `computeOrphanRateFromAggregateRows` consumes the rows
  `src/notion/runtool/query.ts:querySubjectGroupCountsViaRunTool`
  emits when `LORE_USE_RUNTOOL_AGGREGATE=1` is set. The flagged-on
  path falls back per-call to the JS path on capability gate
  (403), saturated `has_more: true` aggregate windows, malformed
  responses, or transient transport-class failures. A 400 /
  `validation_error` re-throws so query-shape drift surfaces
  loudly. Read-only — does not affect the migration's plan/apply
  behavior.

The wired metric counts every fact in scope, NOT just live ones.
Notion's SQL gateway does not expose date columns
(verified 2026-05-06: `Valid Until` / `validUntil` / `valid_until`
all fail with `no such column`), so the SQL aggregate path can't
filter invalidated facts server-side. The migrate-time call site
keeps the JS fallback semantically equivalent by passing
`includeInvalidated: true` to `queryBySubject`. Operationally the
question (does case-folding canonicalization collapse the graph
below 50%?) is unchanged — invalidated facts contributed subjects
to the canonical grouping just like live ones did. Operators
running the metric manually against the spec's "live only" wording
can read off the JS output (still emits the count of facts inspected
including invalidated) and adjust if precise live-only numbers are
ever required.

The `factCount` field on each `EntityGroupPlan` is still available
as a planning-time sanity check; the report adds the post-pass
metric so operators can confirm the <50% threshold has landed
without re-running the numbers manually.

If the metric stays above 50% on a real vault after `--yes`, the case-
folding pass alone wasn't enough — the richer-vs-bare clusterer becomes
load-bearing and the spec's deferred follow-up needs to land. If the
metric drops below 50%, case-folding was sufficient and the deferred
clusterer can be skipped or scoped down to operator-curated alias
merges via `EntityService.addAliases`.

## Fact Write-Side Dedup

`FactService.create()` and `createWithDedup()` both probe the `DedupKey`
column before writing. The key is a SHA-256 hash over
`normalize(subject) ␟ predicate ␟ normalize(object)` — see
`src/notion/normalize.ts`. Normalization folds case, whitespace, trailing
sentence-terminator punctuation, and Unicode NFC so cosmetic variants
resolve to one row. Hashing keeps the stored key at 64 chars regardless
of triple length, sidestepping Notion's 2000-char `rich_text` truncation.

The MCP layer owns the public provenance contract for
`lore-fact action='create'`: it validates usable source provenance before
calling `FactService.createWithDedup`. Internal callers that create facts must
still thread the originating memory id deliberately; current decision auto-edge
and memory auto-mention emitters pass `sourceMemoryId` explicitly.

- **Live match** → merge incoming metadata onto the existing row:
  - Extend `Review By` when the new request has a later date.
  - Union `projectIds` into `Project` (cross-project facts accumulate).
  - Link `sourceMemoryId` into `Source` only when the existing row is
    orphaned (first-writer-wins — does not clobber an earlier provenance
    link).
  - Fill `SubjectEntity` / `ObjectEntity` (PF3-01) with the canonical
    entity ids the upstream caller resolved, but only on sides whose
    relation is currently empty — same first-writer-wins posture as
    `Source`. Backfills legacy / partially migrated rows opportunistically
    on every dedup hit so the migration's coverage doesn't depend on a
    one-shot `lore migrate --build-entities` run capturing every row.
    All applicable mutations ship as a single atomic `pages.update` —
    Notion's API is per-request atomic, so either every mutated property
    lands or none does. A zero-mutation match (everything already present)
    issues no update at all.

  Returns `{ deduped: true, enriched: [...] }` where `enriched` names the
  fields that were mutated. An empty `enriched` array means the probe
  matched but nothing new was added — callers should render "matched,
  no-op" instead of implying a write.

- **Invalidated match** (`Valid Until` set) → deliberately ignored; the
  caller writes a fresh live row so history stays intact when a triple is
  re-asserted after correction.
- **Probe failure** → fall through to blind create with a once-per-process
  stderr warning (pre-migration vaults or transient Notion errors don't
  spam stderr on every autosave). The next
  `lore migrate --dedup-keys --merge` collapses the duplicate.

**Concurrency**: Notion has no unique index or conditional-write primitive.
Two callers racing on the same triple (cross-process, or intra-process
back-to-back autosaves — Notion's query index is eventually consistent by
a few hundred ms) can both see an empty probe. The
`lore migrate --dedup-keys --merge` pass is the authoritative collapse for
any duplicates that slip through. The pass prints the survivor/loser plan
by default; `--yes` is required to execute.

**Concurrency vs `lore migrate --build-entities`**: the migration's
`setEntityRelations` writes target the same `SubjectEntity` /
`ObjectEntity` columns as the dedup-fill above, and both paths resolve
canonical ids through `EntityService.resolveOrCreateEntity`. For a
stable entity name both produce the same id, so a race between an
in-flight migration and an opportunistic dedup-fill on the same row
converges on the same value — worst case is one redundant write of the
same id, never a re-pointed relation. Ambiguity short-circuits both
paths (the migration skips ambiguous groups; `handleLearn` omits the
entity id from the `CreateFactInput`, so the dedup-fill flag resolves
false and no entity write happens here). Operators do not need to
quiesce live writes before running `--build-entities`.

**Rule**: Callers that need to tell the user "this was a dedup, not a new
row" (for example, `lore-fact action='create'`) should use
`createWithDedup()` and inspect the `deduped` and `enriched` fields.
`create()` is preserved for callers that don't care (decision-graph
reachability sync, `decided_by` auto-links).

## HTML-entity Decode Migrations

The autosave path occasionally delivers plain-text fields with HTML
entities already escaped (`Foo &amp;amp; Bar`). Every write-boundary now
decodes via `decodeTextEntities` (`src/notion/html-entities.ts`), but rows
written before that guard shipped still carry encoded payloads. Three
`lore migrate` flags decode pre-existing rows in place — all idempotent,
all support `--dry-run`:

| Flag                    | Target                              | Module                                 | Apply mode                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------- | ----------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--fix-topic-encoding`  | Topics.Name                         | `topic-merge.ts:fixTopicEncoding`      | Applies unless `--dry-run`. Pair with `--merge-duplicate-topics` when cross-encoding pairs would collide post-decode.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `--fix-fact-encoding`   | Facts.Subject + .Object + .DedupKey | `fact-encoding.ts:fixFactEncoding`     | **Plan-only by default; `--yes` applies.** Collision-gated against post-decode dedup-key conflicts — see below.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `--fix-memory-encoding` | Memories.Title + body markdown      | `memory-encoding.ts:fixMemoryEncoding` | **Plan-only by default; `--yes` applies.** Skips archived memories. Bodies above `BODY_SIZE_CAP_BYTES` (100 KB) skip the canonical `replace_content` path by default; under `LORE_USE_RUNTOOL_BLOCK_EDIT=1` they're rewritten via the anchored `update_content` path when `EncodedMemoryRow.anchoredPathPlanned` is true (single-pass body with non-empty entity substitutions — issue #534 AC #5). Multi-pass bodies (`&amp;amp;`) and bodies whose substitution list is empty fall back to skip. Plan-mode preview reflects which oversized rows will be fixed via the new bucket `oversizedAnchoredPlanned`. |

The plan-then-execute posture on the fact and memory flags matches
`--dedup-keys --merge --yes`: both rewrite historical rows at larger blast
radius than the topic-name rename, and the dedup-key recomputation in the
fact path means a misapplied run can't be un-done by re-running. Bare
`lore migrate --fix-fact-encoding` prints the plan and exits; the operator
re-runs with `--yes` once they've reviewed the collision report.

Fact encoding is the subtle one. Decoding `Subject`/`Object` changes the
dedup key, so the rewrite path must recompute `DedupKey` in the same
`pages.update` atom as the Subject/Object write. Otherwise a future
`lore-fact action='create'` call with the already-decoded input misses the
probe and creates a fresh duplicate.

**Collision gate**. Before any Fact rewrite lands,
`findPostDecodeFactCollisions` groups every live row by its post-decode
dedup key. If a group has ≥2 rows — the cross-encoding case, where a
clean row and an encoded sibling would end up on the same key — `every`
member of the group is gated: the migration refuses to rewrite them and
directs the operator to resolve via `lore migrate --dedup-keys --merge
--yes` first. This mirrors the posture `VaultManager.migrate` established
for `--fix-topic-encoding` / `--merge-duplicate-topics`.

Ordering vs. downstream work: land encoding migrations before P2-03
(near-duplicate memory / decision detection), P3-03 (entity
canonicalization), and P3-04 (DS-scoped memory search). Those features
compare plain-text values, so an encoded Title inflates trigram distance
and silently suppresses duplicate detection.

## Agent Identity Canonicalization (PF3-02)

Memory `Agent` is a free-form `rich_text` column populated by
`deriveAgentName` in `src/hooks/helpers.ts`. Default detection produced
seven different spellings of the same Claude Code instance in the
internal vault (`Claude Code`, `claude-code`, `Claude Opus 4.7
(1M context)`, `Claude Code (Opus 4.7)`, `claude-opus-4.7`,
`claude-opus-4-7`, `claude-code-opus-4-7` — see PF3-02), fragmenting
per-agent grouping, retention queries, and dashboards across multiple
buckets per actually-distinct agent. The bare-version cousin
`Claude Opus 4.7` (no parenthetical) is pinned in
`agent-identity.test.ts` as the eighth — the regex grammar covers it,
so passing it through unchanged would re-fragment by one more spelling.

`canonicalizeAgentName` (`src/hooks/agent-identity.ts`) is the single
canonical-table source. It normalizes whitespace + hyphen separators to
spaces, lowercases for matching, and applies a structured Claude variant
regex. Match → `"Claude Code"`. No match → input passed through verbatim.
Idempotent.

The closed-table approach is intentional. The `LORE_AGENT_NAME` env
override (PF1-04) is the explicit-over-inferred path for third-party
integrators (Codex, Cline, Cursor, Aider). Their names don't match the
Claude regex and pass through unchanged, preserving attribution. Only add
to the canonical table when a new _default-detection_ variant appears in
the wild — i.e., another Claude string we ourselves produce.

Two ingest points:

- **Write-time** in `deriveAgentName`: both the override path and the
  Claude-marker inference path route their result through
  `canonicalizeAgentName` so newly-saved memories never re-fragment.
- **Backfill** via `lore migrate --normalize-agents`
  (`agent-normalization.ts:normalizeAgents`): scans every non-archived
  memory, rewrites rows whose stored Agent differs from its canonical
  form via `pages.update` on the `Agent` rich_text column. Plan-only by
  default; `--yes` applies. Idempotent; a second run finds zero rows.

**Agent column scope**: This canonicalization stops at the Agent string.
The version-suffix variants (`Claude Opus 4.7`) are deliberately collapsed
without a separate `Model` column — every observed variant resolves
cleanly to `Claude Code`, and a future query like "memories from Opus 4.7
sessions" can be served from `Keywords` until a real consumer demands it
(YAGNI). Resist the urge to add a `Model` field, an `Agent` enum, or a
separate Agents DB row in this issue.

**Future model families**: The regex closes around `code` and `opus`-versioned
spellings only. When Anthropic ships a Claude family Claude Code routes to
(Sonnet, Haiku, three-component versions like `4.7.1`), autosave starts
producing strings the regex _intentionally_ leaves unchanged — re-fragmenting
the Agent column. The extension recipe lives next to the regex in
`src/hooks/agent-identity.ts` (the JSDoc on `CLAUDE_VARIANTS`), with
companion no-match tests in `agent-identity.test.ts:future-families` that
have to be flipped in lockstep.

## Decision Service

`DecisionService` wraps the decision-specific read/write paths in the Memories
DB — pages where `Kind = decision`. It uses the same `DatabaseRef` as
`MemoryService` (they share the Memories DB) but exposes decision-flavored
methods. Pattern:

```typescript
const decisions = new DecisionService(client, db.memories)
```

Key behaviors:

- `create()` always sets `Kind = decision`, defaults `Status = accepted` and
  `Decided At = today` unless the caller overrides.
- `list()` and `queryOverdue()` skip markdown body fetches, returning
  `DecisionSummary[]` — O(1) API calls regardless of result count.
- `supersede(newId, oldId)` writes in a deliberate order: the new decision's
  `Supersedes` relation first, then the old decision's `Status = superseded`.
  If the second write fails, the system is in "new points at old; old still
  accepted" — a visible, re-runnable inconsistency. Reverse ordering would
  orphan the old decision as superseded with no successor. Do not change the
  order.
- `getDecisionChain()` uses a visited-set guard to terminate on cycles (a
  bidirectional supersession would otherwise loop forever).

**Rule**: `DecisionService` only writes to the Memories DB. It never creates
facts. The `decided_by` and `supersedes_decision` graph edges are created at
the MCP tool layer (`src/mcp/tools/decisions.ts`) where the tool handler
orchestrates `decisions` + `facts` together — consistent with how
`lore-memory action='save'` orchestrates `topics` + `memories`.

## Resolver Caching

The MCP server is a long-lived stdio process that frequently resolves the
same `projectName` or `topicName` across multiple tool calls in a single
conversation. `src/core/cache.ts` provides `LruCache<K, V>`, a minimal
LRU + TTL cache; four resolvers use it — three migrated to `getOrLoad`
and one that deliberately opted out (see notes below the table):

| Resolver                     | Keyed on    | TTL | Cap |
| ---------------------------- | ----------- | --- | --- |
| `ProjectService.findByName`  | name        | 60s | 200 |
| `TopicService.findByName`    | name¹       | 60s | 500 |
| `MemoryService.getTitleById` | memory id²  | 60s | 500 |
| `DecisionService.getById`    | decision id | 30s | 500 |

¹ Only unscoped (no `projectId`) lookups are cached. The scoped variant is
a legacy-vault safety valve with different result shape, and by design
scoped concurrent callers each issue their own query.

² Covers `Kind = decision` pages too — both live in the Memories DB and
`render.ts:resolveTitles` resolves labels for either via this one pool.

**Cached values are not cache hazards.** By default, negative lookups
(loader returns null) are not cached — the project / topic / decision
name resolvers rely on this so a null meaning "not yet created" doesn't
lock in absence for the TTL. `MemoryService.getTitleById` is the
exception: it opts into `cacheNegatives: true` so known-absent ids
(archived / 404 / restricted-resource) commit a tombstone and the next
read short-circuits. Throws are never cached on any resolver — a
transient 429 / 5xx / network blip rejects waiters and clears the
pending slot. Writes invalidate:

**Stampede-safe via `LruCache.getOrLoad`.** `ProjectService.findByName`,
`TopicService.findByName`, `DecisionService.getById`, and
`MemoryService.getTitleById` route their Notion fetch through
`cache.getOrLoad(key, loader)` rather than the classic
`cache.get(key) ?? fetch()` pattern, so concurrent cold-start callers
converging on the same key — `Promise.all` fan-outs in
`resolveCanonicalDecisionLinks`, parallel autosaves resolving the same
`topicName`, BFS walks hitting a shared ancestor, render-layer batches
resolving the same memory id — collapse onto a single Notion call.
`getOrLoad` keeps a `Map<K, Promise<V | null>>` of in-flight loads
keyed by cache key; the second concurrent miss finds the pending
promise and awaits the same underlying Notion call instead of racing
on its own loader. Rejected loaders clear the pending slot so the next
caller retries rather than observing a poisoned miss.

`MemoryService.getTitleById` opts into `cacheNegatives: true` because
not-found / archived / permission-scoped pages are known-absent (the
loader returns `null`) and a tombstone on the next read is more
valuable than a re-fetch. The other three resolvers leave the option
default-off because their `null` means "not yet created" — a
tombstone there would lock in the row's absence for the TTL window
and block subsequent lookups after a sibling write. The loader
distinguishes "known absent" (returns `null`) from "transient error"
(throws) — the throw routes through `getOrLoad`'s rejection path,
clears the pending slot, and never installs a tombstone for a 429 /
network blip. `getTitleById` wraps the call in try/catch to preserve
the "never throws on read" public contract.

**Invalidation reaches the pending map.** `cache.delete(key)`,
`cache.clear()`, and `cache.set(key, value)` all drop any in-flight
`getOrLoad` pending slot for the key, and `getOrLoad`'s loader uses a
promise-identity guard so a stale in-flight read cannot commit back to
the cache after an intervening invalidation. This is what makes the
`delete(key); await getById(key)` write-then-read pattern in
`TopicService.getOrCreate` and `DecisionService.supersede` safe under
concurrent readers — a parallel `findByName` or `getById` in flight at
the moment of invalidation no longer poisons the writer's merge base.

`set(key, value)` clearing pending is what closes the
dispatched-during-write race for `MemoryService.update` / `archive`
without a per-service epoch counter (PF1-09). The writer's
`titleCache.delete(id) → pages.update → titleCache.set(id, "newest")`
sequence drops the pending slot at both ends, so a reader's stale
retrieve resolved between delete and set has its commit suppressed by
the identity guard. Pre-PF1-09 the same protection lived as a
~30-line bespoke `writeEpoch` + `pendingTitles` machinery on
`MemoryService`; folding the invariant into the shared `LruCache.set`
collapsed the whole structure onto the primitive.

- `ProjectService.create` invalidates by name; `archive` clears the whole
  name cache (archive flips `status` on cached objects and we don't track
  the id → name reverse mapping).
- `TopicService.create` invalidates by name; `getOrCreate` proactively
  `set`s the post-extend refetched topic so subsequent lookups see the
  authoritative relation.
- `MemoryService.update` evicts the id's title cache entry _before_ the
  write so a concurrent `getTitleById` can't re-cache the stale title.
  `archive` also evicts so a follow-up read returns `null`, not the
  last-known-good title.
- `DecisionService.create` / `supersede` / `reviewCompleted` invalidate
  the affected ids.

**Create paths evict; `getOrCreate` writes through — deliberate asymmetry.**
`create` returns a freshly-minted page that the caller doesn't look up
by name next; evicting is enough. `getOrCreate` has just refetched the
authoritative post-extend state as part of its retry loop, so writing
that value through to the cache costs nothing and skips a Notion
round-trip for the next `findByName`. Do not "normalize" the create
paths to write-through — they don't have the refetched value in hand.

**Do not cache `MemoryService.getById`.** Memory bodies can be updated via
`lore-memory action='update'` from any tool; a stale body is a real
correctness hazard, not just a latency one.

Tests call `clearServiceCaches(services)` in `src/services.ts` to
force-fresh between fixtures. Production code never calls it — TTLs do
the work.

## Near-Duplicate Probe

`findNearDuplicates()` in `near-duplicate.ts` is the write-path sibling of
`FactService.createWithDedup`: advisory, not blocking. The tool layer
(`src/mcp/tools/memory.ts`, `src/mcp/tools/decisions.ts`) runs it in
parallel with the create so the probe does not add wall-clock latency,
then surfaces any similar rows in the response footer. A failed probe
returns `[]` rather than throwing — probe failures must never fail the
surrounding save.

Scoping rules:

- **Memory path** (`lore-memory action='save'`): project + top-2 tags, trigram
  threshold `0.7`, `excludeKinds: ["decision"]` so decisions surface
  only through `lore-decision action='create'` and the response stays
  focused on `lore-memory action='update'` as the corrective action.
  Deliberately **does not** narrow by `kind` — the P2-03 spec's motivating
  duplicate chain spans `note` / `note` / `agent_diary`, which a server-side
  `kind` filter would mask.
- **Decision path** (`lore-decision action='create'`): project + (topic if
  resolved) + `Kind = decision`, client-side status filter to `accepted` /
  `proposed`, trigram threshold `0.6`. Superseded / deprecated / rejected
  decisions are deliberately excluded — they are not valid supersession
  targets.
- **Autosave atomic-learning path**: project scope when safely available
  (falls back to same-session scope when no project resolves, or when the
  only project is an auto-resolved monorepo catch-all) +
  `Source = conversation` + `Kind = note` + `Confidence = likely`,
  body-fetch enabled. Unlike the general probe, this is blocking:
  `MemoryService.createWithResult()` returns the existing row and creates
  nothing. `MemoryService.create()` also pays this gate and returns the
  reused row, but callers that need to tell the operator "reused, not
  created" must use `createWithResult()` and inspect
  `autosaveLearningDuplicate`. The MCP save path still runs an early
  preflight before topic creation so already-visible duplicates do not
  create orphan Topic rows; the service layer repeats the check under
  lock immediately before create so non-MCP callers share the same
  safety net. MCP save passes topic creation as `prepareFreshCreate`,
  so a duplicate that appears between the preflight and the service
  recheck still returns without creating a topic.
  It uses strict trigram checks for near-literal duplicate bodies plus a
  lightly-stemmed token Jaccard check for reordered same-fact phrasing.
  Project scope requires exact non-empty project-set equality for scoped
  rows, but it also queries with `includeUnscoped: true` and allows an
  unscoped legacy row to block a later scoped duplicate. That preserves
  cross-scope reuse without allowing an A-only row to suppress an A+B
  save. The shared `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` kill switch or
  the narrower `LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1` switch disables
  reuse.
  When `LORE_DEBUG=1`, an auto-resolved catch-all downgrade emits
  `[lore] autosave-learning-dedup-scope-downgrade` with the project id and
  session so operators can distinguish an intentional same-session fallback
  from a missing duplicate.
  It deliberately does NOT use title-only similarity because two
  durable learnings can share a short title while carrying different
  facts. The client-side source/kind/confidence recheck duplicates the
  server filter on purpose so a future `MemoryService.list` regression
  cannot make synopsis rows block atomic-learning rows.

  The service path holds a filesystem lock across
  `probe → prepareFreshCreate → create → post-create stabilization`,
  keyed by exact project set for project scope, or by vault/config-root
  scope plus session for session scope (`autosave-learning-lock.ts`).
  After a fresh create it polls until the new row is visible to the same
  autosave-learning query (bounded by
  `LORE_AUTOSAVE_LEARNING_POST_CREATE_STABILIZE_MS`, default 500ms)
  before releasing, so the next local contender does not miss the row
  during Notion's query-index lag.
  The lock uses per-contender lease files. Stale contenders are ignored
  instead of deleting a shared lock path during takeover, so two waiters
  cannot both observe the same stale file and later delete a fresh holder.
  This is local filesystem coordination, not a Notion-side uniqueness
  guarantee; remote writers or unavailable local state can still bypass
  the local serialization layer.
  A probe failure throws `AutosaveLearningDuplicateProbeError` and fails
  closed; a transient 429 must not fall through to blind create and leave
  a duplicate row.

**`kind` and `excludeKinds` are mutually exclusive by design.** The
memory path sets `excludeKinds: ["decision"]` (client-side filter),
the decision path sets `kind: "decision"` (server-side narrowing).
A probe that sets both would apply a server-side filter _and then_
a client-side filter, which is either redundant (same kind) or
self-contradicting (kind included then excluded). Call sites pick
one axis.

**Untopiced decisions fall back to project-only scope.** The spec rule
is "same-project AND same-topic", but when the caller omits `topicName`
the probe runs with `topicId: undefined` and scopes to project alone.
Looser than spec, intentional: an untopiced decision still benefits
from a near-dup warning against project-wide siblings, and tightening
would gate the probe off on every toolless-topicName call.

The probe post-filters the just-written row in the tool layer
(`m.id !== created.id`) to close the eventual-consistency race between
`pages.create` and the query index. Thresholds are the P2-03 spec's
initial guesses; tune after rollout.

**Effective-pool shrink under `excludeKinds`.** The filter runs
client-side after `memories.list({ limit: 50 })`. In a decision-heavy
project, the usable non-decision slice of the 50-row window is
`50 − (decisions in the top-50 recent memories + tags)`. Notion's
`select` filter has no `not-equals` primitive, so this is unavoidable
without a second query. If probe recall dips, bump
`NEAR_DUPLICATE_POOL_LIMIT` rather than chasing a two-query design.

**Untagged saves broaden the candidate pool.** The list-query's `tags`
filter is Notion-side `OR` across values. When the caller passes no
tags, the probe drops the tag filter entirely and scans up to 50 rows
in the project by recency — still bounded, but more likely to produce
false positives than a tag-scoped probe. If this becomes noisy, the
fix is to either lower the pool limit or require at least one tag
before probing; don't narrow the tag filter to `AND` semantics, which
would under-shoot the candidate pool on the other side.

**HTML-entity decode inside the trigram pipeline is load-bearing.**
`similarity.ts:normalizeTitle` runs `decodeTextEntities` before
lowercasing / NFC / whitespace-collapse so pre-PF1-06 encoded rows
(still present in un-migrated vaults) match post-PF1-06 decoded
writes. Moving the decode out of the pipeline, or onto the call sites,
reopens the silent-miss case where `"Café &amp;amp; Bar"` and
`"Café & Bar"` fail to cluster.

Probe failures flow through an `onError` callback which both tool
handlers route to `debugLogPartialFailures` — probe failures become
visible under `LORE_DEBUG=1` without adding noise to the default
stderr stream.

**Kill-switch.** `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` skips the
general probe entirely. Use for bulk-import, fixture setup, or
autosave flows where the per-save round-trip isn't justified. The
bypass lives inside `findNearDuplicates`, not per-tool, so both write
tools honor it without duplicate plumbing. The autosave-learning gate
also honors this shared switch, and additionally honors
`LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1` for a narrower rollback that
keeps the advisory memory / decision probes enabled.

## Lexical conflict candidates (`conflict.ts`)

`findConflictCandidates()` in `conflict.ts` is the deterministic
half of the 0.9.0 conflict-detection workflow (issue #03). Pure
function over a `Memory[]` snapshot — no Notion access, no service
state, no `client.` imports. Consumed by `lore-memory
action='compare'` (#05) and `lore conflicts scan` (#09).

The function returns pairs whose `title + " " + keywords` trigram
similarity OR tag-overlap crosses threshold AND that share at least
one project. Each unordered pair is emitted at most once via a flat
`i < j` loop with a per-pair project-intersection guard — partition-
by-project would either double-count or miss cross-overlap pairs
(memory in `[A, B]` paired against memory in `[B, C]`).

**Filters this module applies, vs. caller's job.** This module
applies the project intersection guard and the similarity/tag-
overlap threshold. It does NOT filter on `comparedWith`, archive
state, status, time windows, or any other state-aware predicate.
Keeping the module pure decouples it from the `Compared With`
schema column added in #02 and lets #09 evolve its filter set
without touching this module. Acceptance criteria pin both halves
— a fixture passing memories that already cite each other in
`comparedWith` still surfaces the pair (caller filters), and the
`Memory` shape's archive flag (Notion page metadata) isn't on the
shape this module sees at all.

**Pair-limit semantics — two execution paths.** Default cap is
`CONFLICT_PAIR_LIMIT = 50`. To opt out of the cap entirely (the
path #09's `--exhaustive` flag uses), callers pass `pairLimit:
Number.POSITIVE_INFINITY` (or its alias `Infinity`).
`findConflictCandidates` branches on `Number.isFinite(cap)` at
entry and dispatches to one of two internal helpers:

- **Finite cap** → `findConflictCandidatesBounded`. Maintains a
  top-K accumulator via binary-insert + tail-pop with a `<= minBar`
  pre-allocation skip. In-flight footprint is O(cap); per-pair
  work is O(cap) for the splice (binary-search dominated only on
  index lookup; the actual array shift is O(cap)). Total:
  O(N² · cap) CPU, O(cap) memory. For `cap = 50` and `cap = 500`
  this is well-bounded.
- **Unbounded** → `findConflictCandidatesUnbounded`. Pushes every
  passing candidate, sorts once at the end via
  `Array.prototype.sort` (stable since ES2019, so equal-similarity
  pairs preserve their `i < j` insertion order). Total:
  O(N² + M log M) CPU, O(M) memory where M is the count of
  passing pairs.

**Why two paths, not one.** A unified top-K path under
`cap = Infinity` would degenerate to O(N⁴) total work — every
passing candidate walks the full prefix on average for the
binary-insert splice. The split keeps `--exhaustive` honest at
O(N² + M log M) while the bounded default genuinely caps memory
at O(cap). Tie semantics are byte-identical across both paths
(binary-insert with `>= similarity` advancing `lo` matches
stable-sort i<j tie order); the equivalence test in
`conflict.test.ts` cross-checks both internal paths against an
INDEPENDENT brute-force oracle (push-then-sort over
`trigramJaccard` / `tagOverlap` directly), not against each other.

Do NOT special-case `Infinity` to "default to 50". Silently
defeating `--exhaustive` would be observable to callers and the
test fixture pins both literals.

**Threshold tuning.** `CONFLICT_TRIGRAM_THRESHOLD = 0.25` and
`CONFLICT_TAG_OVERLAP_THRESHOLD = 0.5` are starting points
deliberately set lower than the memory near-duplicate threshold
(`MEMORY_NEAR_DUPLICATE_THRESHOLD = 0.7` in
`src/mcp/tools/memory.ts`). Conflict candidates are a wider net
than near-duplicates because the agent provides the semantic
verdict — a borderline pair is worth examining, not worth
suppressing. Re-tune the consts if real-vault data warrants;
document the new value in the test header (`conflict.test.ts`).

## Locked LLM prompts (`src/core/prompts/`)

The `prompts/` subdirectory is the home for version-stamped LLM
prompt templates. Each file:

- Exports a SemVer-style version constant (e.g.,
  `CONFLICT_JUDGE_PROMPT_VERSION = "1"`) at the top.
- Exports a renderer (e.g., `renderConflictJudgePrompt`) that
  takes a typed input and returns the prompt text.
- Carries a snapshot test pinned to the version constant so a
  drive-by edit fails CI; intentional edits require a paired
  version bump and snapshot update in the same PR.

Borrowed from engram's locked-prompt discipline. The borrow is
the discipline (frozen wording + version stamp), not the
specific prompt text. Source on engram's side, commit-pinned:
`https://github.com/Gentleman-Programming/engram/blob/ea1acdaf494e/internal/llm/prompt.go`.
This section is the canonical single-source pointer for the
engram lineage; the source-file header comments in `conflict.ts`
and `prompts/conflict-judge.ts` defer to this paragraph rather
than re-citing the path. The pin keeps the citation navigable
even if engram's default branch later moves the file or rewrites
the prompt — bumping the pin is an intentional act, not a passive
consequence of upstream drift. Lore renders prompts but does NOT
invoke them from the system itself — `findConflictCandidates`
returns candidates, the calling agent reads the prompt and
reasons in-context, then records the verdict via the relevant
tool (#05 for compare verdicts).

**When to bump the version.** Any change to a prompt that could
plausibly change a downstream verdict (verdict definitions
adjusted, `affected`-field semantics changed, output-format
changed) requires a new version constant — bump
`CONFLICT_JUDGE_PROMPT_VERSION` to `"2"` and add a sibling
exported renderer (`renderConflictJudgePromptV2`). Old verdicts
in storage continue to reference the old version; new verdicts
use the new one. Editing the v1 wording in place silently
changes what stored v1 verdicts mean — that is the failure
mode the discipline exists to prevent.

**Verdict vocabulary frozen for 0.9.x.** `conflict-judge.ts`
enumerates exactly six verdicts (`conflicts_with | supersedes |
scoped | related | compatible | not_conflict`). Adding a
verdict requires a prompt-version bump for the same reason a
wording change does — historical verdicts must remain
interpretable.

## Task duplicate probe and assertive reuse (issue #265)

`findDuplicateActiveTasks()` in `near-duplicate.ts` is the
write-path probe for `lore-task action='create'`, and
`findExactReuseTarget()` is the assertive-reuse predicate over
its result. Together they implement the duplicate-handling
promotion called out in issue #265 — promoting one currently
advisory path to idempotent reuse without losing the advisory
escape hatch.

**Pre-#265 (advisory only).** The probe ran in parallel with
`services.tasks.create` via `Promise.all`. Every active task
matching the new task's `Entity` substring landed in a trailing
`Other active tasks tracking "<entity>" (N) — close any that are
obsolete:` footer. Structural duplicates (same subject, same
entity, same project-set) created a fresh row and the agent had
to manually close one of the pair. High-volume autosave / Stop-
hook surfaces re-emitted the same follow-up across sessions and
the vault accumulated near-identical task rows.

**#265 promotion (assertive reuse).** The probe is now sequenced
BEFORE `services.tasks.create`. Its result feeds two consumers:

1. `findExactReuseTarget(candidates, { subject, entity, projectIds })`
   returns the first candidate whose
   normalized `(title, entity, projectIds)` equal the caller's
   `(subject, entity, projectIds)`. On a hit, `handleCreate`
   short-circuits to a `Reused existing task: "<title>" (<id>)`
   response — no `services.tasks.create` call, no
   `services.topics.getOrCreate` call (orphan-topic prevention,
   same discipline as `MemoryService.createWithResult`'s autosave-
   learning gate). Vocabulary distinguishes reuse from create at
   the response boundary so agents can branch on the leading line.

2. The residual probe result (after exact-match exclusion) renders
   in the same advisory close-CTA footer as before. Different-
   subject peers on the same entity continue to surface as advisory
   suggestions; the agent decides whether to close them.

**Cost.** The sequenced probe adds one bounded
`dataSources.query` round-trip (`limit: 10`, server-side filtered
by entity + active states) on the create path. Same posture
`MemoryService.upsertByTopicKey` adopted for `findByTopicKey`. The
parallel posture would block exact reuse at write time and force a
post-create `pages.update({ archived: true })` — race-fragile and
visible to any concurrent reader.

**Exclusion mechanics.** Since the probe runs before create, the
just-created id cannot appear in its result by construction. The
post-create `filter((t) => t.id !== task.id)` was dropped as
dead code under the new sequencing — the probe completes strictly
before create dispatches, so by construction `task.id` cannot
appear in the probe result. The pre-#265 filter existed to close
the eventual-consistency race between parallel create and probe;
sequencing makes it unnecessary.

**Normalization.** `normalizeReuseKey` (in `near-duplicate.ts`)
runs the four-step pipeline `decodeTextEntities → NFKC → toLowerCase →
whitespace-collapse + trim` on `subject`, `entity`, and each
candidate's `title` / `entity` before equality. `projectIds` is
compared set-wise via `projectSetEqual`. Pipeline parity with
`similarity.ts:normalizeTitle`'s decode-then-fold-fold-trim shape so
reuse keys agree with the trigram probe's canonical form. Three
deliberate divergences pinned in the helper docstring:

- **`decodeTextEntities` is load-bearing.** `TaskService.create`
  decodes `subject` / `entity` at the write boundary
  (`src/core/task.ts:176, 180`). Without the same decode here, a
  caller passing `"Café & Bar"` against a stored title `"Café
&amp; Bar"` (pre-PF1-06 vault) would normalize differently and
  miss reuse — exactly the silent-miss the
  `lore migrate --fix-memory-encoding` migration was designed to
  close. AGENTS.md "Near-Duplicate Probe" calls this out as
  load-bearing for the trigram pipeline; the same logic applies to
  the exact-equality predicate.
- **Locale-independent `.toLowerCase()`, not `.toLocaleLowerCase()`.**
  Vault state is shared across engineers; comparison is
  per-process. Turkish-locale `"INVOICE".toLocaleLowerCase()` is
  `"ınvoice"` (dotless-ı), en-US is `"invoice"` — two engineers
  running Lore against the same vault would otherwise reach
  different reuse verdicts. The rest of the codebase
  (`similarity.ts:normalizeTitle`) already sticks to
  `.toLowerCase()` for the same reason.
- **NFKC, not NFC.** `similarity.ts:normalizeTitle` uses NFC.
  NFKC additionally folds compatibility variants (`＃` → `#`, `ﬁ`
  → `fi`, full-width digits, etc.). For an exact-equality
  predicate the more aggressive folding is the safer choice — two
  tasks differing only by full-width vs ASCII punctuation are
  structurally the same task; NFC would let the duplicate land. A
  future contributor "harmonizing the normalizers" by switching
  this to NFC would silently weaken reuse on full-width / ligature
  inputs.

`findDuplicateActiveTasks` ALSO decodes its `entity` arg before
issuing the server-side `Entity contains` filter, so the probe and
the predicate compare against the same canonical form — without
that, a caller's encoded entity would query for the encoded form
and miss every row whose Entity column was decoded at write time.

Trigram-specific punct stripping is deliberately omitted — exact
equality, not fuzzy similarity. Whitespace-only subject or entity
short-circuits to no match (degenerate input must not silently
reuse an unrelated row).

**Project-set equality is set-equal, not overlap.** `[A]` does NOT
match `[A, B]`. Mirrors the rule
`MemoryService.upsertByTopicKey` enforces via `findByTopicKey`. A
scoped task and a multi-scoped task with the same subject + entity
are NOT structurally the same task — different audit boundaries,
different project owners.

**Probe widens; predicate narrows.** Notion's server-side
`Entity contains "PR-1"` filter matches stored
`Entity = "PR-100"` (substring semantics). Without the
post-fetch normalized-equality check on `entity`, reuse would
fire on a task tracking the wrong PR. The widened pool is
deliberate (broad recall for the advisory footer); the
post-filter is what keeps reuse precise.

**Recovery path on ambiguous matches.** When subject and entity
match but project-sets diverge, the existing row surfaces in the
advisory footer and the create proceeds — the agent sees both
rows and decides. When subject differs from existing peers, the
create proceeds with the advisory footer. When the probe
rejects (transient Notion error), `findDuplicateActiveTasks`
returns `[]`, `findExactReuseTarget` returns `null`, and create
proceeds — probe failures must never block the create path
(advisory-then-create posture preserved for the failure mode).

**Concurrent creates can both miss reuse.** Two parallel
`lore-task action='create'` calls with identical
`(subject, entity, projectIds)` can both probe before either
create lands and both see no exact match — producing two
structurally identical rows, the same hazard
`MemoryService.upsertByTopicKey` documents under "Concurrent
upserts." Single-agent serial usage is the common case for the
hot autosave / reconcile paths and the helper does not adopt a
filesystem lock today; if real-vault data shows the race matters,
a follow-up can extend the autosave-learning lock posture
(`autosave-learning-lock.ts`) to the task-reuse path. Operators
collapse any duplicate pair via `lore-task action='close'` on the
losing row.

**Kill-switches** (single-axis, same posture as
`LORE_DISABLE_TASK_CROSSREF`):

- `LORE_DISABLE_TASK_REUSE=1` — disables ONLY assertive reuse.
  The advisory probe still runs and surfaces the close-CTA
  footer (pre-#265 behavior). Use when the operator wants the
  visibility but distrusts auto-reuse on a vault.
- `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` — broader switch shared
  with the memory and decision near-duplicate probes; disables
  both the probe and (transitively, via empty input) the reuse
  helper. Use for bulk-import flows.

**Response vocabulary** distinguishes states agents can branch on:

| Outcome                             | Leading line                             | Distinguishing footer                                                                      |
| ----------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------ |
| Fresh create, no peers              | `Created task: "<title>" (<id>)`         | No advisory footer                                                                         |
| Fresh create, peers on same entity  | `Created task: "<title>" (<id>)`         | `Other active tasks tracking "<entity>" (N) — close any …`                                 |
| Exact-match reuse (#265)            | `Reused existing task: "<title>" (<id>)` | `Subject and entity match an existing active task; nothing was created.`                   |
| Exact-match reuse with ignored args | `Reused existing task: "<title>" (<id>)` | `Ignored on reuse: <comma-separated field names> — use lore-task({ action: 'update', … })` |
| Reuse disabled, exact match exists  | `Created task: "<title>" (<id>)`         | Footer surfaces the duplicate as advisory only                                             |

The five outcomes are observable through the leading line and
footer presence; downstream automation can branch on them without
parsing free-form prose. The `Reused existing task:` prefix is the
load-bearing programmatic-consumer signal — a hook or autosave
extractor that previously keyed off `text.startsWith("Created task:")`
to detect fresh-create events must also recognize the reuse prefix
or extract the `(<id>)` suffix (which appears on both shapes) to
get the task id.

**Ignored-arg disclosure (suggested by principal review).** The
reuse predicate consumes only `(subject, entity, projectIds)`. Any
of `description`, `state`, `blockedBy`, `dueDate`, `affectsIds`,
`topicName`, `forceNewTopic`, `confidence`, `tags`, `keywords`, or
`synopsis` passed by the caller is structurally dropped on the
reuse path — `services.tasks.create` was never called, so those
fields had no observable effect on the existing row. The
`Ignored on reuse:` audit line names every dropped field so an
agent calling create to bump state, due-date, or description gets a
loud signal that none of those changes landed and the
`lore-task({ action: 'update', … })` CTA is the right next step.
`agent` / `session` / `author` are session / provenance metadata,
not task fields, and are excluded from the disclosure.
`projectName` / `projectNames` participate in the reuse-key
(project-set) and are excluded for the same reason.

## Active-task cross-reference probe

`findRelatedActiveTasks()` in `near-duplicate.ts` is the third leg of
the closure-nudge tripod (issue 0.7.0/11), alongside the operating-
contract rule (#08) and the `lore-task` create/update closure CTA
(#09). Fired in parallel with `lore-memory action='save'` so the
response can surface active tasks tracking the same entity the saved
memory describes — anchoring closure CTAs at the resolution moment.

`extractEntityCandidates(title, keywords, synopsis)` is the
fixture-pinned tokenizer that feeds it. The candidate set is scored
by an `Entity contains` server-side OR probe; helpers include:

- **PR / issue / Jira shapes**: `\bPR\s*#\d+\b`, `\bPR-\d+\b`,
  `(?<![\w#])#\d+\b`, `\b[A-Z]{2,}-\d+\b`. High-precision; iterate
  first so cap-induced truncation drops the noisy candidates.
- **URLs**: `https?:\/\/[a-zA-Z0-9][^\s]*` plus a trailing-punct
  strip (`URL_TRAILING_PUNCT`) so `See https://x.com/foo,` produces
  `https://x.com/foo` not `https://x.com/foo,`. The leading
  `[a-zA-Z0-9]` after `://` rejects bare-scheme stubs such as
  `Just https://.` because `Entity contains "https://"` would substring-hit
  every URL-bearing task entity in the vault.
- **Capitalized phrases**: split into multi-word and single-word
  patterns gated by `isMeaningfulCapitalizedMatch`. A leading-word
  stop-list (`Merged`, `Found`, `Fixed`, `Saved`, ..., paired
  imperatives `Merge`, `Find`, `Fix`, `Save`, ...) drops common
  save-title verbs that would otherwise burn cap-5 slots; 1-word
  matches further require length ≥ 4 AND
  identifier-shape (mixed-case after first letter OR contains a
  digit). The split exists because a greedy multi-word match would
  swallow `Investigated PR1234` — stoplist rejects the lead, and
  `PR1234` would never get a chance via single-word alone. Two
  patterns iterating independently let `PR1234` land. Past-tense
  AND bare-imperative entries are paired 1:1 in `TITLE_LEAD_STOPLIST`
  because agent-written titles use both shapes (`"Fixed the bug"` AND
  `"Fix the bug"`); future contributors adding a past-tense entry
  should add the imperative form alongside.

Candidate cap is `ENTITY_CANDIDATE_LIMIT = 5` (Notion's OR-branch
ceiling); per-pattern cap is `PER_PATTERN_MATCH_CAP = 5` and counts
**iteration attempts**, not unique additions — a pathological input
where the same `PR #1234` repeats 50 times in keywords would
otherwise scan all 50 before yielding to later patterns.

**Failure-domain isolation**. The whole helper body (sync tokenizer +
async list call) is wrapped in a single `try/catch` that routes any
throw through `opts.onError` and degrades to `[]`. The save always
succeeds; the cross-reference footer is silently absent on probe
failure. A future regex change introducing catastrophic backtracking
would NOT propagate to the user as a save error.

**Kill-switch.** `LORE_DISABLE_TASK_CROSSREF=1` skips the probe
entirely without making any Notion call. **Distinct from
`LORE_DISABLE_NEAR_DUPLICATE_PROBE`** — single-axis kill switches let
an operator trust the deterministic substring near-dup probe and
distrust the regex-based entity extraction here (or vice versa). Use
for bulk-import flows, fixture setup, or distrust of the
entity-extraction tokenizer's noise floor on a particular vault. The
bypass lives inside `findRelatedActiveTasks`, not per-tool.

## Auto-`mentions` fact emission

`lore-memory action='save'` (issue 0.8.0/#07) emits one `mentions`
fact per entity surfaced by `extractEntityCandidates(title, keywords,
synopsis)` — the same fixture-pinned tokenizer the active-task
cross-reference probe consumes. The branch fires after the create
resolves (the fact's `Source` relation needs the just-created memory
id) and dispatches per-entity `services.facts.createWithDedup` calls
in parallel.

`mentions` is system-managed, not agent-addressable. The value lives
on `FactPredicate` for type coverage and on the `Predicate` select
column for storage, but the active profile's writable fact predicates
exclude it — `decided_by` / `supersedes_decision` / `informs` get the
same treatment. Auto-emitted facts ship at `confidence: speculative`
so `lore-query action='ask'`
preferentially surfaces agent-curated edges when both exist on the same
entity.

**Subject is the saved memory's title.** Matches the existing
`decided_by` shape on `lore-decision action='create'` (subject is the
affected entity name, not a synthetic "memory entity"). The `Source`
relation provides the structural backlink to the originating page.

**Cap is `ENTITY_CANDIDATE_LIMIT = 5`**, enforced inside the
extractor — auto-emit honors the same ceiling as the active-task
cross-reference probe rather than re-deriving its own limit. A memory
that mentions ten entities emits at most five facts, dropping the
noisiest candidates first via the high-precision-first pattern
ordering.

**Failure-domain isolation.** Per-entity `createWithDedup` failures
route through `debugLogAutoFactFailure` (in `src/mcp/helpers.ts`) and
degrade to a no-op for that entity. Surviving fact creates land; the
save itself always succeeds. Same posture as the parallel near-dup /
cross-ref probes. Under `LORE_DEBUG=1`, one stderr line per failure
surfaces enough detail to distinguish a transient blip from a
pathological loop.

**Kill-switch.** `LORE_DISABLE_AUTO_MENTIONS=1` skips both extraction
and per-entity fact creation entirely. **Distinct from
`LORE_DISABLE_NEAR_DUPLICATE_PROBE` and `LORE_DISABLE_TASK_CROSSREF`**
— single-axis kill switches let an operator distrust the
regex-derived auto-mentions tokenizer independently of the
deterministic substring near-dup probe and the active-task
cross-reference. Set for bulk-import flows, fixture setup, or vaults
where the tokenizer's noise floor is unacceptable.

**Update-time re-emission (diff-and-invalidate, DEFERRED-03 +
issue #491).** `lore-memory action='update'` runs the same
extraction over the post-update title / keywords / synopsis,
pre-queries existing `mentions` facts sourced from this memory via
`FactService.queryBySourceMemory({ predicates: ["mentions"] })`, and
produces a symmetric diff: `createWithDedup` fires for entities the
graph doesn't already cover (`current − previous`), and
`services.facts.invalidate` fires for facts whose Object is no
longer surfaced (`previous − current`). The covered / stale check
is by Object alone, deliberately: a title-only update that leaves
the entity set untouched changes every existing fact's subject text
but emits zero new rows AND zero invalidates.

`FactService.invalidate` is a soft-delete (writes `Valid Until =
today`, never `pages.update({ archived: true })`) per the
"Fact Invalidation" rule above, so historical record is preserved
even on the auto-mentions surface — the row is dropped from
default-active queries via the `is_empty` filter, but
`includeInvalidated: true` reads still surface it. Mirrors the
explicit `lore-fact action='invalidate'` surface; auto-mentions and
manual invalidation produce structurally identical row state.

The pre-query runs unconditionally inside the
`extractionInputsTouched` gate (no `mentionedEntities.length > 0`
short-circuit) — without this, an update that strips every entity
from the surface (e.g. retitling `Investigated PR #1234 latency
regression` to `Generic refactor notes`) would silently leave the
existing `mentions` facts orphaned, the exact dynamic issue #491
exists to close.

The `predicates: ["mentions"]` filter on the pre-query is
load-bearing for the "auto-emit only invalidates auto-emitted
facts" contract — manual `lore-fact action='create'` calls cannot
land a `mentions` row (the predicate is excluded from
the active profile's writable fact predicates), AND the pre-query
filters by predicate at the service boundary so the diff branch
never sees manual `uses` / `depends_on` / `causes` rows pointing at
this source memory. A future refactor that loosens the filter
(e.g. dropping the options arg on the `queryBySourceMemory` call)
would silently start invalidating manual facts whose source memory
is the one being updated; pinned at the call boundary by
`pins the pre-query call boundary at predicates: ['mentions']` in
`memory.test.ts`.

> **Historical (pre-#491).** The branch was add-only and
> deliberately accepted drift on removes — the alternative
> (diff-and-invalidate on every update) was scoped out of
> 0.8.0/#07 as "owned by the explicit fact invalidation surface."
> Issue #491 closed that gap because every entity rename produced
> a fresh fact AND left the old fact live, so a long-lived memory
> accumulated orphans without bound across revisions. The
> symmetric contract restores parity with the explicit
> `lore-fact action='invalidate'` and `lore-correct` surfaces.

The advisory footer surfaces both halves: `Auto-mentions: N new`
when only creates fired, `Auto-mentions: N stale invalidated` when
only invalidates fired, `Auto-mentions: N new, M stale invalidated`
when both fired. Partial-failure ratios render independently per
half (`Auto-mentions: 1/2 new attempted, 0/1 stale invalidated
attempted`). The `new` / `stale invalidated` suffixes distinguish
update-time emission from save-time emission so an operator
triaging response output can tell which surface produced the count
and which half of the diff drove the work. Same
`LORE_DISABLE_AUTO_MENTIONS=1` kill switch — the env var disables
both extraction AND the pre-query, so an operator distrusting the
tokenizer disables every per-entity write the branch would
otherwise emit. Per-entity invalidate failures route through
`debugLogAutoFactFailure` with `kind=invalidate` so a sustained
problem with the invalidate write is distinguishable from
transient dedup races on the create side.

**Concurrent invalidate against the same fact id.**
`FactService.invalidate` serializes the confidence read/compute/write
with the existing per-id filesystem lock primitive. The `Valid Until`
write is idempotent, but `Confidence Score` must apply one decrement
per invalidate call. Acquiring the lock before `pages.retrieve` and
holding it through the update/retry path makes parallel invalidators
queue: the second caller reads the first caller's written score and
lands the next decrement instead of overwriting with the same value.
This covers explicit `lore-fact action='invalidate'` and
auto-mentions diff invalidation from `lore-memory action='update'`.
Compare-dispatch contradiction handling is governed by its own ledger
and memory-confidence path, not by this fact-id lock. The cost is one
filesystem lock per invalidate call.

**Out of scope: decision-side emission.** `lore-decision
action='create'` already emits `decided_by` facts via its `affects`
path. Adding a parallel `mentions` emission to the decision handler
is plausible follow-up work but expands the surface and the test
coverage in lockstep. 0.8.0 scopes auto-mentions to `lore-memory`
(save and update via DEFERRED-03) exclusively.

## Schema Drift Detection

`VaultManager.load()` can fire a non-blocking `detectDrift()` check that runs
the same diff logic as `lore migrate` but read-only — when drift is found, a
stderr warning nudges the user to run `lore migrate`. Failures in the check
are caught and logged (not silently swallowed) so we don't lose the nudge
when the check itself is broken; the vault still loads. Reads on drifted
vaults keep working via extractor fallbacks; writes that need missing
properties fail at the Notion API with a 400.

The check is **opt-in** as of 0.6.0 (issue 02): it is gated by an explicit
`driftCheck` boolean on `VaultManager.load`, resolved at the
`initServicesFromConfig` seam from the tri-state `DriftCheckMode`:

| Mode (`InitServicesOptions.driftCheck`) | Behavior                                                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `true`                                  | Always run; bypass the marker; touch the marker so a sibling debounced caller skips.                                    |
| `false` (default)                       | Always skip; don't read or touch the marker.                                                                            |
| `"debounced"`                           | Run only if the per-config-root drift marker is ≥ `DRIFT_DEBOUNCE_DAYS` (7) old. Optimistically touch before returning. |

Per-surface policy:

| Surface                                                    | Mode              | Why                                                                          |
| ---------------------------------------------------------- | ----------------- | ---------------------------------------------------------------------------- |
| MCP server (`src/mcp/server.ts`)                           | `"debounced"`     | Hot startup path; every reconnecting client would otherwise re-run the scan. |
| Hooks wake-up (`src/hooks/helpers.ts`)                     | `"debounced"`     | Fires on every session start / first user prompt.                            |
| Digest scheduler (`src/hooks/digest-scheduler.ts`)         | `"debounced"`     | Same hot path as wake-up.                                                    |
| `lore status` (`src/cli/commands/status.ts`)               | `true`            | Canonical operator-facing drift surface.                                     |
| `lore migrate` (`src/cli/commands/migrate.ts`)             | `true`            | Operator-facing drift surface.                                               |
| Other CLI (`search`, `mine`, `digest`, status subcommands) | (default) `false` | Don't surface drift; don't pay for it.                                       |

Why this layering rather than option 3 (a separate low-priority client):
the drift work is short-lived enough that a once-per-week run on the same
rate-limited client is cheaper than maintaining two parallel pools, and
the tri-state seam keeps the policy decision explicit at every entry
point. If sustained contention shows up post-rollout, revisit.

The debounce marker is keyed on a sha256 hash of the resolved `configRoot`
so multiple worktrees pointing at the same vault share one suppression
window — without that keying, every parallel worktree would rediscover
drift independently and the debounce would degrade for stacked PR work.
See `src/hooks/drift-marker.ts`; same shape as `digest-marker.ts`.

## Extractors Dependency

All services import property extractors from `src/notion/extractors.ts`. The
private `pageToFoo()` methods on each service convert a `PageObjectResponse`
into a domain type using these extractors.

| Service           | Converter                                   | Domain type |
| ----------------- | ------------------------------------------- | ----------- |
| `ProjectService`  | `pageToProject()`                           | `Project`   |
| `TopicService`    | `pageToTopic()`                             | `Topic`     |
| `MemoryService`   | `pageToMemory()` (module-level exported)    | `Memory`    |
| `FactService`     | `pageToFact()`                              | `Fact`      |
| `DecisionService` | uses `pageToMemory()` + type-narrowing cast | `Decision`  |

**Rule**: If you add a new database property, you must:

1. Add the property config in `schema.ts`
2. Add extraction logic using an extractor from `extractors.ts`
3. Update the domain type in `types.ts`
4. Update the `pageToFoo()` converter in the relevant service
