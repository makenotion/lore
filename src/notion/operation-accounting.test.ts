import { describe, expect, it, vi } from "vitest"
import type { Client } from "@notionhq/client"
import {
  captureCostAccounting,
  recordNotionRateLimitBackoff,
} from "../core/cost-accounting.js"
import {
  classifyNotionOperation,
  createOperationAccountingClient,
} from "./operation-accounting.js"

describe("Notion operation accounting", () => {
  it("classifies known SDK and RunTool paths", () => {
    expect(classifyNotionOperation("dataSources.query", [])).toBe("read")
    expect(classifyNotionOperation("pages.updateMarkdown", [])).toBe("write")
    expect(
      classifyNotionOperation("request", [
        {
          method: "post",
          path: "tools/run",
          body: { type: "query_data_sources", query_data_sources: {} },
        },
      ])
    ).toBe("read")
    expect(
      classifyNotionOperation("request", [
        {
          method: "post",
          path: "tools/run",
          body: { type: "update_page", update_page: {} },
        },
      ])
    ).toBe("write")
    expect(
      classifyNotionOperation("request", [
        { method: "patch", path: "pages/page-id", body: {} },
      ])
    ).toBe("write")
  })

  it("leaves unknown helper functions unwrapped", async () => {
    type HelperClient = Client & {
      helper: (value: string) => string
      list: () => string
      helpers: {
        helper: (this: { prefix: string }, value: string) => string
        prefix: string
      }
    }

    const raw = {
      helper: vi.fn((value: string) => `helper:${value}`),
      list: vi.fn(() => "list"),
      helpers: {
        helper: vi.fn(function (this: { prefix: string }, value: string) {
          return `${this.prefix}:${value}`
        }),
        prefix: "nested",
      },
    } as unknown as HelperClient
    const client = createOperationAccountingClient(raw) as HelperClient

    expect(client.helper).toBe(raw.helper)
    expect(client.list).toBe(raw.list)
    expect(client.helpers).toBe(raw.helpers)
    expect(client.helpers.helper).toBe(raw.helpers.helper)

    const tracked = await captureCostAccounting(async () => {
      expect(client.helper("value")).toBe("helper:value")
      expect(client.list()).toBe("list")
      expect(client.helpers.helper("value")).toBe("nested:value")
    })

    expect(tracked.ok).toBe(true)
    expect(tracked.context.notion).toEqual({
      reads: 0,
      writes: 0,
      failures: 0,
      rateLimitBackoffs: 0,
    })
    expect(raw.helper).toHaveBeenCalledWith("value")
    expect(raw.list).toHaveBeenCalled()
    expect(raw.helpers.helper).toHaveBeenCalledWith("value")
  })

  it("still instruments known nested SDK methods", async () => {
    const raw = {
      dataSources: {
        query: vi.fn(async () => ({ results: [] })),
      },
    } as unknown as Client
    const client = createOperationAccountingClient(raw)

    const tracked = await captureCostAccounting(async () => {
      await client.dataSources.query({ data_source_id: "ds" })
    })

    expect(tracked.ok).toBe(true)
    expect(tracked.context.notion).toEqual({
      reads: 1,
      writes: 0,
      failures: 0,
      rateLimitBackoffs: 0,
    })
  })

  it("still instruments top-level RunTool requests", async () => {
    const raw = {
      request: vi.fn(async () => ({})),
    } as unknown as Client
    const client = createOperationAccountingClient(raw)

    const tracked = await captureCostAccounting(async () => {
      await client.request({
        method: "post",
        path: "tools/run",
        body: { type: "query_data_sources", query_data_sources: {} },
      })
    })

    expect(tracked.ok).toBe(true)
    expect(tracked.context.notion).toEqual({
      reads: 1,
      writes: 0,
      failures: 0,
      rateLimitBackoffs: 0,
    })
  })

  it("attributes reads, writes, failures, and rate-limit backoffs to active context", async () => {
    const raw = {
      dataSources: {
        query: vi.fn(async () => ({ results: [] })),
      },
      pages: {
        update: vi.fn(async () => ({ id: "page" })),
        retrieve: vi.fn(async () => {
          throw new Error("notion 500")
        }),
      },
    } as unknown as Client
    const client = createOperationAccountingClient(raw)

    const tracked = await captureCostAccounting(async () => {
      await client.dataSources.query({ data_source_id: "ds" })
      await client.pages.update({ page_id: "page", properties: {} })
      await expect(client.pages.retrieve({ page_id: "missing" })).rejects.toThrow(
        "notion 500"
      )
      recordNotionRateLimitBackoff()
    })

    expect(tracked.ok).toBe(true)
    expect(tracked.context.notion).toEqual({
      reads: 1,
      writes: 1,
      failures: 1,
      rateLimitBackoffs: 1,
    })
  })

  it("attributes RunTool request envelopes to active context", async () => {
    const raw = {
      request: vi.fn(async (args: { body?: { type?: string } }) => {
        if (args.body?.type === "update_page") {
          throw new Error("notion 500")
        }
        return {}
      }),
    } as unknown as Client
    const client = createOperationAccountingClient(raw)

    const tracked = await captureCostAccounting(async () => {
      await client.request({
        method: "post",
        path: "tools/run",
        body: { type: "query_data_sources", query_data_sources: {} },
      })
      await client.request({
        method: "post",
        path: "tools/run",
        body: { type: "create_pages", create_pages: {} },
      })
      await expect(
        client.request({
          method: "post",
          path: "tools/run",
          body: { type: "update_page", update_page: {} },
        })
      ).rejects.toThrow("notion 500")
    })

    expect(tracked.ok).toBe(true)
    expect(tracked.context.notion).toEqual({
      reads: 1,
      writes: 1,
      failures: 1,
      rateLimitBackoffs: 0,
    })
  })
})
