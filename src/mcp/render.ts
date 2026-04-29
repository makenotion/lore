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

import type {
  Fact,
  FactPredicate,
  Memory,
  MemoryKind,
  MemorySource,
  MemoryStatus,
} from "../types.js"
import { SYNOPSIS_MAX } from "../types.js"

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
 * `prefix` is inserted between the leading `- ` bullet and the subject
 * — kept for callers that want to attach a marker (e.g. `⚠ `) without
 * re-implementing the triple rendering.
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
 * non-fact structures (e.g., `lore-decision action='get'`'s Supersedes section)
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
 * inside a non-standard line format.
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
 * Structural subtype documenting the field set `formatMemoryListItem`
 * actually reads. Using a structural subtype (rather than `Memory`) means
 * `DecisionSummary` and `TaskSummary` — the body-less projections, see
 * naming note in `0.7.0/README.md` — can be passed without an unsafe
 * cast. The fields cover what every meta-builder used by the recall /
 * search / wake-up surfaces needs: source / kind / status / tags /
 * dates for recall/search, source / tags / date for wake-up Recent
 * Memories, and id for diagnostic paths.
 */
export interface MemoryListItem {
  id: string
  title: string
  synopsis: string
  source: MemorySource
  kind: MemoryKind
  status: MemoryStatus
  tags: string[]
  createdAt: string
  updatedAt: string
}

export interface FormatMemoryListItemOptions {
  /** When false, suppress synopsis even on rows that have one. Default: true. */
  includeSynopsis?: boolean
  /**
   * Heading level (number of leading `#`). Defaults to 3 — recall,
   * search, and wake-up's Related / For-Your-Current-Task all use `###`.
   * Wake-up Recent Memories sits under date-bucket `### Today`
   * sub-heads and passes 4 to keep the markdown tree balanced.
   */
  headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  /**
   * How to render the italic metadata line. Either:
   * - a `(memory) => string | null` builder — call it with the row and
   *   wrap the returned string in asterisks; `null` skips the meta line
   *   entirely.
   * - a literal string — wrapped in asterisks verbatim.
   *
   * Recall/search pass a builder that emits the
   * `[source, kind (when !== "note"), status (when !== "informational"),
   * tags.join(", ") (when non-empty), updatedAt.split("T")[0]]`
   * pipe-joined shape pre-#03 already produced. Wake-up Recent /
   * Related pass a leaner builder. Omitting this option falls back to
   * the recall/search shape via `defaultMemoryMetaBuilder`.
   */
  meta?: ((memory: MemoryListItem) => string | null) | string
  /**
   * Markdown body to append after the meta line. When supplied AND
   * non-empty, the helper appends `\n\n${body}` to the rendered row,
   * producing the `### {title}\n[{synopsis}\n]*{meta}*\n\n{body}`
   * shape from the includeContent=true cells of the four-cell matrix.
   * When omitted or empty, the helper renders the body-off shape
   * (`### {title}\n[{synopsis}\n]*{meta}*`).
   *
   * Body lives on `Memory` (`content` field) but NOT on
   * `MemoryListItem` — keeping it off the structural type lets
   * `DecisionSummary` and `TaskSummary` (the body-less projections)
   * pass the helper without a content field they don't have. Recall /
   * search forward `m.content` here when their `includeContent` flag
   * is `true`. Wake-up does NOT pass body — its body inclusion is
   * gated by `expand: true` and rendered in a different code path
   * outside this helper.
   */
  body?: string
}

/**
 * Default builder matching recall / search's pre-#03 meta shape. Pulled
 * out so wake-up's section-specific builders can fall back to it for the
 * non-Recent-Memories surfaces if they ever need to.
 */
export function defaultMemoryMetaBuilder(memory: MemoryListItem): string {
  return [
    memory.source,
    memory.kind !== "note" ? memory.kind : null,
    memory.status !== "informational" ? memory.status : null,
    memory.tags.length > 0 ? memory.tags.join(", ") : null,
    memory.updatedAt.split("T")[0],
  ]
    .filter(Boolean)
    .join(" | ")
}

/**
 * Render one memory listing entry. Shared by `lore-query action='recall'`,
 * `lore-query action='search'`, and `lore-context action='wake-up'`'s
 * memory sections so a future rendering tweak (e.g. wrapping the
 * synopsis in italics, or moving it after the metadata line) is a
 * one-place edit instead of a fan-out across three handlers with
 * fixture pins each.
 *
 * Output shape, traversing the four-cell `body` × synopsis matrix:
 *
 *   `### {title}` (heading level configurable)
 *   `[{synopsis}]`  (only when `includeSynopsis !== false` and present)
 *   `*{meta}*`      (only when meta builder/string yields a non-null value)
 *   `[\n\n{body}]`  (only when `body` is non-empty)
 *
 * The synopsis is defensively truncated at `SYNOPSIS_MAX` (declared in
 * `src/types.ts`). Per #01 the service layer accepts up to the Notion
 * 2000-char ceiling and only the MCP write Zod enforces the 500-char
 * soft cap — internal callers (bulk migrations, `--backfill-synopses`
 * synthesizer, future scripts) can write longer values, and a 1500-char
 * synopsis on a wake-up listing would blow up the page. Truncation
 * snaps back to the last word boundary at or before the cap. No
 * ellipsis marker is appended — adding `…` would diverge from how
 * other text fields handle truncation in this codebase.
 */
export function formatMemoryListItem(
  memory: MemoryListItem,
  options: FormatMemoryListItemOptions = {},
): string {
  const headingLevel = options.headingLevel ?? 3
  const heading = "#".repeat(headingLevel)
  const lines: string[] = [`${heading} ${memory.title}`]

  const includeSynopsis = options.includeSynopsis !== false
  // `.trim()` on the truthy check so a whitespace-only synopsis (a hypothetical
  // future write-path bug, or a placeholder "   " landed by a migration) doesn't
  // render as a blank line between heading and meta. The rendered value is the
  // un-trimmed input — `truncateSynopsis` operates on the original so word-
  // boundary truncation logic doesn't see a shifted index.
  if (includeSynopsis && memory.synopsis.trim()) {
    lines.push(truncateSynopsis(memory.synopsis))
  }

  const metaText = renderMetaLine(memory, options.meta)
  if (metaText !== null) {
    lines.push(`*${metaText}*`)
  }

  let rendered = lines.join("\n")
  if (options.body && options.body.length > 0) {
    rendered = `${rendered}\n\n${options.body}`
  }
  return rendered
}

function renderMetaLine(
  memory: MemoryListItem,
  meta: FormatMemoryListItemOptions["meta"],
): string | null {
  if (typeof meta === "string") return meta
  if (typeof meta === "function") return meta(memory)
  return defaultMemoryMetaBuilder(memory)
}

/**
 * Trim a synopsis to `SYNOPSIS_MAX` chars on the last word boundary at
 * or before the cap. When the synopsis is already within budget, the
 * input is returned as-is — short paths shouldn't pay a slice/regex
 * cost. When no usable word boundary appears inside the window (a
 * single 600-char token, or whitespace only at index 0) we fall back
 * to the hard slice so the row still respects the cap.
 *
 * Exported so the per-surface formatters that don't go through
 * `formatMemoryListItem` (decision-list's bold meta line; the bullet-
 * row task formatters in `lore-task action='list'` and the wake-up
 * `## Tasks` section) share the same defensive discipline. Internal
 * callers (bulk migrations, the `--backfill-synopses` synthesizer)
 * can write up to the Notion 2000-char ceiling; every list surface
 * must defend against an over-cap row blowing up its output.
 */
export function truncateSynopsis(synopsis: string): string {
  if (synopsis.length <= SYNOPSIS_MAX) return synopsis
  const window = synopsis.slice(0, SYNOPSIS_MAX)
  const lastBoundary = window.search(/\s\S*$/u)
  if (lastBoundary <= 0) return window
  return window.slice(0, lastBoundary)
}

/**
 * Predicate classification for the grouped-display taxonomy used by
 * `lore-query action='ask'` (P2-06):
 *
 * - `governance` — decision-graph edges (`decided_by`, `supersedes_decision`)
 *   that answer "what decisions govern this?"
 * - `structure` — everything else (type, composition, causation, dependency,
 *   ownership) — the default bucket.
 *
 * Unknown predicates fall through to `structure` so a predicate added
 * server-side still renders in *some* bucket instead of disappearing.
 * Kept in `render.ts` so other read tools can reuse the same taxonomy
 * without duplicating predicate lists.
 */
export type FactClass = "governance" | "structure"

const GOVERNANCE_PREDICATES: ReadonlySet<FactPredicate> = new Set<FactPredicate>([
  "decided_by",
  "supersedes_decision",
])

export function factClass(predicate: FactPredicate): FactClass {
  if (GOVERNANCE_PREDICATES.has(predicate)) return "governance"
  return "structure"
}

export interface GroupedFacts {
  governance: Fact[]
  structure: Fact[]
}

/**
 * Group facts into `FactClass` buckets and sort each one
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
  const groups: GroupedFacts = { governance: [], structure: [] }
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
 * fetched via `lore-memory action='expand'` / `lore-query action='recall'`.
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
