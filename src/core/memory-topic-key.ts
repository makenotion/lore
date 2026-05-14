import { createHash } from "node:crypto"
import type {
  Client,
  CreatePageParameters,
  PageObjectResponse,
  QueryDataSourceParameters,
} from "@notionhq/client"
import type {
  CreateMemoryInput,
  DatabaseRef,
  Memory,
  MemoryConfidence as MemoryConfidenceLevel,
  MemoryKind,
  MemoryScopeInput,
  MemorySource,
  MemoryStatus,
} from "../types.js"
import { buildMemoryProps, MEMORY_PROPS } from "../notion/schema.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { isLiveFullPage } from "../notion/extractors.js"
import {
  RunToolBlockEditError,
  updatePageContentViaRunTool,
} from "../notion/runtool/index.js"
import { redactDebugMessage } from "../debug-redact.js"
import { LoreError, errorCauseMessage } from "../errors.js"
import type { LoreFeatureFlags } from "../feature-flags.js"
import { validateRichTextMetadataFields } from "./rich-text-schema.js"
import { todayUtc } from "./task.js"
import { withCleanupOrphanExclusion } from "./memory-filters.js"

type PageToMemory = (page: PageObjectResponse, content: string) => Promise<Memory>

interface TitleCacheWriter {
  delete(id: string): void
  set(id: string, value: string | null): void
}

interface MemoryTopicKeyDependencies {
  create(input: CreateMemoryInput): Promise<Memory>
  getById(id: string): Promise<Memory>
  pageToMemory: PageToMemory
  titleCache: TitleCacheWriter
}

export class RekeyAuditError extends LoreError<"rekey-audit-failed"> {
  readonly memoryId: string
  readonly oldTopicKey: string
  readonly newTopicKey: string
  readonly cause: unknown

  constructor(
    message: string,
    details: {
      memoryId: string
      oldTopicKey: string
      newTopicKey: string
      cause: unknown
    }
  ) {
    super(
      "rekey-audit-failed",
      message,
      {
        memoryId: details.memoryId,
        oldTopicKey: details.oldTopicKey,
        newTopicKey: details.newTopicKey,
        causeMessage: errorCauseMessage(details.cause),
      },
      { cause: details.cause }
    )
    this.name = "RekeyAuditError"
    this.memoryId = details.memoryId
    this.oldTopicKey = details.oldTopicKey
    this.newTopicKey = details.newTopicKey
    this.cause = details.cause
  }
}

/**
 * Revision count at which the upsert response footer surfaces a
 * promotion advisory. When `Revision Count` post-write
 * meets this threshold, the topic chain has revised five times —
 * enough that the operator should consider whether the upsert chain
 * is still a single coherent topic or has accumulated several
 * distinct sub-topics. Tunable; the value is a starting point and
 * may need real-vault data to refine.
 */
export const PROMOTE_REVISION_THRESHOLD = 5

/**
 * Post-write body length (in characters of the assembled markdown)
 * at which the upsert response footer surfaces a promotion advisory.
 * At ~5KB the page is unwieldy to read as a single
 * artifact; the threshold is a *human-readability* heuristic, NOT a
 * Notion structural cap. Notion's documented block-per-page limits
 * drift between releases; a precise claim would invite operator
 * confusion when the limit changes.
 */
export const PROMOTE_BODY_LENGTH_THRESHOLD = 5000

/**
 * Promotion advisory surfaced by `MemoryService.upsertByTopicKey`
 * when an *append-revision* upsert (NOT a fresh create) crosses
 * either the revision-count or body-length threshold. The advisory
 * is informational: it never blocks the save and never auto-
 * promotes. The MCP layer renders the advisory as a response footer
 * so the agent or operator can decide whether to act.
 *
 * `reasons` is human-readable and may carry one or both threshold
 * crossings. `suggestion` is the ready-to-paste promotion
 * incantation — the wording is frozen (an `instanceof`-style stable
 * contract for the MCP layer's footer rendering).
 */
export interface PromotionAdvisory {
  reasons: string[]
  suggestion: string
}

interface LatestTopicRevision {
  revisionCount: number
  title: string | null
  content: string
  fingerprint: string | null
}

interface TopicUpsertSnapshot {
  kind: MemoryKind
  title: string
  content: string
  synopsis: string
  keywords: string
  source: MemorySource
  confidence: MemoryConfidenceLevel
  author: string
}

interface TopicUpsertAnalysis {
  latestRevision: LatestTopicRevision | null
  bodyMatches: boolean
  propertiesMatch: boolean
  fingerprintMatches: boolean
  bodyAheadOfProperties: boolean
}

const TOPIC_UPSERT_FINGERPRINT_PREFIX = "<!-- lore-topic-upsert-sha256: "

function topicUpsertFingerprint(input: TopicUpsertSnapshot): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: input.kind,
        title: input.title,
        content: input.content,
        synopsis: input.synopsis,
        keywords: input.keywords,
        source: input.source,
        confidence: input.confidence,
        author: input.author,
      })
    )
    .digest("hex")
}

function parseAppendedTopicRevision(
  markdown: string,
  blockStart: number,
  revisionCount: number
): LatestTopicRevision | null {
  const headerStart = blockStart + "\n---\n\n".length
  const headerEnd = markdown.indexOf("\n", headerStart)
  if (headerEnd < 0) {
    return null
  }

  const titlePrefix = "**Title at this revision:** "
  const afterHeader = markdown.slice(headerEnd + 1)
  const lines = afterHeader.split("\n")
  let lineIndex = 0
  while (lines[lineIndex] === "") {
    lineIndex += 1
  }

  let fingerprint: string | null = null
  const fingerprintLine = lines[lineIndex]
  if (fingerprintLine?.startsWith(TOPIC_UPSERT_FINGERPRINT_PREFIX)) {
    fingerprint = fingerprintLine
      .slice(TOPIC_UPSERT_FINGERPRINT_PREFIX.length)
      .replace(/ -->$/, "")
    lineIndex += 1
    if (lines[lineIndex] === "") {
      lineIndex += 1
    }
  }

  const titleLine = lines[lineIndex]
  if (!titleLine?.startsWith(titlePrefix)) {
    return null
  }

  lineIndex += 1
  if (lines[lineIndex] === "") {
    lineIndex += 1
  }

  return {
    revisionCount,
    title: titleLine.slice(titlePrefix.length),
    content: lines.slice(lineIndex).join("\n"),
    fingerprint,
  }
}

