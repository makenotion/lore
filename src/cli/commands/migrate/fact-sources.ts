import type { LoreServices } from "../../../services.js"
import type { Fact, Memory } from "../../../types.js"

export interface FactMatchCandidate {
  fact: Fact
  memory: Memory | null
  /** Normalized description of how the candidate was chosen. */
  reason: string
}

/**
 * Find facts with an empty `Source` relation and propose a supporting
 * memory for each. Matching heuristic is deliberately conservative: we
 * require a search hit whose title contains the fact's subject or object.
 * Operator reviews the printed report and re-runs with `--apply` to commit.
 *
 * This is best-effort triage for the orphan backlog surfaced in the
 * internal vault audit — not a substitute for the write-side `sourceMemoryId`
 * discipline now enforced on `lore-fact action='create'`.
 */
export async function backfillFactSources(
  services: LoreServices,
  opts: { apply: boolean; projectId?: string }
): Promise<void> {
  const orphans = opts.projectId
    ? await services.facts.queryOrphans({ projectId: opts.projectId })
    : await services.facts.queryOrphans()

  if (orphans.length === 0) {
    console.log(
      "\nNo orphan facts found — every current fact already links to a source memory."
    )
    return
  }

  console.log(
    `\nFound ${orphans.length} orphan fact${orphans.length === 1 ? "" : "s"} (no Source relation).`
  )

  const candidates: FactMatchCandidate[] = []
  for (const fact of orphans) {
    const candidate = await proposeSourceMemory(services, fact)
    candidates.push(candidate)
  }

  const matched = candidates.filter((c) => c.memory !== null)
  const unmatched = candidates.filter((c) => c.memory === null)

  const verb = opts.apply ? "Linking" : "Proposed"
  console.log(`\n${verb} ${matched.length} match${matched.length === 1 ? "" : "es"}:`)
  for (const { fact, memory, reason } of matched) {
    if (!memory) continue
    console.log(
      `  ${fact.subject} → ${fact.predicate.replace(/_/g, " ")} → ${fact.object}`
    )
    console.log(
      `    fact ${fact.id} → memory "${memory.title}" (${memory.id}) [${reason}]`
    )
  }

  if (unmatched.length > 0) {
    console.log(
      `\n${unmatched.length} fact${unmatched.length === 1 ? "" : "s"} without a candidate memory (will remain orphan):`
    )
    for (const { fact } of unmatched) {
      console.log(
        `  fact ${fact.id}: ${fact.subject} ${fact.predicate.replace(/_/g, " ")} ${fact.object}`
      )
    }
  }

  if (opts.apply) {
    let applied = 0
    for (const { fact, memory } of matched) {
      if (!memory) continue
      await services.facts.setSource(fact.id, memory.id)
      applied++
    }
    console.log(
      `\nLinked ${applied} orphan fact${applied === 1 ? "" : "s"} to proposed source memor${applied === 1 ? "y" : "ies"}.`
    )
  } else {
    console.log(
      "\nRead-only pass — no Source relations written. Re-run with `--apply` to commit the matches above."
    )
  }
}

/**
 * Propose a supporting memory for an orphan fact via semantic search. Uses
 * the fact's subject as the primary query (most facts are structured
 * "Entity → predicate → Value" where the Subject is the central concept),
 * and falls back to the object if the subject search turns up nothing.
 *
 * Returns `null` memory when no candidate survives the title-match check.
 * False positives are more damaging than false negatives here — an orphan
 * fact is recoverable; a mis-linked Source distorts
 * `lore-query action='ask'` outputs for the lifetime of the fact.
 *
 * Assumes autosave is not creating facts concurrently. `setSource` at the
 * call site in `backfillFactSources` overwrites without re-checking, which
 * is safe when the backfill is operator-run during a quiet window.
 */
export async function proposeSourceMemory(
  services: Pick<LoreServices, "memories">,
  fact: Fact
): Promise<FactMatchCandidate> {
  const search = async (query: string): Promise<Memory | null> => {
    if (!matchableQuery(query)) return null

    // Scope to every project the fact is in, not just the first. A fact on
    // [A, B] should match memories in either project, not just in A.
    const projectIds = fact.projectIds.length > 0 ? fact.projectIds : [undefined]
    for (const projectId of projectIds) {
      const results = await services.memories.search({
        query,
        projectId,
        limit: 5,
        includeContent: false,
      })
      for (const memory of results) {
        if (titleMatches(memory.title, query)) return memory
      }
    }
    return null
  }

  const bySubject = await search(fact.subject)
  if (bySubject) {
    return { fact, memory: bySubject, reason: `title matches subject "${fact.subject}"` }
  }

  const byObject = await search(fact.object)
  if (byObject) {
    return { fact, memory: byObject, reason: `title matches object "${fact.object}"` }
  }

  return { fact, memory: null, reason: "no title match" }
}

/**
 * A query must be long enough to be discriminating, or multi-word so a
 * substring hit is unlikely to be incidental. Three-letter common tokens
 * ("API", "DB", "Widget") would otherwise false-positive against half the
 * workspace.
 */
function matchableQuery(query: string): boolean {
  const trimmed = query.trim()
  if (trimmed.length === 0) return false
  if (trimmed.length >= 4) return true
  return /\s/.test(trimmed)
}

/**
 * Accept a candidate only when the query appears as a whole word in the
 * title. `"API" → uses → "JSON"` must not match "rapid-fire" (contains
 * "api" as a substring) but should match "API design checklist".
 */
function titleMatches(title: string, query: string): boolean {
  const escaped = query.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`(^|\\W)${escaped}($|\\W)`, "i")
  return pattern.test(title)
}
