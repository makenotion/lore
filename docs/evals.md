# Lore Evals

Lore evals measure whether memory changes agent outcomes, not just whether
search returns plausible rows. The first harness is intentionally local and
retrieval-only: it reads committed YAML fixtures, loads them into fixture-backed
services, runs the production `loadWakeUpData` wake-up retrieval composition,
scores surfaced memory IDs, and writes a JSON artifact. It never reads or writes
a live Notion vault.

The retrieval runner protects the wake-up `taskMemories` surface. Its fixture
adapter replaces Notion search, so it does not claim to benchmark Notion vector
ranking or the wake-up debug metrics emitted by the observability path.

## Run The Starter Suite

```bash
npm run build
node dist/cli.js eval run evals/suites/lore-core.yaml
```

By default, result artifacts are written under `evals/results/`, which is
ignored by git. Use `--out <path>` to choose a deterministic artifact path for
CI or comparison runs.

```bash
node dist/cli.js eval run evals/suites/lore-core.yaml \
  --out evals/results/lore-core-latest.json \
  --json
```

## Suite Format

Suites are YAML files with task prompts, memory scenario fixtures, and retrieval
expectations:

```yaml
version: 1
name: lore-core
trials: 1
runner: retrieval

tasks:
  - id: respects-governing-auth-decision
    prompt: Add the requested feature while following the auth decision.
    memoryScenarios:
      no-lore: ../memory/no-lore.yaml
      empty-lore: ../memory/empty.yaml
      noisy-memory: ../memory/noisy.yaml
      helpful-memory: ../memory/auth-decision.yaml
    expectedRetrieval:
      helpful-memory:
        shouldSurface:
          - decision/auth-model
```

Every task must include the `no-lore`, `empty-lore`, and `helpful-memory`
ablations. Additional scenarios such as `noisy-memory` and `stale-memory` are
allowed as the suite grows.

The suite `version` is required. Retrieval mode is deterministic and requires
`trials: 1`; the CLI rejects other trial counts until a nondeterministic runner
exists.

## Designing A Task

Use one task for one memory-sensitive behavior. The prompt should describe the
developer action the agent would take, and the `shouldSurface` IDs should be the
minimum set of memories needed to do that action correctly.

Use `helpful-memory` to prove useful memory can surface. Keep `no-lore` and
`empty-lore` as mandatory baselines so the lift metric can tell the difference
between "the memory helped" and "nothing was available." Add `noisy-memory`
when plausible but irrelevant memory could crowd out the useful row, and add
`stale-memory` when old or deprecated guidance must not influence the task.

Use `shouldNotSurface` for memories that would actively harm the task, such as
deprecated decisions or unrelated notes that share tempting keywords. Retrieval
precision treats unlabeled surfaced memories as false positives, so label the
rows you intentionally expect to surface.

## Metrics

- **Task success**: for the retrieval runner, a trial succeeds when all
  `shouldSurface` memories appear and all `shouldNotSurface` memories stay out
  of the surfaced set.
- **Memory lift**: the helpful-memory recall minus the best baseline recall
  from `no-lore`, `empty-lore`, or `noisy-memory` when present. Positive lift
  means useful memory changed what the agent would see.
- **Memory harm**: the success-rate drop from `empty-lore` to `noisy-memory`
  or `stale-memory`, when those scenarios exist. This stays `null` for suites
  that do not define harm scenarios.
- **Retrieval recall**: the fraction of expected memory IDs that surfaced for
  a scenario.
- **Retrieval precision**: the fraction of surfaced memory IDs that were in
  `shouldSurface`, when labels exist. Labels are intentionally sparse: an
  unlabeled surfaced memory counts as a false positive for this metric until the
  suite labels it as expected.

Retrieval mode is deterministic, so it executes one pass per task/scenario.
Repeated trials matter once a runner includes nondeterministic agent execution.

CI should assert the metrics that matter for each starter suite, not only the
boolean result count. The committed CI gate runs the starter suite with a
minimum memory-lift threshold and a maximum memory-harm threshold, then uploads
the JSON artifact for inspection.

The JSON artifact is the comparison contract. Human CLI output is only a
summary. `startedAt` is operational metadata; compare `results` and `summary`
when checking deterministic regressions.
