# Adopting Lore on a Team

> Audience: A team lead rolling Lore out to a shared Notion vault so every
> engineer's AI assistants read and write the same memory.
>
> Last updated: 2026-05-11.

This guide walks through the operator-facing pieces of standing up Lore for a
team: prerequisites each engineer needs, the one-time per-engineer
onboarding flow, common failures, and the fallback knobs available if ntn auth
doesn't fit your environment. For the end-user quickstart, start with the
[README](../README.md); for the auth contract in full, see
[`authentication.md`](authentication.md).

## Prerequisites

Each engineer needs **one** of the following Notion auth paths working before
`lore install` will write a useful config:

- **`ntn` CLI** (recommended for teams). Per-user tokens that inherit each
  engineer's personal Notion permissions, with an independent rate-limit
  bucket per engineer. Lore tests against minimum version `0.12.0`
  (`MIN_NTN_VERSION` in `src/auth/ntn.ts`) and prints a non-blocking warning
  below that tested minimum. Lore offers to install ntn automatically via the
  canonical command (`curl -fsSL https://ntn.dev | bash`) when missing — see
  the Auto-install section below.
- **`NOTION_API_TOKEN`** environment variable. A Notion integration token
  shared with the vault page through Notion's UI. This is the simplest path
  if your team already has a Notion integration set up; the trade-off is that
  every engineer hits the same rate-limit bucket because rate limits are
  per token.

That's it. Both prerequisites are auto-remediated by Lore: missing ntn is
offered for install, missing auth triggers a guided `ntn login`. If your team
prefers the integration-token path, set `NOTION_API_TOKEN` in each engineer's
shell rc and skip the ntn flow.

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
3. Run `lore migrate --build-entities --yes` in a quiet window to create
   canonical Entity rows and re-point existing Fact rows. The
   row-level `SubjectKey` fallback remains available until every row is
   backfilled.

`lore vault ensure-entities --dry-run` previews the bootstrap step
without writing. If a vault is missing any required child database other
than Entities, stop and inspect the page manually before running any
write command. The supported repair path is to restore the missing
database from backup or recreate it with the documented schema, then run
`lore migrate`.

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

Lore's tested-against minimum ntn version is **0.12.0**. The policy:

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
macOS Keychain. Lore does not read keychain-mode storage, so it
relies on `NOTION_KEYRING=0` to force ntn to file-mode storage at
`~/.config/notion/auth.json`, which Lore reads directly.

The public `ntn` CLI does not expose a token-export command, so
the `NOTION_KEYRING=0` + `auth.json` read pair is the contract
rather than a temporary bridge. Operators who'd rather not rely on
the on-disk read can export `NOTION_API_TOKEN` directly (the
highest-priority auth source); ntn itself reads the same env var,
so the keychain default is bypassed end-to-end.

**Engineers don't need to set `NOTION_KEYRING=0` in their shell
rc** for the Lore install path. Lore's `runNtnLogin()` and
`installNtn()` force the env var inside the spawn env they
pass to ntn, so any ntn invocation Lore triggers writes to file
mode regardless of the operator's shell setup. The "seamless
onboarding" property holds.

The exception is the **direct ntn login outside Lore** gotcha —
see "Known gotcha" section below for the recovery paths
(including the shell-rc setup for engineers who want
bidirectional consistency).

## Per-team onboarding

For each team adopting Lore:

### Step 1 — Team lead prep

- [ ] Confirm the team's vault page exists in a workspace that
      the team's engineers belong to. Record the page id.
