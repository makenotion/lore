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

Build output has five entry points:

| Entry           | Source                 | Output                     |
| --------------- | ---------------------- | -------------------------- |
| `index`         | `src/index.ts`         | `dist/index.js`            |
| `mcp`           | `src/mcp/server.ts`    | `dist/mcp.js`              |
| `cli`           | `src/cli/index.ts`     | `dist/cli.js` with shebang |
| `hooks/helpers` | `src/hooks/helpers.ts` | `dist/hooks/helpers.js`    |
| `hooks/prompts` | `src/hooks/prompts.ts` | `dist/hooks/prompts.js`    |

## Data Model

A Vault is a Notion page containing five core child databases:

```text
Projects -> Topics -> Memories -> Entities -> Facts
```

The Entities database is required. Code paths reading entity ids from facts
must still handle mid-migration rows: relation-populated rows and empty
unbackfilled rows that need the SubjectKey substring fallback.

## Commands

| Command                | What it does            |
| ---------------------- | ----------------------- |
| `npm run build`        | tsup build              |
| `npm run typecheck`    | `tsc --noEmit`          |
| `npm run lint`         | `eslint src/`           |
| `npm run format`       | `prettier --write src/` |
| `npm run format:check` | `prettier --check src/` |
| `npm run test`         | `vitest run`            |
| `npm run test:watch`   | `vitest` watch mode     |
| `npm run dev`          | `tsup --watch`          |

## Notion SDK v5

This project uses `@notionhq/client` v5.x. Do not use v4 patterns. See
[`docs/notion-sdk-v5.md`](notion-sdk-v5.md) for the canonical request shapes
and migration differences.

## Configuration

- Config lives in `.lore.yaml` with upward directory search from cwd.
- `.lore.yaml` is local-only — keep it out of version control. Copy
  `.lore.example.yaml` to `.lore.yaml` per clone, and distribute shared team
  values (`vault.pageId`, `auth.workspaceId`) via onboarding docs rather than
  by committing config. The current policy also applies to credential-free
  shared vault config and supersedes older changelog guidance that allowed
  intentional committed config. Never put `auth.token`, personal scratch vault
  page IDs, or maintainer-specific values in the file.
- Notion page IDs are locators, not bearer credentials. Keeping them out of
  git is still the right default so external clones don't auto-target an
  unrelated vault. Accidental maintainer-local page IDs that land in history
  need owner review for page replacement or history rewrite.
- Token resolution is handled by `resolveAuth` in `src/config.ts`; see
  [`docs/authentication.md`](authentication.md).
- Config is validated with Zod at load time, including refusal of
  bearer-shaped `auth.token` values in `.lore.yaml`.
- `profile` is optional in `.lore.yaml`; omission resolves in memory to the
  runtime default selector from `profiles/default/profile.yaml`. New
  `lore init` configs write that selector explicitly. See
  [`profiles.md`](profiles.md).
- `configRoot`, the directory containing `.lore.yaml`, is the base for relative
  project paths.
- `upstreamVaults` and `promotionTargets` describe optional multi-vault
  topology. They are explicit, bounded status/read orchestration inputs; normal
  memory/fact/decision/task writes still target only `vault.pageId`. See
  [`topology.md`](topology.md) for the `lore status` topology section, every
  health state the surface emits, and the recovery workflow for each;
  [`topology-inheritance.md`](topology-inheritance.md) for read-upstream
  wake-up behavior; and [`topology-promotion.md`](topology-promotion.md) for
  promotion targets.
- Runtime feature flags resolve once in `src/feature-flags.ts` from
  `.lore.yaml` `features:` plus backward-compatible env vars. The feature
  taxonomy is: duplicate/advisory gates (`nearDuplicateProbe`,
  `autosaveLearningDedup`, `taskReuse`, `taskCrossref`), write/read behavior
  gates (`autoMentions`, `learningExtraction`, fact `confidenceFactor`,
  `forceSemanticSearch`), and the `runTool` family (`enabled`, `blockEdit`,
  `filterSql`, `search`, `aggregate`, `batchCreates`). Env rollback switches
  such as `LORE_DISABLE_AUTO_MENTIONS=1` and `LORE_USE_RUNTOOL=0` still win
  over config values.

