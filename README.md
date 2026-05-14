# Lore

AI memory backed by Notion.

Lore gives your AI assistants a persistent, shared memory: it stores
conversations, decisions, follow-up tasks, and durable relationships as Notion
pages that any teammate or agent session can read back. Anything you use with
the [Model Context Protocol](https://modelcontextprotocol.io) (Claude Code,
Codex, Cursor, and other MCP hosts) can recall, save, and reason over the same
vault, so context survives `/clear`, new branches, and handoffs between
people.

Under the hood, Lore organizes a vault into five core Notion databases:
Projects, Topics, Memories, Entities (canonical-handle resolution), and
Facts. The same domain services power three surfaces: an MCP server for
AI assistants, a CLI for humans, and hook commands that wire automatic
context loading and session saving into supported hosts.

## Quick Start

### 1. Install

> **Pending first public publish.** The npm publish workflow was
> retargeted to public `registry.npmjs.org` in
> [#561](https://github.com/makenotion/lore/pull/561), but the first
> release tag has not been cut yet —
> `npm view @makenotion/lore --registry=https://registry.npmjs.org/`
> currently returns `E404`. Until first publish lands (tracked in
> [#569](https://github.com/makenotion/lore/issues/569)), install from a
> local clone (option A below). The published-package commands in
> option B will work as-is once the publish succeeds.

#### Option A — local clone (works today, recommended while publish is pending)

```bash
git clone https://github.com/makenotion/lore.git
cd lore && npm install && npm run build && npm link
```

`npm link` makes `lore` available globally on your `PATH` from the clone.
Run `lore --version` to confirm, then continue with step 2 below.

#### Option B — published package (works once first publish lands)

When `@makenotion/lore` is on public npm, install with no `.npmrc` or
authentication setup:

```bash
npm install -g @makenotion/lore                       # global CLI
# or
npm install -D @makenotion/lore  # or  yarn add -D    # project-local
```

For project-local installs, run `npx lore <command>` from inside the
project or add a `lore` script to `package.json`. See
[`docs/dev-dependency-install.md`](docs/dev-dependency-install.md) for
the Yarn PnP wiring and path-portable setup teams use to share assistant
config across a repo.

### 2. Authenticate with Notion

Lore needs a Notion bearer token. Two supported sources:

- **`NOTION_API_TOKEN`** — external operators set this environment variable
  to a Notion Personal Access Token (PAT) from
  `notion.so/developers/tokens`. PATs inherit the operator's Notion
  permissions and keep rate limits per operator:

  ```bash
  export NOTION_API_TOKEN=ntn_...
  ```

  Do not use `secret_` integration tokens from
  `notion.so/profile/integrations` for team rollout; they share one bucket
  across every operator using the same integration.

- **`ntn` CLI** — the [`ntn` tool](https://github.com/makenotion/skills)
  issues per-user Notion tokens that inherit your own Notion permissions.
  This is the recommended path for teams: each engineer gets their own
  rate-limit bucket, no integration sharing is required, and access matches
  what each engineer can already see in Notion's UI.

  The simplest setup is to let Lore drive the internal flow — run
  `lore install --ntn` when configuring assistants, or
  `lore auth --login` for auth only. Both auto-install `ntn` if needed
  and run `ntn login` for you, forcing the file-mode storage that Lore
  reads.

  To run `ntn` yourself, set `NOTION_KEYRING=0` before logging in. `ntn`
  defaults to macOS Keychain storage, which Lore does not read; the env
  var forces file-mode storage at `~/.config/notion/auth.json`:

  ```bash
  NOTION_KEYRING=0 ntn login
  ```

  Lore reads the resulting `auth.json` automatically. See
  [`docs/team-rollout.md#known-gotcha-direct-ntn-login-outside-lore`](docs/team-rollout.md#known-gotcha-direct-ntn-login-outside-lore)
  for the persistent shell-rc setup if you use `ntn` for other tooling too.

Token resolution order is `NOTION_API_TOKEN` → ntn-resolved `auth.json`.
The first source available wins. See
[`docs/authentication.md`](docs/authentication.md) for the full priority chain,
multi-workspace selection, and troubleshooting.

### 3. Create a Vault

A Lore vault is a Notion page containing the five databases (Projects,
Topics, Memories, Entities, Facts).

**For a shared team vault** — the common case — create a page in Notion at
the location your team agrees on, make sure your auth source can access it,
and pass its id to `lore init`:

```bash
lore init <page-id>
```

This is the recommended path for shared use: the page lives at a
deliberate location (a team workspace, a project sub-page) with
deliberate sharing, and every engineer's local `.lore.yaml` points at the
same id.

`.lore.yaml` is local-only — keep it out of version control. Copy
`.lore.example.yaml` to `.lore.yaml` in each clone and paste the shared
`vault.pageId` from your team's onboarding docs (or let `lore init`
write the file for you). Distribute shared values via onboarding docs,
not by committing config.

Notion page IDs are access locators, not bearer credentials: knowing a page ID
does not grant access unless the caller's Notion token can already read that
page. Even so, keep `vault.pageId` out of version control so external clones of
a public repo don't auto-target a maintainer's vault. If a personal or
accidental page ID lands in git history, scrub the working tree and decide with
the page owner whether to replace the page or rewrite history.

**For personal vaults / fresh-onboarding scratch use**, the no-arg
flow creates a workspace-level page on your behalf using the active auth
source. If no auth resolves, it auto-installs ntn, runs `ntn login`, and then
writes `.lore.yaml`:

```bash
lore init                            # default title: "Lore Vault — <basename(cwd)>"
lore init --name "Lore Vault Widget" # explicit title
lore init --ntn-env dev              # bootstrap against the dev Notion environment
```

If your existing ntn auth points at a different environment than `--ntn-env`,
Lore exits 1 with recovery copy (typically
`ntn logout && NOTION_KEYRING=0 NOTION_ENV=<env> ntn login`) rather than
silently creating a vault in the wrong environment. Either init path creates the
five databases inside the page (Projects, Topics, Memories, Entities, Facts)
and writes a `.lore.yaml` config file.

For direct non-ntn setup, create a Notion Personal Access Token at
`notion.so/developers/tokens`, set the canonical Notion SDK env var, and
make sure the operator's Notion account can access the vault page before
`lore init <page-id>`.

```bash
export NOTION_API_TOKEN=ntn_...
```

See [`docs/team-rollout.md`](docs/team-rollout.md) for the per-engineer
onboarding flow and team-lead runbook.

### 3. Refresh Auth for an Existing Vault

Once your local `.lore.yaml` points at a configured vault, use the Lore auth
wrapper to refresh ntn auth and preflight access:

```bash
lore auth --login
```

Deprecated token fallbacks have been removed. `LORE_NOTION_TOKEN` is no
longer read, and any `auth.token` value in `.lore.yaml` is rejected at
config load time. Use `NOTION_API_TOKEN` for Personal Access Tokens or
`lore auth --login` for ntn auth.

Existing vaults from before PF3-01 need one bootstrap step before the
entity backfill: run `lore vault ensure-entities`, then run
`lore migrate --build-entities --yes` in a quiet window to canonicalize
the fact graph.

### 4. Configure Your AI Assistant

```bash
# Internal ntn path:
lore install --ntn

# External PAT path, after exporting NOTION_API_TOKEN:
lore install
```

Both install paths configure every supported assistant integration
(`--client all`) and fill in any missing side from an older install. Use
`--client` to install only one. Keep `--ntn` on client-scoped commands when
using the internal ntn path; omit it for the PAT path after exporting
`NOTION_API_TOKEN`:

```bash
lore install --ntn --client claude
lore install --ntn --client codex
lore install --ntn --client cursor
lore install --ntn --client cursor --cursor-global
```

- `claude`: writes Claude Code settings plus `.mcp.json`
- `codex`: writes `.codex/config.toml` plus `.codex/hooks.json`
- `cursor`: writes `<projectDir>/.cursor/mcp.json`
  (`--cursor-global` opts into `~/.cursor/mcp.json`)

Codex only loads project-scoped `.codex/*` files for trusted projects.

Cursor's MCP runtime doesn't currently support session-end / Stop hooks, so
the Cursor installer only writes the MCP entry; the Stop-triggered autosave
and the detached auto-digest spawn run only under Claude Code or Codex.
Recall / save / scan paths work identically across all three.

#### Other MCP Hosts

For agents not directly supported by `lore install --client`, run
`lore install --print-config json` or `lore install --print-config toml` and
paste the emitted MCP server snippet into the host's config file. See
[`docs/mcp-hosts.md`](docs/mcp-hosts.md) for host notes and hook limitations.

### 5. Refresh Auth On An Existing Vault

Once your local `.lore.yaml` points at a configured vault, refresh ntn auth
and preflight access with:

```bash
lore auth --login
```

Vaults created before the Entities database was introduced need one
bootstrap step before the entity backfill: run
`lore vault ensure-entities`, then run `lore migrate --build-entities --yes`
in a quiet window to canonicalize the fact graph.

### 6. Teach Your Agents to Use Lore

`lore install` wires the MCP server and hooks into the assistant host, but
agents still need repo-local instructions that tell them to prefer the shared
Lore vault for team knowledge. Add a "Memory and note-taking" section to the
root `AGENTS.md` and, when the repo uses Claude Code, mirror it in
`CLAUDE.md` or another host-specific instruction file.

A minimal starter:

```markdown
### Memory and note-taking

- Use Lore for cross-session and cross-team knowledge. Lore stores memories,
  facts, decisions, and tasks in the shared vault, so every team member and
  agent session benefits. Prefer Lore over file-based memory for anything the
  team should know.
- Use file-based memory only for personal preferences or local-only context
  that should not be shared.
- At session start, call `lore-context` with `action: "wake-up"` to load recent
  project context when the tool is available.
- In Codex, automatic wake-up ranks against the first prompt. After `/clear` or
  a major topic pivot, call `lore-context` again with `action: "wake-up"` and
  `userQuery` set to the new task prompt.
- Save non-obvious discoveries with `lore-memory` and `action: "save"`.
- Record architectural decisions with `lore-decision` and `action: "create"`.
- Record durable component relationships with `lore-fact` and
  `action: "create"` after saving a supporting memory; pass
  `sourceMemoryId`, or pass `agent` + `session` so Lore can auto-link the
  fact to the earlier memory in the same process.
- Track follow-up work with `lore-task` and `action: "create"`; close tasks
  with `action: "close"` as soon as the work is done or cancelled.
```

Adapt the snippet to the repo. For example, if Lore is installed as a Yarn PnP
devDependency, tell agents to run CLI commands as
`yarn run -T lore <subcommand>` while still calling MCP tools by their normal
`lore-*` names.

## Data Model

A vault is a Notion page containing five core databases:

| Database     | Title Property | Key Properties                                         | Relations                                             |
| ------------ | -------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| **Projects** | Name           | Type (project/person/agent), Path, Status, Description | --                                                    |
| **Topics**   | Name           | Description                                            | Project                                               |
| **Memories** | Title          | Source, Author, Agent, Tags, Session + page body       | Project, Topic                                        |
| **Entities** | Name           | Aliases, Kind, Description                             | Project, Source (Memory)                              |
| **Facts**    | Subject        | Predicate, Object, Valid From, Valid Until, Confidence | Project, Source (Memory), SubjectEntity, ObjectEntity |

`lore init` creates all five databases on a new vault. Vaults created
before the Entities database was introduced only have four (no Entities);
they need a one-time legacy migration via `lore vault ensure-entities` to
create the Entities database and add the `SubjectEntity` / `ObjectEntity`
relation columns to Facts, followed by `lore migrate --build-entities --yes`
to re-point historical rows. See
[`docs/team-rollout.md#entities-database-cutover`](docs/team-rollout.md#entities-database-cutover).

**Predicate values accepted by `lore-fact action='create'`**: `is_a`, `has_a`,
`uses`, `depends_on`, `related_to`, `created_by`, `owned_by`, `replaces`,
`extends`, `conflicts_with`. System-managed predicates are `decided_by`,
`supersedes_decision`, `informs` (`lore-decision action='create'` /
`supersede`) and `mentions` (`lore-memory action='save'`). Historical tracking
predicates (`needs_action`, `waiting_on`, `blocked_by`) are legacy row values
only; use `lore-task action='create'` for tracked work.

**Confidence (categorical)**: `certain`, `likely`, `speculative`. This is the
agent-writable categorical stance. The separate numeric `Confidence Score`
column is system-managed: read citations raise it, contradiction/supersession
signals lower it, and neglect decay reduces untouched memories over time. Do
not try to write the numeric score through MCP inputs; see
[`docs/memory-workflows.md`](docs/memory-workflows.md#confidence) for the full
contract.

**Memory sources**: `conversation`, `file`, `manual`, `agent_diary`, `digest`

**Memory kinds**: `note`, `decision`, `incident`, `runbook`, `postmortem`, `policy`, `task`

**Memory statuses**: `informational`, `proposed`, `accepted`, `superseded`, `deprecated`, `rejected`

### Topic keys

Recurring memory topics can pass `topicKey` to `lore-memory action='save'`.
Rows upsert by `(Topic Key + exact Project relation set)`: a matching row gets
a revision appended and its `Revision Count` incremented instead of creating a
new memory. Use stable prefixes matching recurring families:
`decision/`, `runbook/`, `incident/`, `postmortem/`, and `policy/`. Topic keys
apply to recurring categories; `note` and `task` kinds do not form revision
chains. Use
`lore-memory action='suggest-topic-key'` to derive a key, and see
[`docs/memory-workflows.md`](docs/memory-workflows.md#topic-keys) for
promotion and re-keying rules.

Save digests regularly (`lore-context action='digest'` → synthesize →
`lore-memory action='save'` with `source: "digest"`). When a digest from the
last 7 days exists, `lore-context action='wake-up'` surfaces it at the top and
trims the raw-memory list underneath — a denser, lower-token starting point
than a long stream of individual memories.

## MCP Tools

Lore exposes a small set of polymorphic tools, each multiplexing several
actions behind one MCP registration. The prior single-purpose tool names and
task aliases were removed in the 0.6.0 deprecation purge. See
[`docs/mcp-tools.md`](docs/mcp-tools.md) for the current tool list, action
reference, and task/fact migration notes.

## CLI Commands

Core commands:

- `lore init [page-id]` creates vault databases and writes `.lore.yaml`.
- `lore install` writes assistant MCP config and supported hooks; add `--ntn`
  to select the internal ntn bootstrap path.
- `lore auth --login` refreshes ntn auth and verifies vault access.
- `lore search <query>` searches memories.
- `lore status` reports vault health and active project resolution.
- `lore migrate` runs schema and one-shot data migrations.
- `lore entities merge --from <loser-id> --into <winner-id>` previews or applies
  duplicate Entity merges.
- `lore conflicts scan` surfaces read-only conflict candidates for agent
  judgment.

See [`docs/cli.md`](docs/cli.md) for a compact CLI command overview. See
[`docs/conflict-detection.md`](docs/conflict-detection.md) for conflict verdict
rules, scan caps, and the repeat-until-clean workflow.

## Hooks

Lore installs hook commands for supported AI coding assistants:

- **Auto-save** (`lore hooks autosave`) runs on assistant `Stop` and saves
  the session after enough user messages.
- **Wake-up** (`lore hooks wakeup`) loads the latest digest, recent memories,
  active facts, and task-matched context before the first response.

Claude Code and Codex installs wire hooks automatically using bin dispatch
(`lore hooks ...`, or `yarn run -T lore hooks ...` under Yarn PnP). The
`hooks/autosave.sh` and `hooks/wakeup.sh` scripts are compatibility
entrypoints for older absolute-path installs. Cursor and `--print-config`
hosts only get the MCP tool surface.
See [`docs/hooks.md`](docs/hooks.md) for host timing, auth forwarding, auto-digest
behavior, and compatibility notes.

## Configuration

Lore is configured via `.lore.yaml`. The file is located by searching upward
from the current working directory.

`.lore.yaml` is local-only — keep it out of version control. Copy
`.lore.example.yaml` to `.lore.yaml` and fill in your values, or run
`lore init` to generate one. Distribute shared team values (`vault.pageId`,
`auth.workspaceId`) through your onboarding docs rather than committing config;
never put `auth.token`, personal scratch vault page IDs, or personally
identifying values in the file.

Threat-model posture for `vault.pageId`: a Notion page ID is not a credential,
and exposing one does not bypass Notion permissions. Even so, keep page IDs out
of git so external clones of a public repo don't auto-target an unrelated
vault. A page ID that lands in history by accident should be removed from the
working tree; history rewrite or page replacement is only needed when the owner
considers the page location itself sensitive.

```yaml
# Required: Notion page ID containing the vault databases
vault:
  pageId: "<shared-team-vault-page-id>"

# Optional: workspace selector for multi-workspace ntn auth.json setups
# auth:
#   workspaceId: "workspace-id"
#
# Optional: read-only inherited vaults and deliberate promotion destinations.
# Normal save/update tools still write only to vault.pageId.
# upstreamVaults:
#   - name: "Engineering"
#     pageId: "engineering-vault-id"
#     priority: 10
# promotionTargets:
#   - name: "Team"
#     pageId: "team-vault-id"
#     requireReview: true

# Map directories to named projects (for monorepo support)
projects:
  - name: "Server"
    path: "src/server"
    tags: ["backend"]
  - name: "Client"
    path: "src/client"
    tags: ["frontend"]

# Auto-detect projects from workspace patterns
# detect:
#   patterns: ["packages/*/package.json"]
#   exclude: ["node_modules"]

# Hook behavior
hooks:
  autoSave: true
  # Inject digest, memories, tasks, active facts, and decisions at session start.
  # Set to false to skip the context injection (reduces prompt overhead
  # and the Notion round-trip at session start).
  wakeUp: true
  saveInterval: 5 # save after every 5 user messages
```

Token resolution order: `NOTION_API_TOKEN` environment variable, then
ntn-resolved `~/.config/notion/auth.json`. The first available source wins.
Any `auth.token` value in `.lore.yaml` is rejected at config load time; move
credentials to `NOTION_API_TOKEN` or ntn auth. Multi-workspace ntn setups
select a workspace with `NOTION_WORKSPACE_ID` or `auth.workspaceId`.

Notion rate limits are per token. ntn-issued tokens and PATs give each
operator an independent bucket; distributing one shared `secret_` integration
token through `NOTION_API_TOKEN` collapses everyone onto one bucket. See
[`AGENTS.md`](AGENTS.md#authentication) for the operational rationale, and
[`src/auth/AGENTS.md`](src/auth/AGENTS.md) for the priority chain
implementation, ntn version policy, and keychain-mode workaround.

### Environment variables

| Variable                 | Effect                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTION_API_TOKEN`       | Canonical Notion bearer token env var for Personal Access Tokens. Takes precedence over ntn `auth.json`                                                                                |
| `NOTION_WORKSPACE_ID`    | Selects a workspace from a multi-workspace ntn `auth.json`                                                                                                                            |
| `LORE_AGENT_NAME`        | Override the `Agent:` field on saved memories (e.g., `LORE_AGENT_NAME=Codex`)                                                                                                         |
| `LORE_USER_NAME`         | Override the `Author:` field on saved memories with a human display name. When unset, Lore resolves the engineer identity from `users.me` on the active ntn-issued token.             |
| `LORE_AUTO_DIGEST=false` | Suppress the Stop-triggered auto-digest scheduler (CLI `lore digest` still works)                                                                                                     |
| `LORE_NO_HYPERLINKS=1`   | Skip OSC 8 clickable hyperlinks in `lore search` and `lore status` output, even under TTY. Same fallback as the non-TTY path. `=0`, `=false`, and empty string are treated as not set |
| `NO_COLOR=1`             | Honored alongside `LORE_NO_HYPERLINKS` to skip OSC 8 emission                                                                                                                         |

## Monorepo Support

Projects map directories to named scopes using the `projects` array in
`.lore.yaml`. Lore resolves the current project from your working directory
using longest-prefix matching.

Given this config:

```yaml
projects:
  - name: "Root"
    path: "."
  - name: "Server"
    path: "src/server"
  - name: "Auth"
    path: "src/server/auth"
```

Running from `src/server/auth/middleware` resolves to the "Auth" project.
Memories, facts, and searches are automatically scoped to the matched project.

## Development

**Prerequisites**: Node.js 20+, npm

```bash
npm install          # Install dependencies
npm run build        # Build with tsup (ESM, 4 entry points)
npm run typecheck    # Type-check with tsc --noEmit
npm run lint         # Lint with eslint
npm run lint:fix     # Lint and auto-fix
npm run format       # Format with prettier
npm run test         # Run tests with vitest
npm run dev          # Watch mode (tsup --watch)
```

See [`CONTRIBUTING.md`](CONTRIBUTING.md), [`AGENTS.md`](AGENTS.md), and the
subsystem guides under `src/*/AGENTS.md` for contributor conventions,
architecture notes, and the non-negotiable stability rules. If you are changing
anything under `.github/workflows/`, read [`docs/ci.md`](docs/ci.md) first —
it documents the fork-safety contract every workflow must keep.

## Changelog

Notable user-facing changes are recorded in [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT
