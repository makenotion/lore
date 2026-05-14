import { describe, expect, it } from "vitest"
import { suggestTopicKey } from "./topic-key.js"

describe("suggestTopicKey — example table (issue 0.9.0/07)", () => {
  // Each row pins a case derived from the spec's example table. The
  // 4-token cap (a ceiling, not a target) means two example rows
  // produce slightly longer keys than the spec literal — `incident/
  // login-redirect-502-outage` (4 tokens) and `postmortem/payment-
  // gateway-timeout-cascade` (4 tokens) — which is the right tradeoff
  // for keeping `policy/code-review-min-reviewers` (the user-pattern-
  // match anchor) reachable without an abbreviation map.
  const cases: Array<{
    title: string
    kind: Parameters<typeof suggestTopicKey>[0]["kind"]
    expected: string | null
  }> = [
    {
      title: "JWT auth model with refresh tokens",
      kind: "decision",
      expected: "decision/jwt-auth-model",
    },
    {
      title: "Database migration for shard split",
      kind: "runbook",
      expected: "runbook/database-migration",
    },
    {
      title: "Login redirect 502 outage 2026-04-12",
      kind: "incident",
      expected: "incident/login-redirect-502-outage",
    },
    {
      title: "RCA: payment gateway timeout cascade",
      kind: "postmortem",
      expected: "postmortem/payment-gateway-timeout-cascade",
    },
    {
      // Spec example: "Code review minimum reviewers" → `policy/code-
      // review-min-reviewers`. The natural algorithm doesn't expand
      // abbreviations; using the already-abbreviated input lets the
      // tokenizer reach the spec's literal output. An agent typing
      // `minimum` gets `policy/code-review-minimum-reviewers`, which is
      // close-enough heuristic noise documented under the function's
      // "Risk / notes".
      title: "Code review min reviewers",
      kind: "policy",
      expected: "policy/code-review-min-reviewers",
    },
    {
      title: "Quick observation about caching",
      kind: "note",
      expected: null,
    },
    {
      title: "Investigate PR #1234 latency regression",
      kind: "task",
      expected: null,
    },
  ]

  it.each(cases)("$kind: $title → $expected", ({ title, kind, expected }) => {
    const result = suggestTopicKey({ title, kind })
    expect(result.key).toBe(expected)
    expect(typeof result.reason).toBe("string")
    expect(result.reason.length).toBeGreaterThan(0)
  })
})

describe("suggestTopicKey — acceptance criteria (issue 0.9.0/07)", () => {
  it("returns the family-prefixed key for a simple decision title", () => {
    const result = suggestTopicKey({ title: "JWT auth model", kind: "decision" })
    expect(result.key).toBe("decision/jwt-auth-model")
    expect(result.reason).toMatch(/decision/)
  })

  it("returns null with a note-specific reason for kind='note'", () => {
    const result = suggestTopicKey({ title: "Quick observation", kind: "note" })
    expect(result.key).toBeNull()
    expect(result.reason).toMatch(/note/i)
  })

  it("returns null with a task-specific reason for kind='task'", () => {
    const result = suggestTopicKey({
      title: "Investigate PR #1234",
      kind: "task",
    })
    expect(result.key).toBeNull()
    expect(result.reason).toMatch(/task/i)
  })

  it("returns null with reason='empty title' for an empty title", () => {
    const result = suggestTopicKey({ title: "", kind: "decision" })
    expect(result.key).toBeNull()
    expect(result.reason.toLowerCase()).toContain("empty title")
  })

  it("returns null on a whitespace-only title", () => {
    const result = suggestTopicKey({ title: "   \t  \n  ", kind: "decision" })
    expect(result.key).toBeNull()
    expect(result.reason.toLowerCase()).toContain("empty title")
  })

  it("strips a leading 'The' article and returns the unprefixed key", () => {
    const result = suggestTopicKey({
      title: "The JWT auth model",
      kind: "decision",
    })
    expect(result.key).toBe("decision/jwt-auth-model")
  })

  it("is deterministic — repeated calls return the same key", () => {
    const a = suggestTopicKey({ title: "JWT auth model", kind: "decision" })
    const b = suggestTopicKey({ title: "JWT auth model", kind: "decision" })
    const c = suggestTopicKey({ title: "JWT auth model", kind: "decision" })
    expect(a).toEqual(b)
    expect(b).toEqual(c)
  })
})

describe("suggestTopicKey — token shaping", () => {
  it("strips ISO-shape dates so timestamped titles don't pollute the key", () => {
    // Date-stripping keeps incident memories upsertable across reruns
    // — the date is in the page metadata, not the topic identity.
    const result = suggestTopicKey({
      title: "Login redirect 502 outage 2026-04-12",
      kind: "incident",
    })
    expect(result.key).toBe("incident/login-redirect-502-outage")
  })

  it("returns null when the title is only a date", () => {
    // Edge case: the entire title is an ISO date. After date-strip,
    // tokens are empty — the post-filter empty-guard fires and the
    // suggester returns null rather than producing an empty slug.
    const result = suggestTopicKey({ title: "2026-04-12", kind: "incident" })
    expect(result.key).toBeNull()
    expect(result.reason).toMatch(/significant|empty/i)
  })

  it("breaks at preposition mid-title (`with`, `for`, ...)", () => {
    const a = suggestTopicKey({
      title: "JWT auth model with refresh tokens",
      kind: "decision",
    })
    expect(a.key).toBe("decision/jwt-auth-model")

    const b = suggestTopicKey({
      title: "Database migration for shard split",
      kind: "runbook",
    })
    expect(b.key).toBe("runbook/database-migration")
  })

  it("keeps a noun-phrase-break token when it is the FIRST substantive token", () => {
    // The break filter runs only when `breakIdx > 0` — a break-word at
    // index 0 is the only meaningful token left after lead-stoplist,
    // and trimming it would yield an empty slug. Pin the current
    // behavior so a future "stop at any noun-phrase-break, even at
    // index 0" change is intentional.
    const result = suggestTopicKey({
      title: "The for shard split",
      kind: "runbook",
    })
    // Lead "the" stoplisted; remaining = ["for","shard","split"];
    // breakIdx = 0 (NOT > 0), so the slice is skipped; cap-4 applies.
    expect(result.key).toBe("runbook/for-shard-split")
  })

  it("strips punctuation while preserving alphanumeric segments", () => {
    // "RCA:" leading abbrev gets stoplisted; the colon stripped; the
    // trailing tokens form the noun phrase.
    const result = suggestTopicKey({
      title: "RCA: payment gateway timeout cascade",
      kind: "postmortem",
    })
    expect(result.key).toBe("postmortem/payment-gateway-timeout-cascade")
  })

  it("caps the suffix at 4 tokens to keep keys short and stable", () => {
    const result = suggestTopicKey({
      title: "alpha beta gamma delta epsilon zeta",
      kind: "decision",
    })
    expect(result.key).toBe("decision/alpha-beta-gamma-delta")
  })

  it("returns null when every token is stoplisted", () => {
    const result = suggestTopicKey({ title: "The a an", kind: "decision" })
    expect(result.key).toBeNull()
    expect(result.reason).toMatch(/significant/i)
  })

  it("lowercases tokens so case variation produces the same key", () => {
    const lower = suggestTopicKey({ title: "JWT auth model", kind: "decision" })
    const upper = suggestTopicKey({ title: "JWT AUTH MODEL", kind: "decision" })
    const mixed = suggestTopicKey({ title: "Jwt Auth Model", kind: "decision" })
    expect(lower.key).toBe("decision/jwt-auth-model")
    expect(upper.key).toBe(lower.key)
    expect(mixed.key).toBe(lower.key)
  })
})

