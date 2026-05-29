# Hook Autosave Runtime

This document owns the current autosave runtime contract. Keep hook routing and
handler registration guidance in `src/hooks/AGENTS.md`; keep background spawn,
digest, lock, marker, and log details in `docs/hooks-background.md`.

## Autosave Flow

Autosave fires on `Stop` only and spawns a detached background sub-agent that
writes structured content through Lore MCP tools. The main agent is never
blocked.

| Hook            | Trigger                                                                         | Prompt builder              |
| --------------- | ------------------------------------------------------------------------------- | --------------------------- |
| `Stop` autosave | `userMessages - lastSavedAt >= saveInterval` (first save: min(saveInterval, 2)) | `buildBackgroundSavePrompt` |

The `Stop` path always emits `{}\n` and offloads save work to a background
process. The spawned sub-agent has no prior context and receives the transcript
inline through the prompt.

## Auth Handoff

The detached child resolves its own credentials at startup through the same
`resolveAuth` path the parent uses, against `event.cwd`.
`spawnBackgroundSave` passes `cwd` directly to `child_process.spawn`, and the
child's `findConfigFile` walks upward from that cwd to locate `.lore.yaml`.
`LORE_CONFIG_ROOT` is not forwarded.

This differs from the long-running MCP server child that `lore install` writes
config for. MCP server children may receive static `LORE_CONFIG_ROOT` values
because they are launched by a host-controlled cwd and can outlive the current
project shell. Hook autosave children run once per Stop event and inherit the
parent hook cwd, so upward `.lore.yaml` discovery is the contract.

The parent builds a minimal `safeEnv` for the child:

- `PATH`
- `HOME`
- `LORE_AUTOSAVE=false`, so the child cannot recursively trigger autosave
- `LORE_BACKGROUND_AGENT=true`, so the child's MCP server fails fast on init
  errors instead of staying alive as a diagnostic server
- Every non-empty key in `RUNTIME_FORWARDED_KEYS` from
  `src/auth/forwarded-env.ts`: `NOTION_API_TOKEN`, `LORE_NOTION_BASE_URL`,
  `NOTION_WORKSPACE_ID`, `NOTION_ENV`, `NOTION_BASE_URL`,
  `NOTION_API_BASE_URL`, and `LORE_USER_NAME`

The same allowlist drives `lore install` host-config placeholders, so foreground
CLI runs, host-spawned MCP children, and hook workers target the same Notion
workspace and environment.

When the foreground's resolved `AuthSource` is `ntn-auth-json`, callers thread
that source into `spawnBackgroundSave` with the `authSource` option. The
auth-token subset (`RUNTIME_FORWARDED_AUTH_TOKEN_KEYS`, currently
`NOTION_API_TOKEN`) is then dropped from `safeEnv`. The detached child lands on
priority 2 (`loadNtnToken`) by reading `~/.config/notion/auth.json` directly,
without the bearer token crossing the fork boundary in env. Workspace and base
URL selectors still forward so the child picks the same workspace and
environment as the foreground.

Non-ntn sources keep the env-token forward because those callers explicitly use
token-in-env as part of their contract. If `resolveAuth` fails while deriving
the Stop auth source, the Stop hot path falls back to the legacy every-key
forward instead of gaining a new failure mode.

`LORE_USER_NAME` forwards engineer identity into the spawned MCP child through
the synchronous env path. When it is unset, the child can still fall through to
`users.me` if a save omits an explicit author.

For MCP tool calls made by an autosave child, an MCP server that started from
`ntn-auth-json` re-runs auth resolution after the first 401, rebuilds the SDK
client if the token or base URL changed, and retries the failed request once.
Static token sources surface the 401 and rely on the next spawned child to pick
up any changed launch environment or config.

When the parent has `NOTION_API_TOKEN` set, the child resolves that env token at
priority 1 and never reads `auth.json`. Operators on the canonical env-token
path who rotate tokens mid-session must restart the parent assistant for the
new token to reach hook workers.

## Atomic-Learning Extraction

The autosave prompt asks the spawned sub-agent to write the session synopsis and
identify atomic learnings: single-fact discoveries from the session that should
be saved as their own `note` memories. Extraction happens inside the background
sub-agent. Foreground output is unchanged, and the foreground agent has no
`Key Learnings` convention to enumerate.

## Capture Modes

`hooks.memoryCaptureMode` selects the autosave capture policy:

- `durable` is the default production mode. It preserves engineering memories
  a future agent would need months later: non-obvious constraints, decisions,
  runbooks, system facts, and out-of-scope open loops.
- `conversational` is an explicit opt-in for broad chat recall. It preserves
  user-stated preferences, personal or work context, reminders, commitments,
  and similar future-useful conversational facts that the durable filter skips.
  It still rejects secrets, weak inferences, one-off small talk, and transcript
  summaries.

