import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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
  buildMcpEnv,
  buildPrintConfigOutput,
  containsTomlArrayOfTables,
  detectYarnPnp,
  ntnLoginRecovery,
  prepareInstallContext,
  shellQuotePortablePath,
  shellQuoteSingle,
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
import { RUNTIME_FORWARDED_KEYS } from "../../auth/forwarded-env.js"

/**
 * Deterministic test fixtures so unit tests don't depend on the
 * developer's actual env at test time. Pass these to entry-builder
 * call sites via the explicit `configRoot` and `envSource`
 * parameters; production code reads `process.cwd()` and `process.env`
 * by default.
 */
const TEST_CONFIG_ROOT = "/test/config-root"

/** Both legacy env vars present — exercises the `${VAR}` forwarding shape. */
const ENV_BOTH_LEGACY = {
  LORE_NOTION_TOKEN: "test-token",
  LORE_NOTION_BASE_URL: "https://api.notion.so",
} as const

/** No auth env vars — exercises the "ntn-resolved at runtime" shape. */
const ENV_NONE: NodeJS.ProcessEnv = {}

/** Always-on static entries, regardless of operator env. */
const STATIC_ENV_FOR_TEST_CONFIG_ROOT = {
  LORE_CONFIG_ROOT: TEST_CONFIG_ROOT,
  LORE_SUPPRESS_DEPRECATIONS: "1",
} as const

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

  it("emits the bin-dispatch Claude hook command anchored to $CLAUDE_PROJECT_DIR for each event name", () => {
    // Claude Code's hook runner fires hooks with cwd set to whatever
    // its process happened to have at fire time — frequently NOT the
    // project root. Lore's hook helpers walk upward from
    // `process.cwd()` to find `.lore.yaml`, so the `cd` prefix
    // anchors resolution to Claude's `$CLAUDE_PROJECT_DIR` env var
    // (substituted by Claude's hook shell at fire time, not by
    // Lore's writer).
    expect(buildClaudeHookCommand("wakeup")).toBe(
      `cd "$CLAUDE_PROJECT_DIR" && lore hooks wakeup`,
    )
    expect(buildClaudeHookCommand("autosave")).toBe(
      `cd "$CLAUDE_PROJECT_DIR" && lore hooks autosave`,
    )
    expect(buildClaudeHookCommand("session-end")).toBe(
      `cd "$CLAUDE_PROJECT_DIR" && lore hooks session-end`,
    )
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

  it("buildClaudeMcpEntry emits the yarn-PnP shape with workspace-root resolution and no LORE_CONFIG_ROOT", () => {
    // Yarn Berry / Yarn 4 PnP consumers don't populate
    // node_modules/.bin/lore, so `command: "lore"` would not resolve
    // at host-launch time. Two interlocking properties this shape
    // pins:
    //
    // 1. `args: ["run", "-T", "lore", "mcp"]` resolves the
    //    workspace-root binary via Yarn's `-T`/top-level flag,
    //    working from any nested workspace package the host happens
    //    to launch from.
    // 2. `LORE_CONFIG_ROOT` is OMITTED from the env block. Committed
    //    `.mcp.json` is shared across developers in monorepos; an
    //    absolute machine-specific path baked into shared config
    //    leaks one developer's checkout into the others'. The
    //    `yarn run -T` launch always lands at workspace root, so the
    //    spawned MCP server's `findConfigFile(cwd)` walk resolves
    //    `.lore.yaml` without help.
    expect(buildClaudeMcpEntry("yarn", TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)).toEqual({
      command: "yarn",
      args: ["run", "-T", "lore", "mcp"],
      env: {
        LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}",
        LORE_NOTION_BASE_URL: "${LORE_NOTION_BASE_URL}",
        // No LORE_CONFIG_ROOT under PnP — runtime resolves via
        // workspace-root cwd walk.
        LORE_SUPPRESS_DEPRECATIONS: "1",
      },
    })
  })

  it("buildClaudeHookCommand wraps with `yarn run -T` under shape='yarn' (workspace-root resolution)", () => {
    // `yarn run -T` resolves the workspace-root binary even when the
    // hook fires from a nested workspace package's cwd — the cd
    // wrapper anchors to project root and `-T` (top-level) handles
    // the cross-package binary lookup.
    expect(buildClaudeHookCommand("autosave", "yarn")).toBe(
      `cd "$CLAUDE_PROJECT_DIR" && yarn run -T lore hooks autosave`,
    )
    expect(buildClaudeHookCommand("wakeup", "yarn")).toBe(
      `cd "$CLAUDE_PROJECT_DIR" && yarn run -T lore hooks wakeup`,
    )
  })

  it("buildCodexHookCommand wraps with `yarn run -T` under shape='yarn' (preserves env prefix, no cd anchor)", () => {
    // The LORE_AGENT_NAME=Codex prefix MUST stay intact so the
    // detector and `stripShellEnvPrefix` continue to recognize the
    // hook entry as Lore-owned across reinstalls. Codex's hook
    // runner already exposes the project root via Codex's own
    // context (no `cd` anchor needed; hooks fire with project cwd
    // by convention).
    expect(buildCodexHookCommand("wakeup", "yarn")).toBe(
      "LORE_AGENT_NAME=Codex yarn run -T lore hooks wakeup",
    )
    expect(buildCodexHookCommand("autosave", "yarn")).toBe(
      "LORE_AGENT_NAME=Codex yarn run -T lore hooks autosave",
    )
  })

  it("buildCodexMcpSection emits the yarn-PnP TOML shape with `run -T` and no LORE_CONFIG_ROOT", () => {
    // Codex's TOML can't carry literal env values in `env_vars`, so
    // any static pair lands as a shell prefix on the launch command.
    // Under PnP the LORE_CONFIG_ROOT entry is omitted (committed-
    // config portability) and the launch command uses `yarn run -T`
    // for workspace-root binary resolution from subdirectory cwds.
    const section = buildCodexMcpSection("yarn", TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)
    expect(section).toContain(
      `args = ["-lc", "LORE_SUPPRESS_DEPRECATIONS='1' yarn run -T lore mcp"]`,
    )
    expect(section).not.toContain("LORE_CONFIG_ROOT=")
    expect(section).toContain('command = "bash"')
  })

  it("buildClaudeMcpEntry emits portable bin-dispatch shape with no paths", () => {
    // 0.11.0 acceptance criterion: the default `.mcp.json` entry
    // contains no absolute paths and no `${HOME}` placeholders, so the
    // committed file resolves identically on every engineer's machine.
    // (The 0.10.0 LORE_CONFIG_ROOT addition does carry an absolute
    // path, but it's the operator's vault directory — not a path
    // baked into the install module.)
    const entry = buildClaudeMcpEntry("bare", TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)
    expect(entry).toEqual({
      command: "lore",
      args: ["mcp"],
      env: {
        LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}",
        LORE_NOTION_BASE_URL: "${LORE_NOTION_BASE_URL}",
        ...STATIC_ENV_FOR_TEST_CONFIG_ROOT,
      },
    })
    // `cwd` is intentionally absent on the bin-dispatch path — pinning a
    // specific cwd would defeat the portability gain.
    expect("cwd" in entry).toBe(false)
  })

  it("buildCodexMcpSection emits the bin-dispatch TOML shape", () => {
    const section = buildCodexMcpSection("bare", TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)
    expect(section).toContain("[mcp_servers.lore]")
    // Codex needs the `bash -lc` wrapper to carry the static env
    // prefix; the bin name `lore` is the tail of the launch command.
    expect(section).toContain('command = "bash"')
    expect(section).toContain(
      `args = ["-lc", "LORE_CONFIG_ROOT='${TEST_CONFIG_ROOT}' LORE_SUPPRESS_DEPRECATIONS='1' lore mcp"]`,
    )
    // env_vars carries only the runtime-resolved forwards
    // (NOTION_API_TOKEN / LORE_NOTION_TOKEN / LORE_NOTION_BASE_URL),
    // never the static pair.
    expect(section).toContain('env_vars = ["LORE_NOTION_TOKEN", "LORE_NOTION_BASE_URL"]')
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
    expect(buildCursorMcpEntry("bare", TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)).toEqual(
      buildClaudeMcpEntry("bare", TEST_CONFIG_ROOT, ENV_BOTH_LEGACY),
    )
    expect(buildCursorMcpEntry("bare", TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)).toEqual({
      command: "lore",
      args: ["mcp"],
      env: {
        LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}",
        LORE_NOTION_BASE_URL: "${LORE_NOTION_BASE_URL}",
        ...STATIC_ENV_FOR_TEST_CONFIG_ROOT,
      },
    })
  })

  it("builds a legacy absolute-path Cursor MCP entry under buildLegacyCursorMcpEntry", () => {
    const entry = buildLegacyCursorMcpEntry(
      "${HOME}/.lore/dist/mcp.js",
      "${HOME}/.lore",
      TEST_CONFIG_ROOT,
      ENV_BOTH_LEGACY,
    )
    expect(entry).toEqual({
      command: "node",
      args: ["${HOME}/.lore/dist/mcp.js"],
      cwd: "${HOME}/.lore",
      env: {
        LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}",
        LORE_NOTION_BASE_URL: "${LORE_NOTION_BASE_URL}",
        ...STATIC_ENV_FOR_TEST_CONFIG_ROOT,
      },
    })
  })

  it("re-running buildLegacyCursorMcpEntry produces deepEqual output for idempotency checks", () => {
    // The install path determines drift via `deepEqual(existing, expected)`,
    // so two builds with the same inputs must compare equal.
    const a = buildLegacyCursorMcpEntry(
      "${HOME}/.lore/dist/mcp.js",
      "${HOME}/.lore",
      TEST_CONFIG_ROOT,
      ENV_BOTH_LEGACY,
    )
    const b = buildLegacyCursorMcpEntry(
      "${HOME}/.lore/dist/mcp.js",
      "${HOME}/.lore",
      TEST_CONFIG_ROOT,
      ENV_BOTH_LEGACY,
    )
    expect(deepEqual(a, b)).toBe(true)
  })

  it("detects drift when the legacy MCP path moves", () => {
    const previous = buildLegacyCursorMcpEntry(
      "${HOME}/.lore/dist/mcp.js",
      "${HOME}/.lore",
      TEST_CONFIG_ROOT,
      ENV_BOTH_LEGACY,
    )
    const current = buildLegacyCursorMcpEntry(
      "${HOME}/.lore/dist/mcp.js",
      "${HOME}/.lore-2",
      TEST_CONFIG_ROOT,
      ENV_BOTH_LEGACY,
    )
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
      // 0.10.0: configRoot is the resolved `.lore.yaml` directory the
      // install path forwards as `LORE_CONFIG_ROOT`. Tests with no
      // `.lore.yaml` on disk fall back to projectDir, matching what
      // prepareInstallContext computes.
      configRoot: projectDir,
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
    expect(servers.lore).toEqual(buildCursorMcpEntry("bare", projectDir, process.env))
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

  it("rewrites a PnP entry that still carries LORE_CONFIG_ROOT to the portable shape", async () => {
    // Followup #11 (makenotion/mail#25947): an operator who installed
    // before #08's PnP omission rule landed has a `.cursor/mcp.json`
    // whose `lore` entry uses the canonical PnP launch shape (`yarn
    // run -T lore mcp`) but still carries `LORE_CONFIG_ROOT` set to
    // their personal checkout path. Reinstalling under PnP detection
    // must rewrite the entry so committed config stops leaking the
    // engineer-specific path. The deep-equal MCP-status comparison
    // classifies the seeded entry as `stale` (not `current`) because
    // `binMcpEntry` for `shape: "yarn"` builds `env` without
    // `LORE_CONFIG_ROOT`, so the runner's write path replaces it.
    const projectDir = mkdtempSync(join(SCRATCH, "pnp-rewrite-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "pnp-rewrite-pkg-"))
    const targetPath = join(projectDir, ".cursor", "mcp.json")

    const stale = {
      mcpServers: {
        lore: {
          command: "yarn",
          args: ["run", "-T", "lore", "mcp"],
          env: {
            LORE_CONFIG_ROOT: "/Users/old-engineer/work/repo",
            LORE_SUPPRESS_DEPRECATIONS: "1",
          },
        },
      },
    }
    const fs = await import("node:fs/promises")
    await fs.mkdir(join(projectDir, ".cursor"), { recursive: true })
    writeFileSync(targetPath, JSON.stringify(stale, null, 2))

    const ctx: InstallContext = { ...makeContext(projectDir, pkgRoot), yarnPnp: true }
    await runCursorInstall(ctx, null, targetPath, false)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    const servers = written.mcpServers as Record<string, unknown>
    const loreEntry = servers.lore as {
      command: string
      args: string[]
      env: Record<string, string>
    }
    expect(loreEntry.command).toBe("yarn")
    expect(loreEntry.args).toEqual(["run", "-T", "lore", "mcp"])
    expect(loreEntry.env).not.toHaveProperty("LORE_CONFIG_ROOT")
    // The other static (`LORE_SUPPRESS_DEPRECATIONS=1`) survives — its
    // value is a literal "1", not a per-engineer path.
    expect(loreEntry.env.LORE_SUPPRESS_DEPRECATIONS).toBe("1")
  })

  it("anchors the PnP entry with cwd + LORE_CONFIG_ROOT under --cursor-global", async () => {
    // PR #182 review feedback: under `--cursor-global`, the entry
    // lands at `~/.cursor/mcp.json` (machine-local), not in
    // committed project config. Cursor's launch cwd at fire time is
    // not guaranteed to be inside the PnP project, so `yarn run -T
    // lore mcp` would fire from Cursor's process cwd and fail to
    // walk upward to `.pnp.cjs`. The runner has to emit `cwd`
    // anchored to the project's configRoot AND retain
    // `LORE_CONFIG_ROOT` so the spawned MCP child resolves
    // `.lore.yaml` regardless of how Cursor handles cwd
    // inheritance.
    const projectDir = mkdtempSync(join(SCRATCH, "pnp-global-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "pnp-global-pkg-"))
    const fakeHome = mkdtempSync(join(SCRATCH, "pnp-global-home-"))
    const targetPath = join(fakeHome, ".cursor", "mcp.json")

    const ctx: InstallContext = { ...makeContext(projectDir, pkgRoot), yarnPnp: true }
    // useGlobalScope=true is the production driver of the
    // anchored shape; the runner threads it into the entry
    // builder.
    await runCursorInstall(ctx, null, targetPath, true)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    const loreEntry = (written.mcpServers as Record<string, unknown>).lore as {
      command: string
      args: string[]
      cwd?: string
      env: Record<string, string>
    }
    expect(loreEntry.command).toBe("yarn")
    expect(loreEntry.args).toEqual(["run", "-T", "lore", "mcp"])
    // configRoot defaults to projectDir under makeContext (no
    // .lore.yaml on disk). `toPortablePath` leaves tmpdir paths
    // unchanged because they're outside `homedir()`.
    expect(loreEntry.cwd).toBe(projectDir)
    expect(loreEntry.env["LORE_CONFIG_ROOT"]).toBe(projectDir)
  })

  it("anchors cwd to projectDir (NOT configRoot) when .lore.yaml lives above the PnP workspace", async () => {
    // PR #182 second-round review feedback: `--project
    // <repo>/services/mail` plus a `.lore.yaml` that resolves to a
    // parent ABOVE the PnP workspace splits the two roots:
    //
    //   tmpdir/umbrella/                       <- configRoot
    //                                              (.lore.yaml lives here,
    //                                              found by findConfigFile's
    //                                              upward walk from mail)
    //   tmpdir/umbrella/repo/                  <- PnP workspace
    //                                              (.pnp.cjs lives here)
    //   tmpdir/umbrella/repo/services/mail/    <- projectDir
    //                                              (--project arg)
    //
    // The earlier shape of this fix derived `cwd` from `configRoot`,
    // which works when `.lore.yaml` lives inside the PnP workspace
    // (configRoot === projectDir or descendant) but breaks here:
    // `cwd === umbrella` is OUTSIDE the PnP workspace, so
    // `yarn run -T` walks upward from umbrella and never enters
    // `repo/` where `.pnp.cjs` lives. Same class of failure the
    // global-scope anchor was supposed to close.
    //
    // The fix: thread `launchCwd: context.projectDir` through to
    // the entry builder, and `LORE_CONFIG_ROOT: context.configRoot`
    // independently. `projectDir` is what `detectYarnPnp` was
    // called against — guaranteed at-or-below `.pnp.cjs` when
    // `yarnPnp` came back true. `configRoot` continues to point
    // at the actual `.lore.yaml` directory so the spawned MCP
    // child can resolve config.
    const umbrella = mkdtempSync(join(SCRATCH, "umbrella-"))
    const repo = join(umbrella, "repo")
    const mail = join(repo, "services", "mail")
    mkdirSync(mail, { recursive: true })
    writeFileSync(join(repo, ".pnp.cjs"), "")

    const pkgRoot = mkdtempSync(join(SCRATCH, "split-pkg-"))
    const fakeHome = mkdtempSync(join(SCRATCH, "split-home-"))
    const targetPath = join(fakeHome, ".cursor", "mcp.json")

    const ctx: InstallContext = {
      ...makeContext(mail, pkgRoot),
      // configRoot deliberately diverges from projectDir — this is
      // the topology where `.lore.yaml` resolves to a parent above
      // the PnP workspace.
      configRoot: umbrella,
      yarnPnp: true,
    }
    await runCursorInstall(ctx, null, targetPath, true)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    const loreEntry = (written.mcpServers as Record<string, unknown>).lore as {
      cwd?: string
      env: Record<string, string>
    }
    // The fix: cwd anchors to projectDir (inside PnP workspace)
    // so `yarn run -T` can walk upward to `.pnp.cjs` at `repo`.
    expect(loreEntry.cwd).toBe(mail)
    // The fix: LORE_CONFIG_ROOT continues to point at the
    // `.lore.yaml` directory (above the PnP workspace), separate
    // from `cwd`.
    expect(loreEntry.env["LORE_CONFIG_ROOT"]).toBe(umbrella)
    // Negative assertion: cwd MUST NOT equal configRoot in this
    // topology — that's exactly the bug the fix closes.
    expect(loreEntry.cwd).not.toBe(umbrella)
  })

  it("does NOT anchor the PnP entry under project-scoped install (committed-portability invariant)", async () => {
    // Inverse of the test above: pin that the project-scoped path
    // continues to omit `cwd` and `LORE_CONFIG_ROOT` so committed
    // `<project>/.cursor/mcp.json` stays portable across
    // engineers. A regression that lifted the global-scope anchor
    // into the project path would silently re-introduce
    // per-engineer leaks Mail PR #25947 spent effort to remove.
    const projectDir = mkdtempSync(join(SCRATCH, "pnp-project-"))
    const pkgRoot = mkdtempSync(join(SCRATCH, "pnp-project-pkg-"))
    const targetPath = join(projectDir, ".cursor", "mcp.json")

    const ctx: InstallContext = { ...makeContext(projectDir, pkgRoot), yarnPnp: true }
    await runCursorInstall(ctx, null, targetPath, false)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    const loreEntry = (written.mcpServers as Record<string, unknown>).lore as {
      cwd?: string
      env: Record<string, string>
    }
    expect(loreEntry.cwd).toBeUndefined()
    expect(loreEntry.env).not.toHaveProperty("LORE_CONFIG_ROOT")
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
    // `buildLegacyCursorMcpEntry` would produce for this pkgRoot AND
    // this configRoot (same env shape as the install would write).
    const seededEntry = buildLegacyCursorMcpEntry(
      toPortablePath(join(pkgRoot, "dist", "mcp.js")),
      toPortablePath(pkgRoot),
      projectDir,
      process.env,
    )
    const fs = await import("node:fs/promises")
    await fs.mkdir(join(projectDir, ".cursor"), { recursive: true })
    writeFileSync(targetPath, JSON.stringify({ mcpServers: { lore: seededEntry } }, null, 2))

    consoleLogSpy.mockClear()
    await runCursorInstall(makeContext(projectDir, pkgRoot), null, targetPath, false)

    const written = JSON.parse(await readFile(targetPath, "utf-8")) as Record<string, unknown>
    expect((written.mcpServers as Record<string, unknown>).lore).toEqual(
      buildCursorMcpEntry("bare", projectDir, process.env),
    )

    const messages = consoleLogSpy.mock.calls.map((args) => args.join(" ")).join("\n")
    expect(messages).toMatch(/MCP server:\s+legacy form \(will upgrade\)/)
    expect(messages).toMatch(/MCP server:\s+upgraded \(legacy → bin-dispatch\)/)
  })

  it("succeeds without hook scripts on disk — Cursor doesn't depend on autosave/wakeup", async () => {
    // `lore install --client cursor` must NOT abort just because
    // `hooks/autosave.sh` or `hooks/wakeup.sh` are missing or
    // non-writable. Cursor's MCP runtime doesn't use them.
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
      configRoot: pkgRoot,
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
      configRoot: "/tmp/orchestration-fake-project",
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
  //
  // 0.10.0 layered env: `--print-config` carries the same conditional
  // forwarding (`${VAR}` placeholders for keys present in the
  // operator's install-time env) plus the always-on
  // `LORE_CONFIG_ROOT` static — sourced from `--project` (when
  // present) or cwd otherwise.

  it("emits the bin-dispatch JSON shape by default for format='json'", () => {
    const output = buildPrintConfigOutput(
      "json",
      "/lore/dist/mcp.js",
      "/lore",
      TEST_CONFIG_ROOT,
      false,
      "bare",
      ENV_BOTH_LEGACY,
    )
    const parsed = JSON.parse(output) as {
      mcpServers: { lore: { command: string; args: string[]; env: Record<string, string> } }
    }
    expect(parsed.mcpServers.lore.command).toBe("lore")
    expect(parsed.mcpServers.lore.args).toEqual(["mcp"])
    expect(parsed.mcpServers.lore.env["LORE_NOTION_TOKEN"]).toBe("${LORE_NOTION_TOKEN}")
    expect(parsed.mcpServers.lore.env["LORE_CONFIG_ROOT"]).toBe(TEST_CONFIG_ROOT)
    expect(parsed.mcpServers.lore.env["LORE_SUPPRESS_DEPRECATIONS"]).toBe("1")
    expect(output.endsWith("\n")).toBe(true)
  })

  it("emits the bin-dispatch TOML shape by default for format='toml'", () => {
    const output = buildPrintConfigOutput(
      "toml",
      "/lore/dist/mcp.js",
      "/lore",
      TEST_CONFIG_ROOT,
      false,
      "bare",
      ENV_BOTH_LEGACY,
    )
    expect(output.startsWith("[mcp_servers.lore]\n")).toBe(true)
    expect(output).toContain('command = "bash"')
    expect(output).toContain(
      `args = ["-lc", "LORE_CONFIG_ROOT='${TEST_CONFIG_ROOT}' LORE_SUPPRESS_DEPRECATIONS='1' lore mcp"]`,
    )
    expect(output).toContain("env_vars = ")
    expect(output).toContain('"LORE_NOTION_TOKEN"')
    // Trailing newline lets `lore install --print-config toml >> file.toml`
    // append a clean section without joining the next line.
    expect(output.endsWith("\n")).toBe(true)
  })

  it("contains no static env values when only operator env vars are unset", () => {
    // With ENV_NONE, neither NOTION_API_TOKEN nor LORE_NOTION_TOKEN
    // forwards. The MCP server resolves auth via auth.json on its own
    // (LORE_CONFIG_ROOT is forwarded so it knows where to look).
    const output = buildPrintConfigOutput(
      "json",
      "/lore/dist/mcp.js",
      "/lore",
      TEST_CONFIG_ROOT,
      false,
      "bare",
      ENV_NONE,
    )
    const parsed = JSON.parse(output) as {
      mcpServers: { lore: { env: Record<string, string> } }
    }
    expect(parsed.mcpServers.lore.env).toEqual(STATIC_ENV_FOR_TEST_CONFIG_ROOT)
  })

  it("emits the legacy absolute-path JSON shape when legacyPaths=true", () => {
    const home = homedir()
    const output = buildPrintConfigOutput(
      "json",
      `${home}/.lore/dist/mcp.js`,
      `${home}/.lore`,
      TEST_CONFIG_ROOT,
      true,
      "bare",
      ENV_BOTH_LEGACY,
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
      TEST_CONFIG_ROOT,
      true,
      "bare",
      ENV_BOTH_LEGACY,
    )
    expect(output).toContain('command = "bash"')
    // The legacy launch command embeds the mcp.js path via path-aware
    // quoting: the `${HOME}` portability marker is double-quoted (so
    // bash expands it at launch time) and the suffix is single-quoted
    // (so a path containing `$`/backtick/`\\` does not trigger shell
    // re-interpretation). `JSON.stringify` would expose the suffix to
    // shell expansion; plain `shellQuoteSingle` would inhibit `${HOME}`
    // expansion and break committed-config portability.
    //
    // After JSON-encoding for TOML emission: each literal `"` becomes
    // `\"` and the single quotes pass through unchanged.
    expect(output).toContain('node \\"${HOME}\\"\'/.lore/dist/mcp.js\'')
    expect(output).toContain(`LORE_CONFIG_ROOT='${TEST_CONFIG_ROOT}'`)
  })

  it("byte-matches buildClaudeMcpEntry() under the bin-dispatch default", () => {
    const expected =
      JSON.stringify(
        { mcpServers: { lore: buildClaudeMcpEntry("bare", TEST_CONFIG_ROOT, ENV_BOTH_LEGACY) } },
        null,
        2,
      ) + "\n"
    expect(
      buildPrintConfigOutput(
        "json",
        "/lore/dist/mcp.js",
        "/lore",
        TEST_CONFIG_ROOT,
        false,
        "bare",
        ENV_BOTH_LEGACY,
      ),
    ).toBe(expected)
  })

  it("byte-matches buildLegacyClaudeMcpEntry under --legacy-paths", () => {
    const expected =
      JSON.stringify(
        {
          mcpServers: {
            lore: buildLegacyClaudeMcpEntry(
              "/lore/dist/mcp.js",
              "/lore",
              TEST_CONFIG_ROOT,
              ENV_BOTH_LEGACY,
            ),
          },
        },
        null,
        2,
      ) + "\n"
    expect(
      buildPrintConfigOutput(
        "json",
        "/lore/dist/mcp.js",
        "/lore",
        TEST_CONFIG_ROOT,
        true,
        "bare",
        ENV_BOTH_LEGACY,
      ),
    ).toBe(expected)
  })

  it("byte-matches buildCodexMcpSection() under the bin-dispatch default", () => {
    const expected = buildCodexMcpSection("bare", TEST_CONFIG_ROOT, ENV_BOTH_LEGACY) + "\n"
    expect(
      buildPrintConfigOutput(
        "toml",
        "/lore/dist/mcp.js",
        "/lore",
        TEST_CONFIG_ROOT,
        false,
        "bare",
        ENV_BOTH_LEGACY,
      ),
    ).toBe(expected)
  })

  it("byte-matches buildLegacyCodexMcpSection under --legacy-paths", () => {
    const expected =
      buildLegacyCodexMcpSection("/lore/dist/mcp.js", TEST_CONFIG_ROOT, ENV_BOTH_LEGACY) + "\n"
    expect(
      buildPrintConfigOutput(
        "toml",
        "/lore/dist/mcp.js",
        "/lore",
        TEST_CONFIG_ROOT,
        true,
        "bare",
        ENV_BOTH_LEGACY,
      ),
    ).toBe(expected)
  })

  it("ignores --client / --project context — output depends only on resolved paths and legacyPaths", () => {
    // Neither --client nor --project flows into buildPrintConfigOutput. Two
    // calls with the same paths always produce the same snippet, regardless
    // of what the operator passed alongside --print-config.
    const first = buildPrintConfigOutput(
      "json",
      "/lore/dist/mcp.js",
      "/lore",
      TEST_CONFIG_ROOT,
      false,
      "bare",
      ENV_BOTH_LEGACY,
    )
    const second = buildPrintConfigOutput(
      "json",
      "/lore/dist/mcp.js",
      "/lore",
      TEST_CONFIG_ROOT,
      false,
      "bare",
      ENV_BOTH_LEGACY,
    )
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

  it("--project sets the embedded LORE_CONFIG_ROOT in the print-config snippet (no file write)", async () => {
    // Behavior change in 0.10.0/08: --print-config used to ignore
    // --project entirely. Under ntn-first auth, the spawned MCP child
    // needs LORE_CONFIG_ROOT to find the right `.lore.yaml`, so
    // --project is now load-bearing for the embedded static — even
    // though no file is written. The bin-dispatch entry has no `cwd`
    // field, so the proof is the env value, not cwd.
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
      mcpServers: { lore: { env: Record<string, string> } }
    }
    // Asserts the new contract: --project resolves to the embedded
    // LORE_CONFIG_ROOT static. findConfigFile returns null for a
    // fictitious path, so configRoot falls back to the resolved
    // `--project` directory itself.
    expect(parsed.mcpServers.lore.env["LORE_CONFIG_ROOT"]).toBe(
      "/tmp/nonexistent-print-config-test",
    )
    expect(parsed.mcpServers.lore.env["LORE_SUPPRESS_DEPRECATIONS"]).toBe("1")
    // No file write side-effect: the install banner never landed on
    // stdout (the print-config short-circuit fires first).
    expect(output).not.toContain("Checking prerequisites")
  })
})

describe("shellQuoteSingle (issue 0.10.0/08)", () => {
  // The Codex `bash -lc` launch line must inhibit shell expansion of
  // path metacharacters in `LORE_CONFIG_ROOT`. JSON.stringify (the
  // original 0.10.0 draft) produces double-quoted strings, which do
  // NOT inhibit `$`, backticks, or `\\` under bash. Single-quote
  // POSIX quoting is the safe shape — these tests pin the contract
  // for the metacharacters bash would otherwise interpret.

  it("inhibits parameter expansion ($VAR)", () => {
    expect(shellQuoteSingle("/Users/foo/$bar/project")).toBe(
      "'/Users/foo/$bar/project'",
    )
  })

  it("inhibits command substitution (backticks and $())", () => {
    expect(shellQuoteSingle("/Users/foo/`whoami`/project")).toBe(
      "'/Users/foo/`whoami`/project'",
    )
    expect(shellQuoteSingle("/Users/foo/$(whoami)/project")).toBe(
      "'/Users/foo/$(whoami)/project'",
    )
  })

  it("preserves backslash without escaping (no double-quote semantics)", () => {
    // Inside double quotes bash interprets `\` as an escape; inside
    // single quotes it's literal.
    expect(shellQuoteSingle("a\\b")).toBe("'a\\b'")
  })

  it("escapes embedded single quotes via close-escape-reopen", () => {
    // Standard POSIX idiom: `'foo'\''bar'` parses as concatenation of
    // `'foo'` + `\'` + `'bar'` and yields `foo'bar`.
    expect(shellQuoteSingle("foo'bar")).toBe("'foo'\\''bar'")
  })

  it("preserves spaces verbatim inside single quotes", () => {
    expect(shellQuoteSingle("/Users/Foo Bar/proj")).toBe("'/Users/Foo Bar/proj'")
  })

  it("emits empty quotes for empty input", () => {
    expect(shellQuoteSingle("")).toBe("''")
  })
})

describe("shellQuotePortablePath (issue 0.10.0/08)", () => {
  // The path-aware quoter solves a constraint plain `shellQuoteSingle`
  // can't: `toPortablePath` rewrites home-relative paths into
  // `${HOME}/...` for committed-config portability, and bash MUST be
  // allowed to expand that marker at launch time. The quoter splits
  // the path on the `${HOME}` prefix — prefix double-quoted (expands),
  // suffix single-quoted (literal). Adjacent-string concatenation in
  // bash joins the two halves into a single argv entry.

  it("emits bare \"${HOME}\" when the value is exactly the home marker", () => {
    expect(shellQuotePortablePath("${HOME}")).toBe(`"\${HOME}"`)
  })

  it("preserves ${HOME} expansion AND inhibits suffix metacharacter expansion", () => {
    // The load-bearing case: home-portable path under Lore install.
    expect(shellQuotePortablePath("${HOME}/.lore/dist/mcp.js")).toBe(
      `"\${HOME}"'/.lore/dist/mcp.js'`,
    )
  })

  it("inhibits $-expansion in the suffix even when the prefix is the home marker", () => {
    // Pathological: home-portable prefix + suffix containing literal
    // `$bar` (legal Unix, illegal under double-quoted bash).
    expect(shellQuotePortablePath("${HOME}/$build/mcp.js")).toBe(
      `"\${HOME}"'/$build/mcp.js'`,
    )
  })

  it("inhibits backtick command substitution in the suffix", () => {
    expect(shellQuotePortablePath("${HOME}/`whoami`/mcp.js")).toBe(
      `"\${HOME}"'/\`whoami\`/mcp.js'`,
    )
  })

  it("falls through to plain single-quoting on absolute (non-${HOME}) paths", () => {
    // Lore installed outside the operator's home (e.g., /opt/lore) —
    // there's no portability marker to preserve, so single-quote the
    // whole path the same way `shellQuoteSingle` would.
    expect(shellQuotePortablePath("/opt/lore/dist/mcp.js")).toBe("'/opt/lore/dist/mcp.js'")
  })

  it("falls through to plain single-quoting on absolute paths with shell metacharacters", () => {
    expect(shellQuotePortablePath("/opt/lore/$build/mcp.js")).toBe(
      "'/opt/lore/$build/mcp.js'",
    )
  })

  it("does NOT match a path that merely contains ${HOME} mid-string", () => {
    // Defensive: only the prefix form gets the split treatment. A
    // path like `/home/foo/${HOME}-suffix` (rare but legal) doesn't
    // start with the marker and falls through to single-quoting.
    expect(shellQuotePortablePath("/home/foo/${HOME}-suffix")).toBe(
      "'/home/foo/${HOME}-suffix'",
    )
  })
})

describe("buildCodexMcpSection — shell-safe path embedding", () => {
  // Regression test for the Codex `bash -lc` shape: a configRoot
  // containing `$`, backticks, or `'` must NOT cause shell expansion
  // when the line is re-evaluated. The TEST_CONFIG_ROOT fixture used
  // elsewhere (`/test/config-root`) is metachar-free and would not
  // catch a regression here.

  it("single-quotes $-bearing configRoots so bash does not expand the variable", () => {
    const root = "/Users/foo/$bar/project"
    const section = buildCodexMcpSection("bare", root, ENV_BOTH_LEGACY)
    // The literal `$bar` must appear in the launch command unquoted
    // by double-quotes, so bash treats it as a literal string.
    expect(section).toContain(
      `args = ["-lc", "LORE_CONFIG_ROOT='/Users/foo/$bar/project' LORE_SUPPRESS_DEPRECATIONS='1' lore mcp"]`,
    )
  })

  it("single-quotes backtick-bearing configRoots so bash does not run command substitution", () => {
    const root = "/Users/foo/`whoami`/project"
    const section = buildCodexMcpSection("bare", root, ENV_BOTH_LEGACY)
    expect(section).toContain(
      `args = ["-lc", "LORE_CONFIG_ROOT='/Users/foo/\`whoami\`/project' LORE_SUPPRESS_DEPRECATIONS='1' lore mcp"]`,
    )
  })

  it("escapes embedded single quotes via the POSIX close-escape-reopen idiom", () => {
    const root = "/Users/foo's/project"
    const section = buildCodexMcpSection("bare", root, ENV_BOTH_LEGACY)
    // `'foo'\''s'` ↦ bash concatenation of `foo` + `'` + `s`.
    // Inside the TOML JSON-encoded string, the backslash is escaped
    // again as `\\\\` (one for JSON, one for literal backslash).
    expect(section).toContain(
      `LORE_CONFIG_ROOT='/Users/foo'\\\\''s/project'`,
    )
  })
})

describe("buildLegacyCodexMcpSection — shell-safe path embedding", () => {
  // The legacy bash-`-lc` path interpolates the mcp.js path INTO the
  // launch command, so it shares the same shell-injection hazard the
  // static env prefix had to address. The path-aware quoting helper
  // also has to preserve the `${HOME}` portability marker —
  // `toPortablePath` rewrites home-relative paths into `${HOME}/...`
  // for committed-config portability, and bash MUST be allowed to
  // expand `${HOME}` at launch time. Plain single-quoting would
  // inhibit that expansion and break `lore install --legacy-paths`
  // installs under home; plain double-quoting (the original 0.10.0
  // draft) would re-expose `$bar` / backtick / `\\` to bash. The
  // helper resolves both with `"${HOME}"'/<suffix>'` — adjacent
  // quoted strings concatenate into a single argv entry, with the
  // prefix expanded and the suffix literal.

  it("single-quotes absolute (non-${HOME}) $-bearing mcp.js paths so bash does not expand the variable", () => {
    const mcpPath = "/opt/lore/$build/dist/mcp.js"
    const section = buildLegacyCodexMcpSection(mcpPath, TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)
    expect(section).toContain(
      `args = ["-lc", "LORE_CONFIG_ROOT='${TEST_CONFIG_ROOT}' LORE_SUPPRESS_DEPRECATIONS='1' node '/opt/lore/$build/dist/mcp.js'"]`,
    )
  })

  it("single-quotes backtick-bearing mcp.js paths so bash does not run command substitution", () => {
    const mcpPath = "/opt/lore/`whoami`/dist/mcp.js"
    const section = buildLegacyCodexMcpSection(mcpPath, TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)
    expect(section).toContain(
      `args = ["-lc", "LORE_CONFIG_ROOT='${TEST_CONFIG_ROOT}' LORE_SUPPRESS_DEPRECATIONS='1' node '/opt/lore/\`whoami\`/dist/mcp.js'"]`,
    )
  })

  it("escapes embedded single quotes in mcp.js paths via close-escape-reopen", () => {
    const mcpPath = "/opt/lore/foo's/dist/mcp.js"
    const section = buildLegacyCodexMcpSection(mcpPath, TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)
    // `'foo'\''s'` after JSON-encoding for TOML emission.
    expect(section).toContain(`node '/opt/lore/foo'\\\\''s/dist/mcp.js'`)
  })

  it("preserves ${HOME} expansion on home-portable paths (the standard ~/.lore install)", () => {
    // `lore install --legacy-paths` against a Lore checkout under the
    // operator's home produces a `toPortablePath` output of
    // `${HOME}/.lore/dist/mcp.js`. Bash must expand `${HOME}` to the
    // runtime home; the suffix is single-quoted as a defensive measure
    // against pathological suffix metacharacters.
    //
    // After JSON-encoding for TOML emission: `"${HOME}"` becomes
    // `\"${HOME}\"` and the single quotes pass through.
    const mcpPath = `${homedir()}/.lore/dist/mcp.js`
    const section = buildLegacyCodexMcpSection(mcpPath, TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)
    expect(section).toContain('node \\"${HOME}\\"\'/.lore/dist/mcp.js\'')
  })

  it("preserves ${HOME} expansion AND inhibits suffix metacharacter expansion simultaneously", () => {
    // Pathological combination: home-portable path whose home-relative
    // suffix contains `$bar`. Bash must expand `${HOME}` (portability)
    // but NOT `$bar` (security). Adjacent-quoted-string concatenation
    // is what keeps the two halves on a single argv entry.
    const mcpPath = `${homedir()}/.lore/$build/dist/mcp.js`
    const section = buildLegacyCodexMcpSection(mcpPath, TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)
    expect(section).toContain('node \\"${HOME}\\"\'/.lore/$build/dist/mcp.js\'')
  })

  it("emits bare \"${HOME}\" when the path is exactly ${HOME} (no suffix)", () => {
    // Edge case: toPortablePath returns the bare string "${HOME}" when
    // the input equals the operator's home directory exactly. Pass
    // that through as a no-suffix portable token so bash expands it
    // verbatim. (No real-world Lore install lives at the home root,
    // but pinning this branch keeps the helper honest.)
    const section = buildLegacyCodexMcpSection(homedir(), TEST_CONFIG_ROOT, ENV_BOTH_LEGACY)
    expect(section).toContain('node \\"${HOME}\\"')
  })
})

describe("buildMcpEnv (issue 0.10.0/08)", () => {
  // The conditional-forwarding contract is the load-bearing piece of
  // the 0.10.0 ntn-first install — pre-0.10.0 unconditionally
  // forwarded `LORE_NOTION_TOKEN` and `LORE_NOTION_BASE_URL`, which
  // pre-0.10.0 was the canonical auth path. Under ntn-first the
  // canonical path is `auth.json` (resolved at runtime by the MCP
  // server's `resolveAuth`); install-time forwarding is for
  // *legacy operators* whose env still carries one of the deprecated
  // vars, plus operators who explicitly set `NOTION_API_TOKEN`.

  it("forwards NOTION_API_TOKEN when the operator has it set, plus always-on statics", () => {
    const env: NodeJS.ProcessEnv = { NOTION_API_TOKEN: "ntn-tok" }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.env).toEqual({ NOTION_API_TOKEN: "${NOTION_API_TOKEN}" })
    expect(build.staticEnv).toEqual(STATIC_ENV_FOR_TEST_CONFIG_ROOT)
    expect(build.forwarded).toEqual(["NOTION_API_TOKEN"])
  })

  it("forwards LORE_NOTION_TOKEN and reports it via `forwarded` for the migration note", () => {
    // Acceptance criterion: a fresh install with `LORE_NOTION_TOKEN`
    // set produces an MCP entry env containing `${LORE_NOTION_TOKEN}`
    // AND surfaces the forwarded key so the install action prints the
    // legacy-deprecated note shown at the install summary. The `forwarded`
    // array is
    // the connection between buildMcpEnv and the install action's
    // legacy-detected note.
    const env: NodeJS.ProcessEnv = { LORE_NOTION_TOKEN: "lore-tok" }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.env).toEqual({ LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}" })
    expect(build.forwarded).toContain("LORE_NOTION_TOKEN")
  })

  it("forwards both env vars when both are set in the operator env", () => {
    const env: NodeJS.ProcessEnv = {
      NOTION_API_TOKEN: "api-tok",
      LORE_NOTION_TOKEN: "lore-tok",
    }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.env).toEqual({
      NOTION_API_TOKEN: "${NOTION_API_TOKEN}",
      LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}",
    })
    expect(build.forwarded.sort()).toEqual(["LORE_NOTION_TOKEN", "NOTION_API_TOKEN"])
  })

  it("forwards no auth env when neither var is set — MCP server resolves via auth.json", () => {
    // 0.10.0 default: a fresh install with no env vars produces an
    // MCP entry env with only LORE_CONFIG_ROOT + LORE_SUPPRESS_DEPRECATIONS=1.
    // The MCP server resolves auth via auth.json on its own startup
    // (no token forwarding needed because resolveAuth's path 2 reads
    // directly from `~/.config/notion/auth.json`).
    const build = buildMcpEnv(TEST_CONFIG_ROOT, ENV_NONE)
    expect(build.env).toEqual({})
    expect(build.staticEnv).toEqual(STATIC_ENV_FOR_TEST_CONFIG_ROOT)
    expect(build.forwarded).toEqual([])
  })

  it("treats empty-string env values as unset (does not forward `${VAR}` for empty values)", () => {
    // A literal empty string in the env shouldn't push a `${VAR}`
    // placeholder — the host would resolve `${VAR}` to empty at spawn
    // time and `resolveAuth` would fall through to the next priority
    // path anyway. Defending against the "operator has the var
    // declared but empty" edge case keeps the entry shape honest.
    const env: NodeJS.ProcessEnv = {
      NOTION_API_TOKEN: "",
      LORE_NOTION_TOKEN: "value",
    }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.env).toEqual({ LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}" })
    expect(build.forwarded).toEqual(["LORE_NOTION_TOKEN"])
  })

  it("forwards LORE_NOTION_BASE_URL alongside whichever token forwards", () => {
    // The base URL override is orthogonal to the auth-source choice —
    // dev / staging environments need it regardless of whether the
    // operator is on NOTION_API_TOKEN or LORE_NOTION_TOKEN.
    const env: NodeJS.ProcessEnv = {
      NOTION_API_TOKEN: "tok",
      LORE_NOTION_BASE_URL: "https://api.dev.notion.com",
    }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.env["LORE_NOTION_BASE_URL"]).toBe("${LORE_NOTION_BASE_URL}")
    expect(build.forwarded).toContain("LORE_NOTION_BASE_URL")
  })

  it("forwards ntn-native NOTION_ENV so a dev MCP child resolves the same env as the install-time preflight", () => {
    // A dev operator with NOTION_ENV=dev set in their shell needs
    // the variable to reach the spawned MCP child too — without
    // forwarding, the child would silently default to prod even
    // though install-time preflight resolved dev (via ntn's
    // config.json). Forwarding closes the install/runtime gap.
    const env: NodeJS.ProcessEnv = { NOTION_ENV: "dev" }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.env["NOTION_ENV"]).toBe("${NOTION_ENV}")
    expect(build.forwarded).toContain("NOTION_ENV")
  })

  it("forwards ntn-native NOTION_BASE_URL when the operator has it set", () => {
    // ntn's documented base-URL override. Some operators export this
    // (rather than the Lore-namespaced LORE_NOTION_BASE_URL) because
    // it's what `ntn --help` documents. Forwarding lets the MCP
    // child's resolveAuth pick up the same override via
    // `resolveOperatorBaseUrl` priority chain.
    const env: NodeJS.ProcessEnv = { NOTION_BASE_URL: "https://api-dev.notion.com" }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.env["NOTION_BASE_URL"]).toBe("${NOTION_BASE_URL}")
    expect(build.forwarded).toContain("NOTION_BASE_URL")
  })

  it("forwards ntn-native NOTION_API_BASE_URL when the operator has it set", () => {
    // The legacy ntn name; same posture as NOTION_BASE_URL.
    const env: NodeJS.ProcessEnv = { NOTION_API_BASE_URL: "https://api-stg.notion.com" }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.env["NOTION_API_BASE_URL"]).toBe("${NOTION_API_BASE_URL}")
    expect(build.forwarded).toContain("NOTION_API_BASE_URL")
  })

  it("forwards NOTION_WORKSPACE_ID so a multi-workspace ntn MCP child picks the same workspace as the foreground CLI (#188)", () => {
    // Multi-workspace ntn engineers select their workspace via
    // `NOTION_WORKSPACE_ID`; without forwarding, the spawned MCP
    // child's `loadNtnToken` would fall back to the single-workspace
    // auto-pick (which throws with a "specify a workspace" hint when
    // auth.json carries multiple) or pick the wrong one. Same shape
    // as the other ntn-native vars.
    const env: NodeJS.ProcessEnv = { NOTION_WORKSPACE_ID: "ws_abc" }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.env["NOTION_WORKSPACE_ID"]).toBe("${NOTION_WORKSPACE_ID}")
    expect(build.forwarded).toContain("NOTION_WORKSPACE_ID")
  })

  it("forwards all eight runtime keys when the operator has the full ntn-dev shell environment", () => {
    // Pathological-but-real: a dev operator with everything set.
    // All eight keys forward as `${VAR}` placeholders. Includes
    // LORE_USER_NAME (DEFERRED-ATTRIBUTION) — operators who set the
    // attribution override at install time keep it on the spawned
    // MCP child without an extra `users.me` round-trip — and
    // NOTION_WORKSPACE_ID (#188) so multi-workspace ntn engineers'
    // hook workers and MCP children pick the same workspace.
    const env: NodeJS.ProcessEnv = {
      NOTION_API_TOKEN: "api-tok",
      LORE_NOTION_TOKEN: "lore-tok",
      LORE_NOTION_BASE_URL: "https://api-dev.notion.com",
      NOTION_WORKSPACE_ID: "ws_abc",
      NOTION_ENV: "dev",
      NOTION_BASE_URL: "https://api-dev.notion.com",
      NOTION_API_BASE_URL: "https://api-dev.notion.com",
      LORE_USER_NAME: "Hesham Salman",
    }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.env).toEqual({
      NOTION_API_TOKEN: "${NOTION_API_TOKEN}",
      LORE_NOTION_TOKEN: "${LORE_NOTION_TOKEN}",
      LORE_NOTION_BASE_URL: "${LORE_NOTION_BASE_URL}",
      NOTION_WORKSPACE_ID: "${NOTION_WORKSPACE_ID}",
      NOTION_ENV: "${NOTION_ENV}",
      NOTION_BASE_URL: "${NOTION_BASE_URL}",
      NOTION_API_BASE_URL: "${NOTION_API_BASE_URL}",
      LORE_USER_NAME: "${LORE_USER_NAME}",
    })
    // Order pinned via runtimeForwardedKeys (matches RUNTIME_FORWARDED_KEYS).
    expect(build.forwarded).toEqual([
      "NOTION_API_TOKEN",
      "LORE_NOTION_TOKEN",
      "LORE_NOTION_BASE_URL",
      "NOTION_WORKSPACE_ID",
      "NOTION_ENV",
      "NOTION_BASE_URL",
      "NOTION_API_BASE_URL",
      "LORE_USER_NAME",
    ])
  })

  it("forwards LORE_USER_NAME when the operator has the attribution override set (DEFERRED-ATTRIBUTION)", () => {
    // The operator-controlled escape hatch parallel to LORE_AGENT_NAME.
    // Without forwarding, an MCP child resolves identity via `users.me`
    // and the operator's explicit override never reaches the column.
    const env: NodeJS.ProcessEnv = { LORE_USER_NAME: "hsalman" }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.env["LORE_USER_NAME"]).toBe("${LORE_USER_NAME}")
    expect(build.forwarded).toContain("LORE_USER_NAME")
  })

  it("does NOT include LORE_USER_NAME in the legacy-deprecated note filter", () => {
    // Only LORE_NOTION_TOKEN is soft-deprecated. LORE_USER_NAME is a
    // first-class operator override under DEFERRED-ATTRIBUTION; an
    // engineer who sets it shouldn't see a migration recommendation
    // pointing them at ntn.
    const env: NodeJS.ProcessEnv = { LORE_USER_NAME: "hsalman" }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.forwarded).not.toContain("LORE_NOTION_TOKEN")
  })

  it("threads LORE_USER_NAME into Claude / Cursor / Codex installer output as `${LORE_USER_NAME}`", () => {
    // Per-host coverage that the reviewer flagged: the runtime-forward
    // is only useful if the three install paths actually emit it. Pin
    // each host's output shape so a future RUNTIME_FORWARDED_KEYS edit
    // that drops LORE_USER_NAME from the chain breaks the test.
    const env: NodeJS.ProcessEnv = { LORE_USER_NAME: "hsalman" }

    const claudeEntry = buildClaudeMcpEntry("bare", TEST_CONFIG_ROOT, env)
    expect(claudeEntry.env).toMatchObject({
      LORE_USER_NAME: "${LORE_USER_NAME}",
    })

    const cursorEntry = buildCursorMcpEntry("bare", TEST_CONFIG_ROOT, env)
    expect(cursorEntry.env).toMatchObject({
      LORE_USER_NAME: "${LORE_USER_NAME}",
    })

    const codexSection = buildCodexMcpSection("bare", TEST_CONFIG_ROOT, env)
    expect(codexSection).toContain('"LORE_USER_NAME"')
    // Codex's `env_vars = [...]` is a name-only allowlist; the host
    // resolves the value at MCP-spawn time from the operator's env.
    // The string match here pins both that LORE_USER_NAME shows up in
    // the array AND that it's quoted (so a future formatting refactor
    // can't accidentally emit it as a literal value).
  })

  it("does NOT include the new ntn-native keys in the legacy-deprecated note filter", () => {
    // Only LORE_NOTION_TOKEN is soft-deprecated. NOTION_ENV /
    // NOTION_BASE_URL / NOTION_API_BASE_URL are normal ntn vars and
    // shouldn't trigger the migration recommendation.
    const env: NodeJS.ProcessEnv = {
      NOTION_ENV: "dev",
      NOTION_BASE_URL: "https://api-dev.notion.com",
      NOTION_API_BASE_URL: "https://api-dev.notion.com",
    }
    const build = buildMcpEnv(TEST_CONFIG_ROOT, env)
    expect(build.forwarded).not.toContain("LORE_NOTION_TOKEN")
  })

  it("omits LORE_CONFIG_ROOT from staticEnv when omitConfigRoot is true (PnP path)", () => {
    // Yarn-PnP MCP entries are committed to the workspace root and
    // shared across developers; a per-machine LORE_CONFIG_ROOT in
    // shared config breaks portability. Omitting the static drives
    // the spawned MCP server to resolve `.lore.yaml` via the
    // workspace-root cwd walk instead.
    const build = buildMcpEnv(TEST_CONFIG_ROOT, ENV_NONE, { omitConfigRoot: true })
    expect(build.staticEnv).toEqual({ LORE_SUPPRESS_DEPRECATIONS: "1" })
    expect(build.staticEnv["LORE_CONFIG_ROOT"]).toBeUndefined()
  })

  it("retains LORE_CONFIG_ROOT in staticEnv when omitConfigRoot is false (default; bare-bin path)", () => {
    // Bare-bin (non-PnP) installs include LORE_CONFIG_ROOT because
    // the host's spawn cwd may not match the operator's vault
    // directory; the static carries the resolved path so `services.ts`
    // can short-circuit the upward walk.
    const build = buildMcpEnv(TEST_CONFIG_ROOT, ENV_NONE)
    expect(build.staticEnv).toEqual(STATIC_ENV_FOR_TEST_CONFIG_ROOT)
  })
})

