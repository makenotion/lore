# LongMemEval And Benchmark Reference

This reference covers LongMemEval bench setup, runtime gates, ingestion and
retrieval strategies, profile suites, safety gates, model pinning, caveats, and
cleanup. Start with [`evals.md`](evals.md) for the runner overview and
[`evals-suite-format.md`](evals-suite-format.md) for retrieval/task suite
schema and baseline rules.

## Temporal-Fidelity Caveat

The LongMemEval bench published number on the `temporal-reasoning` and
`knowledge-update` categories is **not apples-to-apples** with agent-memory
systems that rank by session event time. Two facts about Lore's schema explain
why, and the caveat must travel with every published number on those two
categories.

Lore's Memories schema has no caller-writable session-timestamp column.
`Memory.createdAt` maps to Notion's `page.created_time` (server-set, not
caller-settable); `Last Referenced At` is the read-decay anchor; `Decided At`
and `Done At` are domain-specific to the decision and task surfaces; `Session`
is `rich_text` carrying a session id, not a date. Lore's retrieval ranks by
ingestion-time recency, not by event time embedded in the conversation.

Consequence on those two categories: a LongMemEval score measures **whether the
agent recovers temporal context from the memory body's free text**, not whether
Lore's retrieval ranks by event time. The agent can still answer correctly when
the body's prose carries the session timestamp explicitly -- the bench is
therefore a measurement of an agent capability composed with Lore's ingestion
shape, not a direct comparison to systems that rank by event time. The
comparison to Zep's `longmemeval_s` numbers on these two categories is not
apples-to-apples on the temporal axis.

The bench artifact's `summary.temporalFidelityCaveat` field carries this
disclaimer verbatim so downstream consumers (CI logs, dashboards, public posts)
cannot strip it from headline output. Adding a writable session-time column to
the Memories schema would let retrieval rank by event time and convert this
caveat into an honest apples-to-apples comparison; until then, the caveat
applies.

## LongMemEval Bench Runner

The `bench` runner targets the publicly comparable LongMemEval `s_cleaned`
corpus. Each example is a haystack of 30-40 multi-turn sessions plus one target
question; the runner replays the haystack through Lore's production mining seam
(`runConversationMining`), invokes a Codex-driven agent to answer through
`lore-context` / `lore-query` / `lore-memory`, and scores the answer with a
snapshot-pinned OpenAI judge.

### One-Time Setup

```bash
node dist/cli.js eval bench fetch longmemeval
```

Downloads the corpus from the HF revision pinned in
`evals/bench-corpora/longmemeval/checksums.json` and verifies sha256.
Re-running is idempotent (sha-matched file is left in place).

### Required Env Vars

| Variable                          | Purpose                                                                                                                                                                                                                                                                                            |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `LORE_EVAL_BENCH_REAL=1`          | Master gate -- without it every bench-mode adapter refuses to spawn.                                                                                                                                                                                                                               |
| `LORE_BENCH_NOTION_TOKEN`         | Per-run Notion token; the bench-runner keeps it in runner-owned process state for tool-driven retrieval. Use a revocable bench-scoped token, not your day-to-day `NOTION_API_TOKEN`. |
| `LORE_BENCH_OPENAI_API_KEY`       | OpenAI key for both the agent (Codex shells out) and the judge.                                                                                                                                                                                                                                    |
| `LORE_BENCH_CONFIG_ROOT`          | Path to a `.lore.yaml` directory targeting the sandbox vault.                                                                                                                                                                                                                                      |
| `LORE_BENCH_SANDBOX_PROJECT_NAME` | Parent sandbox project name; per-example sub-projects are created under it.                                                                                                                                                                                                                        |
| `LORE_EVAL_BENCH_MAX_USD`         | Optional cost cap (default 75). The runner aborts between examples if the projected total exceeds it.                                                                                                                                                                                              |

### Running

```bash
node dist/cli.js eval run --runner bench \
  evals/bench-suites/longmemeval.yaml \
  --out evals/results/bench-$(date +%Y%m%d).json
```

Pass `--baseline evals/baselines/longmemeval-s-gpt4o-mini.json` to gate drift;
the first dispatched run lands in **bootstrap** mode (no baseline file present)
and a maintainer commits the captured baseline before drift gating activates.

The bench workflow (`.github/workflows/eval-bench.yml`) is
**workflow_dispatch-only** for now -- bench runs are operator-initiated, not
scheduled. Promotion to a recurring cadence is a follow-up once the steady-state
cost + drift gate are trusted.

### Ingestion Strategies

Three strategies ship; the suite YAML's `ingestion.strategy` chooses between
them. `lore-mine` can also set `ingestion.memoryCaptureMode:
conversational` to compare production autosave's durable filter with the
opt-in conversational recall filter on the same corpus. All produce the same
artifact shape; the `config.ingestion.strategy` and `config.ingestion.seam`
fields record which path produced the numbers.

