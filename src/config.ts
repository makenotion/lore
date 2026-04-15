import { access, readFile } from "node:fs/promises"
import { resolve, dirname } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import type { LoreConfig } from "./types.js"

const CONFIG_FILENAME = ".lore.yaml"

const configSchema = z.object({
  vault: z.object({
    pageId: z.string().min(1, "vault.pageId is required"),
  }),
  auth: z
    .object({
      token: z.string().optional(),
    })
    .optional(),
  projects: z
    .array(
      z.object({
        name: z.string(),
        path: z.string(),
        tags: z.array(z.string()).optional(),
      })
    )
    .optional(),
  detect: z
    .object({
      patterns: z.array(z.string()).optional(),
      exclude: z.array(z.string()).optional(),
    })
    .optional(),
  hooks: z
    .object({
      autoSave: z.boolean().optional(),
      wakeUp: z.boolean().optional(),
      saveInterval: z.number().int().min(1).optional(),
    })
    .optional(),
})

/**
 * Search upward from `startDir` for a `.lore.yaml` file.
 * Returns the path to the file and the directory it was found in.
 */
export async function findConfigFile(
  startDir: string
): Promise<{ path: string; root: string } | null> {
  let dir = resolve(startDir)
  const { root } = { root: "/" }

  while (true) {
    const candidate = resolve(dir, CONFIG_FILENAME)
    try {
      await access(candidate)
      return { path: candidate, root: dir }
    } catch {
      // File doesn't exist at this level — go up
    }
    const parent = dirname(dir)
    if (parent === dir || dir === root) return null
    dir = parent
  }
}

/**
 * Load and validate a `.lore.yaml` config from disk.
 */
export async function loadConfig(configPath: string): Promise<LoreConfig> {
  const raw = await readFile(configPath, "utf-8")
  const parsed = parseYaml(raw)
  return configSchema.parse(parsed)
}

export interface ResolvedAuth {
  token: string
  baseUrl?: string
}

/**
 * Resolve the Notion token from: config → env var → OAuth credentials.
 * Also returns baseUrl if it was stored with OAuth credentials.
 */
export async function resolveAuth(config?: LoreConfig): Promise<ResolvedAuth> {
  // 1. Explicit token in config
  const fromConfig = config?.auth?.token
  if (fromConfig) return { token: fromConfig }

  // 2. Environment variable
  const fromEnv = process.env["LORE_NOTION_TOKEN"]
  if (fromEnv) return { token: fromEnv }

  // 3. Saved OAuth credentials
  const { loadCredentials } = await import("./auth/oauth.js")
  const creds = await loadCredentials()
  if (creds?.access_token) {
    return {
      token: creds.access_token,
      baseUrl: creds.base_url,
    }
  }

  throw new Error(
    "No Notion token found. Run `lore auth` to authenticate, or set LORE_NOTION_TOKEN."
  )
}

/**
 * Convenience wrapper that returns just the token string.
 */
export async function resolveToken(config?: LoreConfig): Promise<string> {
  const { token } = await resolveAuth(config)
  return token
}
