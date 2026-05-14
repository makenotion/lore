/**
 * Tests for `lore init`'s pure config-emit helper, the workspace-level
 * page-create helper, and the two top-level orchestrators
 * (`runExplicitPageInit`, `runNoArgInit`). The orchestrator tests heavily
 * mock the auth + Notion + ntn boundaries — `runNoArgInit` chains
 * resolveAuth → ntn helpers (interactive recovery) → pages.create →
 * verifyVaultAccess → vault.init() → writeFile, and we want to pin each
 * branch's behavior without a network round-trip.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { parse as yamlParse } from "yaml"

// Mock the auth + Notion boundaries BEFORE importing the SUT so the
// SUT's top-level imports bind to the mocked surfaces. Each module
// exports the same names the SUT uses; tests reach in via vi.mocked()
// to control behavior per-case.
vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>()
  return {
    ...actual,
    resolveAuth: vi.fn(),
  }
})
vi.mock("../../auth/oauth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/oauth.js")>()
  return {
    ...actual,
    verifyVaultAccess: vi.fn(),
  }
})
vi.mock("../../auth/ntn.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../auth/ntn.js")>()
  return {
    ...actual,
    isNtnInstalled: vi.fn(),
    installNtn: vi.fn(),
    listNtnWorkspaces: vi.fn(),
    runNtnLogin: vi.fn(),
  }
})
vi.mock("../../notion/client.js", () => ({
  createClient: vi.fn(() => ({}) as object),
}))
vi.mock("../../notion/rate-limit.js", () => ({
  createLimitedClient: vi.fn((c: unknown) => c),
}))
vi.mock("../../core/vault.js", () => ({
  VaultManager: vi.fn(),
}))
// `confirmPrompt` lives in its own module so we can intercept the
// declined-prompt branches without piping into real stdin. The default
// returns `true` (accept) — individual tests override per-case.
vi.mock("./init-prompt.js", () => ({
  confirmPrompt: vi.fn(),
}))

import {
  authBaseUrlMatchesEnv,
  buildHookDisclosureLines,
  buildInitConfigYaml,
  createWorkspaceLevelPage,
  defaultVaultTitle,
  runExplicitPageInit,
  runNoArgInit,
} from "./init.js"
import { resolveAuth } from "../../config.js"
import { verifyVaultAccess } from "../../auth/oauth.js"
import {
  installNtn,
  isNtnInstalled,
  listNtnWorkspaces,
  runNtnLogin,
} from "../../auth/ntn.js"
import { VaultManager } from "../../core/vault.js"
import { defaultProfileSelector } from "../../profile/index.js"
import { confirmPrompt } from "./init-prompt.js"

describe("buildInitConfigYaml", () => {
  it("emits a parseable YAML document with the expected top-level shape", () => {
    const text = buildInitConfigYaml("abc123")
    const parsed = yamlParse(text)
    expect(parsed).toEqual({
      vault: { pageId: "abc123" },
      profile: defaultProfileSelector(),
      projects: [],
      hooks: {
        autoSave: true,
        wakeUp: true,
        saveInterval: 5,
      },
    })
  })

  it("includes the learningExtraction commented-default line under hooks: (0.9.0/08)", () => {
    const text = buildInitConfigYaml("abc123")
    // Pin the exact line so the indentation, comment marker, and 0.9.0/08
    // attribution can't drift silently. Two-space indent matches the
    // hooks block; the leading `#` is what hides the line from the YAML
    // parser. The trailing `\n` is part of the line.
    expect(text).toContain(
      "  # learningExtraction: true  # 0.9.0/08 — autosave atomic-learning extraction\n"
    )
  })

  it("includes the proposeAutosaveLearnings commented-default line under hooks: (issue #281)", () => {
    // Pinned alongside `learningExtraction` so a fresh install
    // advertises the inbox-routing opt-in. Default-`false` so the
    // line stays commented and doesn't change autosave behavior.
    const text = buildInitConfigYaml("abc123")
    expect(text).toContain(
      "  # proposeAutosaveLearnings: false  # issue #281 — route auto-extracted learnings through the proposed-memory review inbox"
    )
  })

  it("places both commented-default lines AFTER the saveInterval entry inside hooks", () => {
    // Order is contract: an operator scanning the hooks: block reads
    // the active settings first, then the commented opt-outs. Snapshotting
    // the slice from `hooks:` to the comments defends against a future
    // reordering that would land the comments above the active fields.
    const text = buildInitConfigYaml("abc123")
    const hooksIdx = text.indexOf("hooks:")
    const saveIntervalIdx = text.indexOf("saveInterval: 5")
    const commentIdx = text.indexOf("# learningExtraction:")
    const proposeIdx = text.indexOf("# proposeAutosaveLearnings:")
    expect(hooksIdx).toBeGreaterThan(-1)
    expect(saveIntervalIdx).toBeGreaterThan(hooksIdx)
    expect(commentIdx).toBeGreaterThan(saveIntervalIdx)
    expect(proposeIdx).toBeGreaterThan(commentIdx)
  })

  it("emits a YAML document whose comment-stripped re-parse matches the typed shape", () => {
    // Defense against a future yaml-lib upgrade that changes how
    // `YAMLMap.comment` renders: if either commented line somehow
    // leaked into the active config (e.g. wrong escape, missing `#`),
    // `yamlParse` would either throw or return an extra
    // `learningExtraction` / `proposeAutosaveLearnings` key. Both
    // would fail this assertion.
    const text = buildInitConfigYaml("abc123")
    const parsed = yamlParse(text) as { hooks: Record<string, unknown> }
    expect(parsed.hooks).not.toHaveProperty("learningExtraction")
    expect(parsed.hooks).not.toHaveProperty("proposeAutosaveLearnings")
    expect(Object.keys(parsed.hooks).sort()).toEqual([
      "autoSave",
      "saveInterval",
      "wakeUp",
    ])
  })

  it("includes the issue #560 hook-disclosure block ABOVE the hooks: key", () => {
    // Acceptance criteria for issue #560: the generated config carries
    // an explanatory comment block immediately above `hooks:` so an
    // operator who skims the YAML without reading docs/hooks.md still
    // sees that the default-enabled background hooks write to / read
    // from their own Notion vault, and how to opt out.
    //
    // Pin a substring from each load-bearing fragment of the block
    // rather than the full string: yaml-lib renders `commentBefore`
    // with a leading `#` per line; the prose can evolve, but each
    // signal (privacy framing, descriptions of every default-true
    // hook, the disable-knob name, the docs reference) must remain
    // present.
    const text = buildInitConfigYaml("abc123")
    const hooksIdx = text.indexOf("hooks:")
    expect(hooksIdx).toBeGreaterThan(-1)
    const above = text.slice(0, hooksIdx)
    expect(above).toContain("# Background hooks (issue #560 disclosure)")
    // PR #567 round-2 review: privacy claim is honest about the
    // background-agent LLM hop; the earlier "nothing leaves your
    // account" copy elided the autosave transcript send to whichever
    // model the operator has wired in.
    expect(above).toContain("Writes land in your Notion vault")
    expect(above).toContain("background-agent LLM")
    // All four default-true hooks named, not just autoSave/wakeUp.
    expect(above).toContain("autoSave")
    expect(above).toContain("wakeUp")
    expect(above).toContain("autoDigest")
    expect(above).toContain("learningExtraction")
    expect(above).toContain("saveInterval")
    // PR #567 review: the disable hint must name the boolean knobs
    // by name and explicitly call out that saveInterval is numeric.
    // The earlier "Set any value below to `false`" wording would have
    // misled an operator into typing `saveInterval: false`, which
    // trips `parseConfigAllowingInvalidHooks` into dropping the
    // entire hooks section and silently re-enabling the defaults.
    expect(above).toContain("hooks.autoSave: false")
    expect(above).toContain("hooks.wakeUp: false")
    expect(above).toContain("hooks.autoDigest: false")
    expect(above).toContain("hooks.learningExtraction: false")
    // PR #567 round-2 concern #2: env kill switches are the natural
    // one-session opt-out and must be discoverable from the
    // disclosure copy itself.
    expect(above).toContain("LORE_AUTOSAVE=false")
    expect(above).toContain("LORE_AUTO_DIGEST=false")
    expect(above).toContain("LORE_DISABLE_LEARNING_EXTRACTION=1")
    expect(above).toContain("docs/hooks.md")
  })

  it("disclosure block disable hint is scoped to boolean knobs only (PR #567 review)", () => {
    // Positive-shape replacement for the previous absence-only guard
    // (round-2 nit #3): instead of asserting the broken
    // "Set any value below to `false`" string is absent, assert the
    // disable hint structurally — extract the sentence after
    // "Disable in .lore.yaml" and confirm it lists each boolean knob
    // exactly once and never names `saveInterval`. A future copy
    // edit that uses synonyms like "any of the values" or "the
    // settings below" still fails this test loudly.
    const text = buildInitConfigYaml("abc123")
    const hooksIdx = text.indexOf("hooks:")
    const above = text.slice(0, hooksIdx)
    const match = above.match(/Disable in \.lore\.yaml with any of: ([^\n]+)/)
    expect(match).not.toBeNull()
    if (!match) throw new Error("disable-hint sentence not found")
    const hintBody = match[1]
    expect(hintBody).toContain("hooks.autoSave: false")
    expect(hintBody).toContain("hooks.wakeUp: false")
    expect(hintBody).toContain("hooks.autoDigest: false")
    expect(hintBody).toContain("hooks.learningExtraction: false")
    // saveInterval is a number in the schema; the disable hint must
    // not name it, no matter how the wording evolves.
    expect(hintBody).not.toContain("saveInterval")
  })

  it("disclosure block does not contaminate the parsed YAML shape", () => {
    // Defense against a future yaml-lib upgrade or a typo (missing
    // leading space, broken commentBefore semantics) that would let
    // the disclosure text leak into the active config as top-level
    // keys. The block is comments only — `yamlParse` must return
    // the same minimal shape with no extra keys.
    const text = buildInitConfigYaml("abc123")
    const parsed = yamlParse(text)
    expect(parsed).toEqual({
      vault: { pageId: "abc123" },
      profile: defaultProfileSelector(),
      projects: [],
      hooks: {
        autoSave: true,
        wakeUp: true,
        saveInterval: 5,
      },
    })
  })

  it("omits the auth: block when no workspaceId is provided (single-workspace operators)", () => {
    const text = buildInitConfigYaml("abc123")
    const parsed = yamlParse(text) as Record<string, unknown>
    expect(parsed).not.toHaveProperty("auth")
  })

  it("writes auth.workspaceId when the resolved auth carries one (multi-workspace ntn-source)", () => {
    const text = buildInitConfigYaml("abc123", "ws-team-engineering")
    const parsed = yamlParse(text) as { auth: { workspaceId: string } }
    expect(parsed.auth).toEqual({ workspaceId: "ws-team-engineering" })
    // The rest of the shape is unchanged.
    expect(parsed).toMatchObject({
      vault: { pageId: "abc123" },
      profile: defaultProfileSelector(),
      auth: { workspaceId: "ws-team-engineering" },
      projects: [],
      hooks: {
        autoSave: true,
        wakeUp: true,
        saveInterval: 5,
      },
    })
  })

  it("writes an explicit non-default profile selector when provided", () => {
    const text = buildInitConfigYaml("abc123", undefined, "support@1.0.0")
    const parsed = yamlParse(text)

    expect(parsed).toMatchObject({
      vault: { pageId: "abc123" },
      profile: "support@1.0.0",
    })
  })
})

describe("buildHookDisclosureLines", () => {
  // Issue #560 disclosure helper. `lore init` and `lore install
  // --client {claude,codex}` all print the returned lines verbatim
  // (PR #567 round-2 review #2 added the install-time surface), so
  // the wording lives in `src/cli/hook-disclosure.ts` as the single
  // source of truth. These assertions pin the load-bearing signals
  // so a future copy edit doesn't quietly drop the privacy framing,
  // a default-true hook, or the env-override list.
  it("returns a non-empty array of lines", () => {
    const lines = buildHookDisclosureLines()
    expect(Array.isArray(lines)).toBe(true)
    expect(lines.length).toBeGreaterThan(0)
  })

  it("mentions every default-true hook by name (PR #567 round-2 blocker #1)", () => {
    // Round-1 only named autoSave + wakeUp. Round-2 review pointed
    // out `mergeHookDefaults` defaults FOUR hooks to true; the
    // disclosure must surface all of them or it lies about the
    // actual side-effect set.
    const joined = buildHookDisclosureLines().join("\n")
    expect(joined).toContain("autoSave")
    expect(joined).toContain("wakeUp")
    expect(joined).toContain("autoDigest")
    expect(joined).toContain("learningExtraction")
  })

  it("names the exact .lore.yaml knobs an operator types to disable", () => {
    // Discoverability is the whole point of the disclosure — print
    // the literal config keys, not paraphrases. A future edit that
    // says "in your config" instead of `hooks.autoSave: false` fails
    // this test loudly.
    const joined = buildHookDisclosureLines().join("\n")
    expect(joined).toContain("hooks.autoSave: false")
    expect(joined).toContain("hooks.wakeUp: false")
    expect(joined).toContain("hooks.autoDigest: false")
    expect(joined).toContain("hooks.learningExtraction: false")
  })

  it("names the per-session env-var overrides (PR #567 round-2 concern #2)", () => {
    // The env knobs are the natural answer to "I want autosave off
    // for this one session without touching .lore.yaml." Operators
    // never discover them if the disclosure copy itself doesn't
    // mention them.
    const joined = buildHookDisclosureLines().join("\n")
    expect(joined).toContain("LORE_AUTOSAVE=false")
    expect(joined).toContain("LORE_AUTO_DIGEST=false")
    expect(joined).toContain("LORE_DISABLE_LEARNING_EXTRACTION=1")
  })

  it("uses an accurate privacy framing (PR #567 round-2 concern #4)", () => {
    // Round-1 said "nothing leaves your account" — true for the
    // Memory-row writes but misleading about the autosave / learning-
    // extraction transcript send to the configured background-agent
    // LLM. Round-2 wording is structurally honest: writes land in
    // Notion; transcript goes to the configured LLM.
    const joined = buildHookDisclosureLines().join("\n")
    expect(joined).toContain("Writes land in your Notion vault")
    expect(joined).toContain("background-agent LLM")
    expect(joined).not.toContain("nothing leaves your account")
  })

  it("uses ASCII bullets only (PR #567 round-2 nit #1)", () => {
    // Round-1 used `•` which mojibakes on legacy Windows consoles.
    // The CLI does run on Windows even though the hook runner is
    // POSIX-only, so the install-time output needs to render
    // cleanly on cmd.exe / PowerShell.
    const joined = buildHookDisclosureLines().join("\n")
    expect(joined).not.toContain("•")
  })

  it("points operators at the docs/hooks.md reference", () => {
    const joined = buildHookDisclosureLines().join("\n")
    expect(joined).toContain("docs/hooks.md")
  })
})

describe("createWorkspaceLevelPage", () => {
  it("calls pages.create with the workspace-parent shape and the supplied title", async () => {
    const create = vi.fn(async () => ({ id: "page-1" }))
    const client = { pages: { create } } as unknown as Parameters<
      typeof createWorkspaceLevelPage
    >[0]
    const result = await createWorkspaceLevelPage(client, "Lore Vault — widget")
    expect(result).toEqual({ id: "page-1" })
    // Pin the runtime payload — Notion's REST docs explicitly support
    // `{ type: "workspace", workspace: true }` and the SDK type-cast in
    // the source acknowledges this is the documented shape. A future SDK
    // upgrade that renames the discriminant would silently break the
    // payload; this assertion catches that drift.
    expect(create).toHaveBeenCalledTimes(1)
    expect(create).toHaveBeenCalledWith({
      parent: { type: "workspace", workspace: true },
      properties: {
        title: {
          title: [{ type: "text", text: { content: "Lore Vault — widget" } }],
        },
      },
    })
  })
})

describe("defaultVaultTitle", () => {
  it("derives the page title from the cwd basename so multi-vault workspaces stay distinguishable", () => {
    expect(defaultVaultTitle("/Users/me/Developer/widget")).toBe("Lore Vault — widget")
    expect(defaultVaultTitle("/Users/me/Developer/my-cool-repo")).toBe(
      "Lore Vault — my-cool-repo"
    )
  })

  it("falls back to the bare 'Lore Vault' string when basename is empty (filesystem root)", () => {
    // basename("/") is "" on POSIX; defaultVaultTitle should not produce
    // the malformed "Lore Vault — " (em-dash + trailing whitespace).
    expect(defaultVaultTitle("/")).toBe("Lore Vault")
  })
})

describe("authBaseUrlMatchesEnv", () => {
  // The pure half of round-5's env-mismatch gate. Pinned table-style
  // because the matrix is small and the equality rules are
  // load-bearing — any future drift would silently demote the gate
  // from "fail-fast on env mismatch" to "let mismatched calls
  // through."
  it("treats undefined baseUrl as prod (the SDK default)", () => {
    expect(authBaseUrlMatchesEnv(undefined, "prod")).toBe(true)
    expect(authBaseUrlMatchesEnv(undefined, "dev")).toBe(false)
    expect(authBaseUrlMatchesEnv(undefined, "stg")).toBe(false)
  })

  it("treats explicit api.notion.so as prod (handles a future resolveNtnBaseUrl change)", () => {
    expect(authBaseUrlMatchesEnv("https://api.notion.so", "prod")).toBe(true)
    expect(authBaseUrlMatchesEnv("https://api.notion.so", "dev")).toBe(false)
    expect(authBaseUrlMatchesEnv("https://api.notion.so", "stg")).toBe(false)
  })

  it("treats the `.com` prod alias as prod (Notion is migrating `.so` → `.com`)", () => {
    // Consolidation pin: `authBaseUrlMatchesEnv` delegates to
    // `oauth.ts:ntnEnvFromBaseUrl`, which recognizes both
    // `https://api.notion.so` and `https://api.notion.com` as prod.
    // Without this, a `.lore.yaml` carrying the `.com` form would fail
    // the env-mismatch gate even when the operator's intent matched.
    expect(authBaseUrlMatchesEnv("https://api.notion.com", "prod")).toBe(true)
    expect(authBaseUrlMatchesEnv("https://api.notion.com", "dev")).toBe(false)
    expect(authBaseUrlMatchesEnv("https://api.notion.com", "stg")).toBe(false)
  })

  it("matches dev baseUrl strictly to the dev env", () => {
    expect(authBaseUrlMatchesEnv("https://api-dev.notion.com", "dev")).toBe(true)
    expect(authBaseUrlMatchesEnv("https://api-dev.notion.com", "prod")).toBe(false)
    expect(authBaseUrlMatchesEnv("https://api-dev.notion.com", "stg")).toBe(false)
  })

  it("matches stg baseUrl strictly to the stg env", () => {
    expect(authBaseUrlMatchesEnv("https://api-stg.notion.com", "stg")).toBe(true)
    expect(authBaseUrlMatchesEnv("https://api-stg.notion.com", "prod")).toBe(false)
    expect(authBaseUrlMatchesEnv("https://api-stg.notion.com", "dev")).toBe(false)
  })

  it("treats unknown baseUrls as a mismatch against any specific env", () => {
    // E.g., operator set LORE_NOTION_BASE_URL to a self-hosted proxy
    // or a typo'd URL — the gate refuses to claim a match it can't
    // structurally guarantee.
    expect(authBaseUrlMatchesEnv("https://attacker.example", "prod")).toBe(false)
    expect(authBaseUrlMatchesEnv("https://attacker.example", "dev")).toBe(false)
    expect(authBaseUrlMatchesEnv("https://attacker.example", "stg")).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// runNoArgInit / runExplicitPageInit orchestrator tests
// ---------------------------------------------------------------------------

const SCRATCH = mkdtempSync(join(tmpdir(), "lore-init-test-"))

afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

interface TestVaultResult {
  databases: Record<
    "projects" | "topics" | "memories" | "entities" | "facts",
    { databaseId: string; dataSourceId: string }
  >
}

/**
 * Spy on `process.exit` so the orchestrator's `process.exit(1)` calls
 * surface as a thrown sentinel instead of tearing down the test
 * runner. Returns a getter for the exit code captured by the most
 * recent throw.
 */
