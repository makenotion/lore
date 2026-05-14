import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { VaultManager } from "./vault.js"
import type { Vault } from "../types.js"
import {
  FACTS_DB_TITLE,
  MEMORIES_DB_TITLE,
  PROJECTS_DB_TITLE,
  TOPICS_DB_TITLE,
} from "../notion/schema.js"

/**
 * Focused tests on `VaultManager.migrate`'s atomicity gate — specifically
 * that cross-encoding duplicates forbid `--fix-topic-encoding` from writing
 * unless `--merge-duplicate-topics` is also authorized. A half-migrated
 * state is the single most important thing the gate prevents, so the
 * assertion is "throws AND `pages.update` was never called".
 *
 * Only the `migrate()` atomicity path is covered here; `migrateVaultSchema`
 * is unreachable when the gate throws, so the broader migrate flow lives
 * in the end-to-end story against real vaults.
 *
 * The `load()`-level drift-gate tests live in `vault-load.test.ts` so the
 * file-wide `vi.mock` of `verifyVaultDatabases` they need stays scoped
 * to that file.
 */

const VAULT: Vault = {
  pageId: "page-id",
  databases: {
    projects: { databaseId: "proj-db", dataSourceId: "proj-ds" },
    topics: { databaseId: "topics-db", dataSourceId: "topics-ds" },
    memories: { databaseId: "mem-db", dataSourceId: "mem-ds" },
    entities: { databaseId: "entities-db", dataSourceId: "entities-ds" },
    facts: { databaseId: "facts-db", dataSourceId: "facts-ds" },
  },
}

