# Changelog

All notable user-facing changes to Lore are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lore versions
adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries describe behavior an operator or AI assistant can observe — tool
output shape, CLI flags, hook side effects, schema additions. Internal
refactors that leave behavior unchanged are intentionally omitted; the git
log is the canonical source for those.

## [Unreleased]

### Added

- **Archived project migration opt-in.** `lore migrate --project <name>` now
  accepts `--include-archived` for the memory and fact confidence-score
  backfills, allowing intentional maintenance on archived historical
  projects while keeping archived scopes rejected by default. (#337)
- **Explicit archived project listing modes.** `lore-project action='list'`
  now accepts `status: "any"` to include active and archived projects, and
  `lore status projects --archived-only` lists only archived projects. (#337)
- **Local Lore evals can run from the CLI.** `lore eval run <suite>` loads
  versioned YAML suites, runs deterministic retrieval evals against
  fixture-backed services, and writes JSON artifacts without live Notion
  access. (#306)
- **`stale-memory` ablation scenario for the committed eval suite.** The
  `lore-core` retrieval suite now ships three tasks (auth decision,
  test runner, error-handling shape) with paired helpful-memory,
  noisy-memory, and stale-memory fixtures. The fixture runner enforces
  status-aware retrieval as the contract: rows whose `status` is
  `superseded`, `deprecated`, or `rejected` are dropped from
  `searchFixtureMemories` and `memories.list`, so a stale-memory task's
  `shouldNotSurface` lists the actual stale id and the assertion fires
  if a future change drops the filter. The Notion-backed runner can
  still report `memoryHarm > 0` against the same suite — that gap is
  the temporal-recall work tracked under #284. (#450)
- **Self-service Entities bootstrap for legacy vaults.** A new vault repair
  command creates the Entities database on four-database vaults and runs
  additive schema migration so Facts gains the `SubjectEntity` /
  `ObjectEntity` relation columns. Run it as `lore vault ensure-entities`
  before `lore migrate --build-entities --yes`. (#336)
- **Vault topology is now visible in status output.** `lore status` and
  `lore-context action='status'` report vault topology health for operator
  checks, and the public package exports the status types for callers that
  consume Lore as a library. (#308, #322)
- **Wake-up coverage debug output reaches hooks and MCP.** `LORE_DEBUG=1`
  hook wake-up logs and `lore-context action='wake-up'` with `debug: true`
  expose privacy-conscious coverage counters: ranked/default/error mode,
  digest freshness/age, rendered section counts, `reason=no-ranked-search` for
  the unranked path, and explicit `already-ranked-for-session` /
  `load-failed` variants. Counts reflect rendered rows after topical collapse
  and task bucketing without logging query text, titles, facts, or page bodies.
  (#307, #416, #429, #436)
- **Background hook failures appear in status.** `lore status` and
  `lore-context action='status'` now surface recent autosave and digest failure
  markers with context, log paths, structured MCP JSON, and recovery hints.
  (#300, #334)
- **Committed config has a pre-commit secret guard.** The installed Git hook
  blocks staged `.lore.yaml` additions that contain `auth.token` or personal
  Notion page IDs while still allowing the repository's shared vault locator.
  (#445)

### Changed

- **Fact creation now requires usable provenance.** MCP
  `lore-fact action='create'` calls now hard-error before Entity or Fact writes
  unless they pass an explicit live, project-compatible Memories-row
  `sourceMemoryId` or a compatible same-process `agent`+`session` auto-link.
  This flips the previous warning-and-write behavior into an agent-observable
  hard error for all MCP consumers, including out-of-tree integrations. (#296)
- **Explicit fact sources are validated before writes.** Explicit
  `sourceMemoryId` fact creates now perform one additional Notion property read
  to verify that the source resolves to a live Memories row whose project scope
  is compatible with the fact. Session auto-link remains a process-local
  optimization that trusts the in-process write order and tracker metadata.
  (#296)
- **Memory property reads now require live Memories rows.**
  `MemoryService.getPropertiesById` and `getManyById` now drop archived pages
  and pages outside the configured Memories database/data source. This makes
  provenance validation consistent with the intended memory-read contract and
  means read-path callers no longer refresh decay metadata for archived or
  cross-database source rows. (#296)
- **Breaking project-scope contract: explicit project scope now fails closed.**
  MCP tools and CLI commands that accept `projectName`, `projectNames`, or
  `--project` now reject typo'd, archived, inaccessible, or ambiguous project
  names before scoped reads or writes run. Omit the project field intentionally
  to use auto-detected scope. (#301)
- **Breaking vault-shape contract: Entities is now required.** Vault
  verification now requires the five-database schema
  Projects/Topics/Memories/Entities/Facts, `LoreServices.entities` is
  non-null, and schema drift always checks the Entities database plus
  the Facts `SubjectEntity` / `ObjectEntity` relation columns. Legacy
  four-database vaults fail fast with manual repair guidance instead of
  falling back to no-Entities compatibility. Row-level `SubjectKey`
  fallback remains for Fact rows whose entity relations have not been
  backfilled yet. (#272, #302)
- **Autosave learning dedup reuses exact-project matches across sessions.**
  Hook-spawned autosave learning extraction now reuses an existing likely
  conversation note when the duplicate is scoped to the same resolved project,
  falls back to same-session dedup for auto-resolved catch-all scope, includes
  legacy unscoped duplicate learnings at the core write boundary, serializes the
  probe/write window with a project-scoped local lock, reuses marker-backed
  duplicates when coordination succeeds, warns when lock/marker coordination
  degrades, and reports when the MCP memory save path reused an existing
  learning. Set
  `LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1` to recover the previous
  create-every-time behavior. (#305, #323, #335, #352)
- **Lore vault config can be committed intentionally.** `.lore.yaml` is no
  longer ignored by default so private deployments can carry shared,
  credential-free vault config in git when that is intentional. (#268)
- **Unscoped topic updates warn when they are skipped.** MCP memory, decision,
  and task write paths that include topic fields without a resolvable target
  now return a structured warning and still skip the topic update instead of
  failing or silently dropping it. (#291, #326)
- **Archived projects are excluded from default resolution.** Project lookup by
  path or name now ignores archived Notion rows, so scripted callers no longer
  resolve to retired project scopes. (#292)
- **`lore mine` includes Dockerfile-style filenames.** Mine file selection now
  matches `Dockerfile` and related Dockerfile name variants, changing which
  files are eligible for indexing. (#293)
- **`lore mine` preserves Markdown fences in mined content.** Mined Markdown
  output chooses wrapper fence lengths so inner fenced blocks remain intact.
  (#294)
- **Rich-text metadata limits are enforced in every write path.** MCP schemas
  and core memory, decision, task, and topic-key write services now validate
  Notion-sized metadata before reads or writes, and known cap errors render
  from structured issue fields. (#295, #333, #434, #439)
- **MCP date fields can be cleared consistently.** Date-typed memory update
  fields, decision review dates, fact review dates, and task due dates now
  accept `null` or the MCP-friendly empty-string clear sentinel where an
  existing Notion date can be cleared, while create-only date fields still
  reject empty clears. Tool descriptions document the keep-vs-clear behavior.
  (#297, #330, #421, #438)
- **CLI numeric flags parse strictly.** `lore search --limit`,
  `lore tasks reconcile --limit`, and `lore tasks reconcile --min-score` now
  reject malformed, fractional, signed, out-of-range, or exponent/coerced
  values instead of accepting partial parses. (#298, #328)
- **Author identity resolution is lazy, write-scoped, and auth-scoped.**
  Read-only CLI invocations and startup paths no longer call `users.me` solely
  to resolve attribution; in-flight lookups are shared only for the same active
  token/base URL snapshot and stale settled snapshots are evicted. (#299, #331)
- **MCP memory tool instructions stay under the config budget.** The
  `lore-memory` MCP tool description is shorter while preserving the author
  field contract, reducing agent-visible tool-config pressure. (#303)
- **Wake-up coverage counters now surface in status.** `lore status` and
  `lore-context action='status'` print the same content-free coverage line
  shape as the hook debug log, so operators and MCP-driven agents can inspect
  retrieval coverage without waiting for a live hook fire. (#436)
- **Project listing defaults to active projects.** `ProjectService.list()`,
  `lore-project action='list'`, and `lore status projects` now return active
  projects by default. Use `status: "archived"` / `--archived-only` for
  archived-only output or `status: "any"` / `--all` to include archived rows.
  (#337)
- **Archived explicit project scopes get specific diagnostics.** CLI and MCP
  read surfaces that accept explicit project names now route through the
  shared project-scope resolver, so names that resolve only to archived rows
  report that archived state instead of a generic not-found message. (#337)
- **Codex wake-up is query-aware and debounced by attempt.** Codex hook installs
  now use `UserPromptSubmit`, parse the prompt-bearing event shape via
  `LORE_WAKEUP_EVENT`, rank wake-up context against the submitted prompt, and
  create an atomic per-session attempt marker before Notion initialization so
  slash-first prompts, transient load failures, and concurrent prompt hooks do
  not run wake-up repeatedly. (#304, #332)

### Fixed

- **Author identity cache handles concurrent auth rotation.** Lazy
  `users.me` lookups now keep in-flight entries long enough for callers under
  the same auth snapshot to share one request, even when another token/base URL
  starts resolving concurrently. Settled stale snapshots are still evicted so
  attribution does not leak across auth changes. (#331)
- **`resetIdentityCache()` keeps its no-arg compatibility.** External callers
  can continue calling the exported reset helper without passing a resolver;
  the no-arg form clears all resolver-owned identity caches in the process.
  (#331)
- **Autosave learning reuse now applies at the core write boundary.** Likely
  conversation-note autosaves reuse same-session, cross-session, and legacy
  unscoped duplicate learnings through `MemoryService`, fail closed when the
  blocking duplicate probe cannot read Notion, and surface explicit
  `cross-session` / `unknown-session` reuse labels in MCP output. (#324)
- **Codex wake-up debounce now records attempts atomically.** The
  `UserPromptSubmit` marker is created before Notion initialization, applies to
  slash-command first prompts and transient wake-up load failures, honors
  `hooks.wakeUp: false` before touching marker state, and uses atomic
  create-if-absent so concurrent prompt hooks do not both run wake-up. (#310,
  #332)
- **Lore config rejects unsafe committed values before Notion calls.**
  Config parsing warns on `auth.token`, rejects token-shaped values such as
  `ntn_`, `secret_`, and `Bearer secret_`, rejects starter-style `<...>` page
  IDs in local, upstream, and promotion vault config, and keeps the committed
  shared vault locator credential-free. (#327, #408, #418, #444)
- **Project-scoped migrations require an explicit scope decision.**
  Project-capable data migrations now reject missing, archived, inaccessible,
  ambiguous, or transiently unreadable project names unless the operator passes
  a valid `--project` or an intentional `--allow-unscoped`. (#356)
- **Migration lock reclaim is serialized.** Concurrent migration runs can no
  longer both acquire the same stale lock during reclaim. (#444)
- **Partial-vault detection now sees renamed Lore databases.** Vault
  verification falls back to schema fingerprints when expected child
  database titles are missing, preventing `lore init` from duplicating a
  page where an existing Lore database was renamed. (#336)
- **MCP startup diagnostics cover missing-Entities vaults.** MCP startup
  still registers diagnostic tools when strict service init fails on a
  partial vault and points operators at `lore vault ensure-entities`. (#336)
- **Missing-database errors redact long vault page IDs by default.** Set
  `LORE_DEBUG=1` to include the full page ID in local diagnostic output. (#336)

## [0.11.0] - 2026-05-03

The 0.11.0 train packages the post-ntn dogfood hardening work: per-user
attribution, safer write/idempotency paths, broader task/query coverage,
first-class entity merge, and Notion request-rate protection. This release also
publishes the 0.10.1 MCP startup-diagnostic work that had landed on `main` but
had not been cut as a GitHub Package release.

### Added

- **Per-user attribution on every Memory write
  (DEFERRED-ATTRIBUTION).** The `Author` Memories column finally
  carries engineer identity now that ntn-issued tokens make it
  reliably resolvable. New `src/auth/identity.ts` lazily resolves the
  display name only when a write omits an explicit `author`, using
  `LORE_USER_NAME` env override (synchronous, wins over `users.me`) →
  bot owner user-name fallback. `lore-memory action='save'`,
  `lore-decision action='create'`, and `lore-task action='create'`
  default `author` from the resolved identity when the caller
  omits it; an explicit `author` argument always wins. The
  topic-key upsert path's append-revision branch also stamps
  `author` (REPLACE-on-every-save, mirroring Title / Synopsis /
  Keywords / Source) so legacy unattributed rows pick up an
  author when the next revision lands. The Stop hook's autosave
  prompt-builder injects an `Author: <name>` line alongside the
  existing `Agent: <name>` line and instructs the spawned
  `claude -p` to pass `author:` verbatim. `lore install`'s MCP
  config and `spawnBackgroundSave` both forward `LORE_USER_NAME`
  to the spawned child's env so explicit overrides survive the
  hop. Memory listings (`lore-query action='recall'` / `'search'`,
  `lore-context action='wake-up'`) surface attribution as
  `by <name>` between tags and the revision marker on the meta
  line; rows without an attributed author render byte-identically
  to pre-DEFERRED-ATTRIBUTION output.

  **Operational note:** read-only startup and one-shot CLI invocations do
  not call `users.me` for attribution. The resolver is per-process memoized by
  active token/base URL and pays the Notion round-trip on the first
  unattributed write only. Operators on slow networks who want the synchronous
  path export `LORE_USER_NAME` in shell rc; failures collapse to
  `{ author: null }` and never block writes. This supersedes the original
  0.11.0 startup-cost note that every Lore process startup paid one
  `users.me` call unless `LORE_USER_NAME` was set. (#299, #331)

- **Dynamic Fact confidence mirror.** Facts now carry a mirrored numeric
  confidence score derived from the source Memory's system-managed
  `Confidence Score`, with a migration path for existing vaults. Query,
  context, and decision-graph surfaces can display the trust signal without
  needing to dereference the source Memory every time. (#186)
- **First-class entity merge with fact repointing.** `lore entities merge`
  and the underlying `EntityService` can collapse duplicate canonical handles,
  repoint affected facts, and preserve project scope through the merge. (#258)
- **Bounded conflict-scan continuation.** `lore conflicts scan` gains raw-limit
  control so large vaults can resume lexical candidate discovery beyond the
  prior fixed candidate cap. (#252)
- **Configurable background agent command.** Hook-spawned background work can
  use a configured command, enabling Codex installs and other clients whose
  autosave worker is not launched via the default `claude` binary. (#211)
- **MCP startup diagnostics.** Interactive MCP initialization failures now
  register diagnostic stubs for the seven `lore-*` dispatchers instead of
  disconnecting immediately; background-agent MCP children still fail fast via
  `LORE_BACKGROUND_AGENT=true`. (#230)
- **Overdue tasks in query audit.** `lore-query action='audit'` now includes
  overdue task coverage so agent wakeups and audits surface more actionable
  follow-up work. (#231)

### Changed

- **Notion client request throttling and 429 backoff.** Outbound Notion calls
  now pass through a token bucket and bounded retry path, reducing accidental
  rate-limit collisions now that internal rollout is exercising more real
  traffic. (#213)
- **Search and wake-up coverage widen under caps.** Semantic memory search
  paginates before applying client-side filters, wake-up task loading balances
  due-dated and undated task coverage, and `knowledgeFactLimit: 0` is honored as
  an explicit "load no facts" setting. (#208, #255, #202)
- **Task list totals are exact when possible.** `lore-task action='list'`
  labels totals as exact or lower-bound and only prefixes bucket totals with
  `>=` when the fetched window saturated. (#226)
- **Trust indicators reach the remaining list surfaces.** Decision and task
  list renderers now include the same confidence/trust signal already used by
  the memory-oriented surfaces. (#185)
- **Client integration configs are tracked in-repo.** `.mcp.json`,
  `.cursor/mcp.json`, `.codex/config.toml`, and `.codex/hooks.json` are now
  committed examples of the supported local-client wiring. (#250)
- **Documentation was split into focused guides.** README content was
  streamlined, with detailed CLI, MCP, hook, conflict-detection, dependency,
  host, and rollout material moved into `docs/`. (#225, #234, #261)
- **Notion `User-Agent` header bumps to `lore/0.11.0`.** Notion logs
  `User-Agent` on every API call; the bump keeps Notion-side analytics
  attribution honest for the post-dogfood hardening train.

### Fixed

- **Write paths now report partial failures.** Memory, decision, task, and
  update flows surface structured partial-failure errors when a multi-step
  write succeeds in Notion but a follow-up write fails. (#206, #229, #224,
  #251)
- **Retry/idempotency hardening.** Topic-key upserts, compare verdict dispatch,
  autosave atomic-learning deduplication, and concurrent `lore mine` file
  memory creation now avoid duplicate rows or duplicate revision blocks when
  callers retry. (#260, #259, #256, #253)
- **Archived rows are filtered consistently.** Memory list/search, query,
  overdue, decision, task, knowledge, context, and live-page surfaces now avoid
  returning archived Notion rows. (#203, #233)
- **Pagination gaps closed.** Vault database verification and relation-property
  reads now paginate instead of silently dropping data beyond Notion's first
  response page. (#248, #254)
- **Entity and fact edge cases are safer.** Fact dedup no longer shortens review
  dates, entity relation backfills happen on dedup hits, auto-created entities
  preserve project scope, and apply-mode entity migrations are lock-protected.
  (#201, #204, #205, #257)
- **Hook and auth robustness.** Background hook workers forward canonical auth
  env, sanitize session-derived state paths, and clean up prompt temp files on
  preparation failures. ntn auth can re-resolve after mid-session 401s. (#212,
  #207, #210, #232)
- **Legacy OAuth and CLI input fixes.** The legacy OAuth callback path validates
  more aggressively and threads the configured client id into the authorization
  URL; `lore mine` now honors `--pattern` and validates `--limit`. (#249, #227,
  #209)

## [0.10.0] - 2026-05-01

The 0.10.0 train ships ntn-First Auth: per-engineer Notion bearer
tokens issued by Notion's internal `ntn` CLI replace the shared
`LORE_NOTION_TOKEN` deployment, eliminating the per-token rate-limit
collision N humans on one ~3-rps bucket caused. Three workstreams:
ntn integration (Workstream A), operator UX (Workstream B), and
documentation (Workstream C). Internal-rollout-only — the OAuth + PKCE
broker work originally scoped here is parked at
`Lore-Issues/oauth-pkce-epic/` for a future external-rollout release.
The four version literals move atomically per the release-coordinator
pattern (#10).

### Added

#### Workstream A — ntn integration

- **`resolveAuth` rewrites with a four-source priority order.** The
  first available source wins: `NOTION_API_TOKEN` env (canonical) >
  ntn-resolved (`~/.config/notion/auth.json`) > `LORE_NOTION_TOKEN`
  env (soft-deprecated) > `auth.token` in `.lore.yaml` (soft-
  deprecated). The pre-0.10.0 `ResolvedAuth` discriminated-union from
  the parked OAuth epic collapses to a flat shape with a `source`
  field — every source produces a static bearer token; no refresh
  capability under ntn. Soft-deprecated paths emit a debounced one-
  time-per-session warning to stderr; `LORE_SUPPRESS_DEPRECATIONS=1`
  silences. (Issue 0.10.0/01.)
- **New `src/auth/ntn.ts` module.** Covers (a) `auth.json` reading +
  workspace selection via `NOTION_WORKSPACE_ID` env / `auth.workspaceId`
  config / single-workspace auto-pick; (b) interactive `ntn login`
  shell-out via `runNtnLogin()` with stdio inheritance and
  `NOTION_KEYRING=0` forced inside the spawn so engineers don't need
  the env var in shell rc; (c) auto-install via `installNtn()` invoking
  `curl -fsSL https://ntn.dev | bash` with operator confirmation
  (`--yes` skips); (d) version detection via `getNtnVersion` /
  `checkNtnVersion` against `MIN_NTN_VERSION` (currently `0.12.0`).
  Below-minimum versions emit a non-blocking warning; Lore prefers
  existing operator versions and never auto-upgrades. (Issue
  0.10.0/02.)
- **New `verifyVaultAccess(client, pageId)` preflight.** Auth-mode-
  agnostic helper ported from the parked OAuth epic. Runs against
  `pages.retrieve` and surfaces `not-found` / `unauthorized` /
  `forbidden` cleanly so operators see "wrong workspace" / "page not
  shared with the engineer in this workspace" before downstream
  commands fail. Used by `lore auth --status`, `--login`, `--migrate`,
  and `lore init <page-id>`. Under ntn-first auth, tokens inherit the
  engineer's personal Notion permissions; there is no separate "share
  with Notion Workers CLI integration" step. (Issue 0.10.0/03.)

#### Workstream B — Operator UX

- **`lore auth` rewritten for the ntn-first model.** `--login` is the
  recommended entry point: probes prerequisites, auto-installs ntn if
  missing (with confirmation), runs `runNtnLogin()` with
  `NOTION_KEYRING=0` forced, then runs `verifyVaultAccess` post-flow.
  `--status` reports ntn install state, active workspace, token source,
  deprecation state of legacy paths, and runs `verifyVaultAccess`
  against the configured vault page. `--whoami` reads identity via
  `users.me`. `--logout` is informational and points at `ntn logout`
  since Lore does not manage ntn's storage. `-y, --yes` skips
  confirmation prompts on `--login` / `--migrate` for non-interactive
  automation. (Issue 0.10.0/06.)
- **New `lore auth --migrate`.** Walks operators with `LORE_NOTION_TOKEN`
  set through ntn setup. Shells out to `ntn login` directly via
  `runNtnLogin()` (no press-Enter pause), runs double-preflight (legacy
  token reaches vault → ntn-issued token reaches the same vault) before
  printing unset instructions with shell-rc location detection (zsh /
  bash / fish). (Issue 0.10.0/07.)
- **`lore install` adds ntn detection and rewrites MCP env-forwarding.**
  Three new prerequisite probes: `isNtnInstalled`, ntn version check,
  auth-resolution. Offers auto-install via `installNtn()` when ntn is
  missing and auto-login via `runNtnLogin()` when auth resolves empty
  — both honor `--yes` for non-interactive contexts. The MCP-entry
  env-forwarding shifts from a static forwarded `LORE_NOTION_TOKEN` to
  `LORE_CONFIG_ROOT` so the spawned MCP server resolves auth.json on
  its own at startup; `LORE_SUPPRESS_DEPRECATIONS=1` is always added
  to the MCP env to silence per-session warnings from spawned children.
  Conditional `LORE_NOTION_TOKEN` forwarding is preserved when the
  legacy env var is set in the install-time environment so legacy
  operators don't lose access by upgrading. `services.ts:initServices`
  honors `LORE_CONFIG_ROOT` env so MCP children resolve the right
  `.lore.yaml` without re-walking the filesystem. (Issue 0.10.0/08.)
- **New `lore init` no-arg form.** Runs against the resolved ntn token;
  offers auto-install + `runNtnLogin()` if no auth resolves; creates a
  workspace-level vault page via
  `pages.create({ parent: { type: "workspace", workspace: true } })`
  (per Notion's Create-a-page reference, "available only for bots of
  public connections" — which ntn-issued tokens qualify as); runs
  preflight; initializes databases; writes `.lore.yaml` with
  `auth.workspaceId` populated when the resolved auth carries a
  workspace id. The existing `lore init <page-id>` form for already-
  created vault pages remains, with a new preflight gate. (Issue
  0.10.0/09.)

#### Workstream C — Documentation

- **New top-level `Authentication` section in root `AGENTS.md`.**
  Covers the four auth sources, the per-token Notion rate-limit rule
  (confirmed with the public-connections team 2026-05-01), the
  `auth.json` direct-read coupling as a temporary bridge pending
  `ntn auth token --plain` (DEFERRED-OFFICIAL-EXPORT), the Lore-managed
  `NOTION_KEYRING=0` posture (forced inside Lore's ntn spawns, not a
  shell-rc prerequisite), and the version-compatibility policy.
  (Issue 0.10.0/04.)
- **New internal-team rollout runbook at `docs/internal-rollout.md`.**
  Documents per-engineer onboarding, the auto-install path
  (`curl -fsSL https://ntn.dev | bash`), the version policy,
  `lore auth --migrate` walkthrough, dogfood criteria, and the asks-
  list to the `ntn` CLI team for the official `ntn auth token --plain`
  command. (Issue 0.10.0/05.)

### Changed

- **`.lore.yaml` config schema gains `auth.workspaceId`
  (string, optional).** Pins which workspace the ntn-token resolver
  picks from `auth.json` when multiple are present. Falls back to the
  `NOTION_WORKSPACE_ID` env var, then to single-workspace auto-pick.
  Documented in `.lore.example.yaml` alongside the four-source priority
  chain.
- **Notion `User-Agent` header bumps to `lore/0.10.0`.** Notion logs
  `User-Agent` on every API call; the bump keeps Notion-side analytics
  attribution honest. No drift detection migration: 0.10.0 does not add
  any Notion DB columns — `lore migrate` against a 0.9.x vault is a
  no-op.

### Deprecated

- **`LORE_NOTION_TOKEN` env var.** Soft-deprecated; still works in 0.10.x
  but emits a debounced one-time-per-session warning to stderr.
  `lore auth --migrate` walks operators through upgrading. Hard removal
  is plausibly 0.11.0 or 1.0.0, contingent on telemetry showing no
  internal team still relies on the env path. Not 0.10.0.
- **`auth.token` in `.lore.yaml`.** Same posture as `LORE_NOTION_TOKEN`
  — soft-deprecated, same debounced warning, same migration path.

### Notes

- **OAuth + PKCE / broker work parked.** The OAuth+PKCE epic originally
  scoped as 0.10.0 stays parked at `Lore-Issues/oauth-pkce-epic/` for a
  future external-rollout release; the release coordinator does not
  update or close the parked epic.
- **DEFERRED-OFFICIAL-EXPORT timeline open.** The ask to the `ntn` CLI
  team for an official `ntn auth token --plain` (or equivalent) command
  has no commitment. If they ship within 0.10.x, Lore lands a 0.10.1
  patch swapping the auth.json reader for the official command.
- **Internal-only rollout.** The 0.10.0 dogfood window is multi-team
  internal — the ntn CLI is not externally available, so external users
  remain on the legacy paths until the eventual external-rollout
  release.

## [0.9.0] - 2026-05-01

The 0.9.0 train ships four engram-borrow workstreams: lexical-conflict
detection with agent-judged verdicts (Workstream A), topic-key upsert
for evolving memories (Workstream B), background-autosave atomic-
learning extraction (Workstream C), and broader multi-agent reach
(Workstream D). Operating-contract documentation in `CLAUDE.md` is
updated alongside the runtime changes (#04). The four version literals
move atomically per the release-coordinator pattern (#13).

### Added

#### Workstream A — Lexical-conflict detection with agent-judged verdicts

- **Two new Memories columns: `Compared With` (single_property
  self-relation) and `Compare Notes` (rich_text).** `Compared With`
  symmetrically tracks every pair the agent has judged so the
  candidate generator can skip already-resolved pairs without a
  second round trip. `Compare Notes` records the verdict + reasoning
  in NDJSON form for audit trails, chunked under Notion's per-block
  rich-text cap. (Issue 0.9.0/02.)
- **New `lore-memory action='compare'` verdict-recording dispatcher.**
  Accepts six frozen verdicts — `conflicts_with`, `supersedes`,
  `scoped`, `related`, `compatible`, `not_conflict` — over an unordered
  memory pair. Asymmetric verdicts (`conflicts_with`, `supersedes`)
  require an explicit `affectedMemoryId` to name the side that
  loses confidence. Pair-scoped idempotency is enforced via a
  `Compare Notes` membership check, not via global fact existence —
  re-issuing the same verdict against the same pair short-circuits to
  `alreadyJudged: true` with no writes. Actionable verdicts dispatch
  through the compare dispatch helpers for `conflicts_with` and
  `supersedes` so confidence-decrement algebra and decision-status
  flips remain in one place. (Issue 0.9.0/05.)
- **New `lore conflicts scan` CLI for on-demand candidate detection.**
  Lexical-candidate generator surfaces memory pairs that share enough
  signal to warrant comparison. Output includes a self-describing
  `compareContract` JSON block naming the verdict vocabulary so an
  agent receiving the candidates can pick a verdict without
  out-of-band schema knowledge. (Issue 0.9.0/03 + 0.9.0/09.)

#### Workstream B — Topic-key upsert for evolving memories

- **Two new Memories columns: `Topic Key` (rich_text) and
  `Revision Count` (number).** `Topic Key` is a stable kebab-case
  identifier (`decision/jwt-auth-model`, `runbook/database-migration`)
  that lets evolving memories upsert under one row. `Revision Count`
  tracks how many times the upsert chain has appended. Both columns
  ship in the fresh-vault config and the legacy two-arg overload so
  drift detection on a vault upgraded from <0.9.0 surfaces them by
  name. (Issue 0.9.0/01.)
- **`lore-memory action='save'` upserts on `Topic Key` + project-set
  equality.** A second save with the same key and identical project
  relation set appends a `## Revision N (date)` block to the existing
  page body and increments `Revision Count`, instead of creating a
  fresh row. Structural invariants (kind, status, topic relation) are
  validated BEFORE the body write — `kind` cannot change across
  upsert calls; `status` and topic-relation are silently preserved.
  Topic keys are rejected on `kind: 'note'` and `kind: 'task'`.
  (Issue 0.9.0/06.)
- **New `lore-memory action='suggest-topic-key'` heuristic helper.**
  Returns a stable kebab-case key derived from the title's noun
  phrase plus the kind family (`decision/`, `runbook/`, `incident/`,
  `postmortem/`, `policy/`). Grounded in the actual `MemoryKind`
  taxonomy — returns `null` for `note` and `task`. (Issue 0.9.0/07.)
- **Revision-count rendering on `lore-query action='recall'` /
  `'search'` and `lore-context action='wake-up'` listings.** A new
  meta-line component below the synopsis shows `[topic-key, revN]`
  when present. Renders independently of the 0.8.0/09 trust line so
  the two annotations stay distinct. (Issue 0.9.0/10.)
- **`lore-memory action='update'` accepts `topicKey` for re-keying.**
  An agent that picked the wrong topic key on first save can now
  switch to the canonical key without abandoning the row. The kebab-
  case format is identical to the (forthcoming) save-time `topicKey`
  parameter. The handler preflights the re-key (collision check
  against the current project-set, non-empty `projectIds`) before
  applying any other content delta, so the most common failure modes
  fail fast without leaving a half-persisted update. When the new
  key matches the existing one, the response surfaces a
  `Topic key unchanged: '<key>' (no-op).` line — the call is
  acknowledged rather than silently dropped. A combined
  `topicKey + kind` call is rejected at the handler boundary
  before any Notion read because the upsert chain is per-kind.
  Re-keying appends a `## Re-keyed (YYYY-MM-DD)` audit block to
  the body (deliberately distinct from the upsert path's
  `## Revision N (date)` prefix) and writes only the `Topic Key`
  column — `Revision Count` and `Last Referenced At` are
  intentionally untouched because re-keying is identity surgery,
  not content evolution. (Issue 0.9.0/14.)

- **New `MemoryService.validateRekey` public method.** Non-mutating
  preflight that loads the memory, checks empty `projectIds`, and
  runs the collision query against the current project-set.
  Returns `{memory, oldTopicKey, willRekey}` (with `willRekey: false`
  signaling the no-op short-circuit case). Throws the same
  collision and empty-projectIds errors the authoritative
  `rekeyTopicKey` raises, so direct callers can fail fast without
  duplicating validation logic. The MCP `handleUpdate` consumes it
  to gate combined `topicKey + content` updates.

- **New error subclasses exported from `src/core/memory.ts`:**
  - `RekeyAuditError` — raised by `MemoryService.rekeyTopicKey`
    when the Topic Key property write succeeded but the body
    audit-block append failed. Carries `memoryId`, `oldTopicKey`,
    `newTopicKey`, and `cause`. The re-key persisted; only the
    audit trail is missing. A retry short-circuits via the no-op
    guard because the property already matches the new key.
  - `PartialUpdateError` — raised by the MCP `handleUpdate` when
    a combined `topicKey + content` call has the content delta
    persist successfully but the subsequent re-key reject (race
    with another agent grabbing the slot, transient Notion
    failure, or post-update `projectIds` change exposing a fresh
    collision). Carries `memoryId`, `contentApplied: true`, and
    `rekeyError`. The content mutation is durable on Notion; the
    re-key did not happen.

  Both are `instanceof`-checkable for future operator tooling.
  `RekeyAuditError` propagates unchanged from the combined-update
  catch path so its accurate "rekey persisted, audit missing"
  message isn't shadowed by `PartialUpdateError`'s "rekey did
  not happen" wording.

- **Promotion-advisory footer on upsert responses.** When an upsert
  pushes the row past a revision-count or body-length threshold, the
  response appends an advisory line nudging the agent to consider
  promoting the synthesis into a formal `lore-decision action='create'`.
  Decision-kind chains include `supersedesIds` referencing the upserted
  decision memory; non-decision chains deliberately omit `supersedesIds`
  because decision creation resolves those ids through `DecisionService.getById`.
  No auto-promotion fires — the advisory is informational only and emits
  exclusively on the upsert path, not on the create path or the re-key path.
  (Issue 0.9.0/15.)

#### Workstream C — Background-autosave learning extraction

- **Stop-triggered background autosave extracts atomic learnings
  alongside the session synopsis.** The detached `claude -p`
  sub-agent prompt is extended to identify single-fact discoveries —
  things that would help a future session — and save each as its
  own memory. A per-spawn cap protects against runaway noise on
  long sessions, and a kill switch (`LORE_DISABLE_LEARNING_EXTRACTION=1`
  or `hooks.learningExtraction: false` in `.lore.yaml`) reverts the
  autosave to its 0.8.x synopsis-only shape. No foreground convention
  — extraction is deliberately invisible to the agent. (Issue
  0.9.0/08.)

#### Workstream D — Multi-agent reach

- **`lore install --client cursor`** writes a Cursor-compatible MCP
  config. The default lands at `<projectDir>/.cursor/mcp.json`
  (project-scoped); `--cursor-global` opts into `~/.cursor/mcp.json`.
  (Issue 0.9.0/11.)
- **`lore install --print-config <json|toml>`** prints the config
  payload to stdout instead of writing it to disk. Output is byte-
  identical to what `--client claude` (json) and `--client codex`
  (toml) would persist, so hosts not directly supported can copy-
  paste the result into their own config files. (Issue 0.9.0/12.)

#### Operating contract

- **CLAUDE.md updated.** The conflict-verdict vocabulary, topic-key
  guidance, and invisible learning-extraction posture are documented
  alongside the runtime changes so agents reading project context
  pick up the new surfaces without spelunking through PR history.
  (Issue 0.9.0/04.)

### Changed

- **`.lore.yaml` config schema gains `hooks.learningExtraction`
  (boolean, default `true`).** Surfaced as a commented-out default
  in fresh `lore init` output and documented in `.lore.example.yaml`.
  (Issue 0.9.0/08.)

### Fixed

- **`lore-memory` (and every MCP tool that accepts `topicName`) no
  longer silently fans out near-duplicate topic pages.** Previously,
  `TopicService.getOrCreate` only checked for _exact-name_ matches,
  so an agent that drifted casing, pluralization, `&` vs `and`, or
  punctuation across saves accumulated sibling topic rows — the
  issue #109 Mail-vault audit found four such siblings produced in
  a single session. The slow path (no exact match) now normalizes
  the input (lowercase, NFC, HTML-decode, plural-strip, `&`↔`and`,
  and punctuation-strip), scans every topic in the resolved projects,
  and silently extends any row whose stored name shares the
  normalized key (`Eval & Testing` and `Evals & Testing` collapse
  onto the oldest row). Names that survive normalization but score
  ≥ 0.85 trigram-Jaccard against a project sibling raise a
  `SimilarTopicError` listing the candidates; agents can either
  pick an existing name or pass `forceNewTopic: true` to create a
  fresh row.
- **New CLI flag: `lore migrate --merge-similar-topics`.** Plan-then-
  execute migration that collapses normalized-equivalent topic groups
  on legacy vaults — the cleanup pass for drift that
  `getOrCreate` now prevents at write time. Bare invocation prints
  the plan grouped by canonical destination; re-run with `--yes` to
  archive sibling rows and re-point their memories onto the
  canonical. Idempotent.

## [0.6.0]

### Fixed

- **`lore-query action='audit'` now returns the complete set of overdue
  facts and decisions on large vaults.** Previously,
  `FactService.queryOverdue` and `DecisionService.queryOverdue` issued a
  single un-paginated
  `dataSources.query`, so Notion's default 100-row page silently capped
  the result set. Both methods now paginate to exhaustion and accept an
  optional `limit`. Because both queries sort `Review By asc`, the rows
  that were previously dropped are the _least_ overdue tail (and
  no-review-date rows) — the most-overdue head was always returned. On
  vaults with more than 100 overdue rows, expect
  `lore-query action='audit'` to surface rows it previously did not; the
  newly-visible rows are the ones with the latest `Review By` dates (or no
  date at all). See
  [PR #96](https://github.com/makenotion/lore/pull/96) for the underlying
  fix.

## [0.5.1]

### Added

- **`lore status` tracking-predicate preflight.** When the vault still
  carries facts whose Notion `Predicate` select value is one of the
  legacy tracking predicates (`needs_action`, `waiting_on`,
  `blocked_by`), `lore status` now prints a warning at the top of its
  output naming the count and recommending
  `lore migrate --migrate-tracking-to-tasks --yes` as remediation.
  When the count is zero the warning is suppressed and status output
  is byte-identical to the previous behavior. The preflight is
  informational — `lore status` does not refuse to run on non-zero
  count, so operators can still diagnose other vault state. This
  ships ahead of the 0.6.0 deprecation purge so an operator on the
  old line sees the warning while
  `lore migrate --migrate-tracking-to-tasks` still works; on 0.6.0
  the prose updates to reflect the migration command's removal.

[Unreleased]: https://github.com/makenotion/lore/compare/v0.11.0...HEAD
[0.11.0]: https://github.com/makenotion/lore/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/makenotion/lore/compare/v0.9.0...v0.10.0
[0.9.0]: https://github.com/makenotion/lore/compare/v0.6.0...v0.9.0
[0.6.0]: https://github.com/makenotion/lore/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/makenotion/lore/releases/tag/v0.5.1
