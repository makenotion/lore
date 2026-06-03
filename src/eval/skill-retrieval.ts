import { createHash } from "node:crypto"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, parse, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { setTimeout as sleep } from "node:timers/promises"
import type { Client } from "@notionhq/client"
import pLimit from "p-limit"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { MemoryService } from "../core/memory.js"
import { defaultFeatureFlags, type LoreFeatureFlags } from "../feature-flags.js"
import { initServices, type LoreServices } from "../services.js"
import type { Memory, SearchExplain, Topic } from "../types.js"
import { averageMetric, scoreRanking, type RankingMetrics } from "./rank-metrics.js"

export const SKILL_RETRIEVAL_RUNNER = "skill-retrieval" as const

export const SKILL_RETRIEVAL_LANES = ["keyword", "notion-ai"] as const

export type SkillRetrievalLane = (typeof SKILL_RETRIEVAL_LANES)[number]

const skillRetrievalLaneSchema = z.enum(SKILL_RETRIEVAL_LANES)
const SKILL_RETRIEVAL_IMPORT_ATTEMPTS = 4
const SKILL_RETRIEVAL_IMPORT_TRANSFORM_VERSION = 3
const SKILL_RETRIEVAL_IMPORT_FIELD_CHAR_LIMIT = 60_000
const SKILL_RETRIEVAL_NOTION_SEARCH_ATTEMPTS = 5
const SKILL_RETRIEVAL_NOTION_SEARCH_RETRY_BASE_MS = 1_000

const skillRetrievalCorpusSchema = z
  .object({
    kind: z.literal("skillret"),
    root: z.string().min(1),
    split: z.enum(["train", "test"]).default("test"),
    skillsPath: z.string().min(1).optional(),
    queriesPath: z.string().min(1).optional(),
    qrelsPath: z.string().min(1).optional(),
  })
  .strict()

const skillRetrievalDocumentSchema = z
  .object({
    textFields: z
      .array(z.enum(["name", "description", "skill_md", "body"]))
      .min(1)
      .default(["name", "description", "skill_md"]),
  })
  .strict()
  .default({ textFields: ["name", "description", "skill_md"] })

const skillRetrievalQuerySelectionSchema = z
  .object({
    limit: z.number().int().positive().optional(),
    seed: z.string().min(1).optional(),
    ids: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .default({})

const skillRetrievalNotionSchema = z
  .object({
    projectName: z.string().trim().min(1),
    topicName: z.string().trim().min(1),
    importManifestPath: z.string().trim().min(1),
    expectedVaultPageId: z.string().trim().min(1).optional(),
    requireRunToolAi: z.boolean().default(true),
    taxonomyTopics: z.boolean().default(false),
    searchTopicScoped: z.boolean().default(true),
    queryDelayMs: z.number().int().nonnegative().default(1000),
  })
  .strict()
  .superRefine((notion, ctx) => {
    if (notion.taxonomyTopics && notion.searchTopicScoped) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["searchTopicScoped"],
        message: "taxonomyTopics requires searchTopicScoped: false",
      })
    }
  })

export const skillRetrievalSuiteSchema = z
  .object({
    version: z.literal(1),
    runner: z.literal(SKILL_RETRIEVAL_RUNNER),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case"),
    description: z.string().default(""),
    corpus: skillRetrievalCorpusSchema,
    document: skillRetrievalDocumentSchema,
    queries: skillRetrievalQuerySelectionSchema,
    notion: skillRetrievalNotionSchema.optional(),
    lanes: z.array(skillRetrievalLaneSchema).min(1).default(["keyword"]),
    k: z.array(z.number().int().positive()).min(1).default([1, 5, 10]),
    retrieval: z
      .object({
        limit: z.number().int().positive().default(10),
      })
      .strict()
      .default({ limit: 10 }),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const lanes = new Set<SkillRetrievalLane>()
    for (const [index, lane] of suite.lanes.entries()) {
      if (lanes.has(lane)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["lanes", index],
          message: `duplicate skill-retrieval lane "${lane}"`,
        })
      }
      lanes.add(lane)
    }
    const kValues = new Set<number>()
    for (const [index, k] of suite.k.entries()) {
      if (kValues.has(k)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["k", index],
          message: `duplicate k value "${k}"`,
        })
      }
      kValues.add(k)
    }
    if (suite.retrieval.limit < Math.max(...suite.k)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retrieval", "limit"],
        message: "retrieval.limit must be at least the largest requested k value",
      })
    }
    if (suite.lanes.includes("notion-ai") && suite.notion === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["notion"],
        message: "notion config is required when skill-retrieval lanes include notion-ai",
      })
    }
    if (suite.lanes.includes("notion-ai") && suite.retrieval.limit > 25) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retrieval", "limit"],
        message: "notion-ai uses RunTool search, whose current returned-window cap is 25",
      })
    }
  })

const skillretSkillSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    description: z.string().default(""),
    skill_md: z.string().default(""),
    body: z.string().default(""),
    major: z.string().optional(),
    sub: z.string().optional(),
  })
  .passthrough()

const skillretQuerySchema = z
  .object({
    id: z.string().min(1),
    query: z.string().min(1),
    skill_ids: z.array(z.string().min(1)).default([]),
    skill_names: z.array(z.string()).default([]),
    k: z.number().int().positive().optional(),
  })
  .passthrough()

const skillretQrelSchema = z
  .object({
    query_id: z.string().min(1),
    skill_id: z.string().min(1),
    relevance: z.number().int().default(1),
  })
  .strict()

export type SkillRetrievalSuite = z.infer<typeof skillRetrievalSuiteSchema>
export type SkillRetSkill = z.infer<typeof skillretSkillSchema>
export type SkillRetQuery = z.infer<typeof skillretQuerySchema>
export type SkillRetQrel = z.infer<typeof skillretQrelSchema>
export type SkillRetrievalNotionConfig = z.infer<typeof skillRetrievalNotionSchema>

export interface LoadedSkillRetrievalSuite {
  suite: SkillRetrievalSuite
  path: string
  root: string
}

export interface SkillRetrievalCorpus {
  skills: SkillRetSkill[]
  queries: SkillRetQuery[]
  qrels: SkillRetQrel[]
  paths: {
    skills: string
    queries: string
    qrels: string
  }
}

export interface SkillRetrievalResult {
  queryId: string
  query: string
  lane: SkillRetrievalLane
  expectedSkillIds: string[]
  returnedSkillIds: string[]
  returnedSkillNames: string[]
  returnedMemoryIds?: string[]
  capped?: boolean
  explain?: SearchExplain[]
  mechanism?: SkillRetrievalMechanism
  metrics: RankingMetrics & {
    estimatedContextTokens: number
    elapsedMs: number
  }
}

export interface SkillRetrievalTransportTrace {
  toolsRunSearchCalls: number
  toolsRunOtherCalls: number
  clientSearchCalls: number
  dataSourceQueryCalls: number
  pagesRetrieveCalls: number
}

export interface SkillRetrievalMechanism {
  passed: boolean
  failures: string[]
  trace: SkillRetrievalTransportTrace
}

export interface SkillRetrievalLaneSummary {
  queries: number
  recallAt: Record<string, number>
  precisionAt: Record<string, number>
  completenessAt: Record<string, number>
  ndcgAt: Record<string, number>
  mrrAt: Record<string, number>
  mapAt: Record<string, number>
  estimatedContextTokens: number
  elapsedMs: number
  cappedResults: number
  mechanismFailures: number
}

export interface SkillRetrievalRunSummary {
  skills: number
  queries: number
  qrels: number
  totalResults: number
  lanes: Record<SkillRetrievalLane, SkillRetrievalLaneSummary | null>
}