describe("Yarn-PnP MCP entry shape (workspace-root resolution + portable env)", () => {
  // The PnP shape pins three properties simultaneously:
  //   1. The launch command uses `yarn run -T lore` so the
  //      workspace-root binary resolves from any subdirectory cwd.
  //   2. `LORE_CONFIG_ROOT` is omitted from the env block (Claude /
  //      Cursor) and from the bash-prefix (Codex) so committed
  //      shared config carries no machine-specific paths.
  //   3. The runtime-forwarded auth/env vars still flow as `${VAR}`
  //      placeholders.

  it("Claude PnP entry uses `yarn run -T` and omits LORE_CONFIG_ROOT", () => {
    const entry = buildClaudeMcpEntry("yarn", TEST_CONFIG_ROOT, ENV_NONE)
    expect(entry.command).toBe("yarn")
    expect(entry.args).toEqual(["run", "-T", "lore", "mcp"])
    expect(entry.env["LORE_CONFIG_ROOT"]).toBeUndefined()
    expect(entry.env["LORE_SUPPRESS_DEPRECATIONS"]).toBe("1")
  })

  it("Cursor PnP entry uses `yarn run -T` and omits LORE_CONFIG_ROOT", () => {
    const entry = buildCursorMcpEntry("yarn", TEST_CONFIG_ROOT, ENV_NONE)
    expect(entry.command).toBe("yarn")
    expect(entry.args).toEqual(["run", "-T", "lore", "mcp"])
    expect(entry.env["LORE_CONFIG_ROOT"]).toBeUndefined()
  })

  it("Codex PnP TOML uses `yarn run -T` and omits LORE_CONFIG_ROOT from the bash prefix", () => {
    const section = buildCodexMcpSection("yarn", TEST_CONFIG_ROOT, ENV_NONE)
    expect(section).toContain('args = ["-lc", "LORE_SUPPRESS_DEPRECATIONS=\'1\' yarn run -T lore mcp"]')
    expect(section).not.toContain("LORE_CONFIG_ROOT=")
  })

  it("PnP entries still forward auth and ntn-env runtime keys when set", () => {
    const env: NodeJS.ProcessEnv = {
      NOTION_API_TOKEN: "tok",
      NOTION_ENV: "dev",
    }
    const claude = buildClaudeMcpEntry("yarn", TEST_CONFIG_ROOT, env)
    expect(claude.env["NOTION_API_TOKEN"]).toBe("${NOTION_API_TOKEN}")
    expect(claude.env["NOTION_ENV"]).toBe("${NOTION_ENV}")
    // Static still suppresses deprecations; LORE_CONFIG_ROOT still absent.
    expect(claude.env["LORE_SUPPRESS_DEPRECATIONS"]).toBe("1")
    expect(claude.env["LORE_CONFIG_ROOT"]).toBeUndefined()
  })

  it("bare (non-PnP) shape continues to include LORE_CONFIG_ROOT (portability boundary)", () => {
    // Pinning the contract that the omission is PnP-specific. A
    // future refactor that lifts omission into the bare path
    // would surface as a failure here.
    const claude = buildClaudeMcpEntry("bare", TEST_CONFIG_ROOT, ENV_NONE)
    expect(claude.env["LORE_CONFIG_ROOT"]).toBe(TEST_CONFIG_ROOT)
  })

  it("Cursor PnP global-scope entry anchors with cwd and keeps LORE_CONFIG_ROOT", () => {
    // Under `--cursor-global` the entry lands at `~/.cursor/mcp.json`
    // which is per-machine, NOT committed across developers. The
    // committed-portability rationale that drives the omissions on
    // the project-scoped path doesn't apply here, and Cursor's
    // launch cwd at fire time is not guaranteed to be inside the
    // PnP project. Without an explicit `cwd` anchor, `yarn run -T`
    // would fire from Cursor's process cwd, fail to find
    // `.pnp.cjs` upward, and the install would silently break for
    // every PnP operator who used `--cursor-global`.
    const entry = buildCursorMcpEntry("yarn", TEST_CONFIG_ROOT, ENV_NONE, {
      useGlobalScope: true,
    })
    expect(entry.command).toBe("yarn")
    expect(entry.args).toEqual(["run", "-T", "lore", "mcp"])
    // cwd defaults to configRoot when launchCwd is omitted —
    // safe in the typical case where `.lore.yaml` lives inside
    // the PnP workspace.
    expect(entry.cwd).toBe(TEST_CONFIG_ROOT)
    // LORE_CONFIG_ROOT short-circuits the spawned MCP child's
    // `.lore.yaml` discovery — defense in depth alongside the cwd
    // anchor in case Cursor or yarn does anything unexpected with
    // cwd inheritance.
    expect(entry.env["LORE_CONFIG_ROOT"]).toBe(TEST_CONFIG_ROOT)
    expect(entry.env["LORE_SUPPRESS_DEPRECATIONS"]).toBe("1")
  })

  it("Cursor PnP global-scope entry uses launchCwd separately from configRoot", () => {
    // Pinning the unit-level invariant the integration test pins
    // end-to-end: when callers pass `launchCwd` distinct from
    // `configRoot` (the split-roots topology where `.lore.yaml`
    // lives above the PnP workspace), the entry's `cwd` derives
    // from `launchCwd` and `LORE_CONFIG_ROOT` from `configRoot`.
    const TEST_PROJECT_DIR = "/test/pnp-workspace/services/mail"
    const TEST_CONFIG_ABOVE_WORKSPACE = "/test/umbrella"
    const entry = buildCursorMcpEntry(
      "yarn",
      TEST_CONFIG_ABOVE_WORKSPACE,
      ENV_NONE,
      { useGlobalScope: true, launchCwd: TEST_PROJECT_DIR },
    )
    // cwd → launchCwd (inside PnP workspace).
    expect(entry.cwd).toBe(TEST_PROJECT_DIR)
    // LORE_CONFIG_ROOT → configRoot (the .lore.yaml directory,
    // possibly outside the PnP workspace).
    expect(entry.env["LORE_CONFIG_ROOT"]).toBe(TEST_CONFIG_ABOVE_WORKSPACE)
  })

  it("Cursor PnP project-scope entry (default) still omits cwd and LORE_CONFIG_ROOT", () => {
    // Default useGlobalScope=false (and the omitted-options call
    // path) must continue to produce the committed-portability
    // shape. A regression that lifted cwd / LORE_CONFIG_ROOT into
    // the project-scoped path would re-introduce the per-engineer
    // path leak Mail PR #25947 fixed.
    const explicit = buildCursorMcpEntry("yarn", TEST_CONFIG_ROOT, ENV_NONE, {
      useGlobalScope: false,
    })
    const defaulted = buildCursorMcpEntry("yarn", TEST_CONFIG_ROOT, ENV_NONE)
    for (const entry of [explicit, defaulted]) {
      expect(entry.cwd).toBeUndefined()
      expect(entry.env["LORE_CONFIG_ROOT"]).toBeUndefined()
    }
  })

  it("Cursor bare global-scope entry keeps LORE_CONFIG_ROOT (no cwd needed)", () => {
    // The bare shape resolves `lore` via PATH (npm /
    // `node_modules/.bin/lore`) — no need to anchor cwd to find a
    // `.pnp.cjs` because there isn't one. The spawned MCP child
    // still needs `LORE_CONFIG_ROOT` to find `.lore.yaml`
    // regardless of Cursor's cwd, which the bare shape already
    // emits unconditionally. Pinning that the global-scope flag
    // doesn't accidentally spuriously add cwd on the bare path.
    const entry = buildCursorMcpEntry("bare", TEST_CONFIG_ROOT, ENV_NONE, {
      useGlobalScope: true,
    })
    expect(entry.cwd).toBeUndefined()
    expect(entry.env["LORE_CONFIG_ROOT"]).toBe(TEST_CONFIG_ROOT)
  })
})

