# AGENTS.md -- src/mcp/

> Read the root `AGENTS.md` first. This file covers the MCP server layer only.

## Purpose

This directory implements Lore's MCP (Model Context Protocol) server. It is the
primary interface for AI assistants. The server runs as a stdio process and
exposes seven polymorphic tools — `lore-context`, `lore-memory`, `lore-query`,
`lore-fact`, `lore-decision`, `lore-project`, `lore-task`. The 24 P3-01
single-purpose tool names and the four PF3-06 task aliases — redundant names
for actions already reachable under the polymorphic dispatchers — were
preserved as deprecated registrations through the `0.5.0` line and were
removed in the `0.6.0` deprecation purge. `lore-journal` was a polymorphic
tool in its own right (not an alias) whose actions migrated to
`lore-memory action='save'` with `kind: 'note'` and `lore-decision
action='create'`; it carried a deprecation banner across the same window
and came out in the same purge. See "Deprecation timeline" below.

## Files

| File                   | Responsibility                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `server.ts`            | Server entry point: init services, register tools, start stdio transport                                                              |
| `helpers.ts`           | `toolError()`, `paginationFooter()`, `debugLogPartialFailures()`, `formatDispatchError()`                                             |
| `tools/context.ts`     | `lore-context` polymorphic dispatcher (`status` / `wake-up` / `digest`)                                                               |
| `tools/memory.ts`      | `lore-memory` polymorphic dispatcher (`save` / `update` / `archive` / `expand` / `suggest-topic-key` / `compare`)                     |
| `tools/query.ts`       | `lore-query` polymorphic (read-path dispatcher; reuses handlers from memory.ts and knowledge.ts)                                      |
| `tools/project.ts`     | `lore-project` polymorphic dispatcher (`list` / `get`)                                                                                |
| `tools/knowledge.ts`   | `lore-fact` polymorphic dispatcher (`create` / `invalidate` / `extend`); read-side `ask` / `audit` handlers exported for `lore-query` |
| `tools/decisions.ts`   | `lore-decision` polymorphic dispatcher (`create` / `list` / `get` / `context` / `supersede` / `review`)                               |
| `tools/tasks.ts`       | `lore-task` polymorphic dispatcher (`create` / `update` / `close` / `list` / `reconcile`) (P3-02 + PF3-06)                            |
| `tools/date-schema.ts` | Shared `YYYY-MM-DD` and clearable date Zod schemas for MCP tool boundaries                                                            |
| `tools/text-schema.ts` | Shared `nonBlankString` Zod schema for create-required user-facing text fields (rejects empty / whitespace-only)                      |

## Polymorphic dispatch pattern (P3-01 + PF3-06)

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

3. **One handler per action.** Handlers are local async functions named
   `handle<Action>` taking `(services, args) → Promise<ToolResult>`. The
   polymorphic dispatcher routes to the right handler via the discriminated
   union's `action` discriminator.

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

### Deprecation timeline (historical)

The 28 deprecated single-purpose aliases (24 from P3-01 + 4 from
PF3-06) plus the `lore-journal` polymorphic tool were **removed in
the `0.6.0` deprecation purge.** Diary-style memories now go through
`lore-memory action='save'` with `kind: 'note'`, architectural
decisions through `lore-decision action='create'`, and historical
`agent_diary` memories remain readable via `lore-query action='recall'`
with `source: "agent_diary"`. The seven remaining polymorphic
dispatchers are the only registered MCP tool surface;
`polymorphic.test.ts` pins the surface at exactly 7 names and fails
loudly if a new alias re-enters the registration list.

The deprecation window existed because every alias's schema was
rendered into the agent-visible config string and therefore consumed
prompt budget on every reconnecting session for as long as the alias
existed. The original target was MCP server `0.5.0`; the actual
removal slipped one minor (`0.6.0`) but the rationale is unchanged.

Pattern for future deprecation cycles:

- Add a `TODO(<target-version>)` sentinel to each contiguous removal
  block so `grep -rn "TODO(<version>)" src/` finds the entire surface
  atomically.
- Land the deprecation purge as one PR that removes the registrations,
  drops the corresponding entries from `DEFAULT_SAVE_ALLOWLIST` in
  `src/hooks/background.ts`, and tightens the `polymorphic.test.ts`
  surface count assertion.
- Treat the rename of "deprecation timeline (current)" → "deprecation
  timeline (historical)" as part of the purge so future contributors
  inspecting the file can tell the work is done.

## Tool Registration Pattern

Every tool file exports a single `registerFooTools(server, services)` function
that calls `server.registerTool()` for each tool. The pattern:

```typescript
import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import { toolError } from "../helpers.js"

export function registerFooTools(server: McpServer, services: LoreServices): void {
  server.registerTool(
    "lore-verb-noun",
    {
      title: "Human-readable title",
      description: "What this tool does. Include usage guidance for the AI.",
      inputSchema: {
        paramName: z.string().describe("What this parameter is for"),
        optionalParam: z.string().optional().describe("Optional context"),
      },
      annotations: { readOnlyHint: true }, // if tool only reads data
    },
    async ({ paramName, optionalParam }) => {
      try {
        // ... tool logic ...
        return { content: [{ type: "text", text: "result" }] }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
```

### Mandatory conventions

1. **Tool names**: Always `lore-<verb>` or `lore-<verb>-<noun>` in kebab-case.

2. **try/catch**: Every tool callback must wrap its body in try/catch and return
   `toolError(err)` on failure. MCP protocol requires tools to report errors as
   content, not throw exceptions.

3. **inputSchema**: Always uses Zod objects. Each field must have a `.describe()`
   call explaining the parameter to the AI.

4. **Clear sentinels**: For optional update fields, omission always means
   "leave unchanged." For clearable non-string Notion properties, `null` is the
   canonical clear sentinel; MCP schemas may also accept `""` as an
   agent-friendly alias, but must normalize it to `null` before calling domain
   services. For string / rich-text properties such as `synopsis`,
   `alternatives`, and `consequences`, `""` is the clear value because the
   field domain is text. The field `.describe()` copy must state the keep /
   clear behavior whenever a parameter can clear existing data.

5. **annotations**: Set `readOnlyHint: true` for tools that only read data.
   Set `destructiveHint: true` for tools that delete or archive.

6. **Project resolution**: Most tools accept an optional `projectName` /
   `projectNames` parameter. Explicit project scope is strict: if the
   caller passes a name, every named project must resolve or the tool must
   return an error before reading or writing scoped data. For **write**
   tools (memory, knowledge, decisions, tasks) prefer
   `resolveProjectIds(services, projectName, projectNames)` from
   `resolve.ts`. For **read** tools that accept an explicit `projectName`
   parameter, use `resolveReadProjectScope(services, projectName)`. Read
   tools that always operate on the auto-detected context keep reading
   `services.context.project` directly. The write-path resolver handles the
   catch-all warning for omitted scope:

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

7. **Return format**: Always return `{ content: [{ type: "text", text: "..." }] }`.
   Format output as readable markdown when returning multiple items.

8. **Tags are a closed vocabulary.** Any tool that accepts `tags` must use
   `tagsSchema` from `tools/tag-schema.ts` (backed by `TAG_VOCABULARY` in
   `types.ts`). Pair it with `keywordsSchema` so callers have a home for
   free-form tokens (PR numbers, ticket IDs, file paths, class names).
   Out-of-vocab tags must fail validation — don't loosen this at the tool
   boundary.

9. **Interactive init failures stay MCP-visible.** If `initServices()` fails
   during normal MCP startup, register diagnostic stubs for every `lore-*`
   dispatcher and connect stdio so the client gets recovery text. Do not
   call `process.exit(1)` for interactive init failures unless the diagnostic
   startup path is replaced by another MCP-visible recovery surface.

