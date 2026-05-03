import { execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

const guardPath = fileURLToPath(
  new URL("../tools/check-lore-config.mjs", import.meta.url)
)
const installerPath = fileURLToPath(
  new URL("../tools/install-git-hooks.mjs", import.meta.url)
)

let scratchDirs: string[] = []

interface GuardModule {
  validateLoreConfig(raw: string, label?: string): string[]
  validateStagedLoreConfig(cwd?: string): string[]
}

interface InstallerModule {
  installGitHooks(options?: {
    cwd?: string
    env?: Record<string, string | undefined>
  }): void
}

afterEach(() => {
  for (const dir of scratchDirs) rmSync(dir, { recursive: true, force: true })
  scratchDirs = []
})

function scratchDir(name: string) {
  const dir = mkdtempSync(join(tmpdir(), name))
  scratchDirs.push(dir)
  return dir
}

function writeConfig(dir: string, raw: string) {
  const file = join(dir, ".lore.yaml")
  writeFileSync(file, raw)
  return file
}

async function loadGuardModule(): Promise<GuardModule> {
  return (await import(pathToFileURL(guardPath).href)) as GuardModule
}

async function loadInstallerModule(): Promise<InstallerModule> {
  return (await import(pathToFileURL(installerPath).href)) as InstallerModule
}

function git(repo: string, args: string[]) {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
}

describe("committed Lore config guard", () => {
  it("allows the safe repository placeholder config", async () => {
    const { validateLoreConfig } = await loadGuardModule()
    const errors = validateLoreConfig(`
vault:
  pageId: "<your-vault-page-id>"
projects: []
`)

    expect(errors).toEqual([])
  })

  it("rejects committed auth.token values", async () => {
    const { validateLoreConfig } = await loadGuardModule()
    const errors = validateLoreConfig(`
vault:
  pageId: "<your-vault-page-id>"
auth:
  token: "secret"
`)

    expect(errors.join("\n")).toContain("auth.token")
  })

  it("rejects committed personal vault page ids", async () => {
    const { validateLoreConfig } = await loadGuardModule()
    const errors = validateLoreConfig(`
vault:
  pageId: "personal-vault-page-id"
`)

    expect(errors.join("\n")).toContain("personal vault page IDs")
  })

  it("checks the staged .lore.yaml content instead of unstaged edits", async () => {
    const { validateStagedLoreConfig } = await loadGuardModule()
    const repo = scratchDir("lore-config-guard-staged-")
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" })

    writeConfig(
      repo,
      `
vault:
  pageId: "<your-vault-page-id>"
`
    )
    execFileSync("git", ["add", ".lore.yaml"], { cwd: repo })

    writeConfig(
      repo,
      `
vault:
  pageId: "personal-vault-page-id"
auth:
  token: "secret"
`
    )

    const stagedSafe = validateStagedLoreConfig(repo)
    expect(stagedSafe).toEqual([])

    execFileSync("git", ["add", ".lore.yaml"], { cwd: repo })
    const stagedUnsafe = validateStagedLoreConfig(repo)
    expect(stagedUnsafe.join("\n")).toContain("auth.token")
    expect(stagedUnsafe.join("\n")).toContain("vault.pageId")
  }, 30_000)
})

describe("Lore git hook installer", () => {
  function initRepo() {
    const repo = scratchDir("lore-git-hooks-install-")
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" })
    mkdirSync(join(repo, ".githooks"))
    return repo
  }

  async function runInstaller(repo: string) {
    const { installGitHooks } = await loadInstallerModule()
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      installGitHooks({
        cwd: repo,
        env: {
          ...process.env,
          CI: "",
          LORE_SKIP_GIT_HOOK_INSTALL: "",
        },
      })
    } finally {
      stderr.mockRestore()
    }
  }

  it("sets core.hooksPath to .githooks on a fresh checkout", async () => {
    const repo = initRepo()

    await runInstaller(repo)

    expect(git(repo, ["config", "--local", "--get", "core.hooksPath"])).toBe(".githooks")
  }, 30_000)

  it("adds a wrapper to an existing hook path when no pre-commit hook exists", async () => {
    const repo = initRepo()
    const customHooks = join(repo, "custom-hooks")
    mkdirSync(customHooks)
    git(repo, ["config", "--local", "core.hooksPath", customHooks])

    await runInstaller(repo)

    const wrapper = join(customHooks, "pre-commit")
    expect(existsSync(wrapper)).toBe(true)
    expect(readFileSync(wrapper, "utf8")).toContain(
      'repo_hook="$repo_root/.githooks/pre-commit"'
    )
    expect(git(repo, ["config", "--local", "--get", "core.hooksPath"])).toBe(customHooks)
  }, 30_000)
})
