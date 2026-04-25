/**
 * End-to-end integration tests for the encoding-decode migrations. Each
 * test uses a minimal stateful Notion fixture (see `FixtureVault`) where
 * `pages.update` / `pages.updateMarkdown` mutations reflect back into
 * subsequent `dataSources.query` results, so we can prove the full
 * round-trip these migrations promise:
 *
 *  1. Start with known-encoded rows.
 *  2. Run `fixFactEncoding` / `fixMemoryEncoding`.
 *  3. Re-scan — the encoded-rows list is empty (idempotent).
 *  4. Verify the stored `DedupKey` matches `computeFactDedupKey(decoded)`
 *     — i.e. a subsequent `lore-learn` with the decoded triple would
 *     probe-hit the migrated row instead of creating a duplicate.
 *  5. For memories, verify both Title property and body markdown are
 *     persisted in decoded form.
 *
 * The fixture is deliberately minimal: it doesn't model every Notion
 * property shape, only the slots the migrations touch. That keeps the
 * test honest about what the migration depends on — a future migration
 * that starts reading `Review By` would surface the omission here.
 */

import { describe, expect, it } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import type { DatabaseRef, FactPredicate } from "../types.js"
import { computeFactDedupKey } from "../notion/normalize.js"
import {
  fixFactEncoding,
  findEncodedFacts,
} from "./fact-encoding.js"
import {
  findEncodedMemories,
  fixMemoryEncoding,
} from "./memory-encoding.js"

/**
 * Stateful in-memory fixture for Notion `pages` + `dataSources` surfaces.
 *
 * Mutations land back in the store so that a second query after a write
 * sees the updated row — which is exactly what the idempotency +
 * round-trip assertions need. The full Notion schema is not modeled; the
 * fixture carries only the property slots the encoding migrations read.
 */
class FixtureVault {
  private pages: Map<string, PageObjectResponse> = new Map()
  /** Body markdown per page id, simulating `pages.retrieveMarkdown`. */
  private markdown: Map<string, string> = new Map()

  addFact(row: {
    id: string
    subject: string
    predicate?: FactPredicate
    object: string
    dedupKey?: string
    validUntil?: string | null
    createdTime?: string
  }): void {
    const predicate = row.predicate ?? "uses"
    this.pages.set(row.id, {
      object: "page",
      id: row.id,
      created_time: row.createdTime ?? "2026-01-01T00:00:00.000Z",
      last_edited_time: row.createdTime ?? "2026-01-01T00:00:00.000Z",
      archived: false,
      url: `https://notion.so/${row.id}`,
      parent: { type: "database_id", database_id: "facts-db" },
      properties: {
        Subject: {
          type: "title",
          title: [{ plain_text: row.subject }],
        } as unknown,
        Predicate: {
          type: "select",
          select: { name: predicate },
        } as unknown,
        Object: {
          type: "rich_text",
          rich_text: [{ plain_text: row.object }],
        } as unknown,
        DedupKey: {
          type: "rich_text",
          rich_text: row.dedupKey
            ? [{ plain_text: row.dedupKey }]
            : [],
        } as unknown,
        "Valid Until": {
          type: "date",
          date: row.validUntil ? { start: row.validUntil } : null,
        } as unknown,
      } as PageObjectResponse["properties"],
    } as PageObjectResponse)
  }

  addMemory(row: {
    id: string
    title: string
    body: string
    archived?: boolean
    createdTime?: string
  }): void {
    this.pages.set(row.id, {
      object: "page",
      id: row.id,
      created_time: row.createdTime ?? "2026-01-01T00:00:00.000Z",
      last_edited_time: row.createdTime ?? "2026-01-01T00:00:00.000Z",
      archived: row.archived ?? false,
      url: `https://notion.so/${row.id}`,
      parent: { type: "database_id", database_id: "memories-db" },
      properties: {
        Title: {
          type: "title",
          title: [{ plain_text: row.title }],
        } as unknown,
      } as PageObjectResponse["properties"],
    } as PageObjectResponse)
    this.markdown.set(row.id, row.body)
  }

  snapshotFact(id: string): {
    subject: string
    predicate: FactPredicate
    object: string
    dedupKey: string
  } {
    const page = this.pages.get(id)
    if (!page) throw new Error(`no page ${id}`)
    const props = page.properties as Record<string, unknown>
    return {
      subject: readTitle(props["Subject"]),
      predicate: readSelect(props["Predicate"]) as FactPredicate,
      object: readRichText(props["Object"]),
      dedupKey: readRichText(props["DedupKey"]),
    }
  }

