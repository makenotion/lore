# Contributing to Lore

Thanks for helping improve Lore. This project is a Notion-backed memory system
with a CLI, an MCP server, and assistant hook integrations. Start by reading
[`AGENTS.md`](AGENTS.md), then follow the subsystem guide for the area you are
changing.

## Development Setup

Lore requires Node.js 20 or newer.

```bash
npm install
npm run build
npm test
```

Useful commands:

| Command                | Purpose                             |
| ---------------------- | ----------------------------------- |
| `npm run build`        | Build the ESM entry points          |
| `npm run typecheck`    | Run TypeScript without emitting     |
| `npm run lint`         | Run ESLint over `src/`              |
| `npm test`             | Run the Vitest suite                |
| `npm run dev`          | Rebuild in watch mode               |

`.lore.yaml` is local-only — it's gitignored, the pre-commit hook
(`tools/check-lore-config.mjs --staged`) rejects any staged index entry,
and `src/config-guard.test.ts > repo invariants > does not track a
`.lore.yaml` at the repo root` pins the absence on every CI run. Copy
`.lore.example.yaml` to `.lore.yaml` per clone; don't commit it.

Do not bump package versions in contribution PRs unless a maintainer explicitly
asks for a release change.

## Repository Guides

Read the root [`AGENTS.md`](AGENTS.md) first. It links the subsystem guides
that carry the detailed rules for each area:

| Area             | Guide                                          |
| ---------------- | ---------------------------------------------- |
| MCP server       | [`src/mcp/AGENTS.md`](src/mcp/AGENTS.md)       |
| Domain services  | [`src/core/AGENTS.md`](src/core/AGENTS.md)     |
| Notion SDK layer | [`src/notion/AGENTS.md`](src/notion/AGENTS.md) |
| CLI              | [`src/cli/AGENTS.md`](src/cli/AGENTS.md)       |
| Hook runner      | [`src/hooks/AGENTS.md`](src/hooks/AGENTS.md)   |
| Auth layer       | [`src/auth/AGENTS.md`](src/auth/AGENTS.md)     |

For wider architecture and command reference, see
[`docs/development.md`](docs/development.md), [`docs/cli.md`](docs/cli.md),
and [`docs/mcp-tools.md`](docs/mcp-tools.md).

## Branches, Commits, and Pull Requests

- Work on a feature branch, not directly on `main`.
- Use a short, descriptive branch name. Maintainers often prefix branches with
  their GitHub handle; fork contributors may use any descriptive branch name.
- Prefer one focused commit per branch. Maintainers usually amend follow-up
  changes into the branch's existing commit.
- Use Conventional Commits for commit messages, for example
  `fix: handle missing project scope`.
- Keep PR titles human-readable and omit Conventional Commit prefixes.
- Open a draft PR while work is still in progress.
- Rebase on the latest `origin/main` before pushing or asking for review.
- Fill out the PR template, including the test plan and changelog decision.

## Testing Expectations

Run the narrowest useful checks while iterating, then run the relevant full
checks before review. At minimum, run `npm run typecheck` before committing.
For behavior changes, run `npm test` or the affected Vitest files. For public
CLI, MCP, or hook changes, include the command you used to validate the affected
workflow in the PR test plan.

Docs-only changes do not need new tests, but they should still be checked for
broken links, stale commands, and misleading setup instructions.

## Adding or Changing MCP Tools

Lore exposes a small set of polymorphic MCP tools. See
[`docs/mcp-tools.md`](docs/mcp-tools.md) for the current list. Do not add
single-purpose aliases for actions that belong under an existing family.

To add an action to an existing polymorphic tool:

1. Read [`src/mcp/AGENTS.md`](src/mcp/AGENTS.md).
2. Add a `handle<Action>` function in the relevant `src/mcp/tools/*.ts` file.
3. Add the action branch to that file's discriminated union.
4. Add the action to the flat `inputSchema`, with `.describe()` text for every
   new field.
5. Add the dispatch `switch` case.
6. Update the tool description and [`docs/mcp-tools.md`](docs/mcp-tools.md).
7. Add tests for the new dispatch path, usually in
   `src/mcp/tools/polymorphic.test.ts` plus behavior-specific tests near the
   changed tool.

To add a brand-new MCP tool family, discuss the shape with maintainers first.
New MCP surfaces are public agent contracts and should use the polymorphic
pattern from day one.

## Running Evals

The default eval suite is fixture-backed and does not read or write a live
Notion vault:

```bash
npm run build
node dist/cli.js eval run evals/suites/lore-core.yaml
```

Use the Notion-backed runner only against an operator-maintained sandbox
project:

```bash
node dist/cli.js eval run evals/suites/lore-core.yaml \
  --runner notion \
  --project <SandboxProject>
```

Task evals run a real headless agent and are intentionally opt-in:

```bash
LORE_EVAL_TASK_REAL=1 node dist/cli.js eval run \
  --runner task \
  evals/task-suites/starter.yaml
```

See [`docs/evals.md`](docs/evals.md) for runner modes, safety gates, baselines,
and artifact output.

## Maintainer Assistant Config Workflow

This section is for Notion maintainers and internal contributors who use this
repo as the source of their installed `lore` binary. Outside contributors do
not need a stable `~/.lore` clone to make normal code, docs, fixture, or test
changes.

Lore's source repo is its own consumer, and Lore cannot bin-dispatch through
itself: there is no `node_modules/.bin/lore` in the repo that is publishing
`lore`. The committed `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`,
and `.codex/hooks.json` therefore use the legacy `${HOME}/.lore/...`
absolute-path shape deliberately.

Maintainers using the committed assistant configs should keep a stable
`~/.lore` clone for editor and agent integration:

```bash
cd ~/.lore
npm install
npm run build
```

Then hack on Lore from any worktree you like. A worktree under
`~/Developer/...` or anywhere else is independent and does not affect the
committed assistant config.

If you re-run `lore install` from a different Lore checkout, it will rewrite the
committed assistant config files to point at that checkout. Do not commit that
diff. The expected workflow is:

1. Maintain a stable `~/.lore` clone for editor and agent integration.
2. Hack on Lore from any worktree you like.
3. Keep the committed `${HOME}/.lore/...` paths stable for every contributor.

The committed env passthrough assumes the recommended ntn-source path. The
spawned MCP server reads `~/.config/notion/auth.json` directly, so the shared
`.mcp.json`, `.cursor/mcp.json`, and `.codex/config.toml` intentionally avoid
auth-token placeholders that produce `/doctor` warnings when an operator's
shell does not define them.

Legacy `LORE_NOTION_TOKEN` contributors can restore local token forwarding
without committing the diff by running:

```bash
cd ~/.lore
lore install --legacy-paths
```

Pass `--project <checkout>` from that clone when updating another local
worktree. The same local reinstall path applies to contributors who depend on
`NOTION_WORKSPACE_ID`, `NOTION_ENV`, `NOTION_BASE_URL`,
`NOTION_API_BASE_URL`, or `LORE_USER_NAME`: the generated env passthrough
reflects that operator's install-time shell and should remain a personal,
uncommitted diff.

## Sensitive Details

Do not include Notion API tokens, bearer tokens, private vault content, exploit
details, or other secrets in public issues, pull requests, comments, logs, or
screenshots.
