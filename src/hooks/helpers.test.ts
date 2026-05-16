/**
 * Tests for the Stop hook's non-blocking save path, the auto-digest helper
 * action it schedules, and the SessionEnd compatibility shim.
 *
 * The Stop hook used to emit `{"decision": "block"}` and force an extra
 * agent turn; P2-05 replaced that with a detached background spawn that
 * never blocks the main agent. 0.6.0 also moved auto-digest scheduling
 * onto Stop (via a separate detached node child) and dropped active
 * SessionEnd registration. These tests pin that contract:
 *   - Stop stdout never contains `"decision": "block"`
 *   - A save spawn fires at the interval
 *   - The per-session lock prevents an overlapping second save spawn
 *   - Stop schedules the detached auto-digest helper on every accepted event
 *   - The SessionEnd shim is a strict no-op
 *   - The auto-digest helper threads config and env-var overrides into
 *     `fireDigestIfStale` correctly
 *
 * `helpers.ts` is now import-safe: its entry-point guard skips `main()`
 * when invoked from a test runner, so we can exercise `handleStop`,
 * `handleSessionEnd`, and `handleAutoDigest` directly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

// Isolate from sibling test files that also touch the lock dir. Each test
// file gets its own subtree under $TMPDIR via `LORE_HOOK_STATE_DIR`. The
// assignment is in `vi.hoisted` because ES modules evaluate imports before
// top-level statements; without hoisting, `./lock.js` would pin `STATE_DIR`
// to the default before this override ran. `getStateDir()` re-reads
// the env var on every call so function-side usage picks up the override.
vi.hoisted(() => {
  process.env["LORE_HOOK_STATE_DIR"] =
    `${process.env["TMPDIR"] ?? "/tmp"}/lore-helpers-state-${process.pid}-${Date.now()}`
})

// Hoisted mocks — `vi.spyOn` can't redefine native ESM exports, so the
// mocks must be set up via `vi.mock` + `vi.hoisted`.
//
// `execFileSyncMock` stands in for the configured background-binary probe:
// on CI runners `claude` isn't on PATH and the real probe
// would return null, short-circuiting `spawnBackgroundSave` before the
// spawn-path assertions fire. The mock always resolves to a fake path so
// the rest of the hook runs as if `claude` were installed.
//
// `fireDigestIfStaleMock` stands in for the digest scheduler so the
// auto-digest integration tests can assert wiring (was the call made? with
// what shape?) without firing real Notion or `claude -p` work.
//
// `scheduleAutoDigestSpawnMock` stands in for the detached node fork the
// Stop hook now schedules — tests assert it was called with the right cwd
// without actually forking a child process.
const {
  spawnMock,
  execFileSyncMock,
  fireDigestIfStaleMock,
  initServicesFromConfigMock,
  scheduleAutoDigestSpawnMock,
  buildBackgroundSavePromptMock,
} = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  execFileSyncMock: vi.fn(() => "/mock/bin/claude\n"),
  fireDigestIfStaleMock: vi.fn(async () => "no-project" as const),
  initServicesFromConfigMock: vi.fn(async () => {
    throw new Error("mock init disabled")
  }),
  scheduleAutoDigestSpawnMock: vi.fn<(cwd: string, opts?: unknown) => void>(),
  buildBackgroundSavePromptMock: vi.fn(),
}))

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>("node:child_process")
  return { ...actual, spawn: spawnMock, execFileSync: execFileSyncMock }
})

vi.mock("./digest-scheduler.js", async () => {
  const actual = await vi.importActual<typeof import("./digest-scheduler.js")>(
    "./digest-scheduler.js"
  )
  return {
    ...actual,
    fireDigestIfStale: fireDigestIfStaleMock,
    scheduleAutoDigestSpawn: scheduleAutoDigestSpawnMock,
  }
})

vi.mock("../services.js", async () => {
  const actual = await vi.importActual<typeof import("../services.js")>("../services.js")
  return {
    ...actual,
    initServicesFromConfig: initServicesFromConfigMock,
  }
})

// Mock the prompt builder so tests can inspect the resolved
// `extractLearnings` flag without having to crack open the temp prompt
// file the spawn pipeline writes. The actual builder is unit-tested in
// `prompts.test.ts`; here we only care that helpers.ts threads the
// kill-switch boolean through correctly. Default returns the canonical
// marker string so the rest of the autosave pipeline (spawn, lock
// acquisition) still has plausible bytes to write to the temp file.
vi.mock("./prompts.js", async () => {
  const actual = await vi.importActual<typeof import("./prompts.js")>("./prompts.js")
  return {
    ...actual,
    buildBackgroundSavePrompt: buildBackgroundSavePromptMock,
  }
})

import {
  DEFAULT_BACKGROUND_ARGS,
  DEFAULT_BACKGROUND_COMMAND,
  type HookConfig,
} from "./config.js"
import {
  getStateDir,
  lockPath,
  releaseSessionLock,
  tryAcquireSessionLock,
} from "./lock.js"
import {
  deriveAgentName,
  deriveAuthorName,
  handleAutoDigest,
  handleStop,
  handleSessionEnd,
  parseWakeupEventMetadata,
  parseUserQueryFromEvent,
  statePath,
  wakeup,
  wakeupStatePath,
} from "./helpers.js"
import { HOSTILE_SESSION_IDS } from "./path-injection-fixtures.js"
import { HOOK_STATE_DIR_MODE, HOOK_STATE_FILE_MODE } from "./marker-key.js"
import {
  listBackgroundFailures,
  recordBackgroundFailure,
} from "./background-failure-marker.js"
import type { LoreConfig } from "../types.js"

// Stand-in for a spawned `claude -p` process. Returning a live PID (this
// process) means subsequent lock-aliveness checks see it as "still running",
// which is exactly the condition we want when asserting overlap rejection.
// `kill` is stubbed because the race-loss code path SIGTERMs the child when
// a concurrent hook wins the lock.
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

function defaultConfig(overrides: Partial<HookConfig> = {}): HookConfig {
  return {
    saveInterval: 2,
    autoSave: true,
    wakeUp: true,
    autoDigest: true,
    learningExtraction: true,
    proposeAutosaveLearnings: false,
    backgroundAgent: {
      command: DEFAULT_BACKGROUND_COMMAND,
      args: [...DEFAULT_BACKGROUND_ARGS],
    },
    features: { learningExtraction: true },
    catchAllName: null,
    subProjects: [],
    ...overrides,
  }
}

/** Write a minimal Claude Code transcript with N user messages. */
function writeTranscript(path: string, userMessages: number): void {
  const lines: string[] = []
  for (let i = 0; i < userMessages; i++) {
    lines.push(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: [{ type: "text", text: `user ${i}` }] },
      })
    )
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: `assistant ${i}` }],
        },
      })
    )
  }
  writeFileSync(path, lines.join("\n"))
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

function modeBits(mode: number): number {
  return mode & 0o777
}

async function withUmask<T>(mask: number, fn: () => Promise<T>): Promise<T> {
  const previous = process.umask(mask)
  try {
    return await fn()
  } finally {
    process.umask(previous)
  }
}

function minimalExternalProfileFiles(
  name: string,
  version = "1.0.0"
): Record<string, string> {
  return {
    "profile.yaml": `name: ${name}\nversion: ${version}\ntaxonomy: taxonomy.yaml\nschema: schema.yaml\nprompts:\n  autosaveExtractionFilter: prompts/filter.txt\n`,
    "taxonomy.yaml": `tags:\n  - support\nentityKinds:\n  - account\nwritableFactPredicates:\n  - owns\n`,
    "schema.yaml": `databases:\n  projects:\n    properties: {}\n  topics:\n    properties: {}\n  memories:\n    properties: {}\n  entities:\n    properties: {}\n  facts:\n    properties: {}\n`,
    "prompts/filter.txt": "Installed profile autosave filter.",
  }
}

function failureContext(tmpDir: string): {
  config: LoreConfig
  configRoot: string
  cwd: string
} {
  return {
    configRoot: tmpDir,
    cwd: join(tmpDir, "apps/widget/service"),
    config: {
      vault: { pageId: "vault-fixture-id" },
      projects: [{ name: "Widget Backend", path: "apps/widget" }],
    },
  }
}

