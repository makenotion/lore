# Lore — ntn-First Auth Internal Rollout Runbook

> Audience: Team leads at Notion rolling Lore out to their teams in
> the 0.10.0 internal-first dogfood window.
> Status: Living. Owners: _TBD — fill in before dogfood kickoff_.
> Last updated: 2026-05-01.

## Prerequisites

Each engineer needs:

- [ ] `ntn` CLI installed. Lore tests against minimum version `0.12.0`
      (`MIN_NTN_VERSION` in `src/auth/ntn.ts`) and prints a non-blocking
      warning below that tested minimum. Lore offers to install ntn
      automatically via the canonical command
      (`curl -fsSL https://ntn.dev | bash`) when missing — see the
      Auto-install section below.
- [ ] Has run `ntn login` against a workspace containing their
      team's Lore vault. Lore's `lore install` / `lore auth --login` /
      `lore init` (no-arg) offer to run `ntn login` inline if it
      hasn't been done. Lore handles the `NOTION_KEYRING=0` env
      variable automatically inside its own ntn invocations — no
      shell-rc edit required for the install path.

That's it. Two prerequisites the engineer might need to address;
both are auto-remediated by Lore when missing.

### Entities Database Cutover

Lore versions after the #272 schema contract change require every vault
page to contain five child databases: Projects, Topics, Memories,
Entities, and Facts. Older PF3-01-era vaults may already have
Projects/Topics/Memories/Facts but no Entities database. Those pages
are partial vault schemas under the new contract.

Do **not** run `lore init <page-id>` against a partial vault page.
Initialization is only for empty pages; creating a second set of
Projects/Topics/Memories/Entities/Facts under the same Notion page can
split future reads across duplicate database titles. Newer Lore builds
refuse this case, but operators upgrading manually should treat it as a
hard stop.

Manual repair for a four-database vault:

1. Open the vault page in Notion.
2. Create one child database named `Entities`.
3. Add these properties to `Entities`:
   - `Name` as the title property.
   - `Aliases` rich text.
   - `Kind` select with options: `class`, `function`, `file`,
     `workflow`, `pr`, `task-id`, `person`, `system`.
   - `Description` rich text.
   - `Project` relation to the vault's `Projects` database.
   - `Source` relation to the vault's `Memories` database.
4. Upgrade Lore and run `lore migrate`. This adds the Facts
   `SubjectEntity` / `ObjectEntity` relation columns and any other
   additive drift.
5. Run `lore migrate --build-entities --yes` in a quiet window to create
   canonical Entity rows and re-point existing Fact rows. The
   row-level `SubjectKey` fallback remains available until every row is
   backfilled.

If a vault is missing any required child database other than Entities,
stop and inspect the page manually before running any write command.
The supported repair path is to restore the missing database from backup
or recreate it with the documented schema, then run `lore migrate`.

**Vault-page sharing**: ntn-issued tokens inherit the engineer's
personal Notion permissions. If the engineer can open the vault
page in Notion's UI (because they're a member of the workspace
containing it, or someone explicitly shared it with them), their
Lore install reads the page. There is no separate "share the
vault page with the Notion Workers CLI integration" step
required.

### Auto-install via Lore

Engineers without `ntn` already installed don't need to look up
the install command. Lore detects missing ntn during
`lore install` / `lore auth --login` / `lore init` (no-arg) and
offers to install it:

```text
ntn is not installed.
Lore can install it via the canonical command:
  curl -fsSL https://ntn.dev | bash

Install ntn now? [Y/n]
```

The command is the same one ntn itself recommends (per ntn's own
self-update error message). Engineers who answer "n" get manual
install instructions and can re-run after installing. `--yes`
(on `lore install`, `lore auth --login`, `lore init`)
auto-confirms for non-interactive automation.

### Version policy

Lore's tested-against minimum is **0.12.0**. The policy:

- **If ntn is already installed**, Lore uses whatever version is
  there. No auto-upgrade.