export interface SkillRetrievalArtifact {
  suite: string
  description: string
  startedAt: string
  runner: {
    mode: typeof SKILL_RETRIEVAL_RUNNER
    corpusKind: "skillret"
    lanes: SkillRetrievalLane[]
    k: number[]
    limit: number
  }
  corpus: {
    skillsPath: string
    queriesPath: string
    qrelsPath: string
    skills: number
    queries: number
    qrels: number
  }
  results: SkillRetrievalResult[]
  summary: SkillRetrievalRunSummary
}

export interface SkillRetrievalLaneRunnerInput {
  suite: SkillRetrievalSuite
  corpus: SkillRetrievalCorpus
  queries: SkillRetQuery[]
  lane: SkillRetrievalLane
  services?: LoreServices
  loadedSuiteRoot: string
  notionSearch?: SkillRetrievalNotionSearch
}

export type SkillRetrievalLaneRunner = (
  input: SkillRetrievalLaneRunnerInput
) => Promise<SkillRetrievalResult[]>

export interface RunSkillRetrievalOptions {
  outPath?: string
  now?: Date
  laneRunner?: SkillRetrievalLaneRunner
  servicesFactory?: () => Promise<LoreServices>
  notionSearch?: SkillRetrievalNotionSearch
}

export interface SkillRetrievalNotionSearchInput {
  services: LoreServices
  query: SkillRetQuery
  projectId: string
  topicId?: string
  limit: number
  requireRunToolAi: boolean
}

export interface SkillRetrievalNotionSearchOutput {
  memories: Memory[]
  explain: SearchExplain[]
  capped: boolean
  mechanism: SkillRetrievalMechanism
  elapsedMs: number
}

export type SkillRetrievalNotionSearch = (
  input: SkillRetrievalNotionSearchInput
) => Promise<SkillRetrievalNotionSearchOutput>

const skillRetrievalImportManifestEntrySchema = z
  .object({
    skillId: z.string().min(1),
    memoryId: z.string().min(1),
    name: z.string().min(1),
    contentSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    metadataSha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    topicName: z.string().min(1).optional(),
    topicId: z.string().min(1).optional(),
    topicKey: z.string().min(1).optional(),
    tags: z.array(z.string().min(1)).optional(),
    truncatedFields: z
      .array(
        z
          .object({
            field: z.enum(["description", "skill_md", "body"]),
            originalChars: z.number().int().nonnegative(),
            importedChars: z.number().int().nonnegative(),
          })
          .strict()
      )
      .optional(),
    importedAt: z.string().min(1),
  })
  .strict()

export const skillRetrievalImportManifestSchema = z
  .object({
    version: z.literal(1),
    corpusKind: z.literal("skillret"),
    corpusRevision: z.string().min(1),
    split: z.enum(["train", "test"]),
    documentFields: z.array(z.enum(["name", "description", "skill_md", "body"])).min(1),
    transformVersion: z.union([
      z.literal(1),
      z.literal(2),
      z.literal(SKILL_RETRIEVAL_IMPORT_TRANSFORM_VERSION),
    ]),
    projectName: z.string().min(1),
    projectId: z.string().min(1),
    topicName: z.string().min(1),
    topicId: z.string().min(1),
    importedAt: z.string().min(1),
    skills: z.record(z.string().min(1), skillRetrievalImportManifestEntrySchema),
  })
  .strict()

export type SkillRetrievalImportManifest = z.infer<
  typeof skillRetrievalImportManifestSchema
>

export interface ImportSkillRetrievalOptions {
  outPath?: string
  now?: Date
  limit?: number
  parallelism?: number
  createProject?: boolean
  servicesFactory?: () => Promise<LoreServices>
}

export interface SkillRetrievalImportReport {
  manifest: SkillRetrievalImportManifest
  outPath: string
  imported: number
  updated: number
  skipped: number
  reconciled: number
  selected: number
}

interface SkillRetrievalImportDraft {
  title: string
  content: string
  contentSha256: string
  sourceSha256: string
  metadataSha256: string
  promotionSourceKey: string
  topicName: string
  topicId: string
  topicKey: string
  tags: string[]
  truncatedFields: SkillRetrievalTruncatedField[]
  keywords: string
  synopsis: string
}

interface SkillRetrievalTruncatedField {
  field: "description" | "skill_md" | "body"
  originalChars: number
  importedChars: number
}

type SkillRetrievalImportOutcome = "imported" | "updated" | "skipped" | "reconciled"

interface KeywordDocument {
  skill: SkillRetSkill
  text: string
  termCounts: Map<string, number>
  uniqueTerms: Set<string>
  length: number
}

