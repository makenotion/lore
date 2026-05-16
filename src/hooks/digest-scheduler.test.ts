import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Hoisted mock for `node:child_process.spawn` so the
// `scheduleAutoDigestSpawn` tests can capture the args + options the
// helper passes to the platform spawn primitive without actually forking
// a node process. Hoisting via `vi.hoisted` is required because ES
// modules evaluate imports before top-level statements; without it, the
// `digest-scheduler.js` import below would resolve `node:child_process`
// to its real export before the mock is registered.
const { spawnMock } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
}))

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, spawn: spawnMock }
})

import {
  buildAutoDigestHelperEnv,
  fireDigestIfStale,
  scheduleAutoDigestSpawn,
  type DigestSchedulerDeps,
  type DigestSchedulerState,
} from "./digest-scheduler.js"
import {
  clearBackgroundFailure,
  listBackgroundFailures,
  recordBackgroundFailure,
} from "./background-failure-marker.js"
import { withClearedRuntimeEnv } from "./test-utils.js"
import type { LoreServices } from "../services.js"
import type { LoreConfig, Project } from "../types.js"

const CONFIG: LoreConfig = {
  vault: { pageId: "v" },
  projects: [
    { name: "Widget", path: "." },
    { name: "Widget Backend", path: "services/widget" },
  ],
}

const CONFIG_ROOT = "/repo"
const SUB_PROJECT_CWD = "/repo/services/widget/graphql"

function makeProject(name: string): Project {
  return {
    id: `proj-${name}`,
    name,
    path: "services/widget",
    type: "project",
    status: "active",
    description: "",
  }
}

function makeServices(project: Project | null): LoreServices {
  return {
    context: {
      project,
      cwd: SUB_PROJECT_CWD,
      vault: { pageId: "v" },
      isCatchAllFallback: false,
    },
  } as unknown as LoreServices
}

function baseDeps(overrides: Partial<DigestSchedulerDeps> = {}): {
  deps: DigestSchedulerDeps
  calls: {
    init: ReturnType<typeof vi.fn>
    gather: ReturnType<typeof vi.fn>
    age: ReturnType<typeof vi.fn>
    touch: ReturnType<typeof vi.fn>
    clear: ReturnType<typeof vi.fn>
    spawn: ReturnType<typeof vi.fn>
    recordFailure: ReturnType<typeof vi.fn>
    clearFailure: ReturnType<typeof vi.fn>
    log: ReturnType<typeof vi.fn>
  }
} {
  const calls = {
    init: vi.fn(async () => makeServices(makeProject("Widget Backend"))),
    gather: vi.fn(async () => ({
      raw: "# Digest Data — Widget Backend\n",
      lastDigestDate: null,
      recentMemoryCount: 5,
      renderedMemoryCount: 5,
      renderedTaskCount: 0,
    })),
    age: vi.fn(async () => Infinity),
    touch: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    spawn: vi.fn(() => ({ kind: "spawned" as const })),
    recordFailure: vi.fn(),
    clearFailure: vi.fn(async () => {}),
    log: vi.fn(),
  }
  return {
    calls,
    deps: {
      initServices: calls.init,
      gatherDigest: calls.gather,
      markerAge: calls.age,
      touchMarker: calls.touch,
      clearMarker: calls.clear,
      spawn: calls.spawn,
      recordFailure: calls.recordFailure,
      clearFailure: calls.clearFailure,
      now: () => new Date("2026-04-24T12:00:00.000Z"),
      log: calls.log,
      ...overrides,
    },
  }
}

function state(autoDigest = true): DigestSchedulerState {
  return { config: CONFIG, configRoot: CONFIG_ROOT, autoDigest }
}

async function withTempFailureState<T>(fn: () => Promise<T>): Promise<T> {
  const originalStateDir = process.env["LORE_HOOK_STATE_DIR"]
  const stateDir = mkdtempSync(join(tmpdir(), "lore-digest-scheduler-"))
  process.env["LORE_HOOK_STATE_DIR"] = stateDir
  try {
    return await fn()
  } finally {
    rmSync(stateDir, { recursive: true, force: true })
    if (originalStateDir) {
      process.env["LORE_HOOK_STATE_DIR"] = originalStateDir
    } else {
      delete process.env["LORE_HOOK_STATE_DIR"]
    }
  }
}

