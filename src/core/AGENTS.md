# AGENTS.md -- src/core/

> Read the root `AGENTS.md` first. This file covers the domain logic layer only.

## Purpose

This directory contains Lore's business logic: CRUD operations for each entity
type, context resolution, and vault management. These services sit between the
interfaces (MCP, CLI, hooks) and the Notion SDK layer (`src/notion/`).

## Files

| File                        | Class/Function                                                                                                                               | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `vault.ts`                  | `VaultManager`                                                                                                                               | Init/load vault, get database IDs, count stats, drift check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `project.ts`                | `ProjectService`                                                                                                                             | CRUD for projects, findByPath, findByName                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `topic.ts`                  | `TopicService`                                                                                                                               | CRUD for topics, getOrCreate, listByProject                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `memory.ts`                 | `MemoryService`                                                                                                                              | CRUD + list + semantic search for memories. Hosts `touchOnRead` and `decrementConfidence` — the I/O wrappers around the `decay.ts` algebra (0.8.0/#03). Hosts `listAllForBackfill` (paginating async iterator over non-archived memories) and `applyBackfillScore` (single-call write of `Confidence Score` + `Last Referenced At`) for the 0.8.0/#11 baseline migration. Hosts `confidenceStats` — single-pass `Confidence Score` aggregator backing the `lore status` confidence-summary line (DEFERRED-04); reuses `listAllForBackfill` so the migration and the status surface share one walker. Hosts `findByTopicKey` (0.9.0/#01) — `(Topic Key, Project-set)` lookup helper shared by #06's upsert and #14's re-key — `upsertByTopicKey` (0.9.0/#06) — append-revision-on-match save path consumed by `lore-memory action='save'` when `topicKey` is set — and `rekeyTopicKey` (0.9.0/#14) — re-key path that appends a `## Re-keyed (date)` audit block, validates collision via `findByTopicKey`, and writes only the `Topic Key` column. Hosts `recordCompared` — symmetric two-page `pages.update` writing `Compared With` + `Compare Notes` on both sides of a judged pair (0.9.0/#05); accepts an `affected` field (loser id for asymmetric verdicts, `null` for symmetric) so direction is part of the pair-scoped idempotency key. Module also exports the standalone dispatch helpers `recordContradiction` / `recordSupersedence` — `recordContradiction` runs `createWithDedup` first (idempotent on the triple hash) then `decrementConfidence` with an atomic `compare_dispatch` ledger marker in `Compare Notes`; `recordSupersedence` adds `decisions.supersede` as step 1 ahead of fact + ledgered decrement, routing through the existing `lore-decision action='supersede'` semantics so the new decision's `Supersedes` relation and the old decision's `Status` flip alongside the contradiction signal. Both throw `CompareDispatchPartialFailureError` with `step` / `affectedMemoryId` / `factId` fields when a step lands but a successor fails — surfaces retry diagnostics rather than requiring manual repair. Prompt-version provenance survives only via the final Compare Notes audit trail; `FactService` has no body column in 0.9.0 so the helpers do NOT thread `reason` / `promptVersion` into the emitted fact. Module also exports the pair-scoped final-audit helper `hasMatchingCompareNote`, the dispatch-ledger helpers (`buildCompareDispatchLedgerEntry`, `hasCompareDispatchLedgerEntry`), and the structural `CompareDispatchServices` type the helpers accept |
| `fact.ts`                   | `FactService`                                                                                                                                | Knowledge graph triples with temporal validity; includes `repointEntity` for entity merges                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `decision.ts`               | `DecisionService`                                                                                                                            | Decision lifecycle (Kind=decision memories): create, list (index tier), supersede, chain walk, review                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `task.ts`                   | `TaskService`                                                                                                                                | Task CRUD (Kind=task memories): create, list (index tier), update, close, queryOverdue, countActive, countClosedSince. Hosts `taskDaysOverdue` / `taskDaysStale` helpers and the `taskStats` + `formatTaskSummary` pair shared by `lore status` and `lore-context action='status'`. Canonical surface for tracked work (P3-02).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `task-reconcile.ts`         | `reconcileActiveTasks()` / `scoreCandidate()` / `formatReconcileOutput()`                                                                    | Operator-pulled batch reconciliation (issue 0.7.0/14): scan active tasks against recent memories with resolution-shaped cues, score by entity / cue / recency, surface ranked candidate closures. Read-only; one-shot vault cleanup. Hosts the `MAX_RECONCILE_TASKS` / `RECONCILE_PER_TASK_LIMIT` / cue-pattern constants and the `mapWithConcurrency` fan-out helper. Shared by `lore-task action='reconcile'` and `lore tasks reconcile`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `entity.ts`                 | `EntityService`                                                                                                                              | Canonical-entity registry (PF3-01): findByName, findByAlias, resolveOrCreateEntity (with ambiguity surface), addAliases, archive. Required service wired from the required Entities DB.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `entity-merge.ts`           | `mergeEntities()`                                                                                                                            | Operator-driven duplicate Entity merge: preview/apply plan, repoint facts from loser to winner, append loser lookup forms to winner aliases, write a merge note, archive loser only after earlier steps succeed, then re-scan for late fact writes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `entity-migration.ts`       | `buildEntities()`                                                                                                                            | One-shot pass that groups every fact's Subject/Object strings by normalized key, picks longest-form canonical, and re-points each fact's `SubjectEntity`/`ObjectEntity` relation. Plan-then-execute via `lore migrate --build-entities --yes`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `context.ts`                | `resolveProject()`                                                                                                                           | Match cwd to a project via longest prefix                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `wakeup.ts`                 | `loadWakeUpData()`                                                                                                                           | Aggregate digest + memories + facts + decisions + active-task-related memories for wake-up surfaces (MCP tool + shell hook)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `project-context.ts`        | `composeProjectContext()` / `renderProjectContextLines()`                                                                                    | Renders the per-project framing block (name + description + siblings + catch-all warning) for `lore-context action='wake-up'`, `lore-query action='ask'`, and the shell wake-up hook. Synchronous; takes an already-resolved `Project` so no Notion call. (Issue 0.6.0/18.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `cache.ts`                  | `LruCache<K, V>`                                                                                                                             | Minimal in-process LRU + TTL used by name→id resolvers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `fact-encoding.ts`          | `fixFactEncoding()`                                                                                                                          | `lore migrate --fix-fact-encoding` — decode Subject/Object + recompute DedupKey, gated by post-decode collisions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `memory-encoding.ts`        | `fixMemoryEncoding()`                                                                                                                        | `lore migrate --fix-memory-encoding` — decode Title + body markdown; skips archived and body >100 KB                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `agent-normalization.ts`    | `normalizeAgents()`                                                                                                                          | `lore migrate --normalize-agents` — collapse fragmented `Agent` strings onto their canonical form (PF3-02)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `synopsis-backfill.ts`      | `backfillSynopses()`                                                                                                                         | `lore migrate --backfill-synopses` — synthesize a 1–2 sentence synopsis for memories whose `Synopsis` is empty; pluggable `claude` / `placeholder` backends (issue 0.7.0/05)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `confidence-migration.ts`   | `runBuildConfidenceScoresMigration()`                                                                                                        | `lore migrate --build-confidence-scores` — baseline-seed every memory's `Confidence Score` from its categorical `Confidence` and write `Last Referenced At = created_time`, then realize accrued decay. Plan-then-execute; `--yes` applies. Project-scoped via `--project <name>` (strict-resolve, fails fast on unknown names). (Issue 0.8.0/11.)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `similarity.ts`             | `titleTrigrams`, `trigramJaccard`, `tagOverlap`                                                                                              | Pure helpers for the write-path near-duplicate probe                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `near-duplicate.ts`         | `findNearDuplicates()`                                                                                                                       | Advisory probe used by memory and decision write paths (`lore-memory action='save'`, `lore-decision action='create'`) to surface similar rows                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `conflict.ts`               | `findConflictCandidates()`                                                                                                                   | Lexical conflict-candidate generator (0.9.0 issue #03). Pure function over a `Memory[]` snapshot — no Notion access. Consumed by #05 (`lore-memory action='compare'`) and #09 (`lore conflicts scan`). Returns pairs whose title-blob trigram OR tag overlap crosses threshold; the caller filters on `comparedWith` / archive state                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `prompts/conflict-judge.ts` | `renderConflictJudgePrompt()` + `CONFLICT_JUDGE_PROMPT_VERSION`                                                                              | Locked judgment-prompt template for the conflict-detection workflow (0.9.0 issue #03). Borrowed from engram's `internal/llm/prompt.go` discipline; see "Locked LLM prompts (`src/core/prompts/`)" below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `decay.ts`                  | `clampConfidenceScore`, `seedConfidenceScore`, `bumpConfidenceScore`, `decrementConfidenceScore`, `decayConfidenceScore`, `confidenceFactor` | Pure-algebra helpers for the dynamic-confidence workstream (0.8.0/#03). I/O wrappers `MemoryService.touchOnRead` and `MemoryService.decrementConfidence` consume them; #08's RRF reads `confidenceFactor`. The migration in `confidence-migration.ts` consumes `seedConfidenceScore` + `decayConfidenceScore` for baseline backfill                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `topic-key.ts`              | `suggestTopicKey()`                                                                                                                          | Pure heuristic over (title, kind) → kebab-case `${family}/${noun-phrase}` key (issue 0.9.0/#07). No I/O, no Notion access. Backs `lore-memory action='suggest-topic-key'`. Family from a closed `Record<MemoryKind, string \| null>` — `note` and `task` map to `null`. Noun phrase is the title's first 4 tokens after NFKD ASCII fold + stoplist + preposition-break filtering, with `YYYY-MM-DD` dates pre-stripped, then truncated at a 48-char hyphen-aware boundary. Deterministic; same input always returns the same key                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

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

`project-scope.ts` exports `formatUnresolvedProjectScopeError()` for
operator-facing errors when a caller explicitly names a project that cannot be
resolved. Boundary resolvers for explicit names (MCP, CLI, migrations, hooks)
must use this helper so typo, archived, and inaccessible project failures stay
consistent and fatal instead of falling back to auto-detected or vault-wide
scope. `ProjectService.findByName()` owns the separate duplicate-active-name
error; do not catch and soften it at the boundary.

## Memory Content Storage

Memory content is stored as Notion page body using the markdown API, not as a
page property. The workflow:

1. **Create**: `pages.create()` with properties only, then `pages.updateMarkdown()`
   with `type: "insert_content"` to write the body.
2. **Read**: `pages.retrieveMarkdown()` returns `{ markdown: string }`.
3. **Update**: `pages.updateMarkdown()` with `type: "replace_content_range"` and
   `content_range: "full_page"`.

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

| Branch            | Behavior                                                                                                                                     | `upserted` |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| No existing match | `create` with `revisionCount: 1` and the topic key seeded onto the new row                                                                   | `false`    |
| Existing match    | Append `## Revision N (YYYY-MM-DD)` block to the page body via `replace_content_range`, then property update with new title + revision count | `true`     |

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
Title, so the same write-epoch sandwich + post-write `set` discipline
that protects `MemoryService.update` from concurrent `getTitleById`
callers applies here. The pre-write epoch bump invalidates any
in-flight reader's commit-time epoch check; the cache delete clears
the stored value; the post-write `set` installs the authoritative new
title; the post-write bump closes the dispatched-during-write
window. Without this, render-layer resolvers would keep returning
the pre-upsert title from `titleCache` until the 60s TTL expired
even though the new title has landed in Notion.

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
`replace_content_range` with `content_range: "full_page"` for edits
to an existing body (per `src/notion/CLAUDE.md`). The upsert path
therefore reads existing markdown via `retrieveMarkdown` before any
append decision. When a new revision is needed, it writes back the
concatenation via `replace_content_range` with
`allow_deleting_content: true`.

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

## Memory Search

`MemoryService.search()` switches on `input.mode` (default `"hybrid"`)
between three execution paths. Each path returns the same `Memory[]` shape;
they differ in scope, filter capability, and ranking.

### `mode: "contains"` (DS-scoped, server-side filters)

Issues a `dataSources.query` against the Memories DS only — never touches
`client.search`. The filter is composed as a single `and`:

- Project inheritance: `Project relation contains projectId OR Project is_empty`
  (mirrors `MemoryService.list`).
- Topic: `Topic relation contains topicId`.
- Tags: any-match `OR` across tag values (single value collapses to a flat
  `multi_select.contains`).
- Kind / Status: server-side `select.equals`.
- Text clause: title, keywords, or synopsis contains the query.
  Synopsis joins the precision lane (issue 0.7.0/01–02) because it's
  agent-curated, short, and high-signal — a
  phrase absent from title and keywords but present in a synopsis would
  otherwise miss the contains lane entirely. All three branches share
  Notion's case-insensitive `contains` semantics on `rich_text`/`title`.

**Empty / whitespace-only queries skip the text clause** — `contains: ""`
matches every row in Notion, which would degenerate the query into "every
page in the DS." Skipping the clause lets the surrounding property filters
drive the result set, giving the caller a recency-ordered listing under
their other filters. Sort is `last_edited_time desc`; `page_size` is the
caller's `limit` (max 100).

Body matches are **not** searched here — `dataSources.query` only filters
on properties. Callers that need body relevance should use `"semantic"`
or rely on the hybrid fallback below.

**Archived rows are excluded client-side.** Notion's `archived` flag
lives on `PageObjectResponse`, not as a DB column, so `dataSources.query`
returns archived rows by default. `fetchContainsPages` filters them out
post-fetch — same posture as `findByTopicKey`, `listAllForBackfill`, and
`listForScan`. Without this, an archived row at the top of recency could
occupy a result slot a live row would otherwise fill.

### `mode: "semantic"` (workspace-wide, vector-ranked)

The legacy path. Uses `client.search()` for relevance ranking against page
titles AND bodies. Results are post-filtered to the Memories DS — matching
either `parent.type === "database_id"` against `db.databaseId` **or**
`parent.type === "data_source_id"` against `db.dataSourceId`. Notion SDK
v5 returns both shapes in the wild depending on when and how the page was
created; accepting only `database_id` silently filters out every real
result from a data-source-backed workspace.

Property filters (`projectId` / `topicId` / `tags` / `kind` / `status`)
all post-filter client-side because `client.search` has no property-filter
support.

**Do not pass a `sort` parameter to `client.search()`.** Notion's `search`
endpoint returns results ranked by relevance when no `sort` is provided.
Passing a `sort` switches to recency ordering and demotes the query to a
lexical filter — which defeats the whole purpose of semantic search. We
fetch `page_size: 100` instead so the post-filter to the Memories DS has
headroom when the workspace contains unrelated pages matching the query
tokens.

**Paginates up to `SEMANTIC_SEARCH_MAX_PAGES` raw pages (default 5)** when
the first 100 raw hits do not yield enough post-filtered Lore memories to
satisfy the requested `limit` (issue #192). Loop exits early on
saturation (`accumulated >= limit`) or exhaustion (`has_more: false`); the
cap fires only when both conditions miss — bounding worst-case latency at
five sequential `client.search` round-trips and protecting the per-token
rate-limit bucket from a pathological query that has no matches anywhere
in the workspace. See `SEMANTIC_SEARCH_MAX_PAGES`'s docstring for the
choice rationale (scan window, tail latency, rate-limit budget).

**Pagination dedupes by page id across cursor steps.** `client.search`
runs each cursor step as a fresh workspace-wide query, not a slice of a
frozen result set, so concurrent vault edits between page-N and page-N+1
fetches CAN surface the same memory id twice. The dedup `Set<string>`
guards both consumers: hybrid's RRF accumulator (intra-branch
double-credit would inflate the fused score) and the semantic-only
caller (rendering the same row twice is a visible correctness bug). Pre-
pagination this couldn't happen — single page meant single observation.

**Returns the full pagination accumulator without an early slice.**
The saturation gate bounds `accumulated.length` to the range from 0
through `limit + pageSize - 1`; trimming inside `fetchSemanticPages`
would silently narrow the hybrid RRF pool. A row at semantic-rank 11
that also appears in contains contributes its `1 / (RRF_K + 11 + 1)`
to the fused score and can plausibly beat a contains-only row — but
only if it survives long enough to reach the accumulator. `runSearch`
applies `pages.slice(0, limit)` at the call boundary as the
authoritative final cap for semantic-only callers; hybrid consumes the
wider pool. Pre-PR the
equivalent narrowing was structural (single page of 100 trimmed to
limit), so this is a recall improvement on the same axis pagination
opened up, not a fix-for-regression.

**Operator triage signal.** When the cap fires (loop exhausted
`SEMANTIC_SEARCH_MAX_PAGES` without saturating or hitting `has_more:
false`), `debugLogSemanticSearchCapFired` writes one stderr line under
`LORE_DEBUG=1`: `[lore] semantic-search-cap-fired: pages=5
accumulated=N limit=L source=fetch-semantic-pages`. The `LORE_DEBUG`
gate keeps the common path silent; operators triaging "lore-query
returned empty / short results" use this to distinguish the
pathological-query case from genuine no-matches. Same posture as
`debugLogHybridBranchFailure`.

**Archived memory pages are excluded** before they enter the
accumulator. `client.search` ignores Notion's `archived` flag; under
pagination, an archived memory pushed into the accumulator counts
toward `limit` and can stop the loop before later live matches are
fetched. The `applySemanticPostFilters` helper drops archived rows in
the same pass as the parent-DB match — mirrors the every-other-walker
contract (`findByTopicKey`, `listAllForBackfill`, `listForScan`,
`fetchContainsPages`).

### `mode: "hybrid"` (default)

Speculative parallelism. `searchByHybridPages` fires `fetchContainsPages`
and `fetchSemanticPages` (the **raw** fetch helpers — see "Fetch/sort
pipeline split" below for why hybrid composes the raw helpers, not the
public confidence-aware wrappers) concurrently via `Promise.allSettled`.
Once both settle:

- **Saturating case** (`containsPages.length >= HYBRID_FALLBACK_THRESHOLD`,
  default 3): the contains rows alone become the result. The parallel
  semantic call is discarded. `Promise.allSettled` does NOT short-circuit
  when contains saturates, so wall-clock is still
  `max(contains_latency, semantic_latency)`. **Post-#192**, the worst-
  case `semantic_latency` is bounded by `SEMANTIC_SEARCH_MAX_PAGES` (5)
  sequential `client.search` round-trips on a pathological query that
  has no matches anywhere in the workspace; saturation cutoff still
  pays that cost only to discard the result. In practice the semantic
  branch saturates or exhausts after 1–2 pages on real queries, so
  the wall-clock impact is bounded but not theoretically free. A
  future `AbortController`-based cooperative cancellation would let
  the saturating contains branch terminate the in-flight semantic
  pagination; track in `DEFERRED.md` if real-vault metrics show the
  cost matters.
- **Under-shooting case (RRF)**: when contains under-shoots the
  threshold, the merge runs Reciprocal Rank Fusion over both branches
  rather than concat-with-dedup. Each row's score is
  `Σ (1 / (RRF_K + rank + 1)) * weight * confidenceFactor` summed across
  the branches it appears in; `RRF_K = 60` (Cormack 2009 / qmd default).
  `confidenceFactor` is the per-row `[CONFIDENCE_FACTOR_MIN, 1.0]`
  multiplier from `decay.ts` (0.8.0/#08); the factor is applied **once
  per per-branch contribution** inside the accumulator (see
  `src/core/memory.ts:searchByHybridPages`). Cross-branch agreement is
  the signal RRF surfaces — a row ranked #1 in both branches with
  `confidenceFactor=1.0` scores `2/61` and beats a row ranked #1 in
  only one branch (`1/61`). The earlier concat-then-fill heuristic
  discarded that signal.

  **Tie-break order** (deterministic, fixture-pinned): score →
  best-rank → contains-presence → page id ascending. `bestRank` is the
  minimum of contains rank and semantic rank, with missing ranks treated
  as infinity. The contains-presence rule
  preserves the "contains is precision" intuition the prior heuristic
  encoded — a contains-present row beats a semantic-only row when score
  AND best-rank are tied. A future contributor tempted to "make
  tie-break symmetric" would silently shift this case; the test fixture
  pins it via an adversarial alphabetic ordering on the semantic-only id.

  **Saturation cutoff is preserved verbatim above the RRF block.** RRF
  only runs when contains under-shoots — the precision case where
  contains nails it (file names, PR numbers, function names) skips RRF
  entirely and returns contains rows in their original order. The
  saturation gate is the first decision; RRF is the second.

- **Single-branch failure (PF3-03).** A rejected branch degrades to an
  empty result; the surviving branch's rows pass through unchanged. A
  transient `429`/`5xx` from `client.search` no longer takes down a
  contains query that saturated independently, and an outage on
  `dataSources.query` no longer takes down a semantic query that
  returned. `LORE_DEBUG=1` emits one stderr line per failed branch
  (`[lore] partial-failure: branch=<contains|semantic> error=<message>
source=hybrid-search`) so an operator can distinguish a transient
  blip from a pathological loop. **Both branches rejected** still
  surfaces an error so a fully broken search subsystem doesn't
  masquerade as "no results found." The both-fail path additionally
  writes `[lore] both-failure: contains=<message> semantic=<message>
source=hybrid-search` **unconditionally** — not gated on
  `LORE_DEBUG` — because there is no surviving response to mask
  noise on, the caller's `try/catch` only sees one chosen `throw`,
  and an operator triaging a real outage needs both rejection
  reasons regardless of how their environment was started. The
  surfaced error is `containsResult.reason` (DS-scoped, structured
  filter errors are more actionable than `client.search`
  workspace-wide errors); flipping that choice would be observable
  to callers and should be a coordinated change.

  **Visibility-cost note.** A genuine clean-miss and a "one branch
  down, the other returned zero hits" both surface as an empty
  result to the caller — by design, since the surviving branch's
  empty result IS the honest answer to the query. The operator-side
  mitigation is the `LORE_DEBUG=1` stderr line; the production
  followup is an error-counter dashboard alert.

  **Log-format divergence from `mcp/helpers.ts:debugLogPartialFailures`.**
  Both helpers share the `[lore] partial-failure:` prefix and the
  `error=` field — that is the stable contract for `grep`-based
  log aggregation. The key names diverge: hybrid search uses
  `branch=<contains|semantic>` and `source=hybrid-search` because
  a hybrid branch isn't a Notion root id, and `tool=hybrid-search`
  would be misleading (hybrid search is a core-service path, not
  an MCP tool). Downstream parsers should match on the prefix and
  the `error=` field; per-surface key names are intentionally
  scoped to their surface.

The earlier sequential design (run contains, then run semantic if it
under-shot) traded latency _against_ itself in the under-shooting case,
which is the _common_ case for phrase-shaped queries. Parallelism
restores the pre-PR worst-case wall-clock while keeping the precision
of contains when it produces enough signal. Switching from `Promise.all`
to `Promise.allSettled` preserves the wall-clock guarantee while
decoupling the failure domains — the kill switch
(`LORE_FORCE_SEMANTIC_SEARCH=1`) remains the manual rollback for
sustained problems; this guard is the automatic one for transient ones.

Three is a tradeoff: small enough that a niche query with one or two
title hits still gets the benefit of body-relevance ranking, large enough
that the common case (a caller searching a specific PR number, file
name, or function) skips merging with semantic. If the threshold ever
needs tuning, change the `HYBRID_FALLBACK_THRESHOLD` constant in
`memory.ts` — it's exported so callers can reference it in their own
diagnostics.

### Optional `intent` disambiguator (#17)

`SearchMemoriesInput.intent` is an optional disambiguator threaded
into the **semantic branch's relevance query as context only** —
NEVER into the contains branch's substring match. Use when `query` is
short and ambiguous and the caller knows which sense they mean (e.g.
`query: "auth"`, `intent: "WeChat session cookie"`). Existing call
sites that don't pass `intent` see byte-identical pre-#17 behavior.

**Contains-vs-semantic asymmetry is the load-bearing rule.** Appending
intent into `query` would break the contains branch's substring
match — every Title without the literal disambiguator phrase drops
out, narrowing recall in the opposite direction the disambiguator
exists to fix. The contains branch sees ONLY `input.query`. Body
matches are not searched in contains regardless (see the contains
caveat above), so the asymmetry is doubly tight: contains-mode
ignores `intent` end-to-end. Co-located here next to the contains
caveat so a future contributor doesn't need to chase the rule across
two surfaces.

**Normalize once, whitespace-only treated as unset.** Both consumers
(the saturation gate in `searchByHybridPages` and the query
composition in `searchBySemanticPages`) read the same normalized
value computed at the top of `runSearch`:

```ts
const trimmedIntent = input.intent?.trim()
const intent =
  trimmedIntent !== undefined && trimmedIntent.length > 0 ? trimmedIntent : null
```

Whitespace-only intent (`"   "`) collapses to `null` so it cannot
accidentally bypass the saturation cutoff or pollute the semantic
query with leading/trailing spaces. The `null` sentinel is the
single signal of "intent is set"; helpers branch on `intent !== null`.

**Saturation-cutoff bypass under intent.** `searchByHybridPages`
gates the saturation cutoff on `intent === null`:

```ts
if (intent === null && containsPages.length >= HYBRID_FALLBACK_THRESHOLD) {
  // contains-saturated branch — discard the parallel semantic call
} else {
  // RRF merge runs regardless of contains saturation
}
```

Without this gate, a naive intent implementation has no effect in
the common case: any non-trivial vault produces 3+ contains hits for
a one-word query, the saturation cutoff fires, and the
intent-augmented semantic call is built, dispatched, and discarded.
The cost of the bypass is small (one Map walk + one sort) but
observable — an agent passing intent on every call sees slightly
different ordering on queries that today saturate. The alternative
(keep the cutoff under intent) silently nullifies intent in the
common case, which is worse.

**Lane weighting under RRF when intent is set.** When intent
disables the cutoff, the RRF merge runs with `containsWeight = 2`
and `semanticWeight = 1`. Contains-precision still dominates
ordering (the literal-precision lane wins when both branches agree)
while the intent-augmented semantic lane can still surface a row
contains missed. This mirrors qmd's "original query ×2" rule. When
intent is unset, both weights default to `1` — byte-identical to
the pre-#17 RRF baseline. The `2` is empirical and the same
operator-tuning posture as `RRF_K`: a future env knob
(`LORE_HYBRID_CONTAINS_WEIGHT`) is the next step if real-query
ordering needs adjustment, not a per-call argument.

**Empty `query` composition.** The semantic branch composes its
`client.search` query as `[query.trim(), intent].filter(Boolean).join(" ")`,
so an empty `query` (allowed on `MemoryService.search` callers that
pass `""` for unscoped relevance lookups) produces `"intent"` rather
than `" intent"` — Notion's `client.search` may rank a leading-space
string differently from the bare term.

The contains-vs-semantic asymmetry is the load-bearing decision and
the most likely source of future regression. A future contributor
tempted to "make intent symmetric across both branches" would
silently re-introduce the recall-narrowing failure mode this
parameter exists to avoid.

### Diagnostic trace via `searchWithExplain`

`MemoryService.search` returns `Promise<Memory[]>` for every existing
caller; the contract is byte-stable. A sibling method
`searchWithExplain(input)` runs the same pipeline, returns the same row
order, and additionally surfaces per-row diagnostics aligned by index
(`explain[i]` describes `memories[i]`).

The two-method shape is deliberate. TypeScript overload signatures would
force every existing call site (including `loadWakeUpData`) to disambiguate
at the boundary, paying a typing tax for a feature 99% of callers don't
need. Two methods keep the contract clean and put the cost only on opt-in
callers.

The explain shape (`SearchExplain` in `src/types.ts`) carries:

- `memoryId` — the row's Notion page id.
- `containsRank` / `semanticRank` — 0-based rank within each branch, or
  `null` when that branch did not run, was discarded, or did not surface
  the row.
- `rrfScore` — populated only on the `"rrf"` branch.
- `branch` — the canonical signal: `"contains-only"`, `"semantic-only"`,
  `"contains-saturated"`, or `"rrf"`. Reflects the **resolved** mode (after
  `LORE_FORCE_SEMANTIC_SEARCH=1` is applied), not the caller's request.
- `confidenceFactor` — 0.8.0/#08. The factor multiplied into this row's
  per-branch RRF score: `[CONFIDENCE_FACTOR_MIN, 1.0]`, default `1.0`
  for unscored or fully-trusted rows. Populated on every branch.
  Pre-0.8.0 trace fixtures (deserialized from disk) lack the field;
  consumers tolerate the absence.

**Branch-field rules** (pinned by tests):

| Resolved mode                    | `branch`             | `containsRank`           | `semanticRank`           | `rrfScore`  |
| -------------------------------- | -------------------- | ------------------------ | ------------------------ | ----------- |
| `"contains"`                     | `contains-only`      | row position in contains | `null`                   | `null`      |
| `"semantic"` (incl. kill-switch) | `semantic-only`      | `null`                   | row position in semantic | `null`      |
| `"hybrid"`, saturated            | `contains-saturated` | row position in contains | **always `null`**        | `null`      |
| `"hybrid"`, RRF                  | `rrf`                | actual rank or `null`    | actual rank or `null`    | fused score |

The "saturated → semanticRank null" rule is load-bearing: the semantic
branch ran in parallel and may have returned the same id, but the
saturation cutoff discarded its output. Surfacing its rank in the trace
would imply influence on ordering that did not happen.

The explain trace is also surfaced through `lore-query
action='search'` via the optional `explain: boolean` field, rendered as a
`## Score trace` footer (one row per result). Agents that don't pass
`explain` pay zero output-token cost.

Field names (`containsRank`, `semanticRank`, `rrfScore`, `branch`,
`confidenceFactor`) are canonical to lore and a test pins them. qmd uses
`lexRank` for the contains lane; we keep `containsRank` because the
underlying Notion query is a `contains` filter, not a lexical index. A
future contributor chasing qmd's vocabulary would silently break the
contract.

### Materialization is a single pass

`searchByContainsPages` / `searchBySemanticPages` / `searchByHybridPages`
return raw `PageObjectResponse[]`. `search()` slices the merged result
to `limit` and runs `materializeMemories` exactly once on the survivors.
This is load-bearing: without it, hybrid's under-shooting path could
fetch markdown for `containsHits + semanticHits` candidates (potentially
100+) before the dedupe and `limit` cap. With the single-pass discipline,
hybrid never fetches markdown for a row that isn't in the final response.

### `includeContent: false`

`materializeMemories` honors `includeContent: false` to skip the per-page
`retrieveMarkdown` round-trip. Use it when the caller renders only title /
date / tags (e.g. the shell wake-up hook's related-memories section).

### Fetch/sort pipeline split (0.8.0/#08)

The single-branch and hybrid paths each apply `confidenceFactor` to the
RRF score **exactly once**. The split keeps that contract enforceable:

| Layer  | Function                               | Confidence-aware?                                    |
| ------ | -------------------------------------- | ---------------------------------------------------- |
| Fetch  | `fetchContainsPages(input)`            | No — raw Notion result                               |
| Fetch  | `fetchSemanticPages(input, intent)`    | No — raw Notion result                               |
| Public | `searchByContainsPages(input)`         | Yes — fetch + factor + sort                          |
| Public | `searchBySemanticPages(input, intent)` | Yes — fetch + factor + sort                          |
| Public | `searchByHybridPages(...)`             | Yes — composes raw fetch + factor in RRF accumulator |

Hybrid composes the **raw** fetch helpers, not the public confidence-
aware wrappers. If hybrid called `searchByContainsPages` /
`searchBySemanticPages`, the factor would be applied once in the
single-branch sort and again in the RRF accumulator — collapsing the
documented `[CONFIDENCE_FACTOR_MIN, 1.0]` floor to
`[CONFIDENCE_FACTOR_MIN², 1.0]` for hybrid callers (e.g. a row at
score 0.0 would multiply by 0.25, not 0.5).

`rerankByConfidence` (private, in `memory.ts`) is the shared
factor-then-sort applier used by both single-branch public wrappers.
It short-circuits when every input row is unscored
(`Confidence Score = null`) so pre-migration vaults see byte-identical
pre-0.8.0 ordering — without that gate, the page-id-ascending fall-
through in `tieBreakingRrfCompare` would re-sort otherwise-tied rows
into id order, masking Notion's recency / relevance ordering on
unmigrated vaults.

**Saturation cutoff is unchanged**. The cutoff already has a documented
bypass under `intent !== null`; 0.8.0 deliberately does NOT add a
"saturated-but-low-confidence" bypass. Even when contains saturates,
`confidenceFactor` reranks within the contains branch — a heavily-
decayed row at contains-rank 1 can sort below a fresh row at
contains-rank 2. If real-query feedback shows saturation suppressing
fresh semantic hits, a follow-up issue can introduce the second
bypass; track in `DEFERRED.md`.

### `LORE_DISABLE_CONFIDENCE_FACTOR=1` kill switch (0.8.0/#08)

Operator escape hatch at the top of `confidenceFactor` (`decay.ts`).
With the env var set, every call returns `1.0` unconditionally — a
sustained-failure rollback to pre-0.8.0 ranking, not a default. Same
posture as `LORE_FORCE_SEMANTIC_SEARCH` and
`LORE_DISABLE_NEAR_DUPLICATE_PROBE`. The check lives at the helper
boundary so single-branch and hybrid paths share one bypass.

### Kill switch: `LORE_FORCE_SEMANTIC_SEARCH=1`

Operator escape hatch checked inside `search()`. When set, every search
routes through the legacy workspace-wide path regardless of the caller's
`mode`. Use as a rollback if the contains path silently under-recalls in
a vault that hasn't run `lore migrate --fix-memory-encoding` yet —
encoded titles miss substring matches against post-decode queries
(see P2-10). Same posture as `LORE_DISABLE_NEAR_DUPLICATE_PROBE`: an
opt-in defensive lever, not a default.

The `list()` method uses `dataSources.query()` with property filters and is
suited for browsing recent memories by project/topic/source. It has no
substring-title filter — use `search()` for anything that needs relevance
ranking or body-text matching (e.g. `loadWakeUpData`'s related-memories pass,
which seeds a single query from active-task subjects).

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

| Method                          | Behavior                                                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `queryBySubject(subject, opts)` | Finds facts where `Subject` title contains the string; paginates until exhausted or `limit` is reached                                                                                                                                                       |
| `queryByObject(object, opts)`   | Same shape as `queryBySubject` but matches the `Object` rich-text property                                                                                                                                                                                   |
| `queryBySourceMemory(id, opts)` | Finds facts whose `Source` relation points at a given memory page                                                                                                                                                                                            |
| `queryByEntity(entity, opts)`   | Finds facts where the entity appears as either Subject or Object, deduplicates. `limit` is forwarded into both underlying branches as a `page_size` clamp + early-stop, then re-applied as a post-dedup slice so `limit: 25` never returns more than 25 rows |
| `queryOrphans(opts)`            | Returns current facts whose `Source` relation is empty. Used by `lore migrate --backfill-fact-sources`                                                                                                                                                       |

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
| `extendReview(id, reviewBy)`    | Push forward the `Review By` date                |
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

### `pageToFact` filters historical tracking-predicate rows

`pageToFact` returns `Fact | null`. It returns `null` when the row's raw
`Predicate` select value is one of the historical tracking strings
(`needs_action` / `waiting_on` / `blocked_by`). Notion's schema is
additive-only (`src/notion/setup.ts`), so those select options stay
registered and historical rows still exist for vaults that skipped the
`--migrate-tracking-to-tasks` migration before upgrading to 0.6.0.
Filtering at the deserialization boundary keeps the pre-#23 read shape
intact (`FactService.queryBySubject` etc. return `Fact[]`, not
`Fact | null[]`) — every caller narrows via `.filter(isFact)`.

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
from 79.6% to <50% on the Mail vault." The migration ships with
case-folding-only canonical clustering — `computeSubjectKey` collapses
case/whitespace/trailing-punct variants but does NOT recognize that
`MemoryService.create` is a richer-handle variant of `MemoryService`
or that `PR #25705 (SENTRY-MAIL-IOS-2E3)` is metadata-tagged onto the
same `PR #25705` entity. The next contributor evaluating whether to
ship a richer canonical clusterer needs to be able to compute this
metric without re-deriving the methodology.

**How to compute the metric** post-migration:

1. Snapshot every live fact:
   `dataSources.query` against the Facts DS, filter `Valid Until is_empty`,
   paginate to exhaustion. Project-scoped or vault-wide depending on
   what the spec criterion measures (Mail vault is project-scoped).
2. Group by canonical entity. The post-migration row's
   `SubjectEntity` relation IS the canonical key — empty relations
   mean the row hasn't been re-pointed (either pre-migration or a
   transient migration miss). For the metric, **count rows by
   `SubjectEntity[0]?.id ?? computeSubjectKey(Subject)`** so
   un-migrated rows still cluster by their case-folded form.
3. Compute `1 - groups_with_count >= 2 / total_groups`. The
   numerator is groups with at least one peer; the denominator is
   total distinct entities/keys. Pre-PF3-01 baseline on the Mail vault
   was 79.6% (560 facts → ~445 distinct subjects → ~89 had a peer).

The measurement script lives in spirit in
`src/cli/commands/migrate.ts:runBuildEntitiesMigration` — the
`factCount` field on each `EntityGroupPlan` is the raw input. A
follow-up that wires the metric into `lore status` (or a dedicated
`lore migrate --build-entities --report-orphan-rate`) would close the
measurability gap; until then operators run the numbers manually
against the `groupCount` / `factsRepointed` output of a `--dry-run`
pass.

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

| Flag                    | Target                              | Module                                 | Apply mode                                                                                                                                                   |
| ----------------------- | ----------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--fix-topic-encoding`  | Topics.Name                         | `topic-merge.ts:fixTopicEncoding`      | Applies unless `--dry-run`. Pair with `--merge-duplicate-topics` when cross-encoding pairs would collide post-decode.                                        |
| `--fix-fact-encoding`   | Facts.Subject + .Object + .DedupKey | `fact-encoding.ts:fixFactEncoding`     | **Plan-only by default; `--yes` applies.** Collision-gated against post-decode dedup-key conflicts — see below.                                              |
| `--fix-memory-encoding` | Memories.Title + body markdown      | `memory-encoding.ts:fixMemoryEncoding` | **Plan-only by default; `--yes` applies.** Skips archived memories; skips body rewrite (Title still fixed) when body exceeds `BODY_SIZE_CAP_BYTES` (100 KB). |

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
production Mail vault (`Claude Code`, `claude-code`, `Claude Opus 4.7
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

**Cached values are not cache hazards.** Negative lookups (null) are never
cached, and throws are never cached — only successful resolutions. Writes
invalidate:

**Stampede-safe via `LruCache.getOrLoad`.** `ProjectService.findByName`,
`TopicService.findByName`, and `DecisionService.getById` route their
Notion fetch through `cache.getOrLoad(key, loader)` rather than the
classic `cache.get(key) ?? fetch()` pattern, so concurrent cold-start
callers converging on the same key — `Promise.all` fan-outs in
`resolveCanonicalDecisionLinks`, parallel autosaves resolving the same
`topicName`, BFS walks hitting a shared ancestor — collapse onto a
single Notion call. `getOrLoad` keeps a `Map<K, Promise<V | null>>` of
in-flight loads keyed by cache key; the second concurrent miss finds the
pending promise and awaits the same underlying Notion call instead of
racing on its own loader. Rejected loaders clear the pending slot so the
next caller retries rather than observing a poisoned miss.

`MemoryService.getTitleById` is the one resolver that does **not** use
`getOrLoad`. Its title cache stores `null` tombstones for not-found /
permission-denied pages so the caller can skip the retry without
pessimising the hot path — and `getOrLoad`'s contract explicitly refuses
to commit `null` to the store. If `LruCache` ever grows a
`cacheNegatives: true` option, fold `titleCache` onto the shared
primitive as part of that work.

**Invalidation reaches the pending map.** `cache.delete(key)` and
`cache.clear()` drop both the stored value AND any in-flight `getOrLoad`
pending slot, and `getOrLoad`'s loader uses a promise-identity guard so
a stale in-flight read cannot commit back to the cache after an
intervening invalidation. This is what makes the
`delete(key); await getById(key)` write-then-read pattern in
`TopicService.getOrCreate` and `DecisionService.supersede` safe under
concurrent readers — a parallel `findByName` or `getById` in flight at
the moment of invalidation no longer poisons the writer's merge base.

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
  body-fetch enabled. Unlike the general probe, this is blocking: a
  match returns the existing row and the MCP save path creates nothing.
  It uses strict trigram checks for near-literal duplicate bodies plus a
  lightly-stemmed token Jaccard check for reordered same-fact phrasing.
  Project scope intentionally requires exact project-set equality and sets
  `includeUnscoped: false` so the assertive cross-session gate never
  collapses an A+B save into an A-only row and never becomes a vault-wide
  or repo-wide-unscoped scan; the shared `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1`
  kill switch or the narrower `LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1`
  switch disables reuse.
  When `LORE_DEBUG=1`, an auto-resolved catch-all downgrade emits
  `[lore] autosave-learning-dedup-scope-downgrade` with the project id and
  session so operators can distinguish an intentional same-session fallback
  from a missing duplicate.
  This is still a probe-then-create flow, not a Notion-side uniqueness
  guarantee. Concurrent Stop fires in separate worktrees can both miss
  each other during Notion query/index lag and create duplicate learning
  rows; follow-up GitHub issue #311 tracks a lock/coalescing layer, with
  `entity-relation-lock.ts` as the local pattern to evaluate.
  It deliberately does NOT use title-only similarity because two
  durable learnings can share a short title while carrying different
  facts. The client-side source/kind/confidence recheck duplicates the
  server filter on purpose so a future `MemoryService.list` regression
  cannot make synopsis rows block atomic-learning rows.

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
where the same `PR #25750` repeats 50 times in keywords would
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
column for storage, but the `PREDICATE_VALUES` allowlist in
`tools/knowledge.ts` excludes it — `decided_by` /
`supersedes_decision` / `informs` get the same treatment. Auto-emitted
facts ship at `confidence: speculative` so `lore-query action='ask'`
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

**Update-time re-emission (add-only, DEFERRED-03).**
`lore-memory action='update'` runs the same extraction over the
post-update title / keywords / synopsis, pre-queries existing
`mentions` facts sourced from this memory via
`FactService.queryBySourceMemory`, and emits `createWithDedup` only
for entities the graph doesn't already cover. The "covered" check
is by Object alone, deliberately: a title-only update changes
every existing fact's subject text but emits zero new rows.
**Stale facts (entities removed by the update) are NOT cleaned
up** — diff-and-invalidate would extend the auto-fact contract
with invalidation behavior owned by the explicit fact invalidation and
memory-compare surfaces; that contract is its own design decision, not
part of this follow-up. The advisory footer mirrors save
(`Auto-mentions: N new` / `Auto-mentions: K/N new attempted`) with the
`new` suffix distinguishing update-time emission from save-time. Same
`LORE_DISABLE_AUTO_MENTIONS=1` kill switch.

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
