import { effectiveConfidenceScore } from "./decay.js"
import { expandEntityQueryVariants } from "./entity.js"
import { composeProjectContext, renderProjectContextLines } from "./project-context.js"
import { resolveCanonicalDecisionLinks } from "./decision-graph.js"
import {
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "./project-scope.js"
import { taskDaysOverdue } from "./task.js"
import { computeSubjectKey } from "../notion/normalize.js"
import type { LoreServices } from "../services.js"
import {
  formatTrustLabel,
  type Decision,
  type Fact,
  type FactPredicate,
  type Project,
  type TaskSummary,
} from "../types.js"

const DEFAULT_ASK_BUCKET_CAP = 5
const SUGGESTED_OVERFLOW_LIMIT = 20
const PROJECT_LIST_HINT = "run `lore status projects` to list configured projects"
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const GOVERNANCE_PREDICATES: ReadonlySet<FactPredicate> = new Set<FactPredicate>([
  "decided_by",
  "supersedes_decision",
])

export interface RunAskOptions {
  entity: string
  projectName?: string
  limit?: number
  includeContext?: boolean
  asOf?: string
  includeHistory?: boolean
}

export interface AskDecisionFailure {
  rootId: string
  error: unknown
}

export interface RunAskHooks {
  onDecisionFailures?: (failures: AskDecisionFailure[]) => void
  onMemoryTouchError?: (id: string, error: unknown) => void
  onFactTouchError?: (id: string, error: unknown) => void
}

export interface AskResultData {
  entity: string
  resolvedEntity: { id?: string; name: string; aliases: string[] } | null
  project: Pick<Project, "id" | "name" | "path" | "status" | "description"> | null
  isCatchAllFallback: boolean
  facts: {
    governance: Fact[]
    structure: Fact[]
  }
  tasks: TaskSummary[]
  counts: {
    governance: number
    structure: number
    tasks: number
    visibleGovernance: number
    visibleStructure: number
    visibleTasks: number
  }
  warnings: string[]
}

export interface AskResult {
  text: string
  data: AskResultData
}

type FactClass = "governance" | "structure"
type Governed = {
  sortKey: string | null
  line: string
  decision?: Decision
  fact?: Fact
}
type Structured = { fact: Fact; line: string; sortKey: string | null }

export async function runAsk(
  services: LoreServices,
  args: RunAskOptions,
  hooks: RunAskHooks = {}
): Promise<AskResult> {
  const {
    projectId,
    project: resolvedProject,
    isCatchAllFallback: resolvedCatchAllFallback,
  } = await resolveReadProjectScopeForAsk(services, args.projectName)
  const warnings: string[] = []

  let entityId: string | null = null
  let resolvedEntity: { id?: string; name: string; aliases: string[] } | null = null
  const resolution = await services.entities
    .resolveOrCreateEntity(args.entity, { autoCreate: false })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(`Entity lookup failed: ${message}`)
      return null
    })
  if (resolution) {
    if (resolution.ambiguous) {
      const candidateLabels = resolution.candidates
        .map((candidate) => `"${candidate.name}" (${candidate.id})`)
        .join(", ")
      warnings.push(
        `"${args.entity}" matches ${resolution.candidates.length} entities — falling back to substring search. ` +
          `Disambiguate by passing one of: ${candidateLabels}.`
      )
    } else if (resolution.entity) {
      entityId = resolution.entity.id
      resolvedEntity = {
        id: resolution.entity.id,
        name: resolution.entity.name,
        aliases: resolution.entity.aliases,
      }
    }
  }

  const taskVariants = expandEntityQueryVariants(args.entity, resolvedEntity)
  if (taskVariants.hitCap) {
    const droppedLabel = taskVariants.dropped
      .slice(0, 3)
      .map((dropped) => `"${dropped}"`)
      .join(", ")
    const remainder =
      taskVariants.dropped.length > 3 ? `, +${taskVariants.dropped.length - 3} more` : ""
    warnings.push(
      `Task recall capped at ${taskVariants.variants.length} alias variants for "${args.entity}" — ` +
        `dropped ${droppedLabel}${remainder}. Tasks written under the dropped aliases may be missed.`
    )
  }

  const taskListEntities =
    taskVariants.variants.length > 0 ? taskVariants.variants : [args.entity]
  const [facts, taskListing] = await Promise.all([
    services.facts.queryByEntity(args.entity, {
      projectId,
      entityId,
      asOf: args.asOf,
      includeInvalidated: args.includeHistory,
    }),
    services.tasks
      .list({ projectId, entities: taskListEntities, limit: 50 })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err)
        warnings.push(`Tasks lookup failed: ${message}`)
        return { items: [] as TaskSummary[] }
      }),
  ])
  const tasks = taskListing.items

  const includeContextBlock = args.includeContext !== false
  const projectContextLines = includeContextBlock
    ? renderProjectContextLines(
        composeProjectContext(resolvedProject, services.config, resolvedCatchAllFallback)
      )
    : []
  const framingPrefix =
    projectContextLines.length > 0 ? `${projectContextLines.join("\n")}\n\n` : ""

  const formatWarnings = () =>
    warnings.length > 0 ? `\n\nWarnings: ${warnings.join("; ")}` : ""

  const dataBase = (
    grouped: { governance: Fact[]; structure: Fact[] },
    counts: AskResultData["counts"]
  ): AskResultData => ({
    entity: args.entity,
    resolvedEntity,
    project: resolvedProject
      ? {
          id: resolvedProject.id,
          name: resolvedProject.name,
          path: resolvedProject.path,
          status: resolvedProject.status,
          description: resolvedProject.description,
        }
      : null,
    isCatchAllFallback: resolvedCatchAllFallback,
    facts: grouped,
    tasks,
    counts,
    warnings,
  })

  const emptyCounts = {
    governance: 0,
    structure: 0,
    tasks: tasks.length,
    visibleGovernance: 0,
    visibleStructure: 0,
    visibleTasks: 0,
  }
  if (facts.length === 0 && tasks.length === 0) {
    return {
      text: `${framingPrefix}No facts or tasks found about "${args.entity}".${formatWarnings()}`,
      data: dataBase({ governance: [], structure: [] }, emptyCounts),
    }
  }

  const today = new Date().toISOString().split("T")[0]!
  const cap = args.limit ?? DEFAULT_ASK_BUCKET_CAP
  const grouped = groupFactsByClass(facts)
  const decidedByFacts = grouped.governance.filter(
    (fact) => fact.predicate === "decided_by"
  )
  const supersedesFacts = grouped.governance.filter(
    (fact) => fact.predicate === "supersedes_decision"
  )

  const [{ links: decisionLinks, failures: decisionFailures }, titleMap] =
    await Promise.all([
      resolveCanonicalDecisionLinks(services, decidedByFacts, { projectId }),
      resolveReferencedTitles([...supersedesFacts, ...grouped.structure], services),
    ])

  if (decisionFailures.length > 0) {
    hooks.onDecisionFailures?.(decisionFailures)
    const rootIds = decisionFailures.map(({ rootId }) => rootId).join(", ")
    warnings.push(
      `Could not resolve ${decisionFailures.length} decision root${decisionFailures.length === 1 ? "" : "s"} (${rootIds}) — retry before relying on this result.`
    )
  }

  const governanceItems: Governed[] = [
    ...decisionLinks.map(({ fact, decision }) => ({
      sortKey: fact.validFrom,
      line: renderDecidedByLine(fact, decision, today),
      decision,
      fact,
    })),
    ...supersedesFacts.map((fact) => ({
      sortKey: fact.validFrom,
      line: renderFact(fact, {
        titleMap,
        trailing: renderGenericTrailing(fact, today, { asOf: args.asOf }),
      }),
      fact,
    })),
  ]
  const rankedGovernance = applyRecencyRanking(governanceItems)

  const structureItems: Structured[] = grouped.structure.map((fact) => ({
    fact,
    line: renderFact(fact, {
      titleMap,
      trailing: renderGenericTrailing(fact, today, { asOf: args.asOf }),
    }),
    sortKey: fact.validFrom,
  }))
  const rankedStructure = applyRecencyRanking(structureItems)

  const sections: string[] = []
  let anyOverflow = false
  let visibleGovernance: Governed[] = []
  let visibleStructure: Structured[] = []

  if (governanceItems.length > 0) {
    visibleGovernance = rankedGovernance.slice(0, cap)
    const hidden = governanceItems.length - visibleGovernance.length
    if (hidden > 0) anyOverflow = true
    const hiddenSuffix = hidden > 0 ? ` (${hidden} hidden)` : ""
    sections.push(
      `### Governance (${governanceItems.length})${hiddenSuffix}\n${visibleGovernance
        .map((item) => item.line)
        .join("\n")}`
    )
  }

  if (structureItems.length > 0) {
    visibleStructure = rankedStructure.slice(0, cap)
    const hidden = structureItems.length - visibleStructure.length
    if (hidden > 0) anyOverflow = true
    const hiddenSuffix = hidden > 0 ? ` (${hidden} hidden)` : ""
    sections.push(
      `### Structure (${structureItems.length})${hiddenSuffix}\n${visibleStructure
        .map((item) => item.line)
        .join("\n")}`
    )
  }

  const taskItems = renderTaskItems(tasks, today)
  let visibleTasks: typeof taskItems = []
  if (taskItems.length > 0) {
    visibleTasks = taskItems.slice(0, cap)
    const hidden = taskItems.length - visibleTasks.length
    if (hidden > 0) anyOverflow = true
    const hiddenSuffix = hidden > 0 ? ` (${hidden} hidden)` : ""
    sections.push(
      `### Tasks (${taskItems.length})${hiddenSuffix}\n${visibleTasks
        .map((item) => item.line)
        .join("\n")}`
    )
  }

  const counts = {
    governance: governanceItems.length,
    structure: structureItems.length,
    tasks: taskItems.length,
    visibleGovernance: visibleGovernance.length,
    visibleStructure: visibleStructure.length,
    visibleTasks: visibleTasks.length,
  }

  if (sections.length === 0) {
    return {
      text: `${framingPrefix}No current facts or tasks found about "${args.entity}".${formatWarnings()}`,
      data: dataBase(grouped, counts),
    }
  }

  const totalResults = governanceItems.length + structureItems.length + taskItems.length
  const overflowHint =
    anyOverflow && args.limit === undefined
      ? `\n\n(pass limit to raise the cap; e.g. limit=${SUGGESTED_OVERFLOW_LIMIT})`
      : ""
  const noun = taskItems.length > 0 && facts.length === 0 ? "results" : "facts"
  const text = `${framingPrefix}${totalResults} ${noun} about "${args.entity}":\n\n${sections.join("\n\n")}${overflowHint}${formatWarnings()}`

  const sourceMemoryIds = collectAskSourceMemoryIds(visibleGovernance, visibleStructure)
  if (sourceMemoryIds.length > 0) {
    try {
      const cited = await services.memories.getManyById(sourceMemoryIds)
      await services.memories.touchOnRead(cited, {
        onError: hooks.onMemoryTouchError,
      })
    } catch {
      // Citation touch is advisory and must not block the read response.
    }
  }

  const visibleFacts: Fact[] = [
    ...visibleGovernance.flatMap((item) => (item.fact ? [item.fact] : [])),
    ...visibleStructure.map((item) => item.fact),
  ]
  if (visibleFacts.length > 0) {
    try {
      await services.facts.touchOnRead(visibleFacts, {
        onError: hooks.onFactTouchError,
      })
    } catch {
      // Citation touch is advisory and must not block the read response.
    }
  }

  return {
    text,
    data: dataBase(grouped, counts),
  }
}

