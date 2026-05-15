import { Command } from "commander"
import { access, readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { findConfigFile, loadConfig } from "../../config.js"
import { initServices, type LoreServices } from "../../services.js"
import {
  reconcileActiveTasks,
  formatReconcileOutput,
  DEFAULT_RECONCILE_LIMIT,
  DEFAULT_RECONCILE_MIN_SCORE,
  MAX_RECONCILE_LIMIT,
} from "../../core/task-reconcile.js"
import { validateTaskSubjectForCreate } from "../../core/task-subject-validation.js"
import {
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import {
  TaskClosePartialFailureError,
  normalizeCloseManyTaskIds,
  taskDaysOverdue,
} from "../../core/task.js"
import {
  findDuplicateActiveTasks,
  findExactReuseTarget,
} from "../../core/near-duplicate.js"
import { decodeTextEntities } from "../../notion/html-entities.js"
import { debugLogPartialFailures } from "../../mcp/helpers.js"
import { resolveFeatureFlags } from "../../feature-flags.js"
import {
  ACTIVE_TASK_STATES,
  TAG_VOCABULARY,
  type TaskState,
  type TaskSummary,
} from "../../types.js"
import { parsePositiveDecimalInteger, parseUnitIntervalDecimal } from "../parse.js"
import { resolveProfileFromConfigAtRoot } from "../../profile/index.js"

const PROJECT_LIST_HINT = "run `lore status projects` to list configured projects"
const YMD_REGEX = /^\d{4}-\d{2}-\d{2}$/
const YMD_HINT = "must be YYYY-MM-DD"

const TASK_STATES: readonly TaskState[] = [
  "open",
  "in-progress",
  "blocked",
  "done",
  "cancelled",
]
const CLOSE_STATES: readonly TaskState[] = ["done", "cancelled"]

/**
 * Default per-section render cap for `lore tasks list`. Matches the MCP
 * `lore-task action='list'` `DEFAULT_TASKS_LIMIT` so an operator and
 * an agent see the same triage window on the same vault.
 */
const DEFAULT_LIST_LIMIT = 10
/**
 * Per-Notion-call ceiling. `TaskService.list` clamps a single call
 * to 100 internally; respecting that cap here keeps each iteration of
 * the cursor walk a single Notion round-trip.
 */
const LIST_PAGE_SIZE = 100
/**
 * Safety cap on the cursor-walk loop. 5 pages × 100 rows = 500 fetched
 * rows worst case before the loop exits with a "more matching tasks
 * exist" footer. Past this cap, an operator triaging a 5,000-task vault
 * pays five sequential `dataSources.query` round-trips at most; the
 * footer points them at narrower filters (`--project`, `--entity`,
 * `--state`, `--due-before`) for an exact total.
 */
const MAX_LIST_PAGES = 5
/**
 * Effective ceiling on `--limit` exposed to operators. Walking past this
 * would exceed `MAX_LIST_PAGES` × `LIST_PAGE_SIZE` and start truncating
 * silently; reject at the parse boundary instead.
 */
const MAX_LIST_LIMIT = LIST_PAGE_SIZE * MAX_LIST_PAGES

type CliParseOk<T> = { ok: true; value: T }
type CliParseErr = { ok: false; message: string }
type CliParseResult<T> = CliParseOk<T> | CliParseErr

/**
 * Parallels the MCP-side `isUnusableBlockerLabel`. A
 * blocker label that is missing, null, or whitespace-only is
 * unactionable: it tells triage "this task is blocked" without naming
 * the blocker, which is the failure mode the cross-field guard exists
 * to prevent. Without this trim, `lore tasks create "T" --state blocked
 * --blocked-by "   "` would land a row whose `Blocked By` column reads
 * as visually blank — exactly the situation an operator triaging
 * `lore tasks list` cannot act on.
 *
 * Defined as a CLI-local helper rather than imported from the MCP
 * `lore-task` handler to avoid a CLI → MCP-tools dependency edge;
 * the predicate is small and the parity contract is documented here.
 */
function isUnusableBlockerLabel(value: string | undefined | null): boolean {
  return value === undefined || value === null || value.trim() === ""
}

/**
 * Parsed reconcile options after CLI-boundary validation. The action
 * body builds this shape (or a numeric error) before touching services
 * — separating parse-validate from execution lets the unit test exercise
 * the boundary checks without standing up a Notion stub.
 */
export interface ReconcileCliOptions {
  projectName: string | undefined
  minScore: number
  limit: number
}

/**
 * Validate `--min-score` and `--limit` raw string inputs. Default
 * `parseFloat` / `parseInt` silently coerce malformed input
 * (`--min-score 0.5abc` → 0.5, `--limit 3.7` → 3). Shared strict parsers
 * make the boundary loud: a malformed flag fails the parse, the action body
 * surfaces a clear error, and the operator knows to retry. Same shape for
 * over-cap `--limit` so the CLI doesn't silently coerce 9999 → 100 via the
 * orchestrator's clamp without telling the operator they tripped the cap.
 *
 * Returns a discriminated union: `{ ok: true, value }` on success or
 * `{ ok: false, message }` on failure. The action body short-circuits
 * on `ok: false` and the unit test asserts on `message` content.
 */
export function parseReconcileCliOptions(raw: {
  project?: string
  minScore: string
  limit: string
}): CliParseResult<ReconcileCliOptions> {
  const parsedMinScore = parseUnitIntervalDecimal("--min-score", raw.minScore)
  if (!parsedMinScore.ok) return parsedMinScore

  const parsedLimit = parsePositiveDecimalInteger("--limit", raw.limit)
  if (!parsedLimit.ok) return parsedLimit
  if (parsedLimit.value > MAX_RECONCILE_LIMIT) {
    return {
      ok: false,
      message: `--limit must be between 1 and ${MAX_RECONCILE_LIMIT}, got ${parsedLimit.value}`,
    }
  }
  return {
    ok: true,
    value: {
      projectName: raw.project,
      minScore: parsedMinScore.value,
      limit: parsedLimit.value,
    },
  }
}

/**
 * Run the reconcile pass and return the rendered markdown output.
 * Pure-ish helper: takes `services` + parsed options so the unit test can
 * assert project resolution without standing up a CLI process.
 */
export async function runReconcile(
  services: LoreServices,
  opts: ReconcileCliOptions
): Promise<string> {
  const projectId = await resolveProjectIdForRead(services, opts.projectName)

  const today = new Date().toISOString().split("T")[0]!
  const { candidates, activeTasksScanned } = await reconcileActiveTasks(services, {
    projectId,
    minScore: opts.minScore,
    limit: opts.limit,
    today,
  })

  return formatReconcileOutput(candidates, activeTasksScanned, today)
}

const reconcileCommand = new Command("reconcile")
  .description("Scan active tasks for resolution-shaped memory matches")
  .option(
    "-p, --project <name>",
    "Project to scope the scan to (defaults to cwd-resolved project)"
  )
  .option(
    "--min-score <n>",
    `Minimum candidate score (0–1) to surface (default ${DEFAULT_RECONCILE_MIN_SCORE})`,
    String(DEFAULT_RECONCILE_MIN_SCORE)
  )
  .option(
    "-n, --limit <n>",
    `Maximum candidate closures to surface (default ${DEFAULT_RECONCILE_LIMIT}, capped at ${MAX_RECONCILE_LIMIT})`,
    String(DEFAULT_RECONCILE_LIMIT)
  )
  .action(async (opts: { project?: string; minScore: string; limit: string }) => {
    // Parse-validate runs OUTSIDE the try/catch for `reconcile` only:
    // this branch predates the project-wide `trapProcessExit` no-throw
    // mock and uses a throw-sentinel mock locally, where leaving parse
    // inside `try` would re-fire `console.error` with the throw-mock's
    // sentinel as the operator-facing message. The new
    // create/update/close/list subcommands below place parse INSIDE
    // `try` because they use the no-throw `trapProcessExit` mock,
    // where `process.exit(1)` returns rather than throws — the
    // doubled-emission failure mode the lifted-parse posture protects
    // against cannot occur there.
    const parsed = parseReconcileCliOptions(opts)
    if (!parsed.ok) {
      console.error(`Reconcile failed: ${parsed.message}`)
      process.exit(1)
      return
    }
    try {
      const services = await initServices()
      const output = await runReconcile(services, parsed.value)
      console.log(output)
    } catch (err) {
      console.error("Reconcile failed:", err instanceof Error ? err.message : err)
      process.exit(1)
    }
  })

// ---------------------------------------------------------------------------
// Shared resolution + format helpers used by create / update / close / list.
// ---------------------------------------------------------------------------

/**
 * Resolve an explicit `--project <name>` to its id under the strict
 * fatal-on-miss contract that `runReconcile` already follows. Returns
 * `undefined` when the caller did not pass `--project`; in that case
 * the auto-detected context project (when present) wins, and a vault
 * outside any configured project flows through as vault-wide.
 */
async function resolveProjectIdForRead(
  services: LoreServices,
  projectName: string | undefined,
  opts: { useContextProject?: boolean } = {}
): Promise<string | undefined> {
  const explicit = validateExplicitProjectScopeName(projectName, "--project", {
    listHint: PROJECT_LIST_HINT,
  })
  if (explicit !== undefined) {
    const found = await resolveProjectScopeName(
      services.projects,
      explicit,
      "--project",
      {
        listHint: PROJECT_LIST_HINT,
      }
    )
    return found.id
  }
  return opts.useContextProject === false ? undefined : services.context.project?.id
}

/**
 * Validate `--tags` against the active profile vocabulary so the CLI
 * fails at the boundary the same way the MCP `tagsSchema` does. Without
 * this gate, an unknown tag would otherwise reach the `pages.update`
 * `multi_select` write and surface as a generic Notion 400, NOT the
 * actionable "use --keywords for free-form" message agents see. Tags
 * for PR numbers, ticket IDs, file paths, and class/function names
 * belong on `--keywords`, not `--tags`.
 */
function parseTagsList(
  raw: string | undefined,
  flag: string,
  vocabulary: readonly string[] = TAG_VOCABULARY
): CliParseResult<string[] | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  const tags = raw
    .split(",")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0)
  if (tags.length === 0) return { ok: true, value: undefined }
  const vocab = new Set<string>(vocabulary)
  const invalid = tags.filter((tag) => !vocab.has(tag))
  if (invalid.length > 0) {
    const quoted = invalid.map((tag) => `"${tag}"`).join(", ")
    return {
      ok: false,
      message:
        `${flag} value${invalid.length === 1 ? "" : "s"} ${quoted} not in the closed tag vocabulary. ` +
        `Accepted tags: ${vocabulary.join(", ")}. ` +
        `For free-form labels (PR numbers, ticket IDs, file paths, class/function names), ` +
        `use --keywords instead.`,
    }
  }
  return { ok: true, value: tags }
}