- **`lore-mine`** (V1 default,
  [`longmemeval.yaml`](../evals/bench-suites/longmemeval.yaml)) -- each session
  is mined through the production Stop-hook autosave pipeline:
  `runConversationMining` spawns `claude -p`, which calls Lore MCP tools, which
  run the autosave's "durable knowledge" filter. Faithful to Lore's production
  write path. The autosave filter intentionally rejects casual conversational
  facts, so on LongMemEval's synthetic-conversation corpus mining produces ~1
  memory per ~30-session haystack and the agent recalls little. This number
  measures "Lore's production filter against the LongMemEval workload" -- honest
  but not directly comparable to memory systems that ingest every token.
- **`lore-mine` + `memoryCaptureMode: conversational`**
  ([`longmemeval-conversational-autosave.yaml`](../evals/bench-suites/longmemeval-conversational-autosave.yaml))
  -- each session still runs through `runConversationMining` and the hook-native
  background-agent path, but the autosave prompt uses the opt-in conversational
  recall policy. This is the product-path comparison for user preferences,
  casual facts, personal details, and LongMemEval-style chat memory without
  bypassing the production write seam. Bench sandboxes force these writes to
  accepted status so the retrieval phase measures post-review recall quality
  rather than proposed-inbox invisibility.
- **`raw-transcript`**
  ([`longmemeval-raw-transcript.yaml`](../evals/bench-suites/longmemeval-raw-transcript.yaml))
  -- each haystack session is stored verbatim as one memory (title
  `Session <i>: <session-id>`, body = the rendered transcript). The agent's
  `lore-query` / `lore-context` retrieves transcript memories by question
  relevance and reads the body via `lore-memory action='expand'`. Bypasses
  `runConversationMining` entirely -- no `claude -p`, no autosave-prompt
  filter. Apples-to-apples with Zep's published Graphiti baseline on
  `longmemeval_s`.
- **`simulated-autosave`**
  ([`longmemeval-simulated-autosave.yaml`](../evals/bench-suites/longmemeval-simulated-autosave.yaml))
  -- each haystack session is sent through a deterministic structured
  extraction prompt, then written as Lore-shaped memory rows with title,
  synopsis, keywords, closed-vocabulary tags, body content, and explicit
  `mentions` facts for extracted entities. This bypasses the production
  autosave durability filter, so it is not a measurement of what Lore writes
  during normal Stop-hook autosave. It is the Zep-comparable enriched-ingestion
  surface: the full conversational signal is retained, but the vault shape is
  closer to production Lore recall than raw transcript dumps.

All strategies share the same per-example / per-suite write caps and the same
retrieval surface (the agent does not know which path populated the vault).
Publishing a number alongside a Zep-comparable headline means picking
`raw-transcript`; publishing a number that reflects default Lore production
autosave means picking `lore-mine`; publishing the opt-in conversational product
path means picking `longmemeval-conversational-autosave.yaml`. Use
`simulated-autosave` when comparing against systems that enrich conversation
turns at ingest time, and report the production-filter bypass trade-off with
the result.

Manual comparison for `simulated-autosave`: run the simulated suite and the
same-sample wake-up suite with the same `--limit` and artifact paths, then
compare their `summary.overall.accuracy`,
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

If simulated-autosave does not outperform raw-transcript plus wake-up-prefetch
on the same sample, file a follow-up with both artifact paths and the observed
deltas; the implementation remains valid as long as the artifact records the
comparable fields.

### Profile Suites

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

### Agent Retrieval Strategies

The bench supports two retrieval surfaces, selected via the suite YAML's
`agent.retrieval` field. Both produce the same artifact shape;
`config.agent.retrieval` records which surface produced the numbers.

- **`tool-driven`** (V1 default) -- the agent decides during the answer attempt
  when to retrieve from Lore. Codex bench runs expose live read tools through
  runner-installed `lore-query` and `lore-memory` command shims in the
  workspace `PATH`; those shims call Lore services against the just-seeded
  example project and append a JSONL retrieval trace. This is not wake-up
  prefetch: no retrieved memory body is injected into the initial prompt.
- **`wake-up-prefetch`**
  ([`longmemeval-wake-up.yaml`](../evals/bench-suites/longmemeval-wake-up.yaml))
  -- the bench-runner calls `loadWakeUpData({ mode: "task-only",
  userQuery: <question>, includeMemoryContent: true })` BEFORE invoking the
  agent, then injects the top-10 matching memory bodies into the user prompt as
  a "Retrieved context" block. The agent answers from the injected context --
  no live tool calls required. This uses the same narrow wake-up shape as
  `lore-context action='wake-up' mode='task-only' userQuery=<task>`: for a
  one-shot bench question the relevance-ranked taskMemories section is the
  load-bearing part, while digest / recent / active-tasks sections of full
  wake-up are noise.

Every bench example now records `agent.retrieval.calls[]`. Tool-driven entries
come from the command shim and have `timing: "during-agent-run"`; wake-up
prefetch entries have `timing: "before-agent-run"`. Each entry records the
tool/action, status, surfaced memory IDs, expanded memory IDs, and any error.
When the selected host cannot expose live tools, the runner writes an aborted
artifact with a clear skip reason before creating per-example projects.

