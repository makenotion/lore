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
 * continue to its final recovery message without duplicate noise.
 * Callers pass `quiet: true` to suppress every hint and surface one
 * consolidated error at the call site. A future ntn shape change is
 * handled by bumping `MIN_NTN_VERSION` and teaching the reader the
 * new shape.
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
   * `resolveAuth` sets this to true so that the ntn ambiguity hint
   * lands only in the final auth recovery error.
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
 * Release Lore installs when ntn is missing. The installer pins both
 * the release URL and the per-platform archive hash in this module so
 * a Lore package upgrade is the authority boundary for a new ntn
 * binary.
 */
export const NTN_INSTALL_VERSION = "v0.13.2"

export const NTN_INSTALL_BASE_URL = "https://ntn.dev"

export const NTN_VERIFIED_INSTALL_DESCRIPTION =
  `ntn ${NTN_INSTALL_VERSION} from ` +
  `${NTN_INSTALL_BASE_URL}/releases/${NTN_INSTALL_VERSION} ` +
  "(sha256 pinned by Lore)"

/**
 * Operator-driven fallback command from ntn's upstream installer
 * surface. Lore's auto-install path uses `installNtn()` instead,
 * which verifies the release archive against the hashes below.
 */
export const NTN_MANUAL_INSTALL_COMMAND = "curl -fsSL https://ntn.dev | bash"

/**
 * Compatibility alias for consumers that import Lore's manual install
 * string. CLI code should prefer `NTN_MANUAL_INSTALL_COMMAND` when
 * it is specifically printing the upstream fallback.
 *
 * @deprecated Use `NTN_MANUAL_INSTALL_COMMAND` for manual fallback
 * copy. `installNtn()` uses Lore's verified installer.
 */
export const NTN_INSTALL_COMMAND = NTN_MANUAL_INSTALL_COMMAND

export const NTN_INSTALL_ARCHIVE_SHA256 = {
  "aarch64-apple-darwin":
    "40ce5ed7490f9371bc52a28918723f5c2010bf7d9b7a7b30273d8b63b30d5054",
  "x86_64-apple-darwin":
    "18dd6f6c289d24f6ef609160923d4ca02f66ea46910b45feae44a028096d7254",
  "x86_64-unknown-linux-musl":
    "44bbcf91e113bd33ef5275d1ee45160f4463bddae53beaeb381273f797d349c9",
  "aarch64-unknown-linux-musl":
    "21c6b57dd7e7dbf8bd653191b3b8c0c0142042c24939ebab46048a7b9f22e2e7",
} as const

function buildPinnedChecksumCases(): string {
  return Object.entries(NTN_INSTALL_ARCHIVE_SHA256)
    .map(([target, checksum]) => `  ${target}) printf '%s\\n' "${checksum}" ;;`)
    .join("\n")
}

