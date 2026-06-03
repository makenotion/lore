import { access, appendFile, readFile, unlink } from "node:fs/promises"
import { createConnection, createServer, type Server, type Socket } from "node:net"
import { dirname, join, resolve } from "node:path"
import { initServices, type LoreServices } from "../services.js"
import type { Memory, SearchMode } from "../types.js"
import type { BenchRetrievalCall } from "./bench-runner-types.js"
import { redactBearerTokens } from "./bench-redaction.js"

export const BENCH_TOOL_TRACE_ENV = "LORE_BENCH_TOOL_TRACE_FILE"
export const BENCH_TOOL_PROJECT_ID_ENV = "LORE_BENCH_TOOL_PROJECT_ID"
export const BENCH_TOOL_PROJECT_NAME_ENV = "LORE_BENCH_TOOL_PROJECT_NAME"
export const BENCH_TOOL_SOCKET_ENV = "LORE_BENCH_TOOL_SOCKET"

interface ParsedBenchToolArgs {
  action: string | null
  values: Record<string, string | boolean>
  positionals: string[]
}

interface BenchToolRunResult {
  text: string
  surfacedMemoryIds: string[]
  expandedMemoryIds: string[]
}

interface BenchToolExecutionResult {
  exitCode: number
  stdout: string
  stderr: string
}

type BenchMemoryHandleMap = Map<string, string>

interface BenchToolRenderContext {
  skillRet: boolean
}

interface BenchToolBrokerRequest {
  tool: string
  argv: string[]
}

export interface BenchToolBroker {
  socketPath: string
  close(): Promise<void>
}

export async function runBenchToolCli(
  tool: string,
  argv: string[],
  env: NodeJS.ProcessEnv = process.env
): Promise<number> {
  const brokerSocket = env[BENCH_TOOL_SOCKET_ENV]?.trim()
  if (brokerSocket) {
    const result = await executeBenchToolViaBroker(brokerSocket, tool, argv)
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    return result.exitCode
  }

  const result = await executeBenchTool(tool, argv, env)
  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  return result.exitCode
}

export async function startBenchToolBroker(input: {
  socketPath: string
  traceFile: string
  projectId: string
  projectName: string
  runtimeEnv?: NodeJS.ProcessEnv
}): Promise<BenchToolBroker> {
  await unlink(input.socketPath).catch(() => undefined)
  const fixedEnv: NodeJS.ProcessEnv = {
    ...(input.runtimeEnv ?? process.env),
    [BENCH_TOOL_TRACE_ENV]: input.traceFile,
    [BENCH_TOOL_PROJECT_ID_ENV]: input.projectId,
    [BENCH_TOOL_PROJECT_NAME_ENV]: input.projectName,
  }
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    handleBenchToolBrokerConnection(socket, fixedEnv).catch((err) => {
      socket.end(
        `${JSON.stringify({
          exitCode: 1,
          stdout: "",
          stderr: `lore bench tool broker failed: ${redactBearerTokens(
            err instanceof Error ? err.message : String(err)
          )}\n`,
        } satisfies BenchToolExecutionResult)}\n`
      )
    })
  })
  await listenOnUnixSocket(server, input.socketPath)
  return {
    socketPath: input.socketPath,
    async close() {
      await closeServer(server)
      await unlink(input.socketPath).catch(() => undefined)
    },
  }
}

async function executeBenchTool(
  tool: string,
  argv: string[],
  env: NodeJS.ProcessEnv
): Promise<BenchToolExecutionResult> {
  const startedAtMs = Date.now()
  const startedAt = new Date(startedAtMs).toISOString()
  const parsed = parseBenchToolArgs(argv)
  const action = parsed.action
  let runtimeEnv = env

  try {
    runtimeEnv = await prepareBenchToolRuntimeEnv(env)
    const result = await withBenchToolProcessEnv(runtimeEnv, async () => {
      const services = await initServices(undefined, { driftCheck: false })
      return dispatchBenchTool(services, tool, parsed, runtimeEnv)
    })
    await appendBenchToolTrace(runtimeEnv, {
      tool,
      action,
      surface: "codex-shell-shim",
      timing: "during-agent-run",
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      surfacedMemoryIds: result.surfacedMemoryIds,
      expandedMemoryIds: result.expandedMemoryIds,
      error: null,
    })
    return {
      exitCode: 0,
      stdout: result.text.endsWith("\n") ? result.text : `${result.text}\n`,
      stderr: "",
    }
  } catch (err) {
    const message = redactBearerTokens(err instanceof Error ? err.message : String(err))
    await appendBenchToolTrace(runtimeEnv, {
      tool,
      action,
      surface: "codex-shell-shim",
      timing: "during-agent-run",
      status: "error",
      startedAt,
      finishedAt: new Date().toISOString(),
      surfacedMemoryIds: [],
      expandedMemoryIds: [],
      error: message,
    })
    return {
      exitCode: 1,
      stdout: "",
      stderr: `${tool} failed: ${message}\n`,
    }
  }
}

function parseBenchToolArgs(argv: string[]): ParsedBenchToolArgs {
  const values: Record<string, string | boolean> = {}
  const positionals: string[] = []
  for (let i = 0; i < argv.length; i += 1) {
    const raw = argv[i]!
    if (raw === "--json" && argv[i + 1]) {
      const parsed = JSON.parse(argv[i + 1]!) as unknown
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("--json must be followed by a JSON object")
      }
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" || typeof value === "number") {
          values[key] = String(value)
        } else if (typeof value === "boolean") {
          values[key] = value
        } else if (Array.isArray(value)) {
          values[key] = value.join(",")
        }
      }
      i += 1
      continue
    }
    const keyValue = /^([A-Za-z][A-Za-z0-9_-]*)=(.*)$/u.exec(raw)
    if (keyValue) {
      values[keyValue[1]!] = keyValue[2]!
      continue
    }
    if (raw.startsWith("--")) {
      const key = raw.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith("--")) {
        values[key] = true
      } else {
        values[key] = next
        i += 1
      }
      continue
    }
    positionals.push(raw)
  }
  const rawAction = values["action"]
  const action =
    typeof rawAction === "string" && rawAction.trim().length > 0
      ? rawAction.trim()
      : positionals[0]
        ? positionals[0]
        : null
  return { action, values, positionals }
}

async function executeBenchToolViaBroker(
  socketPath: string,
  tool: string,
  argv: string[]
): Promise<BenchToolExecutionResult> {
  const request = `${JSON.stringify({ tool, argv } satisfies BenchToolBrokerRequest)}\n`
  return new Promise((resolve) => {
    const socket = createConnection(socketPath)
    const chunks: Buffer[] = []
    let settled = false
    let bytes = 0
    const finish = (result: BenchToolExecutionResult): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(result)
    }
    socket.on("connect", () => {
      socket.end(request)
    })
    socket.on("data", (chunk) => {
      bytes += chunk.length
      if (bytes > 1_000_000) {
        finish({
          exitCode: 1,
          stdout: "",
          stderr: `${tool} failed: bench tool broker response exceeded 1000000 bytes\n`,
        })
        return
      }
      chunks.push(chunk)
    })
    socket.on("error", (err) => {
      finish({
        exitCode: 1,
        stdout: "",
        stderr: `${tool} failed: bench tool broker request failed: ${redactBearerTokens(
          err.message
        )}\n`,
      })
    })
    socket.on("end", () => {
      if (settled) return
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown
        finish(parseBenchToolBrokerResponse(parsed))
      } catch (err) {
        finish({
          exitCode: 1,
          stdout: "",
          stderr: `${tool} failed: invalid bench tool broker response: ${redactBearerTokens(
            err instanceof Error ? err.message : String(err)
          )}\n`,
        })
      }
    })
  })
}

async function handleBenchToolBrokerConnection(
  socket: Socket,
  fixedEnv: NodeJS.ProcessEnv
): Promise<void> {
  const chunks: Buffer[] = []
  let bytes = 0
  await new Promise<void>((resolveSocket) => {
    socket.on("data", (chunk) => {
      bytes += chunk.length
      if (bytes > 1_000_000) {
        socket.destroy(new Error("bench tool broker request exceeded 1000000 bytes"))
        resolveSocket()
        return
      }
      chunks.push(chunk)
    })
    socket.on("end", resolveSocket)
    socket.on("error", resolveSocket)
  })
  if (socket.destroyed) return
  const request = parseBenchToolBrokerRequest(
    JSON.parse(Buffer.concat(chunks).toString("utf-8")) as unknown
  )
  const result = await executeBenchTool(request.tool, request.argv, fixedEnv)
  socket.end(`${JSON.stringify(result)}\n`)
}

