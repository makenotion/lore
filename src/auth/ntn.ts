/**
 * ntn integration module — auth.json reader + interactive shell-out helpers.
 *
 * The auth.json read is the contract. Lore reads ntn's on-disk
 * storage at ~/.config/notion/auth.json because the public `ntn`
 * CLI (github.com/makenotion/skills) does not expose a token-export
 * surface — only `ntn login` / `ntn logout` for the auth lifecycle
 * and `NOTION_API_TOKEN` for injection. The maintainers have indicated
 * no `ntn auth token` (or equivalent) command will ship. Operators who
 * want to bypass the on-disk read entirely set `NOTION_API_TOKEN`,
 * which `resolveAuth` honors as the highest-priority source.
 *
 * The file format is undocumented but has been stable across the
 * `ntn` versions Lore supports (`MIN_NTN_VERSION` onward). No failure
 * mode throws. The reader returns null on every failure path, but
 * emits a stderr hint only on recoverable mismatches the operator can
 * act on: malformed JSON, unexpected root type, unknown requested
 * workspace, and ambiguous multi-workspace selection. The missing-file
 * and empty-workspace paths return null silently so `resolveAuth` can
 * fall through to deprecated sources without noise. Callers pass
 * `quiet: true` to suppress every hint — `resolveAuth` uses this when
 * a legacy fallback is available so operators see at most one
 * consolidated stderr line. A future ntn shape change is handled by
 * bumping `MIN_NTN_VERSION` and teaching the reader the new shape.
 */

