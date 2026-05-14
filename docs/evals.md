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

## LongMemEval bench: temporal-fidelity caveat

The LongMemEval bench published number on the `temporal-reasoning`
and `knowledge-update` categories is **not apples-to-apples** with
agent-memory systems that rank by session event time. Two facts about
Lore's schema explain why, and the caveat must travel with every
published number on those two categories.

Lore's Memories schema has no caller-writable session-timestamp
column. `Memory.createdAt` maps to Notion's `page.created_time`
(server-set, not caller-settable); `Last Referenced At` is the
read-decay anchor; `Decided At` and `Done At` are domain-specific to
the decision and task surfaces; `Session` is `rich_text` carrying a
session id, not a date. Lore's retrieval ranks by ingestion-time
recency, not by event time embedded in the conversation.

Consequence on those two categories: a LongMemEval score measures
**whether the agent recovers temporal context from the memory body's
free text**, not whether Lore's retrieval ranks by event time. The
agent can still answer correctly when the body's prose carries the
session timestamp explicitly — the bench is therefore a measurement
of an agent capability composed with Lore's ingestion shape, not a
direct comparison to systems that rank by event time. The comparison
to Zep's `longmemeval_s` numbers on these two categories is not
apples-to-apples on the temporal axis.

The bench artifact's `summary.temporalFidelityCaveat` field carries
this disclaimer verbatim so downstream consumers (CI logs,
dashboards, public posts) cannot strip it from headline output.
Adding a writable session-time column to the Memories schema would
let retrieval rank by event time and convert this caveat into an
honest apples-to-apples comparison; until then, the caveat applies.

## Runner modes

Four runners ship today; the first two share the same suite YAML format and
surface registry, the last two each have their own format because they score
agent-produced workspace state or LongMemEval-style multi-session recall
rather than retrieved memory ids:

| Runner | What it exercises | Where to use it |
| --- | --- | --- |
| `retrieval` (default) | Fixture-backed `loadWakeUpData` with deterministic token-overlap search. No Notion calls. | Per-PR CI; the inner-loop fast feedback. |
| `notion` | Real `loadWakeUpData` against `LoreServices` initialized from `.lore.yaml`. Hits Notion. | Nightly CI; PRs that touch retrieval composition or ranking. |
| `task` | End-to-end agent run against a synthetic workspace, scored by deterministic verifiers. Shells out to `codex exec`. | Nightly CI; opt-in PRs. Slow + model-cost; not the per-PR hot path. |
| `bench` | End-to-end LongMemEval bench: per-example ingest + recall through Lore MCP + judge. Hits Notion + OpenAI. | Operator-dispatched only (workflow_dispatch). The most expensive runner; produces a number we can publish alongside Zep / MemGPT / Mem0. |

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

The boundary is a regex `\b` word boundary, so `Widget-staging`, `Eval-Project`,
and `dev-vault` all pass, but **camel-case names without a separator**
(`EvalProject`, `TestVault`) reject — the regex sees those as embedded
substrings rather than standalone markers. If your sandbox uses a
camel-case convention, either add a separator (`Eval-Project`) or set the
env var to opt in.

### Evaluation vault registry

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
`LORE_EVAL_LONGITUDINAL_CONFIG_ROOT` at the generated config root, exporting
the vault selector env, and opting into the live task runner:

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

## Hook-Native Longitudinal Task Evals: Phase 0 Decision

This section records the Phase 0 recommendation for hook-native longitudinal
software-agent evals. It is a feasibility and fidelity decision, not a product
claim: positive lift, no lift, or harm are Phase 1+ findings.

## Existing Lore Eval Inventory

Lore already has four eval surfaces. The retrieval and notion runners measure
which memory rows surface; the task runner measures whether an agent changes a
workspace correctly; the bench runner measures LongMemEval-style ingest and
recall. The hook-native longitudinal claim needs the task runner's workspace
and verifier model, plus the hook and wake-up seams already proven in the bench
runner.

| Existing surface | Current fit | Limits for this decision |
| --- | --- | --- |
| `retrieval` runner (`src/eval/runner.ts`, `src/eval/schema.ts`, `evals/suites/lore-core.yaml`) | Deterministic fixture-backed `loadWakeUpData`; fast precision/recall over surfaced memory IDs. | Measures retrieval quality only. It does not run a coding agent or form memory from a prior session. |
| `notion` runner (`src/eval/runner.ts`) | Same suite shape against real `LoreServices` scoped to a sandbox project. Useful for retrieval-stack drift. | Read-only live-vault state. No isolated seed/cleanup, no phase boundary, no agent workspace. |
| `task` runner (`src/eval/task-runner.ts`, `evals/task-suites/starter.yaml`) | Copies synthetic workspaces, runs `codex exec`, and scores deterministic verifiers. | Current memory matrix seeds `.lore-memories.json`; it does not exercise Stop-hook-shaped formation or wake-up injection. |
| `bench` runner (`src/eval/bench-runner.ts`, `src/eval/bench-ingest.ts`, `evals/bench-suites/*.yaml`) | Replays LongMemEval haystacks through `runConversationMining`, raw transcripts, or simulated autosave; supports `wake-up-prefetch`. | LongMemEval is conversation-memory QA, not multi-session software work. Tool-driven retrieval remains unavailable under `codex exec`; runnable paths use `wake-up-prefetch`. |

