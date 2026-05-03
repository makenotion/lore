/**
 * Bounded health markers for detached background hook failures.
 *
 * Autosave and auto-digest work intentionally runs out-of-process, so an
 * operator can miss a spawn/init/gather failure once the foreground hook
 * exits. These markers keep a recent, non-sensitive breadcrumb for
 * `lore status` without turning hook state into a job dashboard. Markers are
 * local-only by design: Notion-backed health records would make background
 * failures visible cross-machine, but would also require Notion auth on the
 * very paths whose auth failures we need to diagnose.
 */

import { createHash } from "node:crypto"
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { getStateDir } from "./lock.js"
import { configKey, safeFilenameSegment } from "./marker-key.js"

export const BACKGROUND_FAILURE_MARKER_VERSION = 1
// Two weeks gives operators one missed weekly digest window plus slack to run
// `lore status`, while keeping old local diagnostics short-lived.
export const BACKGROUND_FAILURE_STALE_DAYS = 14
export const BACKGROUND_FAILURE_LIST_LIMIT = 10

const MILLISECONDS_PER_DAY = 86_400_000
const MAX_PROJECT_NAME = 120
const MAX_SESSION_ID = 120
const MAX_FAILURE_CODE = 80
const MAX_MESSAGE = 220
const MAX_LOG_PATH = 500

export type BackgroundFailureKind =
  | "autosave"
  | "digest-scheduler"
  | "digest-synthesizer"
  | "auto-digest-helper-spawn"

const BACKGROUND_FAILURE_KINDS = new Set<BackgroundFailureKind>([
  "autosave",
  "digest-scheduler",
  "digest-synthesizer",
  "auto-digest-helper-spawn",
])

export interface BackgroundFailureScope {
  projectName?: string | null
  sessionId?: string | null
}

export interface BackgroundFailureInput extends BackgroundFailureScope {
  kind: BackgroundFailureKind
  code: string
  message: string
  logPath?: string | null
}

export interface BackgroundFailureMarker extends BackgroundFailureInput {
  version: typeof BACKGROUND_FAILURE_MARKER_VERSION
  occurredAt: string
  configRootKey: string
  projectName?: string
  sessionId?: string
  logPath?: string
}

export interface BackgroundFailureListResult {
  failures: BackgroundFailureMarker[]
  totalRecent: number
}

function boundedString(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = redactSensitiveText(value).trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > max ? `${trimmed.slice(0, max - 3)}...` : trimmed
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/\bsecret_[A-Za-z0-9_-]+/g, "secret_[redacted]")
    .replace(/\bntn_[A-Za-z0-9_-]+/g, "ntn_[redacted]")
    .replace(/\b(NOTION_API_TOKEN|LORE_NOTION_TOKEN)=\S+/g, "$1=[redacted]")
}

function scopeHash(kind: BackgroundFailureKind, scope: BackgroundFailureScope): string {
  const projectName = boundedString(scope.projectName, MAX_PROJECT_NAME) ?? ""
  // Active markers are keyed by the operator-actionable recovery scope, not
  // by session. A later successful autosave/helper run for the same project
  // clears or supersedes the prior failure, while the latest session id stays
  // in the JSON body for context.
  return createHash("sha256")
    .update(`${kind}\0${projectName}`)
    .digest("hex")
    .slice(0, 12)
}

function parseOccurredAt(value: unknown): { iso: string; ms: number } | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 40) {
    return null
  }
  const ms = new Date(value).getTime()
  if (!Number.isFinite(ms)) return null
  return { iso: value, ms }
}

function writeMarkerDiagnostic(err: unknown): void {
  const message =
    boundedString(err instanceof Error ? err.message : String(err), MAX_MESSAGE) ??
    "unknown error"
  try {
    process.stderr.write(`[lore] background-failure-marker: write failed: ${message}\n`)
  } catch {
    // Diagnostics must never make hook failure recording a new failure source.
  }
}

async function pruneMarkerFile(path: string): Promise<void> {
  try {
    await rm(path, { force: true })
  } catch {
    // Best-effort local GC; unreadable marker cleanup must stay fail-open.
  }
}