import { execFileSync, spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export interface NtnTokenRecord {
  token: string
  workspaceId: string
  /**
   * Notion API base URL. ntn's per-environment defaults are
   *   prod: https://api.notion.so
   *   dev:  https://api-dev.notion.com
   *   stg:  https://api-stg.notion.com (verify if used)
   * Resolves from `LORE_NOTION_BASE_URL` first, then a best-effort
   * read of ntn's config.json, with a final fallback to undefined
   * (SDK default = prod).
   */
  baseUrl?: string
}

export interface LoadNtnTokenInput {
  workspaceId?: string
  /**
   * Suppress stderr emission for the recoverable failure modes
   * (malformed JSON, unexpected shape, requested-workspace-not-present,
   * multi-workspace-no-selector). The function still returns null in
   * those cases — the caller takes responsibility for surfacing a
   * user-visible hint at a moment of its choosing.
   *
   * `resolveAuth` sets this to true so that an
   * operator who has both auth.json AND a legacy fallback (e.g.
   * `LORE_NOTION_TOKEN`) does not see two contradictory stderr lines —
   * "set NOTION_WORKSPACE_ID" from this module followed by
   * "LORE_NOTION_TOKEN is soft-deprecated, run lore auth --migrate"
   * from the deprecation emitter. Instead, `resolveAuth` surfaces the
   * ntn ambiguity hint only at the throw site (no source resolved).
   */
  quiet?: boolean
}

/**
 * Read the operator's ntn-issued token for a chosen workspace.
 *
 * Selector precedence: explicit `input.workspaceId` > single-workspace
 * auto-pick > error. The caller (`resolveAuth`) is responsible
 * for resolving `NOTION_WORKSPACE_ID` env / `auth.workspaceId` config
 * into the `workspaceId` argument.
 *
 * Returns null on every failure path; never throws. Stderr hints
 * fire on the four recoverable mismatches but stay silent on
 * missing-file and empty-workspace; `input.quiet` suppresses every
 * hint. Full failure-mode contract in the module-level docstring above.
 */
export async function loadNtnToken(
  input: LoadNtnTokenInput = {}
): Promise<NtnTokenRecord | null> {
  const result = await readWorkspaceEntries()
  const quiet = input.quiet === true

  if (result.kind === "missing") return null
  if (result.kind === "unusable") {
    if (!quiet) {
      const reason =
        result.reason === "malformed"
          ? "is malformed; ignoring"
          : "has unexpected shape (expected an object)"
      // Recovery copy points at `lore auth --login`, the canonical
      // Phase-2 wrapper that auto-installs ntn (if missing), forces
      // `NOTION_KEYRING=0` inside the spawn, and runs the post-login
      // vault preflight. Operators who'd rather drive ntn directly
      // can still run `NOTION_KEYRING=0 ntn login` manually.
      process.stderr.write(
        `[lore] auth.json at ${result.path} ${reason}. ` +
          `Run \`lore auth --login\` to refresh ` +
          `(or \`NOTION_KEYRING=0 ntn login\` to drive ntn directly).\n`
      )
    }
    return null
  }

  const workspaceEntries = result.entries

  if (workspaceEntries.length === 0) {
    return null
  }

  let pick: [string, string] | undefined

  if (input.workspaceId) {
    pick = workspaceEntries.find(([ws]) => ws === input.workspaceId)
    if (!pick) {
      // Caller asked for a specific workspace and ntn doesn't have
      // it. Don't silently substitute another. Return null with a
      // stderr hint so the operator knows.
      if (!quiet) {
        process.stderr.write(
          `[lore] ntn auth.json carries ${workspaceEntries.length} ` +
            `workspace(s), but the requested workspaceId ` +
            `(${input.workspaceId}) is not among them. ` +
            `Available: ${workspaceEntries.map(([ws]) => ws).join(", ")}.\n` +
            `[lore] Run \`lore auth --login\` against the right workspace, ` +
            `or update auth.workspaceId in .lore.yaml. (\`lore auth --login\` ` +
            `forces NOTION_KEYRING=0 inside the spawn so the resulting ` +
            `token lands in auth.json where Lore can read it; bare ` +
            `\`ntn login\` on macOS defaults to keychain mode.)\n`
        )
      }
      return null
    }
  } else if (workspaceEntries.length === 1) {
    pick = workspaceEntries[0]!
  } else {
    // Multiple workspaces, no selector. Surface the choice.
    if (!quiet) {
      process.stderr.write(
        `[lore] ntn auth.json carries ${workspaceEntries.length} ` +
          `workspaces; specify one via NOTION_WORKSPACE_ID env or ` +
          `auth.workspaceId in .lore.yaml.\n` +
          `[lore] Available: ${workspaceEntries.map(([ws]) => ws).join(", ")}.\n`
      )
    }
    return null
  }

  return {
    token: pick[1],
    workspaceId: pick[0],
    baseUrl: await resolveNtnBaseUrl(),
  }
}

/**
 * Tagged result shape for `readWorkspaceEntries`. The discriminator lets
 * `loadNtnToken` and `listNtnWorkspaces` apply the failure-mode policy
 * each owns (stderr hint + null vs. silent empty array) without
 * duplicating the parse / shape-guard / filter walk.
 *
 * - `missing`  — file absent or empty-after-filter (no string-valued
 *                workspace entries). Silent in both consumers.
 * - `unusable` — file present but unparseable or wrong root shape.
 *                `loadNtnToken` emits a stderr hint (unless quiet),
 *                `listNtnWorkspaces` returns [].
 * - `ok`       — at least one string-valued workspace entry.
 */
type WorkspaceEntriesResult =
  | { kind: "missing" }
  | { kind: "unusable"; reason: "malformed" | "unexpected-shape"; path: string }
  | { kind: "ok"; entries: Array<[string, string]> }

async function readWorkspaceEntries(): Promise<WorkspaceEntriesResult> {
  const path = ntnAuthJsonPath()
  let raw: string
  try {
    raw = await readFile(path, "utf-8")
  } catch {
    // File doesn't exist (operator hasn't run ntn login yet, OR is
    // using keychain mode without NOTION_KEYRING=0).
    return { kind: "missing" }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: "unusable", reason: "malformed", path }
  }

  // Object-shape guard. `JSON.parse("null")` returns null;
  // `JSON.parse("[1, 2]")` returns an array; `JSON.parse('"x"')`
  // returns a string. All three parse successfully but break
  // `Object.entries` (null) or produce nonsense workspace ids.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "unusable", reason: "unexpected-shape", path }
  }

  // Filter to entries with non-empty string-valued tokens. ntn writes
  // additional metadata under reserved keys in some versions — don't
  // trip over those. The type predicate narrows the tuple's value
  // position from `unknown` to `string` so consumers can destructure
  // without re-validating.
  const entries = Object.entries(parsed as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0
  )

  return { kind: "ok", entries }
}

