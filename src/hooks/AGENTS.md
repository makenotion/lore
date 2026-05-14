# AGENTS.md -- src/hooks/

> Read the root `AGENTS.md` first. This file covers the hook runner layer only.

## Purpose

This directory implements Lore's hook runner. Default Claude Code and Codex
installs invoke `lore hooks <action>` at defined lifecycle events (or
`yarn run -T lore hooks <action>` under Yarn PnP). Older absolute-path
installs invoke `node dist/hooks/helpers.js <action>` through the checked-in
`hooks/*.sh` scripts. The helper reads the hook event from env vars, loads
`.lore.yaml`, and either injects context (`wakeup`) or spawns a background
save (`autosave`). The Stop hook also spawns a detached `auto-digest` helper
that owns digest synthesis off the hot path. The `session-end` action is an
exit-0 compatibility shim for stale Claude Code settings written before 0.6.0
dropped active SessionEnd registration.

## Files

| File                           | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `helpers.ts`                   | Entry point: routes to `autosave` / `wakeup` / `auto-digest` / `session-end` handlers                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `prompts.ts`                   | Pure prompt builders for background-save sub-agents                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `conversation-mining.ts`       | `runConversationMining(transcript, options)` — synchronous, awaitable counterpart to `background.ts`'s detached fire-and-forget spawn. Co-located here because it shares the prompt builder, binary resolver, and `buildSafeEnv` partition with the autosave spawn primitive; consumers needing deterministic per-session completion (eval harnesses, one-shot replays) import this seam directly. The hook itself does not call this helper — its lock + concurrency-cap machinery is owned by `spawnBackgroundSave`. |
| `transcript.ts`                | Parse Claude Code / Codex transcript formats into messages                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `lock.ts`                      | Per-session concurrency guard for background saves; owns `getStateDir()` for every marker in this dir                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `config.ts`                    | `.lore.yaml` `hooks` section defaults + merge                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `digest-scheduler.ts`          | `fireDigestIfStale` (in-child digest logic) + `scheduleAutoDigestSpawn` (parent-side detached fork off Stop)                                                                                                                                                                                                                                                                                                                                                                                                           |
| `digest-marker.ts`             | Per-config-root debounce marker for the auto-digest scheduler                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `drift-marker.ts`              | Per-config-root debounce marker for `VaultManager.load`'s schema drift check (0.6.0 issue 02)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `background-failure-marker.ts` | Bounded per-config-root health markers for detached autosave / digest background failures surfaced by `lore status`                                                                                                                                                                                                                                                                                                                                                                                                    |
| `marker-key.ts`                | Shared `configKey()` and `safeFilenameSegment()` helpers for every filesystem marker, lock, log, and count file in this dir                                                                                                                                                                                                                                                                                                                                                                                            |

New marker modules under `src/hooks/` derive their config key and
sanitize free-form name segments via `marker-key.ts` rather than
re-implementing the hash or the regex — that keeps the truncation
length and sanitization charset in lockstep across every filesystem
state file. The lock/log/count paths in `lock.ts` and `helpers.ts`
route through `safeFilenameSegment` for the same reason: a hostile
or malformed `sessionId` carrying `/`, `..`, backslashes, or shell
metacharacters must not be able to escape `getStateDir()`. The
sanitizer also fronts the prompt-side `Session ID:` / `session: "..."`
lines in `prompts.ts:buildIdentityBlock` so a `sessionId` carrying
`\n` followed by a fake instruction can't inject prompt content into
the spawned `claude -p`'s body — same regex policy, parallel exit
channel.

### Background failure markers

`background-failure-marker.ts` owns the small local health breadcrumbs that
`lore status` renders under **Background hooks**. Files live in
`getStateDir()` (`$LORE_HOOK_STATE_DIR` when set, otherwise
`$TMPDIR/lore-hook-state/`) next to locks, logs, digest markers, and drift
markers. Their filenames are isolated with the `background-failure.` prefix,
the config-root key, the failure kind, and a short hash of the
operator-actionable scope.

The active marker key is **recoverable scope**, not session scope:
`kind + config root + project name` (project omitted for vault-level cases).
The latest `sessionId` stays in the JSON body for diagnosis, but it must not
make a new file per Stop hook session. A later success for the same kind and
project clears only markers whose `occurredAt` is strictly older than the
pre-spawn recovery boundary, so a concurrent fresh failure survives stale
success cleanup. Writers use sync tmp-file + POSIX rename on the Stop hot path;
same-key concurrent writes are intentionally last-writer-wins because the
status surface is "latest observed failure for this scope." Writers
opportunistically prune stale files for the same config root; readers prune
malformed, unknown-version, unknown-kind, wrong-root, and stale files. Stale
means older than 14 days, chosen as one missed weekly digest window plus slack
for an operator to run `lore status`.

