# CLI Command Contracts

This guide holds developer-facing contracts for CLI commands whose behavior is
easy to break while refactoring. It complements the user-facing
[`cli.md`](cli.md) reference and the shared authoring rules in
[`cli-authoring.md`](cli-authoring.md).

## Cross-Command Rules

- User-facing command inventory lives in [`cli.md`](cli.md). Registered command
  inventory lives in [`src/cli/index.ts`](../src/cli/index.ts). Update both
  when adding, removing, or renaming a command.
- Explicit project scope is fatal-strict. If a command accepts
  `--project <name>` and the name does not resolve, exit non-zero with an
  actionable message instead of falling back to auto-detected or vault-wide
  scope.
- Plan/apply migrations default to plan mode unless the flag's contract says
  otherwise. `--dry-run` always wins over apply mode.
- JSON-capable commands write parseable results to stdout and progress or
  diagnostics to stderr.
- No command should silently widen the user's requested scope after a parse,
  profile, auth, or project-resolution failure.

## The `auth` Command

`lore auth --login` is the recommended interactive re-authentication entry
point. It auto-installs `ntn` if needed, shells out to `ntn login` with
`NOTION_KEYRING=0` forced inside the spawn, and runs vault access preflight
after login. New operators usually hit this flow through `lore install`; direct
use is for re-authentication and setup repair.

Other subcommands:

- `--status` reports `ntn` install state, active workspace, token source, and
  vault access. It performs a Notion round-trip and intentionally bypasses
  `initServices()` so it can diagnose auth before the full service graph loads.
- `--whoami` resolves the active token, calls `users.me`, and prints the bot
  identity. Use it to confirm the token belongs to the expected workspace.
- `--logout` directs operators to `ntn logout`. Lore does not own `ntn` token
  storage and should not pretend it can revoke that token itself.

`-y, --yes` skips confirmation prompts on `--login` for non-interactive
automation. `loadNtnToken` in [`src/auth/ntn.ts`](../src/auth/ntn.ts) reads
`~/.config/notion/auth.json`; workspace selection respects
`NOTION_WORKSPACE_ID` or `auth.workspaceId` in `.lore.yaml` when `auth.json`
contains multiple workspaces.

The root [`AGENTS.md`](../AGENTS.md) Authentication section and
[`authentication.md`](authentication.md) define the source priority chain.

## The `migrate` Command

`lore migrate` handles additive schema repair and one-shot data migrations. It
must stay idempotent: a second run on an up-to-date vault should report no
writes for the selected operation.

Default schema migration:

- Detects missing properties on live data sources and patches them with
  `dataSources.update`.
- Detects missing select and multi-select options while preserving live option
  IDs so Notion does not duplicate options.
- Performs additive changes only; property renames or removals are breaking and
  require an explicit architectural decision.

Legacy tag upgrade:

- `--upgrade-decision-tags` finds memories tagged `decision`, upgrades them to
  `Kind: decision`, and strips the legacy tag.
- The flag auto-runs schema migration first so users do not need to remember
  ordering.
- `--dry-run --upgrade-decision-tags` shows schema drift but does not apply the
  tag upgrade; the tag upgrade is opt-in apply behavior.

Agent identity normalization:

- `--normalize-agents` scans non-archived memories and collapses known
  Lore-produced Claude variants onto the canonical `"Claude Code"` string.
- Explicit third-party names such as `Codex`, `Cline`, and `Cursor` pass
  through unchanged so explicit attribution stays authoritative.
- Bare invocation prints the plan grouped by canonical destination; `--yes`
  applies it.
- The write-time canonicalizer in
  [`src/hooks/agent-identity.ts`](../src/hooks/agent-identity.ts) owns the
  variant table. Add to it only when a new default-detection variant appears in
  saved rows.

Synopsis backfill:

- `--backfill-synopses` targets non-archived memories whose `Synopsis` property
  is empty.
- Plan mode reports candidates. `--yes` applies. `--dry-run` wins over apply
  mode.
- `--synopsis-backend claude` fetches page markdown with `pages.retrieveMarkdown`,
  synthesizes a short synopsis, sanitizes it, and writes the `Synopsis`
  rich-text property. PATH preflight for `claude` runs only on the apply path so
  operators without `claude` can still inspect candidate counts.
