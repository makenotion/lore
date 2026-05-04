import { describe, expect, it } from "vitest"
import {
  RUNTIME_FORWARDED_AUTH_TOKEN_KEYS,
  RUNTIME_FORWARDED_KEYS,
  type RuntimeForwardedAuthTokenKey,
  type RuntimeForwardedKey,
} from "./forwarded-env.js"

// `forwarded-env.ts` is a contract module: a single source-of-truth
// allowlist consumed by `lore install` (committed `.mcp.json` /
// `config.toml` placeholders) and `spawnBackgroundSave` (detached
// `claude -p` env passthrough). The module's own JSDoc warns that drift
// between the two surfaces produces silent auth/workspace divergence
// (#188), so these tests pin the invariants that drift would violate.
//
// Consumer-side tests already iterate this constant to verify emit
// behavior:
// - `src/cli/commands/install.test.ts:3319` walks `RUNTIME_FORWARDED_KEYS`
//   and asserts every per-host MCP entry emits `${VAR}` placeholders.
// - `src/cli/commands/install.test.ts:2799` opens the
//   `ntn-auth-json` block, where `RUNTIME_FORWARDED_AUTH_TOKEN_KEYS`
//   suppression is exhaustively pinned per token key.
// - `src/hooks/background.test.ts:137` (and 149, 262, 301) walks
//   the same array against `safeEnv` to pin spawn-side parity.
//
// This file pins the array's *own* shape — independent of either
// consumer — so a refactor that broke the allowlist's shape would
// surface here even if both consumer tests were temporarily
// disabled, AND so the consumer files don't need to grow ambient
// shape probes alongside their per-host emit assertions.

// Module-scope exhaustiveness gates. The mere presence of these
// switches in the source file is the type-test: if a key is added to
// `RUNTIME_FORWARDED_KEYS` without a matching `case`, the `default`
// branch's `assertNever(_value: never)` rail receives the leftover
// literal and `tsc --noEmit` fails. If a key is removed but the case
// label stays, the `case` branch becomes unreachable and tsc
// also fails. The runtime walk in the `it()` below confirms the
// switches return on every actual array member — a thin diagnostic
// surface, since the load-bearing guarantee is the compile output.
function assertNever(_value: never): never {
  throw new Error("unreachable")
}
function exhaustiveAllKeys(key: RuntimeForwardedKey): RuntimeForwardedKey {
  switch (key) {
    case "NOTION_API_TOKEN":
    case "LORE_NOTION_TOKEN":
    case "LORE_NOTION_BASE_URL":
    case "NOTION_WORKSPACE_ID":
    case "NOTION_ENV":
    case "NOTION_BASE_URL":
    case "NOTION_API_BASE_URL":
    case "LORE_USER_NAME":
      return key
    default:
      return assertNever(key)
  }
}
function exhaustiveAuthTokenKeys(
  key: RuntimeForwardedAuthTokenKey,
): RuntimeForwardedAuthTokenKey {
  switch (key) {
    case "NOTION_API_TOKEN":
    case "LORE_NOTION_TOKEN":
      return key
    default:
      return assertNever(key)
  }
}

