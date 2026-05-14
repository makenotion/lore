/**
 * Phase 3 profile installer.
 *
 * Installs an external profile bundle into
 * `<configRoot>/.lore/profiles/installed/<name>/<version>/` after staging,
 * validating, computing the manifest digest, and (in non-interactive
 * mode) requiring an exact allow-list match in `.lore.yaml`.
 *
 * Sources supported in Phase 3:
 *
 *   - Local filesystem path that points at the bundle root containing
 *     `profile.yaml`. No repo-root discovery, no subdir selection.
 *   - Git URL pinned to an exact 40-hex commit SHA in the
 *     `git@host:org/repo.git#<sha>` or `https://host/org/repo.git#<sha>`
 *     form. Branches and tags are rejected even when they currently
 *     resolve to the same commit.
 *
 * Distribution requires immutable, versioned bundles: once an
 * `<configRoot>/.lore/profiles/installed/<name>/<version>/` directory
 * exists with a recorded digest, install is either a same-digest no-op
 * or a fail-closed.
 */

import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, resolve } from "node:path"

import type { ProfilesAllowedInstallSource } from "../types.js"
import {
  INSTALLED_PROFILES_LOCK_FILENAME,
  INSTALLED_PROFILES_REL,
  LOCAL_PROFILES_REL,
  ProfileLoadError,
  isProfileBundleRoot,
  loadProfileFromRoot,
  tryBundledProfileRoot,
  type ResolvedProfile,
} from "./index.js"

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/

export interface InstallSourceLocal {
  kind: "path"
  path: string
}

export interface InstallSourceGit {
  kind: "git"
  url: string
  commit: string
}

export type InstallSource = InstallSourceLocal | InstallSourceGit

export interface ProfilesLockEntry {
  name: string
  version: string
  source:
    | { kind: "git"; url: string; commit: string }
    | { kind: "path"; path: string }
  manifestDigest: string
  installedAt: string
}

export interface ProfilesLock {
  profiles: Record<string, ProfilesLockEntry>
}

export interface InstallPreview {
  source: InstallSource
  bundleRoot: string
  profile: ResolvedProfile
  manifestDigest: string
  installTarget: string
  collision: InstallCollision
  shadowing: InstallShadowing
  cleanup: () => void
}

export type InstallCollision =
  | { kind: "none" }
  | { kind: "same-digest" }
  | { kind: "different-digest"; existingDigest: string }

export type InstallShadowing =
  | { kind: "none" }
  | {
      kind: "local-shadow"
      localDir: string
      localDigest: string
      sameDigest: boolean
    }
  | {
      kind: "built-in-shadow"
      builtInDir: string
      builtInDigest: string
      sameDigest: boolean
    }

export interface InstallOptions {
  configRoot: string
  source: InstallSource
  /**
   * When true, treat install as a non-interactive automated run. The
   * caller is responsible for validating allow-list match using
   * `findAllowedInstallSourceMatch` before invoking `applyInstall`.
   * The applyInstall step itself enforces collision rules either way.
   */
  yes?: boolean
}

export interface InstallApplyResult {
  /** New or refreshed lock entry written to disk. */
  entry: ProfilesLockEntry
  /** Effective install state after apply. */
  outcome: "installed" | "already-installed"
  installTarget: string
}

export class ProfileInstallError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProfileInstallError"
  }
}

/**
 * Parse a CLI-facing source string into an `InstallSource`. Accepted
 * forms:
 *
 *   - Local: any path that is not parsable as a git URL — resolved
 *     against `cwd` when relative. Must point at a directory containing
 *     `profile.yaml`.
 *   - Git: `git@host:org/repo.git#<40-hex-sha>` or
 *     `<scheme>://host/org/repo.git#<40-hex-sha>`. Branches and tags
 *     are rejected. The fragment MUST be present.
 */
export function parseInstallSource(raw: string, cwd: string): InstallSource {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new ProfileInstallError("Install source cannot be empty.")
  }
  if (looksLikeGitUrl(trimmed)) {
    return parseGitInstallSource(trimmed)
  }
  const path = isAbsolute(trimmed) ? trimmed : resolve(cwd, trimmed)
  return { kind: "path", path }
}