export async function loadSkillRetrievalSuite(
  path: string
): Promise<LoadedSkillRetrievalSuite> {
  const absolute = resolve(path)
  const raw = await readFile(absolute, "utf-8")
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse YAML in ${absolute}: ${message}`, { cause: err })
  }
  return {
    suite: skillRetrievalSuiteSchema.parse(parsed),
    path: absolute,
    root: dirname(absolute),
  }
}

export async function loadSkillRetrievalCorpus(
  loaded: LoadedSkillRetrievalSuite
): Promise<SkillRetrievalCorpus> {
  const paths = resolveSkillRetrievalCorpusPaths(loaded)
  const [skills, queries, qrels] = await Promise.all([
    readJsonl(paths.skills, skillretSkillSchema, "SkillRet skill"),
    readJsonl(paths.queries, skillretQuerySchema, "SkillRet query"),
    readJsonl(paths.qrels, skillretQrelSchema, "SkillRet qrel"),
  ])
  validateSkillRetrievalCorpus({ skills, queries, qrels })
  return {
    skills,
    queries,
    qrels,
    paths,
  }
}

export async function runSkillRetrievalSuite(
  suitePath: string,
  options: RunSkillRetrievalOptions = {}
): Promise<{ artifact: SkillRetrievalArtifact; outPath: string }> {
  const loaded = await loadSkillRetrievalSuite(suitePath)
  const now = options.now ?? new Date()
  const startedAt = now.toISOString()
  const corpus = await loadSkillRetrievalCorpus(loaded)
  const queries = selectSkillRetrievalQueries(corpus.queries, loaded.suite.queries)
  const laneRunner = options.laneRunner ?? runSkillRetrievalLane
  const needsServices = loaded.suite.lanes.includes("notion-ai")
  const services = needsServices
    ? await (options.servicesFactory ?? (() => initServices()))()
    : undefined
  const results: SkillRetrievalResult[] = []

  for (const lane of loaded.suite.lanes) {
    results.push(
      ...(await laneRunner({
        suite: loaded.suite,
        corpus,
        queries,
        lane,
        services,
        loadedSuiteRoot: loaded.root,
        notionSearch: options.notionSearch,
      }))
    )
  }

  const artifact: SkillRetrievalArtifact = {
    suite: loaded.suite.name,
    description: loaded.suite.description,
    startedAt,
    runner: {
      mode: SKILL_RETRIEVAL_RUNNER,
      corpusKind: loaded.suite.corpus.kind,
      lanes: [...loaded.suite.lanes],
      k: [...loaded.suite.k].sort((a, b) => a - b),
      limit: loaded.suite.retrieval.limit,
    },
    corpus: {
      skillsPath: corpus.paths.skills,
      queriesPath: corpus.paths.queries,
      qrelsPath: corpus.paths.qrels,
      skills: corpus.skills.length,
      queries: queries.length,
      qrels: corpus.qrels.length,
    },
    results,
    summary: summarizeSkillRetrieval(loaded.suite, corpus, queries, results),
  }

  const outPath = resolve(
    options.outPath ?? (await defaultSkillRetrievalArtifactPath(loaded, startedAt))
  )
  await mkdir(dirname(outPath), { recursive: true })
  await writeFile(outPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf-8")
  return { artifact, outPath }
}

export async function importSkillRetrievalCorpusToNotion(
  suitePath: string,
  options: ImportSkillRetrievalOptions = {}
): Promise<SkillRetrievalImportReport> {
  const loaded = await loadSkillRetrievalSuite(suitePath)
  const notion = requireSkillRetrievalNotionConfig(loaded.suite)
  const now = options.now ?? new Date()
  const importedAt = now.toISOString()
  const corpus = await loadSkillRetrievalCorpus(loaded)
  const selectedSkills =
    options.limit === undefined ? corpus.skills : corpus.skills.slice(0, options.limit)
  const parallelism = Math.max(1, options.parallelism ?? 6)
  const services = await (options.servicesFactory ?? (() => initServices()))()
  assertSkillRetrievalVaultBinding(notion, services)
  const corpusRevision = await readSkillRetPinnedRevision(loaded.root)
  let project = await services.projects.findByName(notion.projectName)
  if (!project) {
    if (options.createProject !== true) {
      throw new Error(
        `SkillRet import project "${notion.projectName}" was not found. ` +
          "Create it first or pass --create-project."
      )
    }
    project = await services.projects.create({
      name: notion.projectName,
      type: "project",
      description: "Persistent SkillRet corpus import for Lore retrieval evals.",
    })
  }
  const topic = await services.topics.getOrCreate(notion.topicName, [project.id], {
    forceNew: false,
  })
  const topicPromises = new Map<string, Promise<Topic>>()
  const resolveSkillTopic = (skill: SkillRetSkill): Promise<Topic> => {
    const topicName = notion.taxonomyTopics
      ? skillRetTaxonomyTopicName(notion.topicName, skill)
      : notion.topicName
    const existing = topicPromises.get(topicName)
    if (existing) return existing
    const promise =
      topicName === notion.topicName
        ? Promise.resolve(topic)
        : services.topics.getOrCreate(topicName, [project.id], { forceNew: false })
    topicPromises.set(topicName, promise)
    return promise
  }
  const outPath = resolve(
    options.outPath ?? resolve(loaded.root, notion.importManifestPath)
  )
  const manifest = await readSkillRetrievalImportManifestIfPresent(outPath, {
    corpusRevision,
    split: loaded.suite.corpus.split,
    documentFields: loaded.suite.document.textFields,
    projectName: notion.projectName,
    projectId: project.id,
    topicName: notion.topicName,
    topicId: topic.id,
    importedAt,
  })
  assertSkillRetrievalManifestMatchesSuite(
    manifest,
    loaded.suite,
    notion,
    corpusRevision,
    project.id,
    topic.id
  )
  if (
    manifest.transformVersion !== SKILL_RETRIEVAL_IMPORT_TRANSFORM_VERSION &&
    selectedSkills.length !== corpus.skills.length
  ) {
    throw new Error(
      `SkillRet import manifest uses transformVersion ${manifest.transformVersion}; ` +
        "repairing a legacy transform requires importing the full selected corpus without --limit."
    )
  }
  const startingTransformVersion = manifest.transformVersion

  let manifestWrite = Promise.resolve()
  const queueManifestWrite = () => {
    const snapshot = `${JSON.stringify(manifest, null, 2)}\n`
    manifestWrite = manifestWrite.then(async () => {
      await mkdir(dirname(outPath), { recursive: true })
      await writeFile(outPath, snapshot, "utf-8")
    })
    return manifestWrite
  }
  const limit = pLimit(parallelism)
  const settled = await Promise.allSettled(
    selectedSkills.map((skill) =>
      limit(async (): Promise<SkillRetrievalImportOutcome> => {
        const skillTopic = await resolveSkillTopic(skill)
        const outcome = await importSkillRetrievalMemoryWithRetry({
          skill,
          fields: loaded.suite.document.textFields,
          services,
          projectId: project.id,
          topic: skillTopic,
          importedAt,
          manifest,
        })
        if (outcome !== "skipped") {
          await queueManifestWrite()
        }
        return outcome
      })
    )
  )
  await manifestWrite
  const outcomes: SkillRetrievalImportOutcome[] = []
  const failures: string[] = []
  for (const result of settled) {
    if (result.status === "fulfilled") {
      outcomes.push(result.value)
    } else {
      failures.push(errorMessage(result.reason))
    }
  }
  if (failures.length > 0) {
    const firstFailures = Array.from(new Set(failures)).slice(0, 3)
    throw new Error(
      `SkillRet import failed after draining in-flight writes: ` +
        `${failures.length} failed, ${outcomes.length} completed. ` +
        `First failure(s): ${firstFailures.join(" | ")}`
    )
  }
  if (startingTransformVersion !== SKILL_RETRIEVAL_IMPORT_TRANSFORM_VERSION) {
    manifest.transformVersion = SKILL_RETRIEVAL_IMPORT_TRANSFORM_VERSION
    await queueManifestWrite()
    await manifestWrite
  }

  return {
    manifest,
    outPath,
    imported: outcomes.filter((outcome) => outcome === "imported").length,
    updated: outcomes.filter((outcome) => outcome === "updated").length,
    skipped: outcomes.filter((outcome) => outcome === "skipped").length,
    reconciled: outcomes.filter((outcome) => outcome === "reconciled").length,
    selected: selectedSkills.length,
  }
}

async function importSkillRetrievalMemoryWithRetry(input: {
  skill: SkillRetSkill
  fields: SkillRetrievalSuite["document"]["textFields"]
  services: LoreServices
  projectId: string
  topic: Topic
  importedAt: string
  manifest: SkillRetrievalImportManifest
}): Promise<SkillRetrievalImportOutcome> {
  for (let attempt = 1; attempt <= SKILL_RETRIEVAL_IMPORT_ATTEMPTS; attempt += 1) {
    try {
      return await importSkillRetrievalMemory(input)
    } catch (err) {
      if (isNonRetryableSkillRetrievalImportError(err)) throw err
      if (attempt === SKILL_RETRIEVAL_IMPORT_ATTEMPTS) throw err
      await sleep(1000 * 2 ** (attempt - 1))
    }
  }
  throw new Error("unreachable SkillRet import retry state")
}

function isNonRetryableSkillRetrievalImportError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return (
    message.includes("different source hash") ||
    message.includes("already held by memory")
  )
}

async function importSkillRetrievalMemory(input: {
  skill: SkillRetSkill
  fields: SkillRetrievalSuite["document"]["textFields"]
  services: LoreServices
  projectId: string
  topic: Topic
  importedAt: string
  manifest: SkillRetrievalImportManifest
}): Promise<SkillRetrievalImportOutcome> {
  const { skill, fields, services, projectId, topic, importedAt, manifest } = input
  const draft = buildSkillRetrievalImportDraft({
    skill,
    fields,
    revision: manifest.corpusRevision,
    split: manifest.split,
    topic,
  })
  const existing = manifest.skills[skill.id]
  if (existing) {
    if (existing.sourceSha256 !== draft.sourceSha256) {
      throw new Error(
        `SkillRet skill "${skill.id}" already exists in the import manifest with a different source hash. ` +
          "Archive or repair the existing import before re-importing this corpus revision."
      )
    }
    const entryMatches = skillRetrievalManifestEntryMatchesDraft(existing, draft)
    const liveMemory = await services.memories.findByPromotionSourceKey(
      draft.promotionSourceKey
    )
    if (
      entryMatches &&
      manifest.transformVersion === SKILL_RETRIEVAL_IMPORT_TRANSFORM_VERSION &&
      liveMemory?.id === existing.memoryId
    ) {
      return "skipped"
    }
    if (!liveMemory) {
      const memory = await createSkillRetrievalMemory({
        services,
        projectId,
        draft,
      })
      manifest.skills[skill.id] = skillRetrievalManifestEntry({
        skill,
        draft,
        memoryId: memory.id,
        importedAt,
      })
      return "imported"
    }
    if (liveMemory.id !== existing.memoryId || !entryMatches) {
      await updateSkillRetrievalMemory({
        memoryId: liveMemory.id,
        services,
        projectId,
        draft,
      })
      manifest.skills[skill.id] = skillRetrievalManifestEntry({
        skill,
        draft,
        memoryId: liveMemory.id,
        importedAt,
      })
      return liveMemory.id === existing.memoryId ? "updated" : "reconciled"
    }
    return "skipped"
  }
  const existingMemory = await services.memories.findByPromotionSourceKey(
    draft.promotionSourceKey
  )
  if (existingMemory) {
    await updateSkillRetrievalMemory({
      memoryId: existingMemory.id,
      services,
      projectId,
      draft,
    })
    manifest.skills[skill.id] = skillRetrievalManifestEntry({
      skill,
      draft,
      memoryId: existingMemory.id,
      importedAt,
    })
    return "reconciled"
  }
  const memory = await createSkillRetrievalMemory({
    services,
    projectId,
    draft,
  })
  manifest.skills[skill.id] = skillRetrievalManifestEntry({
    skill,
    draft,
    memoryId: memory.id,
    importedAt,
  })
  return "imported"
}

async function createSkillRetrievalMemory(input: {
  services: LoreServices
  projectId: string
  draft: SkillRetrievalImportDraft
}): Promise<Memory> {
  const { services, projectId, draft } = input
  await assertSkillRetrievalTopicKeyAvailable({
    services,
    projectId,
    topicKey: draft.topicKey,
  })
  return await services.memories.create({
    title: draft.title,
    content: draft.content,
    projectIds: [projectId],
    topicId: draft.topicId,
    topicKey: draft.topicKey,
    source: "manual",
    kind: "procedure",
    status: "informational",
    tags: draft.tags,
    keywords: draft.keywords,
    synopsis: draft.synopsis,
    promotionSourceKey: draft.promotionSourceKey,
  })
}

function buildSkillRetrievalImportDraft(input: {
  skill: SkillRetSkill
  fields: SkillRetrievalSuite["document"]["textFields"]
  revision: string
  split: SkillRetrievalSuite["corpus"]["split"]
  topic: Topic
}): SkillRetrievalImportDraft {
  const { skill, fields, revision, split, topic } = input
  const topicKey = skillRetTopicKey(skill, revision, split)
  const tags = buildSkillRetTags(skill, split)
  const content = renderSkillRetMemoryContent(skill, fields, {
    topicName: topic.name,
    topicKey,
    tags,
  })
  const keywords = buildSkillRetKeywords(skill, revision, topicKey, tags)
  const synopsis = truncateSynopsis(skill.description || skill.body || skill.skill_md)
  const truncatedFields = buildSkillRetTruncatedFields(skill, fields)
  return {
    title: skill.name,
    content,
    contentSha256: stableHash(content),
    sourceSha256: stableHash(JSON.stringify(skill)),
    metadataSha256: stableHash(
      JSON.stringify({
        title: skill.name,
        topicName: topic.name,
        topicId: topic.id,
        topicKey,
        tags,
        ...(truncatedFields.length > 0 ? { truncatedFields } : {}),
        keywords,
        synopsis,
      })
    ),
    promotionSourceKey: skillRetPromotionSourceKey(revision, skill.id),
    topicName: topic.name,
    topicId: topic.id,
    topicKey,
    tags,
    truncatedFields,
    keywords,
    synopsis,
  }
}

function skillRetrievalManifestEntry(input: {
  skill: SkillRetSkill
  draft: SkillRetrievalImportDraft
  memoryId: string
  importedAt: string
}): SkillRetrievalImportManifest["skills"][string] {
  const { skill, draft, memoryId, importedAt } = input
  return {
    skillId: skill.id,
    memoryId,
    name: skill.name,
    contentSha256: draft.contentSha256,
    sourceSha256: draft.sourceSha256,
    metadataSha256: draft.metadataSha256,
    topicName: draft.topicName,
    topicId: draft.topicId,
    topicKey: draft.topicKey,
    tags: draft.tags,
    ...(draft.truncatedFields.length > 0
      ? { truncatedFields: draft.truncatedFields }
      : {}),
    importedAt,
  }
}

function skillRetrievalManifestEntryMatchesDraft(
  entry: SkillRetrievalImportManifest["skills"][string],
  draft: SkillRetrievalImportDraft
): boolean {
  return (
    entry.contentSha256 === draft.contentSha256 &&
    entry.metadataSha256 === draft.metadataSha256 &&
    entry.topicName === draft.topicName &&
    entry.topicId === draft.topicId &&
    entry.topicKey === draft.topicKey &&
    arraysEqual(entry.tags ?? [], draft.tags) &&
    truncatedFieldsEqual(entry.truncatedFields ?? [], draft.truncatedFields)
  )
}

async function updateSkillRetrievalMemory(input: {
  memoryId: string
  services: LoreServices
  projectId: string
  draft: SkillRetrievalImportDraft
}): Promise<void> {
  const { memoryId, services, projectId, draft } = input
  await assertSkillRetrievalTopicKeyAvailable({
    services,
    projectId,
    topicKey: draft.topicKey,
    memoryId,
  })
  await services.memories.update(memoryId, {
    title: draft.title,
    content: draft.content,
    projectIds: [projectId],
    topicId: draft.topicId,
    topicKey: draft.topicKey,
    kind: "procedure",
    status: "informational",
    tags: draft.tags,
    keywords: draft.keywords,
    synopsis: draft.synopsis,
  })
}

async function assertSkillRetrievalTopicKeyAvailable(input: {
  services: LoreServices
  projectId: string
  topicKey: string
  memoryId?: string
}): Promise<void> {
  const { services, projectId, topicKey, memoryId } = input
  const collision = await services.memories.findByTopicKey({
    topicKey,
    projectIds: [projectId],
  })
  if (!collision || collision.id === memoryId) return
  if (memoryId) {
    throw new Error(
      `SkillRet topicKey "${topicKey}" is already held by memory ${collision.id}; ` +
        `cannot assign it to memory ${memoryId}.`
    )
  }
  throw new Error(
    `SkillRet topicKey "${topicKey}" is already held by memory ${collision.id}; ` +
      "cannot create a duplicate SkillRet memory."
  )
}

export async function runSkillRetrievalLane(
  input: SkillRetrievalLaneRunnerInput
): Promise<SkillRetrievalResult[]> {
  if (input.lane === "keyword") return runKeywordSkillRetrievalLane(input)
  if (input.lane === "notion-ai") return runNotionSkillRetrievalLane(input)
  throw new Error(`Unsupported skill-retrieval lane "${input.lane}"`)
}

export async function runKeywordSkillRetrievalLane(
  input: SkillRetrievalLaneRunnerInput
): Promise<SkillRetrievalResult[]> {
  if (input.lane !== "keyword") {
    throw new Error(`Unsupported skill-retrieval lane "${input.lane}"`)
  }
  const documents = input.corpus.skills.map((skill) =>
    buildKeywordDocument(skill, input.suite.document.textFields)
  )
  const idf = buildInverseDocumentFrequency(documents)
  const qrelsByQuery = groupQrelsByQuery(input.corpus.qrels)
  const results: SkillRetrievalResult[] = []

  for (const query of input.queries) {
    const before = performance.now()
    const returned = rankKeywordDocuments({
      query: query.query,
      documents,
      idf,
      limit: input.suite.retrieval.limit,
    })
    const elapsedMs = roundMs(performance.now() - before)
    const relevant = (qrelsByQuery.get(query.id) ?? []).map((qrel) => ({
      id: qrel.skill_id,
      relevance: qrel.relevance,
    }))
    const metrics = scoreRanking({
      returnedIds: returned.map((doc) => doc.skill.id),
      relevant,
      kValues: input.suite.k,
    })
    results.push({
      queryId: query.id,
      query: query.query,
      lane: input.lane,
      expectedSkillIds: relevant.map((label) => label.id),
      returnedSkillIds: returned.map((doc) => doc.skill.id),
      returnedSkillNames: returned.map((doc) => doc.skill.name),
      metrics: {
        ...metrics,
        estimatedContextTokens: estimateContextTokens(returned.map((doc) => doc.text)),
        elapsedMs,
      },
    })
  }

  return results
}

export async function runNotionSkillRetrievalLane(
  input: SkillRetrievalLaneRunnerInput
): Promise<SkillRetrievalResult[]> {
  if (input.lane !== "notion-ai") {
    throw new Error(`Unsupported skill-retrieval lane "${input.lane}"`)
  }
  if (!input.services) {
    throw new Error("skill-retrieval notion-ai lane requires initialized Lore services")
  }
  const notion = requireSkillRetrievalNotionConfig(input.suite)
  assertSkillRetrievalVaultBinding(notion, input.services)
  const manifestPath = resolve(input.loadedSuiteRoot, notion.importManifestPath)
  const manifest = await readSkillRetrievalImportManifest(manifestPath)
  const corpusRevision = await readSkillRetPinnedRevision(input.loadedSuiteRoot)
  assertSkillRetrievalManifestMatchesSuite(
    manifest,
    input.suite,
    notion,
    corpusRevision,
    manifest.projectId,
    manifest.topicId,
    { requireCurrentTransform: true }
  )
  const qrelsByQuery = groupQrelsByQuery(input.corpus.qrels)
  assertSkillRetrievalManifestCoversQueries({
    manifest,
    queries: input.queries,
    qrelsByQuery,
  })
  const skillNamesById = new Map(
    input.corpus.skills.map((skill) => [skill.id, skill.name])
  )
  const memoryIdToSkillId = new Map(
    Object.values(manifest.skills).map((entry) => [entry.memoryId, entry.skillId])
  )
  const search = input.notionSearch ?? defaultSkillRetrievalNotionSearch
  const results: SkillRetrievalResult[] = []

  for (const [index, query] of input.queries.entries()) {
    const out = await runSkillRetrievalNotionSearchWithRetry(search, {
      services: input.services,
      query,
      projectId: manifest.projectId,
      topicId: notion.searchTopicScoped ? manifest.topicId : undefined,
      limit: input.suite.retrieval.limit,
      requireRunToolAi: notion.requireRunToolAi,
    })
    const returnedSkillIds = out.memories.map((memory) => {
      return memoryIdToSkillId.get(memory.id) ?? `unknown:${memory.id}`
    })
    const returnedSkillNames = returnedSkillIds.map((skillId, index) => {
      return skillNamesById.get(skillId) ?? out.memories[index]?.title ?? skillId
    })
    const relevant = (qrelsByQuery.get(query.id) ?? []).map((qrel) => ({
      id: qrel.skill_id,
      relevance: qrel.relevance,
    }))
    const metrics = scoreRanking({
      returnedIds: returnedSkillIds,
      relevant,
      kValues: input.suite.k,
    })
    results.push({
      queryId: query.id,
      query: query.query,
      lane: input.lane,
      expectedSkillIds: relevant.map((label) => label.id),
      returnedSkillIds,
      returnedSkillNames,
      returnedMemoryIds: out.memories.map((memory) => memory.id),
      capped: out.capped,
      explain: out.explain,
      mechanism: out.mechanism,
      metrics: {
        ...metrics,
        estimatedContextTokens: estimateContextTokens(
          out.memories.map((memory) =>
            [memory.title, memory.synopsis].filter(Boolean).join("\n")
          )
        ),
        elapsedMs: out.elapsedMs,
      },
    })
    if (notion.queryDelayMs > 0 && index < input.queries.length - 1) {
      await sleep(notion.queryDelayMs)
    }
  }

  return results
}

async function runSkillRetrievalNotionSearchWithRetry(
  search: SkillRetrievalNotionSearch,
  input: SkillRetrievalNotionSearchInput
): Promise<SkillRetrievalNotionSearchOutput> {
  for (let attempt = 1; attempt <= SKILL_RETRIEVAL_NOTION_SEARCH_ATTEMPTS; attempt += 1) {
    try {
      return await search(input)
    } catch (err) {
      if (
        attempt === SKILL_RETRIEVAL_NOTION_SEARCH_ATTEMPTS ||
        !isRetryableSkillRetrievalNotionSearchError(err)
      ) {
        throw err
      }
      await sleep(
        Math.min(60_000, SKILL_RETRIEVAL_NOTION_SEARCH_RETRY_BASE_MS * 2 ** (attempt - 1))
      )
    }
  }
  throw new Error("unreachable SkillRet notion-ai search retry state")
}

function isRetryableSkillRetrievalNotionSearchError(err: unknown): boolean {
  const message = errorMessage(err).toLowerCase()
  return (
    message.includes("rate_limited") ||
    message.includes("rate limited") ||
    message.includes("status: 429") ||
    message.includes("status: 500") ||
    message.includes("status: 502") ||
    message.includes("status: 503") ||
    message.includes("status: 504") ||
    message.includes("timed out") ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("socket hang up")
  )
}

export function summarizeSkillRetrieval(
  suite: SkillRetrievalSuite,
  corpus: SkillRetrievalCorpus,
  queries: SkillRetQuery[],
  results: SkillRetrievalResult[]
): SkillRetrievalRunSummary {
  const laneSummaries = Object.fromEntries(
    SKILL_RETRIEVAL_LANES.map((lane) => {
      if (!suite.lanes.includes(lane)) return [lane, null]
      const rows = results.filter((result) => result.lane === lane)
      return [lane, summarizeSkillRetrievalLane(suite.k, rows)]
    })
  ) as Record<SkillRetrievalLane, SkillRetrievalLaneSummary | null>
  return {
    skills: corpus.skills.length,
    queries: queries.length,
    qrels: corpus.qrels.length,
    totalResults: results.length,
    lanes: laneSummaries,
  }
}

function summarizeSkillRetrievalLane(
  kValues: number[],
  results: SkillRetrievalResult[]
): SkillRetrievalLaneSummary {
  const recallAt: Record<string, number> = {}
  const precisionAt: Record<string, number> = {}
  const completenessAt: Record<string, number> = {}
  const ndcgAt: Record<string, number> = {}
  const mrrAt: Record<string, number> = {}
  const mapAt: Record<string, number> = {}
  for (const k of kValues) {
    const key = String(k)
    recallAt[key] = averageMetric(
      results.map((result) => result.metrics.recallAt[key] ?? 0)
    )
    precisionAt[key] = averageMetric(
      results.map((result) => result.metrics.precisionAt[key] ?? 0)
    )
    completenessAt[key] = averageMetric(
      results.map((result) => result.metrics.completenessAt[key] ?? 0)
    )
    ndcgAt[key] = averageMetric(results.map((result) => result.metrics.ndcgAt[key] ?? 0))
    mrrAt[key] = averageMetric(results.map((result) => result.metrics.mrrAt[key] ?? 0))
    mapAt[key] = averageMetric(
      results.map((result) => result.metrics.averagePrecisionAt[key] ?? 0)
    )
  }
  return {
    queries: results.length,
    recallAt,
    precisionAt,
    completenessAt,
    ndcgAt,
    mrrAt,
    mapAt,
    estimatedContextTokens: averageMetric(
      results.map((result) => result.metrics.estimatedContextTokens)
    ),
    elapsedMs: averageMetric(results.map((result) => result.metrics.elapsedMs)),
    cappedResults: results.filter((result) => result.capped === true).length,
    mechanismFailures: results.filter(
      (result) => result.mechanism && !result.mechanism.passed
    ).length,
  }
}

async function defaultSkillRetrievalNotionSearch(
  input: SkillRetrievalNotionSearchInput
): Promise<SkillRetrievalNotionSearchOutput> {
  const trace = createSkillRetrievalTransportTrace()
  const client = createSkillRetrievalTracingClient(input.services.client, trace)
  const features = featuresForSkillRetrievalNotionAi(input.services.features)
  const memories = new MemoryService(
    client,
    input.services.context.vault.databases.memories,
    input.services.scopeContext,
    { features }
  )
  const before = performance.now()
  const searchInput: Parameters<MemoryService["searchWithExplain"]>[0] = {
    query: input.query.query,
    projectId: input.projectId,
    kind: "procedure",
    status: "informational",
    limit: input.limit,
    includeContent: false,
    mode: "semantic",
  }
  if (input.topicId !== undefined) searchInput.topicId = input.topicId
  const out = await memories.searchWithExplain(searchInput)
  const elapsedMs = roundMs(performance.now() - before)
  return {
    memories: out.memories,
    explain: out.explain,
    capped: out.capped,
    mechanism: validateSkillRetrievalNotionMechanism(trace, input.requireRunToolAi),
    elapsedMs,
  }
}

function featuresForSkillRetrievalNotionAi(
  base: LoreFeatureFlags | undefined
): LoreFeatureFlags {
  const features = cloneFeatureFlags(base ?? defaultFeatureFlags())
  features.runTool.enabled = true
  features.runTool.search = true
  return features
}

function cloneFeatureFlags(features: LoreFeatureFlags): LoreFeatureFlags {
  return {
    ...features,
    runTool: { ...features.runTool },
  }
}

function createSkillRetrievalTransportTrace(): SkillRetrievalTransportTrace {
  return {
    toolsRunSearchCalls: 0,
    toolsRunOtherCalls: 0,
    clientSearchCalls: 0,
    dataSourceQueryCalls: 0,
    pagesRetrieveCalls: 0,
  }
}

function validateSkillRetrievalNotionMechanism(
  trace: SkillRetrievalTransportTrace,
  requireRunToolAi: boolean
): SkillRetrievalMechanism {
  const failures: string[] = []
  if (requireRunToolAi) {
    if (trace.toolsRunSearchCalls === 0) {
      failures.push("expected RunTool AI search to dispatch through tools/run")
    }
    if (trace.clientSearchCalls !== 0) {
      failures.push("expected no REST client.search fallback")
    }
  }
  return {
    passed: failures.length === 0,
    failures,
    trace: { ...trace },
  }
}

function createSkillRetrievalTracingClient(
  client: Client,
  trace: SkillRetrievalTransportTrace
): Client {
  return new Proxy(client as Client & Record<PropertyKey, unknown>, {
    get(target, prop, receiver) {
      if (prop === "request") {
        const request = Reflect.get(target, prop, receiver)
        if (typeof request !== "function") return request
        return (args: Record<string, unknown>) => {
          if (args["path"] === "tools/run") {
            const body = args["body"] as { type?: unknown } | undefined
            if (body?.type === "search") {
              trace.toolsRunSearchCalls += 1
            } else {
              trace.toolsRunOtherCalls += 1
            }
          }
          return Reflect.apply(request, target, [args])
        }
      }
      if (prop === "search") {
        const search = Reflect.get(target, prop, receiver)
        if (typeof search !== "function") return search
        return (...args: unknown[]) => {
          trace.clientSearchCalls += 1
          return Reflect.apply(search, target, args)
        }
      }
      if (prop === "dataSources") {
        const dataSources = Reflect.get(target, prop, receiver)
        return wrapNestedClientObject(dataSources, {
          query: () => {
            trace.dataSourceQueryCalls += 1
          },
        })
      }
      if (prop === "pages") {
        const pages = Reflect.get(target, prop, receiver)
        return wrapNestedClientObject(pages, {
          retrieve: () => {
            trace.pagesRetrieveCalls += 1
          },
        })
      }
      return Reflect.get(target, prop, receiver)
    },
  }) as Client
}

function wrapNestedClientObject(
  value: unknown,
  beforeCall: Record<string, () => void>
): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value
  }
  return new Proxy(value as Record<PropertyKey, unknown>, {
    get(target, prop, receiver) {
      const member = Reflect.get(target, prop, receiver)
      if (typeof prop !== "string" || typeof member !== "function") return member
      const before = beforeCall[prop]
      if (!before) return member
      return (...args: unknown[]) => {
        before()
        return Reflect.apply(member, target, args)
      }
    },
  })
}

function requireSkillRetrievalNotionConfig(
  suite: SkillRetrievalSuite
): SkillRetrievalNotionConfig {
  if (!suite.notion) {
    throw new Error("skill-retrieval notion config is required for this operation")
  }
  return suite.notion
}

function assertSkillRetrievalVaultBinding(
  notion: SkillRetrievalNotionConfig,
  services: LoreServices
): void {
  if (notion.expectedVaultPageId === undefined) return
  const expected = normalizeNotionPageId(notion.expectedVaultPageId)
  const actual = normalizeNotionPageId(services.config.vault.pageId)
  if (expected !== actual) {
    throw new Error(
      `SkillRet suite is bound to vault ${notion.expectedVaultPageId}, ` +
        `but the active Lore config points at ${services.config.vault.pageId}.`
    )
  }
}

function normalizeNotionPageId(value: string): string {
  return value.trim().toLowerCase().replaceAll("-", "")
}

export async function readSkillRetrievalImportManifest(
  path: string
): Promise<SkillRetrievalImportManifest> {
  const raw = await readFile(path, "utf-8")
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Could not parse skill-retrieval import manifest at ${path}: ${message}`,
      {
        cause: err,
      }
    )
  }
  return skillRetrievalImportManifestSchema.parse(parsed)
}

