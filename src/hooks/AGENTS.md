# AGENTS.md -- src/hooks/

> Read the root `AGENTS.md` first. This file covers the shell-hook layer only.

## Purpose

This directory implements Lore's hook runner. Shell hooks (Claude Code and
Codex) invoke `node dist/hooks/helpers.js <action>` at defined lifecycle
events; the helper reads the hook event from env vars, loads `.lore.yaml`,
and either injects context (`wakeup`) or spawns a background save (`autosave`
/ `session-end`).

## Files

| File            | Responsibility                                                        |
| --------------- | --------------------------------------------------------------------- |
| `helpers.ts`    | Entry point: routes to `autosave` / `wakeup` / `session-end` handlers |
| `prompts.ts`    | Pure prompt builders for background-save sub-agents                   |
| `transcript.ts` | Parse Claude Code / Codex transcript formats into messages            |
| `lock.ts`       | Per-session concurrency guard for background saves                    |
| `config.ts`     | `.lore.yaml` `hooks` section defaults + merge                         |

Tests for each module sit alongside it (`*.test.ts`). `helpers.ts` runs
`main()` only when invoked as the Node entry point (`dist/hooks/helpers.js`)
— when imported from a test file the `isEntryPoint()` guard skips it so
handlers can be unit-tested directly.

## Autosave flow

Autosave fires on two events and both paths spawn a detached `claude -p`
sub-agent that writes structured content via lore-\* MCP tools. The main
agent is **never** blocked.

| Hook              | Trigger                                                                         | Prompt builder          |
| ----------------- | ------------------------------------------------------------------------------- | ----------------------- |
| `Stop` (autosave) | `userMessages - lastSavedAt >= saveInterval` (first save: min(saveInterval, 2)) | `buildSessionEndPrompt` |
| `SessionEnd`      | `userMessages >= 2 && userMessages > lastSavedAt`                               | `buildSessionEndPrompt` |

Before P2-05 the `Stop` path injected `{"decision": "block"}` and forced an
extra agent turn. That pattern is gone: `Stop` now always emits `{}\n` and
offloads save work to a background process. The hook returns in
milliseconds and the user's next turn starts immediately.

Both paths share the same prompt because the spawned sub-agent has no prior
context and must receive the transcript inline.

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
`RANKED_WAKEUP_LIMITS` (memory: 3, related: 2, openLoops: 5,
knowledge: 10, taskMemories: 3) and adds a top-of-output **For Your
Current Task** section seeded by `MemoryService.search(userQuery)`.
The section is omitted entirely on the fallback path so unranked
output stays identical to the pre-P3-05 shape.

`taskMemories` is deduped against digest, recents, AND `relatedMemories`
in the data layer (`loadWakeUpData` in `src/core/wakeup.ts`) so the
same memory never renders across the three memory sections. The user
query is truncated to 1000 chars before search so a pasted log doesn't
blow Notion's query budget or drown relevance.

### Operator log

`LORE_DEBUG=1` emits `[lore] wakeup: no user query available — falling
back to unranked output.` to stderr when the helper hits the fallback
path. Useful for triaging "why didn't wake-up surface task-relevant
memories?" — the most common cause is `wakeup.sh` not forwarding stdin
(legacy hook, or a host assistant that fires wake-up off a non-prompt
event). Gated behind `LORE_DEBUG=1` because Codex `SessionStart`
*always* hits the fallback path, and an unconditional log would flood
stderr on every Codex session.

## Concurrency guard

Two hooks firing for the same session (e.g. a Stop hook fires while the
SessionEnd save for the same session is still running) would race on the
same transcript and create duplicate memories. `lock.ts` prevents this:

- One lock file per session: `$TMPDIR/lore-hook-state/<sessionId>.lock`
- The file contains the PID of the owning detached `claude -p` child
- `tryAcquireSessionLock(sessionId, ownerPid)` uses `O_EXCL` (`wx`) for
  atomic create-if-absent — only one concurrent caller wins
- A lock is "held" iff its owner PID is still alive; `hasActiveSessionLock`
  sweeps stale entries by probing `process.kill(pid, 0)`
- Global cap: `MAX_CONCURRENT_SAVES = 5`. Beyond that, new spawns are
  skipped rather than queued — missed saves are recovered by the next
  `Stop` (only if the prior spawn was rejected — the save counter does
  not advance on rejection) or by `SessionEnd`.

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
