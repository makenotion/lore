/**
 * ntn integration module — auth.json reader + interactive shell-out helpers.
 *
 * **TEMPORARY COUPLING WARNING.** This module reads `ntn`'s private
 * storage at `~/.config/notion/auth.json`. The format is undocumented
 * and may change unannounced when `ntn` ships a new version. The
 * coupling is a deliberate bridge until `ntn` ships a supported
 * token-export command — tracked as DEFERRED-OFFICIAL-EXPORT in the
 * milestone DEFERRED.md.
 *
 * When `ntn auth token --plain` (or equivalent) ships, every read site
 * in this module flagged with `// TODO(ntn-export):` swaps for a
 * shell-out to that command. Function signatures stay the same;
 * consumers in `resolveAuth` (#01) are unchanged.
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
   * read of ntn's `config.json`, with a final fallback to undefined
   * (SDK default = prod).
   */
  baseUrl?: string
}

export interface LoadNtnTokenInput {
  workspaceId?: string
}

/**
 * Read the operator's ntn-issued token for a chosen workspace.
 *
 * Selector precedence: explicit `input.workspaceId` > single-workspace
 * auto-pick > error. The caller (resolveAuth in #01) is responsible
 * for resolving `NOTION_WORKSPACE_ID` env / `auth.workspaceId` config
 * into the `workspaceId` argument.
 *
 * Returns null on every "no usable token" failure mode (file missing,
 * malformed, requested workspace absent, multiple workspaces with no
 * selector). Stderr emits a single hint line on the recoverable
 * failure modes; the missing-file path is silent so callers can fall
 * through to deprecated paths without noise.
 */
export async function loadNtnToken(
  input: LoadNtnTokenInput = {}
): Promise<NtnTokenRecord | null> {
  // TODO(ntn-export): Replace this auth.json read with a shell-out to
  // `ntn auth token --plain` (or equivalent) when DEFERRED-OFFICIAL-EXPORT
  // ships. Function signature stays the same; consumers unchanged.
  const path = ntnAuthJsonPath()
  let raw: string
  try {
    raw = await readFile(path, "utf-8")
  } catch {
    // File doesn't exist (operator hasn't run ntn login yet, OR is
    // using keychain mode without NOTION_KEYRING=0). Caller surfaces
    // the recommendation.
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Malformed file. Don't throw — return null and let the caller
    // surface "no auth available." Recovery copy points at `lore auth
    // --login` first because Lore forces NOTION_KEYRING=0 in the
    // spawn env (the file-mode contract this reader relies on); a
    // manual `NOTION_KEYRING=0 ntn login` is the fallback for
    // operators who can't or don't want to go through Lore.
    process.stderr.write(
      `[lore] auth.json at ${path} is malformed; ignoring. ` +
        `Run \`lore auth --login\` to refresh ` +
        `(or \`NOTION_KEYRING=0 ntn login\` directly).\n`
    )
    return null
  }

  // Object-shape guard. `JSON.parse("null")` returns null;
  // `JSON.parse("[1, 2]")` returns an array; `JSON.parse('"x"')`
  // returns a string. All three parse successfully but break
  // `Object.entries` (null) or produce nonsense workspace ids
  // (array → digit-string keys; string → no entries). Treat any
  // non-object root as "no usable file" and return null, same as
  // the parse-failure path. Same recovery copy as above.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    process.stderr.write(
      `[lore] auth.json at ${path} has unexpected shape ` +
        `(expected an object). Run \`lore auth --login\` to refresh ` +
        `(or \`NOTION_KEYRING=0 ntn login\` directly).\n`
    )
    return null
  }

  // Filter to entries with non-empty string-valued tokens. ntn writes
  // additional metadata under reserved keys in some versions — don't
  // trip over those. The type predicate narrows the tuple's value
  // position from `unknown` to `string` so downstream destructures
  // know it's safe.
  const workspaceEntries = Object.entries(parsed as Record<string, unknown>).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0
  )

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
      process.stderr.write(
        `[lore] ntn auth.json carries ${workspaceEntries.length} ` +
          `workspace(s), but the requested workspaceId ` +
          `(${input.workspaceId}) is not among them. ` +
          `Available: ${workspaceEntries.map(([ws]) => ws).join(", ")}.\n` +
          `[lore] Run \`ntn login\` against the right workspace, or ` +
          `update auth.workspaceId in .lore.yaml.\n`
      )
      return null
    }
  } else if (workspaceEntries.length === 1) {
    pick = workspaceEntries[0]!
  } else {
    // Multiple workspaces, no selector. Surface the choice.
    process.stderr.write(
      `[lore] ntn auth.json carries ${workspaceEntries.length} ` +
        `workspaces; specify one via NOTION_WORKSPACE_ID env or ` +
        `auth.workspaceId in .lore.yaml.\n` +
        `[lore] Available: ${workspaceEntries.map(([ws]) => ws).join(", ")}.\n`
    )
    return null
  }

  return {
    token: pick[1],
    workspaceId: pick[0],
    baseUrl: await resolveNtnBaseUrl(),
  }
}