async function resolveReadProjectScopeForAsk(
  services: LoreServices,
  projectName: string | undefined
): Promise<{
  projectId: string | undefined
  project: Project | null
  isCatchAllFallback: boolean
}> {
  const explicit = validateExplicitProjectScopeName(projectName, "--project", {
    listHint: PROJECT_LIST_HINT,
  })
  if (explicit !== undefined) {
    const project = await resolveProjectScopeName(
      services.projects,
      explicit,
      "--project",
      {
        listHint: PROJECT_LIST_HINT,
      }
    )
    return { projectId: project.id, project, isCatchAllFallback: false }
  }
  return {
    projectId: services.context.project?.id,
    project: services.context.project,
    isCatchAllFallback: services.context.isCatchAllFallback,
  }
}

function factClass(predicate: FactPredicate): FactClass {
  return GOVERNANCE_PREDICATES.has(predicate) ? "governance" : "structure"
}

function groupFactsByClass(facts: readonly Fact[]): {
  governance: Fact[]
  structure: Fact[]
} {
  const groups = { governance: [] as Fact[], structure: [] as Fact[] }
  for (const fact of facts) {
    groups[factClass(fact.predicate)].push(fact)
  }
  const compare = (a: Fact, b: Fact): number => compareSortKeyDesc(a, b)
  groups.governance.sort(compare)
  groups.structure.sort(compare)
  return groups
}

