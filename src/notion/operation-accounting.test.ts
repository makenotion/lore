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
import { createLimitedClient } from "./rate-limit.js"

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

  it("attributes rate-limit backoffs after limiter timer hops to active context", async () => {
    vi.useFakeTimers()
    try {
      let calls = 0
      const raw = {
        dataSources: {
          query: vi.fn(async () => {
            calls += 1
            if (calls === 1) return { results: [] }
            throw Object.assign(new Error("rate_limited"), {
              code: "rate_limited",
              status: 429,
            })
          }),
        },
      } as unknown as Client
      const client = createOperationAccountingClient(
        createLimitedClient(
          raw,
          {
            concurrency: 1,
            requestsPerSecond: 10,
            burstSize: 1,
            endpointOverrides: {},
          },
          { onBackoff: () => recordNotionRateLimitBackoff() }
        )
      )

      await client.dataSources.query({ data_source_id: "pre-capture" })

      const trackedPromise = captureCostAccounting(async () => {
        await expect(
          client.dataSources.query({ data_source_id: "captured" })
        ).rejects.toThrow("rate_limited")
      })

      await vi.advanceTimersByTimeAsync(0)
      expect(raw.dataSources.query).toHaveBeenCalledTimes(1)

      await vi.advanceTimersByTimeAsync(100)
      const tracked = await trackedPromise

      expect(tracked.ok).toBe(true)
      expect(tracked.context.notion.rateLimitBackoffs).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
