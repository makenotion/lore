#!/usr/bin/env node
/**
 * Operator-rerunnable probe for `pages.retrieveMarkdown` throughput.
 * Bypasses Lore's outbound rate-limit wrapper so the SERVER-side
 * ceiling is observable; the wrapper-side pacing is governed by the
 * `DEFAULT_NOTION_*` config knobs the shared client exports.
 *
 * Usage:
 *   node tools/probe-retrieve-markdown.mjs --yes
 *
 * The `--yes` flag is required. Without it the probe refuses to run
 * — `main()` would otherwise issue up to ~1,500 live read calls
 * against the configured vault on first invocation.
 *
 * Auth selection (matches the canonical Lore auth-resolution order):
 *   1. `NOTION_API_TOKEN` env (canonical, ntn-shaped tokens / PATs)
 *   2. `~/.config/notion/auth.json` (the ntn-managed bearer store)
 *      keyed by `LORE_NOTION_WORKSPACE_ID` / `NOTION_WORKSPACE_ID`
 *      or single-entry auto-pick; multi-workspace without selector
 *      fails loudly rather than silently picking `Object.keys()[0]`.
 *
 * Probe matrix:
 *   fan-out sizes:    25 / 50 / 100 (capped to live memory count)
 *   concurrencies:    1 / 3 / 5 / 10 / 20
 *
 * For each (size, concurrency) cell records:
 *   - wall-clock elapsed
 *   - sustained rps over successful responses
 *     (NOT offered rps; a 429-rich cell would understate offered load)
 *   - p50 / p95 / max per-call latency
 *   - 429 count
 *   - longest observed Retry-After window
 *
 * 429 handling is `count, do not retry`. A cell that surfaces 429s
 * will show `count429 > 0` and a depressed `rps` (the 429'd call is
 * excluded from `latencies.length` but not from `elapsedMs`). For
 * an offered-load reading on a throttling-heavy workspace, retry
 * with `Retry-After` is a TODO; the current probe targets a
 * workspace that does NOT throttle.
 *
 * Auth-bypass note: this probe constructs `new Client({ auth })`
 * directly. It does NOT route through the ntn token loader, so it
 * skips that helper's XDG_CONFIG_HOME resolution and shape guards.
 * The conservative env-priority chain below covers the failure
 * modes that mattered for the original measurement; routing through
 * the ntn loader would require importing Lore's TypeScript source
 * into this `.mjs` tool.
 *
 * Read-only: only issues `dataSources.query`, `databases.retrieve`,
 * `blocks.children.list`, and `pages.retrieveMarkdown`. No writes.
 *
 * Exit codes:
 *   0  matrix completed (possibly with `429`-counted cells)
 *   1  fatal error during a cell (non-rate-limit, non-auth)
 *   2  `--yes` not provided
 *   3  workspace has fewer live memories than the smallest cell
 */
import { Client } from "@notionhq/client"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { parse as parseYaml } from "yaml"

const VERSION = "1"

/**
 * Cell sizes the probe matrix runs at, smallest first. Lifted to a
 * named const so a future retune is a one-edit change and the
 * "smallest cell required" error message picks up the new floor
 * automatically.
 */
const PROBE_SIZES = [25, 50, 100]

/**
 * Concurrencies the probe matrix runs at, ordered from serial
 * baseline to the highest cell that did not surface 429s in the
 * original measurement.
 */
const PROBE_CONCURRENCIES = [1, 3, 5, 10, 20]

/**
 * Resolve a bearer token by honoring the same env-first priority chain
 * Lore's own auth-resolution path uses, but stop short of importing
 * Lore's TypeScript source into this `.mjs` tool — the imports would
 * force either a `npm run build` precondition or a runtime switch to
 * `tsx`, both of which add friction for a one-shot operator probe.
 *
 * Priority (matches the canonical Lore auth-resolution order):
 *   1. `NOTION_API_TOKEN` env (canonical, ntn-shaped tokens / PATs)
 *   2. `~/.config/notion/auth.json` (the ntn-managed bearer store)
 *
 * Workspace selection from `auth.json`:
 *   1. `LORE_NOTION_WORKSPACE_ID` env (explicit selector)
 *   2. `NOTION_WORKSPACE_ID` env (ntn's native name)
 *   3. Single-entry auth.json — picks the only workspace
 *   Else → fail loudly. A silent `Object.keys(auth)[0]` would pick
 *   whichever workspace happened to sort first, which is unsafe on
 *   multi-workspace operator setups.
 *
 * Base URL: `LORE_NOTION_BASE_URL` → `NOTION_BASE_URL` → SDK default,
 * matching the canonical auth-resolution precedence.
 */
