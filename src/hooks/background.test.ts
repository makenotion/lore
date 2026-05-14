/**
 * Tests for `spawnBackgroundSave`.
 *
 * Two separate concerns covered in this file:
 *
 * 1. **`safeEnv` env forwarding (#188).** The Stop-hook autosave / digest
 *    paths spawn a detached `claude -p` with a deliberately minimal env.
 *    The `safeEnv` describe block pins that every key in
 *    `RUNTIME_FORWARDED_KEYS` forwards conditionally from `process.env`
 *    into the spawned child's env so hook workers resolve the same auth,
 *    workspace, and Notion environment as the foreground process. The
 *    `safeEnv` describe block pins the post-#188 contract: every key in
 *    `RUNTIME_FORWARDED_KEYS` (the shared install/hooks allowlist —
 *    `src/auth/forwarded-env.ts`) forwards conditionally from
 *    `process.env` into the spawned child's env.
 *
 * 2. **Prompt-file preparation cleanup (#195).** The prep block creates a
 *    temp file under $TMPDIR via O_EXCL, writes the prompt content
 *    (which includes session transcript text), closes and re-opens for
 *    read, then unlinks. If any step after the initial `openSync` throws,
 *    the catch path must close any open fd and unlink the temp file
 *    before returning `{ kind: "tempfile-failed" }` — without that
 *    cleanup, sensitive session text leaks under /tmp. The prep-failure
 *    describe block injects failures at each step by overriding the
 *    mocked `node:fs` exports; defaults pass through to real impls so a
 *    real temp file is created and cleaned up.
 *
 * The `node:fs` mock is shared across both suites: defaults pass through
 * to actual implementations so the safeEnv tests' `mkdtempSync` / `rmSync`
 * still work, and only the prep-failure tests reconfigure the openSync /
 * writeSync / closeSync / unlinkSync mocks per-test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Per-process state-dir override so this test file's lock + log markers
// don't collide with sibling test files running in parallel. Hoisted so
// the assignment runs before `./lock.js` reads the env var.
vi.hoisted(() => {
  process.env["LORE_HOOK_STATE_DIR"] =
    `${process.env["TMPDIR"] ?? "/tmp"}/lore-background-state-${process.pid}-${Date.now()}`
})

const realFs = vi.hoisted(() => {
  return {
    openSync: undefined as unknown as typeof import("node:fs").openSync,
    writeSync: undefined as unknown as typeof import("node:fs").writeSync,
    closeSync: undefined as unknown as typeof import("node:fs").closeSync,
    unlinkSync: undefined as unknown as typeof import("node:fs").unlinkSync,
    existsSync: undefined as unknown as typeof import("node:fs").existsSync,
  }
})

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs")
  realFs.openSync = actual.openSync
  realFs.writeSync = actual.writeSync
  realFs.closeSync = actual.closeSync
  realFs.unlinkSync = actual.unlinkSync
  realFs.existsSync = actual.existsSync
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    writeSync: vi.fn(actual.writeSync),
    closeSync: vi.fn(actual.closeSync),
    unlinkSync: vi.fn(actual.unlinkSync),
    existsSync: vi.fn(actual.existsSync),
  }
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

import * as fs from "node:fs"
import { RUNTIME_FORWARDED_KEYS } from "../auth/forwarded-env.js"
import { spawnBackgroundSave } from "./background.js"
import { getStateDir } from "./lock.js"
import { withClearedRuntimeEnv } from "./test-utils.js"

const openSyncMock = fs.openSync as unknown as ReturnType<typeof vi.fn>
const writeSyncMock = fs.writeSync as unknown as ReturnType<typeof vi.fn>
const closeSyncMock = fs.closeSync as unknown as ReturnType<typeof vi.fn>
const unlinkSyncMock = fs.unlinkSync as unknown as ReturnType<typeof vi.fn>

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
  const envGuard = withClearedRuntimeEnv(RUNTIME_FORWARDED_KEYS)

  beforeEach(() => {
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "lore-bg-test-")))

    envGuard.install()

    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeLiveChild())
    execFileSyncMock.mockReset()
    execFileSyncMock.mockImplementation(() => "/mock/bin/claude\n")
  })

  afterEach(() => {
    envGuard.restore()
    rmSync(tmpDir, { recursive: true, force: true })
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
  })

  it("always forwards PATH, HOME, and background child guards", () => {
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
    // The private sentinel tells the spawned agent's MCP child to fail
    // fast on init errors instead of staying alive as a diagnostic server.
    expect(env["LORE_BACKGROUND_AGENT"]).toBe("true")
  })

  it("forwards NOTION_API_TOKEN so an env-token operator's hook worker auths", () => {
    process.env["NOTION_API_TOKEN"] = "secret_canonical_token"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    expect(env["NOTION_API_TOKEN"]).toBe("secret_canonical_token")
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

  it("forwards LORE_USER_NAME (DEFERRED-ATTRIBUTION) when set so the spawned MCP child skips the users.me round-trip", () => {
    process.env["LORE_USER_NAME"] = "Test User"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    expect(lastSpawnEnv()["LORE_USER_NAME"]).toBe("Test User")
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
    process.env["LORE_NOTION_BASE_URL"] = "https://api-dev.notion.com"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    expect("NOTION_API_TOKEN" in env).toBe(false)
    expect(env["LORE_NOTION_BASE_URL"]).toBe("https://api-dev.notion.com")
  })

  it("forwards the full allowlist when the operator has a complete dev shell environment", () => {
    // Pathological-but-real: the full ntn-dev shell. Pinning every
    // key here means a future regression that drops a single
    // forwarder fails one assertion and surfaces the dropped key by
    // name in the diff.
    process.env["NOTION_API_TOKEN"] = "secret_api"
    process.env["LORE_NOTION_BASE_URL"] = "https://api-dev.notion.com"
    process.env["NOTION_WORKSPACE_ID"] = "ws_dev"
    process.env["NOTION_ENV"] = "dev"
    process.env["NOTION_BASE_URL"] = "https://api-dev.notion.com"
    process.env["NOTION_API_BASE_URL"] = "https://api-dev.notion.com"
    process.env["LORE_USER_NAME"] = "Test User"
    process.env["LORE_MCP_WRITE_BUDGET"] = "500"
    process.env["LORE_MCP_BUDGET_STATE_FILE"] = "/tmp/state.json"

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

describe("spawnBackgroundSave authSource partition (#475)", () => {
  // Mirrors the install-path partition (`buildMcpEnv`'s
  // `skipAuthTokens`): under `authSource: "ntn-auth-json"` the
  // detached child re-reads `~/.config/notion/auth.json` directly
  // and the bearer token does not need to cross the fork boundary.
  // The env-token source keeps the token forward because the child has no
  // other way to land on the same source.
  let tmpDir: string
  const envGuard = withClearedRuntimeEnv(RUNTIME_FORWARDED_KEYS)

  beforeEach(() => {
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "lore-bg-authsource-")))

    envGuard.install()

    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeLiveChild())
    execFileSyncMock.mockReset()
    execFileSyncMock.mockImplementation(() => "/mock/bin/claude\n")
  })

  afterEach(() => {
    envGuard.restore()
    rmSync(tmpDir, { recursive: true, force: true })
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
  })

  it("under authSource=ntn-auth-json, drops NOTION_API_TOKEN from safeEnv", () => {
    // The 0.10.0 ntn-first invariant: a child whose own resolveAuth
    // can re-read auth.json directly does not need bearer tokens
    // forwarded via env — their presence increases blast radius
    // (process env reads, debug logs of third-party agents) without
    // changing the child's auth contract.
    process.env["NOTION_API_TOKEN"] = "secret_canonical_token"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined, {
      authSource: "ntn-auth-json",
    })
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    expect("NOTION_API_TOKEN" in env).toBe(false)
  })

  it("under authSource=ntn-auth-json, still forwards workspace + base-URL + attribution selectors", () => {
    // Only the auth-token subset is partitioned. Multi-workspace
    // resolution and per-environment routing still need the
    // operator-controlled selectors so the child's loadNtnToken
    // picks the same workspace as the foreground.
    process.env["NOTION_API_TOKEN"] = "secret_canonical_token"
    process.env["LORE_NOTION_BASE_URL"] = "https://api-dev.notion.com"
    process.env["NOTION_WORKSPACE_ID"] = "ws_team_alpha"
    process.env["NOTION_ENV"] = "dev"
    process.env["NOTION_BASE_URL"] = "https://api-dev.notion.com"
    process.env["NOTION_API_BASE_URL"] = "https://api-dev.notion.com"
    process.env["LORE_USER_NAME"] = "Test User"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined, {
      authSource: "ntn-auth-json",
    })
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    expect(env["LORE_NOTION_BASE_URL"]).toBe("https://api-dev.notion.com")
    expect(env["NOTION_WORKSPACE_ID"]).toBe("ws_team_alpha")
    expect(env["NOTION_ENV"]).toBe("dev")
    expect(env["NOTION_BASE_URL"]).toBe("https://api-dev.notion.com")
    expect(env["NOTION_API_BASE_URL"]).toBe("https://api-dev.notion.com")
    expect(env["LORE_USER_NAME"]).toBe("Test User")
  })

  it("under authSource=env-notion-api-token, forwards NOTION_API_TOKEN as today", () => {
    // The canonical-env operator's contract: the foreground's auth
    // came from NOTION_API_TOKEN, so the child must see it too —
    // there is no on-disk source for the child to re-read.
    process.env["NOTION_API_TOKEN"] = "secret_canonical_token"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined, {
      authSource: "env-notion-api-token",
    })
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    expect(env["NOTION_API_TOKEN"]).toBe("secret_canonical_token")
  })

  it("with authSource omitted, forwards every set runtime key", () => {
    process.env["NOTION_API_TOKEN"] = "secret_canonical_token"
    process.env["LORE_NOTION_BASE_URL"] = "https://api-dev.notion.com"

    const result = spawnBackgroundSave(tmpDir, "prompt body", undefined)
    expect(result.kind).toBe("spawned")

    const env = lastSpawnEnv()
    expect(env["NOTION_API_TOKEN"]).toBe("secret_canonical_token")
    expect(env["LORE_NOTION_BASE_URL"]).toBe("https://api-dev.notion.com")
  })
})

interface PrepProbe {
  /** Per-call openSync arguments observed (path-only, both wx+ and r). */
  paths: string[]
  /** Per-call openSync return values (the fds the prep block sees). */
  fds: number[]
  /** Per-call closeSync arguments — what the cleanup path actually closed. */
  closedFds: number[]
  /** Per-call unlinkSync arguments — what the cleanup path tried to delete. */
  unlinkedPaths: string[]
}

