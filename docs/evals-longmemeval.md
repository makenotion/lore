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
| `LORE_BENCH_NOTION_TOKEN`         | Per-run Notion token; the bench-runner writes it into the per-example workspace's `.codex/config.toml` (mode `0600`) so the spawned MCP child can authenticate. See "Secrets posture" below for the full risk model -- use a revocable bench-scoped token, not your day-to-day `NOTION_API_TOKEN`. |
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
them. All produce the same artifact shape; the `config.ingestion.strategy` and
`config.ingestion.seam` fields record which path produced the numbers.

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
`raw-transcript`; publishing a number that reflects what Lore writes in
production means picking `lore-mine`. Use `simulated-autosave` when comparing
against systems that enrich conversation turns at ingest time, and report the
production-filter bypass trade-off with the result.

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

- **`tool-driven`** (V1 default) -- the agent has Lore MCP tools (`lore-query`,
  `lore-memory`, `lore-context`) registered and decides for itself when to call
  them. Maps to mid-session followup behavior in production Lore. **Currently
  structurally unavailable under `codex exec`** -- Codex 0.128.0 does not load
  MCP servers in its non-interactive exec mode (`enable_mcp_apps` feature flag
  is "under development"). The agent sees no tools and falls through to
  shell-command attempts that all fail with `command not found`. Listed in the
  schema for completeness and to keep YAML loading stable when a future Codex
  release or a Claude Code headless adapter restores tool-driven retrieval.
- **`wake-up-prefetch`**
  ([`longmemeval-wake-up.yaml`](../evals/bench-suites/longmemeval-wake-up.yaml))
  -- the bench-runner calls `services.memories.search(...)` with
  `includeContent: true` and `mode: "hybrid"` BEFORE invoking the agent, then
  injects the top-10 matching memory bodies into the user prompt as a
  "Retrieved context" block. The agent answers from the injected context -- no
  MCP tool calls required, which sidesteps the MCP-in-exec gap. Mirrors how
  Lore's wake-up hook actually works at session start: the hook calls
  `lore-context action='wake-up' userQuery=<task>` via the agent's MCP
  integration and the response is pasted into the agent's context window. For a
  one-shot bench question the relevance-ranked taskMemories section is the
  load-bearing part -- digest / recent / active-tasks sections of full wake-up
  are noise for a single question.

The two strategies compose with `ingestion.strategy` independently:

| `ingestion.strategy` | `agent.retrieval`  | What it measures                                                            | Currently runnable     |
| -------------------- | ------------------ | --------------------------------------------------------------------------- | ---------------------- |
| `lore-mine`          | `tool-driven`      | Production write path x agent tool-call propensity                          | Blocked on MCP-in-exec |
| `lore-mine`          | `wake-up-prefetch` | Production write path x isolated retrieval surface                          | Yes                    |
| `raw-transcript`     | `tool-driven`      | Full corpus fidelity x agent tool-call propensity (Zep-comparable headline) | Blocked on MCP-in-exec |
| `raw-transcript`     | `wake-up-prefetch` | Full corpus fidelity x isolated retrieval surface (V1 publishable headline) | Yes                    |
| `simulated-autosave` | `tool-driven`      | Enriched ingest x agent tool-call propensity (Zep-style enrichment surface) | Blocked on MCP-in-exec |
| `simulated-autosave` | `wake-up-prefetch` | Enriched ingest x isolated retrieval surface                                | Yes                    |

The V1 publishable headline lives at `longmemeval-wake-up.yaml`. The tool-driven
Zep-comparable number becomes available once Codex ships `enable_mcp_apps` (or a
Claude Code headless adapter lands).

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
  `0700` (owner traverse only). The workspace carries the `.lore-bench-mode`
  sentinel and a `.codex/config.toml` written at mode `0600` (owner read/write
  only). The `.codex/config.toml` embeds the bench `NOTION_API_TOKEN` and
  `LORE_CONFIG_ROOT` in its `[mcp_servers.lore.env]` table so the spawned MCP
  child can authenticate; the values do NOT appear in Codex argv
  (`buildBenchSpawnArgs` carries zero secrets). Threat model: the token is on
  disk for the duration of the example (~3-5 minutes), readable only by the
  owning UID, removed when `runBenchExample`'s `finally` deletes the workspace.
  **Cancellation or `--keep-workspaces` leaves the file behind** -- operators
  running with either must clean up manually (`rm -rf /tmp/lore-bench-*`) and
  use a per-run revocable bench-scoped token (`LORE_BENCH_NOTION_TOKEN` is
  deliberately distinct from `NOTION_API_TOKEN` for this reason). An adversarial
  corpus-row prompt-injection reaching the agent could `cat .codex/config.toml`
  from within its sandbox; LongMemEval mitigates this at the supply-chain layer
  (HF-pinned + sha256-verified corpus), and `redactBearerTokens` strips verbatim
  bearer-shaped substrings from any answer/judge output before artifact write
  as defense-in-depth.

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
