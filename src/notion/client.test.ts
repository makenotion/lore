import { LogLevel } from "@notionhq/client"
import { describe, expect, it, vi } from "vitest"
import { resolveSdkDebugOptions, stderrSdkLogger } from "./client.js"

describe("resolveSdkDebugOptions", () => {
  it("returns null when LORE_DEBUG is unset so the SDK keeps its default LogLevel.WARN", () => {
    // Default-quiet is the contract operators rely on — adding INFO
    // to every CLI session would re-introduce stderr noise in normal
    // operation. The opt-in gate is the load-bearing rule.
    expect(resolveSdkDebugOptions({})).toBeNull()
  })

  it("returns null for non-'1' LORE_DEBUG values (no truthy interpretation)", () => {
    // We intentionally do NOT treat `LORE_DEBUG=true` /
    // `LORE_DEBUG=yes` as opt-in — the codebase's existing
    // `LORE_DEBUG=1` convention (memory.ts, near-duplicate probe) is
    // the single shape, and a parallel truthy ladder here would
    // silently diverge from it.
    expect(resolveSdkDebugOptions({ LORE_DEBUG: "0" })).toBeNull()
    expect(resolveSdkDebugOptions({ LORE_DEBUG: "true" })).toBeNull()
    expect(resolveSdkDebugOptions({ LORE_DEBUG: "" })).toBeNull()
  })

  it("returns LogLevel.INFO + the stderr logger when LORE_DEBUG=1", () => {
    // INFO is the level at which the Notion SDK emits "retrying
    // request" with `{ method, path, attempt, delayMs }` — the
    // diagnostic that distinguishes a quiet `Retry-After`-induced
    // sleep from a genuine hang. DEBUG would also expose request
    // bodies, which can leak vault content into operator-shared
    // logs; INFO is the right tradeoff.
    const opts = resolveSdkDebugOptions({ LORE_DEBUG: "1" })
    expect(opts).not.toBeNull()
    expect(opts?.logLevel).toBe(LogLevel.INFO)
    expect(opts?.logger).toBe(stderrSdkLogger)
  })
})

describe("stderrSdkLogger", () => {
  it("writes to stderr with a [lore] prefix so log aggregation patterns keep working", () => {
    // The SDK's default `makeConsoleLogger` routes INFO through
    // `console.info` → stdout in Node, which would silently
    // pollute the stdout of any CLI command piped into a parser.
    // stderr is the right destination; the `[lore]` prefix matches
    // the `[lore] partial-failure:` shape used elsewhere so a
    // single grep keeps surfacing both.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8"),
        )
        return true
      })

    stderrSdkLogger(LogLevel.INFO, "retrying request", {
      method: "POST",
      path: "/v1/data_sources/abc/query",
      attempt: 2,
      delayMs: 1000,
    })

    stderrSpy.mockRestore()

    expect(stderrChunks).toHaveLength(1)
    const line = stderrChunks[0]!
    expect(line).toMatch(/^\[lore\] notion-sdk info: retrying request /)
    expect(line).toContain('"method":"POST"')
    expect(line).toContain('"delayMs":1000')
    expect(line.endsWith("\n")).toBe(true)
  })

  it("falls back to [unserializable extraInfo] when JSON.stringify throws (e.g. circular references)", () => {
    // The "retrying request" path passes a flat
    // `{ method, path, attempt, delayMs }` and never trips this
    // branch today. The guard exists so a future SDK extra-info
    // shape carrying a circular reference (an error with a `cause`
    // chain pointing back at itself, a request object holding a
    // reference to its own response) cannot turn the diagnostic
    // logger into the source of a CLI crash.
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8"),
        )
        return true
      })

    const circular: Record<string, unknown> = {}
    circular["self"] = circular

    expect(() =>
      stderrSdkLogger(LogLevel.WARN, "circular extra", circular),
    ).not.toThrow()

    stderrSpy.mockRestore()

    expect(stderrChunks).toEqual([
      "[lore] notion-sdk warn: circular extra [unserializable extraInfo]\n",
    ])
  })

  it("omits the JSON suffix when extraInfo is empty so plain messages stay readable", () => {
    const stderrChunks: string[] = []
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrChunks.push(
          typeof chunk === "string"
            ? chunk
            : Buffer.from(chunk as Uint8Array).toString("utf8"),
        )
        return true
      })

    stderrSdkLogger(LogLevel.WARN, "hello", {})

    stderrSpy.mockRestore()

    expect(stderrChunks).toEqual(["[lore] notion-sdk warn: hello\n"])
  })
})
