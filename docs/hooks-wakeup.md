# Hook Wake-Up Runtime

This document owns the current wake-up hook contract: context loading, ranked
output, per-session debounce, and debug counters. Keep hook routing and handler
registration guidance in `src/hooks/AGENTS.md`.

## Wake-Up Flow

Wake-up fires once per session and injects project context into the host
assistant before the first reply. Current Claude Code and Codex installs use
`UserPromptSubmit`, which lets Lore rank memories against the user's first real
prompt.

| Hook                           | Trigger                  | User query?          |
| ------------------------------ | ------------------------ | -------------------- |
| Claude Code `UserPromptSubmit` | First user message       | Yes (`event.prompt`) |
| Codex `UserPromptSubmit`       | First user message       | Yes (`event.prompt`) |
| Legacy Codex `SessionStart`    | Session startup / resume | No (default path)    |

The `lore hooks wakeup` dispatcher reads the JSON event off stdin and calls the
helper directly with `wakeup({ event: stdin })`. The legacy `hooks/wakeup.sh`
wrapper uses the env-var bridge, forwarding stdin as `LORE_WAKEUP_EVENT` before
invoking the helper.

Current Codex installs include `prompt` in the `UserPromptSubmit` payload.
Older Codex installs wired wake-up to `SessionStart`, which has no user message
yet. A `SessionStart` payload returns `undefined` from the prompt parser and
drops wake-up to the unranked output path.

`parseUserQueryFromEvent` in `helpers.ts` is the single point that extracts the
prompt. Pin its tests when changing the parsing contract. A malformed event,
missing `prompt` field, or non-string `prompt` all degrade to the same default
path. Wake-up must not crash for input-shape regressions.

## Context Loading

Wake-up loads the latest project digest when one was saved in the last 7 days,
plus recent memories, active facts, and memories relevance-matched against the
user's first prompt when the hook event provides one. Automatic hook wake-up
passes `taskLimit: 0`, so it skips task inventory and the task-seeded
related-memory query. Task triage belongs behind explicit `lore-task` calls or
the MCP `lore-context action='wake-up'` surface, not automatic session-start
prompt material.

The hook's wake-up render passes `includeProposedMemories: false`, so it never
includes the proposed-memory inbox section. Inbox depth belongs to `lore status`
and the MCP `lore-context action='wake-up' debug=true` output.

If `.lore.yaml` fails to parse, wake-up falls back to the default enabled state
and writes a `[lore]` warning to stderr. If no auth source resolves, wake-up
logs a `[lore] wakeup: init failed - No Notion auth configured...` diagnostic
and returns without injecting context.

## Per-Session Debounce

Codex does not expose Claude Code's `runOnce` flag on `UserPromptSubmit`, so
`wakeup()` owns a per-session filesystem marker:

```text
$TMPDIR/lore-hook-state/<session>.wakeup
```

After `hooks.wakeUp` opt-out and config discovery pass, the first
prompt-bearing event atomically creates the marker with `O_EXCL` before Notion
initialization. The marker means wake-up was attempted for this session.
Slash-command prompts, service init failures, and transient `loadWakeUpData`
failures are still debounced so Codex does not retry a decorative Notion path
every turn. Later prompts in the same session return before Notion
initialization.

After `/clear` or a topical pivot inside the same Codex session, agents should
explicitly rerun the MCP surface:

```text
lore-context action='wake-up' userQuery='<new task prompt>'
```

If the marker cannot be written because the hook state directory is read-only,
full, or inaccessible, wake-up fails open. It logs
`[lore] wakeup: debounce mark failed` to stderr and still tries to inject
context for that prompt. Since no marker landed, later prompt events in the same
session can re-run the full wake-up path until state-dir writes recover or the
session ends. This is local hook-state degradation, not a detached background
job failure, so `lore status` does not report it under **Background hooks**.

## Ranked Output

When a user query is present, the hook tightens per-section caps via
`RANKED_WAKEUP_LIMITS`:

| Section                        | Ranked cap |
| ------------------------------ | ---------- |
| `memory`                       | 3          |
| `related` (active-task seeded) | 0          |
| `knowledge`                    | 10         |
| `taskMemories`                 | 3          |

Ranked wake-up adds a top-of-output **For Your Current Task** section seeded by
`MemoryService.search(userQuery)`. The section is omitted on the default path so
unranked output keeps the same shape used by promptless wake-up events.

