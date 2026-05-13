/**
 * Shared filesystem debounce marker for the read-only schema drift check
 * fired by `VaultManager.load()`. Same shape and purpose as the digest
 * marker: when a hot startup path (MCP server, shell hooks) passes
 * `driftCheck: "debounced"` to `initServicesFromConfig`, the marker
 * mtime decides whether we run the drift scan or skip it for this fire.
 *
 * Keyed on a short hash of the config root so multiple worktrees pointing
 * at the same vault share a single suppression window — without that
 * keying, every worktree would rediscover drift independently and the
 * debounce would lose most of its value on agents who rotate worktrees
 * for stacked PR work. Key derivation lives in the shared marker-key
 * helper so the truncation tradeoff stays in lockstep across every
 * filesystem marker.
 *
 * Reuses `getStateDir()` so `LORE_HOOK_STATE_DIR` overrides
 * (parallel test files) flow through automatically.
 */

import { mkdir, stat, utimes, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { getStateDir } from "./lock.js"
import { configKey } from "./marker-key.js"

/**
 * Days between debounced drift checks. A week is the same window as the
 * auto-digest scheduler — long enough that hot-path callers don't pay the
 * drift tax on every fire, short enough that an operator who lands a
 * schema-extending change still gets nudged within one workweek.
 */
export const DRIFT_DEBOUNCE_DAYS = 7

export function driftMarkerPath(configRoot: string): string {
  return join(getStateDir(), `drift.${configKey(configRoot)}.last`)
}

/**
 * Days between the marker's mtime and `now`. Returns `Infinity` when the
 * marker is missing so callers treat a fresh install as "always stale" and
 * fire drift on the first debounced load.
 */
export async function driftMarkerAgeDays(
  configRoot: string,
  now: Date = new Date(),
): Promise<number> {
  try {
    const stats = await stat(driftMarkerPath(configRoot))
    return (now.getTime() - stats.mtimeMs) / 86_400_000
  } catch {
    return Infinity
  }
}

export async function touchDriftMarker(configRoot: string): Promise<void> {
  await mkdir(getStateDir(), { recursive: true })
  const path = driftMarkerPath(configRoot)
  try {
    const now = new Date()
    await utimes(path, now, now)
  } catch {
    await writeFile(path, "")
  }
}
