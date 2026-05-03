import { afterEach, describe, expect, it, vi } from "vitest"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { MemoryCreatePartialFailureError } from "../../core/memory.js"

const { mineStateDir } = vi.hoisted(() => {
  const mineStateDir = `${process.env["TMPDIR"] ?? "/tmp"}/lore-mine-lock-test-${process.pid}-${Date.now()}`
  process.env["LORE_HOOK_STATE_DIR"] = mineStateDir
  process.env["LORE_MINE_POST_CREATE_STABILIZE_MS"] = "0"
  process.env["LORE_MINE_LOCK_TIMEOUT_MS"] = "1000"
  return { mineStateDir }
})

afterEach(async () => {
  await rm(mineStateDir, { recursive: true, force: true })
  process.env["LORE_MINE_POST_CREATE_STABILIZE_MS"] = "0"
  process.env["LORE_MINE_LOCK_TIMEOUT_MS"] = "1000"
  delete process.env["LORE_DEBUG"]
})

import {
  DEFAULT_MINE_LIMIT,
  DEFAULT_MINE_PATTERN,
  FIND_EXISTING_LIMIT,
  classifyMineFailure,
  formatOrphanSummary,
  findExistingFileMemory,
  formatMineSummary,
  globToRegExp,
  matchesGlob,
  mineLockPath,
  parseMineCliOptions,
  resolveMineProject,
  runMineUpsert,
  selectMineFiles,
  tryReclaimStaleMineLock,
  type MineCliOptions,
  type MineSummary,
} from "./mine.js"
import type { LoreServices } from "../../services.js"
import type { Memory } from "../../types.js"

