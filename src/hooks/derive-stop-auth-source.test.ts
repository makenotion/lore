/**
 * Tests for `deriveStopAuthSource` (issue #475 PR review, Suggestion 4).
 *
 * The Stop hot path's "no new failure mode" guarantee rests entirely on
 * the four-branch failure matrix this helper documents: undefined
 * failureContext, null config, null configRoot, and `resolveAuth`
 * rejection all return `undefined` so the legacy every-key forward
 * applies. The success branch returns the resolved `AuthSource` so
 * `spawnBackgroundSave` and `scheduleAutoDigestSpawn` apply the
 * ntn-source partition. A future refactor that quietly inverts the
 * fallback (e.g., re-throws on resolveAuth rejection) would break the
 * Stop contract; pinning each branch here is the structural defense.
 *
 * Lives in its own file so the env-cleanup discipline (clear every
 * auth-relevant env var between tests) doesn't fight the broader
 * `helpers.test.ts` fixtures, which exercise `handleStop` end-to-end
 * with a real-but-mock-spawn pipeline. This file's surface is just
 * the helper; the cross-file split keeps both fixtures simple.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Auth-relevant env vars that influence `resolveAuth` priority chain
// resolution. Cleared per-test so a developer's local shell rc can't
// drag the resolver onto a different priority than the test asserts.
const AUTH_ENV_KEYS = [
  "NOTION_API_TOKEN",
  "LORE_NOTION_TOKEN",
  "NOTION_WORKSPACE_ID",
  "LORE_NOTION_BASE_URL",
  "NOTION_BASE_URL",
  "NOTION_API_BASE_URL",
  "NOTION_ENV",
] as const

// Mock `auth/ntn.js` so `resolveAuth`'s priority-2 dynamic import
// doesn't hit the developer's actual `~/.config/notion/auth.json`.
// Default returns `null` (no ntn token); individual tests override
// per-call for the ntn-auth-json success branch.
//
// Type the mock via the actual `loadNtnToken` signature so
// `mockResolvedValue({ token, workspaceId, baseUrl })` is accepted
// instead of being constrained to the literal `null` inferred from
// the default-impl arrow. `listNtnWorkspaces` also gets stubbed
// because `resolveAuth`'s no-source-resolved throw path calls
// `buildNtnAmbiguityHint`, which in turn calls into the same module.
const { loadNtnTokenMock, listNtnWorkspacesMock } = vi.hoisted(() => ({
  loadNtnTokenMock: vi.fn<
    typeof import("../auth/ntn.js").loadNtnToken
  >(async () => null),
  listNtnWorkspacesMock: vi.fn<
    typeof import("../auth/ntn.js").listNtnWorkspaces
  >(async () => []),
}))

vi.mock("../auth/ntn.js", async () => {
  const actual = await vi.importActual<typeof import("../auth/ntn.js")>(
    "../auth/ntn.js"
  )
  return {
    ...actual,
    loadNtnToken: loadNtnTokenMock,
    listNtnWorkspaces: listNtnWorkspacesMock,
  }
})

import { deriveStopAuthSource, type StopFailureContext } from "./helpers.js"
import { withClearedRuntimeEnv } from "./test-utils.js"
import type { LoreConfig } from "../types.js"

const BASE_CONFIG: LoreConfig = {
  vault: { pageId: "v" },
  projects: [{ name: "Widget", path: "." }],
}

function ctx(overrides: Partial<StopFailureContext> = {}): StopFailureContext {
  return {
    config: BASE_CONFIG,
    configRoot: "/repo",
    ...overrides,
  }
}

describe("deriveStopAuthSource — failure branches preserve every-key forward", () => {
  const envGuard = withClearedRuntimeEnv(AUTH_ENV_KEYS)

  beforeEach(() => {
    envGuard.install()
    loadNtnTokenMock.mockReset()
    loadNtnTokenMock.mockResolvedValue(null)
    listNtnWorkspacesMock.mockReset()
    listNtnWorkspacesMock.mockResolvedValue([])
  })

  afterEach(() => {
    envGuard.restore()
  })

  it("returns undefined when failureContext is undefined", async () => {
    // No config to feed `resolveAuth`. The helper short-circuits
    // BEFORE any I/O — pinning this branch protects the
    // "no new failure mode" Stop hot-path guarantee.
    const source = await deriveStopAuthSource(undefined)
    expect(source).toBeUndefined()
    expect(loadNtnTokenMock).not.toHaveBeenCalled()
  })

  it("returns undefined when failureContext.config is null", async () => {
    // `loadHookState`'s recovery branch (config-load-failed) sets
    // `config: null`. Helper must short-circuit; otherwise
    // `resolveAuth(undefined, configRoot)` would proceed and
    // potentially throw differently than the "no source" path.
    const source = await deriveStopAuthSource(ctx({ config: null }))
    expect(source).toBeUndefined()
    expect(loadNtnTokenMock).not.toHaveBeenCalled()
  })

  it("returns undefined when failureContext.configRoot is null", async () => {
    // `loadHookState`'s recovery branch also sets `configRoot: null`
    // when `findConfigFile` finds nothing. `resolveAuth` requires
    // a non-null root for the deprecation-warning marker key, so
    // the helper must short-circuit.
    const source = await deriveStopAuthSource(ctx({ configRoot: null }))
    expect(source).toBeUndefined()
    expect(loadNtnTokenMock).not.toHaveBeenCalled()
  })

  it("returns undefined when resolveAuth rejects (no token configured)", async () => {
    // Defensive try/catch: a `resolveAuth` rejection (no source
    // resolves: NOTION_API_TOKEN unset, ntn returns null,
    // LORE_NOTION_TOKEN unset, no `auth.token` in config) must NOT
    // propagate. Production: the spawned child re-runs resolveAuth
    // and surfaces auth problems through its own stderr log;
    // throwing here would convert a normal "no auth yet" state
    // into a Stop hook failure that blocks `{}\n` emission.
    loadNtnTokenMock.mockResolvedValue(null)
    const source = await deriveStopAuthSource(ctx())
    expect(source).toBeUndefined()
  })
})

describe("deriveStopAuthSource — success branches return the resolved source", () => {
  const envGuard = withClearedRuntimeEnv(AUTH_ENV_KEYS)

  beforeEach(() => {
    envGuard.install()
    loadNtnTokenMock.mockReset()
    loadNtnTokenMock.mockResolvedValue(null)
    listNtnWorkspacesMock.mockReset()
    listNtnWorkspacesMock.mockResolvedValue([])
  })

  afterEach(() => {
    envGuard.restore()
  })

  it("returns 'env-notion-api-token' when NOTION_API_TOKEN is set", async () => {
    process.env["NOTION_API_TOKEN"] = "secret_canonical_token"
    const source = await deriveStopAuthSource(ctx())
    expect(source).toBe("env-notion-api-token")
    // Priority 1 short-circuits before priority 2 runs.
    expect(loadNtnTokenMock).not.toHaveBeenCalled()
  })

  it("returns 'ntn-auth-json' when ntn resolves a token", async () => {
    // The load-bearing case for issue #475: this is the source that
    // triggers the env partition in `spawnBackgroundSave` and
    // `scheduleAutoDigestSpawn`.
    loadNtnTokenMock.mockResolvedValue({
      token: "secret_ntn_token",
      baseUrl: undefined,
      workspaceId: "ws_team_alpha",
    })
    const source = await deriveStopAuthSource(ctx())
    expect(source).toBe("ntn-auth-json")
    expect(loadNtnTokenMock).toHaveBeenCalledTimes(1)
    // Pin the quiet propagation contract: `resolveAuth` calls
    // `loadNtnToken` with `quiet: true` unconditionally so the
    // ntn-module's stderr ambiguity hints don't fight the
    // deprecation emitter when an ntn fallback path coexists with
    // a legacy token. A future refactor that drops the always-quiet
    // posture (e.g., propagating the new `ResolveAuthOptions.quiet`
    // through to `loadNtnToken` literally — which would be a
    // semantics change the synthetic-resolver caller does NOT
    // intend) would surface here.
    expect(loadNtnTokenMock).toHaveBeenCalledWith(
      expect.objectContaining({ quiet: true })
    )
  })

  it("returns 'env-lore-notion-token' for the soft-deprecated env path", async () => {
    process.env["LORE_NOTION_TOKEN"] = "secret_legacy_lore_token"
    const source = await deriveStopAuthSource(ctx())
    expect(source).toBe("env-lore-notion-token")
  })

  it("returns 'config-auth-token' for the soft-deprecated repo-config path", async () => {
    const source = await deriveStopAuthSource(
      ctx({
        config: {
          vault: { pageId: "v" },
          auth: { token: "secret_config_token" },
        },
      })
    )
    expect(source).toBe("config-auth-token")
  })
})

describe("deriveStopAuthSource — quiet emission", () => {
  // The synthetic resolver call must not emit a NEW deprecation
  // warning on every Stop fire after the debounce window expires.
  // The foreground host already paid that emission via its primary
  // `resolveAuth`; re-emitting from the hot path would surface a
  // stderr nag at hook cadence rather than the intended
  // once-per-warning-window cadence (the fresh `lore hooks autosave`
  // process is its own debounce key).
  let stderrChunks: string[]
  let stderrSpy: { mockRestore: () => void }
  let realConfigRoot: string
  const envGuard = withClearedRuntimeEnv(AUTH_ENV_KEYS)

  beforeEach(() => {
    envGuard.install()
    realConfigRoot = mkdtempSync(join(tmpdir(), "lore-derive-auth-"))
    stderrChunks = []
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      stderrChunks.push(String(chunk))
      return true
    })
    loadNtnTokenMock.mockReset()
    loadNtnTokenMock.mockResolvedValue(null)
  })

  afterEach(() => {
    stderrSpy.mockRestore()
    rmSync(realConfigRoot, { recursive: true, force: true })
    envGuard.restore()
  })

  it("does NOT emit a deprecation warning for env-lore-notion-token (quiet: true)", async () => {
    // Use a real configRoot so `emitDeprecationWarningOnce`'s
    // filesystem marker key resolves cleanly. The marker would
    // suppress the second emission anyway, but the first emission
    // must ALSO be suppressed under quiet — a fresh hook process
    // is its own marker bed and would otherwise emit on every fire.
    process.env["LORE_NOTION_TOKEN"] = "secret_legacy_lore_token"
    const source = await deriveStopAuthSource({
      config: BASE_CONFIG,
      configRoot: realConfigRoot,
    })
    expect(source).toBe("env-lore-notion-token")
    const stderr = stderrChunks.join("")
    expect(stderr).not.toContain("LORE_NOTION_TOKEN")
    expect(stderr).not.toContain("deprecated")
  })

  it("does NOT emit a deprecation warning for config-auth-token (quiet: true)", async () => {
    // Save the .lore.yaml fixture so `emitDeprecationWarningOnce`
    // can compute its config-key hash without falling back to a
    // path-doesn't-exist branch.
    writeFileSync(join(realConfigRoot, ".lore.yaml"), "vault:\n  pageId: v\n")
    const source = await deriveStopAuthSource({
      config: {
        vault: { pageId: "v" },
        auth: { token: "secret_config_token" },
      },
      configRoot: realConfigRoot,
    })
    expect(source).toBe("config-auth-token")
    const stderr = stderrChunks.join("")
    expect(stderr).not.toContain("auth.token")
    expect(stderr).not.toContain("deprecated")
  })
})
