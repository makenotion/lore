/**
 * Tests for issue #283 review-blocker fixes:
 *
 * 1. `TaskService.list`, `DecisionService.list`, and the
 *    `FactService` entity / subject / object / source-memory query
 *    branches must thread `withDefaultScopeFilter` through their
 *    Notion query so narrow-scope rows whose Scope Key doesn't
 *    match the reader drop out of default reads.
 * 2. `FactService.createWithDedup` must NOT merge a same-triple
 *    fact across a different scope. Both directions: a fresh
 *    session-scoped write must not absorb into an existing team
 *    row, and a fresh team-scoped write must not absorb into an
 *    existing session row.
 *
 * Tests assert structural query shape (the scope clause is present
 * in the emitted Notion filter) rather than executing against a
 * real Notion vault — the integration coverage already exists for
 * the underlying filter helper in `scope-filter.test.ts`.
 */

import { describe, expect, it, vi } from "vitest"
import type { Client } from "@notionhq/client"
import { FactService } from "./fact.js"
import { DecisionService } from "./decision.js"
import { TaskService } from "./task.js"
import { FACT_PROPS, MEMORY_PROPS } from "../notion/schema.js"

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const memoriesDb = { databaseId: "mem-db", dataSourceId: "mem-ds" }
const factsDb = { databaseId: "facts-db", dataSourceId: "facts-ds" }

function createClient(
  opts: {
    results?: unknown[]
    has_more?: boolean
  } = {}
): { client: Client; querySpy: ReturnType<typeof vi.fn> } {
  const querySpy = vi.fn(async () => ({
    results: opts.results ?? [],
    has_more: opts.has_more ?? false,
    next_cursor: null,
  }))
  const client = {
    dataSources: { query: querySpy, retrieve: vi.fn() },
    pages: {
      retrieve: vi.fn(),
      retrieveMarkdown: vi.fn(async () => ({ markdown: "" })),
    },
  } as unknown as Client
  return { client, querySpy }
}

// ---------------------------------------------------------------------------
// TaskService.list — applies default scope filter
// ---------------------------------------------------------------------------

describe("TaskService.list — scope filter (issue #283 review)", () => {
  it("threads scope filter through the Notion query when scope context is injected", async () => {
    const { client, querySpy } = createClient()
    const service = new TaskService(client, memoriesDb, { session: "sess-A" })
    await service.list({ projectId: "p1" })

    const filter = querySpy.mock.calls[0]?.[0]?.filter
    // Issue #283 round-3 — server-side filter narrows to broadcast +
    // the reader's narrow kinds (no key binding; that's client-side
    // via `matchesDefaultScope`). The scope-related columns appear
    // in the dispatched filter; the kind+key match runs in
    // `collectLivePages`'s `extraFilter`.
    const json = JSON.stringify(filter)
    expect(json).toContain('"Scope Kind"')
    expect(json).toContain('"Expires At"')
    // The narrow kind for the reader's session ctx is included as
    // an OR branch.
    expect(json).toContain('"session"')
  })

  it("opts out via includeOutOfScope: true", async () => {
    const { client, querySpy } = createClient()
    const service = new TaskService(client, memoriesDb, { session: "sess-A" })
    await service.list({ projectId: "p1", includeOutOfScope: true })
    const filter = querySpy.mock.calls[0]?.[0]?.filter
    expect(JSON.stringify(filter)).not.toContain('"Scope Kind"')
    expect(JSON.stringify(filter)).not.toContain('"Expires At"')
  })

  it("no-ops when constructed without scope context (legacy fixtures)", async () => {
    const { client, querySpy } = createClient()
    const service = new TaskService(client, memoriesDb)
    await service.list({ projectId: "p1" })
    const filter = querySpy.mock.calls[0]?.[0]?.filter
    expect(JSON.stringify(filter)).not.toContain('"Scope Kind"')
  })
})

// ---------------------------------------------------------------------------
// DecisionService.list — applies default scope filter
// ---------------------------------------------------------------------------

describe("DecisionService.list — scope filter (issue #283 review)", () => {
  it("threads scope filter when scope context is injected", async () => {
    const { client, querySpy } = createClient()
    const service = new DecisionService(client, memoriesDb, {
      agent: "Claude Code",
    })
    await service.list({ projectId: "p1" })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).toContain('"Scope Kind"')
    // Round-3 — server filter narrows to broadcast + reader's narrow
    // kinds; key match runs in `extraFilter` post-filter. The `agent`
    // narrow kind appears as an OR branch.
    expect(json).toContain('"agent"')
  })

  it("opts out via includeOutOfScope", async () => {
    const { client, querySpy } = createClient()
    const service = new DecisionService(client, memoriesDb, {
      agent: "Claude Code",
    })
    await service.list({ projectId: "p1", includeOutOfScope: true })
    expect(JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)).not.toContain(
      '"Scope Kind"'
    )
  })
})

// ---------------------------------------------------------------------------
// FactService entity/subject/object reads — apply default scope filter
// ---------------------------------------------------------------------------

