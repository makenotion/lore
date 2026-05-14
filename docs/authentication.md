# Authentication

Lore is a Notion-backed memory system. Every interaction with Notion (read,
write, vault preflight, hooks, MCP) requires a bearer token. This document is
organized by who you are, because that determines which token you should use.

- **Are you an internal Notion engineer?** Use `ntn`. See
  [Internal Notion engineers (`ntn`)](#internal-notion-engineers-ntn).
- **Are you an external operator?** Create a Personal Access Token (PAT) and
  paste it into `NOTION_API_TOKEN`. See
  [External operators (PAT)](#external-operators-pat).

If you don't know which you are, the short answer is: if you have access to
Notion's internal monorepo and the `ntn` CLI, you're internal. Otherwise
you're external.

New operators adopting Lore on a team should start at
[`docs/team-rollout.md`](team-rollout.md), which covers per-engineer onboarding,
the Entities-database cutover, the direct-`ntn login` keychain gotcha and
its recovery, and shared-vault hook configuration. This document is the
reference for the auth contract itself.

Below the persona walkthroughs, the [Priority chain](#priority-chain) section
documents the two-source resolver for reference — operators rarely need to
consult it.

## What is a PAT?

A Notion Personal Access Token (PAT) is a bearer token issued to a specific
human operator, scoped to that operator's personal Notion permissions and
rate-limited per-user. You create one at:

<https://www.notion.so/developers/tokens>

**Do not confuse this with <https://www.notion.so/profile/integrations>.**
That surface issues *integration tokens* (the `secret_…` shape). Integration
tokens look like bearer tokens on the wire and the API accepts them, but
they are **integration-level rate-limited** — every engineer on a team that
shares one integration is in the same rate-limit bucket. This is exactly the
shared-token deployment the 0.10.0 ntn-first move existed to escape; reusing
it via a `notion.so/profile/integrations` token re-collapses Lore into one
bucket. **Use a PAT from `developers/tokens`, not an integration token from
`profile/integrations`.**

On the wire a PAT is indistinguishable from an `ntn`-issued bot token: same
`ntn_` / `development_ntn_` prefix, same `users.me` response shape (the
walker at `src/auth/identity.ts` reads `bot.owner.user.name` unchanged), same
per-user rate-limit semantics. The only operator-visible difference is the
integration identity:

- `ntn`-issued tokens: identity is `Notion Workers CLI`.
- PATs: identity is whatever name the operator gave the token at creation
  time (visible at `developers/tokens`).

`lore auth --whoami` prints the token-prefix classification alongside the
identity so operators can confirm at a glance which kind of token Lore
resolved.

## Internal Notion engineers (`ntn`)

Internal engineers run:

```bash
lore install --ntn
```

The `--ntn` flag selects the internal-engineer path: Lore auto-installs
`ntn` if missing, runs `ntn login` (forcing `NOTION_KEYRING=0` in the spawn
so the token lands in `~/.config/notion/auth.json` where Lore can read it),
and writes MCP config for the installed assistant hosts. Lore resolves the
bearer token at runtime by reading `auth.json`.

For dev-environment vaults, compose with `--dev`:

```bash
lore install --ntn --dev
```

The flag forwards `NOTION_ENV=dev` into the `ntn login` spawn so the issued
token authorizes against the dev deployment.

The direct `auth.json` read is the contract for the `ntn login` flow. The
public `ntn` CLI (`github.com/makenotion/skills`) does not expose a
token-export subcommand, and the maintainers have indicated none will ship —
see [`src/auth/AGENTS.md`](../src/auth/AGENTS.md) for the contract details
and degradation rules.

`ntn` defaults to the macOS keychain. Lore cannot read keychain-stored
tokens in 0.10.x, so Lore-managed `runNtnLogin()` and `installNtn()` force
`NOTION_KEYRING=0`. Engineers do not need to set this in their shell rc for
the Lore install path. If an engineer runs `ntn login` directly outside
Lore and `auth.json` ends up empty (keychain mode), recover with:

```bash
lore auth --login
```

or persist `NOTION_KEYRING=0` to a shell startup file for bidirectional
consistency.

Multi-workspace operators select a workspace with `NOTION_WORKSPACE_ID` or
`auth.workspaceId` in `.lore.yaml`. Single-workspace operators auto-pick.

`ntn`-issued tokens inherit the engineer's personal Notion permissions: if
you can open the vault page in Notion's UI, your token can read it. There
is no "share this vault page with Notion Workers CLI" step.

### `ntn` version policy

Lore tests against `MIN_NTN_VERSION` in `src/auth/ntn.ts`, currently
`0.12.0`.

- Operators with `ntn` already installed keep their existing version.
- Versions below the minimum print a non-blocking warning and continue.
- Operators without `ntn` are offered installation via
  `curl -fsSL https://ntn.dev | bash`.
- Lore never auto-upgrades `ntn`.

## External operators (PAT)

External operators create a PAT and paste it into `NOTION_API_TOKEN`. Step
by step:

1. Open <https://www.notion.so/developers/tokens> in your browser.
2. Click **New token**, give it a descriptive name (the name becomes the
   integration identity that shows up on Notion pages your token edits),
   and pick the workspace and pages it should access.
3. Copy the token (starts with `ntn_`; dev-environment tokens start with
   `development_ntn_`).
4. Export it in your shell:

   ```bash
   export NOTION_API_TOKEN="ntn_..."
   ```

   Add the export to your shell rc (`~/.zshrc`, `~/.bashrc`, etc.) so it
   persists across sessions.

5. Run `lore install` from the project directory. The default install path
   does not require `ntn`; Lore detects `NOTION_API_TOKEN`, runs the vault
   preflight, and writes MCP config.

6. Confirm with `lore auth --whoami`. Output should resemble:

   ```text
   <Your Notion name>  (personal token — ntn_)
   ```

   If you see `(integration token — secret_)` instead, you pasted an
   integration token from `notion.so/profile/integrations` rather than a
   PAT from `notion.so/developers/tokens`. See
   [Rate limits](#rate-limits) for why that matters; rotate to a real PAT.

For dev-environment PATs (created on Notion's dev deployment, prefix
`development_ntn_`), run install with `--dev`:

```bash
lore install --dev
```

The flag surfaces dev-PAT guidance and configures the MCP environment so
Lore's API calls target the dev base URL.

**Do NOT paste your PAT into `auth.token` in `.lore.yaml`.** That file is
local config that can still be accidentally backed up, synced, or staged;
pasting a bearer token there will:

- Land the secret in git history on the next commit.
- Trigger Lore's config schema, which rejects every `auth.token` value before
  resolving auth.
- Trigger the pre-commit hook (installed by `npm install`) which blocks
  commits adding `auth.token`.

The right home for a PAT is `NOTION_API_TOKEN` in your shell environment.

## Priority chain

`resolveAuth` in `src/config.ts` is the single resolution point for the MCP
server, CLI, and hooks. The chain (highest priority first):

1. `NOTION_API_TOKEN` environment variable (PATs land here).
2. `ntn`-resolved token from `~/.config/notion/auth.json`.

The first source available wins. The chain does not need a new source for
PAT support: PATs are bearer tokens in `NOTION_API_TOKEN`, which has always
been priority 1.

### `NOTION_API_TOKEN`

This is the canonical explicit environment variable. When set, no other
source supplies the bearer token. Both PATs (`ntn_…` / `development_ntn_…`)
and integration tokens (`secret_…`) are accepted on the wire; `lore auth
--whoami` surfaces the prefix classification so you can spot a wrong-token
paste.

`LORE_NOTION_TOKEN` is no longer read. If it is still set in your shell,
move that value to `NOTION_API_TOKEN` only if it is a Personal Access
Token. Integration tokens from `notion.so/profile/integrations` should be
rotated to PATs from `notion.so/developers/tokens`.

`auth.token` in `.lore.yaml` is rejected at config-load time for every
value. Move credentials to `NOTION_API_TOKEN` or `lore auth --login`, then
remove the field from `.lore.yaml`.

### `.lore.yaml` is local-only

`.lore.yaml` is local-only — keep it out of version control. Copy
`.lore.example.yaml` to `.lore.yaml` per clone, fill in your `vault.pageId`
(paste the shared team value from your onboarding docs, or let `lore init`
write it), and rely on `NOTION_API_TOKEN` (external operators, PAT) or
`lore auth --login` (internal engineers, ntn) for credentials. Distribute
shared team values (`vault.pageId`, `auth.workspaceId`) through onboarding
docs rather than by committing config. Never put `auth.token`, personal
scratch vault page IDs, or personally identifying values in the file.
Lore rejects any `auth.token` value before any Notion call is made.

`vault.pageId` values are not bearer secrets. They identify a Notion page,
but Notion still enforces access through the resolved token's permissions.
Even so, keeping page IDs out of git is the right default so external
clones of a public repo don't auto-target an unrelated vault. Personal
scratch page IDs and accidentally committed private page IDs that land in
history need owner review; decide with the page owner whether to replace
the page or rewrite history.

The Lore repo also installs a Git pre-commit guard during `npm install`
to enforce the gitignore. The guard reads the staged `.lore.yaml` from
the Git index and rejects any committed content with a pointer at
`.lore.example.yaml`. It returns silently when `.lore.yaml` is not
tracked (the steady state). Fresh checkouts with only Git's sample hooks
use `core.hooksPath=.githooks`; checkouts that already have active
default `.git/hooks` or a custom hook path get a small wrapper installed
there when no active `pre-commit` hook exists. If an active `pre-commit`
hook already exists, chain `.githooks/pre-commit` from that hook.

## Rate limits

Notion enforces rate limits **per access token**, not per integration. The
practical consequences:

- **PATs and `ntn`-issued tokens are per-user.** Each operator has their
  own bucket; one operator burning their bucket does not throttle the
  team. This is the isolation property the 0.10.0 ntn-first move was
  designed to buy, and PATs preserve it for external operators.
- **Integration tokens from `notion.so/profile/integrations` are
  per-integration.** Every operator routing through the same integration
  shares one bucket. A team that distributes one integration token to
  every engineer re-collapses Lore into a single rate-limit bucket — the
  exact deployment the 0.10.0 move existed to escape. **This is the
  headline risk for external operators picking the wrong token type.**

Operational implications:

- Do not route Lore through a shared token for caching; that collapses the
  isolation back into one bucket.
- The visible integration identity differs by source:
  - `ntn`-issued tokens: identity is `Notion Workers CLI`.
  - PATs: identity is whatever the operator named the token (visible at
    `notion.so/developers/tokens`).
  - `secret_` integration tokens: identity is the integration name from
    `notion.so/profile/integrations` — and **the rate-limit bucket is
    shared with every other user of that integration**.
- Page access follows the resolved token's permissions (for PATs and
  `ntn`-issued, that is the operator's personal Notion permissions; for
  integration tokens, the pages explicitly shared with the integration).

## Author attribution

Lore resolves the default Memory `Author` lazily. Service initialization,
read-only CLI commands, and MCP startup do not call `users.me` for
attribution. Write paths that create authored Memory rows call the
identity resolver only when the caller omits an explicit `author`.

Resolution order:

1. `LORE_USER_NAME`, trimmed and used synchronously.
2. `users.me().bot.owner.user.name`, cached by the active token / base URL.
3. No author value, when neither source produces a trusted name.

The `users.me` fallback is best-effort. Network failures, 4xx responses,
and unexpected response shapes do not block writes; Lore omits the Author
property and retries on the next unattributed write. Recognized no-owner
responses are cached for the current auth snapshot. When `ntn` auth
refresh changes the active token or base URL, Lore does not reuse a
cached author resolved under the prior snapshot; the next unattributed
write resolves under the new snapshot.

The walker is bytes-identical for PATs and `ntn`-issued tokens: both
populate `bot.owner.user.name` on `users.me`.

## Troubleshooting

| Symptom                                            | Where to look                                                                                                                                              |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No Notion auth configured`                        | Walk the `resolveAuth` priority chain in `src/config.ts`.                                                                                                  |
| `lore auth --whoami` shows `(integration token — secret_)` | You pasted an integration token from `notion.so/profile/integrations`. Rotate to a PAT from `notion.so/developers/tokens` to escape the shared bucket. |
| `lore auth --status` shows multiple `ntn` workspaces | Set `NOTION_WORKSPACE_ID` or `auth.workspaceId` in `.lore.yaml`.                                                                                           |
| 401 mid-session                                    | Run `lore auth --login` (internal) or rotate your PAT (external); the client wrapper re-runs auth resolution after the first 401 and retries once when auth changes. |
| `auth.json` malformed or wrong root type           | `loadNtnToken` in `src/auth/ntn.ts` returns null with a stderr hint; run `lore auth --login`.                                                              |
| `auth.json` absent or empty-workspace              | Silent null fallback by design — `resolveAuth` falls through to the unsupported-auth diagnostic. If you expected `ntn` auth to resolve, run `lore auth --login`. |
| Direct `ntn login` used keychain mode              | Re-run `lore auth --login`, or set `NOTION_KEYRING=0` before direct `ntn login`.                                                                           |
| Hook-spawned background save cannot read the vault | Check `spawnBackgroundSave` in `src/hooks/background.ts`; the child gets minimal env and discovers `.lore.yaml` by walking upward from the hook event cwd. |

See [`docs/team-rollout.md`](team-rollout.md) for the operator-facing
rollout runbook (internal-engineer + external-operator personas both
covered).