## Tool Reference

> Each polymorphic tool is documented as a single row with its action set.
> If service initialization fails, `server.ts` still starts stdio in
> diagnostic mode and registers stubs for all seven `lore-*` dispatchers.
> Every diagnostic tool call must return the initialization error plus setup
> recovery steps.

### `lore-context` — vault context operations

| Action    | Purpose                                                                                                                                                                                                                    | Read-only |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `status`  | Vault page id, database counts, active project, task summary, proposed-memory inbox count (proposed learnings; proposed-state decisions surface via `lore-decision` instead), wake-up coverage, background hooks, projects | Yes       |
| `wake-up` | Load digest + recent memories + active tasks + active facts + decisions requiring attention                                                                                                                                | Yes       |
| `digest`  | Gather raw activity data for synthesis into a `source: digest` memory                                                                                                                                                      | Yes       |

#### Two-tier default for `lore-context action='wake-up'`

`lore-context action='wake-up'` defaults to **title-tier rows** (title +
metadata, no body) across Recent Memories and Related to Active Tasks. This
is the same content-off discipline as `lore-query action='recall'` /
`lore-query action='search'` (below), extended to the session-priming tool
where the pre-P2-01 default used to fan out one `pages.retrieveMarkdown`
per memory on every call.

- **Default path.** Agents get heading + `source | tags | date` per
  memory. Bodies are omitted; the section size reduction is measured at
  ~60% against the Mail production vault (10 recent + 10 active tasks +
  15 knowledge facts, no digest).
- **Opt in.** Pass `expand: true` to restore the pre-P2-01 body-inclusive
  output. The digest memory (`source: digest`) always renders with its
  body regardless — the digest IS the content.
- **Per-section caps.** `limit` (memories), `taskLimit`,
  `knowledgeFactLimit` are independent knobs so callers can bound one
  section without truncating others. `taskLimit: 0` short-circuits the
  Tasks Notion query.
- **`limit` counts clusters, not rows.** Topical collapse runs on the
  display side: wake-up over-fetches the memory sections by
  `COLLAPSE_OVERFETCH_MULTIPLIER` (`src/mcp/tools/context.ts`), groups
  near-duplicate memories (title-token Jaccard ≥ 0.5 OR tag-set overlap
  ≥ 0.5), then slices by cluster count so the agent sees a stable
  number of distinct topics. Collapsed peers render on the representative
  as `(related: <uuid>, <uuid>)` — **full Notion UUIDs**, so an agent
  can call `lore-query action='recall'` / `lore-decision action='get'`
  with the trailer ID to fetch the peer's body. Even when `expand: true`,
  only the representative's body is rendered; collapsed peers stay
  suppressed.

This joins `lore-query action='recall'` / `lore-query action='search'`
under the `0.2.0` server version. MCP clients that relied on the previous
eager-body default will observe the change on reconnect.

#### Ranked output via `userQuery` (P3-05)

`lore-context action='wake-up'` accepts an optional `userQuery`
parameter. When set, it fires an additional relevance search seeded
by that text and surfaces the hits as a **For Your Current Task**
section directly under the digest, above Recent Memories. This
mirrors the shell hook's P3-05 ranked path so MCP-direct callers (an
agent calling wake-up explicitly after `/clear`, or to refresh
context after a session pivot) see the same query-aware output the
hook ships on first prompt.

- **No userQuery → unchanged output.** The section is omitted entirely
  on the no-query path, so legacy callers see byte-identical pre-P3-05
  output.
- **`taskMemoryLimit`.** Independent knob (default 3) capping the
  visible-cluster count for the task section. `taskMemoryLimit: 0`
  short-circuits the Notion search AND the section render.
- **Cross-section dedupe.** A memory rendered in the digest, Recent
  Memories, or Related to Active Tasks never re-renders under For Your
  Current Task. Dedupe is by Notion ID; topical-overlap dedupe is not
  done deliberately (a memory adjacent in the vector neighborhood but
  with a different ID may still render in two sections — relevance
  ranking surfaces it more than once because it is, in fact, relevant
  more than once).
- **Truncation.** `userQuery` is truncated to 1000 chars before search
  with a UTF-16 surrogate-tail strip so a paste at exactly 1KB never
  produces a malformed string.
- **The data layer is shared with the hook.** Both `loadWakeUpData`
  callers see the same `userQuery` / `taskMemoryLimit` options on
  `WakeUpOptions`; the only divergence is rendering (the hook emits
  flat list items, the MCP tool routes through `collapseOverlappingMemories`).
- **Per-section caps mirror the hook (PF3-04).** When `userQuery` is
  set and the caller hasn't overridden a section, the MCP tool falls
  back to the same `RANKED_WAKEUP_LIMITS` constant that the hook
  applies — exported from `src/core/wakeup.ts` so the surfaces share
  one source of truth. Caller-supplied `limit`, `taskLimit`,
  `knowledgeFactLimit`, and `taskMemoryLimit` still win; the ranked
  caps are defaults, not ceilings. The MCP layer then over-fetches by
  `COLLAPSE_OVERFETCH_MULTIPLIER` for the memory sections that go
  through topical collapse, so visible row counts converge with the
  hook output even though the data-layer requests differ.

  | Section                       | Ranked cap (`userQuery` set) | Surface default (no `userQuery`) |
  | ----------------------------- | ---------------------------- | -------------------------------- |
  | Recent Memories (no digest)   | 3                            | 10                               |
  | Recent Memories (with digest) | 3                            | 3                                |
  | Related to Active Tasks       | 2                            | 5                                |
  | Active Facts                  | 10                           | 25                               |
  | For Your Current Task         | 3                            | n/a (section omitted)            |

  Values live in `RANKED_WAKEUP_LIMITS` and the `DEFAULT_WAKEUP_*`
  constants in `src/core/wakeup.ts`; restated here so an operator
  triaging "why is wake-up surfacing only 3 memories?" doesn't have to
  chase the constants.

  **Backwards-compat note:** an MCP-direct caller that passes `userQuery`
  without explicit per-section args sees fewer rows post-PF3-04 than
  pre-PF3-04. That is the entire point — the prior behavior diverged
  from the hook's ranked output. Callers that want the looser caps
  back can pass them explicitly (`limit: 10, knowledgeFactLimit: 25`,
  etc.) and the explicit args win over the ranked defaults. The MCP
  server version is bumped (`0.4.0 → 0.5.0`) so reconnecting clients
  observe the change.

#### Wake-up coverage counters

`lore-context action='wake-up'` accepts `debug: true` to append the same
privacy-conscious coverage line that the shell hook logs under
`LORE_DEBUG=1`. The MCP renderer must adjust the data-layer counters before
formatting them: Recent, Related, and For-Your-Current-Task counts are
post-collapse visible clusters, and Tasks is the post-bucketing visible row
count. Do not include raw query text, memory titles, fact text, or bodies in
coverage output.

### `lore-memory` — memory mutations + batch hydration

| Action              | Purpose                                                                      | Read-only        |
| ------------------- | ---------------------------------------------------------------------------- | ---------------- |
| `save`              | Create a new memory (with parallel near-duplicate probe)                     | No               |
| `update`            | Mutate title / body / tags / kind / status / relations on an existing memory | No               |
| `archive`           | Soft-delete a memory by ID                                                   | No (destructive) |
| `expand`            | Batch-fetch full markdown bodies for up to 20 IDs (parallelized)             | Yes              |
| `suggest-topic-key` | Suggest a stable topic key for recurring memory topics                       | Yes              |
| `compare`           | Record a conflict/compatibility verdict on a pair of memories                | No               |

Read-side `recall` and `search` live on `lore-query` since they share
structural overlap with the rest of the read-path surface.

### `lore-query` — vault read paths

