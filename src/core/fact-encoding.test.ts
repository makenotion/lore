import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import {
  findEncodedFacts,
  findPostDecodeFactCollisions,
  fixFactEncoding,
} from "./fact-encoding.js"
import { computeFactDedupKey } from "../notion/normalize.js"
import type { DatabaseRef } from "../types.js"

function factPage(overrides: {
  id: string
  subject: string
  predicate?: string
  object: string
  dedupKey?: string
  validUntil?: string | null
  createdTime?: string
}): PageObjectResponse {
  return {
    object: "page",
    id: overrides.id,
    created_time: overrides.createdTime ?? "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${overrides.id}`,
    parent: { type: "database_id", database_id: "facts-db" },
    properties: {
      Subject: {
        type: "title",
        title: [{ plain_text: overrides.subject }],
      } as unknown,
      Predicate: {
        type: "select",
        select: { name: overrides.predicate ?? "uses" },
      } as unknown,
      Object: {
        type: "rich_text",
        rich_text: [{ plain_text: overrides.object }],
      } as unknown,
      DedupKey: {
        type: "rich_text",
        rich_text: overrides.dedupKey
          ? [{ plain_text: overrides.dedupKey }]
          : [],
      } as unknown,
      "Valid Until": {
        type: "date",
        date: overrides.validUntil ? { start: overrides.validUntil } : null,
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function createMockClient(opts: {
  queryResponses?: Array<{
    results: PageObjectResponse[]
    has_more?: boolean
    next_cursor?: string | null
  }>
} = {}) {
  const queryMock = vi.fn()
  for (const r of opts.queryResponses ?? []) {
    queryMock.mockResolvedValueOnce({
      results: r.results,
      has_more: r.has_more ?? false,
      next_cursor: r.next_cursor ?? null,
    })
  }
  queryMock.mockResolvedValue({
    results: [],
    has_more: false,
    next_cursor: null,
  })
  return {
    pages: { update: vi.fn().mockResolvedValue({}) },
    dataSources: { query: queryMock },
  } as unknown as Client & {
    pages: { update: ReturnType<typeof vi.fn> }
    dataSources: { query: ReturnType<typeof vi.fn> }
  }
}

const DB: DatabaseRef = { databaseId: "facts-db", dataSourceId: "facts-ds" }

describe("findEncodedFacts", () => {
  it("is empty when all Subject/Object are already clean", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({ id: "f1", subject: "Auth", object: "JWT" }),
            factPage({ id: "f2", subject: "Build & Tooling", object: "Rollup" }),
          ],
        },
      ],
    })

    const encoded = await findEncodedFacts(client, DB)
    expect(encoded).toEqual([])
  })

  it("flags rows with &amp; in Subject or Object with the decoded form", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({
              id: "f1",
              subject: "Build &amp; Tooling",
              object: "Rollup",
            }),
            factPage({
              id: "f2",
              subject: "Deploy",
              object: "Canary &amp;amp; Rollback",
            }),
            factPage({ id: "f3", subject: "clean", object: "clean" }),
          ],
        },
      ],
    })

    const encoded = await findEncodedFacts(client, DB)
    expect(encoded).toHaveLength(2)
    const f1 = encoded.find((e) => e.id === "f1")!
    expect(f1.rawSubject).toBe("Build &amp; Tooling")
    expect(f1.decodedSubject).toBe("Build & Tooling")
    expect(f1.rawObject).toBe("Rollup")
    expect(f1.decodedObject).toBe("Rollup")
    const f2 = encoded.find((e) => e.id === "f2")!
    expect(f2.decodedObject).toBe("Canary & Rollback")
  })

  it("recomputes the decoded dedup key from the decoded triple", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({
              id: "f1",
              subject: "Build &amp; Tooling",
              predicate: "uses",
              object: "Rollup",
            }),
          ],
        },
      ],
    })

    const encoded = await findEncodedFacts(client, DB)
    expect(encoded[0].decodedDedupKey).toBe(
      computeFactDedupKey({
        subject: "Build & Tooling",
        predicate: "uses",
        object: "Rollup",
      })
    )
  })

  it("paginates through multi-page results", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({ id: "f1", subject: "A &amp; B", object: "x" }),
          ],
          has_more: true,
          next_cursor: "cursor-1",
        },
        {
          results: [
            factPage({ id: "f2", subject: "C &amp;amp; D", object: "y" }),
          ],
        },
      ],
    })

    const encoded = await findEncodedFacts(client, DB)
    expect(encoded.map((e) => e.id).sort()).toEqual(["f1", "f2"])
  })

  it("sorts by decoded subject, then decoded object, for stable output", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({ id: "f3", subject: "Observability &amp; PII", object: "m" }),
            factPage({ id: "f1", subject: "Async &amp; Concurrency", object: "z" }),
            factPage({ id: "f2", subject: "Async &amp; Concurrency", object: "a" }),
          ],
        },
      ],
    })

    const encoded = await findEncodedFacts(client, DB)
    expect(encoded.map((e) => e.id)).toEqual(["f2", "f1", "f3"])
  })
})

