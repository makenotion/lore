/**
 * Production `BenchSandbox` factory — wires the bench-runner's
 * Notion-side hooks (`createSubProject` / `archiveProject` / row
 * counters) into the live Lore services.
 *
 * Lazily imported by the CLI so the bench-runner module graph
 * (corpus loader, fetch, etc.) does not need to drag in the full
 * service init.
 */

import { initServices } from "../services.js"
import { resolveFeatureFlags } from "../feature-flags.js"
import { resolveProjectByName } from "../core/project-scope.js"
import { emitAutoMentions } from "../core/auto-mentions.js"
import { loadWakeUpData } from "../core/wakeup.js"
import type { BenchSandbox } from "./bench-runner.js"

/**
 * Per-example wake-up prefetch caps. The bench renders a single
 * relevance-ranked context block, so these are tighter than the
 * production `lore-context action='wake-up'` defaults — small,
 * focused, fits well within the agent's prompt budget.
 */
const WAKE_UP_PREFETCH_LIMIT = 10
const WAKE_UP_PREFETCH_FETCH_LIMIT = WAKE_UP_PREFETCH_LIMIT * 3
/**
 * Per-memory body truncation when rendering the wake-up prefetch
 * block. LongMemEval transcripts can run to a few KB each; capping
 * at 4 KB keeps the rendered block under ~40 KB total even at
 * `limit=10`, well within gpt-4o-mini's context window after the
 * system prompt + question.
 */
const WAKE_UP_PREFETCH_BODY_CAP = 4000

export async function buildBenchSandbox(): Promise<BenchSandbox> {
  const sandboxName = process.env["LORE_BENCH_SANDBOX_PROJECT_NAME"]
  if (!sandboxName) {
    throw new Error(
      "LORE_BENCH_SANDBOX_PROJECT_NAME must be set to a sandbox project NAME (the bench-runner resolves it to an id at startup)."
    )
  }
  const services = await initServices(undefined, { driftCheck: false })
  const parent = await resolveProjectByName(services.projects, sandboxName, "bench")
  return {
    authSource: services.authSource,
    activeProfileSelector: services.profile.selector,
    async createSubProject(name) {
      const project = await services.projects.create({
        name,
        type: "project",
        path: `${parent.path ?? parent.name}/${name}`,
      })
      return project.id
    },
    async createMemoryInProject(input) {
      const memory = await services.memories.create({
        title: input.title,
        content: input.content,
        projectIds: [input.projectId],
        source: "conversation",
        kind: "note",
        autosaveLearningDedupScope: "off",
      })
      // `MemoryService.createFresh` always issues a `pages.create`
      // and conditionally a second `pages.updateMarkdown` when
      // `content` is non-empty. Surface the real mutation count to
      // the caller so the per-example write cap is enforced against
      // SDK-level mutations, not per-memory rows. See the comment on
      // `BenchSandbox.createMemoryInProject` for the cap-accounting
      // contract.
      const mutationCount = input.content.length > 0 ? 2 : 1
      return { id: memory.id, mutationCount }
    },
    async createSimulatedAutosaveMemoryInProject(input) {
      const memory = await services.memories.create({
        ...input.createInput,
        projectIds: input.createInput.projectIds ?? [input.projectId],
      })
      const memoryMutationCount = input.createInput.content.length > 0 ? 2 : 1
      const mentionFacts = await emitAutoMentions({
        facts: services.facts,
        memory,
        extraEntities: input.mentionEntities,
        disabled: !(services.features ?? resolveFeatureFlags()).autoMentions,
      })
      return {
        id: memory.id,
        memoryMutationCount,
        mentionFacts,
        notionMutationCount: memoryMutationCount + mentionFacts.notionMutationCount,
      }
    },
    async getWakeUpForQuery(input) {
      // The `wake-up-prefetch` retrieval strategy uses the same
      // narrow task-only wake-up shape exposed by MCP: one
      // relevance-ranked search seeded by the bench question, with
      // digest / recents / active task inventory suppressed. That
      // keeps LongMemEval measuring retrieval of the right memory
      // instead of unrelated session-start context injection.
      const wakeUp = await loadWakeUpData(services, {
        mode: "task-only",
        projectId: input.projectId,
        userQuery: input.userQuery,
        taskMemoryLimit: WAKE_UP_PREFETCH_FETCH_LIMIT,
        includeMemoryContent: true,
      })
      const memories = wakeUp.taskMemories
        .filter((memory) => memory.projectIds.includes(input.projectId))
        .slice(0, WAKE_UP_PREFETCH_LIMIT)
      if (memories.length === 0) {
        return { renderedContext: "", surfacedMemoryIds: [] }
      }
      const blocks = memories.map((memory, index) => {
        const body = (memory.content ?? "").slice(0, WAKE_UP_PREFETCH_BODY_CAP)
        return `### Memory ${index + 1}: ${memory.title}\n\n${body}`
      })
      return {
        renderedContext: [
          "## Retrieved context (relevance-ranked for your current question)",
          "",
          "The memories below were retrieved by Lore's hybrid search seeded",
          "with your question. Answer from these contents.",
          "",
          ...blocks,
        ].join("\n"),
        surfacedMemoryIds: memories.map((memory) => memory.id),
      }
    },
    async archiveProject(id) {
      await services.projects.archive(id)
    },
    async countMemoriesForProject(projectId) {
      let count = 0
      const iter = services.memories.listAllForBackfill({ projectId })
      for await (const row of iter) {
        if (row) count += 1
      }
      return count
    },
    async countFactsForProject(projectId) {
      let count = 0
      const iter = services.facts.listAllForBackfill({
        projectId,
        includeInvalidated: false,
      })
      for await (const row of iter) {
        if (row) count += 1
      }
      return count
    },
  }
}
