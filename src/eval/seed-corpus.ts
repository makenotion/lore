import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"

const idSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9._/-]*$/u, "must be a stable lowercase id")

const repositorySchema = z
  .object({
    repo: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    sha: z.string().regex(/^[a-f0-9]{40}$/iu),
  })
  .strict()

const seedProjectSchema = z
  .object({
    name: z.string().min(1),
    path: z.string().min(1),
    tags: z.array(z.string().min(1)).default([]),
  })
  .strict()

const seedTopicSchema = z
  .object({
    id: idSchema,
    name: z.string().min(1),
    description: z.string().min(1),
  })
  .strict()

const sourcePullRequestSchema = z
  .object({
    repo: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u),
    number: z.number().int().positive(),
    title: z.string().min(1),
    url: z.string().url(),
  })
  .strict()

const seedMemorySchema = z
  .object({
    id: idSchema,
    title: z.string().min(1),
    topics: z.array(idSchema).min(1),
    status: z.enum(["active", "stale", "proposed"]).default("active"),
    confidence: z.enum(["high", "medium", "low"]).default("high"),
    provenanceKind: z
      .enum(["pr-derived", "generalized", "synthetic"])
      .default("generalized"),
    synopsis: z.string().min(1),
    body: z.string().min(1),
    scenarios: z.array(idSchema).default([]),
    sourcePullRequests: z.array(sourcePullRequestSchema).default([]),
  })
  .strict()

const seedDecisionSchema = z
  .object({
    id: idSchema,
    title: z.string().min(1),
    topics: z.array(idSchema).min(1),
    status: z.enum(["accepted", "superseded", "proposed"]).default("accepted"),
    provenanceKind: z
      .enum(["pr-derived", "generalized", "synthetic"])
      .default("generalized"),
    body: z.string().min(1),
    scenarios: z.array(idSchema).default([]),
    sourcePullRequests: z.array(sourcePullRequestSchema).default([]),
  })
  .strict()

const seedFactSchema = z
  .object({
    id: idSchema,
    subject: z.string().min(1),
    predicate: z.string().min(1),
    object: z.string().min(1),
    topics: z.array(idSchema).min(1),
    source: idSchema,
  })
  .strict()

export const seedCorpusSchema = z
  .object({
    version: z.literal(1),
    id: idSchema,
    description: z.string().min(1),
    repository: repositorySchema,
    vault: z
      .object({
        project: seedProjectSchema,
        topics: z.array(seedTopicSchema).min(1),
        memories: z.array(seedMemorySchema).min(1),
        decisions: z.array(seedDecisionSchema).default([]),
        facts: z.array(seedFactSchema).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((corpus, ctx) => {
    const assertUnique = (
      label: string,
      items: Array<{ id: string }>,
      pathPrefix: Array<string | number>
    ) => {
      const seen = new Map<string, number>()
      for (const [index, item] of items.entries()) {
        const firstIndex = seen.get(item.id)
        if (firstIndex !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [...pathPrefix, index, "id"],
            message: `duplicate ${label} id "${item.id}"; first seen at index ${firstIndex}`,
          })
        }
        seen.set(item.id, index)
      }
    }

    assertUnique("topic", corpus.vault.topics, ["vault", "topics"])
    assertUnique("memory", corpus.vault.memories, ["vault", "memories"])
    assertUnique("decision", corpus.vault.decisions, ["vault", "decisions"])
    assertUnique("fact", corpus.vault.facts, ["vault", "facts"])

    const topicIds = new Set(corpus.vault.topics.map((topic) => topic.id))
    const sourceIds = new Set([
      ...corpus.vault.memories.map((memory) => memory.id),
      ...corpus.vault.decisions.map((decision) => decision.id),
    ])
    for (const [index, memory] of corpus.vault.memories.entries()) {
      validateProvenance({
        ctx,
        item: memory,
        pathPrefix: ["vault", "memories", index],
      })
      for (const topicId of memory.topics) {
        if (!topicIds.has(topicId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["vault", "memories", index, "topics"],
            message: `unknown topic id "${topicId}"`,
          })
        }
      }
    }
    for (const [index, decision] of corpus.vault.decisions.entries()) {
      validateProvenance({
        ctx,
        item: decision,
        pathPrefix: ["vault", "decisions", index],
      })
      for (const topicId of decision.topics) {
        if (!topicIds.has(topicId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["vault", "decisions", index, "topics"],
            message: `unknown topic id "${topicId}"`,
          })
        }
      }
    }
    for (const [index, fact] of corpus.vault.facts.entries()) {
      if (!sourceIds.has(fact.source)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["vault", "facts", index, "source"],
          message: `unknown source id "${fact.source}"`,
        })
      }
      for (const topicId of fact.topics) {
        if (!topicIds.has(topicId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["vault", "facts", index, "topics"],
            message: `unknown topic id "${topicId}"`,
          })
        }
      }
    }
  })

export type SeedCorpus = z.infer<typeof seedCorpusSchema>

function validateProvenance(input: {
  ctx: z.RefinementCtx
  item: {
    provenanceKind: "pr-derived" | "generalized" | "synthetic"
    sourcePullRequests: Array<{ repo: string; number: number; url: string }>
  }
  pathPrefix: Array<string | number>
}): void {
  if (input.item.provenanceKind === "pr-derived") {
    if (input.item.sourcePullRequests.length === 0) {
      input.ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...input.pathPrefix, "sourcePullRequests"],
        message: "pr-derived seed entries must cite at least one source pull request",
      })
    }
  } else if (input.item.sourcePullRequests.length > 0) {
    input.ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [...input.pathPrefix, "sourcePullRequests"],
      message: "only pr-derived seed entries may cite source pull requests",
    })
  }

  for (const [index, source] of input.item.sourcePullRequests.entries()) {
    if (!source.url.includes(`/${source.repo}/pull/${source.number}`)) {
      input.ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [...input.pathPrefix, "sourcePullRequests", index, "url"],
        message: "source pull request URL must match its repo and pull request number",
      })
    }
  }
}

export async function loadSeedCorpus(path: string): Promise<SeedCorpus> {
  const absolute = resolve(path)
  const raw = await readFile(absolute, "utf-8")
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse seed corpus at ${absolute}: ${message}`, {
      cause: err,
    })
  }
  return seedCorpusSchema.parse(parsed)
}