/**
 * Wires every fs primitive used by the prep block to a single shared
 * recorder. Each step (openSync call #n, writeSync, closeSync, unlinkSync)
 * delegates to either the real implementation or a per-step throw,
 * configured via the `failAt` option. This avoids the
 * `mockImplementationOnce`-queue subtlety where a queued second-openSync
 * mock never fires when a prior step throws.
 */
function setupPrepProbe(opts: {
  failAt?:
    | { kind: "writeSync" }
    | { kind: "closeSync"; nth: number }
    | { kind: "openSync"; nth: number }
    | { kind: "unlinkSync"; nth: number }
}): PrepProbe {
  const probe: PrepProbe = {
    paths: [],
    fds: [],
    closedFds: [],
    unlinkedPaths: [],
  }
  let openCalls = 0
  let closeCalls = 0
  let unlinkCalls = 0

  openSyncMock.mockImplementation(
    (
      path: Parameters<typeof realFs.openSync>[0],
      flags?: Parameters<typeof realFs.openSync>[1],
      mode?: Parameters<typeof realFs.openSync>[2]
    ) => {
      const n = ++openCalls
      if (opts.failAt?.kind === "openSync" && opts.failAt.nth === n) {
        throw new Error(`simulated openSync failure at call ${n}`)
      }
      const fd = realFs.openSync(path, flags as never, mode as never)
      if (typeof path === "string" && path.includes("lore-prompt-")) {
        probe.paths.push(path)
        probe.fds.push(fd)
      }
      return fd
    }
  )

  writeSyncMock.mockImplementation(
    (
      fd: Parameters<typeof realFs.writeSync>[0],
      buf: Parameters<typeof realFs.writeSync>[1],
      ...rest: unknown[]
    ) => {
      if (opts.failAt?.kind === "writeSync") {
        throw new Error("simulated writeSync failure")
      }
      // The real signature is overloaded; pass through the variadic tail.
      return (realFs.writeSync as unknown as (...args: unknown[]) => number)(
        fd,
        buf,
        ...rest
      )
    }
  )

  closeSyncMock.mockImplementation((fd: number) => {
    const n = ++closeCalls
    probe.closedFds.push(fd)
    if (opts.failAt?.kind === "closeSync" && opts.failAt.nth === n) {
      throw new Error(`simulated closeSync failure at call ${n}`)
    }
    realFs.closeSync(fd)
  })

  unlinkSyncMock.mockImplementation((path: Parameters<typeof realFs.unlinkSync>[0]) => {
    const n = ++unlinkCalls
    if (typeof path === "string") probe.unlinkedPaths.push(path)
    if (opts.failAt?.kind === "unlinkSync" && opts.failAt.nth === n) {
      throw new Error(`simulated unlinkSync failure at call ${n}`)
    }
    realFs.unlinkSync(path)
  })

  return probe
}

