import { afterEach, describe, expect, it, vi } from "vitest"
import { DEFAULT_MEMORY_SYNOPSIS_MAX, TAG_VOCABULARY } from "../types.js"
import { RICH_TEXT_PROPERTY_MAX_LEN } from "../core/rich-text-schema.js"
import {
  FetchBenchExtractionClient,
  SIMULATED_AUTOSAVE_EXTRACTION_SCHEMA,
  SimulatedAutosaveExtractionError,
  buildSimulatedAutosaveExtractionRequest,
  buildSimulatedAutosaveExtractionSchema,
  extractSimulatedAutosaveMemories,
  normalizeSimulatedAutosaveMemories,
  type BenchExtractionClient,
} from "./bench-simulated-autosave.js"

class StubExtractionClient implements BenchExtractionClient {
  public calls = 0
  public inputs: Parameters<BenchExtractionClient["complete"]>[0][] = []
  constructor(
    private readonly responses: Array<
      Awaited<ReturnType<BenchExtractionClient["complete"]>>
    >
  ) {}

  async complete(
    input: Parameters<BenchExtractionClient["complete"]>[0]
  ): ReturnType<BenchExtractionClient["complete"]> {
    this.calls += 1
    this.inputs.push(input)
    const next = this.responses.shift()
    if (!next) throw new Error("StubExtractionClient exhausted")
    return next
  }
}

describe("simulated-autosave structured output schema", () => {
  it("generates tags enum from TAG_VOCABULARY", () => {
    const properties = SIMULATED_AUTOSAVE_EXTRACTION_SCHEMA.properties as {
      memories: {
        items: {
          properties: {
            tags: {
              items: { enum: string[] }
            }
          }
        }
      }
    }
    expect(properties.memories.items.properties.tags.items.enum).toEqual([
      ...TAG_VOCABULARY,
    ])
  })

  it("can build a schema from a supplied profile tag vocabulary", () => {
    const schema = buildSimulatedAutosaveExtractionSchema(["alpha", "beta"])
    const properties = schema.properties as {
      memories: {
        items: {
          properties: {
            tags: {
              items: { enum: string[] }
            }
          }
        }
      }
    }
    expect(properties.memories.items.properties.tags.items.enum).toEqual([
      "alpha",
      "beta",
    ])
  })

  it("threads profile tags into the extraction request schema", () => {
    const request = buildSimulatedAutosaveExtractionRequest({
      extractionPrompt: "extract",
      transcript: "hello",
      tagVocabulary: ["alpha"],
    })
    const schema = request.response_format.json_schema.schema
    const properties = schema.properties as {
      memories: {
        items: {
          properties: {
            tags: {
              items: { enum: string[] }
            }
          }
        }
      }
    }
    expect(properties.memories.items.properties.tags.items.enum).toEqual(["alpha"])
  })
})

describe("FetchBenchExtractionClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("returns finish reason, refusal, and OpenAI-reported usage", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                finish_reason: "length",
                message: { content: null, refusal: "cannot comply" },
              },
            ],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 2,
              prompt_tokens_details: { cached_tokens: 4 },
            },
          }),
          { status: 200, statusText: "OK" }
        )
    )
    vi.stubGlobal("fetch", fetchMock)
    const client = new FetchBenchExtractionClient(
      "sk-test",
      "https://openai.test/v1",
      async () => {}
    )

    const result = await client.complete({
      model: "gpt-4o-mini-2024-07-18",
      messages: [{ role: "user", content: "x" }],
      temperature: 0,
      max_tokens: 1000,
      response_format: {
        type: "json_schema",
        json_schema: { name: "x", strict: true, schema: {} },
      },
    })

    expect(result).toEqual({
      content: null,
      finishReason: "length",
      refusal: "cannot comply",
      usage: {
        promptTokens: 10,
        cachedPromptTokens: 4,
        completionTokens: 2,
      },
    })
  })
})

describe("extractSimulatedAutosaveMemories", () => {
  it("retries length responses once and sums usage across attempts", async () => {
    const client = new StubExtractionClient([
      {
        content: JSON.stringify({ memories: [] }),
        finishReason: "length",
        refusal: null,
        usage: { promptTokens: 10, cachedPromptTokens: 2, completionTokens: 5 },
      },
      {
        content: JSON.stringify({ memories: [] }),
        finishReason: "stop",
        refusal: null,
        usage: { promptTokens: 11, cachedPromptTokens: 3, completionTokens: 6 },
      },
    ])

    const result = await extractSimulatedAutosaveMemories({
      client,
      extractionPrompt: "extract",
      transcript: "User: hi",
    })

    expect(client.calls).toBe(2)
    expect(client.inputs[1]?.messages[0]?.content).toContain("more compact")
    expect(result.usage).toEqual({
      promptTokens: 21,
      cachedPromptTokens: 5,
      completionTokens: 11,
    })
  })

  it("throws ingestion-safe errors with accumulated usage after invalid attempts", async () => {
    const client = new StubExtractionClient([
      {
        content: "{not-json",
        finishReason: "stop",
        refusal: null,
        usage: { promptTokens: 10, cachedPromptTokens: 1, completionTokens: 2 },
      },
      {
        content: null,
        finishReason: "stop",
        refusal: "no",
        usage: { promptTokens: 20, cachedPromptTokens: 2, completionTokens: 3 },
      },
    ])

    await expect(
      extractSimulatedAutosaveMemories({
        client,
        extractionPrompt: "extract",
        transcript: "User: hi",
      })
    ).rejects.toMatchObject({
      name: "SimulatedAutosaveExtractionError",
      usage: {
        promptTokens: 30,
        cachedPromptTokens: 3,
        completionTokens: 5,
      },
    } satisfies Partial<SimulatedAutosaveExtractionError>)
  })
})

describe("normalizeSimulatedAutosaveMemories", () => {
  it("maps structured records to CreateMemoryInput and mention entities", () => {
    const plans = normalizeSimulatedAutosaveMemories({
      projectId: "project-1",
      sessionId: "session-1",
      raw: {
        memories: [
          {
            title: ` ${"T".repeat(90)} `,
            synopsis: "S".repeat(DEFAULT_MEMORY_SYNOPSIS_MAX + 20),
            keywords: "PR-1234   beta",
            tags: ["backend", "personal", "backend"],
            content: "  User prefers the Notion API path. ",
            entities: ["Notion API", "Notion API", "New York"],
          },
        ],
      },
    })

    expect(plans).toHaveLength(1)
    expect(plans[0]?.createInput).toMatchObject({
      title: "T".repeat(80),
      content: "User prefers the Notion API path.",
      projectIds: ["project-1"],
      source: "autosave_learning",
      kind: "note",
      tags: ["backend"],
      session: "session-1",
      agent: "bench-simulated-autosave",
      autosaveLearningDedupScope: "off",
    })
    expect(plans[0]?.createInput.synopsis).toHaveLength(DEFAULT_MEMORY_SYNOPSIS_MAX)
    expect(plans[0]?.createInput.keywords).toContain("PR-1234 beta")
    expect(plans[0]?.createInput.keywords).toContain("Notion API")
    expect(plans[0]?.createInput.keywords).toContain("personal")
    expect(plans[0]?.createInput.keywords?.length).toBeLessThanOrEqual(
      RICH_TEXT_PROPERTY_MAX_LEN
    )
    expect(plans[0]?.mentionEntities).toEqual(["Notion API", "New York"])
  })

  it("normalizes tags against a supplied profile vocabulary", () => {
    const plans = normalizeSimulatedAutosaveMemories({
      projectId: "project-1",
      sessionId: "session-1",
      tagVocabulary: ["alpha"],
      raw: {
        memories: [
          {
            title: "Profile tag",
            synopsis: "",
            keywords: "",
            tags: ["alpha", "backend"],
            content: "content",
            entities: [],
          },
        ],
      },
    })

    expect(plans[0]?.createInput.tags).toEqual(["alpha"])
    expect(plans[0]?.createInput.keywords).toContain("backend")
  })

  it("drops records with empty title or content after trimming", () => {
    const plans = normalizeSimulatedAutosaveMemories({
      projectId: "project-1",
      sessionId: "session-1",
      raw: {
        memories: [
          {
            title: " ",
            synopsis: "",
            keywords: "",
            tags: [],
            content: "content",
            entities: [],
          },
          {
            title: "title",
            synopsis: "",
            keywords: "",
            tags: [],
            content: " ",
            entities: [],
          },
        ],
      },
    })

    expect(plans).toEqual([])
  })
})