## Candidate Benchmark Review

The recommendation below uses external benchmarks as design input, not as the
Phase 1 runner source. Public availability was checked on 2026-05-13.

| Candidate | Adopt / adapt / reject | Reproducibility status | Public data/code | License | Software-agent fit | Hook compatibility | Scoring/verifier model | Cost | Implementation risk | Rationale |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| LongMemEval / LoCoMo / current memory leaderboards | Reject as the Phase 1 source; keep as retrieval/chat-memory context. | Data and runners are available for LongMemEval and memory-benchmark suites; some runs require OpenAI judges or memory-service backends. Lore already has pinned LongMemEval bench corpus support. | Yes: LongMemEval repo/dataset and memory-benchmark runners are public. | LongMemEval code MIT; `mem0ai/memory-benchmarks` Apache-2.0; dataset licenses vary by corpus. | Weak. They are mostly chat-history QA and retrieval recall, not repo work across sessions. | Partial. Lore's bench runner already covers `runConversationMining` and `wake-up-prefetch`, but not software-task outcomes. | QA correctness, retrieval recall, or judge labels. | Medium to high when judge/model calls are included. | Low for continuing current bench work; high if used for the software-work claim. | They are useful calibration surfaces, but they cannot answer whether hook-captured software context changes later coding behavior. |
| LongMemEval-V2 | Adapt ideas only. | Data is available as a 7.12 GB Hugging Face dataset with JSONL trajectories, screenshots, schema, and checksums. A public runner/code release was not found during Phase 0. | Data yes; runner/code not verified. | Dataset Apache-2.0. | Medium. It targets environment-specific agent experience, workflows, gotchas, and premise awareness, but in web/enterprise environments rather than code repos. | Partial. Trajectories resemble Phase A experience, but the task is evidence gathering for QA rather than hook-written memory used in a later software task. | Context-gathering evidence followed by QA accuracy. | High: large trajectory/screenshot payloads and coding-agent evidence gathering. | High for direct adoption; medium as scenario inspiration. | It best matches "experienced colleague" memory, but adopting it would require a new web-agent trajectory adapter before Lore can test hook-native software work. |
| Mem2ActBench | Adapt the action-grounding idea. | Paper advertises an anonymous 4open code/data repo; direct fetch was Cloudflare-blocked during Phase 0, so local reproduction was not verified. | Advertised yes; not locally verified. | Unknown from accessible surfaces. | Medium. It tests memory-driven tool choice and parameter grounding, which is closer to "memory changes action" than QA. It is not repo patching. | Partial. Histories can inform formation prompts, but the benchmark's final action is an offline tool call, not a fresh coding session with workspace verifiers. | Tool-call selection and parameter F1. | Medium. | Medium to high because the public artifact path is anonymous and the task format needs conversion. | Good conceptual pressure: Phase 1 verifiers should check behavior, not only surfaced memories. Direct adoption would spend effort adapting tool-call data instead of exercising Lore's hooks. |
| MemoryArena | Adapt scenario structure later; reject for Phase 1 source. | Hugging Face dataset is public with bundled shopping, progressive search, group travel, and formal reasoning configs. A directly reusable software-runner path was not verified. | Dataset yes; reusable runner/code unclear. | Dataset CC-BY-4.0. | Medium. It is explicitly multi-session and interdependent, but its environments are web shopping, travel planning, search, and formal reasoning. | Conceptually strong but mechanically heavy: would need environment adapters and hook transcript synthesis before it tests Lore. | Ground-truth answers, task success, and progress-style scores. | Medium to high. | High for the MVP. | The Memory-Agent-Environment loop is the right mental model, but the Phase 1 MVP should first prove the harness on small repo fixtures. |
| MemoryAgentBench | Reject as runner source; adapt taxonomy. | Hugging Face dataset and GitHub code are public. Reproduction requires model/API setup for several baselines. | Data yes; code yes. | Dataset MIT; GitHub repo license not detected via GitHub API. | Weak to medium. It covers memory competencies, not software-agent workspace outcomes. | Low. Incremental chunks can be replayed, but they bypass Lore's hook-shaped transcript and wake-up workflow. | QA / classification / summarization accuracy, with LLM-based metrics for some tasks. | Medium to high. | Medium. | Its competency taxonomy is useful for naming future scenarios, especially conflict resolution, but it would not validate hook-native software work. |
| SWE-bench / SWE-bench Mobile / coding-agent benchmarks | Adapt fixture and verifier discipline; reject direct adoption. | SWE-bench has public code/data and Docker evaluation. SWE-bench Mobile is a hosted challenge; task details remain private and the repo is still being prepared for public release. | SWE-bench yes; SWE-bench Mobile public leaderboard/toolkit but private tasks. | SWE-bench MIT; SWE-bench Mobile license not verified. | High for repo patching, low for memory because tasks are independent issue fixes. | Low without manual scenario chaining. Existing issues do not naturally include a prior-session memory formation phase. | Test suites and patch correctness. | High compute/storage for full SWE-bench; hosted for Mobile. | Medium. | This is the right source of verifier instincts, but Phase 1 should use tiny committed fixtures where the memory dependency is deliberate and auditable. |
| AgentBench-style agent setup benchmarks | Adapt measurement posture; reject direct adoption. | `agentbench/agentbench` is public as a Claude Code/OpenClaw plugin; THUDM AgentBench is public for multi-environment LLM-as-agent evaluation. | Yes. | `agentbench/agentbench` MIT; THUDM AgentBench Apache-2.0. | Medium for tool workflow and tracing, weak for Lore-specific memory. | Low. They benchmark an agent setup, not Lore's Stop/wake-up loop. | Rule-based tasks and traces for the plugin; environment task success for THUDM AgentBench. | Low to medium. | Low as inspiration, high as a direct runner dependency. | Keep the rule-based scoring, trace, and cost fields; do not import an unrelated plugin runner into Lore's eval stack. |