- Body fetch, synthesis, sanitize, and write failures continue to the next row
  and log to stderr with row id, phase, and error. The failed row's Synopsis
  stays empty so a later run can target it again.
- `--synopsis-backend placeholder` writes the
  `SYNOPSIS_PLACEHOLDER_SENTINEL` value directly, skips body fetches, and leaves
  typed body-fetch counters at `0`. The display layer renders those counters as
  not applicable for the placeholder backend.
- Placeholder writes are one-way for discovery: once the sentinel lands, the
  empty-Synopsis filter excludes the row until an operator explicitly clears the
  property.
- Discovery filters on empty Synopsis, so any successful write drops the row
  out of later runs. Failed writes leave the row eligible for retry. Notion page
  updates are per-request atomic, so a write that does not land leaves the row in
  the last observed state.

Confidence-score backfill:

- `--build-confidence-scores` seeds null numeric `Confidence Score` values from
  categorical `Confidence`, writes `Last Referenced At = created_time`, and
  applies any decay accrued since creation.
- Without the migration, older rows with null numeric confidence bypass
  score-based ordering, trust indicators, and stale-confidence surfacing until a
  read path touches them.
- Rows with a non-null numeric score are skipped.
- `--project <name>` scopes the migration to one active project. Archived
  projects require `--include-archived`. Unknown names abort before planning.
- Bare `--yes` must not be treated as consent to mutate every null-scored row
  when a project-specific migration was intended.
- Writes dispatch in batches sized to `notion.rateLimit.concurrency`. Rate-limit
  middleware gates concurrency; it is not a retry layer. A surfaced 429 aborts
  the run, and reruns finish remaining null-scored rows.
- `Last Referenced At = created_time` is an algebra anchor, not proof the memory
  was read at creation. Later read touches keep their newer date because the
  migration skips rows that already have a numeric score.
- Plan output surfaces the most-decayed candidate titles so operators can
  sanity-check before applying. Apply mode prints progress periodically to
  stderr.
- Pure planning and scoring live in
  [`src/core/confidence-migration.ts`](../src/core/confidence-migration.ts);
  service-boundary I/O lives on memory-service helpers.
- The categorical `certain` default can overstate old rows that were never
  explicitly graded. Operators who care should re-grade targeted rows via
  `lore-memory action='update'` before or after the migration.

Entity and fact repair flags:

- `--build-entities` and `lore vault ensure-entities` support legacy
  four-database vault migration. Preserve the creation order
  `Projects -> Topics -> Memories -> Entities -> Facts`.
- Fact readers must tolerate rows with populated entity relations and rows that
  still require the SubjectKey substring fallback.
- `--report-orphan-rate` pairs with entity builds to report orphan metrics; it
  is a reporting surface, not permission to perform unrelated writes.
- Encoding repair and topic merge flags are one-shot maintenance operations.
  Keep their plan/apply posture explicit and idempotent.

## The `digest` Command

`lore digest` gathers recent project activity and spawns a background
synthesizer that saves a distilled `source: digest` memory back to the vault.
The digest is what `lore-context action='wake-up'` surfaces in its fast path, so
the output goal is signal density: non-obvious findings, decisions, active
tasks, and emerging themes rather than a chronological session log.

Contracts:

- Data gathering is shared with `lore-context action='digest'` through
  [`src/core/digest.ts`](../src/core/digest.ts).
- The synthesizer prompt lives in
  [`src/hooks/prompts.ts`](../src/hooks/prompts.ts) and uses the same
  untrusted-content framing as background autosave.
- Background spawn reuses
  [`spawnBackgroundSave`](../src/hooks/background.ts) with `logLabel: "digest"`
  so stderr attribution stays distinct.
- `--dry-run` prints gathered markdown and skips the spawn.
- When no memories fall in the selected window, the command exits early without
  spawning.
- `--since YYYY-MM-DD` and optional `--until` widen the window for projects
  whose weekly auto-digest would otherwise stay quiet.
- Manual CLI runs touch the same per-project marker file used by the Stop-hook
  auto path so a manual digest debounces the next automatic run.

## The `status` Command

`lore status` prints vault metadata, active profile, database counts, active
projects, task and confidence summaries, proposed-memory review counts, wake-up
coverage, digest/drift watermarks, topology health, and recent background
failures where configured.