describe("PnP MCP entries carry no per-engineer absolute paths", () => {
  // Followup #11 (makenotion/mail#25947): the headline portability
  // promise of the PnP shape is that `.mcp.json` /
  // `.cursor/mcp.json` / `.codex/config.toml` can be committed to a
  // shared monorepo without leaking any single engineer's checkout
  // path. The `LORE_CONFIG_ROOT` omission is the most visible case
  // (covered above), but the invariant must hold for the entire
  // serialized entry — `command`, `args`, `cwd`, every value in
  // `env`, and the entire Codex bash-prefix string. A regression
  // anywhere in those surfaces would force Mail-style consumers
  // back onto hand-maintained committed config.
  //
  // The probe substrings:
  //   - `/Users/`  catches macOS absolute paths
  //   - `${HOME}`  catches the portability-rewritten shell marker
  //                that `toPortablePath` produces (legitimate on
  //                the legacy absolute-path shape, illegitimate on
  //                the PnP shape)
  //   - `$HOME`    catches the unbraced shell variant for paranoia
  //
  // The PROJECT_ABS_PATH passed in is deliberately under `/Users/`
  // and inside the developer's home directory so a regression that
  // accidentally included `configRoot` somewhere in the entry would
  // fail loudly here. The PnP builders ignore the configRoot for
  // exactly this reason; the test pins that ignoring.
  const PROJECT_ABS_PATH = "/Users/test-engineer/work/repo"

  // Table-driven across the three MCP-host serializers so a
  // regression in any one of them fails its own row independently.
  // Each row's `serialize` returns the full string a future operator
  // would commit to disk — JSON for Claude / Cursor (the on-disk
  // shape that ships in `.mcp.json` / `.cursor/mcp.json`), the raw
  // TOML section for Codex (the on-disk shape that ships in
  // `.codex/config.toml`).
  const PNP_HOSTS = [
    {
      name: "Claude",
      serialize: (env: NodeJS.ProcessEnv) =>
        JSON.stringify(buildClaudeMcpEntry("yarn", PROJECT_ABS_PATH, env)),
    },
    {
      name: "Cursor",
      serialize: (env: NodeJS.ProcessEnv) =>
        JSON.stringify(buildCursorMcpEntry("yarn", PROJECT_ABS_PATH, env)),
    },
    {
      name: "Codex",
      serialize: (env: NodeJS.ProcessEnv) =>
        buildCodexMcpSection("yarn", PROJECT_ABS_PATH, env),
    },
  ] as const

  // A realistic operator env. Real-shaped values (not "test-token"
  // sentinels) so a regression that accidentally interpolated a
  // value into committed config would surface a recognizable
  // secret rather than a sanitized placeholder.
  const REAL_OPERATOR_ENV: NodeJS.ProcessEnv = {
    NOTION_API_TOKEN: "secret_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfG",
    LORE_NOTION_TOKEN: "secret_legacy_lore_token_must_not_leak_into_config",
    LORE_NOTION_BASE_URL: "https://api-dev.notion.com",
    NOTION_WORKSPACE_ID: "ws_pnp_real_operator_workspace",
    NOTION_ENV: "dev",
    NOTION_BASE_URL: "https://api-dev.notion.com",
    NOTION_API_BASE_URL: "https://api-dev.notion.com",
    LORE_USER_NAME: "Real Operator",
  }

  // Probes that should never appear in committed PnP config:
  //   - `/Users/` catches macOS absolute paths (the configRoot we
  //     deliberately passed in) — the PnP shape ignores it.
  //   - `${HOME}` and `$HOME` catch the portability-rewritten shell
  //     marker (legitimate on the legacy absolute-path shape but
  //     illegitimate on PnP).
  //   - The two raw token strings catch a regression that
  //     interpolated values into the entry rather than emitting
  //     `${VAR}` placeholders. The operator env above is the only
  //     place these strings exist; finding them in serialized
  //     output means a real leak.
  //   - The dev base-URL value catches the same family of leak on
  //     the auth-base-url forwarder. The dev-env name `dev` is too
  //     short / too generic to probe for safely.
  //   - The workspace ID and display-name sentinels are operator
  //     identifiers; same byte-identity contract — finding either
  //     literal in committed config means a forwarder regressed
  //     and started emitting values instead of `${VAR}`.
  const FORBIDDEN_SUBSTRINGS = [
    "/Users/",
    "${HOME}",
    "$HOME",
    "secret_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfG",
    "secret_legacy_lore_token_must_not_leak_into_config",
    "https://api-dev.notion.com",
    "ws_pnp_real_operator_workspace",
    "Real Operator",
  ]

  for (const host of PNP_HOSTS) {
    it(`${host.name} PnP entry stays portable across the empty-env case`, () => {
      // No operator env vars set — the bare ntn-resolved-at-runtime
      // shape. Catches a regression that introduced a per-engineer
      // path into the always-emitted entry surface.
      const serialized = host.serialize(ENV_NONE)
      for (const probe of FORBIDDEN_SUBSTRINGS) {
        expect(serialized, `${host.name}: empty-env serialized output leaked ${probe}`).not.toContain(probe)
      }
    })

    it(`${host.name} PnP entry stays portable with the full real-operator env`, () => {
      // Every supported runtime forwarder set to a realistic
      // value. The serialized entry must carry `${VAR}`
      // placeholders, never the raw values.
      const serialized = host.serialize(REAL_OPERATOR_ENV)
      for (const probe of FORBIDDEN_SUBSTRINGS) {
        expect(serialized, `${host.name}: real-env serialized output leaked ${probe}`).not.toContain(probe)
      }
    })
  }

  it("PnP entries still emit ${VAR} placeholders for every runtime forwarder on every host", () => {
    // Inverse of the leak probes above: confirm each host actually
    // emits the placeholder names for every key in the forwarded
    // allowlist so the MCP-host substitution flow works at runtime.
    // Iterating `RUNTIME_FORWARDED_KEYS` (instead of hand-listing) is
    // the load-bearing piece — the next addition to the allowlist
    // automatically gets per-host placeholder coverage. Without this,
    // a regression that suppressed the entire env block would pass
    // the no-leak assertions trivially, and a regression that dropped
    // a single host's forwarder for one key would slip past a
    // hand-listed assertion that didn't enumerate the new key.
    const claude = buildClaudeMcpEntry("yarn", PROJECT_ABS_PATH, REAL_OPERATOR_ENV)
    const cursor = buildCursorMcpEntry("yarn", PROJECT_ABS_PATH, REAL_OPERATOR_ENV)
    const codex = buildCodexMcpSection("yarn", PROJECT_ABS_PATH, REAL_OPERATOR_ENV)

    for (const key of RUNTIME_FORWARDED_KEYS) {
      const placeholder = `\${${key}}`
      expect(claude.env[key], `claude PnP did not emit ${placeholder}`).toBe(placeholder)
      expect(cursor.env[key], `cursor PnP did not emit ${placeholder}`).toBe(placeholder)
      // Codex's env_vars is a name-only allowlist; the placeholder
      // form lives implicitly there. Probe each name as a quoted
      // literal so a future formatting refactor can't accidentally
      // emit it as a bare token.
      expect(codex, `codex PnP did not include "${key}" in env_vars`).toContain(`"${key}"`)
    }

    // Pin the full env_vars line shape to catch ordering regressions
    // — the per-key probe above would still pass if a refactor
    // shuffled the array.
    expect(codex).toContain('env_vars = ["NOTION_API_TOKEN", "LORE_NOTION_TOKEN", "LORE_NOTION_BASE_URL", "NOTION_WORKSPACE_ID", "NOTION_ENV", "NOTION_BASE_URL", "NOTION_API_BASE_URL", "LORE_USER_NAME"]')
  })
})