function trapProcessExit(): { lastCode: () => number | undefined } {
  let captured: number | undefined
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    captured = code
    throw new ProcessExitSentinel(code)
  }) as never)
  return { lastCode: () => captured }
}

class ProcessExitSentinel extends Error {
  constructor(public code: number | undefined) {
    super(`process.exit(${code})`)
  }
}

/**
 * Each orchestrator test runs in an isolated tmpdir so a stale
 * `.lore.yaml` from one case doesn't poison the next, and so the
 * "writes config" assertion can read the file back with a stable path.
 */
function setupTestCwd(): string {
  const cwd = mkdtempSync(join(SCRATCH, "cwd-"))
  vi.spyOn(process, "cwd").mockReturnValue(cwd)
  return cwd
}

function mockVaultInitSuccess(): TestVaultResult {
  const result: TestVaultResult = {
    databases: {
      projects: { databaseId: "db-projects", dataSourceId: "ds-projects" },
      topics: { databaseId: "db-topics", dataSourceId: "ds-topics" },
      memories: { databaseId: "db-memories", dataSourceId: "ds-memories" },
      // PF3-01: every fresh init creates the Entities DB. Fixture
      // mirrors the production shape so the success-log render asserts
      // realistic output.
      entities: { databaseId: "db-entities", dataSourceId: "ds-entities" },
      facts: { databaseId: "db-facts", dataSourceId: "ds-facts" },
    },
  }
  vi.mocked(VaultManager).mockImplementation(
    () =>
      ({
        init: vi.fn().mockResolvedValue(result),
      }) as unknown as InstanceType<typeof VaultManager>
  )
  return result
}