describe("parseMineCliOptions", () => {
  it("returns defaults when --limit and --pattern are omitted", () => {
    const result = parseMineCliOptions({})
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual<MineCliOptions>({
        project: undefined,
        topic: undefined,
        pattern: DEFAULT_MINE_PATTERN,
        dryRun: false,
        limit: DEFAULT_MINE_LIMIT,
      })
    }
  })

  it("rejects --limit with a non-numeric string", () => {
    const result = parseMineCliOptions({ limit: "banana" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("--limit")
  })

  it("rejects --limit of 0", () => {
    // `parseInt("0", 10) === 0` would silently land a 0-file slice.
    const result = parseMineCliOptions({ limit: "0" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("positive")
  })

  it("rejects --limit of -1 (leading sign)", () => {
    // The regex /^[0-9]+$/ rejects the leading `-` before any
    // numeric coercion — without it `Number("-1")` returns `-1` and
    // the negative-number guard would catch it but later;
    // string-side rejection produces the cleaner error message.
    const result = parseMineCliOptions({ limit: "-1" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("decimal integer")
  })

  it("rejects --limit with trailing alpha (3abc → integer rejection, NOT silent truncation to 3)", () => {
    const result = parseMineCliOptions({ limit: "3abc" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("decimal integer")
  })

  it("rejects --limit with a fractional component (3.7)", () => {
    // `parseInt("3.7", 10) === 3` would silently floor — the regex
    // rejects the `.` so the operator gets an explicit error.
    const result = parseMineCliOptions({ limit: "3.7" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("decimal integer")
  })

  it("rejects --limit as the empty string", () => {
    // `parseInt("", 10) === NaN` and `slice(0, NaN)` returns `[]`;
    // explicit rejection prevents the empty-result-set surprise.
    const result = parseMineCliOptions({ limit: "" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("decimal integer")
  })

  it("rejects --limit in exponent notation (1e3)", () => {
    // `Number("1e3") === 1000` would silently pass `Number.isInteger`
    // and land a 1000-file cap — the regex rejects exponent notation.
    const result = parseMineCliOptions({ limit: "1e3" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("decimal integer")
  })

  it("rejects --limit with a leading +", () => {
    const result = parseMineCliOptions({ limit: "+5" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("decimal integer")
  })

  it("rejects --limit beyond Number.MAX_SAFE_INTEGER", () => {
    const result = parseMineCliOptions({ limit: "9999999999999999999" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain("safe integer")
  })

  it("accepts positive integers", () => {
    const result = parseMineCliOptions({ limit: "25" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.limit).toBe(25)
  })

  it("accepts MAX_SAFE_INTEGER and rejects MAX_SAFE_INTEGER+1", () => {
    // Boundary check on the safe-integer rejection — pin the exact
    // bound so a future contributor can't drift it without failing
    // a test.
    const safeMax = String(Number.MAX_SAFE_INTEGER)
    const safe = parseMineCliOptions({ limit: safeMax })
    expect(safe.ok).toBe(true)
    if (safe.ok) expect(safe.value.limit).toBe(Number.MAX_SAFE_INTEGER)
    const beyond = parseMineCliOptions({ limit: "9007199254740992" })
    expect(beyond.ok).toBe(false)
  })

  it("accepts leading zeros (007 → 7) — digit-only is unambiguous", () => {
    // Mirrors `parseScanCliOptions`' posture in conflicts.ts — leading
    // zeros are unconventional but not ambiguous, so accepted.
    const result = parseMineCliOptions({ limit: "007" })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.limit).toBe(7)
  })

  it("forwards string flags verbatim", () => {
    const result = parseMineCliOptions({
      project: "Mail",
      topic: "auth",
      pattern: "src/**/*.ts",
      dryRun: true,
      limit: "5",
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual<MineCliOptions>({
        project: "Mail",
        topic: "auth",
        pattern: "src/**/*.ts",
        dryRun: true,
        limit: 5,
      })
    }
  })
})

describe("globToRegExp / matchesGlob", () => {
  it("default pattern '**/*' matches every file at any depth", () => {
    expect(matchesGlob("foo.ts", DEFAULT_MINE_PATTERN)).toBe(true)
    expect(matchesGlob("a/b/c.ts", DEFAULT_MINE_PATTERN)).toBe(true)
    expect(matchesGlob("README.md", DEFAULT_MINE_PATTERN)).toBe(true)
  })

  it("'src/**/*.ts' matches paths under src ending in .ts at any depth", () => {
    expect(matchesGlob("src/foo.ts", "src/**/*.ts")).toBe(true)
    expect(matchesGlob("src/cli/mine.ts", "src/**/*.ts")).toBe(true)
    expect(matchesGlob("src/a/b/c/deep.ts", "src/**/*.ts")).toBe(true)
  })

  it("'src/**/*.ts' does NOT match paths outside src or non-.ts files", () => {
    expect(matchesGlob("README.md", "src/**/*.ts")).toBe(false)
    expect(matchesGlob("docs/intro.ts", "src/**/*.ts")).toBe(false)
    expect(matchesGlob("src/cli/mine.js", "src/**/*.ts")).toBe(false)
    expect(matchesGlob("src/foo.tsx", "src/**/*.ts")).toBe(false)
  })

  it("'*' matches within a single path segment, not across", () => {
    expect(matchesGlob("foo.ts", "*.ts")).toBe(true)
    expect(matchesGlob("a/b.ts", "*.ts")).toBe(false)
  })

  it("trailing '**' captures every file under a prefix", () => {
    expect(matchesGlob("src/foo.ts", "src/**")).toBe(true)
    expect(matchesGlob("src/a/b/c", "src/**")).toBe(true)
    expect(matchesGlob("docs/foo.ts", "src/**")).toBe(false)
  })

  it("'?' matches exactly one non-slash character", () => {
    expect(matchesGlob("a.ts", "?.ts")).toBe(true)
    expect(matchesGlob("ab.ts", "?.ts")).toBe(false)
    expect(matchesGlob("a/b.ts", "?/b.ts")).toBe(true)
  })

  it("character class '[abc]' matches one of the listed chars", () => {
    expect(matchesGlob("a.ts", "[abc].ts")).toBe(true)
    expect(matchesGlob("b.ts", "[abc].ts")).toBe(true)
    expect(matchesGlob("d.ts", "[abc].ts")).toBe(false)
  })

  it("negated character class '[!abc]' rejects the listed chars", () => {
    expect(matchesGlob("a.ts", "[!abc].ts")).toBe(false)
    expect(matchesGlob("d.ts", "[!abc].ts")).toBe(true)
  })

  it("escapes regex metacharacters in literal segments (dot/parens)", () => {
    // The literal `.` in `*.ts` must NOT match `xts` — without
    // escaping, `*.ts` would compile to `[^/]*.ts` and `.` would
    // match any single char.
    expect(matchesGlob("foo.ts", "*.ts")).toBe(true)
    expect(matchesGlob("fooxts", "*.ts")).toBe(false)
  })

  it("normalizes Windows-style backslash separators to forward slashes", () => {
    // `walk` uses `path.join`, which produces OS-native separators.
    // Pattern grammar stays platform-independent — operators write
    // `src/**/*.ts` regardless of where the walker ran.
    expect(matchesGlob("src\\cli\\mine.ts", "src/**/*.ts")).toBe(true)
  })

  it("globToRegExp produces an anchored regex (no partial matches)", () => {
    const re = globToRegExp("*.ts")
    expect(re.test("foo.ts")).toBe(true)
    // Without anchoring, "extra-foo.ts-suffix" would partial-match.
    expect(re.test("extra-foo.ts-suffix")).toBe(false)
    expect(re.source.startsWith("^")).toBe(true)
    expect(re.source.endsWith("$")).toBe(true)
  })

  it("unterminated character class is treated as a literal '['", () => {
    // `globToRegExp` must not throw on malformed patterns; treating
    // the bracket as literal keeps the matcher's failure mode "this
    // file doesn't match" rather than a crash on every walk entry.
    expect(() => globToRegExp("[abc")).not.toThrow()
    expect(matchesGlob("[abc", "[abc")).toBe(true)
  })

  it("character class containing '/' does NOT match across path boundaries", () => {
    // `[a/b]` must compile to a regex that matches `a` or `b` only —
    // never the literal `/`. Without the slash-strip in
    // `globToRegExp`, JS would compile `[a/b]` as a class that
    // matches `/` and break the matcher's "no token crosses path
    // boundaries" invariant. POSIX globs leave `/` in classes
    // undefined; lore's strip is the operator-friendly reading.
    expect(matchesGlob("a", "[a/b]")).toBe(true)
    expect(matchesGlob("b", "[a/b]")).toBe(true)
    expect(matchesGlob("/", "[a/b]")).toBe(false)
    // And at the orchestration level, a pattern like `foo[a/b]bar`
    // must not match `foo/bar` via the slash leaking through.
    expect(matchesGlob("foo/bar", "foo[a/b]bar")).toBe(false)
  })

  it("character class with only '/' (stripped to empty) never matches", () => {
    // After stripping `/`, the class body is empty. Without the
    // never-matching-atom emit in `globToRegExp`, this would
    // compile to `[]` (a JS regex syntax error) or `[^]` (which
    // matches any char, re-introducing the slash leak).
    expect(matchesGlob("a", "[/]")).toBe(false)
    expect(matchesGlob("/", "[/]")).toBe(false)
    expect(() => globToRegExp("[/]")).not.toThrow()
  })

  it("mid-segment '**' (e.g. 'foo**bar') does NOT cross slashes", () => {
    // Pinning the deliberate semantics: globstar only when surrounded
    // by path boundaries. `foo**bar` collapses to single-`*`
    // semantics — `foo[^/]*bar` — so it does NOT match
    // `foo/x/y/bar`. Earlier drafts used `.*` here, which would have
    // silently over-matched.
    expect(matchesGlob("foobar", "foo**bar")).toBe(true)
    expect(matchesGlob("fooxbar", "foo**bar")).toBe(true)
    expect(matchesGlob("fooxxbar", "foo**bar")).toBe(true)
    expect(matchesGlob("foo/bar", "foo**bar")).toBe(false)
    expect(matchesGlob("foo/x/y/bar", "foo**bar")).toBe(false)
  })

  it("leading bare '**foo' (no slash separator) does NOT cross slashes", () => {
    // Mirrors the mid-segment rule: globstar requires both-sides
    // path boundary. `**foo` has prevBoundary (start) but no
    // nextBoundary (no slash before `foo`), so it collapses to
    // single-`*`. Pinned so a future contributor can't quietly
    // "fix" the grammar in a way that changes operator-pinned
    // patterns.
    expect(matchesGlob("foo", "**foo")).toBe(true)
    expect(matchesGlob("xfoo", "**foo")).toBe(true)
    expect(matchesGlob("a/foo", "**foo")).toBe(false)
  })

  it("brace literals are escaped through, not expanded ({a,b} is literal)", () => {
    // Pinning the documented "no brace expansion" behavior. A future
    // contributor reaching for minimatch would need to flip this
    // test in lockstep, surfacing the grammar contract change.
    expect(matchesGlob("{a,b}.ts", "{a,b}.ts")).toBe(true)
    expect(matchesGlob("a.ts", "{a,b}.ts")).toBe(false)
    expect(matchesGlob("b.ts", "{a,b}.ts")).toBe(false)
  })

  it("path matching is case-sensitive even though the extension filter isn't", () => {
    // Documented asymmetry: `TEXT_EXTENSIONS` is `.toLowerCase()`'d
    // (so `Foo.TS` passes the extension filter), but the glob grammar
    // stays case-sensitive so Linux operators get predictable
    // matching. Pinning so the asymmetry doesn't drift silently.
    expect(matchesGlob("Foo.TS", "*.ts")).toBe(false)
    expect(matchesGlob("Foo.TS", "*.TS")).toBe(true)
    expect(matchesGlob("foo.ts", "*.ts")).toBe(true)
  })
})

describe("selectMineFiles", () => {
  // Pin the AC-critical ordering: pattern filter MUST run before the
  // limit slice. A regression that swapped them would silently break
  // `--pattern src/**/*.ts --limit 10` and ship unless this test is
  // wired up at the orchestration layer.
  it("applies pattern filter BEFORE limit slice", () => {
    const files = [
      "README.md",
      "package.json",
      "src/a.ts",
      "src/b.ts",
      "src/c.ts",
      "src/d.ts",
    ]
    const out = selectMineFiles(files, "src/**/*.ts", 2)
    expect(out).toEqual(["src/a.ts", "src/b.ts"])
  })

  it("filters non-text-extension files even with default pattern", () => {
    const files = ["a.ts", "b.bin", "c.exe", "d.md"]
    const out = selectMineFiles(files, "**/*", 10)
    expect(out).toEqual(["a.ts", "d.md"])
  })

  it("includes conventional Dockerfile and Containerfile paths", () => {
    const files = [
      "Dockerfile",
      "Containerfile",
      "deploy/Dockerfile",
      "containers/base/Containerfile",
    ]
    const out = selectMineFiles(files, "**/*", 10)
    expect(out).toEqual(files)
  })

  it("includes suffixed conventional container build file names", () => {
    const files = [
      "Dockerfile.dev",
      "Dockerfile.prod",
      "Containerfile.dev",
      "deploy/Containerfile.local",
      "deploy\\Dockerfile.windows",
    ]
    const out = selectMineFiles(files, "**/*", 10)
    expect(out).toEqual(files)
  })

  it("keeps extension-based .dockerfile support", () => {
    const files = ["foo.dockerfile", "deploy/base.DOCKERFILE"]
    const out = selectMineFiles(files, "**/*", 10)
    expect(out).toEqual(files)
  })

  it("does not include unrelated extensionless files", () => {
    const files = ["LICENSE", "Makefile", "docs/README"]
    const out = selectMineFiles(files, "**/*", 10)
    expect(out).toEqual([])
  })

  it("keeps conventional container build filename matching case-sensitive", () => {
    const files = ["dockerfile", "containerfile", "deploy/dockerfile.dev"]
    const out = selectMineFiles(files, "**/*", 10)
    expect(out).toEqual([])
  })

  it("returns [] when pattern matches nothing", () => {
    const files = ["a.ts", "b.ts"]
    const out = selectMineFiles(files, "docs/**/*.md", 10)
    expect(out).toEqual([])
  })

  it("respects limit when matches exceed the cap", () => {
    const files = ["a.ts", "b.ts", "c.ts", "d.ts"]
    const out = selectMineFiles(files, "**/*", 2)
    expect(out).toEqual(["a.ts", "b.ts"])
  })
})

describe("resolveMineProject", () => {
  function makeServices(opts: {
    findByName?: (name: string) => Promise<{ id: string; name: string } | null>
    contextProject?: { id: string; name: string } | null
  }): LoreServices {
    return {
      projects: {
        findByName: opts.findByName ?? (async () => null),
      },
      context: { project: opts.contextProject ?? null },
    } as unknown as LoreServices
  }

  it("returns the project when --project resolves", async () => {
    const services = makeServices({
      findByName: async (n) => (n === "Mail" ? { id: "p-mail", name: "Mail" } : null),
    })
    const result = await resolveMineProject(services, "Mail")
    expect(result).toEqual({ id: "p-mail" })
  })

  it("throws with a 'lore status projects' hint when --project is unknown", async () => {
    // Explicit-but-unresolved project names must fatal-fail before
    // any create / update work starts. Otherwise `--project Mial`
    // (typo) silently dispatches unscoped writes that can collide
    // with another project's existing rows.
    const services = makeServices({ findByName: async () => null })
    await expect(resolveMineProject(services, "Mial")).rejects.toThrow(
      /Project "Mial" could not be resolved.*lore status projects/,
    )
  })

  it("falls back to context.project when --project is omitted", async () => {
    const services = makeServices({
      contextProject: { id: "p-ctx", name: "Catch-all" },
    })
    const result = await resolveMineProject(services, undefined)
    expect(result).toEqual({ id: "p-ctx" })
  })

  it("returns null when --project is omitted and context has no project", async () => {
    const services = makeServices({})
    const result = await resolveMineProject(services, undefined)
    expect(result).toBeNull()
  })
})

describe("findExistingFileMemory", () => {
  function memShape(overrides: Partial<Memory> & { id: string; title: string }): Memory {
    return {
      projectIds: [],
      topicId: null,
      source: "file",
      kind: "note",
      status: "informational",
      confidence: "certain",
      confidenceScore: null,
      reviewBy: null,
      doneAt: null,
      decidedAt: null,
      lastReferencedAt: null,
      supersedesIds: [],
      affectsIds: [],
      alternatives: "",
      consequences: "",
      author: "",
      agent: "",
      tags: [],
      keywords: "",
      synopsis: "",
      session: "",
      content: "",
      taskState: null,
      blockedBy: "",
      entity: "",
      topicKey: "",
      revisionCount: 1,
      comparedWith: [],
      compareNotes: "",
      createdAt: "2026-04-20T00:00:00.000Z",
      updatedAt: "2026-04-20T00:00:00.000Z",
      ...overrides,
    }
  }

  function makeServices(searchResults: Memory[]): LoreServices {
    const search = vi.fn(async () => searchResults)
    return {
      memories: { search },
    } as unknown as LoreServices
  }

  it("returns the matching id when project-set, source, and title all match", async () => {
    const services = makeServices([
      memShape({
        id: "m1",
        title: "mine.ts — src/cli/commands/mine.ts",
        source: "file",
        projectIds: ["p1"],
      }),
    ])
    const id = await findExistingFileMemory(
      services,
      "mine.ts — src/cli/commands/mine.ts",
      "src/cli/commands/mine.ts",
      "p1",
    )
    expect(id).toBe("m1")
  })

  it("returns null when search returns no candidates", async () => {
    const services = makeServices([])
    const id = await findExistingFileMemory(
      services,
      "mine.ts — src/cli/commands/mine.ts",
      "src/cli/commands/mine.ts",
      "p1",
    )
    expect(id).toBeNull()
  })

  it("rejects same-title rows whose source is not 'file'", async () => {
    // A user-curated note that happens to match the mined-title shape
    // must NOT be treated as the upsert target — that would clobber
    // the user's content with a code dump.
    const services = makeServices([
      memShape({
        id: "m1",
        title: "mine.ts — src/cli/commands/mine.ts",
        source: "manual",
        projectIds: ["p1"],
      }),
    ])
    const id = await findExistingFileMemory(
      services,
      "mine.ts — src/cli/commands/mine.ts",
      "src/cli/commands/mine.ts",
      "p1",
    )
    expect(id).toBeNull()
  })

  it("rejects source:file rows whose title doesn't exactly match", async () => {
    // Substring overlap from contains-mode search: a query for
    // `src/foo.ts` returns mined files whose path is a substring,
    // such as `src/foo.ts.bak`. The exact-title gate filters them.
    const services = makeServices([
      memShape({
        id: "m1",
        title: "foo.ts.bak — src/foo.ts.bak",
        source: "file",
        projectIds: ["p1"],
      }),
    ])
    const id = await findExistingFileMemory(
      services,
      "foo.ts — src/foo.ts",
      "src/foo.ts",
      "p1",
    )
    expect(id).toBeNull()
  })

  it("rejects unscoped (projectIds: []) rows when query has --project set", async () => {
    // The flagged failure mode in PR review: `lore mine --project Foo`
    // could match an unscoped mined memory (created without
    // --project) and rewrite it into Foo's scope, silently merging
    // two upsert lineages. The post-filter on project-set equality
    // must reject the unscoped row.
    const services = makeServices([
      memShape({
        id: "m1",
        title: "mine.ts — src/cli/commands/mine.ts",
        source: "file",
        projectIds: [],
      }),
    ])
    const id = await findExistingFileMemory(
      services,
      "mine.ts — src/cli/commands/mine.ts",
      "src/cli/commands/mine.ts",
      "p1",
    )
    expect(id).toBeNull()
  })

  it("rejects rows scoped to a different project than the query", async () => {
    // Same axis: a mined memory in project A must NOT match a query
    // for project B, even if title and source align. Otherwise
    // running mine in two parallel-project worktrees would clobber
    // each other's mined lineages.
    const services = makeServices([
      memShape({
        id: "m1",
        title: "mine.ts — src/cli/commands/mine.ts",
        source: "file",
        projectIds: ["p-other"],
      }),
    ])
    const id = await findExistingFileMemory(
      services,
      "mine.ts — src/cli/commands/mine.ts",
      "src/cli/commands/mine.ts",
      "p1",
    )
    expect(id).toBeNull()
  })

  it("rejects rows with project superset (e.g. [p1, p2]) when query is [p1]", async () => {
    // Set-equality, not subset. Mirrors the
    // upsert-by-topic-key contract: `[A]` does not match `[A, B]`.
    const services = makeServices([
      memShape({
        id: "m1",
        title: "mine.ts — src/cli/commands/mine.ts",
        source: "file",
        projectIds: ["p1", "p2"],
      }),
    ])
    const id = await findExistingFileMemory(
      services,
      "mine.ts — src/cli/commands/mine.ts",
      "src/cli/commands/mine.ts",
      "p1",
    )
    expect(id).toBeNull()
  })

  it("matches an unscoped row when query has no projectId", async () => {
    // Symmetric to the rejection above: vault-wide unscoped mines
    // upsert into the unscoped lineage. Both expectedProjectIds and
    // memory.projectIds are `[]`, so set-equality matches.
    const services = makeServices([
      memShape({
        id: "m1",
        title: "mine.ts — src/cli/commands/mine.ts",
        source: "file",
        projectIds: [],
      }),
    ])
    const id = await findExistingFileMemory(
      services,
      "mine.ts — src/cli/commands/mine.ts",
      "src/cli/commands/mine.ts",
      undefined,
    )
    expect(id).toBe("m1")
  })

  it("uses contains-mode search scoped to the project with FIND_EXISTING_LIMIT recall", async () => {
    // Pin the recall ceiling: bumped from 25 → 100 to survive the
    // "busy vault paginates the previously-mined row out" failure
    // mode flagged in PR review.
    const search = vi.fn(async () => [])
    const services = {
      memories: { search },
    } as unknown as LoreServices
    await findExistingFileMemory(
      services,
      "mine.ts — src/cli/commands/mine.ts",
      "src/cli/commands/mine.ts",
      "p-mail",
    )
    expect(search).toHaveBeenCalledTimes(1)
    expect(search).toHaveBeenCalledWith(
      expect.objectContaining({
        query: "src/cli/commands/mine.ts",
        mode: "contains",
        projectId: "p-mail",
        limit: FIND_EXISTING_LIMIT,
        includeContent: false,
      }),
    )
    expect(FIND_EXISTING_LIMIT).toBe(100)
  })
})

describe("classifyMineFailure", () => {
  it("records archived partial-create failures without orphan follow-up", () => {
    const err = new MemoryCreatePartialFailureError(
      "Memory create partial failure: body write failed",
      {
        pageId: "p-1",
        cleanedUp: true,
        bodyWriteError: new Error("oops"),
      },
    )

    const record = classifyMineFailure("foo.ts", err)

    expect(record.failure).toEqual({
      file: "foo.ts",
      error: err.message,
      partialPageId: "p-1",
      partialCleanedUp: true,
    })
    expect(record.lineMessage).toBe(`  Failed foo.ts: ${err.message}`)
    expect(record.lineMessage).not.toMatch(/\[orphan/)
    expect(record.orphanPageId).toBeNull()
  })

  it("records live orphan partial-create failures for manual cleanup", () => {
    const err = new MemoryCreatePartialFailureError(
      "Memory create partial failure: cleanup also failed",
      {
        pageId: "p-2",
        cleanedUp: false,
        bodyWriteError: new Error("oops"),
        cleanupError: new Error("boom"),
      },
    )

    const record = classifyMineFailure("bar.py", err)

    expect(record.failure.partialPageId).toBe("p-2")
    expect(record.failure.partialCleanedUp).toBe(false)
    expect(record.failure.error).toBe(err.message)
    expect(record.lineMessage).toContain("[orphan p-2 requires manual archive]")
    expect(record.lineMessage.startsWith("  Failed bar.py:")).toBe(true)
    expect(record.orphanPageId).toBe("p-2")
  })

  it("keeps generic errors in the pre-existing failure shape", () => {
    const record = classifyMineFailure(
      "baz.md",
      new Error("Notion 400: invalid relation"),
    )

    expect(record.failure.partialPageId).toBeUndefined()
    expect(record.failure.partialCleanedUp).toBeUndefined()
    expect(record.failure.error).toBe("Notion 400: invalid relation")
    expect(record.lineMessage).toBe("  Failed baz.md: Notion 400: invalid relation")
    expect(record.orphanPageId).toBeNull()
  })

  it("stringifies non-Error thrown values", () => {
    const record = classifyMineFailure("qux.json", "503 Service Unavailable")

    expect(record.failure.error).toBe("503 Service Unavailable")
    expect(record.failure.partialPageId).toBeUndefined()
    expect(record.failure.partialCleanedUp).toBeUndefined()
    expect(record.lineMessage).toBe("  Failed qux.json: 503 Service Unavailable")
    expect(record.orphanPageId).toBeNull()
  })
})

describe("formatOrphanSummary", () => {
  it("returns no lines when there are no orphaned pages", () => {
    expect(formatOrphanSummary([])).toEqual([])
  })

  it("renders a manual cleanup block for orphaned pages", () => {
    const lines = formatOrphanSummary(["p-2", "p-3", "p-4"])

    expect(lines[0]).toBe("")
    expect(lines[1]).toBe("Orphan pages from cleanup-archive failures (3):")
    expect(lines[2]).toBe("  p-2")
    expect(lines[3]).toBe("  p-3")
    expect(lines[4]).toBe("  p-4")
    expect(lines[5]).toContain("Archive these manually")
    expect(lines[5]).toContain("`lore mine`")
    expect(lines).toHaveLength(6)
  })

  it("keeps the summary header stable for one orphaned page", () => {
    const lines = formatOrphanSummary(["only-one"])
    expect(lines[1]).toBe("Orphan pages from cleanup-archive failures (1):")
    expect(lines[2]).toBe("  only-one")
  })
})

describe("formatMineSummary", () => {
  function summary(overrides: Partial<MineSummary> = {}): MineSummary {
    return {
      outcomes: [],
      indexed: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      ...overrides,
    }
  }

  it("emits 'Indexed N files.' on a fresh-create-only run (byte-stable with pre-PR)", () => {
    // Backwards compat anchor: scripts and CI logs scraping for
    // `Indexed N files.` keep working unchanged on a no-update mine.
    expect(formatMineSummary(summary({ indexed: 12 }), 12)).toBe(
      "Done! Indexed 12 files.",
    )
  })

  it("appends the breakdown clause only when at least one update landed", () => {
    expect(formatMineSummary(summary({ indexed: 8, updated: 4 }), 12)).toBe(
      "Done! Indexed 12 files (8 new, 4 updated).",
    )
  })

  it("does NOT emit the breakdown clause when only fresh creates", () => {
    expect(formatMineSummary(summary({ indexed: 12, updated: 0 }), 12)).toBe(
      "Done! Indexed 12 files.",
    )
  })

  it("emits 'Done. Indexed N/M files (K failed).' on partial failure", () => {
    // Period (not exclamation) when failures are present — mirrors
    // pre-PR shape so log-scrape parsers stay stable.
    expect(formatMineSummary(summary({ indexed: 8, failed: 2 }), 10)).toBe(
      "Done. Indexed 8/10 files (2 failed).",
    )
  })

  it("includes the breakdown clause alongside failures when both apply", () => {
    expect(formatMineSummary(summary({ indexed: 4, updated: 4, failed: 2 }), 10)).toBe(
      "Done. Indexed 8/10 files (4 new, 4 updated) (2 failed).",
    )
  })
})

describe("runMineUpsert (orchestration)", () => {
  /** Thin in-memory MemoryService stand-in. Tracks call counts so
   * tests can assert update vs. create dispatch. */
  function makeServices(opts: {
    existingByPath?: Map<string, string>
    concurrency?: number
    searchImpl?: (input: { query: string }) => Promise<Memory[]>
    searchDelayMs?: number
    onCreate?: (input: unknown) => void | Promise<void>
  }) {
    const existingByPath = opts.existingByPath ?? new Map<string, string>()
    const updateCalls: Array<{ id: string; input: unknown }> = []
    const createCalls: Array<{ input: unknown }> = []
    const search =
      opts.searchImpl ??
      (async (input: { query: string }) => {
        if (opts.searchDelayMs) {
          await new Promise((r) => setTimeout(r, opts.searchDelayMs))
        }
        const id = existingByPath.get(input.query)
        if (!id) return []
        return [
          {
            id,
            projectIds: [],
            topicId: null,
            source: "file" as const,
            kind: "note" as const,
            status: "informational" as const,
            confidence: "certain" as const,
            confidenceScore: null,
            reviewBy: null,
            doneAt: null,
            decidedAt: null,
            lastReferencedAt: null,
            supersedesIds: [],
            affectsIds: [],
            alternatives: "",
            consequences: "",
            author: "",
            agent: "",
            tags: [],
            keywords: "",
            synopsis: "",
            session: "",
            content: "",
            taskState: null,
            blockedBy: "",
            entity: "",
            topicKey: "",
            revisionCount: 1,
            comparedWith: [],
            compareNotes: "",
            createdAt: "2026-04-20T00:00:00.000Z",
            updatedAt: "2026-04-20T00:00:00.000Z",
            // Title aligned with the mined-title shape so the
            // post-filter exact-title check matches.
            title: `${input.query.split("/").pop()} — ${input.query}`,
          } satisfies Memory,
        ]
      })
    const update = vi.fn(async (id: string, input: unknown) => {
      updateCalls.push({ id, input })
      return { id } as unknown as Memory
    })
    const create = vi.fn(async (input: unknown) => {
      createCalls.push({ input })
      await opts.onCreate?.(input)
      return { id: "fresh-id" } as unknown as Memory
    })
    const services = {
      memories: { search, update, create },
      context: {
        vault: {
          pageId: "vault-test",
          databases: {},
        },
        project: null,
        cwd: "/repo",
        isCatchAllFallback: false,
      },
      configRoot: "/repo",
      config: {
        notion: { rateLimit: { concurrency: opts.concurrency ?? 3 } },
      },
    } as unknown as LoreServices
    return { services, updateCalls, createCalls, update, create }
  }

  // We need actual files on disk because runMineUpsert calls stat /
  // readFile. Use a vitest tmp dir; helpers imported at module top.

  async function withFixture(
    files: Record<string, string>,
    test: (dir: string) => Promise<void>,
  ) {
    const tmp = await mkdtemp(`${tmpdir()}/lore-mine-test-`)
    try {
      for (const [name, content] of Object.entries(files)) {
        const idx = name.lastIndexOf("/")
        if (idx >= 0) {
          await mkdir(`${tmp}/${name.slice(0, idx)}`, { recursive: true })
        }
        await writeFile(`${tmp}/${name}`, content, "utf-8")
      }
      await test(tmp)
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  }

  function mineLockPathFor(relPath: string, projectId?: string): string {
    return mineLockPath("vault-test", projectId, relPath)
  }

  async function seedMineLock(
    relPath: string,
    opts: {
      projectId?: string
      pid?: number
      createdAt?: string
    } = {},
  ): Promise<string> {
    const pid = opts.pid ?? 4_000_001
    const createdAt = opts.createdAt ?? new Date().toISOString()
    const path = mineLockPathFor(relPath, opts.projectId)
    await mkdir(path, { recursive: true })
    await writeFile(
      join(path, "owner.json"),
      JSON.stringify({
        pid,
        token: "stale-owner",
        relPath,
        createdAt,
      }),
    )
    return path
  }

  it("creates fresh memories on a vault with no existing matches", async () => {
    const { services, updateCalls, createCalls } = makeServices({})
    await withFixture({ "a.ts": "// a", "b.ts": "// b" }, async (dir) => {
      const summary = await runMineUpsert(
        services,
        dir,
        ["a.ts", "b.ts"],
        undefined,
        undefined,
        () => {},
      )
      expect(summary.indexed).toBe(2)
      expect(summary.updated).toBe(0)
      expect(summary.failed).toBe(0)
      expect(createCalls).toHaveLength(2)
      expect(updateCalls).toHaveLength(0)
    })
  })

  it("uses the normal 3-backtick body for files with no embedded fence", async () => {
    const { services, createCalls } = makeServices({})
    await withFixture({ "a.ts": "const answer = 42" }, async (dir) => {
      const summary = await runMineUpsert(
        services,
        dir,
        ["a.ts"],
        undefined,
        undefined,
        () => {},
      )
      const relPath = relative("/repo", `${dir}/a.ts`)
      expect(summary.indexed).toBe(1)
      expect(createCalls[0]?.input).toMatchObject({
        content: `# ${relPath}\n\n\`\`\`ts\nconst answer = 42\n\`\`\``,
      })
    })
  })

  it("uses a longer outer fence when a mined Markdown file contains a code fence", async () => {
    const { services, createCalls } = makeServices({})
    const source = ["before", "```ts", "const answer = 42", "```", "after"].join("\n")
    await withFixture({ "notes.md": source }, async (dir) => {
      const summary = await runMineUpsert(
        services,
        dir,
        ["notes.md"],
        undefined,
        undefined,
        () => {},
      )
      const relPath = relative("/repo", `${dir}/notes.md`)
      expect(summary.indexed).toBe(1)
      expect(createCalls[0]?.input).toMatchObject({
        content: `# ${relPath}\n\n\`\`\`\`md\n${source}\n\`\`\`\``,
      })
    })
  })

  it("updates existing memories on a second run (idempotent upsert)", async () => {
    // Pin the AC-critical idempotency cycle: first mine creates,
    // second mine finds-and-updates the same row instead of
    // creating a duplicate. This is the test the PR review flagged
    // as missing — fresh-vault create + re-mine update sequence.
    await withFixture({ "a.ts": "// content v1" }, async (dir) => {
      const existing = new Map<string, string>()
      const { services, updateCalls, createCalls } = makeServices({
        existingByPath: existing,
      })
      // First run: no existing matches, create.
      const first = await runMineUpsert(
        services,
        dir,
        ["a.ts"],
        undefined,
        undefined,
        () => {},
      )
      expect(first.indexed).toBe(1)
      expect(first.updated).toBe(0)
      // Simulate the create having landed: subsequent searches find
      // it. Key the existing-row map on the same relPath
      // `runMineUpsert` will compute (`relative(configRoot, fullPath)`).
      existing.set(relative("/repo", `${dir}/a.ts`), "existing-id-1")

      // Second run: search returns the existing row, update fires.
      const second = await runMineUpsert(
        services,
        dir,
        ["a.ts"],
        undefined,
        undefined,
        () => {},
      )
      expect(second.indexed).toBe(0)
      expect(second.updated).toBe(1)
      expect(second.failed).toBe(0)
      // Total dispatches: 1 create on first run + 1 update on second.
      expect(createCalls).toHaveLength(1)
      expect(updateCalls).toHaveLength(1)
      expect(updateCalls[0]?.id).toBe("existing-id-1")
    })
  })

  it("serializes concurrent runs for the same file so only one fresh row is created", async () => {
    process.env["LORE_MINE_POST_CREATE_STABILIZE_MS"] = "40"
    await withFixture({ "a.ts": "// content" }, async (dir) => {
      const relPath = relative("/repo", `${dir}/a.ts`)
      const existing = new Map<string, string>()
      const createInputs: unknown[] = []
      const makeRunnerServices = () =>
        makeServices({
          existingByPath: existing,
          concurrency: 2,
          searchDelayMs: 1,
          onCreate: async (input) => {
            createInputs.push(input)
            setTimeout(() => existing.set(relPath, "fresh-id"), 10)
          },
        })
      const firstServices = makeRunnerServices()
      const secondServices = makeRunnerServices()

      const [first, second] = await Promise.all([
        runMineUpsert(
          firstServices.services,
          dir,
          ["a.ts"],
          undefined,
          undefined,
          () => {},
        ),
        runMineUpsert(
          secondServices.services,
          dir,
          ["a.ts"],
          undefined,
          undefined,
          () => {},
        ),
      ])

      expect(first.indexed + second.indexed).toBe(1)
      expect(first.updated + second.updated).toBe(1)
      expect(first.failed + second.failed).toBe(0)
      expect(createInputs).toHaveLength(1)
      expect(firstServices.updateCalls.length + secondServices.updateCalls.length).toBe(1)
    })
  })

  it("fails fast on duplicate files in the same concurrent batch", async () => {
    await withFixture({ "a.ts": "// content" }, async (dir) => {
      const { services, createCalls } = makeServices({
        searchDelayMs: 20,
        onCreate: async () => {
          await new Promise((r) => setTimeout(r, 20))
        },
      })

      const summary = await runMineUpsert(
        services,
        dir,
        ["a.ts", "a.ts"],
        undefined,
        undefined,
        () => {},
        () => {},
      )

      expect(summary.indexed).toBe(1)
      expect(summary.failed).toBe(1)
      expect(createCalls).toHaveLength(1)
      expect(
        summary.outcomes.some(
          (o) => o.kind === "failed" && o.error.includes("Duplicate in-flight"),
        ),
      ).toBe(true)
    })
  })

  it("recovers a stale mine lock before processing the file", async () => {
    await withFixture({ "a.ts": "// content" }, async (dir) => {
      const relPath = relative("/repo", `${dir}/a.ts`)
      await seedMineLock(relPath)
      const { services, createCalls } = makeServices({})

      const summary = await runMineUpsert(
        services,
        dir,
        ["a.ts"],
        undefined,
        undefined,
        () => {},
      )

      expect(summary.indexed).toBe(1)
      expect(summary.failed).toBe(0)
      expect(createCalls).toHaveLength(1)
    })
  })

  it("reclaims old mine locks even when the recorded PID is live", async () => {
    await withFixture({ "a.ts": "// content" }, async (dir) => {
      const relPath = relative("/repo", `${dir}/a.ts`)
      await seedMineLock(relPath, {
        pid: process.pid,
        createdAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      })
      const { services, createCalls } = makeServices({})

      const summary = await runMineUpsert(
        services,
        dir,
        ["a.ts"],
        undefined,
        undefined,
        () => {},
      )

      expect(summary.indexed).toBe(1)
      expect(summary.failed).toBe(0)
      expect(createCalls).toHaveLength(1)
    })
  })

  it("serializes stale-lock cleanup races with the reaper marker", async () => {
    await withFixture({ "a.ts": "// content" }, async (dir) => {
      const relPath = relative("/repo", `${dir}/a.ts`)
      const path = await seedMineLock(relPath)

      const results = await Promise.all([
        tryReclaimStaleMineLock(path),
        tryReclaimStaleMineLock(path),
      ])

      expect(results.filter((r) => r === "reclaimed")).toHaveLength(1)
      expect(results.some((r) => r === "active" || r === "gone")).toBe(true)
      await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" })
    })
  })

  it("isolates per-file failures: one bad file does not abort the batch", async () => {
    // The Promise.all batch must not reject on a single-file
    // failure. Modeled by a `create` that rejects on a specific
    // file path — every other file must still process and the
    // summary's `failed` counter increments.
    await withFixture({ "good.ts": "// ok", "bad.ts": "// will-fail" }, async (dir) => {
      const { services, update, create } = makeServices({})
      // Override `create` to reject on bad.ts.
      create.mockImplementationOnce(async () => {
        throw new Error("simulated 429")
      })
      const summary = await runMineUpsert(
        services,
        dir,
        ["bad.ts", "good.ts"], // bad first so it lands in the same batch
        undefined,
        undefined,
        () => {},
        () => {},
      )
      expect(summary.indexed).toBe(1)
      expect(summary.failed).toBe(1)
      expect(update).not.toHaveBeenCalled()
    })
  })

  it("skips files larger than the 100KB cap with kind: 'skipped' (no Notion call)", async () => {
    // Pre-PR posture preserved: oversized files are never read into
    // memory bodies. The new structure surfaces this via outcome
    // kind so the summary's `skipped` counter is observable.
    await withFixture(
      { "big.ts": "x".repeat(101 * 1024) }, // > 100 KB
      async (dir) => {
        const { services, create, update } = makeServices({})
        const summary = await runMineUpsert(
          services,
          dir,
          ["big.ts"],
          undefined,
          undefined,
          () => {},
        )
        expect(summary.skipped).toBe(1)
        expect(summary.indexed).toBe(0)
        expect(summary.failed).toBe(0)
        expect(create).not.toHaveBeenCalled()
        expect(update).not.toHaveBeenCalled()
      },
    )
  })

  it("update payload omits topicId when none is passed (preserves prior topic)", async () => {
    // Documented contract: re-mining a file without `--topic` does
    // NOT clear an existing Topic relation. `MemoryService.update`
    // only writes a property when its input field is present, so
    // omitting topicId from the payload is the preservation
    // mechanism. Mirrors `MemoryService.upsertByTopicKey`'s
    // Topic-preserves-silently posture documented in
    // `src/core/CLAUDE.md`.
    await withFixture({ "a.ts": "// content" }, async (dir) => {
      const existing = new Map<string, string>()
      const { services, updateCalls } = makeServices({
        existingByPath: existing,
      })
      existing.set(relative("/repo", `${dir}/a.ts`), "existing-id")

      await runMineUpsert(
        services,
        dir,
        ["a.ts"],
        undefined,
        undefined, // no --topic on rerun
        () => {},
      )
      expect(updateCalls).toHaveLength(1)
      const payload = updateCalls[0]?.input as { topicId?: string }
      expect(payload.topicId).toBeUndefined()
    })
  })

  it("dispatches in batches of services.config.notion.rateLimit.concurrency", async () => {
    // Pin the parallelization contract: bounded `Promise.all` chunks,
    // not a sequential `for await` loop. Sequential dispatch would
    // make the rate-limit-concurrency knob a no-op (round-trip
    // serialization is the bottleneck, not in-flight count).
    await withFixture(
      {
        "1.ts": "// 1",
        "2.ts": "// 2",
        "3.ts": "// 3",
        "4.ts": "// 4",
        "5.ts": "// 5",
      },
      async (dir) => {
        const inFlight: number[] = []
        let active = 0
        const search = vi.fn(async () => {
          active++
          inFlight.push(active)
          await new Promise((r) => setTimeout(r, 20))
          active--
          return []
        })
        const services = {
          memories: {
            search,
            create: vi.fn(async () => ({ id: "x" }) as unknown as Memory),
            update: vi.fn(async () => ({ id: "x" }) as unknown as Memory),
          },
          context: {
            vault: {
              pageId: "vault-test",
              databases: {},
            },
            project: null,
            cwd: "/repo",
            isCatchAllFallback: false,
          },
          configRoot: "/repo",
          config: { notion: { rateLimit: { concurrency: 2 } } },
        } as unknown as LoreServices
        await runMineUpsert(
          services,
          dir,
          ["1.ts", "2.ts", "3.ts", "4.ts", "5.ts"],
          undefined,
          undefined,
          () => {},
        )
        // Peak concurrency must equal the configured value, not 1
        // (sequential) and not all-N (unbounded).
        expect(Math.max(...inFlight)).toBe(2)
      },
    )
  })
})
