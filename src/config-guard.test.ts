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

describe("repo invariants", () => {
  it("does not track a `.lore.yaml` at the repo root", () => {
    // Codifies the gitignored steady state introduced with #557. The
    // pre-commit guard enforces this on new commits, but a tracked
    // file already in HEAD wouldn't trip the guard — this test pins
    // the HEAD-side invariant so a future `git add -f .lore.yaml`
    // landing through a different path (rebase, cherry-pick, manual
    // sequencer) fails CI.
    //
    // Non-git environments (vendored tarball install, npm pack) get a
    // clearer skip-with-diagnostic rather than a cryptic `fatal: not a
    // git repository` failure.
    const repoRoot = fileURLToPath(new URL("..", import.meta.url))
    let tracked: string
    try {
      tracked = execFileSync(
        "git",
        ["ls-files", "--", ".lore.yaml"],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
      ).trim()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `cannot verify repo invariant — git invocation failed (likely running outside the repo's git working tree): ${message}`,
        { cause: error }
      )
    }
    expect(tracked).toBe("")
  })
})

describe("committed Lore config guard", () => {
  it("rejects any non-empty committed .lore.yaml content", async () => {
    const { validateLoreConfig } = await loadGuardModule()
    const errors = validateLoreConfig(`
vault:
  pageId: "<your-vault-page-id>"
projects: []
`)

    expect(errors.join("\n")).toContain("must not be committed")
  })

  it("rejects committed auth.token values", async () => {
    const { validateLoreConfig } = await loadGuardModule()
    const errors = validateLoreConfig(`
vault:
  pageId: "<your-vault-page-id>"
auth:
  token: "secret"
`)

    expect(errors.join("\n")).toContain("must not be committed")
  })

  it("rejects an empty staged .lore.yaml", async () => {
    // Reviewer-flagged regression: pre-tightening, the guard returned
    // success on whitespace-only staged content, so `git add -f
    // .lore.yaml` with an empty file would slip past the pre-commit
    // hook. The new policy keys off the git index entry, not the
    // content, so any staged .lore.yaml is rejected.
    const { validateStagedLoreConfig } = await loadGuardModule()
    const repo = scratchDir("lore-config-guard-empty-")
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" })

    writeConfig(repo, "")
    execFileSync("git", ["add", "-f", ".lore.yaml"], { cwd: repo })

    const errors = validateStagedLoreConfig(repo)
    expect(errors.join("\n")).toContain("must not be committed")
  })

  it("passes silently when .lore.yaml is not tracked", async () => {
    const { validateStagedLoreConfig } = await loadGuardModule()
    const repo = scratchDir("lore-config-guard-untracked-")
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" })

    expect(validateStagedLoreConfig(repo)).toEqual([])
  })

  it("rejects staged .lore.yaml content even when unstaged edits would also fail", async () => {
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
    execFileSync("git", ["add", "-f", ".lore.yaml"], { cwd: repo })

    writeConfig(
      repo,
      `
vault:
  pageId: "personal-vault-page-id"
auth:
  token: "secret"
`
    )

    const stagedFirst = validateStagedLoreConfig(repo)
    expect(stagedFirst.join("\n")).toContain("must not be committed")

    execFileSync("git", ["add", "-f", ".lore.yaml"], { cwd: repo })
    const stagedSecond = validateStagedLoreConfig(repo)
    expect(stagedSecond.join("\n")).toContain("must not be committed")
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