function renderDecidedByLine(fact: Fact, decision: Decision, today: string): string {
  const review = decision.reviewBy
    ? decision.reviewBy <= today
      ? ` **(DECISION REVIEW OVERDUE — ${decision.reviewBy})**`
      : ` (decision review by ${decision.reviewBy})`
    : ""
  const decided = decision.decidedAt ? ` (decided ${decision.decidedAt})` : ""
  const trustLine = renderTrustLine(effectiveFactConfidenceScore(fact, today), "  ")
  const trustSegment = trustLine !== null ? `\n${trustLine}` : ""
  return `- **${fact.subject}** decided by **${decision.title}** [${decision.status}]${decided}${review}${trustSegment}\n  Decision ID: ${decision.id} | Fact ID: ${fact.id}`
}

function renderGenericTrailing(
  fact: Fact,
  today: string,
  opts: { asOf?: string } = {}
): string {
  const validity = fact.validFrom ? ` (since ${fact.validFrom})` : ""
  const suppressInvalidatedAt =
    opts.asOf !== undefined &&
    fact.invalidatedAt != null &&
    fact.invalidatedAt > opts.asOf
  const invalidated =
    fact.invalidatedAt && !suppressInvalidatedAt
      ? ` **(INVALIDATED on ${fact.invalidatedAt})**`
      : ""
  const review = fact.reviewBy
    ? fact.reviewBy <= today
      ? ` **(OVERDUE — review by ${fact.reviewBy})**`
      : ` (review by ${fact.reviewBy})`
    : ""
  const trustLine = renderTrustLine(effectiveFactConfidenceScore(fact, today), "  ")
  const trustSegment = trustLine !== null ? `\n${trustLine}` : ""
  return `[${fact.confidence}]${validity}${invalidated}${review}${trustSegment}\n  ID: ${fact.id}`
}

