# Lore Memory Workflows

Use Lore for knowledge that should survive the current session. The hook
autosave is a safety net; explicit saves are still the right tool for decisions,
gotchas, durable facts, and tracked follow-up work.

## What To Save

- **Decisions**: use `lore-decision action='create'` for architectural choices,
  rationale, alternatives, consequences, and review dates. Pass `affects: [...]`
  to auto-create `decided_by` facts.
- **Memories**: use `lore-memory action='save'` for non-obvious discoveries,
  debugging insights, gotchas, and workarounds that are not formal decisions.
- **Facts**: use `lore-fact action='create'` for relationships between system
  components, such as `uses`, `depends_on`, or `is_a`. Lore rejects fact
  creation without resolvable provenance: pass an existing `sourceMemoryId`, or
  pass `agent` and `session` matching an earlier memory saved in the same
  process.
- **Tasks**: use `lore-task action='create'` for tracked work such as open PRs,
  blocked dependencies, and follow-up investigations. Close tasks as soon as
  they are done or cancelled.

When a fact becomes stale, invalidate it with `lore-fact action='invalidate'`.
That action also halves the originating memory's numeric `Confidence Score`, so
use it for real contradictions rather than soft uncertainty.

For recurring corpus hygiene — low-trust memories, orphan facts, overdue
governance, duplicate clusters, topic sprawl, ownerless rows, and scope
anomalies — run [`lore debt scan`](./memory-debt.md) periodically. The
scanner is read-only by default; `docs/memory-debt.md` describes the seven
categories, scoring, recommended monthly cadence, and the opt-in
`lore debt create-tasks` Phase-2 surface.

## Confidence

The Memories database carries two confidence columns:

- `Confidence` is categorical and agent-set: `certain`, `likely`, or
  `speculative`. Set it honestly on writes when the default does not match your
  stance.
- `Confidence Score` is numeric and system-managed. Reads bump it, contradiction
  signals decrement it, and old untouched memories decay toward zero.

Do not try to write `Confidence Score` directly. The categorical value expresses
your stance; the numeric score accumulates evidence over time.

## Conflict Verdicts

`lore-memory action='compare'` accepts six verdicts for a pair of memories.
`memoryIdA` and `memoryIdB` are unordered labels. For asymmetric verdicts, pass
`affectedMemoryId` to name the memory whose score should be reduced. For
symmetric verdicts, omit it.

| Verdict | Direction | Meaning |
| ------- | --------- | ------- |
| `conflicts_with` | Asymmetric | A and B make incompatible factual claims in the same scope. `affectedMemoryId` names the contradicted memory. |
| `supersedes` | Asymmetric | Decision-kind affected targets only. The other memory is the later, more accurate decision. `affectedMemoryId` names the superseded decision. |
| `scoped` | Symmetric | A and B differ, but the difference is explained by project, time, environment, or other scope. |
| `related` | Symmetric | A and B share a subject but make non-overlapping claims. |
| `compatible` | Symmetric | A and B make near-identical claims. Consider updating one memory if one should become canonical. |
| `not_conflict` | Symmetric | A and B are about unrelated subjects. |

For non-decision memories that need to be replaced by a new synthesis, do not
use `supersedes`. Either update/archive the old memory manually, or promote the
synthesis into a formal decision and archive the old non-decision memory.

When `lore conflicts scan` surfaces candidate pairs, judge each pair with this
vocabulary and call `lore-memory action='compare'` once per pair. The
non-actionable verdicts also record that the pair has already been judged, so
future scans skip it.

## Topic Keys

Use `topicKey` when saving a memory about a recurring topic: a governance
decision, runbook, incident, postmortem, or policy that may evolve. The save
path upserts on `Topic Key` plus identical project relation set. A matching
memory receives a revision block instead of a new row.

Use stable kebab-case paths grouped by kind:

- `decision/jwt-auth-model`
- `runbook/database-migration`
- `incident/login-redirect-502`
- `postmortem/payment-gateway-timeout`
- `policy/data-retention`
- `procedure/cache-miss-investigation`

If unsure, call `lore-memory action='suggest-topic-key'` with the title and
kind. Do not use `topicKey` on `kind: 'note'` or `kind: 'task'`.

When an upsert chain grows beyond roughly 5 KB or 5 revisions, the save response
surfaces a promotion advisory. For decision chains, promote the synthesis into a
fresh formal decision. For non-decision chains, split into narrower topic keys
or archive the broad chain and start a more specific one.

