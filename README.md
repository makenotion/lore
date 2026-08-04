# Lore

AI memory backed by Notion.

Lore gives your AI assistants a persistent, shared memory: it stores
conversations, decisions, follow-up tasks, and durable relationships as Notion
pages that any teammate or agent session can read back. Anything you use with
the [Model Context Protocol](https://modelcontextprotocol.io) (Claude Code,
Codex, Cursor, OMP, and other MCP hosts) can recall, save, and reason over the
same vault, so context survives `/clear`, new branches, and handoffs between
people.

Under the hood, Lore organizes a vault into five core Notion databases:
Projects, Topics, Memories, Entities (canonical-handle resolution), and
Facts. The same domain services power three surfaces: an MCP server for
AI assistants, a CLI for humans, and hook commands that wire automatic
context loading and session saving into supported hosts.

## Quick Start

### 1. Install Lore

#### Install from npm (recommended)

```bash
npm install -g @notionhq/lore
# or
npm install -D @notionhq/lore
```

Public npm requires no registry configuration or package token.

#### Build from source

```bash
git clone https://github.com/makenotion/lore.git
cd lore && npm install && npm run build && npm link
```

`npm link` makes `lore` available globally on your `PATH` from the clone.
Run `lore --version` to confirm either installation route, then continue with
step 2 below.

For project-local installs, run `npx lore <command>` from inside the project
or add a `lore` script to `package.json`. See
[`docs/dev-dependency-install.md`](docs/dev-dependency-install.md) for the
Yarn PnP wiring and path-portable setup teams use to share assistant config
across a repo.

### 2. Join an Existing Shared Vault

Most operators should join an already initialized shared vault. A Lore vault is
a Notion page that already contains the five databases (Projects, Topics,
Memories, Entities, Facts). Joining that vault means pointing your local
`.lore.yaml` at the shared `vault.pageId`; do not run database initialization
against a shared page that your team lead has already bootstrapped.

`.lore.yaml` is local-only. Keep it out of version control, and distribute
shared values such as `vault.pageId` through onboarding docs instead of
committing config. This is the current policy even for credential-free shared
vault config and supersedes older changelog notes that allowed intentional
committed config.

Notion page IDs are access locators, not bearer credentials: knowing a page ID
does not grant access unless the caller's Notion token can already read that
page. Even so, keep `vault.pageId` out of version control so external clones of
a public repo don't auto-target a maintainer's vault. If a personal or
accidental page ID lands in git history, scrub the working tree and decide with
the page owner whether to replace the page or rewrite history.

#### Internal Notion engineer + shared vault

Use Lore's ntn-backed auth flow. It auto-installs `ntn` when needed, runs
`ntn login`, and stores the per-user token where Lore can read it.

```bash
# Join by pointing local config at the initialized shared vault.
# Do not run database initialization against an existing shared vault.
cat > .lore.yaml <<'YAML'
vault:
  pageId: "<shared-vault-page-id>"
YAML

lore auth --login
lore auth --status
lore status
```

#### External operator + shared vault

Create a Notion Personal Access Token at `notion.so/developers/tokens`, then
use it through the canonical Notion SDK environment variable. Do not use
`secret_` integration tokens from `notion.so/profile/integrations` for team
rollout; they share one rate-limit bucket across every operator using the same
integration. Persist `NOTION_API_TOKEN` in your shell profile or assistant host
environment before running `lore install` and restarting your assistant.

```bash
export NOTION_API_TOKEN="<notion-pat>"

# Join by pointing local config at the initialized shared vault.
# Do not run database initialization against an existing shared vault.
cat > .lore.yaml <<'YAML'
vault:
  pageId: "<shared-vault-page-id>"
YAML

lore auth --status
lore status
```

The last two commands verify that Lore can resolve auth and read the vault.
After they pass, configure your assistant in step 3. Restart or reconnect the
assistant after install or config changes so it reloads the MCP server and
hooks.

Token resolution order is `NOTION_API_TOKEN` -> ntn-resolved `auth.json`.
The first source available wins. See
[`docs/authentication.md`](docs/authentication.md) for the full priority chain,
multi-workspace selection, and troubleshooting.

If setup is broken and the next command is unclear, run `lore doctor` from the
project. It performs read-only checks across config discovery, auth, vault
access, MCP host config, hooks, and recent background hook failures, then ends
with one prioritized next action.

### 3. Configure Your Assistant

```bash
# Internal ntn path:
lore install --ntn

# External PAT path, after exporting NOTION_API_TOKEN:
lore install
```