async function readSkillRetrievalImportManifestIfPresent(
  path: string,
  defaults: Omit<
    SkillRetrievalImportManifest,
    "version" | "corpusKind" | "transformVersion" | "skills"
  >
): Promise<SkillRetrievalImportManifest> {
  try {
    await access(path)
  } catch {
    return {
      version: 1,
      corpusKind: "skillret",
      transformVersion: SKILL_RETRIEVAL_IMPORT_TRANSFORM_VERSION,
      skills: {},
      ...defaults,
    }
  }
  return readSkillRetrievalImportManifest(path)
}

function assertSkillRetrievalManifestMatchesSuite(
  manifest: SkillRetrievalImportManifest,
  suite: SkillRetrievalSuite,
  notion: SkillRetrievalNotionConfig,
  corpusRevision: string,
  projectId: string,
  topicId: string,
  options: { requireCurrentTransform?: boolean } = {}
): void {
  const mismatches: string[] = []
  if (
    options.requireCurrentTransform === true &&
    manifest.transformVersion !== SKILL_RETRIEVAL_IMPORT_TRANSFORM_VERSION
  ) {
    mismatches.push(
      `transformVersion ${manifest.transformVersion} != ${SKILL_RETRIEVAL_IMPORT_TRANSFORM_VERSION}`
    )
  }
  if (manifest.corpusRevision !== corpusRevision) {
    mismatches.push(`corpusRevision ${manifest.corpusRevision} != ${corpusRevision}`)
  }
  if (manifest.split !== suite.corpus.split) {
    mismatches.push(`split ${manifest.split} != ${suite.corpus.split}`)
  }
  const manifestFields = manifest.documentFields.join(",")
  const suiteFields = suite.document.textFields.join(",")
  if (manifestFields !== suiteFields) {
    mismatches.push(`documentFields ${manifestFields} != ${suiteFields}`)
  }
  if (manifest.projectName !== notion.projectName) {
    mismatches.push(`projectName ${manifest.projectName} != ${notion.projectName}`)
  }
  if (manifest.projectId !== projectId) {
    mismatches.push(`projectId ${manifest.projectId} != ${projectId}`)
  }
  if (manifest.topicName !== notion.topicName) {
    mismatches.push(`topicName ${manifest.topicName} != ${notion.topicName}`)
  }
  if (manifest.topicId !== topicId) {
    mismatches.push(`topicId ${manifest.topicId} != ${topicId}`)
  }
  if (mismatches.length > 0) {
    throw new Error(
      `SkillRet import manifest does not match the suite configuration: ${mismatches.join(", ")}`
    )
  }
}

