# Lore

AI memory backed by Notion.

Lore stores knowledge as Notion pages organized across four core databases —
Projects, Topics, Memories, and Facts — plus an optional fifth database
(Entities, PF3-01) for canonical-handle resolution. It provides an MCP server
for AI assistants, a CLI for humans, and shell hooks for automated context
loading and session saving.

## Quick Start

### 1. Install

```bash
npm install makenotion/lore
```

### Using `@makenotion/lore` as a devDep (internal consumers)

Internal repos can pin `@makenotion/lore` as a devDependency from
GitHub Packages, then commit team-shared assistant config that works on
every engineer's checkout without per-engineer absolute-path rewrites.

#### Engineer setup (one-time, ~30 seconds)

If you're already authed with the [`gh` CLI](https://cli.github.com/):

```bash
gh auth refresh -h github.com -s read:packages
echo 'export GITHUB_PACKAGES_TOKEN="$(gh auth token)"' >> ~/.zshrc   # or ~/.bashrc
source ~/.zshrc
```

That's it. `gh` already manages the token, you just expose it under the
name `.yarnrc.yml` / `.npmrc` reads.

<details>
<summary>If you don't use the <code>gh</code> CLI (or your org disables OAuth tokens for packages)</summary>

Create a Personal Access Token instead:

1. Visit <https://github.com/settings/tokens/new> (Classic) or
   <https://github.com/settings/personal-access-tokens/new>
   (Fine-grained — preferred for least-privilege).
2. Scope: **`read:packages`** (Classic) or **Repository → Packages:
   Read-only** scoped to the package's source repo (Fine-grained).
3. `export GITHUB_PACKAGES_TOKEN=<the-token>` in your shell rc.

Both forms produce a token GitHub Packages accepts as a Bearer token.
The PAT path is also what CI typically uses, via
`secrets.GITHUB_TOKEN`.
</details>

#### Wiring the consumer repo (one-time, by whoever lands the migration)

1. **Configure the registry mapping.** For Yarn 4 / Berry, add to
   `.yarnrc.yml`:

   ```yaml
   npmScopes:
     makenotion:
       npmRegistryServer: "https://npm.pkg.github.com"
       npmAuthToken: "${GITHUB_PACKAGES_TOKEN:-}"
   ```

   For npm / Yarn 1, copy `.npmrc.example` and adapt — see that file
   for the details.

   The `${VAR:-}` default-value form is load-bearing: it lets unrelated
   yarn invocations (`yarn run -T lore mcp`, `yarn lint`, etc.) load the file
   without a token. Only registry fetches need it.

2. **Add the devDep.**

   ```bash
   yarn add -D @makenotion/lore        # or `npm install -D @makenotion/lore`
   ```

3. **Run `lore install` once locally.** From inside the consumer repo:

   ```bash
   yarn lore install -y      # Yarn PnP consumers
   npx lore install -y       # npm / Yarn 1 consumers
   ```

   This writes the **bin-dispatch** config shape:
   - `.mcp.json` with `{ "command": "yarn", "args": ["run", "-T", "lore", "mcp"] }`
     for Yarn PnP, or `{ "command": "lore", "args": ["mcp"] }` for
     npm / Yarn 1 (auto-detected via `.pnp.cjs`).
   - `.claude/settings.json` hooks with `"command": "cd \"$CLAUDE_PROJECT_DIR\" && yarn run -T lore hooks <event>"`
     (PnP) or `"command": "cd \"$CLAUDE_PROJECT_DIR\" && lore hooks <event>"`
     (npm).

   No absolute paths and no `${HOME}` placeholders — the file is
   portable across every engineer's machine.

4. **Teach the repo's agents to prefer Lore.** Add a short
   "Memory and note-taking" section to the repo's `AGENTS.md` and
   `CLAUDE.md` so agents know when to call Lore tools instead of
   writing local-only notes. See [Quick Start step 5](#5-teach-your-agents-to-use-lore)
   for a pasteable starter.

5. **Commit the resulting diff.** The committed config now Just Works
   on any teammate's fresh checkout: `yarn install` resolves
   `@makenotion/lore` from GitHub Packages (using each engineer's
   `GITHUB_PACKAGES_TOKEN`), and the host assistant resolves `lore`
   through Yarn's PnPAPI (or `node_modules/.bin/lore` for non-PnP
   consumers).

