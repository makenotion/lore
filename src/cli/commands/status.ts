import { Command } from "commander"
import { initServices } from "../../services.js"

export const statusCommand = new Command("status")
  .description("Show vault status and project list")
  .action(async () => {
    try {
      const services = await initServices()
      const stats = await services.vault.stats()
      const project = services.context.project

      console.log("Lore Vault Status")
      console.log("─".repeat(40))
      console.log(`  Vault page: ${services.context.vault.pageId}`)
      console.log(
        `  Current project: ${project ? `${project.name} (${project.path || "root"})` : "none"}`
      )
      console.log()
      console.log("Database counts:")
      console.log(`  Projects: ${stats.projects}`)
      console.log(`  Topics:   ${stats.topics}`)
      console.log(`  Memories: ${stats.memories}`)
      console.log(`  Facts:    ${stats.facts}`)

      // List projects
      const projects = await services.projects.list("active")
      if (projects.length > 0) {
        console.log()
        console.log("Active projects:")
        for (const p of projects) {
          const path = p.path ? ` (${p.path})` : ""
          console.log(`  - ${p.name}${path} [${p.type}]`)
        }
      }
    } catch (err) {
      console.error("Status failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

// Sub-commands
const projectsCmd = new Command("projects")
  .description("List all projects")
  .option("-a, --all", "Include archived projects")
  .action(async (opts: { all?: boolean }) => {
    try {
      const services = await initServices()
      const projects = await services.projects.list(opts.all ? undefined : "active")

      if (projects.length === 0) {
        console.log("No projects found.")
        return
      }

      for (const p of projects) {
        const path = p.path ? `  ${p.path}` : ""
        const desc = p.description ? `  ${p.description}` : ""
        console.log(`${p.name} [${p.type}, ${p.status}]${path}${desc}`)
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

const topicsCmd = new Command("topics")
  .description("List topics in a project")
  .argument("[project]", "Project name (default: current project)")
  .action(async (projectName: string | undefined) => {
    try {
      const services = await initServices()

      let projectId: string | undefined
      if (projectName) {
        const found = await services.projects.findByName(projectName)
        if (!found) {
          console.error(`Project "${projectName}" not found.`)
          process.exit(1)
        }
        projectId = found.id
      } else if (services.context.project) {
        projectId = services.context.project.id
      } else {
        console.error("No project specified and none detected from cwd.")
        process.exit(1)
      }

      const topics = await services.topics.listByProject(projectId!)

      if (topics.length === 0) {
        console.log("No topics found.")
        return
      }

      for (const t of topics) {
        const desc = t.description ? `  ${t.description}` : ""
        console.log(`${t.name}${desc}`)
      }
    } catch (err) {
      console.error("Error:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

statusCommand.addCommand(projectsCmd)
statusCommand.addCommand(topicsCmd)
