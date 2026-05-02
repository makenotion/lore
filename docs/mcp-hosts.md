# Unsupported MCP Hosts

For agents not directly supported by `lore install --client`, use
`--print-config` to emit a paste-ready snippet for the appropriate format:

```bash
lore install --print-config json             # JSON `mcpServers` block
lore install --print-config toml             # TOML `[mcp_servers.lore]` section
lore install --print-config json --yarn-pnp  # Yarn PnP JSON snippet
lore install --print-config toml --yarn-pnp  # Yarn PnP TOML snippet
```

The snippet's command / args shape and env-placeholder list match what
`--client claude` writes to `.mcp.json` and what `--client codex` appends to
`.codex/config.toml` for the selected shape. `--print-config` defaults to the
bare binary snippet and does not auto-detect `.pnp.cjs`; pass `--yarn-pnp` for
Yarn / PnP snippets. Bare snippets can rely on static env such as
`LORE_CONFIG_ROOT`; Yarn / PnP snippets intentionally omit that env and rely on
launching from the workspace root so `findConfigFile(cwd)` can walk upward. No
files are written; pipe the output into your agent's MCP config file by hand.

> **Note:** Per-host config paths below are **best-effort references**, not
> contracts. Each host owns its own config schema and may relocate the file
> between releases. Verify against your agent's official documentation before
> pasting; Lore only commits to producing the canonical JSON / TOML shape.

- **Gemini-CLI** — typically a TOML file under `~/.config/gemini/`. Run
  `lore install --print-config toml`, paste the output into the appropriate
  section per the agent's current docs.
- **OpenCode** — TOML under `~/.opencode/` or `<project>/.opencode/`. Same
  workflow.
- **Windsurf** — JSON. Run `lore install --print-config json`, paste into
  Windsurf's `mcpServers` block per its docs.
- **Antigravity, Copilot, etc.** — locate your agent's MCP config file (host
  docs), pick the right format, paste.

> **Hooks are host-specific.** Claude Code and Codex installs wire
> Stop-triggered autosave, wake-up injection, and detached auto-digest helpers.
> Cursor and `--print-config` hosts get the MCP tool surface but not background
> hooks.
