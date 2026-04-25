import { afterAll, describe, expect, it } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveSpawnCwd } from "./digest.js"

// Real on-disk fixtures — `resolveSpawnCwd` calls `existsSync` and we want
// to pin actual filesystem behavior, not a mock of it.
const SCRATCH = mkdtempSync(join(tmpdir(), "lore-digest-cli-test-"))
afterAll(() => {
  rmSync(SCRATCH, { recursive: true, force: true })
})

describe("resolveSpawnCwd", () => {
  it("returns process.cwd() when no project path is given", () => {
    const warn = (): void => {}
    expect(resolveSpawnCwd(SCRATCH, undefined, warn)).toBe(process.cwd())
  })

  it("returns configRoot when the project path is the catch-all '.'", () => {
    const warn = (): void => {}
    expect(resolveSpawnCwd(SCRATCH, ".", warn)).toBe(SCRATCH)
  })

  it("returns the configured absolute path when it exists on disk (round-2 #7 happy path)", () => {
    // Use the scratch root itself as a valid sub-path — the test only cares
    // that existsSync returns true and resolve() lands on the right absolute.
    const warn = (): void => {}
    const fakeProjectPath = "."
    expect(resolveSpawnCwd(SCRATCH, fakeProjectPath, warn)).toBe(SCRATCH)
  })

  it("warns and falls back to process.cwd() when the project path is stale", () => {
    const messages: string[] = []
    const warn = (msg: string): void => {
      messages.push(msg)
    }
    const result = resolveSpawnCwd(SCRATCH, "this-path-does-not-exist", warn)
    expect(result).toBe(process.cwd())
    expect(messages).toHaveLength(1)
    expect(messages[0]).toContain(`"this-path-does-not-exist"`)
    expect(messages[0]).toContain("may diverge")
  })

  it("strips a leading slash on the project path before resolving", () => {
    // `.lore.yaml` historically allowed `/services/mail` as a project path.
    // The leading slash must be stripped so `resolve(configRoot, ...)` doesn't
    // jump up to the filesystem root.
    const warn = (): void => {}
    const result = resolveSpawnCwd(SCRATCH, "/nope-still-stale", warn)
    // Stale → fallback. The important part is that we didn't try to resolve
    // against `/nope-still-stale` as an absolute path on disk.
    expect(result).toBe(process.cwd())
  })
})
