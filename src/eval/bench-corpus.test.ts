import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import {
  LONGMEMEVAL_CATEGORIES,
  loadBenchCorpus,
  readBenchCorpusChecksums,
  sha256Hex,
  renderSessionTranscript,
  BenchCorpusChecksumMismatchError,
} from "./bench-corpus.js"

describe("LONGMEMEVAL_CATEGORIES", () => {
  it("contains exactly seven categories including abstention", () => {
    expect(LONGMEMEVAL_CATEGORIES).toHaveLength(7)
    expect(LONGMEMEVAL_CATEGORIES).toContain("abstention")
    expect(LONGMEMEVAL_CATEGORIES).toContain("single-session-user")
    expect(LONGMEMEVAL_CATEGORIES).toContain("temporal-reasoning")
  })
})

describe("sha256Hex", () => {
  it("produces a 64-char lowercase hex string", () => {
    const result = sha256Hex("hello")
    expect(result).toMatch(/^[a-f0-9]{64}$/)
    expect(result).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
    )
  })
})

describe("renderSessionTranscript", () => {
  it("renders user and assistant turns as Role: content", () => {
    const transcript = renderSessionTranscript([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ])
    expect(transcript).toBe("User: Hello\n\nAssistant: Hi there")
  })

  it("returns empty string for empty sessions", () => {
    expect(renderSessionTranscript([])).toBe("")
  })
})

describe("loadBenchCorpus", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-corpus-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("loads and verifies a matching corpus", async () => {
    const examples = [
      {
        question_id: "lme_s_0001",
        question_type: "single-session-user",
        question: "What did the user say?",
        answer: "They said hello.",
        haystack_sessions: [
          [
            { role: "user", content: "hello" },
            { role: "assistant", content: "hi" },
          ],
        ],
      },
    ]
    const corpusPath = join(dir, "corpus.json")
    const buffer = Buffer.from(JSON.stringify(examples))
    writeFileSync(corpusPath, buffer)
    const sha = sha256Hex(buffer)
    writeFileSync(
      join(dir, "checksums.json"),
      JSON.stringify({
        source: "huggingface",
        repository: "xiaowu0162/longmemeval-cleaned",
        revision: "abc123",
        files: { "corpus.json": { sha256: sha } },
        license: "MIT",
      })
    )
    const loaded = await loadBenchCorpus({
      name: "longmemeval_s_cleaned",
      corpusPath,
    })
    expect(loaded.examples).toHaveLength(1)
    expect(loaded.examples[0]?.question_type).toBe("single-session-user")
    expect(loaded.sha256).toBe(sha)
  })

  it("throws BenchCorpusChecksumMismatchError on sha drift", async () => {
    const corpusPath = join(dir, "corpus.json")
    writeFileSync(corpusPath, JSON.stringify([]))
    writeFileSync(
      join(dir, "checksums.json"),
      JSON.stringify({
        source: "huggingface",
        repository: "xiaowu0162/longmemeval-cleaned",
        revision: "abc123",
        files: {
          "corpus.json": {
            sha256: "deadbeef".repeat(8),
          },
        },
        license: "MIT",
      })
    )
    await expect(loadBenchCorpus({ name: "x", corpusPath })).rejects.toBeInstanceOf(
      BenchCorpusChecksumMismatchError
    )
  })

  it("throws when checksums.json shape is invalid", async () => {
    const path = join(dir, "checksums.json")
    writeFileSync(path, JSON.stringify({ source: "other" }))
    await expect(readBenchCorpusChecksums(path)).rejects.toThrow()
  })
})