function mockVaultInitThrow(err: Error): void {
  vi.mocked(VaultManager).mockImplementation(
    () =>
      ({
        init: vi.fn().mockRejectedValue(err),
      }) as unknown as InstanceType<typeof VaultManager>
  )
}

describe("runNoArgInit", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    // Default mocks: ntn installed, single workspace (no ambiguity),
    // confirmPrompt accepts (covers the post-reject + post-yes-flag
    // combined cases). Tests that exercise the recovery / decline /
    // ambiguity paths override per-case.
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(listNtnWorkspaces).mockResolvedValue(["ws-1"])
    vi.mocked(confirmPrompt).mockResolvedValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it("creates a workspace-level page, runs preflight, initializes databases, writes config (happy path)", async () => {
    const cwd = setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    })
    const create = vi.fn(async () => ({ id: "page-1" }))
    // The mocked rate-limit module passes the client through unchanged,
    // so the createClient mock can return a thin object with the
    // pages.create shape the orchestrator calls.
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "ok",
      pageTitle: "Lore Vault",
    })
    mockVaultInitSuccess()

    await runNoArgInit({})

    // Workspace id flows into the generated config.
    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    const parsed = yamlParse(yaml) as Record<string, unknown>
    expect(parsed).toMatchObject({
      vault: { pageId: "page-1" },
      auth: { workspaceId: "ws-1" },
    })
    // Preflight ran against the just-created page id.
    expect(verifyVaultAccess).toHaveBeenCalledWith(expect.anything(), "page-1")
    // The page title flows through pages.create as the cwd-derived default.
    // setupTestCwd() creates a tmpdir matching `cwd-XXXXXX`; the title
    // is `Lore Vault — cwd-XXXXXX`. Pin the prefix to defend against the
    // multi-vault-per-workspace footgun (PR #177 review feedback): if a
    // future refactor reverts the title to the bare "Lore Vault", every
    // operator's private vault would collapse to indistinguishable pages.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          title: expect.objectContaining({
            title: [
              expect.objectContaining({
                text: expect.objectContaining({
                  content: expect.stringMatching(/^Lore Vault — cwd-/),
                }),
              }),
            ],
          }),
        }),
      })
    )
    // Heavy ntn helpers (install / login) were not consulted — auth
    // resolved on the first try. `isNtnInstalled` IS called because
    // the no-arg flow hoists it to a single per-call probe (used by
    // both the multi-workspace ambiguity branch and the recovery
    // branch); that's a passive read against the per-process cache,
    // not a recovery-flow signal.
    expect(installNtn).not.toHaveBeenCalled()
    expect(runNtnLogin).not.toHaveBeenCalled()
    const log = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(log).toContain("Projects DB: db-projects")
    expect(log).not.toContain("[object Object]")
  })

  it("threads --profile through no-arg vault creation and generated config", async () => {
    const cwd = setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    })
    const create = vi.fn(async () => ({ id: "page-support" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runNoArgInit({ profile: "support@1.0.0" })

    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    const parsed = yamlParse(yaml) as Record<string, unknown>
    expect(parsed.profile).toBe("support@1.0.0")
    expect(VaultManager).toHaveBeenCalledWith(
      expect.anything(),
      "page-support",
      expect.objectContaining({ selector: "support@1.0.0" })
    )
  })

  it("rejects an invalid --profile before creating a page or resolving auth", async () => {
    setupTestCwd()
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ profile: "missing@1.0.0" })).rejects.toBeInstanceOf(
      ProcessExitSentinel
    )

    expect(exitTrap.lastCode()).toBe(1)
    expect(resolveAuth).not.toHaveBeenCalled()
    expect(VaultManager).not.toHaveBeenCalled()
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("Invalid --profile")
    expect(stderr).toContain("Unknown built-in profile")
  })

  it("post-init output prints the issue #560 hook-disclosure block before Next steps", async () => {
    // The no-arg flow is the primary onboarding path for external
    // users (`lore init` with no page id). The disclosure must
    // appear here so a first-time user sees what the
    // default-enabled hooks do before they hit the README.
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    })
    const create = vi.fn(async () => ({ id: "page-disclosure" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "ok",
      pageTitle: null,
    })
    mockVaultInitSuccess()

    await runNoArgInit({})

    const log = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    // Each disclosure line must surface verbatim from the shared helper.
    for (const line of buildHookDisclosureLines()) {
      expect(log).toContain(line)
    }
    // Order is contract: the disclosure sits above Next steps so an
    // operator scanning the tail of the post-init output reads the
    // privacy framing before being directed at follow-up commands.
    const disclosureIdx = log.indexOf(buildHookDisclosureLines()[0])
    const nextStepsIdx = log.indexOf("Next steps:")
    expect(disclosureIdx).toBeGreaterThan(-1)
    expect(nextStepsIdx).toBeGreaterThan(disclosureIdx)
  })

  it("uses --name to override the cwd-derived default title", async () => {
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    })
    const create = vi.fn(async () => ({ id: "page-named" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runNoArgInit({ name: "Test Team Vault" })

    // The explicit --name wins over the basename-derived default.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          title: expect.objectContaining({
            title: [
              expect.objectContaining({
                text: expect.objectContaining({ content: "Test Team Vault" }),
              }),
            ],
          }),
        }),
      })
    )
  })

  it("falls back to the cwd-derived default when --name is empty/whitespace", async () => {
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    })
    const create = vi.fn(async () => ({ id: "page-blank" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    // `--name "   "` is functionally equivalent to no flag — commander
    // accepts the value, but treating whitespace as empty avoids landing
    // a malformed title in Notion.
    await runNoArgInit({ name: "   " })

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          title: expect.objectContaining({
            title: [
              expect.objectContaining({
                text: expect.objectContaining({
                  content: expect.stringMatching(/^Lore Vault — cwd-/),
                }),
              }),
            ],
          }),
        }),
      })
    )
  })

  it("writes config WITHOUT auth: block when resolved auth has no workspaceId (env-token source)", async () => {
    const cwd = setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-env",
      baseUrl: undefined,
      source: "env-notion-api-token",
      // No workspaceId — env-token source can't introspect that.
    })
    const create = vi.fn(async () => ({ id: "page-2" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "ok",
      pageTitle: "Lore Vault",
    })
    mockVaultInitSuccess()

    await runNoArgInit({})

    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    const parsed = yamlParse(yaml) as Record<string, unknown>
    expect(parsed).toMatchObject({ vault: { pageId: "page-2" } })
    expect(parsed).not.toHaveProperty("auth")
  })

  it("refuses to overwrite an existing .lore.yaml (exits 1)", async () => {
    const cwd = setupTestCwd()
    writeFileSync(join(cwd, ".lore.yaml"), "vault:\n  pageId: existing\n")
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({})).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    // resolveAuth never runs — the early refusal short-circuits.
    expect(resolveAuth).not.toHaveBeenCalled()
    // Operator-facing copy points at the documented recovery (delete the file).
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("A .lore.yaml already exists")
    expect(stderr).toContain("delete it first")
  })

  it("with no auth + ntn missing + interactive accepted: installs ntn, runs login, then proceeds", async () => {
    const cwd = setupTestCwd()
    // First resolveAuth call returns null (no token); second (post-login)
    // returns the ntn-resolved record.
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({
        token: "tok-after-login",
        baseUrl: undefined,
        source: "ntn-auth-json",
        workspaceId: "ws-1",
      })
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(installNtn).mockResolvedValue({ kind: "success" })
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })
    const create = vi.fn(async () => ({ id: "page-after-login" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    // `--yes` skips the interactive prompts (functionally equivalent to
    // accepting both); a true interactive test would block on stdin.
    await runNoArgInit({ yes: true })

    expect(installNtn).toHaveBeenCalledTimes(1)
    expect(runNtnLogin).toHaveBeenCalledTimes(1)
    // Default / prod path: no `--ntn-env` was passed, so runNtnLogin
    // is called with an empty opts object (no env override). Pin the
    // call shape so a refactor that "always passes env" can't
    // silently send prod operators through the dev/stg branch.
    expect(runNtnLogin).toHaveBeenCalledWith({})
    // Auth got re-resolved post-login and the flow proceeded.
    expect(resolveAuth).toHaveBeenCalledTimes(2)
    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    expect(yaml).toContain("pageId: page-after-login")
  })

  it("with no auth + --yes: skips prompts, invokes installNtn/runNtnLogin without confirmation", async () => {
    setupTestCwd()
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({
        token: "tok-yes",
        baseUrl: undefined,
        source: "ntn-auth-json",
        workspaceId: "ws-yes",
      })
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(installNtn).mockResolvedValue({ kind: "success" })
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })
    const create = vi.fn(async () => ({ id: "page-yes" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runNoArgInit({ yes: true })

    expect(installNtn).toHaveBeenCalledTimes(1)
    expect(runNtnLogin).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------
  // --ntn-env propagation (round-4 review: dev-env support)
  // ---------------------------------------------------------------------

  it("with --ntn-env dev: threads { env: 'dev' } into the runNtnLogin spawn so ntn writes config.json against dev", async () => {
    // The reviewer's round-4 finding: a dev operator should be able
    // to complete `lore init` without first running an out-of-band
    // ntn command. The env selection must reach the spawn so ntn
    // writes `env: "dev"` into config.json — which the post-login
    // `tryResolveAuth(cwd)` reads via resolveNtnBaseUrl to surface
    // the dev base URL on the subsequent Notion calls.
    setupTestCwd()
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({
        token: "tok-after-dev-login",
        baseUrl: "https://api-dev.notion.com",
        source: "ntn-auth-json",
        workspaceId: "ws-dev-1",
      })
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(listNtnWorkspaces).mockResolvedValue([])
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })
    const create = vi.fn(async () => ({ id: "page-dev-1" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runNoArgInit({ yes: true, ntnEnv: "dev" })

    // The selection reached the login spawn.
    expect(runNtnLogin).toHaveBeenCalledTimes(1)
    expect(runNtnLogin).toHaveBeenCalledWith({ env: "dev" })
    // Post-login auth resolution happened — the second resolveAuth
    // call returned a baseUrl threaded into createClient.
    expect(resolveAuth).toHaveBeenCalledTimes(2)
    expect(createClient).toHaveBeenCalledWith(
      "tok-after-dev-login",
      "https://api-dev.notion.com"
    )
  })

  it("with --ntn-env stg: threads { env: 'stg' } through to runNtnLogin", async () => {
    // Symmetric coverage for the third valid env literal.
    setupTestCwd()
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({
        token: "tok-stg",
        baseUrl: "https://api-stg.notion.com",
        source: "ntn-auth-json",
        workspaceId: "ws-stg",
      })
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(listNtnWorkspaces).mockResolvedValue([])
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })
    const create = vi.fn(async () => ({ id: "page-stg" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runNoArgInit({ yes: true, ntnEnv: "stg" })

    expect(runNtnLogin).toHaveBeenCalledWith({ env: "stg" })
  })

  it("with --ntn-env prod: threads { env: 'prod' } through (explicit-prod-override case)", async () => {
    // An operator with shell-rc `NOTION_ENV=dev` who passes
    // `--ntn-env prod` to a Lore command wants prod — the explicit
    // flag overrides the inherited shell value. `runNtnLogin`'s
    // implementation only writes NOTION_ENV when the caller passes
    // `env`; passing `{ env: "prod" }` is the right surface. Pin the
    // call shape so a future refactor that "skips passing prod
    // because it's the default" silently demotes the override.
    setupTestCwd()
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({
        token: "tok-prod",
        baseUrl: undefined,
        source: "ntn-auth-json",
        workspaceId: "ws-prod",
      })
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(listNtnWorkspaces).mockResolvedValue([])
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })
    const create = vi.fn(async () => ({ id: "page-prod" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runNoArgInit({ yes: true, ntnEnv: "prod" })

    expect(runNtnLogin).toHaveBeenCalledWith({ env: "prod" })
  })

  it("with no --ntn-env: calls runNtnLogin with empty opts so ntn picks its own default (prod-or-shell-NOTION_ENV)", async () => {
    // Companion to the dev/stg/prod tests above. Pinning that the
    // default path is structurally `runNtnLogin({})` — NOT
    // `runNtnLogin({ env: "prod" })` — defends the
    // omit-vs-explicit semantics: an inherited shell `NOTION_ENV`
    // flows through naturally rather than being clobbered by an
    // implicit prod override.
    setupTestCwd()
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({
        token: "tok-default",
        baseUrl: undefined,
        source: "ntn-auth-json",
        workspaceId: "ws-default",
      })
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(listNtnWorkspaces).mockResolvedValue([])
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })
    const create = vi.fn(async () => ({ id: "page-default" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runNoArgInit({ yes: true })

    expect(runNtnLogin).toHaveBeenCalledWith({})
  })

  it("with --ntn-env <invalid>: exits 1 BEFORE any side effect (no auth resolve, no ntn spawn)", async () => {
    // Fail-fast on bad input: the parse runs ahead of any Notion
    // touch, ntn probe, or filesystem write so a typo'd flag never
    // produces a partial-state mess.
    setupTestCwd()
    const exitTrap = trapProcessExit()

    await expect(
      runNoArgInit({ yes: true, ntnEnv: "Dev" /* wrong case */ })
    ).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    expect(resolveAuth).not.toHaveBeenCalled()
    expect(isNtnInstalled).not.toHaveBeenCalled()
    expect(installNtn).not.toHaveBeenCalled()
    expect(runNtnLogin).not.toHaveBeenCalled()
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("Invalid --ntn-env value")
    expect(stderr).toContain("prod, dev, stg")
  })

  // ---------------------------------------------------------------------
  // Auth-env mismatch gate (round-5 review: --ntn-env silently ignored
  // when auth already resolves)
  // ---------------------------------------------------------------------

  it("with --ntn-env dev + prod ntn-source auth on first try: exits 1 with ntn logout/login recovery (does NOT proceed)", async () => {
    // The reviewer's round-5 blocker: pre-fix, the flag was only
    // threaded into the recovery-branch `runNtnLogin` call. If auth
    // resolved on the first try (e.g., operator already had prod ntn
    // login), the flag was silently ignored and the vault landed in
    // prod despite the explicit dev request. The fix gates on a
    // post-resolve env-match check that fires regardless of which
    // branch produced the auth.
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-prod-ntn",
      baseUrl: undefined, // ntn-source prod returns undefined (SDK default)
      source: "ntn-auth-json",
      workspaceId: "ws-prod",
    })
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true, ntnEnv: "dev" })).rejects.toBeInstanceOf(
      ProcessExitSentinel
    )

    expect(exitTrap.lastCode()).toBe(1)
    // The init flow MUST NOT have proceeded — no page creation, no
    // vault.init, no config write.
    expect(VaultManager).not.toHaveBeenCalled()
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("--ntn-env dev requested")
    expect(stderr).toContain("Auth source: ntn-auth-json")
    // ntn-source recovery copy: logout + re-login under the requested env.
    expect(stderr).toContain("ntn logout && NOTION_KEYRING=0 NOTION_ENV=dev ntn login")
  })

  it("with --ntn-env dev + env-notion-api-token auth: exits 1 with LORE_NOTION_BASE_URL recovery copy", async () => {
    // Different recovery for env-token sources: the operator pasted a
    // token into NOTION_API_TOKEN env. The right move is either
    // unsetting the env var to fall through to ntn-resolved auth, or
    // setting LORE_NOTION_BASE_URL to point at the requested env.
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-env-api",
      baseUrl: undefined, // NOTION_API_TOKEN with no LORE_NOTION_BASE_URL → prod
      source: "env-notion-api-token",
    })
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true, ntnEnv: "dev" })).rejects.toBeInstanceOf(
      ProcessExitSentinel
    )

    expect(exitTrap.lastCode()).toBe(1)
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("--ntn-env dev requested")
    expect(stderr).toContain("Auth source: env-notion-api-token")
    expect(stderr).toContain("Unset NOTION_API_TOKEN")
    expect(stderr).toContain("LORE_NOTION_BASE_URL=https://api-dev.notion.com")
  })

  it("with --ntn-env prod + dev-baseUrl auth: exits 1 (mismatch in the other direction)", async () => {
    // Symmetric coverage: the gate fires in BOTH directions.
    // Operator on dev wants to switch to prod gets the same fail-fast
    // treatment.
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-dev-ntn",
      baseUrl: "https://api-dev.notion.com",
      source: "ntn-auth-json",
      workspaceId: "ws-dev",
    })
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true, ntnEnv: "prod" })).rejects.toBeInstanceOf(
      ProcessExitSentinel
    )

    expect(exitTrap.lastCode()).toBe(1)
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("--ntn-env prod requested")
    expect(stderr).toContain("https://api-dev.notion.com")
    expect(stderr).toContain("ntn logout && NOTION_KEYRING=0 NOTION_ENV=prod ntn login")
  })

  it("with --ntn-env prod + undefined baseUrl auth: gate is silent (undefined === prod default)", async () => {
    // Pin the omit-vs-explicit semantics on the consumer side: a
    // resolved auth with `baseUrl: undefined` corresponds to the SDK's
    // prod default; a `--ntn-env prod` request matches it. The gate
    // is silent and the flow proceeds.
    const cwd = setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-prod-implicit",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-prod",
    })
    const create = vi.fn(async () => ({ id: "page-prod-implicit" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runNoArgInit({ yes: true, ntnEnv: "prod" })

    // Init proceeded — config exists.
    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    expect(yaml).toContain("pageId: page-prod-implicit")
  })

  it("with --ntn-env prod + explicit api.notion.so baseUrl: gate is silent (explicit prod URL also matches)", async () => {
    // Defense for a future change to `resolveNtnBaseUrl` that returns
    // an explicit `https://api.notion.so` for the prod env instead of
    // `undefined`. The match table accepts both shapes so the gate
    // doesn't false-positive on a benign refactor.
    const cwd = setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-prod-explicit",
      baseUrl: "https://api.notion.so",
      source: "ntn-auth-json",
      workspaceId: "ws-prod",
    })
    const create = vi.fn(async () => ({ id: "page-prod-explicit" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runNoArgInit({ yes: true, ntnEnv: "prod" })

    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    expect(yaml).toContain("pageId: page-prod-explicit")
  })

  it("WITHOUT --ntn-env: the env-match gate does NOT fire even on prod-vs-dev baseUrl divergence", async () => {
    // Operators who don't pass `--ntn-env` are saying "use whatever
    // env my auth resolves to" — no constraint to enforce. Pin that
    // the gate is gated on `ntnEnv` being set, not on baseUrl
    // divergence per se.
    const cwd = setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-dev-no-flag",
      baseUrl: "https://api-dev.notion.com",
      source: "ntn-auth-json",
      workspaceId: "ws-dev",
    })
    const create = vi.fn(async () => ({ id: "page-no-flag" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    // No `ntnEnv` passed — flow uses dev-resolved baseUrl directly.
    await runNoArgInit({ yes: true })

    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    expect(yaml).toContain("pageId: page-no-flag")
  })

  it("with installNtn failure: exits 1, does not run runNtnLogin", async () => {
    setupTestCwd()
    vi.mocked(resolveAuth).mockRejectedValue(new Error("No Notion auth configured."))
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(installNtn).mockResolvedValue({ kind: "exit-non-zero", code: 1 })
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true })).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    expect(installNtn).toHaveBeenCalledTimes(1)
    expect(runNtnLogin).not.toHaveBeenCalled()
  })

  it("with runNtnLogin returning exit-non-zero: exits 1 with retry recommendation", async () => {
    setupTestCwd()
    vi.mocked(resolveAuth).mockRejectedValue(new Error("No Notion auth configured."))
    vi.mocked(isNtnInstalled).mockReturnValue(true) // ntn already installed
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "exit-non-zero", code: 130 })
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true })).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    expect(installNtn).not.toHaveBeenCalled()
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("ntn login did not complete successfully")
    expect(stderr).toContain("Re-run `lore init`")
    expect(stderr).toContain("ntn exited with code 130")
  })

  it("with login succeeding but auth still not resolving post-login: exits 1, points at lore auth --status", async () => {
    setupTestCwd()
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true })).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("ntn login completed, but Lore could not resolve")
    expect(stderr).toContain("lore auth --status")
  })

  it("with pages.create throwing permission error: prints documented fallback message, exits 1", async () => {
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-x",
    })
    const create = vi
      .fn()
      .mockRejectedValue(
        new Error("Workspace-level page creation is reserved for public connections")
      )
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true })).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("Failed to create workspace-level page")
    expect(stderr).toContain("public connections")
    // Manual fallback recommends the explicit-page-id form.
    expect(stderr).toContain("lore init <page-id-from-notion-url>")
  })

  it("with vault.init() throwing 'already initialized' (fresh page): exits 1 with orphan page id", async () => {
    // Reviewer concern: in the no-arg flow we just created the page
    // seconds ago. If `verifyVaultDatabases` finds an existing
    // five-database structure on a freshly-created page that's a
    // genuine anomaly (concurrent Lore process / Notion misbehavior /
    // bug). Burying it under a friendly "already exists" notice would
    // silently land a config pointing at a vault we don't understand.
    // The legacy `runExplicitPageInit` path keeps the non-fatal
    // semantics — separately tested below.
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-x",
    })
    const create = vi.fn(async () => ({ id: "page-x" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitThrow(new Error("Vault already initialized at this page."))
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true })).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("Freshly-created page reports 'already initialized'")
    expect(stderr).toContain("Orphan page id: page-x")
    expect(stderr).toContain("open an issue")
  })

  it("with verifyVaultAccess failing post-create: surfaces the orphan page id with retry/cleanup recovery", async () => {
    // Reviewer concern: the post-create preflight failure leaves an
    // orphan page in the operator's Notion Private area. Lore has the
    // page id in scope; printing it lets the operator either retry via
    // `lore init <id>` (re-runs preflight against the same page) or
    // delete the orphan from Notion's UI.
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    })
    const create = vi.fn(async () => ({ id: "orphan-page-id" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "not-found",
      pageId: "orphan-page-id",
      message: "Vault page not accessible.",
    })
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true })).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("Cannot read the page we just created")
    expect(stderr).toContain("Orphan page id: orphan-page-id")
    // Retry path uses the explicit-page-id form against the same id.
    expect(stderr).toContain("lore init orphan-page-id")
  })

  it("on post-create preflight 'unknown-error': surfaces the underlying error message (review N3)", async () => {
    // The `unknown-error` branch carries an `error: unknown` field
    // that's been silently dropped pre-fix. Pin the surface so a
    // refactor can't regress the diagnostic detail operators need to
    // distinguish a transient 5xx from a permission edge case.
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    })
    const create = vi.fn(async () => ({ id: "orphan-flaky" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "unknown-error",
      pageId: "orphan-flaky",
      error: new Error("Notion API: 503 Service Unavailable"),
    })
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true })).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("Orphan page id: orphan-flaky")
    expect(stderr).toContain("Detail: Notion API: 503 Service Unavailable")
  })

  it("with vault.init() throwing a non-'already initialized' error: surfaces orphan page id and explicit-init recovery", async () => {
    // Coverage gap before this fix: the generic vault.init() failure
    // branch exited without naming the orphan id. Now both error
    // branches surface enough information for the operator to either
    // retry or clean up.
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    })
    const create = vi.fn(async () => ({ id: "orphan-init-fail" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitThrow(new Error("Notion 5xx during database creation"))
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true })).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("Failed to initialize vault")
    expect(stderr).toContain("Orphan page id: orphan-init-fail")
    expect(stderr).toContain("lore init orphan-init-fail")
  })

  it("Entities DB row appears in the success log (PF3-01: five DBs, not four)", async () => {
    // Pre-fix coverage gap: the success log printed
    // Projects/Topics/Memories/Facts and silently dropped the Entities
    // DB. README says "five databases"; operator scanning output saw
    // four. Pin the row's presence so a future refactor can't elide
    // it again.
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    })
    const create = vi.fn(async () => ({ id: "page-five-dbs" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    // mockVaultInitSuccess(): default fixture includes
    // databases.entities; the assertion below pins that the line
    // renders.
    mockVaultInitSuccess()

    await runNoArgInit({ yes: true })

    const log = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(log).toContain("Entities DB:")
    expect(log).toContain("db-entities")
    expect(log).not.toContain("[object Object]")
  })

  // ---------------------------------------------------------------------
  // Multi-workspace ambiguity (Blocker #1 from PR #177 review)
  // ---------------------------------------------------------------------

  it("with ntn installed + multiple workspaces in auth.json: exits 1 with selector hint, does NOT enter install/login recovery", async () => {
    // Reviewer concern: tryResolveAuth swallows two distinct null
    // sources (no auth, multi-workspace ambiguity). The recovery flow
    // is misleading for the ambiguity case — operator gets "Run ntn
    // login" copy that won't fix anything. Fix probes
    // `isNtnInstalled()` + `listNtnWorkspaces()` BEFORE the recovery
    // and short-circuits with the actionable selector hint.
    setupTestCwd()
    vi.mocked(resolveAuth).mockRejectedValue(new Error("No Notion auth configured."))
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(listNtnWorkspaces).mockResolvedValue(["ws-personal", "ws-team-widget"])
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true })).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    // Recovery flow MUST NOT have run — the actionable fix is a
    // workspace selector, not a re-login.
    expect(installNtn).not.toHaveBeenCalled()
    expect(runNtnLogin).not.toHaveBeenCalled()
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("Multiple workspaces in ntn auth.json")
    expect(stderr).toContain("ws-personal")
    expect(stderr).toContain("ws-team-widget")
    expect(stderr).toContain("NOTION_WORKSPACE_ID=<id> lore init")
    // The hint deliberately does NOT recommend the auth.workspaceId
    // route — that path is bootstrap-impossible during init (no
    // .lore.yaml exists yet). Listing it as a parallel option
    // misleads operators skimming for a next step. Subsequent commands
    // pick up auth.workspaceId once the post-init config carries it.
    expect(stderr).not.toContain("auth.workspaceId in .lore.yaml")
  })

  it("with multi-workspace ambiguity + --ntn-env dev: preserves --ntn-env in the recovery copy (round-6 review)", async () => {
    // Reviewer's round-6 blocker: pasting the bare recovery
    // command after running `lore init --ntn-env dev` against a
    // multi-workspace auth.json silently demotes the request. On
    // the second run, NOTION_WORKSPACE_ID resolves cleanly and the
    // env-mismatch gate doesn't fire (no `--ntn-env` to constrain
    // against), so a vault could land in prod despite the explicit
    // dev request. Fix: thread `--ntn-env <env>` into the recovery
    // copy so the paste is transitively safe.
    setupTestCwd()
    vi.mocked(resolveAuth).mockRejectedValue(new Error("No Notion auth configured."))
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(listNtnWorkspaces).mockResolvedValue(["ws-personal", "ws-team-widget"])
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true, ntnEnv: "dev" })).rejects.toBeInstanceOf(
      ProcessExitSentinel
    )

    expect(exitTrap.lastCode()).toBe(1)
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    // The recovery command must carry the original env selection.
    // Pin the FULL command shape (not just the substring) so a
    // future refactor can't silently drop the flag mid-string.
    expect(stderr).toContain("NOTION_WORKSPACE_ID=<id> lore init --ntn-env dev")
  })

  it("with multi-workspace ambiguity + --name and --ntn-env: preserves both flags in the recovery copy", async () => {
    // Both operator-supplied flags need to survive the recovery
    // paste — `--name` would otherwise revert to the cwd-derived
    // default on the second run, surprising operators who scripted
    // a deliberate vault title.
    setupTestCwd()
    vi.mocked(resolveAuth).mockRejectedValue(new Error("No Notion auth configured."))
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(listNtnWorkspaces).mockResolvedValue(["ws-personal", "ws-team-widget"])
    const exitTrap = trapProcessExit()

    await expect(
      runNoArgInit({
        yes: true,
        ntnEnv: "stg",
        name: "Test Vault — STG",
      })
    ).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    // `--name`'s value gets JSON.stringify'd so a value with spaces
    // / special characters survives the shell quote round-trip.
    expect(stderr).toContain(
      'NOTION_WORKSPACE_ID=<id> lore init --ntn-env stg --name "Test Vault — STG"'
    )
  })

  it("with multi-workspace ambiguity + no flags: recovery copy is the bare form (regression on the no-flag path)", async () => {
    // Defense for a future refactor that might always append a
    // suffix to the recovery command. The bare form is what
    // operators on the no-flag path see, and changing that shape
    // breaks copy-paste muscle memory.
    setupTestCwd()
    vi.mocked(resolveAuth).mockRejectedValue(new Error("No Notion auth configured."))
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(listNtnWorkspaces).mockResolvedValue(["ws-personal", "ws-team-widget"])
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({ yes: true })).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    // Pin the EXACT recovery line (no trailing flags) — a future
    // refactor that always appends `--ntn-env prod` (treating the
    // unset case as prod) would surprise operators who didn't
    // type the flag. Asserting against the raw mock call surfaces
    // the per-line shape directly; the joined-string approach
    // requires trailing-newline gymnastics that obscure the intent.
    const recoveryLine = consoleErrorSpy.mock.calls.find(
      (c) =>
        typeof c[0] === "string" && (c[0] as string).includes("NOTION_WORKSPACE_ID=<id>")
    )
    expect(recoveryLine?.[0]).toBe("  NOTION_WORKSPACE_ID=<id> lore init")
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).not.toContain("--ntn-env")
    expect(stderr).not.toContain("--name")
  })

  it("with ntn installed + zero workspaces (auth.json absent): falls through to install/login recovery", async () => {
    // Distinguish the multi-workspace ambiguity case from the
    // ntn-installed-but-not-logged-in case. workspaces.length === 0
    // means the recovery IS the right path.
    setupTestCwd()
    vi.mocked(resolveAuth)
      .mockRejectedValueOnce(new Error("No Notion auth configured."))
      .mockResolvedValueOnce({
        token: "tok-after-login",
        baseUrl: undefined,
        source: "ntn-auth-json",
        workspaceId: "ws-1",
      })
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(listNtnWorkspaces).mockResolvedValue([])
    vi.mocked(runNtnLogin).mockResolvedValue({ kind: "success" })
    const create = vi.fn(async () => ({ id: "page-after-recovery" }))
    const { createClient } = await import("../../notion/client.js")
    vi.mocked(createClient).mockReturnValue({
      pages: { create },
    } as unknown as ReturnType<typeof createClient>)
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runNoArgInit({ yes: true })

    // ntn already installed, zero-workspaces branch invokes login (not
    // install) and then re-resolves auth successfully.
    expect(installNtn).not.toHaveBeenCalled()
    expect(runNtnLogin).toHaveBeenCalledTimes(1)
  })

  // ---------------------------------------------------------------------
  // Declined-prompt branches (Major #4 from PR #177 review)
  // ---------------------------------------------------------------------

  it("with ntn missing + Install ntn declined: exits 1 with manual-install pointer, does NOT call installNtn", async () => {
    setupTestCwd()
    vi.mocked(resolveAuth).mockRejectedValue(new Error("No Notion auth configured."))
    vi.mocked(isNtnInstalled).mockReturnValue(false)
    vi.mocked(confirmPrompt).mockResolvedValueOnce(false) // Install ntn? → no
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({})).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    expect(installNtn).not.toHaveBeenCalled()
    expect(runNtnLogin).not.toHaveBeenCalled()
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("ntn is required for `lore init`")
    expect(stderr).toContain("Install manually")
  })

  it("with ntn installed + ntn login declined: exits 1 with manual-action pointer, does NOT call runNtnLogin", async () => {
    setupTestCwd()
    vi.mocked(resolveAuth).mockRejectedValue(new Error("No Notion auth configured."))
    vi.mocked(isNtnInstalled).mockReturnValue(true)
    vi.mocked(listNtnWorkspaces).mockResolvedValue([]) // not multi-workspace
    vi.mocked(confirmPrompt).mockResolvedValueOnce(false) // Run ntn login? → no
    const exitTrap = trapProcessExit()

    await expect(runNoArgInit({})).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    expect(installNtn).not.toHaveBeenCalled()
    expect(runNtnLogin).not.toHaveBeenCalled()
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("ntn login is required to initialize a vault")
    expect(stderr).toContain("NOTION_KEYRING=0 ntn login")
  })
})

