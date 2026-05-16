import type { LoreServices } from "../../server.js"
import { fireTouchOnRead, toolError } from "../../helpers.js"
import { debugLogPartialFailures } from "../../../observability/partial-failure.js"
import { settleAll } from "../../../core/settle.js"
import type { Memory } from "../../../types.js"
import type { ToolResult } from "./types.js"

export async function handleExpand(
  services: LoreServices,
  args: { ids: string[] }
): Promise<ToolResult> {
  try {
    const unique: string[] = []
    const seen = new Set<string>()
    for (const id of args.ids) {
      if (!seen.has(id)) {
        seen.add(id)
        unique.push(id)
      }
    }

    const { fulfilled, failures } = await settleAll(
      unique.map((id) => [id, services.memories.getById(id)] as const)
    )
    if (failures.length > 0) {
      debugLogPartialFailures(
        "lore-memory",
        failures.map(({ key, error }) => ({ rootId: key, error }))
      )
    }

    const bodies = new Map<string, Memory>()
    for (const [id, memory] of fulfilled) bodies.set(id, memory)
    const errors = new Map<string, unknown>()
    for (const { key, error } of failures) errors.set(key, error)

    const sections = unique.map((id) => {
      const memory = bodies.get(id)
      if (memory) return formatExpandedMemory(memory)
      const error = errors.get(id)
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown error")
      return `### (unresolved: ${id})\n*${message}*`
    })

    const header =
      failures.length > 0
        ? `Expanded ${fulfilled.length}/${unique.length} memories (${failures.length} unresolved):`
        : `Expanded ${fulfilled.length} ${fulfilled.length === 1 ? "memory" : "memories"}:`

    const response: ToolResult = {
      content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n---\n\n")}` }],
      costOutputs: { memoriesReturned: fulfilled.length },
    }

    // Citation-as-evidence. `expand` fetches a
    // memory's body for the agent to read directly — that is a cite.
    // Touches only the rows that hydrated successfully; rows that
    // 404'd / errored are already reported as `(unresolved: ...)` and
    // touching them would duplicate the failure mode without any
    // signal value.
    const fulfilledMemories = fulfilled.map(([, memory]) => memory)
    await fireTouchOnRead(services.memories, fulfilledMemories, "lore-memory (expand)")

    return response
  } catch (err) {
    return toolError(err)
  }
}

/**
 * Render one hydrated memory for `lore-memory action='expand'` output.
 * Mirrors the meta-line shape used by `lore-query action='recall'` /
 * `lore-query action='search'` so agents scanning across
 * triage listings and expanded bodies see a uniform header line. Empty
 * `content` still renders the header (the memory exists; the body is just
 * blank) rather than collapsing the row.
 */
function formatExpandedMemory(m: Memory): string {
  const meta = [
    m.source,
    m.kind !== "note" ? m.kind : null,
    m.status !== "informational" ? m.status : null,
    m.updatedAt.split("T")[0],
  ]
    .filter(Boolean)
    .join(" | ")
  const body = m.content ? `\n\n${m.content}` : ""
  return `### ${m.title}\n*${meta}*${body}`
}
