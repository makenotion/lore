# The `costs` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore costs` is a local-only inspection surface for the opt-in cost ledger. It
does not initialize Notion services and must never require vault reachability to
summarize or export existing local usage rows.

- `costTracking.ledgerPath` is the ledger family root. Readers include the
  legacy root file and same-directory per-process shard files derived from the
  configured basename.
- New cost events are appended to the current process shard, not the legacy
  root file. Existing root-file rows are never migrated or rewritten.
- `summary` defaults to the local calendar day `today`; `export` defaults to all
  ledger rows.
- `--since` accepts only `Nh`, `Nd`, or `Nw` with a positive integer. `--month`
  accepts `YYYY-MM` in local calendar time. Combining them exits non-zero before
  reading the ledger.
- Disabled tracking prints a short status message for `summary` and exits
  non-zero for `export`, because export scripts expect data on stdout.
- JSONL export writes the original redacted ledger lines that match the range.
  When no rows match, JSONL export exits successfully and writes no stdout.
- CSV export writes stable columns with missing values as empty cells. When no
  rows match, CSV export exits successfully and writes only the header row.
- Summary and export rows are ordered by event timestamp across the merged
  ledger family with deterministic tie-breaking for equal timestamps.
- Malformed or schema-invalid non-blank ledger rows are skipped with a redacted
  warning that reports only the skipped-line count. Export warnings go to stderr
  so stdout stays parseable as JSONL or CSV.
- Summary output distinguishes exact agent model usage, background prompt
  estimates, and unknown-cost background model events. Autosave and digest
  background model rows must keep `modelUsage.source: "prompt_estimate"`;
  those rows estimate prompt-side input only and may exclude completion tokens,
  cached-input billing, and provider-side rounding.
- JSONL and CSV export schema compatibility is stable. Export consumers should
  treat `autosave.background_model` and `digest.background_model` rows with
  `modelUsage.source: "prompt_estimate"` as prompt-side estimates; CSV keeps the
  existing `modelUsageEstimated` / `estimatedUsd` columns instead of adding a
  source column.
- Summary output reports wake-up tokens as cost unknown by default and groups
  MCP usage by tool/action and success/error.
- The command must never print raw prompts, MCP arguments, MCP results, memory
  content, fact content, Notion page bodies, or Notion response payloads.
