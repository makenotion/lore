# Memory Debt Audit

`lore debt` is the recurring maintenance workflow for a shared Lore vault.
`scan` is a read-only inventory of hygiene problems across the vault,
ranked by likely impact on retrieval and governance. `create-tasks`
folds the highest-priority debt items into normal `lore-task` triage so
memory hygiene becomes regular work rather than a one-off cleanup.

The scanner does not mutate any Notion row by default. Every remediation
is recommended through suggested commands; the operator (or the agent
reviewing the report) decides what to act on.

## Why memory debt is a first-class workflow

A shared memory corpus decays without explicit maintenance. Stale,
duplicate, ownerless, or orphaned rows quietly affect every engineer and agent
that relies on wake-up / search / ask. Lore already has individual hygiene
surfaces — `lore conflicts scan`, `lore status`'s proposed-memories line, and
scope-expiry checks — but they are scattered across several commands.
`lore debt scan` collapses them into one operator-pulled audit that answers a
single question:

> What memory debt is accumulating in this vault, what should I fix
> first, and what command would remediate it?

## Debt categories

The scanner currently classifies findings into eight categories. Each
category reuses an existing service surface — the scanner is an
orchestrator, not a re-implementation of vault walking.

| Category             | Source                                                                                                   | What it surfaces                                                                                                                                                                    |
| -------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `orphan_fact`        | `FactService.queryOrphans` (bounded by `--per-category-limit + 1`)                                       | Active facts whose `Source` relation is empty (no supporting memory).                                                                                                               |
| `overdue_governance` | `FactService.queryOverdue`, `DecisionService.queryOverdue`, `TaskService.queryOverdue` + `taskDaysStale` | Facts / decisions / tasks past their `Review By` date, plus active tasks untouched ≥ `STALE_TASK_DAYS`.                                                                             |
| `duplicate_cluster`  | `MemoryService.listForScan` + `findConflictCandidates`                                                   | Memory pairs whose `title + keywords` trigram overlap or tag overlap crosses threshold and that share at least one project, filtering out pairs already judged via `Compared With`. |
| `topic_sprawl`       | `findSimilarTopicGroups`                                                                                 | Topic groups whose stored names differ but normalize to the same key.                                                                                                               |
| `scope_anomaly`      | `loadExpiringScopedStatus` (issue #283 columns)                                                          | Counts of expired / expiring-soon / narrow-scope-out-of-context rows.                                                                                                               |
| `operational_expiry` | `MemoryService.list(kind: "operational")` + task/PR closure checks                                       | Operational memories missing expiry metadata, or whose linked PR/task closure has happened.                                                                                         |
| `summary_quality`    | `MemoryService.list(source: "digest")` + synopsis audit                                                  | Digest bodies and synopses that read like chronological logs instead of durable signal.                                                                                             |
| `ownerless`          | `MemoryService.list` (paginated)                                                                         | Memories in a project that have no Topic AND no author/agent attribution.                                                                                                           |

### Prerequisites and category semantics

- **`scope_anomaly` requires the issue #283 schema columns** (`Scope Kind`,
  `Expires At`, …). On a pre-#283 vault the probe degrades to
  `stats.scopeAnomalies: null` and the rest of the scanner runs regardless.
  Run `lore migrate` to enable the surface.
- **`operational_expiry` is for temporary rows only.** Use
  `kind: "operational"` for PR poll state, closeout receipts, and other
  execution breadcrumbs. Add `expiresAt` or `expiresOn` when creating the
  row; retroactively add it with `lore memory update <id> --expires-at ...`,
  `lore memory update <id> --expires-on ...`, or
  `lore-memory action='update'`. `task-closed` markers resolve through Lore
  tasks; `pr-closed` markers resolve through the GitHub pull-request API, using
  `GITHUB_TOKEN` or `GH_TOKEN` when private-repo access needs a token.
- **`summary_quality` audits scan surfaces.** Digest bodies and
  `Synopsis` values should contain durable signal, not chronological
  session narration.
