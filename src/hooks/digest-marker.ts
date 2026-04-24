/**
 * Shared filesystem debounce marker for digest synthesis. Both the
 * session-end hook and the `lore digest` CLI write this marker so the
 * "≤ 1 digest per project per 7 days" session-end guarantee is respected
 * even when an operator runs the CLI explicitly mid-week.
 *
 * Keyed on a short hash of the config root *plus* the project name so two
 * vaults that both have a `Mail` project in the same user's `$TMPDIR` don't
 * collide — a cross-vault collision would silently debounce the second
 * vault's digest forever. The hash is truncated to 8 hex chars because
 * collisions across an operator's own config roots are a theoretical concern
 * and we prefer short filenames.
 *
 * The slash-to-underscore replacement on the project name guards against
 * path injection from exotic names without coupling to Notion's id format.
 *
 * The state dir is resolved per-call via `getStateDir()` from `lock.ts` so
 * `LORE_HOOK_STATE_DIR` overrides (used by parallel test files for
 * isolation) flow through automatically.
 */

import { createHash } from "node:crypto"
import { stat, writeFile, utimes, mkdir, rm } from "node:fs/promises"
import { join, resolve as resolvePath } from "node:path"
import { getStateDir } from "./lock.js"

function configKey(configRoot: string): string {
  return createHash("sha256").update(resolvePath(configRoot)).digest("hex").slice(0, 8)
}

export function digestMarkerPath(
  configRoot: string,
  projectName: string,
): string {
  const safeName = projectName.replace(/[^A-Za-z0-9_.-]/g, "_")
  return join(getStateDir(), `digest.${configKey(configRoot)}.${safeName}.last`)
}

/**
 * Days between the marker's mtime and `now`. Returns `Infinity` when the
 * marker is missing so callers can treat a fresh install as "always stale".
 */
export async function digestMarkerAgeDays(
  configRoot: string,
  projectName: string,
  now: Date = new Date(),
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
  projectName: string,
): Promise<void> {
  await mkdir(getStateDir(), { recursive: true })
  const path = digestMarkerPath(configRoot, projectName)
  try {
    const now = new Date()
    await utimes(path, now, now)
  } catch {
    await writeFile(path, "")
  }
}

/**
 * Remove the marker for a project. Used by the scheduler to roll back an
 * optimistic touch when the subsequent spawn fails — without the rollback,
 * a transient `claude` binary problem would debounce the next 7 days of
 * retries.
 *
 * No-op when the marker is already absent.
 */
export async function clearDigestMarker(
  configRoot: string,
  projectName: string,
): Promise<void> {
  await rm(digestMarkerPath(configRoot, projectName), { force: true })
}