To re-key a misnamed first save, pass `topicKey` to
`lore-memory action='update'`. Re-keying appends a `## Re-keyed (YYYY-MM-DD)`
audit block but does not bump `Revision Count`. Combining `topicKey` with
`kind` in a single update is rejected.

## Passive Learning Extraction

The Stop-triggered background autosave reviews the session transcript and saves
a session synopsis. It can also identify atomic learnings and save each as its
own memory.

Foreground agents should still save important decisions and discoveries
explicitly. Do not add a visible `## Key Learnings:` section to user-facing
responses, and do not double-save a discovery you already wrote explicitly.

Operators can disable extraction with `LORE_DISABLE_LEARNING_EXTRACTION=1` or
`hooks.learningExtraction: false` in `.lore.yaml`.

For shared-vault deployments, set `hooks.proposeAutosaveLearnings: true` in
`.lore.yaml` to route every auto-extracted learning through the
proposed-memory review inbox (`Status = proposed`) instead of writing it
directly into accepted recall. Default is `false` so existing installs see
byte-identical autosave behavior. When enabled, the rows are filtered out of
default `lore-query action='recall'` / `lore-context action='wake-up'` until
a reviewer approves or rejects them via `lore inbox` (CLI:
`lore inbox list`, `lore inbox approve <id>`, `lore inbox reject <id>`,
`lore inbox archive <id>`) or `lore-memory action='approve' / 'reject'`
(MCP). Both surfaces share the same `MemoryService.recordReview`
service path and append a `## Reviewed (YYYY-MM-DD)` audit block with
the reviewer + timestamp. Both terminal verdicts drop the row out of
the proposed-memory inbox: `approve` makes it eligible for default
recall, `reject` keeps it off default recall (the
`reviewTerminalStatusExclusionFilters` default-exclude on
`MemoryService.list` / `search` / `queryStaleConfidence` covers
both `proposed` and `rejected`), so neither verdict pollutes shared
recall with noisy auto-extractions. The inbox depth surfaces in
`lore status`'s Proposed memories line and the wake-up Proposed
Memories section. Has no effect when `hooks.learningExtraction` is
`false` — there is no learning save to gate.

Atomic learning saves are deduplicated more strictly than ordinary memory
saves. In background-agent runs, a `source: "conversation"`, `kind: "note"`,
`confidence: "likely"` save with a session id checks likely conversation notes
before creating a row. Project-scoped autosaves reuse same-project-set matches
across sessions, including legacy unscoped rows; projectless and catch-all
fallback autosaves stay same-session scoped. If Lore cannot read the duplicate
candidate set, the autosave learning save fails before creating a possible
duplicate. To force a separate row during recovery or migration, set
`LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1` for that autosave run.

## Procedures (Reusable Procedural Memories)

Procedures are reviewed, fleet-wide operating knowledge promoted from
resolved episodes — closed tasks, resolved incidents, postmortems,
and high-confidence notes. Adapted from LangMem's
episodic / semantic / procedural taxonomy: episodes stay inspectable
history, while `kind: "procedure"` memories carry the "when this
situation appears, this sequence worked" guidance an agent reaches
for. Procedures always require human or authorized-agent review
before they become fleet-wide; raw session summaries never become
procedures silently.

The lifecycle is three steps:

1. **Mine candidates.** Run `lore procedures scan` (CLI) or
   `lore-procedure action='scan-candidates'` (MCP). Both are
   read-only. Lore walks the project's resolved
   incidents / postmortems / runbooks plus closed tasks, clusters
   them by entity, and surfaces ranked candidate groups (cluster
   key, supporting source ids, score). A cluster requires at least
   two supporting memories before it surfaces.
2. **Propose.** Distill the resolution shape into a procedure via
   `lore procedures propose --title ... --entity ... --activation ...
--step ... --source <id> --source <id>` (CLI) or
   `lore-procedure action='propose'` (MCP). The propose path creates a
   `kind: "procedure", Status: proposed` memory with structured
   activation conditions, ordered steps (each must be non-blank
   after trim — a stepless or whitespace-only step is rejected at
   the schema boundary), optional known failure modes, and `##
   Sources` pointing back to the supporting episodes. At least two
   `sourceMemoryIds` are required (mirrors the scan's
   `PROCEDURE_MIN_SOURCES = 2` threshold) so the propose path can
   never bypass the auditable evidence trail. Pass `supersedesIds`
   when replacing an older procedure or runbook. Body sections are
   pinned so the wake-up surface can label rows distinctly.
