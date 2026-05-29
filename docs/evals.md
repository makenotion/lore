# Lore Evals

Lore evals measure whether memory changes agent outcomes, not just whether
search returns plausible rows. The default harness is the **retrieval runner**:
it reads committed YAML fixtures, loads them into fixture-backed services,
runs the production `loadWakeUpData` wake-up retrieval composition, scores
surfaced memory IDs, and writes a JSON artifact. The retrieval runner never
reads or writes a live Notion vault -- its fixture adapter replaces Notion
search.

The retrieval runner protects seven wake-up memory-surfacing sections:
`taskMemories` (the default), `taskOnly`, `memories` (recents),
`relatedMemories`, full `context`, `pinnedContext`, and `inheritedMemories`.
Each task selects the surface under test via the `surface` field. The fixture
adapter replaces Notion search, so the retrieval runner does not claim to
benchmark Notion vector ranking or the wake-up debug metrics emitted by the
observability path.

A second mode, the **Notion-backed runner** (`--runner notion`), points the
same suite YAML at an operator-configured sandbox project and exercises the
real retrieval stack -- Notion's rate limiter, hybrid search composition,
contains/semantic fusion, ranking. It performs **live Notion reads** scoped to
the project named via `--project`, but does not write to the vault. Use it
nightly or on PRs that touch retrieval composition; don't use it as the per-PR
hot-path gate.

## Eval Docs

| Need                                                                                                     | Read                                                                   |
| -------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Runner overview, quick start, sandbox-vault discipline, shared vault registry                            | This file                                                              |
| Retrieval YAML schema, wake-up surfaces, task-eval suites, metrics, baseline refresh/drift rules         | [`evals-suite-format.md`](evals-suite-format.md)                       |
| LongMemEval bench setup, env vars, ingestion/retrieval strategies, profile suites, safety gates, cleanup | [`evals-longmemeval.md`](evals-longmemeval.md)                         |
| Phase 0/A/B decisions, rejected alternatives, historical benchmark selection evidence                    | [`archive/evals-phase-decisions.md`](archive/evals-phase-decisions.md) |

## Run The Starter Suite

```bash
npm run build
node dist/cli.js eval run evals/suites/lore-core.yaml
```

The starter retrieval suite writes a JSON artifact under `evals/results/` by
default. Pass `--out <path>` to choose a deterministic artifact path for CI or
comparison runs:

```bash
node dist/cli.js eval run evals/suites/lore-core.yaml \
  --out evals/results/lore-core-latest.json \
  --json
```

## Runner Modes

Five runners ship today. `retrieval` and `notion` share the same suite YAML
format and surface registry; `task`, `bench`, and `profile` each have their own
suite shape and scoring path because they score agent-produced workspace state,
LongMemEval-style multi-session recall, or profile taxonomy quality rather than
retrieved memory ids:

| Runner                | What it exercises                                                                                                                                   | Where to use it                                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `retrieval` (default) | Fixture-backed `loadWakeUpData` with deterministic token-overlap search. No Notion calls.                                                           | Per-PR CI; the inner-loop fast feedback.                                                                                                 |
| `notion`              | Real `loadWakeUpData` against `LoreServices` initialized from `.lore.yaml`. Hits Notion.                                                            | Nightly CI; PRs that touch retrieval composition or ranking.                                                                             |
| `task`                | End-to-end agent run against a synthetic workspace, scored by deterministic verifiers. Shells out to `codex exec`.                                  | Nightly CI; opt-in PRs. Slow + model-cost; not the per-PR hot path.                                                                      |
| `bench`               | End-to-end LongMemEval bench: per-example ingest + recall through Lore MCP + judge. Hits Notion + OpenAI.                                           | Operator-dispatched only (workflow_dispatch). The most expensive runner; produces a number we can publish alongside Zep / MemGPT / Mem0. |
| `profile`             | Deterministic profile-owned extraction artifacts scored against taxonomy, required-field, and hallucination expectations. No Notion or model calls. | Per-profile support suites and PRs that change profile manifests, schemas, or extraction contracts.                                      |

