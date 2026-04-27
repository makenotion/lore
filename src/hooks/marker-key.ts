/**
 * Shared key derivation for filesystem debounce markers under `src/hooks/`.
 *
 * Both `digest-marker.ts` and `drift-marker.ts` (and any future marker that
 * needs the same shape) hash their config root through `configKey` and
 * sanitize free-form name segments through `safeProjectName`. Keeping the
 * helpers here means a future change to the truncation length or the
 * sanitization charset lands in one place — without this module, two
 * byte-identical helpers would silently drift the moment one of them is
 * tweaked.
 *
 * The module intentionally depends only on `node:crypto` and `node:path` so
 * it never creates an import cycle with the marker modules that consume it,
 * and so it stays orthogonal to the state-dir resolution that lives in
 * `lock.ts`.
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
 * Replace every character outside `[A-Za-z0-9_.-]` with an underscore so a
 * free-form project name can be embedded in a marker filename without path
 * injection or shell-metacharacter surprises. Decoupled from any specific
 * id format (e.g. Notion page ids) so it stays useful when a marker keys
 * on a human-supplied label.
 *
 * The regex is intentionally `g`-only — adding the `u` flag would collapse
 * each surrogate pair (e.g. `🚀`) to a single underscore and silently
 * invalidate every existing marker filename for projects whose name
 * contains emoji or other supplementary-plane characters. Don't add `u`
 * unless that migration is being made deliberately.
 */
export function safeProjectName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, "_")
}
