/**
 * Phase 3 profile migration DSL and runner.
 *
 * A migration file lives at:
 *
 *   `<sourceProfileRoot>/migrations/<from>__<to>.yaml`
 *
 * and declares a sequence of step kinds chosen from the Phase 3
 * allow-list:
 *
 *   - `add_property` — add an additive Notion property to one of the
 *     five core data sources
 *   - `add_select_options` — append options to an existing select column
 *   - `add_multi_select_options` — append options to an existing
 *     multi_select column
 *   - `write_config_profile_pin` — rewrite the `profile:` selector in
 *     `.lore.yaml`
 *   - `backfill_empty_property` — write a literal value to empty cells
 *     that match a bounded filter (capped at 500 rows per run)
 *
 * Apply mode is dry-run by default. `--apply` requires the migration
 * lock and writes a per-vault ledger to
 *
 *   `<configRoot>/.lore/profile-migrations/<safe-profile-name>/<from>__<to>.<vault-page-sha12>.json`
 *
 * Idempotency: every step is re-checked against live Notion state at
 * the start of apply. A step whose effect is already visible is skipped
 * without writes. The config-pin write is always last so a partial
 * failure leaves the operator on the source pin.
 */

import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, join, resolve } from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import type { Client } from "@notionhq/client"

import {
  PROFILE_MIGRATIONS_LEDGER_REL,
  ProfileLoadError,
  RESERVED_FACT_PREDICATES,
  loadProfileFromRoot,
  parseProfileSelector,
  resolveProfileSelector,
  type ResolvedProfile,
} from "./index.js"
import type { LoreServices } from "../services.js"

export const PROFILE_MIGRATION_STEP_KINDS = [
  "add_property",
  "add_select_options",
  "add_multi_select_options",
  "write_config_profile_pin",
  "backfill_empty_property",
] as const

export type ProfileMigrationStepKind = (typeof PROFILE_MIGRATION_STEP_KINDS)[number]

/** Step kinds that Phase 3 validation rejects up-front. */
export const REJECTED_PROFILE_MIGRATION_STEP_KINDS = [
  "delete_property",
  "remove_property",
  "rename_property",
  "replace_select_options",
  "remove_select_options",
  "archive_pages",
  "delete_pages",
  "overwrite_property",
  "add_profile_prompt",
  "add_taxonomy_values",
  "edit_profile_files",
  "run_shell",
  "run_js",
] as const

const PROFILE_MIGRATION_DATABASE_KEYS = [
  "projects",
  "topics",
  "memories",
  "entities",
  "facts",
] as const
type ProfileMigrationDatabaseKey = (typeof PROFILE_MIGRATION_DATABASE_KEYS)[number]

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

export const BACKFILL_ROW_LIMIT_CAP = 500

const PROFILE_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

const RESERVED_PROFILE_MIGRATION_PROPERTY_NAMES: Record<
  ProfileMigrationDatabaseKey,
  readonly string[]
> = {
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

export class ProfileMigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProfileMigrationError"
  }
}

export interface ProfileMigrationStepBase {
  id: string
  kind: ProfileMigrationStepKind
  dryRunSummary?: string
  /** Optional; explicitly set false is required when present. */
  destructive?: boolean
}

export interface AddPropertyStep extends ProfileMigrationStepBase {
  kind: "add_property"
  database: ProfileMigrationDatabaseKey
  property: string
  config: Record<string, unknown>
}

export interface AddSelectOptionsStep extends ProfileMigrationStepBase {
  kind: "add_select_options"
  database: ProfileMigrationDatabaseKey
  property: string
  options: Array<{ name: string; color?: string }>
}

export interface AddMultiSelectOptionsStep extends ProfileMigrationStepBase {
  kind: "add_multi_select_options"
  database: ProfileMigrationDatabaseKey
  property: string
  options: Array<{ name: string; color?: string }>
}

export interface WriteConfigProfilePinStep extends ProfileMigrationStepBase {
  kind: "write_config_profile_pin"
  selector: string
}

export interface BackfillEmptyPropertyStep extends ProfileMigrationStepBase {
  kind: "backfill_empty_property"
  database: ProfileMigrationDatabaseKey
  property: string
  value: Record<string, unknown>
  filter: Record<string, unknown>
  limit: number
}

export type ProfileMigrationStep =
  | AddPropertyStep
  | AddSelectOptionsStep
  | AddMultiSelectOptionsStep
  | WriteConfigProfilePinStep
  | BackfillEmptyPropertyStep

export interface ProfileMigrationDocument {
  profile: string
  from: string
  to: string
  steps: ProfileMigrationStep[]
}

export type ProfileMigrationPlanStatus =
  | "would-run"
  | "skip-already-satisfied"
  | "rejected"

