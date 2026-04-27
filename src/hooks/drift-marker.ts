/**
 * Shared filesystem debounce marker for the read-only schema drift check
 * fired by `VaultManager.load()`. Same shape and purpose as
 * `digest-marker.ts`: when a hot startup path (MCP server, shell hooks)
 * passes `driftCheck: "debounced"` to `initServicesFromConfig`, the marker
 * mtime decides whether we run the drift scan or skip it for this fire.
 *
 * Keyed on a short hash of the config root so multiple worktrees pointing
 * at the same vault share a single suppression window — without that
 * keying, every worktree would rediscover drift independently and the
 * debounce would lose most of its value on agents who rotate worktrees
 * for stacked PR work. The hash is truncated to 8 hex chars because
 * collisions across an operator's own config roots are a theoretical
 * concern and we prefer short filenames; same posture as
 * `digest-marker.ts`. If the two markers ever need to compose with each
 * other (e.g. cross-marker invariants), lift `configKey` to a shared
 * helper so they stay in lockstep on the truncation tradeoff.
 *
 * Reuses `getStateDir()` from `lock.ts` so `LORE_HOOK_STATE_DIR` overrides
 * (parallel test files) flow through automatically.
 */

import { createHash } from "node:crypto"
import { mkdir, stat, utimes, writeFile } from "node:fs/promises"
import { join, resolve as resolvePath } from "node:path"
import { getStateDir } from "./lock.js"

/**
 * Days between debounced drift checks. A week is the same window as the
 * auto-digest scheduler — long enough that hot-path callers don't pay the
 * drift tax on every fire, short enough that an operator who lands a
 * schema-extending change still gets nudged within one workweek.
 */
export const DRIFT_DEBOUNCE_DAYS = 7

function configKey(configRoot: string): string {
  return createHash("sha256").update(resolvePath(configRoot)).digest("hex").slice(0, 8)
}

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
