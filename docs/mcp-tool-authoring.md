# MCP Tool Authoring

This guide holds the detailed MCP implementation patterns that are too large
for the subsystem routing guide. Read [src/mcp/AGENTS.md](../src/mcp/AGENTS.md)
first; it remains the precedence-bearing guide for MCP work.

The current MCP surface is intentionally polymorphic: `lore-context`,
`lore-memory`, `lore-pinned`, `lore-query`, `lore-fact`,
`lore-decision`, `lore-project`, `lore-task`, and
`lore-procedure`. User-facing behavior belongs in
[docs/mcp-tools.md](mcp-tools.md), not in this authoring guide.

## Polymorphic Dispatch Pattern

The polymorphic `lore-*` tools above multiplex multiple actions behind one
MCP registration to keep per-session prompt overhead low. Each tool follows
the same shape:

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
introduced when the surface really is one action. If a behavior can reasonably
grow another action, start with a polymorphic family.

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

8. **Tags are a profile-owned closed vocabulary.** Any tool that writes
   `tags` must build its schema from `createTagsSchema(services.profile...)`
   in `tools/tag-schema.ts`. Pair it with `keywordsSchema` so callers have a
   home for free-form tokens (PR numbers, ticket IDs, file paths, class
   names). Out-of-vocab tags must fail validation. Read filters remain
   permissive so legacy or out-of-profile rows can still be found.

9. **Interactive init failures stay MCP-visible.** If `initServices()` fails
   during normal MCP startup, register diagnostic stubs for every `lore-*`
   dispatcher and connect stdio so the client gets recovery text. Do not
   call `process.exit(1)` for interactive init failures unless the diagnostic
   startup path is replaced by another MCP-visible recovery surface.

## Adding A New Tool

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
4. Document current behavior in `docs/mcp-tools.md`, add help recipes in
   `src/mcp/help.ts` when users need examples, and update the root
   `README.md` only when its public surface summary needs the new tool.
5. Add tests to `polymorphic.test.ts` exercising at least: registration,
   each action's dispatch, an unknown-action error, and a per-action
   missing-required-field error.