## Recommendation

Extend the existing `task` runner with a phase-aware longitudinal suite shape.
Do not add a new top-level runner unless implementation proves the schema
cannot remain inside task mode.

The `task` runner already owns the right primitives: temporary workspace copy,
agent adapter dispatch, scrubbed env, timeout/process cleanup, deterministic
workspace verifiers, and JSON artifacts. Phase 1 should add a longitudinal
task-suite variant under that runner with two phases per scenario and two
conditions:

- `no-memory`: run Phase A and Phase B across a fresh process/session boundary,
  but with Lore disabled: no `.lore.yaml`, no seeded memory file, no hook
  formation, no wake-up/context injection, and no Notion token in the agent env.
- `lore-full-loop`: run the same Phase A workspace work, then form memory
  through `runConversationMining`, start Phase B in a fresh process, prefetch
  wake-up context with `loadWakeUpData`, and inject only that rendered context
  plus the Phase B prompt.

The runner should report lift/harm as observed outcome deltas, but acceptance
must stay about reproducibility and interpretability. Positive lift is not a
Phase 1 pass/fail gate.

## Rejected Alternatives

- Add a new `longitudinal-task` runner: rejected for Phase 1 because it would
  duplicate the existing task runner's workspace, adapter, verifier, timeout,
  and artifact machinery before the suite shape proves it needs independence.
- Adapt an external benchmark runner/dataset directly: rejected because none of
  the reviewed public benchmarks simultaneously provide software-repo work,
  hook-shaped memory formation, fresh-session memory use, and deterministic
  local verifiers.
- Extend `bench` beyond LongMemEval: rejected because bench mode is built
  around per-example Notion projects, corpus ingest, QA answering, judge cost,
  and LongMemEval artifact caveats. The software-work claim needs patch
  verifiers, not another memory-QA corpus.
- Use `lore hooks autosave` itself as the Phase A formation path: rejected for
  the harness because the production hook is intentionally fire-and-forget.
  The runner needs an awaitable completion boundary and structured failure
  signal.
- Seed Lore rows through direct service calls for `lore-full-loop`: rejected
  because it bypasses the autosave prompt, background-agent env partition, MCP
  write surface, source-link rules, and review/dedup behavior that Phase 1 is
  supposed to exercise.
- Use MCP tool-driven retrieval inside `codex exec`: rejected until the
  headless adapter supports MCP tools. Phase 1 must use runner-side wake-up
  prefetch instead.

## Phase A Path

Phase A is the memory-formation phase.

1. Copy the scenario fixture workspace into a temp directory.
2. Run the Phase A prompt through the existing task agent adapter. The adapter
   should capture enough conversation material to reconstruct the user prompt
   and final agent response, then normalize that capture through the transcript
   helpers into the same human-readable `User:` / `Assistant:` session content
   the hook path mines. The resulting workspace state is the input to Phase B.
3. For `no-memory`, stop there. Do not write `.lore.yaml`, do not run autosave,
   and do not seed `.lore-memories.json`.
4. For `lore-full-loop`, run `runConversationMining(transcript, ...)` from
   `src/hooks/conversation-mining.ts` against an isolated sandbox project. This
   is the selected hook-native formation path: it shares the autosave prompt
   builder, background-agent config, tool allowlist, auth-source env partition,
   MCP write surface, learning-extraction knobs, and write-budget signal, while
   giving the eval runner an awaitable boundary.
5. Capture formation counts and IDs after mining completes: memories, facts,
   decisions, tasks, write-budget status, elapsed time, and any stderr sink path
   when kept for debugging.