Conversational mode defaults its auto-captured memory saves to `Status =
proposed`, routing them through the proposed-memory inbox before default
recall. The durable mode keeps the historical accepted-by-default behavior
unless `hooks.proposeAutosaveLearnings: true` is set.

Selecting `profile: conversational@1.0.0` without a `hooks.memoryCaptureMode`
override also activates conversational autosave and the proposed-memory default.
Set `hooks.memoryCaptureMode: durable` explicitly when that profile should apply
outside hook autosave without broadening Stop-hook capture.

When `hooks.learningExtraction: false` or `LORE_DISABLE_LEARNING_EXTRACTION=1`
is active, conversational capture is suppressed with the learning block. The
autosave prompt falls back to the durable synopsis-only shape rather than
running broad recall capture without the per-spawn cap.

The session synopsis is a scan surface, not a session-history surface. It should
capture durable signal from the transcript, not a chronological "first/then"
activity log. Log-shaped synopses are reported by `lore debt scan` under
`summary_quality`.

Each autosave run may save at most `PER_SPAWN_LEARNING_LIMIT` atomic learnings
from `prompts.ts` (currently 5). A noisy session must rank by durability and
skip the long tail; overlapping transcripts let later autosaves recover
important misses.

Foreground/background dedup has a structural autosave-learning gate plus a
prompt-level search probe. The save path treats background
`source: "autosave_learning"`, `kind: "note"` saves with a session id as
atomic-learning-shaped and checks existing autosave-learning notes before
creating a row. Explicit project saves and non-catch-all resolved projects use
exact project-set reuse. Projectless and catch-all fallback saves use
same-session reuse.

The service layer repeats the blocking check under a filesystem lock immediately
before create, then keeps the lock through bounded post-create query-index
stabilization. Direct-write hook paths must call `MemoryService.create` or
`createWithResult` instead of bypassing the service. If a later autosave
restates the same autosave learning, `lore-memory action='save'` returns the
existing row instead of creating another one.

Project sets have to match exactly. An A-only row does not block an A+B save.
The gate does not apply to synopsis-style saves, so the session-level memory
stays independent from per-learning rows. The prompt must use
`source: "autosave_learning"` on every atomic learning; omitting that source
opts out of the structural learning gate and should not be used by autosave
learning extraction.

The prompt also tells the sub-agent to probe `lore-query action='search'`,
scoped to the same project and seeded by the candidate's title or distinctive
terms, for older or cross-session near-matches. `action='search'` is the right
probe because `action='ask'` walks the fact and task graph by entity and would
miss foreground `lore-memory action='save'` rows whose titles do not already
carry matching fact edges. `lore-query` remains in `DEFAULT_SAVE_ALLOWLIST` for
that cross-session check.

Atomic learnings use `source: "autosave_learning"`. The source marker lets the
save path apply autosave-specific duplicate blocking without overloading memory
confidence or ordinary conversation saves.

Vaults with autosave learnings written by older releases can run
`lore migrate --backfill-autosave-learning-source --project <name>` to preview
rows that still carry the retired autosave marker shape. Apply with
`lore migrate --backfill-autosave-learning-source --project <name> --yes` in a
quiet window. Use `--allow-unscoped` instead of `--project <name>` only for an
intentional vault-wide backfill.

Claude Code compaction can reduce the transcript visible to the autosave
background agent. Learnings that only appear in a compacted-away region will
not be extracted by a later Stop autosave.

## Kill Switches

Two coordinated knobs disable the extraction block. Either disabled setting
wins; both must be permissive for learning extraction to run.

- `LORE_DISABLE_LEARNING_EXTRACTION=1`: runtime override. Only the literal
  string `"1"` disables extraction.
- `hooks.learningExtraction: false`: persistent `.lore.yaml` setting. Defaults
  to `true` in `mergeHookDefaults`.

When either knob disables extraction, `helpers.ts` passes
`{ extractLearnings: false }` to `buildBackgroundSavePrompt`, and the prompt
uses the synopsis-only shape.

Two rollback knobs disable the structural autosave-learning reuse gate without
turning off extraction:

- `LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1`
- `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1`

Both disable same-session dedup and exact-project cross-session reuse for
autosave learning rows.

## Proposed Learning Routing

`hooks.proposeAutosaveLearnings: true` routes every auto-extracted learning
through the proposed-memory review inbox. When set, `mergeHookDefaults`
resolves `proposeAutosaveLearnings: true`, `helpers.ts` derives
`proposeLearnings = true` when learning extraction is also enabled, and the
prompt builder adds `status: "proposed"` to the per-learning save block.

The autosave sub-agent then writes each atomic learning with `Status = proposed`.
Those rows stay out of default recall until a reviewer approves them via
`lore inbox approve <id>` or `lore-memory action='approve'`, or rejects them
through the matching surfaces. Inbox depth appears in `lore status`, and the
MCP wake-up surface can render the Proposed Memories section for review. Default
is `false`, so existing installs keep the normal autosave behavior.
