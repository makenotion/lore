/**
 * Hook helper utilities.
 *
 * These are invoked by the shell hook scripts to interact with Lore.
 * The hooks call `node dist/hooks/helpers.js <action>` with
 * relevant context passed via environment variables.
 */

import { initServices } from "../services.js"

const action = process.argv[2]

async function main(): Promise<void> {
  switch (action) {
    case "autosave":
      await autosave()
      break
    case "wakeup":
      await wakeup()
      break
    default:
      console.error(`Unknown hook action: ${action}`)
      process.exit(1)
  }
}

/**
 * Auto-save: extract and save a summary from the current conversation.
 * Called by the auto-save hook on context compression or conversation end.
 *
 * Expects LORE_AUTOSAVE_CONTENT env var with the content to save.
 */
async function autosave(): Promise<void> {
  const content = process.env["LORE_AUTOSAVE_CONTENT"]
  if (!content) {
    console.error("LORE_AUTOSAVE_CONTENT not set, skipping auto-save.")
    return
  }

  const title =
    process.env["LORE_AUTOSAVE_TITLE"] ??
    `Session notes — ${new Date().toISOString().split("T")[0]}`
  const agent = process.env["LORE_AGENT_NAME"] ?? "Claude Code"
  const session = process.env["LORE_SESSION_ID"]

  const services = await initServices()

  await services.memories.create({
    title,
    content,
    projectId: services.context.project?.id,
    source: "agent_diary",
    agent,
    session,
    tags: ["auto-save"],
  })

  console.log(`[lore] Auto-saved: "${title}"`)
}

/**
 * Wake-up: load and print relevant context for the current session.
 * Output is captured by the hook and injected into the system prompt.
 */
async function wakeup(): Promise<void> {
  const services = await initServices()
  const project = services.context.project

  const memories = await services.memories.list({
    projectId: project?.id,
    limit: 5,
  })

  const facts = project
    ? await services.facts.queryBySubject("", { projectId: project.id })
    : []

  const sections: string[] = []

  if (project) {
    sections.push(`Project: ${project.name} (${project.path || "root"})`)
  }

  if (memories.length > 0) {
    sections.push("\n## Recent Memories")
    for (const mem of memories) {
      sections.push(`- **${mem.title}** (${mem.source}, ${mem.updatedAt.split("T")[0]})`)
    }
  }

  if (facts.length > 0) {
    sections.push("\n## Active Facts")
    for (const fact of facts) {
      sections.push(
        `- ${fact.subject} ${fact.predicate.replace(/_/g, " ")} ${fact.object}`
      )
    }
  }

  if (sections.length > 0) {
    console.log(sections.join("\n"))
  }
}

main().catch((err) => {
  console.error("[lore] Hook error:", err instanceof Error ? err.message : err)
  process.exit(1)
})
