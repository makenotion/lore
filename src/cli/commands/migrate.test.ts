import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Fact, Memory } from "../../types.js"
import type { TopicAliasMergeResult } from "../../core/topic-merge.js"
import {
  backfillFactSources,
  formatBackfillBucket,
  loadTopicAliasMerges,
  migrateCommand,
  parseSynopsisBackend,
  parseSynopsisBatchSize,
  printAliasMergeResults,
  printDiscoveryBreadcrumb,
  proposeSourceMemory,
  resolveMigrationProjectScope,
  runAgentNormalization,
  runBuildConfidenceScores,
  runBuildEntitiesMigration,
  runFactEncodingFix,
  runMemoryEncodingFix,
  runOrphanRateReport,
  runSynopsisBackfill,
  summarizeConfidenceScorePlan,
} from "./migrate.js"
import { migrationLockPath } from "../migration-lock.js"
import type { BuildConfidenceScoresPlan } from "../../core/confidence-migration.js"
import { DEFAULT_SYNOPSIS_BATCH_SIZE } from "../../core/synopsis-backfill.js"
import type { BackfillReport } from "../../core/synopsis-backfill.js"

function makeFact(id: string, overrides: Partial<Fact> = {}): Fact {
  return {
    id,
    subject: "AuthService",
    predicate: "uses",
    object: "JWT",
    projectIds: [],
    validFrom: "2026-04-20",
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: null,
    confidence: "certain",
    createdAt: "2026-04-20T00:00:00.000Z",
    subjectEntityId: null,
    objectEntityId: null,
    ...overrides,
  }
}

function makeMemory(id: string, overrides: Partial<Memory> = {}): Memory {
  return {
    id,
    title: `Memory ${id}`,
    projectIds: [],
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

describe("migrateCommand help", () => {
  it("links project-scoped migration recovery flags to the unscoped-write docs", () => {
    const help = migrateCommand.helpInformation()
    expect(help).toContain("--project <name>")
    expect(help).toContain("--include-archived")
    expect(help).toContain("--allow-unscoped")
    expect(help).toContain("docs/memory-workflows.md#migrating-from-unscoped-writes")
  })

  it("documents --report-orphan-rate alongside --build-entities", () => {
    const help = migrateCommand.helpInformation()
    expect(help).toContain("--report-orphan-rate")
    expect(help).toContain("LORE_USE_RUNTOOL_AGGREGATE")
  })
})

describe("resolveMigrationProjectScope", () => {
  function makeScopeServices(
    resolveByName: (
      name: string,
      options?: { includeArchived?: boolean }
    ) => Promise<
      | { kind: "resolved"; project: { id: string; name: string } }
      | { kind: "missing" }
      | { kind: "transient-error"; cause: unknown }
    >
  ) {
    return {
      projects: {
        resolveByName: vi.fn(resolveByName),
        findByName: vi.fn(),
      },
    } as unknown as Parameters<typeof resolveMigrationProjectScope>[0]
  }

  it("returns empty scope when no project-capable migration flag is present", async () => {
    const services = makeScopeServices(async () => ({
      kind: "resolved",
      project: { id: "unused", name: "Unused" },
    }))

    await expect(
      resolveMigrationProjectScope(services, { project: "Mail" })
    ).resolves.toEqual({})
    expect(services.projects.resolveByName).not.toHaveBeenCalled()
  })

  it("resolves archived projects only when --include-archived is supplied", async () => {
    const services = makeScopeServices(async (name) => ({
      kind: "resolved",
      project: { id: "project-archive", name },
    }))

    const scope = await resolveMigrationProjectScope(services, {
      fixMemoryEncoding: true,
      project: "Archive",
      includeArchived: true,
    })

    expect(scope).toEqual({ projectId: "project-archive", projectName: "Archive" })
    expect(services.projects.resolveByName).toHaveBeenCalledWith("Archive", {
      includeArchived: true,
    })
  })

  it("adds docs and include-archived recovery hints when project resolution misses", async () => {
    const services = makeScopeServices(async () => ({ kind: "missing" }))

    await expect(
      resolveMigrationProjectScope(services, {
        fixFactEncoding: true,
        project: "Archive",
      })
    ).rejects.toThrow(
      /Project "Archive" could not be resolved.*--include-archived.*docs\/memory-workflows\.md#migrating-from-unscoped-writes/
    )
  })

  it("preserves retryable transient project-resolution failures", async () => {
    const services = makeScopeServices(async () => ({
      kind: "transient-error",
      cause: Object.assign(new Error("rate_limited"), { status: 429 }),
    }))

    await expect(
      resolveMigrationProjectScope(services, {
        buildEntities: true,
        project: "Mail",
      })
    ).rejects.toMatchObject({
      code: "transient_project_resolution",
      retryable: true,
    })
  })
})

describe("proposeSourceMemory", () => {
  it("matches a memory whose title contains the fact subject as a whole word", async () => {
    const fact = makeFact("fact-1", { subject: "AuthService", object: "JWT" })
    const memories = {
      search: vi
        .fn()
        .mockResolvedValue([makeMemory("mem-1", { title: "AuthService retry policy" })]),
    }

    const candidate = await proposeSourceMemory({ memories } as never, fact)
    expect(candidate.memory?.id).toBe("mem-1")
    expect(candidate.reason).toContain("AuthService")
  })

  it("falls back to object search when subject finds no title match", async () => {
    const fact = makeFact("fact-2", { subject: "AuthService", object: "JWTLibrary" })
    const memories = {
      search: vi
        .fn()
        // First search (subject) returns a non-matching title.
        .mockResolvedValueOnce([makeMemory("mem-x", { title: "Unrelated topic" })])
        // Second search (object) returns a matching title.
        .mockResolvedValueOnce([makeMemory("mem-2", { title: "JWTLibrary review" })]),
    }

    const candidate = await proposeSourceMemory({ memories } as never, fact)
    expect(candidate.memory?.id).toBe("mem-2")
    expect(candidate.reason).toContain("JWTLibrary")
  })

  it("rejects short-token queries that would over-match on common substrings", async () => {
    // A three-letter subject like "API" would otherwise match any title
    // containing "api". The guard requires length >= 4 or a space.
    const fact = makeFact("fact-3", { subject: "API", object: "X" })
    const memories = {
      search: vi
        .fn()
        .mockResolvedValue([
          makeMemory("mem-overmatch", { title: "API design checklist" }),
        ]),
    }

    const candidate = await proposeSourceMemory({ memories } as never, fact)
    expect(candidate.memory).toBeNull()
    // Neither subject nor object triggered a search — both are too short.
    expect(memories.search).not.toHaveBeenCalled()
  })

  it("requires a word-boundary match so substrings inside other words don't count", async () => {
    // Subject "auth" is 4 chars so passes the length guard, but the title
    // contains "authentic", not "auth" as a discrete token.
    const fact = makeFact("fact-4", { subject: "auth", object: "x" })
    const memories = {
      search: vi
        .fn()
        .mockResolvedValue([
          makeMemory("mem-inside", { title: "authentic voice design" }),
        ]),
    }

    const candidate = await proposeSourceMemory({ memories } as never, fact)
    expect(candidate.memory).toBeNull()
  })

  it("searches across every project the fact is linked to, not just the first", async () => {
    const fact = makeFact("fact-5", {
      subject: "AuthService",
      object: "JWT",
      projectIds: ["proj-a", "proj-b"],
    })
    const searchCalls: Array<{ projectId: string | undefined }> = []
    const memories = {
      search: vi.fn().mockImplementation(async ({ projectId }) => {
        searchCalls.push({ projectId })
        // First project returns nothing relevant; second returns a match.
        if (projectId === "proj-b") {
          return [makeMemory("mem-b", { title: "AuthService handoff" })]
        }
        return []
      }),
    }

    const candidate = await proposeSourceMemory({ memories } as never, fact)
    expect(candidate.memory?.id).toBe("mem-b")
    expect(searchCalls.map((c) => c.projectId)).toEqual(["proj-a", "proj-b"])
  })

  it("handles facts with no project scope by passing undefined projectId", async () => {
    const fact = makeFact("fact-6", {
      subject: "AuthService",
      object: "JWT",
      projectIds: [],
    })
    const memories = {
      search: vi.fn().mockResolvedValue([]),
    }

    const candidate = await proposeSourceMemory({ memories } as never, fact)
    expect(candidate.memory).toBeNull()
    expect(memories.search).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined })
    )
  })
})