`RANKED_WAKEUP_LIMITS` lives in `src/core/wakeup.ts` and is shared with the MCP
`lore-context action='wake-up'` handler for user-query ranking caps. The hook
starts from those caps, then applies `relatedMemoryLimit: 0` and `taskLimit: 0`
so the active-task-seeded Related section stays empty even though the MCP
surface still renders it by default. `relatedMemoryLimit` controls that
active-task-entity query, not the user-query-seeded **For Your Current Task**
section.

`taskMemories` is deduped against digest and recents in `loadWakeUpData` in
`src/core/wakeup.ts`, so the same memory never renders across the hook memory
sections. The user query is truncated to 1000 chars before search so pasted
logs do not overwhelm Notion query budget or relevance.

## Operator Log

`LORE_DEBUG=1` emits one stderr line per wake-up attempt in the
`[lore] <subsystem>: key=value` shape. The line is content-free: no query text,
memory titles, fact text, or page bodies. It reports only ranked/default mode,
full/task-only shape, caps, digest freshness, and counts.

Successful loads include section counts. Cache hits and load failures use the
same formatter with zero counts so operators can aggregate outcomes without
stitching together separate log schemas. The examples below are wrapped for
readability; the hook emits each event as one line.

```text
[lore] wakeup: mode=ranked shape=full ranked=true queryLen=42 memory=3 related=0
knowledge=10 taskMemories=3 digestAvailable=true digestFresh=true
digestAgeDays=1 sections.digest=1 sections.currentTask=3 sections.recent=3
sections.related=0 sections.tasks=0 sections.facts=10 sections.decisions=0
sections.proposedDecisions=0 sections.overdueDecisions=0
sections.proposedMemories=0 sections.staleConfidence=0
sections.pinnedContext=0 sections.inheritedMemories=0

[lore] wakeup: mode=default shape=full ranked=false reason=no-ranked-search
digestAvailable=false digestFresh=false digestAgeDays=none sections.digest=0
sections.currentTask=0 sections.recent=10 sections.related=0 sections.tasks=0
sections.facts=25 sections.decisions=0 sections.proposedDecisions=0
sections.overdueDecisions=0 sections.proposedMemories=0
sections.staleConfidence=0 sections.pinnedContext=0
sections.inheritedMemories=0

[lore] wakeup: mode=default shape=full ranked=false reason=already-ranked-for-session
digestAvailable=false digestFresh=false digestAgeDays=none sections.digest=0
sections.currentTask=0 sections.recent=0 sections.related=0 sections.tasks=0
sections.facts=0 sections.decisions=0 sections.proposedDecisions=0
sections.overdueDecisions=0 sections.proposedMemories=0
sections.staleConfidence=0 sections.pinnedContext=0
sections.inheritedMemories=0

[lore] wakeup: mode=error shape=full ranked=false reason=load-failed digestAvailable=false
digestFresh=false digestAgeDays=none sections.digest=0 sections.currentTask=0
sections.recent=0 sections.related=0 sections.pinnedContext=0
sections.inheritedMemories=0 sections.tasks=0 sections.facts=0
sections.decisions=0 sections.proposedDecisions=0 sections.overdueDecisions=0
sections.proposedMemories=0 sections.staleConfidence=0
```

The ranked variant reports the per-section caps applied so operators can confirm
that the ranked path fired. The default variant means the user-query relevance
search did not run. On legacy Codex `SessionStart`, that is expected; on
`UserPromptSubmit`, it usually points at event forwarding or project-scope
issues. The already-ranked variant confirms Codex's per-session debounce fired
before any Notion calls. The error variant records failed loads as
`reason=load-failed`.

`sections.*` values are wake-up coverage counters. Use them to compare signal
density across digest, current-task, recent, related, pinned-context,
inherited-memory, task, fact, decision, and stale-confidence sections while
tuning caps and ranking. They are per-firing counters rather than
relevance-quality scores, so aggregate multiple lines before tuning. Precision,
recall, and memory-lift quality measurement belong to the eval harness.

The hook wake-up log always reports `sections.proposedMemories=0`,
`sections.pinnedContext=0`, and `sections.inheritedMemories=0` because the hook
render skips the inbox and governance-channel queries by design. Use
`lore status` to monitor proposed-memory inbox depth from the shell. `lore status` and
`lore-context action='status'` render the same content-free coverage line on
demand.