/**
 * Enumerate workspace ids in ntn's auth.json. Used by `lore auth
 * --status` in the no-vault-context branch to surface the
 * operator's auth.json footprint without requiring a .lore.yaml.
 *
 * Returns empty array on every "no usable file" failure mode so
 * consumers can treat empty as "nothing to show" without
 * distinguishing reasons.
 */
export async function listNtnWorkspaces(): Promise<string[]> {
  const result = await readWorkspaceEntries()
  if (result.kind !== "ok") return []
  return result.entries.map(([workspaceId]) => workspaceId)
}

/**
 * Resolve the path to ntn's auth.json. Honors `XDG_CONFIG_HOME`
 * (the same env ntn itself respects per its --help output); falls
 * back to ~/.config.
 */
function ntnAuthJsonPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]
  const base = xdg ?? join(homedir(), ".config")
  return join(base, "notion", "auth.json")
}

/**
 * Resolve the Notion API base URL ntn would use for the active
 * environment.
 *
 * Priority order:
 *   1. Operator env override (`LORE_NOTION_BASE_URL` →
 *      `NOTION_BASE_URL` → `NOTION_API_BASE_URL`, see
 *      `resolveOperatorBaseUrl`).
 *   2. ntn's ~/.config/notion/config.json `env` field
 *      (`prod`/`dev`/`stg`) mapped to the canonical host.
 *   3. `undefined` — the SDK applies its prod default.
 *
 * The config.json shape is undocumented. Best-effort read with a
 * hard fallback to `undefined` (SDK default = prod) when the file
 * is missing or unparseable. Operators on dev / staging who want a
 * deterministic override set `LORE_NOTION_BASE_URL` rather than
 * relying on the config.json read.
 */
async function resolveNtnBaseUrl(): Promise<string | undefined> {
  const { resolveOperatorBaseUrl, ntnEnvBaseUrl } = await import("./oauth.js")
  const fromEnv = resolveOperatorBaseUrl()
  if (fromEnv) return fromEnv
  const configPath = ntnAuthJsonPath().replace(/auth\.json$/, "config.json")
  try {
    const raw = await readFile(configPath, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const env = typeof parsed["env"] === "string" ? parsed["env"] : "prod"
    // Share the ntn-env → URL mapping table with the oauth module
    // so the canonical URLs land in one place. Returning `undefined`
    // for `prod` is intentional: prod is the SDK default, no
    // override needed.
    return env === "prod" ? undefined : ntnEnvBaseUrl(env)
  } catch {
    return undefined
  }
}

/**
 * Probe whether `ntn` is installed on PATH. Used by `lore install`
 * and `lore auth --status` to surface clear messaging
 * when the operator hasn't installed ntn yet.
 *
 * Cheap synchronous probe with a 1-second timeout. Returns false on
 * any error (not-found, permission denied, etc.) — never throws.
 *
 * Memoized per-process — the result is cached after the first call and
 * reused by subsequent calls in the same Lore invocation. Operator
 * surfaces (`lore install`, `lore auth --status`) call this multiple
 * times within one CLI invocation; without the cache each call would
 * pay another `execFileSync`. `installNtn` resets the cache on success
 * so a follow-up probe sees the freshly installed binary.
 */
export function isNtnInstalled(): boolean {
  if (cachedInstalled !== null) return cachedInstalled
  try {
    execFileSync("ntn", ["--version"], { stdio: "pipe", timeout: 1000 })
    cachedInstalled = true
  } catch {
    cachedInstalled = false
  }
  return cachedInstalled
}

let cachedInstalled: boolean | null = null
let cachedVersion: string | null | undefined = undefined

/**
 * Lore's tested-against minimum `ntn` version. Below this, Lore warns
 * but does not block — operators preferring an older version for
 * other reasons keep using it; their auth.json shape may differ
 * but the reader degrades gracefully (returns null).
 *
 * Bumped only when a new ntn version ships an auth.json shape
 * change Lore needs to handle.
 */
export const MIN_NTN_VERSION = "0.12.0"

/**
 * The canonical install command `ntn` itself recommends when asked
 * to self-update on a package-manager install (per the binary's own
 * error message: "reinstall with `curl -fsSL https://ntn.dev | bash`").
 * Lore uses this for the auto-install path across `lore install`,
 * `lore init` no-arg, `lore auth --login`, and `lore auth --migrate`
 * when the operator opts in.
 *
 * Hardcoded constant — no string concatenation, no user-controlled
 * interpolation. Confirmed by `installNtn` test that asserts the
 * spawn command argument equals this constant exactly.
 */
export const NTN_INSTALL_COMMAND = "curl -fsSL https://ntn.dev | bash"

/**
 * Read the installed ntn version. Returns the parsed SemVer string
 * (e.g., "0.12.0") or null if `ntn` is not on PATH or returned an
 * unparseable response.
 *
 * Memoized per-process (same posture as `isNtnInstalled`). `installNtn`
 * resets on success.
 */
export function getNtnVersion(): string | null {
  if (cachedVersion !== undefined) return cachedVersion
  try {
    const output = execFileSync("ntn", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 1000,
    })
    // `ntn --version` prints "ntn 0.12.0" (or with a build suffix).
    const match = output.trim().match(/(\d+\.\d+\.\d+)/)
    cachedVersion = match ? match[1]! : null
  } catch {
    cachedVersion = null
  }
  return cachedVersion
}

