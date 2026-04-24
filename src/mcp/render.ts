/**
 * Shared rendering helpers for MCP tool output.
 *
 * Facts, decisions, and memories cross-reference each other by Notion
 * page ID. Rendering those IDs raw is opaque to a reader — this module
 * batches referenced IDs, resolves them to titles via a caller-supplied
 * loader, and produces a per-fact renderer that substitutes titles when
 * it has them and falls back to a short hinted suffix when it doesn't.
 *
 * Every lookup path should use `MemoryService.getTitleById` (or an
 * equivalent index-tier loader) — never `getById`, which pulls the full
 * markdown body. A wake-up rendering 25 Active Facts must not fan out
 * to 25+ body fetches just to read a Title property.
 */

import { TRACKING_PREDICATES } from "../types.js"
import type { Fact, FactPredicate, Memory } from "../types.js"

/**
 * Notion page IDs are canonical 8-4-4-4-12 hex UUIDs. The SDK emits
 * lowercase, but we match case-insensitively so a stray uppercase value
 * from a migrated row still resolves. All keys are normalized to
 * lowercase before going into the title map.
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

/**
 * Minimal service surface the facts-side resolver needs. A title-only
 * loader — no markdown body — so a render pass costs exactly one Notion
 * round-trip per unique referenced ID.
 */
export interface TitleResolvers {
  memories: { getTitleById(id: string): Promise<string | null> }
}

/**
 * Batch-resolve titles for the given IDs using the provided loader.
 * Dedupes and normalizes to lowercase before issuing the fan-out so a
 * mixed-case set of references still collapses to one request per
 * distinct page. Unresolved IDs (loader returned `null`) are dropped —
 * callers should render them via `displayId` to get the `(?)` fallback.
 *
 * This is the shared primitive. Callers with a `Fact[]` should use
 * `resolveReferencedTitles`; callers with a bare `string[]` (e.g., the
 * `Supersedes` / `Affects` ID lists on a Decision) should use this
 * directly with a kind-specific loader.
 */
export async function resolveTitles(
  ids: readonly string[],
  loader: (id: string) => Promise<string | null>,
): Promise<Map<string, string>> {
  const unique = new Set<string>()
  for (const id of ids) {
    if (!id) continue
    unique.add(id.toLowerCase())
  }
  if (unique.size === 0) return new Map()

  const entries = await Promise.all(
    Array.from(unique).map(async (id) => {
      const title = await loader(id)
      return title ? ([id, title] as const) : null
    }),
  )

  return new Map(
    entries.filter((entry): entry is readonly [string, string] => entry !== null),
  )
}

/**
 * Convenience for the common case: scan a `Fact[]` for UUID-shaped
 * subject/object values and resolve them via `services.memories.getTitleById`.
 * Every MCP read tool that renders facts should pass its fact list
 * through this before calling `renderFact`.
 */
export async function resolveReferencedTitles(
  facts: readonly Fact[],
  services: TitleResolvers,
): Promise<Map<string, string>> {
  const ids: string[] = []
  for (const fact of facts) {
    if (isUuid(fact.subject)) ids.push(fact.subject)
    if (isUuid(fact.object)) ids.push(fact.object)
  }
  return resolveTitles(ids, (id) => services.memories.getTitleById(id))
}

/**
 * Format a single fact line with title substitution. UUIDs that resolve
 * render as their title; UUIDs that don't render as a short hint
 * (`…last8 (?)`) so the reader still has a traceable anchor without
 * 36 characters of random hex cluttering the output. Non-UUID values
 * render verbatim.
 *
 * `trailing` is appended space-prefixed after the core triple so callers
 * can attach confidence, validity window, review hints, or a multi-line
 * ID footer without re-implementing the subject/object substitution.
 *
 * `prefix` is inserted between the leading `- ` bullet and the subject.
 * Used by `lore-ask`'s grouped display (P2-06) to surface a `⚠ ` marker
 * on overdue tracking facts without reimplementing the triple rendering.
 */
export interface RenderFactOptions {
  titleMap: Map<string, string>
  /** Inserted between the `- ` bullet and `**Subject**`. */
  prefix?: string
  /** Appended after the core "Subject predicate Object" segment, space-prefixed. */
  trailing?: string
}

export function renderFact(fact: Fact, options: RenderFactOptions): string {
  const subject = displayValue(fact.subject, options.titleMap)
  const object = displayValue(fact.object, options.titleMap)
  const predicate = fact.predicate.replace(/_/g, " ")
  const prefix = options.prefix ?? ""
  const suffix = options.trailing ? ` ${options.trailing}` : ""
  return `- ${prefix}**${subject}** ${predicate} **${object}**${suffix}`
}

/**
 * Format a single ID as its resolved title (when known) or a short
 * unresolved-hint that preserves enough of the UUID to trace back
 * without dumping the whole string inline. Exposed so callers rendering
 * non-fact structures (e.g., `lore-get-decision`'s Supersedes section)
 * share the same lookup discipline as `renderFact`.
 */
