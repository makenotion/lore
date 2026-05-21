import type { Memory } from "../types.js"

export interface SummaryQualityInput {
  title?: string
  source?: Memory["source"]
  kind?: Memory["kind"]
  content?: string
  synopsis?: string
}

export interface SummaryQualityResult {
  ok: boolean
  chronologyScore: number
  signalScore: number
  reasons: string[]
}

const CHRONOLOGY_PATTERNS: RegExp[] = [
  /\b(first|next|then|after that|finally|later|today|yesterday)\b/i,
  /\b(i|we) (started|checked|ran|searched|opened|created|updated|edited|implemented|fixed|tested|pushed|merged)\b/i,
  /\bthis session\b/i,
  /\bin the session\b/i,
  /\bsession (started|ended|continued)\b/i,
  /\bopened (a )?pr\b/i,
  /\bran (the )?(tests?|typecheck|build|lint)\b/i,
  /^\s*(\d{1,2}:\d{2}|[-*]\s*(then|next|finally)\b)/im,
]

const SIGNAL_PATTERNS: RegExp[] = [
  /\b(decision|decided|policy|invariant|constraint|contract|rule|requirement)\b/i,
  /\b(root cause|gotcha|failure mode|known risk|mitigation|remediation)\b/i,
  /\b(use|prefer|avoid|must|should|requires|depends on)\b/i,
  /\b(open loop|follow-up|owner|blocked|review by|expires|archive)\b/i,
  /\b(source|evidence|because|therefore|so that)\b/i,
  /\b(api|schema|migration|runtime|service|tool|vault|notion|mcp)\b/i,
]

function countMatches(text: string, patterns: readonly RegExp[]): number {
  return patterns.reduce((count, pattern) => count + (pattern.test(text) ? 1 : 0), 0)
}

function chronologyDensity(text: string): number {
  const transitions = text.match(/\b(first|next|then|after that|finally|later)\b/gi)
  const activity = text.match(
    /\b(ran|searched|opened|created|updated|edited|implemented|fixed|tested|pushed|merged)\b/gi
  )
  return (transitions?.length ?? 0) + Math.min(activity?.length ?? 0, 5)
}

function lineLogScore(text: string): number {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  if (lines.length < 3) return 0
  const logLines = lines.filter((line) =>
    /^\s*(?:[-*]\s*)?(?:\d{1,2}:\d{2}|first\b|next\b|then\b|finally\b|today\b)/i.test(
      line
    )
  )
  return logLines.length >= Math.ceil(lines.length / 2) ? 2 : 0
}

export function assessSignalSummaryQuality(
  input: SummaryQualityInput
): SummaryQualityResult {
  const text = [input.title, input.synopsis, input.content]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n")
    .trim()

  if (text.length === 0) {
    return { ok: true, chronologyScore: 0, signalScore: 0, reasons: [] }
  }

  const chronologyScore =
    countMatches(text, CHRONOLOGY_PATTERNS) + chronologyDensity(text) + lineLogScore(text)
  const signalScore = countMatches(text, SIGNAL_PATTERNS)
  const reasons: string[] = []

  if (/\bthis session\b/i.test(text)) {
    reasons.push("mentions the session as the subject")
  }
  if (/\b(first|next|then|after that|finally)\b/i.test(text)) {
    reasons.push("uses chronological transition markers")
  }
  if (
    /\b(i|we) (ran|searched|opened|created|updated|edited|implemented|fixed|tested)\b/i.test(
      text
    )
  ) {
    reasons.push("describes agent activity instead of durable memory")
  }

  const looksLogShaped =
    (chronologyScore >= 5 && signalScore <= 3) ||
    (chronologyScore >= 7 && chronologyScore >= signalScore + 3)

  if (!looksLogShaped) {
    return { ok: true, chronologyScore, signalScore, reasons: [] }
  }

  return {
    ok: false,
    chronologyScore,
    signalScore,
    reasons: reasons.length > 0 ? reasons : ["chronological activity prose"],
  }
}

export function shouldAuditSummaryQuality(memory: Memory): boolean {
  return memory.source === "digest" || memory.synopsis.trim().length > 0
}
