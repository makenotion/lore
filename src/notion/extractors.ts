/**
 * Notion property extractors and type guards.
 *
 * These are Notion-specific utilities for pulling typed values out of
 * PageObjectResponse properties. Used by all core services.
 */

import type { PageObjectResponse, QueryDataSourceResponse } from "@notionhq/client"

// ---------------------------------------------------------------------------
// Type guard
// ---------------------------------------------------------------------------

export function isFullPage(
  obj: QueryDataSourceResponse["results"][number]
): obj is PageObjectResponse {
  return obj.object === "page" && "properties" in obj
}

// ---------------------------------------------------------------------------
// Property extractors
// ---------------------------------------------------------------------------

type PropertyValue = PageObjectResponse["properties"][string]

export function extractTitle(prop: PropertyValue): string {
  if (prop.type === "title") {
    return prop.title.map((t: { plain_text: string }) => t.plain_text).join("")
  }
  return ""
}

export function extractRichText(prop: PropertyValue): string {
  if (prop.type === "rich_text") {
    return prop.rich_text.map((t: { plain_text: string }) => t.plain_text).join("")
  }
  return ""
}

export function extractSelect(prop: PropertyValue, fallback: string): string {
  if (prop.type === "select" && prop.select) {
    return prop.select.name
  }
  return fallback
}

export function extractMultiSelect(prop: PropertyValue): string[] {
  if (prop.type === "multi_select") {
    return prop.multi_select.map((s: { name: string }) => s.name)
  }
  return []
}

export function extractRelationIds(prop: PropertyValue): string[] {
  if (prop.type === "relation") {
    return prop.relation.map((r: { id: string }) => r.id)
  }
  return []
}

export function extractDate(prop: PropertyValue): string | null {
  if (prop.type === "date" && prop.date) {
    return prop.date.start
  }
  return null
}