/**
 * Drop the per-process `isNtnInstalled` / `getNtnVersion` caches.
 * Called on a successful `installNtn` so a follow-up probe sees the
 * freshly installed binary instead of the pre-install null result.
 * Exported for tests; production code goes through `installNtn`.
 */
export function resetNtnProbeCache(): void {
  cachedInstalled = null
  cachedVersion = undefined
}

/**
 * Compare the installed ntn version against `MIN_NTN_VERSION`.
 *
 * - `"unknown"` — ntn not installed or version unparseable
 * - `"too-old"` — installed version < MIN_NTN_VERSION
 * - `"ok"` — installed version >= MIN_NTN_VERSION
 *
 * Per the "prefer existing version" rollout policy, `"too-old"` is
 * informational — Lore never auto-upgrades. Consumers (`lore auth
 * --login`, `lore install`) print a warning and proceed.
 */
export function checkNtnVersion(): "unknown" | "too-old" | "ok" {
  const installed = getNtnVersion()
  if (!installed) return "unknown"
  return compareSemver(installed, MIN_NTN_VERSION) < 0 ? "too-old" : "ok"
}

/**
 * Minimal SemVer comparison sufficient for `0.X.Y` style versions.
 * Returns -1 / 0 / 1. Doesn't handle SemVer suffixes; ntn's
 * release shape is stable major.minor.patch per the binary
 * inspection.
 *
 * Non-finite components (e.g., a future caller that hands raw
 * `ntn 0.13.0a` past `getNtnVersion`'s SemVer-stripping regex) are
 * coerced to 0 before comparison so `NaN !== NaN` doesn't mis-rank
 * the input as "newer" by skipping the equality check. Today this
 * branch is unreachable through the public surface — `getNtnVersion`
 * always returns a clean `\d+\.\d+\.\d+` substring or `null` — but
 * the guard is one line and stops a future contributor from being
 * surprised when they pass raw output.
 */
function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const ai = Number.isFinite(pa[i]) ? (pa[i] as number) : 0
    const bi = Number.isFinite(pb[i]) ? (pb[i] as number) : 0
    if (ai !== bi) return ai < bi ? -1 : 1
  }
  return 0
}

export type NtnLoginResult =
  | { kind: "success" }
  | { kind: "exit-non-zero"; code: number }
  | { kind: "spawn-error"; error: unknown }

/**
 * Notion environment ntn authenticates against. Mirrors ntn's own
 * `--env` flag values and the `NOTION_ENV` env var ntn reads.
 *
 * - `prod` → `api.notion.so` (default)
 * - `dev`  → `api-dev.notion.com`
 * - `stg`  → `api-stg.notion.com`
 *
 * Single source of truth for consumers (`lore init --ntn-env`,
 * `lore install --ntn-env`, `lore auth --login --ntn-env`) so a typo
 * in one surface can't drift away from another. The literal strings
 * match ntn's accepted values verbatim — the type is functionally an
 * enum but expressed as a string union so it round-trips through
 * commander's argv parsing without a custom coercer.
 */
