# AGENTS.md -- src/mcp/

> Read the root `AGENTS.md` first. This file covers the MCP server layer only.

## Purpose

This directory implements Lore's MCP (Model Context Protocol) server. It is the
primary interface for AI assistants. The server runs as a stdio process and
exposes seven polymorphic tools — `lore-context`, `lore-memory`, `lore-query`,
`lore-fact`, `lore-decision`, `lore-journal`, `lore-project` — plus the prior
24 single-purpose tool names registered as deprecated aliases for the
one-release transition window mandated by the stability rule. The tasks
layer (P3-02) lands as a separate `lore-tasks-*` family pending PF3-06's
subsumption into a polymorphic `lore-task` dispatcher.

## Files

| File | Responsibility |
|------|---------------|
| `server.ts` | Server entry point: init services, register tools, start stdio transport |
| `helpers.ts` | `toolError()`, `paginationFooter()`, `debugLogPartialFailures()`, `formatDispatchError()` |
| `tools/context.ts` | `lore-context` polymorphic + legacy `lore-status`, `lore-wake-up`, `lore-digest` aliases |
| `tools/memory.ts` | `lore-memory` polymorphic + legacy `lore-remember`, `lore-update`, `lore-forget`, `lore-expand`, `lore-recall`, `lore-search` aliases |
| `tools/query.ts` | `lore-query` polymorphic (read-path dispatcher; reuses handlers from memory.ts and knowledge.ts) |
| `tools/project.ts` | `lore-project` polymorphic + legacy `lore-list-projects`, `lore-get-project` aliases |
| `tools/knowledge.ts` | `lore-fact` polymorphic + legacy `lore-learn`, `lore-ask`, `lore-correct`, `lore-open-loops`, `lore-audit`, `lore-extend` aliases |
| `tools/journal.ts` | `lore-journal` polymorphic (defaults action='write' for legacy call shape) + legacy `lore-read-journal` alias |
| `tools/decisions.ts` | `lore-decision` polymorphic + legacy `lore-decide`, `lore-list-decisions`, `lore-get-decision`, `lore-decision-context`, `lore-supersede`, `lore-review-decision` aliases |
| `tools/tasks.ts` | `lore-task-create`, `lore-task-update`, `lore-task-close`, `lore-tasks` (P3-02; pending PF3-06 polymorphic subsumption) |

## Polymorphic dispatch pattern (P3-01)

The seven `lore-*` tools above multiplex multiple actions behind one MCP
registration to keep per-session prompt overhead low. Each tool follows the
same shape:

