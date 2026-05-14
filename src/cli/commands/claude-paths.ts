import { join } from "node:path"

export function encodeClaudeProjectPath(projectDir: string): string {
  return projectDir.replace(/\//g, "-")
}

export function resolveClaudeSettingsPath(projectDir: string, homeDir: string): string {
  return join(
    homeDir,
    ".claude",
    "projects",
    encodeClaudeProjectPath(projectDir),
    "settings.json"
  )
}
