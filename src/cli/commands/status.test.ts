import { describe, expect, it, vi } from "vitest"
import {
  formatDigestStatus,
  groupLatestDigestByProject,
  loadDigestStatus,
  type DigestStatusReport,
} from "./status.js"
import type { LoreServices } from "../../services.js"
import type { LoreConfig, Memory, Project } from "../../types.js"

function makeMemory(overrides: Partial<Memory>): Memory {
  return {
    id: "m-" + Math.random().toString(36).slice(2),
    title: "Untitled",
    projectIds: [],
    topicId: null,
    source: "digest",
    kind: "note",
    status: "informational",
    confidence: "certain",
    reviewBy: null,
    decidedAt: null,
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "",
    agent: "",
    tags: [],
    keywords: "",
    session: "",
    content: "",
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    ...overrides,
  }
}

function makeProject(name: string, overrides: Partial<Project> = {}): Project {
  return {
    id: `proj-${name}`,
    name,
    path: name,
    type: "project",
    status: "active",
    description: "",
    ...overrides,
  }
}

function makeServices(opts: {
  config: LoreConfig
  digestMemories?: Memory[]
  projects?: Project[]
}): LoreServices {
  const projectsByName = new Map((opts.projects ?? []).map((p) => [p.name, p]))
  return {
    config: opts.config,
    configRoot: "/repo",
    memories: {
      async list(args: {
        source?: string
        limit?: number
        includeContent?: boolean
      }): Promise<{ items: Memory[] }> {
        if (args.source !== "digest") return { items: [] }
        return { items: opts.digestMemories ?? [] }
      },
    },
    projects: {
      async findByName(name: string): Promise<Project | null> {
        return projectsByName.get(name) ?? null
      },
    },
  } as unknown as LoreServices
}

describe("groupLatestDigestByProject", () => {
  it("keeps the most recent memory per project ID", () => {
    const older = makeMemory({
      id: "older",
      projectIds: ["p-a"],
      createdAt: "2026-04-10T00:00:00.000Z",
    })
    const newer = makeMemory({
      id: "newer",
      projectIds: ["p-a"],
      createdAt: "2026-04-20T00:00:00.000Z",
    })

    const grouped = groupLatestDigestByProject([older, newer])
    expect(grouped.get("p-a")?.id).toBe("newer")
  })

  it("fans a multi-project digest out to every linked project ID", () => {
    const shared = makeMemory({
      id: "shared",
      projectIds: ["p-a", "p-b"],
    })

    const grouped = groupLatestDigestByProject([shared])
    expect(grouped.get("p-a")?.id).toBe("shared")
    expect(grouped.get("p-b")?.id).toBe("shared")
  })

  it("buckets unscoped digests under the empty-string key without throwing", () => {
    const orphan = makeMemory({ id: "orphan", projectIds: [] })
    const grouped = groupLatestDigestByProject([orphan])
    expect(grouped.get("")?.id).toBe("orphan")
  })
})