- **`overdue_governance` fuses three signals**: overdue facts /
  decisions / tasks past their `Review By`, AND active tasks untouched
  ≥ `STALE_TASK_DAYS` (the "stale-task" signal). All items in this
  category carry one of four **stable id prefixes** so JSON consumers
  can split them client-side without re-deriving the classification:

  | Prefix                   | What it signals                                           |
  | ------------------------ | --------------------------------------------------------- |
  | `overdue_fact::<id>`     | Fact past `Review By`, still active.                      |
  | `overdue_decision::<id>` | Decision past `Review By`, still `accepted` / `proposed`. |
  | `overdue_task::<id>`     | Task past `Review By`, still in an active state.          |
  | `stale_task::<id>`       | Active task untouched ≥ `STALE_TASK_DAYS`.                |

  The id prefix is part of the schema contract — a consumer can write
  `if (item.id.startsWith("stale_task::"))` to triage stale rows
  separately. The markdown renderer groups them under the same
  priority bucket as overdue rows.

- **Overdue tasks are warning-only.** `Review By` is the task review /
  due date; it does not cancel, archive, expire, or otherwise mutate
  a task by itself. Operators close or extend overdue tasks explicitly
  after reading the task and any supporting evidence.

## Scoring and priority

Each detected item gets a numeric score blending five inputs (the
formula from issue #288):

```text
score = severityWeight + retrievalRisk + stalenessWeight
      + governanceRisk
```

- **`severityWeight`** is a category default. Orphan facts and overdue
  governance start higher than topic sprawl.
- **`retrievalRisk`** rises when the row is likely to surface often
  (recent edits, broad project scope, decision / policy / runbook kinds).
- **`stalenessWeight`** scales with `Review By` overdue days and active-task
  age past the stale-task cutoff.
- **`governanceRisk`** weights decisions / policies / runbooks / facts
  higher than ordinary notes.

Priority bins:

| Bucket | Score band        | Meaning                                                                             |
| ------ | ----------------- | ----------------------------------------------------------------------------------- |
| P1     | `score ≥ 70`      | Triage now. Orphan facts and overdue decisions land here by default.                |
| P2     | `40 ≤ score < 70` | Plan into the next maintenance pass. Duplicate clusters and stale task signals.     |
| P3     | `score < 40`      | Background hygiene. Topic sprawl, ownerless notes, low-impact stale signals.        |

The formula is a prioritization aid, not objective truth. Tune the
`SEVERITY_WEIGHT` table or the priority thresholds in
`src/core/memory-debt.ts` if real-vault data shows the bands shifting too
hot or too cold. The load-bearing contract is **stable, deterministic
ordering** so re-running the scanner over the same vault state produces
the same JSON.

## Output

By default, the scan emits a markdown report grouped by priority. Each
item carries:

- A category label, score, and entity type.
- A `Why:` block listing the structural signals that put the row on the
  list.
- A `Suggested:` list of short verbs (`attach_source`, `archive`,
  `compare_memories`, ...) the operator can map to specific commands.

Pass `--json` for a stable schema suitable for automation:

```json
{
  "project": "Mail",
  "scannedAt": "2026-05-12T17:00:00.000Z",
  "today": "2026-05-12",
  "summary": { "total": 37, "p1": 4, "p2": 12, "p3": 21, "byCategory": { ... } },
  "items": [
    {
      "id": "orphan_fact::<fact-id>",
      "priority": "P1",
      "category": "orphan_fact",
      "entityType": "fact",
      "entityId": "<fact-id>",
      "title": "AuthService depends_on SessionStore",
      "score": 72,
      "reasons": ["Source relation is empty", "Fact is still active (no Valid Until)"],
      "suggestedActions": ["attach_source", "invalidate_fact", "recreate_with_provenance"],
      "safeToAutoFix": false
    }
  ],
  "stats": { ... }
}
```

`safeToAutoFix` is always `false`. The field is part of the stable JSON schema,
but no shipped command treats it as actionable. Consumers MUST NOT key behavior
off `safeToAutoFix: true`; the flag is currently a no-op signal.

`stats.scopeAnomalies` semantics:

- A **non-null number** means the scope-anomaly probe ran successfully and observed that many anomalies (including `0`).
- `null` means the probe was attempted but the underlying data source lacks the issue-#283 columns (pre-#283 vault). Operators run `lore migrate` to enable.
- `0` paired with `stats.scopeAnomalyProbeSkipped: true` means the scope category was filtered out by `--category`; the probe never ran. Consumers check `scopeAnomalyProbeSkipped` before treating `null` as a degraded-probe signal.

The `stats` block reports per-category counters and these diagnostic fields:

- `truncated` — output exceeded `--limit`; raise `--limit` for more.
- `orphanFactsCapped` — `queryOrphans` hit `perCategoryLimit + 1` and
  more orphan facts exist past the inspected window.
- `staleTasksScanCapped` — the stale-task probe stopped after
  inspecting `perCategoryLimit` active tasks without exhausting Notion.
- `ownerlessScanCapped` — same shape for the ownerless-memory probe.
- `operationalMemoriesInspected` and `operationalExpiryIssues` count the
  operational-expiry audit surface.
- `summaryQualityCandidates` and `logShapedSummaries` count audited digest /
  synopsis rows and deterministic quality failures. For `Synopsis`, the
  per-category limit caps auditable synopsis rows; the scanner may walk past
  rows with empty synopses to reach that cap.
- `scopeAnomalies` is `null` on pre-#283 vaults (probe degraded) so
  consumers can distinguish "no debt detected" from "scanner couldn't
  probe that category."
- `scopeAnomalyProbeSkipped` is `true` when category filtering excludes
  the scope-anomaly probe; consumers check it before interpreting
  `scopeAnomalies`.

When any of the three `*Capped` flags fires, the markdown report
appends a `_Per-category scan window hit …_` footer naming the
affected categories and prompting the operator to raise
`--per-category-limit`.

## Recommended workflow

A monthly cadence is the starting point; tune to vault activity.

```bash
# 1. Scan and review priority bucket P1/P2 by hand.
lore debt scan --project Mail
lore debt scan --project Mail --json > debt.json   # for automation / dashboards

# 2. Drill into one dimension when triaging.
lore debt scan --project Mail --category orphan_fact
lore debt scan --project Mail --category duplicate_cluster --limit 20

# 3. Fold the highest-priority items into normal task hygiene.
lore debt create-tasks --project Mail --dry-run    # preview
lore debt create-tasks --project Mail              # creates P1/P2 tasks (cap 25)
lore debt create-tasks --project Mail --priority-floor P1   # P1 only

# 4. Act on individual rows — the scanner's suggestedActions name the path:
#    - `attach_source`              → save a supporting memory, then re-run
#                                      `lore-fact action='create'` with the
#                                      same triple and `sourceMemoryId` set.
#    - `compare_memories`           → `lore conflicts scan --project ...`
#                                      surfaces the same pair as a compare
#                                      candidate; judge via
#                                      `lore-memory action='compare'`.
#    - `merge_topics_dry_run`       → `lore migrate --merge-duplicate-topics`
#                                      (dry-run first).
#    - `archive_expired_memories` / `invalidate_expired_facts`
#                                   → review under `lore status`'s
#                                      expiring-rows section, then archive /
#                                      invalidate individually.
#    - `review_and_extend`          → bump `reviewBy` on the decision or fact
#                                      via the normal update tools.

# 5. Re-scan until the report is clean.
lore debt scan --project Mail
```

## `lore debt create-tasks`

`create-tasks` lets a team fold memory maintenance into the same `lore-task`
triage loop they use for normal work. The command:

- Reuses `scanDebt`'s result, then filters by `--priority-floor` (default
  `P2`; pass `P1` to surface only the most severe items).