1. **Flat MCP-level `inputSchema`.** A top-level `action` enum field plus
   every action's parameters as optional fields. Each parameter description
   names which actions use it (e.g. "(action='create') The entity this fact
   is about"). This keeps the schema readable as a single property table for
   agents — discriminated unions at the MCP boundary would surface as a JSON
   Schema `oneOf` which agents handle less consistently than flat property
   lists.

2. **Module-level discriminated union for runtime validation.** A
   `z.discriminatedUnion("action", [...])` schema parses the args inside the
   handler. Failed parses route through `formatDispatchError()` so the agent
   gets a single-line `tool: field: message` error instead of a stack trace.

3. **One handler per action, shared with the legacy alias.** Handlers
   are local async functions named `handle<Action>` taking `(services, args)
   → Promise<ToolResult>`. The polymorphic dispatcher and the legacy alias
   both call the same handler so behavior cannot drift between the two
   surfaces during the deprecation window.

Skeleton:

```typescript
async function handleSave(services: LoreServices, args: SaveArgs): Promise<ToolResult> { ... }
async function handleArchive(services: LoreServices, args: ArchiveArgs): Promise<ToolResult> { ... }

const memoryDispatchSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("save"), title: z.string(), content: z.string(), ... }),
  z.object({ action: z.literal("archive"), memoryId: z.string() }),
  ...
])

server.registerTool("lore-memory", {
  title: "Memory operations",
  description: "Action-dispatched: save | archive | ...",
  inputSchema: {
    action: z.enum(["save", "archive", ...]).describe("..."),
    title: z.string().optional().describe("(action='save') Required."),
    memoryId: z.string().optional().describe("(action='archive') Required."),
    ...
  },
}, async (args) => {
  const parsed = memoryDispatchSchema.safeParse(args)
  if (!parsed.success) {
    return toolError(new Error(formatDispatchError("lore-memory", parsed.error)))
  }
  switch (parsed.data.action) {
    case "save": return handleSave(services, parsed.data)
    case "archive": return handleArchive(services, parsed.data)
    ...
  }
})

// Deprecated alias — preserved for the transition window.
server.registerTool("lore-remember", {
  title: "Save a memory",
  description: "Deprecated alias — prefer `lore-memory` with `action: 'save'`.",
  inputSchema: { /* original lore-remember schema, unchanged */ },
}, async (args) => handleSave(services, args))
```

### Adding a new action to a polymorphic tool

1. Write a `handleX` function following the existing pattern.
2. Add a new branch to the `discriminatedUnion` for that action's params.
3. Add the action value to the top-level `action` enum and add any new
   per-action fields to the flat `inputSchema`.
4. Add the dispatch case to the handler's `switch (parsed.data.action)`.
5. Update the polymorphic tool's description with a one-line bullet for
   the new action.
6. Add a test in `polymorphic.test.ts` exercising the new dispatch path.

### Adding a brand-new tool family

Use the polymorphic shape from day one. Single-purpose tools should only be
introduced when the surface really is one action (e.g. `lore-status` made
sense pre-P3-01 because it never grew beyond "show vault stats" — but even
that collapsed into `lore-context action='status'`).

## Tool Registration Pattern

Every tool file exports a single `registerFooTools(server, services)` function
that calls `server.registerTool()` for each tool. The pattern:

```typescript
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"

export function registerFooTools(
  server: McpServer,
  services: LoreServices
): void {
  server.registerTool("lore-verb-noun", {
    title: "Human-readable title",
    description: "What this tool does. Include usage guidance for the AI.",
    inputSchema: {
      paramName: z.string().describe("What this parameter is for"),
      optionalParam: z.string().optional().describe("Optional context"),
    },
    annotations: { readOnlyHint: true },  // if tool only reads data
  }, async ({ paramName, optionalParam }) => {
    try {
      // ... tool logic ...
      return { content: [{ type: "text", text: "result" }] }
    } catch (err) {
      return toolError(err)
    }
  })
}
```

### Mandatory conventions

1. **Tool names**: Always `lore-<verb>` or `lore-<verb>-<noun>` in kebab-case.

2. **try/catch**: Every tool callback must wrap its body in try/catch and return
   `toolError(err)` on failure. MCP protocol requires tools to report errors as
   content, not throw exceptions.

3. **inputSchema**: Always uses Zod objects. Each field must have a `.describe()`
   call explaining the parameter to the AI.

4. **annotations**: Set `readOnlyHint: true` for tools that only read data.
   Set `destructiveHint: true` for tools that delete or archive.

5. **Project resolution**: Most tools accept an optional `projectName` /
   `projectNames` parameter. For **write** tools (memory, knowledge,
   decisions) prefer `resolveProjectIds(services, projectName, projectNames)`
   from `resolve.ts`. For **read** tools, use `services.context.project`
   directly. The write-path resolver handles the catch-all warning:

   ```typescript
   const resolved = await resolveProjectIds(services, projectName, projectNames)
   // resolved.ids → project IDs to persist
   // resolved.warnings → surface in the tool response
   ```

   When the auto-detected context is a monorepo catch-all (config entry with
   path `"."`), and no explicit project was named, `resolveProjectIds` adds
   a warning naming the candidate sub-projects. The warning surfaces via the
   existing `Warnings: …` line in save tool responses — no display-layer
   changes needed per tool.

6. **Return format**: Always return `{ content: [{ type: "text", text: "..." }] }`.
   Format output as readable markdown when returning multiple items.

7. **Tags are a closed vocabulary.** Any tool that accepts `tags` must use
   `tagsSchema` from `tools/tag-schema.ts` (backed by `TAG_VOCABULARY` in
   `types.ts`). Pair it with `keywordsSchema` so callers have a home for
   free-form tokens (PR numbers, ticket IDs, file paths, class names).
   Out-of-vocab tags must fail validation — don't loosen this at the tool
   boundary.

## Tool Reference

> Each polymorphic tool is documented as a single row with its action set;
> the "alias" column lists the legacy single-purpose tool name kept for the
> deprecation window. Behavior of the polymorphic action and its alias is
> identical because both call the same handler.

### `lore-context` — vault context operations

| Action | Purpose | Read-only | Legacy alias |
|--------|---------|-----------|--------------|
| `status` | Vault page id, database counts, active project, configured projects | Yes | `lore-status` |
| `wake-up` | Load digest + recent memories + open loops + active facts + decisions requiring attention | Yes | `lore-wake-up` |
| `digest` | Gather raw activity data for synthesis into a `source: digest` memory | Yes | `lore-digest` |

#### Two-tier default for `lore-wake-up`

`lore-wake-up` defaults to **title-tier rows** (title + metadata, no body)
across Recent Memories and Related to Open Loops. This is the same
content-off discipline as `lore-recall` / `lore-search` (below), extended
to the session-priming tool where the pre-P2-01 default used to fan out
one `pages.retrieveMarkdown` per memory on every call.

- **Default path.** Agents get heading + `source | tags | date` per
  memory. Bodies are omitted; the section size reduction is measured at
  ~60% against the Mail production vault (10 recent + 10 open loops +
  15 knowledge facts, no digest).
- **Opt in.** Pass `expand: true` to restore the pre-P2-01 body-inclusive
  output. The digest memory (`source: digest`) always renders with its
  body regardless — the digest IS the content.
- **Per-section caps.** `limit` (memories), `openLoopLimit`,
  `knowledgeFactLimit` are independent knobs so callers can bound one
  section without truncating others. `openLoopLimit: 0` short-circuits
  the tracking-predicate Notion query AND the related-memory search
  that seeds off it — zero open loops means zero seeds, so skipping
  both saves two round-trips for one knob.
- **`limit` counts clusters, not rows.** Topical collapse runs on the
  display side: wake-up over-fetches the memory sections by
  `COLLAPSE_OVERFETCH_MULTIPLIER` (`src/mcp/tools/context.ts`), groups
  near-duplicate memories (title-token Jaccard ≥ 0.5 OR tag-set overlap
  ≥ 0.5), then slices by cluster count so the agent sees a stable
  number of distinct topics. Collapsed peers render on the representative
  as `(related: <uuid>, <uuid>)` — **full Notion UUIDs**, so an agent
  can call `lore-recall` / `lore-get-decision` with the trailer ID to
  fetch the peer's body. Even when `expand: true`, only the
  representative's body is rendered; collapsed peers stay suppressed.

This joins `lore-recall` / `lore-search` under the `0.2.0` server
version. MCP clients that relied on the previous eager-body default
will observe the change on reconnect.

### `lore-memory` — memory mutations + batch hydration

| Action | Purpose | Read-only | Legacy alias |
|--------|---------|-----------|--------------|
| `save` | Create a new memory (with parallel near-duplicate probe) | No | `lore-remember` |
| `update` | Mutate title / body / tags / kind / status / relations on an existing memory | No | `lore-update` |
| `archive` | Soft-delete a memory by ID | No (destructive) | `lore-forget` |
| `expand` | Batch-fetch full markdown bodies for up to 20 IDs (parallelized) | Yes | `lore-expand` |

Read-side `recall` and `search` live on `lore-query` since they share
structural overlap with the rest of the read-path surface. Their legacy
`lore-recall` and `lore-search` aliases are kept registered alongside the
memory family to mirror the prior file layout.

### `lore-query` — vault read paths

| Action | Purpose | Read-only | Legacy alias |
|--------|---------|-----------|--------------|
| `recall` | List recent memories with server-side filters; cursor-paginated | Yes | `lore-recall` |
| `search` | Semantic search over memories (Notion vector similarity); `kind`/`status` post-filter | Yes | `lore-search` |
| `ask` | Query facts about an entity, grouped into Governance / Structure / Tracking buckets | Yes | `lore-ask` |
| `open-loops` | List active tracking-predicate facts; capped at 10 per section unless `{all: true}` | Yes | `lore-open-loops` |
| `audit` | List facts and decisions past their review-by date | Yes | `lore-audit` |

#### Near-duplicate probe on `lore-remember` and `lore-decide`

Both write tools run `findNearDuplicates()` (see `src/core/near-duplicate.ts`)
in parallel with the create. When the probe finds rows whose title
trigram similarity meets threshold (0.7 for memories, 0.6 for decisions),
the response adds a trailing `Warning:` block listing the candidates.

- `lore-remember` recommends `lore-update` or `lore-decide` with
  `supersedesIds`.
- `lore-decide` emits a ready-to-copy `lore-supersede({ ... })` line per
  candidate, scoped to same-project + same-topic + active status.

The probe is advisory only — it never blocks the save, and a probe
failure returns silently (no trailing warning, save succeeds as normal).
Rows the caller already superseded via `supersedesIds` are dropped from
the warning list to avoid re-warning about known duplicates.

Set `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` to skip the probe entirely
in bulk-import, fixture, or autosave contexts where the per-save
`dataSources.query` is unwanted overhead. See `src/core/AGENTS.md`
for the full scoping rules and the implementation-side rationale.

#### Content-off default for list/search tools

`lore-recall` and `lore-search` both default to **`includeContent: false`**.
Each returns index-tier rows — title, metadata, timestamps — without fetching
the markdown body for each page. Fetching bodies costs one extra
`pages.retrieveMarkdown` round-trip per row, and most triage paths only need
a handful of bodies for the rows the agent actually cares about.

- **Default path.** Agents scan the index tier, decide which rows are
  relevant, then fetch bodies in one shot via `lore-expand({ids: [...]})`.
  For decisions specifically, `lore-get-decision` also renders the
  structured rationale (alternatives, consequences, supersession
  chain). The response footer reminds callers that bodies were omitted.
- **Opt in.** Pass `includeContent: true` when the caller genuinely needs
  every body — e.g. exporting a window of memories or piping into another
  indexing pipeline. The hot path stays fast by default, and the slow path
  is explicit.

Changing this default is a breaking change for agents that relied on eager
bodies; the server version is bumped to `0.2.0` in `server.ts` so MCP
clients see the shift immediately.

#### `recall` → `expand` pattern

Canonical triage flow once bodies are content-off by default:

1. `lore-recall` or `lore-search` returns title + metadata rows (one
   Notion round-trip).
2. Agent picks the handful of rows whose bodies it actually needs.
3. `lore-expand({ids: [...]})` hydrates those bodies in one tool call,
   parallelized server-side so wall-clock is roughly one
   `pages.retrieveMarkdown` latency, not N.

`lore-expand` caps at 20 IDs per call and dispatches via `settleAll`, so a
single failing ID does not collapse the whole response — the failed row
renders as `### (unresolved: <id>)` with the error inline. Partial
failures also route through `debugLogPartialFailures` so operators
running with `LORE_DEBUG=1` see them on stderr.

The cap deliberately exists one layer below the user: it is enforced by
the Zod schema on `ids`, not by runtime guards, so oversized calls fail
at the MCP boundary with a parsing error rather than partial-completing.
If an agent genuinely needs bodies for more than 20 memories, it re-
batches — but the expected path is to triage on the title tier first and
hydrate only the rows that matter. Blind-hydrating every title in chunks
of 20 re-introduces the prompt tax that content-off defaults were
designed to remove.

### `lore-project` — project read paths

| Action | Purpose | Read-only | Legacy alias |
|--------|---------|-----------|--------------|
| `list` | List all projects in the vault | Yes | `lore-list-projects` |
| `get` | Get project details including topics and recent activity | Yes | `lore-get-project` |

### `lore-fact` — knowledge graph mutations

| Action | Purpose | Read-only | Legacy alias |
|--------|---------|-----------|--------------|
| `create` | Add a subject-predicate-object fact triple (auto-dedupes via `DedupKey`). Tracking predicates (`needs_action`, `waiting_on`, `blocked_by`) are rejected post-P3-02 with a directive redirect to `lore-task-create`. | No | `lore-learn` |
| `invalidate` | Invalidate a fact (sets Valid Until, does not delete) | No (destructive) | `lore-correct` |
| `extend` | Push back a fact's review-by date | No | `lore-extend` |

Read-side fact paths (`ask`, `open-loops`, `audit`) live on `lore-query` —
see the table above. After P3-02 the `ask` action also surfaces tasks
touching the entity in a fourth bucket so post-migration vaults still
get the open-loops view at `lore-ask` time. The `open-loops` action is
deprecated in favour of `lore-tasks` — it remains available so
un-migrated vaults can still surface their legacy tracking facts during
the transition window.

### Task Tools

| Tool | Purpose | Read-only |
|------|---------|-----------|
| `lore-task-create` | Create a `Kind = task` memory with description in the page body | No |
| `lore-task-update` | Change state, blocker, due date, subject, or description | No |
| `lore-task-close` | Mark done (or cancelled — distinguished for metrics) | No (destructive) |
| `lore-tasks` | List tasks with Overdue/Active sections; filters by state, entity, due | Yes |

#### P3-02 task model

Tasks supersede the legacy tracking-predicate facts. Three new properties on the Memories DB:
- `Task State` — `open` / `in-progress` / `blocked` / `done` / `cancelled`
- `Blocked By` — free-form blocker label (PR number, person, service)
- `Entity` — normalized subject the task is about; defaults to title

The body of a task page carries the full description (no rich_text length cap), unlike the old tracking facts whose 187-char-average Object field was a Jira-ticket-shaped paragraph in a graph slot meant for atomic relationship objects.

`lore-learn` rejects tracking predicates with a redirect to `lore-task-create`. Existing tracking facts can be ported via `lore migrate --migrate-tracking-to-tasks --yes`. The migration carries the source memory forward as the task's `Affects` relation so `lore-ask(entity)` retracing still works.

#### Open loops ranking contract

`lore-open-loops` caps its output at **10 rows per section** (Overdue +
Active) by default. The Mail vault has 271 open loops; an unbounded
dump floods agent context and drowns the signal. Three knobs override
the default:

- **`{entity: "..."}`** — substring filter matched server-side against
  `Subject` (title) and `Object` (rich_text) via an OR. Use this to
  scope to a PR, service, or other entity. Cheap even on vaults with
  hundreds of loops.
- **`{limit: N}`** — override the per-section cap. `N` must be >= 1
  (zero is rejected at the schema boundary; use `{all: true}` for full
  output). Capped at 200.
- **`{all: true}`** — bypass the cap entirely. Paginates through every
  matching row via `FactService.listTracking`. Noisy on large vaults;
  use for triage sweeps.

**Ranking contract** (pinned by tests in `knowledge.test.ts`):

- **Overdue**: most-overdue-first. Tiebreakers: `validFrom` desc, then
  `id` lex. Urgency markers are rendered as `⚠⚠` at `>= 14` days
  overdue (`OVERDUE_SEVERE_DAYS`) and `⚠` at `>= 1` day
  (`OVERDUE_MILD_DAYS`); zero-day rows are overdue but unmarked.
- **Active**: soonest-`reviewBy`-first. Null `reviewBy` sinks to the
  bottom via an explicit-null comparator (not a sentinel string — see
  `rankActive` in `tools/knowledge.ts`). Tiebreakers: `validFrom`
  desc, then `id` lex.

The sort comparators live in `tools/knowledge.ts` as `rankOverdue` /
`rankActive` with full JSDoc. The two named constants
`OVERDUE_SEVERE_DAYS` and `OVERDUE_MILD_DAYS` are the source of truth
for the urgency thresholds. Changing any of this is observable to
agents and requires a coordinated spec revision plus a server-version
bump (the `0.2.0 → 0.3.0` bump landed with this contract).

**Pagination caveat.** `FactService.listTracking` paginates to
fulfil the request, unlike `listRecent` which is single-page. This
honours the P1-02 `hasMore` caveat: Notion's `page_size` saturates at
100, so `{all: true}` on a 228-`needs_action` vault cannot safely
use a single-page helper. A 100-page safety valve (`LIST_TRACKING_MAX_PAGES`)
clips runaway walks; the resulting `hasMore: true` surfaces to the
agent as a "safety cap" warning.

### `lore-journal` — agent diary (deprecated tool family)

| Action | Purpose | Read-only | Legacy alias |
|--------|---------|-----------|--------------|
| `write` (default) | Save an agent diary entry (memory with `source: 'agent_diary'`) | No | `lore-journal` itself (legacy write-only call shape preserved by defaulting `action` to `write`) |
| `read` | List recent diary entries, optionally filtered by agent | Yes | `lore-read-journal` |

The whole tool family is itself deprecated in favor of `lore-memory` with
`kind: 'note'` for durable knowledge or `lore-decision` for architectural
decisions. The polymorphic registration consolidates the legacy two-tool
surface so the overall surface count stays at the planned ~8.

### `lore-decision` — decision lifecycle

| Action | Purpose | Read-only | Legacy alias |
|--------|---------|-----------|--------------|
| `create` | Save a decision; auto-creates `decided_by` facts per `affects` entry and `supersedes_decision` facts if superseding | No | `lore-decide` |
| `list` | Index-tier listing of decisions (properties only, no body fetch) | Yes | `lore-list-decisions` |
| `get` | Load full rationale + metadata for one decision | Yes | `lore-get-decision` |
| `context` | Graph walk: every active decision governing an entity (via `decided_by` facts) | Yes | `lore-decision-context` |
| `supersede` | Mark old decision as superseded by new; atomic + creates `supersedes_decision` fact | No | `lore-supersede` |
| `review` | Mark a decision as reviewed, push `Review By` forward (default +90 days) | No | `lore-review-decision` |

**Decision predicates are internal-only.** `decided_by`, `supersedes_decision`,
and `informs` are in the `FactPredicate` union and the Notion `Predicate`
select options, but they are NOT in `PREDICATE_VALUES` in `tools/knowledge.ts`.
This prevents users from creating inconsistent decision edges via `lore-fact`
(or its legacy `lore-learn` alias) — only `DecisionService` and the decision
tools create these facts.

**`lore-learn` expects `sourceMemoryId` (soft-phase).** Every fact
should link back to a supporting memory so `lore-ask` can retrace the
reasoning. The tool resolves the source in this order:

1. Explicit `sourceMemoryId` argument — always wins.
2. Session auto-link: if the caller passes `agent`+`session` and a
   `lore-remember`/`lore-decide` call earlier in this process recorded
   a memory under the same composite key, that memory becomes the
   source **only if** its project scope intersects the fact's (or
   either side is vault-wide). The response shows
   "auto-linked from session" so the caller can retract on mis-match.
