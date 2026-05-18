# CLI Command Overview

This is a compact overview of the main command surfaces and notable options,
not an exhaustive flag reference. Run `lore <command> --help` for the complete
registered flags for a command.

## Common Workflows

### Set up Lore for a shared vault

Goal: connect this clone and its assistant integrations to a team-owned Notion
vault page.

Minimum commands:

```sh
# Bootstrap an empty shared page once, after auth is available:
lore init <shared-page-id>

# Internal Notion engineers configuring assistant integrations:
lore install --ntn

# External operators configuring assistant integrations:
export NOTION_API_TOKEN=ntn_...
lore install
```

Success signal: `lore init` writes a local `.lore.yaml`, and `lore install`
prints successful auth and vault access checks before writing assistant config.
See the `lore init [page-id]` and `lore install` command rows below for flag
details; use [README](../README.md) and
[team-rollout.md](team-rollout.md) for the full onboarding runbook.

### Check setup health

Goal: confirm the current auth source, vault access, profile, and database
health before relying on recalled context.

Minimum commands:

```sh
lore auth --status
lore status
```

Success signal: auth status reports the expected source and workspace, and
`lore status` shows the vault title, profile, database counts, and any topology
or migration warnings. See the `lore auth` and `lore status` rows below; use
[authentication.md](authentication.md) when auth points at the wrong workspace
or cannot reach the vault.

### Search remembered context

Goal: find accepted memories relevant to a concrete question before asking an
assistant to reason from scratch.

Minimum commands:

```sh
lore search "PAT rollout"
lore search "PAT rollout" --project Lore --limit 5
lore search "PAT rollout" --json
```

Success signal: matching memories render with titles, snippets, and Notion
links; narrowing with `--project` or `--limit` changes the result set without
changing vault contents. `--json` emits a pipe-clean `{ query, projectId, tags,
results }` object for scripts. See the `lore search <query>` row below for the
complete flag surface.

### Add or inspect durable knowledge

Goal: make useful project knowledge available to future sessions, then inspect
the durable context that is already pinned or queryable.

Minimum commands:

```sh
lore mine .
lore memory save "Rollout note" --content "Use per-user PATs for external operators."
lore decision create "Use PATs for external operators" --rationale "PATs preserve per-user permissions and rate limits."
lore ask Authentication --project Lore --limit 10
lore pinned list --project Lore
```

Success signal: write commands print the created or reused Notion row, `lore ask`
returns facts and tasks for the entity, and `lore pinned list` shows active
context blocks for the requested project or audience. Use the MCP
`lore-fact`, `lore-memory`, `lore-decision`, and `lore-pinned` tools when a
write path is only exposed through assistant integrations; see the matching
command rows below for the CLI-covered paths.

### Triage and close tasks

Goal: review active work, create follow-up tasks, update metadata, and close
work once the durable memory trail supports it.

Minimum commands:

```sh
lore tasks list --project Lore
lore tasks create "Document PAT onboarding" --project Lore --entity Authentication
lore tasks update <task-id> --state blocked --blocked-by "Waiting for reviewer"
lore tasks close <task-id>
```

Success signal: task lists split overdue and active work, create/update commands
echo the affected row, and close reports the final state and `Done At` stamp
when the vault has that column. See the `lore tasks ...` rows below for filters,
JSON output, and cancellation.

### Review proposed memories

Goal: keep automatic learning useful by accepting, rejecting, or archiving
proposed memories after human review.

Minimum commands:

```sh
lore inbox list --project Lore
lore inbox approve <memory-id> --reason "Accurate durable workflow"
lore inbox reject <memory-id> --reason "Too transient"
lore inbox archive <memory-id>
```

