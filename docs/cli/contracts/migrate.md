# The `migrate` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore migrate` handles additive schema repair and one-shot data migrations. It
must stay idempotent: a second run on an up-to-date vault should report no
writes for the selected operation.

Default schema migration:

- Detects missing properties on live data sources and patches them with
  `dataSources.update`.
- Detects missing select and multi-select options while preserving live option
  IDs so Notion does not duplicate options.
- Performs additive changes only; property renames or removals are breaking and
  require an explicit architectural decision.

Legacy tag upgrade:

- `--upgrade-decision-tags` finds memories tagged `decision`, upgrades them to
  `Kind: decision`, and strips the legacy tag.
- The flag auto-runs schema migration first so users do not need to remember
  ordering.
- `--dry-run --upgrade-decision-tags` shows schema drift but does not apply the
  tag upgrade; the tag upgrade is opt-in apply behavior.

Agent identity normalization:

- `--normalize-agents` scans non-archived memories and collapses known
  Lore-produced Claude variants onto the canonical `"Claude Code"` string.
- Explicit third-party names such as `Codex`, `Cline`, and `Cursor` pass
  through unchanged so explicit attribution stays authoritative.
- Bare invocation prints the plan grouped by canonical destination; `--yes`
  applies it.
- The write-time canonicalizer in
  [`src/hooks/agent-identity.ts`](../../../src/hooks/agent-identity.ts) owns the
  variant table. Add to it only when a new default-detection variant appears in
  saved rows.

Synopsis backfill:

- `--backfill-synopses` targets non-archived memories whose `Synopsis` property
  is empty.
- Plan mode reports candidates. `--yes` applies. `--dry-run` wins over apply
  mode.
- `--synopsis-backend claude` fetches page markdown with `pages.retrieveMarkdown`,
  synthesizes a short synopsis, sanitizes it, and writes the `Synopsis`
  rich-text property. PATH preflight for `claude` runs only on the apply path so
  operators without `claude` can still inspect candidate counts.
- Body fetch, synthesis, sanitize, and write failures continue to the next row
  and log to stderr with row id, phase, and error. The failed row's Synopsis
  stays empty so a later run can target it again.
- `--synopsis-backend placeholder` writes the
  `SYNOPSIS_PLACEHOLDER_SENTINEL` value directly, skips body fetches, and leaves
  typed body-fetch counters at `0`. The display layer renders those counters as
  not applicable for the placeholder backend.
- Placeholder writes are one-way for discovery: once the sentinel lands, the
  empty-Synopsis filter excludes the row until an operator explicitly clears the
  property.
- Discovery filters on empty Synopsis, so any successful write drops the row
  out of later runs. Failed writes leave the row eligible for retry. Notion page
  updates are per-request atomic, so a write that does not land leaves the row in
  the last observed state.

Confidence-score backfill:

- `--build-confidence-scores` seeds null numeric `Confidence Score` values from
  categorical `Confidence`, writes `Last Referenced At = created_time`, and
  applies any decay accrued since creation.
- Without the migration, older rows with null numeric confidence bypass
  score-based ordering, trust indicators, and stale-confidence surfacing until a
  read path touches them.
- Rows with a non-null numeric score are skipped.
- `--project <name>` scopes the migration to one active project. Archived
  projects require `--include-archived`. Unknown names abort before planning.
- Bare `--yes` must not be treated as consent to mutate every null-scored row
  when a project-specific migration was intended.
- Writes dispatch in batches sized to `notion.rateLimit.concurrency`. Rate-limit
  middleware gates concurrency; it is not a retry layer. A surfaced 429 aborts
  the run, and reruns finish remaining null-scored rows.
- `Last Referenced At = created_time` is an algebra anchor, not proof the memory
  was read at creation. Later read touches keep their newer date because the
  migration skips rows that already have a numeric score.
- Plan output surfaces the most-decayed candidate titles so operators can
  sanity-check before applying. Apply mode prints progress periodically to
  stderr.
- Pure planning and scoring live in
  [`src/core/confidence-migration.ts`](../../../src/core/confidence-migration.ts);
  service-boundary I/O lives on memory-service helpers.
- The categorical `certain` default can overstate old rows that were never
  explicitly graded. Operators who care should re-grade targeted rows via
  `lore-memory action='update'` before or after the migration.

Entity and fact repair flags:

- `--build-entities` and `lore vault ensure-entities` support legacy
  four-database vault migration. Preserve the creation order
  `Projects -> Topics -> Memories -> Entities -> Facts`.
- Fact readers must tolerate rows with populated entity relations and rows that
  still require the SubjectKey substring fallback.
- `--report-orphan-rate` pairs with entity builds to report orphan metrics; it
  is a reporting surface, not permission to perform unrelated writes.
- Encoding repair and topic merge flags are one-shot maintenance operations.
  Keep their plan/apply posture explicit and idempotent.