export type NtnEnv = "prod" | "dev" | "stg"

export interface RunNtnLoginOpts {
  /**
   * Notion environment to authenticate against. When provided, sets
   * `NOTION_ENV` in the spawn env so ntn writes the matching `env`
   * field into ~/.config/notion/config.json — which `loadNtnToken`
   * + `resolveNtnBaseUrl` then read on the post-login auth resolution
   * to surface the dev / stg base URL.
   *
   * Omitting this leaves the spawn env untouched (no override
   * written), so an operator who set `NOTION_ENV` in their shell rc
   * sees that value flow through naturally. The omit-vs-explicit
   * distinction is load-bearing: writing `NOTION_ENV=prod` always
   * would clobber an inherited `dev` value from shell rc, surprising
   * operators who already opted into dev outside Lore.
   */
  env?: NtnEnv
}

/**
 * Spawn `ntn login` interactively. Inherits stdio so the operator
 * interacts with ntn's prompts (workspace picker, browser
 * confirmation) directly. Blocks until ntn exits.
 *
 * **Forces `NOTION_KEYRING=0` in the spawn env** so the resulting
 * token lands in ~/.config/notion/auth.json (file mode) where
 * `loadNtnToken` can read it. This is the load-bearing piece of the
 * "Option A" seamless-onboarding posture — engineers don't have to
 * set the env var in their shell rc; Lore handles it at the boundary
 * for any ntn invocation it triggers. Operators who later run
 * `ntn login` directly (outside Lore) without the env var fall
 * through to ntn's default keychain mode; the operator runbook
 * documents this gotcha and the recovery paths.
 *
 * `opts.env` (optional) propagates the dev / stg environment
 * selection forward to ntn via `NOTION_ENV`. See `RunNtnLoginOpts`
 * for the omit-vs-explicit semantics — this is intentionally a
 * "set when caller asks for it" surface, not a "default to prod"
 * surface.
 *
 * Used by `lore install`, `lore init` no-arg, `lore auth --login`,
 * and `lore auth --migrate` when the operator confirms they want to
 * log in.
 *
 * The function does NOT prompt the operator — it just runs the
 * spawn. Confirmation prompts live in the consumer per their UX
 * shape.
 *
 * Returns a discriminated outcome so consumers can route on success
 * / exit-non-zero / spawn-error without try/catch ladders.
 */
export async function runNtnLogin(opts: RunNtnLoginOpts = {}): Promise<NtnLoginResult> {
  return new Promise((resolve) => {
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        NOTION_KEYRING: "0",
      }
      if (opts.env !== undefined) {
        env["NOTION_ENV"] = opts.env
      }
      const child = spawn("ntn", ["login"], {
        stdio: "inherit",
        shell: false,
        env,
      })
      child.on("error", (error) => resolve({ kind: "spawn-error", error }))
      child.on("exit", (code) => {
        if (code === 0) resolve({ kind: "success" })
        else resolve({ kind: "exit-non-zero", code: code ?? -1 })
      })
    } catch (error) {
      resolve({ kind: "spawn-error", error })
    }
  })
}

/**
 * Parse a CLI-supplied `--ntn-env` value (or `NOTION_ENV` from the
 * operator's shell) into an `NtnEnv` or null.
 *
 * Returns the parsed enum on a recognized value, `null` on an
 * unrecognized string. Consumers that want hard-fail behavior treat
 * `null` as "reject and exit"; consumers that want soft-fail can fall
 * back to default ntn behavior. The MCP / hooks paths don't expose
 * this surface, so this helper is CLI-side only — exported here
 * (rather than per-consumer) to keep the canonical-value list in one
 * place.
 *
 * Returns `undefined` (NOT `null`) when the input itself is undefined,
 * so consumers can distinguish "operator didn't pass the flag" from
 * "operator passed an invalid value." The former is the "use ntn's
 * default" path; the latter is a fail-fast input error.
 */
