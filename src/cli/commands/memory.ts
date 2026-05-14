import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"
import type {
  CreateMemoryInput,
  Memory,
  MemoryConfidence,
  MemoryKind,
} from "../../types.js"
import { notionPageUrl, terminalLink } from "../output.js"
import type { CliParseResult } from "../parse.js"
import {
  loadActiveTagVocabularyForCli,
  parseTagsList,
  parseTextSource,
  readTextSource,
  resolveProjectIdForCli,
  validateChoice,
  validateNonBlank,
  validateYmd,
  type TextSource,
} from "./common.js"

const MEMORY_KINDS = [
  "note",
  "decision",
  "incident",
  "runbook",
  "postmortem",
  "policy",
] as const satisfies readonly MemoryKind[]
const CONFIDENCES = ["certain", "likely", "speculative"] as const

export interface MemorySaveCliOptions {
  title: string
  contentSource: TextSource
  projectName: string | undefined
  topicName: string | undefined
  kind: MemoryKind | undefined
  tags: string[] | undefined
  keywords: string | undefined
  confidence: MemoryConfidence | undefined
  reviewBy: string | undefined
  decidedAt: string | undefined
  synopsis: string | undefined
}

export interface MemorySaveCliResultData {
  id: string
  title: string
  url: string
  projectId: string | null
  projectLabel: string
  topicId: string | null
  topicLabel: string | null
  warnings: string[]
  memory: Memory
}

export interface MemorySaveCliResult {
  text: string
  data: MemorySaveCliResultData
}

export function parseMemorySaveCliOptions(
  title: string,
  raw: {
    content?: string
    contentFile?: string
    project?: string
    topic?: string
    kind?: string
    tags?: string
    keywords?: string
    confidence?: string
    reviewBy?: string
    decidedAt?: string
    synopsis?: string
  },
  tagVocabulary: readonly string[]
): CliParseResult<MemorySaveCliOptions> {
  const parsedTitle = validateNonBlank(title, "<title>")
  if (!parsedTitle.ok) return parsedTitle
  const contentSource = parseTextSource(
    { inline: raw.content, file: raw.contentFile },
    { inlineFlag: "--content", fileFlag: "--content-file" }
  )
  if (!contentSource.ok) return contentSource
  const kind = validateChoice(raw.kind, "--kind", MEMORY_KINDS)
  if (!kind.ok) return kind
  const tags = parseTagsList(raw.tags, "--tags", tagVocabulary)
  if (!tags.ok) return tags
  const confidence = validateChoice(raw.confidence, "--confidence", CONFIDENCES)
  if (!confidence.ok) return confidence
  const reviewBy = validateYmd(raw.reviewBy, "--review-by")
  if (!reviewBy.ok) return reviewBy
  const decidedAt = validateYmd(raw.decidedAt, "--decided-at")
  if (!decidedAt.ok) return decidedAt

  return {
    ok: true,
    value: {
      title: parsedTitle.value,
      contentSource: contentSource.value,
      projectName: raw.project,
      topicName: raw.topic,
      kind: kind.value,
      tags: tags.value,
      keywords: raw.keywords,
      confidence: confidence.value,
      reviewBy: reviewBy.value,
      decidedAt: decidedAt.value,
      synopsis: raw.synopsis,
    },
  }
}

export async function runMemorySave(
  services: LoreServices,
  opts: MemorySaveCliOptions,
  content: string
): Promise<MemorySaveCliResult> {
  const parsedContent = validateNonBlank(content, "--content")
  if (!parsedContent.ok) throw new Error(parsedContent.message)

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

  const input: CreateMemoryInput = {
    title: opts.title,
    content: parsedContent.value,
    projectIds: projectId ? [projectId] : undefined,
    topicId,
    source: "manual",
    kind: opts.kind,
    tags: opts.tags,
    keywords: opts.keywords,
    confidence: opts.confidence,
    reviewBy: opts.reviewBy,
    decidedAt: opts.decidedAt,
    synopsis: opts.synopsis,
  }
  const memory = await services.memories.create(input)
  const url = notionPageUrl(memory.id)
  const lines = [
    `Saved memory: "${memory.title}" (${memory.id})`,
    `URL: ${terminalLink(url, url)}`,
    `Project: ${projectLabel}`,
  ]
  if (topicLabel !== null) lines.push(`Topic: ${topicLabel}`)
  if (warnings.length > 0) lines.push(`Warnings: ${warnings.join("; ")}`)

  return {
    text: lines.join("\n"),
    data: {
      id: memory.id,
      title: memory.title,
      url,
      projectId: projectId ?? null,
      projectLabel,
      topicId: topicId ?? null,
      topicLabel,
      warnings,
      memory,
    },
  }
}

const saveCommand = new Command("save")
  .description("Save a memory")
  .argument("<title>", "Memory title")
  .option("--content <markdown>", "Memory body markdown")
  .option(
    "--content-file <path>",
    "Read memory body markdown from a file; '-' reads stdin"
  )
  .option("-p, --project <name>", "Project name (defaults to cwd-resolved project)")
  .option("--topic <name>", "Topic name within the project")
  .option("--kind <kind>", `Memory kind: ${MEMORY_KINDS.join(" | ")}`)
  .option("--tags <csv>", "Comma-separated tags from the closed vocabulary")
  .option("--keywords <text>", "Free-form keywords")
  .option("--confidence <value>", `Confidence: ${CONFIDENCES.join(" | ")}`)
  .option("--review-by <YYYY-MM-DD>", "Review-by date")
  .option("--decided-at <YYYY-MM-DD>", "Canonical decision date")
  .option("--synopsis <text>", "1-2 sentence synopsis")
  .option("--json", "Emit the result as JSON")
  .action(
    async (
      title: string,
      opts: {
        content?: string
        contentFile?: string
        project?: string
        topic?: string
        kind?: string
        tags?: string
        keywords?: string
        confidence?: string
        reviewBy?: string
        decidedAt?: string
        synopsis?: string
        json?: boolean
      }
    ) => {
      try {
        const tagVocabulary = await loadActiveTagVocabularyForCli()
        const parsed = parseMemorySaveCliOptions(title, opts, tagVocabulary)
        if (!parsed.ok) {
          console.error(`Memory save failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const content = await readTextSource(parsed.value.contentSource)
        const parsedContent = validateNonBlank(content, "--content")
        if (!parsedContent.ok) {
          console.error(`Memory save failed: ${parsedContent.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const result = await runMemorySave(services, parsed.value, parsedContent.value)
        console.log(opts.json ? JSON.stringify(result.data, null, 2) : result.text)
      } catch (err) {
        console.error("Memory save failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

export const memoryCommand = new Command("memory")
  .description("Memory operations")
  .addCommand(saveCommand)
