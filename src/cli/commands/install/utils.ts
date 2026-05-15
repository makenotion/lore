import { readFile, writeFile, mkdir, access, rename, unlink } from "node:fs/promises"
import { dirname } from "node:path"
import { homedir } from "node:os"
import { createInterface } from "node:readline/promises"
import type { HookStatus } from "./types.js"

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return false
  if (typeof a !== typeof b) return false
  if (typeof a !== "object") return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  const aObj = a as Record<string, unknown>
  const bObj = b as Record<string, unknown>
  const aKeys = Object.keys(aObj)
  const bKeys = Object.keys(bObj)
  if (aKeys.length !== bKeys.length) return false
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false
    if (!deepEqual(aObj[key], bObj[key])) return false
  }
  return true
}

/**
 * Rewrite an absolute path under the user's home directory into a portable
 * `${HOME}`-prefixed form for project config that may be committed and shared.
 */
export function toPortablePath(absPath: string): string {
  const home = homedir()
  // A home of "/" would turn every absolute path into a `${HOME}` path.
  if (home === "/" || home === "") return absPath
  if (absPath === home) return "${HOME}"
  const prefix = home.endsWith("/") ? home : home + "/"
  if (absPath.startsWith(prefix)) {
    return "${HOME}/" + absPath.slice(prefix.length)
  }
  return absPath
}

/**
 * Display-format an absolute path, replacing the user's home directory with
 * `~`. Anchors at the home prefix so a path like
 * `/Users/foo/work/Users/foo/legacy` doesn't get its inner occurrence
 * mangled — the unanchored `String.replace(homedir(), "~")` shortcut hits
 * the first match, which may be the wrong one.
 */
export function displayHomePath(absPath: string): string {
  const home = homedir()
  if (home === "/" || home === "") return absPath
  if (absPath === home) return "~"
  const prefix = home.endsWith("/") ? home : home + "/"
  if (absPath.startsWith(prefix)) {
    return "~/" + absPath.slice(prefix.length)
  }
  return absPath
}

export async function readJsonSafe(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(filePath, "utf-8")
    try {
      return JSON.parse(raw) as Record<string, unknown>
    } catch (err) {
      throw new Error(
        `Failed to parse ${filePath}: ${err instanceof Error ? err.message : err}`,
        { cause: err }
      )
    }
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") return {}
    throw err
  }
}

export async function readTextSafe(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf-8")
  } catch (err: unknown) {
    if ((err as { code?: string }).code === "ENOENT") return ""
    throw err
  }
}

export async function writeJsonFile(
  filePath: string,
  data: Record<string, unknown>
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  // Write to a sibling temp file and rename so a failed write never leaves a
  // half-written config on disk.
  const tmpPath = `${filePath}.${process.pid}.tmp`
  try {
    await writeFile(tmpPath, JSON.stringify(data, null, 2) + "\n", "utf-8")
    await rename(tmpPath, filePath)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}

export async function writeTextFile(filePath: string, data: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const tmpPath = `${filePath}.${process.pid}.tmp`
  const normalized = data.endsWith("\n") ? data : data + "\n"
  try {
    await writeFile(tmpPath, normalized, "utf-8")
    await rename(tmpPath, filePath)
  } catch (err) {
    await unlink(tmpPath).catch(() => {})
    throw err
  }
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export async function confirm(
  rl: ReturnType<typeof createInterface> | null,
  message: string,
  defaultYes = true
): Promise<boolean> {
  if (!rl) return defaultYes
  const suffix = defaultYes ? "[Y/n]" : "[y/N]"
  const answer = await rl.question(`${message} ${suffix} `)
  const normalized = answer.trim().toLowerCase()
  if (normalized === "") return defaultYes
  return normalized === "y" || normalized === "yes"
}

export function statusLabel(status: HookStatus, legacyPaths: boolean): string {
  if (status === "current") return "already installed"
  // Under legacy absolute-path mode, a `legacy-current` entry IS the desired
  // shape — it should read as already installed. Under bin-dispatch
  // (default), the same entry is upgrade-eligible.
  if (status === "legacy-current") {
    return legacyPaths ? "already installed" : "legacy form (will upgrade)"
  }
  if (status === "stale") return "update available"
  return "not installed"
}

/**
 * Post-write status line for the install summary. Differentiates
 * "rewrote a legacy-current entry to bin-dispatch" from a fresh write
 * so an operator running `lore install` after upgrading from 0.10.x
 * sees an explicit signal that their committed config diff is
 * intentional, not a hand-rolled drift fix.
 */
export function postWriteLabel(prevStatus: HookStatus, legacyPaths: boolean): string {
  if (prevStatus === "legacy-current" && !legacyPaths) {
    return "upgraded (legacy → bin-dispatch)"
  }
  return "installed"
}

/**
 * Whether the on-disk hook status matches the desired install shape.
 */
export function isEffectivelyCurrent(status: HookStatus, legacyPaths: boolean): boolean {
  return legacyPaths ? status === "legacy-current" : status === "current"
}