describe("backfillFactSources", () => {
  function makeServices(overrides: Record<string, unknown> = {}) {
    return {
      facts: {
        queryOrphans: vi.fn().mockResolvedValue([]),
        setSource: vi.fn(),
      },
      memories: {
        search: vi.fn().mockResolvedValue([]),
      },
      ...overrides,
    }
  }

  it("reports no-op when the vault has no orphan facts", async () => {
    const services = makeServices()
    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })

    await backfillFactSources(services as never, { apply: false })
    log.mockRestore()

    expect(logs.some((l) => l.includes("No orphan facts"))).toBe(true)
    expect(services.facts.setSource as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it("does not write any Source relation when apply is false", async () => {
    // Read-only default: the operator reviews the proposed matches before
    // committing anything. The safety guarantee has to hold end-to-end, not
    // just in the helper that prints the report.
    const orphan = makeFact("fact-1", { subject: "AuthService" })
    const match = makeMemory("mem-1", { title: "AuthService retry policy" })

    const services = makeServices({
      facts: {
        queryOrphans: vi.fn().mockResolvedValue([orphan]),
        setSource: vi.fn(),
      },
      memories: {
        search: vi.fn().mockResolvedValue([match]),
      },
    })

    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await backfillFactSources(services as never, { apply: false })
    log.mockRestore()

    expect(services.facts.setSource).not.toHaveBeenCalled()
  })

  it("writes the Source relation for each matched orphan when apply is true", async () => {
    const orphanA = makeFact("fact-A", { subject: "AuthService" })
    const orphanB = makeFact("fact-B", { subject: "Scheduler" })
    const memA = makeMemory("mem-A", { title: "AuthService retry policy" })
    const memB = makeMemory("mem-B", { title: "Scheduler cutover" })

    const services = makeServices({
      facts: {
        queryOrphans: vi.fn().mockResolvedValue([orphanA, orphanB]),
        setSource: vi.fn(),
      },
      memories: {
        search: vi.fn().mockImplementation(async ({ query }) => {
          if (query === "AuthService") return [memA]
          if (query === "Scheduler") return [memB]
          return []
        }),
      },
    })

    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await backfillFactSources(services as never, { apply: true })
    log.mockRestore()

    expect(services.facts.setSource).toHaveBeenCalledTimes(2)
    expect(services.facts.setSource).toHaveBeenCalledWith("fact-A", "mem-A")
    expect(services.facts.setSource).toHaveBeenCalledWith("fact-B", "mem-B")
  })

  it("passes projectId to orphan discovery when migration scope is explicit", async () => {
    const services = makeServices()
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    await backfillFactSources(services as never, {
      apply: false,
      projectId: "project-mail",
    })
    log.mockRestore()

    expect(services.facts.queryOrphans).toHaveBeenCalledWith({
      projectId: "project-mail",
    })
  })

  it("leaves unmatched orphans alone even with apply=true", async () => {
    // Three orphans, only one gets a conservative title match. The other
    // two must remain orphaned rather than being force-linked to whatever
    // the search returned.
    const matched = makeFact("fact-match", { subject: "AuthService" })
    const unmatched1 = makeFact("fact-none-1", { subject: "API", object: "X" }) // too short
    const unmatched2 = makeFact("fact-none-2", { subject: "Scheduler" }) // no search hit

    const services = makeServices({
      facts: {
        queryOrphans: vi.fn().mockResolvedValue([matched, unmatched1, unmatched2]),
        setSource: vi.fn(),
      },
      memories: {
        search: vi.fn().mockImplementation(async ({ query }) => {
          if (query === "AuthService") {
            return [makeMemory("mem-ok", { title: "AuthService handoff" })]
          }
          return []
        }),
      },
    })

    const log = vi.spyOn(console, "log").mockImplementation(() => {})
    await backfillFactSources(services as never, { apply: true })
    log.mockRestore()

    expect(services.facts.setSource).toHaveBeenCalledTimes(1)
    expect(services.facts.setSource).toHaveBeenCalledWith("fact-match", "mem-ok")
  })
})

describe("runFactEncodingFix", () => {
  it("reports nothing-to-do on a clean vault", async () => {
    const services = {
      facts: {
        fixEncoding: vi
          .fn()
          .mockResolvedValue({ encoded: [], collisions: [], fixes: [] }),
      },
    }

    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
    await runFactEncodingFix(services as never, { apply: true })
    log.mockRestore()

    expect(services.facts.fixEncoding).toHaveBeenCalledWith({ dryRun: false })
    expect(logs.some((l) => l.includes("No HTML-encoded fact rows"))).toBe(true)
  })

  it("default (no --yes) is plan-only and surfaces the re-run footer", async () => {
    // Plan-then-execute: bare `--fix-fact-encoding` MUST NOT write. The
    // underlying helper is called with `dryRun: true` and the output
    // ends with the "Re-run with --yes" directive.
    const encoded = [
      {
        id: "f1",
        rawSubject: "Build &amp; Tooling",
        rawObject: "Rollup",
        decodedSubject: "Build & Tooling",
        decodedObject: "Rollup",
        rawDedupKey: "",
        decodedDedupKey: "abc",
        predicate: "uses",
      },
    ]
    const services = {
      facts: {
        fixEncoding: vi.fn().mockResolvedValue({ encoded, collisions: [], fixes: [] }),
      },
    }

    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
    await runFactEncodingFix(services as never, { apply: false })
    log.mockRestore()

    expect(services.facts.fixEncoding).toHaveBeenCalledWith({ dryRun: true })
    expect(logs.some((l) => l.includes("Would decode 1 HTML-encoded fact"))).toBe(true)
    expect(logs.some((l) => l.includes("Re-run with `--yes`"))).toBe(true)
  })

  it("--dry-run prints the same plan output and still carries the --yes directive", async () => {
    // `--dry-run` and the bare default both route to `dryRun: true`
    // under the hood. Both paths emit the "Re-run with --yes" footer
    // because the global migrate action suppresses its generic
    // "Re-run without --dry-run" footer when an encoding flag is
    // present, so operators always see exactly one apply instruction.
    const encoded = [
      {
        id: "f1",
        rawSubject: "A &amp; B",
        rawObject: "x",
        decodedSubject: "A & B",
        decodedObject: "x",
        rawDedupKey: "",
        decodedDedupKey: "abc",
        predicate: "uses",
      },
    ]
    const services = {
      facts: {
        fixEncoding: vi.fn().mockResolvedValue({ encoded, collisions: [], fixes: [] }),
      },
    }

    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
    await runFactEncodingFix(services as never, { apply: false, dryRun: true })
    log.mockRestore()

    expect(services.facts.fixEncoding).toHaveBeenCalledWith({ dryRun: true })
    expect(logs.some((l) => l.includes("Would decode 1 HTML-encoded fact"))).toBe(true)
    expect(logs.some((l) => l.includes("Re-run with `--yes`"))).toBe(true)
  })

  it("--yes forwards dryRun=false and labels the output as applied", async () => {
    const encoded = [
      {
        id: "f1",
        rawSubject: "Build &amp; Tooling",
        rawObject: "Rollup",
        decodedSubject: "Build & Tooling",
        decodedObject: "Rollup",
        rawDedupKey: "",
        decodedDedupKey: "abc",
        predicate: "uses",
      },
    ]
    const services = {
      facts: {
        fixEncoding: vi.fn().mockResolvedValue({
          encoded,
          collisions: [],
          fixes: [encoded[0]],
        }),
      },
    }

    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
    await runFactEncodingFix(services as never, { apply: true })
    log.mockRestore()

    expect(services.facts.fixEncoding).toHaveBeenCalledWith({ dryRun: false })
    expect(logs.some((l) => l.includes("Decoded 1 HTML-encoded fact"))).toBe(true)
  })

  it("threads explicit projectId into the fact encoding service", async () => {
    const services = {
      facts: {
        fixEncoding: vi
          .fn()
          .mockResolvedValue({ encoded: [], collisions: [], fixes: [] }),
      },
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    await runFactEncodingFix(services as never, {
      apply: false,
      projectId: "project-mail",
    })
    log.mockRestore()

    expect(services.facts.fixEncoding).toHaveBeenCalledWith({
      dryRun: true,
      projectId: "project-mail",
    })
  })

  it("surfaces the dedup-key collision gate and points operators at --dedup-keys --merge --yes", async () => {
    const encoded = [
      {
        id: "f-encoded",
        rawSubject: "Build &amp; Tooling",
        rawObject: "Rollup",
        decodedSubject: "Build & Tooling",
        decodedObject: "Rollup",
        rawDedupKey: "",
        decodedDedupKey: "abc",
        predicate: "uses",
      },
    ]
    const collisions = [
      {
        decodedDedupKey: "abc",
        triple: { subject: "Build & Tooling", predicate: "uses", object: "Rollup" },
        factIds: ["f-clean", "f-encoded"],
      },
    ]
    const services = {
      facts: {
        fixEncoding: vi.fn().mockResolvedValue({ encoded, collisions, fixes: [] }),
      },
    }

    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
    await runFactEncodingFix(services as never, { apply: true })
    log.mockRestore()

    // Tally line reports 0 applied despite 1 encoded row, matching the gate.
    expect(
      logs.some(
        (l) =>
          l.includes("Decoded 0 HTML-encoded fact") && l.includes("1 collision group")
      )
    ).toBe(true)
    // Directive for the operator is present.
    expect(logs.some((l) => l.includes("--dedup-keys --merge --yes"))).toBe(true)
  })
})

describe("runMemoryEncodingFix", () => {
  it("default (no --yes) is plan-only and surfaces the re-run footer", async () => {
    const encoded = [
      {
        id: "m1",
        rawTitle: "Build &amp; Tooling",
        decodedTitle: "Build & Tooling",
        titleNeedsFix: true,
        contentNeedsFix: false,
        contentBytes: 0,
        contentTooLargeToFix: false,
        rawContent: null,
        decodedContent: null,
        contentFetchFailed: false,
      },
    ]
    const services = {
      memories: {
        fixEncoding: vi.fn().mockResolvedValue({
          encoded,
          oversizedSkipped: [],
          oversizedAnchoredPlanned: [],
          contentFetchFailures: [],
          fixes: [],
        }),
      },
    }

    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
    await runMemoryEncodingFix(services as never, { apply: false })
    log.mockRestore()

    expect(services.memories.fixEncoding).toHaveBeenCalledWith({ dryRun: true })
    expect(logs.some((l) => l.includes("Would decode 1 HTML-encoded memory"))).toBe(true)
    expect(logs.some((l) => l.includes("Re-run with `--yes`"))).toBe(true)
  })

  it("reports nothing-to-do on a clean vault", async () => {
    const services = {
      memories: {
        fixEncoding: vi.fn().mockResolvedValue({
          encoded: [],
          oversizedSkipped: [],
          oversizedAnchoredPlanned: [],
          contentFetchFailures: [],
          fixes: [],
        }),
      },
    }

    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
    await runMemoryEncodingFix(services as never, { apply: true })
    log.mockRestore()

    expect(services.memories.fixEncoding).toHaveBeenCalledWith({ dryRun: false })
    expect(logs.some((l) => l.includes("No HTML-encoded memory rows"))).toBe(true)
  })

  it("threads explicit projectId into the memory encoding service", async () => {
    const services = {
      memories: {
        fixEncoding: vi.fn().mockResolvedValue({
          encoded: [],
          oversizedSkipped: [],
          oversizedAnchoredPlanned: [],
          contentFetchFailures: [],
          fixes: [],
        }),
      },
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    await runMemoryEncodingFix(services as never, {
      apply: false,
      projectId: "project-mail",
    })
    log.mockRestore()

    expect(services.memories.fixEncoding).toHaveBeenCalledWith({
      dryRun: true,
      projectId: "project-mail",
    })
  })

  it("prints Title and body tallies separately", async () => {
    const encoded = [
      {
        id: "m1",
        rawTitle: "Build &amp; Tooling",
        decodedTitle: "Build & Tooling",
        titleNeedsFix: true,
        contentNeedsFix: true,
        contentBytes: 20,
        contentTooLargeToFix: false,
        rawContent: "Rollup &amp; Vite",
        decodedContent: "Rollup & Vite",
      },
      {
        id: "m2",
        rawTitle: "clean title",
        decodedTitle: "clean title",
        titleNeedsFix: false,
        contentNeedsFix: true,
        contentBytes: 15,
        contentTooLargeToFix: false,
        rawContent: "body &amp;amp; more",
        decodedContent: "body & more",
      },
    ]
    const fixes = [
      {
        id: "m1",
        rawTitle: "Build &amp; Tooling",
        decodedTitle: "Build & Tooling",
        titleFixed: true,
        contentFixed: true,
      },
      {
        id: "m2",
        rawTitle: "clean title",
        decodedTitle: "clean title",
        titleFixed: false,
        contentFixed: true,
      },
    ]
    const services = {
      memories: {
        fixEncoding: vi.fn().mockResolvedValue({
          encoded,
          oversizedSkipped: [],
          oversizedAnchoredPlanned: [],
          contentFetchFailures: [],
          fixes,
        }),
      },
    }

    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
    await runMemoryEncodingFix(services as never, { apply: true })
    log.mockRestore()

    expect(
      logs.some((l) => l.includes("Title fixes: 1") && l.includes("body fixes: 2"))
    ).toBe(true)
  })

  it("plan mode labels oversized rows as 'will fix via anchored RunTool patterns' when LORE_USE_RUNTOOL_BLOCK_EDIT predicts the path applies (issue #534 AC #5 review)", async () => {
    // Pre-review the plan output labeled every oversized row as
    // 'skipped', then `--yes` rewrote the body anyway under
    // `LORE_USE_RUNTOOL_BLOCK_EDIT=1`. That broke the
    // plan-then-execute contract on bodies > 100KB. Now the
    // service routes apply-path-eligible oversized rows into a
    // separate `oversizedAnchoredPlanned` bucket; the CLI surfaces
    // it as its own preview section, AND the body-fixes counter
    // includes those rows so `Would decode 1` is truthful.
    const encoded = [
      {
        id: "11111111111111111111111111111111",
        rawTitle: "Big & Chunky",
        decodedTitle: "Big & Chunky",
        titleNeedsFix: false,
        contentNeedsFix: true,
        contentBytes: 250_000,
        contentTooLargeToFix: true,
        rawContent: "…big body with &amp;…",
        decodedContent: "…big body with &…",
        contentFetchFailed: false,
        anchoredPathPlanned: true,
      },
    ]
    const services = {
      memories: {
        fixEncoding: vi.fn().mockResolvedValue({
          encoded,
          oversizedSkipped: [],
          oversizedAnchoredPlanned: [encoded[0]],
          contentFetchFailures: [],
          fixes: [],
        }),
      },
    }

    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
    await runMemoryEncodingFix(services as never, { apply: false })
    log.mockRestore()

    // Body counter includes the oversized-anchored row.
    expect(
      logs.some((l) => l.includes("Title fixes: 0") && l.includes("body fixes: 1"))
    ).toBe(true)
    // Per-row preview labels the body shape correctly. NOT "skipped".
    expect(
      logs.some(
        (l) =>
          l.includes("body via anchored RunTool patterns") && l.includes("244.1 KB")
      )
    ).toBe(true)
    expect(
      logs.every((l) => !l.includes("Skipped body rewrite"))
    ).toBe(true)
    // Dedicated section surfaces the count.
    expect(
      logs.some(
        (l) =>
          l.includes("Will fix oversized body via anchored RunTool patterns on 1 memory")
      )
    ).toBe(true)
    // Re-run footer still fires (planOnly + fixableRows > 0).
    expect(logs.some((l) => l.includes("Re-run with `--yes`"))).toBe(true)
  })

  it("plan mode keeps oversized multi-pass / no-substitutions rows in the skipped bucket (anchored path can't help)", async () => {
    // Counterpart to the previous test: when `anchoredPathPlanned`
    // is false (multi-pass entity body, empty substitutions list,
    // body fetch failed), the oversized row stays in
    // `oversizedSkipped` and the CLI labels it as such — apply
    // mode would also skip it, so plan and apply agree.
    const encoded = [
      {
        id: "22222222222222222222222222222222",
        rawTitle: "Multi-encoded",
        decodedTitle: "Multi-encoded",
        titleNeedsFix: false,
        contentNeedsFix: true,
        contentBytes: 250_000,
        contentTooLargeToFix: true,
        rawContent: "…body with &amp;amp;…",
        decodedContent: "…body with &…",
        contentFetchFailed: false,
        anchoredPathPlanned: false,
      },
    ]
    const services = {
      memories: {
        fixEncoding: vi.fn().mockResolvedValue({
          encoded,
          oversizedSkipped: [encoded[0]],
          oversizedAnchoredPlanned: [],
          contentFetchFailures: [],
          fixes: [],
        }),
      },
    }

    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
    await runMemoryEncodingFix(services as never, { apply: false })
    log.mockRestore()

    // Body counter does NOT include the oversized-non-anchored row.
    expect(
      logs.some((l) => l.includes("Title fixes: 0") && l.includes("body fixes: 0"))
    ).toBe(true)
    // Per-row preview correctly labels as 'skipped'.
    expect(
      logs.some((l) => l.includes("body skipped") && l.includes("244.1 KB"))
    ).toBe(true)
    expect(
      logs.every((l) => !l.includes("body via anchored RunTool patterns"))
    ).toBe(true)
    // Dedicated 'Skipped' section fires.
    expect(logs.some((l) => l.includes("Skipped body rewrite on 1 memory"))).toBe(true)
  })

  it("surfaces oversized-body rows in a dedicated bucket", async () => {
    const encoded = [
      {
        id: "m-big",
        rawTitle: "Big &amp; Chunky",
        decodedTitle: "Big & Chunky",
        titleNeedsFix: true,
        contentNeedsFix: true,
        contentBytes: 250_000,
        contentTooLargeToFix: true,
        rawContent: "…very large body…",
        decodedContent: "…very large body…",
      },
    ]
    const fixes = [
      {
        id: "m-big",
        rawTitle: "Big &amp; Chunky",
        decodedTitle: "Big & Chunky",
        titleFixed: true,
        contentFixed: false,
      },
    ]
    const services = {
      memories: {
        fixEncoding: vi.fn().mockResolvedValue({
          encoded,
          oversizedSkipped: [encoded[0]],
          oversizedAnchoredPlanned: [],
          contentFetchFailures: [],
          fixes,
        }),
      },
    }

    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
    await runMemoryEncodingFix(services as never, { apply: true })
    log.mockRestore()

    expect(logs.some((l) => l.includes("Skipped body rewrite on 1 memory"))).toBe(true)
    // 250_000 bytes → "244.1 KB" under `formatBytes` (1024-base KB with
    // one decimal). The oversize preview renders in KB so it's scannable
    // next to the 100 KB cap instead of a six-digit byte count.
    expect(logs.some((l) => l.includes("244.1 KB"))).toBe(true)
  })

  it("emits the discovery breadcrumb on stderr before the (potentially long-blocking) fixEncoding call", async () => {
    // Same hang risk as runSynopsisBackfill: `findEncodedMemories`
    // paginates `dataSources.query` with no per-page output, and the
    // Notion SDK absorbs 429s with multi-second `Retry-After` sleeps
    // inside a single `await`. The ordering pin (stderr seen BEFORE
    // services.memories.fixEncoding resolves) is the load-bearing
    // assertion — a future contributor moving the breadcrumb after
    // the await would silently restore the silent-hang UX.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })
    let stderrSeenBeforeDiscovery = false
    const services = {
      memories: {
        fixEncoding: vi.fn().mockImplementation(async () => {
          stderrSeenBeforeDiscovery = stderrChunks.length > 0
          return {
            encoded: [],
            oversizedSkipped: [],
            oversizedAnchoredPlanned: [],
            contentFetchFailures: [],
            fixes: [],
          }
        }),
      },
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    await runMemoryEncodingFix(services as never, { apply: false })
    log.mockRestore()
    stderrSpy.mockRestore()

    expect(stderrSeenBeforeDiscovery).toBe(true)
    const all = stderrChunks.join("")
    expect(all).toMatch(/Discovering/)
    expect(all).toMatch(/HTML-encoded/)
    expect(all).toMatch(/LORE_DEBUG=1/)
  })
})

describe("runAgentNormalization", () => {
  it("threads explicit projectId into the agent normalization service", async () => {
    const services = {
      memories: {
        normalizeAgents: vi
          .fn()
          .mockResolvedValue({ encoded: [], fixes: [], errors: [] }),
      },
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    await runAgentNormalization(services as never, {
      apply: false,
      projectId: "project-mail",
    })
    log.mockRestore()

    expect(services.memories.normalizeAgents).toHaveBeenCalledWith({
      dryRun: true,
      projectId: "project-mail",
    })
  })

  it("emits the discovery breadcrumb on stderr before the (potentially long-blocking) normalizeAgents call", async () => {
    // Same hang risk as the synopsis and memory-encoding paths:
    // `findNormalizableAgents` paginates the Memories DS without
    // per-page output. The ordering pin matches the runSynopsisBackfill
    // and runMemoryEncodingFix tests so a future regression here is
    // caught at exactly the same shape.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })
    let stderrSeenBeforeDiscovery = false
    const services = {
      memories: {
        normalizeAgents: vi.fn().mockImplementation(async () => {
          stderrSeenBeforeDiscovery = stderrChunks.length > 0
          return { encoded: [], fixes: [], errors: [] }
        }),
      },
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    await runAgentNormalization(services as never, { apply: false })
    log.mockRestore()
    stderrSpy.mockRestore()

    expect(stderrSeenBeforeDiscovery).toBe(true)
    const all = stderrChunks.join("")
    expect(all).toMatch(/Discovering/)
    expect(all).toMatch(/Agent/)
    expect(all).toMatch(/LORE_DEBUG=1/)
  })
})

describe("printDiscoveryBreadcrumb", () => {
  it("renders Discovering <label> with the LORE_DEBUG=1 pointer on stderr", () => {
    // One canonical line shape across every paginating discovery
    // surface — operators only have to learn `LORE_DEBUG=1` once,
    // and a single grep (`Discovering`) catches every migration's
    // up-front breadcrumb.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })

    printDiscoveryBreadcrumb("memories with empty Synopsis")
    stderrSpy.mockRestore()

    expect(stderrChunks).toHaveLength(1)
    const line = stderrChunks[0]!
    expect(line).toBe(
      "Discovering memories with empty Synopsis (paginating Notion; set LORE_DEBUG=1 to trace retries)...\n"
    )
  })
})

describe("loadTopicAliasMerges", () => {
  let workDir: string

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "lore-merge-test-"))
  })

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true })
  })

  it("parses a well-formed YAML into plan objects", async () => {
    const path = join(workDir, "merges.yaml")
    await writeFile(
      path,
      `merges:
  - canonical: "Build & Tooling"
    aliases:
      - "Build System"
      - "Build tooling"
  - canonical: "MCP"
    aliases: ["MCP Tools"]
`
    )

    const plans = await loadTopicAliasMerges(path)
    expect(plans).toEqual([
      { canonical: "Build & Tooling", aliases: ["Build System", "Build tooling"] },
      { canonical: "MCP", aliases: ["MCP Tools"] },
    ])
  })

  it("rejects a missing file with a clean error naming the absolute path", async () => {
    const missing = join(workDir, "does-not-exist.yaml")
    await expect(loadTopicAliasMerges(missing)).rejects.toThrow(
      /Merge file not found:.*does-not-exist\.yaml/
    )
  })

  it("rejects malformed YAML with a parse-error message", async () => {
    const path = join(workDir, "broken.yaml")
    // Nested-inside-compact triggers a yaml parse error deterministically.
    await writeFile(path, "this: is\n  not: valid: yaml: {[}")
    await expect(loadTopicAliasMerges(path)).rejects.toThrow(/Could not parse YAML in/)
  })

  it("rejects a schema-invalid YAML with a path-aware zod error", async () => {
    const path = join(workDir, "bad-schema.yaml")
    await writeFile(path, `merges:\n  - canonical: "A"\n    aliases: []\n`)
    await expect(loadTopicAliasMerges(path)).rejects.toThrow(
      /Invalid merge file.*merges\.0\.aliases.*at least one alias/
    )
  })

  it("rejects a YAML missing the merges key entirely", async () => {
    const path = join(workDir, "empty.yaml")
    await writeFile(path, `other_key: true\n`)
    await expect(loadTopicAliasMerges(path)).rejects.toThrow(/Invalid merge file/)
  })

  it("rejects an empty merges array (zod .min(1))", async () => {
    const path = join(workDir, "no-plans.yaml")
    await writeFile(path, `merges: []\n`)
    await expect(loadTopicAliasMerges(path)).rejects.toThrow(/at least one plan/)
  })
})

