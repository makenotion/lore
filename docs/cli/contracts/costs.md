# The `costs` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore costs` is a local-only inspection surface for the opt-in cost ledger. It
does not initialize Notion services and must never require vault reachability to
summarize or export existing local usage rows.

The ledger is advisory telemetry, not an authoritative billing or audit log.
Successful appends are not forced to stable storage with fsync/fdatasync, so a
host crash or power loss may drop a small tail of recently accepted events
without producing an append-error marker.

- `costTracking.ledgerPath` is the ledger family root. Readers include the
  legacy root file and same-directory per-process shard files derived from the
  configured basename.
- New cost events are appended to the current process shard, not the legacy
  root file. Existing root-file rows are never migrated or rewritten.

Ledger rows may include project, agent, session, tool, and action identifiers;
redacted payload byte/token estimates; Notion operation counts; and model
usage/cost estimates when known. They must not include raw prompts, MCP argument
bodies, MCP result bodies, memory/fact text, Notion page bodies, or Notion
response payloads.

- `summary` defaults to the local calendar day `today`; `export` defaults to all
  ledger rows.
- `--since` accepts only `Nh`, `Nd`, or `Nw` with a positive integer. `--month`
  accepts `YYYY-MM` in local calendar time. Combining them exits non-zero before
  reading the ledger.
- Disabled tracking prints a short status message for `summary` and exits
  non-zero for `export`, because export scripts expect data on stdout.
- JSONL export writes validated matching ledger events with redacted payload
  summaries. Unknown fields from raw ledger lines are not preserved. When no
  rows match, JSONL export exits successfully and writes no stdout.
- CSV export writes stable columns with missing values as empty cells. When no
  rows match, CSV export exits successfully and writes only the header row.
- Summary and export rows are ordered by event timestamp across the merged
  ledger family with deterministic tie-breaking for equal timestamps.
- Malformed or schema-invalid non-blank ledger rows are skipped with a redacted
  warning that reports only the skipped-line count. Export warnings go to stderr
  so stdout stays parseable as JSONL or CSV.
- Summary output distinguishes exact agent model usage, background prompt
  estimates, and unknown-cost background model events. Autosave, digest, and
  longitudinal eval mining background model rows must keep
  `modelUsage.source: "prompt_estimate"`; those rows estimate prompt-side input
  only and may exclude completion tokens, cached-input billing, and
  provider-side rounding.
- JSONL and CSV export schema compatibility is stable. Export consumers should
  treat `autosave.background_model`, `digest.background_model`, and
  `eval.mining.background_model` rows with
  `modelUsage.source: "prompt_estimate"` as prompt-side estimates; CSV keeps
  the existing `modelUsageEstimated` / `estimatedUsd` columns instead of adding
  a source column.
- JSONL/CSV payload fields are compatibility-stable: `inputBytes`,
  `outputBytes`, `estimatedInputTokens`, and `estimatedOutputTokens` must not be
  renamed in this schema version.
- For `mcp.invocation` rows, `payload.inputBytes` is the UTF-8 byte length of
  the serialized MCP argument envelope summarized into the redacted payload
  record. The ledger stores only the byte count and token estimate, not the
  arguments. It is useful payload telemetry, not tokenizer-accurate model prompt
  size.
- `estimatedInputTokens` and `estimatedOutputTokens` use the repo's
  `chars_per_token_4` estimator (`ceil(bytes / 4)`). They are estimates, not
  provider tokenizer output.
- Summary output reports wake-up context estimated tokens as cost unknown by
  default and groups MCP usage by tool/action and success/error.
- The command must never print raw prompts, MCP argument bodies, MCP result
  bodies, memory/fact text, Notion page bodies, or Notion response payloads.
