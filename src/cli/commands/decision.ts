import { Command } from "commander"
import { syncDecisionReachability } from "../../core/decision-graph.js"
import { initServices, type LoreServices } from "../../services.js"
import { memoryScopeToInput } from "../../types.js"
import type { CreateDecisionInput, Decision, Fact } from "../../types.js"
import { notionPageUrl, terminalLink } from "../output.js"
import type { CliParseResult } from "../parse.js"
import {
  loadActiveTagVocabularyForCli,
  parseCsvList,
  parseTagsList,
  parseTextSource,
  readTextSource,
  resolveProjectIdForCli,
  validateNonBlank,
  validateYmd,
  type TextSource,
} from "./common.js"

const DECISION_FACT_CONFIDENCE = "likely" as const

export interface DecisionCreateCliOptions {
  statement: string
  rationaleSource: TextSource
  projectName: string | undefined
  topicName: string | undefined
  affects: string[] | undefined
  supersedesIds: string[] | undefined
  alternatives: string | undefined
  consequences: string | undefined
  reviewBy: string | undefined
  decidedAt: string | undefined
  tags: string[] | undefined
  keywords: string | undefined
  synopsis: string | undefined
}

export interface DecisionCreateCliResultData {
  id: string
  decision: string
  url: string
  projectId: string | null
  projectLabel: string
  topicId: string | null
  topicLabel: string | null
  affected: string[]
  decidedByFactIds: string[]
  superseded: Array<{ id: string; title: string }>
  supersedesFactIds: string[]
  reachabilityUpdates: Array<{
    oldDecisionId: string
    invalidated: number
    created: number
  }>
  warnings: string[]
  row: Decision
}

export interface DecisionCreateCliResult {
  text: string
  data: DecisionCreateCliResultData
}

export function parseDecisionCreateCliOptions(
  statement: string,
  raw: {
    rationale?: string
    rationaleFile?: string
    project?: string
    topic?: string
    affects?: string
    supersedes?: string
    alternatives?: string
    consequences?: string
    reviewBy?: string
    decidedAt?: string
    tags?: string
    keywords?: string
    synopsis?: string
  },
  tagVocabulary: readonly string[]
): CliParseResult<DecisionCreateCliOptions> {
  const parsedStatement = validateNonBlank(statement, "<statement>")
  if (!parsedStatement.ok) return parsedStatement
  const rationaleSource = parseTextSource(
    { inline: raw.rationale, file: raw.rationaleFile },
    { inlineFlag: "--rationale", fileFlag: "--rationale-file" }
  )
  if (!rationaleSource.ok) return rationaleSource
  const reviewBy = validateYmd(raw.reviewBy, "--review-by")
  if (!reviewBy.ok) return reviewBy
  const decidedAt = validateYmd(raw.decidedAt, "--decided-at")
  if (!decidedAt.ok) return decidedAt
  const tags = parseTagsList(raw.tags, "--tags", tagVocabulary)
  if (!tags.ok) return tags

  return {
    ok: true,
    value: {
      statement: parsedStatement.value,
      rationaleSource: rationaleSource.value,
      projectName: raw.project,
      topicName: raw.topic,
      affects: parseCsvList(raw.affects),
      supersedesIds: parseCsvList(raw.supersedes),
      alternatives: raw.alternatives,
      consequences: raw.consequences,
      reviewBy: reviewBy.value,
      decidedAt: decidedAt.value,
      tags: tags.value,
      keywords: raw.keywords,
      synopsis: raw.synopsis,
    },
  }
}

