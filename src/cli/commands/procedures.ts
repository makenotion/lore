import { Command } from "commander"
import { initServices, type LoreServices } from "../../services.js"
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
import { notionPageIdSchema } from "../../notion/page-id-schema.js"
import {
  resolveProjectScopeName,
  validateExplicitProjectScopeName,
} from "../../core/project-scope.js"
import { parsePositiveDecimalInteger } from "../parse.js"
import type { MemoryStatus } from "../../types.js"

const PROJECT_LIST_HINT = "run `lore status projects` to list configured projects"

type CliParseOk<T> = { ok: true; value: T }
type CliParseErr = { ok: false; message: string }
type CliParseResult<T> = CliParseOk<T> | CliParseErr

interface ScanCliOptions {
  project?: string
  limit: number
  minScore: number
  json: boolean
}

function parseScanCliOptions(raw: {
  project?: string
  limit: string
  minScore: string
  json?: boolean
}): CliParseResult<ScanCliOptions> {
  const parsedLimit = parsePositiveDecimalInteger("--limit", raw.limit)
  if (!parsedLimit.ok) return parsedLimit
  if (parsedLimit.value > MAX_PROCEDURE_CANDIDATE_LIMIT) {
    return {
      ok: false,
      message: `--limit must be ≤ ${MAX_PROCEDURE_CANDIDATE_LIMIT}, got ${parsedLimit.value}`,
    }
  }
  if (!/^[0-9]+(?:\.[0-9]+)?$/.test(raw.minScore)) {
    return {
      ok: false,
      message: `--min-score must be a non-negative decimal number, got "${raw.minScore}"`,
    }
  }
  const minScore = Number(raw.minScore)
  return {
    ok: true,
    value: {
      project: raw.project,
      limit: parsedLimit.value,
      minScore,
      json: Boolean(raw.json),
    },
  }
}

async function resolveProjectIdForScan(
  services: LoreServices,
  projectName: string | undefined
): Promise<string | undefined> {
  const explicit = validateExplicitProjectScopeName(projectName, "--project", {
    listHint: PROJECT_LIST_HINT,
  })
  if (explicit !== undefined) {
    const found = await resolveProjectScopeName(
      services.projects,
      explicit,
      "--project",
      {
        listHint: PROJECT_LIST_HINT,
      }
    )
    return found.id
  }
  return services.context.project?.id
}

function formatScanMarkdown(candidates: ProcedureCandidate[]): string {
  if (candidates.length === 0) {
    return [
      "# Procedure candidates",
      "",
      "No clusters of resolved episodes met the candidate threshold.",
      "",
      "Procedures are mined from repeated solved work — at least two",
      "supporting memories sharing an entity. Try:",
      "- Closing more tasks (`lore tasks list`, then `lore tasks close <id>`).",
      "- Saving incident / postmortem / runbook memories with",
      "  `lore-memory action='save'` so the scan has source material.",
      "",
    ].join("\n")
  }

  const lines: string[] = [
    "# Procedure candidates",
    "",
    `Surfaced ${candidates.length} candidate cluster${candidates.length === 1 ? "" : "s"} (read-only scan).`,
    "",
    "## How to promote",
    "",
    "Review each cluster's supporting sources, distill the resolution",
    "shape into structured activation conditions + steps, then promote",
    "via:",
    "",
    "```",
    "lore procedures propose \\",
    '  --title "<short procedure name>" \\',
    '  --entity "<activation entity>" \\',
    '  --activation "<condition 1>" --activation "<condition 2>" \\',
    '  --step "<step 1>" --step "<step 2>" \\',
    "  --source <memory-id> --source <memory-id>",
    "```",
    "",
    "Promoted procedures land with `Status = proposed` and only become",
    "fleet-wide guidance after a human / authorized agent approves via",
    "`lore inbox approve <id>`. Raw scans never auto-promote.",
    "",
  ]

  candidates.forEach((c, i) => {
    lines.push(`## Candidate ${i + 1}: ${c.entity}`, "")
    lines.push(`- **Cluster key**: \`${c.clusterKey}\``)
    lines.push(`- **Suggested topic key**: \`${c.suggestedTopicKey}\``)
    lines.push(`- **Score**: ${c.score.toFixed(2)}`)
    lines.push(`- **Sources**: ${c.sources.length} (kinds: ${c.kindDiversity})`)
    lines.push("", "Supporting memories:")
    for (const src of c.sources) {
      const stateLabel = src.taskState ? ` [${src.taskState}]` : ""
      lines.push(
        `- ${src.kind}${stateLabel} \`${src.memoryId}\` — ${src.title} (${src.createdAt})`
      )
    }
    lines.push("")
  })

  return lines.join("\n")
}

