import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  ProfileInstallError,
  applyInstall,
  checkInstallCollision,
  checkInstallShadowing,
  findAllowedInstallSourceMatch,
  findLockNoOpReinstall,
  parseInstallSource,
  previewInstall,
  profilesLockPath,
  readProfilesLock,
} from "./install.js"
import { loadProfileFromRoot } from "./index.js"

function makeBundle(dir: string, files: Record<string, string>): void {
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

describe("parseInstallSource", () => {
  it("recognizes git URLs pinned to a 40-hex commit", () => {
    const result = parseInstallSource(
      "git@github.com:org/repo.git#0123456789abcdef0123456789abcdef01234567",
      process.cwd()
    )
    expect(result).toEqual({
      kind: "git",
      url: "git@github.com:org/repo.git",
      commit: "0123456789abcdef0123456789abcdef01234567",
    })
  })

  it("rejects git URLs without a commit pin", () => {
    expect(() =>
      parseInstallSource("git@github.com:org/repo.git", process.cwd())
    ).toThrow(/pin an exact commit SHA/)
  })

  it("rejects git URLs with a branch instead of a commit", () => {
    expect(() =>
      parseInstallSource("git@github.com:org/repo.git#main", process.cwd())
    ).toThrow(/40-character lowercase hex SHA/)
  })

  it("treats non-git strings as a path", () => {
    const result = parseInstallSource("/tmp/profile", process.cwd())
    expect(result).toEqual({ kind: "path", path: "/tmp/profile" })
  })

  it("rejects empty strings", () => {
    expect(() => parseInstallSource("   ", process.cwd())).toThrow(
      /cannot be empty/
    )
  })
})

describe("previewInstall + applyInstall (local path)", () => {
  let workDir: string
  let configRoot: string
  let bundleDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "lore-install-"))
    configRoot = join(workDir, "vault")
    mkdirSync(configRoot, { recursive: true })
    bundleDir = join(workDir, "bundle")
    mkdirSync(bundleDir, { recursive: true })
    makeBundle(bundleDir, minimalProfileFiles("custom"))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it("installs into .lore/profiles/installed/<name>/<version>/ and writes the lock file", () => {
    const preview = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    expect(preview.profile.name).toBe("custom")
    expect(preview.profile.version).toBe("1.0.0")
    expect(preview.collision.kind).toBe("none")
    expect(preview.shadowing.kind).toBe("none")

    const result = applyInstall(preview, configRoot)
    expect(result.outcome).toBe("installed")
    expect(result.installTarget).toBe(
      resolve(configRoot, ".lore", "profiles", "installed", "custom", "1.0.0")
    )
    const installed = loadProfileFromRoot(result.installTarget, {
      source: "external",
    })
    expect(installed.manifestDigest).toBe(preview.manifestDigest)
    const lock = readProfilesLock(configRoot)
    expect(lock.profiles["custom@1.0.0"]?.manifestDigest).toBe(
      preview.manifestDigest
    )
    expect(lock.profiles["custom@1.0.0"]?.source).toEqual({
      kind: "path",
      path: bundleDir,
    })
  })

  it("treats a same-digest reinstall as a no-op", () => {
    const first = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    applyInstall(first, configRoot)

    const second = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    expect(second.collision.kind).toBe("same-digest")
    const result = applyInstall(second, configRoot)
    expect(result.outcome).toBe("already-installed")
  })

  it("refuses to overwrite a different-digest install", () => {
    const first = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    applyInstall(first, configRoot)

    // Change the bundle content to alter the digest.
    writeFileSync(
      join(bundleDir, "taxonomy.yaml"),
      `tags:\n  - beta\nentityKinds:\n  - component\nwritableFactPredicates:\n  - owns\n`
    )
    expect(() =>
      previewInstall({
        configRoot,
        source: { kind: "path", path: bundleDir },
      })
    ).toThrow(/different manifest digest/)
  })

  it("fails when the local source path is not a bundle root", () => {
    expect(() =>
      previewInstall({
        configRoot,
        source: { kind: "path", path: workDir },
      })
    ).toThrow(/profile.yaml/)
  })

  it("rejects symlinked migration YAML before digesting or copying", () => {
    const externalMigration = join(workDir, "mutable-migration.yaml")
    writeFileSync(
      externalMigration,
      "profile: custom\nfrom: 1.0.0\nto: 1.1.0\nsteps: []\n"
    )
    mkdirSync(join(bundleDir, "migrations"))
    symlinkSync(
      externalMigration,
      join(bundleDir, "migrations", "1.0.0__1.1.0.yaml")
    )

    expect(() =>
      previewInstall({
        configRoot,
        source: { kind: "path", path: bundleDir },
      })
    ).toThrow(/contains symlink migrations\/1\.0\.0__1\.1\.0\.yaml/)
    expect(
      existsSync(
        join(configRoot, ".lore", "profiles", "installed", "custom", "1.0.0")
      )
    ).toBe(false)
  })

  it("installs the staged snapshot when local source mutates after preview", () => {
    const migrationPath = join(bundleDir, "migrations", "1.0.0__1.1.0.yaml")
    const approvedMigration =
      "profile: custom\nfrom: 1.0.0\nto: 1.1.0\nsteps: []\n"
    makeBundle(bundleDir, {
      "migrations/1.0.0__1.1.0.yaml": approvedMigration,
    })
    const preview = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    const approvedDigest = preview.manifestDigest

    const externalMigration = join(workDir, "mutable-after-preview.yaml")
    writeFileSync(
      externalMigration,
      "profile: custom\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: pin\n    kind: write_config_profile_pin\n    selector: custom@1.1.0\n"
    )
    rmSync(migrationPath)
    symlinkSync(externalMigration, migrationPath)

    const result = applyInstall(preview, configRoot)
    const installedMigrationPath = join(
      result.installTarget,
      "migrations",
      "1.0.0__1.1.0.yaml"
    )
    expect(lstatSync(installedMigrationPath).isSymbolicLink()).toBe(false)
    expect(readFileSync(installedMigrationPath, "utf-8")).toBe(approvedMigration)
    const installed = loadProfileFromRoot(result.installTarget, {
      source: "external",
    })
    expect(installed.manifestDigest).toBe(approvedDigest)
    const lock = readProfilesLock(configRoot)
    expect(lock.profiles["custom@1.0.0"]?.manifestDigest).toBe(approvedDigest)
  })
})

