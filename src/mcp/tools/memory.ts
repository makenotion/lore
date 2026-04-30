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
import { resolveProjectIds } from "../resolve.js"
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
  extractEntityCandidates,
  findNearDuplicates,
  findRelatedActiveTasks,
  type NearDuplicateMatch,
} from "../../core/near-duplicate.js"
import { decodeTextEntities } from "../../notion/html-entities.js"
import { defaultMemoryMetaBuilder, formatMemoryListItem } from "../render.js"
import { suggestTopicKey, type TopicKeySuggestion } from "../../core/topic-key.js"
import type { TaskSummary } from "../../types.js"

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
    `Warning: ${matches.length} existing ${matches.length === 1 ? "memory looks" : "memories look"} similar:`,
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
    "Consider `lore-memory` with `action: 'update'` on the existing row, or `lore-decision` with `action: 'create'` and `supersedesIds` if this is a formal replacement.",
  )
  return lines
}

const KINDS = [
  "note",
  "decision",
  "incident",
  "runbook",
  "postmortem",
  "policy",
] as const

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
function _assertSuggestKindCovers(
  _kind: (typeof SUGGEST_KIND_VALUES)[number],
): void {
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
  agent?: string
  session?: string
  topicKey?: string
}

async function handleSave(services: LoreServices, args: SaveArgs): Promise<ToolResult> {
  try {
    // Validate the topicKey + kind contract BEFORE any service call.
    //
    // Topic keys group recurring decision/runbook/policy/incident/
    // postmortem topics. Notes are the catch-all default and don't form
    // a recurring topic — the suggester (`action='suggest-topic-key'`)
    // returns null for `kind: 'note'` and `kind: 'task'` for the same
    // reason. The contract is documented in CLAUDE.md ("Topic keys for
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
    if (args.topicKey && resolvedKind === "note") {
      throw new Error(
        "topicKey is not valid on kind: 'note'. Topic keys group " +
          "recurring decision/runbook/policy-style topics; notes are " +
          "the catch-all default and do not form a recurring topic. " +
          "Either omit topicKey, or set kind to one of: decision, " +
          "runbook, incident, postmortem, policy.",
      )
    }

    const resolved = await resolveProjectIds(services, args.projectName, args.projectNames)

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
    }

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

    // Active-task cross-reference probe (issue 0.7.0/11). Fires in
    // parallel with the create + near-dup probe so wall-clock latency
    // stays at `max(latencies)` rather than summed. The probe surfaces
    // active tasks whose `Entity` column contains an entity extracted
    // from the saved memory's title / keywords / synopsis — anchoring
    // closure CTAs at the moment the agent reasons about resolution.
    // Project scope is optional here (unlike near-dup): the helper's
    // unscoped path is well-defined since `TaskService.list` honors
    // `projectOrUnscopedFilter`. Advisory: failures route through
    // `debugLogPartialFailures` and degrade to `[]` silently.
    const taskCrossrefPromise = findRelatedActiveTasks(services, {
      memoryTitle: args.title,
      memoryKeywords: args.keywords,
      memorySynopsis: args.synopsis,
      projectId: probeProjectId,
      onError: (err) =>
        debugLogPartialFailures("lore-memory", [
          { rootId: "task-crossref", error: err },
        ]),
    })

    // Topic-key upsert dispatch (0.9.0/#06). When `topicKey` is set,
    // the save path looks for an existing memory with that key +
    // identical project-set and appends a revision block instead of
    // creating a fresh row. The lookup (`findByTopicKey`) is the first
    // step inside `upsertByTopicKey` and runs concurrently with the
    // probes via `Promise.all` — caller wall-clock is `max(latencies)`,
    // not summed. The kind=note guard above already short-circuited
    // the unsafe-defaulting case; from here either path is contract-
    // valid.
    const writePromise: Promise<{
      memory: Memory
      revisionCount: number
      upserted: boolean
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
            agent: args.agent,
            session: args.session,
          })
          .then((memory) => ({ memory, revisionCount: 1, upserted: false }))

    const [writeResult, nearDuplicates, relatedTasks] = await Promise.all([
      writePromise,
      probePromise,
      taskCrossrefPromise,
    ])

    const memory = writeResult.memory
    const matches = nearDuplicates.filter((m) => m.id !== memory.id)

    services.sessionMemories.record(
      { agent: args.agent, session: args.session },
      { memoryId: memory.id, projectIds: memory.projectIds },
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
        memory.synopsis,
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
                },
              ),
          ),
        )
        autoMentionsCount = results.filter(Boolean).length
      }
    }

    const projectLabel = args.projectNames?.length
      ? args.projectNames.join(", ")
      : args.projectName ?? services.context.project?.name ?? "none (repo-wide)"

    // Header line distinguishes upsert-append from fresh-create so the
    // agent knows which path fired without parsing for revision count.
    // "Created (revision 1, topic key 'X')" / "Appended as revision N
    // (topic key 'X')" wording matches the spec footer for #06.
    const headerLine = args.topicKey
      ? writeResult.upserted
        ? `Saved memory: "${memory.title}" (${memory.id}) — Appended as revision ${writeResult.revisionCount} (topic key '${args.topicKey}')`
        : `Saved memory: "${memory.title}" (${memory.id}) — Created (revision 1, topic key '${args.topicKey}')`
      : `Saved memory: "${memory.title}" (${memory.id})`
    const lines = [
      headerLine,
      `Project: ${projectLabel}`,
      `Topic: ${topicLabel}`,
    ]
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
          : `Auto-mentions: ${autoMentionsCount}/${autoMentionsAttempted} attempted`,
      )
    }

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    }
  } catch (err) {
    return toolError(err)
  }
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
        `lore-task({ action: 'close', taskId: '${task.id}' })`,
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
  reviewBy?: string
  decidedAt?: string
  supersedesIds?: string[]
  affectsIds?: string[]
  alternatives?: string
  consequences?: string
}

async function handleUpdate(services: LoreServices, args: UpdateArgs): Promise<ToolResult> {
  try {
    let projectIds: string[] | undefined
    let topicId: string | undefined
    let topicLabel: string | undefined
    const warnings: string[] = []

    if (args.projectNames?.length || args.projectName) {
      const resolved = await resolveProjectIds(services, args.projectName, args.projectNames)
      projectIds = resolved.ids.length > 0 ? resolved.ids : undefined
      warnings.push(...resolved.warnings)
    }
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
        throw new Error(
          `Cannot set topicName="${args.topicName}": no project scope available. ` +
            `The memory has no Project relation and no project was passed or auto-detected. ` +
            `Pass projectName or projectNames.`,
        )
      }
      const topic = await services.topics.getOrCreate(args.topicName, topicScope, {
        forceNew: args.forceNewTopic,
      })
      topicId = topic.id
      topicLabel = topic.name
    }

    const updated = await services.memories.update(args.memoryId, {
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
        updated.synopsis,
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
                  },
                ),
            ),
          )
          autoMentionsCount = results.filter(Boolean).length
        }
      }
    }

    const lines = [`Updated memory: "${updated.title}" (${updated.id})`]
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
          : `Auto-mentions: ${autoMentionsCount}/${autoMentionsAttempted} new attempted`,
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
  args: { memoryId: string },
): Promise<ToolResult> {
  try {
    await services.memories.archive(args.memoryId)
    return {
      content: [{ type: "text", text: `Archived memory ${args.memoryId}` }],
    }
  } catch (err) {
    return toolError(err)
  }
}

