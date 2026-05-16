# Vault Topology

`lore status` renders a **Vault topology** section when `.lore.yaml`
configures `upstreamVaults` or `promotionTargets`. The section reports the
configured relationship between the primary vault, read-only upstreams, and
deliberate promotion targets, and probes each remote vault's health on the
shared service client.

This page covers the operator-facing contract: when the section renders,
what the output means, every health string the surface can emit, and the
recovery workflow for each degraded state. The implementation lives in
[`src/core/topology-status.ts`](../src/core/topology-status.ts) and
[`src/core/topology.ts`](../src/core/topology.ts); see
[`src/core/AGENTS.md`](../src/core/AGENTS.md) for service-pattern context.

Read-upstream wake-up behavior lives in
[`docs/topology-inheritance.md`](topology-inheritance.md). Promotion workflow
material lives in [`docs/topology-promotion.md`](topology-promotion.md).

## When the section renders

The section is suppressed entirely when neither key is configured, so a
single-vault `.lore.yaml` produces byte-identical output to pre-topology
releases. Either key alone fires the section:

```yaml
# .lore.yaml — single-vault config: section suppressed
vault:
  pageId: "abc123…"
```

```yaml
# .lore.yaml — topology-aware config: section renders
vault:
  pageId: "abc123…"
upstreamVaults:
  - name: Engineering
    pageId: "def456…"
    priority: 10            # optional; lower numbers render first; default 100
  - name: Policy
    pageId: "ghi789…"
promotionTargets:
  - name: Team
    pageId: "jkl012…"
    requireReview: true     # optional; default false
```

Normal memory / fact / decision / task **writes** still target only
`vault.pageId`. Upstreams are read-only context; promotion targets are
explicit cross-vault destinations the deliberate promotion flow writes
against. Topology is a status / read-orchestration concept, not a write
fanout.

## Output shape

A configured topology section renders below `Current project:` and above
`Database counts:` in `lore status`. All examples below use placeholder
labels and page ids (`primary-page`, `engineering-page`, etc.) and
illustrative ages — real output uses the configured `name` / `pageId`
from `.lore.yaml` and the actual probe age. Annotated example:

```
Vault topology:
  primary: Primary · mode read-write · page primary-page · health ok (loaded by current status request)
  upstreams:
    - Engineering · mode read-only · priority 10 · page engineering-page · health ok (checked just now)
    - Policy · mode read-only · priority 100 · page policy-page · health unavailable (404 not found; checked 2s ago)
  promotion targets:
    - Team · mode promotion (review required) · page team-page · health missing databases (Entities; cached 30s ago)
    - Org · mode promotion · page org-page · health ok (cached 12m ago)
```

A promotion-targets-only configuration suppresses the `upstreams:` block
and renders only the primary plus `promotion targets:` block:

```
Vault topology:
  primary: Primary · mode read-write · page primary-page · health ok (loaded by current status request)
  promotion targets:
    - Team · mode promotion (review required) · page team-page · health ok (checked just now)
```

Symmetrically, an upstreams-only configuration renders only the primary
plus `upstreams:` block.

Each row joins fields with ` · ` (U+00B7). Field order is fixed:

| Field      | Possible values                                                                                | Notes                                                                |
| ---------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| label      | configured `name` (primary uses the literal `Primary`)                                          |                                                                      |
| `mode`     | `read-write` (primary) · `read-only` (upstream) · `promotion` · `promotion (review required)` | promotion variant depends on `requireReview`                         |
| `priority` | integer (upstreams only)                                                                       | omitted on primary and promotion rows                                |
| `page`     | configured `pageId`                                                                            | unstyled — operators copy into other tools                           |
| `health`   | see [Health states](#health-states)                                                             | parenthetical detail and freshness only when present                 |

Upstreams sort by `priority` ascending (lower fires first), with config
order preserved on ties. Promotion targets render in config order.

### The primary row's `ok` is presentational

The primary row is not probed. `initServices()` already loaded the primary
vault before the status request reached this surface, so the row reports
`ok (loaded by current status request)` as a structural acknowledgement —
NOT as evidence that the probe ran during this status call. A failing
primary surfaces upstream as an `initServices()` error (different output
path), never as a degraded primary row.

### Freshness markers

Every probed health line in `lore status` output carries a `checked` /
`cached` / `debounced` marker plus a humanized age. (Direct callers of
`loadVaultTopologyStatus` that opt out of the on-disk cache may render
markerless lines; the operator-facing CLI path always opts in.)

| Marker      | Meaning                                                                                                                                                           |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `checked`   | This `lore status` invocation issued the probe and wrote the cache entry. Authoritative reading.                                                                  |
| `cached`    | Probe was satisfied by an on-disk cache entry from a prior invocation (TTL = 60s, `TOPOLOGY_STATUS_CACHE_TTL_MS`). Applies to all probe outcomes — `ok`, `missing databases`, and `unavailable` are all cached for the full TTL. Re-run after the TTL to refresh. |
| `debounced` | A concurrent invocation was already probing the same vault; this run reused that in-flight result. Treat as equivalent to `checked`.                              |

Cache entries live under the hook state directory keyed by
`(configRoot, pageId)`, where `configRoot` is the absolute path to the
directory containing the resolving `.lore.yaml`. The cache key is
`sha256(configRoot + "\0" + pageId)` truncated to 16 hex chars, so the
sharing condition is **path equality on `configRoot`**, not file-content
equivalence:

- A second `lore status` from the same checkout within 60s reuses the
  prior probe.
- Two checkouts pointing at the same vault — including two git
  worktrees of the same repo — each maintain their own 60s suppression
  window, because each has its own absolute `configRoot` path.
- `LORE_CONFIG_ROOT` is the explicit override that lets two invocations
  collapse onto a shared key.

Probe concurrency is bounded to 2 (`TOPOLOGY_STATUS_PROBE_CONCURRENCY`)
to protect the shared Notion rate-limit bucket from large topologies.

Age is rendered as `just now`, `Ns ago`, `Nm ago`, `Nh ago`, or `Nd ago`.

The 60s TTL is fixed in source (`TOPOLOGY_STATUS_CACHE_TTL_MS`); there
is no env-override knob for tuning it. If the wait-out-the-window
workflow becomes operator-hostile, the next step is a code change and a
release, not configuration.

## Health states

Three states are emitted by the health classifier in
`topology-status.ts:checkVaultHealth`:

### `ok`

Vault loaded cleanly. Lore read its child databases and recognized the
five-database core schema (Projects, Topics, Memories, Entities, Facts).

```
health ok (checked just now)
```

No action required.

### `missing databases (...)`

Lore found the page but the schema is incomplete. The parenthetical names
the missing databases. Triggered by `MissingVaultDatabasesError` in
`src/notion/setup.ts`. Common cases:

- **A pre-Entities legacy vault** (`Entities` and / or related Facts
  columns missing). Run [`lore vault ensure-entities`](cli.md) against
  that vault to add the Entities database and the additive Facts
  columns. Plan-only by default; pass `--dry-run` for a preview.
- **A vault initialized for a different purpose** (a Notion page that
  is not actually a Lore vault). Remove the entry from `upstreamVaults`
  / `promotionTargets`, or point it at the correct page id.
- **Drift on a live vault** — properties were renamed or removed in
  Notion. Run [`lore migrate`](cli.md) against the vault to add
  missing properties; do NOT manually rename columns in Notion (see
  the schema-stability rule in [`AGENTS.md`](../AGENTS.md)).

```
health missing databases (Entities; checked just now)
health missing databases (Projects, Topics, Memories, Entities, Facts; cached 30s ago)
```

The all-five form indicates the page does not contain any Lore
databases — almost always a misconfigured `pageId`.

### `unavailable (...)`

The probe threw any error other than `MissingVaultDatabasesError`. The
parenthetical carries the underlying error message verbatim — it is
whatever the Notion SDK put on `err.message`, not a fixed lore string.

Most `unavailable` failures fall in two buckets: **config shape** (the
`pageId` in `.lore.yaml` is wrong) and **auth/share state** (the token
can't reach the page). Triage in that order: run `lore auth --status`
first to rule out the auth bucket, then verify the `pageId` against
Notion.

The `Symptom` column below shows substrings paraphrased from real
Notion errors; match by substring (`object_not_found`, `unauthorized`,
`restricted_resource`) rather than expecting the exact strings to
appear in `lore status` output. Notion's actual messages are typically
longer (e.g., `object_not_found: Could not find page with ID …`).

| Symptom substring                                            | Likely cause                                                                                          | Recovery                                                                                                                                |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `object_not_found` / `404`                                   | `pageId` is wrong, the page was deleted, or the page was moved to a workspace the token can't reach.  | Verify the page id in Notion. Update or remove the entry in `.lore.yaml`.                                                               |
| `unauthorized` / `restricted_resource`                       | The current auth token does not have access to that page.                                             | For ntn-issued tokens and PATs in `NOTION_API_TOKEN`, share the page with the operator's Notion user. Do not recover by distributing one shared integration token. |
| Notion 5xx / network errors                                  | Transient Notion outage or local network blip.                                                        | The failure is cached for the 60s TTL like any other probe outcome. Wait out the cache window before re-checking.                       |
| `restricted_resource` from an ntn-issued token specifically  | An ntn-issued token cannot read a page the engineer has not been added to.                            | Share the upstream / promotion target page with the engineer in Notion.                                                                 |

```
health unavailable (404 not found; checked just now)
health unavailable (HTTP 401 unauthorized; cached 12s ago)
```

A failing probe never blocks `lore status`; the rest of the status output
renders normally. An `unavailable` upstream also does NOT prevent normal
writes (which target the primary vault) — read-orchestration paths that
depend on the upstream may degrade or skip until the issue is resolved.

## Operator recovery workflow

The same pattern applies to all degraded states:

1. **Identify which row is degraded.** The label and page id name the
   `.lore.yaml` entry.
2. **Read the parenthetical.** It is the underlying error message, not a
   summary — use it to triage.
3. **Apply the recovery from the matching row in [Health states](#health-states).**
4. **Re-run `lore status` after the cache window.** All probe outcomes —
   including `unavailable` and `missing databases` — are cached for the
   60s TTL, so a re-run inside that window returns the same `cached`
   result without re-probing. Wait out the TTL, then a fresh probe will
   surface the post-fix state as `checked`.

If the same vault is degraded for multiple operators, the issue is almost
certainly in `.lore.yaml` or in the Notion-side share state of the page.
If only one operator sees the degradation, look at their auth source first
(see [`docs/authentication.md`](authentication.md)).

## Inheritance

Read-upstream wake-up behavior lives in
[`docs/topology-inheritance.md`](topology-inheritance.md). This status
contract still owns upstream health rows and recovery; the inheritance doc
owns wake-up rendering, trust containment, design rules, opt-out behavior,
and the promotion-target read-upstream carve-out.

## Promotion

Promotion workflow material lives in
[`docs/topology-promotion.md`](topology-promotion.md). This anchor remains
as a compatibility pointer for older references to `docs/topology.md#promotion`.

## Cross-references

- [`docs/cli.md`](cli.md) — `lore status` and `lore promote` command
  reference.
- [`docs/topology-inheritance.md`](topology-inheritance.md) —
  read-upstream wake-up rendering, trust containment, design rules,
  opt-out behavior, and the promotion-target read-upstream carve-out.
- [`docs/topology-promotion.md`](topology-promotion.md) — promotion
  workflow, audit block, dry run, guards, source validation, idempotency,
  promoter identity, and implementation pointers.
- [`docs/development.md`](development.md) — `upstreamVaults` and
  `promotionTargets` configuration context.
- [`src/core/AGENTS.md`](../src/core/AGENTS.md) — `topology.ts` /
  `topology-status.ts` implementation notes (probe concurrency, cache
  semantics, primary-row presentation).
- [`src/notion/setup.ts`](../src/notion/setup.ts) — home of
  `MissingVaultDatabasesError` and the child-database title checks that
  drive the `missing databases` health state.
- [`docs/authentication.md`](authentication.md) — auth priority chain;
  most `unavailable` failures come from token / share-state mismatches.
