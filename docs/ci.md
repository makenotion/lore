# CI Contract

This doc states the contract that `/.github/workflows/ci.yml` is required to
keep. The contract exists because Lore is a public repository: every external
fork's pull request runs `ci.yml` against code the maintainers have not seen,
under the fork's identity, with no access to repo secrets.

A CI step that needs a Notion token, a real vault, an internal fixture, or
any other secret will fail (or worse, silently skip) on a fork PR. The
contract below keeps every step inside that envelope.

**Repository bindings.** `.github/CODEOWNERS` declares `@Iron-Ham`
ownership for `.github/`, `.github/workflows/`, and this doc. The
`workflow-lint` job in `ci.yml` runs `actionlint` and `zizmor` on every
push to `main` and every pull request. These repository artifacts are
review-routing and CI signals unless branch protection or repository
rulesets require code-owner review and the named status checks before
merge.

**Upstream reference.** This contract is project-specific, but the
underlying threat model and patterns it codifies come from GitHub's
[Security hardening for GitHub Actions](https://docs.github.com/en/actions/security-guides/security-hardening-for-github-actions)
guide. When a new footgun emerges that this doc hasn't yet captured, the
upstream guide is the fallback reference.

> If you are adding a CI step, **read the [Rules for new CI steps](#rules-for-new-ci-steps)
> section first**. If your step legitimately needs internal state, move it to a
> separate workflow that does **not** run on `pull_request` (see the
> [Adding internal-state workflows](#adding-internal-state-workflows) section
> for the safe shapes — a bare `github.repository == 'makenotion/lore'` check
> is **not** fork-safe when the workflow runs on `pull_request`).

## Per-step contract (`ci.yml`)

Every step in `ci.yml` is fork-safe. The table lists what each step does and
why it stays inside the envelope.

| Step                 | Command                                                                                            | Needs token?                | Needs network?              | Needs internal fixture? | Why it's fork-safe                                                                                                                                                                                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------- | --------------------------- | --------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Checkout             | `actions/checkout` (SHA-pinned, see rule #6)                                                       | No                          | Public Git over HTTPS       | No                      | Reads the PR's own commit; no secrets injected; `persist-credentials: false` prevents the checkout token from being written into git config.                                                                                                                                     |
| Install actionlint   | `curl` the pinned `actionlint` Linux release archive, verify SHA-256, and add the binary to `PATH` | No                          | Public GitHub release asset | No                      | Downloads a public, versioned static-analysis binary and verifies the archive checksum before execution.                                                                                                                                                                         |
| Run actionlint       | `actionlint .github/workflows/*.yml`                                                               | No                          | No                          | No                      | Pure static analysis of committed workflow files.                                                                                                                                                                                                                                |
| Install zizmor       | `curl` the pinned `zizmor` Linux release archive, verify SHA-256, and add the binary to `PATH`     | No                          | Public GitHub release asset | No                      | Downloads a public, versioned static-analysis binary and verifies the archive checksum before execution.                                                                                                                                                                         |
| Run zizmor           | `zizmor --min-severity medium --format github --no-progress .github/workflows`                     | No                          | No                          | No                      | Pure static analysis of committed workflow files; unsuppressed medium-or-higher findings fail the job.                                                                                                                                                                           |
| Setup Node.js        | `actions/setup-node` (SHA-pinned, see rule #6)                                                     | No                          | Public npm mirror           | No                      | Standard action; pulls Node 20 binary.                                                                                                                                                                                                                                           |
| Install dependencies | `npm ci`                                                                                           | No                          | Public npm registry         | No                      | No `.npmrc`, no `@makenotion`-scoped runtime deps. `prepare` script (`tools/install-git-hooks.mjs`) returns early when `CI=true`.                                                                                                                                                |
| Format check         | `npm run format:check` (`prettier --check src/`)                                                   | No                          | No                          | No                      | Pure static formatting check.                                                                                                                                                                                                                                                    |
| Version sync check   | `npm run version:check` (`node tools/check-version-sync.mjs`)                                      | No                          | No                          | No                      | Pure static consistency check that package, MCP handshake, CLI, and Notion `User-Agent` version literals match.                                                                                                                                                                  |
| Lint                 | `npm run lint` (`eslint src/`)                                                                     | No                          | No                          | No                      | Pure static analysis.                                                                                                                                                                                                                                                            |
| Typecheck            | `npm run typecheck` (`tsc --noEmit`)                                                               | No                          | No                          | No                      | Pure static analysis.                                                                                                                                                                                                                                                            |
| Test                 | `npm test` (`vitest run`)                                                                          | No                          | No                          | No                      | Tests use fixture-backed services. `tests/setup-runtool-flag.ts` pins all RunTool flags to `0` so no test path can accidentally hit Notion.                                                                                                                                      |
| Build                | `npm run build` (`tsup`)                                                                           | No                          | No                          | No                      | Local bundler.                                                                                                                                                                                                                                                                   |
| Eval starter suite   | `node dist/cli.js eval run evals/suites/lore-core.yaml …`                                          | No                          | No                          | No (synthetic)          | Runs the **retrieval** runner (see below). Synthetic YAML fixtures, no Notion calls.                                                                                                                                                                                             |
| Upload eval artifact | `actions/upload-artifact` (SHA-pinned, see rule #6)                                                | Ambient `GITHUB_TOKEN` only | GitHub API                  | No                      | The ambient per-run `GITHUB_TOKEN` is **automatically scoped to this run**; on a fork PR it is read-only by default and lifetime-bound to the run. The workflow declares `permissions: contents: read` at top level so the token is least-privilege regardless of repo defaults. |

The `concurrency` block keys on `github.ref` and cancels stale runs; that's
also fork-safe — for `pull_request`, `github.ref` is `refs/pull/<n>/merge`
and naturally isolates per-PR. (For other triggers `github.ref` is not
inherently per-PR; this workflow only fires on `push: main` and
`pull_request`, both of which are safe here.)

## Why the eval step doesn't need a Notion token

CI invokes the eval CLI with the `evals/suites/lore-core.yaml` suite, which
declares `runner: retrieval` (see `src/eval/runner.ts` for the dispatch and
`docs/evals.md` for the runner taxonomy). The retrieval runner is
contractually hermetic:

- It loads YAML fixtures from `evals/memory/` and `evals/baselines/`. These
  fixtures are explicitly synthetic — every fixture file begins with a
  banner stating "Synthetic fixture. Do not copy production vault content
  into eval fixtures." None of the fixture ids (`decision/auth-model`,
  `note/general-ui-polish`, …) exist in any real vault.
- It calls a `fixtureWakeUpServices()` factory (`src/eval/runner.ts`) that
  returns an in-memory `WakeUpServices` mock. The real `initServices()` path
  — the only code path that reads `NOTION_API_TOKEN`, `auth.json`, or
  `.lore.yaml` — is never invoked.
- The baseline JSON is read with `readFile` and validated with Zod; no
  network access.

The Notion-backed runner (`--runner notion --project <SandboxProject>`)
_does_ require a real token and a sandbox vault, but the CI workflow does
not pass `--runner notion` or `--project`, so that branch never fires.
Anyone changing the eval CI step who wants live-vault coverage should add
it to a _separate workflow_ that does not run on `pull_request` (see
[Adding internal-state workflows](#adding-internal-state-workflows)),
not to `ci.yml`.

## Why `publish.yml` doesn't affect forks

`publish.yml` only runs on `release: published`, so a fork pull request cannot
run the job. The job has only `contents: read` plus `id-token: write`; npm
exchanges the GitHub Actions OIDC identity for a short-lived publish credential.

Before an OIDC release, the package owner must configure
`@notionhq/lore`'s Trusted Publisher for GitHub organization `makenotion`,
repository `lore`, workflow filename `publish.yml`, and the `npm publish`
action. npm requires the package to exist before configuring that relationship,
so the first prerelease bootstrap is published manually with interactive 2FA.

## What the local dev hooks installer does in CI

`tools/install-git-hooks.mjs` is wired into the `prepare` npm script and runs
on every `npm ci` — including in CI. It guards against running in CI by
returning early when `process.env.CI === "true"`:

```js
if (env["CI"] === "true" || env["LORE_SKIP_GIT_HOOK_INSTALL"] === "1") {
  return
}
```

GitHub Actions sets `CI=true` automatically, so the hooks installer is a
no-op on every CI run, fork or otherwise.

## How the `.lore.yaml` gitignore invariant is enforced

`.lore.yaml` is local-only — each clone copies `.lore.example.yaml` to
`.lore.yaml` and fills in values from team onboarding docs. The repo
enforces this with two complementary layers. This invariant is the current
policy even for credential-free shared vault config and supersedes older
changelog notes that described intentionally committed config:

- **Pre-commit guard.** `.githooks/pre-commit` invokes
  `node tools/check-lore-config.mjs --staged`, which rejects any staged
  `.lore.yaml` index entry regardless of content (keying off
  `git ls-files --cached --error-unmatch`). The hook is installed by
  `tools/install-git-hooks.mjs` during `npm install`. CI does not
  invoke it directly — pre-commit hooks run on the contributor's
  machine, and `LORE_SKIP_GIT_HOOK_INSTALL=1` plus the `CI=true` guard
  in the installer skip the install path on CI runners anyway.
- **CI-side repo invariant.** The `src/config-guard.test.ts` invariant for
  an untracked root `.lore.yaml` runs in the standard test suite and fails
  the build if `.lore.yaml` is ever tracked at the repo root again,
  regardless of how it slipped in (rebase, cherry-pick, manual sequencer).
  This is what catches a bypass that the pre-commit hook missed.

Fork contributors do not need to install the hooks; they commit to
their own branches, and the repo-invariant test runs against the
merge candidate.

## Rules for new CI steps

Before adding a new step to `ci.yml`, confirm all seven of these:

1. **No repo secrets.** The step does not reference `secrets.*` other than
   the ambient `GITHUB_TOKEN` (which is auto-scoped per-run, even on forks).
2. **No live Notion access.** The step does not call any CLI/MCP path that
   ends up in `initServices()` or `getNotionClient()`. If the step exercises
   retrieval, it must use `--runner retrieval`.
3. **No internal-only fixtures.** Any fixture under `evals/`, `tests/`,
   `examples/`, etc. that the step reads must be committed to the repo and
   either explicitly synthetic or sourced from public data.
4. **No privileged `prepare` / `postinstall` work.** Don't add `prepare` or
   `postinstall` hooks that require interactive state, a writable git
   config, or non-public network access. The existing
   `tools/install-git-hooks.mjs` short-circuits on `CI=true`; new install-time
   hooks must take the same posture.
5. **No privileged PR-head checkout.** `pull_request_target` and
   `workflow_run` run with write tokens and elevated permissions. The single
   most common GitHub Actions supply-chain footgun combines
   `pull_request_target`, `actions/checkout` of
   `github.event.pull_request.head.*`, and repo secrets in the same job. If
   you think you need this, ask the security owner first.
6. **Third-party actions are pinned to a full commit SHA, not a floating
   tag.** Include a trailing `# v<x.y.z>` comment so reviewers can verify the
   pin without leaving the file. Floating tags (`@v4`) leave the workflow
   exposed to SHA-shifting / retagging — `publish.yml` already meets this
   bar; `ci.yml` must too. To verify a SHA matches its claimed tag before
   committing the pin, check the upstream `releases/tag/<v>` page or run
   `gh api repos/<owner>/<action>/git/ref/tags/<v> --jq .object.sha` and
   confirm it matches.
7. **Workflow declares an explicit top-level `permissions:` block, and no
   job widens it beyond what that job needs.** Default to
   `permissions: contents: read`. The repo-default token permissions are
   org/repo-policy-dependent; an explicit top-level block guarantees
   least-privilege regardless of policy drift.

### Adding internal-state workflows

If a step legitimately can't satisfy rules 1–3 — for example, a nightly
live-vault eval — put it in a _separate workflow file_. The safest shape is
to keep that workflow off `pull_request` entirely, so fork PRs cannot ever
trigger it:

```yaml
on:
  schedule:
    - cron: "0 7 * * *"
  workflow_dispatch:

permissions:
  contents: read

jobs:
  nightly-live-eval:
    if: github.repository == 'makenotion/lore'
    ...
```

`github.repository == 'makenotion/lore'` is **not** by itself a fork-safe
gate when the workflow runs on `pull_request`. A fork PR opened against
the base repo runs in the base repo's context: `github.repository` is
still `makenotion/lore`, and the guard evaluates `true`. Use one of these
two shapes when a workflow needs to stay on `pull_request` but still skip
fork PRs:

```yaml
# Either: forbid pull_request entirely on the secret-backed workflow.
on:
  push:
    branches: [main]
  workflow_dispatch:
```

```yaml
# Or: combine the canonical-repo check with a PR-head check.
if: >
  github.repository == 'makenotion/lore' &&
  (github.event_name != 'pull_request' ||
   github.event.pull_request.head.repo.full_name == github.repository)
```

The combined guard handles the case where a fork PR runs in the base repo's
context: `github.event.pull_request.head.repo.full_name` resolves to
`<fork-owner>/lore`, which differs from `github.repository`, so the guard
short-circuits before any privileged step runs.

## Verifying fork-safety locally

Two quick checks before opening a PR that touches CI:

```bash
# 1. The whole ci.yml pipeline, with no supported Notion auth source
#    available and CI=true so the prepare hooks installer takes its no-op
#    branch.
#
#    The chain runs inside a single `bash -c` so the env scrub and CI=true
#    apply to every command, not just the first one. `env -u VAR cmd1 &&
#    cmd2` only scrubs cmd1; cmd2 inherits your caller environment and the
#    self-test can falsely pass on a maintainer machine that has tokens set.
#    Isolated HOME and XDG_CONFIG_HOME also hide ntn auth.json, which is a
#    supported fallback auth source when NOTION_API_TOKEN is unset.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/home" "$tmp/.config"
env -u NOTION_API_TOKEN -u GITHUB_TOKEN \
  HOME="$tmp/home" XDG_CONFIG_HOME="$tmp/.config" CI=true \
  bash -c '
    set -euo pipefail
    npm ci
    npm run format:check
    npm run lint
    npm run typecheck
    npm test
    npm run build
    node dist/cli.js eval run evals/suites/lore-core.yaml \
      --out evals/results/lore-core-ci.json \
      --min-lift 0.5 --max-harm 0.0 \
      --baseline evals/baselines/lore-core.json
  '
```

If any step in that pipeline fails when no supported Notion auth source is
available, the step has regressed the fork-safety contract.

```bash
# 2. Confirm the eval suite still declares the retrieval runner.
grep '^runner:' evals/suites/lore-core.yaml
# Expected: runner: retrieval
```

## First-fork-PR sanity check

When the repo first goes public, the maintainer who reviews the inaugural
external fork PR should confirm:

**Happy-path:**

- The "CI" check on the PR shows green or skipped — not failed with an auth
  error.
- The "Upload eval artifact" step ran and attached an artifact (proves the
  eval reached the end on a fork's `GITHUB_TOKEN`).

**No silent secret leak:**

- The run logs contain no `***` redactions. GitHub redacts any secret value
  it sees in step output; redactions in a fork-PR run mean a secret was
  expanded into the environment, which violates the contract.
- Dump the relevant env on the fork-PR run and confirm `NOTION_API_TOKEN`
  and any org-level secret are empty. An ad-hoc step
  like `run: 'echo "notion=${NOTION_API_TOKEN:+SET}"'` (without the variable
  value itself) proves the absence without risking a leak if the contract
  has already broken. The GitHub-native equivalent is a step gated on
  `if: ${{ secrets.NOTION_API_TOKEN != '' }}` that fails the run if it
  evaluates true; that form sidesteps echo entirely.

**No internal-only workflow fired:**

- No workflow gated on `github.repository == 'makenotion/lore'` ran.
- No `workflow_run`-shaped workflow fired off the fork's `pull_request`
  completion. If a future workflow listens for `workflow_run` from `CI`,
  re-run this check — `workflow_run` runs in the base repo's context with
  the base repo's permissions, and it's a known leak path if it consumes
  fork outputs.

Record the result on the public-launch issue.
