/**
 * Build a code-fence string of at least 3 backticks AND strictly longer
 * than the longest backtick run anywhere in `content`.
 *
 * Returns just the backticks; the caller appends any language info string
 * to the opening fence and uses the same string verbatim as the closing
 * fence.
 */
export function dynamicCodeFence(content: string): string {
  let maxRun = 0
  let currentRun = 0
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 0x60 /* backtick */) {
      currentRun++
      if (currentRun > maxRun) maxRun = currentRun
    } else {
      currentRun = 0
    }
  }
  return "`".repeat(Math.max(3, maxRun + 1))
}