export function displayId(
  id: string,
  titleMap: Map<string, string>,
): string {
  const title = titleMap.get(id.toLowerCase())
  return title ?? unresolvedHint(id)
}

/**
 * UUID-aware value rendering: looks up a UUID through the title map
 * (with unresolved-hint fallback) and returns plain strings verbatim.
 * Shared by `renderFact` and call sites that need per-side substitution
 * inside a non-standard line format (e.g., wake-up's Open Loops arrows).
 */
export function displayValue(
  value: string,
  titleMap: Map<string, string>,
): string {
  if (!isUuid(value)) return value
  return displayId(value, titleMap)
}

/**
 * Trim a UUID down to its last 8 hex chars for the unresolved fallback.
 * 36 characters of random hex in a bulleted list is visual noise — the
 * tail is enough to disambiguate nearby rows, and a caller who needs
 * the full ID can still look it up on the facts/decisions row itself.
 */
function unresolvedHint(id: string): string {
  const normalized = id.toLowerCase()
  if (!isUuid(normalized)) return `${id} (?)`
  return `…${normalized.slice(-8)} (?)`
}

/**
 * Predicate classification for the grouped-display taxonomy used by
 * `lore-ask` (P2-06):
 *
 * - `governance` — decision-graph edges (`decided_by`, `supersedes_decision`)
 *   that answer "what decisions govern this?"
 * - `tracking` — open loops (`needs_action`, `waiting_on`, `blocked_by`)
 *   that answer "what is pending on this?"
 * - `structure` — everything else (type, composition, causation, dependency,
 *   ownership) — the default bucket.
 *
 * Unknown predicates fall through to `structure` so a predicate added
 * server-side still renders in *some* bucket instead of disappearing.
 * Kept in `render.ts` so other read tools (future wake-up top-k sections,
 * P2-07 ranked open-loops) can reuse the same taxonomy without
 * duplicating predicate lists.
 */
export type FactClass = "governance" | "structure" | "tracking"

const GOVERNANCE_PREDICATES: ReadonlySet<FactPredicate> = new Set<FactPredicate>([
  "decided_by",
  "supersedes_decision",
])

// Derived from the canonical `TRACKING_PREDICATES` export so a new tracking
// predicate added to the `FactPredicate` union flows through here without a
// second-copy update. `TRACKING_PREDICATES` already has several consumers
// (`core/fact.ts`, `core/wakeup.ts`, `mcp/tools/digest.ts`, etc.) — keep this
// set in lockstep with the rest of the codebase rather than maintaining a
// local literal.
const TRACKING_PREDICATE_SET: ReadonlySet<FactPredicate> = new Set(TRACKING_PREDICATES)

export function factClass(predicate: FactPredicate): FactClass {
  if (GOVERNANCE_PREDICATES.has(predicate)) return "governance"
  if (TRACKING_PREDICATE_SET.has(predicate)) return "tracking"
  return "structure"
}

export interface GroupedFacts {
  governance: Fact[]
  structure: Fact[]
  tracking: Fact[]
}

/**
 * Group facts into the three `FactClass` buckets and sort each one
 * most-recent-first by `validFrom`. Facts without a `validFrom` sink to
 * the end so newer rows surface above legacy entries that predate the
 * column.
 *
 * Sort is stable within a `validFrom` tie — the grouped output preserves
 * the caller's input order for rows stamped on the same day, which keeps
 * downstream renderers (e.g., the decision-first ordering after
 * `resolveCanonicalDecisionLinks` dedupes) deterministic.
 */
export function groupFactsByClass(facts: readonly Fact[]): GroupedFacts {
  const groups: GroupedFacts = { governance: [], structure: [], tracking: [] }
  for (const fact of facts) {
    groups[factClass(fact.predicate)].push(fact)
  }
  const compare = (a: Fact, b: Fact): number => {
    if (a.validFrom === b.validFrom) return 0
    if (!a.validFrom) return 1
    if (!b.validFrom) return -1
    return a.validFrom < b.validFrom ? 1 : -1
  }
  groups.governance.sort(compare)
  groups.structure.sort(compare)
  groups.tracking.sort(compare)
  return groups
}

/**
 * Default title-token Jaccard threshold for topical dedup. ≥ 0.5 means
 * more than half the distinct tokens in the shorter title appear in the
 * other — enough to flag "same topic, different phrasing" without
 * collapsing unrelated memories that share a couple of generic tokens.
 * Kept file-local until a second call-site emerges: callers with a
 * different tuning should pass `titleJaccardThreshold` through
 * `CollapseOverlappingOptions`, not take a hard dependency on the
 * constant.
 */
const DEFAULT_TITLE_JACCARD_THRESHOLD = 0.5
/**
 * Default tag-set overlap threshold (Szymkiewicz-Simpson). A memory whose
 * smaller tag set is at least half-covered by another's is almost always
 * the same topic — this heuristic complements title-token Jaccard for
 * cases where agents retitle but tag consistently.
 */
