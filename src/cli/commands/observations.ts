import { Command } from "commander"
import { findConfigFile, loadConfigAllowingInvalidHooks } from "../../config.js"
import {
  rawObservationPath,
  readRecentObservations,
  type RawObservationRecord,
} from "../../hooks/raw-observation-store.js"

export const observationsCommand = new Command("observations").description(
  "Inspect raw PostToolUse observations from the local JSONL store"
)

observationsCommand
  .command("tail")
  .description("Print recent raw observations")
  .option("--limit <n>", "Maximum number of records to show", "20")
  .option("--session <id>", "Filter to a specific session ID")
  .option("--json", "Emit NDJSON (one record per line)")
  .action(async (opts: { limit: string; session?: string; json?: boolean }) => {
    const limit = parseInt(opts.limit, 10)
    if (!Number.isFinite(limit) || limit < 1) {
      console.error("--limit must be a positive integer")
      process.exit(1)
    }

    const found = await findConfigFile(process.cwd())
    if (!found) {
      console.error("No .lore.yaml found. Run `lore init` to set up a vault.")
      process.exit(1)
      return
    }

    const { config } = await loadConfigAllowingInvalidHooks(found.path)
    const rawObsEnabled =
      config.hooks?.rawObservationCapture === true ||
      process.env["LORE_RAW_OBSERVATIONS"] === "1"

    if (!rawObsEnabled) {
      console.warn(
        "Raw observation capture is disabled. " +
          "Set hooks.rawObservationCapture: true in .lore.yaml and rerun lore install to enable."
      )
    }

    const storePath = rawObservationPath(found.root, process.env)
    const records = await readRecentObservations(storePath, {
      sessionId: opts.session,
    })

    const slice = records.slice(-limit)

    if (opts.json) {
      for (const record of slice) {
        console.log(JSON.stringify(record))
      }
      return
    }

    if (slice.length === 0) {
      console.log("No observations found.")
      return
    }

    for (const record of slice) {
      printRecord(record)
    }
  })

function printRecord(record: RawObservationRecord): void {
  const shortHash = record.contentHash.slice(0, 8)
  const session = record.sessionId ? ` session=${record.sessionId.slice(0, 8)}` : ""
  console.log(`[${record.observedAt}] ${record.toolName} (${shortHash})${session}`)
}
