import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  debugLogAutoFactFailure,
  debugLogContradictionFailure,
  debugLogFactTouchFailure,
  debugLogPartialFailures,
  debugLogTouchFailure,
  toolError,
} from "./helpers.js"
import { WriteBudgetExceededError } from "../notion/rate-limit.js"
import { LoreError } from "../errors.js"

// Wrapper around `vi.spyOn(process.stderr, "write")` that returns the
// spy at the loose `MockInstance` shape vitest infers. The
// `WriteStream.write(...)` overload set doesn't unify cleanly with
// the `vi.spyOn<T, K>` generic, so a type-literal annotation on the
// `let stderr` variable wouldn't compile; pulling the call into a
// helper lets `ReturnType<typeof spyStderr>` resolve through TS's
// inference path instead.
function spyStderr() {
  return vi.spyOn(process.stderr, "write").mockImplementation(() => true)
}

describe("toolError", () => {
  it("redacts sensitive substrings before returning MCP error content", () => {
    const pageId = "abcdef0123456789abcdef0123456789"
    const token = "secret_aaaaaaaaaaaaaaaaaaaaaaaa"
    const result = toolError(
      new Error(
        `APIError body={"token":"${token}","page":"${pageId}"} page=${pageId} headers={Authorization: Bearer ${token}} status=500`
      )
    )

    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: "Error: APIError body=<redacted> page=<page-id> headers=<redacted> status=500",
        },
      ],
      isError: true,
    })
    expect(result.content[0].text).not.toContain(pageId)
    expect(result.content[0].text).not.toContain(token)
  })

  it("redacts thrown non-Error values before returning MCP error content", () => {
    const pageId = "fedcba9876543210fedcba9876543210"
    const result = toolError(`Failed to load page ${pageId}`)

    expect(result).toEqual({
      content: [{ type: "text", text: "Error: Failed to load page <page-id>" }],
      isError: true,
    })
  })

  it("keeps retryable metadata while redacting the user-visible message", () => {
    const pageId = "abcdef0123456789abcdef0123456789"
    const err = new Error(`Transient failure for page ${pageId}`) as Error & {
      code: string
      retryable: true
    }
    err.code = "project_scope_retry"
    err.retryable = true

    const result = toolError(err)

    expect(result.content[0].text).toBe(
      'Error: Transient failure for page <page-id>\n\n```json\n{"code":"project_scope_retry","retryable":true}\n```'
    )
    expect(result.content[0].text).not.toContain(pageId)
  })

  it("does not truncate recovery guidance in MCP error content", () => {
    const pageId = "abcdef0123456789abcdef0123456789"
    const recovery = `${"Inspect the saved row before retrying. ".repeat(20)}final recovery marker`
    const result = toolError(new Error(`Partial failure on ${pageId}. ${recovery}`))

    expect(result.content[0].text).toContain("<page-id>")
    expect(result.content[0].text).not.toContain(pageId)
    expect(result.content[0].text).toContain("final recovery marker")
    expect(result.content[0].text).not.toContain("…(truncated)")
  })

  it("preserves write-budget errors verbatim", () => {
    const err = new WriteBudgetExceededError(
      "lore-memory.abcdef0123456789abcdef0123456789",
      10,
      11
    )

    expect(toolError(err)).toEqual({
      content: [{ type: "text", text: err.message }],
      isError: true,
    })
  })

  it("renders LoreError kind and redacted details as structured metadata", () => {
    const pageId = "abcdef0123456789abcdef0123456789"
    const token = "secret_aaaaaaaaaaaaaaaaaaaaaaaa"
    const err = new LoreError("memory-create-partial", `Partial failure on ${pageId}`, {
      pageId,
      cleanedUp: false,
      bodyWriteCauseMessage: `body=${JSON.stringify({ token, pageId })}`,
      cleanupCauseMessage: `headers={Authorization: Bearer ${token}}`,
    })

    const result = toolError(err)
    const text = result.content[0].text

    expect(text).toContain("Error: Partial failure on <page-id>")
    expect(text).toContain('"kind":"memory-create-partial"')
    expect(text).toContain('"pageId":"<page-id>"')
    expect(text).toContain('"bodyWriteCauseMessage":"body=<redacted>"')
    expect(text).toContain('"cleanupCauseMessage":"headers=<redacted>"')
    expect(text).not.toContain(pageId)
    expect(text).not.toContain(token)
  })
})