function extractLatestAppendedTopicRevision(
  markdown: string,
  options: { requireFingerprint?: boolean } = {}
): LatestTopicRevision | null {
  const revisionStart = /\n---\n\n## Revision (\d+) \([^)]+\)/g
  const matches: RegExpExecArray[] = []
  let match: RegExpExecArray | null

  while ((match = revisionStart.exec(markdown)) !== null) {
    matches.push(match)
  }

  for (const candidate of matches.reverse()) {
    if (candidate.index === undefined) continue

    const revisionCount = Number.parseInt(candidate[1] ?? "", 10)
    if (!Number.isFinite(revisionCount)) continue

    const parsed = parseAppendedTopicRevision(markdown, candidate.index, revisionCount)
    if (options.requireFingerprint && !parsed?.fingerprint) continue
    if (parsed) return parsed
  }

  return null
}

function extractAppendedTopicRevisionByCount(
  markdown: string,
  revisionCount: number
): LatestTopicRevision | null {
  const revisionPrefix = `\n---\n\n## Revision ${revisionCount} (`
  const blockStart = markdown.indexOf(revisionPrefix)
  if (blockStart < 0) {
    return null
  }

  return parseAppendedTopicRevision(markdown, blockStart, revisionCount)
}

function extractLatestTopicRevision(
  markdown: string,
  storedRevisionCount: number
): LatestTopicRevision | null {
  const fingerprintedRevision = extractLatestAppendedTopicRevision(markdown, {
    requireFingerprint: true,
  })
  if (
    fingerprintedRevision &&
    fingerprintedRevision.revisionCount >= storedRevisionCount
  ) {
    return fingerprintedRevision
  }

  if (storedRevisionCount <= 1) {
    return { revisionCount: 1, title: null, content: markdown, fingerprint: null }
  }

  return extractAppendedTopicRevisionByCount(markdown, storedRevisionCount)
}

/**
 * Pick a unique anchor string for the upsert revision-append RunTool
 * branch. Returns `null` when no safe anchor exists — caller falls back
 * to the canonical full-body `replace_content` path.
 *
 * The anchor is the latest fingerprinted revision's fingerprint comment
 * line plus everything that follows it through the end of the body. Two
 * load-bearing properties:
 *
 * 1. **Uniqueness.** The fingerprint hashes (kind, title, content,
 * synopsis, keywords, source, confidence, author) — content-derived,
 * so two revisions with byte-identical effective inputs would have
 * short-circuited through the no-op branch above instead of
 * appending. A non-unique fingerprint line would therefore be a
 * structural impossibility for the path that reaches here, but the
 * occurrence-count guard below makes the contract explicit and fails
 * closed if a hand-edited body somehow contains the line twice.
 *
 * 2. **Tail coverage.** The fingerprint line lives inside the latest
 * revision block, and the latest revision is, by definition, the
 * last block in the body. Anchoring on `<fp line> + <rest-to-end>`
 * means substituting the anchor for `anchor + revisionBlock`
 * semantically appends — the new revision lands strictly after the
 * previous one, preserving the document's structural ordering.
 *
 * Falls back to `null` when:
 * - no latest revision exists (first append on a body with no prior
 * revision blocks) — the legacy / un-fingerprinted shape gives no
 * safe anchor;
 * - the latest revision lacks a fingerprint (legacy un-fingerprinted
 * revision blocks predate the audit fingerprint and could collide
 * with other content);
 * - the fingerprint line does not occur exactly once in the body
 * (defensive: structural impossibility today, but the explicit guard
 * keeps a future hand-edited body from silently routing into the
 * wrong replacement).
 */
function pickRevisionAppendAnchor(
  markdown: string,
  latestRevision: LatestTopicRevision | null
): string | null {
  if (!latestRevision || latestRevision.fingerprint === null) return null
  const fpLine = `${TOPIC_UPSERT_FINGERPRINT_PREFIX}${latestRevision.fingerprint} -->`
  const idx = markdown.lastIndexOf(fpLine)
  if (idx < 0) return null
  const occurrences = markdown.split(fpLine).length - 1
  if (occurrences !== 1) return null
  return markdown.slice(idx)
}

/**
 * Pick a unique tail anchor for the rekey audit-block append branch.
 * Returns `null` when no anchor with exactly one occurrence in the body
 * is available — caller falls back to the canonical
 * `replace_content` full-body path while preserving the
 * `RekeyAuditError` partial-state contract.
 *
 * Strategy: take the trailing slice of the body (capped at
 * `REKEY_TAIL_ANCHOR_BYTES`) and verify it occurs exactly once. The
 * tail must be unique by virtue of the body terminating there — any
 * substring that happens to repeat earlier defeats the uniqueness
 * guarantee, so the count-occurrences guard is load-bearing.
 *
 * Unlike the revision-append branch, there is no structural fingerprint
 * to anchor on: re-keys do not carry content-derived hashes (the audit
 * block names the old/new keys, not a fingerprint over them). The
 * tail-with-uniqueness check is the strongest invariant available
 * without changing the body schema.
 */
const REKEY_TAIL_ANCHOR_BYTES = 256

function pickRekeyAuditAnchor(content: string): string | null {
  if (content.length === 0) return null
  const tail = content.slice(Math.max(0, content.length - REKEY_TAIL_ANCHOR_BYTES))
  const occurrences = content.split(tail).length - 1
  if (occurrences !== 1) return null
  return tail
}

/** Construct the canonical `RekeyAuditError` for a partial-state
 * failure. The `cause`'s message is routed through the shared
 * `redactDebugMessage` so a Notion error carrying a workspace id /
 * page-id substring (rare but possible on auth-shaped errors) does
 * not bypass the redactor. The original `err` is still attached as
 * `cause` on the structured error so callers branching via
 * `instanceof RekeyAuditError` retain access to the underlying SDK
 * shape — only the rendered `message` is scrubbed.
 *
 * Keeping a single helper for both the RunTool and REST audit
 * failure surfaces ensures the error shape and redaction posture
 * cannot drift between the two transports. */
function buildRekeyAuditError(
  memoryId: string,
  oldTopicKey: string,
  newTopicKey: string,
  err: unknown
): RekeyAuditError {
  const rawMessage = err instanceof Error ? err.message : String(err)
  const cause = redactDebugMessage(rawMessage)
  return new RekeyAuditError(
    `Re-key persisted ('${oldTopicKey || "(unset)"}' → '${newTopicKey}') ` +
      `but audit-block append failed: ${cause}. The Topic Key column is ` +
      `updated; the body audit trail is missing. A retry will short-circuit ` +
      `as a no-op — the audit block cannot be recovered automatically. ` +
      `Inspect memory ${memoryId} on Notion to confirm and append the audit ` +
      `manually if needed.`,
    { memoryId, oldTopicKey, newTopicKey, cause: err }
  )
}

