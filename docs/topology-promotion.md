# Topology Promotion

`lore promote <memoryId> --to <name>` copies a memory from the primary
vault into a configured promotion target. It is the operator-deliberate
path for crossing the vault boundary; normal save / update / fact /
decision / task tools still write only to the primary vault.

## Workflow

1. Declare the target in `.lore.yaml`:

   ```yaml
   promotionTargets:
     - name: Team
       pageId: "team-vault-page-id"
       requireReview: true
   ```

2. Run `lore status` to confirm the target is reachable. The
   topology section's `promotion (review required)` row health is the
   read-side preflight — a target that surfaces as `unavailable` or
   `missing databases` will reject `lore promote` at the
   `VaultManager.load` step.

3. Promote a row:

   ```
   $ lore promote 1234abcd5678 --to Team --reason "Generalizes pattern"
   Promoted to Team: JWT auth pattern for service-to-service calls (awaiting review)
     Target memory ID: 9876fedc4321
     Status: proposed
     Promoter: Engineer Name
     Reason: Generalizes pattern
   ```

   The `(awaiting review)` suffix and `Status: proposed` line render only
   when `requireReview: true`. Targets without `requireReview` land the
   promoted row at the source's status (an accepted source promotes to
   accepted; a proposed source promotes to proposed).

## Audit block

The promoted row's body opens with a `## Promoted from <vault>` block
listing source vault label, source memory id (deep-linked back to the
source Notion page), source kind / status / confidence / synopsis,
target vault label, promoter, ISO-8601 timestamp, and optional
`--reason`. The remainder of the source body follows verbatim. Cross-
vault provenance lives in this text/url metadata rather than in Notion
relations because a `relation` column targets a specific database — a
primary-vault memory id is structurally unreferenceable from a
relation column living in the target vault.

## What does NOT cross the vault boundary

- **Project relations.** A project id from the source vault's Projects
  DB is meaningless in the target vault. The promoted row lands with
  `Project = []`; re-scope via `lore-memory action='update'` in the
  target vault if needed.
- **Tags.** Mirrors the projectIds treatment for the same reason —
  taxonomy is vault-local. The closed `Tag` vocabulary is enforced
  at the MCP boundary, not at the service layer, so target-vault tag
  vocabularies can diverge from the source's. The promoted row lands
  with `Tags = []`; re-tag via `lore-memory action='update'` against
  the target-vault MCP boundary if needed.
- **Agent / Session attribution.** Promotion is operator-deliberate,
  not an agent-attributed write. The Agent and Session columns on the
  promoted row are left empty; the `Author` column is set to the
  resolved promoter.
- **`source` provenance.** The promoted row's `Source` column is
  forced to `manual` — a cross-vault copy is not an autosave / file /
  digest derivation of new content; it is an operator-curated copy.

## Dry run

Pass `--dry-run` to preview what the apply path would write without
touching the target vault:

```
$ lore promote 1234abcd5678 --to Team --reason "Trial run" --dry-run
[dry-run] Would promote to Team: JWT auth pattern for service-to-service calls (awaiting review)
[dry-run] Resolved status: proposed
[dry-run] Promoter: Engineer Name
[dry-run] Audit block preview:
  ## Promoted from Primary

  - **Source memory:** [1234abcd5678…](https://notion.so/1234abcd5678…)
  - **Source vault:** Primary
  …
[dry-run] No target-vault write was issued. Re-run without --dry-run to apply.
```

Dry-run issues one `pages.retrieve` + one `pages.retrieveMarkdown` on
the source vault — same source-side cost as the apply path. The
target-vault load and target-vault create are both skipped.

## Same-vault guard

`lore promote --to <name>` rejects targets whose `pageId` equals the
primary vault page id. Both ids are normalized (strip hyphens,
lowercase) before comparison so the guard catches the equivalent
shapes Notion accepts for the same page (`abc12345-6789-…` vs
`abc1234567...`). Without this normalization a misconfigured
`.lore.yaml` carrying the same id in two different forms could
bypass the guard and silently duplicate a row inside the same vault
under the audit shape; the guard surfaces a clear redirect to
`lore-memory action='update'`.