describe("FactService read paths — scope filter (issue #283 review)", () => {
  it("queryBySubject threads scope filter when context is injected", async () => {
    const { client, querySpy } = createClient()
    const service = new FactService(client, factsDb, { session: "sess-A" })
    await service.queryBySubject("AuthService", { projectId: "p1" })
    const filter = querySpy.mock.calls[0]?.[0]?.filter
    const json = JSON.stringify(filter)
    expect(json).toContain('"Scope Kind"')
    expect(json).toContain('"Expires At"')
    // Round-3 — server-side filter is 2-deep; narrow kind branch
    // is included without binding to key. Key match is post-filter.
    expect(json).toContain('"session"')
  })

  it("queryByObject threads scope filter", async () => {
    const { client, querySpy } = createClient()
    const service = new FactService(client, factsDb, { session: "sess-A" })
    await service.queryByObject("DatabaseUrl", { projectId: "p1" })
    const filter = querySpy.mock.calls[0]?.[0]?.filter
    expect(JSON.stringify(filter)).toContain('"Scope Kind"')
  })

  it("queryByEntity threads scope through both relation and unmigrated branches", async () => {
    const { client, querySpy } = createClient()
    const service = new FactService(client, factsDb, { session: "sess-A" })
    await service.queryByEntity("AuthService", {
      projectId: "p1",
      entityId: "ent-1",
    })
    // Both branches should fire (relation + unmigrated text).
    expect(querySpy).toHaveBeenCalledTimes(2)
    for (const call of querySpy.mock.calls) {
      expect(JSON.stringify(call[0]?.filter)).toContain('"Scope Kind"')
    }
  })

  it("queryBySourceMemory threads scope filter by default", async () => {
    const { client, querySpy } = createClient()
    const service = new FactService(client, factsDb, { session: "sess-A" })
    await service.queryBySourceMemory("mem-1", { projectId: "p1" })
    const filter = querySpy.mock.calls[0]?.[0]?.filter
    expect(JSON.stringify(filter)).toContain('"Scope Kind"')
  })

  it("queryBySourceMemory opts out via includeOutOfScope: true", async () => {
    const { client, querySpy } = createClient()
    const service = new FactService(client, factsDb, { session: "sess-A" })
    await service.queryBySourceMemory("mem-1", {
      projectId: "p1",
      includeOutOfScope: true,
    })
    const filter = querySpy.mock.calls[0]?.[0]?.filter
    expect(JSON.stringify(filter)).not.toContain('"Scope Kind"')
  })
})

// ---------------------------------------------------------------------------
// FactService.createWithDedup — scope-aware merge
// ---------------------------------------------------------------------------

/**
 * Build a Notion `PageObjectResponse` shape sufficient to satisfy
 * `pageToFact`. Internal helper for the dedup tests below.
 */
function makeFactPage(opts: {
  id: string
  subject: string
  predicate: string
  object: string
  scopeKind?: string | null
  scopeKey?: string
}): unknown {
  return {
    object: "page",
    id: opts.id,
    created_time: "2026-05-04T00:00:00Z",
    last_edited_time: "2026-05-04T00:00:00Z",
    archived: false,
    parent: { type: "data_source_id", data_source_id: factsDb.dataSourceId },
    properties: {
      [FACT_PROPS.SUBJECT]: {
        type: "title",
        title: [
          { plain_text: opts.subject, type: "text", text: { content: opts.subject } },
        ],
      },
      [FACT_PROPS.PREDICATE]: {
        type: "select",
        select: { name: opts.predicate },
      },
      [FACT_PROPS.OBJECT]: {
        type: "rich_text",
        rich_text: [
          { plain_text: opts.object, type: "text", text: { content: opts.object } },
        ],
      },
      [FACT_PROPS.PROJECT]: { type: "relation", relation: [], has_more: false },
      [FACT_PROPS.SOURCE]: { type: "relation", relation: [], has_more: false },
      [FACT_PROPS.CONFIDENCE]: { type: "select", select: { name: "certain" } },
      [FACT_PROPS.VALID_FROM]: { type: "date", date: null },
      [FACT_PROPS.VALID_UNTIL]: { type: "date", date: null },
      [FACT_PROPS.REVIEW_BY]: { type: "date", date: null },
      [FACT_PROPS.DEDUP_KEY]: { type: "rich_text", rich_text: [] },
      [FACT_PROPS.SUBJECT_KEY]: { type: "rich_text", rich_text: [] },
      [FACT_PROPS.SUBJECT_ENTITY]: {
        type: "relation",
        relation: [],
        has_more: false,
      },
      [FACT_PROPS.OBJECT_ENTITY]: {
        type: "relation",
        relation: [],
        has_more: false,
      },
      [FACT_PROPS.CONFIDENCE_SCORE]: { type: "number", number: null },
      [FACT_PROPS.LAST_REFERENCED_AT]: { type: "date", date: null },
      [FACT_PROPS.SCOPE_KIND]:
        opts.scopeKind === undefined
          ? { type: "select", select: null }
          : opts.scopeKind === null
            ? { type: "select", select: null }
            : { type: "select", select: { name: opts.scopeKind } },
      [FACT_PROPS.SCOPE_KEY]:
        opts.scopeKey !== undefined
          ? {
              type: "rich_text",
              rich_text: [
                {
                  plain_text: opts.scopeKey,
                  type: "text",
                  text: { content: opts.scopeKey },
                },
              ],
            }
          : { type: "rich_text", rich_text: [] },
      [FACT_PROPS.AUDIENCE]: { type: "rich_text", rich_text: [] },
      [FACT_PROPS.LIFETIME]: { type: "select", select: null },
      [FACT_PROPS.EXPIRES_AT]: { type: "date", date: null },
    },
  }
}

