import { createHash, randomUUID } from "node:crypto"
import {
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const LOCK_STALE_MS = 10 * 60 * 1000
const LOCK_HEARTBEAT_MS = 30_000
const LOCK_POLL_MS = 50

interface LockRecord {
  token: string
  pid: number
  createdAt: number
}

function lockDir(): string {
  return join(process.env["HOME"] ?? tmpdir(), ".lore", "entity-relation-locks")
}

export function normalizeEntityRelationLockKey(entityId: string): string {
  const trimmed = entityId.trim().toLowerCase()
  const compact = trimmed.replace(/-/g, "")
  return /^[0-9a-f]{32}$/.test(compact) ? compact : trimmed
}

function lockPath(entityId: string): string {
  const digest = createHash("sha256")
    .update(normalizeEntityRelationLockKey(entityId))
    .digest("hex")
  return join(lockDir(), `${digest}.lock`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function readLock(path: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Partial<LockRecord>
    if (
      typeof parsed.token === "string" &&
      typeof parsed.pid === "number" &&
      typeof parsed.createdAt === "number"
    ) {
      return {
        token: parsed.token,
        pid: parsed.pid,
        createdAt: parsed.createdAt,
      }
    }
  } catch {
    return null
  }
  return null
}

function fileAgeMs(path: string): number | null {
  try {
    return Date.now() - statSync(path).mtimeMs
  } catch {
    return null
  }
}

function removeStaleLock(path: string): void {
  const record = readLock(path)
  const age = fileAgeMs(path)
  if (record && age !== null && isProcessAlive(record.pid) && age < LOCK_STALE_MS) {
    return
  }
  if (record === null && age !== null && age < LOCK_STALE_MS) return

  try {
    unlinkSync(path)
  } catch {
    // Another waiter may have removed it first.
  }
}

function refreshLock(path: string, record: LockRecord): void {
  const current = readLock(path)
  if (current?.token !== record.token) return
  const now = new Date()
  try {
    // Touch mtime so waiters can distinguish a live long-running merge from
    // a stale lock whose PID was later reused by an unrelated process.
    utimesSync(path, now, now)
  } catch {
    // The owner is finishing or the lock was externally removed.
  }
}

export function __entityRelationLockPathForTests(entityId: string): string {
  return lockPath(entityId)
}

export function __removeStaleEntityRelationLockForTests(path: string): void {
  removeStaleLock(path)
}

async function acquireLock(path: string): Promise<LockRecord> {
  mkdirSync(lockDir(), { recursive: true })
  while (true) {
    const record: LockRecord = {
      token: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
    }
    try {
      writeFileSync(path, JSON.stringify(record), { flag: "wx", mode: 0o600 })
      return record
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      removeStaleLock(path)
      await sleep(LOCK_POLL_MS)
    }
  }
}

function releaseLock(path: string, record: LockRecord): void {
  try {
    const current = readLock(path)
    if (current?.token === record.token) unlinkSync(path)
  } catch {
    // The lock is already gone or unreadable; the owner is done either way.
  }
}

export async function withEntityRelationLocks<T>(
  entityIds: Array<string | null | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const ids = [
    ...new Set(
      entityIds
        .filter((id): id is string => Boolean(id))
        .map(normalizeEntityRelationLockKey)
        .filter((id) => id.length > 0)
    ),
  ].sort()
  if (ids.length === 0) return fn()

  const acquired: Array<{
    path: string
    record: LockRecord
    heartbeat: ReturnType<typeof setInterval>
  }> = []
  try {
    for (const id of ids) {
      const path = lockPath(id)
      const record = await acquireLock(path)
      const heartbeat = setInterval(() => refreshLock(path, record), LOCK_HEARTBEAT_MS)
      heartbeat.unref?.()
      acquired.push({ path, record, heartbeat })
    }
    return await fn()
  } finally {
    for (const lock of acquired.reverse()) {
      clearInterval(lock.heartbeat)
      releaseLock(lock.path, lock.record)
    }
  }
}
