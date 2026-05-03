import {
  collectBackgroundFailures,
  listBackgroundFailures,
  type BackgroundFailureKind,
  type BackgroundFailureMarker,
} from "./background-failure-marker.js"

export const BACKGROUND_FAILURE_OBSERVED_SCOPE =
  "spawn/init/gather only; detached child exits are not tracked."

export interface BackgroundFailureStatusReport {
  failures: BackgroundFailureMarker[]
  totalRecent: number
}

export interface BackgroundFailureStatusDeps {
  collectFailures?: typeof collectBackgroundFailures
  listFailures?: typeof listBackgroundFailures
}

export interface BackgroundFailureStatusFailure {
  kind: BackgroundFailureKind
  label: string
  occurredAt: string
  scope: {
    projectName?: string
    sessionId?: string
  }
  code: string
  message: string
  logPath?: string
  next: string
}

export interface BackgroundFailureStatusObject {
  observedScope: string
  failures: BackgroundFailureStatusFailure[]
  totalRecent: number
  showing: number
}

export async function loadBackgroundFailureStatus(
  configRoot: string | null | undefined,
  deps: BackgroundFailureStatusDeps = {}
): Promise<BackgroundFailureStatusReport> {
  if (!configRoot) return { failures: [], totalRecent: 0 }
  if (deps.collectFailures) return deps.collectFailures(configRoot)
  if (deps.listFailures) {
    const failures = await deps.listFailures(configRoot)
    return { failures, totalRecent: failures.length }
  }
  return collectBackgroundFailures(configRoot)
}

export function formatBackgroundFailureStatusObject(
  report: BackgroundFailureStatusReport
): BackgroundFailureStatusObject {
  const totalRecent = report.totalRecent ?? report.failures.length
  return {
    observedScope: BACKGROUND_FAILURE_OBSERVED_SCOPE,
    failures: report.failures.map(formatBackgroundFailureObject),
    totalRecent,
    showing: report.failures.length,
  }
}

export function formatBackgroundFailureStatus(
  report: BackgroundFailureStatusReport
): string[] {
  const status = formatBackgroundFailureStatusObject(report)
  const lines: string[] = ["Background hooks:"]
  lines.push(`  observed scope: ${status.observedScope}`)
  if (status.failures.length === 0) {
    lines.push("  observed failures: none")
    return lines
  }

  lines.push("  recent observed failures:")
  for (const failure of status.failures) {
    const scope = formatBackgroundFailureScope(failure.scope)
    const scopeText = scope ? ` · ${scope}` : ""
    lines.push(
      `    - ${failure.label} · ${failure.occurredAt}${scopeText} · ${failure.code}: ${failure.message}`
    )
    if (failure.logPath) lines.push(`      log: ${failure.logPath}`)
    lines.push(`      next: ${failure.next}`)
  }
  if (status.totalRecent > status.showing) {
    lines.push(`  (showing ${status.showing} of ${status.totalRecent} recent failures)`)
  }
  return lines
}

function formatBackgroundFailureObject(
  failure: BackgroundFailureMarker
): BackgroundFailureStatusFailure {
  return {
    kind: failure.kind,
    label: formatBackgroundFailureKind(failure.kind),
    occurredAt: failure.occurredAt,
    scope: {
      ...(failure.projectName ? { projectName: failure.projectName } : {}),
      ...(failure.sessionId ? { sessionId: failure.sessionId } : {}),
    },
    code: failure.code,
    message: failure.message,
    ...(failure.logPath ? { logPath: failure.logPath } : {}),
    next: backgroundFailureHint(failure),
  }
}

function formatBackgroundFailureScope(
  scope: BackgroundFailureStatusFailure["scope"]
): string {
  const parts: string[] = []
  if (scope.projectName) parts.push(`project ${scope.projectName}`)
  if (scope.sessionId) parts.push(`session ${scope.sessionId}`)
  return parts.join(" · ")
}

function formatBackgroundFailureKind(kind: BackgroundFailureKind): string {
  switch (kind) {
    case "autosave":
      return "autosave"
    case "digest-scheduler":
      return "digest scheduler"
    case "digest-synthesizer":
      return "digest synthesizer"
    case "auto-digest-helper-spawn":
      return "auto-digest helper spawn"
  }
}

function backgroundFailureHint(failure: BackgroundFailureMarker): string {
  if (failure.code === "binary-missing") {
    return "Check hooks.backgroundAgent.command or LORE_BACKGROUND_COMMAND, then trigger the hook again."
  }
  if (failure.code === "tempfile-failed") {
    return "Check the temp/state directory permissions and available disk space."
  }
  if (failure.kind === "digest-scheduler" && failure.code === "init-failed") {
    return "Run `lore auth --status` to verify vault access."
  }
  if (failure.kind === "digest-scheduler" && failure.code === "gather-failed") {
    return "Run `lore digest` manually; if it fails, run `lore auth --status`."
  }
  if (failure.kind === "digest-synthesizer") {
    return "Run `lore digest` manually after fixing the underlying spawn issue."
  }
  if (failure.kind === "auto-digest-helper-spawn") {
    return "Check Node/process limits; run `lore digest` manually to produce the digest now."
  }
  if (failure.logPath) {
    return "Trigger the hook again after fixing the logged issue."
  }
  return "Run `lore status` and retry the hook after fixing the underlying issue."
}