  snapshotMemory(id: string): { title: string; body: string; archived: boolean } {
    const page = this.pages.get(id)
    if (!page) throw new Error(`no page ${id}`)
    return {
      title: readTitle((page.properties as Record<string, unknown>)["Title"]),
      body: this.markdown.get(id) ?? "",
      archived: page.archived ?? false,
    }
  }

  /** Count of writes observed, so tests can assert "no write issued" on
   *  idempotent second runs. */
  writeCount = 0

  // Minimal subset of the SDK surface. Any call site the migration
  // reaches that isn't modeled here throws — which is how a future
  // migration that starts using, say, `pages.retrieve` gets caught by
  // these tests. Arrow methods capture `this` lexically so the fixture
  // state stays accessible without an aliasing hack.
  client(): Client {
    return {
      dataSources: {
        query: async (args: { data_source_id: string; start_cursor?: string }) => {
          if (args.start_cursor !== undefined) {
            // Fixture is single-page; pagination past the first page is
            // a test fixture misuse (the migrations paginate internally,
            // so this branch only fires after next_cursor is returned,
            // which we never do).
            return { results: [], has_more: false, next_cursor: null }
          }
          return {
            results: [...this.pages.values()],
            has_more: false,
            next_cursor: null,
          }
        },
      },
      pages: {
        update: async (args: {
          page_id: string
          properties?: Record<string, unknown>
        }) => {
          this.writeCount++
          const page = this.pages.get(args.page_id)
          if (!page) throw new Error(`update target ${args.page_id} not found`)
          if (!args.properties) return page
          // Merge property updates into the stored page. We only handle
          // the shapes `fixFactEncoding` and `fixMemoryEncoding` actually
          // emit: title-array, rich_text-array, date.
          const merged = { ...(page.properties as Record<string, unknown>) }
          for (const [propName, propValue] of Object.entries(args.properties)) {
            const v = propValue as Record<string, unknown>
            if (Array.isArray(v.title)) {
              merged[propName] = {
                type: "title",
                title: (v.title as Array<{ text: { content: string } }>).map(
                  (t) => ({ plain_text: t.text.content })
                ),
              } as unknown
            } else if (Array.isArray(v.rich_text)) {
              merged[propName] = {
                type: "rich_text",
                rich_text: (v.rich_text as Array<{ text: { content: string } }>).map(
                  (t) => ({ plain_text: t.text.content })
                ),
              } as unknown
            } else if ("date" in v) {
              merged[propName] = { type: "date", date: v.date } as unknown
            } else {
              throw new Error(
                `fixture does not model property shape for ${propName}: ${JSON.stringify(propValue)}`
              )
            }
          }
          const updated = {
            ...page,
            properties: merged as PageObjectResponse["properties"],
          }
          this.pages.set(args.page_id, updated)
          return updated
        },
        retrieveMarkdown: async (args: { page_id: string }) => {
          return { markdown: this.markdown.get(args.page_id) ?? "" }
        },
        updateMarkdown: async (args: {
          page_id: string
          type: string
          replace_content?: { new_str: string }
          replace_content_range?: { content: string; content_range: string }
          insert_content?: { content: string; after?: string }
        }) => {
          this.writeCount++
          if (args.type === "replace_content" && args.replace_content) {
            this.markdown.set(args.page_id, args.replace_content.new_str)
            return {}
          }
          if (args.type === "replace_content_range" && args.replace_content_range) {
            // Faithfully model Notion's contract: `content_range` is a literal
            // selector inside the existing page body, expressed as
            // "start...end". The whole-page replace primitive lives behind
            // `type: "replace_content"` — passing magic strings like
            // "full_page" hits the Notion API as a substring search and
            // returns `validation_error: String not found: <pattern>...`.
            // Enforcing that here is what would have caught issue #90.
            const existing = this.markdown.get(args.page_id) ?? ""
            const range = args.replace_content_range.content_range
            if (!existing.includes(range)) {
              throw new Error(
                `String not found: <pattern>${range}...${range}</pattern> in current version of the page`
              )
            }
            this.markdown.set(args.page_id, args.replace_content_range.content)
            return {}
          }
          if (args.type === "insert_content" && args.insert_content) {
            const existing = this.markdown.get(args.page_id) ?? ""
            this.markdown.set(
              args.page_id,
              existing + args.insert_content.content
            )
            return {}
          }
          throw new Error(
            `fixture does not model updateMarkdown type=${args.type}`
          )
        },
      },
    } as unknown as Client
  }
}

