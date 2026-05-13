import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, beforeEach, afterEach } from "vitest"
import {
  readBudgetCount,
  runBenchIngest,
  runBenchRawTranscriptIngest,
} from "./bench-ingest.js"
import type { MiningResult } from "../hooks/conversation-mining.js"
import type { LongMemEvalExample } from "./bench-corpus.js"

function buildExample(
  sessionCount: number,
  category: LongMemEvalExample["question_type"] = "single-session-user",
): LongMemEvalExample {
  return {
    question_id: "lme_s_test_001",
    question_type: category,
    question: "What did the user say?",
    answer: "hello",
    haystack_sessions: Array.from({ length: sessionCount }, (_, i) => [
      { role: "user" as const, content: `hello-${i}` },
      { role: "assistant" as const, content: `reply-${i}` },
    ]),
  }
}

describe("readBudgetCount", () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-ingest-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it("returns null when the file is absent", () => {
    expect(readBudgetCount(join(dir, "missing.json"))).toBeNull()
  })

  it("returns the parsed count", () => {
    const path = join(dir, "state.json")
    writeFileSync(
      path,
      JSON.stringify({
        writeBudgetExceeded: true,
        limit: 500,
        count: 510,
        exceededAt: "2026-05-13T06:00:00Z",
      }),
    )
    expect(readBudgetCount(path)).toBe(510)
  })

  it("returns null on malformed json", () => {
    const path = join(dir, "state.json")
    writeFileSync(path, "not-json")
    expect(readBudgetCount(path)).toBeNull()
  })
})

describe("runBenchIngest", () => {
  it("replays every session when none trigger cap", async () => {
    const calls: string[] = []
    const result = await runBenchIngest({
      example: buildExample(3),
      cwd: "/tmp/cwd",
      subProjects: ["lme-test"],
      catchAllName: null,
      budgetStateFile: "/tmp/state.json",
      projectId: "project-1",
      runMining: async (transcript): Promise<MiningResult> => {
        calls.push(transcript)
        return {
          elapsedMs: 100,
          writeBudgetExceeded: false,
          exitCode: 0,
          exitSignal: null,
        }
      },
      readBudgetCount: () => 12,
      countMemoriesForProject: async () => 4,
      countFactsForProject: async () => 2,
    })
    expect(calls).toHaveLength(3)
    expect(result.sessionsReplayed).toBe(3)
    expect(result.writeBudgetExceeded).toBe(false)
    expect(result.failureReason).toBeNull()
    expect(result.notionWrites).toBe(12)
  })

  it("halts on write-budget-exceeded", async () => {
    let callCount = 0
    const result = await runBenchIngest({
      example: buildExample(5),
      cwd: "/tmp/cwd",
      subProjects: ["lme-test"],
      catchAllName: null,
      budgetStateFile: "/tmp/state.json",
      projectId: "project-1",
      runMining: async (): Promise<MiningResult> => {
        callCount += 1
        return {
          elapsedMs: 100,
          writeBudgetExceeded: callCount === 2,
          exitCode: 0,
          exitSignal: null,
        }
      },
      readBudgetCount: () => 501,
      countMemoriesForProject: async () => 50,
      countFactsForProject: async () => 10,
    })
    expect(result.failureReason).toBe("write-cap-exceeded")
    expect(result.writeBudgetExceeded).toBe(true)
    expect(result.sessionsReplayed).toBe(2)
    expect(callCount).toBe(2)
  })

  it("halts on SIGKILL timeout", async () => {
    const result = await runBenchIngest({
      example: buildExample(3),
      cwd: "/tmp/cwd",
      subProjects: ["lme-test"],
      catchAllName: null,
      budgetStateFile: "/tmp/state.json",
      projectId: "project-1",
      runMining: async (): Promise<MiningResult> => ({
        elapsedMs: 500_000,
        writeBudgetExceeded: false,
        exitCode: null,
        exitSignal: "SIGKILL",
      }),
      readBudgetCount: () => null,
      countMemoriesForProject: async () => 0,
      countFactsForProject: async () => 0,
    })
    expect(result.failureReason).toBe("mining-timeout")
  })

  it("falls back to row counts when budget state file is absent", async () => {
    const result = await runBenchIngest({
      example: buildExample(2),
      cwd: "/tmp/cwd",
      subProjects: ["lme-test"],
      catchAllName: null,
      budgetStateFile: "/tmp/state.json",
      projectId: "project-1",
      runMining: async (): Promise<MiningResult> => ({
        elapsedMs: 100,
        writeBudgetExceeded: false,
        exitCode: 0,
        exitSignal: null,
      }),
      readBudgetCount: () => null,
      countMemoriesForProject: async () => 5,
      countFactsForProject: async () => 3,
    })
    expect(result.notionWrites).toBe(8)
  })
})

