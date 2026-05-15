import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { stringify as stringifyYaml } from "yaml"
import type { AuthSource } from "../../config.js"
import { resolveProjectByName } from "../../core/project-scope.js"
import { loadWakeUpData, type WakeUpData } from "../../core/wakeup.js"
import {
  runConversationMining,
  type MiningResult,
} from "../../hooks/conversation-mining.js"
import { mergeHookDefaults } from "../../hooks/config.js"
import { initServices, type LoreServices } from "../../services.js"
import type { Fact, Memory, Project } from "../../types.js"
import { createIsolatedCodexHome, removeIsolatedCodexHome } from "./codex-adapter.js"
import type {
  LongitudinalLoreAdapter,
  LongitudinalLoreFormationResult,
  LongitudinalLoreRun,
  LongitudinalTaskEvalSuite,
  LongitudinalTaskScenario,
  LongitudinalWakeUpResult,
} from "./schema.js"

export function defaultLongitudinalLoreAdapter(): LongitudinalLoreAdapter {
  const allowReal = process.env["LORE_EVAL_LONGITUDINAL_REAL"]
  if (allowReal === "1" || allowReal === "true") {
    return new LiveLongitudinalLoreAdapter()
  }
  return new RefusingLongitudinalLoreAdapter(
    "Real longitudinal Lore formation refused: set " +
      "LORE_EVAL_LONGITUDINAL_REAL=1 and " +
      "LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT to opt in."
  )
}

export class LongitudinalAdapterRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LongitudinalAdapterRefusedError"
  }
}

class RefusingLongitudinalLoreAdapter implements LongitudinalLoreAdapter {
  constructor(private readonly message: string) {}

  async createRun(): Promise<LongitudinalLoreRun> {
    const message = this.message
    return {
      projectId: null,
      projectName: null,
      async formContext(): Promise<LongitudinalLoreFormationResult> {
        throw new LongitudinalAdapterRefusedError(message)
      },
      async loadContext(): Promise<LongitudinalWakeUpResult> {
        throw new LongitudinalAdapterRefusedError(message)
      },
      async cleanup(): Promise<void> {},
    }
  }
}

class LiveLongitudinalLoreAdapter implements LongitudinalLoreAdapter {
  private servicesPromise: Promise<LoreServices> | null = null

  async createRun(input: {
    suite: LongitudinalTaskEvalSuite
    scenario: LongitudinalTaskScenario
    runId: string
    workspace: string
  }): Promise<LongitudinalLoreRun> {
    const services = await this.services()
    const sandboxProjectName = process.env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"]
    if (!sandboxProjectName) {
      throw new LongitudinalAdapterRefusedError(
        "LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT is required for lore-full-loop runs."
      )
    }
    assertLongitudinalSandboxProjectName(sandboxProjectName)
    const parentProject = await resolveProjectByName(
      services.projects,
      sandboxProjectName,
      "longitudinal eval sandbox"
    )
    const projectName = `${parentProject.name}/${input.runId}`
    const project = await services.projects.create({
      name: projectName,
      path: ".",
      description:
        `Longitudinal eval project for suite ${input.suite.name}, ` +
        `scenario ${input.scenario.id}.`,
    })
    let configRoot: string | null = null
    try {
      configRoot = await mkdtemp(join(tmpdir(), "lore-eval-longitudinal-config-"))
      await chmod(configRoot, 0o700)
      await writeLongitudinalConfigRoot({
        configRoot,
        services,
        projectName: project.name,
      })
      return new LiveLongitudinalLoreRun({
        services,
        project,
        configRoot,
        workspace: input.workspace,
      })
    } catch (err) {
      await Promise.allSettled([
        services.projects.archive(project.id),
        configRoot ? rm(configRoot, { recursive: true, force: true }) : Promise.resolve(),
      ])
      throw err
    }
  }

  private async services(): Promise<LoreServices> {
    if (!this.servicesPromise) {
      const configuredRoot = process.env["LORE_EVAL_LONGITUDINAL_CONFIG_ROOT"]
      if (configuredRoot) {
        const prior = process.env["LORE_CONFIG_ROOT"]
        process.env["LORE_CONFIG_ROOT"] = configuredRoot
        this.servicesPromise = initServices(undefined, { driftCheck: false }).finally(
          () => {
            if (prior === undefined) delete process.env["LORE_CONFIG_ROOT"]
            else process.env["LORE_CONFIG_ROOT"] = prior
          }
        )
      } else {
        this.servicesPromise = initServices(undefined, { driftCheck: false })
      }
    }
    return this.servicesPromise
  }
}

class LiveLongitudinalLoreRun implements LongitudinalLoreRun {
  readonly projectId: string
  readonly projectName: string

