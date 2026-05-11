import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { basename } from "node:path"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"

vi.hoisted(() => {
  process.env["LORE_HOOK_STATE_DIR"] =
    `${process.env["TMPDIR"] ?? "/tmp"}/lore-background-failure-marker-${process.pid}-${Date.now()}`
})
import {
  backgroundFailureMarkerPath,
  clearBackgroundFailure,
  collectBackgroundFailures,
  listBackgroundFailures,
  recordBackgroundFailure,
} from "./background-failure-marker.js"
import { getStateDir } from "./lock.js"
import { configKey } from "./marker-key.js"

const CONFIG_ROOT = "/repo/lore"

describe("background-failure-marker", () => {
  // Pin Date so the 14-day staleness window in `listBackgroundFailures` /
  // `collectBackgroundFailures` anchors against the same era the fixtures
  // below use (April 2026). Tests that pass an explicit `now` are
  // unaffected; tests that omit `occurredAt` record at the fake time and
  // list against it. Without the pin, fixtures dated more than 14 days
  // before the real wall clock silently drop out of the result set.
  beforeEach(() => {
    rmSync(getStateDir(), { recursive: true, force: true })
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"))
  })

  afterEach(() => {
    vi.useRealTimers()
    rmSync(getStateDir(), { recursive: true, force: true })
  })

  it("writes bounded marker JSON and reads it back by config root", async () => {
    recordBackgroundFailure(
      CONFIG_ROOT,
      {
        kind: "autosave",
        projectName: "Mail Backend",
        sessionId: "sess-123",
        code: "binary-missing",
        message: "x".repeat(500),
        logPath: "/tmp/lore-hook-state/sess-123.log",
      },
      new Date("2026-04-24T12:00:00.000Z")
    )

    const [marker] = await listBackgroundFailures(CONFIG_ROOT, {
      now: new Date("2026-04-24T12:00:01.000Z"),
    })
    expect(marker?.kind).toBe("autosave")
    expect(marker?.projectName).toBe("Mail Backend")
    expect(marker?.sessionId).toBe("sess-123")
    expect(marker?.code).toBe("binary-missing")
    expect(marker?.message.length).toBeLessThanOrEqual(220)
    expect(marker?.message.endsWith("...")).toBe(true)
    expect(marker?.configRootKey).toBe(configKey(CONFIG_ROOT))
    expect(marker?.logPath).toBe("/tmp/lore-hook-state/sess-123.log")
  })

  it("keeps raw project and session values out of marker filenames", () => {
    const path = backgroundFailureMarkerPath(CONFIG_ROOT, "autosave", {
      projectName: "Mail/Backend",
      sessionId: "../escape/session",
    })

    const file = basename(path)
    expect(path.startsWith(`${getStateDir()}/`)).toBe(true)
    expect(file).toContain(`background-failure.${configKey(CONFIG_ROOT)}.autosave.`)
    expect(file).not.toContain("Mail")
    expect(file).not.toContain("Backend")
    expect(file).not.toContain("escape")
    expect(file).not.toContain("session")
  })

  it("keys active markers by recoverable project scope and keeps latest session context", async () => {
    const pathA = backgroundFailureMarkerPath(CONFIG_ROOT, "autosave", {
      projectName: "Mail Backend",
      sessionId: "sess-a",
    })
    const pathB = backgroundFailureMarkerPath(CONFIG_ROOT, "autosave", {
      projectName: "Mail Backend",
      sessionId: "sess-b",
    })
    expect(pathA).toBe(pathB)

    recordBackgroundFailure(
      CONFIG_ROOT,
      {
        kind: "autosave",
        projectName: "Mail Backend",
        sessionId: "sess-a",
        code: "binary-missing",
        message: "background command missing",
      },
      new Date("2026-04-24T12:00:00.000Z")
    )
    recordBackgroundFailure(
      CONFIG_ROOT,
      {
        kind: "autosave",
        projectName: "Mail Backend",
        sessionId: "sess-b",
        code: "spawn-error",
        message: "spawn failed",
      },
      new Date("2026-04-24T12:01:00.000Z")
    )

    const markers = await listBackgroundFailures(CONFIG_ROOT, {
      now: new Date("2026-04-24T12:02:00.000Z"),
    })
    expect(markers).toHaveLength(1)
    expect(markers[0]).toMatchObject({
      kind: "autosave",
      projectName: "Mail Backend",
      sessionId: "sess-b",
      code: "spawn-error",
    })
  })

  it("clears the marker for the same recoverable scope across sessions", async () => {
    const scope = { projectName: "Mail Backend", sessionId: "sess-clear" }
    recordBackgroundFailure(CONFIG_ROOT, {
      kind: "autosave",
      ...scope,
      code: "spawn-error",
      message: "spawn failed",
    })
    expect(await listBackgroundFailures(CONFIG_ROOT)).toHaveLength(1)

    await clearBackgroundFailure(CONFIG_ROOT, "autosave", {
      projectName: "Mail Backend",
      sessionId: "sess-later-success",
    })

    expect(await listBackgroundFailures(CONFIG_ROOT)).toEqual([])
  })

  it("clears helper-spawn markers by project scope instead of session scope", async () => {
    recordBackgroundFailure(CONFIG_ROOT, {
      kind: "auto-digest-helper-spawn",
      projectName: "Mail Backend",
      sessionId: "sess-helper-a",
      code: "spawn-error",
      message: "spawn failed",
    })
    expect(await listBackgroundFailures(CONFIG_ROOT)).toHaveLength(1)

    await clearBackgroundFailure(CONFIG_ROOT, "auto-digest-helper-spawn", {
      projectName: "Mail Backend",
      sessionId: "sess-helper-b",
    })

    expect(await listBackgroundFailures(CONFIG_ROOT)).toEqual([])
  })

  it("does not clear a newer failure marker with an older success timestamp", async () => {
    const scope = { projectName: "Mail Backend", sessionId: "sess-race" }
    recordBackgroundFailure(
      CONFIG_ROOT,
      {
        kind: "autosave",
        ...scope,
        code: "spawn-error",
        message: "spawn failed",
      },
      new Date("2026-04-24T12:01:00.000Z")
    )

    await clearBackgroundFailure(CONFIG_ROOT, "autosave", scope, {
      before: new Date("2026-04-24T12:00:00.000Z"),
    })
    expect(
      await listBackgroundFailures(CONFIG_ROOT, {
        now: new Date("2026-04-24T12:02:00.000Z"),
      })
    ).toHaveLength(1)

    await clearBackgroundFailure(CONFIG_ROOT, "autosave", scope, {
      before: new Date("2026-04-24T12:02:00.000Z"),
    })
    expect(await listBackgroundFailures(CONFIG_ROOT)).toEqual([])
  })

  it("keeps a marker recorded exactly at the recovery boundary", async () => {
    const scope = { projectName: "Mail Backend", sessionId: "sess-same-ms" }
    recordBackgroundFailure(
      CONFIG_ROOT,
      {
        kind: "autosave",
        ...scope,
        code: "spawn-error",
        message: "spawn failed",
      },
      new Date("2026-04-24T12:00:00.000Z")
    )

    await clearBackgroundFailure(CONFIG_ROOT, "autosave", scope, {
      before: new Date("2026-04-24T12:00:00.000Z"),
    })

    expect(
      await listBackgroundFailures(CONFIG_ROOT, {
        now: new Date("2026-04-24T12:00:01.000Z"),
      })
    ).toHaveLength(1)
  })

  it("prunes stale markers opportunistically on write", () => {
    const staleScope = { projectName: "Old Project", sessionId: "sess-old" }
    const stalePath = backgroundFailureMarkerPath(CONFIG_ROOT, "autosave", staleScope)
    recordBackgroundFailure(
      CONFIG_ROOT,
      {
        kind: "autosave",
        ...staleScope,
        code: "spawn-error",
        message: "old failure",
      },
      new Date("2026-04-01T00:00:00.000Z")
    )
    expect(existsSync(stalePath)).toBe(true)

    recordBackgroundFailure(
      CONFIG_ROOT,
      {
        kind: "digest-scheduler",
        projectName: "Current Project",
        sessionId: "sess-new",
        code: "init-failed",
        message: "new failure",
      },
      new Date("2026-04-24T00:00:00.000Z")
    )

    expect(existsSync(stalePath)).toBe(false)
    const remainingBackgroundFiles = readdirSync(getStateDir()).filter((entry) =>
      entry.startsWith(`background-failure.${configKey(CONFIG_ROOT)}.`)
    )
    expect(remainingBackgroundFiles).toHaveLength(1)
  })

  it("redacts common token shapes from bounded messages", async () => {
    recordBackgroundFailure(CONFIG_ROOT, {
      kind: "digest-scheduler",
      code: "init-failed",
      message:
        "failed with NOTION_API_TOKEN=secret_should_not_persist and Bearer ntn_should_not_persist",
    })

    const [marker] = await listBackgroundFailures(CONFIG_ROOT)

    expect(marker?.message).toContain("NOTION_API_TOKEN=[redacted]")
    expect(marker?.message).toContain("Bearer [redacted]")
    expect(marker?.message).not.toContain("secret_should_not_persist")
    expect(marker?.message).not.toContain("ntn_should_not_persist")
  })

  it("reports marker write failures to stderr without throwing", () => {
    const originalStateDir = process.env["LORE_HOOK_STATE_DIR"]
    const fileStateDir = `${getStateDir()}-file`
    writeFileSync(fileStateDir, "not a directory")
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)

    try {
      process.env["LORE_HOOK_STATE_DIR"] = fileStateDir
      expect(() =>
        recordBackgroundFailure(CONFIG_ROOT, {
          kind: "autosave",
          code: "spawn-error",
          message: "spawn failed",
        })
      ).not.toThrow()
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining("[lore] background-failure-marker: write failed:")
      )
    } finally {
      if (originalStateDir) {
        process.env["LORE_HOOK_STATE_DIR"] = originalStateDir
      } else {
        delete process.env["LORE_HOOK_STATE_DIR"]
      }
      stderrSpy.mockRestore()
      rmSync(fileStateDir, { force: true })
    }
  })

  it("suppresses and prunes malformed and stale marker files", async () => {
    const malformedPath = backgroundFailureMarkerPath(CONFIG_ROOT, "autosave", {
      sessionId: "broken",
    })
    mkdirSync(getStateDir(), { recursive: true })
    writeFileSync(malformedPath, "{not json", { flag: "w" })

    recordBackgroundFailure(
      CONFIG_ROOT,
      {
        kind: "digest-scheduler",
        projectName: "Mail Backend",
        code: "gather-failed",
        message: "rate limit",
      },
      new Date("2026-04-01T00:00:00.000Z")
    )

    expect(
      await listBackgroundFailures(CONFIG_ROOT, {
        now: new Date("2026-04-24T00:00:00.000Z"),
      })
    ).toEqual([])
    expect(existsSync(malformedPath)).toBe(false)
    const remainingBackgroundFiles = readdirSync(getStateDir()).filter((entry) =>
      entry.startsWith(`background-failure.${configKey(CONFIG_ROOT)}.`)
    )
    expect(remainingBackgroundFiles).toEqual([])
  })

  it("suppresses and prunes unknown marker kinds", async () => {
    const path = backgroundFailureMarkerPath(CONFIG_ROOT, "autosave", {
      projectName: "unknown-kind",
    })
    mkdirSync(getStateDir(), { recursive: true })
    writeFileSync(
      path,
      `${JSON.stringify({
        version: 1,
        kind: "future-kind",
        occurredAt: "2026-04-24T00:00:00.000Z",
        configRootKey: configKey(CONFIG_ROOT),
        code: "future",
        message: "future marker",
      })}\n`
    )

    expect(
      await listBackgroundFailures(CONFIG_ROOT, {
        now: new Date("2026-04-24T00:00:01.000Z"),
      })
    ).toEqual([])
    expect(existsSync(path)).toBe(false)
  })

  it("sorts newest first, applies the render limit, and reports the total", async () => {
    for (const [idx, day] of [20, 21, 22].entries()) {
      recordBackgroundFailure(
        CONFIG_ROOT,
        {
          kind: "autosave",
          projectName: `Project ${idx}`,
          sessionId: `sess-${idx}`,
          code: "spawn-error",
          message: `failure ${idx}`,
        },
        new Date(`2026-04-${day}T00:00:00.000Z`)
      )
    }

    const report = await collectBackgroundFailures(CONFIG_ROOT, {
      now: new Date("2026-04-24T00:00:00.000Z"),
      limit: 2,
    })

    expect(report.totalRecent).toBe(3)
    expect(report.failures.map((m) => m.sessionId)).toEqual(["sess-2", "sess-1"])
  })
})
