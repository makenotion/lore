import type {
  SearchPlanResultTrace,
  SearchPlanVariant,
  SearchPlanVariantHit,
  SearchQueryPlan,
} from "../types.js"

export type {
  SearchPlanResultTrace,
  SearchPlanVariant,
  SearchPlanVariantKind,
  SearchQueryPlan,
  SearchStrategy,
} from "../types.js"

export interface PlannedSearchMerge<T> {
  items: T[]
  trace: SearchPlanResultTrace[]
}

const DEFAULT_MAX_QUERIES = 3
const DEFAULT_MAX_QUERY_LENGTH = 180
const DEFAULT_MAX_ORIGINAL_QUERY_LENGTH = 1000
const RRF_K = 60

const SECRET_PATTERNS = [
  /\b(?:development_)?ntn_[A-Za-z0-9_=-]{12,}\b/giu,
  /\bsecret_[A-Za-z0-9_=-]{12,}\b/giu,
  /\b\d{5,}:[A-Za-z0-9_-]{12,}\b/gu,
  /\b[A-Za-z0-9_-]{48,}\b/gu,
]

const STOPWORDS = new Set([
  "about",
  "above",
  "after",
  "again",
  "against",
  "also",
  "among",
  "and",
  "answer",
  "any",
  "are",
  "around",
  "ask",
  "because",
  "before",
  "being",
  "between",
  "but",
  "can",
  "case",
  "could",
  "does",
  "done",
  "each",
  "every",
  "find",
  "for",
  "from",
  "get",
  "give",
  "has",
  "have",
  "help",
  "how",
  "into",
  "its",
  "just",
  "make",
  "more",
  "need",
  "needs",
  "not",
  "our",
  "out",
  "please",
  "query",
  "rather",
  "run",
  "should",
  "show",
  "some",
  "task",
  "than",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "thing",
  "this",
  "those",
  "through",
  "use",
  "using",
  "want",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "without",
  "would",
  "you",
  "your",
])

const ACTION_TERMS = new Set([
  "add",
  "analyze",
  "audit",
  "build",
  "configure",
  "debug",
  "deploy",
  "design",
  "diagnose",
  "fix",
  "generate",
  "implement",
  "improve",
  "install",
  "integrate",
  "measure",
  "migrate",
  "optimize",
  "parse",
  "refactor",
  "render",
  "retrieve",
  "review",
  "run",
  "search",
  "summarize",
  "test",
  "triage",
  "update",
  "validate",
  "verify",
])

export function planSearchQueries(
  rawQuery: string,
  options: {
    maxQueries?: number
    maxQueryLength?: number
    maxOriginalQueryLength?: number
  } = {}
): SearchQueryPlan {
  const maxQueries = boundedInteger(options.maxQueries ?? DEFAULT_MAX_QUERIES, 1, 8)
  const maxQueryLength = boundedInteger(
    options.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH,
    80,
    300
  )
  const maxOriginalQueryLength = boundedInteger(
    options.maxOriginalQueryLength ?? DEFAULT_MAX_ORIGINAL_QUERY_LENGTH,
    80,
    2000
  )
  const sanitized = normalizeSearchText(stripSecretLikeTokens(rawQuery))
  const candidates: SearchPlanVariant[] = []
  const terms = extractSearchTerms(sanitized)
  const exactTerms = exactSearchTerms(sanitized)
  const actionTerms = terms.filter((term) => ACTION_TERMS.has(term.toLowerCase()))
  const contentTerms = terms.filter((term) => !ACTION_TERMS.has(term.toLowerCase()))

  addVariant(candidates, {
    kind: "original",
    query: trimOriginalQuery(sanitized, maxOriginalQueryLength),
  })

  addVariant(candidates, {
    kind: "facets",
    query: trimQuery([...exactTerms, ...actionTerms, ...contentTerms], maxQueryLength),
  })

  addVariant(candidates, {
    kind: "capability",
    query: capabilitySearchQuery(sanitized, maxQueryLength),
  })

  addVariant(candidates, {
    kind: "exact",
    query: trimQuery([...exactTerms, ...contentTerms], maxQueryLength),
  })

  addVariant(candidates, {
    kind: "action",
    query: trimQuery([...actionTerms, ...contentTerms], maxQueryLength),
  })

  for (const clause of scoredClauses(sanitized, terms).slice(0, 3)) {
    addVariant(candidates, {
      kind: "clause",
      query: trimQuery(extractSearchTerms(clause.text), maxQueryLength),
    })
  }

  return {
    originalQuery: sanitized,
    variants: candidates.slice(0, maxQueries),
  }
}

