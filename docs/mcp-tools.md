# MCP Tools

Lore exposes nine polymorphic tools, each multiplexing several actions behind
one MCP registration: `lore-context`, `lore-memory`, `lore-pinned`,
`lore-query`, `lore-fact`, `lore-decision`, `lore-project`, `lore-task`, and
`lore-procedure`. The prior single-purpose tool names and task aliases were
removed in the 0.6.0 deprecation purge; see
[`src/mcp/AGENTS.md`](../src/mcp/AGENTS.md) for the historical timeline.

## `lore-context` — vault context

| Action    | Description                                                                                                                                                                                                                                                                                                                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`  | Show vault status, active profile, topology health when configured, database counts, active project, task summary, proposed-memory inbox count, wake-up coverage counters, configured projects, and background hook failure markers                                                                                                                                                                       |
| `wake-up` | Load latest digest, ranked/recent memories, tasks, active facts, decisions needing attention, memories related to active tasks, and inherited upstream memories per configured `upstreamVaults` entry (issue #286 — sparse and labeled per upstream, bounded per `inheritedMemoryLimit` default 3; failed upstreams render as `> upstream unavailable: <message>` without suppressing surviving sections) |
| `digest`  | Gather raw activity data for synthesis into a `source: "digest"` memory                                                                                                                                                                                                                                                                                                                                   |

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
      "scope": { "projectName": "Widget", "sessionId": "session-123" },
      "code": "binary-missing",
      "message": "background command not found",
      "logPath": "/tmp/lore-hook-state/digest-Widget.log",
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

The active profile controls write-time tag validation, entity kind options,
and writable fact predicates. Tag read filters remain permissive so agents can
find legacy or out-of-profile rows. See [`profiles.md`](profiles.md).

## `lore-memory` — memory mutations + batch hydration

| Action              | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `save`              | Save a new memory (markdown content stored as page body)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `update`            | Update a memory's title, content, tags, or categorization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `archive`           | Soft-delete a memory by ID                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `expand`            | Batch-fetch memory bodies by ID (up to 20, parallelized)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `suggest-topic-key` | Suggest a stable topic key for recurring memory topics                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `compare`           | Record a conflict/compatibility verdict on a pair of memories                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `approve`           | Promote a `Status: proposed` memory to `accepted` and append a `## Reviewed (date)` audit block (issue #281). Inbox-only — non-proposed rows reject. Optional `reviewer` defaults to the engineer-identity resolver; optional `reason` recorded in audit body.                                                                                                                                                                                                                                                                                  |
| `reject`            | Flip a `Status: proposed` memory to `rejected` and append the same audit block. Same inbox-only state guard as `approve`. Rejected rows are excluded from default `lore-query action='recall'` / `'search'`; surface them via explicit `status: "rejected"`.                                                                                                                                                                                                                                                                                    |
| `promote`           | Copy a memory into a configured promotion target (`promotionTargets` in `.lore.yaml`) with a `## Promoted from <vault>` audit block carrying source vault label, source memory id + URL, kind/status/confidence/synopsis, promoter, timestamp, and optional `reason` (issue #286). `requireReview: true` targets land the promoted row as `Status: proposed`; otherwise the source's status passes through. Project relations, tags, and agent/session attribution do NOT cross the vault boundary. See [`topology.md`](topology.md#promotion). |

### Scope and lifetime (`scope` parameter, issue #283)

`save` and `update` accept an optional `scope` bundle that declares
who the row applies to and how it expires. Default reads exclude
narrow-scope rows whose `Scope Key` does not match the resolved
scope context, so a session note from one engineer's debugging run
does not leak into another session's recall.

```json
{
  "scope": {
    "kind": "team | project | user | agent | role | session | run | environment | global",
    "key": "<stable identifier within the kind>",
    "audience": "<free-form text>",
    "lifetime": "persistent | expires | session-only | until-task-closed | until-decision-superseded",
    "expiresAt": "YYYY-MM-DD"
  }
}
```

- **Broadcast scopes** (`team`, `project`, `global`) surface for every
  reader by default.
- **Narrow scopes** (`user`, `agent`, `role`, `session`, `run`,
  `environment`) require the reader's matching context value
  (resolved from `LORE_USER_NAME` / `LORE_AGENT_NAME` / `LORE_ROLE`
  / `LORE_SESSION_ID` / `LORE_RUN_ID` / `LORE_ENVIRONMENT`) to equal
  `scope.key`. A missing identity slot drops every row carrying that
  scope kind; there is no fallback wildcard.
- **Expiry**: `expires` lifetime requires `expiresAt`; rows with
  `expiresAt < today` drop out of default reads (`lore status`
  surfaces them under "Expired scoped rows" for cleanup).
  `until-task-closed` and `until-decision-superseded` are
  declarative — retrieval already drops closed tasks and superseded
  decisions via the existing state filters.

On `update`, every field is optional with clear-aware semantics:
omit to leave the column untouched, pass `null` on the select / date
columns to clear, or pass an empty string on the rich_text columns
to clear. Pre-#283 rows have all five columns null and pass through
default reads byte-identically.

## `lore-pinned` — pinned context blocks (issue #282)

| Action   | Description                                                                                                                                                                                                                                                |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pin`    | Flip an existing memory into a pinned context block. Sets `priority` (sort order; higher first), `audience` (comma-separated tokens, reused from issue #283's `Audience` column), and `mutability` (`mutable` default or `read-only`).                     |
| `unpin`  | Flip a pinned block back to a regular memory. Rejects when `Mutability = read-only` unless a separate `lore-pinned action='update'` flips mutability first.                                                                                                |
| `update` | Change priority / audience / mutability on an existing pin. Pass `force: true` to override `Mutability: read-only` — every override appends a `> Forced read-only update` audit line to the memory body.                                                   |
| `list`   | List active pinned blocks for the current project + audience. `includeAllAudiences: true` skips the audience filter for operator inspection across audiences. `audience: "<token>"` simulates a specific reader's perspective. Default cap is 10, max 100. |

Pinned context blocks render in `lore-context action='wake-up'` under
a dedicated `## Pinned Context` section BEFORE the relevance-ranked
sections (digest / recent / for-your-current-task). Audience matching
is comma-split + case-folded against the reader's resolved scope
context (`LORE_USER_NAME` / `LORE_AGENT_NAME` / `LORE_ROLE`); `all`
/ `*` / `everyone` / `agents` are universal tokens. Empty audience
matches every reader.

Every pin / unpin / update appends an audit line to the memory body
(`> <Action> <YYYY-MM-DD> by <author>: <reason>`) so the change is
recoverable from the row itself without consulting an external audit
log (AC #4).

## `lore-query` — vault read paths

| Action   | Description                                                                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `recall` | List recent memories with optional filters                                                                                                                                                                                                                       |
| `search` | Memory search; `mode` accepts `contains`, `semantic`, or `hybrid` and defaults to `hybrid`. `contains` is DS-scoped substring search with server-side filters, `semantic` is workspace-wide vector ranking over titles and bodies, and `hybrid` runs both lanes. |
| `ask`    | Query facts and tasks about an entity. Pass `asOf: 'YYYY-MM-DD'` for transaction-time as-of recall (what Lore knew at that date), or `includeHistory: true` to surface invalidated facts inline (issue #284).                                                    |
| `audit`  | List overdue facts, decisions, and tasks past their review date                                                                                                                                                                                                  |

## `lore-fact` — knowledge graph mutations

| Action       | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`     | Add a subject-predicate-object fact triple. Requires a live, project-compatible Memories row via `sourceMemoryId` or `agent`+`session` that auto-links a compatible source memory before writing. Tracking predicates (`needs_action` / `waiting_on` / `blocked_by`) are rejected post-P3-02 — use `lore-task action='create'` instead. Accepts the same `scope` bundle as `lore-memory` (issue #283); scope participates in dedup so a session-scoped fact does NOT merge into an existing team-scoped row of the same triple. |
| `invalidate` | Invalidate a fact (sets `Valid Until` and `Invalidated At` to today, preserves history). Pass `sourceMemoryId` to record which memory prompted the invalidation in the fact's `Invalidated By` relation (issue #284 — distinct from `Source`, which names the supporting memory at creation time).                                                                                                                                                                                                                              |
| `extend`     | Set, advance, or clear a fact's review-by date                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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

| Action       | Description                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `create`     | Create a task with subject, description, state, blocker, and due date. Accepts the issue #283 `scope` bundle; the conventional pairing is `scope: { kind: "session", key: "<session-id>", lifetime: "until-task-closed" }` for per-session tracked work.                                                                                                     |
| `update`     | Update a task's state, blocker, due date, subject, or description. Same `scope` bundle as `create`; absent fields leave columns untouched.                                                                                                                                                                                                                   |
| `close`      | Mark a task done (or cancelled — distinguished for metrics). Optional `reason` appends a structured closure note when the task was active.                                                                                                                                                                                                                   |
| `close-many` | Close an explicit `ids` array with the same semantics as `close`. Blank IDs are ignored, duplicates are de-duplicated in first-seen order, and partial failures are reported per ID.                                                                                                                                                                         |
| `list`       | List tasks with Overdue/Active sections; filters by entity, state, due. Default reads apply the issue #283 scope filter so narrow-scope tasks from another reader's session/agent/role drop out. The `includeOutOfScope` opt-out is service-internal only; the `lore status` expiring-rows counters call it directly, but it is not exposed on the MCP tool. |
| `reconcile`  | Surface likely active tasks that can be closed from newer evidence                                                                                                                                                                                                                                                                                           |

The old single-purpose task aliases were removed in 0.6.0; use the polymorphic
`lore-task` dispatcher.

Current releases no longer ship the tracking-predicate migration command. If
`lore status` reports historical tracking facts, restore that migration from
git history and run it manually against the vault, or hand-edit the Notion rows
into tasks.

## `lore-decision` — decision lifecycle

| Action      | Description                                                                                                                                                                                                                                    |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create`    | Record a decision with rationale, alternatives, consequences; auto-creates `decided_by` facts. Accepts the issue #283 `scope` bundle; the conventional pairing for governance decisions is `scope: { lifetime: "until-decision-superseded" }`. |
| `list`      | Index-tier listing of decisions (no body fetch). Default reads apply the issue #283 scope filter. The `includeOutOfScope` opt-out is service-internal only and not exposed on the MCP tool surface.                                            |
| `get`       | Load full rationale + metadata for a specific decision                                                                                                                                                                                         |
| `context`   | Find every decision governing an entity via the facts graph                                                                                                                                                                                    |
| `supersede` | Mark an old decision as superseded by a new one; creates a `supersedes_decision` fact                                                                                                                                                          |
| `review`    | Mark a decision as reviewed; set, advance, or clear `Review By`                                                                                                                                                                                |

## `lore-procedure` — reusable procedural memory

Procedures are reviewed, fleet-wide operating knowledge promoted from
resolved episodes (closed tasks, resolved incidents, postmortems, runbooks).
Adapted from LangMem's episodic / semantic / procedural taxonomy. Always
gated by human or authorized-agent review — raw session summaries never
become fleet-wide procedures.

| Action            | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scan-candidates` | Read-only mining over the project's incidents / postmortems / runbooks and closed tasks. Clusters supporting memories by entity, ranks by count + kind diversity + recency, returns the top candidates. `limit` and `minScore` are optional knobs.                                                                                                                                                                                                                           |
| `propose`         | Create a `Kind: procedure, Status: proposed` memory with structured `## Activation Conditions`, `## Steps`, optional `## Known Failure Modes`, and `## Sources`. Requires at least one non-blank step (whitespace-only steps are rejected at the schema boundary) and at least two `sourceMemoryIds` (mirrors the scan's `PROCEDURE_MIN_SOURCES` threshold so the propose path cannot bypass the auditable evidence trail). Supports `supersedesIds` for replacement chains. |
| `deprecate`       | Status flip on an accepted procedure (`accepted` → `deprecated`). Rejects `Status: proposed` rows (those leave via `lore-memory action='reject'`). Rejects `superseded` / `rejected` rows (already left accepted recall via a different audit path). Optional `reason` (capped at 500 chars) is appended as a `## Deprecated` audit block to the body. Idempotent on already-deprecated rows.                                                                                |

Approval after `propose` flows through `lore-memory action='approve'` —
the existing inbox-review path. The propose surface deliberately does NOT
expose an `approve` action of its own so the audit contract (`recordReview`
plus the `## Reviewed (YYYY-MM-DD)` audit block) has exactly one entrypoint.

Supersession is a two-step workflow: pass `supersedesIds: [<old-id>]`
at `propose` time so the new row records the chain, then run
`lore-procedure action='deprecate'` on each predecessor after the
replacement is approved. The propose response surfaces ready-to-paste
deprecate commands when `supersedesIds` is set so the operator can't
miss the second step. The compare-supersedes path
(`lore-memory action='compare'` with `verdict: 'supersedes'`) is
**decision-only**: the compare handler rejects non-decision kinds, so
it cannot replace a procedure.

## `lore-project` — project read paths

| Action | Description                                                                                |
| ------ | ------------------------------------------------------------------------------------------ |
| `list` | List active projects; `status: "archived"` is archived-only and `status: "any"` lists both |
| `get`  | Get active project details, topics, and recent activity                                    |
