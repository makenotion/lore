import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import { z } from "zod"
import type { LoreServices } from "../../../services.js"
import type {
  TopicAliasMergePlan,
  TopicAliasMergeResult,
} from "../../../core/topic-merge.js"

const topicAliasMergesFileSchema = z.object({
  merges: z
    .array(
      z.object({
        canonical: z.string().min(1, "canonical must be non-empty"),
        aliases: z
          .array(z.string().min(1, "alias must be non-empty"))
          .min(1, "each merge must list at least one alias"),
      })
    )
    .min(1, "merges must contain at least one plan"),
})

/**
 * Load a topic-alias merges YAML file, parse it, and surface friendly
 * errors for the common mistakes (file missing, invalid YAML, wrong
 * shape). Resolves relative paths against the operator's cwd.
 */
export async function loadTopicAliasMerges(path: string): Promise<TopicAliasMergePlan[]> {
  const absolute = resolve(process.cwd(), path)
  let raw: string
  try {
    raw = await readFile(absolute, "utf-8")
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? (err as { code?: string }).code
        : undefined
    if (code === "ENOENT") {
      throw new Error(`Merge file not found: ${absolute}`, { cause: err })
    }
    throw err
  }

  let parsed: unknown
  try {
    parsed = parseYaml(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not parse YAML in ${absolute}: ${msg}`, { cause: err })
  }

  const result = topicAliasMergesFileSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : ""
    throw new Error(`Invalid merge file ${absolute}${where}: ${issue.message}`)
  }

  return result.data.merges
}

/**
 * Print one block per merge plan: header line names the canonical + its
 * status (existing / would-be-created / no-op), followed by one indented
 * line per archived alias row and one summary line when projects change.
 * Kept compact so a YAML listing twenty plans doesn't scroll off-screen.
 */
export function printAliasMergeResults(
  results: TopicAliasMergeResult[],
  opts: { writing: boolean }
): void {
  const workingVerb = opts.writing ? "Merged" : "Would merge"
  const workingResults = results.filter((r) => !r.noop)

  if (workingResults.length === 0) {
    console.log(
      "\nNothing to merge — every alias in the plan already resolved to its canonical."
    )
  } else {
    console.log(
      `\n${workingVerb} ${workingResults.length} topic alias group${workingResults.length === 1 ? "" : "s"}:`
    )
    for (const result of workingResults) {
      const canonicalLabel = result.canonicalCreated
        ? opts.writing
          ? "canonical created"
          : "canonical would be created"
        : "existing canonical"
      console.log(`  "${result.canonical}" (${canonicalLabel})`)
      for (const { name, id } of result.archivedAliases) {
        console.log(`    archived alias "${name}" (${id})`)
      }
      // Collapse the memory clause when the only effect is a Project
      // union extension. Otherwise "re-pointed 0 memories; 4 projects on
      // canonical" reads like something was moved, when nothing was.
      const memories = result.reassignedMemoryIds.length
      const projects = result.canonicalProjectIds.length
      const verb = opts.writing ? "re-pointed" : "would re-point"
      if (memories > 0) {
        console.log(
          `    ${verb} ${memories} memor${memories === 1 ? "y" : "ies"}; ` +
            `${projects} project${projects === 1 ? "" : "s"} on canonical`
        )
      } else {
        console.log(
          `    canonical Project relation covers ${projects} project${projects === 1 ? "" : "s"}`
        )
      }
      if (result.unmatchedAliases.length > 0) {
        console.log(
          `    no match for: ${result.unmatchedAliases.map((a) => `"${a}"`).join(", ")}`
        )
      }
    }
  }

  const noops = results.filter((r) => r.noop)
  if (noops.length > 0) {
    console.log(
      `\n${noops.length} plan${noops.length === 1 ? "" : "s"} already merged (no aliases to collapse):`
    )
    for (const noop of noops) {
      const extra =
        noop.unmatchedAliases.length > 0
          ? ` (no match for: ${noop.unmatchedAliases.map((a) => `"${a}"`).join(", ")})`
          : ""
      console.log(`  "${noop.canonical}"${extra}`)
    }
  }
}

/**
 * Collapse normalized-equivalent topic groups whose stored
 * names differ but normalize to the same key. Plan-only by default; the
 * apply pass rewrites memory→topic relations onto the canonical and
 * archives the sibling rows. Idempotent.
 */
export async function runSimilarTopicsMigration(
  services: LoreServices,
  options: { apply: boolean; dryRun?: boolean }
): Promise<void> {
  const planOnly = !options.apply || options.dryRun === true
  const { groups, mergeResults } = await services.vault.migrateSimilarTopics({
    dryRun: planOnly,
  })

  if (groups.length === 0) {
    console.log(
      "\nNo normalized-equivalent topic groups found — every distinct stored " +
        "name has its own normalized key."
    )
    return
  }

  const verb = planOnly ? "Would merge" : "Merged"
  const totalSiblings = groups.reduce((n, g) => n + g.siblingIds.length, 0)
  console.log(
    `\n${verb} ${groups.length} normalized-equivalent topic group${groups.length === 1 ? "" : "s"} ` +
      `(${totalSiblings} sibling row${totalSiblings === 1 ? "" : "s"} would ${planOnly ? "be" : "have been"} archived):`
  )

  // 10 groups inline keeps wide vaults readable; the rest summarized.
  const PREVIEW_LIMIT = 10
  const sourceForReassign = new Map(mergeResults.map((r) => [r.canonicalId, r] as const))
  for (const group of groups.slice(0, PREVIEW_LIMIT)) {
    const reassignment = sourceForReassign.get(group.canonicalId)
    const memCount = reassignment?.reassignedMemoryIds.length ?? 0
    const aliasNames = group.siblings.map((s) => `"${s.name}"`).join(", ")
    console.log(
      `  "${group.canonicalName}" ← ${aliasNames} ` +
        `(${planOnly ? "would re-point" : "re-pointed"} ${memCount} memor${memCount === 1 ? "y" : "ies"})`
    )
  }
  if (groups.length > PREVIEW_LIMIT) {
    console.log(`  … and ${groups.length - PREVIEW_LIMIT} more groups.`)
  }

  if (planOnly) {
    console.log(
      "\nPlan only — no changes written. Re-run with `--yes` to archive the sibling rows " +
        "and re-point their memories onto each canonical."
    )
  }
}
