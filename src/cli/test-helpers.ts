import { vi } from "vitest"

/**
 * Spy on `process.exit` so a CLI test can assert an exit-code contract
 * without tearing down the test runner. The mock RECORDS the requested
 * exit code and returns `undefined as never` — it does NOT throw. Each
 * command-action `process.exit(1)` site is paired with a defensive
 * `return` (see the "standing pattern" comment in `commands/mine.ts`),
 * so under the no-throw mock the action returns cleanly and the test
 * asserts on `exitTrap.exitCodes`.
 *
 * ## Why no-throw, not throw-sentinel
 *
 * The earlier throw-sentinel design (which `init.test.ts` and
 * `auth.test.ts` still use locally) interacts badly with the
 * project-wide outer try/catch in command actions:
 *
 * ```typescript
 * try {
 *   if (!parsed.ok) { console.error(...); process.exit(1) }  // throws
 *   ...
 * } catch (err) {
 *   console.error("Foo failed:", err.message)  // err.message is the sentinel
 *   process.exit(1)                            // doubled emission!
 * }
 * ```
 *
 * Under the throw-sentinel mock, the spy's throw is caught by the
 * outer `catch (err)`, which emits a SECOND `console.error` carrying
 * the sentinel string as the error message AND calls `process.exit(1)`
 * a SECOND time. Tests using `expect(exitTrap.exitCodes).toContain(1)`
 * silently accept `[1, 1]` and lock in the doubled-emission bug. See
 * PR #512's review for the full trace.
 *
 * The no-throw design avoids the entire issue. Production behavior is
 * unchanged: real `process.exit(1)` actually terminates, so the catch
 * block never runs after a successful exit. The mock matches that
 * shape (mock records, defensive `return` exits the action) — the
 * test bed now accurately reflects production.
 *
 * ## Call-site pattern
 *
 * ```typescript
 * let exitTrap: ReturnType<typeof trapProcessExit>
 * beforeEach(() => {
 *   exitTrap = trapProcessExit()
 * })
 * afterEach(() => {
 *   vi.restoreAllMocks()
 * })
 *
 * it("exits 1 on initServices failure", async () => {
 *   vi.mocked(initServices).mockRejectedValue(new Error("notion 503"))
 *
 *   await fooCommand.parseAsync([], { from: "user" })
 *
 *   expect(errorSpy.mock.calls.flat().join("\n")).toContain("Foo failed:")
 *   expect(exitTrap.exitCodes).toEqual([1])
 *   expect(errorSpy).toHaveBeenCalledTimes(1)
 * })
 * ```
 *
 * Pin three things:
 *
 * 1. The user-visible `<Cmd> failed:` prefix — refactors can't silently
 *    change shell-grep contracts.
 * 2. `exitTrap.exitCodes` via `toEqual([1])`, NOT `toContain(1)`. The
 *    tight assertion catches doubled-emission bugs caused by future
 *    refactors that drop the defensive `return` after `process.exit(1)`.
 * 3. `errorSpy` was called exactly once (`toHaveBeenCalledTimes(1)`) —
 *    same regression class.
 *
 * Spy cleanup is the project convention via `vi.restoreAllMocks()` in
 * `afterEach`; the helper does NOT expose a `restore()` method.
 *
 * `init.test.ts` and `auth.test.ts` predate this helper and define
 * their own local throw-sentinel versions. They are NOT migrated in
 * PR #512 — both files are well-covered today and a mass rewrite
 * would balloon the diff. Migrate them as a focused follow-up so the
 * CLI surface eventually shares one helper shape.
 */
export function trapProcessExit(): {
  exitCodes: number[]
} {
  const exitCodes: number[] = []
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    const c = typeof code === "number" ? code : 0
    exitCodes.push(c)
    return undefined as never
  }) as never)
  return { exitCodes }
}

/**
 * Shared malformed `--limit` fuzz set used by every CLI parse-failure
 * `it.each`. Centralizing the array means a parse-helper change that
 * narrows or widens what counts as malformed updates every command's
 * test-bed in lockstep — drift between `tasks.test.ts`,
 * `search.test.ts`, `mine.test.ts`, and `conflicts.test.ts` would let
 * the parse helpers diverge silently.
 *
 * The list captures three classes of regex-rejected input across seven
 * entries:
 * - **Out-of-range integers**: `"0"` (positive-integer guard),
 *   `"-1"` (leading-sign).
 * - **Coercion-prone strings**: `"3.7"` (fractional), `"3abc"`
 *   (trailing alpha), `"1e3"` (exponent), `"+5"` (leading `+`).
 * - **Non-numeric**: `"banana"` (no digits).
 *
 * The empty string `""` is deliberately NOT included — `parseInt("")`
 * returns `NaN` rather than a number, so the parse path differs
 * subtly. Cover it as its own `it()` test so a regression that
 * mishandles empty surfaces clearly instead of melting into the
 * fuzz-array assertion.
 *
 * Over-cap values (e.g. `"9999"` for reconcile's `MAX_RECONCILE_LIMIT
 * = 100`) are also excluded — they're not malformed, they're
 * range-rejected with a different error message, and belong in
 * per-command tests that pin the cap-specific wording.
 */
export const INVALID_LIMIT_STRINGS = [
  "0",
  "3.7",
  "3abc",
  "1e3",
  "+5",
  "-1",
  "banana",
] as const
