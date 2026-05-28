import type { ChildProcess } from "node:child_process"

const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"] as const

const SIGNAL_EXIT_CODES: Record<(typeof TERMINATION_SIGNALS)[number], number> = {
  SIGTERM: 143,
  SIGINT: 130,
  SIGHUP: 129,
}

const activeDetachedChildren = new Set<ChildProcess>()
let handlersInstalled = false
let handlingTermination = false

export function registerDetachedChildProcessGroup(child: ChildProcess): () => void {
  activeDetachedChildren.add(child)
  installTerminationHandlers()
  let unregistered = false
  const unregister = (): void => {
    if (unregistered) return
    unregistered = true
    activeDetachedChildren.delete(child)
  }
  child.once("close", unregister)
  child.once("error", unregister)
  return unregister
}

export function killChildProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    try {
      child.kill(signal)
    } catch {
      // The process may already be gone.
    }
    return
  }
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // The process may already be gone.
    }
  }
}

export function isChildProcessRunning(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null
}

function installTerminationHandlers(): void {
  if (handlersInstalled) return
  handlersInstalled = true
  for (const signal of TERMINATION_SIGNALS) {
    process.on(signal, () => handleTerminationSignal(signal))
  }
}

function handleTerminationSignal(signal: (typeof TERMINATION_SIGNALS)[number]): void {
  const exitCode = SIGNAL_EXIT_CODES[signal]
  if (handlingTermination) {
    killActiveDetachedChildren("SIGKILL")
    process.exit(exitCode)
  }
  handlingTermination = true

  const active = [...activeDetachedChildren].filter(isChildProcessRunning)
  if (active.length === 0) process.exit(exitCode)

  for (const child of active) killChildProcessGroup(child, "SIGTERM")
  const killTimer = setTimeout(() => {
    killActiveDetachedChildren("SIGKILL")
  }, 500)
  killTimer.unref()

  let remaining = active.length
  const exitWhenDone = (): void => {
    remaining -= 1
    if (remaining <= 0) process.exit(exitCode)
  }
  for (const child of active) child.once("close", exitWhenDone)

  const exitTimer = setTimeout(() => process.exit(exitCode), 2_000)
  exitTimer.unref()
}

function killActiveDetachedChildren(signal: NodeJS.Signals): void {
  for (const child of [...activeDetachedChildren].filter(isChildProcessRunning)) {
    killChildProcessGroup(child, signal)
  }
}
