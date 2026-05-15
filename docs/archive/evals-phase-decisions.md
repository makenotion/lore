# Evals Phase Decisions

This archive preserves the Phase 0/A/B decisions, rejected alternatives, and
benchmark-selection evidence that originally lived in the main eval guide. Use
[`../evals.md`](../evals.md) for current runner routing and
[`../evals-suite-format.md`](../evals-suite-format.md) for active suite-format
guidance.

## Hook-Native Longitudinal Task Evals: Phase 0 Decision

This section records the Phase 0 recommendation for hook-native longitudinal
software-agent evals. It is a feasibility and fidelity decision, not a product
claim: positive lift, no lift, or harm are Phase 1+ findings.

## Existing Lore Eval Inventory

Lore already has five eval runner modes. The retrieval and notion runners
measure which memory rows surface; the task runner measures whether an agent
changes a workspace correctly; the bench runner measures LongMemEval-style
ingest and recall; the profile runner measures deterministic profile-owned
taxonomy quality. The hook-native longitudinal claim needs the task runner's
workspace and verifier model, plus the hook and wake-up seams already proven in
the bench runner.

| Existing surface                                                                                     | Current fit                                                                                                                         | Limits for this decision                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retrieval` runner (`src/eval/runner.ts`, `src/eval/schema.ts`, `evals/suites/lore-core.yaml`)       | Deterministic fixture-backed `loadWakeUpData`; fast precision/recall over surfaced memory IDs.                                      | Measures retrieval quality only. It does not run a coding agent or form memory from a prior session.                                                                         |
| `notion` runner (`src/eval/runner.ts`)                                                               | Same suite shape against real `LoreServices` scoped to a sandbox project. Useful for retrieval-stack drift.                         | Read-only live-vault state. No isolated seed/cleanup, no phase boundary, no agent workspace.                                                                                 |
| `task` runner (`src/eval/task-runner.ts`, `evals/task-suites/starter.yaml`)                          | Copies synthetic workspaces, runs `codex exec`, and scores deterministic verifiers.                                                 | Current memory matrix seeds `.lore-memories.json`; it does not exercise Stop-hook-shaped formation or wake-up injection.                                                     |
| `bench` runner (`src/eval/bench-runner.ts`, `src/eval/bench-ingest.ts`, `evals/bench-suites/*.yaml`) | Replays LongMemEval haystacks through `runConversationMining`, raw transcripts, or simulated autosave; supports `wake-up-prefetch`. | LongMemEval is conversation-memory QA, not multi-session software work. Tool-driven retrieval remains unavailable under `codex exec`; runnable paths use `wake-up-prefetch`. |
| `profile` runner (`src/eval/profile-runner.ts`, `evals/profile-suites/support.yaml`)                 | Scores committed profile extraction artifacts against profile-owned taxonomy and output-shape expectations.                         | Does not exercise memory retrieval, hook capture, live Notion state, or agent workspace behavior.                                                                            |

## Candidate Benchmark Review

The recommendation below uses external benchmarks as design input, not as the
Phase 1 runner source. Public availability was checked on 2026-05-13.

| Candidate                                              | Adopt / adapt / reject                                               | Reproducibility status                                                                                                                                                                            | Public data/code                                                              | License                                                                                       | Software-agent fit                                                                                                                                              | Hook compatibility                                                                                                                                              | Scoring/verifier model                                                                     | Cost                                                                            | Implementation risk                                                                                | Rationale                                                                                                                                                                                     |
| ------------------------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LongMemEval / LoCoMo / current memory leaderboards     | Reject as the Phase 1 source; keep as retrieval/chat-memory context. | Data and runners are available for LongMemEval and memory-benchmark suites; some runs require OpenAI judges or memory-service backends. Lore already has pinned LongMemEval bench corpus support. | Yes: LongMemEval repo/dataset and memory-benchmark runners are public.        | LongMemEval code MIT; `mem0ai/memory-benchmarks` Apache-2.0; dataset licenses vary by corpus. | Weak. They are mostly chat-history QA and retrieval recall, not repo work across sessions.                                                                      | Partial. Lore's bench runner already covers `runConversationMining` and `wake-up-prefetch`, but not software-task outcomes.                                     | QA correctness, retrieval recall, or judge labels.                                         | Medium to high when judge/model calls are included.                             | Low for continuing current bench work; high if used for the software-work claim.                   | They are useful calibration surfaces, but they cannot answer whether hook-captured software context changes later coding behavior.                                                            |
| LongMemEval-V2                                         | Adapt ideas only.                                                    | Data is available as a 7.12 GB Hugging Face dataset with JSONL trajectories, screenshots, schema, and checksums. A public runner/code release was not found during Phase 0.                       | Data yes; runner/code not verified.                                           | Dataset Apache-2.0.                                                                           | Medium. It targets environment-specific agent experience, workflows, gotchas, and premise awareness, but in web/enterprise environments rather than code repos. | Partial. Trajectories resemble Phase A experience, but the task is evidence gathering for QA rather than hook-written memory used in a later software task.     | Context-gathering evidence followed by QA accuracy.                                        | High: large trajectory/screenshot payloads and coding-agent evidence gathering. | High for direct adoption; medium as scenario inspiration.                                          | It best matches "experienced colleague" memory, but adopting it would require a new web-agent trajectory adapter before Lore can test hook-native software work.                              |
| Mem2ActBench                                           | Adapt the action-grounding idea.                                     | Paper advertises an anonymous 4open code/data repo; direct fetch was Cloudflare-blocked during Phase 0, so local reproduction was not verified.                                                   | Advertised yes; not locally verified.                                         | Unknown from accessible surfaces.                                                             | Medium. It tests memory-driven tool choice and parameter grounding, which is closer to "memory changes action" than QA. It is not repo patching.                | Partial. Histories can inform formation prompts, but the benchmark's final action is an offline tool call, not a fresh coding session with workspace verifiers. | Tool-call selection and parameter F1.                                                      | Medium.                                                                         | Medium to high because the public artifact path is anonymous and the task format needs conversion. | Good conceptual pressure: Phase 1 verifiers should check behavior, not only surfaced memories. Direct adoption would spend effort adapting tool-call data instead of exercising Lore's hooks. |
| MemoryArena                                            | Adapt scenario structure later; reject for Phase 1 source.           | Hugging Face dataset is public with bundled shopping, progressive search, group travel, and formal reasoning configs. A directly reusable software-runner path was not verified.                  | Dataset yes; reusable runner/code unclear.                                    | Dataset CC-BY-4.0.                                                                            | Medium. It is explicitly multi-session and interdependent, but its environments are web shopping, travel planning, search, and formal reasoning.                | Conceptually strong but mechanically heavy: would need environment adapters and hook transcript synthesis before it tests Lore.                                 | Ground-truth answers, task success, and progress-style scores.                             | Medium to high.                                                                 | High for the MVP.                                                                                  | The Memory-Agent-Environment loop is the right mental model, but the Phase 1 MVP should first prove the harness on small repo fixtures.                                                       |
| MemoryAgentBench                                       | Reject as runner source; adapt taxonomy.                             | Hugging Face dataset and GitHub code are public. Reproduction requires model/API setup for several baselines.                                                                                     | Data yes; code yes.                                                           | Dataset MIT; GitHub repo license not detected via GitHub API.                                 | Weak to medium. It covers memory competencies, not software-agent workspace outcomes.                                                                           | Low. Incremental chunks can be replayed, but they bypass Lore's hook-shaped transcript and wake-up workflow.                                                    | QA / classification / summarization accuracy, with LLM-based metrics for some tasks.       | Medium to high.                                                                 | Medium.                                                                                            | Its competency taxonomy is useful for naming future scenarios, especially conflict resolution, but it would not validate hook-native software work.                                           |
| SWE-bench / SWE-bench Mobile / coding-agent benchmarks | Adapt fixture and verifier discipline; reject direct adoption.       | SWE-bench has public code/data and Docker evaluation. SWE-bench Mobile is a hosted challenge; task details remain private and the repo is still being prepared for public release.                | SWE-bench yes; SWE-bench Mobile public leaderboard/toolkit but private tasks. | SWE-bench MIT; SWE-bench Mobile license not verified.                                         | High for repo patching, low for memory because tasks are independent issue fixes.                                                                               | Low without manual scenario chaining. Existing issues do not naturally include a prior-session memory formation phase.                                          | Test suites and patch correctness.                                                         | High compute/storage for full SWE-bench; hosted for Mobile.                     | Medium.                                                                                            | This is the right source of verifier instincts, but Phase 1 should use tiny committed fixtures where the memory dependency is deliberate and auditable.                                       |
| AgentBench-style agent setup benchmarks                | Adapt measurement posture; reject direct adoption.                   | `agentbench/agentbench` is public as a Claude Code/OpenClaw plugin; THUDM AgentBench is public for multi-environment LLM-as-agent evaluation.                                                     | Yes.                                                                          | `agentbench/agentbench` MIT; THUDM AgentBench Apache-2.0.                                     | Medium for tool workflow and tracing, weak for Lore-specific memory.                                                                                            | Low. They benchmark an agent setup, not Lore's Stop/wake-up loop.                                                                                               | Rule-based tasks and traces for the plugin; environment task success for THUDM AgentBench. | Low to medium.                                                                  | Low as inspiration, high as a direct runner dependency.                                            | Keep the rule-based scoring, trace, and cost fields; do not import an unrelated plugin runner into Lore's eval stack.                                                                         |

## Recommendation

Extend the existing `task` runner with a phase-aware longitudinal suite shape.
Do not add a new top-level runner unless implementation proves the schema cannot
remain inside task mode.

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
  the harness because the production hook is intentionally fire-and-forget. The
  runner needs an awaitable completion boundary and structured failure signal.
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

The Phase A artifact must record `condition`, `phase: "formation"`, `promptId`,
`workspace`, hook settings, created memory/fact/decision/task counts, verifier
results, elapsed time, cost fields when available, and patch stats.

## Phase B Path

Phase B is the memory-use phase.

1. Start a fresh agent process/session against the post-Phase-A workspace.
2. For `no-memory`, pass only the Phase B prompt. Lore remains disabled, and the
   agent receives no context file or preloaded memory.
3. For `lore-full-loop`, call `loadWakeUpData(...)` with `projectId`, the Phase
   B prompt as `userQuery`, and `includeMemoryContent: true` before spawning the
   Phase B agent. Render the relevant wake-up bundle into the prompt as
   retrieved context. This is the selected Phase B path: runner-side
   `loadWakeUpData` / wake-up-prefetch, not MCP tool-driven retrieval inside
   `codex exec`.
4. Run deterministic workspace verifiers after the Phase B agent exits. Verifier
   failures are outcome data. Harness failures are only infrastructure failures:
   setup errors, mining crashes, wake-up load failures, timeout/spawn failures,
   malformed artifacts, or cleanup failures.

The Phase B artifact must record `condition`, `phase: "use"`, `promptId`,
`workspace`, wake-up settings, expected context IDs, surfaced context IDs,
harmful context IDs, verifier results, elapsed time, cost fields when available,
and patch stats.

## Storage Strategy

Use a hybrid storage strategy:

- Unit tests and parser/schema tests should use fake services or in-memory
  adapters. They should verify suite loading, condition expansion, artifact
  shape, verifier behavior, cleanup, and the no-memory path without Notion.
- The real `lore-full-loop` dry run requires a live Notion sandbox. Create a
  per-run sub-project under an operator-provided sandbox/eval/test project,
  named with the scenario id and a run ULID. Write `.lore.yaml` only in the temp
  config root or temp workspace, never in the source fixture. Archive the
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
as `runConversationMining`, the Phase B memory-use path as `loadWakeUpData` /
wake-up-prefetch, and the storage path as hybrid fake tests plus a live sandbox
smoke run. Keep exactly these three scenarios for Phase 1:

| Scenario                               | Fixture path                                     | Phase A prompt                                                                                                                                                               | Phase B prompt                                                                                       | Expected memory dependency                                                                                                        | Verifier                                                                                                                                              | Artifact assertions                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `decision-continuity-result-boundary`  | `evals/longitudinal/workspaces/result-boundary/` | Add `createUserProfile(input)`, decide whether service-boundary functions return Result objects or throw exceptions, implement the chosen pattern, and capture the decision. | Add `fetchUserProfile(userId)` while staying consistent with the previous service-boundary decision. | A surfaced decision/memory that service-boundary functions return `Result` values with `ok` / `err` helpers rather than throwing. | `fetchUserProfile` is exported; it returns `ok(...)` or `err(...)`; `throw new Error` is forbidden in service-boundary functions; fixture tests pass. | Phase A records at least one memory or decision; Phase B surfaces the expected context under `lore-full-loop`; verifier results and patch stats are present for both conditions. |
| `failed-attempt-avoidance-esm-imports` | `evals/longitudinal/workspaces/esm-cli/`         | Investigate and fix the failing CLI import test for `commands/status.ts`; capture any repo-specific import gotcha.                                                           | Add `commands/sync.ts` and wire it into the CLI using the learned import convention.                 | A surfaced memory that TypeScript source in the ESM fixture must use `.js` on internal relative imports.                          | `commands/sync.ts` imports siblings with `.js` extensions; extensionless relative imports from `./` or `../` are forbidden; fixture tests pass.       | Phase A records the import gotcha; Phase B surfaces it in `lore-full-loop`; no-memory failures are captured as lift/harm data, not harness failures.                             |
| `follow-up-task-json-output`           | `evals/longitudinal/workspaces/follow-up-task/`  | Implement basic text output for `status`; create a follow-up task to add `--json` output for automation consumers.                                                           | Pick up the unresolved follow-up from the previous session and implement it.                         | An active Lore task or surfaced memory identifying the unresolved `status --json` follow-up.                                      | `status --json` emits parseable JSON with expected keys; default text output remains unchanged; fixture tests pass.                                   | Phase A records `tasksCreated >= 1`; Phase B surfaces the expected task or task-derived memory; artifact records task completion/closure when observable.                        |
