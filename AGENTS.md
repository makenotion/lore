# Agent Reference

> **Read this file first**, then read the guide for the area you're working in.
> When a subsystem guide conflicts with this file, the subsystem guide takes precedence for that subsystem.

## Subsystem Guides

| Area | Guide | Scope |
|------|-------|-------|
| MCP server | [`src/mcp/AGENTS.md`](src/mcp/AGENTS.md) | Tool registration, error handling, server startup |
| Domain services | [`src/core/AGENTS.md`](src/core/AGENTS.md) | Service pattern, context resolution, fact invalidation |
| Notion SDK layer | [`src/notion/AGENTS.md`](src/notion/AGENTS.md) | Client, schema, extractors, vault setup, SDK v5 specifics |
| CLI | [`src/cli/AGENTS.md`](src/cli/AGENTS.md) | Commander patterns, command reference, output formatting |
| Hook runner | [`src/hooks/AGENTS.md`](src/hooks/AGENTS.md) | Stop autosave, Stop-triggered auto-digest, background spawn, lockfiles |

## Repo-Wide Reference

Notion-backed memory system. Stores knowledge as Notion pages organized across
four core databases (Projects, Topics, Memories, Facts) plus an optional fifth
database (Entities, PF3-01) for canonical-handle resolution. Exposes three
interfaces: an MCP server, a CLI, and shell hooks.

### Architecture

```
.lore.yaml  -->  config.ts  -->  services.ts (shared init)
                                    |
                    +---------------+---------------+
                    |               |               |
                 mcp/server.ts   cli/index.ts   hooks/helpers.ts
                    |               |               |
                 MCP tools     CLI commands    autosave / wakeup
                    |               |               |
                    +-------+-------+-------+-------+
                            |               |
                         core/*          notion/*
                 (domain services)   (SDK + extractors)
```

**Data model**: A Vault is a Notion page containing four core child databases
plus an optional fifth database for canonical-handle resolution, all linked by
relations. Creation order matters because of foreign keys:
Projects --> Topics --> Memories --> Entities --> Facts.

The Entities database (PF3-01) is opt-in on legacy vaults — `verifyVaultDatabases`
populates `vault.databases.entities` only when the database exists, and
`services.entities` is `null` until `lore migrate --build-entities` runs. Code
paths that read entity ids from facts MUST handle both shapes (relation
populated post-migration, empty pre-migration) and fall back to the SubjectKey
substring path on un-backfilled rows.

### Quick Start Commands

| Command | What it does |
|---------|-------------|
| `npm run build` | tsup build (ESM, 4 entry points) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | `eslint src/` |
| `npm run test` | `vitest run` |
| `npm run test:watch` | `vitest` (watch mode) |
| `npm run dev` | `tsup --watch` |

Build produces four entry points via tsup:

| Entry | Source | Output |
|-------|--------|--------|
| `index` | `src/index.ts` | `dist/index.js` (library exports) |
| `mcp` | `src/mcp/server.ts` | `dist/mcp.js` (MCP stdio server) |
| `cli` | `src/cli/index.ts` | `dist/cli.js` (CLI binary, has shebang) |
| `hooks/helpers` | `src/hooks/helpers.ts` | `dist/hooks/helpers.js` |

### Key Conventions

#### Notion SDK v5.x

This project uses `@notionhq/client` v5.x which has significant API differences
from v4 and earlier. Do not use v4 patterns.

| Operation | Correct (v5) | Wrong (v4) |
|-----------|-------------|------------|
| Query a database | `client.dataSources.query({ data_source_id })` | `client.databases.query({ database_id })` |
| Create a database | `databases.create({ initial_data_source: { properties } })` | `databases.create({ properties })` |
| Read page content | `client.pages.retrieveMarkdown({ page_id })` | block children iteration |
| Write page content | `client.pages.updateMarkdown({ page_id, ... })` | append block children |
| Parent discriminant | `{ type: "page_id", page_id }` | `{ page_id }` |

#### ESM-Only

- `package.json` has `"type": "module"`
- All internal imports use `.js` extensions (e.g., `import { Foo } from "./types.js"`)
- tsconfig uses `"module": "ES2022"` with `"moduleResolution": "bundler"`
- Do not use `require()` or CommonJS patterns anywhere

#### Configuration

- Config lives in `.lore.yaml` with upward directory search from cwd
- Token resolution chain: `config.auth.token` --> `LORE_NOTION_TOKEN` env var
- Config is validated with Zod at load time
- The `configRoot` (directory containing `.lore.yaml`) is the base for relative project paths