| Action   | Purpose                                                                                                                                                                    | Read-only |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `recall` | List recent memories with server-side filters; cursor-paginated                                                                                                            | Yes       |
| `search` | Memory search — DS-scoped contains, workspace-wide semantic, or parallel hybrid (default). `mode` selects; see "`lore-query action='search'` mode parameter (P3-04)" below | Yes       |
| `ask`    | Query facts and tasks about an entity, grouped into Governance / Structure / Tasks buckets                                                                                 | Yes       |
| `audit`  | List facts, decisions, and tasks past their review-by date                                                                                                                 | Yes       |

For tracked work (open / blocked / done), use `lore-task action='list'`
rather than `lore-query`. The pre-#23 `open-loops` action and the
underlying `FactService.listTracking` paginating helper were removed
in 0.6.0 — tracking predicates were dropped from `FactPredicate` and
the canonical surface for tracked work is the Tasks Memories DB.

#### Near-duplicate probe on `lore-memory action='save'` and `lore-decision action='create'`

Both write tools run `findNearDuplicates()` (see `src/core/near-duplicate.ts`)
in parallel with the create. When the probe finds rows whose title
trigram similarity meets threshold (0.7 for memories, 0.6 for decisions),
the response adds a trailing `Warning:` block listing the candidates.

- `lore-memory action='save'` recommends `lore-memory action='update'` or
  `lore-decision action='create'` with `supersedesIds`.
- `lore-decision action='create'` emits a ready-to-copy
  `lore-decision({ action: 'supersede', ... })` line per candidate,
  scoped to same-project + same-topic + active status.

The general probe is advisory only — it never blocks the save, and a
probe failure returns silently (no trailing warning, save succeeds as
normal). Rows the caller already superseded via `supersedesIds` are
dropped from the warning list to avoid re-warning about known
duplicates.

Exception: Stop-spawn atomic learnings have a structural duplicate gate
before create. In a `LORE_BACKGROUND_AGENT=true` process, a
`lore-memory action='save'` call shaped like the learning prompt
(`source: "conversation"` default, `kind: "note"`,
`confidence: "likely"`, non-empty `session`) checks existing likely
conversation notes in the exact resolved project set when an explicit
or non-catch-all project scope is available. Projectless saves and
auto-resolved catch-all project saves stay scoped to the current
vault/config root plus session. A duplicate returns the existing row
and creates nothing. This intentionally does not apply to synopsis-style
saves where `confidence` is omitted or non-`likely`.
When `topicName` is present, topic creation is deferred through
`MemoryService.createWithResult()` and runs only after the locked
service-layer duplicate recheck commits to a fresh memory row; duplicate
reuse must not leak an orphan Topic.
Set `LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1` to bypass only this
structural gate; `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` bypasses it too
for one-switch near-duplicate rollback.

Set `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` to skip the probe entirely
in bulk-import, fixture, or autosave contexts where the per-save
`dataSources.query` is unwanted overhead. See `src/core/AGENTS.md`
for the full scoping rules and the implementation-side rationale.

#### Content-off default for list/search tools

`lore-query action='recall'` and `lore-query action='search'` both default
to **`includeContent: false`**. Each returns index-tier rows — title,
metadata, timestamps — without fetching the markdown body for each page.
Fetching bodies costs one extra `pages.retrieveMarkdown` round-trip per
row, and most triage paths only need a handful of bodies for the rows the
agent actually cares about.

- **Default path.** Agents scan the index tier, decide which rows are
  relevant, then fetch bodies in one shot via
  `lore-memory action='expand'` with `ids: [...]`. For decisions
  specifically, `lore-decision action='get'` also renders the
  structured rationale (alternatives, consequences, supersession
  chain). The response footer reminds callers that bodies were omitted.
- **Opt in.** Pass `includeContent: true` when the caller genuinely needs
  every body — e.g. exporting a window of memories or piping into another
  indexing pipeline. The hot path stays fast by default, and the slow path
  is explicit.

Changing this default is a breaking change for agents that relied on eager
bodies; the server version is bumped to `0.2.0` in `server.ts` so MCP
clients see the shift immediately.

#### `lore-query action='search'` mode parameter (P3-04)

`lore-query action='search'` exposes three execution modes via a `mode`
parameter (default `"hybrid"`). The MCP tool surfaces the mode but the
actual switching lives in `MemoryService.search` — see
`src/core/AGENTS.md` for the per-mode filter composition.

| Mode               | Notion endpoint     | Scope            | Property filters                                                   | Body relevance                                               |
| ------------------ | ------------------- | ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------ |
| `contains`         | `dataSources.query` | Memories DS only | Server-side                                                        | No (server-side `contains` on Title, Keywords, and Synopsis) |
| `semantic`         | `client.search`     | Workspace-wide   | Post-filter                                                        | Yes                                                          |
| `hybrid` (default) | Both, in parallel   | Best-of-both     | Server-side on the contains leg, post-filter on the RRF-fused tail | When contains under-shoots                                   |

Why default to hybrid:

- **No more workspace leakage on the saturating case.** Pre-P3-04, every
  search call paid for `client.search`'s 100-row workspace-wide page
  even when 99 of the 100 results were unrelated pages from the user's
  personal Notion. Hybrid uses contains rows alone when contains
  saturates (`>= HYBRID_FALLBACK_THRESHOLD`, default 3), so the result
  set is DS-scoped and free of workspace pages.
- **Server-side property filters when scoped.** Contains and the
  contains leg of hybrid apply `kind`, `status`, `tags`, and `topicName`
  server-side. Pre-P3-04, all of these were post-filters, so a
  `kind: "decision"` search would fetch 100 candidates and discard
  most. Now Notion does the narrowing.
- **Vector ranking when contains is too narrow.** Phrase-shaped
  fact subjects like `"PR #25650 outlook label.applied classifier"`
  do not appear verbatim in titles, so contains may miss them. The
  parallel semantic call backfills body-ranking results, capped at
  `limit` after dedupe.

**Speculative parallelism — wall-clock = max(contains, semantic).**
The hybrid path fires both queries via `Promise.all`. Worst-case
wall-clock is one round-trip (≈ `client.search` latency) regardless of
which leg saturates. The discarded-saturating-case cost is one wasted
Notion call governed by the shared rate limiter; the round-trip itself
overlaps the contains query. The earlier sequential design (run
contains, then run semantic on under-shoot) regressed wall-clock for
the common phrase-shaped case — that's been replaced.

Callers can opt out of hybrid:

- Pass `mode: "contains"` for "scope tightly, never leak workspace pages,
  never pay the wasted semantic call." Use when you know the query is a
  literal substring (PR numbers, file names, function names).
- Pass `mode: "semantic"` to force the workspace-wide ranked path
  (e.g. `loadWakeUpData`'s related-memory pass relies on Notion's
  vector ranking against active-task entity names).

`HYBRID_FALLBACK_THRESHOLD` is exported from `core/memory.ts` so test
fixtures and diagnostics can reference the same constant.

**Rollback lever.** `LORE_FORCE_SEMANTIC_SEARCH=1` (read inside
`MemoryService.search`) routes every call through the legacy
workspace-wide path regardless of the caller's `mode`. Use as a
defensive escape hatch — same posture as
`LORE_DISABLE_NEAR_DUPLICATE_PROBE`. See `src/core/AGENTS.md` for the
encoding-migration scenario it's designed to handle.

**Diagnostic trace via `explain: true`.** `lore-query action='search'`
accepts an optional `explain: boolean` parameter. When set, the
response gains a `## Score trace` footer with one row per result
showing the resolved branch (`contains-only` / `semantic-only` /
`contains-saturated` / `rrf`), the per-branch rank, and the RRF
score (`rrf` branch only). Null fields render as `—` (em dash)
uniformly. The handler routes through `MemoryService.searchWithExplain`
when `explain` is set, leaving the default-path return shape unchanged
for callers that don't opt in. See `src/core/AGENTS.md` for the
branch-field rules and `SearchExplain` shape.