describe("handleStop", () => {
  let tmpDir: string
  let transcriptPath: string
  let stdoutWrites: string[]
  let stderrWrites: string[]
  // Loose type because `vi.spyOn` on stream.write has an overloaded signature
  // that doesn't match MockInstance's default constraint cleanly.
  let stdoutSpy: { mockRestore: () => void }
  let stderrSpy: { mockRestore: () => void }

  beforeEach(() => {
    // Fresh state dir per test — the lock module writes real files here.
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }

    tmpDir = mkdtempSync(join(tmpdir(), "lore-helpers-test-"))
    transcriptPath = join(tmpDir, "transcript.jsonl")

    stdoutWrites = []
    stderrWrites = []
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk))
      return true
    })
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk))
      return true
    })

    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeLiveChild())
    scheduleAutoDigestSpawnMock.mockReset()
    buildBackgroundSavePromptMock.mockReset()
    buildBackgroundSavePromptMock.mockImplementation(
      () => "[Lore autosave] mocked prompt body"
    )
    delete process.env["LORE_DISABLE_LEARNING_EXTRACTION"]
  })

  afterEach(() => {
    vi.useRealTimers()
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
    delete process.env["LORE_DISABLE_LEARNING_EXTRACTION"]
  })

  it("never emits decision: block when the interval is reached", async () => {
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-no-block",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig()
    )

    const stdout = stdoutWrites.join("")
    expect(stdout).not.toContain('"decision"')
    expect(stdout).not.toContain("block")
    expect(stdout.trim()).toBe("{}")
  })

  it("spawns a background save when the interval is reached", async () => {
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-spawn",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig()
    )

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(typeof bin).toBe("string")
    expect(args).toContain("-p")
    // Background saves allowlist the four polymorphic lore write tools
    // — the legacy aliases were removed in the 0.6.0 deprecation purge.
    const allowedIdx = args.indexOf("--allowedTools")
    expect(allowedIdx).toBeGreaterThan(-1)
    const allowed = args[allowedIdx + 1]
    expect(allowed).toContain("lore-memory")
    expect(allowed).toContain("lore-fact")
    expect(allowed).toContain("lore-decision")
    expect(allowed).toContain("lore-task")
    // 0.9.0/08: the atomic-learning extraction prompt asks the sub-agent
    // to probe `lore-query action='search'` for dedup; the allowlist must
    // include lore-query so that probe is callable. (action='ask' is
    // the wrong probe for memory dedup — entity-keyed graph walk vs.
    // the memory-shaped similarity surface — see prompts.ts.)
    expect(allowed).toContain("lore-query")
    // lore-journal is soft-deprecated and no longer invited from the prompt;
    // drop it from the allowlist too so implementation and prompt agree.
    expect(allowed).not.toContain("lore-journal")
    // Legacy single-purpose aliases should not appear after the purge.
    expect(allowed).not.toContain("lore-remember")
    expect(allowed).not.toContain("lore-learn")
    expect(allowed).not.toContain("lore-decide")
    expect(allowed).not.toContain("lore-task-create")
  })

  it("issue #194 — codex-shaped backgroundAgent threads through to the spawn boundary", async () => {
    // Pins the bottom half of the pipeline: a pre-resolved
    // `HookConfig.backgroundAgent` carrying codex's shape must reach
    // `child_process.spawn` with the codex binary AND codex args, NOT
    // Claude's flag dialect. The top half (mergeHookDefaults's
    // command + preset resolution from `LORE_AGENT_NAME` / yaml / env)
    // is exercised in `config.test.ts`; this test pins the
    // helpers.handleStop → spawnBackgroundSave → spawn stage so the
    // two halves can't drift independently.
    execFileSyncMock.mockImplementationOnce(() => "/mock/bin/codex\n")

    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-codex-preset",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig({
        backgroundAgent: { command: "codex", args: ["exec", "--full-auto"] },
      })
    )

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]]
    expect(bin).toBe("/mock/bin/codex")
    // Codex preset shape — emphatically NOT Claude's flag dialect.
    expect(args).toEqual(["exec", "--full-auto"])
    expect(args).not.toContain("-p")
    expect(args).not.toContain("--allowedTools")
    expect(args).not.toContain("--model")
    expect(args).not.toContain("sonnet")
    expect(args).not.toContain("--dangerously-skip-permissions")
    expect(args).not.toContain("--no-session-persistence")
  })

  it("issue #194 — threads a custom backgroundAgent into the spawn (binary + args + placeholder substitution)", async () => {
    // End-to-end pin: a `.lore.yaml`-overridden backgroundAgent flows
    // from the resolved HookConfig through `handleStop` into
    // `spawnBackgroundSave` and lands at the `child_process.spawn`
    // boundary as the operator-configured binary + args. Without this,
    // the unit tests cover the helpers in isolation but no test catches
    // a regression where the integration drops the custom shape.
    //
    // Path probe routing: `which` returns `/mock/bin/codex` for the
    // override; the same `execFileSyncMock` already powers the default
    // path so we don't need extra setup here.
    execFileSyncMock.mockImplementationOnce(() => "/mock/bin/codex\n")

    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-custom-agent",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig({
        backgroundAgent: {
          command: "codex",
          args: ["exec", "--full-auto", "--tools={{allowedTools}}"],
        },
      })
    )

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [bin, args] = spawnMock.mock.calls[0] as [string, string[]]
    // Binary lookup hit the override, not the default `claude`.
    expect(bin).toBe("/mock/bin/codex")
    // Args carry the operator's custom shape, including the substituted
    // allowlist embedded in the `--tools=` arg via the placeholder.
    expect(args[0]).toBe("exec")
    expect(args[1]).toBe("--full-auto")
    expect(args[2]).toMatch(/^--tools=/)
    expect(args[2]).toContain("lore-memory")
    // The historical `claude -p`-shaped flags are absent — proves the
    // operator's args fully replaced the defaults rather than appending.
    expect(args).not.toContain("--dangerously-skip-permissions")
    expect(args).not.toContain("--no-session-persistence")
    expect(args).not.toContain("-p")
  })

  it("forwards LORE_USER_NAME into the spawned child's env when set (DEFERRED-ATTRIBUTION)", async () => {
    // The detached `claude -p` runs the spawned MCP server which
    // lazily resolves identity on unattributed writes. Forwarding
    // `LORE_USER_NAME` keeps that path synchronous and avoids a
    // `users.me` round-trip. Pin both the conditional forward (set →
    // forwarded) AND the absence of unrelated env leakage.
    process.env["LORE_USER_NAME"] = "Test User"
    try {
      writeTranscript(transcriptPath, 3)
      await handleStop(
        {
          session_id: "sess-attrib-env",
          transcript_path: transcriptPath,
          cwd: tmpDir,
        },
        defaultConfig()
      )

      expect(spawnMock).toHaveBeenCalledTimes(1)
      const [, , options] = spawnMock.mock.calls[0] as [
        string,
        string[],
        { env: Record<string, string> },
      ]
      expect(options.env["LORE_USER_NAME"]).toBe("Test User")
    } finally {
      delete process.env["LORE_USER_NAME"]
    }
  })

  it("does NOT include LORE_USER_NAME in the child env when unset (no empty-string injection)", async () => {
    // The dominant case: ntn-resolved-identity engineer who hasn't set
    // the override. `LORE_USER_NAME` must be absent from the child's
    // env so the spawned MCP child's lazy resolver falls through
    // cleanly to `users.me`. An accidentally-injected empty
    // string would short-circuit the env-override branch with the
    // "no LORE_USER_NAME, fall to users.me" path bypassed.
    delete process.env["LORE_USER_NAME"]
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-no-attrib-env",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig()
    )

    expect(spawnMock).toHaveBeenCalledTimes(1)
    const [, , options] = spawnMock.mock.calls[0] as [
      string,
      string[],
      { env: Record<string, string> },
    ]
    expect("LORE_USER_NAME" in options.env).toBe(false)
  })

  it("does not spawn when the interval has not been reached", async () => {
    writeTranscript(transcriptPath, 1)
    await handleStop(
      {
        session_id: "sess-under-threshold",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig({ saveInterval: 5 })
    )

    expect(spawnMock).not.toHaveBeenCalled()
    expect(stdoutWrites.join("").trim()).toBe("{}")
  })

  it("leaves only one process running when two Stop hooks race on the same session", async () => {
    writeTranscript(transcriptPath, 10)
    const sessionId = "sess-lock-overlap"

    // First fire: reaches threshold, acquires lock, spawns once. Because our
    // fake child reports process.pid (guaranteed alive), the lock stays live
    // across the second call.
    await handleStop(
      {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig()
    )

    // Second fire: interval would again say "spawn", but the lock is still
    // held by the "previous" child → no second spawn.
    await handleStop(
      {
        session_id: sessionId,
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig({ saveInterval: 1 })
    )

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it("still serializes spawns when two Stop hooks fire concurrently (Promise.all)", async () => {
    writeTranscript(transcriptPath, 10)
    const sessionId = "sess-lock-concurrent"

    // Both hooks start simultaneously. Only one can acquire the lock; the
    // other must skip spawn even though it also clears the interval check.
    await Promise.all([
      handleStop(
        { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
        defaultConfig()
      ),
      handleStop(
        { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
        defaultConfig()
      ),
    ])

    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it("still responds {} and exits cleanly when the lock rejects the spawn", async () => {
    writeTranscript(transcriptPath, 10)
    const sessionId = "sess-lock-output"
    await handleStop(
      { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
      defaultConfig()
    )
    stdoutWrites.length = 0
    await handleStop(
      { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
      defaultConfig({ saveInterval: 1 })
    )
    expect(stdoutWrites.join("").trim()).toBe("{}")
    expect(stdoutWrites.join("")).not.toContain('"decision"')
  })

  it("does not advance the save counter when a peer holds the session lock", async () => {
    // PF2-03 invariant: handleStop only advances the save counter on
    // `result.kind === "spawned"`. When `spawnBackgroundSave` returns
    // `lock-held` (because a peer is still in flight), the counter must
    // stay where it is so the next Stop hook retries. A regression here
    // would re-introduce the bug PR #66 fixed.
    writeTranscript(transcriptPath, 5)
    const sessionId = "sess-counter-invariant"

    // Pre-acquire the session lock with this process's PID so it's seen as
    // "alive" — `spawnBackgroundSave` will short-circuit on its fast-path
    // `hasActiveSessionLock` check and return `lock-held` without firing
    // child_process.spawn at all.
    const heldLock = tryAcquireSessionLock(sessionId, process.pid)
    expect(heldLock).not.toBeNull()

    await handleStop(
      { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
      defaultConfig()
    )

    // No child spawn should have happened — the fast-path lock-held check
    // returns before child_process.spawn is invoked.
    expect(spawnMock).not.toHaveBeenCalled()

    // Counter must remain at 0 — proving the next Stop hook will see
    // currentCount > lastSaveCount and re-fire the save on its turn.
    // Route through `statePath` (rather than re-inlining the join +
    // raw `${sessionId}.count`) so the assertion exercises the same
    // sanitized path the production writer uses; without that, a future
    // regression that broke the writer/reader round-trip wouldn't be
    // caught here.
    const { readFileSync, existsSync } = await import("node:fs")
    const counterPath = statePath(sessionId)
    if (existsSync(counterPath)) {
      const contents = readFileSync(counterPath, "utf-8")
      expect(contents).toBe("0")
    }

    releaseSessionLock(heldLock!)
  })

  it("records an autosave failure marker when the background binary is missing", async () => {
    const context = failureContext(tmpDir)
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-missing-binary",
        transcript_path: transcriptPath,
        cwd: context.cwd,
      },
      defaultConfig({
        backgroundAgent: {
          command: "/definitely/missing/lore-background-agent",
          args: [],
        },
      }),
      { config: context.config, configRoot: context.configRoot }
    )

    const [marker] = await listBackgroundFailures(context.configRoot)
    expect(marker).toMatchObject({
      kind: "autosave",
      projectName: "Widget Backend",
      sessionId: "sess-missing-binary",
      code: "binary-missing",
    })
    expect(marker?.message).toContain("background command")
    expect(marker?.logPath).toBeUndefined()
  })

  it("clears a prior autosave failure marker once a later session spawn starts", async () => {
    const context = failureContext(tmpDir)
    recordBackgroundFailure(context.configRoot, {
      kind: "autosave",
      projectName: "Widget Backend",
      sessionId: "sess-prior-failure",
      code: "binary-missing",
      message: "background command missing",
    })
    expect(await listBackgroundFailures(context.configRoot)).toHaveLength(1)

    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-later-success",
        transcript_path: transcriptPath,
        cwd: context.cwd,
      },
      defaultConfig(),
      { config: context.config, configRoot: context.configRoot }
    )

    expect(await listBackgroundFailures(context.configRoot)).toEqual([])
  })

  it("keeps a same-scope failure recorded during a successful spawn", async () => {
    const context = failureContext(tmpDir)
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"))
    spawnMock.mockImplementation(() => {
      recordBackgroundFailure(context.configRoot, {
        kind: "autosave",
        projectName: "Widget Backend",
        sessionId: "sess-concurrent-failure",
        code: "spawn-error",
        message: "concurrent stop failed",
      })
      vi.setSystemTime(new Date("2026-04-24T12:00:00.001Z"))
      return fakeLiveChild()
    })

    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-later-success",
        transcript_path: transcriptPath,
        cwd: context.cwd,
      },
      defaultConfig(),
      { config: context.config, configRoot: context.configRoot }
    )

    const [marker] = await listBackgroundFailures(context.configRoot, {
      now: new Date("2026-04-24T12:00:01.000Z"),
    })
    expect(marker).toMatchObject({
      kind: "autosave",
      projectName: "Widget Backend",
      sessionId: "sess-concurrent-failure",
      code: "spawn-error",
    })
  })

  it("acquires the session lock with the child's PID", async () => {
    writeTranscript(transcriptPath, 3)
    const sessionId = "sess-pid-lock"
    await handleStop(
      { session_id: sessionId, transcript_path: transcriptPath, cwd: tmpDir },
      defaultConfig()
    )
    // The fake child returns process.pid. The hook acquires the lock with
    // that PID directly, so staleness probes keep returning "alive" after
    // the hook exits.
    const { readFileSync } = await import("node:fs")
    const lockContent = readFileSync(lockPath(sessionId), "utf-8").trim()
    expect(lockContent).toBe(process.pid.toString())
  })

  it("writes the save counter under getStateDir() even for a hostile sessionId (issue #200 E2E)", async () => {
    // Parallel to the `tryAcquireSessionLock` end-to-end check in
    // `lock.test.ts`. Drives the real `handleStop` -> `writeSaveCount`
    // path with a path-traversing sessionId and verifies the counter
    // file lands inside the state dir. Without `safeFilenameSegment`
    // in `statePath`, this writes to `$TMPDIR/escape/me.count` and the
    // assertion below fails — pin the production write path, not just
    // the path builder, so a future regression that bypassed
    // `statePath` (e.g. inlining the join in `writeSaveCount`) gets
    // caught here.
    const { existsSync, readFileSync } = await import("node:fs")
    writeTranscript(transcriptPath, 3)
    const hostile = "../escape/me"
    await handleStop(
      {
        session_id: hostile,
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig()
    )

    const stateDir = getStateDir()
    const expected = statePath(hostile)
    expect(expected.startsWith(`${stateDir}/`)).toBe(true)
    expect(existsSync(expected)).toBe(true)
    // Counter must reflect the user-message count we just produced.
    expect(readFileSync(expected, "utf-8")).toBe("3")
    // Confirm no file was written at the un-sanitized escape path —
    // belt-and-suspenders proof that the hostile id didn't ALSO land
    // there as a side effect.
    const escapePath = `${stateDir}/../escape/me.count`
    expect(existsSync(escapePath)).toBe(false)
  })

  it("creates the save counter private even under umask 000", async () => {
    writeTranscript(transcriptPath, 3)
    const sessionId = "sess-count-mode"

    await withUmask(0o000, async () => {
      await handleStop(
        {
          session_id: sessionId,
          transcript_path: transcriptPath,
          cwd: tmpDir,
        },
        defaultConfig()
      )
    })

    expect(modeBits(statSync(getStateDir()).mode)).toBe(HOOK_STATE_DIR_MODE)
    expect(modeBits(statSync(statePath(sessionId)).mode)).toBe(HOOK_STATE_FILE_MODE)
  })

  it("schedules the detached auto-digest helper with the event cwd", async () => {
    // 0.6.0: auto-digest moved off SessionEnd to a detached node child
    // spawned from Stop. The parent process must NOT init Notion or gather
    // digest data — the scheduling call is the parent's only contribution.
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-auto-digest",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig()
    )

    expect(scheduleAutoDigestSpawnMock).toHaveBeenCalledTimes(1)
    expect(scheduleAutoDigestSpawnMock.mock.calls[0]![0]).toBe(tmpDir)
  })

  it("schedules auto-digest even when the save threshold is not reached", async () => {
    // The save counter and the digest marker debounce independently —
    // a quiet session that doesn't trigger autosave should still get a
    // chance to refresh a stale digest. The marker debounce inside the
    // helper is the only guard against repeated firings.
    writeTranscript(transcriptPath, 1)
    await handleStop(
      {
        session_id: "sess-quiet",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig({ saveInterval: 5 })
    )

    expect(spawnMock).not.toHaveBeenCalled()
    expect(scheduleAutoDigestSpawnMock).toHaveBeenCalledTimes(1)
  })

  it("schedules auto-digest with process.cwd() when the event has no cwd", async () => {
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-no-cwd",
        transcript_path: transcriptPath,
      },
      defaultConfig()
    )

    expect(scheduleAutoDigestSpawnMock).toHaveBeenCalledTimes(1)
    expect(scheduleAutoDigestSpawnMock.mock.calls[0]![0]).toBe(process.cwd())
  })

  it("schedules auto-digest even when the transcript is missing or unreadable", async () => {
    // Stop hook must always emit `{}` and always give the digest path a
    // chance to run, regardless of whether the transcript was readable.
    await handleStop(
      {
        session_id: "sess-no-transcript",
        // No transcript_path, so readTranscriptForSave returns null and
        // handleStop's early-return branch fires. That branch must still
        // schedule the digest helper.
        cwd: tmpDir,
      },
      defaultConfig()
    )

    expect(spawnMock).not.toHaveBeenCalled()
    expect(scheduleAutoDigestSpawnMock).toHaveBeenCalledTimes(1)
    expect(scheduleAutoDigestSpawnMock.mock.calls[0]![0]).toBe(tmpDir)
  })

  // -----------------------------------------------------------------
  // 0.9.0/08: atomic-learning extraction kill switches
  //
  // The helper resolves `extractLearnings` from two knobs and passes the
  // result to `buildBackgroundSavePrompt`. The dual-knob shape mirrors
  // `autoDigest`: either knob set to disabled wins (AND-of-permissive),
  // and only the resolved boolean is exposed to the prompt builder.
  // -----------------------------------------------------------------

  function lastExtractLearnings(): boolean | undefined {
    expect(buildBackgroundSavePromptMock).toHaveBeenCalled()
    const call = buildBackgroundSavePromptMock.mock.calls.at(-1)!
    // Signature: (subProjects, catchAllName, sessionContent, sessionId,
    // agentName, options). The options arg is the 6th positional.
    const options = call[5] as { extractLearnings?: boolean } | undefined
    return options?.extractLearnings
  }

  it("passes extractLearnings: true to buildBackgroundSavePrompt by default", async () => {
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-learn-default",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig()
    )

    expect(lastExtractLearnings()).toBe(true)
  })

  it("resolves installed external profile prompts for Stop autosave", async () => {
    const context = failureContext(tmpDir)
    context.config.profile = "external-support@1.0.0"
    writeFiles(
      join(tmpDir, ".lore", "profiles", "installed", "external-support", "1.0.0"),
      minimalExternalProfileFiles("external-support")
    )

    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-installed-profile-prompts",
        transcript_path: transcriptPath,
        cwd: context.cwd,
      },
      defaultConfig(),
      { config: context.config, configRoot: context.configRoot }
    )

    const call = buildBackgroundSavePromptMock.mock.calls.at(-1)!
    const options = call[5] as {
      profilePrompts?: {
        autosaveExtractionFilter?: { text?: string; source?: string }
      }
    }
    expect(options.profilePrompts?.autosaveExtractionFilter?.text).toBe(
      "Installed profile autosave filter."
    )
    expect(options.profilePrompts?.autosaveExtractionFilter?.source).toBe(
      "active-profile"
    )
  })

  it("passes extractLearnings: false when the resolved learning-extraction feature is off", async () => {
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-learn-env-off",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig({ features: { learningExtraction: false } })
    )

    expect(lastExtractLearnings()).toBe(false)
  })

  it("passes extractLearnings: false when hooks.learningExtraction is false", async () => {
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-learn-config-off",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig({ learningExtraction: false })
    )

    expect(lastExtractLearnings()).toBe(false)
  })

  it("passes extractLearnings: false when both config and the resolved feature are off", async () => {
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-learn-both-off",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig({
        learningExtraction: false,
        features: { learningExtraction: false },
      })
    )

    expect(lastExtractLearnings()).toBe(false)
  })

  it("does not reread ambient LORE_DISABLE_LEARNING_EXTRACTION after hook features are resolved", async () => {
    // The parser layer owns env interpretation. Once the hook config
    // carries `features.learningExtraction: true`, Stop processing
    // should not re-check process.env and change behavior mid-process.
    process.env["LORE_DISABLE_LEARNING_EXTRACTION"] = "true"

    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-learn-env-non-one",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig()
    )

    expect(lastExtractLearnings()).toBe(true)
  })

  it("resolved feature gate beats hooks.learningExtraction: true in config", async () => {
    writeTranscript(transcriptPath, 3)
    await handleStop(
      {
        session_id: "sess-learn-env-wins",
        transcript_path: transcriptPath,
        cwd: tmpDir,
      },
      defaultConfig({
        learningExtraction: true,
        features: { learningExtraction: false },
      })
    )

    expect(lastExtractLearnings()).toBe(false)
  })
})

