import { access } from "node:fs/promises"
import { resolve } from "node:path"
import type { Readable } from "node:stream"
import { findConfigFile, loadConfig } from "../../config.js"
import {
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import { resolveProfileFromConfigAtRoot } from "../../profile/index.js"
import type { LoreServices } from "../../services.js"
import { TAG_VOCABULARY } from "../../types.js"
import type { CliParseResult } from "../parse.js"

export const PROJECT_LIST_HINT = "run `lore status projects` to list configured projects"
export const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/
export const YMD_HINT = "must be YYYY-MM-DD"

export interface TextSource {
  kind: "inline" | "file" | "stdin"
  value: string
}

export function parseTextSource(
  raw: { inline?: string; file?: string },
  labels: { inlineFlag: string; fileFlag: string }
): CliParseResult<TextSource> {
  const hasInline = raw.inline !== undefined
  const hasFile = raw.file !== undefined
  if (hasInline === hasFile) {
    return {
      ok: false,
      message: `Pass exactly one of ${labels.inlineFlag} or ${labels.fileFlag}`,
    }
  }
  if (hasInline) {
    return { ok: true, value: { kind: "inline", value: raw.inline ?? "" } }
  }
  const file = raw.file ?? ""
  if (!file.trim()) {
    return { ok: false, message: `${labels.fileFlag} must be a non-empty path` }
  }
  return {
    ok: true,
    value: file === "-" ? { kind: "stdin", value: "-" } : { kind: "file", value: file },
  }
}

export async function readTextSource(
  source: TextSource,
  stdin: Readable = process.stdin
): Promise<string> {
  if (source.kind === "inline") return source.value
  if (source.kind === "stdin") return readStdin(stdin)
  const { readFile } = await import("node:fs/promises")
  return readFile(source.value, "utf8")
}

async function readStdin(stdin: Readable): Promise<string> {
  stdin.setEncoding("utf8")
  let out = ""
  for await (const chunk of stdin) {
    out += chunk
  }
  return out
}

export function validateNonBlank(raw: string, label: string): CliParseResult<string> {
  if (!raw.trim()) {
    return { ok: false, message: `${label} must be a non-empty string` }
  }
  return { ok: true, value: raw }
}

export function validateYmd(
  raw: string | undefined,
  flag: string
): CliParseResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (!YMD_REGEX.test(raw)) {
    return { ok: false, message: `${flag} ${YMD_HINT}, got "${raw}"` }
  }
  return { ok: true, value: raw }
}

export function validateChoice<T extends string>(
  raw: string | undefined,
  flag: string,
  allowed: readonly T[]
): CliParseResult<T | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (!(allowed as readonly string[]).includes(raw)) {
    return {
      ok: false,
      message: `${flag} must be one of ${allowed.join(" | ")}, got "${raw}"`,
    }
  }
  return { ok: true, value: raw as T }
}

export function parseCsvList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  const values = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
  return values.length > 0 ? values : undefined
}

export function parseTagsList(
  raw: string | undefined,
  flag: string,
  vocabulary: readonly string[] = TAG_VOCABULARY
): CliParseResult<string[] | undefined> {
  const tags = parseCsvList(raw)
  if (tags === undefined) return { ok: true, value: undefined }
  const vocab = new Set<string>(vocabulary)
  const invalid = tags.filter((tag) => !vocab.has(tag))
  if (invalid.length > 0) {
    const quoted = invalid.map((tag) => `"${tag}"`).join(", ")
    return {
      ok: false,
      message:
        `${flag} value${invalid.length === 1 ? "" : "s"} ${quoted} not in the closed tag vocabulary. ` +
        `Accepted tags: ${vocabulary.join(", ")}. ` +
        "For free-form labels (PR numbers, ticket IDs, file paths, class/function names), use --keywords instead.",
    }
  }
  return { ok: true, value: tags }
}

export async function loadActiveTagVocabularyForCli(): Promise<readonly string[]> {
  const rawRoot = process.env["LORE_CONFIG_ROOT"]
  const explicitRoot = rawRoot?.trim() ? rawRoot.trim() : undefined
  let configPath: string
  let configRoot: string
  if (explicitRoot) {
    const root = resolve(explicitRoot)
    configRoot = root
    configPath = resolve(root, ".lore.yaml")
    try {
      await access(configPath)
    } catch {
      throw new Error(
        `LORE_CONFIG_ROOT=${root} but no .lore.yaml exists there. ` +
          "Re-run `lore install` from the project directory or unset " +
          "LORE_CONFIG_ROOT to fall back to the upward search."
      )
    }
  } else {
    const found = await findConfigFile(process.cwd())
    if (!found) return TAG_VOCABULARY
    configPath = found.path
    configRoot = found.root
  }
  const config = await loadConfig(configPath)
  return resolveProfileFromConfigAtRoot(config, configRoot).taxonomy.tags
}

export async function resolveProjectIdForCli(
  services: LoreServices,
  projectName: string | undefined,
  flag = "--project"
): Promise<{ projectId: string | undefined; projectLabel: string }> {
  const explicit = validateExplicitProjectScopeName(projectName, flag, {
    listHint: PROJECT_LIST_HINT,
  })
  if (explicit !== undefined) {
    const found = await resolveProjectScopeName(services.projects, explicit, flag, {
      listHint: PROJECT_LIST_HINT,
    })
    return { projectId: found.id, projectLabel: found.name }
  }
  if (services.context.project) {
    return {
      projectId: services.context.project.id,
      projectLabel: services.context.project.name,
    }
  }
  return { projectId: undefined, projectLabel: "none (repo-wide)" }
}