describe("findPostDecodeFactCollisions", () => {
  it("is empty when decoded triples are all unique", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({ id: "f1", subject: "A", object: "B" }),
            factPage({ id: "f2", subject: "A &amp; B", object: "C" }),
          ],
        },
      ],
    })

    expect(await findPostDecodeFactCollisions(client, DB)).toEqual([])
  })

  it("detects a cross-encoding pair that would collide post-decode", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({
              id: "f-clean",
              subject: "Build & Tooling",
              predicate: "uses",
              object: "Rollup",
            }),
            factPage({
              id: "f-encoded",
              subject: "Build &amp; Tooling",
              predicate: "uses",
              object: "Rollup",
            }),
          ],
        },
      ],
    })

    const collisions = await findPostDecodeFactCollisions(client, DB)
    expect(collisions).toHaveLength(1)
    expect(collisions[0].triple.subject).toBe("Build & Tooling")
    expect(collisions[0].factIds).toEqual(["f-clean", "f-encoded"])
  })

  it("ignores invalidated rows when computing collisions", async () => {
    // An invalidated row that would post-decode-collide with a live row is
    // not a real collision — the live dedup probe already filters by
    // `Valid Until IS NULL`, so the migration can safely rewrite the live
    // row.
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({
              id: "f-live",
              subject: "Build &amp; Tooling",
              object: "Rollup",
            }),
            factPage({
              id: "f-dead",
              subject: "Build & Tooling",
              object: "Rollup",
              validUntil: "2026-01-01",
            }),
          ],
        },
      ],
    })

    expect(await findPostDecodeFactCollisions(client, DB)).toEqual([])
  })

  it("detects double-encoding collapsed to an existing clean row", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({
              id: "f1",
              subject: "Build & Tooling",
              object: "Rollup",
            }),
            factPage({
              id: "f2",
              subject: "Build &amp;amp; Tooling",
              object: "Rollup",
            }),
          ],
        },
      ],
    })

    const collisions = await findPostDecodeFactCollisions(client, DB)
    expect(collisions[0].factIds).toEqual(["f1", "f2"])
  })

  it("sorts collision groups alphabetically by decoded subject", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({ id: "z1", subject: "Zebra", object: "x" }),
            factPage({ id: "z2", subject: "Zebra", object: "x" }),
            factPage({ id: "a1", subject: "Apple &amp; Pear", object: "y" }),
            factPage({ id: "a2", subject: "Apple & Pear", object: "y" }),
          ],
        },
      ],
    })

    const collisions = await findPostDecodeFactCollisions(client, DB)
    expect(collisions.map((c) => c.triple.subject)).toEqual([
      "Apple & Pear",
      "Zebra",
    ])
  })
})