/**
 * Enumerate workspace ids in ntn's `auth.json`. Used by `lore auth
 * --status` (#06) in the no-vault-context branch to surface the
 * operator's auth.json footprint without requiring a `.lore.yaml`.
 *
 * Returns empty array on every "no usable file" failure mode so
 * consumers can treat empty as "nothing to show" without
 * distinguishing reasons.
 */
export async function listNtnWorkspaces(): Promise<string[]> {
  // TODO(ntn-export): Replace this auth.json read with `ntn auth
  // workspaces --json` (or equivalent) when DEFERRED-OFFICIAL-EXPORT
  // ships.
  const path = ntnAuthJsonPath()
  let raw: string
  try {
    raw = await readFile(path, "utf-8")
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return []
  }
  return Object.entries(parsed as Record<string, unknown>)
    .filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" && entry[1].length > 0
    )
    .map(([workspaceId]) => workspaceId)
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
 * environment. Reads `~/.config/notion/config.json` if present;
 * `LORE_NOTION_BASE_URL` env override always wins; final fallback
 * is undefined (the SDK uses its prod default).
 *
 * The exact config.json shape is undocumented. Best-effort read with
 * a hard fallback. When DEFERRED-OFFICIAL-EXPORT ships, `ntn auth
 * token --json` likely returns the base URL alongside the token,
 * eliminating this read.
 */
async function resolveNtnBaseUrl(): Promise<string | undefined> {
  if (process.env["LORE_NOTION_BASE_URL"]) {
    return process.env["LORE_NOTION_BASE_URL"]
  }
  // TODO(ntn-export): Replace this config.json read with a value
  // pulled from `ntn auth token --json` when DEFERRED-OFFICIAL-EXPORT
  // ships.
  const configPath = ntnAuthJsonPath().replace(/auth\.json$/, "config.json")
  try {
    const raw = await readFile(configPath, "utf-8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const env = typeof parsed["env"] === "string" ? parsed["env"] : "prod"
    if (env === "dev") return "https://api-dev.notion.com"
    if (env === "stg") return "https://api-stg.notion.com"
    return undefined
  } catch {
    return undefined
  }
}

/**
 * Probe whether `ntn` is installed on PATH. Used by `lore install`
 * (#08) and `lore auth --status` (#06) to surface clear messaging
 * when the operator hasn't installed ntn yet.
 *
 * Cheap synchronous probe with a 1-second timeout. Returns false on
 * any error (not-found, permission denied, etc.) — never throws.
 */
export function isNtnInstalled(): boolean {
  try {
    execFileSync("ntn", ["--version"], { stdio: "pipe", timeout: 1000 })
    return true
  } catch {
    return false
  }
}

/**
 * Lore's tested-against minimum `ntn` version. Below this, Lore warns
 * but does not block — operators preferring an older version for
 * other reasons keep using it; their `auth.json` shape may differ
 * but the reader degrades gracefully (returns null).
 *
 * Bumped only when a new ntn version ships an `auth.json` shape
 * change Lore needs to handle, OR when DEFERRED-OFFICIAL-EXPORT
 * lands and Lore prefers `ntn auth token --plain`.
 */
export const MIN_NTN_VERSION = "0.12.0"

/**
 * The canonical install command `ntn` itself recommends when asked
 * to self-update on a package-manager install (per the binary's own
 * error message: "reinstall with `curl -fsSL https://ntn.dev | bash`").
 * Lore uses this for the auto-install path in #08 / #09 / #06 / #07
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
 */
export function getNtnVersion(): string | null {
  try {
    const output = execFileSync("ntn", ["--version"], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      timeout: 1000,
    })
    // `ntn --version` prints "ntn 0.12.0" (or with a build suffix).
    const match = output.trim().match(/(\d+\.\d+\.\d+)/)
    return match ? match[1]! : null
  } catch {
    return null
  }
}

