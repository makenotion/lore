# Agent Reference

> Read this file first, then read the guide for the area you are working in.
> When a subsystem guide conflicts with this file, the subsystem guide wins for
> that subsystem.

## Subsystem Guides

| Area             | Guide                                          | Scope                                                                  |
| ---------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| MCP server       | [`src/mcp/AGENTS.md`](src/mcp/AGENTS.md)       | Tool registration, error handling, server startup                      |
| Domain services  | [`src/core/AGENTS.md`](src/core/AGENTS.md)     | Service pattern, context resolution, fact invalidation                 |
| Notion SDK layer | [`src/notion/AGENTS.md`](src/notion/AGENTS.md) | Client, schema, extractors, vault setup, SDK v5 specifics              |
| CLI              | [`src/cli/AGENTS.md`](src/cli/AGENTS.md)       | Commander patterns, command reference, output formatting               |
| Hook runner      | [`src/hooks/AGENTS.md`](src/hooks/AGENTS.md)   | Stop autosave, auto-digest, background spawn, lockfiles                |
| Auth layer       | [`src/auth/AGENTS.md`](src/auth/AGENTS.md)     | ntn / PAT auth, `auth.json` contract, vault preflight, token classification |

## Detailed Guides

| Guide | Use it for |
| ----- | ---------- |
| [`docs/development.md`](docs/development.md) | Architecture, commands, conventions, stability rules, troubleshooting |
| [`docs/authentication.md`](docs/authentication.md) | Auth priority chain, ntn behavior, rate limits, auth troubleshooting |
| [`docs/memory-workflows.md`](docs/memory-workflows.md) | Lore memory/fact/decision/task workflow, confidence, topic keys, digest |
| [`docs/conflict-detection.md`](docs/conflict-detection.md) | `lore conflicts scan` workflow and compare-verdict contract |
| [`docs/topology.md`](docs/topology.md) | `lore status` topology section, health states, recovery workflow |
| [`docs/hooks.md`](docs/hooks.md) | Installed hook behavior and auth forwarding |
| [`docs/team-rollout.md`](docs/team-rollout.md) | Operator-facing ntn-first rollout runbook |
| [`docs/ci.md`](docs/ci.md) | Per-step CI contract: token/network/fixture needs and fork-safety rules |
| [`docs/cli.md`](docs/cli.md), [`docs/mcp-tools.md`](docs/mcp-tools.md) | CLI and MCP user-facing reference |

## Repo At A Glance

Lore is a Notion-backed memory system. It stores knowledge as Notion pages in
five core databases: Projects, Topics, Memories, Entities, and Facts.

The same domain services power three interfaces:

```text
.lore.yaml -> config.ts -> services.ts
                              |
                 +------------+------------+
                 |            |            |
            mcp/server.ts  cli/index.ts  hooks/helpers.ts
```

Creation order matters because relations form foreign keys:

```text
Projects -> Topics -> Memories -> Entities -> Facts
```

Facts can still be mid-migration at the row level: code that reads entity ids
from facts must handle both rows with populated entity relations and rows that
need the SubjectKey substring fallback.

## Quick Commands

| Command              | What it does                     |
| -------------------- | -------------------------------- |
| `npm run build`      | tsup build                       |
| `npm run typecheck`  | `tsc --noEmit`                   |
| `npm run lint`       | `eslint src/`                    |
| `npm run test`       | `vitest run`                     |
| `npm run test:watch` | `vitest` watch mode              |
| `npm run dev`        | `tsup --watch`                   |

## Non-Negotiables

Rule #1: If you need an exception to any rule here, stop and get explicit
permission from the human lead first.

- Do not bump version numbers. Never edit the `version` field in
  `package.json`, `package-lock.json`, or any release manifest unless the
  human lead has explicitly asked for a version bump in this turn. Releases
  are cut deliberately; an unrequested bump in an unrelated PR can ship a
  release, break stacked-branch rebases, or desync `package-lock.json`.
- Do not remove existing MCP tools. Deprecate first, remove in a future major.
- Do not rename database properties. Property names are baked into schema,
  extractors, and services.
- Keep the five-database core schema stable. Adding properties is fine;
  removing or renaming them is breaking.
- Do not change `initServices()` without updating MCP, CLI, and hooks.
- Respect the import boundary: CLI and hooks import from `services.ts`, not
  from `mcp/server.ts`.
