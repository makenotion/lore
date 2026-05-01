import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, describe, expect, it, vi } from "vitest"

// runPrintConfig calls fileExists(dist/mcp.js) before printing. Under vitest
// the source-file `import.meta.url` resolves pkgRoot to `src/cli/`, not the
// package root, so dist/mcp.js doesn't exist at the computed path even on a
// fresh `npm run build`. Stub access ONLY for the dist/mcp.js probe; every
// other path passes through to the real fs.access. Tightly scoping the stub
// keeps the runtime tests honest — if a future refactor accidentally drops
// the `if (opts.printConfig != null) { ... return }` short-circuit and falls
// into prepareInstallContext, the hooks/autosave.sh and hooks/wakeup.sh
// existence checks would still hit the real filesystem and fail loudly
// rather than silently passing under a blanket-true stub.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...actual,
    access: async (path: import("node:fs").PathLike, mode?: number) => {
      if (typeof path === "string" && path.endsWith("/dist/mcp.js")) return undefined
      return actual.access(path, mode)
    },
  }
})
import {
  buildClaudeHookCommand,
  buildClaudeMcpEntry,
  buildCodexHookCommand,
  buildCodexMcpSection,
  buildCursorGlobalIgnoredNotice,
  buildCursorMcpEntry,
  buildLegacyClaudeMcpEntry,
  buildLegacyCodexHookCommand,
  buildLegacyCodexMcpSection,
  buildLegacyCursorMcpEntry,
  buildPrintConfigOutput,
  containsTomlArrayOfTables,
  deepEqual,
  detectClaudeHook,
  detectCodexHook,
  displayHomePath,
  dispatchInstall,
  ensureHookPrerequisites,
  installCommand,
  isDeprecatedInstallClient,
  parseInstallClient,
  parsePrintConfigFormat,
  removeClaudeScriptEntries,
  resolveCursorMcpPath,
  runCursorInstall,
  stripLoreOwnedSessionEndEntries,
  stripShellEnvPrefix,
  toPortablePath,
  type ClaudeHookEntry,
  type InstallContext,
  type InstallRunners,
} from "./install.js"

describe("install helpers", () => {
  it("defaults to installing all assistants", () => {
    expect(parseInstallClient(undefined)).toBe("all")
  })

  it("accepts the four supported client values", () => {
    expect(parseInstallClient("claude")).toBe("claude")
    expect(parseInstallClient("codex")).toBe("codex")
    expect(parseInstallClient("cursor")).toBe("cursor")
    expect(parseInstallClient("all")).toBe("all")
  })

  it("accepts the deprecated 'both' alias and maps it to 'all'", () => {
    expect(parseInstallClient("both")).toBe("all")
    expect(isDeprecatedInstallClient("both")).toBe(true)
    expect(isDeprecatedInstallClient("all")).toBe(false)
    expect(isDeprecatedInstallClient(undefined)).toBe(false)
  })

  it("rejects unrecognized client values, including the empty string", () => {
    // Only `undefined` (option omitted entirely) routes to the `"all"`
    // default. An explicit empty string is treated as a malformed value
    // and routes through the unrecognized-value error path so the CLI
    // doesn't silently dispatch every installer for `--client ""`.
    expect(parseInstallClient("aider")).toBeNull()
    expect(parseInstallClient("")).toBeNull()
  })

  it("rewrites paths under the current home directory into ${HOME}", () => {
    expect(toPortablePath(`${homedir()}/.lore/dist/mcp.js`)).toBe("${HOME}/.lore/dist/mcp.js")
    expect(toPortablePath("/opt/lore/dist/mcp.js")).toBe("/opt/lore/dist/mcp.js")
  })

  it("displayHomePath anchors at the home prefix (not substring) so inner matches survive", () => {
    // The buggy `String.replace(homedir(), "~")` shortcut hits the first
    // occurrence — anywhere in the string. A path like
    // `/Users/foo/work/Users/foo/legacy` would get the inner occurrence
    // mangled. The anchored helper only rewrites a true home prefix.
    const home = homedir()
    expect(displayHomePath(`${home}/.lore/dist/mcp.js`)).toBe("~/.lore/dist/mcp.js")
    expect(displayHomePath(`${home}`)).toBe("~")
    expect(displayHomePath("/opt/lore/dist/mcp.js")).toBe("/opt/lore/dist/mcp.js")
    // Inner-occurrence path: the helper must NOT collapse it because the
    // path doesn't start at home.
    const trickyPath = `/var/${home.slice(1)}/legacy`
    expect(displayHomePath(trickyPath)).toBe(trickyPath)
  })

  it("toPortablePath is idempotent — re-applying to an already-portable path returns it unchanged", () => {
    // buildPrintConfigOutput double-applies toPortablePath when format='toml'
    // (once on its own input, once inside buildCodexMcpSection). The result
    // stays byte-identical to a single application because a `${HOME}/...`
    // path does not start with the current `home + "/"` prefix and falls
    // through unchanged. Pinning this property keeps the print path's
    // byte-identity guarantee from regressing on a future toPortablePath
    // refactor.
    const homePath = `${homedir()}/.lore/dist/mcp.js`
    expect(toPortablePath(toPortablePath(homePath))).toBe(toPortablePath(homePath))

    const nonHomePath = "/opt/lore/dist/mcp.js"
    expect(toPortablePath(toPortablePath(nonHomePath))).toBe(toPortablePath(nonHomePath))
  })

  it("compares nested JSON-like values structurally", () => {
    expect(deepEqual({ a: [1, { b: "two" }] }, { a: [1, { b: "two" }] })).toBe(true)
    expect(deepEqual({ a: [1, { b: "two" }] }, { a: [1, { b: "three" }] })).toBe(false)
  })

  it("detects legacy absolute-path Claude hooks against the resolved pkgRoot", () => {
    // 0.11.0 detection taxonomy: a legacy hook entry that points at the
    // resolved `pkgRoot` is `legacy-current`, an entry that points
    // elsewhere is `stale`, and absence is `missing`. The bin-dispatch
    // 4th arg is omitted here so detection treats the hook strictly as
    // a legacy entry.
    const entries = [
      {
        matcher: "",
        hooks: [{ type: "command", command: "/tmp/lore/hooks/autosave.sh" }],
      },
    ]

    expect(detectClaudeHook(entries, "autosave.sh", "/tmp/lore/hooks/autosave.sh")).toBe(
      "legacy-current",
    )
    expect(detectClaudeHook(entries, "autosave.sh", "/tmp/elsewhere/hooks/autosave.sh")).toBe(
      "stale",
    )
    expect(detectClaudeHook(entries, "wakeup.sh", "/tmp/lore/hooks/wakeup.sh")).toBe("missing")
  })

  it("detects bin-dispatch Claude hook entries as current", () => {
    const binCommand = buildClaudeHookCommand("autosave")
    const entries = [
      {
        matcher: "",
        hooks: [{ type: "command", command: binCommand }],
      },
    ]
    // Legacy path doesn't match (no `.sh` suffix) but the bin-dispatch
    // command does — `current`.
    expect(
      detectClaudeHook(entries, "autosave.sh", "/tmp/lore/hooks/autosave.sh", binCommand),
    ).toBe("current")
  })

  it("detects legacy Codex hooks without matching unrelated substrings", () => {
    // Pre-0.11.0 absolute-path Codex hook entries surface as
    // `legacy-current` when they match the resolved pkgRoot, `stale`
    // when they point elsewhere. Detection is shape-aware: the
    // bin-dispatch form goes through the new `binDispatchCommand`
    // arg, the legacy form through `legacyExpectedCommand`.
    const currentCommand = buildLegacyCodexHookCommand("/tmp/lore/hooks/autosave.sh")
    const staleCommand = buildLegacyCodexHookCommand("/tmp/elsewhere/autosave.sh")
    const entries = [
      {
        hooks: [{ type: "command" as const, command: currentCommand }],
      },
    ]

    expect(detectCodexHook(entries, "autosave.sh", currentCommand)).toBe("legacy-current")
    expect(detectCodexHook(entries, "autosave.sh", staleCommand)).toBe("stale")
    expect(
      detectCodexHook(
        [{ hooks: [{ type: "command" as const, command: "echo autosave.sh backup" }] }],
        "autosave.sh",
        currentCommand,
      ),
    ).toBe("missing")
  })

  it("classifies a bin-dispatch Codex hook entry as current", () => {
    const binCommand = buildCodexHookCommand("autosave")
    const legacyCommand = buildLegacyCodexHookCommand("/tmp/lore/hooks/autosave.sh")
    const entries = [{ hooks: [{ type: "command" as const, command: binCommand }] }]

    expect(detectCodexHook(entries, "autosave.sh", legacyCommand, binCommand)).toBe("current")
  })

  it("prefixes Codex hook commands with LORE_AGENT_NAME=Codex (bin-dispatch and legacy)", () => {
    expect(buildCodexHookCommand("wakeup")).toBe("LORE_AGENT_NAME=Codex lore hooks wakeup")
    const legacy = buildLegacyCodexHookCommand("/tmp/lore/hooks/wakeup.sh")
    expect(legacy.startsWith("LORE_AGENT_NAME=Codex ")).toBe(true)
    // The quoted script path stays intact after the prefix so Codex can
    // invoke it verbatim as a shell string.
    expect(legacy.endsWith("/wakeup.sh\"")).toBe(true)
  })

  it("emits the bin-dispatch Claude hook command for each event name", () => {
    expect(buildClaudeHookCommand("wakeup")).toBe("lore hooks wakeup")
    expect(buildClaudeHookCommand("autosave")).toBe("lore hooks autosave")
    expect(buildClaudeHookCommand("session-end")).toBe("lore hooks session-end")
  })

  it("flags a Codex hook entry missing the env prefix as stale", () => {
    const expected = buildLegacyCodexHookCommand("/tmp/lore/hooks/wakeup.sh")
    // Pre-PF1-04 install shape: path-only command, no LORE_AGENT_NAME prefix.
    const legacyCommand = JSON.stringify("/tmp/lore/hooks/wakeup.sh")

    const entries = [{ hooks: [{ type: "command" as const, command: legacyCommand }] }]
    expect(detectCodexHook(entries, "wakeup.sh", expected)).toBe("stale")
  })

  it("classifies a prefixed legacy Codex hook entry as legacy-current when the path matches", () => {
    const expected = buildLegacyCodexHookCommand("/tmp/lore/hooks/wakeup.sh")
    const entries = [{ hooks: [{ type: "command" as const, command: expected }] }]
    expect(detectCodexHook(entries, "wakeup.sh", expected)).toBe("legacy-current")
  })

  it("buildClaudeMcpEntry emits the yarn-wrapped shape under shape='yarn' (Yarn PnP consumers)", () => {
    // 0.9.1 — Yarn Berry / Yarn 4 PnP consumers don't populate
    // node_modules/.bin/lore, so `command: "lore"` would not resolve
    // at host-launch time. The yarn-wrapped form delegates to Yarn's
    // PnPAPI and works inside any PnP project.
    expect(buildClaudeMcpEntry("yarn")).toEqual({
      command: "yarn",
      args: ["lore", "mcp"],
      env: {
        LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}",
        LORE_NOTION_BASE_URL: "${LORE_NOTION_BASE_URL}",
      },
    })
  })

  it("buildClaudeHookCommand wraps with yarn under shape='yarn'", () => {
    expect(buildClaudeHookCommand("autosave", "yarn")).toBe("yarn lore hooks autosave")
    expect(buildClaudeHookCommand("wakeup", "yarn")).toBe("yarn lore hooks wakeup")
  })

  it("buildCodexHookCommand wraps with yarn under shape='yarn' (preserves env prefix)", () => {
    // The LORE_AGENT_NAME=Codex prefix MUST stay intact so the
    // detector and `stripShellEnvPrefix` continue to recognize the
    // hook entry as Lore-owned across reinstalls.
    expect(buildCodexHookCommand("wakeup", "yarn")).toBe(
      "LORE_AGENT_NAME=Codex yarn lore hooks wakeup",
    )
    expect(buildCodexHookCommand("autosave", "yarn")).toBe(
      "LORE_AGENT_NAME=Codex yarn lore hooks autosave",
    )
  })

  it("buildCodexMcpSection emits the yarn-wrapped TOML shape under shape='yarn'", () => {
    const section = buildCodexMcpSection("yarn")
    expect(section).toContain('command = "yarn"')
    expect(section).toContain('args = ["lore", "mcp"]')
    expect(section).not.toContain('command = "lore"')
  })

  it("buildClaudeMcpEntry emits portable bin-dispatch shape with no paths", () => {
    // 0.11.0 acceptance criterion: the default `.mcp.json` entry
    // contains no absolute paths and no `${HOME}` placeholders, so the
    // committed file resolves identically on every engineer's machine.
    const entry = buildClaudeMcpEntry()
    expect(entry).toEqual({
      command: "lore",
      args: ["mcp"],
      env: {
        LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}",
        LORE_NOTION_BASE_URL: "${LORE_NOTION_BASE_URL}",
      },
    })
    // `cwd` is intentionally absent on the bin-dispatch path — pinning a
    // specific cwd would defeat the portability gain.
    expect("cwd" in entry).toBe(false)
  })

  it("buildCodexMcpSection emits the bin-dispatch TOML shape", () => {
    const section = buildCodexMcpSection()
    expect(section).toContain("[mcp_servers.lore]")
    expect(section).toContain('command = "lore"')
    expect(section).toContain('args = ["mcp"]')
    // No bash wrapper, no node command, no absolute path on the
    // default bin-dispatch path.
    expect(section).not.toContain('command = "bash"')
    expect(section).not.toContain("dist/mcp.js")
  })

  it("detectClaudeHook prefers bin-dispatch match over legacy-current when both are present", () => {
    // A pathological config with both shapes registered shouldn't
    // happen in practice, but if it does, detection picks the
    // bin-dispatch entry first because it iterates entries in order
    // and bin-dispatch is what `upsertClaudeHookCommand` writes today.
    // The runner's strip-both-shapes pre-pass prevents the dual-entry
    // shape from outliving any single install — but the detection
    // primitive must not panic if it sees one in the wild.
    const binCommand = buildClaudeHookCommand("autosave")
    const entries = [
      { matcher: "", hooks: [{ type: "command", command: binCommand }] },
      { matcher: "", hooks: [{ type: "command", command: "/tmp/lore/hooks/autosave.sh" }] },
    ]
    expect(
      detectClaudeHook(entries, "autosave.sh", "/tmp/lore/hooks/autosave.sh", binCommand),
    ).toBe("current")
  })

  it("flags TOML array-of-tables as unsupported for Lore rewrites", () => {
    expect(containsTomlArrayOfTables("[[profile]]\nname = \"default\"\n")).toBe(true)
    expect(containsTomlArrayOfTables("# [[comment]]\n[features]\ncodex_hooks = true\n")).toBe(
      false,
    )
  })
})

