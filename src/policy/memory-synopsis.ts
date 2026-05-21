import type { LoreConfig } from "../types/config.js"
import { DEFAULT_MEMORY_SYNOPSIS_MAX } from "../types/domain.js"

/**
 * Resolve the effective `lore-memory` synopsis authoring budget for a
 * process. The config parser enforces the numeric bounds; this helper owns
 * the default so MCP, CLI-backed services, and tests stay aligned.
 */
export function resolveMemorySynopsisMaxChars(
  config?: Pick<LoreConfig, "memory"> | null
): number {
  return config?.memory?.synopsisMaxChars ?? DEFAULT_MEMORY_SYNOPSIS_MAX
}
