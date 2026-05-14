# Profiles

Profiles package Lore's vault-facing taxonomy, additive schema, and prompt
registry. Lore ships built-in first-party profiles such as:

```yaml
profile: default@1.0.0
```

```yaml
profile: support@1.0.0
```

When `.lore.yaml` omits `profile`, Lore resolves the same selector in memory.
Read-only startup paths do not rewrite `.lore.yaml`. New `lore init` configs
write the selector explicitly so fresh installs are pinned to the runtime
default profile version.

The runtime profile version comes from `profiles/default/profile.yaml`, not
from `package.json`. Do not bump it with package releases unless the profile
contract itself changes.

## Owned Surfaces

The active profile owns:

- closed write-time memory tags
- entity kind options
- writable fact predicates
- additive Notion properties for Projects, Topics, Memories, Entities, and Facts
- prompt registry entries for autosave extraction, autosave tool guidance,
  atomic-learning extraction, digest synthesis, conflict judging, and
  LongMemEval simulated autosave

Core enums remain code-owned. Memory kind/status/confidence, task state,
review state, scope/lifetime values, and internal fact predicates are not
profile-extensible in Phase 1.

Read filters for tags intentionally accept arbitrary non-empty strings so
operators can find legacy or out-of-profile rows. Write paths validate against
the active profile vocabulary and point free-form labels at `keywords`.

## Profile Files

A profile root contains:

- `profile.yaml` with `name`, `version`, and optional `taxonomy`, `schema`,
  `prompts`, and `evals` paths
- `taxonomy.yaml` with `tags`, `entityKinds`, and `writableFactPredicates`
- `schema.yaml` with additive database properties only
- prompt text files referenced by the prompt registry
- optional eval-suite YAML files referenced by `evals`

`profile.yaml extends` is reserved for profile composition and is rejected
with an explicit error until that later phase lands.

Profile names are kebab-case and selectors are exact `<name>@<semver>` values.
Ranges and floating versions are intentionally unsupported. Built-in,
project-local, and installed external profiles resolve through the Phase 3
priority order below; registry-backed profiles remain out of scope.

Fresh vaults can select a built-in profile during bootstrap:

```bash
lore init --profile support@1.0.0
```

The selector is validated before Notion database creation begins. On success,
the generated `.lore.yaml` records the exact selector. Existing configs are not
mutated by read-only startup paths, and switching an existing vault to another
profile waits for the explicit profile-management workflow.

`manifestDigest` is `sha256:<hex>` over the normalized `profile.yaml` and every
schema, taxonomy, prompt, and declared eval-suite file that participates in the
effective profile.
Relative paths and normalized content are included in stable sorted order.
Docs, READMEs, and undeclared fixtures do not participate unless a later phase
makes them part of resolution.

## Schema Contract

The five Lore databases and all core property names remain code-owned via
`PROJECT_PROPS`, `TOPIC_PROPS`, `MEMORY_PROPS`, `ENTITY_PROPS`, and
`FACT_PROPS`. Profiles may add properties after the core set is built. They may
not remove, rename, or override core properties, and they may not alter relation
topology.

Supported additive property types are `rich_text`, `number`, `select`,
`multi_select`, `date`, `checkbox`, `url`, `email`, and `phone_number`.
`number` supports Notion's plain `number` format only in Phase 1. `select` and
`multi_select` options declare `name` and may declare a Notion color from the
standard color vocabulary. Relation, rollup, formula, title, status, people,
file, created/edited metadata, unique id, and any unlisted property type are
rejected.

## Prompt Contract

Every resolved profile has an effective prompt for all required keys:
autosave extraction filter, autosave tool guidance, atomic-learning extraction,
digest synthesis, conflict judge, and LongMemEval simulated autosave. A
non-default fixture may omit prompt keys; omitted keys fall back to the
core/default prompt for that key. This prompt fallback is not profile
composition and does not enable schema or taxonomy inheritance.

Prompt templates may reference only variables allowlisted for that prompt key.
Default prompt files are data-backed copies of the current code-owned prompts;
tests assert that rendering through the default profile is byte-identical to
the core renderer.

