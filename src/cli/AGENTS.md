# AGENTS.md -- src/cli/

> Read the root `AGENTS.md` first. This file covers the CLI layer only.

## Purpose

This directory implements Lore's command-line interface using commander.js.
The CLI is the secondary interface for direct human interaction (setup,
debugging, manual search).

## Files

| File                    | Responsibility                                                                                                                                                              |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`              | CLI entry point: creates the `lore` program, registers commands                                                                                                             |
| `commands/init.ts`      | `lore init [page-id]` -- create a workspace-level vault or initialize databases under an existing Notion page                                                               |
| `commands/auth.ts`      | `lore auth` -- check/display authentication status                                                                                                                          |
| `commands/search.ts`    | `lore search <query>` -- semantic search across memories                                                                                                                    |
| `commands/mine.ts`      | `lore mine [path]` -- index project files as memories                                                                                                                       |
| `commands/status.ts`    | `lore status` -- vault status + subcommands (projects, topics)                                                                                                              |
| `commands/install.ts`   | `lore install` -- install Lore assistant hooks and MCP config into a project (Claude Code + Codex + Cursor by default; opt in to one with `--client claude\|codex\|cursor`) |
| `commands/migrate.ts`   | `lore migrate` -- add missing schema properties to vault data sources                                                                                                       |
| `commands/digest.ts`    | `lore digest` -- gather digest data + spawn background synthesizer                                                                                                          |
| `commands/tasks.ts`     | `lore tasks` -- task lifecycle subcommands (currently: `reconcile`)                                                                                                         |
| `commands/conflicts.ts` | `lore conflicts` -- conflict-detection workflow (currently: `scan`)                                                                                                         |
| `commands/entities.ts`  | `lore entities` -- entity registry subcommands (currently: `merge`)                                                                                                         |
| `commands/vault.ts`     | `lore vault` -- vault maintenance subcommands (currently: `ensure-entities`)                                                                                                |
| `commands/mcp.ts`       | `lore mcp` -- start the MCP stdio server for host assistant integrations                                                                                                    |
| `commands/hooks.ts`     | `lore hooks` -- dispatch host-assistant hook events (`wakeup`, `autosave`, `session-end`)                                                                                   |

## Commander Patterns

Each command file exports a `Command` instance:

```typescript
import { Command } from "commander"