/**
 * Compare the installed ntn version against `MIN_NTN_VERSION`.
 *
 * - `"unknown"` — ntn not installed or version unparseable
 * - `"too-old"` — installed version < MIN_NTN_VERSION
 * - `"ok"` — installed version >= MIN_NTN_VERSION
 *
 * Per the "prefer existing version" rollout policy, `"too-old"` is
 * informational — Lore never auto-upgrades. Consumers (#06 / #08)
 * print a warning and proceed.
 */
export function checkNtnVersion(): "unknown" | "too-old" | "ok" {
  const installed = getNtnVersion()
  if (!installed) return "unknown"
  return compareSemver(installed, MIN_NTN_VERSION) < 0 ? "too-old" : "ok"
}

/**
 * Minimal SemVer comparison sufficient for `0.X.Y` style versions.
 * Returns -1 / 0 / 1. Doesn't handle pre-release suffixes; ntn's
 * release shape is stable major.minor.patch per the binary
 * inspection. Harden if ntn ever ships pre-releases.
 */
function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    const ai = pa[i] ?? 0
    const bi = pb[i] ?? 0
    if (ai !== bi) return ai < bi ? -1 : 1
  }
  return 0
}

export type NtnLoginResult =
  | { kind: "success" }
  | { kind: "exit-non-zero"; code: number }
  | { kind: "spawn-error"; error: unknown }

/**
 * Spawn `ntn login` interactively. Inherits stdio so the operator
 * interacts with ntn's prompts (workspace picker, browser
 * confirmation) directly. Blocks until ntn exits.
 *
 * **Forces `NOTION_KEYRING=0` in the spawn env** so the resulting
 * token lands in `~/.config/notion/auth.json` (file mode) where
 * `loadNtnToken` can read it. This is the load-bearing piece of the
 * "Option A" seamless-onboarding posture — engineers don't have to
 * set the env var in their shell rc; Lore handles it at the boundary
 * for any ntn invocation it triggers. Operators who later run
 * `ntn login` directly (outside Lore) without the env var fall
 * through to ntn's default keychain mode; that scenario is
 * documented in the runbook (#05) as a known gotcha.
 *
 * Used by `lore install` (#08), `lore init` no-arg (#09), `lore auth
 * --login` (#06), and `lore auth --migrate` (#07) when the operator
 * confirms they want to log in.
 *
 * The function does NOT prompt the operator — it just runs the
 * spawn. Confirmation prompts live in the consumer per their UX
 * shape.
 *
 * Returns a discriminated outcome so consumers can route on success
 * / exit-non-zero / spawn-error without try/catch ladders.
 */
export async function runNtnLogin(): Promise<NtnLoginResult> {
  return new Promise((resolve) => {
    try {
      const child = spawn("ntn", ["login"], {
        stdio: "inherit",
        shell: false,
        env: { ...process.env, NOTION_KEYRING: "0" },
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
 * The function does NOT prompt for confirmation. Consumers must
 * confirm with the operator before calling — auto-installing
 * without explicit consent would surprise operators with a
 * curl-pipe-bash they didn't authorize.
 *
 * On success, the caller should re-run any version / install probe
 * (the just-installed binary is now on PATH).
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
        env: { ...process.env, NOTION_KEYRING: "0" },
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