const scanCommand = new Command("scan")
  .description("Read-only scan for procedure-worthy clusters of resolved episodes")
  .option(
    "-p, --project <name>",
    "Project to scope the scan to (defaults to cwd-resolved project)"
  )
  .option(
    "-n, --limit <n>",
    `Maximum candidates to surface (default ${DEFAULT_PROCEDURE_CANDIDATE_LIMIT}, capped at ${MAX_PROCEDURE_CANDIDATE_LIMIT})`,
    String(DEFAULT_PROCEDURE_CANDIDATE_LIMIT)
  )
  .option("--min-score <n>", "Minimum candidate score to surface", "0")
  .option("--json", "Emit JSON instead of Markdown")
  .action(
    async (opts: {
      project?: string
      limit: string
      minScore: string
      json?: boolean
    }) => {
      try {
        const parsed = parseScanCliOptions(opts)
        if (!parsed.ok) {
          console.error(`Procedure scan failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const projectId = await resolveProjectIdForScan(services, parsed.value.project)
        if (!projectId) {
          console.error(
            "Procedure scan failed: no project resolved. Pass --project <name> or run from inside a configured project directory."
          )
          process.exit(1)
          return
        }
        const candidates = await findProcedureCandidates(services, {
          projectId,
          limit: parsed.value.limit,
          minScore: parsed.value.minScore,
        })
        if (parsed.value.json) {
          console.log(JSON.stringify({ candidates }, null, 2))
        } else {
          console.log(formatScanMarkdown(candidates))
        }
      } catch (err) {
        console.error("Procedure scan failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )

interface ProposeCliOptions {
  project?: string
  title: string
  entity: string
  activation: string[]
  step: string[]
  failureMode: string[]
  notes?: string
  source: string[]
  supersedes: string[]
  topicKey?: string
}

/**
 * Length caps for `lore procedures propose` arguments. Without them an
 * operator could paste a 1MB `--notes` or 1000+ `--step` entries; the
 * caps reject the input at the CLI boundary before any service call.
 * Values match the MCP propose schema's caps so a payload that fails
 * one surface also fails the other.
 */
const CLI_MAX_TITLE = 200
const CLI_MAX_ENTITY = 200
const CLI_MAX_NOTES = 8000
const CLI_MAX_TOPIC_KEY = 120
const CLI_MAX_BULLET = 500
const CLI_MAX_ARRAY = 50

function capCheck(
  field: string,
  value: string,
  cap: number
): { ok: true } | { ok: false; message: string } {
  if (value.length > cap) {
    return {
      ok: false,
      message: `${field} exceeds ${cap} chars (got ${value.length})`,
    }
  }
  return { ok: true }
}

function arrayCheck(
  field: string,
  arr: readonly string[],
  cap: number,
  perItemCap: number
): { ok: true } | { ok: false; message: string } {
  if (arr.length > cap) {
    return {
      ok: false,
      message: `${field} exceeds ${cap} entries (got ${arr.length})`,
    }
  }
  for (let i = 0; i < arr.length; i += 1) {
    const item = arr[i]!
    if (item.length > perItemCap) {
      return {
        ok: false,
        message: `${field} #${i + 1} exceeds ${perItemCap} chars (got ${item.length})`,
      }
    }
  }
  return { ok: true }
}

export function parseProposeCliOptions(raw: {
  project?: string
  title: string
  entity?: string
  activation?: string[]
  step?: string[]
  failureMode?: string[]
  notes?: string
  source?: string[]
  supersedes?: string[]
  topicKey?: string
}): CliParseResult<ProposeCliOptions> {
  if (!raw.title || raw.title.trim() === "") {
    return { ok: false, message: "--title is required and must be non-empty" }
  }
  const titleCheck = capCheck("--title", raw.title, CLI_MAX_TITLE)
  if (!titleCheck.ok) return titleCheck
  if (raw.entity !== undefined) {
    const entityCheck = capCheck("--entity", raw.entity, CLI_MAX_ENTITY)
    if (!entityCheck.ok) return entityCheck
  }
  if (raw.notes !== undefined) {
    const notesCheck = capCheck("--notes", raw.notes, CLI_MAX_NOTES)
    if (!notesCheck.ok) return notesCheck
  }
  if (raw.topicKey !== undefined) {
    if (raw.topicKey.trim() === "") {
      return {
        ok: false,
        message:
          "--topic-key must be non-blank after trimming. Whitespace-only keys defeat the idempotency probe.",
      }
    }
    const tkCheck = capCheck("--topic-key", raw.topicKey, CLI_MAX_TOPIC_KEY)
    if (!tkCheck.ok) return tkCheck
  }
  const steps = raw.step ?? []
  if (steps.length === 0) {
    return {
      ok: false,
      message:
        "at least one --step is required. A procedure is an ordered sequence; an empty steps section makes the row indistinguishable from a note.",
    }
  }
  // Each step must be non-blank after trim. Same guard as the MCP
  // schema's `nonBlankString` — without it a `--step "   "` lands a
  // bare `1. ` in the rendered body and defeats the stepless-procedure
  // boundary that separates procedures from notes.
  const blankStepIdx = steps.findIndex((s) => s.trim() === "")
  if (blankStepIdx !== -1) {
    return {
      ok: false,
      message: `--step entries must be non-blank after trimming; --step #${blankStepIdx + 1} was empty / whitespace-only`,
    }
  }
  const stepsCheck = arrayCheck("--step", steps, CLI_MAX_ARRAY, CLI_MAX_BULLET)
  if (!stepsCheck.ok) return stepsCheck
  const activations = raw.activation ?? []
  const actCheck = arrayCheck("--activation", activations, CLI_MAX_ARRAY, CLI_MAX_BULLET)
  if (!actCheck.ok) return actCheck
  const failureModes = raw.failureMode ?? []
  const fmCheck = arrayCheck(
    "--failure-mode",
    failureModes,
    CLI_MAX_ARRAY,
    CLI_MAX_BULLET
  )
  if (!fmCheck.ok) return fmCheck
  const sources = raw.source ?? []
  // Provenance is load-bearing — a propose call must carry at least
  // `PROCEDURE_MIN_SOURCES` supporting source memory ids (same
  // threshold the scan uses). Without this gate the CLI lets an
  // operator promote a procedure with no auditable evidence trail
  // and bypass the review surface's debugging story.
  if (sources.length < PROCEDURE_MIN_SOURCES) {
    return {
      ok: false,
      message:
        `at least ${PROCEDURE_MIN_SOURCES} --source <memoryId> entries are required ` +
        `(got ${sources.length}). Procedures must link back to supporting memories so ` +
        `the review surface has an auditable evidence trail; this matches the scan threshold.`,
    }
  }
  if (sources.length > CLI_MAX_ARRAY) {
    return {
      ok: false,
      message: `--source exceeds ${CLI_MAX_ARRAY} entries (got ${sources.length})`,
    }
  }
  const supersedes = raw.supersedes ?? []
  if (supersedes.length > CLI_MAX_ARRAY) {
    return {
      ok: false,
      message: `--supersedes exceeds ${CLI_MAX_ARRAY} entries (got ${supersedes.length})`,
    }
  }
  return {
    ok: true,
    value: {
      project: raw.project,
      title: raw.title,
      entity: raw.entity ?? "",
      activation: activations,
      step: steps,
      failureMode: failureModes,
      notes: raw.notes,
      source: sources,
      supersedes,
      topicKey: raw.topicKey,
    },
  }
}

function collectMulti(value: string, prior: string[] | undefined): string[] {
  // Return a NEW array rather than mutating `prior` in place.
  // Commander stores the option's default array once at registration
  // time and passes the same instance as `prior` on the first call
  // of every subsequent `parseAsync` invocation; mutating it would
  // leak state across invocations.
  return prior ? [...prior, value] : [value]
}

const proposeCommand = new Command("propose")
  .description("Promote resolved-episode work into a proposed procedure memory")
  .requiredOption("--title <text>", "Short title for the procedure")
  .option("--entity <text>", "Activation entity (e.g. PR-1234, cache-miss)", "")
  .option(
    "--activation <text>",
    "Activation condition bullet (repeatable)",
    collectMulti,
    [] as string[]
  )
  .option(
    "--step <text>",
    "Resolution step (repeatable, ordered)",
    collectMulti,
    [] as string[]
  )
  .option(
    "--failure-mode <text>",
    "Known failure mode bullet (repeatable)",
    collectMulti,
    [] as string[]
  )
  .option("--notes <text>", "Free-form notes section")
  .option(
    "--source <memoryId>",
    `Notion page id of a supporting memory (repeatable; at least ${PROCEDURE_MIN_SOURCES} required)`,
    collectMulti,
    [] as string[]
  )
  .option(
    "--supersedes <memoryId>",
    "Notion page id of a memory this procedure supersedes (repeatable)",
    collectMulti,
    [] as string[]
  )
  .option(
    "--topic-key <key>",
    "Override default topic key (otherwise derived as procedure/<entity>)"
  )
  .option("-p, --project <name>", "Project to attach the procedure to")
  .action(
    async (opts: {
      project?: string
      title: string
      entity?: string
      activation?: string[]
      step?: string[]
      failureMode?: string[]
      notes?: string
      source?: string[]
      supersedes?: string[]
      topicKey?: string
    }) => {
      try {
        const parsed = parseProposeCliOptions(opts)
        if (!parsed.ok) {
          console.error(`Procedure propose failed: ${parsed.message}`)
          process.exit(1)
          return
        }
        const services = await initServices()
        const projectId = await resolveProjectIdForScan(services, parsed.value.project)
        if (!projectId) {
          console.error(
            "Procedure propose failed: no project resolved. Pass --project <name> or run from inside a configured project directory."
          )
          process.exit(1)
          return
        }

        // Canonicalize CLI page-id args via the shared schema so a
        // 32-char hex (the Notion URL shape) becomes the dashed UUID
        // the service layer expects. Without this, --source <hex>
        // would reach getById as an unmatched id and surface as a
        // generic Notion 400 instead of an actionable parse error.
        const canonicalSources: string[] = []
        for (let i = 0; i < parsed.value.source.length; i += 1) {
          const raw = parsed.value.source[i]!
          const parsedId = notionPageIdSchema.safeParse(raw)
          if (!parsedId.success) {
            console.error(
              `Procedure propose failed: --source #${i + 1} '${raw}' is not a valid Notion page id (32-char hex or dashed UUID).`
            )
            process.exit(1)
            return
          }
          canonicalSources.push(parsedId.data)
        }
        const canonicalSupersedes: string[] = []
        for (let i = 0; i < parsed.value.supersedes.length; i += 1) {
          const raw = parsed.value.supersedes[i]!
          const parsedId = notionPageIdSchema.safeParse(raw)
          if (!parsedId.success) {
            console.error(
              `Procedure propose failed: --supersedes #${i + 1} '${raw}' is not a valid Notion page id (32-char hex or dashed UUID).`
            )
            process.exit(1)
            return
          }
          canonicalSupersedes.push(parsedId.data)
        }

        // Resolve effective topic key + reject empty-derived case
        // BEFORE any service call. An empty key would skip the
        // idempotency probe and let concurrent proposes both create
        // rows.
        const resolvedTopicKey =
          parsed.value.topicKey ??
          defaultProcedureTopicKey(parsed.value.entity, parsed.value.title)
        if (!resolvedTopicKey) {
          console.error(
            "Procedure propose failed: could not derive a topic key from --entity / --title (both normalized to empty alphanumerics). " +
              "Pass an explicit --topic-key (kebab-case, e.g. procedure/cache-miss-runbook), or set a more descriptive --entity / --title."
          )
          process.exit(1)
          return
        }

        // Idempotency probe BEFORE source resolution. Mirror the MCP
        // handler: existing proposed procedure on the same
        // (topicKey, project-set) short-circuits to reuse; any
        // non-proposed live procedure throws so the operator
        // deprecates/supersedes explicitly. Running the probe first
        // saves N getById round-trips on operator re-runs.
        try {
          const probe = await findExistingProposedProcedure(services, {
            topicKey: resolvedTopicKey,
            projectIds: [projectId],
          })
          if (probe.reuseTarget) {
            console.log(
              `Reused existing proposed procedure: "${probe.reuseTarget.title}" (${probe.reuseTarget.id})`
            )
            console.log(`  Status: ${probe.reuseTarget.status}`)
            console.log(`  Topic key: ${probe.reuseTarget.topicKey}`)
            console.log("")
            console.log(
              "Topic key matched an existing in-flight proposed row; nothing was created."
            )
            console.log(
              "Review and ship via `lore inbox approve <id>`, or update its body via `lore-memory action='update'`."
            )
            return
          }
        } catch (err) {
          if (err instanceof ProcedureTopicKeyConflictError) {
            console.error(`Procedure propose failed: ${err.message}`)
            process.exit(1)
            return
          }
          throw err
        }

        // Validate every source id resolves to a live, kind-
        // appropriate, scope-overlapping memory before any Notion
        // write. Runs AFTER the idempotency probe so reuse short-
        // circuits don't pay N getById round-trips.
        try {
          await resolveProcedureSources(services, canonicalSources, [projectId])
        } catch (err) {
          if (err instanceof ProcedureSourceResolutionError) {
            console.error(`Procedure propose failed: ${err.message}`)
            process.exit(1)
            return
          }
          throw err
        }

        // Validate every `supersedesIds` entry resolves to a live
        // procedure / runbook in scope. Page-id schema validates
        // shape but not liveness; a typo here would otherwise land
        // a dangling Supersedes relation. Sister of the source-
        // resolution preflight with the narrower kind set.
        if (canonicalSupersedes.length > 0) {
          try {
            await resolveProcedureSupersedesIds(services, canonicalSupersedes, [
              projectId,
            ])
          } catch (err) {
            if (err instanceof ProcedureSourceResolutionError) {
              console.error(`Procedure propose failed: ${err.message}`)
              process.exit(1)
              return
            }
            throw err
          }
        }

        const input: ProposeProcedureInput = {
          title: parsed.value.title,
          entity: parsed.value.entity,
          body: {
            activationConditions: parsed.value.activation,
            steps: parsed.value.step,
            failureModes: parsed.value.failureMode,
            notes: parsed.value.notes,
            sourceMemoryIds: canonicalSources,
          },
          projectIds: [projectId],
          topicKey: parsed.value.topicKey,
          supersedesIds: canonicalSupersedes.length > 0 ? canonicalSupersedes : undefined,
        }
        const createInput = buildProposeProcedureInput(input)
        const memory = await services.memories.create(createInput)
        console.log(`Proposed procedure: "${memory.title}" (${memory.id})`)
        console.log(`  Status: ${memory.status}`)
        console.log(`  Topic key: ${memory.topicKey || "(none)"}`)
        console.log("")
        console.log("Review and approve via:")
        console.log(`  lore inbox approve ${memory.id}`)
        console.log("")
        console.log("Or reject if it shouldn't ship:")
        console.log(`  lore inbox reject ${memory.id}`)
        if (canonicalSupersedes.length > 0) {
          // Notion does NOT auto-deprecate the predecessor when
          // `Supersedes` is written. Without explicit operator
          // action the old procedure stays in accepted recall
          // alongside the new one. Surface the deprecate step so
          // the workflow is enforceable, not implicit.
          console.log("")
          console.log(
            `Supersession recorded on the new row's \`Supersedes\` relation (${canonicalSupersedes.length} entr${canonicalSupersedes.length === 1 ? "y" : "ies"}). After approval, run:`
          )
          for (const id of canonicalSupersedes) {
            console.log(
              `  lore procedures deprecate ${id} --reason "Superseded by ${memory.id}"`
            )
          }
        }
      } catch (err) {
        console.error(
          "Procedure propose failed:",
          err instanceof Error ? err.message : err
        )
        process.exit(1)
      }
    }
  )

const deprecateCommand = new Command("deprecate")
  .description(
    "Mark an accepted procedure as deprecated (status flip; preserves history)"
  )
  .argument("<memoryId>", "Notion page id of the procedure to deprecate")
  .option("--reason <text>", "Optional rationale recorded on the memory body")
  .action(async (memoryId: string, opts: { reason?: string }) => {
    try {
      // Canonicalize the bare CLI arg via the shared schema before
      // any service call. A typo / undashed paste fails here with a
      // page-id-shaped error instead of an unhelpful Notion 400.
      const parsedId = notionPageIdSchema.safeParse(memoryId)
      if (!parsedId.success) {
        console.error(
          `Procedure deprecate failed: '${memoryId}' is not a valid Notion page id (32-char hex or dashed UUID).`
        )
        process.exit(1)
        return
      }
      const canonicalId = parsedId.data

      // Cap the raw rationale before embedding it in the
      // deprecation audit block so oversized user input cannot be
      // written to Notion. The cap applies to the raw input;
      // sanitization (heading / blockquote / fence escape and
      // control-char stripping) runs below, before composition.
      if (opts.reason !== undefined && opts.reason.length > 500) {
        console.error(
          `Procedure deprecate failed: --reason exceeds 500 chars (got ${opts.reason.length}). Trim before re-running.`
        )
        process.exit(1)
        return
      }

      const services = await initServices()
      const existing = await services.memories.getById(canonicalId)
      if (existing.kind !== "procedure") {
        console.error(
          `Procedure deprecate failed: memory ${canonicalId} is kind="${existing.kind}", not "procedure".`
        )
        process.exit(1)
        return
      }
      // Idempotency: an already-deprecated row should not re-write
      // Notion (the status flip is a no-op and the optional reason
      // block would double-append on every CLI re-run). Mirrors the
      // MCP `lore-procedure action='deprecate'` handler.
      if (existing.status === "deprecated") {
        console.log(`Procedure already deprecated: "${existing.title}" (${canonicalId})`)
        return
      }
      // Status-boundary gate: a `Status: proposed` procedure must
      // leave the inbox via review, not deprecate. Deprecate would
      // bypass the `## Reviewed (YYYY-MM-DD)` audit block and
      // produce a second terminal path for unreviewed candidates.
      if (existing.status === "proposed") {
        console.error(
          `Procedure deprecate failed: ${canonicalId} is Status: proposed and must leave the inbox via review, not deprecate.\n` +
            `Use \`lore inbox reject ${canonicalId}\` so the \`## Reviewed (YYYY-MM-DD)\` audit block lands with the reviewer identity.`
        )
        process.exit(1)
        return
      }
      // Superseded / rejected procedures already left accepted
      // recall via different paths; flipping to deprecated here
      // would erase that audit trail.
      if (!PROCEDURE_DEPRECATABLE_STATUSES.includes(existing.status)) {
        console.error(
          `Procedure deprecate failed: ${canonicalId} has Status: ${existing.status}; deprecate is only valid on accepted / informational procedures.`
        )
        process.exit(1)
        return
      }
      const nextStatus: MemoryStatus = "deprecated"
      // Shared helper with the MCP deprecate path so both surfaces
      // apply the same audit-integrity contract: strip C0 controls
      // / bidi-overrides / zero-width characters and escape line-start
      // markdown structural markers so the caller-supplied reason
      // cannot forge an adjacent audit heading, blockquote line, or
      // code fence inside the deprecated procedure's body.
      const sanitizedReason = opts.reason ? sanitizeDeprecateReason(opts.reason) : ""
      const reasonLine = sanitizedReason
        ? `\n\n## Deprecated (${new Date().toISOString().slice(0, 10)})\n\n${sanitizedReason}`
        : ""
      const newContent = reasonLine ? `${existing.content}${reasonLine}` : undefined
      await services.memories.update(canonicalId, {
        status: nextStatus,
        ...(newContent !== undefined ? { content: newContent } : {}),
      })
      console.log(
        `Deprecated procedure: "${existing.title}" (${canonicalId}). Status: ${existing.status} → deprecated.`
      )
    } catch (err) {
      console.error(
        "Procedure deprecate failed:",
        err instanceof Error ? err.message : err
      )
      process.exit(1)
    }
  })

export const proceduresCommand = new Command("procedures")
  .description("Promote resolved episodes into reusable procedural memories")
  .addCommand(scanCommand)
  .addCommand(proposeCommand)
  .addCommand(deprecateCommand)