describe("runExplicitPageInit", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.clearAllMocks()
  })

  it("with valid preflight: creates databases and writes config (regression on the legacy path)", async () => {
    const cwd = setupTestCwd()
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runExplicitPageInit("explicit-page", { token: "tok-explicit" })

    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    expect(yaml).toContain("pageId: explicit-page")
    // Preflight runs against the operator-supplied page id.
    expect(verifyVaultAccess).toHaveBeenCalledWith(expect.anything(), "explicit-page")
  })

  it("threads --profile through explicit-page vault creation and generated config", async () => {
    const cwd = setupTestCwd()
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runExplicitPageInit("explicit-support", {
      token: "tok-explicit",
      profile: "support@1.0.0",
    })

    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    const parsed = yamlParse(yaml) as Record<string, unknown>
    expect(parsed.profile).toBe("support@1.0.0")
    expect(VaultManager).toHaveBeenCalledWith(
      expect.anything(),
      "explicit-support",
      expect.objectContaining({ selector: "support@1.0.0" })
    )
  })

  it("with partial vault schema: exits without writing config or implying init can repair it", async () => {
    const cwd = setupTestCwd()
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitThrow(
      new Error(
        "Vault at explicit-page is missing databases: Entities. " +
          "Found existing Lore databases: Projects, Topics, Memories, Facts. " +
          "This is a partial vault schema; do not run 'lore init' on this page."
      )
    )
    const exitTrap = trapProcessExit()

    await expect(
      runExplicitPageInit("explicit-page", { token: "tok-explicit" })
    ).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    await expect(readFile(join(cwd, ".lore.yaml"), "utf-8")).rejects.toThrow()
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("partial vault schema")
    expect(stderr).toContain("do not run 'lore init'")
  })

  it("with invalid preflight (not-found): aborts before vault.init() with documented copy", async () => {
    setupTestCwd()
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "not-found",
      pageId: "bad-page",
      message: "Vault page not accessible.",
    })
    // VaultManager constructor MUST NOT be called when preflight fails.
    const ctor = vi.fn()
    vi.mocked(VaultManager).mockImplementation(ctor)
    const exitTrap = trapProcessExit()

    await expect(
      runExplicitPageInit("bad-page", { token: "tok" })
    ).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    // Preflight aborted before any VaultManager work happened.
    expect(ctor).not.toHaveBeenCalled()
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("Cannot access page bad-page")
    expect(stderr).toContain("not-found")
    expect(stderr).toContain("Vault page not accessible")
  })

  it("without --token: routes through resolveAuth so the ntn-resolved baseUrl threads through", async () => {
    setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: "https://api-dev.notion.com",
      source: "ntn-auth-json",
      workspaceId: "ws-1",
    })
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()
    const { createClient } = await import("../../notion/client.js")

    await runExplicitPageInit("explicit", {})

    expect(resolveAuth).toHaveBeenCalled()
    // baseUrl from the ntn-resolved auth threads into createClient. A
    // regression that drops the second arg would silently send dev
    // tokens to the prod API — pin it.
    expect(createClient).toHaveBeenCalledWith("tok-ntn", "https://api-dev.notion.com")
  })

  it("with --name combined with explicit page-id: prints stderr note and continues with init", async () => {
    // `runExplicitPageInit` accepts `--name` for option-shape symmetry
    // (single source of truth on `InitOpts`) but ignores it — Lore
    // doesn't rename existing pages. Mirror install.ts's
    // `--cursor-global ignored under --client claude` precedent: emit
    // the note instead of silently dropping so an operator who
    // scripted the wrong shape isn't surprised.
    const cwd = setupTestCwd()
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runExplicitPageInit("page-explicit", {
      token: "tok",
      name: "Ignored Name",
    })

    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("--name is ignored when a page id is provided")
    // Init still completed — the note is informational, not fatal.
    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    expect(yaml).toContain("pageId: page-explicit")
  })

  it("with --ntn-env combined with explicit page-id: prints stderr note and continues (mirrors --name precedent)", async () => {
    // The explicit-page path expects auth to already be configured —
    // no ntn login is spawned, so `--ntn-env` has nothing to bind to.
    // Same precedent as `--name` ignored under explicit page-id.
    const cwd = setupTestCwd()
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runExplicitPageInit("page-with-env", {
      token: "tok",
      ntnEnv: "dev",
    })

    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("--ntn-env is ignored when a page id is provided")
    // Init still completed — the note is informational, not fatal.
    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    expect(yaml).toContain("pageId: page-with-env")
  })

  it("Entities DB row appears in the success log on the legacy path too (PF3-01: five DBs, not four)", async () => {
    // Same pre-fix coverage gap as the no-arg path: legacy success log
    // dropped the Entities DB row. Pin the row's presence here too.
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    setupTestCwd()
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runExplicitPageInit("explicit", { token: "tok" })

    const log = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(log).toContain("Entities DB:")
  })

  it("post-init output prints the issue #560 hook-disclosure block before Next steps (legacy path)", async () => {
    // Both init paths share the same disclosure helper; pin the
    // legacy path's wiring so a future contributor who only updates
    // one branch fails this test loudly. Without this, the legacy
    // path could regress to the pre-#560 silent post-init output
    // while the no-arg path stays correct.
    const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {})
    setupTestCwd()
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runExplicitPageInit("explicit-disclosure", { token: "tok" })

    const log = consoleLogSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    for (const line of buildHookDisclosureLines()) {
      expect(log).toContain(line)
    }
    const disclosureIdx = log.indexOf(buildHookDisclosureLines()[0])
    const nextStepsIdx = log.indexOf("Next steps:")
    expect(disclosureIdx).toBeGreaterThan(-1)
    expect(nextStepsIdx).toBeGreaterThan(disclosureIdx)
  })

  it("threads ntn-resolved workspaceId into the generated YAML on the legacy path (regression: review #3)", async () => {
    // Pre-fix bug: `runExplicitPageInit` resolved auth (potentially
    // ntn-source with workspaceId) but called
    // `buildInitConfigYaml(pageId)` with one argument, dropping the
    // workspaceId. Multi-workspace operators using `lore init <id>`
    // got a config without `auth.workspaceId`, so subsequent commands
    // re-hit the same multi-workspace ambiguity that the no-arg path
    // now handles. Pin the workspaceId threading so a future
    // contributor refactoring the call sites can't silently drop it
    // again.
    const cwd = setupTestCwd()
    vi.mocked(resolveAuth).mockResolvedValue({
      token: "tok-ntn",
      baseUrl: undefined,
      source: "ntn-auth-json",
      workspaceId: "ws-team-widget",
    })
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    // No `--token` so resolveAuth runs and returns the ntn-source
    // record carrying workspaceId.
    await runExplicitPageInit("explicit-mw", {})

    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    const parsed = yamlParse(yaml) as Record<string, unknown>
    expect(parsed).toMatchObject({
      vault: { pageId: "explicit-mw" },
      auth: { workspaceId: "ws-team-widget" },
    })
  })

  it("does NOT write auth.workspaceId on the legacy path under --token (raw token has no workspace metadata)", async () => {
    // The `--token` path receives a literal token with no workspace
    // metadata; capturing a stray workspaceId from a prior test would
    // be wrong. Pin the absence so a refactor that "always passes
    // workspaceId" can't silently mistype the YAML.
    const cwd = setupTestCwd()
    vi.mocked(verifyVaultAccess).mockResolvedValue({ kind: "ok", pageTitle: null })
    mockVaultInitSuccess()

    await runExplicitPageInit("explicit-rawtoken", { token: "tok-explicit" })

    const yaml = await readFile(join(cwd, ".lore.yaml"), "utf-8")
    const parsed = yamlParse(yaml) as Record<string, unknown>
    expect(parsed).toMatchObject({ vault: { pageId: "explicit-rawtoken" } })
    expect(parsed).not.toHaveProperty("auth")
    // resolveAuth must NOT run when --token is set — the token
    // bypasses the resolve chain and we have no workspaceId anyway.
    expect(resolveAuth).not.toHaveBeenCalled()
  })

  it("surfaces preflight 'unknown-error' detail to stderr (review N3)", async () => {
    // Reviewer concern: the `unknown-error` branch dropped the
    // underlying SDK / network error message, leaving operators with
    // no diagnostic detail to attach to a bug report. Pin the surface.
    setupTestCwd()
    vi.mocked(verifyVaultAccess).mockResolvedValue({
      kind: "unknown-error",
      pageId: "page-flaky",
      error: new Error("Notion API: 503 Service Unavailable"),
    })
    const exitTrap = trapProcessExit()

    await expect(
      runExplicitPageInit("page-flaky", { token: "tok" })
    ).rejects.toBeInstanceOf(ProcessExitSentinel)

    expect(exitTrap.lastCode()).toBe(1)
    const stderr = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
    expect(stderr).toContain("Cannot access page page-flaky")
    expect(stderr).toContain("unknown-error")
    expect(stderr).toContain("Detail: Notion API: 503 Service Unavailable")
  })
})