/** Emit one stderr line under `LORE_DEBUG=1` when `rekeyTopicKey`'s
 * RunTool branch is enabled but the body's tail anchor is not unique
 * (typically because the body has accumulated repetitive structures
 * like multiple `## Re-keyed (...)` audit blocks).
 *
 * Same posture as the existing `[lore] semantic-search-cap-fired`
 * emission — silent under default logging, observable when the
 * operator is debugging. Without this signal an operator running
 * flag-on against a corpus with repetitive tails would see RunTool
 * engaged for some calls and not others with no diagnostic.
 *
 * Bodies for which the anchor IS unique (the common case) emit
 * nothing; this is strictly the no-anchor diagnostic surface. */
function debugLogRekeyAnchorMiss(memoryId: string, bodyLength: number): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(
    `[lore] rekey-anchor-miss: memory=${memoryId} body-length=${bodyLength} ` +
      `source=pickRekeyAuditAnchor\n`
  )
}

function analyzeLatestTopicUpsert(
  input: TopicUpsertSnapshot,
  existing: Memory,
  markdown: string
): TopicUpsertAnalysis {
  const latestRevision = extractLatestTopicRevision(markdown, existing.revisionCount)
  if (!latestRevision) {
    return {
      latestRevision: null,
      bodyMatches: false,
      propertiesMatch: false,
      fingerprintMatches: false,
      bodyAheadOfProperties: false,
    }
  }

  const bodyTitleMatches =
    latestRevision.title === null
      ? existing.title === input.title
      : latestRevision.title === input.title
  const bodyMatches = bodyTitleMatches && latestRevision.content === input.content
  const propertiesMatch =
    existing.title === input.title &&
    existing.synopsis === input.synopsis &&
    existing.keywords === input.keywords &&
    existing.source === input.source &&
    existing.confidence === input.confidence &&
    existing.author === input.author

  return {
    latestRevision,
    bodyMatches,
    propertiesMatch,
    fingerprintMatches: latestRevision.fingerprint === topicUpsertFingerprint(input),
    bodyAheadOfProperties: latestRevision.revisionCount > existing.revisionCount,
  }
}

/**
 * Pure helper that returns a `PromotionAdvisory` when at least one
 * threshold is met, or `null` when neither is. The boundary semantics
 * are inclusive (`>=`) so a value AT the threshold fires the
 * advisory — pinned by tests so a future contributor can't silently
 * shift to strict-greater and quietly raise the firing point.
 *
 * Both reasons surface in the order revision-count → body-length so
 * the rendered footer reads consistently; multi-reason firings
 * preserve that order.
 *
 * **Suggestion wording is kind-aware.** Topic-key chains are valid
 * for `decision`, `runbook`, `incident`, `postmortem`, and `policy`
 * kinds. Only `kind: 'decision'` memories can be superseded via
 * `lore-decision action='create'` with `supersedesIds`:
 * `DecisionService.getById` (the resolver the create handler runs
 * for every supersedesIds entry) throws on non-decision kinds, so a
 * footer that handed a runbook/incident/postmortem/policy operator
 * `supersedesIds: [<this-id>]` would be a ready-to-paste BROKEN
 * command. Decisions get the supersede-and-split wording; other
 * kinds get the split-and-archive path that doesn't depend on a
 * decision-only API. The `<this-memory-id>` placeholder appears in
 * the decision-kind branch only and is replaced by the rendering
 * layer.
 */
export function computePromotionAdvisory(input: {
  revisionCount: number
  bodyLength: number
  kind: MemoryKind
}): PromotionAdvisory | null {
  const reasons: string[] = []
  if (input.revisionCount >= PROMOTE_REVISION_THRESHOLD) {
    reasons.push(`${input.revisionCount} revisions accumulated`)
  }
  if (input.bodyLength >= PROMOTE_BODY_LENGTH_THRESHOLD) {
    reasons.push(`body length ${input.bodyLength} chars`)
  }
  if (reasons.length === 0) return null
  const suggestion =
    input.kind === "decision"
      ? "Consider promoting via lore-decision action='create' " +
        "with supersedesIds: [<this-memory-id>], or splitting " +
        "the topic into narrower topicKeys."
      : "Consider splitting the topic into narrower topicKeys, " +
        "or archiving this chain via lore-memory action='archive' " +
        "and starting a fresh chain with a more specific topicKey."
  return { reasons, suggestion }
}

export class MemoryTopicKey {
  constructor(
    private client: Client,
    private db: DatabaseRef,
    private features: LoreFeatureFlags,
    private deps: MemoryTopicKeyDependencies
  ) {}

