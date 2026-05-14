import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { runProfileEvalSuite } from "./profile-runner.js"

describe("runProfileEvalSuite", () => {
  it("runs the committed support suite and records profile metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-profile-eval-"))
    const outPath = join(dir, "support-profile.json")

    const { artifact } = await runProfileEvalSuite("evals/profile-suites/support.yaml", {
      outPath,
      now: () => new Date("2026-05-14T00:00:00.000Z"),
    })

    expect(artifact.runner).toBe("profile")
    expect(artifact.profile.selector).toBe("support@1.0.0")
    expect(artifact.profile.promptHashes.autosaveExtractionFilter).toMatch(
      /^[a-f0-9]{64}$/
    )
    expect(artifact.summary.failedCases).toBe(0)
    expect(artifact.summary.failures).toEqual([])
    expect(artifact.summary.metrics.invalidTaxonomyRate).toBe(0)

    const written = JSON.parse(await readFile(outPath, "utf-8")) as typeof artifact
    expect(written.profile.selector).toBe("support@1.0.0")
  })
})
