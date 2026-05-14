export type {
  Vault,
  VaultDatabases,
  DatabaseRef,
  Project,
  CreateProjectInput,
  ProjectType,
  ProjectStatus,
  ProjectListStatus,
  Topic,
  CreateTopicInput,
  Memory,
  MemoryWithoutContent,
  CreateMemoryInput,
  UpdateMemoryInput,
  SearchMemoriesInput,
  MemorySource,
  MemoryKind,
  MemoryStatus,
  MemoryConfidence,
  Decision,
  DecisionSummary,
  DecisionStatus,
  CreateDecisionInput,
  ListDecisionsOpts,
  Entity,
  EntityKind,
  EntityResolution,
  CreateEntityInput,
  Fact,
  CreateFactInput,
  FactPredicate,
  FactConfidence,
  LoreConfig,
  ProjectConfig,
  PromotionTargetConfig,
  ResolvedContext,
  UpstreamVaultConfig,
} from "./types.js"

export { findConfigFile, loadConfig, resolveToken, resolveAuth } from "./config.js"
export type { AuthSource, ResolvedAuth } from "./config.js"
export {
  defaultProfileSelector,
  loadProfileFromRoot,
  parseProfileSelector,
  resolveProfileFromConfig,
} from "./profile/index.js"
export type {
  ProfileManifest,
  ResolvedProfile,
  ResolvedProfileSchema,
  ResolvedProfileTaxonomy,
  ResolvedPromptRegistry,
} from "./profile/index.js"
export { createClient } from "./notion/client.js"
export { createVaultDatabases, verifyVaultDatabases } from "./notion/setup.js"
export { VaultManager } from "./core/vault.js"
export { ProjectService } from "./core/project.js"
export type { ProjectNameResolution } from "./core/project.js"
export {
  isFullPage,
  extractTitle,
  extractRichText,
  extractSelect,
  extractMultiSelect,
  extractRelationIds,
  extractDate,
} from "./notion/extractors.js"
export { projectOrUnscopedFilter } from "./notion/filters.js"
export type { LoreServices } from "./services.js"
export { initServices } from "./services.js"
export { TopicService } from "./core/topic.js"
export {
  MemoryService,
  MemoryCreatePartialFailureError,
  MemoryUpdatePartialFailureError,
  RekeyAuditError,
  PartialUpdateError,
} from "./core/memory.js"
export type { ListMemoriesOptions } from "./core/memory.js"
export {
  TaskCreatePartialFailureError,
  TaskUpdatePartialFailureError,
} from "./core/task.js"
export { FactService } from "./core/fact.js"
export type {
  FactEntityRepointPlan,
  FactEntityRepointResult,
  RepointEntityOptions,
} from "./core/fact.js"
export { DecisionCreatePartialFailureError, DecisionService } from "./core/decision.js"
export { EntityService } from "./core/entity.js"
export type { ArchiveEntityOptions, GetEntityOptions } from "./core/entity.js"
export {
  aliasesForEntityMerge,
  mergeEntities,
  type EntityMergeError,
  type EntityMergeErrorPhase,
  type EntityMergeOptions,
  type EntityMergeResult,
} from "./core/entity-merge.js"
export {
  resolveProject,
  isCatchAllProject,
  subProjectNames,
  catchAllProjectName,
} from "./core/context.js"
export type { ProjectResolution } from "./core/context.js"
export {
  DEFAULT_UPSTREAM_PRIORITY,
  buildVaultTopology,
  hasConfiguredTopology,
} from "./core/topology.js"
export type {
  PrimaryVaultTopologyRef,
  PromotionTargetTopologyRef,
  UpstreamVaultTopologyRef,
  VaultTopology,
} from "./core/topology.js"
export {
  PROMOTION_REASON_MAX_LEN,
  buildPromotionAuditBlock,
  preparePromotion,
  promoteMemory,
} from "./core/promote.js"
export type {
  PromoteMemoryInput,
  PromoteMemoryResult,
  PromoteMemoryServices,
  PromotionPreview,
} from "./core/promote.js"
export { buildUpstreamVaultBundles } from "./core/topology-readers.js"
// `UpstreamReaders` is intentionally NOT re-exported as a public
// type. Today it carries only `memories: MemoryService` for the
// wake-up inheritance fan-out; a future fact-side inheritance
// surface would extend it, but external consumers building against
// the current shape would have to migrate. Keep the public surface
// to the bundle interface (which is the actually-stable shape) and
// the builder function.
export type { UpstreamVaultBundle } from "./core/topology-readers.js"
export type { VaultAccessResult } from "./auth/oauth.js"

// Individual deprecation-tagged re-exports. The `@deprecated` JSDoc on
// each `export` statement propagates through TypeScript's deprecation
// analysis to the consumer's import site, so an IDE hover on
// `import { runOAuthFlow } from "@makenotion/lore"` shows the
// strikethrough — the JSDoc at the original definition site only
// propagates through goto-definition.
//
// Removal target: 0.14.0, aligning with `LORE_NOTION_TOKEN` /
// `auth.token` hard-removal.

/**
 * @deprecated Removal targeted for 0.14.0. PATs (issued at
 * https://www.notion.so/developers/tokens) replace the BYO-integration
 * OAuth path; new code MUST NOT use this export. The authentication
 * doc carries the PAT operator flow.
 */
export { runOAuthFlow } from "./auth/oauth.js"

/**
 * @deprecated Removal targeted for 0.14.0. See `runOAuthFlow`.
 */
export { loadCredentials } from "./auth/oauth.js"

/**
 * @deprecated Removal targeted for 0.14.0. See `runOAuthFlow`.
 */
export { getAuthorizationUrl } from "./auth/oauth.js"

/**
 * @deprecated Removal targeted for 0.14.0. See `runOAuthFlow`.
 */
export type { OAuthCredentials } from "./auth/oauth.js"

/**
 * @deprecated Removal targeted for 0.14.0. See `runOAuthFlow`.
 */
export type { OAuthConfig } from "./auth/oauth.js"

export { verifyVaultAccess } from "./auth/oauth.js"
export type {
  NtnTokenRecord,
  LoadNtnTokenInput,
  NtnLoginResult,
  NtnInstallResult,
} from "./auth/ntn.js"
export {
  loadNtnToken,
  listNtnWorkspaces,
  isNtnInstalled,
  getNtnVersion,
  checkNtnVersion,
  runNtnLogin,
  installNtn,
  MIN_NTN_VERSION,
  NTN_INSTALL_COMMAND,
} from "./auth/ntn.js"
