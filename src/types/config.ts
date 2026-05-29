/**
 * Configuration and resolved-runtime context types.
 */
import type { Project } from "./domain.js"
import type { Vault } from "./persistence.js"
import type { MemoryCaptureMode } from "../memory-capture-mode.js"

// ---------------------------------------------------------------------------
// Config (.lore.yaml)
// ---------------------------------------------------------------------------

export interface ProjectConfig {
  name: string
  path: string
  tags?: string[]
}

export interface UpstreamVaultConfig {
  name: string
  pageId: string
  /**
   * Lower numbers render first. Defaults to 100 when omitted.
   */
  priority?: number
}

export interface PromotionTargetConfig {
  name: string
  pageId: string
  /**
   * Whether promotion into this vault should land as a reviewed/proposed flow.
   * Defaults to false until the promotion command implements policy handling.
   */
  requireReview?: boolean
}

export interface ProfilesAllowedGitInstallSource {
  kind: "git"
  /** Git URL of the source repository. */
  url: string
  /** 40-character lowercase hex commit SHA. */
  commit: string
  /** `sha256:<64-hex>` manifest digest computed at allow-list authoring time. */
  manifestDigest: string
}

export interface ProfilesAllowedPathInstallSource {
  kind: "path"
  /**
   * Absolute or `<configRoot>`-relative path to a profile bundle root
   * (the directory that contains `profile.yaml`).
   */
  path: string
  /** `sha256:<64-hex>` manifest digest of the bundle at allow-list authoring time. */
  manifestDigest: string
}

export type ProfilesAllowedInstallSource =
  | ProfilesAllowedGitInstallSource
  | ProfilesAllowedPathInstallSource

export interface ProfilesConfig {
  /**
   * Closed allow-list of install sources that `lore profile install --yes`
   * may write under `<configRoot>/.lore/profiles/installed/`. The CLI
   * stages the source, validates it, computes its `manifestDigest`, and
   * requires an exact entry match before writing anything to disk.
   * Interactive installs without `--yes` print the digest so an operator
   * can add an entry for later CI/scripted runs.
   */
  allowedInstallSources?: ProfilesAllowedInstallSource[]
}

export interface LoreFeatureConfig {
  /**
   * Advisory near-duplicate probes for saves, decisions, autosave-learning
   * dedup, and task duplicate/cross-reference helpers. Default: true.
   * `LORE_DISABLE_NEAR_DUPLICATE_PROBE=1` forces this off.
   */
  nearDuplicateProbe?: boolean
  /**
   * Structural deduplication for background autosave atomic-learning notes.
   * Default: true. `LORE_DISABLE_AUTOSAVE_LEARNING_DEDUP=1` forces this off.
   */
  autosaveLearningDedup?: boolean
  /**
   * Automatic `mentions` fact emission from memory title/keywords/synopsis.
   * Default: true. `LORE_DISABLE_AUTO_MENTIONS=1` forces this off.
   */
  autoMentions?: boolean
  /**
   * Exact active-task reuse instead of creating duplicate task rows.
   * Default: true. `LORE_DISABLE_TASK_REUSE=1` forces this off.
   */
  taskReuse?: boolean
  /**
   * Related-task cross-reference footers on memory saves.
   * Default: true. `LORE_DISABLE_TASK_CROSSREF=1` forces this off.
   */
  taskCrossref?: boolean
  /**
   * Stop-hook atomic-learning extraction. Default: true.
   * `LORE_DISABLE_LEARNING_EXTRACTION=1` forces this off.
   */
  learningExtraction?: boolean
  /**
   * Confidence-score weighting in rank fusion. Default: true.
   * `LORE_DISABLE_CONFIDENCE_FACTOR=1` forces this off.
   */
  confidenceFactor?: boolean
  /**
   * Force every memory search request through semantic mode instead of
   * contains/hybrid modes. This does not disable RunTool search; use
   * `LORE_USE_RUNTOOL_SEARCH=0` or `LORE_USE_RUNTOOL=0` to bypass the
   * RunTool search transport. Default: false.
   * `LORE_FORCE_SEMANTIC_SEARCH=1` forces semantic mode on.
   */
  forceSemanticSearch?: boolean
  /**
   * RunTool feature family. `enabled` is the parent value; all sub-flags
   * except `batchCreates` inherit from it unless explicitly set.
   */
  runTool?: {
    enabled?: boolean
    blockEdit?: boolean
    filterSql?: boolean
    search?: boolean
    aggregate?: boolean
    batchCreates?: boolean
  }
}