Current `BackgroundFailureKind` values:

| Kind                       | Observes                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `autosave`                 | Foreground Stop hook failures before the detached autosave child successfully starts     |
| `digest-scheduler`         | Detached auto-digest helper init/gather failures before synthesis spawn                  |
| `digest-synthesizer`       | Auto-digest synthesis spawn setup failures (`binary-missing`, tempfile, spawn exception) |
| `auto-digest-helper-spawn` | Foreground Stop hook failure to fork the detached `helpers.js auto-digest` child         |

The supervision boundary is narrow by design: markers cover failures the
foreground process or helper can directly observe at spawn/init/gather time.
Lore does **not** supervise detached background agents through final process
exit, so a child that spawns successfully and later crashes will not create a
background-failure marker. Keep that caveat visible in any user-facing status
renderer; the honest clean state is "no observed failures," not "healthy."

Wake-up's per-session debounce marker is outside this subsystem: if its
`getStateDir()` write fails with a non-`EEXIST` error, wake-up logs
`[lore] wakeup: debounce mark failed` and fails open without creating a
background-failure marker or `lore status` row.

When adding a new kind, update the `BackgroundFailureKind` union,
`BACKGROUND_FAILURE_KINDS`, `formatBackgroundFailureKind`, and
`backgroundFailureHint`, then add tests for write/read/clear, stale pruning,
and status rendering. Only attach `logPath` when the target log file can
exist; `binary-missing` and tempfile setup failures happen before child
stderr is opened.

**POSIX-only.** The sanitizer is not Windows-safe: NTFS reserved device
names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) pass
through the allowed-charset regex unchanged, so `CON.lock` would resolve
to a device handle on Windows rather than a file. Lore's hook runner
already assumes POSIX for unrelated reasons (`process.kill` PID liveness
probe, `os.tmpdir()` state-dir convention, the Stop-hook lifecycle); a
future Windows port should layer a case-insensitive reserved-name check
at the same boundary rather than widening the regex.

Tests for each module sit alongside it (`*.test.ts`). `helpers.ts` runs
`main()` only when invoked as the Node entry point (`dist/hooks/helpers.js`)
— when imported from a test file the `isEntryPoint()` guard skips it so
handlers can be unit-tested directly.

## Background-agent configurability (issue #194)

The Stop-spawn autosave and Stop-spawn auto-digest paths shell out to a
detached agent CLI. The historical default is `claude -p` with the args
`["-p", "--allowedTools", "{{allowedTools}}", "--dangerously-skip-permissions",
"--no-session-persistence", "--model", "sonnet"]` — preserved byte-for-byte so
Claude Code installs see no behavioral change.

Operators swap the binary by name (preset args resolve automatically):

```yaml
hooks:
  backgroundAgent:
    command: codex # picks up CODEX_BACKGROUND_ARGS preset (`exec --sandbox workspace-write --skip-git-repo-check`)
```

Or via env (ad-hoc):

```bash
export LORE_BACKGROUND_COMMAND=codex
```

For unsupported binaries, operators must supply `args` explicitly:

```yaml
hooks:
  backgroundAgent:
    command: aider
    args: ["--no-pretty", "--message-from-stdin"]
```

Resolution order:

| Field     | Precedence (highest first)                                                                                                                                                        |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `command` | `LORE_BACKGROUND_COMMAND` env > `hooks.backgroundAgent.command` in `.lore.yaml` > derived from `LORE_AGENT_NAME` (via `AGENT_BACKGROUND_COMMAND`) > `"claude"`                    |
| `args`    | `hooks.backgroundAgent.args` in `.lore.yaml` > preset for the resolved `command` (`lookupCommandPreset` — basename-aware) > `DEFAULT_BACKGROUND_ARGS` (Claude-shaped fallthrough) |