#### `recall` → `expand` pattern

Canonical triage flow once bodies are content-off by default:

1. `lore-query action='recall'` or `lore-query action='search'` returns
   title + metadata rows (one Notion round-trip).
2. Agent picks the handful of rows whose bodies it actually needs.
3. `lore-memory action='expand'` with `ids: [...]` hydrates those bodies
   in one tool call, parallelized server-side so wall-clock is roughly
   one `pages.retrieveMarkdown` latency, not N.

`lore-memory action='expand'` caps at 20 IDs per call and dispatches via
`settleAll`, so a single failing ID does not collapse the whole response
— the failed row renders as `### (unresolved: <id>)` with the error
inline. Partial failures also route through `debugLogPartialFailures` so
operators running with `LORE_DEBUG=1` see them on stderr.

The cap deliberately exists one layer below the user: it is enforced by
the Zod schema on `ids`, not by runtime guards, so oversized calls fail
at the MCP boundary with a parsing error rather than partial-completing.
If an agent genuinely needs bodies for more than 20 memories, it re-
batches — but the expected path is to triage on the title tier first and
hydrate only the rows that matter. Blind-hydrating every title in chunks
of 20 re-introduces the prompt tax that content-off defaults were
designed to remove.

### `lore-project` — project read paths

| Action | Purpose                                                                                | Read-only |
| ------ | -------------------------------------------------------------------------------------- | --------- |
| `list` | List active projects by default; `status: "archived"` is archived-only and `"any"` all | Yes       |
| `get`  | Get active project details including topics and recent activity                        | Yes       |

### `lore-fact` — knowledge graph mutations

| Action       | Purpose                                                                                                                                                                                             | Read-only        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `create`     | Add a subject-predicate-object fact triple (auto-dedupes via `DedupKey`). Tracking predicates were dropped from `FactPredicate` in 0.6.0 — the Zod-derived schema rejects them at the MCP boundary. | No               |
| `invalidate` | Invalidate a fact (sets Valid Until, does not delete)                                                                                                                                               | No (destructive) |
| `extend`     | Set, advance, or clear a fact's review-by date                                                                                                                                                      | No               |

Read-side fact paths (`ask`, `audit`) live on `lore-query` — see the
table above. The `ask` action surfaces tasks touching the entity
alongside Governance and Structure buckets so callers see tracked work
inline with the rest of the entity's facts.

### `lore-task` — task lifecycle (PF3-06)

| Action      | Purpose                                                                                                                                                 | Read-only                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `create`    | Create a `Kind = task` memory with description in the page body                                                                                         | No                                                                                                                                 |
| `update`    | Change state, blocker, due date, subject, or description                                                                                                | No                                                                                                                                 |
| `close`     | Mark done (or cancelled — distinguished for metrics)                                                                                                    | No (destructive)                                                                                                                   |
| `list`      | List tasks with Overdue/Active sections; filters by state, entity, due                                                                                  | Yes                                                                                                                                |
| `reconcile` | Operator-pulled batch pass: scan active tasks for resolution-shaped memory matches and surface ranked candidate closures with inline close incantations | Yes (read-only by handler implementation; tool-level `readOnlyHint` cannot be set because the same tool also serves write actions) |

PF3-06 brought the P3-02 standalone task family under the same
polymorphic dispatcher pattern as the rest of P3-01. The four standalone
names (`lore-task-create`, `lore-task-update`, `lore-task-close`,
`lore-tasks`) shipped as deprecated aliases on the `0.5.0` line and were
removed in the `0.6.0` deprecation purge alongside the 24 P3-01 aliases.
`DEFAULT_SAVE_ALLOWLIST` in `src/hooks/background.ts` now lists only the
polymorphic surface (`lore-memory`, `lore-fact`, `lore-decision`,
`lore-task`).

#### Task model

Tasks are the canonical surface for tracked work. Three properties on the
Memories DB carry the lifecycle:

- `Task State` — `open` / `in-progress` / `blocked` / `done` / `cancelled`
- `Blocked By` — free-form blocker label (PR number, person, service)
- `Entity` — normalized subject the task is about; defaults to title

The body of a task page carries the full description (no rich_text length
cap), unlike the pre-P3-02 tracking-predicate facts whose 187-char-average
Object field was a Jira-ticket-shaped paragraph in a graph slot meant for
atomic relationship objects. Tracking predicates were dropped from
`FactPredicate` in 0.6.0; tracked work no longer flows through `lore-fact`.

### `lore-decision` — decision lifecycle

| Action      | Purpose                                                                                                             | Read-only |
| ----------- | ------------------------------------------------------------------------------------------------------------------- | --------- |
| `create`    | Save a decision; auto-creates `decided_by` facts per `affects` entry and `supersedes_decision` facts if superseding | No        |
| `list`      | Index-tier listing of decisions (properties only, no body fetch)                                                    | Yes       |
| `get`       | Load full rationale + metadata for one decision                                                                     | Yes       |
| `context`   | Graph walk: every active decision governing an entity (via `decided_by` facts)                                      | Yes       |
| `supersede` | Mark old decision as superseded by new; atomic + creates `supersedes_decision` fact                                 | No        |
| `review`    | Mark a decision as reviewed; set, advance, or clear `Review By` (default +90 days)                                  | No        |

**Decision predicates are internal-only.** `decided_by`, `supersedes_decision`,
and `informs` are in the `FactPredicate` union and the Notion `Predicate`
select options, but they are NOT in `PREDICATE_VALUES` in `tools/knowledge.ts`.
This prevents users from creating inconsistent decision edges via
`lore-fact` — only `DecisionService` and the decision tools create
these facts.

**`lore-fact action='create'` requires provenance.** Every fact must link
back to a supporting memory so `lore-query action='ask'` can retrace the
reasoning. The tool resolves the source in this order:

1. Explicit `sourceMemoryId` argument — highest precedence, but it must
   resolve to a live Memories row whose project scope intersects the fact's
   (or either side is vault-wide). The property-tier read happens before
   Entity resolution so typoed or inaccessible sources cannot leave
   Entity side effects.
2. Session auto-link: if the caller passes `agent`+`session` and a
   `lore-memory action='save'` / `lore-decision action='create'` call
   earlier in this process recorded a memory under the same composite
   key, that memory becomes the source **only if** its project scope
   intersects the fact's (or either side is vault-wide). This path is a
   process-local optimization: it trusts the in-process write order and
   tracker metadata instead of re-reading the memory from Notion, so it
   does not detect a source memory archived after it was saved in the
   same process. The response shows "auto-linked from session" so the
   caller can audit the link.
3. Neither available, the explicit source is unresolved/incompatible, or
   the session candidate is project-incompatible → the create call returns
   an MCP error before Entity resolution or `FactService.createWithDedup`
   runs. Pass a compatible `sourceMemoryId` explicitly to override an
   incompatible session candidate.

The Zod schema marks `sourceMemoryId` as optional only because
`agent`+`session` is also valid provenance input. A `superRefine` requires
either an explicit `sourceMemoryId` or the complete `agent`+`session`
pair, and runtime logic still rejects when the session tracker has no
usable compatible memory.

Existing orphan facts from the soft-phase window are handled out of band:
operators should use `lore migrate --backfill-fact-sources` to propose and
optionally apply conservative Source links.

The session mapping lives on `services.sessionMemories` (a per-process
`SessionMemoryTracker`). `lore-memory action='save'` and
`lore-decision action='create'` write into it with the memory's
`projectIds` so the auto-link project check has real data. The tracker
is keyed on a composite of `agent`+`session` so two agents connected to
the same MCP process cannot collide on a shared session string. Capped
at 256 entries with LRU eviction — no cross-process persistence.

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

