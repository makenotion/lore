import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml } from "yaml"

export const PROFILE_EXTENDS_RESERVED_MESSAGE =
  "profile.yaml extends is reserved for profile composition (#577) and is not supported yet."

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
const PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const PROFILE_SELECTOR_PATTERN =
  /^([a-z0-9]+(?:-[a-z0-9]+)*)@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/

const DATABASE_KEYS = ["projects", "topics", "memories", "entities", "facts"] as const
export type ProfileDatabaseKey = (typeof DATABASE_KEYS)[number]

export type ProfileSource = "built-in" | "local" | "external"

export interface ProfileManifest {
  name: string
  version: string
  taxonomy?: string
  schema?: string
  prompts?: Partial<Record<ProfilePromptKey, string>>
}

export interface ResolvedProfileTaxonomy {
  tags: string[]
  entityKinds: string[]
  writableFactPredicates: string[]
}

export type ResolvedProfileSchema = Record<
  ProfileDatabaseKey,
  Record<string, Record<string, unknown>>
>

export const PROFILE_PROMPT_KEYS = [
  "autosaveExtractionFilter",
  "autosaveToolGuidance",
  "atomicLearningExtraction",
  "digestSynthesis",
  "conflictJudge",
  "longmemevalSimulatedAutosave",
] as const

export type ProfilePromptKey = (typeof PROFILE_PROMPT_KEYS)[number]

export interface ResolvedPrompt {
  key: ProfilePromptKey
  text: string
  source: "active-profile" | "core-default"
  path: string
}

export type ResolvedPromptRegistry = Record<ProfilePromptKey, ResolvedPrompt>

export interface ResolvedProfile {
  selector: string
  name: string
  version: string
  source: ProfileSource
  rootDir: string
  manifestDigest: string
  manifest: ProfileManifest
  taxonomy: ResolvedProfileTaxonomy
  prompts: ResolvedPromptRegistry
  schema: ResolvedProfileSchema
}

export interface ParsedProfileSelector {
  name: string
  version: string
  selector: string
}

export class ProfileLoadError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProfileLoadError"
  }
}

const CORE_GENERIC_FACT_PREDICATES = ["is_a", "has_a", "related_to"] as const

export const GENERIC_FACT_PREDICATES: readonly string[] = CORE_GENERIC_FACT_PREDICATES

export const RESERVED_FACT_PREDICATES: readonly string[] = [
  "mentions",
  "decided_by",
  "supersedes_decision",
  "informs",
  "needs_action",
  "waiting_on",
  "blocked_by",
]

const INTERNAL_FACT_PREDICATE_OPTIONS: readonly string[] = [
  "needs_action",
  "waiting_on",
  "blocked_by",
  "decided_by",
  "supersedes_decision",
  "informs",
  "mentions",
]

const CORE_PROPERTY_NAMES: Record<ProfileDatabaseKey, readonly string[]> = {
  projects: ["Name", "Type", "Path", "Status", "Description"],
  topics: ["Name", "Project", "Description"],
  memories: [
    "Title",
    "Project",
    "Topic",
    "Source",
    "Kind",
    "Task State",
    "Blocked By",
    "Entity",
    "Status",
    "Confidence",
    "Confidence Score",
    "Topic Key",
    "Revision Count",
    "Compare Notes",
    "Review By",
    "Done At",
    "Decided At",
    "Last Referenced At",
    "Alternatives",
    "Consequences",
    "Author",
    "Agent",
    "Tags",
    "Keywords",
    "Synopsis",
    "Session",
    "Supersedes",
    "Affects",
    "Compared With",
    "Scope Kind",
    "Scope Key",
    "Audience",
    "Lifetime",
    "Expires At",
    "Pinned",
    "Pinned Priority",
    "Mutability",
  ],
  entities: ["Name", "Aliases", "Kind", "Description", "Project", "Source"],
  facts: [
    "Subject",
    "Predicate",
    "Object",
    "Project",
    "Source",
    "Confidence",
    "Confidence Score",
    "Valid From",
    "Valid Until",
    "Observed At",
    "Invalidated At",
    "Invalidated By",
    "Review By",
    "Last Referenced At",
    "DedupKey",
    "SubjectKey",
    "SubjectEntity",
    "ObjectEntity",
    "Scope Kind",
    "Scope Key",
    "Audience",
    "Lifetime",
    "Expires At",
  ],
}

