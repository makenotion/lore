# Eval Suite Format

This reference covers retrieval-suite YAML, wake-up surfaces, task-eval suites,
metrics, and baseline drift rules. Start with [`evals.md`](evals.md) for the
runner overview, live-vault discipline, and registry commands. Use
[`evals-longmemeval.md`](evals-longmemeval.md) for bench-runner operations.

## Retrieval Suite Format

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
    surface: wake-up.taskMemories # default; omit for taskMemories
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

The suite `version` is required. Retrieval mode is deterministic and requires
`trials: 1`; the CLI rejects other trial counts until a nondeterministic runner
exists.

## Wake-Up Surfaces

Each task targets one wake-up surface via the optional `surface` field. The
runner zeroes out other section limits when running the task so the eval
exercises only the surface under test.

| Surface                          | Driver                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `wake-up.taskMemories` (default) | The task's `prompt` becomes `userQuery`; relevance search ranks fixture memories within the full wake-up data shape.                          |
| `wake-up.taskOnly`               | The task's `prompt` becomes `userQuery`; only query-ranked memories are loaded, so digest / recents / facts / task inventory noise is absent. |
| `wake-up.memories`               | Recents -- fixture `memories` array order is the recency order.                                                                               |
| `wake-up.relatedMemories`        | Active tasks in the fixture's top-level `tasks: [...]` block seed entity-based search. The `entity` field on each task drives the seed query. |
| `wake-up.staleConfidence`        | Fixture memories with `isStaleConfidence: true` populate the surface.                                                                         |
| `wake-up.context`                | Query-focused union of rendered memory channels. The prompt becomes `userQuery`; pinned and inherited governance channels are suppressed.     |
| `wake-up.pinnedContext`          | Fixture memories with `isPinnedContext: true` populate the pinned-context channel.                                                            |
| `wake-up.inheritedMemories`      | Fixture memories with `isInheritedMemory: true` populate one synthetic upstream inheritance channel.                                          |

Every task must include the `no-lore`, `empty-lore`, and `helpful-memory`
ablations. Additional scenarios such as `noisy-memory` and `stale-memory` are
allowed as the suite grows.

`stale-memory` is the ablation that captures temporal correctness: the fixture
contains a previously-accepted decision (or other memory) that has since been
superseded or deprecated. The expectation is that retrieval does not promote
the stale row over the current one. The fixture runner enforces this contract
by suppressing rows whose `status` is `superseded`, `deprecated`, or `rejected`
from `searchFixtureMemories` and `memories.list` before scoring. Stale-memory
tasks should therefore list the **stale memory id** under
`stale-memory.shouldNotSurface` -- when the status filter holds, the row never
surfaces, the assertion passes, and `memoryHarm` stays 0; if a future change
drops the filter (or surfaces the row another way), the assertion fires and
`memoryHarm` flags the regression.

This is the eval's enforced ideal. Production default list/search is not wholly
blind to review state: it excludes `proposed` and `rejected` rows by default,
using server-side filters for `dataSources.query` paths and a client-side
post-filter after `client.search`, which cannot apply property filters. The
remaining temporal-correctness gap is narrower: default production recall can
still surface `superseded` and `deprecated` rows unless a caller requests a
status-specific slice or another lifecycle-aware path removes them. The
Notion-backed runner exercises that production behavior, so `memoryHarm > 0`
against stale-memory tasks still tracks the `superseded` / `deprecated` recall
gap covered by #284 (temporal recall).

## Designing A Task

Use one task for one memory-sensitive behavior. The prompt should describe the
developer action the agent would take, and the `shouldSurface` IDs should be the
minimum set of memories needed to do that action correctly.