Task summary:

- `taskStats` and `formatTaskSummary` live in
  [`src/core/task.ts`](../src/core/task.ts) so CLI and MCP status surfaces share
  the same line shape.
- Active tasks render as
  `Tasks: N active (overdue: M, stale ≥30d: K, in-progress: P, blocked: Q)`.
  Zero buckets collapse off; `active === 0` still renders `Tasks: 0 active`.
- Vaults with `Done At` also render a closed-last-30-days line. Vaults without
  that column silently omit it.

Memory confidence:

- `MemoryService.confidenceStats` walks non-archived memories in the selected
  project scope and aggregates total, scored, average score, and below-threshold
  counts.
- The CLI fans confidence stats out alongside tasks and wake-up coverage so
  orchestration wall-clock is bounded by the slowest probe, not their sum.
- `formatConfidenceSummary` suppresses the line when there are no memories,
  drops parentheses when no rows are scored, and omits `0 below threshold`.
- The prefix is `Memory confidence:` to avoid collision with the database-count
  `Memories:` line. Database counts include archived rows; confidence stats
  exclude them and may legitimately differ.

Proposed-memory inbox count:

- `MemoryService.countProposed` queries `Status = proposed AND Kind != decision`
  and aggregates total plus source and agent buckets.
- `Kind != decision` is load-bearing because `proposed` is also a valid
  decision lifecycle state.
- The shared proposed-memory filter lives in the core memory layer; default
  recall exclusion, wake-up surfacing, status counts, CLI review, and MCP review
  actions must compose the same predicate rather than re-deriving it.
- `formatProposedInboxStatus` returns no lines for `total === 0`; an empty
  inbox is silent in `lore status`.
- Prefix inflects as `Proposed memory:` for one and `Proposed memories:` for
  more than one.
- Rendered examples:

  ```text
  Proposed memory: 1 pending review
  Proposed memories: 12 pending review (sources: conversation 8, manual 4 · agents: Claude Code 9, Codex 3)
  ```

- Single-bucket source or agent clusters collapse off; bucket ordering is
  deterministic by descending count, then ascending key.
- Missing Source and Agent values render as `"unknown"` for status aggregation
  rather than pretending the row was saved manually.
- Approval and rejection record reviewer plus timestamp in a `## Reviewed` audit
  block on the memory body. Status count and review operations are separate
  read/write surfaces over the same proposed-memory lifecycle.

Wake-up coverage:

- `lore status` calls `loadWakeUpData` with `includeMemoryContent: false` and
  `includeCoverage: true`.
- The section must not leak titles, fact text, query text, or page bodies.

Failure posture:

- The status probes use `Promise.all`, not `allSettled`. A broken vault or
  Notion outage should fail loudly instead of presenting partial status as if
  missing sections were empty.
- This mirrors the search-path rule that a fully broken subsystem must not look
  like an empty result set.

Digest and drift watermarks:

- Digest status performs one bounded memories query for `source: digest` and
  filesystem `stat` calls for per-project markers.
- The digest section reports the latest existing digest memory, marker age, and
  estimated time until the next automatic digest. It also shows when auto-digest
  is disabled by environment or config.
- The digest section suppresses itself when there are no configured
  sub-projects.
- Drift status wording says "next fire on next debounced session" because drift
  can run from any debounced caller, not only Stop hooks.
- `lore status` itself touches the drift marker before loading drift status, so
  the rendered section reflects what later debounced callers will see.
- If there is no configured `.lore.yaml` root, drift status returns no lines and
  the section is suppressed.

## The `install` Command

`lore install` writes assistant integration configuration and performs auth and
vault preflight checks before writing host files.

Persona routing:

- Default `lore install` is PAT-first. It expects `NOTION_API_TOKEN` to contain
  a Personal Access Token from `notion.so/developers/tokens` and skips `ntn`
  install and version probes.
- `--ntn` opts into the internal-engineer path: auto-install `ntn` if missing
  and run `ntn login`.
- `--dev` composes with both personas. Under `--ntn`, it forwards
  `NOTION_ENV=dev` into the `ntn login` spawn. Under the PAT path, it plants a
  literal `NOTION_BASE_URL=https://api-dev.notion.com` static env entry into the
  spawned MCP environment.