describe("RUNTIME_FORWARDED_KEYS — declaration shape", () => {
  it("matches the exact expected sequence", () => {
    // Declaration order is observable: `lore install` emits Codex
    // `env_vars = [...]` entries in this order, so a refactor that
    // shuffles the array silently rewrites committed TOML for every
    // operator who re-runs `lore install`. Pin the sequence so that
    // reorder is a deliberate, reviewed change rather than an
    // accidental side effect of a sort or a structural cleanup.
    expect(RUNTIME_FORWARDED_KEYS).toEqual([
      "NOTION_API_TOKEN",
      "LORE_NOTION_TOKEN",
      "LORE_NOTION_BASE_URL",
      "NOTION_WORKSPACE_ID",
      "NOTION_ENV",
      "NOTION_BASE_URL",
      "NOTION_API_BASE_URL",
      "LORE_USER_NAME",
    ])
  })

  it("pins the array length so a single-line append breaks the test", () => {
    // The exact-sequence assertion above already pins length, but a
    // standalone length probe catches the narrow case where someone
    // renames a key in place (sequence changes, length unchanged) AND
    // updates the sequence assertion to match — leaving a length pin
    // as a second guard against an accidental dual-edit. Adding a key
    // is a deliberate change to both surfaces; the expected length
    // updates here in the same patch.
    expect(RUNTIME_FORWARDED_KEYS).toHaveLength(8)
  })

  it("contains no duplicate keys", () => {
    // Forwarding the same key twice is silently harmless at runtime
    // (the `for...of` loop would just write the placeholder twice,
    // last write wins on object assignment) but signals confused
    // intent. A duplicate would also break `RUNTIME_FORWARDED_KEYS`'s
    // Codex `env_vars = [...]` emission by listing the same name twice
    // in the TOML output. Set-size-equals-array-length is the cheapest
    // structural probe.
    const unique = new Set<RuntimeForwardedKey>(RUNTIME_FORWARDED_KEYS)
    expect(unique.size).toBe(RUNTIME_FORWARDED_KEYS.length)
  })

  it("places auth tokens first so the array reads in resolveAuth precedence order", () => {
    // The module JSDoc claims the array's auth-token prefix matches
    // `resolveAuth`'s priority chain ("canonical first,
    // soft-deprecated second"). Pin that prefix so a reorder that
    // moved `LORE_NOTION_TOKEN` ahead of `NOTION_API_TOKEN` would
    // fail loudly even if the full-sequence assertion was updated to
    // match — protecting the documented contract that an operator
    // reading the array sees the same precedence the runtime applies.
    expect(RUNTIME_FORWARDED_KEYS[0]).toBe("NOTION_API_TOKEN")
    expect(RUNTIME_FORWARDED_KEYS[1]).toBe("LORE_NOTION_TOKEN")
  })

  it("excludes env names the source JSDoc documents as intentionally absent", () => {
    // The module JSDoc explicitly carves out three env names that
    // would otherwise be plausible additions:
    //
    // - `LORE_AGENT_NAME` (lines 47-52) — agent-name flow already
    //   threads through prompt-text + Codex hook-command prefix.
    //   Forwarding here would double-forward.
    // - `LORE_CONFIG_ROOT` (lines 43-46) — install-time-derived
    //   absolute path, not an operator-controlled env reference.
    // - `LORE_SUPPRESS_DEPRECATIONS` (same range) — literal
    //   `"1"` static value, set by `buildMcpEnv`'s static block.
    //
    // A "quiet append" that adds any of these without re-reading
    // the JSDoc carve-out re-introduces the exact failure modes
    // the carve-out exists to prevent. Pin the exclusions so a
    // future PR has to delete this assertion deliberately, which
    // forces a re-read.
    expect(RUNTIME_FORWARDED_KEYS).not.toContain("LORE_AGENT_NAME")
    expect(RUNTIME_FORWARDED_KEYS).not.toContain("LORE_CONFIG_ROOT")
    expect(RUNTIME_FORWARDED_KEYS).not.toContain("LORE_SUPPRESS_DEPRECATIONS")
  })
})

describe("RUNTIME_FORWARDED_AUTH_TOKEN_KEYS — subset partition", () => {
  it("contains exactly the auth-token names", () => {
    // Pin the subset's contents so a future "the MCP host's
    // validator now also warns on `NOTION_WORKSPACE_ID`" claim has
    // to land as a deliberate edit here — not as a quiet append
    // that silently changes which placeholders `buildMcpEnv` skips
    // under `authSource: "ntn-auth-json"`.
    expect(RUNTIME_FORWARDED_AUTH_TOKEN_KEYS).toEqual([
      "NOTION_API_TOKEN",
      "LORE_NOTION_TOKEN",
    ])
  })

  it("pins length so a single-line append breaks the test", () => {
    expect(RUNTIME_FORWARDED_AUTH_TOKEN_KEYS).toHaveLength(2)
  })

  it("forms a contiguous prefix of RUNTIME_FORWARDED_KEYS in matching order", () => {
    // Strictly stronger than the `satisfies readonly
    // RuntimeForwardedKey[]` constraint already enforced at the type
    // layer: the JSDoc claims auth tokens lead the array "canonical
    // first, soft-deprecated second," which is a contiguous-prefix
    // statement, not a subset statement. A reorder that moved
    // `NOTION_WORKSPACE_ID` between the two token keys would still
    // satisfy `satisfies` and still satisfy a plain subset probe,
    // but would violate this assertion — and would silently break
    // any consumer who reads the prefix to derive precedence.
    //
    // Pinning the prefix also subsumes the subset claim, so a
    // separate "every auth-token key appears in the parent" test
    // would be redundant once this passes.
    const prefix = RUNTIME_FORWARDED_KEYS.slice(0, RUNTIME_FORWARDED_AUTH_TOKEN_KEYS.length)
    expect(prefix).toEqual([...RUNTIME_FORWARDED_AUTH_TOKEN_KEYS])
  })
})

describe("type-level exhaustiveness — see compile output", () => {
  it("module-scope switches cover both unions; runtime walk confirms no key is missing", () => {
    // The `assertNever` rails in the two module-scope switches
    // (`exhaustiveAllKeys` / `exhaustiveAuthTokenKeys`) are the
    // load-bearing checks — they fail at `tsc --noEmit` time, not
    // here. This `it()` exists as a thin diagnostic surface so the
    // test runner reports a failure if a future edit ever adds a
    // key to one of the arrays in a way that bypasses tsc (e.g. an
    // `as any` widening at the call site, an `eslint-disable`
    // around the switch, or a generated array constructed via
    // string operations the compiler can't narrow).
    for (const key of RUNTIME_FORWARDED_KEYS) {
      expect(exhaustiveAllKeys(key)).toBe(key)
    }
    for (const key of RUNTIME_FORWARDED_AUTH_TOKEN_KEYS) {
      expect(exhaustiveAuthTokenKeys(key)).toBe(key)
    }
  })
})
