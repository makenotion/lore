#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { pathToFileURL } from "node:url"

const CONFIG_PATH = ".lore.yaml"

const COMMITTED_CONFIG_ERROR =
  `${CONFIG_PATH} must not be committed. ` +
  `Copy .lore.example.yaml to ${CONFIG_PATH} locally and keep your pageId ` +
  `and tokens out of version control.`

function usage() {
  return [
    "Usage:",
    `  node tools/check-lore-config.mjs --file ${CONFIG_PATH}`,
    "  node tools/check-lore-config.mjs --staged",
  ].join("\n")
}

export function validateLoreConfig(raw, label = CONFIG_PATH) {
  if (typeof raw !== "string") return []
  return [`${label}: ${COMMITTED_CONFIG_ERROR}`]
}

export function readStagedConfig(cwd = process.cwd()) {
  try {
    return execFileSync("git", ["show", `:${CONFIG_PATH}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch {
    return null
  }
}

export function isLoreConfigStaged(cwd = process.cwd()) {
  try {
    execFileSync("git", ["ls-files", "--cached", "--error-unmatch", CONFIG_PATH], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    })
    return true
  } catch (error) {
    // git ls-files --error-unmatch exits 1 when the file is not in
    // the index — the expected "not tracked" signal. Any other exit
    // (git missing, cwd not a repo, ICE) is an environment error
    // that should fail the guard loudly rather than silently pass.
    const status =
      error && typeof error === "object" && "status" in error
        ? error.status
        : undefined
    if (status === 1) return false
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `cannot verify ${CONFIG_PATH} stage state — git invocation failed: ${message}`,
      { cause: error }
    )
  }
}

export function validateStagedLoreConfig(cwd = process.cwd()) {
  if (!isLoreConfigStaged(cwd)) return []
  return [`staged ${CONFIG_PATH}: ${COMMITTED_CONFIG_ERROR}`]
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
    let errors
    try {
      errors = validateStagedLoreConfig()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fail([message])
    }
    if (errors && errors.length > 0) fail(errors)
    return
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