describe("fireDigestIfStale", () => {
  it("returns 'disabled' when autoDigest is off and never touches any dep", async () => {
    const { deps, calls } = baseDeps()
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(false), deps)
    expect(outcome).toBe("disabled")
    expect(calls.age).not.toHaveBeenCalled()
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(calls.touch).not.toHaveBeenCalled()
  })

  it("returns 'no-project' when cwd resolves only to a catch-all", async () => {
    const { deps, calls } = baseDeps()
    // cwd at the repo root matches only the "Widget" catch-all entry.
    const outcome = await fireDigestIfStale(CONFIG_ROOT, state(), deps)
    expect(outcome).toBe("no-project")
    expect(calls.init).not.toHaveBeenCalled()
  })

  it("returns 'marker-fresh' and skips when the marker is younger than the staleness window", async () => {
    const { deps, calls } = baseDeps({
      markerAge: vi.fn(async () => 2),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("marker-fresh")
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(calls.touch).not.toHaveBeenCalled()
  })

  it("fires the synthesizer and optimistically touches the marker when stale + activity present", async () => {
    const { deps, calls } = baseDeps()
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("fired")
    expect(calls.touch).toHaveBeenCalledTimes(1)
    expect(calls.touch).toHaveBeenCalledWith(CONFIG_ROOT, "Widget Backend")
    expect(calls.spawn).toHaveBeenCalledTimes(1)
    expect(calls.clear).not.toHaveBeenCalled()
    // Prompt should be passed with the today date + no-prior-digest wording.
    const [spawnCwd, prompt] = calls.spawn.mock.calls[0]!
    expect(spawnCwd).toBe(SUB_PROJECT_CWD)
    expect(prompt).toContain("Digest — 2026-04-24 — Widget Backend")
    expect(prompt).toContain("first one")
    const recovered = { before: new Date("2026-04-24T12:00:00.000Z") }
    expect(calls.clearFailure).toHaveBeenCalledWith(
      CONFIG_ROOT,
      "digest-scheduler",
      {
        projectName: "Widget Backend",
      },
      recovered
    )
    expect(calls.clearFailure).toHaveBeenCalledWith(
      CONFIG_ROOT,
      "digest-synthesizer",
      {
        projectName: "Widget Backend",
      },
      recovered
    )
    expect(calls.clearFailure).not.toHaveBeenCalledWith(
      CONFIG_ROOT,
      "auto-digest-helper-spawn",
      expect.anything(),
      expect.anything()
    )
  })

  it("rolls back the marker when the binary is missing so the next session retries", async () => {
    const { deps, calls } = baseDeps({
      spawn: vi.fn(() => ({ kind: "binary-missing" as const })),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("spawn-failed")
    expect(calls.touch).toHaveBeenCalledTimes(1)
    expect(calls.clear).toHaveBeenCalledTimes(1)
    expect(calls.clear).toHaveBeenCalledWith(CONFIG_ROOT, "Widget Backend")
    expect(calls.recordFailure).toHaveBeenCalledWith(
      CONFIG_ROOT,
      expect.objectContaining({
        kind: "digest-synthesizer",
        projectName: "Widget Backend",
        code: "binary-missing",
      })
    )
    expect(calls.recordFailure.mock.calls[0]![1].logPath).toBeUndefined()
  })

  it("rolls back the marker when spawn itself throws", async () => {
    const { deps, calls } = baseDeps({
      spawn: vi.fn(() => ({
        kind: "spawn-error" as const,
        error: new Error("ENOMEM"),
      })),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("spawn-failed")
    expect(calls.clear).toHaveBeenCalledTimes(1)
    expect(calls.recordFailure.mock.calls[0]![1].logPath).toContain(
      "digest-Widget_Backend"
    )
  })

  it("rolls back the marker when temp-file preparation fails", async () => {
    const { deps, calls } = baseDeps({
      spawn: vi.fn(() => ({ kind: "tempfile-failed" as const })),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("spawn-failed")
    expect(calls.clear).toHaveBeenCalledTimes(1)
    expect(calls.recordFailure.mock.calls[0]![1].logPath).toBeUndefined()
  })

  it("keeps the marker fresh and reports skipped-peer-active when a peer holds the lock", async () => {
    // The narrow PF2-03 race: between our optimistic touch and our spawn
    // entering tryAcquireSessionLock, a sibling session-end touched, spawned,
    // and acquired the digest lock first. Our spawn rejects with `lock-held`
    // — but the peer is still producing the digest. Clearing the marker
    // here would cost us an extra `claude -p` on the next session-end.
    const { deps, calls } = baseDeps({
      spawn: vi.fn(() => ({ kind: "lock-held" as const })),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("skipped-peer-active")
    expect(calls.touch).toHaveBeenCalledTimes(1)
    // Critical invariant: the optimistic touch is NOT rolled back. The peer's
    // digest will land and the marker should reflect that.
    expect(calls.clear).not.toHaveBeenCalled()
  })

  it("keeps the marker fresh and reports skipped-peer-active when the global cap is hit", async () => {
    const { deps, calls } = baseDeps({
      spawn: vi.fn(() => ({ kind: "cap-hit" as const })),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("skipped-peer-active")
    expect(calls.clear).not.toHaveBeenCalled()
  })

  it("keeps the marker fresh and reports skipped-peer-active when we lose the post-spawn O_EXCL race", async () => {
    const { deps, calls } = baseDeps({
      spawn: vi.fn(() => ({ kind: "race-lost" as const })),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("skipped-peer-active")
    expect(calls.clear).not.toHaveBeenCalled()
  })

  it("touches the marker but does NOT spawn when the window has zero activity", async () => {
    const { deps, calls } = baseDeps({
      gatherDigest: vi.fn(async () => ({
        raw: "# Digest Data — Widget Backend\n",
        lastDigestDate: null,
        recentMemoryCount: 0,
        renderedMemoryCount: 0,
        renderedTaskCount: 0,
      })),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("no-activity")
    expect(calls.touch).toHaveBeenCalledTimes(1)
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(calls.clear).not.toHaveBeenCalled()
    expect(calls.clearFailure).toHaveBeenCalledWith(
      CONFIG_ROOT,
      "digest-scheduler",
      {
        projectName: "Widget Backend",
      },
      { before: new Date("2026-04-24T12:00:00.000Z") }
    )
  })

  it("keeps a digest-scheduler failure recorded during a successful digest attempt", async () => {
    await withTempFailureState(async () => {
      const { deps } = baseDeps({
        touchMarker: vi.fn(async () => {
          recordBackgroundFailure(
            CONFIG_ROOT,
            {
              kind: "digest-scheduler",
              projectName: "Widget Backend",
              code: "gather-failed",
              message: "concurrent gather failed",
            },
            new Date("2026-04-24T12:00:00.001Z")
          )
        }),
        clearFailure: clearBackgroundFailure,
        now: () => new Date("2026-04-24T12:00:00.000Z"),
      })

      await expect(fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)).resolves.toBe(
        "fired"
      )

      const [marker] = await listBackgroundFailures(CONFIG_ROOT, {
        now: new Date("2026-04-24T12:00:01.000Z"),
      })
      expect(marker).toMatchObject({
        kind: "digest-scheduler",
        projectName: "Widget Backend",
        code: "gather-failed",
      })
    })
  })

  it("keeps a digest-synthesizer failure recorded during a successful spawn", async () => {
    await withTempFailureState(async () => {
      const { deps } = baseDeps({
        spawn: vi.fn(() => {
          recordBackgroundFailure(
            CONFIG_ROOT,
            {
              kind: "digest-synthesizer",
              projectName: "Widget Backend",
              code: "spawn-error",
              message: "concurrent spawn failed",
            },
            new Date("2026-04-24T12:00:00.001Z")
          )
          return { kind: "spawned" as const }
        }),
        clearFailure: clearBackgroundFailure,
        now: () => new Date("2026-04-24T12:00:00.000Z"),
      })

      await expect(fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)).resolves.toBe(
        "fired"
      )

      const [marker] = await listBackgroundFailures(CONFIG_ROOT, {
        now: new Date("2026-04-24T12:00:01.000Z"),
      })
      expect(marker).toMatchObject({
        kind: "digest-synthesizer",
        projectName: "Widget Backend",
        code: "spawn-error",
      })
    })
  })

  it("returns 'init-failed' and logs when services init throws", async () => {
    const { deps, calls } = baseDeps({
      initServices: vi.fn(async () => {
        throw new Error("notion down")
      }),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("init-failed")
    expect(calls.log).toHaveBeenCalledTimes(1)
    expect(calls.log.mock.calls[0]![0]).toContain("init failed — notion down")
    expect(calls.recordFailure).toHaveBeenCalledWith(
      CONFIG_ROOT,
      expect.objectContaining({
        kind: "digest-scheduler",
        projectName: "Widget Backend",
        code: "init-failed",
      })
    )
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(calls.touch).not.toHaveBeenCalled()
  })

  it("returns 'project-mismatch' when the config name doesn't match the resolved Notion project", async () => {
    const { deps, calls } = baseDeps({
      initServices: vi.fn(async () => makeServices(makeProject("Different Name"))),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("project-mismatch")
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(calls.touch).not.toHaveBeenCalled()
    expect(calls.gather).not.toHaveBeenCalled()
  })

  it("returns 'gather-failed' and logs when digest data gathering throws", async () => {
    const { deps, calls } = baseDeps({
      gatherDigest: vi.fn(async () => {
        throw new Error("rate limit")
      }),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("gather-failed")
    expect(calls.log.mock.calls[0]![0]).toContain("gather failed — rate limit")
    expect(calls.recordFailure).toHaveBeenCalledWith(
      CONFIG_ROOT,
      expect.objectContaining({
        kind: "digest-scheduler",
        projectName: "Widget Backend",
        code: "gather-failed",
      })
    )
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(calls.touch).not.toHaveBeenCalled()
  })

  it("uses the narrow digest allowlist + digest log label so prompt violations become tool-call errors", async () => {
    const { deps, calls } = baseDeps()
    await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    const args = calls.spawn.mock.calls[0]!
    const options = args[3] as { logLabel?: string; allowedTools?: string }
    expect(options.logLabel).toBe("digest")
    // After the 0.6.0 alias purge the digest allowlist contains only
    // the polymorphic `lore-memory` — the synthesizer prompt teaches
    // `lore-memory action='save'` and the legacy alias is gone.
    expect(options.allowedTools).toBe("mcp__lore__lore-memory")
  })

  it("passes a digest-prefixed lock key so global cap respects per-project debounce without colliding with real session ids", async () => {
    const { deps, calls } = baseDeps()
    await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    const lockKey = calls.spawn.mock.calls[0]![2]
    expect(lockKey).toBe("digest-Widget_Backend")
  })
})

describe("scheduleAutoDigestSpawn", () => {
  // The Stop hot-path contract is load-bearing: the parent must never
  // gather digest data or initialize Notion clients inline. That contract
  // rests entirely on the spawn options passed to `child_process.spawn`
  // — `detached: true`, `stdio: "ignore"`, plus the post-spawn `unref()`
  // call. A regression that flips any of those would let stderr from the
  // digest child leak into Stop's response (Claude Code interprets that
  // as a hook error message) or pin the parent's stdout to the child's
  // lifetime. None of those would surface in a unit test that just
  // mocks the function. Pin the spawn-options shape directly here.

  function fakeChild(): { unref: ReturnType<typeof vi.fn> } {
    return { unref: vi.fn() }
  }

  it("forks node with the auto-digest action and the supplied cwd", () => {
    spawnMock.mockReset()
    const child = fakeChild()
    spawnMock.mockReturnValue(child)

    scheduleAutoDigestSpawn("/some/project")

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [bin, args, options] = spawnMock.mock.calls[0]! as [
      string,
      string[],
      { cwd: string; detached: boolean; stdio: string },
    ]
    expect(bin).toBe(process.execPath)
    expect(args[args.length - 1]).toBe("auto-digest")
    expect(options.cwd).toBe("/some/project")
  })

  it("spawns detached with stdio:ignore so the child never blocks the Stop hook", () => {
    // Three properties make the digest helper safe to launch from the
    // hot path:
    //   - `detached: true` lets Node release the child to the OS so the
    //     parent's event loop can exit while the child keeps running.
    //   - `stdio: "ignore"` keeps the child's stderr out of Stop's
    //     stdout response (Claude Code parses that response as JSON
    //     and treats stderr leakage as a hook-error signal).
    //   - The returned child must be `unref()`'d so a long-lived child
    //     doesn't pin the parent process alive past Stop's natural exit.
    spawnMock.mockReset()
    const child = fakeChild()
    spawnMock.mockReturnValue(child)

    scheduleAutoDigestSpawn("/proj")

    const options = spawnMock.mock.calls[0]![2] as {
      detached: boolean
      stdio: unknown
    }
    expect(options.detached).toBe(true)
    expect(options.stdio).toBe("ignore")
    expect(child.unref).toHaveBeenCalledTimes(1)
  })

  it("targets the sibling helpers.js file so the bundled and source layouts both resolve", () => {
    // The spawn target is built via `new URL("./helpers.js", import.meta.url)`
    // so the script path always resolves relative to the digest-scheduler
    // module — `dist/hooks/digest-scheduler.js` → `dist/hooks/helpers.js`
    // in production, `src/hooks/digest-scheduler.ts` → `src/hooks/helpers.js`
    // (post-build) in tests. Either way the path ends in `/hooks/helpers.js`.
    spawnMock.mockReset()
    spawnMock.mockReturnValue(fakeChild())

    scheduleAutoDigestSpawn("/proj")

    const args = spawnMock.mock.calls[0]![1] as string[]
    const helperPath = args[0]
    expect(typeof helperPath).toBe("string")
    expect(helperPath!.endsWith("/hooks/helpers.js")).toBe(true)
  })

  it("swallows spawn failures and writes a [lore] stderr line so the Stop hook stays fail-open", () => {
    // The Stop hook contract requires `{}\n` to be emitted regardless of
    // what auto-digest scheduling does. A throw out of `child_process.spawn`
    // (no fork available, EAGAIN, etc.) must not propagate into the Stop
    // path; the helper must trap it and log instead.
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => {
      throw new Error("EAGAIN")
    })
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(String(chunk))
        return true
      })

    expect(() => scheduleAutoDigestSpawn("/proj")).not.toThrow()
    expect(stderrChunks.join("")).toContain("[lore] auto-digest scheduler: spawn failed")
    expect(stderrChunks.join("")).toContain("EAGAIN")

    stderrSpy.mockRestore()
  })

  it("records a helper-spawn failure marker when the detached fork throws", () => {
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => {
      throw new Error("EAGAIN")
    })
    const recordFailure = vi.fn()
    const clearFailure = vi.fn(async () => {})
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    scheduleAutoDigestSpawn("/proj", {
      configRoot: CONFIG_ROOT,
      projectName: "Widget Backend",
      sessionId: "sess-digest",
      recordFailure,
      clearFailure,
    })

    expect(recordFailure).toHaveBeenCalledWith(
      CONFIG_ROOT,
      expect.objectContaining({
        kind: "auto-digest-helper-spawn",
        projectName: "Widget Backend",
        sessionId: "sess-digest",
        code: "spawn-error",
      })
    )
    expect(clearFailure).not.toHaveBeenCalled()
    stderrSpy.mockRestore()
  })

  it("clears a stale helper-spawn marker once the detached fork succeeds", () => {
    spawnMock.mockReset()
    spawnMock.mockReturnValue(fakeChild())
    const recordFailure = vi.fn()
    const clearFailure = vi.fn(async () => {})

    scheduleAutoDigestSpawn("/proj", {
      configRoot: CONFIG_ROOT,
      projectName: "Widget Backend",
      sessionId: "sess-digest",
      recordFailure,
      clearFailure,
    })

    expect(recordFailure).not.toHaveBeenCalled()
    expect(clearFailure).toHaveBeenCalledWith(
      CONFIG_ROOT,
      "auto-digest-helper-spawn",
      {
        projectName: "Widget Backend",
      },
      { before: expect.any(Date) }
    )
  })

  it("keeps a helper-spawn failure recorded during a successful detached fork", async () => {
    await withTempFailureState(async () => {
      spawnMock.mockReset()
      spawnMock.mockImplementation(() => {
        recordBackgroundFailure(
          CONFIG_ROOT,
          {
            kind: "auto-digest-helper-spawn",
            projectName: "Widget Backend",
            sessionId: "sess-concurrent-helper",
            code: "spawn-error",
            message: "concurrent helper fork failed",
          },
          new Date(Date.now() + 1_000)
        )
        return fakeChild()
      })

      scheduleAutoDigestSpawn("/proj", {
        configRoot: CONFIG_ROOT,
        projectName: "Widget Backend",
        sessionId: "sess-digest",
        clearFailure: clearBackgroundFailure,
      })

      await new Promise((resolve) => setTimeout(resolve, 20))
      const [marker] = await listBackgroundFailures(CONFIG_ROOT)
      expect(marker).toMatchObject({
        kind: "auto-digest-helper-spawn",
        projectName: "Widget Backend",
        sessionId: "sess-concurrent-helper",
        code: "spawn-error",
      })
    })
  })

  describe("authSource env partition (#475)", () => {
    // The Stop → auto-digest-helper hop was the leak the second
    // PR review caught: pre-#475 fix this fork inherited
    // `process.env` via Node's default, so an ntn-resolved Stop
    // path with `NOTION_API_TOKEN` still landed the bearer in the
    // detached child's env BEFORE the inner synthesizer spawn's
    // partition got a chance to apply. Pin the partition shape
    // here so a future refactor that drops the explicit `env:`
    // option (or forgets to thread `authSource` through) fails
    // loudly rather than silently re-introducing the leak.
    const envGuard = withClearedRuntimeEnv([
      "NOTION_API_TOKEN",
      "NOTION_WORKSPACE_ID",
      "LORE_NOTION_BASE_URL",
    ] as const)

    beforeEach(() => {
      envGuard.install()
    })

    afterEach(() => {
      envGuard.restore()
    })

    it("under authSource=ntn-auth-json, drops auth tokens from the helper child's inherited env", () => {
      process.env["NOTION_API_TOKEN"] = "secret_canonical"
      spawnMock.mockReset()
      spawnMock.mockReturnValue(fakeChild())

      scheduleAutoDigestSpawn("/proj", { authSource: "ntn-auth-json" })

      const options = spawnMock.mock.calls[0]![2] as {
        env: NodeJS.ProcessEnv
      }
      expect(options.env).toBeDefined()
      expect("NOTION_API_TOKEN" in options.env).toBe(false)
    })

    it("under authSource=ntn-auth-json, preserves every other operator-controlled runtime knob", () => {
      // The helper child needs every other env var the foreground
      // had — `LORE_HOOK_STATE_DIR` for the digest marker,
      // `LORE_DEBUG` for the operator log line, `LORE_AUTO_DIGEST`
      // for the kill switch, `LORE_AGENT_NAME` for `deriveAgentName`
      // inside the synthesizer, etc. The partition is surgical:
      // it removes ONLY the auth-token subset.
      process.env["NOTION_API_TOKEN"] = "secret_canonical"
      process.env["NOTION_WORKSPACE_ID"] = "ws_team_alpha"
      process.env["LORE_NOTION_BASE_URL"] = "https://api-dev.notion.com"
      spawnMock.mockReset()
      spawnMock.mockReturnValue(fakeChild())

      try {
        scheduleAutoDigestSpawn("/proj", { authSource: "ntn-auth-json" })

        const options = spawnMock.mock.calls[0]![2] as {
          env: NodeJS.ProcessEnv
        }
        expect("NOTION_API_TOKEN" in options.env).toBe(false)
        expect(options.env["NOTION_WORKSPACE_ID"]).toBe("ws_team_alpha")
        expect(options.env["LORE_NOTION_BASE_URL"]).toBe("https://api-dev.notion.com")
        // PATH and HOME inherited via process.env spread.
        expect(options.env["PATH"]).toBe(process.env["PATH"])
      } finally {
        delete process.env["NOTION_WORKSPACE_ID"]
        delete process.env["LORE_NOTION_BASE_URL"]
      }
    })

    it("under authSource=env-notion-api-token, forwards every key (legacy inheritance)", () => {
      // The canonical-env operator's contract: their `resolveAuth`
      // priority chain reaches the bearer only through env, so the
      // helper must see it.
      process.env["NOTION_API_TOKEN"] = "secret_canonical"
      spawnMock.mockReset()
      spawnMock.mockReturnValue(fakeChild())

      scheduleAutoDigestSpawn("/proj", { authSource: "env-notion-api-token" })

      const options = spawnMock.mock.calls[0]![2] as {
        env: NodeJS.ProcessEnv
      }
      // Non-ntn sources receive a fresh shallow copy of
      // `process.env` (NOT the live reference — see the
      // `buildAutoDigestHelperEnv` describe block below for the
      // identity-inequality + mutation-isolation pins). Token
      // contents are preserved byte-for-byte; only the object
      // reference differs.
      expect(options.env["NOTION_API_TOKEN"]).toBe("secret_canonical")
    })

    it("with authSource omitted, preserves pre-#475 inheritance behavior AND passes env explicitly", () => {
      // Two contracts pinned here: (1) test fixtures and ad-hoc
      // invocations preserve pre-#475 token forwarding; (2) the
      // `env` field is ALWAYS passed explicitly to `child_process.spawn`,
      // never falling back to Node's default-inherit shape that
      // masked the original blocking-review leak. A future refactor
      // that "optimizes" the omitted-authSource path by dropping the
      // `env:` option (relying on Node default) would silently re-
      // introduce the leak class — pin both halves here.
      process.env["NOTION_API_TOKEN"] = "secret_canonical"
      spawnMock.mockReset()
      spawnMock.mockReturnValue(fakeChild())

      scheduleAutoDigestSpawn("/proj")

      const options = spawnMock.mock.calls[0]![2] as {
        env: NodeJS.ProcessEnv
      }
      // Explicit-env-passed contract: `env` MUST be present in the
      // spawn options (not relying on Node default inherit).
      expect(options.env).toBeDefined()
      // Token preservation: pre-#475 behavior unchanged.
      expect(options.env["NOTION_API_TOKEN"]).toBe("secret_canonical")
    })

    describe("buildAutoDigestHelperEnv", () => {
      // The pure helper that builds the env. Tested directly so a
      // regression in just the env-shape logic surfaces independently
      // of the broader spawn wiring above.

      it("returns a fresh copy (NOT the live process.env reference) for non-ntn sources", () => {
        // Symmetry with the ntn-source branch (review iteration 3
        // Suggestion 3): both branches return a shallow copy so a
        // downstream caller-side mutation can't silently leak into
        // process.env. Pin the copy semantics here so a future
        // refactor that "optimizes" the non-ntn branch back to a
        // direct return fails the assertion rather than re-introducing
        // the footgun class.
        const env = buildAutoDigestHelperEnv("env-notion-api-token")
        expect(env).not.toBe(process.env)
      })

      it("returns a fresh copy for omitted authSource", () => {
        const env = buildAutoDigestHelperEnv(undefined)
        expect(env).not.toBe(process.env)
      })

      it("preserves every parent env var for non-ntn sources", () => {
        process.env["NOTION_API_TOKEN"] = "secret_canonical"
        try {
          const env = buildAutoDigestHelperEnv("env-notion-api-token")
          // Auth tokens stay forwarded under non-ntn sources — those
          // callers' `resolveAuth` priority chain reaches the bearer
          // only through env.
          expect(env["NOTION_API_TOKEN"]).toBe("secret_canonical")
        } finally {
          delete process.env["NOTION_API_TOKEN"]
        }
      })

      it("mutations on the returned env do NOT propagate to process.env", () => {
        // Symmetry contract with the ntn-source branch: a caller
        // adding a child-only var via `env.SOMETHING = "..."` must
        // not leak into the parent. The shallow copy is what makes
        // this safe.
        const env = buildAutoDigestHelperEnv(undefined)
        env["LORE_TEST_CHILD_ONLY_VAR"] = "child-only"
        try {
          expect(process.env["LORE_TEST_CHILD_ONLY_VAR"]).toBeUndefined()
        } finally {
          delete env["LORE_TEST_CHILD_ONLY_VAR"]
        }
      })

      it("returns a copy with auth tokens removed for ntn-auth-json", () => {
        process.env["NOTION_API_TOKEN"] = "secret_canonical"
        try {
          const env = buildAutoDigestHelperEnv("ntn-auth-json")
          expect(env).not.toBe(process.env)
          expect("NOTION_API_TOKEN" in env).toBe(false)
          // The original process.env is untouched.
          expect(process.env["NOTION_API_TOKEN"]).toBe("secret_canonical")
        } finally {
          delete process.env["NOTION_API_TOKEN"]
        }
      })
    })
  })
})