Pass `--runner notion --project <SandboxProject>` to route a run through the
production retrieval stack (rate limiter, hybrid search, contains/semantic
fusion, ranking) against an operator-maintained sandbox vault. Per-task results
collapse to a single synthetic `live-vault` scenario; the runner uses the
helpful-memory expectation as the live-vault assertion **because the live vault
IS the "memory is present" state by definition**. The other ablations
(`no-lore`, `empty-lore`, `noisy-memory`, `stale-memory`) cannot be replayed
against a single live vault state without seed/cleanup infrastructure, so
notion-mode is structurally one-scenario-per-task. Lift / harm metrics therefore
stay `null` in notion mode. `shouldNotSurface` lists from the helpful-memory
expectation are forwarded into the live-vault assertion but are typically empty
in retrieval-mode helpful scenarios; if non-empty, those ids almost certainly
don't exist in the live vault and the assertion silently passes.

Suite syntax, task-mode verifier details, retrieval metrics, and baseline drift
rules live in [`evals-suite-format.md`](evals-suite-format.md). LongMemEval
bench operations and the temporal-fidelity caveat that must travel with
published benchmark numbers live in
[`evals-longmemeval.md`](evals-longmemeval.md).

## Sandbox Vault Discipline

Notion-mode suites typically live alongside the fixture suite but reference
**real Notion page ids** in `shouldSurface`. The committed `lore-core` suite
uses synthetic ids (e.g. `decision/auth-model`) and will not match anything on
a real vault -- author a parallel suite under `evals/suites/<name>-sandbox.yaml`
whose `shouldSurface` lists the actual ids from the operator's sandbox vault.

The CLI rejects project names that don't **word-boundary**-match one of
`sandbox`, `eval`, `test`, `scratch`, `staging`, `dev`, or `playground` unless
`LORE_EVAL_NOTION_ALLOW_PRODUCTION=1` is set in the environment. Notion-mode
reads are technically read-only, but pointing the runner at a production vault
still hammers per-token rate limits and surfaces misleading "drift" against
fixture-shaped expectations -- the env-var gate forces an explicit decision.

The boundary is a regex `\b` word boundary, so `Widget-staging`, `Eval-Project`,
and `dev-vault` all pass, but **camel-case names without a separator**
(`EvalProject`, `TestVault`) reject -- the regex sees those as embedded
substrings rather than standalone markers. If your sandbox uses a camel-case
convention, either add a separator (`Eval-Project`) or set the env var to opt
in.

## Evaluation Vault Registry

Shared live eval vault locators live in
[`evals/vaults.yaml`](../evals/vaults.yaml). The registry may commit Notion
workspace ids and vault page ids because they are access locators, not bearer
credentials; operators still need matching Notion auth and page access. Never
commit tokens or generated `.lore.yaml` files.

List the registered vaults:

```bash
npm run build
node dist/cli.js eval vaults
```

Materialize a local config root for the seeded dev sandbox:

```bash
mkdir -p /tmp/lore-eval-vaults/lore-dev-sandbox
node dist/cli.js eval vaults show lore-dev-sandbox --config \
  > /tmp/lore-eval-vaults/lore-dev-sandbox/.lore.yaml
node dist/cli.js eval vaults show lore-dev-sandbox --env
```

Live evals that are measuring cost should opt into Lore's local cost ledger in
that sandbox config root before running:

```yaml
costTracking:
  enabled: true
  ledgerPath: /tmp/lore-eval-vaults/lore-dev-sandbox/eval-costs.jsonl
```

Run the live longitudinal suite against that vault by pointing
`LORE_EVAL_LONGITUDINAL_CONFIG_ROOT` at the generated config root, exporting the
vault selector env, and opting into the live task runner:

```bash
NOTION_ENV=dev \
NOTION_WORKSPACE_ID=415fc269-e68f-4da0-b3e3-b1273b741a7f \
LORE_EVAL_LONGITUDINAL_CONFIG_ROOT=/tmp/lore-eval-vaults/lore-dev-sandbox \
LORE_EVAL_TASK_REAL=1 \
LORE_EVAL_LONGITUDINAL_REAL=1 \
LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT="Eval Sandbox" \
node dist/cli.js eval run --runner task evals/task-suites/longitudinal.yaml
```

