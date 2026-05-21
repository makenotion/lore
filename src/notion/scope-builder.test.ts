/**
 * Tests for the issue #283 scope/lifetime builder + extractor
 * primitives. Exercises `buildMemoryProps` and `buildFactProps`
 * against the new tristate semantics on each of the five scope
 * columns: undefined leaves, null clears (selects/dates), value
 * writes; rich_text columns emit empty string on clear.
 */

import { describe, expect, it } from "vitest"
import {
  buildFactProps,
  buildMemoryProps,
  FACT_PROPS,
  MEMORY_PROPS,
  memoriesProperties,
  factsProperties,
} from "./schema.js"
import { MEMORY_LIFETIMES, MEMORY_SCOPE_KINDS } from "../types.js"

describe("memoriesProperties — scope columns (issue #283)", () => {
  it("emits Scope Kind, Scope Key, Audience, Lifetime, and Expires At", () => {
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    expect(props[MEMORY_PROPS.SCOPE_KIND]).toEqual({
      select: {
        options: [
          { name: "team", color: "blue" },
          { name: "project", color: "green" },
          { name: "user", color: "yellow" },
          { name: "agent", color: "purple" },
          { name: "role", color: "orange" },
          { name: "session", color: "pink" },
          { name: "run", color: "red" },
          { name: "environment", color: "brown" },
          { name: "global", color: "gray" },
        ],
      },
    })
    expect(props[MEMORY_PROPS.SCOPE_KEY]).toEqual({ rich_text: {} })
    expect(props[MEMORY_PROPS.AUDIENCE]).toEqual({ rich_text: {} })
    expect(props[MEMORY_PROPS.EXPIRES_AT]).toEqual({ date: {} })

    const lifetime = props[MEMORY_PROPS.LIFETIME] as {
      select: { options: Array<{ name: string }> }
    }
    expect(lifetime.select.options.map((o) => o.name)).toEqual(MEMORY_LIFETIMES)
  })

  it("Scope Kind options match the MEMORY_SCOPE_KINDS enum exactly", () => {
    const props = memoriesProperties("p-ds", "t-ds", "m-ds")
    const kindProp = props[MEMORY_PROPS.SCOPE_KIND] as {
      select: { options: Array<{ name: string }> }
    }
    expect(kindProp.select.options.map((o) => o.name)).toEqual(MEMORY_SCOPE_KINDS)
  })
})

describe("factsProperties — scope columns mirror Memories DB", () => {
  it("emits the same five columns as the Memories DB", () => {
    const props = factsProperties("p-ds", "m-ds", "e-ds")
    const factKindProp = props[FACT_PROPS.SCOPE_KIND] as {
      select: { options: Array<{ name: string }> }
    }
    expect(factKindProp.select.options.map((o) => o.name)).toEqual(MEMORY_SCOPE_KINDS)
    const factLifetimeProp = props[FACT_PROPS.LIFETIME] as {
      select: { options: Array<{ name: string }> }
    }
    expect(factLifetimeProp.select.options.map((o) => o.name)).toEqual(MEMORY_LIFETIMES)
    expect(props[FACT_PROPS.SCOPE_KEY]).toEqual({ rich_text: {} })
    expect(props[FACT_PROPS.AUDIENCE]).toEqual({ rich_text: {} })
    expect(props[FACT_PROPS.EXPIRES_AT]).toEqual({ date: {} })
  })
})

