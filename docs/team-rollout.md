# Lore Team Onboarding Runbook

> Audience: Team leads rolling Lore out to their teams.
> Status: Current operator guidance. Historical rollout evidence is archived in
> [`docs/archive/team-rollout-0.10.0.md`](archive/team-rollout-0.10.0.md).

This runbook covers the current team onboarding path for Lore's ntn-first auth
flow, shared vault setup, and fallback auth options.

## Prerequisites

Each engineer needs **one** of the following Notion auth paths working before
the install command will write a useful config:

- **`ntn` CLI** (recommended for teams). Per-user tokens that inherit each
  engineer's personal Notion permissions, with an independent rate-limit
  bucket per engineer. Lore tests against minimum version `0.12.0`
  (`MIN_NTN_VERSION` in `src/auth/ntn.ts`) and prints a non-blocking warning
  below that tested minimum. When the ntn path is selected with
  `lore install --ntn`, `lore auth --login`, or no-arg `lore init`, Lore
  offers to install ntn automatically from a Lore-pinned release archive
  whose sha256 is embedded in Lore. The upstream `curl -fsSL
  https://ntn.dev | bash` command is printed only as a manual fallback
  when the operator declines Lore's installer.
- **`NOTION_API_TOKEN`** environment variable. External operators put a
  Notion Personal Access Token (PAT) from `notion.so/developers/tokens`
  here. PATs inherit the operator's personal Notion permissions and keep an
  independent rate-limit bucket per operator.

That's it. The ntn path is auto-remediated by Lore once an engineer selects it
with `lore install --ntn` or `lore auth --login`: missing ntn is offered for
install, and missing auth triggers a guided `ntn login`. If your team prefers
the PAT path, create one PAT per engineer, set `NOTION_API_TOKEN` in each
engineer's shell rc, and run bare `lore install`. Do not distribute a shared
`secret_` integration token from `notion.so/profile/integrations`; that
re-collapses the team into one rate-limit bucket.

### Entities Database Cutover

Current Lore versions require every vault page to contain five child
databases: Projects, Topics, Memories, Entities, and Facts. Vaults
created before the Entities database was introduced may have
Projects/Topics/Memories/Facts but no Entities database. Those pages
are partial vault schemas under the current contract.

Do **not** run `lore init <page-id>` against a partial vault page.
Initialization is only for empty pages; creating a second set of
Projects/Topics/Memories/Entities/Facts under the same Notion page can
split future reads across duplicate database titles. Newer Lore builds
refuse this case, but operators upgrading manually should treat it as a
hard stop.

Self-service repair for a four-database vault:

1. Upgrade Lore.
2. Run `lore vault ensure-entities`. This creates the `Entities` child
   database with the supported schema and runs the additive schema
   migration so Facts gains `SubjectEntity` / `ObjectEntity`.
3. Run `lore migrate --build-entities --allow-unscoped` to preview the
   vault-wide entity backfill, then run
   `lore migrate --build-entities --allow-unscoped --yes` in a quiet
   window to create canonical Entity rows and fill empty Fact entity
   relations. Use `--project <name>` instead of `--allow-unscoped` in
   both commands when repairing one project at a time. Populated
   relations are preserved, and the row-level `SubjectKey` fallback
   remains available until every row is backfilled.

`lore vault ensure-entities --dry-run` previews the bootstrap step
without writing. If a vault is missing any required child database other
than Entities, stop and inspect the page manually before running any
write command. The supported repair path is to restore the missing
database from backup or recreate it with the documented schema, then run
`lore migrate`.

**Vault-page sharing**: ntn-issued tokens and PATs inherit the
operator's personal Notion permissions. If the operator can open the
vault page in Notion's UI (because they're a member of the workspace
containing it, or someone explicitly shared it with them), Lore can
read the page through that token. There is no separate "share the
vault page with the Notion Workers CLI integration" or shared
integration-token step required.

### Auto-install via Lore

Engineers without `ntn` already installed don't need to look up
the install command. Lore detects missing ntn during
`lore install --ntn` / `lore auth --login` / `lore init` (no-arg)
and offers to install it:

