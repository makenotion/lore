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

| File | Responsibility |
|------|---------------|
| `oauth.ts` | Two roles: legacy OAuth helpers from 0.9.x (`runOAuthFlow`, `loadCredentials`, `getAuthorizationUrl`, `exchangeCode`, `getBaseUrl`) for the BYO-integration rollback path; AND the new `verifyVaultAccess` post-resolution preflight (#03). OAuth-flow primitives are no longer the canonical auth path under ntn-first; they remain reachable for legacy operators in 0.10.0 and removal is plausibly 1.0.0 contingent on telemetry. The filename reflects historical content; renaming is a separate cleanup. |
| `ntn.ts` | ntn integration module (#02). `loadNtnToken` reads `~/.config/notion/auth.json` for token resolution; `runNtnLogin` shells out to `ntn login` interactively; `installNtn` auto-installs via `curl -fsSL https://ntn.dev \| bash`; `getNtnVersion` / `checkNtnVersion` report the installed version. Exports `MIN_NTN_VERSION` and `NTN_INSTALL_COMMAND`. |

## The auth.json read is a temporary coupling

`src/auth/ntn.ts` reads ntn's private storage at
`~/.config/notion/auth.json`. **This is a deliberate bridge until
`ntn` ships a supported token-export command** (`ntn auth token
--plain` or equivalent). Every read site in this directory carries a
`// TODO(ntn-export):` comment pointing at DEFERRED-OFFICIAL-EXPORT
in the milestone DEFERRED.md.

When the supported command lands, `loadNtnToken`'s body changes to a
`child_process.execFile` call. The function signature stays the
same; consumers in `src/config.ts:resolveAuth` are unchanged. The
swap is ~10 lines of code.

## ntn version policy

`MIN_NTN_VERSION` is the tested-against floor. Bump only when:

- A new ntn version ships an `auth.json` shape change Lore needs to
  handle (read-shape compatibility), OR
- DEFERRED-OFFICIAL-EXPORT lands and Lore prefers `ntn auth token
  --plain` (consume-shape compatibility).

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

- `runNtnLogin()` — `child_process.spawn("ntn", ["login"], {
  stdio: "inherit", env: { ...process.env, NOTION_KEYRING: "0" } })`.
  Operator interacts with ntn's prompts directly; Lore captures the
  exit code only. The forced `NOTION_KEYRING=0` is the load-bearing
  piece — engineers don't need the env var in their shell rc for the
  Lore install path. Without it, ntn defaults to the macOS keychain
  on darwin and `auth.json` never gets written.
- `installNtn()` — runs `NTN_INSTALL_COMMAND` via shell with
  `stdio: "inherit"`, also setting `NOTION_KEYRING=0` for parity.
  Operator must explicitly confirm before this is called (via the
  consumer's prompt) — never curl-pipe-bash without explicit consent.

Both return discriminated `{ kind: "success" | "exit-non-zero" |
"spawn-error" }` outcomes so consumers route differently on each
failure mode.

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
plausible follow-up if telemetry surfaces friction), and `lore
auth --migrate` (post-migration verify).

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