describe("detectYarnPnp — cwd-drift coverage", () => {
  // Followup #11 (makenotion/mail#25947): the install path runs from
  // wherever the operator invokes `lore install`, and Claude hooks
  // can fire after the assistant changes cwd mid-session. Detection
  // must walk upward from the supplied directory to find the
  // `.pnp.cjs` (or `.pnp.loader.mjs`) marker at the workspace root,
  // not just check the immediate directory. Without these tests, a
  // future refactor that drops the upward walk would still pass the
  // existing entry-builder tests and silently break Mail-style
  // monorepo consumers whose hooks fire from `services/<name>`
  // subdirectories.
  //
  // Fixtures use `node:os` `tmpdir()` so the walk doesn't traverse
  // the developer's home directory; the upward walk hits filesystem
  // root and returns false on the no-marker path, which is exactly
  // the production semantics for an outside-repo cwd.
  const SCRATCH = mkdtempSync(join(tmpdir(), "lore-pnp-detect-"))
  afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true })
  })

  it("detects PnP when the marker sits at the supplied repo root", async () => {
    const repo = mkdtempSync(join(SCRATCH, "repo-root-"))
    writeFileSync(join(repo, ".pnp.cjs"), "")
    expect(await detectYarnPnp(repo)).toBe(true)
  })

  it("detects PnP from a nested workspace cwd by walking upward to the marker", async () => {
    // Yarn 4 monorepo layout: `apps/web` is a workspace package.
    // The MCP host or hook may launch from this subdirectory; the
    // upward walk has to find the marker at the workspace root.
    const repo = mkdtempSync(join(SCRATCH, "nested-workspace-"))
    writeFileSync(join(repo, ".pnp.cjs"), "")
    const apps = join(repo, "apps", "web")
    mkdirSync(apps, { recursive: true })
    expect(await detectYarnPnp(apps)).toBe(true)
  })

  it("detects PnP from `services/mail` (Mail's specific layout)", async () => {
    // Mirrors the layout from `makenotion/mail#25947`. Hook-time
    // cwd lands here when the assistant changes directory during a
    // session, and the install path has to recognize the project as
    // PnP regardless of which subdirectory it was invoked from.
    const repo = mkdtempSync(join(SCRATCH, "services-mail-"))
    writeFileSync(join(repo, ".pnp.cjs"), "")
    const mail = join(repo, "services", "mail")
    mkdirSync(mail, { recursive: true })
    expect(await detectYarnPnp(mail)).toBe(true)
  })

  it("returns false for an outside-repo cwd with no marker on the upward path", async () => {
    // Confirms the walk does NOT classify every directory as PnP
    // just because the bounded walk-stop logic exists. Without this
    // test, a regression that returned `true` for any tmpdir-style
    // path would silently misroute every install onto the PnP
    // shape.
    const empty = mkdtempSync(join(SCRATCH, "outside-"))
    expect(await detectYarnPnp(empty)).toBe(false)
  })

  it("recognizes the `.pnp.loader.mjs` alternate marker spelling", async () => {
    // Some Yarn configurations emit `.pnp.loader.mjs` instead of
    // `.pnp.cjs` (or alongside it). The detector accepts either —
    // documented in the helper's docblock — so installs on those
    // configs land on the PnP shape just like `.pnp.cjs`-equipped
    // ones.
    const repo = mkdtempSync(join(SCRATCH, "loader-marker-"))
    writeFileSync(join(repo, ".pnp.loader.mjs"), "")
    expect(await detectYarnPnp(repo)).toBe(true)
  })
})

