/**
 * `lore-procedure` polymorphic MCP tool.
 *
 * Three actions — `scan-candidates` (read-only mining), `propose`
 * (create a `Status: proposed` procedure memory), and `deprecate`
 * (status flip on an accepted procedure). Approval flows through
 * the existing `lore-memory action='approve'` inbox path; this
 * tool deliberately does NOT expose an `approve` action of its own
 * so the inbox-review codepath has one entrypoint.
 *
 * Same registration shape as `lore-memory` / `lore-decision`: flat
 * `inputSchema` for agent ergonomics, `z.discriminatedUnion` for
 * runtime validation, one `handle<Action>` per action wrapped in
 * try/catch with `toolError` on failure.
 */

import { z } from "zod"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"

import {
  buildProposeProcedureInput,
  defaultProcedureTopicKey,
  DEFAULT_PROCEDURE_CANDIDATE_LIMIT,
  findExistingProposedProcedure,
  findProcedureCandidates,
  MAX_PROCEDURE_CANDIDATE_LIMIT,
  PROCEDURE_DEPRECATABLE_STATUSES,
  PROCEDURE_MIN_SOURCES,
  ProcedureSourceResolutionError,
  ProcedureTopicKeyConflictError,
  resolveProcedureSources,
  resolveProcedureSupersedesIds,
  sanitizeDeprecateReason,
  type ProcedureCandidate,
  type ProposeProcedureInput,
} from "../../core/procedure.js"
import { resolveProjectIds, resolveReadProjectScope } from "../resolve.js"
import type { LoreServices } from "../../services.js"
import { formatDispatchError, toolError, withWakeUpCacheBump } from "../helpers.js"
import { nonBlankString } from "./text-schema.js"
import { notionPageIdSchema } from "../../notion/page-id-schema.js"