The agent-context tier (tier 3 on `command`) is what makes Codex installs
"just work." The Codex installer prefixes every hook command with
`LORE_AGENT_NAME=Codex `, so at hook-fire time `mergeHookDefaults` sees
`LORE_AGENT_NAME=Codex` and derives `command: codex` automatically — no
per-project `.lore.yaml` setup or shell-rc-exported `LORE_BACKGROUND_COMMAND`
required. Claude Code installs do NOT set `LORE_AGENT_NAME` (they rely on
`CLAUDECODE=1` runtime markers, which `mergeHookDefaults` deliberately
doesn't read for command derivation), so they fall through to the
historical `claude` default — back-compat preserved byte-for-byte.

Lore ships presets for `claude` and `codex` (in `KNOWN_COMMAND_PRESETS`,
`src/hooks/config.ts`). The preset lookup is **basename-aware** —
`/opt/homebrew/bin/codex` and bare `codex` both pick up the codex preset.
Absolute paths are common in hook environments with minimal `PATH`, and
exact-string matching would silently let an absolute-path Codex operator
inherit Claude flags. Adding a preset is a one-line change to the
constant plus a test in `config.test.ts`. Adding an agent-name → command
mapping (e.g., a future `Cline` installer that sets
`LORE_AGENT_NAME=Cline`) is a one-line change to
`AGENT_BACKGROUND_COMMAND`.

There is no env path for `args` because the value is structurally an array
and env vars are scalar; an env-shaped split-on-whitespace parser would
re-introduce the quoting bugs (`--flag "value with spaces"`) the structured
shape exists to avoid.

The token `{{allowedTools}}` (`ALLOWED_TOOLS_PLACEHOLDER` in `config.ts`) inside
`args` is replaced at spawn time with the tool allowlist string
(`DEFAULT_SAVE_ALLOWLIST` for autosave, `DIGEST_ALLOWLIST` for digest). Operators
whose CLI doesn't accept an allowlist flag drop the placeholder; the spawn
primitive silently skips the hand-off, and the agent's allowlist must be
configured out-of-band (for Codex: `mcp_servers.lore.allowed_tools` in
`.codex/config.toml`). The install-time path emits an explicit `Note:` line
when the resolved args lack the placeholder so operators see the
out-of-band requirement.

The merged shape lives on `HookConfig.backgroundAgent` and is threaded through
`helpers.handleStop` (autosave), `digest-scheduler.fireDigestIfStale`
(auto-digest), and `core/synopsis-backfill.backfillSynopses`
(`lore migrate --backfill-synopses`). The `lore digest` CLI calls
`mergeHookDefaults(services.config.hooks)` to pick up the same knob.
Direct callers of `spawnBackgroundSave` that omit the `agent` option fall
through to the built-in defaults — that's the back-compat path for callers
not threaded through the config layer.

Both `runClaudeInstall` and `runCodexInstall` (in `cli/commands/install.ts`)
call `resolveBackgroundAgentForInstall` and `printBackgroundAgentSummary` so
operators see install-time warnings for any of three independent failure
bands:

1. **Binary missing** — the resolved command isn't on PATH; the runtime
   spawn would fail with `binary-missing`.
2. **Unknown command without preset** — the binary exists but isn't in
   `KNOWN_COMMAND_PRESETS`; args fell through to the Claude-shaped default,
   which works only for Claude variants. The warning recommends an explicit
   `args` override.
3. **Allowlist hand-off missing** — the resolved args lack
   `{{allowedTools}}`; the agent's allowlist must be configured out-of-band.

`LORE_BACKGROUND_COMMAND` is the canonical operator-scoped knob for
redirecting the background agent. The matching `.lore.yaml` shape is
also canonical.

## Autosave flow

Autosave fires on `Stop` only and spawns a detached `claude -p` sub-agent
that writes structured content via lore-\* MCP tools. The main agent is
**never** blocked.

| Hook              | Trigger                                                                         | Prompt builder              |
| ----------------- | ------------------------------------------------------------------------------- | --------------------------- |
| `Stop` (autosave) | `userMessages - lastSavedAt >= saveInterval` (first save: min(saveInterval, 2)) | `buildBackgroundSavePrompt` |

Before P2-05 the `Stop` path injected `{"decision": "block"}` and forced an
extra agent turn. That pattern is gone: `Stop` now always emits `{}\n` and
offloads save work to a background process. The hook returns in
milliseconds and the user's next turn starts immediately.

The spawned sub-agent has no prior context and receives the transcript
inline through the prompt.

### Auth handoff to the spawned `claude -p`

The detached child resolves its own credentials at startup via the
same `resolveAuth` path the parent uses, against `event.cwd`
(`spawnBackgroundSave` passes `cwd` straight through to
`child_process.spawn`). The child's `findConfigFile` walks upward
from `cwd` to locate `.lore.yaml`; from there `resolveAuth` runs
the priority chain. **No `LORE_CONFIG_ROOT` is forwarded** —
config-root discovery is the same upward-search the parent did.

This is **not** the same env contract as the long-running MCP
server child that `lore install` writes config for. Bare-bin, legacy,
Cursor global-scope, and bare/legacy print-config shapes include static
`LORE_CONFIG_ROOT` so the MCP child can resolve the right `.lore.yaml` from a
host-controlled cwd. Project-scoped Yarn/PnP snippets for Claude, Codex,
Cursor, and `--print-config --yarn-pnp` intentionally omit `LORE_CONFIG_ROOT`;
they launch from the workspace root and rely on the same upward `.lore.yaml`
search instead. The two spawn paths have different env contracts because they
have different lifetimes — the hook autosave child runs once per Stop and
inherits the parent's cwd, while the MCP server child is launched by the host
assistant.

The parent's env passthrough is deliberately minimal:
`spawnBackgroundSave` builds a `safeEnv` with `PATH`, `HOME`,
`LORE_AUTOSAVE: "false"` (so the child can't recursively trigger
its own autosave), `LORE_BACKGROUND_AGENT: "true"` (so the child's
MCP server fails fast on init errors instead of staying alive as a
diagnostic server), and every key in the shared
`RUNTIME_FORWARDED_KEYS` list (`src/auth/forwarded-env.ts`) when
the parent has it set: `NOTION_API_TOKEN`, `LORE_NOTION_BASE_URL`,
`NOTION_WORKSPACE_ID`, `NOTION_ENV`, `NOTION_BASE_URL`,
`NOTION_API_BASE_URL`, and `LORE_USER_NAME`.
The same list drives `lore install`'s `${VAR}` placeholders for
MCP host config, so a foreground CLI run, a host-spawned MCP
child, and a hook worker all reach the same Notion workspace
and environment — pre-#188 the hook path forwarded only the three
Lore-namespaced legacy keys, leaving canonical `NOTION_API_TOKEN`
operators and multi-workspace ntn users with silent auth /
workspace divergence between foreground and hook code paths. The
child ntn-resolves directly off `auth.json` because that file is on
disk where the child can read it. If the
parent refreshed ntn (e.g., the operator re-ran `ntn login`)
before spawning the child, the child sees the updated `auth.json`
at startup. Empty-string values are skipped to mirror the install
allowlist's posture — a declared-but-empty var would otherwise
short-circuit `resolveAuth`'s priority chain in the spawned child.

**ntn-source partition (issue #475).** This **tightens the
existing posture rather than introducing a new one**: the
preceding paragraph already established the ntn-source child
re-reads `auth.json` directly because the file is on disk where
the child can read it. The partition makes that the _only_ path
under `ntn-auth-json`, never a parallel one — no `auth.json`
read AND env-forward of the same token, just the disk read.
When the foreground's resolved `AuthSource` is `ntn-auth-json`,
callers thread that source into `spawnBackgroundSave` via the
`authSource` option and the auth-token subset
(`RUNTIME_FORWARDED_AUTH_TOKEN_KEYS` — `NOTION_API_TOKEN`) is
dropped from `safeEnv`. The detached
child's `resolveAuth` lands at priority 2 (`loadNtnToken`)
without the bearer ever crossing the fork boundary in env. This
mirrors the install-time partition `buildMcpEnv` already applies
for `.mcp.json`. Workspace and base-URL selectors still forward
— the ntn-source child needs them to pick the same workspace as
the foreground. Non-ntn sources keep the legacy forward (their
callers explicitly accept token-in-env as part of their
contract). `helpers.handleStop` derives the source via
`resolveAuth(config, configRoot, { quiet: true })` once per Stop
fire and threads it through BOTH the autosave
`spawnBackgroundSave` AND the auto-digest helper-fork
`scheduleAutoDigestSpawn` (which spreads `process.env` and
deletes the auth-token subset under `ntn-auth-json` so the
detached `helpers.js auto-digest` child inherits everything
EXCEPT bearer tokens). `quiet: true` suppresses duplicate resolver
diagnostics during this synthetic auth check. A
`resolveAuth` failure (no token configured, transient `auth.json`
read error) falls back to the legacy every-key forward so the
Stop hot path itself never gains a new failure mode. The digest
paths (`fireDigestIfStale`, `lore digest`) read the source from
`services.authSource` so the foreground's already-resolved auth
isn't re-read from disk.

`LORE_USER_NAME` (DEFERRED-ATTRIBUTION) is forwarded so the spawned
MCP child resolves engineer identity via the synchronous env path
rather than paying a lazy `users.me` round-trip on its first
unattributed autosave write.
**The dominant case is unset, not set**: ntn-first engineers don't
typically export `LORE_USER_NAME` because they expect ntn-resolved
identity to "just work." For those operators, the spawned MCP child
falls through to `users.me` only if the save omits an explicit
author. Realistic latency: <100ms; under load the identity probe is
one entry in the rate-limit gate's queue. Operators on slow networks
(or who otherwise want the resolution off the write path) export
`LORE_USER_NAME` in shell rc and the spawned child's synchronous env
path resolves identity for free.

**Mid-process ntn re-resolution is bounded in the MCP server.** The
autosave child still resolves its own credentials at startup, then
invokes tools on the MCP server. For those tool calls, an MCP server
that started from `ntn-auth-json` re-runs auth resolution after the
first 401, rebuilds the SDK client when the token or base URL changed,
and retries the failed request once. Static token sources keep the old
behavior: the 401 surfaces, and a subsequent child starts with fresh
credentials only if its launch environment or config changed. `lore
auth --login` refreshes ntn auth; it does not refresh canonical
env-token children.

**Canonical-path child never reads `auth.json` at all (#188).** When
the parent has `NOTION_API_TOKEN` set, the forward lands in the
child's `safeEnv` and `resolveAuth` priority 1 wins at child startup
— the child never reaches the ntn-resolve branch. So an `auth.json`
refresh that lands between the Stop fire and the child's first
Notion call doesn't reach the child. This matches the existing
"mid-process re-resolution is deferred" posture, but tightens the
asymmetry between the two auth sources: ntn-source children read
disk fresh on each spawn (and pick up a between-spawn refresh on
the next fire); canonical-token children inherit the parent's
snapshot of `NOTION_API_TOKEN` and only see a refresh once the
parent's env catches up. For short-lived autosave windows this is
the right tradeoff; operators on the canonical path who rotate
tokens mid-session must restart the parent assistant for the new
token to reach hook workers.

### Atomic-learning extraction (0.9.0/08)

The autosave prompt asks the spawned sub-agent to do two things in one
spawn: write the session synopsis it has always written, AND identify
_atomic learnings_ — single-fact discoveries from the session ("bcrypt
cost=12 is the right balance for our load.") — and save each as its own
`note` memory. Extraction happens entirely inside the background
sub-agent's reasoning. The foreground agent has no convention to learn
and no `## Key Learnings:` section to enumerate; user-visible output is
unchanged.

Per-spawn cap: at most `PER_SPAWN_LEARNING_LIMIT` atomic learnings per
autosave run (currently 5; see `prompts.ts`). A noisy session that
surfaces 30 candidate facts must rank by durability and skip the long
tail — the next session's autosave will catch anything truly important
that the prior run dropped (transcripts overlap).

Foreground/background dedup has a structural autosave-learning gate plus
a prompt-level search probe. The save path treats background
`source: "conversation"`, `kind: "note"`, `confidence: "likely"` saves
with a session id as atomic-learning-shaped and checks existing likely
conversation notes before creating a row. Explicit project saves and
non-catch-all resolved projects use exact project-set reuse; projectless
and catch-all fallback saves use same-session reuse. The service layer
repeats the blocking check under a filesystem lock immediately before
create, so a future direct-write hook path must call `MemoryService.create`
or `createWithResult` rather than bypassing the service. The same lock
stays held through bounded post-create query-index stabilization, so the
next local autosave does not probe Notion before the just-created row is
visible.
If a later autosave restates the same likely-note learning (including
simple title/body reordering), `lore-memory action='save'` returns the
existing row instead of creating another one. When project scope is not
available, or the only project is the auto-resolved monorepo catch-all,
the gate falls back to the original same-session check rather than scanning
across the catch-all.
Unscoped legacy learning rows can be reused by later scoped saves, but
scoped project sets still have to match exactly: an A-only row does not
block an A+B save.
This gate does not apply to synopsis-style saves (`confidence` omitted
or non-`likely`) so the session-level memory stays independent from the
per-learning rows. The prompt therefore requires `confidence: "likely"`
on every atomic learning; using `"certain"` intentionally opts out of
the structural learning gate and should not be used by autosave
learning extraction.

The prompt still tells the sub-agent to probe `lore-query
action='search'` (scoped to the same project, seeded by the candidate's
title or distinctive terms) for older or cross-session near-matches.
`action='search'` — not `action='ask'` — is the right probe: `ask` walks
the fact / task graph by entity, so it would miss any foreground
`lore-memory action='save'` row whose title doesn't already carry a
matching fact edge. `lore-query` stays in the autosave's
`DEFAULT_SAVE_ALLOWLIST` for that cross-session check.

The block does not introduce a new `MemorySource` value. Atomic
learnings inherit `source: "conversation"` (the existing autosave
default). Differentiating learnings from other conversation-sourced
memories at the schema level would surface a _mechanism_ (autosave
extracted this) rather than a _kind_, and the existing source values
track mechanisms, not kinds.

**Compaction interaction.** Claude Code compaction reduces the
transcript visible to the autosave's `claude -p`. A session that hits
compaction mid-work loses the pre-compaction transcript content, so any
learnings buried in the compacted region won't be extracted by the
post-Stop autosave. This is a known limitation of the autosave path —
not a regression introduced by 0.9.0/08.

#### Kill switches

Two coordinated knobs disable the extraction block; either set to
disabled wins (AND-of-permissive — both must be permissive for the
block to ship).

- `LORE_DISABLE_LEARNING_EXTRACTION=1` — env var, runtime override.
  Anti-foot-gun: only the literal string `"1"` disables. Other
  truthy-looking values (`"true"`, `"yes"`) fall through to the
  permissive branch.
- `LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1` — env var, runtime
  rollback for the structural autosave-learning reuse gate only, including
  both same-session dedup and exact-project cross-session reuse. Learning
  extraction still runs; the save path simply stops blocking duplicate
  learning rows. The shared `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` also
  disables this gate because it is a near-duplicate probe by another name.
- `hooks.learningExtraction: false` — `.lore.yaml`, persistent.
  Defaults to `true` in `mergeHookDefaults`.

When either knob disables extraction (env var set to `"1"` OR
`hooks.learningExtraction` set to `false` — note that the two knobs
have opposite polarities, so neither "both true" nor "both false"
captures the disabling state), `helpers.ts` passes
`{ extractLearnings: false }` to `buildBackgroundSavePrompt` and the
prompt reproduces the 0.8.x synopsis-only shape byte-for-byte. Same
posture as the existing `hooks.autoDigest: false` knob.

#### Proposed-by-default routing (issue #281, AC #1)

`hooks.proposeAutosaveLearnings: true` in `.lore.yaml` opts a fleet
into routing every auto-extracted learning through the
proposed-memory review inbox. When set, `mergeHookDefaults`
resolves `proposeAutosaveLearnings: true` on the merged
`HookConfig`, `helpers.ts` derives `proposeLearnings = true` (gated
on `learningExtraction` being permissive — there's no learning
block to gate when extraction is off), and the prompt builder adds
a `status: "proposed"` instruction to the per-learning save block.
The autosave sub-agent then writes every atomic learning with
`Status = proposed`, which keeps the row out of default recall
(see `MemoryService.list` / `search` / `queryStaleConfidence`'s
`includeProposed` flag) and surfaces it in the wake-up
`Proposed Memories` section and the `lore status` inbox-count line
until a reviewer approves it via `lore inbox approve <id>` (CLI) or
`lore-memory action='approve'` (MCP), or rejects it via the matching
`reject` surfaces.

Default is `false` — existing installs see byte-identical autosave
behavior. The trust boundary this knob enables: a fleet of agents
managed by many engineers can opt into review-before-share so a
noisy session cannot pollute recall for everyone before a human or
authorized agent approves the learning.

### Auto-digest (Stop-triggered, detached)

After every accepted `Stop` event the hook also spawns a separate detached
node child to run the `auto-digest` helper action. The child loads
`.lore.yaml`, honors `hooks.autoDigest: false` and `LORE_AUTO_DIGEST=false`,
and delegates to `fireDigestIfStale`. The marker debounce in
`digest-marker.ts` guarantees ≤ 1 digest per project per 7 days even if
`Stop` fires every minute.

Two-process split is load-bearing:

- The parent `Stop` hook never gathers digest data, never initializes a
  Notion client. Stop's `{}` emission stays in-the-millisecond regardless
  of how stale the digest marker is.
- The child runs the heavy work asynchronously. Any failure inside the
  child is logged to `[lore]` stderr and swallowed — the parent has
  already exited.

Known exception under #475: the parent Stop path now derives the
foreground's resolved `AuthSource` once per fire via
`deriveStopAuthSource` (in `helpers.ts`) so both spawn paths apply
the same env partition. This adds one `auth.json` `readFile` plus a
dynamic import of `auth/ntn.js` to the parent's hot path for
ntn-source operators (cached by ESM after the first call, so
subsequent fires within the same process — which is rare since
`lore hooks autosave` is a fresh process per Stop — pay only the
disk read). Defensive try/catch falls back to the legacy every-key
forward on rejection so the Stop path itself never gains a new
failure mode. Per-source cost reflects `resolveAuth`'s priority
walk: `NOTION_API_TOKEN`-source operators short-circuit at
priority 1 with zero I/O; ntn-source operators pay the priority-2
`auth.json` read + `auth/ntn.js` dynamic import.
The "in-the-millisecond" budget claim still holds (the readFile is
small and the failure-to-resolve path is fast), and the "never
initializes a Notion client" claim still holds — the new I/O is
filesystem-only, not network.

`scheduleAutoDigestSpawn` (in `digest-scheduler.ts`) is the parent-side
fork helper; `handleAutoDigest` (in `helpers.ts`) is the child-side
handler.

### SessionEnd compatibility shim

Active SessionEnd registration was removed in 0.6.0 (issue 26). Stale
`~/.claude/.../settings.json` entries pointing at
`hooks/session-end.sh` keep firing `node dist/hooks/helpers.js
session-end` for one release cycle; the action resolves with no work,
no transcript parse, no save spawn, no stderr noise. `lore install
--client claude` strips Lore-owned SessionEnd entries on reinstall.

A future release may delete both `hooks/session-end.sh` and the
`session-end` switch case once operators have had a release cycle to
refresh their installs.

## Wake-up flow

Wake-up fires once per session and injects project context into the host
assistant before the first reply. P3-05 changed it from a context-blind
session-start dump into a relevance-ranked surface seeded by the user's
actual question.

| Hook                           | Trigger                  | User query?          |
| ------------------------------ | ------------------------ | -------------------- |
| Claude Code `UserPromptSubmit` | First user message       | Yes (`event.prompt`) |
| Codex `UserPromptSubmit`       | First user message       | Yes (`event.prompt`) |
| Legacy Codex `SessionStart`    | Session startup / resume | No (default path)    |

The `lore hooks wakeup` dispatcher reads the JSON event off stdin and calls the
helper directly with `wakeup({ event: stdin })`. The legacy `hooks/wakeup.sh`
wrapper uses the env-var bridge, forwarding stdin as `LORE_WAKEUP_EVENT` before
invoking the helper. Current Codex installs use `UserPromptSubmit`, whose
payload includes `prompt`; older Codex installs wired wake-up to `SessionStart`,
which has no user message yet. A `SessionStart` payload still returns
`undefined`, dropping wake-up to the unranked output that matches the pre-P3-05
shape exactly.

`parseUserQueryFromEvent` (in `helpers.ts`) is the single point that
extracts the prompt; pin its tests when changing the parsing contract.
A malformed event, missing `prompt` field, or non-string `prompt` all
degrade to the same default path — wake-up never crashes for an
input-shape regression.

Codex does not expose Claude Code's `runOnce` flag on `UserPromptSubmit`, so
`wakeup()` owns a per-session filesystem marker
(`$TMPDIR/lore-hook-state/<session>.wakeup`). After `hooks.wakeUp` opt-out and
config discovery pass, the first prompt-bearing event atomically creates the
marker with `O_EXCL` before Notion initialization. The marker means "wake-up
was attempted for this session": slash-command prompts, service init failures,
and transient `loadWakeUpData` failures are still debounced so Codex does not
retry a decorative Notion path every turn. Later prompts in the same session
return before Notion initialization. After `/clear` or a topical pivot inside
the same Codex session, agents should explicitly rerun the MCP surface with
`lore-context action='wake-up' userQuery='<new task prompt>'` to get fresh
ranked context.

### Ranked output sections

When a user query is present the hook tightens per-section caps via
`RANKED_WAKEUP_LIMITS` (memory: 3, related: 2, knowledge: 10,
taskMemories: 3) and adds a top-of-output **For Your Current Task**
section seeded by `MemoryService.search(userQuery)`.
The section is omitted entirely on the default path so unranked
output stays identical to the pre-P3-05 shape.

`RANKED_WAKEUP_LIMITS` lives in `src/core/wakeup.ts` and is shared
with the MCP `lore-context action='wake-up'` handler — both surfaces
fall back to the same caps when `userQuery` is set and the caller
hasn't overridden a section. Tighten the constant in one place and
both surfaces pick it up. (PF3-04.)

`taskMemories` is deduped against digest, recents, AND `relatedMemories`
in the data layer (`loadWakeUpData` in `src/core/wakeup.ts`) so the
same memory never renders across the three memory sections. The user
query is truncated to 1000 chars before search so a pasted log doesn't
blow Notion's query budget or drown relevance.

### Operator log

`LORE_DEBUG=1` emits one stderr line per wake-up attempt in the same
`[lore] <subsystem>: key=value` shape as the `[lore] partial-failure:`
line in `src/mcp/AGENTS.md`. The line is intentionally content-free: no
query text, memory titles, fact text, or page bodies, only mode, caps,
digest freshness, and counts. Successful loads include section counts; cache
hits and load failures use the same formatter with zero counts so operators can
aggregate attempt outcomes without stitching together separate log schemas.
Examples below are wrapped for readability; the hook emits each event as one
line.

```
[lore] wakeup: mode=ranked ranked=true queryLen=42 memory=3 related=2
knowledge=10 taskMemories=3 digestAvailable=true digestFresh=true
digestAgeDays=1 sections.digest=1 sections.currentTask=3 sections.recent=3
sections.related=2 sections.tasks=10 sections.facts=10 sections.decisions=0
sections.proposedDecisions=0 sections.overdueDecisions=0
sections.proposedMemories=0 sections.staleConfidence=0

[lore] wakeup: mode=default ranked=false reason=no-ranked-search
digestAvailable=false digestFresh=false digestAgeDays=none sections.digest=0
sections.currentTask=0 sections.recent=10 sections.related=5 sections.tasks=10
sections.facts=25 sections.decisions=0 sections.proposedDecisions=0
sections.overdueDecisions=0 sections.proposedMemories=0
sections.staleConfidence=0

[lore] wakeup: mode=default ranked=false reason=already-ranked-for-session
digestAvailable=false digestFresh=false digestAgeDays=none sections.digest=0
sections.currentTask=0 sections.recent=0 sections.related=0 sections.tasks=0
sections.facts=0 sections.decisions=0 sections.proposedDecisions=0
sections.overdueDecisions=0 sections.proposedMemories=0
sections.staleConfidence=0

[lore] wakeup: mode=error ranked=false reason=load-failed digestAvailable=false
digestFresh=false digestAgeDays=none sections.digest=0 sections.currentTask=0
sections.recent=0 sections.related=0 sections.tasks=0 sections.facts=0
sections.decisions=0 sections.proposedDecisions=0 sections.overdueDecisions=0
sections.proposedMemories=0 sections.staleConfidence=0
```

The ranked variant reports the per-section caps applied so an operator
triaging "why is wake-up surfacing only 3 memories?" can confirm the
ranked path fired without chasing the constant. The default variant means
the user-query relevance search did not run; on legacy Codex `SessionStart`
that is expected, while on `UserPromptSubmit` it usually points at event
forwarding or project-scope issues. The already-ranked variant confirms
Codex's per-session `UserPromptSubmit` debounce fired before any Notion calls.
The error variant records failed loads (`reason=load-failed`) so flaky Notion
sessions are visible in coverage aggregation instead of disappearing behind the
decorative wake-up failure path.
The `sections.*` values are the first supported wake-up coverage counters:
use them to compare signal density across digest, current-task, recent,
related, task, fact, decision, and stale-confidence sections while tuning caps
and ranking. They are per-firing counters rather than relevance-quality
scores, so aggregate multiple lines before tuning; precision / recall /
memory-lift quality measurement belongs to the eval harness. Gated behind
`LORE_DEBUG=1` because unconditional logging would flood stderr on every
session. `lore status` and `lore-context action='status'` render the same
content-free coverage line on demand.

The hook's wake-up call passes `includeProposedMemories: false` because
the hook's wake-up render never includes the inbox section. As a
result, `sections.proposedMemories` in the hook `LORE_DEBUG=1` log is
always `0` by design — the depth signal that issue #281 surfaces lives
on the MCP `lore-context action='wake-up' debug=true` output and the
`lore status` coverage line, both of which fan out the
`countProposed` query the hook deliberately skips. An operator who
wants to monitor inbox depth from the shell uses `lore status`, not
the wake-up hook log.

## Concurrency guard

Two `Stop` hooks firing for the same session in quick succession would race
on the same transcript and create duplicate memories. `lock.ts` prevents
this:

- One lock file per session: `$TMPDIR/lore-hook-state/<sessionId>.lock`
- The file contains the PID of the owning detached `claude -p` child
- `tryAcquireSessionLock(sessionId, ownerPid)` uses `O_EXCL` (`wx`) for
  atomic create-if-absent — only one concurrent caller wins
- A lock is "held" iff its owner PID is still alive; `hasActiveSessionLock`
  sweeps stale entries by probing `process.kill(pid, 0)`
- Global cap: `MAX_CONCURRENT_SAVES = 5`. Beyond that, new spawns are
  skipped rather than queued — missed saves are recovered by the next
  `Stop` (only if the prior spawn was rejected — the save counter does
  not advance on rejection).

`spawnBackgroundSave` spawns the child first, then calls
`tryAcquireSessionLock` with the child's PID. If the O_EXCL write fails
(another concurrent hook got there first), the loser SIGTERMs its own
child and bails — so there is never a hand-off window where the lock's
owner PID has not yet been assigned to a real process.

The lock is "released" implicitly when its owner PID is reaped — there is
no exit handler on the detached `claude -p`. Stale lock files are cleaned
up lazily by the next acquire attempt.

## Background save observability

The detached `claude -p` runs with `stdio: ["stdin", "ignore", logFd]`
where `logFd` opens `$TMPDIR/lore-hook-state/<sessionId>.log` in
truncate-write mode (`"w"`, mode `0o600`). Each save gets a clean
postmortem; the file reflects only the most recent save attempt, not an
unbounded append across the session. When a save crashes, `tail` the file:

```
tail -f $TMPDIR/lore-hook-state/<sessionId>.log
```

Without this, save failures were invisible outside of the silent process
exit code.

## Adding a handler

1. Add a `case` to the `main()` switch in `helpers.ts`.
2. Accept a `HookEvent` parsed from the relevant env var.
3. If the handler triggers a save, read the transcript via
   `readTranscriptForSave(event, label)` — this shares the malformed-line
   diagnostics between paths.
4. If the handler spawns a background agent, route through
   `spawnBackgroundSave(cwd, prompt, sessionId)` so the lock + log-file
   machinery applies.
5. Fail open: any exception caught in the top-level `main().catch` should
   let the agent continue. Autosave in particular writes `{}\n` to stdout
   and exits `0`.