const ADDITIVE_PROPERTY_TYPES = [
  "rich_text",
  "number",
  "select",
  "multi_select",
  "date",
  "checkbox",
  "url",
  "email",
  "phone_number",
] as const

const NOTION_COLORS = new Set([
  "default",
  "gray",
  "brown",
  "orange",
  "yellow",
  "green",
  "blue",
  "purple",
  "pink",
  "red",
])

const DEFAULT_TAGS = [
  "android",
  "api",
  "architecture",
  "audit",
  "backend",
  "bug",
  "build",
  "ci",
  "code-review",
  "concurrency",
  "config",
  "convention",
  "data-model",
  "db",
  "decision-context",
  "dependency",
  "deployment",
  "docs",
  "error-handling",
  "frontend",
  "gotcha",
  "incident",
  "infrastructure",
  "investigation",
  "ios",
  "migration",
  "observability",
  "onboarding",
  "performance",
  "policy",
  "postmortem",
  "refactor",
  "runbook",
  "security",
  "testing",
  "tooling",
  "ui",
  "ux",
  "web",
  "workflow",
]

const DEFAULT_ENTITY_KINDS = [
  "class",
  "function",
  "file",
  "workflow",
  "pr",
  "task-id",
  "person",
  "system",
]

const DEFAULT_WRITABLE_FACT_PREDICATES = [
  "uses",
  "depends_on",
  "created_by",
  "owned_by",
  "replaces",
  "extends",
  "conflicts_with",
]

const EMPTY_SCHEMA: ResolvedProfileSchema = {
  projects: {},
  topics: {},
  memories: {},
  entities: {},
  facts: {},
}

export function parseProfileSelector(selector: string): ParsedProfileSelector {
  const trimmed = selector.trim()
  const match = PROFILE_SELECTOR_PATTERN.exec(trimmed)
  if (!match) {
    throw new ProfileLoadError(
      `Invalid profile selector "${selector}". Expected exact <name>@<semver>, for example default@1.0.0.`
    )
  }
  return { name: match[1]!, version: match[2]!, selector: trimmed }
}

export function isProfileSelector(value: string): boolean {
  return PROFILE_SELECTOR_PATTERN.test(value.trim())
}

export function defaultProfileRoot(): string {
  return bundledProfileRoot("default")
}

export function defaultProfileSelector(): string {
  const manifest = readManifest(defaultProfileRoot())
  return `${manifest.name}@${manifest.version}`
}

export function bundledProfileRoot(name: string): string {
  return findBundledProfileRoot(name)
}

export function resolveProfileFromConfig(config: { profile?: string }): ResolvedProfile {
  const selector = config.profile ?? defaultProfileSelector()
  const parsed = parseProfileSelector(selector)
  let root: string
  try {
    root = bundledProfileRoot(parsed.name)
  } catch (err) {
    if (!(err instanceof ProfileLoadError)) throw err
    throw new ProfileLoadError(
      `Unknown built-in profile "${parsed.name}". Expected profiles/${parsed.name}/profile.yaml to exist in this Lore release.`
    )
  }
  return loadProfileFromRoot(root, { source: "built-in", selector: parsed.selector })
}

export function loadProfileFromRoot(
  rootDir: string,
  options: { source?: ProfileSource; selector?: string } = {}
): ResolvedProfile {
  const root = resolve(rootDir)
  const files = new Map<string, string>()
  const manifest = readManifest(root, files)
  const selector = options.selector ?? `${manifest.name}@${manifest.version}`
  const parsed = parseProfileSelector(selector)
  if (parsed.name !== manifest.name || parsed.version !== manifest.version) {
    throw new ProfileLoadError(
      `Profile selector ${selector} does not match ${join(root, "profile.yaml")} (${manifest.name}@${manifest.version}).`
    )
  }

  const taxonomy = loadTaxonomy(root, manifest, files)
  const schema = loadSchema(root, manifest, files)
  const prompts = loadPromptRegistry(root, manifest, files)

  return {
    selector,
    name: manifest.name,
    version: manifest.version,
    source: options.source ?? "local",
    rootDir: root,
    manifestDigest: computeManifestDigest(files),
    manifest,
    taxonomy,
    prompts,
    schema,
  }
}

export function profilePropertyAdditions(
  profileOrSchema: ResolvedProfile | ResolvedProfileSchema | undefined,
  key: ProfileDatabaseKey
): Record<string, Record<string, unknown>> {
  if (!profileOrSchema) return {}
  const schema = "schema" in profileOrSchema ? profileOrSchema.schema : profileOrSchema
  return schema[key] ?? {}
}