export function mergePlannedSearchResults<T>(
  resultSets: readonly (readonly T[])[],
  options: {
    getId: (item: T) => string
    limit: number
    preserveFirstSetCount?: number
  }
): PlannedSearchMerge<T> {
  const entries = new Map<
    string,
    {
      id: string
      item: T
      score: number
      bestRank: number
      firstVariantIndex: number
      variantHits: SearchPlanVariantHit[]
    }
  >()
  const limit = Math.max(0, Math.trunc(options.limit))

  resultSets.forEach((items, variantIndex) => {
    items.forEach((item, rank) => {
      const id = options.getId(item)
      const score = 1 / (RRF_K + rank + 1)
      const existing = entries.get(id)
      if (existing) {
        existing.score += score
        existing.bestRank = Math.min(existing.bestRank, rank)
        existing.variantHits.push({ variantIndex, rank })
        return
      }
      entries.set(id, {
        id,
        item,
        score,
        bestRank: rank,
        firstVariantIndex: variantIndex,
        variantHits: [{ variantIndex, rank }],
      })
    })
  })

  const ranked = [...entries.values()].sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank
    if (a.firstVariantIndex !== b.firstVariantIndex) {
      return a.firstVariantIndex - b.firstVariantIndex
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  const selected = anchorFirstResultSet(
    ranked.slice(0, limit),
    resultSets[0] ?? [],
    entries,
    {
      getId: options.getId,
      limit,
      preserveFirstSetCount: options.preserveFirstSetCount ?? 0,
    }
  ).sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank
    if (a.firstVariantIndex !== b.firstVariantIndex) {
      return a.firstVariantIndex - b.firstVariantIndex
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  return {
    items: selected.map((entry) => entry.item),
    trace: selected.map((entry) => ({
      memoryId: entry.id,
      score: entry.score,
      bestRank: entry.bestRank,
      variantHits: [...entry.variantHits].sort((a, b) => {
        if (a.variantIndex !== b.variantIndex) return a.variantIndex - b.variantIndex
        return a.rank - b.rank
      }),
    })),
  }
}

type PlannedEntry<T> = {
  id: string
  item: T
  score: number
  bestRank: number
  firstVariantIndex: number
  variantHits: SearchPlanVariantHit[]
}

function anchorFirstResultSet<T>(
  selected: PlannedEntry<T>[],
  firstResultSet: readonly T[],
  entries: ReadonlyMap<string, PlannedEntry<T>>,
  options: {
    getId: (item: T) => string
    limit: number
    preserveFirstSetCount: number
  }
): PlannedEntry<T>[] {
  if (options.limit <= 0 || options.preserveFirstSetCount <= 0) return selected

  const anchorIds = new Set(
    firstResultSet
      .slice(0, Math.min(options.limit, options.preserveFirstSetCount))
      .map(options.getId)
  )
  if (anchorIds.size === 0) return selected

  const selectedIds = new Set(selected.map((entry) => entry.id))
  for (const anchorId of anchorIds) {
    if (selectedIds.has(anchorId)) continue
    const anchor = entries.get(anchorId)
    if (!anchor) continue
    if (selected.length < options.limit) {
      selected.push(anchor)
      selectedIds.add(anchor.id)
      continue
    }

    let replaceIndex = -1
    for (let index = selected.length - 1; index >= 0; index -= 1) {
      if (!anchorIds.has(selected[index]!.id)) {
        replaceIndex = index
        break
      }
    }
    if (replaceIndex === -1) break

    selectedIds.delete(selected[replaceIndex]!.id)
    selected[replaceIndex] = anchor
    selectedIds.add(anchor.id)
  }

  return selected
}

function stripSecretLikeTokens(value: string): string {
  return SECRET_PATTERNS.reduce((text, pattern) => text.replace(pattern, " "), value)
}

function normalizeSearchText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s)]+/giu, (url) => {
      try {
        const parsed = new URL(url)
        return `${parsed.hostname} ${parsed.pathname.replace(/[/?#=&._-]+/gu, " ")}`
      } catch {
        return " "
      }
    })
    .replace(/[\u2018\u2019]/gu, "'")
    .replace(/[\u201c\u201d]/gu, '"')
    .replace(/\s+/gu, " ")
    .trim()
}

