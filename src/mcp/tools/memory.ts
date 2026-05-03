import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import type { LoreServices } from "../server.js"
import {
  debugLogAutoFactFailure,
  formatDispatchError,
  paginationFooter,
  toolError,
  debugLogPartialFailures,
  fireTouchOnRead,
} from "../helpers.js"
import { resolveProjectIds, resolveReadProjectScope } from "../resolve.js"
import { settleAll } from "../../core/settle.js"
import type {
  Fact,
  Memory,
  MemoryKind,
  MemorySource,
  MemoryStatus,
  MemoryConfidence,
  SearchMode,
  SearchExplain,
} from "../../types.js"
import { SYNOPSIS_MAX } from "../../types.js"
import { tagsSchema, keywordsSchema } from "./tag-schema.js"
import {
  RICH_TEXT_PROPERTY_MAX_LEN,
  richTextPropertySchema,
} from "../../core/rich-text-schema.js"
import {
  extractEntityCandidates,
  findAutosaveLearningDuplicate,
  findNearDuplicates,
  findRelatedActiveTasks,
  type AutosaveLearningDuplicateMatch,
  type NearDuplicateMatch,
} from "../../core/near-duplicate.js"
import { decodeTextEntities } from "../../notion/html-entities.js"
import { defaultMemoryMetaBuilder, formatMemoryListItem } from "../render.js"
import { suggestTopicKey, type TopicKeySuggestion } from "../../core/topic-key.js"
import {
  appendCompareDispatchLedgerEntry,
  appendCompareNote,
  buildCompareDispatchLedgerEntry,
  hasCompareDispatchLedgerEntry,
  hasMatchingCompareNote,
  MemoryUpdatePartialFailureError,
  PartialUpdateError,
  recordContradiction,
  recordSupersedence,
  RekeyAuditError,
  type PromotionAdvisory,
  type RecordComparedResult,
} from "../../core/memory.js"
import { CONFLICT_JUDGE_PROMPT_VERSION } from "../../core/prompts/conflict-judge.js"
import type { TaskSummary } from "../../types.js"
import { resolveAuthorForWrite } from "../../auth/identity.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

/**
 * Trigram threshold for the `lore-memory action='save'` near-duplicate
 * probe. Matches the P2-03 spec's initial guess — tune after rollout if
 * we see false positives flooding the response footer on legitimately-
 * distinct memories sharing boilerplate title wording.
 */
const MEMORY_NEAR_DUPLICATE_THRESHOLD = 0.7

/** Cap the probe candidate pool. See `findNearDuplicates` docstring. */
const NEAR_DUPLICATE_POOL_LIMIT = 50

/** Cap the session-scoped duplicate pool for Stop-spawn atomic learnings. */
const AUTOSAVE_LEARNING_DUPLICATE_POOL_LIMIT = 50

/**
 * Topic-key format (0.9.0/#06): kebab-case path like `decision/jwt-auth`.
 * Requires a `family/key` shape — at least one slash separator —
 * because the `suggest-topic-key` heuristic always emits
 * `${family}/${slug}` (per `src/core/topic-key.ts`'s `KIND_TO_FAMILY`)
 * and the upsert grouping is meaningful only when the family prefix is
 * present. Single-segment tokens (e.g. `decision` alone) are rejected
 * at the Zod boundary so the contract between suggester and upsert
 * stays tight: any key the suggester would return is accepted, and
 * any key it wouldn't is a typo or contract violation.
 *
 * Format violations are validation errors, not silent acceptance —
 * a malformed `topicKey` is almost always a typo, not a deliberate
 * choice.
 */
const TOPIC_KEY_REGEX = /^[a-z0-9]+\/[a-z0-9-]+(\/[a-z0-9-]+)*$/

/** Max candidates to surface in the response. */
const NEAR_DUPLICATE_SURFACE_LIMIT = 3

function formatNearDuplicateMatches(matches: NearDuplicateMatch[]): string[] {
  const lines: string[] = []
  const shown = matches.slice(0, NEAR_DUPLICATE_SURFACE_LIMIT)
  lines.push(
    `Warning: ${matches.length} existing ${matches.length === 1 ? "memory looks" : "memories look"} similar:`
  )
  for (const m of shown) {
    const sim = m.titleSimilarity.toFixed(2)
    const tagPart = m.tagOverlap > 0 ? `, tag overlap ${m.tagOverlap.toFixed(2)}` : ""
    lines.push(`  - "${m.title}" (${m.id}) — trigram ${sim}${tagPart}`)
  }
  if (matches.length > shown.length) {
    lines.push(`  - …and ${matches.length - shown.length} more`)
  }
  lines.push(
    "Consider `lore-memory` with `action: 'update'` on the existing row, or `lore-decision` with `action: 'create'` and `supersedesIds` if this is a formal replacement."
  )
  return lines
}

function isAutosaveLearningSave(args: SaveArgs, resolvedKind: MemoryKind): boolean {
  return (
    process.env["LORE_BACKGROUND_AGENT"] === "true" &&
    (args.source ?? "conversation") === "conversation" &&
    resolvedKind === "note" &&
    args.confidence === "likely" &&
    typeof args.session === "string" &&
    args.session.trim().length > 0
  )
}

function formatAutosaveLearningDuplicate(
  match: AutosaveLearningDuplicateMatch,
  args: SaveArgs,
  currentSession?: string
): string[] {
  const matchSession = match.session.trim()
  const normalizedCurrentSession = currentSession?.trim()
  const duplicateScope =
    normalizedCurrentSession && matchSession === normalizedCurrentSession
      ? "same-session"
      : "cross-session"
  const lines = [
    `Reused existing autosave learning (${duplicateScope} duplicate): "${match.title}" (${match.id})`,
    `Similarity: title ${match.titleSimilarity.toFixed(2)}, ` +
      `content ${match.contentSimilarity.toFixed(2)}, ` +
      `combined ${match.combinedSimilarity.toFixed(2)}, ` +
      `token ${match.tokenSimilarity.toFixed(2)}`,
    "No new memory was created. The existing memory stays available for this session.",
    "Recovery: set LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1 before autosave to force a separate row.",
  ]
  const dropped = formatDroppedAutosaveLearningFields(args)
  if (dropped) lines.splice(3, 0, dropped)
  return lines
}

function formatDroppedAutosaveLearningFields(args: SaveArgs): string | null {
  const dropped: string[] = []
  const synopsisLength = args.synopsis?.trim().length ?? 0
  if (synopsisLength > 0) dropped.push(`synopsis (${synopsisLength} chars)`)

  const keywordCount = args.keywords?.trim().split(/\s+/).filter(Boolean).length ?? 0
  if (keywordCount > 0) {
    dropped.push(`keywords (${keywordCount} ${keywordCount === 1 ? "token" : "tokens"})`)
  }

  const tagCount = args.tags?.length ?? 0
  if (tagCount > 0) dropped.push(`tags (${tagCount})`)
  if (args.agent?.trim()) dropped.push(`agent=${args.agent.trim()}`)
  if (args.author?.trim()) dropped.push(`author=${args.author.trim()}`)

  return dropped.length > 0
    ? `Dropped candidate metadata on reuse: ${dropped.join(", ")}.`
    : null
}

// eslint-disable-next-line no-control-regex -- preserving one-event-per-line logs
const DEBUG_LOG_CONTROL_CHARS = /[\x00-\x1F\x7F]/g

function debugLogField(value: string | undefined): string {
  const normalized = value && value.trim().length > 0 ? value.trim() : "none"
  return JSON.stringify(normalized.replace(DEBUG_LOG_CONTROL_CHARS, " "))
}

function debugLogAutosaveLearningScopeDowngrade(opts: {
  projectId: string
  session: string | undefined
}): void {
  if (process.env["LORE_DEBUG"] !== "1") return
  process.stderr.write(
    `[lore] autosave-learning-dedup-scope-downgrade: reason=catch-all-fallback ` +
      `projectId=${debugLogField(opts.projectId)} session=${debugLogField(opts.session)} ` +
      `source=lore-memory\n`
  )
}

const KINDS = ["note", "decision", "incident", "runbook", "postmortem", "policy"] as const

/**
 * Full `MemoryKind` set accepted by `lore-memory action='suggest-topic-key'`.
 * Includes `task` (which `KINDS` deliberately excludes — task memories are
 * written via `lore-task action='create'`, not `lore-memory`) because the
 * suggester returns a no-suggestion verdict for task / note kinds rather
 * than rejecting them, and an agent that has just received `kind: "task"`
 * from upstream should be able to ask for a key without first having to
 * special-case the kind. The flat `inputSchema`'s `kind` field uses this
 * broader enum so the MCP-visible surface accepts any kind the tool can
 * reason about; per-arm validation in the discriminated union narrows
 * back to `KINDS` for save / update.
 *
 * `satisfies readonly MemoryKind[]` plus `_SuggestKindExhaustive` below
 * mirror the `Record<MemoryKind, string | null>` exhaustiveness contract
 * in `src/core/topic-key.ts` at this MCP boundary: adding a new
 * `MemoryKind` without adding it here is a compile error, not a silent
 * runtime rejection from Zod.
 */
const SUGGEST_KIND_VALUES = [
  "note",
  "decision",
  "incident",
  "runbook",
  "postmortem",
  "policy",
  "task",
] as const satisfies readonly MemoryKind[]

/**
 * Compile-time exhaustiveness assertion: `SUGGEST_KIND_VALUES` MUST
 * cover every `MemoryKind`. The function below requires its argument
 * type to extend `(typeof SUGGEST_KIND_VALUES)[number]`; calling it
 * with `null as unknown as MemoryKind` forces `tsc` to verify that
 * every `MemoryKind` is assignable to the union of literals — a
 * subset relationship the `as const satisfies readonly MemoryKind[]`
 * annotation above does NOT enforce on its own.
 *
 * Adding a new `MemoryKind` without updating `SUGGEST_KIND_VALUES`
 * fails the assignment in this call, breaking the build. The runtime
 * cost is one no-op function call that DCE strips at bundle time.
 */
function _assertSuggestKindCovers(_kind: (typeof SUGGEST_KIND_VALUES)[number]): void {
  // intentionally empty
}
_assertSuggestKindCovers(null as unknown as MemoryKind)

const STATUSES = [
  "informational",
  "proposed",
  "accepted",
  "superseded",
  "deprecated",
  "rejected",
] as const

const CONFIDENCES = ["certain", "likely", "speculative"] as const

const SOURCES = ["conversation", "file", "manual", "agent_diary", "digest"] as const

const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/
// Save requires real dates. Update accepts empty strings so MCP callers can
// clear existing date properties while sharing the same YYYY-MM-DD contract.
const ymdDateSchema = z.string().regex(YMD_REGEX, "Must be YYYY-MM-DD format")
const clearableYmdDateSchema = z
  .string()
  .transform((value, ctx) => {
    if (value === "") return null
    if (YMD_REGEX.test(value)) return value

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Must be YYYY-MM-DD format",
    })
    return z.NEVER
  })
  .nullable()

const EXPAND_MAX_IDS = 20

// -------------------------------------------------------------------------
// Handlers — one per `lore-memory` action (save | update | archive |
// expand | suggest-topic-key). Routed by the polymorphic dispatcher's
// discriminated union.
// -------------------------------------------------------------------------

interface SaveArgs {
  title: string
  content: string
  projectName?: string
  projectNames?: string[]
  topicName?: string
  forceNewTopic?: boolean
  source?: (typeof SOURCES)[number]
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  confidence?: (typeof CONFIDENCES)[number]
  reviewBy?: string
  decidedAt?: string
  tags?: string[]
  keywords?: string
  synopsis?: string
  author?: string
  agent?: string
  session?: string
  topicKey?: string
}

async function handleSave(services: LoreServices, args: SaveArgs): Promise<ToolResult> {
  try {
    // Validate the topicKey + kind contract BEFORE any service call.
    //
    // Topic keys group recurring decision/runbook/policy/incident/
    // postmortem topics. Notes are the catch-all default and tasks are
    // lifecycle records owned by `lore-task`, so neither forms a
    // recurring topic — the suggester (`action='suggest-topic-key'`)
    // returns null for `kind: 'note'` and `kind: 'task'` for the same
    // reason. The contract is documented in AGENTS.md ("Topic keys for
    // evolving memories").
    //
    // **Position is load-bearing**: this guard runs BEFORE
    // `resolveProjectIds`, BEFORE `topics.getOrCreate` (which CREATES
    // a Topic in Notion as a side effect), and BEFORE the parallel
    // probes are dispatched. A rejected save must leave zero side
    // effects in Notion. An earlier placement after topic resolution
    // could create an orphaned Topic row that the rejected save never
    // links to. A regression test (`rejects topicKey + default-note
    // before any service call ... including topics.getOrCreate`)
    // pins this by passing `topicName` and asserting `topics.getOrCreate`,
    // `memories.create`, AND `memories.upsertByTopicKey` all stay
    // unmocked.
    //
    // Catching the omitted-kind path is also load-bearing — without
    // the default check, an agent that passes only `topicKey` (no
    // `kind`) would silently land in an upsert chain on a
    // `note`-defaulted memory.
    const resolvedKind = (args.kind as MemoryKind | undefined) ?? "note"
    if (args.topicKey && (resolvedKind === "note" || resolvedKind === "task")) {
      const reason =
        resolvedKind === "note"
          ? "notes are the catch-all default"
          : "tasks are lifecycle records owned by lore-task"

      throw new Error(
        `topicKey is not valid on kind: '${resolvedKind}'. Topic keys group ` +
          `recurring decision/runbook/policy-style topics; ${reason} and ` +
          "do not form a recurring topic. " +
          "Either omit topicKey, or set kind to one of: decision, " +
          "runbook, incident, postmortem, policy."
      )
    }

    const resolved = await resolveProjectIds(
      services,
      args.projectName,
      args.projectNames
    )
    const probeProjectId = resolved.ids[0]

    const probePromise = probeProjectId
      ? findNearDuplicates(services.memories, {
          title: args.title,
          tags: args.tags ?? [],
          projectId: probeProjectId,
          excludeKinds: ["decision"],
          threshold: MEMORY_NEAR_DUPLICATE_THRESHOLD,
          limit: NEAR_DUPLICATE_POOL_LIMIT,
          onError: (err) =>
            debugLogPartialFailures("lore-memory", [
              { rootId: "near-duplicate-probe", error: err },
            ]),
        })
      : Promise.resolve([] as NearDuplicateMatch[])

    if (isAutosaveLearningSave(args, resolvedKind)) {
      const hasExplicitProjectScope =
        Boolean(args.projectName) || Boolean(args.projectNames?.length)
      const canUseProjectAutosaveDedup =
        Boolean(probeProjectId) &&
        (hasExplicitProjectScope || !services.context.isCatchAllFallback)
      if (
        probeProjectId &&
        services.context.isCatchAllFallback &&
        !hasExplicitProjectScope
      ) {
        debugLogAutosaveLearningScopeDowngrade({
          projectId: probeProjectId,
          session: args.session,
        })
      }
      const duplicate = await findAutosaveLearningDuplicate(services.memories, {
        title: args.title,
        content: args.content,
        projectId: probeProjectId,
        projectIds: resolved.ids,
        session: args.session,
        scope: canUseProjectAutosaveDedup ? "project" : "session",
        limit: AUTOSAVE_LEARNING_DUPLICATE_POOL_LIMIT,
        onError: (err) =>
          debugLogPartialFailures("lore-memory", [
            { rootId: "autosave-learning-dedup", error: err },
          ]),
      })

      if (duplicate) {
        // Record the existing row's project scope so later same-session
        // fact creates auto-link to the row future retrieval should cite.
        services.sessionMemories.record(
          { agent: args.agent, session: args.session },
          { memoryId: duplicate.id, projectIds: duplicate.projectIds }
        )
        // No new memory means no derived auto-mentions or task-crossref
        // footer: the duplicate row's existing facts remain authoritative.
        return {
          content: [
            {
              type: "text",
              text: formatAutosaveLearningDuplicate(
                duplicate,
                args,
                args.session?.trim()
              ).join("\n"),
            },
          ],
        }
      }
    }

    const authorPromise = resolveAuthorForWrite(args.author, services.identity)

    // Active-task cross-reference probe (issue 0.7.0/11). Starts only
    // after the blocking autosave-learning dedup gate clears: duplicate
    // early returns avoid this advisory read entirely because no new memory
    // exists to cross-reference. The tradeoff is a small latency delay on
    // non-duplicate autosave saves before this read starts; it still overlaps
    // with the write below once the write path is known to create a row.
    const taskCrossrefPromise = findRelatedActiveTasks(services, {
      memoryTitle: args.title,
      memoryKeywords: args.keywords,
      memorySynopsis: args.synopsis,
      projectId: probeProjectId,
      onError: (err) =>
        debugLogPartialFailures("lore-memory", [{ rootId: "task-crossref", error: err }]),
    })

    let topicId: string | undefined
    let topicLabel = "none"
    if (args.topicName && resolved.ids.length > 0) {
      const topic = await services.topics.getOrCreate(args.topicName, resolved.ids, {
        forceNew: args.forceNewTopic,
      })
      topicId = topic.id
      // Use the canonical's stored name when normalized-equivalent
      // collapse landed on an existing row — otherwise the response
      // misleadingly echoes the caller's input even though the memory
      // is now linked to a topic with a different name.
      topicLabel = topic.name
    } else if (args.topicName) {
      resolved.warnings.push(
        `Topic "${args.topicName}" skipped (requires at least one project)`
      )
    }

    // Topic-key upsert dispatch (0.9.0/#06). When `topicKey` is set,
    // the save path looks for an existing memory with that key +
    // identical project-set and appends a revision block instead of
    // creating a fresh row. The lookup (`findByTopicKey`) is the first
    // step inside `upsertByTopicKey` and runs concurrently with the
    // probes via `Promise.all` — caller wall-clock is `max(latencies)`,
    // not summed. The kind=note guard above already short-circuited
    // the unsafe-defaulting case; from here either path is contract-
    // valid.
    // Per-user attribution (DEFERRED-ATTRIBUTION). Caller override wins
    // without touching identity resolution. Only omitted authors ask the
    // lazy resolver, whose null result collapses to undefined so
    // buildMemoryProps leaves the column empty instead of stamping a
    // placeholder.
    const resolvedAuthor = await authorPromise

    const writePromise: Promise<{
      memory: Memory
      revisionCount: number
      upserted: boolean
      promotionAdvisory: PromotionAdvisory | null
    }> = args.topicKey
      ? services.memories.upsertByTopicKey({
          topicKey: args.topicKey,
          projectIds: resolved.ids,
          title: args.title,
          content: args.content,
          kind: resolvedKind,
          source: (args.source ?? "conversation") as MemorySource,
          status: args.status as MemoryStatus | undefined,
          confidence: args.confidence as MemoryConfidence | undefined,
          topicId,
          tags: args.tags,
          keywords: args.keywords,
          synopsis: args.synopsis,
          author: resolvedAuthor,
          agent: args.agent,
          session: args.session,
          reviewBy: args.reviewBy,
          decidedAt: args.decidedAt,
        })
      : services.memories
          .create({
            title: args.title,
            content: args.content,
            projectIds: resolved.ids.length > 0 ? resolved.ids : undefined,
            topicId,
            source: args.source ?? "conversation",
            kind: args.kind as MemoryKind | undefined,
            status: args.status as MemoryStatus | undefined,
            confidence: args.confidence as MemoryConfidence | undefined,
            reviewBy: args.reviewBy,
            decidedAt: args.decidedAt,
            tags: args.tags,
            keywords: args.keywords,
            synopsis: args.synopsis,
            author: resolvedAuthor,
            agent: args.agent,
            session: args.session,
          })
          .then((memory) => ({
            memory,
            revisionCount: 1,
            upserted: false,
            // Non-topicKey saves and fresh-create upserts never carry
            // an advisory — the upsert path returns null on
            // fresh-create, so the non-topicKey branch matches that
            // posture for shape uniformity.
            promotionAdvisory: null,
          }))

    const [writeResult, nearDuplicates, relatedTasks] = await Promise.all([
      writePromise,
      probePromise,
      taskCrossrefPromise,
    ])

    const memory = writeResult.memory
    const matches = nearDuplicates.filter((m) => m.id !== memory.id)

    services.sessionMemories.record(
      { agent: args.agent, session: args.session },
      { memoryId: memory.id, projectIds: memory.projectIds }
    )

    // Auto-emit `mentions` facts (issue 0.8.0/#07). Two non-obvious
    // choices the spec pins:
    //
    // 1. Post-create placement. The `Source` relation needs the
    //    just-created memory id, so the branch runs after the
    //    `Promise.all([create, probes])` block resolves rather than
    //    alongside it.
    // 2. Deliberate double-tokenizer call. `extractEntityCandidates`
    //    ALSO runs inside `findRelatedActiveTasks` above. Coupling
    //    the two probes onto a single tokenizer pass would re-couple
    //    their failure domains and force a shared kill switch —
    //    keeping them independent lets `LORE_DISABLE_TASK_CROSSREF=1`
    //    and `LORE_DISABLE_AUTO_MENTIONS=1` toggle separately. The
    //    extractor is regex-only; the duplicate call is cheap.
    const autoMentionsDisabled = process.env["LORE_DISABLE_AUTO_MENTIONS"] === "1"
    let autoMentionsCount = 0
    let autoMentionsAttempted = 0
    if (!autoMentionsDisabled) {
      // `decodeTextEntities` matches what `createWithDedup` applies
      // internally (`src/core/fact.ts`'s decode-at-write-boundary
      // step). Decoding here as well keeps the on-the-wire `Object`
      // value byte-identical between the input the dedup-key probe
      // hashes and the input the update-time covered-set check
      // compares against — without it, an entity name surfaced by
      // the regex tokenizer that contains an HTML-decodable
      // character (`Foo &amp; Bar` → `Foo & Bar`) would be stored
      // decoded by `createWithDedup` but compared raw on update,
      // producing a wasted Notion round-trip per update per
      // affected entity. Idempotent — clean ASCII entities pass
      // through unchanged.
      const mentionedEntities = extractEntityCandidates(
        memory.title,
        memory.keywords,
        memory.synopsis
      ).map(decodeTextEntities)
      if (mentionedEntities.length > 0) {
        autoMentionsAttempted = mentionedEntities.length
        const projectIds = memory.projectIds.length > 0 ? memory.projectIds : undefined
        // The per-entity `.then(success, failure)` is load-bearing for
        // failure isolation: it converts every rejection into a
        // resolved boolean BEFORE `Promise.all` ever sees it, so a
        // single per-entity 400 (e.g. an upgraded-vault that hasn't
        // run `lore migrate` and still lacks the `mentions` select
        // option) can't sink the surviving creates. Replacing this
        // with `await Promise.all(...)` over bare `createWithDedup`
        // calls would re-introduce fail-fast semantics — surviving
        // creates would still resolve under the hood (Notion already
        // accepted them) but the caller's await would re-throw the
        // first rejection, the surrounding `try/catch` would emit a
        // tool-level error, and the user would see a save failure
        // even though the memory landed. `Promise.allSettled` would
        // produce the same end state but at the cost of a per-row
        // `.status === 'fulfilled'` filter at the consumer; the
        // current shape lets the success/failure callbacks return
        // typed booleans the count operation can sum directly.
        const results = await Promise.all(
          mentionedEntities.map((entity) =>
            services.facts
              .createWithDedup({
                subject: memory.title,
                predicate: "mentions",
                object: entity,
                sourceMemoryId: memory.id,
                projectIds,
                confidence: "speculative",
              })
              .then(
                () => true,
                (err: unknown) => {
                  debugLogAutoFactFailure("save", memory.id, entity, err)
                  return false
                }
              )
          )
        )
        autoMentionsCount = results.filter(Boolean).length
      }
    }

    const projectLabel = args.projectNames?.length
      ? args.projectNames.join(", ")
      : (args.projectName ?? services.context.project?.name ?? "none (repo-wide)")

    // Header line distinguishes upsert-append from fresh-create so the
    // agent knows which path fired without parsing for revision count.
    // "Created (revision 1, topic key 'X')" / "Appended as revision N
    // (topic key 'X')" wording matches the spec footer for #06.
    const headerLine = args.topicKey
      ? writeResult.upserted
        ? `Saved memory: "${memory.title}" (${memory.id}) — Appended as revision ${writeResult.revisionCount} (topic key '${args.topicKey}')`
        : `Saved memory: "${memory.title}" (${memory.id}) — Created (revision 1, topic key '${args.topicKey}')`
      : `Saved memory: "${memory.title}" (${memory.id})`
    const lines = [headerLine, `Project: ${projectLabel}`, `Topic: ${topicLabel}`]
    if (resolved.warnings.length > 0) {
      lines.push(`Warnings: ${resolved.warnings.join("; ")}`)
    }
    if (matches.length > 0) {
      lines.push("", ...formatNearDuplicateMatches(matches))
    }
    if (relatedTasks.length > 0) {
      lines.push("", ...formatRelatedTaskCrossref(relatedTasks))
    }
    // Advisory footer — emitted whenever the tokenizer produced at
    // least one candidate, so an operator inspecting a save with
    // entities ALWAYS sees a signal whether the work actually landed
    // (count == attempted), partially landed (count < attempted,
    // failures logged under LORE_DEBUG=1), or fully failed (count =
    // 0/N). A kill-switched run (LORE_DISABLE_AUTO_MENTIONS=1) and a
    // run with no extractable entities both stay silent (no
    // attempted count to surface).
    if (autoMentionsAttempted > 0) {
      lines.push(
        autoMentionsCount === autoMentionsAttempted
          ? `Auto-mentions: ${autoMentionsCount}`
          : `Auto-mentions: ${autoMentionsCount}/${autoMentionsAttempted} attempted`
      )
    }
    // Promotion advisory (0.9.0/#15). Renders only when the upsert
    // path returned a non-null advisory — fresh-create upserts and
    // non-topicKey saves both surface as null upstream and produce no
    // footer. The `<this-memory-id>` placeholder in the suggestion is
    // substituted with the just-saved memory's id so the operator can
    // copy-paste the promotion incantation directly.
    //
    // Loose `!= null` rather than strict `!== null`: the runtime type
    // contract guarantees `PromotionAdvisory | null` (the writePromise
    // type pin above is authoritative), but #06-era test fixtures cast
    // through `as never` and don't supply `promotionAdvisory` at all,
    // so they observe `undefined` here. Treating both as "no advisory"
    // is correct under both shapes; production callers cannot supply
    // `undefined` because TypeScript rejects it at the writePromise
    // assignment.
    if (writeResult.promotionAdvisory != null) {
      lines.push("", ...formatPromotionAdvisory(writeResult.promotionAdvisory, memory.id))
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    }
  } catch (err) {
    return toolError(err)
  }
}