describe("runBenchRawTranscriptIngest", () => {
  it("creates one memory per session and counts SDK mutations (2× per non-empty body)", async () => {
    const created: Array<{ title: string; content: string }> = []
    const result = await runBenchRawTranscriptIngest({
      example: buildExample(3),
      projectId: "project-1",
      perExampleWrites: 500,
      createMemoryInProject: async ({ title, content }) => {
        created.push({ title, content })
        return { id: `memory-${created.length}`, mutationCount: 2 }
      },
      countMemoriesForProject: async () => 3,
      countFactsForProject: async () => 0,
    })
    expect(created).toHaveLength(3)
    expect(result.sessionsReplayed).toBe(3)
    // 3 sessions × 2 mutations (pages.create + pages.updateMarkdown) = 6
    expect(result.notionWrites).toBe(6)
    expect(result.writeBudgetExceeded).toBe(false)
    expect(result.failureReason).toBeNull()
    expect(result.memoriesCreated).toBe(3)
    expect(result.factsCreated).toBe(0)
  })

  it("halts on worst-case headroom before crossing the per-example cap", async () => {
    let callCount = 0
    // Cap = 5: one 2-mutation session lands (notionWrites=2), pre-check
    // would project notionWrites+2=4 (≤5) → next session lands
    // (notionWrites=4), pre-check projects 4+2=6 (>5) → halt before
    // the third write. Without the headroom check the third write
    // would land at notionWrites=6, one past the advertised cap —
    // the inclusive-cap contract from round 5 carried forward.
    const result = await runBenchRawTranscriptIngest({
      example: buildExample(5),
      projectId: "project-1",
      perExampleWrites: 5,
      createMemoryInProject: async () => {
        callCount += 1
        return { id: `memory-${callCount}`, mutationCount: 2 }
      },
      countMemoriesForProject: async () => 2,
      countFactsForProject: async () => 0,
    })
    expect(callCount).toBe(2)
    expect(result.notionWrites).toBe(4)
    expect(result.writeBudgetExceeded).toBe(true)
    expect(result.failureReason).toBe("write-cap-exceeded")
    expect(result.sessionsReplayed).toBe(2)
  })

  it("propagates createMemoryInProject errors as ingestion-error", async () => {
    const result = await runBenchRawTranscriptIngest({
      example: buildExample(3),
      projectId: "project-1",
      perExampleWrites: 500,
      createMemoryInProject: async () => {
        throw new Error("notion rate limit")
      },
      countMemoriesForProject: async () => 0,
      countFactsForProject: async () => 0,
    })
    expect(result.failureReason).toBe("ingestion-error")
    expect(result.failureMessage).toBe("notion rate limit")
    expect(result.notionWrites).toBe(0)
    expect(result.sessionsReplayed).toBe(0)
  })

  it("uses haystack_session_ids when present for memory titles", async () => {
    const titles: string[] = []
    const example: LongMemEvalExample = {
      ...buildExample(2),
      haystack_session_ids: ["custom-id-a", "custom-id-b"],
    }
    await runBenchRawTranscriptIngest({
      example,
      projectId: "project-1",
      perExampleWrites: 500,
      createMemoryInProject: async ({ title }) => {
        titles.push(title)
        return { id: "memory-id", mutationCount: 2 }
      },
      countMemoriesForProject: async () => 2,
      countFactsForProject: async () => 0,
    })
    expect(titles).toEqual([
      "Session 1: custom-id-a",
      "Session 2: custom-id-b",
    ])
  })
})

describe("runBenchIngest notionWrites fallback", () => {
  it("treats budgetCount === 0 as authoritative zero (no row-count fallback)", async () => {
    // Regression for the `??` semantics — a legitimate steady-state
    // run that performed zero mutations must NOT fall back to
    // memoriesCreated + factsCreated, which could be non-zero if
    // pre-existing rows live under the project (e.g. cleanup
    // residue). `0 ?? sum` returns `0`; `0 || sum` would return
    // `sum` — the bug shape the reviewer flagged.
    const result = await runBenchIngest({
      example: buildExample(1),
      cwd: "/tmp/cwd",
      subProjects: ["lme-test"],
      catchAllName: null,
      budgetStateFile: "/tmp/state.json",
      projectId: "project-1",
      runMining: async (): Promise<MiningResult> => ({
        elapsedMs: 100,
        writeBudgetExceeded: false,
        exitCode: 0,
        exitSignal: null,
      }),
      readBudgetCount: () => 0,
      countMemoriesForProject: async () => 5,
      countFactsForProject: async () => 3,
    })
    expect(result.notionWrites).toBe(0)
  })
})
