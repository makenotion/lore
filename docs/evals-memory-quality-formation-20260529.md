# Memory Quality Formation Evidence, 2026-05-29

This records the issue 919 formation-quality pass: raw full-loop harm review,
production Mail vault grounding, and the layer recommendation for a future
programmatic quality gate.

## Inputs

- Aggregate command: `node tools/aggregate-longitudinal-results.mjs /Users/zer0/.lore/evals/results --json`
- Result set: 120 artifacts, 742 rows, 275 scenarios.
- Raw full-loop comparison: 148 paired scenarios, 12 lifts, 8 harms, exact
  McNemar p = 0.5034.
- Adjudicated full-loop comparison: 12 lifts, 6 harms, adjusted p = 0.2379.
- Transcript source: local campaign shards under `/Users/zer0/.lore/evals/results`.
- Production grounding: `env -u LORE_CONFIG_ROOT lore status` and
  `env -u LORE_CONFIG_ROOT lore debt scan --category duplicate_cluster --category summary_quality`
  from `~/Developer/Notion/Mail`.

## Raw Full-Loop Harm Characterization

The raw aggregate reports eight no-memory-pass / full-loop-fail rows. Five are
product-relevant memory harms. Three are measurement artifacts where the row
should not be interpreted as an autonomous memory-quality failure.

| Scenario                                                  | Local transcript shard                                                                                                                                                              | Raw outcome                                                                                                                                                     | What the memory supplied                                                                                                                   | Classification           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| `gh-cli-auth-token-flow-preserves-client-context`         | `/Users/zer0/.lore/evals/results/longitudinal-github-cli-powered-repair-20260527T151634Z.json-shards/035-gh-cli-auth-token-flow-preserves-client-context-transcripts/`              | Hidden verifier expected `TestAuthTokenFlowPreservesClientContext` in `internal/authflow/flow_test.go`; use phase implemented around shared login flow instead. | Retrieved context correctly identified that viewer/token lookups dropped request context and named relevant auth flow helpers.             | `misapplied-at-use-time` |
| `gh-cli-issue-develop-ref-validation-v3`                  | `/Users/zer0/.lore/evals/results/longitudinal-github-cli-capability-edge-v3-final-hard-20260528T0730Z.json-shards/004-gh-cli-issue-develop-ref-validation-v3-transcripts/`          | Invalid `--name` and `--base` still reached branch lookup or mutation.                                                                                          | Retrieved context explicitly said to validate literal refs before git/API side effects and warned against `git check-ref-format --branch`. | `misapplied-at-use-time` |
| `gh-cli-pr-close-delete-branch-worktree-guard-v3`         | `/Users/zer0/.lore/evals/results/longitudinal-github-cli-capability-edge-v3-final-hard-20260528T0730Z.json-shards/003-gh-cli-pr-close-delete-branch-worktree-guard-v3-transcripts/` | The implementation failed before the remote-delete path; verifier saw unmatched git stubs.                                                                      | Retrieved context named the worktree guard, false-success risk, and the need to keep remote deletion independent from local cleanup.       | `misapplied-at-use-time` |
| `gh-cli-pr-status-display-names`                          | `/Users/zer0/.lore/evals/results/longitudinal-github-cli-powered-medium-hard-20260527T123057Z.json-shards/006-gh-cli-pr-status-display-names-transcripts/`                          | Use phase changed JSON/export boundaries and the focused package test failed to compile.                                                                        | Retrieved context named the human-display boundary and warned not to change `api/export_pr.go` or JSON contracts.                          | `over-scoped`            |
| `gh-cli-telemetry-agent-host-type`                        | `/Users/zer0/.lore/evals/results/longitudinal-github-cli-powered-repair-20260527T151634Z.json-shards/007-gh-cli-telemetry-agent-host-type-transcripts/`                             | Use phase generalized host-type telemetry across skill commands instead of landing the narrower expected contract.                                              | Retrieved context emphasized telemetry privacy and host categorization across several skill telemetry paths.                               | `over-scoped`            |
| `gh-cli-repo-create-dry-run-json-plan-memory-contract-v2` | `/Users/zer0/.lore/evals/results/longitudinal-github-cli-memory-contract-v2-hard-20260528T0528Z.json-shards/`                                                                       | Full-loop row ended as a harness error before a usable memory/use comparison.                                                                                   | No durable mined/retrieved memory drove the failure.                                                                                       | measurement artifact     |
| `pytest-parametrize-trailing-comma-v1`                    | `/Users/zer0/.lore/evals/results/longitudinal-pytest-public-spec-v1-param-trailing-memory-20260528T1101Z.json-shards/`                                                              | Formation tripped the read-only gate with zero-line patch stats; no use-phase memory behavior was measured.                                                     | No durable mined/retrieved memory drove the failure.                                                                                       | measurement artifact     |
| `rg-cross-boundary-correctness-epic-v1`                   | `/Users/zer0/.lore/evals/results/longitudinal-ripgrep-public-spec-v1-epic-full-loop-final-20260528T1417Z-transcripts/`                                                              | Raw row failed on `expected-context`, but the use-phase verifier passed the hidden integration test.                                                            | Retrieved context was specific and relevant: ignore-file CWD rules, CRLF trimming, isolated home/XDG, JSON output boundaries.              | measurement artifact     |

## Production Mail Grounding

The Mail vault had 10 projects, 278 topics, 1,522 memories, and 1,357 facts at
scan time. The targeted debt scan returned 200 P2 findings across duplicate
clusters and summary-quality findings. Raw production memory bodies are not
reproduced here.

Manual review of the `conversation/note` population found:

- 55-60% experiential and precise enough to keep.
- 15-20% semantic near-duplicates.
- 8-12% inferable noise that a competent agent could re-derive from code,
  docs, and types.
- 3-5% session narration stored as `kind: note`.
- About 13% null synopsis rows, concentrated in `conversation/note`.

Confidence was not a useful discriminator: low-value rows and good rows both
appeared at ordinary confidence values. The safest prompt-only target is the
8-12% inferable/no-experience slice; duplicate clustering and null synopsis
repair belong to separate quality work.

## Layer Recommendation

Issue 919 should stay at the formation-prompt layer. The prompt can cheaply
raise the bar for inferability, experiential evidence, and precision without
changing persistence semantics.

The full-loop harm sample does not justify a programmatic save-time reject gate
for issue 921. The product-relevant harms were use-time application failures:
the memories were usually specific enough, but the agent applied them in the
wrong file, too late in the workflow, or beyond the requested boundary. A
programmatic formation gate would not have rejected most of those rows.

If issue 921 proceeds, it should be evaluated against a replay set whose
positive class is actually vague, inferable, redundant, or wrong saved memory.
For the harms above, the better intervention point is the use/evaluation layer:
task-boundary adherence, expected-test targeting, and reviewer checks for
over-scoped implementation.
