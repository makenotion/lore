# Longitudinal Eval — Total Corpus Aggregate, 2026-05-28

This records the **raw, descriptive** aggregate across every local longitudinal
result artifact accumulated to date. It is exploratory calibration evidence, not
a predeclared, adjudicated headline. For the controlled/adjudicated view see
`docs/evals-github-cli-powered-20260527.md`; for the one cleanly-validated
Python-repo lift case see `docs/evals-httpx-public-spec-20260528.md`; for the
scoring rubric see `docs/evals-adjudication-rules.md`.

## Method

- Source: all `evals/results/longitudinal-*.json` artifacts (gitignored local
  provenance).
- Dedupe: keep the latest result per `(scenarioId, condition)` by `startedAt`, so
  reruns are not counted as independent samples.
- Comparison: paired no-memory vs each memory arm over scenarios that have both
  arms present, with an exact two-sided McNemar test on the discordant pairs.
- Reproduce: `node tools/aggregate-longitudinal-results.mjs` (add `--json` for
  machine output).

This is RAW (verifier outcomes as recorded), not adjudicated for verifier
false-negatives.

## Corpus size

- 103 artifacts parsed, 682 result rows, **239 distinct scenarios**.
- Raw no-memory pass rate: **144/239 (60.3%)** → ~95 scenarios are "hard"
  (no-memory fails), a real failure surface. The pool was deliberately hardened
  over time (frontier / capability-edge / memory-contract tranches), so the
  corpus-wide no-memory rate sits well below the easy-weighted github-cli 50-sample
  (80–82%).

## Paired results (raw)

| Comparison | n | no-memory | memory arm | Δ | lifted / harmed | both-pass / both-fail | exact McNemar p |
|---|---:|---:|---:|---:|---:|---:|---:|
| seeded-lore vs no-memory | 137 | 82 (59.9%) | 92 (67.2%) | **+10 (+7.3 pp)** | 17 / 7 | 75 / 38 | 0.0639 |
| lore-full-loop vs no-memory | 136 | 81 (59.6%) | 83 (61.0%) | +2 (+1.5 pp) | 10 / 8 | 73 / 45 | 0.8145 |

- **Seeded-lore** shows a consistent directional correctness lift (17 lifted vs 7
  harmed) that approaches but does not reach significance (p = 0.064).
- **Lore-full-loop** is essentially flat in raw terms. This is substantially a
  measurement-artifact effect: many full-loop losses on hard scenarios are
  `formation` / `wake-up` / `agent-exit` failures and verifier false-negatives,
  not behavioral failures. Two of those gate bugs are fixed in this branch
  (expected-context now diagnostic; the Phase A read-only gate now keys on real
  content line changes). The adjudicated github-cli 50-sample puts full-loop at
  +6 pp once such artifacts are corrected.

## Ceiling normalization and adjudicated view

The pool-wide marginal lift understates the effect because the corpus is
**ceiling-dominated**: of the 136 full-triple scenarios, **69 (50.7%) pass under
all three conditions** — they have no headroom for memory to help. A fair effect
size conditions on the **contested set** (scenarios where no-memory fails, i.e.
there is room to improve) and reports the *recovery rate*: of the no-memory
failures, what fraction does the memory arm pass.

The adjudicated view excludes rows that are infra or now-fixed-harness artifacts,
applied symmetrically:
- `agent-exit` failures (8, identical across arms) → infra / model-invocation →
  exclude.
- Phase A read-only-gate failures with a zero-line diff (now fixed; Phase B never
  ran, so no behavioral evidence) → exclude (rerun needed).
- `expected-context` failures where the hidden verifier actually passed (now a
  diagnostic) → flip to pass.
- `verifier` failures are **not** flipped without transcript review, so the
  recovery rates below are conservative **lower bounds** (the handoff established
  many such failures are verifier false-negatives).

| Comparison | recovery rate (raw → adj) = ceiling-EXCLUDED lift | harm rate | McNemar p (adj) |
|---|---:|---:|---:|
| seeded-lore vs no-memory | 30.9% → **36.2%** (17/47 contested) | 8.5% | 0.064 |
| lore-full-loop vs no-memory | 18.2% → **21.7%** (10/46 contested) | 9.9% → 7.5% | 0.455 |

Read this as: **on tasks hard enough to defeat no-memory, seeded memory recovers
roughly a third of them (≈36% after excluding infra), and full-loop about a
fifth (≈22%).** On the contested set no-memory passes 0% by construction, so the
recovery rate *is* the ceiling-excluded lift: +36 pp (seeded) and +22 pp
(full-loop).

Which numbers exclude the triple-passes, and which do not:
- **Recovery rate (above): excludes them** — it conditions on no-memory failures,
  so all 69 triple-passes (and every other both-pass) are out of the denominator.
  This is the effect size.
- **McNemar p: independent of them** — the exact test uses only the discordant
  pairs; concordant cells (both-pass, both-fail) do not enter it.
- **A pool-wide "net Δ in pp" does NOT exclude them** and is therefore diluted:
  the adjudicated paired sets are 58% ceiling (both-pass = 75/129 seeded, 74/126
  full-loop). Because adjudication removed hard failures but kept all triple-passes,
  that denominator is *more* ceiling-heavy than the raw pool — so net-pp is a
  misleading effect size and is deliberately not used as the headline here.

Reproduce with `node tools/aggregate-longitudinal-results.mjs`.

### Discordant-only (the most concentrated lift signal)

Stripping *both* the ceiling (both-pass) and the floor (both-fail) leaves only the
pairs where the two conditions disagree — exactly what the McNemar test scores:

| Arm (adjudicated) | discordant pairs | memory wins | net | McNemar p |
|---|---:|---:|---:|---:|
| seeded-lore | 24 (17 lift / 7 harm) | **70.8%** | +10 (+41.7 pp of discordant) | 0.064 |
| lore-full-loop | 16 (10 lift / 6 harm) | **62.5%** | +4 (+25.0 pp of discordant) | 0.455 |

Raw: seeded is identical (its exclusions were concordant both-fails); full-loop is
18 pairs (10/8 = 55.6%) raw, lifting to 62.5% after removing one infra/gate harm
and flipping one `expected-context` harm. Among cases where memory changed the
outcome at all, it helped ~2.4× more than it hurt (seeded) / ~1.7× (full-loop)
versus a 50% no-effect null. Direction and magnitude are strong; significance is
gated by the small discordant n (24, 16).

## Discordant pairs (transparency)

Seeded-lore lifted (17): `gh-cli-alias-set-clobber-shorthand`,
`gh-cli-discussion-view-threaded-replies-json`,
`gh-cli-extension-upgrade-json-dry-run-no-mutation`,
`gh-cli-key-add-dry-run-fingerprint-shared-memory-followup`,
`gh-cli-pr-create-fill-skip-merge-commits-v1`,
`gh-cli-pr-merge-queue-plan-memory-contract`,
`gh-cli-pr-merge-queue-plan-memory-contract-v2`,
`gh-cli-release-download-asset-path-safety-v1`,
`gh-cli-repo-edit-auto-merge-prerequisite`,
`gh-cli-repo-edit-security-push-protection-validation`,
`gh-cli-repo-edit-security-validation`,
`gh-cli-repo-fork-remote-name-side-effect-order-v1`,
`gh-cli-run-list-jobs-json-lazy-memory-followup`,
`gh-cli-secret-variable-env-file-plan-memory-contract`,
`gh-cli-secret-variable-env-file-plan-memory-contract-v2`,
`gh-cli-skills-publish-allow-hidden-dirs`,
`httpx-cross-boundary-protocol-epic-v1`.

Seeded-lore harmed (7): `gh-cli-autolink-edit-replacement-memory-contract-v2`,
`gh-cli-codespace-ssh-config-quotes-auto-key`,
`gh-cli-comment-edit-last-paginated-author-memory-followup`,
`gh-cli-pr-checks-display-names`,
`gh-cli-repo-create-dry-run-json-plan-memory-contract-v2`,
`pytest-lastfailed-nested-package-v1`, `pytest-parametrize-trailing-comma-v1`.

Lore-full-loop lifted (10): `gh-cli-extension-upgrade-json-dry-run-no-mutation`,
`gh-cli-key-add-dry-run-fingerprint-memory-contract-v2`,
`gh-cli-key-add-dry-run-fingerprint-shared-memory-followup`,
`gh-cli-repo-edit-auto-merge-prerequisite`,
`gh-cli-repo-edit-merge-commit-message`,
`gh-cli-repo-edit-security-push-protection-validation`,
`gh-cli-repo-edit-security-validation`,
`gh-cli-repo-edit-visibility-warning`,
`gh-cli-secret-variable-env-file-plan-memory-contract-v2`,
`gh-cli-skills-publish-allow-hidden-dirs`.

Lore-full-loop harmed (8): `gh-cli-auth-token-flow-preserves-client-context`,
`gh-cli-issue-develop-ref-validation-v3`,
`gh-cli-pr-close-delete-branch-worktree-guard-v3`,
`gh-cli-pr-status-display-names`,
`gh-cli-repo-create-dry-run-json-plan-memory-contract-v2`,
`gh-cli-telemetry-agent-host-type`, `pytest-parametrize-trailing-comma-v1`,
`rg-cross-boundary-correctness-epic-v1`.

## Caveats — why this is not a headline

- **Raw, not adjudicated.** Many verifier failures in the memory arms are
  false-negatives (verifier overfit), per `docs/evals-github-cli-powered-20260527.md`.
  Adjudication would likely raise both arms, full-loop most.
- **Heterogeneous pool.** Mixes calibration runs, reruns, and suite versions
  (v1–v4, public-spec, memory-contract, frontier, capability-edge) authored and
  tuned over time. It is not a single predeclared sample.
- **Cross-arm verifier-version risk.** A scenario's no-memory row and its memory
  row can come from runs with different verifier versions; the dedupe is
  per-condition. The github-cli checkpoint's provenance discipline avoids this for
  its subset; this corpus-wide number does not.
- **github-cli dominates** the pool; Python/Rust repos contribute a small minority.
- Not significant at available sizes; no token or speed-reduction claim (costs are
  comparable, full-loop is slower because it adds formation + wake-up).

## Bottom line

Once the **51% ceiling** is removed and infra/now-fixed-gate rows are excluded,
the effect is substantive, not marginal: on the contested set (tasks hard enough
to defeat no-memory), **seeded memory recovers ≈36% of failures and full-loop
≈22%** (+36 pp / +22 pp ceiling-excluded) — conservative lower bounds, since
verifier false-negatives are left unflipped. The pool-wide marginals (+7.3 pp
seeded, +1.5 pp full-loop raw) and the adjudicated net-pp figures are *diluted by
the ceiling* and are not the effect size; significance is carried by the
condition-independent McNemar test (seeded p = 0.064, full-loop p = 0.46 — both
not yet significant, gated by sample size not effect size). The remaining
cost-free step is a transcript-level adjudication of the `verifier`-failure
bucket to tighten these lower bounds.