export function writableFactPredicates(profile: ResolvedProfile): string[] {
  return [...CORE_GENERIC_FACT_PREDICATES, ...profile.taxonomy.writableFactPredicates]
}

export function factPredicateSchemaOptions(profile: ResolvedProfile): string[] {
  return [
    ...CORE_GENERIC_FACT_PREDICATES,
    ...profile.taxonomy.writableFactPredicates,
    ...INTERNAL_FACT_PREDICATE_OPTIONS,
  ]
}

function findBundledProfileRoot(name: string): string {
  const start = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(start, "..", "profiles", name),
    join(start, "..", "..", "profiles", name),
    join(start, "..", "..", "..", "profiles", name),
  ]
  for (const candidate of candidates) {
    const profilePath = join(candidate, "profile.yaml")
    if (existsSync(profilePath)) return resolve(candidate)
  }
  throw new ProfileLoadError(
    `Cannot find built-in profile "${name}". Expected profiles/${name}/profile.yaml beside the package root.`
  )
}

function readManifest(rootDir: string, files?: Map<string, string>): ProfileManifest {
  const path = join(rootDir, "profile.yaml")
  const raw = readText(path)
  files?.set("profile.yaml", normalizeYamlForDigest(path, raw))
  const parsed = parseYamlFile(path, raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProfileLoadError(`${path}: profile.yaml must be a mapping.`)
  }
  const record = parsed as Record<string, unknown>
  if ("extends" in record) {
    throw new ProfileLoadError(`${path}: ${PROFILE_EXTENDS_RESERVED_MESSAGE}`)
  }
  const name = expectString(record["name"], `${path}: name`)
  const version = expectString(record["version"], `${path}: version`)
  if (!PROFILE_NAME_PATTERN.test(name)) {
    throw new ProfileLoadError(`${path}: name must be kebab-case, got "${name}".`)
  }
  if (!SEMVER_PATTERN.test(version)) {
    throw new ProfileLoadError(`${path}: version must be valid semver, got "${version}".`)
  }
  const promptsRaw = record["prompts"]
  const prompts: Partial<Record<ProfilePromptKey, string>> = {}
  if (promptsRaw !== undefined) {
    if (!promptsRaw || typeof promptsRaw !== "object" || Array.isArray(promptsRaw)) {
      throw new ProfileLoadError(`${path}: prompts must be a mapping.`)
    }
    for (const [key, value] of Object.entries(promptsRaw)) {
      if (!(PROFILE_PROMPT_KEYS as readonly string[]).includes(key)) {
        throw new ProfileLoadError(
          `${path}: prompts.${key} is not a supported prompt key.`
        )
      }
      prompts[key as ProfilePromptKey] = expectString(value, `${path}: prompts.${key}`)
    }
  }
  return {
    name,
    version,
    taxonomy:
      record["taxonomy"] === undefined
        ? undefined
        : expectString(record["taxonomy"], `${path}: taxonomy`),
    schema:
      record["schema"] === undefined
        ? undefined
        : expectString(record["schema"], `${path}: schema`),
    prompts,
  }
}

function loadTaxonomy(
  rootDir: string,
  manifest: ProfileManifest,
  files: Map<string, string>
): ResolvedProfileTaxonomy {
  if (!manifest.taxonomy) {
    return {
      tags: [...DEFAULT_TAGS],
      entityKinds: [...DEFAULT_ENTITY_KINDS],
      writableFactPredicates: [...DEFAULT_WRITABLE_FACT_PREDICATES],
    }
  }
  const rel = normalizeRelPath(manifest.taxonomy)
  const path = join(rootDir, rel)
  const raw = readText(path)
  files.set(rel, normalizeYamlForDigest(path, raw))
  const parsed = parseYamlFile(path, raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProfileLoadError(`${path}: taxonomy must be a mapping.`)
  }
  const record = parsed as Record<string, unknown>
  const taxonomy = {
    tags: readStringList(record["tags"], `${path}: tags`, DEFAULT_TAGS),
    entityKinds: readStringList(
      record["entityKinds"],
      `${path}: entityKinds`,
      DEFAULT_ENTITY_KINDS
    ),
    writableFactPredicates: readStringList(
      record["writableFactPredicates"],
      `${path}: writableFactPredicates`,
      DEFAULT_WRITABLE_FACT_PREDICATES
    ),
  }
  validateUniqueStrings(taxonomy.tags, `${path}: tags`)
  validateUniqueStrings(taxonomy.entityKinds, `${path}: entityKinds`)
  validateUniqueStrings(
    taxonomy.writableFactPredicates,
    `${path}: writableFactPredicates`
  )
  const reserved = new Set([...CORE_GENERIC_FACT_PREDICATES, ...RESERVED_FACT_PREDICATES])
  for (const predicate of taxonomy.writableFactPredicates) {
    if (reserved.has(predicate)) {
      throw new ProfileLoadError(
        `${path}: writableFactPredicates cannot include reserved/core predicate "${predicate}".`
      )
    }
  }
  return taxonomy
}

