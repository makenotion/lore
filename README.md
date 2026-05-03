# Lore

AI memory backed by Notion.

Lore stores knowledge as Notion pages organized across four core databases —
Projects, Topics, Memories, and Facts — plus an optional fifth database
(Entities, PF3-01) for canonical-handle resolution. It provides an MCP server
for AI assistants, a CLI for humans, and hook commands for automated context
loading and session saving.

## Quick Start

### 1. Install

```bash
npm install makenotion/lore
```

### Using `@makenotion/lore` as a Dev Dependency

Internal repos can pin `@makenotion/lore` from GitHub Packages and commit
portable assistant config that works across every engineer's checkout. See
[`docs/dev-dependency-install.md`](docs/dev-dependency-install.md) for the
GitHub Packages token setup, Yarn/npm wiring, and legacy `~/.lore` migration
notes.

#### Working on lore itself (this repo's committed configs)

Lore's source repo is its own consumer, and lore can't bin-dispatch
through itself — there's no `node_modules/.bin/lore` in the repo
that's _publishing_ `lore`. The committed `.mcp.json`,
`.cursor/mcp.json`, `.codex/config.toml`, and `.codex/hooks.json`
therefore use the legacy `${HOME}/.lore/...` absolute-path shape
deliberately. They assume the team-wide convention that every
internal contributor keeps a stable `~/.lore` clone (built with
`npm install && npm run build`) for assistant integration; a
worktree under `~/Developer/...` or anywhere else is independent
and does not affect the committed config.

If you re-run `lore install` from a different lore checkout it
will rewrite these files to point at that checkout's path — do
**not** commit that diff. The expected workflow is:

1. Maintain a stable `~/.lore` clone for editor / agent integration.
2. Hack on lore from any worktree you like (`~/Developer/lore`,
   `git worktree add`, etc.).
3. The committed `${HOME}/.lore/...` paths remain stable for
   every contributor.

The committed env passthrough lists every key in
`RUNTIME_FORWARDED_KEYS` (see `src/auth/forwarded-env.ts`) so any
contributor's resolved auth — `NOTION_API_TOKEN` (canonical),
ntn-issued (`auth.json`, no env forwarding needed),
`LORE_NOTION_TOKEN` (legacy), workspace + environment selectors,
`LORE_USER_NAME` attribution — reaches the spawned MCP server
unchanged.

### 2. Create a Vault

Lore is currently internal-Notion dogfood. The recommended internal auth path is
`ntn`-issued per-user tokens; the OAuth + PKCE external rollout is parked.

**For team / repo-scoped vaults** (the common case — one vault per
repo, shared across the team), create a page in Notion at the location
your team agrees on, make sure your active auth source can access it, and
pass its id to `lore init`. For ntn-issued tokens, page access inherits your
personal Notion permissions.

```bash
lore init <page-id>
```

This is the recommended path for shared use: the page lives at a
deliberate location (a team workspace, a project sub-page) with
deliberate sharing, and every engineer's `.lore.yaml` points at the
same id.

`.lore.yaml` is intended to be committable only when it contains shared,
non-secret configuration. A repo-scoped `vault.pageId` should point at a vault
deliberately shared with the team. Do not commit personal scratch vault IDs,
`auth.token`, or any other maintainer-specific value.

Notion page IDs are access locators, not bearer credentials: knowing a page ID
does not grant access unless the caller's Notion token can already read that
page. Lore therefore does not treat a deliberately shared team vault ID in git
history as a token leak requiring history rewrite or integration-sharing
rotation. Still treat page IDs as repo-scoped configuration, not personal
scratch metadata; if a private or accidental page ID lands in history, scrub the
working tree and decide with the page owner whether the page should be replaced
or history should be rewritten.

**For personal vaults / fresh-onboarding scratch use**, the no-arg
flow creates a workspace-level page on your behalf using the active auth
source. If no auth resolves, it auto-installs ntn, runs `ntn login`, and then
writes `.lore.yaml`:

```bash
lore init                          # default title: "Lore Vault — <basename(cwd)>"
lore init --name "Lore Vault Mail" # explicit title
lore init --ntn-env dev            # spawn ntn login against the dev environment
```

