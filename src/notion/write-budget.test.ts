import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import type { Client } from "@notionhq/client"
import {
  classifyWriteBudget,
  WRITE_BUDGET_DIRECT_MUTATIONS,
  WRITE_BUDGET_DIRECT_READS,
  WRITE_BUDGET_RUNTOOL_MUTATIONS,
  WRITE_BUDGET_RUNTOOL_READS,
  WriteBudgetExceededError,
  wrapWithWriteBudget,
} from "./rate-limit.js"

interface ProxyableStub {
  pages: {
    create: () => Promise<unknown>
    update: () => Promise<unknown>
    updateMarkdown: () => Promise<unknown>
    retrieve: () => Promise<unknown>
    retrieveMarkdown: () => Promise<unknown>
    properties: {
      retrieve: () => Promise<unknown>
    }
  }
  databases: {
    create: () => Promise<unknown>
    retrieve: () => Promise<unknown>
  }
  dataSources: {
    update: () => Promise<unknown>
    retrieve: () => Promise<unknown>
    query: () => Promise<unknown>
  }
  search: () => Promise<unknown>
  request: (input: unknown) => Promise<unknown>
}

function makeStubClient(): ProxyableStub {
  return {
    pages: {
      async create() {
        return { id: "page-1" }
      },
      async update() {
        return { id: "page-1" }
      },
      async updateMarkdown() {
        return { id: "page-1" }
      },
      async retrieve() {
        return { id: "page-1" }
      },
      async retrieveMarkdown() {
        return { id: "page-1", markdown: "" }
      },
      properties: {
        async retrieve() {
          return { id: "prop-1" }
        },
      },
    },
    databases: {
      async create() {
        return { id: "db-1" }
      },
      async retrieve() {
        return { id: "db-1" }
      },
    },
    dataSources: {
      async update() {
        return { id: "ds-1" }
      },
      async retrieve() {
        return { id: "ds-1" }
      },
      async query() {
        return { results: [] }
      },
    },
    async search() {
      return { results: [] }
    },
    async request() {
      return {}
    },
  }
}

describe("classifyWriteBudget", () => {
  it.each(WRITE_BUDGET_DIRECT_MUTATIONS as readonly string[])(
    "classifies %s as mutation",
    (path) => {
      expect(classifyWriteBudget(path, [])).toBe("mutation")
    },
  )

  it.each(WRITE_BUDGET_DIRECT_READS as readonly string[])(
    "classifies %s as read",
    (path) => {
      expect(classifyWriteBudget(path, [])).toBe("read")
    },
  )

  it.each(WRITE_BUDGET_RUNTOOL_MUTATIONS as readonly string[])(
    "classifies request type=%s as mutation",
    (type) => {
      expect(classifyWriteBudget("request", [{ body: { type } }])).toBe(
        "mutation",
      )
    },
  )

  it.each(WRITE_BUDGET_RUNTOOL_READS as readonly string[])(
    "classifies request type=%s as read",
    (type) => {
      expect(classifyWriteBudget("request", [{ body: { type } }])).toBe("read")
    },
  )

  it("defaults unknown request body.type to mutation (default-deny)", () => {
    expect(
      classifyWriteBudget("request", [{ body: { type: "unknown_tool" } }]),
    ).toBe("mutation")
  })

  it("treats request with missing/non-object body as read passthrough", () => {
    expect(classifyWriteBudget("request", [{}])).toBe("read")
    expect(classifyWriteBudget("request", [{ body: null }])).toBe("read")
    expect(classifyWriteBudget("request", [{ body: "not-an-object" }])).toBe(
      "read",
    )
  })
})

describe("wrapWithWriteBudget", () => {
  let dir: string
  let statePath: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "write-budget-"))
    statePath = join(dir, "state.json")
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("increments counter on mutation success only", async () => {
    const stub = makeStubClient()
    const { client } = wrapWithWriteBudget(stub as unknown as Client, {
      limit: 5,
      stateFilePath: statePath,
    })
    await (client as unknown as ProxyableStub).pages.create()
    await (client as unknown as ProxyableStub).pages.retrieve()
    await (client as unknown as ProxyableStub).pages.update()
    // 2 mutations succeeded; the state file is only written past the cap,
    // so it should NOT exist yet.
    expect(() => readFileSync(statePath)).toThrow()
  })

  it("throws WriteBudgetExceededError past the cap", async () => {
    const stub = makeStubClient()
    const { client } = wrapWithWriteBudget(stub as unknown as Client, {
      limit: 2,
      stateFilePath: statePath,
    })
    const c = client as unknown as ProxyableStub
    await c.pages.create()
    await c.pages.create()
    // Third mutation hits the `count >= limit` preflight gate —
    // throws BEFORE dispatch. State file is written by the same call
    // (first observation of the cap) before throwing.
    await expect(c.pages.create()).rejects.toBeInstanceOf(
      WriteBudgetExceededError,
    )
    const body = JSON.parse(readFileSync(statePath, "utf-8")) as {
      writeBudgetExceeded: boolean
      count: number
      limit: number
    }
    expect(body.writeBudgetExceeded).toBe(true)
    expect(body.limit).toBe(2)
    // Cap is the exclusive limit on dispatch: at count === limit, the
    // next mutation throws BEFORE incrementing. Total successful
    // mutations = limit.
    expect(body.count).toBe(2)
    // Subsequent mutation: pre-call cap check throws before dispatch.
    await expect(c.pages.update()).rejects.toBeInstanceOf(
      WriteBudgetExceededError,
    )
    // Reads continue to function past the cap.
    await expect(c.pages.retrieve()).resolves.toBeDefined()
  })

  it("classifies pages.updateMarkdown as a counted mutation", async () => {
    const stub = makeStubClient()
    const { client } = wrapWithWriteBudget(stub as unknown as Client, {
      limit: 1,
      stateFilePath: statePath,
    })
    const c = client as unknown as ProxyableStub
    await c.pages.updateMarkdown()
    await expect(c.pages.updateMarkdown()).rejects.toBeInstanceOf(
      WriteBudgetExceededError,
    )
  })

  it("counts request body type=create_pages as a mutation", async () => {
    const stub = makeStubClient()
    const { client } = wrapWithWriteBudget(stub as unknown as Client, {
      limit: 1,
      stateFilePath: statePath,
    })
    const c = client as unknown as ProxyableStub
    await c.request({ body: { type: "create_pages" } })
    await expect(
      c.request({ body: { type: "create_pages" } }),
    ).rejects.toBeInstanceOf(WriteBudgetExceededError)
  })

  it("does not count request body type=query_data_sources", async () => {
    const stub = makeStubClient()
    const { client } = wrapWithWriteBudget(stub as unknown as Client, {
      limit: 1,
      stateFilePath: statePath,
    })
    const c = client as unknown as ProxyableStub
    for (let i = 0; i < 50; i += 1) {
      await c.request({ body: { type: "query_data_sources" } })
    }
    // Still under cap — no errors thrown.
    await expect(c.pages.create()).resolves.toBeDefined()
  })

  it("defaults unknown request body.type to counted (default-deny)", async () => {
    const stub = makeStubClient()
    const { client } = wrapWithWriteBudget(stub as unknown as Client, {
      limit: 1,
      stateFilePath: statePath,
    })
    const c = client as unknown as ProxyableStub
    await c.request({ body: { type: "totally_new_tool" } })
    await expect(
      c.request({ body: { type: "another_new_tool" } }),
    ).rejects.toBeInstanceOf(WriteBudgetExceededError)
  })

  it("rejects non-positive limit", () => {
    expect(() =>
      wrapWithWriteBudget({} as unknown as Client, {
        limit: 0,
        stateFilePath: statePath,
      }),
    ).toThrow(/positive integer/)
  })

  it("rejects empty stateFilePath", () => {
    expect(() =>
      wrapWithWriteBudget({} as unknown as Client, {
        limit: 5,
        stateFilePath: "",
      }),
    ).toThrow(/stateFilePath/)
  })

  it("writes the state file exactly once across multiple over-cap calls", async () => {
    const stub = makeStubClient()
    const writes: number[] = []
    const { client } = wrapWithWriteBudget(stub as unknown as Client, {
      limit: 1,
      stateFilePath: statePath,
      writeStateFile: () => writes.push(1),
    })
    const c = client as unknown as ProxyableStub
    await c.pages.create()
    await expect(c.pages.create()).rejects.toBeInstanceOf(
      WriteBudgetExceededError,
    )
    await expect(c.pages.create()).rejects.toBeInstanceOf(
      WriteBudgetExceededError,
    )
    expect(writes).toHaveLength(1)
  })

  it("flushBudgetCount writes a state-file snapshot under cap (authoritative notionWrites)", async () => {
    const stub = makeStubClient()
    const writes: Array<{ count: number; exceeded: boolean }> = []
    const wrapped = wrapWithWriteBudget(stub as unknown as Client, {
      limit: 10,
      stateFilePath: statePath,
      writeStateFile: (_path, body) =>
        writes.push({ count: body.count, exceeded: body.writeBudgetExceeded }),
    })
    const c = wrapped.client as unknown as ProxyableStub
    await c.pages.create()
    await c.pages.create()
    await c.pages.create()
    expect(wrapped.getCount()).toBe(3)
    // Pre-flush: no state file written yet (cap not hit).
    expect(writes).toHaveLength(0)
    wrapped.flushBudgetCount()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({ count: 3, exceeded: false })
  })

  it("flushBudgetCount marks exceeded=true when called after the cap was breached", async () => {
    const stub = makeStubClient()
    const writes: Array<{ count: number; exceeded: boolean }> = []
    const wrapped = wrapWithWriteBudget(stub as unknown as Client, {
      limit: 1,
      stateFilePath: statePath,
      writeStateFile: (_path, body) =>
        writes.push({ count: body.count, exceeded: body.writeBudgetExceeded }),
    })
    const c = wrapped.client as unknown as ProxyableStub
    await c.pages.create()
    await expect(c.pages.create()).rejects.toBeInstanceOf(
      WriteBudgetExceededError,
    )
    // Inline cap-exceeded writer fires on the rejected call BEFORE
    // dispatch; count is the successful-mutation total (limit), not
    // limit+1.
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({ count: 1, exceeded: true })
    // Flush writes a fresh snapshot — still exceeded=true.
    wrapped.flushBudgetCount()
    expect(writes).toHaveLength(2)
    expect(writes[1]).toEqual({ count: 1, exceeded: true })
  })

  it("flushBudgetCount marks exceeded=false at exact cap when no over-cap mutation attempted", async () => {
    // Verdict semantics: `writeBudgetExceeded` means a mutation was
    // attempted past the cap and rejected, NOT that the counter
    // happens to be at the cap. Exact-cap-without-attempted-overflow
    // is the same not-exceeded verdict the raw-transcript path
    // produces — it halts before crossing, so the counter can land
    // at `limit` with no rejection event. The two surfaces must
    // report the same verdict for the same observable behavior.
    const stub = makeStubClient()
    const writes: Array<{ count: number; exceeded: boolean }> = []
    const wrapped = wrapWithWriteBudget(stub as unknown as Client, {
      limit: 3,
      stateFilePath: statePath,
      writeStateFile: (_path, body) =>
        writes.push({ count: body.count, exceeded: body.writeBudgetExceeded }),
    })
    const c = wrapped.client as unknown as ProxyableStub
    // Land EXACTLY at the cap (3/3), no over-cap dispatch attempted.
    await c.pages.create()
    await c.pages.create()
    await c.pages.create()
    expect(wrapped.getCount()).toBe(3)
    // No state-file write yet — no cap-rejection event fired.
    expect(writes).toHaveLength(0)
    wrapped.flushBudgetCount()
    expect(writes).toHaveLength(1)
    expect(writes[0]).toEqual({ count: 3, exceeded: false })
  })
})