  constructor(
    private readonly input: {
      services: LoreServices
      project: Project
      configRoot: string
      workspace: string
    }
  ) {
    this.projectId = input.project.id
    this.projectName = input.project.name
  }

  async formContext(input: {
    scenario: LongitudinalTaskScenario
    transcript: string
    workspace: string
    sessionId: string
  }): Promise<LongitudinalLoreFormationResult> {
    const before = await snapshotProjectContext(this.input.services, this.projectId)
    const hooks = mergeHookDefaults(
      this.input.services.config.hooks,
      this.projectName,
      []
    )
    const codexHome = await createIsolatedCodexHome()
    let mining: MiningResult
    try {
      mining = await withTemporaryLongitudinalAgentConfig(
        {
          workspace: input.workspace,
          configRoot: this.input.configRoot,
          services: this.input.services,
        },
        () =>
          withTemporaryEnv(
            {
              LORE_CONFIG_ROOT: this.input.configRoot,
              LORE_AGENT_NAME: process.env["LORE_AGENT_NAME"] ?? "Codex",
              CODEX_HOME: codexHome,
            },
            () =>
              runConversationMining(input.transcript, {
                cwd: input.workspace,
                subProjects: [],
                catchAllName: this.projectName,
                sessionId: input.sessionId,
                agentName: "Codex",
                authSource: this.input.services.authSource,
                agent: hooks.backgroundAgent,
              })
          )
      )
    } finally {
      await removeIsolatedCodexHome(codexHome)
    }
    const after = await snapshotProjectContext(this.input.services, this.projectId)
    const delta = diffProjectContextSnapshots(before, after)
    const expectedContextIds = selectExpectedContextIds(
      input.scenario.expectedContext.keywords,
      delta.contexts
    )
    return {
      projectId: this.projectId,
      projectName: this.projectName,
      mining,
      memoriesCreated: delta.memoriesCreated,
      factsCreated: delta.factsCreated,
      decisionsCreated: delta.decisionsCreated,
      tasksCreated: delta.tasksCreated,
      createdContextIds: delta.contexts.map((context) => context.id),
      expectedContextIds,
    }
  }

  async loadContext(input: {
    scenario: LongitudinalTaskScenario
    phaseBPrompt: string
    expectedContextIds: string[]
  }): Promise<LongitudinalWakeUpResult> {
    const data = await loadWakeUpData(this.input.services, {
      projectId: this.projectId,
      userQuery: input.phaseBPrompt,
      includeMemoryContent: true,
      includeCoverage: true,
    })
    return wakeUpDataToLongitudinalResult(data, input.scenario)
  }

  async cleanup(): Promise<void> {
    await this.input.services.projects.archive(this.projectId)
    await rm(this.input.configRoot, { recursive: true, force: true })
  }
}

const LONGITUDINAL_SANDBOX_NAME_MARKERS =
  /\b(?:sandbox|eval|test|scratch|staging|dev|playground)\b/i

export type LongitudinalAgentConfigServices = Pick<LoreServices, "authSource" | "config">

function assertLongitudinalSandboxProjectName(projectName: string): void {
  if (LONGITUDINAL_SANDBOX_NAME_MARKERS.test(projectName)) return
  const allowProd = process.env["LORE_EVAL_NOTION_ALLOW_PRODUCTION"]
  if (allowProd === "1" || allowProd === "true") return
  throw new Error(
    `Project "${projectName}" does not look like a sandbox (no word-bounded match for sandbox/eval/test/scratch/staging/dev/playground). ` +
      `Set LORE_EVAL_NOTION_ALLOW_PRODUCTION=1 to confirm pointing longitudinal task evals at this project on purpose.`
  )
}

async function writeLongitudinalConfigRoot(input: {
  configRoot: string
  services: LoreServices
  projectName: string
}): Promise<void> {
  const auth =
    input.services.config.auth &&
    (input.services.config.auth.workspaceId || input.services.config.auth.baseUrl)
      ? {
          workspaceId: input.services.config.auth.workspaceId,
          baseUrl: input.services.config.auth.baseUrl,
        }
      : undefined
  const config = {
    vault: { pageId: input.services.config.vault.pageId },
    ...(auth ? { auth } : {}),
    projects: [{ name: input.projectName, path: "." }],
    hooks: input.services.config.hooks ?? {},
  }
  await writeFile(join(input.configRoot, ".lore.yaml"), stringifyYaml(config), {
    mode: 0o600,
  })
}