describe("prepareInstallContext — threads --project through to runner-bound yarnPnp", () => {
  // Followup #11 (makenotion/mail#25947): Mail invokes
  // `yarn run -T lore install -y` from arbitrary cwds, frequently a
  // workspace package's directory rather than the repo root. The seam
  // that has to hold end-to-end:
  //
  //   --project <repo>/services/mail
  //     → projectDir = <abs path>/services/mail
  //     → detectYarnPnp(projectDir) walks upward
  //     → context.yarnPnp = true (because .pnp.cjs sits at <repo>)
  //     → every per-client runner sees shape: "yarn"
  //
  // detectYarnPnp's upward walk is unit-tested above and the
  // runner-level honoring of yarnPnp:true is integration-tested in
  // runCursorInstall, but nothing pinned the threading from
  // --project through prepareInstallContext into the runner-bound
  // context. A regression that, say, forwarded process.cwd() into
  // detectYarnPnp instead of opts.project would slip past every
  // existing test.
  const SCRATCH = mkdtempSync(join(tmpdir(), "lore-prepare-ctx-"))
  afterAll(() => {
    rmSync(SCRATCH, { recursive: true, force: true })
  })

  it("auto-detects yarnPnp when --project lands in a nested workspace package and the marker sits at the repo root", async () => {
    // Mail's specific layout: hooks fire / install runs from
    // `services/mail`. The function must locate the marker by
    // walking upward, not by checking only the supplied directory.
    const repo = mkdtempSync(join(SCRATCH, "mail-monorepo-"))
    writeFileSync(join(repo, ".pnp.cjs"), "")
    const mail = join(repo, "services", "mail")
    mkdirSync(mail, { recursive: true })

    const ctx = await prepareInstallContext({ project: mail, yes: true })

    expect(ctx.projectDir).toBe(mail)
    expect(ctx.yarnPnp).toBe(true)
    expect(ctx.legacyPaths).toBe(false)
  })

  it("returns yarnPnp:false when --project lands outside any PnP repo", async () => {
    // Outside-repo cwds (and projects not using PnP at all) must
    // route to the bare bin-dispatch shape. A regression that
    // misclassified non-PnP projects as PnP would wedge installs
    // for every consumer that uses npm or Yarn 1.
    const project = mkdtempSync(join(SCRATCH, "non-pnp-"))

    const ctx = await prepareInstallContext({ project, yes: true })

    expect(ctx.projectDir).toBe(project)
    expect(ctx.yarnPnp).toBe(false)
  })

  it("--no-yarn-pnp (explicit yarnPnp:false) overrides auto-detection", async () => {
    // Operator escape hatch: a PnP project that has fixed bin
    // resolution out-of-band (custom .yarnrc.yml, vendored
    // node_modules/.bin shim) can pin the bare shape without
    // ripping out .pnp.cjs. The marker is present but the
    // explicit override wins per the field's documented priority.
    const repo = mkdtempSync(join(SCRATCH, "pnp-with-override-"))
    writeFileSync(join(repo, ".pnp.cjs"), "")

    const ctx = await prepareInstallContext({
      project: repo,
      yes: true,
      yarnPnp: false,
    })

    expect(ctx.yarnPnp).toBe(false)
  })

  it("--yarn-pnp (explicit yarnPnp:true) overrides absence of a marker", async () => {
    // Symmetric escape hatch: an operator pinning the PnP shape on
    // a project that lacks the marker (e.g., the marker lives in a
    // sibling workspace and detection's upward-only walk misses
    // it). The explicit true wins regardless of detection.
    const project = mkdtempSync(join(SCRATCH, "force-pnp-"))

    const ctx = await prepareInstallContext({
      project,
      yes: true,
      yarnPnp: true,
    })

    expect(ctx.yarnPnp).toBe(true)
  })

  it("legacyPaths:true forces yarnPnp:false even when a marker is present", async () => {
    // The legacy absolute-path shape doesn't depend on PATH
    // resolution at all (it invokes node against an absolute
    // mcp.js path), so the PnP question is moot. The field's
    // priority rule pins `legacyPaths` ahead of every other
    // signal — pinning it here keeps a future refactor from
    // accidentally lifting the legacy override.
    const repo = mkdtempSync(join(SCRATCH, "legacy-with-marker-"))
    writeFileSync(join(repo, ".pnp.cjs"), "")

    const ctx = await prepareInstallContext({
      project: repo,
      yes: true,
      legacyPaths: true,
    })

    expect(ctx.legacyPaths).toBe(true)
    expect(ctx.yarnPnp).toBe(false)
  })
})