describe("FactService.createWithDedup — scope-aware merge (issue #283 review)", () => {
  it("does NOT merge a fresh session-scoped fact into an existing team-scoped row (server filter excludes mismatched-scope rows by construction)", async () => {
    // Round-4: the dedup probe is now scope-constrained server-side.
    // Notion's filter binds every scope column, so the team-scoped
    // existing row never appears in a session-scope query response.
    // The mock therefore returns empty for the session-scope probe.
    // Caller blind-creates the session-scoped row.
    const querySpy = vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const createSpy = vi.fn(async () =>
      makeFactPage({
        id: "fact-session",
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
        scopeKind: "session",
        scopeKey: "sess-A",
      })
    )
    const client = {
      dataSources: { query: querySpy, retrieve: vi.fn() },
      pages: {
        create: createSpy,
        update: vi.fn(),
        retrieveMarkdown: vi.fn(),
      },
    } as unknown as Client
    const service = new FactService(client, factsDb, { session: "sess-A" })

    const result = await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-1",
      scope: { kind: "session", key: "sess-A" },
    })

    expect(result.deduped).toBe(false)
    expect(createSpy).toHaveBeenCalledTimes(1)
    // Probe filter binds Scope Kind=session AND Scope Key=sess-A
    // — the constraint that prevents a team-scoped row from
    // appearing in this query.
    const probeArgs = querySpy.mock.calls[0] as unknown as Array<{
      filter?: unknown
    }>
    const probeFilter = probeArgs[0]?.filter
    const json = JSON.stringify(probeFilter)
    expect(json).toContain('"Scope Kind"')
    expect(json).toContain('"session"')
    expect(json).toContain('"sess-A"')
    // The created fact carries the session scope verbatim.
    const createArgs = createSpy.mock.calls[0] as unknown as Array<{
      properties: Record<string, unknown>
    }>
    const createdProps = createArgs[0].properties
    expect(createdProps[FACT_PROPS.SCOPE_KIND]).toEqual({
      select: { name: "session" },
    })
    expect(createdProps[FACT_PROPS.SCOPE_KEY]).toEqual({
      rich_text: [{ text: { content: "sess-A" } }],
    })
  })

  it("does NOT merge a fresh team-scoped fact into an existing session-scoped row (mirror direction)", async () => {
    // The probe filter binds every scope column to is_empty for a
    // no-scope (team/broadcast) write. The session-scoped existing
    // row carries a non-empty Scope Kind, so the server filter
    // excludes it and the mock returns empty.
    const querySpy = vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const createSpy = vi.fn(async () =>
      makeFactPage({
        id: "fact-team",
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
      })
    )
    const client = {
      dataSources: { query: querySpy, retrieve: vi.fn() },
      pages: {
        create: createSpy,
        update: vi.fn(),
        retrieveMarkdown: vi.fn(),
      },
    } as unknown as Client
    const service = new FactService(client, factsDb, { session: "sess-A" })

    // Caller writes the team-wide assertion (no scope bundle declared).
    const result = await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-1",
      // scope is omitted — team / broadcast write
    })

    expect(result.deduped).toBe(false)
    expect(createSpy).toHaveBeenCalledTimes(1)
    // No-scope probe binds Scope Kind=is_empty.
    const firstCall = querySpy.mock.calls[0] as unknown as Array<{ filter?: unknown }>
    const probeFilter = firstCall[0]?.filter
    expect(JSON.stringify(probeFilter)).toContain('"is_empty":true')
  })

  it("DOES merge two same-triple writes that declare the same scope", async () => {
    const existingPage = makeFactPage({
      id: "fact-session",
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      scopeKind: "session",
      scopeKey: "sess-A",
    })
    const querySpy = vi.fn(async () => ({
      results: [existingPage],
      has_more: false,
      next_cursor: null,
    }))
    const updateSpy = vi.fn(async () => existingPage)
    const createSpy = vi.fn()
    const client = {
      dataSources: { query: querySpy, retrieve: vi.fn() },
      pages: {
        create: createSpy,
        update: updateSpy,
        retrieveMarkdown: vi.fn(),
      },
    } as unknown as Client
    const service = new FactService(client, factsDb, { session: "sess-A" })

    const result = await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-2",
      scope: { kind: "session", key: "sess-A" },
    })

    expect(result.deduped).toBe(true)
    expect(createSpy).not.toHaveBeenCalled()
  })

  it("DOES merge two same-triple writes that both omit scope (legacy behavior)", async () => {
    const existingPage = makeFactPage({
      id: "fact-team",
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    })
    const querySpy = vi.fn(async () => ({
      results: [existingPage],
      has_more: false,
      next_cursor: null,
    }))
    const updateSpy = vi.fn(async () => existingPage)
    const createSpy = vi.fn()
    const client = {
      dataSources: { query: querySpy, retrieve: vi.fn() },
      pages: {
        create: createSpy,
        update: updateSpy,
        retrieveMarkdown: vi.fn(),
      },
    } as unknown as Client
    const service = new FactService(client, factsDb, { session: "sess-A" })

    const result = await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-2",
    })

    expect(result.deduped).toBe(true)
    expect(createSpy).not.toHaveBeenCalled()
  })

  it("dedup probe filter binds every scope column on the server (round-4)", async () => {
    // Round-4: the dedup probe is now scope-constrained. The filter
    // includes one clause per scope column (kind/key/audience/
    // lifetime/expiresAt) so Notion returns at most the row whose
    // scope bundle deep-equals the incoming write's scope. There's
    // no client-side candidate walking and no arbitrary cap on
    // mismatched rows preceding the compatible one — Notion does
    // the bundle-equality match itself.
    const querySpy = vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const createSpy = vi.fn(async () =>
      makeFactPage({
        id: "fact-session",
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
        scopeKind: "session",
        scopeKey: "sess-A",
      })
    )
    const client = {
      dataSources: { query: querySpy, retrieve: vi.fn() },
      pages: {
        create: createSpy,
        update: vi.fn(),
        retrieveMarkdown: vi.fn(),
      },
    } as unknown as Client
    const service = new FactService(client, factsDb, { session: "sess-A" })

    await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-1",
      scope: {
        kind: "session",
        key: "sess-A",
        audience: "team",
        lifetime: "expires",
        expiresAt: "2026-06-01",
      },
    })

    // Each scope column appears as an explicit `equals` clause in
    // the probe filter, not just `is_empty`. A future contributor
    // dropping any clause from the probe builder would break this
    // assertion AND structurally re-enable the round-4 blocker.
    const firstCall = querySpy.mock.calls[0] as unknown as Array<{ filter?: unknown }>
    const probeFilter = firstCall[0]?.filter
    const json = JSON.stringify(probeFilter)
    expect(json).toContain('"Scope Kind"')
    expect(json).toContain('"session"')
    expect(json).toContain('"Scope Key"')
    expect(json).toContain('"sess-A"')
    expect(json).toContain('"Audience"')
    expect(json).toContain('"team"')
    expect(json).toContain('"Lifetime"')
    expect(json).toContain('"expires"')
    expect(json).toContain('"Expires At"')
    expect(json).toContain('"2026-06-01"')
  })

  it("scales past 250 mismatched rows preceding the compatible row (round-4 blocker fix)", async () => {
    // Round-4 review's regression scenario: pre-fix the candidate
    // walker capped at 250 rows total; if the compatible row sat at
    // candidate 251 the caller blind-created a duplicate. Round-4
    // moved the scope binding server-side, so Notion returns the
    // compatible row directly regardless of how many mismatched rows
    // exist for the same dedup key. The mock returns one row when
    // the filter matches the session-A scope (server-side filtering
    // is what would happen against real Notion).
    const matchingPage = makeFactPage({
      id: "fact-compatible",
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      scopeKind: "session",
      scopeKey: "sess-A",
    })
    const querySpy = vi.fn(async () => ({
      // Server-side filter has matched and returned the compatible
      // row. The 250 mismatched rows that exist in the vault never
      // reach the client because the server filter excludes them.
      results: [matchingPage],
      has_more: false,
      next_cursor: null,
    }))
    const updateSpy = vi.fn(async () => matchingPage)
    const createSpy = vi.fn()
    const client = {
      dataSources: { query: querySpy, retrieve: vi.fn() },
      pages: {
        create: createSpy,
        update: updateSpy,
        retrieveMarkdown: vi.fn(),
      },
    } as unknown as Client
    const service = new FactService(client, factsDb, { session: "sess-A" })

    const result = await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-1",
      scope: { kind: "session", key: "sess-A" },
    })

    expect(result.deduped).toBe(true)
    expect(result.fact.id).toBe("fact-compatible")
    expect(createSpy).not.toHaveBeenCalled()
    // Single round-trip — no walker pagination.
    expect(querySpy).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// MemoryService.list / FactService.listRecent — service-level scope filter
// coverage (locks the issue #283 acceptance criterion that was approve-review
// flagged as a should-fix coverage gap)
// ---------------------------------------------------------------------------

describe("MemoryService.list — scope filter end-to-end (issue #283 acceptance)", () => {
  it("emits the issue #283 scope clause in the dispatched Notion filter when scopeCtx is injected", async () => {
    const { MemoryService } = await import("./memory.js")
    const { client, querySpy } = createClient()
    const service = new MemoryService(client, memoriesDb, { session: "sess-A" })
    await service.list({ projectId: "p1" })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).toContain('"Scope Kind"')
    expect(json).toContain('"Expires At"')
    // Round-3 — server-side narrows by kind; key match is client-
    // side. The narrow kind for the reader's session ctx appears
    // as an OR branch.
    expect(json).toContain('"session"')
  })

  it("includeOutOfScope: true skips the scope clause", async () => {
    const { MemoryService } = await import("./memory.js")
    const { client, querySpy } = createClient()
    const service = new MemoryService(client, memoriesDb, { session: "sess-A" })
    await service.list({ projectId: "p1", includeOutOfScope: true })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).not.toContain('"Scope Kind"')
    expect(json).not.toContain('"Expires At"')
  })

  it("legacy fixtures (no scope context) emit pre-#283 filter shape", async () => {
    const { MemoryService } = await import("./memory.js")
    const { client, querySpy } = createClient()
    const service = new MemoryService(client, memoriesDb)
    await service.list({ projectId: "p1" })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).not.toContain('"Scope Kind"')
  })
})

describe("FactService.listRecent — scope filter end-to-end", () => {
  it("emits the issue #283 scope clause in the dispatched Notion filter when scopeCtx is injected", async () => {
    const { client, querySpy } = createClient()
    const service = new FactService(client, factsDb, { session: "sess-A" })
    await service.listRecent({ projectId: "p1" })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).toContain('"Scope Kind"')
    expect(json).toContain('"Expires At"')
    expect(json).toContain('"session"')
  })

  it("includeOutOfScope: true skips the scope clause", async () => {
    const { client, querySpy } = createClient()
    const service = new FactService(client, factsDb, { session: "sess-A" })
    await service.listRecent({ projectId: "p1", includeOutOfScope: true })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).not.toContain('"Scope Kind"')
  })
})

// ---------------------------------------------------------------------------
// matchesDefaultScope: fail-CLOSED on unknown scope kinds (issue #283 round-2)
// ---------------------------------------------------------------------------

