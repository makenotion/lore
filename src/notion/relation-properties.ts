import type {
  Client,
  GetPagePropertyResponse,
  PageObjectResponse,
} from "@notionhq/client"
import pLimit from "p-limit"
import { extractRelationIds } from "./extractors.js"

type PropertyValue = PageObjectResponse["properties"][string]
type RelationPropertyValue = Extract<PropertyValue, { type: "relation" }> & {
  has_more?: boolean
}

type PagePropertyClient = {
  pages: {
    properties: Pick<Client["pages"]["properties"], "retrieve">
  }
}

const RELATION_PROPERTY_PAGE_SIZE = 100
const RELATION_PROPERTY_HYDRATION_CONCURRENCY = 3
export const RELATION_PROPERTY_MAX_PAGES = 50

export function relationPropertyNeedsHydration(
  prop: PropertyValue | undefined
): prop is RelationPropertyValue {
  return prop?.type === "relation" && (prop as { has_more?: boolean }).has_more === true
}

export async function retrieveRelationPropertyIds(
  client: PagePropertyClient,
  pageId: string,
  prop: PropertyValue | undefined
): Promise<string[]> {
  const inlineIds = extractRelationIds(prop)
  if (!relationPropertyNeedsHydration(prop)) return inlineIds

  const ids: string[] = []
  let cursor: string | undefined
  const seenCursors = new Set<string>()

  for (let pageCount = 0; pageCount < RELATION_PROPERTY_MAX_PAGES; pageCount++) {
    const response = await client.pages.properties.retrieve({
      page_id: pageId,
      property_id: prop.id,
      page_size: RELATION_PROPERTY_PAGE_SIZE,
      start_cursor: cursor,
    })

    if (response.object !== "list") {
      throw new Error(
        `Expected relation property ${prop.id} on page ${pageId} to ` +
          `return a paginated list, received ${describePropertyResponse(response)}.`
      )
    }

    for (const item of response.results) {
      if (item.type === "relation") ids.push(item.relation.id)
    }

    if (!response.has_more) return ids
    if (response.next_cursor == null) {
      throw new Error(
        `Relation property ${prop.id} on page ${pageId} returned ` +
          "`has_more: true` without a next cursor."
      )
    }
    if (seenCursors.has(response.next_cursor)) {
      throw new Error(
        `Relation property ${prop.id} on page ${pageId} returned ` +
          `the same next cursor (${response.next_cursor}) twice.`
      )
    }
    seenCursors.add(response.next_cursor)
    cursor = response.next_cursor
  }

  throw new Error(
    `Relation property ${prop.id} on page ${pageId} exceeded ` +
      `${RELATION_PROPERTY_MAX_PAGES} pages while hydrating relation ids.`
  )
}

export async function hydrateRelationProperties(
  client: PagePropertyClient,
  page: PageObjectResponse,
  propertyNames: readonly string[]
): Promise<PageObjectResponse> {
  let hydrated: PageObjectResponse | null = null

  for (const propertyName of propertyNames) {
    const prop = page.properties[propertyName]
    if (!relationPropertyNeedsHydration(prop)) continue

    const ids = await retrieveRelationPropertyIds(client, page.id, prop)
    // Clone lazily so the common "nothing is truncated" path preserves
    // object identity and avoids allocating a replacement properties bag.
    hydrated ??= { ...page, properties: { ...page.properties } }
    hydrated.properties[propertyName] = {
      ...prop,
      relation: ids.map((id) => ({ id })),
      has_more: false,
    } as PropertyValue
  }

  return hydrated ?? page
}

export async function hydrateRelationPropertiesForPages(
  client: PagePropertyClient,
  pages: readonly PageObjectResponse[],
  propertyNames: readonly string[]
): Promise<PageObjectResponse[]> {
  const limit = pLimit(RELATION_PROPERTY_HYDRATION_CONCURRENCY)
  return Promise.all(
    pages.map((page) =>
      limit(() => hydrateRelationProperties(client, page, propertyNames))
    )
  )
}

function describePropertyResponse(response: GetPagePropertyResponse): string {
  if (response.object === "list") return "list"
  return `property_item:${response.type}`
}