function assertSkillRetrievalManifestCoversQueries(input: {
  manifest: SkillRetrievalImportManifest
  queries: SkillRetQuery[]
  qrelsByQuery: Map<string, SkillRetQrel[]>
}): void {
  const importedSkillIds = new Set(
    Object.values(input.manifest.skills).map((entry) => entry.skillId)
  )
  const missing = new Set<string>()
  for (const query of input.queries) {
    for (const qrel of input.qrelsByQuery.get(query.id) ?? []) {
      if (!importedSkillIds.has(qrel.skill_id)) missing.add(qrel.skill_id)
    }
  }
  if (missing.size === 0) return
  const sample = Array.from(missing).sort().slice(0, 10)
  const suffix =
    missing.size > sample.length ? `, ... ${missing.size - sample.length} more` : ""
  throw new Error(
    `SkillRet import manifest is incomplete for the selected queries; ` +
      `missing ${missing.size} required skill(s): ${sample.join(", ")}${suffix}. ` +
      "Re-run the SkillRet Notion import before measuring the notion-ai lane."
  )
}

async function readSkillRetPinnedRevision(root: string): Promise<string> {
  const manifestPath = resolve(root, "skillret-checksums.json")
  try {
    const parsed = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      revision?: unknown
    }
    if (typeof parsed.revision === "string" && parsed.revision.trim().length > 0) {
      return parsed.revision.trim()
    }
  } catch {
    // Custom suites can still import; their manifest records an unknown revision.
  }
  return "unknown"
}

