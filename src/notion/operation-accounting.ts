import type { Client } from "@notionhq/client"
import {
  recordNotionFailure,
  recordNotionRead,
  recordNotionWrite,
} from "../core/cost-accounting.js"

type OperationKind = "read" | "write" | "unknown"

const READ_PATHS = new Set([
  "search",
  "users.me",
  "users.list",
  "pages.retrieve",
  "pages.retrieveMarkdown",
  "pages.properties.retrieve",
  "dataSources.retrieve",
  "dataSources.query",
  "databases.retrieve",
  "blocks.children.list",
])

const WRITE_PATHS = new Set([
  "pages.create",
  "pages.update",
  "pages.updateMarkdown",
  "dataSources.update",
  "databases.create",
  "blocks.children.append",
])

const RUNTOOL_READ_TOOLS = new Set(["query_data_sources", "search"])
const RUNTOOL_WRITE_TOOLS = new Set(["create_pages", "update_page", "update_content"])

export function classifyNotionOperation(path: string, args: unknown[]): OperationKind {
  if (path === "request") return classifyRequest(args[0])
  if (READ_PATHS.has(path)) return "read"
  if (WRITE_PATHS.has(path)) return "write"
  const last = path.split(".").pop()
  if (last === "retrieve" || last === "list" || last === "query") return "read"
  if (last === "create" || last === "update" || last === "delete" || last === "append") {
    return "write"
  }
  return "unknown"
}

function classifyRequest(arg: unknown): OperationKind {
  if (!arg || typeof arg !== "object") return "unknown"
  const record = arg as Record<string, unknown>
  const body = record["body"]
  if (body && typeof body === "object") {
    const tool = runToolName(body as Record<string, unknown>)
    if (RUNTOOL_READ_TOOLS.has(tool)) return "read"
    if (RUNTOOL_WRITE_TOOLS.has(tool)) return "write"
  }
  const method = typeof record["method"] === "string" ? record["method"] : undefined
  if (!method) return "unknown"
  const normalizedMethod = method.toUpperCase()
  if (normalizedMethod === "GET") return "read"
  if (
    normalizedMethod === "POST" ||
    normalizedMethod === "PATCH" ||
    normalizedMethod === "DELETE"
  ) {
    return "write"
  }
  return "unknown"
}

function runToolName(body: Record<string, unknown>): string {
  const type = body["type"]
  if (typeof type === "string") return type
  const tool = body["tool"]
  if (typeof tool === "string") return tool
  for (const key of Object.keys(body)) {
    if (RUNTOOL_READ_TOOLS.has(key) || RUNTOOL_WRITE_TOOLS.has(key)) return key
  }
  return ""
}

export function createOperationAccountingClient(client: Client): Client {
  const seen = new WeakMap<object, object>()

  const wrapLevel = <T extends object>(obj: T, path: string): T => {
    const cached = seen.get(obj)
    if (cached) return cached as T

    const wrapped = new Proxy(obj, {
      get(target, prop, receiver) {
        if (typeof prop === "symbol") {
          return Reflect.get(target, prop, receiver)
        }
        const value = Reflect.get(target, prop, receiver)
        const nextPath = path === "" ? prop : `${path}.${prop}`
        if (typeof value === "function") {
          return async (...args: unknown[]): Promise<unknown> => {
            const kind = classifyNotionOperation(nextPath, args)
            try {
              const result = await (value as (...inner: unknown[]) => unknown).apply(
                target,
                args
              )
              if (kind === "read") recordNotionRead()
              if (kind === "write") recordNotionWrite()
              return result
            } catch (err) {
              if (kind !== "unknown") recordNotionFailure()
              throw err
            }
          }
        }
        if (typeof value === "object" && value !== null) {
          return wrapLevel(value as object, nextPath)
        }
        return value
      },
    })

    seen.set(obj, wrapped)
    return wrapped
  }

  return wrapLevel(client, "")
}