- Defaults to a 25-task cap per run. Raise deliberately via `--limit`.
- Stamps each task with `Tags: [audit]`, a `Debt ID: <id>` line in the
  body, and the stable `lore-debt-id-<…>` marker token in `Keywords`.
- Is **idempotent on debt id**: before creating, the command searches
  for an existing task carrying the marker token via three coverage
  passes that span the full `MemoryStatus` space. The default pass
  (no `status:` filter) relies on Notion's `does_not_equal` filter
  being permissive on null, so it matches the empty-`Status` rows
  `TaskService.create` produces AND `informational` / `accepted` /
  `deprecated` / `superseded`. Two explicit passes cover `proposed`
  and `rejected` (these are excluded by the default-recall filter).
  Together the three passes find every marker-bearing task regardless of
  lifecycle state. A reused row reports as `REUSE task: ... (existing <id>)`
  in the plan output and contributes to
  the trailing `Created N tasks, reused M tasks.` summary. Closed
  (`done` / `cancelled`) tasks the operator previously closed also
  count as a reuse hit — re-running `create-tasks` honors a prior
  explicit close.
- Is **cross-scope safe**: a debt task created during a vault-wide
  run carries `projectIds: []`; one created under `--project Mail`
  carries `projectIds: ["proj-a"]`. The probe routes through
  `MemoryService.search`'s `projectOrUnscopedFilter`, which is
  `Project relation contains <id> OR Project is_empty`. So a
  vault-wide-created task surfaces under a later `--project Mail`
  rerun, and a scoped task surfaces under a later vault-wide rerun.
  Either direction collapses onto the existing row instead of
  minting a duplicate.

