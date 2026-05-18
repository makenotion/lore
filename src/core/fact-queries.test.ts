import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { FACT_PROPS } from "../notion/schema.js"
import { computeSubjectKey } from "../notion/normalize.js"
import type {
  DatabaseRef,
  FactPredicate,
  MemoryLifetime,
  MemoryScopeContext,
  MemoryScopeKind,
} from "../types.js"
import { FactQueries } from "./fact-queries.js"

const DB: DatabaseRef = {
  databaseId: "facts-db",
  dataSourceId: "facts-ds",
}

function titleProp(text: string) {
  return {
    type: "title",
    title: text ? [{ plain_text: text, text: { content: text } }] : [],
  } as unknown
}

function richTextProp(text: string) {
  return {
    type: "rich_text",
    rich_text: text ? [{ plain_text: text, text: { content: text } }] : [],
  } as unknown
}

function selectProp(name: string | null) {
  return {
    type: "select",
    select: name === null ? null : { name },
  } as unknown
}

function relationProp(ids: string[], hasMore = false) {
  return {
    type: "relation",
    relation: ids.map((id) => ({ id })),
    has_more: hasMore,
  } as unknown
}

function dateProp(date: string | null) {
  return {
    type: "date",
    date: date === null ? null : { start: date },
  } as unknown
}

function numberProp(value: number | null) {
  return {
    type: "number",
    number: value,
  } as unknown
}

