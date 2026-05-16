/**
 * Shared filesystem debounce marker for digest synthesis. Both the
 * Stop-triggered auto-digest helper and the `lore digest` CLI write this
 * marker so the "≤ 1 digest per project per 7 days" guarantee is respected
 * even when an operator runs the CLI explicitly mid-week.
 *
 * Keyed on a short hash of the config root *plus* the project name so two
 * vaults that both have a project with the same name in the same user's
 * `$TMPDIR` don't collide — a cross-vault collision would silently debounce the second
 * vault's digest forever. Key derivation and segment sanitization live
 * in the shared marker-key helper so this module, the drift marker,
 * and the lock / log / count paths stay in lockstep on the truncation
 * length and the sanitization charset.
 *
 * The state dir is resolved per-call via `getStateDir()` so
 * `LORE_HOOK_STATE_DIR` overrides (used by parallel test files for
 * isolation) flow through automatically.
 */

import { stat, utimes, rm } from "node:fs/promises"
import { join } from "node:path"
import { getStateDir } from "./lock.js"
import {
  configKey,
  ensureHookStateDir,
  ensureHookStateFileMode,
  safeFilenameSegment,
  writeHookStateFile,
} from "./marker-key.js"

export function digestMarkerPath(configRoot: string, projectName: string): string {
  return join(
    getStateDir(),
    `digest.${configKey(configRoot)}.${safeFilenameSegment(projectName)}.last`
  )
}

/**
 * Days between the marker's mtime and `now`. Returns `Infinity` when the
 * marker is missing so callers can treat a fresh install as "always stale".
 */
export async function digestMarkerAgeDays(
  configRoot: string,
  projectName: string,
  now: Date = new Date()
): Promise<number> {
  try {
    const stats = await stat(digestMarkerPath(configRoot, projectName))
    return (now.getTime() - stats.mtimeMs) / 86_400_000
  } catch {
    return Infinity
  }
}

export async function touchDigestMarker(
  configRoot: string,
  projectName: string
): Promise<void> {
  await ensureHookStateDir(getStateDir())
  const path = digestMarkerPath(configRoot, projectName)
  try {
    const now = new Date()
    await utimes(path, now, now)
    await ensureHookStateFileMode(path)
  } catch {
    await writeHookStateFile(path, "")
  }
}

/**
 * Remove the marker for a project. Used by the scheduler to roll back an
 * optimistic touch when the subsequent spawn fails — without the rollback,
 * a transient `claude` binary problem would debounce the next 7 days of
 * retries.
 *
 * No-op when the marker is already absent.
 *
 * Unlike `touchDigestMarker`, this helper intentionally does not `mkdir`
 * the state dir: `rm({ force: true })` already tolerates a missing path
 * (file or any parent), so ensuring the dir before deletion would be
 * wasted I/O on every rollback.
 */
export async function clearDigestMarker(
  configRoot: string,
  projectName: string
): Promise<void> {
  await rm(digestMarkerPath(configRoot, projectName), { force: true })
}
