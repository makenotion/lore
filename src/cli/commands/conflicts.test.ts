import { describe, expect, it, vi } from "vitest"
import {
  SCAN_RAW_CANDIDATE_CAP,
  parseScanCliOptions,
  renderScanJson,
  renderScanMarkdown,
  resolveScanProjects,
  runScan,
  type ScanCliOptions,
  type ScanReport,
  type ScanStats,
} from "./conflicts.js"
import type { LoreServices } from "../../services.js"
import type { Memory } from "../../types.js"
import * as conflictModule from "../../core/conflict.js"

/** Build a Memory shape with sane defaults. */
function memShape(overrides: Partial<Memory> & { id: string; title: string }): Memory {
  return {
    projectIds: ["P1"],
    topicId: null,
    source: "manual",
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
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

function scanStats(overrides: Partial<ScanStats> = {}): ScanStats {
  return {
    rawCandidateLimit: SCAN_RAW_CANDIDATE_CAP,
    rawCandidateLimitReached: false,
    rawCandidateLimitReachedProjects: [],
    rawCandidates: 0,
    dedupedCandidates: 0,
    alreadyJudgedCandidates: 0,
    survivingCandidates: 0,
    ...overrides,
  }
}

interface MakeServicesOpts {
  projectsByName?: Record<string, { id: string; name: string }>
  projectsList?: Array<{ id: string; name: string }>
  /** Aligned with projectIds passed to listForScan. */
  memoriesByProjectId?: Record<string, Memory[]>
}

/**
 * Build a `LoreServices`-shaped stub narrow to what `runScan` reads:
 * `projects.findByName` (when --project), `projects.list()` (vault-wide),
 * and `memories.listForScan`. Anything else is cast through `unknown`.
 */
function makeServices(opts: MakeServicesOpts): LoreServices {
  const findByName = vi.fn(async (name: string) => {
    return opts.projectsByName?.[name] ?? null
  })
  const list = vi.fn(async () => opts.projectsList ?? [])
  const listForScan = vi.fn(
    async (args: {
      projectIds: string[]
      projectLabels?: string[]
      includeBodies?: boolean
      onProgress?: (info: {
        projectId: string
        projectLabel: string
        pageIndex: number
        runningTotal: number
      }) => void
    }) => {
      const result: Memory[][] = []
      for (let i = 0; i < args.projectIds.length; i++) {
        const id = args.projectIds[i]!
        result.push(opts.memoriesByProjectId?.[id] ?? [])
      }
      return result
    }
  )
  return {
    projects: { findByName, list },
    memories: { listForScan },
  } as unknown as LoreServices
}

describe("parseScanCliOptions", () => {
  it("returns CONFLICT_PAIR_LIMIT default when --limit is omitted", () => {
    const result = parseScanCliOptions({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.limit).toBe(50)
      expect(result.value.rawLimit).toBeUndefined()
      expect(result.value.includeBodies).toBe(false)
      expect(result.value.json).toBe(false)
      expect(result.value.exhaustive).toBe(false)
    }
  })

  it("rejects --limit with a non-numeric string", () => {
    const result = parseScanCliOptions({ limit: "banana" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--limit")
  })

  it("rejects --limit below 1", () => {
    const result = parseScanCliOptions({ limit: "0" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("positive")
  })

  it("rejects --limit with a fractional component (3.7 → integer rejection, NOT silent floor to 3)", () => {
    // `parseInt("3.7", 10)` returns 3 silently, which would degrade
    // `--limit` from a strict gate into a coercion. The parser
    // string-validates with /^[0-9]+$/ so fractional inputs reject.
    const result = parseScanCliOptions({ limit: "3.7" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("decimal integer")
  })

  it("rejects --limit with a trailing alpha suffix (3abc → integer rejection, NOT silent truncation to 3)", () => {
    const result = parseScanCliOptions({ limit: "3abc" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("decimal integer")
  })

  it("rejects --limit in exponent notation (1e3 → integer rejection, NOT silent acceptance as 1000)", () => {
    // `Number("1e3")` returns 1000, which IS a valid integer and would
    // silently pass `Number.isInteger`. The string-side regex check
    // rejects exponent notation explicitly so an operator typing
    // `--limit 1e3` expecting an error gets one, not a 1000-pair scan.
    const result = parseScanCliOptions({ limit: "1e3" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("decimal integer")
  })

  it("rejects --limit with a leading sign (+5 / -5)", () => {
    // `Number("+5")` returns 5; `Number.isInteger(5)` passes — silent
    // acceptance. The regex requires bare decimal digits.
    const plus = parseScanCliOptions({ limit: "+5" })
    expect(plus.ok).toBe(false)
    const minus = parseScanCliOptions({ limit: "-5" })
    expect(minus.ok).toBe(false)
  })

  it("rejects --limit beyond Number.MAX_SAFE_INTEGER", () => {
    // The regex accepts arbitrarily long digit strings; the explicit
    // safe-integer check rejects what would silently lose precision.
    const result = parseScanCliOptions({ limit: "9999999999999999999" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("safe integer range")
  })

  it("accepts --limit with leading zeros (007 → 7, unconventional but unambiguous)", () => {
    const result = parseScanCliOptions({ limit: "007" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.limit).toBe(7)
  })

  it("accepts --raw-limit as an operator-controlled raw candidate cap", () => {
    const result = parseScanCliOptions({ rawLimit: "750" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.rawLimit).toBe(750)
  })

  it("rejects malformed --raw-limit values with the flag name", () => {
    const result = parseScanCliOptions({ rawLimit: "5.5" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.message).toContain("--raw-limit")
      expect(result.message).toContain("decimal integer")
    }
  })

  it("forwards boolean flags verbatim", () => {
    const result = parseScanCliOptions({
      project: "Mail",
      limit: "5",
      includeBodies: true,
      json: true,
      exhaustive: true,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual<ScanCliOptions>({
        projectName: "Mail",
        limit: 5,
        rawLimit: undefined,
        includeBodies: true,
        json: true,
        exhaustive: true,
      })
    }
  })
})

describe("resolveScanProjects", () => {
  it("returns the single project when --project resolves", async () => {
    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
    })
    const refs = await resolveScanProjects(services, "Mail")
    expect(refs).toEqual([{ id: "p-mail", label: "Mail" }])
  })

  it("throws with a 'lore status' hint when --project is unknown", async () => {
    const services = makeServices({ projectsByName: {} })
    await expect(resolveScanProjects(services, "Nope")).rejects.toThrow(
      /Project "Nope" not found.*lore status/
    )
  })

  it("scopes the all-projects branch to active projects (calls projects.list with 'active' status)", async () => {
    // Without the explicit "active" filter, archived projects walk
    // through the conflict-scan pipeline paying for paginated Memory
    // walks against retired contexts. `lore status projects` already
    // uses `-a` to opt INTO archived; the conflict scan inherits the
    // active-by-default convention.
    const list = vi.fn().mockResolvedValue([])
    const services = {
      projects: {
        findByName: vi.fn().mockResolvedValue(null),
        list,
      },
      memories: {},
    } as unknown as LoreServices

    await resolveScanProjects(services, undefined)
    expect(list).toHaveBeenCalledTimes(1)
    expect(list).toHaveBeenCalledWith("active")
  })

  it("returns every configured project when --project is omitted", async () => {
    const services = makeServices({
      projectsList: [
        { id: "p-1", name: "Alpha" },
        { id: "p-2", name: "Beta" },
      ],
    })
    const refs = await resolveScanProjects(services, undefined)
    expect(refs).toEqual([
      { id: "p-1", label: "Alpha" },
      { id: "p-2", label: "Beta" },
    ])
  })
})

describe("runScan — pipeline shape", () => {
  it("returns 0 pairs when the vault has no candidate pairs", async () => {
    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: {
        "p-mail": [memShape({ id: "m1", title: "Sole memory" })],
      },
    })
    const report = await runScan(services, {
      projectName: "Mail",
      limit: 50,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })
    expect(report.pairs).toEqual([])
  })

  it("surfaces a candidate pair with the expected per-pair shape", async () => {
    const m1 = memShape({
      id: "m1",
      title: "JWT auth model",
      projectIds: ["p-mail"],
      kind: "decision",
      synopsis: "Decided JWT.",
      keywords: "auth jwt",
      confidence: "likely",
      confidenceScore: 0.65,
    })
    const m2 = memShape({
      id: "m2",
      title: "JWT auth model",
      projectIds: ["p-mail"],
      kind: "decision",
      synopsis: "Switched away.",
      keywords: "auth session",
      confidence: "certain",
      confidenceScore: 0.84,
    })
    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: { "p-mail": [m1, m2] },
    })

    const report = await runScan(services, {
      projectName: "Mail",
      limit: 50,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })

    expect(report.pairs).toHaveLength(1)
    const pair = report.pairs[0]!
    expect(pair.memoryA.id).toBe("m1")
    expect(pair.memoryB.id).toBe("m2")
    expect(pair.memoryA.kind).toBe("decision")
    expect(pair.memoryB.kind).toBe("decision")
    expect(pair.memoryA.project).toBe("Mail")
    expect(pair.memoryA.synopsis).toBe("Decided JWT.")
    expect(pair.memoryA.keywords).toEqual(["auth", "jwt"])
    // No --include-bodies → no body field on the wire shape.
    expect(pair.memoryA.body).toBeUndefined()
    // Title trigrams match exactly (1.0); the blob also folds in
    // keywords, which differ ("auth jwt" vs "auth session"), so the
    // composite trigram score is between threshold and 1.0.
    expect(pair.similarity).toBeGreaterThan(conflictModule.CONFLICT_TRIGRAM_THRESHOLD)
  })

  it("filters pairs already in Compared With (state-aware filter the generator deliberately omits)", async () => {
    const m1 = memShape({
      id: "m1",
      title: "JWT auth model",
      comparedWith: ["m2"],
    })
    const m2 = memShape({
      id: "m2",
      title: "JWT auth model",
      comparedWith: ["m1"],
    })
    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: {
        "p-mail": [
          { ...m1, projectIds: ["p-mail"] },
          { ...m2, projectIds: ["p-mail"] },
        ],
      },
    })
    const report = await runScan(services, {
      projectName: "Mail",
      limit: 50,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })
    expect(report.pairs).toEqual([])
  })

  it("dedups multi-project pairs: one pair surfaced even when both memories share two projects", async () => {
    // Memory A in projects [X, Y]; Memory B in [X, Y]. Without dedup,
    // X's group emits the pair AND Y's group emits the pair — two
    // entries. Dedup-by-unordered-pair-key collapses to one.
    const m1 = memShape({
      id: "m1",
      title: "JWT auth model",
      projectIds: ["p-x", "p-y"],
    })
    const m2 = memShape({
      id: "m2",
      title: "JWT auth model",
      projectIds: ["p-x", "p-y"],
    })
    const services = makeServices({
      projectsList: [
        { id: "p-x", name: "X" },
        { id: "p-y", name: "Y" },
      ],
      memoriesByProjectId: {
        "p-x": [m1, m2],
        "p-y": [m1, m2],
      },
    })
    const report = await runScan(services, {
      projectName: undefined,
      limit: 50,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })
    expect(report.pairs).toHaveLength(1)
  })

  it("pipeline order is filter-before-truncate: 100 raw → 40 judged → 60 survivors → --limit 50 returns 50 of those 60", async () => {
    // Spec acceptance criterion: a fixture where 100 raw candidates
    // contain already-judged pairs that without filter-first would slip
    // through truncation. Mock findConflictCandidates so the test pins
    // pipeline ordering, NOT the generator's internal trigram logic.
    //
    // Setup: 100 candidates, similarity descending. The TOP-40 (highest
    // similarity) are pre-judged via `comparedWith`; the BOTTOM-60 are
    // unjudged. Under the correct pipeline (filter then truncate),
    // `--limit 50` returns 50 of the 60 unjudged pairs. Under a broken
    // `generate → sort → truncate → filter` pipeline, the truncation
    // would happen on the raw 100 (taking the top 50 = all 40 judged
    // + 10 unjudged), and filtering-after would drop the 40 judged
    // pairs, surfacing only 10. The two pipelines produce divergent
    // surfaced counts under this fixture: 50 vs 10. Either divergence
    // would fail the `length === 50` assertion below; the per-pair
    // `idx >= 40` assertion further pins that surfaced pairs come
    // from the unjudged half so a hypothetical pipeline that skipped
    // filtering altogether (50 surfaced, but 40 of them judged) would
    // also fail.
    const candidates = Array.from({ length: 100 }, (_, i) => {
      const judged = i < 40
      return {
        memoryA: memShape({
          id: `a${i}`,
          title: `t${i}`,
          comparedWith: judged ? [`b${i}`] : [],
        }),
        memoryB: memShape({
          id: `b${i}`,
          title: `t${i}`,
          comparedWith: judged ? [`a${i}`] : [],
        }),
        // Strictly descending similarity puts the judged candidates
        // at the front of the sort, which is the pre-truncation
        // failure mode the AC pins.
        similarity: 1 - i / 1000,
        signals: ["title trigram: 1.00"],
      }
    })
    const spy = vi.spyOn(conflictModule, "findConflictCandidates")
    spy.mockReturnValue(candidates)

    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: {
        "p-mail": [memShape({ id: "any", title: "any" })],
      },
    })
    const report = await runScan(services, {
      projectName: "Mail",
      limit: 50,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })

    // 60 unjudged survive the filter; --limit 50 budgets the surfaced
    // set to the top-50 of those 60.
    expect(report.pairs).toHaveLength(50)
    // Every surfaced pair must come from the unjudged half (i ≥ 40).
    for (const pair of report.pairs) {
      const idx = parseInt(pair.memoryA.id.slice(1), 10)
      expect(idx).toBeGreaterThanOrEqual(40)
    }
    spy.mockRestore()
  })

  it("requests one sentinel candidate beyond SCAN_RAW_CANDIDATE_CAP by default for cap detection", async () => {
    const spy = vi.spyOn(conflictModule, "findConflictCandidates")
    spy.mockReturnValue([])

    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: { "p-mail": [] },
    })
    await runScan(services, {
      projectName: "Mail",
      limit: 5,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })
    expect(spy).toHaveBeenCalledWith(expect.any(Array), {
      pairLimit: SCAN_RAW_CANDIDATE_CAP + 1,
    })
    spy.mockRestore()
  })

  it("requests one sentinel candidate beyond --raw-limit when provided for cap detection", async () => {
    const spy = vi.spyOn(conflictModule, "findConflictCandidates")
    spy.mockReturnValue([])

    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: { "p-mail": [] },
    })
    await runScan(services, {
      projectName: "Mail",
      limit: 5,
      rawLimit: 750,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })
    expect(spy).toHaveBeenCalledWith(expect.any(Array), { pairLimit: 751 })
    spy.mockRestore()
  })

  it("calls findConflictCandidates with pairLimit: Number.POSITIVE_INFINITY under --exhaustive", async () => {
    const spy = vi.spyOn(conflictModule, "findConflictCandidates")
    spy.mockReturnValue([])

    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: { "p-mail": [] },
    })
    await runScan(services, {
      projectName: "Mail",
      limit: 50,
      includeBodies: false,
      json: false,
      exhaustive: true,
    })
    expect(spy).toHaveBeenCalledWith(expect.any(Array), {
      pairLimit: Number.POSITIVE_INFINITY,
    })
    spy.mockRestore()
  })

  it("warns and ignores --raw-limit under --exhaustive", async () => {
    const spy = vi.spyOn(conflictModule, "findConflictCandidates")
    spy.mockReturnValue([])
    const messages: string[] = []

    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: { "p-mail": [] },
    })
    const report = await runScan(
      services,
      {
        projectName: "Mail",
        limit: 50,
        rawLimit: 1000,
        includeBodies: false,
        json: false,
        exhaustive: true,
      },
      (msg) => messages.push(msg)
    )

    expect(spy).toHaveBeenCalledWith(expect.any(Array), {
      pairLimit: Number.POSITIVE_INFINITY,
    })
    expect(report.stats.rawCandidateLimit).toBeNull()
    expect(messages.some((msg) => msg.includes("--raw-limit is ignored"))).toBe(true)
    spy.mockRestore()
  })

  it("forwards --include-bodies to MemoryService.listForScan and threads body through to wire shape", async () => {
    const m1 = memShape({
      id: "m1",
      title: "JWT auth model",
      content: "Body of m1",
    })
    const m2 = memShape({
      id: "m2",
      title: "JWT auth model",
      content: "Body of m2",
    })
    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: { "p-mail": [m1, m2] },
    })
    const report = await runScan(services, {
      projectName: "Mail",
      limit: 50,
      includeBodies: true,
      json: false,
      exhaustive: false,
    })

    const listForScanSpy = (
      services.memories as unknown as { listForScan: ReturnType<typeof vi.fn> }
    ).listForScan
    expect(listForScanSpy.mock.calls[0]![0].includeBodies).toBe(true)
    expect(report.pairs[0]!.memoryA.body).toBe("Body of m1")
    expect(report.pairs[0]!.memoryB.body).toBe("Body of m2")
  })

  it("scanId is a fresh UUID on each run", async () => {
    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: { "p-mail": [] },
    })
    const opts: ScanCliOptions = {
      projectName: "Mail",
      limit: 50,
      includeBodies: false,
      json: false,
      exhaustive: false,
    }
    const r1 = await runScan(services, opts)
    const r2 = await runScan(services, opts)
    expect(r1.scanId).not.toBe(r2.scanId)
    // RFC 4122 v4 UUID surface check.
    expect(r1.scanId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    )
  })

  it("emits progress lines via the injected log sink (not stderr/stdout directly)", async () => {
    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: { "p-mail": [] },
    })
    const messages: string[] = []
    // Replace the listForScan spy with one that fires progress events.
    const listForScan = vi.fn(
      async (args: {
        projectIds: string[]
        projectLabels?: string[]
        onProgress?: (info: {
          projectId: string
          projectLabel: string
          pageIndex: number
          runningTotal: number
        }) => void
      }) => {
        if (args.onProgress) {
          args.onProgress({
            projectId: args.projectIds[0]!,
            projectLabel: args.projectLabels?.[0] ?? args.projectIds[0]!,
            pageIndex: 1,
            runningTotal: 42,
          })
        }
        return [[]]
      }
    )
    ;(services.memories as unknown as { listForScan: typeof listForScan }).listForScan =
      listForScan

    await runScan(
      services,
      {
        projectName: "Mail",
        limit: 50,
        includeBodies: false,
        json: false,
        exhaustive: false,
      },
      (msg) => messages.push(msg)
    )
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain("Mail")
    expect(messages[0]).toContain("page 1")
    expect(messages[0]).toContain("42 memories")
  })

  it("batched convergence: 150 candidates against --limit 50 takes 3 cycles to drain", async () => {
    // Mock findConflictCandidates to return 150 deterministic pairs.
    // Real-fixture testing here is hostile: the trigram threshold is
    // 0.25 and short shared-prefix titles ("Topic 0" / "Topic 1")
    // exceed it, producing thousands of cross-topic pairs. The
    // pipeline behavior under test (--limit 50 truncation +
    // comparedWith filtering across cycles) is independent of the
    // generator's internals — pin it directly.
    const allPairs = Array.from({ length: 150 }, (_, i) => ({
      memoryA: memShape({ id: `a${i}`, title: `t${i}`, projectIds: ["p-mail"] }),
      memoryB: memShape({ id: `b${i}`, title: `t${i}`, projectIds: ["p-mail"] }),
      similarity: 1 - i / 1000,
      signals: ["title trigram: 1.00"],
    }))
    const judged = new Set<string>()
    const spy = vi.spyOn(conflictModule, "findConflictCandidates")
    spy.mockImplementation(() => {
      // Reflect the per-cycle judged set onto the candidate list so
      // the comparedWith filter inside runScan drops the right ones.
      return allPairs.map((p) => ({
        ...p,
        memoryA: {
          ...p.memoryA,
          comparedWith: judged.has(p.memoryA.id) ? [p.memoryB.id] : [],
        },
        memoryB: {
          ...p.memoryB,
          comparedWith: judged.has(p.memoryB.id) ? [p.memoryA.id] : [],
        },
      }))
    })

    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: {
        "p-mail": [memShape({ id: "any", title: "any" })],
      },
    })

    const surfacedCounts: number[] = []
    for (let cycle = 0; cycle < 4; cycle++) {
      const report = await runScan(services, {
        projectName: "Mail",
        limit: 50,
        includeBodies: false,
        json: false,
        exhaustive: false,
      })
      surfacedCounts.push(report.pairs.length)
      for (const pair of report.pairs) {
        judged.add(pair.memoryA.id)
        judged.add(pair.memoryB.id)
      }
    }
    expect(surfacedCounts).toEqual([50, 50, 50, 0])
    spy.mockRestore()
  })

  it("bounded coverage limitation: 600 lexical candidates with default cap surfaces ≤500 across all cycles", async () => {
    // Stub findConflictCandidates so we can pin the cap behavior
    // without simulating every trigram-overlap path. This is the
    // tightest test of the AC: under default cap, candidates ranked
    // 501+ never reach the post-filter pipeline.
    const candidates = Array.from({ length: 600 }, (_, i) => ({
      memoryA: memShape({ id: `a${i}`, title: `t${i}` }),
      memoryB: memShape({ id: `b${i}`, title: `t${i}` }),
      similarity: 1 - i / 1000,
      signals: ["title trigram: 1.00"],
    }))
    const spy = vi.spyOn(conflictModule, "findConflictCandidates")
    spy.mockImplementation((_memories, options) => {
      const cap = options?.pairLimit ?? 50
      return candidates.slice(0, cap)
    })

    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: {
        "p-mail": [memShape({ id: "any", title: "any" })],
      },
    })

    const r1 = await runScan(services, {
      projectName: "Mail",
      limit: 1000,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })
    expect(r1.pairs).toHaveLength(SCAN_RAW_CANDIDATE_CAP)
    expect(r1.stats.rawCandidateLimitReached).toBe(true)

    const r2 = await runScan(services, {
      projectName: "Mail",
      limit: 1000,
      rawLimit: 600,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })
    expect(r2.pairs).toHaveLength(600)

    const r3 = await runScan(services, {
      projectName: "Mail",
      limit: 1000,
      includeBodies: false,
      json: false,
      exhaustive: true,
    })
    expect(r3.pairs).toHaveLength(600)

    spy.mockRestore()
  })

  it("resumes beyond the first raw window when already-judged pairs consume the default cap", async () => {
    const candidates = Array.from({ length: SCAN_RAW_CANDIDATE_CAP + 25 }, (_, i) => {
      const judged = i < SCAN_RAW_CANDIDATE_CAP
      return {
        memoryA: memShape({
          id: `a${i}`,
          title: `t${i}`,
          comparedWith: judged ? [`b${i}`] : [],
        }),
        memoryB: memShape({
          id: `b${i}`,
          title: `t${i}`,
          comparedWith: judged ? [`a${i}`] : [],
        }),
        similarity: 1 - i / 1000,
        signals: ["title trigram: 1.00"],
      }
    })
    const spy = vi.spyOn(conflictModule, "findConflictCandidates")
    spy.mockImplementation((_memories, options) => {
      const cap = options?.pairLimit ?? 50
      return candidates.slice(0, cap)
    })

    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: {
        "p-mail": [memShape({ id: "any", title: "any" })],
      },
    })

    const firstWindow = await runScan(services, {
      projectName: "Mail",
      limit: 50,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })
    expect(firstWindow.pairs).toEqual([])
    expect(firstWindow.stats.rawCandidateLimitReached).toBe(true)
    expect(firstWindow.stats.alreadyJudgedCandidates).toBe(SCAN_RAW_CANDIDATE_CAP)

    const followUp = await runScan(services, {
      projectName: "Mail",
      limit: 50,
      rawLimit: SCAN_RAW_CANDIDATE_CAP + 25,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })
    expect(followUp.pairs).toHaveLength(25)
    expect(followUp.pairs[0]!.memoryA.id).toBe(`a${SCAN_RAW_CANDIDATE_CAP}`)

    spy.mockRestore()
  })

  it("does not mark the raw limit reached when the generator exhausts exactly at the requested window", async () => {
    const candidates = Array.from({ length: SCAN_RAW_CANDIDATE_CAP }, (_, i) => ({
      memoryA: memShape({
        id: `a${i}`,
        title: `t${i}`,
        comparedWith: [`b${i}`],
      }),
      memoryB: memShape({
        id: `b${i}`,
        title: `t${i}`,
        comparedWith: [`a${i}`],
      }),
      similarity: 1 - i / 1000,
      signals: ["title trigram: 1.00"],
    }))
    const spy = vi.spyOn(conflictModule, "findConflictCandidates")
    spy.mockImplementation((_memories, options) => {
      const cap = options?.pairLimit ?? 50
      return candidates.slice(0, cap)
    })

    const services = makeServices({
      projectsByName: { Mail: { id: "p-mail", name: "Mail" } },
      memoriesByProjectId: {
        "p-mail": [memShape({ id: "any", title: "any" })],
      },
    })

    const report = await runScan(services, {
      projectName: "Mail",
      limit: 50,
      includeBodies: false,
      json: false,
      exhaustive: false,
    })

    expect(report.pairs).toEqual([])
    expect(report.stats.rawCandidates).toBe(SCAN_RAW_CANDIDATE_CAP)
    expect(report.stats.rawCandidateLimitReached).toBe(false)

    spy.mockRestore()
  })
})