- This repo is ESM-only. Internal relative imports include `.js`; no
  CommonJS.
- Use Notion SDK v5 patterns: `client.dataSources.query`,
  `pages.retrieveMarkdown`, `pages.updateMarkdown`, and
  `databases.create({ initial_data_source: ... })`.
- Run `npm run typecheck` before committing. Add or update tests when behavior
  changes and a relevant test suite exists.

## Operating Contract

- Be honest, push back, and call out bad ideas.
- Discuss architectural decisions before implementation. Routine fixes do not
  need discussion.
- Ask for clarification when a risky assumption cannot be resolved from local
  context.
- Make the smallest reasonable change that solves the problem.
- Do not rewrite implementations without explicit permission.
- Fix broken things immediately; do not paper over symptoms.
- Names describe what code does, not implementation history or mechanism.
- Comments explain what or why, never obvious how.
- Update the right AGENTS/doc file when you discover a missing convention,
  workflow, or gotcha. Structural rule changes need human lead approval.

## Lore Usage

Use Lore for cross-session knowledge when the tools are available:

- At session start, load context with `lore-context action='wake-up'`.
- Capture architectural choices with `lore-decision action='create'`.
- Save non-obvious discoveries with `lore-memory action='save'`.
- Save durable relationships with `lore-fact action='create'`; it requires a
  supporting memory via `sourceMemoryId` or same-process `agent`+`session`
  auto-link provenance.
- Track follow-up work with `lore-task action='create'` and close tasks as soon
  as they are done or cancelled.
- When memories are in tension, use `lore-memory action='compare'` with the
  verdict vocabulary in [`docs/memory-workflows.md`](docs/memory-workflows.md).
- Do not add visible "Key Learnings" boilerplate to user responses; learning
  extraction happens out of band through hooks.

## Authentication

Two operator personas, two recommended paths:

- **Internal Notion engineers** run `lore install --ntn`. `--ntn`
  auto-installs `ntn` (if missing), runs `ntn login` with
  `NOTION_KEYRING=0` forced in the spawn, and Lore reads the resulting
  bearer token from `~/.config/notion/auth.json`. Compose with `--dev`
  (`lore install --ntn --dev`) to forward `NOTION_ENV=dev` for
  dev-environment vaults.
- **External operators** create a Personal Access Token at
  <https://www.notion.so/developers/tokens> and paste it into
  `NOTION_API_TOKEN`, then run `lore install` (no flags). **Do not use
  integration tokens from `notion.so/profile/integrations`** — those
  carry `secret_…` shapes and are integration-level rate-limited, which
  re-collapses Lore into one shared bucket across the team. PATs are
  per-user. The PAT prefix is `ntn_` on prod and `development_ntn_` on
  the dev environment (use `lore install --dev` for the latter).

The four-source priority chain (highest first) backs both personas:

1. `NOTION_API_TOKEN` — PATs land here (and internal engineers may also
   set this explicitly).
2. `ntn`-resolved token from `~/.config/notion/auth.json`.
3. `LORE_NOTION_TOKEN` (soft-deprecated; hard-removal targeted for 0.14.0).
4. `auth.token` in `.lore.yaml` (soft-deprecated; same removal target).

`.lore.yaml` is local-only — keep it out of version control. Copy
`.lore.example.yaml` to `.lore.yaml` per clone, and distribute shared team
values (`vault.pageId`, `auth.workspaceId`) through onboarding docs rather
than by committing config. The Lore repo gitignores `.lore.yaml` and its
pre-commit guard (`tools/check-lore-config.mjs`) rejects any staged content.
Lore also warns whenever `auth.token` is present in `.lore.yaml`, even if a
higher-priority auth source wins, and rejects bearer-shaped values at config
load time.

Notion page IDs are access locators, not bearer secrets. Keeping them out of
git is still the right default so external clones don't auto-target an
unrelated vault. Accidental maintainer-local or personal scratch page IDs that
land in history need explicit owner review.

Both `ntn`-issued tokens and PATs inherit the operator's personal Notion
permissions and carry per-user rate limits. Lore-managed `ntn` spawns force
`NOTION_KEYRING=0`; direct `ntn login` outside Lore may need the recovery
path in [`docs/authentication.md`](docs/authentication.md).

See [`docs/authentication.md`](docs/authentication.md) and
[`src/auth/AGENTS.md`](src/auth/AGENTS.md) for the full auth contract.