function renderSkillRetMemoryContent(
  skill: SkillRetSkill,
  fields: SkillRetrievalSuite["document"]["textFields"],
  metadata?: { topicName: string; topicKey: string; tags: string[] }
): string {
  const sections: string[] = [`# ${skill.name}`, `SkillRet ID: ${skill.id}`]
  if (metadata) {
    sections.push(
      [
        "## Lore Metadata",
        "",
        `Topic: ${metadata.topicName}`,
        `Topic Key: ${metadata.topicKey}`,
        `Tags: ${metadata.tags.join(", ")}`,
      ].join("\n")
    )
  }
  if (fields.includes("description") && skill.description.trim().length > 0) {
    sections.push(renderSkillRetMemorySection("Description", skill.description))
  }
  if (fields.includes("skill_md") && skill.skill_md.trim().length > 0) {
    sections.push(renderSkillRetMemorySection("Skill", skill.skill_md))
  }
  if (fields.includes("body") && skill.body.trim().length > 0) {
    sections.push(renderSkillRetMemorySection("Body", skill.body))
  }
  const taxonomy = [
    skill.major ? `Major: ${skill.major}` : "",
    skill.sub ? `Sub: ${skill.sub}` : "",
  ].filter(Boolean)
  if (taxonomy.length > 0) sections.push(`## Taxonomy\n\n${taxonomy.join("\n")}`)
  return `${sections.join("\n\n")}\n`
}

