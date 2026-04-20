# Lore

AI memory backed by Notion.

Lore stores knowledge as Notion pages organized across four databases: Projects,
Topics, Memories, and Facts. It provides an MCP server for AI assistants, a CLI
for humans, and shell hooks for automated context loading and session saving.

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

This creates the four databases inside the page and writes a `.lore.yaml`
config file.

### 4. Configure Your AI Assistant

```bash
lore install
```

By default, `lore install` installs both assistant integrations and fills in any
missing side from an older install.

Use `--client` to install only one assistant:

```bash
lore install --client claude
lore install --client codex
```

- `claude`: writes Claude Code settings plus `.mcp.json`
- `codex`: writes `.codex/config.toml` plus `.codex/hooks.json`

Codex only loads project-scoped `.codex/*` files for trusted projects.

## Data Model

A vault is a Notion page containing four linked databases:

| Database     | Title Property | Key Properties                                         | Relations                |
| ------------ | -------------- | ------------------------------------------------------ | ------------------------ |
| **Projects** | Name           | Type (project/person/agent), Path, Status, Description | --                       |
| **Topics**   | Name           | Description                                            | Project                  |
| **Memories** | Title          | Source, Author, Agent, Tags, Session + page body       | Project, Topic           |
| **Facts**    | Subject        | Predicate, Object, Valid From, Valid Until, Confidence | Project, Source (Memory) |

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

### Context

| Tool           | Description                                            |
| -------------- | ------------------------------------------------------ |
| `lore-status`  | Show vault status, database counts, and active project |
| `lore-wake-up` | Load latest digest, recent memories, open loops, and decisions needing attention |

### Memory

| Tool            | Description                                               |
| --------------- | --------------------------------------------------------- |
| `lore-remember` | Save a new memory (markdown content stored as page body)  |
| `lore-search`   | Semantic search across memories using Notion's search API |
| `lore-recall`   | List recent memories with optional filters                |
| `lore-update`   | Update a memory's title, content, tags, or categorization |
| `lore-forget`   | Archive a memory by ID                                    |

### Project

| Tool                 | Description                                      |
| -------------------- | ------------------------------------------------ |
| `lore-list-projects` | List all projects in the vault                   |
| `lore-get-project`   | Get project details, topics, and recent activity |

### Knowledge

| Tool             | Description                                                  |
| ---------------- | ------------------------------------------------------------ |
| `lore-learn`     | Add a subject-predicate-object fact triple                   |
| `lore-ask`       | Query facts about an entity (as subject or object)           |
| `lore-correct`   | Invalidate a fact (sets Valid Until date, preserves history) |
| `lore-open-loops` | List active open loops (tracking-predicate facts)           |
| `lore-audit`     | List overdue facts and decisions past their review date      |
| `lore-extend`    | Push a fact's review-by date forward                         |

### Decisions

| Tool                    | Description                                                          |
| ----------------------- | -------------------------------------------------------------------- |
| `lore-decide`           | Record a decision with rationale, alternatives, consequences; auto-creates `decided_by` facts |
| `lore-list-decisions`   | Index-tier listing of decisions (no body fetch)                      |
| `lore-get-decision`     | Load full rationale + metadata for a specific decision               |
| `lore-decision-context` | Find every decision governing an entity via the facts graph          |
| `lore-supersede`        | Mark an old decision as superseded by a new one; creates a `supersedes_decision` fact |
| `lore-review-decision`  | Mark a decision as reviewed, push `Review By` forward                |

### Journal

| Tool                | Description                 |
| ------------------- | --------------------------- |
| `lore-journal`      | Write an agent diary entry  |
| `lore-read-journal` | Read recent journal entries |

## CLI Commands

| Command                        | Description                                                      |
| ------------------------------ | ---------------------------------------------------------------- |
| `lore init <page-id>`          | Create vault databases in a Notion page and write `.lore.yaml`   |
| `lore install`                 | Install Lore assistant integrations (defaults to Claude Code + Codex) |
| `lore auth`                    | Check authentication status                                      |
| `lore auth --login`            | Authenticate via OAuth (opens browser)                           |
| `lore search <query>`          | Semantic search across memories (`-p`, `-t`, `-n` flags)         |
| `lore mine [path]`             | Index project files as memories (`--dry-run`, `--pattern`, `-n`) |
| `lore status`                  | Show vault status, database counts, and active projects          |
| `lore status projects`         | List all projects (`-a` for archived)                            |
| `lore status topics [project]` | List topics in a project                                         |
| `lore migrate`                 | Add missing schema properties to vault data sources (`--dry-run`, `--upgrade-decision-tags`) |

## Hooks

Shell hooks for automated integration with AI coding assistants:

- **Auto-save** (`hooks/autosave.sh`): Runs on the assistant `Stop` hook and
  continues the session with a Lore save prompt after enough user messages.
  Works in both Claude Code and Codex.

- **Wake-up** (`hooks/wakeup.sh`): Loads the latest project digest (if one was
  saved in the last 7 days), plus recent memories and active facts for the
  current project. Claude Code injects it on `UserPromptSubmit`; Codex injects
  it on `SessionStart`. Set `hooks.wakeUp: false` in `.lore.yaml` to skip this
  injection for both assistants. If `.lore.yaml` fails to parse, the hook falls
  back to the default (on) and writes a `[lore]` warning to stderr.

- **Session-end** (`hooks/session-end.sh`): Claude Code only. Runs a
  background fallback save when the stop hook did not already capture the
  session.

These hooks require `LORE_NOTION_TOKEN` to be set. They silently exit if the
variable is absent.

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

## License

MIT
