import { Command } from "commander"
import { readFile, readdir, stat } from "node:fs/promises"
import { resolve, relative, basename, extname, join } from "node:path"
import { initServices, type LoreServices } from "../../services.js"
import { DEFAULT_NOTION_CONCURRENCY } from "../../notion/rate-limit.js"
import type { Memory } from "../../types.js"

const TEXT_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".swift",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".css",
  ".scss",
  ".less",
  ".html",
  ".vue",
  ".svelte",
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".md",
  ".mdx",
  ".txt",
  ".rst",
  ".sh",
  ".bash",
  ".zsh",
  ".sql",
  ".graphql",
  ".dockerfile",
  ".tf",
])

/** Default `--pattern` value. Matches every relative path. */
export const DEFAULT_MINE_PATTERN = "**/*"

/** Default `--limit` value. Applied after extension AND pattern filtering. */
export const DEFAULT_MINE_LIMIT = 50

/**
 * Per-file find-existing search recall ceiling. Matches Notion's
 * `dataSources.query` `page_size` cap of 100 — same posture as
 * `MemoryService.list`'s upper bound. The post-filter on
 * `(source, title, projectIds)` keeps the candidate window tight, but
 * the underlying contains query orders by `last_edited_time desc`, so
 * a small ceiling can paginate the previously-mined row out on busy
 * vaults. 100 is the Notion-side cap; raising further would require
 * pagination, which the issue's idempotency contract doesn't justify
 * for the per-file lookup.
 */
export const FIND_EXISTING_LIMIT = 100

/** Max file size the mine path will ingest. Notion bodies above this
 * crowd out the page properties on render and are usually generated
 * artifacts. */
const MAX_FILE_SIZE = 100 * 1024

const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".git",
  ".next",
  "__pycache__",
])

const IGNORED_FILES = new Set([
  ".lore.yaml",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
])

/** Parsed and validated `lore mine` flags. */
export interface MineCliOptions {
  project: string | undefined
  topic: string | undefined
  pattern: string
  dryRun: boolean
  limit: number
}

/**
 * Validate `lore mine`'s raw flag inputs. Mirrors the strict-integer
 * posture in `parseScanCliOptions` (`commands/conflicts.ts`): reject
 * fractional, exponent-notation, leading-sign, and trailing-alpha
 * limits via a digit-only regex BEFORE any numeric coercion.
 *
 * `parseInt`'s silent fallback would otherwise:
 * - return `3` for `"3.7"` (truncation),
 * - return `3` for `"3abc"` (trailing-alpha truncation),
 * - return `NaN` for `""` or `"abc"` (`slice(0, NaN)` returns `[]`).
 *
 * Each of those would land bogus `--limit` values in the slice call —
 * either silently changing the cap or zeroing the result set.
 */
export function parseMineCliOptions(raw: {
  project?: string
  topic?: string
  pattern?: string
  dryRun?: boolean
  limit?: string
}):
  | { ok: true; value: MineCliOptions }
  | { ok: false; message: string } {
  let limit = DEFAULT_MINE_LIMIT
  if (raw.limit !== undefined) {
    // String-side digit-only check rejects:
    //   "3.7"  → would parseInt-floor to 3
    //   "3abc" → would parseInt-truncate to 3
    //   "1e3"  → Number() returns 1000, Number.isInteger passes silently
    //   "+5"   → Number() returns 5, Number.isInteger passes silently
    //   ""     → empty, parseInt returns NaN
    //   "  5"  → leading whitespace
    if (!/^[0-9]+$/.test(raw.limit)) {
      return {
        ok: false,
        message: `--limit must be a positive decimal integer, got "${raw.limit}"`,
      }
    }
    const n = Number(raw.limit)
    if (n < 1) {
      return {
        ok: false,
        message: `--limit must be a positive integer, got ${n}`,
      }
    }
    if (!Number.isSafeInteger(n)) {
      return {
        ok: false,
        message: `--limit exceeds the safe integer range, got "${raw.limit}"`,
      }
    }
    limit = n
  }
  return {
    ok: true,
    value: {
      project: raw.project,
      topic: raw.topic,
      pattern: raw.pattern ?? DEFAULT_MINE_PATTERN,
      dryRun: !!raw.dryRun,
      limit,
    },
  }
}

