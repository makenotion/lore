import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve as resolvePath } from "node:path"
import { describe, expect, it } from "vitest"
import {
  PROFILE_EXTENDS_RESERVED_MESSAGE,
  PROFILE_PROMPT_KEYS,
  defaultProfileSelector,
  loadProfileFromRoot,
  resolveProfileFromConfig,
} from "./index.js"
import { MEMORY_PROPS, memoriesProperties } from "../notion/schema.js"

function withProfileDir(files: Record<string, string>, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "lore-profile-"))
  try {
    for (const [rel, text] of Object.entries(files)) {
      const path = join(dir, rel)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
    }
    fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function minimalProfileFiles(name = "fixture"): Record<string, string> {
  return {
    "profile.yaml": `
name: ${name}
version: 1.0.0
taxonomy: taxonomy.yaml
schema: schema.yaml
`,
    "taxonomy.yaml": `
tags:
  - alpha
entityKinds:
  - component
writableFactPredicates:
  - owns
`,
    "schema.yaml": `
databases:
  projects:
    properties: {}
  topics:
    properties: {}
  memories:
    properties: {}
  entities:
    properties: {}
  facts:
    properties: {}
`,
  }
}

describe("profile loader", () => {
  it("loads the built-in default profile and selector", () => {
    const profile = resolveProfileFromConfig({})

    expect(profile.selector).toBe(defaultProfileSelector())
    expect(profile.name).toBe("default")
    expect(profile.version).toMatch(/^\d+\.\d+\.\d+/)
    expect(profile.manifestDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(profile.taxonomy.tags).toContain("architecture")
    expect(profile.prompts.longmemevalSimulatedAutosave.source).toBe("active-profile")
  })

  it("does not resolve the built-in default profile from the caller cwd", () => {
    const originalCwd = process.cwd()
    const dir = mkdtempSync(join(tmpdir(), "lore-profile-cwd-"))
    const shadowRoot = join(dir, "profiles", "default")
    const shadowPromptMappings = PROFILE_PROMPT_KEYS.map(
      (key) => `  ${key}: prompts/${key}.txt`
    ).join("\n")

    try {
      mkdirSync(join(shadowRoot, "prompts"), { recursive: true })
      writeFileSync(
        join(shadowRoot, "profile.yaml"),
        `
name: default
version: 1.0.0
taxonomy: taxonomy.yaml
schema: schema.yaml
prompts:
${shadowPromptMappings}
`
      )
      writeFileSync(
        join(shadowRoot, "taxonomy.yaml"),
        `
tags:
  - shadow-tag
entityKinds:
  - shadow-kind
writableFactPredicates:
  - shadow_predicate
`
      )
      writeFileSync(
        join(shadowRoot, "schema.yaml"),
        `
databases:
  projects:
    properties: {}
  topics:
    properties: {}
  memories:
    properties: {}
  entities:
    properties: {}
  facts:
    properties: {}
`
      )
      for (const key of PROFILE_PROMPT_KEYS) {
        writeFileSync(join(shadowRoot, "prompts", `${key}.txt`), "Shadow prompt.")
      }

      process.chdir(dir)
      const profile = resolveProfileFromConfig({ profile: "default@1.0.0" })

      expect(profile.rootDir).not.toBe(resolvePath(shadowRoot))
      expect(profile.source).toBe("built-in")
      expect(profile.taxonomy.tags).toContain("architecture")
      expect(profile.taxonomy.tags).not.toContain("shadow-tag")
      expect(profile.taxonomy.entityKinds).not.toContain("shadow-kind")
      expect(profile.taxonomy.writableFactPredicates).not.toContain("shadow_predicate")
    } finally {
      process.chdir(originalCwd)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects profile.yaml extends with the reserved composition message", () => {
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "profile.yaml": `
name: fixture
version: 1.0.0
extends: default@1.0.0
`,
      },
      (dir) => {
        expect(() => loadProfileFromRoot(dir)).toThrow(PROFILE_EXTENDS_RESERVED_MESSAGE)
      }
    )
  })

  it("rejects malformed selectors, bad semver, and unknown built-ins", () => {
    expect(() => resolveProfileFromConfig({ profile: "default" })).toThrow(
      /Expected exact <name>@<semver>/
    )
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "profile.yaml": `
name: fixture
version: banana
`,
      },
      (dir) => {
        expect(() => loadProfileFromRoot(dir)).toThrow(/version must be valid semver/)
      }
    )
    expect(() => resolveProfileFromConfig({ profile: "other@1.0.0" })).toThrow(
      /Unknown built-in profile/
    )
  })

  it("rejects out-of-scope memory kind declarations", () => {
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "profile.yaml": `
name: fixture
version: 1.0.0
taxonomy: taxonomy.yaml
schema: schema.yaml
memoryKinds:
  - sales-call
`,
      },
      (dir) => {
        expect(() => loadProfileFromRoot(dir)).toThrow(/cannot define memory kinds/)
      }
    )

    withProfileDir(
      {
        ...minimalProfileFiles(),
        "taxonomy.yaml": `
tags:
  - alpha
entityKinds:
  - component
writableFactPredicates:
  - owns
memoryKinds:
  - sales-call
`,
      },
      (dir) => {
        expect(() => loadProfileFromRoot(dir)).toThrow(/cannot define memory kinds/)
      }
    )
  })

  it("resolves a non-default built-in profile by exact selector", () => {
    const profile = resolveProfileFromConfig({ profile: "support@1.0.0" })

    expect(profile.selector).toBe("support@1.0.0")
    expect(profile.source).toBe("built-in")
    expect(profile.taxonomy.tags).toContain("customer-report")
    expect(profile.taxonomy.entityKinds).toContain("support-ticket")
    expect(profile.taxonomy.writableFactPredicates).toContain("reported_by")
    expect(profile.schema.memories["Support Severity"]).toEqual({
      select: {
        options: [
          { name: "sev1", color: "red" },
          { name: "sev2", color: "orange" },
          { name: "sev3", color: "yellow" },
          { name: "sev4", color: "blue" },
        ],
      },
    })
    expect(profile.prompts.autosaveExtractionFilter.source).toBe("active-profile")
    expect(profile.prompts.atomicLearningExtraction.source).toBe("core-default")
  })

  it("rejects an exact built-in selector whose version does not match the bundle", () => {
    expect(() => resolveProfileFromConfig({ profile: "support@9.9.9" })).toThrow(
      /does not match/
    )
  })

  it("keeps manifestDigest stable across YAML key order and changes on participating content", () => {
    const files = minimalProfileFiles("fixture")
    withProfileDir(files, (dir) => {
      const first = loadProfileFromRoot(dir).manifestDigest
      writeFileSync(
        join(dir, "profile.yaml"),
        `
schema: schema.yaml
taxonomy: taxonomy.yaml
version: 1.0.0
name: fixture
`
      )
      expect(loadProfileFromRoot(dir).manifestDigest).toBe(first)
      writeFileSync(
        join(dir, "taxonomy.yaml"),
        `
tags:
  - beta
entityKinds:
  - component
writableFactPredicates:
  - owns
`
      )
      expect(loadProfileFromRoot(dir).manifestDigest).not.toBe(first)
    })
  })

  it("loads declared eval suites and includes them in the manifest digest", () => {
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "profile.yaml": `
name: fixture
version: 1.0.0
taxonomy: taxonomy.yaml
schema: schema.yaml
evals:
  - evals/profile.yaml
`,
        "evals/profile.yaml": "suite: fixture\nprofile: fixture@1.0.0\ncases: []\n",
      },
      (dir) => {
        const profile = loadProfileFromRoot(dir)
        const first = profile.manifestDigest
        expect(profile.evalSuites).toEqual(["evals/profile.yaml"])

        writeFileSync(
          join(dir, "evals", "profile.yaml"),
          "suite: fixture\nprofile: fixture@1.0.0\ncases:\n  - id: changed\n"
        )
        expect(loadProfileFromRoot(dir).manifestDigest).not.toBe(first)
      }
    )
  })

  it("rejects declared eval suites that are missing", () => {
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "profile.yaml": `
name: fixture
version: 1.0.0
taxonomy: taxonomy.yaml
schema: schema.yaml
evals:
  - evals/missing.yaml
`,
      },
      (dir) => {
        expect(() => loadProfileFromRoot(dir)).toThrow(/Failed to read/)
      }
    )
  })

  it("rejects core-property overrides and unsupported additive schema types", () => {
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "schema.yaml": `
databases:
  memories:
    properties:
      ${MEMORY_PROPS.TITLE}:
        rich_text: {}
`,
      },
      (dir) => {
        expect(() => loadProfileFromRoot(dir)).toThrow(/cannot override a core property/)
      }
    )
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "schema.yaml": `
databases:
  memories:
    properties:
      Score Formula:
        formula: {}
`,
      },
      (dir) => {
        expect(() => loadProfileFromRoot(dir)).toThrow(/supported additive property type/)
      }
    )
  })

  it("rejects unsupported schema file structure", () => {
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "schema.yaml": `
databases:
  memories:
    properties: {}
memoryKinds:
  - decision
`,
      },
      (dir) => {
        expect(() => loadProfileFromRoot(dir)).toThrow(/unsupported schema field "memoryKinds"/)
      }
    )
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "schema.yaml": `
databases:
  memores:
    properties: {}
`,
      },
      (dir) => {
        expect(() => loadProfileFromRoot(dir)).toThrow(/unsupported schema database field "memores"/)
      }
    )
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "schema.yaml": `
databases:
  memories:
    propreties: {}
`,
      },
      (dir) => {
        expect(() => loadProfileFromRoot(dir)).toThrow(/unsupported schema database field "propreties"/)
      }
    )
  })

  it("falls back missing profile prompt keys to the default registry", () => {
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "profile.yaml": `
name: fixture
version: 1.0.0
taxonomy: taxonomy.yaml
schema: schema.yaml
prompts:
  autosaveExtractionFilter: prompts/filter.txt
`,
        "prompts/filter.txt": "Custom autosave filter.",
      },
      (dir) => {
        const profile = loadProfileFromRoot(dir)
        expect(profile.prompts.autosaveExtractionFilter.source).toBe("active-profile")
        expect(profile.prompts.digestSynthesis.source).toBe("core-default")
        expect(profile.prompts.digestSynthesis.text).toContain("project digest")
      }
    )
  })

  it("rejects unsupported prompt template variables", () => {
    withProfileDir(
      {
        ...minimalProfileFiles(),
        "profile.yaml": `
name: fixture
version: 1.0.0
taxonomy: taxonomy.yaml
schema: schema.yaml
prompts:
  autosaveExtractionFilter: prompts/filter.txt
`,
        "prompts/filter.txt": "Bad {{unknown}} variable.",
      },
      (dir) => {
        expect(() => loadProfileFromRoot(dir)).toThrow(/unsupported variable/)
      }
    )
  })

  it("keeps two resolved profile fixtures isolated in one process", () => {
    withProfileDir(minimalProfileFiles("alpha-profile"), (alphaDir) => {
      withProfileDir(
        {
          ...minimalProfileFiles("beta-profile"),
          "taxonomy.yaml": `
tags:
  - beta
entityKinds:
  - service
writableFactPredicates:
  - manages
`,
        },
        (betaDir) => {
          const alpha = loadProfileFromRoot(alphaDir)
          const beta = loadProfileFromRoot(betaDir)
          const alphaTags = (
            memoriesProperties("p", "t", "m", alpha)[MEMORY_PROPS.TAGS].multi_select as {
              options: Array<{ name: string }>
            }
          ).options.map((option) => option.name)
          const betaTags = (
            memoriesProperties("p", "t", "m", beta)[MEMORY_PROPS.TAGS].multi_select as {
              options: Array<{ name: string }>
            }
          ).options.map((option) => option.name)

          expect(alphaTags).toEqual(["alpha"])
          expect(betaTags).toEqual(["beta"])
        }
      )
    })
  })
})
