export type {
  Vault,
  VaultDatabases,
  DatabaseRef,
  Project,
  CreateProjectInput,
  ProjectType,
  ProjectStatus,
  Topic,
  CreateTopicInput,
  Memory,
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
  ResolvedContext,
} from "./types.js"

export { findConfigFile, loadConfig, resolveToken, resolveAuth } from "./config.js"
export type { AuthSource, ResolvedAuth } from "./config.js"
export { createClient } from "./notion/client.js"
export { createVaultDatabases, verifyVaultDatabases } from "./notion/setup.js"
export { VaultManager } from "./core/vault.js"
export { ProjectService } from "./core/project.js"
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
  RekeyAuditError,
  PartialUpdateError,
} from "./core/memory.js"
export { TaskCreatePartialFailureError } from "./core/task.js"
export { FactService } from "./core/fact.js"
export { DecisionCreatePartialFailureError, DecisionService } from "./core/decision.js"
export { EntityService } from "./core/entity.js"
export {
  resolveProject,
  isCatchAllProject,
  subProjectNames,
  catchAllProjectName,
} from "./core/context.js"
export type { ProjectResolution } from "./core/context.js"
export type { OAuthCredentials, OAuthConfig, VaultAccessResult } from "./auth/oauth.js"
export {
  runOAuthFlow,
  loadCredentials,
  getAuthorizationUrl,
  verifyVaultAccess,
} from "./auth/oauth.js"
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