describe("formatDigestStatus", () => {
  it("returns no lines when there are no rows so the section is suppressed", () => {
    const report: DigestStatusReport = {
      disabledReason: null,
      rows: [],
      truncated: false,
    }
    expect(formatDigestStatus(report)).toEqual([])
  })

  it("renders the plain header when auto-digest is enabled", () => {
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: false,
      rows: [{ name: "Mail", lastDigest: null, markerAgeDays: null }],
    }
    expect(formatDigestStatus(report)[0]).toBe("Digests:")
  })

  it("surfaces the env kill-switch in the section header", () => {
    const report: DigestStatusReport = {
      disabledReason: { source: "env", detail: "LORE_AUTO_DIGEST=false" },
      truncated: false,
      rows: [{ name: "Mail", lastDigest: null, markerAgeDays: null }],
    }
    expect(formatDigestStatus(report)[0]).toBe(
      "Digests (autoDigest=false via LORE_AUTO_DIGEST=false):",
    )
  })

  it("surfaces the config kill-switch in the section header", () => {
    const report: DigestStatusReport = {
      disabledReason: { source: "config", detail: "hooks.autoDigest: false" },
      truncated: false,
      rows: [{ name: "Mail", lastDigest: null, markerAgeDays: null }],
    }
    expect(formatDigestStatus(report)[0]).toBe(
      "Digests (autoDigest=false via hooks.autoDigest: false):",
    )
  })

  it("renders a missing-marker row as 'next fire on next session-end'", () => {
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: false,
      rows: [{ name: "Mail Web", lastDigest: null, markerAgeDays: null }],
    }
    const [, row] = formatDigestStatus(report)
    expect(row).toContain("no digest yet")
    expect(row).toContain("marker missing")
    expect(row).toContain("next fire on next session-end")
  })

  it("computes a fresh marker's remaining time as ceil(stale_days - age)", () => {
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: false,
      rows: [
        {
          name: "Mail Backend",
          lastDigest: { date: "2026-04-12", daysAgo: 13 },
          markerAgeDays: 5,
        },
      ],
    }
    const [, row] = formatDigestStatus(report)
    expect(row).toContain("last digest 2026-04-12 (13d ago)")
    expect(row).toContain("marker 5d old")
    expect(row).toContain("next fire ~2d")
  })

  it("treats markers older than the freshness window as 'next fire on next session-end'", () => {
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: false,
      rows: [
        {
          name: "Router",
          lastDigest: { date: "2026-04-15", daysAgo: 10 },
          markerAgeDays: 9,
        },
      ],
    }
    const [, row] = formatDigestStatus(report)
    expect(row).toContain("marker 9d old")
    expect(row).toContain("next fire on next session-end")
  })

  it("treats a marker exactly at the freshness boundary as 'fire on next session-end'", () => {
    // markerAgeDays === DIGEST_STALE_DAYS (7) puts `remaining` at 0, which
    // matches the scheduler's `markerAge >= DIGEST_STALE_DAYS` semantic —
    // the next session-end re-fires synthesis.
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: false,
      rows: [
        { name: "Edge", lastDigest: null, markerAgeDays: 7 },
      ],
    }
    const [, row] = formatDigestStatus(report)
    expect(row).toContain("marker 7d old")
    expect(row).toContain("next fire on next session-end")
  })

  it("appends a truncation footer when the digest list query saturated", () => {
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: true,
      rows: [{ name: "Mail", lastDigest: null, markerAgeDays: null }],
    }
    const lines = formatDigestStatus(report)
    expect(lines[lines.length - 1]).toMatch(/older may be truncated/)
  })

  it("aligns project names by padding on the colon-suffixed label", () => {
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: false,
      rows: [
        { name: "Mail Backend", lastDigest: null, markerAgeDays: null },
        { name: "Web", lastDigest: null, markerAgeDays: null },
      ],
    }
    const lines = formatDigestStatus(report)
    // Both rows should have the divider start at the same column.
    const dividerCol = lines[1]!.indexOf("·")
    expect(lines[2]!.indexOf("·")).toBe(dividerCol)
  })
})

