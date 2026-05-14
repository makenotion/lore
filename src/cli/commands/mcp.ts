import { statSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { Command } from "commander"

/**
 * `lore mcp` — start the MCP stdio server.
 *
 * Replaces the legacy absolute-path `node <pkgRoot>/<built-entry>`
 * shape that legacy `lore install` runs wrote into consumer config.
 * With this subcommand on the bin, host assistants can dispatch
 * through the package-managed `node_modules/.bin/lore` symlink,
 * which yarn/npm resolve correctly on every machine regardless of
 * where the consumer repo lives on disk.
 *
 * The action handler lazy-imports the MCP server module so
 * `lore --help`, `lore install`, and the unrelated CLI surfaces
 * don't drag the MCP module graph (and its eager Notion / Zod
 * imports) into every CLI run.
 *
 * Bench-mode flags `--write-budget` and `--budget-state-file` are
 * threaded through process env (`LORE_MCP_WRITE_BUDGET` /
 * `LORE_MCP_BUDGET_STATE_FILE`) before the server module is
 * imported. Production install paths (`lore install`) do not emit
 * these flags; they exist for the LongMemEval bench-runner to spawn
 * a write-budget-capped MCP server per example.
 */
export const mcpCommand = new Command("mcp")
  .description("Run the Lore MCP server (stdio transport)")
  .option(
    "--write-budget <n>",
    "Bench-only: cap successful mutations at N per server lifetime. " +
      "Requires --budget-state-file."
  )
  .option(
    "--budget-state-file <path>",
    "Bench-only: absolute path the write-budget proxy writes its " +
      "cap-exceeded state file to (atomic tmpfile + rename, mode 0600)."
  )
  .action(async (opts: { writeBudget?: string; budgetStateFile?: string }) => {
    if ((opts.writeBudget === undefined) !== (opts.budgetStateFile === undefined)) {
      console.error(
        "lore mcp: --write-budget and --budget-state-file must be passed together."
      )
      process.exit(1)
      return
    }
    if (opts.writeBudget !== undefined && opts.budgetStateFile !== undefined) {
      const limit = Number.parseInt(opts.writeBudget, 10)
      if (!Number.isInteger(limit) || limit <= 0 || String(limit) !== opts.writeBudget) {
        console.error(
          `lore mcp: --write-budget must be a positive integer, got "${opts.writeBudget}"`
        )
        process.exit(1)
        return
      }
      if (!isAbsolute(opts.budgetStateFile)) {
        console.error(
          `lore mcp: --budget-state-file must be an absolute path, got "${opts.budgetStateFile}"`
        )
        process.exit(1)
        return
      }
      const parentDir = dirname(opts.budgetStateFile)
      try {
        const parentStat = statSync(parentDir)
        if (!parentStat.isDirectory()) {
          console.error(
            `lore mcp: --budget-state-file parent "${parentDir}" is not a directory`
          )
          process.exit(1)
          return
        }
      } catch (err) {
        console.error(
          `lore mcp: --budget-state-file parent "${parentDir}" not accessible: ${err instanceof Error ? err.message : String(err)}`
        )
        process.exit(1)
        return
      }
      process.env["LORE_MCP_WRITE_BUDGET"] = String(limit)
      process.env["LORE_MCP_BUDGET_STATE_FILE"] = opts.budgetStateFile
    }
    const { startServer } = await import("../../mcp/server.js")
    await startServer()
  })
