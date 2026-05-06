/**
 * Vitest setup hook: pin every RunTool flag OFF for the legacy
 * test corpus.
 *
 * Production default flipped to ON in issue #543 Phase 4 (parent
 * `LORE_USE_RUNTOOL` and every inheriting sub-flag). Most existing
 * tests stub a Notion `Client` shape with only the SDK methods their
 * subject under test exercises (e.g. `client.search`,
 * `client.dataSources.query`). With the parent flag default-on, every
 * legacy semantic / aggregate path would now route through
 * `client.request` and crash with `TypeError: client.request is not a
 * function`.
 *
 * **Hermetic invariant.** The `beforeEach` and `afterEach` hooks
 * UNCONDITIONALLY write `=0` to the parent and every inheriting
 * sub-flag — they do NOT honor pre-existing values. Without this,
 * a developer or CI runner with `LORE_USE_RUNTOOL=1` in their shell
 * environment would see different test outcomes than a clean shell:
 * legacy mock-client tests would crash, and the suite would pass
 * locally but fail under `LORE_USE_RUNTOOL=1 npm test`. Pinned by PR
 * #549 review iteration 1 (#543 Phase 4 blocker 1).
 *
 * Tests that exercise RunTool consumers (e.g. `compat.test.ts`'s A/B
 * harness, `update-page.test.ts`, `search.test.ts`) opt back in by
 * setting `LORE_USE_RUNTOOL_*=1` in their own `beforeEach` — those
 * hooks run AFTER this setup hook (Vitest invokes setupFile hooks
 * before per-file hooks), so the override wins for the duration of
 * that test, and the global `afterEach` resets back to the hermetic
 * `=0` baseline.
 *
 * The unit-level flag tests in those files pass an explicit empty
 * env object to `is*Enabled({})`, which directly exercises the
 * parser defaults without consulting `process.env` — those still
 * pin the production default-on contract independently of this
 * setup hook.
 */
import { afterEach, beforeEach } from "vitest"
import { __resetRunToolFlagWarningsForTest } from "../src/notion/runtool/flag.js"

const RUNTOOL_FLAGS = [
  "LORE_USE_RUNTOOL",
  "LORE_USE_RUNTOOL_BLOCK_EDIT",
  "LORE_USE_RUNTOOL_FILTER_SQL",
  "LORE_USE_RUNTOOL_SEARCH",
  "LORE_USE_RUNTOOL_AGGREGATE",
  // BATCH_CREATES does NOT inherit from the parent and is
  // separately security-reviewed (#533 carve-out for partial-commit
  // failure). Pin it OFF too so a legacy test of the batched
  // create_pages path doesn't crash on a stub without `request`.
  "LORE_USE_RUNTOOL_BATCH_CREATES",
] as const

function pinAllRunToolFlagsOff(): void {
  for (const flag of RUNTOOL_FLAGS) {
    process.env[flag] = "0"
  }
}

// Guard the initial value too, in case any module-level code reads
// the flag at import time before the first beforeEach fires.
pinAllRunToolFlagsOff()

beforeEach(() => {
  pinAllRunToolFlagsOff()
  // Clear the unrecognized-value warning latch between tests so a
  // test that exercises a typo'd flag value sees the warning fire,
  // and so an earlier test's warning doesn't suppress a later
  // test's expectation.
  __resetRunToolFlagWarningsForTest()
})

afterEach(() => {
  // Reset back to the hermetic baseline so a test that set `=1`
  // doesn't leak into the next file's setup. Without this, the
  // first test of the next file sees the `=1` until the next
  // `beforeEach` fires — which is too late for any module-level
  // flag read at file import time.
  pinAllRunToolFlagsOff()
})