function parseBenchToolBrokerRequest(value: unknown): BenchToolBrokerRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("broker request must be a JSON object")
  }
  const obj = value as { tool?: unknown; argv?: unknown }
  if (typeof obj.tool !== "string" || obj.tool.length === 0) {
    throw new Error("broker request tool must be a string")
  }
  if (!Array.isArray(obj.argv) || !obj.argv.every((arg) => typeof arg === "string")) {
    throw new Error("broker request argv must be a string array")
  }
  return { tool: obj.tool, argv: obj.argv }
}

function parseBenchToolBrokerResponse(value: unknown): BenchToolExecutionResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("broker response must be a JSON object")
  }
  const obj = value as { exitCode?: unknown; stdout?: unknown; stderr?: unknown }
  if (typeof obj.exitCode !== "number" || !Number.isInteger(obj.exitCode)) {
    throw new Error("broker response exitCode must be an integer")
  }
  if (typeof obj.stdout !== "string" || typeof obj.stderr !== "string") {
    throw new Error("broker response stdout/stderr must be strings")
  }
  return {
    exitCode: obj.exitCode,
    stdout: redactBearerTokens(obj.stdout),
    stderr: redactBearerTokens(obj.stderr || ""),
  }
}

async function listenOnUnixSocket(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolveListen, rejectListen) => {
    const onError = (err: Error): void => {
      server.off("listening", onListening)
      rejectListen(err)
    }
    const onListening = (): void => {
      server.off("error", onError)
      resolveListen()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(socketPath)
  })
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) => {
    server.close((err) => {
      if (err) rejectClose(err)
      else resolveClose()
    })
  })
}

async function dispatchBenchTool(
  services: LoreServices,
  tool: string,
  parsed: ParsedBenchToolArgs,
  env: NodeJS.ProcessEnv
): Promise<BenchToolRunResult> {
  if (tool === "lore-query") {
    return dispatchBenchQuery(services, parsed, env)
  }
  if (tool === "lore-memory") {
    return dispatchBenchMemory(services, parsed, env)
  }
  throw new Error(`unsupported bench tool "${tool}"`)
}

async function dispatchBenchQuery(
  services: LoreServices,
  parsed: ParsedBenchToolArgs,
  env: NodeJS.ProcessEnv
): Promise<BenchToolRunResult> {
  switch (parsed.action) {
    case "search": {
      const query = requiredString(parsed, "query")
      const limit = optionalPositiveInteger(parsed, "limit") ?? 10
      const mode = optionalSearchMode(parsed)
      const includeContent = optionalBoolean(parsed, "includeContent") === true
      const projectId = requiredBenchProjectId(env)
      const searched = await services.memories.search({
        query,
        projectId,
        limit,
        includeContent,
        mode,
      })
      const memories = filterBenchProjectMemories(searched, projectId)
      const handles = await assignBenchMemoryHandles(memories, env)
      const renderContext = benchToolRenderContext(env)
      return {
        text: renderBenchSearch(query, memories, includeContent, handles, renderContext),
        surfacedMemoryIds: memories.map((memory) => memory.id),
        expandedMemoryIds: [],
      }
    }
    case "recall": {
      const limit = optionalPositiveInteger(parsed, "limit") ?? 10
      const includeContent = optionalBoolean(parsed, "includeContent") === true
      const projectId = requiredBenchProjectId(env)
      const listed = await services.memories.list({
        projectId,
        limit,
        includeContent,
        includeUnscoped: false,
      })
      const memories = filterBenchProjectMemories(listed.items, projectId)
      const handles = await assignBenchMemoryHandles(memories, env)
      const renderContext = benchToolRenderContext(env)
      return {
        text: renderBenchRecall(memories, includeContent, handles, renderContext),
        surfacedMemoryIds: memories.map((memory) => memory.id),
        expandedMemoryIds: [],
      }
    }
    default:
      throw new Error(
        `unsupported lore-query action "${parsed.action ?? ""}"; supported actions: search, recall`
      )
  }
}

async function dispatchBenchMemory(
  services: LoreServices,
  parsed: ParsedBenchToolArgs,
  env: NodeJS.ProcessEnv
): Promise<BenchToolRunResult> {
  if (parsed.action !== "expand") {
    throw new Error(
      `unsupported lore-memory action "${parsed.action ?? ""}"; supported actions: expand`
    )
  }
  const ids = await resolveBenchMemoryIds(memoryIdsFromArgs(parsed), env)
  if (ids.length === 0) {
    throw new Error("lore-memory action=expand requires ids=<id1,id2>")
  }
  const projectId = requiredBenchProjectId(env)
  const memories = await Promise.all(ids.map((id) => services.memories.getById(id)))
  const outOfScope = memories.filter((memory) => !memory.projectIds.includes(projectId))
  if (outOfScope.length > 0) {
    throw new Error(
      `refusing to expand memories outside bench project ${projectId}: ${outOfScope
        .map((memory) => memory.id)
        .join(", ")}`
    )
  }
  return {
    text: renderBenchExpandedMemories(memories),
    surfacedMemoryIds: memories.map((memory) => memory.id),
    expandedMemoryIds: memories.map((memory) => memory.id),
  }
}

function requiredString(parsed: ParsedBenchToolArgs, key: string): string {
  const value = parsed.values[key]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key}=<value> is required`)
  }
  return value.trim()
}

function optionalPositiveInteger(
  parsed: ParsedBenchToolArgs,
  key: string
): number | undefined {
  const value = parsed.values[key]
  if (value === undefined) return undefined
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    throw new Error(`${key} must be a positive integer`)
  }
  return Number.parseInt(value, 10)
}

function optionalBoolean(parsed: ParsedBenchToolArgs, key: string): boolean | undefined {
  const value = parsed.values[key]
  if (value === undefined) return undefined
  if (typeof value === "boolean") return value
  if (value === "true") return true
  if (value === "false") return false
  throw new Error(`${key} must be true or false`)
}

function optionalSearchMode(parsed: ParsedBenchToolArgs): SearchMode | undefined {
  const value = parsed.values["mode"]
  if (value === undefined) return undefined
  if (value === "contains" || value === "semantic" || value === "hybrid") {
    return value
  }
  throw new Error("mode must be contains, semantic, or hybrid")
}

function memoryIdsFromArgs(parsed: ParsedBenchToolArgs): string[] {
  const value =
    parsed.values["ids"] ?? parsed.values["memoryIds"] ?? parsed.values["memoryId"]
  const raw =
    typeof value === "string" && value.trim().length > 0
      ? value
      : parsed.positionals.slice(parsed.positionals[0] === "expand" ? 1 : 0).join(",")
  return raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

async function resolveBenchMemoryIds(
  ids: string[],
  env: NodeJS.ProcessEnv
): Promise<string[]> {
  if (ids.length === 0) return []
  let handles: BenchMemoryHandleMap | null = null
  const resolved: string[] = []
  for (const id of ids) {
    if (isLatestBenchMemorySurfaceToken(id)) {
      const latestSurface = await readLatestBenchMemorySurface(env)
      if (!latestSurface || latestSurface.length === 0) {
        throw new Error(
          `memory set ${id} is not available; run lore-query search or recall first`
        )
      }
      resolved.push(...latestSurface)
      continue
    }
    const handleIndex = parseBenchMemoryHandle(id)
    if (handleIndex === null) {
      if (isLikelyAbbreviatedBenchMemoryId(id)) {
        throw new Error(
          `memory id ${id} looks abbreviated; use ids=latest, a listed handle such as m1, or a complete memory ID`
        )
      }
      resolved.push(id)
      continue
    }
    handles ??= await readBenchMemoryHandleMap(env)
    if (handles.size === 0) {
      throw new Error(
        `memory handle ${id} is not available; run lore-query search or recall first`
      )
    }
    const handle = `m${handleIndex + 1}`
    const memoryId = memoryIdForBenchHandle(handles, handle)
    if (!memoryId) {
      throw new Error(
        `memory handle ${id} is out of range; known handles: m1..m${handles.size}`
      )
    }
    resolved.push(memoryId)
  }
  return uniqueBenchMemoryIds(resolved)
}

function isLatestBenchMemorySurfaceToken(value: string): boolean {
  return value.trim().toLowerCase() === "latest"
}

function uniqueBenchMemoryIds(ids: readonly string[]): string[] {
  return Array.from(new Set(ids))
}

function isLikelyAbbreviatedBenchMemoryId(value: string): boolean {
  return /^[0-9a-f]{4,31}$/iu.test(value.trim())
}

function parseBenchMemoryHandle(value: string): number | null {
  const trimmed = value.trim()
  const match = /^m([1-9]\d*)$/iu.exec(trimmed)
  if (!match) return null
  return Number.parseInt(match[1]!, 10) - 1
}

async function assignBenchMemoryHandles(
  memories: readonly Memory[],
  env: NodeJS.ProcessEnv
): Promise<BenchMemoryHandleMap> {
  const handles = await readBenchMemoryHandleMap(env)
  for (const memory of memories) {
    if (handles.has(memory.id)) continue
    handles.set(memory.id, `m${handles.size + 1}`)
  }
  return handles
}

async function readBenchMemoryHandleMap(
  env: NodeJS.ProcessEnv
): Promise<BenchMemoryHandleMap> {
  const handles: BenchMemoryHandleMap = new Map()
  const traceFile = env[BENCH_TOOL_TRACE_ENV]
  if (!traceFile) return handles
  let raw: string
  try {
    raw = await readFile(traceFile, "utf-8")
  } catch {
    return handles
  }
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  for (const line of lines) {
    try {
      const call = JSON.parse(line) as Partial<BenchRetrievalCall>
      if (
        call.tool === "lore-query" &&
        call.status === "success" &&
        Array.isArray(call.surfacedMemoryIds) &&
        call.surfacedMemoryIds.every((id) => typeof id === "string")
      ) {
        for (const id of call.surfacedMemoryIds) {
          if (handles.has(id)) continue
          handles.set(id, `m${handles.size + 1}`)
        }
      }
    } catch {
      continue
    }
  }
  return handles
}

async function readLatestBenchMemorySurface(
  env: NodeJS.ProcessEnv
): Promise<string[] | null> {
  const traceFile = env[BENCH_TOOL_TRACE_ENV]
  if (!traceFile) return null
  let raw: string
  try {
    raw = await readFile(traceFile, "utf-8")
  } catch {
    return null
  }
  const lines = raw
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const call = JSON.parse(lines[index]!) as Partial<BenchRetrievalCall>
      if (
        call.tool === "lore-query" &&
        call.status === "success" &&
        Array.isArray(call.surfacedMemoryIds) &&
        call.surfacedMemoryIds.every((id) => typeof id === "string")
      ) {
        return call.surfacedMemoryIds
      }
    } catch {
      continue
    }
  }
  return null
}

function memoryIdForBenchHandle(
  handles: BenchMemoryHandleMap,
  handle: string
): string | null {
  const normalized = handle.toLowerCase()
  for (const [memoryId, mappedHandle] of handles.entries()) {
    if (mappedHandle.toLowerCase() === normalized) return memoryId
  }
  return null
}

function benchProjectId(env: NodeJS.ProcessEnv): string | undefined {
  const value = env[BENCH_TOOL_PROJECT_ID_ENV]
  return value && value.trim().length > 0 ? value.trim() : undefined
}

function requiredBenchProjectId(env: NodeJS.ProcessEnv): string {
  const value = benchProjectId(env)
  if (!value) {
    throw new Error(`${BENCH_TOOL_PROJECT_ID_ENV} is required for bench retrieval`)
  }
  return value
}

function benchToolRenderContext(env: NodeJS.ProcessEnv): BenchToolRenderContext {
  const projectName = env[BENCH_TOOL_PROJECT_NAME_ENV] ?? ""
  return { skillRet: /\bskillret\b/iu.test(projectName) }
}

function filterBenchProjectMemories(
  memories: readonly Memory[],
  projectId: string
): Memory[] {
  return memories.filter((memory) => memory.projectIds.includes(projectId))
}

function renderBenchSearch(
  query: string,
  memories: readonly Memory[],
  includeContent: boolean,
  handles: BenchMemoryHandleMap,
  context: BenchToolRenderContext
): string {
  if (memories.length === 0) return `No memories found for: "${query}"`
  return [
    `Found ${memories.length} memories for "${query}":`,
    "",
    memories
      .map((memory) =>
        renderBenchMemoryListItem(memory, includeContent, handles, context)
      )
      .join("\n\n---\n\n"),
    includeContent ? "" : benchMemoryExpansionHint(context),
  ].join("\n")
}

function renderBenchRecall(
  memories: readonly Memory[],
  includeContent: boolean,
  handles: BenchMemoryHandleMap,
  context: BenchToolRenderContext
): string {
  if (memories.length === 0) return "No recent memories found."
  return [
    `${memories.length} recent memories:`,
    "",
    memories
      .map((memory) =>
        renderBenchMemoryListItem(memory, includeContent, handles, context)
      )
      .join("\n\n---\n\n"),
    includeContent ? "" : benchMemoryExpansionHint(context),
  ].join("\n")
}

function benchMemoryExpansionHint(context?: BenchToolRenderContext): string {
  if (context?.skillRet) {
    return "\nBodies omitted. Compare Skill Name, Short Summary, and SkillRet Tags, then run `lore-memory action=expand ids=latest` for the latest result set, `ids=m1` for a listed handle, or pass complete IDs copied exactly."
  }
  return "\nBodies omitted. Run `lore-memory action=expand ids=latest` for the latest result set, `ids=m1` for a listed handle, or pass complete IDs copied exactly."
}

function renderBenchMemoryListItem(
  memory: Memory,
  includeContent: boolean,
  handles: BenchMemoryHandleMap,
  context: BenchToolRenderContext
): string {
  if (isSkillRetMemory(memory, context)) {
    return renderBenchSkillRetMemoryListItem(memory, includeContent, handles)
  }
  const handle = handles.get(memory.id)
  const meta = [
    handle ? `Handle: ${handle}` : null,
    `ID: ${memory.id}`,
    memory.source,
    memory.kind !== "note" ? memory.kind : null,
    memory.status !== "informational" ? memory.status : null,
    memory.updatedAt.split("T")[0],
  ]
    .filter((part): part is string => part !== null)
    .join(" | ")
  const synopsis = memory.synopsis.trim() ? `\n${memory.synopsis}` : ""
  const body = includeContent && memory.content ? `\n\n${memory.content}` : ""
  return `### ${memory.title}\n*${meta}*${synopsis}${body}`
}

