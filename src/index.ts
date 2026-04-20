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
  Fact,
  CreateFactInput,
  FactPredicate,
  FactConfidence,
  LoreConfig,
  ResolvedContext,
} from "./types.js"

export { findConfigFile, loadConfig, resolveToken, resolveAuth } from "./config.js"
export type { ResolvedAuth } from "./config.js"
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
export { MemoryService } from "./core/memory.js"
export { FactService } from "./core/fact.js"
export { DecisionService } from "./core/decision.js"
export { resolveProject } from "./core/context.js"
export type { OAuthCredentials, OAuthConfig } from "./auth/oauth.js"
export { runOAuthFlow, loadCredentials, getAuthorizationUrl } from "./auth/oauth.js"