> **Don't have a global `lore` install on the same machine.** A global
> `npm install -g @makenotion/lore` would shadow the project-local
> devDep on PATH for shells that don't put `node_modules/.bin` ahead
> of global bins. Stick to one source of truth per machine.

#### Migrating from a `~/.lore` deployment

Legacy `~/.lore` installs (where every engineer cloned lore to home and
the committed config used absolute paths) still work — `lore install
--legacy-paths` opts back into the 0.10.x absolute-path output for one
release. Default `lore install` rewrites legacy entries to bin-dispatch
and prints `MCP server: upgraded (legacy → bin-dispatch)` in the install
summary. The 0.12.0 release will remove `--legacy-paths` and the
absolute-path code path together.

#### Working on lore itself (this repo's committed configs)

Lore's source repo is its own consumer, and lore can't bin-dispatch
through itself — there's no `node_modules/.bin/lore` in the repo
that's *publishing* `lore`. The committed `.mcp.json`,
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
Lore exits 1 with recovery copy (typically `ntn logout && NOTION_ENV=<env> ntn
login`) rather than silently creating a vault in the wrong environment. Either
init path creates the five databases inside the page (Projects, Topics,
Memories, Entities, Facts) and writes a `.lore.yaml` config file.

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

`LORE_NOTION_TOKEN` and inline `auth.token` still resolve as soft-deprecated
migration fallbacks. Removal is plausibly 0.11.0 or 1.0.0, contingent on
telemetry showing no internal team still relies on them; see
[`src/auth/AGENTS.md`](src/auth/AGENTS.md) for migration timing.

Existing vaults from before PF3-01 keep working without the Entities
database; run `lore migrate --build-entities --yes` to add it and
canonicalize the fact graph in one pass.

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

### Other MCP hosts

For agents not directly supported by `lore install --client`, use
`--print-config` to emit a paste-ready snippet for the appropriate format:

```bash
lore install --print-config json   # JSON `mcpServers` block
lore install --print-config toml   # TOML `[mcp_servers.lore]` section
```

The snippet's `cwd` and env-placeholder list are byte-identical to what
`--client claude` writes to `.mcp.json` and what `--client codex` appends
to `.codex/config.toml`. No files are written; pipe the output into your
agent's MCP config file by hand.

> **Note:** Per-host config paths below are **best-effort references**, not
> contracts. Each host owns its own config schema and may relocate the file
> between releases. Verify against your agent's official documentation
> before pasting; lore only commits to producing the canonical JSON / TOML
> shape.

- **Gemini-CLI** — typically a TOML file under `~/.config/gemini/`. Run
  `lore install --print-config toml`, paste the output into the appropriate
  section per the agent's current docs.
- **OpenCode** — TOML under `~/.opencode/` or `<project>/.opencode/`. Same
  workflow.
- **Windsurf** — JSON. Run `lore install --print-config json`, paste into
  Windsurf's `mcpServers` block per its docs.
- **Antigravity, Copilot, etc.** — locate your agent's MCP config file
  (host docs), pick the right format, paste.

> **Hooks are host-specific.** Claude Code and Codex installs wire
> Stop-triggered autosave, wake-up injection, and detached auto-digest helpers.
> Cursor and `--print-config` hosts get the MCP tool surface but not background
> hooks.

### 5. Teach Your Agents to Use Lore

`lore install` wires the MCP server and hooks into the assistant host, but
agents still need repo-local instructions that tell them to prefer the shared
Lore vault for team knowledge. Add a "Memory and note-taking" section to the
root `AGENTS.md` and, when the repo uses Claude Code, mirror it in
`CLAUDE.md`.

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

| Database     | Title Property | Key Properties                                         | Relations                                    |
| ------------ | -------------- | ------------------------------------------------------ | -------------------------------------------- |
| **Projects** | Name           | Type (project/person/agent), Path, Status, Description | --                                           |
| **Topics**   | Name           | Description                                            | Project                                      |
| **Memories** | Title          | Source, Author, Agent, Tags, Session + page body       | Project, Topic                               |
| **Entities** | Name           | Aliases, Kind, Description                             | Project, Source (Memory)                     |
| **Facts**    | Subject        | Predicate, Object, Valid From, Valid Until, Confidence | Project, Source (Memory), SubjectEntity, ObjectEntity |