async function writeLongitudinalAgentConfig(input: {
  workspace: string
  configRoot: string
  services: LongitudinalAgentConfigServices
}): Promise<void> {
  const mcpCommand = await resolveMcpCommand()
  const mcpEnv = buildLongitudinalMcpEnv(input.configRoot, input.services.authSource)
  await mkdir(join(input.workspace, ".codex"), { recursive: true, mode: 0o700 })
  await writeFile(
    join(input.workspace, ".codex", "config.toml"),
    renderCodexMcpConfig({
      command: mcpCommand.command,
      args: mcpCommand.args,
      env: mcpEnv,
    }),
    { mode: 0o600 }
  )
  await writeFile(
    join(input.workspace, ".mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          lore: {
            command: mcpCommand.command,
            args: mcpCommand.args,
            env: mcpEnv,
          },
        },
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  )
}

export async function removeLongitudinalAgentConfig(workspace: string): Promise<void> {
  await Promise.all([
    rm(join(workspace, ".codex", "config.toml"), { force: true }),
    rm(join(workspace, ".mcp.json"), { force: true }),
  ])
}

export async function withTemporaryLongitudinalAgentConfig<T>(
  input: {
    workspace: string
    configRoot: string
    services: LongitudinalAgentConfigServices
  },
  fn: () => Promise<T>
): Promise<T> {
  try {
    await writeLongitudinalAgentConfig(input)
    return await fn()
  } finally {
    await removeLongitudinalAgentConfig(input.workspace)
  }
}

async function resolveMcpCommand(): Promise<{ command: string; args: string[] }> {
  const distMcp = resolve(dirname(fileURLToPath(import.meta.url)), "..", "mcp.js")
  try {
    await stat(distMcp)
    return { command: "node", args: [distMcp] }
  } catch {
    return { command: "lore", args: ["mcp"] }
  }
}

function buildLongitudinalMcpEnv(
  configRoot: string,
  authSource: AuthSource
): Record<string, string> {
  const env: Record<string, string> = {
    LORE_CONFIG_ROOT: configRoot,
    LORE_SUPPRESS_DEPRECATIONS: "1",
    LORE_BACKGROUND_AGENT: "true",
  }
  for (const key of [
    "PATH",
    "HOME",
    "NOTION_API_TOKEN",
    "LORE_NOTION_BASE_URL",
    "NOTION_WORKSPACE_ID",
    "NOTION_ENV",
    "NOTION_BASE_URL",
    "NOTION_API_BASE_URL",
    "LORE_USER_NAME",
  ]) {
    if (authSource === "ntn-auth-json" && key === "NOTION_API_TOKEN") {
      continue
    }
    const value = process.env[key]
    if (typeof value === "string" && value.length > 0) env[key] = value
  }
  return env
}

function renderCodexMcpConfig(input: {
  command: string
  args: string[]
  env: Record<string, string>
}): string {
  const enabledTools = [
    "lore-context",
    "lore-query",
    "lore-memory",
    "lore-decision",
    "lore-fact",
    "lore-task",
    "lore-project",
  ]
  const lines = [
    "[mcp_servers.lore]",
    'transport = "stdio"',
    `command = "${tomlEscape(input.command)}"`,
    `args = [${input.args.map((arg) => `"${tomlEscape(arg)}"`).join(", ")}]`,
    'default_tools_approval_mode = "approve"',
    `enabled_tools = [${enabledTools.map((tool) => `"${tool}"`).join(", ")}]`,
    "",
    "[mcp_servers.lore.env]",
  ]
  for (const [key, value] of Object.entries(input.env).sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    lines.push(`${key} = "${tomlEscape(value)}"`)
  }
  lines.push("")
  return lines.join("\n")
}

function tomlEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
}

async function withTemporaryEnv<T>(
  overrides: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const prior = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(overrides)) {
    prior.set(key, process.env[key])
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const [key, value] of prior) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

interface ProjectContextSnapshot {
  memoryContexts: ProjectContextItem[]
  factContexts: ProjectContextItem[]
}

export interface ProjectContextItem {
  id: string
  kind: Memory["kind"] | "fact"
  text: string
}

async function snapshotProjectContext(
  services: LoreServices,
  projectId: string
): Promise<ProjectContextSnapshot> {
  const memoryContexts: ProjectContextItem[] = []
  for await (const memory of services.memories.listAllForBackfill({ projectId })) {
    memoryContexts.push(memoryToContextItem(memory))
  }
  const factContexts: ProjectContextItem[] = []
  for await (const fact of services.facts.listAllForBackfill({ projectId })) {
    factContexts.push(factToContextItem(fact))
  }
  return { memoryContexts, factContexts }
}