Both install paths configure every supported assistant integration
(`--client all`, including OMP) and fill in any missing side from an older
install. Use `--client` to install only one. Keep `--ntn` on client-scoped
commands when using the internal ntn path; omit it for the PAT path after
exporting `NOTION_API_TOKEN`:

```bash
lore install --ntn --client claude
lore install --ntn --client codex
lore install --ntn --client cursor
lore install --ntn --client omp
lore install --ntn --client cursor --cursor-global
```

- `claude`: writes Claude Code settings plus `.mcp.json`
- `codex`: writes `.codex/config.toml` plus `.codex/hooks.json`
- `cursor`: writes `<projectDir>/.cursor/mcp.json`
  (`--cursor-global` opts into `~/.cursor/mcp.json`)
- `omp`: writes the project `.omp/mcp.json`

OMP's native `.omp/mcp.json` takes precedence over a root `.mcp.json` for OMP
discovery. OMP receives Lore's MCP tools without Claude/Codex lifecycle hooks;
restart OMP or run `/mcp reload` after installing or changing its config.

Codex only loads project-scoped `.codex/*` files for trusted projects.

Cursor's MCP runtime doesn't currently support session-end / Stop hooks, so
the Cursor installer only writes the MCP entry; the Stop-triggered autosave
and the detached auto-digest spawn run only under Claude Code or Codex.
Recall / save / scan paths work identically across Claude Code, Codex, Cursor,
and OMP.

#### Other MCP Hosts

For agents not directly supported by `lore install --client`, run
`lore install --print-config json` or `lore install --print-config toml` and
paste the emitted MCP server snippet into the host's config file. See
[`docs/mcp-hosts.md`](docs/mcp-hosts.md) for host notes and hook limitations.
OMP is already supported natively; do not use `--print-config` for OMP.

Restart or reconnect your assistant after `lore install` or manual host config
changes so it reloads the MCP server. For OMP, `/mcp reload` is also available;
OMP does not install Lore lifecycle hooks.

### 4. Advanced and Maintenance Flows

#### Team-lead / first-time shared-vault bootstrap

Use this path only when you are creating the shared vault databases for the
first time. Pick or create the Notion page your team will share, make sure your
auth source can write to it, then run:

```bash
lore init <page-id>
```

That command creates the five databases inside the page (Projects, Topics,
Memories, Entities, Facts) and writes your local `.lore.yaml`. Operators who
join the initialized vault later should use step 2 instead of running
initialization again.

See [`docs/team-rollout.md`](docs/team-rollout.md) for the per-engineer
onboarding flow and team-lead runbook.

#### Personal or Scratch Vault Creation

For personal vaults or fresh-onboarding scratch use, the no-arg flow creates a
workspace-level page on your behalf using the active auth source. If no auth
resolves, it auto-installs ntn, runs `ntn login`, and then writes
`.lore.yaml`:

```bash
lore init                            # default title: "Lore Vault - <basename(cwd)>"
lore init --name "Lore Vault Widget" # explicit title
```

For direct non-ntn setup, create a Notion Personal Access Token at
`notion.so/developers/tokens`, set the canonical Notion SDK env var, and make
sure the operator's Notion account can access the vault page before
bootstrapping a new vault:

```bash
export NOTION_API_TOKEN="<notion-pat>"
```

#### Dev-Environment Setup

Use the dev environment only when you intentionally want a dev-environment
vault:

```bash
lore init --ntn-env dev
```

If your existing ntn auth points at a different environment than `--ntn-env`,
Lore exits 1 with recovery copy (typically
`ntn logout && NOTION_KEYRING=0 NOTION_ENV=<env> ntn login`) rather than
silently creating a vault in the wrong environment.

To run `ntn` yourself, set `NOTION_KEYRING=0` before logging in. `ntn` defaults
to macOS Keychain storage, which Lore does not read; the env var forces
file-mode storage at `~/.config/notion/auth.json`:

```bash
NOTION_KEYRING=0 ntn login
```