function renderBenchSkillRetMemoryListItem(
  memory: Memory,
  includeContent: boolean,
  handles: BenchMemoryHandleMap
): string {
  const handle = handles.get(memory.id)
  const tags = benchMemoryTags(memory).filter((tag) => tag.trim().length > 0)
  const keywords = benchMemoryKeywords(memory)
  const meta = [
    handle ? `Handle: ${handle}` : null,
    `Memory ID: ${memory.id}`,
    memory.source,
    memory.kind !== "procedure" ? memory.kind : null,
    memory.status !== "informational" ? memory.status : null,
    memory.updatedAt.split("T")[0],
  ]
    .filter((part): part is string => part !== null)
    .join(" | ")
  const lines = [
    `### Skill Candidate: ${memory.title}`,
    `*${meta}*`,
    `Skill Name: ${memory.title}`,
    `Short Summary: ${memory.synopsis.trim() || "No short summary available."}`,
  ]
  if (tags.length > 0) lines.push(`SkillRet Tags: ${tags.join(", ")}`)
  if (keywords.length > 0) {
    lines.push(`SkillRet Search Keys: ${keywords}`)
  }
  const body = includeContent && memory.content ? `\n\n${memory.content}` : ""
  return `${lines.join("\n")}${body}`
}

function isSkillRetMemory(memory: Memory, context: BenchToolRenderContext): boolean {
  if (context.skillRet) return true
  if (benchMemoryTags(memory).some((tag) => tag.toLowerCase() === "skillret")) {
    return true
  }
  return /\bskillret\b/iu.test(benchMemoryKeywords(memory))
}