function topicPage(
  id: string,
  name: string,
  projectIds: string[] = []
): PageObjectResponse {
  return {
    object: "page",
    id,
    created_time: "2026-01-01T00:00:00.000Z",
    last_edited_time: "2026-02-01T00:00:00.000Z",
    archived: false,
    url: `https://notion.so/${id}`,
    parent: { type: "database_id", database_id: "topics-db" },
    properties: {
      Name: {
        type: "title",
        title: [{ plain_text: name }],
      } as unknown,
      Project: {
        type: "relation",
        relation: projectIds.map((pid) => ({ id: pid })),
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

interface MockedClient {
  client: Client
  queryMock: ReturnType<typeof vi.fn>
  updateMock: ReturnType<typeof vi.fn>
}

function mockClient(pages: PageObjectResponse[]): MockedClient {
  const queryMock = vi.fn().mockResolvedValue({
    results: pages,
    has_more: false,
    next_cursor: null,
  })
  const updateMock = vi.fn().mockResolvedValue({})

  const client = {
    pages: {
      update: updateMock,
      retrieve: vi.fn(),
      create: vi.fn(),
    },
    dataSources: {
      query: queryMock,
      retrieve: vi.fn(),
      update: vi.fn(),
    },
  } as unknown as Client

  return { client, queryMock, updateMock }
}

function makeVaultManager(client: Client): VaultManager {
  const manager = new VaultManager(client, VAULT.pageId)
  // Bypass `load()` — we're exercising `migrate()` in isolation, not the
  // database-verification flow.
  ;(manager as unknown as { vault: Vault }).vault = VAULT
  return manager
}

function initClientWithChildDatabases(
  childDatabases: Array<{ id: string; title: string }>
): { client: Client; createMock: ReturnType<typeof vi.fn> } {
  const createMock = vi.fn()
  const client = {
    blocks: {
      children: {
        list: vi.fn(async () => ({
          results: childDatabases.map((db) => ({
            type: "child_database",
            id: db.id,
            child_database: { title: db.title },
          })),
          has_more: false,
          next_cursor: null,
        })),
      },
    },
    databases: {
      create: createMock,
      retrieve: vi.fn(),
    },
    dataSources: {
      update: vi.fn(),
    },
  } as unknown as Client
  return { client, createMock }
}

describe("VaultManager.init — partial schema guard", () => {
  it("refuses to create duplicate databases when a legacy vault is missing only Entities", async () => {
    const { client, createMock } = initClientWithChildDatabases([
      { id: "block-projects", title: PROJECTS_DB_TITLE },
      { id: "block-topics", title: TOPICS_DB_TITLE },
      { id: "block-memories", title: MEMORIES_DB_TITLE },
      { id: "block-facts", title: FACTS_DB_TITLE },
    ])
    const manager = new VaultManager(client, "page-1")

    await expect(manager.init()).rejects.toThrow("do not run 'lore init'")
    expect(createMock).not.toHaveBeenCalled()
  })
})

describe("VaultManager.migrate — atomicity gate", () => {
  it("throws without writing when decoding would surface a cross-encoding dup and --merge-duplicate-topics is omitted", async () => {
    const { client, updateMock } = mockClient([
      topicPage("t1", "Build & Tooling", ["p1"]),
      topicPage("t2", "Build &amp; Tooling", ["p2"]),
    ])
    const manager = makeVaultManager(client)

    await expect(manager.migrate({ fixTopicEncoding: true })).rejects.toThrow(
      /Decoding would surface 1 duplicate-name topic group/
    )

    // Critical invariant: no write hit Notion. A half-migrated vault is
    // exactly what the gate is designed to prevent.
    expect(updateMock).not.toHaveBeenCalled()
  })

  it("lists the colliding decoded name in the error so the user can verify before re-running", async () => {
    const { client } = mockClient([
      topicPage("t1", "Build & Tooling"),
      topicPage("t2", "Build &amp; Tooling"),
    ])
    const manager = makeVaultManager(client)

    await expect(manager.migrate({ fixTopicEncoding: true })).rejects.toThrow(
      /"Build & Tooling" \(2 rows\)/
    )
  })

  it("does not gate when encoded rows exist but no decoded twin would collide", async () => {
    // Encoded rows without cross-encoding partners can decode cleanly with
    // just `--fix-topic-encoding`; the gate should not intervene. The
    // subsequent `migrateVaultSchema` call here will fail because our mock
    // has no dataSources.retrieve, so we assert that we at least PASSED the
    // gate (fixTopicEncoding wrote) before hitting that wall.
    const { client, updateMock } = mockClient([
      topicPage("t1", "Build &amp; Tooling"),
      topicPage("t2", "clean"),
    ])
    const manager = makeVaultManager(client)

    await expect(manager.migrate({ fixTopicEncoding: true })).rejects.toThrow() // migrateVaultSchema fails on the mock
    // The decode write happened — that's the point: the gate did not veto.
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        page_id: "t1",
        properties: expect.objectContaining({
          Name: expect.anything(),
        }),
      })
    )
  })

  it("does not gate when --merge-duplicate-topics is also passed", async () => {
    // With both flags, the gate must not throw even if cross-encoding dups
    // exist — the intent is that fixTopicEncoding + mergeDuplicateTopics
    // together land the vault in the intended final state.
    const { client } = mockClient([
      topicPage("t1", "Build & Tooling"),
      topicPage("t2", "Build &amp; Tooling"),
    ])
    const manager = makeVaultManager(client)

    // Downstream flow (mergeDuplicateTopics + migrateVaultSchema) will fail
    // against our bare-bones mock; the gate itself should not throw.
    await expect(
      manager.migrate({
        fixTopicEncoding: true,
        mergeDuplicateTopics: true,
      })
    ).rejects.not.toThrow(/Decoding would surface/)
  })

  it("does not gate on dry-run even when cross-encoding dups would surface", async () => {
    // Dry run must never write and never throw on the gate — its whole
    // purpose is to preview the drift without side effects.
    const { client, updateMock } = mockClient([
      topicPage("t1", "Build & Tooling"),
      topicPage("t2", "Build &amp; Tooling"),
    ])
    const manager = makeVaultManager(client)

    // The subsequent migrateVaultSchema call will still fail on the mock;
    // we only care that the gate did not throw.
    await expect(
      manager.migrate({ fixTopicEncoding: true, dryRun: true })
    ).rejects.not.toThrow(/Decoding would surface/)
    expect(updateMock).not.toHaveBeenCalled()
  })
})