function diffProjectContextSnapshots(
  before: ProjectContextSnapshot,
  after: ProjectContextSnapshot
): {
  memoriesCreated: number
  factsCreated: number
  decisionsCreated: number
  tasksCreated: number
  contexts: ProjectContextItem[]
} {
  const beforeIds = new Set([
    ...before.memoryContexts.map((item) => item.id),
    ...before.factContexts.map((item) => item.id),
  ])
  const contexts = [...after.memoryContexts, ...after.factContexts].filter(
    (item) => !beforeIds.has(item.id)
  )
  return {
    memoriesCreated: contexts.filter(
      (item) => item.kind !== "decision" && item.kind !== "task" && item.kind !== "fact"
    ).length,
    factsCreated: contexts.filter((item) => item.kind === "fact").length,
    decisionsCreated: contexts.filter((item) => item.kind === "decision").length,
    tasksCreated: contexts.filter((item) => item.kind === "task").length,
    contexts,
  }
}

export function selectExpectedContextIds(
  keywords: string[],
  contexts: ProjectContextItem[]
): string[] {
  if (keywords.length === 0) {
    return contexts
      .filter((context) => context.kind !== "fact")
      .map((context) => context.id)
  }
  const normalized = keywords.map((keyword) => keyword.toLocaleLowerCase())
  const combinedText = contexts
    .map((context) => context.text)
    .join("\n")
    .toLocaleLowerCase()
  if (normalized.every((keyword) => combinedText.includes(keyword))) {
    const partialMatches = contexts.filter((context) => {
      const text = context.text.toLocaleLowerCase()
      return normalized.some((keyword) => text.includes(keyword))
    })
    return partialMatches.length > 0
      ? partialMatches.map((context) => context.id)
      : contexts.map((context) => context.id)
  }
  return contexts
    .filter((context) => {
      const text = context.text.toLocaleLowerCase()
      return normalized.every((keyword) => text.includes(keyword))
    })
    .map((context) => context.id)
}

function wakeUpDataToLongitudinalResult(
  data: WakeUpData,
  scenario: LongitudinalTaskScenario
): LongitudinalWakeUpResult {
  const contexts = wakeUpDataToContextItems(data)
  const surfacedContextIds = contexts.map((context) => context.id)
  const harmfulKeywords = scenario.expectedContext.harmfulKeywords.map((keyword) =>
    keyword.toLocaleLowerCase()
  )
  const harmfulContextIds =
    harmfulKeywords.length === 0
      ? []
      : contexts
          .filter((context) => {
            const text = context.text.toLocaleLowerCase()
            return harmfulKeywords.some((keyword) => text.includes(keyword))
          })
          .map((context) => context.id)
  return {
    renderedContext: renderLongitudinalWakeUpContext(contexts),
    surfacedContextIds,
    harmfulContextIds,
    failureMessage: null,
  }
}

function wakeUpDataToContextItems(data: WakeUpData): ProjectContextItem[] {
  const items: ProjectContextItem[] = []
  const add = (item: ProjectContextItem | null | undefined) => {
    if (!item) return
    if (items.some((existing) => existing.id === item.id)) return
    items.push(item)
  }
  add(data.digest ? memoryToContextItem(data.digest) : null)
  for (const memory of data.taskMemories) add(memoryToContextItem(memory))
  for (const memory of data.memories) add(memoryToContextItem(memory))
  for (const memory of data.relatedMemories) add(memoryToContextItem(memory))
  for (const memory of data.proposedMemories) add(memoryToContextItem(memory))
  for (const memory of data.staleConfidence) add(memoryToContextItem(memory))
  for (const memory of data.pinnedBlocks) add(memoryToContextItem(memory))
  for (const section of data.inheritedMemories) {
    for (const memory of section.memories) add(memoryToContextItem(memory))
  }
  for (const decision of data.proposedDecisions) add(memoryToContextItem(decision))
  for (const decision of data.overdueDecisions) add(memoryToContextItem(decision))
  for (const task of data.tasks) add(memoryToContextItem(task))
  for (const fact of data.knowledgeFacts) add(factToContextItem(fact))
  return items
}

function memoryToContextItem(
  memory: Omit<Memory, "content"> & { content?: string }
): ProjectContextItem {
  return {
    id: memory.id,
    kind: memory.kind,
    text: [
      memory.kind,
      memory.title,
      memory.synopsis,
      memory.keywords,
      memory.entity,
      memory.content ?? "",
    ]
      .filter(Boolean)
      .join("\n"),
  }
}

function factToContextItem(fact: Fact): ProjectContextItem {
  return {
    id: fact.id,
    kind: "fact",
    text: ["fact", fact.subject, fact.predicate, fact.object].join(" "),
  }
}

function renderLongitudinalWakeUpContext(contexts: ProjectContextItem[]): string {
  if (contexts.length === 0) return ""
  const lines: string[] = []
  for (const context of contexts) {
    const preview = context.text.replace(/\s+/g, " ").trim().slice(0, 1_000)
    lines.push(`- [${context.kind}] ${context.id}: ${preview}`)
  }
  return lines.join("\n")
}
