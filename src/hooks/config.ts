/**
 * Hook config shape + defaulting policy.
 *
 * Kept separate from `helpers.ts` because that module runs `main()` at import
 * time. Pulling the pure helpers out keeps them importable from tests and
 * from anywhere else that needs to know what a missing flag means.
 */

import type { LoreConfig } from "../types.js"

/** Real user messages between structured AI-driven saves, when unset. */
export const DEFAULT_SAVE_INTERVAL = 5

export interface HookConfig {
  saveInterval: number
  autoSave: boolean
  wakeUp: boolean
  projectName: string | null
}

/**
 * Merge a `.lore.yaml` hooks section with built-in defaults.
 *
 * `autoSave` and `wakeUp` default to true: hooks are opt-out, not opt-in, once
 * the integration is installed. Users who want to suppress either set the flag
 * to `false` explicitly.
 */
export function mergeHookDefaults(
  hooks: LoreConfig["hooks"] | undefined,
  projectName: string | null = null,
): HookConfig {
  return {
    saveInterval: hooks?.saveInterval ?? DEFAULT_SAVE_INTERVAL,
    autoSave: hooks?.autoSave ?? true,
    wakeUp: hooks?.wakeUp ?? true,
    projectName,
  }
}
