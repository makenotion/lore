# GitHub CLI Longitudinal Eval Results, 2026-05-27

This records the current OSS longitudinal evaluation result for the GitHub CLI
powered candidate pool. It is a measurement checkpoint, not a publishable
headline benchmark.

## Dataset

- Suite: `evals/task-suites/longitudinal-github-cli-powered-candidates.yaml`
- OSS target: `cli/cli@9a593ce81b593dee752cc11737d1a3ef768e52b3`
- Conditions: `no-memory`, `seeded-lore`, `lore-full-loop`
- Current candidate pool: 38 easy, 22 medium, 15 hard scenarios
- Target no-memory calibration bands:
  - Easy: 80-95% pass
  - Medium: 50-75% pass
  - Hard: 20-45% pass

The pool is intentionally uneven. As scenarios become too easy for the model,
they should be demoted, and new harder scenarios should be added to restore the
capability edge.

## Provenance

The deterministic checkpoint sample below was derived from completed scenario
triples already present in local raw artifacts. No new benchmark rows were
counted from aborted sample attempts.

Raw artifacts used as provenance:

- `evals/results/longitudinal-github-cli-powered-candidates-20260527T021658Z.json`
- `evals/results/longitudinal-github-cli-powered-medium-hard-20260527T123057Z.json`
- `evals/results/longitudinal-github-cli-powered-repair-20260527T151634Z.json`

When a selected `scenarioId|condition` appears in more than one provenance
artifact, the latest completed row wins. The repair artifact contains reruns for
known harness-validity repairs, so earlier rows for the same key are retained as
raw provenance but are not scored twice.

Excluded artifacts:

- `evals/results/longitudinal-github-cli-powered-sample-20260527T163121Z.json`
  hit a local `mise` trust failure before valid agent work and terminated with
  cost unknown.
- `evals/results/longitudinal-github-cli-powered-sample-20260527T163332Z.json`
  produced no completed result rows.
- `evals/results/longitudinal-github-cli-powered-sample-20260527T163723Z.json`
  was manually stopped after the decision to avoid rerunning already-complete
  easy scenarios; it produced no completed result rows.

The deterministic sample design was:

```text
seed: 2026-05-27-nightly
sample: easy=25,medium=15,hard=10
```

Every selected scenario already had complete valid triples in the provenance
artifacts. This is useful as a retrospective descriptive checkpoint because
scenario prompts, verifiers, and the pinned workspace SHA did not change. It is
weaker for confirmatory inference than a fresh predeclared run unless selection
is demonstrably independent of observed outcomes. Repeated runs of the same
scenario must not be counted as independent statistical units.

## Sample Results

Raw result, using verifier outcomes directly:

| Condition        |   Pass rate | Primary agent cost | Phase elapsed sum |
| ---------------- | ----------: | -----------------: | ----------------: |
| `no-memory`      | 40/50 (80%) |            $149.00 |            5.34 h |
| `seeded-lore`    | 41/50 (82%) |            $151.29 |            5.51 h |
| `lore-full-loop` | 43/50 (86%) |            $149.39 |            6.91 h |

Adjudicated result, applying the narrow measurement repairs accepted during
analysis:

| Condition        |   Pass rate | Delta vs no-memory |
| ---------------- | ----------: | -----------------: |
| `no-memory`      | 41/50 (82%) |                  - |
| `seeded-lore`    | 43/50 (86%) |              +4 pp |
| `lore-full-loop` | 44/50 (88%) |              +6 pp |

Adjudication overrides applied to this sample:

- `gh-cli-pr-checks-display-names|seeded-lore`
- `gh-cli-telemetry-send-failure-nonfatal|no-memory`
- `gh-cli-telemetry-send-failure-nonfatal|seeded-lore`
- `gh-cli-telemetry-agent-host-type|lore-full-loop`

Difficulty breakdown for the adjudicated sample:

| Difficulty |   no-memory | seeded-lore | lore-full-loop | full-loop delta |
| ---------- | ----------: | ----------: | -------------: | --------------: |
| Easy       | 23/25 (92%) | 24/25 (96%) |    24/25 (96%) |           +4 pp |
| Medium     | 12/15 (80%) | 13/15 (87%) |    14/15 (93%) |          +13 pp |
| Hard       |  6/10 (60%) |  6/10 (60%) |     6/10 (60%) |            0 pp |

Paired full-loop vs no-memory discordance:

| View               | Lifted | Harmed |           Net | Exact McNemar p-value |
| ------------------ | -----: | -----: | ------------: | --------------------: |
| Raw sample         |      5 |      2 | +3/50 (+6 pp) |                 0.453 |
| Adjudicated sample |      4 |      1 | +3/50 (+6 pp) |                 0.375 |

This is not statistically significant at alpha 0.05.

Lore-owned background model cost for the selected `lore-full-loop` rows was
approximately $0.59, recorded as prompt-estimated `eval.mining.background_model`
ledger events. The total selected primary-agent cost across all conditions was
approximately $449.68.

## Full Pool Sensitivity

The full candidate pool gives the same qualitative result:

| View             |   no-memory | seeded-lore | lore-full-loop | full-loop delta | Exact McNemar p-value |
| ---------------- | ----------: | ----------: | -------------: | --------------: | --------------------: |
| Raw pool         | 61/75 (81%) | 64/75 (85%) |    64/75 (85%) |           +4 pp |                 0.508 |
| Adjudicated pool | 62/75 (83%) | 66/75 (88%) |    65/75 (87%) |           +4 pp |                 0.453 |

The current medium and hard strata are still too easy relative to the target
bands. In the deterministic sample, no-memory passed 80% of medium scenarios
and 60% of hard scenarios. That leaves too little failure surface for Lore to
show measurable lift.

## Measurement Interpretation

Current evidence supports:

- In this sample, full-loop passed two additional medium scenarios versus
  no-memory.
- The strongest current directional signal is in medium tasks, where full-loop
  improves from 12/15 to 14/15 in the adjudicated sample.
- The current pool does not yet demonstrate statistically significant headline
  lift.

Current evidence does not support:

- A publishable statistically significant lift claim.
- A token reduction claim. Primary-agent cost is comparable, and prompt volume
  is not low enough to support a reduction claim from this sample.
- A speed improvement claim. Summed phase elapsed time is higher for
  `lore-full-loop`, likely because full-loop includes memory formation and
  wake-up work.

## Top-Up Policy

Running only missing medium/hard scenarios is valid if treated as stratified
sampling:

- Select missing scenarios before looking at their outcomes.
- Keep the difficulty stratum fixed for analysis.
- Do not count reruns of the same scenario as independent samples.
- Report per-stratum rates or a predeclared weighted aggregate.
- Exclude harness-invalid scenarios only with documented, symmetric criteria.

In this checkpoint there are no missing medium/hard rows for the deterministic
sample above; every selected scenario already has complete valid triples.

## Next Step

Do not spend more on the current easy-heavy sample. Add or promote genuinely
hard scenarios as calibration work until the hard no-memory pass rate lands near
20-45%. Then run a fresh predeclared stratified holdout sample before making a
publishable lift claim.