describe("buildMemoryProps — scope tristate semantics", () => {
  it("undefined fields leave columns untouched", () => {
    const props = buildMemoryProps({ title: "x" }) as Record<string, unknown>
    expect("Scope Kind" in props).toBe(false)
    expect("Scope Key" in props).toBe(false)
    expect("Audience" in props).toBe(false)
    expect("Lifetime" in props).toBe(false)
    expect("Expires At" in props).toBe(false)
  })

  it("null on select / date columns clears via Notion's null sentinel", () => {
    const props = buildMemoryProps({
      title: "x",
      scopeKind: null,
      lifetime: null,
      expiresAt: null,
    }) as Record<string, unknown>
    expect(props[MEMORY_PROPS.SCOPE_KIND]).toEqual({ select: null })
    expect(props[MEMORY_PROPS.LIFETIME]).toEqual({ select: null })
    expect(props[MEMORY_PROPS.EXPIRES_AT]).toEqual({ date: null })
  })

  it("populated values write the named option / date verbatim", () => {
    const props = buildMemoryProps({
      title: "x",
      scopeKind: "session",
      scopeKey: "sess-42",
      audience: "team",
      lifetime: "expires",
      expiresAt: "2026-06-01",
    }) as Record<string, unknown>
    expect(props[MEMORY_PROPS.SCOPE_KIND]).toEqual({
      select: { name: "session" },
    })
    expect(props[MEMORY_PROPS.SCOPE_KEY]).toEqual({
      rich_text: [{ text: { content: "sess-42" } }],
    })
    expect(props[MEMORY_PROPS.AUDIENCE]).toEqual({
      rich_text: [{ text: { content: "team" } }],
    })
    expect(props[MEMORY_PROPS.LIFETIME]).toEqual({
      select: { name: "expires" },
    })
    expect(props[MEMORY_PROPS.EXPIRES_AT]).toEqual({
      date: { start: "2026-06-01" },
    })
  })

  it("empty string on rich_text columns writes an empty cell (clears via overwrite)", () => {
    const props = buildMemoryProps({
      title: "x",
      scopeKey: "",
      audience: "",
    }) as Record<string, unknown>
    expect(props[MEMORY_PROPS.SCOPE_KEY]).toEqual({
      rich_text: [{ text: { content: "" } }],
    })
    expect(props[MEMORY_PROPS.AUDIENCE]).toEqual({
      rich_text: [{ text: { content: "" } }],
    })
  })
})

describe("buildMemoryProps — event expiry marker", () => {
  it("writes and clears Expires On", () => {
    const setProps = buildMemoryProps({
      title: "x",
      expiresOn: "pr-closed:Iron-Ham/lore#899",
    }) as Record<string, unknown>
    expect(setProps[MEMORY_PROPS.EXPIRES_ON]).toEqual({
      rich_text: [{ text: { content: "pr-closed:Iron-Ham/lore#899" } }],
    })

    const clearProps = buildMemoryProps({ title: "x", expiresOn: null }) as Record<
      string,
      unknown
    >
    expect(clearProps[MEMORY_PROPS.EXPIRES_ON]).toEqual({ rich_text: [] })
  })
})

describe("buildFactProps — scope tristate semantics mirror buildMemoryProps", () => {
  it("populated values write the named option / date verbatim", () => {
    const props = buildFactProps({
      subject: "s",
      predicate: "uses",
      object: "o",
      scopeKind: "agent",
      scopeKey: "Claude Code",
      lifetime: "until-task-closed",
      expiresAt: "2026-06-30",
    }) as Record<string, unknown>
    expect(props[FACT_PROPS.SCOPE_KIND]).toEqual({ select: { name: "agent" } })
    expect(props[FACT_PROPS.SCOPE_KEY]).toEqual({
      rich_text: [{ text: { content: "Claude Code" } }],
    })
    expect(props[FACT_PROPS.LIFETIME]).toEqual({
      select: { name: "until-task-closed" },
    })
    expect(props[FACT_PROPS.EXPIRES_AT]).toEqual({
      date: { start: "2026-06-30" },
    })
  })

  it("null clears select / date columns", () => {
    const props = buildFactProps({
      subject: "s",
      predicate: "uses",
      object: "o",
      scopeKind: null,
      lifetime: null,
      expiresAt: null,
    }) as Record<string, unknown>
    expect(props[FACT_PROPS.SCOPE_KIND]).toEqual({ select: null })
    expect(props[FACT_PROPS.LIFETIME]).toEqual({ select: null })
    expect(props[FACT_PROPS.EXPIRES_AT]).toEqual({ date: null })
  })
})
