import type { Client } from "@notionhq/client"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { MissingVaultDatabasesError } from "../../notion/setup.js"
import { resolveClaudeSettingsPath } from "./claude-paths.js"
import { runDoctor, type DoctorDeps } from "./doctor.js"

const createdDirs: string[] = []
const DEV_NOTION_BASE_URL = "https://api-dev.notion.com"

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lore-doctor-test-"))
  createdDirs.push(dir)
  return dir
}

function writeConfig(dir: string, body = "vault:\n  pageId: page-1\n"): void {
  writeFileSync(join(dir, ".lore.yaml"), body, "utf-8")
}

function writeCodexHooks(
  dir: string,
  commands = {
    wakeup: "LORE_AGENT_NAME=Codex lore hooks wakeup",
    autosave: "LORE_AGENT_NAME=Codex lore hooks autosave",
  }
): void {
  mkdirSync(join(dir, ".codex"), { recursive: true })
  writeFileSync(
    join(dir, ".codex", "hooks.json"),
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [{ type: "command", command: commands.wakeup }],
            },
          ],
          Stop: [
            {
              hooks: [{ type: "command", command: commands.autosave }],
            },
          ],
        },
      },
      null,
      2
    ),
    "utf-8"
  )
}

function writeClaudeMcp(
  dir: string,
  configRoot = dir,
  notionBaseUrlLiteral?: string
): void {
  const env: Record<string, string> = {
    LORE_CONFIG_ROOT: configRoot,
    LORE_SUPPRESS_DEPRECATIONS: "1",
  }
  if (notionBaseUrlLiteral) env["NOTION_BASE_URL"] = notionBaseUrlLiteral
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          lore: {
            command: "lore",
            args: ["mcp"],
            env,
          },
        },
      },
      null,
      2
    ),
    "utf-8"
  )
}

function writeStaleClaudeMcp(dir: string, configRoot = dir): void {
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          lore: {
            command: "node",
            args: ["/tmp/old-lore/dist/mcp.js"],
            cwd: dir,
            env: { LORE_CONFIG_ROOT: configRoot, LORE_SUPPRESS_DEPRECATIONS: "1" },
          },
        },
      },
      null,
      2
    ),
    "utf-8"
  )
}

function writeUnrelatedClaudeMcp(dir: string): void {
  writeFileSync(
    join(dir, ".mcp.json"),
    JSON.stringify(
      {
        mcpServers: {
          search: {
            command: "search-mcp",
            args: ["serve"],
          },
        },
      },
      null,
      2
    ),
    "utf-8"
  )
}

function writeUnrelatedCursorMcp(path: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: {
          search: {
            command: "search-mcp",
            args: ["serve"],
          },
        },
      },
      null,
      2
    ),
    "utf-8"
  )
}

function writeCursorMcp(path: string, configRoot: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: {
          lore: {
            command: "lore",
            args: ["mcp"],
            env: {
              LORE_CONFIG_ROOT: configRoot,
              LORE_SUPPRESS_DEPRECATIONS: "1",
            },
          },
        },
      },
      null,
      2
    ),
    "utf-8"
  )
}

function writeStaleCursorMcp(path: string, configRoot: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(
    path,
    JSON.stringify(
      {
        mcpServers: {
          lore: {
            command: "node",
            args: ["/tmp/old-lore/dist/mcp.js"],
            cwd: configRoot,
            env: {
              LORE_CONFIG_ROOT: configRoot,
              LORE_SUPPRESS_DEPRECATIONS: "1",
            },
          },
        },
      },
      null,
      2
    ),
    "utf-8"
  )
}

function writeClaudeHooks(
  projectDir: string,
  homeDir: string,
  commands = {
    wakeup: 'cd "$CLAUDE_PROJECT_DIR" && lore hooks wakeup',
    autosave: 'cd "$CLAUDE_PROJECT_DIR" && lore hooks autosave',
  }
): void {
  const settingsPath = resolveClaudeSettingsPath(projectDir, homeDir)
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(
    settingsPath,
    JSON.stringify(
      {
        hooks: {
          UserPromptSubmit: [
            {
              hooks: [
                {
                  type: "command",
                  command: commands.wakeup,
                },
              ],
            },
          ],
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command: commands.autosave,
                },
              ],
            },
          ],
        },
      },
      null,
      2
    ),
    "utf-8"
  )
}

