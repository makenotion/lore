# CLI Authoring Guide

This guide covers shared conventions for implementing Lore CLI commands. Read
[`src/cli/AGENTS.md`](../src/cli/AGENTS.md) first for routing and
[`cli-command-contracts.md`](cli-command-contracts.md) for per-command
contracts.

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
      // command logic
    } catch (err) {
      console.error("Foo failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })
```

Commands are added to the program in [`src/cli/index.ts`](../src/cli/index.ts):

```typescript
program.addCommand(fooCommand)
```

## Service Initialization

All commands that interact with the vault call `initServices()` from
[`src/services.ts`](../src/services.ts). This loads config, creates the Notion
client, verifies the vault, and resolves the current project context.

Exceptions:

- `auth` status/login paths construct narrower auth clients directly when they
  need token or vault preflight checks without the full service graph.
- `init` creates its own client and `VaultManager` directly because it runs
  before a `.lore.yaml` exists.
- `install` loads config and verifies vault access through a narrow Notion
  client before writing host files; it does not use the full service graph.

## Error Handling

Every command action is wrapped in `try` / `catch`:

```typescript
try {
  // command logic
} catch (err) {
  console.error("Command failed:", err instanceof Error ? err.message : err)
  process.exit(1)
}
```

Rules:

- Log errors with `console.error`, not `console.log`.
- Exit with code 1 on failure.
- Extract `.message` from `Error` instances for clean output.
- Parse raw CLI flags inside the action's `try` block before calling
  `initServices()`. Parser helpers should return `CliParseResult<T>` from
  [`src/cli/parse.ts`](../src/cli/parse.ts); on `ok: false`, log the
  command-specific failure prefix and exit with code 1 before service
  initialization.
- Pair every intentional `process.exit(1)` inside the action body with a
  defensive `return` so production and test behavior stay aligned.
- Treat explicit project-scope misses as fatal. If a command accepts
  `--project <name>` and the name cannot be resolved, log an actionable error
  and exit with code 1 instead of falling back to auto-detected or vault-wide
  scope. Use `resolveProjectByName()` or `resolveProjectsByNames()` from
  [`src/core/project-scope.ts`](../src/core/project-scope.ts) so CLI wording
  stays aligned with MCP, including archived-specific diagnostics.
- Non-fatal warnings use `console.warn` and continue execution only when the
  requested operation can still proceed without changing the user's explicit
  scope.

## Testing Exit Paths

Every `process.exit(1)` call is a behavior contract that shell-script
integrations rely on. Each exit call site needs a paired test.

Use `trapProcessExit` from [`src/cli/test-helpers.ts`](../src/cli/test-helpers.ts):

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { trapProcessExit } from "../test-helpers.js"

describe("fooCommand exit paths", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>

  beforeEach(() => {
    exitTrap = trapProcessExit()
    errorSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("exits 1 on initServices failure", async () => {
    vi.mocked(initServices).mockRejectedValue(new Error("notion 503"))

    await fooCommand.parseAsync([], { from: "user" })

    expect(errorSpy.mock.calls.flat().join("\n")).toContain("Foo failed:")
    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })
})
```

The spy records exit codes into `exitTrap.exitCodes` and returns `undefined`; it
does not throw. Command actions must return after early `process.exit(1)` calls
so the no-throw test helper does not fall through into the outer catch.

Pin three things in these tests:

1. The user-visible `<Cmd> failed:` prefix.
2. `exitTrap.exitCodes` with `toEqual([1])`, not `toContain(1)`, so doubled
   exits are caught.
3. `errorSpy` call count with `toHaveBeenCalledTimes(1)`.

Spy cleanup is the project convention via `vi.restoreAllMocks()` in `afterEach`;
the helper does not expose a `restore()` method.

For malformed `--limit` / `--n` parse-failure tests, use the shared
`INVALID_LIMIT_STRINGS` fuzz set from `test-helpers.ts` so changes to the parse
helpers update every command's test bed in lockstep. The empty string `""` is
intentionally not in that set because `parseInt("")` returns `NaN`, a
structurally different parse path; cover it as its own `it()` test.

[`init.test.ts`](../src/cli/commands/init.test.ts) and
[`auth.test.ts`](../src/cli/commands/auth.test.ts) define local exit-trap
helpers with slightly different shapes. Keep their local pattern unless you are
doing a focused migration of those files.

## Output Formatting

- Use `console.log` for normal output.
- Keep output human-readable and scannable.
- Use indentation with two spaces for nested information.
- Use `"-".repeat(40)` or a similar separator when a command already uses
  visual sections.
- Memory search results show title, tags, source, date, ID, and a
  120-character content preview.
- Progress and diagnostics for JSON-capable commands go to stderr so stdout
  stays pipe-clean.

## OSC 8 Hyperlinks

Memory titles and project names rendered by `lore search` and `lore status`
flow through `terminalLink` in [`src/cli/output.ts`](../src/cli/output.ts),
which wraps them in OSC 8 escape sequences pointing at the page's Notion URL.
The helper falls back to plain text on non-TTY stdout, when `NO_COLOR` or
`LORE_NO_HYPERLINKS` is set, or when the URL fails the Notion safelist. Page
IDs stay plain text because operators copy them into other tools.

`maybeTerminalLink` is the pure helper with injected `{ isTTY, env }` values;
`terminalLink` is the production wrapper that binds those values from the live
process. Build link targets via `notionPageUrl(id)` rather than constructing a
Notion URL inline so every call site routes through the same helper.

Subcommand listings such as `lore status projects` and `lore status topics`
stay plain to keep names selectable for copy-paste. Only top-level `lore
status` and `lore search` wrap titles. `lore mine` has no title-shaped output
to link.

## Adding a New Command

1. Create `commands/foo.ts` following the commander pattern above.
2. Export a `Command` instance named `fooCommand`.
3. Import and add it in [`src/cli/index.ts`](../src/cli/index.ts):

   ```typescript
   import { fooCommand } from "./commands/foo.js"
   program.addCommand(fooCommand)
   ```

4. Remember the `.js` extension in the import path.
5. Add the command to [`docs/cli.md`](cli.md) and update the root README summary
   when the command belongs in the quick-start list.
6. Add or update command-specific contracts in
   [`cli-command-contracts.md`](cli-command-contracts.md).
7. Add focused tests when behavior changes.