function looksLikeGitUrl(raw: string): boolean {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) && /\.git(?:#|$)/i.test(raw)) return true
  if (raw.startsWith("git@") && /\.git(?:#|$)/i.test(raw)) return true
  return false
}

function parseGitInstallSource(raw: string): InstallSourceGit {
  const hashIdx = raw.indexOf("#")
  if (hashIdx === -1) {
    throw new ProfileInstallError(
      `Git install sources must pin an exact commit SHA: ${raw}#<40-hex-sha>. Branches and tags are not accepted in Phase 3.`
    )
  }
  const url = raw.slice(0, hashIdx)
  const commit = raw.slice(hashIdx + 1)
  if (!COMMIT_SHA_PATTERN.test(commit)) {
    throw new ProfileInstallError(
      `Git install commit must be a 40-character lowercase hex SHA, got: ${commit}.`
    )
  }
  if (!/\.git$/i.test(url)) {
    throw new ProfileInstallError(
      `Git install source URL must end in .git, got: ${url}.`
    )
  }
  return { kind: "git", url, commit }
}

/**
 * Stage, validate, and digest the requested source without writing to the
 * installed-target directory. Returns a preview object that the CLI uses
 * to render the trust summary; call `applyInstall` to commit, or
 * `preview.cleanup()` to discard.
 *
 * Throws `ProfileInstallError` on validation failure or destructive
 * collisions (local-shadow with different digest, built-in collision
 * with different digest).
 */
export function previewInstall(options: InstallOptions): InstallPreview {
  const stage = stageSource(options.source)
  let profile: ResolvedProfile
  try {
    assertBundleContainsNoSymlinks(stage.bundleRoot)
    profile = loadProfileFromRoot(stage.bundleRoot, { source: "external" })
  } catch (err) {
    stage.cleanup()
    if (err instanceof ProfileLoadError) {
      throw new ProfileInstallError(`Invalid profile bundle: ${err.message}`)
    }
    throw err
  }

  const installTarget = resolve(
    options.configRoot,
    INSTALLED_PROFILES_REL,
    profile.name,
    profile.version
  )
  const collision = checkInstallCollision(installTarget, profile.manifestDigest)
  const shadowing = checkInstallShadowing(
    options.configRoot,
    profile.name,
    profile.version,
    profile.manifestDigest
  )

  if (shadowing.kind === "local-shadow" && !shadowing.sameDigest) {
    stage.cleanup()
    throw new ProfileInstallError(
      `Refusing to install ${profile.name}@${profile.version}: a project-local profile at ${shadowing.localDir} with a different manifest digest would shadow this install. Resolve the local copy first (remove or align it) or pick a different version.`
    )
  }
  if (shadowing.kind === "built-in-shadow" && !shadowing.sameDigest) {
    stage.cleanup()
    throw new ProfileInstallError(
      `Refusing to install ${profile.name}@${profile.version}: a built-in profile at ${shadowing.builtInDir} with a different manifest digest would shadow this install. Built-in resolution wins over installed external; pick a different version.`
    )
  }
  if (collision.kind === "different-digest") {
    stage.cleanup()
    throw new ProfileInstallError(
      `Refusing to install ${profile.name}@${profile.version}: ${installTarget} already exists with a different manifest digest (${collision.existingDigest}). Phase 3 has no --force; pick a new version or remove the existing directory manually.`
    )
  }

  return {
    source: options.source,
    bundleRoot: stage.bundleRoot,
    profile,
    manifestDigest: profile.manifestDigest,
    installTarget,
    collision,
    shadowing,
    cleanup: stage.cleanup,
  }
}

/**
 * Commit a previewed install. Idempotent: if the install target already
 * exists with the same digest, the function only refreshes the lock-file
 * entry and reports `already-installed`.
 *
 * `applyInstall` does NOT enforce allow-list match — the CLI is
 * responsible for calling `findAllowedInstallSourceMatch` before reaching
 * this entrypoint when `--yes` is set.
 */
export function applyInstall(
  preview: InstallPreview,
  configRoot: string
): InstallApplyResult {
  let removePartialTarget = false
  try {
    if (preview.collision.kind === "same-digest") {
      verifyInstalledBundle(preview)
      const entry = recordLockEntry(configRoot, preview)
      return {
        entry,
        outcome: "already-installed",
        installTarget: preview.installTarget,
      }
    }
    mkdirSync(preview.installTarget, { recursive: true })
    removePartialTarget = true
    cpSync(preview.bundleRoot, preview.installTarget, { recursive: true })
    verifyInstalledBundle(preview)
    const entry = recordLockEntry(configRoot, preview)
    removePartialTarget = false
    return {
      entry,
      outcome: "installed",
      installTarget: preview.installTarget,
    }
  } catch (err) {
    if (removePartialTarget) {
      rmSync(preview.installTarget, { recursive: true, force: true })
    }
    throw err
  } finally {
    preview.cleanup()
  }
}

interface StageResult {
  bundleRoot: string
  cleanup: () => void
}

function stageSource(source: InstallSource): StageResult {
  if (source.kind === "path") {
    return stageLocalSource(source)
  }
  return stageGitSource(source)
}

function stageLocalSource(source: InstallSourceLocal): StageResult {
  if (!isProfileBundleRoot(source.path)) {
    throw new ProfileInstallError(
      `Local install source ${source.path} is not a profile bundle root (no profile.yaml found). Phase 3 does not search subdirectories or repo roots.`
    )
  }
  const tempDir = mkdtempSync(join(tmpdir(), "lore-profile-install-"))
  const bundleRoot = join(tempDir, "bundle")
  const cleanup = (): void => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Best-effort: tmp lives under OS temp; cleanup failure is non-fatal.
    }
  }
  try {
    cpSync(resolve(source.path), bundleRoot, { recursive: true })
  } catch (err) {
    cleanup()
    const message = err instanceof Error ? err.message : String(err)
    throw new ProfileInstallError(
      `Failed to stage local install source ${source.path}: ${message}.`
    )
  }
  return { bundleRoot, cleanup }
}

