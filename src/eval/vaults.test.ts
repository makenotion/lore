import { readFile, writeFile, mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
  findEvalVault,
  loadEvalVaultRegistry,
  renderEvalVaultEnv,
  renderEvalVaultLoreConfig,
  resolveDefaultEvalVaultRegistryPath,
} from "./vaults.js"

describe("eval vault registry", () => {
  const originalCwd = process.cwd()

  afterEach(() => {
    process.chdir(originalCwd)
  })

  it("loads the committed Lore dev sandbox vault", async () => {
    const registry = await loadEvalVaultRegistry()
    const vault = findEvalVault(registry, "lore-dev-sandbox")

    expect(vault).toMatchObject({
      notionEnv: "dev",
      notionWorkspaceId: "415fc269-e68f-4da0-b3e3-b1273b741a7f",
      vaultPageId: "360b35e6-e67f-8156-aa0e-f3763246719d",
      defaultProjectName: "Eval Sandbox",
      lastValidation: {
        kind: "smoke",
        scenarios: 4,
        conditionRuns: 8,
        successRateDelta: 0.25,
        liftedScenarioIds: ["convention-continuity-cache-prefix"],
      },
    })
  })

  it("loads the default registry when cwd is outside the checkout root", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-vaults-cwd-"))
    process.chdir(dir)

    const registry = await loadEvalVaultRegistry()

    expect(findEvalVault(registry, "lore-dev-sandbox")).toBeDefined()
    expect(await resolveDefaultEvalVaultRegistryPath()).toMatch(/evals\/vaults\.yaml$/)
  })

  it("publishes the registry with the package files", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf-8")) as {
      files?: string[]
    }

    expect(packageJson.files).toContain("evals/vaults.yaml")
  })

  it("renders local config without embedding auth tokens", async () => {
    const registry = await loadEvalVaultRegistry()
    const vault = findEvalVault(registry, "lore-dev-sandbox")
    expect(vault).toBeDefined()

    const config = renderEvalVaultLoreConfig(vault!)
    expect(config).toContain("pageId: 360b35e6-e67f-8156-aa0e-f3763246719d")
    expect(config).toContain("workspaceId: 415fc269-e68f-4da0-b3e3-b1273b741a7f")
    expect(config).not.toMatch(/token|ntn_|secret_/i)
  })

  it("renders the environment selectors for the sandbox vault", async () => {
    const registry = await loadEvalVaultRegistry()
    const vault = findEvalVault(registry, "lore-dev-sandbox")
    expect(vault).toBeDefined()

    expect(renderEvalVaultEnv(vault!)).toBe(
      [
        "export NOTION_ENV='dev'",
        "export NOTION_WORKSPACE_ID='415fc269-e68f-4da0-b3e3-b1273b741a7f'",
        "export LORE_EVAL_LONGITUDINAL_SANDBOX_PROJECT='Eval Sandbox'",
        "",
      ].join("\n")
    )
  })

  it("rejects duplicate vault ids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lore-eval-vaults-"))
    const path = join(dir, "vaults.yaml")
    await writeFile(
      path,
      `version: 1
vaults:
  - id: duplicate-vault
    label: First
    notionEnv: dev
    notionWorkspaceId: 415fc269-e68f-4da0-b3e3-b1273b741a7f
    vaultPageId: 360b35e6-e67f-8156-aa0e-f3763246719d
  - id: duplicate-vault
    label: Second
    notionEnv: dev
    notionWorkspaceId: 415fc269-e68f-4da0-b3e3-b1273b741a7f
    vaultPageId: 360b35e6-e67f-8156-aa0e-f3763246719d
`
    )

    await expect(loadEvalVaultRegistry(path)).rejects.toThrow(/duplicate eval vault id/)
  })
})
