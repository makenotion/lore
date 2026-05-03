# Hooks

Hook commands automate Lore integration with supported AI coding assistants.
Default installs use bin dispatch (`lore hooks <event>`, or
`yarn run -T lore hooks <event>` under Yarn PnP). The `hooks/*.sh` scripts are
legacy compatibility entrypoints emitted only by `lore install --legacy-paths`.

## Auto-Save

`lore hooks autosave` runs on the assistant `Stop` hook, emits `{}` immediately,
and spawns a detached background save after enough user messages. It works in
both Claude Code and Codex; Yarn PnP installs invoke it as
`yarn run -T lore hooks autosave`. The Stop hook also schedules a detached
auto-digest helper, off the hot path, so a stale weekly project digest is
regenerated without blocking the user's next turn.

## Wake-Up

`lore hooks wakeup` loads the latest project digest, if one was saved in the
last 7 days, plus recent memories, active facts, and any memories
relevance-matched against active task entities. Yarn PnP installs invoke it as
`yarn run -T lore hooks wakeup`. It performs one semantic query scored against
memory titles and bodies, so the context behind each outstanding task comes in
alongside the task itself.

Claude Code and current Codex installs inject wake-up context on
`UserPromptSubmit`, which lets Lore rank memories against the user's first real
prompt. Legacy Codex installs used `SessionStart`; that event has no prompt, so
it still falls back to unranked output until the project reruns
`lore install --client codex`.

Codex does not provide Claude Code's `runOnce` flag for `UserPromptSubmit`, so
Lore keeps its own per-session debounce marker and skips later prompt events
before initializing Notion. The marker records the first enabled
`UserPromptSubmit` attempt, even when the prompt is a slash command or a
transient Notion failure prevents context injection, so Codex does not retry the
same decorative wake-up path every turn. After `/clear` or a topic pivot inside
the same Codex session, call the MCP surface explicitly with
`lore-context action='wake-up' userQuery='<new task prompt>'` to refresh ranked
context. Set `hooks.wakeUp: false` in `.lore.yaml` to skip automatic injection
for supported assistants. If `.lore.yaml` fails to parse, the hook falls back to
the default (on) and writes a `[lore]` warning to stderr.

Set `LORE_DEBUG=1` to inspect wake-up coverage counters on stderr. The log line
does not include query text, memory titles, facts, or page bodies; it reports
only the retrieval mode, ranked caps, digest freshness, and per-section counts.
Use `mode=ranked|default` to verify whether the user-query ranker actually ran,
`digestFresh` / `digestAgeDays` to judge whether the digest is carrying the
session, and `sections.*` counts to spot when wake-up is too noisy or too thin.
Operators with alerts or saved greps for the older `reason=no-user-query` key
should update them to `reason=no-ranked-search`, which covers every unranked
wake-up fallback.
These are per-firing counters, not relevance-quality scores; aggregate multiple
lines before tuning caps, and use the eval harness for precision / recall /
memory-lift quality measurements.

## Auth Forwarding

Hooks resolve Notion auth through the same priority chain as the CLI and MCP
server. Stop-triggered background saves build a minimal runtime environment in
`spawnBackgroundSave`: `PATH`, `HOME`, `LORE_AUTOSAVE=false`,
`LORE_BACKGROUND_AGENT=true`, and any live non-empty key from the
`RUNTIME_FORWARDED_KEYS` allowlist in `src/auth/forwarded-env.ts` (auth tokens,
workspace selector, base-URL selectors, and user attribution override). The
background child does not receive `LORE_CONFIG_ROOT`; it discovers `.lore.yaml`
by walking upward from the hook event's cwd. ntn-backed setups read
`~/.config/notion/auth.json` from the operator's home directory.

If no source resolves, wake-up logs a `[lore] wakeup: init failed — No Notion
auth configured...` diagnostic and returns without injecting context. Autosave's
foreground Stop path still emits `{}`; auth is resolved later by the detached
background child / MCP path, so failures surface in background logs instead of
blocking the hook response.

## Compatibility Notes

`hooks/session-end.sh` is kept as an exit-0 compatibility shim for Claude Code
settings written before 0.6.0; new installs no longer register a SessionEnd
hook. Re-running `lore install --client claude` strips any stale Lore-owned
SessionEnd entries from `~/.claude/.../settings.json`.

Codex also requires the project to be trusted before it will load project-scoped
`.codex/*` files.