/**
 * Translate a glob pattern into an anchored, slash-aware `RegExp`.
 *
 * Path separators are normalized to forward slashes BEFORE matching
 * (see `matchesGlob` below) so the pattern grammar is platform-
 * independent — operators write `src/**` regardless of OS.
 *
 * Supported tokens:
 * - `**` is a *globstar* only when surrounded by path boundaries
 *   (`/` or string start/end). In that position it matches any
 *   number of path segments (including zero). Mid-segment `**`
 *   (e.g. `foo**bar`) collapses to single-`*` semantics
 *   (`[^/]*`) — matching across slashes there would silently
 *   over-match (`foo**bar` matching `foo/x/y/bar`), so the matcher
 *   declines the over-broad reading.
 * - `*` matches any chars except `/`.
 * - `?` matches exactly one non-`/` char.
 * - `[...]` character class — copied through verbatim, except a
 *   leading `!` is rewritten to `^` to match POSIX glob negation
 *   semantics. An unterminated `[` is treated as a literal. Raw
 *   `/` inside the class body is stripped — without that strip,
 *   `[a/b]` would compile to a JS regex that matches the literal
 *   `/`, breaking the matcher's "no token crosses path boundaries"
 *   invariant. POSIX globs leave `/` in classes undefined; lore's
 *   strip is the operator-friendly reading.
 * - All other regex metacharacters are escaped.
 *
 * **Case sensitivity.** Path matching is case-sensitive. The
 * `TEXT_EXTENSIONS` filter is case-insensitive (`.toLowerCase()`)
 * because file-extension semantics on macOS/Windows are
 * case-insensitive at the OS layer, but the `--pattern` grammar
 * stays case-sensitive so an operator on a case-sensitive
 * filesystem (Linux) gets predictable matching. A mixed-case file
 * (`Foo.TS`) passes the extension filter but only matches a
 * pattern whose path segment also says `Foo.TS`.
 *
 * Brace expansion (`{a,b}`) is intentionally NOT supported —
 * brace literals `{` / `}` are escaped through to literal regex
 * matches. Adding brace expansion would pull in a real glob
 * library; the issue's acceptance criteria use `src/**\/*.ts`-
 * style patterns which need only the four tokens above.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "^"
  let i = 0
  while (i < pattern.length) {
    const c = pattern[i]!
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // Globstar candidate. Only treat as a true multi-segment
        // wildcard when it sits between path boundaries on BOTH
        // sides (or string start / end). Otherwise collapse to
        // single-`*` semantics so a pattern like `foo**bar` does
        // NOT silently match `foo/x/y/bar`.
        const prevBoundary = i === 0 || pattern[i - 1] === "/"
        const next = pattern[i + 2]
        const nextBoundary = next === undefined || next === "/"
        if (prevBoundary && nextBoundary) {
          if (next === "/") {
            // `**/` — match zero or more `dir/` segments. The
            // collapsed form is greedy AND optional: `(?:.*/)?`
            // matches either nothing (zero dirs) or everything up
            // to a trailing `/` (N dirs).
            out += "(?:.*/)?"
            i += 3
          } else {
            // Trailing `**` (end of pattern). Matches anything to
            // end of string, including slashes — used for patterns
            // like `src/**` to capture every file under `src/`.
            out += ".*"
            i += 2
          }
        } else {
          // Mid-segment `**` (e.g. `foo**bar`). Collapse to
          // single-`*` semantics — a non-slash-spanning wildcard.
          // Skip BOTH stars so the second `*` doesn't double-emit.
          out += "[^/]*"
          i += 2
        }
      } else {
        out += "[^/]*"
        i += 1
      }
    } else if (c === "?") {
      out += "[^/]"
      i += 1
    } else if (c === "[") {
      const end = pattern.indexOf("]", i + 1)
      if (end === -1) {
        // Unterminated character class — treat the `[` as literal.
        out += "\\["
        i += 1
      } else {
        let body = pattern.slice(i + 1, end)
        // POSIX `[!abc]` → JS regex `[^abc]`.
        if (body.startsWith("!")) body = "^" + body.slice(1)
        // Strip raw `/` so the class never matches a path
        // separator. Without this, `[a/b]` would compile to a JS
        // class containing `/` and match across path boundaries,
        // breaking the matcher's segment invariant. POSIX leaves
        // `/` in classes undefined; lore's strip is the
        // operator-friendly reading.
        body = body.replaceAll("/", "")
        if (body === "" || body === "^") {
          // After the strip, the class is empty (or only the
          // negation). Emit a never-matching atom so an empty
          // class doesn't compile to `[]` (a syntax error in JS)
          // or `[^]` (which matches any char including `/`,
          // re-introducing the leak the strip closes).
          out += "(?!)"
        } else {
          out += "[" + body + "]"
        }
        i = end + 1
      }
    } else if (
      c === "\\" ||
      c === "^" ||
      c === "$" ||
      c === "." ||
      c === "|" ||
      c === "+" ||
      c === "(" ||
      c === ")" ||
      c === "{" ||
      c === "}"
    ) {
      out += "\\" + c
      i += 1
    } else {
      out += c
      i += 1
    }
  }
  out += "$"
  return new RegExp(out)
}

/**
 * Match a relative path against a glob pattern.
 *
 * Forward-slash-normalized so Windows-style paths (`src\\foo.ts`)
 * match patterns written with `/`. The walker emits paths joined via
 * `path.join`, which uses the platform separator; normalizing here
 * means `mine.ts`'s pattern grammar stays platform-independent
 * regardless of where the walker ran.
 */
