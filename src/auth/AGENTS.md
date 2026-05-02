# AGENTS.md -- src/auth/

> Read the root `AGENTS.md` first. This file covers the auth layer.

## Purpose

This directory implements Lore's authentication resolution. Under
0.10.0 the auth model is **ntn-first**: every internal Notion engineer
authenticates via the `ntn` CLI (`ntn login`), and Lore reads the
resulting bearer token. Legacy paths (`LORE_NOTION_TOKEN`,
`auth.token` in `.lore.yaml`) remain as soft-deprecated fallbacks per
the priority chain in the root **Authentication** section.

`resolveAuth` itself lives in `src/config.ts` — it is the single
resolution point for every interface. This directory carries the
resolution-mode-specific helpers `resolveAuth` calls into.

## Files

| File          | Responsibility                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oauth.ts`    | Two roles: legacy OAuth helpers from 0.9.x (`runOAuthFlow`, `loadCredentials`, `getAuthorizationUrl`, `exchangeCode`, `getBaseUrl`) for the BYO-integration rollback path; AND the new `verifyVaultAccess` post-resolution preflight (#03). OAuth-flow primitives are no longer the canonical auth path under ntn-first; they remain reachable for legacy operators in 0.10.0 and removal is plausibly 1.0.0 contingent on telemetry. The filename reflects historical content; renaming is a separate cleanup.                                                                                                                  |
| `ntn.ts`      | ntn integration module (#02). `loadNtnToken` reads `~/.config/notion/auth.json` for token resolution; `runNtnLogin` shells out to `ntn login` interactively; `installNtn` auto-installs via `curl -fsSL https://ntn.dev \| bash`; `getNtnVersion` / `checkNtnVersion` report the installed version. Exports `MIN_NTN_VERSION` and `NTN_INSTALL_COMMAND`.                                                                                                                                                                                                                                                                         |
| `identity.ts` | Engineer-identity resolver for the per-user attribution path (DEFERRED-ATTRIBUTION). `resolveAuthorIdentity(client)` is memoized per-process: `LORE_USER_NAME` env override (synchronous, wins) → `users.me().bot.owner.user.name` fallback → `null`. Failures collapse to `{ author: null }` and never throw — the Author column is advisory; an unattributed memory beats a save that fails because identity resolution hit a transient blip. Public surface is `resolveAuthorIdentity` + `resetIdentityCache` (tests); the JSON-shape walker is private (tests reach every failure-mode branch via mocked `client.users.me`). |

## Identity resolution vs. `renderWhoamiIdentity` — deliberate divergence

`src/cli/commands/auth.ts:renderWhoamiIdentity` walks the same
`users.me` shape with three fallbacks: `bot.owner.user.name` →
`bot.owner.user.id` → `<bot in <workspace_name>>`.
`src/auth/identity.ts:resolveAuthorIdentity` (via its private
JSON walker) walks ONLY the first (`bot.owner.user.name`) and
returns `null` when missing.

The divergence is intentional and load-bearing:

- **`renderWhoamiIdentity`** drives `lore auth --whoami`, a CLI
  diagnostic where the operator wants _some_ identity string back —
  even the bot's workspace label is more useful than `<unknown>` in
  that surface. Falling back through the three layers is correct
  there because the consumer is a human reading the output.
- **`resolveAuthorIdentity`** drives the `Author` Memory column. The
  column is per-engineer attribution; falling back to the bot owner
  user id would stamp every row with an opaque UUID, and falling back
  to `bot.workspace_name` would re-fragment
  attribution to per-team granularity (the same workspace label
  every engineer in the team would resolve). Returning `null`
  preserves the empty-Author signal so an operator can fix the
  resolution path (export `LORE_USER_NAME`) rather than discover
  they've been writing UUIDs into a column meant for human bylines.

A future engineer reconciling the two paths should NOT make them
match — the difference is the contract.

## The auth.json read is a temporary coupling

`src/auth/ntn.ts` reads ntn's private storage at
`~/.config/notion/auth.json`. **This is a deliberate bridge until
`ntn` ships a supported token-export command.** The expected shape is
`ntn auth token --plain` or equivalent. Every read site in this
directory carries a `// TODO(ntn-export):` comment pointing at
DEFERRED-OFFICIAL-EXPORT in the milestone DEFERRED.md.

When the supported command lands, `loadNtnToken`'s body changes to a
`child_process.execFile` call. The function signature stays the
same; consumers in `src/config.ts:resolveAuth` are unchanged. The
swap is ~10 lines of code.

## ntn version policy

`MIN_NTN_VERSION` is the tested-against floor. Bump only when:

- A new ntn version ships an `auth.json` shape change Lore needs to
  handle (read-shape compatibility), OR
- DEFERRED-OFFICIAL-EXPORT lands and Lore prefers the supported ntn
  token-export command (consume-shape compatibility).

Lore prefers the operator's existing ntn install. The CLI never
auto-upgrades; `checkNtnVersion()` returns `"too-old"`
informationally; consumers (`lore auth --login`, `lore install`)
print a non-blocking warning suggesting `ntn update` but proceed.
Auto-install is offered only when ntn is missing entirely; the
install command is the constant `NTN_INSTALL_COMMAND`
(`curl -fsSL https://ntn.dev | bash`) sourced from ntn's own
self-update error message.

## Shell-out helpers

Two helpers wrap interactive ntn invocations:

- `runNtnLogin()` — spawns `ntn login` with inherited stdio and forces
  `NOTION_KEYRING=0` in the child env. The operator interacts with ntn's
  prompts directly; Lore captures the exit code only. Engineers don't
  need the env var in their shell rc for the Lore install path. Without
  the forced env, ntn defaults to the macOS keychain on darwin and
  `auth.json` never gets written.