describe("printAliasMergeResults", () => {
  let logs: string[]
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    logs = []
    logSpy = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  function makeResult(overrides: Partial<TopicAliasMergeResult>): TopicAliasMergeResult {
    return {
      canonical: "MCP",
      canonicalId: "t1",
      canonicalCreated: false,
      canonicalProjectIds: ["p1"],
      archivedAliases: [],
      reassignedMemoryIds: [],
      unmatchedAliases: [],
      noop: false,
      ...overrides,
    }
  }

  it("uses past-tense verbs when writing is true", () => {
    printAliasMergeResults(
      [
        makeResult({
          archivedAliases: [{ name: "MCP Tools", id: "t2" }],
          reassignedMemoryIds: ["m1", "m2"],
          canonicalProjectIds: ["p1", "p2"],
        }),
      ],
      { writing: true }
    )
    const joined = logs.join("\n")
    expect(joined).toContain("Merged 1 topic alias group")
    expect(joined).toContain('"MCP" (existing canonical)')
    expect(joined).toContain('archived alias "MCP Tools" (t2)')
    expect(joined).toContain("re-pointed 2 memories; 2 projects on canonical")
  })

  it("uses hypothetical verbs when writing is false", () => {
    printAliasMergeResults(
      [
        makeResult({
          archivedAliases: [{ name: "MCP Tools", id: "t2" }],
          reassignedMemoryIds: ["m1"],
        }),
      ],
      { writing: false }
    )
    const joined = logs.join("\n")
    expect(joined).toContain("Would merge 1 topic alias group")
    expect(joined).toContain("would re-point 1 memory")
  })

  it("labels the canonical as 'would be created' on dry-run creation", () => {
    printAliasMergeResults(
      [
        makeResult({
          canonicalId: null,
          canonicalCreated: true,
          archivedAliases: [{ name: "Old", id: "t2" }],
          reassignedMemoryIds: ["m1"],
        }),
      ],
      { writing: false }
    )
    expect(logs.join("\n")).toContain("canonical would be created")
  })

  it("labels the canonical as 'created' on apply-creation", () => {
    printAliasMergeResults(
      [
        makeResult({
          canonicalId: "t-new",
          canonicalCreated: true,
          archivedAliases: [{ name: "Old", id: "t2" }],
        }),
      ],
      { writing: true }
    )
    expect(logs.join("\n")).toContain("canonical created")
  })

  it("collapses the memory clause when no memories are re-pointed (project-only extension)", () => {
    // The awkward "re-pointed 0 memories; 4 projects on canonical" phrasing
    // should not appear when the only effect is extending Project relations.
    printAliasMergeResults(
      [
        makeResult({
          archivedAliases: [{ name: "MCP Tools", id: "t2" }],
          reassignedMemoryIds: [],
          canonicalProjectIds: ["p1", "p2", "p3", "p4"],
        }),
      ],
      { writing: false }
    )
    const joined = logs.join("\n")
    expect(joined).not.toMatch(/0 memor/)
    expect(joined).toContain("canonical Project relation covers 4 projects")
  })

  it("surfaces unmatched aliases alongside the archived ones", () => {
    printAliasMergeResults(
      [
        makeResult({
          archivedAliases: [{ name: "MCP Tools", id: "t2" }],
          reassignedMemoryIds: ["m1"],
          unmatchedAliases: ["MCP tool layout", "MCP Client Conventions"],
        }),
      ],
      { writing: false }
    )
    expect(logs.join("\n")).toContain(
      'no match for: "MCP tool layout", "MCP Client Conventions"'
    )
  })

  it("prints the 'Nothing to merge' banner when every plan is a noop", () => {
    printAliasMergeResults(
      [makeResult({ noop: true, archivedAliases: [], reassignedMemoryIds: [] })],
      { writing: false }
    )
    expect(logs.join("\n")).toContain("Nothing to merge")
  })

  it("separates noop plans into their own section with unmatched alias detail", () => {
    printAliasMergeResults(
      [
        makeResult({
          canonical: "Active",
          archivedAliases: [{ name: "A", id: "t-a" }],
          reassignedMemoryIds: ["m1"],
        }),
        makeResult({
          canonical: "Already Done",
          noop: true,
          unmatchedAliases: ["StaleAlias"],
        }),
      ],
      { writing: true }
    )
    const joined = logs.join("\n")
    expect(joined).toContain("1 plan already merged")
    expect(joined).toContain('"Already Done"')
    expect(joined).toContain('no match for: "StaleAlias"')
  })
})