/**
 * Render the promotion advisory footer (issue 0.9.0/#15) for the
 * upsert response. Surfaces "this topic chain is getting long,
 * consider promoting" when revision count or body length crosses
 * threshold. Informational only — never blocks the save, never
 * auto-promotes.
 *
 * The `<this-memory-id>` placeholder in the core advisory's
 * `suggestion` string is substituted with the just-saved memory's
 * id at render time so the operator can copy-paste the incantation
 * directly. The substitution lives at the MCP boundary rather than
 * in `computePromotionAdvisory` for separation of concerns: the
 * core helper is pure id-free value computation; the rendering
 * layer owns formatting decisions including which placeholder
 * substitutions to apply. `replaceAll` (not `replace`) so a future
 * suggestion-string evolution that mentions the id more than once
 * substitutes every occurrence rather than only the first.
 */
function formatPromotionAdvisory(
  advisory: PromotionAdvisory,
  memoryId: string
): string[] {
  const lines: string[] = ["Promotion advisory:"]
  for (const reason of advisory.reasons) {
    lines.push(`  - ${reason}`)
  }
  lines.push(`  ${advisory.suggestion.replaceAll("<this-memory-id>", memoryId)}`)
  return lines
}

/**
 * Render the active-task cross-reference footer (issue 0.7.0/11).
 *
 * Mirrors the duplicate-task footer on `lore-task action='create'`
 * (issue 0.7.0/10) — heading line + one bulleted line per task with
 * title, state, and a copy-paste closure CTA. Heading wording differs
 * deliberately: the duplicate-task footer says "close any that are
 * obsolete" because it surfaces *competing* trackers; this footer says
 * "close any that this memory resolves" because it surfaces tasks the
 * just-saved memory may have *finished*.
 */
function formatRelatedTaskCrossref(tasks: TaskSummary[]): string[] {
  const lines: string[] = [
    `Related active tasks (${tasks.length}) — close any that this memory resolves:`,
  ]
  for (const task of tasks) {
    const stateLabel = task.taskState ?? "open"
    lines.push(
      `  - "${task.title}" [${stateLabel}] — ` +
        `lore-task({ action: 'close', taskId: '${task.id}' })`
    )
  }
  return lines
}

interface UpdateArgs {
  memoryId: string
  title?: string
  content?: string
  tags?: string[]
  keywords?: string
  synopsis?: string
  projectName?: string
  projectNames?: string[]
  topicName?: string
  forceNewTopic?: boolean
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  confidence?: (typeof CONFIDENCES)[number]
  reviewBy?: string | null
  decidedAt?: string | null
  supersedesIds?: string[]
  affectsIds?: string[]
  alternatives?: string
  consequences?: string
  topicKey?: string
}

