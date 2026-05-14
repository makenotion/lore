import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest"
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
  createAuthorIdentityResolver: vi.fn(() => ({
    resolveAuthor: vi.fn(async () => null),
    clearCache: vi.fn(),
  })),
  resolveAuthorIdentity: vi.fn(async () => ({ author: null })),
}))

import { resolveAuth } from "./config.js"
import { createClient } from "./notion/client.js"
import { initServicesFromConfig } from "./services.js"
import {
  ENTITIES_DB_TITLE,
  FACTS_DB_TITLE,
  MEMORIES_DB_TITLE,
  PROJECTS_DB_TITLE,
  TOPICS_DB_TITLE,
} from "./notion/schema.js"

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

function minimalProfileFiles(name: string, version = "1.0.0"): Record<string, string> {
  return {
    "profile.yaml": `name: ${name}\nversion: ${version}\ntaxonomy: taxonomy.yaml\nschema: schema.yaml\n`,
    "taxonomy.yaml": `tags:\n  - sales\nentityKinds:\n  - account\nwritableFactPredicates:\n  - owns\n`,
    "schema.yaml": `databases:\n  projects:\n    properties: {}\n  topics:\n    properties: {}\n  memories:\n    properties: {}\n  entities:\n    properties: {}\n  facts:\n    properties: {}\n`,
  }
}

function clientWithVault(): Client {
  const dbIds = [
    ["block-projects", PROJECTS_DB_TITLE],
    ["block-topics", TOPICS_DB_TITLE],
    ["block-memories", MEMORIES_DB_TITLE],
    ["block-entities", ENTITIES_DB_TITLE],
    ["block-facts", FACTS_DB_TITLE],
  ] as const
  return {
    blocks: {
      children: {
        list: vi.fn(async () => ({
          results: dbIds.map(([id, title]) => ({
            id,
            type: "child_database",
            child_database: { title },
          })),
          has_more: false,
          next_cursor: null,
        })),
      },
    },
    databases: {
      retrieve: vi.fn(async ({ database_id }: { database_id: string }) => ({
        id: database_id,
        data_sources: [{ id: `ds-${database_id}` }],
      })),
    },
    dataSources: {
      retrieve: vi.fn(async () => ({
        properties: {
          "Scope Kind": {},
          "Expires At": {},
        },
      })),
    },
  } as unknown as Client
}

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
  const scratchRoots: string[] = []

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok",
      baseUrl: undefined,
      source: "env-notion-api-token",
    })
  })

  afterEach(() => {
    for (const root of scratchRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true })
    }
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

  it("resolves an installed external profile through the config root", async () => {
    const root = mkdtempSync(join(tmpdir(), "lore-services-profile-"))
    scratchRoots.push(root)
    const profileDir = join(root, ".lore", "profiles", "installed", "sales", "1.0.0")
    writeFiles(profileDir, minimalProfileFiles("sales"))
    vi.mocked(createClient).mockReturnValue(clientWithVault())

    const services = await initServicesFromConfig(root, root, {
      vault: { pageId: "page-1" },
      profile: "sales@1.0.0",
      projects: [],
    } as LoreConfig)

    expect(services.profile.selector).toBe("sales@1.0.0")
    expect(services.profile.source).toBe("external")
    expect(services.profile.rootDir).toBe(profileDir)
  })
})
