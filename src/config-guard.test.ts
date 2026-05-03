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

function gitConfig(repo: string, key: string) {
  try {
    return git(repo, ["config", "--local", "--get", key])
  } catch {
    return ""
  }
}

describe("committed Lore config guard", () => {
  it("allows the shared repository vault config", async () => {
    const { validateLoreConfig } = await loadGuardModule()
    const errors = validateLoreConfig(`
vault:
  pageId: "343b35e6e67f81a0afa9c9801b35199f"
projects: []
`)

    expect(errors).toEqual([])
  })

  it("rejects committed auth.token values", async () => {
    const { validateLoreConfig } = await loadGuardModule()
    const errors = validateLoreConfig(`
vault:
  pageId: "343b35e6e67f81a0afa9c9801b35199f"
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

  it("rejects committed starter page id placeholders", async () => {
    const { validateLoreConfig } = await loadGuardModule()
    const errors = validateLoreConfig(`
vault:
  pageId: "<your-vault-page-id>"
`)

    expect(errors.join("\n")).toContain("approved shared team vault page ID")
  })

  it("checks the staged .lore.yaml content instead of unstaged edits", async () => {
    const { validateStagedLoreConfig } = await loadGuardModule()
    const repo = scratchDir("lore-config-guard-staged-")
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" })

    writeConfig(
      repo,
      `
vault:
  pageId: "343b35e6e67f81a0afa9c9801b35199f"
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
    const writes: string[] = []
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      writes.push(String(chunk))
      return true
    })
    try {
      installGitHooks({
        cwd: repo,
        env: {
          ...process.env,
          CI: "",
          LORE_SKIP_GIT_HOOK_INSTALL: "",
        },
      })
      return writes.join("")
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

  it("preserves active default hooks by adding a pre-commit wrapper", async () => {
    const repo = initRepo()
    const defaultHooks = join(repo, ".git", "hooks")
    writeFileSync(join(defaultHooks, "pre-push"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })

    await runInstaller(repo)

    const wrapper = join(defaultHooks, "pre-commit")
    expect(existsSync(wrapper)).toBe(true)
    expect(readFileSync(wrapper, "utf8")).toContain(
      'repo_hook="$repo_root/.githooks/pre-commit"'
    )
    expect(gitConfig(repo, "core.hooksPath")).toBe("")
  }, 30_000)

  it("does not replace an existing default pre-commit hook", async () => {
    const repo = initRepo()
    const preCommit = join(repo, ".git", "hooks", "pre-commit")
    const existingHook = "#!/bin/sh\nexit 0\n"
    writeFileSync(preCommit, existingHook, { mode: 0o755 })

    const stderr = await runInstaller(repo)

    expect(readFileSync(preCommit, "utf8")).toBe(existingHook)
    expect(gitConfig(repo, "core.hooksPath")).toBe("")
    expect(stderr).toContain("default Git hooks already exist")
  }, 30_000)
})