describe("semantic post-filter — unknown Scope Kind handling", () => {
  // The semantic post-filter runs client-side on `client.search`
  // results. The server-side filter has no clause for an unknown
  // `Scope Kind` select option (e.g. someone manually adding a
  // `"vault"` value to the Notion select column outside the migration
  // path), so the row is dropped on the contains lane. The client-
  // side mirror must drop the row too — otherwise the semantic lane
  // surfaces it and callers see asymmetric results across the two
  // lanes.
  //
  // We exercise this through `MemoryService.applySemanticPostFilters`
  // by mocking `client.search` to return a single page carrying an
  // unknown Scope Kind, then asserting the page is filtered out.
  it("drops a row whose Scope Kind is an unrecognized value", async () => {
    const { MemoryService } = await import("./memory.js")
    const unknownPage = {
      object: "page" as const,
      id: "mem-unknown",
      created_time: "2026-05-04T00:00:00Z",
      last_edited_time: "2026-05-04T00:00:00Z",
      archived: false,
      parent: {
        type: "data_source_id" as const,
        data_source_id: memoriesDb.dataSourceId,
      },
      properties: {
        [MEMORY_PROPS.TITLE]: {
          type: "title",
          title: [{ plain_text: "x", type: "text", text: { content: "x" } }],
        },
        [MEMORY_PROPS.SCOPE_KIND]: {
          type: "select",
          select: { name: "vault" }, // unknown kind not in the closed enum
        },
        [MEMORY_PROPS.SCOPE_KEY]: {
          type: "rich_text",
          rich_text: [
            {
              plain_text: "anything",
              type: "text",
              text: { content: "anything" },
            },
          ],
        },
        [MEMORY_PROPS.KEYWORDS]: { type: "rich_text", rich_text: [] },
      },
    }
    const client = {
      search: vi.fn(async () => ({
        results: [unknownPage],
        has_more: false,
      })),
      dataSources: { query: vi.fn() },
      pages: {
        retrieveMarkdown: vi.fn(async () => ({ markdown: "" })),
        retrieve: vi.fn(),
      },
    } as unknown as Client
    const service = new MemoryService(client, memoriesDb, { session: "sess-A" })
    const result = await service.search({
      query: "anything",
      mode: "semantic",
    })
    // Unknown-kind row must be filtered out by the client-side scope
    // post-filter so it doesn't surface where the server filter would
    // have dropped it.
    expect(result.find((m) => m.id === "mem-unknown")).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Migration safety: scope columns missing on legacy vault
// ---------------------------------------------------------------------------

describe("scope column probe (issue #283 review — migration safety)", () => {
  it("probeScopeColumnsPresent returns false when Memories DS lacks Scope Kind", async () => {
    const { probeScopeColumnsPresent } = await import("../services.js")
    const memWithoutScope = {
      properties: {
        // No Scope Kind / Expires At
        Title: { type: "title" },
      },
    }
    const factWithScope = {
      properties: {
        [FACT_PROPS.SCOPE_KIND]: { type: "select" },
        [FACT_PROPS.EXPIRES_AT]: { type: "date" },
      },
    }
    const client = {
      dataSources: {
        retrieve: vi.fn(async (args: { data_source_id: string }) =>
          args.data_source_id === memoriesDb.dataSourceId
            ? memWithoutScope
            : factWithScope
        ),
      },
    } as unknown as Client
    const ready = await probeScopeColumnsPresent(client, {
      projects: { databaseId: "p", dataSourceId: "p" },
      topics: { databaseId: "t", dataSourceId: "t" },
      memories: memoriesDb,
      entities: { databaseId: "e", dataSourceId: "e" },
      facts: factsDb,
    })
    expect(ready).toBe(false)
  })

  it("probeScopeColumnsPresent returns true when both DBs have all scope columns", async () => {
    const { probeScopeColumnsPresent } = await import("../services.js")
    // Memories and Facts share the same scope-column names so one
    // map covers both DSes.
    const dsWithScope = {
      properties: {
        [MEMORY_PROPS.SCOPE_KIND]: { type: "select" },
        [MEMORY_PROPS.EXPIRES_AT]: { type: "date" },
      },
    }
    const client = {
      dataSources: {
        retrieve: vi.fn(async () => dsWithScope),
      },
    } as unknown as Client
    const ready = await probeScopeColumnsPresent(client, {
      projects: { databaseId: "p", dataSourceId: "p" },
      topics: { databaseId: "t", dataSourceId: "t" },
      memories: memoriesDb,
      entities: { databaseId: "e", dataSourceId: "e" },
      facts: factsDb,
    })
    expect(ready).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Audience-leg dedup: pin scopesMatchForMerge audience equality
// (round-2 review's outstanding audience-dedup ask)
// ---------------------------------------------------------------------------

describe("FactService.createWithDedup — audience leg of scope match", () => {
  // Round-4: same triple, same kind, same key, but different
  // audience strings → must produce two distinct rows. The
  // server-side scope-constrained probe binds `Audience` along
  // with `Scope Kind` / `Scope Key` / `Lifetime` / `Expires At`,
  // so a `audience: "public"` write does not match an existing
  // `audience: "internal-only"` row. The server filter excludes
  // the mismatched-audience row from the probe response.
  it("dedup probe binds Audience server-side; mismatched audience produces a distinct row", async () => {
    // Scenario: an `audience: "internal-only"` row exists in the
    // vault. The new write declares `audience: "public"`. The
    // probe filter binds `Audience equals "public"`, so the
    // existing `internal-only` row never appears in the probe
    // response. Caller blind-creates the public-audience row.
    const querySpy = vi.fn(async () => ({
      results: [],
      has_more: false,
      next_cursor: null,
    }))
    const createSpy = vi.fn(async () =>
      makeFactPage({
        id: "fact-public",
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
        scopeKind: "team",
      })
    )
    const client = {
      dataSources: { query: querySpy, retrieve: vi.fn() },
      pages: {
        create: createSpy,
        update: vi.fn(),
        retrieveMarkdown: vi.fn(),
      },
    } as unknown as Client
    const service = new FactService(client, factsDb, { session: "sess-A" })

    const result = await service.createWithDedup({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      sourceMemoryId: "mem-1",
      scope: { kind: "team", audience: "public" },
    })

    expect(result.deduped).toBe(false)
    expect(createSpy).toHaveBeenCalledTimes(1)
    // Probe binds Audience=public.
    const firstCall = querySpy.mock.calls[0] as unknown as Array<{ filter?: unknown }>
    const probeFilter = firstCall[0]?.filter
    const json = JSON.stringify(probeFilter)
    expect(json).toContain('"Audience"')
    expect(json).toContain('"public"')
  })
})

// ---------------------------------------------------------------------------
// Round-3's paginating candidate walker tests are obsolete — round-4
// replaced the walker with a scope-constrained server-side query
// (`findScopeMatchingLiveByDedupKey`). The post-#283 probe binds every
// scope column on the server, so there's no client-side walker to
// test pagination on. The "scales past 250 mismatched rows" test
// above is the round-4 successor: it pins that the probe is a single
// round-trip regardless of how many same-key rows exist server-side,
// because the server filter does the kind+key+audience+lifetime+
// expiresAt match itself.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Compare-dispatch facts — pair-scope rule (round-3 review blocker)
// ---------------------------------------------------------------------------

describe("compare-dispatch facts — pair-scope rule (round-3)", () => {
  it("pairScopeForFactEmission emits with shared scope when both rows agree", async () => {
    const { pairScopeForFactEmission } = await import("../types.js")
    const result = pairScopeForFactEmission(
      {
        kind: "session",
        key: "sess-A",
        audience: "",
        lifetime: null,
        expiresAt: null,
      },
      {
        kind: "session",
        key: "sess-A",
        audience: "",
        lifetime: null,
        expiresAt: null,
      }
    )
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scope?.kind).toBe("session")
  })

  it("pairScopeForFactEmission rejects when scopes differ (one narrower than the other)", async () => {
    const { pairScopeForFactEmission } = await import("../types.js")
    const result = pairScopeForFactEmission(
      {
        kind: "session",
        key: "sess-A",
        audience: "",
        lifetime: null,
        expiresAt: null,
      },
      // Other row is broadcast (null scope kind)
      null
    )
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toContain("pair-scope mismatch")
    }
  })

  it("pairScopeForFactEmission emits no-scope when both rows are pre-#283 broadcast (legacy)", async () => {
    const { pairScopeForFactEmission } = await import("../types.js")
    const result = pairScopeForFactEmission(null, null)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.scope).toBeUndefined()
  })

  it("recordContradiction skips fact emission when scopes mismatch", async () => {
    const { recordContradiction } = await import("./memory.js")
    const facts = {
      createWithDedup: vi.fn(),
    }
    const decrementConfidence = vi.fn(async () => 0.45)
    const memories = { decrementConfidence }
    const decisions = { supersede: vi.fn() }
    const services = { facts, memories, decisions }

    const result = await recordContradiction(services, {
      contradictedMemory: {
        id: "mem-loser",
        title: "Loser",
        projectIds: ["p1"],
        confidence: "certain",
        confidenceScore: 0.9,
        lastReferencedAt: "2026-05-01",
        createdAt: "2026-04-01",
        compareNotes: "",
        scope: {
          kind: "session",
          key: "sess-A",
          audience: "",
          lifetime: null,
          expiresAt: null,
        },
      },
      sourceMemory: {
        id: "mem-winner",
        title: "Winner",
        projectIds: ["p1"],
        scope: null, // broadcast — mismatched with loser's session-scoped
      },
      judgeConfidence: undefined,
    })

    // Fact emission was skipped — pair-scope rejected.
    expect(result.factId).toBeNull()
    expect(facts.createWithDedup).not.toHaveBeenCalled()
    expect(result.factEmissionSkippedReason).toContain("pair-scope mismatch")
    // Confidence decrement still landed (the contradiction is real).
    expect(decrementConfidence).toHaveBeenCalledTimes(1)
  })

  it("recordContradiction emits the fact when both rows share scope", async () => {
    const { recordContradiction } = await import("./memory.js")
    const facts = {
      createWithDedup: vi.fn(async () => ({
        fact: { id: "fact-conflict" },
        deduped: false,
      })),
    }
    const decrementConfidence = vi.fn(async () => 0.45)
    const memories = { decrementConfidence }
    const decisions = { supersede: vi.fn() }
    const services = { facts, memories, decisions }

    const sharedScope = {
      kind: "session" as const,
      key: "sess-A",
      audience: "",
      lifetime: null,
      expiresAt: null,
    }

    const result = await recordContradiction(services, {
      contradictedMemory: {
        id: "mem-loser",
        title: "Loser",
        projectIds: ["p1"],
        confidence: "certain",
        confidenceScore: 0.9,
        lastReferencedAt: "2026-05-01",
        createdAt: "2026-04-01",
        compareNotes: "",
        scope: sharedScope,
      },
      sourceMemory: {
        id: "mem-winner",
        title: "Winner",
        projectIds: ["p1"],
        scope: sharedScope,
      },
      judgeConfidence: undefined,
    })

    expect(result.factId).toBe("fact-conflict")
    expect(facts.createWithDedup).toHaveBeenCalledTimes(1)
    const callArgs = facts.createWithDedup.mock.calls[0] as unknown as Array<{
      scope?: { kind?: string }
    }>
    // Fact carries the shared session scope.
    expect(callArgs[0]?.scope?.kind).toBe("session")
  })
})

// ---------------------------------------------------------------------------
// Auto-mentions scope inheritance (round-2 follow-up)
// ---------------------------------------------------------------------------

describe("auto-mentions scope inheritance — memoryScopeToInput contract", () => {
  it("memoryScopeToInput returns undefined for null/absent scope (legacy passthrough)", async () => {
    const { memoryScopeToInput } = await import("../types.js")
    expect(memoryScopeToInput(null)).toBeUndefined()
    expect(memoryScopeToInput(undefined)).toBeUndefined()
  })

  it("memoryScopeToInput populates kind/key/lifetime/expiresAt from a populated scope", async () => {
    const { memoryScopeToInput } = await import("../types.js")
    const result = memoryScopeToInput({
      kind: "session",
      key: "sess-A",
      audience: "internal",
      lifetime: "expires",
      expiresAt: "2026-06-01",
    })
    expect(result).toEqual({
      kind: "session",
      key: "sess-A",
      audience: "internal",
      lifetime: "expires",
      expiresAt: "2026-06-01",
    })
  })

  it("memoryScopeToInput collapses empty rich_text components to undefined (legacy clears)", async () => {
    const { memoryScopeToInput } = await import("../types.js")
    const result = memoryScopeToInput({
      kind: null,
      key: "",
      audience: "",
      lifetime: null,
      expiresAt: null,
    })
    expect(result).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Migration scope-aware grouping (round-3 review blocker)
// ---------------------------------------------------------------------------

describe("runFactDedupBackfill — scope-aware grouping (round-3)", () => {
  // The migration must group by (dedupKey, scope kind, scope key,
  // audience, lifetime, expiresAt). Pre-fix it grouped by dedupKey
  // alone, which would collapse same-triple-different-scope rows
  // and invalidate the narrow-scoped one (or absorb the broadcast
  // one into a session). Post-fix the rows live independently.
  it("returns survivor.dedupKey on FactMergePlan, not the composite group key (round-4 cleanup)", async () => {
    // Round-4 review: `FactMergePlan.dedupKey` is documented as the
    // stable SHA-256 hash. Round-3 grouping switched the Map key
    // to a composite of `dedupKey + scope bundle`; the plan must
    // surface the actual hash, not the composite. Programmatic
    // consumers indexing by dedupKey or comparing against
    // `computeFactDedupKey(triple)` would break otherwise.
    const { runFactDedupBackfill } = await import("./fact-dedup.js")
    const { computeFactDedupKey } = await import("../notion/normalize.js")
    const expectedDedupKey = computeFactDedupKey({
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    })
    const buildPage = (id: string) => {
      const page = makeFactPage({
        id,
        subject: "AuthService",
        predicate: "uses",
        object: "JWT",
      }) as { properties: Record<string, unknown> }
      // Pre-populate DedupKey with the canonical hash so Phase 1
      // (backfill) skips the row and Phase 2 (merge) sees the
      // hash on the survivor.
      page.properties[FACT_PROPS.DEDUP_KEY] = {
        type: "rich_text",
        rich_text: [
          {
            plain_text: expectedDedupKey,
            type: "text",
            text: { content: expectedDedupKey },
          },
        ],
      }
      return page
    }
    const querySpy = vi.fn(async () => ({
      results: [buildPage("fact-survivor"), buildPage("fact-loser")],
      has_more: false,
      next_cursor: null,
    }))
    const updateSpy = vi.fn()
    const client = {
      dataSources: { query: querySpy, retrieve: vi.fn() },
      pages: { update: updateSpy },
    } as unknown as Client

    const result = await runFactDedupBackfill(client, factsDb, {
      merge: true,
      yes: true,
    })

    expect(result.plans).toHaveLength(1)
    // The plan's `dedupKey` MUST be the stored SHA-256 hash, not
    // the composite grouping key (which would include unit-
    // separator-joined scope columns).
    expect(result.plans[0].dedupKey).toBe(expectedDedupKey)
    expect(result.plans[0].dedupKey).not.toContain("\x1F")
  })

  it("does NOT merge same-triple-different-scope rows", async () => {
    const { runFactDedupBackfill } = await import("./fact-dedup.js")
    const teamPage = makeFactPage({
      id: "fact-team",
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
    })
    // Add the matching DedupKey so the row qualifies for the merge
    // grouping at all.
    const dedupKey = "deadbeef".repeat(8)
    ;(teamPage as { properties: Record<string, unknown> }).properties[
      FACT_PROPS.DEDUP_KEY
    ] = {
      type: "rich_text",
      rich_text: [{ plain_text: dedupKey, type: "text", text: { content: dedupKey } }],
    }
    const sessionPage = makeFactPage({
      id: "fact-session",
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      scopeKind: "session",
      scopeKey: "sess-A",
    })
    ;(sessionPage as { properties: Record<string, unknown> }).properties[
      FACT_PROPS.DEDUP_KEY
    ] = {
      type: "rich_text",
      rich_text: [{ plain_text: dedupKey, type: "text", text: { content: dedupKey } }],
    }
    const querySpy = vi.fn(async () => ({
      results: [teamPage, sessionPage],
      has_more: false,
      next_cursor: null,
    }))
    const updateSpy = vi.fn()
    const client = {
      dataSources: { query: querySpy, retrieve: vi.fn() },
      pages: { update: updateSpy },
    } as unknown as Client

    const result = await runFactDedupBackfill(client, factsDb, {
      merge: true,
      yes: true,
    })

    // Different scopes ⇒ different groups ⇒ no merge plan, no
    // invalidation.
    expect(result.mergedGroups).toBe(0)
    expect(result.invalidated).toBe(0)
    expect(result.plans).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Overdue / audit read paths — scope filter (issue #283 round-5 review)
// ---------------------------------------------------------------------------

/**
 * The wake-up `## Overdue for Review` decision section and the MCP
 * `lore-query action='audit'` fan-out both consume the three
 * `queryOverdue*` paths. Without scope filtering, a session-scoped
 * overdue fact / decision / task surfaces to readers whose session
 * id differs — the exact retrieval-contract violation issue #283
 * exists to prevent. Round-5 threads `withDefaultScopeFilter` (and
 * the client-side `matchesDefaultScope` post-filter via
 * `extraFilter`) through all three.
 */
describe("FactService.queryOverdue — scope filter (issue #283 round-5)", () => {
  it("threads the default-scope filter through the Notion query when scopeCtx is injected", async () => {
    const { client, querySpy } = createClient()
    const service = new FactService(client, factsDb, { session: "sess-A" })
    await service.queryOverdue({ projectId: "p1" })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    // Server-side narrows to broadcast + reader's narrow kind; key
    // match runs client-side via `matchesDefaultScope`.
    expect(json).toContain('"Scope Kind"')
    expect(json).toContain('"Expires At"')
    expect(json).toContain('"session"')
  })

  it("opts out via includeOutOfScope: true (audit / migration callers)", async () => {
    const { client, querySpy } = createClient()
    const service = new FactService(client, factsDb, { session: "sess-A" })
    await service.queryOverdue({ projectId: "p1", includeOutOfScope: true })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).not.toContain('"Scope Kind"')
    expect(json).not.toContain('"Expires At"')
  })

  it("legacy fixtures (no scope context) emit pre-#283 filter shape", async () => {
    const { client, querySpy } = createClient()
    const service = new FactService(client, factsDb)
    await service.queryOverdue({ projectId: "p1" })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).not.toContain('"Scope Kind"')
  })

  it("client-side post-filter drops a mismatched-scope-key row even if the server response leaks it through", async () => {
    // Server-side narrowing on `Scope Kind` is 2-level deep; the
    // kind+key binding runs client-side. A row with
    // `Scope Kind = "session"` whose `Scope Key !== reader.session`
    // would survive the server filter (the kind branch matched) but
    // must drop client-side. This test drives the client-side
    // `postScopeFilterPredicate` directly: the mock returns one
    // mismatched-session row, and the assertion is that
    // `queryOverdue` returns an empty array (the row never reaches
    // `pageToFact`).
    const mismatchedRow = makeFactPage({
      id: "fact-other-session",
      subject: "AuthService",
      predicate: "uses",
      object: "JWT",
      scopeKind: "session",
      scopeKey: "sess-OTHER",
    })
    const querySpy = vi.fn(async () => ({
      results: [mismatchedRow],
      has_more: false,
      next_cursor: null,
    }))
    const client = {
      dataSources: { query: querySpy, retrieve: vi.fn() },
      pages: {
        retrieve: vi.fn(),
        retrieveMarkdown: vi.fn(async () => ({ markdown: "" })),
        properties: { retrieve: vi.fn() },
      },
    } as unknown as Client
    const service = new FactService(client, factsDb, { session: "sess-A" })
    const result = await service.queryOverdue({ projectId: "p1" })
    expect(result).toEqual([])
  })
})

describe("DecisionService.queryOverdueWindow — scope filter (issue #283 round-5)", () => {
  it("threads the default-scope filter when scopeCtx is injected", async () => {
    const { client, querySpy } = createClient()
    const service = new DecisionService(client, memoriesDb, {
      session: "sess-A",
    })
    await service.queryOverdueWindow({ projectId: "p1" })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).toContain('"Scope Kind"')
    expect(json).toContain('"Expires At"')
    expect(json).toContain('"session"')
  })

  it("opts out via includeOutOfScope: true", async () => {
    const { client, querySpy } = createClient()
    const service = new DecisionService(client, memoriesDb, {
      session: "sess-A",
    })
    await service.queryOverdueWindow({
      projectId: "p1",
      includeOutOfScope: true,
    })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).not.toContain('"Scope Kind"')
  })

  it("legacy fixtures (no scope context) emit pre-#283 filter shape", async () => {
    const { client, querySpy } = createClient()
    const service = new DecisionService(client, memoriesDb)
    await service.queryOverdueWindow({ projectId: "p1" })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).not.toContain('"Scope Kind"')
  })
})

describe("TaskService.queryOverdueWindow — scope filter (issue #283 round-5)", () => {
  it("threads the default-scope filter when scopeCtx is injected", async () => {
    const { client, querySpy } = createClient()
    const service = new TaskService(client, memoriesDb, { session: "sess-A" })
    await service.queryOverdueWindow({ projectId: "p1" })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).toContain('"Scope Kind"')
    expect(json).toContain('"Expires At"')
    expect(json).toContain('"session"')
  })

  it("opts out via includeOutOfScope: true", async () => {
    const { client, querySpy } = createClient()
    const service = new TaskService(client, memoriesDb, { session: "sess-A" })
    await service.queryOverdueWindow({
      projectId: "p1",
      includeOutOfScope: true,
    })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).not.toContain('"Scope Kind"')
  })

  it("legacy fixtures (no scope context) emit pre-#283 filter shape", async () => {
    const { client, querySpy } = createClient()
    const service = new TaskService(client, memoriesDb)
    await service.queryOverdueWindow({ projectId: "p1" })
    const json = JSON.stringify(querySpy.mock.calls[0]?.[0]?.filter)
    expect(json).not.toContain('"Scope Kind"')
  })
})
