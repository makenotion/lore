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

## The mine Command

`mine` is the most complex command. It walks a directory tree, filters for
text files by extension, and creates one memory per file. Key details:

- Skips directories: `node_modules`, `dist`, `build`, `.git`, `.next`, `__pycache__`
- Skips files: `.lore.yaml`, `package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`
- Only indexes files with recognized text extensions (see `TEXT_EXTENSIONS` set)
- Max file size: 100KB per file
- Default limit: 50 files per run
- Each memory is created with source `"file"` and tags `[extension, "mined"]`
- Content is wrapped in a markdown code block with the file extension as language
- Supports `--dry-run` to preview files without creating memories