function loadToken() {
  const baseUrl =
    process.env["LORE_NOTION_BASE_URL"] ?? process.env["NOTION_BASE_URL"] ?? undefined

  const apiTokenEnv = process.env["NOTION_API_TOKEN"]
  if (apiTokenEnv) {
    return { token: apiTokenEnv, workspaceId: "<from NOTION_API_TOKEN env>", baseUrl }
  }

  const auth = JSON.parse(readFileSync(homedir() + "/.config/notion/auth.json", "utf8"))
  const keys = Object.keys(auth)
  const explicit =
    process.env["LORE_NOTION_WORKSPACE_ID"] ?? process.env["NOTION_WORKSPACE_ID"]
  if (explicit) {
    if (!(explicit in auth)) {
      throw new Error(
        `Workspace ${explicit} not present in ~/.config/notion/auth.json ` +
          `(known: ${keys.join(", ")})`,
      )
    }
    return { token: auth[explicit], workspaceId: explicit, baseUrl }
  }
  if (keys.length !== 1) {
    throw new Error(
      `~/.config/notion/auth.json has ${keys.length} workspaces; set ` +
        `LORE_NOTION_WORKSPACE_ID (or NOTION_WORKSPACE_ID) to one of: ${keys.join(", ")}`,
    )
  }
  return { token: auth[keys[0]], workspaceId: keys[0], baseUrl }
}

function loadVaultConfig() {
  const explicit = process.env["LORE_PROBE_VAULT_PAGE_ID"]
  if (explicit) return { pageId: explicit }
  const yaml = readFileSync("./.lore.yaml", "utf8")
  const parsed = parseYaml(yaml)
  return { pageId: parsed.vault.pageId }
}

async function findMemoriesDataSourceId(client, vaultPageId) {
  // Walk the vault page's children, find the database titled "Memories"
  // and return its first data source id.
  let cursor
  do {
    const res = await client.blocks.children.list({
      block_id: vaultPageId,
      page_size: 100,
      start_cursor: cursor,
    })
    for (const block of res.results) {
      if (block.type === "child_database") {
        const title = block.child_database?.title
        if (title === "Memories") {
          // Resolve data source via databases.retrieve
          const db = await client.databases.retrieve({ database_id: block.id })
          const dsId = db.data_sources?.[0]?.id
          if (!dsId) throw new Error(`Memories DB ${block.id} has no data sources`)
          return dsId
        }
      }
    }
    cursor = res.has_more ? res.next_cursor : undefined
  } while (cursor)
  throw new Error("Memories database not found under vault page")
}

async function collectMemoryPageIds(client, dataSourceId, target) {
  const ids = []
  let cursor
  while (ids.length < target) {
    const res = await client.dataSources.query({
      data_source_id: dataSourceId,
      page_size: 100,
      start_cursor: cursor,
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
    })
    for (const page of res.results) {
      if (page.object === "page" && !page.archived) {
        ids.push(page.id)
        if (ids.length >= target) break
      }
    }
    if (!res.has_more) break
    cursor = res.next_cursor ?? undefined
  }
  return ids
}

function quantile(sorted, q) {
  if (sorted.length === 0) return 0
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q))
  return sorted[idx]
}

async function runCell(client, pageIds, concurrency) {
  const latencies = []
  let count429 = 0
  let maxRetryAfterMs = 0
  let fatalError = null
  const queue = [...pageIds]
  const startedAt = Date.now()
  await new Promise((resolve, reject) => {
    let active = 0
    let done = 0
    const total = pageIds.length
    function settle() {
      if (active > 0) return
      if (fatalError !== null) reject(fatalError)
      else resolve()
    }
    function pump() {
      // Stop dispatching new work once a fatal error has surfaced; the
      // outer Promise stays unsettled until in-flight calls drain, so
      // post-rejection metric mutation cannot poison `latencies` /
      // `count429` for a cell that already failed.
      if (fatalError !== null) {
        settle()
        return
      }
      while (active < concurrency && queue.length > 0) {
        const id = queue.shift()
        active++
        const callStart = Date.now()
        client.pages
          .retrieveMarkdown({ page_id: id })
          .then(() => {
            if (fatalError === null) latencies.push(Date.now() - callStart)
          })
          .catch((err) => {
            if (err?.code === "rate_limited" || err?.status === 429) {
              count429++
              const retryAfter = Number(err?.headers?.["retry-after"]) || 0
              const ms = retryAfter * 1000
              if (ms > maxRetryAfterMs) maxRetryAfterMs = ms
            } else if (fatalError === null) {
              // First non-rate-limit error becomes the cell's verdict;
              // later errors during drain are ignored (the outer Promise
              // is committed to rejecting with the first failure).
              fatalError = err
            }
          })
          .finally(() => {
            active--
            done++
            if (fatalError !== null) settle()
            else if (done >= total) resolve()
            else pump()
          })
      }
    }
    pump()
  })
  const elapsedMs = Date.now() - startedAt
  const sorted = latencies.slice().sort((a, b) => a - b)
  const rps = (latencies.length / elapsedMs) * 1000
  return {
    elapsedMs,
    rps: Number(rps.toFixed(2)),
    p50: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
    n: latencies.length,
    count429,
    maxRetryAfterMs,
  }
}