function verifyInstalledBundle(preview: InstallPreview): void {
  assertBundleContainsNoSymlinks(preview.installTarget)
  let installed: ResolvedProfile
  try {
    installed = loadProfileFromRoot(preview.installTarget, {
      source: "external",
      selector: preview.profile.selector,
    })
  } catch (err) {
    if (err instanceof ProfileLoadError) {
      throw new ProfileInstallError(
        `Installed profile verification failed: ${err.message}`
      )
    }
    throw err
  }
  if (installed.manifestDigest !== preview.manifestDigest) {
    throw new ProfileInstallError(
      `Installed profile verification failed: digest mismatch after copy (${installed.manifestDigest} != ${preview.manifestDigest}).`
    )
  }
}

function assertBundleContainsNoSymlinks(bundleRoot: string): void {
  function walk(path: string, rel: string): void {
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(path)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProfileInstallError(`Failed to inspect ${path}: ${message}`)
    }
    if (st.isSymbolicLink()) {
      const label = rel.length > 0 ? rel : "."
      throw new ProfileInstallError(
        `Profile bundle contains symlink ${label}. Symlinks are not allowed because installed profiles must be immutable after digest approval.`
      )
    }
    if (!st.isDirectory()) return
    let entries: string[]
    try {
      entries = readdirSync(path)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new ProfileInstallError(`Failed to inspect ${path}: ${message}`)
    }
    for (const entry of entries) {
      walk(join(path, entry), rel.length > 0 ? `${rel}/${entry}` : entry)
    }
  }
  walk(bundleRoot, "")
}