export function matchesGlob(filePath: string, pattern: string): boolean {
  const normalized = filePath.split(/[\\/]/).join("/")
  return globToRegExp(pattern).test(normalized)
}

/**
 * Apply the extension filter, then the glob filter, then the limit
 * slice — in that order. Pure function; exported so the orchestration
 * test can pin the ordering directly.
 *
 * Pattern filtering MUST run before the limit slice so an operator's
 * `--pattern src/**\/*.ts --limit 10` returns the first 10 matching
 * files, not the first 10 files of any type that happen to come
 * before any matches in walk order.
 */
export function selectMineFiles(
  files: readonly string[],
  pattern: string,
  limit: number,
): string[] {
  return files
    .filter((f) => TEXT_EXTENSIONS.has(extname(f).toLowerCase()))
    .filter((f) => matchesGlob(f, pattern))
    .slice(0, limit)
}

/**
 * Resolve the active project for the mine run.
 *
 * Three-state contract:
 * - **Explicit `--project <name>` resolves**: returns the project.
 * - **Explicit `--project <name>` does NOT resolve**: throws. A typo
 *   like `--project Mial` would otherwise fall through to "no
 *   project" and silently dispatch unscoped writes — which can
 *   collide with another project's existing mined memories. Other
 *   CLI surfaces (`lore conflicts scan`, `lore tasks reconcile`)
 *   treat unknown project names as fatal; mine matches.
 * - **No `--project`**: defers to `services.context.project` (the
 *   `.lore.yaml`-resolved current project, possibly the catch-all),
 *   or `null` if cwd resolves to no project at all.
 */
export async function resolveMineProject(
  services: LoreServices,
  explicitName: string | undefined,
): Promise<{ id: string } | null> {
  if (explicitName) {
    const found = await services.projects.findByName(explicitName)
    if (!found) {
      throw new Error(
        `Project "${explicitName}" not found. ` +
          "Run `lore status projects` to list configured projects.",
      )
    }
    return { id: found.id }
  }
  if (services.context.project) {
    return { id: services.context.project.id }
  }
  return null
}

/** Order-independent set equality for project-id arrays. Both sides
 * carry small N (typically ≤ 3 projects per memory) so the linear
 * `every` over a `Set` is cheap. */
function projectIdsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  for (const x of b) if (!setA.has(x)) return false
  return true
}

