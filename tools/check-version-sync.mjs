#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"

export const VERSION_SOURCE_PATHS = {
  packageJson: "package.json",
  packageLock: "package-lock.json",
  mcpServer: "src/mcp/server.ts",
  cliIndex: "src/cli/index.ts",
  notionClient: "src/notion/client.ts",
}

const VERSION_SOURCES = [
  {
    path: VERSION_SOURCE_PATHS.packageJson,
    label: "package.json#version",
    extract: extractPackageVersion,
  },
  {
    path: VERSION_SOURCE_PATHS.packageLock,
    label: "package-lock.json#version",
    extract: extractPackageLockVersion,
  },
  {
    path: VERSION_SOURCE_PATHS.packageLock,
    label: 'package-lock.json#packages[""].version',
    extract: extractPackageLockRootVersion,
  },
  {
    path: VERSION_SOURCE_PATHS.mcpServer,
    label: "src/mcp/server.ts McpServer version",
    extract: extractMcpServerVersion,
  },
  {
    path: VERSION_SOURCE_PATHS.cliIndex,
    label: "src/cli/index.ts Commander version",
    extract: extractCliVersion,
  },
  {
    path: VERSION_SOURCE_PATHS.notionClient,
    label: "src/notion/client.ts USER_AGENT version",
    extract: extractUserAgentVersion,
  },
]

function usage() {
  return [
    "Usage:",
    "  node tools/check-version-sync.mjs",
    "  node tools/check-version-sync.mjs --staged",
  ].join("\n")
}

function messageFor(error) {
  return error instanceof Error ? error.message : String(error)
}

function extractMatch(raw, pattern, description) {
  const match = raw.match(pattern)
  if (!match || typeof match[1] !== "string" || match[1].length === 0) {
    throw new Error(`cannot find ${description}`)
  }
  return match[1]
}

export function extractPackageVersion(raw) {
  const parsed = parseJson(raw, "package.json")

  if (!parsed || typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package.json#version must be a non-empty string")
  }

  return parsed.version
}

function parseJson(raw, label) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`cannot parse ${label}: ${messageFor(error)}`, {
      cause: error,
    })
  }
  return parsed
}

export function extractPackageLockVersion(raw) {
  const parsed = parseJson(raw, "package-lock.json")

  if (!parsed || typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("package-lock.json#version must be a non-empty string")
  }

  return parsed.version
}

export function extractPackageLockRootVersion(raw) {
  const parsed = parseJson(raw, "package-lock.json")
  const rootPackage = parsed?.packages?.[""]

  if (
    !rootPackage ||
    typeof rootPackage.version !== "string" ||
    rootPackage.version.length === 0
  ) {
    throw new Error('package-lock.json#packages[""].version must be a non-empty string')
  }

  return rootPackage.version
}

export function extractMcpServerVersion(raw) {
  return extractMatch(
    raw,
    /new\s+McpServer\s*\(\s*\{[\s\S]*?\bversion:\s*["']([^"']+)["']/,
    'new McpServer({ ..., version: "..." })'
  )
}

export function extractCliVersion(raw) {
  return extractMatch(
    raw,
    /\.version\(\s*["']([^"']+)["']\s*\)/,
    'Commander .version("...")'
  )
}

export function extractUserAgentVersion(raw) {
  return extractMatch(
    raw,
    /const\s+USER_AGENT\s*=\s*["']lore\/([^"']+)["']/,
    'USER_AGENT = "lore/..."'
  )
}

function readWorktreeFile(cwd, path) {
  return readFileSync(join(cwd, path), "utf8")
}

function readStagedFile(cwd, path) {
  try {
    return execFileSync("git", ["show", `:${path}`], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    })
  } catch (error) {
    throw new Error(`cannot read staged ${path} from the git index`, { cause: error })
  }
}

export function validateVersionSources(contents) {
  const entries = VERSION_SOURCES.map((source) => {
    const raw = contents[source.path]
    if (typeof raw !== "string") {
      return {
        source,
        error: `missing ${source.path}`,
      }
    }

    try {
      return {
        source,
        version: source.extract(raw),
      }
    } catch (error) {
      return {
        source,
        error: messageFor(error),
      }
    }
  })

  const errors = entries
    .filter((entry) => entry.error)
    .map((entry) => `${entry.source.label}: ${entry.error}`)

  if (errors.length > 0) return errors

  const packageVersion = entries.find(
    (entry) => entry.source.path === VERSION_SOURCE_PATHS.packageJson
  )?.version

  for (const entry of entries) {
    if (entry.version !== packageVersion) {
      errors.push(
        `${entry.source.label}: ${entry.version} (expected ${packageVersion} from package.json#version)`
      )
    }
  }

  return errors
}

export function validateVersionSync(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const readVersionFile = options.staged
    ? (path) => readStagedFile(cwd, path)
    : (path) => readWorktreeFile(cwd, path)

  const contents = {}
  const readErrors = []
  const seenPaths = new Set()

  for (const source of VERSION_SOURCES) {
    if (seenPaths.has(source.path)) continue
    seenPaths.add(source.path)

    try {
      contents[source.path] = readVersionFile(source.path)
    } catch (error) {
      readErrors.push(`${source.label}: ${messageFor(error)}`)
    }
  }

  if (readErrors.length > 0) return readErrors

  return validateVersionSources(contents)
}

function fail(errors) {
  process.stderr.write("[lore] version literals are out of sync:\n")
  for (const error of errors) process.stderr.write(`- ${error}\n`)
  process.exit(1)
}

export function main(args = process.argv.slice(2)) {
  let staged = false

  if (args.length === 1 && args[0] === "--staged") {
    staged = true
  } else if (args.length !== 0) {
    process.stderr.write(`${usage()}\n`)
    process.exit(2)
  }

  const errors = validateVersionSync({ staged })
  if (errors.length > 0) fail(errors)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