describe("Claude hook detection — recognizes prior-shape entries as stale", () => {
  // An upgrade from a pre-`cd` install (or pre-`yarn run -T` PnP
  // install) must classify the existing entry as `stale` so the
  // install summary surfaces "update available" before the upsert
  // strips and rewrites it. Without explicit recognition, the older
  // entry would classify as `missing` even though the upsert path
  // would still strip it — a misleading status display.

  it("classifies pre-`cd` bare-bin entry as stale", () => {
    const entries = [
      { matcher: "", hooks: [{ type: "command", command: "lore hooks autosave" }] },
    ]
    const newCommand = buildClaudeHookCommand("autosave")
    expect(detectClaudeHook(entries, "autosave.sh", "/no/legacy/path", newCommand)).toBe(
      "stale",
    )
  })

  it("classifies pre-`cd` yarn-PnP bin entry (`yarn lore hooks ...`) as stale", () => {
    const entries = [
      { matcher: "", hooks: [{ type: "command", command: "yarn lore hooks autosave" }] },
    ]
    const newCommand = buildClaudeHookCommand("autosave", "yarn")
    expect(detectClaudeHook(entries, "autosave.sh", "/no/legacy/path", newCommand)).toBe(
      "stale",
    )
  })

  it("classifies cd-anchored but pre-`run -T` yarn entry as stale (mixed-state upgrade)", () => {
    // An operator who landed on the `cd` wrapper before `run -T`
    // shipped (or a hand-edit). Recognized as stale so the
    // canonical-shape rewrite catches them.
    const entries = [
      {
        matcher: "",
        hooks: [
          {
            type: "command",
            command: `cd "$CLAUDE_PROJECT_DIR" && yarn lore hooks autosave`,
          },
        ],
      },
    ]
    const newCommand = buildClaudeHookCommand("autosave", "yarn")
    expect(detectClaudeHook(entries, "autosave.sh", "/no/legacy/path", newCommand)).toBe(
      "stale",
    )
  })

  it("classifies the canonical current shape as `current`", () => {
    const newCommand = buildClaudeHookCommand("autosave")
    const entries = [
      { matcher: "", hooks: [{ type: "command", command: newCommand }] },
    ]
    expect(detectClaudeHook(entries, "autosave.sh", "/no/legacy/path", newCommand)).toBe(
      "current",
    )
  })
})

