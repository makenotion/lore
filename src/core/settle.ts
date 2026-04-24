/**
 * Partial-results helper for read-path fan-outs.
 *
 * Fan-out paths like `resolveCanonicalDecisionLinks` issue many Notion
 * reads in parallel. With plain `Promise.all`, a single rejection
 * (transient Notion 5xx, a missing page, a genuinely stale root) sinks
 * the whole call — the user gets no answer for any of their entities.
 *
 * `settleAll` is a keyed `Promise.allSettled` wrapper that splits the
 * fan-out into fulfilled and failed buckets. Callers iterate
 * `fulfilled` for the normal path and surface `failures` as warnings
 * on the tool response — a partial answer that names what was missed
 * beats an opaque error banner every time.
 */

export interface SettleResult<K, T> {
  fulfilled: Array<readonly [K, T]>
  failures: Array<{ key: K; error: unknown }>
}

/**
 * Run every `(key, promise)` pair to completion and bucket the results.
 *
 * `keyed` is a list of `[key, promise]` pairs — not a map — so keys are
 * allowed to repeat and iteration order is preserved. Callers that want
 * to key on objects (not strings) get exactly that without an extra
 * identity hoop.
 */
export async function settleAll<K, T>(
  keyed: Array<readonly [K, Promise<T>]>,
): Promise<SettleResult<K, T>> {
  const settled = await Promise.allSettled(keyed.map(([, promise]) => promise))
  const fulfilled: Array<readonly [K, T]> = []
  const failures: Array<{ key: K; error: unknown }> = []

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i]
    const [key] = keyed[i]
    if (result.status === "fulfilled") {
      fulfilled.push([key, result.value] as const)
    } else {
      failures.push({ key, error: result.reason })
    }
  }

  return { fulfilled, failures }
}
