import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

export type HelpRecipe = {
  tool: string
  action: string
  summary: string
  whenToUse: string
  example: Record<string, unknown>
  cautions?: readonly string[]
}

const GENERIC_CAUTION =
  "This example is illustrative. The tool schema and runtime validation remain authoritative."

export const HELP_RECIPES = [
  {
    tool: "lore-context",
    action: "status",
    summary: "Show vault topology, counts, active project, and operational health.",
    whenToUse:
      "Use this at the start of a troubleshooting session or when you need a quick view of configured projects, background hook failures, open tasks, and proposed-memory inbox state.",
    example: {
      action: "status",
    },
  },
  {
    tool: "lore-context",
    action: "wake-up",
    summary:
      "Prime a session with the memories, facts, tasks, and decisions most likely to matter now.",
    whenToUse:
      "Use this after /clear, after reconnecting, or after the user pivots topics. Pass userQuery with the current task so Lore can rank task-relevant memories above the normal recent-memory list; add mode='task-only' for narrow one-shot retrieval.",
    example: {
      action: "wake-up",
      projectName: "Lore",
      mode: "task-only",
      userQuery: "Implement MCP help resources for polymorphic tool actions",
      expand: false,
      governanceContext: false,
      debug: true,
    },
    cautions: [
      "Prefer title-tier output first. Set expand only when the returned titles are not enough.",
      "When userQuery is set, pinned and inherited governance context is skipped unless governanceContext is true.",
    ],
  },
  {
    tool: "lore-context",
    action: "digest",
    summary: "Gather raw recent activity for a digest memory.",
    whenToUse:
      "Use this when preparing a daily or weekly summary, then synthesize the returned raw activity into lore-memory action='save' with source='digest'.",
    example: {
      action: "digest",
      projectName: "Lore",
      period: "day",
    },
  },
  {
    tool: "lore-memory",
    action: "save",
    summary:
      "Create a memory page with body content, optional topic/project scope, and metadata.",
    whenToUse:
      "Use this for durable learnings, implementation notes, runbooks, incidents, postmortems, or policies that should be discoverable later. For decisions use lore-decision action='create'; for tracked work use lore-task action='create'.",
    example: {
      action: "save",
      title: "MCP help resources live outside tools/list",
      content:
        "Lore exposes action-specific MCP help through resources so normal tool descriptions stay within prompt-budget limits.",
      kind: "runbook",
      source: "conversation",
      projectName: "Lore",
      topicName: "MCP help resources",
      confidence: "certain",
      keywords: "issue-669 mcp resources help-recipes",
      agent: "codex",
      session: "session-2026-05-15-help-recipes",
    },
    cautions: [
      "Use topicKey only for durable keyed memories such as decisions, runbooks, incidents, postmortems, policies, or procedures.",
      "Tags are profile-owned and closed-vocabulary; use keywords for free-form labels.",
    ],
  },
  {
    tool: "lore-memory",
    action: "update",
    summary: "Mutate an existing memory's metadata, body, title, topic, or relations.",
    whenToUse:
      "Use this when a memory remains the same durable record but needs corrected content, updated scope, a synopsis, or relation changes. Omitted fields are left unchanged.",
    example: {
      action: "update",
      memoryId: "11111111-1111-1111-1111-111111111111",
      content: "Updated markdown body with the corrected invariant.",
      synopsis: "Help recipes are registered as MCP resources, not tools.",
      keywords: "issue-669 corrected",
    },
  },
  {
    tool: "lore-memory",
    action: "archive",
    summary: "Soft-delete a memory by archiving the Notion page.",
    whenToUse:
      "Use this when a memory was saved in error or should no longer appear in recall/search results, while preserving Notion history.",
    example: {
      action: "archive",
      memoryId: "11111111-1111-1111-1111-111111111111",
    },
    cautions: [
      "Archive is destructive for normal recall paths; prefer update for corrections.",
    ],
  },
  {
    tool: "lore-memory",
    action: "expand",
    summary: "Fetch full markdown bodies for a batch of memory IDs.",
    whenToUse:
      "Use this after lore-query action='recall', lore-query action='search', or lore-context action='wake-up' returns title-tier rows and you need the complete body for selected results.",
    example: {
      action: "expand",
      ids: [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
      ],
    },
    cautions: [
      "Expand only the rows you need; each body fetch costs an extra Notion read.",
    ],
  },
  {
    tool: "lore-memory",
    action: "history",
    summary: "Read the revision-chain body for a subject-canonical state memory.",
    whenToUse:
      "Use this after saving repeated current-state updates with subject + replace=true and you need the preserved history behind the single wake-up row.",
    example: {
      action: "history",
      subject: "Lore auth",
      projectName: "Lore",
    },
  },
  {
    tool: "lore-memory",
    action: "suggest-topic-key",
    summary: "Generate a kebab-case topic key from a title and durable memory kind.",
    whenToUse:
      "Use this before saving a keyed durable memory when you want Lore to suggest a stable topicKey shape.",
    example: {
      action: "suggest-topic-key",
      title: "MCP help resources live outside tools list",
      kind: "runbook",
    },
  },
  {
    tool: "lore-memory",
    action: "compare",
    summary:
      "Record a conflict, supersession, scope, relation, compatibility, or non-conflict verdict for two memories.",
    whenToUse:
      "Use this after reviewing two memories that appear related or contradictory. Set affectedMemoryId for asymmetric verdicts so Lore knows which row loses.",
    example: {
      action: "compare",
      memoryIdA: "11111111-1111-1111-1111-111111111111",
      memoryIdB: "22222222-2222-2222-2222-222222222222",
      verdict: "supersedes",
      affectedMemoryId: "22222222-2222-2222-2222-222222222222",
      reason: "The newer memory documents the accepted resource-based design.",
      judgeConfidence: 0.86,
    },
    cautions: ["For judgeConfidence below 0.7, ask the user before recording a verdict."],
  },
  {
    tool: "lore-memory",
    action: "approve",
    summary: "Approve a proposed memory from the inbox review flow.",
    whenToUse:
      "Use this when a proposed memory is accurate and should become accepted knowledge.",
    example: {
      action: "approve",
      memoryId: "11111111-1111-1111-1111-111111111111",
      reviewer: "Ada Lovelace",
      reason: "Validated against the implemented MCP resource registration.",
    },
  },
  {
    tool: "lore-memory",
    action: "reject",
    summary: "Reject a proposed memory from the inbox review flow.",
    whenToUse:
      "Use this when a proposed memory is duplicate, incorrect, too vague, or not useful as durable knowledge.",
    example: {
      action: "reject",
      memoryId: "11111111-1111-1111-1111-111111111111",
      reviewer: "Ada Lovelace",
      reason: "Duplicate of an accepted procedure memory.",
    },
  },
  {
    tool: "lore-memory",
    action: "promote",
    summary:
      "Copy a memory into a configured promotion target vault with an origin audit block.",
    whenToUse:
      "Use this for memories that should move from a source vault into a configured downstream vault, optionally as proposed knowledge when the target requires review.",
    example: {
      action: "promote",
      memoryId: "11111111-1111-1111-1111-111111111111",
      targetName: "Team Vault",
      reason: "This procedure applies across the team.",
      dryRun: true,
    },
  },
  {
    tool: "lore-pinned",
    action: "pin",
    summary: "Turn an existing memory into an always-visible pinned context block.",
    whenToUse:
      "Use this for governance, safety, rollout, or project context that must render before relevance-ranked wake-up sections.",
    example: {
      action: "pin",
      memoryId: "11111111-1111-1111-1111-111111111111",
      priority: 50,
      audience: "all",
      mutability: "read-only",
      reason: "Governance memory should appear in every wake-up.",
    },
    cautions: [
      "Audience and mutability are rendering and audit metadata, not an authorization boundary.",
    ],
  },
  {
    tool: "lore-pinned",
    action: "unpin",
    summary: "Return a pinned context block to normal memory behavior.",
    whenToUse:
      "Use this when a memory should stay in the vault but should no longer render in every wake-up.",
    example: {
      action: "unpin",
      memoryId: "11111111-1111-1111-1111-111111111111",
      reason: "Rollout completed; normal recall is enough.",
    },
  },
  {
    tool: "lore-pinned",
    action: "update",
    summary: "Change pinned context priority, audience, or mutability.",
    whenToUse:
      "Use this when a pinned block stays pinned but its ordering, target audience, or read-only audit posture changes.",
    example: {
      action: "update",
      memoryId: "11111111-1111-1111-1111-111111111111",
      priority: 75,
      audience: "codex,claude,all",
      mutability: "read-only",
      force: true,
      reason: "Tighten rollout guidance after review.",
    },
    cautions: [
      "force bypasses the read-only guard but is not an access-control gate; the audit line is the contract.",
      "Audience and mutability are rendering and audit metadata, not an authorization boundary.",
    ],
  },
  {
    tool: "lore-pinned",
    action: "list",
    summary: "List active pinned context blocks in the current project/audience scope.",
    whenToUse:
      "Use this to audit what renders before wake-up sections, or pass includeAllAudiences when reviewing pinned blocks across audience tokens.",
    example: {
      action: "list",
      projectName: "Lore",
      audience: "codex",
      includeAllAudiences: true,
      limit: 25,
    },
    cautions: [
      "Audience is rendering and audit metadata, not an authorization boundary.",
    ],
  },
  {
    tool: "lore-query",
    action: "recall",
    summary: "List recent memories with optional filters and cursor pagination.",
    whenToUse:
      "Use this when recency, status, kind, source, topic, or review-date filters matter more than a semantic query.",
    example: {
      action: "recall",
      projectName: "Lore",
      kind: "runbook",
      status: "accepted",
      limit: 20,
      includeSynopsis: true,
    },
  },
  {
    tool: "lore-query",
    action: "search",
    summary:
      "Search memory titles and bodies with contains, semantic, or hybrid retrieval.",
    whenToUse:
      "Use this before answering factual questions about stored conversation or recorded knowledge when you have search terms or a natural-language query. Use mode='contains' for exact tokens, mode='semantic' for meaning, and the default hybrid mode for most cases.",
    example: {
      action: "search",
      query: "MCP resource help recipes",
      intent: "Find implementation notes for issue 669",
      projectName: "Lore",
      mode: "hybrid",
      limit: 8,
      includeSynopsis: true,
      explain: true,
    },
    cautions: [
      "Use lore-query action='ask' instead when the question names an entity and you need structured facts or tasks.",
    ],
  },
  {
    tool: "lore-query",
    action: "ask",
    summary: "Query structured facts and tasks about a named entity.",
    whenToUse:
      "Use this when the user asks what Lore knows about a system, person, file, API, project, or other entity. It returns governance, structure, and task buckets instead of free-form memories.",
    example: {
      action: "ask",
      entity: "MCP resources",
      projectName: "Lore",
      limit: 10,
      includeContext: true,
      includeHistory: false,
    },
    cautions: [
      "Use lore-query action='search' instead when you need narrative memory bodies or broad semantic recall.",
    ],
  },
  {
    tool: "lore-query",
    action: "audit",
    summary: "List facts, decisions, and tasks past their review date.",
    whenToUse:
      "Use this for maintenance sweeps when stale knowledge, overdue decisions, or open tasks need review.",
    example: {
      action: "audit",
      projectName: "Lore",
    },
  },
  {
    tool: "lore-fact",
    action: "create",
    summary: "Create or dedupe a structured Subject-predicate-Object fact.",
    whenToUse:
      "Use this for durable relationships that should be answerable through lore-query action='ask'. The fact must be backed by a source memory, either directly through sourceMemoryId or by same-process agent/session auto-linking.",
    example: {
      action: "create",
      subject: "Lore MCP server",
      predicate: "related_to",
      object: "MCP resources for action help recipes",
      projectName: "Lore",
      confidence: "certain",
      sourceMemoryId: "11111111-1111-1111-1111-111111111111",
      reviewBy: "2026-08-15",
    },
    cautions: [
      "Requires provenance via sourceMemoryId or compatible same-process agent and session auto-linking.",
      "Use writable profile predicates only; internal decision predicates are emitted by decision tools.",
    ],
  },
  {
    tool: "lore-fact",
    action: "invalidate",
    summary: "Mark a fact as no longer true while preserving history.",
    whenToUse:
      "Use this when a previously valid fact has been contradicted or expired, optionally linking the memory that prompted the invalidation.",
    example: {
      action: "invalidate",
      factId: "33333333-3333-3333-3333-333333333333",
      sourceMemoryId: "11111111-1111-1111-1111-111111111111",
    },
  },
  {
    tool: "lore-fact",
    action: "extend",
    summary: "Set or clear a fact review-by date.",
    whenToUse:
      "Use this after revalidating a fact or deciding that it no longer needs a scheduled review date.",
    example: {
      action: "extend",
      factId: "33333333-3333-3333-3333-333333333333",
      reviewBy: "2026-09-01",
    },
  },
  {
    tool: "lore-decision",
    action: "create",
    summary:
      "Record an architectural decision with rationale and optional structured effects.",
    whenToUse:
      "Use this instead of lore-memory action='save' when the record is a decision. Include rationale, alternatives, consequences, affected entities, and superseded decision IDs when known.",
    example: {
      action: "create",
      decision: "Expose polymorphic MCP action help as resources",
      rationale:
        "Resources keep action-specific examples discoverable without growing the normal tools/list prompt footprint.",
      projectName: "Lore",
      topicName: "MCP help resources",
      status: "accepted",
      confidence: "certain",
      decidedAt: "2026-05-15",
      affects: ["Lore MCP server", "MCP clients"],
      alternatives: "Add long descriptions to tools/list; add a help action.",
      consequences: "Clients must read lore://help resources for action recipes.",
      keywords: "issue-669 mcp resources",
      agent: "codex",
      session: "session-2026-05-15-help-recipes",
    },
  },
  {
    tool: "lore-decision",
    action: "list",
    summary: "List decisions by project, status, review date, or cursor.",
    whenToUse: "Use this to scan decision state without fetching full rationale bodies.",
    example: {
      action: "list",
      projectName: "Lore",
      status: "accepted",
      reviewBefore: "2026-08-15",
      limit: 20,
    },
  },
  {
    tool: "lore-decision",
    action: "get",
    summary: "Fetch one decision's full rationale and metadata.",
    whenToUse:
      "Use this after list/context returns a decision ID and you need the complete body or relations.",
    example: {
      action: "get",
      decisionId: "44444444-4444-4444-4444-444444444444",
    },
  },
  {
    tool: "lore-decision",
    action: "context",
    summary: "Find active decisions governing an entity, following supersession chains.",
    whenToUse:
      "Use this when changing an entity and you need the decision context that constrains the work.",
    example: {
      action: "context",
      entity: "MCP resources",
      projectName: "Lore",
      limit: 10,
    },
  },
  {
    tool: "lore-decision",
    action: "supersede",
    summary:
      "Mark an old decision superseded by a new decision and create the supersession fact.",
    whenToUse:
      "Use this after recording the replacement decision so the decision graph points readers at the current rule.",
    example: {
      action: "supersede",
      oldDecisionId: "44444444-4444-4444-4444-444444444444",
      newDecisionId: "55555555-5555-5555-5555-555555555555",
    },
    cautions: [
      "Create or identify the replacement decision before superseding the old one.",
    ],
  },
  {
    tool: "lore-decision",
    action: "review",
    summary: "Mark a decision reviewed and set or clear its next review date.",
    whenToUse: "Use this when a scheduled decision review is complete.",
    example: {
      action: "review",
      decisionId: "44444444-4444-4444-4444-444444444444",
      reviewBy: "2026-11-15",
    },
  },
  {
    tool: "lore-project",
    action: "list",
    summary: "List configured Lore projects.",
    whenToUse:
      "Use this when you need the valid project names before passing projectName or projectNames to another action.",
    example: {
      action: "list",
      status: "active",
    },
  },
  {
    tool: "lore-project",
    action: "get",
    summary: "Get details for one configured project by name.",
    whenToUse:
      "Use this when you need project metadata, topics, or recent activity for a specific project.",
    example: {
      action: "get",
      name: "Lore",
    },
  },
  {
    tool: "lore-task",
    action: "create",
    summary:
      "Create a tracked task memory for tangential or out-of-scope follow-up work.",
    whenToUse:
      "Use this for work discovered during a session but not completed as the session's primary objective. Include entity, dueDate, blocker, and source context when useful.",
    example: {
      action: "create",
      subject: "Audit older MCP clients for resource template support",
      description:
        "Check whether deployed clients list lore://help resources and document any compatibility gaps.",
      entity: "MCP clients",
      state: "open",
      dueDate: "2026-05-22",
      projectName: "Lore",
      keywords: "issue-669 follow-up",
      agent: "codex",
      session: "session-2026-05-15-help-recipes",
    },
    cautions: [
      "Use this for tangential or out-of-scope follow-up work, not the session's current primary objective.",
    ],
  },
  {
    tool: "lore-task",
    action: "update",
    summary:
      "Mutate an existing task's state, blocker, due date, subject, description, or metadata.",
    whenToUse:
      "Use this when a task remains active but its details or triage state changed.",
    example: {
      action: "update",
      taskId: "66666666-6666-6666-6666-666666666666",
      state: "blocked",
      blockedBy: "Waiting for client compatibility report",
      dueDate: "2026-05-29",
      synopsis: "Verify resource-template support before broad rollout.",
    },
  },
  {
    tool: "lore-task",
    action: "close",
    summary: "Mark a task done or cancelled.",
    whenToUse:
      "Use this immediately when tracked work completes or is intentionally abandoned so it stops surfacing in wake-up.",
    example: {
      action: "close",
      taskId: "66666666-6666-6666-6666-666666666666",
      state: "done",
    },
    cautions: ["Close completed tasks promptly; open tasks are treated as active work."],
  },
  {
    tool: "lore-task",
    action: "close-many",
    summary: "Close an explicit batch of task IDs.",
    whenToUse:
      "Use this after a reconcile, review, or maintenance pass produces a specific list of task IDs to mark done or cancelled. Partial failures are reported per ID.",
    example: {
      action: "close-many",
      ids: [
        "66666666-6666-6666-6666-666666666666",
        "77777777-7777-7777-7777-777777777777",
      ],
      state: "done",
      reason: "The referenced work has shipped and validation passed.",
    },
    cautions: [
      "Only pass task IDs you have explicitly reviewed; use lore-task action='list' or action='reconcile' first when you need candidates.",
      "Already-closed tasks are reported as no-ops, and the result is an error when any ID fails.",
    ],
  },
  {
    tool: "lore-task",
    action: "list",
    summary: "List active task memories with overdue and active sections.",
    whenToUse:
      "Use this to triage open, in-progress, or blocked work by project, entity, state, due date, or cursor.",
    example: {
      action: "list",
      projectName: "Lore",
      entity: "MCP resources",
      state: "open",
      dueBefore: "2026-05-31",
      limit: 25,
      includeSynopsis: true,
    },
  },
  {
    tool: "lore-task",
    action: "reconcile",
    summary: "Scan active tasks for resolution-shaped memories that may close them.",
    whenToUse:
      "Use this during maintenance to find likely stale active tasks that have already been resolved elsewhere.",
    example: {
      action: "reconcile",
      projectName: "Lore",
      minScore: 0.7,
      limit: 10,
    },
    cautions: [
      "This is read-only; close candidates explicitly with lore-task action='close'.",
    ],
  },
  {
    tool: "lore-procedure",
    action: "scan-candidates",
    summary: "Find repeated resolved work that may deserve a reusable procedure memory.",
    whenToUse:
      "Use this to mine closed tasks, incidents, postmortems, and runbooks for repeated resolution patterns before proposing a procedure.",
    example: {
      action: "scan-candidates",
      projectName: "Lore",
      minScore: 0.6,
      limit: 10,
    },
  },
  {
    tool: "lore-procedure",
    action: "propose",
    summary:
      "Create a proposed procedure memory with activation conditions, steps, and supporting sources.",
    whenToUse:
      "Use this after identifying a repeatable workflow backed by source memories. The result is proposed governance memory that must still be approved through lore-memory action='approve'.",
    example: {
      action: "propose",
      projectName: "Lore",
      title: "Add MCP resource help for a new tool action",
      entity: "MCP resources",
      activationConditions: [
        "A polymorphic lore-* tool adds a new action",
        "The action needs examples without growing tools/list descriptions",
      ],
      steps: [
        "Add a structured help recipe for the new action",
        "Verify the recipe set matches the registered action enum",
        "Read lore://help/<tool>/<action> through the MCP resources API",
      ],
      failureModes: ["Adding a new tool alias instead of a resource recipe"],
      notes: "Approval is handled by the proposed-memory inbox.",
      sourceMemoryIds: [
        "11111111-1111-1111-1111-111111111111",
        "22222222-2222-2222-2222-222222222222",
        "33333333-3333-3333-3333-333333333333",
      ],
      topicKey: "procedure/mcp-resource-help",
    },
    cautions: [
      "Creates a proposed memory; approval still goes through lore-memory action='approve'.",
      "Every sourceMemoryIds entry must resolve to a live source memory in scope.",
    ],
  },
  {
    tool: "lore-procedure",
    action: "deprecate",
    summary: "Mark an accepted procedure memory deprecated while preserving history.",
    whenToUse:
      "Use this after a replacement procedure has been approved, or when the procedure no longer applies.",
    example: {
      action: "deprecate",
      memoryId: "77777777-7777-7777-7777-777777777777",
      reason: "Superseded by the approved MCP resource help procedure.",
    },
    cautions: [
      "Proposed procedures leave through lore-memory action='reject', not deprecate.",
    ],
  },
] as const satisfies readonly HelpRecipe[]

