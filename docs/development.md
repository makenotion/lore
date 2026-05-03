# Development Guide

This guide holds the repo-wide details that used to make the root `AGENTS.md`
hard to scan. Read the root first, then come here when you need implementation
or troubleshooting detail.

## Architecture

Lore stores knowledge in Notion and exposes it through the MCP server, CLI, and
assistant hooks. `services.ts` is the shared initialization path for all three.

```text
.lore.yaml -> config.ts -> services.ts
                              |
                 +------------+------------+
                 |            |            |
            mcp/server.ts  cli/index.ts  hooks/helpers.ts
                 |            |            |
              MCP tools   CLI commands   autosave / wakeup
                 |            |            |
                 +------------+------------+
                              |
                       core/* and notion/*
```

Build output has four entry points:

| Entry           | Source                 | Output                                  |
| --------------- | ---------------------- | --------------------------------------- |
| `index`         | `src/index.ts`         | `dist/index.js`                         |
| `mcp`           | `src/mcp/server.ts`    | `dist/mcp.js`                           |
| `cli`           | `src/cli/index.ts`     | `dist/cli.js` with shebang              |
| `hooks/helpers` | `src/hooks/helpers.ts` | `dist/hooks/helpers.js`                 |

## Data Model

A Vault is a Notion page containing five core child databases:

```text
Projects -> Topics -> Memories -> Entities -> Facts
```

The Entities database is required. Code paths reading entity ids from facts
must still handle mid-migration rows: relation-populated rows and empty
unbackfilled rows that need the SubjectKey substring fallback.

## Commands

| Command              | What it does                     |
| -------------------- | -------------------------------- |
| `npm run build`      | tsup build                       |
| `npm run typecheck`  | `tsc --noEmit`                   |
| `npm run lint`       | `eslint src/`                    |
| `npm run test`       | `vitest run`                     |
| `npm run test:watch` | `vitest` watch mode              |
| `npm run dev`        | `tsup --watch`                   |

## Notion SDK v5

This project uses `@notionhq/client` v5.x. Do not use v4 patterns.

| Operation           | Correct v5                                                 | Wrong v4                                  |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------- |
| Query a database    | `client.dataSources.query({ data_source_id })`             | `client.databases.query({ database_id })` |
| Create a database   | `databases.create({ initial_data_source: { properties } })`| `databases.create({ properties })`        |
| Read page content   | `client.pages.retrieveMarkdown({ page_id })`               | Block children iteration                  |
| Write page content  | `client.pages.updateMarkdown({ page_id, ... })`            | Append block children                     |
| Parent discriminant | `{ type: "page_id", page_id }`                             | `{ page_id }`                             |

## Configuration

- Config lives in `.lore.yaml` with upward directory search from cwd.
- `.lore.yaml` may be committed only with shared, non-secret values. Never
  commit `auth.token`, personal scratch vault page IDs, or maintainer-specific
  local values.
- Notion page IDs are locators, not bearer credentials. A deliberate team vault
  page ID in git history is not a token leak by itself; private or accidental
  maintainer-local page IDs still need owner review for page replacement or
  history rewrite.
- Token resolution is handled by `resolveAuth` in `src/config.ts`; see
  [`docs/authentication.md`](authentication.md).
- Config is validated with Zod at load time.
- `configRoot`, the directory containing `.lore.yaml`, is the base for relative
  project paths.

## Code Patterns

- Core services use constructor injection: `new Service(client, databaseId)`.
- `initServices()` in `services.ts` is the single initialization path for MCP,
  CLI, and hooks.
- Property extraction uses typed helpers from `notion/extractors.ts`; do not
  inline extraction logic.
- Property building uses helpers from `notion/schema.ts`, such as
  `buildMemoryProps()`.
- Complex filters should be cast to `QueryDataSourceParameters["filter"]`.
- MCP tool inputs are validated with Zod schemas via `inputSchema` in
  `registerTool()`.
- CLI inputs are validated through commander's argument and option parsing.

## Stability Rules

1. Do not remove existing MCP tools. Tools are public contracts with agents.
   Deprecate in the description first, then remove in a future major version.
2. Do not rename database properties. Property names such as `Name`, `Title`,
   `Subject`, `Predicate`, and `Object` are baked into schema, extractors, and
   services.
3. Do not change `initServices()` without updating all three consumers: MCP
   server, CLI, and hooks.
4. Keep the five-database schema stable. Adding properties is fine; removing or
   renaming properties is breaking.
5. Respect the import boundary: CLI and hooks import from `services.ts`, not
   directly from `mcp/server.ts`.

## Coding Rules

- YAGNI. The best code is no code.
- Make the smallest reasonable change that achieves the outcome.
- Never rewrite implementations without explicit permission.
- Match surrounding style and formatting.
- Fix broken things immediately.
- Do not abandon an approach because it is tedious; abandon it only when it is
  technically wrong.
- Names must describe what code does, not how it is implemented or when it was
  introduced.
- Comments explain what or why, never obvious how. Do not remove existing
  comments unless they are provably false.

## Testing

- Run `npm run typecheck` before committing.
- Write or update tests for behavior changes when a relevant test suite exists.
- Follow the test framework and patterns already used in the project. This repo
  uses Vitest.

## Debugging

Always find the root cause. Never fix symptoms or add workarounds.

- Read error messages carefully.
- Test one hypothesis at a time.
- Make the smallest possible change, verify it, then move on.
- Say "I don't understand" rather than guessing.

## AGENTS.md Maintenance

AGENTS files are living documents. Update them when you discover undocumented
conventions, missing workflows, gotchas that cost time, or outdated
instructions.

- Put knowledge in the right file: MCP-specific in `src/mcp/AGENTS.md`,
  Notion SDK details in `src/notion/AGENTS.md`, cross-cutting guidance in root
  `AGENTS.md` or this docs tree.
- Make small factual corrections directly.
- Propose structural rule changes to the human lead first.
- Never remove or weaken existing rules without approval.
- Every change should leave the document shorter, more useful, or both.

## Troubleshooting

| Symptom                                    | Cause                                             | Fix                                                                                                  |
| ------------------------------------------ | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `dataSources is undefined`                 | Using v4 SDK patterns                             | Use `client.dataSources.query()`                                                                     |
| `pages.retrieveMarkdown is not a function` | Notion SDK before v5                              | Ensure `@notionhq/client` is `^5.1.0`                                                                |
| `initial_data_source` type error           | Missing cast or wrong create shape                | Use `createDbArgs()` from `setup.ts` as a reference                                                  |
| Import without `.js` extension             | ESM requires explicit extensions                  | Add `.js` to relative imports                                                                        |
| `No .lore.yaml found`                      | Config search failed                              | Ensure `.lore.yaml` exists in cwd or an ancestor                                                     |
| `filter` type errors in queries            | Complex filter needs cast                         | Cast to `QueryDataSourceParameters["filter"]`                                                        |
| `Vault already initialized`                | Running `lore init` twice                         | Use `lore status` to verify, or `VaultManager.load()`                                                |
| Codex does not load Lore tools             | Project not trusted or hooks feature disabled     | Trust the project and ensure `.codex/config.toml` sets `features.codex_hooks = true`                 |
| `No Notion auth configured`                | Every auth source returned empty                  | Run `lore auth --login` or set `NOTION_API_TOKEN`; see [`docs/authentication.md`](authentication.md) |
