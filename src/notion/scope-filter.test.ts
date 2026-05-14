/**
 * Tests for the issue #283 default scope inclusion filter.
 *
 * The filter is the load-bearing gate for "session/run-scoped
 * memories do not become team-wide recall by accident" (the
 * acceptance criterion this feature exists to satisfy). These tests
 * pin the structural shape of the emitted Notion filter so a future
 * refactor cannot silently widen recall.
 */

import { describe, expect, it } from "vitest"
import { FACT_PROPS, MEMORY_PROPS } from "./schema.js"
import {
  defaultScopeInclusionFilter,
  expiringWithinFilter,
  expiredBeforeFilter,
  withDefaultScopeFilter,
  FACT_SCOPE_PROPS,
} from "./filters.js"

describe("defaultScopeInclusionFilter", () => {
  it("emits scopeKind is_empty + the three broadcast scopes when context is empty", () => {
    const filter = defaultScopeInclusionFilter({}, "2026-05-04")
    const top = filter["and"] as Array<Record<string, unknown>>
    expect(top).toHaveLength(2)

    const scopeKindOr = top[0] as { or: Array<Record<string, unknown>> }
    // Empty context → no narrow-scope branches; only is_empty + broadcast.
    expect(scopeKindOr.or).toHaveLength(4)
    expect(scopeKindOr.or[0]).toEqual({
      property: MEMORY_PROPS.SCOPE_KIND,
      select: { is_empty: true },
    })
    expect(scopeKindOr.or[1]).toEqual({
      property: MEMORY_PROPS.SCOPE_KIND,
      select: { equals: "team" },
    })
    expect(scopeKindOr.or[2]).toEqual({
      property: MEMORY_PROPS.SCOPE_KIND,
      select: { equals: "project" },
    })
    expect(scopeKindOr.or[3]).toEqual({
      property: MEMORY_PROPS.SCOPE_KIND,
      select: { equals: "global" },
    })
  })

  it("adds a narrow-kind branch per populated narrow-scope slot (server filter is 2-deep; key binding is client-side)", () => {
    // Issue #283 round-3 — Notion's compound-filter language caps
    // nesting at 2 levels, so the server-side filter cannot express
    // `(kind=session AND key=sess-42)` as one OR child (that's 3
    // levels deep). The kind+key binding moved to the client-side
    // `matchesDefaultScope` post-filter. The server filter still
    // narrows to "kind in [broadcast, ...readers-narrow-kinds]".
    const filter = defaultScopeInclusionFilter(
      { userId: "alice", session: "sess-42" },
      "2026-05-04"
    )
    const scopeKindOr = (filter["and"] as Array<Record<string, unknown>>)[0] as {
      or: Array<Record<string, unknown>>
    }
    // is_empty + 3 broadcast + 2 narrow kinds = 6
    expect(scopeKindOr.or).toHaveLength(6)
    expect(scopeKindOr.or).toContainEqual({
      property: MEMORY_PROPS.SCOPE_KIND,
      select: { equals: "user" },
    })
    expect(scopeKindOr.or).toContainEqual({
      property: MEMORY_PROPS.SCOPE_KIND,
      select: { equals: "session" },
    })
    // Crucially, the server filter does NOT reference Scope Key —
    // that match runs in `matchesDefaultScope` client-side.
    expect(JSON.stringify(scopeKindOr.or)).not.toContain('"Scope Key"')
  })

  it("skips narrow-scope slots whose context value is undefined or empty", () => {
    const filter = defaultScopeInclusionFilter(
      { userId: "alice", agent: "" },
      "2026-05-04"
    )
    const scopeKindOr = (filter["and"] as Array<Record<string, unknown>>)[0] as {
      or: Array<Record<string, unknown>>
    }
    // Empty agent collapses; only userId adds a narrow branch.
    expect(scopeKindOr.or).toHaveLength(5)
    expect(JSON.stringify(scopeKindOr.or)).not.toContain("agent")
  })

  it("emits the expiry clause as `is_empty OR on_or_after today`", () => {
    const filter = defaultScopeInclusionFilter({}, "2026-05-04")
    const expiryOr = (filter["and"] as Array<Record<string, unknown>>)[1] as {
      or: Array<Record<string, unknown>>
    }
    expect(expiryOr.or).toEqual([
      { property: MEMORY_PROPS.EXPIRES_AT, date: { is_empty: true } },
      { property: MEMORY_PROPS.EXPIRES_AT, date: { on_or_after: "2026-05-04" } },
    ])
  })

  it("targets the Facts DB columns when FACT_SCOPE_PROPS is passed", () => {
    // Memories and Facts use the same column NAMES (`Scope Kind` /
    // `Scope Key` / `Expires At`) — what differs is which DB the
    // filter applies to. The structural test below pins that the
    // `property` keys come from the FACT_SCOPE_PROPS struct rather
    // than MEMORY_SCOPE_PROPS by string identity (FACT_PROPS.X ===
    // MEMORY_PROPS.X today, but the abstraction lets a future rename
    // to one DB stay isolated).
    expect(FACT_PROPS.SCOPE_KIND).toBe("Scope Kind")
    expect(FACT_PROPS.SCOPE_KEY).toBe("Scope Key")
    expect(FACT_PROPS.EXPIRES_AT).toBe("Expires At")
    const filter = defaultScopeInclusionFilter(
      { session: "s" },
      "2026-05-04",
      FACT_SCOPE_PROPS
    )
    const top = filter["and"] as Array<Record<string, unknown>>
    const expiryOr = top[1] as { or: Array<Record<string, unknown>> }
    expect(expiryOr.or[0]).toEqual({
      property: FACT_PROPS.EXPIRES_AT,
      date: { is_empty: true },
    })
  })

  it("returns a fresh literal on every call so caller mutations don't leak", () => {
    const a = defaultScopeInclusionFilter({}, "2026-05-04")
    const b = defaultScopeInclusionFilter({}, "2026-05-04")
    expect(a).not.toBe(b)
    ;(a["and"] as Array<unknown>).push("mutated")
    expect((b["and"] as Array<unknown>).length).toBe(2)
  })
})

