/**
 * Shared key derivation for filesystem state under `src/hooks/`.
 *
 * Every hook-state filename (debounce markers in `digest-marker.ts` /
 * `drift-marker.ts`, per-session lock + log + count files in `lock.ts` /
 * `helpers.ts`, the synthetic digest lock key in `digest-scheduler.ts`)
 * lands inside `getStateDir()` and is built by string-concatenating a
 * free-form key with a fixed suffix. Without one shared sanitizer that
 * policy drifts the moment two callers re-implement the regex, and a
 * hostile or malformed key can either escape the state dir via path
 * separators or trip filesystem `NAME_MAX` limits via unbounded length
 * — the latter throws `ENAMETOOLONG` from `tryAcquireSessionLock`'s
 * `writeFileSync` and would orphan an already-spawned `claude -p`
 * child without `safeFilenameSegment`'s length cap.
 *
 * `configKey` hashes a config root to a short stable id; `safeFilenameSegment`
 * scrubs and length-caps a free-form name segment to a filesystem-safe shape.
 * Keeping both helpers here means a future change to the truncation length or
 * the sanitization charset lands in one place.
 *
 * The module intentionally depends only on `node:crypto` and `node:path` so
 * it never creates an import cycle with the marker / lock modules that
 * consume it, and so it stays orthogonal to the state-dir resolution that
 * lives in `lock.ts`.
 */

import { createHash } from "node:crypto"
import { resolve as resolvePath } from "node:path"

/**
 * Short, stable, filesystem-safe key derived from a config root.
 *
 * Truncated to 8 hex chars (~4.3 billion variants) because collisions
 * across an operator's own config roots are a theoretical concern and we
 * prefer short filenames. If a future change decides 8 chars is too short,
 * bump this constant — every marker that keys on a config root picks the
 * change up automatically.
 */
export function configKey(configRoot: string): string {
  return createHash("sha256").update(resolvePath(configRoot)).digest("hex").slice(0, 8)
}

/**
 * Maximum length of a sanitized filename segment, in characters. Picked so
 * (a) UUID-shaped Claude Code session ids (36 chars) round-trip unchanged,
 * (b) realistic operator-supplied project names (≤ ~100 chars in the wild)
 * also round-trip unchanged, and (c) the longest consumer suffix
 * (`.last` / `.count` — 5 chars) plus the cap stays well under POSIX
 * `NAME_MAX = 255 bytes`. A pathological input over the cap is truncated
 * and a deterministic 8-hex-char hash of the *original* segment is
 * appended so two oversized segments that differ only in the truncated
 * tail still produce distinct filenames.
 */
const MAX_SEGMENT_LENGTH = 128

/** Length of the deterministic hash suffix appended on truncation. */
const TRUNCATE_HASH_LENGTH = 8

/**
 * Replace every character outside `[A-Za-z0-9_.-]` with an underscore so a
 * free-form name segment (project name, session id, anything operator- or
 * host-supplied) can be embedded in a hook-state filename without path
 * injection or shell-metacharacter surprises. Decoupled from any specific
 * id format so it stays useful across markers, locks, logs, and counters.
 *
 * Length-capped at `MAX_SEGMENT_LENGTH` characters. A segment within the
 * cap round-trips byte-for-byte after the regex scrub (the common case for
 * UUID-shaped session ids and reasonable project names). A segment over
 * the cap is truncated to fit and a short sha256-derived suffix is
 * appended so two long segments that differ only past the truncation
 * boundary still hash to distinct filenames — without that, a hostile
 * caller could force two over-cap session ids onto one `.lock` file and
 * deliberately starve the second save's debounce window. The cap also
 * prevents `ENAMETOOLONG` from propagating out of
 * `tryAcquireSessionLock`'s `writeFileSync`, which (under the pre-cap
 * shape) would be caught by `spawnBackgroundSave`'s outer try/catch
 * AFTER the child had already been spawned — leaving an untracked
 * background `claude -p` running and silently spending tokens.
 *
 * `..` survives the scrub (both `.` chars are in the allowed set) but is
 * defanged at the call site — every consumer concatenates a fixed suffix
 * (`.lock`, `.log`, `.count`, `.last`) onto the segment, so a `..` key
 * becomes a literal filename like `...lock` rather than a parent-directory
 * reference. Path separators (`/`, `\`) and shell metacharacters are the
 * actual escape characters the regex collapses.
 *
 * The regex is intentionally `g`-only — adding the `u` flag would collapse
 * each surrogate pair (e.g. `🚀`) to a single underscore and silently
 * invalidate every existing marker filename for projects whose name
 * contains emoji or other supplementary-plane characters. Don't add `u`
 * unless that migration is being made deliberately.
 *
 * **POSIX-only.** Lore is POSIX-targeted (`process.kill` PID liveness
 * probe, `os.tmpdir()` state-dir convention, Stop-hook lifecycle); this
 * sanitizer reflects that. Windows OS-reserved device names (`CON`,
 * `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) pass through the
 * regex unchanged because every character is in the allowed set, so a
 * sessionId of `CON` would land as `CON.lock` — which on NTFS resolves
 * to a device handle, not a file. If Lore ever ships a Windows-targeted
 * hook runner, layer a reserved-name check on top of this regex at the
 * same boundary; don't widen the regex itself, because the case-
 * insensitive Windows reserved set isn't something a regex over the
 * allowed charset can express cleanly.
 */
export function safeFilenameSegment(name: string): string {
  const scrubbed = name.replace(/[^A-Za-z0-9_.-]/g, "_")
  if (scrubbed.length <= MAX_SEGMENT_LENGTH) return scrubbed
  // Hash the ORIGINAL input (not the scrubbed form) so two over-cap
  // names that differ only in characters the regex would have collapsed
  // (e.g. `aaa…/escape` vs. `aaa…\escape`) still produce distinct hashes
  // and therefore distinct lock files.
  const hash = createHash("sha256")
    .update(name)
    .digest("hex")
    .slice(0, TRUNCATE_HASH_LENGTH)
  // Reserve room for the `_<hash>` suffix.
  const head = scrubbed.slice(0, MAX_SEGMENT_LENGTH - TRUNCATE_HASH_LENGTH - 1)
  return `${head}_${hash}`
}
