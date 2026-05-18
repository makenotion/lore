import { describe, expect, it, vi } from "vitest"
import type { Client, PageObjectResponse } from "@notionhq/client"
import {
  PROMOTION_REASON_MAX_LEN,
  buildPromotionAuditBlock,
  preparePromotion,
  promoteMemory,
} from "./promote.js"
import { MemoryService } from "./memory.js"
import type { Memory, Vault } from "../types.js"
import type { PromotionTargetTopologyRef } from "./topology.js"
import { MEMORY_PROPS } from "../notion/schema.js"

// Stub the SDK-touching vault preflight (`verifyVaultDatabases`) so the
// target vault under test reports a deterministic schema without making
// network calls. The promote helper instantiates a fresh `VaultManager`
// for the target page id; mocking the preflight makes that step
// observable end-to-end without rebuilding the entire blocks /
// databases dance. Scoped to this file so other tests that need the
// real preflight (e.g. `vault.test.ts`) stay unaffected.
vi.mock("../notion/setup.js", async () => {
  const actual =
    await vi.importActual<typeof import("../notion/setup.js")>("../notion/setup.js")
  return {
    ...actual,
    verifyVaultDatabases: vi.fn(async (_client: unknown, pageId: string) => {
      const vault: Vault = {
        pageId,
        databases: {
          projects: {
            databaseId: `${pageId}-proj-db`,
            dataSourceId: `${pageId}-proj-ds`,
          },
          topics: {
            databaseId: `${pageId}-topics-db`,
            dataSourceId: `${pageId}-topics-ds`,
          },
          memories: {
            databaseId: `${pageId}-mem-db`,
            dataSourceId: `${pageId}-mem-ds`,
          },
          entities: {
            databaseId: `${pageId}-entities-db`,
            dataSourceId: `${pageId}-entities-ds`,
          },
          facts: { databaseId: `${pageId}-facts-db`, dataSourceId: `${pageId}-facts-ds` },
        },
      }
      return vault
    }),
  }
})

const FIXED_NOW = new Date("2026-05-12T14:30:00.000Z")

function makeSourceMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "source-mem-1",
    title: "JWT auth pattern for service-to-service calls",
    projectIds: ["proj-a"],
    topicId: null,
    source: "manual",
    kind: "note",
    status: "accepted",
    confidence: "likely",
    confidenceScore: 0.7,
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
    lastReferencedAt: null,
    supersedesIds: [],
    affectsIds: [],
    alternatives: "",
    consequences: "",
    author: "Source Author",
    agent: "Claude Code",
    tags: [],
    keywords: "auth jwt service",
    synopsis: "We sign service-to-service tokens with RS256 and verify via JWKS.",
    content: "Body content explaining the decision.",
    session: null,
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    scope: null,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-21T00:00:00.000Z",
    ...overrides,
  }
}

interface PromotionHarness {
  client: Client
  createSpy: ReturnType<typeof vi.fn>
  updateSpy: ReturnType<typeof vi.fn>
  updateMarkdownSpy: ReturnType<typeof vi.fn>
  retrieveMarkdownSpy: ReturnType<typeof vi.fn>
  retrieveDataSourceSpy: ReturnType<typeof vi.fn>
  queryDataSourceSpy: ReturnType<typeof vi.fn>
  memories: MemoryService
}

function makePromotionHarness(
  source: Memory,
  options: {
    getPropertiesByIdImpl?: (id: string) => Promise<Memory>
    dataSourceProperties?: Record<string, unknown>
    queryDataSourceImpl?: (args: unknown) => Promise<unknown>
    retrieveMarkdownImpl?: (args: { page_id: string }) => Promise<{ markdown: string }>
    updateImpl?: (args: unknown) => Promise<unknown>
  } = {}
): PromotionHarness {
  const createSpy = vi.fn(
    async (args: { parent: unknown; properties: Record<string, unknown> }) => ({
      object: "page",
      id: "promoted-mem-1",
      created_time: FIXED_NOW.toISOString(),
      last_edited_time: FIXED_NOW.toISOString(),
      archived: false,
      properties: args.properties,
      parent: { type: "database_id", database_id: "target-vault-mem-db" },
      url: "",
    })
  )
  const updateSpy = vi.fn(options.updateImpl ?? (async () => ({})))
  const updateMarkdownSpy = vi.fn(async () => ({}))
  const retrieveMarkdownSpy = vi.fn(
    options.retrieveMarkdownImpl ??
      (async () => ({ markdown: "## Promoted from Primary\n\nPromoted body." }))
  )
  const retrieveDataSourceSpy = vi.fn(async () => ({
    properties: options.dataSourceProperties ?? {
      [MEMORY_PROPS.PROMOTION_SOURCE_KEY]: {
        type: "rich_text",
        rich_text: {},
      },
    },
  }))
  const queryDataSourceSpy = vi.fn(
    options.queryDataSourceImpl ??
      (async () => ({
        results: [],
        has_more: false,
        next_cursor: null,
      }))
  )
  const client = {
    pages: {
      create: createSpy,
      update: updateSpy,
      updateMarkdown: updateMarkdownSpy,
      retrieveMarkdown: retrieveMarkdownSpy,
    },
    dataSources: {
      retrieve: retrieveDataSourceSpy,
      query: queryDataSourceSpy,
    },
  } as unknown as Client
  const defaultGetProps = async (id: string) => {
    if (id !== source.id) {
      throw new Error(`unexpected memory id: ${id}`)
    }
    // `getPropertiesById` returns the row WITHOUT body content;
    // `materializeContent` fetches the markdown. Mirror that
    // boundary in the harness so the test surface reflects the
    // production read path.
    return { ...source, content: "" }
  }
  const memories = {
    getPropertiesById: vi.fn(options.getPropertiesByIdImpl ?? defaultGetProps),
    materializeContent: vi.fn(async (memory: Memory) => ({
      ...memory,
      content: source.content,
    })),
  } as unknown as MemoryService

  return {
    client,
    createSpy,
    updateSpy,
    updateMarkdownSpy,
    retrieveMarkdownSpy,
    retrieveDataSourceSpy,
    queryDataSourceSpy,
    memories,
  }
}

function makeTargetMemoryPage(
  overrides: Partial<Memory> & { id: string; title: string }
): PageObjectResponse {
  const status = overrides.status ?? "proposed"
  return {
    object: "page",
    id: overrides.id,
    created_time: overrides.createdAt ?? FIXED_NOW.toISOString(),
    last_edited_time: overrides.updatedAt ?? FIXED_NOW.toISOString(),
    archived: false,
    parent: { type: "database_id", database_id: "target-vault-mem-db" },
    url: "",
    properties: {
      [MEMORY_PROPS.TITLE]: {
        type: "title",
        title: [{ plain_text: overrides.title }],
      },
      [MEMORY_PROPS.SOURCE]: {
        type: "select",
        select: { name: overrides.source ?? "manual" },
      },
      [MEMORY_PROPS.KIND]: {
        type: "select",
        select: { name: overrides.kind ?? "note" },
      },
      [MEMORY_PROPS.STATUS]: {
        type: "select",
        select: { name: status },
      },
      [MEMORY_PROPS.CONFIDENCE]: {
        type: "select",
        select: { name: overrides.confidence ?? "likely" },
      },
      [MEMORY_PROPS.PROMOTION_SOURCE_KEY]: {
        type: "rich_text",
        rich_text: [{ plain_text: overrides.promotionSourceKey ?? "" }],
      },
    } as unknown as PageObjectResponse["properties"],
  } as PageObjectResponse
}

function makeTarget(
  overrides: Partial<PromotionTargetTopologyRef> = {}
): PromotionTargetTopologyRef {
  return {
    role: "promotion-target",
    label: "Team",
    pageId: "target-vault",
    requireReview: false,
    ...overrides,
  }
}

describe("buildPromotionAuditBlock", () => {
  it("renders every required line for a fully-populated input", () => {
    const block = buildPromotionAuditBlock({
      sourceVaultLabel: "Primary",
      sourceMemoryId: "source-mem-1",
      sourceMemoryUrl: "https://notion.so/sourcemem1",
      sourceKind: "note",
      sourceStatus: "accepted",
      sourceConfidence: "likely",
      sourceSynopsis: "Short synopsis.",
      targetVaultLabel: "Team",
      requireReview: true,
      promoter: "Engineer Name",
      promotedAt: FIXED_NOW,
      reason: "Generalizes from the project pattern.",
    })

    expect(block).toBe(
      [
        "## Promoted from Primary",
        "",
        // Displayed id renders dashless to match the URL slug
        // (`notionPageUrl` strips hyphens). Hyphenated source ids
        // collapse on render — see the dashless-form test below.
        "- **Source memory:** [sourcemem1](https://notion.so/sourcemem1)",
        "- **Source vault:** Primary",
        "- **Source kind:** note",
        "- **Source status:** accepted",
        "- **Source confidence:** likely",
        "- **Source synopsis:** Short synopsis.",
        "- **Promoted to:** Team (review required)",
        "- **Promoter:** Engineer Name",
        `- **Promoted at:** ${FIXED_NOW.toISOString()}`,
        "- **Reason:** Generalizes from the project pattern.",
      ].join("\n")
    )
  })

  it("omits the link wrapper when sourceMemoryUrl is absent", () => {
    const block = buildPromotionAuditBlock({
      sourceVaultLabel: "Primary",
      sourceMemoryId: "source-mem-1",
      sourceKind: "note",
      sourceStatus: "accepted",
      sourceConfidence: "likely",
      sourceSynopsis: "",
      targetVaultLabel: "Team",
      requireReview: false,
      promoter: "Engineer Name",
      promotedAt: FIXED_NOW,
      reason: undefined,
    })

    expect(block).toContain("- **Source memory:** source-mem-1\n")
    expect(block).not.toContain("Source synopsis:")
    expect(block).not.toContain("Reason:")
    expect(block).toContain("- **Promoted to:** Team\n")
    expect(block).not.toContain("(review required)")
  })

  it("treats whitespace-only synopsis as absent", () => {
    const block = buildPromotionAuditBlock({
      sourceVaultLabel: "Primary",
      sourceMemoryId: "source-mem-1",
      sourceKind: "note",
      sourceStatus: "accepted",
      sourceConfidence: "likely",
      sourceSynopsis: "   ",
      targetVaultLabel: "Team",
      requireReview: false,
      promoter: "Engineer Name",
      promotedAt: FIXED_NOW,
      reason: undefined,
    })

    expect(block).not.toContain("Source synopsis:")
  })
})

describe("promoteMemory", () => {
  it("creates the promoted memory in the target vault with origin audit block", async () => {
    const source = makeSourceMemory()
    const {
      client,
      createSpy,
      updateSpy,
      updateMarkdownSpy,
      queryDataSourceSpy,
      memories,
    } = makePromotionHarness(source)

    const result = await promoteMemory(
      {
        client,
        memories,
        primaryVaultPageId: "primary-vault",
        primaryVaultLabel: "Primary",
      },
      {
        sourceMemoryId: source.id,
        target: makeTarget(),
        promoter: "Engineer Name",
        sourceMemoryUrl: "https://notion.so/sourcemem1",
        now: FIXED_NOW,
      }
    )

    expect(queryDataSourceSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        data_source_id: "target-vault-mem-ds",
        filter: {
          and: expect.arrayContaining([
            {
              property: "Promotion Source Key",
              rich_text: { equals: "v1:primaryvault:sourcemem1" },
            },
            {
              property: "Keywords",
              rich_text: { does_not_contain: "__lore-cleanup-orphan" },
            },
          ]),
        },
      })
    )
    expect(createSpy).toHaveBeenCalledTimes(1)
    const createArgs = createSpy.mock.calls[0]![0]
    expect(createArgs.parent).toEqual({
      type: "database_id",
      database_id: "target-vault-mem-db",
    })
    // Title preserved verbatim.
    const titleRich = (
      createArgs.properties as Record<
        string,
        { title: Array<{ text: { content: string } }> }
      >
    ).Title.title
    expect(titleRich[0]?.text.content).toBe(source.title)
    const promotionSourceKey = (
      createArgs.properties as Record<
        string,
        { rich_text: Array<{ text: { content: string } }> }
      >
    )["Promotion Source Key"].rich_text
    expect(promotionSourceKey[0]?.text.content).toBe("v1:primaryvault:sourcemem1")

    // Body write happened with the audit block prepended.
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(1)
    const bodyArgs = updateMarkdownSpy.mock.calls[0]![0] as {
      page_id: string
      insert_content: { content: string }
    }
    expect(bodyArgs.page_id).toBe("promoted-mem-1")
    expect(bodyArgs.insert_content.content).toContain("## Promoted from Primary")
    expect(bodyArgs.insert_content.content).toContain(
      // Displayed id is dashless (`normalizePageId` strips hyphens)
      // to match the URL slug. `source-mem-1` → `sourcemem1`.
      "- **Source memory:** [sourcemem1](https://notion.so/sourcemem1)"
    )
    expect(bodyArgs.insert_content.content).toContain("- **Promoter:** Engineer Name")
    expect(bodyArgs.insert_content.content).toContain(source.content)

    expect(updateSpy).not.toHaveBeenCalled()

    expect(result.targetVaultLabel).toBe("Team")
    expect(result.outcome).toBe("created")
    expect(result.status).toBe("accepted")
  })

  it("reuses an existing target row with the same promotion source key", async () => {
    const source = makeSourceMemory({
      id: "ABC12345-6789-4DEF-8123-456789012345",
    })
    const existing = makeTargetMemoryPage({
      id: "promoted-existing",
      title: "Already promoted title",
      status: "accepted",
      promotionSourceKey:
        "v1:abc1234567894def8123456789012345:abc1234567894def8123456789012345",
    })
    const {
      client,
      createSpy,
      updateSpy,
      updateMarkdownSpy,
      queryDataSourceSpy,
      memories,
    } = makePromotionHarness(source, {
      queryDataSourceImpl: async () => ({
        results: [existing],
        has_more: false,
        next_cursor: null,
      }),
    })

    const result = await promoteMemory(
      {
        client,
        memories,
        primaryVaultPageId: "abc12345-6789-4def-8123-456789012345",
        primaryVaultLabel: "Primary",
      },
      {
        sourceMemoryId: source.id,
        target: makeTarget(),
        promoter: "Engineer Name",
        now: FIXED_NOW,
      }
    )

    expect(queryDataSourceSpy).toHaveBeenCalledTimes(1)
    expect(createSpy).not.toHaveBeenCalled()
    expect(updateSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()
    expect(result.outcome).toBe("already-promoted")
    expect(result.promoted.id).toBe("promoted-existing")
    expect(result.status).toBe("accepted")
  })

  it("does not reuse a keyed properties-only orphan after body-write cleanup fails", async () => {
    const source = makeSourceMemory()
    const keyedOrphan = makeTargetMemoryPage({
      id: "promoted-orphan",
      title: "Properties-only orphan",
      promotionSourceKey: "v1:primaryvault:sourcemem1",
    })
    const {
      client,
      createSpy,
      updateSpy,
      updateMarkdownSpy,
      retrieveMarkdownSpy,
      memories,
    } = makePromotionHarness(source, {
      queryDataSourceImpl: async () => ({
        results: [keyedOrphan],
        has_more: false,
        next_cursor: null,
      }),
      retrieveMarkdownImpl: async ({ page_id }) => ({
        markdown:
          page_id === "promoted-orphan"
            ? ""
            : "## Promoted from Primary\n\nCompleted body.",
      }),
      updateImpl: async (args) => {
        if ((args as { archived?: boolean }).archived === true) {
          throw new Error("archive failed")
        }
        return {}
      },
    })
    updateMarkdownSpy
      .mockRejectedValueOnce(new Error("body write failed"))
      .mockResolvedValueOnce({})

    await expect(
      promoteMemory(
        {
          client,
          memories,
          primaryVaultPageId: "primary-vault",
          primaryVaultLabel: "Primary",
        },
        {
          sourceMemoryId: source.id,
          target: makeTarget(),
          promoter: "Engineer Name",
          now: FIXED_NOW,
        }
      )
    ).rejects.toThrow(/cleanup archive also failed/)

    expect(createSpy).toHaveBeenCalledTimes(1)
    const firstCreateSourceKey = (
      createSpy.mock.calls[0]![0].properties as Record<
        string,
        { rich_text: Array<{ text: { content: string } }> }
      >
    )["Promotion Source Key"].rich_text
    expect(firstCreateSourceKey[0]?.text.content).toBe("v1:primaryvault:sourcemem1")

    const result = await promoteMemory(
      {
        client,
        memories,
        primaryVaultPageId: "primary-vault",
        primaryVaultLabel: "Primary",
      },
      {
        sourceMemoryId: source.id,
        target: makeTarget(),
        promoter: "Engineer Name",
        now: FIXED_NOW,
      }
    )

    expect(result.outcome).toBe("created")
    expect(result.promoted.id).toBe("promoted-mem-1")
    expect(createSpy).toHaveBeenCalledTimes(2)
    expect(retrieveMarkdownSpy).toHaveBeenCalledWith({ page_id: "promoted-orphan" })
    expect(updateMarkdownSpy).toHaveBeenCalledTimes(2)
    expect(updateSpy).toHaveBeenCalledTimes(1)
    expect(updateSpy.mock.calls[0]![0]).toMatchObject({
      page_id: "promoted-mem-1",
      archived: true,
    })
  })

  it("fails before create when the target vault is missing Promotion Source Key", async () => {
    const source = makeSourceMemory()
    const { client, createSpy, queryDataSourceSpy, memories } = makePromotionHarness(
      source,
      {
        dataSourceProperties: {
          [MEMORY_PROPS.TITLE]: { type: "title", title: {} },
        },
      }
    )

    await expect(
      promoteMemory(
        { client, memories, primaryVaultPageId: "primary-vault" },
        {
          sourceMemoryId: source.id,
          target: makeTarget(),
          promoter: "Engineer Name",
          now: FIXED_NOW,
        }
      )
    ).rejects.toThrow(/Promotion Source Key/)

    expect(queryDataSourceSpy).not.toHaveBeenCalled()
    expect(createSpy).not.toHaveBeenCalled()
  })

  it("forces Status=proposed when target.requireReview is true", async () => {
    const source = makeSourceMemory({ status: "accepted" })
    const { client, createSpy, memories } = makePromotionHarness(source)

    const result = await promoteMemory(
      { client, memories, primaryVaultPageId: "primary-vault" },
      {
        sourceMemoryId: source.id,
        target: makeTarget({ requireReview: true }),
        promoter: "Engineer Name",
        now: FIXED_NOW,
      }
    )

    expect(result.status).toBe("proposed")
    const createProps = createSpy.mock.calls[0]![0].properties as Record<
      string,
      { select?: { name: string } }
    >
    expect(createProps.Status?.select?.name).toBe("proposed")
  })

  it("preserves source status when target.requireReview is false", async () => {
    // Use a non-proposed source status here. The `requireReview:
    // true` test above resolves to "proposed" regardless of source,
    // so a "preserve source status" test that ALSO uses
    // "proposed" leaves the two cases visually indistinguishable —
    // both pass and fail outcomes read identically. `informational`
    // is a status the `requireReview: true` branch will NEVER
    // produce (that branch always lands `proposed`), so a passing
    // assertion here means the source pass-through is actually
    // wired up and not a happy accident.
    const source = makeSourceMemory({ status: "informational" })
    const { client, createSpy, memories } = makePromotionHarness(source)

    const result = await promoteMemory(
      { client, memories, primaryVaultPageId: "primary-vault" },
      {
        sourceMemoryId: source.id,
        target: makeTarget({ requireReview: false }),
        promoter: "Engineer Name",
        now: FIXED_NOW,
      }
    )

    expect(result.status).toBe("informational")
    const createProps = createSpy.mock.calls[0]![0].properties as Record<
      string,
      { select?: { name: string } }
    >
    expect(createProps.Status?.select?.name).toBe("informational")
  })

  it("rejects promotion targeting the primary vault page id", async () => {
    const source = makeSourceMemory()
    const { client, memories, createSpy } = makePromotionHarness(source)

    await expect(
      promoteMemory(
        { client, memories, primaryVaultPageId: "shared-page" },
        {
          sourceMemoryId: source.id,
          target: makeTarget({ pageId: "shared-page" }),
          promoter: "Engineer Name",
          now: FIXED_NOW,
        }
      )
    ).rejects.toThrow(/Cannot promote into the primary vault/)

    expect(createSpy).not.toHaveBeenCalled()
  })

  it("rejects same-vault target even when one id is hyphenated and the other dashless", async () => {
    // Notion accepts both hyphenated UUIDs and compact 32-char ids
    // for the same page. Without normalization in the same-vault
    // guard, an operator who writes `vault.pageId` in one form and
    // `promotionTargets[].pageId` in the other would bypass the
    // guard and silently land a duplicate row in the primary vault
    // under the audit shape — exactly the misconfiguration the
    // guard exists to prevent.
    const source = makeSourceMemory()
    const { client, memories, createSpy } = makePromotionHarness(source)

    const dashed = "abc12345-6789-4def-8123-456789012345"
    const dashless = "abc1234567894def8123456789012345"

    await expect(
      promoteMemory(
        { client, memories, primaryVaultPageId: dashed },
        {
          sourceMemoryId: source.id,
          target: makeTarget({ pageId: dashless }),
          promoter: "Engineer Name",
          now: FIXED_NOW,
        }
      )
    ).rejects.toThrow(/Cannot promote into the primary vault/)

    // Symmetric: dashless primary, dashed target.
    await expect(
      promoteMemory(
        { client, memories, primaryVaultPageId: dashless },
        {
          sourceMemoryId: source.id,
          target: makeTarget({ pageId: dashed.toUpperCase() }),
          promoter: "Engineer Name",
          now: FIXED_NOW,
        }
      )
    ).rejects.toThrow(/Cannot promote into the primary vault/)

    expect(createSpy).not.toHaveBeenCalled()
  })

  it("propagates a non-Memories parent rejection from the source live-page gate", async () => {
    // `MemoryService.getPropertiesById` routes through
    // `requireLiveMemoryPage`, which rejects pages whose parent is
    // not the configured Memories DB. Pin that contract end-to-end
    // here: without it, `lore promote <any accessible Notion page>`
    // would copy from any database while the audit block claimed
    // primary-vault provenance — breaking the source-isolation
    // contract the audit metadata is meant to guarantee.
    const source = makeSourceMemory()
    const { client, memories, createSpy } = makePromotionHarness(source, {
      getPropertiesByIdImpl: async () => {
        throw new Error(`Memory ${source.id} is not in the Memories database.`)
      },
    })

    await expect(
      promoteMemory(
        { client, memories, primaryVaultPageId: "primary-vault" },
        {
          sourceMemoryId: source.id,
          target: makeTarget(),
          promoter: "Engineer Name",
          now: FIXED_NOW,
        }
      )
    ).rejects.toThrow(/not in the Memories database/)

    expect(createSpy).not.toHaveBeenCalled()
  })

  it("propagates an archived-source rejection from the source live-page gate", async () => {
    // Companion to the non-Memories-parent test above:
    // `requireLiveMemoryPage` also rejects archived rows.
    // Promoting an archived row would land a target-vault copy with
    // an audit block that claims primary-vault provenance against a
    // row the operator already removed from active use.
    const source = makeSourceMemory()
    const { client, memories, createSpy } = makePromotionHarness(source, {
      getPropertiesByIdImpl: async () => {
        throw new Error(`Memory ${source.id} is archived.`)
      },
    })

    await expect(
      promoteMemory(
        { client, memories, primaryVaultPageId: "primary-vault" },
        {
          sourceMemoryId: source.id,
          target: makeTarget(),
          promoter: "Engineer Name",
          now: FIXED_NOW,
        }
      )
    ).rejects.toThrow(/archived/)

    expect(createSpy).not.toHaveBeenCalled()
  })

  it("rejects empty / whitespace-only promoter names", async () => {
    const source = makeSourceMemory()
    const { client, memories, createSpy } = makePromotionHarness(source)

    await expect(
      promoteMemory(
        { client, memories, primaryVaultPageId: "primary-vault" },
        {
          sourceMemoryId: source.id,
          target: makeTarget(),
          promoter: "   ",
          now: FIXED_NOW,
        }
      )
    ).rejects.toThrow(/non-empty promoter name/)

    expect(createSpy).not.toHaveBeenCalled()
  })

  it("does not carry source projectIds across the vault boundary", async () => {
    const source = makeSourceMemory({ projectIds: ["proj-a", "proj-b"] })
    const { client, createSpy, memories } = makePromotionHarness(source)

    await promoteMemory(
      { client, memories, primaryVaultPageId: "primary-vault" },
      {
        sourceMemoryId: source.id,
        target: makeTarget(),
        promoter: "Engineer Name",
        now: FIXED_NOW,
      }
    )

    // `buildMemoryProps` omits the Project relation property entirely
    // when projectIds is empty (see schema.ts:938 — the `length` guard).
    // The absence of the column is the load-bearing assertion: a Notion
    // `relation` column targets a specific Projects DB, so writing an
    // empty-array relation in the target vault would silently land an
    // empty payload against the WRONG Projects DB schema.
    expect("Project" in createSpy.mock.calls[0]![0].properties).toBe(false)
  })

  it("does not carry source tags across the vault boundary", async () => {
    // Tags are dropped on cross-vault writes, mirroring the
    // projectIds treatment above. The closed `Tag` vocabulary is
    // enforced at the MCP boundary, not at the service layer (per
    // `CreateMemoryInput.tags` at `src/types.ts:874-880`), so a
    // target-vault tag vocabulary can diverge from the source's. A
    // copied tag that isn't valid in the target's MCP-boundary Zod
    // schema would commit on this write and then reject on the
    // operator's next `lore-memory action='update'` in the target —
    // dropping tags here is the safer default. Operators re-tag via
    // `lore-memory action='update'` against the target-vault MCP
    // boundary.
    const source = makeSourceMemory({ tags: ["learning", "pattern"] })
    const { client, createSpy, memories } = makePromotionHarness(source)

    await promoteMemory(
      { client, memories, primaryVaultPageId: "primary-vault" },
      {
        sourceMemoryId: source.id,
        target: makeTarget(),
        promoter: "Engineer Name",
        now: FIXED_NOW,
      }
    )

    // `buildMemoryProps` omits the Tags multi-select property when
    // tags is undefined/empty (no length means no column write —
    // same posture as projectIds). The absence of the column is the
    // load-bearing assertion.
    expect("Tags" in createSpy.mock.calls[0]![0].properties).toBe(false)
  })

  it("forces source=manual on the promoted row regardless of source provenance", async () => {
    const source = makeSourceMemory({ source: "conversation" })
    const { client, createSpy, memories } = makePromotionHarness(source)

    await promoteMemory(
      { client, memories, primaryVaultPageId: "primary-vault" },
      {
        sourceMemoryId: source.id,
        target: makeTarget(),
        promoter: "Engineer Name",
        now: FIXED_NOW,
      }
    )

    const sourceProp = createSpy.mock.calls[0]![0].properties.Source as {
      select: { name: string }
    }
    expect(sourceProp.select.name).toBe("manual")
  })

  it("truncates an over-long reason and tags it with the truncation marker", async () => {
    const source = makeSourceMemory()
    const { client, updateMarkdownSpy, memories } = makePromotionHarness(source)

    const longReason = "x".repeat(PROMOTION_REASON_MAX_LEN + 100)

    await promoteMemory(
      { client, memories, primaryVaultPageId: "primary-vault" },
      {
        sourceMemoryId: source.id,
        target: makeTarget(),
        promoter: "Engineer Name",
        reason: longReason,
        now: FIXED_NOW,
      }
    )

    const body = (
      updateMarkdownSpy.mock.calls[0]![0] as { insert_content: { content: string } }
    ).insert_content.content
    expect(body).toContain("… [truncated]")
    // The truncated reason line carries the trailing marker; the
    // pre-truncation portion stays intact.
    expect(body).toMatch(/- \*\*Reason:\*\* x{1000}… \[truncated\]/)
  })

  it("omits the reason line when reason is empty / whitespace-only", async () => {
    const source = makeSourceMemory()
    const { client, updateMarkdownSpy, memories } = makePromotionHarness(source)

    await promoteMemory(
      { client, memories, primaryVaultPageId: "primary-vault" },
      {
        sourceMemoryId: source.id,
        target: makeTarget(),
        promoter: "Engineer Name",
        reason: "   ",
        now: FIXED_NOW,
      }
    )

    const body = (
      updateMarkdownSpy.mock.calls[0]![0] as { insert_content: { content: string } }
    ).insert_content.content
    expect(body).not.toContain("Reason:")
  })

  it("at-cap reason + at-cap synopsis + large body all flow through pages.updateMarkdown without rejection", async () => {
    // The audit block embeds the source synopsis (capped at 500
    // chars by the MCP boundary / service layer per `SYNOPSIS_MAX`)
    // and an optional reason (capped at `PROMOTION_REASON_MAX_LEN =
    // 1000` here). Concatenated with a large body, the whole thing
    // is written via `pages.updateMarkdown` — Notion's markdown API
    // segments the content server-side and is NOT subject to the
    // per-block 2000-char rich_text cap that direct property writes
    // hit. This test pins that the combined max-shape input writes
    // through without rejection. If a future refactor switches the
    // body write off `updateMarkdown` and onto a path that DOES hit
    // the rich_text cap, this test will fail with a per-block-size
    // error.
    const longSynopsis = "s".repeat(500)
    const longReason = "r".repeat(PROMOTION_REASON_MAX_LEN)
    const longBody = "body line\n".repeat(2000)
    const source = makeSourceMemory({ synopsis: longSynopsis, content: longBody })
    const { client, updateMarkdownSpy, memories } = makePromotionHarness(source)

    await expect(
      promoteMemory(
        { client, memories, primaryVaultPageId: "primary-vault" },
        {
          sourceMemoryId: source.id,
          target: makeTarget(),
          promoter: "Engineer Name",
          reason: longReason,
          now: FIXED_NOW,
        }
      )
    ).resolves.toMatchObject({ targetVaultLabel: "Team" })

    const body = (
      updateMarkdownSpy.mock.calls[0]![0] as { insert_content: { content: string } }
    ).insert_content.content
    expect(body).toContain(longSynopsis)
    expect(body).toContain(longReason)
    // Body content from the source is appended after the audit block.
    expect(body).toContain("body line")
    expect(body).not.toContain("… [truncated]")
  })

  it("formats the source-memory audit link using the dashless id form to match the URL slug", async () => {
    // `notionPageUrl` strips hyphens; rendering the displayed id in
    // the hyphenated form while the link target is dashless reads
    // as "the id and the link disagree." Pin the symmetric form.
    const dashedSourceId = "abc12345-6789-4def-8123-456789012345"
    const dashlessSourceId = "abc1234567894def8123456789012345"
    const source = makeSourceMemory({ id: dashedSourceId })
    const { client, updateMarkdownSpy, memories } = makePromotionHarness(source)

    await promoteMemory(
      { client, memories, primaryVaultPageId: "primary-vault" },
      {
        sourceMemoryId: dashedSourceId,
        target: makeTarget(),
        promoter: "Engineer Name",
        sourceMemoryUrl: `https://notion.so/${dashlessSourceId}`,
        now: FIXED_NOW,
      }
    )

    const body = (
      updateMarkdownSpy.mock.calls[0]![0] as { insert_content: { content: string } }
    ).insert_content.content
    expect(body).toContain(
      `- **Source memory:** [${dashlessSourceId}](https://notion.so/${dashlessSourceId})`
    )
    expect(body).not.toContain(dashedSourceId)
  })

  it("emits only the audit block when the source memory has no body", async () => {
    const source = makeSourceMemory({ content: "" })
    const { client, updateMarkdownSpy, memories } = makePromotionHarness(source)

    await promoteMemory(
      { client, memories, primaryVaultPageId: "primary-vault" },
      {
        sourceMemoryId: source.id,
        target: makeTarget(),
        promoter: "Engineer Name",
        now: FIXED_NOW,
      }
    )

    const body = (
      updateMarkdownSpy.mock.calls[0]![0] as { insert_content: { content: string } }
    ).insert_content.content
    expect(body.startsWith("## Promoted from")).toBe(true)
    // No body content was appended — the audit block stands alone.
    expect(body.trim().endsWith("[truncated]")).toBe(false)
  })
})

describe("preparePromotion (dry-run)", () => {
  it("composes the audit block and resolved status without target-vault writes", async () => {
    const source = makeSourceMemory()
    const { client, createSpy, updateMarkdownSpy, memories } =
      makePromotionHarness(source)

    const preview = await preparePromotion(
      {
        client,
        memories,
        primaryVaultPageId: "primary-vault",
        primaryVaultLabel: "Primary",
      },
      {
        sourceMemoryId: source.id,
        target: makeTarget({ requireReview: true }),
        promoter: "Engineer Name",
        sourceMemoryUrl: "https://notion.so/sourcemem1",
        reason: "Trial run",
        now: FIXED_NOW,
      }
    )

    // No target-vault round-trips were issued — the apply path's
    // `targetVault.load` and `targetMemories.create` both stay
    // unfired. The only Notion call surface a dry-run touches is
    // the source-side `getPropertiesById` + `materializeContent`
    // pair.
    expect(createSpy).not.toHaveBeenCalled()
    expect(updateMarkdownSpy).not.toHaveBeenCalled()

    expect(preview.status).toBe("proposed")
    expect(preview.promoter).toBe("Engineer Name")
    expect(preview.auditBlock).toContain("## Promoted from Primary")
    expect(preview.auditBlock).toContain("- **Reason:** Trial run")
    expect(preview.body).toContain(preview.auditBlock)
    expect(preview.body).toContain(source.content)
  })

  it("rejects same-vault target before issuing any Notion read (cheap-rejection ordering)", async () => {
    const source = makeSourceMemory()
    const { client, memories } = makePromotionHarness(source)
    const getPropsSpy = vi.mocked(memories.getPropertiesById)

    await expect(
      preparePromotion(
        { client, memories, primaryVaultPageId: "primary-vault" },
        {
          sourceMemoryId: source.id,
          target: makeTarget({ pageId: "primary-vault" }),
          promoter: "Engineer Name",
          now: FIXED_NOW,
        }
      )
    ).rejects.toThrow(/Cannot promote into the primary vault/)

    // The same-vault guard fires before the source read — a
    // misconfigured invocation does not pay the Notion round-trip.
    expect(getPropsSpy).not.toHaveBeenCalled()
  })
})