describe("withDefaultScopeFilter", () => {
  it("returns the bare scope filter when caller filter is undefined", () => {
    const result = withDefaultScopeFilter(undefined, {}, "2026-05-04")
    expect(result).toBeDefined()
    expect(Object.keys(result!)).toEqual(["and"])
  })

  it("appends each scope clause to an existing `and:` array (flat shape)", () => {
    const baseAnd: Record<string, unknown> = {
      and: [{ property: "Foo", select: { equals: "bar" } }],
    }
    const result = withDefaultScopeFilter(baseAnd, { session: "s" }, "2026-05-04")
    const top = (result as { and: Array<Record<string, unknown>> }).and
    // 1 caller clause + 2 scope clauses (or + expiry) = 3 top-level clauses
    expect(top).toHaveLength(3)
    expect(top[0]).toEqual({ property: "Foo", select: { equals: "bar" } })
  })

  it("wraps a bare property filter into a fresh `{ and: [...] }`", () => {
    const bare = { property: "Foo", select: { equals: "bar" } }
    const result = withDefaultScopeFilter(bare, {}, "2026-05-04") as {
      and: Array<Record<string, unknown>>
    }
    expect(result.and[0]).toBe(bare)
    expect(result.and).toHaveLength(3)
  })
})

describe("expiringWithinFilter / expiredBeforeFilter", () => {
  it("expiringWithinFilter selects rows in the inclusive window", () => {
    expect(expiringWithinFilter("2026-05-04", "2026-05-11")).toEqual({
      and: [
        { property: MEMORY_PROPS.EXPIRES_AT, date: { on_or_after: "2026-05-04" } },
        { property: MEMORY_PROPS.EXPIRES_AT, date: { on_or_before: "2026-05-11" } },
      ],
    })
  })

  it("expiredBeforeFilter selects rows strictly before today", () => {
    expect(expiredBeforeFilter("2026-05-04")).toEqual({
      property: MEMORY_PROPS.EXPIRES_AT,
      date: { before: "2026-05-04" },
    })
  })
})
