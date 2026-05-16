# The `eval` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore eval` runs local evaluation surfaces. See [`evals.md`](../../evals.md),
[`evals-suite-format.md`](../../evals-suite-format.md), and
[`evals-longmemeval.md`](../../evals-longmemeval.md) for full runner contracts.

Contracts:

- `eval run <suite>` defaults to the fixture-only retrieval runner and writes a
  JSON artifact.
- The Notion runner requires an explicit sandbox project unless
  `LORE_EVAL_NOTION_ALLOW_PRODUCTION=1` allows a non-sandbox name.
- Task evals require `LORE_EVAL_TASK_REAL=1` before invoking Codex headless;
  without it, the adapter refuses to run real trials.
- Profile evals run deterministic profile taxonomy and scorer suites.
- `--trials` must remain `1`.
- Baseline comparison must reject cross-suite and cross-runner comparisons.
- `eval baseline` captures comparison-stable baselines for compatible runners.
  Task and profile baselines are rejected because those modes use deterministic
  verifiers or YAML thresholds.
- `eval vaults` and `eval bench` are operator surfaces for live-vault and
  benchmark workflows; keep their token, network, and fixture needs documented
  in the eval docs and CI guide.