/**
 * Find an existing `source: file` memory whose title matches the
 * mined-file title shape (`<basename> — <relPath>`) AND whose project
 * relation set exactly matches the intended scope.
 *
 * Uses `MemoryService.search({ mode: "contains", query: relPath })`
 * — Notion's contains filter searches Title, Keywords, and Synopsis.
 * Mined memories carry the relPath in BOTH the keywords blob and the
 * title, so a contains-mode query against the relPath is a single
 * round-trip that returns at most a handful of candidates. Limit is
 * `FIND_EXISTING_LIMIT = 100` (the Notion-side `page_size` cap) so a
 * busy vault with many recently-edited mined rows doesn't paginate
 * the target row out of the candidate window.
 *
 * Three post-filter gates close three failure modes:
 * - `source === "file"` rejects user-curated memories that happen to
 *   mention the relPath in their body or title (different source =
 *   different upsert lineage).
 * - `title === expectedTitle` rejects mined files whose path is a
 *   substring of the queried one (e.g. `src/foo.ts` substring-
 *   matches `src/foo.ts.bak`).
 * - `projectIdsEqual` rejects rows whose project-set differs from
 *   the intended scope. Without this, `lore mine --project Foo`
 *   could match an unscoped or differently-scoped row and rewrite
 *   it into Foo's project — silently merging two upsert lineages
 *   that should stay separate. Mirrors `MemoryService.upsertByTopicKey`'s
 *   `(Topic Key, Project-set)` equality contract.
 */
export async function findExistingFileMemory(
  services: LoreServices,
  expectedTitle: string,
  relPath: string,
  projectId: string | undefined,
): Promise<string | null> {
  const results = await services.memories.search({
    query: relPath,
    mode: "contains",
    projectId,
    limit: FIND_EXISTING_LIMIT,
    includeContent: false,
  })
  const expectedProjectIds = projectId ? [projectId] : []
  const match = results.find(
    (m: Memory) =>
      m.source === "file" &&
      m.title === expectedTitle &&
      projectIdsEqual(m.projectIds, expectedProjectIds),
  )
  return match?.id ?? null
}

/** Outcome of a single per-file mine attempt. Modeled as a discriminated
 * union so the parallel batch can return per-file status without
 * resorting to side-effect-y counter arithmetic across promises. */
export type MineFileOutcome =
  | { kind: "indexed"; file: string }
  | { kind: "updated"; file: string }
  | { kind: "skipped"; file: string; reason: string }
  | { kind: "failed"; file: string; error: string }

/** Aggregate result of a mine run. */
export interface MineSummary {
  outcomes: MineFileOutcome[]
  indexed: number
  updated: number
  skipped: number
  failed: number
}

/** Process one file: stat, read, search-for-existing, then update OR
 * create. Catches every failure and returns a `failed` outcome — the
 * parallel batch above must never reject on a single-file error. */
async function processOneFile(
  services: LoreServices,
  dir: string,
  file: string,
  projectId: string | undefined,
  topicId: string | undefined,
): Promise<MineFileOutcome> {
  try {
    const fullPath = resolve(dir, file)
    const fileStat = await stat(fullPath)
    if (fileStat.size > MAX_FILE_SIZE) {
      return {
        kind: "skipped",
        file,
        reason: `${(fileStat.size / 1024).toFixed(0)}KB > ${MAX_FILE_SIZE / 1024}KB limit`,
      }
    }
    const content = await readFile(fullPath, "utf-8")
    const relPath = relative(services.configRoot, fullPath)

    // File extension + `mined` marker are free-form tokens — the
    // closed `tags` vocabulary is a taxonomy, not a scratch pad.
    // Drop the extension entry if the file has no extension so we
    // don't emit a leading space.
    const ext = extname(file).slice(1)
    const keywords = [ext, "mined", relPath].filter(Boolean).join(" ")
    const title = `${basename(file)} — ${relPath}`
    const body = `# ${relPath}\n\n\`\`\`${ext}\n${content}\n\`\`\``

    const existingId = await findExistingFileMemory(
      services,
      title,
      relPath,
      projectId,
    )

    if (existingId) {
      // Topic preservation: when the rerun has no `--topic` (or
      // `topicId` couldn't be resolved without a project), we omit
      // the field from the update payload so `MemoryService.update`
      // leaves the existing Topic relation in place. Mirrors the
      // upsert-by-topic-key contract documented in
      // `src/core/CLAUDE.md` (Status / Topic preserve silently on
      // upsert). An operator who wants to retire a stale topic
      // explicitly should call `lore-memory action='update'` —
      // not the mine path, which is content-replication, not
      // metadata-curation.
      await services.memories.update(existingId, {
        title,
        content: body,
        projectIds: projectId ? [projectId] : undefined,
        topicId,
        keywords,
      })
      return { kind: "updated", file }
    }

    await services.memories.create({
      title,
      content: body,
      projectIds: projectId ? [projectId] : undefined,
      topicId,
      source: "file",
      keywords,
    })
    return { kind: "indexed", file }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    return { kind: "failed", file, error: msg }
  }
}

