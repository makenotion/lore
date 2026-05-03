import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { VaultManager } from "./vault.js"
import type { Vault } from "../types.js"

// Stub the SDK-touching pre-flight (`verifyVaultDatabases`) so the
// `load()`-level drift-gate tests below don't need to mock the entire
// blocks.children.list + databases.retrieve dance. Scoping the stub to
// this file (rather than co-locating with `vault.test.ts`) means the
// atomicity-gate tests over there exercise the real module, and a future
// test that needs the real `verifyVaultDatabases` lands in `vault.test.ts`
// without any `vi.doUnmock` boilerplate.
vi.mock("../notion/setup.js", async () => {
  const actual =
    await vi.importActual<typeof import("../notion/setup.js")>("../notion/setup.js")
  return {
    ...actual,
    verifyVaultDatabases: vi.fn(async () => VAULT),
  }
})

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

interface MockedClient {
  client: Client
  queryMock: ReturnType<typeof vi.fn>
  retrieveMock: ReturnType<typeof vi.fn>
}

function mockClient(pages: PageObjectResponse[]): MockedClient {
  const queryMock = vi.fn().mockResolvedValue({
    results: pages,
    has_more: false,
    next_cursor: null,
  })
  const retrieveMock = vi.fn()

  const client = {
    pages: {
      update: vi.fn().mockResolvedValue({}),
      retrieve: vi.fn(),
      create: vi.fn(),
    },
    dataSources: {
      query: queryMock,
      retrieve: retrieveMock,
      update: vi.fn(),
    },
  } as unknown as Client

  return { client, queryMock, retrieveMock }
}

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