The Phase A artifact must record `condition`, `phase: "formation"`,
`promptId`, `workspace`, hook settings, created memory/fact/decision/task
counts, verifier results, elapsed time, cost fields when available, and patch
stats.

## Phase B Path

Phase B is the memory-use phase.

1. Start a fresh agent process/session against the post-Phase-A workspace.
2. For `no-memory`, pass only the Phase B prompt. Lore remains disabled, and
   the agent receives no context file or preloaded memory.
3. For `lore-full-loop`, call `loadWakeUpData({ projectId, userQuery:
   phaseBPrompt, includeMemoryContent: true })` before spawning the Phase B
   agent. Render the relevant wake-up bundle into the prompt as retrieved
   context. This is the selected Phase B path: runner-side
   `loadWakeUpData` / wake-up-prefetch, not MCP tool-driven retrieval inside
   `codex exec`.
4. Run deterministic workspace verifiers after the Phase B agent exits. Verifier
   failures are outcome data. Harness failures are only infrastructure failures:
   setup errors, mining crashes, wake-up load failures, timeout/spawn failures,
   malformed artifacts, or cleanup failures.

The Phase B artifact must record `condition`, `phase: "use"`, `promptId`,
`workspace`, wake-up settings, expected context IDs, surfaced context IDs,
harmful context IDs, verifier results, elapsed time, cost fields when
available, and patch stats.

## Storage Strategy

Use a hybrid storage strategy:

- Unit tests and parser/schema tests should use fake services or in-memory
  adapters. They should verify suite loading, condition expansion, artifact
  shape, verifier behavior, cleanup, and the no-memory path without Notion.
- The real `lore-full-loop` dry run requires a live Notion sandbox. Create a
  per-run sub-project under an operator-provided sandbox/eval/test project,
  named with the scenario id and a run ULID. Write `.lore.yaml` only in the
  temp config root or temp workspace, never in the source fixture. Archive the
  sub-project in `finally`, then remove temp config roots and workspaces.
- The live sandbox path must be explicitly gated, mirroring the existing task
  and bench guardrails. Use a new opt-in such as `LORE_EVAL_LONGITUDINAL_REAL=1`
  plus a sandbox project name. Non-sandbox project names should require the same
  explicit production override posture as notion-mode evals.
- Direct row seeding is allowed only for fake-service unit tests. It is not the
  `lore-full-loop` condition.

Runs stay deterministic enough for engineering validation by using committed
fixtures, stable prompts, deterministic verifiers, and explicit artifacts. The
agent may still be stochastic; the harness should summarize success by
condition and report lift/harm deltas without requiring positive lift as an
acceptance criterion.

## Phase 1 Changes To #608

#608's three MVP scenarios are confirmed. The issue should be updated to mark
the selected runner path as "extend `task` runner", the Phase A formation path
as `runConversationMining`, the Phase B memory-use path as
`loadWakeUpData` / wake-up-prefetch, and the storage path as hybrid fake tests
plus a live sandbox smoke run. Keep exactly these three scenarios for Phase 1:

| Scenario | Fixture path | Phase A prompt | Phase B prompt | Expected memory dependency | Verifier | Artifact assertions |
| --- | --- | --- | --- | --- | --- | --- |
| `decision-continuity-result-boundary` | `evals/longitudinal/workspaces/result-boundary/` | Add `createUserProfile(input)`, decide whether service-boundary functions return Result objects or throw exceptions, implement the chosen pattern, and capture the decision. | Add `fetchUserProfile(userId)` while staying consistent with the previous service-boundary decision. | A surfaced decision/memory that service-boundary functions return `Result` values with `ok` / `err` helpers rather than throwing. | `fetchUserProfile` is exported; it returns `ok(...)` or `err(...)`; `throw new Error` is forbidden in service-boundary functions; fixture tests pass. | Phase A records at least one memory or decision; Phase B surfaces the expected context under `lore-full-loop`; verifier results and patch stats are present for both conditions. |
| `failed-attempt-avoidance-esm-imports` | `evals/longitudinal/workspaces/esm-cli/` | Investigate and fix the failing CLI import test for `commands/status.ts`; capture any repo-specific import gotcha. | Add `commands/sync.ts` and wire it into the CLI using the learned import convention. | A surfaced memory that TypeScript source in the ESM fixture must use `.js` on internal relative imports. | `commands/sync.ts` imports siblings with `.js` extensions; extensionless relative imports from `./` or `../` are forbidden; fixture tests pass. | Phase A records the import gotcha; Phase B surfaces it in `lore-full-loop`; no-memory failures are captured as lift/harm data, not harness failures. |
| `follow-up-task-json-output` | `evals/longitudinal/workspaces/follow-up-task/` | Implement basic text output for `status`; create a follow-up task to add `--json` output for automation consumers. | Pick up the unresolved follow-up from the previous session and implement it. | An active Lore task or surfaced memory identifying the unresolved `status --json` follow-up. | `status --json` emits parseable JSON with expected keys; default text output remains unchanged; fixture tests pass. | Phase A records `tasksCreated >= 1`; Phase B surfaces the expected task or task-derived memory; artifact records task completion/closure when observable. |