function factPage(overrides: {
  id: string
  subject?: string
  subjectKey?: string
  predicate?: FactPredicate
  object?: string
  projectIds?: string[]
  validUntil?: string | null
  subjectEntityIds?: string[]
  objectEntityIds?: string[]
  scopeKind?: MemoryScopeKind | null
  scopeKey?: string
  audience?: string
  lifetime?: MemoryLifetime | null
  expiresAt?: string | null
}): PageObjectResponse {
  const subject = overrides.subject ?? "AuthService"
  return {
    object: "page",
    id: overrides.id,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-01-02T00:00:00.000Z",
    archived: false,
    parent: { type: "data_source_id", data_source_id: DB.dataSourceId },
    url: `https://notion.so/${overrides.id}`,
    properties: {
      [FACT_PROPS.SUBJECT]: titleProp(subject),
      [FACT_PROPS.PREDICATE]: selectProp(overrides.predicate ?? "uses"),
      [FACT_PROPS.OBJECT]: richTextProp(overrides.object ?? "JWT"),
      [FACT_PROPS.PROJECT]: relationProp(overrides.projectIds ?? []),
      [FACT_PROPS.VALID_FROM]: dateProp("2026-01-01"),
      [FACT_PROPS.VALID_UNTIL]: dateProp(overrides.validUntil ?? null),
      [FACT_PROPS.OBSERVED_AT]: dateProp("2026-01-01"),
      [FACT_PROPS.INVALIDATED_AT]: dateProp(null),
      [FACT_PROPS.INVALIDATED_BY]: relationProp([]),
      [FACT_PROPS.REVIEW_BY]: dateProp(null),
      [FACT_PROPS.SOURCE]: relationProp([]),
      [FACT_PROPS.CONFIDENCE]: selectProp("certain"),
      [FACT_PROPS.CONFIDENCE_SCORE]: numberProp(null),
      [FACT_PROPS.LAST_REFERENCED_AT]: dateProp(null),
      [FACT_PROPS.DEDUP_KEY]: richTextProp(""),
      [FACT_PROPS.SUBJECT_KEY]: richTextProp(
        overrides.subjectKey ?? computeSubjectKey(subject)
      ),
      [FACT_PROPS.SUBJECT_ENTITY]: relationProp(overrides.subjectEntityIds ?? []),
      [FACT_PROPS.OBJECT_ENTITY]: relationProp(overrides.objectEntityIds ?? []),
      [FACT_PROPS.SCOPE_KIND]: selectProp(overrides.scopeKind ?? null),
      [FACT_PROPS.SCOPE_KEY]: richTextProp(overrides.scopeKey ?? ""),
      [FACT_PROPS.AUDIENCE]: richTextProp(overrides.audience ?? ""),
      [FACT_PROPS.LIFETIME]: selectProp(overrides.lifetime ?? null),
      [FACT_PROPS.EXPIRES_AT]: dateProp(overrides.expiresAt ?? null),
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function propertyValue(page: PageObjectResponse, property: string) {
  return page.properties[property] as
    | {
        type: string
        title?: Array<{ plain_text: string }>
        rich_text?: Array<{ plain_text: string }>
        select?: { name: string } | null
        relation?: Array<{ id: string }>
        date?: { start: string } | null
      }
    | undefined
}

function titleValue(page: PageObjectResponse, property: string): string {
  const prop = propertyValue(page, property)
  if (prop?.type !== "title") return ""
  return prop.title?.map((item) => item.plain_text).join("") ?? ""
}

function richTextValue(page: PageObjectResponse, property: string): string {
  const prop = propertyValue(page, property)
  if (prop?.type !== "rich_text") return ""
  return prop.rich_text?.map((item) => item.plain_text).join("") ?? ""
}

function relationIds(page: PageObjectResponse, property: string): string[] {
  const prop = propertyValue(page, property)
  if (prop?.type !== "relation") return []
  return prop.relation?.map((item) => item.id) ?? []
}

function selectValue(page: PageObjectResponse, property: string): string | null {
  const prop = propertyValue(page, property)
  if (prop?.type !== "select") return null
  return prop.select?.name ?? null
}

function dateValue(page: PageObjectResponse, property: string): string | null {
  const prop = propertyValue(page, property)
  if (prop?.type !== "date") return null
  return prop.date?.start ?? null
}

function matchesDateFilter(
  value: string | null,
  filter: Record<string, unknown>
): boolean {
  if (filter.is_empty === true) return value === null
  if (typeof filter.on_or_before === "string") {
    return value !== null && value <= filter.on_or_before
  }
  if (typeof filter.on_or_after === "string") {
    return value !== null && value >= filter.on_or_after
  }
  if (typeof filter.after === "string") return value !== null && value > filter.after
  return true
}

function matchesPropertyFilter(
  page: PageObjectResponse,
  filter: Record<string, unknown>
): boolean {
  const property = filter.property
  if (typeof property !== "string") return true

  const relation = filter.relation as Record<string, unknown> | undefined
  if (relation) {
    const ids = relationIds(page, property)
    if (typeof relation.contains === "string") return ids.includes(relation.contains)
    if (relation.is_empty === true) return ids.length === 0
  }

  const title = filter.title as Record<string, unknown> | undefined
  if (title && typeof title.contains === "string") {
    return titleValue(page, property).includes(title.contains)
  }

  const richText = filter.rich_text as Record<string, unknown> | undefined
  if (richText) {
    const value = richTextValue(page, property)
    if (typeof richText.contains === "string") return value.includes(richText.contains)
    if (richText.is_empty === true) return value.length === 0
  }

  const select = filter.select as Record<string, unknown> | undefined
  if (select) {
    const value = selectValue(page, property)
    if (typeof select.equals === "string") return value === select.equals
    if (select.is_empty === true) return value === null
  }

  const date = filter.date as Record<string, unknown> | undefined
  if (date) return matchesDateFilter(dateValue(page, property), date)

  return true
}

function matchesFilter(
  page: PageObjectResponse,
  filter: Record<string, unknown> | undefined
): boolean {
  if (!filter) return true
  const and = filter.and as Array<Record<string, unknown>> | undefined
  if (and) return and.every((clause) => matchesFilter(page, clause))
  const or = filter.or as Array<Record<string, unknown>> | undefined
  if (or) return or.some((clause) => matchesFilter(page, clause))
  return matchesPropertyFilter(page, filter)
}

function createFilteringClient(pages: PageObjectResponse[]) {
  const calls: Array<Record<string, unknown>> = []
  const querySpy = vi.fn(async (args: Record<string, unknown>) => {
    calls.push(args)
    const matches = pages.filter((page) =>
      matchesFilter(page, args.filter as Record<string, unknown> | undefined)
    )
    const start = typeof args.start_cursor === "string" ? Number(args.start_cursor) : 0
    const pageSize = typeof args.page_size === "number" ? args.page_size : 100
    const end = start + pageSize
    return {
      results: matches.slice(start, end),
      has_more: end < matches.length,
      next_cursor: end < matches.length ? String(end) : null,
    }
  })
  const client = {
    dataSources: { query: querySpy },
    pages: { properties: { retrieve: vi.fn() } },
  } as unknown as Client
  return { client, calls, querySpy }
}

function queriesFor(pages: PageObjectResponse[], scopeCtx?: MemoryScopeContext) {
  const { client, calls, querySpy } = createFilteringClient(pages)
  return {
    queries: new FactQueries({ client, db: DB, scopeCtx }),
    calls,
    querySpy,
  }
}

describe("FactQueries.queryByEntity", () => {
  it("matches relation rows when the entity id is not the first relation id", async () => {
    const { queries, calls } = queriesFor([
      factPage({
        id: "subject-secondary",
        subjectEntityIds: ["ent-stale", "ent-auth"],
      }),
      factPage({
        id: "object-secondary",
        objectEntityIds: ["ent-stale", "ent-auth"],
      }),
      factPage({
        id: "other-entity",
        subjectEntityIds: ["ent-other"],
      }),
    ])

    const facts = await queries.queryByEntity("AuthService", {
      entityId: "ent-auth",
      projectId: "project-a",
    })

    expect(facts.map((fact) => fact.id)).toEqual([
      "subject-secondary",
      "object-secondary",
    ])
    expect(facts[0].subjectEntityId).toBe("ent-stale")
    const relationClause = (calls[0].filter as { and: Array<Record<string, unknown>> })
      .and[0]
    expect(relationClause).toEqual({
      or: [
        { property: "SubjectEntity", relation: { contains: "ent-auth" } },
        { property: "ObjectEntity", relation: { contains: "ent-auth" } },
      ],
    })
  })

  it("uses the SubjectKey fallback for rows whose entity relations are empty", async () => {
    const { queries } = queriesFor([
      factPage({
        id: "legacy-subject-key",
        subject: "Display name that does not contain the query",
        subjectKey: `${computeSubjectKey("AuthService")} adapter`,
      }),
      factPage({
        id: "migrated-non-match",
        subject: "AuthService",
        subjectEntityIds: ["ent-other"],
      }),
    ])

    const facts = await queries.queryByEntity("AuthService", {
      entityId: "ent-auth",
    })

    expect(facts.map((fact) => fact.id)).toEqual(["legacy-subject-key"])
    expect(facts[0].subjectEntityId).toBeNull()
  })

  it("deduplicates mixed relation and fallback rows without losing fallback-only matches", async () => {
    const { queries } = queriesFor([
      factPage({
        id: "shared",
        subject: "AuthService",
        subjectEntityIds: ["ent-auth"],
      }),
      factPage({
        id: "shared",
        subject: "AuthService",
        subjectEntityIds: [],
        objectEntityIds: [],
        validUntil: "2026-12-31",
      }),
      factPage({
        id: "fallback-only",
        subject: "AuthService migration note",
        subjectEntityIds: [],
        objectEntityIds: [],
      }),
    ])

    const facts = await queries.queryByEntity("AuthService", {
      entityId: "ent-auth",
      includeInvalidated: true,
    })

    expect(facts.map((fact) => fact.id)).toEqual(["shared", "fallback-only"])
    expect(facts[0].subjectEntityId).toBe("ent-auth")
    expect(facts[0].validUntil).toBeNull()
  })

  it("paginates relation matches and keeps rows whose secondary relation id lands after the first page", async () => {
    const pages = Array.from({ length: 101 }, (_, index) =>
      factPage({
        id: `relation-${index}`,
        subjectEntityIds:
          index === 100 ? ["ent-stale", "ent-auth"] : ["ent-auth", `ent-${index}`],
      })
    )
    const { queries, querySpy } = queriesFor(pages)

    const facts = await queries.queryByEntity("AuthService", {
      entityId: "ent-auth",
    })

    expect(facts).toHaveLength(101)
    expect(facts.at(-1)?.id).toBe("relation-100")
    expect(facts.at(-1)?.subjectEntityId).toBe("ent-stale")
    expect(querySpy).toHaveBeenCalledWith(
      expect.objectContaining({ page_size: 100, start_cursor: "100" })
    )
  })

  it("applies project and default scope filters to relation and fallback matches", async () => {
    const { queries } = queriesFor(
      [
        factPage({
          id: "relation-in-scope",
          projectIds: ["project-a"],
          subjectEntityIds: ["ent-auth"],
          scopeKind: "session",
          scopeKey: "sess-a",
        }),
        factPage({
          id: "relation-wrong-session",
          projectIds: ["project-a"],
          subjectEntityIds: ["ent-auth"],
          scopeKind: "session",
          scopeKey: "sess-b",
        }),
        factPage({
          id: "relation-wrong-project",
          projectIds: ["project-b"],
          subjectEntityIds: ["ent-auth"],
          scopeKind: "session",
          scopeKey: "sess-a",
        }),
        factPage({
          id: "fallback-in-scope",
          projectIds: ["project-a"],
          subject: "AuthService fallback",
          scopeKind: "session",
          scopeKey: "sess-a",
        }),
        factPage({
          id: "fallback-wrong-session",
          projectIds: ["project-a"],
          subject: "AuthService fallback",
          scopeKind: "session",
          scopeKey: "sess-b",
        }),
        factPage({
          id: "fallback-wrong-project",
          projectIds: ["project-b"],
          subject: "AuthService fallback",
          scopeKind: "session",
          scopeKey: "sess-a",
        }),
      ],
      { session: "sess-a" }
    )

    const facts = await queries.queryByEntity("AuthService", {
      entityId: "ent-auth",
      projectId: "project-a",
    })

    expect(facts.map((fact) => fact.id)).toEqual([
      "relation-in-scope",
      "fallback-in-scope",
    ])
  })
})
