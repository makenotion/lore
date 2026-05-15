import type { Client, PageObjectResponse } from "@notionhq/client"
import type {
  CreateMemoryInput,
  DatabaseRef,
  FreshCreatePreparation,
  Memory,
  MemoryScopeInput,
} from "../types.js"
import { buildMemoryProps, MEMORY_PROPS } from "../notion/schema.js"
import { decodeTextEntities } from "../notion/html-entities.js"
import { LoreError, errorCauseMessage } from "../errors.js"
import type { LoreFeatureFlags } from "../feature-flags.js"
import { validateRichTextMetadataFields } from "./rich-text-schema.js"
import {
  findAutosaveLearningDuplicate,
  MEMORY_CLEANUP_ORPHAN_SENTINEL,
  type AutosaveLearningDuplicateMatch,
  type MemoryLister,
} from "./near-duplicate.js"
import { withAutosaveLearningLock } from "./autosave-learning-lock.js"
import { pinnedInputToBuilderProps } from "./memory-pinned.js"

const AUTOSAVE_LEARNING_POST_CREATE_STABILIZE_MS = 500
const AUTOSAVE_LEARNING_POST_CREATE_POLL_MS = 50

type AutosaveLearningDuplicateConfig =
  | { scope: "session"; session: string; projectIds: string[]; scopeId: string | null }
  | { scope: "project"; session: string; projectIds: string[]; scopeId: string | null }

type MemoryCreateDeps = {
  duplicateLister: MemoryLister
  preflightPinnedCreate: (input: CreateMemoryInput["pinned"]) => Promise<void>
  invalidatePinnedCountCache: () => void
  pageToMemory: (page: PageObjectResponse, content: string) => Promise<Memory>
}

function parseNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined) return fallback
  if (!/^[0-9]+$/.test(raw)) return fallback
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : fallback
}

