# AGENTS.md -- Lore

Lore is a Notion-backed memory system. It stores knowledge as Notion pages
organized across four databases and exposes three interfaces: an MCP server,
a CLI, and shell hooks.

## Architecture

```
.lore.yaml  -->  config.ts  -->  services.ts (shared init)
                                    |
                    +---------------+---------------+
                    |               |               |
                 mcp/server.ts   cli/index.ts   hooks/helpers.ts
                    |               |               |
                 15 tools      5 commands      autosave / wakeup
                    |               |               |
                    +-------+-------+-------+-------+
                            |               |
                         core/*          notion/*
                 (domain services)   (SDK + extractors)
```

**Data model**: A Vault is a Notion page containing four child databases linked by
relations. Creation order matters because of foreign keys:
Projects --> Topics --> Memories --> Facts.

## Directory Map

| Path | Purpose |
|------|---------|
| `src/types.ts` | Core domain types (Vault, Project, Topic, Memory, Fact) |
| `src/config.ts` | `.lore.yaml` loading with upward directory search, Zod validation |
| `src/services.ts` | `LoreServices` interface + `initServices()` shared by MCP and CLI |
| `src/notion/client.ts` | Configured `@notionhq/client` wrapper |
| `src/notion/schema.ts` | Database property schemas + page property builders |
| `src/notion/extractors.ts` | Type-safe property extractors for `PageObjectResponse` |
| `src/notion/setup.ts` | Create/verify vault database structure |
| `src/core/vault.ts` | `VaultManager` -- init, load, stats |
| `src/core/project.ts` | `ProjectService` -- CRUD, findByPath, findByName |
| `src/core/topic.ts` | `TopicService` -- CRUD, getOrCreate |
| `src/core/memory.ts` | `MemoryService` -- CRUD, list, search (semantic via Notion) |
| `src/core/fact.ts` | `FactService` -- knowledge graph triples with temporal validity |
| `src/core/context.ts` | `resolveProject()` -- match cwd to project via longest prefix |
| `src/mcp/server.ts` | MCP stdio server entry point |
| `src/mcp/helpers.ts` | `toolError()` helper for MCP error responses |
| `src/mcp/tools/*.ts` | Tool registration files (context, memory, project, knowledge, journal) |
| `src/cli/index.ts` | CLI entry point (commander) |
| `src/cli/commands/*.ts` | Command files (init, auth, search, mine, status) |
| `src/hooks/helpers.ts` | Hook helper entry point (autosave, wakeup actions) |
| `hooks/*.sh` | Shell hook scripts for Claude Code integration |

## Build & Test

```bash
npm run build         # tsup build (ESM, 4 entry points)
npm run typecheck     # tsc --noEmit
npm run lint          # eslint src/
npm run test          # vitest run
npm run test:watch    # vitest (watch mode)
npm run dev           # tsup --watch
```

Build produces four entry points via tsup:

| Entry | Source | Output |
|-------|--------|--------|
| `index` | `src/index.ts` | `dist/index.js` (library exports) |
| `mcp` | `src/mcp/server.ts` | `dist/mcp.js` (MCP stdio server) |
| `cli` | `src/cli/index.ts` | `dist/cli.js` (CLI binary, has shebang) |
| `hooks/helpers` | `src/hooks/helpers.ts` | `dist/hooks/helpers.js` |

## Key Conventions

### Notion SDK v5.x

This project uses `@notionhq/client` v5.x which has significant API differences
from v4 and earlier. Do not use v4 patterns.

| Operation | Correct (v5) | Wrong (v4) |
|-----------|-------------|------------|
| Query a database | `client.dataSources.query({ data_source_id })` | `client.databases.query({ database_id })` |
| Create a database | `databases.create({ initial_data_source: { properties } })` | `databases.create({ properties })` |
| Read page content | `client.pages.retrieveMarkdown({ page_id })` | block children iteration |
| Write page content | `client.pages.updateMarkdown({ page_id, ... })` | append block children |
| Parent discriminant | `{ type: "page_id", page_id }` | `{ page_id }` |

### ESM-Only

- `package.json` has `"type": "module"`
- All internal imports use `.js` extensions (e.g., `import { Foo } from "./types.js"`)
- tsconfig uses `"module": "ES2022"` with `"moduleResolution": "bundler"`
- Do not use `require()` or CommonJS patterns anywhere

### Configuration

- Config lives in `.lore.yaml` with upward directory search from cwd
- Token resolution chain: `config.auth.token` --> `LORE_NOTION_TOKEN` env var
- Config is validated with Zod at load time
- The `configRoot` (directory containing `.lore.yaml`) is the base for relative project paths

### Code Patterns

- Core services use constructor injection: `new Service(client, databaseId)`
- `initServices()` in `services.ts` is the single initialization path for all interfaces
- Property extraction uses typed helpers from `notion/extractors.ts` -- do not inline extraction logic
- Property building uses helpers from `notion/schema.ts` (e.g., `buildMemoryProps()`)
- Filter types require explicit casts: `as QueryDataSourceParameters["filter"]`

### Input Validation

- MCP tool inputs are validated with Zod schemas via `inputSchema` in `registerTool()`
- CLI inputs are validated by commander's argument/option parsing
- Config is validated with Zod in `config.ts`

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `dataSources is undefined` | Using v4 SDK patterns | Use `client.dataSources.query()` not `client.databases.query()` |
| `pages.retrieveMarkdown is not a function` | Notion SDK < 5.x | Ensure `@notionhq/client` is ^5.1.0 |
| `initial_data_source` type error | Missing cast or wrong shape | Use `createDbArgs()` from `setup.ts` as a reference |
| Import without `.js` extension | ESM requires explicit extensions | Add `.js` to all relative import paths |
| `No .lore.yaml found` | Config search failed | Ensure `.lore.yaml` exists in cwd or any parent directory |
| `filter` type errors in queries | Complex filter needs cast | Cast to `QueryDataSourceParameters["filter"]` |
| `Vault already initialized` | Running `lore init` twice | Use `lore status` to verify, or `VaultManager.load()` |

## Agent Rules

1. **Do not remove existing MCP tools.** Tools are part of the public contract with
   AI assistants. Deprecate by adding a deprecation notice to the description, then
   remove in a future major version.

2. **Do not rename database properties.** Property names (`Name`, `Title`, `Subject`,
   `Predicate`, `Object`, etc.) are baked into `schema.ts`, `extractors.ts`, and all
   core services. Renaming requires a migration.

3. **Do not change the `initServices()` signature** without updating all three
   consumers (MCP server, CLI, hooks).

4. **All new MCP tools must follow the existing pattern**: try/catch wrapping the
   callback body and returning `toolError()` on failure. See `src/mcp/AGENTS.md`.

5. **Keep the four-database schema stable.** Adding properties is fine. Removing or
   renaming properties is a breaking change.

6. **Respect the import boundary**: CLI and hooks import from `services.ts`, not
   directly from `mcp/server.ts` (except legacy imports that should be migrated).

7. **Test with `npm run typecheck` before committing.** The project uses strict
   TypeScript and the type system catches most SDK usage errors.

## Lore MCP Tools

When working in this project, you have access to `lore-*` MCP tools. Use them:

- **At session start**: call `lore-wake-up` to load recent project context
- **When making decisions**: call `lore-remember` to save architectural decisions, conventions, or bug context
- **When learning facts**: call `lore-learn` to record entity relationships (e.g., "MemoryService uses dataSources.query")
- **At session end**: call `lore-journal` to summarize what was accomplished
