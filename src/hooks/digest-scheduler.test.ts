import { describe, expect, it, vi } from "vitest"

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
  fireDigestIfStale,
  scheduleAutoDigestSpawn,
  type DigestSchedulerDeps,
  type DigestSchedulerState,
} from "./digest-scheduler.js"
import type { LoreServices } from "../services.js"
import type { LoreConfig, Project } from "../types.js"

const CONFIG: LoreConfig = {
  vault: { pageId: "v" },
  projects: [
    { name: "Mail", path: "." },
    { name: "Mail Backend", path: "services/mail" },
  ],
}

const CONFIG_ROOT = "/repo"
const SUB_PROJECT_CWD = "/repo/services/mail/graphql"

function makeProject(name: string): Project {
  return {
    id: `proj-${name}`,
    name,
    path: "services/mail",
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
    log: ReturnType<typeof vi.fn>
  }
} {
  const calls = {
    init: vi.fn(async () => makeServices(makeProject("Mail Backend"))),
    gather: vi.fn(async () => ({
      raw: "# Digest Data — Mail Backend\n",
      lastDigestDate: null,
      recentMemoryCount: 5,
    })),
    age: vi.fn(async () => Infinity),
    touch: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    spawn: vi.fn(() => ({ kind: "spawned" as const })),
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
      now: () => new Date("2026-04-24T12:00:00.000Z"),
      log: calls.log,
      ...overrides,
    },
  }
}

function state(autoDigest = true): DigestSchedulerState {
  return { config: CONFIG, configRoot: CONFIG_ROOT, autoDigest }
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
    // cwd at the repo root matches only the "Mail" catch-all entry.
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
    expect(calls.touch).toHaveBeenCalledWith(CONFIG_ROOT, "Mail Backend")
    expect(calls.spawn).toHaveBeenCalledTimes(1)
    expect(calls.clear).not.toHaveBeenCalled()
    // Prompt should be passed with the today date + no-prior-digest wording.
    const [spawnCwd, prompt] = calls.spawn.mock.calls[0]!
    expect(spawnCwd).toBe(SUB_PROJECT_CWD)
    expect(prompt).toContain("Digest — 2026-04-24 — Mail Backend")
    expect(prompt).toContain("first one")
  })

  it("rolls back the marker when the binary is missing so the next session retries", async () => {
    const { deps, calls } = baseDeps({
      spawn: vi.fn(() => ({ kind: "binary-missing" as const })),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("spawn-failed")
    expect(calls.touch).toHaveBeenCalledTimes(1)
    expect(calls.clear).toHaveBeenCalledTimes(1)
    expect(calls.clear).toHaveBeenCalledWith(CONFIG_ROOT, "Mail Backend")
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
  })

  it("rolls back the marker when temp-file preparation fails", async () => {
    const { deps, calls } = baseDeps({
      spawn: vi.fn(() => ({ kind: "tempfile-failed" as const })),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("spawn-failed")
    expect(calls.clear).toHaveBeenCalledTimes(1)
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
        raw: "# Digest Data — Mail Backend\n",
        lastDigestDate: null,
        recentMemoryCount: 0,
      })),
    })
    const outcome = await fireDigestIfStale(SUB_PROJECT_CWD, state(), deps)
    expect(outcome).toBe("no-activity")
    expect(calls.touch).toHaveBeenCalledTimes(1)
    expect(calls.spawn).not.toHaveBeenCalled()
    expect(calls.clear).not.toHaveBeenCalled()
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
    expect(lockKey).toBe("digest-Mail_Backend")
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
})
