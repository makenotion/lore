import type { LoreServices } from "../../server.js"
import { toolError } from "../../helpers.js"
import { subjectToTopicKey } from "../../../core/memory-subject.js"
import { resolveProjectIds } from "../../resolve.js"
import type { ToolResult } from "./types.js"

export interface HistoryArgs {
  subject: string
  projectName?: string
  projectNames?: string[]
}

export async function handleHistory(
  services: LoreServices,
  args: HistoryArgs
): Promise<ToolResult> {
  try {
    const topicKey = subjectToTopicKey(args.subject)
    const resolved = await resolveProjectIds(
      services,
      args.projectName,
      args.projectNames
    )
    if (resolved.ids.length === 0) {
      throw new Error(
        "subject history requires a project scope. Pass projectName or run from a configured project."
      )
    }

    const match = await services.memories.findByTopicKey({
      topicKey,
      projectIds: resolved.ids,
    })
    const projectLabel = args.projectNames?.length
      ? args.projectNames.join(", ")
      : (args.projectName ?? services.context.project?.name ?? "none (repo-wide)")

    if (!match) {
      const lines = [
        `No subject-canonical memory found for "${args.subject.trim()}" (topic key '${topicKey}').`,
        `Project: ${projectLabel}`,
      ]
      if (resolved.warnings.length > 0) {
        lines.push(`Warnings: ${resolved.warnings.join("; ")}`)
      }
      return { content: [{ type: "text", text: lines.join("\n") }] }
    }
    if (match.kind !== "state") {
      throw new Error(
        `Topic key '${topicKey}' matched a non-state memory (${match.id}, kind='${match.kind}'); refusing to render it as subject history.`
      )
    }

    const memory = await services.memories.getById(match.id)
    if (memory.kind !== "state") {
      throw new Error(
        `Topic key '${topicKey}' hydrated as a non-state memory (${memory.id}, kind='${memory.kind}'); refusing to render it as subject history.`
      )
    }
    const lines = [
      `Subject history: "${args.subject.trim()}" (topic key '${topicKey}')`,
      `Memory: "${memory.title}" (${memory.id})`,
      `Project: ${projectLabel}`,
      `Revision Count: ${memory.revisionCount}`,
    ]
    if (resolved.warnings.length > 0) {
      lines.push(`Warnings: ${resolved.warnings.join("; ")}`)
    }
    lines.push("", memory.content.trimEnd())

    return { content: [{ type: "text", text: lines.join("\n") }] }
  } catch (err) {
    return toolError(err)
  }
}