  /**
   * Find at most one non-archived memory matching a `(Topic Key,
   * Project-set)` pair, ordered by `Revision Count` desc with
   * `Last Referenced At` desc as the tiebreaker. The shared lookup
   * helper for the topic-key upsert and the re-key repair paths —
   * both consume this so neither hard-depends on the other. Two
   * short-circuit guards defend against accidental whole-vault
   * matches: empty `topicKey` and empty `projectIds` both return
   * null without issuing any Notion query.
   *
   * **Empty `topicKey` guard.** Per the schema contract, empty
   * string and missing both mean "no upsert grouping" — there is
   * no canonical row to find. Without this guard, an upsert caller
   * that forgets to gate on `topicKey === ""` would issue
   * `rich_text: { equals: "" }` to Notion, which matches every
   * legacy row whose Topic Key column is empty (i.e. every
   * memory without a declared topic key). The JS post-filter would
   * narrow to the project set and return the highest-`Revision
   * Count` legacy memory — silently appending a revision onto an
   * arbitrary unrelated row. The parameter type is `string` (not
   * `string | undefined`), so the type system doesn't catch the
   * call-site mistake; this guard does.
   *
   * **Project-set EQUALITY, not containment.** Notion's relation
   * filter only supports `contains`, so the query OR-AND-composes
   * one `contains` clause per project ID. The result set is then
   * filtered client-side down to true equality — a memory whose
   * Project relation is `["P1", "P2"]` is excluded from a query
   * for `projectIds: ["P1"]` because the memory has extra projects
   * the caller didn't ask for. Symmetric: a query for
   * `["P1", "P2"]` against a memory in `["P1"]` returns null.
   * Order-independent: set semantics, not list semantics.
   *
   * **Pagination.** A vault with many memories under the same Topic
   * Key (project-set differs across rows so the helper returns null
   * for each but the query yields >100 candidates) or repeated re-
   * keying could overflow the default 100-row Notion page. Loop
   * until `has_more` is false; without pagination the latest
   * revision could hide on a non-first page and the helper would
   * silently return a stale candidate.
   *
   * **Archived rows.** `dataSources.query` cannot filter on the
   * `archived` page-metadata flag (it lives on PageObjectResponse,
   * not as a DB column). The post-filter excludes archived rows
   * client-side.
   *
   * **Cross-kind matching is intentional.** The Memories DB hosts
   * notes, decisions, and tasks (the Kind column discriminates).
   * The query does NOT filter on Kind — a `decision/jwt-auth` topic
   * key matches against any memory in the project set carrying that
   * key, regardless of Kind. This is what the re-key path needs for
   * collision detection: if a re-key would land on an existing
   * task or decision, the helper must surface that collision so the
   * re-key can reject. Callers that want kind-specific upsert
   * semantics layer a Kind filter at their own boundary; the helper
   * stays Kind-agnostic so the single primitive serves both consumers.
   */
  async findByTopicKey(input: {
    topicKey: string
    projectIds: string[]
  }): Promise<Memory | null> {
    if (input.topicKey === "") return null
    if (input.projectIds.length === 0) return null

    const allResults: PageObjectResponse[] = []
    // First iteration runs with `start_cursor: undefined` (Notion
    // treats this as "first page"). Subsequent iterations carry the
    // returned `next_cursor` until `has_more` is false; the
    // `?? undefined` guard normalizes a `next_cursor: null` from
    // Notion into the loop-exit sentinel.
    //
    // The `Keywords does_not_contain MEMORY_CLEANUP_ORPHAN_SENTINEL`
    // clause (composed via `withCleanupOrphanExclusion`) excludes
    // resurfaced cleanup-orphans. A properties-only orphan archived
    // after a partial-create failure can be restored from Notion's
    // trash, at which point `isLiveFullPage` stops excluding it; the
    // sentinel keyword written in the same `pages.update` as the
    // archive survives the round-trip and steers the upsert path
    // away from the empty-body shell.
    let cursor: string | undefined = undefined
    do {
      const page = await this.client.dataSources.query({
        data_source_id: this.db.dataSourceId,
        filter: withCleanupOrphanExclusion({
          and: [
            { property: MEMORY_PROPS.TOPIC_KEY, rich_text: { equals: input.topicKey } },
            ...input.projectIds.map((id) => ({
              property: MEMORY_PROPS.PROJECT,
              relation: { contains: id },
            })),
          ],
        }) as QueryDataSourceParameters["filter"],
        start_cursor: cursor,
      })
      for (const r of page.results) {
        if (isLiveFullPage(r)) allResults.push(r)
      }
      cursor = page.has_more ? (page.next_cursor ?? undefined) : undefined
    } while (cursor !== undefined)

    const inputSet = new Set(input.projectIds)
    const memories = await Promise.all(
      allResults.map((page) => this.deps.pageToMemory(page, ""))
    )
    const matches = memories.filter(
      (m) =>
        m.projectIds.length === inputSet.size &&
        m.projectIds.every((id) => inputSet.has(id))
    )

    matches.sort((a, b) => {
      if (a.revisionCount !== b.revisionCount) {
        return b.revisionCount - a.revisionCount
      }
      return (b.lastReferencedAt ?? "").localeCompare(a.lastReferencedAt ?? "")
    })

    return matches[0] ?? null
  }