Use `helpful-memory` to prove useful memory can surface. Keep `no-lore` and
`empty-lore` as mandatory baselines so the lift metric can tell the difference
between "the memory helped" and "nothing was available." Add `noisy-memory`
when plausible but irrelevant memory could crowd out the useful row, and add
`stale-memory` when old or deprecated guidance must not influence the task.
For task-focused wake-up, model pinned and upstream noise with
`isPinnedContext` and `isInheritedMemory` fixtures plus `shouldNotSurface`
expectations; those channels are measured separately from query-ranked task
memory.

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
- **Memory harm**: the success-rate drop from `empty-lore` to `noisy-memory` or
  `stale-memory`, when those scenarios exist. This stays `null` for suites that
  do not define harm scenarios.
- **Retrieval recall**: the fraction of expected memory IDs that surfaced for a
  scenario.
- **Retrieval precision**: the fraction of surfaced memory IDs that were in
  `shouldSurface`, when labels exist. Labels are intentionally sparse: an
  unlabeled surfaced memory counts as a false positive for this metric until the
  suite labels it as expected.

Retrieval mode is deterministic, so it executes one pass per task/scenario.
Repeated trials matter once a runner includes nondeterministic agent execution.

CI should assert the metrics that matter for each starter suite, not only the
boolean result count. The committed CI gate runs the starter suite with a
minimum memory-lift threshold, a maximum memory-harm threshold, and a committed
baseline drift check, then uploads the JSON artifact for inspection.

## Baselines

Baselines live under `evals/baselines/` as comparison-stable JSON snapshots
captured from a known-good run. The committed `evals/baselines/lore-core.json`
is the reference that CI diff-checks every PR against.

```bash
# Capture a fresh baseline (operator command -- review the diff before commit)
node dist/cli.js eval baseline evals/suites/lore-core.yaml \
  --out evals/baselines/lore-core.json \
  --notes "Why this baseline was refreshed"
```

The snapshot drops timing/order-sensitive fields (`startedAt`,
`metrics.elapsedMs`) and pins per-result `success`, `recall`, and `precision`
plus the aggregate retrieval summary.

Baselines record their `runner` mode. `lore eval run --baseline <path>` refuses
to compare a baseline captured in one mode against an artifact from another
(they key results on disjoint scenario spaces -- retrieval baselines on
ablations, notion baselines on `live-vault`). Capture a runner-matched baseline
with `lore eval baseline --runner <mode> ... <suite>` before comparing.

### Drift Detection

`lore eval run` accepts `--baseline <path>` to compare a fresh run against a
committed snapshot:

```bash
node dist/cli.js eval run evals/suites/lore-core.yaml \
  --baseline evals/baselines/lore-core.json
```

Regression triggers (any one flips the run to a non-zero exit):

- A previously-passing result now fails (per-task regression).
- `failedResults` increases vs. baseline.
- `memoryHarm` increases past the baseline value (no tolerance -- any new harm
  is a regression).

Aggregate metric drops on `averageRecall` / `averagePrecision` / `memoryLift`
are surfaced in the drift report for visibility, but do not themselves
auto-regress: any per-result drop already shows up as a new failure, and a
metric drop without a per-result regression usually means a previously-failing
result was tightened.

Per-result identity is keyed on `(taskId, scenario, surface)` -- a task that
exercises multiple surfaces under one scenario keeps each surface's row
distinct in the drift gate's `Map` lookups. A regression test pins this
contract so a future contributor cannot silently narrow the key back to the
legacy 2-key `(taskId, scenario)` form (which would clobber siblings under the
same `(taskId, scenario)` and silently drop coverage from the drift gate).

Byte-stable `lore eval baseline` output is **retrieval-mode only**. The
retrieval runner pins `DEFAULT_RETRIEVAL_NOW` so per-result rows and aggregate
metrics reproduce across runs. The notion runner uses real wall-clock time and
hits live Notion, so its baselines record real timestamps and may have
per-trial variance from hybrid-search noise -- the drift gate is a coarser
per-result success/recall comparator there, not a byte-equality check. A future
refactor that re-introduces `new Date()` into `runRetrievalSuite` will silently
re-introduce nondeterminism into retrieval-mode baselines; if you change the
clock seam, update this section and the snapshot in lockstep.

