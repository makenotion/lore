/**
 * Shared test-only helpers for the hook test suite.
 *
 * Exported per-file: keep this surface minimal. The original
 * extraction was driven by three call sites carrying the same
 * `RUNTIME_FORWARDED_KEYS`-shaped env save/restore pattern across the
 * hook test suite. Keeping the helper alongside the other test-only
 * code avoids dragging test machinery into production-import surfaces
 * — the file's name signals "not for runtime callers."
 */

/**
 * Snapshot the listed env keys on entry, clear them, and restore
 * on teardown. Returns `{ install, restore }` so tests can call
 * `install()` in `beforeEach` and `restore()` in `afterEach`.
 *
 * The save-restore discipline matters because vitest runs every
 * test in a file inside the same Node process: a key set inside one
 * test would leak into the next one, silently flipping branches
 * (e.g. `LORE_NOTION_TOKEN` set in test A would make test B's
 * `deriveStopAuthSource` land on `env-lore-notion-token` instead of
 * its intended branch). Clearing-then-restoring decouples each
 * test from process-global state without requiring a per-test
 * subprocess.
 *
 * Pass the keys explicitly rather than defaulting to
 * `RUNTIME_FORWARDED_KEYS` so callers see the exact surface they
 * own. Current call sites scope independently; the count is
 * intentionally not asserted in this docstring so future
 * additions / removals can't drift the documentation. The
 * background safeEnv suite passes the full forwarded list, the
 * stop-auth-source suite passes the auth-relevant subset, and the
 * digest-scheduler partition suite passes a narrower auth +
 * workspace + base-URL subset tailored to the partition contract
 * it tests.
 */
export function withClearedRuntimeEnv<K extends string>(
  keys: readonly K[],
): {
  install: () => void
  restore: () => void
} {
  let saved: Partial<Record<K, string | undefined>> = {}

  return {
    install(): void {
      saved = {}
      for (const key of keys) {
        saved[key] = process.env[key]
        delete process.env[key]
      }
    },
    restore(): void {
      for (const key of keys) {
        const prior = saved[key]
        if (prior === undefined) {
          delete process.env[key]
        } else {
          process.env[key] = prior
        }
      }
    },
  }
}
