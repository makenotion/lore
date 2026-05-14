import { describe, expect, it } from "vitest"
import { resolveFeatureFlags } from "./feature-flags.js"

describe("resolveFeatureFlags", () => {
  it("defines the default runtime taxonomy", () => {
    expect(resolveFeatureFlags({})).toEqual({
      nearDuplicateProbe: true,
      autosaveLearningDedup: true,
      autoMentions: true,
      taskReuse: true,
      taskCrossref: true,
      learningExtraction: true,
      confidenceFactor: true,
      forceSemanticSearch: false,
      runTool: {
        enabled: true,
        blockEdit: true,
        filterSql: true,
        search: true,
        aggregate: true,
        batchCreates: false,
      },
    })
  })

  it("uses .lore.yaml features when env does not override them", () => {
    expect(
      resolveFeatureFlags(
        {},
        {
          features: {
            nearDuplicateProbe: false,
            autoMentions: false,
            forceSemanticSearch: true,
            runTool: {
              enabled: false,
              search: true,
              batchCreates: true,
            },
          },
        }
      )
    ).toMatchObject({
      nearDuplicateProbe: false,
      autoMentions: false,
      forceSemanticSearch: true,
      runTool: {
        enabled: false,
        blockEdit: false,
        filterSql: false,
        search: true,
        aggregate: false,
        batchCreates: true,
      },
    })
  })

  it("lets rollback kill-switch env vars force config-enabled features off", () => {
    const flags = resolveFeatureFlags(
      {
        LORE_DISABLE_AUTO_MENTIONS: "1",
        LORE_DISABLE_NEAR_DUPLICATE_PROBE: "1",
        LORE_DISABLE_LEARNING_EXTRACTION: "1",
        LORE_FORCE_SEMANTIC_SEARCH: "1",
      },
      {
        features: {
          autoMentions: true,
          nearDuplicateProbe: true,
          learningExtraction: true,
          forceSemanticSearch: false,
        },
      }
    )

    expect(flags.autoMentions).toBe(false)
    expect(flags.nearDuplicateProbe).toBe(false)
    expect(flags.learningExtraction).toBe(false)
    expect(flags.forceSemanticSearch).toBe(true)
  })

  it("preserves RunTool parent inheritance and explicit sub-flag overrides", () => {
    const flags = resolveFeatureFlags(
      {
        LORE_USE_RUNTOOL: "0",
        LORE_USE_RUNTOOL_SEARCH: "1",
        LORE_USE_RUNTOOL_AGGREGATE: "0",
      },
      {
        features: {
          runTool: {
            enabled: true,
            filterSql: true,
            aggregate: true,
          },
        },
      }
    )

    expect(flags.runTool).toMatchObject({
      enabled: false,
      blockEdit: false,
      filterSql: false,
      search: true,
      aggregate: false,
    })
  })

  it("keeps RunTool batch creates strict for env while allowing config opt-in", () => {
    expect(
      resolveFeatureFlags(
        { LORE_USE_RUNTOOL_BATCH_CREATES: "true" },
        { features: { runTool: { batchCreates: true } } }
      ).runTool.batchCreates
    ).toBe(false)

    expect(
      resolveFeatureFlags({}, { features: { runTool: { batchCreates: true } } }).runTool
        .batchCreates
    ).toBe(true)
  })
})