async function main() {
  // Required `--yes` gate: `main()` issues up to ~1,500 live
  // `pages.retrieveMarkdown` reads against the resolved workspace.
  // Combined with the multi-workspace ambiguity the env chain
  // discourages but does not eliminate, the footgun would be "wrong
  // vault × 1,500 silent reads." Refuse to run without explicit
  // operator confirmation.
  if (!process.argv.includes("--yes")) {
    console.error(
      "Refusing to run without --yes. The probe issues up to ~1,500 live\n" +
        "`pages.retrieveMarkdown` reads against the resolved workspace.\n" +
        "Re-run with `--yes` after verifying the workspace/vault selection.",
    )
    process.exit(2)
  }
  const { token, workspaceId, baseUrl } = loadToken()
  const { pageId: vaultPageId } = loadVaultConfig()

  console.log(`Probe v${VERSION} — pages.retrieveMarkdown server-side ceiling`)
  console.log(`Workspace id: ${workspaceId}`)
  console.log(`Vault page id: ${vaultPageId}`)
  // The 4-char prefix is the discriminant operators use to tell
  // `ntn_*` (PAT) from `development_ntn_*` (dev PAT) from the
  // ntn-managed bearer; the token length is deliberately omitted to
  // avoid narrowing the brute-force search space if the output
  // lands in CI logs / scrollback / pasted bug reports.
  console.log(`Token prefix: ${token.slice(0, 4)}...`)
  if (baseUrl) console.log(`Base URL: ${baseUrl}`)
  console.log("")

  // No rate-limit wrapper — direct SDK client. The whole point of the
  // probe is to observe the server-side ceiling without Lore's local
  // `createLimitedClient` pacing on top.
  const client = new Client({ auth: token, ...(baseUrl ? { baseUrl } : {}) })

  console.log("→ Locating Memories data source...")
  const dsId = await findMemoriesDataSourceId(client, vaultPageId)
  console.log(`  Memories data source: ${dsId}`)

  console.log("→ Collecting up to 100 live memory page ids...")
  const ids = await collectMemoryPageIds(client, dsId, 100)
  console.log(`  Collected ${ids.length} ids.`)
  console.log("")

  const sizes = PROBE_SIZES.filter((s) => s <= ids.length)
  const concurrencies = PROBE_CONCURRENCIES
  const droppedSizes = PROBE_SIZES.filter((s) => !sizes.includes(s))

  if (sizes.length === 0) {
    // Fail loudly: a workspace with fewer live memories than the
    // smallest cell can't produce a single throughput measurement,
    // so the probe would otherwise exit cleanly with zero data and
    // an operator might miss it.
    console.error("")
    console.error(
      `ERROR: vault has ${ids.length} live memories; the smallest probe cell ` +
        `requires ${PROBE_SIZES[0]}. No throughput cells can run — aborting.`,
    )
    process.exit(3)
  }

  if (droppedSizes.length > 0) {
    // Conspicuous fenced block so the truncation isn't a single
    // easy-to-miss `console.warn` line that scrolls past during
    // the per-cell output stream.
    const banner = "!".repeat(72)
    console.warn("")
    console.warn(banner)
    console.warn(
      `WARNING: vault has ${ids.length} live memories; dropping size cells ` +
        `${droppedSizes.join(" / ")} from the matrix.`,
    )
    console.warn(
      `Throughput numbers below will only cover sizes ${sizes.join(" / ")}; ` +
        `seed more memories before using this run to drive retune decisions.`,
    )
    console.warn(banner)
    console.warn("")
  }

  console.log(`Probe matrix: sizes=${sizes.join("/")} concurrencies=${concurrencies.join("/")}`)
  console.log("")

  // Continue past a failed cell so the operator can see which other
  // cells did succeed (useful when one concurrency cell trips a
  // transient error but the rest of the matrix would have produced
  // valid evidence). Honor the documented exit-code contract by
  // setting `process.exitCode = 1` if any cell rejected — without
  // this, the matrix loop swallows the rejection in its try/catch
  // and `main()` resolves normally, exiting 0 against the explicit
  // "exit code 1: fatal error during a cell" header docstring.
  let anyCellFailed = false
  for (const size of sizes) {
    for (const concurrency of concurrencies) {
      const slice = ids.slice(0, size)
      process.stdout.write(`size=${size.toString().padStart(3)} concurrency=${concurrency.toString().padStart(2)} ... `)
      try {
        const r = await runCell(client, slice, concurrency)
        console.log(
          `elapsed=${r.elapsedMs}ms rps=${r.rps} p50=${r.p50}ms p95=${r.p95}ms max=${r.max}ms 429s=${r.count429}${
            r.maxRetryAfterMs > 0 ? ` retryAfterMax=${r.maxRetryAfterMs}ms` : ""
          }`,
        )
      } catch (err) {
        console.log(`FAILED: ${err?.message ?? String(err)}`)
        anyCellFailed = true
      }
      // Idle gap so consecutive cells don't bleed throttling state.
      await new Promise((res) => setTimeout(res, 5000))
    }
  }
  if (anyCellFailed) {
    console.error("")
    console.error("One or more probe cells failed; exit code 1.")
    process.exitCode = 1
  }
}

main().catch((err) => {
  console.error("Probe failed:", err)
  process.exit(1)
})