function benchMemoryTags(memory: Memory): string[] {
  return Array.isArray(memory.tags) ? memory.tags : []
}

function benchMemoryKeywords(memory: Memory): string {
  return typeof memory.keywords === "string" ? memory.keywords.trim() : ""
}

function renderBenchExpandedMemories(memories: readonly Memory[]): string {
  if (memories.length === 0) return "Expanded 0 memories."
  const label = memories.length === 1 ? "memory" : "memories"
  return [
    `Expanded ${memories.length} ${label}:`,
    "",
    memories.map(renderBenchExpandedMemory).join("\n\n---\n\n"),
  ].join("\n")
}

function renderBenchExpandedMemory(memory: Memory): string {
  const meta = [
    `ID: ${memory.id}`,
    memory.source,
    memory.kind !== "note" ? memory.kind : null,
    memory.status !== "informational" ? memory.status : null,
    memory.updatedAt.split("T")[0],
  ]
    .filter((part): part is string => part !== null)
    .join(" | ")
  const body = memory.content ? `\n\n${memory.content}` : ""
  return `### ${memory.title}\n*${meta}*${body}`
}

async function appendBenchToolTrace(
  env: NodeJS.ProcessEnv,
  call: BenchRetrievalCall
): Promise<void> {
  const traceFile = env[BENCH_TOOL_TRACE_ENV]
  if (!traceFile) return
  await appendFile(traceFile, `${JSON.stringify(call)}\n`, "utf-8")
}

