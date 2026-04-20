import { homedir } from "node:os"
import { describe, expect, it } from "vitest"
import {
  buildCodexHookCommand,
  containsTomlArrayOfTables,
  deepEqual,
  detectClaudeHook,
  detectCodexHook,
  parseInstallClient,
  toPortablePath,
} from "./install.js"

describe("install helpers", () => {
  it("defaults to installing both assistants", () => {
    expect(parseInstallClient(undefined)).toBe("both")
  })

  it("accepts explicit single-assistant targets only", () => {
    expect(parseInstallClient("claude")).toBe("claude")
    expect(parseInstallClient("codex")).toBe("codex")
    expect(parseInstallClient("both")).toBeNull()
  })

  it("rewrites paths under the current home directory into ${HOME}", () => {
    expect(toPortablePath(`${homedir()}/.lore/dist/mcp.js`)).toBe("${HOME}/.lore/dist/mcp.js")
    expect(toPortablePath("/opt/lore/dist/mcp.js")).toBe("/opt/lore/dist/mcp.js")
  })

  it("compares nested JSON-like values structurally", () => {
    expect(deepEqual({ a: [1, { b: "two" }] }, { a: [1, { b: "two" }] })).toBe(true)
    expect(deepEqual({ a: [1, { b: "two" }] }, { a: [1, { b: "three" }] })).toBe(false)
  })

  it("detects Claude hooks by the script Lore owns", () => {
    const entries = [
      {
        matcher: "",
        hooks: [{ type: "command", command: "/tmp/lore/hooks/autosave.sh" }],
      },
    ]

    expect(detectClaudeHook(entries, "autosave.sh", "/tmp/lore/hooks/autosave.sh")).toBe("current")
    expect(detectClaudeHook(entries, "autosave.sh", "/tmp/elsewhere/hooks/autosave.sh")).toBe(
      "stale",
    )
    expect(detectClaudeHook(entries, "wakeup.sh", "/tmp/lore/hooks/wakeup.sh")).toBe("missing")
  })

  it("detects Codex hooks without matching unrelated substrings", () => {
    const currentCommand = buildCodexHookCommand("/tmp/lore hooks/autosave.sh")
    const staleCommand = buildCodexHookCommand("/tmp/elsewhere/autosave.sh")
    const entries = [
      {
        hooks: [{ type: "command" as const, command: currentCommand }],
      },
    ]

    expect(detectCodexHook(entries, "autosave.sh", currentCommand)).toBe("current")
    expect(detectCodexHook(entries, "autosave.sh", staleCommand)).toBe("stale")
    expect(
      detectCodexHook(
        [{ hooks: [{ type: "command" as const, command: "echo autosave.sh backup" }] }],
        "autosave.sh",
        currentCommand,
      ),
    ).toBe("missing")
  })

  it("flags TOML array-of-tables as unsupported for Lore rewrites", () => {
    expect(containsTomlArrayOfTables("[[profile]]\nname = \"default\"\n")).toBe(true)
    expect(containsTomlArrayOfTables("# [[comment]]\n[features]\ncodex_hooks = true\n")).toBe(
      false,
    )
  })
})