function readTitle(p: unknown): string {
  const prop = p as { title?: Array<{ plain_text?: string }> }
  return prop?.title?.[0]?.plain_text ?? ""
}
function readRichText(p: unknown): string {
  const prop = p as { rich_text?: Array<{ plain_text?: string }> }
  return prop?.rich_text?.[0]?.plain_text ?? ""
}
function readSelect(p: unknown): string {
  const prop = p as { select?: { name?: string } }
  return prop?.select?.name ?? ""
}

const FACTS_DB: DatabaseRef = {
  databaseId: "facts-db",
  dataSourceId: "facts-ds",
}
const MEMORIES_DB: DatabaseRef = {
  databaseId: "memories-db",
  dataSourceId: "memories-ds",
}

describe("fact encoding migration — end-to-end", () => {
  it("rewrites encoded rows, makes DedupKey match decoded triple, and a re-run is a true no-op", async () => {
    // Known-encoded starting state. Pre-migration DedupKey matches the
    // RAW (still-encoded) triple — which is exactly the pathology P2-10
    // fixes: a `lore-learn` call with the naturally-decoded triple would
    // hash to a different key and miss the probe, creating a duplicate.
    const vault = new FixtureVault()
    const encodedSubject = "Build &amp; Tooling"
    const encodedObject = "Rollup &amp;amp; Vite"
    const rawDedupKey = computeFactDedupKey({
      subject: encodedSubject,
      predicate: "uses",
      object: encodedObject,
    })
    vault.addFact({
      id: "f-encoded",
      subject: encodedSubject,
      predicate: "uses",
      object: encodedObject,
      dedupKey: rawDedupKey,
    })
    // Unrelated clean row — should pass through untouched.
    const cleanDedupKey = computeFactDedupKey({
      subject: "Auth",
      predicate: "uses",
      object: "JWT",
    })
    vault.addFact({
      id: "f-clean",
      subject: "Auth",
      predicate: "uses",
      object: "JWT",
      dedupKey: cleanDedupKey,
    })

    const client = vault.client()

    // Step 1: migrate.
    const report = await fixFactEncoding(client, FACTS_DB, { dryRun: false })
    expect(report.fixes.map((f) => f.id)).toEqual(["f-encoded"])

    // Step 2: encoded row now stores decoded text.
    const migrated = vault.snapshotFact("f-encoded")
    expect(migrated.subject).toBe("Build & Tooling")
    expect(migrated.object).toBe("Rollup & Vite")

    // Step 3: DedupKey matches the hash of the DECODED triple — what
    // closes the bug. A future `createWithDedup` with the decoded input
    // will compute this exact hash and the probe filter
    // `DedupKey equals <decoded-hash>` will hit this row.
    const expectedDecodedKey = computeFactDedupKey({
      subject: "Build & Tooling",
      predicate: "uses",
      object: "Rollup & Vite",
    })
    expect(migrated.dedupKey).toBe(expectedDecodedKey)
    expect(migrated.dedupKey).not.toBe(rawDedupKey)

    // Clean row untouched.
    expect(vault.snapshotFact("f-clean")).toEqual({
      subject: "Auth",
      predicate: "uses",
      object: "JWT",
      dedupKey: cleanDedupKey,
    })

    // Step 4: idempotency — a second scan finds nothing to do and the
    // fixture records zero additional writes on a second apply.
    const writesAfterFirstRun = vault.writeCount
    const encodedAfterFirstRun = await findEncodedFacts(client, FACTS_DB)
    expect(encodedAfterFirstRun).toEqual([])

    const secondReport = await fixFactEncoding(client, FACTS_DB, { dryRun: false })
    expect(secondReport.fixes).toEqual([])
    expect(vault.writeCount).toBe(writesAfterFirstRun)
  })

  it("refuses to rewrite any row in a post-decode collision group, even end-to-end", async () => {
    // Two rows — one already decoded, one encoded — whose decoded forms
    // would share a DedupKey. Running the migration MUST NOT introduce a
    // second row with the same live key; the whole group is gated.
    const vault = new FixtureVault()
    const decodedKey = computeFactDedupKey({
      subject: "Build & Tooling",
      predicate: "uses",
      object: "Rollup",
    })
    vault.addFact({
      id: "f-clean",
      subject: "Build & Tooling",
      predicate: "uses",
      object: "Rollup",
      dedupKey: decodedKey,
    })
    // Encoded row keyed by its encoded form.
    vault.addFact({
      id: "f-encoded",
      subject: "Build &amp; Tooling",
      predicate: "uses",
      object: "Rollup",
      dedupKey: computeFactDedupKey({
        subject: "Build &amp; Tooling",
        predicate: "uses",
        object: "Rollup",
      }),
    })

    const client = vault.client()
    const writesBefore = vault.writeCount
    const report = await fixFactEncoding(client, FACTS_DB, { dryRun: false })

    expect(report.collisions).toHaveLength(1)
    expect(report.collisions[0].factIds.sort()).toEqual(["f-clean", "f-encoded"])
    expect(report.fixes).toEqual([])
    expect(vault.writeCount).toBe(writesBefore)
    // Encoded row still stores the encoded text — migration refused.
    expect(vault.snapshotFact("f-encoded").subject).toBe("Build &amp; Tooling")
  })
})