## Source validation

`lore promote` reads the source memory via the live-Memories-page
gate (`MemoryService.getPropertiesById`), which rejects archived rows
and pages whose parent is not the primary vault's Memories DB. A
fat-fingered Notion page id pointing at another database — or an
archived source — fails fast with the underlying error, before any
target-vault round-trip. Without this gate, `lore promote <any
accessible page id>` would copy from any database while the audit
block claimed primary-vault provenance.

## Idempotency posture

`lore promote` is idempotent for a given source vault, source memory,
and target vault. Promoted target rows carry an additive Memories DB
property named `Promotion Source Key`. It is a `rich_text` property
populated only on rows created by cross-vault promotion. The key format
is:

```text
v1:<normalized-source-vault-page-id>:<normalized-source-memory-page-id>
```

Both ids are normalized the same way as the same-vault guard: strip
hyphens and lowercase. The source vault id is the primary vault page id
from the promoting process, not the target vault id. The target vault
itself scopes the lookup, so promoting the same source memory to two
different targets still creates one row in each target.

The apply path probes the target Memories DB for exact
`Promotion Source Key` equality before create. If one live row matches,
promotion returns that row with outcome `already-promoted` and writes
nothing. If no row matches, promotion creates a row with the key set
and returns outcome `created`. Title, body, synopsis, status, reason,
promoter, timestamp, or audit-block equality are never used as the
dedupe key: two distinct source memories can contain identical content,
and legacy promoted rows can carry edited bodies after review.

Schema/setup behavior:

- New vault setup adds `Promotion Source Key` to the Memories DB.
- `lore migrate` adds the property to the primary vault named by the
  active config, as an add-only schema migration.
- `lore promote` does not auto-migrate a promotion target. If the
  target Memories DB is missing `Promotion Source Key`, it must fail
  before create with setup guidance to run `lore migrate` against that
  target vault.
- Legacy promoted rows with an empty key are not deduped by title/body
  fallback. A backfill that parses historical audit blocks would be a
  separate explicit migration.

CLI response contract after implementation:

```text
Promoted to Team: JWT auth pattern for service-to-service calls (awaiting review)
  Target memory ID: 9876fedc4321
  Outcome: created
  Status: proposed
  Promoter: Engineer Name
  Reason: Generalizes pattern
```

```text
Already promoted to Team: JWT auth pattern for service-to-service calls (awaiting review)
  Target memory ID: 9876fedc4321
  Outcome: already-promoted
  Status: proposed
  Promoter: Engineer Name
```

The MCP `lore-memory action='promote'` response mirrors the same
created vs already-promoted wording. Its cost outputs report
`memoriesCreated: 1` only for the created path; the already-promoted
path returns the existing memory without incrementing created counts.
`--dry-run` remains target-write-free and target-probe-free: it previews
the audit block and resolved status, but it does not claim whether a
matching target row already exists.

## Promoter identity

The audit block's `Promoter:` line is resolved via
`services.identity.resolveAuthor()` (the same `LORE_USER_NAME` →
`users.me` chain that authors Memory writes). An unresolvable identity
fails fast with exit code 1 rather than landing an audit block
attributed to `(unknown)`. Pass `--promoter <name>` to override.

## Implementation pointers

- [`src/core/promote.ts`](../src/core/promote.ts) — `promoteMemory`
  service helper and `buildPromotionAuditBlock` audit format.
- [`src/cli/commands/promote.ts`](../src/cli/commands/promote.ts) —
  CLI wrapper, target lookup, promoter resolution.

## Cross-references

- [`docs/topology.md`](topology.md) — `lore status` topology section,
  promotion-target health rows, and recovery workflow.
- [`docs/cli.md`](cli.md) — `lore promote` command reference.
- [`docs/development.md`](development.md) — `promotionTargets`
  configuration context.
- [`src/core/AGENTS.md`](../src/core/AGENTS.md) — `promote.ts`
  implementation notes.