function compareSortKeyDesc(
  a: { sortKey?: string | null; validFrom?: string | null },
  b: { sortKey?: string | null; validFrom?: string | null }
): number {
  const aKey = a.sortKey ?? a.validFrom ?? null
  const bKey = b.sortKey ?? b.validFrom ?? null
  if (aKey === bKey) return 0
  if (!aKey) return 1
  if (!bKey) return -1
  return aKey < bKey ? 1 : -1
}

function applyRecencyRanking<T extends { sortKey: string | null }>(items: T[]): T[] {
  if (items.length <= 1) return items
  return [...items].sort(compareSortKeyDesc)
}

function effectiveFactConfidenceScore(fact: Fact, today: string): number | null {
  return effectiveConfidenceScore(
    fact.confidenceScore ?? null,
    fact.lastReferencedAt ?? null,
    today
  )
}

function collectAskSourceMemoryIds(
  visibleGovernance: ReadonlyArray<{ decision?: Decision; fact?: Fact }>,
  visibleStructure: ReadonlyArray<{ fact: Fact }>
): string[] {
  const ids = new Set<string>()
  for (const item of visibleGovernance) {
    if (item.decision) ids.add(item.decision.id)
    if (item.fact?.sourceMemoryId) ids.add(item.fact.sourceMemoryId)
  }
  for (const item of visibleStructure) {
    if (item.fact.sourceMemoryId) ids.add(item.fact.sourceMemoryId)
  }
  return Array.from(ids)
}

