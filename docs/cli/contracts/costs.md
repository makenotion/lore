# The `costs` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore costs` is a local-only inspection surface for the opt-in cost ledger. It
does not initialize Notion services and must never require vault reachability to
summarize or export existing local usage rows.

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
- Summary output distinguishes exact, estimated, and unknown model cost, reports
  wake-up tokens as cost unknown by default, and groups MCP usage by tool/action
  and success/error.
- The command must never print raw prompts, MCP arguments, MCP results, memory
  content, fact content, Notion page bodies, or Notion response payloads.
