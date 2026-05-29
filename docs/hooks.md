# Hooks

Hook commands automate Lore integration with supported AI coding assistants.
Default installs use bin dispatch (`lore hooks <event>`, or
`yarn run -T lore hooks <event>` under Yarn PnP). The `hooks/*.sh` scripts are
legacy compatibility entrypoints for older absolute-path installs.

Developer/runtime details are split by flow:

- [`hooks-autosave.md`](hooks-autosave.md) - Stop autosave, auth handoff,
  learning extraction, and review-inbox routing.
- [`hooks-wakeup.md`](hooks-wakeup.md) - context loading, ranked wake-up output,
  per-session debounce, and debug counters.
- [`hooks-background.md`](hooks-background.md) - background-agent config,
  failure markers, auto-digest, locks, logs, and compatibility shims.

## Auto-Save

`lore hooks autosave` runs on the assistant `Stop` hook, emits `{}` immediately,
and spawns a detached background save after enough user messages. It works in
both Claude Code and Codex; Yarn PnP installs invoke it as
`yarn run -T lore hooks autosave`. The Stop hook also schedules a detached
auto-digest helper, off the hot path, so a stale weekly project digest is
regenerated without blocking the user's next turn.

The autosave sub-agent extracts atomic learnings from the session and saves
each as its own `note` memory. Two `.lore.yaml` flags govern this behavior:

- `hooks.learningExtraction: false` — disable atomic-learning extraction
  entirely. The autosave reverts to the synopsis-only shape. Default `true`.
  Also honored via `LORE_DISABLE_LEARNING_EXTRACTION=1` env override; either
  knob set to disabled wins.
- `hooks.proposeAutosaveLearnings: true` — route every auto-extracted
  learning through the proposed-memory review inbox (`Status = proposed`).
  Default `false` so existing installs see byte-identical autosave behavior.
  When enabled, the rows are filtered out of default
  `lore-query action='recall'` / `lore-context action='wake-up'` until a
  reviewer approves or rejects them; inbox depth surfaces in `lore status`'s
  Proposed memories line and the wake-up Proposed Memories section. Has no
  effect when `learningExtraction` is `false`.

Autosave capture policy is separate from whether hooks are installed:

- `hooks.memoryCaptureMode: durable` — default production mode. The autosave
  prompt preserves durable engineering knowledge: gotchas, decisions, runbooks,
  facts, and out-of-scope open loops.
- `hooks.memoryCaptureMode: conversational` — explicit opt-in for broad chat
  recall. The autosave prompt preserves user-stated preferences, personal or
  work context, reminders, commitments, and other future-useful conversational
  facts that the durable filter intentionally skips. Conversational capture
  defaults auto-captured memory saves to `Status = proposed`; reviewers approve
  or reject them before they enter default recall. Disabling learning extraction
  also suppresses conversational capture and falls back to durable synopsis-only
  autosave.

Selecting `profile: conversational@1.0.0` without a `hooks.memoryCaptureMode`
override also activates conversational autosave semantics, including proposed
routing. Set `hooks.memoryCaptureMode: durable` explicitly only when you want
that profile's non-hook surfaces without broad hook capture.

## Shared-vault hook configuration

For shared-vault deployments where many engineers share a single Lore
workspace, set `hooks.proposeAutosaveLearnings: true` in `.lore.yaml` for
durable mode. This routes every auto-extracted learning through the
proposed-memory review inbox (`Status = proposed`) instead of writing it
directly to accepted recall. Conversational mode applies the proposed-memory
route by default because broad recall can be noisier than engineering autosave.
The trust boundary keeps a noisy session from polluting recall for everyone
before a human reviewer approves the learning. Reviewers act on the inbox via
`lore inbox list` / `lore inbox approve <id>` /
`lore inbox reject <id>` / `lore inbox archive <id>` (CLI), or
`lore-memory action='approve'` / `lore-memory action='reject'` (MCP); both
surfaces share the same `MemoryService.recordReview` service path and append a
`## Reviewed (YYYY-MM-DD)` audit block with the reviewer + timestamp. Both
terminal verdicts drop the row out of the proposed-memory inbox: `approve`
makes it eligible for default recall, `reject` keeps it off default recall
	(the `reviewTerminalStatusExclusionFilters` default-exclude on
	`MemoryService.list` / `search` covers both `proposed` and `rejected`), so
	neither verdict pollutes shared recall with
	noisy auto-extractions. The inbox depth also surfaces in `lore status`'s
**Proposed memories** line and the wake-up **Proposed Memories** section.

Single-engineer / personal-vault deployments can leave the flag at its
`false` default — the inbox surface still exists if the engineer manually
saves with `status: "proposed"`, but autosave-learning saves go straight into
recall.

## Wake-Up

`lore hooks wakeup` loads the latest project digest, if one was saved in the
last 7 days, plus recent memories, active facts, and query-ranked memories when
the host supplies the user's first prompt. Yarn PnP installs invoke it as
`yarn run -T lore hooks wakeup`. Automatic wake-up deliberately skips task
inventory and task-seeded related-memory retrieval; agents that need task state
should call `lore-task` or the MCP `lore-context action='wake-up'` surface
explicitly.

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

If the per-session marker cannot be written because the hook state directory is
read-only, full, or inaccessible, wake-up fails open: it logs
`[lore] wakeup: debounce mark failed` to stderr and still tries to inject
context for that prompt. Since no marker landed, later prompt events in the same
session can re-run the full wake-up path until state-dir writes recover or the
session ends. This is a local hook-state degradation, not a detached background
job failure, so `lore status` does not report it under **Background hooks**;
triage the stderr line and the permissions / capacity of `$LORE_HOOK_STATE_DIR`
or `$TMPDIR/lore-hook-state/`.

Set `LORE_DEBUG=1` to inspect wake-up coverage counters on stderr. The log line
does not include query text, memory titles, facts, or page bodies; it reports
only the retrieval mode, wake-up shape, ranked caps, digest freshness, and
per-section counts. Use `mode=ranked|default|error` and
`shape=full|task-only` to verify whether the user-query ranker actually ran,
`reason=already-ranked-for-session` to identify Codex debounce
cache hits, `reason=load-failed` to count failed wake-up loads, `digestFresh` /
`digestAgeDays` to judge whether the digest is carrying the session, and
`sections.*` counts to spot when wake-up is too noisy or too thin. Operators
with alerts or saved greps for the older `reason=no-user-query` key should
update them to `reason=no-ranked-search`, which covers every unranked wake-up
fallback. The same vocabulary includes `sections.pinnedContext` and
`sections.inheritedMemories`; the hook reports both as zero because automatic
wake-up does not render those governance channels. These are per-firing
counters, not relevance-quality scores;
aggregate multiple lines before tuning caps, and use the eval harness for
precision / recall / memory-lift quality measurements. The same content-free
line is also visible in `lore status` and `lore-context action='status'` for
on-demand inspection.

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

When the foreground resolved auth via `ntn-auth-json`, the bearer-token subset
(`NOTION_API_TOKEN`) is dropped from the spawned child's env — the child
re-reads `~/.config/notion/auth.json` directly and lands on the same token
without it ever crossing the fork boundary. Workspace and
base-URL selectors still forward so multi-workspace ntn setups pick the same
workspace as the foreground. This mirrors the install-path partition
`buildMcpEnv` already applies for `.mcp.json` (issue #475). Other auth sources
keep the legacy every-key forward.

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
