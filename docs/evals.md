# Lore Evals

Lore evals measure whether memory changes agent outcomes, not just whether
search returns plausible rows. The default harness is the **retrieval runner**:
it reads committed YAML fixtures, loads them into fixture-backed services,
runs the production `loadWakeUpData` wake-up retrieval composition, scores
surfaced memory IDs, and writes a JSON artifact. The retrieval runner never
reads or writes a live Notion vault — its fixture adapter replaces Notion
search.

The retrieval runner protects four wake-up memory-surfacing sections:
`taskMemories` (the default), `memories` (recents), `relatedMemories`, and
`staleConfidence`. Each task selects the surface under test via the
`surface` field. The fixture adapter replaces Notion search, so the
retrieval runner does not claim to benchmark Notion vector ranking or the
wake-up debug metrics emitted by the observability path.

A second mode, the **Notion-backed runner** (`--runner notion`), points the
same suite YAML at an operator-configured sandbox project and exercises the
real retrieval stack — Notion's rate limiter, hybrid search composition,
contains/semantic fusion, ranking. It performs **live Notion reads** scoped
to the project named via `--project`, but does not write to the vault. Use it
nightly or on PRs that touch retrieval composition; don't use it as the
per-PR hot-path gate.

## Run The Starter Suite

```bash
npm run build
node dist/cli.js eval run evals/suites/lore-core.yaml
```

## Runner modes

Two runners ship today, sharing the same suite YAML format and the same surface
registry:

| Runner | What it exercises | Where to use it |
| --- | --- | --- |
| `retrieval` (default) | Fixture-backed `loadWakeUpData` with deterministic token-overlap search. No Notion calls. | Per-PR CI; the inner-loop fast feedback. |
| `notion` | Real `loadWakeUpData` against `LoreServices` initialized from `.lore.yaml`. Hits Notion. | Nightly CI; PRs that touch retrieval composition or ranking. |

Pass `--runner notion --project <SandboxProject>` to route a run through the
production retrieval stack (rate limiter, hybrid search, contains/semantic
fusion, ranking) against an operator-maintained sandbox vault. Per-task results
collapse to a single synthetic `live-vault` scenario; the runner uses the
helpful-memory expectation as the live-vault assertion **because the live
vault IS the "memory is present" state by definition**. The other ablations
(`no-lore`, `empty-lore`, `noisy-memory`, `stale-memory`) cannot be replayed
against a single live vault state without seed/cleanup infrastructure, so
notion-mode is structurally one-scenario-per-task. Lift / harm metrics
therefore stay `null` in notion mode. `shouldNotSurface` lists from the
helpful-memory expectation are forwarded into the live-vault assertion but
are typically empty in retrieval-mode helpful scenarios; if non-empty, those
ids almost certainly don't exist in the live vault and the assertion silently
passes.

### Sandbox vault discipline

Notion-mode suites typically live alongside the fixture suite but reference
**real Notion page ids** in `shouldSurface`. The committed `lore-core` suite
uses synthetic ids (e.g. `decision/auth-model`) and will not match anything
on a real vault — author a parallel suite under
`evals/suites/<name>-sandbox.yaml` whose `shouldSurface` lists the actual ids
from the operator's sandbox vault.

The CLI rejects project names that don't **word-boundary**-match one of
`sandbox`, `eval`, `test`, `scratch`, `staging`, `dev`, or `playground`
unless `LORE_EVAL_NOTION_ALLOW_PRODUCTION=1` is set in the environment.
Notion-mode reads are technically read-only, but pointing the runner at a
production vault still hammers per-token rate limits and surfaces
misleading "drift" against fixture-shaped expectations — the env-var
gate forces an explicit decision.

The boundary is a regex `\b` word boundary, so `Mail-staging`, `Eval-Project`,
and `dev-vault` all pass, but **camel-case names without a separator**
(`EvalProject`, `TestVault`) reject — the regex sees those as embedded
substrings rather than standalone markers. If your sandbox uses a
camel-case convention, either add a separator (`Eval-Project`) or set the
env var to opt in.

Because the sandbox vault is not committed, runners against it are not
deterministic the way fixture runs are; treat notion-mode CI as a coarser
signal that catches retrieval-stack regressions across the rate limiter,
search composition, and Notion-side ranking — not the per-row precision the
fixture suite measures. Single-task pass/fail flips between adjacent runs
are expected noise from Notion's hybrid search; only aggregate trends and
sustained per-task regressions matter.

### Baselines and the runner contract

Baselines record their `runner` mode. `lore eval run --baseline <path>`
refuses to compare a baseline captured in one mode against an artifact from
another (they key results on disjoint scenario spaces — retrieval baselines
on ablations, notion baselines on `live-vault`). Capture a runner-matched
baseline with `lore eval baseline --runner <mode> ... <suite>` before
comparing.

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
    surface: wake-up.taskMemories  # default; omit for taskMemories
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

### Wake-up surfaces

Each task targets one wake-up surface via the optional `surface` field. The
runner zeroes out other section limits when running the task so the eval
exercises only the surface under test.

