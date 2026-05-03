export type CliParseResult<T> = { ok: true; value: T } | { ok: false; message: string }

/**
 * Validate a positive decimal integer flag before numeric conversion.
 * Looser approaches silently accept malformed values:
 * `parseInt("3.7", 10)` floors, `parseInt("3abc", 10)` truncates,
 * `Number("1e3")` accepts exponent notation, and `Number("+5")`
 * accepts a leading sign. The raw string check keeps CLI flags strict.
 */
export function parsePositiveDecimalInteger(
  flag: string,
  raw: string
): CliParseResult<number> {
  if (!/^[0-9]+$/.test(raw)) {
    return {
      ok: false,
      message: `${flag} must be a positive decimal integer, got "${raw}"`,
    }
  }
  const n = Number(raw)
  if (n < 1) {
    return {
      ok: false,
      message: `${flag} must be a positive integer, got ${n}`,
    }
  }
  if (!Number.isSafeInteger(n)) {
    return {
      ok: false,
      message: `${flag} exceeds the safe integer range, got "${raw}"`,
    }
  }
  return { ok: true, value: n }
}