export function parseNtnEnv(value: string | undefined): NtnEnv | null | undefined {
  if (value === undefined) return undefined
  if (value === "prod" || value === "dev" || value === "stg") return value
  return null
}

export type NtnInstallResult =
  | { kind: "success" }
  | { kind: "exit-non-zero"; code: number }
  | { kind: "spawn-error"; error: unknown }

/**
 * Install `ntn` via the canonical command Lore knows about
 * (`NTN_INSTALL_COMMAND`).
 *
 * Inherits stdio so the operator sees the install progress and can
 * interrupt if needed. Blocks until completion. Sets
 * `NOTION_KEYRING=0` in the spawn env for parity with `runNtnLogin`
 * — if the install script chains into a first-run ntn invocation,
 * that invocation also targets file mode. Most `curl ... | bash`
 * installers don't auto-run the binary, but the env-forcing is
 * cheap defense in depth.
 *
 * **Spawn env is scrubbed to an allowlist** rather than inheriting
 * the full `process.env`. The remote installer at `https://ntn.dev`
 * has no business reading `NOTION_API_TOKEN`, `LORE_NOTION_TOKEN`,
 * `GITHUB_TOKEN`, npm credentials, or any other token-bearing
 * variables that happen to live in the operator's shell. The
 * allowlist (`buildInstallNtnEnv`) covers what the install script
 * actually needs: shell + locale + proxy + `HOME`/`PATH`/`USER`/
 * temp-dir variables, plus `NOTION_KEYRING=0`.
 *
 * The function does NOT prompt for confirmation. Consumers must
 * confirm with the operator before calling — auto-installing
 * without explicit consent would surprise operators with a
 * curl-pipe-bash they didn't authorize.
 *
 * On success, drops the `isNtnInstalled` / `getNtnVersion` probe
 * cache so a follow-up probe in the same process sees the freshly
 * installed binary instead of the pre-install null result.
 */
export async function installNtn(): Promise<NtnInstallResult> {
  return new Promise((resolve) => {
    try {
      // Run via shell so the curl-pipe-bash composition resolves.
      // shell: true is intentional and acceptable here — the command
      // is a hardcoded constant, not user-controlled input.
      const child = spawn(NTN_INSTALL_COMMAND, {
        stdio: "inherit",
        shell: true,
        env: buildInstallNtnEnv(),
      })
      child.on("error", (error) => resolve({ kind: "spawn-error", error }))
      child.on("exit", (code) => {
        if (code === 0) {
          resetNtnProbeCache()
          resolve({ kind: "success" })
        } else {
          resolve({ kind: "exit-non-zero", code: code ?? -1 })
        }
      })
    } catch (error) {
      resolve({ kind: "spawn-error", error })
    }
  })
}

/**
 * Allowlist of env-var names forwarded into the `installNtn` shell.
 * Deliberately minimal — anything not on this list (most importantly,
 * the various `*_TOKEN` / `*_KEY` / `*_SECRET` variables) is dropped
 * before the spawn.
 *
 * Categories the allowlist covers:
 * - Shell + path: `HOME`, `PATH`, `USER`, `LOGNAME`, `SHELL`
 * - Temp dirs: `TMPDIR`, `TMP`, `TEMP`
 * - Locale: `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TERM`,
 *   `COLORTERM`
 * - Proxy: `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` (lower- and
 *   upper-case variants)
 *
 * Verified against ntn's own `https://ntn.dev` installer needs: it's
 * a `curl ... | bash` script, so it needs the shell + path + proxy
 * vars to fetch; it does not need any Notion / Lore / git / npm
 * credentials.
 */
const INSTALL_NTN_ENV_ALLOWLIST: ReadonlyArray<string> = [
  "HOME",
  "PATH",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TERM",
  "COLORTERM",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]

/**
 * Build the spawn env for `installNtn`. Only allowlisted variables
 * from `process.env` are forwarded; `NOTION_KEYRING=0` is appended
 * unconditionally so any chained ntn invocation lands in file mode.
 */
function buildInstallNtnEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const key of INSTALL_NTN_ENV_ALLOWLIST) {
    const value = process.env[key]
    if (typeof value === "string") env[key] = value
  }
  env["NOTION_KEYRING"] = "0"
  return env
}
