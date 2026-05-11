import { describe, expect, it, vi } from "vitest"
import { resolveProjectIds, resolveReadProjectScope } from "./resolve.js"
import type { LoreServices } from "../services.js"
import type { Project, LoreConfig, ResolvedContext } from "../types.js"

function makeProject(name: string, id = `proj-${name.toLowerCase()}`): Project {
  return {
    id,
    name,
    path: name === "Repo" ? "." : `path/${name}`,
    type: "project",
    status: "active",
    description: "",
  }
}

const MONOREPO_CONFIG: LoreConfig = {
  vault: { pageId: "v" },
  projects: [
    { name: "Repo", path: "." },
    { name: "Widget Backend", path: "services/widget" },
    { name: "Widget Web", path: "widget-web" },
  ],
}

interface StubOpts {
  contextProject?: Project | null
  isCatchAllFallback?: boolean
  findByName?: Record<string, Project | null>
  transientNames?: string[]
  config?: LoreConfig
}

function makeServices(opts: StubOpts = {}): LoreServices {
  const findByName = vi.fn(async (name: string) => opts.findByName?.[name] ?? null)
  const resolveByName = vi.fn(async (name: string) => {
    if (opts.transientNames?.includes(name)) {
      return {
        kind: "transient-error" as const,
        cause: Object.assign(new Error("rate_limited"), { status: 429 }),
      }
    }
    const project = await findByName(name)
    return project ? { kind: "resolved" as const, project } : { kind: "missing" as const }
  })

  const context: ResolvedContext = {
    vault: { pageId: "v", databases: {} as never },
    project: opts.contextProject ?? null,
    cwd: "/tmp",
    isCatchAllFallback: opts.isCatchAllFallback ?? false,
  }

  return {
    projects: { findByName, resolveByName } as unknown as LoreServices["projects"],
    context,
    config: opts.config ?? MONOREPO_CONFIG,
  } as unknown as LoreServices
}