describe("runBuildEntitiesMigration", () => {
  let logs: string[]
  let logSpy: ReturnType<typeof vi.spyOn>
  const configRoot = "/tmp/lore-migrate-test"
  const vaultPageId = "vault-page-entity-test"
  const lockStateDir = join(tmpdir(), `lore-migrate-command-lock-test-${process.pid}`)
  let originalStateDir: string | undefined

  beforeEach(() => {
    originalStateDir = process.env["LORE_HOOK_STATE_DIR"]
    process.env["LORE_HOOK_STATE_DIR"] = lockStateDir
    rmSync(lockStateDir, { recursive: true, force: true })
    logs = []
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "))
    })
  })
  afterEach(() => {
    logSpy.mockRestore()
    rmSync(lockStateDir, { recursive: true, force: true })
    if (originalStateDir === undefined) {
      delete process.env["LORE_HOOK_STATE_DIR"]
    } else {
      process.env["LORE_HOOK_STATE_DIR"] = originalStateDir
    }
  })

  function addLockFields(
    services: object
  ): object & { configRoot: string; config: { vault: { pageId: string } } } {
    return {
      configRoot,
      config: { vault: { pageId: vaultPageId } },
      ...services,
    }
  }

  function entityLockPath(): string {
    return migrationLockPath({
      name: "build-entities",
      configRoot,
      vaultPageId,
    })
  }

  function seedEntityLock(pid: number): string {
    const path = entityLockPath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, pid.toString())
    return path
  }

  it("emits 'No fact subjects/objects' when the graph is empty", async () => {
    const services = addLockFields({
      entities: {
        listAll: vi.fn().mockResolvedValue([]),
        clearNameCache: vi.fn(),
      },
      facts: {
        queryBySubject: vi.fn().mockResolvedValue([]),
      },
      vault: {
        getClient: vi.fn(),
      },
    }) as never

    await runBuildEntitiesMigration(services, { apply: false })
    expect(logs.join("\n")).toContain("nothing to canonicalize")
  })

  it("threads explicit projectId into the entity migration fact scan", async () => {
    const services = addLockFields({
      entities: {
        listAll: vi.fn().mockResolvedValue([]),
        clearNameCache: vi.fn(),
      },
      facts: {
        queryBySubject: vi.fn().mockResolvedValue([]),
      },
      vault: {
        getClient: vi.fn(),
      },
    }) as never

    await runBuildEntitiesMigration(services, {
      apply: false,
      projectId: "project-mail",
    })

    expect(
      (services as { facts: { queryBySubject: ReturnType<typeof vi.fn> } }).facts
        .queryBySubject
    ).toHaveBeenCalledWith("", expect.objectContaining({ projectId: "project-mail" }))
  })

  it("apply mode fails fast when the build-entities lock is held", async () => {
    const lockPath = seedEntityLock(process.pid)
    const services = addLockFields({
      entities: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      facts: {
        queryBySubject: vi.fn().mockResolvedValue([]),
      },
      vault: {
        getClient: vi.fn(),
      },
    }) as never

    await expect(runBuildEntitiesMigration(services, { apply: true })).rejects.toThrow(
      /Another build-entities migration is already active/
    )
    expect(existsSync(lockPath)).toBe(true)
    expect(
      (services as { facts: { queryBySubject: ReturnType<typeof vi.fn> } }).facts
        .queryBySubject
    ).not.toHaveBeenCalled()
  })

  it("apply mode releases the build-entities lock when finished", async () => {
    const services = addLockFields({
      entities: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      facts: {
        queryBySubject: vi.fn().mockResolvedValue([]),
      },
      vault: {
        getClient: vi.fn(),
      },
    }) as never

    await runBuildEntitiesMigration(services, { apply: true })

    expect(existsSync(entityLockPath())).toBe(false)
    expect(logs.join("\n")).toContain("nothing to canonicalize")
  })

  it("plan-only mode remains lock-free", async () => {
    const lockPath = seedEntityLock(process.pid)
    const services = addLockFields({
      entities: {
        listAll: vi.fn().mockResolvedValue([]),
      },
      facts: {
        queryBySubject: vi.fn().mockResolvedValue([]),
      },
      vault: {
        getClient: vi.fn(),
      },
    }) as never

    await runBuildEntitiesMigration(services, { apply: false })

    expect(existsSync(lockPath)).toBe(true)
    expect(
      (services as { facts: { queryBySubject: ReturnType<typeof vi.fn> } }).facts
        .queryBySubject
    ).toHaveBeenCalled()
  })
})