describe("Cursor helpers", () => {
  // Cursor MCP integration mirrors the Claude `.mcp.json` shape — same
  // command/args/cwd/env keys, same `${VAR}` placeholder convention from
  // LORE_MCP_ENV_VARS. Tests pin the shape so a Cursor schema change shows
  // up here rather than as a silent runtime mismatch in a Cursor session.

  it("builds a bin-dispatch Cursor MCP entry that matches the Claude entry shape", () => {
    expect(buildCursorMcpEntry()).toEqual(buildClaudeMcpEntry())
    expect(buildCursorMcpEntry()).toEqual({
      command: "lore",
      args: ["mcp"],
      env: {
        LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}",
        LORE_NOTION_BASE_URL: "${LORE_NOTION_BASE_URL}",
      },
    })
  })

  it("builds a legacy absolute-path Cursor MCP entry under buildLegacyCursorMcpEntry", () => {
    const entry = buildLegacyCursorMcpEntry("${HOME}/.lore/dist/mcp.js", "${HOME}/.lore")
    expect(entry).toEqual({
      command: "node",
      args: ["${HOME}/.lore/dist/mcp.js"],
      cwd: "${HOME}/.lore",
      env: {
        LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}",
        LORE_NOTION_BASE_URL: "${LORE_NOTION_BASE_URL}",
      },
    })
  })

  it("re-running buildLegacyCursorMcpEntry produces deepEqual output for idempotency checks", () => {
    // The install path determines drift via `deepEqual(existing, expected)`,
    // so two builds with the same inputs must compare equal.
    const a = buildLegacyCursorMcpEntry("${HOME}/.lore/dist/mcp.js", "${HOME}/.lore")
    const b = buildLegacyCursorMcpEntry("${HOME}/.lore/dist/mcp.js", "${HOME}/.lore")
    expect(deepEqual(a, b)).toBe(true)
  })

  it("detects drift when the legacy MCP path moves", () => {
    const previous = buildLegacyCursorMcpEntry("${HOME}/.lore/dist/mcp.js", "${HOME}/.lore")
    const current = buildLegacyCursorMcpEntry("${HOME}/.lore/dist/mcp.js", "${HOME}/.lore-2")
    expect(deepEqual(previous, current)).toBe(false)
  })

  it("resolves the project-scoped Cursor mcp.json path by default", () => {
    const projectDir = "/Users/operator/work/project"
    expect(resolveCursorMcpPath(projectDir, false)).toBe(
      "/Users/operator/work/project/.cursor/mcp.json",
    )
  })

  it("resolves the global Cursor mcp.json path under --cursor-global", () => {
    expect(resolveCursorMcpPath("/Users/operator/work/project", true)).toBe(
      `${homedir()}/.cursor/mcp.json`,
    )
  })

  it("buildCursorGlobalIgnoredNotice fires only when Cursor is out of scope", () => {
    // The action handler emits this note to stderr when an operator passes
    // `--cursor-global` alongside a `--client` value that doesn't include
    // Cursor — Claude / Codex. For Cursor itself or `all` (where Cursor is
    // one of the three branches), the flag is meaningful and no note is
    // emitted.
    expect(buildCursorGlobalIgnoredNotice(true, "claude")).toBe(
      "Note: --cursor-global has no effect under --client claude (Cursor not selected); ignored.",
    )
    expect(buildCursorGlobalIgnoredNotice(true, "codex")).toBe(
      "Note: --cursor-global has no effect under --client codex (Cursor not selected); ignored.",
    )
    expect(buildCursorGlobalIgnoredNotice(true, "cursor")).toBeNull()
    expect(buildCursorGlobalIgnoredNotice(true, "all")).toBeNull()
  })

  it("buildCursorGlobalIgnoredNotice returns null when the flag is absent", () => {
    // No `--cursor-global` → no note, regardless of the client value. Both
    // `false` and `undefined` (omitted) hit this branch.
    expect(buildCursorGlobalIgnoredNotice(false, "claude")).toBeNull()
    expect(buildCursorGlobalIgnoredNotice(undefined, "claude")).toBeNull()
    expect(buildCursorGlobalIgnoredNotice(false, "all")).toBeNull()
  })
})

describe("SessionEnd cleanup (issue 0.6.0/26)", () => {
  // 0.6.0 stops registering a Claude Code SessionEnd hook. `lore install`
  // must strip Lore-owned SessionEnd entries on reinstall while preserving
  // any unrelated user hooks installed on the same event.

  function loreSessionEndEntry(): ClaudeHookEntry {
    return {
      matcher: "",
      hooks: [{ type: "command", command: "/tmp/lore/hooks/session-end.sh" }],
    }
  }

  function legacyAutosaveOnSessionEndEntry(): ClaudeHookEntry {
    // Pre-P2-04 install shape: the older `autosave.sh`-on-SessionEnd
    // registration that Lore replaced with `session-end.sh`. `lore install`
    // still needs to clean it up if it's been sitting in a stale settings
    // file across multiple upgrades.
    return {
      matcher: "",
      hooks: [{ type: "command", command: "/tmp/lore/hooks/autosave.sh" }],
    }
  }

  function userOwnedSessionEndEntry(): ClaudeHookEntry {
    return {
      matcher: "",
      hooks: [{ type: "command", command: "/Users/operator/scripts/notify.sh" }],
    }
  }

  it("removes Lore-owned session-end.sh entries", () => {
    const entries = [loreSessionEndEntry()]
    expect(removeClaudeScriptEntries(entries, "session-end.sh")).toBeUndefined()
  })

  it("removes legacy SessionEnd -> autosave.sh entries", () => {
    const entries = [legacyAutosaveOnSessionEndEntry()]
    expect(removeClaudeScriptEntries(entries, "autosave.sh")).toBeUndefined()
  })

  it("preserves unrelated user hooks when stripping the Lore-owned shim", () => {
    // Acceptance criterion: unrelated user hooks in Claude settings are
    // preserved across reinstalls. Strip the Lore-owned entry and check
    // the user-owned one survives untouched.
    const entries = [loreSessionEndEntry(), userOwnedSessionEndEntry()]
    const result = removeClaudeScriptEntries(entries, "session-end.sh")
    expect(result).toBeDefined()
    expect(result).toHaveLength(1)
    expect(result![0]!.hooks[0]!.command).toBe("/Users/operator/scripts/notify.sh")
  })

  it("preserves unrelated user hooks when stripping the legacy autosave registration", () => {
    const entries = [legacyAutosaveOnSessionEndEntry(), userOwnedSessionEndEntry()]
    const result = removeClaudeScriptEntries(entries, "autosave.sh")
    expect(result).toBeDefined()
    expect(result).toHaveLength(1)
    expect(result![0]!.hooks[0]!.command).toBe("/Users/operator/scripts/notify.sh")
  })

  it("returns undefined for an empty entry list so callers can `delete settings.hooks.SessionEnd`", () => {
    // The install path checks `if (!mergedHooks["SessionEnd"]) delete ...`
    // — `removeClaudeScriptEntries` returning undefined is what triggers
    // the delete, leaving no `SessionEnd` key behind on a vault whose
    // only entry was Lore-owned. A regression that returned an empty
    // array here would leave `"SessionEnd": []` in settings.json,
    // which is harmless but visible.
    expect(removeClaudeScriptEntries([loreSessionEndEntry()], "session-end.sh")).toBeUndefined()
    expect(removeClaudeScriptEntries(undefined, "session-end.sh")).toBeUndefined()
  })

  it("detects the Lore-owned shim entry against any path so reinstalls match across moved installs", () => {
    // Acceptance criterion: `lore install --client claude` removes existing
    // Lore-owned `session-end.sh` entries — even when the install moved
    // (the recorded path no longer matches the current install's hook
    // directory). `detectClaudeHook` matches by script-name suffix, so a
    // stale entry pointing at `/old/path/hooks/session-end.sh` still
    // classifies as present and is eligible for cleanup.
    const entries: ClaudeHookEntry[] = [
      {
        matcher: "",
        hooks: [{ type: "command", command: "/old/path/hooks/session-end.sh" }],
      },
    ]
    // Empty expected path: we only care that the script name matches,
    // not whether the path is "current".
    expect(detectClaudeHook(entries, "session-end.sh", "")).not.toBe("missing")
  })
})

