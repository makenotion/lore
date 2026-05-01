/**
 * Tests for `confirmPrompt`. Lives in its own file because
 * `init.test.ts` mocks `./init-prompt.js` globally to control
 * `runNoArgInit`'s decline branches; mocking the module under test in
 * the same file would shadow the real implementation we want to
 * exercise here.
 *
 * Three branches:
 *   1. `yesFlag === true` short-circuits to true without touching stdin.
 *   2. Non-TTY without `--yes` returns false and prints the
 *      "pass --yes" stderr hint (the CI-onboarding case the original
 *      review flagged as missing acceptance-criteria coverage).
 *   3. TTY path is exercised indirectly — the readline interaction is
 *      hard to fake without piping a real stream, and the `--yes` /
 *      non-TTY branches together cover every code path that doesn't
 *      hit `rl.question`.
 */
import { afterEach, describe, expect, it, vi } from "vitest"
import { confirmPrompt } from "./init-prompt.js"

describe("confirmPrompt", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("returns true unconditionally when yesFlag is set, without touching stdin", async () => {
    // Pin the short-circuit so a future refactor that "moves the TTY
    // check ahead of yesFlag" can't accidentally route a `--yes` call
    // into the non-TTY branch and then return false.
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    const result = await confirmPrompt("Install ntn now? [Y/n] ", true)
    expect(result).toBe(true)
    // No stderr emission on the yes-path.
    expect(stderrSpy).not.toHaveBeenCalled()
  })

  it("on non-TTY without yesFlag: returns false and emits the 'pass --yes' stderr hint", async () => {
    // The review flagged this branch as the practical CI-failure
    // case: an automation runs `lore init` with neither a token nor
    // `--yes` and the prompt blocks waiting on a stdin that isn't
    // there. The right behavior is to fail fast with an actionable
    // message — pin it.
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
    // Simulate a non-TTY stdin. `process.stdin.isTTY` is `undefined`
    // on piped runs; setting to `false` is the explicit form vitest
    // accepts.
    const originalIsTTY = process.stdin.isTTY
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    })
    try {
      const result = await confirmPrompt("Run `ntn login` now? [Y/n] ", false)
      expect(result).toBe(false)
      const msg = consoleErrorSpy.mock.calls.map((c) => c.join(" ")).join("\n")
      expect(msg).toContain("Non-interactive context detected")
      expect(msg).toContain("Pass --yes")
    } finally {
      Object.defineProperty(process.stdin, "isTTY", {
        configurable: true,
        value: originalIsTTY,
      })
    }
  })
})
