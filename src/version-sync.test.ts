import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const versionSyncPath = fileURLToPath(
  new URL("../tools/check-version-sync.mjs", import.meta.url)
)

const PATHS = {
  packageJson: "package.json",
  packageLock: "package-lock.json",
  mcpServer: "src/mcp/server.ts",
  cliIndex: "src/cli/index.ts",
  notionClient: "src/notion/client.ts",
}

let scratchDirs: string[] = []

interface VersionSyncModule {
  validateVersionSources(contents: Record<string, string>): string[]
  validateVersionSync(options?: { cwd?: string; staged?: boolean }): string[]
}

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  scratchDirs = []
})

async function loadVersionSyncModule(): Promise<VersionSyncModule> {
  return (await import(pathToFileURL(versionSyncPath).href)) as VersionSyncModule
}

function scratchDir(name: string) {
  const dir = mkdtempSync(join(tmpdir(), name))
  scratchDirs.push(dir)
  return dir
}

function versionFiles(version: string): Record<string, string> {
  return {
    [PATHS.packageJson]: JSON.stringify({ version }, null, 2),
    [PATHS.packageLock]: JSON.stringify(
      {
        name: "@makenotion/lore",
        version,
        lockfileVersion: 3,
        packages: {
          "": {
            name: "@makenotion/lore",
            version,
          },
        },
      },
      null,
      2
    ),
    [PATHS.mcpServer]: `new McpServer({ name: "lore", version: "${version}" }, {})`,
    [PATHS.cliIndex]: `program.name("lore").version("${version}")`,
    [PATHS.notionClient]: `const USER_AGENT = "lore/${version}"`,
  }
}

function writeVersionFiles(dir: string, version: string) {
  for (const [path, contents] of Object.entries(versionFiles(version))) {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), contents)
  }
}

function git(repo: string, args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
}

describe("version sync guard", () => {
  it("accepts the current repo version literals", async () => {
    const { validateVersionSync } = await loadVersionSyncModule()

    expect(validateVersionSync({ cwd: repoRoot })).toEqual([])
  })

  it("rejects divergent version literals", async () => {
    const { validateVersionSources } = await loadVersionSyncModule()
    const files = versionFiles("0.14.0")
    files[PATHS.cliIndex] = 'program.name("lore").version("0.15.0")'

    const errors = validateVersionSources(files)

    expect(errors.join("\n")).toContain("src/cli/index.ts Commander version")
    expect(errors.join("\n")).toContain("expected 0.14.0 from package.json#version")
  })

  it("rejects divergent lockfile top-level versions", async () => {
    const { validateVersionSources } = await loadVersionSyncModule()
    const files = versionFiles("0.14.0")
    files[PATHS.packageLock] = JSON.stringify({
      version: "0.15.0",
      packages: { "": { version: "0.14.0" } },
    })

    const errors = validateVersionSources(files)

    expect(errors.join("\n")).toContain("package-lock.json#version")
    expect(errors.join("\n")).toContain("0.15.0")
  })

  it("rejects divergent lockfile root package versions", async () => {
    const { validateVersionSources } = await loadVersionSyncModule()
    const files = versionFiles("0.14.0")
    files[PATHS.packageLock] = JSON.stringify({
      version: "0.14.0",
      packages: { "": { version: "0.15.0" } },
    })

    const errors = validateVersionSources(files)

    expect(errors.join("\n")).toContain('package-lock.json#packages[""].version')
    expect(errors.join("\n")).toContain("0.15.0")
  })

  it("reports missing version literals", async () => {
    const { validateVersionSources } = await loadVersionSyncModule()
    const files = versionFiles("0.14.0")
    files[PATHS.notionClient] = 'const USER_AGENT = "custom-client"'

    const errors = validateVersionSources(files)

    expect(errors.join("\n")).toContain('USER_AGENT = "lore/..."')
  })

  it("validates the staged index for pre-commit checks", async () => {
    const { validateVersionSync } = await loadVersionSyncModule()
    const repo = scratchDir("lore-version-sync-staged-")
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" })

    writeVersionFiles(repo, "1.2.3")
    git(repo, [
      "add",
      "package.json",
      "package-lock.json",
      "src/mcp/server.ts",
      "src/cli/index.ts",
      "src/notion/client.ts",
    ])

    writeFileSync(join(repo, PATHS.cliIndex), 'program.name("lore").version("9.9.9")')
    expect(validateVersionSync({ cwd: repo, staged: true })).toEqual([])

    git(repo, ["add", PATHS.cliIndex])
    const errors = validateVersionSync({ cwd: repo, staged: true })
    expect(errors.join("\n")).toContain("9.9.9")
  })

  it("validates staged lockfile versions for pre-commit checks", async () => {
    const { validateVersionSync } = await loadVersionSyncModule()
    const repo = scratchDir("lore-version-sync-staged-lockfile-")
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" })

    writeVersionFiles(repo, "1.2.3")
    git(repo, [
      "add",
      "package.json",
      "package-lock.json",
      "src/mcp/server.ts",
      "src/cli/index.ts",
      "src/notion/client.ts",
    ])

    const files = versionFiles("1.2.3")
    files[PATHS.packageLock] = JSON.stringify({
      version: "9.9.9",
      packages: { "": { version: "8.8.8" } },
    })
    writeFileSync(join(repo, PATHS.packageLock), files[PATHS.packageLock])
    expect(validateVersionSync({ cwd: repo, staged: true })).toEqual([])

    git(repo, ["add", PATHS.packageLock])
    const errors = validateVersionSync({ cwd: repo, staged: true })
    const errorText = errors.join("\n")
    expect(errorText).toContain("package-lock.json#version")
    expect(errorText).toContain('package-lock.json#packages[""].version')
  })
})