async function handleUpdate(
  services: LoreServices,
  args: UpdateArgs
): Promise<ToolResult> {
  try {
    // Reject illegal combinations BEFORE any I/O. Re-keying preserves
    // identity (kind is part of identity); a combined `topicKey + kind`
    // update would smuggle a kind change through the residual update
    // path and silently split an upsert chain across two kinds.
    // Operators that genuinely need both issue two separate calls.
    if (args.topicKey !== undefined && args.kind !== undefined) {
      throw new Error(
        "Cannot combine `topicKey` (re-key) with `kind` change in a " +
          "single update. Re-keying preserves identity; the kind belongs " +
          "to the upsert chain. Issue two separate updates if you need " +
          "both, or rethink whether the chain should change kind at all " +
          "(it usually shouldn't)."
      )
    }

    // Detect whether anything beyond the framing fields (`action`,
    // `memoryId`, `topicKey`) was passed. A topicKey-only update is a
    // pure re-key and must NOT call `services.memories.update` —
    // pinned by the re-key acceptance criteria. Stripping via
    // destructure keeps the gate honest: adding a future field to
    // `UpdateArgs` automatically counts toward the content-delta
    // check without re-listing every key. `action` is included in
    // the strip set because Zod's discriminated-union output carries
    // the discriminator literal verbatim, and a non-undefined value
    // would otherwise flip the gate to true on every update call.
    const argsRecord = args as unknown as Record<string, unknown>
    const { action: _a, memoryId: _m, topicKey: _t, ...contentDelta } = argsRecord
    void _a
    void _m
    void _t
    const hasContentDelta = Object.values(contentDelta).some((v) => v !== undefined)

    let projectIds: string[] | undefined
    const warnings: string[] = []

    // Explicit project scope is strict even on update. Resolve it before
    // re-key preflight because `validateRekey` reads the target Memory and
    // collision candidates; an invalid explicit project must win the
    // error-ordering race before any scoped read or write starts.
    if (args.projectNames !== undefined || args.projectName !== undefined) {
      const resolved = await resolveProjectIds(
        services,
        args.projectName,
        args.projectNames
      )
      projectIds = resolved.ids.length > 0 ? resolved.ids : undefined
      warnings.push(...resolved.warnings)
    }

    // Preflight the re-key BEFORE any content-delta mutation. If the
    // re-key would reject (collision against current state, empty
    // `projectIds`), we throw cleanly without leaving an update
    // half-persisted. The validation is non-mutating — it loads the
    // memory and runs the collision query against the current
    // project-set, but writes nothing.
    //
    // The race window between preflight and the actual mutation is
    // documented in `MemoryService.validateRekey`'s docstring: a
    // concurrent grab of the new key, or a content-delta that
    // changes `projectIds` and exposes a fresh collision under the
    // post-update set, both fall through to the `try/catch` around
    // the actual `rekeyTopicKey` call below — which surfaces a
    // `PartialUpdateError` when content has already landed.
    let preflight: { oldTopicKey: string; willRekey: boolean } | undefined
    if (args.topicKey !== undefined) {
      const result = await services.memories.validateRekey({
        memoryId: args.memoryId,
        newTopicKey: args.topicKey,
      })
      preflight = {
        oldTopicKey: result.oldTopicKey,
        willRekey: result.willRekey,
      }
    }

    let topicId: string | undefined
    let topicLabel: string | undefined
    let updated: Memory | undefined

    // Apply content delta FIRST. Re-key (when present) runs AFTER so
    // the audit-block append is the LAST write to the body —
    // otherwise `MemoryService.update`'s full-body `replace_content`
    // would clobber the audit block that `rekeyTopicKey` just
    // appended. Reversing the dispatch order here is what makes a
    // combined `topicKey + content` call land both writes durably.
    if (hasContentDelta) {
      if (args.topicName) {
        let topicScope = projectIds
        if (!topicScope || topicScope.length === 0) {
          const current = await services.memories.getById(args.memoryId)
          if (current.projectIds.length > 0) {
            topicScope = current.projectIds
          } else if (services.context.project) {
            topicScope = [services.context.project.id]
          }
        }
        if (!topicScope || topicScope.length === 0) {
          warnings.push(
            `Topic "${args.topicName}" skipped (requires at least one project)`
          )
        } else {
          const topic = await services.topics.getOrCreate(args.topicName, topicScope, {
            forceNew: args.forceNewTopic,
          })
          topicId = topic.id
          topicLabel = topic.name
        }
      }

      try {
        updated = await services.memories.update(args.memoryId, {
          title: args.title,
          content: args.content,
          tags: args.tags,
          keywords: args.keywords,
          synopsis: args.synopsis,
          projectIds,
          topicId,
          kind: args.kind as MemoryKind | undefined,
          status: args.status as MemoryStatus | undefined,
          confidence: args.confidence as MemoryConfidence | undefined,
          reviewBy: args.reviewBy,
          decidedAt: args.decidedAt,
          supersedesIds: args.supersedesIds,
          affectsIds: args.affectsIds,
          alternatives: args.alternatives,
          consequences: args.consequences,
        })
      } catch (err) {
        if (
          err instanceof MemoryUpdatePartialFailureError &&
          args.topicKey !== undefined &&
          preflight?.willRekey !== false
        ) {
          throw new MemoryUpdatePartialFailureError(
            `${err.message} The requested re-key to '${args.topicKey}' ` +
              `was not attempted because the body write failed before ` +
              `the re-key step. Re-issue the re-key separately after ` +
              `repairing the body update.`,
            {
              memoryId: err.memoryId,
              bodyWriteError: err.bodyWriteError,
            }
          )
        }
        throw err
      }
    }

    // Re-key SECOND. `rekeyTopicKey` reads the post-content body
    // (via its internal `getById`) so the audit block is appended on
    // top of any content the prior `MemoryService.update` wrote.
    // Short-circuits as a no-op when the new key matches existing —
    // pin verified by `MemoryService.rekeyTopicKey`'s tests.
    //
    // `PartialUpdateError` wraps the re-key failure when the
    // content delta has already landed, so the operator gets a
    // clear signal that part of the requested mutation persisted.
    // The preflight above catches the most common failure modes
    // (collision, empty-projectIds) before this point — a
    // `PartialUpdateError` here means the preflight passed but
    // the actual mutation rejected (race, transient Notion
    // failure, post-update projectIds change exposing a fresh
    // collision). When no content delta accompanied the re-key,
    // the underlying error propagates unchanged because nothing
    // was partially applied.
    let rekeyed = false
    let oldTopicKey: string | undefined
    let topicKeyUnchanged = false
    if (args.topicKey !== undefined) {
      if (preflight && !preflight.willRekey) {
        // No-op short-circuit path: the new key matches the
        // existing one, so `rekeyTopicKey` would do nothing. Track
        // the no-op state so the response can acknowledge the
        // intent rather than silently dropping it. Skip the
        // service call entirely — the preflight already loaded
        // the memory and confirmed equality.
        topicKeyUnchanged = true
        oldTopicKey = preflight.oldTopicKey
      } else {
        try {
          const result = await services.memories.rekeyTopicKey({
            memoryId: args.memoryId,
            newTopicKey: args.topicKey,
          })
          updated = result.memory
          if (result.oldTopicKey !== args.topicKey) {
            rekeyed = true
            oldTopicKey = result.oldTopicKey
          }
        } catch (err) {
          // `RekeyAuditError` describes a DIFFERENT partial state
          // from `PartialUpdateError`: the Topic Key property
          // already persisted (the load-bearing identity change
          // landed) and only the audit-block append failed.
          // Wrapping it in `PartialUpdateError` would falsely
          // claim "the topic key is unchanged" and instruct an
          // unnecessary retry — but a retry would short-circuit
          // through `validateRekey`'s no-op guard because the new
          // key now matches the stored value. Propagate
          // `RekeyAuditError` unchanged; its own message
          // accurately describes the rekey-side state, and the
          // operator who issued the combined call already knows
          // the content delta was attempted in the same request.
          if (err instanceof RekeyAuditError) {
            throw err
          }
          if (hasContentDelta) {
            const cause = err instanceof Error ? err.message : String(err)
            throw new PartialUpdateError(
              `Content update for memory ${args.memoryId} persisted, ` +
                `but the subsequent re-key to '${args.topicKey}' failed: ` +
                `${cause}. The title/body/tags/etc. you supplied are now ` +
                `on Notion; the topic key is unchanged. Inspect the row ` +
                `and re-issue the re-key (without the content delta) once ` +
                `the underlying issue is resolved.`,
              {
                memoryId: args.memoryId,
                rekeyError: err,
              }
            )
          }
          throw err
        }
      }
    }

    if (!updated) {
      // Degenerate input: neither a content delta nor a topicKey
      // was passed (e.g. just `{ memoryId }`). Surface current
      // state so the tool returns a sensible shape rather than
      // throwing. Both content-update and re-key branches assign
      // `updated` when they run, so this path only fires for the
      // empty-args case.
      updated = await services.memories.getById(args.memoryId)
    }

    // Add-only re-emission of `mentions` facts (DEFERRED-03). An
    // update that surfaces a fresh entity in title / keywords /
    // synopsis emits a new `mentions` fact for it; an update that
    // REMOVES an entity leaves the corresponding fact in place.
    // Silent drift on removes is the accepted cost — the alternative
    // (diff-and-invalidate on every update) extends the auto-fact
    // contract with invalidation behavior that today only
    // `lore-correct` carries, which is a separate design decision
    // worth its own review.
    //
    // Pre-query existing `mentions` facts sourced from this memory
    // so per-entity `createWithDedup` only fires for entities the
    // graph doesn't already cover. The "covered" check is by Object
    // alone, deliberately: a title-only update that leaves the
    // entity set untouched changes every existing fact's subject
    // text but emits zero new rows. `createWithDedup`'s dedup-key
    // probe is the second-line defense against a concurrent
    // autosave landing the same triple between our pre-query and
    // our writes.
    //
    // Gate the whole branch on at least one extraction-relevant arg
    // being defined: title, keywords, or synopsis. An update that
    // only mutates `confidence` / `status` / `reviewBy` /
    // `decidedAt` / `tags` / `projectIds` / `topicId` /
    // `supersedesIds` / `affectsIds` / `alternatives` /
    // `consequences` cannot change the extraction surface, so the
    // pre-query and per-entity `createWithDedup` calls would be
    // pure waste — every candidate would resolve to "already
    // covered" and the round-trips burn for no signal. The gate
    // checks arg presence, not arg-vs-resolved-value diff, so an
    // agent that re-supplies an unchanged title still pays the
    // pre-query; that noise case is the agent's choice and bounded
    // by the kill switch.
    const autoMentionsDisabled = process.env["LORE_DISABLE_AUTO_MENTIONS"] === "1"
    const extractionInputsTouched =
      args.title !== undefined ||
      args.keywords !== undefined ||
      args.synopsis !== undefined
    let autoMentionsCount = 0
    let autoMentionsAttempted = 0
    if (!autoMentionsDisabled && extractionInputsTouched) {
      // Decode candidates to match `createWithDedup`'s internal
      // decode-at-write-boundary step. Without this, an entity
      // surfaced as `Foo &amp; Bar` would compare raw against an
      // already-decoded `Foo & Bar` in the covered-set Set,
      // triggering a wasted round-trip per affected entity per
      // update. Idempotent.
      const mentionedEntities = extractEntityCandidates(
        updated.title,
        updated.keywords,
        updated.synopsis
      ).map(decodeTextEntities)
      if (mentionedEntities.length > 0) {
        let existing: Fact[]
        try {
          existing = await services.facts.queryBySourceMemory(updated.id, {
            predicates: ["mentions"],
          })
        } catch (err) {
          // Probe failure must not block the update response.
          // Degrade to "assume nothing covered" — `createWithDedup`'s
          // own probe still absorbs same-triple duplicates downstream,
          // so the worst case is one wasted round-trip per entity
          // rather than a duplicated row.
          debugLogPartialFailures("lore-memory", [
            { rootId: `${updated.id}: existing-mentions-probe`, error: err },
          ])
          existing = []
        }
        const covered = new Set(existing.map((f) => f.object))
        const newCandidates = mentionedEntities.filter((entity) => !covered.has(entity))
        if (newCandidates.length > 0) {
          autoMentionsAttempted = newCandidates.length
          const autoProjectIds =
            updated.projectIds.length > 0 ? updated.projectIds : undefined
          // Per-entity `.then(success, failure)` — same shape as
          // the save-time emission: convert every rejection into a
          // resolved boolean BEFORE `Promise.all` ever sees it so a
          // single per-entity 400 cannot sink the surviving creates.
          // See `handleSave`'s comment for the full rationale.
          const results = await Promise.all(
            newCandidates.map((entity) =>
              services.facts
                .createWithDedup({
                  subject: updated.title,
                  predicate: "mentions",
                  object: entity,
                  sourceMemoryId: updated.id,
                  projectIds: autoProjectIds,
                  confidence: "speculative",
                })
                .then(
                  () => true,
                  (err: unknown) => {
                    debugLogAutoFactFailure("update", updated.id, entity, err)
                    return false
                  }
                )
            )
          )
          autoMentionsCount = results.filter(Boolean).length
        }
      }
    }

    const lines = [`Updated memory: "${updated.title}" (${updated.id})`]
    if (rekeyed && oldTopicKey !== undefined && args.topicKey !== undefined) {
      lines.push(`Re-keyed: '${oldTopicKey || "(unset)"}' → '${args.topicKey}'`)
      lines.push(`Audit block appended to body.`)
    } else if (topicKeyUnchanged && args.topicKey !== undefined) {
      // Acknowledge the no-op so the operator can see the call was
      // received and recognized as a no-op (the new key matched the
      // existing one). Silent suppression would leave the operator
      // wondering whether the re-key was honored or dropped.
      lines.push(`Topic key unchanged: '${args.topicKey}' (no-op).`)
    }
    if (topicLabel) {
      lines.push(`Topic: ${topicLabel}`)
    }
    if (warnings.length > 0) {
      lines.push(`Warnings: ${warnings.join("; ")}`)
    }
    // Footer fires only when at least one new fact was attempted —
    // the add-only contract's steady state (every entity already
    // covered) renders no footer, matching save's silent-on-no-
    // tokenizer-output posture. The "new" suffix distinguishes
    // update-time emission from save-time emission ("Auto-mentions:
    // 2" on save vs. "Auto-mentions: 2 new" on update) so an
    // operator triaging response output can tell which surface
    // produced the count.
    if (autoMentionsAttempted > 0) {
      lines.push(
        autoMentionsCount === autoMentionsAttempted
          ? `Auto-mentions: ${autoMentionsCount} new`
          : `Auto-mentions: ${autoMentionsCount}/${autoMentionsAttempted} new attempted`
      )
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    }
  } catch (err) {
    return toolError(err)
  }
}

interface SuggestTopicKeyArgs {
  title: string
  kind: (typeof SUGGEST_KIND_VALUES)[number]
}

/**
 * Render a `TopicKeySuggestion` as the two-line tool response
 * documented in 0.9.0/07. Distinguishes "suggestion" from "no
 * suggestion" cleanly so the agent can branch on the first line
 * (`Suggested topic key:` vs `No suggestion`) without parsing the
 * reason.
 */
function renderSuggestKeyResult(result: TopicKeySuggestion): ToolResult {
  const lines =
    result.key !== null
      ? [`Suggested topic key: ${result.key}`, `Reason: ${result.reason}`]
      : [`No suggestion — leave topicKey unset.`, `Reason: ${result.reason}`]
  return {
    content: [{ type: "text", text: lines.join("\n") }],
  }
}

function handleSuggestTopicKey(args: SuggestTopicKeyArgs): ToolResult {
  try {
    const result = suggestTopicKey({ title: args.title, kind: args.kind })
    return renderSuggestKeyResult(result)
  } catch (err) {
    return toolError(err)
  }
}

async function handleArchive(
  services: LoreServices,
  args: { memoryId: string }
): Promise<ToolResult> {
  try {
    await services.memories.archive(args.memoryId)
    // `lore-memory archive` can archive `Kind = decision` rows, while
    // DecisionService keeps positive getById reads in a 30s id cache.
    // Clear it so same-process decision reads cannot serve a just-
    // archived decision until the TTL expires.
    services.decisions.clearCache()
    return {
      content: [{ type: "text", text: `Archived memory ${args.memoryId}` }],
    }
  } catch (err) {
    return toolError(err)
  }
}

// -------------------------------------------------------------------------
// Compare verdict (issue 0.9.0/05) — frozen vocabulary, mirrors the locked
// judgment prompt in `src/core/prompts/conflict-judge.ts`. Adding a verdict
// requires bumping `CONFLICT_JUDGE_PROMPT_VERSION` in lockstep so historical
// stored verdicts remain interpretable.
// -------------------------------------------------------------------------

const COMPARE_VERDICTS = [
  "conflicts_with",
  "supersedes",
  "scoped",
  "related",
  "compatible",
  "not_conflict",
] as const

type CompareVerdict = (typeof COMPARE_VERDICTS)[number]

const ASYMMETRIC_VERDICTS: ReadonlySet<CompareVerdict> = new Set([
  "conflicts_with",
  "supersedes",
])

interface CompareArgs {
  memoryIdA: string
  memoryIdB: string
  verdict: CompareVerdict
  affectedMemoryId?: string
  reason: string
  judgeConfidence?: number
  promptVersion?: string
}

/**
 * Cross-field validation for `affectedMemoryId`. Asymmetric verdicts
 * (`conflicts_with`, `supersedes`) name a loser; symmetric verdicts
 * don't. Throws BEFORE any Notion read so a direction mismatch is
 * caught with zero side effects — `services.memories.getById` must
 * not fire when this throws.
 */
function validateAffectedMemoryId(input: CompareArgs): void {
  const isAsymmetric = ASYMMETRIC_VERDICTS.has(input.verdict)
  if (isAsymmetric) {
    if (!input.affectedMemoryId) {
      throw new Error(
        `verdict='${input.verdict}' requires affectedMemoryId ` +
          "naming the loser memory (memoryIdA or memoryIdB)."
      )
    }
    if (
      input.affectedMemoryId !== input.memoryIdA &&
      input.affectedMemoryId !== input.memoryIdB
    ) {
      throw new Error("affectedMemoryId must equal memoryIdA or memoryIdB.")
    }
  } else {
    if (input.affectedMemoryId) {
      throw new Error(
        `verdict='${input.verdict}' is symmetric; ` + "affectedMemoryId must be omitted."
      )
    }
  }
}

/**
 * Compose the tool-error message body for a post-dispatch
 * `recordCompared` failure. `toolError` (`src/mcp/helpers.ts`) only
 * forwards `error.message`, so every diagnostic field the operator
 * needs to manually reconcile lives in the message text itself —
 * structured `readonly` properties on a custom Error class would be
 * dropped before the agent ever sees them.
 *
 * Fields embedded in the message:
 * - `dispatchedFactId` — the fact that landed on the actionable path
 *   (the operator can `lore-fact action='invalidate'` it during
 *   manual cleanup if needed).
 * - `decrementedMemoryId` — the loser whose Confidence Score was
 *   halved.
 * - `compareNotesEntryToWriteA/B` — the NDJSON lines that should
 *   have been appended to each side's Compare Notes.
 * - `comparedWithRelationToWrite` — the pair ids that should appear
 *   in each other's Compared With relation.
 * - `inconsistentState: true` — sentinel marker the operator can
 *   `grep` for in agent transcripts.
 *
 * The agent surfaces this back to the operator instead of pretending
 * the call succeeded. A same-input retry is safe because the
 * confidence decrement now carries an atomic compare-dispatch ledger;
 * the embedded fields remain useful when repeated retries hit the
 * same Notion-side failure and an operator needs to inspect manually.
 */
function inconsistentCompareStateMessage(args: {
  dispatchedFactId: string | undefined
  decrementedMemoryId: string
  compareNotesEntryToWriteA: string
  compareNotesEntryToWriteB: string
  comparedWithRelationToWrite: { memoryIdA: string; memoryIdB: string }
}): string {
  return (
    "Compare dispatch landed but recordCompared failed (inconsistentState: true). " +
    "Compare dispatch state landed or was already present, but the " +
    "audit-marker write (Compare Notes + Compared With on both sides, " +
    "issued via Promise.all) failed. " +
    "Possible states: NEITHER side received its updates; OR one side succeeded " +
    "and the other failed. Retrying the same lore-memory action='compare' is " +
    "safe: the affected memory carries a compare_dispatch ledger marker when " +
    "the confidence update lands, and recordCompared skips any side whose " +
    "final audit entry is already present. If repeated retries fail, INSPECT " +
    "both sides first, then write only the missing audit pieces (do NOT blindly " +
    "apply four updates — appending an NDJSON line that already landed creates " +
    "a duplicate audit entry; re-adding to Compared With is harmless because " +
    "Notion's relation set is set-semantic).\n" +
    `dispatchedFactId=${args.dispatchedFactId ?? "(none)"}\n` +
    `decrementedMemoryId=${args.decrementedMemoryId}\n` +
    `compareNotesEntryToWriteA=${args.compareNotesEntryToWriteA}\n` +
    `compareNotesEntryToWriteB=${args.compareNotesEntryToWriteB}\n` +
    `comparedWithRelationToWrite=${JSON.stringify(args.comparedWithRelationToWrite)}`
  )
}

/**
 * Type-narrow `affectedMemoryId` to a definitely-defined string for
 * the actionable verdict branches. `validateAffectedMemoryId` runs
 * upstream and rejects asymmetric verdicts that omit this field, so
 * this helper is an assertion: it throws with a clear "internal
 * invariant violated" message if a future refactor reorders guards
 * such that an asymmetric branch reaches here without the field set.
 *
 * Cheaper than non-null assertions (`input.affectedMemoryId!`) because
 * a future contributor reading the throw sees what went wrong rather
 * than a TypeError on an undefined property access.
 */
function requireAffectedMemoryId(args: {
  affectedMemoryId?: string
  verdict: string
}): string {
  if (args.affectedMemoryId === undefined) {
    throw new Error(
      "Internal: requireAffectedMemoryId called without " +
        `affectedMemoryId set (verdict='${args.verdict}'). ` +
        "validateAffectedMemoryId should have caught this upstream."
    )
  }
  return args.affectedMemoryId
}

/**
 * Project-set intersection check for the cross-project compare guard.
 * `Project` is a multi-relation on Memories, so a pair is comparable
 * when their project sets intersect — `[P, Q]` and `[Q, R]` share Q
 * → allowed. A vault-wide memory (empty `projectIds`) intersects
 * with NO project set; the guard rejects pairs with no shared
 * project so the dispatch surface stays scoped.
 */
function shareProject(a: { projectIds: string[] }, b: { projectIds: string[] }): boolean {
  if (a.projectIds.length === 0 || b.projectIds.length === 0) return false
  const setB = new Set(b.projectIds)
  return a.projectIds.some((id) => setB.has(id))
}

interface CompareResultInput {
  verdict: CompareVerdict
  memoryA: { id: string; title: string }
  memoryB: { id: string; title: string }
  affectedMemoryId?: string
  factId?: string
  decremented?: boolean
  alreadyJudged: boolean
  /**
   * `"A"` or `"B"` when this call was a partial-failure recovery
   * (only that side's audit-marker write actually fired this time
   * because the other side already carried the entry from a prior
   * partial-success). `null` for fresh judgments where both sides
   * wrote. Surfaces in the response text so the agent can tell the
   * operator that the pair's audit state is now consistent (rather
   * than silently treating the recovery like a fresh judgment).
   */
  recoveredSide?: "A" | "B" | null
}

/**
 * Render the tool response for `lore-memory action='compare'`. The
 * shape distinguishes the cases the agent needs to branch on:
 * idempotent skip (`alreadyJudged: true`), symmetric verdict
 * (compared-with updated only), actionable verdict with fact id,
 * `supersedes` (which surfaces the same fields as `conflicts_with`
 * but with the supersession framing), and partial-failure recovery
 * (one side caught up to the other after a prior partial-success).
 */
function renderCompareResult(input: CompareResultInput): ToolResult {
  const {
    verdict,
    memoryA,
    memoryB,
    factId,
    decremented,
    alreadyJudged,
    affectedMemoryId,
    recoveredSide,
  } = input
  if (alreadyJudged) {
    return {
      content: [
        {
          type: "text",
          text: [
            `Verdict: ${verdict} — already recorded for this pair (no-op).`,
            `  A: "${memoryA.title}" (${memoryA.id})`,
            `  B: "${memoryB.title}" (${memoryB.id})`,
          ].join("\n"),
        },
      ],
    }
  }

  const lines: string[] = []
  if (verdict === "conflicts_with") {
    const loserId = affectedMemoryId
    const loser = loserId === memoryA.id ? memoryA : memoryB
    lines.push(
      `Verdict: conflicts_with — "${loser.title}" (${loser.id}) ${
        decremented === false ? "confidence already halved" : "confidence halved"
      }.`
    )
  } else if (verdict === "supersedes") {
    const loserId = affectedMemoryId
    const loser = loserId === memoryA.id ? memoryA : memoryB
    lines.push(
      `Verdict: supersedes — "${loser.title}" (${loser.id}) marked superseded; ${
        decremented === false ? "confidence already halved" : "confidence halved"
      }.`
    )
  } else {
    lines.push(
      `Verdict: ${verdict} — Compared With and Compare Notes updated on both sides.`
    )
  }
  lines.push(`  A: "${memoryA.title}" (${memoryA.id})`)
  lines.push(`  B: "${memoryB.title}" (${memoryB.id})`)
  if (factId) {
    lines.push(`Fact: ${factId}`)
  }
  if (recoveredSide) {
    const recoveredId = recoveredSide === "A" ? memoryA.id : memoryB.id
    lines.push(
      `Audit recovery: only side ${recoveredSide} (${recoveredId}) wrote this call — the other side already carried a matching entry from a prior partial-success. The pair's audit state is now consistent on both sides.`
    )
  }
  return {
    content: [{ type: "text", text: lines.join("\n") }],
  }
}

