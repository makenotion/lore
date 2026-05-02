# AGENTS.md -- src/hooks/

> Read the root `AGENTS.md` first. This file covers the shell-hook layer only.

## Purpose

This directory implements Lore's hook runner. Shell hooks (Claude Code and
Codex) invoke `node dist/hooks/helpers.js <action>` at defined lifecycle
events; the helper reads the hook event from env vars, loads `.lore.yaml`,
and either injects context (`wakeup`) or spawns a background save
(`autosave`). The Stop hook also spawns a detached `auto-digest` helper
that owns digest synthesis off the hot path. The `session-end` action is
an exit-0 compatibility shim for stale Claude Code settings written before
0.6.0 dropped active SessionEnd registration.

## Files

| File              | Responsibility                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| `helpers.ts`      | Entry point: routes to `autosave` / `wakeup` / `auto-digest` / `session-end` handlers                  |
| `prompts.ts`      | Pure prompt builders for background-save sub-agents                                                    |
| `transcript.ts`   | Parse Claude Code / Codex transcript formats into messages                                             |
| `lock.ts`         | Per-session concurrency guard for background saves; owns `getStateDir()` for every marker in this dir |
| `config.ts`       | `.lore.yaml` `hooks` section defaults + merge                                                          |
| `digest-scheduler.ts` | `fireDigestIfStale` (in-child digest logic) + `scheduleAutoDigestSpawn` (parent-side detached fork off Stop) |
| `digest-marker.ts`| Per-config-root debounce marker for the auto-digest scheduler                                          |
| `drift-marker.ts` | Per-config-root debounce marker for `VaultManager.load`'s schema drift check (0.6.0 issue 02)          |
| `marker-key.ts`   | Shared `configKey()` and `safeFilenameSegment()` helpers for every filesystem marker, lock, log, and count file in this dir |

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
    command: codex   # picks up CODEX_BACKGROUND_ARGS preset (`exec --full-auto`)
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

| Field | Precedence (highest first) |
|---|---|
| `command` | `LORE_BACKGROUND_COMMAND` env > `hooks.backgroundAgent.command` in `.lore.yaml` > derived from `LORE_AGENT_NAME` (via `AGENT_BACKGROUND_COMMAND`) > `"claude"` |
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

`LORE_BACKGROUND_COMMAND` is NOT deprecation-tracked — unlike
`LORE_NOTION_TOKEN` (soft-deprecated 0.10.0; see root `AGENTS.md`'s
**Authentication** section), this env var is the canonical
operator-scoped knob for redirecting the background agent. The
matching `.lore.yaml` shape is also canonical. Both paths persist
through the deprecation horizon for `LORE_NOTION_TOKEN` and beyond.

## Autosave flow

Autosave fires on `Stop` only and spawns a detached `claude -p` sub-agent
that writes structured content via lore-\* MCP tools. The main agent is
**never** blocked.

| Hook              | Trigger                                                                         | Prompt builder            |
| ----------------- | ------------------------------------------------------------------------------- | ------------------------- |
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
server child that `lore install` writes config for: that one
*does* receive `LORE_CONFIG_ROOT` (post-#08; see
`src/cli/AGENTS.md`'s `## The install Command` →
`### 0.10.0 ntn detection and MCP env forwarding`). The two
spawn paths have different env contracts because they have
different lifetimes — the hook autosave child runs once per
Stop and inherits the parent's cwd, so upward search is
sufficient; the MCP server child is launched by the host
assistant from a cwd Lore can't predict, so the
`.lore.yaml` location must be passed explicitly.

The parent's env passthrough is deliberately minimal:
`spawnBackgroundSave` builds a `safeEnv` with `PATH`, `HOME`,
`LORE_AUTOSAVE: "false"` (so the child can't recursively trigger
its own autosave), `LORE_BACKGROUND_AGENT: "true"` (so the child's
MCP server fails fast on init errors instead of staying alive as a
diagnostic server), and every key in the shared
`RUNTIME_FORWARDED_KEYS` list (`src/auth/forwarded-env.ts`) when
the parent has it set: `NOTION_API_TOKEN`, `LORE_NOTION_TOKEN`,
`LORE_NOTION_BASE_URL`, `NOTION_WORKSPACE_ID`, `NOTION_ENV`,
`NOTION_BASE_URL`, `NOTION_API_BASE_URL`, and `LORE_USER_NAME`.
The same list drives `lore install`'s `${VAR}` placeholders for
MCP host config, so a foreground CLI run, a host-spawned MCP
child, and a hook worker all reach the same Notion workspace
and environment — pre-#188 the hook path forwarded only the three
Lore-namespaced legacy keys, leaving canonical `NOTION_API_TOKEN`
operators and multi-workspace ntn users with silent auth /
workspace divergence between foreground and hook code paths. The
legacy `LORE_NOTION_TOKEN` forwarding preserves access for
operators still on the soft-deprecated env var while they migrate;
under ntn-first the child ntn-resolves directly off `auth.json`
because that file is on disk where the child can read it. If the
parent refreshed ntn (e.g., the operator re-ran `ntn login`)
before spawning the child, the child sees the updated `auth.json`
at startup. Empty-string values are skipped to mirror the install
allowlist's posture — a declared-but-empty var would otherwise
short-circuit `resolveAuth`'s priority chain in the spawned child.