#### Code Patterns

- Core services use constructor injection: `new Service(client, databaseId)`
- `initServices()` in `services.ts` is the single initialization path for all interfaces
- Property extraction uses typed helpers from `notion/extractors.ts` -- do not inline extraction logic
- Property building uses helpers from `notion/schema.ts` (e.g., `buildMemoryProps()`)
- Filter types require explicit casts: `as QueryDataSourceParameters["filter"]`

#### Input Validation

- MCP tool inputs are validated with Zod schemas via `inputSchema` in `registerTool()`
- CLI inputs are validated by commander's argument/option parsing
- Config is validated with Zod in `config.ts`

### Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `dataSources is undefined` | Using v4 SDK patterns | Use `client.dataSources.query()` not `client.databases.query()` |
| `pages.retrieveMarkdown is not a function` | Notion SDK < 5.x | Ensure `@notionhq/client` is ^5.1.0 |
| `initial_data_source` type error | Missing cast or wrong shape | Use `createDbArgs()` from `setup.ts` as a reference |
| Import without `.js` extension | ESM requires explicit extensions | Add `.js` to all relative import paths |
| `No .lore.yaml found` | Config search failed | Ensure `.lore.yaml` exists in cwd or any parent directory |
| `filter` type errors in queries | Complex filter needs cast | Cast to `QueryDataSourceParameters["filter"]` |
| `Vault already initialized` | Running `lore init` twice | Use `lore status` to verify, or `VaultManager.load()` |
| Codex does not load Lore tools | Project not trusted or hooks feature disabled | Trust the project, start a new Codex session, and ensure `.codex/config.toml` sets `features.codex_hooks = true` |

## Operating Contract

Rule #1: If you want an exception to ANY rule below, STOP and get explicit permission from the human lead first.

### Working together

- Be honest, push back, call out bad ideas. Don't tell me what I want to hear.
- Ask for clarification rather than assuming. Ask for help when stuck.
- Discuss architectural decisions together before implementation. Routine fixes don't need discussion.

### Memory and note-taking

- **Use Lore** for cross-session knowledge. Lore stores memories and facts as Notion pages in a shared vault, so every agent session benefits.
- When you notice something that should be fixed but is unrelated to your current task, note it rather than fixing it immediately.

**What to save in Lore:**

- **Decisions** (`lore-decide`): Architectural choices with their rationale, alternatives, consequences, and review date. Prefer this over `lore-remember` for decisions — records participate in `lore-audit`, `lore-wake-up`, and supersession workflows. Pass `affects: [...]` with affected entity names to auto-create `decided_by` facts so the decision surfaces via `lore-ask`.
- **Memories** (`lore-remember`): Non-obvious discoveries that would save someone else time. Gotchas, workarounds, architectural patterns, debugging insights — anything that *isn't* a decision with formal rationale.
- **Facts** (`lore-learn`): Relationships between system components (`uses`, `depends_on`, `is_a`). For tracked work — open PRs, blocked dependencies, follow-up investigations — use `lore-task action='create'` instead; tracking predicates were dropped from `FactPredicate` in 0.6.0. Invalidate facts with `lore-correct` when they become stale. **`lore-correct` also halves the `Confidence Score` of the memory the fact came from (0.8.0+) — facts don't carry a score; the decrement lands on the originating memory. Use it precisely, not as a soft "maybe" signal.**

### Confidence: categorical vs. numeric (0.8.0+)

The Memories DB carries two confidence columns. They are NOT interchangeable.

- **`Confidence` (categorical, agent-set).** A select column with three values — `certain`, `likely`, `speculative`. You set this on write to capture your stance: "I'm sure" / "this seems true but I haven't fully verified it" / "this is a guess." It is the agent-curated, human-readable signal. Set it explicitly on every `lore-decide` and `lore-remember` call when the default (`certain`) doesn't match your actual stance — being honest about speculation is more valuable than overstating certainty.

- **`Confidence Score` (numeric, system-managed).** A 0–1 score the system maintains. It is bumped on every read-citation (`lore-query action='ask'`, `'recall'`, `lore-context action='wake-up'` surfacing the row), decremented on every contradiction signal (`lore-correct`, `lore-supersede`), and decays toward zero when a memory is untouched past 60 days. RRF-based retrieval ranks by this score (lower-score rows surface less).

  **You do not write this column directly.** It is system-managed, and the MCP tool surface deliberately does not accept it as a `lore-memory` / `lore-decision` / `lore-task` parameter. Trying to set it would either silently fail (no parameter to bind) or, worse, force the system's accumulated-evidence signal into the agent's stance — collapsing the two axes into one.