  /**
   * Topic-key upsert. Either appends a revision block to an existing
   * memory or creates a fresh one. The match key is `(Topic Key,
   * Project-set)`; project equality is set-equal (same IDs, same count),
   * resolved by `findByTopicKey`.
   *
   * **Kind-mismatch validation runs BEFORE any Notion write.** The
   * kind check fires immediately after `findByTopicKey` returns, NOT
   * after the body read/write. Validation after `retrieveMarkdown` +
   * `updateMarkdown` would be a real correctness bug because a
   * kind-mismatched upsert would append a revision block to the page
   * before rejecting.
   *
   * **Project-set equality is enforced by `findByTopicKey`, NOT by a
   * defensive recheck here.** The lookup post-filters candidates to
   * `existing.projectIds.length === input.projectIds.length &&
   * existing.projectIds.every(id => inputSet.has(id))` and returns
   * null on mismatch — so by construction the post-find row is
   * set-equal to the input. A second JS-side recheck against the same
   * returned value is structurally tautological. True race detection
   * (a writer that mutates the project relation between find and write
   * on this process) would require a second `pages.retrieve` round-
   * trip and the worst-case consequence (one revision lands on a row
   * whose project set just expanded under a concurrent write) is
   * benign — not justified.
   *
   * **Field policy on upsert:**
   * - **THROW on mismatch**: Kind (per-kind chain). Project-set is
   * handled by the lookup; not a separate throw at this layer.
   * - **PRESERVE silently** (input dropped, no warning): Status,
   * Topic relation. State transitions belong on `lore-memory
   * action='update'`; the upsert path treats these as forgotten-to-
   * omit envelopes.
   * - **REPLACE on every save** (latest write wins): Title, Synopsis,
   * Keywords, Source. Confidence (categorical) bumps if input
   * provides one.
   * - **UNTOUCHED**: Confidence Score (system-managed by the
   * read-path decay pipeline), Last Referenced At (read-citation
   * signal owned by `touchOnRead`).
   *
   * **Empty-project guard.** An upsert with `projectIds: []` is
   * structurally undefined — set-equality on the empty set matches
   * every other empty-project memory. Lore allows projectless saves
   * via the create path (catch-all), but those must NOT participate
   * in topic-key upsert. `findByTopicKey` returns null on empty
   * projects, but we throw here for a clearer error.
   *
   * **Notion v5 markdown API.** The SDK exposes `insert_content` for
   * fresh writes on a page with no body and `replace_content` for
   * edits to an existing body. There is no append mode, so the upsert
   * path always reads existing markdown and writes back the
   * concatenation. Two API calls per upsert.
   *
   * **Retry idempotency.** Calling upsert twice with identical
   * effective inputs does NOT append a second revision. The append
   * branch reads the latest stored body and skips the write when the
   * caller's title/content plus replace-on-save metadata already match
   * the row's current state. If a previous attempt landed the body
   * append but failed before the property update, the retry repairs the
   * row properties only when the revision's stored fingerprint matches
   * the effective retry input. Otherwise body-ahead saves append from
   * the markdown revision count, not the stale property count. Only
   * fingerprinted revisions can advance that base beyond the stored
   * `Revision Count`; legacy unfingerprinted revisions remain readable
   * at the stored count for no-op compatibility. A body, title,
   * synopsis, keywords, source, confidence, or author change on a
   * complete chain still appends a new revision. Full-match retries
   * return no advisory because the original successful write already
   * surfaced it; repair retries recompute the advisory because the
   * original response never reached the caller.
   */
  async upsertByTopicKey(input: {
    topicKey: string
    projectIds: string[]
    title: string
    content: string
    kind: MemoryKind
    source?: MemorySource
    status?: MemoryStatus
    confidence?: MemoryConfidenceLevel
    topicId?: string
    synopsis?: string
    keywords?: string
    tags?: string[]
    author?: string
    agent?: string
    session?: string
    reviewBy?: string
    decidedAt?: string
    today?: string
    /**
     * Scope / lifetime declaration. On fresh-create the
     * scope columns land verbatim; on append-revision the scope is
     * silently preserved (revisions inherit the head row's scope —
     * agents change scope through `lore-memory action='update'`).
     */
    scope?: MemoryScopeInput
  }): Promise<{
    memory: Memory
    revisionCount: number
    upserted: boolean
    promotionAdvisory: PromotionAdvisory | null
  }> {
    validateRichTextMetadataFields(input, "MemoryService.upsertByTopicKey")

    if (input.projectIds.length === 0) {
      throw new Error(
        "topicKey requires at least one projectId. " +
          "Projectless memories cannot upsert."
      )
    }

    const existing = await this.findByTopicKey({
      topicKey: input.topicKey,
      projectIds: input.projectIds,
    })

    if (!existing) {
      const created = await this.deps.create({
        title: input.title,
        content: input.content,
        projectIds: input.projectIds,
        topicId: input.topicId,
        source: input.source,
        kind: input.kind,
        status: input.status,
        confidence: input.confidence,
        tags: input.tags,
        keywords: input.keywords,
        synopsis: input.synopsis,
        author: input.author,
        agent: input.agent,
        session: input.session,
        reviewBy: input.reviewBy,
        decidedAt: input.decidedAt,
        topicKey: input.topicKey,
        revisionCount: 1,
        // Scope / lifetime is preserved verbatim on fresh-create;
        // append-revision intentionally skips the scope write below
        // because revisions inherit the head row's scope.
        scope: input.scope,
      })
      // Fresh-create never returns a promotion advisory. The
      // advisory is specifically about revision-chain accumulation; a
      // one-shot write with a long body is a different signal that
      // warrants a different surface.
      return {
        memory: created,
        revisionCount: 1,
        upserted: false,
        promotionAdvisory: null,
      }
    }

    // Validate Kind BEFORE any Notion write. The kind-mismatch throw
    // must fire before retrieveMarkdown / updateMarkdown so a rejected
    // upsert leaves the existing page untouched.
    //
    // Project-set is NOT re-checked here: `findByTopicKey` already
    // post-filters to set-equality and returns null on mismatch, so by
    // construction `existing.projectIds` is set-equal to
    // `input.projectIds` whenever we get past the find. A defensive
    // re-check of the same returned value is structurally unreachable
    // (it can only fire if `findByTopicKey`'s post-filter is
    // bypassed, which is not a path a caller can take). True
    // race detection would require a second `pages.retrieve` round-
    // trip, which is not justified — the only racing writer that
    // could change the project set between find and write is another
    // process holding the same `topicKey`, an extremely rare case
    // whose worst outcome (one revision lands on a row whose project
    // set just expanded) is benign.
    if (input.kind !== existing.kind) {
      throw new Error(
        `Kind cannot change on upsert. Existing: '${existing.kind}'; ` +
          `input: '${input.kind}'. Pick a new topicKey for the new ` +
          `kind, or supersede via lore-decision action='create'.`
      )
    }

    // Decode at the write boundary — same posture as `create`. Encoded
    // values flowing in from autosave-rendered transcripts (`Foo &amp;
    // Bar`) must land in Notion as plain text. Idempotent on clean
    // input; covers title, content body, synopsis, and keywords (the
    // similarity / embedding surfaces that read these fields downstream).
    const decodedTitle = decodeTextEntities(input.title)
    const decodedContent = input.content ? decodeTextEntities(input.content) : ""
    const decodedSynopsis =
      input.synopsis !== undefined ? decodeTextEntities(input.synopsis) : undefined
    const decodedKeywords =
      input.keywords !== undefined ? decodeTextEntities(input.keywords) : undefined
    const decodedAuthor =
      input.author !== undefined ? decodeTextEntities(input.author) : undefined
    const authorForUpdate = decodedAuthor || existing.author

    // Read before deciding whether to append. Notion's v5 markdown API
    // has no append mode, and the body is the only place the latest
    // revision content lives.
    const existingBody = await this.client.pages.retrieveMarkdown({
      page_id: existing.id,
    })

    const upsertSnapshot = {
      kind: input.kind,
      title: decodedTitle,
      content: decodedContent,
      synopsis: decodedSynopsis ?? existing.synopsis,
      keywords: decodedKeywords ?? existing.keywords,
      source: input.source ?? existing.source,
      confidence: input.confidence ?? existing.confidence,
      author: authorForUpdate,
    }
    const upsertAnalysis = analyzeLatestTopicUpsert(
      upsertSnapshot,
      existing,
      existingBody.markdown
    )

    if (
      upsertAnalysis.bodyMatches &&
      upsertAnalysis.bodyAheadOfProperties &&
      upsertAnalysis.fingerprintMatches
    ) {
      const repairedRevisionCount = upsertAnalysis.latestRevision!.revisionCount
      const titleChanged = decodedTitle !== existing.title
      if (titleChanged) {
        this.deps.titleCache.delete(existing.id)
      }
      await this.client.pages.update({
        page_id: existing.id,
        properties: buildMemoryProps({
          title: decodedTitle,
          revisionCount: repairedRevisionCount,
          synopsis: decodedSynopsis,
          keywords: decodedKeywords,
          source: input.source,
          confidence: input.confidence ?? existing.confidence,
          author: authorForUpdate,
        }) as CreatePageParameters["properties"],
      })
      if (titleChanged) {
        this.deps.titleCache.set(existing.id, decodedTitle || null)
      }

      const promotionAdvisory = computePromotionAdvisory({
        revisionCount: repairedRevisionCount,
        bodyLength: existingBody.markdown.length,
        kind: input.kind,
      })

      return {
        memory: {
          ...existing,
          title: decodedTitle,
          revisionCount: repairedRevisionCount,
          synopsis: decodedSynopsis ?? existing.synopsis,
          keywords: decodedKeywords ?? existing.keywords,
          source: input.source ?? existing.source,
          confidence: input.confidence ?? existing.confidence,
          author: authorForUpdate,
        },
        revisionCount: repairedRevisionCount,
        upserted: true,
        promotionAdvisory,
      }
    }

    if (
      upsertAnalysis.bodyMatches &&
      upsertAnalysis.propertiesMatch &&
      !upsertAnalysis.bodyAheadOfProperties
    ) {
      return {
        memory: existing,
        revisionCount: existing.revisionCount,
        upserted: true,
        promotionAdvisory: null,
      }
    }

    // Title-cache delete matches the discipline `update()` uses.
    // Upserts that reach the write branch always bump Title, so the
    // same write-through pattern that protects `update()` from
    // concurrent `getTitleById`
    // callers applies here. Without this, render-layer resolvers
    // would keep returning the pre-upsert title from `titleCache`
    // until the 60s TTL expired even though the new title has landed
    // in Notion. The pre-write delete clears the stored value AND drops
    // any in-flight `getOrLoad` pending slot; the post-write `set`
    // installs the authoritative new title and (via `LruCache.set`'s
    // pending-clearing discipline) suppresses any stale loader's
    // commit dispatched mid-flight.
    this.deps.titleCache.delete(existing.id)

    // Append + write. Notion's v5 markdown API has no append mode;
    // replace_content with allow_deleting_content is the canonical
    // full-body edit path. When `LORE_USE_RUNTOOL_BLOCK_EDIT` is on
    // AND the previous revision carries a fingerprint we can
    // anchor on, a RunTool `update_content` call substitutes only the
    // tail of the body — the server splices the new
    // revision in-place instead of rewriting the whole page. The
    // wrapper raises a `RunToolBlockEditError` for the four
    // structured fall-back kinds (`no_match` / `multiple_matches` /
    // `deletion_warning` / `restricted_resource`), and we fall back
    // to the canonical full-body path on those so the save always
    // lands. Transient transport errors (401 / 429 / 5xx /
    // malformed) propagate verbatim so the auth-refresh proxy and
    // shared 429 backoff stay authoritative.
    const baseRevisionCount =
      upsertAnalysis.latestRevision &&
      upsertAnalysis.latestRevision.revisionCount > existing.revisionCount
        ? upsertAnalysis.latestRevision.revisionCount
        : existing.revisionCount
    const nextRevision = baseRevisionCount + 1
    const today = input.today ?? todayUtc()
    const revisionBlock = [
      "",
      "---",
      "",
      `## Revision ${nextRevision} (${today})`,
      "",
      `${TOPIC_UPSERT_FINGERPRINT_PREFIX}${topicUpsertFingerprint(upsertSnapshot)} -->`,
      "",
      `**Title at this revision:** ${decodedTitle}`,
      "",
      decodedContent,
    ].join("\n")

    const anchor = pickRevisionAppendAnchor(
      existingBody.markdown,
      upsertAnalysis.latestRevision
    )
    const useRunToolAnchor = this.features.runTool.blockEdit && anchor !== null
    let bodyEditApplied = false
    if (useRunToolAnchor && anchor) {
      try {
        await updatePageContentViaRunTool(this.client, {
          pageId: existing.id,
          updates: [{ oldStr: anchor, newStr: anchor + revisionBlock }],
        })
        bodyEditApplied = true
      } catch (err) {
        if (!(err instanceof RunToolBlockEditError)) throw err
        // Fall through to the full-body path on every structured
        // fall-back signal: `no_match` / `multiple_matches` /
        // `deletion_warning` (validation-class) AND
        // `restricted_resource` (403 capability rejection — the
        // auth-refresh proxy cannot repair this, but the existing
        // REST/SDK path can). A future contributor narrowing the
        // catch (e.g. on `kind === "no_match"` only) would silently
        // re-introduce the integration-secret outage; the
        // `restricted_resource` integration test would fail loudly.
      }
    }
    const assembledBodyLength = existingBody.markdown.length + revisionBlock.length
    if (!bodyEditApplied) {
      const assembledBody = existingBody.markdown + revisionBlock
      await this.client.pages.updateMarkdown({
        page_id: existing.id,
        type: "replace_content",
        replace_content: {
          new_str: assembledBody,
          allow_deleting_content: true,
        },
      })
    }

    // Property update: Title bumps, Revision Count increments,
    // synopsis / keywords / source replace if provided, confidence
    // bumps if provided. Kind / Status / topicId / projectIds /
    // lastReferencedAt / confidenceScore are NOT in this update.
    //
    // Author is REPLACE-on-every-save (DEFERRED-ATTRIBUTION) when the
    // input carries one: the engineer making this revision becomes the
    // author of the chain. Symmetric reasoning to title / synopsis /
    // keywords / source — the upsert path's "latest write wins" policy
    // covers human attribution. The MCP tool layer lazily passes a
    // default author only when no explicit override is given. Falls
    // back to existing on decodedAuthor is empty/undefined so a
    // service-layer caller (migration, internal tooling) that omits it
    // preserves the prior value rather than clobbering with null. Empty
    // string from the input is treated as "leave alone", matching the
    // `agent` field's posture.
    await this.client.pages.update({
      page_id: existing.id,
      properties: buildMemoryProps({
        title: decodedTitle,
        revisionCount: nextRevision,
        synopsis: decodedSynopsis,
        keywords: decodedKeywords,
        source: input.source,
        confidence: input.confidence ?? existing.confidence,
        author: authorForUpdate,
      }) as CreatePageParameters["properties"],
    })

    // Write-through: install the post-upsert title. `LruCache.set`
    // also drops any in-flight `getOrLoad` pending slot, so a
    // concurrent reader whose loader resolves with the pre-upsert
    // page after this point has its commit suppressed by the
    // identity guard. Mirror of `update()`'s post-write
    // `nameCache.set`.
    this.deps.titleCache.set(existing.id, decodedTitle || null)

    // Promotion advisory. Fires only on the
    // append-revision branch (fresh-create returned earlier with a
    // null advisory). Reads post-write state already in memory:
    // `nextRevision` is the value just written, `assembledBodyLength`
    // is the markdown body's post-write character count. No extra
    // Notion calls. The body length is identical whether the write went
    // through the anchored RunTool path or the full-body fallback —
    // both produce `existingBody.markdown + revisionBlock` as the
    // resulting body. The MCP layer renders this in the save response
    // footer when non-null; agents reading the response decide whether
    // to promote — the system never auto-promotes.
    //
    // `kind` is forwarded to `computePromotionAdvisory` because the
    // suggestion wording is kind-aware: only `kind: 'decision'`
    // memories can be referenced from `lore-decision action='create'
    // supersedesIds: [...]` (DecisionService.getById throws on
    // non-decision kinds). The kind-mismatch guard above already
    // rejected upserts where `input.kind !== existing.kind`, so the
    // two values agree here; either is correct.
    const promotionAdvisory = computePromotionAdvisory({
      revisionCount: nextRevision,
      bodyLength: assembledBodyLength,
      kind: input.kind,
    })

    // Return the post-write memory shape so callers (auto-mentions,
    // session recording) read the new title / keywords / synopsis when
    // re-running entity extraction. `synopsis` and `keywords` fall
    // back to existing when caller omitted them, matching the
    // buildMemoryProps `if (input.X !== undefined)` gate behavior.
    // `author` reflects the post-write state — `authorForUpdate`
    // already collapses input/existing per DEFERRED-ATTRIBUTION's
    // overwrite-when-provided rule, so the returned shape reads the
    // value Notion holds after the update.
    return {
      memory: {
        ...existing,
        title: decodedTitle,
        revisionCount: nextRevision,
        synopsis: decodedSynopsis ?? existing.synopsis,
        keywords: decodedKeywords ?? existing.keywords,
        source: input.source ?? existing.source,
        confidence: input.confidence ?? existing.confidence,
        author: authorForUpdate,
      },
      revisionCount: nextRevision,
      upserted: true,
      promotionAdvisory,
    }
  }

