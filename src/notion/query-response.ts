import type { QueryDataSourceResponse } from "@notionhq/client"
import { isMissingPropertyError } from "./errors.js"

type QueryResults = QueryDataSourceResponse["results"]

export function requireQueryResults(response: unknown, source: string): QueryResults {
  const results = (response as { results?: unknown } | null)?.results
  if (Array.isArray(results)) return results as QueryResults

  if (isMissingPropertyError(response)) {
    throw normalizeErrorPayload(response)
  }

  throw new Error(
    `Invalid Notion data source query response from ${source}: ` +
      `expected results array${formatPayloadContext(response)}`
  )
}

function normalizeErrorPayload(payload: unknown): Error {
  const record = payload && typeof payload === "object" ? payload : {}
  const message =
    typeof (record as { message?: unknown }).message === "string"
      ? (record as { message: string }).message
      : "Notion data source query failed."
  const err = new Error(message)
  const errorRecord = err as unknown as Record<string, unknown>
  for (const key of ["code", "status", "rawBodyText", "request_id"] as const) {
    const value = (record as Record<string, unknown>)[key]
    if (value !== undefined) {
      errorRecord[key] = value
    }
  }
  return err
}

function formatPayloadContext(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "."
  const record = payload as { code?: unknown; message?: unknown }
  const parts: string[] = []
  if (typeof record.code === "string") parts.push(`code=${record.code}`)
  if (typeof record.message === "string") {
    parts.push(`message=${JSON.stringify(record.message)}`)
  }
  return parts.length > 0 ? ` (${parts.join(", ")}).` : "."
}