function loadSchema(
  rootDir: string,
  manifest: ProfileManifest,
  files: Map<string, string>
): ResolvedProfileSchema {
  if (!manifest.schema) return cloneSchema(EMPTY_SCHEMA)
  const rel = normalizeRelPath(manifest.schema)
  const path = join(rootDir, rel)
  const raw = readText(path)
  files.set(rel, normalizeYamlForDigest(path, raw))
  const parsed = parseYamlFile(path, raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProfileLoadError(`${path}: schema must be a mapping.`)
  }
  const databases = (parsed as Record<string, unknown>)["databases"]
  if (!databases || typeof databases !== "object" || Array.isArray(databases)) {
    throw new ProfileLoadError(`${path}: databases must be a mapping.`)
  }
  const out = cloneSchema(EMPTY_SCHEMA)
  for (const key of DATABASE_KEYS) {
    const db = (databases as Record<string, unknown>)[key]
    if (db === undefined) continue
    if (!db || typeof db !== "object" || Array.isArray(db)) {
      throw new ProfileLoadError(`${path}: databases.${key} must be a mapping.`)
    }
    const properties = (db as Record<string, unknown>)["properties"] ?? {}
    if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
      throw new ProfileLoadError(
        `${path}: databases.${key}.properties must be a mapping.`
      )
    }
    for (const [propertyName, config] of Object.entries(
      properties as Record<string, unknown>
    )) {
      if (CORE_PROPERTY_NAMES[key].includes(propertyName)) {
        throw new ProfileLoadError(
          `${path}: databases.${key}.properties.${propertyName} cannot override a core property.`
        )
      }
      validateAdditivePropertyConfig(
        config,
        `${path}: databases.${key}.properties.${propertyName}`
      )
      out[key][propertyName] = config as Record<string, unknown>
    }
  }
  return out
}

function loadPromptRegistry(
  rootDir: string,
  manifest: ProfileManifest,
  files: Map<string, string>
): ResolvedPromptRegistry {
  const defaultRoot = defaultProfileRoot()
  const out = {} as ResolvedPromptRegistry
  for (const key of PROFILE_PROMPT_KEYS) {
    const activeRel = manifest.prompts?.[key]
    const fallbackRel = readManifest(defaultRoot).prompts?.[key]
    const rel = activeRel ?? fallbackRel
    if (!rel) {
      throw new ProfileLoadError(
        `${join(rootDir, "profile.yaml")}: prompts.${key} is required and has no default fallback.`
      )
    }
    const ownerRoot = activeRel ? rootDir : defaultRoot
    const normalizedRel = normalizeRelPath(rel)
    const path = join(ownerRoot, normalizedRel)
    const text = normalizeText(readText(path))
    files.set(activeRel ? normalizedRel : `core-default/${key}:${normalizedRel}`, text)
    validatePromptVariables(key, text, path)
    out[key] = {
      key,
      text,
      source: activeRel ? "active-profile" : "core-default",
      path,
    }
  }
  return out
}

function validateAdditivePropertyConfig(config: unknown, path: string): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ProfileLoadError(`${path} must be a property config mapping.`)
  }
  const keys = Object.keys(config)
  const declared = keys.filter((key) =>
    (ADDITIVE_PROPERTY_TYPES as readonly string[]).includes(key)
  )
  if (declared.length !== 1 || keys.length !== 1) {
    const got = keys.length > 0 ? keys.join(", ") : "<empty>"
    throw new ProfileLoadError(
      `${path} must declare exactly one supported additive property type; got ${got}.`
    )
  }
  const type = declared[0]!
  const value = (config as Record<string, unknown>)[type]
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfileLoadError(`${path}.${type} must be a mapping.`)
  }
  if (type === "number") {
    const format = (value as Record<string, unknown>)["format"]
    if (format !== undefined && format !== "number") {
      throw new ProfileLoadError(`${path}.number.format supports only "number".`)
    }
  }
  if (type === "select" || type === "multi_select") {
    validateSelectOptions(value, `${path}.${type}`)
  }
}

