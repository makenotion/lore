# Authentication

Lore reads a Notion bearer token from four sources in priority order. The first
source available wins. `resolveAuth` in `src/config.ts` is the single
resolution point for the MCP server, CLI, and hooks.

## Priority Chain

1. `NOTION_API_TOKEN` environment variable
2. ntn-resolved token from `~/.config/notion/auth.json`
3. `LORE_NOTION_TOKEN` environment variable, soft-deprecated migration fallback
4. `auth.token` in `.lore.yaml`, soft-deprecated migration fallback

## `NOTION_API_TOKEN`

This is the canonical explicit environment variable. When set, no other source
in the chain supplies the bearer token.

Lore still inspects `.lore.yaml` for `auth.token` before returning the
canonical env token. If that field is present, Lore emits the
`auth.token in .lore.yaml is soft-deprecated` warning even though
`NOTION_API_TOKEN` wins authentication. The warning is tied to removing the
unsafe field, not to which source supplied the runtime token — a local
`.lore.yaml` is still backed up, synced, and easy to paste from.

## ntn-Resolved Auth

To set up ntn-based auth, run:

```bash
lore install
```

`lore install` auto-installs ntn if missing, runs `ntn login` if no auth
resolves, and writes MCP config. Lore then reads
`~/.config/notion/auth.json` to select the workspace bearer token. The public
ntn CLI does not expose a token-export command, so the direct file read is the
contract for the `ntn login` flow rather than a temporary bridge. Operators who
want to bypass the on-disk read entirely set `NOTION_API_TOKEN` (the
highest-priority auth source). Implementation details live in
[`src/auth/AGENTS.md`](../src/auth/AGENTS.md).

ntn defaults to the macOS keychain. Lore cannot read that storage mode yet,
so Lore-managed `runNtnLogin()` and `installNtn()` calls force
`NOTION_KEYRING=0` in the spawned environment. Engineers do not need to set this
in their shell rc for the Lore install path.

If an engineer runs `ntn login` directly outside Lore, ntn may use keychain mode
and `auth.json` may not contain a readable token. Recovery:

```bash
lore auth --login
```

Alternatively, add `NOTION_KEYRING=0` to shell startup files for permanent
bidirectional consistency.

Multi-workspace operators select a workspace with `NOTION_WORKSPACE_ID` or
`auth.workspaceId` in `.lore.yaml`. Single-workspace operators auto-pick.

ntn-issued tokens inherit the engineer's personal Notion permissions. If the
engineer can open the vault page in Notion's UI, their token can read it. There
is no separate "share the vault page with Notion Workers CLI" step.

## ntn Version Policy

Lore tests against `MIN_NTN_VERSION` in `src/auth/ntn.ts`, currently `0.12.0`.

- Operators with ntn already installed keep their existing version.
- Versions below the minimum print a non-blocking warning and continue.
- Operators without ntn are offered installation via
  `curl -fsSL https://ntn.dev | bash`.
- Lore never auto-upgrades ntn.

## Legacy Sources

`LORE_NOTION_TOKEN` and `auth.token` in `.lore.yaml` remain soft-deprecated
migration fallbacks. The two warnings have asymmetric cadences because they
map to different threat models:

- `LORE_NOTION_TOKEN` warns when it is the selected source. Debounced once
  per 24-hour window per config root and silenceable via
  `LORE_SUPPRESS_DEPRECATIONS=1`. The env var is ephemeral session state
  (it dies with the shell), so a session-scoped debounce + a silence
  escape hatch is the right shape for log hygiene.
