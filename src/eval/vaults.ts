import { access, readFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import { z } from "zod"
import { NOTION_PAGE_ID_RE } from "../notion/runtool/error-helpers.js"
import { EVAL_RUNNERS } from "./schema.js"

export const EVAL_VAULT_REGISTRY_PATH = "evals/vaults.yaml"

const vaultIdSchema = z
  .string()
  .min(1)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "must be kebab-case")

const notionEnvSchema = z.enum(["prod", "dev", "stg"])

const nonEmptyStringSchema = z.string().min(1)

const pageIdSchema = nonEmptyStringSchema.refine(
  (value) => NOTION_PAGE_ID_RE.test(value.trim()),
  "must be a Notion page id"
)

const requiredEnvSchema = z.record(
  z.string().regex(/^[A-Z_][A-Z0-9_]*$/, "must be an environment variable name"),
  nonEmptyStringSchema
)

const evalVaultSupportedRunSchema = z
  .object({
    id: vaultIdSchema,
    runner: z.enum(EVAL_RUNNERS),
    suite: nonEmptyStringSchema,
    sandboxProjectName: nonEmptyStringSchema.optional(),
    requiredEnv: requiredEnvSchema.default({}),
  })
  .strict()

const validationCountSchema = z
  .object({
    passed: z.number().int().nonnegative(),
    trials: z.number().int().positive(),
  })
  .strict()
  .refine((value) => value.passed <= value.trials, {
    message: "passed cannot exceed trials",
    path: ["passed"],
  })

const evalVaultValidationSchema = z
  .object({
    kind: z.enum(["smoke", "sample", "full"]).default("smoke"),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    suite: nonEmptyStringSchema,
    scenarios: z.number().int().positive(),
    conditionRuns: z.number().int().positive(),
    noMemory: validationCountSchema,
    loreFullLoop: validationCountSchema,
    successRateDelta: z.number().min(-1).max(1),
    liftedScenarioIds: z.array(vaultIdSchema).default([]),
  })
  .strict()

export const evalVaultSchema = z
  .object({
    id: vaultIdSchema,
    label: nonEmptyStringSchema,
    description: z.string().default(""),
    notionEnv: notionEnvSchema,
    notionWorkspaceId: z.string().uuid(),
    vaultPageId: pageIdSchema,
    defaultProjectName: nonEmptyStringSchema.optional(),
    supportedRuns: z.array(evalVaultSupportedRunSchema).default([]),
    lastValidation: evalVaultValidationSchema.optional(),
    notes: z.array(nonEmptyStringSchema).default([]),
  })
  .strict()

export const evalVaultRegistrySchema = z
  .object({
    version: z.literal(1),
    vaults: z.array(evalVaultSchema).min(1),
  })
  .strict()
  .superRefine((registry, ctx) => {
    const seen = new Set<string>()
    for (const [index, vault] of registry.vaults.entries()) {
      if (seen.has(vault.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["vaults", index, "id"],
          message: `duplicate eval vault id "${vault.id}"`,
        })
      }
      seen.add(vault.id)
    }
  })

export type EvalVault = z.infer<typeof evalVaultSchema>
export type EvalVaultRegistry = z.infer<typeof evalVaultRegistrySchema>

export async function loadEvalVaultRegistry(path?: string): Promise<EvalVaultRegistry> {
  const absolute =
    path === undefined ? await resolveDefaultEvalVaultRegistryPath() : resolve(path)
  const raw = await readFile(absolute, "utf-8")
  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse YAML in ${absolute}: ${message}`, {
      cause: err,
    })
  }
  return evalVaultRegistrySchema.parse(parsed)
}

export async function resolveDefaultEvalVaultRegistryPath(): Promise<string> {
  const moduleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    resolve(moduleDir, "../", EVAL_VAULT_REGISTRY_PATH),
    resolve(moduleDir, "../../", EVAL_VAULT_REGISTRY_PATH),
  ]

  for (const candidate of candidates) {
    try {
      await access(candidate)
      return candidate
    } catch {
      // Try the next supported source or package layout.
    }
  }

  throw new Error(
    `Could not find ${EVAL_VAULT_REGISTRY_PATH}. ` +
      "Use an installed package that includes the eval vault registry, or pass an explicit registry path."
  )
}

export function findEvalVault(
  registry: EvalVaultRegistry,
  id: string
): EvalVault | undefined {
  return registry.vaults.find((vault) => vault.id === id)
}

export function renderEvalVaultLoreConfig(vault: EvalVault): string {
  return (
    stringifyYaml({
      vault: {
        pageId: vault.vaultPageId,
      },
      auth: {
        workspaceId: vault.notionWorkspaceId,
      },
    }).trimEnd() + "\n"
  )
}

export function evalVaultEnv(vault: EvalVault): Record<string, string> {
  const env: Record<string, string> = {
    NOTION_ENV: vault.notionEnv,
    NOTION_WORKSPACE_ID: vault.notionWorkspaceId,
  }
  if (vault.defaultProjectName) {
    env["LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT"] = vault.defaultProjectName
  }
  return env
}

export function renderEvalVaultEnv(vault: EvalVault): string {
  return (
    Object.entries(evalVaultEnv(vault))
      .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
      .join("\n") + "\n"
  )
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
