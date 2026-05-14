/**
 * Compatibility barrel for Lore shared types and policy constants.
 *
 * Concern-specific modules live under `types/` and `policy/`; keep this
 * barrel so existing internal and external imports remain stable.
 */
export * from "./types/domain.js"
export * from "./types/persistence.js"
export * from "./types/scope.js"
export * from "./types/search.js"
export * from "./types/config.js"
export * from "./policy/confidence.js"
export * from "./policy/pinned.js"
