# AGENTS.md -- src/cli/

> Read the root `AGENTS.md` first. This file covers the CLI layer only.

## Purpose

This directory implements Lore's command-line interface using commander.js.
The CLI is the secondary interface for direct human interaction (setup,
debugging, manual search).

## Files

| File | Responsibility |
|------|---------------|
| `index.ts` | CLI entry point: creates the `lore` program, registers commands |
| `commands/init.ts` | `lore init <page-id>` -- create vault databases in Notion |
| `commands/auth.ts` | `lore auth` -- check/display authentication status |
| `commands/search.ts` | `lore search <query>` -- semantic search across memories |
| `commands/mine.ts` | `lore mine [path]` -- index project files as memories |
| `commands/status.ts` | `lore status` -- vault status + subcommands (projects, topics) |
| `commands/install.ts` | `lore install` -- install Lore assistant hooks and MCP config into a project (both assistants by default) |
| `commands/migrate.ts` | `lore migrate` -- add missing schema properties to vault data sources |
| `commands/digest.ts` | `lore digest` -- gather digest data + spawn background synthesizer |

## Commander Patterns

Each command file exports a `Command` instance:

```typescript
import { Command } from "commander"

export const fooCommand = new Command("foo")
  .description("What this command does")
  .argument("<required-arg>", "Argument description")
  .option("-f, --flag <value>", "Option description")
  .action(async (arg: string, opts: { flag?: string }) => {
    try {
      const services = await initServices()
      // ... command logic ...
    } catch (err) {
      console.error("Foo failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })
```

Commands are added to the program in `index.ts`:

```typescript
program.addCommand(fooCommand)
```

## Service Initialization

All commands that interact with the vault call `initServices()` from
`src/services.ts`. This loads config, creates the Notion client, verifies the
vault, and resolves the current project context.

**Exception**: The `auth` command does not call `initServices()` because it
only checks whether the token is available, without connecting to Notion.

**Exception**: The `init` command creates its own client and `VaultManager`
directly because it runs before a `.lore.yaml` exists.

## Error Handling

Every command action is wrapped in try/catch:

```typescript
try {
  // ... command logic ...
} catch (err) {
  console.error("Command failed:", err instanceof Error ? err.message : err)
  process.exit(1)
}
```

**Rules**:
- Log errors with `console.error`, not `console.log`.
- Exit with code 1 on failure.
- Extract the `.message` from Error instances for clean output.
- Non-fatal warnings (e.g., project not found during search) use `console.warn`
  and continue execution.

## Output Formatting

- Use `console.log` for all normal output.
- Keep output human-readable and scannable.
- Use indentation with two spaces for nested information.
- Use `"-".repeat(40)` or similar separators for visual structure (see `status.ts`).
- Memory search results show: title, tags, source, date, ID, and a 120-character
  content preview.

## Command Reference

| Command | Arguments | Key Options | Description |
|---------|-----------|-------------|-------------|
| `lore init <page-id>` | Notion page ID | `--token <token>` | Create vault databases, write `.lore.yaml` |
| `lore auth` | none | none | Show authentication status and setup instructions |
| `lore search <query>` | Search query | `-p`, `-t`, `-n` | Semantic search across memories |
| `lore mine [path]` | Directory path | `-p`, `-t`, `--pattern`, `--dry-run`, `-n` | Index project files as memories |
| `lore status` | none | none | Show vault status, database counts, active projects |
| `lore status projects` | none | `-a, --all` | List all projects |
| `lore status topics [project]` | Project name | none | List topics in a project |
| `lore install` | none | `--client`, `--project`, `-y` | Install Lore assistant integrations (defaults to Claude Code + Codex) |
| `lore migrate` | none | `--dry-run`, `--upgrade-decision-tags` | Add missing schema properties and select options to vault data sources (add-only, idempotent) |
| `lore digest` | none | `-p, --project`, `--period`, `--since`, `--until`, `--dry-run` | Gather project digest data and spawn a background `claude -p` synthesizer; `--dry-run` prints raw data only |

## The migrate Command

`migrate` handles two additive operations:

1. **Schema additions (default)**: Detects missing properties on each live data
   source and patches them via `dataSources.update`. Also detects missing
   select options on existing select/multi_select properties (preserving live
   option IDs so Notion doesn't duplicate). Idempotent — re-runs on an
   up-to-date vault issue zero writes.

2. **Legacy tag upgrade (`--upgrade-decision-tags`)**: Finds memories tagged
   `decision` (the pre-`Kind`-column convention) and upgrades them to
   `Kind: decision`, stripping the tag. Auto-runs schema migration first —
   users never have to remember the ordering.

Combining `--dry-run --upgrade-decision-tags` shows schema drift but does not
apply the tag upgrade (tag upgrade has no dry-run mode — it's opt-in by
design).

## The digest Command

`digest` gathers recent project activity and spawns a background `claude -p`
synthesizer that saves a distilled `source: digest` memory back to the vault.
The digest is what `lore-wake-up`'s fast path surfaces at session start, so
the goal is signal density (non-obvious findings, decisions landed, top-5
open loops, emerging themes) — not a chronological session log.

Mechanics:

- Data gathering is shared with the `lore-digest` MCP tool via
  `src/core/digest.ts` (`gatherDigestData`).
- The synthesizer prompt lives in `src/hooks/prompts.ts`
  (`buildDigestPrompt`) and uses the same untrusted-content framing as
  `buildSessionEndPrompt`.
- Background spawn reuses `spawnBackgroundSave` from
  `src/hooks/background.ts` with `logLabel: "digest"` so stderr
  attributions stay distinct.
- `--dry-run` prints the gathered markdown and skips the spawn. Use this to
  preview what the synthesizer will see before burning an API call.
- When no memories fall in the window, the command exits early without
  spawning (nothing to digest).
- `--since YYYY-MM-DD` (paired with optional `--until`) widens the window
  past the auto-scheduler's `period: "week"` default. Use this for
  projects that hover below the digest-worthy bar week-over-week — the
  session-end scheduler's quiet-week branch keeps touching the marker
  for those, so no `source: "digest"` memory ever lands and
  `lore-wake-up`'s fast path stays dark. The CLI re-touches the same
  marker after spawning, so a manual run debounces the next
  session-end's auto-path correctly.

Operators invoke `lore digest --project Mail` (or any configured
sub-project). It's the explicit path; the session-end hook fires it
implicitly once per project per 7 days when the cwd resolves to a single
sub-project. Both paths touch a per-project marker file under the hook
state directory (`$TMPDIR/lore-hook-state/digest.<project>.last`) so the
session-end path respects the debounce. The CLI also touches the marker
so a manual run won't be immediately overridden by the next session-end.

## Adding a New Command

1. Create `commands/foo.ts` following the pattern above.
2. Export a `Command` instance named `fooCommand`.
3. Import and add it in `index.ts`:
   ```typescript
   import { fooCommand } from "./commands/foo.js"
   program.addCommand(fooCommand)
   ```
4. Remember the `.js` extension in the import path.
5. Add the command to the table in this file and in the root `README.md`.

## The install Command

`install` supports multiple assistant targets:

- Default `lore install` updates both the Claude Code and Codex integration for
  the current project, so rerunning it after an older Claude-only install will
  add the missing Codex side.
- `--client claude` updates only Claude Code's `settings.json` hooks and the
  project's `.mcp.json`.
- `--client codex` updates only the project's `.codex/config.toml` and
  `.codex/hooks.json`.
- Codex hooks require `features.codex_hooks = true` and only load in trusted
  projects, so preserve that behavior if you change the installer.

### Agent identity via LORE_AGENT_NAME

Hook helpers derive the `Agent:` field on saved memories via
`deriveAgentName` (see `src/hooks/helpers.ts`). Claude Code sets
`CLAUDECODE=1` / `CLAUDE_CODE_*` automatically, but Codex has no
equivalent runtime marker.

To close the attribution gap, the Codex installer prefixes each hook
command with `LORE_AGENT_NAME=Codex `. `deriveAgentName` honors that
override so Codex-hooked sessions save memories tagged with
`Agent: Codex` instead of omitting the field.

Third-party agent integrations (Cline, Cursor, Aider, etc.) should
follow the same convention: prefix the hook command with
`LORE_AGENT_NAME=<Name>`. Explicit-over-inferred, so an override always
wins even if `deriveAgentName` later learns a detection heuristic for
that agent.

#### Contract for third-party integrators

The hook command must be executable as a POSIX shell string — Codex runs
`hooks.json` entries through `/bin/sh`, not `execve`. The exact pattern
`detectCodexHook` / `stripShellEnvPrefix` recognizes is:

```
VAR=VALUE [VAR=VALUE ...] /path/to/script.sh
```

Rules the detector enforces (and that reinstall depends on — a hook that
doesn't match the pattern will be classified `stale` and replaced):

- **Uppercase keys only**: `LORE_AGENT_NAME=Codex` ✓,
  `lore_agent_name=codex` ✗. Matches the POSIX env-var spelling
  convention the regex `[A-Z_][A-Z0-9_]*` enforces.
- **Unquoted, no-whitespace values only**: `LORE_AGENT_NAME=Codex` ✓,
  `LORE_AGENT_NAME=My-Agent` ✓, `LORE_AGENT_NAME="My Agent"` ✗.
  Quoted/spaced values break the `\S+` parse and the detector treats
  the command as un-prefixed. Pick a single-token agent name.
- **Multiple env prefixes are allowed**: `FOO=1 BAR=2 LORE_AGENT_NAME=Codex /path/to/script`
  works — each `VAR=VALUE ` pair is stripped in turn.
- **Do not wrap the command in an outer shell** (`sh -c "…"`). The
  detector strips leading assignments but does not unwrap wrapper
  shells; a wrapped command will not match its script name and
  `lore install` will replace it on every run.

Integrators writing to `.codex/hooks.json` directly should build the
command via the same shape `buildCodexHookCommand` produces: prefix,
then `JSON.stringify(absolutePath)` for the quoted script path. Running
`lore install --client codex` produces the canonical form for reference.

Codex currently targets POSIX shells only (macOS / Linux). `VAR=VALUE
cmd` is not recognized by `cmd.exe`, so the prefix is not portable to
Windows; revisit if Codex ships a Windows-native hook runner.

## The mine Command

`mine` is the most complex command. It walks a directory tree, filters for
text files by extension, and creates one memory per file. Key details:

- Skips directories: `node_modules`, `dist`, `build`, `.git`, `.next`, `__pycache__`
- Skips files: `.lore.yaml`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
- Only indexes files with recognized text extensions (see `TEXT_EXTENSIONS` set)
- Max file size: 100KB per file
- Default limit: 50 files per run
- Each memory is created with source `"file"` and keywords `"<extension> mined <relPath>"` — `tags` is left empty because file extensions are free-form tokens, not part of the closed tag vocabulary
- Content is wrapped in a markdown code block with the file extension as language
- Supports `--dry-run` to preview files without creating memories