/**
 * Run the upsert pipeline against the resolved file list. Bounded-
 * concurrent dispatch sized to `notion.rateLimit.concurrency` so an
 * operator's rate-limit knob actually moves the wall-clock needle —
 * without parallelism the per-file `search → create-or-update`
 * round-trips serialize end-to-end at one-step-at-a-time.
 *
 * Per-file failures resolve as `kind: "failed"` outcomes and never
 * reject the batch (`processOneFile` swallows). Logging is injected
 * so tests can capture progress lines without process globals; the
 * default sink writes to stdout.
 *
 * **Concurrent mining caveat.** Two parallel `lore mine` runs against
 * the same project for the same file can both observe an empty
 * `findExistingFileMemory` and both create — Notion has no per-key
 * uniqueness primitive on the Memories DB. Single-operator serial
 * use is the common case; if real-vault data shows the race matters,
 * a follow-up adds a per-vault lock via `src/hooks/lock.ts`. The
 * existing `lore migrate --dedup-keys --merge` pass is fact-side
 * dedup, not memory-side, so it does NOT collapse mine duplicates.
 */
export async function runMineUpsert(
  services: LoreServices,
  dir: string,
  files: readonly string[],
  projectId: string | undefined,
  topicId: string | undefined,
  log: (msg: string) => void = (msg) => process.stdout.write(msg + "\n"),
): Promise<MineSummary> {
  const concurrency =
    services.config.notion?.rateLimit?.concurrency ?? DEFAULT_NOTION_CONCURRENCY
  const outcomes: MineFileOutcome[] = []
  let writes = 0
  let nextProgressMark = 10
  for (let i = 0; i < files.length; i += concurrency) {
    const batch = files.slice(i, i + concurrency)
    const results = await Promise.all(
      batch.map((file) => processOneFile(services, dir, file, projectId, topicId)),
    )
    outcomes.push(...results)

    // Inline logging for skipped / failed outcomes so the operator
    // sees them at the moment they happen rather than at end-of-run.
    for (const r of results) {
      if (r.kind === "skipped") log(`  Skipping ${r.file} (${r.reason})`)
      else if (r.kind === "failed") log(`  Failed ${r.file}: ${r.error}`)
      if (r.kind === "indexed" || r.kind === "updated") writes++
    }
    if (writes >= nextProgressMark) {
      log(`  ${writes}/${files.length} files indexed...`)
      // Next 10-write boundary strictly greater than `writes`. Same
      // shape as confidence-migration's progress-mark advance.
      nextProgressMark = Math.floor(writes / 10) * 10 + 10
    }
  }
  let indexed = 0
  let updated = 0
  let skipped = 0
  let failed = 0
  for (const o of outcomes) {
    if (o.kind === "indexed") indexed++
    else if (o.kind === "updated") updated++
    else if (o.kind === "skipped") skipped++
    else failed++
  }
  return { outcomes, indexed, updated, skipped, failed }
}