function renderSkillRetMemorySection(title: string, value: string): string {
  return `## ${title}\n\n${truncateSkillRetMemoryField(value)}`
}

function truncateSkillRetMemoryField(value: string): string {
  const normalized = value.trim()
  if (normalized.length <= SKILL_RETRIEVAL_IMPORT_FIELD_CHAR_LIMIT) {
    return normalized
  }
  const kept = normalized.slice(0, SKILL_RETRIEVAL_IMPORT_FIELD_CHAR_LIMIT).trimEnd()
  return [
    kept,
    "",
    `[Content truncated at ${SKILL_RETRIEVAL_IMPORT_FIELD_CHAR_LIMIT.toLocaleString(
      "en-US"
    )} characters for stable Notion eval import; source length ${normalized.length.toLocaleString(
      "en-US"
    )} characters.]`,
  ].join("\n")
}

function buildSkillRetTruncatedFields(
  skill: SkillRetSkill,
  fields: SkillRetrievalSuite["document"]["textFields"]
): SkillRetrievalTruncatedField[] {
  return fields.flatMap((field) => {
    if (field === "name") return []
    const normalized = skill[field].trim()
    if (normalized.length <= SKILL_RETRIEVAL_IMPORT_FIELD_CHAR_LIMIT) return []
    return [
      {
        field,
        originalChars: normalized.length,
        importedChars: SKILL_RETRIEVAL_IMPORT_FIELD_CHAR_LIMIT,
      },
    ]
  })
}

function buildSkillRetKeywords(
  skill: SkillRetSkill,
  revision: string,
  topicKey: string,
  tags: string[]
): string {
  return [
    "skillret",
    `skillret:${revision}`,
    `skillret:${revision}:${skill.id}`,
    `skillret:${skill.id}`,
    topicKey,
    ...tags,
    skill.major ?? "",
    skill.sub ?? "",
  ]
    .filter((part) => part.trim().length > 0)
    .join(" ")
}

function skillRetPromotionSourceKey(revision: string, skillId: string): string {
  return `skillret:${revision}:${skillId}`
}

function skillRetTopicKey(
  skill: SkillRetSkill,
  revision: string,
  split: SkillRetrievalSuite["corpus"]["split"]
): string {
  return [
    "skillret",
    split,
    slugPart(revision).slice(0, 24),
    slugPart(skill.major ?? "uncategorized"),
    slugPart(skill.sub ?? "general"),
    slugPart(skill.id),
  ].join("/")
}

function skillRetTaxonomyTopicName(baseTopicName: string, skill: SkillRetSkill): string {
  return [
    baseTopicName,
    skill.major?.trim() || "Uncategorized",
    skill.sub?.trim() || "General",
  ].join(" / ")
}

function buildSkillRetTags(
  skill: SkillRetSkill,
  split: SkillRetrievalSuite["corpus"]["split"]
): string[] {
  const major = slugPart(skill.major ?? "uncategorized")
  const sub = slugPart(skill.sub ?? "general")
  return [
    "skillret",
    `skillret-split-${split}`,
    "skillret-kind-procedure",
    truncateTag(`skillret-major-${major}`),
    truncateTag(`skillret-sub-${sub}`),
  ]
}