async function loadActiveTagVocabularyForCli(): Promise<readonly string[]> {
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

function validateState(
  raw: string | undefined,
  flag: string,
  allowed: readonly TaskState[]
): CliParseResult<TaskState | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (!(allowed as readonly string[]).includes(raw)) {
    return {
      ok: false,
      message: `${flag} must be one of ${allowed.join(" | ")}, got "${raw}"`,
    }
  }
  return { ok: true, value: raw as TaskState }
}

function validateOptionalReason(
  raw: string | undefined,
  flag: string
): CliParseResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  const trimmed = raw.trim()
  if (!trimmed) {
    return { ok: false, message: `${flag} must not be blank or whitespace-only` }
  }
  return { ok: true, value: trimmed }
}

function validateYmd(
  raw: string | undefined,
  flag: string
): CliParseResult<string | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (!YMD_REGEX.test(raw)) {
    return { ok: false, message: `${flag} ${YMD_HINT}, got "${raw}"` }
  }
  return { ok: true, value: raw }
}

/**
 * Validate a clearable YYYY-MM-DD value. An empty string clears the
 * column on update — same convention `lore-task action='update'` uses
 * via `clearableYmdDateSchema`. `undefined` means "leave untouched."
 */
function validateClearableYmd(
  raw: string | undefined,
  flag: string
): CliParseResult<string | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === "") return { ok: true, value: null }
  if (!YMD_REGEX.test(raw)) {
    return {
      ok: false,
      message: `${flag} ${YMD_HINT} or empty string to clear, got "${raw}"`,
    }
  }
  return { ok: true, value: raw }
}

/**
 * Render the due-date suffix for a task row. Three branches:
 *
 * - row has a `Review By` and is overdue → `"5 days overdue (review by 2024-01-01)"`
 *   (singular form for `1 day`, `due today` when overdueDays is 0).
 * - row has a `Review By` but is in-window → `"due 2026-06-01"`.
 * - row has no `Review By` → `"no due date"`.
 *
 * Pulled out so it's unit-testable independently of the surrounding
 * row format — both `formatTaskListRow` and the bullet-row test pin
 * the wording through this helper.
 */
export function renderDueLabel(task: TaskSummary, today: string): string {
  const overdueDays = taskDaysOverdue(task, today)
  if (overdueDays !== null && task.reviewBy) {
    if (overdueDays === 0) return `due today (review by ${task.reviewBy})`
    const noun = overdueDays === 1 ? "day" : "days"
    return `${overdueDays} ${noun} overdue (review by ${task.reviewBy})`
  }
  return task.reviewBy ? `due ${task.reviewBy}` : "no due date"
}

function formatTaskListRow(task: TaskSummary, today: string): string {
  const stateLabel = task.taskState ?? "open"
  const overdueDays = taskDaysOverdue(task, today)
  const due = renderDueLabel(task, today)
  const blocked = task.blockedBy ? ` — blocked by ${task.blockedBy}` : ""
  const marker = overdueDays !== null && overdueDays > 0 ? "⚠ " : ""
  return (
    `- ${marker}${task.title} [${stateLabel}]${blocked} (${due})\n` + `  ID: ${task.id}`
  )
}