## Task-eval suites (end-to-end)

Task-eval suites live under `evals/task-suites/` and use a different YAML
schema from retrieval suites — the unit of measurement is a task, not a
retrieval surface. Each task names:

- A `prompt` for the agent
- A `workspace` fixture path (relative to the suite); the runner copies it to
  a tmp directory before the run so workspaces stay read-only on disk
- An `agent` — only `codex` is registered as a production agent today; tests
  inject mock adapters under arbitrary string ids via `RunTaskEvalOptions.adapters`
- An optional `memoryConditions` matrix mapping condition (`no-lore` /
  `helpful` / `noisy` / `stale`) to a fixture path; the runner runs the
  task once per declared condition and seeds `.lore-memories.json` into
  the workspace from the fixture
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

- `file-exists` — passes if the path exists in the post-run workspace.
- `file-contents-match` — reads the file, applies the regex pattern. Mode
  `match` (default) passes when the pattern hits; mode `forbid` passes when
  the pattern does NOT hit. Patterns are validated as JavaScript regexes at
  schema parse time.
- `file-unchanged` — sha256-compares the workspace file to the source
  fixture; passes when they're byte-identical. Use this to pin "the agent
  must not modify this file" contracts the prompt declares.

Run with `lore eval run --runner task evals/task-suites/starter.yaml`. The
runner copies the workspace, optionally seeds the memory-condition fixture,
shells out to `codex exec --cd <workspace> --sandbox workspace-write
--skip-git-repo-check <prompt>`, then runs the verifiers against the
result.

### Longitudinal task suites

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

The committed MVP suite lives at
`evals/task-suites/longitudinal.yaml` and contains four smoke scenarios:

- `decision-continuity-result-boundary`
- `failed-attempt-avoidance-esm-imports`
- `follow-up-task-json-output`
- `convention-continuity-cache-prefix`

Each scenario runs Phase A and Phase B in the same copied workspace, but each
phase is a fresh agent process. Under `no-memory`, the runner does not write
`.lore.yaml`, does not seed memory, does not run hook formation, and injects no
wake-up context. Under `lore-full-loop`, the runner mines the Phase A
conversation through `runConversationMining`, then calls `loadWakeUpData({
projectId, userQuery: phaseBPrompt, includeMemoryContent: true })` before Phase
B and injects the rendered wake-up bundle into the Phase B prompt.

The JSON artifact records each condition run with `phases[]`, prompt ids,
workspace source, verifier results, patch stats, elapsed time, Lore counts,
expected context ids, surfaced context ids, harmful context ids, and cost fields
when the adapter reports them. The summary reports pass rate per condition and a
`lore-full-loop - no-memory` success-rate delta, plus the scenario ids where
Lore lifted or harmed the outcome. Positive lift is useful evidence, but it is
not a validity gate: a no-lift or harmful result means the harness found
outcome data to inspect, not that the harness failed. The CLI exits non-zero
when `lore-full-loop` has failing trials; `no-memory` baseline failures alone
remain lift data.

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

### Production safety gates

- **Cost guardrail.** Real Codex invocation requires
  `LORE_EVAL_TASK_REAL=1` in the environment. Without it,
  `CodexAgentAdapter.run` exits with a recognizable refusal stderr line
  and a non-zero exit code. The CLI failure summary surfaces the first
  stderr line so the operator sees the refusal directly.
- **Env scrubbing.** The Codex child inherits an explicit allowlist
  env (`PATH`, `HOME`, `TMPDIR`, `TZ`, `LANG`, `LC_*`, `OPENAI_API_KEY`,
  plus `CODEX_*`). Secrets like `NOTION_API_TOKEN` and `GITHUB_TOKEN`
  are stripped — both from the child env and from
  any echo into the captured stdout/stderr.
- **Process-tree teardown.** The Codex child runs in a detached process
  group; timeout cancellation kills `-pid` so subprocesses Codex
  spawned (test watchers, dev servers, package installs) terminate
  too. POSIX-only — Windows would need a `taskkill /T` reimplementation.
- **Capture cap.** stdout / stderr each cap at 1 MiB; truncation is
  marked in the captured text so the operator knows.
- **Workspace cleanup.** Tmp workspaces are removed via `try/finally`
  after each trial. Pass `keepWorkspaces: true` programmatically (or
  `--keep-workspaces` once exposed on the CLI) for debugging.

Adapter contract: `AgentAdapter` is a 2-member interface (`id`, `run`)
that lets tests inject a mock without shelling out to a real model.
Production callers get the `CodexAgentAdapter`; tests pass a custom
adapter via `RunTaskEvalOptions.adapters`.

