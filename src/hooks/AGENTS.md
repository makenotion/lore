# AGENTS.md -- src/hooks/

> Read the root `AGENTS.md` first. This file covers the hook runner layer only.
> Runtime-flow contracts live in the linked hook docs below.

## Purpose

This directory implements Lore's hook runner. Default Claude Code and Codex
installs invoke `lore hooks <action>` at defined lifecycle events, or
`yarn run -T lore hooks <action>` under Yarn PnP. Older absolute-path installs
invoke `node dist/hooks/helpers.js <action>` through the checked-in
`hooks/*.sh` scripts.

The helper reads the hook event from stdin or env vars, loads `.lore.yaml`, and
routes to one of the supported handlers:

| Action        | Runtime flow                                                    | Detailed contract                                            |
| ------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| `autosave`    | Stop hook, detached save spawn, auth handoff, learning capture  | [`docs/hooks-autosave.md`](../../docs/hooks-autosave.md)     |
| `wakeup`      | User-prompt context injection, ranked retrieval, debug counters | [`docs/hooks-wakeup.md`](../../docs/hooks-wakeup.md)         |
| `auto-digest` | Detached digest helper spawned from accepted Stop hooks         | [`docs/hooks-background.md`](../../docs/hooks-background.md) |
| `session-end` | Exit-0 compatibility shim for stale installed settings          | [`docs/hooks-background.md`](../../docs/hooks-background.md) |

Historical rollout and issue provenance lives in
[`docs/archive/hooks-history.md`](../../docs/archive/hooks-history.md). Keep
current handler contracts in the runtime docs, not in the archive.

## Instruction Precedence

1. Root `AGENTS.md` sets repository-wide rules.
2. This file sets hook-runner routing, ownership, and handler-authoring rules.
3. Linked hook docs define current runtime-flow contracts.
4. Code and tests are the source of truth when docs and implementation diverge;
   fix the stale doc immediately.

When changing a hook behavior, update the focused doc for that flow in the same
PR. When adding historical context, place it in `docs/archive/hooks-history.md`
unless it is required to operate the current runtime.

## Files

| File                           | Responsibility                                                                                           |
| ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `helpers.ts`                   | Entry point: routes to `autosave`, `wakeup`, `auto-digest`, and `session-end` handlers                   |
| `prompts.ts`                   | Pure prompt builders for background-save sub-agents                                                      |
| `conversation-mining.ts`       | Awaitable counterpart to the detached background save spawn for deterministic replays and eval harnesses |
| `transcript.ts`                | Parse Claude Code and Codex transcript formats into messages                                             |
| `lock.ts`                      | Per-session concurrency guard for background saves; owns `getStateDir()` for hook state                  |
| `config.ts`                    | `.lore.yaml` `hooks` section defaults and merge logic                                                    |
| `digest-scheduler.ts`          | `fireDigestIfStale` in-child digest logic and `scheduleAutoDigestSpawn` parent-side fork                 |
| `digest-marker.ts`             | Per-config-root debounce marker for the auto-digest scheduler                                            |
| `drift-marker.ts`              | Per-config-root debounce marker for schema drift checks                                                  |
| `background-failure-marker.ts` | Bounded per-config-root health markers rendered by `lore status`                                         |
| `marker-key.ts`                | Shared `configKey()` and `safeFilenameSegment()` helpers for marker, lock, log, and count files          |

New marker modules under `src/hooks/` derive their config key and sanitize
free-form name segments via `marker-key.ts`. Do not reimplement the hash or the
regex in another module. The lock, log, count, and prompt identity paths rely on
the same policy so malformed `sessionId` values cannot escape `getStateDir()`
or inject prompt content into a spawned background agent.

The marker sanitizer is POSIX-oriented. Lore's hook runner already assumes POSIX
for process liveness probing and temp-dir state, so a future Windows port should
add reserved-device-name handling at the same boundary instead of widening the
regex.

Tests for each module sit alongside it as `*.test.ts`. `helpers.ts` runs
`main()` only when invoked as the Node entry point (`dist/hooks/helpers.js`);
imports from tests pass through the `isEntryPoint()` guard and can exercise
handlers directly.

## Handler Registration

Hook handlers are registered in the `main()` switch in `helpers.ts`. The current
actions are:

- `autosave`: reads the Stop event, parses the transcript, spawns a detached
  background save when the interval gate allows it, then schedules auto-digest.
- `wakeup`: reads the prompt event, applies the per-session debounce, and
  renders context before the host assistant's first response.
- `auto-digest`: child-side helper that loads services and delegates to the
  digest scheduler.
- `session-end`: compatibility action that exits successfully with no work.

Every handler must fail open. Exceptions caught by the top-level
`main().catch` should let the host assistant continue. Autosave must write
`{}\n` to stdout and exit `0` even when setup fails.

## Adding a Handler

1. Add a `case` to the `main()` switch in `helpers.ts`.
2. Accept a `HookEvent` parsed from stdin or the relevant env var.
3. If the handler triggers a save, read the transcript via
   `readTranscriptForSave(event, label)` so malformed-line diagnostics stay
   shared.
4. If the handler spawns a background agent, route through
   `spawnBackgroundSave(cwd, prompt, sessionId)` so the lock and log-file
   machinery applies.
5. Document the runtime contract in the focused hook doc, and add archive-only
   provenance to `docs/archive/hooks-history.md` when needed.