## Code Patterns

- Core services use constructor injection: `new Service(client, databaseId)`.
- `initServices()` in `services.ts` is the single initialization path for MCP,
  CLI, and hooks.
- Property extraction uses typed helpers from `notion/extractors.ts`; do not
  inline extraction logic.
- Property building uses helpers from `notion/schema.ts`, such as
  `buildMemoryProps()`.
- Complex filters should be cast to `QueryDataSourceParameters["filter"]`.
- Project-capable data migrations resolve `--project` once in the CLI
  dispatcher, pass the resolved project ID down to core helpers, and use
  `projectOrUnscopedFilter(projectId)` for Notion queries. Unknown project
  names must never fall back to vault-wide scans; require
  `--allow-unscoped` for intentional vault-wide migration work.
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

### ABOUTME Comments

`ABOUTME` comments are optional file-level owner notes for high-churn files
where the right edit location or responsibility boundary is not obvious from
imports and names alone.

- Add them only when they reduce lookup friction for a future contributor.
- Place them at the top of the file, after any shebang or license block and
  before imports or executable code.
- Use one or two short lines beginning `ABOUTME:`. The first line names the
  file's current responsibility; the optional second line names common edit
  triggers.
- Keep them current-state only: no temporal phrasing, issue references,
  reviewer references, phase names, or history.
- Do not use them for broad subsystem routing or cross-file invariants. Routing
  belongs in AGENTS files; cross-file contracts belong in focused docs or
  subsystem guides.

## Testing

- Run `npm run typecheck` before committing.
- Write or update tests for behavior changes when a relevant test suite exists.
- Follow the test framework and patterns already used in the project. This repo
  uses Vitest.

## Continuous Integration

CI is fork-safe: every step in `.github/workflows/ci.yml` runs without a
Notion token, without live vault access, and without internal-only fixtures.
That envelope is contractual — see [`docs/ci.md`](./ci.md) for the per-step
contract, the rules for adding new steps, and the local self-test recipe to
verify fork-safety before opening a PR that touches CI.

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

- Put knowledge in the right file: MCP-specific guidance in
  `src/mcp/AGENTS.md`, durable Notion SDK shape guidance in
  [`docs/notion-sdk-v5.md`](notion-sdk-v5.md), Notion rate-limit internals and
  call-site checklists in [`docs/notion-rate-limit.md`](notion-rate-limit.md),
  short Notion-layer routing and local invariants in `src/notion/AGENTS.md`,
  and cross-cutting guidance in root `AGENTS.md` or this docs tree.
- Make small factual corrections directly.
- Propose structural rule changes to the human lead first.
- Never remove or weaken existing rules without approval.
- Every change should leave the document shorter, more useful, or both.

## Troubleshooting

| Symptom                                    | Cause                                         | Fix                                                                                                  |
| ------------------------------------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `dataSources is undefined`                 | Using v4 SDK patterns                         | Use the data-source query shape in [`docs/notion-sdk-v5.md`](notion-sdk-v5.md)                       |
| `pages.retrieveMarkdown is not a function` | Notion SDK before v5                          | Ensure `@notionhq/client` is `^5.1.0`                                                                |
| `initial_data_source` type error           | Missing cast or wrong create shape            | Use `createDbArgs()` and the database-create shape in [`docs/notion-sdk-v5.md`](notion-sdk-v5.md)    |
| Import without `.js` extension             | ESM requires explicit extensions              | Add `.js` to relative imports                                                                        |
| `No .lore.yaml found`                      | Config search failed                          | Ensure `.lore.yaml` exists in cwd or an ancestor                                                     |
| `filter` type errors in queries            | Complex filter needs cast                     | Cast as described in [`docs/notion-sdk-v5.md`](notion-sdk-v5.md)                                     |
| `Vault already initialized`                | Running `lore init` twice                     | Use `lore status` to verify, or `VaultManager.load()`                                                |
| Codex does not load Lore tools             | Project not trusted or hooks feature disabled | Trust the project and ensure `.codex/config.toml` sets `features.hooks = true`                       |
| `No Notion auth configured`                | Every auth source returned empty              | Run `lore auth --login` or set `NOTION_API_TOKEN`; see [`docs/authentication.md`](authentication.md) |