- When neither `--ntn` nor `NOTION_API_TOKEN` is set but `ntn` is already
  installed, prerequisite checks may use the ntn path for backward
  compatibility. Auto-install only happens when `--ntn` is explicit.
- When neither flag nor PAT is set and `ntn` is not installed, print both
  persona paths and bail without writing config.

Auth and MCP environment:

- `preflightAndReport` routes recovery copy by auth source. PAT failures get
  PAT-specific guidance, including the difference between PAT and integration
  token shapes. `ntn` failures keep `ntn login` recovery.
- MCP children resolve auth at startup through `resolveAuth`; installers should
  not statically forward resolved bearer tokens for ntn-source operators.
- Static env entries from `buildMcpEnv()` include
  `LORE_SUPPRESS_DEPRECATIONS=1` and `LORE_CONFIG_ROOT` only for host shapes
  that may launch from an unpredictable cwd.
- Runtime forwarded env names come from
  [`src/auth/forwarded-env.ts`](../src/auth/forwarded-env.ts). Static entries
  are assembled by `buildMcpEnv()` in
  [`src/cli/commands/install.ts`](../src/cli/commands/install.ts).
- Project-scoped Yarn/PnP snippets for Claude, Codex, Cursor, and
  `--print-config --yarn-pnp` intentionally omit `LORE_CONFIG_ROOT` and rely on
  launch from the workspace root.
- Install refuses to write MCP config when vault access preflight returns
  not-found.

Assistant targets:

- Default `lore install` updates Claude Code, Codex, and Cursor for the current
  project.
- `--client claude` updates only Claude Code hooks and `.mcp.json`.
- `--client codex` updates only `.codex/config.toml` and `.codex/hooks.json`.
- `--client cursor` updates project `.cursor/mcp.json` or global
  `~/.cursor/mcp.json` with `--cursor-global`.
- Codex hooks require `features.hooks = true` and trusted projects.
- Cursor receives only an MCP entry because its runtime does not support the
  Stop/session-end hooks used by Claude Code and Codex.
- Under `--client all`, each assistant installer runs independently. The CLI
  exits non-zero with per-client failure summaries if any branch fails. Set
  `LORE_INSTALL_DEBUG=1` for stack traces.
- Default Claude and Codex installs use bin dispatch (`lore hooks ...`, or
  `yarn run -T lore hooks ...` under Yarn PnP) and do not require checked-in
  shell wrappers.

Cursor global precedence:

- `--cursor-global` overrides `--project` only for the Cursor branch.
- Under `--client all`, Claude and Codex still write project-scoped config.
- Under `--client claude` or `--client codex`, `--cursor-global` is ignored
  with a one-line stderr note and no exit-code change.

Print-config:

- `--print-config json|toml` emits paste-ready MCP config to stdout and writes
  no files.
- `--client` is accepted as a no-op. `--project` selects the config root
  embedded as `LORE_CONFIG_ROOT` for bare and legacy printed snippets.
- `--yarn-pnp` printed snippets omit static `LORE_CONFIG_ROOT` and assume the
  unsupported host launches from the workspace root.
- JSON output reuses `buildClaudeMcpEntry`; TOML output reuses
  `buildCodexMcpSection`. For the same project and Yarn/PnP shape, printed
  snippets must stay byte-identical to supported host writes.
- Preserve the byte-identity tests when changing config builder helpers. Drift
  between printed snippets and on-disk host config silently breaks unsupported
  host operators.
- The runtime path validates that `dist/mcp.js` exists and exits 1 with the
  standard build-first message if not.
- The command performs best-effort auth resolution for placeholder suppression,
  but the snippet itself must remain clean stdout for pipes such as `jq`.
- Hooks are not part of `--print-config`; unsupported hosts get MCP tools only.

Agent identity:

- Hook helpers derive the `Agent:` field through
  [`deriveAgentName`](../src/hooks/helpers.ts).
- Codex hook commands are prefixed with `LORE_AGENT_NAME=Codex` because Codex
  has no built-in runtime marker equivalent to Claude Code's environment.
- Third-party integrations should follow the same explicit
  `LORE_AGENT_NAME=<Name>` convention. Explicit override wins over inferred
  detection.