describe("resolveProjectIds", () => {
  it("returns the ID for an explicit projectName", async () => {
    const backend = makeProject("Widget Backend")
    const services = makeServices({
      findByName: { "Widget Backend": backend },
    })

    const result = await resolveProjectIds(services, "Widget Backend")
    expect(result.ids).toEqual([backend.id])
    expect(result.warnings).toEqual([])
  })

  it("returns IDs for every projectNames entry", async () => {
    const backend = makeProject("Widget Backend")
    const web = makeProject("Widget Web")
    const services = makeServices({
      findByName: { "Widget Backend": backend, "Widget Web": web },
    })

    const result = await resolveProjectIds(services, undefined, [
      "Widget Backend",
      "Widget Web",
    ])
    expect(result.ids).toEqual([backend.id, web.id])
    expect(result.warnings).toEqual([])
  })

  it("throws when an explicit projectName does not resolve", async () => {
    const services = makeServices()

    await expect(resolveProjectIds(services, "Missing")).rejects.toThrow(
      'Project "Missing" could not be resolved (not found, archived, or inaccessible).'
    )
  })

  it("throws a retryable transient error without calling the missing-project path", async () => {
    const services = makeServices({ transientNames: ["Missing"] })

    await expect(resolveProjectIds(services, "Missing")).rejects.toMatchObject({
      code: "transient_project_resolution",
      retryable: true,
    })
    await expect(resolveProjectIds(services, "Missing")).rejects.toThrow(
      /transient error/
    )
  })

  it("throws when an explicit projectName is blank without falling back", async () => {
    const repo = makeProject("Repo")
    const services = makeServices({ contextProject: repo })

    await expect(resolveProjectIds(services, "")).rejects.toThrow(
      'Project "" could not be resolved (not found, archived, or inaccessible).'
    )
    expect(services.projects.findByName).not.toHaveBeenCalled()
  })

  it("throws when every projectNames entry is missing", async () => {
    const services = makeServices()

    await expect(
      resolveProjectIds(services, undefined, ["Missing", "Also Missing"])
    ).rejects.toThrow(
      'Projects "Missing", "Also Missing" could not be resolved (not found, archived, or inaccessible).'
    )
  })

  it("throws when projectNames is explicitly empty without falling back", async () => {
    const repo = makeProject("Repo")
    const services = makeServices({ contextProject: repo })

    await expect(resolveProjectIds(services, undefined, [])).rejects.toThrow(
      'Project "" could not be resolved (not found, archived, or inaccessible).'
    )
    expect(services.projects.findByName).not.toHaveBeenCalled()
  })

  it("throws when any projectNames entry is blank", async () => {
    const backend = makeProject("Widget Backend")
    const services = makeServices({
      contextProject: makeProject("Repo"),
      findByName: { "Widget Backend": backend },
    })

    await expect(
      resolveProjectIds(services, undefined, ["Widget Backend", "  "])
    ).rejects.toThrow(
      'Project "" could not be resolved (not found, archived, or inaccessible).'
    )
    expect(services.projects.findByName).not.toHaveBeenCalled()
  })

  it("throws atomically when a mixed projectNames list has any miss", async () => {
    const backend = makeProject("Widget Backend")
    const services = makeServices({
      findByName: { "Widget Backend": backend },
    })

    await expect(
      resolveProjectIds(services, undefined, ["Widget Backend", "Missing"])
    ).rejects.toThrow(
      'Project "Missing" could not be resolved (not found, archived, or inaccessible).'
    )
  })

  it("treats archived explicit project names as unresolved with useful recovery wording", async () => {
    const services = makeServices({
      findByName: { Archive: null },
    })

    await expect(resolveProjectIds(services, "Archive")).rejects.toThrow(
      /Project "Archive" could not be resolved.*archived.*Fix the project scope/
    )
  })

  it("does not warn when falling back to a sub-project from context", async () => {
    const backend = makeProject("Widget Backend")
    const services = makeServices({
      contextProject: backend,
      isCatchAllFallback: false,
    })

    const result = await resolveProjectIds(services)
    expect(result.ids).toEqual([backend.id])
    expect(result.warnings).toEqual([])
  })

  it("warns with candidate list when falling back to the catch-all", async () => {
    const repo = makeProject("Repo")
    const services = makeServices({
      contextProject: repo,
      isCatchAllFallback: true,
    })

    const result = await resolveProjectIds(services)
    expect(result.ids).toEqual([repo.id])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/catch-all "Repo"/)
    expect(result.warnings[0]).toMatch(/Widget Backend/)
    expect(result.warnings[0]).toMatch(/Widget Web/)
    expect(result.warnings[0]).not.toMatch(/lore-update/)
  })

  it("does not warn on catch-all when no sub-projects are configured", async () => {
    const repo = makeProject("Repo")
    const soloConfig: LoreConfig = {
      vault: { pageId: "v" },
      projects: [{ name: "Repo", path: "." }],
    }
    const services = makeServices({
      contextProject: repo,
      isCatchAllFallback: true,
      config: soloConfig,
    })

    const result = await resolveProjectIds(services)
    expect(result.ids).toEqual([repo.id])
    expect(result.warnings).toEqual([])
  })

  it("does not warn when the agent explicitly picks the catch-all by name", async () => {
    const repo = makeProject("Repo")
    const services = makeServices({
      contextProject: repo,
      isCatchAllFallback: true,
      findByName: { Repo: repo },
    })

    const result = await resolveProjectIds(services, "Repo")
    expect(result.ids).toEqual([repo.id])
    expect(result.warnings).toEqual([])
  })

  it("returns empty ids and no warning when no context project is set", async () => {
    const services = makeServices({ contextProject: null })
    const result = await resolveProjectIds(services)
    expect(result.ids).toEqual([])
    expect(result.warnings).toEqual([])
  })
})

describe("resolveReadProjectScope", () => {
  it("returns an explicit project and disables catch-all fallback", async () => {
    const repo = makeProject("Repo")
    const services = makeServices({
      contextProject: makeProject("Widget Backend"),
      isCatchAllFallback: true,
      findByName: { Repo: repo },
    })

    const result = await resolveReadProjectScope(services, "Repo")
    expect(result).toEqual({
      projectId: repo.id,
      project: repo,
      isCatchAllFallback: false,
    })
  })

  it("throws when an explicit read projectName does not resolve", async () => {
    const services = makeServices({ contextProject: makeProject("Repo") })

    await expect(resolveReadProjectScope(services, "Missing")).rejects.toThrow(
      'Project "Missing" could not be resolved (not found, archived, or inaccessible).'
    )
  })

  it("throws a retryable transient error for read projectName resolution", async () => {
    const services = makeServices({
      contextProject: makeProject("Repo"),
      transientNames: ["Missing"],
    })

    await expect(resolveReadProjectScope(services, "Missing")).rejects.toMatchObject({
      code: "transient_project_resolution",
      retryable: true,
    })
  })

  it("throws when an explicit read projectName is blank without falling back", async () => {
    const services = makeServices({ contextProject: makeProject("Repo") })

    await expect(resolveReadProjectScope(services, " ")).rejects.toThrow(
      'Project "" could not be resolved (not found, archived, or inaccessible).'
    )
    expect(services.projects.findByName).not.toHaveBeenCalled()
  })

  it("falls back to auto-detected context only when projectName is omitted", async () => {
    const repo = makeProject("Repo")
    const services = makeServices({
      contextProject: repo,
      isCatchAllFallback: true,
    })

    const result = await resolveReadProjectScope(services)
    expect(result).toEqual({
      projectId: repo.id,
      project: repo,
      isCatchAllFallback: true,
    })
  })
})
