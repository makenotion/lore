# The `auth` Command

[Back to CLI command contracts](../../cli-command-contracts.md).

`lore auth --login` is the recommended interactive re-authentication entry
point. It auto-installs `ntn` if needed, shells out to `ntn login` with
`NOTION_KEYRING=0` forced inside the spawn, and runs vault access preflight
after login. New operators usually hit this flow through `lore install`; direct
use is for re-authentication and setup repair.

Other subcommands:

- `--status` reports `ntn` install state, active workspace, token source, and
  vault access. It performs a Notion round-trip and intentionally bypasses
  `initServices()` so it can diagnose auth before the full service graph loads.
- `--whoami` resolves the active token, calls `users.me`, and prints the bot
  identity. Use it to confirm the token belongs to the expected workspace.
- `--logout` directs operators to `ntn logout`. Lore does not own `ntn` token
  storage and should not pretend it can revoke that token itself.

`-y, --yes` skips confirmation prompts on `--login` for non-interactive
automation. `loadNtnToken` in [`src/auth/ntn.ts`](../../../src/auth/ntn.ts) reads
`~/.config/notion/auth.json`; workspace selection respects
`NOTION_WORKSPACE_ID` or `auth.workspaceId` in `.lore.yaml` when `auth.json`
contains multiple workspaces.

The root [`AGENTS.md`](../../../AGENTS.md) Authentication section and
[`authentication.md`](../../authentication.md) define the source priority chain.