describe("spawnBackgroundSave prompt-file cleanup on prep failure (#195)", () => {
  beforeEach(() => {
    // Default spawn returns a fake live child so the post-prep success path
    // can complete without forking a real process. Uses our own pid so the
    // lock liveness check (when the test passes a lockKey) sees the child
    // as alive.
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeLiveChild())
  })

  afterEach(() => {
    // Reset the chained `mockImplementation` calls between tests so leftover
    // step counters from a prior `setupPrepProbe` don't leak into the
    // safeEnv tests' default-passthrough expectations.
    openSyncMock.mockReset()
    writeSyncMock.mockReset()
    closeSyncMock.mockReset()
    unlinkSyncMock.mockReset()
    // Re-bind to passthrough so the safeEnv tests (which run with these
    // mocks at default) keep working — `mockReset` clears even the
    // default implementation.
    openSyncMock.mockImplementation(realFs.openSync)
    writeSyncMock.mockImplementation(realFs.writeSync)
    closeSyncMock.mockImplementation(realFs.closeSync)
    unlinkSyncMock.mockImplementation(realFs.unlinkSync)
  })

  it("unlinks the temp file when writeSync throws after the initial open", () => {
    const probe = setupPrepProbe({ failAt: { kind: "writeSync" } })

    const result = spawnBackgroundSave("/tmp", "sensitive transcript content")

    expect(result.kind).toBe("tempfile-failed")
    expect(probe.paths.length).toBe(1)
    // Cleanup must remove the file the wx+ open created.
    expect(realFs.existsSync(probe.paths[0]!)).toBe(false)
  })

  it("closes the open fd when writeSync throws", () => {
    const probe = setupPrepProbe({ failAt: { kind: "writeSync" } })

    const result = spawnBackgroundSave("/tmp", "sensitive content")

    expect(result.kind).toBe("tempfile-failed")
    expect(probe.fds.length).toBe(1)
    // The fd from the wx+ open must be closed by the cleanup path.
    expect(probe.closedFds).toContain(probe.fds[0]!)
  })

  it("unlinks the temp file when the second openSync (read mode) throws", () => {
    const probe = setupPrepProbe({ failAt: { kind: "openSync", nth: 2 } })

    const result = spawnBackgroundSave("/tmp", "sensitive content")

    expect(result.kind).toBe("tempfile-failed")
    // Only the first open succeeded, so we recorded one path.
    expect(probe.paths.length).toBe(1)
    // Cleanup must still find the file via `needsUnlink` and remove it
    // even though no fd is currently open at this failure point.
    expect(realFs.existsSync(probe.paths[0]!)).toBe(false)
    expect(probe.unlinkedPaths).toContain(probe.paths[0]!)
  })

  it("closes the read fd and retries unlink when the production unlinkSync throws", () => {
    // Force the mock to throw on every unlinkSync call so both the
    // production unlink (the throwing one we're simulating) AND the
    // cleanup-path retry hit the failure branch. This pins that the
    // function does not propagate even when the cleanup retry fails.
    const probe: PrepProbe = {
      paths: [],
      fds: [],
      closedFds: [],
      unlinkedPaths: [],
    }
    let openCalls = 0
    openSyncMock.mockImplementation(
      (
        path: Parameters<typeof realFs.openSync>[0],
        flags?: Parameters<typeof realFs.openSync>[1],
        mode?: Parameters<typeof realFs.openSync>[2]
      ) => {
        openCalls++
        const fd = realFs.openSync(path, flags as never, mode as never)
        if (typeof path === "string" && path.includes("lore-prompt-")) {
          probe.paths.push(path)
          probe.fds.push(fd)
        }
        return fd
      }
    )
    closeSyncMock.mockImplementation((fd: number) => {
      probe.closedFds.push(fd)
      realFs.closeSync(fd)
    })
    unlinkSyncMock.mockImplementation((path: Parameters<typeof realFs.unlinkSync>[0]) => {
      if (typeof path === "string") probe.unlinkedPaths.push(path)
      throw new Error("simulated unlinkSync failure")
    })

    const result = spawnBackgroundSave("/tmp", "sensitive content")
    try {
      expect(result.kind).toBe("tempfile-failed")
      expect(openCalls).toBe(2)
      expect(probe.fds.length).toBe(2)
      // The read fd (second open) must be closed by cleanup.
      expect(probe.closedFds).toContain(probe.fds[1]!)
      // Production unlink (1st call) threw; cleanup retried (2nd call), which
      // also threw and was swallowed. spawnBackgroundSave returned cleanly.
      expect(probe.unlinkedPaths.filter((p) => p.includes("lore-prompt-")).length).toBe(2)
    } finally {
      // The mock threw on every unlink, so the file was never actually
      // removed. Clean up directly even if an assertion above failed —
      // otherwise this test leaves forensic state under /tmp between runs.
      if (probe.paths[0] && realFs.existsSync(probe.paths[0])) {
        realFs.unlinkSync(probe.paths[0])
      }
    }
  })

  it("cleans up when the production closeSync (between writeSync and reopen) throws", () => {
    // The trickiest cleanup case: production closeSync at line 207 throws,
    // so `openFd = null` (line 208) never runs — `openFd` still references
    // the wx+ fd. Cleanup re-calls closeSync on it, which Node already
    // released and now yields EBADF. The inner try/catch must swallow.
    const probe = setupPrepProbe({ failAt: { kind: "closeSync", nth: 1 } })

    const result = spawnBackgroundSave("/tmp", "sensitive content")

    expect(result.kind).toBe("tempfile-failed")
    expect(probe.fds.length).toBe(1)
    // Cleanup attempted to close the wx+ fd — that's the second closeSync
    // observation (production close was the first).
    expect(probe.closedFds).toContain(probe.fds[0]!)
    // File must still be unlinked even though the close path threw.
    expect(realFs.existsSync(probe.paths[0]!)).toBe(false)
  })

  it("does no cleanup when the initial openSync(wx+) throws", () => {
    // No file was created and no fd was opened, so neither cleanup branch
    // should run. Pins the contract that `needsUnlink`/`openFd` start
    // false/null and a never-reached prep block doesn't try to delete a
    // path that doesn't exist on disk.
    const probe = setupPrepProbe({ failAt: { kind: "openSync", nth: 1 } })

    const result = spawnBackgroundSave("/tmp", "content")

    expect(result.kind).toBe("tempfile-failed")
    expect(probe.fds.length).toBe(0)
    expect(probe.closedFds.length).toBe(0)
    expect(probe.unlinkedPaths.length).toBe(0)
  })

  it("swallows a closeSync failure inside the cleanup path without throwing", () => {
    // writeSync throws → cleanup path tries closeSync(openFd). Force the
    // *cleanup* closeSync to throw — the function must not propagate, and
    // the postconditions (kind=tempfile-failed, file removed) must still
    // hold even though the cleanup close was useless.
    const probe = setupPrepProbe({ failAt: { kind: "writeSync" } })
    let trackedFd: number | null = null
    closeSyncMock.mockImplementationOnce((fd: number) => {
      // Genuinely close the fd so we don't leak it to the test runner;
      // then throw to exercise the cleanup-close swallow path.
      trackedFd = fd
      try {
        realFs.closeSync(fd)
      } catch {
        // already closed by something upstream — fine.
      }
      throw new Error("simulated EBADF on cleanup close")
    })

    let result: ReturnType<typeof spawnBackgroundSave> | undefined
    expect(() => {
      result = spawnBackgroundSave("/tmp", "content")
    }).not.toThrow()

    expect(result?.kind).toBe("tempfile-failed")
    expect(probe.paths.length).toBe(1)
    // Cleanup close threw, but cleanup unlink ran and removed the file.
    expect(realFs.existsSync(probe.paths[0]!)).toBe(false)
    expect(trackedFd).toBe(probe.fds[0])
  })

  it("does not leak the prompt file on a successful spawn (regression guard)", () => {
    const probe = setupPrepProbe({})

    const result = spawnBackgroundSave("/tmp", "ordinary prompt")

    expect(result.kind).toBe("spawned")
    // Prep opens the same temp path twice (wx+ then r); both observations
    // must point at the same file.
    expect(probe.paths.length).toBe(2)
    expect(probe.paths[0]).toBe(probe.paths[1])
    // Production code unlinks the file after the read-fd open. Verify the
    // file is gone after the call returns successfully.
    expect(realFs.existsSync(probe.paths[0]!)).toBe(false)
  })
})
