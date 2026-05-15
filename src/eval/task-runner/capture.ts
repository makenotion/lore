export const CODEX_CAPTURE_CAP_BYTES = 1024 * 1024

export interface CappedCapture {
  chunks: Buffer[]
  truncated: boolean
}

export function makeCappedCapture(): CappedCapture {
  return { chunks: [], truncated: false }
}

export function appendCappedChunk(capture: CappedCapture, chunk: Buffer): void {
  let captured = 0
  for (const c of capture.chunks) captured += c.length
  if (captured >= CODEX_CAPTURE_CAP_BYTES) {
    capture.truncated = true
    return
  }
  const remaining = CODEX_CAPTURE_CAP_BYTES - captured
  if (remaining >= chunk.length) {
    capture.chunks.push(chunk)
  } else {
    capture.chunks.push(chunk.subarray(0, remaining))
    // The chunk was clipped, so mark truncated for the join() marker.
    // Exact-fill chunks stay unmarked because no bytes were dropped.
    capture.truncated = true
  }
}

export function joinCappedCapture(capture: CappedCapture): string {
  const text = Buffer.concat(capture.chunks).toString("utf-8")
  if (capture.truncated) {
    return `${text}\n[capture-truncated at ${CODEX_CAPTURE_CAP_BYTES} bytes]`
  }
  return text
}
