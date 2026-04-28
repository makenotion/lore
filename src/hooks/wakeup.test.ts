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

import { wakeup } from "./helpers.js"
import type { Project } from "../types.js"

// Tests use the full `Project` type from production rather than a
// hand-rolled shape so the fixture stays in lockstep with the type. If
// `Project` ever grows a required field (or renames one), these tests
// fail at compile time instead of silently shipping a divergent shape.
function setupMocks(opts: {
  project: Project | null
  isCatchAllFallback: boolean
  configProjects: Array<{ name: string; path: string }>
}): void {
  findConfigFileMock.mockResolvedValue({
    path: "/tmp/.lore.yaml",
    root: "/tmp",
  })
  loadConfigMock.mockResolvedValue({
    config: {
      vault: { pageId: "v1" },
      projects: opts.configProjects,
      hooks: { wakeUp: true, autoSave: true, autoDigest: true, saveInterval: 5 },
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
    tasks: [],
    knowledgeFacts: [],
    relatedMemories: [],
    taskMemories: [],
  })
}

describe("hooks/wakeup — project framing block (issue 0.6.0/18)", () => {
  let stdout: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    stdout = vi.spyOn(console, "log").mockImplementation(() => {})
  })

  afterEach(() => {
    stdout.mockRestore()
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
})