`LORE_USER_NAME` (DEFERRED-ATTRIBUTION) is forwarded so the spawned
MCP child resolves engineer identity via the synchronous env path
rather than paying a `users.me` round-trip on every autosave fire.
**The dominant case is unset, not set**: ntn-first engineers don't
typically export `LORE_USER_NAME` because they expect ntn-resolved
identity to "just work." For those operators, the spawned MCP child
falls through to `users.me` at startup, costing one extra Notion
round-trip per autosave fire. Realistic latency: <100ms; under load
each autosave is one entry in the rate-limit gate's queue. Operators
on slow networks (or who otherwise want the resolution off the hot
path) export `LORE_USER_NAME` in shell rc and the spawned child's
synchronous env path resolves identity for free.

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
*atomic learnings* — single-fact discoveries from the session ("bcrypt
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

Foreground/background dedup has a structural same-session gate plus a
prompt-level cross-session probe. The save path treats background
`source: "conversation"`, `kind: "note"`, `confidence: "likely"` saves
with a session id as atomic-learning-shaped and checks existing
likely conversation notes in that session before creating a row. If an
overlapping transcript window produces the same likely-note learning
twice (including simple title/body reordering), `lore-memory
action='save'` returns the existing row instead of creating another one.
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
memories at the schema level would surface a *mechanism* (autosave
extracted this) rather than a *kind*, and the existing source values
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
  rollback for the structural same-session gate only. Learning
  extraction still runs; the save path simply stops blocking duplicate
  learning rows. The shared `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1`
  also disables this gate because it is a near-duplicate probe by
  another name.
- `hooks.learningExtraction: false` — `.lore.yaml`, persistent.
  Defaults to `true` in `mergeHookDefaults`.

When either knob disables extraction (env var set to `"1"` OR
`hooks.learningExtraction` set to `false` — note that the two knobs
have opposite polarities, so neither "both true" nor "both false"
captures the disabling state), `helpers.ts` passes
`{ extractLearnings: false }` to `buildBackgroundSavePrompt` and the
prompt reproduces the 0.8.x synopsis-only shape byte-for-byte. Same
posture as the existing `hooks.autoDigest: false` knob.

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

| Hook                            | Trigger                  | User query? |
| ------------------------------- | ------------------------ | ----------- |
| Claude Code `UserPromptSubmit`  | First user message       | Yes (`event.prompt`) |
| Codex `SessionStart`            | Session startup / resume | No (fallback path) |

`wakeup.sh` reads the JSON event off stdin (Claude Code) and forwards it
to the helper as `LORE_WAKEUP_EVENT`. Codex's `SessionStart` event has
no user message yet — stdin is typically empty and the helper's parser
returns `undefined`, dropping wake-up to the unranked output that
matches the pre-P3-05 shape exactly.

`parseUserQueryFromEvent` (in `helpers.ts`) is the single point that
extracts the prompt; pin its tests when changing the parsing contract.
A malformed event, missing `prompt` field, or non-string `prompt` all
degrade to the same fallback path — wake-up never crashes for an
input-shape regression.

### Ranked output sections

When a user query is present the hook tightens per-section caps via
`RANKED_WAKEUP_LIMITS` (memory: 3, related: 2, knowledge: 10,
taskMemories: 3) and adds a top-of-output **For Your Current Task**
section seeded by `MemoryService.search(userQuery)`.
The section is omitted entirely on the fallback path so unranked
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

`LORE_DEBUG=1` emits one stderr line per wake-up firing in the same
`[lore] <subsystem>: key=value` shape as the `[lore] partial-failure:`
line in `src/mcp/AGENTS.md`. Two variants:

```
[lore] wakeup: ranked=true queryLen=42 memory=3 related=2 knowledge=10 taskMemories=3
[lore] wakeup: ranked=false reason=no-user-query
```

The ranked variant reports the per-section caps applied so an operator
triaging "why is wake-up surfacing only 3 memories?" can confirm the
ranked path fired without chasing the constant. The fallback variant
distinguishes the wakeup.sh-not-forwarding case from a ranked-but-
surprising-hits case — directing operators to fix the forwarder vs.
inspect the relevance index. Gated behind `LORE_DEBUG=1` because Codex
`SessionStart` *always* hits the fallback path, and an unconditional
log would flood stderr on every Codex session.

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
