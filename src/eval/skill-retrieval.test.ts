import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  loadSkillRetrievalCorpus,
  loadSkillRetrievalSuite,
  runSkillRetrievalSuite,
  skillRetrievalSuiteSchema,
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