- [ ] Confirm the team's `.lore.yaml` is checked into the team
      repo with the right `vault.pageId`. If the team is in a
      multi-workspace setup, also set `auth.workspaceId` (in the
      team's `.lore.yaml` under `auth: workspaceId: <id>`) to
      disambiguate.
- [ ] Send the team this guide + the line-items each engineer
      needs to do.

**No "share with integration" step** when using ntn-issued tokens.
ntn-issued tokens inherit each engineer's personal Notion permissions, so
as long as the engineer can open the vault page in Notion's UI, Lore can
read it through their token. The `NOTION_API_TOKEN` path is different —
share the page with the integration in Notion's UI before any engineer
runs `lore install`.

### Step 2 — Each engineer runs (one-time, ~2 minutes)

> **Pending first public publish.** `npm install -g @makenotion/lore` below
> currently returns `E404` from `registry.npmjs.org` — the publish workflow
> was retargeted to public npm in
> [#561](https://github.com/makenotion/lore/pull/561) but the first release
> tag has not been cut yet (tracked in
> [#569](https://github.com/makenotion/lore/issues/569)). Until that lands,
> install from a local clone instead:
>
> ```bash
> git clone https://github.com/makenotion/lore.git
> cd lore && npm install && npm run build && npm link
> ```
>
> The post-publish steps below will work as-is once first publish succeeds.

```bash
# 1. Install Lore (if not already pinned as a devDependency in the team repo)
npm install -g @makenotion/lore

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
# Migrate from a legacy shared token to ntn-issued
lore auth --migrate
# Verifies the legacy token reaches the vault, confirms the new
# ntn-issued token reaches the same vault, prints the unset
# instruction. Run the unset, source the rc, done.
```

### Dev-environment onboarding

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
cd <your repo>
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
cd <your dev repo>
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
back to the macOS Keychain (its default). Lore doesn't read
keychain-mode storage, so subsequent `lore` commands fail to find
a token.

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

## Falling back to a shared integration token

If ntn-first surfaces real issues for your team — `auth.json` shape
mismatches break Lore's reader, frequent mid-session token expiry, or
your team's existing tooling depends on a shared integration token —
you can fall back to `NOTION_API_TOKEN` per engineer with no Lore-side
changes.

### Recommended path: `NOTION_API_TOKEN` (highest-priority source, no ntn mutation)

`NOTION_API_TOKEN` is the highest-priority source in Lore's auth
priority chain, ahead of ntn-resolved auth. Setting it takes
precedence over the ntn `auth.json` without touching ntn's private
state, which keeps any other ntn-using tooling on the operator's
machine working unchanged:

```bash
# 1. Set the shared integration token (e.g., from a secret manager) in shell rc:
export NOTION_API_TOKEN=<value-from-secret-manager>

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

**Important:** because Lore ranks ntn-resolved auth ahead of
`LORE_NOTION_TOKEN`, simply setting the env var on top of an
existing ntn `auth.json` does NOT take precedence — Lore
continues to resolve via ntn. To fall back via the legacy var,
the operator must also rename the auth.json:

```bash
# 1. Set the legacy token in shell rc:
export LORE_NOTION_TOKEN=<value-from-secret-manager>

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

Either fallback path is purely operator-side env manipulation;
neither requires a Lore release rollback.

## The `auth.json` read is the contract

The public [`ntn` CLI](https://github.com/makenotion/skills) exposes
only `ntn login` / `ntn logout` for the auth lifecycle and
`NOTION_API_TOKEN` for injection — no token-export subcommand exists,
and the maintainers have indicated none will ship. Earlier Lore
releases framed the `~/.config/notion/auth.json` read as a "temporary
coupling pending an official export command"; that framing is
superseded.

Lore therefore treats the `auth.json` read as the contract for the
`ntn login` flow, not a bridge to anything. Operators who'd rather not
rely on the on-disk read can export `NOTION_API_TOKEN`
(highest-priority source), which `ntn` itself reads as well.

Open follow-ups that would still benefit Lore if the ntn maintainers
take them on later — kept here as a reference rather than a blocking
ask:

- **Stable `auth.json` shape**: if the format ever changes, an
  explicit schema marker (e.g. a top-level `schema` field) lets the
  reader detect mismatches and surface an upgrade hint instead of
  failing as "malformed".
- **Engineer-identity exposure**: per-user attribution on saved
  memories currently requires Lore to round-trip `users.me` against
  the active token. An env handoff like `NOTION_USER_EMAIL` from
  `ntn login` would save the round-trip.

## Shared-vault hook configuration

> Origin: [issue #281](https://github.com/makenotion/lore/issues/281)
> (closed; live behavior documented in
> [`memory-workflows.md`](memory-workflows.md)).

For shared-vault deployments where many engineers share a single Lore
workspace, set `hooks.proposeAutosaveLearnings: true` in `.lore.yaml`.
This routes every auto-extracted learning through the proposed-memory
review inbox (`Status = proposed`) instead of writing it directly to
accepted recall. The trust boundary keeps a noisy session from
polluting recall for everyone before a human reviewer approves the
learning. Reviewers act on the inbox via `lore inbox list` /
`lore inbox approve <id>` / `lore inbox reject <id>` /
`lore inbox archive <id>` (CLI), or `lore-memory action='approve'` /
`lore-memory action='reject'` (MCP); both surfaces share the same
`MemoryService.recordReview` service path and append a
`## Reviewed (YYYY-MM-DD)` audit block with the reviewer + timestamp.
Both terminal verdicts drop the row out of the proposed-memory
inbox: `approve` makes it eligible for default recall, `reject`
keeps it off default recall (the
`reviewTerminalStatusExclusionFilters` default-exclude on
`MemoryService.list` / `search` / `queryStaleConfidence` covers
both `proposed` and `rejected`), so neither verdict pollutes
shared recall with noisy auto-extractions. The inbox
depth also surfaces in `lore status`'s **Proposed memories** line
and the wake-up **Proposed Memories** section.

Single-engineer / personal-vault deployments can leave the flag at
its `false` default — the inbox surface still exists if the engineer
manually saves with `status: "proposed"`, but autosave-learning
saves go straight into recall.

See [`hooks.md`](hooks.md) for the reference of the underlying
`learningExtraction` / `proposeAutosaveLearnings` knobs.