async function prepareBenchToolRuntimeEnv(
  env: NodeJS.ProcessEnv
): Promise<NodeJS.ProcessEnv> {
  const out: NodeJS.ProcessEnv = { ...env }
  delete out["LORE_MCP_WRITE_BUDGET"]
  delete out["LORE_MCP_BUDGET_STATE_FILE"]
  if (out["NOTION_API_TOKEN"]?.trim() && out["LORE_CONFIG_ROOT"]?.trim()) return out
  const configPath = await findBenchCodexConfigPath(out)
  if (!configPath) return out
  const parsed = parseBenchCodexMcpEnv(await readFile(configPath, "utf-8"))
  for (const key of BENCH_TOOL_RUNTIME_ENV_KEYS) {
    if (!out[key]?.trim() && parsed[key]) out[key] = parsed[key]
  }
  return out
}

async function findBenchCodexConfigPath(env: NodeJS.ProcessEnv): Promise<string | null> {
  const candidates = new Set<string>()
  const traceFile = env[BENCH_TOOL_TRACE_ENV]
  if (traceFile?.trim()) {
    candidates.add(join(dirname(resolve(traceFile)), ".codex", "config.toml"))
  }
  let dir = resolve(process.cwd())
  while (true) {
    candidates.add(join(dir, ".codex", "config.toml"))
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  for (const path of candidates) {
    try {
      await access(path)
      return path
    } catch {
      // Try the next candidate.
    }
  }
  return null
}

function parseBenchCodexMcpEnv(toml: string): Record<string, string> {
  const out: Record<string, string> = {}
  let inEnv = false
  for (const line of toml.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue
    const section = /^\[([^\]]+)\]$/u.exec(trimmed)
    if (section) {
      inEnv = section[1] === "mcp_servers.lore.env"
      continue
    }
    if (!inEnv) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"((?:\\.|[^"\\])*)"\s*$/u.exec(trimmed)
    if (!match) continue
    out[match[1]!] = unescapeTomlDoubleQuotedString(match[2]!)
  }
  return out
}

function unescapeTomlDoubleQuotedString(value: string): string {
  let out = ""
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!
    if (char !== "\\" || i + 1 >= value.length) {
      out += char
      continue
    }
    i += 1
    out += value[i]!
  }
  return out
}

async function withBenchToolProcessEnv<T>(
  env: NodeJS.ProcessEnv,
  fn: () => Promise<T>
): Promise<T> {
  const previous: Record<string, string | undefined> = {}
  for (const key of BENCH_TOOL_PROCESS_ENV_KEYS) {
    previous[key] = process.env[key]
    const value = env[key]
    if (value !== undefined) process.env[key] = value
    else delete process.env[key]
  }
  try {
    return await fn()
  } finally {
    for (const key of BENCH_TOOL_PROCESS_ENV_KEYS) {
      const value = previous[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const BENCH_TOOL_RUNTIME_ENV_KEYS = [
  "NOTION_API_TOKEN",
  "LORE_CONFIG_ROOT",
  "LORE_NOTION_BASE_URL",
  "NOTION_WORKSPACE_ID",
  "NOTION_ENV",
  "NOTION_BASE_URL",
  "NOTION_API_BASE_URL",
  "LORE_USER_NAME",
] as const

const BENCH_TOOL_PROCESS_ENV_KEYS = [
  ...BENCH_TOOL_RUNTIME_ENV_KEYS,
  "LORE_MCP_WRITE_BUDGET",
  "LORE_MCP_BUDGET_STATE_FILE",
] as const