describe("handleSessionEnd compatibility shim", () => {
  // 0.6.0 removed active SessionEnd registration. `handleSessionEnd` is
  // kept as a one-release exit-0 no-op so stale Claude Code settings
  // pointing at `node dist/hooks/helpers.js session-end` keep exiting
  // cleanly until operators reinstall.

  const savedEnv = { ...process.env }
  let stdoutSpy: { mockRestore: () => void }
  let stderrSpy: { mockRestore: () => void }
  let stderrWrites: string[]

  beforeEach(() => {
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    stderrWrites = []
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrWrites.push(String(chunk))
      return true
    })
    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeLiveChild())
    fireDigestIfStaleMock.mockReset()
    scheduleAutoDigestSpawnMock.mockReset()
  })

  afterEach(() => {
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    process.env = { ...savedEnv }
  })

  it("resolves without spawning a save even when ambient env vars are populated", async () => {
    // Pre-0.6.0 Claude Code shells forwarded the event JSON to the helper
    // via `LORE_SESSION_END_CONTENT`. A stale settings.json invocation
    // can still set that env var, so we explicitly assert the shim
    // ignores it — the compatibility handler is a strict no-op, not a
    // soft-deprecated path that re-activates when input is present.
    process.env["LORE_SESSION_END_CONTENT"] = JSON.stringify({
      session_id: "sess-stale",
      transcript_path: "/nonexistent/transcript.jsonl",
      cwd: "/tmp",
    })
    delete process.env["LORE_AUTOSAVE"]

    await expect(handleSessionEnd()).resolves.toBeUndefined()

    expect(spawnMock).not.toHaveBeenCalled()
  })

  it("does not call fireDigestIfStale or schedule the auto-digest helper", async () => {
    // Auto-digest scheduling moved to Stop entirely. The stale shim must
    // not double-fire the scheduler from a SessionEnd path.
    await handleSessionEnd()

    expect(fireDigestIfStaleMock).not.toHaveBeenCalled()
    expect(scheduleAutoDigestSpawnMock).not.toHaveBeenCalled()
  })

  it("emits no stderr by default — a stale hook must be invisible to the operator", async () => {
    await handleSessionEnd()

    expect(stderrWrites.join("")).toBe("")
  })
})

