export const MEMORY_CAPTURE_MODES = ["durable", "conversational"] as const

export type MemoryCaptureMode = (typeof MEMORY_CAPTURE_MODES)[number]

export const DEFAULT_MEMORY_CAPTURE_MODE: MemoryCaptureMode = "durable"