function renderTaskItems(
  tasks: TaskSummary[],
  today: string
): Array<{
  sortKey: string | null
  line: string
}> {
  const taskItems = tasks.map((task) => {
    const overdueDays = taskDaysOverdue(task, today)
    const stateLabel = task.taskState ?? "open"
    const blocker = task.blockedBy ? `, blocked by ${task.blockedBy}` : ""
    const due =
      overdueDays !== null && task.reviewBy
        ? overdueDays === 0
          ? " **(due today)**"
          : ` **(${overdueDays} day${overdueDays === 1 ? "" : "s"} overdue — review by ${task.reviewBy})**`
        : task.reviewBy
          ? ` (due ${task.reviewBy})`
          : ""
    const prefix = overdueDays !== null ? "⚠ " : ""
    return {
      sortKey: task.reviewBy ?? task.decidedAt ?? null,
      line: `- ${prefix}**${task.title}** [${stateLabel}${blocker}]${due}\n  Task ID: ${task.id}`,
    }
  })
  taskItems.sort((a, b) => {
    if (a.sortKey === b.sortKey) return 0
    if (!a.sortKey) return 1
    if (!b.sortKey) return -1
    return a.sortKey < b.sortKey ? -1 : 1
  })
  return taskItems
}

interface TitleResolvers {
  memories: { getTitleById(id: string): Promise<string | null> }
}

async function resolveReferencedTitles(
  facts: readonly Fact[],
  services: TitleResolvers
): Promise<Map<string, string>> {
  const ids: string[] = []
  for (const fact of facts) {
    if (isUuid(fact.subject)) ids.push(fact.subject)
    if (isUuid(fact.object)) ids.push(fact.object)
  }
  return resolveTitles(ids, (id) => services.memories.getTitleById(id))
}

async function resolveTitles(
  ids: readonly string[],
  loader: (id: string) => Promise<string | null>
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
    })
  )
  return new Map(
    entries.filter((entry): entry is readonly [string, string] => entry !== null)
  )
}

function renderFact(
  fact: Fact,
  options: {
    titleMap: Map<string, string>
    prefix?: string
    trailing?: string
  }
): string {
  const subject = displayValue(fact.subject, options.titleMap)
  const object = displayValue(fact.object, options.titleMap)
  const predicate = fact.predicate.replace(/_/g, " ")
  const prefix = options.prefix ?? ""
  const suffix = options.trailing ? ` ${options.trailing}` : ""
  return `- ${prefix}**${subject}** ${predicate} **${object}**${suffix}`
}

function displayValue(value: string, titleMap: Map<string, string>): string {
  if (!isUuid(value)) return value
  return displayId(value, titleMap)
}

function displayId(id: string, titleMap: Map<string, string>): string {
  const title = titleMap.get(id.toLowerCase())
  return title ?? unresolvedHint(id)
}

function unresolvedHint(id: string): string {
  const normalized = id.toLowerCase()
  if (!isUuid(normalized)) return `${id} (?)`
  return `...${normalized.slice(-8)} (?)`
}

function isUuid(value: string | null | undefined): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value)
}

function renderTrustLine(confidenceScore: number | null, indent = ""): string | null {
  if (confidenceScore === null) return null
  const label = formatTrustLabel(confidenceScore)
  if (label === null) return null
  return `${indent}_${label}_`
}

export function normalizeAskEntityInput(entity: string): string {
  return computeSubjectKey(entity)
}
