# Hook Background Runtime

This document owns background hook contracts: detached agent configuration,
failure markers, auto-digest, lock behavior, and log files. Keep autosave
prompt and learning behavior in `docs/hooks-autosave.md`; keep wake-up context
loading and ranked output in `docs/hooks-wakeup.md`.

## Background-Agent Configuration

The Stop-spawn autosave and Stop-spawn auto-digest paths shell out to a detached
agent CLI. The default is `claude -p` with these args, preserved for Claude Code
compatibility:

```json
[
  "-p",
  "--allowedTools",
  "{{allowedTools}}",
  "--dangerously-skip-permissions",
  "--no-session-persistence",
  "--model",
  "sonnet"
]
```

Operators can swap the binary by name. Preset args resolve automatically:

```yaml
hooks:
  backgroundAgent:
    command: codex
```

They can also use the env override:

```bash
export LORE_BACKGROUND_COMMAND=codex
```

Unsupported binaries must supply `args` explicitly:

```yaml
hooks:
  backgroundAgent:
    command: aider
    args: ["--no-pretty", "--message-from-stdin"]
```

Resolution order:

| Field     | Precedence (highest first)                                                                                                                                   |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command` | `LORE_BACKGROUND_COMMAND` env > `hooks.backgroundAgent.command` in `.lore.yaml` > derived from `LORE_AGENT_NAME` via `AGENT_BACKGROUND_COMMAND` > `"claude"` |
| `args`    | `hooks.backgroundAgent.args` in `.lore.yaml` > preset for the resolved `command` through basename-aware `lookupCommandPreset` > `DEFAULT_BACKGROUND_ARGS`    |

The agent-context tier makes Codex installs work without per-project
`.lore.yaml` setup. The Codex installer prefixes every hook command with
`LORE_AGENT_NAME=Codex`, so `mergeHookDefaults` derives `command: codex`.
Claude Code installs do not set `LORE_AGENT_NAME`, so they fall through to the
historical `claude` default.

Lore ships presets for `claude` and `codex` in `KNOWN_COMMAND_PRESETS` in
`src/hooks/config.ts`. Preset lookup is basename-aware, so absolute paths such
as `/opt/homebrew/bin/codex` and bare `codex` both pick up the Codex preset.
Adding a preset requires a one-line constant change plus a test in
`config.test.ts`. Adding an agent-name to command mapping requires a change to
`AGENT_BACKGROUND_COMMAND`.

The Codex preset uses the Codex exec form with workspace-write sandboxing and
the no-git-repo-check flag. Keep the preset and its tests aligned when changing
those args.

There is no env path for `args` because the value is structurally an array and
env vars are scalar. Use `.lore.yaml` for args so quoting remains explicit.

The `{{allowedTools}}` token (`ALLOWED_TOOLS_PLACEHOLDER` in `config.ts`) inside
`args` is replaced at spawn time with the tool allowlist string:

- `DEFAULT_SAVE_ALLOWLIST` for autosave
- `DIGEST_ALLOWLIST` for digest

Operators whose CLI does not accept an allowlist flag can omit the placeholder.
The spawn primitive skips the handoff, and the agent's allowlist must be
configured out-of-band. For Codex, that means `mcp_servers.lore.allowed_tools`
in `.codex/config.toml`. The install-time path emits a `Note:` line when the
resolved args lack the placeholder.

The merged shape lives on `HookConfig.backgroundAgent` and is threaded through
`helpers.handleStop`, `digest-scheduler.fireDigestIfStale`,
`core/synopsis-backfill.backfillSynopses`, and the `lore digest` CLI through
`mergeHookDefaults(services.config.hooks)`. Direct callers of
`spawnBackgroundSave` that omit the `agent` option use the built-in defaults.

Both `runClaudeInstall` and `runCodexInstall` in `cli/commands/install.ts` call
`resolveBackgroundAgentForInstall` and `printBackgroundAgentSummary`, so
operators see install-time warnings for independent failure bands:

- Binary missing: the resolved command is not on `PATH`.
- Unknown command without preset: the binary exists but no preset supplies args,
  so args fall through to the Claude-shaped default.
- Allowlist handoff missing: the resolved args lack `{{allowedTools}}`, so the
  agent allowlist must be configured out-of-band.

`LORE_BACKGROUND_COMMAND` is the canonical operator-scoped knob for redirecting
the background agent. The matching `.lore.yaml` shape is also canonical.

## Background Failure Markers

`background-failure-marker.ts` owns the local health breadcrumbs that
`lore status` renders under **Background hooks**. Files live in `getStateDir()`
(`$LORE_HOOK_STATE_DIR` when set, otherwise `$TMPDIR/lore-hook-state/`) next to
locks, logs, digest markers, and drift markers. Filenames are isolated with the
`background-failure.` prefix, the config-root key, the failure kind, and a short
hash of the operator-actionable scope.

The active marker key is recoverable scope, not session scope:
`kind + config root + project name` (project omitted for vault-level cases).
The latest `sessionId` stays in the JSON body for diagnosis, but it must not
make a new file per Stop hook session.

A later success for the same kind and project clears only markers whose
`occurredAt` is strictly older than the pre-spawn recovery boundary, so a
concurrent fresh failure survives stale success cleanup. Writers use sync
tmp-file plus POSIX rename on the Stop hot path. Same-key concurrent writes are
last-writer-wins because the status surface is the latest observed failure for
that scope.

Writers opportunistically prune stale files for the same config root. Readers
prune malformed, unknown-version, unknown-kind, wrong-root, and stale files.
Stale means older than 14 days, chosen as one missed weekly digest window plus
slack for an operator to run `lore status`.

Current `BackgroundFailureKind` values:

| Kind                       | Observes                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------- |
| `autosave`                 | Foreground Stop hook failures before the detached autosave child successfully starts              |
| `digest-scheduler`         | Detached auto-digest helper init/gather failures before synthesis spawn                           |
| `digest-synthesizer`       | Auto-digest synthesis spawn setup failures such as `binary-missing`, tempfile, or spawn exception |
| `auto-digest-helper-spawn` | Foreground Stop hook failure to fork the detached `helpers.js auto-digest` child                  |

The supervision boundary is narrow by design. Markers cover failures the
foreground process or helper can directly observe at spawn, init, or gather
time. Lore does not supervise detached background agents through final process
exit, so a child that spawns successfully and later crashes will not create a
background-failure marker. User-facing status renderers should report the clean
state as no observed failures, not healthy.

Wake-up's per-session debounce marker is outside this subsystem. If its
`getStateDir()` write fails with a non-`EEXIST` error, wake-up logs
`[lore] wakeup: debounce mark failed` and fails open without creating a
background-failure marker or `lore status` row.

When adding a new kind, update the `BackgroundFailureKind` union,
`BACKGROUND_FAILURE_KINDS`, `formatBackgroundFailureKind`, and
`backgroundFailureHint`, then add tests for write/read/clear, stale pruning,
and status rendering. Only attach `logPath` when the target log file can exist;
`binary-missing` and tempfile setup failures happen before child stderr is
opened.

## Auto-Digest

After every accepted `Stop` event, the hook spawns a separate detached Node child
to run the `auto-digest` helper action. The child loads `.lore.yaml`, honors
`hooks.autoDigest: false` and `LORE_AUTO_DIGEST=false`, and delegates to
`fireDigestIfStale`. The marker debounce in `digest-marker.ts` guarantees at
most one digest per project per 7 days even if `Stop` fires every minute.

The two-process split is load-bearing:

- The parent Stop hook never gathers digest data and never initializes a Notion
  client. Stop's `{}` emission stays in the millisecond-scale hot path.
- The child runs the heavy work asynchronously. Any failure inside the child is
  logged to `[lore]` stderr and swallowed because the parent has already exited.

The parent Stop path derives the foreground's resolved `AuthSource` once per
fire via `deriveStopAuthSource` in `helpers.ts`, so autosave and auto-digest use
the same env partition. For ntn-source operators, that adds one `auth.json`
read plus a cached dynamic import of `auth/ntn.js`. A defensive try/catch falls
back to the legacy every-key forward on rejection, so the Stop path itself does
not gain a new failure mode.

Digest paths that already have initialized services, including
`fireDigestIfStale` and `lore digest`, read the source from
`services.authSource` instead of re-reading auth from disk.

`scheduleAutoDigestSpawn` in `digest-scheduler.ts` is the parent-side fork
helper. `handleAutoDigest` in `helpers.ts` is the child-side handler.

## Concurrency Guard

Two `Stop` hooks firing for the same session in quick succession would race on
the same transcript and create duplicate memories. `lock.ts` prevents this:

- One lock file per session: `$TMPDIR/lore-hook-state/<sessionId>.lock`
- The file contains the PID of the owning detached background child
- `tryAcquireSessionLock(sessionId, ownerPid)` uses `O_EXCL` (`wx`) for atomic
  create-if-absent
- A lock is held iff its owner PID is still alive; `hasActiveSessionLock` sweeps
  stale entries by probing `process.kill(pid, 0)`
- Global cap: `MAX_CONCURRENT_SAVES = 5`. Beyond that, new spawns are skipped
  rather than queued. Missed saves are recovered by the next `Stop` only if the
  prior spawn was rejected, because the save counter does not advance on
  rejection.

`spawnBackgroundSave` spawns the child first, then calls
`tryAcquireSessionLock` with the child's PID. If the `O_EXCL` write fails, the
loser SIGTERMs its own child and bails, so there is no handoff window where the
lock owner PID has not been assigned to a real process.

The lock is released implicitly when its owner PID is reaped. There is no exit
handler on the detached background agent. Stale lock files are cleaned up lazily
by the next acquire attempt.

## Background Save Observability

The detached background agent runs with:

```text
stdio: ["stdin", "ignore", logFd]
```

`logFd` opens `$TMPDIR/lore-hook-state/<sessionId>.log` in truncate-write mode
(`"w"`, mode `0o600`). Each save gets a clean postmortem. The file reflects only
the most recent save attempt for that session, not an unbounded append.

When a save crashes, inspect the file:

```bash
tail -f $TMPDIR/lore-hook-state/<sessionId>.log
```

## SessionEnd Compatibility

The `session-end` action exists only as an exit-0 compatibility shim for stale
installed settings. It performs no transcript parse, save spawn, or stderr
output. `lore install --client claude` strips Lore-owned SessionEnd entries on
reinstall.
