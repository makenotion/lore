import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"
import type {
  GitWorkspaceSource,
  TaskEvalWorkspaceSource,
  WorkspaceMaterialization,
} from "./schema.js"

export async function prepareWorkspace(input: {
  source: TaskEvalWorkspaceSource
  suiteRoot: string
  declaredPath: string
}): Promise<PreparedWorkspace> {
  if (typeof input.source !== "string") {
    return prepareGitWorkspace(input.source)
  }
  const source = resolve(input.suiteRoot, input.source)
  // Path-escape guard. `task.workspace` is operator-controlled YAML; a
  // malicious or careless `../../../etc` could otherwise turn `fs.cp`
  // into a recursive read of arbitrary host filesystem directories
  // (and write them into a tmpdir handed to the agent). The legitimate
  // boundary is the suite root's parent — sibling directories like
  // `evals/workspaces/<name>` are valid, anything that climbs above
  // `evals/` is not. Mirrors the `seedMemoryCondition` boundary.
  const evalsRoot = dirname(input.suiteRoot)
  const rel = relative(evalsRoot, source)
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(
      `Workspace fixture path "${input.declaredPath}" escapes the eval-suite parent directory`
    )
  }
  const dir = await mkdtemp(join(tmpdir(), "lore-eval-task-"))
  // `fs.cp` (Node 16.7+) preserves modes and handles symlinks/dotfiles
  // out of the box. The recursive flag walks subdirectories; verbatim
  // mode preservation matters when a fixture commits an executable
  // script (e.g. `scripts/setup.sh`) whose +x bit must survive the copy.
  await cp(source, dir, { recursive: true, preserveTimestamps: true })
  return {
    workspace: dir,
    sourceRoot: source,
    sourceLabel: source,
    materialization: { kind: "local", source },
  }
}

export async function rematerializeWorkspace(source: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "lore-eval-task-"))
  await cp(source, dir, { recursive: true, preserveTimestamps: true })
  return dir
}

export async function seedMemoryCondition(input: {
  suiteRoot: string
  fixturePath: string
  workspace: string
}): Promise<void> {
  const absolute = resolve(input.suiteRoot, input.fixturePath)
  // Path-escape guard. Production memory fixtures live next to the
  // suite root in a sibling directory (e.g., a YAML suite reading a
  // JSON memory fixture in a peer subdirectory), so the legitimate
  // read scope is
  // "under the suite root's parent" — NOT the suite root itself, and
  // NOT a broader `evals/` ancestor. The boundary intentionally allows
  // sibling-directory reads (task-memory/, baselines/) but rejects
  // anything that escapes via `../../../etc/...`.
  const evalsRoot = dirname(input.suiteRoot)
  const rel = relative(evalsRoot, absolute)
  // `rel.startsWith("/")` is a Windows-port hedge; `path.relative` on
  // POSIX never returns an absolute path, but on win32 it can return
  // a drive-letter path (`C:\...`) that no `..` prefix would catch.
  if (rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(
      `Memory-condition fixture path "${input.fixturePath}" escapes the eval-suite parent directory`
    )
  }
  const contents = await readFile(absolute, "utf-8")
  // Conventional drop point: .lore-memories.json at the workspace
  // root. Agent prompts that are matrix-aware reference this path.
  await writeFile(join(input.workspace, ".lore-memories.json"), contents, "utf-8")
}

export interface PreparedWorkspace {
  workspace: string
  sourceRoot: string
  sourceLabel: string
  materialization: WorkspaceMaterialization
}

async function prepareGitWorkspace(
  source: GitWorkspaceSource
): Promise<PreparedWorkspace> {
  const cachePath = gitWorkspaceCachePath(source)
  if (!(await pathExists(cachePath))) {
    await populateGitCache(source, cachePath)
  }
  const dir = await mkdtemp(join(tmpdir(), "lore-eval-task-"))
  await cp(cachePath, dir, { recursive: true, preserveTimestamps: true })
  return {
    workspace: dir,
    sourceRoot: cachePath,
    sourceLabel: `git:${source.repo}@${source.sha}`,
    materialization: {
      kind: "git",
      repo: source.repo,
      sha: source.sha,
      sparseCheckout: source.sparseCheckout ?? [],
      cachePath,
    },
  }
}

function gitWorkspaceCachePath(source: GitWorkspaceSource): string {
  const [owner, repo] = source.repo.split("/") as [string, string]
  const sparseKey = createHash("sha256")
    .update(JSON.stringify(source.sparseCheckout ?? []))
    .digest("hex")
    .slice(0, 12)
  return join(resolveEvalWorkspaceCacheRoot(), "git", owner, repo, source.sha, sparseKey)
}

function resolveEvalWorkspaceCacheRoot(): string {
  const explicit = process.env["LORE_EVAL_WORKSPACE_CACHE_DIR"]
  if (explicit) return resolve(explicit)
  const xdg = process.env["XDG_CACHE_HOME"]
  if (xdg) return join(xdg, "lore", "eval-workspaces")
  const home = process.env["HOME"]
  if (home) return join(home, ".cache", "lore", "eval-workspaces")
  return join(tmpdir(), "lore-eval-workspaces")
}

async function populateGitCache(
  source: GitWorkspaceSource,
  cachePath: string
): Promise<void> {
  const parent = dirname(cachePath)
  await mkdir(parent, { recursive: true })
  const temp = await mkdtemp(join(parent, ".tmp-"))
  try {
    await git(["init", "--quiet"], temp)
    await git(["remote", "add", "origin", resolveGitRemoteUrl(source.repo)], temp)
    if (source.sparseCheckout && source.sparseCheckout.length > 0) {
      await git(["sparse-checkout", "init", "--no-cone"], temp)
      await git(["sparse-checkout", "set", ...source.sparseCheckout], temp)
    }
    await git(["fetch", "--depth=1", "--quiet", "origin", source.sha], temp)
    await git(["checkout", "--quiet", "--detach", "FETCH_HEAD"], temp)
    if (await pathExists(cachePath)) {
      await rm(temp, { recursive: true, force: true })
      return
    }
    await rename(temp, cachePath)
  } catch (err) {
    await rm(temp, { recursive: true, force: true })
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Failed to materialize git workspace ${source.repo}#${source.sha}: ${message}`,
      { cause: err }
    )
  }
}

function resolveGitRemoteUrl(repo: string): string {
  const base = process.env["LORE_EVAL_GIT_REMOTE_BASE_URL"] ?? "https://github.com"
  if (base.startsWith("file://")) return `${base.replace(/\/$/u, "")}/${repo}.git`
  if (base.startsWith("/")) return join(base, `${repo}.git`)
  return `${base.replace(/\/$/u, "")}/${repo}.git`
}

function git(args: string[], cwd: string): Promise<void> {
  return new Promise((resolveGit, reject) => {
    execFile("git", args, { cwd }, (err, _stdout, stderr) => {
      if (err) {
        reject(new Error(stderr.trim() || err.message))
      } else {
        resolveGit()
      }
    })
  })
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
