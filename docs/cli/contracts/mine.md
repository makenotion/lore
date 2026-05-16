# The `mine` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore mine` walks a directory tree, filters mineable text files, and creates or
updates one `source: "file"` memory per file.

Discovery:

- Skips local tooling and generated directories such as `node_modules`, `dist`,
  `build`, `.git`, `.next`, and `__pycache__`.
- Skips local config and lockfiles such as `.lore.yaml`, `package-lock.json`,
  `yarn.lock`, and `pnpm-lock.yaml`.
- Indexes recognized text extensions plus explicit basenames such as
  `Dockerfile` and `Containerfile`.
- Enforces a 100KB max file size and a default 50-file run limit.
- Wraps content in a markdown code block with the file extension as language.
- Creates memories with source `"file"` and keywords shaped as
  `"<extension> mined <relPath>"`; tags remain empty because file extensions are
  free-form tokens, not closed-vocabulary tags.
- Supports `--dry-run` to preview files without writing memories.

Pattern and limit validation:

- `--pattern <glob>` filters before the `--limit` slice, so the limit applies to
  matching files.
- `globToRegExp` supports `**` only when surrounded by path boundaries, `*`,
  `?`, and POSIX-style character classes. Brace expansion is intentionally not
  supported.
- Mid-segment `**` collapses to single-`*` semantics so it does not silently
  match across path boundaries. Raw `/` inside a character class is stripped so
  a class cannot match the path separator. Brace literals are escaped through.
- Path matching is case-sensitive. Extension filtering is case-insensitive.
- `--limit` validates as a strict positive integer and rejects zero, negatives,
  decimals, signed values, exponent notation, mixed strings, empty string, and
  values past `Number.MAX_SAFE_INTEGER`.

Project resolution:

- `resolveMineProject` runs before file walking or upsert work.
- An explicit unknown `--project` throws. This prevents typos from producing
  unscoped file memories that collide with other projects.

Idempotency:

- Repeated runs do not accumulate duplicates. The upsert key is
  `(title, source, projectIds)`.
- `findExistingFileMemory` performs a bounded memory search by relPath and
  post-filters candidates by `source === "file"`, exact expected title, and
  exact project-id set equality.
- Source filtering rejects user-curated memories that merely mention the same
  relPath. Exact title matching rejects substring collisions such as
  `src/foo.ts` and `src/foo.ts.bak`.
- Project-set equality is load-bearing: unscoped rows do not match project
  rows, and `[A]` does not match `[A, B]`.
- The existing-row search limit is the Notion single-query maximum of 100 so a
  busy vault is less likely to page the relevant file row out of the candidate
  window.

Topic preservation:

- The upsert path passes `topicId` to `MemoryService.update` only when a current
  `--topic` resolves.
- Re-mining without `--topic` preserves the row's existing Topic relation.

Failure isolation and concurrency:

- `runMineUpsert` chunks files into batches sized to
  `config.notion.rateLimit.concurrency`.
- Each batch dispatches with `Promise.all`.
- Per-file failures resolve as `kind: "failed"` outcomes; one read or Notion
  failure does not abort the batch.

Concurrent runs:

- Parallel `lore mine` runs against the same vault, project, and file serialize
  through a per-file lock around the `findExistingFileMemory -> create-or-update`
  critical section.
- Fresh creates hold the lock through a short stabilization delay so Notion's
  eventually consistent search index can see the row before the next miner
  probes.

Output:

- `formatMineSummary` preserves the legacy `Indexed N files.` and
  `Done. Indexed N/M files (K failed).` shapes.
- `(N new, M updated)` is appended only when at least one update landed.
