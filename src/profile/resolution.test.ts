import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  discoverProfiles,
  parseProfileSelector,
  resolveProfileFromConfigAtRoot,
  resolveProfileSelector,
} from "./index.js"

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
    "taxonomy.yaml": `tags:\n  - tag-${name}\nentityKinds:\n  - component\nwritableFactPredicates:\n  - owns\n`,
    "schema.yaml": `databases:\n  projects:\n    properties: {}\n  topics:\n    properties: {}\n  memories:\n    properties: {}\n  entities:\n    properties: {}\n  facts:\n    properties: {}\n`,
  }
}

describe("Phase 3 profile resolution priority", () => {
  let workDir: string
  let configRoot: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "lore-resolve-"))
    configRoot = join(workDir, "vault")
    mkdirSync(configRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it("falls back to built-in when no local or installed bundle exists", () => {
    const profile = resolveProfileFromConfigAtRoot(
      { profile: "default@1.0.0" },
      configRoot
    )
    expect(profile.source).toBe("built-in")
    expect(profile.name).toBe("default")
  })

  it("prefers a local profile over the built-in version", () => {
    const localDir = join(configRoot, ".lore", "profiles", "local", "default", "1.0.0")
    writeFiles(localDir, minimalProfileFiles("default"))

    const profile = resolveProfileFromConfigAtRoot(
      { profile: "default@1.0.0" },
      configRoot
    )
    expect(profile.source).toBe("local")
    expect(profile.rootDir.endsWith("local/default/1.0.0")).toBe(true)
  })

  it("falls through to installed external when no built-in matches and no local override exists", () => {
    const installedDir = join(
      configRoot,
      ".lore",
      "profiles",
      "installed",
      "custom",
      "1.0.0"
    )
    writeFiles(installedDir, minimalProfileFiles("custom"))

    const profile = resolveProfileFromConfigAtRoot(
      { profile: "custom@1.0.0" },
      configRoot
    )
    expect(profile.source).toBe("external")
    expect(profile.name).toBe("custom")
  })

  it("throws when the selector resolves nowhere", () => {
    expect(() =>
      resolveProfileFromConfigAtRoot({ profile: "ghost@9.9.9" }, configRoot)
    ).toThrow(/Profile not found/)
  })

  it("never resolves an installed-external bundle when the built-in already wins", () => {
    const installedDir = join(
      configRoot,
      ".lore",
      "profiles",
      "installed",
      "default",
      "1.0.0"
    )
    writeFiles(installedDir, minimalProfileFiles("default"))

    const profile = resolveProfileFromConfigAtRoot(
      { profile: "default@1.0.0" },
      configRoot
    )
    expect(profile.source).toBe("built-in")
  })
})

describe("resolveProfileSelector", () => {
  it("returns null when nothing matches", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-resolve-"))
    try {
      const parsed = parseProfileSelector("ghost@9.9.9")
      expect(resolveProfileSelector(parsed, dir)).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("discoverProfiles", () => {
  it("includes built-in profiles and any installed/local overrides", () => {
    const workDir = mkdtempSync(join(tmpdir(), "lore-resolve-"))
    const configRoot = join(workDir, "vault")
    mkdirSync(configRoot, { recursive: true })
    try {
      const installedDir = join(
        configRoot,
        ".lore",
        "profiles",
        "installed",
        "custom",
        "1.0.0"
      )
      writeFiles(installedDir, minimalProfileFiles("custom"))
      const discoveries = discoverProfiles(configRoot)
      const names = discoveries.map((d) => `${d.source}:${d.name}@${d.version}`)
      expect(names).toContain("external:custom@1.0.0")
      expect(names.some((n) => n.startsWith("built-in:default@"))).toBe(true)
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  })
})