describe("renderScanJson", () => {
  function buildReport(overrides: Partial<ScanReport> = {}): ScanReport {
    return {
      scanId: "test-scan-id",
      scannedAt: "2026-04-30T12:34:56.000Z",
      promptVersion: "1",
      stats: scanStats(),
      pairs: [],
      ...overrides,
    }
  }

  it("emits a top-level compareContract block listing asymmetric and symmetric verdicts", () => {
    const out = JSON.parse(renderScanJson(buildReport()))
    expect(out.compareContract.tool).toBe("lore-memory")
    expect(out.compareContract.action).toBe("compare")
    expect(out.compareContract.verdicts.asymmetric).toEqual([
      "conflicts_with",
      "supersedes",
    ])
    expect(out.compareContract.verdicts.symmetric).toEqual([
      "scoped",
      "related",
      "compatible",
      "not_conflict",
    ])
  })

  it("emits scan stats for programmatic no-results handling", () => {
    const out = JSON.parse(
      renderScanJson(
        buildReport({
          stats: scanStats({
            rawCandidateLimit: 750,
            rawCandidateLimitReached: true,
            rawCandidateLimitReachedProjects: ["Mail"],
            alreadyJudgedCandidates: 750,
          }),
        })
      )
    )
    expect(out.stats.rawCandidateLimit).toBe(750)
    expect(out.stats.rawCandidateLimitReached).toBe(true)
    expect(out.stats.rawCandidateLimitReachedProjects).toEqual(["Mail"])
  })

  it("documents direction rules (unordered labels, affectedMemoryId for asymmetric, supersedes-decision)", () => {
    const out = JSON.parse(renderScanJson(buildReport()))
    const rules: string[] = out.compareContract.directionRules
    expect(rules.some((r) => r.includes("unordered labels"))).toBe(true)
    expect(rules.some((r) => r.includes("affectedMemoryId"))).toBe(true)
    expect(rules.some((r) => r.includes("kind='decision'"))).toBe(true)
  })

  it("includes a back-reference to the docs for verdictDefinitions (not the definitions themselves)", () => {
    const out = JSON.parse(renderScanJson(buildReport()))
    expect(out.compareContract.verdictDefinitions).toContain("docs/memory-workflows.md#conflict-verdicts")
  })

  it("each pair entry carries kind for both memories so the agent can validate supersedes-decision client-side", () => {
    const out = JSON.parse(
      renderScanJson(
        buildReport({
          pairs: [
            {
              memoryA: {
                id: "m1",
                title: "A",
                project: "Mail",
                kind: "decision",
                confidence: "certain",
                confidenceScore: 0.9,
                synopsis: "",
                keywords: [],
              },
              memoryB: {
                id: "m2",
                title: "B",
                project: "Mail",
                kind: "note",
                confidence: "certain",
                confidenceScore: null,
                synopsis: "",
                keywords: [],
              },
              similarity: 0.78,
              signals: ["title trigram: 0.78"],
            },
          ],
        })
      )
    )
    expect(out.pairs[0].memoryA.kind).toBe("decision")
    expect(out.pairs[0].memoryB.kind).toBe("note")
  })

  it("emits parseable JSON ending with a newline (clean for shell pipes)", () => {
    const text = renderScanJson(buildReport())
    expect(text.endsWith("\n")).toBe(true)
    expect(() => JSON.parse(text)).not.toThrow()
  })
})

