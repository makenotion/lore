import { mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { sha256Hex } from "./bench-corpus.js"
import {
  fetchSkillRetrievalCorpus,
  readSkillRetrievalCorpusManifest,
} from "./skill-retrieval-fetch.js"

describe("skill-retrieval corpus fetch", () => {
  it("validates the committed SkillRet manifest", async () => {
    const manifest = await readSkillRetrievalCorpusManifest(
      "evals/skill-retrieval/skillret-checksums.json"
    )

    expect(manifest.repository).toBe("ThakiCloud/SKILLRET")
    expect(manifest.files["data/skills/test.jsonl"]?.path).toBe("data/skills/test.jsonl")
  })

  it("downloads missing files and skips sha-matched files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skillret-fetch-"))
    const manifestPath = join(dir, "checksums.json")
    const payload = Buffer.from('{"ok":true}\n')
    await writeFile(
      manifestPath,
      JSON.stringify({
        source: "huggingface",
        repository: "owner/repo",
        revision: "abc123",
        license: "Apache-2.0",
        files: {
          "data/example.jsonl": {
            sha256: sha256Hex(payload),
            path: "data/example.jsonl",
          },
        },
      }),
      "utf-8"
    )
    const outRoot = join(dir, "out")

    const first = await fetchSkillRetrievalCorpus({
      manifestPath,
      outRoot,
      download: async () => payload,
    })
    expect(first.files).toEqual([
      {
        path: join(outRoot, "data/example.jsonl"),
        sha256: sha256Hex(payload),
        skipped: false,
      },
    ])

    const second = await fetchSkillRetrievalCorpus({
      manifestPath,
      outRoot,
      download: async () => {
        throw new Error("should not download")
      },
    })
    expect(second.files[0]?.skipped).toBe(true)
    expect(await readFile(join(outRoot, "data/example.jsonl"), "utf-8")).toBe(
      payload.toString("utf-8")
    )
  })

  it("rejects sha drift", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-skillret-fetch-bad-"))
    const manifestPath = join(dir, "checksums.json")
    await writeFile(
      manifestPath,
      JSON.stringify({
        source: "huggingface",
        repository: "owner/repo",
        revision: "abc123",
        license: "Apache-2.0",
        files: {
          "data/example.jsonl": {
            sha256: "0".repeat(64),
            path: "data/example.jsonl",
          },
        },
      }),
      "utf-8"
    )

    await expect(
      fetchSkillRetrievalCorpus({
        manifestPath,
        outRoot: join(dir, "out"),
        download: async () => Buffer.from("different"),
      })
    ).rejects.toThrow(/sha256 mismatch/)
  })
})
