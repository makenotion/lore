import { describe, expect, it } from "vitest"

import { configKey, safeProjectName } from "./marker-key.js"

describe("marker-key", () => {
  describe("configKey", () => {
    // Pin the truncation length so a future change to the slice() argument
    // is a deliberate, reviewable edit instead of a one-character tweak.
    // Every filesystem marker that keys on a config root inherits this
    // length, so a silent bump would shorten or lengthen every marker file
    // name in lockstep and invalidate every existing debounce window.
    it("returns exactly 8 lowercase hex characters", () => {
      const key = configKey("/some/config/root")
      expect(key).toMatch(/^[0-9a-f]{8}$/)
      expect(key).toHaveLength(8)
    })

    it("is deterministic for the same input", () => {
      expect(configKey("/repo/main")).toBe(configKey("/repo/main"))
    })

    it("normalizes paths so relative and absolute forms of the same root collide", () => {
      // The helper feeds the input through `path.resolve()` before hashing
      // so a marker keyed from `cwd` and one keyed from the equivalent
      // absolute path land on the same suppression window.
      const absolute = configKey(process.cwd())
      const relative = configKey(".")
      expect(relative).toBe(absolute)
    })

    it("produces different keys for different roots", () => {
      // A collision here would re-introduce the cross-vault bug the keying
      // exists to prevent — pin the property even though sha256 makes it
      // overwhelmingly likely by construction.
      expect(configKey("/vault-a")).not.toBe(configKey("/vault-b"))
    })
  })

  describe("safeProjectName", () => {
    // Pin the exact replacement set so a future maintainer cannot quietly
    // narrow it (allowing `/` would re-open the path-injection surface) or
    // widen it (dropping `_` would break filenames the helper has already
    // produced). Every character outside `[A-Za-z0-9_.-]` becomes `_`.
    it("replaces every character outside [A-Za-z0-9_.-] with an underscore", () => {
      expect(safeProjectName("My Project/Backend")).toBe("My_Project_Backend")
      expect(safeProjectName("a/b\\c:d e")).toBe("a_b_c_d_e")
      // The rocket is two UTF-16 code units flanked by two spaces, so the
      // helper's `g`-only regex (no `u` flag) produces four underscores.
      // Adding the `u` flag would collapse the surrogate pair to one
      // underscore and silently change every existing marker filename for
      // projects with emoji — keep this assertion as-is unless that
      // tradeoff is being made deliberately.
      expect(safeProjectName("emoji 🚀 page")).toBe("emoji____page")
    })

    it("leaves the entire allowed charset untouched", () => {
      const allowed =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-"
      expect(safeProjectName(allowed)).toBe(allowed)
    })

    it("returns an empty string unchanged so callers never get an empty -> '_' surprise", () => {
      expect(safeProjectName("")).toBe("")
    })
  })
})
