/**
 * Public surface for the quarantined RunTool integration narrowed to
 * the `update_page` consumer. Phase 0 (issue #532) shipped the
 * contract README; issue #533 (PR #538) landed the shared
 * `runTool<T>(client, tool, params)` dispatcher in `client.ts` along
 * with the `create_pages` consumer in `create-pages.ts`; issue #534
 * (PR #537) extends with `update_page` / `update_content` for
 * anchored markdown edits.
 *
 * This module intentionally re-exports only the `update_page`
 * surface that `MemoryService` and `memory-encoding.ts` consume —
 * `runTool`, `runUpdatePageContent`, `createPagesViaRunTool`, and
 * the search / aggregate wrappers from #532's Phase 1+ are imported
 * directly from their per-consumer modules to keep this barrel
 * narrow.
 */

export { isRunToolBlockEditEnabled, isRunToolEnabled } from "./flag.js"
export {
  RunToolBlockEditError,
  updatePageContentViaRunTool,
} from "./update-page.js"
export type {
  RunToolBlockEditFailureKind,
  UpdatePageContentEdit,
  UpdatePageContentParams,
} from "./update-page.js"
