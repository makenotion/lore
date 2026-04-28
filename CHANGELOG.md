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

[Unreleased]: https://github.com/makenotion/lore/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/makenotion/lore/releases/tag/v0.6.0
