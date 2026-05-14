import {
  GENERIC_FACT_PREDICATES,
  type ResolvedProfileTaxonomy,
} from "../profile/index.js"

export interface ProfileExtractionEntity {
  name: string
  kind: string
}

export interface ProfileExtractionFact {
  subject: string
  predicate: string
  object: string
  evidence?: string
}

export interface ProfileExtractionMemory {
  title: string
  synopsis: string
  tags: string[]
  content: string
  entities: ProfileExtractionEntity[]
  facts: ProfileExtractionFact[]
}

export interface ProfileExtractionOutput {
  memories: ProfileExtractionMemory[]
}

export interface ProfileMetricThresholds {
  entityKindRecallMin: number
  predicatePrecisionMin: number
  hallucinatedFactRateMax: number
  requiredFieldCompletenessMin: number
  invalidTaxonomyRateMax: number
}

export interface ProfileMetricCounts {
  expectedEntities: number
  correctEntityKinds: number
  predictedWritableFacts: number
  correctWritableFacts: number
  actualFacts: number
  hallucinatedFacts: number
  requiredFields: number
  completeRequiredFields: number
  taxonomyValues: number
  invalidTaxonomyValues: number
}

export interface ProfileMetricBreakdown {
  entityKindRecall: number
  predicatePrecision: number
  hallucinatedFactRate: number
  requiredFieldCompleteness: number
  invalidTaxonomyRate: number
  counts: ProfileMetricCounts
}

export function emptyProfileMetricCounts(): ProfileMetricCounts {
  return {
    expectedEntities: 0,
    correctEntityKinds: 0,
    predictedWritableFacts: 0,
    correctWritableFacts: 0,
    actualFacts: 0,
    hallucinatedFacts: 0,
    requiredFields: 0,
    completeRequiredFields: 0,
    taxonomyValues: 0,
    invalidTaxonomyValues: 0,
  }
}

export function mergeProfileMetricCounts(
  counts: readonly ProfileMetricCounts[]
): ProfileMetricCounts {
  const out = emptyProfileMetricCounts()
  for (const count of counts) {
    out.expectedEntities += count.expectedEntities
    out.correctEntityKinds += count.correctEntityKinds
    out.predictedWritableFacts += count.predictedWritableFacts
    out.correctWritableFacts += count.correctWritableFacts
    out.actualFacts += count.actualFacts
    out.hallucinatedFacts += count.hallucinatedFacts
    out.requiredFields += count.requiredFields
    out.completeRequiredFields += count.completeRequiredFields
    out.taxonomyValues += count.taxonomyValues
    out.invalidTaxonomyValues += count.invalidTaxonomyValues
  }
  return out
}

export function profileMetricsFromCounts(
  counts: ProfileMetricCounts
): ProfileMetricBreakdown {
  return {
    entityKindRecall: ratioOrPerfect(
      counts.correctEntityKinds,
      counts.expectedEntities
    ),
    predicatePrecision: ratioOrPerfect(
      counts.correctWritableFacts,
      counts.predictedWritableFacts
    ),
    hallucinatedFactRate: ratioOrZero(counts.hallucinatedFacts, counts.actualFacts),
    requiredFieldCompleteness: ratioOrPerfect(
      counts.completeRequiredFields,
      counts.requiredFields
    ),
    invalidTaxonomyRate: ratioOrZero(
      counts.invalidTaxonomyValues,
      counts.taxonomyValues
    ),
    counts,
  }
}