describe("stripLoreOwnedSessionEndEntries (integration plan)", () => {
  // The pure planner that drives `runClaudeInstall`'s SessionEnd cleanup.
  // Test cases here mirror the real settings.json shapes the install path
  // sees on reinstall — the helper-level filter coverage is upstream in
  // `removeClaudeScriptEntries`'s unit tests; this suite proves the
  // integration assembled on top of it preserves user hooks end-to-end.

  function loreSessionEndEntry(): ClaudeHookEntry {
    return {
      matcher: "",
      hooks: [{ type: "command", command: "/lore/hooks/session-end.sh", timeout: 10000 }],
    }
  }

  function legacyAutosaveOnSessionEndEntry(): ClaudeHookEntry {
    return {
      matcher: "",
      hooks: [{ type: "command", command: "/lore/hooks/autosave.sh" }],
    }
  }

  function userOwnedSessionEndEntry(): ClaudeHookEntry {
    return {
      matcher: "*",
      hooks: [
        { type: "command", command: "/Users/operator/scripts/notify.sh", timeout: 30000 },
      ],
    }
  }

  it("returns no removals and the input untouched when no Lore-owned entries exist", () => {
    // Acceptance criterion: byte-identical reinstall on a vault that's
    // already SessionEnd-clean.
    const entries = [userOwnedSessionEndEntry()]
    const plan = stripLoreOwnedSessionEndEntries(entries)
    expect(plan.removedShim).toBe(false)
    expect(plan.removedLegacyAutosave).toBe(false)
    // The result still contains the user entry. The reference may be the
    // same array (helper short-circuits when nothing changed) or a copy —
    // assert on shape, not identity.
    expect(plan.result).toEqual([userOwnedSessionEndEntry()])
  })

  it("returns undefined when only a Lore-owned shim entry was registered", () => {
    // Acceptance criterion: caller deletes the SessionEnd key entirely
    // rather than leaving `"SessionEnd": []` in settings.json.
    const plan = stripLoreOwnedSessionEndEntries([loreSessionEndEntry()])
    expect(plan.removedShim).toBe(true)
    expect(plan.removedLegacyAutosave).toBe(false)
    expect(plan.result).toBeUndefined()
  })

  it("returns undefined when only a legacy autosave-on-SessionEnd entry was registered", () => {
    const plan = stripLoreOwnedSessionEndEntries([legacyAutosaveOnSessionEndEntry()])
    expect(plan.removedShim).toBe(false)
    expect(plan.removedLegacyAutosave).toBe(true)
    expect(plan.result).toBeUndefined()
  })

  it("strips both Lore-owned shapes when they coexist in the same SessionEnd array", () => {
    // Some operators upgrade across multiple Lore versions and accumulate
    // both registration shapes simultaneously; cleanup must remove both
    // and leave SessionEnd empty.
    const plan = stripLoreOwnedSessionEndEntries([
      loreSessionEndEntry(),
      legacyAutosaveOnSessionEndEntry(),
    ])
    expect(plan.removedShim).toBe(true)
    expect(plan.removedLegacyAutosave).toBe(true)
    expect(plan.result).toBeUndefined()
  })

  it("preserves an unrelated user hook entry on SessionEnd when stripping the Lore shim", () => {
    // Issue 0.6.0/26 acceptance criterion: "Unrelated user hooks in Claude
    // settings are preserved." This is the integration-level proof — the
    // post-cleanup array still has the user entry verbatim.
    const userEntry = userOwnedSessionEndEntry()
    const plan = stripLoreOwnedSessionEndEntries([loreSessionEndEntry(), userEntry])
    expect(plan.removedShim).toBe(true)
    expect(plan.result).toBeDefined()
    expect(plan.result).toHaveLength(1)
    // Matcher and command must round-trip intact, not be reset to defaults.
    expect(plan.result![0]).toEqual(userEntry)
  })

  it("preserves an unrelated user hook entry on SessionEnd when stripping the legacy autosave registration", () => {
    const userEntry = userOwnedSessionEndEntry()
    const plan = stripLoreOwnedSessionEndEntries([
      legacyAutosaveOnSessionEndEntry(),
      userEntry,
    ])
    expect(plan.removedLegacyAutosave).toBe(true)
    expect(plan.result).toEqual([userEntry])
  })

  it("preserves multiple unrelated user hook entries when both Lore-owned shapes are stripped", () => {
    // Multi-user-hook fixture: two different user-owned entries on
    // SessionEnd, plus both Lore-owned shapes in between. Post-cleanup
    // SessionEnd must contain exactly the two user entries in order.
    const userA: ClaudeHookEntry = {
      matcher: "git",
      hooks: [{ type: "command", command: "/scripts/audit.sh" }],
    }
    const userB: ClaudeHookEntry = {
      matcher: "*",
      hooks: [{ type: "command", command: "/scripts/notify.sh" }],
    }
    const plan = stripLoreOwnedSessionEndEntries([
      userA,
      loreSessionEndEntry(),
      userB,
      legacyAutosaveOnSessionEndEntry(),
    ])
    expect(plan.removedShim).toBe(true)
    expect(plan.removedLegacyAutosave).toBe(true)
    expect(plan.result).toEqual([userA, userB])
  })

  it("returns no removals when the SessionEnd key is absent (undefined input)", () => {
    // Vaults that never had SessionEnd registered at all (fresh install
    // direct from 0.6.0 onward) should produce a no-op plan.
    const plan = stripLoreOwnedSessionEndEntries(undefined)
    expect(plan.removedShim).toBe(false)
    expect(plan.removedLegacyAutosave).toBe(false)
    expect(plan.result).toBeUndefined()
  })
})

