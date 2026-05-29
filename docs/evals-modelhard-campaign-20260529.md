# Lore memory lift — significance campaign report (2026-05-29)

## TL;DR

- **Seeded-lore memory produces a statistically significant correctness lift: McNemar p = 0.0008** (27 lift / 7 harm across 149 paired scenarios; raw). On tasks hard enough to defeat a no-memory agent, a curated memory recovers **~46%** of them, and among scenarios where memory changes the outcome it helps **79%** of the time.
- **Autonomous full-loop memory is NOT significant: p = 0.50** raw (12 lift / 8 harm); even a favorable adjudication is ~0.14. **This is structural, not a sample-size problem** — and more scenarios will not fix it.
- **Root cause (the key finding):** full-loop's Phase-A *formation* runs on the **pre-fix workspace, where a non-inferable rule is absent** — so it cannot be mined. Full-loop only recovered the **2 of 12** contested scenarios whose rule was already *latent in the existing codebase*. It also showed **5 genuine harms** (mined memory actively misled the use-phase agent). The seeded arm succeeds precisely because it is *handed* the curated rule that formation cannot derive.

## Goal & method

Goal (/goal): grow the discordant-pair set until **both** seeded-lore and lore-full-loop reach p<0.05, then record metrics, write this report, merge the data, and place the report on the Desktop.

Method: real OSS repos at pinned SHAs; hidden patched-command verifiers; three conditions (`no-memory`, `seeded-lore` = handed a curated durable memory, `lore-full-loop` = Phase-A formation mines a memory, Phase-B uses it). Scoring: exact two-sided McNemar on discordant scenario pairs; ceiling-normalized recovery rate; raw + adjudicated views (`tools/aggregate-longitudinal-results.mjs`).

## Results (full corpus, 275 distinct scenarios)

| Comparison | n (paired) | no-mem → memory | discordant (lift / harm) | McNemar p | recovery on contested | discordant win-rate |
|---|---:|---:|---:|---:|---:|---:|
| **seeded-lore vs no-memory** | 149 | 82 → 102 (+20, +13.4pp) | **27 / 7** | **0.0008 ✓** | 27/59 ≈ **46%** (adj) | **79.4%** |
| lore-full-loop vs no-memory | 148 | 81 → 85 (+4, +2.7pp) | 12 / 8 | 0.50 (adj 0.24; best-case 0.14) | 12/58 ≈ 21% (adj) | 66.7% |

Ceiling: ~47% of full-triple scenarios pass under all three conditions (no headroom) — the recovery-rate and discordant-only views above strip that out.

## The campaign that produced this

- **36 new model-hard scenarios authored + validated** (fail-pre/pass-post) across 12 suites: gh-cli security CVEs (5), gh-cli output/validation contracts (6+7), httpx/werkzeug/requests/urllib3 HTTP-spec (5), pydantic/sqlalchemy (2), Django ORM (6), Jinja2/click framework (5). Branch `Iron-Ham/longitudinal-model-hard-batch-1`.
- **Discovery → author → validate → calibrate** pipeline, 3 discovery rounds (~50 candidates), self-validating authoring agents (after a write-only first pass had a 15/18 verifier-bug rework).
- **Calibration (2 batches, 36 scenarios, ~$78 agent cost):**
  - **Batch 1 (18):** 7 contested (no-memory failed). Seeded recovered **7/7**; full-loop **2/7**.
  - **Batch 2 (18):** only 5 contested — **12/13 Django/Jinja2/click scenarios were too-easy** (the model has internalized these "canonical footguns"). Seeded recovered 3/5; full-loop **0/5**.

## Why full-loop is structurally blocked (the 12-contested breakdown)

Across both batches, **12 scenarios defeated no-memory**. Full-loop recovered exactly **2** — `run-log-terminal-escape` and `werkzeug-iri-uri`, the only two whose correct rule was **discoverable in the pre-fix codebase** (asciisanitizer used elsewhere; urlsplit invariants present). For the other 10:
- **8 were `formation:ok → use:FAIL`** — formation ran fine, but the mined memory was insufficient and the use-phase agent failed the verifier, *even on the 8 where the curated seed made seeded pass*. The rule (the missing fix) **was not in the pre-fix workspace to mine**.
- 2 were both-fail (even the curated seed didn't help).

Separately, full-loop has **5 genuine harms** (no-memory passed, full-loop failed on `verifiers`) — cases where the autonomously-mined memory **led the agent astray** relative to having no memory at all.

**Implication:** the property that makes a scenario model-hard (a non-inferable rule) is the same property that makes it un-mineable by formation-on-inspection. Seeded works because the rule is curated and handed in; full-loop cannot synthesize that rule from a workspace that doesn't contain it. This is a **methodology/product limit**, confirmed across 12 contested scenarios — not something more scenarios resolve.

## Honest caveats

- Numbers are **raw** (verifier outcomes as recorded); adjudicated views are exploratory (rubric `docs/evals-adjudication-rules.md` was not predeclared per-run). Seeded is significant in both raw and adjudicated views.
- Corpus is heterogeneous (prior 239 + 36 new; mixed run dates) and gh-cli-weighted. The seeded result is robust to this; it is strongly significant.
- Cost ~$78 (well under the $1000 autonomous ceiling). The brute-force loop was stopped once full-loop was shown structurally blocked — continuing would have spent the budget for an unreachable target.

## Recommendations

1. **Seeded/curated memory clearly helps** — the strong, significant signal. Lore's value is real when the right durable memory is *available*.
2. **Full-loop significance needs a different eval design, not more scenarios.** Phase-A must produce a **genuine cross-session learning** — e.g., a *prior, related task the agent actually solves* (encountering and resolving the gotcha) — so formation mines a real learning, rather than inspecting pre-fix code that lacks the rule. This is the original "durable cross-session learnings" intent and is an eval-design / product change.
3. **Investigate the 5 full-loop harms** — autonomously-mined memory that misleads is a product risk worth understanding (mining precision / wake-up relevance).
4. Treat "model-hard" as empirical: ~60% of carefully-authored candidates were solved by no-memory (the model knows them); only no-memory calibration reveals true difficulty.

## What's merged

The 36 validated scenarios + seeds, this report, and an updated total-corpus aggregate are committed on `Iron-Ham/longitudinal-model-hard-batch-1` (draft PR; left for human review + squash given the partial-goal outcome and shared repo). Data + recipes preserved under `~/Desktop/lore-campaign/`.