describe("fixFactEncoding", () => {
  it("is a no-op on a clean vault", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [factPage({ id: "f1", subject: "Auth", object: "JWT" })],
        },
      ],
    })

    const report = await fixFactEncoding(client, DB, { dryRun: false })
    expect(report.encoded).toEqual([])
    expect(report.fixes).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("rewrites Subject, Object, and DedupKey for each encoded row", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({
              id: "f1",
              subject: "Build &amp; Tooling",
              predicate: "uses",
              object: "Rollup",
            }),
            factPage({ id: "f2", subject: "clean", object: "clean" }),
          ],
        },
      ],
    })

    const report = await fixFactEncoding(client, DB, { dryRun: false })
    expect(report.fixes).toHaveLength(1)
    expect(client.pages.update).toHaveBeenCalledTimes(1)

    const call = client.pages.update.mock.calls[0][0]
    expect(call.page_id).toBe("f1")
    expect(call.properties).toEqual({
      Subject: { title: [{ text: { content: "Build & Tooling" } }] },
      Object: { rich_text: [{ text: { content: "Rollup" } }] },
      DedupKey: {
        rich_text: [
          {
            text: {
              content: computeFactDedupKey({
                subject: "Build & Tooling",
                predicate: "uses",
                object: "Rollup",
              }),
            },
          },
        ],
      },
    })
  })

  it("is idempotent — a second run finds nothing to do", async () => {
    // After the first-run rewrite the scanned rows are already decoded, so
    // a second invocation with the post-rewrite snapshot should produce
    // zero writes.
    const postFix = [
      factPage({
        id: "f1",
        subject: "Build & Tooling",
        predicate: "uses",
        object: "Rollup",
        dedupKey: computeFactDedupKey({
          subject: "Build & Tooling",
          predicate: "uses",
          object: "Rollup",
        }),
      }),
    ]
    const client = createMockClient({
      queryResponses: [{ results: postFix }],
    })

    const report = await fixFactEncoding(client, DB, { dryRun: false })
    expect(report.encoded).toEqual([])
    expect(report.fixes).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("dry-run surfaces encoded rows without writing", async () => {
    const client = createMockClient({
      queryResponses: [
        {
          results: [
            factPage({ id: "f1", subject: "A &amp; B", object: "x" }),
          ],
        },
      ],
    })

    const report = await fixFactEncoding(client, DB, { dryRun: true })
    expect(report.encoded).toHaveLength(1)
    expect(report.fixes).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("collision gate refuses to rewrite members of a colliding group", async () => {
    // Two rows would decode to the same triple. The rewrite MUST be
    // refused so the migration doesn't introduce a duplicate — the
    // operator is expected to run `--dedup-keys --merge --yes` first.
    const rows = [
      factPage({
        id: "f-clean",
        subject: "Build & Tooling",
        predicate: "uses",
        object: "Rollup",
      }),
      factPage({
        id: "f-encoded",
        subject: "Build &amp; Tooling",
        predicate: "uses",
        object: "Rollup",
      }),
    ]
    const client = createMockClient({
      queryResponses: [{ results: rows }],
    })

    const report = await fixFactEncoding(client, DB, { dryRun: false })
    expect(report.encoded.map((e) => e.id)).toEqual(["f-encoded"])
    expect(report.collisions).toHaveLength(1)
    expect(report.collisions[0].factIds).toEqual(["f-clean", "f-encoded"])
    // Critical: no writes happened despite the encoded row existing.
    expect(report.fixes).toEqual([])
    expect(client.pages.update).not.toHaveBeenCalled()
  })

  it("rewrites non-colliding rows even when an unrelated collision group exists", async () => {
    // Collision gate is row-level: blocking one group must not stop
    // unrelated rewrites.
    const rows = [
      // Unrelated encoded row — rewritable.
      factPage({
        id: "f-alone",
        subject: "Cache &amp; TTL",
        predicate: "has_a",
        object: "maxAge",
      }),
      // Colliding pair — both gated.
      factPage({
        id: "f-clean",
        subject: "Build & Tooling",
        predicate: "uses",
        object: "Rollup",
      }),
      factPage({
        id: "f-encoded",
        subject: "Build &amp; Tooling",
        predicate: "uses",
        object: "Rollup",
      }),
    ]
    const client = createMockClient({
      queryResponses: [{ results: rows }],
    })

    const report = await fixFactEncoding(client, DB, { dryRun: false })
    expect(report.fixes.map((f) => f.id)).toEqual(["f-alone"])
    expect(report.collisions).toHaveLength(1)
    expect(client.pages.update).toHaveBeenCalledTimes(1)
    expect(client.pages.update.mock.calls[0][0].page_id).toBe("f-alone")
  })
})