The two strategies compose with `ingestion.strategy` independently:

| `ingestion.strategy` | `agent.retrieval`  | What it measures                                                            | Currently runnable |
| -------------------- | ------------------ | --------------------------------------------------------------------------- | ------------------ |
| `lore-mine`          | `tool-driven`      | Production write path x agent tool-call propensity                          | Yes                |
| `lore-mine`          | `wake-up-prefetch` | Production write path x isolated retrieval surface                          | Yes                |
| `raw-transcript`     | `tool-driven`      | Full corpus fidelity x agent tool-call propensity (Zep-comparable headline) | Yes                |
| `raw-transcript`     | `wake-up-prefetch` | Full corpus fidelity x isolated retrieval surface                           | Yes                |
| `simulated-autosave` | `tool-driven`      | Enriched ingest x agent tool-call propensity (Zep-style enrichment surface) | Yes                |
| `simulated-autosave` | `wake-up-prefetch` | Enriched ingest x isolated retrieval surface                                | Yes                |

Use tool-driven suites when measuring whether the agent chooses useful
mid-session retrieval and expansion. Use wake-up-prefetch suites when isolating
the retrieval ranker from tool-choice behavior.

### Safety Gates

- **Sandbox-name discipline.** Sub-project names match `lme-<id>-<ulid>`; the
  runner refuses any name containing `production` / `prod` and requires a
  sandbox marker in the parent project name.
- **Per-example write cap.** `lore mcp` with `--write-budget 500` and
  `--budget-state-file <path>` installs a Proxy on the Notion client between
  the rate-limit gate and the SDK. Once successful mutations exceed 500, every
  subsequent mutation tool returns the `WriteBudgetExceeded:` MCP error envelope
  and the mining child halts.
- **Per-suite write cap.** 250,000 writes across the run, inclusive ceiling --
  the example that pushes the running total to exactly the cap is scored, but
  the next example does not start. Hard abort with `summary.aborted: true`.
- **Cost cap.** Runner-measured agent + judge spend plus an ingestion-estimated
  number (sessions x per-session table from `evals/bench/pricing.json`).
  Projected after every example; aborts before the next one if the projection
  exceeds the cap.
- **Secrets posture.** Per-example workspaces are created via `mkdtemp` at mode
  `0700` (owner traverse only). Agent-readable workspaces carry only the
  `.lore-bench-mode` sentinel and a `.codex/config.toml` with non-secret model
  config; tool-driven retrieval additionally installs command shims. The agent
  gets a Unix socket path for live tools; the bench-runner-owned broker process
  keeps the Notion token, config root, project id, and trace path fixed outside
  the workspace. Wake-up-prefetch retrieval also stays runner-side and does not
  need a Notion-authenticated MCP config in the workspace. Codex argv and the
  Codex child env carry zero Notion bearer-shaped values; the bench spawn also
  sets `shell_environment_policy.exclude` so model-generated shell commands do
  not inherit bearer env keys such as `OPENAI_API_KEY`. Cancellation or
  `--keep-workspaces` can leave non-secret workspace files behind; operators may
  clean up with `rm -rf /tmp/lore-bench-*`. Use a per-run revocable bench-scoped
  token (`LORE_BENCH_NOTION_TOKEN` is deliberately distinct from
  `NOTION_API_TOKEN` for this reason). `redactBearerTokens` strips verbatim
  bearer-shaped substrings from answer, judge, broker stderr, and wake-up
  retrieval errors before artifact write as defense-in-depth.

### Model Snapshot Pinning

`benchSuiteSchema` pins `agent.model` to `z.literal("gpt-4o-mini-2024-07-18")`
and `judge.model` to `z.literal("gpt-4o-2024-08-06")`. The schema is the
deliberate audit checkpoint when bumping models -- a model bump must include a
coordinated Zod-schema change, a baseline re-capture to absorb the ranking
delta, and a `evals/bench/pricing.json` update so the cost cap remains honest.
The model-version coupling is by design.

### Caveats Baked Into Every Artifact

- **`summary.temporalFidelityCaveat`** -- Lore's Memory schema has no
  caller-writable session-timestamp column today. The `temporal-reasoning` and
  `knowledge-update` scores measure temporal context recovered from body text,
  not Lore-ranked event time.
- **`summary.diagnosticCountCaveat`** -- `ingestion.memoriesCreated` and
  `ingestion.factsCreated` come from `listAllForBackfill({ projectId })`, which
  may include vault-wide unscoped rows. The authoritative per-example write
  count is `ingestion.notionWrites` (sourced from the write-budget Proxy's
  counter).

### Cleanup

`lore eval bench cleanup-orphans --older-than 24` archives any
`lme-<id>-<ulid>` sub-project under the sandbox vault whose ULID-embedded
timestamp is older than 24 hours. ULIDs decode without a Notion round-trip;
idempotent.
