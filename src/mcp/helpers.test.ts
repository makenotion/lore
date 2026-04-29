import { describe, expect, it, vi } from "vitest"

import {
  debugLogAutoFactFailure,
  debugLogContradictionFailure,
} from "./helpers.js"

describe("debugLogAutoFactFailure (0.8.0/07)", () => {
  it("is a no-op when LORE_DEBUG is unset (zero stderr writes)", () => {
    // The helper exists for opt-in operator observability — running
    // without `LORE_DEBUG=1` must not flood stderr on every save
    // because the auto-emit branch fans out per-entity. Same posture
    // as `debugLogPartialFailures`.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("LORE_DEBUG", "")
    try {
      debugLogAutoFactFailure(
        "save",
        "mem-1",
        "PR #25750",
        new Error("notion 429"),
      )
      expect(write).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("writes one stderr line under LORE_DEBUG=1 with source/memoryId/entity/error fields", () => {
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("LORE_DEBUG", "1")
    try {
      debugLogAutoFactFailure(
        "save",
        "mem-1",
        "PR #25750",
        new Error("notion 429"),
      )
      expect(write).toHaveBeenCalledTimes(1)
      const line = write.mock.calls[0][0] as string
      expect(line).toBe(
        "[lore] auto-fact-failure: source=save memoryId=mem-1 entity=PR #25750 error=notion 429\n",
      )
    } finally {
      vi.unstubAllEnvs()
      write.mockRestore()
    }
  })

  it("carries source=update for the deferred re-emission follow-up's eventual call site", () => {
    // `update` is reserved for DEFERRED-03's eventual re-emission
    // path — pinning the value here so the helper's union doesn't
    // need a parameter rename when that work lands.
    const write = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    vi.stubEnv("LORE_DEBUG", "1")
    try {
      debugLogAutoFactFailure(
        "update",
        "mem-2",
        "AuthService",
        new Error("dedup race"),
      )
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
        new Error("multi\nline\rerror"),
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
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    try {
      delete process.env.LORE_DEBUG
      debugLogContradictionFailure("invalidate", "mem-1", new Error("boom"))
      expect(stderr).not.toHaveBeenCalled()
    } finally {
      stderr.mockRestore()
    }
  })

  it("writes one stderr line under LORE_DEBUG=1 with the full key set", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      debugLogContradictionFailure("invalidate", "mem-1", new Error("boom"))
      expect(stderr).toHaveBeenCalledTimes(1)
      const line = String(stderr.mock.calls[0]![0])
      expect(line).toBe(
        "[lore] contradiction-failure: source=invalidate memoryId=mem-1 error=boom\n",
      )
    } finally {
      delete process.env.LORE_DEBUG
      stderr.mockRestore()
    }
  })

  it("renders each source discriminator literally", () => {
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
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
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
    process.env.LORE_DEBUG = "1"
    try {
      // A multi-line error message would otherwise break the
      // newline-delimited contract that log aggregators rely on.
      debugLogContradictionFailure(
        "invalidate",
        "mem-1",
        new Error("line one\nline two\ttab"),
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
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true)
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