| Surface | Driver |
| --- | --- |
| `wake-up.taskMemories` (default) | The task's `prompt` becomes `userQuery`; relevance search ranks fixture memories. |
| `wake-up.memories` | Recents — fixture `memories` array order is the recency order. |
| `wake-up.relatedMemories` | Active tasks in the fixture's top-level `tasks: [...]` block seed entity-based search. The `entity` field on each task drives the seed query. |
| `wake-up.staleConfidence` | Fixture memories with `isStaleConfidence: true` populate the surface. |

Every task must include the `no-lore`, `empty-lore`, and `helpful-memory`
ablations. Additional scenarios such as `noisy-memory` and `stale-memory` are
allowed as the suite grows.

`stale-memory` is the ablation that captures temporal correctness: the
fixture contains a previously-accepted decision (or other memory) that has
since been superseded or deprecated. The expectation is that retrieval does
not promote the stale row over the current one. The fixture runner enforces
this contract by suppressing rows whose `status` is `superseded`,
`deprecated`, or `rejected` from `searchFixtureMemories` and `memories.list`
before scoring. Stale-memory tasks should therefore list the **stale memory
id** under `stale-memory.shouldNotSurface` — when the status filter holds,
the row never surfaces, the assertion passes, and `memoryHarm` stays 0; if
a future change drops the filter (or surfaces the row another way), the
assertion fires and `memoryHarm` flags the regression.

This is the eval's enforced ideal. Production retrieval today is
status-blind (Notion's `dataSources.query` and `client.search` do not
filter on the `Status` column), so the Notion-backed runner can report
`memoryHarm > 0` against the same suite — that gap is what #284 (temporal
recall) tracks.

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
minimum memory-lift threshold, a maximum memory-harm threshold, and a
committed baseline drift check, then uploads the JSON artifact for inspection.

## Baselines

Baselines live under `evals/baselines/` as comparison-stable JSON snapshots
captured from a known-good run. The committed `evals/baselines/lore-core.json`
is the reference that CI diff-checks every PR against.

```bash
# Capture a fresh baseline (operator command — review the diff before commit)
node dist/cli.js eval baseline evals/suites/lore-core.yaml \
  --out evals/baselines/lore-core.json \
  --notes "Why this baseline was refreshed"
```

The snapshot drops timing/order-sensitive fields (`startedAt`,
`metrics.elapsedMs`) and pins per-result `success`, `recall`, and `precision`
plus the aggregate retrieval summary.

### Drift detection

`lore eval run` accepts `--baseline <path>` to compare a fresh run against a
committed snapshot:

```bash
node dist/cli.js eval run evals/suites/lore-core.yaml \
  --baseline evals/baselines/lore-core.json
```

Regression triggers (any one flips the run to a non-zero exit):

- A previously-passing result now fails (per-task regression).
- `failedResults` increases vs. baseline.
- `memoryHarm` increases past the baseline value (no tolerance — any new harm
  is a regression).

Aggregate metric drops on `averageRecall` / `averagePrecision` /
`memoryLift` are surfaced in the drift report for visibility, but do not
themselves auto-regress: any per-result drop already shows up as a new
failure, and a metric drop without a per-result regression usually means a
previously-failing result was tightened.

Per-result identity is keyed on `(taskId, scenario, surface)` — a task that
exercises multiple surfaces under one scenario keeps each surface's row
distinct in the drift gate's `Map` lookups. A regression test pins this
contract so a future contributor cannot silently narrow the key back to
the legacy 2-key `(taskId, scenario)` form (which would clobber siblings
under the same `(taskId, scenario)` and silently drop coverage from the
drift gate).

Byte-stable `lore eval baseline` output is **retrieval-mode only**. The
retrieval runner pins `DEFAULT_RETRIEVAL_NOW` so per-result rows and
aggregate metrics reproduce across runs. The notion runner uses real
wall-clock time and hits live Notion, so its baselines record real
timestamps and may have per-trial variance from hybrid-search noise — the
drift gate is a coarser per-result success/recall comparator there, not a
byte-equality check. A future refactor that re-introduces `new Date()`
into `runRetrievalSuite` will silently re-introduce nondeterminism into
retrieval-mode baselines; if you change the clock seam, update this
section and the snapshot in lockstep.

### When to refresh the baseline

Refresh the baseline (`lore eval baseline ... --out evals/baselines/<suite>.json`
followed by an explicit commit) when:

- A new task lands and adds rows the baseline didn't have. The drift report
  surfaces these under `New results (refresh baseline)`; the CI gate will not
  regress on them, but operators should refresh so the next PR's drift check
  has stable expectations.
- A scenario expectation tightened intentionally (e.g., temporal-correctness
  work landed and stale-memory `shouldNotSurface` lists were tightened to
  list stale ids).
- A retrieval improvement raised lift / lowered harm and the new metrics
  should become the floor.

Refreshing the baseline as a side effect of a PR that introduces a regression
defeats the purpose of the gate — review the diff before committing.

The JSON artifact is the comparison contract. Human CLI output is only a
summary. `startedAt` is operational metadata; compare `results` and `summary`
when checking deterministic regressions.