async function handleCompare(
  services: LoreServices,
  args: CompareArgs
): Promise<ToolResult> {
  try {
    // 1. Self-pair guard. Pure input check, no I/O.
    if (args.memoryIdA === args.memoryIdB) {
      throw new Error("Cannot compare a memory to itself.")
    }

    // 2. Validate direction BEFORE any Notion read. Acceptance criteria
    //    require invalid affectedMemoryId to throw with zero side
    //    effects — direction validation runs immediately after the
    //    self-pair guard, before hydration.
    validateAffectedMemoryId(args)

    // 3. Hydrate both memories (parallel). Needed for project
    //    intersection check, fact subjects, and Compare Notes
    //    membership check.
    const [memoryA, memoryB] = await Promise.all([
      services.memories.getById(args.memoryIdA),
      services.memories.getById(args.memoryIdB),
    ])

    // 4. Cross-project guard. Project intersection required —
    //    pair-with-disjoint-projects has no shared scope to write the
    //    fact under.
    if (!shareProject(memoryA, memoryB)) {
      throw new Error(
        "Cannot compare memories with disjoint project sets. " +
          "Project intersection required."
      )
    }

    // 5. Resolve loser/winner pair. Symmetric verdicts have no loser;
    //    the actionable branches narrow via affectedMemoryId.
    const isAsymmetric = ASYMMETRIC_VERDICTS.has(args.verdict)
    const affectedId = isAsymmetric
      ? requireAffectedMemoryId({
          affectedMemoryId: args.affectedMemoryId,
          verdict: args.verdict,
        })
      : null
    const loser = isAsymmetric
      ? affectedId === args.memoryIdA
        ? memoryA
        : memoryB
      : null
    const winner = isAsymmetric ? (loser === memoryA ? memoryB : memoryA) : null

    const promptVersion = args.promptVersion ?? CONFLICT_JUDGE_PROMPT_VERSION

    // 6. Idempotency gate — pair-scoped via local NDJSON parse, with
    //    direction baked into the key for asymmetric verdicts. Both
    //    sides must carry the final audit entry before we no-op.
    //
    //    The `affected` field on the match is the load-bearing piece
    //    the prior design missed: a corrected judgment with the same
    //    pair/verdict but flipped `affectedMemoryId` (e.g.,
    //    `(A, B, conflicts_with, affected=A)` after
    //    `(A, B, conflicts_with, affected=B)`) MUST re-dispatch. With
    //    direction in the key, the prior entry's `affected=B` does
    //    not match the new query's `affected=A`, the gate clears, and
    //    A is decremented.
    //
    //    Same-verdict idempotent re-calls (same direction) still
    //    short-circuit here with zero side effects: no decrement,
    //    no fact write, no Compare Notes append. Different-verdict
    //    re-calls also fall through (a changed verdict is a
    //    deliberate signal — verdict change is allowed).
    //
    //    The destructive actionable branch is retry-safe because the
    //    affected memory gets a `compare_dispatch` ledger marker in
    //    the same update as the Confidence Score decrement. That lets
    //    actionable verdicts use the same both-sides audit gate as
    //    symmetric verdicts: a retry after one audit side landed
    //    catches up the missing side without double-decrementing.
    const aAlreadyHasEntry = hasMatchingCompareNote(memoryA.compareNotes, {
      target: memoryB.id,
      verdict: args.verdict,
      affected: affectedId,
    })
    const bAlreadyHasEntry = hasMatchingCompareNote(memoryB.compareNotes, {
      target: memoryA.id,
      verdict: args.verdict,
      affected: affectedId,
    })
    const gateHits = aAlreadyHasEntry && bAlreadyHasEntry
    if (gateHits) {
      return renderCompareResult({
        verdict: args.verdict,
        memoryA,
        memoryB,
        affectedMemoryId: args.affectedMemoryId,
        alreadyJudged: true,
      })
    }

    // 7. Compose audit-trail entries and PREFLIGHT only the sides
    //    that `recordCompared` would actually write. The preflight's
    //    job is to catch overflow BEFORE a destructive
    //    `recordContradiction` / `recordSupersedence` could fire and
    //    leave a halved memory with no audit marker. But preflight
    //    must mirror `recordCompared`'s per-side idempotent skip:
    //    a side whose loaded snapshot already carries the matching
    //    `(target, verdict, affected)` entry will be SKIPPED by
    //    `recordCompared` and so does NOT need overflow validation
    //    — and preflighting it on a near-cap side would erroneously
    //    throw on a partial-failure recovery, blocking the missing
    //    side's write even though `recordCompared` would have
    //    handled the safe case correctly.
    //
    //    The two side-presence flags computed here are reused by the
    //    response renderer (`recoveredSide`) so the agent can
    //    surface "only side X wrote this call" when the retry was
    //    a one-sided catch-up.
    const judgedAt = new Date().toISOString()
    const entryA = {
      verdict: args.verdict,
      target: args.memoryIdB,
      affected: affectedId,
      reason: args.reason,
      judgedAt,
      promptVersion,
    }
    const entryB = {
      verdict: args.verdict,
      target: args.memoryIdA,
      affected: affectedId,
      reason: args.reason,
      judgedAt,
      promptVersion,
    }
    let preflightNotesA = memoryA.compareNotes
    let preflightNotesB = memoryB.compareNotes
    let legacyPartialAuditWithoutLedger = false
    let forceRecordA = false
    let forceRecordB = false
    if (isAsymmetric) {
      const ledgerEntry = buildCompareDispatchLedgerEntry({
        verdict: args.verdict as "conflicts_with" | "supersedes",
        sourceMemoryId: winner!.id,
        affectedMemoryId: loser!.id,
      })
      const loserHasLedger = hasCompareDispatchLedgerEntry(loser!.compareNotes, {
        dispatchKey: ledgerEntry.dispatchKey,
        step: "confidence_decrement",
      })
      legacyPartialAuditWithoutLedger =
        (aAlreadyHasEntry || bAlreadyHasEntry) && !loserHasLedger
      if (!loserHasLedger) {
        if (loser!.id === memoryA.id) {
          preflightNotesA = appendCompareDispatchLedgerEntry(preflightNotesA, ledgerEntry)
          forceRecordA = aAlreadyHasEntry
        } else {
          preflightNotesB = appendCompareDispatchLedgerEntry(preflightNotesB, ledgerEntry)
          forceRecordB = bAlreadyHasEntry
        }
      }
    }
    if (!aAlreadyHasEntry) appendCompareNote(preflightNotesA, entryA)
    if (!bAlreadyHasEntry) appendCompareNote(preflightNotesB, entryB)

    // 8. Dispatch on actionable verdicts. Only fires after the
    //    overflow preflight clears, so a destructive decrement + fact
    //    write never lands without a corresponding audit-trail entry
    //    being writable.
    //
    //    The supersedes-non-decision guard is the spec's "non-decision
    //    affected target throws" — runs BEFORE the dispatch helper so
    //    a non-decision pair never hits `decisions.supersede`.
    let dispatchResult: {
      factId?: string
      affectedMemoryId?: string
      affectedCompareNotes?: string
      decremented?: boolean
    } = {}

    if (args.verdict === "supersedes" && loser!.kind !== "decision") {
      throw new Error(
        "verdict='supersedes' requires the affected (superseded) " +
          "memory to have kind='decision'. For non-decision pairs, " +
          "use 'compatible' + lore-memory action='update' to merge, " +
          "or promote via lore-decision action='create' supersedesIds."
      )
    }

    if (legacyPartialAuditWithoutLedger) {
      dispatchResult = {
        affectedMemoryId: loser!.id,
        affectedCompareNotes:
          loser!.id === memoryA.id ? preflightNotesA : preflightNotesB,
        decremented: false,
      }
    } else if (args.verdict === "conflicts_with") {
      const result = await recordContradiction(services, {
        contradictedMemory: loser!,
        sourceMemory: winner!,
        judgeConfidence: args.judgeConfidence,
      })
      dispatchResult = {
        ...result,
        affectedMemoryId: loser!.id,
      }
    } else if (args.verdict === "supersedes") {
      const result = await recordSupersedence(services, {
        supersedingMemory: winner!,
        supersededMemory: loser!,
        judgeConfidence: args.judgeConfidence,
      })
      dispatchResult = {
        ...result,
        affectedMemoryId: loser!.id,
      }
    }

    // 9. Audit-marker write (Compare Notes + Compared With on both
    //    sides). The preflight in step 7 already validated both sides
    //    will accept the append. `recordCompared` is per-side
    //    idempotent (skips a side whose loaded snapshot already
    //    carries the matching entry), so a partial-failure recovery
    //    retry writes only the missing side without duplicating the
    //    successful one. The returned `RecordComparedResult` tells us
    //    which sides actually landed a write so the response text
    //    can distinguish "fresh judgment" from "recovery completion."
    //
    //    Failure modes:
    //    - Actionable verdict + recordCompared throws → dispatch
    //      already landed, audit may be partial. The retry is safe
    //      because the affected memory now carries the dispatch ledger
    //      and `recordCompared` is per-side idempotent. The structured
    //      message still embeds the audit entries for operators who
    //      need to inspect repeated failures.
    //    - Symmetric verdict + recordCompared throws → no destructive
    //      dispatch happened, but the per-side write may have left
    //      one side updated and the other not. A naive retry is now
    //      safe: the per-side idempotent skip in `recordCompared` AND
    //      the both-sides gate at step 6 together ensure the retry
    //      writes only the missing side. Rethrow the underlying error
    //      so the operator (or agent) can see what failed and decide
    //      whether to retry.
    const memoryAForRecord =
      dispatchResult.affectedMemoryId === memoryA.id &&
      dispatchResult.affectedCompareNotes !== undefined
        ? { ...memoryA, compareNotes: dispatchResult.affectedCompareNotes }
        : memoryA
    const memoryBForRecord =
      dispatchResult.affectedMemoryId === memoryB.id &&
      dispatchResult.affectedCompareNotes !== undefined
        ? { ...memoryB, compareNotes: dispatchResult.affectedCompareNotes }
        : memoryB
    let recordResult: RecordComparedResult
    try {
      recordResult = await services.memories.recordCompared({
        memoryA: memoryAForRecord,
        memoryB: memoryBForRecord,
        verdict: args.verdict,
        affected: affectedId,
        reason: args.reason,
        judgedAt,
        promptVersion,
        forceWriteA: forceRecordA,
        forceWriteB: forceRecordB,
      })
    } catch (err) {
      if (isAsymmetric) {
        throw new Error(
          inconsistentCompareStateMessage({
            dispatchedFactId: dispatchResult.factId,
            decrementedMemoryId: loser!.id,
            compareNotesEntryToWriteA: JSON.stringify(entryA),
            compareNotesEntryToWriteB: JSON.stringify(entryB),
            comparedWithRelationToWrite: {
              memoryIdA: args.memoryIdA,
              memoryIdB: args.memoryIdB,
            },
          }),
          { cause: err }
        )
      }
      // Symmetric verdict — no destructive dispatch happened. The
      // per-side idempotent recordCompared + both-sides gate at
      // step 6 make a retry safely repairing: the side that already
      // landed is skipped on retry, only the missing side writes.
      throw err
    }

    return renderCompareResult({
      verdict: args.verdict,
      memoryA,
      memoryB,
      affectedMemoryId: args.affectedMemoryId,
      factId: dispatchResult.factId,
      decremented: dispatchResult.decremented,
      alreadyJudged: false,
      recoveredSide:
        recordResult.wroteA && recordResult.wroteB
          ? null
          : recordResult.wroteA
            ? "A"
            : recordResult.wroteB
              ? "B"
              : null,
    })
  } catch (err) {
    return toolError(err)
  }
}

