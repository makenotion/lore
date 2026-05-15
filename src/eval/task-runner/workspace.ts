import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

export async function prepareWorkspace(input: {
  source: string
  suiteRoot: string
  declaredPath: string
}): Promise<string> {
  // Path-escape guard. `task.workspace` is operator-controlled YAML; a
  // malicious or careless `../../../etc` could otherwise turn `fs.cp`
  // into a recursive read of arbitrary host filesystem directories
  // (and write them into a tmpdir handed to the agent). The legitimate
  // boundary is the suite root's parent — sibling directories like
  // `evals/workspaces/<name>` are valid, anything that climbs above
  // `evals/` is not. Mirrors the `seedMemoryCondition` boundary.
  const evalsRoot = dirname(input.suiteRoot)
  const rel = relative(evalsRoot, input.source)
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
  await cp(input.source, dir, { recursive: true, preserveTimestamps: true })
  return dir
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