describe("previewInstall + applyInstall (pinned git source)", () => {
  let workDir: string
  let configRoot: string
  let repoDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "lore-install-git-"))
    configRoot = join(workDir, "vault")
    repoDir = join(workDir, "profile.git")
    mkdirSync(configRoot, { recursive: true })
    mkdirSync(repoDir, { recursive: true })
    makeBundle(repoDir, minimalProfileFiles("git-profile"))
    execFileSync("git", ["init", "--quiet"], { cwd: repoDir })
    execFileSync("git", ["add", "."], { cwd: repoDir })
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Lore Test",
        "-c",
        "user.email=lore-test@example.com",
        "commit",
        "--quiet",
        "-m",
        "add profile",
      ],
      { cwd: repoDir }
    )
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it("fetches an exact commit-pinned git URL and installs the repo root bundle", () => {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf-8",
    }).trim()
    const source = parseInstallSource(`file://${repoDir}#${commit}`, process.cwd())
    expect(source).toEqual({
      kind: "git",
      url: `file://${repoDir}`,
      commit,
    })

    const preview = previewInstall({ configRoot, source })
    expect(preview.source.kind).toBe("git")
    expect(preview.profile.selector).toBe("git-profile@1.0.0")

    const result = applyInstall(preview, configRoot)
    expect(result.outcome).toBe("installed")
    const lock = readProfilesLock(configRoot)
    expect(lock.profiles["git-profile@1.0.0"]?.source).toEqual({
      kind: "git",
      url: `file://${repoDir}`,
      commit,
    })
  })
})

describe("checkInstallShadowing", () => {
  let workDir: string
  let configRoot: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "lore-shadow-"))
    configRoot = join(workDir, "vault")
    mkdirSync(configRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it("reports a local profile collision when one exists at the same selector", () => {
    const localDir = join(
      configRoot,
      ".lore",
      "profiles",
      "local",
      "custom",
      "1.0.0"
    )
    mkdirSync(localDir, { recursive: true })
    makeBundle(localDir, minimalProfileFiles("custom"))
    const profile = loadProfileFromRoot(localDir, { source: "local" })

    const shadow = checkInstallShadowing(
      configRoot,
      "custom",
      "1.0.0",
      profile.manifestDigest
    )
    expect(shadow.kind).toBe("local-shadow")
    if (shadow.kind === "local-shadow") {
      expect(shadow.sameDigest).toBe(true)
    }
  })

  it("reports a built-in collision when bundled default would shadow this install", () => {
    const shadow = checkInstallShadowing(
      configRoot,
      "default",
      "1.0.0",
      "sha256:0000000000000000000000000000000000000000000000000000000000000000"
    )
    expect(shadow.kind).toBe("built-in-shadow")
    if (shadow.kind === "built-in-shadow") {
      expect(shadow.sameDigest).toBe(false)
    }
  })
})