```text
ntn is required for the --ntn install path.
Lore can install it using a verified release archive:
  ntn v0.13.2 from https://ntn.dev/releases/v0.13.2 (sha256 pinned by Lore)

Install ntn now? [Y/n]
```

Lore runs its bundled installer script, downloads the pinned release archive,
verifies the archive sha256 against the value embedded in Lore, extracts the
`ntn` binary, and waits for installation to complete. Engineers who answer
"n" get the upstream manual fallback and can re-run after installing:
`curl -fsSL https://ntn.dev | bash`. `--yes` auto-confirms for
non-interactive automation on `lore install --ntn`, `lore auth --login`, and
`lore init`.

### Version policy

Lore's tested-against minimum ntn version is **0.12.0**. The policy:

- **If ntn is already installed**, Lore uses whatever version is
  there. No auto-upgrade.
- **If ntn is below 0.12.0**, Lore prints a non-blocking warning
  (`! 0.11.5 (below tested minimum 0.12.0)`) and proceeds.
  Operators who hit auth resolution issues run `ntn update` to
  upgrade.
- **If ntn is missing**, Lore offers to install `NTN_INSTALL_VERSION` from
  the Lore-pinned release archive whose sha256 is embedded in Lore. The
  upstream `curl -fsSL https://ntn.dev | bash` command is printed only as a
  manual fallback.

This policy lets engineers who pin specific ntn versions for
other tooling continue with that version; Lore degrades
gracefully if the auth.json shape doesn't match (returns "Not
authenticated" rather than crashing).

### Why `NOTION_KEYRING=0` matters (and why engineers don't have to set it)

`ntn` defaults to storing the operator's bearer token in the
macOS Keychain. Lore does not read keychain-mode storage, so it
relies on `NOTION_KEYRING=0` to force ntn to file-mode storage at
`~/.config/notion/auth.json`, which Lore reads directly.