`--dry-run` prints the would-create plan (including reuse outcomes)
without writing to Notion. `--priority-floor P3` is intentionally
rejected — surfacing P3 items as tasks would routinely create dozens
of low-impact rows per run.

**Partial-failure contract**: if any per-item `tasks.create` call
throws, the command writes one stderr line per failure and exits with
code `1`. Automation wrapping `lore debt create-tasks` can therefore
distinguish a clean maintenance pass from an incomplete one without
parsing the trailing count line.

## Cost on a vault-wide scan

A vault-wide scan (`--all-projects`, or `--project` omitted) walks the
category branches sequentially within `scanDebt`. Each branch
issues its own paginated `dataSources.query` calls — they are not
fanned out via `Promise.all` because each branch mutates shared
state (the `items` list and `stats` block). On a 10-project /
10,000-memory vault the dominant costs are:

- `duplicate_cluster`: one `listForScan` per active project (full
  paginated walk of the project's non-archived memories) plus an
  O(N²) per-project `findConflictCandidates` pass.
- `orphan_fact`, `overdue_governance`, `ownerless`,
  `operational_expiry`, `summary_quality`:
  each issues one or more paginated `dataSources.query` calls,
  bounded by `--per-category-limit` (default 200).

For ad-hoc operator triage, `--project <name>` is the recommended
shape — it avoids the per-project walk in `duplicate_cluster` and
fits comfortably in a single terminal window. The vault-wide form
is intended for periodic automation runs, not interactive use.

`lore debt create-tasks` adds a preflight cost on top of the scan: up
to `--limit` items × 3 status-coverage passes (default
`25 × 3 = 75`) sequential `MemoryService.search` round-trips before
any write. Each preflight call is bounded (`limit: 5`) and reads only
properties (no body fetch), so wall-clock is dominated by Notion's
per-call latency.

## Limitations

- Project scoping happens via `--project`; vault-wide scans aggregate across
  every active project. Archived projects are excluded — the scanner does
  not support `--include-archived`.
- The scoring formula is empirical and should be re-tuned if a real
  vault shows the priority bands distributing oddly. Tune via
  `SEVERITY_WEIGHT` in `src/core/memory-debt.ts`; the existing tests pin
  ordering but allow the absolute numbers to move.
- Topic sprawl and entity sprawl signals depend on the existing
  `findSimilarTopicGroups` helper. Entity alias ambiguity and
  low-row-count topic overlap are not reported by this category.
- The scope-anomaly category surfaces aggregate counters, not per-row
  ids. The `lore status` expiring-rows surface remains the canonical
  per-row view; `lore debt scan` adds it to a single triage view alongside
  the other dimensions.
