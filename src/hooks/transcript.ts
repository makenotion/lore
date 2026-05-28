export interface TranscriptMessage {
  role: "user" | "assistant"
  text: string
}

export interface TranscriptInspection {
  messages: TranscriptMessage[]
  malformedLineCount: number
  ignoredLineCount: number
  totalNonEmptyLineCount: number
}

function stripSystemReminders(text: string): string {
  return text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim()
}

function textFromClaudeContent(content: unknown): string | null {
  if (Array.isArray(content)) {
    return content
      .filter((part): part is { type: string; text?: string } => {
        return Boolean(part) && typeof part === "object" && "type" in part
      })
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("")
  }

  if (typeof content === "string") {
    return content
  }

  return null
}

function parseClaudeMessage(entry: Record<string, unknown>): TranscriptMessage | null {
  const type = entry["type"]
  if (type !== "user" && type !== "assistant") {
    return null
  }

  const message = entry["message"]
  if (!message || typeof message !== "object") {
    return null
  }

  const content = textFromClaudeContent((message as { content?: unknown }).content)
  if (!content) {
    return null
  }

  return {
    role: type,
    text: stripSystemReminders(content),
  }
}

function parseCodexEvent(entry: Record<string, unknown>): TranscriptMessage | null {
  if (entry["type"] !== "event_msg") {
    return null
  }

  const payload = entry["payload"]
  if (!payload || typeof payload !== "object") {
    return null
  }

  const eventType = (payload as { type?: unknown }).type
  if (eventType !== "user_message" && eventType !== "agent_message") {
    return null
  }

  const message = (payload as { message?: unknown }).message
  if (typeof message !== "string") {
    return null
  }

  return {
    role: eventType === "user_message" ? "user" : "assistant",
    text: stripSystemReminders(message),
  }
}

function parseCodexEvalRunStart(
  entry: Record<string, unknown>
): TranscriptMessage | null {
  if (entry["type"] !== "lore.eval.agent_run.started") return null
  const prompt = entry["prompt"]
  if (typeof prompt !== "string" || prompt.length === 0) return null
  return {
    role: "user",
    text: stripSystemReminders(prompt),
  }
}

function parseCodexItem(entry: Record<string, unknown>): TranscriptMessage | null {
  if (entry["type"] !== "item.completed") return null
  const item = entry["item"]
  if (!item || typeof item !== "object") return null
  const typedItem = item as {
    type?: unknown
    text?: unknown
    command?: unknown
    aggregated_output?: unknown
    exit_code?: unknown
  }

  if (typedItem.type === "agent_message" && typeof typedItem.text === "string") {
    return {
      role: "assistant",
      text: stripSystemReminders(typedItem.text),
    }
  }

  if (typedItem.type !== "command_execution") return null
  const command = typeof typedItem.command === "string" ? typedItem.command : ""
  const output =
    typeof typedItem.aggregated_output === "string"
      ? capTranscriptPart(typedItem.aggregated_output, 12_000)
      : ""
  const exitCode =
    typeof typedItem.exit_code === "number" ? `\nExit code: ${typedItem.exit_code}` : ""
  const text = [`Command: ${command}${exitCode}`, output && `Output:\n${output}`]
    .filter(Boolean)
    .join("\n")
  if (text.length === 0) return null
  return {
    role: "assistant",
    text: stripSystemReminders(text),
  }
}

function capTranscriptPart(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}\n...(truncated)`
}

export function inspectTranscript(transcriptRaw: string): TranscriptInspection {
  const messages: TranscriptMessage[] = []
  let malformedLineCount = 0
  let ignoredLineCount = 0
  let totalNonEmptyLineCount = 0

  for (const line of transcriptRaw.split("\n")) {
    if (!line.trim()) continue
    totalNonEmptyLineCount++

    try {
      const entry = JSON.parse(line) as Record<string, unknown>
      const parsed =
        parseClaudeMessage(entry) ??
        parseCodexEvent(entry) ??
        parseCodexEvalRunStart(entry) ??
        parseCodexItem(entry)
      if (!parsed || parsed.text.length === 0) {
        ignoredLineCount++
        continue
      }
      messages.push(parsed)
    } catch {
      malformedLineCount++
    }
  }

  return {
    messages,
    malformedLineCount,
    ignoredLineCount,
    totalNonEmptyLineCount,
  }
}

export function listTranscriptMessages(transcriptRaw: string): TranscriptMessage[] {
  return inspectTranscript(transcriptRaw).messages
}

export function countTranscriptUserMessages(transcriptRaw: string): number {
  return listTranscriptMessages(transcriptRaw).filter(
    (message) => message.role === "user"
  ).length
}

export function formatTranscriptSessionContent(
  messages: TranscriptMessage[],
  maxLength = 100_000
): string {
  const parts = messages.map((message) => {
    const role = message.role === "user" ? "User" : "Assistant"
    return `${role}: ${message.text}`
  })

  let result = parts.join("\n\n")
  if (result.length > maxLength) {
    result = "...(truncated)\n\n" + result.slice(-maxLength)
  }
  return result
}

export function extractTranscriptSessionContent(
  transcriptRaw: string,
  maxLength = 100_000
): string {
  return formatTranscriptSessionContent(listTranscriptMessages(transcriptRaw), maxLength)
}
