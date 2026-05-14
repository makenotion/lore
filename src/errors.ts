export type LoreErrorDetailPrimitive = string | number | boolean | null

export type LoreErrorDetailValue =
  | LoreErrorDetailPrimitive
  | readonly LoreErrorDetailValue[]
  | { readonly [key: string]: LoreErrorDetailValue | undefined }

export interface LoreErrorDetailsByKind {
  "validation-error": {
    readonly field?: string
    readonly value?: LoreErrorDetailValue
  }
  "similar-topic": {
    readonly attempted: string
    readonly candidates: readonly {
      readonly id: string
      readonly name: string
      readonly similarity: number
    }[]
  }
  "autosave-learning-duplicate-probe": {
    readonly causeMessage: string
  }
  "transient-project-resolution": {
    readonly names: readonly string[]
    readonly scopeFields: string
    readonly causeMessage: string
  }
  "decision-create-partial": {
    readonly pageId: string
    readonly cleanedUp: boolean
    readonly bodyWriteCauseMessage: string
    readonly cleanupCauseMessage?: string
  }
  "decision-create-fact-partial": {
    readonly decisionId: string
    readonly failedAffect: string
    readonly createdAffects: readonly string[]
    readonly pendingAffects: readonly string[]
    readonly pendingSupersedes: readonly string[]
    readonly factWriteCauseMessage: string
  }
  "decision-create-supersede-partial": {
    readonly decisionId: string
    readonly failedSupersede: string
    readonly completedSupersedes: readonly string[]
    readonly markedSupersedes: readonly string[]
    readonly createdSupersedeFacts: readonly string[]
    readonly pendingSupersedes: readonly string[]
    readonly missingSupersedeFacts: readonly string[]
    readonly missingReachabilityUpdates: readonly string[]
    readonly supersedeCauseMessage: string
  }
  "procedure-source-resolution": {
    readonly memoryIds: readonly string[]
  }
  "procedure-topic-key-conflict": {
    readonly topicKey: string
    readonly existingMemoryId: string
    readonly existingStatus: string
  }
  "rekey-audit-failed": {
    readonly memoryId: string
    readonly oldTopicKey: string
    readonly newTopicKey: string
    readonly causeMessage: string
  }
  "memory-review-state": {
    readonly memoryId: string
    readonly currentStatus: string
  }
  "memory-review-audit-failed": {
    readonly memoryId: string
    readonly previousStatus: string
    readonly newStatus: string
    readonly causeMessage: string
  }
  "memory-update-partial": {
    readonly memoryId: string
    readonly contentApplied: true
    readonly rekeyCauseMessage: string
  }
  "memory-update-body-partial": {
    readonly memoryId: string
    readonly failedPhase: "body"
    readonly persisted: { readonly properties: true; readonly body: false }
    readonly bodyWriteCauseMessage: string
  }
  "memory-read-only": {
    readonly memoryId: string
    readonly memoryTitle: string
  }
  "memory-pin-cap-exceeded": {
    readonly memoryId: string
    readonly currentCount: number
    readonly cap: number
  }
  "memory-create-partial": {
    readonly pageId: string
    readonly cleanedUp: boolean
    readonly bodyWriteCauseMessage: string
    readonly cleanupCauseMessage?: string
  }
  "record-compared-partial-write": {
    readonly result: { readonly wroteA: boolean; readonly wroteB: boolean }
    readonly failedSide: "A" | "B"
    readonly causeMessage: string
  }
  "compare-dispatch-partial": {
    readonly step: "fact" | "supersede"
    readonly affectedMemoryId: string
    readonly factId?: string
    readonly causeMessage: string
  }
  "task-create-partial": {
    readonly pageId: string
    readonly cleanedUp: boolean
    readonly bodyWriteCauseMessage: string
    readonly cleanupCauseMessage?: string
  }
  "task-update-partial": {
    readonly taskId: string
    readonly failedPhase: "body"
    readonly persisted: { readonly properties: true; readonly body: false }
    readonly bodyWriteCauseMessage: string
  }
  "pinned-audit-failed": {
    readonly memoryId: string
    readonly action: string
    readonly causeMessage: string
  }
  "pinned-cap-exceeded": {
    readonly currentCount: number
    readonly cap: number
  }
  "lock-path-too-long": {
    readonly lockKey: string
    readonly code: "ENAMETOOLONG" | "ENOENT"
  }
  "write-budget-exceeded": {
    readonly toolPath: string
    readonly limit: number
    readonly count: number
  }
}

export type LoreErrorKind = keyof LoreErrorDetailsByKind
export type LoreErrorDetails<TKind extends LoreErrorKind = LoreErrorKind> =
  LoreErrorDetailsByKind[TKind]

export class LoreError<TKind extends LoreErrorKind = LoreErrorKind> extends Error {
  readonly kind: TKind
  readonly details: Readonly<LoreErrorDetails<TKind>>

  constructor(
    kind: TKind,
    message: string,
    details: LoreErrorDetails<TKind>,
    options?: { cause?: unknown }
  ) {
    super(message, options)
    this.name = `LoreError(${kind})`
    this.kind = kind
    this.details = details
  }
}

export function isLoreError(err: unknown): err is LoreError {
  return err instanceof LoreError
}

export function errorCauseMessage(cause: unknown, fallback = "unknown error"): string {
  if (cause instanceof Error && cause.message.length > 0) return cause.message
  if (typeof cause === "string" && cause.length > 0) return cause
  if (cause === undefined || cause === null) return fallback
  return String(cause)
}

const USER_ERROR_KINDS = new Set<LoreErrorKind>([
  "validation-error",
  "similar-topic",
  "procedure-source-resolution",
  "procedure-topic-key-conflict",
  "memory-review-state",
  "memory-read-only",
  "memory-pin-cap-exceeded",
  "pinned-cap-exceeded",
])

const TEMPORARY_FAILURE_KINDS = new Set<LoreErrorKind>([
  "autosave-learning-duplicate-probe",
  "transient-project-resolution",
  "write-budget-exceeded",
])

export function loreErrorExitCode(err: unknown, fallback = 1): number {
  if (!isLoreError(err)) return fallback
  if (USER_ERROR_KINDS.has(err.kind)) return 2
  if (TEMPORARY_FAILURE_KINDS.has(err.kind)) return 75
  return fallback
}