export async function handleExpand(
  services: LoreServices,
  args: { ids: string[] },
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
      unique.map((id) => [id, services.memories.getById(id)] as const),
    )
    if (failures.length > 0) {
      debugLogPartialFailures(
        "lore-memory",
        failures.map(({ key, error }) => ({ rootId: key, error })),
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
      const message = error instanceof Error ? error.message : String(error ?? "unknown error")
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
  args: RecallArgs,
): Promise<ToolResult> {
  try {
    let projectId: string | undefined
    let topicId: string | undefined

    if (args.projectName) {
      const found = await services.projects.findByName(args.projectName)
      if (!found) {
        return {
          content: [{ type: "text", text: `Project "${args.projectName}" not found.` }],
        }
      }
      projectId = found.id
    } else if (services.context.project) {
      projectId = services.context.project.id
    }

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

    const { items: memories, nextCursor } = await services.memories.list({
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
          { type: "text", text: `${header}${paginationFooter(nextCursor)}` },
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
        }),
      )
      .join("\n\n---\n\n")

    const bodiesFooter = withContent
      ? ""
      : `\n\n_Bodies omitted — re-call with \`includeContent: true\` to fetch them._`

    const response: ToolResult = {
      content: [
        {
          type: "text",
          text: `${memories.length} recent memories:\n\n${text}${bodiesFooter}${paginationFooter(nextCursor)}`,
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
  args: SearchArgs,
): Promise<ToolResult> {
  try {
    let projectId: string | undefined
    let topicId: string | undefined
    const warnings: string[] = []

    if (args.projectName) {
      const found = await services.projects.findByName(args.projectName)
      if (found) {
        projectId = found.id
      } else {
        warnings.push(
          `Project "${args.projectName}" not found — falling back to auto-detected project.`,
        )
      }
    }
    if (!projectId && services.context.project) {
      projectId = services.context.project.id
    }

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
    if (wantExplain) {
      const out = await services.memories.searchWithExplain(searchInput)
      searchResults = out.memories
      explain = out.explain
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

    const warn = warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

    if (results.length === 0) {
      return {
        content: [{ type: "text", text: `No memories found for: "${args.query}"${warn}` }],
      }
    }

    const includeSynopsis = args.includeSynopsis !== false

    const text = results
      .map((m) =>
        formatMemoryListItem(m, {
          meta: defaultMemoryMetaBuilder,
          body: withContent ? m.content : undefined,
          includeSynopsis,
        }),
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
          text: `Found ${results.length} memories for "${args.query}":\n\n${text}${bodiesFooter}${explainFooter}${warn}`,
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
    reviewBy: z.string().regex(YMD_REGEX).optional(),
    decidedAt: z.string().regex(YMD_REGEX).optional(),
    tags: tagsSchema.optional(),
    keywords: keywordsSchema.optional(),
    synopsis: z.string().max(SYNOPSIS_MAX).optional(),
    agent: z.string().optional(),
    session: z.string().optional(),
    topicKey: z
      .string()
      .regex(
        TOPIC_KEY_REGEX,
        "Must be kebab-case path like 'decision/jwt-auth' (lowercase, slash-separated, no leading/trailing slash)",
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
    reviewBy: z.string().regex(YMD_REGEX).optional(),
    decidedAt: z.string().regex(YMD_REGEX).optional(),
    supersedesIds: z.array(z.string()).optional(),
    affectsIds: z.array(z.string()).optional(),
    alternatives: z.string().optional(),
    consequences: z.string().optional(),
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
        "Save, update, archive, batch-expand, or suggest a topic key for memories. Action-dispatched:\n\n" +
        "- `action: 'save'` — create a new memory page in the vault. Runs a near-duplicate probe in parallel. When `topicKey` is set, save UPSERTS: if a memory exists with the same key AND identical project-set, the new content appends as a revision block instead of creating a new row.\n" +
        "- `action: 'update'` — mutate an existing memory's title, body, tags, kind, status, or relations. Any field omitted is left untouched.\n" +
        "- `action: 'archive'` — soft-delete a memory by ID (Notion archive flag).\n" +
        "- `action: 'expand'` — batch-fetch full markdown bodies for up to 20 IDs in one parallel call. Companion to the title-tier defaults on `lore-query` recall/search.\n" +
        "- `action: 'suggest-topic-key'` — pure heuristic over (title, kind) → kebab-case key. No I/O. Pass the result to `action: 'save'` as `topicKey` to opt into upsert grouping. Notes and tasks return no suggestion.\n\n" +
        "For architectural decisions prefer `lore-decision` with `action: 'create'` — it captures structured rationale and supersession chains.\n\n" +
        "`tags` is a closed vocabulary; for free-form labels (PR numbers, file paths, IDs) use `keywords`.",
      inputSchema: {
        action: z
          .enum(["save", "update", "archive", "expand", "suggest-topic-key"])
          .describe(
            "Operation: save (create), update, archive, expand (batch body fetch), or suggest-topic-key (heuristic key generator).",
          ),
        // save
        title: z
          .string()
          .optional()
          .describe(
            "Required for action='save' and action='suggest-topic-key'; new title for action='update'. Short, descriptive.",
          ),
        content: z
          .string()
          .optional()
          .describe("Required for action='save'; new body (markdown) for action='update'."),
        // save | update | archive | expand
        memoryId: z
          .string()
          .optional()
          .describe(
            "Required for action='update' and action='archive'. The Notion page ID of the memory.",
          ),
        ids: z
          .array(z.string().uuid())
          .optional()
          .describe(
            `(action='expand') Memory IDs (1-${EXPAND_MAX_IDS}). UUIDs as returned by recall/search/wake-up.`,
          ),
        // shared (save | update)
        projectName: z
          .string()
          .optional()
          .describe("(save | update) Project name. Defaults to auto-detected project from cwd."),
        projectNames: z
          .array(z.string())
          .optional()
          .describe("(save | update) Multiple project names for cross-project memories."),
        topicName: z
          .string()
          .optional()
          .describe(
            "(save | update) Topic name within the project. Auto-created if missing on save. Variants that differ only by case, plural-`s`, `&` vs `and`, or punctuation (e.g. `Eval & Testing` vs `Evals & Testing`) silently collapse onto the existing canonical row to prevent fan-out.",
          ),
        forceNewTopic: z
          .boolean()
          .optional()
          .describe(
            "(save | update) Bypass the normalized-equivalent + trigram-similar check on `topicName` and create a fresh row. Use only when you've reviewed the candidates surfaced by the structured error and confirmed your name is intentionally distinct.",
          ),
        source: z
          .enum(SOURCES)
          .optional()
          .describe("(action='save') How this memory was captured. Default: conversation."),
        kind: z
          .enum(SUGGEST_KIND_VALUES)
          .optional()
          .describe(
            "(save | update | suggest-topic-key) Memory kind (default: note on save). " +
              "Use lore-decision for decisions; lore-task for tasks. " +
              "Required for action='suggest-topic-key', which accepts the full kind set; " +
              "save and update reject 'task' (tasks are owned by lore-task).",
          ),
        status: z
          .enum(STATUSES)
          .optional()
          .describe("(save | update) Lifecycle state (default: informational on save)."),
        confidence: z
          .enum(CONFIDENCES)
          .optional()
          .describe("(save | update) Confidence level (default: certain on save)."),
        reviewBy: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("(save | update) Review-by date YYYY-MM-DD."),
        decidedAt: z
          .string()
          .regex(YMD_REGEX, "Must be YYYY-MM-DD format")
          .optional()
          .describe("(save | update) Canonical decision date YYYY-MM-DD."),
        tags: tagsSchema
          .optional()
          .describe("(save | update) Closed-vocabulary tags."),
        keywords: keywordsSchema
          .optional()
          .describe("(save | update) Free-form keywords."),
        synopsis: z
          .string()
          .max(SYNOPSIS_MAX)
          .optional()
          .describe(
            "(save | update) 1–2 sentence synopsis surfaced under the title on " +
              `recall/search/wake-up listings. Up to ${SYNOPSIS_MAX} chars. Keep it tight — ` +
              "this is the snippet a triager reads to decide whether to expand the body. " +
              "On update, omit to leave untouched; pass empty string to clear.",
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
            "Must be kebab-case path like 'decision/jwt-auth' (lowercase, slash-separated, no leading/trailing slash)",
          )
          .optional()
          .describe(
            "(action='save') Optional kebab-case path like 'decision/jwt-auth'. " +
              "When provided, save upserts: if a memory with the same topicKey AND " +
              "identical project-set exists, the new content appends as a revision " +
              "block to the existing page (incrementing Revision Count) instead of " +
              "creating a new row. Title bumps to latest; Kind / Project-set cannot " +
              "change (rejected). Requires `kind` to be set to one of decision / " +
              "runbook / incident / postmortem / policy — not valid on `kind: 'note'` " +
              "(the catch-all default) and not valid on tasks. Use " +
              "`action: 'suggest-topic-key'` for a heuristic key from (title, kind). " +
              "See CLAUDE.md 'Topic keys for evolving memories'.",
          ),
        // update only
        supersedesIds: z
          .array(z.string())
          .optional()
          .describe("(action='update') Replace the Supersedes relation with these decision IDs."),
        affectsIds: z
          .array(z.string())
          .optional()
          .describe("(action='update') Replace the Affects relation with these memory IDs."),
        alternatives: z
          .string()
          .optional()
          .describe("(action='update') Alternatives text (replaces existing)."),
        consequences: z
          .string()
          .optional()
          .describe("(action='update') Consequences text (replaces existing)."),
      },
    },
    async (args) => {
      const parsed = memoryDispatchSchema.safeParse(args)
      if (!parsed.success) {
        return toolError(
          new Error(formatDispatchError("lore-memory", parsed.error)),
        )
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
      }
    },
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
