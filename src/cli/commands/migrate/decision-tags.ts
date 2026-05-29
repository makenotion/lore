import type { LoreServices } from "../../../services.js"

/**
 * Upgrade legacy memories tagged `decision` to `Kind: decision`, stripping
 * the tag in the process. Idempotent: after upgrade, the query returns no
 * results and re-running is a no-op.
 *
 * Iterates in a loop calling `list({ tags: ["decision"] })` — since each
 * iteration upgrades the matched pages (removing the tag), subsequent
 * iterations only see remaining un-upgraded memories.
 */
export async function upgradeLegacyDecisionTags(services: LoreServices): Promise<number> {
  const BATCH_SIZE = 100
  let upgraded = 0

  while (true) {
    // `includeProposed: true` opts out of the `Status != proposed`
    // default-recall filter. Pre-`Kind` legacy
    // rows tagged `decision` may carry any status — including
    // proposed — and the upgrade-then-strip contract must catch
    // every such row to be idempotent. Without the opt-in, a
    // proposed-status legacy `decision`-tagged row would persist
    // across the migration and resurface only after the row's
    // status changes.
    // Retired source values are included for the same reason: this
    // command repairs legacy metadata, not recall results.
    const { items: batch } = await services.memories.list({
      tags: ["decision"],
      limit: BATCH_SIZE,
      includeContent: false,
      includeProposed: true,
      includeRetiredSources: true,
    })

    // Defensive filter in case a memory is already Kind=decision but still
    // has the tag for some reason — we still strip the tag in that case.
    const toUpgrade = batch.filter((m) => m.tags.includes("decision"))
    if (toUpgrade.length === 0) break

    for (const m of toUpgrade) {
      const newTags = m.tags.filter((t) => t !== "decision")
      await services.memories.update(m.id, {
        kind: "decision",
        tags: newTags,
      })
      upgraded++
    }
  }

  return upgraded
}