describe("runOrphanRateReport — issue #542 pre/post-pass label contract", () => {
  let logs: string[]
  let logSpy: ReturnType<typeof vi.spyOn>
  let savedFlag: string | undefined

  beforeEach(() => {
    logs = []
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "))
    })
    // Force the JS enumeration path for these tests — exercising the
    // label contract should not depend on the RunTool aggregate flag
    // an operator may have set in their shell.
    savedFlag = process.env["LORE_USE_RUNTOOL_AGGREGATE"]
    process.env["LORE_USE_RUNTOOL_AGGREGATE"] = "0"
  })

  afterEach(() => {
    logSpy.mockRestore()
    if (savedFlag === undefined) {
      delete process.env["LORE_USE_RUNTOOL_AGGREGATE"]
    } else {
      process.env["LORE_USE_RUNTOOL_AGGREGATE"] = savedFlag
    }
  })

  function buildServices(facts: Fact[]): Parameters<typeof runOrphanRateReport>[0] {
    return {
      facts: {
        queryBySubject: vi.fn().mockResolvedValue(facts),
      },
      vault: {
        databases: {
          facts: { databaseId: "facts-db", dataSourceId: "facts-ds" },
        },
      },
      client: {} as never,
    } as unknown as Parameters<typeof runOrphanRateReport>[0]
  }

  it("emits 'pre-pass' when apply is false (plan-only / --dry-run)", async () => {
    const services = buildServices([
      makeFact("f1", { subject: "MemoryService" }),
      makeFact("f2", { subject: "MemoryService" }),
      makeFact("f3", { subject: "Solo" }),
    ])
    await runOrphanRateReport(services, { apply: false })
    const out = logs.join("\n")
    expect(out).toMatch(/Orphan rate \(pre-pass, vault-wide, via js-enumeration\)/)
    expect(out).not.toMatch(/post-pass/)
  })

  it("emits 'post-pass' when apply is true (--yes apply)", async () => {
    const services = buildServices([
      makeFact("f1", { subject: "MemoryService" }),
      makeFact("f2", { subject: "MemoryService" }),
    ])
    await runOrphanRateReport(services, { apply: true })
    const out = logs.join("\n")
    expect(out).toMatch(/Orphan rate \(post-pass, vault-wide, via js-enumeration\)/)
    expect(out).not.toMatch(/pre-pass/)
  })

  it("uses the resolved project name in the scope label when present", async () => {
    const services = buildServices([makeFact("f1", { subject: "Foo" })])
    await runOrphanRateReport(services, {
      apply: false,
      projectId: "project-mail",
      projectName: "Mail",
    })
    expect(logs.join("\n")).toMatch(/Orphan rate \(pre-pass, project "Mail", via js-enumeration\)/)
  })

  it("falls back to 'project-scoped' when projectId is set but projectName is not", async () => {
    const services = buildServices([makeFact("f1", { subject: "Foo" })])
    await runOrphanRateReport(services, {
      apply: false,
      projectId: "project-mail",
    })
    expect(logs.join("\n")).toMatch(/Orphan rate \(pre-pass, project-scoped, via js-enumeration\)/)
  })

  it("threads includeInvalidated:true into the JS enumeration walk", async () => {
    // Equivalence pin: the SQL aggregate path counts every fact
    // (Notion's SQL gateway can't filter date columns), so the JS
    // fallback MUST also count invalidated facts. Without this opt-in,
    // the two paths would diverge on real vaults.
    const services = buildServices([])
    await runOrphanRateReport(services, { apply: false })
    const queryBySubject = (services as unknown as {
      facts: { queryBySubject: ReturnType<typeof vi.fn> }
    }).facts.queryBySubject
    expect(queryBySubject).toHaveBeenCalledWith(
      "",
      expect.objectContaining({
        allowUnfiltered: true,
        includeInvalidated: true,
      }),
    )
  })
})