describe("renderScanMarkdown", () => {
  it("emits a 0-pair report with the verdict-vocabulary header and a no-pairs body", () => {
    const md = renderScanMarkdown({
      scanId: "id-1",
      scannedAt: "2026-04-30T12:34:56.000Z",
      promptVersion: "1",
      stats: scanStats(),
      pairs: [],
    })
    // Plural "pairs" when length === 0 (English plural for zero
    // counts; matches the spec's example "0 pairs surfaced").
    expect(md).toContain("0 pairs surfaced")
    expect(md).toContain("docs/memory-workflows.md#conflict-verdicts")
    expect(md).toContain("lore-memory action='compare'")
    expect(md).toContain("No candidate pairs to surface")
    expect(md).toContain("exhausted the scan scope")
    expect(md.endsWith("\n")).toBe(true)
  })

  it("emits a bounded-window no-pairs message with a --raw-limit continuation hint", () => {
    const md = renderScanMarkdown({
      scanId: "id-1",
      scannedAt: "2026-04-30T12:34:56.000Z",
      promptVersion: "1",
      stats: scanStats({
        rawCandidateLimit: SCAN_RAW_CANDIDATE_CAP,
        rawCandidateLimitReached: true,
        rawCandidateLimitReachedProjects: ["Mail"],
        rawCandidates: SCAN_RAW_CANDIDATE_CAP,
        dedupedCandidates: SCAN_RAW_CANDIDATE_CAP,
        alreadyJudgedCandidates: SCAN_RAW_CANDIDATE_CAP,
        survivingCandidates: 0,
      }),
      pairs: [],
    })
    expect(md).toContain("hit the raw-candidate limit")
    expect(md).toContain("Mail")
    expect(md).toContain("--raw-limit <higher n>")
    expect(md).toContain("--exhaustive")
  })

  it("emits a 1-pair report with action prompt + per-memory metadata + signals", () => {
    const md = renderScanMarkdown({
      scanId: "id-1",
      scannedAt: "2026-04-30T12:34:56.000Z",
      promptVersion: "1",
      stats: scanStats(),
      pairs: [
        {
          memoryA: {
            id: "m1",
            title: "JWT auth model",
            project: "Mail",
            kind: "decision",
            confidence: "likely",
            confidenceScore: 0.65,
            synopsis: "Decided JWT.",
            keywords: ["auth", "jwt"],
          },
          memoryB: {
            id: "m2",
            title: "Switched auth to session cookies",
            project: "Mail",
            kind: "decision",
            confidence: "certain",
            confidenceScore: 0.84,
            synopsis: "Replaced JWT.",
            keywords: ["auth", "session"],
          },
          similarity: 0.78,
          signals: ["title trigram: 0.78", "shared tags: auth"],
        },
      ],
    })
    // Singular "pair" when length === 1; plural "pairs" otherwise.
    expect(md).toContain("1 pair surfaced")
    expect(md).not.toContain("1 pairs surfaced")
    expect(md).toContain("Pair 1 — similarity 0.78")
    expect(md).toContain("Scan stats")
    expect(md).toContain("Raw candidate limit")
    expect(md).toContain("Raw candidates retained")
    expect(md).toContain('Memory A: "JWT auth model"')
    expect(md).toContain('Memory B: "Switched auth to session cookies"')
    expect(md).toContain("score 0.65")
    expect(md).toContain("score 0.84")
    // Each signal renders as its own bullet line so a future caller-
    // controlled signal containing a literal `;` can't ambiguate the
    // separator.
    expect(md).toContain("- title trigram: 0.78")
    expect(md).toContain("- shared tags: auth")
    // The action prompt names the compare tool.
    expect(md).toContain("call `lore-memory action='compare'`")
    // Output ends with a trailing newline regardless of pair count.
    expect(md.endsWith("\n")).toBe(true)
  })

  it("renders body fences when --include-bodies populated body field", () => {
    const md = renderScanMarkdown({
      scanId: "id-1",
      scannedAt: "2026-04-30T12:34:56.000Z",
      promptVersion: "1",
      stats: scanStats(),
      pairs: [
        {
          memoryA: {
            id: "m1",
            title: "Title A",
            project: "Mail",
            kind: "note",
            confidence: "certain",
            confidenceScore: null,
            synopsis: "",
            keywords: [],
            body: "Full body of A.",
          },
          memoryB: {
            id: "m2",
            title: "Title B",
            project: "Mail",
            kind: "note",
            confidence: "certain",
            confidenceScore: null,
            synopsis: "",
            keywords: [],
            body: "Full body of B.",
          },
          similarity: 0.5,
          signals: ["title trigram: 0.50"],
        },
      ],
    })
    expect(md).toContain("```markdown")
    expect(md).toContain("Full body of A.")
    expect(md).toContain("Full body of B.")
  })

  it("uses a dynamically longer fence when the body contains triple backticks (CommonMark fence-length rule)", () => {
    // A memory body containing its own fenced code block (3 backticks)
    // would close a fixed-3-backtick outer fence early and corrupt the
    // prompt-ready report. The renderer measures the longest backtick
    // run in the body and emits an outer fence of length `n + 1`
    // (minimum 3), which CommonMark guarantees can only be closed by a
    // fence of equal-or-greater length.
    const bodyWithFencedBlock = [
      "Pre-fence text.",
      "```javascript",
      "console.log('hello')",
      "```",
      "Post-fence text.",
    ].join("\n")
    const md = renderScanMarkdown({
      scanId: "id-1",
      scannedAt: "2026-04-30T12:34:56.000Z",
      promptVersion: "1",
      stats: scanStats(),
      pairs: [
        {
          memoryA: {
            id: "m1",
            title: "Title A",
            project: "Mail",
            kind: "note",
            confidence: "certain",
            confidenceScore: null,
            synopsis: "",
            keywords: [],
            body: bodyWithFencedBlock,
          },
          memoryB: {
            id: "m2",
            title: "Title B",
            project: "Mail",
            kind: "note",
            confidence: "certain",
            confidenceScore: null,
            synopsis: "",
            keywords: [],
            body: "Plain body, no backticks.",
          },
          similarity: 0.5,
          signals: ["title trigram: 0.50"],
        },
      ],
    })
    // The body's inner fence is 3 backticks, so the outer fence MUST
    // be ≥ 4 backticks. A 3-backtick outer fence would have closed at
    // the body's `\`\`\`javascript` line.
    expect(md).toContain("````markdown")
    expect(md).toContain("```javascript")
    expect(md).toContain("Pre-fence text.")
    expect(md).toContain("Post-fence text.")
    // Memory B's plain body uses the minimum 3-backtick fence.
    expect(md).toContain("```markdown\nPlain body, no backticks.\n```")
  })
})