export async function runDecisionCreate(
  services: LoreServices,
  opts: DecisionCreateCliOptions,
  rationale: string
): Promise<DecisionCreateCliResult> {
  const parsedRationale = validateNonBlank(rationale, "--rationale")
  if (!parsedRationale.ok) throw new Error(parsedRationale.message)

  const { projectId, projectLabel } = await resolveProjectIdForCli(
    services,
    opts.projectName
  )
  const warnings: string[] = []
  let topicId: string | undefined
  let topicLabel: string | null = null
  if (opts.topicName && projectId) {
    const topic = await services.topics.getOrCreate(opts.topicName, [projectId])
    topicId = topic.id
    topicLabel = topic.name
  } else if (opts.topicName) {
    warnings.push(`Topic "${opts.topicName}" skipped (requires a project scope)`)
  }

  const input: CreateDecisionInput = {
    decision: opts.statement,
    rationale: parsedRationale.value,
    projectIds: projectId ? [projectId] : undefined,
    topicId,
    reviewBy: opts.reviewBy,
    decidedAt: opts.decidedAt,
    alternatives: opts.alternatives,
    consequences: opts.consequences,
    tags: opts.tags,
    keywords: opts.keywords,
    synopsis: opts.synopsis,
  }
  const decision = await services.decisions.create(input)
  const affected = opts.affects ?? []
  const decidedByFacts: Fact[] = []
  for (const [index, entity] of affected.entries()) {
    let subjectEntityId: string | undefined
    try {
      const resolution = await services.entities.resolveOrCreateEntity(entity, {
        autoCreate: true,
        projectIds: decision.projectIds,
      })
      if (resolution.ambiguous) {
        const labels = resolution.candidates
          .map((candidate) => `${candidate.name} (${candidate.id})`)
          .join(", ")
        warnings.push(
          `Ambiguous --affects entry "${entity}" matched ${resolution.candidates.length} entities (${labels}); fact written without SubjectEntity`
        )
      } else if (resolution.entity) {
        subjectEntityId = resolution.entity.id
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      warnings.push(
        `Entity resolution failed for --affects entry "${entity}": ${message}; fact written without SubjectEntity`
      )
    }
    try {
      decidedByFacts.push(
        await services.facts.create({
          subject: entity,
          predicate: "decided_by",
          object: decision.id,
          projectIds: decision.projectIds.length > 0 ? decision.projectIds : undefined,
          sourceMemoryId: decision.id,
          confidence: DECISION_FACT_CONFIDENCE,
          subjectEntityId,
          scope: memoryScopeToInput(decision.scope),
        })
      )
    } catch (err) {
      throw new Error(
        formatDecisionPartialFailure(
          decision,
          `the decided_by fact for "${entity}" failed`,
          err,
          [
            ...formatPendingItems("Created decided_by facts", affected.slice(0, index)),
            ...formatPendingItems("Missing decided_by facts", affected.slice(index)),
            ...formatPendingItems(
              "Pending supersessions not attempted",
              opts.supersedesIds ?? []
            ),
          ]
        ),
        { cause: err }
      )
    }
  }

  const superseded: Array<{ id: string; title: string }> = []
  const supersedesFactIds: string[] = []
  const reachabilityUpdates: Array<{
    oldDecisionId: string
    invalidated: number
    created: number
  }> = []
  const supersedesIds = opts.supersedesIds ?? []
  for (const [index, oldId] of supersedesIds.entries()) {
    let oldDecision: Decision | undefined
    try {
      oldDecision = await services.decisions.getById(oldId)
      await services.decisions.supersede(decision.id, oldId)
      const supersedesFact = await services.facts.create({
        subject: decision.id,
        predicate: "supersedes_decision",
        object: oldId,
        projectIds: decision.projectIds.length > 0 ? decision.projectIds : undefined,
        sourceMemoryId: decision.id,
        confidence: DECISION_FACT_CONFIDENCE,
        scope: memoryScopeToInput(decision.scope),
      })
      supersedesFactIds.push(supersedesFact.id)

      const reachability = await syncDecisionReachability(services, oldId, decision)
      reachabilityUpdates.push({
        oldDecisionId: oldId,
        invalidated: reachability.invalidated,
        created: reachability.created,
      })
      superseded.push({ id: oldId, title: oldDecision.title })
    } catch (err) {
      const target = oldDecision ? `"${oldDecision.title}" (${oldId})` : oldId
      throw new Error(
        formatDecisionPartialFailure(decision, `supersession for ${target} failed`, err, [
          ...formatPendingItems(
            "Completed supersessions before failure",
            superseded.map((entry) => `${entry.title} (${entry.id})`)
          ),
          ...formatPendingItems("Missing supersessions", supersedesIds.slice(index)),
        ]),
        { cause: err }
      )
    }
  }

  const url = notionPageUrl(decision.id)
  const lines = [
    `Saved decision: "${decision.title}" (${decision.id})`,
    `URL: ${terminalLink(url, url)}`,
    `Project: ${projectLabel}`,
  ]
  if (topicLabel !== null) lines.push(`Topic: ${topicLabel}`)
  if (affected.length > 0) lines.push(`Affects: ${affected.join(", ")}`)
  if (superseded.length > 0) {
    lines.push(
      `Superseded: ${superseded.map((entry) => `${entry.title} (${entry.id})`).join(", ")}`
    )
  }
  const reachabilityCount = reachabilityUpdates.reduce(
    (sum, update) => sum + update.invalidated,
    0
  )
  if (reachabilityCount > 0) {
    lines.push(
      `Graph updates: retargeted ${reachabilityCount} decided_by ${reachabilityCount === 1 ? "fact" : "facts"}`
    )
  }
  if (warnings.length > 0) lines.push(`Warnings: ${warnings.join("; ")}`)

  return {
    text: lines.join("\n"),
    data: {
      id: decision.id,
      decision: decision.title,
      url,
      projectId: projectId ?? null,
      projectLabel,
      topicId: topicId ?? null,
      topicLabel,
      affected,
      decidedByFactIds: decidedByFacts.map((fact) => fact.id),
      superseded,
      supersedesFactIds,
      reachabilityUpdates,
      warnings,
      row: decision,
    },
  }
}

function formatPendingItems(label: string, items: readonly string[]): string[] {
  return items.length > 0 ? [`${label}: ${items.join(", ")}`] : []
}

function formatDecisionPartialFailure(
  decision: Decision,
  failed: string,
  err: unknown,
  details: string[]
): string {
  const cause = err instanceof Error ? err.message : String(err)
  const detailText = details.length > 0 ? ` ${details.join(". ")}.` : ""
  return (
    `Decision create partial failure: decision "${decision.title}" (${decision.id}) was saved, but ${failed}: ${cause}.` +
    detailText +
    " Repair the saved decision graph; do not recreate the decision."
  )
}

const createCommand = new Command("create")
  .description("Create a decision")
  .argument("<statement>", "Decision statement")
  .option("--rationale <markdown>", "Decision rationale markdown")
  .option(
    "--rationale-file <path>",
    "Read decision rationale markdown from a file; '-' reads stdin"
  )
  .option("-p, --project <name>", "Project name (defaults to cwd-resolved project)")
  .option("--topic <name>", "Topic name within the project")
  .option("--affects <csv>", "Affected entity names")
  .option("--supersedes <csv>", "Decision page IDs this decision supersedes")
  .option("--alternatives <text>", "Alternatives considered")
  .option("--consequences <text>", "Consequences accepted")
  .option("--review-by <YYYY-MM-DD>", "Review-by date")
  .option("--decided-at <YYYY-MM-DD>", "Decision date")
  .option("--tags <csv>", "Comma-separated tags from the closed vocabulary")
  .option("--keywords <text>", "Free-form keywords")
  .option("--synopsis <text>", "1-2 sentence synopsis")
  .option("--json", "Emit the result as JSON")
  .action(
    async (
      statement: string,
      opts: {
        rationale?: string
        rationaleFile?: string
        project?: string
        topic?: string
        affects?: string
        supersedes?: string
        alternatives?: string
        consequences?: string
        reviewBy?: string
        decidedAt?: string
        tags?: string
        keywords?: string
        synopsis?: string
        json?: boolean
      }
    ) => {
      try {
        const tagVocabulary = await loadActiveTagVocabularyForCli()
        const parsed = parseDecisionCreateCliOptions(statement, opts, tagVocabulary)
        if (!parsed.ok) {
          console.error(`Decision create failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const rationale = await readTextSource(parsed.value.rationaleSource)
        const parsedRationale = validateNonBlank(rationale, "--rationale")
        if (!parsedRationale.ok) {
          console.error(`Decision create failed: ${parsedRationale.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const result = await runDecisionCreate(
          services,
          parsed.value,
          parsedRationale.value
        )
        console.log(opts.json ? JSON.stringify(result.data, null, 2) : result.text)
      } catch (err) {
        console.error("Decision create failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

export const decisionCommand = new Command("decision")
  .description("Decision operations")
  .addCommand(createCommand)