3. Neither available → fact is created **with a prominent warning** in
   the response. This soft-phase window lets deployed callers adopt
   `sourceMemoryId` before we flip to a hard error in a future minor.

The Zod schema marks `sourceMemoryId` as optional. Runtime logic is
stricter — it surfaces a warning when neither an explicit ID nor an
auto-link candidate is available. The mismatch is intentional: schema-
level strictness would break every deployed agent caller on day one,
which is exactly what the soft-phase avoids. Agents that inspect the
tool description see the contract; runtime surfaces the enforcement.
When we flip to hard error, also tighten the Zod schema to a
`superRefine` requiring either `sourceMemoryId` or `session`.

The session mapping lives on `services.sessionMemories` (a per-process
`SessionMemoryTracker`). `lore-remember` and `lore-decide` write into
it with the memory's `projectIds` so the auto-link project check has
real data. The tracker is keyed on a composite of `agent`+`session`
so two agents connected to the same MCP process cannot collide on a
shared session string. Capped at 256 entries with LRU eviction — no
cross-process persistence.

## Adding a New Tool

Prefer adding a new **action** to an existing polymorphic tool — see "Adding
a new action to a polymorphic tool" above. Only introduce a new tool family
when the surface genuinely doesn't fit any existing one.

To add a new family:

1. Create `src/mcp/tools/<family>.ts` following the polymorphic pattern in
   any existing file. Define `handle<Action>` functions, a discriminated
   union schema, and a `register<Family>Tools(server, services)` exporter.
2. Register it in `server.ts`:
   ```typescript
   import { register<Family>Tools } from "./tools/<family>.js"
   // ... in main():
   register<Family>Tools(server, services)
   ```
3. Do not forget the try/catch + `toolError()` wrapper inside each handler.
4. Add the tool to the Tool Reference table in this file and in the root
   `README.md`.
5. Add tests to `polymorphic.test.ts` exercising at least: registration,
   each action's dispatch, an unknown-action error, and a per-action
   missing-required-field error.

## Error Handling

The `toolError()` helper in `helpers.ts` formats errors for MCP:

```typescript
export function toolError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err)
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  }
}
```

**Rule**: Never let exceptions propagate out of a tool callback. The MCP transport
does not handle thrown errors gracefully. Always catch and return `toolError()`.

### Partial-failure observability (`LORE_DEBUG`)

Read-path fan-outs that use `settleAll` (see `core/settle.ts`) return partial
results plus per-root failures rather than sinking the whole call. Failures
surface to the agent via the existing `Warnings:` footer, but that signal
stops at the MCP response — operators running the server see nothing.

