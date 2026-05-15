import type { Client, PageObjectResponse, UpdatePageParameters } from "@notionhq/client"
import type { Fact } from "../types.js"
import { FACT_PROPS } from "../notion/schema.js"
import { extractMissingPropertyName, isMissingPropertyError } from "../notion/errors.js"
import { isFullPage } from "../notion/extractors.js"
import { withEntityRelationLocks } from "./entity-relation-lock.js"
import {
  decayConfidenceScore,
  decrementConfidenceScore,
  seedConfidenceScore,
} from "./decay.js"
import { todayUtc } from "./task.js"
import { readFactCreatedAt, type FactPageToFact } from "./fact-maintenance.js"

export interface FactInvalidateOptions {
  /**
   * Memory id that prompted the invalidation. Written to the `Invalidated By`
   * relation column alongside `Invalidated At`.
   */
  sourceMemoryId?: string
}

/**
 * Once-per-process stderr warning when a fact invalidate drops a missing
 * column on retry.
 */
const invalidateMissingColumnWarned = new Set<string>()
function warnInvalidateMissingColumnOnce(propertyName: string | null): void {
  const key = propertyName ?? "<unparsed>"
  if (invalidateMissingColumnWarned.has(key)) return
  invalidateMissingColumnWarned.add(key)
  if (propertyName === null) {
    process.stderr.write(
      "[lore] fact-invalidate: vault schema lacks at least one of the " +
        "Issue #284 transaction-time columns (Invalidated At / Invalidated " +
        "By) or DEFERRED-02 columns (Confidence Score / Last Referenced " +
        "At); falling back to a bare `Valid Until` write. Run `lore migrate" +
        " --backfill-fact-observed-at` and `lore migrate --build-fact-" +
        "confidence-scores` to seed the missing columns.\n"
    )
    return
  }
  const hint =
    propertyName === "Invalidated At" || propertyName === "Invalidated By"
      ? "Run `lore migrate --backfill-fact-observed-at` to seed transaction-time columns."
      : propertyName === "Confidence Score" || propertyName === "Last Referenced At"
        ? "Run `lore migrate --build-fact-confidence-scores` to seed DEFERRED-02 columns."
        : "Run `lore migrate` to add the missing column."
  process.stderr.write(
    `[lore] fact-invalidate: vault schema lacks \`${propertyName}\`; ` +
      `dropping that column from the invalidate write. ${hint}\n`
  )
}

/** Reset between tests. Not exported on the public API surface. */
export function __resetInvalidateMissingColumnWarningForTests(): void {
  invalidateMissingColumnWarned.clear()
}

export class FactInvalidation {
  constructor(
    private client: Client,
    private readonly pageToFact: FactPageToFact
  ) {}

  async invalidate(id: string, opts: FactInvalidateOptions = {}): Promise<void> {
    return withEntityRelationLocks([id], () => this.invalidateLocked(id, opts))
  }

  async invalidateLocked(id: string, opts: FactInvalidateOptions = {}): Promise<void> {
    const today = todayUtc()
    let page: PageObjectResponse | null = null
    try {
      const retrieved = await this.client.pages.retrieve({ page_id: id })
      if (isFullPage(retrieved)) {
        page = retrieved
      }
    } catch {
      // The read failed but the invalidate write must still happen.
      // The confidence decrement is best-effort.
    }

    if (page !== null && page.archived) {
      return
    }

    let fact: Fact | null = null
    if (page !== null) {
      try {
        fact = await this.pageToFact(page)
      } catch {
        fact = null
      }
    }

    const properties: Record<string, unknown> = {
      [FACT_PROPS.VALID_UNTIL]: { date: { start: today } },
      [FACT_PROPS.INVALIDATED_AT]: { date: { start: today } },
    }
    if (opts.sourceMemoryId) {
      properties[FACT_PROPS.INVALIDATED_BY] = {
        relation: [{ id: opts.sourceMemoryId }],
      }
    }

    if (fact !== null) {
      // Realize lazy decay before decrementing so invalidation before
      // and after the confidence-score migration converges on the same score.
      let current: number
      if (fact.confidenceScore == null) {
        const seeded = seedConfidenceScore(fact.confidence)
        current = decayConfidenceScore(
          seeded,
          readFactCreatedAt(fact, "invalidate").slice(0, 10),
          today
        )
      } else {
        current = decayConfidenceScore(
          fact.confidenceScore,
          fact.lastReferencedAt ?? null,
          today
        )
      }
      const next = decrementConfidenceScore(current)
      properties[FACT_PROPS.CONFIDENCE_SCORE] = { number: next }
      properties[FACT_PROPS.LAST_REFERENCED_AT] = { date: { start: today } }
    }

    // Drop only the missing optional property on partially migrated vaults.
    // The final fallback still writes `Valid Until`, preserving the
    // invalidation contract when Notion cannot name the missing column.
    const MAX_OPTIONAL_DROPS = 4
    for (let attempt = 0; attempt <= MAX_OPTIONAL_DROPS; attempt += 1) {
      try {
        await this.client.pages.update({
          page_id: id,
          properties: properties as UpdatePageParameters["properties"],
        })
        return
      } catch (err) {
        if (!isMissingPropertyError(err)) throw err
        const missing = extractMissingPropertyName(err)
        if (missing && missing in properties) {
          warnInvalidateMissingColumnOnce(missing)
          delete properties[missing]
          if (Object.keys(properties).length === 0) throw err
          continue
        }
        warnInvalidateMissingColumnOnce(null)
        await this.client.pages.update({
          page_id: id,
          properties: {
            [FACT_PROPS.VALID_UNTIL]: { date: { start: today } },
          },
        })
        return
      }
    }

    warnInvalidateMissingColumnOnce(null)
    await this.client.pages.update({
      page_id: id,
      properties: {
        [FACT_PROPS.VALID_UNTIL]: { date: { start: today } },
      },
    })
  }
}
