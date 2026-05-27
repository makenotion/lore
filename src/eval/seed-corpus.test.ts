import { describe, expect, it } from "vitest"
import { loadSeedCorpus } from "./seed-corpus.js"

describe("seed corpus", () => {
  it("loads the committed GitHub CLI pilot corpus", async () => {
    const corpus = await loadSeedCorpus("evals/vault-seeds/github-cli-pilot.yaml")

    expect(corpus).toMatchObject({
      id: "github-cli-pilot",
      repository: {
        repo: "cli/cli",
        sha: "9a593ce81b593dee752cc11737d1a3ef768e52b3",
      },
      vault: {
        project: {
          name: "GitHub CLI",
          path: ".",
        },
      },
    })
    expect(corpus.vault.topics.map((topic) => topic.id)).toContain("commands/config")
    expect(corpus.vault.memories).toHaveLength(7)
    expect(corpus.vault.decisions.length).toBeGreaterThan(0)
    expect(corpus.vault.facts.length).toBeGreaterThan(0)
  })

  it("loads the PR-derived and generalized GitHub CLI powered candidate corpus", async () => {
    const corpus = await loadSeedCorpus("evals/vault-seeds/github-cli-powered.yaml")

    expect(corpus).toMatchObject({
      id: "github-cli-powered",
      repository: {
        repo: "cli/cli",
        sha: "9a593ce81b593dee752cc11737d1a3ef768e52b3",
      },
    })
    const memoryIds = corpus.vault.memories.map((memory) => memory.id)
    expectUnique(memoryIds)
    expectUnique(corpus.vault.topics.map((topic) => topic.id))
    expectUnique(corpus.vault.decisions.map((decision) => decision.id))
    expectUnique(corpus.vault.facts.map((fact) => fact.id))
    expect(memoryIds).toContain("gh-cli/skills-hidden-dir-filtering")
    expect(memoryIds).toContain("gh-cli/telemetry-command-policy")
    expect(memoryIds).toContain("gh-cli/release-digest-algorithm")
    expect(
      corpus.vault.memories.some((memory) => memory.sourcePullRequests.length > 0)
    ).toBe(true)
    expect(
      corpus.vault.facts.find((fact) => fact.id === "gh-cli/fact-powered-scenario-target")
    ).toMatchObject({ object: "75" })
    for (const memory of corpus.vault.memories) {
      if (memory.provenanceKind === "pr-derived") {
        expect(memory.sourcePullRequests.length).toBeGreaterThan(0)
      } else {
        expect(memory.sourcePullRequests).toEqual([])
      }
      for (const source of memory.sourcePullRequests) {
        expect(source.url).toContain(`/${source.repo}/pull/${source.number}`)
      }
    }
    for (const decision of corpus.vault.decisions) {
      expect(decision.sourcePullRequests).toEqual([])
      expect(decision.provenanceKind).toBe("generalized")
    }
  })
})

function expectUnique(ids: string[]): void {
  expect(new Set(ids).size).toBe(ids.length)
}