## Taxonomy Contract

Profile-owned taxonomy is runtime data. Tags, entity kinds, and
agent-writable fact predicates are typed as strings and validated at write
boundaries against the active profile. Default-profile constants remain
available as fixtures and backwards-compatible helpers, but they are not the
active runtime source of truth once services have resolved a profile.

Generic fact predicates `is_a`, `has_a`, and `related_to` are always available.
Reserved/internal predicates cannot appear in profile-writable predicate lists:
`mentions`, `decided_by`, `supersedes_decision`, `informs`, `needs_action`,
`waiting_on`, and `blocked_by`.

## Implementation Notes

There is no active-profile singleton. `initServicesFromConfig()` resolves a
`ResolvedProfile` and threads it through services, vault setup/migration, MCP
write validators, CLI tag validation helpers, tag migration, and simulated
autosave schema construction. Hook helpers that cannot carry `LoreServices`
resolve the profile from `.lore.yaml` and pass the resolved prompt registry
into prompt construction. Tests should pass explicit profile objects when they
need a non-default taxonomy, schema, or prompt fixture.

## Built-In Support Pilot

`support@1.0.0` is the first non-default pilot profile. Its start contract is:

| Field | Value |
| --- | --- |
| Pilot team | Support Escalations, with the Lore maintainers owning the code rollout. |
| Data policy | Fixtures are synthetic/redacted only. Do not commit real customer content, PHI, regulated data, production workspace ids, or live ticket payloads. Live-vault evals are operator-dispatched only against sandbox vaults. |
| Profile name | `support` |
| Target use case | Help support engineers preserve escalation symptoms, owners, mitigations, product areas, and root-cause findings for future triage. |
| Additive schema | Memories: `Support Severity` select, `Customer Impact` rich_text. Entities: `Support Entity Role` select. Facts: `Evidence Link` url. |
| Tag vocabulary | `admin`, `api`, `billing`, `customer-report`, `data-loss`, `desktop`, `docs-gap`, `escalation`, `integration`, `latency`, `mobile`, `outage`, `permissions`, `product-area`, `root-cause`, `workaround`. |
| Entity kind vocabulary | `account`, `customer`, `feature`, `integration`, `person`, `plan`, `product-area`, `support-ticket`, `system`, `team`, `workspace`. |
| Writable fact predicates | `affects`, `caused_by`, `mitigated_by`, `owned_by`, `reported_by`, `reproduced_by`, plus the core generic predicates. |
| Prompt keys to override | Autosave extraction filter, autosave tool guidance, and simulated-autosave eval extraction. Atomic learning, digest, and conflict judge use default prompt fallback. |
| Retrieval/wake-up stance | Default core behavior. No support-specific ranking, section suppression, or cap changes. |
| Debt/procedure stance | Default core policy. Procedure review gates, proposal/deprecation flow, conflict detection, stale-confidence handling, temporal facts, auto-mentions, and cross-vault trust markers remain unchanged. |
| Eval runner | `lore eval run evals/profile-suites/support.yaml` for deterministic CI-safe scorer checks; `lore eval run --runner bench evals/bench-suites/support-simulated-autosave.yaml` for operator-dispatched model-backed extraction runs. |
| Eval metric | Entity-kind recall, predicate precision, hallucinated-fact rate, required-field completeness, and invalid-taxonomy rate. |
| Minimum threshold | Entity-kind recall >= 0.80, predicate precision >= 0.85, hallucinated-fact rate <= 0.05, required-field completeness >= 0.90, invalid-taxonomy rate = 0. |
| Latest measured result | The committed deterministic support suite passes 1/1 cases: entity-kind recall 1.00, predicate precision 1.00, hallucinated-fact rate 0.00, required-field completeness 1.00, invalid-taxonomy rate 0.00. |
| Pilot success signal | Support engineers can bootstrap a sandbox vault with `support@1.0.0`, run synthetic scorer fixtures in CI, and use operator-dispatched bench artifacts to inspect prompt/taxonomy quality before any live pilot data is written. |

