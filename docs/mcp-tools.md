# MCP Tools

Lore exposes seven polymorphic tools, each multiplexing several actions behind
one MCP registration: `lore-context`, `lore-memory`, `lore-query`, `lore-fact`,
`lore-decision`, `lore-project`, and `lore-task`. The prior single-purpose tool
names and task aliases were removed in the 0.6.0 deprecation purge; see
[`src/mcp/AGENTS.md`](../src/mcp/AGENTS.md) for the historical timeline.

## `lore-context` — vault context

| Action    | Description                                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `status`  | Show vault status, topology health when configured, database counts, active project, task summary, proposed-memory inbox count, wake-up coverage counters, configured projects, and background hook failure markers |
| `wake-up` | Load latest digest, ranked/recent memories, tasks, active facts, decisions needing attention, and memories related to active tasks |
| `digest`  | Gather raw activity data for synthesis into a `source: "digest"` memory                                                            |

`lore-context action='status'` includes a `Background hooks` JSON block. The
object is shaped for agents to inspect directly:

```json
{
  "observedScope": "spawn/init/gather only; detached child exits are not tracked.",
  "failures": [
    {
      "kind": "autosave",
      "label": "autosave",
      "occurredAt": "2026-04-24T12:00:00.000Z",
      "scope": { "projectName": "Mail", "sessionId": "session-123" },
      "code": "binary-missing",
      "message": "background command not found",
      "logPath": "/tmp/lore-hook-state/digest-Mail.log",
      "next": "Check hooks.backgroundAgent.command or LORE_BACKGROUND_COMMAND, then trigger the hook again."
    }
  ],
  "totalRecent": 1,
  "showing": 1
}
```

An empty clean-state block renders `"failures": []`. The scope caveat is
intentional: Lore records foreground spawn/init/gather failures, but it does
not supervise detached background child exits after a successful spawn.
`failures` is capped to the 10 most recent markers; when more exist,
`showing` is lower than `totalRecent`. `kind` is one of `autosave`,
`digest-scheduler`, `digest-synthesizer`, or `auto-digest-helper-spawn`.
`logPath` is present only when the failure happened after a log file could
exist.

Pass `userQuery` to `wake-up` when rerunning context after `/clear`, a resume,
or a topic pivot; the response adds a **For Your Current Task** section ranked
against that prompt.

Pass `debug: true` to `wake-up` when investigating why a context load is too
thin or too noisy. The response appends privacy-conscious coverage counters
for mode, caps, section counts, and digest age; it does not include titles,
facts, memory bodies, or the raw `userQuery`.

## `lore-memory` — memory mutations + batch hydration

| Action              | Description                                                                                                                                                                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `save`              | Save a new memory (markdown content stored as page body)                                                                                                                                                                                   |
| `update`            | Update a memory's title, content, tags, or categorization                                                                                                                                                                                  |
| `archive`           | Soft-delete a memory by ID                                                                                                                                                                                                                 |
| `expand`            | Batch-fetch memory bodies by ID (up to 20, parallelized)                                                                                                                                                                                   |
| `suggest-topic-key` | Suggest a stable topic key for recurring memory topics                                                                                                                                                                                     |
| `compare`           | Record a conflict/compatibility verdict on a pair of memories                                                                                                                                                                              |
| `approve`           | Promote a `Status: proposed` memory to `accepted` and append a `## Reviewed (date)` audit block (issue #281). Inbox-only — non-proposed rows reject. Optional `reviewer` defaults to the engineer-identity resolver; optional `reason` recorded in audit body. |
| `reject`            | Flip a `Status: proposed` memory to `rejected` and append the same audit block. Same inbox-only state guard as `approve`. Rejected rows are excluded from default `lore-query action='recall'` / `'search'`; surface them via explicit `status: "rejected"`.  |

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
| `create`     | Add a subject-predicate-object fact triple. Requires a live, project-compatible Memories row via `sourceMemoryId` or `agent`+`session` that auto-links a compatible source memory before writing. Tracking predicates (`needs_action` / `waiting_on` / `blocked_by`) are rejected post-P3-02 — use `lore-task action='create'` instead. |
| `invalidate` | Invalidate a fact (sets Valid Until date, preserves history)                                                                                                                      |
| `extend`     | Set, advance, or clear a fact's review-by date                                                                                                                                    |

After P3-02, `lore-query action='ask'` also surfaces tasks touching the entity.
For tracked work triage, use `lore-task action='list'`. Un-migrated vaults may
still contain historical tracking-predicate facts; `lore status` reports those
rows for manual remediation.

This is an unreleased agent-observable behavior change: MCP fact creation
without usable provenance now hard-errors instead of warning and writing a
source-less fact. This is tool-surface enforcement, not a Notion schema
invariant; direct Notion writes outside Lore can still create sourceless Fact
rows.

Stable provenance error reasons:

- `provenance-missing` — neither a non-empty `sourceMemoryId` nor a complete
  non-empty `agent`+`session` pair was provided.
- `provenance-source-unresolved` — explicit `sourceMemoryId` did not resolve to
  a live Memories row.
- `provenance-source-cross-project` — explicit `sourceMemoryId` resolved but
  its project scope is incompatible with the fact.
- `provenance-unresolved` — `agent`+`session` was provided, but this process has
  no compatible session memory recorded for that composite key.
- `provenance-cross-project` — session auto-link found a memory, but its
  project scope is incompatible with the fact.

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
| `review`    | Mark a decision as reviewed; set, advance, or clear `Review By`                               |

## `lore-project` — project read paths

| Action | Description                                                                                 |
| ------ | ------------------------------------------------------------------------------------------- |
| `list` | List active projects; `status: "archived"` is archived-only and `status: "any"` lists both |
| `get`  | Get active project details, topics, and recent activity                                     |