- `auth.token` in `.lore.yaml` warns whenever the field is present in the
  config, including migration-window setups where `NOTION_API_TOKEN`, ntn
  auth, or `LORE_NOTION_TOKEN` supplies the runtime token. The warning
  fires on every invocation and is **not silenceable** via
  `LORE_SUPPRESS_DEPRECATIONS=1`. `.lore.yaml` is local-only, but a token
  written there still rides every backup, sync, and editor tab; that is a
  different class of misconfiguration than an ephemeral env var. Treating
  the two with the same noise budget would hide the signal across CI runs
  and across engineers in the same worktree (issue #484). Removing the
  field is the only way to clear the warning.

Config load also rejects `auth.token` values that look like Notion bearer
tokens (`ntn_...` or `secret_...`); move those tokens to `NOTION_API_TOKEN` or
ntn auth. `lore auth --migrate` walks operators through moving to ntn-issued
auth.

Hard removal is planned for a future major release, contingent on telemetry
showing no active deployments still rely on the legacy paths.

`.lore.yaml` is local-only — keep it out of version control. Copy
`.lore.example.yaml` to `.lore.yaml` per clone, fill in your `vault.pageId`
(paste the shared team value from your onboarding docs, or let `lore init`
write it), and rely on `lore auth --login` (ntn) or `NOTION_API_TOKEN` for
credentials. Distribute shared team values (`vault.pageId`,
`auth.workspaceId`) through onboarding docs rather than by committing config.
Never put `auth.token`, personal scratch vault page IDs, or personally
identifying values in the file. Lore warns whenever `auth.token` is present in
`.lore.yaml`, even if `NOTION_API_TOKEN`, ntn auth, or `LORE_NOTION_TOKEN`
wins the priority chain, and refuses bearer-shaped `auth.token` values before
any Notion call is made.

`vault.pageId` values are not bearer secrets. They identify a Notion page, but
Notion still enforces access through the resolved token's permissions. Even
so, keeping page IDs out of git is the right default so external clones of a
public repo don't auto-target an unrelated vault. Personal scratch page IDs
and accidental maintainer-local page IDs that land in history need owner
review; decide with the page owner whether to replace the page or rewrite
history.

The Lore repo also installs a Git pre-commit guard during `npm install` to
enforce the gitignore. The guard reads the staged `.lore.yaml` from the Git
index and rejects any committed content with a pointer at
`.lore.example.yaml`. It returns silently when `.lore.yaml` is not tracked
(the steady state). Fresh checkouts with only Git's sample hooks use
`core.hooksPath=.githooks`; checkouts that already have active default
`.git/hooks` or a custom hook path get a small wrapper installed there when no
active `pre-commit` hook exists. If an active `pre-commit` hook already
exists, chain `.githooks/pre-commit` from that hook.

## Rate Limits

Notion rate limits are enforced per access token, not per integration.
Using ntn-issued per-user tokens gives every engineer an independent rate-limit
bucket; a shared integration token collapses everyone onto one bucket.

Implications:

- Do not route through a shared token for caching; that would collapse the
  isolation back into one bucket.
- The visible bot identity is `Notion Workers CLI`, not `Lore`.
- Page access follows the engineer's personal Notion permissions.

## Author Attribution

Lore resolves the default Memory `Author` lazily. Service initialization,
read-only CLI commands, and MCP startup do not call `users.me` for attribution.
Write paths that create authored Memory rows call the identity resolver only
when the caller omits an explicit `author`.

Resolution order:

1. `LORE_USER_NAME`, trimmed and used synchronously
2. `users.me().bot.owner.user.name`, cached by the active token/base URL
3. no author value, when neither source produces a trusted name

The `users.me` fallback is best-effort. Network failures, 4xx responses, and
unexpected response shapes do not block writes; Lore omits the Author property
and retries on the next unattributed write. Recognized no-owner responses are
cached for the current auth snapshot. When ntn auth refresh changes the active
token or base URL, Lore does not reuse a cached author resolved under the prior
snapshot; the next unattributed write resolves under the new snapshot.

## Troubleshooting

| Symptom                                            | Where to look                                                                                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No Notion auth configured`                        | Walk the `resolveAuth` priority chain in `src/config.ts`.                                                                                                  |
| `lore auth --status` shows multiple ntn workspaces | Set `NOTION_WORKSPACE_ID` or `auth.workspaceId` in `.lore.yaml`.                                                                                           |
| 401 mid-session                                    | Run `lore auth --login`; the client wrapper re-runs auth resolution after the first 401 and retries once when auth changes.                                |
| `auth.json` malformed or wrong root type           | `loadNtnToken` in `src/auth/ntn.ts` returns null with a stderr hint; run `lore auth --login`.                                                              |
| `auth.json` absent or empty-workspace              | Silent null fallback by design — `resolveAuth` falls through to the next priority source (`LORE_NOTION_TOKEN`, then `.lore.yaml auth.token`). If you expected ntn auth to resolve, run `lore auth --login`. |
| Direct `ntn login` used keychain mode              | Re-run `lore auth --login`, or set `NOTION_KEYRING=0` before direct ntn login.                                                                             |
| Hook-spawned background save cannot read the vault | Check `spawnBackgroundSave` in `src/hooks/background.ts`; the child gets minimal env and discovers `.lore.yaml` by walking upward from the hook event cwd. |

See [`docs/team-rollout.md`](team-rollout.md) for the operator-facing
rollout runbook.