type ToolResult = {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

const PROCEDURE_BUILDER_SNIPPET = [
  "lore-procedure({",
  "  action: 'propose',",
  "  title: '<short title>',",
  "  entity: '<activation entity>',",
  "  activationConditions: ['<cond 1>', '<cond 2>'],",
  "  steps: ['<step 1>', '<step 2>'],",
  "  failureModes: ['<known wrong path>'],",
  // `PROCEDURE_MIN_SOURCES` (=2) entries required; matches the
  // scan threshold so the propose path cannot bypass provenance.
  "  sourceMemoryIds: ['<mem-id>', '<mem-id>'],",
  "})",
].join("\n")

function formatCandidatesMarkdown(candidates: ProcedureCandidate[]): string {
  if (candidates.length === 0) {
    return [
      "No procedure candidates surfaced.",
      "",
      `Procedures are mined from clusters of ≥${PROCEDURE_MIN_SOURCES} resolved-episode memories`,
      "sharing an entity (incidents, postmortems, runbooks, plus done/cancelled tasks).",
      "Close more tasks or save more incident/postmortem memories, then re-scan.",
      "",
      "When a cluster does surface, promote it with the shared shape:",
      "```",
      PROCEDURE_BUILDER_SNIPPET,
      "```",
    ].join("\n")
  }
  const lines: string[] = [
    `# Procedure candidates (${candidates.length})`,
    "",
    "Read-only scan. Review each cluster and promote via:",
    "",
    "```",
    PROCEDURE_BUILDER_SNIPPET,
    "```",
    "",
    "Promoted procedures land with `Status: proposed`. They become",
    "fleet-wide guidance only after `lore-memory action='approve'`",
    "(or `lore inbox approve <id>`).",
    "",
  ]
  candidates.forEach((c, i) => {
    lines.push(`## ${i + 1}. ${c.entity} (score ${c.score.toFixed(2)})`)
    lines.push("")
    lines.push(`- Cluster key: \`${c.clusterKey}\``)
    lines.push(`- Suggested topic key: \`${c.suggestedTopicKey}\``)
    lines.push(`- Sources: ${c.sources.length} across ${c.kindDiversity} kind(s)`)
    lines.push("")
    for (const src of c.sources) {
      const stateLabel = src.taskState ? ` [${src.taskState}]` : ""
      lines.push(
        `  - \`${src.memoryId}\` ${src.kind}${stateLabel} — ${src.title} (${src.createdAt})`
      )
    }
    lines.push("")
  })
  return lines.join("\n")
}

interface ScanArgs {
  action: "scan-candidates"
  projectName?: string
  limit?: number
  minScore?: number
}

async function handleScanCandidates(
  services: LoreServices,
  args: ScanArgs
): Promise<ToolResult> {
  const scope = await resolveReadProjectScope(services, args.projectName)
  if (!scope.projectId) {
    return toolError(
      new Error(
        "No project resolved. Pass `projectName` or run from inside a configured project."
      )
    )
  }
  const candidates = await findProcedureCandidates(services, {
    projectId: scope.projectId,
    limit: args.limit ?? DEFAULT_PROCEDURE_CANDIDATE_LIMIT,
    minScore: args.minScore ?? 0,
  })
  return {
    content: [{ type: "text", text: formatCandidatesMarkdown(candidates) }],
  }
}

interface ProposeArgs {
  action: "propose"
  title: string
  entity?: string
  activationConditions?: string[]
  steps: string[]
  failureModes?: string[]
  notes?: string
  sourceMemoryIds: string[]
  supersedesIds?: string[]
  topicKey?: string
  projectName?: string
}

async function handlePropose(
  services: LoreServices,
  args: ProposeArgs
): Promise<ToolResult> {
  // Procedures land in a single project scope (matches the CLI's
  // `-p, --project` and the typical operating contract: procedures
  // belong to one team's project). Multi-project scope on the propose
  // path would clash with the `(topicKey, project-set)` idempotency
  // probe — a procedure spanning N projects can't reuse a row from
  // any sub-project of that set, defeating the dedup. Stay single-
  // scope until a real cross-project use case shows up.
  const resolved = await resolveProjectIds(services, args.projectName, undefined)
  if (resolved.ids.length === 0) {
    return toolError(
      new Error("Procedure propose requires a resolved project. Pass `projectName`.")
    )
  }

  // 1. Resolve the effective topic key + reject the empty-derived
  //    case BEFORE any other validation. The empty case is a corner
  //    bug (entity="???" + title="!!!" both normalize to empty
  //    alphanumerics) that would skip the idempotency probe and let
  //    two concurrent proposes both create rows.
  const resolvedTopicKey =
    args.topicKey ?? defaultProcedureTopicKey(args.entity ?? "", args.title)
  if (!resolvedTopicKey) {
    return toolError(
      new Error(
        "Procedure propose requires a non-empty topic key. " +
          "Could not derive one from entity / title (both normalized to empty alphanumerics). " +
          "Pass an explicit `topicKey` (kebab-case, e.g. `procedure/cache-miss-runbook`), " +
          "or set a more descriptive `entity` / `title`."
      )
    )
  }

  // 2. Idempotency probe BEFORE source resolution. Mirrors
  //    `lore-task action='create'`'s `findExactReuseTarget` posture:
  //    look up the `(topicKey, project-set)` slot first so a
  //    reuse-short-circuit doesn't pay N Notion round-trips fetching
  //    sources we're not going to write. A live proposed procedure on
  //    the slot short-circuits to reuse; any non-proposed live
  //    procedure throws so the operator deprecates/supersedes
  //    explicitly.
  try {
    const probe = await findExistingProposedProcedure(services, {
      topicKey: resolvedTopicKey,
      projectIds: resolved.ids,
    })
    if (probe.reuseTarget) {
      const reuseLines = [
        `Reused existing proposed procedure: "${probe.reuseTarget.title}" (${probe.reuseTarget.id})`,
        `- Status: ${probe.reuseTarget.status}`,
        `- Topic key: ${probe.reuseTarget.topicKey}`,
        `- Project ids: ${probe.reuseTarget.projectIds.join(", ")}`,
        "",
        "Topic key matched an existing in-flight proposed row; nothing was created.",
        "Review and ship via `lore-memory action='approve'` with this id, or",
        "`lore-memory action='reject'`. Update the body / steps via",
        "`lore-memory action='update'`.",
      ]
      return { content: [{ type: "text", text: reuseLines.join("\n") }] }
    }
  } catch (err) {
    if (err instanceof ProcedureTopicKeyConflictError) {
      return toolError(err)
    }
    throw err
  }

  // 3. Validate every source id is a live, kind-appropriate, scope-
  //    overlapping memory before we touch Notion writes. Runs AFTER
  //    the idempotency probe so reuse re-runs don't pay N getById
  //    round-trips. Closes the "syntactic provenance" blocker — Zod
  //    proves the ids are UUID-shaped; this proves they actually
  //    back the procedure.
  try {
    await resolveProcedureSources(services, args.sourceMemoryIds, resolved.ids)
  } catch (err) {
    if (err instanceof ProcedureSourceResolutionError) {
      return toolError(err)
    }
    throw err
  }

  // 4. Validate every `supersedesIds` entry resolves to a live
  //    procedure / runbook in scope. The page-id schema validates
  //    shape but not liveness; without this preflight a typo lands a
  //    dangling `Supersedes` relation. Sister of `resolveProcedureSources`
  //    with the narrower kind set (procedure | runbook). Same error
  //    type so the dispatcher catches both via one instanceof.
  if (args.supersedesIds && args.supersedesIds.length > 0) {
    try {
      await resolveProcedureSupersedesIds(services, args.supersedesIds, resolved.ids)
    } catch (err) {
      if (err instanceof ProcedureSourceResolutionError) {
        return toolError(err)
      }
      throw err
    }
  }

  const input: ProposeProcedureInput = {
    title: args.title,
    entity: args.entity ?? "",
    body: {
      activationConditions: args.activationConditions ?? [],
      steps: args.steps,
      failureModes: args.failureModes ?? [],
      notes: args.notes,
      sourceMemoryIds: args.sourceMemoryIds,
    },
    projectIds: resolved.ids,
    topicKey: args.topicKey,
    supersedesIds:
      args.supersedesIds && args.supersedesIds.length > 0
        ? args.supersedesIds
        : undefined,
  }
  const createInput = buildProposeProcedureInput(input)
  const memory = await services.memories.create(createInput)
  const lines = [
    `Proposed procedure: "${memory.title}" (${memory.id})`,
    `- Status: ${memory.status}`,
    `- Topic key: ${memory.topicKey || "(none)"}`,
    `- Project ids: ${resolved.ids.join(", ")}`,
    "",
    "Review and ship via `lore-memory action='approve'` with this id —",
    "or reject via `lore-memory action='reject'`. Proposed procedures",
    "do NOT surface as approved fleet-wide guidance in wake-up; they",
    "show up labeled as candidates until reviewed.",
  ]
  if (input.supersedesIds && input.supersedesIds.length > 0) {
    // Supersession is recorded on the new row's `Supersedes` relation,
    // but the old procedure / runbook stays in `Status: accepted` until
    // explicitly deprecated. Without this footer the operator's natural
    // assumption ("supersedesIds takes care of it") leaves two
    // procedures presented as equally current in default recall.
    lines.push(
      "",
      `Supersession recorded on the new row's \`Supersedes\` relation (${input.supersedesIds.length} entr${input.supersedesIds.length === 1 ? "y" : "ies"}). Notion does NOT auto-deprecate the predecessor.`,
      "After approval, run `lore-procedure action='deprecate'` on each predecessor so the old row drops out of accepted recall:"
    )
    for (const id of input.supersedesIds) {
      lines.push(
        `  lore-procedure action='deprecate' memoryId='${id}' reason='Superseded by ${memory.id}'`
      )
    }
  }
  if (resolved.warnings.length > 0) {
    lines.push("", "Warnings:")
    for (const warning of resolved.warnings) lines.push(`- ${warning}`)
  }
  return { content: [{ type: "text", text: lines.join("\n") }] }
}

interface DeprecateArgs {
  action: "deprecate"
  memoryId: string
  reason?: string
}

async function handleDeprecate(
  services: LoreServices,
  args: DeprecateArgs
): Promise<ToolResult> {
  const existing = await services.memories.getById(args.memoryId)
  if (existing.kind !== "procedure") {
    // Kind-scoped guidance: `lore-memory action='update'` with
    // `status: 'deprecated'` is the right path for non-procedure
    // rows (decisions, runbooks, etc.). The update path's
    // procedure-row gate intentionally rejects that same call for
    // kind='procedure', so this advice only applies here.
    return toolError(
      new Error(
        `Memory ${args.memoryId} has kind="${existing.kind}", not "procedure". ` +
          `This lore-procedure deprecate handler is the only procedure-deprecation surface. ` +
          `For this non-procedure row (kind="${existing.kind}"), deprecate via lore-memory action='update' with status: 'deprecated' instead. ` +
          `Do NOT copy that advice back onto a procedure id — the update path rejects procedure rows for the same audit-contract reason this handler exists.`
      )
    )
  }
  if (existing.status === "deprecated") {
    return {
      content: [
        {
          type: "text",
          text: `Procedure already deprecated: "${existing.title}" (${args.memoryId})`,
        },
      ],
    }
  }
  // Status-boundary gate: a `Status: proposed` procedure must leave
  // the inbox via the review surface (`lore-memory action='reject'` /
  // `lore inbox reject`) so the `## Reviewed (YYYY-MM-DD)` audit
  // block lands with the reviewer identity. Deprecate would bypass
  // that audit and produce a second terminal path for unreviewed
  // candidates.
  if (existing.status === "proposed") {
    return toolError(
      new Error(
        `Procedure ${args.memoryId} is Status: proposed and must leave the inbox via review, not deprecate. ` +
          "Use `lore-memory action='reject' memoryId='" +
          args.memoryId +
          "'` (or `lore inbox reject " +
          args.memoryId +
          "`) so the `## Reviewed (YYYY-MM-DD)` audit block lands with the reviewer identity."
      )
    )
  }
  // Superseded / rejected procedures also can't go to deprecated:
  // they already left accepted recall via different paths and a
  // status flip here would obscure that audit trail. Only
  // accepted / informational rows are eligible.
  if (!PROCEDURE_DEPRECATABLE_STATUSES.includes(existing.status)) {
    return toolError(
      new Error(
        `Procedure ${args.memoryId} has Status: ${existing.status}; deprecate is only valid on accepted / informational procedures. ` +
          `(Current status was reached via a non-deprecation path; flipping it would erase that audit trail.)`
      )
    )
  }
  // Sanitize the caller-supplied reason before embedding it inside
  // the `## Deprecated (YYYY-MM-DD)` audit block. Shared helper with
  // the CLI deprecate path so both surfaces apply the same
  // audit-integrity contract: strip control characters and escape
  // line-start markdown structural markers so a forged sibling
  // heading, blockquote audit line, or code fence cannot disrupt
  // the audit block this handler controls.
  const sanitizedReason = args.reason ? sanitizeDeprecateReason(args.reason) : ""
  const reasonBlock = sanitizedReason
    ? `\n\n## Deprecated (${new Date().toISOString().slice(0, 10)})\n\n${sanitizedReason}`
    : ""
  await services.memories.update(args.memoryId, {
    status: "deprecated",
    ...(reasonBlock ? { content: `${existing.content}${reasonBlock}` } : {}),
  })
  return {
    content: [
      {
        type: "text",
        text: `Deprecated procedure: "${existing.title}" (${args.memoryId}). Status: ${existing.status} → deprecated.`,
      },
    ],
  }
}

const procedureDispatchSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("scan-candidates"),
    projectName: z.string().optional(),
    limit: z.number().int().min(1).max(MAX_PROCEDURE_CANDIDATE_LIMIT).optional(),
    minScore: z.number().min(0).optional(),
  }),
  z.object({
    action: z.literal("propose"),
    // Length caps mirror the body composer's per-bullet budget
    // (MAX_BULLET = 500) so a Notion-side payload cannot exceed the
    // structured-section budget. Array-length caps bound the worst-
    // case `pages.updateMarkdown` body size; without them an MCP
    // caller could ship a multi-MB blob into the review surface.
    title: nonBlankString.pipe(z.string().max(200)),
    entity: z.string().max(200).optional(),
    activationConditions: z.array(z.string().max(500)).max(50).optional(),
    // Each step must be non-blank after trim. `z.string().min(1)`
    // accepts `"   "`, which `composeProcedureBody` then renders as a
    // bare `1. ` — defeating the stepless-procedure guard that
    // separates procedures from notes at the schema boundary.
    steps: z
      .array(nonBlankString.pipe(z.string().max(500)))
      .min(1, "procedure must have at least one non-blank step")
      .max(50),
    failureModes: z.array(z.string().max(500)).max(50).optional(),
    notes: z.string().max(8000).optional(),
    // Provenance is load-bearing — a procedure must link back to
    // ≥`PROCEDURE_MIN_SOURCES` supporting memories (same threshold
    // the scan uses). Without this, the propose path bypasses the
    // auditable evidence trail the scan enforces and ships a
    // `Status: proposed` row that can be approved with no provenance.
    sourceMemoryIds: z
      .array(notionPageIdSchema)
      .min(
        PROCEDURE_MIN_SOURCES,
        `procedure must link to at least ${PROCEDURE_MIN_SOURCES} supporting source memories`
      )
      .max(50),
    supersedesIds: z.array(notionPageIdSchema).max(50).optional(),
    // Whitespace-only topicKey would pass `findByTopicKey` (which
    // only short-circuits on exactly `""`) and land in Notion as a
    // literal whitespace key — defeats the idempotency probe.
    // Mirror the title schema's `nonBlankString` posture.
    topicKey: nonBlankString.pipe(z.string().max(120)).optional(),
    projectName: z.string().optional(),
  }),
  z.object({
    action: z.literal("deprecate"),
    memoryId: notionPageIdSchema,
    reason: z.string().max(500).optional(),
  }),
])