const DEFAULT_TAG_OVERLAP_THRESHOLD = 0.5
/** Tokens shorter than this are dropped as too noisy to disambiguate. */
const MIN_TITLE_TOKEN_LENGTH = 3

/**
 * Rendering descriptor for one deduped memory group. `keep` is the
 * newest memory in the cluster (preserved in-place in the caller's
 * sort order); `collapsedIds` are the remaining memories in newest-
 * first order so the renderer can stitch an "(related: …)" trailer.
 */
export interface CollapsedMemoryGroup {
  keep: Memory
  collapsedIds: string[]
}

/**
 * Collapse topically overlapping memories into one representative per
 * cluster. The first memory in caller-supplied order wins its cluster;
 * subsequent memories that pass the similarity threshold are attached
 * as `collapsedIds`. Memories that match nothing preserved above form
 * their own single-member cluster. Callers that want "newest wins"
 * sort descending by createdAt before calling.
 *
 * Similarity is the OR of two fast heuristics:
 *   - Title-token Jaccard ≥ `titleJaccardThreshold` — same topic, any
 *     phrasing. Uses lowercased alphanumeric tokens with short fragments
 *     dropped so stopwords don't inflate overlap.
 *   - Tag-set overlap (Szymkiewicz-Simpson) ≥ `tagOverlapThreshold` —
 *     agents often retitle across sessions but keep tags stable, so tag
 *     overlap catches clusters the title heuristic would miss.
 *
 * The spec errs toward showing — thresholds are high enough that
 * distinct memories rarely collapse, and a hidden nuance can still be
 * fetched via `lore-expand` / `lore-recall`.
 *
 * **Input-size budget: N ≤ 50.** The cluster-comparison loop is
 * O(N · K) with K = cluster count, and in the degenerate case where
 * every memory opens a new cluster the pass is O(N²). Wake-up's
 * over-fetched memory sections sit well inside that budget (recent
 * cap × 3 ≈ 30, related cap × 3 ≈ 15). A caller planning to pass
 * hundreds of rows should batch or move the dedup closer to storage.
 */
export interface CollapseOverlappingOptions {
  titleJaccardThreshold?: number
  tagOverlapThreshold?: number
}

export function collapseOverlappingMemories(
  memories: readonly Memory[],
  options: CollapseOverlappingOptions = {},
): CollapsedMemoryGroup[] {
  const titleThreshold = options.titleJaccardThreshold ?? DEFAULT_TITLE_JACCARD_THRESHOLD
  const tagThreshold = options.tagOverlapThreshold ?? DEFAULT_TAG_OVERLAP_THRESHOLD
  // Each cluster caches its representative's signature inline so the
  // comparison loop stays O(N·M) in set ops. Recomputing tokens per
  // comparison — or rescanning the signatures array to locate a group's
  // signature — would degrade to O(N·M·|title|) or O(N·M·N).
  const clusters: Array<{ group: CollapsedMemoryGroup; signature: MemorySignature }> = []

  for (const memory of memories) {
    const signature: MemorySignature = {
      memory,
      titleTokens: titleTokens(memory.title),
      tagSet: new Set(memory.tags.map((tag) => tag.toLowerCase())),
    }

    let attached = false
    for (const cluster of clusters) {
      if (areTopicallySimilar(signature, cluster.signature, titleThreshold, tagThreshold)) {
        cluster.group.collapsedIds.push(memory.id)
        attached = true
        break
      }
    }
    if (!attached) {
      clusters.push({
        group: { keep: memory, collapsedIds: [] },
        signature,
      })
    }
  }

  return clusters.map((c) => c.group)
}

interface MemorySignature {
  memory: Memory
  titleTokens: Set<string>
  tagSet: Set<string>
}

function areTopicallySimilar(
  a: MemorySignature,
  b: MemorySignature,
  titleThreshold: number,
  tagThreshold: number,
): boolean {
  if (jaccard(a.titleTokens, b.titleTokens) >= titleThreshold) return true
  // Szymkiewicz-Simpson: biases toward "one set is a subset of the
  // other", which matches how agents tag the same topic with slightly
  // different breadth across sessions. Jaccard would penalize the
  // larger set for carrying extra tags, and Dice would split the
  // difference — neither reflects the actual pattern we're catching.
  return overlapCoefficient(a.tagSet, b.tagSet) >= tagThreshold
}

function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>()
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/u)) {
    if (raw.length >= MIN_TITLE_TOKEN_LENGTH) tokens.add(raw)
  }
  return tokens
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const value of a) if (b.has(value)) shared += 1
  const union = a.size + b.size - shared
  return union === 0 ? 0 : shared / union
}

function overlapCoefficient(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0
  let shared = 0
  for (const value of a) if (b.has(value)) shared += 1
  return shared / Math.min(a.size, b.size)
}