3. **Approve.** Review and approve via the existing inbox surface
   (`lore inbox approve <id>` CLI or `lore-memory action='approve'`
   MCP). Approved procedures flip to `Status: accepted` and surface
   in default recall / wake-up, labeled `procedure` in the meta
   line. Reject via `lore inbox reject <id>` if the candidate
   isn't worth shipping; both approve and reject append a
   `## Reviewed (YYYY-MM-DD)` audit block recording the reviewer.

Procedures can be deprecated via `lore procedures deprecate <id>`
(CLI) or `lore-procedure action='deprecate'` (MCP). Deprecate
rejects `Status: proposed` rows — those must leave the inbox via
`lore inbox reject` so the `## Reviewed (YYYY-MM-DD)` audit block
lands with the reviewer identity. Deprecate is idempotent on
already-deprecated rows.

**Supersession** is a two-step workflow: at propose time, pass
`supersedesIds: [<old-procedure-id>]` so the new row's
`Supersedes` relation records the chain. After approval, run
`lore procedures deprecate <old-id> --reason "Superseded by
<new-id>"` to flip the predecessor out of accepted recall. The
propose response surfaces ready-to-paste deprecate commands when
`supersedesIds` is set, so the workflow is explicit and
operator-visible. The `lore-memory action='compare'` path with
`verdict: 'supersedes'` is **decision-only**: the compare handler
rejects non-decision kinds, so it cannot replace a procedure.

Activation conditions are also replicated to the memory's
`Keywords` field so hybrid search picks up procedures whose
activation entity matches the user's current query.

## Task Hygiene

- Create tasks for work that needs cross-session tracking.
- Close tasks with `lore-task action='close'` as soon as work completes.
- Use `done` for completed work and `cancelled` for abandoned or superseded
  work.
- When saving a memory that resolves tracked work, check wake-up context for
  related active tasks and close any resolved ones.

## Migrating From Unscoped Writes

Older vaults may contain memories or facts whose `Project` relation is empty.
Those rows usually mean "repo-wide" context, but during operator migrations an
omitted project scope is easy to confuse with "run this for my current project."

Project-capable migrations therefore require an explicit scope decision. Pass
`--project <name>` to target one project; the discovery query includes rows in
that project plus unscoped rows so shared repo context can still be repaired.
Pass `--allow-unscoped` only when you intentionally want the migration to scan
the whole vault. Pass `--include-archived` with `--project` when repairing data
for a retired project.

This applies to `--fix-fact-encoding`, `--fix-memory-encoding`,
`--build-entities`, `--normalize-agents`, `--backfill-fact-sources`,
`--backfill-synopses`, `--build-confidence-scores`, and
`--build-fact-confidence-scores`.

Recommended flow:

1. List candidates: `lore status projects -a`
2. Preview: `lore migrate --fix-memory-encoding --project "Widget" --dry-run`
3. Apply: `lore migrate --fix-memory-encoding --project "Widget" --yes`

If a project name is missing, archived, or inaccessible, Lore aborts before the
plan or write phase. Transient Notion lookup failures such as 429s and 5xxs are
reported as retryable project-resolution errors; retry them rather than
switching to `--allow-unscoped`.

## MCP Tool Checklist

- Session start: `lore-context action='wake-up'`
- After `/clear` or a topic pivot: `lore-context action='wake-up'` with
  `userQuery` set to the new task prompt.
- Formal decision: `lore-decision action='create'`
- Superseding a decision: `lore-decision action='create'` with
  `supersedesIds`, or `lore-decision action='supersede'`
- Governing context before editing an entity:
  `lore-decision action='context'`
- General knowledge: `lore-memory action='save'`
- Durable relationship: `lore-fact action='create'`
- Tension between memories: `lore-memory action='compare'`
- Session end: rely on the Stop autosave hook; no manual call required

## Scheduled Digest Synthesis

The Stop hook can spawn a detached weekly digest synthesizer for the current
project. Digest scheduling is debounced by filesystem marker and never blocks
the user's next turn.

- Manual invocation: `lore digest --project <name>`
- Preview: `lore digest --dry-run`
- Wider low-volume window: `lore digest --since YYYY-MM-DD`
- Disable: `hooks.autoDigest: false` in `.lore.yaml`, or
  `LORE_AUTO_DIGEST=false`
- Reset debounce marker: `rm $TMPDIR/lore-hook-state/digest.*.last`
