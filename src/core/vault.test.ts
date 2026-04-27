import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { VaultManager } from "./vault.js"
import type { Vault } from "../types.js"

// Stub the SDK-touching pre-flight (`verifyVaultDatabases`) so the
// `load()`-level drift-gate tests below don't need to mock the entire
// blocks.children.list + databases.retrieve dance. The atomicity-gate
// tests above bypass `load()` entirely (they assign `manager.vault`
// directly) so they're unaffected by this mock.
//
// Note: `vi.mock` is hoisted, so this stub applies file-wide. Adding a
// future test that needs the *real* `verifyVaultDatabases` requires a
// `vi.doUnmock("../notion/setup.js")` inside that test's setup — or
// move it to a separate test file, which is the cleaner answer once
// this file gets a third class of test.
vi.mock("../notion/setup.js", async () => {
  const actual =
    await vi.importActual<typeof import("../notion/setup.js")>("../notion/setup.js")
  return {
    ...actual,
    verifyVaultDatabases: vi.fn(async () => VAULT),
  }
})

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
 */

const VAULT: Vault = {
  pageId: "page-id",
  databases: {
    projects: { databaseId: "proj-db", dataSourceId: "proj-ds" },
    topics: { databaseId: "topics-db", dataSourceId: "topics-ds" },
    memories: { databaseId: "mem-db", dataSourceId: "mem-ds" },
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
  retrieveMock: ReturnType<typeof vi.fn>
}

function mockClient(pages: PageObjectResponse[]): MockedClient {
  const queryMock = vi.fn().mockResolvedValue({
    results: pages,
    has_more: false,
    next_cursor: null,
  })
  const updateMock = vi.fn().mockResolvedValue({})
  const retrieveMock = vi.fn()

  const client = {
    pages: {
      update: updateMock,
      retrieve: vi.fn(),
      create: vi.fn(),
    },
    dataSources: {
      query: queryMock,
      retrieve: retrieveMock,
      update: vi.fn(),
    },
  } as unknown as Client

  return { client, queryMock, updateMock, retrieveMock }
}

function makeVaultManager(client: Client): VaultManager {
  const manager = new VaultManager(client, VAULT.pageId)
  // Bypass `load()` — we're exercising `migrate()` in isolation, not the
  // database-verification flow.
  ;(manager as unknown as { vault: Vault }).vault = VAULT
  return manager
}

describe("VaultManager.migrate — atomicity gate", () => {
  it("throws without writing when decoding would surface a cross-encoding dup and --merge-duplicate-topics is omitted", async () => {
    const { client, updateMock } = mockClient([
      topicPage("t1", "Build & Tooling", ["p1"]),
      topicPage("t2", "Build &amp; Tooling", ["p2"]),
    ])
    const manager = makeVaultManager(client)

    await expect(
      manager.migrate({ fixTopicEncoding: true })
    ).rejects.toThrow(/Decoding would surface 1 duplicate-name topic group/)

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

    await expect(
      manager.migrate({ fixTopicEncoding: true })
    ).rejects.toThrow() // migrateVaultSchema fails on the mock
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

describe("VaultManager.load — drift-check gate (0.6.0 issue 02)", () => {
  // The gate's job is to keep `detectDrift`'s multi-page Topics scan +
  // per-DS retrieve OFF the hot startup path when callers don't ask
  // for it. The signal we observe here is whether `dataSources.query`
  // gets invoked at all on the rate-limited client — if it does, the
  // drift path fired.

  it("does not run drift detection when driftCheck is omitted (default false)", async () => {
    const { client, queryMock, retrieveMock } = mockClient([])
    const manager = new VaultManager(client, VAULT.pageId)

    await manager.load()
    // Flush microtasks so any (incorrectly) fired drift work has a
    // chance to land before we assert "nothing happened."
    await new Promise<void>((r) => setTimeout(r, 0))

    // detectDrift would call migrateVaultSchema (dataSources.retrieve),
    // findDuplicateTopicNames + findEncodedTopicNames (dataSources.query).
    // Zero calls on either proves the entire drift path was skipped.
    expect(queryMock).not.toHaveBeenCalled()
    expect(retrieveMock).not.toHaveBeenCalled()
  })

  it("does not run drift detection when driftCheck is explicit false", async () => {
    const { client, queryMock, retrieveMock } = mockClient([])
    const manager = new VaultManager(client, VAULT.pageId)

    await manager.load({ driftCheck: false })
    await new Promise<void>((r) => setTimeout(r, 0))

    expect(queryMock).not.toHaveBeenCalled()
    expect(retrieveMock).not.toHaveBeenCalled()
  })

  it("runs drift detection when driftCheck is true", async () => {
    const { client, retrieveMock } = mockClient([])
    const manager = new VaultManager(client, VAULT.pageId)

    // Suppress the catch-and-log stderr line — detectDrift will throw
    // because the mock retrieve returns undefined and migrateVaultSchema
    // expects a populated DS payload. The whole point of this test is
    // that we got far enough to call retrieve.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await manager.load({ driftCheck: true })

      // detectDrift is fire-and-forget. Flush microtasks so the call
      // lands before we assert.
      await new Promise<void>((r) => setTimeout(r, 0))

      // First Notion fan-out from detectDrift is migrateVaultSchema's
      // per-DS retrieve. Asserting on retrieve (not query) is robust
      // even when the migrate pass fails fast on the bare-bones mock.
      expect(retrieveMock).toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it("returns the loaded vault even when the drift scan crashes", async () => {
    // Drift is best-effort — a transient Notion failure must not
    // prevent the vault from loading. Pin the property the JSDoc on
    // load() defends.
    const queryMock = vi.fn().mockRejectedValue(new Error("boom"))
    const client = {
      pages: { update: vi.fn(), retrieve: vi.fn(), create: vi.fn() },
      dataSources: {
        query: queryMock,
        retrieve: vi.fn().mockRejectedValue(new Error("boom")),
        update: vi.fn(),
      },
    } as unknown as Client
    const manager = new VaultManager(client, VAULT.pageId)

    // Silence the stderr the catch-and-log emits so test output stays
    // clean; we'll assert on the call instead.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(manager.load({ driftCheck: true })).resolves.toEqual(VAULT)
      // Flush microtasks so the rejected detectDrift promise settles
      // and the catch handler runs.
      await new Promise<void>((r) => setTimeout(r, 0))
      expect(errSpy).toHaveBeenCalledWith(
        "[lore] Schema drift check failed:",
        expect.any(String)
      )
    } finally {
      errSpy.mockRestore()
    }
  })
})
