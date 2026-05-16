# The `status` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore status` prints vault metadata, active profile, database counts, active
projects, task and confidence summaries, proposed-memory review counts, wake-up
coverage, digest/drift watermarks, topology health, and recent background
failures where configured.

Task summary:

- `taskStats` and `formatTaskSummary` live in
  [`src/core/task.ts`](../../../src/core/task.ts) so CLI and MCP status surfaces share
  the same line shape.
- Active tasks render as
  `Tasks: N active (overdue: M, stale ≥30d: K, in-progress: P, blocked: Q)`.
  Zero buckets collapse off; `active === 0` still renders `Tasks: 0 active`.
- Vaults with `Done At` also render a closed-last-30-days line. Vaults without
  that column silently omit it.

Memory confidence:

- `MemoryService.confidenceStats` walks non-archived memories in the selected
  project scope and aggregates total, scored, average score, and below-threshold
  counts.
- The CLI fans confidence stats out alongside tasks and wake-up coverage so
  orchestration wall-clock is bounded by the slowest probe, not their sum.
- `formatConfidenceSummary` suppresses the line when there are no memories,
  drops parentheses when no rows are scored, and omits `0 below threshold`.
- The prefix is `Memory confidence:` to avoid collision with the database-count
  `Memories:` line. Database counts include archived rows; confidence stats
  exclude them and may legitimately differ.

Proposed-memory inbox count:

- `MemoryService.countProposed` queries `Status = proposed AND Kind != decision`
  and aggregates total plus source and agent buckets.
- `Kind != decision` is load-bearing because `proposed` is also a valid
  decision lifecycle state.
- The shared proposed-memory filter lives in the core memory layer; default
  recall exclusion, wake-up surfacing, status counts, CLI review, and MCP review
  actions must compose the same predicate rather than re-deriving it.
- `formatProposedInboxStatus` returns no lines for `total === 0`; an empty
  inbox is silent in `lore status`.
- Prefix inflects as `Proposed memory:` for one and `Proposed memories:` for
  more than one.
- Rendered examples:

  ```text
  Proposed memory: 1 pending review
  Proposed memories: 12 pending review (sources: conversation 8, manual 4 · agents: Claude Code 9, Codex 3)
  ```

- Single-bucket source or agent clusters collapse off; bucket ordering is
  deterministic by descending count, then ascending key.
- Missing Source and Agent values render as `"unknown"` for status aggregation
  rather than pretending the row was saved manually.
- Approval and rejection record reviewer plus timestamp in a `## Reviewed` audit
  block on the memory body. Status count and review operations are separate
  read/write surfaces over the same proposed-memory lifecycle.

Wake-up coverage:

- `lore status` calls `loadWakeUpData` with `includeMemoryContent: false` and
  `includeCoverage: true`.
- The section must not leak titles, fact text, query text, or page bodies.

Failure posture:

- The status probes use `Promise.all`, not `allSettled`. A broken vault or
  Notion outage should fail loudly instead of presenting partial status as if
  missing sections were empty.
- This mirrors the search-path rule that a fully broken subsystem must not look
  like an empty result set.

Digest and drift watermarks:

- Digest status performs one bounded memories query for `source: digest` and
  filesystem `stat` calls for per-project markers.
- The digest section reports the latest existing digest memory, marker age, and
  estimated time until the next automatic digest. It also shows when auto-digest
  is disabled by environment or config.
- The digest section suppresses itself when there are no configured
  sub-projects.
- Drift status wording says "next fire on next debounced session" because drift
  can run from any debounced caller, not only Stop hooks.
- `lore status` itself touches the drift marker before loading drift status, so
  the rendered section reflects what later debounced callers will see.
- If there is no configured `.lore.yaml` root, drift status returns no lines and
  the section is suppressed.

Cost tracking:

- `lore status` renders a compact cost section only when
  `costTracking.enabled` is true. Disabled or omitted cost tracking is silent.
- The section reads the local ledger only; it must not initialize any extra
  Notion clients beyond the status probes already running for the command.
- The line reports today's Lore-owned model spend, wake-up estimated tokens,
  MCP call count, and Notion writes. A month-to-date line appears only when the
  current month has ledger entries. Autosave and digest model spend is labeled
  as a background prompt estimate; it may exclude completion tokens,
  cached-input billing, and provider-side rounding.
- Missing, empty, or malformed ledger rows must not fail status output.
  Malformed or schema-invalid non-blank rows render a redacted warning with only
  the skipped-line count.
