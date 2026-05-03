import { Command } from "commander"
import { initServices } from "../../services.js"
import {
  formatUnresolvedProjectScopeError,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import { notionPageUrl, terminalLink } from "../output.js"
import { parsePositiveDecimalInteger, type CliParseResult } from "../parse.js"

export interface SearchCliOptions {
  projectName: string | undefined
  tags: string[] | undefined
  limit: number
}

export function parseSearchCliOptions(raw: {
  project?: string
  tags?: string
  limit: string
}): CliParseResult<SearchCliOptions> {
  const parsedLimit = parsePositiveDecimalInteger("--limit", raw.limit)
  if (!parsedLimit.ok) return parsedLimit
  return {
    ok: true,
    value: {
      projectName: raw.project,
      tags: raw.tags?.split(",").map((t) => t.trim()),
      limit: parsedLimit.value,
    },
  }
}

export const searchCommand = new Command("search")
  .description("Semantic search across memories")
  .argument("<query>", "Search query")
  .option("-p, --project <name>", "Scope to a specific project")
  .option("-t, --tags <tags>", "Filter by tags (comma-separated)")
  .option("-n, --limit <n>", "Max results", "10")
  .action(
    async (query: string, opts: { project?: string; tags?: string; limit: string }) => {
      try {
        const parsed = parseSearchCliOptions(opts)
        if (!parsed.ok) {
          console.error(`Search failed: ${parsed.message}`)
          process.exit(1)
          return
        }

        const services = await initServices()
        let projectId: string | undefined

        const explicitProjectName = validateExplicitProjectScopeName(
          parsed.value.projectName,
          "--project",
          {
            listHint: "run `lore status projects` to list configured projects",
          }
        )
        if (explicitProjectName !== undefined) {
          const found = await services.projects.findByName(explicitProjectName)
          if (found) projectId = found.id
          else {
            throw new Error(
              formatUnresolvedProjectScopeError([explicitProjectName], "--project", {
                listHint: "run `lore status projects` to list configured projects",
              })
            )
          }
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        const results = await services.memories.search({
          query,
          projectId,
          tags: parsed.value.tags,
          limit: parsed.value.limit,
        })

        if (results.length === 0) {
          console.log(`No memories found for: "${query}"`)
          return
        }

        console.log(`Found ${results.length} memories:\n`)

        for (const mem of results) {
          const tags = mem.tags.length > 0 ? ` [${mem.tags.join(", ")}]` : ""
          const linkedTitle = terminalLink(mem.title, notionPageUrl(mem.id))
          console.log(`  ${linkedTitle}${tags}`)
          // Page ID stays plain text — operators copy it into other tools.
          console.log(`  ${mem.source} | ${mem.updatedAt.split("T")[0]} | ${mem.id}`)
          if (mem.content) {
            const preview = mem.content.slice(0, 120).replace(/\n/g, " ")
            console.log(`  ${preview}${mem.content.length > 120 ? "..." : ""}`)
          }
          console.log()
        }
      } catch (err) {
        console.error("Search failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )
