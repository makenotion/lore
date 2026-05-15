import type { LoreServices } from "../../server.js"
import { toolError } from "../../helpers.js"
import type { ToolResult } from "./types.js"

export async function handleArchive(
  services: LoreServices,
  args: { memoryId: string }
): Promise<ToolResult> {
  try {
    await services.memories.archive(args.memoryId)
    // `lore-memory archive` can archive `Kind = decision` rows, while
    // DecisionService keeps positive getById reads in a 30s id cache.
    // Clear it so same-process decision reads cannot serve a just-
    // archived decision until the TTL expires.
    services.decisions.clearCache()
    return {
      content: [{ type: "text", text: `Archived memory ${args.memoryId}` }],
      costOutputs: { memoriesArchived: 1 },
    }
  } catch (err) {
    return toolError(err)
  }
}