function validateSelectOptions(config: unknown, path: string): void {
  const options = (config as Record<string, unknown>)["options"]
  if (!Array.isArray(options)) return
  const seen = new Set<string>()
  for (let i = 0; i < options.length; i += 1) {
    const option = options[i]
    const optionPath = `${path}.options[${i}]`
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      throw new ProfileLoadError(`${optionPath} must be a mapping.`)
    }
    const name = expectString(
      (option as Record<string, unknown>)["name"],
      `${optionPath}.name`
    )
    if (seen.has(name)) {
      throw new ProfileLoadError(`${optionPath}.name duplicates "${name}".`)
    }
    seen.add(name)
    const color = (option as Record<string, unknown>)["color"]
    if (color !== undefined && (typeof color !== "string" || !NOTION_COLORS.has(color))) {
      throw new ProfileLoadError(`${optionPath}.color is not a supported Notion color.`)
    }
  }
}

function validatePromptVariables(
  key: ProfilePromptKey,
  text: string,
  path: string
): void {
  const allowlist: Record<ProfilePromptKey, readonly string[]> = {
    autosaveExtractionFilter: [],
    autosaveToolGuidance: [],
    atomicLearningExtraction: ["limit", "statusLine"],
    digestSynthesis: [],
    conflictJudge: [
      "memoryAProject",
      "memoryAKind",
      "memoryATitle",
      "memoryABody",
      "memoryBProject",
      "memoryBKind",
      "memoryBTitle",
      "memoryBBody",
    ],
    longmemevalSimulatedAutosave: [],
  }
  const allowed = new Set(allowlist[key])
  const re = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g
  for (const match of text.matchAll(re)) {
    const variable = match[1]!
    if (!allowed.has(variable)) {
      throw new ProfileLoadError(
        `${path}: prompts.${key} references unsupported variable "{{${variable}}}".`
      )
    }
  }
}

function computeManifestDigest(files: Map<string, string>): string {
  const hash = createHash("sha256")
  for (const [rel, content] of [...files.entries()].sort(([a], [b]) =>
    a.localeCompare(b)
  )) {
    hash.update(rel)
    hash.update("\0")
    hash.update(content)
    hash.update("\0")
  }
  return `sha256:${hash.digest("hex")}`
}

function readStringList(
  value: unknown,
  path: string,
  fallback: readonly string[]
): string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value)) {
    throw new ProfileLoadError(`${path} must be a list of strings.`)
  }
  return value.map((item, index) => expectString(item, `${path}[${index}]`))
}

function validateUniqueStrings(values: readonly string[], path: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (value.trim().length === 0) {
      throw new ProfileLoadError(`${path} cannot contain an empty string.`)
    }
    if (seen.has(value)) {
      throw new ProfileLoadError(`${path} contains duplicate value "${value}".`)
    }
    seen.add(value)
  }
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProfileLoadError(`${path} must be a non-empty string.`)
  }
  return value.trim()
}

function normalizeRelPath(rel: string): string {
  if (rel.startsWith("/") || rel.split(/[\\/]/).includes("..")) {
    throw new ProfileLoadError(
      `Profile file path must be relative within the profile root: ${rel}`
    )
  }
  return rel.replace(/\\/g, "/")
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf-8")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ProfileLoadError(`Failed to read ${path}: ${message}`)
  }
}

function parseYamlFile(path: string, raw: string): unknown {
  try {
    return parseYaml(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ProfileLoadError(`Failed to parse ${path}: ${message}`)
  }
}

function normalizeYamlForDigest(path: string, raw: string): string {
  return stableStringify(parseYamlFile(path, raw))
}

function normalizeText(raw: string): string {
  return raw.replace(/\r\n?/g, "\n").trimEnd()
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((child) => stableStringify(child)).join(",")}]`
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`
      )
      .join(",")}}`
  }
  return JSON.stringify(value)
}

function cloneSchema(schema: ResolvedProfileSchema): ResolvedProfileSchema {
  return {
    projects: { ...schema.projects },
    topics: { ...schema.topics },
    memories: { ...schema.memories },
    entities: { ...schema.entities },
    facts: { ...schema.facts },
  }
}