export interface CostTrackingPricingConfig {
  /**
   * Checked-in pricing table id. V1 never fetches pricing over the network.
   */
  builtinTable?: string
  /**
   * Optional absolute, `~`-expanded, or config-root-relative JSON file whose
   * model entries override the selected built-in table.
   */
  overridesPath?: string
}

export interface CostTrackingConfig {
  /**
   * Opt-in switch for the local JSONL cost ledger. Defaults to false when the
   * block or field is omitted. Enabled ledger rows may include local project,
   * agent, session, tool, and action identifiers alongside redacted payload
   * byte/token estimates, Notion operation counts, and model usage/cost
   * estimates when known.
   */
  enabled?: boolean
  /**
   * Ledger JSONL path. Defaults to ~/.local/share/lore/cost-ledger.jsonl when
   * tracking is enabled.
   */
  ledgerPath?: string
  pricing?: CostTrackingPricingConfig
}

export interface MemoryAuthoringConfig {
  /**
   * Maximum characters accepted for `lore-memory` synopses on save/update.
   * Defaults to 150 so wake-up and recall stay scan-friendly. May be raised
   * up to the structural `SYNOPSIS_MAX` storage ceiling.
   */
  synopsisMaxChars?: number
}

export interface LoreConfig {
  vault: {
    pageId: string
  }
  /**
   * Exact profile selector (`<name>@<semver>`). Omitted legacy configs
   * resolve in memory to the bundled default profile; read-only starts
   * never write this field back to disk.
   */
  profile?: string
  /**
   * Optional profile distribution settings (Phase 3). Currently scoped to
   * `allowedInstallSources`, the closed allow-list that authorizes
   * `lore profile install --yes` to write under
   * `<configRoot>/.lore/profiles/installed/`.
   */
  profiles?: ProfilesConfig
  /**
   * Runtime feature flags. Environment variables remain supported as the
   * operator override layer; disabling env vars always win for rollback
   * kill switches.
   */
  features?: LoreFeatureConfig
  /**
   * Local-only cost and usage ledger. Disabled by default and must not store
   * raw prompts, MCP argument bodies, MCP result bodies, memory/fact text,
   * Notion page bodies, or Notion response payloads.
   */
  costTracking?: CostTrackingConfig
  /**
   * Memory-authoring policy knobs. These affect plain `lore-memory` writes,
   * not decision/task services that have their own synopsis surfaces.
   */
  memory?: MemoryAuthoringConfig
  /**
   * Read-only vaults whose memories can be inherited by topology-aware read
   * paths. The primary vault remains the only normal write target.
   */
  upstreamVaults?: UpstreamVaultConfig[]
  /**
   * Explicit cross-vault destinations for deliberate memory promotion.
   */
  promotionTargets?: PromotionTargetConfig[]
  auth?: {
    /**
     * Rejected at config load. Kept in the type only so callers handling
     * raw parsed objects can surface a targeted validation error.
     */
    token?: string
    baseUrl?: string
    /**
     * Workspace id to pick when ntn's auth.json carries multiple
     * workspaces. Optional; falls back to `NOTION_WORKSPACE_ID` env, then
     * to single-workspace auto-pick. Has no effect on `NOTION_API_TOKEN`,
     * which carries whatever workspace the operator's token was issued
     * against and Lore can't introspect that without an API call.
     */
    workspaceId?: string
  }
  notion?: {
    rateLimit?: {
      /**
       * Max outbound Notion API calls in flight at once on the global
       * gate. Endpoints with a `endpointOverrides` entry run their own
       * concurrency slot pool independent of this value. Defaults to
       * `DEFAULT_NOTION_CONCURRENCY` (aligned with Notion's public-API
       * ~3 rps guidance).
       */
      concurrency?: number
      /**
       * Sustained outbound request rate, in calls/second, on the global
       * gate. Token-bucket refill rate enforced by `createLimitedClient`.
       * Defaults to `DEFAULT_NOTION_REQUESTS_PER_SECOND`. Distinct from
       * `concurrency`: the latter caps fan-out memory; this caps
       * throughput. Per-process budget; multiple concurrent Lore
       * processes on one Notion token (MCP server + CLI + hooks)
       * compose additively at the server-side bucket and may need
       * tighter tuning to stay under the per-token ceiling.
       */
      requestsPerSecond?: number
      /**
       * Token-bucket capacity for the global gate — how many calls may
       * fire instantly after a quiet period. Defaults to
       * `DEFAULT_NOTION_BURST_SIZE`. Endpoints with their own
       * `endpointOverrides` entry have their own burst.
       */
      burstSize?: number
      /**
       * Per-endpoint pacing overrides keyed by dot-joined SDK method
       * path (e.g., `"pages.retrieveMarkdown"`, `"dataSources.query"`,
       * or a top-level method name like `"search"`). Each override may
       * loosen one or more pacing dimensions for a single endpoint
       * without raising the global cap.
       *
       * Built-in defaults loosen endpoints with operator-runnable probe
       * evidence under `tools/`. When this field is omitted but any
       * global rate-limit knob is set, the effective global values cap
       * the inherited built-ins so existing process-wide throttles stay
       * conservative. Setting this field REPLACES the built-in table —
       * pass `{}` to opt every endpoint back through the global gate, or
       * include any path the caller wants to customize. Endpoints absent
       * from this map fall through to the global concurrency /
       * requestsPerSecond / burstSize values.
       */
      endpointOverrides?: Record<
        string,
        {
          concurrency?: number
          requestsPerSecond?: number
          burstSize?: number
        }
      >
    }
  }
  projects?: ProjectConfig[]
  detect?: {
    patterns?: string[]
    exclude?: string[]
  }
  hooks?: {
    autoSave?: boolean
    wakeUp?: boolean
    /**
     * Background digest synthesizer scheduled by the Stop hook. Fires at
     * most once per project per 7 days via a filesystem marker. Default:
     * true. Honors `LORE_AUTO_DIGEST=false` env override as well — either
     * disables the auto-spawn without affecting the manual `lore digest` CLI.
     */
    autoDigest?: boolean
    /**
     * Atomic-learning extraction inside the Stop-spawn autosave sub-agent.
     * When true (default) the sub-agent is asked to identify
     * single-fact discoveries and save each as its own `note` memory, in
     * addition to the session synopsis it already writes. When false, the
     * autosave reproduces the synopsis-only shape. Honors
     * `LORE_DISABLE_LEARNING_EXTRACTION=1` env override — either knob set
     * to disabled wins (AND-of-permissive).
     */
    learningExtraction?: boolean
    /**
     * Whether the Stop-spawn autosave sub-agent should write atomic
     * learnings as `status: "proposed"`. Default is `false` — the
     * historical "auto-extracted learnings land directly in the shared
     * vault" posture is preserved. When `true`, the prompt instructs
     * the sub-agent to set `status: "proposed"` on every
     * atomic-learning save, routing the row into the review inbox
     * surfaced by `lore status`'s `Proposed memories` line and the
     * wake-up `Proposed Memories` section. Has no effect when
     * `learningExtraction` is `false` — there are no learning saves
     * to gate.
     *
     * The trust boundary this knob enables: a fleet of agents
     * managed by many engineers can opt into review-before-share so
     * a noisy session cannot pollute recall for everyone before a
     * human or authorized agent approves it. The inbox-count surface,
     * default-recall exclusion, and approve / reject actions all read
     * the proposed `Status`; this flag is the corresponding
     * write-side opt-in.
     */
    proposeAutosaveLearnings?: boolean
    /**
     * Autosave capture policy. `durable` preserves the production engineering
     * filter; `conversational` is an explicit opt-in for broad recall facts
     * such as user preferences, personal details, and future commitments.
     * Default: "durable".
     */
    memoryCaptureMode?: MemoryCaptureMode
    /** Real user messages between structured AI-driven saves. Default: 5. */
    saveInterval?: number
    /**
     * Background-agent worker configuration. Lore's autosave
     * and auto-digest paths shell out to a detached agent CLI to do the
     * structured save / digest synthesis. Defaults to `claude -p` with the
     * shape Claude Code installs assume. Codex-only operators (or anyone
     * who wants to try a different agent CLI) override `command` to point
     * at an alternate binary and `args` to pass that binary's headless
     * flags. Each spawn substitutes `{{allowedTools}}` in `args` for the
     * tool allowlist string — operators whose CLI does not accept an
     * allowlist flag should omit the placeholder. Honors
     * `LORE_BACKGROUND_COMMAND` env override on `command` for ad-hoc
     * experimentation without editing .lore.yaml.
     */
    backgroundAgent?: {
      /** Binary name (resolved on PATH) or absolute path. Default: "claude". */
      command?: string
      /**
       * Args passed to the binary verbatim, with `{{allowedTools}}` replaced
       * by the tool allowlist string at spawn time. The placeholder appears
       * once in the default; multiple occurrences are all replaced; omitting
       * it skips the allowlist hand-off entirely (operators whose CLI takes
       * the allowlist via env or stdin instead).
       */
      args?: string[]
    }
  }
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface ResolvedContext {
  vault: Vault
  project: Project | null
  cwd: string
  /**
   * True when `project` was resolved by falling back to a monorepo catch-all
   * (a config entry with path `"."` or `""`). Save tools use this to surface
   * a warning prompting the agent to scope memories to a sub-project.
   */
  isCatchAllFallback: boolean
}
