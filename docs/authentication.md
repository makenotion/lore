# Authentication

Lore reads a Notion bearer token from four sources in priority order. The first
source available wins. `resolveAuth` in `src/config.ts` is the single
resolution point for the MCP server, CLI, and hooks.

## Priority Chain

1. `NOTION_API_TOKEN` environment variable
2. ntn-resolved token from `~/.config/notion/auth.json`
3. `LORE_NOTION_TOKEN` environment variable, soft-deprecated in 0.10.0
4. `auth.token` in `.lore.yaml`, soft-deprecated in 0.10.0

## `NOTION_API_TOKEN`

This is the canonical explicit environment variable. When set, no other source
in the chain runs.

## ntn-Resolved Auth

Internal Notion engineers run:

```bash
lore install
```

`lore install` auto-installs ntn if missing, runs `ntn login` if no auth
resolves, and writes MCP config. Lore then reads
`~/.config/notion/auth.json` to select the workspace bearer token. This direct
read is a temporary coupling until ntn ships a supported token-export command.
The implementation details live in [`src/auth/AGENTS.md`](../src/auth/AGENTS.md).

ntn defaults to the macOS keychain. Lore cannot read that storage mode in
0.10.0, so Lore-managed `runNtnLogin()` and `installNtn()` calls force
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

`LORE_NOTION_TOKEN` and `auth.token` in `.lore.yaml` still work in 0.10.x, but
both are soft-deprecated and emit a debounced warning. `lore auth --migrate`
walks operators through moving to ntn-issued auth.

Hard removal is expected no earlier than 0.11.0 or 1.0.0, contingent on
telemetry showing the internal team no longer relies on the legacy paths.

`.lore.yaml` is committable only when it contains shared, non-secret config:
team-owned `vault.pageId` values, project mappings, detection rules, and hook
preferences. Do not commit `auth.token`, personal scratch vault IDs, or
personally identifying local values. Lore warns whenever `auth.token` is
present in `.lore.yaml`, even if `NOTION_API_TOKEN`, ntn auth, or
`LORE_NOTION_TOKEN` wins the priority chain.

## Rate Limits

Notion rate limits are enforced per access token, not per integration. The
0.10.0 move to ntn-issued per-user tokens prevents the old shared-token
deployment from putting every engineer into the same rate-limit bucket.

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
| `auth.json` malformed or absent                    | `loadNtnToken` in `src/auth/ntn.ts` returns null with a stderr hint; run `lore auth --login`.                                                              |
| Direct `ntn login` used keychain mode              | Re-run `lore auth --login`, or set `NOTION_KEYRING=0` before direct ntn login.                                                                             |
| Hook-spawned background save cannot read the vault | Check `spawnBackgroundSave` in `src/hooks/background.ts`; the child gets minimal env and discovers `.lore.yaml` by walking upward from the hook event cwd. |

See [`docs/internal-rollout.md`](internal-rollout.md) for the operator-facing
rollout runbook.
