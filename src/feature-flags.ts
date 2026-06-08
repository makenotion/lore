import type { LoreFeatureConfig } from "./types.js"
import {
  isRunToolAggregateEnabled,
  isRunToolBlockEditEnabled,
  isRunToolEnabled,
  isRunToolFilterSqlEnabled,
  isRunToolSearchEnabled,
} from "./notion/runtool/index.js"

export interface LoreFeatureFlags {
  nearDuplicateProbe: boolean
  autosaveLearningDedup: boolean
  autoMentions: boolean
  taskReuse: boolean
  taskCrossref: boolean
  learningExtraction: boolean
  confidenceFactor: boolean
  queryPlanning: boolean
  forceSemanticSearch: boolean
  runTool: {
    enabled: boolean
    blockEdit: boolean
    filterSql: boolean
    search: boolean
    aggregate: boolean
    batchCreates: boolean
  }
}

export const LORE_FEATURE_FLAG_TAXONOMY = {
  killSwitches: [
    "LORE_DISABLE_NEAR_DUPLICATE_PROBE",
    "LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP",
    "LORE_DISABLE_AUTO_MENTIONS",
    "LORE_DISABLE_TASK_REUSE",
    "LORE_DISABLE_TASK_CROSSREF",
    "LORE_DISABLE_LEARNING_EXTRACTION",
    "LORE_DISABLE_CONFIDENCE_FACTOR",
    "LORE_DISABLE_QUERY_PLANNING",
  ],
  forceSwitches: ["LORE_FORCE_SEMANTIC_SEARCH"],
  runTool: [
    "LORE_USE_RUNTOOL",
    "LORE_USE_RUNTOOL_BLOCK_EDIT",
    "LORE_USE_RUNTOOL_FILTER_SQL",
    "LORE_USE_RUNTOOL_SEARCH",
    "LORE_USE_RUNTOOL_AGGREGATE",
    "LORE_USE_RUNTOOL_BATCH_CREATES",
  ],
} as const

const DEFAULT_FLAGS: LoreFeatureFlags = {
  nearDuplicateProbe: true,
  autosaveLearningDedup: true,
  autoMentions: true,
  taskReuse: true,
  taskCrossref: true,
  learningExtraction: true,
  confidenceFactor: true,
  queryPlanning: true,
  forceSemanticSearch: false,
  runTool: {
    enabled: true,
    blockEdit: true,
    filterSql: true,
    search: true,
    aggregate: true,
    batchCreates: false,
  },
}

function cloneDefaultFlags(): LoreFeatureFlags {
  return {
    ...DEFAULT_FLAGS,
    runTool: { ...DEFAULT_FLAGS.runTool },
  }
}

function disabledByEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] === "1"
}

function configThenDisableEnv(
  configured: boolean | undefined,
  env: NodeJS.ProcessEnv,
  envName: string,
  defaultValue = true
): boolean {
  if (disabledByEnv(env, envName)) return false
  return configured ?? defaultValue
}

function hasEnvFlag(env: NodeJS.ProcessEnv, name: string): boolean {
  return env[name] !== undefined
}

function resolveRunToolParent(
  env: NodeJS.ProcessEnv,
  config: LoreFeatureConfig["runTool"] | undefined
): boolean {
  if (hasEnvFlag(env, "LORE_USE_RUNTOOL")) return isRunToolEnabled(env)
  return config?.enabled ?? DEFAULT_FLAGS.runTool.enabled
}

function resolveRunToolInheritedSubFlag(
  env: NodeJS.ProcessEnv,
  envName: string,
  readEnvFlag: (env: NodeJS.ProcessEnv) => boolean,
  configured: boolean | undefined,
  parent: boolean
): boolean {
  if (hasEnvFlag(env, envName)) return readEnvFlag(env)
  if (hasEnvFlag(env, "LORE_USE_RUNTOOL")) return parent
  return configured ?? parent
}

function resolveRunToolBatchCreates(
  env: NodeJS.ProcessEnv,
  config: LoreFeatureConfig["runTool"] | undefined
): boolean {
  const raw = env["LORE_USE_RUNTOOL_BATCH_CREATES"]
  if (raw !== undefined) return raw === "1"
  return config?.batchCreates ?? DEFAULT_FLAGS.runTool.batchCreates
}

export function resolveFeatureFlags(
  env: NodeJS.ProcessEnv = process.env,
  config?: { features?: LoreFeatureConfig } | null
): LoreFeatureFlags {
  const featureConfig = config?.features
  const runToolConfig = featureConfig?.runTool
  const runToolParent = resolveRunToolParent(env, runToolConfig)

  return {
    nearDuplicateProbe: configThenDisableEnv(
      featureConfig?.nearDuplicateProbe,
      env,
      "LORE_DISABLE_NEAR_DUPLICATE_PROBE"
    ),
    autosaveLearningDedup: configThenDisableEnv(
      featureConfig?.autosaveLearningDedup,
      env,
      "LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP"
    ),
    autoMentions: configThenDisableEnv(
      featureConfig?.autoMentions,
      env,
      "LORE_DISABLE_AUTO_MENTIONS"
    ),
    taskReuse: configThenDisableEnv(
      featureConfig?.taskReuse,
      env,
      "LORE_DISABLE_TASK_REUSE"
    ),
    taskCrossref: configThenDisableEnv(
      featureConfig?.taskCrossref,
      env,
      "LORE_DISABLE_TASK_CROSSREF"
    ),
    learningExtraction: configThenDisableEnv(
      featureConfig?.learningExtraction,
      env,
      "LORE_DISABLE_LEARNING_EXTRACTION"
    ),
    confidenceFactor: configThenDisableEnv(
      featureConfig?.confidenceFactor,
      env,
      "LORE_DISABLE_CONFIDENCE_FACTOR"
    ),
    queryPlanning: configThenDisableEnv(
      featureConfig?.queryPlanning,
      env,
      "LORE_DISABLE_QUERY_PLANNING"
    ),
    forceSemanticSearch:
      featureConfig?.forceSemanticSearch === true ||
      env["LORE_FORCE_SEMANTIC_SEARCH"] === "1",
    runTool: {
      enabled: runToolParent,
      blockEdit: resolveRunToolInheritedSubFlag(
        env,
        "LORE_USE_RUNTOOL_BLOCK_EDIT",
        isRunToolBlockEditEnabled,
        runToolConfig?.blockEdit,
        runToolParent
      ),
      filterSql: resolveRunToolInheritedSubFlag(
        env,
        "LORE_USE_RUNTOOL_FILTER_SQL",
        isRunToolFilterSqlEnabled,
        runToolConfig?.filterSql,
        runToolParent
      ),
      search: resolveRunToolInheritedSubFlag(
        env,
        "LORE_USE_RUNTOOL_SEARCH",
        isRunToolSearchEnabled,
        runToolConfig?.search,
        runToolParent
      ),
      aggregate: resolveRunToolInheritedSubFlag(
        env,
        "LORE_USE_RUNTOOL_AGGREGATE",
        isRunToolAggregateEnabled,
        runToolConfig?.aggregate,
        runToolParent
      ),
      batchCreates: resolveRunToolBatchCreates(env, runToolConfig),
    },
  }
}

export function defaultFeatureFlags(): LoreFeatureFlags {
  return cloneDefaultFlags()
}
