import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { LoreServices } from "../services.js"
import type { Memory } from "../types.js"
import {
  importSkillRetrievalCorpusToNotion,
  loadSkillRetrievalCorpus,
  loadSkillRetrievalSuite,
  readSkillRetrievalImportManifest,
  runSkillRetrievalSuite,
  skillRetrievalSuiteSchema,
  type SkillRetrievalNotionSearch,
} from "./skill-retrieval.js"

describe("skill-retrieval runner", () => {
  it("validates the committed smoke suite and corpus", async () => {
    const loaded = await loadSkillRetrievalSuite(
      "evals/skill-retrieval/skillret-smoke.yaml"
    )
    const corpus = await loadSkillRetrievalCorpus(loaded)

    expect(loaded.suite.runner).toBe("skill-retrieval")
    expect(corpus.skills).toHaveLength(3)
    expect(corpus.queries).toHaveLength(3)
    expect(corpus.qrels).toHaveLength(3)
  })

  it("rejects retrieval windows smaller than the largest k value", () => {
    const result = skillRetrievalSuiteSchema.safeParse({
      version: 1,
      runner: "skill-retrieval",
      name: "bad-window",
      corpus: {
        kind: "skillret",
        root: "fixtures/skillret-mini",
      },
      k: [1, 10],
      retrieval: { limit: 5 },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "retrieval.limit must be at least the largest requested k value"
      )
    }
  })

  it("rejects notion-ai suites without notion import config", () => {
    const result = skillRetrievalSuiteSchema.safeParse({
      version: 1,
      runner: "skill-retrieval",
      name: "missing-notion-config",
      corpus: {
        kind: "skillret",
        root: "fixtures/skillret-mini",
      },
      lanes: ["notion-ai"],
      k: [1],
      retrieval: { limit: 1 },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "notion config is required when skill-retrieval lanes include notion-ai"
      )
    }
  })

  it("rejects notion-ai retrieval windows above the RunTool cap", () => {
    const result = skillRetrievalSuiteSchema.safeParse({
      version: 1,
      runner: "skill-retrieval",
      name: "large-notion-window",
      corpus: {
        kind: "skillret",
        root: "fixtures/skillret-mini",
      },
      notion: {
        projectName: "SkillRet Eval",
        topicName: "SkillRet Test Split",
        importManifestPath: "manifests/import.json",
        expectedVaultPageId: "374b35e6-e67f-8108-beb4-dec11f2f5d28",
      },
      lanes: ["notion-ai"],
      k: [1],
      retrieval: { limit: 26 },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "notion-ai uses RunTool search, whose current returned-window cap is 25"
      )
    }
  })

  it("rejects taxonomy topic imports that also scope search to the root topic", () => {
    const result = skillRetrievalSuiteSchema.safeParse({
      version: 1,
      runner: "skill-retrieval",
      name: "bad-taxonomy-scope",
      corpus: {
        kind: "skillret",
        root: "fixtures/skillret-mini",
      },
      notion: {
        projectName: "SkillRet Eval",
        topicName: "SkillRet Test Split",
        importManifestPath: "manifests/import.json",
        taxonomyTopics: true,
        searchTopicScoped: true,
      },
      lanes: ["notion-ai"],
      k: [1],
      retrieval: { limit: 1 },
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "taxonomyTopics requires searchTopicScoped: false"
      )
    }
  })

  it("runs the keyword lane and writes a skill-retrieval artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skill-retrieval-"))
    const outPath = join(dir, "artifact.json")

    const { artifact, outPath: writtenPath } = await runSkillRetrievalSuite(
      "evals/skill-retrieval/skillret-smoke.yaml",
      {
        outPath,
        now: new Date("2026-06-03T12:00:00.000Z"),
      }
    )

    expect(writtenPath).toBe(outPath)
    expect(artifact.runner).toMatchObject({
      mode: "skill-retrieval",
      corpusKind: "skillret",
      lanes: ["keyword"],
      k: [1, 2],
      limit: 2,
    })
    expect(artifact.summary).toMatchObject({
      skills: 3,
      queries: 2,
      qrels: 3,
      totalResults: 2,
    })
    expect(artifact.summary.lanes.keyword?.recallAt["1"]).toBe(1)
    expect(artifact.summary.lanes.keyword?.ndcgAt["2"]).toBe(1)

    const persisted = JSON.parse(await readFile(outPath, "utf-8")) as {
      startedAt: string
      runner: { mode: string }
    }
    expect(persisted.startedAt).toBe("2026-06-03T12:00:00.000Z")
    expect(persisted.runner.mode).toBe("skill-retrieval")
  })

  it("imports a SkillRet corpus once and scores notion-ai through the manifest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skill-retrieval-notion-"))
    const oversizedSkillMarkdown =
      "Prefer beta typography when dense scanning is required.\n\n" +
      "Dense dashboard typography guidance. ".repeat(3000)
    await writeFile(
      join(dir, "skills.jsonl"),
      [
        JSON.stringify({
          id: "skill-alpha",
          name: "Alpha Skill",
          description:
            "Use alpha routing for tenancy decisions when metadata authority, tenancy boundaries, request provenance, regional policy, cache invalidation, and retry behavior all need to remain aligned.",
          skill_md: "Prefer alpha routing when tenant metadata is authoritative.",
          major: "architecture",
          sub: "routing",
        }),
        JSON.stringify({
          id: "skill-beta",
          name: "Beta Skill",
          description: "Use beta typography for compact dashboards.",
          skill_md: oversizedSkillMarkdown,
          major: "design",
          sub: "typography",
        }),
      ].join("\n") + "\n",
      "utf-8"
    )
    await writeFile(
      join(dir, "queries.jsonl"),
      '{"id":"q-alpha","query":"tenant metadata routing","skill_ids":["skill-alpha"]}\n',
      "utf-8"
    )
    await writeFile(
      join(dir, "qrels.jsonl"),
      '{"query_id":"q-alpha","skill_id":"skill-alpha","relevance":1}\n',
      "utf-8"
    )
    const suitePath = join(dir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
runner: skill-retrieval
name: notion-import-test
corpus:
  kind: skillret
  root: .
  skillsPath: skills.jsonl
  queriesPath: queries.jsonl
  qrelsPath: qrels.jsonl
document:
  textFields:
    - name
    - description
    - skill_md
notion:
  projectName: SkillRet Eval
  topicName: SkillRet Test Split
  importManifestPath: manifests/import.json
  taxonomyTopics: true
  searchTopicScoped: false
lanes:
  - notion-ai
k:
  - 1
retrieval:
  limit: 1
`,
      "utf-8"
    )

    const createdMemories = new Map<string, Memory>()
    const memoriesById = new Map<string, Memory>()
    const topicKeysByMemoryId = new Map<string, string>()
    const createInputs: Array<Record<string, unknown>> = []
    const updateInputs: Array<{ id: string; input: Record<string, unknown> }> = []
    const topicIdsByName = new Map<string, string>()
    const topicIdForName = (name: string): string => {
      const existing = topicIdsByName.get(name)
      if (existing) return existing
      const id =
        name === "SkillRet Test Split"
          ? "topic-1"
          : `topic-${name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "")}`
      topicIdsByName.set(name, id)
      return id
    }
    const services = {
      config: {
        vault: {
          pageId: "374b35e6-e67f-8108-beb4-dec11f2f5d28",
        },
      },
      projects: {
        findByName: async () => ({
          id: "project-1",
          name: "SkillRet Eval",
          type: "project",
          path: "",
          status: "active",
          description: "",
        }),
        create: async () => {
          throw new Error("project should already exist")
        },
      },
      topics: {
        getOrCreate: async (name: string) => ({
          id: topicIdForName(name),
          name,
          projectIds: ["project-1"],
          description: "",
        }),
      },
      memories: {
        findByPromotionSourceKey: async (sourceKey: string) => {
          const skillId = sourceKey.split(":").at(-1)
          if (!skillId) return null
          return createdMemories.get(skillId) ?? null
        },
        findByTopicKey: async (input: { topicKey: string }) => {
          for (const [memoryId, topicKey] of topicKeysByMemoryId.entries()) {
            if (topicKey !== input.topicKey) continue
            return memoriesById.get(memoryId) ?? null
          }
          return null
        },
        create: async (input: Record<string, unknown>) => {
          createInputs.push(input)
          const sourceKey = String(input["promotionSourceKey"] ?? "")
          const skillId = sourceKey.split(":").at(-1) ?? "unknown"
          const memory = testMemory(
            `memory-${skillId}`,
            String(input["title"] ?? ""),
            String(input["topicId"] ?? "")
          )
          createdMemories.set(skillId, memory)
          memoriesById.set(memory.id, memory)
          if (typeof input["topicKey"] === "string") {
            topicKeysByMemoryId.set(memory.id, input["topicKey"])
          }
          return memory
        },
        update: async (id: string, input: Record<string, unknown>) => {
          updateInputs.push({ id, input })
          const existing = memoriesById.get(id) ?? testMemory(id, "")
          const updated = {
            ...existing,
            title: typeof input["title"] === "string" ? input["title"] : existing.title,
            content:
              typeof input["content"] === "string" ? input["content"] : existing.content,
            topicId:
              typeof input["topicId"] === "string" ? input["topicId"] : existing.topicId,
          } as Memory
          memoriesById.set(id, updated)
          if (typeof input["topicKey"] === "string") {
            topicKeysByMemoryId.set(id, input["topicKey"])
          }
          return updated
        },
      },
      client: {
        pages: {
          update: async (input: {
            page_id: string
            properties: Record<string, unknown>
          }) => {
            const property = input.properties["Topic Key"] as
              | { rich_text?: Array<{ text?: { content?: string } }> }
              | undefined
            const topicKey = property?.rich_text?.[0]?.text?.content
            if (topicKey) topicKeysByMemoryId.set(input.page_id, topicKey)
            return {}
          },
        },
      },
    } as unknown as LoreServices

    const firstImport = await importSkillRetrievalCorpusToNotion(suitePath, {
      servicesFactory: async () => services,
      now: new Date("2026-06-03T12:00:00.000Z"),
    })
    const oldManifest = JSON.parse(
      await readFile(join(dir, "manifests/import.json"), "utf-8")
    ) as { transformVersion: number; skills: Record<string, Record<string, unknown>> }
    oldManifest.transformVersion = 1
    oldManifest.skills["skill-alpha"]!.contentSha256 = "0".repeat(64)
    delete oldManifest.skills["skill-alpha"]!["metadataSha256"]
    delete oldManifest.skills["skill-alpha"]!["topicName"]
    delete oldManifest.skills["skill-alpha"]!["topicId"]
    delete oldManifest.skills["skill-alpha"]!["topicKey"]
    delete oldManifest.skills["skill-alpha"]!["tags"]
    await writeFile(
      join(dir, "manifests/import.json"),
      `${JSON.stringify(oldManifest, null, 2)}\n`,
      "utf-8"
    )
    const secondImport = await importSkillRetrievalCorpusToNotion(suitePath, {
      servicesFactory: async () => services,
      now: new Date("2026-06-03T12:05:00.000Z"),
    })
    await rm(join(dir, "manifests/import.json"))
    const rebuiltImport = await importSkillRetrievalCorpusToNotion(suitePath, {
      servicesFactory: async () => services,
      now: new Date("2026-06-03T12:06:00.000Z"),
    })

    expect(firstImport).toMatchObject({
      imported: 2,
      updated: 0,
      skipped: 0,
      selected: 2,
    })
    expect(secondImport).toMatchObject({
      imported: 0,
      updated: 1,
      reconciled: 0,
      skipped: 1,
      selected: 2,
    })
    expect(rebuiltImport).toMatchObject({
      imported: 0,
      updated: 0,
      reconciled: 2,
      skipped: 0,
      selected: 2,
    })
    expect(createInputs).toHaveLength(2)
    expect(createInputs[0]).toMatchObject({
      projectIds: ["project-1"],
      topicId: "topic-skillret-test-split-architecture-routing",
      topicKey: "skillret/test/unknown/architecture/routing/skill-alpha",
      kind: "procedure",
      status: "informational",
      promotionSourceKey: "skillret:unknown:skill-alpha",
      tags: [
        "skillret",
        "skillret-split-test",
        "skillret-kind-procedure",
        "skillret-major-architecture",
        "skillret-sub-routing",
      ],
    })
    const alphaContent = String(createInputs[0]?.["content"] ?? "")
    expect(alphaContent).toContain("## Search Summary")
    expect(alphaContent).toContain("Skill Name: Alpha Skill")
    expect(alphaContent).toContain("Short Summary: Use alpha routing")
    expect(alphaContent).toContain("Major: architecture")
    expect(alphaContent).toContain("Sub: routing")
    expect(alphaContent).toContain("Tags: skillret, skillret-split-test")
    const alphaSynopsis = String(createInputs[0]?.["synopsis"] ?? "")
    expect(alphaSynopsis).toHaveLength(150)
    expect(alphaSynopsis).toContain("Skill: Alpha Skill")
    expect(alphaSynopsis).toContain("Use when: Use alpha routing")
    const betaCreate = createInputs.find((input) => input["title"] === "Beta Skill")
    const betaContent = String(betaCreate?.["content"] ?? "")
    expect(betaContent).toContain(
      "[Content truncated at 60,000 characters for stable Notion eval import;"
    )
    expect(betaContent.length).toBeLessThan(62_000)
    expect(updateInputs).toHaveLength(3)
    const manifest = await readSkillRetrievalImportManifest(
      join(dir, "manifests/import.json")
    )
    expect(Object.keys(manifest.skills).sort()).toEqual(["skill-alpha", "skill-beta"])
    expect(manifest.skills["skill-alpha"]?.memoryId).toBe("memory-skill-alpha")
    expect(manifest.skills["skill-alpha"]?.topicKey).toBe(
      "skillret/test/unknown/architecture/routing/skill-alpha"
    )
    expect(manifest.transformVersion).toBe(4)
    expect(manifest.skills["skill-beta"]?.truncatedFields).toEqual([
      {
        field: "skill_md",
        originalChars: oversizedSkillMarkdown.trim().length,
        importedChars: 60_000,
      },
    ])

    const searchCalls: Array<{
      projectId: string
      topicId?: string
      limit: number
      requireRunToolAi: boolean
    }> = []
    let transientSearchFailures = 1
    const notionSearch: SkillRetrievalNotionSearch = async (input) => {
      searchCalls.push({
        projectId: input.projectId,
        topicId: input.topicId,
        limit: input.limit,
        requireRunToolAi: input.requireRunToolAi,
      })
      if (transientSearchFailures > 0) {
        transientSearchFailures -= 1
        throw new Error("Request to Notion API failed with status: 502")
      }
      const memory = createdMemories.get("skill-alpha")
      if (!memory) throw new Error("missing imported alpha memory")
      return {
        memories: [memory],
        explain: [],
        capped: false,
        mechanism: {
          passed: true,
          failures: [],
          trace: {
            toolsRunSearchCalls: 1,
            toolsRunOtherCalls: 0,
            clientSearchCalls: 0,
            dataSourceQueryCalls: 0,
            pagesRetrieveCalls: 0,
          },
        },
        elapsedMs: 3,
      }
    }

    await writeFile(
      join(dir, "manifests/import.json"),
      `${JSON.stringify({ ...manifest, transformVersion: 3 }, null, 2)}\n`,
      "utf-8"
    )
    await expect(
      runSkillRetrievalSuite(suitePath, {
        servicesFactory: async () => services,
        notionSearch,
        outPath: join(dir, "stale-result.json"),
        now: new Date("2026-06-03T12:09:00.000Z"),
      })
    ).rejects.toThrow(/transformVersion 3 != 4/)
    await writeFile(
      join(dir, "manifests/import.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8"
    )
    const partialManifest = {
      ...manifest,
      skills: { ...manifest.skills },
    }
    delete partialManifest.skills["skill-alpha"]
    await writeFile(
      join(dir, "manifests/import.json"),
      `${JSON.stringify(partialManifest, null, 2)}\n`,
      "utf-8"
    )
    await expect(
      runSkillRetrievalSuite(suitePath, {
        servicesFactory: async () => services,
        notionSearch,
        outPath: join(dir, "partial-result.json"),
        now: new Date("2026-06-03T12:09:30.000Z"),
      })
    ).rejects.toThrow(/manifest is incomplete/)
    await writeFile(
      join(dir, "manifests/import.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf-8"
    )

    const { artifact } = await runSkillRetrievalSuite(suitePath, {
      servicesFactory: async () => services,
      notionSearch,
      outPath: join(dir, "result.json"),
      now: new Date("2026-06-03T12:10:00.000Z"),
    })

    expect(searchCalls).toEqual(
      Array.from({ length: 2 }, () => ({
        projectId: "project-1",
        topicId: undefined,
        limit: 1,
        requireRunToolAi: true,
      }))
    )
    expect(artifact.summary.lanes["notion-ai"]).toMatchObject({
      queries: 1,
      cappedResults: 0,
      mechanismFailures: 0,
    })
    expect(artifact.summary.lanes["notion-ai"]?.recallAt["1"]).toBe(1)
    expect(artifact.results[0]).toMatchObject({
      lane: "notion-ai",
      returnedSkillIds: ["skill-alpha"],
      returnedMemoryIds: ["memory-skill-alpha"],
    })
  })

  it("recreates current manifest entries whose live Notion row disappeared", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skill-retrieval-stale-live-"))
    await writeFile(
      join(dir, "skills.jsonl"),
      [
        JSON.stringify({
          id: "skill-alpha",
          name: "Alpha Skill",
          description: "Use alpha routing.",
          skill_md: "Prefer alpha routing.",
        }),
      ].join("\n") + "\n",
      "utf-8"
    )
    await writeFile(
      join(dir, "queries.jsonl"),
      '{"id":"q-alpha","query":"alpha routing","skill_ids":["skill-alpha"]}\n',
      "utf-8"
    )
    await writeFile(
      join(dir, "qrels.jsonl"),
      '{"query_id":"q-alpha","skill_id":"skill-alpha","relevance":1}\n',
      "utf-8"
    )
    const suitePath = join(dir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
runner: skill-retrieval
name: stale-live-row
corpus:
  kind: skillret
  root: .
  skillsPath: skills.jsonl
  queriesPath: queries.jsonl
  qrelsPath: qrels.jsonl
notion:
  projectName: SkillRet Eval
  topicName: SkillRet Test Split
  importManifestPath: manifests/import.json
`,
      "utf-8"
    )

    let nextMemoryId = 1
    let liveMemory: Memory | null = null
    const createInputs: Array<Record<string, unknown>> = []
    const services = {
      config: {
        vault: {
          pageId: "374b35e6-e67f-8108-beb4-dec11f2f5d28",
        },
      },
      projects: {
        findByName: async () => ({
          id: "project-1",
          name: "SkillRet Eval",
          type: "project",
          path: "",
          status: "active",
          description: "",
        }),
        create: async () => {
          throw new Error("project should already exist")
        },
      },
      topics: {
        getOrCreate: async () => ({
          id: "topic-1",
          name: "SkillRet Test Split",
          projectIds: ["project-1"],
          description: "",
        }),
      },
      memories: {
        findByPromotionSourceKey: async () => liveMemory,
        findByTopicKey: async () => liveMemory,
        create: async (input: Record<string, unknown>) => {
          createInputs.push(input)
          liveMemory = testMemory(`memory-${nextMemoryId}`, String(input["title"] ?? ""))
          nextMemoryId += 1
          return liveMemory
        },
        update: async () => {
          throw new Error("stale live row should be recreated, not updated")
        },
      },
    } as unknown as LoreServices

    const firstImport = await importSkillRetrievalCorpusToNotion(suitePath, {
      servicesFactory: async () => services,
      now: new Date("2026-06-03T12:00:00.000Z"),
    })
    liveMemory = null
    const secondImport = await importSkillRetrievalCorpusToNotion(suitePath, {
      servicesFactory: async () => services,
      now: new Date("2026-06-03T12:05:00.000Z"),
    })
    const manifest = await readSkillRetrievalImportManifest(
      join(dir, "manifests/import.json")
    )

    expect(firstImport).toMatchObject({ imported: 1, skipped: 0 })
    expect(secondImport).toMatchObject({ imported: 1, skipped: 0 })
    expect(createInputs).toHaveLength(2)
    expect(manifest.skills["skill-alpha"]?.memoryId).toBe("memory-2")
  })

  it("does not mark a legacy import manifest current during a limited repair", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skill-retrieval-limit-"))
    await writeFile(
      join(dir, "skills.jsonl"),
      [
        JSON.stringify({
          id: "skill-alpha",
          name: "Alpha Skill",
          description: "Alpha description.",
          skill_md: "Alpha body.",
        }),
        JSON.stringify({
          id: "skill-beta",
          name: "Beta Skill",
          description: "Beta description.",
          skill_md: "Beta body.",
        }),
        JSON.stringify({
          id: "skill-gamma",
          name: "Gamma Skill",
          description: "Gamma description.",
          skill_md: "Gamma body.",
        }),
      ].join("\n") + "\n",
      "utf-8"
    )
    await writeFile(
      join(dir, "queries.jsonl"),
      '{"id":"q-alpha","query":"alpha","skill_ids":["skill-alpha"]}\n',
      "utf-8"
    )
    await writeFile(
      join(dir, "qrels.jsonl"),
      '{"query_id":"q-alpha","skill_id":"skill-alpha","relevance":1}\n',
      "utf-8"
    )
    const suitePath = join(dir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
runner: skill-retrieval
name: limited-legacy-repair
corpus:
  kind: skillret
  root: .
  skillsPath: skills.jsonl
  queriesPath: queries.jsonl
  qrelsPath: qrels.jsonl
notion:
  projectName: SkillRet Eval
  topicName: SkillRet Test Split
  importManifestPath: manifests/import.json
lanes:
  - notion-ai
k:
  - 1
retrieval:
  limit: 1
`,
      "utf-8"
    )

    const services = {
      config: {
        vault: {
          pageId: "374b35e6-e67f-8108-beb4-dec11f2f5d28",
        },
      },
      projects: {
        findByName: async () => ({
          id: "project-1",
          name: "SkillRet Eval",
          type: "project",
          path: "",
          status: "active",
          description: "",
        }),
        create: async () => {
          throw new Error("project should already exist")
        },
      },
      topics: {
        getOrCreate: async () => ({
          id: "topic-1",
          name: "SkillRet Test Split",
          projectIds: ["project-1"],
          description: "",
        }),
      },
      memories: {
        findByPromotionSourceKey: async () => null,
        findByTopicKey: async () => null,
        create: async (input: Record<string, unknown>) => {
          const sourceKey = String(input["promotionSourceKey"] ?? "")
          const skillId = sourceKey.split(":").at(-1) ?? "unknown"
          return testMemory(`memory-${skillId}`, String(input["title"] ?? ""))
        },
      },
    } as unknown as LoreServices

    await importSkillRetrievalCorpusToNotion(suitePath, {
      servicesFactory: async () => services,
      now: new Date("2026-06-03T12:00:00.000Z"),
    })
    const manifestPath = join(dir, "manifests/import.json")
    const oldManifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      transformVersion: number
    }
    oldManifest.transformVersion = 2
    await writeFile(manifestPath, `${JSON.stringify(oldManifest, null, 2)}\n`, "utf-8")

    await expect(
      importSkillRetrievalCorpusToNotion(suitePath, {
        servicesFactory: async () => services,
        now: new Date("2026-06-03T12:05:00.000Z"),
        limit: 1,
      })
    ).rejects.toThrow(/repairing a legacy transform requires importing the full/)

    const manifest = await readSkillRetrievalImportManifest(manifestPath)
    expect(manifest.transformVersion).toBe(2)
  })

  it("does not mark a failed full legacy repair current", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skill-retrieval-repair-fail-"))
    await writeFile(
      join(dir, "skills.jsonl"),
      [
        JSON.stringify({
          id: "skill-alpha",
          name: "Alpha Skill",
          description: "Alpha description.",
          skill_md: "Alpha body.",
        }),
        JSON.stringify({
          id: "skill-beta",
          name: "Beta Skill",
          description: "Beta description.",
          skill_md: "Beta body.",
        }),
      ].join("\n") + "\n",
      "utf-8"
    )
    await writeFile(
      join(dir, "queries.jsonl"),
      '{"id":"q-beta","query":"beta","skill_ids":["skill-beta"]}\n',
      "utf-8"
    )
    await writeFile(
      join(dir, "qrels.jsonl"),
      '{"query_id":"q-beta","skill_id":"skill-beta","relevance":1}\n',
      "utf-8"
    )
    const suitePath = join(dir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
runner: skill-retrieval
name: failed-legacy-repair
corpus:
  kind: skillret
  root: .
  skillsPath: skills.jsonl
  queriesPath: queries.jsonl
  qrelsPath: qrels.jsonl
notion:
  projectName: SkillRet Eval
  topicName: SkillRet Test Split
  importManifestPath: manifests/import.json
lanes:
  - notion-ai
k:
  - 1
retrieval:
  limit: 1
`,
      "utf-8"
    )

    const liveMemories = new Map<string, Memory>()
    let failAlphaUpdate = false
    const services = {
      config: {
        vault: {
          pageId: "374b35e6-e67f-8108-beb4-dec11f2f5d28",
        },
      },
      projects: {
        findByName: async () => ({
          id: "project-1",
          name: "SkillRet Eval",
          type: "project",
          path: "",
          status: "active",
          description: "",
        }),
        create: async () => {
          throw new Error("project should already exist")
        },
      },
      topics: {
        getOrCreate: async () => ({
          id: "topic-1",
          name: "SkillRet Test Split",
          projectIds: ["project-1"],
          description: "",
        }),
      },
      memories: {
        findByPromotionSourceKey: async (sourceKey: string) =>
          liveMemories.get(sourceKey) ?? null,
        findByTopicKey: async () => null,
        create: async (input: Record<string, unknown>) => {
          const sourceKey = String(input["promotionSourceKey"] ?? "")
          const memory = testMemory(
            `memory-${sourceKey.split(":").at(-1) ?? "unknown"}`,
            String(input["title"] ?? "")
          )
          liveMemories.set(sourceKey, memory)
          return memory
        },
        update: async (_memoryId: string, input: Record<string, unknown>) => {
          if (failAlphaUpdate && input["title"] === "Alpha Skill") {
            throw new Error("SkillRet topicKey is already held by memory mem-alpha")
          }
        },
      },
    } as unknown as LoreServices

    await importSkillRetrievalCorpusToNotion(suitePath, {
      servicesFactory: async () => services,
      now: new Date("2026-06-03T12:00:00.000Z"),
    })
    const manifestPath = join(dir, "manifests/import.json")
    const oldManifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      transformVersion: number
      skills: Record<string, { contentSha256: string }>
    }
    oldManifest.transformVersion = 3
    oldManifest.skills["skill-alpha"]!.contentSha256 = "0".repeat(64)
    await writeFile(manifestPath, `${JSON.stringify(oldManifest, null, 2)}\n`, "utf-8")

    failAlphaUpdate = true
    await expect(
      importSkillRetrievalCorpusToNotion(suitePath, {
        servicesFactory: async () => services,
        now: new Date("2026-06-03T12:05:00.000Z"),
        parallelism: 2,
      })
    ).rejects.toThrow(/1 failed, 1 completed/)

    const manifest = await readSkillRetrievalImportManifest(manifestPath)
    expect(manifest.transformVersion).toBe(3)
    expect(manifest.skills["skill-alpha"]?.contentSha256).toBe("0".repeat(64))
  })

  it("rejects fresh imports when another memory already owns the topic key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skill-retrieval-topic-key-"))
    await writeFile(
      join(dir, "skills.jsonl"),
      JSON.stringify({
        id: "skill-alpha",
        name: "Alpha Skill",
        description: "Alpha description.",
        skill_md: "Alpha body.",
      }) + "\n",
      "utf-8"
    )
    await writeFile(
      join(dir, "queries.jsonl"),
      '{"id":"q-alpha","query":"alpha","skill_ids":["skill-alpha"]}\n',
      "utf-8"
    )
    await writeFile(
      join(dir, "qrels.jsonl"),
      '{"query_id":"q-alpha","skill_id":"skill-alpha","relevance":1}\n',
      "utf-8"
    )
    const suitePath = join(dir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
runner: skill-retrieval
name: duplicate-topic-key
corpus:
  kind: skillret
  root: .
  skillsPath: skills.jsonl
  queriesPath: queries.jsonl
  qrelsPath: qrels.jsonl
notion:
  projectName: SkillRet Eval
  topicName: SkillRet Test Split
  importManifestPath: manifests/import.json
lanes:
  - notion-ai
k:
  - 1
retrieval:
  limit: 1
`,
      "utf-8"
    )

    const services = {
      config: {
        vault: {
          pageId: "374b35e6-e67f-8108-beb4-dec11f2f5d28",
        },
      },
      projects: {
        findByName: async () => ({
          id: "project-1",
          name: "SkillRet Eval",
          type: "project",
          path: "",
          status: "active",
          description: "",
        }),
        create: async () => {
          throw new Error("project should already exist")
        },
      },
      topics: {
        getOrCreate: async () => ({
          id: "topic-1",
          name: "SkillRet Test Split",
          projectIds: ["project-1"],
          description: "",
        }),
      },
      memories: {
        findByPromotionSourceKey: async () => null,
        findByTopicKey: async () => testMemory("memory-stale", "Stale Skill"),
        create: async () => {
          throw new Error("create should not be called")
        },
      },
    } as unknown as LoreServices

    await expect(
      importSkillRetrievalCorpusToNotion(suitePath, {
        servicesFactory: async () => services,
        now: new Date("2026-06-03T12:00:00.000Z"),
      })
    ).rejects.toThrow(/cannot create a duplicate SkillRet memory/)
  })

  it("drains completed parallel imports before reporting failures", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skill-retrieval-drain-"))
    await writeFile(
      join(dir, "skills.jsonl"),
      [
        JSON.stringify({
          id: "skill-alpha",
          name: "Alpha Skill",
          description: "This row fails during create.",
          skill_md: "Alpha body.",
        }),
        JSON.stringify({
          id: "skill-beta",
          name: "Beta Skill",
          description: "This row completes during create.",
          skill_md: "Beta body.",
        }),
      ].join("\n") + "\n",
      "utf-8"
    )
    await writeFile(
      join(dir, "queries.jsonl"),
      '{"id":"q-beta","query":"beta","skill_ids":["skill-beta"]}\n',
      "utf-8"
    )
    await writeFile(
      join(dir, "qrels.jsonl"),
      '{"query_id":"q-beta","skill_id":"skill-beta","relevance":1}\n',
      "utf-8"
    )
    const suitePath = join(dir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
runner: skill-retrieval
name: drain-test
corpus:
  kind: skillret
  root: .
  skillsPath: skills.jsonl
  queriesPath: queries.jsonl
  qrelsPath: qrels.jsonl
notion:
  projectName: SkillRet Eval
  topicName: SkillRet Test Split
  importManifestPath: manifests/import.json
lanes:
  - notion-ai
k:
  - 1
retrieval:
  limit: 1
`,
      "utf-8"
    )

    const services = {
      config: {
        vault: {
          pageId: "374b35e6-e67f-8108-beb4-dec11f2f5d28",
        },
      },
      projects: {
        findByName: async () => ({
          id: "project-1",
          name: "SkillRet Eval",
          type: "project",
          path: "",
          status: "active",
          description: "",
        }),
        create: async () => {
          throw new Error("project should already exist")
        },
      },
      topics: {
        getOrCreate: async () => ({
          id: "topic-1",
          name: "SkillRet Test Split",
          projectIds: ["project-1"],
          description: "",
        }),
      },
      memories: {
        findByPromotionSourceKey: async () => null,
        findByTopicKey: async () => null,
        create: async (input: Record<string, unknown>) => {
          const title = String(input["title"] ?? "")
          if (title === "Alpha Skill") {
            throw new Error("SkillRet topicKey is already held by memory mem-alpha")
          }
          return testMemory("memory-skill-beta", title)
        },
      },
    } as unknown as LoreServices

    await expect(
      importSkillRetrievalCorpusToNotion(suitePath, {
        servicesFactory: async () => services,
        now: new Date("2026-06-03T12:00:00.000Z"),
        parallelism: 2,
      })
    ).rejects.toThrow(/1 failed, 1 completed/)

    const manifest = await readSkillRetrievalImportManifest(
      join(dir, "manifests/import.json")
    )
    expect(Object.keys(manifest.skills)).toEqual(["skill-beta"])
  })

  it("fails when qrels point at missing skills", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skill-retrieval-bad-"))
    await writeFile(
      join(dir, "skills.jsonl"),
      '{"id":"skill-one","name":"One","description":"","skill_md":""}\n',
      "utf-8"
    )
    await writeFile(
      join(dir, "queries.jsonl"),
      '{"id":"query-one","query":"Find one","skill_ids":["missing"]}\n',
      "utf-8"
    )
    await writeFile(
      join(dir, "qrels.jsonl"),
      '{"query_id":"query-one","skill_id":"missing","relevance":1}\n',
      "utf-8"
    )
    const suitePath = join(dir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
runner: skill-retrieval
name: bad-corpus
corpus:
  kind: skillret
  root: .
  skillsPath: skills.jsonl
  queriesPath: queries.jsonl
  qrelsPath: qrels.jsonl
`,
      "utf-8"
    )

    const loaded = await loadSkillRetrievalSuite(suitePath)
    await expect(loadSkillRetrievalCorpus(loaded)).rejects.toThrow(
      'references unknown skill "missing"'
    )
  })
})

function testMemory(id: string, title: string, topicId = "topic-1"): Memory {
  return {
    id,
    title,
    synopsis: "",
    content: "",
    projectIds: ["project-1"],
    topicId,
    source: "manual",
    kind: "procedure",
    status: "informational",
  } as Memory
}
