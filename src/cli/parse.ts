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

/**
 * Validate a decimal number constrained to the inclusive unit interval.
 * The raw string check rejects parseFloat's silent coercions:
 * `parseFloat("0.5abc")` truncates, `parseFloat("5e-1")` accepts
 * exponent notation, and `parseFloat("+0.5")` accepts a leading sign.
 * It also proves the upper bound before `Number(raw)` so values just
 * above 1 cannot round down to 1 and bypass the range check.
 */
export function parseUnitIntervalDecimal(
  flag: string,
  raw: string
): CliParseResult<number> {
  const message = `${flag} must be a number in [0, 1], got "${raw}"`
  if (!/^(?:0(?:\.[0-9]+)?|1(?:\.0+)?)$/.test(raw)) {
    return { ok: false, message }
  }

  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    return { ok: false, message }
  }

  return { ok: true, value: n }
}