describe("memory encoding migration — end-to-end", () => {
  it("rewrites Title + body and a re-run is a true no-op", async () => {
    const vault = new FixtureVault()
    vault.addMemory({
      id: "m-encoded",
      title: "Build &amp; Tooling",
      body: "Rollup &amp;amp; Vite details",
    })
    vault.addMemory({
      id: "m-clean",
      title: "Clean Title",
      body: "Clean body",
    })

    const client = vault.client()

    const report = await fixMemoryEncoding(client, MEMORIES_DB, { dryRun: false })
    expect(report.fixes.map((f) => f.id)).toEqual(["m-encoded"])
    expect(report.fixes[0].titleFixed).toBe(true)
    expect(report.fixes[0].contentFixed).toBe(true)

    // Decoded state is persisted.
    expect(vault.snapshotMemory("m-encoded")).toEqual({
      title: "Build & Tooling",
      body: "Rollup & Vite details",
      archived: false,
    })
    // Unrelated clean row untouched.
    expect(vault.snapshotMemory("m-clean")).toEqual({
      title: "Clean Title",
      body: "Clean body",
      archived: false,
    })

    // Idempotency — a second scan finds nothing and the fixture records
    // zero additional writes on the second apply.
    const writesAfterFirstRun = vault.writeCount
    const rescanned = await findEncodedMemories(client, MEMORIES_DB)
    expect(rescanned).toEqual([])

    const secondReport = await fixMemoryEncoding(client, MEMORIES_DB, {
      dryRun: false,
    })
    expect(secondReport.fixes).toEqual([])
    expect(vault.writeCount).toBe(writesAfterFirstRun)
  })

  it("fixes Title independently when only the body is dirty", async () => {
    // Validates that body-only dirty rows still take the fast path —
    // the migration writes only the markdown, not the Title property.
    const vault = new FixtureVault()
    vault.addMemory({
      id: "m-body-only",
      title: "Clean Title",
      body: "Body with &amp;amp; escape",
    })

    const client = vault.client()
    const writesBefore = vault.writeCount
    const report = await fixMemoryEncoding(client, MEMORIES_DB, { dryRun: false })

    expect(report.fixes).toHaveLength(1)
    expect(report.fixes[0].titleFixed).toBe(false)
    expect(report.fixes[0].contentFixed).toBe(true)
    expect(vault.writeCount - writesBefore).toBe(1) // exactly one updateMarkdown

    expect(vault.snapshotMemory("m-body-only")).toEqual({
      title: "Clean Title",
      body: "Body with & escape",
      archived: false,
    })
  })

  it("skips archived memories entirely — no properties read, no writes attempted", async () => {
    const vault = new FixtureVault()
    vault.addMemory({
      id: "m-archived",
      title: "Build &amp; Tooling",
      body: "Rollup &amp; Vite",
      archived: true,
    })

    const client = vault.client()
    const writesBefore = vault.writeCount
    const report = await fixMemoryEncoding(client, MEMORIES_DB, { dryRun: false })

    expect(report.fixes).toEqual([])
    expect(vault.writeCount).toBe(writesBefore)
    // Row still carries encoded text — archived memories are out of scope
    // for this migration. An unarchive-then-re-run would pick them up.
    expect(vault.snapshotMemory("m-archived").title).toBe("Build &amp; Tooling")
  })
})
