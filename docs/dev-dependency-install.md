# Installing Lore as a Dev Dependency

Teams that want every engineer's checkout to share the same Lore config can
pin `@makenotion/lore` as a devDependency and commit assistant config alongside
the rest of the repo. Yarn PnP is the fully path-portable shape: no absolute
paths land in committed MCP config, so the same files work on every
engineer's checkout.

## Fresh install (post-#561, pending first public publish)

The publish workflow targets public `registry.npmjs.org` post-#561, but the
first release tag has not been cut yet — `npm view @makenotion/lore`
against the public registry currently returns `E404`. Once the first
publish lands (tracked in
[#569](https://github.com/makenotion/lore/issues/569)), the install path is:

```bash
npm install -D @makenotion/lore
# or
yarn add -D @makenotion/lore
```

No `.npmrc`, registry mapping, or authentication required. Run
`npx lore install` (or `yarn run -T lore install` under Yarn PnP) to wire
the MCP server and hooks.

> If you previously set up the pre-#561 `@makenotion`-scope mapping against
> GitHub Packages, skip to
> [Legacy: Pre-#561 GitHub Packages Migration](#legacy-pre-561-github-packages-migration)
> at the bottom of this doc for the cleanup steps. Fresh installs do not
> need any registry mapping; the legacy section is migration-only.

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
     `features.hooks = true`, plus `.codex/hooks.json` entries for
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

3. **Teach the repo's agents to prefer Lore.** Add a short "Memory and
   note-taking" section to the repo's `AGENTS.md` and `CLAUDE.md` so agents know
   when to call Lore tools instead of writing local-only notes. See
   [Quick Start step 6](../README.md#6-teach-your-agents-to-use-lore) for a
   pasteable starter.

4. **Commit the project-local diff.** Under the default `--client all` flow,
   commit the generated `.mcp.json`, `.codex/config.toml`, `.codex/hooks.json`,
   `.cursor/mcp.json`, and docs changes that landed in the repo.

   **Yarn PnP consumers**: the committed files Just Work on any teammate's
   fresh checkout. `yarn install` resolves `@makenotion/lore` from the public
   npm registry (no token required post-#561), and host assistants resolve
   `lore` through Yarn's PnPAPI. No absolute paths or `${HOME}` placeholders
   land in the project-local MCP config.

   **npm / Yarn 1 consumers**: the committed MCP config carries a static
   `LORE_CONFIG_ROOT=<checkout-path>` so hosts can launch `lore mcp` from
   unpredictable directories. Review that static path before sharing across
   different checkout locations, or have teammates rerun `lore install`
   after checkout.

   Per-user Claude hook settings are local to each engineer and not part of
   the project diff; teammates should run `lore install` after checkout to
   write their own host hook config.

> **Don't have a global `lore` install on the same machine.** A global
> `npm install -g @makenotion/lore` would shadow the project-local devDep on
> PATH for shells that don't put `node_modules/.bin` ahead of global bins. Stick
> to one source of truth per machine.

## Migrating From a `~/.lore` Deployment

Legacy `~/.lore` installs, where every engineer cloned Lore to home and the
committed config used absolute paths, still upgrade in place. Default
`lore install` rewrites legacy entries to bin-dispatch and prints
`MCP server: upgraded (legacy → bin-dispatch)` in the install summary.

## Legacy: Pre-#561 GitHub Packages Migration

> This section is only relevant if you previously set up the
> `@makenotion`-scope GitHub Packages registry mapping. Post-#561,
> `@makenotion/lore` resolves directly from public npm — no `.npmrc`
> or token needed for fresh installs. Skip this entire section if you
> never set up the pre-#561 flow.

### Cleanup (recommended)

Remove the pre-#561 registry mapping so future `yarn install` / `npm install`
runs hit public npm without falling through the legacy path:

- **Yarn 4 / Berry**: delete the `npmScopes.makenotion` block from
  `.yarnrc.yml`.
- **npm / Yarn 1**: delete the `@makenotion:registry=...` and
  `//npm.pkg.github.com/:_authToken=...` lines from `~/.npmrc`.
- The `GITHUB_PACKAGES_TOKEN` shell-rc export can stay or go; nothing in the
  post-#561 flow consumes it.

### Reference: the original pre-#561 setup

The setup below is preserved for engineers who still have these files on
disk and want to recognise what they configured. Do not follow these steps
for a fresh install.

<details>
<summary>Engineer Setup (pre-#561 GitHub Packages flow)</summary>

If you were already authed with the [`gh` CLI](https://cli.github.com/):

```bash
gh auth refresh -h github.com -s read:packages

# zsh
echo 'export GITHUB_PACKAGES_TOKEN="$(gh auth token)"' >> ~/.zshrc
source ~/.zshrc

# bash
echo 'export GITHUB_PACKAGES_TOKEN="$(gh auth token)"' >> ~/.bashrc
source ~/.bashrc
```

Or, if you didn't use the `gh` CLI or your org disabled OAuth tokens for
packages: a Personal Access Token instead.

1. Visit <https://github.com/settings/tokens/new> (Classic) or
   <https://github.com/settings/personal-access-tokens/new> (Fine-grained,
   preferred for least-privilege).
2. Scope: **`read:packages`** (Classic) or **Repository → Packages: Read-only**
   scoped to the package's source repo (Fine-grained).
3. `export GITHUB_PACKAGES_TOKEN=<the-token>` in your shell rc.

Both forms produced a token GitHub Packages accepted as a Bearer token. The
PAT path was also what CI used, via `secrets.GITHUB_TOKEN`.

</details>

<details>
<summary>Consumer-repo registry mapping (pre-#561)</summary>

For Yarn 4 / Berry, the `.yarnrc.yml` carried:

```yaml
npmScopes:
  makenotion:
    npmRegistryServer: "https://npm.pkg.github.com"
    npmAuthToken: "${GITHUB_PACKAGES_TOKEN:-}"
```

The `${VAR:-}` default-value form was load-bearing: it let unrelated yarn
invocations (`yarn run -T lore mcp`, `yarn lint`, etc.) load the file without
a token. Only registry fetches needed it.

For npm / Yarn 1, the `~/.npmrc` carried:

```
@makenotion:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_PACKAGES_TOKEN}
```

</details>