  /**
   * Re-key a memory's `Topic Key` to a new value. The
   * conservative repair path for the topic-key upsert chain — an
   * agent that picks the wrong topic key on first save can switch
   * to the canonical key without abandoning the row.
   *
   * Re-keying is identity surgery, not content evolution:
   *
   * - **No `Revision Count` bump.** Revision Count tracks topic content
   * evolution (N saves under the same identity meant the topic was
   * refined N times). Bumping on re-key would conflate identity
   * changes with content changes.
   * - **No `Last Referenced At` write.** Re-keying is a write, not a
   * read citation, same posture as the topic-key upsert.
   * - **Audit block format** (`## Re-keyed (YYYY-MM-DD)`) deliberately
   * differs from the revision-block prefix (`## Revision N`) so a
   * future memory-history renderer can distinguish identity events
   * from content events without parsing body text.
   *
   * Validation is strict and fail-fast — every guard fires before any
   * Notion mutation, so a rejected call leaves the row entirely
   * untouched. Two structurally undefined cases short-circuit:
   *
   * - **No-op short-circuit.** Re-keying to the existing value is a
   * user-error, not an invariant violation; respond truthfully but
   * write nothing.
   * - **Empty-set guard.** Topic-key identity is `(Topic Key,
   * Project-set)`-keyed. A memory with no projects has no identity
   * slot to re-key into; rejecting is structurally correct (matches
   * the upsert path's empty-project rejection).
   *
   * **Cross-kind collision detection is intentional.** The collision
   * check delegates to `findByTopicKey`, which is deliberately
   * Kind-agnostic (see its docstring) — a re-key onto a slot held by a
   * task or decision under the same key surfaces as a collision and is
   * rejected, even if the re-keyed memory is a different Kind. Lore
   * does NOT auto-merge two topic chains; the operator handles the
   * duplication manually (archive one, re-key the other).
   *
   * **Archived rows do NOT count as collisions.** `findByTopicKey`
   * post-filters `!page.archived`, so a re-key onto a key held only
   * by archived rows succeeds. Intentional per the spec ("must not
   * collide with another **live** memory in the same project-set"):
   * archived rows are out of the active upsert chain. Edge case to
   * track: un-archiving the old row after a re-key would land two
   * live members under the same `(Topic Key, Project-set)` slot.
   * Operators that un-archive should re-check chain integrity via
   * `lore-memory action='recall'`.
   *
   * **Skip-self in collision check.** A memory whose `Topic Key`
   * already equals `newTopicKey` would otherwise self-collide. The
   * no-op short-circuit at step 2 catches this when the OLD key
   * already matches; the explicit `collision.id !== input.memoryId`
   * guard at step 4 catches the eventual-consistency window where
   * `findByTopicKey`'s post-write index lag could surface the same
   * row. Defense in depth — neither guard alone covers both cases.
   *
   * **Property write FIRST, audit-block append SECOND.** The reverse
   * order would create a worse partial state on a transient failure
   * (audit succeeds → property fails → body falsely claims a re-key
   * while the property holds the old key, and a retry duplicates the
   * audit). With property-first, an audit-failure leaves the
   * structural identity change in place and only the cosmetic audit
   * trail at risk. The audit-failure path throws `RekeyAuditError`
   * (a distinct subclass of `Error`) so callers can distinguish
   * "re-key didn't happen" from "re-key happened but audit is
   * missing." See the inline `try/catch` and the `RekeyAuditError`
   * class docstring for the full rationale.
   *
   * **Body-write uses `replace_content` with `new_str`** to match
   * the existing `update()` body-write pattern in this file. The
   * markdown is read first via `pages.retrieveMarkdown` (inside
   * `getById`), the audit block is concatenated, then the full body
   * is rewritten. Concurrent re-keys against the same memory could
   * race past each other and clobber each other's audit blocks —
   * same posture as the documented concurrent-upsert risk, fixed
   * if real-vault data shows the race matters.
   */
  /**
   * Pre-validate a `rekeyTopicKey` call without performing any
   * mutation. Returns the loaded memory + old topic key + a flag
   * indicating whether the re-key would actually do work
   * (`willRekey === false` for the no-op short-circuit case).
   * Throws the same structured errors `rekeyTopicKey` would —
   * empty-projectIds rejection, collision rejection — so callers
   * can surface those failures BEFORE running unrelated mutations.
   *
   * The `lore-memory action='update'` MCP handler calls this
   * before applying a residual content delta so a topicKey-only
   * rejection (collision, empty-projectIds) doesn't leave the
   * content update half-persisted with the operator looking at
   * an error response.
   *
   * **Race window with subsequent `rekeyTopicKey`.** This method
   * loads memory state once and runs the collision query against
   * that snapshot. By the time the caller actually invokes
   * `rekeyTopicKey`, another agent could have grabbed the slot,
   * the row's projectIds could have changed (via a concurrent
   * update), or a transient Notion failure could surface during
   * the mutation. None of those cases retroactively invalidate
   * the preflight; they're caught by `rekeyTopicKey`'s own
   * validation pass and propagated through whatever exception
   * the caller wraps them in (e.g. `PartialUpdateError` at the
   * MCP layer when content has already landed).
   */
  async validateRekey(input: {
    memoryId: string
    newTopicKey: string
  }): Promise<{ memory: Memory; oldTopicKey: string; willRekey: boolean }> {
    const memory = await this.deps.getById(input.memoryId)
    const oldTopicKey = memory.topicKey

    if (oldTopicKey === input.newTopicKey) {
      return { memory, oldTopicKey, willRekey: false }
    }

    if (memory.projectIds.length === 0) {
      throw new Error(
        "Cannot re-key a memory with empty projectIds. " +
          "Topic-key identity requires at least one project."
      )
    }

    const collision = await this.findByTopicKey({
      topicKey: input.newTopicKey,
      projectIds: memory.projectIds,
    })
    if (collision && collision.id !== input.memoryId) {
      throw new Error(
        `Re-key target '${input.newTopicKey}' is already in use by ` +
          `memory ${collision.id} in this project-set. ` +
          `Lore does not auto-merge — archive one or pick a different key.`
      )
    }

    return { memory, oldTopicKey, willRekey: true }
  }