export interface ProfileMigrationPlanEntry {
  step: ProfileMigrationStep
  status: ProfileMigrationPlanStatus
  reason?: string
  estimatedWrites: number
}

export interface ProfileMigrationPlan {
  document: ProfileMigrationDocument
  migrationPath: string
  ledgerPath: string
  sourceSelector: string
  targetSelector: string
  sourceRoot: string
  targetRoot: string | null
  entries: ProfileMigrationPlanEntry[]
}

export interface ProfileMigrationLedger {
  profile: string
  from: string
  to: string
  migrationFileDigest: string
  vaultPageId: string
  startedAt: string
  completedAt: string | null
  stepIds: string[]
  applied: Array<{
    stepId: string
    appliedAt: string
    summary: string
  }>
}

/**
 * Locate the migration YAML inside a profile bundle. Throws when the file
 * is missing — Phase 3 has no inferred migrations.
 */
export function findMigrationFile(sourceRoot: string, from: string, to: string): string {
  const path = join(sourceRoot, "migrations", `${from}__${to}.yaml`)
  if (!existsSync(path)) {
    throw new ProfileMigrationError(
      `Migration file not found: ${path}. Each profile bundle must declare migrations explicitly.`
    )
  }
  return path
}

export interface MigrationDiscovery {
  from: string
  to: string
  path: string
}

export function listProfileMigrations(profileRoot: string): MigrationDiscovery[] {
  const dir = join(profileRoot, "migrations")
  if (!existsSync(dir)) return []
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return []
  }
  const out: MigrationDiscovery[] = []
  for (const entry of entries) {
    if (!entry.endsWith(".yaml")) continue
    const base = entry.slice(0, -".yaml".length)
    const parts = base.split("__")
    if (parts.length !== 2) continue
    const [from, to] = parts
    if (!from || !to) continue
    out.push({ from, to, path: join(dir, entry) })
  }
  return out
}

export function parseMigrationFile(path: string): ProfileMigrationDocument {
  const raw = readFileSync(path, "utf-8")
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new ProfileMigrationError(`Failed to parse ${path}: ${message}`)
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ProfileMigrationError(`${path}: migration must be a YAML mapping.`)
  }
  const record = parsed as Record<string, unknown>
  const profile = expectStringField(record, "profile", path)
  const from = expectStringField(record, "from", path)
  const to = expectStringField(record, "to", path)
  if (!PROFILE_NAME_PATTERN.test(profile)) {
    throw new ProfileMigrationError(
      `${path}: profile must be kebab-case, got "${profile}".`
    )
  }
  const stepsRaw = record["steps"]
  if (!Array.isArray(stepsRaw)) {
    throw new ProfileMigrationError(`${path}: steps must be a list.`)
  }
  const steps: ProfileMigrationStep[] = []
  const stepIds = new Set<string>()
  for (let i = 0; i < stepsRaw.length; i += 1) {
    const step = parseMigrationStep(stepsRaw[i], `${path}: steps[${i}]`)
    if (stepIds.has(step.id)) {
      throw new ProfileMigrationError(
        `${path}: steps[${i}].id "${step.id}" is duplicated within the migration.`
      )
    }
    stepIds.add(step.id)
    steps.push(step)
  }
  return { profile, from, to, steps }
}

function expectStringField(
  record: Record<string, unknown>,
  field: string,
  path: string
): string {
  const value = record[field]
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ProfileMigrationError(`${path}: ${field} must be a non-empty string.`)
  }
  return value.trim()
}

function parseMigrationStep(raw: unknown, path: string): ProfileMigrationStep {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ProfileMigrationError(`${path} must be a mapping.`)
  }
  const record = raw as Record<string, unknown>
  const id = expectStringField(record, "id", path)
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new ProfileMigrationError(`${path}.id must be kebab-case, got "${id}".`)
  }
  const kindValue = record["kind"]
  if (typeof kindValue !== "string") {
    throw new ProfileMigrationError(`${path}.kind must be a string.`)
  }
  if ((REJECTED_PROFILE_MIGRATION_STEP_KINDS as readonly string[]).includes(kindValue)) {
    throw new ProfileMigrationError(
      `${path}.kind "${kindValue}" is rejected in Phase 3 because the operation is destructive or edits profile/prompt/taxonomy files. Phase 3 supports only: ${PROFILE_MIGRATION_STEP_KINDS.join(", ")}.`
    )
  }
  if (!(PROFILE_MIGRATION_STEP_KINDS as readonly string[]).includes(kindValue)) {
    throw new ProfileMigrationError(
      `${path}.kind "${kindValue}" is not a supported Phase 3 step kind. Supported: ${PROFILE_MIGRATION_STEP_KINDS.join(", ")}.`
    )
  }
  if (record["destructive"] === true) {
    throw new ProfileMigrationError(
      `${path}.destructive must be absent or false. Destructive migrations are not supported in Phase 3.`
    )
  }
  const base: ProfileMigrationStepBase = {
    id,
    kind: kindValue as ProfileMigrationStepKind,
    dryRunSummary: record["dryRunSummary"] as string | undefined,
    destructive: false,
  }
  switch (base.kind) {
    case "add_property":
      return parseAddPropertyStep(base, record, path)
    case "add_select_options":
    case "add_multi_select_options":
      return parseAddOptionsStep(base, record, path)
    case "write_config_profile_pin":
      return parseWriteConfigPinStep(base, record, path)
    case "backfill_empty_property":
      return parseBackfillStep(base, record, path)
  }
}

