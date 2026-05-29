import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"
import type {
  CreateMemoryInput,
  Memory,
  MemoryKind,
  UpdateMemoryInput,
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
  YMD_HINT,
  YMD_REGEX,
} from "./common.js"

const MEMORY_KINDS = [
  "note",
  "decision",
  "incident",
  "runbook",
  "postmortem",
  "policy",
  "operational",
] as const satisfies readonly MemoryKind[]

export interface MemorySaveCliOptions {
  title: string
  contentSource: TextSource
  projectName: string | undefined
  topicName: string | undefined
  kind: MemoryKind | undefined
  tags: string[] | undefined
  keywords: string | undefined
  reviewBy: string | undefined
  decidedAt: string | undefined
  synopsis: string | undefined
  expiresAt: string | undefined
  expiresOn: string | undefined
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

export interface MemoryUpdateCliOptions {
  memoryId: string
  kind: MemoryKind | undefined
  expiresAt: string | null | undefined
  expiresOn: string | null | undefined
}

export interface MemoryUpdateCliResultData {
  id: string
  title: string
  url: string
  kind: MemoryKind
  expiresAt: string | null
  expiresOn: string | null
  memory: Memory
}

export interface MemoryUpdateCliResult {
  text: string
  data: MemoryUpdateCliResultData
}

function validateOptionalText(
  raw: string | undefined,
  flag: string
): CliParseResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  const parsed = validateNonBlank(raw, flag)
  if (!parsed.ok) return parsed
  return { ok: true, value: parsed.value }
}

function validateClearableYmd(
  raw: string | undefined,
  flag: string
): CliParseResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === "") return { ok: true, value: null }
  if (!YMD_REGEX.test(raw)) {
    return {
      ok: false,
      message: `${flag} ${YMD_HINT} or empty string to clear, got "${raw}"`,
    }
  }
  return { ok: true, value: raw }
}

function validateClearableText(
  raw: string | undefined,
  flag: string
): CliParseResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === "") return { ok: true, value: null }
  const parsed = validateNonBlank(raw, flag)
  if (!parsed.ok) return parsed
  return { ok: true, value: parsed.value }
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
    reviewBy?: string
    decidedAt?: string
    synopsis?: string
    expiresAt?: string
    expiresOn?: string
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
  const reviewBy = validateYmd(raw.reviewBy, "--review-by")
  if (!reviewBy.ok) return reviewBy
  const decidedAt = validateYmd(raw.decidedAt, "--decided-at")
  if (!decidedAt.ok) return decidedAt
  const expiresAt = validateYmd(raw.expiresAt, "--expires-at")
  if (!expiresAt.ok) return expiresAt
  const expiresOn = validateOptionalText(raw.expiresOn, "--expires-on")
  if (!expiresOn.ok) return expiresOn

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
      reviewBy: reviewBy.value,
      decidedAt: decidedAt.value,
      synopsis: raw.synopsis,
      expiresAt: expiresAt.value,
      expiresOn: expiresOn.value,
    },
  }
}

export function parseMemoryUpdateCliOptions(
  memoryId: string,
  raw: {
    kind?: string
    expiresAt?: string
    expiresOn?: string
  }
): CliParseResult<MemoryUpdateCliOptions> {
  const parsedMemoryId = validateNonBlank(memoryId, "<memory-id>")
  if (!parsedMemoryId.ok) return parsedMemoryId
  const kind = validateChoice(raw.kind, "--kind", MEMORY_KINDS)
  if (!kind.ok) return kind
  const expiresAt = validateClearableYmd(raw.expiresAt, "--expires-at")
  if (!expiresAt.ok) return expiresAt
  const expiresOn = validateClearableText(raw.expiresOn, "--expires-on")
  if (!expiresOn.ok) return expiresOn
  if (
    kind.value === undefined &&
    expiresAt.value === undefined &&
    expiresOn.value === undefined
  ) {
    return {
      ok: false,
      message: "Pass at least one of --kind, --expires-at, or --expires-on",
    }
  }

  return {
    ok: true,
    value: {
      memoryId: parsedMemoryId.value,
      kind: kind.value,
      expiresAt: expiresAt.value,
      expiresOn: expiresOn.value,
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
    reviewBy: opts.reviewBy,
    decidedAt: opts.decidedAt,
    synopsis: opts.synopsis,
    expiresAt: opts.expiresAt,
    expiresOn: opts.expiresOn,
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

export async function runMemoryUpdate(
  services: LoreServices,
  opts: MemoryUpdateCliOptions
): Promise<MemoryUpdateCliResult> {
  const input: UpdateMemoryInput = {}
  if (opts.kind !== undefined) input.kind = opts.kind
  if (opts.expiresAt !== undefined) input.expiresAt = opts.expiresAt
  if (opts.expiresOn !== undefined) input.expiresOn = opts.expiresOn

  const memory = await services.memories.update(opts.memoryId, input)
  const url = notionPageUrl(memory.id)
  const expiresAt = memory.scope?.expiresAt ?? null
  const expiresOn =
    memory.expiresOn && memory.expiresOn.trim().length > 0 ? memory.expiresOn : null
  const lines = [
    `Updated memory: "${memory.title}" (${memory.id})`,
    `URL: ${terminalLink(url, url)}`,
    `Kind: ${memory.kind}`,
  ]
  if (expiresAt !== null) lines.push(`Expires At: ${expiresAt}`)
  if (expiresOn !== null) lines.push(`Expires On: ${expiresOn}`)

  return {
    text: lines.join("\n"),
    data: {
      id: memory.id,
      title: memory.title,
      url,
      kind: memory.kind,
      expiresAt,
      expiresOn,
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
  .option("--review-by <YYYY-MM-DD>", "Review-by date")
  .option("--decided-at <YYYY-MM-DD>", "Canonical decision date")
  .option("--synopsis <text>", "1-2 sentence synopsis")
  .option("--expires-at <YYYY-MM-DD>", "Expiry date for temporary memories")
  .option("--expires-on <marker>", "Event-bound expiry marker")
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
        reviewBy?: string
        decidedAt?: string
        synopsis?: string
        expiresAt?: string
        expiresOn?: string
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

const updateCommand = new Command("update")
  .description("Update memory metadata")
  .argument("<memory-id>", "ID of the memory to update")
  .option("--kind <kind>", `Memory kind: ${MEMORY_KINDS.join(" | ")}`)
  .option("--expires-at <YYYY-MM-DD>", "Expiry date (pass empty string to clear)")
  .option(
    "--expires-on <marker>",
    "Event-bound expiry marker (pass empty string to clear)"
  )
  .option("--json", "Emit the result as JSON")
  .action(
    async (
      memoryId: string,
      opts: {
        kind?: string
        expiresAt?: string
        expiresOn?: string
        json?: boolean
      }
    ) => {
      try {
        const parsed = parseMemoryUpdateCliOptions(memoryId, opts)
        if (!parsed.ok) {
          console.error(`Memory update failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const result = await runMemoryUpdate(services, parsed.value)
        console.log(opts.json ? JSON.stringify(result.data, null, 2) : result.text)
      } catch (err) {
        console.error("Memory update failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

export const memoryCommand = new Command("memory")
  .description("Memory operations")
  .addCommand(saveCommand)
  .addCommand(updateCommand)