function extractSearchTerms(text: string): string[] {
  const weighted = new Map<string, number>()
  for (const term of exactSearchTerms(text)) {
    weighted.set(term, (weighted.get(term) ?? 0) + 5)
  }
  for (const match of text.matchAll(
    /\b[A-Za-z][A-Za-z0-9]*(?:[./_:+#-][A-Za-z0-9]+)+\b/gu
  )) {
    addWeightedTerm(weighted, match[0]!, 4)
  }
  for (const match of text.matchAll(/\b[A-Z]{2,}[A-Za-z0-9]*\b/gu)) {
    addWeightedTerm(weighted, match[0]!, 3)
  }
  for (const match of text.matchAll(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/gu)) {
    addWeightedTerm(weighted, match[0]!, 3)
  }
  for (const match of text.matchAll(/\b[a-zA-Z][a-zA-Z0-9]{2,}\b/gu)) {
    const term = match[0]!
    const normalized = term.toLowerCase()
    if (STOPWORDS.has(normalized)) continue
    const score = ACTION_TERMS.has(normalized) ? 3 : 1
    addWeightedTerm(weighted, normalized, score)
  }
  return [...weighted.entries()]
    .sort((a, b) => {
      if (a[1] !== b[1]) return b[1] - a[1]
      return a[0].localeCompare(b[0])
    })
    .map(([term]) => term)
}

function exactSearchTerms(text: string): string[] {
  const values: string[] = []
  for (const match of text.matchAll(/`([^`]{2,80})`/gu)) {
    values.push(match[1]!)
  }
  for (const match of text.matchAll(/"([^"]{3,80})"/gu)) {
    values.push(match[1]!)
  }
  return uniqueTerms(values.flatMap((value) => splitExactTerm(value)))
}

function splitExactTerm(value: string): string[] {
  const normalized = value.trim()
  if (!normalized) return []
  if (normalized.length <= 40 && /\s/u.test(normalized)) return [normalized]
  return normalized
    .split(/[^A-Za-z0-9./_:+#-]+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2)
}

function scoredClauses(
  text: string,
  rankedTerms: readonly string[]
): Array<{ text: string; score: number }> {
  const topTerms = new Set(rankedTerms.slice(0, 16).map((term) => term.toLowerCase()))
  return text
    .split(/(?:[.;?!]|\n| - |\s+\|\s+)/u)
    .map((part) => normalizeSearchText(part))
    .filter((part) => part.length >= 20)
    .map((part) => {
      const clauseTerms = extractSearchTerms(part)
      const score = clauseTerms.reduce((total, term) => {
        const normalized = term.toLowerCase()
        if (ACTION_TERMS.has(normalized)) return total + 3
        if (topTerms.has(normalized)) return total + 2
        return total + 1
      }, 0)
      return { text: part, score }
    })
    .filter((part) => part.score > 0)
    .sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score
      if (a.text.length !== b.text.length) return b.text.length - a.text.length
      return a.text.localeCompare(b.text)
    })
}

function capabilitySearchQuery(text: string, maxLength: number): string {
  const terms = extractSearchTerms(text)
  const exactTerms = exactSearchTerms(text)
  const actionTerms = terms.filter((term) => ACTION_TERMS.has(term.toLowerCase()))
  const contentTerms = terms.filter((term) => !ACTION_TERMS.has(term.toLowerCase()))
  const subjectTerms = uniqueTerms([...exactTerms, ...contentTerms]).slice(0, 12)
  if (subjectTerms.length === 0) return ""
  if (subjectTerms.length < 3 && actionTerms.length === 0) return ""

  const action = actionTerms.length > 0 ? actionTerms.slice(0, 4).join(" ") : "work with"
  return trimOriginalQuery(
    trimQuery(["Use", "when", action, ...subjectTerms], maxLength),
    maxLength
  )
}

function addWeightedTerm(
  weighted: Map<string, number>,
  rawTerm: string,
  score: number
): void {
  const normalized = rawTerm.trim()
  if (normalized.length < 2) return
  if (isSecretLikeTerm(normalized)) return
  weighted.set(normalized, (weighted.get(normalized) ?? 0) + score)
}

function isSecretLikeTerm(value: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0
    return pattern.test(value)
  })
}

function trimQuery(terms: readonly string[], maxLength: number): string {
  const unique = uniqueTerms(terms)
  const selected: string[] = []
  for (const term of unique) {
    const next = [...selected, term].join(" ")
    if (next.length > maxLength) break
    selected.push(term)
  }
  return selected.join(" ")
}

function trimOriginalQuery(query: string, maxLength: number): string {
  if (query.length <= maxLength) return query
  const cutoff = query.slice(0, maxLength)
  const lastSpace = cutoff.lastIndexOf(" ")
  return cutoff.slice(0, lastSpace > maxLength * 0.75 ? lastSpace : maxLength).trim()
}

function addVariant(candidates: SearchPlanVariant[], variant: SearchPlanVariant): void {
  const query = normalizeSearchText(variant.query)
  if (!query) return
  const normalized = query.toLowerCase()
  if (candidates.some((candidate) => candidate.query.toLowerCase() === normalized)) {
    return
  }
  candidates.push({ ...variant, query })
}

function uniqueTerms(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const normalized = value.trim()
    if (!normalized) continue
    const key = normalized.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(normalized)
  }
  return out
}

function boundedInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}