function parseAddPropertyStep(
  base: ProfileMigrationStepBase,
  record: Record<string, unknown>,
  path: string
): AddPropertyStep {
  const database = parseDatabaseKey(record["database"], `${path}.database`)
  const property = expectStringField(record, "property", path)
  if (
    (RESERVED_PROFILE_MIGRATION_PROPERTY_NAMES[database] as readonly string[]).includes(
      property
    )
  ) {
    throw new ProfileMigrationError(
      `${path}.property "${property}" is a core property of databases.${database}; profile migrations cannot redefine core columns.`
    )
  }
  const config = record["config"]
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ProfileMigrationError(`${path}.config must be a property config mapping.`)
  }
  const declared = Object.keys(config as Record<string, unknown>)
  if (declared.length !== 1) {
    throw new ProfileMigrationError(
      `${path}.config must declare exactly one Notion property type; got ${declared.length === 0 ? "<empty>" : declared.join(", ")}.`
    )
  }
  const type = declared[0]!
  if (!(ADDITIVE_PROPERTY_TYPES as readonly string[]).includes(type)) {
    throw new ProfileMigrationError(
      `${path}.config.${type} is not an additive property type allowed in Phase 3. Allowed: ${ADDITIVE_PROPERTY_TYPES.join(", ")}.`
    )
  }
  return {
    ...base,
    kind: "add_property",
    database,
    property,
    config: config as Record<string, unknown>,
  }
}

function parseAddOptionsStep(
  base: ProfileMigrationStepBase,
  record: Record<string, unknown>,
  path: string
): AddSelectOptionsStep | AddMultiSelectOptionsStep {
  const database = parseDatabaseKey(record["database"], `${path}.database`)
  const property = expectStringField(record, "property", path)
  const optionsRaw = record["options"]
  if (!Array.isArray(optionsRaw)) {
    throw new ProfileMigrationError(`${path}.options must be a list.`)
  }
  const options: Array<{ name: string; color?: string }> = []
  for (let i = 0; i < optionsRaw.length; i += 1) {
    const option = optionsRaw[i]
    if (!option || typeof option !== "object" || Array.isArray(option)) {
      throw new ProfileMigrationError(`${path}.options[${i}] must be a mapping.`)
    }
    const name = expectStringField(
      option as Record<string, unknown>,
      "name",
      `${path}.options[${i}]`
    )
    const color = (option as Record<string, unknown>)["color"]
    if (color !== undefined && typeof color !== "string") {
      throw new ProfileMigrationError(`${path}.options[${i}].color must be a string.`)
    }
    options.push(color === undefined ? { name } : { name, color })
  }
  validateOptionAppendTarget(database, property, base.kind, options, path)
  return {
    ...base,
    kind: base.kind as "add_select_options" | "add_multi_select_options",
    database,
    property,
    options,
  } as AddSelectOptionsStep | AddMultiSelectOptionsStep
}