function autosaveLearningPostCreateStabilizeMs(): number {
  return parseNonNegativeIntegerEnv(
    "LORE_AUTOSAVE_LEARNING_POST_CREATE_STABILIZE_MS",
    AUTOSAVE_LEARNING_POST_CREATE_STABILIZE_MS
  )
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Translate the agent-facing `MemoryScopeInput` bundle into the flat
 * primitive shape `buildMemoryProps` / `buildFactProps` consume. The
 * builders themselves stay one-primitive-per-Notion-column so the
 * write path is identical regardless of which surface produced the
 * scope (CLI, MCP, or internal migration).
 *
 * `undefined` input → `undefined` outputs across the board (no
 * column writes). Spread the result into the builder call so omitted
 * scopes leave the caller's surface untouched.
 */
function scopeInputToBuilderProps(scope: MemoryScopeInput | undefined): {
  scopeKind?: string | null
  scopeKey?: string
  audience?: string
  lifetime?: string | null
  expiresAt?: string | null
} {
  if (scope === undefined) return {}
  const out: ReturnType<typeof scopeInputToBuilderProps> = {}
  if (scope.kind !== undefined) out.scopeKind = scope.kind
  if (scope.key !== undefined) out.scopeKey = scope.key
  if (scope.audience !== undefined) out.audience = scope.audience
  if (scope.lifetime !== undefined) out.lifetime = scope.lifetime
  if (scope.expiresAt !== undefined) out.expiresAt = scope.expiresAt
  return out
}

/**
 * Every plain-text field that flows through the agent boundary and lands
 * in a Memory page. Run them through `decodeTextEntities` before writing
 * so doubly-encoded autosave input (`&amp;amp;`) resolves to plain text
 * and future similarity / embedding surfaces see consistent values.
 * Sibling: `decodeDecisionTextFields` — keep shared field coverage
 * in lockstep.
 *
 * Coverage is deliberately explicit rather than derived from
 * `CreateMemoryInput` so a future plain-text field addition fails the
 * type-check here and forces a decision about whether to decode. If the
 * coverage ever diverges from `CreateMemoryInput`'s rich_text shape, the
 * drift stays visible in the compiler rather than in a downstream
 * similarity regression.
 */
function decodeMemoryTextFields(input: CreateMemoryInput): {
  title: string
  content: string
  alternatives: string | undefined
  consequences: string | undefined
  author: string | undefined
  agent: string | undefined
  keywords: string | undefined
  synopsis: string | undefined
  session: string | undefined
  blockedBy: string | undefined
  entity: string | undefined
} {
  return {
    title: decodeTextEntities(input.title),
    content: input.content ? decodeTextEntities(input.content) : "",
    alternatives:
      input.alternatives !== undefined
        ? decodeTextEntities(input.alternatives)
        : undefined,
    consequences:
      input.consequences !== undefined
        ? decodeTextEntities(input.consequences)
        : undefined,
    author: input.author !== undefined ? decodeTextEntities(input.author) : undefined,
    agent: input.agent !== undefined ? decodeTextEntities(input.agent) : undefined,
    keywords:
      input.keywords !== undefined ? decodeTextEntities(input.keywords) : undefined,
    synopsis:
      input.synopsis !== undefined ? decodeTextEntities(input.synopsis) : undefined,
    session: input.session !== undefined ? decodeTextEntities(input.session) : undefined,
    blockedBy:
      input.blockedBy !== undefined ? decodeTextEntities(input.blockedBy) : undefined,
    entity: input.entity !== undefined ? decodeTextEntities(input.entity) : undefined,
  }
}

/**
 * Structured partial-state error raised by `MemoryService.create`
 * when the `pages.create` call landed (a Memories DB row exists) but
 * the follow-up `pages.updateMarkdown` body-write rejected. Notion's
 * SDK splits memory creation across two calls — properties first, body
 * second — and a failure between them would otherwise leave a
 * properties-only orphan in the vault that a naive retry would
 * duplicate rather than reuse.
 */
export class MemoryCreatePartialFailureError extends LoreError<"memory-create-partial"> {
  readonly pageId: string
  readonly cleanedUp: boolean
  readonly bodyWriteError: unknown
  readonly cleanupError: unknown

  constructor(
    message: string,
    details: {
      pageId: string
      cleanedUp: boolean
      bodyWriteError: unknown
      cleanupError?: unknown
    }
  ) {
    super(
      "memory-create-partial",
      message,
      {
        pageId: details.pageId,
        cleanedUp: details.cleanedUp,
        bodyWriteCauseMessage: errorCauseMessage(details.bodyWriteError),
        ...(details.cleanupError !== undefined
          ? { cleanupCauseMessage: errorCauseMessage(details.cleanupError) }
          : {}),
      },
      { cause: details.bodyWriteError }
    )
    this.name = "MemoryCreatePartialFailureError"
    this.pageId = details.pageId
    this.cleanedUp = details.cleanedUp
    this.bodyWriteError = details.bodyWriteError
    this.cleanupError = details.cleanupError
  }
}

export interface MemoryCreateResult {
  memory: Memory
  autosaveLearningDuplicate: AutosaveLearningDuplicateMatch | null
  freshCreatePreparation: FreshCreatePreparation | null
}

export class MemoryCreate {
  constructor(
    private readonly client: Client,
    private readonly db: DatabaseRef,
    private readonly features: LoreFeatureFlags,
    private readonly deps: MemoryCreateDeps
  ) {}

  async createWithResult(input: CreateMemoryInput): Promise<MemoryCreateResult> {
    validateRichTextMetadataFields(input, "MemoryService.create")

    const duplicateConfig = this.autosaveLearningDuplicateConfig(input)
    const lockKey = duplicateConfig
      ? `autosave-learning:${duplicateConfig.scope}:` +
        (duplicateConfig.scope === "project"
          ? duplicateConfig.projectIds.join(",")
          : `${duplicateConfig.scopeId ?? "global"}\0${duplicateConfig.session}`)
      : null

    return await withAutosaveLearningLock(lockKey, async () => {
      if (duplicateConfig) {
        const decoded = decodeMemoryTextFields(input)
        const duplicate = await findAutosaveLearningDuplicate(this.deps.duplicateLister, {
          title: decoded.title,
          content: decoded.content,
          projectId: duplicateConfig.projectIds[0],
          projectIds: duplicateConfig.projectIds,
          session: duplicateConfig.session,
          scope: duplicateConfig.scope,
          features: this.features,
        })
        if (duplicate) {
          return {
            memory: duplicate.memory,
            autosaveLearningDuplicate: duplicate,
            freshCreatePreparation: null,
          }
        }
      }

      const freshCreatePreparation = input.prepareFreshCreate
        ? await input.prepareFreshCreate()
        : null
      const freshInput = freshCreatePreparation
        ? { ...input, ...freshCreatePreparation.input }
        : input
      const memory = await this.createFresh(freshInput)
      if (duplicateConfig) {
        await this.waitForAutosaveLearningIndexStability(
          duplicateConfig,
          memory,
          freshInput
        )
      }

      return {
        memory,
        autosaveLearningDuplicate: null,
        freshCreatePreparation,
      }
    })
  }

  private autosaveLearningDuplicateConfig(
    input: CreateMemoryInput
  ): AutosaveLearningDuplicateConfig | null {
    if (
      input.autosaveLearningDedupScope === "off" ||
      !this.features.autosaveLearningDedup ||
      !this.features.nearDuplicateProbe
    ) {
      return null
    }
    if ((input.source ?? "manual") !== "conversation") return null
    if ((input.kind ?? "note") !== "note") return null
    if (input.confidence !== "likely") return null

    const session = input.session?.trim()
    if (!session) return null

    const projectIds = [...new Set(input.projectIds ?? [])].sort()
    const requestedScope =
      input.autosaveLearningDedupScope ?? (projectIds.length > 0 ? "project" : "session")
    const scope =
      requestedScope === "project" && projectIds.length > 0 ? "project" : "session"
    const scopeId = input.autosaveLearningScopeId?.trim() || null

    return { scope, session, projectIds, scopeId }
  }

  private async waitForAutosaveLearningIndexStability(
    duplicateConfig: AutosaveLearningDuplicateConfig,
    memory: Memory,
    input: CreateMemoryInput
  ): Promise<void> {
    const timeoutMs = autosaveLearningPostCreateStabilizeMs()
    if (timeoutMs <= 0) return

    const decoded = decodeMemoryTextFields(input)
    const deadline = Date.now() + timeoutMs
    while (true) {
      try {
        const visible = await findAutosaveLearningDuplicate(this.deps.duplicateLister, {
          title: decoded.title,
          content: decoded.content,
          projectId: duplicateConfig.projectIds[0],
          projectIds: duplicateConfig.projectIds,
          session: duplicateConfig.session,
          scope: duplicateConfig.scope,
          features: this.features,
        })
        if (visible?.id === memory.id) return
      } catch {
        // The memory already landed. A transient read-side failure should not
        // convert the successful create into a partial failure; future writers
        // still fail closed on their own duplicate probe while Notion recovers.
      }

      const remainingMs = deadline - Date.now()
      if (remainingMs <= 0) return
      await sleep(Math.min(AUTOSAVE_LEARNING_POST_CREATE_POLL_MS, remainingMs))
    }
  }

  private async createFresh(input: CreateMemoryInput): Promise<Memory> {
    // Decode at the write boundary so doubly-encoded values from the
    // autosave/markdown path land in Notion as plain text. Idempotent: a
    // clean value passes through unchanged. Covers every plain-text
    // field that flows through the agent boundary — title, content body,
    // and the rich_text fields that downstream similarity/embedding
    // surfaces (near-duplicate probe, entity canonicalization,
    // DS-scoped search) will read.
    const decoded = decodeMemoryTextFields(input)
    const createsPinnedBlock = input.pinned?.pinned === true
    await this.deps.preflightPinnedCreate(input.pinned)

    // Create the page with properties only
    const page = await this.client.pages.create({
      parent: { type: "database_id", database_id: this.db.databaseId },
      properties: buildMemoryProps({
        title: decoded.title,
        projectIds: input.projectIds,
        topicId: input.topicId,
        source: input.source ?? "manual",
        kind: input.kind,
        status: input.status,
        confidence: input.confidence,
        confidenceScore: input.confidenceScore,
        reviewBy: input.reviewBy,
        decidedAt: input.decidedAt,
        lastReferencedAt: input.lastReferencedAt,
        supersedesIds: input.supersedesIds,
        affectsIds: input.affectsIds,
        alternatives: decoded.alternatives,
        consequences: decoded.consequences,
        author: decoded.author,
        agent: decoded.agent,
        tags: input.tags,
        keywords: decoded.keywords,
        synopsis: decoded.synopsis,
        session: decoded.session,
        taskState: input.taskState,
        blockedBy: decoded.blockedBy,
        entity: decoded.entity,
        topicKey: input.topicKey,
        revisionCount: input.revisionCount,
        ...scopeInputToBuilderProps(input.scope),
        ...pinnedInputToBuilderProps(input.pinned),
      }),
    })
    if (createsPinnedBlock) {
      this.deps.invalidatePinnedCountCache()
    }

    // Write content via markdown API. The SDK splits memory creation
    // across two calls — properties above, body below — so a rejection
    // here would otherwise leave a properties-only orphan that a naive
    // retry would duplicate. Best-effort archive the orphan, then
    // surface a structured error carrying enough state for the caller
    // to retry safely or surface the failure to the operator. See
    // `MemoryCreatePartialFailureError`.
    if (decoded.content) {
      try {
        await this.client.pages.updateMarkdown({
          page_id: page.id,
          type: "insert_content",
          insert_content: { content: decoded.content },
        })
      } catch (bodyWriteError) {
        // Direct `pages.update` rather than `MemoryService.archive()`:
        // the page was just created in this same call, so the
        // title-cache delete-then-tombstone-set discipline `archive()`
        // performs to protect concurrent readers cannot apply — no
        // consumer has had time to cache the title or dispatch a
        // racing read against this id. Inlining keeps the cleanup a
        // single round-trip with no incidental cache work.
        //
        // Cleanup writes BOTH `archived: true` AND the
        // `MEMORY_CLEANUP_ORPHAN_SENTINEL` keyword in one atomic
        // `pages.update`. Notion's archive is soft —
        // within ~30 days the orphan can be restored from the workspace
        // trash, at which point `isLiveFullPage` stops excluding it.
        // The sentinel keyword survives archive/restore round-trips and
        // is the load-bearing signal for `findByTopicKey`,
        // `findNearDuplicates`, and `findAutosaveLearningDuplicate`
        // ignoring the resurfaced empty-body shell. Combining the two
        // mutations into one request closes the window where archive
        // succeeds but the sentinel write fails — Notion's per-request
        // atomicity guarantees both land or neither does.
        //
        // **Keyword preservation**. Notion's `rich_text` writes are
        // full-replace, not append. Writing only the sentinel would
        // clobber whatever the caller passed in `decoded.keywords`,
        // which an operator inspecting Notion's trash would see as
        // "your original keywords are gone" — the sentinel and the
        // user's content. Concatenating preserves both: the sentinel
        // substring still satisfies the `does_not_contain` /
        // `keywords.includes` filters, and the original keywords
        // remain visible if the operator restores the row to recover
        // content. Use a single-space separator so the sentinel is
        // word-tokenizable in any future tag-aware view; an empty
        // existing keywords field collapses to bare-sentinel.
        //
        // **Multi-segment write at the cap edge**. Notion's per-block
        // `rich_text` segment cap is 2000 chars
        // (`RICH_TEXT_PROPERTY_MAX_LEN`), and the MCP boundary's
        // `keywordsSchema` accepts keywords up to exactly that cap.
        // Concatenating ` __lore-cleanup-orphan` (22 chars) onto a
        // 2000-char keyword string would produce a 2022-char single
        // segment that Notion rejects with a validation error. A
        // rejected cleanup write means `cleanedUp = false` and the
        // orphan stays live in the vault — exactly the partial-failure
        // recovery regression the sentinel-write path is meant to
        // prevent. Splitting
        // into two segments — `[originalKeywords, " sentinel"]` —
        // keeps each segment well under the cap; `extractRichText`
        // joins them via empty-string concat, so the substring filter
        // (`does_not_contain` server-side, `keywords.includes`
        // client-side) still sees the unified `original sentinel`
        // string. Always use the two-segment form when keywords are
        // present so the at-cap edge is handled by the same code path
        // as the under-cap normal case — no segment-size math at write
        // time, no edge-case branching.
        const existingKeywords = decoded.keywords?.trim() ?? ""
        const cleanupKeywordsRichText: Array<{ text: { content: string } }> =
          existingKeywords.length > 0
            ? [
                { text: { content: existingKeywords } },
                { text: { content: ` ${MEMORY_CLEANUP_ORPHAN_SENTINEL}` } },
              ]
            : [{ text: { content: MEMORY_CLEANUP_ORPHAN_SENTINEL } }]
        let cleanedUp = false
        let cleanupError: unknown
        try {
          await this.client.pages.update({
            page_id: page.id,
            archived: true,
            properties: {
              [MEMORY_PROPS.KEYWORDS]: {
                rich_text: cleanupKeywordsRichText,
              },
            },
          })
          cleanedUp = true
        } catch (err) {
          cleanupError = err
        }
        const cause =
          bodyWriteError instanceof Error
            ? bodyWriteError.message
            : String(bodyWriteError)
        const message = cleanedUp
          ? `Memory create partial failure: the Memories DB row was ` +
            `created (page ${page.id}) but the body write failed: ${cause}. ` +
            `The orphan row was soft-archived to Notion's trash and its ` +
            `Keywords column carries the '${MEMORY_CLEANUP_ORPHAN_SENTINEL}' ` +
            `sentinel so dedup probes ignore it even if it is later restored ` +
            `from trash. Your retry will land cleanly regardless of whether ` +
            `you restore this row from trash later.`
          : `Memory create partial failure: the Memories DB row was ` +
            `created (page ${page.id}) but the body write failed: ${cause}. ` +
            `The cleanup archive also failed (${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }); the orphan row remains live in the vault. Archive it ` +
            `manually (or hard-delete from Notion's trash) before retrying ` +
            `to avoid a duplicate row.`
        throw new MemoryCreatePartialFailureError(message, {
          pageId: page.id,
          cleanedUp,
          bodyWriteError,
          cleanupError,
        })
      }
    }

    return await this.deps.pageToMemory(page as PageObjectResponse, decoded.content ?? "")
  }
}
