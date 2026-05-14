#!/usr/bin/env node
/**
 * Operator-rerunnable probe for the server-side throughput ceiling of
 * read endpoints Lore depends on. Bypasses Lore's outbound rate-limit
 * wrapper so the SERVER-side ceiling is observable; the wrapper-side
 * pacing is governed by the `DEFAULT_NOTION_*` constants on the shared
 * client and the per-endpoint defaults in
 * `DEFAULT_NOTION_ENDPOINT_OVERRIDES`.
 *
 * Usage:
 *   node tools/probe-notion-endpoint.mjs --endpoint <name> --yes
 *
 *   <name> is one of:
 *     - retrieveMarkdown  (body-fetch hot path on list views)
 *     - retrieve          (title-resolution hot path)
 *     - query             (list / search hot path)
 *
 *   The `--yes` flag is required. Without it the probe refuses to run.
 *
 * Auth selection (matches the canonical Lore auth-resolution order):
 *   1. `NOTION_API_TOKEN` env (canonical, ntn-shaped tokens / PATs)
 *   2. ntn-managed `auth.json`, resolved via `XDG_CONFIG_HOME` or
 *      `~/.config`, keyed by `NOTION_WORKSPACE_ID` / `.lore.yaml`
 *      `auth.workspaceId`, or single-entry auto-pick.
 *
 * Probe matrix (per endpoint):
 *   fan-out sizes:    25 / 50 / 100 (capped to live row count for the
 *                     endpoint's source set)
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
 * will show `count429 > 0` and a depressed `rps`.
 *
 * Read-only: only issues `dataSources.query`, `databases.retrieve`,
 * `blocks.children.list`, and the endpoint under test. No writes.
 *
 * Exit codes:
 *   0  matrix completed (possibly with `429`-counted cells)
 *   1  fatal error during a cell (non-rate-limit, non-auth)
 *   2  `--yes` not provided
 *   3  workspace has fewer live rows than the smallest cell
 *   4  unknown / missing `--endpoint`
 */
import { Client } from "@notionhq/client"
import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { parse as parseYaml } from "yaml"

const VERSION = "3"

const PROBE_SIZES = [25, 50, 100]
const PROBE_CONCURRENCIES = [1, 3, 5, 10, 20]

const KNOWN_ENDPOINTS = ["retrieveMarkdown", "retrieve", "query"]

function parseArgs(argv) {
  const out = { endpoint: null, yes: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === "--yes") out.yes = true
    else if (arg === "--endpoint") {
      out.endpoint = argv[++i]
    } else if (arg.startsWith("--endpoint=")) {
      out.endpoint = arg.slice("--endpoint=".length)
    }
  }
  return out
}

const NTN_ENV_BASE_URLS = {
  prod: "https://api.notion.so",
  dev: "https://api-dev.notion.com",
  stg: "https://api-stg.notion.com",
}

function ntnEnvBaseUrl(env) {
  return NTN_ENV_BASE_URLS[env] ?? undefined
}

function resolveOperatorBaseUrl() {
  return (
    process.env["LORE_NOTION_BASE_URL"] ||
    process.env["NOTION_BASE_URL"] ||
    process.env["NOTION_API_BASE_URL"] ||
    ntnEnvBaseUrl(process.env["NOTION_ENV"]) ||
    undefined
  )
}

function notionConfigDir() {
  const xdg = process.env["XDG_CONFIG_HOME"]
  return join(xdg && xdg.length > 0 ? xdg : join(homedir(), ".config"), "notion")
}

function ntnAuthJsonPath() {
  return join(notionConfigDir(), "auth.json")
}

function ntnConfigJsonPath() {
  return join(notionConfigDir(), "config.json")
}

function resolveNtnBaseUrl() {
  const fromEnv = resolveOperatorBaseUrl()
  if (fromEnv) return fromEnv
  try {
    const parsed = JSON.parse(readFileSync(ntnConfigJsonPath(), "utf8"))
    const env = typeof parsed?.env === "string" ? parsed.env : "prod"
    return env === "prod" ? undefined : ntnEnvBaseUrl(env)
  } catch {
    return undefined
  }
}

