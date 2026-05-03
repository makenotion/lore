#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"
import { parse as parseYaml } from "yaml"

const CONFIG_PATH = ".lore.yaml"
const ALLOWED_REPO_PAGE_IDS = new Set(["343b35e6e67f81a0afa9c9801b35199f"])
const ALLOWED_REPO_PAGE_ID_LIST = [...ALLOWED_REPO_PAGE_IDS]
  .map((pageId) => JSON.stringify(pageId))
  .join(", ")

function usage() {
  return [
    "Usage:",
    `  node tools/check-lore-config.mjs --file ${CONFIG_PATH}`,
    "  node tools/check-lore-config.mjs --staged",
  ].join("\n")
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key)
}

export function validateLoreConfig(raw, label = CONFIG_PATH) {
  const errors = []
  let parsed

  try {
    parsed = parseYaml(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return [`${label} could not be parsed as YAML: ${message}`]
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return [`${label} must contain a YAML mapping.`]
  }

  const auth = parsed.auth
  if (auth && typeof auth === "object" && !Array.isArray(auth) && hasOwn(auth, "token")) {
    errors.push(
      `${label} must not contain auth.token. Use NOTION_API_TOKEN or run lore auth --login instead.`
    )
  }

  const vault = parsed.vault
  const pageId =
    vault && typeof vault === "object" && !Array.isArray(vault) ? vault.pageId : undefined

  if (!ALLOWED_REPO_PAGE_IDS.has(pageId)) {
    errors.push(
      `${label} must keep vault.pageId set to an approved shared team vault page ID ` +
        `(${ALLOWED_REPO_PAGE_ID_LIST}); do not commit personal vault page IDs.`
    )
  }

  return errors
}

export function readStagedConfig(cwd = process.cwd()) {
  return execFileSync("git", ["show", `:${CONFIG_PATH}`], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

export function validateStagedLoreConfig(cwd = process.cwd()) {
  return validateLoreConfig(readStagedConfig(cwd), `staged ${CONFIG_PATH}`)
}

function fail(errors) {
  process.stderr.write("[lore] blocked unsafe committed config:\n")
  for (const error of errors) process.stderr.write(`- ${error}\n`)
  process.exit(1)
}

export function main(args = process.argv.slice(2)) {
  let raw
  let label = CONFIG_PATH

  if (args.length === 2 && args[0] === "--file") {
    label = args[1]
    raw = readFileSync(label, "utf8")
  } else if (args.length === 1 && args[0] === "--staged") {
    try {
      const errors = validateStagedLoreConfig()
      if (errors.length > 0) fail(errors)
      return
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fail([`could not read staged ${CONFIG_PATH}: ${message}`])
    }
  } else {
    process.stderr.write(`${usage()}\n`)
    process.exit(2)
  }

  const errors = validateLoreConfig(raw, label)
  if (errors.length > 0) fail(errors)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