function stageGitSource(source: InstallSourceGit): StageResult {
  const tempDir = mkdtempSync(join(tmpdir(), "lore-profile-install-"))
  const cleanup = (): void => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Best-effort: tmp lives under OS temp; cleanup failure is non-fatal.
    }
  }
  try {
    execFileSync("git", ["init", "--quiet"], { cwd: tempDir, stdio: "ignore" })
    execFileSync("git", ["remote", "add", "origin", source.url], {
      cwd: tempDir,
      stdio: "ignore",
    })
    execFileSync(
      "git",
      ["fetch", "--depth=1", "--quiet", "origin", source.commit],
      { cwd: tempDir, stdio: "ignore" }
    )
    execFileSync("git", ["checkout", "--quiet", "FETCH_HEAD"], {
      cwd: tempDir,
      stdio: "ignore",
    })
  } catch (err) {
    cleanup()
    const message = err instanceof Error ? err.message : String(err)
    throw new ProfileInstallError(
      `Failed to fetch ${source.url}#${source.commit}: ${message}. ` +
        `Confirm the URL is reachable and the commit SHA exists.`
    )
  }
  if (!isProfileBundleRoot(tempDir)) {
    cleanup()
    throw new ProfileInstallError(
      `Git checkout of ${source.url}#${source.commit} did not contain profile.yaml at the repository root. Phase 3 requires the bundle to live at the repo root.`
    )
  }
  return { bundleRoot: tempDir, cleanup }
}

/**
 * Check the installed-external target for an existing same/different-digest
 * directory.
 */
export function checkInstallCollision(
  installTarget: string,
  manifestDigest: string
): InstallCollision {
  if (!existsSync(installTarget)) return { kind: "none" }
  if (!isProfileBundleRoot(installTarget)) {
    return { kind: "different-digest", existingDigest: "<not-profile-bundle>" }
  }
  let existing: ResolvedProfile
  try {
    existing = loadProfileFromRoot(installTarget, { source: "external" })
  } catch {
    return { kind: "different-digest", existingDigest: "<unreadable>" }
  }
  if (existing.manifestDigest === manifestDigest) return { kind: "same-digest" }
  return { kind: "different-digest", existingDigest: existing.manifestDigest }
}

/**
 * Detect higher-priority resolutions for the same `<name>@<version>`
 * that would shadow this install.
 */
export function checkInstallShadowing(
  configRoot: string,
  name: string,
  version: string,
  manifestDigest: string
): InstallShadowing {
  const localDir = join(configRoot, LOCAL_PROFILES_REL, name, version)
  if (isProfileBundleRoot(localDir)) {
    let localDigest = "<unreadable>"
    try {
      localDigest = loadProfileFromRoot(localDir, { source: "local" }).manifestDigest
    } catch {
      // Fall through with the unreadable sentinel.
    }
    return {
      kind: "local-shadow",
      localDir,
      localDigest,
      sameDigest: localDigest === manifestDigest,
    }
  }
  const builtInRoot = tryBundledProfileRoot(name)
  if (builtInRoot) {
    try {
      const builtIn = loadProfileFromRoot(builtInRoot, { source: "built-in" })
      if (builtIn.version === version) {
        return {
          kind: "built-in-shadow",
          builtInDir: builtInRoot,
          builtInDigest: builtIn.manifestDigest,
          sameDigest: builtIn.manifestDigest === manifestDigest,
        }
      }
    } catch {
      // Built-in failed to load — treat as no shadow.
    }
  }
  return { kind: "none" }
}

/**
 * Read the on-disk `profiles.lock.json`, returning an empty object when
 * the file does not exist. Throws when the file exists but is malformed.
 */
export function readProfilesLock(configRoot: string): ProfilesLock {
  const path = profilesLockPath(configRoot)
  if (!existsSync(path)) return { profiles: {} }
  const raw = readFileSync(path, "utf-8")
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected an object")
    }
    const profiles = (parsed as Record<string, unknown>)["profiles"]
    if (profiles !== undefined && (typeof profiles !== "object" || Array.isArray(profiles))) {
      throw new Error("expected profiles to be an object")
    }
    const out: ProfilesLock = { profiles: {} }
    for (const [key, value] of Object.entries(
      (profiles ?? {}) as Record<string, unknown>
    )) {
      out.profiles[key] = value as ProfilesLockEntry
    }
    return out
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ProfileInstallError(
      `Malformed ${path}: ${message}. Remove or repair the file manually.`
    )
  }
}

export function profilesLockPath(configRoot: string): string {
  return join(configRoot, INSTALLED_PROFILES_REL, INSTALLED_PROFILES_LOCK_FILENAME)
}

