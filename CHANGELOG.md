# Changelog

All notable user-facing changes to Lore are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and Lore versions
adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries describe behavior an operator or AI assistant can observe — tool
output shape, CLI flags, hook side effects, schema additions. Internal
refactors that leave behavior unchanged are intentionally omitted; the git
log is the canonical source for those.

## [Unreleased]

<!-- TODO(release): when cutting v0.5.1 or v0.6.0, append the release
date to the matching heading below per Keep a Changelog v1.1.0 convention,
e.g. `## [0.5.1] - 2026-04-27`. -->

## [0.5.1]

### Added

- **`lore status` now warns when live tracking-predicate facts remain.**
  Vaults with `needs_action`, `waiting_on`, or `blocked_by` facts will see
  a preflight recommending
  `lore migrate --migrate-tracking-to-tasks --yes` before the next minor
  release. Ignoring the warning means those rows become invisible to Lore
  after upgrade: Notion still stores them, but no read path surfaces them
  once the tracking-predicate purge lands.

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
[0.5.1]: https://github.com/makenotion/lore/compare/v0.5.0...v0.5.1
[0.6.0]: https://github.com/makenotion/lore/releases/tag/v0.6.0
