import { Command, Option } from "commander"
import { findConfigFile, loadConfig } from "../../config.js"
import {
  defaultTodayRange,
  eventsToCsv,
  formatCostSummary,
  formatMalformedLedgerWarning,
  monthRange,
  readLedgerEventsWithDiagnostics,
  resolveCostTracking,
  sinceRange,
  summarizeCostEvents,
  type CostRange,
  type ResolvedCostTracking,
} from "../../core/cost-ledger.js"

interface RangeOpts {
  since?: string
  month?: string
}

function warnForMalformedLedgerLines(malformedLineCount: number): void {
  const warning = formatMalformedLedgerWarning(malformedLineCount)
  if (warning) console.warn(warning)
}

async function loadCostTracking(): Promise<ResolvedCostTracking> {
  const found = await findConfigFile(process.cwd())
  if (!found) throw new Error("No .lore.yaml found. Run `lore init` to set up a vault.")
  const config = await loadConfig(found.path)
  return resolveCostTracking(config, found.root)
}

function parseRange(
  opts: RangeOpts,
  defaultRange: CostRange | null
): CostRange | undefined {
  if (opts.since && opts.month) {
    throw new Error("--since and --month cannot be combined")
  }
  if (opts.since) return sinceRange(opts.since)
  if (opts.month) return monthRange(opts.month)
  return defaultRange ?? undefined
}

export const costsCommand = new Command("costs").description(
  "Inspect the opt-in local Lore cost ledger"
)

costsCommand
  .command("summary")
  .description("Summarize cost and usage events")
  .option("--since <range>", "Rolling window: Nh, Nd, or Nw")
  .option("--month <yyyy-mm>", "Local calendar month, e.g. 2026-05")
  .action(async (opts: RangeOpts) => {
    try {
      const costTracking = await loadCostTracking()
      if (!costTracking.enabled) {
        console.log("Cost tracking is disabled.")
        return
      }
      const range = parseRange(opts, defaultTodayRange())
      const { rows, malformedLineCount } = await readLedgerEventsWithDiagnostics(
        costTracking,
        range
      )
      warnForMalformedLedgerLines(malformedLineCount)
      console.log(
        formatCostSummary(
          summarizeCostEvents(
            rows.map((row) => row.event),
            range?.label ?? "all time"
          )
        )
      )
    } catch (err) {
      console.error("Costs failed:", err instanceof Error ? err.message : err)
      process.exit(1)
      return
    }
  })

costsCommand
  .command("export")
  .description("Export cost ledger events")
  .option("--since <range>", "Rolling window: Nh, Nd, or Nw")
  .option("--month <yyyy-mm>", "Local calendar month, e.g. 2026-05")
  .addOption(
    new Option("--format <format>", "Export format")
      .choices(["jsonl", "csv"])
      .default("jsonl")
  )
  .action(async (opts: RangeOpts & { format: "jsonl" | "csv" }) => {
    try {
      const costTracking = await loadCostTracking()
      if (!costTracking.enabled) {
        console.error("Costs failed: cost tracking is disabled.")
        process.exit(1)
        return
      }
      const range = parseRange(opts, null)
      const { rows, malformedLineCount } = await readLedgerEventsWithDiagnostics(
        costTracking,
        range
      )
      warnForMalformedLedgerLines(malformedLineCount)
      if (opts.format === "csv") {
        console.log(eventsToCsv(rows.map((row) => row.event)))
      } else if (rows.length > 0) {
        console.log(rows.map((row) => row.line).join("\n"))
      }
    } catch (err) {
      console.error("Costs failed:", err instanceof Error ? err.message : err)
      process.exit(1)
      return
    }
  })
