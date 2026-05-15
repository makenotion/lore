import type { Memory } from "../types.js"
import { redactDebugError } from "../debug-redact.js"
import type { UpstreamVaultBundle } from "./topology-readers.js"

export interface InheritedMemorySection {
  /** Configured upstream label (display name from .lore.yaml). */
  label: string
  /** Configured upstream page id. */
  pageId: string
  /** Bounded slice of recently-edited memories from this upstream. */
  memories: Memory[]
  /**
   * Underlying error message when the upstream load or query
   * failed; `null` on success. **Pre-redacted at capture** via
   * `redactDebugError` (or the safe-redact fallback when the
   * thrown value's `toString()` throws — see
   * `loadInheritedMemorySections`), so the field is safe to
   * surface on any downstream consumer (MCP renderer, CLI status
   * dumper, eval harness, debug log) without re-applying
   * redaction at every boundary. Notion request IDs and
   * page-id-shaped substrings are scrubbed before the value
   * reaches this field; a pathological rejection degrades to the
   * literal `<unrenderable upstream error>` sentinel.
   */
  error: string | null
}

export async function loadInheritedMemorySections(
  upstreams: readonly UpstreamVaultBundle[],
  perUpstreamLimit: number,
  includeContent: boolean
): Promise<InheritedMemorySection[]> {
  // Per-upstream `Promise.allSettled` + unwrap: a single upstream
  // failure (auth, missing databases, transient 5xx) MUST NOT
  // take down the whole inherited block. Each upstream that
  // fails surfaces as a section carrying its own `error` message
  // so the operator can triage which upstream is broken without
  // losing the others. Same posture as
  // `loadVaultTopologyStatus`'s probe fan-out: each upstream's
  // failure is isolated to that upstream.
  //
  // **`allSettled` is load-bearing here, not defensive.**
  // `redactDebugError` propagates a throw when the thrown value's
  // `toString()` itself throws. The inner try/catch calls
  // `redactDebugError(err)` in its catch branch, so an exotic
  // `toString`-throwing rejection from `bundle.loadReaders()` or
  // `readers.memories.list()` would re-throw inside the mapper.
  // Under `Promise.all` that re-throw would reject the whole
  // fan-out and take down wake-up. `allSettled` always resolves;
  // the post-loop unwrap maps any rejection (including a re-throw
  // from `redactDebugError`) to a section value with `safeRedact`
  // (which catches the re-throw itself), so the failure isolation
  // contract holds for the full pathological-error chain.
  //
  // **Errors are redacted at capture**, not at the renderer
  // boundary. `WakeUpData` is a public shape; a future caller
  // that surfaces `inheritedMemories[].error` outside the MCP
  // renderer (a CLI status dumper, an eval harness, a debug
  // log) inherits the same scrubbing posture without
  // re-applying redaction at every boundary.
  const results = await Promise.allSettled(
    upstreams.map(async (bundle): Promise<InheritedMemorySection> => {
      try {
        const readers = await bundle.loadReaders()
        if (readers === null) {
          return {
            label: bundle.label,
            pageId: bundle.pageId,
            memories: [],
            error: safeRedact(bundle.lastError ?? "upstream vault unavailable"),
          }
        }
        // Upstream taxonomies do NOT share project ids with the
        // primary — a `projectId` filter would reject every row. The
        // fan-out is vault-wide on the upstream, capped at
        // `perUpstreamLimit` rows by recency, sorted via the default
        // `last_edited_time desc`. The narrow cap is what keeps the
        // prompt-noise multiplier in check.
        const result = await readers.memories.list({
          limit: perUpstreamLimit,
          includeContent,
        })
        return {
          label: bundle.label,
          pageId: bundle.pageId,
          memories: result.items,
          error: null,
        }
      } catch (err) {
        return {
          label: bundle.label,
          pageId: bundle.pageId,
          memories: [],
          error: safeRedact(err),
        }
      }
    })
  )
  return results.map((result, index): InheritedMemorySection => {
    if (result.status === "fulfilled") return result.value
    // Unwrap path. Reachable when `redactDebugError` itself
    // re-throws on a `toString`-throwing rejection (see the
    // surrounding rationale). `safeRedact` swallows its own
    // throws so the failure-isolation contract holds even when
    // the redactor can't format the rejection value at all.
    const bundle = upstreams[index]!
    return {
      label: bundle.label,
      pageId: bundle.pageId,
      memories: [],
      error: safeRedact(result.reason),
    }
  })
}

/**
 * Redact a value for surfacing on `WakeUpData.inheritedMemories[].error`
 * without ever throwing. `redactDebugError` calls `String(error)`
 * in its fallback path, which propagates a thrown `toString` — an
 * unavoidable consequence of being a general-purpose formatter.
 * For the wake-up capture site, a throwing formatter would cascade
 * into rejecting `Promise.allSettled`'s unwrap and (in `Promise.all`
 * shape) the whole fan-out. This wrapper traps any throw and falls
 * back to the literal `<unrenderable upstream error>` sentinel so
 * the section's `error` field is always a safe string.
 */
function safeRedact(error: unknown): string {
  try {
    return redactDebugError(error)
  } catch {
    return "<unrenderable upstream error>"
  }
}