- Codex hook commands are POSIX shell strings. The reinstall detector recognizes
  uppercase env assignment prefixes followed by the script path:

  ```sh
  VAR=VALUE [VAR=VALUE ...] /path/to/script.sh
  ```

- Env keys must be uppercase. Values must be unquoted single tokens. Multiple
  env prefixes are allowed. Do not wrap the command in `sh -c`.
- A hook that does not match the detector's env-prefix-plus-script pattern is
  classified stale and replaced on reinstall.
- Build direct `.codex/hooks.json` entries with the same shape as
  `buildCodexHookCommand`: env prefix, then `JSON.stringify(absolutePath)` for
  the script path.
- The prefix shape targets POSIX shells on macOS and Linux.

## The `conflicts` Command

`lore conflicts scan` walks the vault, runs lexical candidate generation per
project, filters out pairs already judged via `Compared With`, and emits
prompt-ready material for the current agent to judge with
`lore-memory action='compare'`.

The CLI does not call an LLM and does not call the compare tool. It is a
structured scan surface, not a judging subprocess.

Pipeline:

```text
list -> generate -> dedup -> filter -> sort -> truncate -> render
```

Filtering before truncation is load-bearing: `--limit` budgets the useful
candidate set, not raw lexical pairs.

Cap knobs:

- `--raw-limit` controls coverage. It is passed to `findConflictCandidates` as
  `pairLimit` per project and bounds candidate accumulation. Similarity
  computation is still O(N^2); bounded top-K accumulation prevents candidate
  object blow-up.
- `--exhaustive` lifts the raw limit by passing
  `Number.POSITIVE_INFINITY` as the pair limit. If combined with `--raw-limit`,
  exhaustive wins and the CLI emits a stderr note.
- `--limit` controls rendered prompt budget after deduplication, already-judged
  filtering, and sorting.
- Passing `--limit` to candidate generation would pre-truncate before dedup and
  filtering, yielding fewer useful rendered pairs than requested even when more
  candidates exist.

Bounded coverage:

- A project can have unjudged pairs ranked beyond the current `--raw-limit`.
  After all pairs in the bounded window are judged, a run can return zero pairs
  even though deeper candidates remain.
- The no-results message distinguishes cap-hit bounded scans from true
  exhaustion and points operators at a larger `--raw-limit`.
- `--exhaustive` can allocate and compute against a very large O(N^2) pair set;
  keep it explicit.

Output shapes:

- Markdown output is prompt-ready for an interactive agent session. It names the
  verdict vocabulary and points to [`memory-workflows.md`](memory-workflows.md)
  for definitions.
- JSON output carries a top-level `compareContract` block with asymmetric and
  symmetric verdict rules so a programmatic consumer can produce correctly
  shaped compare calls.
- Progress routes to stderr so `--json` remains pipe-clean.
- The implementation injects a log sink instead of writing directly to process
  globals so tests can capture progress without mutating the process.

`MemoryService.listForScan`:

- Uses strict project scoping with `Project relation contains <id>` rather than
  `projectOrUnscopedFilter`.
- Paginates at page size 100 until `has_more === false`.
- Fetches page bodies only when `includeBodies` is set.
- Filters archived rows client-side because Notion's archived flag is page
  metadata rather than a database property.

## The `inbox` Command

`lore inbox` is the operator-facing surface for proposed-memory review.

Subcommands:

- `inbox list [--project <name>] [-n <limit>]` lists memories with
  `Status = proposed`. Empty inbox prints a single line and exits 0.
- `inbox approve <memoryId> [--reason <text>]` promotes a row to
  `Status: accepted` and records `verdict: "approve"`.
- `inbox reject <memoryId> [--reason <text>]` sets `Status: rejected`.
- `inbox archive <memoryId>` soft-deletes through `MemoryService.archive`.

Reviewer identity resolves through `services.identity.resolveAuthor()`, using
the same `LORE_USER_NAME -> users.me` chain as memory writes. An unresolvable
identity fails with exit 1 rather than writing an audit row attributed to an
unknown reviewer.

The `## Reviewed (YYYY-MM-DD)` audit block is appended after the property write.
Property-first / audit-second ordering means a partial audit append failure
leaves the structural status flip in place. Shared error types let callers
distinguish non-proposed rows from audit-write failures.