const VERIFIED_NTN_INSTALL_SCRIPT = `set -euo pipefail

readonly BASE_URL="${NTN_INSTALL_BASE_URL}"
readonly VERSION="${NTN_INSTALL_VERSION}"
readonly INSTALL_DIR="\${NTN_INSTALL_DIR:-/usr/local/bin}"

function info() {
  printf '==> %s\\n' "$*" >&2
}

function fail() {
  printf 'error: %s\\n' "$*" >&2
  exit 1
}

function require_command() {
  local command_name="$1"
  command -v "$command_name" >/dev/null 2>&1 || fail "Missing required command: \${command_name}"
}

function detect_downloader() {
  if command -v curl >/dev/null 2>&1; then
    DOWNLOADER="curl"
  elif command -v wget >/dev/null 2>&1; then
    DOWNLOADER="wget"
  else
    fail "Either curl or wget is required but neither is installed"
  fi
}

function download() {
  local url="$1"
  local output="$2"

  if [[ "\${DOWNLOADER}" == "curl" ]]; then
    curl --proto '=https' --tlsv1.2 -fsSL -o "\${output}" "\${url}"
  else
    wget -q -O "\${output}" "\${url}"
  fi
}

function detect_target() {
  local os
  local arch

  os="$(uname -s)"
  arch="$(uname -m)"

  if [[ "\${os}" == "Darwin" && "\${arch}" == "x86_64" ]]; then
    if [[ "$(sysctl -n sysctl.proc_translated 2>/dev/null)" == "1" ]]; then
      arch="arm64"
    fi
  fi

  case "\${os}" in
  MINGW* | MSYS* | CYGWIN*)
    fail "ntn does not currently support Windows"
    ;;
  esac

  case "\${os}:\${arch}" in
  Darwin:arm64 | Darwin:aarch64)
    NTN_TARGET="aarch64-apple-darwin"
    NTN_PLATFORM_LABEL="darwin-arm64"
    ;;
  Darwin:x86_64)
    NTN_TARGET="x86_64-apple-darwin"
    NTN_PLATFORM_LABEL="darwin-x64"
    ;;
  Linux:x86_64)
    NTN_TARGET="x86_64-unknown-linux-musl"
    NTN_PLATFORM_LABEL="linux-x64"
    ;;
  Linux:arm64 | Linux:aarch64)
    NTN_TARGET="aarch64-unknown-linux-musl"
    NTN_PLATFORM_LABEL="linux-arm64"
    ;;
  *)
    fail "ntn does not support \${os} \${arch}"
    ;;
  esac
}

function expected_sha256() {
  case "$1" in
${buildPinnedChecksumCases()}
  *) fail "Lore does not ship a checksum for target $1" ;;
  esac
}

function file_sha256() {
  local file="$1"

  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "\${file}" | {
      read -r checksum _
      printf '%s\\n' "\${checksum}"
    }
    return
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "\${file}" | {
      read -r checksum _
      printf '%s\\n' "\${checksum}"
    }
    return
  fi

  fail "No checksum tool found (need shasum or sha256sum)"
}

function install_binary() {
  local binary_path="$1"
  local destination_path="\${INSTALL_DIR}/ntn"

  if mkdir -p "\${INSTALL_DIR}" 2>/dev/null && install -m 0755 "\${binary_path}" "\${destination_path}" 2>/dev/null; then
    return
  fi

  command -v sudo >/dev/null 2>&1 || fail "Cannot write to \${INSTALL_DIR}; re-run with sudo or set NTN_INSTALL_DIR"

  sudo mkdir -p "\${INSTALL_DIR}"
  sudo install -m 0755 "\${binary_path}" "\${destination_path}"
}

detect_downloader
require_command tar
require_command uname
require_command mktemp
require_command install

detect_target
EXPECTED_SHA256="$(expected_sha256 "\${NTN_TARGET}")"
readonly EXPECTED_SHA256

readonly ARCHIVE_NAME="ntn-\${NTN_TARGET}.tar.gz"
readonly ARCHIVE_URL="\${BASE_URL}/releases/\${VERSION}/\${ARCHIVE_NAME}"

TMP_DIR="$(mktemp -d)"
readonly TMP_DIR
trap 'rm -rf "\${TMP_DIR}"' EXIT

ARCHIVE_PATH="\${TMP_DIR}/\${ARCHIVE_NAME}"
readonly ARCHIVE_PATH

info "Downloading \${VERSION} for \${NTN_PLATFORM_LABEL}"
if ! download "\${ARCHIVE_URL}" "\${ARCHIVE_PATH}"; then
  rm -f "\${ARCHIVE_PATH}"
  fail "Failed to download \${ARCHIVE_URL}"
fi

ACTUAL_SHA256="$(file_sha256 "\${ARCHIVE_PATH}")"
readonly ACTUAL_SHA256
if [[ "\${ACTUAL_SHA256}" != "\${EXPECTED_SHA256}" ]]; then
  rm -f "\${ARCHIVE_PATH}"
  fail "Checksum verification failed for \${ARCHIVE_NAME}: expected \${EXPECTED_SHA256}, got \${ACTUAL_SHA256}"
fi

tar -xzf "\${ARCHIVE_PATH}" -C "\${TMP_DIR}"

BINARY_PATH="\${TMP_DIR}/ntn-\${NTN_TARGET}/ntn"
readonly BINARY_PATH
[[ -f "\${BINARY_PATH}" ]] || fail "Downloaded archive did not contain an ntn binary"

install_binary "\${BINARY_PATH}"

printf 'Installed ntn %s to %s/ntn\\n' "\${VERSION}" "\${INSTALL_DIR}" >&2
`

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
 * Used by `lore install`, `lore init` no-arg, and `lore auth --login`
 * when the operator confirms they want to log in.
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
 * Install `ntn` from the Lore-pinned release archive.
 *
 * Inherits stdio so the operator sees the install progress and can
 * interrupt if needed. Blocks until completion. Sets
 * `NOTION_KEYRING=0` in the spawn env for parity with `runNtnLogin`
 * — if a platform-specific package hook chains into a first-run ntn
 * invocation, that invocation also targets file mode.
 *
 * **Spawn env is scrubbed to an allowlist** rather than inheriting
 * the full `process.env`. The install process has no business
 * reading `NOTION_API_TOKEN`, `GITHUB_TOKEN`, npm credentials, or
 * any other token-bearing variables that happen to live in the
 * operator's shell. The allowlist (`buildInstallNtnEnv`) covers what
 * the installer actually needs: shell + locale + proxy +
 * `HOME`/`PATH`/`USER`/temp-dir variables, optional
 * `NTN_INSTALL_DIR`, plus `NOTION_KEYRING=0`.
 *
 * The function does NOT prompt for confirmation. Consumers must
 * confirm with the operator before calling.
 *
 * On success, drops the `isNtnInstalled` / `getNtnVersion` probe
 * cache so a follow-up probe in the same process sees the freshly
 * installed binary instead of the pre-install null result.
 */
export async function installNtn(): Promise<NtnInstallResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn("bash", ["-c", VERIFIED_NTN_INSTALL_SCRIPT], {
        stdio: "inherit",
        shell: false,
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
 * - Install location: `NTN_INSTALL_DIR`
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
  "NTN_INSTALL_DIR",
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