describe("loadDigestStatus", () => {
  const baseConfig: LoreConfig = {
    vault: { pageId: "v" },
    projects: [
      { name: "Mail Backend", path: "services/mail" },
      { name: "Mail Web", path: "apps/web" },
    ],
  }

  it("returns an empty rows list when the config has no sub-projects", async () => {
    const services = makeServices({
      config: { vault: { pageId: "v" }, projects: [{ name: "Mono", path: "." }] },
    })
    const report = await loadDigestStatus(services, "/repo")
    expect(report.rows).toEqual([])
    expect(report.disabledReason).toBeNull()
  })

  it("groups a vault-wide digest list by Notion project ID", async () => {
    const projectA = makeProject("Mail Backend", { id: "p-a" })
    const projectB = makeProject("Mail Web", { id: "p-b" })
    const services = makeServices({
      config: baseConfig,
      projects: [projectA, projectB],
      digestMemories: [
        makeMemory({
          projectIds: ["p-a"],
          createdAt: "2026-04-12T00:00:00.000Z",
        }),
        makeMemory({
          projectIds: ["p-b"],
          createdAt: "2026-04-19T00:00:00.000Z",
        }),
      ],
    })

    const report = await loadDigestStatus(services, "/repo", {
      markerAge: vi.fn(async () => 5),
    })

    const a = report.rows.find((r) => r.name === "Mail Backend")
    const b = report.rows.find((r) => r.name === "Mail Web")
    expect(a?.lastDigest?.date).toBe("2026-04-12")
    expect(b?.lastDigest?.date).toBe("2026-04-19")
  })

  it("emits null for a project with no Notion record (rather than throwing)", async () => {
    const services = makeServices({
      config: baseConfig,
      // No matching Notion projects — findByName returns null.
      projects: [],
      digestMemories: [],
    })

    const report = await loadDigestStatus(services, "/repo", {
      markerAge: vi.fn(async () => Infinity),
    })

    for (const row of report.rows) {
      expect(row.lastDigest).toBeNull()
      expect(row.markerAgeDays).toBeNull()
    }
  })

  it("converts Infinity marker age into null so the renderer shows 'marker missing'", async () => {
    const services = makeServices({
      config: baseConfig,
      projects: [makeProject("Mail Backend", { id: "p-a" })],
    })

    const report = await loadDigestStatus(services, "/repo", {
      markerAge: vi.fn(async () => Infinity),
    })

    expect(report.rows.every((r) => r.markerAgeDays === null)).toBe(true)
  })

  it("flags `hooks.autoDigest: false` as a config kill-switch", async () => {
    const services = makeServices({
      config: { ...baseConfig, hooks: { autoDigest: false } },
      projects: [makeProject("Mail Backend", { id: "p-a" })],
    })
    const report = await loadDigestStatus(services, "/repo")
    expect(report.disabledReason).toEqual({
      source: "config",
      detail: "hooks.autoDigest: false",
    })
  })

  it("flags `LORE_AUTO_DIGEST=false` as an env kill-switch and overrides config", async () => {
    const services = makeServices({
      // Even when config says enabled, env still wins.
      config: { ...baseConfig, hooks: { autoDigest: true } },
      projects: [makeProject("Mail Backend", { id: "p-a" })],
    })
    const report = await loadDigestStatus(services, "/repo", {
      autoDigestEnvOverride: "false",
    })
    expect(report.disabledReason).toEqual({
      source: "env",
      detail: "LORE_AUTO_DIGEST=false",
    })
  })

  it("surfaces a multi-project digest as the latest watermark for every linked project", async () => {
    // Regression guard for a subtle bug where the loader could read
    // `projectIds[0]` instead of consulting the per-project map: a digest
    // linked to both Backend and Web should show as the latest for both.
    const projectA = makeProject("Mail Backend", { id: "p-a" })
    const projectB = makeProject("Mail Web", { id: "p-b" })
    const services = makeServices({
      config: baseConfig,
      projects: [projectA, projectB],
      digestMemories: [
        makeMemory({
          projectIds: ["p-a", "p-b"],
          createdAt: "2026-04-22T00:00:00.000Z",
        }),
      ],
    })

    const report = await loadDigestStatus(services, "/repo", {
      markerAge: vi.fn(async () => 1),
    })

    const a = report.rows.find((r) => r.name === "Mail Backend")
    const b = report.rows.find((r) => r.name === "Mail Web")
    expect(a?.lastDigest?.date).toBe("2026-04-22")
    expect(b?.lastDigest?.date).toBe("2026-04-22")
  })

  it("treats env values other than literal 'false' as enabled (matching the scheduler)", async () => {
    // `autoDigestEnvDisabled` in helpers.ts uses `=== "false"`. Every other
    // truthy/falsy string ("0", "no", "", "true") should leave auto-digest
    // enabled — this test pins that contract on the status side.
    const services = makeServices({
      config: baseConfig,
      projects: [makeProject("Mail Backend", { id: "p-a" })],
    })
    for (const value of ["0", "no", "", "true", undefined]) {
      const report = await loadDigestStatus(services, "/repo", {
        autoDigestEnvOverride: value,
      })
      expect(report.disabledReason).toBeNull()
    }
  })

  it("flags `truncated` when the digest list query returns the cap", async () => {
    // Cap is 50 in the loader; 50 returned items means the underlying
    // `memories.list({ source: digest })` saturated and older digests may
    // be missing — surfaced via the truncated flag for the renderer.
    const fifty = Array.from({ length: 50 }, (_, i) =>
      makeMemory({ id: `d-${i}`, projectIds: ["p-a"] }),
    )
    const services = makeServices({
      config: baseConfig,
      projects: [makeProject("Mail Backend", { id: "p-a" })],
      digestMemories: fifty,
    })

    const report = await loadDigestStatus(services, "/repo", {
      markerAge: vi.fn(async () => 1),
    })
    expect(report.truncated).toBe(true)
  })

  it("does not flag `truncated` when the digest list query returns under the cap", async () => {
    const services = makeServices({
      config: baseConfig,
      projects: [makeProject("Mail Backend", { id: "p-a" })],
      digestMemories: [makeMemory({ projectIds: ["p-a"] })],
    })

    const report = await loadDigestStatus(services, "/repo", {
      markerAge: vi.fn(async () => 1),
    })
    expect(report.truncated).toBe(false)
  })

  it("only issues one digest list call regardless of project count", async () => {
    const listSpy = vi.fn(async () => ({ items: [] }))
    const services = {
      config: baseConfig,
      configRoot: "/repo",
      memories: { list: listSpy },
      projects: {
        async findByName(name: string): Promise<Project | null> {
          return makeProject(name)
        },
      },
    } as unknown as LoreServices

    await loadDigestStatus(services, "/repo", {
      markerAge: vi.fn(async () => 1),
    })
    expect(listSpy).toHaveBeenCalledTimes(1)
  })
})