The MCP parallel surface is `lore-memory action='approve'` and
`lore-memory action='reject'`; keep the handler shape and service path aligned.

## The `mine` Command

`lore mine` walks a directory tree, filters mineable text files, and creates or
updates one `source: "file"` memory per file.

Discovery:

- Skips local tooling and generated directories such as `node_modules`, `dist`,
  `build`, `.git`, `.next`, and `__pycache__`.
- Skips local config and lockfiles such as `.lore.yaml`, `package-lock.json`,
  `yarn.lock`, and `pnpm-lock.yaml`.
- Indexes recognized text extensions plus explicit basenames such as
  `Dockerfile` and `Containerfile`.
- Enforces a 100KB max file size and a default 50-file run limit.
- Wraps content in a markdown code block with the file extension as language.
- Creates memories with source `"file"` and keywords shaped as
  `"<extension> mined <relPath>"`; tags remain empty because file extensions are
  free-form tokens, not closed-vocabulary tags.
- Supports `--dry-run` to preview files without writing memories.

Pattern and limit validation:

- `--pattern <glob>` filters before the `--limit` slice, so the limit applies to
  matching files.
- `globToRegExp` supports `**` only when surrounded by path boundaries, `*`,
  `?`, and POSIX-style character classes. Brace expansion is intentionally not
  supported.
- Mid-segment `**` collapses to single-`*` semantics so it does not silently
  match across path boundaries. Raw `/` inside a character class is stripped so
  a class cannot match the path separator. Brace literals are escaped through.
- Path matching is case-sensitive. Extension filtering is case-insensitive.
- `--limit` validates as a strict positive integer and rejects zero, negatives,
  decimals, signed values, exponent notation, mixed strings, empty string, and
  values past `Number.MAX_SAFE_INTEGER`.

Project resolution:

- `resolveMineProject` runs before file walking or upsert work.
- An explicit unknown `--project` throws. This prevents typos from producing
  unscoped file memories that collide with other projects.

Idempotency:

- Repeated runs do not accumulate duplicates. The upsert key is
  `(title, source, projectIds)`.
- `findExistingFileMemory` performs a bounded memory search by relPath and
  post-filters candidates by `source === "file"`, exact expected title, and
  exact project-id set equality.
- Source filtering rejects user-curated memories that merely mention the same
  relPath. Exact title matching rejects substring collisions such as
  `src/foo.ts` and `src/foo.ts.bak`.
- Project-set equality is load-bearing: unscoped rows do not match project
  rows, and `[A]` does not match `[A, B]`.
- The existing-row search limit is the Notion single-query maximum of 100 so a
  busy vault is less likely to page the relevant file row out of the candidate
  window.

Topic preservation:

- The upsert path passes `topicId` to `MemoryService.update` only when a current
  `--topic` resolves.
- Re-mining without `--topic` preserves the row's existing Topic relation.

Failure isolation and concurrency:

- `runMineUpsert` chunks files into batches sized to
  `config.notion.rateLimit.concurrency`.
- Each batch dispatches with `Promise.all`.
- Per-file failures resolve as `kind: "failed"` outcomes; one read or Notion
  failure does not abort the batch.

Concurrent runs:

- Parallel `lore mine` runs against the same vault, project, and file serialize
  through a per-file lock around the `findExistingFileMemory -> create-or-update`
  critical section.
- Fresh creates hold the lock through a short stabilization delay so Notion's
  eventually consistent search index can see the row before the next miner
  probes.

Output:

- `formatMineSummary` preserves the legacy `Indexed N files.` and
  `Done. Indexed N/M files (K failed).` shapes.
- `(N new, M updated)` is appended only when at least one update landed.

## The `tasks` Command

`lore tasks` is the CLI surface for task lifecycle operations.

Contracts:

- `tasks create` writes a task with explicit title and optional project,
  description, entity, initial state, blocker label, due date, topic, tags,
  keywords, synopsis, pointer-subject override, and JSON output.
- `tasks update` changes mutable metadata without implying completion.
- `tasks close` records closure state and `Done At` when the vault has that
  column. Close reasons should preserve the distinction between completed,
  cancelled, duplicate, and obsolete work.
- `tasks close-many` is a batch operation; preserve per-row reporting so partial
  failures are visible.