/**
 * The fields that reuse on `lore tasks create` structurally drops
 * because `findExactReuseTarget` consumes only `(subject, entity,
 * projectIds)`. Surfaced in the response so an operator who tried to
 * land a state transition or due-date bump alongside the create knows
 * none of those fields took effect, and is pointed at `lore tasks
 * update <id>` for the correction.
 *
 * Parallels the MCP-side `collectIgnoredReuseFields` so
 * the CLI surface and the MCP surface produce the same reuse audit
 * for the same operator-supplied fields. `--project` is excluded
 * because it participates in the reuse-key (project-set), not as
 * ignored side-channel data. `--topic` IS listed because
 * `topics.getOrCreate` is deferred until after the reuse gate (per
 * the reuse short-circuit at `runTaskCreate`); on a reuse hit, a
 * caller-passed `--topic` had no observable effect on the existing
 * row's topic relation. Without this, `lore tasks create "T"
 * --project Widget --topic Reviews` could reuse an existing task,
 * silently skip the topic create, and produce no audit signal — the
 * operator would believe the topic landed when it didn't, with no
 * `lore tasks update --topic` flag to apply it after the fact.
 */
function collectIgnoredCreateReuseFields(opts: CreateCliOptions): string[] {
  const ignored: string[] = []
  if (opts.description !== undefined) ignored.push("--description")
  if (opts.state !== undefined) ignored.push("--state")
  if (opts.blockedBy !== undefined) ignored.push("--blocked-by")
  if (opts.dueDate !== undefined) ignored.push("--due-date")
  if (opts.topicName !== undefined) ignored.push("--topic")
  if (opts.tags !== undefined && opts.tags.length > 0) ignored.push("--tags")
  if (opts.keywords !== undefined) ignored.push("--keywords")
  if (opts.synopsis !== undefined) ignored.push("--synopsis")
  return ignored
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

export interface CreateCliOptions {
  subject: string
  description: string | undefined
  entity: string | undefined
  state: TaskState | undefined
  blockedBy: string | undefined
  dueDate: string | undefined
  projectName: string | undefined
  topicName: string | undefined
  tags: string[] | undefined
  keywords: string | undefined
  synopsis: string | undefined
  allowPointerSubject?: boolean
}

export interface CreateCliResultData {
  reused: boolean
  id: string
  title: string
  state: TaskState
  projectIds: string[]
  projectLabel: string
  topicLabel: string | null
  entity: string | null
  reviewBy: string | null
  blockedBy: string | null
  warnings: string[]
  ignoredOnReuse: string[] | null
}

export interface CreateCliResult {
  text: string
  data: CreateCliResultData
}

export function parseCreateCliOptions(
  subject: string,
  raw: {
    description?: string
    entity?: string
    state?: string
    blockedBy?: string
    dueDate?: string
    project?: string
    topic?: string
    tags?: string
    keywords?: string
    synopsis?: string
    allowPointerSubject?: boolean
  },
  tagVocabulary: readonly string[] = TAG_VOCABULARY
): CliParseResult<CreateCliOptions> {
  if (!subject.trim()) {
    return { ok: false, message: "<subject> must be a non-empty string" }
  }
  const state = validateState(raw.state, "--state", TASK_STATES)
  if (!state.ok) return state
  const dueDate = validateYmd(raw.dueDate, "--due-date")
  if (!dueDate.ok) return dueDate
  const tags = parseTagsList(raw.tags, "--tags", tagVocabulary)
  if (!tags.ok) return tags
  // Cross-field rule matches the MCP handler's `isUnusableBlockerLabel`
  // guard: a `blocked` task without a meaningful blocker label is
  // unactionable. Whitespace-only blockers (`"   "`) trip the same gate
  // — the column would render as visually blank in `lore tasks list`,
  // which is the same triage hazard as a missing label.
  if (state.value === "blocked" && isUnusableBlockerLabel(raw.blockedBy)) {
    return {
      ok: false,
      message:
        '--state "blocked" requires --blocked-by naming the dependency ' +
        "(PR number, person, external service); whitespace-only labels are rejected",
    }
  }
  const subjectValidation = validateTaskSubjectForCreate({
    subject,
    description: raw.description,
    synopsis: raw.synopsis,
    dueDate: dueDate.value,
    blockedBy: raw.blockedBy,
    allowPointerSubject: raw.allowPointerSubject,
  })
  if (!subjectValidation.ok) {
    return { ok: false, message: subjectValidation.message }
  }
  return {
    ok: true,
    value: {
      subject,
      description: raw.description,
      entity: raw.entity,
      state: state.value,
      blockedBy: raw.blockedBy,
      dueDate: dueDate.value,
      projectName: raw.project,
      topicName: raw.topic,
      tags: tags.value,
      keywords: raw.keywords,
      synopsis: raw.synopsis,
      allowPointerSubject: raw.allowPointerSubject,
    },
  }
}

/**
 * Create a task and render an operator-friendly confirmation. Calls
 * `services.tasks.create` directly — same TaskService the MCP handler
 * uses — and runs the same assertive-reuse probe via
 * `findDuplicateActiveTasks` + `findExactReuseTarget` so a duplicate
 * `lore tasks create` short-circuits to `Reused existing task: ...`
 * instead of landing a second structurally-identical row in the
 * vault. Idempotency parity with `lore-task action='create'` is the
 * load-bearing rule — the task-reuse predicate's docstring documents
 * the vocabulary the response surfaces.
 *
 * Returns `{ text, data }` so the action wrapper can route to either
 * the human-facing text rendering or a JSON dump under `--json`. The
 * leading `Created task:` / `Reused existing task:` prefix is the
 * stable contract programmatic shell consumers parse.
 */
export async function runTaskCreate(
  services: LoreServices,
  opts: CreateCliOptions
): Promise<CreateCliResult> {
  const subjectValidation = validateTaskSubjectForCreate(opts)
  if (!subjectValidation.ok) {
    throw new Error(subjectValidation.message)
  }
  const features = services.features ?? resolveFeatureFlags()
  let projectId: string | undefined
  let projectLabel: string

  const explicit = validateExplicitProjectScopeName(opts.projectName, "--project", {
    listHint: PROJECT_LIST_HINT,
  })
  if (explicit !== undefined) {
    const found = await resolveProjectScopeName(
      services.projects,
      explicit,
      "--project",
      {
        listHint: PROJECT_LIST_HINT,
      }
    )
    projectId = found.id
    projectLabel = found.name
  } else if (services.context.project) {
    projectId = services.context.project.id
    projectLabel = services.context.project.name
  } else {
    projectLabel = "none (repo-wide)"
  }

  // Assertive-reuse probe. Mirrors the `lore-task` MCP handler's
  // `handleCreate`: probe for active tasks with the same entity,
  // then short-circuit when an exact `(subject, entity,
  // projectIds)` match exists. The probe runs BEFORE create so a
  // duplicate doesn't leak into Notion before we can detect it. Probe
  // failures degrade silently to "no candidates" and the create
  // proceeds — same posture as the MCP handler.
  //
  // Decode at the CLI boundary so every consumer of
  // `findDuplicateActiveTasks` decodes once at its own boundary. Today
  // the helper re-decodes internally (`near-duplicate.ts:findDuplicateActiveTasks`
  // calls it "load-bearing for non-MCP callers that don't pre-decode"
  // — i.e. exactly this CLI). Decoding here pins the contract so a
  // future helper-internal cleanup that drops the redundant decode
  // doesn't silently break us.
  //
  // `projectIds: []` is the unscoped (no `--project`, no context)
  // shape: `findExactReuseTarget`'s set-equality check accepts only
  // other `[]`-scoped candidates as reuse targets. Cross-scope reuse
  // is intentionally rejected (per `near-duplicate.ts:findExactReuseTarget`'s
  // contract), so an unscoped create cannot reuse a scoped row.
  const probeEntity = decodeTextEntities(opts.entity ?? opts.subject)
  const projectIds = projectId ? [projectId] : []
  const duplicates = await findDuplicateActiveTasks(services.tasks, {
    entity: probeEntity,
    projectId,
    features,
    onError: (err) =>
      debugLogPartialFailures("lore tasks create", [
        { rootId: "duplicate-probe", error: err },
      ]),
  })
  const reuseTarget = findExactReuseTarget(duplicates, {
    subject: opts.subject,
    entity: probeEntity,
    projectIds,
    features,
  })

  if (reuseTarget !== null) {
    // Reuse path: structurally-identical task already exists. Render
    // the same response shape the MCP handler does, but with CLI-form
    // CTAs (`lore tasks update <id>` / `lore tasks close <id>`) so an
    // operator's next step lives in their shell, not a tool host.
    const ignored = collectIgnoredCreateReuseFields(opts)
    const warnings: string[] = []
    if (opts.topicName !== undefined && projectId === undefined) {
      warnings.push(`Topic "${opts.topicName}" skipped (requires a project scope)`)
    }
    const lines: string[] = [
      `Reused existing task: "${reuseTarget.title}" (${reuseTarget.id})`,
      `State: ${reuseTarget.taskState ?? "open"}`,
      `Project: ${projectLabel}`,
    ]
    if (reuseTarget.entity && reuseTarget.entity !== reuseTarget.title) {
      lines.push(`Entity: ${reuseTarget.entity}`)
    }
    if (reuseTarget.reviewBy) lines.push(`Due: ${reuseTarget.reviewBy}`)
    if (reuseTarget.blockedBy) lines.push(`Blocked by: ${reuseTarget.blockedBy}`)
    if (warnings.length > 0) lines.push(`Warnings: ${warnings.join("; ")}`)
    if (ignored.length > 0) {
      lines.push(
        `Ignored on reuse: ${ignored.join(", ")} — use ` +
          `\`lore tasks update ${reuseTarget.id} ...\` to change them.`
      )
    }
    lines.push(
      "",
      "Subject and entity match an existing active task; nothing was created.",
      `Update the existing row if needed: lore tasks update ${reuseTarget.id} ...`,
      `Close it when the work is done: lore tasks close ${reuseTarget.id}`
    )

    return {
      text: lines.join("\n"),
      data: {
        reused: true,
        id: reuseTarget.id,
        title: reuseTarget.title,
        state: (reuseTarget.taskState ?? "open") as TaskState,
        projectIds: reuseTarget.projectIds,
        projectLabel,
        topicLabel: null,
        entity:
          reuseTarget.entity && reuseTarget.entity !== reuseTarget.title
            ? reuseTarget.entity
            : null,
        reviewBy: reuseTarget.reviewBy ?? null,
        blockedBy: reuseTarget.blockedBy || null,
        warnings,
        ignoredOnReuse: ignored.length > 0 ? ignored : null,
      },
    }
  }

  let topicId: string | undefined
  let topicLabel: string | null = null
  const warnings: string[] = []
  if (opts.topicName && projectId) {
    const topic = await services.topics.getOrCreate(opts.topicName, [projectId])
    topicId = topic.id
    topicLabel = topic.name
  } else if (opts.topicName) {
    warnings.push(`Topic "${opts.topicName}" skipped (requires a project scope)`)
  }

  const task = await services.tasks.create({
    subject: opts.subject,
    description: opts.description,
    entity: opts.entity,
    state: opts.state,
    blockedBy: opts.blockedBy,
    dueDate: opts.dueDate,
    projectIds: projectId ? [projectId] : undefined,
    topicId,
    tags: opts.tags,
    keywords: opts.keywords,
    synopsis: opts.synopsis,
  })

  const lines = [
    `Created task: "${task.title}" (${task.id})`,
    `State: ${task.taskState ?? "open"}`,
    `Project: ${projectLabel}`,
  ]
  // Suppress the Topic line when no `--topic` was supplied so an
  // operator scanning the response sees only the topics they actually
  // touched.
  if (topicLabel !== null) {
    lines.push(`Topic: ${topicLabel}`)
  }
  if (task.entity && task.entity !== task.title) {
    lines.push(`Entity: ${task.entity}`)
  }
  if (task.reviewBy) {
    lines.push(`Due: ${task.reviewBy}`)
  }
  if (task.blockedBy) {
    lines.push(`Blocked by: ${task.blockedBy}`)
  }
  if (warnings.length > 0) {
    lines.push(`Warnings: ${warnings.join("; ")}`)
  }

  return {
    text: lines.join("\n"),
    data: {
      reused: false,
      id: task.id,
      title: task.title,
      state: (task.taskState ?? "open") as TaskState,
      projectIds: task.projectIds,
      projectLabel,
      topicLabel,
      entity: task.entity && task.entity !== task.title ? task.entity : null,
      reviewBy: task.reviewBy ?? null,
      blockedBy: task.blockedBy || null,
      warnings,
      ignoredOnReuse: null,
    },
  }
}

const createCommand = new Command("create")
  .description("Create a new task")
  .argument("<subject>", "One-line task subject (becomes the page title)")
  .option("-p, --project <name>", "Project name (defaults to cwd-resolved project)")
  .option("-d, --description <text>", "Description (rendered as page body)")
  .option(
    "-e, --entity <name>",
    "Normalized entity name the task is about (defaults to subject)"
  )
  .option(
    "-s, --state <state>",
    `Initial state: ${TASK_STATES.join(" | ")} (default open)`
  )
  .option(
    "--blocked-by <label>",
    "Free-form blocker label; required when --state=blocked"
  )
  .option("--due-date <yyyy-mm-dd>", "Due date / next review")
  .option(
    "--topic <name>",
    "Topic name within the project (created automatically if missing)"
  )
  .option("--tags <list>", "Comma-separated tags from the closed vocabulary")
  .option("--keywords <text>", "Free-form keywords")
  .option("--synopsis <text>", "1–2 sentence synopsis of the task")
  .option(
    "--allow-pointer-subject",
    "Bypass the pointer-only subject guard for false positives"
  )
  .option("--json", "Emit the result as a JSON object instead of human text")
  .action(
    async (
      subject: string,
      opts: {
        project?: string
        description?: string
        entity?: string
        state?: string
        blockedBy?: string
        dueDate?: string
        topic?: string
        tags?: string
        keywords?: string
        synopsis?: string
        allowPointerSubject?: boolean
        json?: boolean
      }
    ) => {
      try {
        const tagVocabulary = await loadActiveTagVocabularyForCli()
        const parsed = parseCreateCliOptions(subject, opts, tagVocabulary)
        if (!parsed.ok) {
          console.error(`Task create failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const result = await runTaskCreate(services, parsed.value)
        console.log(opts.json ? JSON.stringify(result.data, null, 2) : result.text)
      } catch (err) {
        console.error("Task create failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

export interface UpdateCliOptions {
  taskId: string
  state: TaskState | undefined
  blockedBy: string | undefined
  entity: string | undefined
  dueDate: string | null | undefined
  subject: string | undefined
  description: string | undefined
  tags: string[] | undefined
  keywords: string | undefined
  synopsis: string | undefined
}

export interface UpdateCliResultData {
  id: string
  title: string
  state: TaskState
  projectIds: string[]
  entity: string | null
  reviewBy: string | null
  blockedBy: string | null
}

export interface UpdateCliResult {
  text: string
  data: UpdateCliResultData
}

export function parseUpdateCliOptions(
  taskId: string,
  raw: {
    state?: string
    blockedBy?: string
    entity?: string
    dueDate?: string
    subject?: string
    description?: string
    tags?: string
    keywords?: string
    synopsis?: string
  },
  tagVocabulary: readonly string[] = TAG_VOCABULARY
): CliParseResult<UpdateCliOptions> {
  if (!taskId.trim()) {
    return { ok: false, message: "<task-id> must be a non-empty string" }
  }
  const state = validateState(raw.state, "--state", TASK_STATES)
  if (!state.ok) return state
  const dueDate = validateClearableYmd(raw.dueDate, "--due-date")
  if (!dueDate.ok) return dueDate
  const tags = parseTagsList(raw.tags, "--tags", tagVocabulary)
  if (!tags.ok) return tags
  // Mirror MCP's `isUnusableBlockerLabel` guard: transitioning into
  // `blocked` must restate a meaningful blocker label even if the row
  // already had one set. `--blocked-by ""` (and whitespace-only `"   "`)
  // would otherwise be interpreted as the explicit clear sentinel — but
  // a clear under `--state=blocked` lands the same unactionable row the
  // create-side guard exists to prevent. `--blocked-by ""` remains a
  // valid clear sentinel only when the requested state is NOT `blocked`.
  if (state.value === "blocked" && isUnusableBlockerLabel(raw.blockedBy)) {
    return {
      ok: false,
      message:
        '--state "blocked" requires --blocked-by in the same call ' +
        "(restate the blocker explicitly even if the row already had one); " +
        "whitespace-only labels are rejected",
    }
  }
  return {
    ok: true,
    value: {
      taskId,
      state: state.value,
      blockedBy: raw.blockedBy,
      entity: raw.entity,
      dueDate: dueDate.value,
      subject: raw.subject,
      description: raw.description,
      tags: tags.value,
      keywords: raw.keywords,
      synopsis: raw.synopsis,
    },
  }
}

export async function runTaskUpdate(
  services: LoreServices,
  opts: UpdateCliOptions
): Promise<UpdateCliResult> {
  const updated = await services.tasks.update(opts.taskId, {
    state: opts.state,
    blockedBy: opts.blockedBy,
    entity: opts.entity,
    dueDate: opts.dueDate,
    subject: opts.subject,
    description: opts.description,
    tags: opts.tags,
    keywords: opts.keywords,
    synopsis: opts.synopsis,
  })

  const lines = [
    `Updated task: "${updated.title}" (${updated.id})`,
    `State: ${updated.taskState ?? "open"}`,
  ]
  if (updated.reviewBy) lines.push(`Due: ${updated.reviewBy}`)
  if (updated.blockedBy) lines.push(`Blocked by: ${updated.blockedBy}`)
  if (updated.entity && updated.entity !== updated.title) {
    lines.push(`Entity: ${updated.entity}`)
  }
  return {
    text: lines.join("\n"),
    data: {
      id: updated.id,
      title: updated.title,
      state: (updated.taskState ?? "open") as TaskState,
      projectIds: updated.projectIds,
      entity: updated.entity && updated.entity !== updated.title ? updated.entity : null,
      reviewBy: updated.reviewBy ?? null,
      blockedBy: updated.blockedBy || null,
    },
  }
}

const updateCommand = new Command("update")
  .description("Update an existing task")
  .argument("<task-id>", "ID of the task to update")
  .option("-s, --state <state>", `New state: ${TASK_STATES.join(" | ")}`)
  .option(
    "--blocked-by <label>",
    "Blocker label (pass empty string to clear; required with --state=blocked)"
  )
  .option("--entity <name>", "Rename the task's entity")
  .option("--due-date <yyyy-mm-dd>", "New due date (pass empty string to clear)")
  .option("--subject <text>", "New subject (page title)")
  .option("-d, --description <text>", "Replace the description body")
  .option(
    "--tags <list>",
    "Comma-separated tags from the closed vocabulary (replaces existing)"
  )
  .option("--keywords <text>", "Replace free-form keywords")
  .option("--synopsis <text>", "Replace the synopsis (empty string clears)")
  .option("--json", "Emit the result as a JSON object instead of human text")
  .action(
    async (
      taskId: string,
      opts: {
        state?: string
        blockedBy?: string
        entity?: string
        dueDate?: string
        subject?: string
        description?: string
        tags?: string
        keywords?: string
        synopsis?: string
        json?: boolean
      }
    ) => {
      try {
        const tagVocabulary = await loadActiveTagVocabularyForCli()
        const parsed = parseUpdateCliOptions(taskId, opts, tagVocabulary)
        if (!parsed.ok) {
          console.error(`Task update failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const result = await runTaskUpdate(services, parsed.value)
        console.log(opts.json ? JSON.stringify(result.data, null, 2) : result.text)
      } catch (err) {
        console.error("Task update failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

// ---------------------------------------------------------------------------
// close
// ---------------------------------------------------------------------------

export interface CloseCliOptions {
  taskId: string
  state: "done" | "cancelled"
  reason?: string
}

export interface CloseCliPartialFailureData {
  kind: "task-close-partial"
  message: string
  doneAt: string
  failedPhase: "closure-note"
  persisted: {
    state: true
    doneAt: true
    closureNote: false
  }
  causeMessage: string
  attemptedClosureNote: string
}

export interface CloseCliResultData {
  id: string
  state: "done" | "cancelled"
  doneAt: string | null
  closureNote: string | null
  partialFailure: CloseCliPartialFailureData | null
}

export interface CloseCliResult {
  text: string
  data: CloseCliResultData
}

export function parseCloseCliOptions(
  taskId: string,
  raw: { state?: string; reason?: string }
): CliParseResult<CloseCliOptions> {
  if (!taskId.trim()) {
    return { ok: false, message: "<task-id> must be a non-empty string" }
  }
  const state = validateState(raw.state, "--state", CLOSE_STATES)
  if (!state.ok) return state
  const reason = validateOptionalReason(raw.reason, "--reason")
  if (!reason.ok) return reason
  return {
    ok: true,
    value: {
      taskId,
      state: (state.value ?? "done") as "done" | "cancelled",
      reason: reason.value,
    },
  }
}

export async function runTaskClose(
  services: LoreServices,
  opts: CloseCliOptions
): Promise<CloseCliResult> {
  let closeResult: Awaited<ReturnType<typeof services.tasks.close>> | undefined =
    undefined
  let partialFailure: CloseCliPartialFailureData | null = null
  try {
    closeResult =
      opts.reason !== undefined
        ? await services.tasks.close(opts.taskId, opts.state, { reason: opts.reason })
        : await services.tasks.close(opts.taskId, opts.state)
  } catch (err) {
    if (!(err instanceof TaskClosePartialFailureError)) throw err
    partialFailure = {
      kind: err.kind,
      message: err.message,
      doneAt: err.doneAt,
      failedPhase: err.failedPhase,
      persisted: err.persisted,
      causeMessage: err.details.closureNoteCauseMessage,
      attemptedClosureNote: err.closureNote,
    }
  }
  const closureNote = closeResult?.closureNote ?? null

  let doneAt: string | null = closeResult?.doneAt ?? null
  try {
    // Re-read the post-close row so the response can echo the stamped
    // `Done At`. On a vault that hasn't migrated the Memories DS to add
    // the column, this throws and we suppress the line — graceful
    // degradation, no version gate. Same posture as the MCP handler.
    const reread = await services.tasks.getById(opts.taskId)
    doneAt = reread.doneAt ?? doneAt
  } catch {
    // Ignore re-read failures: the close itself succeeded, and the
    // Done At echo is a courtesy line.
    if (partialFailure) doneAt = partialFailure.doneAt
  }

  const text =
    `Closed task ${opts.taskId} (state: ${opts.state})` +
    (doneAt ? `\nDone at: ${doneAt}` : "") +
    (closureNote
      ? `\nClosure note appended.`
      : partialFailure
        ? `\nClosure note failed: ${partialFailure.causeMessage}`
        : opts.reason
          ? `\nClosure note skipped: task was already closed.`
          : "")
  return {
    text,
    data: {
      id: opts.taskId,
      state: opts.state,
      doneAt,
      closureNote,
      partialFailure,
    },
  }
}

const closeCommand = new Command("close")
  .description("Mark a task done (or cancelled)")
  .argument("<task-id>", "ID of the task to close")
  .option(
    "-s, --state <state>",
    `Closing state: ${CLOSE_STATES.join(" | ")} (default done)`
  )
  .option("-r, --reason <text>", "Optional closure rationale appended to the task body")
  .option("--json", "Emit the result as a JSON object instead of human text")
  .action(
    async (taskId: string, opts: { state?: string; reason?: string; json?: boolean }) => {
      try {
        const parsed = parseCloseCliOptions(taskId, opts)
        if (!parsed.ok) {
          console.error(`Task close failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const result = await runTaskClose(services, parsed.value)
        console.log(opts.json ? JSON.stringify(result.data, null, 2) : result.text)
        if (result.data.partialFailure) {
          process.exit(1)
        }
      } catch (err) {
        console.error("Task close failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

// ---------------------------------------------------------------------------
// close-many
// ---------------------------------------------------------------------------

export interface CloseManyCliOptions {
  idsFrom: string
  state: "done" | "cancelled"
  reason?: string
}

export interface CloseManyCliRunOptions {
  ids: string[]
  state: "done" | "cancelled"
  reason?: string
}

export interface CloseManyCliResultData {
  attempted: number
  closed: number
  noop: number
  failed: Array<{ id: string; error: string }>
  results: Array<{
    id: string
    status: "closed" | "already-closed" | "failed"
    state?: "done" | "cancelled"
    doneAt?: string | null
    closureNote?: string | null
    error?: string
  }>
}

export interface CloseManyCliResult {
  text: string
  data: CloseManyCliResultData
}

export function parseCloseManyCliOptions(raw: {
  idsFrom?: string
  state?: string
  reason?: string
}): CliParseResult<CloseManyCliOptions> {
  const idsFrom = raw.idsFrom?.trim()
  if (!idsFrom) {
    return { ok: false, message: "--ids-from <path|-> is required" }
  }
  const state = validateState(raw.state, "--state", CLOSE_STATES)
  if (!state.ok) return state
  const reason = validateOptionalReason(raw.reason, "--reason")
  if (!reason.ok) return reason
  return {
    ok: true,
    value: {
      idsFrom,
      state: (state.value ?? "done") as "done" | "cancelled",
      reason: reason.value,
    },
  }
}

export function parseCloseManyIds(raw: string): CliParseResult<string[]> {
  try {
    return { ok: true, value: normalizeCloseManyTaskIds(raw.split(/\r?\n/)) }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

async function readStdinText(): Promise<string> {
  process.stdin.setEncoding("utf8")
  let data = ""
  for await (const chunk of process.stdin) {
    data += typeof chunk === "string" ? chunk : chunk.toString("utf8")
  }
  return data
}

async function readIdsFromSource(idsFrom: string): Promise<string> {
  if (idsFrom === "-") return readStdinText()
  try {
    return await readFile(idsFrom, "utf8")
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Unable to read --ids-from ${idsFrom}: ${message}`, {
      cause: err,
    })
  }
}

export async function runTaskCloseMany(
  services: LoreServices,
  opts: CloseManyCliRunOptions
): Promise<CloseManyCliResult> {
  const result = await services.tasks.closeMany({
    ids: opts.ids,
    state: opts.state,
    reason: opts.reason,
  })
  const data: CloseManyCliResultData = {
    attempted: result.attempted,
    closed: result.closed,
    noop: result.noop,
    failed: result.failed,
    results: result.outcomes,
  }
  const lines = [
    `Closed task batch: ${result.attempted} attempted, ${result.closed} closed, ` +
      `${result.noop} already closed, ${result.failed.length} failed.`,
  ]
  if (result.failed.length > 0) {
    lines.push("", "Failed:")
    for (const failure of result.failed) {
      lines.push(`- ${failure.id}: ${failure.error}`)
    }
  }
  return { text: lines.join("\n"), data }
}

const closeManyCommand = new Command("close-many")
  .description("Close a newline-delimited list of task IDs")
  .option("--ids-from <path|->", "Read task IDs from a newline-delimited file or stdin")
  .option(
    "-s, --state <state>",
    `Closing state: ${CLOSE_STATES.join(" | ")} (default done)`
  )
  .option("-r, --reason <text>", "Optional closure rationale appended to each task body")
  .option("--json", "Emit the result as a JSON object instead of human text")
  .action(
    async (opts: {
      idsFrom?: string
      state?: string
      reason?: string
      json?: boolean
    }) => {
      try {
        const parsed = parseCloseManyCliOptions(opts)
        if (!parsed.ok) {
          console.error(`Task close-many failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const rawIds = await readIdsFromSource(parsed.value.idsFrom)
        const ids = parseCloseManyIds(rawIds)
        if (!ids.ok) {
          console.error(`Task close-many failed: ${ids.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const result = await runTaskCloseMany(services, {
          ids: ids.value,
          state: parsed.value.state,
          reason: parsed.value.reason,
        })
        console.log(opts.json ? JSON.stringify(result.data, null, 2) : result.text)
        if (result.data.failed.length > 0) {
          process.exit(1)
          return
        }
      } catch (err) {
        console.error("Task close-many failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

export interface ListCliOptions {
  projectName: string | undefined
  allProjects: boolean
  entity: string | undefined
  state: TaskState | undefined
  dueBefore: string | undefined
  limit: number
}

export interface ListCliRow {
  id: string
  title: string
  projectIds: string[]
  projects: string[]
  state: TaskState
  reviewBy: string | null
  blockedBy: string | null
  entity: string | null
  overdueDays: number | null
}

/**
 * Distinguishes WHY the cursor walk stopped while more matching rows
 * remain in Notion. The two saturation cases need different operator
 * nudges:
 *
 * - `"user-limit"` — the loop exited because `tasks.length === --limit`
 *   while `nextCursor` was still set. The right nudge is "showed first
 *   N rows; raise --limit to see more, or narrow filters." The 500-row
 *   safety cap is irrelevant in this case (we stopped well before it).
 * - `"safety-cap"` — the loop hit `MAX_LIST_PAGES` with `nextCursor`
 *   still set without reaching the user's `--limit`. The right nudge
 *   is the original "narrow with --project / --entity / --state /
 *   --due-before for an exact total" — the user already asked for more
 *   rows than the safety cap can fetch.
 * - `null` — the result set was exhausted (`nextCursor` undefined);
 *   totals are exact and no footer is rendered.
 */
type ListSaturationReason = "user-limit" | "safety-cap" | null

export interface ListCliResultData {
  total: number
  distinctTaskIds: number
  multiProjectTaskCount: number
  saturated: boolean
  /**
   * Why the walk stopped short of exhausting Notion's result set.
   * `"user-limit"` is the common case for default `--limit 10` against
   * a vault with more matching rows; `"safety-cap"` only fires when
   * the requested limit exceeded the 500-row walk budget. `null`
   * means the result set was exhausted (totals are exact). Distinct
   * from `saturated` because a JSON consumer needs the reason, not
   * just the boolean — `saturated && reason === "user-limit"` is the
   * "raise --limit" signal; `saturated && reason === "safety-cap"`
   * is the "narrow filters" signal.
   */
  saturationReason: ListSaturationReason
  maxFetched: number
  overdue: ListCliRow[]
  active: ListCliRow[]
  filter: {
    projectId: string | null
    allProjects: boolean
    entity: string | null
    state: TaskState | null
    dueBefore: string | null
    limit: number
  }
}

export interface ListCliResult {
  text: string
  data: ListCliResultData
}

export function parseListCliOptions(raw: {
  project?: string
  allProjects?: boolean
  entity?: string
  state?: string
  dueBefore?: string
  limit: string
}): CliParseResult<ListCliOptions> {
  if (raw.project !== undefined && raw.allProjects === true) {
    return {
      ok: false,
      message:
        "--project and --all-projects are mutually exclusive; pass one or the other",
    }
  }
  const state = validateState(raw.state, "--state", TASK_STATES)
  if (!state.ok) return state
  const dueBefore = validateYmd(raw.dueBefore, "--due-before")
  if (!dueBefore.ok) return dueBefore
  const parsedLimit = parsePositiveDecimalInteger("--limit", raw.limit)
  if (!parsedLimit.ok) return parsedLimit
  if (parsedLimit.value > MAX_LIST_LIMIT) {
    return {
      ok: false,
      message: `--limit must be between 1 and ${MAX_LIST_LIMIT}, got ${parsedLimit.value}`,
    }
  }
  return {
    ok: true,
    value: {
      projectName: raw.project,
      allProjects: raw.allProjects === true,
      entity: raw.entity,
      state: state.value,
      dueBefore: dueBefore.value,
      limit: parsedLimit.value,
    },
  }
}

async function projectNameMapForRows(
  services: LoreServices,
  tasks: readonly TaskSummary[]
): Promise<Map<string, string>> {
  const ids = new Set(tasks.flatMap((task) => task.projectIds))
  if (ids.size === 0) return new Map()
  let projects
  try {
    projects = await services.projects.list("any")
  } catch (err) {
    debugLogPartialFailures("lore tasks list", [
      { rootId: "project-name-enrichment", error: err },
    ])
    return new Map()
  }
  return new Map(
    projects
      .filter((project) => ids.has(project.id))
      .map((project) => [project.id, project.name])
  )
}

function rowFromTask(
  task: TaskSummary,
  today: string,
  projectNameById: ReadonlyMap<string, string>
): ListCliRow {
  const projects = task.projectIds
    .map((id) => projectNameById.get(id))
    .filter((name): name is string => name !== undefined)
  return {
    id: task.id,
    title: task.title,
    projectIds: [...task.projectIds],
    projects,
    state: (task.taskState ?? "open") as TaskState,
    reviewBy: task.reviewBy ?? null,
    blockedBy: task.blockedBy || null,
    entity: task.entity && task.entity !== task.title ? task.entity : null,
    overdueDays: taskDaysOverdue(task, today),
  }
}

export async function runTaskList(
  services: LoreServices,
  opts: ListCliOptions
): Promise<ListCliResult> {
  const projectId = await resolveProjectIdForRead(services, opts.projectName, {
    useContextProject: !opts.allProjects,
  })
  // Default state set matches the MCP `lore-task action='list'` default —
  // active states only. An explicit `--state done` (or `cancelled`) widens
  // to closed work, same posture as the MCP filter.
  const states: TaskState[] = opts.state ? [opts.state] : [...ACTIVE_TASK_STATES]
  const listOpts = {
    projectId,
    entities: opts.entity ? [opts.entity] : undefined,
    states,
    dueBefore: opts.dueBefore,
  }

  // Cursor-walk the listing up to the operator's `--limit`, capped at
  // `MAX_LIST_PAGES`. Each iteration requests the smaller of the
  // remaining rows and `LIST_PAGE_SIZE` so a small `--limit` still
  // issues just one Notion call.
  const tasks: TaskSummary[] = []
  let nextCursor: string | undefined
  let pages = 0
  do {
    const remaining = opts.limit - tasks.length
    if (remaining <= 0) break
    const pageSize = Math.min(remaining, LIST_PAGE_SIZE)
    const page = await services.tasks.list({
      ...listOpts,
      limit: pageSize,
      ...(nextCursor ? { startCursor: nextCursor } : {}),
    })
    tasks.push(...page.items)
    nextCursor = page.nextCursor
    pages += 1
  } while (nextCursor && pages < MAX_LIST_PAGES && tasks.length < opts.limit)

  // Distinguish stop-reasons. The two saturation cases need different
  // operator nudges:
  //
  //  - User-limit: walked exactly to `--limit` while `nextCursor` was
  //    still set AND the safety cap did NOT fire. The walk stopped
  //    because the operator asked for N rows. The right nudge is
  //    "raise --limit (or narrow filters)."
  //  - Safety-cap: hit `MAX_LIST_PAGES` (500 fetched rows) with
  //    `nextCursor` still set. The walk budget was the binding
  //    constraint. The right nudge is "narrow filters for an exact
  //    total."
  //
  // Safety-cap wins when both terminal conditions fire simultaneously
  // (`--limit === MAX_LIST_LIMIT === 500` against a saturated vault).
  // `--limit > 500` is rejected at parse time, so "raise --limit" at
  // that boundary is unactionable advice; the safety cap is the
  // constraint the operator can't move past. The classifier picks
  // `pages >= MAX_LIST_PAGES` first to encode that priority.
  let saturationReason: ListSaturationReason = null
  if (nextCursor !== undefined) {
    saturationReason = pages >= MAX_LIST_PAGES ? "safety-cap" : "user-limit"
  }
  const saturated = saturationReason !== null

  const today = new Date().toISOString().split("T")[0]!

  const filter = {
    projectId: projectId ?? null,
    allProjects: opts.allProjects,
    entity: opts.entity ?? null,
    state: opts.state ?? null,
    dueBefore: opts.dueBefore ?? null,
    limit: opts.limit,
  } as const
  const maxFetched = LIST_PAGE_SIZE * MAX_LIST_PAGES

  if (tasks.length === 0) {
    const filterHint = opts.entity ? ` matching "${opts.entity}"` : ""
    // An empty result with `saturationReason === "safety-cap"` means we
    // walked the full `MAX_LIST_PAGES` without finding a row matching
    // the filter — possible on an entity / state / due-before query
    // that hits unrelated rows in cursor order. `"user-limit"` is
    // structurally impossible on the empty path (we'd have stopped at
    // `--limit` rows, but `--limit` is positive and `tasks.length === 0`).
    const text =
      saturationReason === "safety-cap"
        ? `No tasks found${filterHint} in the first ${maxFetched} fetched rows; more matching tasks may exist.`
        : `No tasks found${filterHint}.`
    return {
      text,
      data: {
        total: 0,
        distinctTaskIds: 0,
        multiProjectTaskCount: 0,
        saturated,
        saturationReason,
        maxFetched,
        overdue: [],
        active: [],
        filter,
      },
    }
  }

  const overdueTasks: TaskSummary[] = []
  const activeTasks: TaskSummary[] = []
  for (const task of tasks) {
    if (taskDaysOverdue(task, today) !== null) overdueTasks.push(task)
    else activeTasks.push(task)
  }
  const projectNameById = await projectNameMapForRows(services, tasks)
  const distinctTaskIds = new Set(tasks.map((task) => task.id)).size
  const multiProjectTaskCount = tasks.filter((task) => task.projectIds.length > 1).length

  // Bound prefix matches the MCP shape: `≥` when totals are
  // lower-bound (saturated), bare otherwise. The user-limit and
  // safety-cap cases both use `≥` because both indicate "more rows
  // exist beyond what we returned"; only the footer wording differs.
  const bound = saturated ? "≥" : ""
  const sections: string[] = []
  if (overdueTasks.length > 0) {
    sections.push(
      `Overdue (${bound}${overdueTasks.length}):\n` +
        overdueTasks.map((t) => formatTaskListRow(t, today)).join("\n")
    )
  }
  if (activeTasks.length > 0) {
    const sectionTitle = opts.state
      ? opts.state[0]!.toUpperCase() + opts.state.slice(1)
      : "Active"
    sections.push(
      `${sectionTitle} (${bound}${activeTasks.length}):\n` +
        activeTasks.map((t) => formatTaskListRow(t, today)).join("\n")
    )
  }

  const filterSuffix = opts.entity ? ` touching "${opts.entity}"` : ""
  const totalCountLabel = `${bound}${tasks.length}`
  const totalNoun = tasks.length === 1 && !saturated ? "task" : "tasks"
  const totalSemantics =
    saturationReason === "user-limit"
      ? `lower-bound total; showed first ${tasks.length} rows of more matching tasks`
      : saturationReason === "safety-cap"
        ? `lower-bound total; listing capped at ${maxFetched} fetched rows`
        : "exact total"
  const headerLine = `${totalCountLabel} ${totalNoun} (${totalSemantics})${filterSuffix}:`

  const footers: string[] = []
  if (saturationReason === "user-limit") {
    footers.push(
      `Showing first ${tasks.length} matching tasks; more matching tasks exist. ` +
        "Raise --limit to see more, or narrow with --project, --entity, --state, " +
        "or --due-before for an exact total."
    )
  } else if (saturationReason === "safety-cap") {
    footers.push(
      `More matching tasks exist after the first ${maxFetched} fetched rows; ` +
        "totals are lower bounds. Narrow with --project, --entity, --state, or " +
        "--due-before for an exact total."
    )
  }
  const footer = footers.length > 0 ? `\n\n${footers.join("\n")}` : ""

  return {
    text: `${headerLine}\n\n${sections.join("\n\n")}${footer}`,
    data: {
      total: tasks.length,
      distinctTaskIds,
      multiProjectTaskCount,
      saturated,
      saturationReason,
      maxFetched,
      overdue: overdueTasks.map((t) => rowFromTask(t, today, projectNameById)),
      active: activeTasks.map((t) => rowFromTask(t, today, projectNameById)),
      filter,
    },
  }
}

const listCommand = new Command("list")
  .description("List tasks with Overdue/Active sections")
  .option("-p, --project <name>", "Project to scope the listing to")
  .option("--all-projects", "Bypass cwd project fallback and list vault-wide")
  .option("-e, --entity <name>", "Substring filter against the Entity column")
  .option("-s, --state <state>", `Filter to one state: ${TASK_STATES.join(" | ")}`)
  .option(
    "--due-before <yyyy-mm-dd>",
    "Only return tasks whose Review By date is on or before this YYYY-MM-DD"
  )
  .option(
    "-n, --limit <n>",
    `Maximum tasks to return (default ${DEFAULT_LIST_LIMIT}, capped at ${MAX_LIST_LIMIT}); ` +
      `cursor-walked across up to ${MAX_LIST_PAGES} Notion pages`,
    String(DEFAULT_LIST_LIMIT)
  )
  .option("--json", "Emit the result as a JSON object instead of human text")
  .action(
    async (opts: {
      project?: string
      allProjects?: boolean
      entity?: string
      state?: string
      dueBefore?: string
      limit: string
      json?: boolean
    }) => {
      try {
        const parsed = parseListCliOptions(opts)
        if (!parsed.ok) {
          console.error(`Task list failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const result = await runTaskList(services, parsed.value)
        console.log(opts.json ? JSON.stringify(result.data, null, 2) : result.text)
      } catch (err) {
        console.error("Task list failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

export const tasksCommand = new Command("tasks")
  .description("Task lifecycle operations")
  .addCommand(createCommand)
  .addCommand(updateCommand)
  .addCommand(closeCommand)
  .addCommand(closeManyCommand)
  .addCommand(listCommand)
  .addCommand(reconcileCommand)
