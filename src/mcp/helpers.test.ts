import { describe, expect, it, vi } from "vitest"
import { debugLogAutoFactFailure } from "./helpers.js"

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