describe("handleAutoDigest", () => {
  let tmpDir: string
  let stdoutSpy: { mockRestore: () => void }
  let stderrSpy: { mockRestore: () => void }
  const savedEnv = { ...process.env }
  const originalCwd = process.cwd()

  // Minimal `.lore.yaml` so `loadHookState` returns a populated `config`
  // + `configRoot`. Without these fields the auto-digest helper short-
  // circuits before reaching `fireDigestIfStale`.
  const FIXTURE_YAML = `vault:
  pageId: vault-fixture-id
projects:
  - name: Widget
    path: .
hooks:
  autoDigest: true
`

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lore-auto-digest-"))
    writeFileSync(join(tmpDir, ".lore.yaml"), FIXTURE_YAML)

    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true)
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    spawnMock.mockReset()
    spawnMock.mockImplementation(() => fakeLiveChild())

    fireDigestIfStaleMock.mockReset()
    fireDigestIfStaleMock.mockResolvedValue("no-project")

    // chdir so the helper's `findConfigFile(process.cwd())` finds the
    // fixture. The detached child the Stop hook spawns gets `cwd`
    // baked in by `child_process.spawn`, so production reads the same
    // value via `process.cwd()`.
    process.chdir(tmpDir)

    delete process.env["LORE_AUTO_DIGEST"]
  })

  afterEach(() => {
    process.chdir(originalCwd)
    stdoutSpy.mockRestore()
    stderrSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
    try {
      rmSync(getStateDir(), { recursive: true, force: true })
    } catch {
      // Nothing to clean.
    }
    process.env = { ...savedEnv }
  })

  it("calls fireDigestIfStale with process.cwd(), loaded config, and autoDigest=true", async () => {
    await handleAutoDigest()

    expect(fireDigestIfStaleMock).toHaveBeenCalledTimes(1)
    const [cwdArg, stateArg] = fireDigestIfStaleMock.mock.calls[0] as unknown as [
      string,
      { config: { vault: { pageId: string } }; configRoot: string; autoDigest: boolean },
    ]
    expect(cwdArg).toBe(process.cwd())
    // findConfigFile canonicalizes via real-path resolution (`/var → /private/var`
    // on macOS), so compare canonical to canonical instead of the raw mkdtemp.
    expect(stateArg.configRoot).toBe(realpathSync(tmpDir))
    expect(stateArg.autoDigest).toBe(true)
    expect(stateArg.config.vault.pageId).toBe("vault-fixture-id")
  })

  it("threads autoDigest=false through to the scheduler when LORE_AUTO_DIGEST=false", async () => {
    process.env["LORE_AUTO_DIGEST"] = "false"

    await handleAutoDigest()

    expect(fireDigestIfStaleMock).toHaveBeenCalledTimes(1)
    const stateArg = (
      fireDigestIfStaleMock.mock.calls[0] as unknown as [string, { autoDigest: boolean }]
    )[1]
    expect(stateArg.autoDigest).toBe(false)
  })

  it("threads autoDigest=false when hooks.autoDigest is false in .lore.yaml", async () => {
    writeFileSync(
      join(tmpDir, ".lore.yaml"),
      FIXTURE_YAML.replace("autoDigest: true", "autoDigest: false")
    )

    await handleAutoDigest()

    expect(fireDigestIfStaleMock).toHaveBeenCalledTimes(1)
    const stateArg = (
      fireDigestIfStaleMock.mock.calls[0] as unknown as [string, { autoDigest: boolean }]
    )[1]
    expect(stateArg.autoDigest).toBe(false)
  })

  it("env override wins over `hooks.autoDigest: true` in config", async () => {
    process.env["LORE_AUTO_DIGEST"] = "false"

    await handleAutoDigest()

    const stateArg = (
      fireDigestIfStaleMock.mock.calls[0] as unknown as [string, { autoDigest: boolean }]
    )[1]
    expect(stateArg.autoDigest).toBe(false)
  })

  it("swallows scheduler throws so the detached child still exits cleanly", async () => {
    // The detached helper has no parent to propagate failures to; an
    // uncaught throw would only end up in `child.stderr` and confuse
    // operators inspecting hook state. The handler must trap the throw.
    fireDigestIfStaleMock.mockRejectedValueOnce(new Error("notion exploded"))

    await expect(handleAutoDigest()).resolves.toBeUndefined()
    expect(fireDigestIfStaleMock).toHaveBeenCalledTimes(1)
  })

  it("returns early without calling fireDigestIfStale when no .lore.yaml is found", async () => {
    const noConfigDir = mkdtempSync(join(tmpdir(), "lore-no-config-auto-digest-"))
    try {
      process.chdir(noConfigDir)

      await handleAutoDigest()

      expect(fireDigestIfStaleMock).not.toHaveBeenCalled()
    } finally {
      rmSync(noConfigDir, { recursive: true, force: true })
    }
  })
})