describe("Codex hook detection — recognizes prior-shape entries as stale", () => {
  // Symmetric to the Claude detection: pre-`run -T` Codex bin-dispatch
  // hooks (with the LORE_AGENT_NAME=Codex env prefix) classify as
  // stale so reinstall upgrades them. Codex hooks DON'T carry the
  // `cd` anchor — Codex's runner exposes project cwd directly.

  it("classifies pre-`run -T` Codex bin entry as stale", () => {
    const entries = [
      {
        hooks: [
          {
            type: "command" as const,
            command: "LORE_AGENT_NAME=Codex yarn lore hooks autosave",
          },
        ],
      },
    ]
    const newCommand = buildCodexHookCommand("autosave", "yarn")
    expect(detectCodexHook(entries, "autosave.sh", "/no/legacy", newCommand)).toBe(
      "stale",
    )
  })

  it("classifies the canonical current shape (`yarn run -T`) as current", () => {
    const newCommand = buildCodexHookCommand("autosave", "yarn")
    const entries = [
      { hooks: [{ type: "command" as const, command: newCommand }] },
    ]
    expect(detectCodexHook(entries, "autosave.sh", "/no/legacy", newCommand)).toBe(
      "current",
    )
  })
})

describe("dev-environment MCP entries", () => {
  // Each MCP-entry builder must surface the ntn-native env selectors
  // (NOTION_ENV / NOTION_BASE_URL / NOTION_API_BASE_URL) into committed
  // config so a dev / staging operator's MCP child resolves the same
  // Notion environment the install-time preflight verified against.

  const DEV_ENV: NodeJS.ProcessEnv = {
    NOTION_ENV: "dev",
    NOTION_BASE_URL: "https://api-dev.notion.com",
  }

  it("Claude MCP entry forwards ntn-native dev selectors", () => {
    const entry = buildClaudeMcpEntry("bare", TEST_CONFIG_ROOT, DEV_ENV)
    expect(entry.env["NOTION_ENV"]).toBe("${NOTION_ENV}")
    expect(entry.env["NOTION_BASE_URL"]).toBe("${NOTION_BASE_URL}")
    // Static pair still present.
    expect(entry.env["LORE_CONFIG_ROOT"]).toBe(TEST_CONFIG_ROOT)
  })

  it("Cursor MCP entry forwards ntn-native dev selectors (matches Claude shape)", () => {
    const entry = buildCursorMcpEntry("bare", TEST_CONFIG_ROOT, DEV_ENV)
    expect(entry.env["NOTION_ENV"]).toBe("${NOTION_ENV}")
    expect(entry.env["NOTION_BASE_URL"]).toBe("${NOTION_BASE_URL}")
  })

  it("Codex bin-dispatch TOML lists ntn-native dev selectors in env_vars", () => {
    // Codex's env_vars carries name-only references. Order matches
    // RUNTIME_FORWARDED_KEYS so a downstream toml parser sees a
    // deterministic shape.
    const section = buildCodexMcpSection("bare", TEST_CONFIG_ROOT, DEV_ENV)
    expect(section).toContain('env_vars = ["NOTION_ENV", "NOTION_BASE_URL"]')
  })

  it("Codex legacy TOML lists ntn-native dev selectors in env_vars", () => {
    // Same env_vars contract on the legacy path — the bash-prefix
    // shape doesn't change which env vars get name-referenced.
    const section = buildLegacyCodexMcpSection(
      "/opt/lore/dist/mcp.js",
      TEST_CONFIG_ROOT,
      DEV_ENV,
    )
    expect(section).toContain('env_vars = ["NOTION_ENV", "NOTION_BASE_URL"]')
  })

  it("--print-config json emits ntn-native dev selectors as ${VAR} placeholders", () => {
    const output = buildPrintConfigOutput(
      "json",
      "/lore/dist/mcp.js",
      "/lore",
      TEST_CONFIG_ROOT,
      false,
      "bare",
      DEV_ENV,
    )
    const parsed = JSON.parse(output) as {
      mcpServers: { lore: { env: Record<string, string> } }
    }
    expect(parsed.mcpServers.lore.env["NOTION_ENV"]).toBe("${NOTION_ENV}")
    expect(parsed.mcpServers.lore.env["NOTION_BASE_URL"]).toBe("${NOTION_BASE_URL}")
  })

  it("--print-config toml lists ntn-native dev selectors in env_vars", () => {
    const output = buildPrintConfigOutput(
      "toml",
      "/lore/dist/mcp.js",
      "/lore",
      TEST_CONFIG_ROOT,
      false,
      "bare",
      DEV_ENV,
    )
    expect(output).toContain('env_vars = ["NOTION_ENV", "NOTION_BASE_URL"]')
  })

  it("prod default is unchanged when the operator has no ntn env vars set", () => {
    // Acceptance criterion: "The default prod path should stay
    // unchanged." A fresh install with no NOTION_ENV / NOTION_BASE_URL
    // / NOTION_API_BASE_URL produces an MCP entry with only the
    // existing static pair (and no token forwarding).
    const entry = buildClaudeMcpEntry("bare", TEST_CONFIG_ROOT, ENV_NONE)
    expect(entry.env).toEqual(STATIC_ENV_FOR_TEST_CONFIG_ROOT)
  })
})

