import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  loadSkillUseCorpus,
  loadSkillUseSuite,
  runEvidenceProxySkillUseAnswerer,
  runSkillUseSuite,
  skillUseSuiteSchema,
} from "./skill-use.js"

describe("skill-use runner", () => {
  it("validates the committed smoke suite and corpus", async () => {
    const loaded = await loadSkillUseSuite("evals/skill-use/smoke.yaml")
    const corpus = await loadSkillUseCorpus(loaded)

    expect(loaded.suite.runner).toBe("skill-use")
    expect(corpus.documents).toHaveLength(4)
    expect(corpus.hashes.documentsSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("rejects retrieval windows smaller than the largest k value", () => {
    const result = skillUseSuiteSchema.safeParse({
      version: 1,
      runner: "skill-use",
      name: "bad-window",
      corpus: { documentsPath: "documents.jsonl" },
      retrieval: { lane: "keyword", limit: 1, k: [1, 2] },
      tasks: [
        {
          id: "task-one",
          prompt: "Answer from memory",
          answer: { accepted: ["yes"] },
          supportSets: [{ id: "primary", documentIds: ["memory-one"] }],
        },
      ],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "retrieval.limit must be at least the largest requested k value"
      )
    }
  })

  it("requires oracle context to satisfy at least one support set", () => {
    const result = skillUseSuiteSchema.safeParse({
      version: 1,
      runner: "skill-use",
      name: "bad-oracle",
      corpus: { documentsPath: "documents.jsonl" },
      tasks: [
        {
          id: "task-one",
          prompt: "Answer from memory",
          answer: { accepted: ["yes"] },
          supportSets: [{ id: "primary", documentIds: ["memory-one"] }],
          oracleContextIds: ["near-miss"],
        },
      ],
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toContain(
        "oracleContextIds must satisfy at least one support set"
      )
    }
  })

  it("runs all context conditions and writes a skill-use artifact", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skill-use-"))
    const outPath = join(dir, "artifact.json")

    const { artifact, outPath: writtenPath } = await runSkillUseSuite(
      "evals/skill-use/smoke.yaml",
      {
        outPath,
        now: new Date("2026-06-03T12:00:00.000Z"),
      }
    )

    expect(writtenPath).toBe(outPath)
    expect(artifact.runner).toMatchObject({
      mode: "skill-use",
      conditions: [
        "no-context",
        "oracle-context",
        "retrieved-context",
        "harmful-context",
      ],
      requiredConditions: ["oracle-context", "retrieved-context"],
      retrieval: { lane: "keyword", limit: 1, k: [1] },
    })
    expect(artifact.summary.thresholdFailures).toEqual([])
    expect(artifact.summary.conditions["no-context"]?.successRate).toBe(0)
    expect(artifact.summary.conditions["oracle-context"]?.successRate).toBe(1)
    expect(artifact.summary.conditions["retrieved-context"]?.successRate).toBe(1)
    expect(artifact.summary.conditions["harmful-context"]?.harmfulRate).toBe(1)
    expect(artifact.summary.lift).toMatchObject({
      retrievedVsNoContextAccuracyDelta: 1,
      retrievedGapToOracle: 0,
      contextDependentTaskIds: ["calendar-retention", "invoice-rounding"],
      retrievedLiftedTaskIds: ["calendar-retention", "invoice-rounding"],
      retrievedHarmedTaskIds: [],
    })
    const retrieved = artifact.results.find(
      (result) =>
        result.taskId === "calendar-retention" && result.condition === "retrieved-context"
    )
    expect(retrieved?.supportSetSatisfied).toBe(true)
    expect(retrieved?.ranking?.recallAt["1"]).toBe(1)

    const persisted = JSON.parse(await readFile(outPath, "utf-8")) as {
      startedAt: string
      runner: { mode: string; configHash: string }
      corpus: { documentsSha256: string }
    }
    expect(persisted.startedAt).toBe("2026-06-03T12:00:00.000Z")
    expect(persisted.runner.mode).toBe("skill-use")
    expect(persisted.runner.configHash).toMatch(/^[a-f0-9]{64}$/)
    expect(persisted.corpus.documentsSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it("surfaces no-context answer leakage as a threshold failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skill-use-leak-"))
    const { artifact } = await runSkillUseSuite("evals/skill-use/smoke.yaml", {
      outPath: join(dir, "artifact.json"),
      now: new Date("2026-06-03T12:00:00.000Z"),
      answerer: async (input) => {
        if (input.condition === "no-context") {
          return { answer: input.task.answer.accepted[0]!, citedDocumentIds: [] }
        }
        return runEvidenceProxySkillUseAnswerer(input)
      },
    })

    expect(artifact.summary.conditions["no-context"]?.answerAccuracy).toBe(1)
    expect(artifact.summary.thresholdFailures).toContain(
      "no-context answer accuracy 1 exceeds maxNoContextAccuracy 0"
    )
  })

  it("fails when support sets point at missing documents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skill-use-bad-"))
    await writeFile(
      join(dir, "documents.jsonl"),
      '{"id":"memory-one","title":"One","content":"Answer yes."}\n',
      "utf-8"
    )
    const suitePath = join(dir, "suite.yaml")
    await writeFile(
      suitePath,
      `version: 1
runner: skill-use
name: bad-corpus
corpus:
  documentsPath: documents.jsonl
tasks:
  - id: task-one
    prompt: Answer from memory
    answer:
      accepted:
        - yes
    supportSets:
      - id: primary
        documentIds:
          - missing
`,
      "utf-8"
    )

    const loaded = await loadSkillUseSuite(suitePath)
    await expect(loadSkillUseCorpus(loaded)).rejects.toThrow(
      'references unknown skill-use document "missing"'
    )
  })
})