Lore reads the resulting `auth.json` automatically. See
[`docs/team-rollout.md#known-gotcha-direct-ntn-login-outside-lore`](docs/team-rollout.md#known-gotcha-direct-ntn-login-outside-lore)
for the persistent shell-rc setup if you use `ntn` for other tooling too.

#### Refresh Auth for an Existing Vault

Once your local `.lore.yaml` points at a configured vault, refresh ntn auth
and preflight access with:

```bash
lore auth --login
```

Legacy token sources are not valid for new setup. `LORE_NOTION_TOKEN` is no
longer read as an auth source; when no supported auth source resolves, Lore
only mentions it as a migration hint. Any `auth.token` value in `.lore.yaml`
is rejected at config load time. Use `NOTION_API_TOKEN` for Personal Access
Tokens or `lore auth --login` for ntn auth.

#### Legacy Four-Database Vault Migration

Vaults created before the Entities database was introduced need one
bootstrap step before the entity backfill: run
`lore vault ensure-entities`, then run
`lore migrate --build-entities --allow-unscoped` to preview the vault-wide
backfill and `lore migrate --build-entities --allow-unscoped --yes` in a quiet
window to canonicalize the fact graph. Use `--project <name>` in both commands
for a project-scoped pass.

### 5. Teach Your Agents to Use Lore

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
relation columns to Facts. Plan/apply the vault-wide backfill with
`lore migrate --build-entities --allow-unscoped` and
`lore migrate --build-entities --allow-unscoped --yes`, or use
`--project <name>` in both commands for a project-scoped pass, to fill
historical rows that do not already have relation values. See
[`docs/team-rollout.md#entities-database-cutover`](docs/team-rollout.md#entities-database-cutover).

**Predicate values accepted by `lore-fact action='create'`** are profile-aware.
Generic predicates `is_a`, `has_a`, and `related_to` are always available; the
active profile contributes the rest of the agent-writable predicate set. The
default profile currently adds `uses`, `depends_on`, `created_by`, `owned_by`,
`replaces`, `extends`, and `conflicts_with`, while other profiles can expose
different domain-specific predicates. See
[`docs/profiles.md#taxonomy-contract`](docs/profiles.md#taxonomy-contract) and
the active profile taxonomy for the writable set in a given vault.
System-managed predicates are `decided_by`, `supersedes_decision`, `informs`
(`lore-decision action='create'` / `supersede`) and `mentions`
(`lore-memory action='save'`). Historical tracking predicates (`needs_action`,
`waiting_on`, `blocked_by`) are legacy row values only; use
`lore-task action='create'` for tracked work.

**Fact confidence (categorical)**: `certain`, `likely`, `speculative`. This is
the agent-writable stance on Facts. The separate numeric Facts `Confidence
Score` column is system-managed: read citations raise it,
contradiction/supersession signals lower it, and neglect decay reduces untouched
facts over time. Do not try to write the numeric score through MCP inputs.

**Memory sources**: new writes accept `conversation`, `autosave_learning`,
`file`, `manual`, and `digest`. `agent_diary` is retained for historical rows
and explicit audit recall only.

**Memory kinds**: `note`, `decision`, `incident`, `runbook`, `postmortem`,
`policy`, `task`, `procedure`. Procedures are reviewed governance memory:
propose them through `lore-procedure action='propose'`, then approve or reject
them through `lore-memory action='approve'` /
`lore-memory action='reject'`. `lore-memory action='save'` does not create
`kind: "procedure"` rows.

**Memory statuses**: `informational`, `proposed`, `accepted`, `superseded`, `deprecated`, `rejected`

### Topic keys

Recurring non-procedure memory topics (`decision`, `runbook`, `incident`,
`postmortem`, and `policy`) can pass `topicKey` to
`lore-memory action='save'`. Rows upsert by `(Topic Key + exact Project relation
set)`: a matching row gets a revision appended and its `Revision Count`
incremented instead of creating a new memory. Use stable prefixes matching those
save families: `decision/`, `runbook/`, `incident/`, `postmortem/`, and
`policy/`. Procedure topic keys use the `procedure/` family, but they are
supplied to `lore-procedure action='propose'` for proposal idempotency and
conflict detection rather than to `lore-memory action='save'` for revision
chains. Only the non-procedure save families form `lore-memory` revision chains;
`note` and `task` kinds do not form revision chains. Use
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
- `lore doctor` diagnoses setup health and prints the next repair action.
- `lore search <query>` searches memories.
- `lore memory save <title>` saves a manual memory from the shell.
- `lore decision create <statement>` records a decision with rationale.
- `lore ask <entity>` queries facts and tasks about an entity.
- `lore status` reports vault health and active project resolution.
- `lore costs summary` summarizes the opt-in local cost ledger.
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
even credential-free shared vault config stays outside git under the current
policy. Never put `auth.token`, personal scratch vault page IDs, or personally
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
| `NOTION_API_TOKEN`       | Canonical Notion bearer token env var for Personal Access Tokens. Takes precedence over ntn `auth.json`                                                                               |
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
npm run format:check # Check prettier formatting
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