The rule of thumb: **write the categorical to express your stance; let the numeric accumulate from the system's signals.** A memory you mark `speculative` that survives ten cites without contradiction will have its numeric score climb above what its categorical implies — and that's the system telling you the memory is more trustworthy than your initial stance suggested. A memory you mark `certain` that gets contradicted twice will see its numeric score drop below what its categorical implies, and that's the system telling you to revisit. The two columns together carry more information than either alone.

**When to save:**

- After resolving a non-obvious bug or build issue → `lore-remember`
- When you discover an undocumented convention or constraint → `lore-remember`
- When an architectural decision is made → `lore-decide` (capture the *why*, not just the *what*)
- When a new decision supersedes an older one → `lore-decide` with `supersedesIds` or `lore-supersede`. **Supersession also halves the superseded decision's `Confidence Score` (0.8.0+) — the earlier decision still exists for historical reading but retrieval ranks against it.**
- When you identify work that needs to happen but is out of scope → `lore-task action='create'` (with `state: "open"` and an `entity` naming the subject)

### Conflict verdicts (0.9.0+)

`lore-memory action='compare'` accepts six verdicts on a memory
pair. The vocabulary is frozen — the same wording matches
engram's protocol so cross-system reasoning stays portable.

`memoryIdA` and `memoryIdB` are unordered labels — the order
does NOT encode direction. For asymmetric verdicts
(`conflicts_with`, `supersedes`), pass `affectedMemoryId` to
name the memory whose `Confidence Score` halves. For
symmetric verdicts, omit `affectedMemoryId`.

- **`conflicts_with` (asymmetric)** — A and B make incompatible
  factual claims about the same subject in the same scope.
  Pass `affectedMemoryId` naming the contradicted memory (the
  one to lose confidence). Routes through `lore-correct`:
  affected memory's `Confidence Score` halves, the
  contradiction is recorded as a fact (subject = winner, object
  = loser).
- **`supersedes` (asymmetric)** — Decision-kind affected
  targets ONLY. The other memory is the later, more accurate
  statement; the affected (decision) memory should be retired.
  Pass `affectedMemoryId` naming the superseded decision.
  Routes through `lore-supersede`: affected memory's
  `Confidence Score` halves, a `supersedes_decision` fact is
  emitted. For non-decision affected targets, use `compatible`
  and manually edit one body to incorporate the other via
  `lore-memory action='update'` (no structured merge primitive
  ships — `update` is a body-edit surface, not a merge engine),
  OR promote to a formal decision via `lore-decision
  action='create'` with `supersedesIds`. Calling `compare` with
  `verdict: 'supersedes'` and a non-decision affected memory
  throws.
- **`scoped` (symmetric)** — A and B differ but the
  differences are explained by scope (project, time,
  environment). Recorded via `Compared With` and `Compare
  Notes` (no confidence change). Omit `affectedMemoryId`.
- **`related` (symmetric)** — A and B share a subject but make
  non-overlapping claims. `Compared With` and `Compare Notes`
  only. Omit `affectedMemoryId`.
- **`compatible` (symmetric)** — A and B make near-identical
  claims. Redundant but not in conflict. `Compared With` and
  `Compare Notes` only. **Consider `lore-memory
  action='update'` to merge one's body into the other if one
  is clearly canonical.** Omit `affectedMemoryId`.
- **`not_conflict` (symmetric)** — A and B are about unrelated
  subjects. `Compared With` and `Compare Notes` only. Omit
  `affectedMemoryId`. The candidate generator surfaced them by
  shallow signal; the verdict closes the case.

When `lore conflicts scan` returns candidate pairs, judge each
pair using the verdict definitions above and call `lore-memory
action='compare'` once per pair. The four non-actionable verdicts
record "we've judged this, don't re-ask" — the next scan skips
them.

### Topic keys for evolving memories (0.9.0+)

When saving a memory about a *recurring topic* — a governance
decision that may revise, a runbook that gets refined, a policy
that evolves — pass `topicKey` to `lore-memory action='save'`.
The save upserts on `(Topic Key + Project-set equality)`: if a
memory with that key AND identical project relation set already
exists, the new content appends as a revision block to the
existing page (incrementing `Revision Count`) rather than
creating a new row.

