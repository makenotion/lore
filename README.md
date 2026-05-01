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

### 2. Create a Notion Integration

Go to [notion.so/my-integrations](https://www.notion.so/my-integrations),
create an integration, and copy the token.

```bash
export LORE_NOTION_TOKEN=ntn_...
```

### 3. Create a Vault

Create a page in Notion and share it with your integration, then:

```bash
lore init <page-id>
```

This creates the five databases inside the page (Projects, Topics, Memories,
Entities, Facts) and writes a `.lore.yaml` config file. Existing vaults from
before PF3-01 keep working without the Entities database; run
`lore migrate --build-entities --yes` to add it and canonicalize the fact
graph in one pass.

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

> **Hooks unsupported by design.** Stop-triggered autosave and the
> detached auto-digest spawn only fire under Claude Code today. Other
> hosts get the MCP tool surface but not the background hooks — same as
> Cursor.

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

**Predicate values**: `is_a`, `has_a`, `uses`, `depends_on`, `related_to`,
`created_by`, `owned_by`, `replaces`, `extends`, `conflicts_with`,
`needs_action`, `waiting_on`, `blocked_by` (plus `decided_by`,
`supersedes_decision`, `informs` — created internally by `lore-decide`)

**Confidence levels**: `certain`, `likely`, `speculative`

**Memory sources**: `conversation`, `file`, `manual`, `agent_diary`, `digest`

**Memory kinds**: `note`, `decision`, `incident`, `runbook`, `postmortem`, `policy`

**Memory statuses**: `informational`, `proposed`, `accepted`, `superseded`, `deprecated`, `rejected`

Save digests regularly (`lore-digest` → synthesize → `lore-remember` with
`source: "digest"`). When a digest from the last 7 days exists, `lore-wake-up`
surfaces it at the top and trims the raw-memory list underneath — a denser,
lower-token starting point than a long stream of individual memories.

## MCP Tools

Lore exposes seven polymorphic tools, each multiplexing several actions
behind one MCP registration. The 24 prior single-purpose tool names remain
registered as deprecated aliases that delegate to the same handlers — see
`src/mcp/AGENTS.md` for the full alias map.

### `lore-context` — vault context

| Action     | Description |
| ---------- | ----------- |
| `status`   | Show vault status, database counts, and active project |
| `wake-up`  | Load latest digest, recent memories, open loops, decisions needing attention, and memories related to those open loops |
| `digest`   | Gather raw activity data for synthesis into a `source: "digest"` memory |

### `lore-memory` — memory mutations + batch hydration

| Action    | Description |
| --------- | ----------- |
| `save`    | Save a new memory (markdown content stored as page body) |
| `update`  | Update a memory's title, content, tags, or categorization |
| `archive` | Soft-delete a memory by ID |
| `expand`  | Batch-fetch memory bodies by ID (up to 20, parallelized) |

### `lore-query` — vault read paths

| Action       | Description |
| ------------ | ----------- |
| `recall`     | List recent memories with optional filters |
| `search`     | Semantic search across memories using Notion's search API |
| `ask`        | Query facts about an entity (as subject or object) |
| `open-loops` | List active open loops (tracking-predicate facts) |
| `audit`      | List overdue facts and decisions past their review date |

### `lore-fact` — knowledge graph mutations

| Action       | Description |
| ------------ | ----------- |
| `create`     | Add a subject-predicate-object fact triple. Tracking predicates (`needs_action` / `waiting_on` / `blocked_by`) are rejected post-P3-02 — use `lore-task-create` instead. |
| `invalidate` | Invalidate a fact (sets Valid Until date, preserves history) |
| `extend`     | Push a fact's review-by date forward |

After P3-02, `lore-query action='ask'` also surfaces tasks touching the
entity, and `lore-query action='open-loops'` is deprecated in favour of
`lore-tasks` (un-migrated vaults still see legacy tracking facts).

### Tasks

`Kind = task` memories supersede the legacy tracking-predicate facts (`needs_action` / `waiting_on` / `blocked_by`). The description lives in the page body (no rich_text length cap) and the subject is structurally indexed, so structural queries actually work.

| Tool                | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| `lore-task-create`  | Create a task with subject, description, state, blocker, and due date  |
| `lore-task-update`  | Update a task's state, blocker, due date, subject, or description      |
| `lore-task-close`   | Mark a task done (or cancelled — distinguished for metrics)            |
| `lore-tasks`        | List tasks with Overdue/Active sections; filters by entity, state, due |

Migrate existing tracking-predicate facts to tasks via `lore migrate --migrate-tracking-to-tasks --yes`. Subsuming this family into a polymorphic `lore-task` dispatcher is tracked as PF3-06.

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
| `lore init <page-id>`          | Create vault databases in a Notion page and write `.lore.yaml`   |
| `lore install`                 | Install Lore assistant integrations (defaults to Claude Code + Codex + Cursor; `--client cursor`, `--cursor-global` for Cursor-only setup; `--print-config json\|toml` prints a paste-ready snippet for unsupported MCP hosts) |
| `lore auth`                    | Check authentication status                                      |
| `lore auth --login`            | Authenticate via OAuth (opens browser)                           |
| `lore search <query>`          | Semantic search across memories (`-p`, `-t`, `-n` flags)         |
| `lore mine [path]`             | Index project files as memories (`--dry-run`, `--pattern`, `-n`) |
| `lore status`                  | Show vault status, database counts, and active projects          |
| `lore status projects`         | List all projects (`-a` for archived)                            |
| `lore status topics [project]` | List topics in a project                                         |
| `lore migrate`                 | Add missing schema properties and run one-shot data migrations (`--dry-run`, `--upgrade-decision-tags`, `--build-entities`, `--migrate-tracking-to-tasks`, `--fix-fact-encoding`, `--merge-similar-topics`, `--backfill-synopses`, `--build-confidence-scores`, etc.) |
| `lore conflicts scan`          | Walk the vault and surface candidate conflict pairs for in-context judgment (`-p`, `-n`, `--include-bodies`, `--json`, `--exhaustive`). Read-only — emits prompt-ready output the calling agent dispatches back via `lore-memory action='compare'`. |

### Conflict detection

`lore conflicts scan` is a read-only operator-pulled scanner that
walks the vault, identifies pairs of memories whose titles +
keywords trigram-overlap (or whose tags overlap) above threshold,
filters out pairs already judged via `Compared With`, and emits
**prompt-ready output** the calling agent reads and dispatches
back via `lore-memory action='compare'`. The CLI itself does NOT
call any LLM and does NOT call the compare tool.

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
  memories relevance-matched against the entities already surfaced as open
  loops — one semantic query scored against memory titles and bodies, so the
  context behind each outstanding loop comes in alongside the loop itself.
  Claude Code injects it on `UserPromptSubmit`; Codex injects it on
  `SessionStart`. Set `hooks.wakeUp: false` in `.lore.yaml` to skip this
  injection for both assistants. If `.lore.yaml` fails to parse, the hook falls
  back to the default (on) and writes a `[lore]` warning to stderr.

These hooks require `LORE_NOTION_TOKEN` to be set. They silently exit if the
variable is absent.

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

# Optional: inline token (or set LORE_NOTION_TOKEN env var)
# auth:
#   token: "ntn_..."

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
  # Inject recent memories and open facts at session start.
  # Set to false to skip the context injection (reduces prompt overhead
  # and the Notion round-trip at session start).
  wakeUp: true
  saveInterval: 5 # save after every 5 user messages
```

Token resolution order: `auth.token` in `.lore.yaml`, then `LORE_NOTION_TOKEN`
environment variable, then OAuth credentials at `~/.lore/credentials.json`.

### Environment variables

| Variable | Effect |
|----------|--------|
| `LORE_NOTION_TOKEN` | Notion integration token (used when `auth.token` is absent from `.lore.yaml`) |
| `LORE_AGENT_NAME` | Override the `Agent:` field on saved memories (e.g., `LORE_AGENT_NAME=Codex`) |
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
