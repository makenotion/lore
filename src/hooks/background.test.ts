/**
 * Tests for `spawnBackgroundSave`'s `safeEnv` construction (#188).
 *
 * The Stop-hook autosave / digest paths spawn a detached `claude -p`
 * with a deliberately minimal env. Pre-#188 only the legacy
 * `LORE_NOTION_TOKEN` / `LORE_NOTION_BASE_URL` / `LORE_USER_NAME`
 * keys were forwarded, so an operator authenticated via
 * `NOTION_API_TOKEN` (the canonical 0.10.0 path) — or a
 * multi-workspace ntn user with `NOTION_WORKSPACE_ID` — saw their
 * foreground CLI / MCP calls succeed while hook workers silently
 * failed auth or selected the wrong workspace.
 *
 * These tests pin the post-#188 contract: every key in
 * `RUNTIME_FORWARDED_KEYS` (the shared install/hooks allowlist —
 * `src/auth/forwarded-env.ts`) forwards conditionally from
 * `process.env` into the spawned child's env, mirroring the
 * placeholder set `lore install` writes into MCP host config.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

vi.hoisted(() => {
  process.env["LORE_HOOK_STATE_DIR"] =
    `${process.env["TMPDIR"] ?? "/tmp"}/lore-background-state-${process.pid}-${Date.now()}`
})

const { spawnMock, execFileSyncMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(() => "/mock/bin/claude\n"),
}))

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, spawn: spawnMock, execFileSync: execFileSyncMock }
})

import { RUNTIME_FORWARDED_KEYS } from "../auth/forwarded-env.js"
import { spawnBackgroundSave } from "./background.js"
import { getStateDir } from "./lock.js"

function fakeLiveChild(): {
  pid: number
  unref: () => void
  kill: (signal?: string) => boolean
} {
  return {
    pid: process.pid,
    unref: () => {},
    kill: () => true,
  }
}

function lastSpawnEnv(): Record<string, string> {
  expect(spawnMock).toHaveBeenCalledTimes(1)
  const call = spawnMock.mock.calls.at(-1) as
    | [string, string[], { env: Record<string, string> }]
    | undefined
  expect(call, "expected spawn to have been invoked").toBeDefined()
  return call![2].env
}

describe("spawnBackgroundSave safeEnv (#188)", () => {
  let tmpDir: string

  // Clear every key in the forwarded allowlist before each test so a
  // value carried in from the developer's shell doesn't leak into the
  // assertions. Restore on teardown so a CI runner re-using the
  // process for sibling tests sees the same env it started with.
  let savedEnv: Partial<Record<(typeof RUNTIME_FORWARDED_KEYS)[number], string | undefined>>

  beforeEach(() => {
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "lore-bg-test-")))

    savedEnv = {}
    for (const key of RUNTIME_FORWARDED_KEYS) {
      savedEnv[key] = process.env[key]
      delete process.env[key]
    }

    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeLiveChild())
    execFileSyncMock.mockReset()
    execFileSyncMock.mockImplementation(() => "/mock/bin/claude\n")
  })

  afterEach(() => {
    for (const key of RUNTIME_FORWARDED_KEYS) {
      const prior = savedEnv[key]
      if (prior === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = prior
      }
    }
    rmSync(tmpDir, { recursive: true, force: true })
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
  })

  it("always forwards PATH, HOME, and the LORE_AUTOSAVE=false guard", () => {
    process.env["PATH"] = "/usr/bin:/bin"
    process.env["HOME"] = "/home/test"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    expect(env["PATH"]).toBe("/usr/bin:/bin")
    expect(env["HOME"]).toBe("/home/test")
    // The `LORE_AUTOSAVE=false` guard prevents the spawned `claude -p`
    // from triggering its own autosave on its Stop event — without
    // it, every spawn would recursively spawn another spawn.
    expect(env["LORE_AUTOSAVE"]).toBe("false")
  })

  it("forwards NOTION_API_TOKEN so a canonical-auth operator's hook worker auths without LORE_NOTION_TOKEN (#188)", () => {
    // The 0.10.0 acceptance criterion. Pre-#188 a `NOTION_API_TOKEN`-
    // only operator had to also export `LORE_NOTION_TOKEN` for the
    // hook spawn to auth — surfacing as silent autosave failures.
    process.env["NOTION_API_TOKEN"] = "secret_canonical_token"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    expect(env["NOTION_API_TOKEN"]).toBe("secret_canonical_token")
    // Legacy keys must not be conjured when only the canonical key
    // is set — confirms the conditional-forward shape.
    expect("LORE_NOTION_TOKEN" in env).toBe(false)
  })

  it("forwards NOTION_WORKSPACE_ID so multi-workspace ntn hook workers pick the right workspace (#188)", () => {
    // Multi-workspace ntn users select a workspace via
    // `NOTION_WORKSPACE_ID`. Without forwarding, the spawned child's
    // `loadNtnToken` re-runs against `auth.json` and either auto-
    // picks the wrong workspace (single-workspace shape) or throws
    // with a "specify a workspace" hint.
    process.env["NOTION_WORKSPACE_ID"] = "ws_team_alpha"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    expect(lastSpawnEnv()["NOTION_WORKSPACE_ID"]).toBe("ws_team_alpha")
  })

  it("forwards every base-URL selector so a non-prod hook worker hits the same Notion env as the foreground (#188)", () => {
    // `resolveOperatorBaseUrl` reads the four keys in priority
    // order. Forwarding all four keeps the spawned child on the
    // same priority chain as the foreground `resolveAuth`.
    process.env["LORE_NOTION_BASE_URL"] = "https://api-dev.notion.com"
    process.env["NOTION_BASE_URL"] = "https://api-stg.notion.com"
    process.env["NOTION_API_BASE_URL"] = "https://api-legacy.notion.com"
    process.env["NOTION_ENV"] = "dev"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    expect(env["LORE_NOTION_BASE_URL"]).toBe("https://api-dev.notion.com")
    expect(env["NOTION_BASE_URL"]).toBe("https://api-stg.notion.com")
    expect(env["NOTION_API_BASE_URL"]).toBe("https://api-legacy.notion.com")
    expect(env["NOTION_ENV"]).toBe("dev")
  })

  it("preserves the legacy LORE_NOTION_TOKEN forwarder so soft-deprecated operators keep working", () => {
    // The 0.10.0 priority chain still honors `LORE_NOTION_TOKEN` —
    // dropping the forward here would break hook workers for any
    // operator who hasn't migrated to `lore auth --login` yet.
    process.env["LORE_NOTION_TOKEN"] = "secret_legacy_lore_token"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    expect(lastSpawnEnv()["LORE_NOTION_TOKEN"]).toBe("secret_legacy_lore_token")
  })

  it("forwards LORE_USER_NAME (DEFERRED-ATTRIBUTION) when set so the spawned MCP child skips the users.me round-trip", () => {
    process.env["LORE_USER_NAME"] = "Hesham Salman"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    expect(lastSpawnEnv()["LORE_USER_NAME"]).toBe("Hesham Salman")
  })

  it("does NOT inject any forwarded key when none are set in the parent env (no empty-string injection)", () => {
    // Mirrors the install path's empty-env contract: no spurious
    // entries appear so the spawned child's `resolveAuth` falls
    // through to its own ntn-resolution path cleanly.
    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    for (const key of RUNTIME_FORWARDED_KEYS) {
      expect(key in env, `${key} unexpectedly present in safeEnv`).toBe(false)
    }
  })

  it("treats empty-string env values as unset (no `${VAR}` blank-write into the child)", () => {
    // An operator with `export NOTION_API_TOKEN=""` declared but
    // empty would otherwise short-circuit `resolveAuth`'s priority
    // chain in the spawned child. Same posture as `buildMcpEnv` in
    // `install.ts` — empty strings drop from the forward.
    process.env["NOTION_API_TOKEN"] = ""
    process.env["LORE_NOTION_TOKEN"] = "non-empty"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    expect("NOTION_API_TOKEN" in env).toBe(false)
    expect(env["LORE_NOTION_TOKEN"]).toBe("non-empty")
  })

  it("forwards the full eight-key allowlist when the operator has a complete dev shell environment", () => {
    // Pathological-but-real: the full ntn-dev shell. Pinning every
    // key here means a future regression that drops a single
    // forwarder fails one assertion and surfaces the dropped key by
    // name in the diff.
    process.env["NOTION_API_TOKEN"] = "secret_api"
    process.env["LORE_NOTION_TOKEN"] = "secret_lore"
    process.env["LORE_NOTION_BASE_URL"] = "https://api-dev.notion.com"
    process.env["NOTION_WORKSPACE_ID"] = "ws_dev"
    process.env["NOTION_ENV"] = "dev"
    process.env["NOTION_BASE_URL"] = "https://api-dev.notion.com"
    process.env["NOTION_API_BASE_URL"] = "https://api-dev.notion.com"
    process.env["LORE_USER_NAME"] = "Hesham Salman"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    for (const key of RUNTIME_FORWARDED_KEYS) {
      expect(env[key], `expected ${key} to be forwarded`).toBe(process.env[key])
    }
  })

  it("does not forward LORE_AGENT_NAME — agent identity rides in the prompt text, not the spawn env", () => {
    // The hook's prompt text already carries `Agent: <name>` and the
    // `pass agent: "..." verbatim` instruction, and the MCP boundary
    // applies the override via `args.agent` — forwarding via env
    // would double up and conflict with the prompt-text path.
    process.env["LORE_AGENT_NAME"] = "Codex"
    try {
      const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
      expect(result.kind).toBe("spawned")

      expect("LORE_AGENT_NAME" in lastSpawnEnv()).toBe(false)
    } finally {
      delete process.env["LORE_AGENT_NAME"]
    }
  })
})