describe("stripShellEnvPrefix", () => {
  it("strips a single LORE_AGENT_NAME=<value> prefix", () => {
    expect(stripShellEnvPrefix('LORE_AGENT_NAME=Codex "/path/to/script.sh"')).toBe(
      '"/path/to/script.sh"',
    )
  })

  it("strips multiple sequential env prefixes", () => {
    expect(stripShellEnvPrefix('FOO=1 BAR=2 LORE_AGENT_NAME=Codex "/path/to/script.sh"')).toBe(
      '"/path/to/script.sh"',
    )
  })

  it("tolerates leading whitespace before the first assignment", () => {
    expect(stripShellEnvPrefix('  LORE_AGENT_NAME=Codex "/path/to/script.sh"')).toBe(
      '"/path/to/script.sh"',
    )
  })

  it("ignores lowercase keys — contract requires uppercase", () => {
    // `lore_agent_name=codex` does not match the `[A-Z_][A-Z0-9_]*` pattern,
    // so the prefix is treated as part of the command and not stripped.
    const input = 'lore_agent_name=codex "/path/to/script.sh"'
    expect(stripShellEnvPrefix(input)).toBe(input)
  })

  it("does not strip quoted values that contain whitespace", () => {
    // `\S+` stops at the first space inside the quotes, so the whole
    // assignment fails to match and the command is returned unchanged.
    const input = 'LORE_AGENT_NAME="My Agent" "/path/to/script.sh"'
    expect(stripShellEnvPrefix(input)).toBe(input)
  })

  it("returns the input unchanged when there is no env prefix", () => {
    const input = '"/path/to/script.sh"'
    expect(stripShellEnvPrefix(input)).toBe(input)
  })

  it("accepts digits and underscores after the first alphabetical character in keys", () => {
    expect(stripShellEnvPrefix('MY_VAR_1=value rest')).toBe('rest')
    expect(stripShellEnvPrefix('_VAR=value rest')).toBe('rest')
  })
})

// Shared console spies for the install-driving describe blocks below.
// Single-source-of-truth so a future refactor that reorders the blocks
// can't shadow one set with another (re-spying on `console.log` from a
// later block would orphan the earlier block's spy reference and the
// `mock.calls` assertions would silently see an empty array).
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