### When To Refresh The Baseline

Refresh the baseline (`lore eval baseline ... --out evals/baselines/<suite>.json`
followed by an explicit commit) when:

- A new task lands and adds rows the baseline didn't have. The drift report
  surfaces these under `New results (refresh baseline)`; the CI gate will not
  regress on them, but operators should refresh so the next PR's drift check has
  stable expectations.
- A scenario expectation tightened intentionally (e.g., temporal-correctness
  work landed and stale-memory `shouldNotSurface` lists were tightened to list
  stale ids).
- A retrieval improvement raised lift / lowered harm and the new metrics should
  become the floor.

Refreshing the baseline as a side effect of a PR that introduces a regression
defeats the purpose of the gate -- review the diff before committing.

The JSON artifact is the comparison contract. Human CLI output is only a
summary. `startedAt` is operational metadata; compare `results` and `summary`
when checking deterministic regressions.

## Task-Eval Suites

Task-eval suites live under `evals/task-suites/` and use a different YAML
schema from retrieval suites -- the unit of measurement is a task, not a
retrieval surface. Each task names:

- A `prompt` for the agent
- A `workspace` fixture path (relative to the suite); the runner copies it to a
  tmp directory before the run so workspaces stay read-only on disk
- An `agent` -- only `codex` is registered as a production agent today; tests
  inject mock adapters under arbitrary string ids via `RunTaskEvalOptions.adapters`
- An optional `memoryConditions` matrix mapping condition (`no-lore` /
  `helpful` / `noisy` / `stale`) to a fixture path; the runner runs the task
  once per declared condition and seeds `.lore-memories.json` into the workspace
  from the fixture
- A list of `verifiers` that score the post-run workspace state

```yaml
version: 1
name: lore-task-starter
tasks:
  - id: add-readme-mentioning-package
    prompt: Add a README that explains the greet function.
    agent: codex
    workspace: ../workspaces/add-readme
    memoryConditions:
      no-lore: ../task-memory/no-lore.json
      helpful: ../task-memory/helpful-add-readme.json
      noisy: ../task-memory/noisy-add-readme.json
      stale: ../task-memory/stale-add-readme.json
    verifiers:
      - type: file-exists
        path: README.md
      - type: file-contents-match
        path: README.md
        pattern: greet
      - type: file-contents-match
        path: index.js
        pattern: throw new Error
        mode: forbid
      - type: file-unchanged
        path: package.json
```

Three verifier types ship today:

- `file-exists` -- passes if the path exists in the post-run workspace.
- `file-contents-match` -- reads the file, applies the regex pattern. Mode
  `match` (default) passes when the pattern hits; mode `forbid` passes when the
  pattern does NOT hit. Patterns are validated as JavaScript regexes at schema
  parse time.
- `file-unchanged` -- sha256-compares the workspace file to the source fixture;
  passes when they're byte-identical. Use this to pin "the agent must not
  modify this file" contracts the prompt declares.

Run with `lore eval run --runner task evals/task-suites/starter.yaml`. The
runner copies the workspace, optionally seeds the memory-condition fixture,
shells out to `codex exec --json --output-last-message <sidecar> --cd
<workspace> --sandbox workspace-write --skip-git-repo-check <prompt>`, writes
the JSONL event stream to a transcript sidecar, then runs the verifiers against
the result.

### Longitudinal Task Suites

Longitudinal task suites are a phase-aware variant of `--runner task`:

```yaml
version: 1
runner: task
longitudinal: true
name: lore-longitudinal-minimal
conditions: [no-memory, lore-full-loop]
scenarios:
  - id: decision-continuity-result-boundary
    workspace: ../longitudinal/workspaces/result-boundary
    phaseA:
      prompt: Add `createUserProfile(input)` and capture the service-boundary decision.
    phaseB:
      prompt: Add `fetchUserProfile(userId)` consistently with the previous decision.
    expectedContext:
      keywords: ["Result", "ok", "err"]
    verifiers:
      - type: command
        command: npm
        args: ["test"]
```

The committed MVP suite lives at `evals/task-suites/longitudinal.yaml` and
contains four smoke scenarios:

- `decision-continuity-result-boundary`
- `failed-attempt-avoidance-esm-imports`
- `follow-up-task-json-output`
- `convention-continuity-cache-prefix`

Each scenario runs Phase A and Phase B in the same copied workspace, but each
phase is a fresh agent process. Under `no-memory`, the runner does not write
`.lore.yaml`, does not seed memory, does not run hook formation, and injects no
wake-up context. Under `lore-full-loop`, the runner mines the Phase A
conversation through `runConversationMining` using the evaluated agent's
background CLI shape (Codex scenarios mine with `codex exec`, not `claude -p`),
then calls `loadWakeUpData({ projectId, userQuery: phaseBPrompt,
includeMemoryContent: true })` before Phase B and injects the rendered wake-up
bundle into the Phase B prompt.

Longitudinal suites may also include `seeded-lore`. This condition runs Phase A
without hook mining, then injects the scenario's source-controlled
`seededContext` before Phase B. It is a pilot seam for known-corpus evals: it
measures whether the agent can use known memory when it is available, while
`lore-full-loop` measures the full formation + retrieval + use path. When a
suite includes `seeded-lore`, every scenario must declare `seededContext` with
rendered context and stable context ids. Every listed `contextIds` or
`harmfulContextIds` entry must appear in `renderedContext`; otherwise the suite
would report context as surfaced even though the agent never saw it.

Design `lore-full-loop` Phase A prompts around durable learnings that Lore is
expected to preserve: decisions, conventions, gotchas, failed attempts,
workarounds, and explicit follow-up cues. Do not make `expectedContext.keywords`
depend on arbitrary source-code facts or Phase B-only feature details unless
Phase A explicitly asks the agent to capture that forward-looking detail.
Expected-context matching is diagnostic: the artifact records which expected
context ids were created and surfaced, but missing expected context does not
fail the trial by itself. Use the Phase B verifiers for performance judgments.

Suites can point at a source-controlled seed corpus:

```yaml
seededCorpus: ../vault-seeds/github-cli-pilot.yaml
```

Seed corpora model the realistic vault that should eventually be imported for
the non-control condition. For the GitHub CLI pilot, that means one `GitHub CLI`
project with component-level topics (`commands/config`, `commands/alias`,
`output/json`, `flags/cobra`, `tests/commands`) plus memories, decisions, and
facts. Do not invent monorepo subprojects for repositories that are not
monorepos.

Seed memories and decisions may include provenance metadata. Use
`provenanceKind: pr-derived` only when the entry cites one or more
`sourcePullRequests`; use `generalized` for project conventions that are not
directly derived from a specific PR, and `synthetic` only for intentionally
invented fixture data. When `seededCorpus` is set, suite loading validates that
the corpus file parses and that every seeded context id is present in the
corpus.

Longitudinal suites may set `costKillSwitchUsd` as an overnight-run guard:

```yaml
costKillSwitchUsd: 1500
```

The serial runner checks observed priced cost between condition runs. Observed cost
includes primary agent usage recorded on phase rows and, when the live
longitudinal config root exposes enabled cost tracking, Lore-owned model cost
from the local cost ledger for the current run window. Because the ledger slice
is time-window based, use a dedicated eval config root/ledger for overnight
runs. Once observed cost reaches the threshold, the runner stops launching new
work, records a `termination` block with the observed total, and
leaves the JSON artifact containing every completed result. If primary-agent
usage is missing or the model is unpriced, the guard stops fail-closed with
`termination.reason: "cost-unknown"`. Artifact checkpoints are written through
a temp-file rename after every condition run in serial mode and after every
scenario shard in parallel mode.

