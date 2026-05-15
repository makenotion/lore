# Hook Runtime History

This archive preserves historical issue and rollout notes for hook behavior.
Current runtime contracts live in:

- [`docs/hooks-autosave.md`](../hooks-autosave.md)
- [`docs/hooks-wakeup.md`](../hooks-wakeup.md)
- [`docs/hooks-background.md`](../hooks-background.md)

Do not add operational requirements here. If a detail is necessary to implement,
operate, or test current hooks, place it in the focused runtime doc instead.

## Background-Agent Configuration

Background-agent configurability was introduced under issue #194. The historical
default stayed `claude -p` with the original Claude-shaped args so Claude Code
installs kept byte-for-byte behavior unless operators opted into another
background agent. Codex support later used the installer-provided
`LORE_AGENT_NAME=Codex` marker to select the Codex preset automatically.

The schema drift marker was added during the 0.6.0 line to debounce
`VaultManager.load` drift checks by config root.

## Stop Blocking Removal

Older Stop-hook autosave injected `{"decision": "block"}` and forced an extra
agent turn. The current Stop path emits `{}\n` and offloads save work to a
background process so the user's next turn can start immediately.

## Auth Forwarding Evolution

The hook env allowlist used to forward only the three Lore-namespaced legacy
keys. The current `RUNTIME_FORWARDED_KEYS` allowlist also forwards canonical
Notion token, workspace, base-URL, and attribution variables so foreground CLI
runs, host-spawned MCP children, and hook workers target the same Notion
workspace and environment.

Issue #475 tightened the ntn-auth path. When foreground auth resolves from
`ntn-auth-json`, hook children re-read `~/.config/notion/auth.json` directly
instead of receiving `NOTION_API_TOKEN` through env. The same source partition
is applied to the auto-digest helper fork.

## Atomic-Learning Rollout

Atomic-learning extraction shipped as part of the 0.9.0 rollout. The foreground
agent intentionally did not gain a user-visible `Key Learnings` convention;
learning extraction happens inside the detached autosave sub-agent. The rollout
also documented the compaction limitation: content removed from the transcript
before Stop fires is not visible to the autosave background agent.

Issue #281 added `hooks.proposeAutosaveLearnings`, allowing shared-vault fleets
to route auto-extracted learnings into the proposed-memory inbox before they
enter default recall.

## Wake-Up Ranking

The wake-up hook originally used a context-blind session-start dump. The ranked
path changed current installs to seed wake-up context from the user's actual
first prompt and added the **For Your Current Task** section. The ranked caps
later moved to the shared `RANKED_WAKEUP_LIMITS` constant so hook and MCP
wake-up surfaces stay aligned.

## SessionEnd Compatibility

Active SessionEnd registration was removed in the 0.6.0 line. The
`session-end` helper action remains as an exit-0 shim for stale settings that
still invoke `hooks/session-end.sh`; reinstalling Lore removes those stale
entries from Claude Code settings.
