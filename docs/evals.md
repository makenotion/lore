# Lore Evals

Lore evals measure whether memory changes agent outcomes, not just whether
search returns plausible rows. The default harness is the **retrieval runner**:
it reads committed YAML fixtures, loads them into fixture-backed services,
runs the production `loadWakeUpData` wake-up retrieval composition, scores
surfaced memory IDs, and writes a JSON artifact. The retrieval runner never
reads or writes a live Notion vault -- its fixture adapter replaces Notion
search.

The retrieval runner protects eight wake-up memory-surfacing sections:
`taskMemories` (the default), `taskOnly`, `memories` (recents),
`relatedMemories`, `staleConfidence`, full `context`, `pinnedContext`, and
`inheritedMemories`.
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

Because the live sandbox vault state is not committed, runners against it are
not deterministic the way fixture runs are; treat notion-mode CI as a coarser
signal that catches retrieval-stack regressions across the rate limiter, search
composition, and Notion-side ranking -- not the per-row precision the fixture
suite measures. Single-task pass/fail flips between adjacent runs are expected
noise from Notion's hybrid search; only aggregate trends and sustained per-task
regressions matter.
