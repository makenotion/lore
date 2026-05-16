# The `conflicts` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore conflicts scan` walks the vault, runs lexical candidate generation per
project, filters out pairs already judged via `Compared With`, and emits
prompt-ready material for the current agent to judge with
`lore-memory action='compare'`.

The CLI does not call an LLM and does not call the compare tool. It is a
structured scan surface, not a judging subprocess.

Pipeline:

```text
list -> generate -> dedup -> filter -> sort -> truncate -> render
```

Filtering before truncation is load-bearing: `--limit` budgets the useful
candidate set, not raw lexical pairs.

Cap knobs:

- `--raw-limit` controls coverage. It is passed to `findConflictCandidates` as
  `pairLimit` per project and bounds candidate accumulation. Similarity
  computation is still O(N^2); bounded top-K accumulation prevents candidate
  object blow-up.
- `--exhaustive` lifts the raw limit by passing
  `Number.POSITIVE_INFINITY` as the pair limit. If combined with `--raw-limit`,
  exhaustive wins and the CLI emits a stderr note.
- `--limit` controls rendered prompt budget after deduplication, already-judged
  filtering, and sorting.
- Passing `--limit` to candidate generation would pre-truncate before dedup and
  filtering, yielding fewer useful rendered pairs than requested even when more
  candidates exist.

Bounded coverage:

- A project can have unjudged pairs ranked beyond the current `--raw-limit`.
  After all pairs in the bounded window are judged, a run can return zero pairs
  even though deeper candidates remain.
- The no-results message distinguishes cap-hit bounded scans from true
  exhaustion and points operators at a larger `--raw-limit`.
- `--exhaustive` can allocate and compute against a very large O(N^2) pair set;
  keep it explicit.

Output shapes:

- Markdown output is prompt-ready for an interactive agent session. It names the
  verdict vocabulary and points to [`memory-workflows.md`](../../memory-workflows.md)
  for definitions.
- JSON output carries a top-level `compareContract` block with asymmetric and
  symmetric verdict rules so a programmatic consumer can produce correctly
  shaped compare calls.
- Progress routes to stderr so `--json` remains pipe-clean.
- The implementation injects a log sink instead of writing directly to process
  globals so tests can capture progress without mutating the process.

`MemoryService.listForScan`:

- Uses strict project scoping with `Project relation contains <id>` rather than
  `projectOrUnscopedFilter`.
- Paginates at page size 100 until `has_more === false`.
- Fetches page bodies only when `includeBodies` is set.
- Filters archived rows client-side because Notion's archived flag is page
  metadata rather than a database property.