function emptyBackfillReport(): BackfillReport {
  return {
    totalCandidates: 0,
    archivedSkipped: 0,
    bodyOversizeSkipped: 0,
    emptyBodySkipped: 0,
    synthesized: 0,
    placeholderWritten: 0,
    bodyFetchFailed: 0,
    synthesisFailed: 0,
    scaffoldingRejected: 0,
    writeFailed: 0,
    truncated: 0,
    examples: [],
  }
}

describe("parseSynopsisBackend", () => {
  it("defaults to claude when undefined", () => {
    expect(parseSynopsisBackend(undefined)).toBe("claude")
  })

  it("accepts the two valid backends case-insensitively", () => {
    expect(parseSynopsisBackend("claude")).toBe("claude")
    expect(parseSynopsisBackend("Claude")).toBe("claude")
    expect(parseSynopsisBackend("placeholder")).toBe("placeholder")
    expect(parseSynopsisBackend("PLACEHOLDER")).toBe("placeholder")
  })

  it("rejects an unknown backend with process.exit(1)", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit-called")
    }) as never)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(() => parseSynopsisBackend("openai")).toThrow("exit-called")
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("openai"))).toBe(true)
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})

describe("parseSynopsisBatchSize", () => {
  it("defaults to DEFAULT_SYNOPSIS_BATCH_SIZE when undefined", () => {
    expect(parseSynopsisBatchSize(undefined)).toBe(DEFAULT_SYNOPSIS_BATCH_SIZE)
  })

  it("accepts a positive integer string", () => {
    expect(parseSynopsisBatchSize("1")).toBe(1)
    expect(parseSynopsisBatchSize("4")).toBe(4)
    expect(parseSynopsisBatchSize("16")).toBe(16)
  })

  it("rejects non-positive / non-integer / non-numeric values", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit-called")
    }) as never)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      expect(() => parseSynopsisBatchSize("0")).toThrow("exit-called")
      expect(() => parseSynopsisBatchSize("-1")).toThrow("exit-called")
      expect(() => parseSynopsisBatchSize("3.5")).toThrow("exit-called")
      expect(() => parseSynopsisBatchSize("abc")).toThrow("exit-called")
      expect(() => parseSynopsisBatchSize("")).toThrow("exit-called")
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
  })
})

describe("formatBackfillBucket", () => {
  it("renders numeric on plan-only regardless of backend", () => {
    expect(formatBackfillBucket(0, "claude", true)).toBe("0")
    expect(formatBackfillBucket(0, "placeholder", true)).toBe("0")
    expect(formatBackfillBucket(7, "claude", true)).toBe("7")
  })

  it("renders numeric on the claude apply path", () => {
    expect(formatBackfillBucket(0, "claude", false)).toBe("0")
    expect(formatBackfillBucket(7, "claude", false)).toBe("7")
  })

  it("renders n/a (placeholder backend) on the placeholder apply path", () => {
    // Acceptance criterion: the CLI display layer renders both
    // counters as `n/a (placeholder backend)` rather than the
    // literal `0` so an operator scanning the report doesn't
    // misread "checked and found zero" when the migration didn't
    // check at all.
    expect(formatBackfillBucket(0, "placeholder", false)).toBe(
      "n/a (placeholder backend)"
    )
    expect(formatBackfillBucket(99, "placeholder", false)).toBe(
      "n/a (placeholder backend)"
    )
  })
})

