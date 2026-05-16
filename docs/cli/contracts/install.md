# The `install` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore install` writes assistant integration configuration and performs auth and
vault preflight checks before writing host files.

Persona routing:

- Default `lore install` is PAT-first. It expects `NOTION_API_TOKEN` to contain
  a Personal Access Token from `notion.so/developers/tokens` and skips `ntn`
  install and version probes.
- `--ntn` opts into the internal-engineer path: auto-install `ntn` if missing
  and run `ntn login`.
- `--dev` composes with both personas. Under `--ntn`, it forwards
  `NOTION_ENV=dev` into the `ntn login` spawn. Under the PAT path, it plants a
  literal `NOTION_BASE_URL=https://api-dev.notion.com` static env entry into the
  spawned MCP environment.
- When neither `--ntn` nor `NOTION_API_TOKEN` is set but `ntn` is already
  installed, prerequisite checks may use the ntn path for backward
  compatibility. Auto-install only happens when `--ntn` is explicit.
- When neither flag nor PAT is set and `ntn` is not installed, print both
  persona paths and bail without writing config.

Auth and MCP environment:

- `preflightAndReport` routes recovery copy by auth source. PAT failures get
  PAT-specific guidance, including the difference between PAT and integration
  token shapes. `ntn` failures keep `ntn login` recovery.
- MCP children resolve auth at startup through `resolveAuth`; installers should
  not statically forward resolved bearer tokens for ntn-source operators.
- Static env entries from `buildMcpEnv()` include
  `LORE_SUPPRESS_DEPRECATIONS=1` and `LORE_CONFIG_ROOT` only for host shapes
  that may launch from an unpredictable cwd.
- Runtime forwarded env names come from
  [`src/auth/forwarded-env.ts`](../../../src/auth/forwarded-env.ts). Static entries
  are assembled by `buildMcpEnv()` in
  [`src/cli/commands/install.ts`](../../../src/cli/commands/install.ts).
- Project-scoped Yarn/PnP snippets for Claude, Codex, Cursor, and
  `--print-config --yarn-pnp` intentionally omit `LORE_CONFIG_ROOT` and rely on
  launch from the workspace root.
- Install refuses to write MCP config when vault access preflight returns
  not-found.

Assistant targets:

- Default `lore install` updates Claude Code, Codex, and Cursor for the current
  project.
- `--client claude` updates only Claude Code hooks and `.mcp.json`.
- `--client codex` updates only `.codex/config.toml` and `.codex/hooks.json`.
- `--client cursor` updates project `.cursor/mcp.json` or global
  `~/.cursor/mcp.json` with `--cursor-global`.
- Codex hooks require `features.hooks = true` and trusted projects.
- Cursor receives only an MCP entry because its runtime does not support the
  Stop/session-end hooks used by Claude Code and Codex.
- Under `--client all`, each assistant installer runs independently. The CLI
  exits non-zero with per-client failure summaries if any branch fails. Set
  `LORE_INSTALL_DEBUG=1` for stack traces.
- Default Claude and Codex installs use bin dispatch (`lore hooks ...`, or
  `yarn run -T lore hooks ...` under Yarn PnP) and do not require checked-in
  shell wrappers.

Cursor global precedence:

- `--cursor-global` overrides `--project` only for the Cursor branch.
- Under `--client all`, Claude and Codex still write project-scoped config.
- Under `--client claude` or `--client codex`, `--cursor-global` is ignored
  with a one-line stderr note and no exit-code change.

Print-config:

- `--print-config json|toml` emits paste-ready MCP config to stdout and writes
  no files.
- `--client` is accepted as a no-op. `--project` selects the config root
  embedded as `LORE_CONFIG_ROOT` for bare and legacy printed snippets.
- `--yarn-pnp` printed snippets omit static `LORE_CONFIG_ROOT` and assume the
  unsupported host launches from the workspace root.
- JSON output reuses `buildClaudeMcpEntry`; TOML output reuses
  `buildCodexMcpSection`. For the same project and Yarn/PnP shape, printed
  snippets must stay byte-identical to supported host writes.
- Preserve the byte-identity tests when changing config builder helpers. Drift
  between printed snippets and on-disk host config silently breaks unsupported
  host operators.
- The runtime path validates that `dist/mcp.js` exists and exits 1 with the
  standard build-first message if not.
- The command performs best-effort auth resolution for placeholder suppression,
  but the snippet itself must remain clean stdout for pipes such as `jq`.
- Hooks are not part of `--print-config`; unsupported hosts get MCP tools only.

Agent identity:

- Hook helpers derive the `Agent:` field through
  [`deriveAgentName`](../../../src/hooks/helpers.ts).
- Codex hook commands are prefixed with `LORE_AGENT_NAME=Codex` because Codex
  has no built-in runtime marker equivalent to Claude Code's environment.
- Third-party integrations should follow the same explicit
  `LORE_AGENT_NAME=<Name>` convention. Explicit override wins over inferred
  detection.
- Codex hook commands are POSIX shell strings. The reinstall detector recognizes
  uppercase env assignment prefixes followed by the script path:

  ```sh
  VAR=VALUE [VAR=VALUE ...] /path/to/script.sh
  ```

- Env keys must be uppercase. Values must be unquoted single tokens. Multiple
  env prefixes are allowed. Do not wrap the command in `sh -c`.
- A hook that does not match the detector's env-prefix-plus-script pattern is
  classified stale and replaced on reinstall.
- Build direct `.codex/hooks.json` entries with the same shape as
  `buildCodexHookCommand`: env prefix, then `JSON.stringify(absolutePath)` for
  the script path.
- The prefix shape targets POSIX shells on macOS and Linux.