The initial seeded-vault validation recorded in the registry is a smoke run,
not a statistically powered benchmark: it ran all 4 scenarios in the committed
longitudinal suite across both conditions (8 condition runs total). On
2026-05-14, `no-memory` passed 3/4 scenarios, `lore-full-loop` passed 4/4
scenarios, and the observed success-rate lift was +25 percentage points.

An OSS direction-setting pilot lives at
`evals/task-suites/longitudinal-github-cli-pilot.yaml`. It materializes GitHub
CLI (`cli/cli`) at pinned commit
`9a593ce81b593dee752cc11737d1a3ef768e52b3` and runs five scenarios across
`no-memory`, `seeded-lore`, and `lore-full-loop`. Treat this suite as pilot
instrumentation only: it is meant to estimate verifier stability, paired
discordance, token cost, and runtime before choosing the powered sample size for
the 15 percentage point MDE benchmark. It is not a statistically powered result.
Its source-controlled seed corpus lives at
`evals/vault-seeds/github-cli-pilot.yaml`; it models GitHub CLI as one project
with component-level topics, not as a monorepo.

A larger PR-derived and generalized candidate bank lives at
`evals/task-suites/longitudinal-github-cli-powered-candidates.yaml`, backed by
`evals/vault-seeds/github-cli-powered.yaml`. It is a scenario pool, not a fixed
balanced dataset. As model capability moves, scenarios can be demoted from hard
to medium or medium to easy, so the pool is expected to have more easy scenarios
than medium scenarios and fewer hard scenarios than medium scenarios. Powered
runs should draw a deterministic random sample from that pool and record the
seed rather than assuming every authored scenario belongs in the headline
measurement. Those candidate scenarios are not independent statistical units:
many intentionally cluster around the same source memory or source pull
request. Do not publish it as the powered benchmark result until candidates
have been validated for prompt bounds, no-op baseline failure, verifier
stability, runtime, and cost.

The primary powered comparison is `lore-full-loop` vs. `no-memory`, because it
measures Lore's end-to-end formation/retrieval/use loop. `seeded-lore` is an
ablation for separating vault availability from memory formation quality.
The 2026-05-27 GitHub CLI checkpoint is recorded in
[`docs/evals-github-cli-powered-20260527.md`](evals-github-cli-powered-20260527.md).
`lore-full-loop` scenarios should validate durable cross-session learnings that
Lore is designed to capture, such as decisions, conventions, gotchas,
workarounds, and explicit future follow-ups. They should not require generic
project facts or Phase B-only feature details to be captured unless Phase A
makes that durable follow-up explicit. Before a powered run, pre-register the
cluster/capping rule for repeated source memories and PRs, the multiplicity
treatment for secondary comparisons, and the culling rules used to promote
candidates. Candidate culling must be blind to condition deltas: remove tasks
only for objective validity failures such as no-op pass, verifier ambiguity,
prompt out-of-bounds behavior, flake rate, runtime, or cost.

Phase B starts from a clean rematerialization of the original workspace source,
not the Phase A workspace. Phase A edits are preserved only as transcript and
patch evidence for adjudication; they must not become implicit implementation
state for `no-memory`, `seeded-lore`, or `lore-full-loop`. Any cross-session
benefit must therefore flow through seeded context or Lore formation/wake-up.

Keep raw and adjudicated measurements separate. If a run fails because of
harness validation, infrastructure, or an over-narrow verifier, preserve the raw
artifact and classify the row before scoring. A row marked `harness-error` is
not evidence of real-world agent performance and must be rerun or excluded from
the headline measurement. If the transcript, diff, verifier output, and command
results objectively prove that an agent satisfied the intended scenario under a
repaired verifier, an adjudicated score may be reported without rerunning that
condition. Final reports should include raw, adjudicated, and exclusion-only
sensitivity views.

For `lore-full-loop`, formation and wake-up phase errors are product failures
unless they were caused by external infrastructure or harness setup. Expected
context matching is diagnostic, not an outcome override: missing expected memory
can explain a verifier failure, but it does not turn a verifier-passing task
into a failure. Longitudinal task artifacts write transcript and patch sidecars
next to the JSON result so reviewers can adjudicate verifier false negatives
after temporary workspaces are cleaned up.