export async function handleExpand(
  services: LoreServices,
  args: { ids: string[] }
): Promise<ToolResult> {
  try {
    const unique: string[] = []
    const seen = new Set<string>()
    for (const id of args.ids) {
      if (!seen.has(id)) {
        seen.add(id)
        unique.push(id)
      }
    }

    const { fulfilled, failures } = await settleAll(
      unique.map((id) => [id, services.memories.getById(id)] as const)
    )
    if (failures.length > 0) {
      debugLogPartialFailures(
        "lore-memory",
        failures.map(({ key, error }) => ({ rootId: key, error }))
      )
    }

    const bodies = new Map<string, Memory>()
    for (const [id, memory] of fulfilled) bodies.set(id, memory)
    const errors = new Map<string, unknown>()
    for (const { key, error } of failures) errors.set(key, error)

    const sections = unique.map((id) => {
      const memory = bodies.get(id)
      if (memory) return formatExpandedMemory(memory)
      const error = errors.get(id)
      const message =
        error instanceof Error ? error.message : String(error ?? "unknown error")
      return `### (unresolved: ${id})\n*${message}*`
    })

    const header =
      failures.length > 0
        ? `Expanded ${fulfilled.length}/${unique.length} memories (${failures.length} unresolved):`
        : `Expanded ${fulfilled.length} ${fulfilled.length === 1 ? "memory" : "memories"}:`

    const response: ToolResult = {
      content: [{ type: "text", text: `${header}\n\n${sections.join("\n\n---\n\n")}` }],
    }

    // Citation-as-evidence (issue 0.8.0/05). `expand` fetches a
    // memory's body for the agent to read directly — that is a cite.
    // Touches only the rows that hydrated successfully; rows that
    // 404'd / errored are already reported as `(unresolved: ...)` and
    // touching them would duplicate the failure mode without any
    // signal value.
    const fulfilledMemories = fulfilled.map(([, memory]) => memory)
    await fireTouchOnRead(services.memories, fulfilledMemories, "lore-memory (expand)")

    return response
  } catch (err) {
    return toolError(err)
  }
}

interface RecallArgs {
  projectName?: string
  topicName?: string
  source?: (typeof SOURCES)[number]
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  reviewBefore?: string
  limit?: number
  startCursor?: string
  includeContent?: boolean
  includeSynopsis?: boolean
}

export async function handleRecall(
  services: LoreServices,
  args: RecallArgs
): Promise<ToolResult> {
  try {
    const { projectId } = await resolveReadProjectScope(services, args.projectName)
    let topicId: string | undefined

    if (args.topicName) {
      const found = await services.topics.findByName(args.topicName)
      if (!found) {
        return {
          content: [{ type: "text", text: `No topic named "${args.topicName}" found.` }],
        }
      }
      topicId = found.id
    }

    const withContent = args.includeContent === true

    const {
      items: memories,
      nextCursor,
      capped,
    } = await services.memories.list({
      projectId,
      topicId,
      source: args.source,
      kind: args.kind as MemoryKind | undefined,
      status: args.status as MemoryStatus | undefined,
      reviewBefore: args.reviewBefore,
      limit: args.limit ?? 10,
      includeContent: withContent,
      startCursor: args.startCursor,
    })

    if (memories.length === 0) {
      const header = nextCursor
        ? "No matching memories on this page."
        : "No recent memories found."
      return {
        content: [
          {
            type: "text",
            text: `${header}${paginationFooter(nextCursor, { truncated: capped })}`,
          },
        ],
      }
    }

    const includeSynopsis = args.includeSynopsis !== false

    const text = memories
      .map((m) =>
        formatMemoryListItem(m, {
          meta: defaultMemoryMetaBuilder,
          body: withContent ? m.content : undefined,
          includeSynopsis,
        })
      )
      .join("\n\n---\n\n")

    const bodiesFooter = withContent
      ? ""
      : `\n\n_Bodies omitted — re-call with \`includeContent: true\` to fetch them._`

    const response: ToolResult = {
      content: [
        {
          type: "text",
          text: `${memories.length} recent memories:\n\n${text}${bodiesFooter}${paginationFooter(nextCursor, { truncated: capped })}`,
        },
      ],
    }

    // Citation-as-evidence (issue 0.8.0/05). Touch fires AFTER the
    // response is composed — write latency cannot block the agent's
    // read. Failure handling and contract details live in
    // `fireTouchOnRead`'s docstring.
    await fireTouchOnRead(services.memories, memories, "lore-query (recall)")

    return response
  } catch (err) {
    return toolError(err)
  }
}

interface SearchArgs {
  query: string
  projectName?: string
  topicName?: string
  tags?: string[]
  kind?: (typeof KINDS)[number]
  status?: (typeof STATUSES)[number]
  limit?: number
  includeContent?: boolean
  includeSynopsis?: boolean
  mode?: SearchMode
  explain?: boolean
  intent?: string
}

export async function handleSearch(
  services: LoreServices,
  args: SearchArgs
): Promise<ToolResult> {
  try {
    const { projectId } = await resolveReadProjectScope(services, args.projectName)
    let topicId: string | undefined
    const warnings: string[] = []

    // Topics span projects (many-to-many Topic.Project), so resolve
    // globally rather than scoping by project — same posture as
    // `handleRecall`'s topic resolution.
    if (args.topicName) {
      const found = await services.topics.findByName(args.topicName)
      if (!found) {
        return {
          content: [{ type: "text", text: `No topic named "${args.topicName}" found.` }],
        }
      }
      topicId = found.id
    }

    const withContent = args.includeContent === true
    const resolvedMode: SearchMode = args.mode ?? "hybrid"
    const wantExplain = args.explain === true

    // Over-fetch slightly only when post-filters are still active — i.e.
    // semantic mode, which can't apply kind/status server-side. Contains
    // and hybrid push kind/status/tags/topicName into the Notion query, so
    // the requested limit is already authoritative there.
    const searchInput = {
      query: args.query,
      projectId,
      topicId,
      tags: args.tags,
      kind: args.kind as MemoryKind | undefined,
      status: args.status as MemoryStatus | undefined,
      limit:
        resolvedMode === "semantic"
          ? Math.min((args.limit ?? 10) * 2, 50)
          : (args.limit ?? 10),
      includeContent: withContent,
      mode: resolvedMode,
      intent: args.intent,
    }

    let searchResults: Memory[]
    let explain: SearchExplain[] = []
    let searchCapped = false
    if (wantExplain && typeof services.memories.searchWithExplain === "function") {
      const out = await services.memories.searchWithExplain(searchInput)
      searchResults = out.memories
      explain = out.explain
      searchCapped = out.capped ?? false
    } else if (typeof services.memories.searchWithMeta === "function") {
      const out = await services.memories.searchWithMeta(searchInput)
      searchResults = out.memories
      searchCapped = out.capped ?? false
    } else {
      searchResults = await services.memories.search(searchInput)
    }

    // The service applies kind/status server-side in contains/hybrid and
    // post-filter in semantic, so the result set is already correctly
    // narrowed by mode. The final slice protects against the semantic
    // over-fetch above leaking extra rows past the caller's limit.
    const finalLimit = args.limit ?? 10
    const results = searchResults.slice(0, finalLimit)
    const explainSlice = explain.slice(0, finalLimit)

    if (searchCapped) {
      warnings.push(
        "Search scan reached the live-row refill cap; more matching memories may exist."
      )
    }
    const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""
    const cappedFooter = paginationFooter(undefined, { truncated: searchCapped })

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No memories found for: "${args.query}"${warn}${cappedFooter}`,
          },
        ],
      }
    }

    const includeSynopsis = args.includeSynopsis !== false

    const text = results
      .map((m) =>
        formatMemoryListItem(m, {
          meta: defaultMemoryMetaBuilder,
          body: withContent ? m.content : undefined,
          includeSynopsis,
        })
      )
      .join("\n\n---\n\n")

    const bodiesFooter = withContent
      ? ""
      : `\n\n_Bodies omitted — re-call with \`includeContent: true\` to fetch them._`

    const explainFooter = wantExplain ? formatScoreTrace(explainSlice) : ""

    const response: ToolResult = {
      content: [
        {
          type: "text",
          text: `Found ${results.length} memories for "${args.query}":\n\n${text}${bodiesFooter}${explainFooter}${warn}${cappedFooter}`,
        },
      ],
    }

    // Citation-as-evidence (issue 0.8.0/05). Touches every surfaced
    // row, not just the slice the agent might read — surfacing alone
    // is the signal that the row passed the filter and is contextually
    // relevant. Fires post-response composition.
    await fireTouchOnRead(services.memories, results, "lore-query (search)")

    return response
  } catch (err) {
    return toolError(err)
  }
}

/**
 * Render a `## Score trace` footer for `lore-query action='search'` when
 * the caller passes `explain: true`. One row per result; null fields
 * render as `—` (em dash) uniformly so the format is grep-friendly across
 * branches.
 *
 * The `branch` field is the canonical signal; `containsRank` /
 * `semanticRank` / `rrfScore` carry rank/score detail when applicable.
 * Agents that don't pass `explain` pay zero output-token cost.
 */
function formatScoreTrace(explain: SearchExplain[]): string {
  if (explain.length === 0) return ""
  const lines = explain.map((e) => {
    const contains = e.containsRank === null ? "—" : String(e.containsRank)
    const semantic = e.semanticRank === null ? "—" : String(e.semanticRank)
    // Six decimals (rather than four) keeps the rendered score
    // information-bearing across the plausible RRF_K range. With the
    // current RRF_K=60, scores are in the 0.01–0.04 range and four
    // decimals would suffice. A future env knob (`LORE_HYBRID_RRF_K`)
    // pushing RRF_K toward 1000+ would crush scores below the four-
    // decimal threshold and silently render them as `0.0000`. Six
    // decimals covers RRF_K up to ~100000 without information loss.
    const rrf = e.rrfScore === null ? "—" : e.rrfScore.toFixed(6)
    // Three decimals matches the resolution of `confidenceFactor`'s
    // [0.5, 1.0] range (the floor controlled by `CONFIDENCE_FACTOR_MIN`
    // in `src/types.ts`). 0.500 / 0.750 / 1.000 are the operationally
    // meaningful values; deeper precision would surface arithmetic
    // noise without diagnostic value.
    const cf = e.confidenceFactor.toFixed(3)
    return `${e.memoryId} branch=${e.branch} contains=${contains} semantic=${semantic} rrf=${rrf} confidenceFactor=${cf}`
  })
  return `\n\n## Score trace\n\n${lines.join("\n")}`
}

const memoryDispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    title: z.string(),
    content: z.string(),
    projectName: z.string().optional(),
    projectNames: z.array(z.string()).optional(),
    topicName: z.string().optional(),
    forceNewTopic: z.boolean().optional(),
    source: z.enum(SOURCES).optional(),
    kind: z.enum(KINDS).optional(),
    status: z.enum(STATUSES).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    reviewBy: ymdDateSchema.optional(),
    decidedAt: ymdDateSchema.optional(),
    tags: tagsSchema.optional(),
    keywords: keywordsSchema.optional(),
    synopsis: z.string().max(SYNOPSIS_MAX).optional(),
    author: z.string().optional(),
    agent: z.string().optional(),
    session: z.string().optional(),
    topicKey: z
      .string()
      .regex(
        TOPIC_KEY_REGEX,
        "Must be kebab-case path like 'decision/jwt-auth' (lowercase, slash-separated, no leading/trailing slash)"
      )
      .optional(),
  }),
  z.object({
    action: z.literal("update"),
    memoryId: z.string(),
    title: z.string().optional(),
    content: z.string().optional(),
    tags: tagsSchema.optional(),
    keywords: keywordsSchema.optional(),
    synopsis: z.string().max(SYNOPSIS_MAX).optional(),
    projectName: z.string().optional(),
    projectNames: z.array(z.string()).optional(),
    topicName: z.string().optional(),
    forceNewTopic: z.boolean().optional(),
    kind: z.enum(KINDS).optional(),
    status: z.enum(STATUSES).optional(),
    confidence: z.enum(CONFIDENCES).optional(),
    reviewBy: clearableYmdDateSchema.optional(),
    decidedAt: clearableYmdDateSchema.optional(),
    supersedesIds: z.array(z.string()).optional(),
    affectsIds: z.array(z.string()).optional(),
    alternatives: richTextPropertySchema("alternatives").optional(),
    consequences: richTextPropertySchema("consequences").optional(),
    // Same kebab-case regex as `lore-memory action='save'`'s
    // (forthcoming) topic-key parameter — the format contract is
    // identical across save and update. See 0.9.0/#14 for the
    // re-key semantics.
    topicKey: z.string().regex(TOPIC_KEY_REGEX).optional(),
  }),
  z.object({
    action: z.literal("archive"),
    memoryId: z.string(),
  }),
  z.object({
    action: z.literal("expand"),
    ids: z.array(z.string().uuid()).min(1).max(EXPAND_MAX_IDS),
  }),
  z.object({
    action: z.literal("suggest-topic-key"),
    title: z.string(),
    kind: z.enum(SUGGEST_KIND_VALUES),
  }),
  z.object({
    action: z.literal("compare"),
    memoryIdA: z.string(),
    memoryIdB: z.string(),
    verdict: z.enum(COMPARE_VERDICTS),
    affectedMemoryId: z.string().optional(),
    reason: z.string().max(200),
    judgeConfidence: z.number().min(0).max(1).optional(),
    promptVersion: z.string().optional(),
  }),
])

export function registerMemoryTools(server: McpServer, services: LoreServices): void {
  // -------------------------------------------------------------------------
  // lore-memory — polymorphic dispatcher (P3-01)
  // -------------------------------------------------------------------------
  server.registerTool(
    "lore-memory",
    {
      title: "Memory operations",
      description:
        "Save, update, archive, batch-expand, suggest a topic key, or record a compare verdict on a memory pair. Action-dispatched:\n\n" +
        "- `action: 'save'` — create a new memory page; runs a near-duplicate probe in parallel. With `topicKey` set, upserts onto an existing memory with the same key AND project-set (appends a revision block instead of creating a new row).\n" +
        "- `action: 'update'` — mutate an existing memory's title, body, tags, kind, status, or relations. Any field omitted is left untouched.\n" +
        "- `action: 'archive'` — soft-delete a memory by ID (Notion archive flag).\n" +
        "- `action: 'expand'` — batch-fetch full markdown bodies for up to 20 IDs in one parallel call. Companion to the title-tier defaults on `lore-query` recall/search.\n" +
        "- `action: 'suggest-topic-key'` — pure heuristic over (title, kind) → kebab-case key. Pass the result to `action: 'save'` as `topicKey`. Notes and tasks return null.\n" +
        "- `action: 'compare'` — record a verdict on a memory pair (`conflicts_with` | `supersedes` | `scoped` | `related` | `compatible` | `not_conflict`). Asymmetric verdicts require `affectedMemoryId`. Idempotent on `(pair, verdict, affected)`.\n\n" +
        "For architectural decisions prefer `lore-decision` with `action: 'create'` — it captures structured rationale and supersession chains.\n\n" +
        "`tags` is a closed vocabulary; for free-form labels (PR numbers, file paths, IDs) use `keywords`.",
      inputSchema: {
        action: z
          .enum(["save", "update", "archive", "expand", "suggest-topic-key", "compare"])
          .describe(
            "Operation: save | update | archive | expand | suggest-topic-key | compare."
          ),
        // save
        title: z
          .string()
          .optional()
          .describe(
            "Required for action='save' and action='suggest-topic-key'; new title for update. Short."
          ),
        content: z
          .string()
          .optional()
          .describe(
            "Required for action='save'; new body (markdown) for action='update'."
          ),
        // save | update | archive | expand
        memoryId: z
          .string()
          .optional()
          .describe(
            "Required for action='update' and action='archive'. The Notion page ID of the memory."
          ),
        ids: z
          .array(z.string().uuid())
          .optional()
          .describe(
            `(action='expand') Memory IDs (1-${EXPAND_MAX_IDS}). UUIDs as returned by recall/search/wake-up.`
          ),
        // shared (save | update)
        projectName: z
          .string()
          .optional()
          .describe(
            "(save | update) Project name. Defaults to auto-detected project from cwd."
          ),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("(save | update) Multiple project names for cross-project memories."),
        topicName: z
          .string()
          .optional()
          .describe(
            "(save | update) Topic name within the project. Auto-created if missing on save. Case/plural/punctuation variants silently collapse onto the canonical row to prevent fan-out."
          ),
        forceNewTopic: z
          .boolean()
          .optional()
          .describe(
            "(save | update) Bypass the normalized-equivalent + trigram-similar check on `topicName` and create a fresh row. Use only when you've reviewed the candidates surfaced by the structured error and confirmed your name is intentionally distinct."
          ),
        source: z
          .enum(SOURCES)
          .optional()
          .describe(
            "(action='save') How this memory was captured. Default: conversation."
          ),
        kind: z
          .enum(SUGGEST_KIND_VALUES)
          .optional()
          .describe(
            "(save | update | suggest-topic-key) Memory kind (default: note on save). " +
              "Use lore-decision for decisions; lore-task for tasks. " +
              "Required for action='suggest-topic-key', which accepts the full kind set; " +
              "save and update reject 'task' (tasks are owned by lore-task)."
          ),
        status: z
          .enum(STATUSES)
          .optional()
          .describe("(save | update) Lifecycle state (default: informational on save)."),
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe("(save | update) Confidence level (default: certain on save)."),
        reviewBy: clearableYmdDateSchema
          .optional()
          .describe(
            "(save | update) Review-by date YYYY-MM-DD. On update, omit to keep, pass null or empty string to clear."
          ),
        decidedAt: clearableYmdDateSchema
          .optional()
          .describe(
            "(save | update) Canonical decision date YYYY-MM-DD. On update, omit to keep, pass null or empty string to clear."
          ),
        tags: tagsSchema.optional().describe("(save | update) Closed-vocabulary tags."),
        keywords: keywordsSchema
          .optional()
          .describe("(save | update) Free-form keywords."),
        synopsis: z
          .string()
          .max(SYNOPSIS_MAX)
          .optional()
          .describe(
            `(save | update) 1-2 sentence synopsis surfaced under the title on recall/search/wake-up listings (≤${SYNOPSIS_MAX} chars). On update, omit to keep, pass empty string to clear.`
          ),
        author: z
          .string()
          .optional()
          .describe(
            "(action='save') Engineer display name. Defaults to LORE_USER_NAME env or `users.me` on the active token."
          ),
        agent: z
          .string()
          .optional()
          .describe("(action='save') Name of the AI agent saving this memory."),
        session: z
          .string()
          .optional()
          .describe("(action='save') Session ID to group related memories."),
        topicKey: z
          .string()
          .regex(
            TOPIC_KEY_REGEX,
            "Must be kebab-case path like 'decision/jwt-auth' (lowercase, slash-separated, no leading/trailing slash)"
          )
          .optional()
          .describe(
            "Kebab-case path like 'decision/jwt-auth'. On save: upserts when a memory " +
              "exists with same key/project-set (appends a revision, bumps Revision Count); " +
              "requires `kind` ∈ {decision, runbook, " +
              "incident, postmortem, policy}. On update: re-keys, appending a " +
              "`## Re-keyed` audit block; cannot be combined with `kind`. " +
              "See docs/memory-workflows.md#topic-keys."
          ),
        // update only
        supersedesIds: z
          .array(z.string())
          .optional()
          .describe(
            "(action='update') Replace the Supersedes relation with these decision IDs."
          ),
        affectsIds: z
          .array(z.string())
          .optional()
          .describe(
            "(action='update') Replace the Affects relation with these memory IDs."
          ),
        alternatives: z
          .string()
          .max(RICH_TEXT_PROPERTY_MAX_LEN)
          .optional()
          .describe(
            `(action='update') Alternatives text, up to ${RICH_TEXT_PROPERTY_MAX_LEN} chars (replaces existing).`
          ),
        consequences: z
          .string()
          .max(RICH_TEXT_PROPERTY_MAX_LEN)
          .optional()
          .describe(
            `(action='update') Consequences text, up to ${RICH_TEXT_PROPERTY_MAX_LEN} chars (replaces existing).`
          ),
        // compare
        memoryIdA: z
          .string()
          .optional()
          .describe(
            "(action='compare') First memory ID. A/B are unordered labels; direction comes from `affectedMemoryId`."
          ),
        memoryIdB: z.string().optional().describe("(action='compare') Second memory ID."),
        verdict: z
          .enum(COMPARE_VERDICTS)
          .optional()
          .describe(
            "(action='compare') Verdict on the pair. See docs/memory-workflows.md#conflict-verdicts."
          ),
        affectedMemoryId: z
          .string()
          .optional()
          .describe(
            "(action='compare') Required for asymmetric verdicts (`conflicts_with`, `supersedes`); names the loser. Must equal memoryIdA or memoryIdB."
          ),
        reason: z
          .string()
          .max(200)
          .optional()
          .describe(
            "(action='compare') Short explanation, ≤200 chars. Recorded in Compare Notes audit trail."
          ),
        judgeConfidence: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe(
            "(action='compare') Optional 0..1 self-reported confidence. Below 0.7 the agent SHOULD ask the user first."
          ),
        promptVersion: z
          .string()
          .optional()
          .describe(
            "(action='compare') Optional prompt version (default: current `CONFLICT_JUDGE_PROMPT_VERSION`)."
          ),
      },
    },
    async (args) => {
      const parsed = memoryDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(new Error(formatDispatchError("lore-memory", parsed.error)))
      }
      switch (parsed.data.action) {
        case "save":
          return handleSave(services, parsed.data)
        case "update":
          return handleUpdate(services, parsed.data)
        case "archive":
          return handleArchive(services, parsed.data)
        case "expand":
          return handleExpand(services, parsed.data)
        case "suggest-topic-key":
          return handleSuggestTopicKey(parsed.data)
        case "compare":
          return handleCompare(services, parsed.data)
      }
    }
  )
}

/**
 * Render one hydrated memory for `lore-memory action='expand'` output.
 * Mirrors the meta-line shape used by `lore-query action='recall'` /
 * `lore-query action='search'` so agents scanning across
 * triage listings and expanded bodies see a uniform header line. Empty
 * `content` still renders the header (the memory exists; the body is just
 * blank) rather than collapsing the row.
 */
function formatExpandedMemory(m: Memory): string {
  const meta = [
    m.source,
    m.kind !== "note" ? m.kind : null,
    m.status !== "informational" ? m.status : null,
    m.updatedAt.split("T")[0],
  ]
    .filter(Boolean)
    .join(" | ")
  const body = m.content ? `\n\n${m.content}` : ""
  return `### ${m.title}\n*${meta}*${body}`
}