The no-arg init flow uses the normal auth priority chain first. When no auth
resolves, it runs `ntn login` with `[Y/n]` prompts (`--yes` for non-interactive
automation). It then creates the page at workspace level (under your Private
area in Notion's UI), runs the `verifyVaultAccess` preflight, initializes the
five databases, and writes `.lore.yaml`. The page title defaults to `Lore Vault
— <basename(cwd)>` (e.g., `Lore Vault — Mail`) so multiple private vaults in
the same workspace remain distinguishable; pass `--name` to override. Pass
`--ntn-env <prod|dev|stg>` when bootstrapping against a non-prod Notion
environment — the flag sets `NOTION_ENV` for the spawned `ntn login` so the
resulting `auth.json` and `config.json` reflect the requested env.

If your existing ntn auth points at a different environment than `--ntn-env`,
Lore exits 1 with recovery copy (typically
`ntn logout && NOTION_KEYRING=0 NOTION_ENV=<env> ntn login`) rather than
silently creating a vault in the wrong environment. Either init path creates the
five databases inside the page (Projects, Topics, Memories, Entities, Facts)
and writes a `.lore.yaml` config file.

For direct non-ntn integration tokens, set the canonical Notion SDK env var and
share the page with that integration before `lore init <page-id>`. This path is
only for non-ntn integrations; ntn users do not separately share with the
`Notion Workers CLI` bot.

```bash
export NOTION_API_TOKEN=<your-integration-token>
```

See [`docs/internal-rollout.md`](docs/internal-rollout.md) for the per-engineer
onboarding flow and team-lead runbook.

### 3. Refresh Auth for an Existing Vault

Once a repo already has `.lore.yaml` checked in, use the Lore auth wrapper to
refresh ntn auth and preflight access to that configured vault:

```bash
lore auth --login
```

`LORE_NOTION_TOKEN` and inline `auth.token` remain soft-deprecated migration
fallbacks. Removal is plausibly 0.11.0 or 1.0.0, contingent on telemetry
showing no internal team still relies on them; see
[`src/auth/AGENTS.md`](src/auth/AGENTS.md) for migration timing. Because
`.lore.yaml` can be checked into a repo, Lore warns whenever it sees
`auth.token` in that file, even when a higher-priority auth source wins, and
rejects Notion bearer-shaped values such as `ntn_...` or `secret_...` at config
load time.

Existing vaults from before PF3-01 need one bootstrap step before the
entity backfill: run `lore vault ensure-entities`, then run
`lore migrate --build-entities --yes` in a quiet window to canonicalize
the fact graph.

### 4. Configure Your AI Assistant

```bash
lore install
```

By default, `lore install` installs every supported assistant integration
(`--client all`) and fills in any missing side from an older install.

Use `--client` to install only one assistant:

```bash
lore install --client claude
lore install --client codex
lore install --client cursor
lore install --client cursor --cursor-global
```

- `claude`: writes Claude Code settings plus `.mcp.json`
- `codex`: writes `.codex/config.toml` plus `.codex/hooks.json`
- `cursor`: writes `<projectDir>/.cursor/mcp.json`
  (`--cursor-global` opts into `~/.cursor/mcp.json`)

`--client both` still works as a deprecated alias for `--client all`; the
CLI prints a warning and proceeds.

Codex only loads project-scoped `.codex/*` files for trusted projects.

Cursor's MCP runtime does not currently support session-end / Stop hooks,
so the Cursor installer only writes the MCP entry; the Stop-triggered
autosave and the detached auto-digest spawn run only under Claude Code or
Codex. Recall / save / scan paths work identically across all three.

### Other MCP Hosts

For agents not directly supported by `lore install --client`, run
`lore install --print-config json` or `lore install --print-config toml` and
paste the emitted MCP server snippet into the host's config file. See
[`docs/mcp-hosts.md`](docs/mcp-hosts.md) for host notes and hook limitations.

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

A vault is a Notion page containing four core databases plus an optional
fifth (Entities, PF3-01):

| Database     | Title Property | Key Properties                                         | Relations                                             |
| ------------ | -------------- | ------------------------------------------------------ | ----------------------------------------------------- |
| **Projects** | Name           | Type (project/person/agent), Path, Status, Description | --                                                    |
| **Topics**   | Name           | Description                                            | Project                                               |
| **Memories** | Title          | Source, Author, Agent, Tags, Session + page body       | Project, Topic                                        |
| **Entities** | Name           | Aliases, Kind, Description                             | Project, Source (Memory)                              |
| **Facts**    | Subject        | Predicate, Object, Valid From, Valid Until, Confidence | Project, Source (Memory), SubjectEntity, ObjectEntity |

**Entities** is created automatically by `lore init` on new vaults. Existing
vaults from before PF3-01 can opt in via `lore vault ensure-entities`, which
creates the Entities database and adds the `SubjectEntity` / `ObjectEntity`
relation columns to Facts. Then run `lore migrate --build-entities --yes` to
re-point historical rows.

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

Lore exposes seven polymorphic tools, each multiplexing several actions
behind one MCP registration: `lore-context`, `lore-memory`, `lore-query`,
`lore-fact`, `lore-decision`, `lore-project`, and `lore-task`. The prior
single-purpose tool names and task aliases were removed in the 0.6.0
deprecation purge. See [`docs/mcp-tools.md`](docs/mcp-tools.md) for the action
reference and task/fact migration notes.

## CLI Commands

Core commands:

- `lore init [page-id]` creates vault databases and writes `.lore.yaml`.
- `lore install` writes assistant MCP config and supported hooks.
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
`hooks/autosave.sh` and `hooks/wakeup.sh` scripts are legacy `--legacy-paths`
entrypoints. Cursor and `--print-config` hosts only get the MCP tool surface.
See [`docs/hooks.md`](docs/hooks.md) for host timing, auth forwarding, auto-digest
behavior, and compatibility notes.

## Configuration

Lore is configured via `.lore.yaml`. The file is located by searching upward
from the current working directory.

Committed `.lore.yaml` files must contain only shared, non-secret config.
Allowed values include a team-owned `vault.pageId`, project mappings, detection
rules, and hook preferences. Do not commit `auth.token`, personal scratch
vault page IDs, or anything personally identifying; use environment variables
or ntn auth for credentials.

Threat-model posture for `vault.pageId`: a Notion page ID is not a credential,
and exposing one does not bypass Notion permissions. Team-owned vault IDs may be
committed when the page is deliberately shared with the repo's operators. A page
ID that is personal, provisional, or accidentally copied from a maintainer's
scratch vault should be removed from the working tree; history rewrite or page
replacement is only needed when the owner considers the page location itself
sensitive.

```yaml
# Required: Notion page ID containing the vault databases
vault:
  pageId: "<shared-team-vault-page-id>"

# Optional: workspace selector for multi-workspace ntn auth.json setups
# auth:
#   workspaceId: "workspace-id"
#
# Soft-deprecated migration fallback only. Never commit this field:
# auth:
#   token: "<legacy-token>"

# Optional: read-only inherited vaults and deliberate promotion destinations.
# Normal save/update tools still write only to vault.pageId.
# upstreamVaults:
#   - name: "Engineering"
#     pageId: "engineering-vault-id"
#     mode: read-only
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
ntn-resolved `~/.config/notion/auth.json`, then soft-deprecated
`LORE_NOTION_TOKEN`, then soft-deprecated `auth.token` in `.lore.yaml`. The
first available source wins. `.lore.yaml` rejects bearer-shaped `auth.token`
values at config load time; move those tokens to `NOTION_API_TOKEN` or ntn auth.
Multi-workspace ntn setups select a workspace with `NOTION_WORKSPACE_ID` or
`auth.workspaceId`.

Notion rate limits are per token, so ntn-issued per-user tokens give each
engineer an independent bucket; a shared `NOTION_API_TOKEN` collapses everyone
onto one bucket. See [`AGENTS.md`](AGENTS.md#authentication) for the operational
rationale, and [`src/auth/AGENTS.md`](src/auth/AGENTS.md) for the priority chain
implementation, ntn version policy, and keychain-mode workaround.

### Environment variables

| Variable                 | Effect                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NOTION_API_TOKEN`       | Canonical Notion bearer token env var. Takes precedence over ntn `auth.json`                                                                                                          |
| `NOTION_WORKSPACE_ID`    | Selects a workspace from a multi-workspace ntn `auth.json`                                                                                                                            |
| `LORE_NOTION_TOKEN`      | Soft-deprecated legacy Notion token fallback. Prefer ntn auth or `NOTION_API_TOKEN`; removal is plausibly 0.11.0 or 1.0.0, contingent on telemetry                                    |
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

## Changelog

Notable user-facing changes are recorded in [`CHANGELOG.md`](CHANGELOG.md).

## License

MIT