// `ensurePrerequisites` tests live in `install-prereqs.test.ts` —
// that file mocks the auth / oauth / config modules at the module
// boundary, which would interfere with the rest of this file's
// fixtures (entry builders, dispatch orchestration). Splitting keeps
// each suite focused.

describe("ntnLoginRecovery — paste-ready recovery command", () => {
  // The single source of truth for "what ntn-login command should
  // we tell the operator to run for THIS project + THIS shell?".
  // Used by both the offer-login skip path and the preflight-failure
  // recovery copy. Pure function; no auth state, no I/O.

  it("includes NOTION_KEYRING=0 unconditionally (Lore can't read keychain auth)", () => {
    // The keychain prefix is load-bearing on every emitted command —
    // without it, ntn defaults to keychain mode on darwin and the
    // resulting token lands somewhere Lore can't read.
    expect(ntnLoginRecovery(undefined, {}).command).toMatch(/^NOTION_KEYRING=0 /)
    expect(
      ntnLoginRecovery({ vault: { pageId: "x" } } as never, {}).command,
    ).toMatch(/^NOTION_KEYRING=0 /)
    expect(
      ntnLoginRecovery({ vault: { pageId: "x" } } as never, { NOTION_ENV: "dev" })
        .command,
    ).toMatch(/^NOTION_KEYRING=0 /)
  })

  it("uses operator's NOTION_ENV verbatim when set (highest priority)", () => {
    const result = ntnLoginRecovery(
      { vault: { pageId: "x" }, auth: { baseUrl: "https://api.notion.so" } } as never,
      { NOTION_ENV: "dev" },
    )
    expect(result.command).toBe("NOTION_KEYRING=0 NOTION_ENV=dev ntn login")
    // Operator-explicit case has no manualEnvNote — they know their
    // own intent; no inference to surface.
    expect(result.manualEnvNote).toBeUndefined()
  })

  it("infers env from .lore.yaml auth.baseUrl=https://api-dev.notion.com", () => {
    const result = ntnLoginRecovery(
      { vault: { pageId: "x" }, auth: { baseUrl: "https://api-dev.notion.com" } } as never,
      {},
    )
    expect(result.command).toBe("NOTION_KEYRING=0 NOTION_ENV=dev ntn login")
    expect(result.manualEnvNote).toBe(
      "(dev env inferred from .lore.yaml auth.baseUrl)",
    )
  })

  it("infers env=stg from canonical staging URL", () => {
    const result = ntnLoginRecovery(
      { vault: { pageId: "x" }, auth: { baseUrl: "https://api-stg.notion.com" } } as never,
      {},
    )
    expect(result.command).toBe("NOTION_KEYRING=0 NOTION_ENV=stg ntn login")
  })

  it("emits NOTION_ENV=<env> placeholder for non-canonical baseUrl with manualEnvNote", () => {
    const result = ntnLoginRecovery(
      {
        vault: { pageId: "x" },
        auth: { baseUrl: "https://my-corporate-proxy.example" },
      } as never,
      {},
    )
    expect(result.command).toBe("NOTION_KEYRING=0 NOTION_ENV=<env> ntn login")
    expect(result.manualEnvNote).toMatch(
      /doesn't match a canonical ntn env[\s\S]*substitute <env>/,
    )
  })

  it("falls through to bare prod-default when no signals are present", () => {
    expect(ntnLoginRecovery(undefined, {}).command).toBe("NOTION_KEYRING=0 ntn login")
    expect(
      ntnLoginRecovery({ vault: { pageId: "x" } } as never, {}).command,
    ).toBe("NOTION_KEYRING=0 ntn login")
  })

  it("operator NOTION_ENV beats config inference even when both signals exist", () => {
    // Pinning the priority chain: explicit operator choice always
    // wins. Matches `runNtnLogin` env-derivation semantics in
    // `ensurePrerequisites`.
    const result = ntnLoginRecovery(
      { vault: { pageId: "x" }, auth: { baseUrl: "https://api-dev.notion.com" } } as never,
      { NOTION_ENV: "stg" },
    )
    expect(result.command).toBe("NOTION_KEYRING=0 NOTION_ENV=stg ntn login")
  })
})