The committed `evals/task-suites/starter.yaml` ships **five tasks** across
the same scenario types as the retrieval suite, each exercised against
the full memory-condition matrix (5 tasks × 4 conditions = 20 trials).
The artifact's `summary.totalTrials` reflects the matrix; per-result
`failureReason` discriminates between adapter refusal, timeout, spawn
error, agent exit, and verifier failure.

`--baseline`, `--min-lift`, `--max-harm`, and `--project` are not
supported with `--runner task` (task-mode artifacts are scored by
verifiers, not retrieval metrics). The CLI parser rejects the
combination so a CI job that wires one of those into a task-mode gate
fails loudly instead of silently never gating.

By default, result artifacts are written under `evals/results/`, which is
ignored by git. Use `--out <path>` to choose a deterministic artifact path for
CI or comparison runs.

```bash
node dist/cli.js eval run evals/suites/lore-core.yaml \
  --out evals/results/lore-core-latest.json \
  --json
```

## LongMemEval bench-runner

The `bench` runner targets the publicly comparable LongMemEval `s_cleaned`
corpus. Each example is a haystack of 30–40 multi-turn sessions plus one
target question; the runner replays the haystack through Lore's production
mining seam (`runConversationMining`), invokes a Codex-driven agent to
answer through `lore-context` / `lore-query` / `lore-memory`, and scores
the answer with a snapshot-pinned OpenAI judge.

### One-time setup

```bash
node dist/cli.js eval bench fetch longmemeval
```

Downloads the corpus from the HF revision pinned in
`evals/bench-corpora/longmemeval/checksums.json` and verifies sha256.
Re-running is idempotent (sha-matched file is left in place).

### Required env vars

| Variable | Purpose |
| --- | --- |
| `LORE_EVAL_BENCH_REAL=1` | Master gate — without it every bench-mode adapter refuses to spawn. |
| `LORE_BENCH_NOTION_TOKEN` | Per-run Notion token; the bench-runner writes it into the per-example workspace's `.codex/config.toml` (mode `0600`) so the spawned MCP child can authenticate. See "Secrets posture" below for the full risk model — use a revocable bench-scoped token, not your day-to-day `NOTION_API_TOKEN`. |
| `LORE_BENCH_OPENAI_API_KEY` | OpenAI key for both the agent (Codex shells out) and the judge. |
| `LORE_BENCH_CONFIG_ROOT` | Path to a `.lore.yaml` directory targeting the sandbox vault. |
| `LORE_BENCH_SANDBOX_PROJECT_NAME` | Parent sandbox project name; per-example sub-projects are created under it. |
| `LORE_EVAL_BENCH_MAX_USD` | Optional cost cap (default 75). The runner aborts between examples if the projected total exceeds it. |

### Running

```bash
node dist/cli.js eval run --runner bench \
  evals/bench-suites/longmemeval.yaml \
  --out evals/results/bench-$(date +%Y%m%d).json
```

Pass `--baseline evals/baselines/longmemeval-s-gpt4o-mini.json` to gate
drift; the first dispatched run lands in **bootstrap** mode (no baseline
file present) and a maintainer commits the captured baseline before
drift gating activates.

The bench workflow (`.github/workflows/eval-bench.yml`) is
**workflow_dispatch-only** for now — bench runs are operator-initiated,
not scheduled. Promotion to a recurring cadence is a follow-up once
the steady-state cost + drift gate are trusted.

### Ingestion strategies

Three strategies ship; the suite YAML's `ingestion.strategy`
chooses between them. All produce the same artifact shape; the
`config.ingestion.strategy` and `config.ingestion.seam` fields
record which path produced the numbers.

- **`lore-mine`** (V1 default, [`longmemeval.yaml`](../evals/bench-suites/longmemeval.yaml)) —
  each session is mined through the production Stop-hook autosave
  pipeline: `runConversationMining` spawns `claude -p`, which calls
  Lore MCP tools, which run the autosave's "durable knowledge"
  filter. Faithful to Lore's production write path. The autosave
  filter intentionally rejects casual conversational facts, so on
  LongMemEval's synthetic-conversation corpus mining produces ~1
  memory per ~30-session haystack and the agent recalls little. This
  number measures "Lore's production filter against the LongMemEval
  workload" — honest but not directly comparable to memory systems
  that ingest every token.
- **`raw-transcript`** ([`longmemeval-raw-transcript.yaml`](../evals/bench-suites/longmemeval-raw-transcript.yaml)) —
  each haystack session is stored verbatim as one memory (title
  `Session <i>: <session-id>`, body = the rendered transcript). The
  agent's `lore-query` / `lore-context` retrieves transcript memories
  by question relevance and reads the body via
  `lore-memory action='expand'`. Bypasses `runConversationMining`
  entirely — no `claude -p`, no autosave-prompt filter. Apples-to-apples
  with Zep's published Graphiti baseline on `longmemeval_s`.
