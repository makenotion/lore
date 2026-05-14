import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
  PROFILE_MIGRATION_STEP_KINDS,
  ProfileMigrationError,
  REJECTED_PROFILE_MIGRATION_STEP_KINDS,
  applyMigrationPlan,
  buildMigrationPlan,
  digestMigrationFile,
  findMigrationFile,
  ledgerPath,
  parseMigrationFile,
  rewriteConfigProfilePin,
  type ProfileMigrationPlan,
  validateProfileBundle,
} from "./migrate.js"
import type { LoreServices } from "../services.js"

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(dir, rel)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
}

function minimalProfileFiles(name: string, version = "1.0.0"): Record<string, string> {
  return {
    "profile.yaml": `name: ${name}\nversion: ${version}\ntaxonomy: taxonomy.yaml\nschema: schema.yaml\n`,
    "taxonomy.yaml": `tags:\n  - alpha\nentityKinds:\n  - component\nwritableFactPredicates:\n  - owns\n`,
    "schema.yaml": `databases:\n  projects:\n    properties: {}\n  topics:\n    properties: {}\n  memories:\n    properties: {}\n  entities:\n    properties: {}\n  facts:\n    properties: {}\n`,
  }
}

function minimalServices(
  configRoot: string,
  client: unknown = {
    dataSources: { retrieve: vi.fn(), query: vi.fn(), update: vi.fn() },
    pages: { update: vi.fn() },
  }
): LoreServices {
  return {
    configRoot,
    config: { vault: { pageId: "vault-page-id" } },
    vault: {
      databases: {
        projects: { dataSourceId: "ds-projects" },
        topics: { dataSourceId: "ds-topics" },
        memories: { dataSourceId: "ds-memories" },
        entities: { dataSourceId: "ds-entities" },
        facts: { dataSourceId: "ds-facts" },
      },
    },
    client,
  } as unknown as LoreServices
}