Success signal: approved memories move to accepted, rejected memories carry a
review audit block, archived rows leave the inbox, and an empty inbox exits 0
with a single status line. See the `lore inbox ...` rows below and
[hooks.md](hooks.md#shared-vault-hook-configuration)
for rollout guidance.

### Repair or migrate a vault

Goal: diagnose schema drift or legacy vault shape, then run the smallest
targeted repair needed for current Lore.

Minimum commands:

```sh
lore status
lore vault ensure-entities --dry-run
lore vault ensure-entities
lore migrate --dry-run
lore migrate
```

Success signal: dry runs describe planned writes without changing Notion, repair
commands summarize created properties or migrated rows, and a follow-up
`lore status` no longer reports the targeted schema warning. Project-capable
one-shot data migrations require a scope and use the same specific migration
flag in plan and apply mode, such as
`lore migrate --build-entities --project Lore` followed by
`lore migrate --build-entities --project Lore --yes`; bare `--yes` is invalid.
See the `lore vault ensure-entities` and `lore migrate` rows below; legacy
four-database vaults also need the entity cutover steps in
[team-rollout.md](team-rollout.md#entities-database-cutover).

### Generate config for unsupported MCP hosts

Goal: produce a paste-ready MCP config snippet for an assistant host that
`lore install --client` does not write directly.

Minimum commands:

```sh
lore install --print-config json
lore install --print-config toml
```

Success signal: Lore prints the requested JSON or TOML config to stdout without
modifying host files, so you can paste it into the unsupported MCP client. See
the `lore install` row below and
[README](../README.md#other-mcp-hosts) for host integration context.

## Command Reference

| Command                                                    | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lore init [page-id]`                                      | Create vault databases and write `.lore.yaml` with an exact built-in profile selector. Defaults to `profile: default@<runtime-profile-version>`; pass `--profile support@1.0.0` for the support pilot. Pass `<page-id>` for team / repo-scoped vaults (recommended); explicit-page init can use `--token <token>` to supply a literal token. Omit `[page-id]` to create a workspace-level page via the active auth source; no-arg init can use `--name <name>`, `--ntn-env <prod\|dev\|stg>`, and `--yes` for ntn install / login prompts. When `<page-id>` is supplied, `--name` and `--ntn-env` are ignored with warnings; `--yes` is silently irrelevant.                                                                                                                                                                                                                                                                                                         |
| `lore install`                                             | Install Lore assistant integrations (defaults to Claude Code + Codex + Cursor; default install path expects a PAT in `NOTION_API_TOKEN`; `--ntn` opts into the internal-engineer flow that auto-installs `ntn` and runs `ntn login`; `--dev` composes with both to target the Notion dev environment; `--client cursor`, `--cursor-global` for Cursor-only setup; `--print-config json\|toml` prints a paste-ready snippet for unsupported MCP hosts; `--yarn-pnp` / `--no-yarn-pnp` override Yarn PnP detection)                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lore auth`                                                | Check authentication status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `lore auth --login`                                        | In a repo with `.lore.yaml`, authenticate via ntn, auto-installing ntn if needed and verifying vault access                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `lore doctor`                                              | Run read-only setup diagnostics across config discovery, auth resolution, vault access, required databases, MCP host config, supported hooks, and recent background hook failures. Ends with one prioritized next action.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lore search <query>`                                      | Semantic search across memories (`-p`/`--project`, `-t`/`--tags`, `-n`/`--limit`, `--json`). Human output renders title links, tags, source, date, page id, and content preview; `--json` emits `{ query, projectId, tags, results }` with diagnostics reserved for stderr.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `lore memory save <title>`                                 | Save a manual memory without going through MCP. Requires exactly one body source: `--content <markdown>` or `--content-file <path>` (`-` reads stdin). Supports `--project`, `--topic`, `--kind`, closed-vocabulary `--tags` (use `--keywords` for free-form labels), `--confidence`, `--review-by`, `--decided-at`, `--synopsis`, and `--json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `lore decision create <statement>`                         | Record a decision without going through MCP. Requires exactly one rationale source: `--rationale <markdown>` or `--rationale-file <path>` (`-` reads stdin). Supports `--project`, `--topic`, `--affects <csv>` (entity names; writes `decided_by` facts), `--supersedes <csv>` (decision page ids), `--alternatives`, `--consequences`, `--confidence`, `--review-by`, `--decided-at`, closed-vocabulary `--tags`, `--keywords`, `--synopsis`, and `--json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lore ask <entity>`                                        | Query facts and tasks about an entity from the shell, mirroring `lore-query action='ask'`. Supports `--project`, `--limit`, `--as-of <YYYY-MM-DD>`, `--history`, and `--json`. The read path resolves existing Entity rows but never creates them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lore mine [path]`                                         | Index project files as source=`file` memories, updating prior mined rows for the same `(title, source, projectIds)` instead of creating duplicates (`--dry-run`, `--pattern`, `-n`). Candidate discovery honors Git `--exclude-standard`, applies default local-tooling/artifact excludes, and skips symlinks.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `lore status`                                              | Show vault status, active profile, [topology health](topology.md) when `upstreamVaults` or `promotionTargets` are configured, database counts, task/confidence summaries, proposed-memory inbox count, expired/expiring/out-of-context scoped row counters (issue #283), wake-up coverage counters, active projects, digest/drift watermarks, recent background autosave/digest failures, and a redacted malformed cost-ledger warning when local cost tracking skips corrupt rows (`--project <name>` scopes project-dependent sections)                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lore costs summary`                                       | Summarize the opt-in local cost ledger family when `costTracking.enabled` is true in `.lore.yaml`, merging the configured legacy root file with per-process shard files. Defaults to today's local events; accepts `--since <Nh\|Nd\|Nw>` or `--month <YYYY-MM>`. Reports exact agent model usage separately from autosave/digest background prompt estimates; prompt estimates may exclude completion tokens, cached-input billing, and provider-side rounding. Also reports unknown-cost model events, wake-up context token estimates, MCP calls, and Notion operation counts. The ledger is advisory telemetry: successful appends are not forced to stable storage, so host crashes or power loss may drop the most recent accepted events without an append-error warning. Warns with only a skipped-line count when malformed ledger rows are ignored.                                                                            |
| `lore costs export`                                        | Export merged cost-ledger events with redacted payload summaries as `jsonl` or `csv` (`--format jsonl\|csv`) with optional `--since <Nh\|Nd\|Nw>` or `--month <YYYY-MM>` filters. JSONL exports with no matching rows write no stdout; CSV exports with no matching rows write only the header row. Exported rows may include project, agent, session, tool, and action identifiers; redacted payload byte counts and `chars_per_token_4` token estimates; Notion operation counts; output counts; and model usage/cost estimates when known. The exported ledger rows are advisory telemetry, not crash-durable billing or audit records: successful appends are not forced to stable storage, so host crashes or power loss may drop the most recent accepted events without an append-error warning. Background autosave/digest rows with `modelUsage.source: "prompt_estimate"` are prompt-side estimates, not exact provider billing rows. Rows must not include raw prompts, raw MCP argument bodies, raw MCP result bodies, memory/fact text, Notion page bodies, or Notion response payloads. Malformed-row warnings go to stderr so stdout remains parseable. |
| `lore inbox list`                                          | List memories awaiting review (`Status = proposed`). Optional `--project <name>`, `-n <limit>` (default 50, max 100). Empty inbox prints a single line and exits 0.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `lore inbox approve <memoryId>`                            | Promote a `Status: proposed` memory to `accepted` and append a Reviewed audit block. Optional `--reason <text>` and `--reviewer <name>`. Reviewer defaults to the engineer-identity chain (`LORE_USER_NAME` → `users.me`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `lore inbox reject <memoryId>`                             | Flip a `Status: proposed` memory to `rejected` and append a Reviewed audit block. Same `--reason` / `--reviewer` flags as `approve`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lore inbox archive <memoryId>`                            | Archive a `Status: proposed` memory via Notion's archive flag. Inbox-only — non-proposed rows are rejected; use `lore-memory action='archive'` for general archives.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lore pinned list`                                         | Inspect pinned context blocks active for the current project / audience (issue #282). Optional `--project <name>`, `--audience <token>` (single-token reader-simulation), `--all-audiences` (operator inspection across audiences), `-n <limit>` (default 10, max 100), `--json` for machine-readable output. Mutating ops (pin / unpin / update) land on the MCP `lore-pinned` tool surface.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lore status projects`                                     | List active projects (`-a` / `--all` includes archived; `--archived-only` lists only archived projects)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lore status topics [project]`                             | List topics in a project                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lore migrate`                                             | Add missing schema properties and run one-shot data migrations (`--dry-run`, `--upgrade-decision-tags`, `--build-entities`, `--report-orphan-rate` (issue #542 — pair with `--build-entities`; prints the PF3-01 orphan-rate metric, `pre-pass` on plan-only / `--dry-run`, `post-pass` on `--yes`; gated by `LORE_USE_RUNTOOL_AGGREGATE` for the SQL aggregate path with JS fallback), `--fix-fact-encoding`, `--fix-memory-encoding`, `--merge-similar-topics`, `--backfill-synopses`, `--build-confidence-scores`, `--backfill-fact-observed-at` (issue #284 — see [Backfilling transaction-time fact provenance](#backfilling-transaction-time-fact-provenance) for the full contract), etc.). Project-capable data migrations require `--project <name>` or explicit `--allow-unscoped`; pass `--include-archived` with `--project` when repairing archived projects. See [Migrating From Unscoped Writes](memory-workflows.md#migrating-from-unscoped-writes). |
| `lore digest`                                              | Gather digest data for the resolved or named project and spawn a background synthesizer (`--project`, `--period`, `--since`, `--until`, `--dry-run`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lore tasks list`                                          | List tasks with Overdue/Active sections (`--project`, `--all-projects`, `--entity`, `--state`, `--due-before`, `-n`/`--limit`, `--json`); pass `--all-projects --json` for vault-wide reporting without cwd project fallback. JSON rows include `projectIds` / `projects`, plus `distinctTaskIds` and `multiProjectTaskCount`. Pass `--state done` or `cancelled` to inspect closed work. Cursor-walks Notion across up to 5 pages × 100 rows; over-cap results render as `≥N tasks (lower-bound total)` with a "narrow filters" footer                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lore tasks create <subject>`                              | Create a task with optional `--description`, `--entity`, `--state`, `--blocked-by`, `--due-date`, `--project`, `--topic`, `--tags` (active profile vocabulary; use `--keywords` for free-form), `--keywords`, `--synopsis`, `--json`. Idempotent on exact `(subject, entity, projectIds)` match — short-circuits to `Reused existing task: ...` instead of landing a duplicate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `lore tasks update <task-id>`                              | Update a task's `--state`, `--blocked-by` (empty string clears), `--entity`, `--due-date` (empty string clears), `--subject`, `--description`, `--tags` (active profile vocabulary), `--keywords`, `--synopsis`, or pass `--json` for structured output. Omitted fields are left untouched                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `lore tasks close <task-id>`                               | Mark a task done (default) or cancelled via `--state done\|cancelled`; optional `--reason` appends a structured closure note when the task was active, or repairs a terminal task that is missing its closure note. Echoes the post-close `Done At` stamp on vaults that have the column. `--json` emits `closureNote` and `partialFailure` so scripts can detect a closed task whose audit note failed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lore tasks close-many --ids-from <path\|->`               | Close a newline-delimited explicit ID list from a file or stdin (`-`). Blank lines are ignored and duplicate IDs are de-duplicated in first-seen order. Supports `--state done\|cancelled`, optional `--reason`, and `--json`. JSON includes `attempted`, `closed`, `noop`, and failed `{ id, error }` rows; exits non-zero when any ID fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `lore tasks reconcile`                                     | Scan active tasks for newer memory evidence that suggests they can be closed (`--project`, `--min-score`, `--limit`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lore vault ensure-entities`                               | Create the Entities database on a legacy four-database vault and run additive schema migration so Facts gains `SubjectEntity` / `ObjectEntity` (`--dry-run` previews without writing)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `lore entities merge --from <loser-id> --into <winner-id>` | Preview/apply a duplicate Entity merge. Plan-only by default; `--yes` repoints Facts from loser to winner, appends loser lookup forms to winner aliases, writes a merge note, then archives the loser. Legacy positional ids are still accepted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `lore conflicts scan`                                      | Walk the vault and surface candidate conflict pairs for in-context judgment (`-p`, `-n`, `--raw-limit`, `--include-bodies`, `--json`, `--exhaustive`). Read-only; emits prompt-ready output the calling agent dispatches back via `lore-memory action='compare'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lore debt scan`                                           | Inventory memory debt across the vault: low-trust memories, orphan facts, overdue governance, duplicate clusters, topic sprawl, ownerless rows, scope anomalies (`-p`, `--all-projects`, `-c/--category`, `-n/--limit`, `--per-category-limit`, `--json`). Read-only; emits prioritized markdown / JSON the operator (or agent) acts on. See [`docs/memory-debt.md`](memory-debt.md) for the recommended cadence and remediation table.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `lore debt create-tasks`                                   | Create one `lore-task` per surfaced debt item; defaults to P1/P2 only and a 25-row cap. Flags: `-p`, `--all-projects`, `--priority-floor P1\|P2`, `-n/--limit`, `--dry-run`. Each task carries `Tags: [audit]` plus a `Debt ID: <id>` body line so it's distinguishable from normal triage work.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `lore procedures scan`                                     | Read-only scan for procedure-worthy clusters of resolved episodes (`--project`, `-n`/`--limit`, `--min-score`, `--json`). Surfaces ranked candidate groups of incidents / postmortems / runbooks / closed tasks sharing an entity.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lore procedures propose`                                  | Promote a cluster of resolved episodes into a `kind: procedure, Status: proposed` memory. Requires `--title`, at least one non-blank `--step`, and at least two `--source <memoryId>` entries (matches the scan's `PROCEDURE_MIN_SOURCES` threshold so the propose path cannot bypass the auditable evidence trail). Supports `--entity`, repeated `--activation` / `--failure-mode` / `--supersedes`, `--notes`, `--topic-key`, `--project`. Approval flows through `lore inbox approve <id>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lore procedures deprecate <memoryId>`                     | Mark an accepted procedure as deprecated (status flip; preserves history). Optional `--reason` is appended as a `## Deprecated` audit block on the procedure body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `lore eval run <suite>`                                    | Run an evaluation suite and write a JSON artifact. `--runner retrieval` (default) is fixture-only, no Notion access. `--runner notion --project <SandboxProject>` exercises the live retrieval stack against a sandbox vault (`LORE_EVAL_NOTION_ALLOW_PRODUCTION=1` required for non-sandbox project names). `--runner task` runs an end-to-end task-eval suite via Codex headless (`LORE_EVAL_TASK_REAL=1` required to actually invoke Codex; otherwise the adapter refuses and every trial fails). `--runner profile` runs deterministic profile taxonomy/scorer suites such as `evals/profile-suites/support.yaml`. Common flags: `--trials` (must be `1`), `--out`, `--json`. Retrieval/notion-only flags: `--min-lift`, `--max-harm`, `--baseline <path>` (compares against committed baseline; rejects cross-suite/cross-runner comparisons) — task/profile mode rejects these.                                                                                |
| `lore eval baseline <suite> --out <path>`                  | Capture a comparison-stable baseline snapshot. Accepts the same `--runner` / `--project` flags as `eval run`; baseline files record their suite + runner mode and `eval run --baseline` refuses cross-suite or cross-runner comparisons. Task/profile-mode baselines are rejected because those modes use deterministic verifiers or YAML thresholds instead of baseline comparisons.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `lore promote <memoryId> --to <name>`                      | Copy a memory from the primary vault into a configured promotion target (`promotionTargets` in `.lore.yaml`). The promoted row carries a `## Promoted from <vault>` audit block with source id, source URL, kind/status/confidence, promoter, timestamp, and optional `--reason`. Project relations and tags do NOT cross the vault boundary (taxonomy is vault-local). Status defaults to `proposed` on review-required targets and to the source's status otherwise. Promoter resolves via `LORE_USER_NAME` → `users.me` unless `--promoter <name>` is set. `--dry-run` previews the audit block without writing to or probing the target. Apply is idempotent by target-vault `Promotion Source Key`: rerunning the same source/target reuses the existing row and renders `Outcome: already-promoted`; fresh creates render `Outcome: created`. Skips schema drift checks on init (same posture as `lore mine`); run `lore status` first to confirm target reachability. |
| `lore profile list`                                        | List the active profile alongside every built-in, local, and installed-external profile this config root can resolve. Marks the active profile with `*` and shadowed lower-priority resolutions with `↳`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lore profile show <name[@version]>`                       | Print manifest details for a profile (selector, source, root, manifest digest, schema additions per database, taxonomy counts, prompt keys, available migrations). Bare `<name>` resolves only when exactly one version is discoverable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lore profile validate <path>`                             | Validate a profile bundle root (must contain `profile.yaml`). Exits non-zero with a human-readable error on any violation: reserved `extends`, removed/renamed core properties, reserved predicates, missing prompt files, unsupported additive property types, etc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lore profile preview <name[@version]>`                    | Dry-run resolution: print the effective profile that would resolve for the current config root, including source (local/built-in/installed) and the resolved bundle path. Confirms `extends` is rejected by the validator.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `lore profile install <path\|git-url#sha>`                 | Install a profile bundle into `<configRoot>/.lore/profiles/installed/<name>/<version>/`. Sources: a local filesystem path that points at a profile bundle root, or a git URL pinned to a 40-hex commit SHA. Stages, validates, computes manifest digest, surfaces collisions and shadowing, and writes/updates `profiles.lock.json`. Interactive confirmation by default; `--yes` requires either a matching `profiles.allowedInstallSources` entry or a same-digest lock no-op.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `lore profile set <name@version>`                          | Pin `.lore.yaml profile:` to an exact `<name>@<version>` selector after verifying the profile resolves under built-in, local, or installed-external priorities.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `lore profile migrate <name@version>`                      | Plan or apply a profile migration declared at `<sourceProfileRoot>/migrations/<from>__<to>.yaml`. Dry-run by default. Step kinds supported: `add_property`, `add_select_options`, `add_multi_select_options`, `write_config_profile_pin`, `backfill_empty_property`. Destructive steps are rejected. Apply mode (`--apply`) takes the migration lock, verifies each step post-write, and writes a per-vault ledger under `<configRoot>/.lore/profile-migrations/<safe-profile-name>/`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `lore mcp`                                                 | Start the Lore MCP server over stdio for host assistant integrations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `lore hooks wakeup`                                        | Dispatch the wake-up hook used by supported host assistants on `UserPromptSubmit`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `lore hooks autosave`                                      | Dispatch the Stop-triggered autosave hook from stdin, exiting quietly when there is no transcript content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `lore hooks session-end`                                   | Compatibility shim for stale pre-0.6.0 SessionEnd hook settings; exits successfully without work                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

See [`conflict-detection.md`](conflict-detection.md) for the full conflict scan
workflow.
See [`evals.md`](evals.md) for the eval runner overview and
[`evals-suite-format.md`](evals-suite-format.md) for suite format, metrics, and
artifact details.

## Setup health with `lore doctor`

Run `lore doctor` from a Lore-managed project when MCP startup, auth, vault
access, or hooks fail and it is not obvious which narrower command should run
next. The command is read-only: it reads local config and host files, runs auth
resolution, performs the same vault-page preflight as install/auth, checks that
the required Lore databases are present, and renders recent background hook
failure markers.

The output is grouped as `Config`, `Auth`, `Vault`, `MCP host config`, `Hooks`,
and `Next action`. Blocking setup failures exit non-zero and the final section
prioritizes the first repair step, for example `lore auth --login`,
`lore vault ensure-entities`, or `lore install`. Informational absences, such
as no Cursor config on a project that has not installed Cursor, do not fail the
doctor run.

## Common memory operations

Use the shell commands when a human operator needs to bootstrap or correct vault
knowledge directly:

```sh
lore memory save "PAT auth rollout note" --content "Use per-user PATs for external operators." --project Lore --tags onboarding
lore decision create "Use PATs for external operators" --rationale "PATs carry per-user permissions and rate limits." --affects "Authentication,Lore install"
lore ask Authentication --project Lore --limit 10
```

`--content-file -` and `--rationale-file -` read from stdin, so longer markdown
can be piped in from an editor or generated report. `--json` on all three
commands emits structured output for scripts.

## Backfilling transaction-time fact provenance

`lore migrate --backfill-fact-observed-at` (issue #284) seeds the three
transaction-time columns added to the Facts DB so pre-#284 vaults gain
the bitemporal axis the new `lore-query action='ask'` `asOf` / `includeHistory`
controls depend on.

What the migration writes per row:

- `Observed At = page.created_time` (YYYY-MM-DD) — when `Observed At`
  is empty. Best available proxy for "when Lore learned this fact" on
  rows that pre-date #284. Newly-created rows get the column seeded at
  write time by `FactService.create`; this migration covers history.
- `Invalidated At = Valid Until` — on rows whose `Valid Until` is set
  AND `Invalidated At` is empty. Conservative best-effort fallback for
  pre-#284 invalidations, where the operator didn't separately record
  the transaction-time invalidation date. On the common path
  (`FactService.invalidate` flips both columns today), the two dates
  align by construction.

What the migration does NOT write:

- `Invalidated By` — the relation requires a valid Memories row id,
  and historical invalidations carry no audit trail of which memory
  prompted them. Operators wanting to retro-link provenance run
  `lore-fact action='invalidate'` with an explicit `sourceMemoryId`
  on the specific rows they care about.

Lifecycle: plan-only by default, `--yes` applies. Idempotent per-axis:
re-runs skip rows whose target column is already populated. Project-
scoped via `--project <name>`; vault-wide otherwise. Per-row failures
are isolated and reported in a final summary so the operator can
distinguish transient 429s from schema-mismatch on a specific row.

## Scope and lifetime in `lore status` (issue #283)

`lore status` (and the MCP parallel `lore-context action='status'`)
surfaces three additional triage lines when scope-aware retrieval has
something to clean up. Each line renders only when its memory + fact
counts sum to a non-zero value:

```
Expired scoped rows: 12 (memories: 8, facts: 4) — consider archiving via `lore-memory action='archive'` or `lore-fact action='invalidate'`
Expiring soon (≤7d): 3 (memories: 2, facts: 1)
Narrow-scope rows outside this context: 1 (memories: 1, facts: 0) — rows whose Scope Kind is user/agent/role/session/run/environment and whose Scope Key does not match the resolved scope context
```

The "narrow-scope outside this context" line is the load-bearing
operator signal: it counts rows that _would_ surface for a different
reader (different `LORE_SESSION_ID`, `LORE_AGENT_NAME`, etc.) but
not for the current process. A non-zero value is normal in a
multi-engineer / multi-agent vault — it does not indicate a bug.

A vault that hasn't yet run `lore migrate` to add the issue #283
schema columns prints a single one-line warning at startup
(`[lore] scope/lifetime columns missing on this vault — recall is
using pre-#283 retrieval shape`) and these triage lines render zeros
across the board until the migration lands.
