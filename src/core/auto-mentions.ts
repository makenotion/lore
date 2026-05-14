import { decodeTextEntities } from "../notion/html-entities.js"
import type { CreateFactInput, Memory } from "../types.js"
import { memoryScopeToInput } from "../types.js"
import type { CreateFactResult } from "./fact.js"
import { extractEntityCandidates } from "./near-duplicate.js"

export const MAX_AUTO_MENTION_ENTITIES = 25

export const SIMULATED_AUTOSAVE_MAX_MUTATIONS_PER_MEMORY = 2 + MAX_AUTO_MENTION_ENTITIES

export interface FactServiceLike {
  createBatchWithDedup(
    inputs: CreateFactInput[]
  ): Promise<PromiseSettledResult<CreateFactResult>[]>
}

export interface EmitAutoMentionsInput {
  facts: FactServiceLike
  memory: Memory
  extraEntities?: string[]
  maxEntities?: number
  disabled?: boolean
  onError?: (entity: string, error: unknown) => void
}

export interface EmitAutoMentionsResult {
  attempted: number
  fulfilled: number
  freshCreated: number
  notionMutationCount: number
}

const EMPTY_RESULT: EmitAutoMentionsResult = {
  attempted: 0,
  fulfilled: 0,
  freshCreated: 0,
  notionMutationCount: 0,
}

function normalizeMentionEntity(value: string): string {
  return decodeTextEntities(value).trim().replace(/\s+/g, " ")
}

export function buildAutoMentionEntities(input: {
  memory: Pick<Memory, "title" | "keywords" | "synopsis">
  extraEntities?: string[]
  maxEntities?: number
}): string[] {
  const maxEntities = input.maxEntities ?? MAX_AUTO_MENTION_ENTITIES
  if (maxEntities <= 0) return []
  const raw = [
    ...extractEntityCandidates(
      input.memory.title,
      input.memory.keywords,
      input.memory.synopsis
    ),
    ...(input.extraEntities ?? []),
  ]
  const seen = new Set<string>()
  const out: string[] = []
  for (const candidate of raw) {
    const normalized = normalizeMentionEntity(candidate)
    if (normalized.length === 0 || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= maxEntities) break
  }
  return out
}

export async function emitAutoMentions(
  input: EmitAutoMentionsInput
): Promise<EmitAutoMentionsResult> {
  if (input.disabled || process.env["LORE_DISABLE_AUTO_MENTIONS"] === "1") {
    return { ...EMPTY_RESULT }
  }

  const mentionedEntities = buildAutoMentionEntities({
    memory: input.memory,
    extraEntities: input.extraEntities,
    maxEntities: input.maxEntities,
  })
  if (mentionedEntities.length === 0) return { ...EMPTY_RESULT }

  const projectIds =
    input.memory.projectIds.length > 0 ? input.memory.projectIds : undefined
  const factScope = memoryScopeToInput(input.memory.scope)
  const settled = await input.facts.createBatchWithDedup(
    mentionedEntities.map((entity) => ({
      subject: input.memory.title,
      predicate: "mentions",
      object: entity,
      sourceMemoryId: input.memory.id,
      projectIds,
      confidence: "speculative",
      scope: factScope,
    }))
  )

  let fulfilled = 0
  let freshCreated = 0
  for (let i = 0; i < settled.length; i += 1) {
    const result = settled[i]!
    if (result.status === "fulfilled") {
      fulfilled += 1
      if (result.value.deduped === false) freshCreated += 1
    } else {
      input.onError?.(mentionedEntities[i]!, result.reason)
    }
  }

  return {
    attempted: mentionedEntities.length,
    fulfilled,
    freshCreated,
    notionMutationCount: freshCreated,
  }
}
