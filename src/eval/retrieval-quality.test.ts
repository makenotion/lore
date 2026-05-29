import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import { runRetrievalQualitySuite } from "./retrieval-quality.js"
import { MEMORY_PROPS } from "../notion/schema.js"
import type { DatabaseRef, Memory } from "../types.js"

const DB: DatabaseRef = {
  databaseId: "memories-db",
  dataSourceId: "memories-ds",
}

function memory(id: string, title: string): Memory {
  return {
    id,
    title,
    content: "",
  } as Memory
}

function page(
  id: string,
  title: string,
  projectId = "project-mail-ios"
): PageObjectResponse {
  return {
    object: "page",
    id,
    created_time: "2026-05-01T00:00:00.000Z",
    last_edited_time: "2026-05-01T00:00:00.000Z",
    archived: false,
    parent: { type: "data_source_id", data_source_id: DB.dataSourceId },
    properties: {
      [MEMORY_PROPS.TITLE]: {
        type: "title",
        title: [{ plain_text: title }],
      } as unknown,
      [MEMORY_PROPS.PROJECT]: {
        type: "relation",
        relation: [{ id: projectId }],
      } as unknown,
    } as PageObjectResponse["properties"],
  } as PageObjectResponse
}

describe("runRetrievalQualitySuite", () => {
  it("scores AI, REST-keyword, and current lanes by target rank", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-retrieval-quality-"))
    const suitePath = join(dir, "suite.yaml")
    await writeFile(
      suitePath,
      [
        "version: 1",
        "name: fixture-quality",
        "cases:",
        "  - id: case-1",
        "    query: swift javascript json",
        "    projectName: Mail iOS",
        "    expectedTitle: Target Memory",
      ].join("\n")
    )

    try {
      const restResults = [
        ...Array.from({ length: 10 }, (_, index) =>
          page(`other-${index}`, "Other Project", "project-other")
        ),
        page("rest-noise", "Noise Memory"),
        page("rest-target", "Target Memory"),
      ]
      const client = {
        request: async () => ({}),
        search: async (args: { page_size?: number }) => ({
          results: restResults.slice(0, args.page_size ?? restResults.length),
          has_more: false,
          next_cursor: null,
        }),
      } as unknown as Client
      const services = {
        vault: { databases: { memories: DB } },
        projects: {
          findByName: async (name: string) =>
            name === "Mail iOS" ? { id: "project-mail-ios", name } : null,
        },
        memories: {
          searchWithMeta: async (input: { mode?: string }) => {
            await client.request({
              method: "post",
              path: "tools/run",
              body: { type: "search", search: {} },
            })
            return {
              capped: false,
              memories:
                input.mode === "semantic"
                  ? [memory("target", "Target Memory"), memory("noise", "Noise Memory")]
                  : [memory("noise", "Noise Memory"), memory("target", "Target Memory")],
            }
          },
          search: async () => [],
        },
        client,
      }

      const artifact = await runRetrievalQualitySuite(services as never, suitePath, {
        now: new Date("2026-05-29T00:00:00.000Z"),
      })

      const result = artifact.results[0]
      expect(result.lanes.map((lane) => [lane.lane, lane.targetRank])).toEqual([
        ["ai_search", 1],
        ["rest_keyword", 2],
        ["current", 2],
      ])
      expect(artifact.summary.ai_search.recallAt1).toBe(1)
      expect(artifact.summary.rest_keyword.mrr).toBe(0.5)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