- `installNtn()` — runs `NTN_INSTALL_COMMAND` via shell with
  `stdio: "inherit"`, also setting `NOTION_KEYRING=0` for parity.
  Operator must explicitly confirm before this is called (via the
  consumer's prompt) — never curl-pipe-bash without explicit consent.

Both return discriminated outcomes: `success`, `exit-non-zero`, or
`spawn-error`. Consumers route differently on each failure mode.

## Vault preflight

`verifyVaultAccess(client, vaultPageId)` is the post-resolution
sanity check that catches the most common authentication mistake:
operator authenticated against the wrong workspace, OR the vault
page isn't shared with the engineer (their Notion identity) in this
workspace. Under ntn-first auth, tokens inherit the engineer's
personal permissions; "page not shared" means the engineer can't
open the page in Notion's UI either.

Returns a discriminated `VaultAccessResult` so the caller can route
"valid token, wrong page" differently from "valid token, right
page" differently from "transient 5xx." Used by `lore install`,
`lore init`, `lore auth --status` (default-on; the diagnostic
value of the round-trip outweighs the ~one-call cost since
operators run `--status` rarely — a `--no-verify` opt-out is a
plausible follow-up if telemetry surfaces friction), and auth
migration's post-flow verify.

## Things that don't live here

- The CLI surface for `lore auth` lives in
  `src/cli/commands/auth.ts`.
- The token resolver `resolveAuth` and `resolveToken` live in
  `src/config.ts` (the resolution point; this directory provides
  the per-source helpers it calls).
- The hook-spawn auth handoff lives in
  `src/hooks/background.ts` (the spawned `claude -p` re-runs the
  same `resolveAuth` from `event.cwd` and locates `.lore.yaml` via
  upward search; no `LORE_CONFIG_ROOT` is forwarded — see
  `src/hooks/AGENTS.md` for the env-passthrough details).
- The OAuth + PKCE / broker work parked at
  `../../oauth-pkce-epic/` (in the issue tracker repo, not the
  source tree). When external rollout becomes a real goal, that
  epic is the path; this directory's `oauth.ts` is a misnomer
  until then.
- The operator-facing onboarding flow (per-engineer `lore install`,
  per-team rollout, the direct-ntn-outside-Lore gotcha + recovery,
  migration script for legacy operators) lives in the
  [internal-rollout runbook](../../docs/internal-rollout.md).
  This file is for contributors working on the auth layer; the
  runbook is for operators rolling Lore out to teams.

## Domain choice

Lore uses `https://api.notion.so` as the default Notion API base
(see `getBaseUrl` in `oauth.ts`). Notion is migrating public
surfaces from `.so` to `.com`; both resolve. ntn's per-environment
defaults are: prod = `api.notion.so`; dev = `api-dev.notion.com`.
Operators on dev / staging set `LORE_NOTION_BASE_URL` per the
existing convention.

## ntn env ↔ URL mapping is centralized in `oauth.ts`

`oauth.ts` exports the **single canonical pair** every Lore-managed
ntn login surface (`lore auth --login`, `lore auth --migrate`,
`lore install`, `lore init`) consults for env ↔ URL conversion:

- `ntnEnvBaseUrl(env)` — env (`prod` / `dev` / `stg`) → canonical URL.
- `ntnEnvFromBaseUrl(url)` — URL → env. Recognizes
  `NTN_ENV_BASE_URLS` plus the aliases in
  `NTN_ENV_BASE_URL_ALIASES` (currently `https://api.notion.com` →
  `prod`, since Notion is migrating public surfaces from `.so` to
  `.com`).

**Do NOT add a new env-mapping table elsewhere.** The 0.10.0 milestone
shipped four PRs (#176 / #178 / #179 / #180) that each rolled their
own duplicate map; they disagreed on edge cases (notably the `.com`
prod alias) and were collapsed in followup #13. Future contributors
who need a URL ↔ env conversion in any new surface MUST import from
`oauth.ts`. New canonical URLs (Notion shipping a new env, retiring
an old one, adding another `.com` alias) land in `NTN_ENV_BASE_URLS`
or `NTN_ENV_BASE_URL_ALIASES` and propagate to every consumer
automatically.

One caller wraps the canonical helper to apply call-site-specific
semantics — this wrapper is intentional, NOT a duplicate table:

- `init.ts:authBaseUrlMatchesEnv` adds the `undefined → prod` rule
  (ntn-source auth pointing at prod returns `baseUrl: undefined`;
  forcing the explicit URL would diverge the in-memory shape from
  ntn's on-disk `config.json` shape). Defined-baseUrl matches go
  through `ntnEnvFromBaseUrl`.

`auth.ts:envNameBaseUrl` (used by migrate's `resolveNtnEnvBaseUrl` /
`resolveLoginTargetBaseUrl`) is a pure delegation to `ntnEnvBaseUrl`
with no prod-special-case — explicit `NOTION_ENV=prod` returns the
canonical prod URL, NOT `undefined`. **Do not reintroduce a shortcut
that collapses prod to `undefined` here**: that lets a
stale `auth.baseUrl: <dev URL>` win over an explicit
`NOTION_ENV=prod` via `computeNtnLoginEnvOverride`'s
`resolveNtnEnvBaseUrl(env) ?? configBaseUrl` fallback (round-7
review's blocking finding #1). The "no override needed for prod"
normalization happens at the spawn boundary in
`computeNtnLoginEnvOverride`: when migrate's target equals ntn
login's native target, no override is forwarded; ntn login then
defaults to prod.