describe("checkInstallCollision", () => {
  let workDir: string
  let configRoot: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "lore-collision-"))
    configRoot = join(workDir, "vault")
    mkdirSync(configRoot, { recursive: true })
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it("returns none when the install target does not exist yet", () => {
    const target = join(
      configRoot,
      ".lore",
      "profiles",
      "installed",
      "custom",
      "1.0.0"
    )
    expect(
      checkInstallCollision(target, "sha256:" + "a".repeat(64)).kind
    ).toBe("none")
  })

  it("treats an existing non-bundle target as a fail-closed collision", () => {
    const target = join(
      configRoot,
      ".lore",
      "profiles",
      "installed",
      "custom",
      "1.0.0"
    )
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "README.md"), "not a profile bundle\n")

    expect(checkInstallCollision(target, "sha256:" + "a".repeat(64))).toEqual({
      kind: "different-digest",
      existingDigest: "<not-profile-bundle>",
    })
  })

  it("refuses to install into an existing non-bundle target", () => {
    const bundleDir = join(workDir, "bundle")
    mkdirSync(bundleDir, { recursive: true })
    makeBundle(bundleDir, minimalProfileFiles("custom"))
    const target = join(
      configRoot,
      ".lore",
      "profiles",
      "installed",
      "custom",
      "1.0.0"
    )
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, "README.md"), "not a profile bundle\n")

    expect(() =>
      previewInstall({
        configRoot,
        source: { kind: "path", path: bundleDir },
      })
    ).toThrow(/already exists with a different manifest digest/)
  })
})

describe("findAllowedInstallSourceMatch", () => {
  let workDir: string
  let configRoot: string
  let bundleDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "lore-allow-"))
    configRoot = join(workDir, "vault")
    mkdirSync(configRoot, { recursive: true })
    bundleDir = join(workDir, "bundle")
    mkdirSync(bundleDir, { recursive: true })
    makeBundle(bundleDir, minimalProfileFiles("custom"))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it("returns the matching entry when path + digest agree", () => {
    const preview = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    try {
      const entry = findAllowedInstallSourceMatch(
        preview,
        [
          {
            kind: "path",
            path: bundleDir,
            manifestDigest: preview.manifestDigest,
          },
        ],
        configRoot
      )
      expect(entry?.kind).toBe("path")
    } finally {
      preview.cleanup()
    }
  })

  it("returns null when the digest changes", () => {
    const preview = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    try {
      const entry = findAllowedInstallSourceMatch(
        preview,
        [
          {
            kind: "path",
            path: bundleDir,
            manifestDigest: "sha256:" + "a".repeat(64),
          },
        ],
        configRoot
      )
      expect(entry).toBeNull()
    } finally {
      preview.cleanup()
    }
  })

  it("requires a new allow-list digest when only migration YAML changes", () => {
    makeBundle(bundleDir, {
      "migrations/1.0.0__1.1.0.yaml":
        "profile: custom\nfrom: 1.0.0\nto: 1.1.0\nsteps: []\n",
    })
    const first = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    const firstDigest = first.manifestDigest
    first.cleanup()

    writeFileSync(
      join(bundleDir, "migrations", "1.0.0__1.1.0.yaml"),
      "profile: custom\nfrom: 1.0.0\nto: 1.1.0\nsteps:\n  - id: pin\n    kind: write_config_profile_pin\n    selector: custom@1.1.0\n"
    )
    const second = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    try {
      expect(second.manifestDigest).not.toBe(firstDigest)
      expect(
        findAllowedInstallSourceMatch(
          second,
          [
            {
              kind: "path",
              path: bundleDir,
              manifestDigest: firstDigest,
            },
          ],
          configRoot
        )
      ).toBeNull()
      expect(
        findAllowedInstallSourceMatch(
          second,
          [
            {
              kind: "path",
              path: bundleDir,
              manifestDigest: second.manifestDigest,
            },
          ],
          configRoot
        )
      )?.toMatchObject({ kind: "path", manifestDigest: second.manifestDigest })
    } finally {
      second.cleanup()
    }
  })

  it("returns null when no entries are configured", () => {
    const preview = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    try {
      expect(findAllowedInstallSourceMatch(preview, undefined, configRoot)).toBeNull()
    } finally {
      preview.cleanup()
    }
  })
})

describe("findLockNoOpReinstall", () => {
  let workDir: string
  let configRoot: string
  let bundleDir: string

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "lore-lock-"))
    configRoot = join(workDir, "vault")
    mkdirSync(configRoot, { recursive: true })
    bundleDir = join(workDir, "bundle")
    mkdirSync(bundleDir, { recursive: true })
    makeBundle(bundleDir, minimalProfileFiles("custom"))
  })

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true })
  })

  it("returns the lock entry when source + digest + install target all match", () => {
    const first = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    applyInstall(first, configRoot)

    const second = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    try {
      expect(findLockNoOpReinstall(configRoot, second)).not.toBeNull()
    } finally {
      second.cleanup()
    }
  })

  it("returns null when no lock entry exists yet", () => {
    const preview = previewInstall({
      configRoot,
      source: { kind: "path", path: bundleDir },
    })
    try {
      expect(findLockNoOpReinstall(configRoot, preview)).toBeNull()
    } finally {
      preview.cleanup()
    }
  })
})

describe("readProfilesLock", () => {
  it("returns an empty lock when the file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-lock-read-"))
    try {
      expect(readProfilesLock(dir).profiles).toEqual({})
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("throws ProfileInstallError when the file is malformed", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-lock-bad-"))
    try {
      const path = profilesLockPath(dir)
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, "{ not json")
      expect(() => readProfilesLock(dir)).toThrow(ProfileInstallError)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
