export interface TaskSubjectValidationInput {
  subject: string
  description?: string
  synopsis?: string
  dueDate?: string | null
  blockedBy?: string
  affectsIds?: readonly string[]
  allowPointerSubject?: boolean
}

export type TaskPointerSubjectReason =
  | "path"
  | "file-reference"
  | "parenthesized-file-reference"
  | "identifier"

export type TaskSubjectValidationResult =
  | { ok: true }
  | { ok: false; reason: TaskPointerSubjectReason; message: string }

const CODE_CONFIG_DATA_EXTENSIONS = [
  "avro",
  "bash",
  "c",
  "cc",
  "cjs",
  "clj",
  "cpp",
  "cs",
  "csv",
  "cts",
  "cxx",
  "env",
  "erl",
  "ex",
  "exs",
  "fish",
  "fs",
  "fsx",
  "go",
  "gql",
  "gradle",
  "graphql",
  "h",
  "hpp",
  "hrl",
  "html",
  "java",
  "js",
  "json",
  "jsonc",
  "jsx",
  "kt",
  "kts",
  "lock",
  "lua",
  "md",
  "mdx",
  "mjs",
  "mts",
  "parquet",
  "php",
  "pl",
  "pm",
  "proto",
  "ps1",
  "py",
  "rb",
  "rs",
  "scala",
  "sh",
  "sql",
  "swift",
  "toml",
  "ts",
  "tsv",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
] as const

const EXTENSION_PATTERN = CODE_CONFIG_DATA_EXTENSIONS.join("|")
const FILE_REFERENCE_PATTERN = new RegExp(
  String.raw`(?:^|[\s(["'])[^/\s\\()"']+\.(?:${EXTENSION_PATTERN})(?::\d+(?:-\d+)?)?(?=$|[\s,;.)"'\\]])`,
  "i"
)
const PARENTHESIZED_FILE_LINE_PATTERN = new RegExp(
  String.raw`\([^)]*\.(?:${EXTENSION_PATTERN}):\d+(?:-\d+)?[^)]*\)`,
  "i"
)
const CAMEL_CASE_PATTERN = /^[a-z][A-Za-z0-9]*[A-Z][A-Za-z0-9]*$/
const PASCAL_CASE_PATTERN = /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/
const SNAKE_CASE_PATTERN = /^[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+$/
const INDEX_IDENTIFIER_PATTERN = /^idx[_-][A-Za-z0-9_-]+$/i
const RESOURCE_NAME_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9_-]*(?:\s+[A-Za-z0-9][A-Za-z0-9_-]*){0,2}\s+(collection|database|dataset|index|queue|table|topic|workflow|worker)$/i
const TASK_CUE_PATTERN =
  /(?:^|\s)(add|audit|backfill|check|clean up|close|create|debug|delete|document|ensure|fix|follow up|handle|implement|investigate|migrate|patch|refactor|remove|rename|repair|resolve|review|ship|test|triage|update|validate|verify)(?=$|[\s:;,.!?-])/i
const PROBLEM_CUE_PATTERN =
  /(?:^|\s)(broken|bug|cannot|can't|cleanup|conflict|crash|error|failing|fails|failure|flaky|leak|missing|need|needs|regression|should|stale|slow|timeout)(?=$|[\s:;,.!?-])/i

export function pointerSubjectRejectionMessage(subject: string): string {
  return (
    `"${subject.replaceAll('"', '\\"')}" looks like a code pointer rather than a task. ` +
    "If you want to track a concern about a code location, use " +
    "lore-fact action='create' with subject=<entity>, " +
    "predicate=<writable predicate for this vault>, object=<your note>. " +
    "If this really is a task, restate it as an imperative, for example " +
    '"Audit countColumnValuesForThreadAttributeID for missing index". ' +
    "To bypass this guard, pass allowPointerSubject/--allow-pointer-subject."
  )
}

export function validateTaskSubjectForCreate(
  input: TaskSubjectValidationInput
): TaskSubjectValidationResult {
  if (input.allowPointerSubject === true) return { ok: true }

  const subject = input.subject.trim()
  if (subject === "") return { ok: true }

  const hasTaskCue = hasTaskLanguage(subject)
  if (PARENTHESIZED_FILE_LINE_PATTERN.test(subject) && !hasTaskCue) {
    return reject(input.subject, "parenthesized-file-reference")
  }
  if (FILE_REFERENCE_PATTERN.test(subject) && !hasTaskCue) {
    return reject(input.subject, "file-reference")
  }
  if (hasPathSeparator(subject) && !hasTaskCue) {
    return reject(input.subject, "path")
  }
  if (RESOURCE_NAME_PATTERN.test(subject) && !hasTaskCue) {
    return reject(input.subject, "identifier")
  }
  if (isSingleTokenIdentifier(subject) && !hasAdditionalDoneCriterion(input)) {
    return reject(input.subject, "identifier")
  }

  return { ok: true }
}

function reject(
  subject: string,
  reason: TaskPointerSubjectReason
): TaskSubjectValidationResult {
  return { ok: false, reason, message: pointerSubjectRejectionMessage(subject) }
}

function hasPathSeparator(subject: string): boolean {
  return subject.includes("/") || subject.includes("\\")
}

function hasTaskLanguage(subject: string): boolean {
  return TASK_CUE_PATTERN.test(subject) || PROBLEM_CUE_PATTERN.test(subject)
}

function hasAdditionalDoneCriterion(input: TaskSubjectValidationInput): boolean {
  return (
    hasText(input.description) ||
    hasText(input.synopsis) ||
    hasText(input.dueDate) ||
    hasText(input.blockedBy) ||
    (input.affectsIds?.length ?? 0) > 0
  )
}

function hasText(value: string | null | undefined): boolean {
  return value !== undefined && value !== null && value.trim() !== ""
}

function isSingleTokenIdentifier(subject: string): boolean {
  if (/\s/.test(subject)) return false
  const token = subject.replace(/^`|`$/g, "")
  return (
    CAMEL_CASE_PATTERN.test(token) ||
    PASCAL_CASE_PATTERN.test(token) ||
    SNAKE_CASE_PATTERN.test(token) ||
    INDEX_IDENTIFIER_PATTERN.test(token)
  )
}
