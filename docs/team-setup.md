# Team Setup Notes

This doc collects the topics most teams hit during onboarding:

- [Entities Database Cutover](#entities-database-cutover) — required for
  vaults created before the Entities database was introduced.
- [Known gotcha: direct ntn login outside Lore](#known-gotcha-direct-ntn-login-outside-lore)
  — only affects engineers who run `ntn login` themselves rather than letting
  Lore drive the flow.
- [Shared-vault hook configuration](#shared-vault-hook-configuration) — the
  one `.lore.yaml` knob to set when many engineers share a single Lore
  workspace.

For the full team-rollout playbook (per-engineer onboarding flow, the
`NOTION_API_TOKEN` fallback path, fail-fast env mismatches), see
[`internal-rollout.md`](internal-rollout.md). The two files cover overlapping
ground deliberately while the rename to a public-friendly filename is tracked
in [#571](https://github.com/makenotion/lore/issues/571).

## Entities Database Cutover

Current Lore versions require every vault page to contain five child
databases: Projects, Topics, Memories, Entities, and Facts. Vaults
created before the Entities database was introduced may have
Projects/Topics/Memories/Facts but no Entities database. Those pages
are partial vault schemas under the current contract.

Do **not** run `lore init <page-id>` against a partial vault page.
Initialization is only for empty pages; creating a second set of
Projects/Topics/Memories/Entities/Facts under the same Notion page can
split future reads across duplicate database titles. Newer Lore builds
refuse this case, but operators upgrading manually should treat it as a
hard stop.

Self-service repair for a four-database vault:

1. Upgrade Lore.
2. Run `lore vault ensure-entities`. This creates the `Entities` child
   database with the supported schema and runs the additive schema
   migration so Facts gains `SubjectEntity` / `ObjectEntity`.
3. Run `lore migrate --build-entities --yes` in a quiet window to create
   canonical Entity rows and re-point existing Fact rows. The
   row-level `SubjectKey` fallback remains available until every row is
   backfilled.

`lore vault ensure-entities --dry-run` previews the bootstrap step
without writing. If a vault is missing any required child database other
than Entities, stop and inspect the page manually before running any
write command. The supported repair path is to restore the missing
database from backup or recreate it with the documented schema, then run
`lore migrate`.

## Known gotcha: direct ntn login outside Lore

Lore-spawned ntn invocations (via `lore install`,
`lore auth --login`, `lore init` no-arg, `lore auth --migrate`)
force `NOTION_KEYRING=0` in their spawn env, so the resulting
token lands in `~/.config/notion/auth.json` where Lore can read
it. **Engineers don't need to set `NOTION_KEYRING=0` in their
shell rc for the Lore install path.**

The gotcha: if an engineer later runs `ntn login` _directly_
(outside Lore — e.g., to switch workspaces or use ntn for other
purposes) without `NOTION_KEYRING=0` in their shell, ntn falls
back to the macOS Keychain (its default). Lore doesn't read
keychain-mode storage, so subsequent `lore` commands fail to find
a token.

Two paths back to a working state:

1. **Run `lore auth --login` again.** This re-spawns ntn login
   with `NOTION_KEYRING=0` forced; the new token writes to
   auth.json; Lore reads it.
2. **Add `export NOTION_KEYRING=0` to shell rc and re-run
   `ntn login` directly.** The token writes to auth.json
   permanently; future direct ntn invocations stay
   Lore-readable. Shell-rc commands:

   ```bash
   # zsh
   echo 'export NOTION_KEYRING=0' >> ~/.zshrc
   source ~/.zshrc

   # bash
   echo 'export NOTION_KEYRING=0' >> ~/.bashrc
   source ~/.bashrc

   # fish
   set -Ux NOTION_KEYRING 0
   ```

   Verify with `echo $NOTION_KEYRING` — should print `0`. After
   this, both Lore-spawned and direct ntn invocations write to
   auth.json, and Lore can read either.

Engineers who only run ntn through Lore never hit this gotcha.
Engineers who use ntn for other purposes (workers, page
management, etc.) and want bidirectional consistency should adopt
path 2 as a one-time setup.

## Shared-vault hook configuration

> Origin: [issue #281](https://github.com/makenotion/lore/issues/281)
> (closed; live behavior documented in
> [`memory-workflows.md`](memory-workflows.md)).

For shared-vault deployments where many engineers share a single Lore
workspace, set `hooks.proposeAutosaveLearnings: true` in `.lore.yaml`.
This routes every auto-extracted learning through the proposed-memory
review inbox (`Status = proposed`) instead of writing it directly to
accepted recall. The trust boundary keeps a noisy session from
polluting recall for everyone before a human reviewer approves the
learning. Reviewers act on the inbox via `lore inbox list` /
`lore inbox approve <id>` / `lore inbox reject <id>` /
`lore inbox archive <id>` (CLI), or `lore-memory action='approve'` /
`lore-memory action='reject'` (MCP); both surfaces share the same
`MemoryService.recordReview` service path and append a
`## Reviewed (YYYY-MM-DD)` audit block with the reviewer + timestamp.
Both terminal verdicts drop the row out of the proposed-memory
inbox: `approve` makes it eligible for default recall, `reject`
keeps it off default recall (the
`reviewTerminalStatusExclusionFilters` default-exclude on
`MemoryService.list` / `search` / `queryStaleConfidence` covers
both `proposed` and `rejected`), so neither verdict pollutes
shared recall with noisy auto-extractions. The inbox
depth also surfaces in `lore status`'s **Proposed memories** line
and the wake-up **Proposed Memories** section.

Single-engineer / personal-vault deployments can leave the flag at
its `false` default — the inbox surface still exists if the engineer
manually saves with `status: "proposed"`, but autosave-learning
saves go straight into recall.

See [`hooks.md`](hooks.md) for the reference of the underlying
`learningExtraction` / `proposeAutosaveLearnings` knobs.