describe("runSynopsisBackfill", () => {
  it("default (no --yes) is plan-only and surfaces the re-run footer", async () => {
    const report = emptyBackfillReport()
    report.totalCandidates = 5
    report.examples = [{ id: "m1", title: "First", bucket: "candidate" as const }]
    const services = {
      memories: { backfillSynopses: vi.fn().mockResolvedValue(report) },
    }
    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })

    await runSynopsisBackfill(services as never, {
      apply: false,
      backend: "claude",
    })
    log.mockRestore()

    expect(services.memories.backfillSynopses).toHaveBeenCalledWith({
      apply: false,
      dryRun: undefined,
      backend: "claude",
      batchSize: undefined,
    })
    expect(logs.some((l) => l.includes("Would backfill 5 synopses"))).toBe(true)
    expect(logs.some((l) => l.includes("Re-run with `--yes`"))).toBe(true)
    expect(logs.some((l) => l.includes("estimated, exact counts require --yes"))).toBe(
      true
    )
    // Plan-only output deliberately suppresses the batch-size clause —
    // the operator hasn't paid anything yet so the concurrency knob
    // is irrelevant noise.
    expect(logs.some((l) => l.includes("batch-size:"))).toBe(false)
  })

  it("threads batchSize through to services.memories.backfillSynopses and into the apply-mode header", async () => {
    const report = emptyBackfillReport()
    report.totalCandidates = 8
    report.synthesized = 8
    const services = {
      memories: { backfillSynopses: vi.fn().mockResolvedValue(report) },
    }
    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })

    await runSynopsisBackfill(services as never, {
      apply: true,
      backend: "claude",
      batchSize: 8,
    })
    log.mockRestore()

    expect(services.memories.backfillSynopses).toHaveBeenCalledWith({
      apply: true,
      dryRun: undefined,
      backend: "claude",
      batchSize: 8,
    })
    expect(logs.some((l) => l.includes("batch-size: 8"))).toBe(true)
  })

  it("reports nothing-to-do when the candidate pool is empty", async () => {
    const services = {
      memories: {
        backfillSynopses: vi.fn().mockResolvedValue(emptyBackfillReport()),
      },
    }
    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })

    await runSynopsisBackfill(services as never, {
      apply: true,
      backend: "claude",
    })
    log.mockRestore()

    expect(logs.some((l) => l.includes("No memories with empty Synopsis"))).toBe(true)
  })

  it("apply path with claude backend reports the synthesis verb and counters", async () => {
    const report = emptyBackfillReport()
    report.totalCandidates = 3
    report.synthesized = 3
    report.truncated = 1
    const services = {
      memories: { backfillSynopses: vi.fn().mockResolvedValue(report) },
    }
    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })

    await runSynopsisBackfill(services as never, {
      apply: true,
      backend: "claude",
    })
    log.mockRestore()

    expect(logs.some((l) => l.includes("Synthesized 3 synopses"))).toBe(true)
    expect(logs.some((l) => l.includes("backend: claude"))).toBe(true)
    expect(logs.some((l) => l.includes("truncated:"))).toBe(true)
  })

  it("apply path with placeholder backend renders n/a for fetch-time counters", async () => {
    // Acceptance criterion: "Test pins both behaviors separately
    // (typed-value assertion vs. display-string snapshot)." The
    // typed-value assertion lives in `synopsis-backfill.test.ts`;
    // here is the display-string snapshot.
    const report = emptyBackfillReport()
    report.totalCandidates = 4
    report.placeholderWritten = 4
    const services = {
      memories: { backfillSynopses: vi.fn().mockResolvedValue(report) },
    }
    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })

    await runSynopsisBackfill(services as never, {
      apply: true,
      backend: "placeholder",
    })
    log.mockRestore()

    expect(logs.some((l) => l.includes("Flagged 4 synopses"))).toBe(true)
    expect(logs.some((l) => l.includes("backend: placeholder"))).toBe(true)
    expect(logs.some((l) => l.includes("body-oversize: n/a (placeholder backend)"))).toBe(
      true
    )
    expect(logs.some((l) => l.includes("empty-body:    n/a (placeholder backend)"))).toBe(
      true
    )
  })

  it("plan-only with placeholder backend renders numeric (estimated) buckets", async () => {
    // Plan-only path: the typed report is `0` and the display layer
    // renders the literal `0` (with the "estimated" caveat). The
    // `n/a` substitution is only applied on the placeholder APPLY
    // path, where the backend deliberately skips body fetches.
    const report = emptyBackfillReport()
    report.totalCandidates = 2
    const services = {
      memories: { backfillSynopses: vi.fn().mockResolvedValue(report) },
    }
    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })

    await runSynopsisBackfill(services as never, {
      apply: false,
      backend: "placeholder",
    })
    log.mockRestore()

    expect(
      logs.some((l) => l.includes("body-oversize: 0") && l.includes("estimated"))
    ).toBe(true)
    expect(logs.some((l) => l.includes("n/a"))).toBe(false)
  })

  it("dry-run wins over apply: --yes --dry-run is plan-only", async () => {
    const report = emptyBackfillReport()
    report.totalCandidates = 1
    const services = {
      memories: { backfillSynopses: vi.fn().mockResolvedValue(report) },
    }
    const logs: string[] = []
    const log = vi.spyOn(console, "log").mockImplementation((msg) => {
      logs.push(String(msg))
    })

    await runSynopsisBackfill(services as never, {
      apply: true,
      dryRun: true,
      backend: "claude",
    })
    log.mockRestore()

    expect(services.memories.backfillSynopses).toHaveBeenCalledWith({
      apply: true,
      dryRun: true,
      backend: "claude",
      batchSize: undefined,
    })
    expect(logs.some((l) => l.includes("Would backfill"))).toBe(true)
    expect(logs.some((l) => l.includes("Re-run with `--yes`"))).toBe(true)
  })

  it("threads explicit projectId into the synopsis backfill service", async () => {
    const report = emptyBackfillReport()
    const services = {
      memories: { backfillSynopses: vi.fn().mockResolvedValue(report) },
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    await runSynopsisBackfill(services as never, {
      apply: false,
      backend: "claude",
      projectId: "project-mail",
    })
    log.mockRestore()

    expect(services.memories.backfillSynopses).toHaveBeenCalledWith({
      apply: false,
      dryRun: undefined,
      backend: "claude",
      batchSize: undefined,
      projectId: "project-mail",
    })
  })

  it("emits a stderr breadcrumb before discovery so a quiet pagination doesn't look like a hang", async () => {
    // The discovery phase has no per-page logging, and the Notion SDK
    // absorbs 429 retries with multi-second `Retry-After` sleeps inside
    // a single `await`. Without an up-front breadcrumb the operator
    // stares at zero output for tens of seconds and concludes the
    // migration is hung — that's the bug this test pins.
    const report = emptyBackfillReport()
    report.totalCandidates = 0
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8")
        )
        return true
      })
    let stderrSeenBeforeDiscovery = false
    const services = {
      memories: {
        backfillSynopses: vi.fn().mockImplementation(async () => {
          stderrSeenBeforeDiscovery = stderrChunks.length > 0
          return report
        }),
      },
    }
    const log = vi.spyOn(console, "log").mockImplementation(() => {})

    await runSynopsisBackfill(services as never, {
      apply: false,
      backend: "claude",
    })
    log.mockRestore()
    stderrSpy.mockRestore()

    // Order is the load-bearing assertion: the breadcrumb must land
    // BEFORE the (potentially long-blocking) discovery call, not after.
    expect(stderrSeenBeforeDiscovery).toBe(true)
    // Pin the load-bearing fragments only — the surrounding sentence
    // wording is allowed to drift, but `Discovering` (so an operator
    // greps for it), `Synopsis` (so it's distinguishable from other
    // migrations), and `LORE_DEBUG=1` (so the retry-trace escape hatch
    // surfaces in the same line) are pinned.
    const all = stderrChunks.join("")
    expect(all).toMatch(/Discovering/)
    expect(all).toMatch(/Synopsis/)
    expect(all).toMatch(/LORE_DEBUG=1/)
  })
})

