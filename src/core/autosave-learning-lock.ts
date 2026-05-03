import { createHash, randomUUID } from "node:crypto"
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { performance } from "node:perf_hooks"

const LOCK_STALE_MS = 10 * 60 * 1000
const LOCK_HEARTBEAT_MS = 30_000
const LOCK_POLL_MS = 50

interface LockRecord {
  token: string
  pid: number
  createdAt: number
}

interface HeldLock {
  path: string
  record: LockRecord
}

interface ActiveContender {
  path: string
  record: LockRecord
}

function lockDir(): string {
  const root = process.env["LORE_HOOK_STATE_DIR"]
    ? join(process.env["LORE_HOOK_STATE_DIR"])
    : join(tmpdir(), "lore-hook-state")
  return join(root, "autosave-learning-locks")
}

function lockDigest(lockKey: string): string {
  return createHash("sha256").update(lockKey).digest("hex")
}

function lockPath(lockKey: string): string {
  return join(lockDir(), `${lockDigest(lockKey)}.lock.d`)
}

function legacyLockPath(lockKey: string): string {
  return join(lockDir(), `${lockDigest(lockKey)}.lock`)
}

function contenderPath(path: string, record: LockRecord): string {
  return join(path, `${record.createdAt}-${record.pid}-${record.token}.json`)
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

function removeIfExists(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Missing files are expected when another waiter wins the race.
  }
}

function isFreshLiveLock(path: string, record: LockRecord): boolean {
  const age = fileAgeMs(path)
  return age !== null && isProcessAlive(record.pid) && age < LOCK_STALE_MS
}

function isFreshFile(path: string): boolean {
  const age = fileAgeMs(path)
  return age !== null && age < LOCK_STALE_MS
}

function hasFreshLegacyLock(path: string): boolean {
  const record = readLock(path)
  if (record) return isFreshLiveLock(path, record)
  return isFreshFile(path)
}

function compareContenders(a: ActiveContender, b: ActiveContender): number {
  const byCreatedAt = a.record.createdAt - b.record.createdAt
  if (byCreatedAt !== 0) return byCreatedAt
  return a.record.token.localeCompare(b.record.token)
}

function listActiveContenders(path: string): {
  contenders: ActiveContender[]
  hasFreshUnknown: boolean
} {
  let names: string[]
  try {
    names = readdirSync(path)
  } catch {
    return { contenders: [], hasFreshUnknown: false }
  }

  const contenders: ActiveContender[] = []
  let hasFreshUnknown = false
  for (const name of names) {
    const currentPath = join(path, name)
    const record = readLock(currentPath)
    if (record) {
      if (isFreshLiveLock(currentPath, record)) {
        contenders.push({ path: currentPath, record })
      } else {
        removeIfExists(currentPath)
      }
      continue
    }

    if (isFreshFile(currentPath)) {
      hasFreshUnknown = true
    } else {
      removeIfExists(currentPath)
    }
  }

  contenders.sort(compareContenders)
  return { contenders, hasFreshUnknown }
}

function refreshLock(path: string, record: LockRecord): void {
  const current = readLock(path)
  if (current?.token !== record.token) return
  const now = new Date()
  try {
    utimesSync(path, now, now)
  } catch {
    // The owner is finishing or the lock was externally removed.
  }
}

async function acquireLock(lockKey: string): Promise<HeldLock> {
  const path = lockPath(lockKey)
  const oldPath = legacyLockPath(lockKey)
  mkdirSync(path, { recursive: true })
  const record: LockRecord = {
    token: randomUUID(),
    pid: process.pid,
    createdAt: performance.timeOrigin + performance.now(),
  }
  const ownPath = contenderPath(path, record)
  writeFileSync(ownPath, JSON.stringify(record), { flag: "wx", mode: 0o600 })
  let nextRefreshAt = Date.now() + LOCK_HEARTBEAT_MS

  while (true) {
    if (Date.now() >= nextRefreshAt) {
      refreshLock(ownPath, record)
      nextRefreshAt = Date.now() + LOCK_HEARTBEAT_MS
    }

    if (!hasFreshLegacyLock(oldPath)) {
      const { contenders, hasFreshUnknown } = listActiveContenders(path)
      if (!hasFreshUnknown && contenders[0]?.record.token === record.token) {
        return { path: ownPath, record }
      }
    }

    await sleep(LOCK_POLL_MS)
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

export async function withAutosaveLearningLock<T>(
  lockKey: string | null | undefined,
  fn: () => Promise<T>
): Promise<T> {
  if (!lockKey) return fn()

  const lock = await acquireLock(lockKey)
  const heartbeat = setInterval(
    () => refreshLock(lock.path, lock.record),
    LOCK_HEARTBEAT_MS
  )
  heartbeat.unref?.()
  try {
    return await fn()
  } finally {
    clearInterval(heartbeat)
    releaseLock(lock.path, lock.record)
  }
}

export function __autosaveLearningLockPathForTests(lockKey: string): string {
  return lockPath(lockKey)
}
