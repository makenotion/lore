import { describe, expect, it, vi } from "vitest"
import type { Fact, Memory } from "../../types.js"
import {
  backfillFactSources,
  proposeSourceMemory,
  runFactEncodingFix,
  runMemoryEncodingFix,
} from "./migrate.js"

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
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

describe("proposeSourceMemory", () => {
  it("matches a memory whose title contains the fact subject as a whole word", async () => {
    const fact = makeFact("fact-1", { subject: "AuthService", object: "JWT" })
    const memories = {
      search: vi.fn().mockResolvedValue([
        makeMemory("mem-1", { title: "AuthService retry policy" }),
      ]),
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
      search: vi.fn().mockResolvedValue([
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
      search: vi.fn().mockResolvedValue([
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
      expect.objectContaining({ projectId: undefined }),
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
    expect((services.facts.setSource as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
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
        fixEncoding: vi
          .fn()
          .mockResolvedValue({ encoded, collisions: [], fixes: [] }),
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
    expect(
      logs.some((l) => l.includes("Re-run with `--yes`"))
    ).toBe(true)
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
        fixEncoding: vi
          .fn()
          .mockResolvedValue({ encoded, collisions: [], fixes: [] }),
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
        fixEncoding: vi
          .fn()
          .mockResolvedValue({ encoded, collisions, fixes: [] }),
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
      logs.some((l) => l.includes("Decoded 0 HTML-encoded fact") && l.includes("1 collision group"))
    ).toBe(true)
    // Directive for the operator is present.
    expect(
      logs.some((l) => l.includes("--dedup-keys --merge --yes"))
    ).toBe(true)
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
        fixEncoding: vi
          .fn()
          .mockResolvedValue({
            encoded: [],
            oversizedSkipped: [],
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
        fixEncoding: vi
          .fn()
          .mockResolvedValue({
            encoded,
            oversizedSkipped: [],
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
        fixEncoding: vi
          .fn()
          .mockResolvedValue({
            encoded,
            oversizedSkipped: [encoded[0]],
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
      logs.some((l) => l.includes("Skipped body rewrite on 1 memory"))
    ).toBe(true)
    // 250_000 bytes → "244.1 KB" under `formatBytes` (1024-base KB with
    // one decimal). The oversize preview renders in KB so it's scannable
    // next to the 100 KB cap instead of a six-digit byte count.
    expect(logs.some((l) => l.includes("244.1 KB"))).toBe(true)
  })
})