/** Render the final summary line. Pure function; tested directly so a
 * regression in summary wording fails a unit test, not a CI log diff.
 *
 * Wording stays additively-compatible with pre-PR: "Indexed N files."
 * is unchanged. The `(N new, M updated)` clause appears only when the
 * upsert produced at least one update, so a fresh-vault first run
 * emits byte-identical output to the pre-PR shape.
 */
export function formatMineSummary(s: MineSummary, totalFiles: number): string {
  const total = s.indexed + s.updated
  const breakdown =
    s.updated > 0 ? ` (${s.indexed} new, ${s.updated} updated)` : ""
  if (s.failed > 0) {
    return `Done. Indexed ${total}/${totalFiles} files${breakdown} (${s.failed} failed).`
  }
  return `Done! Indexed ${total} files${breakdown}.`
}

async function walkDirectory(dir: string, base: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const results: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!IGNORED_DIRS.has(entry.name)) {
        results.push(
          ...(await walkDirectory(join(dir, entry.name), join(base, entry.name))),
        )
      }
    } else if (!IGNORED_FILES.has(entry.name)) {
      results.push(join(base, entry.name))
    }
  }
  return results
}

export const mineCommand = new Command("mine")
  .description("Index project files as memories")
  .argument("[path]", "Path to index (default: current directory)")
  .option("-p, --project <name>", "Target project name")
  .option("-t, --topic <name>", "Target topic name")
  .option(
    "--pattern <glob>",
    "File glob pattern (relative to indexed root)",
    DEFAULT_MINE_PATTERN,
  )
  .option("--dry-run", "Preview files without indexing")
  .option(
    "-n, --limit <n>",
    `Max files to index (default ${DEFAULT_MINE_LIMIT})`,
    String(DEFAULT_MINE_LIMIT),
  )
  .action(
    async (
      targetPath: string | undefined,
      raw: {
        project?: string
        topic?: string
        pattern?: string
        dryRun?: boolean
        limit?: string
      }
    ) => {
      try {
        const parsed = parseMineCliOptions(raw)
        if (!parsed.ok) {
          console.error(`Mine failed: ${parsed.message}`)
          process.exit(1)
          // Defensive `return` after `process.exit` — same posture as
          // `commands/conflicts.ts`. TypeScript's narrowing of
          // `parsed.ok` via `process.exit`'s `never` return is
          // fragile across tsconfig changes.
          return
        }
        const opts = parsed.value
        const services = await initServices()
        const dir = resolve(targetPath ?? ".")

        // Resolve project FIRST — fatal-fail on an unknown explicit
        // `--project Mial` typo so we never silently dispatch
        // unscoped writes that could collide with the intended
        // project's existing rows.
        const project = await resolveMineProject(services, opts.project)
        const projectId = project?.id

        const files = await walkDirectory(dir, "")
        const textFiles = selectMineFiles(files, opts.pattern, opts.limit)

        if (textFiles.length === 0) {
          console.log("No indexable files found.")
          return
        }

        if (opts.dryRun) {
          console.log(`Would index ${textFiles.length} files:`)
          for (const f of textFiles) {
            console.log(`  ${f}`)
          }
          return
        }

        // Resolve topic AFTER project so the `getOrCreate` lands
        // under the right relation. A `--topic` without a resolved
        // project is operator error — Topics live under projects;
        // an orphaned topic write would land in vault-wide scope.
        let topicId: string | undefined
        if (opts.topic && projectId) {
          const topic = await services.topics.getOrCreate(opts.topic, [projectId])
          topicId = topic.id
        } else if (opts.topic && !projectId) {
          console.warn(
            `Warning: --topic "${opts.topic}" ignored: no project resolved ` +
              "(pass --project <name> or run from a directory mapped in .lore.yaml)."
          )
        }

        console.log(`Indexing ${textFiles.length} files...`)
        const summary = await runMineUpsert(
          services,
          dir,
          textFiles,
          projectId,
          topicId,
        )

        console.log(formatMineSummary(summary, textFiles.length))
        if (summary.failed > 0) {
          process.exitCode = 1
        }
      } catch (err) {
        console.error("Mine failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )
