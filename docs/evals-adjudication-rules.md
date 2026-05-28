# Longitudinal Eval Adjudication Rules

This rubric applies to GitHub CLI longitudinal task evals before any result is
used for a headline lift claim. It is intentionally stricter than the internal
calibration workflow.

## Result Views

Every report must keep three views separate:

- `raw`: the verifier result recorded by the harness.
- `adjudicated`: a reviewer-corrected result under this rubric.
- `exclusion-only`: the raw result after removing infra-invalid rows, with no
  pass/fail overrides.

Headline correctness uses the adjudicated view only when the rubric was
predeclared before the run. Otherwise the adjudicated view is exploratory.

## Failure Buckets

Each failing row gets exactly one primary bucket:

- `agent-failure`: the implementation does not satisfy the requested behavior.
- `verifier-false-negative`: the implementation satisfies the behavior, but a
  verifier overfit naming, paths, assertion prose, or implementation shape.
- `verifier-false-positive`: the verifier passed although the behavior is not
  implemented.
- `prompt-ambiguity`: the task wording permits multiple incompatible readings.
- `infra-error`: checkout, build cache, local trust, network, model invocation,
  or timeout failure prevented a trustworthy implementation attempt.
- `memory-system-failure`: the lore condition did not make the required memory
  available because formation, mining, wake-up, or retrieval failed.

## Adjudicate As Pass

Convert a raw verifier failure to pass only when all are true:

- The transcript, diff summary, and command output show the intended behavior
  was implemented.
- The failing verifier is over-specific about file location, symbol name,
  assertion wording, or test decomposition.
- A repaired verifier would pass without changing the prompt, workspace SHA,
  condition setup, seeded corpus, or model.
- The same rule would be applied symmetrically to every condition.
- The row has a complete final workspace and package tests for the touched
  behavior passed, or the artifact contains a replayable patch evidence sidecar
  and full transcript for the final workspace state.

Extra useful work is not harm when the requested behavior is complete and the
extra work does not regress the intended outcome.

## Rerun Or Exclude

Do not adjudicate; rerun or exclude when any are true:

- The row failed before meaningful agent work began.
- The row timed out before an inspectable final state.
- The prompt or verifier ambiguity prevents a confident behavior judgment.
- The repair changes scenario semantics, prompt text, workspace SHA, seeded
  context, or base-vault contents.
- A `seeded-lore` row did not actually receive its pre-seeded context because of
  setup error.
- An external Notion, network, auth, or local harness failure prevented
  `lore-full-loop` from attempting formation or wake-up.
- The row would require condition-aware assumptions to score.

Reruns of a scenario replace the previous row for that `scenarioId|condition`;
they are never counted as independent samples.

Do not exclude `lore-full-loop` rows merely because Lore failed to form,
retrieve, or surface the expected memory. Those misses are product behavior
under test, but expected-context matching remains diagnostic: it can explain a
verifier failure, but it does not turn a verifier-passing task into a failure.
Formation or wake-up phase errors still count as `lore-full-loop` failures
unless they were caused by external infrastructure or harness setup outside
Lore's normal behavior.

## Blinding

Confirmatory adjudication should mask condition labels and randomize transcript
order within each scenario. Reports must include:

- Override counts by condition and direction.
- A brief asymmetry audit.
- A second-reviewer agreement check when available.

## Difficulty Promotion

Difficulty is calibrated by observed no-memory pass rate, not author intent:

- easy/control: 80-95%
- medium: 50-75%
- hard: 20-45%
- too easy: >95%
- too hard or brittle: <20%

Scenarios may enter a headline holdout only after baseline verifiers fail on
the unchanged workspace, at least one reference-quality solution passes, and
no-memory calibration places the scenario in the intended band.

## Reporting

Primary correctness uses paired `lore-full-loop` vs `no-memory` comparisons
with exact McNemar tests on discordant scenario pairs. Token and elapsed-time
claims use paired deltas with bootstrap confidence intervals and must separate
primary-agent cost from lore-owned background mining cost.

Cost-capped or manually stopped runs are incomplete by default. They may be
reported only as calibration evidence or as a clearly labeled complete-pair
subset; marginal condition success rates from an incomplete stopped run are not
a headline lift sample.
