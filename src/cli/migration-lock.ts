/**
 * PID-backed lock for operator-run migrations.
 *
 * Migration locks live under the shared Lore state dir but inside their
 * own subdirectory so they do not count toward the hook background-save
 * concurrency cap. A lock is held only while its owner PID is alive; stale
 * files from crashed CLI processes are reclaimed on the next acquire.
 */

import { createHash, randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { getStateDir } from "../hooks/lock.js"
import { configKey, safeFilenameSegment } from "../hooks/marker-key.js"

export interface MigrationLockScope {
  name: string
  configRoot: string
  vaultPageId: string
}

export interface MigrationLock {
  path: string
  ownerPid: number
  content: string
}

export type MigrationLockAcquireResult =
  | { acquired: true; lock: MigrationLock }
  | { acquired: false; path: string; ownerPid: number | null }

export const MALFORMED_LOCK_STALE_MS = 30_000
export const MIGRATION_LOCK_MAX_AGE_MS = 2 * 60 * 60 * 1_000

interface LockSnapshot {
  raw: string
  dev: number
  ino: number
  mtimeMs: number
  size: number
}

type ExistingLockState =
  | { kind: "absent" }
  | { kind: "held"; ownerPid: number | null }
  | { kind: "stale"; snapshot: LockSnapshot }

function migrationStateDir(): string {
  return join(getStateDir(), "migrations")
}

function ensureMigrationStateDir(): void {
  mkdirSync(migrationStateDir(), { recursive: true })
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8)
}

export function migrationLockPath(scope: MigrationLockScope): string {
  const key = safeFilenameSegment(
    `${scope.name}.${configKey(scope.configRoot)}.${shortHash(scope.vaultPageId)}`
  )
  return join(migrationStateDir(), `${key}.lock`)
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"
  }
}

function readLockSnapshot(path: string): LockSnapshot | null {
  try {
    const stat = statSync(path)
    const raw = readFileSync(path, "utf-8")
    return {
      raw,
      dev: stat.dev,
      ino: stat.ino,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null
    throw err
  }
}

function lockPid(snapshot: LockSnapshot): number | null {
  const [pidText] = snapshot.raw.trim().split(/\s+/, 1)
  const pid = parseInt(pidText ?? "", 10)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

function lockAgeMs(snapshot: LockSnapshot): number {
  const [, createdAtText] = snapshot.raw.trim().split(/\s+/, 2)
  const createdAt = Number(createdAtText)
  const ageBasis =
    Number.isFinite(createdAt) && createdAt > 0 ? createdAt : snapshot.mtimeMs
  return Date.now() - ageBasis
}

function sameSnapshot(a: LockSnapshot, b: LockSnapshot): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.mtimeMs === b.mtimeMs &&
    a.size === b.size &&
    a.raw === b.raw
  )
}

function lockContent(ownerPid: number): string {
  return `${ownerPid} ${Date.now()} ${randomUUID()}`
}

function removeIfSameSnapshot(path: string, snapshot: LockSnapshot): boolean {
  const current = readLockSnapshot(path)
  if (!current) return true
  if (!sameSnapshot(snapshot, current)) return false

  try {
    unlinkSync(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true
    throw err
  }
}

function removeIfSameContent(path: string, content: string): void {
  const current = readLockSnapshot(path)
  if (!current || current.raw !== content) return

  try {
    unlinkSync(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
  }
}

function resultFromExisting(path: string): MigrationLockAcquireResult {
  const state = inspectExistingLock(path)
  return {
    acquired: false,
    path,
    ownerPid: state.kind === "held" ? state.ownerPid : null,
  }
}

function inspectExistingLock(path: string): ExistingLockState {
  const snapshot = readLockSnapshot(path)
  if (!snapshot) return { kind: "absent" }

  const ageMs = lockAgeMs(snapshot)
  const pid = lockPid(snapshot)
  if (pid !== null) {
    if (ageMs > MIGRATION_LOCK_MAX_AGE_MS) {
      return { kind: "stale", snapshot }
    }
    return isProcessAlive(pid)
      ? { kind: "held", ownerPid: pid }
      : { kind: "stale", snapshot }
  }

  if (ageMs < MALFORMED_LOCK_STALE_MS) {
    return { kind: "held", ownerPid: null }
  }
  return { kind: "stale", snapshot }
}

function tryCreateLockFile(path: string, ownerPid: number): MigrationLock | null {
  const content = lockContent(ownerPid)
  try {
    writeFileSync(path, content, { flag: "wx", mode: 0o600 })
    return { path, ownerPid, content }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return null
    throw err
  }
}

export function tryAcquireMigrationLock(
  scope: MigrationLockScope,
  ownerPid = process.pid
): MigrationLockAcquireResult {
  ensureMigrationStateDir()
  const path = migrationLockPath(scope)

  for (let attempt = 0; attempt < 3; attempt++) {
    const existing = inspectExistingLock(path)
    if (existing.kind === "held") {
      return { acquired: false, path, ownerPid: existing.ownerPid }
    }

    if (existing.kind === "stale" && !removeIfSameSnapshot(path, existing.snapshot)) {
      continue
    }

    const lock = tryCreateLockFile(path, ownerPid)
    if (lock) return { acquired: true, lock }
  }

  return resultFromExisting(path)
}

export function releaseMigrationLock(lock: MigrationLock): void {
  removeIfSameContent(lock.path, lock.content)
}
