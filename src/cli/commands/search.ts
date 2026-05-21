import { Command } from "commander"
import { initServices } from "../../services.js"
import {
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import type { Memory } from "../../types.js"
import { notionPageUrl, terminalLink } from "../output.js"
import { parsePositiveDecimalInteger, type CliParseResult } from "../parse.js"

export interface SearchCliOptions {
  projectName: string | undefined
  tags: string[] | undefined
  limit: number
  includeExpired: boolean
  json: boolean
}

export interface SearchJsonOutput {
  query: string
  projectId: string | null
  tags: string[] | null
  results: Memory[]
}

export function parseSearchCliOptions(raw: {
  project?: string
  tags?: string
  limit: string
  includeExpired?: boolean
  json?: boolean
}): CliParseResult<SearchCliOptions> {
  const parsedLimit = parsePositiveDecimalInteger("--limit", raw.limit)
  if (!parsedLimit.ok) return parsedLimit
  return {
    ok: true,
    value: {
      projectName: raw.project,
      tags: raw.tags?.split(",").map((t) => t.trim()),
      limit: parsedLimit.value,
      includeExpired: raw.includeExpired === true,
      json: raw.json === true,
    },
  }
}

export const searchCommand = new Command("search")
  .description("Semantic search across memories")
  .argument("<query>", "Search query")
  .option("-p, --project <name>", "Scope to a specific project")
  .option("-t, --tags <tags>", "Filter by tags (comma-separated)")
  .option("-n, --limit <n>", "Max results", "10")
  .option("--include-expired", "Include expired scoped memories in results")
  .option("--json", "Emit machine-readable JSON instead of human-readable text")
  .action(
    async (
      query: string,
      opts: {
        project?: string
        tags?: string
        limit: string
        includeExpired?: boolean
        json?: boolean
      }
    ) => {
      try {
        const parsed = parseSearchCliOptions(opts)
        if (!parsed.ok) {
          console.error(`Search failed: ${parsed.message}`)
          process.exit(1)
          return
        }

        const explicitProjectName = validateExplicitProjectScopeName(
          parsed.value.projectName,
          "--project",
          {
            listHint: "run `lore status projects` to list configured projects",
          }
        )
        const services = await initServices()
        let projectId: string | undefined

        if (explicitProjectName !== undefined) {
          const found = await resolveProjectScopeName(
            services.projects,
            explicitProjectName,
            "--project",
            {
              listHint: "run `lore status projects` to list configured projects",
            }
          )
          projectId = found.id
        } else if (services.context.project) {
          projectId = services.context.project.id
        }

        const results = await services.memories.search({
          query,
          projectId,
          tags: parsed.value.tags,
          limit: parsed.value.limit,
          includeExpired: parsed.value.includeExpired,
        })

        if (parsed.value.json) {
          const output: SearchJsonOutput = {
            query,
            projectId: projectId ?? null,
            tags: parsed.value.tags ?? null,
            results,
          }
          console.log(JSON.stringify(output, null, 2))
          return
        }

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
