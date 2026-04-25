/**
 * Session-end digest scheduler. Fires a background `claude -p` synthesizer
 * for the current project when the last digest is older than the freshness
 * window, debounced via a shared filesystem marker.
 *
 * Extracted from `helpers.ts` so (a) the module can be unit-tested without
 * triggering the hook dispatcher's `main()` at import time, and (b) every
 * external dependency (service init, spawn, marker I/O) is injectable —
 * tests swap real filesystem + Notion + child_process for stubs.
 *
 * Decision log (see the review response on P2-04):
 * - **Optimistic touch-before-spawn**: we touch the marker *before* spawning
 *   and roll it back on spawn failure. Closes the check-then-act race where
 *   two sibling session-ends can both read a stale marker and double-spawn.
 * - **No-activity also touches**: a quiet week still touches the marker so
 *   we don't retry every session. Deliberate.
 * - **Project-mismatch bails silently**: if the config-derived project name
 *   doesn't match the Notion-resolved project, don't touch the marker —
 *   the user needs to reconcile via `lore status` before auto-digest can
 *   proceed.
 */

import { initServicesFromConfig } from "../services.js"
import type { LoreServices } from "../services.js"
import type { LoreConfig } from "../types.js"
import { resolveProjectPathFromCwd } from "../core/context.js"
import {
  DIGEST_STALE_DAYS,
  gatherDigestData,
  isoDate,
  type DigestData,
} from "../core/digest.js"
import { buildDigestPrompt } from "./prompts.js"
import { DIGEST_ALLOWLIST, spawnBackgroundSave } from "./background.js"
import {
  clearDigestMarker,
  digestMarkerAgeDays,
  touchDigestMarker,
} from "./digest-marker.js"

export interface DigestSchedulerState {
  config: LoreConfig
  configRoot: string
  autoDigest: boolean
}

export type SchedulerOutcome =
  | "disabled"
  | "no-project"
  | "marker-fresh"
  | "init-failed"
  | "project-mismatch"
  | "gather-failed"
  | "no-activity"
  | "fired"
  | "spawn-failed"

export interface DigestSchedulerDeps {
  initServices?: (
    cwd: string,
    configRoot: string,
    config: LoreConfig,
  ) => Promise<LoreServices>
  gatherDigest?: (
    services: LoreServices,
    opts: Parameters<typeof gatherDigestData>[1],
  ) => Promise<DigestData>
  markerAge?: (configRoot: string, projectName: string) => Promise<number>
  touchMarker?: (configRoot: string, projectName: string) => Promise<void>
  clearMarker?: (configRoot: string, projectName: string) => Promise<void>
  spawn?: typeof spawnBackgroundSave
  now?: () => Date
  log?: (message: string) => void
}

/**
 * Fire a background digest synthesis when the project's marker is stale.
 *
 * Never throws — any service-layer or filesystem error is caught internally
 * and reported via the injected `log` sink. The outcome enum signals the
 * branch taken so tests (and, eventually, a `lore status` surface) can
 * observe what actually happened without parsing stderr.
 */
export async function fireDigestIfStale(
  cwd: string,
  state: DigestSchedulerState,
  deps: DigestSchedulerDeps = {},
): Promise<SchedulerOutcome> {
  const initSvc = deps.initServices ?? initServicesFromConfig
  const gather = deps.gatherDigest ?? gatherDigestData
  const age = deps.markerAge ?? digestMarkerAgeDays
  const touch = deps.touchMarker ?? touchDigestMarker
  const clear = deps.clearMarker ?? clearDigestMarker
  const spawn = deps.spawn ?? spawnBackgroundSave
  const now = deps.now ?? (() => new Date())
  const log = deps.log ?? ((msg) => process.stderr.write(msg))

  if (!state.autoDigest) return "disabled"

  const project = resolveProjectPathFromCwd(cwd, state.configRoot, state.config)
  if (!project) return "no-project"

  if ((await age(state.configRoot, project.name)) < DIGEST_STALE_DAYS) {
    return "marker-fresh"
  }

  let services: LoreServices
  try {
    services = await initSvc(cwd, state.configRoot, state.config)
  } catch (err) {
    log(
      `[lore] digest scheduler: init failed — ${err instanceof Error ? err.message : err}\n`,
    )
    return "init-failed"
  }

  const resolved = services.context.project
  if (!resolved || resolved.name !== project.name) {
    // Config and vault disagree on project identity — operator should run
    // `lore status` to reconcile. Don't auto-fire against a mismatched scope.
    return "project-mismatch"
  }

  let digest: DigestData
  try {
    digest = await gather(services, {
      projectId: resolved.id,
      projectLabel: resolved.name,
      period: "week",
      now,
    })
  } catch (err) {
    log(
      `[lore] digest scheduler: gather failed — ${err instanceof Error ? err.message : err}\n`,
    )
    return "gather-failed"
  }

  if (digest.recentMemoryCount === 0) {
    // No activity in the window — touch the marker anyway so we don't retry
    // every session. A quiet week shouldn't wake the synthesizer repeatedly.
    //
    // Trade-off: a project with sustained-low-volume activity (e.g. 1–2
    // routine memories per week, all below the digest-worthy bar) can drift
    // here every session-end without ever producing a `source: "digest"`
    // memory, leaving `lore-wake-up`'s fast path dark for that project.
    // The explicit escape is `lore digest --since YYYY-MM-DD`, which
    // widens the window past the per-project 7-day debounce.
    await touch(state.configRoot, project.name)
    return "no-activity"
  }

  const today = isoDate(now())
  const prompt = buildDigestPrompt(
    digest.raw,
    resolved.name,
    today,
    digest.lastDigestDate,
  )

  // Optimistic touch: claim the marker BEFORE spawning so a sibling
  // session-end that starts between our age-check and our spawn sees a
  // fresh marker and skips. Roll back if the spawn itself fails so the
  // next session retries.
  await touch(state.configRoot, project.name)

  // Synthetic lock key prefixes "digest-" so it never collides with a real
  // session-id. Two session-ends for the same project can't double-fire
  // (the marker debounce already covers that), but the lock is still useful
  // for the global `MAX_CONCURRENT_SAVES` cap — five sessions ending at
  // once shouldn't fan out into five concurrent `claude -p` digests.
  const lockKey = `digest-${project.name.replace(/[^A-Za-z0-9_.-]/g, "_")}`
  const spawned = spawn(cwd, prompt, lockKey, {
    logLabel: "digest",
    allowedTools: DIGEST_ALLOWLIST,
  })
  if (!spawned) {
    await clear(state.configRoot, project.name)
    return "spawn-failed"
  }

  return "fired"
}