```bash
npm run build
NOTION_ENV=dev \
NOTION_WORKSPACE_ID=415fc269-e68f-4da0-b3e3-b1273b741a7f \
LORE_EVAL_LONGITUDINAL_CONFIG_ROOT=/tmp/lore-eval-vaults/lore-dev-sandbox \
LORE_EVAL_TASK_REAL=1 \
LORE_EVAL_LONGITUDINAL_REAL=1 \
LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT="Eval Sandbox" \
node dist/cli.js eval run --runner task \
  evals/task-suites/longitudinal-github-cli-pilot.yaml \
  --out evals/results/longitudinal-github-cli-pilot.json
```

For a powered pool run, select a reproducible sample by difficulty bucket. The
runner hashes the seed and scenario IDs, fails fast if a bucket is undersized,
shuffles the selected scenarios into a deterministic cross-bucket run order so
partial artifacts are not front-loaded with easy cases, and records the
selected scenario IDs in the artifact:

```bash
node dist/cli.js eval run --runner task \
  evals/task-suites/longitudinal-github-cli-powered-candidates.yaml \
  --sample easy=25,medium=15,hard=10 \
  --sample-seed 2026-05-27-nightly \
  --parallel 16 \
  --cost-kill-switch-usd 1500 \
  --out evals/results/longitudinal-github-cli-powered-sample.json
```

The run writes Codex JSONL transcript sidecars next to the artifact, in
a directory derived from the output filename, such as
`evals/results/longitudinal-github-cli-powered-sample-transcripts/`. Use those
sidecars to inspect prompts, event streams, tool activity, and per-turn usage
evidence without bloating the main JSON artifact.

The GitHub CLI longitudinal suites set `costKillSwitchUsd: 1500`. This is an
overnight guard between condition runs: once observed priced cost reaches the
limit, the runner stops before launching another agent subprocess and persists
a partial artifact with a `termination` block. If agent usage is unavailable or
unpriced, the guard stops fail-closed instead of treating that work as free.
Operators can override the suite value for a run with
`--cost-kill-switch-usd <n>`.

Cost is split across two surfaces. Primary Phase A/Phase B agent spend is
recorded in the eval artifact under each phase's `cost` object using Codex
`turn.completed` usage when available. Lore-owned spend is recorded in the
local cost ledger: post-session mining rows use
`eval.mining.background_model`, and MCP/Notion activity appears as
`mcp.invocation` rows. Inspect the Lore-owned side from the sandbox config root:

```bash
LORE_REPO=$PWD
cd /tmp/lore-eval-vaults/lore-dev-sandbox
node "$LORE_REPO/dist/cli.js" costs summary --since 24h
node "$LORE_REPO/dist/cli.js" costs export --since 24h --format csv \
  > /tmp/lore-eval-vaults/lore-dev-sandbox/eval-costs.csv
```

After a pilot artifact exists, estimate the powered run size, budget fit,
paired primary-agent token deltas, and paired runner phase elapsed deltas:

```bash
node dist/cli.js eval longitudinal plan \
  evals/results/longitudinal-github-cli-pilot.json \
  --mde 0.15 \
  --power 0.8 \
  --alpha 0.05 \
  --budget-usd 1000
```

The planner only projects cost from measured artifacts when every condition run
has complete primary-agent cost coverage. If any agent phase lacks priced usage,
the cost projection is reported as unavailable unless the operator supplies
`--cost-per-condition-run-usd`. The elapsed deltas are runner phase elapsed
time, not pure model latency: Phase A elapsed includes formation work, Phase B
elapsed includes verifier execution, and wake-up retrieval is outside the Phase
B timer.

Because the live sandbox vault state is not committed, runners against it are
not deterministic the way fixture runs are; treat notion-mode CI as a coarser
signal that catches retrieval-stack regressions across the rate limiter, search
composition, and Notion-side ranking -- not the per-row precision the fixture
suite measures. Single-task pass/fail flips between adjacent runs are expected
noise from Notion's hybrid search; only aggregate trends and sustained per-task
regressions matter.