Use stable kebab-case paths grouped by family. The family
prefixes match the closed `MemoryKind` set:

- `decision/jwt-auth-model`, `decision/database-choice`
- `runbook/database-migration`, `runbook/incident-response`
- `incident/login-redirect-502`, `incident/payment-cascade`
- `postmortem/payment-gateway-timeout`
- `policy/code-review-min-reviewers`, `policy/data-retention`

If unsure of the right key, call `lore-memory
action='suggest-topic-key'` with the title and kind. The
suggester returns a stable key derived from the title's noun
phrase plus the kind family.

**Do NOT use `topicKey` on `kind: 'note'` or `kind: 'task'`.**
The suggester returns null for both — notes are the catch-all
default and don't form recurring topics; tasks transition through
lifecycle states, not revisions. The kind is preserved across
upsert calls; saving with a different `kind` against an existing
upsert chain is rejected at the save path. Topic keys are for
*categories* of recurring writes, not for individual saves.

When the upserted memory's body grows past ~5KB, consider calling
`lore-decision action='create'` with `supersedesIds` referencing
the upserted memory — promote the synthesis into a formal
decision and let the upsert chain retire.

### Passive learning extraction (0.9.0+)

The Stop-triggered background autosave (see `src/hooks/AGENTS.md`)
already spawns a detached `claude -p` sub-agent that reviews the
session transcript and saves a session synopsis. In 0.9.0 the
sub-agent prompt is extended (#08) so it ALSO identifies atomic
learnings — single-fact discoveries that would help a future
session — and saves each as its own memory alongside the
synopsis.

This is invisible to you in the foreground. You do NOT write a
visible `## Key Learnings:` section in your responses; that
would pollute user-facing output with boilerplate. Extraction
happens out-of-band in the background sub-agent.

**What this means for you:**

- Continue calling `lore-remember` / `lore-decide` explicitly
  for the things you specifically want preserved — the autosave
  extraction is a safety net, not a replacement.
- **Do not** double-save: if you already called
  `lore-remember` for a discovery, the autosave prompt is
  instructed to check for near-matches and skip its own write
  when it finds one (best-effort, prompt-only — duplicates
  are still possible).
- **Do not** add a `## Key Learnings:` section at the end of
  your responses. That's an engram-style convention; lore's
  extraction is invisible.

Operators who want to disable extraction set
`LORE_DISABLE_LEARNING_EXTRACTION=1` or
`hooks.learningExtraction: false` in `.lore.yaml`. Disabling
turns the autosave back into the 0.8.x synopsis-only shape.

### Tasks

- **Use `lore-task action='create'`** when work needs tracking across sessions — open PRs, blocked dependencies, follow-up investigations. Tasks are the canonical surface for tracked work; the description goes in the page body and the entity is structurally indexed.
- **Close tasks (`lore-task action='close'`) as soon as the work completes.** A closed task is the source of truth for "done"; an unclosed task remains in every future session's wake-up Tasks section, eating prompt budget on dead work. The close call is one Notion update — cheap, idempotent, and the right thing to do before ending a session that resolved tracked work.
- **When you save a memory describing resolved work** (a merge, a ship, a decision that obsoletes prior tracked work), check `lore-context action='wake-up'` (or the trailing tasks line in the save response, once #11 ships) for related active tasks and close any whose work this memory resolves. The cost of the cross-check is one tool call; the cost of leaving it open is permanent.
- **When in doubt, close.** A re-opened task (`lore-task action='update' state='open'`) costs nothing; a forgotten-open task costs prompt budget on every future session. Bias toward closure.
- **Distinguish `done` from `cancelled`.** `done` means the work completed as scoped; `cancelled` means the work was abandoned or superseded. The distinction matters for closure-rate metrics (`lore status`, post-#13).

### Maintaining AGENTS.md

AGENTS.md files are living documents. Update them when you discover undocumented conventions, missing workflows, gotchas that cost you time, or outdated instructions.

- Place knowledge in the right file -- MCP-specific in `src/mcp/AGENTS.md`, Notion SDK in `src/notion/AGENTS.md`, cross-cutting here.
- Small factual corrections: make the change directly. Structural changes or rule modifications: propose to the human lead first.
- Never remove or weaken existing rules without raising it with the human lead.
- Every change must leave the document shorter or more useful -- ideally both.

### Writing code

- YAGNI. The best code is no code. Don't add features we don't need right now.
- Make the smallest reasonable changes to achieve the outcome.
- Never rewrite implementations without explicit permission -- ask first.
- Match the style and formatting of surrounding code.
- Fix broken things immediately. Don't ask permission to fix bugs.
- Don't abandon an approach because it's tedious -- abandon it only if it's technically wrong.

### Naming

- Names MUST tell what code does, not how it's implemented or its history.
- NEVER use implementation details in names (e.g., "ZodValidator", "NotionWrapper").
- NEVER use temporal/historical context in names (e.g., "NewAPI", "LegacyHandler").

### Code comments

- Explain WHAT or WHY, never HOW. Must be evergreen -- no temporal context ("recently refactored", "moved from", "new").
- Never remove existing comments unless provably false.

### Stability rules

1. **Do not remove existing MCP tools.** Tools are part of the public contract with
   AI assistants. Deprecate by adding a deprecation notice to the description, then
   remove in a future major version.

2. **Do not rename database properties.** Property names (`Name`, `Title`, `Subject`,
   `Predicate`, `Object`, etc.) are baked into `schema.ts`, `extractors.ts`, and all
   core services. Renaming requires a migration.

3. **Do not change the `initServices()` signature** without updating all three
   consumers (MCP server, CLI, hooks).

4. **Keep the four-database schema stable.** Adding properties is fine. Removing or
   renaming properties is a breaking change.

5. **Respect the import boundary**: CLI and hooks import from `services.ts`, not
   directly from `mcp/server.ts`.

### Testing

- Run `npm run typecheck` before committing. The project uses strict TypeScript and the type system catches most SDK usage errors.
- Write or update tests for code changes when a test suite exists for the area.
- Follow the testing patterns already used in the project (vitest).

### Debugging

Always find the root cause. Never fix symptoms or add workarounds.

- Read error messages carefully -- they often contain the answer.
- One hypothesis at a time: smallest possible change, verify, then move on.
- Say "I don't understand" rather than guessing.

## Lore MCP Tools

When working in this project, you have access to `lore-*` MCP tools. Use them:

- **At session start**: call `lore-wake-up` to load recent project context (includes proposed + overdue decisions)
- **When making a decision**: call `lore-decide` — captures rationale, alternatives, consequences, review date, and auto-creates `decided_by` facts. This is the preferred path for architectural choices.
- **When superseding an old decision**: pass `supersedesIds` to `lore-decide`, or call `lore-supersede` after.
- **When an entity is about to be edited**: call `lore-decision-context` with the entity name to surface governing decisions first.
- **When saving general knowledge** (not a formal decision): call `lore-remember` for gotchas, workarounds, debugging insights.
- **When learning facts**: call `lore-learn` to record entity relationships (e.g., "MemoryService uses dataSources.query")
- **When two memories appear in tension** (a scan surfaces them, or you notice the conflict mid-task): call `lore-memory action='compare'` with one of the six verdicts. See "Conflict verdicts" above.
- **At session end**: the Stop autosave hook fires a background save automatically — no manual call required

### Scheduled digest synthesis

The Stop hook fires a background `claude -p` digest synthesizer at most once per project per 7 days (filesystem-marker debounced) when the cwd resolves to a single sub-project. The synthesizer runs in a detached node child the Stop hook spawns (the parent never initializes Notion or gathers digest data inline), so digest scheduling never blocks the user's next turn. The digest writes a `source: "digest"` memory that `lore-wake-up`'s fast path surfaces at session start and uses to trim the recent-memories section to 3.

- **Manual invocation**: `lore digest --project <name>` (`--dry-run` previews the raw data without spawning; `--period day|week` controls the window).
- **Sustained-low-volume escape**: a project that averages 1–2 memories per week never accumulates digest-worthy content within the auto-path's 7-day window, so the scheduler's quiet-week branch keeps touching the marker and no `source: "digest"` memory ever lands. Run `lore digest --since YYYY-MM-DD` to widen the window past the debounce — the CLI re-touches the marker after spawning so the next Stop hook won't immediately retry.
- **Disable**: set `hooks.autoDigest: false` in `.lore.yaml`, or export `LORE_AUTO_DIGEST=false`. The CLI path still works — only the Stop-triggered scheduler is suppressed.
- **Debounce reset**: `rm $TMPDIR/lore-hook-state/digest.*.last` (per-config-root hashed filename).