function findLoreConfigPath() {
  const root = process.env["LORE_CONFIG_ROOT"]?.trim()
  if (root) return join(resolve(root), ".lore.yaml")

  let dir = resolve(process.cwd())
  while (true) {
    const candidate = join(dir, ".lore.yaml")
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

function loadLoreConfig() {
  const path = findLoreConfigPath()
  if (!path) return { path: null, config: {} }
  const yaml = readFileSync(path, "utf8")
  const parsed = parseYaml(yaml)
  const config = parsed && typeof parsed === "object" ? parsed : {}
  return { path, config }
}

/**
 * Honor the same env-first priority chain Lore's own auth-resolution
 * path uses, but stop short of importing Lore's TypeScript source into
 * this `.mjs` tool.
 */
function loadToken(loreConfig) {
  const apiTokenEnv = process.env["NOTION_API_TOKEN"]
  if (apiTokenEnv) {
    return {
      token: apiTokenEnv,
      workspaceId: "<from NOTION_API_TOKEN env>",
      baseUrl: resolveOperatorBaseUrl(),
    }
  }

  const authPath = ntnAuthJsonPath()
  const parsed = JSON.parse(readFileSync(authPath, "utf8"))
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${authPath} has unexpected shape (expected an object)`)
  }

  const entries = Object.entries(parsed).filter(
    (entry) => typeof entry[1] === "string" && entry[1].length > 0,
  )
  const explicit =
    process.env["NOTION_WORKSPACE_ID"] ??
    (typeof loreConfig?.auth?.workspaceId === "string"
      ? loreConfig.auth.workspaceId
      : undefined)

  if (explicit) {
    const pick = entries.find(([workspaceId]) => workspaceId === explicit)
    if (!pick) {
      throw new Error(
        `Workspace ${explicit} not present in ${authPath} ` +
          `(known: ${entries.map(([workspaceId]) => workspaceId).join(", ")})`,
      )
    }
    return { token: pick[1], workspaceId: pick[0], baseUrl: resolveNtnBaseUrl() }
  }

  if (entries.length !== 1) {
    throw new Error(
      `${authPath} has ${entries.length} usable workspaces; set ` +
        `NOTION_WORKSPACE_ID or auth.workspaceId in .lore.yaml to one of: ` +
        entries.map(([workspaceId]) => workspaceId).join(", "),
    )
  }

  const [workspaceId, token] = entries[0]
  return { token, workspaceId, baseUrl: resolveNtnBaseUrl() }
}

function loadVaultConfig(loreConfig, configPath) {
  const explicit = process.env["LORE_PROBE_VAULT_PAGE_ID"]
  if (explicit) return { pageId: explicit }

  const pageId = loreConfig?.vault?.pageId
  if (typeof pageId === "string" && pageId.length > 0) {
    return { pageId }
  }

  throw new Error(
    configPath
      ? `${configPath} does not contain vault.pageId`
      : "No .lore.yaml found; set LORE_PROBE_VAULT_PAGE_ID or run from a Lore project",
  )
}

async function findMemoriesDataSourceId(client, vaultPageId) {
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

function retryAfterMsFromHeaders(headers) {
  if (!headers) return 0
  let retryAfter = null
  if (
    typeof headers === "object" &&
    headers !== null &&
    "get" in headers &&
    typeof headers.get === "function"
  ) {
    retryAfter = headers.get("retry-after")
  } else if (typeof headers === "object") {
    retryAfter = headers["retry-after"] ?? headers["Retry-After"] ?? null
  }
  if (!retryAfter) return 0

  const seconds = Number.parseInt(retryAfter, 10)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000

  const date = Date.parse(retryAfter)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())

  return 0
}

/**
 * Endpoint-specific call shapes. Each function takes the client and
 * one input from the cell's input slice (a page id for retrieve /
 * retrieveMarkdown; an opaque marker for query) and returns the SDK
 * Promise. The probe doesn't care about the response shape — it only
 * times the round-trip.
 *
 * For `query`, every call issues a fresh first-page `dataSources.query`
 * against the Memories data source with `page_size: 25`. The input
 * value is unused; the cell size sets the call count and the result
 * set's contents don't need to vary call-to-call to characterize
 * server-side throughput.
 */
function buildCaller(endpoint, dataSourceId) {
  if (endpoint === "retrieveMarkdown") {
    return (client, id) => client.pages.retrieveMarkdown({ page_id: id })
  }
  if (endpoint === "retrieve") {
    return (client, id) => client.pages.retrieve({ page_id: id })
  }
  if (endpoint === "query") {
    return (client) =>
      client.dataSources.query({
        data_source_id: dataSourceId,
        page_size: 25,
      })
  }
  throw new Error(`Unknown endpoint: ${endpoint}`)
}

async function runCell(client, inputs, concurrency, callFn) {
  const latencies = []
  let count429 = 0
  let maxRetryAfterMs = 0
  let fatalError = null
  const queue = [...inputs]
  const startedAt = Date.now()
  await new Promise((resolve, reject) => {
    let active = 0
    let done = 0
    const total = inputs.length
    function settle() {
      if (active > 0) return
      if (fatalError !== null) reject(fatalError)
      else resolve()
    }
    function pump() {
      if (fatalError !== null) {
        settle()
        return
      }
      while (active < concurrency && queue.length > 0) {
        const input = queue.shift()
        active++
        const callStart = Date.now()
        callFn(client, input)
          .then(() => {
            if (fatalError === null) latencies.push(Date.now() - callStart)
          })
          .catch((err) => {
            if (err?.code === "rate_limited" || err?.status === 429) {
              count429++
              const ms = retryAfterMsFromHeaders(err?.headers)
              if (ms > maxRetryAfterMs) maxRetryAfterMs = ms
            } else if (fatalError === null) {
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
  const args = parseArgs(process.argv.slice(2))

  if (!args.endpoint) {
    console.error(
      "Refusing to run without --endpoint <name>. Known names: " +
        KNOWN_ENDPOINTS.join(" / ") +
        ".",
    )
    process.exit(4)
  }
  if (!KNOWN_ENDPOINTS.includes(args.endpoint)) {
    console.error(
      `Unknown endpoint: ${args.endpoint}. Known names: ` +
        KNOWN_ENDPOINTS.join(" / ") +
        ".",
    )
    process.exit(4)
  }
  if (!args.yes) {
    console.error(
      "Refusing to run without --yes. The probe issues up to ~1,500 live\n" +
        "read calls against the resolved workspace.\n" +
        "Re-run with `--yes` after verifying the workspace/vault selection.",
    )
    process.exit(2)
  }

  const { path: configPath, config: loreConfig } = loadLoreConfig()
  const { token, workspaceId, baseUrl } = loadToken(loreConfig)
  const { pageId: vaultPageId } = loadVaultConfig(loreConfig, configPath)

  console.log(`Probe v${VERSION} — endpoint=${args.endpoint}`)
  console.log(`Workspace id: ${workspaceId}`)
  console.log(`Vault page id: ${vaultPageId}`)
  if (configPath) console.log(`Config: ${configPath}`)
  console.log(`Token prefix: ${token.slice(0, 4)}...`)
  if (baseUrl) console.log(`Base URL: ${baseUrl}`)
  console.log("")

  // No rate-limit wrapper — direct SDK client.
  const client = new Client({ auth: token, ...(baseUrl ? { baseUrl } : {}) })

  console.log("→ Locating Memories data source...")
  const dsId = await findMemoriesDataSourceId(client, vaultPageId)
  console.log(`  Memories data source: ${dsId}`)

  // `query` doesn't need pre-collected ids — every call issues the same
  // first-page query against the data source. The other two endpoints
  // need page ids to address.
  const needsIds = args.endpoint !== "query"
  let ids = []
  if (needsIds) {
    console.log("→ Collecting up to 100 live memory page ids...")
    ids = await collectMemoryPageIds(client, dsId, 100)
    console.log(`  Collected ${ids.length} ids.`)
  }
  console.log("")

  const callFn = buildCaller(args.endpoint, dsId)
  const inputSetSize = needsIds ? ids.length : 100
  const sizes = PROBE_SIZES.filter((s) => s <= inputSetSize)
  const concurrencies = PROBE_CONCURRENCIES
  const droppedSizes = PROBE_SIZES.filter((s) => !sizes.includes(s))

  if (sizes.length === 0) {
    console.error("")
    console.error(
      `ERROR: vault has ${ids.length} live memories; the smallest probe cell ` +
        `requires ${PROBE_SIZES[0]}. No throughput cells can run — aborting.`,
    )
    process.exit(3)
  }

  if (droppedSizes.length > 0) {
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

  // For `query`, the per-cell input is N opaque markers (the values
  // aren't read by `buildCaller("query")`); for the page-id endpoints
  // we slice the collected ids list. Both produce an iterable of
  // length `size` so `runCell` doesn't need to know which is which.
  const inputForSize = (size) =>
    needsIds ? ids.slice(0, size) : Array.from({ length: size }, () => null)

  let anyCellFailed = false
  for (const size of sizes) {
    for (const concurrency of concurrencies) {
      const slice = inputForSize(size)
      process.stdout.write(
        `size=${size.toString().padStart(3)} concurrency=${concurrency.toString().padStart(2)} ... `,
      )
      try {
        const r = await runCell(client, slice, concurrency, callFn)
        console.log(
          `elapsed=${r.elapsedMs}ms rps=${r.rps} p50=${r.p50}ms p95=${r.p95}ms max=${r.max}ms 429s=${r.count429}${
            r.maxRetryAfterMs > 0 ? ` retryAfterMax=${r.maxRetryAfterMs}ms` : ""
          }`,
        )
      } catch (err) {
        console.log(`FAILED: ${err?.message ?? String(err)}`)
        anyCellFailed = true
      }
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
