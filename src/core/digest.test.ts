import { describe, expect, it } from "vitest"
import { gatherDigestData, daysSince } from "./digest.js"
import type { Memory, Fact } from "../types.js"

function makeMemory(overrides: Partial<Memory>): Memory {
  return {
    id: "m-" + Math.random().toString(36).slice(2),
    title: "Untitled",
    projectIds: [],
    topicId: null,
    source: "conversation",
    kind: "note",
    status: "accepted",
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
    taskState: null,
    blockedBy: "",
    entity: "",
    createdAt: "2026-04-20T10:00:00.000Z",
    updatedAt: "2026-04-20T10:00:00.000Z",
    ...overrides,
  }
}

function makeFact(overrides: Partial<Fact>): Fact {
  return {
    id: "f-" + Math.random().toString(36).slice(2),
    subject: "subject",
    predicate: "needs_action",
    object: "object",
    projectIds: [],
    validFrom: null,
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: null,
    confidence: "likely",
    ...overrides,
  }
}

interface ListedCall {
  projectId?: string
  source?: string
  since?: string
  until?: string
  limit?: number
  sortBy?: "created_time" | "last_edited_time"
}

function stubServices(opts: {
  memories?: Memory[]
  digestMemory?: Memory | null
  facts?: Fact[]
}) {
  const calls: ListedCall[] = []
  return {
    calls,
    memories: {
      async list(args: ListedCall): Promise<{ items: Memory[] }> {
        calls.push(args)
        if (args.source === "digest") {
          return { items: opts.digestMemory ? [opts.digestMemory] : [] }
        }
        return { items: opts.memories ?? [] }
      },
    },
    facts: {
      async queryBySubject(): Promise<Fact[]> {
        return opts.facts ?? []
      },
    },
  }
}

describe("gatherDigestData", () => {
  it("labels the output with the supplied project label", async () => {
    const services = stubServices({})
    const result = await gatherDigestData(services, {
      projectLabel: "Mail",
      period: "week",
    })
    expect(result.raw).toContain("# Digest Data — Mail")
  })

  it("reports recentMemoryCount so schedulers can short-circuit on quiet windows", async () => {
    const services = stubServices({ memories: [] })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.recentMemoryCount).toBe(0)
    expect(result.raw).toContain("No memories found")
  })

  it("returns the last digest's createdAt date (YYYY-MM-DD) when one exists", async () => {
    const services = stubServices({
      digestMemory: makeMemory({
        source: "digest",
        title: "Digest — 2026-04-10 — Mail",
        createdAt: "2026-04-10T00:00:00.000Z",
      }),
    })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.lastDigestDate).toBe("2026-04-10")
    expect(result.raw).toContain("Previous Digest")
  })

  it("returns null lastDigestDate when no digest exists", async () => {
    const services = stubServices({ digestMemory: null })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.lastDigestDate).toBeNull()
    expect(result.raw).not.toContain("Previous Digest")
  })

  it("queries the latest digest by created_time, not last_edited_time", async () => {
    // Regression: the default sort order is last_edited_time, which would let
    // an edit to an older digest mask a newer one. Wake-up uses created_time
    // for the exact same lookup — we must stay consistent or the two code
    // paths disagree on which digest is the "freshest".
    const services = stubServices({})
    await gatherDigestData(services, { projectLabel: "Mail" })
    const digestCall = services.calls.find((c) => c.source === "digest")
    expect(digestCall?.sortBy).toBe("created_time")
  })

  it("accepts an injected clock for deterministic window + overdue computation", async () => {
    const fixed = new Date("2026-04-24T12:00:00.000Z")
    const services = stubServices({
      facts: [
        makeFact({
          subject: "Alice",
          predicate: "needs_action",
          object: "ship",
          reviewBy: "2026-04-24",
        }),
      ],
    })
    const result = await gatherDigestData(services, {
      projectLabel: "Mail",
      period: "day",
      now: () => fixed,
    })
    const call = services.calls.find((c) => c.source !== "digest")
    expect(call?.since).toBe("2026-04-23T12:00:00.000Z")
    expect(result.raw).toContain("**(OVERDUE)**")
  })

  it("groups memories by source in the Activity section", async () => {
    const services = stubServices({
      memories: [
        makeMemory({ title: "conv-1", source: "conversation" }),
        makeMemory({ title: "diary-1", source: "agent_diary" }),
        makeMemory({ title: "conv-2", source: "conversation" }),
      ],
    })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.raw).toContain("### conversation (2)")
    expect(result.raw).toContain("### agent_diary (1)")
    expect(result.raw).toContain("conv-1")
    expect(result.raw).toContain("diary-1")
  })

  it("flags overdue tracking facts", async () => {
    const today = new Date().toISOString().split("T")[0]!
    const services = stubServices({
      facts: [
        makeFact({
          subject: "Alice",
          predicate: "needs_action",
          object: "reply to RFC",
          reviewBy: today, // today counts as overdue
        }),
      ],
    })
    const result = await gatherDigestData(services, { projectLabel: "Mail" })
    expect(result.raw).toContain("Open Loops (1)")
    expect(result.raw).toContain("**(OVERDUE)**")
  })

  it("applies a day window when period is 'day'", async () => {
    const services = stubServices({})
    const before = Date.now() - 86_400_000 - 1_000
    await gatherDigestData(services, { projectLabel: "Mail", period: "day" })
    const call = services.calls.find((c) => c.source !== "digest")
    expect(call).toBeDefined()
    expect(new Date(call!.since!).getTime()).toBeGreaterThan(before)
  })

  it("respects an explicit since/until window", async () => {
    const services = stubServices({})
    await gatherDigestData(services, {
      projectLabel: "Mail",
      since: "2026-04-01T00:00:00.000Z",
      until: "2026-04-15T00:00:00.000Z",
    })
    const call = services.calls.find((c) => c.source !== "digest")
    expect(call?.since).toBe("2026-04-01T00:00:00.000Z")
    expect(call?.until).toBe("2026-04-15T00:00:00.000Z")
  })
})

describe("daysSince", () => {
  it("returns 0 for the same day", () => {
    const now = new Date("2026-04-24T12:00:00.000Z")
    expect(daysSince("2026-04-24T00:00:00.000Z", now)).toBe(0)
  })

  it("returns 7 for exactly one week ago", () => {
    const now = new Date("2026-04-24T00:00:00.000Z")
    expect(daysSince("2026-04-17T00:00:00.000Z", now)).toBe(7)
  })
})