When `LORE_DEBUG=1`, tool handlers call `debugLogPartialFailures(toolName, failures)`
after the resolver returns. The helper is a no-op when the env var is unset,
and otherwise emits one stderr line per failure:

```
[lore] partial-failure: root=<rootId> error=<message> tool=<toolName>
```

The convention is opt-in precisely because routine transients would flood
stderr. Operators who want to distinguish a one-off 429 from a pathological
corrupted-page loop set `LORE_DEBUG=1` for a session. Every new partial-result
surface (PF1-01 bounded retries, wake-up's parallel queries, etc.) should
route its failures through the same helper so `grep "[lore] partial-failure:"`
stays comprehensive.

Only `error.message` is logged — not `.stack`, `.body`, `.headers`, or the
full error object. This narrows the log surface and keeps the bulk of Notion
SDK error metadata out of stderr. It is **not** a redaction boundary: some
SDK errors (e.g. `InvalidPathParameterError`) interpolate request-scoped
detail into `.message` itself, which will still appear. `LORE_DEBUG=1` is
operator instrumentation, not a sensitive-data filter.

Interpolated `rootId` and `message` fields have ASCII control characters
(`0x00-0x1F`, `0x7F` — including `\n`, `\r`, `\t`) replaced with spaces
before the line is written. One failure always produces exactly one log
line, so `grep` and log-aggregator parsers can rely on newline-delimited
events even if a future caller threads a stringly-typed multi-line error
through the same helper.

## Server Startup

`server.ts` runs as a standalone process (the `dist/mcp.js` entry point):

1. Creates an `McpServer` instance with `tools` and `resources` capabilities.
2. Calls `initServices()` to load config, connect to Notion, and resolve context.
3. Registers all tool groups.
4. Connects to a `StdioServerTransport`.

If `initServices()` fails (no config, bad token, etc.), the process exits with
code 1 and logs the error to stderr.