**Entities** is created automatically by `lore init` on new vaults. Existing
vaults from before PF3-01 can opt in via `lore migrate --build-entities --yes`,
which also adds the `SubjectEntity` / `ObjectEntity` relation columns to Facts
and re-points historical rows in one pass.

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
[`AGENTS.md`](AGENTS.md#confidence-categorical-vs-numeric-080) for the full
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
[`AGENTS.md`](AGENTS.md#topic-keys-for-evolving-memories-090) for promotion
and re-keying rules.

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
deprecation purge; see `src/mcp/AGENTS.md` for the historical timeline.

### `lore-context` — vault context

| Action     | Description |
| ---------- | ----------- |
| `status`   | Show vault status, database counts, and active project |
| `wake-up`  | Load latest digest, ranked/recent memories, tasks, active facts, decisions needing attention, and memories related to active tasks |
| `digest`   | Gather raw activity data for synthesis into a `source: "digest"` memory |

### `lore-memory` — memory mutations + batch hydration

| Action    | Description |
| --------- | ----------- |
| `save`    | Save a new memory (markdown content stored as page body) |
| `update`  | Update a memory's title, content, tags, or categorization |
| `archive` | Soft-delete a memory by ID |
| `expand`  | Batch-fetch memory bodies by ID (up to 20, parallelized) |
| `suggest-topic-key` | Suggest a stable topic key for recurring memory topics |
| `compare` | Record a conflict/compatibility verdict on a pair of memories |

### `lore-query` — vault read paths

| Action       | Description |
| ------------ | ----------- |
| `recall`     | List recent memories with optional filters |
| `search`     | Semantic search across memories using Notion's search API |
| `ask`        | Query facts and tasks about an entity |
| `audit`      | List overdue facts, decisions, and tasks past their review date |

### `lore-fact` — knowledge graph mutations

| Action       | Description |
| ------------ | ----------- |
| `create`     | Add a subject-predicate-object fact triple. Tracking predicates (`needs_action` / `waiting_on` / `blocked_by`) are rejected post-P3-02 — use `lore-task action='create'` instead. |
| `invalidate` | Invalidate a fact (sets Valid Until date, preserves history) |
| `extend`     | Push a fact's review-by date forward |

After P3-02, `lore-query action='ask'` also surfaces tasks touching the
entity. For tracked work triage, use `lore-task action='list'`.
Un-migrated vaults may still contain historical tracking-predicate facts;
`lore status` reports those rows for manual remediation.

### `lore-task` — tracked work

`Kind = task` memories supersede the legacy tracking-predicate facts (`needs_action` / `waiting_on` / `blocked_by`). The description lives in the page body (no rich_text length cap) and the subject is structurally indexed, so structural queries actually work.

| Action      | Description                                                            |
| ----------- | ---------------------------------------------------------------------- |
| `create`    | Create a task with subject, description, state, blocker, and due date  |
| `update`    | Update a task's state, blocker, due date, subject, or description      |
| `close`     | Mark a task done (or cancelled — distinguished for metrics)            |
| `list`      | List tasks with Overdue/Active sections; filters by entity, state, due |
| `reconcile` | Surface likely active tasks that can be closed from newer evidence     |

The old single-purpose task aliases were removed in 0.6.0; use the polymorphic
`lore-task` dispatcher.

Current releases no longer ship the tracking-predicate migration command. If
`lore status` reports historical tracking facts, restore that migration from
git history and run it manually against the vault, or hand-edit the Notion rows
into tasks.

### `lore-decision` — decision lifecycle

| Action      | Description |
| ----------- | ----------- |
| `create`    | Record a decision with rationale, alternatives, consequences; auto-creates `decided_by` facts |
| `list`      | Index-tier listing of decisions (no body fetch) |
| `get`       | Load full rationale + metadata for a specific decision |
| `context`   | Find every decision governing an entity via the facts graph |
| `supersede` | Mark an old decision as superseded by a new one; creates a `supersedes_decision` fact |
| `review`    | Mark a decision as reviewed, push `Review By` forward |

### `lore-project` — project read paths

| Action | Description |
| ------ | ----------- |
| `list` | List all projects in the vault |
| `get`  | Get project details, topics, and recent activity |

## CLI Commands

| Command                        | Description                                                      |
| ------------------------------ | ---------------------------------------------------------------- |
| `lore init [page-id]`          | Create vault databases and write `.lore.yaml`. Pass `<page-id>` for team / repo-scoped vaults (recommended); omit to create a workspace-level page via the active auth source, bootstrapping ntn only when no auth resolves. `--name <name>` overrides the default repo-derived title; `--ntn-env <prod\|dev\|stg>` bootstraps against a non-prod Notion environment; `--yes` auto-confirms ntn install / login prompts |
| `lore install`                 | Install Lore assistant integrations (defaults to Claude Code + Codex + Cursor; `--client cursor`, `--cursor-global` for Cursor-only setup; `--print-config json\|toml` prints a paste-ready snippet for unsupported MCP hosts) |
| `lore auth`                    | Check authentication status                                      |
| `lore auth --login`            | In a repo with `.lore.yaml`, authenticate via ntn, auto-installing ntn if needed and verifying vault access |
| `lore search <query>`          | Semantic search across memories (`-p`, `-t`, `-n` flags)         |
| `lore mine [path]`             | Index project files as memories (`--dry-run`, `--pattern`, `-n`) |
| `lore status`                  | Show vault status, database counts, and active projects          |
| `lore status projects`         | List all projects (`-a` for archived)                            |
| `lore status topics [project]` | List topics in a project                                         |
| `lore migrate`                 | Add missing schema properties and run one-shot data migrations (`--dry-run`, `--upgrade-decision-tags`, `--build-entities`, `--fix-fact-encoding`, `--fix-memory-encoding`, `--merge-similar-topics`, `--backfill-synopses`, `--build-confidence-scores`, etc.) |
| `lore conflicts scan`          | Walk the vault and surface candidate conflict pairs for in-context judgment (`-p`, `-n`, `--include-bodies`, `--json`, `--exhaustive`). Read-only — emits prompt-ready output the calling agent dispatches back via `lore-memory action='compare'`. |

### Conflict detection

`lore conflicts scan` is a read-only operator-pulled scanner that
walks the vault, identifies pairs of memories whose titles +
keywords trigram-overlap (or whose tags overlap) above threshold,
filters out pairs already judged via `Compared With`, and emits
**prompt-ready output** the calling agent reads and dispatches
back via `lore-memory action='compare'`. The CLI itself does NOT
call any LLM and does NOT call the compare tool.

Compare verdicts are a closed vocabulary. `conflicts_with` and `supersedes` are
asymmetric and require `affectedMemoryId` naming the memory whose confidence
score should be reduced. `scoped`, `related`, `compatible`, and `not_conflict`
are symmetric and must omit `affectedMemoryId`. The `--json` output includes a
`compareContract` block, and [`AGENTS.md`](AGENTS.md#conflict-verdicts-090)
has the canonical verdict definitions.

The scan is bounded by two distinct caps:

- `SCAN_RAW_CANDIDATE_CAP = 500` per project — coverage knob;
  bounds the per-project candidate accumulator (top-K
  accumulation, so a high-overlap project allocates O(500)
  candidates, not O(N²)). Lifted by `--exhaustive`.
- `--limit` (default 50) — prompt-budget knob; applied AFTER
  dedup + Compared-With filter + sort, so it always budgets the
  *useful* candidate set.

Typical workflow:

```bash
# Surface a batch the agent can reason about:
lore conflicts scan --project Mail --limit 50

# Agent judges each pair via lore-memory action='compare'.

# Re-run; already-judged pairs drop out, next batch surfaces:
lore conflicts scan --project Mail --limit 50

# Repeat until the scan returns zero, then optionally:
lore conflicts scan --project Mail --exhaustive --limit 50
# Lifts the 500-candidate per-project cap to confirm full
# coverage on extremely overlapping projects.
```

`--json` swaps the markdown report for a JSON document carrying a
top-level `compareContract` block (asymmetric vs symmetric verdict
split, direction rules, back-reference to CLAUDE.md for canonical
verdict definitions). Progress messages route to stderr so
`--json` is pipe-clean.

## Hooks

Shell hooks for automated integration with AI coding assistants:

- **Auto-save** (`hooks/autosave.sh`): Runs on the assistant `Stop` hook and
  continues the session with a Lore save prompt after enough user messages.
  Works in both Claude Code and Codex. The Stop hook also schedules a
  detached auto-digest helper (off the hot path) so a stale weekly project
  digest is regenerated without blocking the user's next turn.

- **Wake-up** (`hooks/wakeup.sh`): Loads the latest project digest (if one was
  saved in the last 7 days), plus recent memories, active facts, and any
  memories relevance-matched against active task entities — one semantic query
  scored against memory titles and bodies, so the context behind each
  outstanding task comes in alongside the task itself.
  Claude Code injects it on `UserPromptSubmit`; Codex injects it on
  `SessionStart`. Set `hooks.wakeUp: false` in `.lore.yaml` to skip this
  injection for both assistants. If `.lore.yaml` fails to parse, the hook falls
  back to the default (on) and writes a `[lore]` warning to stderr.

Hooks resolve Notion auth through the same priority chain as the CLI and MCP
server. `lore install` forwards the `RUNTIME_FORWARDED_KEYS` allowlist from
`src/auth/forwarded-env.ts` into spawned children (auth tokens, workspace
selector, base-URL selectors, and user attribution override), while ntn-backed
setups read `~/.config/notion/auth.json` from the operator's home directory. If
no source resolves, the hook exits with the same "No Notion auth configured"
guidance as the foreground CLI.

`hooks/session-end.sh` is kept as an exit-0 compatibility shim for Claude
Code settings written before 0.6.0; new installs no longer register a
SessionEnd hook. Re-running `lore install --client claude` strips any stale
Lore-owned SessionEnd entries from `~/.claude/.../settings.json`.

Codex also requires the project to be trusted before it will load
project-scoped `.codex/*` files.

## Configuration

Lore is configured via `.lore.yaml`. The file is located by searching upward
from the current working directory.

```yaml
# Required: Notion page ID containing the vault databases
vault:
  pageId: "abc123..."

# Optional: workspace selector for multi-workspace ntn auth.json setups
# auth:
#   workspaceId: "workspace-id"
#
# Soft-deprecated migration fallback only:
# auth:
#   token: "<legacy-token>"

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
first available source wins. Multi-workspace ntn setups select a workspace with
`NOTION_WORKSPACE_ID` or `auth.workspaceId`.

Notion rate limits are per token, so ntn-issued per-user tokens give each
engineer an independent bucket; a shared `NOTION_API_TOKEN` collapses everyone
onto one bucket. See [`AGENTS.md`](AGENTS.md#authentication) for the operational
rationale, and [`src/auth/AGENTS.md`](src/auth/AGENTS.md) for the priority chain
implementation, ntn version policy, and keychain-mode workaround.

### Environment variables

| Variable | Effect |
|----------|--------|
| `NOTION_API_TOKEN` | Canonical Notion bearer token env var. Takes precedence over ntn `auth.json` |
| `NOTION_WORKSPACE_ID` | Selects a workspace from a multi-workspace ntn `auth.json` |
| `LORE_NOTION_TOKEN` | Soft-deprecated legacy Notion token fallback. Prefer ntn auth or `NOTION_API_TOKEN`; removal is plausibly 0.11.0 or 1.0.0, contingent on telemetry |
| `LORE_AGENT_NAME` | Override the `Agent:` field on saved memories (e.g., `LORE_AGENT_NAME=Codex`) |
| `LORE_USER_NAME` | Override the `Author:` field on saved memories with a human display name. When unset, Lore resolves the engineer identity from `users.me` on the active ntn-issued token. |
| `LORE_AUTO_DIGEST=false` | Suppress the Stop-triggered auto-digest scheduler (CLI `lore digest` still works) |
| `LORE_NO_HYPERLINKS=1` | Skip OSC 8 clickable hyperlinks in `lore search` and `lore status` output, even under TTY. Same fallback as the non-TTY path. `=0`, `=false`, and empty string are treated as not set |
| `NO_COLOR=1` | Honored alongside `LORE_NO_HYPERLINKS` to skip OSC 8 emission |

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