describe("runCursorInstall (integration)", () => {
  // Drive the real `runCursorInstall` against an on-disk tmpdir. The function
  // resolves to a literal path on disk; passing the target path explicitly
  // keeps the test from writing to the user's actual `~/.cursor/mcp.json`.

  const SCRATCH = mkdtempSync(join(tmpdir(), "lore-install-cursor-test-"))
  afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true })
  })

  afterEach(() => {
    consoleLogSpy.mockClear()
    consoleWarnSpy.mockClear()
    consoleErrorSpy.mockClear()
  })

  function makeContext(projectDir: string, pkgRoot: string): InstallContext {
    return {
      projectDir,
      pkgRoot,
      autosavePath: join(pkgRoot, "hooks", "autosave.sh"),
      wakeupPath: join(pkgRoot, "hooks", "wakeup.sh"),
      mcpJsPath: join(pkgRoot, "dist", "mcp.js"),
      // `skipPrompts: true` and a null `rl` together produce non-interactive
      // happy-path semantics in the helpers under test.
      skipPrompts: true,
      legacyPaths: false,
      yarnPnp: false,
      wakeUpConfig: null,
    }
  }

  it("writes a valid Lore entry to .cursor/mcp.json on a fresh project", async () => {
    const projectDir = mkdtempSync(join(SCRATCH, "fresh-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "pkg-"))
    const targetPath = join(projectDir, ".cursor", "mcp.json")

    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, false)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    const servers = written.mcpServers as Record<string, unknown>
    expect(servers).toBeDefined()
    // makeContext()'s legacyPaths is false → bin-dispatch shape.
    expect(servers.lore).toEqual(buildCursorMcpEntry())
  })

  it("is idempotent on re-run — existing identical entry yields no diff", async () => {
    const projectDir = mkdtempSync(join(SCRATCH, "idem-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "pkg-"))
    const targetPath = join(projectDir, ".cursor", "mcp.json")

    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, false)
    const firstContent = await readFile(targetPath, "utf-8")

    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, false)
    const secondContent = await readFile(targetPath, "utf-8")

    expect(secondContent).toBe(firstContent)
  })

  it("preserves unrelated MCP servers already present in mcp.json", async () => {
    const projectDir = mkdtempSync(join(SCRATCH, "preserve-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "pkg-"))
    const targetPath = join(projectDir, ".cursor", "mcp.json")

    // Seed a pre-existing server unrelated to lore.
    const seeded = {
      mcpServers: {
        other: { command: "node", args: ["other.js"] },
      },
    }
    const fs = await import("node:fs/promises")
    await fs.mkdir(join(projectDir, ".cursor"), { recursive: true })
    writeFileSync(targetPath, JSON.stringify(seeded, null, 2))

    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, false)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    const servers = written.mcpServers as Record<string, unknown>
    expect(servers.other).toEqual(seeded.mcpServers.other)
    expect(servers.lore).toBeDefined()
  })

  it("detects drift and overwrites a stale Lore entry", async () => {
    const projectDir = mkdtempSync(join(SCRATCH, "drift-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "pkg-"))
    const targetPath = join(projectDir, ".cursor", "mcp.json")

    // Seed a stale lore entry pointing at an old path.
    const stale = {
      mcpServers: {
        lore: {
          command: "node",
          args: ["/old/path/dist/mcp.js"],
          cwd: "/old/path",
          env: {},
        },
      },
    }
    const fs = await import("node:fs/promises")
    await fs.mkdir(join(projectDir, ".cursor"), { recursive: true })
    writeFileSync(targetPath, JSON.stringify(stale, null, 2))

    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, false)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    const servers = written.mcpServers as Record<string, unknown>
    const loreEntry = servers.lore as { command: string; args: string[] }
    // makeContext()'s legacyPaths is false → bin-dispatch overwrite of
    // the stale legacy entry. The args[0] flips from the absolute
    // mcp.js path to the literal "mcp" subcommand argument.
    expect(loreEntry.command).toBe("lore")
    expect(loreEntry.args).toEqual(["mcp"])
  })

  it("prints the hook-not-supported notice after a successful install", async () => {
    const projectDir = mkdtempSync(join(SCRATCH, "notice-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "pkg-"))
    const targetPath = join(projectDir, ".cursor", "mcp.json")

    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, false)

    const messages = consoleLogSpy.mock.calls.map((args) => args.join(" ")).join("\n")
    expect(messages).toMatch(/Cursor does not currently support Stop hooks/)
  })

  it("does NOT print the hook-not-supported notice on the idempotent already-installed path", async () => {
    // The notice belongs to the post-write success branch. An idempotent
    // re-run already emitted it on the first install; printing it again on
    // every no-op reinstall would be log spam.
    const projectDir = mkdtempSync(join(SCRATCH, "notice-idem-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "pkg-"))
    const targetPath = join(projectDir, ".cursor", "mcp.json")

    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, false)
    consoleLogSpy.mockClear()
    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, false)

    const messages = consoleLogSpy.mock.calls.map((args) => args.join(" ")).join("\n")
    expect(messages).toMatch(/Everything is already installed/)
    expect(messages).not.toMatch(/Cursor does not currently support Stop hooks/)
  })

  it("writes to the explicit target path under --cursor-global semantics", async () => {
    // The `global: true` branch resolves to `~/.cursor/mcp.json` in production;
    // for tests we pass an explicit fake-home target so we don't mutate the
    // developer's actual home.
    const projectDir = mkdtempSync(join(SCRATCH, "global-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "pkg-"))
    const fakeHome = mkdtempSync(join(SCRATCH, "home-"))
    const targetPath = join(fakeHome, ".cursor", "mcp.json")

    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, true)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    expect((written.mcpServers as Record<string, unknown>).lore).toBeDefined()
  })

  it("writes the legacy absolute-path shape under legacyPaths=true", async () => {
    // 0.11.0 acceptance criterion: `lore install --legacy-paths`
    // preserves the 0.10.x absolute-path output for one release. The
    // Cursor branch follows the same flag.
    const projectDir = mkdtempSync(join(SCRATCH, "legacy-cursor-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "legacy-cursor-pkg-"))
    const targetPath = join(projectDir, ".cursor", "mcp.json")

    const ctx: InstallContext = {
      ...makeContext(projectDir, pkgRoot),
      legacyPaths: true,
      yarnPnp: false,
    }
    await runCursorInstall(ctx, null, targetPath, false)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    const servers = written.mcpServers as Record<string, unknown>
    const loreEntry = servers.lore as { command: string; args: string[]; cwd: string }
    expect(loreEntry.command).toBe("node")
    expect(loreEntry.args[0]).toBe(toPortablePath(join(pkgRoot, "dist", "mcp.js")))
    expect(loreEntry.cwd).toBe(toPortablePath(pkgRoot))
  })

  it("rewrites a legacy-current entry to bin-dispatch on the default path", async () => {
    // 0.11.0 acceptance criterion: `lore install` against a
    // `legacy-current` config rewrites it to bin-dispatch and reports
    // the upgrade in the install summary. The acceptance line target
    // is the `MCP server: upgraded (legacy → bin-dispatch)` summary.
    const projectDir = mkdtempSync(join(SCRATCH, "upgrade-cursor-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "upgrade-cursor-pkg-"))
    const targetPath = join(projectDir, ".cursor", "mcp.json")

    // Seed a legacy-current entry: matches what
    // `buildLegacyCursorMcpEntry` would produce for this pkgRoot.
    const seededEntry = buildLegacyCursorMcpEntry(
      toPortablePath(join(pkgRoot, "dist", "mcp.js")),
      toPortablePath(pkgRoot),
    )
    const fs = await import("node:fs/promises")
    await fs.mkdir(join(projectDir, ".cursor"), { recursive: true })
    writeFileSync(targetPath, JSON.stringify({ mcpServers: { lore: seededEntry } }, null, 2))

    consoleLogSpy.mockClear()
    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, false)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    expect((written.mcpServers as Record<string, unknown>).lore).toEqual(buildCursorMcpEntry())

    const messages = consoleLogSpy.mock.calls.map((args) => args.join(" ")).join("\n")
    expect(messages).toMatch(/MCP server:\s+legacy form \(will upgrade\)/)
    expect(messages).toMatch(/MCP server:\s+upgraded \(legacy → bin-dispatch\)/)
  })

  it("succeeds without hook scripts on disk — Cursor doesn't depend on autosave/wakeup", async () => {
    // The reviewer's blocking finding: `lore install --client cursor`
    // must NOT abort just because `hooks/autosave.sh` or `hooks/wakeup.sh`
    // are missing or non-writable. Cursor's MCP runtime doesn't use them.
    // We construct a context whose pkgRoot is a fresh tmpdir with NO hook
    // files whatsoever — `runCursorInstall` should still write the MCP
    // entry without ever touching `context.autosavePath` /
    // `context.wakeupPath`.
    const projectDir = mkdtempSync(join(SCRATCH, "nohooks-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "nohooks-pkg-"))
    const targetPath = join(projectDir, ".cursor", "mcp.json")

    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, false)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    expect((written.mcpServers as Record<string, unknown>).lore).toBeDefined()
  })
})

describe("ensureHookPrerequisites", () => {
  // Hook prerequisites are now per-runner so a Cursor install isn't gated
  // on hook scripts that Cursor doesn't use. This block pins the new
  // helper's contract: throws with a clear message when hook scripts are
  // missing, no-throw + chmod-applies when they exist.

  const SCRATCH = mkdtempSync(join(tmpdir(), "lore-install-hookprereq-test-"))
  afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true })
  })

  // 0.11.0 turned `ensureHookPrerequisites` into a no-op on the
  // bin-dispatch default path — the bin-dispatch shape has no `.sh`
  // dependency, so the existence checks only run under
  // `--legacy-paths`. The prerequisite-verification tests therefore
  // build a `legacyPaths: true` fixture explicitly. A separate test
  // pins the no-op behavior on the default path.
  function makeLegacyContext(pkgRoot: string): InstallContext {
    return {
      projectDir: pkgRoot,
      pkgRoot,
      autosavePath: join(pkgRoot, "hooks", "autosave.sh"),
      wakeupPath: join(pkgRoot, "hooks", "wakeup.sh"),
      mcpJsPath: join(pkgRoot, "dist", "mcp.js"),
      skipPrompts: true,
      legacyPaths: true,
      yarnPnp: false,
      wakeUpConfig: null,
    }
  }

  it("throws a clear error naming the missing hook scripts under --legacy-paths", async () => {
    const pkgRoot = mkdtempSync(join(SCRATCH, "missing-"))

    await expect(ensureHookPrerequisites(makeLegacyContext(pkgRoot))).rejects.toThrow(
      /Required hook scripts not found.*autosave\.sh.*wakeup\.sh/,
    )
  })

  it("throws when only one of the two hook scripts is missing under --legacy-paths", async () => {
    // Half-baked install state: autosave.sh present, wakeup.sh missing.
    // The error should name only the missing one so an operator can act.
    const pkgRoot = mkdtempSync(join(SCRATCH, "partial-"))
    const fs = await import("node:fs/promises")
    await fs.mkdir(join(pkgRoot, "hooks"), { recursive: true })
    writeFileSync(join(pkgRoot, "hooks", "autosave.sh"), "#!/bin/sh\n")

    await expect(ensureHookPrerequisites(makeLegacyContext(pkgRoot))).rejects.toThrow(
      /Required hook scripts not found.*wakeup\.sh/,
    )
  })

  it("returns without throwing and chmods the scripts when both exist under --legacy-paths", async () => {
    const pkgRoot = mkdtempSync(join(SCRATCH, "ok-"))
    const fs = await import("node:fs/promises")
    await fs.mkdir(join(pkgRoot, "hooks"), { recursive: true })
    writeFileSync(join(pkgRoot, "hooks", "autosave.sh"), "#!/bin/sh\n", { mode: 0o644 })
    writeFileSync(join(pkgRoot, "hooks", "wakeup.sh"), "#!/bin/sh\n", { mode: 0o644 })

    await expect(ensureHookPrerequisites(makeLegacyContext(pkgRoot))).resolves.toBeUndefined()

    // Chmod side-effect: scripts now executable. The exact mode bits depend
    // on the process umask, so we only assert the user-execute bit (0o100).
    const { stat } = await import("node:fs/promises")
    const autosaveStat = await stat(join(pkgRoot, "hooks", "autosave.sh"))
    const wakeupStat = await stat(join(pkgRoot, "hooks", "wakeup.sh"))
    expect(autosaveStat.mode & 0o100).toBe(0o100)
    expect(wakeupStat.mode & 0o100).toBe(0o100)
  })

  it("is a no-op on the bin-dispatch default path even when scripts are missing", async () => {
    // The bin-dispatch path doesn't depend on hooks/*.sh — the `lore`
    // bin owns the hook entry points directly. The prereq verifier
    // must skip its existence checks so a fresh devDep consumer
    // (whose tarball ships dist/ but no hooks/) doesn't fail
    // `lore install` on a phantom missing-script error.
    const pkgRoot = mkdtempSync(join(SCRATCH, "bindispatch-noop-"))
    // No mkdir(hooks/) — the directory doesn't exist at all.
    const ctx: InstallContext = {
      ...makeLegacyContext(pkgRoot),
      legacyPaths: false,
      yarnPnp: false,
    }
    await expect(ensureHookPrerequisites(ctx)).resolves.toBeUndefined()
  })
})

describe("dispatchInstall (--client all orchestration)", () => {
  // The orchestration test injects mock runners and exercises the pure-ish
  // dispatcher directly, sidestepping `prepareInstallContext` (which depends
  // on `dist/mcp.js` and `hooks/*.sh` resolved from `import.meta.url` —
  // those don't resolve to the right place when the test runs from
  // `src/cli/commands/install.ts`). The dispatcher is what carries the
  // captured-error contract; testing it directly is enough.
  //
  // Console spies are file-level (above) so this block and the integration
  // block share the same mock instance for `console.log` / `console.error`.

  afterEach(() => {
    consoleLogSpy.mockClear()
    consoleErrorSpy.mockClear()
  })

  function makeContext(): InstallContext {
    return {
      projectDir: "/tmp/orchestration-fake-project",
      pkgRoot: "/tmp/orchestration-fake-pkg",
      autosavePath: "/tmp/orchestration-fake-pkg/hooks/autosave.sh",
      wakeupPath: "/tmp/orchestration-fake-pkg/hooks/wakeup.sh",
      mcpJsPath: "/tmp/orchestration-fake-pkg/dist/mcp.js",
      skipPrompts: true,
      legacyPaths: false,
      yarnPnp: false,
      wakeUpConfig: null,
    }
  }

  function trackingRunners(
    failures: { claude?: boolean; codex?: boolean; cursor?: boolean } = {},
  ): { runners: InstallRunners; called: { claude: number; codex: number; cursor: number } } {
    const called = { claude: 0, codex: 0, cursor: 0 }
    const runners: InstallRunners = {
      claude: async () => {
        called.claude++
        if (failures.claude) throw new Error("claude install failed (mock)")
      },
      codex: async () => {
        called.codex++
        if (failures.codex) throw new Error("codex install failed (mock)")
      },
      cursor: async () => {
        called.cursor++
        if (failures.cursor) throw new Error("cursor install failed (mock)")
      },
    }
    return { runners, called }
  }

  it("invokes all three runners under --client all on the happy path", async () => {
    const { runners, called } = trackingRunners()
    const errors = await dispatchInstall(makeContext(), null, { client: "all" }, runners)
    expect(called).toEqual({ claude: 1, codex: 1, cursor: 1 })
    expect(errors).toHaveLength(0)
  })

  it("continues to subsequent runners after one fails and aggregates errors", async () => {
    const { runners, called } = trackingRunners({ codex: true })
    const errors = await dispatchInstall(makeContext(), null, { client: "all" }, runners)

    // All three runners ran even though Codex threw.
    expect(called).toEqual({ claude: 1, codex: 1, cursor: 1 })
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({ client: "codex" })
    expect((errors[0]!.error as Error).message).toMatch(/codex install failed \(mock\)/)

    // Per-failure stderr line surfaces the failing client by name.
    const stderr = consoleErrorSpy.mock.calls.map((args) => args.join(" ")).join("\n")
    expect(stderr).toMatch(/codex: install failed \(codex install failed \(mock\)\)/)
  })

  it("aggregates multiple failures across distinct clients", async () => {
    const { runners, called } = trackingRunners({ claude: true, cursor: true })
    const errors = await dispatchInstall(makeContext(), null, { client: "all" }, runners)

    expect(called).toEqual({ claude: 1, codex: 1, cursor: 1 })
    expect(errors.map((e) => e.client).sort()).toEqual(["claude", "cursor"])
  })

  it("propagates a single-client throw without aggregation", async () => {
    // Single-client invocations should fail fast — no captured-errors path,
    // just the original throw bubbling out.
    const { runners, called } = trackingRunners({ claude: true })
    await expect(
      dispatchInstall(makeContext(), null, { client: "claude" }, runners),
    ).rejects.toThrow(/claude install failed \(mock\)/)
    expect(called).toEqual({ claude: 1, codex: 0, cursor: 0 })
  })

  it("only invokes the matching runner under --client cursor", async () => {
    const { runners, called } = trackingRunners()
    const errors = await dispatchInstall(
      makeContext(),
      null,
      { client: "cursor", cursorGlobal: false },
      runners,
    )
    expect(called).toEqual({ claude: 0, codex: 0, cursor: 1 })
    expect(errors).toHaveLength(0)
  })

  it("forwards --cursor-global through to the cursor runner", async () => {
    let receivedGlobal: boolean | null = null
    let receivedPath: string | null = null
    const runners: InstallRunners = {
      claude: async () => {},
      codex: async () => {},
      cursor: async (_ctx, _rl, cursorMcpPath, global) => {
        receivedPath = cursorMcpPath
        receivedGlobal = global
      },
    }
    await dispatchInstall(makeContext(), null, { client: "cursor", cursorGlobal: true }, runners)
    expect(receivedGlobal).toBe(true)
    expect(receivedPath).toBe(`${homedir()}/.cursor/mcp.json`)
  })
})

describe("parsePrintConfigFormat (issue 0.9.0/12)", () => {
  it("accepts the two supported formats", () => {
    expect(parsePrintConfigFormat("json")).toBe("json")
    expect(parsePrintConfigFormat("toml")).toBe("toml")
  })

  it("rejects unknown formats", () => {
    expect(parsePrintConfigFormat("yaml")).toBeNull()
    expect(parsePrintConfigFormat("")).toBeNull()
  })

  it("is case-sensitive — uppercase variants do not match", () => {
    // Operators paste the snippet into config files where lowercase is the
    // convention; rejecting `JSON` keeps the surface tight.
    expect(parsePrintConfigFormat("JSON")).toBeNull()
    expect(parsePrintConfigFormat("Toml")).toBeNull()
  })
})

describe("buildPrintConfigOutput (issue 0.9.0/12)", () => {
  // The print-config snippet is the escape hatch for hosts not supported
  // directly via --client (Gemini-CLI, OpenCode, Windsurf, etc.). The
  // contract is byte-identity with what `--client claude` writes to
  // `.mcp.json` and what `--client codex` writes to `.codex/config.toml`,
  // so an operator pasting the snippet sees the same shape as a
  // first-class install.

  it("emits the bin-dispatch JSON shape by default for format='json'", () => {
    const output = buildPrintConfigOutput("json", "/lore/dist/mcp.js", "/lore")
    const parsed = JSON.parse(output) as {
      mcpServers: { lore: { command: string; args: string[]; env: Record<string, string> } }
    }
    expect(parsed.mcpServers.lore.command).toBe("lore")
    expect(parsed.mcpServers.lore.args).toEqual(["mcp"])
    expect(parsed.mcpServers.lore.env["LORE_NOTION_TOKEN"]).toBe("${LORE_NOTION_TOKEN}")
    expect(output.endsWith("\n")).toBe(true)
  })

  it("emits the bin-dispatch TOML shape by default for format='toml'", () => {
    const output = buildPrintConfigOutput("toml", "/lore/dist/mcp.js", "/lore")
    expect(output.startsWith("[mcp_servers.lore]\n")).toBe(true)
    expect(output).toContain('command = "lore"')
    expect(output).toContain('args = ["mcp"]')
    expect(output).toContain("env_vars = ")
    expect(output).toContain('"LORE_NOTION_TOKEN"')
    // Trailing newline lets `lore install --print-config toml >> file.toml`
    // append a clean section without joining the next line.
    expect(output.endsWith("\n")).toBe(true)
  })

  it("contains no absolute paths and no ${HOME} placeholders in bin-dispatch JSON", () => {
    // 0.11.0 acceptance criterion: the default print-config output
    // resolves portably across machines because no path leaks into the
    // emitted snippet. The bin name `lore` is resolved by the host
    // assistant against the consumer repo's `node_modules/.bin/lore`,
    // which yarn/npm manage as a symlink.
    const output = buildPrintConfigOutput("json", "/lore/dist/mcp.js", "/lore")
    expect(output).not.toContain("/lore/dist/mcp.js")
    expect(output).not.toContain("${HOME}")
  })

  it("emits the legacy absolute-path JSON shape when legacyPaths=true", () => {
    const home = homedir()
    const output = buildPrintConfigOutput(
      "json",
      `${home}/.lore/dist/mcp.js`,
      `${home}/.lore`,
      true,
    )
    const parsed = JSON.parse(output) as {
      mcpServers: { lore: { command: string; args: string[]; cwd: string } }
    }
    expect(parsed.mcpServers.lore.command).toBe("node")
    expect(parsed.mcpServers.lore.args[0]).toBe("${HOME}/.lore/dist/mcp.js")
    expect(parsed.mcpServers.lore.cwd).toBe("${HOME}/.lore")
  })

  it("emits the legacy bash-wrapped TOML shape when legacyPaths=true", () => {
    const home = homedir()
    const output = buildPrintConfigOutput(
      "toml",
      `${home}/.lore/dist/mcp.js`,
      `${home}/.lore`,
      true,
    )
    expect(output).toContain('command = "bash"')
    expect(output).toContain('"node \\"${HOME}/.lore/dist/mcp.js\\""')
  })

  it("byte-matches buildClaudeMcpEntry() under the bin-dispatch default", () => {
    const expected =
      JSON.stringify({ mcpServers: { lore: buildClaudeMcpEntry() } }, null, 2) + "\n"
    expect(buildPrintConfigOutput("json", "/lore/dist/mcp.js", "/lore")).toBe(expected)
  })

  it("byte-matches buildLegacyClaudeMcpEntry under --legacy-paths", () => {
    const expected =
      JSON.stringify(
        {
          mcpServers: {
            lore: buildLegacyClaudeMcpEntry("/lore/dist/mcp.js", "/lore"),
          },
        },
        null,
        2,
      ) + "\n"
    expect(buildPrintConfigOutput("json", "/lore/dist/mcp.js", "/lore", true)).toBe(expected)
  })

  it("byte-matches buildCodexMcpSection() under the bin-dispatch default", () => {
    const expected = buildCodexMcpSection() + "\n"
    expect(buildPrintConfigOutput("toml", "/lore/dist/mcp.js", "/lore")).toBe(expected)
  })

  it("byte-matches buildLegacyCodexMcpSection under --legacy-paths", () => {
    const expected = buildLegacyCodexMcpSection("/lore/dist/mcp.js") + "\n"
    expect(buildPrintConfigOutput("toml", "/lore/dist/mcp.js", "/lore", true)).toBe(expected)
  })

  it("ignores --client / --project context — output depends only on resolved paths and legacyPaths", () => {
    // Neither --client nor --project flows into buildPrintConfigOutput. Two
    // calls with the same paths always produce the same snippet, regardless
    // of what the operator passed alongside --print-config.
    const first = buildPrintConfigOutput("json", "/lore/dist/mcp.js", "/lore")
    const second = buildPrintConfigOutput("json", "/lore/dist/mcp.js", "/lore")
    expect(second).toBe(first)
  })
})

describe("install command runtime — --print-config short-circuits other flags", () => {
  // End-to-end test of the action handler's branch order: --print-config
  // takes precedence over --client and --project. Acceptance criterion 6
  // pins this no-op behavior so existing operator invocations that pair
  // --client with --print-config keep working as later releases extend the
  // --client enum (e.g. when 0.9.0/11 adds `cursor`). The behavior is
  // structurally guaranteed by the `if (opts.printConfig != null) { ...
  // return; }` short-circuit in install.ts; this test pins it against
  // accidental reordering.

  it("emits only the JSON snippet when --client is set alongside --print-config", async () => {
    const writes: string[] = []
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
        return true
      }) as never)

    try {
      // --client claude is a valid value pre-#158 and post-#158; the test
      // works regardless of what later releases add to parseInstallClient's
      // enum. The point is that the install path never runs, so none of its
      // headers ("Lore — Claude Code Integration", "Checking
      // prerequisites...") land on stdout.
      // `from: "user"` means argv contains only the option args — installCommand
      // is the leaf command, not a `node lore install …` invocation.
      await installCommand.parseAsync(
        ["--client", "claude", "--print-config", "json"],
        { from: "user" },
      )
    } finally {
      stdoutSpy.mockRestore()
    }

    const output = writes.join("")
    expect(output.startsWith('{\n  "mcpServers":')).toBe(true)
    const parsed = JSON.parse(output) as {
      mcpServers: { lore: { command: string } }
    }
    // 0.11.0+ default is bin-dispatch — `command: "lore"`. The
    // legacy `command: "node"` shape only emits under
    // `--legacy-paths`, which this test doesn't set.
    expect(parsed.mcpServers.lore.command).toBe("lore")
    // The install path's pre-flight banner would precede any JSON output if
    // it had run — its absence is the proof that --client was a no-op.
    expect(output).not.toContain("Checking prerequisites")
    expect(output).not.toContain("Claude Code Integration")
  })

  it("emits only the JSON snippet when --project is set alongside --print-config", async () => {
    // --project would have controlled the on-disk write directory for
    // --client claude / --client codex. With --print-config no file is
    // written, so --project is a no-op — verified here by passing a
    // fictitious path and confirming the printed snippet is unchanged.
    const writes: string[] = []
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(((chunk: string | Uint8Array) => {
        writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString())
        return true
      }) as never)

    try {
      await installCommand.parseAsync(
        [
          "--project",
          "/tmp/nonexistent-print-config-test",
          "--print-config",
          "json",
        ],
        { from: "user" },
      )
    } finally {
      stdoutSpy.mockRestore()
    }

    const output = writes.join("")
    const parsed = JSON.parse(output) as {
      mcpServers: { lore: { cwd: string } }
    }
    // The entry's `cwd` is sourced from pkgRoot resolution, NOT from
    // --project. Acceptance criterion 7 makes this explicit.
    expect(parsed.mcpServers.lore.cwd).not.toBe("/tmp/nonexistent-print-config-test")
  })
})
