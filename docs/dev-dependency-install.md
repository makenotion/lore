# Installing Lore as a Dev Dependency

Internal repos can pin `@makenotion/lore` as a devDependency from public
npm, then commit team-shared assistant config. Yarn PnP is the fully
path-portable shape; npm / Yarn 1 bin-dispatch config may include a static
`LORE_CONFIG_ROOT` so host-launched MCP children can find `.lore.yaml`.

## Engineer Setup

None required for installing the package itself: `@makenotion/lore` is
published to public npm, so no `.npmrc` registry mapping, no
`GITHUB_PACKAGES_TOKEN`, and no `gh auth` step is needed before
`yarn install` / `npm install` resolves it.

The runtime auth Lore itself uses (Notion vault access) is covered
separately under [Quick Start](../README.md#2-create-a-vault) and
[docs/authentication.md](authentication.md).

## Wiring the Consumer Repo

1. **Add the devDep.**

   ```bash
   yarn add -D @makenotion/lore        # or `npm install -D @makenotion/lore`
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
   - `.codex/config.toml` with the Lore MCP server and
     `features.codex_hooks = true`, plus `.codex/hooks.json` entries for
     `UserPromptSubmit` and `Stop` using `yarn run -T lore hooks <event>` (PnP)
     or `lore hooks <event>` (npm).
   - Project-scoped `.cursor/mcp.json` with the same MCP command / args shape
     as Claude Code. Use `--cursor-global` only when you want per-machine
     Cursor config instead.
   - Per-user Claude Code hook settings under
     `~/.claude/projects/<encoded-project>/settings.json` with
     `"command": "cd \"$CLAUDE_PROJECT_DIR\" && yarn run -T lore hooks <event>"`
     (PnP) or
     `"command": "cd \"$CLAUDE_PROJECT_DIR\" && lore hooks <event>"` (npm).

   In the Yarn PnP shape, no absolute paths and no `${HOME}` placeholders land
   in the project-local MCP config, so the committed files are portable across
   every engineer's checkout. In the npm / Yarn 1 bare-bin shape,
   `LORE_CONFIG_ROOT=<checkout path>` is included in project-local MCP config so
   hosts can launch `lore mcp` from unpredictable directories; review that
   static path before sharing across different checkout locations, or have
   teammates rerun `lore install` after checkout. Claude hook settings are local
   to each engineer; teammates should run `lore install` after checkout to
   write their own host hook config.

3. **Teach the repo's agents to prefer Lore.** Add a short "Memory and
   note-taking" section to the repo's `AGENTS.md` and `CLAUDE.md` so agents know
   when to call Lore tools instead of writing local-only notes. See
   [Quick Start step 5](../README.md#5-teach-your-agents-to-use-lore) for a
   pasteable starter.

4. **Commit the project-local diff.** Under the default `--client all` flow,
   commit the generated `.mcp.json`, `.codex/config.toml`, `.codex/hooks.json`,
   `.cursor/mcp.json`, and docs changes that landed in the repo. For Yarn PnP
   consumers, those committed files Just Work on any teammate's fresh checkout:
   `yarn install` resolves `@makenotion/lore` from public npm, and host
   assistants resolve `lore` through Yarn's PnPAPI. For npm / Yarn 1 consumers,
   review any static `LORE_CONFIG_ROOT` before treating the committed MCP config
   as portable across checkout paths. Per-user Claude hook settings are not part
   of the project diff.

> **Don't have a global `lore` install on the same machine.** A global
> `npm install -g @makenotion/lore` would shadow the project-local devDep on
> PATH for shells that don't put `node_modules/.bin` ahead of global bins. Stick
> to one source of truth per machine.

## Migrating From a `~/.lore` Deployment

Legacy `~/.lore` installs, where every engineer cloned Lore to home and the
committed config used absolute paths, still work. `lore install --legacy-paths`
opts back into the 0.10.x absolute-path output for one release. Default
`lore install` rewrites legacy entries to bin-dispatch and prints `MCP server:
upgraded (legacy → bin-dispatch)` in the install summary. The 0.12.0 release
will remove `--legacy-paths` and the absolute-path code path together.
