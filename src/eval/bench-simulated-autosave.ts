import { z } from "zod"
import {
  DEFAULT_MEMORY_SYNOPSIS_MAX,
  TAG_VOCABULARY,
  type CreateMemoryInput,
} from "../types.js"
import { RICH_TEXT_PROPERTY_MAX_LEN } from "../core/rich-text-schema.js"
import { MAX_AUTO_MENTION_ENTITIES } from "../core/auto-mentions.js"

export const SIMULATED_AUTOSAVE_EXTRACTION_MODEL = "gpt-4o-mini-2024-07-18"
export const SIMULATED_AUTOSAVE_EXTRACTION_TEMPERATURE = 0
export const SIMULATED_AUTOSAVE_EXTRACTION_MAX_TOKENS = 1000
export const SIMULATED_AUTOSAVE_EXTRACTION_SCHEMA_VERSION = 1

export interface BenchExtractionUsage {
  promptTokens: number
  cachedPromptTokens: number
  completionTokens: number
}

export interface BenchExtractionClient {
  complete(input: {
    model: string
    messages: Array<{ role: "system" | "user"; content: string }>
    temperature: number
    max_tokens: number
    response_format: {
      type: "json_schema"
      json_schema: {
        name: string
        strict: true
        schema: Record<string, unknown>
      }
    }
  }): Promise<{
    content: string | null
    finishReason: string | null
    refusal: string | null
    usage: BenchExtractionUsage
  }>
}

export interface RawExtractedBenchMemory {
  title: string
  synopsis: string
  keywords: string
  tags: string[]
  content: string
  entities: string[]
}

export interface RawSimulatedAutosaveExtraction {
  memories: RawExtractedBenchMemory[]
}

export interface ExtractedBenchMemory {
  title: string
  synopsis: string
  keywords: string
  tags: string[]
  content: string
  entities: string[]
}

export interface SimulatedAutosaveMemoryPlan {
  createInput: CreateMemoryInput
  mentionEntities: string[]
}

export interface ExtractSimulatedAutosaveMemoriesResult {
  raw: RawSimulatedAutosaveExtraction
  usage: BenchExtractionUsage
}

export class SimulatedAutosaveExtractionError extends Error {
  constructor(
    message: string,
    public readonly usage: BenchExtractionUsage = zeroExtractionUsage()
  ) {
    super(message)
    this.name = "SimulatedAutosaveExtractionError"
  }
}

export function zeroExtractionUsage(): BenchExtractionUsage {
  return {
    promptTokens: 0,
    cachedPromptTokens: 0,
    completionTokens: 0,
  }
}

export function addExtractionUsage(
  a: BenchExtractionUsage,
  b: BenchExtractionUsage
): BenchExtractionUsage {
  return {
    promptTokens: a.promptTokens + b.promptTokens,
    cachedPromptTokens: a.cachedPromptTokens + b.cachedPromptTokens,
    completionTokens: a.completionTokens + b.completionTokens,
  }
}

export function buildSimulatedAutosaveExtractionSchema(
  tagVocabulary: readonly string[] = TAG_VOCABULARY
): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["memories"],
    properties: {
      memories: {
        type: "array",
        maxItems: 8,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["title", "synopsis", "keywords", "tags", "content", "entities"],
          properties: {
            title: { type: "string" },
            synopsis: { type: "string" },
            keywords: { type: "string" },
            tags: {
              type: "array",
              items: {
                type: "string",
                enum: [...tagVocabulary],
              },
            },
            content: { type: "string" },
            entities: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
      },
    },
  }
}

export const SIMULATED_AUTOSAVE_EXTRACTION_SCHEMA: Record<string, unknown> =
  buildSimulatedAutosaveExtractionSchema()

const rawExtractedBenchMemorySchema = z
  .object({
    title: z.string(),
    synopsis: z.string(),
    keywords: z.string(),
    tags: z.array(z.string()),
    content: z.string(),
    entities: z.array(z.string()),
  })
  .strict()

const rawSimulatedAutosaveExtractionSchema = z
  .object({
    memories: z.array(rawExtractedBenchMemorySchema).max(8),
  })
  .strict()

export function buildSimulatedAutosaveExtractionRequest(input: {
  extractionPrompt: string
  transcript: string
  model?: string
  maxTokens?: number
  tagVocabulary?: readonly string[]
}): Parameters<BenchExtractionClient["complete"]>[0] {
  return {
    model: input.model ?? SIMULATED_AUTOSAVE_EXTRACTION_MODEL,
    messages: [
      { role: "system", content: input.extractionPrompt },
      { role: "user", content: input.transcript },
    ],
    temperature: SIMULATED_AUTOSAVE_EXTRACTION_TEMPERATURE,
    max_tokens: input.maxTokens ?? SIMULATED_AUTOSAVE_EXTRACTION_MAX_TOKENS,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "longmemeval_simulated_autosave",
        strict: true,
        schema: buildSimulatedAutosaveExtractionSchema(input.tagVocabulary),
      },
    },
  }
}

export class FetchBenchExtractionClient implements BenchExtractionClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string = "https://api.openai.com/v1",
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms))
  ) {}

  async complete(
    input: Parameters<BenchExtractionClient["complete"]>[0]
  ): Promise<Awaited<ReturnType<BenchExtractionClient["complete"]>>> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(input),
      })
      if (isRetryableStatus(response.status) && attempt < 2) {
        await this.sleep(retryDelayMs(response, attempt))
        continue
      }
      if (!response.ok) {
        throw new Error(
          `OpenAI extraction failed: HTTP ${response.status} ${response.statusText}`
        )
      }
      let json: {
        choices?: Array<{
          finish_reason?: string | null
          message?: { content?: string | null; refusal?: string | null }
        }>
        usage?: {
          prompt_tokens?: number
          completion_tokens?: number
          prompt_tokens_details?: { cached_tokens?: number }
        }
      }
      try {
        json = (await response.json()) as typeof json
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        throw new Error(`OpenAI extraction returned malformed JSON: ${message}`, {
          cause: err,
        })
      }
      const choice = json.choices?.[0]
      return {
        content:
          typeof choice?.message?.content === "string" ? choice.message.content : null,
        finishReason:
          typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
        refusal:
          typeof choice?.message?.refusal === "string" ? choice.message.refusal : null,
        usage: {
          promptTokens: json.usage?.prompt_tokens ?? 0,
          cachedPromptTokens: json.usage?.prompt_tokens_details?.cached_tokens ?? 0,
          completionTokens: json.usage?.completion_tokens ?? 0,
        },
      }
    }
    throw new Error("OpenAI extraction retry loop exhausted")
  }
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599)
}

function retryDelayMs(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after")
  if (retryAfter) {
    const seconds = Number.parseFloat(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 10_000)
    }
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) {
      return Math.min(Math.max(0, date - Date.now()), 10_000)
    }
  }
  return Math.min(250 * 2 ** attempt, 2_000)
}

export async function extractSimulatedAutosaveMemories(input: {
  client: BenchExtractionClient
  extractionPrompt: string
  transcript: string
  model?: string
  maxTokens?: number
  tagVocabulary?: readonly string[]
}): Promise<ExtractSimulatedAutosaveMemoriesResult> {
  let usage = zeroExtractionUsage()
  let lastFailure = "unknown extraction failure"
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let completion: Awaited<ReturnType<BenchExtractionClient["complete"]>>
    try {
      const extractionPrompt =
        attempt === 0
          ? input.extractionPrompt
          : buildCompactRetryExtractionPrompt(input.extractionPrompt)
      completion = await input.client.complete(
        buildSimulatedAutosaveExtractionRequest({
          extractionPrompt,
          transcript: input.transcript,
          model: input.model,
          maxTokens: input.maxTokens,
          tagVocabulary: input.tagVocabulary,
        })
      )
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new SimulatedAutosaveExtractionError(message, usage)
    }
    usage = addExtractionUsage(usage, completion.usage)

    const preParseFailure = completionFailure(completion)
    if (preParseFailure) {
      lastFailure = preParseFailure
      continue
    }

    const parsed = parseSimulatedAutosaveExtraction(completion.content)
    if (parsed.success) {
      return {
        raw: parsed.data,
        usage,
      }
    }
    lastFailure = parsed.error
  }
  throw new SimulatedAutosaveExtractionError(
    `Simulated-autosave extraction failed: ${lastFailure}`,
    usage
  )
}

function buildCompactRetryExtractionPrompt(extractionPrompt: string): string {
  return [
    extractionPrompt.trimEnd(),
    "",
    [
      "Retry constraint: the previous extraction exceeded the response budget",
      "or failed validation. Return a more compact JSON response: prefer one",
      "memory record, use at most two records only when the session has",
      "clearly separate topics, and keep each content field concise while",
      "preserving substantive facts.",
    ].join(" "),
  ].join("\n")
}

function completionFailure(input: {
  content: string | null
  finishReason: string | null
  refusal: string | null
}): string | null {
  if (input.finishReason === "length") return "model hit max_tokens"
  if (input.refusal && input.refusal.trim().length > 0) {
    return "model refused the extraction request"
  }
  if (input.content === null || input.content.trim().length === 0) {
    return "model returned no extraction content"
  }
  return null
}

function parseSimulatedAutosaveExtraction(
  content: string | null
):
  | { success: true; data: RawSimulatedAutosaveExtraction }
  | { success: false; error: string } {
  if (content === null) return { success: false, error: "missing content" }
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return { success: false, error: "malformed extraction JSON" }
  }
  const result = rawSimulatedAutosaveExtractionSchema.safeParse(parsed)
  if (!result.success) {
    return { success: false, error: "schema validation failed" }
  }
  return { success: true, data: result.data }
}

export function normalizeSimulatedAutosaveMemories(input: {
  raw: RawSimulatedAutosaveExtraction
  projectId: string
  sessionId: string
  tagVocabulary?: readonly string[]
}): SimulatedAutosaveMemoryPlan[] {
  return input.raw.memories
    .map((memory) =>
      normalizeSimulatedAutosaveMemory({
        memory,
        projectId: input.projectId,
        sessionId: input.sessionId,
        tagVocabulary: input.tagVocabulary,
      })
    )
    .filter((memory): memory is SimulatedAutosaveMemoryPlan => memory !== null)
}

function normalizeSimulatedAutosaveMemory(input: {
  memory: RawExtractedBenchMemory
  projectId: string
  sessionId: string
  tagVocabulary?: readonly string[]
}): SimulatedAutosaveMemoryPlan | null {
  const title = capString(cleanText(input.memory.title), 80)
  const content = cleanText(input.memory.content)
  if (title.length === 0 || content.length === 0) return null

  const synopsis = capString(
    cleanText(input.memory.synopsis),
    DEFAULT_MEMORY_SYNOPSIS_MAX
  )
  const { tags, invalidTags } = normalizeTags(
    input.memory.tags,
    input.tagVocabulary ?? TAG_VOCABULARY
  )
  const mentionEntities = normalizeEntities(input.memory.entities)
  const keywords = capString(
    normalizeKeywordString([input.memory.keywords, ...mentionEntities, ...invalidTags]),
    RICH_TEXT_PROPERTY_MAX_LEN
  )

  return {
    createInput: {
      title,
      content,
      projectIds: [input.projectId],
      source: "conversation",
      kind: "note",
      confidence: "likely",
      tags,
      keywords,
      synopsis,
      session: input.sessionId,
      agent: "bench-simulated-autosave",
      autosaveLearningDedupScope: "off",
    },
    mentionEntities,
  }
}

function normalizeTags(
  tags: string[],
  vocabulary: readonly string[]
): { tags: string[]; invalidTags: string[] } {
  const vocab = new Set<string>(vocabulary)
  const seenTags = new Set<string>()
  const seenInvalid = new Set<string>()
  const out: string[] = []
  const invalid: string[] = []
  for (const tag of tags) {
    const normalized = cleanText(tag).toLowerCase()
    if (normalized.length === 0) continue
    if (vocab.has(normalized)) {
      if (!seenTags.has(normalized)) {
        seenTags.add(normalized)
        out.push(normalized)
      }
    } else if (!seenInvalid.has(normalized)) {
      seenInvalid.add(normalized)
      invalid.push(normalized)
    }
  }
  return { tags: out, invalidTags: invalid }
}

function normalizeEntities(entities: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const entity of entities) {
    const normalized = cleanText(entity)
    if (normalized.length === 0 || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= MAX_AUTO_MENTION_ENTITIES) break
  }
  return out
}

function normalizeKeywordString(parts: string[]): string {
  return parts.map(cleanText).filter(Boolean).join(" ").replace(/\s+/g, " ").trim()
}

function cleanText(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

function capString(value: string, max: number): string {
  return value.length <= max ? value : value.slice(0, max)
}
