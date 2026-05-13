/**
 * `lore pinned` — operator-facing CLI for pinned context blocks.
 * One subcommand today:
 *
 * - `lore pinned list [--project <name>] [--audience <token>]
 *                     [--all-audiences] [-n <limit>]`
 *
 * Mutating operations (pin / unpin / update) intentionally land
 * only on the MCP `lore-pinned` tool surface. Operators rolling
 * out a fresh pinned block from a terminal can drop the
 * `Mutability: read-only` row directly into Notion's UI and pin
 * it via the agent surface — that's where the audit-line
 * append lives, and the CLI shouldn't duplicate that path with
 * a divergent author-resolution chain.
 *
 * The `list` subcommand is read-only and supports operator
 * inspection across audiences (so a release engineer can audit
 * every block for a project regardless of which audience tokens
 * the active session would match). Output is human-readable
 * markdown by default; `--json` emits a programmatic shape for
 * scripted consumers.
 */

import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"
import { resolveProjectByName } from "../../core/project-scope.js"
import type { Memory } from "../../types.js"
import { DEFAULT_PINNED_BLOCK_LIMIT } from "../../types.js"

const MAX_LIMIT = 100

export const pinnedCommand = new Command("pinned").description(
  "Operator-facing inspection of pinned context blocks (issue #282)"
)

const listCmd = new Command("list")
  .description("List active pinned context blocks for a project / audience")
  .option(
    "--project <name>",
    "Scope to a single project (defaults to auto-detected project; vault-wide pins always surface)"
  )
  .option(
    "--audience <token>",
    "Show only blocks whose audience matches this token (case-folded; `all` / empty surfaces every block)"
  )
  .option(
    "--all-audiences",
    "List every block regardless of audience match — operator inspection mode"
  )
  .option(
    "-n, --limit <number>",
    `Max rows to render (default ${DEFAULT_PINNED_BLOCK_LIMIT}, max ${MAX_LIMIT})`
  )
  .option("--json", "Emit machine-readable JSON instead of markdown")
  .action(
    async (opts: {
      project?: string
      audience?: string
      allAudiences?: boolean
      limit?: string
      json?: boolean
    }) => {
      try {
        const limit = parseLimit(opts.limit)
        const services = await initServices(undefined, { driftCheck: false })
        const projectId = await resolveProjectScope(services, opts.project)
        const today = new Date().toISOString().slice(0, 10)
        // The reader-context resolution matches the MCP tool's:
        //  - `--all-audiences` disables the audience filter entirely
        //    via `audienceFilter: false`. An empty `readerContext`
        //    alone is not enough — narrow-audience blocks would
        //    still be filtered out because the matcher rejects
        //    narrow tokens when no reader slot is populated.
        //  - `--audience <token>` builds a single-token reader so
        //    operators can simulate the perspective of a specific
        //    audience.
        //  - Otherwise fall back to the process's scope context.
        const useAllAudiences = opts.allAudiences === true
        const readerContext = useAllAudiences
          ? {}
          : opts.audience !== undefined
            ? { agent: opts.audience }
            : services.scopeContext
        const blocks = await services.memories.listPinnedBlocks({
          projectId,
          limit,
          today,
          readerContext,
          audienceFilter: !useAllAudiences,
          includeContent: false,
        })

        if (opts.json) {
          process.stdout.write(JSON.stringify(blocks.map(toJsonShape), null, 2) + "\n")
          return
        }

        if (blocks.length === 0) {
          console.log("No pinned context blocks active for the requested scope.")
          return
        }

        console.log(`Pinned context blocks (${blocks.length}):\n`)
        for (const block of blocks) {
          renderBlock(block)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        console.error(`Pinned list failed: ${msg}`)
        process.exit(1)
        return
      }
    }
  )

pinnedCommand.addCommand(listCmd)

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PINNED_BLOCK_LIMIT
  if (!/^\d+$/.test(raw)) {
    throw new Error(`--limit must be a positive integer; got "${raw}"`)
  }
  const value = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`--limit must be a positive integer; got "${raw}"`)
  }
  return Math.min(value, MAX_LIMIT)
}

async function resolveProjectScope(
  services: LoreServices,
  name: string | undefined
): Promise<string | undefined> {
  if (name === undefined) {
    return services.context.project?.id
  }
  const project = await resolveProjectByName(services.projects, name, "--project")
  return project.id
}

function renderBlock(block: Memory): void {
  const meta: string[] = [`id: ${block.id}`]
  if (block.pinned) {
    meta.push(`priority ${block.pinned.priority}`)
    meta.push(block.pinned.mutability)
  }
  const audience = block.scope?.audience?.trim() ?? ""
  meta.push(`audience: ${audience.length > 0 ? audience : "all"}`)
  console.log(`  ${block.title}`)
  console.log(`    ${meta.join(" | ")}`)
  if (block.synopsis.length > 0) {
    console.log(`    ${block.synopsis}`)
  }
  console.log("")
}

interface PinnedBlockJson {
  id: string
  title: string
  priority: number
  mutability: "mutable" | "read-only"
  audience: string
  synopsis: string
  projectIds: string[]
}

function toJsonShape(block: Memory): PinnedBlockJson {
  return {
    id: block.id,
    title: block.title,
    priority: block.pinned?.priority ?? 0,
    mutability: block.pinned?.mutability ?? "mutable",
    audience: block.scope?.audience ?? "",
    synopsis: block.synopsis,
    projectIds: block.projectIds,
  }
}
