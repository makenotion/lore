import { describe, expect, it, beforeEach, vi } from "vitest"
import type { Client } from "@notionhq/client"
import type { LoreConfig } from "./types.js"

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>()
  return {
    ...actual,
    resolveAuth: vi.fn(),
  }
})

vi.mock("./notion/client.js", () => ({
  createAuthRefreshingClient: vi.fn(),
  createClient: vi.fn(),
}))

vi.mock("./notion/rate-limit.js", () => ({
  createLimitedClient: vi.fn((client: unknown) => client),
}))

vi.mock("./auth/identity.js", () => ({
  resolveAuthorIdentity: vi.fn(async () => ({ author: null })),
}))

import { resolveAuth } from "./config.js"
import { createClient } from "./notion/client.js"
import { initServicesFromConfig } from "./services.js"
import {
  FACTS_DB_TITLE,
  MEMORIES_DB_TITLE,
  PROJECTS_DB_TITLE,
  TOPICS_DB_TITLE,
} from "./notion/schema.js"

function clientWithLegacyVault(): Client {
  return {
    blocks: {
      children: {
        list: vi.fn(async () => ({
          results: [
            {
              id: "block-projects",
              type: "child_database",
              child_database: { title: PROJECTS_DB_TITLE },
            },
            {
              id: "block-topics",
              type: "child_database",
              child_database: { title: TOPICS_DB_TITLE },
            },
            {
              id: "block-memories",
              type: "child_database",
              child_database: { title: MEMORIES_DB_TITLE },
            },
            {
              id: "block-facts",
              type: "child_database",
              child_database: { title: FACTS_DB_TITLE },
            },
          ],
          has_more: false,
          next_cursor: null,
        })),
      },
    },
  } as unknown as Client
}

describe("initServicesFromConfig — required Entities database", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      baseUrl: undefined,
      source: "env-lore-notion-token",
    })
  })

  it("fails startup against a four-database legacy vault before constructing services", async () => {
    vi.mocked(createClient).mockReturnValue(clientWithLegacyVault())
    const config = {
      vault: { pageId: "page-1" },
      projects: [],
    } as LoreConfig

    await expect(
      initServicesFromConfig("/tmp/project", "/tmp/project", config)
    ).rejects.toThrow("missing databases: Entities")
  })
})
