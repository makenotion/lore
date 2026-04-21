import { describe, expect, it, vi } from "vitest"
import {
  catchAllProjectName,
  isCatchAllProject,
  resolveProject,
  subProjectNames,
} from "./context.js"
import type { LoreConfig, Project } from "../types.js"
import type { ProjectService } from "./project.js"

/**
 * Minimal ProjectService stub — resolveProject only calls findByPath and
 * findByName, so everything else can stay unimplemented.
 */
function makeProjectService(
  overrides: Partial<Pick<ProjectService, "findByPath" | "findByName">>,
): ProjectService {
  return {
    findByPath: overrides.findByPath ?? vi.fn().mockResolvedValue(null),
    findByName: overrides.findByName ?? vi.fn().mockResolvedValue(null),
  } as unknown as ProjectService
}

function makeProject(name: string, path: string): Project {
  return {
    id: `proj-${name.toLowerCase().replace(/\s+/g, "-")}`,
    name,
    path,
    type: "project",
    status: "active",
    description: "",
  }
}

const MONOREPO_CONFIG: LoreConfig = {
  vault: { pageId: "vault-id" },
  projects: [
    { name: "Mail", path: "." },
    { name: "Mail Backend", path: "services/mail" },
    { name: "Mail Web", path: "mail-web" },
    { name: "Router", path: "services/router" },
  ],
}

describe("isCatchAllProject", () => {
  it("treats path '.' as catch-all", () => {
    expect(isCatchAllProject({ name: "Mail", path: "." })).toBe(true)
  })

  it("treats empty path as catch-all", () => {
    expect(isCatchAllProject({ name: "Mail", path: "" })).toBe(true)
  })

  it("treats a leading-slash root as catch-all", () => {
    expect(isCatchAllProject({ name: "Mail", path: "/" })).toBe(true)
  })

  it("does not treat sub-project paths as catch-all", () => {
    expect(isCatchAllProject({ name: "Mail Backend", path: "services/mail" })).toBe(false)
  })
})

describe("subProjectNames", () => {
  it("excludes the catch-all and preserves declaration order", () => {
    expect(subProjectNames(MONOREPO_CONFIG)).toEqual(["Mail Backend", "Mail Web", "Router"])
  })

  it("returns empty array when config has no projects", () => {
    expect(subProjectNames({ vault: { pageId: "v" } })).toEqual([])
  })
})

describe("catchAllProjectName", () => {
  it("returns the name of the catch-all when one is configured", () => {
    expect(catchAllProjectName(MONOREPO_CONFIG)).toBe("Mail")
  })

  it("returns null when no catch-all is configured", () => {
    const noCatchAll: LoreConfig = {
      vault: { pageId: "v" },
      projects: [{ name: "Backend", path: "services/api" }],
    }
    expect(catchAllProjectName(noCatchAll)).toBeNull()
  })
})

describe("resolveProject", () => {
  const configRoot = "/home/user/monorepo"

  it("resolves to a sub-project when cwd sits under its path", async () => {
    const backend = makeProject("Mail Backend", "services/mail")
    const projects = makeProjectService({
      findByPath: vi.fn(async (path) => (path === "services/mail" ? backend : null)),
    })

    const result = await resolveProject(
      `${configRoot}/services/mail/graphql`,
      configRoot,
      MONOREPO_CONFIG,
      projects,
    )

    expect(result.project).toEqual(backend)
    expect(result.isCatchAllFallback).toBe(false)
    expect(result.candidates).toContain("Mail Backend")
  })

  it("prefers the longest-prefix sub-project over the catch-all", async () => {
    const router = makeProject("Router", "services/router")
    const findByPath = vi.fn(async (path) => (path === "services/router" ? router : null))
    const projects = makeProjectService({ findByPath })

    const result = await resolveProject(
      `${configRoot}/services/router/cmd`,
      configRoot,
      MONOREPO_CONFIG,
      projects,
    )

    expect(result.project).toEqual(router)
    expect(result.isCatchAllFallback).toBe(false)
  })

  it("falls back to the catch-all when cwd is the monorepo root", async () => {
    const mail = makeProject("Mail", ".")
    const findByPath = vi.fn(async (path) => (path === "." ? mail : null))
    const projects = makeProjectService({ findByPath })

    const result = await resolveProject(configRoot, configRoot, MONOREPO_CONFIG, projects)

    expect(result.project).toEqual(mail)
    expect(result.isCatchAllFallback).toBe(true)
    expect(result.candidates).toEqual(["Mail Backend", "Mail Web", "Router"])
  })

  it("falls back to the catch-all when cwd is in an uncovered subdir", async () => {
    const mail = makeProject("Mail", ".")
    const findByPath = vi.fn(async (path) => (path === "." ? mail : null))
    const projects = makeProjectService({ findByPath })

    const result = await resolveProject(
      `${configRoot}/scripts/release`,
      configRoot,
      MONOREPO_CONFIG,
      projects,
    )

    expect(result.isCatchAllFallback).toBe(true)
  })

  it("returns null when cwd escapes the config root", async () => {
    const projects = makeProjectService({})
    const result = await resolveProject("/tmp/other", configRoot, MONOREPO_CONFIG, projects)
    expect(result.project).toBeNull()
    expect(result.isCatchAllFallback).toBe(false)
  })

  it("returns null when no projects are configured", async () => {
    const projects = makeProjectService({})
    const result = await resolveProject(
      configRoot,
      configRoot,
      { vault: { pageId: "v" } },
      projects,
    )
    expect(result.project).toBeNull()
    expect(result.isCatchAllFallback).toBe(false)
    expect(result.candidates).toEqual([])
  })

  it("falls back from findByPath to findByName when path lookup misses", async () => {
    const mail = makeProject("Mail", ".")
    const projects = makeProjectService({
      findByPath: vi.fn().mockResolvedValue(null),
      findByName: vi.fn(async (name) => (name === "Mail" ? mail : null)),
    })

    const result = await resolveProject(configRoot, configRoot, MONOREPO_CONFIG, projects)
    expect(result.project).toEqual(mail)
  })
})
