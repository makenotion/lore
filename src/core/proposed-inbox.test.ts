import { describe, expect, it, vi } from "vitest"
import {
  formatProposedInboxStatus,
  loadProposedInboxStatus,
} from "./proposed-inbox.js"

describe("formatProposedInboxStatus", () => {
  it("returns no lines on an empty inbox so the section is suppressed", () => {
    expect(formatProposedInboxStatus({ total: 0, bySource: {}, byAgent: {} })).toEqual([])
  })

  it("treats a non-positive total defensively and still suppresses the section", () => {
    // `total <= 0` short-circuits before any bucket inspection so a
    // negative-total report (which the loader cannot produce, but a
    // hand-constructed test fixture or a future direct-construction
    // call site could) doesn't surface a `-3 pending review` line.
    expect(formatProposedInboxStatus({ total: -3, bySource: {}, byAgent: {} })).toEqual(
      []
    )
  })

  it("inflects the prefix to singular for total === 1", () => {
    // `Proposed memories: 1 pending review` reads off — the natural
    // English form for one row is `Proposed memory: 1 pending review`.
    // The `pending review` suffix stays invariant; "review" is the
    // activity, not the row count.
    const lines = formatProposedInboxStatus({
      total: 1,
      bySource: { conversation: 1 },
      byAgent: { "Claude Code": 1 },
    })
    expect(lines).toEqual(["Proposed memory: 1 pending review"])
  })

  it("renders a single bare line when only one source and one agent carry counts", () => {
    // Single-bucket clusters add no operator signal beyond the total
    // — `(sources: conversation 4)` and `(agents: Claude Code 4)`
    // would just duplicate "4 pending review". Suppress the cluster
    // and render the bare line.
    const lines = formatProposedInboxStatus({
      total: 4,
      bySource: { conversation: 4 },
      byAgent: { "Claude Code": 4 },
    })
    expect(lines).toEqual(["Proposed memories: 4 pending review"])
  })

  it("renders source breakdown when at least two sources carry counts", () => {
    const lines = formatProposedInboxStatus({
      total: 12,
      bySource: { conversation: 8, manual: 4 },
      byAgent: { "Claude Code": 12 },
    })
    expect(lines).toEqual([
      "Proposed memories: 12 pending review (sources: conversation 8, manual 4)",
    ])
  })

  it("renders agent breakdown when at least two agents carry counts", () => {
    const lines = formatProposedInboxStatus({
      total: 12,
      bySource: { conversation: 12 },
      byAgent: { "Claude Code": 9, Codex: 3 },
    })
    expect(lines).toEqual([
      "Proposed memories: 12 pending review (agents: Claude Code 9, Codex 3)",
    ])
  })

  it("joins source and agent clusters with ` · ` when both carry diversity", () => {
    const lines = formatProposedInboxStatus({
      total: 12,
      bySource: { conversation: 8, manual: 4 },
      byAgent: { "Claude Code": 9, Codex: 3 },
    })
    expect(lines).toEqual([
      "Proposed memories: 12 pending review (sources: conversation 8, manual 4 · agents: Claude Code 9, Codex 3)",
    ])
  })

  it("sorts buckets by descending count so the heaviest source / agent leads", () => {
    const lines = formatProposedInboxStatus({
      total: 10,
      bySource: { manual: 3, conversation: 7 },
      byAgent: { Codex: 4, "Claude Code": 6 },
    })
    expect(lines[0]).toBe(
      "Proposed memories: 10 pending review (sources: conversation 7, manual 3 · agents: Claude Code 6, Codex 4)"
    )
  })

  it("breaks ties by ascending key for deterministic output across runs", () => {
    // Two sources tied at 4: `conversation` sorts before `manual`
    // because `'c' < 'm'` and the renderer's stable order falls
    // through to localeCompare on count ties.
    const lines = formatProposedInboxStatus({
      total: 8,
      bySource: { manual: 4, conversation: 4 },
      byAgent: { Codex: 4, "Claude Code": 4 },
    })
    expect(lines[0]).toBe(
      "Proposed memories: 8 pending review (sources: conversation 4, manual 4 · agents: Claude Code 4, Codex 4)"
    )
  })

  it("ignores zero-count buckets in either cluster", () => {
    // A future contributor pre-allocating dense bucket maps for
    // every MemorySource enum would flow zero-count keys through to
    // the renderer. Filter them out so the operator never sees
    // `digest 0` in the breakdown.
    const lines = formatProposedInboxStatus({
      total: 12,
      bySource: { conversation: 8, manual: 4, digest: 0, file: 0 },
      byAgent: { "Claude Code": 9, Codex: 3, unknown: 0 },
    })
    expect(lines[0]).toBe(
      "Proposed memories: 12 pending review (sources: conversation 8, manual 4 · agents: Claude Code 9, Codex 3)"
    )
  })

  it("ignores undefined-valued buckets the way zero-valued ones are ignored", () => {
    // The report shape uses `Record<string, number | undefined>` so
    // dense pre-allocation with `undefined` placeholders is safe.
    // Pinning the renderer's filter behavior on `undefined` so a
    // future contributor pre-allocating with `Record.fromEntries(...)`
    // doesn't surface `key undefined` in the line.
    const lines = formatProposedInboxStatus({
      total: 12,
      bySource: { conversation: 8, manual: 4, digest: undefined, file: undefined },
      byAgent: { "Claude Code": 9, Codex: 3 },
    })
    expect(lines[0]).toBe(
      "Proposed memories: 12 pending review (sources: conversation 8, manual 4 · agents: Claude Code 9, Codex 3)"
    )
  })

  it("buckets a missing-Source proposal under 'unknown' rather than 'manual'", () => {
    // `MemoryService.countProposed` reads the raw `Source` property
    // and falls back to `"unknown"` (not `"manual"`) so the operator
    // can see when the column was empty without conflating with
    // user-saved manual rows. Pinning that the renderer surfaces the
    // `"unknown"` bucket faithfully.
    const lines = formatProposedInboxStatus({
      total: 5,
      bySource: { conversation: 3, unknown: 2 },
      byAgent: { "Claude Code": 5 },
    })
    expect(lines[0]).toBe(
      "Proposed memories: 5 pending review (sources: conversation 3, unknown 2)"
    )
  })
})

describe("loadProposedInboxStatus", () => {
  it("delegates to MemoryService.countProposed and forwards projectId", async () => {
    const countProposed = vi.fn(async () => ({
      total: 7,
      bySource: { conversation: 5, manual: 2 },
      byAgent: { "Claude Code": 7 },
    }))
    const services = {
      memories: { countProposed },
    } as unknown as Parameters<typeof loadProposedInboxStatus>[0]

    const report = await loadProposedInboxStatus(services, {
      projectId: "project-widget",
    })

    expect(countProposed).toHaveBeenCalledTimes(1)
    expect(countProposed).toHaveBeenCalledWith({ projectId: "project-widget" })
    expect(report).toEqual({
      total: 7,
      bySource: { conversation: 5, manual: 2 },
      byAgent: { "Claude Code": 7 },
    })
  })

  it("forwards an undefined projectId for vault-wide counts", async () => {
    const countProposed = vi.fn(async () => ({
      total: 0,
      bySource: {},
      byAgent: {},
    }))
    const services = {
      memories: { countProposed },
    } as unknown as Parameters<typeof loadProposedInboxStatus>[0]

    await loadProposedInboxStatus(services)

    expect(countProposed).toHaveBeenCalledWith({ projectId: undefined })
  })
})