With `--parallel`, the runner launches whole scenario triples in child
processes so each scenario's Phase A/Phase B and Lore-full-loop context remain
coherent. The parent checks the cost guard before launching a shard and after a
shard completes; it does not interrupt a shard before its subprocess emits
usage. The final observed cost can therefore exceed the threshold by up to the
priced work of the scenario shards already in flight, bounded by `--parallel`.
If a shard fails structurally, the parent kills active shard process groups and
keeps the latest parent and shard artifacts for restart analysis.

Workspaces can be local fixture directories or pinned GitHub repositories. The
existing string form is unchanged:

```yaml
workspace: ../longitudinal/workspaces/result-boundary
```

Pinned git workspaces use this shape:

```yaml
workspace:
  kind: git
  repo: cli/cli
  sha: 9a593ce81b593dee752cc11737d1a3ef768e52b3
  sparseCheckout:
    - pkg/cmd/config/**
    - go.mod
    - go.sum
```

The runner fetches the full commit SHA before invoking the agent, caches the
checkout outside the repo under `$LORE_EVAL_WORKSPACE_CACHE_DIR` or
`$XDG_CACHE_HOME/lore/eval-workspaces`, then copies that cache into each
trial's temporary workspace. The agent never clones from its prompt, and
existing local fixture path guards still apply to string workspaces. `repo` is
restricted to GitHub `owner/repo` form for v1. Tests may override the remote
base with `LORE_EVAL_GIT_REMOTE_BASE_URL`.

The JSON artifact records each condition run with `phases[]`, prompt ids,
workspace source, verifier results, patch stats, elapsed time, Lore counts,
expected context ids, surfaced context ids, harmful context ids, and cost fields
when the adapter reports them. Phase-level `cost` is primary-agent spend from
the evaluated Codex process only: it includes provider, model, prompt tokens,
cached prompt tokens, output tokens, reasoning output tokens, and `totalUsd`
when the model is known to the local pricing table. Lore-owned background work
is intentionally separate and belongs in the opt-in cost ledger. The summary
reports pass rate per condition and a
primary memory-enabled success-rate delta against `no-memory` (`seeded-lore`
when present, otherwise `lore-full-loop`), plus per-condition lift summaries and
the scenario ids where Lore lifted or harmed the outcome. Positive lift is
useful evidence, but it is not a validity gate: a no-lift or harmful result
means the harness found outcome data to inspect, not that the harness failed.
The CLI exits non-zero when the primary memory-enabled condition has failing
trials; `no-memory` baseline failures alone remain lift data.

`timeoutMs` on a longitudinal scenario is a per-agent-phase timeout, not a
whole-scenario timeout. The runner applies it separately to Phase A and Phase B.
Command verifiers have their own `timeoutMs`. For example, the GitHub CLI suites
use a 30-minute agent timeout per phase and 5-minute Go-test verifier timeouts,
so one condition trial can reasonably take about 60 minutes plus verifier and
Lore overhead.

Timeouts are wall-clock timers in the runner process. Laptop sleep can therefore
produce artificial timeouts: timers do not make progress while the machine is
asleep, but can fire immediately on wake if the deadline passed. Use an
always-on runner or a sleep inhibitor such as `caffeinate` on macOS for any
runtime or cost measurement intended to be compared across conditions.

Run the dry path with mock adapters in unit tests:

```bash
npm run test -- src/eval/task-runner.test.ts
```

Run the committed suite with real agents only when you intentionally opt into
model spend:

```bash
npm run build
LORE_EVAL_TASK_REAL=1 \
node dist/cli.js eval run --runner task evals/task-suites/longitudinal.yaml
```

