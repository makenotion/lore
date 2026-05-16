import { redactDebugError } from "../debug-redact.js"

// eslint-disable-next-line no-control-regex -- fatal stderr events must stay one line
const CONTROL_CHARS = /[\x00-\x1F\x7F]/g

export function formatFatalErrorLine(error: unknown): string {
  return `[lore] Fatal error: ${oneLine(redactDebugError(error))}\n`
}

function oneLine(value: string): string {
  return value.replace(CONTROL_CHARS, " ")
}
