import { Buffer } from "node:buffer"
import type { PageObjectResponse, QueryDataSourceResponse } from "@notionhq/client"
import { isLiveFullPage } from "./extractors.js"

const LIVE_PAGE_CURSOR_PREFIX = "lore-live-page:"
const LIVE_PAGE_QUERY_SIZE = 100

export const LIVE_PAGE_REFILL_MAX_PAGES = 5
export const LIVE_PAGE_REFILL_MAX_ROWS = LIVE_PAGE_REFILL_MAX_PAGES * LIVE_PAGE_QUERY_SIZE

type QueryPage = (args: {
  page_size: number
  start_cursor?: string
}) => Promise<Pick<QueryDataSourceResponse, "results" | "has_more" | "next_cursor">>

interface LivePageCursorPayload {
  v: 1
  startCursor: string | null
  skipIds: string[]
}

export interface LivePageWindow {
  pages: PageObjectResponse[]
  nextCursor?: string
  capped: boolean
  pageCount: number
}

export async function collectLivePages(input: {
  limit: number
  startCursor?: string
  source: string
  query: QueryPage
  maxPages?: number
  /**
   * Optional client-side post-filter applied to each
   * live page during pagination. Returning `false` drops the page
   * from the result without consuming a slot toward `limit`, so the
   * walker keeps paginating to backfill. Matches how the existing
   * `isLiveFullPage` filter handles archived rows.
   *
   * The Notion server-side filter for narrow scope is restricted to
   * 2 levels of nesting (Notion's compound-filter limit), so the
   * server narrows to "scope kind matches a broadcast OR one of the
   * reader's narrow kinds" but cannot bind kind+key together.
   * `extraFilter` enforces the kind+key binding client-side: a row
   * with `Scope Kind = "session"` whose `Scope Key` does not match
   * the reader's `LORE_SESSION_ID` drops here, the walker
   * over-fetches by one slot, and the result still hits the
   * caller's requested limit.
   */
  extraFilter?: (page: PageObjectResponse) => boolean
}): Promise<LivePageWindow> {
  if (input.limit <= 0) {
    return {
      pages: [],
      nextCursor: input.startCursor,
      capped: false,
      pageCount: 0,
    }
  }

  const maxPages = input.maxPages ?? LIVE_PAGE_REFILL_MAX_PAGES
  const pages: PageObjectResponse[] = []
  const decoded = decodeLivePageCursor(input.startCursor)
  let cursor = decoded.startCursor
  let skipIds = decoded.skipIds
  let nextCursor: string | undefined
  let pageCount = 0

  while (pages.length < input.limit && pageCount < maxPages) {
    const response = await input.query({
      page_size: LIVE_PAGE_QUERY_SIZE,
      start_cursor: cursor,
    })
    pageCount++

    const livePages = response.results.filter(isLiveFullPage)
    let visiblePages =
      skipIds.size > 0 ? livePages.filter((page) => !skipIds.has(page.id)) : livePages
    if (input.extraFilter) {
      visiblePages = visiblePages.filter(input.extraFilter)
    }
    const remaining = input.limit - pages.length
    const selected = visiblePages.slice(0, remaining)
    pages.push(...selected)

    if (visiblePages.length > selected.length) {
      const livePageIds = new Set(livePages.map((page) => page.id))
      const carriedSkipIds = new Set([...skipIds].filter((id) => livePageIds.has(id)))
      for (const page of selected) carriedSkipIds.add(page.id)
      // `skipIds` is bounded by one Notion query page. A cursor may re-read
      // the same 100-row response several times with small caller limits, but
      // it never needs to remember ids from more than that single response.
      return {
        pages,
        nextCursor: encodeLivePageCursor({
          v: 1,
          startCursor: cursor ?? null,
          skipIds: [...carriedSkipIds],
        }),
        capped: false,
        pageCount,
      }
    }

    skipIds = new Set()
    nextCursor =
      response.has_more && response.next_cursor ? response.next_cursor : undefined
    cursor = nextCursor
    if (!cursor) break
  }

  const capped = pageCount >= maxPages && Boolean(cursor)
  if (capped) {
    debugLogLivePageCapFired({
      source: input.source,
      pages: pageCount,
      accumulated: pages.length,
      limit: input.limit,
    })
  }

  return { pages, nextCursor, capped, pageCount }
}

export function warnLivePageCapFired(info: {
  source: string
  pages: number
  accumulated: number
  limit: number
}): void {
  process.stderr.write(formatLivePageCapLine(info))
}

function encodeLivePageCursor(payload: LivePageCursorPayload): string {
  return (
    LIVE_PAGE_CURSOR_PREFIX +
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")
  )
}

function decodeLivePageCursor(cursor: string | undefined): {
  startCursor?: string
  skipIds: Set<string>
} {
  if (!cursor?.startsWith(LIVE_PAGE_CURSOR_PREFIX)) {
    return { startCursor: cursor, skipIds: new Set() }
  }

  let parsed: Partial<LivePageCursorPayload>
  try {
    const encoded = cursor.slice(LIVE_PAGE_CURSOR_PREFIX.length)
    const raw = Buffer.from(encoded, "base64url").toString("utf8")
    parsed = JSON.parse(raw) as Partial<LivePageCursorPayload>
  } catch {
    throw new Error("Invalid Lore live-page cursor.")
  }
  if (
    parsed.v !== 1 ||
    (parsed.startCursor !== null &&
      parsed.startCursor !== undefined &&
      typeof parsed.startCursor !== "string") ||
    !Array.isArray(parsed.skipIds) ||
    parsed.skipIds.length > LIVE_PAGE_QUERY_SIZE ||
    !parsed.skipIds.every((id): id is string => typeof id === "string")
  ) {
    throw new Error("Invalid Lore live-page cursor.")
  }

  return {
    startCursor: parsed.startCursor ?? undefined,
    skipIds: new Set(parsed.skipIds),
  }
}

function debugLogLivePageCapFired(info: {
  source: string
  pages: number
  accumulated: number
  limit: number
}): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(formatLivePageCapLine(info))
}

function formatLivePageCapLine(info: {
  source: string
  pages: number
  accumulated: number
  limit: number
}): string {
  return (
    `[lore] live-page-refill-cap-fired: source=${info.source} ` +
    `pages=${info.pages} accumulated=${info.accumulated} limit=${info.limit}\n`
  )
}
