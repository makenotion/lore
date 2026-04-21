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
  /**
   * Name of the catch-all project (path `"."` or `""`) in this workspace, if
   * configured. The save prompts name it explicitly and tell the AI to avoid
   * defaulting to it for sub-project-specific work.
   */
  catchAllName: string | null
  /**
   * Non-catch-all project names from the config, in declaration order. Used
   * by the save prompts to enumerate the buckets the AI should pick from.
   */
  subProjects: string[]
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
  catchAllName: string | null = null,
  subProjects: string[] = [],
): HookConfig {
  return {
    saveInterval: hooks?.saveInterval ?? DEFAULT_SAVE_INTERVAL,
    autoSave: hooks?.autoSave ?? true,
    wakeUp: hooks?.wakeUp ?? true,
    catchAllName,
    subProjects,
  }
}
