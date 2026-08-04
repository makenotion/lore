# Installing Lore as a Dev Dependency

`@notionhq/lore` is publicly available from npm without registry or token
setup.

Teams that want every engineer's checkout to share the same Lore config can
pin `@notionhq/lore` as a devDependency and commit assistant config alongside
the rest of the repo. Yarn PnP is the fully path-portable shape: no absolute
paths land in committed MCP config, so the same files work on every engineer's
checkout.

## Wiring the Consumer Repo

1. **Add the devDependency.**

   ```bash
   yarn add -D @notionhq/lore        # or `npm install -D @notionhq/lore`
   ```

2. **Run `lore install` once locally.** From inside the consumer repo:

   ```bash
   yarn run -T lore install -y  # Yarn PnP consumers
   npx lore install -y          # npm / Yarn 1 consumers
   ```

   Default `lore install` is `--client all`. It writes the **bin-dispatch**
   config shape for every supported host:
   - `.mcp.json` for Claude Code with
     `{ "command": "yarn", "args": ["run", "-T", "lore", "mcp"] }` for Yarn
     PnP, or `{ "command": "lore", "args": ["mcp"] }` for npm / Yarn 1
     (auto-detected via `.pnp.cjs`).
   - `.omp/mcp.json` for OMP with the same MCP command / args shape. OMP's
     native project config takes precedence over root `.mcp.json` and exposes
     Lore's MCP tools without Lore lifecycle hooks.
   - `.codex/config.toml` with the Lore MCP server and
     `features.hooks = true`, plus `.codex/hooks.json` entries for
     `UserPromptSubmit` and `Stop` using `yarn run -T lore hooks <event>` (PnP)
     or `lore hooks <event>` (npm).
   - Project-scoped `.cursor/mcp.json` with the same MCP command / args shape
     as Claude Code. Use `--cursor-global` only when you want per-machine
     Cursor config instead.
   - Per-user Claude Code hook settings under
     `~/.claude/projects/<encoded-project>/settings.json` with
     `"command": "cd \"$CLAUDE_PROJECT_DIR\" && yarn run -T lore hooks <event>"`
     (PnP) or `"command": "cd \"$CLAUDE_PROJECT_DIR\" && lore hooks <event>"`
     (npm).

   OMP is MCP-only: it receives no Claude/Codex lifecycle hooks. Restart OMP
   or run `/mcp reload` after installing or changing `.omp/mcp.json`.

3. **Teach the repo's agents to prefer Lore.** Add a short "Memory and
   note-taking" section to the repo's `AGENTS.md` and `CLAUDE.md` so agents know
   when to call Lore tools instead of writing local-only notes. See
   [Quick Start step 6](../README.md#6-teach-your-agents-to-use-lore) for a
   pasteable starter.

4. **Commit the project-local diff.** Under the default `--client all` flow,
   commit the generated `.mcp.json`, `.omp/mcp.json`, `.codex/config.toml`,
   `.codex/hooks.json`, `.cursor/mcp.json`, and docs changes that landed in the
   repo.


   **Yarn PnP consumers**: the committed files work on any teammate's fresh
   checkout. `yarn install` resolves `@notionhq/lore` from npm without
   credentials, and host assistants resolve `lore` through Yarn's PnPAPI. No
   absolute paths or `${HOME}` placeholders land in the project-local MCP
   config.

   **npm / Yarn 1 consumers**: the committed MCP config carries a static
   `LORE_CONFIG_ROOT=<checkout-path>` so hosts can launch `lore mcp` from
   unpredictable directories. Review that static path before sharing across
   different checkout locations, or have teammates rerun `lore install`
   after checkout.

   Per-user Claude hook settings are local to each engineer and not part of
   the project diff; teammates should run `lore install` after checkout to
   write their own host hook config.

> **Don't have a global `lore` install on the same machine.** A global
> `npm install -g @notionhq/lore` would shadow the project-local devDep on
> PATH for shells that don't put `node_modules/.bin` ahead of global bins. Stick
> to one source of truth per machine.

## Migrating From a `~/.lore` Deployment

Legacy `~/.lore` installs, where every engineer cloned Lore to home and the
committed config used absolute paths, still upgrade in place. Default
`lore install` rewrites legacy entries to bin-dispatch and prints
`MCP server: upgraded (legacy → bin-dispatch)` in the install summary.