function writeCodexConfig(
  dir: string,
  featuresBlock = "[features]\nhooks = true",
  configRoot = dir,
  notionBaseUrlLiteral?: string
): void {
  mkdirSync(join(dir, ".codex"), { recursive: true })
  const staticEnv = [
    `LORE_CONFIG_ROOT='${configRoot}'`,
    "LORE_SUPPRESS_DEPRECATIONS='1'",
    ...(notionBaseUrlLiteral ? [`NOTION_BASE_URL='${notionBaseUrlLiteral}'`] : []),
  ].join(" ")
  writeFileSync(
    join(dir, ".codex", "config.toml"),
    [
      featuresBlock,
      "[mcp_servers.lore]",
      'command = "bash"',
      `args = ["-lc", "${staticEnv} lore mcp"]`,
      "env_vars = []",
    ]
      .filter((block) => block.length > 0)
      .join("\n"),
    "utf-8"
  )
}

function writeStaleCodexConfig(dir: string, configRoot = dir): void {
  mkdirSync(join(dir, ".codex"), { recursive: true })
  writeFileSync(
    join(dir, ".codex", "config.toml"),
    [
      "[features]",
      "hooks = true",
      "[mcp_servers.lore]",
      'command = "bash"',
      `args = ["-lc", "LORE_CONFIG_ROOT='${configRoot}' LORE_SUPPRESS_DEPRECATIONS='1' node '/tmp/old-lore/dist/mcp.js'"]`,
      "env_vars = []",
    ].join("\n"),
    "utf-8"
  )
}

function makeDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const client = {} as Client
  return {
    resolveAuth: vi.fn(async () => ({
      token: "ntn_test-token",
      source: "ntn-auth-json" as const,
      workspaceId: "ws-1",
    })),
    createClient: vi.fn(() => client),
    createLimitedClient: vi.fn(() => client),
    verifyVaultAccess: vi.fn(async () => ({ kind: "ok" as const, pageTitle: "Vault" })),
    verifyVaultDatabases: vi.fn(
      async () => ({ pageId: "page-1", databases: {} }) as never
    ),
    loadBackgroundFailureStatus: vi.fn(async () => ({ failures: [], totalRecent: 0 })),
    ...overrides,
  }
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