- **`simulated-autosave`** ([`longmemeval-simulated-autosave.yaml`](../evals/bench-suites/longmemeval-simulated-autosave.yaml)) —
  each haystack session is sent through a deterministic structured
  extraction prompt, then written as Lore-shaped memory rows with
  title, synopsis, keywords, closed-vocabulary tags, body content, and
  explicit `mentions` facts for extracted entities. This bypasses the
  production autosave durability filter, so it is not a measurement of
  what Lore writes during normal Stop-hook autosave. It is the
  Zep-comparable enriched-ingestion surface: the full conversational
  signal is retained, but the vault shape is closer to production Lore
  recall than raw transcript dumps.

All strategies share the same per-example / per-suite write caps and
the same retrieval surface (the agent does not know which path
populated the vault). Publishing a number alongside a Zep-comparable
headline means picking `raw-transcript`; publishing a number that
reflects what Lore writes in production means picking `lore-mine`.
Use `simulated-autosave` when comparing against systems that enrich
conversation turns at ingest time, and report the production-filter
bypass trade-off with the result.

Manual comparison for `simulated-autosave`: run the simulated suite and
the same-sample wake-up suite with the same `--limit` and artifact
paths, then compare their `summary.overall.accuracy`,
`summary.overall.cost.totalEstimatedUsd`, and per-category stats:

```bash
node dist/cli.js eval run --runner bench \
  evals/bench-suites/longmemeval-simulated-autosave.yaml \
  --limit 10 \
  --out evals/results/longmemeval-simulated-autosave-limit10.json

node dist/cli.js eval run --runner bench \
  evals/bench-suites/longmemeval-wake-up.yaml \
  --limit 10 \
  --out evals/results/longmemeval-wake-up-limit10.json
```

If simulated-autosave does not outperform raw-transcript plus
wake-up-prefetch on the same sample, file a follow-up with both
artifact paths and the observed deltas; the implementation remains
valid as long as the artifact records the comparable fields.

### Profile suites

Profile suites are deterministic `lore eval run` suites for profile-owned
taxonomy quality. They run without Notion, model credentials, or live vault
access and emit profile artifacts with the active profile selector, profile
version, manifest digest, prompt hashes, per-case metrics, aggregate metrics,
and threshold failures.

The support pilot suite lives at
[`evals/profile-suites/support.yaml`](../evals/profile-suites/support.yaml):

```bash
node dist/cli.js eval run evals/profile-suites/support.yaml
```

The scorer reports:

- entity-kind recall: expected entities with the correct kind divided by
  expected entities
- predicate precision: correctly predicted writable fact triples divided by
  predicted writable fact triples
- hallucinated-fact rate: unsupported predicted fact triples divided by all
  predicted fact triples
- required-field completeness: populated required memory/entity/fact fields
  divided by required fields
- invalid-taxonomy rate: emitted tags, entity kinds, or predicates outside the
  active profile taxonomy divided by emitted taxonomy values

Model-backed profile extraction still uses the bench runner family. The support
pilot's operator-dispatched suite is
[`evals/bench-suites/support-simulated-autosave.yaml`](../evals/bench-suites/support-simulated-autosave.yaml).
Its artifact records the support profile metadata and prompt hashes in
`config.profile`, and the simulated-autosave schema is built from the support
tag vocabulary.

### Agent retrieval strategies

The bench supports two retrieval surfaces, selected via the suite
YAML's `agent.retrieval` field. Both produce the same artifact shape;
`config.agent.retrieval` records which surface produced the numbers.