`lore-fact action='create'` provenance precheck failures use a separate
parser-friendly prefix:

```
[lore] fact-precheck-rejected: reason=<reason> agent=<agent> session=<session> sourceMemoryId=<sourceMemoryId> project=<projectIds>
```

This line is emitted only for runtime provenance failures after schema
validation succeeds, such as unresolved session auto-link, cross-project
session candidate, unresolved explicit source, or cross-project explicit
source. `reason=` is the stable classifier; `agent`, `session`,
`sourceMemoryId`, and `project` are diagnostic context.

The convention is opt-in precisely because routine transients would flood
stderr. Operators who want to distinguish a one-off 429 from a pathological
corrupted-page loop set `LORE_DEBUG=1` for a session. Every new partial-result
surface (PF1-01 bounded retries, wake-up's parallel queries, etc.) should
route its failures through the same helper so `grep "[lore] partial-failure:"`
stays comprehensive.

Only `error.message` is logged — not `.stack`, `.body`, `.headers`, or the
full error object. The message then routes through `redactDebugError`
(`src/debug-redact.ts`) before stderr (issue #488):

- **Must-redact (token-leak class).** Bearer-token-shaped substrings
  (`ntn_…` / `secret_…` followed by ≥20 url-safe chars) → `<redacted-token>`.
  Today's Notion SDK does not interpolate tokens into `Error.message`;
  the guard is forward-compatible against a regression in the same class
  axios pre-1.x shipped (echoing `Authorization` headers in retry traces).
- **Should-redact (recon class).** Notion page-id shapes
  (`[a-f0-9]{32}` and the dashed UUID form) → `<page-id>`. Page IDs
  are not bearer secrets per the root `AGENTS.md` Authentication section,
  but they let an outsider enumerate vault structure; same threat the
  PR is closing.
- **SDK-field stripping (flat-string scrubber).** `body=` / `headers?=`
  / `payload=` / `response=` / `request=` / `cause=` / `query=`
  substrings, walked by a state-machine scanner that handles
  arbitrary-depth balanced brace/bracket payloads (the depth counter
  walks through any nesting level — quoted spans inside structured
  payloads are skipped via the quoted-string handler so embedded `}`
  inside `"…"` doesn't confuse the depth math), single- or
  double-quoted strings with C-style escapes, or a bare token stopping
  at hard delimiters (`,`, `;`, `}`, `)`, `]`) OR at whitespace where
  the next non-space token is shaped like another `<name>=` field.
  **Unbalanced or malformed structured input deliberately consumes
  through end-of-string** — the conservative posture when the
  boundary is ambiguous. Forward-compatible against a future SDK
  regression that interpolates a JSON body into `Error.message`.
- **Structured-payload key-aware redaction (extraInfo walker).** The
  Notion SDK's `Logger` interface passes a structured `extraInfo`
  object alongside the `message`. `redactDebugExtraInfo` walks the
  object recursively but applies a **key-aware wholesale-redact rule**:
  when a property's key is in `SENSITIVE_EXTRA_INFO_KEYS` (the same
  eight names as the flat-string scrubber, derived from a single
  `SDK_SENSITIVE_FIELD_NAMES` source) AND the value is not an `Error`,
  the entire value is replaced with `<redacted>` regardless of nested
  shape. This closes the structured-content leak class where leaf-only
  scrubbing would walk into `{ body: { properties: { Name: { title:
[...] } } } }` and only catch substring-shaped leaks. The Error
  escape-hatch preserves operator-actionable diagnostics — `request:
new Error("...")` walks through the Error special-case to extract
  `name` + scrubbed `message`. Recursion still fires for
  non-sensitive keys, so a nested sensitive key under a non-sensitive
  parent (`{ outer: { body: ... } }`) is still wholesale-redacted at
  the inner level. Walker depth is bounded at `MAX_EXTRA_INFO_DEPTH`
  to keep pathological inputs from triggering a recursion-induced
  `RangeError`.
- **Length bound.** Truncated to `MAX_DEBUG_MESSAGE_LENGTH` chars with
  a `…(truncated)` marker.

Operators retain the diagnostic value (error category and first sentence
of message) without leaking SDK-interpolated vault locators (e.g.
`InvalidPathParameterError`'s page-id detail) into a centralized log
aggregator. The explicit `root=<id>` / `memoryId=<id>` / `entity=<value>`
interpolations are intentionally NOT redacted — operators need them to
triage which root failed.

The `eslint.config.js` `no-restricted-syntax` rule fires when a
`process.stderr.write` template literal interpolates an error message
directly (`${err.message}`, `${error.message}`, `${String(err)}`,
`${errorMessage(err)}`, or a ternary thereof). New `LORE_DEBUG`-gated
emitters land safely as `${redactDebugError(err)}` — the wrapped form
sidesteps the rule because the immediate template expression is a call
to the redactor. The lint rule is a backstop, not a complete defense:
a contributor who routes the message through a custom helper that
itself calls `process.stderr.write` could still bypass redaction. The
contract is documented here and in the redactor's own docstring;
review-side enforcement remains the load-bearing layer.

Interpolated `rootId` and `message` fields have ASCII control characters
(`0x00-0x1F`, `0x7F` — including `\n`, `\r`, `\t`) replaced with spaces
before the line is written. One failure always produces exactly one log
line, so `grep` and log-aggregator parsers can rely on newline-delimited
events even if a future caller threads a stringly-typed multi-line error
through the same helper.

**Per-surface key names diverge; the prefix and `error=` field are
the stable contract.** Core-layer surfaces emit `[lore]
partial-failure:` lines too (e.g. hybrid search in
`src/core/memory.ts:debugLogHybridBranchFailure` uses
`branch=<contains|semantic> source=hybrid-search`) because a
non-MCP failure isn't a Notion root id and `tool=` would be
misleading for a core-service path. Downstream log parsers should
match on the `[lore] partial-failure:` prefix and the `error=`
field; per-surface keys are scoped to their surface and may
introduce new names as future call sites land. See
`src/core/AGENTS.md` for the hybrid-search divergence in detail.

## Server Versioning

The lore version is reported in four places that **must move together**:

1. `package.json#version` — what `npm`, dependency consumers, and `npm publish` see.
2. The `version` string passed to `new McpServer({ name, version }, ...)` in
   `src/mcp/server.ts` — what every connected MCP client sees on the protocol handshake.
3. The `.version(...)` argument in `src/cli/index.ts` — what `lore --version`
   reports to humans on the command line.
4. The `USER_AGENT` constant in `src/notion/client.ts` — the `User-Agent` header
   sent on every Notion API request, used by Notion's API analytics to attribute
   lore traffic.

These are intentionally separate string literals (no runtime
`import` of `package.json`, no generated `version.ts`) so the build has
zero JSON-resolution wiring. The cost is that drift is silent: a bump in
one file will not fail the build or any test. Treat them as a paired
release-checklist item — when bumping the version for an agent-observable
change (new tool, removed alias, default-behavior flip), update all four
files in the same commit and add a row to the historical-bumps table
below so the table doesn't go stale.

A vitest assertion that reads each file, parses the version literal, and
asserts equality was considered and deferred — release-checklist
discipline suffices at the current bump cadence. Revisit if a future
change introduces a `version.ts` source of truth or if the cadence picks up.

Historical bumps and what they signalled:

| Version  | Signal                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0.2.0`  | Content-off default for `lore-query` action='recall' / action='search' (and later `lore-context` action='wake-up')                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `0.3.0`  | Open loops ranking contract (`OVERDUE_SEVERE_DAYS` / `OVERDUE_MILD_DAYS`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `0.4.0`  | P3-01 polymorphic tool surface (24 → 7 dispatchers + deprecated aliases)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `0.5.0`  | PF3-04 ranked-mode default caps for MCP `lore-context action='wake-up'` (parity with shell wake-up)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `0.5.1`  | `lore status` tracking-predicate preflight (issue 0.6.0/24) — counts live `needs_action` / `waiting_on` / `blocked_by` facts and warns operators to run `lore migrate --migrate-tracking-to-tasks --yes` before the 0.6.0 deprecation purge removes the read path. CLI / operator UX only; no MCP tool surface change, but the four version literals move together so the patch ships as one atomic bump                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `0.6.0`  | Deprecation purge: 28 alias removals, `lore-journal` tool removal, `decodeTopicHtmlEntities` re-export removal, tracking-predicate read-path removal (issues #20+#21+#22+#23). RRF + explain in hybrid search (#16). Search intent parameter (#17). Per-project context on wake-up/ask (#18). OSC 8 CLI hyperlinks (#19). Claude Code SessionEnd hook install removal and Stop-triggered auto-digest (#26). Release coordinator: #25.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `0.7.0`  | Memory `Synopsis` field rollout (#01–#04); optional `lore migrate --backfill-synopses` (#05); task-closure encouragement workstream: `Done At` schema (#07), CLAUDE.md operating-contract rule (#08), `lore-task` description tightening + closure CTA on create/update responses (#09), duplicate-task probe on `lore-task action='create'` (#10), active-task cross-reference on `lore-memory action='save'` (#11), Stale sub-section in wake-up `## Tasks` (#12), task summary line in `lore status` and `lore-context action='status'` (#13); `lore-task action='reconcile'` + `lore tasks reconcile` CLI (#14). Release coordinator: #06.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `0.8.0`  | Adaptive Confidence (Hermes-borrow workstream — adaptive confidence dynamics borrowed from the Hermes holographic-memory comparison without adopting any of Hermes's representational machinery). Two Memories schema additions: `Confidence Score` numeric 0–1 column (#01) and `Last Referenced At` date column (#02). New `src/core/decay.ts` with `touchOnRead` helper, `decayConfidenceScore` algebra, and `confidenceFactor` helper — write-time decay realization, not read-time computation (#03). CLAUDE.md operating-contract clarification of categorical `Confidence` (agent-set stance) vs. numeric `Confidence Score` (system-managed signal) (#04). `touchOnRead` wired into MCP read paths — `lore-query action='ask'` / `'recall'`, `lore-context action='wake-up'` — bumps `Confidence Score` and refreshes `Last Referenced At` on every read citation (#05). `lore-fact action='invalidate'` and `lore-decision action='supersede'` / `'create'` with supersession halve the originating memory's `Confidence Score` (#06). `lore-memory action='save'` auto-emits `mentions` facts for every entity surfaced in title / synopsis / keywords via `extractEntityCandidates` reuse; new `mentions` predicate added to `FactPredicate` (#07). Hybrid retrieval ranks by `confidenceFactor` so low-confidence rows surface less; null score treated as `1.0` for backwards-compat with un-backfilled vaults (#08). `lore-query action='recall'` / `'search'` and `lore-context action='wake-up'` listings render a trust indicator below threshold (#09). New Stale Confidence subsection in wake-up surfaces long-neglected memories (`Confidence Score < threshold OR Last Referenced At past cutoff`) for triage (#10). New `lore migrate --build-confidence-scores` operator command seeds `Confidence Score` from categorical `Confidence` and writes `Last Referenced At = created_time` with neglect decay applied for every pre-0.8.0 row (#11). Release coordinator: #12.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `0.9.0`  | 2026-05-01 — Engram-borrow — adds `lore-memory action='compare'` (verdict-recording on memory pairs over a frozen six-verdict vocabulary with explicit `affectedMemoryId` direction parameter; pair-scoped idempotency via `Compare Notes` membership check, NOT global fact existence; actionable verdicts dispatch through compare's `conflicts_with` / `supersedes` paths and the decision service); adds `Compared With` self-relation (single_property) and `Compare Notes` rich_text columns to Memories for skip-already-judged + verdict-reasoning audit trail with explicit char cap and chunked rich-text encoding; new `lore conflicts scan` CLI for on-demand lexical-candidate detection with self-describing JSON `compareContract` block; adds `Topic Key` rich_text + `Revision Count` number columns plus shared `MemoryService.findByTopicKey` lookup helper (paginated, project-set-equality, archived-aware); upsert-on-save semantics with structural-invariant validation BEFORE body write (kind cannot change; status / topic relation silently preserved); new `lore-memory action='suggest-topic-key'` heuristic helper grounded in the actual MemoryKind taxonomy; conservative re-key path on `lore-memory action='update'` with `topicKey` parameter (audit-block append, reject ambiguous collisions, reject combined `topicKey + kind` updates, no merge semantics); promotion advisory footer on upsert when revision count or body length crosses thresholds (no auto-promotion; upsert-path only); Stop-triggered background autosave prompt extended to extract atomic learnings as individual memories alongside the session synopsis with per-spawn cap (no foreground convention; kill-switch via `LORE_DISABLE_LEARNING_EXTRACTION` / `hooks.learningExtraction: false`); `lore install` adds `--client cursor` (project-scoped default; `--cursor-global` opts into ~/.cursor/mcp.json) and `--print-config <json\|toml>` escape hatch for hosts not directly supported; revision-count rendering on recall/search/wake-up listings via `formatMemoryListItem` (meta-line component below synopsis, separate from 0.8.0/09's trust line)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `0.10.0` | 2026-05-01 — ntn-First Auth — replaces shared-token deployment with per-user, per-engineer-identity ntn-issued bearer tokens (NOT a per-user OAuth flow built into Lore — Lore depends on Notion's internal `ntn` CLI for the auth handshake and reads the resulting bearer token). Engineers run `ntn login` and Lore reads the resulting bearer token from `~/.config/notion/auth.json`. Lore's `runNtnLogin()` / `installNtn()` helpers (#02) force `NOTION_KEYRING=0` in their spawn env so engineers don't need to set it in shell rc — the install path is seamless. Engineers running `ntn login` directly outside Lore without the env var hit ntn's keychain default; documented in the runbook (#05) as a known gotcha with two recovery paths. Lore depends on `ntn` ≥ `MIN_NTN_VERSION` (currently `0.12.0`); auto-installs latest via the canonical command `curl -fsSL https://ntn.dev \| bash` (sourced from ntn's own self-update error message) when missing, with operator confirmation. Below-minimum versions trigger a non-blocking warning; Lore prefers existing operator versions and never auto-upgrades. `resolveAuth` (`src/config.ts`) rewrites with a four-source priority order: `NOTION_API_TOKEN` env > ntn-resolved (auth.json read) > `LORE_NOTION_TOKEN` env (soft-deprecated) > `auth.token` in `.lore.yaml` (soft-deprecated). The `ResolvedAuth` discriminated-union from the parked OAuth epic collapses to a flat shape with a `source` field — every source produces a bearer token; ntn sessions rely on the shared client wrapper for bounded post-401 re-resolution rather than a refresh-token protocol (`#01`, #223). New `src/auth/ntn.ts` module covers (a) auth.json reading + workspace selection via `NOTION_WORKSPACE_ID` env / `auth.workspaceId` config / single-workspace auto-pick, (b) interactive `ntn login` shell-out via `runNtnLogin()` with stdio inheritance, (c) auto-install via `installNtn()`, (d) version detection via `getNtnVersion` / `checkNtnVersion` / `MIN_NTN_VERSION` (`#02`). `verifyVaultAccess(client, pageId)` preflight ported from the parked epic — auth-mode-agnostic, used by `--status`, `--login`, `--migrate`, and `lore init <page-id>` to catch "wrong workspace" / "page not shared with the engineer in this workspace" before downstream commands fail. Under ntn-first auth, tokens inherit the engineer's personal Notion permissions; there's no separate "share with Notion Workers CLI integration" step (`#03`). New top-level `Authentication` section in root `AGENTS.md` covering the four auth sources, per-token rate limit rule, the `auth.json` coupling as a temporary bridge, the Lore-managed `NOTION_KEYRING=0` posture (forced inside Lore's ntn spawns, not a shell-rc prerequisite), and the version-compat policy (`#04`). Internal-team rollout runbook at `docs/internal-rollout.md` documenting per-engineer onboarding, the `curl -fsSL https://ntn.dev \| bash` auto-install path, the version policy, `lore auth --migrate` walkthrough, dogfood criteria, and asks-list to the `ntn` CLI team for the official `ntn auth token --plain` command (`#05`). `lore auth --status` rewrites for the new auth-source surface; `lore auth --login` ships as a one-command auth path that probes prerequisites, auto-installs ntn if missing (with confirmation), runs `runNtnLogin()`, and verifies vault access; `--whoami` reads identity via `users.me`; `--logout` is informational and points at `ntn logout` since Lore doesn't manage ntn's storage (`#06`). `lore auth --migrate` walks `LORE_NOTION_TOKEN` operators through ntn setup, shells out to `ntn login` directly via `runNtnLogin()` (no press-Enter pause), runs double-preflight (legacy token reaches vault → ntn-issued token reaches the same vault) before printing unset instructions with shell-rc location detection (zsh / bash / fish) (`#07`). `lore install` adds three prerequisite probes (`isNtnInstalled`, ntn version check, auth-resolution — no operator-side `NOTION_KEYRING=0` probe under Option A); offers auto-install via `installNtn()` when ntn missing, auto-login via `runNtnLogin()` when auth missing — both with `--yes` for non-interactive automation; rewrites MCP-entry env-forwarding so the spawned MCP server reads auth.json via `LORE_CONFIG_ROOT` rather than relying on a static forwarded token; `LORE_SUPPRESS_DEPRECATIONS=1` always added to MCP env to silence per-session warnings from spawned children. `services.ts:initServices` honors `LORE_CONFIG_ROOT` env so MCP children resolve the right config without re-walking the filesystem (`#08`). `lore init` no-arg form runs against the resolved ntn token; offers auto-install + `runNtnLogin()` if no auth resolves; creates a workspace-level vault page via `pages.create({ parent: { type: "workspace", workspace: true } })` (per `developers.notion.com/reference/post-page` — "available only for bots of public connections"); runs preflight; initializes databases; writes `.lore.yaml` with `auth.workspaceId` populated when the resolved auth carries a workspace id. Existing-vault setup remains `lore init <page-id>` with a new preflight gate (`#09`). The OAuth + PKCE / broker work originally scoped as 0.10.0 is parked at `Lore-Issues/oauth-pkce-epic/` for a future external-rollout release. `auth.json` direct read is documented as a temporary coupling pending `ntn auth token --plain` (DEFERRED-OFFICIAL-EXPORT — superseded; the public `ntn` CLI does not expose token export and per maintainers none will ship. The auth.json read is the contract; see `src/auth/AGENTS.md` "The auth.json read is the contract" section for the live framing). |
| `0.10.1` | MCP startup diagnostics: interactive `initServices()` failures register diagnostic stubs for all seven `lore-*` dispatchers instead of disconnecting the client, while hook-spawned background-agent MCP children use `LORE_BACKGROUND_AGENT=true` to fail fast. `lore-task action='list'` response-shape clarification for issue #220: task-list headers now label totals as `(exact total)` or `(lower-bound total; listing capped at N)`, bucket totals gain `≥` only when the fetched window/cap saturated, and small-limit triage calls keep a bounded `4×limit` fetch window while larger explicit limits use a deeper bounded walk. Agent-observable MCP output change; four version literals move together.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `0.11.0` | 2026-05-03 — Post-ntn dogfood hardening release: per-user Memory/Decision/Task attribution (`DEFERRED-ATTRIBUTION`), dynamic Fact confidence mirror, first-class entity merge with fact repointing, bounded/resumable conflict scans, configurable background-agent command for Codex installs, MCP startup diagnostics, overdue tasks in query audit, Notion request throttling with 429 backoff, broader search/wake-up coverage, exact/lower-bound task totals, retry-safe topic-key upserts and compare dispatch, structural autosave dedup, duplicate-mine prevention, partial-failure reporting on multi-step writes, archived-row filtering across query/list surfaces, relation/vault pagination fixes, and hook/auth robustness. Agent-observable CLI/MCP output changes; four version literals move together.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `0.12.0` | 2026-05-03 — Phase-3 hardening release. Eval harness: `lore eval run` runs versioned YAML suites against fixture-backed services without live Notion (#306); committed `lore eval baseline` snapshots + CI drift gate fail PRs on regressed/missing results, post-baseline `memoryHarm` bumps, or silent coverage loss (#450); stale-memory ablation enforces status-aware retrieval as contract; eval tasks declare `surface: wake-up.taskMemories \| memories \| relatedMemories \| staleConfidence` (BREAKING artifact: `runner.surface` string → `runner.surfaces: EvalSurface[]` sorted), `lore-core` suite expanded 3 → 21 tasks across the four surfaces. Self-service Entities bootstrap (`lore vault ensure-entities`) creates Entities DB on legacy four-database vaults and adds Facts `SubjectEntity`/`ObjectEntity` columns (#336); archived project migration opt-in via `--include-archived` on confidence-score backfills (#337); vault topology section in `lore status` / `lore-context action='status'` with public type exports (#308, #322); wake-up coverage debug counters reach hooks AND MCP with `reason=no-ranked-search` / `already-ranked-for-session` / `load-failed` variants (#307, #416, #429, #436); background hook autosave/digest failure markers surface in status (#300, #334); pre-commit Git hook blocks staged `.lore.yaml` `auth.token` and personal page IDs (#445). BREAKING contracts: `lore-task action='create'` returns `Reused existing task:` on exact `(subject, entity, project-set)` duplicates instead of cloning (kill-switch `LORE_DISABLE_TASK_REUSE=1`); `lore-fact action='create'` hard-errors before Entity/Fact writes without explicit live `sourceMemoryId` or compatible same-process `agent`+`session` auto-link (#296); explicit project scope (`projectName` / `projectNames` / `--project`) fails closed on typo'd/archived/inaccessible/ambiguous names (#301); Entities is now a required fifth core database — legacy four-database vaults fail fast with manual repair guidance (#272, #302); `.lore.yaml` no longer git-ignored by default for shared credential-free vault config (#268). Plus: autosave learning dedup reuses exact-project matches across sessions with project-scoped lock + same/cross/unknown-session reuse labels and `LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP` kill-switch (#305, #323, #335, #352); rich-text metadata caps enforced in every write path with structured issue field rendering (#295, #333, #434, #439); MCP date fields clearable via `null` or empty-string sentinel where existing dates can be cleared (#297, #330, #421, #438); CLI numeric flags reject malformed/fractional/signed/exponent/coerced values (#298, #328); author identity resolution becomes lazy, write-scoped, and auth-snapshot-aware with `resetIdentityCache()` no-arg compat preserved (#299, #331); `lore-memory` MCP tool description shortened to reduce config-string pressure (#303); project listing defaults to active with `status: "any" \| "archived"` and archived-only diagnostics on explicit scope (#337); Codex wake-up becomes query-aware and debounced via atomic `UserPromptSubmit` per-session attempt marker created before Notion init (#304, #310, #332); long session ids classified as `LockPathTooLongError` instead of rethrowing into Stop hook (#485); unscoped topic updates warn structured instead of silently dropping (#291, #326); archived projects excluded from default resolution (#292); `lore mine` matches `Dockerfile`-style basenames and chooses fence lengths so inner Markdown fences survive (#293, #294); config rejects committed token-shaped values (`ntn_`, `secret_`, `Bearer secret_`) and starter-style `<...>` page IDs (#327, #408, #418, #444); project-scoped migrations require explicit scope decision (#277). Agent-observable CLI/MCP output changes; four version literals move together.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

| `0.13.0` | 2026-05-04 — Scope and lifetime release. Memories and Facts gain `Scope Kind` (`team` / `project` / `user` / `agent` / `role` / `session` / `run` / `environment` / `global`), `Lifetime` (`persistent` / `expires` / `session-only` / `until-task-closed` / `until-decision-superseded`), `Scope Key`, `Audience`, and `Expires At` columns; default reads on memories / tasks / decisions / facts apply a scope inclusion filter that ORs broadcast scopes, narrow-scope-and-key matches against `MemoryScopeContext` (`LORE_USER_NAME` / `LORE_AGENT_NAME` / `LORE_ROLE` / `LORE_SESSION_ID` / `LORE_RUN_ID` / `LORE_ENVIRONMENT`), and an expiry-not-passed clause; audit / migration paths opt out via `includeOutOfScope: true`; fact dedup is scope-aware (same triple under different scope kind/key produces two rows so a session-scoped write never silently absorbs into an existing team row); MCP write tools (`lore-memory action='save' \| 'update'`, `lore-task action='create' \| 'update'`, `lore-fact action='create'`, `lore-decision action='create'`) accept an optional `scope` bundle mirroring `MemoryScopeInput`; `lore status` and `lore-context action='status'` surface `Expired scoped rows` / `Expiring soon (≤7d)` / `Narrow-scope rows outside this context` triage lines when non-zero (#283). Task management CLI: `lore tasks list` / `create` / `update` / `close` mirror the MCP `lore-task` surface, with idempotent `(subject, entity, project-set)` reuse on `create` short-circuiting to `Reused existing task: ...` and `--json` on every subcommand (#523). BREAKING vault schema: run `lore migrate` after upgrade — the migration adds the five scope/lifetime columns to Memories and Facts; pre-existing rows pass through with all columns null and are treated as broadcast-scoped persistent rows by the retrieval filter, preserving legacy recall byte-for-byte; on unmigrated vaults `probeScopeColumnsPresent` runs once at services init via a `dataSources.retrieve` fan-out and disables scope filtering with a one-line stderr warning until migration runs (#283). Plus: hook spawns under `ntn-auth-json` auth no longer forward `NOTION_API_TOKEN` / `LORE_NOTION_TOKEN` to the background child — child re-reads `~/.config/notion/auth.json` directly so the token never crosses the fork boundary; workspace and base-URL selectors still forward so multi-workspace ntn setups land on the same workspace (#475); `lore-memory action='update'` runs a symmetric auto-mentions diff — `createWithDedup` fires on `current − previous` entities, `services.facts.invalidate` fires on `previous − current` (Object-only check, `predicates: ["mentions"]` filter, soft-delete via `Valid Until = today` matching the explicit `lore-fact action='invalidate'` posture); footer distinguishes `Auto-mentions: N new` / `N stale invalidated` / `N new, M stale invalidated` and partial-failure ratios render independently per half; `LORE_DISABLE_AUTO_MENTIONS=1` disables both halves (#491); `lore-memory action='expand'` accepts undashed 32-char hex page ids alongside dashed UUIDs via shared `notionPageIdSchema` with the 1–20 cap and lowercase canonicalization (#526); `LORE_DEBUG=1` stderr lines route through `redactDebugMessage` / `redactDebugError` so `users.me` failures and `lore mine` lock errors don't leak SDK request detail or page-id-shaped substrings, length-bounded with `…(truncated)` marker (#488); wake-up `MemoryService.touchOnRead` and `FactService.touchOnRead` mirror the post-write `lastReferencedAt` and `confidenceScore` onto the caller's in-memory reference so a `loadWakeUpData` cache hit within the 30s TTL no longer re-fires `pages.update` per Active row per cache hit against Notion's per-token rate limit (#495); `lore install` always prints a `Notion environment:` line on the auth-resolved branch driven by `ResolvedAuth.baseUrl` (the runtime value `createClient` consumes, not raw `.lore.yaml auth.baseUrl` — matching the security contract that canonical auth sources ignore repo config) with source-attribution annotations (`(from shell <VAR>)` / `(from shell NOTION_ENV=...)` / `(from ntn config.json)` / `(ntn default; no shell or ntn config.json override)` / `(default; no shell base-URL override)` / `(from .lore.yaml auth.baseUrl)` / `, non-canonical` suffix for URLs that don't map to a known env name), plus a new mismatch warning when `.lore.yaml auth.baseUrl` declares one deployment and canonical auth resolved another — the silent footgun where pinning `auth.baseUrl: <dev URL>` plus an `ntn login` without `NOTION_ENV=dev` quietly routes every call to prod (#529). Agent-observable CLI/MCP output changes; four version literals move together. |
| `0.13.1` | 2026-05-07 — Stop-hook autosave prompt and `lore-task` MCP tool description gate `lore-task action='create'` to **tangential or out-of-scope** work — open loops the session noticed but did not pick up (side-effect discoveries, deferred follow-ups, blocked work). The session's primary objective is explicitly excluded from task filing; an unfinished primary objective is the next session's natural starting point, not a Lore task. Two surfaces moved together: `buildExtractionFilter` item 5 + the per-tool `lore-task` bullet in `buildToolGuidance` (`src/hooks/prompts.ts`), and a new `CRITICAL SCOPE RULE` block above the action bullets in the foreground `lore-task` tool description (`src/mcp/tools/tasks.ts`), parallel to the existing `CRITICAL CLOSURE RULE` and pinned positionally by a mirrored test. No schema or dispatch-surface change; agent-observable prompt + tool description change. Four version literals move together (#550). |

## Server Startup

`server.ts` runs as a standalone process (the `dist/mcp.js` entry point):

1. Creates an `McpServer` instance with `tools` and `resources` capabilities.
2. Calls `initServices()` to load config, connect to Notion, and resolve context.
3. Registers all tool groups.
4. Connects to a `StdioServerTransport`.

If `initServices()` fails (no config, bad token, etc.), interactive MCP hosts
still get a stdio server with diagnostic stubs for all seven `lore-*`
dispatchers. Any action or arguments return the initialization error and
recovery steps, so agents that reflexively call `wake-up`, `digest`, `save`, or
another dispatcher still see actionable setup guidance instead of a schema or
method-not-found error. Non-init failures such as tool registration or
transport connection errors remain fatal.

Hook-spawned background agents set `LORE_BACKGROUND_AGENT=true`; MCP children in
that environment fail fast on init errors rather than staying alive as a
diagnostic server, so the hook lock/liveness path can recover on the next Stop.
They also set `LORE_AUTOSAVE=false` to prevent recursive autosaves, but that
public autosave opt-out is not the diagnostic-mode bypass.

### ntn-issued tokens may expire mid-session

The MCP server is long-running — assistants connect to it and stay
connected across many tool dispatches. If an ntn-issued token
expires mid-session, the next Notion call returns 401. The shared
Notion client wrapper re-runs `resolveAuth` for initial
`ntn-auth-json` sessions, rebuilds the SDK client when `auth.json`
now carries different auth inputs, and retries the failed request once.
Static token sources (`NOTION_API_TOKEN`, `LORE_NOTION_TOKEN`, and
`auth.token`) do not install this refresh hook, and an unchanged or
still-rejected ntn token surfaces the original tool-call error so
the operator can run `lore auth --login` and reconnect if needed.