describe("runDoctor", () => {
  it("exits non-zero when config discovery misses", async () => {
    const cwd = makeTempDir()
    const deps = makeDeps()

    const result = await runDoctor({ cwd, deps, emit: false, env: {} })

    expect(result.exitCode).toBe(1)
    expect(result.lines.join("\n")).toContain("Normal discovery: no .lore.yaml found")
    expect(result.lines.join("\n")).toContain("Next action:\n  lore init")
    expect(deps.resolveAuth).not.toHaveBeenCalled()
  })

  it("exits non-zero for invalid config and skips auth and vault checks", async () => {
    const cwd = makeTempDir()
    writeConfig(cwd, 'vault:\n  pageId: ""\n')
    const deps = makeDeps()

    const result = await runDoctor({ cwd, deps, emit: false, env: {} })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain("Config failed to load")
    expect(output).toContain("Auth\n  Skipped: config did not load.")
    expect(output).toContain("Vault\n  Skipped: config and auth must resolve first.")
    expect(deps.resolveAuth).not.toHaveBeenCalled()
    expect(deps.verifyVaultAccess).not.toHaveBeenCalled()
  })

  it("exits non-zero when auth is missing", async () => {
    const cwd = makeTempDir()
    writeConfig(cwd)
    const deps = makeDeps({
      resolveAuth: vi.fn(async () => {
        throw new Error("No Notion auth configured.")
      }),
    })

    const result = await runDoctor({ cwd, deps, emit: false, env: {} })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain("Auth\n  Status: blocking - No Notion auth configured.")
    expect(output).toContain("Next action:\n  lore auth --login")
    expect(deps.verifyVaultAccess).not.toHaveBeenCalled()
  })

  it("exits non-zero when vault preflight fails", async () => {
    const cwd = makeTempDir()
    writeConfig(cwd)
    const deps = makeDeps({
      verifyVaultAccess: vi.fn(async () => ({
        kind: "not-found" as const,
        pageId: "page-1",
        message: "Vault page not accessible.",
      })),
    })

    const result = await runDoctor({ cwd, deps, emit: false, env: {} })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain("Vault page: not-found - Vault page not accessible.")
    expect(output).toContain("Next action:\n  lore auth --login")
    expect(deps.verifyVaultDatabases).not.toHaveBeenCalled()
  })

  it("points missing Entities database failures at the repair command", async () => {
    const cwd = makeTempDir()
    writeConfig(cwd)
    const deps = makeDeps({
      verifyVaultDatabases: vi.fn(async () => {
        throw new MissingVaultDatabasesError(
          "page-1",
          ["Entities"],
          ["Projects", "Topics", "Memories", "Facts"]
        )
      }),
    })

    const result = await runDoctor({ cwd, deps, emit: false, env: {} })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain("Required databases: missing Entities")
    expect(output).toContain("Next action:\n  lore vault ensure-entities")
  })

  it("reports present MCP host config and matching LORE_CONFIG_ROOT", async () => {
    const cwd = makeTempDir()
    const homeDir = makeTempDir()
    writeConfig(cwd)
    mkdirSync(join(cwd, ".codex"), { recursive: true })
    writeClaudeMcp(cwd)
    writeClaudeHooks(cwd, homeDir)
    writeCodexConfig(cwd)
    writeCodexHooks(cwd)

    const result = await runDoctor({
      cwd,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(0)
    expect(output).toContain(".mcp.json: Lore MCP entry present")
    expect(output).toContain(".codex/config.toml: Lore MCP entry present")
    expect(output).toContain(`LORE_CONFIG_ROOT: matches ${cwd}`)
  })

  it("uses Claude Code home-scoped settings for healthy hooks", async () => {
    const cwd = makeTempDir()
    const homeDir = makeTempDir()
    writeConfig(cwd)
    writeClaudeMcp(cwd)
    writeClaudeHooks(cwd, homeDir)

    const result = await runDoctor({
      cwd,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(0)
    expect(output).toContain(
      `~/.claude/projects/${cwd.replace(/\//g, "-")}/settings.json: present; no legacy Lore MCP entry`
    )
    expect(output).toContain("Claude Code wakeup hook: present")
    expect(output).toContain("Claude Code autosave hook: present")
    expect(output).toContain("Next action:\n  No action needed.")
  })

  it("exits non-zero when Claude Code hooks use stale bare commands", async () => {
    const cwd = makeTempDir()
    const homeDir = makeTempDir()
    writeConfig(cwd)
    writeClaudeMcp(cwd)
    writeClaudeHooks(cwd, homeDir, {
      wakeup: "lore hooks wakeup",
      autosave: "lore hooks autosave",
    })

    const result = await runDoctor({
      cwd,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain("Claude Code wakeup hook: stale")
    expect(output).toContain("Claude Code autosave hook: stale")
    expect(output).toContain("Next action:\n  lore install")
  })

  it("does not require Claude Code hooks for unrelated settings", async () => {
    const cwd = makeTempDir()
    const homeDir = makeTempDir()
    writeConfig(cwd)
    writeClaudeHooks(cwd, homeDir, {
      wakeup: "echo unrelated-wakeup",
      autosave: "echo unrelated-autosave",
    })

    const result = await runDoctor({
      cwd,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(0)
    expect(output).toContain("Claude Code wakeup hook: missing")
    expect(output).toContain("Claude Code autosave hook: missing")
    expect(output).toContain("Next action:\n  No action needed.")
  })

  it("does not require Codex hooks for unrelated hooks config", async () => {
    const cwd = makeTempDir()
    writeConfig(cwd)
    mkdirSync(join(cwd, ".codex"), { recursive: true })
    writeFileSync(
      join(cwd, ".codex", "config.toml"),
      "[features]\nhooks = false\n",
      "utf-8"
    )
    writeCodexHooks(cwd, {
      wakeup: "echo unrelated-wakeup",
      autosave: "echo unrelated-autosave",
    })

    const result = await runDoctor({ cwd, deps: makeDeps(), emit: false, env: {} })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(0)
    expect(output).toContain(".codex/config.toml: present, Lore MCP entry missing")
    expect(output).toContain("Codex hooks feature: not true (false)")
    expect(output).toContain("Codex wakeup hook: missing")
    expect(output).toContain("Codex autosave hook: missing")
    expect(output).toContain("Next action:\n  No action needed.")
  })

  it("does not require Lore in unrelated JSON MCP files", async () => {
    const cwd = makeTempDir()
    const homeDir = makeTempDir()
    writeConfig(cwd)
    writeUnrelatedClaudeMcp(cwd)
    writeUnrelatedCursorMcp(join(cwd, ".cursor", "mcp.json"))
    writeUnrelatedCursorMcp(join(homeDir, ".cursor", "mcp.json"))

    const result = await runDoctor({
      cwd,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(0)
    expect(output).toContain(".mcp.json: present, Lore MCP entry missing")
    expect(output).toContain(".cursor/mcp.json: present, Lore MCP entry missing")
    expect(output).toContain("~/.cursor/mcp.json: present, Lore MCP entry missing")
    expect(output).toContain("Next action:\n  No action needed.")
  })

  it("ignores stale global Cursor MCP when project Cursor MCP is active", async () => {
    const cwd = makeTempDir()
    const homeDir = makeTempDir()
    const wrongRoot = makeTempDir()
    writeConfig(cwd)
    writeCursorMcp(join(cwd, ".cursor", "mcp.json"), cwd)
    writeCursorMcp(join(homeDir, ".cursor", "mcp.json"), wrongRoot)

    const result = await runDoctor({
      cwd,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(0)
    expect(output).toContain(".cursor/mcp.json: Lore MCP entry present")
    expect(output).toContain(
      "~/.cursor/mcp.json: Lore MCP entry present (shadowed by project .cursor/mcp.json)"
    )
    expect(
      result.problems.some(
        (problem) =>
          problem.message === "~/.cursor/mcp.json has a stale LORE_CONFIG_ROOT."
      )
    ).toBe(false)
    expect(output).toContain("Next action:\n  No action needed.")
  })

  it("fails stale global Cursor MCP when no project Cursor MCP shadows it", async () => {
    const cwd = makeTempDir()
    const homeDir = makeTempDir()
    const wrongRoot = makeTempDir()
    writeConfig(cwd)
    writeUnrelatedCursorMcp(join(cwd, ".cursor", "mcp.json"))
    writeCursorMcp(join(homeDir, ".cursor", "mcp.json"), wrongRoot)

    const result = await runDoctor({
      cwd,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain(".cursor/mcp.json: present, Lore MCP entry missing")
    expect(output).toContain("~/.cursor/mcp.json: Lore MCP entry present")
    expect(
      result.problems.some(
        (problem) =>
          problem.message === "~/.cursor/mcp.json has a stale LORE_CONFIG_ROOT."
      )
    ).toBe(true)
    expect(output).toContain("Next action:\n  lore install")
  })

  it("exits non-zero when Claude MCP launcher is stale with matching config root", async () => {
    const cwd = makeTempDir()
    const homeDir = makeTempDir()
    writeConfig(cwd)
    writeStaleClaudeMcp(cwd)
    writeClaudeHooks(cwd, homeDir)

    const result = await runDoctor({
      cwd,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain(".mcp.json: Lore MCP entry present")
    expect(output).toContain(`LORE_CONFIG_ROOT: matches ${cwd}`)
    expect(output).toContain("launcher: stale")
    expect(
      result.problems.some(
        (problem) => problem.message === ".mcp.json has a stale Lore MCP launcher."
      )
    ).toBe(true)
    expect(output).toContain("Next action:\n  lore install")
  })

  it("exits non-zero when project Cursor MCP launcher is stale with matching config root", async () => {
    const cwd = makeTempDir()
    const homeDir = makeTempDir()
    writeConfig(cwd)
    writeStaleCursorMcp(join(cwd, ".cursor", "mcp.json"), cwd)

    const result = await runDoctor({
      cwd,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain(".cursor/mcp.json: Lore MCP entry present")
    expect(output).toContain(`LORE_CONFIG_ROOT: matches ${cwd}`)
    expect(output).toContain("launcher: stale")
    expect(
      result.problems.some(
        (problem) => problem.message === ".cursor/mcp.json has a stale Lore MCP launcher."
      )
    ).toBe(true)
    expect(output).toContain("Next action:\n  lore install")
  })

  it("exits non-zero when Codex MCP launcher is stale with matching config root", async () => {
    const cwd = makeTempDir()
    writeConfig(cwd)
    writeStaleCodexConfig(cwd)
    writeCodexHooks(cwd)

    const result = await runDoctor({ cwd, deps: makeDeps(), emit: false, env: {} })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain(".codex/config.toml: Lore MCP entry present")
    expect(output).toContain(`LORE_CONFIG_ROOT: matches ${cwd}`)
    expect(output).toContain("launcher: stale")
    expect(
      result.problems.some(
        (problem) =>
          problem.message === ".codex/config.toml has a stale Lore MCP launcher."
      )
    ).toBe(true)
    expect(output).toContain("Next action:\n  lore install")
  })

  it("treats a dev Claude MCP launcher literal as current", async () => {
    const cwd = makeTempDir()
    const homeDir = makeTempDir()
    writeConfig(cwd)
    writeClaudeMcp(cwd, cwd, DEV_NOTION_BASE_URL)
    writeClaudeHooks(cwd, homeDir)

    const result = await runDoctor({
      cwd,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(0)
    expect(output).toContain(".mcp.json: Lore MCP entry present")
    expect(output).toContain("launcher: current")
    expect(output).not.toContain("launcher: stale")
    expect(output).toContain("Next action:\n  No action needed.")
  })

  it("treats a dev Codex MCP launcher literal as current", async () => {
    const cwd = makeTempDir()
    writeConfig(cwd)
    writeCodexConfig(cwd, undefined, cwd, DEV_NOTION_BASE_URL)
    writeCodexHooks(cwd)

    const result = await runDoctor({ cwd, deps: makeDeps(), emit: false, env: {} })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(0)
    expect(output).toContain(".codex/config.toml: Lore MCP entry present")
    expect(output).toContain("launcher: current")
    expect(output).not.toContain("launcher: stale")
    expect(output).toContain("Next action:\n  No action needed.")
  })

  it("uses nearest nested host configs while comparing against the discovered config root", async () => {
    const root = makeTempDir()
    const homeDir = makeTempDir()
    const child = join(root, "mail-ios")
    mkdirSync(child, { recursive: true })
    writeConfig(root)
    writeStaleClaudeMcp(root)
    writeStaleCodexConfig(root)
    writeStaleCursorMcp(join(root, ".cursor", "mcp.json"), root)
    writeClaudeMcp(child, root)
    writeClaudeHooks(child, homeDir)
    writeCodexConfig(child, undefined, root)
    writeCodexHooks(child)
    writeCursorMcp(join(child, ".cursor", "mcp.json"), root)

    const result = await runDoctor({
      cwd: child,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(0)
    expect(output).toContain(`Normal discovery: ${join(root, ".lore.yaml")}`)
    expect(output).toContain(`LORE_CONFIG_ROOT: matches ${root}`)
    expect(output).toContain(
      `~/.claude/projects/${child.replace(/\//g, "-")}/settings.json: present; no legacy Lore MCP entry`
    )
    expect(output).toContain("launcher: current")
    expect(output).not.toContain("launcher: stale")
    expect(output).toContain("Next action:\n  No action needed.")
  })

  it.each([
    [
      "Claude Code",
      (dir: string, homeDir: string) => writeClaudeHooks(dir, homeDir),
      "Claude Code hooks are present while Claude Code Lore MCP is not configured.",
    ],
    [
      "Codex",
      (dir: string) => {
        mkdirSync(join(dir, ".codex"), { recursive: true })
        writeFileSync(
          join(dir, ".codex", "config.toml"),
          "[features]\nhooks = true\n",
          "utf-8"
        )
        writeCodexHooks(dir)
      },
      "Codex hooks are present while Codex Lore MCP is not configured.",
    ],
  ])(
    "exits non-zero when %s has Lore hooks without Lore MCP config",
    async (_host, writeHooksOnly, message) => {
      const cwd = makeTempDir()
      const homeDir = makeTempDir()
      writeConfig(cwd)
      writeHooksOnly(cwd, homeDir)

      const result = await runDoctor({
        cwd,
        homeDir,
        deps: makeDeps(),
        emit: false,
        env: {},
      })

      const output = result.lines.join("\n")
      expect(result.exitCode).toBe(1)
      expect(result.problems.some((problem) => problem.message === message)).toBe(true)
      expect(output).toContain("Next action:\n  lore install")
    }
  )

  it.each([
    ["missing", ""],
    ["not true (false)", "[features]\nhooks = false"],
  ])(
    "exits non-zero when healthy Codex hooks have %s features.hooks",
    async (featureStatus, featuresBlock) => {
      const cwd = makeTempDir()
      writeConfig(cwd)
      writeCodexConfig(cwd, featuresBlock)
      writeCodexHooks(cwd)

      const result = await runDoctor({ cwd, deps: makeDeps(), emit: false, env: {} })

      const output = result.lines.join("\n")
      expect(result.exitCode).toBe(1)
      expect(output).toContain(`Codex hooks feature: ${featureStatus}`)
      expect(output).toContain("Codex wakeup hook: present")
      expect(output).toContain("Codex autosave hook: present")
      expect(output).toContain("Next action:\n  lore install")
    }
  )

  it("exits non-zero when Codex MCP is installed but hooks.json is missing", async () => {
    const cwd = makeTempDir()
    writeConfig(cwd)
    writeCodexConfig(cwd)

    const result = await runDoctor({ cwd, deps: makeDeps(), emit: false, env: {} })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain(".codex/config.toml: Lore MCP entry present")
    expect(output).toContain("Codex hooks feature: enabled")
    expect(output).toContain("Codex hooks: not present")
    expect(output).toContain("Next action:\n  lore install")
  })

  it("exits non-zero when Claude MCP is installed but settings hooks are missing", async () => {
    const cwd = makeTempDir()
    const homeDir = makeTempDir()
    writeConfig(cwd)
    writeClaudeMcp(cwd)

    const result = await runDoctor({
      cwd,
      homeDir,
      deps: makeDeps(),
      emit: false,
      env: {},
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain(".mcp.json: Lore MCP entry present")
    expect(output).toContain(
      "Claude Code hooks: not present (required by .mcp.json Lore MCP entry)"
    )
    expect(output).toContain("Next action:\n  lore install")
  })

  it.each([
    [
      "Codex",
      (dir: string) => writeCodexConfig(dir),
      ".codex/config.toml: Lore MCP entry present",
      "Codex hooks: not present",
    ],
    [
      "Claude Code",
      (dir: string) => writeClaudeMcp(dir),
      ".mcp.json: Lore MCP entry present",
      "Claude Code hooks: not present (required by .mcp.json Lore MCP entry)",
    ],
  ])(
    "uses the config root for %s partial installs when run from a child directory",
    async (_host, writePartialInstall, hostLine, hooksLine) => {
      const root = makeTempDir()
      const homeDir = makeTempDir()
      const child = join(root, "packages", "foo")
      mkdirSync(child, { recursive: true })
      writeConfig(root)
      writePartialInstall(root)

      const result = await runDoctor({
        cwd: child,
        homeDir,
        deps: makeDeps(),
        emit: false,
        env: {},
      })

      const output = result.lines.join("\n")
      expect(result.exitCode).toBe(1)
      expect(output).toContain(`Normal discovery: ${join(root, ".lore.yaml")}`)
      expect(output).toContain(hostLine)
      expect(output).toContain(hooksLine)
      expect(output).toContain("Next action:\n  lore install")
    }
  )

  it("prints every healthy section and exits zero", async () => {
    const cwd = makeTempDir()
    writeConfig(cwd)

    const result = await runDoctor({ cwd, deps: makeDeps(), emit: false, env: {} })

    expect(result.exitCode).toBe(0)
    expect(result.lines).toEqual(
      expect.arrayContaining([
        "Config",
        "Auth",
        "Vault",
        "MCP host config",
        "Hooks",
        "Next action:",
        "  No action needed.",
      ])
    )
  })

  it("treats LORE_CONFIG_ROOT without .lore.yaml as the blocking config source", async () => {
    const cwd = makeTempDir()
    const wrongRoot = makeTempDir()
    writeConfig(cwd)
    const deps = makeDeps()

    const result = await runDoctor({
      cwd,
      deps,
      emit: false,
      env: { LORE_CONFIG_ROOT: wrongRoot },
    })

    const output = result.lines.join("\n")
    expect(result.exitCode).toBe(1)
    expect(output).toContain(`LORE_CONFIG_ROOT: ${wrongRoot}`)
    expect(output).toContain("    .lore.yaml: missing")
    expect(output).toContain(`Normal discovery: ${join(cwd, ".lore.yaml")}`)
    expect(output).toContain(
      "Next action:\n  1. unset LORE_CONFIG_ROOT\n  2. lore doctor"
    )
    expect(deps.resolveAuth).not.toHaveBeenCalled()
  })
})