describe("parseMigrationFile", () => {
  it("parses every supported step kind", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: add-prop\n    kind: add_property\n    database: entities\n    property: Account Tier\n    config:\n      select:\n        options: []\n  - id: add-opts\n    kind: add_select_options\n    database: entities\n    property: Account Tier\n    options:\n      - name: strategic\n  - id: pin\n    kind: write_config_profile_pin\n    selector: sales@1.1.0\n  - id: backfill\n    kind: backfill_empty_property\n    database: entities\n    property: Account Tier\n    value:\n      type: select\n      select:\n        name: commercial\n    filter:\n      property: Account Tier\n      select:\n        is_empty: true\n    limit: 100\n`
      )
      const doc = parseMigrationFile(path)
      expect(doc.profile).toBe("sales")
      expect(doc.from).toBe("1.0.0")
      expect(doc.to).toBe("1.1.0")
      expect(doc.steps).toHaveLength(4)
      expect(doc.steps.map((s) => s.kind)).toEqual([
        "add_property",
        "add_select_options",
        "write_config_profile_pin",
        "backfill_empty_property",
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects destructive step kinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      for (const kind of REJECTED_PROFILE_MIGRATION_STEP_KINDS) {
        const path = join(dir, `${kind}.yaml`)
        writeFileSync(
          path,
          `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: bad\n    kind: ${kind}\n    database: memories\n    property: Notes\n`
        )
        expect(() => parseMigrationFile(path)).toThrow(/rejected in Phase 3/)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects unknown step kinds", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: bad\n    kind: invent_a_step\n    database: memories\n`
      )
      expect(() => parseMigrationFile(path)).toThrow(/not a supported Phase 3 step kind/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects backfill steps without an empty/unset filter for the target property", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: backfill\n    kind: backfill_empty_property\n    database: entities\n    property: Account Tier\n    value:\n      type: select\n      select:\n        name: commercial\n    filter:\n      property: Some Other Column\n      select:\n        is_empty: true\n    limit: 100\n`
      )
      expect(() => parseMigrationFile(path)).toThrow(/empty\/unset check/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects does_not_contain as the backfill empty-cell guard", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: backfill\n    kind: backfill_empty_property\n    database: entities\n    property: Notes\n    value:\n      type: rich_text\n      rich_text:\n        - text:\n            content: seeded\n    filter:\n      property: Notes\n      rich_text:\n        does_not_contain: "seeded"\n    limit: 100\n`
      )
      expect(() => parseMigrationFile(path)).toThrow(/empty\/unset check/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects backfill steps whose limit exceeds the cap", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: backfill\n    kind: backfill_empty_property\n    database: entities\n    property: Account Tier\n    value:\n      type: select\n      select:\n        name: commercial\n    filter:\n      property: Account Tier\n      select:\n        is_empty: true\n    limit: 5000\n`
      )
      expect(() => parseMigrationFile(path)).toThrow(/exceeds the Phase 3 cap/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects add_property steps that target a core memories property", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: bad\n    kind: add_property\n    database: memories\n    property: Status\n    config:\n      rich_text: {}\n`
      )
      expect(() => parseMigrationFile(path)).toThrow(/core property/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects option appends to non-taxonomy core properties", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: bad\n    kind: add_select_options\n    database: memories\n    property: Status\n    options:\n      - name: custom\n`
      )
      expect(() => parseMigrationFile(path)).toThrow(/profile-owned core taxonomy/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects reserved fact predicates in option append migrations", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: bad\n    kind: add_select_options\n    database: facts\n    property: Predicate\n    options:\n      - name: mentions\n`
      )
      expect(() => parseMigrationFile(path)).toThrow(/reserved\/internal/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("allows option appends to profile-owned core taxonomy columns", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: add-tag\n    kind: add_multi_select_options\n    database: memories\n    property: Tags\n    options:\n      - name: sales\n  - id: add-kind\n    kind: add_select_options\n    database: entities\n    property: Kind\n    options:\n      - name: account\n  - id: add-predicate\n    kind: add_select_options\n    database: facts\n    property: Predicate\n    options:\n      - name: owns\n`
      )
      const doc = parseMigrationFile(path)
      expect(doc.steps).toHaveLength(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects backfills that target core properties", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: bad\n    kind: backfill_empty_property\n    database: memories\n    property: Status\n    value:\n      type: select\n      select:\n        name: active\n    filter:\n      property: Status\n      select:\n        is_empty: true\n    limit: 100\n`
      )
      expect(() => parseMigrationFile(path)).toThrow(/cannot backfill core columns/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects add_property steps that use an unsupported additive type", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: bad\n    kind: add_property\n    database: memories\n    property: Owner\n    config:\n      relation:\n        single_property: {}\n`
      )
      expect(() => parseMigrationFile(path)).toThrow(/not an additive property type/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects steps whose id collides with another in the same migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: same\n    kind: add_select_options\n    database: entities\n    property: Tags\n    options:\n      - name: foo\n  - id: same\n    kind: add_select_options\n    database: entities\n    property: Tags\n    options:\n      - name: bar\n`
      )
      expect(() => parseMigrationFile(path)).toThrow(/is duplicated/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects steps that explicitly set destructive: true", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(
        path,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: bad\n    kind: add_property\n    database: memories\n    property: Owner\n    destructive: true\n    config:\n      rich_text: {}\n`
      )
      expect(() => parseMigrationFile(path)).toThrow(/destructive/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("PROFILE_MIGRATION_STEP_KINDS", () => {
  it("matches the contract list verbatim", () => {
    expect([...PROFILE_MIGRATION_STEP_KINDS]).toEqual([
      "add_property",
      "add_select_options",
      "add_multi_select_options",
      "write_config_profile_pin",
      "backfill_empty_property",
    ])
  })
})

describe("findMigrationFile", () => {
  it("throws when the migration file is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      expect(() => findMigrationFile(dir, "1.0.0", "1.1.0")).toThrow(
        ProfileMigrationError
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("buildMigrationPlan", () => {
  function writeSourceProfileWithPinMigration(configRoot: string): void {
    const sourceDir = join(configRoot, ".lore", "profiles", "local", "sales", "1.0.0")
    writeFiles(sourceDir, {
      ...minimalProfileFiles("sales", "1.0.0"),
      "migrations/1.0.0__1.1.0.yaml":
        "profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: pin\n    kind: write_config_profile_pin\n    selector: sales@1.1.0\n",
    })
  }

  it("rejects a config-pin migration when the target profile is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      writeSourceProfileWithPinMigration(dir)

      await expect(
        buildMigrationPlan({
          services: minimalServices(dir),
          sourceSelector: "sales@1.0.0",
          targetSelector: "sales@1.1.0",
          checkLive: false,
        })
      ).rejects.toThrow(/Target profile not resolvable for config pin/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects a config-pin migration when the target profile cannot load", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      writeSourceProfileWithPinMigration(dir)
      const targetDir = join(dir, ".lore", "profiles", "installed", "sales", "1.1.0")
      writeFiles(targetDir, minimalProfileFiles("support", "1.1.0"))

      await expect(
        buildMigrationPlan({
          services: minimalServices(dir),
          sourceSelector: "sales@1.0.0",
          targetSelector: "sales@1.1.0",
          checkLive: false,
        })
      ).rejects.toThrow(/Target profile not loadable for config pin/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("rewriteConfigProfilePin", () => {
  it("replaces an existing profile: line in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, ".lore.yaml")
      writeFileSync(path, 'vault:\n  pageId: "abc"\nprofile: default@1.0.0\n')
      rewriteConfigProfilePin(path, "sales@1.1.0")
      expect(readFileSync(path, "utf-8")).toContain("profile: sales@1.1.0")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("appends profile: when the file lacks one", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, ".lore.yaml")
      writeFileSync(path, 'vault:\n  pageId: "abc"\n')
      rewriteConfigProfilePin(path, "sales@1.1.0")
      expect(readFileSync(path, "utf-8")).toContain("profile: sales@1.1.0")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("ledgerPath", () => {
  it("incorporates the vault page sha12 and profile name segments", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = ledgerPath(
        dir,
        { profile: "support", from: "1.0.0", to: "1.1.0", steps: [] },
        "vault-page-id"
      )
      expect(path).toContain(".lore/profile-migrations/support/")
      expect(path).toMatch(/1\.0\.0__1\.1\.0\.[0-9a-f]{12}\.json$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("digestMigrationFile", () => {
  it("produces a sha256 digest over the file bytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const path = join(dir, "migration.yaml")
      writeFileSync(path, "profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps: []\n")
      expect(digestMigrationFile(path)).toMatch(/^sha256:[a-f0-9]{64}$/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("applyMigrationPlan", () => {
  it("caps backfill scans by row limit even when matched rows are non-empty", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      const migrationPath = join(dir, "migration.yaml")
      writeFileSync(
        migrationPath,
        `profile: sales\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: backfill\n    kind: backfill_empty_property\n    database: entities\n    property: Account Tier\n    value:\n      type: select\n      select:\n        name: commercial\n    filter:\n      property: Account Tier\n      select:\n        is_empty: true\n    limit: 2\n`
      )
      const document = parseMigrationFile(migrationPath)
      const query = vi.fn(async () => ({
        results: [
          {
            id: "row-1",
            properties: {
              "Account Tier": { type: "select", select: { name: "strategic" } },
            },
          },
          {
            id: "row-2",
            properties: {
              "Account Tier": { type: "select", select: { name: "commercial" } },
            },
          },
        ],
        has_more: true,
        next_cursor: "next-page",
      }))
      const update = vi.fn()
      const plan: ProfileMigrationPlan = {
        document,
        migrationPath,
        ledgerPath: join(dir, "ledger.json"),
        sourceSelector: "sales@1.0.0",
        targetSelector: "sales@1.1.0",
        sourceRoot: join(dir, "source"),
        targetRoot: join(dir, "target"),
        entries: document.steps.map((step) => ({
          step,
          status: "would-run",
          estimatedWrites: 2,
        })),
      }

      await applyMigrationPlan(
        minimalServices(dir, {
          dataSources: { query },
          pages: { update },
        }),
        plan,
        { configPath: join(dir, ".lore.yaml") }
      )

      expect(query).toHaveBeenCalledTimes(1)
      expect(query).toHaveBeenCalledWith(expect.objectContaining({ page_size: 2 }))
      expect(update).not.toHaveBeenCalled()
      expect(readFileSync(plan.ledgerPath, "utf-8")).toContain("Backfilled 0 row(s)")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("validateProfileBundle", () => {
  it("loads a valid bundle and rejects an invalid one", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      writeFiles(dir, minimalProfileFiles("custom"))
      const profile = validateProfileBundle(dir)
      expect(profile.name).toBe("custom")

      // Now break it.
      writeFileSync(join(dir, "profile.yaml"), "name: custom\nversion: not-semver\n")
      expect(() => validateProfileBundle(dir)).toThrow(/semver/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects bundles that use the reserved `extends` field", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-mig-"))
    try {
      writeFiles(dir, minimalProfileFiles("custom"))
      writeFileSync(
        join(dir, "profile.yaml"),
        "name: custom\nversion: 1.0.0\nextends: base@1.0.0\n"
      )
      expect(() => validateProfileBundle(dir)).toThrow(/extends/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
