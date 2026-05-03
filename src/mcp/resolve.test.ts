import { describe, expect, it, vi } from "vitest"
import { resolveProjectIds } from "./resolve.js"
import type { LoreServices } from "../services.js"
import type { Project, LoreConfig, ResolvedContext } from "../types.js"

function makeProject(name: string, id = `proj-${name.toLowerCase()}`): Project {
  return {
    id,
    name,
    path: name === "Mail" ? "." : `path/${name}`,
    type: "project",
    status: "active",
    description: "",
  }
}

const MONOREPO_CONFIG: LoreConfig = {
  vault: { pageId: "v" },
  projects: [
    { name: "Mail", path: "." },
    { name: "Mail Backend", path: "services/mail" },
    { name: "Mail Web", path: "mail-web" },
  ],
}

interface StubOpts {
  contextProject?: Project | null
  isCatchAllFallback?: boolean
  findByName?: Record<string, Project | null>
  config?: LoreConfig
}

function makeServices(opts: StubOpts = {}): LoreServices {
  const findByName = vi.fn(async (name: string) => opts.findByName?.[name] ?? null)

  const context: ResolvedContext = {
    vault: { pageId: "v", databases: {} as never },
    project: opts.contextProject ?? null,
    cwd: "/tmp",
    isCatchAllFallback: opts.isCatchAllFallback ?? false,
  }

  return {
    projects: { findByName } as unknown as LoreServices["projects"],
    context,
    config: opts.config ?? MONOREPO_CONFIG,
  } as unknown as LoreServices
}

describe("resolveProjectIds", () => {
  it("returns the ID for an explicit projectName", async () => {
    const backend = makeProject("Mail Backend")
    const services = makeServices({
      findByName: { "Mail Backend": backend },
    })

    const result = await resolveProjectIds(services, "Mail Backend")
    expect(result.ids).toEqual([backend.id])
    expect(result.warnings).toEqual([])
  })

  it("returns IDs for every projectNames entry", async () => {
    const backend = makeProject("Mail Backend")
    const web = makeProject("Mail Web")
    const services = makeServices({
      findByName: { "Mail Backend": backend, "Mail Web": web },
    })

    const result = await resolveProjectIds(services, undefined, ["Mail Backend", "Mail Web"])
    expect(result.ids).toEqual([backend.id, web.id])
    expect(result.warnings).toEqual([])
  })

  it("warns for any name that does not resolve", async () => {
    const backend = makeProject("Mail Backend")
    const services = makeServices({
      findByName: { "Mail Backend": backend },
    })

    const result = await resolveProjectIds(services, undefined, ["Mail Backend", "Missing"])
    expect(result.ids).toEqual([backend.id])
    expect(result.warnings).toContain(`Project "Missing" not found`)
  })

  it("treats archived explicit project names as not found", async () => {
    const services = makeServices({
      findByName: { Archive: null },
    })

    const result = await resolveProjectIds(services, "Archive")

    expect(result.ids).toEqual([])
    expect(result.warnings).toEqual([`Project "Archive" not found`])
  })

  it("does not warn when falling back to a sub-project from context", async () => {
    const backend = makeProject("Mail Backend")
    const services = makeServices({
      contextProject: backend,
      isCatchAllFallback: false,
    })

    const result = await resolveProjectIds(services)
    expect(result.ids).toEqual([backend.id])
    expect(result.warnings).toEqual([])
  })

  it("warns with candidate list when falling back to the catch-all", async () => {
    const mail = makeProject("Mail")
    const services = makeServices({
      contextProject: mail,
      isCatchAllFallback: true,
    })

    const result = await resolveProjectIds(services)
    expect(result.ids).toEqual([mail.id])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatch(/catch-all "Mail"/)
    expect(result.warnings[0]).toMatch(/Mail Backend/)
    expect(result.warnings[0]).toMatch(/Mail Web/)
    expect(result.warnings[0]).not.toMatch(/lore-update/)
  })

  it("does not warn on catch-all when no sub-projects are configured", async () => {
    const mail = makeProject("Mail")
    const soloConfig: LoreConfig = {
      vault: { pageId: "v" },
      projects: [{ name: "Mail", path: "." }],
    }
    const services = makeServices({
      contextProject: mail,
      isCatchAllFallback: true,
      config: soloConfig,
    })

    const result = await resolveProjectIds(services)
    expect(result.ids).toEqual([mail.id])
    expect(result.warnings).toEqual([])
  })

  it("does not warn when the agent explicitly picks the catch-all by name", async () => {
    const mail = makeProject("Mail")
    const services = makeServices({
      contextProject: mail,
      isCatchAllFallback: true,
      findByName: { Mail: mail },
    })

    const result = await resolveProjectIds(services, "Mail")
    expect(result.ids).toEqual([mail.id])
    expect(result.warnings).toEqual([])
  })

  it("returns empty ids and no warning when no context project is set", async () => {
    const services = makeServices({ contextProject: null })
    const result = await resolveProjectIds(services)
    expect(result.ids).toEqual([])
    expect(result.warnings).toEqual([])
  })
})