function slugPart(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
  return slug || "unknown"
}

function truncateTag(value: string): string {
  return value.length <= 100 ? value : value.slice(0, 100)
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function truncatedFieldsEqual(
  left: readonly SkillRetrievalTruncatedField[],
  right: readonly SkillRetrievalTruncatedField[]
): boolean {
  if (left.length !== right.length) return false
  return left.every((value, index) => {
    const other = right[index]
    return (
      other !== undefined &&
      value.field === other.field &&
      value.originalChars === other.originalChars &&
      value.importedChars === other.importedChars
    )
  })
}

function truncateSynopsis(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, " ")
  if (normalized.length <= 150) return normalized
  return normalized.slice(0, 147).trimEnd() + "..."
}

function resolveSkillRetrievalCorpusPaths(
  loaded: LoadedSkillRetrievalSuite
): SkillRetrievalCorpus["paths"] {
  const root = resolve(loaded.root, loaded.suite.corpus.root)
  const split = loaded.suite.corpus.split
  return {
    skills: resolve(
      loaded.root,
      loaded.suite.corpus.skillsPath ?? join(root, "data", "skills", `${split}.jsonl`)
    ),
    queries: resolve(
      loaded.root,
      loaded.suite.corpus.queriesPath ?? join(root, "data", "queries", `${split}.jsonl`)
    ),
    qrels: resolve(
      loaded.root,
      loaded.suite.corpus.qrelsPath ?? join(root, "data", "qrels", `${split}.jsonl`)
    ),
  }
}

async function readJsonl<T>(
  path: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  label: string
): Promise<T[]> {
  const raw = await readFile(path, "utf-8")
  const rows: T[] = []
  for (const [index, line] of raw.split(/\r?\n/u).entries()) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(`${label} JSONL parse failed at ${path}:${index + 1}: ${message}`, {
        cause: err,
      })
    }
    try {
      rows.push(schema.parse(parsed))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new Error(
        `${label} row failed validation at ${path}:${index + 1}: ${message}`,
        {
          cause: err,
        }
      )
    }
  }
  return rows
}

function validateSkillRetrievalCorpus(input: {
  skills: SkillRetSkill[]
  queries: SkillRetQuery[]
  qrels: SkillRetQrel[]
}): void {
  const skillIds = assertUniqueIds(input.skills, "skill")
  const queryIds = assertUniqueIds(input.queries, "query")
  for (const [index, qrel] of input.qrels.entries()) {
    if (!queryIds.has(qrel.query_id)) {
      throw new Error(
        `SkillRet qrel ${index} references unknown query "${qrel.query_id}"`
      )
    }
    if (!skillIds.has(qrel.skill_id)) {
      throw new Error(
        `SkillRet qrel ${index} references unknown skill "${qrel.skill_id}"`
      )
    }
  }
}

function assertUniqueIds(items: Array<{ id: string }>, label: string): Set<string> {
  const ids = new Set<string>()
  for (const [index, item] of items.entries()) {
    if (ids.has(item.id)) {
      throw new Error(`Duplicate SkillRet ${label} id "${item.id}" at index ${index}`)
    }
    ids.add(item.id)
  }
  return ids
}

export function selectSkillRetrievalQueries(
  queries: SkillRetQuery[],
  selection: SkillRetrievalSuite["queries"]
): SkillRetQuery[] {
  let selected = queries
  if (selection.ids) {
    const requested = new Set(selection.ids)
    selected = queries.filter((query) => requested.has(query.id))
    const found = new Set(selected.map((query) => query.id))
    const missing = selection.ids.filter((id) => !found.has(id))
    if (missing.length > 0) {
      throw new Error(
        `Skill-retrieval suite requested unknown query id(s): ${missing.join(", ")}`
      )
    }
  }
  if (selection.seed) {
    selected = [...selected].sort((a, b) => {
      const left = stableHash(`${selection.seed}:${a.id}`)
      const right = stableHash(`${selection.seed}:${b.id}`)
      return left.localeCompare(right) || a.id.localeCompare(b.id)
    })
  }
  if (selection.limit !== undefined) selected = selected.slice(0, selection.limit)
  return selected
}

function buildKeywordDocument(
  skill: SkillRetSkill,
  fields: SkillRetrievalSuite["document"]["textFields"]
): KeywordDocument {
  const text = fields
    .map((field) => skill[field] ?? "")
    .filter((value) => value.length > 0)
    .join("\n\n")
  const tokens = tokenize(text)
  const termCounts = new Map<string, number>()
  for (const token of tokens) {
    termCounts.set(token, (termCounts.get(token) ?? 0) + 1)
  }
  return {
    skill,
    text,
    termCounts,
    uniqueTerms: new Set(tokens),
    length: tokens.length,
  }
}

function buildInverseDocumentFrequency(
  documents: KeywordDocument[]
): Map<string, number> {
  const documentFrequency = new Map<string, number>()
  for (const doc of documents) {
    for (const token of doc.uniqueTerms) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1)
    }
  }
  const idf = new Map<string, number>()
  for (const [token, frequency] of documentFrequency.entries()) {
    idf.set(token, Math.log(1 + documents.length / (1 + frequency)))
  }
  return idf
}

function rankKeywordDocuments(input: {
  query: string
  documents: KeywordDocument[]
  idf: Map<string, number>
  limit: number
}): KeywordDocument[] {
  const queryTokens = Array.from(new Set(tokenize(input.query)))
  const scored = input.documents.map((doc) => {
    let score = 0
    for (const token of queryTokens) {
      const tf = doc.termCounts.get(token) ?? 0
      if (tf === 0) continue
      score += (input.idf.get(token) ?? 0) * (tf / (tf + 1.2))
    }
    return { doc, score }
  })
  return scored
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return a.doc.skill.id.localeCompare(b.doc.skill.id)
    })
    .slice(0, input.limit)
    .map((row) => row.doc)
}

function groupQrelsByQuery(qrels: SkillRetQrel[]): Map<string, SkillRetQrel[]> {
  const grouped = new Map<string, SkillRetQrel[]>()
  for (const qrel of qrels) {
    const existing = grouped.get(qrel.query_id) ?? []
    existing.push(qrel)
    grouped.set(qrel.query_id, existing)
  }
  return grouped
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9]+/gu) ?? []
}

function estimateContextTokens(chunks: string[]): number {
  const chars = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  return Math.ceil(chars / 4)
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}

async function defaultSkillRetrievalArtifactPath(
  loaded: LoadedSkillRetrievalSuite,
  startedAt: string
): Promise<string> {
  const root = await findRepoRoot(loaded.root)
  const safeTimestamp = startedAt.replace(/[:.]/g, "-")
  return resolve(root, "evals", "results", `${loaded.suite.name}-${safeTimestamp}.json`)
}

async function findRepoRoot(start: string): Promise<string> {
  let dir = resolve(start)
  while (true) {
    const packageJsonPath = join(dir, "package.json")
    try {
      const parsed = JSON.parse(await readFile(packageJsonPath, "utf-8")) as {
        name?: unknown
      }
      if (parsed.name === "@makenotion/lore") return dir
    } catch {
      // Keep walking. Missing and unrelated package.json files are both non-roots.
    }
    const parent = dirname(dir)
    if (parent === dir || dir === parse(dir).root) {
      throw new Error(
        `Could not find @makenotion/lore package root from ${start}; pass --out to choose an artifact path.`
      )
    }
    dir = parent
  }
}
