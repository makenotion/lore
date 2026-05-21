import type { LoreServices } from "../../server.js"
import { debugLogAutoFactFailure, toolError } from "../../helpers.js"
import { debugLogPartialFailures } from "../../../observability/partial-failure.js"
import { resolveProjectIds } from "../../resolve.js"
import { resolveAuthorForWrite } from "../../../auth/identity.js"
import { emitAutoMentions } from "../../../core/auto-mentions.js"
import { subjectToTopicKey } from "../../../core/memory-subject.js"
import type { MemoryCreateResult, PromotionAdvisory } from "../../../core/memory.js"
import {
  findAutosaveLearningDuplicate,
  findNearDuplicates,
  findRelatedActiveTasks,
  type AutosaveLearningDuplicateMatch,
  type NearDuplicateMatch,
} from "../../../core/near-duplicate.js"
import { resolveFeatureFlags } from "../../../feature-flags.js"
import type {
  CreateMemoryInput,
  FreshCreatePreparation,
  Memory,
  MemoryConfidence,
  MemoryKind,
  MemorySource,
  MemoryStatus,
  TaskSummary,
  MemoryScopeInput,
} from "../../../types.js"
import type { ToolResult } from "./types.js"
import { CONFIDENCES, KINDS, SOURCES, STATUSES } from "./types.js"

/**
 * Trigram threshold for the `lore-memory action='save'` near-duplicate
 * probe. Initial guess — tune after rollout if
 * we see false positives flooding the response footer on legitimately-
 * distinct memories sharing boilerplate title wording.
 */
const MEMORY_NEAR_DUPLICATE_THRESHOLD = 0.7

/** Cap the probe candidate pool. The `findNearDuplicates` docstring carries the rationale. */
const NEAR_DUPLICATE_POOL_LIMIT = 50

/** Cap the session-scoped duplicate pool for Stop-spawn atomic learnings. */
const AUTOSAVE_LEARNING_DUPLICATE_POOL_LIMIT = 50

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
  const matchSession = match.session?.trim()
  const normalizedCurrentSession = currentSession?.trim()
  const duplicateScope = !matchSession
    ? "unknown-session"
    : normalizedCurrentSession && matchSession === normalizedCurrentSession
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
  // Any reuse scope drops candidate-only metadata because no new row is
  // created, so surface the footer for same-session and cross-session hits.
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

async function createMemoryWithResult(
  services: LoreServices,
  input: CreateMemoryInput
): Promise<MemoryCreateResult> {
  const memories = services.memories as typeof services.memories & {
    createWithResult?: (input: CreateMemoryInput) => Promise<MemoryCreateResult>
  }
  if (typeof memories.createWithResult === "function") {
    return await memories.createWithResult(input)
  }
  const freshCreatePreparation = input.prepareFreshCreate
    ? await input.prepareFreshCreate()
    : null
  const freshInput = freshCreatePreparation
    ? { ...input, ...freshCreatePreparation.input }
    : input
  return {
    memory: await services.memories.create(freshInput),
    autosaveLearningDuplicate: null,
    freshCreatePreparation,
  }
}

export interface SaveArgs {
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
  expiresAt?: string
  expiresOn?: string
  tags?: string[]
  keywords?: string
  synopsis?: string
  author?: string
  agent?: string
  session?: string
  subject?: string
  replace?: boolean
  topicKey?: string
  scope?: MemoryScopeInput
}

function applyExpiryArgs(
  scope: MemoryScopeInput | undefined,
  expiresAt: string | undefined
): MemoryScopeInput | undefined {
  if (expiresAt === undefined) return scope
  return {
    ...(scope ?? {}),
    lifetime: scope?.lifetime ?? "expires",
    expiresAt,
  }
}
export async function handleSave(
  services: LoreServices,
  args: SaveArgs
): Promise<ToolResult> {
  try {
    const features = services.features ?? resolveFeatureFlags()
    const subject = args.subject?.trim()
    if (args.replace === true && !subject) {
      throw new Error("replace=true requires subject for subject-canonical saves.")
    }
    if (subject && args.replace !== true) {
      throw new Error(
        "subject-canonical saves require replace=true so the replacement semantics are explicit."
      )
    }
    if (subject && args.topicKey) {
      throw new Error(
        "Pass either subject or topicKey, not both. Subject-canonical saves derive topicKey automatically."
      )
    }
    if (subject && args.kind !== undefined && args.kind !== "state") {
      throw new Error(
        "subject-canonical saves must use kind='state' or omit kind so it defaults to 'state'."
      )
    }
    if (!subject && args.kind === "state") {
      throw new Error(
        "kind='state' saves must use subject with replace=true so Lore can derive the canonical state topic key."
      )
    }
    if (!subject && args.topicKey?.startsWith("state/")) {
      throw new Error(
        "state topic keys are derived from subject-canonical saves. Use subject with replace=true instead of passing a state/... topicKey directly."
      )
    }
    const subjectTopicKey = subject ? subjectToTopicKey(subject) : undefined
    const topicKeyForWrite = args.topicKey ?? subjectTopicKey
    // Validate the topicKey + kind contract BEFORE any service call.
    //
    // Topic keys group recurring decision/runbook/policy/incident/
    // postmortem topics. Subject-canonical state uses the same upsert
    // machinery, but its key is derived from `subject` above rather than
    // accepted as a direct `topicKey` input. Notes are the catch-all
    // default and tasks are
    // lifecycle records owned by `lore-task`, so neither forms a
    // recurring topic — the suggester (`action='suggest-topic-key'`)
    // returns null for `kind: 'note'` and `kind: 'task'` for the same
    // reason.
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
    const resolvedKind =
      (args.kind as MemoryKind | undefined) ?? (subjectTopicKey ? "state" : "note")
    if (
      topicKeyForWrite &&
      (resolvedKind === "note" ||
        resolvedKind === "task" ||
        resolvedKind === "operational")
    ) {
      const reason =
        resolvedKind === "note"
          ? "notes are the catch-all default"
          : resolvedKind === "task"
            ? "tasks are lifecycle records owned by lore-task"
            : "operational rows are temporary coordination receipts"

      throw new Error(
        `topicKey is not valid on kind: '${resolvedKind}'. Topic keys group ` +
          `recurring decision/runbook/policy-style topics; ${reason} and ` +
          "do not form a recurring topic. " +
          "Either omit topicKey, or set kind to one of: decision, " +
          "runbook, incident, postmortem, policy. " +
          "For current-state rows, use subject with replace=true. " +
          "Procedures are not written through lore-memory action='save' — " +
          "use lore-procedure action='propose' instead."
      )
    }
    // Procedure writes route through `lore-procedure action='propose'`
    // exclusively. The propose path enforces source-memory live-row
    // validation (`resolveProcedureSources`), the
    // `PROCEDURE_MIN_SOURCES` threshold, the
    // `(topicKey, project-set)` idempotency probe
    // (`findExistingProposedProcedure`), and lands the row at
    // `Status: proposed` for inbox review. The generic save path
    // bypasses every one of those gates, defeating the load-bearing
    // safety property that raw session summaries never become
    // fleet-wide procedures silently.
    if (resolvedKind === "procedure") {
      throw new Error(
        "lore-memory action='save' does not accept kind: 'procedure'. " +
          "Procedures must route through lore-procedure action='propose', " +
          "which validates supporting source memories, enforces the " +
          "minimum-sources gate, probes the topic-key slot for idempotency, " +
          "and lands the row at Status: proposed for inbox review. " +
          "Use lore-procedure action='propose' instead."
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
          features,
          onError: (err) =>
            debugLogPartialFailures("lore-memory", [
              { rootId: "near-duplicate-probe", error: err },
            ]),
        })
      : Promise.resolve([] as NearDuplicateMatch[])

    const autosaveLearningSave = isAutosaveLearningSave(args, resolvedKind)
    const hasExplicitProjectScope =
      Boolean(args.projectName) || Boolean(args.projectNames?.length)
    const canUseProjectAutosaveDedup =
      Boolean(probeProjectId) &&
      (hasExplicitProjectScope || !services.context.isCatchAllFallback)
    const autosaveLearningDedupScope: "session" | "project" | "off" =
      autosaveLearningSave && canUseProjectAutosaveDedup
        ? "project"
        : autosaveLearningSave
          ? "session"
          : "off"
    const autosaveLearningProbeScope: "session" | "project" | undefined =
      autosaveLearningSave && canUseProjectAutosaveDedup
        ? "project"
        : autosaveLearningSave
          ? "session"
          : undefined

    if (autosaveLearningSave) {
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
      // Two-probe contract: this MCP preflight runs before topic resolution
      // to keep already-visible duplicates side-effect-free, while
      // MemoryService.createWithResult repeats the blocking probe inside the
      // autosave lock to catch races that appear after this read.
      const duplicate = await findAutosaveLearningDuplicate(services.memories, {
        title: args.title,
        content: args.content,
        projectId: probeProjectId,
        projectIds: resolved.ids,
        session: args.session,
        scope: autosaveLearningProbeScope,
        limit: AUTOSAVE_LEARNING_DUPLICATE_POOL_LIMIT,
        features,
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

    // Active-task cross-reference probe. Starts only
    // after the blocking autosave-learning dedup gate clears: duplicate
    // early returns avoid this advisory read entirely because no new memory
    // exists to cross-reference. This intentionally trades a small non-duplicate
    // autosave latency delay for skipping a wasted task query on duplicate
    // returns; it still overlaps with the write below once the write path is
    // known to create a row.
    const taskCrossrefPromise = findRelatedActiveTasks(services, {
      memoryTitle: args.title,
      memoryKeywords: args.keywords,
      memorySynopsis: args.synopsis,
      projectId: probeProjectId,
      features,
      onError: (err) =>
        debugLogPartialFailures("lore-memory", [{ rootId: "task-crossref", error: err }]),
    })

    let topicId: string | undefined
    let topicLabel = "none"
    const shouldDeferAutosaveTopic =
      autosaveLearningSave &&
      !topicKeyForWrite &&
      Boolean(args.topicName) &&
      resolved.ids.length > 0
    const prepareFreshCreate: (() => Promise<FreshCreatePreparation>) | undefined =
      shouldDeferAutosaveTopic
        ? async () => {
            const topic = await services.topics.getOrCreate(
              args.topicName!,
              resolved.ids,
              {
                forceNew: args.forceNewTopic,
              }
            )
            return {
              input: { topicId: topic.id },
              topicLabel: topic.name,
            }
          }
        : undefined
    if (args.topicName && resolved.ids.length > 0 && !shouldDeferAutosaveTopic) {
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

    // Topic-key upsert dispatch. When `topicKey` is set,
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
      autosaveLearningDuplicate: AutosaveLearningDuplicateMatch | null
      freshCreatePreparation: FreshCreatePreparation | null
    }> = topicKeyForWrite
      ? services.memories
          .upsertByTopicKey({
            topicKey: topicKeyForWrite,
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
            expiresAt: args.expiresAt,
            expiresOn: args.expiresOn,
            author: resolvedAuthor,
            agent: args.agent,
            session: args.session,
            reviewBy: args.reviewBy,
            decidedAt: args.decidedAt,
            // Scope / lifetime — fresh-create branch lands the scope
            // verbatim; append-revision branch silently preserves the
            // existing row's scope.
            scope: applyExpiryArgs(args.scope, args.expiresAt),
          })
          .then((result) => ({
            ...result,
            autosaveLearningDuplicate: null,
            freshCreatePreparation: null,
          }))
      : createMemoryWithResult(services, {
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
          expiresAt: args.expiresAt,
          expiresOn: args.expiresOn,
          author: resolvedAuthor,
          agent: args.agent,
          session: args.session,
          // Scope / lifetime. The Zod schema accepts the
          // `MemoryScopeInput` shape verbatim; pass through as-is so the
          // service layer translates it onto the Notion column writes.
          scope: applyExpiryArgs(args.scope, args.expiresAt),
          autosaveLearningDedupScope,
          autosaveLearningScopeId: services.context.vault?.pageId ?? services.configRoot,
          prepareFreshCreate,
        }).then((result) => ({
          memory: result.memory,
          revisionCount: 1,
          upserted: false,
          // Non-topicKey saves and fresh-create upserts never carry
          // an advisory — the upsert path returns null on
          // fresh-create, so the non-topicKey branch matches that
          // posture for shape uniformity.
          promotionAdvisory: null,
          autosaveLearningDuplicate: result.autosaveLearningDuplicate,
          freshCreatePreparation: result.freshCreatePreparation,
        }))

    const [writeResult, nearDuplicates, relatedTasks] = await Promise.all([
      writePromise,
      probePromise,
      taskCrossrefPromise,
    ])

    const memory = writeResult.memory
    if (writeResult.freshCreatePreparation?.topicLabel) {
      topicLabel = writeResult.freshCreatePreparation.topicLabel
    }
    if (writeResult.freshCreatePreparation?.warnings?.length) {
      resolved.warnings.push(...writeResult.freshCreatePreparation.warnings)
    }
    if (writeResult.autosaveLearningDuplicate) {
      services.sessionMemories.record(
        { agent: args.agent, session: args.session },
        { memoryId: memory.id, projectIds: memory.projectIds }
      )
      return {
        content: [
          {
            type: "text",
            text: formatAutosaveLearningDuplicate(
              writeResult.autosaveLearningDuplicate,
              args,
              args.session?.trim()
            ).join("\n"),
          },
        ],
      }
    }

    const matches = nearDuplicates.filter((m) => m.id !== memory.id)

    services.sessionMemories.record(
      { agent: args.agent, session: args.session },
      { memoryId: memory.id, projectIds: memory.projectIds }
    )

    // Auto-emit `mentions` facts. Two non-obvious
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
    const autoMentions = await emitAutoMentions({
      facts: services.facts,
      memory,
      disabled: !features.autoMentions,
      onError: (entity, error) =>
        debugLogAutoFactFailure("save", memory.id, entity, error),
    })
    const autoMentionsCount = autoMentions.fulfilled
    const autoMentionsAttempted = autoMentions.attempted

    const projectLabel = args.projectNames?.length
      ? args.projectNames.join(", ")
      : (args.projectName ?? services.context.project?.name ?? "none (repo-wide)")

    // Header line distinguishes upsert-append from fresh-create so the
    // agent knows which path fired without parsing for revision count.
    // "Created (revision 1, topic key 'X')" / "Appended as revision N
    // (topic key 'X')" wording matches the upsert spec.
    const headerLine = topicKeyForWrite
      ? subject
        ? writeResult.upserted
          ? `Saved memory: "${memory.title}" (${memory.id}) — Appended as revision ${writeResult.revisionCount} (subject '${subject}', topic key '${topicKeyForWrite}')`
          : `Saved memory: "${memory.title}" (${memory.id}) — Created (revision 1, subject '${subject}', topic key '${topicKeyForWrite}')`
        : writeResult.upserted
          ? `Saved memory: "${memory.title}" (${memory.id}) — Appended as revision ${writeResult.revisionCount} (topic key '${topicKeyForWrite}')`
          : `Saved memory: "${memory.title}" (${memory.id}) — Created (revision 1, topic key '${topicKeyForWrite}')`
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
    // Promotion advisory. Renders only when the upsert
    // path returned a non-null advisory — fresh-create upserts and
    // non-topicKey saves both surface as null upstream and produce no
    // footer. The `<this-memory-id>` placeholder in the suggestion is
    // substituted with the just-saved memory's id so the operator can
    // copy-paste the promotion incantation directly.
    //
    // Loose `!= null` rather than strict `!== null`: the runtime type
    // contract guarantees `PromotionAdvisory | null` (the writePromise
    // type pin above is authoritative), but older test fixtures cast
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
      costOutputs: {
        ...(writeResult.upserted ? { memoriesUpdated: 1 } : { memoriesCreated: 1 }),
        ...(autoMentionsCount > 0 ? { factsCreated: autoMentionsCount } : {}),
      },
    }
  } catch (err) {
    return toolError(err)
  }
}

/**
 * Render the promotion advisory footer for the
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
 * Render the active-task cross-reference footer.
 *
 * Matches the duplicate-task footer on `lore-task action='create'` —
 * heading line + one bulleted line per task with
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