The tag vocabulary is intentionally centered on routing, customer impact, and
triage outcome rather than ticket status. Ticket status remains task state;
support tags should answer what kind of support knowledge was preserved. Entity
kinds split customers, workspaces, product areas, plans, internal teams, and
support tickets so future retrieval can connect symptoms to accountable product
surfaces without adding profile-specific memory kinds.

The support prompt overrides narrow extraction toward support-safe incidents:
autosave filtering prefers escalations, customer-impact notes, mitigations, and
root-cause findings over routine chatter; tool guidance names the support tags,
entity kinds, and writable predicates agents should choose from; the simulated
autosave eval prompt mirrors that extraction contract so model-backed bench
artifacts measure the same profile surface. Digest, atomic learning, and
conflict judging fall back to the default prompts because the support pilot does
not change core safety, review, or maintenance policy.

The support profile is deliberately a profile-bundle exercise, not a profile
distribution exercise. It does not add profile memory kinds, registry install,
profile migration, `profile.yaml extends`, or a broad profile-management CLI.

## Distribution (Phase 3)

Phase 3 adds the `lore profile` CLI surface for distributing, validating,
selecting, and migrating profiles without expanding the contract matrix.
The five-database semantic core stays code-owned; nothing here lets an
external profile redefine memory kinds, claim reserved predicates, or
edit profile files via migration.

### Resolution priority

A `<name>@<version>` selector resolves through three tiers in order:

1. Project-authored local: `<configRoot>/.lore/profiles/local/<name>/<version>/`
2. Built-in (bundled with this Lore release): `profiles/<name>/`
3. Installed external: `<configRoot>/.lore/profiles/installed/<name>/<version>/`

`lore profile list` surfaces every profile this config root can resolve.
The active profile is marked with `*`; lower-priority resolutions of the
same selector are marked with `↳` so an operator can see when a local
override shadows a built-in or installed bundle.

### Install sources

`lore profile install` accepts two source forms in Phase 3:

- **Local filesystem path** pointing directly at a profile bundle root
  containing `profile.yaml`. No subdirectory discovery, no repo-root
  guessing. The CLI prints the manifest digest so an operator can add
  the path to `profiles.allowedInstallSources` for later CI runs.
- **Git URL pinned to a 40-hex commit SHA**:
  `git@host:org/repo.git#0123456789abcdef0123456789abcdef01234567` or
  the `https://…` equivalent. Branches and tags are rejected at parse
  time. The repo root, after checkout, must itself be the profile
  bundle root.

External installs always write under
`<configRoot>/.lore/profiles/installed/<name>/<version>/`. The installer
never writes to the project-authored local path.

### Collision behavior

`lore profile install` is intentionally fail-closed. The matrix:

| State | Behavior |
| --- | --- |
| Target directory does not exist | install proceeds after validation + confirmation |
| Target exists, same `manifestDigest` | no-op; only the lock entry is refreshed |
| Target exists, different `manifestDigest` | install fails with `Refusing to install … already exists with a different manifest digest`. Phase 3 has no `--force`; pick a new version or remove the directory manually |
| Target exists but is not a valid profile bundle | install fails closed; the installer never writes into an ambiguous existing directory |
| Local profile at same selector with different digest | install fails because the local override would shadow the install |
| Built-in profile at same selector with different digest | install fails because built-in resolution wins over installed external |

### Lock file

Successful installs write `<configRoot>/.lore/profiles/installed/profiles.lock.json`:

```json
{
  "profiles": {
    "sales@1.2.0": {
      "name": "sales",
      "version": "1.2.0",
      "source": {
        "kind": "git",
        "url": "git@github.com:org/lore-sales-profile.git",
        "commit": "<40-hex-sha>"
      },
      "manifestDigest": "sha256:<64-hex>",
      "installedAt": "2026-05-13T00:00:00.000Z"
    }
  }
}
```