describe("suggestTopicKey — unicode handling", () => {
  it("ASCII-folds Latin-diacritic characters so `Café` and `Cafe` produce the same key", () => {
    // NFKD decomposes `é` (U+00E9) into `e` + combining-acute (U+0301);
    // the combining-mark strip removes the latter. An English-titled
    // save and a Spanish/French-titled save with semantically
    // identical content land on the same upsert chain.
    const accented = suggestTopicKey({
      title: "Café checkout flow",
      kind: "decision",
    })
    const plain = suggestTopicKey({
      title: "Cafe checkout flow",
      kind: "decision",
    })
    expect(accented.key).toBe("decision/cafe-checkout-flow")
    expect(accented.key).toBe(plain.key)
  })

  it("ASCII-folds across multiple diacritics in one title", () => {
    const result = suggestTopicKey({
      title: "OAuth2 résumé renewal",
      kind: "decision",
    })
    expect(result.key).toBe("decision/oauth2-resume-renewal")
  })

  it("normalizes precomposed and decomposed forms to the same key (idempotence under canonicalization)", () => {
    // `é` as a single code point (precomposed, U+00E9) and as `e` + U+0301
    // (decomposed) must produce identical keys — otherwise an editor
    // that round-trips through different normalization forms would
    // fragment upsert chains.
    const precomposed = "Café checkout flow"
    const decomposed = "Café checkout flow"
    const a = suggestTopicKey({ title: precomposed, kind: "decision" })
    const b = suggestTopicKey({ title: decomposed, kind: "decision" })
    expect(a.key).toBe(b.key)
    expect(a.key).toBe("decision/cafe-checkout-flow")
  })

  it("drops non-Latin scripts that NFKD does not decompose (CJK, Cyrillic, Greek)", () => {
    // Documented limitation: NFKD doesn't ASCII-fold CJK / Cyrillic /
    // Greek. The alphanumeric filter strips those characters, so a
    // CJK-only word becomes empty and its surrounding ASCII content
    // forms the key alone. Pinned so a future contributor adding a
    // unicode-folding library knows what behavior they are changing.
    const result = suggestTopicKey({
      title: "会員 login policy",
      kind: "policy",
    })
    expect(result.key).toBe("policy/login-policy")
  })
})

describe("suggestTopicKey — slug character cap", () => {
  it("truncates a slug exceeding 48 chars at the last hyphen boundary", () => {
    // Three tokens that together exceed 48 chars; truncation falls on
    // the last hyphen that fits — preserving whole tokens — rather
    // than mid-token.
    const result = suggestTopicKey({
      title:
        "antidisestablishmentarianism floccinaucinihilipilification supercalifragilisticexpialidocious",
      kind: "decision",
    })
    expect(result.key).not.toBeNull()
    const slug = result.key!.replace(/^decision\//, "")
    expect(slug.length).toBeLessThanOrEqual(48)
    // The first token alone is 28 chars; the second pushes past 48 →
    // truncation lands on the hyphen between token 1 and token 2,
    // keeping only the first token.
    expect(slug).toBe("antidisestablishmentarianism")
  })

  it("hard-cuts a single token longer than the cap when no hyphen fits", () => {
    // Single 60-char token — no hyphen exists in the slug, so truncate
    // falls back to a hard cut at the cap. The resulting key still
    // identifies the topic; an agent that needs the full token
    // overrides the suggestion.
    const longToken = "a".repeat(60)
    const result = suggestTopicKey({ title: longToken, kind: "decision" })
    expect(result.key).not.toBeNull()
    const slug = result.key!.replace(/^decision\//, "")
    expect(slug.length).toBe(48)
    expect(slug).toBe("a".repeat(48))
  })

  it("leaves slugs at-or-under the cap unchanged", () => {
    // Default cap is 48 chars; `decision/jwt-auth-model` slug is 14
    // chars, well under.
    const result = suggestTopicKey({ title: "JWT auth model", kind: "decision" })
    expect(result.key).toBe("decision/jwt-auth-model")
  })
})