function recordLockEntry(
  configRoot: string,
  preview: InstallPreview
): ProfilesLockEntry {
  const lock = readProfilesLock(configRoot)
  const entry: ProfilesLockEntry = {
    name: preview.profile.name,
    version: preview.profile.version,
    source:
      preview.source.kind === "git"
        ? {
            kind: "git",
            url: preview.source.url,
            commit: preview.source.commit,
          }
        : { kind: "path", path: preview.source.path },
    manifestDigest: preview.manifestDigest,
    installedAt: new Date().toISOString(),
  }
  lock.profiles[`${entry.name}@${entry.version}`] = entry
  const path = profilesLockPath(configRoot)
  mkdirSync(join(configRoot, INSTALLED_PROFILES_REL), { recursive: true })
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, { mode: 0o600 })
  return entry
}

/**
 * Check the operator-authored allow-list against the staged source and
 * digest. Returns the matching entry on success, `null` when no entry
 * matches. Caller decides whether to fail open or closed; `lore profile
 * install --yes` requires a match.
 */
export function findAllowedInstallSourceMatch(
  preview: InstallPreview,
  allowedSources: ProfilesAllowedInstallSource[] | undefined,
  configRoot: string
): ProfilesAllowedInstallSource | null {
  if (!allowedSources || allowedSources.length === 0) return null
  for (const entry of allowedSources) {
    if (entry.kind === "git" && preview.source.kind === "git") {
      if (
        entry.url === preview.source.url &&
        entry.commit === preview.source.commit &&
        entry.manifestDigest === preview.manifestDigest
      ) {
        return entry
      }
    } else if (entry.kind === "path" && preview.source.kind === "path") {
      const resolvedPath = isAbsolute(entry.path)
        ? entry.path
        : resolve(configRoot, entry.path)
      if (
        resolve(preview.source.path) === resolve(resolvedPath) &&
        entry.manifestDigest === preview.manifestDigest
      ) {
        return entry
      }
    }
  }
  return null
}

/**
 * Inspect the lock file for an authorized no-op reinstall: the
 * `<name>@<version>` entry must exist, the recorded digest must match
 * the staged digest, and the source descriptor must match.
 */
export function findLockNoOpReinstall(
  configRoot: string,
  preview: InstallPreview
): ProfilesLockEntry | null {
  const lock = readProfilesLock(configRoot)
  const key = `${preview.profile.name}@${preview.profile.version}`
  const entry = lock.profiles[key]
  if (!entry) return null
  if (entry.manifestDigest !== preview.manifestDigest) return null
  if (!isProfileBundleRoot(preview.installTarget)) return null
  if (entry.source.kind !== preview.source.kind) return null
  if (entry.source.kind === "git" && preview.source.kind === "git") {
    if (
      entry.source.url !== preview.source.url ||
      entry.source.commit !== preview.source.commit
    ) {
      return null
    }
    return entry
  }
  if (entry.source.kind === "path" && preview.source.kind === "path") {
    if (resolve(entry.source.path) !== resolve(preview.source.path)) return null
    return entry
  }
  return null
}

/**
 * Compute the manifest digest for an off-disk profile bundle without
 * loading it. Used by `lore profile validate` to surface the same digest
 * an install run would compute, so an operator can pre-populate the
 * allow-list before automation.
 */
export function computeBundleDigest(bundleRoot: string): string {
  const profile = loadProfileFromRoot(bundleRoot, { source: "external" })
  return profile.manifestDigest
}

/**
 * Return every relative file in `dir` for diagnostic listing (the
 * trust-summary contract). Sorted for determinism.
 */
export function listBundleFiles(bundleRoot: string): string[] {
  const out: string[] = []
  function walk(dir: string, rel: string): void {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return
    }
    for (const name of entries) {
      const abs = join(dir, name)
      const relPath = rel.length === 0 ? name : `${rel}/${name}`
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(abs)
      } catch {
        continue
      }
      if (st.isDirectory()) {
        walk(abs, relPath)
      } else {
        out.push(relPath)
      }
    }
  }
  walk(bundleRoot, "")
  return out.sort()
}

/**
 * Compute a sha256 digest over an arbitrary file's bytes. Used by the
 * preview rendering and tests.
 */
export function digestFileSha256(path: string): string {
  const hash = createHash("sha256")
  hash.update(readFileSync(path))
  return `sha256:${hash.digest("hex")}`
}