export function registerProcedureTools(server: McpServer, services: LoreServices): void {
  server.registerTool(
    "lore-procedure",
    {
      title: "Procedure memory operations",
      description:
        "Promote resolved episodes into reusable, reviewed procedural memories. Action-dispatched:\n\n" +
        "- `action: 'scan-candidates'` — read-only mining over resolved incidents / postmortems / runbooks plus closed tasks. Returns ranked candidate clusters of repeated solved work.\n" +
        "- `action: 'propose'` — create a `Kind: procedure, Status: proposed` memory with structured activation conditions and steps. Validates every `sourceMemoryIds` entry resolves to a live source memory in scope; idempotent on `(topicKey, project-set)`. Supporting source ids render under the procedure body's `## Sources` section; `supersedesIds` (predecessor procedures / runbooks) write the `Supersedes` self-relation. Approval lives on the existing inbox surface (`lore-memory action='approve'`).\n" +
        "- `action: 'deprecate'` — flip an accepted procedure to `Status: deprecated` (history preserved). Rejects `proposed` rows (those leave via `lore-memory action='reject'`). Supersession workflow: pass `supersedesIds` at propose time, then run `lore-procedure action='deprecate'` on each predecessor after the replacement is approved.\n\n" +
        "Procedures are reviewed governance memory. The propose path never auto-promotes — raw session summaries do not become fleet-wide procedures.",
      inputSchema: {
        action: z
          .enum(["scan-candidates", "propose", "deprecate"])
          .describe("Operation: scan-candidates | propose | deprecate."),
        // scan-candidates | propose
        projectName: z
          .string()
          .optional()
          .describe(
            "(action='scan-candidates'/'propose') Optional explicit project. Defaults to the cwd-resolved project."
          ),
        limit: z
          .number()
          .int()
          .optional()
          .describe(
            `(action='scan-candidates') Maximum candidates to return. Default ${DEFAULT_PROCEDURE_CANDIDATE_LIMIT}, capped at ${MAX_PROCEDURE_CANDIDATE_LIMIT}.`
          ),
        minScore: z
          .number()
          .optional()
          .describe(
            "(action='scan-candidates') Minimum candidate score to surface (default 0)."
          ),
        // propose
        title: z
          .string()
          .optional()
          .describe(
            "(action='propose') Required. Short title for the procedure (1-line summary)."
          ),
        entity: z
          .string()
          .optional()
          .describe(
            "(action='propose') Activation entity (PR id, file path, system name). Used to derive default topic key and seed activation tokens. Empty string allowed."
          ),
        activationConditions: z
          .array(z.string())
          .optional()
          .describe(
            "(action='propose') When this procedure applies. Rendered as bullets under `## Activation Conditions`. Tokens are also replicated to `Keywords` for hybrid-search retrieval."
          ),
        steps: z
          .array(z.string())
          .optional()
          .describe(
            "(action='propose') Required. Ordered resolution steps; each step must be non-blank after trim. Rendered as numbered list under `## Steps`. Empty / whitespace-only steps are rejected — a stepless procedure is structurally a note."
          ),
        failureModes: z
          .array(z.string())
          .optional()
          .describe(
            "(action='propose') Known paths that did not work. Rendered as bullets under `## Known Failure Modes`. Optional."
          ),
        notes: z
          .string()
          .optional()
          .describe(
            "(action='propose') Free-form additional context. Rendered verbatim under `## Notes`. Optional."
          ),
        sourceMemoryIds: z
          .array(z.string())
          .optional()
          .describe(
            `(action='propose') Required. Notion page ids (32-char hex or dashed UUID) of supporting memories (closed tasks, postmortems, incidents, runbooks, notes) the procedure distills. Must include at least ${PROCEDURE_MIN_SOURCES} entries — same threshold as the scan, so the propose path cannot bypass the auditable evidence trail. Each id is validated to resolve to a live memory in scope before any write. Rendered under \`## Sources\`.`
          ),
        supersedesIds: z
          .array(z.string())
          .optional()
          .describe(
            "(action='propose') Notion page ids (32-char hex or dashed UUID) of memories this procedure supersedes (e.g. an older runbook). Recorded on the `Supersedes` self-relation. After approval, run `lore-procedure action='deprecate'` on each predecessor — Notion does not auto-deprecate."
          ),
        topicKey: z
          .string()
          .optional()
          .describe(
            "(action='propose') Override default topic key. Default: `procedure/<normalized-entity>`."
          ),
        // deprecate
        memoryId: z
          .string()
          .optional()
          .describe(
            "(action='deprecate') Notion page id (32-char hex or dashed UUID) of the procedure to deprecate."
          ),
        reason: z
          .string()
          .optional()
          .describe(
            "(action='deprecate') Optional rationale; appended as a `## Deprecated` block to the procedure body."
          ),
      },
    },
    async (args): Promise<ToolResult> => {
      try {
        const parsed = procedureDispatchSchema.safeParse(args)
        if (!parsed.success) {
          return toolError(new Error(formatDispatchError("lore-procedure", parsed.error)))
        }
        const data = parsed.data
        switch (data.action) {
          case "scan-candidates":
            // Read-only — no cache bump.
            return await handleScanCandidates(services, data)
          case "propose":
            // Conservative bump: even the reuse short-circuit
            // branch (existing proposed procedure on the topic-key
            // slot) is a no-op cache-wise, but the bump is
            // structurally harmless and keeps the dispatch shape
            // uniform with the other write actions on `lore-memory`.
            return await withWakeUpCacheBump(services.wakeupCache, () =>
              handlePropose(services, data)
            )
          case "deprecate":
            // Same posture — the already-deprecated short-circuit
            // doesn't change primary recall, but uniform bumping
            // keeps the write-action contract one-shape across
            // every dispatcher.
            return await withWakeUpCacheBump(services.wakeupCache, () =>
              handleDeprecate(services, data)
            )
        }
      } catch (err) {
        return toolError(err)
      }
    }
  )
}