export function scoreProfileExtraction(input: {
  expected: ProfileExtractionOutput
  actual: ProfileExtractionOutput
  taxonomy: ResolvedProfileTaxonomy
  writableFactPredicates: readonly string[]
}): ProfileMetricBreakdown {
  const tagVocabulary = new Set(input.taxonomy.tags)
  const entityKindVocabulary = new Set(input.taxonomy.entityKinds)
  const predicateVocabulary = new Set([
    ...GENERIC_FACT_PREDICATES,
    ...input.writableFactPredicates,
  ])

  const expectedEntities = new Map<string, string>()
  for (const entity of flattenEntities(input.expected)) {
    expectedEntities.set(normalizeEntityName(entity.name), entity.kind)
  }
  const actualEntities = new Map<string, string>()
  for (const entity of flattenEntities(input.actual)) {
    const key = normalizeEntityName(entity.name)
    if (!actualEntities.has(key)) actualEntities.set(key, entity.kind)
  }

  const expectedFacts = new Set(flattenFacts(input.expected).map(factKey))
  const actualFacts = flattenFacts(input.actual)

  const counts = emptyProfileMetricCounts()
  counts.expectedEntities = expectedEntities.size
  for (const [name, expectedKind] of expectedEntities) {
    if (actualEntities.get(name) === expectedKind) counts.correctEntityKinds += 1
  }

  for (const fact of actualFacts) {
    const validPredicate = predicateVocabulary.has(fact.predicate)
    if (validPredicate) {
      counts.predictedWritableFacts += 1
      if (expectedFacts.has(factKey(fact))) counts.correctWritableFacts += 1
    }
    counts.actualFacts += 1
    if (!expectedFacts.has(factKey(fact))) counts.hallucinatedFacts += 1
  }

  for (const memory of input.actual.memories) {
    recordRequired(counts, memory.title)
    recordRequired(counts, memory.synopsis)
    recordRequired(counts, memory.content)
    counts.requiredFields += 1
    if (memory.tags.length > 0 && memory.tags.every((tag) => tagVocabulary.has(tag))) {
      counts.completeRequiredFields += 1
    }
    for (const tag of memory.tags) {
      counts.taxonomyValues += 1
      if (!tagVocabulary.has(tag)) counts.invalidTaxonomyValues += 1
    }
    for (const entity of memory.entities) {
      recordRequired(counts, entity.name)
      recordRequired(counts, entity.kind)
      counts.taxonomyValues += 1
      if (!entityKindVocabulary.has(entity.kind)) counts.invalidTaxonomyValues += 1
    }
    for (const fact of memory.facts) {
      recordRequired(counts, fact.subject)
      recordRequired(counts, fact.predicate)
      recordRequired(counts, fact.object)
      recordRequired(counts, fact.evidence ?? "")
      counts.taxonomyValues += 1
      if (!predicateVocabulary.has(fact.predicate)) counts.invalidTaxonomyValues += 1
    }
  }

  return profileMetricsFromCounts(counts)
}

export function collectProfileThresholdFailures(
  metrics: ProfileMetricBreakdown,
  thresholds: ProfileMetricThresholds
): string[] {
  const failures: string[] = []
  if (metrics.entityKindRecall < thresholds.entityKindRecallMin) {
    failures.push(
      `Entity-kind recall ${formatMetric(metrics.entityKindRecall)} is below ${formatMetric(thresholds.entityKindRecallMin)}.`
    )
  }
  if (metrics.predicatePrecision < thresholds.predicatePrecisionMin) {
    failures.push(
      `Predicate precision ${formatMetric(metrics.predicatePrecision)} is below ${formatMetric(thresholds.predicatePrecisionMin)}.`
    )
  }
  if (metrics.hallucinatedFactRate > thresholds.hallucinatedFactRateMax) {
    failures.push(
      `Hallucinated-fact rate ${formatMetric(metrics.hallucinatedFactRate)} exceeds ${formatMetric(thresholds.hallucinatedFactRateMax)}.`
    )
  }
  if (
    metrics.requiredFieldCompleteness <
    thresholds.requiredFieldCompletenessMin
  ) {
    failures.push(
      `Required-field completeness ${formatMetric(metrics.requiredFieldCompleteness)} is below ${formatMetric(thresholds.requiredFieldCompletenessMin)}.`
    )
  }
  if (metrics.invalidTaxonomyRate > thresholds.invalidTaxonomyRateMax) {
    failures.push(
      `Invalid-taxonomy rate ${formatMetric(metrics.invalidTaxonomyRate)} exceeds ${formatMetric(thresholds.invalidTaxonomyRateMax)}.`
    )
  }
  return failures
}

function flattenEntities(output: ProfileExtractionOutput): ProfileExtractionEntity[] {
  return output.memories.flatMap((memory) => memory.entities)
}

function flattenFacts(output: ProfileExtractionOutput): ProfileExtractionFact[] {
  return output.memories.flatMap((memory) => memory.facts)
}

function factKey(fact: ProfileExtractionFact): string {
  return [
    normalizeFactPart(fact.subject),
    normalizeFactPart(fact.predicate),
    normalizeFactPart(fact.object),
  ].join("\0")
}

function normalizeEntityName(value: string): string {
  return normalizeFactPart(value)
}

function normalizeFactPart(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase()
}

function recordRequired(counts: ProfileMetricCounts, value: string): void {
  counts.requiredFields += 1
  if (value.trim().length > 0) counts.completeRequiredFields += 1
}

function ratioOrPerfect(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : numerator / denominator
}

function ratioOrZero(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : numerator / denominator
}

function formatMetric(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(4)
}