function parseWriteConfigPinStep(
  base: ProfileMigrationStepBase,
  record: Record<string, unknown>,
  path: string
): WriteConfigProfilePinStep {
  const selector = expectStringField(record, "selector", path)
  try {
    parseProfileSelector(selector)
  } catch (err) {
    throw new ProfileMigrationError(
      `${path}.selector is invalid: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return { ...base, kind: "write_config_profile_pin", selector }
}

function parseBackfillStep(
  base: ProfileMigrationStepBase,
  record: Record<string, unknown>,
  path: string
): BackfillEmptyPropertyStep {
  const database = parseDatabaseKey(record["database"], `${path}.database`)
  const property = expectStringField(record, "property", path)
  rejectCorePropertyTarget(database, property, path)
  const value = record["value"]
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProfileMigrationError(
      `${path}.value must be a literal Notion property value mapping.`
    )
  }
  const filter = record["filter"]
  if (!filter || typeof filter !== "object" || Array.isArray(filter)) {
    throw new ProfileMigrationError(`${path}.filter must be a Notion-style filter.`)
  }
  validateFilterIncludesEmptyCheck(filter as Record<string, unknown>, property, path)
  const limitRaw = record["limit"]
  if (typeof limitRaw !== "number" || !Number.isInteger(limitRaw) || limitRaw <= 0) {
    throw new ProfileMigrationError(`${path}.limit must be a positive integer.`)
  }
  if (limitRaw > BACKFILL_ROW_LIMIT_CAP) {
    throw new ProfileMigrationError(
      `${path}.limit exceeds the Phase 3 cap of ${BACKFILL_ROW_LIMIT_CAP} rows per run; split the backfill into multiple runs.`
    )
  }
  return {
    ...base,
    kind: "backfill_empty_property",
    database,
    property,
    value: value as Record<string, unknown>,
    filter: filter as Record<string, unknown>,
    limit: limitRaw,
  }
}

function validateOptionAppendTarget(
  database: ProfileMigrationDatabaseKey,
  property: string,
  kind: ProfileMigrationStepKind,
  options: Array<{ name: string; color?: string }>,
  path: string
): void {
  if (
    !(RESERVED_PROFILE_MIGRATION_PROPERTY_NAMES[database] as readonly string[]).includes(
      property
    )
  ) {
    return
  }

  const allowed =
    (database === "memories" &&
      property === "Tags" &&
      kind === "add_multi_select_options") ||
    (database === "entities" && property === "Kind" && kind === "add_select_options") ||
    (database === "facts" && property === "Predicate" && kind === "add_select_options")

  if (!allowed) {
    throw new ProfileMigrationError(
      `${path}.property "${property}" is a core property of databases.${database}; Phase 3 migrations may append options only to profile-owned core taxonomy columns: memories.Tags, entities.Kind, or facts.Predicate.`
    )
  }

  if (database === "facts" && property === "Predicate") {
    const reserved = new Set(RESERVED_FACT_PREDICATES)
    const reservedOption = options.find((option) => reserved.has(option.name))
    if (reservedOption) {
      throw new ProfileMigrationError(
        `${path}.options cannot add reserved/internal fact predicate "${reservedOption.name}".`
      )
    }
  }
}

function rejectCorePropertyTarget(
  database: ProfileMigrationDatabaseKey,
  property: string,
  path: string
): void {
  if (
    !(RESERVED_PROFILE_MIGRATION_PROPERTY_NAMES[database] as readonly string[]).includes(
      property
    )
  ) {
    return
  }
  throw new ProfileMigrationError(
    `${path}.property "${property}" is a core property of databases.${database}; Phase 3 migrations cannot backfill core columns.`
  )
}

function validateFilterIncludesEmptyCheck(
  filter: Record<string, unknown>,
  property: string,
  path: string
): void {
  if (containsEmptyCheckForProperty(filter, property)) return
  throw new ProfileMigrationError(
    `${path}.filter must include an empty/unset check for the target property "${property}" so backfills cannot overwrite non-empty cells.`
  )
}

function containsEmptyCheckForProperty(value: unknown, property: string): boolean {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) {
    return value.some((entry) => containsEmptyCheckForProperty(entry, property))
  }
  const record = value as Record<string, unknown>
  if (record["property"] === property) {
    for (const inner of Object.values(record)) {
      if (matchesEmptyCheck(inner)) return true
    }
  }
  for (const child of Object.values(record)) {
    if (containsEmptyCheckForProperty(child, property)) return true
  }
  return false
}

function matchesEmptyCheck(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return record["is_empty"] === true || record["is_unset"] === true
}

function parseDatabaseKey(value: unknown, path: string): ProfileMigrationDatabaseKey {
  if (typeof value !== "string") {
    throw new ProfileMigrationError(`${path} must be a string.`)
  }
  if (!(PROFILE_MIGRATION_DATABASE_KEYS as readonly string[]).includes(value)) {
    throw new ProfileMigrationError(
      `${path} "${value}" is not a core database. Expected one of: ${PROFILE_MIGRATION_DATABASE_KEYS.join(", ")}.`
    )
  }
  return value as ProfileMigrationDatabaseKey
}

/**
 * Compute a stable digest over the canonical migration YAML for storage
 * in the ledger.
 */
export function digestMigrationFile(path: string): string {
  const hash = createHash("sha256")
  hash.update(readFileSync(path))
  return `sha256:${hash.digest("hex")}`
}

function ledgerDir(configRoot: string, profile: string): string {
  return join(configRoot, PROFILE_MIGRATIONS_LEDGER_REL, safeFilenameSegment(profile))
}

function safeFilenameSegment(value: string): string {
  return value.replace(/[^a-z0-9._-]+/gi, "_")
}

export function ledgerPath(
  configRoot: string,
  document: ProfileMigrationDocument,
  vaultPageId: string
): string {
  const vaultDigest = createHash("sha256").update(vaultPageId).digest("hex").slice(0, 12)
  return join(
    ledgerDir(configRoot, document.profile),
    `${document.from}__${document.to}.${vaultDigest}.json`
  )
}

export function readLedger(path: string): ProfileMigrationLedger | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf-8")
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== "object") return null
    return parsed as ProfileMigrationLedger
  } catch {
    return null
  }
}

export function writeLedger(path: string, ledger: ProfileMigrationLedger): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
}

export interface PlanInputs {
  services: LoreServices
  sourceSelector: string
  targetSelector: string
  /**
   * If true, evaluate per-step idempotency against the live Notion
   * schema and emit `skip-already-satisfied` for steps whose effect is
   * already visible. Plan mode and apply mode both want this; tests
   * may disable it.
   */
  checkLive?: boolean
}

/**
 * Build a plan describing which steps would run, be skipped, or fail
 * against the current source/target selector pair. The plan is the
 * output of dry-run and the precondition for apply.
 */
export async function buildMigrationPlan(
  inputs: PlanInputs
): Promise<ProfileMigrationPlan> {
  const sourceParsed = parseProfileSelector(inputs.sourceSelector)
  const targetParsed = parseProfileSelector(inputs.targetSelector)
  if (sourceParsed.name !== targetParsed.name) {
    throw new ProfileMigrationError(
      `Source and target selectors must share a profile name (${sourceParsed.name} vs ${targetParsed.name}).`
    )
  }

  const sourceLocation = resolveProfileSelector(sourceParsed, inputs.services.configRoot)
  if (!sourceLocation) {
    throw new ProfileMigrationError(
      `Source profile not resolvable: ${inputs.sourceSelector}.`
    )
  }
  const targetLocation = resolveProfileSelector(targetParsed, inputs.services.configRoot)

  const migrationPath = findMigrationFile(
    sourceLocation.rootDir,
    sourceParsed.version,
    targetParsed.version
  )
  const document = parseMigrationFile(migrationPath)
  if (document.profile !== sourceParsed.name) {
    throw new ProfileMigrationError(
      `${migrationPath}: profile "${document.profile}" does not match selector profile "${sourceParsed.name}".`
    )
  }
  if (document.from !== sourceParsed.version || document.to !== targetParsed.version) {
    throw new ProfileMigrationError(
      `${migrationPath}: declared ${document.from}__${document.to} does not match requested ${sourceParsed.version}__${targetParsed.version}.`
    )
  }
  for (const step of document.steps) {
    if (
      step.kind === "write_config_profile_pin" &&
      step.selector !== inputs.targetSelector
    ) {
      throw new ProfileMigrationError(
        `${migrationPath}: write_config_profile_pin selector "${step.selector}" must equal the target selector ${inputs.targetSelector}.`
      )
    }
  }
  ensureConfigPinTargetLoadable(document.steps, targetParsed, inputs.services.configRoot)

  const entries: ProfileMigrationPlanEntry[] = []
  for (const step of document.steps) {
    if (inputs.checkLive === false) {
      entries.push({ step, status: "would-run", estimatedWrites: estimateWrites(step) })
      continue
    }
    const live = await evaluateStepLive(inputs.services, step)
    entries.push({
      step,
      status: live.status,
      reason: live.reason,
      estimatedWrites:
        live.status === "skip-already-satisfied" ? 0 : estimateWrites(step),
    })
  }

  return {
    document,
    migrationPath,
    ledgerPath: ledgerPath(
      inputs.services.configRoot,
      document,
      inputs.services.config.vault.pageId
    ),
    sourceSelector: sourceParsed.selector,
    targetSelector: targetParsed.selector,
    sourceRoot: sourceLocation.rootDir,
    targetRoot: targetLocation?.rootDir ?? null,
    entries,
  }
}

function ensureConfigPinTargetLoadable(
  steps: readonly ProfileMigrationStep[],
  targetParsed: ReturnType<typeof parseProfileSelector>,
  configRoot: string
): void {
  if (!steps.some((step) => step.kind === "write_config_profile_pin")) return
  const targetLocation = resolveProfileSelector(targetParsed, configRoot)
  if (!targetLocation) {
    throw new ProfileMigrationError(
      `Target profile not resolvable for config pin: ${targetParsed.selector}. Install it first with \`lore profile install\`.`
    )
  }
  try {
    loadProfileFromRoot(targetLocation.rootDir, {
      source: targetLocation.source,
      selector: targetParsed.selector,
    })
  } catch (err) {
    if (err instanceof ProfileLoadError) {
      throw new ProfileMigrationError(
        `Target profile not loadable for config pin: ${targetParsed.selector}: ${err.message}`
      )
    }
    throw err
  }
}