describe("wakeup state", () => {
  const FIXTURE_YAML = `vault:
  pageId: vault-fixture-id
projects:
  - name: Widget
    path: .
hooks:
  wakeUp: true
`
  const originalCwd = process.cwd()
  let tmpDir: string
  let stderrSpy: { mockRestore: () => void }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lore-wakeup-mode-"))
    writeFileSync(join(tmpDir, ".lore.yaml"), FIXTURE_YAML)
    rmSync(getStateDir(), { recursive: true, force: true })
    initServicesFromConfigMock.mockReset()
    initServicesFromConfigMock.mockRejectedValue(new Error("mock init disabled"))
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.chdir(tmpDir)
  })

  afterEach(() => {
    process.chdir(originalCwd)
    stderrSpy.mockRestore()
    rmSync(tmpDir, { recursive: true, force: true })
    rmSync(getStateDir(), { recursive: true, force: true })
  })

  it("creates the wakeup debounce marker private even under umask 000", async () => {
    const sessionId = "sess-wakeup-mode"
    const event = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: sessionId,
      prompt: "load relevant context",
    })

    await withUmask(0o000, async () => {
      await wakeup({ event })
    })

    expect(modeBits(statSync(getStateDir()).mode)).toBe(HOOK_STATE_DIR_MODE)
    expect(modeBits(statSync(wakeupStatePath(sessionId)).mode)).toBe(HOOK_STATE_FILE_MODE)
  })
})

