# Search CLI Contract

`lore search <query>` is a read-only memory lookup surface for operators and
scripts.

## Scope and Filters

- `--project <name>` is explicit-scope strict. If the name is blank, missing,
  or archived-only, the command exits non-zero and does not search.
- When `--project` is omitted, the command uses the auto-detected project
  context when one exists.
- `--tags <csv>` trims each comma-separated token and forwards the resulting
  list to memory search.
- `--include-expired` forwards `includeExpired: true` to memory search so
  audits and migration checks can inspect expired scoped memories.
- `--limit <n>` must be a positive decimal integer and is parsed before service
  initialization.

## Output

- Default output stays human-readable: count, linked title, tags, source, date,
  page id, and a short content preview.
- Empty human output prints `No memories found for: "<query>"`.
- When the search service reports a capped candidate window, human output prints
  a warning after the result list or empty-result line.
- `--json` writes a single parseable object to stdout:

  ```json
  {
    "query": "PAT rollout",
    "projectId": "project-page-id",
    "tags": ["auth"],
    "capped": false,
    "results": []
  }
  ```

- `projectId` is `null` when the search is vault-wide. `tags` is `null` when no
  tag filter was supplied. `capped` is `true` when the candidate window may have
  omitted additional matching memories. `results` is the
  `MemoryService.search()` result array.
- Diagnostics and errors go to stderr so `--json` remains pipe-clean.