Run the live `lore-full-loop` condition only against a sandbox/eval/test
project. The runner creates a per-run project, writes `.lore.yaml` only in a
temporary config root, writes temporary agent MCP config inside the copied
workspace, archives the per-run project in cleanup, and removes the temporary
config root:

```bash
npm run build
LORE_EVAL_TASK_REAL=1 \
LORE_EVAL_LONGITUDINAL_REAL=1 \
LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT="Eval Sandbox" \
node dist/cli.js eval run --runner task evals/task-suites/longitudinal.yaml
```

If the source checkout does not have a usable `.lore.yaml`, point
`LORE_EVAL_LONGITUDINAL_CONFIG_ROOT` at a sandbox-vault config root. Sandbox
names must contain a word-bounded `sandbox`, `eval`, `test`, `scratch`,
`staging`, `dev`, or `playground` marker unless
`LORE_EVAL_NOTION_ALLOW_PRODUCTION=1` is set.

### Production Safety Gates

- **Cost guardrail.** Real Codex invocation requires `LORE_EVAL_TASK_REAL=1` in
  the environment. Without it, `CodexAgentAdapter.run` exits with a
  recognizable refusal stderr line and a non-zero exit code. The CLI failure
  summary surfaces the first stderr line so the operator sees the refusal
  directly.
- **Env scrubbing.** The Codex child inherits an explicit allowlist env (`PATH`,
  `HOME`, `TMPDIR`, `TZ`, `LANG`, `LC_*`, `OPENAI_API_KEY`, plus `CODEX_*`).
  Secrets like `NOTION_API_TOKEN` and `GITHUB_TOKEN` are stripped -- both from
  the child env and from any echo into the captured stdout/stderr.
- **Process-tree teardown.** The Codex child runs in a detached process group;
  timeout cancellation kills `-pid` so subprocesses Codex spawned (test
  watchers, dev servers, package installs) terminate too. POSIX-only -- Windows
  would need a `taskkill /T` reimplementation.
- **Capture cap.** stdout / stderr each cap at 1 MiB; truncation is marked in
  the captured text so the operator knows.
- **Transcript sidecars.** Task-mode runs write full Codex JSONL event streams
  under a sibling `<artifact-stem>-transcripts/` directory by default. The
  result row stores the sidecar path, while `agentRun.stdout` remains the final
  assistant message from `--output-last-message`.
- **Cost split.** Longitudinal task-mode artifacts count primary Phase A/Phase B
  Codex calls as agent cost. `lore-full-loop` post-session mining uses the
  evaluated agent's background CLI shape and, when cost tracking is enabled in
  the sandbox config root, writes `eval.mining.background_model` rows to the
  Lore cost ledger. MCP tools and Notion operations from the mining child write
  `mcp.invocation` rows to the same ledger.
- **Workspace cleanup.** Tmp workspaces are removed via `try/finally` after each
  trial. Pass `keepWorkspaces: true` programmatically (or `--keep-workspaces`
  once exposed on the CLI) for debugging.

Adapter contract: `AgentAdapter` is a 2-member interface (`id`, `run`) that lets
tests inject a mock without shelling out to a real model. Production callers get
the `CodexAgentAdapter`; tests pass a custom adapter via
`RunTaskEvalOptions.adapters`.

The committed `evals/task-suites/starter.yaml` ships **five tasks** across the
same scenario types as the retrieval suite, each exercised against the full
memory-condition matrix (5 tasks x 4 conditions = 20 trials). The artifact's
`summary.totalTrials` reflects the matrix; per-result `failureReason`
discriminates between adapter refusal, timeout, spawn error, agent exit, and
verifier failure.

`--baseline`, `--min-lift`, `--max-harm`, and `--project` are not supported with
`--runner task` (task-mode artifacts are scored by verifiers, not retrieval
metrics). The CLI parser rejects the combination so a CI job that wires one of
those into a task-mode gate fails loudly instead of silently never gating.