describe("summarizeConfidenceScorePlan", () => {
  function makeRow(
    overrides: Partial<BuildConfidenceScoresPlan["rowsToSeed"][number]> = {}
  ): BuildConfidenceScoresPlan["rowsToSeed"][number] {
    return {
      memoryId: "m1",
      title: "title",
      fromConfidence: "certain",
      seededScore: 0.9,
      decayedScore: 0.9,
      createdDate: "2026-04-29",
      daysSinceCreation: 0,
      ...overrides,
    }
  }

  it("returns zeroes on an empty plan (avoid NaN avg)", () => {
    const stats = summarizeConfidenceScorePlan({
      totalMemoriesScanned: 0,
      rowsToSeed: [],
      rowsAlreadyScored: 0,
    })
    expect(stats).toEqual({
      avgSeeded: 0,
      avgDecayed: 0,
      avgNeglectPastGrace: 0,
    })
  })

  it("computes per-row averages and rounds neglect-past-grace to whole days", () => {
    const stats = summarizeConfidenceScorePlan({
      totalMemoriesScanned: 3,
      rowsAlreadyScored: 0,
      rowsToSeed: [
        makeRow({ seededScore: 0.9, decayedScore: 0.6, daysSinceCreation: 90 }),
        makeRow({ seededScore: 0.6, decayedScore: 0.4, daysSinceCreation: 200 }),
        makeRow({ seededScore: 0.3, decayedScore: 0.2, daysSinceCreation: 30 }),
      ],
    })
    expect(stats.avgSeeded).toBeCloseTo((0.9 + 0.6 + 0.3) / 3, 6)
    expect(stats.avgDecayed).toBeCloseTo((0.6 + 0.4 + 0.2) / 3, 6)
    // (max(0, 90-60) + max(0, 200-60) + max(0, 30-60)) / 3 = (30 + 140 + 0) / 3 ≈ 56.67 → 57.
    expect(stats.avgNeglectPastGrace).toBe(57)
  })
})

describe("runBuildConfidenceScores", () => {
  let logs: string[]
  let logSpy: ReturnType<typeof vi.spyOn>
  let originalStderrWrite: typeof process.stderr.write

  beforeEach(() => {
    logs = []
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map((a) => String(a)).join(" "))
    })
    // Silence the discovery breadcrumb stderr line so test output stays
    // clean. The breadcrumb is asserted in its own describe block above.
    originalStderrWrite = process.stderr.write
    process.stderr.write = (() => true) as typeof process.stderr.write
  })

  afterEach(() => {
    logSpy.mockRestore()
    process.stderr.write = originalStderrWrite
  })

  function fakeMemory(overrides: Partial<Memory> = {}): Memory {
    const id = overrides.id ?? "m1"
    return makeMemory(id, overrides)
  }

  async function* iter(memories: Memory[]) {
    for (const m of memories) yield m
  }

  function makeServices(args: {
    memories: Memory[]
    findByName?: (name: string) => Promise<{ id: string; name: string } | null>
    applyBackfillScore?: (id: string, score: number, date: string) => Promise<void>
  }) {
    const services = {
      config: { notion: { rateLimit: { concurrency: 5 } } },
      memories: {
        listAllForBackfill: vi.fn(() => iter(args.memories)),
        applyBackfillScore: vi.fn(args.applyBackfillScore ?? (async () => undefined)),
      },
      projects: {
        findByName: vi.fn(args.findByName ?? (async () => null)),
      },
    }
    return services
  }

  it("plan-only mode prints the dry-run footer and writes nothing", async () => {
    const services = makeServices({
      memories: [
        fakeMemory({
          id: "m1",
          confidence: "certain",
          confidenceScore: null,
          createdAt: "2026-04-29T00:00:00.000Z",
        }),
      ],
    })
    const result = await runBuildConfidenceScores(services as never, {
      apply: false,
      dryRun: false,
    })
    expect(result.written).toBe(0)
    const joined = logs.join("\n")
    expect(joined).toContain("scanned 1")
    expect(joined).toContain("1 to seed")
    expect(joined).toContain("dry-run: no writes performed")
    expect(joined).toContain("--yes to apply")
  })

  it("apply mode writes via applyBackfillScore and prints the wrote-N summary", async () => {
    const calls: Array<{ id: string; score: number; date: string }> = []
    const services = makeServices({
      memories: [
        fakeMemory({
          id: "m1",
          confidence: "certain",
          confidenceScore: null,
          createdAt: "2026-04-29T00:00:00.000Z",
        }),
        fakeMemory({
          id: "m2",
          confidence: "likely",
          confidenceScore: null,
          createdAt: "2025-10-11T00:00:00.000Z",
        }),
      ],
      applyBackfillScore: async (id, score, date) => {
        calls.push({ id, score, date })
      },
    })
    const result = await runBuildConfidenceScores(services as never, {
      apply: true,
      dryRun: false,
    })
    expect(result.written).toBe(2)
    expect(calls).toHaveLength(2)
    const joined = logs.join("\n")
    expect(joined).toContain("wrote 2 rows")
  })

  it("emits the no-rows-to-seed message when every row is already scored", async () => {
    const services = makeServices({
      memories: [fakeMemory({ id: "m1", confidenceScore: 0.85 })],
    })
    const result = await runBuildConfidenceScores(services as never, {
      apply: false,
      dryRun: false,
    })
    expect(result.plan.rowsAlreadyScored).toBe(1)
    expect(logs.join("\n")).toMatch(/No memories need seeding/)
  })

  it("threads projectName through and resolves it via findByName", async () => {
    const services = makeServices({
      memories: [],
      findByName: async (name) => (name === "Mail" ? { id: "project-mail", name } : null),
    })
    await runBuildConfidenceScores(services as never, {
      apply: false,
      dryRun: false,
      projectName: "Mail",
    })
    expect(services.projects.findByName).toHaveBeenCalledWith("Mail")
    expect(services.memories.listAllForBackfill).toHaveBeenCalledWith({
      projectId: "project-mail",
    })
  })

  it("uses a pre-resolved projectId without re-looking up projectName", async () => {
    const services = makeServices({
      memories: [],
      findByName: async () => {
        throw new Error("should not resolve again")
      },
    })

    await runBuildConfidenceScores(services as never, {
      apply: false,
      dryRun: false,
      projectName: "Archive",
      projectId: "project-archive",
    })

    expect(services.projects.findByName).not.toHaveBeenCalled()
    expect(services.memories.listAllForBackfill).toHaveBeenCalledWith({
      projectId: "project-archive",
    })
  })

  it("aborts on unknown projectName BEFORE the discovery breadcrumb prints", async () => {
    // Capture stderr to verify the breadcrumb does NOT appear on the
    // failure path — operators shouldn't see "Discovering memories..."
    // followed immediately by an unresolved-project error.
    const captured: string[] = []
    const originalWrite = process.stderr.write
    process.stderr.write = ((chunk: unknown) => {
      captured.push(String(chunk))
      return true
    }) as typeof process.stderr.write

    const services = makeServices({
      memories: [makeMemory("m1")],
      findByName: async () => null, // every name resolves to null
    })

    try {
      await expect(
        runBuildConfidenceScores(services as never, {
          apply: false,
          dryRun: false,
          projectName: "Typo",
        })
      ).rejects.toThrow(/Project "Typo" could not be resolved/)
    } finally {
      process.stderr.write = originalWrite
    }

    // Critical: the breadcrumb stayed silent, AND no scan or write
    // attempts ran — the safety property holds end-to-end.
    expect(captured.filter((c) => c.includes("Discovering memories"))).toHaveLength(0)
    expect(services.memories.listAllForBackfill).not.toHaveBeenCalled()
    expect(services.memories.applyBackfillScore).not.toHaveBeenCalled()
  })
})
