import type { CreateFactInput, Decision, Fact, FactPredicate } from "../types.js"

type QueryFactsOpts = {
  projectId?: string
  includeInvalidated?: boolean
  predicates?: FactPredicate[]
  limit?: number
}

export interface DecisionGraphServices {
  decisions: {
    getById(id: string): Promise<Decision>
  }
  facts: {
    queryByObject(object: string, opts?: QueryFactsOpts): Promise<Fact[]>
    queryBySourceMemory(sourceMemoryId: string, opts?: QueryFactsOpts): Promise<Fact[]>
    create(input: CreateFactInput): Promise<Fact>
    invalidate(id: string): Promise<void>
  }
}

export interface ResolvedCurrentDecisions {
  current: Decision[]
  replacedCount: number
}

export interface CanonicalDecisionLink {
  fact: Fact
  decision: Decision
}

export interface ReachabilitySyncResult {
  invalidated: number
  created: number
}

/**
 * Resolve a set of decision IDs to the current active leaf decisions by
 * following `supersedes_decision` edges forward through the graph.
 */
export async function resolveCurrentDecisions(
  services: DecisionGraphServices,
  decisionIds: string[],
  opts: { projectId?: string } = {}
): Promise<ResolvedCurrentDecisions> {
  const queue = Array.from(new Set(decisionIds.filter(Boolean)))
  const visited = new Set<string>()
  const replaced = new Set<string>()
  const leafIds = new Set<string>()
  const decisionCache = new Map<string, Decision | null>()
  const successorCache = new Map<string, string[]>()

  async function getDecision(id: string): Promise<Decision | null> {
    const cached = decisionCache.get(id)
    if (cached !== undefined) return cached
    const loaded = await services.decisions.getById(id).catch(() => null)
    decisionCache.set(id, loaded)
    return loaded
  }

  async function getSuccessorIds(id: string): Promise<string[]> {
    const cached = successorCache.get(id)
    if (cached !== undefined) return cached

    const decision = await getDecision(id)
    const lookupKeys = [id]
    if (decision?.title && decision.title !== id) {
      lookupKeys.push(decision.title)
    }

    const successors = new Set<string>()
    for (const key of lookupKeys) {
      const facts = await services.facts.queryByObject(key, {
        projectId: opts.projectId,
        predicates: ["supersedes_decision"],
        limit: 25,
      })

      for (const fact of facts) {
        if (fact.predicate !== "supersedes_decision" || fact.object !== key) continue
        const successorId = fact.sourceMemoryId ?? fact.subject
        if (successorId && successorId !== id) {
          successors.add(successorId)
        }
      }
    }

    const resolved = Array.from(successors)
    successorCache.set(id, resolved)
    return resolved
  }

  while (queue.length > 0) {
    const currentId = queue.shift()
    if (!currentId || visited.has(currentId)) continue

    visited.add(currentId)
    const successorIds = await getSuccessorIds(currentId)
    if (successorIds.length === 0) {
      const decision = await getDecision(currentId)
      if (!decision || decision.status === "superseded") {
        replaced.add(currentId)
        continue
      }
      leafIds.add(currentId)
      continue
    }

    replaced.add(currentId)
    queue.push(...successorIds)
  }

  const current = (
    await Promise.all(Array.from(leafIds).map((id) => getDecision(id)))
  ).filter((decision): decision is Decision => decision !== null)

  current.sort((a, b) => decisionSortKey(b).localeCompare(decisionSortKey(a)))
  return { current, replacedCount: replaced.size }
}

/**
 * Resolve `decided_by` facts to the current canonical decisions they imply.
 * Deduplicates repeated links that converge on the same subject/decision pair.
 */
export async function resolveCanonicalDecisionLinks(
  services: DecisionGraphServices,
  facts: Fact[],
  opts: { projectId?: string } = {}
): Promise<CanonicalDecisionLink[]> {
  const links: CanonicalDecisionLink[] = []
  const seen = new Set<string>()
  const resolutionCache = new Map<string, Promise<ResolvedCurrentDecisions>>()

  for (const fact of facts) {
    const rootId = fact.sourceMemoryId ?? fact.object
    if (!rootId) continue

    let resolution = resolutionCache.get(rootId)
    if (!resolution) {
      resolution = resolveCurrentDecisions(services, [rootId], opts)
      resolutionCache.set(rootId, resolution)
    }

    for (const decision of (await resolution).current) {
      const key = `${fact.subject}\u0000${decision.id}`
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ fact, decision })
    }
  }

  return links
}

/**
 * Retarget active `decided_by` facts from an old decision onto its replacement.
 * This keeps the graph canonical after supersession so read paths do less work.
 */
export async function syncDecisionReachability(
  services: DecisionGraphServices,
  oldDecisionId: string,
  newDecision: Decision
): Promise<ReachabilitySyncResult> {
  if (oldDecisionId === newDecision.id) {
    return { invalidated: 0, created: 0 }
  }

  const [oldFacts, existingNewFacts] = await Promise.all([
    services.facts.queryBySourceMemory(oldDecisionId, {
      predicates: ["decided_by"],
    }),
    services.facts.queryBySourceMemory(newDecision.id, {
      predicates: ["decided_by"],
    }),
  ])

  const existingSubjects = new Set(existingNewFacts.map((fact) => fact.subject))
  let invalidated = 0
  let created = 0

  for (const fact of oldFacts) {
    await services.facts.invalidate(fact.id)
    invalidated++

    if (existingSubjects.has(fact.subject)) continue

    await services.facts.create({
      subject: fact.subject,
      predicate: "decided_by",
      object: newDecision.id,
      projectIds:
        fact.projectIds.length > 0
          ? fact.projectIds
          : newDecision.projectIds.length > 0
            ? newDecision.projectIds
            : undefined,
      sourceMemoryId: newDecision.id,
      confidence: newDecision.confidence,
    })

    existingSubjects.add(fact.subject)
    created++
  }

  return { invalidated, created }
}

function decisionSortKey(decision: Decision): string {
  return decision.decidedAt ?? decision.updatedAt
}
