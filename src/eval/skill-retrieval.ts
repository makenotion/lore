import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join, parse, resolve } from "node:path"
import { performance } from "node:perf_hooks"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import { averageMetric, scoreRanking, type RankingMetrics } from "./rank-metrics.js"

export const SKILL_RETRIEVAL_RUNNER = "skill-retrieval" as const

export const SKILL_RETRIEVAL_LANES = ["keyword"] as const

export type SkillRetrievalLane = (typeof SKILL_RETRIEVAL_LANES)[number]

const skillRetrievalLaneSchema = z.enum(SKILL_RETRIEVAL_LANES)

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
    lanes: z
      .array(skillRetrievalLaneSchema)
      .min(1)
      .default([...SKILL_RETRIEVAL_LANES]),
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
  metrics: RankingMetrics & {
    estimatedContextTokens: number
    elapsedMs: number
  }
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
}

export type SkillRetrievalLaneRunner = (
  input: SkillRetrievalLaneRunnerInput
) => Promise<SkillRetrievalResult[]>

export interface RunSkillRetrievalOptions {
  outPath?: string
  now?: Date
  laneRunner?: SkillRetrievalLaneRunner
}

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
  const laneRunner = options.laneRunner ?? runKeywordSkillRetrievalLane
  const results: SkillRetrievalResult[] = []

  for (const lane of loaded.suite.lanes) {
    results.push(
      ...(await laneRunner({
        suite: loaded.suite,
        corpus,
        queries,
        lane,
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
  }
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

function selectSkillRetrievalQueries(
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