function estimateWrites(step: ProfileMigrationStep): number {
  switch (step.kind) {
    case "add_property":
    case "add_select_options":
    case "add_multi_select_options":
      return 1
    case "write_config_profile_pin":
      return 1
    case "backfill_empty_property":
      return step.limit
  }
}

interface LiveEvaluation {
  status: ProfileMigrationPlanStatus
  reason?: string
}

async function evaluateStepLive(
  services: LoreServices,
  step: ProfileMigrationStep
): Promise<LiveEvaluation> {
  try {
    switch (step.kind) {
      case "add_property": {
        const has = await dataSourceHasProperty(
          services.client,
          databaseRefId(services, step.database),
          step.property
        )
        return has
          ? {
              status: "skip-already-satisfied",
              reason: `${step.database}.${step.property} already exists on the vault.`,
            }
          : { status: "would-run" }
      }
      case "add_select_options":
      case "add_multi_select_options": {
        const liveOptions = await dataSourceOptions(
          services.client,
          databaseRefId(services, step.database),
          step.property,
          step.kind === "add_select_options" ? "select" : "multi_select"
        )
        const liveNames = new Set(liveOptions.map((o) => o.name))
        const missing = step.options.filter((opt) => !liveNames.has(opt.name))
        if (missing.length === 0) {
          return {
            status: "skip-already-satisfied",
            reason: `All ${step.options.length} options already present on ${step.database}.${step.property}.`,
          }
        }
        return { status: "would-run" }
      }
      case "write_config_profile_pin":
        if (services.config.profile === step.selector) {
          return {
            status: "skip-already-satisfied",
            reason: `.lore.yaml profile already pinned to ${step.selector}.`,
          }
        }
        return { status: "would-run" }
      case "backfill_empty_property":
        return { status: "would-run" }
    }
  } catch (err) {
    return {
      status: "would-run",
      reason: `Live probe failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

function databaseRefId(services: LoreServices, key: ProfileMigrationDatabaseKey): string {
  const databases = services.vault.databases
  return databases[key].dataSourceId
}

interface NotionPropertySchema {
  type: string
  options?: Array<{ name: string; color?: string; id?: string }>
}

async function readDataSourceProperties(
  client: Client,
  dataSourceId: string
): Promise<Record<string, NotionPropertySchema>> {
  const response = (await client.dataSources.retrieve({
    data_source_id: dataSourceId,
  })) as { properties: Record<string, NotionPropertySchema> }
  return response.properties
}

async function dataSourceHasProperty(
  client: Client,
  dataSourceId: string,
  property: string
): Promise<boolean> {
  const properties = await readDataSourceProperties(client, dataSourceId)
  return property in properties
}

async function dataSourceOptions(
  client: Client,
  dataSourceId: string,
  property: string,
  expectedType: "select" | "multi_select"
): Promise<Array<{ name: string; color?: string; id?: string }>> {
  const properties = await readDataSourceProperties(client, dataSourceId)
  const live = properties[property]
  if (!live) {
    throw new ProfileMigrationError(
      `Cannot inspect options for ${property}: property does not exist on the live data source. Add the property first via add_property.`
    )
  }
  if (live.type !== expectedType) {
    throw new ProfileMigrationError(
      `Property ${property} has type ${live.type}, expected ${expectedType} for option append.`
    )
  }
  const opts = (
    live as unknown as {
      [k: string]: { options?: Array<{ name: string; color?: string; id?: string }> }
    }
  )[expectedType]?.options
  return opts ?? []
}

export interface ApplyOptions {
  configPath: string
}

export interface ApplyResult {
  plan: ProfileMigrationPlan
  appliedStepIds: string[]
  skippedStepIds: string[]
  ledger: ProfileMigrationLedger
}

/**
 * Apply a previously-built plan. Each step verifies its effect against
 * live Notion state after the write and only then records into the ledger.
 * The `write_config_profile_pin` step always runs last so a partial
 * failure leaves the source pin intact.
 */
export async function applyMigrationPlan(
  services: LoreServices,
  plan: ProfileMigrationPlan,
  options: ApplyOptions
): Promise<ApplyResult> {
  ensureConfigPinTargetLoadable(
    plan.document.steps,
    parseProfileSelector(plan.targetSelector),
    services.configRoot
  )
  const fileDigest = digestMigrationFile(plan.migrationPath)
  const startedAt = new Date().toISOString()
  const ledger: ProfileMigrationLedger = readLedger(plan.ledgerPath) ?? {
    profile: plan.document.profile,
    from: plan.document.from,
    to: plan.document.to,
    migrationFileDigest: fileDigest,
    vaultPageId: services.config.vault.pageId,
    startedAt,
    completedAt: null,
    stepIds: plan.document.steps.map((s) => s.id),
    applied: [],
  }
  ledger.migrationFileDigest = fileDigest
  if (!ledger.completedAt) {
    ledger.startedAt = startedAt
  }

  const appliedIds: string[] = []
  const skippedIds: string[] = []
  const pinSteps = plan.entries.filter((e) => e.step.kind === "write_config_profile_pin")
  const vaultSteps = plan.entries.filter(
    (e) => e.step.kind !== "write_config_profile_pin"
  )
  const orderedEntries = [...vaultSteps, ...pinSteps]

  for (const entry of orderedEntries) {
    if (entry.status === "skip-already-satisfied") {
      skippedIds.push(entry.step.id)
      continue
    }
    if (entry.status === "rejected") {
      throw new ProfileMigrationError(
        `Cannot apply rejected step "${entry.step.id}": ${entry.reason ?? "unknown"}`
      )
    }
    const summary = await applyStep(services, entry.step, options)
    const verified = await verifyStepIdempotent(services, entry.step, options)
    if (!verified.ok) {
      writeLedger(plan.ledgerPath, ledger)
      throw new ProfileMigrationError(
        `Post-write verification failed for step "${entry.step.id}": ${verified.reason}.`
      )
    }
    appliedIds.push(entry.step.id)
    ledger.applied.push({
      stepId: entry.step.id,
      appliedAt: new Date().toISOString(),
      summary,
    })
    writeLedger(plan.ledgerPath, ledger)
  }
  ledger.completedAt = new Date().toISOString()
  writeLedger(plan.ledgerPath, ledger)
  return { plan, appliedStepIds: appliedIds, skippedStepIds: skippedIds, ledger }
}

async function applyStep(
  services: LoreServices,
  step: ProfileMigrationStep,
  options: ApplyOptions
): Promise<string> {
  switch (step.kind) {
    case "add_property": {
      const dsId = databaseRefId(services, step.database)
      await services.client.dataSources.update({
        data_source_id: dsId,
        properties: { [step.property]: step.config } as Parameters<
          Client["dataSources"]["update"]
        >[0]["properties"],
      })
      return `Added ${step.database}.${step.property}.`
    }
    case "add_select_options":
    case "add_multi_select_options": {
      const dsId = databaseRefId(services, step.database)
      const liveOptions = await dataSourceOptions(
        services.client,
        dsId,
        step.property,
        step.kind === "add_select_options" ? "select" : "multi_select"
      )
      const liveNames = new Set(liveOptions.map((o) => o.name))
      const mergedOptions = [
        ...liveOptions,
        ...step.options.filter((opt) => !liveNames.has(opt.name)),
      ]
      await services.client.dataSources.update({
        data_source_id: dsId,
        properties: {
          [step.property]:
            step.kind === "add_select_options"
              ? { select: { options: mergedOptions } }
              : { multi_select: { options: mergedOptions } },
        } as Parameters<Client["dataSources"]["update"]>[0]["properties"],
      })
      return `Appended ${step.options.length} option(s) to ${step.database}.${step.property}.`
    }
    case "write_config_profile_pin": {
      rewriteConfigProfilePin(options.configPath, step.selector)
      return `Pinned ${options.configPath} profile to ${step.selector}.`
    }
    case "backfill_empty_property": {
      const dsId = databaseRefId(services, step.database)
      const writes = await runBackfill(services.client, dsId, step)
      return `Backfilled ${writes} row(s) on ${step.database}.${step.property}.`
    }
  }
}

async function verifyStepIdempotent(
  services: LoreServices,
  step: ProfileMigrationStep,
  options: ApplyOptions
): Promise<{ ok: boolean; reason?: string }> {
  try {
    switch (step.kind) {
      case "add_property": {
        const has = await dataSourceHasProperty(
          services.client,
          databaseRefId(services, step.database),
          step.property
        )
        return has
          ? { ok: true }
          : {
              ok: false,
              reason: `${step.database}.${step.property} not present after write.`,
            }
      }
      case "add_select_options":
      case "add_multi_select_options": {
        const live = await dataSourceOptions(
          services.client,
          databaseRefId(services, step.database),
          step.property,
          step.kind === "add_select_options" ? "select" : "multi_select"
        )
        const liveNames = new Set(live.map((o) => o.name))
        const missing = step.options.filter((o) => !liveNames.has(o.name))
        return missing.length === 0
          ? { ok: true }
          : {
              ok: false,
              reason: `${missing.map((o) => o.name).join(", ")} missing after write.`,
            }
      }
      case "write_config_profile_pin": {
        const raw = readFileSync(options.configPath, "utf-8")
        const parsed = parseYaml(raw) as { profile?: string }
        return parsed?.profile === step.selector
          ? { ok: true }
          : {
              ok: false,
              reason: `profile in ${options.configPath} is ${parsed?.profile}.`,
            }
      }
      case "backfill_empty_property":
        return { ok: true }
    }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Update only the `profile:` selector in a `.lore.yaml` file without
 * disturbing other keys, comments, or YAML formatting Notion-readers
 * have come to depend on. Falls back to a clean YAML rewrite when the
 * regex form cannot match.
 */
export function rewriteConfigProfilePin(path: string, selector: string): void {
  const raw = readFileSync(path, "utf-8")
  const replacement = `profile: ${selector}`
  const replaced = raw.replace(/^profile:.*$/m, replacement)
  if (replaced !== raw) {
    writeFileSync(path, replaced)
    return
  }
  if (/^profile:/m.test(raw)) {
    writeFileSync(path, raw)
    return
  }
  const parsed = (parseYaml(raw) as Record<string, unknown> | undefined) ?? {}
  parsed["profile"] = selector
  writeFileSync(path, stringifyYaml(parsed))
}

async function runBackfill(
  client: Client,
  dataSourceId: string,
  step: BackfillEmptyPropertyStep
): Promise<number> {
  let writes = 0
  let scanned = 0
  let cursor: string | undefined = undefined
  while (scanned < step.limit) {
    const remaining = step.limit - scanned
    const page = (await client.dataSources.query({
      data_source_id: dataSourceId,
      filter: step.filter as Parameters<Client["dataSources"]["query"]>[0]["filter"],
      start_cursor: cursor,
      page_size: Math.min(remaining, 100),
    })) as {
      results: Array<{ id: string; properties: Record<string, unknown> }>
      next_cursor: string | null
      has_more: boolean
    }
    for (const result of page.results) {
      if (scanned >= step.limit) break
      scanned += 1
      if (!isPropertyEmptyOnPage(result.properties, step.property)) continue
      await client.pages.update({
        page_id: result.id,
        properties: { [step.property]: step.value } as Parameters<
          Client["pages"]["update"]
        >[0]["properties"],
      })
      writes += 1
    }
    if (!page.has_more || !page.next_cursor) break
    cursor = page.next_cursor
  }
  return writes
}

function isPropertyEmptyOnPage(
  properties: Record<string, unknown>,
  property: string
): boolean {
  const prop = properties[property]
  if (!prop || typeof prop !== "object") return true
  const record = prop as Record<string, unknown>
  const type = record["type"]
  if (typeof type !== "string") return true
  const inner = record[type]
  if (inner === null || inner === undefined) return true
  if (Array.isArray(inner)) return inner.length === 0
  if (typeof inner === "object") {
    return Object.keys(inner as Record<string, unknown>).length === 0
  }
  return false
}

/**
 * Try to determine the on-disk path of the loaded `.lore.yaml` for use
 * by `applyMigrationPlan`. Used by the CLI which already knows the
 * config root from `initServices`.
 */
export function defaultConfigPath(configRoot: string): string {
  return resolve(configRoot, ".lore.yaml")
}

/**
 * Helper used by `lore profile show` / `preview` to summarize a profile
 * by reading its on-disk bundle.
 */
export function summarizeProfile(profile: ResolvedProfile): {
  selector: string
  source: string
  rootDir: string
  manifestDigest: string
  schemaAdditions: Record<string, number>
  tags: number
  entityKinds: number
  writableFactPredicates: number
  prompts: string[]
  evalSuites: string[]
  migrations: MigrationDiscovery[]
} {
  const schemaAdditions: Record<string, number> = {}
  for (const key of Object.keys(profile.schema)) {
    const dbKey = key as keyof typeof profile.schema
    schemaAdditions[key] = Object.keys(profile.schema[dbKey]).length
  }
  return {
    selector: profile.selector,
    source: profile.source,
    rootDir: profile.rootDir,
    manifestDigest: profile.manifestDigest,
    schemaAdditions,
    tags: profile.taxonomy.tags.length,
    entityKinds: profile.taxonomy.entityKinds.length,
    writableFactPredicates: profile.taxonomy.writableFactPredicates.length,
    prompts: Object.keys(profile.prompts),
    evalSuites: profile.evalSuites,
    migrations: listProfileMigrations(profile.rootDir),
  }
}

/**
 * Helper used by `lore profile validate` to load a bundle from a path.
 */
export function validateProfileBundle(path: string): ResolvedProfile {
  const root = resolve(path)
  if (!existsSync(join(root, "profile.yaml"))) {
    throw new ProfileMigrationError(
      `${root} does not contain profile.yaml. Phase 3 requires the bundle root to live at the path you pass.`
    )
  }
  try {
    return loadProfileFromRoot(root, { source: "local" })
  } catch (err) {
    if (err instanceof ProfileLoadError) {
      throw new ProfileMigrationError(`Invalid profile: ${err.message}`)
    }
    throw err
  }
}

export function isProfileBundleDir(path: string): boolean {
  try {
    const st = statSync(path)
    return st.isDirectory() && existsSync(join(path, "profile.yaml"))
  } catch {
    return false
  }
}
