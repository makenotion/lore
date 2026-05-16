import type { LoreServices } from "../../server.js"
import { toolError } from "../../helpers.js"
import { resolveReadProjectScope } from "../../resolve.js"
import { gatherDigestData } from "../../../core/digest.js"
import type { ToolResult } from "./types.js"

export async function handleDigest(
  services: LoreServices,
  args: {
    period?: "day" | "week"
    since?: string
    until?: string
    projectName?: string
  }
): Promise<ToolResult> {
  try {
    const { projectId, project } = await resolveReadProjectScope(
      services,
      args.projectName
    )
    const projectLabel = project?.name ?? "vault-wide"

    const digest = await gatherDigestData(services, {
      projectId,
      projectLabel,
      since: args.since,
      until: args.until,
      period: args.period,
    })

    const parts: string[] = [digest.raw]
    parts.push(
      "---\n" +
        "To save this digest, synthesize the above into a concise summary and call " +
        '`lore-memory` with `action: "save"` and `source: "digest"`.'
    )

    return {
      content: [{ type: "text", text: parts.join("\n") }],
      costOutputs: {
        memoriesReturned: digest.renderedMemoryCount,
        tasksReturned: digest.renderedTaskCount,
      },
    }
  } catch (err) {
    return toolError(err)
  }
}