async function rejectMarker(
  path: string,
  shouldPrune: boolean
): Promise<BackgroundFailureMarker | null> {
  if (shouldPrune) await pruneMarkerFile(path)
  return null
}

export function backgroundFailureMarkerPath(
  configRoot: string,
  kind: BackgroundFailureKind,
  scope: BackgroundFailureScope = {}
): string {
  return join(
    getStateDir(),
    [
      "background-failure",
      configKey(configRoot),
      safeFilenameSegment(kind),
      safeFilenameSegment(scopeHash(kind, scope)),
      "json",
    ].join(".")
  )
}

export function recordBackgroundFailure(
  configRoot: string | null | undefined,
  input: BackgroundFailureInput,
  now: Date = new Date()
): void {
  if (!configRoot) return

  const marker: BackgroundFailureMarker = {
    version: BACKGROUND_FAILURE_MARKER_VERSION,
    kind: input.kind,
    occurredAt: now.toISOString(),
    configRootKey: configKey(configRoot),
    code: boundedString(input.code, MAX_FAILURE_CODE) ?? "unknown",
    message: boundedString(input.message, MAX_MESSAGE) ?? "background failure",
  }
  const projectName = boundedString(input.projectName, MAX_PROJECT_NAME)
  if (projectName) marker.projectName = projectName
  const sessionId = boundedString(input.sessionId, MAX_SESSION_ID)
  if (sessionId) marker.sessionId = sessionId
  const safeLogPath = boundedString(input.logPath, MAX_LOG_PATH)
  if (safeLogPath) marker.logPath = safeLogPath

  const path = backgroundFailureMarkerPath(configRoot, input.kind, marker)
  const tmpPath = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    // Synchronous writes are deliberate: Stop hooks may exit immediately after
    // emitting `{}`, so the diagnostic breadcrumb has to land before return.
    mkdirSync(getStateDir(), { recursive: true })
    writeFileSync(tmpPath, `${JSON.stringify(marker)}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    })
    // Same-key concurrent writers are last-writer-wins. The marker represents
    // the most recent observed failure for this recoverable scope, and POSIX
    // rename prevents torn reads while allowing that overwrite semantics.
    renameSync(tmpPath, path)
    pruneStaleBackgroundFailureMarkers(configRoot, now)
  } catch (err) {
    writeMarkerDiagnostic(err)
    try {
      unlinkSync(tmpPath)
    } catch {
      // Best-effort marker cleanup; hook hot paths must stay fail-open.
    }
  }
}

function pruneStaleBackgroundFailureMarkers(configRoot: string, now: Date): void {
  const rootKey = configKey(configRoot)
  const prefix = `background-failure.${rootKey}.`
  let entries: string[]
  try {
    entries = readdirSync(getStateDir())
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.startsWith(prefix) || !entry.endsWith(".json")) continue
    const path = join(getStateDir(), entry)
    try {
      const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown
      if (typeof parsed !== "object" || parsed === null) continue
      const occurredAt = parseOccurredAt(
        (parsed as Partial<BackgroundFailureMarker>).occurredAt,
      )
      if (!occurredAt) continue
      const ageDays = (now.getTime() - occurredAt.ms) / MILLISECONDS_PER_DAY
      if (ageDays > BACKGROUND_FAILURE_STALE_DAYS) unlinkSync(path)
    } catch {
      // Write-side GC is opportunistic; status-time collection still owns
      // full malformed-marker pruning and diagnostics must stay fail-open.
    }
  }
}

export interface ClearBackgroundFailureOptions {
  before?: Date
}

export async function clearBackgroundFailure(
  configRoot: string | null | undefined,
  kind: BackgroundFailureKind,
  scope: BackgroundFailureScope = {},
  opts: ClearBackgroundFailureOptions = {}
): Promise<void> {
  if (!configRoot) return
  const path = backgroundFailureMarkerPath(configRoot, kind, scope)
  if (!opts.before) {
    await rm(path, { force: true })
    return
  }

  const marker = await readBackgroundFailureMarker(path, {
    rootKey: configKey(configRoot),
    now: opts.before,
    staleDays: Number.POSITIVE_INFINITY,
    pruneRejected: false,
  })
  if (!marker) {
    await rm(path, { force: true })
    return
  }
  const occurredAt = parseOccurredAt(marker.occurredAt)
  // `before` is an exclusive recovery boundary captured before the successful
  // attempt starts. Same-millisecond or later failures may be concurrent with
  // that attempt, so they stay visible until a later success clears them.
  if (!occurredAt || occurredAt.ms < opts.before.getTime()) {
    await rm(path, { force: true })
  }
}

export interface ListBackgroundFailureOptions {
  now?: Date
  staleDays?: number
  limit?: number
}

export async function listBackgroundFailures(
  configRoot: string | null | undefined,
  opts: ListBackgroundFailureOptions = {}
): Promise<BackgroundFailureMarker[]> {
  return (await collectBackgroundFailures(configRoot, opts)).failures
}

export async function collectBackgroundFailures(
  configRoot: string | null | undefined,
  opts: ListBackgroundFailureOptions = {}
): Promise<BackgroundFailureListResult> {
  if (!configRoot) return { failures: [], totalRecent: 0 }
  const rootKey = configKey(configRoot)
  const prefix = `background-failure.${rootKey}.`
  const now = opts.now ?? new Date()
  const staleDays = opts.staleDays ?? BACKGROUND_FAILURE_STALE_DAYS
  const limit = opts.limit ?? BACKGROUND_FAILURE_LIST_LIMIT

  let entries: string[]
  try {
    entries = await readdir(getStateDir())
  } catch {
    return { failures: [], totalRecent: 0 }
  }

  const markers: BackgroundFailureMarker[] = []
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".json"))
      .map(async (entry) => {
        const marker = await readBackgroundFailureMarker(join(getStateDir(), entry), {
          rootKey,
          now,
          staleDays,
          pruneRejected: true,
        })
        if (marker) markers.push(marker)
      })
  )

  const sorted = markers.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))
  return {
    failures: sorted.slice(0, Math.max(0, limit)),
    totalRecent: sorted.length,
  }
}

async function readBackgroundFailureMarker(
  path: string,
  opts: { rootKey: string; now: Date; staleDays: number; pruneRejected: boolean }
): Promise<BackgroundFailureMarker | null> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf-8")) as unknown
    if (typeof parsed !== "object" || parsed === null) {
      return rejectMarker(path, opts.pruneRejected)
    }
    const row = parsed as Partial<BackgroundFailureMarker>
    // Strict version matching is intentional: older clients should not render
    // a future schema whose fields or safety semantics they do not understand.
    if (row.version !== BACKGROUND_FAILURE_MARKER_VERSION) {
      return rejectMarker(path, opts.pruneRejected)
    }
    if (!row.kind || !BACKGROUND_FAILURE_KINDS.has(row.kind)) {
      return rejectMarker(path, opts.pruneRejected)
    }
    if (row.configRootKey !== opts.rootKey) {
      return rejectMarker(path, opts.pruneRejected)
    }
    const occurredAt = parseOccurredAt(row.occurredAt)
    if (!occurredAt) return rejectMarker(path, opts.pruneRejected)
    const ageDays = (opts.now.getTime() - occurredAt.ms) / MILLISECONDS_PER_DAY
    if (ageDays > opts.staleDays) return rejectMarker(path, opts.pruneRejected)

    const marker: BackgroundFailureMarker = {
      version: BACKGROUND_FAILURE_MARKER_VERSION,
      kind: row.kind,
      occurredAt: occurredAt.iso,
      configRootKey: opts.rootKey,
      code: boundedString(row.code, MAX_FAILURE_CODE) ?? "unknown",
      message: boundedString(row.message, MAX_MESSAGE) ?? "background failure",
    }
    const projectName = boundedString(row.projectName, MAX_PROJECT_NAME)
    if (projectName) marker.projectName = projectName
    const sessionId = boundedString(row.sessionId, MAX_SESSION_ID)
    if (sessionId) marker.sessionId = sessionId
    const logPath = boundedString(row.logPath, MAX_LOG_PATH)
    if (logPath) marker.logPath = logPath
    return marker
  } catch {
    return rejectMarker(path, opts.pruneRejected)
  }
}