describe("parseUserQueryFromEvent", () => {
  // P3-05: the wake-up hook reads the JSON event Claude Code's
  // UserPromptSubmit emits on stdin (forwarded by wakeup.sh as
  // LORE_WAKEUP_EVENT). The parser is the only place where event-shape
  // assumptions live; pinning them here keeps a future Claude Code
  // event-shape change from silently degrading wake-up to the unranked
  // fallback path without us noticing.

  it("extracts the prompt field from a well-formed UserPromptSubmit event", () => {
    const raw = JSON.stringify({
      session_id: "abc",
      hook_event_name: "UserPromptSubmit",
      prompt: "How do I fix the auth bug?",
      cwd: "/tmp",
    })
    expect(parseUserQueryFromEvent(raw)).toBe("How do I fix the auth bug?")
  })

  it("extracts the prompt from Codex UserPromptSubmit events", () => {
    const raw = JSON.stringify({
      session_id: "codex-session",
      hook_event_name: "UserPromptSubmit",
      turn_id: "turn-1",
      prompt: "Make Codex wake-up query-aware",
      cwd: "/tmp",
    })
    expect(parseUserQueryFromEvent(raw)).toBe("Make Codex wake-up query-aware")
  })

  it("trims surrounding whitespace from the prompt", () => {
    const raw = JSON.stringify({ prompt: "  fix auth bug  \n" })
    expect(parseUserQueryFromEvent(raw)).toBe("fix auth bug")
  })

  it("returns undefined for a whitespace-only prompt", () => {
    // Treated identically to an absent prompt — the data layer would
    // skip the search anyway, but degrading at the parser keeps the
    // log line accurate ("no user query" rather than "empty user query").
    const raw = JSON.stringify({ prompt: "   \n\t  " })
    expect(parseUserQueryFromEvent(raw)).toBeUndefined()
  })

  it.each([
    ["undefined env var", undefined],
    ["empty string", ""],
    ["whitespace only", "  \n  "],
  ])("returns undefined for %s (Codex SessionStart fallback)", (_label, raw) => {
    expect(parseUserQueryFromEvent(raw)).toBeUndefined()
  })

  it("returns undefined for malformed JSON (degrades to fallback path)", () => {
    // A misconfigured wakeup.sh forwarding non-JSON would otherwise
    // crash the helper. Falling back to unranked output is strictly
    // better than failing wake-up entirely.
    expect(parseUserQueryFromEvent("not-json-at-all")).toBeUndefined()
    expect(parseUserQueryFromEvent("{ unterminated")).toBeUndefined()
  })

  it("returns undefined for valid JSON that's not an object", () => {
    expect(parseUserQueryFromEvent("null")).toBeUndefined()
    expect(parseUserQueryFromEvent('"just a string"')).toBeUndefined()
    expect(parseUserQueryFromEvent("42")).toBeUndefined()
    expect(parseUserQueryFromEvent("[1, 2, 3]")).toBeUndefined()
  })

  it("returns undefined when the prompt field is missing", () => {
    // Future-proofing: if Claude Code renames `prompt` to `query` in a
    // later release, we want wake-up to fall back gracefully (and the
    // log under LORE_DEBUG=1 to surface it) rather than ship task-
    // memories seeded by `undefined`.
    const raw = JSON.stringify({
      session_id: "abc",
      hook_event_name: "UserPromptSubmit",
      cwd: "/tmp",
    })
    expect(parseUserQueryFromEvent(raw)).toBeUndefined()
  })

  it("returns undefined when the prompt field is not a string", () => {
    expect(parseUserQueryFromEvent(JSON.stringify({ prompt: 42 }))).toBeUndefined()
    expect(parseUserQueryFromEvent(JSON.stringify({ prompt: null }))).toBeUndefined()
    expect(
      parseUserQueryFromEvent(JSON.stringify({ prompt: { nested: "x" } }))
    ).toBeUndefined()
  })

  it.each([
    ["plain slash command", "/clear"],
    ["with whitespace", "  /compact  "],
    ["with arguments", "/lore-wake-up --debug"],
    ["another tool slash", "/help"],
  ])(
    "returns undefined for %s (slash commands are useless as search seeds)",
    (_label, prompt) => {
      // Slash commands are meta-instructions to the host assistant, not
      // task language. Seeding the relevance ranker with `/clear` would
      // produce noise hits (any memory mentioning "clear") and waste a
      // Notion round-trip. Drop to the fallback path instead.
      const raw = JSON.stringify({ prompt })
      expect(parseUserQueryFromEvent(raw)).toBeUndefined()
    }
  )

  it("preserves prompts that incidentally contain a forward slash", () => {
    // Only LEADING `/` is the slash-command marker. A real task prompt
    // like "fix the path /etc/hosts handling" must still seed the search.
    const raw = JSON.stringify({ prompt: "fix the path /etc/hosts handling" })
    expect(parseUserQueryFromEvent(raw)).toBe("fix the path /etc/hosts handling")
  })

  it("rejects events whose hook_event_name is not UserPromptSubmit, even if they carry a prompt field (PF3-04 nit)", () => {
    // Defensive measure: today only `UserPromptSubmit` is contracted to
    // carry a usable `prompt`. If a future Claude Code release adds a
    // `prompt` field to a different event (e.g. a hypothetical
    // `MidStreamPrompt`), we should NOT silently consume it as a wake-up
    // search seed without an explicit decision here. Future event
    // support requires extending the allowlist.
    const offEvent = JSON.stringify({
      session_id: "abc",
      hook_event_name: "PreToolUse",
      prompt: "this should not be used",
    })
    expect(parseUserQueryFromEvent(offEvent)).toBeUndefined()
  })

  it("rejects events whose hook_event_name is an empty string (sentinel for unknown event)", () => {
    // A forwarder that emits `hook_event_name: ""` as a sentinel for
    // "unknown event" should degrade to fallback rather than be
    // treated as if the field were absent — the field IS present, it
    // just doesn't say `UserPromptSubmit`. Empty string trips the
    // string-typed `!== "UserPromptSubmit"` branch deliberately.
    const emptyNamedEvent = JSON.stringify({
      hook_event_name: "",
      prompt: "fix auth",
    })
    expect(parseUserQueryFromEvent(emptyNamedEvent)).toBeUndefined()
  })

  it("accepts events with no hook_event_name (legacy / stripped forwarders)", () => {
    // The wakeup.sh shim doesn't always preserve the full event shape.
    // When `hook_event_name` is absent we fall through to the prompt
    // check rather than rejecting — this preserves compatibility with
    // forwarders that synthesize a minimal `{prompt}` payload.
    const minimalEvent = JSON.stringify({ prompt: "fix auth bug" })
    expect(parseUserQueryFromEvent(minimalEvent)).toBe("fix auth bug")
  })

  it("falls back when a resumed Claude Code session fires SessionStart instead of UserPromptSubmit", () => {
    // Resumed sessions in Claude Code fire SessionStart, not
    // UserPromptSubmit — there's no user prompt yet. The wakeup.sh
    // script either receives an empty stdin or a SessionStart event
    // with no `prompt` field. Both shapes degrade to the unranked
    // fallback path. This pins that contract so a future Anthropic
    // event-shape change doesn't quietly degrade resumed sessions.
    const sessionStartEvent = JSON.stringify({
      session_id: "abc",
      hook_event_name: "SessionStart",
      cwd: "/tmp",
    })
    expect(parseUserQueryFromEvent(sessionStartEvent)).toBeUndefined()
    // Empty stdin (the more common Codex shape) also falls back.
    expect(parseUserQueryFromEvent("")).toBeUndefined()
    expect(parseUserQueryFromEvent(undefined)).toBeUndefined()
  })
})

