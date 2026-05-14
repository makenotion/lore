import { Command } from "commander"
import { runAsk } from "../../core/ask.js"
import { initServices, type LoreServices } from "../../services.js"
import type { CliParseResult } from "../parse.js"
import { parsePositiveDecimalInteger } from "../parse.js"
import { validateNonBlank, validateYmd } from "./common.js"

export interface AskCliOptions {
  entity: string
  projectName: string | undefined
  limit: number | undefined
  asOf: string | undefined
  includeHistory: boolean
}

export async function runAskCli(
  services: LoreServices,
  opts: AskCliOptions
): Promise<Awaited<ReturnType<typeof runAsk>>> {
  return runAsk(services, {
    entity: opts.entity,
    projectName: opts.projectName,
    limit: opts.limit,
    asOf: opts.asOf,
    includeHistory: opts.includeHistory,
  })
}

export function parseAskCliOptions(
  entity: string,
  raw: {
    project?: string
    limit?: string
    asOf?: string
    history?: boolean
  }
): CliParseResult<AskCliOptions> {
  const parsedEntity = validateNonBlank(entity, "<entity>")
  if (!parsedEntity.ok) return parsedEntity
  let limit: number | undefined
  if (raw.limit !== undefined) {
    const parsedLimit = parsePositiveDecimalInteger("--limit", raw.limit)
    if (!parsedLimit.ok) return parsedLimit
    limit = parsedLimit.value
  }
  const asOf = validateYmd(raw.asOf, "--as-of")
  if (!asOf.ok) return asOf
  return {
    ok: true,
    value: {
      entity: parsedEntity.value,
      projectName: raw.project,
      limit,
      asOf: asOf.value,
      includeHistory: raw.history === true,
    },
  }
}

export const askCommand = new Command("ask")
  .description("Ask about an entity")
  .argument("<entity>", "Entity to query")
  .option("-p, --project <name>", "Scope to a specific project")
  .option("-n, --limit <n>", "Per-section result cap")
  .option("--as-of <YYYY-MM-DD>", "Transaction-time fact recall cutoff")
  .option("--history", "Include invalidated facts")
  .option("--json", "Emit the result as JSON")
  .action(
    async (
      entity: string,
      opts: {
        project?: string
        limit?: string
        asOf?: string
        history?: boolean
        json?: boolean
      }
    ) => {
      try {
        const parsed = parseAskCliOptions(entity, opts)
        if (!parsed.ok) {
          console.error(`Ask failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const result = await runAskCli(services, parsed.value)
        console.log(opts.json ? JSON.stringify(result.data, null, 2) : result.text)
      } catch (err) {
        console.error("Ask failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )
