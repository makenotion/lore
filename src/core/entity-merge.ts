import type { Entity } from "../types.js"
import { normalizeEntityKey, type EntityService } from "./entity.js"
import {
  normalizeEntityRelationLockKey,
  withEntityRelationLocks,
} from "./entity-relation-lock.js"
import type { FactEntityRepointResult, FactService } from "./fact.js"
import { todayUtc } from "./task.js"

export type EntityMergeErrorPhase = "repoint" | "aliases" | "archive"

export interface EntityMergeError {
  phase: EntityMergeErrorPhase
  message: string
  factId?: string
}

export interface EntityMergeOptions {
  winnerId: string
  loserId: string
  apply: boolean
  dryRun?: boolean
  today?: string
}

export interface EntityMergeResult {
  winner: Entity
  loser: Entity
  aliasesToAdd: string[]
  aliasesPlanned: number
  aliasesAdded: number
  repoint: FactEntityRepointResult
  postArchiveRepoint: FactEntityRepointResult | null
  loserArchived: boolean
  errors: EntityMergeError[]
  planOnly: boolean
}

export function aliasesForEntityMerge(winner: Entity, loser: Entity): string[] {
  const seen = new Set<string>()
  const aliases: string[] = []

  const remember = (value: string | undefined): void => {
    const key = normalizeEntityKey(value ?? "")
    if (key) seen.add(key)
  }
  remember(winner.name)
  for (const alias of winner.aliases) remember(alias)

  const addIfFresh = (value: string): void => {
    const trimmed = value.trim()
    const key = normalizeEntityKey(trimmed)
    if (!key || seen.has(key)) return
    seen.add(key)
    aliases.push(trimmed)
  }

  addIfFresh(loser.name)
  for (const alias of loser.aliases) addIfFresh(alias)

  return aliases
}

/**
 * Orchestrate a safe Entity merge. The loser is archived only after every
 * fact relation has successfully moved to the winner and the winner has
 * absorbed the loser's lookup forms as aliases. This is a single-hop merge:
 * the winner must be an active Entity row. The loser may already be archived
 * when retrying a partial merge; aliases and fact repoints remain idempotent.
 */
export async function mergeEntities(
  entities: EntityService,
  facts: FactService,
  options: EntityMergeOptions
): Promise<EntityMergeResult> {
  if (!options.winnerId) {
    throw new Error("mergeEntities: winnerId is required")
  }
  if (!options.loserId) {
    throw new Error("mergeEntities: loserId is required")
  }
  if (
    normalizeEntityRelationLockKey(options.winnerId) ===
    normalizeEntityRelationLockKey(options.loserId)
  ) {
    throw new Error("mergeEntities: winnerId and loserId must differ")
  }

  const planOnly = !options.apply || options.dryRun === true

  if (planOnly) {
    const [winner, loser] = await Promise.all([
      entities.getById(options.winnerId),
      entities.getById(options.loserId, { includeArchived: true }),
    ])
    const aliasesToAdd = aliasesForEntityMerge(winner, loser)
    const repoint = await facts.repointEntity({
      fromEntityId: loser.id,
      toEntityId: winner.id,
      apply: false,
      includeInvalidated: true,
    })
    return {
      winner,
      loser,
      aliasesToAdd,
      aliasesPlanned: aliasesToAdd.length,
      aliasesAdded: 0,
      repoint,
      postArchiveRepoint: null,
      loserArchived: false,
      errors: repoint.errors.map((error) => ({
        phase: "repoint",
        factId: error.factId,
        message: error.message,
      })),
      planOnly,
    }
  }

  return withEntityRelationLocks([options.winnerId, options.loserId], async () => {
    const [winner, loser] = await Promise.all([
      entities.getById(options.winnerId),
      entities.getById(options.loserId, { includeArchived: true }),
    ])
    const aliasesToAdd = aliasesForEntityMerge(winner, loser)
    const runRepoint = (): Promise<FactEntityRepointResult> =>
      facts.repointEntity({
        fromEntityId: loser.id,
        toEntityId: winner.id,
        apply: true,
        includeInvalidated: true,
      })

    const repoint = await runRepoint()

    const result: EntityMergeResult = {
      winner,
      loser,
      aliasesToAdd,
      aliasesPlanned: aliasesToAdd.length,
      aliasesAdded: 0,
      repoint,
      postArchiveRepoint: null,
      loserArchived: false,
      errors: repoint.errors.map((error) => ({
        phase: "repoint",
        factId: error.factId,
        message: error.message,
      })),
      planOnly,
    }

    if (result.errors.length > 0) {
      return result
    }

    try {
      if (aliasesToAdd.length > 0) {
        await entities.addAliases(winner.id, aliasesToAdd)
      }
      result.aliasesAdded = aliasesToAdd.length
    } catch (err) {
      result.errors.push({
        phase: "aliases",
        message: err instanceof Error ? err.message : String(err),
      })
      return result
    }

    try {
      await entities.archive(loser, {
        mergedInto: winner,
        mergedAt: options.today ?? todayUtc(),
      })
      result.loserArchived = true
    } catch (err) {
      result.errors.push({
        phase: "archive",
        message: err instanceof Error ? err.message : String(err),
      })
      return result
    }

    try {
      const postArchiveRepoint = await runRepoint()
      result.postArchiveRepoint = postArchiveRepoint
      result.errors.push(
        ...postArchiveRepoint.errors.map((error) => ({
          phase: "repoint" as const,
          factId: error.factId,
          message: error.message,
        }))
      )
    } catch (err) {
      result.errors.push({
        phase: "repoint",
        message:
          "post-archive scan failed: " +
          (err instanceof Error ? err.message : String(err)),
      })
    }

    return result
  })
}
