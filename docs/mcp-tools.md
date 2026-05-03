# MCP Tools

Lore exposes seven polymorphic tools, each multiplexing several actions behind
one MCP registration: `lore-context`, `lore-memory`, `lore-query`, `lore-fact`,
`lore-decision`, `lore-project`, and `lore-task`. The prior single-purpose tool
names and task aliases were removed in the 0.6.0 deprecation purge; see
[`src/mcp/AGENTS.md`](../src/mcp/AGENTS.md) for the historical timeline.

## `lore-context` — vault context

| Action    | Description                                                                                                                        |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `status`  | Show vault status, database counts, and active project                                                                             |
| `wake-up` | Load latest digest, ranked/recent memories, tasks, active facts, decisions needing attention, and memories related to active tasks |
| `digest`  | Gather raw activity data for synthesis into a `source: "digest"` memory                                                            |

Pass `userQuery` to `wake-up` when rerunning context after `/clear`, a resume,
or a topic pivot; the response adds a **For Your Current Task** section ranked
against that prompt.

## `lore-memory` — memory mutations + batch hydration

| Action              | Description                                                   |
| ------------------- | ------------------------------------------------------------- |
| `save`              | Save a new memory (markdown content stored as page body)      |
| `update`            | Update a memory's title, content, tags, or categorization     |
| `archive`           | Soft-delete a memory by ID                                    |
| `expand`            | Batch-fetch memory bodies by ID (up to 20, parallelized)      |
| `suggest-topic-key` | Suggest a stable topic key for recurring memory topics        |
| `compare`           | Record a conflict/compatibility verdict on a pair of memories |

## `lore-query` — vault read paths

| Action   | Description                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recall` | List recent memories with optional filters                                                                                                                                                                                                                       |
| `search` | Memory search; `mode` accepts `contains`, `semantic`, or `hybrid` and defaults to `hybrid`. `contains` is DS-scoped substring search with server-side filters, `semantic` is workspace-wide vector ranking over titles and bodies, and `hybrid` runs both lanes. |
| `ask`    | Query facts and tasks about an entity                                                                                                                                                                                                                            |
| `audit`  | List overdue facts, decisions, and tasks past their review date                                                                                                                                                                                                  |

## `lore-fact` — knowledge graph mutations

| Action       | Description                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`     | Add a subject-predicate-object fact triple. Tracking predicates (`needs_action` / `waiting_on` / `blocked_by`) are rejected post-P3-02 — use `lore-task action='create'` instead. |
| `invalidate` | Invalidate a fact (sets Valid Until date, preserves history)                                                                                                                      |
| `extend`     | Push a fact's review-by date forward                                                                                                                                              |

After P3-02, `lore-query action='ask'` also surfaces tasks touching the entity.
For tracked work triage, use `lore-task action='list'`. Un-migrated vaults may
still contain historical tracking-predicate facts; `lore status` reports those
rows for manual remediation.

## `lore-task` — tracked work

`Kind = task` memories supersede the legacy tracking-predicate facts
(`needs_action` / `waiting_on` / `blocked_by`). The description lives in the
page body, with no rich_text length cap, and the subject is structurally indexed
so structural queries actually work.

| Action      | Description                                                            |
| ----------- | ---------------------------------------------------------------------- |
| `create`    | Create a task with subject, description, state, blocker, and due date  |
| `update`    | Update a task's state, blocker, due date, subject, or description      |
| `close`     | Mark a task done (or cancelled — distinguished for metrics)            |
| `list`      | List tasks with Overdue/Active sections; filters by entity, state, due |
| `reconcile` | Surface likely active tasks that can be closed from newer evidence     |

The old single-purpose task aliases were removed in 0.6.0; use the polymorphic
`lore-task` dispatcher.

Current releases no longer ship the tracking-predicate migration command. If
`lore status` reports historical tracking facts, restore that migration from
git history and run it manually against the vault, or hand-edit the Notion rows
into tasks.

## `lore-decision` — decision lifecycle

| Action      | Description                                                                                   |
| ----------- | --------------------------------------------------------------------------------------------- |
| `create`    | Record a decision with rationale, alternatives, consequences; auto-creates `decided_by` facts |
| `list`      | Index-tier listing of decisions (no body fetch)                                               |
| `get`       | Load full rationale + metadata for a specific decision                                        |
| `context`   | Find every decision governing an entity via the facts graph                                   |
| `supersede` | Mark an old decision as superseded by a new one; creates a `supersedes_decision` fact         |
| `review`    | Mark a decision as reviewed, push `Review By` forward                                         |

## `lore-project` — project read paths

| Action | Description                                      |
| ------ | ------------------------------------------------ |
| `list` | List all projects in the vault                   |
| `get`  | Get project details, topics, and recent activity |