export function registerHelpResources(server: McpServer): void {
  server.registerResource(
    "lore-help",
    "lore://help",
    {
      title: "Lore MCP help index",
      description: "Index of action-specific Lore MCP payload examples.",
      mimeType: "text/markdown",
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "text/markdown",
          text: renderHelpIndex(),
        },
      ],
    })
  )

  server.registerResource(
    "lore-help-action",
    new ResourceTemplate("lore://help/{tool}/{action}", {
      list: async () => ({
        resources: HELP_RECIPES.map((recipe) => ({
          uri: helpResourceUri(recipe),
          name: `${recipe.tool} ${recipe.action}`,
          title: `${recipe.tool} action='${recipe.action}'`,
          description: recipe.summary,
          mimeType: "text/markdown",
        })),
      }),
    }),
    {
      title: "Lore MCP action help",
      description: "Action-specific Lore MCP payload examples.",
      mimeType: "text/markdown",
    },
    async (uri, variables) => {
      const tool = String(variables["tool"] ?? "")
      const action = String(variables["action"] ?? "")
      const recipe = findHelpRecipe(tool, action)
      if (!recipe) {
        throw new Error(`No Lore MCP help recipe for ${tool} action='${action}'.`)
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: renderHelpRecipe(recipe),
          },
        ],
      }
    }
  )
}