export const fooCommand = new Command("foo")
  .description("What this command does")
  .argument("<required-arg>", "Argument description")
  .option("-f, --flag <value>", "Option description")
  .action(async (arg: string, opts: { flag?: string }) => {
    try {
      const services = await initServices()
      // ... command logic ...
    } catch (err) {
      console.error("Foo failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })
```

Commands are added to the program in `index.ts`:

```typescript
program.addCommand(fooCommand)
```

## Service Initialization

All commands that interact with the vault call `initServices()` from
`src/services.ts`. This loads config, creates the Notion client, verifies the
vault, and resolves the current project context.

**Exception**: The `auth` command does not call `initServices()` because it
only checks whether the token is available, without connecting to Notion.
**Updated for 0.10.0**: `auth --status`, `auth --whoami`, and
`auth --migrate` _do_ connect to Notion (for vault preflight, identity
lookup, and migration verification, respectively), but they construct
their own client directly rather than going through `initServices`.
`--status` runs `verifyVaultAccess` by default — operators run it rarely
and the round-trip is acceptable for the diagnostic value; a future
`--no-verify` opt-out is plausible if telemetry shows real friction.

**Exception**: The `init` command creates its own client and `VaultManager`
directly because it runs before a `.lore.yaml` exists.

## Error Handling

Every command action is wrapped in try/catch:

```typescript
try {
  // ... command logic ...
} catch (err) {
  console.error("Command failed:", err instanceof Error ? err.message : err)
  process.exit(1)
}
```

**Rules**:

- Log errors with `console.error`, not `console.log`.
- Exit with code 1 on failure.
- Extract the `.message` from Error instances for clean output.
- Parse raw CLI flags inside the action's `try` block before calling
  `initServices()`. Parser helpers should return `CliParseResult<T>` from
  `src/cli/parse.ts`; on `ok: false`, log the command-specific failure prefix
  (for example, `Search failed: ...`) and exit with code 1 before any service
  initialization.
- Treat explicit project-scope misses as fatal. If a command accepts
  `--project <name>` and the name cannot be resolved, log an actionable
  error and exit with code 1 instead of falling back to auto-detected or
  vault-wide scope. Use `formatUnresolvedProjectScopeError()` from
  `src/core/project-scope.ts` so CLI wording stays aligned with MCP.
- Non-fatal warnings use `console.warn` and continue execution only when the
  requested operation can still proceed without changing the user's explicit
  scope.

## Output Formatting

- Use `console.log` for all normal output.
- Keep output human-readable and scannable.
- Use indentation with two spaces for nested information.
- Use `"-".repeat(40)` or similar separators for visual structure (see `status.ts`).
- Memory search results show: title, tags, source, date, ID, and a 120-character
  content preview.

### OSC 8 hyperlinks

Memory titles and project names rendered by `lore search` and `lore status`
flow through `terminalLink` in `output.ts`, which wraps them in OSC 8 escape
sequences pointing at the page's Notion URL. The helper falls back to plain
text on non-TTY stdout, when `NO_COLOR` or `LORE_NO_HYPERLINKS` is set, or
when the URL fails the Notion safelist. Page IDs stay plain text — operators
copy them into other tools.

`maybeTerminalLink` is the pure helper (takes injected `{ isTTY, env }` so
tests don't mutate process globals); `terminalLink` is the production wrapper
that binds those values from the live process. Build link targets via
`notionPageUrl(id)` rather than constructing the `https://notion.so/<id>`
string inline — every call site routes through that single helper.

Subcommand listings (`lore status projects`, `lore status topics`) stay
plain to keep names selectable for copy-paste; only the top-level `lore
status` and `lore search` surfaces wrap titles. `lore mine` has nothing
title-shaped to link.

## Command Overview

The canonical command overview table lives in
[`../../docs/cli.md`](../../docs/cli.md). Keep this subsystem guide focused on
CLI implementation conventions and per-command gotchas; when adding, removing,
or changing registered commands in `src/cli/index.ts`, update `docs/cli.md` in
the same patch.

## The auth Command

`lore auth --login` is the recommended entry point for authentication
under 0.10.0. It auto-installs ntn (if missing), shells out to `ntn
login` with `NOTION_KEYRING=0` forced inside the spawn (so the token
lands in `~/.config/notion/auth.json` where Lore can read it), and
runs `verifyVaultAccess` post-flow. Operators who want to re-auth
without re-installing run `lore auth --login` directly; new operators
typically hit it via `lore install`'s prerequisites flow rather than
calling it explicitly.

The other subcommands:

- `--status` reports ntn install state, active workspace, token
  source (`NOTION_API_TOKEN` / ntn-resolved / `LORE_NOTION_TOKEN` /
  `auth.token`), deprecation state of legacy paths, AND runs
  `verifyVaultAccess` against the configured vault page. The
  preflight is a Notion round-trip — that's why `--status`
  bypasses `initServices` and constructs its own client. A future
  `--no-verify` opt-out is plausible if operators report friction;
  not in 0.10.0.
- `--whoami` resolves the token, calls `users.me`, and prints the
  bot identity. Useful for confirming the engineer is authenticated
  against the expected workspace.
- `--logout` directs operators at `ntn logout` (Lore doesn't manage
  ntn's storage; printing the right command is more useful than
  pretending Lore can revoke the token).
- `--migrate` walks operators with `LORE_NOTION_TOKEN` set through
  running `ntn login`, verifies the new token reaches the same
  vault, and prints the unset instruction with shell-rc location
  detection.

`-y, --yes` skips confirmation prompts on `--login` /
`--migrate` so non-interactive automation can pass through. The
`auth.json` read happens in `loadNtnToken` from
`src/auth/ntn.ts`; the workspace selection respects
`NOTION_WORKSPACE_ID` env or `auth.workspaceId` in `.lore.yaml`
when an operator's `auth.json` carries multiple workspaces. See
the root `AGENTS.md` **Authentication** section for the full
priority chain, and the [internal-rollout runbook](../../docs/internal-rollout.md)
for the operator-facing onboarding flow.

## The migrate Command

`migrate` handles two additive operations:

1. **Schema additions (default)**: Detects missing properties on each live data
   source and patches them via `dataSources.update`. Also detects missing
   select options on existing select/multi_select properties (preserving live
   option IDs so Notion doesn't duplicate). Idempotent — re-runs on an
   up-to-date vault issue zero writes.

2. **Legacy tag upgrade (`--upgrade-decision-tags`)**: Finds memories tagged
   `decision` (the pre-`Kind`-column convention) and upgrades them to
   `Kind: decision`, stripping the tag. Auto-runs schema migration first —
   users never have to remember the ordering.

Combining `--dry-run --upgrade-decision-tags` shows schema drift but does not
apply the tag upgrade (tag upgrade has no dry-run mode — it's opt-in by
design).

### Agent identity normalization (`--normalize-agents`)

PF3-02. Scans every non-archived memory's `Agent` field and collapses
the seven Claude variants observed in the production Mail vault audit
(`Claude Code`, `claude-code`, `Claude Opus 4.7 (1M context)`,
`Claude Code (Opus 4.7)`, `claude-opus-4.7`, `claude-opus-4-7`,
`claude-code-opus-4-7`) plus the bare-version cousin
`Claude Opus 4.7` onto the single canonical string `"Claude Code"`.
Explicit third-party names (`Codex`, `Cline`, `Cursor`) pass through
unchanged so the PF1-04 explicit-over-inferred contract stays intact.

Plan-then-execute, same posture as `--fix-fact-encoding` /
`--fix-memory-encoding`: bare invocation prints the plan grouped by
canonical destination; re-run with `--yes` to apply. Idempotent — a
second run reports zero rows once the vault is canonicalized.

The write-time canonicalizer in `src/hooks/agent-identity.ts` is the
single source of truth for the canonical-variant table. New Lore-produced
Agent strings route through it inside `deriveAgentName`, so the migration
exists to canonicalize _historical_ rows. Future agent integrations
should set `LORE_AGENT_NAME=<Name>` explicitly — only add to the
canonical table when a new _default-detection_ variant appears in the
wild.

### Synopsis backfill (`--backfill-synopses`)

Issue 0.7.0/05. Scans every non-archived memory whose `Synopsis`
property is empty (the pre-0.7.0 historical corpus, plus any post-0.7.0
row where the agent omitted the field on save). Plan-only by default;
`--yes` flips to apply mode. `--dry-run` always wins, mirroring every
other migrate flag's posture.

Two backends, selected by `--synopsis-backend`:

- `claude` (default): for each candidate, fetch the page body via
  `pages.retrieveMarkdown`, synthesize a 1–2 sentence synopsis via
  `claude -p` with a prompt-injection-guarded template, sanitize the
  output, and write to the row's `Synopsis` rich_text property. PATH
  preflight runs **only on the apply path** — operators without `claude`
  installed can still preview the candidate count via the cheap dry-run
  pass. Body-fetch / synthesis / sanitize / write failures all
  continue-and-log to stderr with entries shaped like
  `[lore] synopsis-backfill: id=... phase=... error=...`; the failed row's
  Synopsis stays empty so the next run picks it up.
- `placeholder`: writes the `SYNOPSIS_PLACEHOLDER_SENTINEL` constant
  (`"[awaiting backfill]"`) directly to every non-archived candidate
  row. Skips body fetches entirely — the sentinel doesn't consult body
  content. Intended primarily for test infrastructure (CI, fixtures);
  also usable by operators who want to flag every legacy row on a large
  vault before committing to LLM cost. **One-way state**: once the
  sentinel lands, the `Synopsis is_empty` discovery filter excludes the
  row on every subsequent run. Re-clear via `lore-memory action='update'`
  with `synopsis: ""` to re-target a row, or wait on a future
  `--backfill-only-placeholders` flag (out of scope for 0.7.0).

The fetch-time counters (`bodyOversizeSkipped`, `emptyBodySkipped`)
stay at typed numeric `0` on the placeholder apply path because the
backend never fetches a body to evaluate them. The CLI display layer
renders `n/a (placeholder backend)` in place of the literal `0` so an
operator scanning the report doesn't misread "checked and found zero"
when the migration didn't check at all. Programmatic consumers of
`BackfillReport` read the typed `0`.

Idempotency contract: discovery filters on `Synopsis is_empty`, so any
written row (synthesized OR sentinel) drops out of the candidate list
on the next run. `pages.update` is per-request atomic, so a failed
write leaves the Synopsis as Notion last observed it (empty if the
update never landed) — the partial-failure log line tells the operator
exactly which row needs another pass.

### Confidence-score baseline backfill (`--build-confidence-scores`)

Issue 0.8.0/11. Seeds every non-archived memory's `Confidence Score`
from the categorical `Confidence` column (`certain → 0.9`, `likely →
0.6`, `speculative → 0.3` — the `CONFIDENCE_SEED` table in
`src/types.ts`), writes `Last Referenced At = created_time`, and
realizes any neglect-decay accrued since creation via
`decayConfidenceScore` so a 200-day-old `certain` row lands at
`0.9 * 0.99^140 ≈ 0.220` rather than the bare seed value. Plan-only by
default; `--yes` flips to apply mode. `--dry-run` always wins.

**Why operators run this on upgrade.** Without the migration, every
pre-0.8.0 row's `Confidence Score` is null until a Phase 2 read path
touches it. RRF (#08) treats null as `confidenceFactor === 1.0`, so
the new ordering signal effectively no-ops; the trust indicator (#09)
never fires; the wake-up Stale Confidence section (#10) is empty.
Running the backfill once after upgrade populates every row so day-one
behavior matches steady-state.

**Skip rule**: `Confidence Score !== null`. Rows already touched by a
read-path or by a prior backfill are left alone. Idempotent — a second
run reports 100% "already scored" and writes nothing.

**Project scoping** via `--project <name>`: scopes the migration to one
project. Unknown / typo'd names abort BEFORE plan or write. `--yes`
consent for one project is not consent to mutate every null-scored row
across the vault, so the strict-resolve gate is load-bearing safety.
Omit `--project` for vault-wide scope.

**Concurrent execution**: writes dispatch in chunked `Promise.all`
batches sized to `notion.rateLimit.concurrency`
(`DEFAULT_NOTION_CONCURRENCY = 3`). Rate-limit middleware is a
`p-limit` gate, NOT a retry layer — a 429 surfaces as a thrown error
and the migration aborts. Re-run is idempotent: surviving rows from
prior batches are skipped via the `Confidence Score !== null` rule;
unwritten rows finish.

**Last Referenced At = created_time is a fiction.** The memory wasn't
actually "referenced" at creation; the assignment exists so decay
algebra has an anchor. Harmless: the operator who finds it confusing
can re-run the migration after a few weeks of real read-traffic — the
rows whose `Last Referenced At` got bumped by a Phase 2 read-touch
keep that newer date (the migration skips them).

The plan output surfaces top-N most-decayed titles so an operator can
sanity-check before approving with `--yes`. Per-100-rows progress lines
print to stderr during the apply pass. Implementation lives in
`src/core/confidence-migration.ts` (pure plan-then-execute) plus
`MemoryService.listAllForBackfill` / `applyBackfillScore` for the
service-boundary I/O.

**Categorical-default overstatement.** A pre-0.7.0 memory whose
categorical `Confidence` was never explicitly set defaults to
`certain` per `pageToMemory`. The migration treats `certain` as the
seed `0.9` regardless of how confident the original author would have
been if the column had existed, which can overstate confidence on
historical rows whose author would have written `speculative`. This
is unfixable at the migration layer without LLM-assisted relabeling
(out of scope for 0.8.0). The operator workflow for vaults where
this matters: re-grade specific rows via `lore-memory action='update'
confidence=...` before running the backfill (the migration honors
the explicit categorical), or after running it via the same update
path. Structured confidence-decrement now happens through
`lore-memory action='compare'` asymmetric verdicts and fact/decision
invalidation paths, not a standalone correction command. The Stale
Confidence section (#10) surfaces these rows for triage in the natural
course of work.

## The digest Command

`digest` gathers recent project activity and spawns a background `claude -p`
synthesizer that saves a distilled `source: digest` memory back to the vault.
The digest is what `lore-context action='wake-up'` surfaces in its fast path
at session start, so the goal is signal density (non-obvious findings,
decisions landed, top-5 active tasks, emerging themes) — not a chronological
session log.

Mechanics:

- Data gathering is shared with `lore-context action='digest'` via
  `src/core/digest.ts` (`gatherDigestData`).
- The synthesizer prompt lives in `src/hooks/prompts.ts`
  (`buildDigestPrompt`) and uses the same untrusted-content framing as
  `buildBackgroundSavePrompt`.
- Background spawn reuses `spawnBackgroundSave` from
  `src/hooks/background.ts` with `logLabel: "digest"` so stderr
  attributions stay distinct.
- `--dry-run` prints the gathered markdown and skips the spawn. Use this to
  preview what the synthesizer will see before burning an API call.
- When no memories fall in the window, the command exits early without
  spawning (nothing to digest).
- `--since YYYY-MM-DD` (paired with optional `--until`) widens the window
  past the auto-scheduler's `period: "week"` default. Use this for
  projects that hover below the digest-worthy bar week-over-week — the
  Stop-triggered scheduler's quiet-week branch keeps touching the marker
  for those, so no `source: "digest"` memory ever lands and
  `lore-context action='wake-up'` has no digest memory to surface in its fast
  path. The CLI re-touches the same marker after spawning, so a manual run
  debounces the next Stop hook's auto-path correctly.

Operators invoke `lore digest --project Mail` (or any configured
sub-project). It's the explicit path; the Stop hook fires it implicitly
once per project per 7 days when the cwd resolves to a single sub-project,
via a detached `auto-digest` helper child (so the parent Stop hook never
pays Notion init / digest gather cost inline). Both paths touch a
per-project marker file under the hook state directory
(`$TMPDIR/lore-hook-state/digest.<project>.last`) so the auto path
respects the debounce. The CLI also touches the marker so a manual run
won't be immediately overridden by the next Stop hook.

## The status Command

`status` prints vault metadata (page id, current project, database counts,
active projects), a one-line **Tasks** summary, and a per-project
**Digests** section.

The Tasks line surfaces `Tasks: N active (overdue: M, stale ≥30d: K,
in-progress: P, blocked: Q)` against the active project (or vault-wide
when no project is detected). Per-bucket sub-stats render only when
non-zero, and `active === 0` collapses to the bare `Tasks: 0 active`
form so a task-empty vault still prints the line as an explicit signal.
On vaults with the `Done At` column (post-#07), a second line shows
`Closed last 30 days: N (rate: R/day)` (`R = N / 30`, two-decimal
rounded). Pre-#07 vaults silently omit the closure-rate line —
`TaskService.countClosedSince` returns null on the missing-property
error path. Cost: two paginated `dataSources.query` calls fanned out
via `Promise.all`, so wall-clock is `max(active, closed)` rather than
the sum.

The pure renderer (`formatTaskSummary`) and the orchestrator
(`taskStats`) live in `src/core/task.ts` so both surfaces — `lore
status` (CLI) and `lore-context action='status'` (MCP) — emit the
same line shape for the same vault state.

A **Memory confidence** line follows the Tasks summary
(DEFERRED-04). Shape:

```
Memory confidence: 1247 total, 1023 scored (avg 0.51, 412 below threshold)
```

`MemoryService.confidenceStats` walks every non-archived memory in the
project scope (vault-wide when no project is resolved) via the same
`listAllForBackfill` iterator the `--build-confidence-scores`
migration uses, aggregates the four numbers in one pass, and returns
the report. The CLI fans the call out via `Promise.all` alongside
`taskStats` — both walk the Memories DB under the same project scope,
so wall-clock at the orchestration level is `max(taskStats,
confidenceStats)` rather than the sum. (The walk inside
`confidenceStats` is internally sequential — pagination dominates
single-method wall-clock on large vaults; the fan-out is what gives
us the parallelism, not the iterator.)

**`Promise.all` not `allSettled`** is deliberate. Both calls walk the
same data source under the same scope through the same rate-limited
client, so a 5xx that takes down one almost certainly takes down the
other; `allSettled`'s partial-recovery posture would help only on the
narrow case of a transient single-call failure that the rate-limit
middleware doesn't retry through. `taskStats`'s pre-DEFERRED-04
posture was the same `Promise.all` shape, and the
`searchByHybridPages` design rule already pins "fully-broken
subsystem must not masquerade as no-results" — `lore status` should
fail loudly, not paper over an outage with half a status line.

The renderer (`formatConfidenceSummary`) is exported from
`commands/status.ts` and follows the established `formatTaskSummary`
posture: `0 below threshold` collapses off, the parens drop entirely
on a `0 scored` (pre-#11) vault, and `totalMemories === 0`
suppresses the line. CLI-only — no MCP parallel exists; the line is
operator-facing vault-health surface, distinct from the agent-facing
`lore-context action='status'`.

The prefix is deliberately `Memory confidence:` rather than the
deferred-spec's illustrative `Memories:` — the bare `Memories:`
prefix would visually collide with the `Database counts →
Memories: N` line two rows above. The two surfaces also count
different sets: `Database counts → Memories: N` is a vault-wide
`countDatabase` walk that includes archived rows; the confidence
line is project-scoped (when applicable) and excludes archived rows
(inherited from `listAllForBackfill`). On a vault with archived
memories the two numbers will differ legitimately — operators
reading `Memories: 1247` and `Memory confidence: 1245 total …`
should not interpret that as a bug.

The Digests section that follows surfaces:

- Date of the latest existing `source: digest` memory linked to the project
  (or `no digest yet`).
- Marker mtime age in days (or `marker missing`).
- An estimated time until the next auto-digest fire, derived from
  `DIGEST_STALE_DAYS - markerAge`.

The section header surfaces the auto-digest disabled state when either
`LORE_AUTO_DIGEST=false` or `hooks.autoDigest: false` is set, so an
operator who set the env var and forgot sees it on the next `lore status`
without having to grep their shell rc.

Cost: exactly one extra Notion call beyond the existing status output —
a vault-wide `memories.list({ source: digest })` capped at 50 rows,
grouped client-side by `projectIds`. Per-project marker `stat`s are pure
filesystem and proportional to configured sub-projects. A vault with no
configured sub-projects (catch-all only) suppresses the section entirely.

The pure renderer (`formatDigestStatus`) and the loader
(`loadDigestStatus`) are exported from `commands/status.ts` and unit-
tested in `commands/status.test.ts` — extend those tests when adding
new branches to the watermark display.

A symmetric **Drift check** section (`formatDriftStatus` /
`loadDriftStatus`) follows Digests. Three points only that aren't
obvious from the rendered output:

- Wording is "next fire on next _debounced session_", not "Stop hook"
  like digest, because drift fires on every debounced caller (MCP
  server, hook runner, digest scheduler) — not just Stop.
- `lore status` itself runs with `driftCheck: true`, so
  `resolveDriftCheck` touches the marker _before_ the loader reads it.
  The section therefore reflects what debounced callers will see on
  their next fire — not what `lore status` itself triggered. Looks
  like a bug if you don't know to expect it.
- Section-suppression contract: loader returns `configured: false`
  (no `.lore.yaml` config root) → renderer returns `[]` → caller's
  length-check drops the entire section. Mirrors how Digests
  suppresses on no-sub-projects vaults. Single row today, but the
  data shape leaves a `padEnd` seam free for a future multi-vault row.

## Adding a New Command

1. Create `commands/foo.ts` following the pattern above.
2. Export a `Command` instance named `fooCommand`.
3. Import and add it in `index.ts`:
   ```typescript
   import { fooCommand } from "./commands/foo.js"
   program.addCommand(fooCommand)
   ```
4. Remember the `.js` extension in the import path.
5. Add the command to `docs/cli.md` and update the root README summary when the
   command belongs in the quick-start list.

## The install Command

### 0.10.0 ntn detection and MCP env forwarding

The behavior below is the 0.10.0 target shape — implemented
across #01 (`resolveAuth` rewrite + deprecation warnings), #02
(ntn detection + auto-install + auto-login), #03
(`verifyVaultAccess` preflight), and #08 (this section's MCP
env-forwarding rewrite). Runtime env names come from
`RUNTIME_FORWARDED_KEYS` in `src/auth/forwarded-env.ts`; the static
entries are assembled by `buildMcpEnv()` in `src/cli/commands/install.ts`.

Install detects ntn install / login state and prompts on missing
pieces (auto-install via `curl -fsSL https://ntn.dev | bash` with
operator confirmation; `--yes` skips). The MCP server resolves
auth on its own at startup via `resolveAuth` rather than relying
on static token forwarding for ntn-source operators. Conditional
`LORE_NOTION_TOKEN` forwarding is preserved when the legacy env
var is set in the install-time environment (with a `lore auth
--migrate` recommendation), so legacy operators don't lose access
by upgrading. Static values from `buildMcpEnv()` include
`LORE_SUPPRESS_DEPRECATIONS=1` (silences per-session warnings from spawned
children — emitted by #01's `resolveAuth`) and `LORE_CONFIG_ROOT` for bare-bin,
legacy, Cursor global-scope, and bare/legacy print-config shapes. Those shapes
need the static root because the host may launch the MCP child from an
unpredictable cwd. Project-scoped Yarn/PnP snippets for Claude, Codex, Cursor,
and `--print-config --yarn-pnp` intentionally omit `LORE_CONFIG_ROOT`; they
launch from the workspace root and rely on the upward `.lore.yaml` search
instead. Install runs `verifyVaultAccess` post-resolution and refuses to write
MCP config on `not-found`, so operators don't end up with installed-but-broken
state.

### Assistant targets

`install` supports multiple assistant targets:

- Default `lore install` updates Claude Code, Codex, and Cursor for the
  current project (`--client all`), so rerunning it after an older
  single-assistant install will fill in the missing sides.
- `--client claude` updates only Claude Code's `settings.json` hooks and the
  project's `.mcp.json`.
- `--client codex` updates only the project's `.codex/config.toml` and
  `.codex/hooks.json`.
- `--client cursor` updates only the project's `.cursor/mcp.json`
  (or `~/.cursor/mcp.json` with `--cursor-global`).
- `--client both` is a deprecated alias for `--client all`; the CLI emits
  a warning and proceeds. Removal is plausible for 1.0.0.
- Codex hooks require `features.codex_hooks = true` and only load in trusted
  projects, so preserve that behavior if you change the installer.
- Cursor's MCP runtime does not currently support session-end / Stop hooks
  the way Claude Code and Codex do. The installer writes only an MCP entry
  and prints a one-line notice; the Stop-triggered autosave and the detached
  auto-digest spawn (per `src/hooks/AGENTS.md`) do not activate under
  Cursor. Recall / save / scan paths work identically.
- Under `--client all`, each assistant installer runs independently —
  failure of one does not abort the others. The CLI exits non-zero with a
  per-client failure summary if any branch threw. The summary prints
  `client: message` lines by default; set `LORE_INSTALL_DEBUG=1` to
  include stack traces (an unexpected failure mode worth surfacing
  without making the default operator output noisy).
- Hook-script prerequisites (`hooks/autosave.sh`, `hooks/wakeup.sh`) are
  checked only under `--legacy-paths`. Default Claude and Codex installs use
  bin dispatch (`lore hooks ...`, or `yarn run -T lore hooks ...` under Yarn
  PnP) and do not require the checked-in shell wrappers. Cursor never checks
  the scripts because its MCP runtime does not use hooks. A missing or
  non-writable legacy hook script does NOT block a Cursor-only install, and
  under `--client all` it surfaces through the per-client captured-error path
  so non-legacy branches still install cleanly.

Cursor's MCP file location is documented at
<https://docs.cursor.com/context/mcp> — the installer reads the project-
scoped `<projectDir>/.cursor/mcp.json` by default and the global
`~/.cursor/mcp.json` under `--cursor-global`. The JSON shape is identical
to Claude Code's `.mcp.json` (`command` / `args` / `cwd` / `env`); the
installer reuses `buildMcpEnv()` and `RUNTIME_FORWARDED_KEYS` so runtime
values resolve through the same `${VAR}` placeholders.

#### `--cursor-global` precedence rules

- **`--cursor-global` overrides `--project` for the Cursor branch.**
  Running `lore install --client cursor --project ./other --cursor-global`
  writes to `~/.cursor/mcp.json`, NOT `./other/.cursor/mcp.json`. The
  `--project` flag still scopes the Claude / Codex branches; only the
  Cursor branch is hoisted to home.
- **Under `--client all`, `--cursor-global` applies only to the Cursor
  branch.** Claude's `.mcp.json` and Codex's `.codex/config.toml` always
  land project-scoped under the resolved `--project` directory regardless
  of `--cursor-global`. There is no cross-host equivalent flag in 0.9.0.
- **Under `--client claude` or `--client codex`, `--cursor-global` is
  ignored** with a one-line stderr note (no error, no exit code change).
  Operators who scripted `--cursor-global` in advance of an `--client all`
  rollout aren't surprised by it.

### `--print-config <json|toml>` escape hatch

For MCP hosts not directly supported via `--client` (Gemini-CLI, OpenCode,
Windsurf, Antigravity, Copilot, etc.), `--print-config` emits a paste-ready
config snippet to stdout. Pure stdout-emitter — no files written. `--client`
is accepted as a no-op; `--project` selects the config root embedded as
`LORE_CONFIG_ROOT` for bare/legacy printed snippets. Yarn/PnP printed snippets
omit that static env and rely on launch from the workspace root, so pass
`--yarn-pnp` only when the unsupported host will run the snippet from the repo
root. `--yarn-pnp` / `--no-yarn-pnp` select the printed command shape.

- `--print-config json` calls `buildClaudeMcpEntry` and wraps the result in
  `{ "mcpServers": { "lore": ... } }`. For the same `--project` and
  Yarn/PnP shape, it is byte-identical to what `--client claude` writes to
  `.mcp.json`.
- `--print-config toml` calls `buildCodexMcpSection`. For the same
  `--project` and Yarn/PnP shape, it is byte-identical to what
  `--client codex` appends to `.codex/config.toml`.

Reuse — not parallel formatters — is the contract: drift between the
printed snippet and the on-disk shape would silently break operators of
unsupported hosts. Future format changes to the build helpers must
preserve the byte-identity tests in `install.test.ts`.

The runtime path validates `dist/mcp.js` exists (otherwise the printed
`args[0]` would point at nothing and the operator's pasted config would
fail at agent startup); on missing build output the command exits 1 with
the same `Run 'npm run build' first.` message the install paths use.

Hooks are not part of this surface. Stop / UserPromptSubmit hooks are
installed only by supported host-specific installers; operators of other hosts
get the MCP tool surface only. `--print-config` does not pretend
feature-equivalence across hosts — see the README "Other MCP hosts" subsection
for the operator-facing framing.

### Agent identity via LORE_AGENT_NAME

Hook helpers derive the `Agent:` field on saved memories via
`deriveAgentName` (see `src/hooks/helpers.ts`). Claude Code sets
`CLAUDECODE=1` / `CLAUDE_CODE_*` automatically, but Codex has no
equivalent runtime marker.

To close the attribution gap, the Codex installer prefixes each hook
command with `LORE_AGENT_NAME=Codex `. `deriveAgentName` honors that
override so Codex-hooked sessions save memories tagged with
`Agent: Codex` instead of omitting the field.

Third-party agent integrations (Cline, Cursor, Aider, etc.) should
follow the same convention: prefix the hook command with
`LORE_AGENT_NAME=<Name>`. Explicit-over-inferred, so an override always
wins even if `deriveAgentName` later learns a detection heuristic for
that agent.

#### Contract for third-party integrators

The hook command must be executable as a POSIX shell string — Codex runs
`hooks.json` entries through `/bin/sh`, not `execve`. The exact pattern
`detectCodexHook` / `stripShellEnvPrefix` recognizes is:

```
VAR=VALUE [VAR=VALUE ...] /path/to/script.sh
```

Rules the detector enforces (and that reinstall depends on — a hook that
doesn't match the pattern will be classified `stale` and replaced):

- **Uppercase keys only**: `LORE_AGENT_NAME=Codex` ✓,
  `lore_agent_name=codex` ✗. Matches the POSIX env-var spelling
  convention the regex `[A-Z_][A-Z0-9_]*` enforces.
- **Unquoted, no-whitespace values only**: `LORE_AGENT_NAME=Codex` ✓,
  `LORE_AGENT_NAME=My-Agent` ✓, `LORE_AGENT_NAME="My Agent"` ✗.
  Quoted/spaced values break the `\S+` parse and the detector treats
  the command as un-prefixed. Pick a single-token agent name.
- **Multiple env prefixes are allowed**: `FOO=1 BAR=2 LORE_AGENT_NAME=Codex /path/to/script`
  works — each `VAR=VALUE ` pair is stripped in turn.
- **Do not wrap the command in an outer shell** (`sh -c "…"`). The
  detector strips leading assignments but does not unwrap wrapper
  shells; a wrapped command will not match its script name and
  `lore install` will replace it on every run.

Integrators writing to `.codex/hooks.json` directly should build the
command via the same shape `buildCodexHookCommand` produces: prefix,
then `JSON.stringify(absolutePath)` for the quoted script path. Running
`lore install --client codex` produces the canonical form for reference.

Codex currently targets POSIX shells only (macOS / Linux). `VAR=VALUE
cmd` is not recognized by `cmd.exe`, so the prefix is not portable to
Windows; revisit if Codex ships a Windows-native hook runner.

## The conflicts Command

`conflicts scan` (issue 0.9.0/#09) walks the vault, runs lexical
candidate generation per project (delegating to
`findConflictCandidates`), filters out pairs already judged via
`Compared With`, and emits _prompt-ready_ output the calling agent
reads and dispatches back via `lore-memory action='compare'`.

The CLI does NOT call any LLM and does NOT call the compare tool —
it produces structured material the agent acts on. Engram's
analog (`engram conflicts scan`) shells out to a fresh agent CLI
via `ENGRAM_AGENT_CLI`; lore inverts the design because the MCP
server is invoked _by_ the current Claude session already, so the
natural judge is the _current_ session, not a subprocess.

### Pipeline

`list → generate → dedup → filter → sort → truncate → render`

Order is load-bearing: filtering before truncation ensures
`--limit` budgets the _useful_ candidate set, not the raw set.
An earlier draft of the spec applied filters after truncation and
silently under-surfaced candidates when the top-similarity raw
slice contained already-judged pairs.

### Two cap knobs

The scan uses two distinct caps that an operator must keep
separate when reasoning about coverage:

- **`--raw-limit` (default `SCAN_RAW_CANDIDATE_CAP = 500`)** is
  the _coverage_ knob — passed into `findConflictCandidates` as
  `pairLimit` per project. Bounds the per-project candidate
  **accumulator** (the generator uses bounded top-K accumulation so
  a high-overlap project allocates O(`pairLimit`)
  `ConflictCandidate` objects, not O(N²); see
  `findConflictCandidates` in `src/core/conflict.ts`). The per-pair
  similarity computation itself is still O(N²) — that's inherent to
  lexical-pair comparison and only an index over the corpus could
  change it — but the memory blow-up is closed. Increase
  `--raw-limit` to continue bounded scanning beyond the previous raw
  window after those candidates are already judged. Lifted by
  `--exhaustive` (which passes
  `pairLimit: Number.POSITIVE_INFINITY` per #03's contract — NOT
  an empty options object, which would default to
  `CONFLICT_PAIR_LIMIT = 50`). When `--raw-limit` is combined with
  `--exhaustive`, `--exhaustive` wins and the CLI emits a one-line
  stderr note rather than failing.
- **`--limit` (default `CONFLICT_PAIR_LIMIT = 50`)** is the
  _prompt budget_ knob — applied AFTER dedup + comparedWith
  filter + sort. Bounds the agent's per-run reasoning surface.

Passing `--limit` to the generator (instead of
the raw-candidate coverage cap) would pre-truncate before dedup and
filtering, yielding a final surfaced set < `--limit` even when
more useful candidates exist. The two-cap design is what the
acceptance criteria pin via `findConflictCandidates`-spy
assertions.

### Bounded coverage limitation

A project with more lexical candidates than the current
`--raw-limit` can have unjudged pairs ranked after that raw
window. Once an operator has judged every pair the bounded scan
returns, the run can return zero pairs even though deeper
similarity-ranked candidates remain unjudged. The no-results
message distinguishes this cap-hit state from true exhaustion and
points operators at a larger `--raw-limit` for the next bounded
run. `--exhaustive` lifts the bound at the cost of unbounded O(n²)
generation (a 5,000-memory project produces up to ~12.5M pairs).

### Output shapes

- **Markdown (default)** — prompt-ready for an interactive agent
  session. Header references the verdict vocabulary by name (six
  values, defined in `docs/memory-workflows.md` and in
  `src/core/prompts/conflict-judge.ts` per #03). The scan does NOT
  inline the locked prompt verbatim; the calling agent follows the
  linked contract.
- **JSON (`--json`)** — for programmatic consumers. Carries a
  top-level `compareContract` block with the asymmetric /
  symmetric verdict split, the four direction rules, and a
  back-reference to `docs/memory-workflows.md` for canonical verdict definitions.
  Self-describing so an agent piping `--json` into another tool
  doesn't need prior context to produce correctly-shaped
  `compare` calls.

Progress messages route to **stderr** so `--json` is pipe-clean;
result output goes to stdout regardless of format. The
implementation injects a `log` sink rather than calling
`console.error` / `process.stderr.write` directly, mirroring
`runReconcile`'s injection-friendly shape so the unit test
captures progress without process globals.

### MemoryService.listForScan

`listForScan({ projectIds, projectLabels?, includeBodies?,
onProgress? })` is the dedicated walker for this surface.
Distinct from `MemoryService.list` (which is recall-shaped):

- **Strict-scoped** — uses `Project relation contains <id>`, NOT
  `projectOrUnscopedFilter`. Unscoped repo-wide rows would fail
  `findConflictCandidates`'s per-pair project intersection
  anyway, so including them inflates O(n²) work for zero useful
  output.
- **Paginates aggressively** — page size 100, loops until
  `has_more === false`. The conflict scanner needs every row in
  the project, not the recency-truncated 100-row window `list`
  returns.
- **Body fetch is opt-in** — the candidate generator reads only
  `title` / `keywords` / `tags` / `projectIds`. Default off
  keeps the scan an O(N) properties walk; `--include-bodies`
  fans out per-page `retrieveMarkdown` for renderer use only.
- **Archived rows filtered client-side** — Notion's `archived`
  flag lives on `PageObjectResponse`, not as a DB column. Same
  posture as `findByTopicKey` / `listAllForBackfill`.

## The mine Command

`mine` is the most complex command. It walks a directory tree, filters for
mineable text files by extension or explicit basename, and creates or updates
one memory per file. Key details:

- Skips directories: `node_modules`, `dist`, `build`, `.git`, `.next`, `__pycache__`
- Skips files: `.lore.yaml`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
- Only indexes files with recognized text extensions (see `TEXT_EXTENSIONS` set)
  or explicit basename support such as conventional `Dockerfile` /
  `Containerfile` names
- Max file size: 100KB per file
- Default limit: 50 files per run
- Each memory is created with source `"file"` and keywords `"<extension> mined <relPath>"` — `tags` is left empty because file extensions are free-form tokens, not part of the closed tag vocabulary
- Content is wrapped in a markdown code block with the file extension as language
- Supports `--dry-run` to preview files without creating memories

### Pattern and limit validation

- `--pattern <glob>` filters the walker's output before the `--limit`
  slice, so `--pattern src/**/*.ts --limit 10` returns the first 10
  _matching_ files rather than the first 10 files of any type. The
  matcher (`globToRegExp` in `commands/mine.ts`) supports `**`
  (multi-segment globstar; only when surrounded by path boundaries),
  `*` (within-segment), `?`, and POSIX-style character classes
  (`[abc]` / `[!abc]`). Mid-segment `**` (e.g. `foo**bar`) collapses
  to single-`*` semantics so it does not silently match across path
  boundaries. Raw `/` inside a character class is stripped so a class
  like `[a/b]` cannot leak through and match the path separator. Brace
  expansion (`{a,b}`) is intentionally NOT supported — brace literals
  are escaped through.
- Path matching is case-sensitive; the `TEXT_EXTENSIONS` filter is
  case-insensitive. A mixed-case file (`Foo.TS`) passes the extension
  filter but only matches a pattern whose path segment also says
  `Foo.TS`. This is the safer behavior on case-sensitive filesystems
  (Linux); operators on macOS / Windows can write the case that
  matches their actual filenames.
- `--limit` validates as a strict positive integer via the same
  digit-only regex posture as `parseScanCliOptions` in
  `commands/conflicts.ts`. Rejects `0`, `-1`, `3abc`, `3.7`, `1e3`,
  `+5`, empty string, and values past `Number.MAX_SAFE_INTEGER`
  with a clear error message.

### Project resolution: explicit `--project` is fatal-strict

`resolveMineProject` (`commands/mine.ts`) is called BEFORE any file
walk or upsert work. An explicit `--project <name>` that doesn't
resolve throws — matching the posture of `resolveScanProjects` in
`commands/conflicts.ts`. Without that gate, a typo like
`--project Mial` would fall through to the catch-all branch and
silently dispatch unscoped writes that could collide with another
project's existing mined memories.

### Idempotency: per-file upsert keyed on `(title, source, projectIds)`

Repeated `lore mine` runs over the same tree do NOT accumulate
duplicate memories. Before each create, `findExistingFileMemory`
(`commands/mine.ts`) issues a single
`MemoryService.search({ mode: "contains", query: relPath, limit: 100 })`
and post-filters on three gates:

- `source === "file"` rejects user-curated memories that happen to
  mention the relPath (different source = different upsert lineage).
- `title === expectedTitle` (`<basename> — <relPath>`) rejects mined
  files whose path is a substring of the queried one (e.g.
  `src/foo.ts` substring-matches `src/foo.ts.bak`).
- `projectIdsEqual(memory.projectIds, expected)` enforces project-set
  equality — `[A]` does not match `[A, B]` and unscoped (`[]`) does
  not match `[A]`. Mirrors `MemoryService.upsertByTopicKey`'s
  `(Topic Key, Project-set)` equality contract. Without this gate,
  `lore mine --project Foo` could match an unscoped row and rewrite
  it into Foo's scope, silently merging two upsert lineages.

`FIND_EXISTING_LIMIT = 100` is the Notion-side `dataSources.query`
`page_size` cap. The 25-row default that shipped earlier could
paginate the previously-mined row out of the candidate window on a
busy vault, breaking the idempotency contract; 100 is the largest
single-round-trip recall the API supports.

### Topic preservation on re-mine

The upsert path passes `topicId` through to `MemoryService.update`
ONLY when a current `--topic` resolves. Re-mining a file without
`--topic` therefore leaves the row's existing Topic relation in
place — same posture as `MemoryService.upsertByTopicKey`'s
"Topic preserves silently on upsert" rule. An operator who wants to
retire a stale topic on a mined memory uses
`lore-memory action='update'` directly; the mine path is
content-replication, not metadata-curation.

### Per-file failure isolation and bounded concurrency

`runMineUpsert` chunks files into batches sized to
`config.notion.rateLimit.concurrency` (default
`DEFAULT_NOTION_CONCURRENCY = 3`) and dispatches each batch via
`Promise.all`. Per-file failures resolve as `kind: "failed"`
outcomes via `processOneFile`'s outer try/catch — a single 429 or
read error does NOT abort the batch. Sequential `for await` would
serialize round-trips end-to-end; the bounded chunked dispatch makes
the operator's `notion.rateLimit.concurrency` knob actually move the
wall-clock needle.

### Concurrent-mine race (uncovered)

Two parallel `lore mine` runs against the same project for the same
file can both observe an empty `findExistingFileMemory` and both
create — Notion has no per-key uniqueness primitive on the Memories
DB. Single-operator serial use is the common case. The
`lore migrate --dedup-keys --merge` pass is fact-side dedup, not
memory-side, so it does NOT collapse mine duplicates. If real-vault
data shows the race matters, a follow-up adds a per-vault lock via
`src/hooks/lock.ts`.

### Output format (additively-compatible with pre-PR)

`formatMineSummary` keeps the pre-PR `Indexed N files.` /
`Done. Indexed N/M files (K failed).` shapes byte-stable for
log-scrape parsers. The `(N new, M updated)` clause is appended
ONLY when at least one update landed, so a fresh-vault first run
emits identical output to the pre-PR shape.