describe("parseWakeupEventMetadata", () => {
  it("extracts Codex debounce metadata without treating source as a query", () => {
    const raw = JSON.stringify({
      session_id: "codex-session",
      hook_event_name: "UserPromptSubmit",
      source: "startup",
      prompt: "fix auth",
    })
    expect(parseWakeupEventMetadata(raw)).toEqual({
      hookEventName: "UserPromptSubmit",
      sessionId: "codex-session",
      source: "startup",
    })
  })

  it("returns an empty object for malformed or non-object payloads", () => {
    expect(parseWakeupEventMetadata("not-json")).toEqual({})
    expect(parseWakeupEventMetadata("[1,2,3]")).toEqual({})
    expect(parseWakeupEventMetadata(undefined)).toEqual({})
  })
})

describe("deriveAgentName", () => {
  // Snapshot env so the per-test mutations don't leak across tests in this
  // file (or into the suites above, which assume a clean fixture).
  const savedEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...savedEnv }
  })

  function clearAgentInputs(): void {
    delete process.env["LORE_AGENT_NAME"]
    delete process.env["CLAUDECODE"]
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("CLAUDE_CODE_")) delete process.env[key]
    }
  }

  it("canonicalizes the inferred Claude Code marker path", () => {
    clearAgentInputs()
    process.env["CLAUDECODE"] = "1"
    expect(deriveAgentName({})).toBe("Claude Code")
  })

  it("canonicalizes a Claude variant set explicitly via LORE_AGENT_NAME", () => {
    // A future Claude installer that sets `LORE_AGENT_NAME=claude-code-opus-4-7`
    // by mistake must still resolve to the canonical bucket — the
    // override path is wrapped to keep the Agent column from re-fragmenting.
    clearAgentInputs()
    process.env["LORE_AGENT_NAME"] = "claude-code-opus-4-7"
    expect(deriveAgentName({})).toBe("Claude Code")
  })

  it("preserves explicit third-party Agent names (PF1-04 contract)", () => {
    // `Codex`, `Cline`, etc. set explicitly must pass through verbatim —
    // canonicalization is for messy default-detection variants, not for
    // explicitly-attributed third-party agents.
    clearAgentInputs()
    process.env["LORE_AGENT_NAME"] = "Codex"
    expect(deriveAgentName({})).toBe("Codex")

    process.env["LORE_AGENT_NAME"] = "Cline"
    expect(deriveAgentName({})).toBe("Cline")

    process.env["LORE_AGENT_NAME"] = "Cursor"
    expect(deriveAgentName({})).toBe("Cursor")
  })

  it("returns undefined when neither the override nor any Claude marker is set", () => {
    clearAgentInputs()
    expect(deriveAgentName({})).toBeUndefined()
  })

  it("explicit override beats inference (LORE_AGENT_NAME wins over CLAUDECODE)", () => {
    clearAgentInputs()
    process.env["CLAUDECODE"] = "1"
    process.env["LORE_AGENT_NAME"] = "Codex"
    expect(deriveAgentName({})).toBe("Codex")
  })
})

describe("deriveAuthorName (DEFERRED-ATTRIBUTION)", () => {
  // Parallel to `deriveAgentName` but for the Memory `Author` column.
  // The hook helper has no Notion client at prompt-build time, so it
  // resolves only the `LORE_USER_NAME` env override; the spawned MCP
  // child does the `users.me` fallback independently. Pin the env-trim
  // semantics so a `LORE_USER_NAME="   "` shell-rc misconfiguration
  // doesn't stamp whitespace as the Author.

  const savedEnv = { ...process.env }
  afterEach(() => {
    process.env = { ...savedEnv }
  })

  it("returns the explicit env override when LORE_USER_NAME is set", () => {
    delete process.env["LORE_USER_NAME"]
    process.env["LORE_USER_NAME"] = "Test User"
    expect(deriveAuthorName({})).toBe("Test User")
  })

  it("trims surrounding whitespace on the override", () => {
    delete process.env["LORE_USER_NAME"]
    process.env["LORE_USER_NAME"] = "  Test User  "
    expect(deriveAuthorName({})).toBe("Test User")
  })

  it("returns undefined when LORE_USER_NAME is unset", () => {
    delete process.env["LORE_USER_NAME"]
    expect(deriveAuthorName({})).toBeUndefined()
  })

  it("returns undefined when LORE_USER_NAME is whitespace-only (treated as unset)", () => {
    // A `LORE_USER_NAME="   "` shell-rc misconfiguration must NOT stamp
    // whitespace into the prompt's identity block — the spawned MCP
    // child's `users.me` fallback would then have to fight a confident-
    // but-empty override.
    delete process.env["LORE_USER_NAME"]
    process.env["LORE_USER_NAME"] = "   "
    expect(deriveAuthorName({})).toBeUndefined()
  })
})

// Issue #200: parallel to the lock/log path-injection tests in
// `lock.test.ts`, the save-count file must also stay under
// `getStateDir()` for any sessionId. The save-count writer is
// `writeSaveCount` in `helpers.ts` and the path builder is `statePath`;
// pinning the boundary here means a future regression that drops the
// scrub gets caught at the same layer that protects lock and log files.
describe("statePath path injection resistance", () => {
  // Same shared fixture lockPath / logPath use, so the three tables can't
  // drift on a future attack-shape addition. See
  // `path-injection-fixtures.ts`.
  it.each(HOSTILE_SESSION_IDS as unknown as Array<[string, string]>)(
    "stays under getStateDir() for %s",
    (_label, hostileId) => {
      const stateDir = getStateDir()
      const path = statePath(hostileId)
      expect(path.startsWith(`${stateDir}/`)).toBe(true)
      expect(path).toMatch(/\.count$/)
      const segment = path.slice(stateDir.length + 1)
      expect(segment).not.toContain("/")
      expect(segment).not.toContain("\\")
    }
  )

  it("leaves UUID-shaped sessionIds unchanged", () => {
    // Existing on-disk save-count files keyed on real Claude Code
    // session ids must remain addressable across the upgrade — the
    // issue-200 scrub is a defense for hostile inputs, not a migration
    // of the common case.
    const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
    expect(statePath(uuid)).toBe(`${getStateDir()}/${uuid}.count`)
  })

  it("applies the same sanitization to wakeup debounce markers", () => {
    const hostileId = "../escape/me"
    const stateDir = getStateDir()
    const path = wakeupStatePath(hostileId)
    expect(path.startsWith(`${stateDir}/`)).toBe(true)
    expect(path).toMatch(/\.wakeup$/)
    const segment = path.slice(stateDir.length + 1)
    expect(segment).not.toContain("/")
    expect(segment).not.toContain("\\")
  })
})
