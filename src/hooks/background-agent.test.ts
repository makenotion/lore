/**
 * Tests for the spawn-primitive helpers introduced by issue #194:
 *
 * - `renderAgentArgs` — pure args-template substitution
 * - `findBackgroundBinary` — absolute-path short-circuit + name lookup
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { findBackgroundBinary, renderAgentArgs } from "./background.js"
import { ALLOWED_TOOLS_PLACEHOLDER, DEFAULT_BACKGROUND_ARGS } from "./config.js"

describe("renderAgentArgs", () => {
  it("substitutes the placeholder with the allowlist string", () => {
    const args = renderAgentArgs(
      ["-p", "--allowedTools", ALLOWED_TOOLS_PLACEHOLDER, "--model", "sonnet"],
      "tool-a,tool-b",
    )
    expect(args).toEqual([
      "-p",
      "--allowedTools",
      "tool-a,tool-b",
      "--model",
      "sonnet",
    ])
  })

  it("preserves the args array when no placeholder is present", () => {
    const args = renderAgentArgs(["exec", "--full-auto"], "tool-a,tool-b")
    expect(args).toEqual(["exec", "--full-auto"])
  })

  it("substitutes every occurrence when the placeholder appears multiple times", () => {
    const args = renderAgentArgs(
      [ALLOWED_TOOLS_PLACEHOLDER, "--once", ALLOWED_TOOLS_PLACEHOLDER],
      "x,y",
    )
    expect(args).toEqual(["x,y", "--once", "x,y"])
  })

  it("substitutes when the placeholder is embedded in a larger string", () => {
    const args = renderAgentArgs(
      [`--tools=${ALLOWED_TOOLS_PLACEHOLDER}`, "--model", "sonnet"],
      "tool-a,tool-b",
    )
    expect(args).toEqual(["--tools=tool-a,tool-b", "--model", "sonnet"])
  })

  it("threads the empty string through untouched", () => {
    const args = renderAgentArgs(
      ["-p", "--allowedTools", ALLOWED_TOOLS_PLACEHOLDER],
      "",
    )
    expect(args).toEqual(["-p", "--allowedTools", ""])
  })

  it("returns a fresh array", () => {
    const input: readonly string[] = DEFAULT_BACKGROUND_ARGS
    const out = renderAgentArgs(input, "x")
    expect(out).not.toBe(input)
  })
})

describe("findBackgroundBinary", () => {
  it("short-circuits to existsSync for an absolute path that exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-bg-"))
    try {
      const binPath = join(dir, "fake-agent")
      writeFileSync(binPath, "#!/bin/sh\necho fake\n")
      chmodSync(binPath, 0o755)
      expect(findBackgroundBinary(binPath)).toBe(binPath)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("returns null for an absolute path that does not exist", () => {
    const missingPath = join(tmpdir(), "lore-bg-missing-noexist-xyz")
    expect(findBackgroundBinary(missingPath)).toBeNull()
  })

  it("resolves a binary name on PATH via `which`", () => {
    const resolved = findBackgroundBinary("sh")
    expect(resolved).not.toBeNull()
    expect(resolved).toMatch(/sh$/)
  })

  it("returns null for a missing binary name", () => {
    expect(findBackgroundBinary("__lore_nonexistent_binary_xyz_1234__")).toBeNull()
  })
})