The lock authorizes a same-digest, no-op reinstall under `--yes` when
the install directory still exists and the recorded source matches.
First installs always require an explicit allow-list match (see below).

### Non-interactive allow-list

`lore profile install --yes` must match an entry in
`profiles.allowedInstallSources` in `.lore.yaml`. The discriminated
union is enforced by the config schema:

```yaml
profiles:
  allowedInstallSources:
    - kind: git
      url: git@github.com:org/lore-sales-profile.git
      commit: 0123456789abcdef0123456789abcdef01234567
      manifestDigest: sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
    - kind: path
      path: /absolute/path/to/profile
      manifestDigest: sha256:abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd
```

Rules:

- Git entries require `url`, an exact 40-hex `commit`, and `manifestDigest`.
- Path entries require `path` and `manifestDigest`. Relative paths
  resolve against `configRoot` before comparison.
- Interactive installs (without `--yes`) print the digest so operators
  can pre-populate the allow-list. Adding an entry without first running
  the interactive preview is rejected because the digest will not match.

### Migration DSL

Profile migrations live inside the source bundle:

```text
<profileRoot>/migrations/<from>__<to>.yaml
```

`lore profile migrate <name@version>` discovers the file via the source
selector (the currently pinned profile, unless `--from` overrides it),
parses every step, and prints a step table. The dry-run output names
every step's id, kind, planned status, optional reason, and estimated
Notion writes. `--apply` re-checks live state per step before committing
and writes an audit ledger to:

```text
<configRoot>/.lore/profile-migrations/<safe-profile-name>/<from>__<to>.<vault-page-sha12>.json
```

The ledger is local-only operator state — it is not committed and is
safe to delete; a rerun recomputes live state before deciding what to
skip. The migration lock infrastructure (the same lock that gates
`lore migrate`) prevents concurrent profile-migration apply runs against
the same config root.

The supported Phase 3 step kinds:

- `add_property` — append an additive Notion property to one of the
  five core data sources. Cannot redefine core columns; the property
  type must be one of `rich_text`, `number`, `select`, `multi_select`,
  `date`, `checkbox`, `url`, `email`, `phone_number`.
- `add_select_options` / `add_multi_select_options` — append options
  to an existing select / multi_select column. Live option ids are
  preserved on apply so Notion does not duplicate. For core columns,
  Phase 3 allows appends only to profile-owned taxonomy surfaces:
  Memories `Tags`, Entities `Kind`, and Facts `Predicate`; reserved
  fact predicates stay rejected.
- `write_config_profile_pin` — rewrite `.lore.yaml profile:` to the
  target selector. Runs last so a partial failure leaves the operator
  on the source pin.
- `backfill_empty_property` — write a literal value to empty cells
  that match a bounded filter. Capped at 500 rows per run. The filter
  MUST contain an empty/unset check for the target property; the
  apply path re-checks each row at write time and never overwrites
  non-empty cells. Backfills cannot target core columns.

The validator rejects every destructive or out-of-scope step kind —
`delete_property`, `rename_property`, `replace_select_options`,
`archive_pages`, `delete_pages`, `overwrite_property`,
`add_profile_prompt`, `add_taxonomy_values`, `edit_profile_files`,
`run_shell`, `run_js` — with an explicit error pointing at the
rejected `kind` field. Prompt and taxonomy changes are represented by
the target profile version's immutable files; migrations never edit
profile files.

### Trust UX

Interactive `lore profile install` confirmation prints:

- profile name / version
- source path or git URL + commit SHA
- manifest digest
- install target path under `.lore/profiles/installed/`
- collision status (`none`, `same-digest`, `different-digest`)
- shadowing status (`none`, `local-shadow`, `built-in-shadow`)
- schema additions count per database
- taxonomy counts (tags, entity kinds, writable predicates)
- prompt keys included in the bundle
- eval suites included in the bundle
- migration versions included in the bundle
- the warning that profile prompts directly affect what agents save
  to Notion

Operators copy the printed manifest digest into
`profiles.allowedInstallSources` to authorize subsequent CI / scripted
installs against the same source + digest.