- `tasks list` is a read surface. JSON output must remain pipe-clean.
- `tasks reconcile` scans active tasks for memory evidence that suggests they
  can close; it should not silently close work without the explicit close path.
- Project filters use the same fatal-strict project resolution rule as other
  scoped commands.

## The `eval` Command

`lore eval` runs local evaluation surfaces. See [`evals.md`](evals.md),
[`evals-suite-format.md`](evals-suite-format.md), and
[`evals-longmemeval.md`](evals-longmemeval.md) for full runner contracts.

Contracts:

- `eval run <suite>` defaults to the fixture-only retrieval runner and writes a
  JSON artifact.
- The Notion runner requires an explicit sandbox project unless
  `LORE_EVAL_NOTION_ALLOW_PRODUCTION=1` allows a non-sandbox name.
- Task evals require `LORE_EVAL_TASK_REAL=1` before invoking Codex headless;
  without it, the adapter refuses to run real trials.
- Profile evals run deterministic profile taxonomy and scorer suites.
- `--trials` must remain `1`.
- Baseline comparison must reject cross-suite and cross-runner comparisons.
- `eval baseline` captures comparison-stable baselines for compatible runners.
  Task and profile baselines are rejected because those modes use deterministic
  verifiers or YAML thresholds.
- `eval vaults` and `eval bench` are operator surfaces for live-vault and
  benchmark workflows; keep their token, network, and fixture needs documented
  in the eval docs and CI guide.

## The `profile` Command

`lore profile` owns profile distribution. See [`profiles.md`](profiles.md) for
resolution priority, install collision handling, allow-list behavior, and the
migration DSL.

Contracts:

- `profile list` prints the active profile and every built-in, local, and
  installed-external profile visible to the config root. Mark the active profile
  and shadowed lower-priority resolutions distinctly.
- `profile show <name[@version]>` prints manifest details. Bare names resolve
  only when exactly one version is discoverable.
- `profile validate <path>` exits non-zero with human-readable errors for
  reserved `extends`, removed or renamed core properties, reserved predicates,
  missing prompt files, or unsupported additive property types.
- `profile preview <name[@version]>` performs dry-run resolution and prints the
  effective profile and source bundle path.
- `profile install <path|git-url#sha>` stages, validates, computes manifest
  digest, surfaces collisions and shadowing, and writes or updates
  `profiles.lock.json`. Git installs must be pinned to a full commit SHA.
- `profile set <name@version>` pins `.lore.yaml profile:` only after verifying
  the selector resolves.
- `profile migrate <name@version>` is dry-run by default. Apply mode takes the
  migration lock, verifies every step post-write, and writes a per-vault ledger.
  Destructive migration steps are rejected.

## Other Command Surfaces

- `doctor` is a read-only setup diagnostic across config, auth, vault access,
  host MCP config, hooks, and next action. It should use narrow probes and must
  not mutate vault or host configuration.
- `memory`, `decision`, and `ask` mirror MCP write/query behavior for manual
  shell use. Keep body-source exclusivity, closed-vocabulary tag validation, and
  JSON output contracts aligned with [`memory-workflows.md`](memory-workflows.md).
- `pinned list` is read-only in the CLI; pin, unpin, and update operations live
  on the `lore-pinned` MCP tool surface.
- `debt scan` and `debt create-tasks` follow the audit categories, score rules,
  task creation cap, and idempotency contract in [`memory-debt.md`](memory-debt.md).
- `procedures scan/propose/deprecate` promote durable procedures through the
  proposed-memory review workflow; approval still routes through
  `lore inbox approve <id>`.
- `entities merge` plans by default, then repoints fact relations, preserves
  aliases, writes a merge note, and archives the loser only with `--yes`.
- `vault ensure-entities` is the legacy four-database cutover helper; it should
  stay additive and dry-run-capable.
- `promote` copies a memory into a configured promotion target and is not
  idempotent; rerunning duplicates by design.
- `mcp` starts the stdio server and should stay a thin entry point.
- `hooks` dispatches host-assistant hook events. Hook behavior is documented in
  [`hooks.md`](hooks.md), [`hooks-autosave.md`](hooks-autosave.md),
  [`hooks-wakeup.md`](hooks-wakeup.md), and [`hooks-background.md`](hooks-background.md).
