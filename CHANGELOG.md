# Changelog

All notable user-facing changes to Lore are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lore versions
adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries describe behavior an operator or AI assistant can observe — tool
output shape, CLI flags, hook side effects, schema additions. Internal
refactors that leave behavior unchanged are intentionally omitted; the git
log is the canonical source for those.

## [Unreleased]

<!-- TODO(release): when cutting v0.6.0, append the release date to the
heading below per Keep a Changelog v1.1.0 convention, e.g.
`## [0.6.0] - 2026-04-27`. -->

### Added

- **`lore-memory action='update'` accepts `topicKey` for re-keying.**
  An agent that picked the wrong topic key on first save can now
  switch to the canonical key without abandoning the row. The kebab-
  case format is identical to the (forthcoming) save-time `topicKey`
  parameter. The handler preflights the re-key (collision check
  against the current project-set, non-empty `projectIds`) before
  applying any other content delta, so the most common failure modes
  fail fast without leaving a half-persisted update. When the new
  key matches the existing one, the response surfaces a
  `Topic key unchanged: '<key>' (no-op).` line — the call is
  acknowledged rather than silently dropped. A combined
  `topicKey + kind` call is rejected at the handler boundary
  before any Notion read because the upsert chain is per-kind.
  Re-keying appends a `## Re-keyed (YYYY-MM-DD)` audit block to
  the body (deliberately distinct from the upsert path's
  `## Revision N (date)` prefix) and writes only the `Topic Key`
  column — `Revision Count` and `Last Referenced At` are
  intentionally untouched because re-keying is identity surgery,
  not content evolution. (Issue 0.9.0/14.)

- **New `MemoryService.validateRekey` public method.** Non-mutating
  preflight that loads the memory, checks empty `projectIds`, and
  runs the collision query against the current project-set.
  Returns `{memory, oldTopicKey, willRekey}` (with `willRekey: false`
  signaling the no-op short-circuit case). Throws the same
  collision and empty-projectIds errors the authoritative
  `rekeyTopicKey` raises, so direct callers can fail fast without
  duplicating validation logic. The MCP `handleUpdate` consumes it
  to gate combined `topicKey + content` updates.

- **New error subclasses exported from `src/core/memory.ts`:**
  - `RekeyAuditError` — raised by `MemoryService.rekeyTopicKey`
    when the Topic Key property write succeeded but the body
    audit-block append failed. Carries `{memoryId, oldTopicKey,
    newTopicKey, cause}`. The re-key persisted; only the audit
    trail is missing. A retry short-circuits via the no-op guard
    because the property already matches the new key.
  - `PartialUpdateError` — raised by the MCP `handleUpdate` when
    a combined `topicKey + content` call has the content delta
    persist successfully but the subsequent re-key reject (race
    with another agent grabbing the slot, transient Notion
    failure, or post-update `projectIds` change exposing a fresh
    collision). Carries `{memoryId, contentApplied: true,
    rekeyError}`. The content mutation is durable on Notion; the
    re-key did not happen.

  Both are `instanceof`-checkable for future operator tooling.
  `RekeyAuditError` propagates unchanged from the combined-update
  catch path so its accurate "rekey persisted, audit missing"
  message isn't shadowed by `PartialUpdateError`'s "rekey did
  not happen" wording.

### Fixed

- **`lore-memory` (and every MCP tool that accepts `topicName`) no
  longer silently fans out near-duplicate topic pages.** Previously,
  `TopicService.getOrCreate` only checked for *exact-name* matches,
  so an agent that drifted casing, pluralization, `&` vs `and`, or
  punctuation across saves accumulated sibling topic rows — the
  issue #109 Mail-vault audit found four such siblings produced in
  a single session. The slow path (no exact match) now normalizes
  the input (lowercase + NFC + HTML-decode + plural-strip + `&`↔`and`
  + punctuation-strip), scans every topic in the resolved projects,
  and silently extends any row whose stored name shares the
  normalized key (`Eval & Testing` and `Evals & Testing` collapse
  onto the oldest row). Names that survive normalization but score
  ≥ 0.85 trigram-Jaccard against a project sibling raise a
  `SimilarTopicError` listing the candidates; agents can either
  pick an existing name or pass `forceNewTopic: true` to create a
  fresh row.
- **New CLI flag: `lore migrate --merge-similar-topics`.** Plan-then-
  execute migration that collapses normalized-equivalent topic groups
  on legacy vaults — the cleanup pass for drift that
  `getOrCreate` now prevents at write time. Bare invocation prints
  the plan grouped by canonical destination; re-run with `--yes` to
  archive sibling rows and re-point their memories onto the
  canonical. Idempotent.

## [0.6.0]

### Fixed

- **`lore-audit` now returns the complete set of overdue facts and
  decisions on large vaults.** Previously, `FactService.queryOverdue` and
  `DecisionService.queryOverdue` issued a single un-paginated
  `dataSources.query`, so Notion's default 100-row page silently capped
  the result set. Both methods now paginate to exhaustion and accept an
  optional `limit`. Because both queries sort `Review By asc`, the rows
  that were previously dropped are the *least* overdue tail (and
  no-review-date rows) — the most-overdue head was always returned. On
  vaults with more than 100 overdue rows, expect `lore-audit` to surface
  rows it previously did not; the newly-visible rows are the ones with
  the latest `Review By` dates (or no date at all). See
  [PR #96](https://github.com/makenotion/lore/pull/96) for the underlying
  fix.

## [0.5.1]

### Added

- **`lore status` tracking-predicate preflight.** When the vault still
  carries facts whose Notion `Predicate` select value is one of the
  legacy tracking predicates (`needs_action`, `waiting_on`,
  `blocked_by`), `lore status` now prints a warning at the top of its
  output naming the count and recommending
  `lore migrate --migrate-tracking-to-tasks --yes` as remediation.
  When the count is zero the warning is suppressed and status output
  is byte-identical to the previous behavior. The preflight is
  informational — `lore status` does not refuse to run on non-zero
  count, so operators can still diagnose other vault state. This
  ships ahead of the 0.6.0 deprecation purge so an operator on the
  old line sees the warning while
  `lore migrate --migrate-tracking-to-tasks` still works; on 0.6.0
  the prose updates to reflect the migration command's removal.

[Unreleased]: https://github.com/makenotion/lore/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/makenotion/lore/compare/v0.5.1...v0.6.0
[0.5.1]: https://github.com/makenotion/lore/releases/tag/v0.5.1
