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
  and `prompts` paths
- `taxonomy.yaml` with `tags`, `entityKinds`, and `writableFactPredicates`
- `schema.yaml` with additive database properties only
- prompt text files referenced by the prompt registry

`profile.yaml extends` is reserved for profile composition and is rejected
with an explicit error until that later phase lands.

Profile names are kebab-case and selectors are exact `<name>@<semver>` values.
Ranges and floating versions are intentionally unsupported. Phase 2 resolves
built-in first-party profiles only. Local, installed, registry-backed, and
external profiles wait for the profile distribution phase.

Fresh vaults can select a built-in profile during bootstrap:

```bash
lore init --profile support@1.0.0
```

The selector is validated before Notion database creation begins. On success,
the generated `.lore.yaml` records the exact selector. Existing configs are not
mutated by read-only startup paths, and switching an existing vault to another
profile waits for the explicit profile-management workflow.

`manifestDigest` is `sha256:<hex>` over the normalized `profile.yaml` and every
schema, taxonomy, and prompt file that participates in the effective profile.
Relative paths and normalized content are included in stable sorted order.
Docs, READMEs, and eval fixtures do not participate unless a later phase makes
them part of resolution.

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
