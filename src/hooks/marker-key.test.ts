import { describe, expect, it } from "vitest"

import { configKey, safeFilenameSegment } from "./marker-key.js"

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

  describe("safeFilenameSegment", () => {
    // Pin the exact replacement set so a future maintainer cannot quietly
    // narrow it (allowing `/` would re-open the path-injection surface) or
    // widen it (dropping `_` would break filenames the helper has already
    // produced). Every character outside `[A-Za-z0-9_.-]` becomes `_`.
    it("replaces every character outside [A-Za-z0-9_.-] with an underscore", () => {
      expect(safeFilenameSegment("My Project/Backend")).toBe("My_Project_Backend")
      expect(safeFilenameSegment("a/b\\c:d e")).toBe("a_b_c_d_e")
      // The rocket is two UTF-16 code units flanked by two spaces, so the
      // helper's `g`-only regex (no `u` flag) produces four underscores.
      // Adding the `u` flag would collapse the surrogate pair to one
      // underscore and silently change every existing marker filename for
      // projects with emoji — keep this assertion as-is unless that
      // tradeoff is being made deliberately.
      expect(safeFilenameSegment("emoji 🚀 page")).toBe("emoji____page")
    })

    it("leaves the entire allowed charset untouched", () => {
      const allowed =
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-"
      expect(safeFilenameSegment(allowed)).toBe(allowed)
    })

    it("returns an empty string unchanged so callers never get an empty -> '_' surprise", () => {
      expect(safeFilenameSegment("")).toBe("")
    })

    it("collapses path separators so a sessionId can't escape getStateDir()", () => {
      // The same regex policy applies to lock / log / count filenames —
      // pin the path-traversal cases here so a future regex tweak that
      // re-opens `/` or `\` is caught at this layer instead of at every
      // consumer.
      expect(safeFilenameSegment("../escape")).toBe(".._escape")
      expect(safeFilenameSegment("..\\escape")).toBe(".._escape")
      expect(safeFilenameSegment("a/b/c")).toBe("a_b_c")
      expect(safeFilenameSegment("a\\b\\c")).toBe("a_b_c")
    })

    it("scrubs whitespace and shell metacharacters", () => {
      // Hostile sessionIds carrying shell metacharacters or whitespace
      // would otherwise survive into a stat / unlink path. Pin the scrub
      // here so each variant becomes an underscore.
      expect(safeFilenameSegment("a;b|c&d")).toBe("a_b_c_d")
      expect(safeFilenameSegment("a$(b)c`d`")).toBe("a__b_c_d_")
      expect(safeFilenameSegment("a\tb\nc d")).toBe("a_b_c_d")
      // NUL byte must be scrubbed — passing one through to a syscall
      // truncates the path on POSIX and trips Node's invalid-argument
      // guard rather than landing the file where the caller expected.
      expect(safeFilenameSegment("a\0b")).toBe("a_b")
    })

    it("preserves the dot literal so `..` survives but is defanged at call sites", () => {
      // `.` is in the allowed set so `..` passes through unchanged. Path
      // traversal is blocked at the call site by the fixed suffix every
      // consumer concatenates — `..` becomes `...lock`, not `..` — so
      // the segment-level scrub deliberately doesn't try to filter it.
      expect(safeFilenameSegment("..")).toBe("..")
      expect(safeFilenameSegment(".")).toBe(".")
    })

    // ---------------- Length cap (issue #200 review fix) ----------------
    //
    // A scrubbed segment without a length cap is unbounded. A hostile
    // sessionId of `"a".repeat(300)` produces a `*.lock` basename over
    // POSIX `NAME_MAX = 255 bytes`, throwing `ENAMETOOLONG` from
    // `tryAcquireSessionLock`'s `writeFileSync`. Without the cap, that
    // throw is caught by `spawnBackgroundSave`'s outer try/catch AFTER
    // the child has already been spawned — leaving an untracked
    // `claude -p` running. Pin the cap behavior here AND the orphan-
    // child kill in `background.test.ts` (or its host file) so a future
    // regression that drops either defense gets caught at the right
    // layer.

    it("returns segments at or below the cap unchanged", () => {
      // UUID-shaped session ids (36 chars) and realistic project names
      // (≤ ~100 chars) must round-trip byte-for-byte after the regex
      // scrub. Pin the boundary at exactly the cap so a future cap
      // tweak surfaces in code review.
      const uuid = "f47ac10b-58cc-4372-a567-0e02b2c3d479"
      expect(safeFilenameSegment(uuid)).toBe(uuid)

      // Exactly 128 chars, all in the allowed charset → no change.
      const at128 = "a".repeat(128)
      expect(safeFilenameSegment(at128)).toBe(at128)
      expect(safeFilenameSegment(at128).length).toBe(128)
    })

    it("truncates over-cap segments with a deterministic hash suffix", () => {
      // 300-char segment must collapse to ≤ 128 chars and end with a
      // recognizable `_<8-hex>` suffix. The truncated head plus the
      // hash makes the result deterministic for the same input.
      const huge = "a".repeat(300)
      const result = safeFilenameSegment(huge)
      expect(result.length).toBe(128)
      expect(result).toMatch(/^a+_[0-9a-f]{8}$/)
      // Determinism: two calls with the same input produce the same
      // filename. Without that, the lock writer and the lock reader
      // would address different files for the same sessionId.
      expect(safeFilenameSegment(huge)).toBe(result)
    })

    it("hashes the ORIGINAL input so two over-cap inputs that differ only in scrubbed characters still collide-distinctly", () => {
      // `aaa…/escape` and `aaa…\escape` would both scrub to `aaa…_escape`
      // and collide under cap-then-hash-of-scrubbed. Hashing the
      // original input before scrubbing prevents that — the two
      // segments must produce distinct filenames even though their
      // sanitized forms match byte-for-byte.
      const head = "a".repeat(300)
      const a = `${head}/escape`
      const b = `${head}\\escape`
      const ra = safeFilenameSegment(a)
      const rb = safeFilenameSegment(b)
      expect(ra.length).toBe(128)
      expect(rb.length).toBe(128)
      expect(ra).not.toBe(rb)
    })

    it("the cap defends against the ENAMETOOLONG path that would orphan a spawned child", () => {
      // Documentation-as-test: name the failure mode the cap exists to
      // prevent. POSIX NAME_MAX is typically 255 bytes; with the
      // longest consumer suffix (`.count`, 6 chars) the full filename
      // is ≤ 134 bytes after the cap. Without this, a 300-char
      // sessionId would land a 306-byte basename and trip the
      // syscall — see the inline review comment on PR #207.
      const longest = "a".repeat(300)
      const result = safeFilenameSegment(longest)
      expect(result.length + ".count".length).toBeLessThanOrEqual(255)
    })
  })
})
