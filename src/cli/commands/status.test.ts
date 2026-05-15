import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  formatConfidenceSummary,
  formatDigestStatus,
  formatDriftStatus,
  formatTrackingPreflight,
  groupLatestDigestByProject,
  loadCostStatusLines,
  loadDigestStatus,
  loadDriftStatus,
  loadTrackingPreflight,
  type ConfidenceStatsReport,
  type DigestStatusReport,
  type DriftStatusReport,
  type TrackingPreflightReport,
  type TrackingPreflightServices,
} from "./status.js"
import {
  formatBackgroundFailureStatus,
  loadBackgroundFailureStatus,
  type BackgroundFailureStatusReport,
} from "../../hooks/background-failure-status.js"
import { DRIFT_DEBOUNCE_DAYS } from "../../hooks/drift-marker.js"
import type { BackgroundFailureMarker } from "../../hooks/background-failure-marker.js"
import type { LoreServices } from "../../services.js"
import type { LoreConfig, Memory, Project } from "../../types.js"
import {
  COST_LEDGER_SCHEMA_VERSION,
  payloadSummary,
  resolveCostTracking,
} from "../../core/cost-ledger.js"

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
    content: "",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
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

function makeBackgroundFailure(
  overrides: Partial<BackgroundFailureMarker>
): BackgroundFailureMarker {
  return {
    version: 1,
    kind: "autosave",
    occurredAt: "2026-04-24T12:00:00.000Z",
    configRootKey: "abcdef12",
    code: "binary-missing",
    message: "background command not found",
    ...overrides,
  }
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

describe("formatBackgroundFailureStatus", () => {
  it("renders the observed scope when there are no recent failures", () => {
    const report: BackgroundFailureStatusReport = { failures: [], totalRecent: 0 }
    expect(formatBackgroundFailureStatus(report)).toEqual([
      "Background hooks:",
      "  observed scope: spawn/init/gather only; detached child exits are not tracked.",
      "  observed failures: none",
    ])
  })

  it("renders failure context, log path, and a recovery hint", () => {
    const report: BackgroundFailureStatusReport = {
      totalRecent: 1,
      failures: [
        makeBackgroundFailure({
          kind: "digest-scheduler",
          projectName: "Widget Backend",
          sessionId: "sess-123",
          code: "init-failed",
          message: "init failed: unauthorized",
          logPath: "/tmp/lore-hook-state/digest-Widget_Backend.log",
        }),
      ],
    }

    const text = formatBackgroundFailureStatus(report).join("\n")

    expect(text).toContain("Background hooks:")
    expect(text).toContain("detached child exits are not tracked")
    expect(text).toContain("digest scheduler")
    expect(text).toContain("project Widget Backend")
    expect(text).toContain("session sess-123")
    expect(text).toContain("init-failed: init failed: unauthorized")
    expect(text).toContain("/tmp/lore-hook-state/digest-Widget_Backend.log")
    expect(text).toContain("lore auth --status")
  })

  it("uses digest-specific manual recovery hints for synthesizer failures", () => {
    const report: BackgroundFailureStatusReport = {
      totalRecent: 1,
      failures: [
        makeBackgroundFailure({
          kind: "digest-synthesizer",
          code: "spawn-error",
          message: "spawn failed: EAGAIN",
        }),
      ],
    }

    const text = formatBackgroundFailureStatus(report).join("\n")
    expect(text).toContain("digest synthesizer")
    expect(text).toContain("lore digest")
  })

  it("renders the total count when recent failures are truncated", () => {
    const report: BackgroundFailureStatusReport = {
      totalRecent: 12,
      failures: Array.from({ length: 10 }, (_, idx) =>
        makeBackgroundFailure({
          projectName: `Project ${idx}`,
          sessionId: `sess-${idx}`,
        })
      ),
    }

    const text = formatBackgroundFailureStatus(report).join("\n")
    expect(text).toContain("(showing 10 of 12 recent failures)")
  })
})

describe("loadBackgroundFailureStatus", () => {
  it("returns no rows and does not touch the filesystem when configRoot is absent", async () => {
    const listFailures = vi.fn(async () => [makeBackgroundFailure({})])

    const report = await loadBackgroundFailureStatus(null, { listFailures })

    expect(report).toEqual({ failures: [], totalRecent: 0 })
    expect(listFailures).not.toHaveBeenCalled()
  })

  it("delegates to the marker reader with the config root", async () => {
    const marker = makeBackgroundFailure({ sessionId: "sess-one" })
    const listFailures = vi.fn(async () => [marker])

    const report = await loadBackgroundFailureStatus("/repo", { listFailures })

    expect(listFailures).toHaveBeenCalledWith("/repo")
    expect(report).toEqual({ failures: [marker], totalRecent: 1 })
  })

  it("delegates to the marker collector when provided", async () => {
    const marker = makeBackgroundFailure({ sessionId: "sess-one" })
    const collectFailures = vi.fn(async () => ({
      failures: [marker],
      totalRecent: 3,
    }))

    const report = await loadBackgroundFailureStatus("/repo", { collectFailures })

    expect(collectFailures).toHaveBeenCalledWith("/repo")
    expect(report).toEqual({ failures: [marker], totalRecent: 3 })
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
      rows: [{ name: "Widget", lastDigest: null, markerAgeDays: null }],
    }
    expect(formatDigestStatus(report)[0]).toBe("Digests:")
  })

  it("surfaces the env kill-switch in the section header", () => {
    const report: DigestStatusReport = {
      disabledReason: { source: "env", detail: "LORE_AUTO_DIGEST=false" },
      truncated: false,
      rows: [{ name: "Widget", lastDigest: null, markerAgeDays: null }],
    }
    expect(formatDigestStatus(report)[0]).toBe(
      "Digests (autoDigest=false via LORE_AUTO_DIGEST=false):"
    )
  })

  it("surfaces the config kill-switch in the section header", () => {
    const report: DigestStatusReport = {
      disabledReason: { source: "config", detail: "hooks.autoDigest: false" },
      truncated: false,
      rows: [{ name: "Widget", lastDigest: null, markerAgeDays: null }],
    }
    expect(formatDigestStatus(report)[0]).toBe(
      "Digests (autoDigest=false via hooks.autoDigest: false):"
    )
  })

  it("renders a missing-marker row as 'next fire on next Stop hook'", () => {
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: false,
      rows: [{ name: "Widget Web", lastDigest: null, markerAgeDays: null }],
    }
    const [, row] = formatDigestStatus(report)
    expect(row).toContain("no digest yet")
    expect(row).toContain("marker missing")
    expect(row).toContain("next fire on next Stop hook")
  })

  it("computes a fresh marker's remaining time as ceil(stale_days - age)", () => {
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: false,
      rows: [
        {
          name: "Widget Backend",
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

  it("treats markers older than the freshness window as 'next fire on next Stop hook'", () => {
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
    expect(row).toContain("next fire on next Stop hook")
  })

  it("treats a marker exactly at the freshness boundary as 'fire on next Stop hook'", () => {
    // markerAgeDays === DIGEST_STALE_DAYS (7) puts `remaining` at 0, which
    // matches the scheduler's `markerAge >= DIGEST_STALE_DAYS` semantic —
    // the next Stop hook re-fires synthesis.
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: false,
      rows: [{ name: "Edge", lastDigest: null, markerAgeDays: 7 }],
    }
    const [, row] = formatDigestStatus(report)
    expect(row).toContain("marker 7d old")
    expect(row).toContain("next fire on next Stop hook")
  })

  it("appends a truncation footer when the digest list query saturated", () => {
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: true,
      rows: [{ name: "Widget", lastDigest: null, markerAgeDays: null }],
    }
    const lines = formatDigestStatus(report)
    expect(lines[lines.length - 1]).toMatch(/older may be truncated/)
  })

  it("aligns project names by padding on the colon-suffixed label", () => {
    const report: DigestStatusReport = {
      disabledReason: null,
      truncated: false,
      rows: [
        { name: "Widget Backend", lastDigest: null, markerAgeDays: null },
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
      { name: "Widget Backend", path: "services/widget" },
      { name: "Widget Web", path: "apps/web" },
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
    const projectA = makeProject("Widget Backend", { id: "p-a" })
    const projectB = makeProject("Widget Web", { id: "p-b" })
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

    const a = report.rows.find((r) => r.name === "Widget Backend")
    const b = report.rows.find((r) => r.name === "Widget Web")
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
      projects: [makeProject("Widget Backend", { id: "p-a" })],
    })

    const report = await loadDigestStatus(services, "/repo", {
      markerAge: vi.fn(async () => Infinity),
    })

    expect(report.rows.every((r) => r.markerAgeDays === null)).toBe(true)
  })

  it("flags `hooks.autoDigest: false` as a config kill-switch", async () => {
    const services = makeServices({
      config: { ...baseConfig, hooks: { autoDigest: false } },
      projects: [makeProject("Widget Backend", { id: "p-a" })],
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
      projects: [makeProject("Widget Backend", { id: "p-a" })],
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
    const projectA = makeProject("Widget Backend", { id: "p-a" })
    const projectB = makeProject("Widget Web", { id: "p-b" })
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

    const a = report.rows.find((r) => r.name === "Widget Backend")
    const b = report.rows.find((r) => r.name === "Widget Web")
    expect(a?.lastDigest?.date).toBe("2026-04-22")
    expect(b?.lastDigest?.date).toBe("2026-04-22")
  })

  it("treats env values other than literal 'false' as enabled (matching the scheduler)", async () => {
    // `autoDigestEnvDisabled` in helpers.ts uses `=== "false"`. Every other
    // truthy/falsy string ("0", "no", "", "true") should leave auto-digest
    // enabled — this test pins that contract on the status side.
    const services = makeServices({
      config: baseConfig,
      projects: [makeProject("Widget Backend", { id: "p-a" })],
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
      makeMemory({ id: `d-${i}`, projectIds: ["p-a"] })
    )
    const services = makeServices({
      config: baseConfig,
      projects: [makeProject("Widget Backend", { id: "p-a" })],
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
      projects: [makeProject("Widget Backend", { id: "p-a" })],
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

describe("formatDriftStatus", () => {
  it("returns no lines when configured=false so the section is suppressed", () => {
    const report: DriftStatusReport = {
      configured: false,
      markerAgeDays: null,
    }
    expect(formatDriftStatus(report)).toEqual([])
  })

  it("renders the section header on the configured path", () => {
    const report: DriftStatusReport = {
      configured: true,
      markerAgeDays: null,
    }
    expect(formatDriftStatus(report)[0]).toBe("Drift check:")
  })

  it("renders a missing-marker row with the debounced-session phrasing", () => {
    // The wording differs from the digest section's "next fire on next
    // Stop hook" because drift fires on every debounced caller (MCP
    // server, shell hooks, digest scheduler) — not only on Stop.
    const report: DriftStatusReport = {
      configured: true,
      markerAgeDays: null,
    }
    const [, row] = formatDriftStatus(report)
    expect(row).toBe("  marker missing · next fire on next debounced session")
  })

  it("computes a fresh marker's remaining time as ceil(debounce_days - age)", () => {
    const report: DriftStatusReport = {
      configured: true,
      markerAgeDays: 3,
    }
    const [, row] = formatDriftStatus(report)
    expect(row).toBe("  marker 3d old · next fire ~4d")
  })

  it("rounds fractional remaining days up so 'next fire ~Xd' is a worst-case estimate", () => {
    // 6.5 days old → 0.5 days remaining → ceil to 1 so the operator never
    // sees "next fire ~0d" for a marker that's still inside the debounce.
    const report: DriftStatusReport = {
      configured: true,
      markerAgeDays: 6.5,
    }
    const [, row] = formatDriftStatus(report)
    expect(row).toBe("  marker 6d old · next fire ~1d")
  })

  it("treats a marker exactly at DRIFT_DEBOUNCE_DAYS as 'fire on next debounced session'", () => {
    // markerAgeDays === DRIFT_DEBOUNCE_DAYS puts `remaining` at 0, which
    // matches `resolveDriftCheck`'s `ageDays < DRIFT_DEBOUNCE_DAYS` semantic
    // — at exactly the boundary the next debounced caller re-fires.
    const report: DriftStatusReport = {
      configured: true,
      markerAgeDays: DRIFT_DEBOUNCE_DAYS,
    }
    const [, row] = formatDriftStatus(report)
    expect(row).toBe(
      `  marker ${DRIFT_DEBOUNCE_DAYS}d old · next fire on next debounced session`
    )
  })

  it("treats markers older than the debounce window as 'fire on next debounced session'", () => {
    const report: DriftStatusReport = {
      configured: true,
      markerAgeDays: DRIFT_DEBOUNCE_DAYS + 2,
    }
    const [, row] = formatDriftStatus(report)
    expect(row).toContain(`marker ${DRIFT_DEBOUNCE_DAYS + 2}d old`)
    expect(row).toContain("next fire on next debounced session")
  })

  it("treats non-finite markerAgeDays as 'marker missing' instead of leaking 'Infinity'", () => {
    // Defense-in-depth with `loadDriftStatus`: the loader normalizes the
    // filesystem-level `Infinity` sentinel to `null`, but a future caller
    // constructing a `DriftStatusReport` directly mustn't be able to print
    // "marker Infinityd old · next fire on next debounced session".
    // `Math.floor(Infinity)` is a no-op (`=== Infinity`) so without the
    // renderer-side guard `Infinity` would template-stringify into the row.
    for (const bogusAge of [Infinity, -Infinity, NaN]) {
      const report: DriftStatusReport = {
        configured: true,
        markerAgeDays: bogusAge,
      }
      const [, row] = formatDriftStatus(report)
      expect(row).toBe("  marker missing · next fire on next debounced session")
    }
  })
})

describe("loadDriftStatus", () => {
  it("returns configured=false when no config root is provided", async () => {
    for (const noConfig of [undefined, null, ""]) {
      const report = await loadDriftStatus(noConfig)
      expect(report.configured).toBe(false)
      expect(report.markerAgeDays).toBeNull()
    }
  })

  it("does not invoke the marker probe when there is no config root", async () => {
    // Defensive: with no config root we should short-circuit before
    // touching the filesystem so a stat() against an unset path can't
    // throw or leak.
    const probe = vi.fn(async () => 1)
    await loadDriftStatus(undefined, { markerAge: probe })
    expect(probe).not.toHaveBeenCalled()
  })

  it("converts Infinity marker age into null so the renderer shows 'marker missing'", async () => {
    const report = await loadDriftStatus("/repo", {
      markerAge: vi.fn(async () => Infinity),
    })
    expect(report.configured).toBe(true)
    expect(report.markerAgeDays).toBeNull()
  })

  it("passes a finite marker age through verbatim for the renderer", async () => {
    const report = await loadDriftStatus("/repo", {
      markerAge: vi.fn(async () => 4.2),
    })
    expect(report.markerAgeDays).toBe(4.2)
  })

  it("forwards the configRoot to the marker probe so the underlying stat is keyed correctly", async () => {
    const probe = vi.fn(async () => 0)
    await loadDriftStatus("/some/repo", { markerAge: probe })
    expect(probe).toHaveBeenCalledWith("/some/repo")
  })
})

describe("formatTrackingPreflight (issue 0.6.0/24)", () => {
  it("renders no lines when count is zero so the warning block is suppressed", () => {
    // Acceptance criterion: when the vault has zero tracking-predicate
    // facts, status output is byte-identical to pre-issue behavior.
    // Empty array → caller's length-check drops the entire block.
    const report: TrackingPreflightReport = { count: 0 }
    expect(formatTrackingPreflight(report)).toEqual([])
  })

  it("renders the warning block when count is greater than zero", () => {
    const report: TrackingPreflightReport = { count: 14 }
    const lines = formatTrackingPreflight(report)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines[0]).toContain("Tracking-predicate facts detected")
    expect(lines[0]).toContain("14")
  })

  it("names the historical migration command so operators recognize the deleted path", () => {
    // The warning surfaces the (now-deleted) migration command name so an
    // operator who runs `lore status` after upgrading sees the same
    // command they may have read about previously, alongside the
    // explanation that it's gone.
    const report: TrackingPreflightReport = { count: 1 }
    const text = formatTrackingPreflight(report).join("\n")
    expect(text).toContain("lore migrate --migrate-tracking-to-tasks")
  })

  it("names the consequence of skipping the migration", () => {
    // Acceptance criterion: warning text names the consequence so the
    // operator understands the urgency. "Invisible to lore" is the
    // load-bearing phrase — the rows still exist in Notion, but no
    // read path will surface them post-removal.
    const report: TrackingPreflightReport = { count: 1 }
    // Collapse whitespace so the assertion ignores hard line wrapping in
    // the rendered block — render artifact, not a contract change.
    const text = formatTrackingPreflight(report).join(" ").replace(/\s+/g, " ")
    expect(text).toMatch(/invisible to lore/i)
  })

  it("names all three historical predicates so an operator can grep their vault", () => {
    // Pin the predicate names so a future copy edit doesn't accidentally
    // drop one — operators reading the warning may want to filter their
    // Notion view by these exact strings before running the migration.
    const report: TrackingPreflightReport = { count: 3 }
    const text = formatTrackingPreflight(report).join("\n")
    expect(text).toContain("needs_action")
    expect(text).toContain("waiting_on")
    expect(text).toContain("blocked_by")
  })

  it("uses singular noun when count is exactly 1", () => {
    const report: TrackingPreflightReport = { count: 1 }
    const [header] = formatTrackingPreflight(report)
    expect(header).toContain("1 live row.")
  })

  it("uses plural noun when count is greater than 1", () => {
    const report: TrackingPreflightReport = { count: 7 }
    const [header] = formatTrackingPreflight(report)
    expect(header).toContain("7 live rows.")
  })

  it("treats negative counts as the suppressed branch (defense-in-depth)", () => {
    // Defensive: the loader can only return non-negative integers, but
    // a future caller constructing a `TrackingPreflightReport` directly
    // mustn't be able to render "-1 live rows" if they pass a stale
    // count from another subsystem. The renderer collapses any
    // non-positive count to the empty branch.
    for (const negative of [-1, -42]) {
      const report: TrackingPreflightReport = { count: negative }
      expect(formatTrackingPreflight(report)).toEqual([])
    }
  })
})

describe("loadTrackingPreflight (issue 0.6.0/24)", () => {
  function makePreflightServices(
    countByPredicateRaw: (strings: string[]) => Promise<number>
  ): TrackingPreflightServices {
    return {
      facts: { countByPredicateRaw },
    }
  }

  it("returns the count from the predicate probe", async () => {
    const probe = vi.fn(async () => 42)
    const report = await loadTrackingPreflight(makePreflightServices(probe))
    expect(report).toEqual({ count: 42 })
  })

  it("queries the three historical tracking predicates as raw strings", async () => {
    // The probe MUST be called with the raw Notion select values
    // (`needs_action`, `waiting_on`, `blocked_by`). #23 will remove
    // these from the `FactPredicate` typed union, so the loader
    // intentionally passes raw strings — a typed-predicate path
    // would either fail to compile or silently match a shrinking
    // set after #23 ships.
    const probe = vi.fn(async (_strings: string[]) => 0)
    await loadTrackingPreflight(makePreflightServices(probe))
    expect(probe).toHaveBeenCalledTimes(1)
    const args = probe.mock.calls[0]![0]
    expect([...args].sort()).toEqual(["blocked_by", "needs_action", "waiting_on"])
  })

  it("prefers the injected probe over the services.facts method (test seam)", async () => {
    const serviceProbe = vi.fn(async () => 99)
    const injected = vi.fn(async () => 5)
    const report = await loadTrackingPreflight(makePreflightServices(serviceProbe), {
      countByPredicateRaw: injected,
    })
    expect(injected).toHaveBeenCalledTimes(1)
    expect(serviceProbe).not.toHaveBeenCalled()
    expect(report.count).toBe(5)
  })

  it("falls back to services.facts.countByPredicateRaw when no override is provided", async () => {
    const serviceProbe = vi.fn(async () => 12)
    const report = await loadTrackingPreflight(makePreflightServices(serviceProbe))
    expect(serviceProbe).toHaveBeenCalledTimes(1)
    expect(report.count).toBe(12)
  })
})

describe("loadCostStatusLines", () => {
  it("skips schema-invalid ledger rows so status still renders costs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-status-costs-"))
    try {
      const costTracking = resolveCostTracking(
        {
          costTracking: {
            enabled: true,
            ledgerPath: "state/costs.jsonl",
          },
        },
        dir
      )
      if (!costTracking.enabled) {
        throw new Error("expected cost tracking to be enabled")
      }
      mkdirSync(join(dir, "state"))
      writeFileSync(
        costTracking.ledgerPath,
        [
          JSON.stringify({
            timestamp: new Date().toISOString(),
            eventType: "mcp.invocation",
            status: "success",
            projectName: "SECRET_INVALID_STATUS_ROW",
          }),
          JSON.stringify({
            schemaVersion: COST_LEDGER_SCHEMA_VERSION,
            timestamp: new Date().toISOString(),
            eventType: "mcp.invocation",
            source: "host_agent",
            status: "success",
            tool: "lore-query",
            action: "search",
            payload: payloadSummary("{}", "ok"),
            notion: { reads: 1, writes: 0, failures: 0, rateLimitBackoffs: 0 },
          }),
        ].join("\n") + "\n"
      )

      const lines = await loadCostStatusLines({ costTracking } as LoreServices)
      const output = lines.join("\n")
      expect(output).toContain("Cost tracking: enabled")
      expect(output).toContain("1 MCP calls")
      expect(output).not.toContain("SECRET_INVALID_STATUS_ROW")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("Tasks line wiring (issue 0.7.0/13)", () => {
  // The CLI status command's `taskStats` call is exercised here at the
  // free-function level rather than via `statusCommand.action(...)`
  // because the command spins up real `initServices()` against a vault.
  // The wiring proven below (CLI imports `formatTaskSummary` +
  // `taskStats` from `core/task`, and renders the lines into stdout) is
  // covered structurally by the format tests in `core/task.test.ts` and
  // the dispatcher test in `mcp/tools/context.test.ts`.

  it("formatTaskSummary is re-exported from `core/task` and produces the spec example", async () => {
    // Pin the import path the CLI uses: anyone refactoring the renderer's
    // location would have to update both `cli/commands/status.ts` and
    // `mcp/tools/context.ts` together. This guards the byte-identical
    // contract the issue calls out.
    const { formatTaskSummary } = await import("../../core/task.js")
    expect(typeof formatTaskSummary).toBe("function")
    const lines = formatTaskSummary({
      active: 271,
      overdue: 25,
      stale: 89,
      inProgress: 12,
      blocked: 0,
      closedLast30Days: 14,
    })
    expect(lines[0]).toBe(
      "Tasks: 271 active (overdue: 25, stale ≥30d: 89, in-progress: 12)"
    )
    expect(lines[1]).toBe("       Closed last 30 days: 14 (rate: 0.47/day)")
  })
})

describe("formatConfidenceSummary (DEFERRED-04)", () => {
  it("returns no lines on an empty vault so the section is suppressed", () => {
    // Same contract as `formatDigestStatus` / `formatDriftStatus` /
    // `formatTrackingPreflight`: empty array → caller's length-check
    // drops the entire surface. A vault with zero memories has nothing
    // confidence-shaped to report.
    const report: ConfidenceStatsReport = {
      totalMemories: 0,
      scoredMemories: 0,
      averageScore: 0,
      belowThreshold: 0,
    }
    expect(formatConfidenceSummary(report)).toEqual([])
  })

  it("renders a one-memory unscored vault — the smallest non-suppressed input", () => {
    // The `<= 0` empty-vault gate defends one boundary; this test
    // pins the OTHER side of that boundary — the smallest input that
    // produces a rendered line. A future change that broadens the
    // suppression gate (e.g. `<= 1`) would silently hide single-row
    // vaults from `lore status`; pinning this case forces the change
    // to be deliberate. Pre-#11 single-memory case so the parens
    // suffix is also exercised at minimum totals.
    const lines = formatConfidenceSummary({
      totalMemories: 1,
      scoredMemories: 0,
      averageScore: 0,
      belowThreshold: 0,
    })
    expect(lines).toEqual(["Memory confidence: 1 total, 0 scored"])
  })

  it("produces the deferred-spec example shape", () => {
    // Pins the line-shape DEFERRED.md gave as the rendering target.
    // The prefix is `Memory confidence:` rather than the deferred's
    // illustrative `Memories:` to avoid a visual collision with the
    // `Database counts → Memories: N` line two rows above; the
    // structural shape (total, scored, parens with avg + below
    // threshold) matches the spec.
    const lines = formatConfidenceSummary({
      totalMemories: 1247,
      scoredMemories: 1023,
      averageScore: 0.51,
      belowThreshold: 412,
    })
    expect(lines).toEqual([
      "Memory confidence: 1247 total, 1023 scored (avg 0.51, 412 below threshold)",
    ])
  })

  it("collapses to bare 'N total, 0 scored' on a pre-#11 vault", () => {
    // Pre-migration vaults ship with every `Confidence Score` null.
    // Rendering `(avg 0.00, 0 below threshold)` would imply the score
    // distribution actually concentrated at zero; instead we suppress
    // the parens entirely so the operator reads "no scoring yet" and
    // knows to run `lore migrate --build-confidence-scores`.
    const lines = formatConfidenceSummary({
      totalMemories: 432,
      scoredMemories: 0,
      averageScore: 0,
      belowThreshold: 0,
    })
    expect(lines).toEqual(["Memory confidence: 432 total, 0 scored"])
  })

  it("drops the trailing 'below threshold' segment when nothing is below", () => {
    // Mirrors `formatTaskSummary`'s "only render non-zero substats"
    // posture — a vault with every score above CONFIDENCE_DISPLAY_THRESHOLD
    // shouldn't render `, 0 below threshold` as if zero were a remarkable
    // count.
    const lines = formatConfidenceSummary({
      totalMemories: 100,
      scoredMemories: 100,
      averageScore: 0.87,
      belowThreshold: 0,
    })
    expect(lines).toEqual(["Memory confidence: 100 total, 100 scored (avg 0.87)"])
  })

  it("renders averageScore to two decimal places", () => {
    // Pin the precision so a future contributor swapping `toFixed(2)`
    // for a different format (`.toFixed(3)`, `Intl.NumberFormat`) has
    // to surface the shape change. Two decimals matches the Tasks
    // closure-rate line so the two summaries read as one cluster.
    const lines = formatConfidenceSummary({
      totalMemories: 50,
      scoredMemories: 50,
      averageScore: 0.6666666,
      belowThreshold: 5,
    })
    expect(lines[0]).toContain("avg 0.67")
  })

  it("renders averageScore=1.0 as 'avg 1.00' rather than 'avg 1'", () => {
    // `(1).toFixed(2)` yields "1.00" — pinned so a future change to
    // numeric formatting (e.g. swapping in `Intl.NumberFormat`) has
    // to surface the shape change for the perfect-score case.
    const lines = formatConfidenceSummary({
      totalMemories: 1,
      scoredMemories: 1,
      averageScore: 1.0,
      belowThreshold: 0,
    })
    expect(lines).toEqual(["Memory confidence: 1 total, 1 scored (avg 1.00)"])
  })

  it("renders the 'vault is in crisis' shape when every scored row is below threshold", () => {
    // DEFERRED-04 explicitly calls out the operator-visible signal
    // "vault whose average score has crashed below 0.5" as the
    // load-bearing motivation for the line. Pin the rendering for
    // the case where every scored row is below threshold so a future
    // refactor can't quietly degrade the crisis surface.
    const lines = formatConfidenceSummary({
      totalMemories: 50,
      scoredMemories: 50,
      averageScore: 0.32,
      belowThreshold: 50,
    })
    expect(lines).toEqual([
      "Memory confidence: 50 total, 50 scored (avg 0.32, 50 below threshold)",
    ])
  })

  it("treats negative totalMemories as the suppressed branch (defense-in-depth)", () => {
    // Defensive: the loader can only return non-negative integers, but a
    // future caller constructing a ConfidenceStatsReport directly mustn't
    // be able to render `Memories: -1 total` — collapse any non-positive
    // count to the empty branch, same shape `formatTrackingPreflight`
    // uses for negative `count`.
    for (const negative of [-1, -42]) {
      const report: ConfidenceStatsReport = {
        totalMemories: negative,
        scoredMemories: 0,
        averageScore: 0,
        belowThreshold: 0,
      }
      expect(formatConfidenceSummary(report)).toEqual([])
    }
  })

  it("clamps inconsistent inputs to the structural invariants (defense-in-depth)", () => {
    // The loader cannot produce `scoredMemories > totalMemories` or
    // `belowThreshold > scoredMemories`, but a future caller
    // constructing a `ConfidenceStatsReport` directly mustn't be
    // able to render a structurally impossible line like
    // `Memory confidence: 100 total, 200 scored ...`. Pin the
    // clamp at the renderer entry: scoredMemories ⊆ [0,
    // totalMemories], belowThreshold ⊆ [0, scoredMemories].
    const lines = formatConfidenceSummary({
      totalMemories: 100,
      scoredMemories: 200, // impossible — must clamp to 100
      averageScore: 0.5,
      belowThreshold: 500, // impossible — must clamp to scoredMemories (100)
    })
    expect(lines).toEqual([
      "Memory confidence: 100 total, 100 scored (avg 0.50, 100 below threshold)",
    ])
  })

  it("clamps negative scored / below-threshold inputs to zero (defense-in-depth)", () => {
    // Same posture as the negative-`totalMemories` short-circuit
    // above, but for the inner counts. Negative `scoredMemories`
    // collapses to `0 scored` (and the parens drop because there
    // are no scored rows to compute an average over). Negative
    // `belowThreshold` collapses to zero so the trailing
    // `, K below threshold` segment can't render with a nonsensical
    // count.
    const lines = formatConfidenceSummary({
      totalMemories: 10,
      scoredMemories: -5,
      averageScore: 0.5,
      belowThreshold: -3,
    })
    expect(lines).toEqual(["Memory confidence: 10 total, 0 scored"])
  })

  it("clamps averageScore outside [0, 1] back into range (defense-in-depth)", () => {
    // The third structural invariant `confidenceStats` upholds:
    // `0 <= averageScore <= 1`. A future caller constructing a
    // report directly mustn't be able to render `avg 99.00` or
    // `avg -1.00`. The clamp also absorbs FP-mean ULP drift past
    // 1.0 noted in `confidenceStats`'s docstring — a sum that
    // accumulates to `0.9999999999999998 * N + ε` divided by `N`
    // can land at `1.0000000000000002`, which `(1.0000000000000002)
    // .toFixed(2)` would otherwise render as `"1.00"` (harmless
    // here, but the principle generalizes — pin the clamp).
    const high = formatConfidenceSummary({
      totalMemories: 50,
      scoredMemories: 50,
      averageScore: 99,
      belowThreshold: 0,
    })
    expect(high).toEqual(["Memory confidence: 50 total, 50 scored (avg 1.00)"])

    const low = formatConfidenceSummary({
      totalMemories: 50,
      scoredMemories: 50,
      averageScore: -42,
      belowThreshold: 50,
    })
    expect(low).toEqual([
      "Memory confidence: 50 total, 50 scored (avg 0.00, 50 below threshold)",
    ])
  })
})

describe("formatConfidenceSummary wiring (DEFERRED-04)", () => {
  // Mirrors the `Tasks line wiring` block above: structural
  // assertion at the import boundary rather than an integration
  // test that would require a real `initServices()` against a
  // vault. A future contributor swapping `Promise.all` for
  // sequential `await`s in the action handler — or moving the
  // renderer to a different module — would have to update this
  // assertion in lockstep.

  it("formatConfidenceSummary is exported from `cli/commands/status` as a pure function", async () => {
    const mod = await import("./status.js")
    expect(typeof mod.formatConfidenceSummary).toBe("function")
    // Pin the spec-shape one more time at the import-boundary level
    // — a sibling-module refactor that re-exported a renamed function
    // (e.g. `formatConfidenceLine`) would compile-pass but break this.
    const lines = mod.formatConfidenceSummary({
      totalMemories: 1247,
      scoredMemories: 1023,
      averageScore: 0.51,
      belowThreshold: 412,
    })
    expect(lines[0]).toBe(
      "Memory confidence: 1247 total, 1023 scored (avg 0.51, 412 below threshold)"
    )
  })
})

// Phase 1 of issue #281's `formatProposedInboxStatus` /
// `loadProposedInboxStatus` tests live in
// `src/core/proposed-inbox.test.ts` — the renderer + loader moved out
// of `cli/commands/status.ts` to support MCP parity, so the unit
// tests follow the implementation. See `proposed-inbox.test.ts` for
// renderer / loader coverage.
