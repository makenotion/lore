import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initServices } from "../../services.js"
import { trapProcessExit } from "../test-helpers.js"
import { profileCommand } from "./profile.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

function minimalProfileFiles(name: string, version = "1.0.0"): Record<string, string> {
  return {
    "profile.yaml": `name: ${name}\nversion: ${version}\ntaxonomy: taxonomy.yaml\nschema: schema.yaml\n`,
    "taxonomy.yaml": `tags:\n  - local-tag\nentityKinds:\n  - component\nwritableFactPredicates:\n  - owns\n`,
    "schema.yaml": `databases:\n  projects:\n    properties: {}\n  topics:\n    properties: {}\n  memories:\n    properties: {}\n  entities:\n    properties: {}\n  facts:\n    properties: {}\n`,
  }
}

describe("profileCommand", () => {
  let workDir: string
  let logSpy: ReturnType<typeof vi.fn>
  let errorSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "lore-profile-cli-"))
    vi.mocked(initServices).mockReset()
    logSpy = vi.fn()
    errorSpy = vi.fn()
    vi.spyOn(console, "log").mockImplementation(logSpy)
    vi.spyOn(console, "error").mockImplementation(errorSpy)
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it("resolves a bare profile name through normal priority order", async () => {
    const localDir = join(
      workDir,
      ".lore",
      "profiles",
      "local",
      "default",
      "1.0.0"
    )
    writeFiles(localDir, minimalProfileFiles("default"))
    vi.mocked(initServices).mockResolvedValue({
      configRoot: workDir,
    } as never)

    await profileCommand.parseAsync(["show", "default"], { from: "user" })

    const output = logSpy.mock.calls.flat().join("\n")
    expect(output).toContain("Profile:        default@1.0.0")
    expect(output).toContain("Source:         local")
    expect(output).toContain(localDir)
  })

  it("rejects profile set when the resolved bundle is not loadable", async () => {
    const configPath = join(workDir, ".lore.yaml")
    writeFileSync(configPath, "vault:\n  pageId: vault-page-id\n")
    const installedDir = join(
      workDir,
      ".lore",
      "profiles",
      "installed",
      "sales",
      "1.0.0"
    )
    writeFiles(installedDir, minimalProfileFiles("support", "1.0.0"))
    vi.spyOn(process, "cwd").mockReturnValue(workDir)
    const exitTrap = trapProcessExit()

    await profileCommand.parseAsync(["set", "sales@1.0.0"], { from: "user" })

    expect(exitTrap.exitCodes).toEqual([1])
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "Profile selector sales@1.0.0 does not match"
    )
    expect(readFileSync(configPath, "utf-8")).not.toContain(
      "profile: sales@1.0.0"
    )
  })
})
