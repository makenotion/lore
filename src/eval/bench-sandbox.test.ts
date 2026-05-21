import { describe, expect, it, vi } from "vitest"
import type { Memory } from "../types.js"

const mocks = vi.hoisted(() => ({
  initServices: vi.fn(),
  resolveProjectByName: vi.fn(),
  loadWakeUpData: vi.fn(),
}))

vi.mock("../services.js", () => ({
  initServices: mocks.initServices,
}))

vi.mock("../core/project-scope.js", () => ({
  resolveProjectByName: mocks.resolveProjectByName,
}))

vi.mock("../core/wakeup.js", () => ({
  loadWakeUpData: mocks.loadWakeUpData,
}))

import { buildBenchSandbox } from "./bench-sandbox.js"

function testMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "mem-project",
    title: "Project color",
    projectIds: ["project-1"],
    topicId: null,
    source: "conversation",
    kind: "note",
    status: "informational",
    confidence: "medium",
    confidenceScore: null,
    pinned: null,
    synopsis: "The preferred color is blue.",
    content: "I like blue.",
    createdAt: "2026-05-21T00:00:00.000Z",
    updatedAt: "2026-05-21T00:00:00.000Z",
    scope: { kind: "project", projectIds: ["project-1"], audience: [] },
    ...overrides,
  } as Memory
}

describe("buildBenchSandbox", () => {
  it("filters wake-up prefetch memories to the bench project", async () => {
    const savedSandboxName = process.env["LORE_BENCH_SANDBOX_PROJECT_NAME"]
    process.env["LORE_BENCH_SANDBOX_PROJECT_NAME"] = "Eval Sandbox"
    mocks.initServices.mockResolvedValue({
      authSource: "env-notion-api-token",
      profile: { selector: "default@1.0.0" },
      projects: {},
      memories: {},
      facts: {},
    })
    mocks.resolveProjectByName.mockResolvedValue({
      id: "parent-project",
      name: "Eval Sandbox",
      path: "Eval Sandbox",
    })
    mocks.loadWakeUpData.mockResolvedValue({
      taskMemories: [
        testMemory(),
        testMemory({
          id: "mem-unscoped",
          title: "Unscoped secret",
          projectIds: [],
          content: "This body should not render.",
          scope: {
            kind: "global",
            key: "",
            audience: "",
            lifetime: "persistent",
            expiresAt: null,
          },
        }),
        testMemory({
          id: "mem-other-project",
          title: "Other project secret",
          projectIds: ["project-2"],
          content: "Other project body should not render.",
        }),
      ],
    })

    try {
      const sandbox = await buildBenchSandbox()
      const wakeUp = await sandbox.getWakeUpForQuery({
        projectId: "project-1",
        userQuery: "What color?",
      })

      expect(mocks.loadWakeUpData).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          mode: "task-only",
          projectId: "project-1",
          userQuery: "What color?",
          taskMemoryLimit: 30,
          includeMemoryContent: true,
        })
      )
      expect(wakeUp.surfacedMemoryIds).toEqual(["mem-project"])
      expect(wakeUp.renderedContext).toContain("Project color")
      expect(wakeUp.renderedContext).not.toContain("mem-unscoped")
      expect(wakeUp.renderedContext).not.toContain("This body should not render.")
      expect(wakeUp.renderedContext).not.toContain("mem-other-project")
      expect(wakeUp.renderedContext).not.toContain(
        "Other project body should not render."
      )
    } finally {
      if (savedSandboxName === undefined) {
        delete process.env["LORE_BENCH_SANDBOX_PROJECT_NAME"]
      } else {
        process.env["LORE_BENCH_SANDBOX_PROJECT_NAME"] = savedSandboxName
      }
    }
  })
})