export function findHelpRecipe(tool: string, action: string): HelpRecipe | undefined {
  return recipeByKey.get(recipeKey(tool, action))
}

export function helpResourceUri(recipe: Pick<HelpRecipe, "tool" | "action">): string {
  return `lore://help/${recipe.tool}/${recipe.action}`
}

export function renderHelpIndex(): string {
  const lines = [
    "# Lore MCP Help",
    "",
    "These resources provide action-specific example payloads for Lore's polymorphic MCP tools.",
    "Examples are recipes, not a replacement for runtime validation; callers must still obey the tool schema and action-specific validation errors.",
    "",
  ]

  for (const [tool, recipes] of recipesByTool()) {
    lines.push(`## ${tool}`, "")
    for (const recipe of recipes) {
      lines.push(`- \`${helpResourceUri(recipe)}\` - ${recipe.summary}`)
    }
    lines.push("")
  }

  return lines.join("\n").trimEnd()
}

export function renderHelpRecipe(recipe: HelpRecipe): string {
  const cautions = [...(recipe.cautions ?? []), GENERIC_CAUTION]
  return [
    `# ${recipe.tool} action='${recipe.action}'`,
    "",
    recipe.summary,
    "",
    "## When To Use",
    "",
    recipe.whenToUse,
    "",
    "## Example Payload",
    "",
    fencedJson(recipe.example),
    "",
    "## Cautions",
    "",
    ...cautions.map((caution) => `- ${caution}`),
  ].join("\n")
}

function recipeKey(tool: string, action: string): string {
  return `${tool}\0${action}`
}

function recipesByTool(): Map<string, HelpRecipe[]> {
  const byTool = new Map<string, HelpRecipe[]>()
  for (const recipe of HELP_RECIPES) {
    const recipes = byTool.get(recipe.tool)
    if (recipes) {
      recipes.push(recipe)
    } else {
      byTool.set(recipe.tool, [recipe])
    }
  }
  return byTool
}

function fencedJson(value: Record<string, unknown>): string {
  return ["```json", JSON.stringify(value, null, 2), "```"].join("\n")
}

const recipeByKey = new Map(
  HELP_RECIPES.map((recipe) => [recipeKey(recipe.tool, recipe.action), recipe])
)
