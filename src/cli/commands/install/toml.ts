import { displayHomePath } from "./utils.js"

export function splitTomlLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, "\n")
  if (normalized === "") return []
  return normalized.endsWith("\n")
    ? normalized.slice(0, -1).split("\n")
    : normalized.split("\n")
}

export function joinTomlLines(lines: string[]): string {
  return lines.length > 0 ? lines.join("\n") + "\n" : ""
}

interface TomlSection {
  name: string
  start: number
  end: number
}

export function parseTomlSections(text: string): TomlSection[] {
  const lines = splitTomlLines(text)
  const sections: TomlSection[] = []
  const headingPattern = /^\s*\[([^[\]]+)\]\s*(?:#.*)?$/

  for (let i = 0; i < lines.length; i++) {
    const match = headingPattern.exec(lines[i])
    if (!match) continue

    if (sections.length > 0) {
      sections[sections.length - 1].end = i
    }

    sections.push({
      name: match[1].trim(),
      start: i,
      end: lines.length,
    })
  }

  return sections
}

export function containsTomlArrayOfTables(text: string): boolean {
  return splitTomlLines(text).some((line) => /^\s*\[\[/.test(line))
}

export function assertTomlSupportsLoreRewrite(text: string, filePath: string): void {
  if (!containsTomlArrayOfTables(text)) return
  const displayPath = displayHomePath(filePath)
  throw new Error(
    `${displayPath} contains TOML array-of-tables ([[...]]). ` +
      "lore install cannot safely rewrite that file yet; update the Lore sections manually instead."
  )
}

export function appendTomlBlock(text: string, block: string): string {
  const existing = text.trimEnd()
  const nextBlock = block.trim()
  if (existing === "") return nextBlock + "\n"
  return `${existing}\n\n${nextBlock}\n`
}

export function removeTomlTableGroup(text: string, tablePrefix: string): string {
  const lines = splitTomlLines(text)
  const sections = parseTomlSections(text)
    .filter(
      (section) =>
        section.name === tablePrefix || section.name.startsWith(`${tablePrefix}.`)
    )
    .sort((a, b) => b.start - a.start)

  for (const section of sections) {
    lines.splice(section.start, section.end - section.start)
  }

  return joinTomlLines(lines).replace(/\n{3,}/g, "\n\n")
}

export function extractTomlTableGroup(text: string, tablePrefix: string): string | null {
  const lines = splitTomlLines(text)
  const matches = parseTomlSections(text).filter(
    (section) =>
      section.name === tablePrefix || section.name.startsWith(`${tablePrefix}.`)
  )
  if (matches.length === 0) return null

  const start = matches[0].start
  const end = matches[matches.length - 1].end
  return lines.slice(start, end).join("\n")
}

export function extractTomlKeyValue(
  text: string,
  tableName: string,
  key: string
): string | undefined {
  const lines = splitTomlLines(text)
  const section = parseTomlSections(text).find(
    (candidate) => candidate.name === tableName
  )
  if (!section) return undefined

  const keyPattern = new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`)
  for (let i = section.start + 1; i < section.end; i++) {
    const match = keyPattern.exec(lines[i])
    if (match) return match[1].trim()
  }
  return undefined
}

export function upsertTomlTableKey(
  text: string,
  tableName: string,
  key: string,
  value: string
): string {
  const lines = splitTomlLines(text)
  const sections = parseTomlSections(text)
  const section = sections.find((candidate) => candidate.name === tableName)
  const keyPattern = new RegExp(`^\\s*${key}\\s*=`)

  if (!section) {
    return appendTomlBlock(text, `[${tableName}]\n${key} = ${value}`)
  }

  for (let i = section.start + 1; i < section.end; i++) {
    if (keyPattern.test(lines[i])) {
      lines[i] = `${key} = ${value}`
      return joinTomlLines(lines)
    }
  }

  lines.splice(section.end, 0, `${key} = ${value}`)
  return joinTomlLines(lines)
}