- **`tool-driven`** (V1 default) — the agent has Lore MCP tools
  (`lore-query`, `lore-memory`, `lore-context`) registered and decides
  for itself when to call them. Maps to mid-session followup behavior
  in production Lore. **Currently structurally unavailable under
  `codex exec`** — Codex 0.128.0 does not load MCP servers in its
  non-interactive exec mode (`enable_mcp_apps` feature flag is "under
  development"). The agent sees no tools and falls through to shell-
  command attempts that all fail with `command not found`. Listed in
  the schema for completeness and to keep YAML loading stable when a
  future Codex release or a Claude Code headless adapter restores
  tool-driven retrieval.
- **`wake-up-prefetch`** ([`longmemeval-wake-up.yaml`](../evals/bench-suites/longmemeval-wake-up.yaml)) —
  the bench-runner calls `services.memories.search({query, projectId,
  includeContent: true, mode: "hybrid"})` BEFORE invoking the agent
  and injects the top-10 matching memory bodies into the user prompt
  as a "Retrieved context" block. The agent answers from the injected
  context — no MCP tool calls required, which sidesteps the
  MCP-in-exec gap. Mirrors how Lore's wake-up hook actually works at
  session start: the hook calls `lore-context action='wake-up'
  userQuery=<task>` via the agent's MCP integration and the response
  is pasted into the agent's context window. For a one-shot bench
  question the relevance-ranked taskMemories section is the
  load-bearing part — digest / recent / active-tasks sections of full
  wake-up are noise for a single question.

The two strategies compose with `ingestion.strategy` independently:

| `ingestion.strategy` | `agent.retrieval` | What it measures | Currently runnable |
|---|---|---|---|
| `lore-mine` | `tool-driven` | Production write path × agent tool-call propensity | ⚠️ Blocked on MCP-in-exec |
| `lore-mine` | `wake-up-prefetch` | Production write path × isolated retrieval surface | ✅ Yes |
| `raw-transcript` | `tool-driven` | Full corpus fidelity × agent tool-call propensity (Zep-comparable headline) | ⚠️ Blocked on MCP-in-exec |
| `raw-transcript` | `wake-up-prefetch` | Full corpus fidelity × isolated retrieval surface (V1 publishable headline) | ✅ Yes |
| `simulated-autosave` | `tool-driven` | Enriched ingest × agent tool-call propensity (Zep-style enrichment surface) | ⚠️ Blocked on MCP-in-exec |
| `simulated-autosave` | `wake-up-prefetch` | Enriched ingest × isolated retrieval surface | ✅ Yes |

The V1 publishable headline lives at `longmemeval-wake-up.yaml`. The
tool-driven Zep-comparable number becomes available once Codex ships
`enable_mcp_apps` (or a Claude Code headless adapter lands).

### Safety gates

- **Sandbox-name discipline.** Sub-project names match `lme-<id>-<ulid>`;
  the runner refuses any name containing `production` / `prod` and
  requires a sandbox marker in the parent project name.
- **Per-example write cap.** `lore mcp --write-budget 500
  --budget-state-file <path>` installs a Proxy on the Notion client
  between the rate-limit gate and the SDK. Once successful mutations
  exceed 500, every subsequent mutation tool returns the
  `WriteBudgetExceeded:` MCP error envelope and the mining child halts.
- **Per-suite write cap.** 250,000 writes across the run, inclusive
  ceiling — the example that pushes the running total to exactly the
  cap is scored, but the next example does not start. Hard abort with
  `summary.aborted: true`.
- **Cost cap.** Runner-measured agent + judge spend plus an
  ingestion-estimated number (sessions × per-session table from
  `evals/bench/pricing.json`). Projected after every example; aborts
  before the next one if the projection exceeds the cap.
- **Secrets posture.** Per-example workspaces are created via
  `mkdtemp` at mode `0700` (owner traverse only). The workspace
  carries the `.lore-bench-mode` sentinel and a `.codex/config.toml`
  written at mode `0600` (owner read/write only). The
  `.codex/config.toml` embeds the bench `NOTION_API_TOKEN` and
  `LORE_CONFIG_ROOT` in its `[mcp_servers.lore.env]` table so the
  spawned MCP child can authenticate; the values do NOT appear in
  Codex argv (`buildBenchSpawnArgs` carries zero secrets). Threat
  model: the token is on disk for the duration of the example
  (~3–5 minutes), readable only by the owning UID, removed when
  `runBenchExample`'s `finally` deletes the workspace. **Cancellation
  or `--keep-workspaces` leaves the file behind** — operators
  running with either must clean up manually (`rm -rf
  /tmp/lore-bench-*`) and use a per-run revocable bench-scoped
  token (`LORE_BENCH_NOTION_TOKEN` is deliberately distinct from
  `NOTION_API_TOKEN` for this reason). An adversarial corpus-row
  prompt-injection reaching the agent could `cat
  .codex/config.toml` from within its sandbox; LongMemEval
  mitigates this at the supply-chain layer (HF-pinned + sha256-
  verified corpus), and `redactBearerTokens` strips verbatim
  bearer-shaped substrings from any answer/judge output before
  artifact write as defense-in-depth.

### Model snapshot pinning

`benchSuiteSchema` pins `agent.model` to `z.literal("gpt-4o-mini-2024-07-18")`
and `judge.model` to `z.literal("gpt-4o-2024-08-06")`. The schema is
the deliberate audit checkpoint when bumping models — a model bump
must include a coordinated Zod-schema change, a baseline re-capture
to absorb the ranking delta, and a `evals/bench/pricing.json` update
so the cost cap remains honest. The model-version coupling is by
design.

### Caveats baked into every artifact

- **`summary.temporalFidelityCaveat`** — Lore's Memory schema has no
  caller-writable session-timestamp column today. The
  `temporal-reasoning` and `knowledge-update` scores measure
  agent-recovers-temporal-context-from-body-text, not
  Lore-ranks-by-event-time.
- **`summary.diagnosticCountCaveat`** — `ingestion.memoriesCreated` and
  `ingestion.factsCreated` come from `listAllForBackfill({ projectId })`,
  which may include vault-wide unscoped rows. The authoritative
  per-example write count is `ingestion.notionWrites` (sourced from
  the write-budget Proxy's counter).

### Cleanup

`lore eval bench cleanup-orphans --older-than 24` archives any
`lme-<id>-<ulid>` sub-project under the sandbox vault whose
ULID-embedded timestamp is older than 24 hours. ULIDs decode without
a Notion round-trip; idempotent.

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
