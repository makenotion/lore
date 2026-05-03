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

Atomic learning saves are deduplicated more strictly than ordinary memory
saves. In background-agent runs, a `source: "conversation"`, `kind: "note"`,
`confidence: "likely"` save with a session id checks likely conversation notes
before creating a row. Project-scoped autosaves reuse same-project-set matches
across sessions, including legacy unscoped rows; projectless and catch-all
fallback autosaves stay same-session scoped. If Lore cannot read the duplicate
candidate set, the autosave learning save fails before creating a possible
duplicate. To force a separate row during recovery or migration, set
`LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1` for that autosave run.

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
2. Preview: `lore migrate --fix-memory-encoding --project "Mail" --dry-run`
3. Apply: `lore migrate --fix-memory-encoding --project "Mail" --yes`

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
