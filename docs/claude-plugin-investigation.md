# Claude plugin integration: investigation

> **Status**: Investigation complete. Recommendation: do **not** replace the
> generated `.claude/settings.json` + `.mcp.json` shape with a plugin in the
> 0.10.x line. A plugin is viable as an *additional* user-scope distribution
> channel for personal use, but it does not subsume `lore install` for the
> Yarn-PnP / repo-pinned deployment path that drives Mail-shaped consumers.
> See [Recommendation](#recommendation) for the load-bearing reasoning.

This document discharges the acceptance criteria for the post-0.10.0 follow-up
issue *"Claude plugin integration"* (`Followup/12-claude-plugin-integration.md`).
The investigation was prompted by Mail dogfood PR `makenotion/mail#25947`,
which surfaced cwd-drift and Yarn-PnP issues with Lore's generated Claude
config shape. The 0.10.0 fix for those issues is generated-config work, tracked
under #08 (`lore install`) and #11 (root-safe PnP commands). The question this
document answers is whether a Claude plugin is the better long-term integration.

## What current `lore install --client claude` produces

The baseline is what we are deciding whether to replace. As of 0.10.0:

- **Hooks**: `~/.claude/projects/<encoded-project-path>/settings.json` gets
  `Stop` (autosave) and `UserPromptSubmit` (wakeup) entries whose `command`
  is `cd "$CLAUDE_PROJECT_DIR" && lore hooks <event>` (bare bin-dispatch) or
  `cd "$CLAUDE_PROJECT_DIR" && yarn run -T lore hooks <event>` (Yarn-PnP).
  See `buildClaudeHookCommand` in `src/cli/commands/install.ts:644`.
- **MCP**: `<projectDir>/.mcp.json` gets a `lore` entry with `command: "lore"`,
  `args: ["mcp"]`, plus an `env` block carrying conditional placeholders for
  `${NOTION_API_TOKEN}` / `${LORE_NOTION_TOKEN}` / `${LORE_NOTION_BASE_URL}`
  and static `LORE_CONFIG_ROOT` (omitted under PnP) +
  `LORE_SUPPRESS_DEPRECATIONS=1`. See `buildClaudeMcpEntry` in
  `src/cli/commands/install.ts:304`.
- **Idempotency**: `lore install` detects four legacy command shapes and the
  current shape, classifies each as `current` / `legacy-current` / `stale` /
  `missing`, and rewrites in place rather than duplicating.

The committed surface today is **one repo file** (`.mcp.json`) plus
**one user file** per project (`~/.claude/projects/<encoded>/settings.json`).
The user file is per-engineer and not committed; the repo file is portable
under PnP because `LORE_CONFIG_ROOT` is omitted in that mode.

## What a Claude plugin can do (May 2026)

Sourced from the official Claude Code plugin reference
([create plugins](https://code.claude.com/docs/en/plugins),
[plugins reference](https://code.claude.com/docs/en/plugins-reference),
[plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces)).

A plugin is a directory shipped via either `--plugin-dir` (dev) or a
`marketplace.json` (production). Components Lore would use:

- **`.mcp.json`** at the plugin root. Same `mcpServers` shape as project
  `.mcp.json` (`command` / `args` / `env` / `cwd`). Two plugin-only variable
  substitutions are available: `${CLAUDE_PLUGIN_ROOT}` (absolute path to the
  plugin's install dir; **changes on every plugin update**) and
  `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/<id>/`, persistent across
  versions). Standard `${VAR}` substitution from the operator's environment is
  also supported.
- **`hooks/hooks.json`** at the plugin root. Identical shape to user
  `settings.json` `hooks` block. All the lifecycle event names Lore uses
  (`Stop`, `UserPromptSubmit`, `SessionStart`) are available. Plugin hooks
  fire for the session, not scoped to a specific project. `$CLAUDE_PROJECT_DIR`
  is exposed to hook commands, same as user-defined hooks.
- **`bin/`** at the plugin root. Files here are added to the Bash tool's PATH
  while the plugin is enabled. Lore could ship `bin/lore-hook-wakeup`-style
  wrappers if hook command shape became awkward.
- **`.claude-plugin/plugin.json`** manifest. Carries `name` (becomes namespace
  prefix for skills), optional `version`, `dependencies`, etc.
- **Distribution**: Plugin lives in a git repo with a sibling `marketplace.json`
  (or a parent marketplace repo that points at the plugin source). Operators
  run `/plugin marketplace add github:Iron-Ham/lore-marketplace` (or
  equivalent) once, then `/plugin install lore@iron-ham`. Updates flow via
  `/plugin update` with the plugin's `version` field as the cache key.
- **Install scopes**: `user` (default, `~/.claude/settings.json`), `project`
  (`.claude/settings.json`, *committed*), `local` (`.claude/settings.local.json`,
  gitignored), `managed` (read-only). Project scope writes only
  `enabledPlugins: {"lore@<marketplace>": true}` — no per-engineer paths.

Two structural constraints matter for Lore:

1. **Path-traversal lockout**: marketplace-installed plugins are copied to
   `~/.claude/plugins/cache/<id>/` and **cannot reference files outside that
   directory** ("Installed plugins cannot reference files outside their
   directory" — plugins reference §"Path traversal limitations"). A plugin
   cannot reach into the consumer repo's `node_modules/@makenotion/lore` or
   `.lore.yaml`. Files inside the cache are accessible via
   `${CLAUDE_PLUGIN_ROOT}`; persistent plugin state goes in
   `${CLAUDE_PLUGIN_DATA}`.
2. **`$CLAUDE_PROJECT_DIR` exposure to MCP children is not documented**. The
   plugin reference and the MCP reference both confirm `${VAR}` substitution
   in `.mcp.json` `command` / `args` / `env`, but neither says whether
   `CLAUDE_PROJECT_DIR` is set in the environment Claude Code uses to expand
   those substitutions (or in the spawned MCP child's env) at MCP startup.
   Hooks get it explicitly. The conservative read is that any MCP entry that
   needs the project root has to either rely on Claude Code's startup cwd or
   shell out via `bash -lc 'cd "$CLAUDE_PROJECT_DIR" && ...'` from a hook
   (where `$CLAUDE_PROJECT_DIR` is guaranteed). This is something a prototype
   would need to verify; treat it as an unknown for now.

## Answers to the seven investigation questions

### 1. Can a plugin register the Lore MCP server and hooks in the shapes Lore needs?

**Yes, structurally.** Plugin `.mcp.json` and `hooks/hooks.json` accept the
exact shapes Lore writes today. The hook event names Lore uses (`Stop`,
`UserPromptSubmit`) work identically.

The shape difference: a plugin would not produce
`cd "$CLAUDE_PROJECT_DIR" && lore hooks wakeup` directly. The natural plugin
shape is either:

- **Bundled**: `${CLAUDE_PLUGIN_ROOT}/dist/cli.js hooks wakeup` — the plugin
  ships its own Lore build.
- **Shell-out**: `cd "$CLAUDE_PROJECT_DIR" && yarn run -T lore hooks wakeup` —
  same shape as today, just relocated into `hooks/hooks.json`.

The bundled shape is what plugin substitution variables *want* to express;
the shell-out shape is what Lore's deployment model actually needs (see
question 3).

### 2. Can the plugin reliably locate the project root / `.lore.yaml` without relying on hook-time cwd?

**For hooks: yes.** `$CLAUDE_PROJECT_DIR` is exposed to plugin hook commands
with the same guarantees as user hooks. `cd "$CLAUDE_PROJECT_DIR" && ...` is
the same anchoring Lore already uses; nothing in plugin packaging weakens or
strengthens that.

**For MCP: unverified.** Whether `${CLAUDE_PROJECT_DIR}` resolves inside a
plugin's `.mcp.json` `cwd` field is not documented. If yes, the plugin can
emit `cwd: "${CLAUDE_PROJECT_DIR}"` and Lore's existing `findConfigFile`
upward walk handles the rest. If no, the plugin has to wrap the MCP entry in
`bash -lc 'cd "$CLAUDE_PROJECT_DIR" && exec ...'` — workable but adds a shell
hop. **A prototype must verify this** before any commitment to the plugin
direction.

### 3. Can the plugin work when Lore is installed as a repo devDependency under Yarn PnP?

**Yes — but only if the plugin shells out to the consumer's PnP-resolved Lore.**
The path-traversal lockout means the plugin cannot read the consumer repo's
`node_modules`. The plugin would have to fall back to the existing pattern:
hook commands of the form `cd "$CLAUDE_PROJECT_DIR" && yarn run -T lore hooks
wakeup`. The MCP entry would need similar treatment.

This means the plugin is essentially a **delivery vehicle for the same shell
strings `lore install` already generates**, not a mechanism that simplifies
them. The plugin would produce the same hook commands; it would just register
them in a different file.

The alternative is **bundling** Lore inside the plugin so it runs from
`${CLAUDE_PLUGIN_ROOT}/dist/cli.js`. That decouples Lore's version from the
consumer repo's `package.json`, which **breaks the entire reason Mail moved
to a devDependency**: lockfile-pinned, reproducible Lore versions per repo.
Mail PR `#25947`'s explicit goal was to pin `@makenotion/lore` to `0.9.1`
(now post-0.10.0). A plugin that bundles its own Lore re-introduces version
drift between what's in `package.json` and what's actually running hooks
and MCP.

### 4. Can the plugin carry or invoke `LORE_AGENT_NAME=Claude` for autosave attribution?

**Yes, trivially.** Plugin `.mcp.json` and `hooks/hooks.json` both accept
`env` blocks and shell-string commands; setting `LORE_AGENT_NAME=Claude` works
identically to the Codex installer's existing `LORE_AGENT_NAME=Codex` prefix
(see `buildCodexHookCommand` in `src/cli/commands/install.ts:662`). In
practice, Claude Code already exports `CLAUDECODE=1` and `deriveAgentName`
already detects it, so the explicit attribution is belt-and-suspenders rather
than newly required.

### 5. Can the plugin avoid committing machine-specific paths or token values into repo config?

**Yes, and this is the strict-win argument for the plugin direction.**
A `--scope project` plugin install commits to `.claude/settings.json` only:

```json
{
  "enabledPlugins": {
    "lore@iron-ham-marketplace": true
  }
}
```

No `command`, `args`, `cwd`, `env`, or paths leak into the repo. By contrast,
the current `.mcp.json` shape commits `command`, `args`, and `env` placeholders
to the repo (which is fine because they're `${VAR}` placeholders, not absolute
paths — but the shape is opinionated and harder to evolve without a coordinated
Lore-version + repo-config bump). With a plugin, command shape changes ride
the plugin update channel and the repo file never changes.

This is genuine value, but it is **not unique to plugins**: the current
`.mcp.json` shape under PnP already omits `LORE_CONFIG_ROOT` and uses only
`${VAR}` placeholders, so no per-engineer paths are committed today either.

### 6. What is the install/update story for teams?

**Plugin model.**

- **Install**: `/plugin marketplace add` → `/plugin install lore@<marketplace>
  --scope project`. The marketplace-add step is per-engineer-per-machine; the
  install step writes to committed `.claude/settings.json`. Subsequent
  engineers cloning the repo see the `enabledPlugins` flag and Claude Code
  prompts them to enable on first session.
- **Update**: `/plugin update lore` (per-engineer) or auto-update on session
  start when the plugin's `version` field bumps. Cache keyed by version.
- **Versioning**: explicit `version` in `plugin.json` (recommended for
  published) or commit SHA (for fast-iterating internal). For Lore's release
  cadence, explicit version makes sense — bump it whenever hook command shape
  or MCP entry shape changes.

**Current model.**

- **Install**: `lore install` (per-engineer; can be embedded in a repo-level
  `make setup` step). Writes both committed `.mcp.json` and
  per-engineer `~/.claude/projects/.../settings.json`.
- **Update**: re-run `lore install -y`. The detector classifies existing
  shapes and rewrites stale/legacy ones idempotently.

The plugin model has a cleaner *update* story (centralized, version-keyed,
auto-applied). The install story is roughly equal — both require one
per-engineer-per-machine step.

### 7. How does the plugin interact with Codex and Cursor?

**It doesn't.** Claude plugins are a Claude Code feature. Codex consumes its
own `.codex/config.toml` + `.codex/hooks.json`; Cursor consumes
`.cursor/mcp.json`. Neither host has a plugin system that resembles Claude's.
A Lore Claude plugin would replace the Claude branch of `lore install` only,
leaving the Codex and Cursor branches unchanged.

This is the **dominant cost** of going plugin-first: Lore must continue to
maintain `lore install` for two hosts, and adding a third install path
(`/plugin install lore`) increases the surface area we have to keep in sync,
not decreases it. Drift between "what the plugin emits for Claude" and "what
`lore install --client codex` emits for Codex" becomes a real risk — for
instance, if we change hook event semantics in 0.11.0 we'd have to coordinate
the plugin version bump with the `lore install` update, and the plugin's
update cadence is decoupled from the `@makenotion/lore` package version
that Codex / Cursor consumers track.

## Recommendation

**Do not** replace generated `.claude/settings.json` + `.mcp.json` with a
plugin in 0.10.x. Keep `lore install` as the supported integration path. The
Mail-shaped Yarn-PnP / repo-pinned-devDependency deployment is the
load-bearing use case Lore exists to support, and that case is not improved
by plugin packaging:

- A bundled-Lore plugin breaks the lockfile-pinning Mail moved to
  devDependency for in the first place.
- A shell-out plugin produces the same hook commands `lore install` already
  emits under PnP (the work tracked in #11), just relocated into
  `hooks/hooks.json` instead of `~/.claude/projects/.../settings.json` —
  no functional simplification.
- Any plugin direction leaves the Codex and Cursor branches of `lore install`
  unchanged, so the install command does not shrink.
- One unverified gap (`${CLAUDE_PROJECT_DIR}` substitution inside MCP entries)
  would block a clean plugin MCP shape on its own.

**Reconsider** if any of the following changes:

- A second large repo on Yarn PnP hits cwd / install issues that #11 doesn't
  address (suggests the generated-config approach has structural limits).
- Claude Code adds plugin features that meaningfully reduce repo-config churn
  Lore couldn't otherwise reduce (e.g., a documented MCP `${CLAUDE_PROJECT_DIR}`
  substitution that *combined* with bundling would let a plugin emit a
  truly portable MCP entry without shell-outs).
- Anthropic ships an "official" Lore plugin distribution channel that
  implies a stable user surface we'd want to align to.

A complementary user-scope plugin **could** ship later for engineers who want
a personal / cross-repo Lore install without touching repo config. Such a
plugin would shell out via `cd "$CLAUDE_PROJECT_DIR" && yarn run -T lore
hooks <event>` (or `lore hooks <event>` for non-PnP repos), would NOT bundle
its own Lore, and would be explicitly documented as an alternative to
`lore install --client claude` for personal use only — **never** as the
team-shared install path. That's a small, additive scoping decision worth
revisiting once 0.10.0 has landed and Mail (plus a second consumer) are
running on the generated-config path stably.

## Plugin layout sketch (if we did ship one later)

For reference, here is what a personal-use Lore plugin would look like:

```text
lore-claude-plugin/
├── .claude-plugin/
│   └── plugin.json          # name: "lore", version, etc.
├── .mcp.json                # registers `lore` MCP server
└── hooks/
    └── hooks.json           # Stop + UserPromptSubmit
```

`.mcp.json`:

```json
{
  "mcpServers": {
    "lore": {
      "command": "bash",
      "args": [
        "-lc",
        "cd \"$CLAUDE_PROJECT_DIR\" && exec yarn run -T lore mcp 2>/dev/null || cd \"$CLAUDE_PROJECT_DIR\" && exec lore mcp"
      ],
      "env": {
        "LORE_SUPPRESS_DEPRECATIONS": "1"
      }
    }
  }
}
```

`hooks/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && (yarn run -T lore hooks autosave 2>/dev/null || lore hooks autosave)",
            "timeout": 10000
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "cd \"$CLAUDE_PROJECT_DIR\" && (yarn run -T lore hooks wakeup 2>/dev/null || lore hooks wakeup)",
            "timeout": 10000
          }
        ]
      }
    ]
  }
}
```

This is a **delivery vehicle for the existing shell strings**, not a
fundamentally different integration. The `(yarn run -T lore ... || lore ...)`
fallback covers PnP and non-PnP from one entry — it is the price of not
knowing whether the consumer is PnP at plugin-emit time. A prototype would
need to confirm Claude Code's hook runner tolerates the compound shell
expression and that the fallback only triggers on `command not found` rather
than on real Lore failures.

## Acceptance criteria — discharged

- **Document whether a Claude plugin can fully replace generated Claude
  hook/MCP config for Lore.** No, not under the Mail-shaped Yarn-PnP /
  repo-pinned-devDependency deployment. See [question 3](#3-can-the-plugin-work-when-lore-is-installed-as-a-repo-devdependency-under-yarn-pnp)
  and [Recommendation](#recommendation).
- **If viable, define the plugin layout and install/update flow.** A
  personal-use plugin layout is sketched in
  [Plugin layout sketch](#plugin-layout-sketch-if-we-did-ship-one-later).
  The team-shared replacement scenario is judged **not viable**, so its
  layout is omitted by design.
- **If not viable, document the blocking gap and keep #08/#11 generated
  config as the supported path.** The blocking gaps are: lockfile pinning is
  incompatible with plugin bundling; shell-out plugins are isomorphic to the
  current install output; `${CLAUDE_PROJECT_DIR}` exposure to MCP children
  is unverified; Codex and Cursor branches stay generated-config either way.
  `#08` and `#11` remain the supported path.
- **Confirm that any plugin direction does not weaken Codex/Cursor install
  support.** A complementary user-scope Lore plugin (if ever shipped) is
  Claude-only by design. `lore install --client codex` and `lore install
  --client cursor` continue to be the supported install paths for those
  hosts. See [question 7](#7-how-does-the-plugin-interact-with-codex-and-cursor).

## References

- Plugin reference (May 2026): <https://code.claude.com/docs/en/plugins-reference>
- Create plugins guide: <https://code.claude.com/docs/en/plugins>
- Plugin marketplaces: <https://code.claude.com/docs/en/plugin-marketplaces>
- MCP env-var expansion: <https://code.claude.com/docs/en/mcp> §"Environment variable expansion in `.mcp.json`"
- Lore install command source: `src/cli/commands/install.ts` (`buildClaudeMcpEntry`,
  `buildClaudeHookCommand`, `runClaudeInstall`)
- Triggering Mail PR: `makenotion/mail#25947`
- Related 0.10.0 work: `Followup/11-yarn-pnp-root-safe-install.md` (#08, #11)
