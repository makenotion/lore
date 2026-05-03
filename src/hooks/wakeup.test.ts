/**
 * Shell wake-up hook tests for the project framing block (issue 0.6.0/18).
 *
 * Lives in its own file so the heavy `../config.js` / `../services.js`
 * module mocks don't leak into `helpers.test.ts` (which exercises the
 * autosave + session-end paths against the real loaders). Acceptance
 * criterion: the hook always reads `services.context.project` /
 * `.isCatchAllFallback` — no explicit-override surface — and renders
 * the same block as the MCP wake-up surface via the shared renderer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const { findConfigFileMock, loadConfigMock, initServicesMock, loadWakeUpDataMock } =
  vi.hoisted(() => ({
    findConfigFileMock: vi.fn(),
    loadConfigMock: vi.fn(),
    initServicesMock: vi.fn(),
    loadWakeUpDataMock: vi.fn(),
  }))

vi.mock("../config.js", async () => {
  const actual = await vi.importActual<typeof import("../config.js")>("../config.js")
  return {
    ...actual,
    findConfigFile: findConfigFileMock,
    loadConfigAllowingInvalidHooks: loadConfigMock,
  }
})

vi.mock("../services.js", async () => {
  const actual = await vi.importActual<typeof import("../services.js")>("../services.js")
  return {
    ...actual,
    initServicesFromConfig: initServicesMock,
  }
})

vi.mock("../core/wakeup.js", async () => {
  const actual = await vi.importActual<typeof import("../core/wakeup.js")>(
    "../core/wakeup.js",
  )
  return {
    ...actual,
    loadWakeUpData: loadWakeUpDataMock,
  }
})

import { wakeup, wakeupStatePath } from "./helpers.js"
import type { Project, TaskSummary } from "../types.js"
import {
  buildEmptyWakeUpCoverage,
  type WakeUpCoverageMetrics,
} from "../core/wakeup.js"

function makeTask(overrides: Partial<TaskSummary> & { id: string }): TaskSummary {
  const base: TaskSummary = {
    id: overrides.id,
    title: overrides.title ?? `Task ${overrides.id}`,
    projectIds: [],
    topicId: null,
    source: "manual",
    kind: "task",
    status: "informational",
    confidence: "certain",
    confidenceScore: null,
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
    lastReferencedAt: null,
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "",
    agent: "",
    tags: [],
    keywords: "",
    synopsis: "",
    session: "",
    taskState: "open",
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    createdAt: "2026-04-20T00:00:00Z",
    updatedAt: "2026-04-20T00:00:00Z",
  }
  return { ...base, ...overrides }
}

// Tests use the full `Project` type from production rather than a
// hand-rolled shape so the fixture stays in lockstep with the type. If
// `Project` ever grows a required field (or renames one), these tests
// fail at compile time instead of silently shipping a divergent shape.
function setupMocks(opts: {
  project: Project | null
  isCatchAllFallback: boolean
  configProjects: Array<{ name: string; path: string }>
  tasks?: TaskSummary[]
  wakeUp?: boolean
  coverage?: WakeUpCoverageMetrics
}): void {
  findConfigFileMock.mockResolvedValue({
    path: "/tmp/.lore.yaml",
    root: "/tmp",
  })
  loadConfigMock.mockResolvedValue({
    config: {
      vault: { pageId: "v1" },
      projects: opts.configProjects,
      hooks: {
        wakeUp: opts.wakeUp ?? true,
        autoSave: true,
        autoDigest: true,
        saveInterval: 5,
      },
    },
    warnings: [],
  })
  initServicesMock.mockResolvedValue({
    context: {
      project: opts.project,
      isCatchAllFallback: opts.isCatchAllFallback,
    },
  })
  // Empty wake-up data — the framing block sits above the data sections,
  // so it surfaces at the top of stdout regardless of what the data layer
  // returns. Empty data also keeps the assertion grep narrow to the block.
  loadWakeUpDataMock.mockResolvedValue({
    digest: null,
    memories: [],
    tasks: opts.tasks ?? [],
    taskBucketCoverage: {
      overdueCapped: false,
      staleCapped: false,
      activeCapped: false,
    },
    knowledgeFacts: [],
    relatedMemories: [],
    taskMemories: [],
    staleConfidence: [],
    coverage: opts.coverage ?? buildEmptyWakeUpCoverage({
      sectionCounts: { tasks: opts.tasks?.length ?? 0 },
    }),
  })
}

describe("hooks/wakeup — project framing block (issue 0.6.0/18)", () => {
  let stdout: ReturnType<typeof vi.spyOn>
  let stateDir: string
  const savedStateDir = process.env["LORE_HOOK_STATE_DIR"]
  const savedDebug = process.env["LORE_DEBUG"]

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "lore-wakeup-test-"))
    process.env["LORE_HOOK_STATE_DIR"] = stateDir
    stdout = vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    stdout.mockRestore()
    rmSync(stateDir, { recursive: true, force: true })
    if (savedStateDir === undefined) {
      delete process.env["LORE_HOOK_STATE_DIR"]
    } else {
      process.env["LORE_HOOK_STATE_DIR"] = savedStateDir
    }
    if (savedDebug === undefined) {
      delete process.env["LORE_DEBUG"]
    } else {
      process.env["LORE_DEBUG"] = savedDebug
    }
    vi.clearAllMocks()
  })

  it("renders the project framing block at the top of wake-up output", async () => {
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "Notion-backed mail client.",
      },
      isCatchAllFallback: false,
      configProjects: [
        { name: "Mail", path: "apps/mail" },
        { name: "Web", path: "apps/web" },
      ],
    })

    await wakeup()

    expect(stdout).toHaveBeenCalledTimes(1)
    const written = String(stdout.mock.calls[0][0])
    expect(written).toContain("Project: Mail (apps/mail)")
    expect(written).toContain("  Notion-backed mail client.")
    // Siblings names *peers* — Mail is excluded as the resolved project.
    expect(written).toContain("  Siblings: Web.")
  })

  it("prepends a catch-all warning when isCatchAllFallback is true", async () => {
    setupMocks({
      project: {
        id: "proj-mono",
        name: "Monorepo",
        type: "project",
        path: ".",
        status: "active",
        description: "Whole repo.",
      },
      isCatchAllFallback: true,
      configProjects: [
        { name: "Monorepo", path: "." },
        { name: "Mail", path: "apps/mail" },
        { name: "Web", path: "apps/web" },
      ],
    })

    await wakeup()

    expect(stdout).toHaveBeenCalledTimes(1)
    const written = String(stdout.mock.calls[0][0])
    // Lead-in mirrors the save-side wording byte-for-byte (shared via
    // `formatCatchAllScopeSummary` in `src/core/context.ts`).
    expect(written).toContain(
      '> Scoped to catch-all "Monorepo" (monorepo-wide). Sub-projects available: Mail, Web. Pass projectName to scope to a specific sub-project.',
    )
  })

  it("reads services.context.project + isCatchAllFallback (no explicit override on this surface)", async () => {
    // Acceptance criterion: the hook has no projectName argument. It
    // always describes services.context.project and reflects
    // services.context.isCatchAllFallback verbatim. This test pins
    // that wiring by varying the context fields and watching the
    // output respond.
    setupMocks({
      project: {
        id: "proj-web",
        name: "Web",
        type: "project",
        path: "apps/web",
        status: "active",
        description: "Marketing site.",
      },
      isCatchAllFallback: false,
      configProjects: [
        { name: "Mail", path: "apps/mail" },
        { name: "Web", path: "apps/web" },
      ],
    })

    await wakeup()

    const written = String(stdout.mock.calls[0][0])
    expect(written).toContain("Project: Web (apps/web)")
    expect(written).toContain("  Marketing site.")
    expect(written).not.toContain("Mail (apps/mail)")
  })

  it("omits the description line when Project.description is empty", async () => {
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })

    await wakeup()

    const written = String(stdout.mock.calls[0][0])
    expect(written).toContain("Project: Mail (apps/mail)")
    // No description filler line beneath the header.
    expect(written).not.toMatch(/^ {2}Notion/m)
  })

  it("renders no framing block when no project resolved (vault-wide scope)", async () => {
    setupMocks({
      project: null,
      isCatchAllFallback: false,
      configProjects: [],
    })

    await wakeup()

    // With no project AND no other sections, wakeup() emits nothing —
    // sections.length === 0 so the `# Lore Context` header is also
    // skipped. This pins the "no synthetic content for missing data"
    // contract.
    expect(stdout).not.toHaveBeenCalled()
  })

  it("emits privacy-conscious coverage counters when LORE_DEBUG=1", async () => {
    process.env["LORE_DEBUG"] = "1"
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)

    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
      tasks: [makeTask({ id: "task-1" }), makeTask({ id: "task-2" })],
      coverage: buildEmptyWakeUpCoverage({
        mode: "ranked",
        queryLength: 24,
        digest: { available: true, fresh: true, ageDays: 1 },
        sectionCounts: {
          digest: 1,
          currentTaskMemories: 2,
          recentMemories: 3,
          relatedMemories: 1,
          tasks: 2,
          knowledgeFacts: 5,
        },
      }),
    })

    try {
      await wakeup({
        event: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          prompt: "Fix retrieval metrics",
        }),
      })

      const logLine = String(stderr.mock.calls.find((call) =>
        String(call[0]).startsWith("[lore] wakeup:"),
      )?.[0])
      expect(logLine).toContain("mode=ranked")
      expect(logLine).toContain("ranked=true")
      expect(logLine).toContain("memory=3")
      expect(logLine).toContain("sections.currentTask=2")
      expect(logLine).toContain("sections.facts=5")
      expect(logLine).toContain("sections.tasks=2")
      expect(logLine).toContain("digestAgeDays=1")
      expect(logLine).not.toContain("Fix retrieval metrics")
      expect(logLine).not.toContain("Task task-1")
      expect(loadWakeUpDataMock.mock.calls[0][1]).toMatchObject({
        includeCoverage: true,
      })
    } finally {
      stderr.mockRestore()
    }
  })

  it("includes the default mode in unranked wake-up debug counters", async () => {
    process.env["LORE_DEBUG"] = "1"
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)

    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })

    try {
      await wakeup({
        event: JSON.stringify({
          hook_event_name: "SessionStart",
          session_id: "debug-default",
        }),
      })

      const logLine = String(stderr.mock.calls.find((call) =>
        String(call[0]).startsWith("[lore] wakeup:"),
      )?.[0])
      expect(logLine).toContain("mode=default")
      expect(logLine).toContain("ranked=false")
      expect(logLine).toContain("reason=no-ranked-search")
    } finally {
      stderr.mockRestore()
    }
  })

  it("emits the cache-hit coverage variant through the shared formatter", async () => {
    process.env["LORE_DEBUG"] = "1"
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)

    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })
    const event = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "debug-cache-hit",
      prompt: "Fix retrieval metrics",
    })

    try {
      await wakeup({ event })
      await wakeup({ event })

      const logLines = stderr.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith("[lore] wakeup:"))
      expect(logLines).toContainEqual(
        expect.stringContaining("reason=already-ranked-for-session"),
      )
      expect(logLines).toContainEqual(expect.stringContaining("mode=default"))
      expect(logLines).toContainEqual(expect.stringContaining("ranked=false"))
      expect(logLines).toContainEqual(
        expect.stringContaining("digestAvailable=false"),
      )
      expect(loadWakeUpDataMock).toHaveBeenCalledTimes(1)
    } finally {
      stderr.mockRestore()
    }
  })

  it("emits an error coverage variant when wake-up loading fails", async () => {
    process.env["LORE_DEBUG"] = "1"
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })
    loadWakeUpDataMock.mockRejectedValueOnce(new Error("notion down"))

    try {
      await wakeup({
        event: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "debug-load-failed",
          prompt: "Fix retrieval metrics",
        }),
      })

      const logLines = stderr.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith("[lore] wakeup:"))
      expect(logLines).toContainEqual(expect.stringContaining("mode=error"))
      expect(logLines).toContainEqual(expect.stringContaining("reason=load-failed"))
      expect(logLines).toContainEqual(expect.stringContaining("load failed"))
    } finally {
      stderr.mockRestore()
    }
  })

  it("does not crash when coverage is unexpectedly null under debug logging", async () => {
    process.env["LORE_DEBUG"] = "1"
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })
    loadWakeUpDataMock.mockResolvedValueOnce({
      digest: null,
      memories: [],
      tasks: [],
      taskBucketCoverage: {
        overdueCapped: false,
        staleCapped: false,
        activeCapped: false,
      },
      knowledgeFacts: [],
      relatedMemories: [],
      taskMemories: [],
      staleConfidence: [],
      coverage: null,
    })

    try {
      await wakeup({
        event: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "debug-null-coverage",
          prompt: "Fix retrieval metrics",
        }),
      })

      const coverageLines = stderr.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.startsWith("[lore] wakeup: mode="))
      expect(coverageLines).toEqual([])
    } finally {
      stderr.mockRestore()
    }
  })

  it("does not emit wake-up coverage counters when LORE_DEBUG is unset", async () => {
    delete process.env["LORE_DEBUG"]
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)

    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })

    try {
      await wakeup({
        event: JSON.stringify({
          hook_event_name: "UserPromptSubmit",
          session_id: "debug-off",
          prompt: "Fix retrieval metrics",
        }),
      })

      expect(stderr.mock.calls.length).toBe(0)
      expect(loadWakeUpDataMock.mock.calls[0][1]).toMatchObject({
        includeCoverage: false,
      })
    } finally {
      stderr.mockRestore()
    }
  })

  it("renders a fair task subset when overdue rows dominate the wake-up window", async () => {
    function daysAgo(n: number): string {
      return new Date(Date.now() - n * 86_400_000).toISOString()
    }
    function daysAgoDate(n: number): string {
      return daysAgo(n).split("T")[0]
    }

    const tasks: TaskSummary[] = []
    for (let i = 0; i < 12; i++) {
      tasks.push(
        makeTask({
          id: `overdue-${i}`,
          title: `Overdue task ${i}`,
          reviewBy: daysAgoDate(7 + i),
          updatedAt: daysAgo(2),
        }),
      )
    }
    tasks.push(
      makeTask({
        id: "stale-1",
        title: "Null-date stale task",
        reviewBy: null,
        updatedAt: daysAgo(45),
      }),
    )
    tasks.push(
      makeTask({
        id: "active-1",
        title: "Null-date active task",
        reviewBy: null,
        updatedAt: daysAgo(2),
      }),
    )

    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
      tasks,
    })

    await wakeup()

    expect(stdout).toHaveBeenCalledTimes(1)
    const written = String(stdout.mock.calls[0][0])
    expect(written).toContain("Null-date stale task")
    expect(written).toContain("Null-date active task")
    expect(written).toContain("Overdue task 0")
    expect(written).toContain("Overdue task 7")
    expect(written).not.toContain("Overdue task 8")

    const firstOverdue = written.indexOf("- Overdue task 0")
    const stale = written.indexOf("- Null-date stale task")
    const active = written.indexOf("- Null-date active task")
    expect(firstOverdue).toBeGreaterThan(-1)
    expect(stale).toBeGreaterThan(firstOverdue)
    expect(active).toBeGreaterThan(stale)
  })

  it("uses Codex UserPromptSubmit prompt as the ranked wake-up query", async () => {
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })

    await wakeup({
      event: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-ranked",
        turn_id: "turn-1",
        prompt: "Make Codex wake-up query-aware",
        cwd: "/tmp",
      }),
    })

    expect(loadWakeUpDataMock).toHaveBeenCalledTimes(1)
    expect(loadWakeUpDataMock.mock.calls[0][1]).toMatchObject({
      userQuery: "Make Codex wake-up query-aware",
      memoryLimit: 3,
      relatedMemoryLimit: 2,
      knowledgeFactLimit: 10,
      taskMemoryLimit: 3,
    })
  })

  it("debounces repeated Codex UserPromptSubmit wake-up for the same session", async () => {
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })
    const event = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-debounce",
      turn_id: "turn-1",
      prompt: "Make Codex wake-up query-aware",
      cwd: "/tmp",
    })

    await wakeup({ event })
    await wakeup({ event })

    expect(loadWakeUpDataMock).toHaveBeenCalledTimes(1)
    expect(stdout).toHaveBeenCalledTimes(1)
  })

  it("allows a Codex UserPromptSubmit without a session id without writing a wake-up marker", async () => {
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })

    await wakeup({
      event: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        turn_id: "turn-1",
        prompt: "Make Codex wake-up query-aware",
        cwd: "/tmp",
      }),
    })

    expect(loadWakeUpDataMock).toHaveBeenCalledTimes(1)
    expect(stdout).toHaveBeenCalledTimes(1)
    expect(readdirSync(stateDir).filter((entry) => entry.endsWith(".wakeup"))).toEqual(
      [],
    )
  })

  it("debounces later slash-command Codex prompts after ranked wake-up has run", async () => {
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })

    await wakeup({
      event: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-slash-debounce",
        turn_id: "turn-1",
        prompt: "Make Codex wake-up query-aware",
        cwd: "/tmp",
      }),
    })
    await wakeup({
      event: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-slash-debounce",
        turn_id: "turn-2",
        prompt: "/clear",
        cwd: "/tmp",
      }),
    })

    expect(loadWakeUpDataMock).toHaveBeenCalledTimes(1)
    expect(stdout).toHaveBeenCalledTimes(1)
  })

  it("debounces slash-command first Codex prompts before later ranked prompts", async () => {
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })

    await wakeup({
      event: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-slash-first",
        turn_id: "turn-1",
        prompt: "/clear",
        cwd: "/tmp",
      }),
    })
    await wakeup({
      event: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-slash-first",
        turn_id: "turn-2",
        prompt: "Make Codex wake-up query-aware",
        cwd: "/tmp",
      }),
    })

    expect(loadWakeUpDataMock).toHaveBeenCalledTimes(1)
    expect(loadWakeUpDataMock.mock.calls[0][1]).toMatchObject({
      userQuery: undefined,
    })
    expect(stdout).toHaveBeenCalledTimes(1)
  })

  it("records the wake-up attempt before load failures so later prompts skip", async () => {
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })
    loadWakeUpDataMock.mockRejectedValueOnce(new Error("notion down"))
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const event = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-load-failure",
      turn_id: "turn-1",
      prompt: "Make Codex wake-up query-aware",
      cwd: "/tmp",
    })

    try {
      await wakeup({ event })
      await wakeup({ event })

      expect(loadWakeUpDataMock).toHaveBeenCalledTimes(1)
      expect(initServicesMock).toHaveBeenCalledTimes(1)
      expect(stdout).not.toHaveBeenCalled()
      expect(existsSync(wakeupStatePath("codex-load-failure"))).toBe(true)
      expect(String(stderr.mock.calls[0]?.[0])).toContain("load failed")
    } finally {
      stderr.mockRestore()
    }
  })

  it("skips a same-process Codex prompt after the marker write hits EEXIST", async () => {
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
    })
    const event = JSON.stringify({
      hook_event_name: "UserPromptSubmit",
      session_id: "codex-concurrent",
      turn_id: "turn-1",
      prompt: "Make Codex wake-up query-aware",
      cwd: "/tmp",
    })

    // This same-process Promise.all pins the EEXIST branch: one await creates
    // the marker, and the second observes it. Cross-process atomicity comes
    // from the filesystem's O_EXCL create-if-absent contract, not JS scheduling.
    await Promise.all([wakeup({ event }), wakeup({ event })])

    expect(loadWakeUpDataMock).toHaveBeenCalledTimes(1)
    expect(stdout).toHaveBeenCalledTimes(1)
  })

  it("honors hooks.wakeUp false before writing a debounce marker", async () => {
    setupMocks({
      project: {
        id: "proj-mail",
        name: "Mail",
        type: "project",
        path: "apps/mail",
        status: "active",
        description: "",
      },
      isCatchAllFallback: false,
      configProjects: [{ name: "Mail", path: "apps/mail" }],
      wakeUp: false,
    })

    await wakeup({
      event: JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "codex-wakeup-disabled",
        turn_id: "turn-1",
        prompt: "Make Codex wake-up query-aware",
        cwd: "/tmp",
      }),
    })

    expect(initServicesMock).not.toHaveBeenCalled()
    expect(loadWakeUpDataMock).not.toHaveBeenCalled()
    expect(existsSync(wakeupStatePath("codex-wakeup-disabled"))).toBe(false)
  })
})
