#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"

const DESIRED_HOOKS_PATH = ".githooks"

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim()
}

function normalizeHooksPath(repoRoot, hooksPath) {
  if (!hooksPath) return ""
  return resolve(repoRoot, hooksPath)
}

function gitHooksPath(repoRoot) {
  return normalizeHooksPath(repoRoot, git(["rev-parse", "--git-path", "hooks"], { cwd: repoRoot }))
}

function hasActiveHook(hooksDir) {
  if (!existsSync(hooksDir)) return false
  return readdirSync(hooksDir).some((entry) => !entry.endsWith(".sample"))
}

function preCommitWrapper() {
  return `#!/bin/sh
set -eu

repo_root=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
repo_hook="$repo_root/${DESIRED_HOOKS_PATH}/pre-commit"

if [ ! -x "$repo_hook" ]; then
  exit 0
fi

exec "$repo_hook" "$@"
`
}

export function installGitHooks(options = {}) {
  const env = options.env ?? process.env
  const cwd = options.cwd ?? process.cwd()

  if (env["CI"] === "true" || env["LORE_SKIP_GIT_HOOK_INSTALL"] === "1") {
    return
  }

  let repoRoot
  try {
    repoRoot = git(["rev-parse", "--show-toplevel"], { cwd })
  } catch {
    return
  }

  const hooksDir = join(repoRoot, DESIRED_HOOKS_PATH)
  if (!existsSync(hooksDir)) return

  let current = ""
  try {
    current = git(["config", "--local", "--get", "core.hooksPath"], { cwd: repoRoot })
  } catch {
    current = ""
  }

  if (
    current &&
    normalizeHooksPath(repoRoot, current) !==
      normalizeHooksPath(repoRoot, DESIRED_HOOKS_PATH)
  ) {
    const currentHooksDir = normalizeHooksPath(repoRoot, current)
    const currentPreCommit = join(currentHooksDir, "pre-commit")
    if (!existsSync(currentPreCommit)) {
      mkdirSync(currentHooksDir, { recursive: true })
      writeFileSync(currentPreCommit, preCommitWrapper(), { mode: 0o755 })
      process.stderr.write(
        `[lore] installed committed-config guard wrapper at ${currentPreCommit}.\n`
      )
      return
    }

    process.stderr.write(
      `[lore] core.hooksPath is already set to ${current}; leaving it unchanged. ` +
        `Chain ${DESIRED_HOOKS_PATH}/pre-commit from ${currentPreCommit} ` +
        "to enable Lore's committed-config guard.\n"
    )
    return
  }

  if (!current) {
    const defaultHooksDir = gitHooksPath(repoRoot)
    if (hasActiveHook(defaultHooksDir)) {
      const defaultPreCommit = join(defaultHooksDir, "pre-commit")
      if (!existsSync(defaultPreCommit)) {
        mkdirSync(defaultHooksDir, { recursive: true })
        writeFileSync(defaultPreCommit, preCommitWrapper(), { mode: 0o755 })
        process.stderr.write(
          `[lore] installed committed-config guard wrapper at ${defaultPreCommit}.\n`
        )
        return
      }

      process.stderr.write(
        "[lore] default Git hooks already exist; leaving core.hooksPath unset. " +
          `Chain ${DESIRED_HOOKS_PATH}/pre-commit from ${defaultPreCommit} ` +
          "to enable Lore's committed-config guard.\n"
      )
      return
    }

    git(["config", "--local", "core.hooksPath", DESIRED_HOOKS_PATH], {
      cwd: repoRoot,
    })
    process.stderr.write(`[lore] installed git hooks from ${DESIRED_HOOKS_PATH}.\n`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  installGitHooks()
}