- **If ntn is below 0.12.0**, Lore prints a non-blocking warning
  (`! 0.11.5 (below tested minimum 0.12.0)`) and proceeds.
  Operators who hit auth resolution issues run `ntn update` to
  upgrade.
- **If ntn is missing**, Lore offers to install latest via the
  canonical command above.

This policy lets engineers who pin specific ntn versions for
other tooling continue with that version; Lore degrades
gracefully if the auth.json shape doesn't match (returns "Not
authenticated" rather than crashing).

### Why `NOTION_KEYRING=0` matters (and why engineers don't have to set it)

`ntn` defaults to storing the operator's bearer token in the
macOS Keychain. Lore can't read the keychain in 0.10.0 — that
needs OS-specific code that didn't make this release
(DEFERRED-KEYCHAIN-READ). `NOTION_KEYRING=0` forces ntn to
file-mode storage at `~/.config/notion/auth.json`, which Lore
reads directly.

**This is a documented temporary coupling.** When the `ntn` CLI
team ships an official token-export command, neither the env var
nor the auth.json read will be needed (per
DEFERRED-OFFICIAL-EXPORT).

**Engineers don't need to set `NOTION_KEYRING=0` in their shell
rc** for the Lore install path. Lore's `runNtnLogin()` and
`installNtn()` (#02) force the env var inside the spawn env they
pass to ntn, so any ntn invocation Lore triggers writes to file
mode regardless of the operator's shell setup. The "seamless
onboarding" property holds.

The exception is the **direct ntn login outside Lore** gotcha —
see "Known gotcha" section below for the recovery paths
(including the shell-rc setup for engineers who want
bidirectional consistency).

## Per-team onboarding

For each team adopting Lore on ntn-first:

### Step 1 — Team lead prep

- [ ] Confirm the team's vault page exists in a workspace that
      the team's engineers belong to. Record the page id.
- [ ] Confirm the team's `.lore.yaml` is checked into the team
      repo with the right `vault.pageId`. If the team is in a
      multi-workspace setup, also set `auth.workspaceId` (in the
      team's `.lore.yaml` under `auth: workspaceId: <id>`) to
      disambiguate.
- [ ] Send the team this runbook + the line-items each engineer
      needs to do.

**No "share with integration" step.** ntn-issued tokens inherit
each engineer's personal Notion permissions. As long as the
engineer can open the vault page in Notion's UI, Lore can read it
through their token.

### Step 2 — Each engineer runs (one-time, ~2 minutes)

```bash
# 1. Update Lore (if not already on 0.10.x)
npm install -g makenotion/lore

# 2. From the team repo:
lore install
# Lore probes prerequisites:
#   - ntn installed? If no, offers to install via
#       `curl -fsSL https://ntn.dev | bash`
#     (engineer confirms with [Y/n], or pass --yes for
#      automation). Lore proceeds after install.
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

If the engineer has `LORE_NOTION_TOKEN` set in their shell rc:

```bash
# Migrate from shared token to ntn-issued
lore auth --migrate
# Verifies the legacy token reaches the vault, confirms the new
# ntn-issued token reaches the same vault, prints the unset
# instruction. Run the unset, source the rc, done.
```

### Dev-environment onboarding (Mail-style)

Engineers bootstrapping against `api-dev.notion.com` instead of prod
pass `--ntn-env dev` to `lore init`. The flag sets `NOTION_ENV` for the
spawned `ntn login`, so ntn writes `env: "dev"` into
`~/.config/notion/config.json` and the post-login auth resolution
surfaces the dev base URL automatically:

```bash
# Fresh dev onboarding (no prior ntn auth):
cd ~/Developer/Mail
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
cd ~/Developer/Mail-dev
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
| `env-lore-notion-token` | `Unset LORE_NOTION_TOKEN` (fall through to ntn) OR migrate legacy auth with `lore auth --migrate` |

### Step 3 — Verification

```bash
lore auth --whoami
# Prints: <bot identity from users.me>
# (Under ntn-first this is "Notion Workers CLI" plus possibly
# the engineer's identity if Notion exposes it via users.me —
# depends on response shape; see DEFERRED-ATTRIBUTION.)

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
| `No Notion auth configured`                                                                     | Engineer hasn't authenticated yet, OR ntn wrote the token to keychain (operator ran `ntn login` directly outside Lore without `NOTION_KEYRING=0` set) | Run `lore auth --login` — it auto-installs ntn if missing, runs `ntn login` with `NOTION_KEYRING=0` forced inside the spawn (writing to auth.json), and verifies vault access. The `NOTION_KEYRING=0` shell-rc edit is only needed for engineers who use ntn outside Lore and want their direct-ntn sessions to be Lore-readable.                                                    |
| `auth.json carries N workspaces; specify one`                                                   | Engineer is logged into multiple workspaces                                                                                                           | Set `NOTION_WORKSPACE_ID` env, OR add `auth.workspaceId` to `.lore.yaml`                                                                                                                                                                                                                                                                                                             |
| `Vault page not accessible`                                                                     | Engineer authenticated against the wrong workspace, OR the vault page isn't shared with the engineer in this workspace                                | Re-run `lore auth --login` and pick the right workspace, OR ask the team / vault owner to share the page in Notion's UI. (Direct `NOTION_KEYRING=0 ntn login` works too if you prefer the manual path; Lore's wrapper is the canonical recovery because it forces the env var and runs vault preflight.)                                                                             |
| Notion API returns 401 mid-session (assistant errors after working earlier in the same session) | ntn-issued token expired                                                                                                                              | Run `lore auth --login`. The running service re-runs auth resolution after the first 401, rebuilds its Notion client when the token or base URL changed, and retries the failed request once. Restart the assistant only if the refreshed auth is unchanged or still rejected.                                                                                                       |
| `lore auth --migrate` legacy preflight fails                                                    | Legacy `LORE_NOTION_TOKEN` doesn't reach the vault                                                                                                    | Don't unset the env var; investigate the integration sharing                                                                                                                                                                                                                                                                                                                         |
| `auth.json malformed`                                                                           | ntn version mismatch, partial write, or storage corruption                                                                                            | Run `lore auth --login` to spawn ntn login with the right env and refresh the file. (Direct `NOTION_KEYRING=0 ntn login` is the manual fallback.)                                                                                                                                                                                                                                    |
| `--ntn-env dev requested, but resolved auth points at <baseUrl>`                                | Engineer ran `lore init --ntn-env dev` but their existing ntn auth resolves to a different env                                                        | Source-aware recovery printed inline: `ntn-auth-json` → `ntn logout && NOTION_KEYRING=0 NOTION_ENV=dev ntn login`; `env-notion-api-token` → unset the token OR set `LORE_NOTION_BASE_URL`; `env-lore-notion-token` → unset/migrate the legacy token. The gate is fail-fast by design — silent prod-vault creation despite explicit dev request would be worse than re-auth friction. |

### What if `ntn` isn't installed?

`lore install` detects missing ntn and offers to install it:

```text
ntn is not installed.
Lore can install it via the canonical command:
  curl -fsSL https://ntn.dev | bash

Install ntn now? [Y/n]
```

If the engineer answers "n", Lore exits with manual-install
instructions and a `lore install` re-run pointer. If "y" (or
`--yes` was passed), Lore runs the install command, waits for it
to complete, then continues with the rest of the prerequisites
flow.

`lore auth --login` and `lore init` (no-arg) offer the same
auto-install path. Operators have three entry points to the same
auth-bootstrap behavior.

For team leads: the `--yes` flag is the no-prompt path for
scripts and automation. For interactive engineer onboarding, the
prompt-driven flow is the recommended UX — engineers see exactly
what's about to happen.

## Known gotcha: direct ntn login outside Lore

Lore-spawned ntn invocations (via `lore install`,
`lore auth --login`, `lore init` no-arg, `lore auth --migrate`)
force `NOTION_KEYRING=0` in their spawn env, so the resulting
token lands in `~/.config/notion/auth.json` where Lore can read
it. **Engineers don't need to set `NOTION_KEYRING=0` in their
shell rc for the Lore install path.**

The gotcha: if an engineer later runs `ntn login` _directly_
(outside Lore — e.g., to switch workspaces or use ntn for other
purposes) without `NOTION_KEYRING=0` in their shell, ntn falls
back to the macOS Keychain (its default). Lore can't read the
keychain in 0.10.0 (DEFERRED-KEYCHAIN-READ), so subsequent `lore`
commands fail to find a token.

Two paths back to a working state:

1. **Run `lore auth --login` again.** This re-spawns ntn login
   with `NOTION_KEYRING=0` forced; the new token writes to
   auth.json; Lore reads it.
2. **Add `export NOTION_KEYRING=0` to shell rc and re-run
   `ntn login` directly.** The token writes to auth.json
   permanently; future direct ntn invocations stay
   Lore-readable. Shell-rc commands:

   ```bash
   # zsh
   echo 'export NOTION_KEYRING=0' >> ~/.zshrc
   source ~/.zshrc

   # bash
   echo 'export NOTION_KEYRING=0' >> ~/.bashrc
   source ~/.bashrc

   # fish
   set -Ux NOTION_KEYRING 0
   ```

   Verify with `echo $NOTION_KEYRING` — should print `0`. After
   this, both Lore-spawned and direct ntn invocations write to
   auth.json, and Lore can read either.

Engineers who only run ntn through Lore never hit this gotcha.
Engineers who use ntn for other purposes (workers, page
management, etc.) and want bidirectional consistency should adopt
path 2 as a one-time setup.

## Rollback during the dogfood window

If ntn-first surfaces real issues (e.g., `auth.json` shape
changes break Lore's reader, or token expiry causes too many
mid-session breaks), the release coordinator can flip dogfood
teams back to the shared-token model.

### Recommended path: `NOTION_API_TOKEN` (rank 1, no ntn mutation)

`NOTION_API_TOKEN` is the canonical rank-1 source in #01's
priority order, ahead of ntn-resolved (rank 2). Setting it
takes precedence over the ntn auth.json without touching ntn's
private state, which keeps any other ntn-using tooling on the
operator's machine working unchanged:

```bash
# 1. Set the shared token (e.g., from 1Password) in shell rc:
export NOTION_API_TOKEN=<value-from-1Password>

# 2. New shell or source rc; verify with:
lore auth --status
# Should now show:
#   Source: NOTION_API_TOKEN (env)
#   Status: ✓ active
```

To restore ntn-first later: unset `NOTION_API_TOKEN`. ntn
resolves again on the next `lore` invocation. No file moves,
no auth.json surgery.

### Legacy fallback: `LORE_NOTION_TOKEN` + auth.json move

This path exists only for operators whose tooling already
expects the soft-deprecated `LORE_NOTION_TOKEN` env var. Prefer
`NOTION_API_TOKEN` above unless you have a concrete reason to
stay on the legacy var.

**Important:** because #01 ranks ntn (rank 2) above
`LORE_NOTION_TOKEN` (rank 3), simply setting the env var on
top of an existing ntn auth.json does NOT take precedence —
Lore continues to resolve via ntn. To fall back via the legacy
var, the operator must also rename the auth.json:

```bash
# 1. Set the legacy token in shell rc:
export LORE_NOTION_TOKEN=<value-from-1Password>

# 2. Move auth.json out of the way so ntn-resolution returns null:
mv ~/.config/notion/auth.json ~/.config/notion/auth.json.rollback

# 3. New shell or source rc; verify with:
lore auth --status
# Should now show:
#   Source: LORE_NOTION_TOKEN (env, soft-deprecated)
#   Status: ✓ active (legacy)
```

To restore ntn-first later: `mv ~/.config/notion/auth.json.rollback
~/.config/notion/auth.json` and unset `LORE_NOTION_TOKEN`. ntn
takes over again on the next `lore` invocation.

Either rollback path is purely operator-side env manipulation;
neither requires a Lore release rollback.

## Asks to the `ntn` CLI team

Lore's 0.10.0 ships against the `auth.json` read because `ntn`
0.12.0 doesn't expose a supported token-export command.
DEFERRED-OFFICIAL-EXPORT in the milestone DEFERRED.md tracks the
Lore-side migration; this section captures the asks back to the
CLI team:

### Primary ask: `ntn auth token` (export command)

Add a top-level subcommand mirroring the existing
`ntn workers oauth token` pattern:

```bash
ntn auth token --plain   # just the token (for piping)
ntn auth token --json    # structured: { workspace_id, workspace_name, token, base_url, expires_at? }
ntn auth token --eval    # `export NOTION_API_TOKEN=...` (for shell rc)
```

The `--plain` shape already exists in `ntn workers oauth token`
("Output as plain text (just the token, for piping)"). Applying
the same pattern to the workspace-bot token issued by `login` is
a small, safe addition that unblocks safe consumption by other
internal tools (Lore today; hypothetical others later).

When this ships, Lore swaps the `auth.json` reader for a
`child_process.execFile("ntn", ["auth", "token", "--json"])`
call. ~10 lines of code, zero behavior change for operators.

### Secondary ask: stable `auth.json` shape OR explicit deprecation timeline

If `ntn auth token` is more than a release away, request that the
`auth.json` shape be explicitly versioned (e.g., a top-level
`schema` field) so Lore's reader can detect format mismatches
gracefully. Without that, Lore's reader silently breaks when the
shape changes and operators see "auth.json malformed" without
knowing whether to upgrade ntn or report a bug.

### Tertiary ask: `ntn` exposes engineer identity

DEFERRED-ATTRIBUTION in the milestone tracks per-user attribution
on Lore's writes. If `ntn` exposes the authenticated engineer's
identity via env (e.g., `NOTION_USER_EMAIL`) or via the official
export command (`ntn auth token --json` returning
`owner.user.{id,email,name}`), Lore can read it for free without
calling `users.me`. Plausible but not blocking.

## Dogfood quality criteria

The release coordinator (#10) checks these off before promoting
0.10.0 from "internal dogfood" to "ready for general internal
adoption":

- [ ] At least 2 internal teams have rolled out and have been on
      ntn-first auth for at least 1 week.
- [ ] No `[lore] partial-failure` lines tied to authentication in
      the dogfood teams' stderr logs over the dogfood window.
- [ ] At least 1 engineer has confirmed the multi-workspace flow
      (`NOTION_WORKSPACE_ID` env or `auth.workspaceId` config) works
      as documented.
- [ ] At least 1 engineer has run `lore auth --migrate` from a
      legacy `LORE_NOTION_TOKEN` setup successfully.
- [ ] At least 1 engineer has hit a mid-session token expiry and
      the documented `lore auth --login` + bounded in-process retry has
      worked. If the refreshed auth is unchanged or still rejected, the
      fallback restart recovery also works.
- [ ] No regressions in the existing test surface.
- [ ] No regressions in the existing `lore status` output.

## Telemetry

For the dogfood window, optionally instrument:

- [ ] One stderr line per `resolveAuth` resolution, recording
      which source produced the token (`source: env-notion-api-token`
      / `ntn-auth-json` / `env-lore-notion-token` /
      `config-auth-token`). Gated by `LORE_DEBUG=1`. Helps the
      release coordinator see how many engineers are actually on ntn
      vs. fallbacks.

This is optional and can ship as part of #01 / #06 if the team
wants per-mode visibility during the rollout. Not a blocker.

## Hard removal of `LORE_NOTION_TOKEN`

Plausibly 0.11.0 or 1.0.0. Decision criteria:

- All internal teams have completed migration to ntn-issued
  tokens (target: 100%).
- No CI scripts in any internal repo still reference
  `LORE_NOTION_TOKEN` for anything other than service-account
  workflows (which stay on integration-token auth deliberately —
  CI is not an operator workflow).
- No production hot path still uses it.

Until those are met, the env-var path stays soft-deprecated.