  async rekeyTopicKey(input: {
    memoryId: string
    newTopicKey: string
  }): Promise<{ memory: Memory; oldTopicKey: string }> {
    // `validateRekey` re-runs the same loads and checks
    // `rekeyTopicKey` performs inline. The duplication is
    // intentional: callers that pre-validated via the MCP
    // handler still go through the authoritative validation
    // here so direct callers of `rekeyTopicKey` (anyone
    // bypassing the handler) get the full safety net.
    const { memory, oldTopicKey, willRekey } = await this.validateRekey(input)
    if (!willRekey) {
      return { memory, oldTopicKey }
    }

    // Property write FIRST, audit block SECOND. The reverse order
    // (audit then property) was the original spec but creates a worse
    // partial-state: an audit-write success followed by a property-
    // write failure leaves the body falsely claiming a re-key while
    // the property still holds the old key, AND a retry would append
    // a SECOND audit block before the property write could succeed.
    //
    // With property-first, the failure modes are:
    //
    // 1. **Property write fails.** Nothing was written. The memory is
    // unchanged. A retry runs the full pipeline cleanly — collision
    // check is still valid, no body drift. The thrown error matches
    // a normal Notion error.
    // 2. **Property write succeeds, audit append fails.** The re-key
    // persisted (the load-bearing identity change). Only the
    // cosmetic audit trail is missing. A retry would observe
    // `oldTopicKey === newTopicKey` (we already updated the
    // property), short-circuit through the no-op guard, and exit
    // without re-attempting the audit. The audit block is
    // permanently lost — but the row's structural state is
    // correct and self-consistent.
    //
    // The audit-append failure throws a structured `RekeyAuditError`
    // so callers can distinguish "rekey didn't happen" from "rekey
    // happened but audit is missing." The MCP response surfaces the
    // distinction in the error message; operators triaging the
    // failure see the new key persisted on Notion.
    await this.client.pages.update({
      page_id: input.memoryId,
      // Direct partial-property update — matches `update()`'s
      // targeted shape rather than going through `buildMemoryProps`
      // (which always writes Title and would needlessly disturb the
      // title cache). Re-keying touches `Topic Key` only; `Revision
      // Count` and `Last Referenced At` are deliberately untouched.
      properties: {
        [MEMORY_PROPS.TOPIC_KEY]: {
          rich_text: [{ text: { content: input.newTopicKey } }],
        },
      } as CreatePageParameters["properties"],
    })

    const today = todayUtc()
    const auditBlock = [
      "",
      "---",
      "",
      `## Re-keyed (${today})`,
      "",
      `**From:** \`${oldTopicKey || "(unset)"}\``,
      `**To:** \`${input.newTopicKey}\``,
    ].join("\n")
    const newBody = memory.content + auditBlock

    // Anchored append via RunTool when the flag is on and the body has a
    // unique tail substring. The wire payload is the tail
    // anchor + the small audit block rather than the full body — a
    // proportional reduction for large memory bodies. The
    // `RekeyAuditError` partial-state contract is preserved across both
    // paths: a property write that lands followed by an audit-append
    // failure (RunTool or REST) raises `RekeyAuditError` so callers can
    // distinguish "re-key didn't happen" from "re-key happened but
    // audit is missing." The fall-back-able RunTool signals
    // (`no_match` / `multiple_matches` / `deletion_warning` /
    // `restricted_resource`) drop through to the existing
    // `replace_content` path so a stale anchor never leaves the audit
    // block stranded. `restricted_resource` is load-bearing for
    // integration-secret operators: the auth-refresh proxy cannot
    // repair the 403, but the REST/SDK path can — silently widening
    // the catch back to validation-only would re-introduce the
    // outage path the security review B1/B2 fixed.
    const rekeyFlagOn = this.features.runTool.blockEdit
    const rekeyAnchor = rekeyFlagOn ? pickRekeyAuditAnchor(memory.content) : null
    if (rekeyFlagOn && rekeyAnchor === null) {
      debugLogRekeyAnchorMiss(input.memoryId, memory.content.length)
    }
    let auditApplied = false
    if (rekeyAnchor !== null) {
      try {
        await updatePageContentViaRunTool(this.client, {
          pageId: input.memoryId,
          updates: [{ oldStr: rekeyAnchor, newStr: rekeyAnchor + auditBlock }],
        })
        auditApplied = true
      } catch (err) {
        if (!(err instanceof RunToolBlockEditError)) {
          throw buildRekeyAuditError(input.memoryId, oldTopicKey, input.newTopicKey, err)
        }
        // Structured fall-back signal (no_match / multiple_matches /
        // deletion_warning / restricted_resource): drop through to the
        // REST path. RunTool's own deferral counter could be threaded
        // through here once the A/B harness is in place.
      }
    }

    if (!auditApplied) {
      try {
        await this.client.pages.updateMarkdown({
          page_id: input.memoryId,
          type: "replace_content",
          replace_content: {
            new_str: newBody,
            allow_deleting_content: true,
          },
        })
      } catch (err) {
        throw buildRekeyAuditError(input.memoryId, oldTopicKey, input.newTopicKey, err)
      }
    }

    return {
      memory: { ...memory, topicKey: input.newTopicKey, content: newBody },
      oldTopicKey,
    }
  }
}

export type FindByTopicKeyInput = Parameters<MemoryTopicKey["findByTopicKey"]>[0]
export type TopicKeyUpsertInput = Parameters<MemoryTopicKey["upsertByTopicKey"]>[0]
export type TopicKeyUpsertResult = Awaited<ReturnType<MemoryTopicKey["upsertByTopicKey"]>>
export type RekeyTopicKeyInput = Parameters<MemoryTopicKey["rekeyTopicKey"]>[0]
export type RekeyValidationResult = Awaited<ReturnType<MemoryTopicKey["validateRekey"]>>
export type RekeyTopicKeyResult = Awaited<ReturnType<MemoryTopicKey["rekeyTopicKey"]>>