The auth reference owns the durable details for this storage contract and
the PAT fallback path; see
[`The auth.json read is the contract`](authentication.md#the-authjson-read-is-the-contract)
and [`Fallback to PAT auth`](authentication.md#fallback-to-pat-auth).

**Engineers don't need to set `NOTION_KEYRING=0` in their shell
rc** for the Lore install path. Lore's `runNtnLogin()` and
`installNtn()` force the env var inside the spawn env they
pass to ntn, so any ntn invocation Lore triggers writes to file
mode regardless of the operator's shell setup. The "seamless
onboarding" property holds.

The exception is the **direct ntn login outside Lore** gotcha —
see [`docs/authentication.md`](authentication.md#known-gotcha-direct-ntn-login-outside-lore)
for the recovery paths, including the shell-rc setup for engineers who want
bidirectional consistency.

## Per-team onboarding

For each team adopting Lore:

### Step 1 — Team lead prep

- [ ] Confirm the team's vault page exists in a workspace that
      the team's engineers belong to. Record the page id.
- [ ] Document the team's `vault.pageId` in your onboarding
      README (and `auth.workspaceId` if the team is in a
      multi-workspace setup). `.lore.yaml` is local-only; each
      engineer copies `.lore.example.yaml` to `.lore.yaml` and
      pastes the shared values during onboarding. Do not commit
      `.lore.yaml`.
- [ ] Send the team this runbook + the line-items each engineer
      needs to do.

**No "share with integration" step** for ntn-issued tokens or PATs. Both
paths inherit the operator's personal Notion permissions, so as long as the
engineer can open the vault page in Notion's UI, Lore can read it through
their token. For the `NOTION_API_TOKEN` path, create one PAT per operator at
`notion.so/developers/tokens`; do not share the vault with one `secret_`
integration and distribute that shared token.

### Step 2 — Each engineer runs (one-time, ~2 minutes)

Install Lore from public npm; no registry configuration or package token is
required:

```bash
# 1. Install Lore (if not already pinned as a devDependency in the team repo)
npm install -g @notionhq/lore

# 2. From the team repo, select the internal ntn path:
lore install --ntn
# Lore probes prerequisites:
#   - ntn installed? If no, offers to install the Lore-pinned
#     release archive (sha256 verified). If the engineer declines,
#     Lore prints the manual fallback:
#       `curl -fsSL https://ntn.dev | bash`
#     Pass --yes for automation. Lore proceeds after install.
#   - ntn version OK? Warns if below 0.12.0; proceeds.
#   - Auth resolved? If not, offers to run `ntn login` directly
#     (interactive — workspace picker, browser flow). Lore
#     handles NOTION_KEYRING=0 inside the spawn, so no shell-rc
#     edit needed. Lore proceeds after login.
# After all probes pass, Lore writes MCP config and prints:
#   Auth source:          ✓ ntn-issued (auth.json)
#   Vault page:           ✓ <title>

# Alternative entry point (just the auth, no install):
lore auth --login
# Same prerequisite probes + offer-install + offer-login flow,
# but doesn't write MCP config. Use to re-auth without
# re-installing.
```

### Dev-environment onboarding (PnP-style)

> Skip this section unless your team runs Lore against a non-prod
> Notion environment (Notion's `api-dev.notion.com`, a staging
> deployment, etc.). For standard prod onboarding, the steps above
> are complete.

Engineers bootstrapping against a non-prod Notion environment
(`api-dev.notion.com`, staging, etc.) instead of prod pass `--ntn-env dev`
to `lore init`. The flag sets `NOTION_ENV` for the spawned `ntn login`, so
ntn writes `env: "dev"` into `~/.config/notion/config.json` and the
post-login auth resolution surfaces the dev base URL automatically:

```bash
# Fresh dev onboarding (no prior ntn auth):
cd ~/Developer/widget
lore init --ntn-env dev
# Flow:
#   1. tryResolveAuth fails (no auth yet) → ntn install/login
#      recovery branch
#   2. runNtnLogin spawns with NOTION_ENV=dev — operator picks dev
#      workspace in the browser
#   3. ntn writes auth.json + config.json (env: "dev")
#   4. tryResolveAuth re-runs, returns ntn-resolved auth with
#      baseUrl=https://api-dev.notion.com
#   5. Vault page created against dev, .lore.yaml written

# Already authed against prod, but want a separate dev vault?
ntn logout
NOTION_KEYRING=0 NOTION_ENV=dev ntn login
# Or: lore init --ntn-env dev (will spawn the login with
# NOTION_KEYRING=0 forced if no auth resolves)
cd ~/Developer/widget-dev
lore init --ntn-env dev
```

#### Mismatch recovery: env-flag disagrees with resolved auth

If `--ntn-env dev` is passed but the engineer's resolved auth points at
prod (typically because they previously ran `ntn login` against prod
without `NOTION_ENV=dev`), Lore exits 1 BEFORE creating any pages:

```text
--ntn-env dev requested, but resolved auth points at (prod default — api.notion.so).
Auth source: ntn-auth-json

Recovery options:
  ntn logout && NOTION_KEYRING=0 NOTION_ENV=dev ntn login
  (then re-run lore init)
```

The fail-fast posture is deliberate: silently creating a vault in prod
despite the explicit dev request would be worse than the friction of
re-authing. The recovery copy is source-aware:

| Auth source             | Recovery copy                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------- |
| `ntn-auth-json`         | `ntn logout && NOTION_KEYRING=0 NOTION_ENV=<env> ntn login`                                       |
| `env-notion-api-token`  | `Unset NOTION_API_TOKEN` (fall through to ntn) OR `export LORE_NOTION_BASE_URL=<endpoint>`        |

### Step 3 — Verification

```bash
lore auth --whoami
# Prints: <bot identity from users.me>

lore auth --status
# Expected output includes:
#   Lore auth status for <path>/.lore.yaml
#   Source: ntn (auth.json)
#   Status: ✓ active
#   Vault page id:  <page-id>
#   ✓ Vault page accessible: <title>
```

If `lore auth --status` reports the wrong workspace, the engineer
authenticated against the wrong one — re-run `lore auth --login`
and confirm the workspace selector during the ntn flow it spawns.

### Common failures

| Symptom                                                                                         | Cause                                                                                                                                                 | Fix                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `No Notion auth configured`                                                                     | No supported token resolved, OR ntn wrote the token to keychain (operator ran `ntn login` directly outside Lore without `NOTION_KEYRING=0` set)       | Internal ntn path: run `lore auth --login` — it auto-installs ntn if missing, runs `ntn login` with `NOTION_KEYRING=0` forced inside the spawn (writing to auth.json), and verifies vault access. External PAT path: create a PAT at `notion.so/developers/tokens`, export it as `NOTION_API_TOKEN`, then rerun the command.                                                       |
| `auth.json carries N workspaces; specify one`                                                   | Engineer is logged into multiple workspaces                                                                                                           | Set `NOTION_WORKSPACE_ID` env, OR add `auth.workspaceId` to `.lore.yaml`                                                                                                                                                                                                                                                                                                             |
| `Vault page not accessible`                                                                     | The resolved token cannot read the vault page: wrong workspace, wrong page id, or the page is not shared with the token owner's Notion identity       | For ntn auth, re-run `lore auth --login` and pick the right workspace, OR ask the team / vault owner to share the page with your Notion user. For PAT auth, confirm the PAT was created in the vault workspace, confirm you can open the page in Notion's UI, export the PAT as `NOTION_API_TOKEN`, and rerun the command.                                                          |
| Notion API returns 401 mid-session (assistant errors after working earlier in the same session) | The active token expired, was revoked, or no longer has access                                                                                         | For ntn auth, run `lore auth --login`. For PAT auth, rotate the PAT at `notion.so/developers/tokens`, export the new value as `NOTION_API_TOKEN`, and rerun the command. The running service re-runs auth resolution after the first 401, rebuilds its Notion client when the token or base URL changed, and retries the failed request once. Restart the assistant only if auth is still rejected. |
| `auth.json malformed`                                                                           | ntn version mismatch, partial write, or storage corruption                                                                                            | Run `lore auth --login` to spawn ntn login with the right env and refresh the file. (Direct `NOTION_KEYRING=0 ntn login` is the manual fallback.)                                                                                                                                                                                                                                    |
| `--ntn-env dev requested, but resolved auth points at <baseUrl>`                                | Engineer ran `lore init --ntn-env dev` but their existing auth resolves to a different env                                                            | Source-aware recovery printed inline: `ntn-auth-json` → `ntn logout && NOTION_KEYRING=0 NOTION_ENV=dev ntn login`; `env-notion-api-token` → unset the token OR set `LORE_NOTION_BASE_URL`. The gate is fail-fast by design — silent prod-vault creation despite explicit dev request would be worse than re-auth friction. |

### What if `ntn` isn't installed?

`lore install --ntn` detects missing ntn and offers to install it:

```text
ntn is required for the --ntn install path.
Lore can install it using a verified release archive:
  ntn v0.13.2 from https://ntn.dev/releases/v0.13.2 (sha256 pinned by Lore)

Install ntn now? [Y/n]
```

If the engineer answers "n", Lore prints the manual fallback
`curl -fsSL https://ntn.dev | bash` and exits with a `lore install --ntn`
re-run pointer. If "y" (or `--yes` was passed), Lore runs its verified
installer, waits for it to complete, then continues with the rest of the
prerequisites flow.

`lore auth --login` and `lore init` (no-arg) offer the same
auto-install path. Operators have three ntn-selected entry points to the
same auth-bootstrap behavior.

For team leads: the `--yes` flag is the no-prompt path for
scripts and automation. For interactive engineer onboarding, the
prompt-driven flow is the recommended UX — engineers see exactly
what's about to happen.

## Auth reference

The long-lived auth contract lives in
[`docs/authentication.md`](authentication.md):

- [Known gotcha: direct ntn login outside Lore](authentication.md#known-gotcha-direct-ntn-login-outside-lore)
- [Fallback to PAT auth](authentication.md#fallback-to-pat-auth)
- [The `auth.json` read is the contract](authentication.md#the-authjson-read-is-the-contract)

## Hook setup reference

For shared-vault autosave review-inbox setup, see
[`Shared-vault hook configuration`](hooks.md#shared-vault-hook-configuration)
in the hook reference.