describe("debugLogAutoFactFailure (0.8.0/07)", () => {
  it("is a no-op when LORE_DEBUG is unset (zero stderr writes)", () => {
    // The helper exists for opt-in operator observability — running
    // without `LORE_DEBUG=1` must not flood stderr on every save
    // because the auto-emit branch fans out per-entity. Same posture
    // as `debugLogPartialFailures`.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("LORE_DEBUG", "")
    try {
      debugLogAutoFactFailure("save", "mem-1", "PR #1234", new Error("notion 429"))
      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("writes one stderr line under LORE_DEBUG=1 with source/kind/memoryId/entity/error fields", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("LORE_DEBUG", "1")
    try {
      debugLogAutoFactFailure("save", "mem-1", "PR #1234", new Error("notion 429"))
      expect(write).toHaveBeenCalledTimes(1)
      const line = write.mock.calls[0][0] as string
      // `kind` defaults to `create` for the save-time call site; the
      // field is always present so log parsers can rely on a stable
      // key set across both save creates and update creates /
      // invalidates (issue #491).
      expect(line).toBe(
        "[lore] auto-fact-failure: source=save kind=create memoryId=mem-1 entity=PR #1234 error=notion 429\n"
      )
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("emits kind=invalidate for the stale-fact invalidate path on update (issue #491)", () => {
    // Diff-and-invalidate on update needs a separate failure
    // discriminator from the per-entity create path so an operator
    // grepping `auto-fact-failure: kind=invalidate` can isolate
    // sustained issues with the invalidate write from transient
    // dedup races on create.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("LORE_DEBUG", "1")
    try {
      debugLogAutoFactFailure(
        "update",
        "mem-1",
        "PR #1234",
        new Error("notion 503"),
        "invalidate"
      )
      const line = write.mock.calls[0][0] as string
      expect(line).toContain("source=update")
      expect(line).toContain("kind=invalidate")
      expect(line).toContain("memoryId=mem-1")
      expect(line).toContain("entity=PR #1234")
      expect(line).toContain("error=notion 503")
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("carries source=update for the diff-driven re-emission landed via DEFERRED-03 + #491", () => {
    // `update` is the call-site discriminator for the re-emission
    // path landed via DEFERRED-03 (and reshaped by issue #491 from
    // add-only into symmetric diff-and-invalidate) — pin the value
    // here so the helper's union doesn't drift if a future
    // contributor renames the call site.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("LORE_DEBUG", "1")
    try {
      debugLogAutoFactFailure("update", "mem-2", "AuthService", new Error("dedup race"))
      const line = write.mock.calls[0][0] as string
      expect(line).toContain("source=update")
      expect(line).toContain("memoryId=mem-2")
      expect(line).toContain("entity=AuthService")
      expect(line).toContain("error=dedup race")
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("stringifies non-Error rejections so a thrown string still surfaces", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("LORE_DEBUG", "1")
    try {
      debugLogAutoFactFailure("save", "mem-3", "Foo", "bare-string-throw")
      const line = write.mock.calls[0][0] as string
      expect(line).toContain("error=bare-string-throw")
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("replaces ASCII control characters in interpolated fields with spaces (one-event-per-line)", () => {
    // Log aggregators rely on newline-delimited events; if a future
    // tokenizer or memory-id source surfaces a `\n` or `\t` we must
    // not split one logical failure into multiple parsed records.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("LORE_DEBUG", "1")
    try {
      debugLogAutoFactFailure(
        "save",
        "mem\n4",
        "Foo\tBar",
        new Error("multi\nline\rerror")
      )
      const line = write.mock.calls[0][0] as string
      // Exactly one terminating newline; control chars in the body
      // collapsed to spaces.
      expect(line.endsWith("\n")).toBe(true)
      expect(line.split("\n")).toHaveLength(2)
      expect(line).toContain("memoryId=mem 4")
      expect(line).toContain("entity=Foo Bar")
      expect(line).toContain("error=multi line error")
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })
})

describe("debugLogContradictionFailure", () => {
  // Pin the log shape so log aggregators / `grep "[lore]"` parsers can
  // match on the prefix and the canonical key names.

  it("is a no-op when LORE_DEBUG is unset (default operator posture)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    try {
      delete process.env.LORE_DEBUG
      debugLogContradictionFailure("invalidate", "mem-1", new Error("boom"))
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
  })

  it("writes one stderr line under LORE_DEBUG=1 with the full key set", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      debugLogContradictionFailure("invalidate", "mem-1", new Error("boom"))
      expect(stderr).toHaveBeenCalledTimes(1)
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toBe(
        "[lore] contradiction-failure: source=invalidate memoryId=mem-1 error=boom\n"
      )
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })

  it("renders each source discriminator literally", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      debugLogContradictionFailure("supersede", "dec-1", new Error("e1"))
      debugLogContradictionFailure("decide-supersede", "dec-2", new Error("e2"))
      const lines = stderr.mock.calls.map(([l]) => String(l))
      expect(lines[0]).toContain("source=supersede")
      expect(lines[1]).toContain("source=decide-supersede")
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })

  it("collapses embedded control characters into spaces (one failure = one log line)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      // A multi-line error message would otherwise break the
      // newline-delimited contract that log aggregators rely on.
      debugLogContradictionFailure(
        "invalidate",
        "mem-1",
        new Error("line one\nline two\ttab")
      )
      expect(stderr).toHaveBeenCalledTimes(1)
      const line = String(stderr.mock.calls[0]![0])
      // Exactly one trailing newline; control chars in the middle are
      // coerced to spaces.
      expect(line.split("\n")).toHaveLength(2)
      expect(line).toContain("error=line one line two tab")
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })

  it("stringifies non-Error values via String()", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      debugLogContradictionFailure("invalidate", "mem-1", "raw string")
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toContain("error=raw string")
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })
})

describe("LORE_DEBUG redaction routing (issue #488)", () => {
  // Pins the contract that every LORE_DEBUG-gated stderr emitter in
  // this module routes its error message through `redactDebugError`
  // before writing. Page-id-shaped substrings and forward-compatible
  // SDK leak shapes (`body=`, `headers=`) are scrubbed; the
  // `root=<id>` / `memoryId=<id>` / `entity=<id>` explicit fields are
  // intentionally NOT redacted because operators need them for
  // triage. Coverage of one helper per shape is sufficient — the
  // routing is the contract, not the per-helper plumbing.

  it("debugLogPartialFailures redacts page-id substrings in error messages but keeps explicit root id intact", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      const id = "abcdef0123456789abcdef0123456789"
      const rootId = "fedcba9876543210fedcba9876543210"
      debugLogPartialFailures("lore-memory", [
        { rootId, error: new Error(`Failed to load page ${id}`) },
      ])
      const line = String(stderr.mock.calls[0]![0])
      // The 32-char hex inside the error message is redacted...
      expect(line).toContain("error=Failed to load page <page-id>")
      // ...but the explicit root field still carries the operator-actionable id.
      expect(line).toContain(`root=${rootId}`)
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })

  it("debugLogPartialFailures strips forward-compatible SDK body= leaks", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      debugLogPartialFailures("lore-memory", [
        {
          rootId: "root-id",
          error: new Error('APIError body={"page":"secret"} status=500'),
        },
      ])
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toContain("body=<redacted>")
      expect(line).not.toContain('"secret"')
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })

  it("debugLogAutoFactFailure routes through the redactor too (single-pass coverage)", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      const id = "abcdef0123456789abcdef0123456789"
      debugLogAutoFactFailure(
        "save",
        "mem-1",
        "PR #1234",
        new Error(`unable to read ${id}`)
      )
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toContain("error=unable to read <page-id>")
      // Explicit field is still readable.
      expect(line).toContain("memoryId=mem-1")
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })

  it("debugLogContradictionFailure routes through the redactor too", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      const id = "abcdef0123456789abcdef0123456789"
      debugLogContradictionFailure(
        "invalidate",
        "mem-1",
        new Error(`page ${id} access denied`)
      )
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toContain("error=page <page-id> access denied")
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })

  it("debugLogTouchFailure routes through the redactor too", () => {
    // Coverage parity with the other LORE_DEBUG emitters in this
    // module — the touch path fires on every read citation, so an
    // SDK error carrying a page id under load would otherwise rain
    // recon-grade detail into stderr.
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      const id = "abcdef0123456789abcdef0123456789"
      debugLogTouchFailure("lore-query", "mem-7", new Error(`page ${id} 429`))
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toContain("error=page <page-id> 429")
      expect(line).toContain("memory=mem-7")
      expect(line).toContain("tool=lore-query")
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })

  it("debugLogFactTouchFailure routes through the redactor too", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      const id = "abcdef0123456789abcdef0123456789"
      debugLogFactTouchFailure("lore-query", "fact-3", new Error(`fact ${id}`))
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toContain("error=fact <page-id>")
      expect(line).toContain("fact=fact-3")
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })

  describe("clean messages pass through unchanged; explicit fields remain readable", () => {
    // Negative coverage per routing site — a regression that
    // accidentally over-redacts the explicit `root=` / `memoryId=` /
    // `entity=` / `fact=` interpolations would silently break operator
    // triage. Pin the safe-passthrough contract per emitter.
    //
    // Each test saves the prior `LORE_DEBUG` value and restores it in
    // `finally` so a vitest run that already had the env var set
    // (e.g. an outer harness, a watch-mode rerun, or a sibling test
    // that leaked the gate state) doesn't see its value silently
    // deleted out from under it. Mirrors the defensive shape used in
    // `auth/identity.test.ts` and `notion/client.test.ts`.

    let priorDebug: string | undefined
    // Vitest's `MockInstance` generic doesn't unify with the
    // overloaded `WriteStream.write(...)` signature, so the spy is
    // typed via the helper's return shape rather than the
    // narrower `vi.spyOn<...>` form.
    let stderr: ReturnType<typeof spyStderr>

    beforeEach(() => {
      priorDebug = process.env["LORE_DEBUG"]
      process.env["LORE_DEBUG"] = "1"
      stderr = spyStderr()
    })

    afterEach(() => {
      stderr.mockRestore()
      if (priorDebug === undefined) {
        delete process.env["LORE_DEBUG"]
      } else {
        process.env["LORE_DEBUG"] = priorDebug
      }
    })

    it("debugLogPartialFailures with a clean message preserves rootId and tool", () => {
      debugLogPartialFailures("lore-memory", [
        { rootId: "root-id-1", error: new Error("notion 429") },
      ])
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toBe(
        "[lore] partial-failure: root=root-id-1 error=notion 429 tool=lore-memory\n"
      )
    })

    it("debugLogAutoFactFailure with a clean message preserves memoryId and entity", () => {
      debugLogAutoFactFailure("save", "mem-1", "PR #1234", new Error("notion 429"))
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toBe(
        "[lore] auto-fact-failure: source=save kind=create memoryId=mem-1 entity=PR #1234 error=notion 429\n"
      )
    })

    it("debugLogContradictionFailure with a clean message preserves source and memoryId", () => {
      debugLogContradictionFailure("invalidate", "mem-1", new Error("notion 429"))
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toBe(
        "[lore] contradiction-failure: source=invalidate memoryId=mem-1 error=notion 429\n"
      )
    })

    it("debugLogTouchFailure with a clean message preserves memory id and tool", () => {
      debugLogTouchFailure("lore-query", "mem-1", new Error("notion 429"))
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toBe(
        "[lore] touch-failure: memory=mem-1 error=notion 429 tool=lore-query\n"
      )
    })

    it("debugLogFactTouchFailure with a clean message preserves fact id and tool", () => {
      debugLogFactTouchFailure("lore-query", "fact-1", new Error("notion 429"))
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toBe(
        "[lore] fact-touch-failure: fact=fact-1 error=notion 429 tool=lore-query\n"
      )
    })
  })
})
