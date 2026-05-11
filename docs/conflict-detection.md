# Conflict Detection

`lore conflicts scan` is a read-only operator-pulled scanner that walks the
vault, identifies pairs of memories whose titles + keywords trigram-overlap, or
whose tags overlap, above threshold, filters out pairs already judged via
`Compared With`, and emits **prompt-ready output** the calling agent reads and
dispatches back via `lore-memory action='compare'`. The CLI itself does not call
any LLM and does not call the compare tool.

## Compare Verdicts

Compare verdicts are a closed vocabulary. `conflicts_with` and `supersedes` are
asymmetric and require `affectedMemoryId` naming the memory whose confidence
score should be reduced. `scoped`, `related`, `compatible`, and `not_conflict`
are symmetric and must omit `affectedMemoryId`. The `--json` output includes a
`compareContract` block. [`docs/memory-workflows.md`](memory-workflows.md)
has the canonical verdict definitions.

## Scan Caps

The scan is bounded by two distinct caps:

- `--raw-limit` (default `SCAN_RAW_CANDIDATE_CAP = 500`) per project —
  coverage knob; bounds the per-project candidate accumulator (top-K
  accumulation, so a high-overlap project allocates O(raw-limit) candidates,
  not O(N²)). Increase it to continue bounded scanning beyond the first raw
  window, or lift it entirely with `--exhaustive`.
- `--limit` (default 50) — prompt-budget knob; applied after dedup +
  Compared-With filter + sort, so it always budgets the useful candidate set.

## Workflow

```bash
# Surface a batch the agent can reason about:
lore conflicts scan --project Widget --limit 50

# Agent judges each pair via lore-memory action='compare'.

# Re-run; already-judged pairs drop out, next batch surfaces:
lore conflicts scan --project Widget --limit 50

# If the no-results report says "Raw limit reached: yes" and suggests
# a higher raw window, continue bounded scanning without going fully
# exhaustive:
lore conflicts scan --project Widget --raw-limit 1000 --limit 50

# Repeat until the scan returns zero, then optionally:
lore conflicts scan --project Widget --exhaustive --limit 50
# Lifts the raw-candidate per-project cap to confirm full
# coverage on extremely overlapping projects.
```

`--json` swaps the markdown report for a JSON document carrying a top-level
`compareContract` block: asymmetric vs. symmetric verdict split, direction
rules, and a back-reference to the canonical verdict definitions.
Progress messages route to stderr so `--json` is pipe-clean.
