# Memory Quality Replay Benchmark

This benchmark replays redacted Mail transcript excerpts through
`buildBackgroundSavePrompt` and scores whether the autosave response keeps or
rejects labeled candidate learnings.

It is a formation-quality smoke benchmark, not a headline product metric. The
fixture provider is deterministic and suitable for CI: it asserts that the
rendered prompt still contains the issue 919 quality gates, scores known
outputs, and fails nonzero if the default thresholds are missed. The `claude`
provider runs the rendered autosave prompt with `claude -p` for repeated live
samples with mutation/read tools disallowed, an empty strict MCP config, an
explicit read-only replay instruction, and the prompt piped on stdin so replay
cannot call Lore MCP tools, mutate a real Lore vault, or expose transcripts in
argv.

## Run

```sh
npm run build
node evals/memory-quality/run.mjs --provider fixture --seeds 1,2,3
node evals/memory-quality/run.mjs --provider claude --seeds 1,2,3
```

Use `--no-thresholds` for exploratory live runs where you want metrics without
turning low scores into a failing process.

The runner reports per-run candidate outcomes plus aggregate mean and standard
deviation for:

- `candidateAccuracy`
- `keepPrecision`
- `keepRecall`
- `rejectRecall`
- `falseKeepRate`

## Rubric

Each corpus case supplies a transcript and labeled candidate memories:

- `expected: "keep"` means the response should save that exact durable,
  experiential, precise learning or decision.
- `expected: "reject"` means the response should omit the candidate because it
  is inferable, vague, redundant, or session narration.
- `matchAny` and `matchAll` terms detect whether the response emitted the
  candidate. The rubric is deliberately simple so the benchmark can run without
  another model judging the model output.

The prompt SHA is recorded for each case so changes to
`buildBackgroundSavePrompt` are visible in result artifacts.
