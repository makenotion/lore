import { describe, expect, it, vi } from "vitest"
import {
  extractEntityCandidates,
  findDuplicateActiveTasks,
  findNearDuplicates,
  findRelatedActiveTasks,
  type MemoryLister,
  type TaskLister,
} from "./near-duplicate.js"
import type { Memory, TaskSummary } from "../types.js"

function makeMemory(overrides: Partial<Memory> & { id: string; title: string }): Memory {
  return {
    projectIds: ["proj-a"],
    topicId: null,
    source: "manual",
    kind: "note",
    status: "informational",
    confidence: "certain",
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
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
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

function makeLister(items: Memory[]): MemoryLister & { listSpy: ReturnType<typeof vi.fn> } {
  const listSpy = vi.fn().mockResolvedValue({ items })
  return { list: listSpy, listSpy }
}

describe("findNearDuplicates", () => {
  it("short-circuits when LORE_DISABLE_NEAR_DUPLICATE_PROBE=1 (operator kill-switch)", async () => {
    const listSpy = vi.fn()
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "1")
    try {
      const result = await findNearDuplicates(
        { list: listSpy },
        {
          title: "Anything",
          tags: [],
          projectId: "proj-a",
          threshold: 0.7,
        },
      )
      expect(result).toEqual([])
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("runs normally when LORE_DISABLE_NEAR_DUPLICATE_PROBE is anything other than '1'", async () => {
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "0")
    try {
      await findNearDuplicates(
        { list: listSpy },
        {
          title: "Anything",
          tags: [],
          projectId: "proj-a",
          threshold: 0.7,
        },
      )
      expect(listSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("returns [] when no projectId is given (vault-wide probes are skipped)", async () => {
    const lister = makeLister([])
    const result = await findNearDuplicates(lister, {
      title: "Anything",
      tags: [],
      threshold: 0.7,
    })
    expect(result).toEqual([])
    // No wasted Notion query on the unscoped path.
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("returns [] for an empty title (degenerate input, no useful signal)", async () => {
    const lister = makeLister([])
    const result = await findNearDuplicates(lister, {
      title: "   ",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(result).toEqual([])
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("passes the top-2 tags into the list filter (candidate-pool scoping)", async () => {
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "Something",
      tags: ["architecture", "core", "performance", "bug"],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["architecture", "core"] }),
    )
  })

  it("omits the tag filter entirely when the caller has no tags", async () => {
    // Project scope alone is enough of a candidate pool when tags are
    // absent — passing `tags: []` would return nothing from Notion's OR
    // filter.
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "Something",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ tags: undefined }),
    )
  })

  it("skips the per-page markdown fetch (probe only needs titles)", async () => {
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "Something",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ includeContent: false }),
    )
  })

  it("surfaces matches whose title trigram similarity meets the threshold", async () => {
    const lister = makeLister([
      makeMemory({
        id: "mem-1",
        title: "Wakeup hook swallows errors silently",
        tags: ["architecture"],
      }),
      makeMemory({ id: "mem-2", title: "Unrelated memory about database migrations" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook swallows errors silently",
      tags: ["architecture"],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("mem-1")
    expect(result[0].titleSimilarity).toBeCloseTo(1)
    expect(result[0].tagOverlap).toBeCloseTo(1)
  })

  it("sorts results by title similarity descending", async () => {
    const lister = makeLister([
      makeMemory({ id: "mem-mid", title: "Wakeup hook swallows errors" }),
      makeMemory({ id: "mem-high", title: "Wakeup hook swallows errors silently" }),
      makeMemory({ id: "mem-low", title: "Wakeup hook" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook swallows errors silently",
      tags: [],
      projectId: "proj-a",
      threshold: 0.1,
    })
    const ids = result.map((m) => m.id)
    // Descending by similarity: identical first, then partial, then low.
    expect(ids[0]).toBe("mem-high")
    expect(ids[1]).toBe("mem-mid")
    expect(ids[2]).toBe("mem-low")
  })

  it("drops rows with similarity strictly below threshold", async () => {
    const lister = makeLister([
      makeMemory({ id: "mem-1", title: "Completely unrelated topic" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook crash",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
    })
    expect(result).toEqual([])
  })

  it("filters by status whitelist client-side", async () => {
    // `lore-decide` needs `accepted OR proposed` — Notion's query accepts
    // one status clause, so the probe post-filters instead of issuing
    // two server queries for one probe.
    const lister = makeLister([
      makeMemory({
        id: "dec-accepted",
        title: "Replace auth middleware",
        kind: "decision",
        status: "accepted",
      }),
      makeMemory({
        id: "dec-superseded",
        title: "Replace auth middleware",
        kind: "decision",
        status: "superseded",
      }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Replace auth middleware",
      tags: [],
      projectId: "proj-a",
      kind: "decision",
      statuses: ["accepted", "proposed"],
      threshold: 0.6,
    })
    expect(result.map((m) => m.id)).toEqual(["dec-accepted"])
  })

  it("filters out kinds listed in excludeKinds (memory probe drops decisions)", async () => {
    const lister = makeLister([
      makeMemory({ id: "note", title: "Wakeup hook crash", kind: "note" }),
      makeMemory({ id: "dec", title: "Wakeup hook crash", kind: "decision" }),
    ])
    const result = await findNearDuplicates(lister, {
      title: "Wakeup hook crash",
      tags: [],
      projectId: "proj-a",
      threshold: 0.7,
      excludeKinds: ["decision"],
    })
    expect(result.map((m) => m.id)).toEqual(["note"])
  })

  it("swallows list() errors and returns [] (probe failures must not fail the save)", async () => {
    const listSpy = vi.fn().mockRejectedValue(new Error("notion 503"))
    const result = await findNearDuplicates(
      { list: listSpy },
      {
        title: "Anything",
        tags: [],
        projectId: "proj-a",
        threshold: 0.7,
      },
    )
    expect(result).toEqual([])
  })

  it("invokes onError when the list query throws (operator observability hook)", async () => {
    const err = new Error("notion 503")
    const listSpy = vi.fn().mockRejectedValue(err)
    const onError = vi.fn()

    const result = await findNearDuplicates(
      { list: listSpy },
      {
        title: "Anything",
        tags: [],
        projectId: "proj-a",
        threshold: 0.7,
        onError,
      },
    )

    expect(result).toEqual([])
    expect(onError).toHaveBeenCalledWith(err)
  })

  it("forwards topicId through to the lister (decision probe scopes by topic)", async () => {
    const lister = makeLister([])
    await findNearDuplicates(lister, {
      title: "x",
      tags: [],
      projectId: "proj-a",
      topicId: "topic-z",
      kind: "decision",
      threshold: 0.6,
    })
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ topicId: "topic-z", kind: "decision" }),
    )
  })
})

function makeTaskSummary(
  overrides: Partial<TaskSummary> & { id: string; title: string },
): TaskSummary {
  return {
    projectIds: ["proj-a"],
    topicId: null,
    source: "manual",
    kind: "task",
    status: "informational",
    confidence: "certain",
    reviewBy: null,
    doneAt: null,
    decidedAt: null,
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
    taskState: "open",
    blockedBy: "",
    // Default `entity` to title to mirror `TaskService.create`'s
    // omitted-entity behavior; an explicit `overrides.entity` wins
    // via the spread below. Spelled `entity ?? title` rather than
    // bare `overrides.title` so the override-or-default contract is
    // visible at the call site for future test authors.
    entity: overrides.entity ?? overrides.title,
    createdAt: "2026-04-20T00:00:00.000Z",
    updatedAt: "2026-04-20T00:00:00.000Z",
    ...overrides,
  }
}

function makeTaskLister(
  items: TaskSummary[],
): TaskLister & { listSpy: ReturnType<typeof vi.fn> } {
  const listSpy = vi.fn().mockResolvedValue({ items })
  return { list: listSpy, listSpy }
}

describe("findDuplicateActiveTasks", () => {
  it("short-circuits when LORE_DISABLE_NEAR_DUPLICATE_PROBE=1 (operator kill-switch)", async () => {
    const listSpy = vi.fn()
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "1")
    try {
      const result = await findDuplicateActiveTasks(
        { list: listSpy },
        { entity: "PR-25750", projectId: "proj-a" },
      )
      expect(result).toEqual([])
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("runs normally when LORE_DISABLE_NEAR_DUPLICATE_PROBE is anything other than '1'", async () => {
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "0")
    try {
      await findDuplicateActiveTasks(
        { list: listSpy },
        { entity: "PR-25750", projectId: "proj-a" },
      )
      expect(listSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("returns [] when entity is empty (degenerate input — no useful signal)", async () => {
    const lister = makeTaskLister([])
    const result = await findDuplicateActiveTasks(lister, {
      entity: "",
      projectId: "proj-a",
    })
    expect(result).toEqual([])
    // No wasted Notion call on the unscoped path.
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("returns [] when entity is whitespace-only", async () => {
    const lister = makeTaskLister([])
    const result = await findDuplicateActiveTasks(lister, {
      entity: "   ",
      projectId: "proj-a",
    })
    expect(result).toEqual([])
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("forwards entity, projectId, ACTIVE_TASK_STATES, and limit=10 into the list query", async () => {
    const lister = makeTaskLister([])
    await findDuplicateActiveTasks(lister, {
      entity: "PR-25750",
      projectId: "proj-a",
    })
    expect(lister.listSpy).toHaveBeenCalledWith({
      projectId: "proj-a",
      entities: ["PR-25750"],
      states: ["open", "in-progress", "blocked"],
      limit: 10,
    })
  })

  it("returns the raw set of active tasks — no exclusion of any kind", async () => {
    // Acceptance criterion: the helper performs no exclusion. Even if
    // the caller passes the just-created task's id back through some
    // surface, this helper does not (and cannot) filter by it. The
    // test pins that contract — every TaskSummary the lister returns
    // surfaces in the result, in the order the lister returned them.
    const items = [
      makeTaskSummary({ id: "task-1", title: "Track PR-25750 review" }),
      makeTaskSummary({ id: "task-2", title: "PR-25750 follow-up" }),
      makeTaskSummary({ id: "task-3", title: "PR-25750 redux" }),
    ]
    const lister = makeTaskLister(items)
    const result = await findDuplicateActiveTasks(lister, {
      entity: "PR-25750",
      projectId: "proj-a",
    })
    expect(result.map((t) => t.id)).toEqual(["task-1", "task-2", "task-3"])
  })

  it("swallows list() errors and returns [] (probe failures must not fail the create)", async () => {
    const listSpy = vi.fn().mockRejectedValue(new Error("notion 503"))
    const result = await findDuplicateActiveTasks(
      { list: listSpy },
      { entity: "PR-25750", projectId: "proj-a" },
    )
    expect(result).toEqual([])
  })

  it("invokes onError when the list query throws (operator observability hook)", async () => {
    const err = new Error("notion 503")
    const listSpy = vi.fn().mockRejectedValue(err)
    const onError = vi.fn()

    const result = await findDuplicateActiveTasks(
      { list: listSpy },
      { entity: "PR-25750", projectId: "proj-a", onError },
    )

    expect(result).toEqual([])
    expect(onError).toHaveBeenCalledWith(err)
  })

  it("allows an undefined projectId — vault-wide active-task probe is well-defined", async () => {
    // Unlike `findNearDuplicates`, which skips vault-wide probes
    // because they'd scan the whole Memories DB, the task probe rides
    // `TaskService.list`'s `projectOrUnscopedFilter` which already
    // bounds the query to active tasks. An unscoped call is rare in
    // practice (the wire-in always passes `resolved.ids[0]`), but the
    // helper must not refuse it — projectless tasks exist.
    const lister = makeTaskLister([
      makeTaskSummary({ id: "task-1", title: "Track PR-25750" }),
    ])
    const result = await findDuplicateActiveTasks(lister, {
      entity: "PR-25750",
    })
    expect(result.map((t) => t.id)).toEqual(["task-1"])
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined }),
    )
  })
})

describe("extractEntityCandidates", () => {
  // The fixture-pinned tokenizer for `findRelatedActiveTasks`. Order
  // matters: high-precision patterns (PR / issue / Jira / URL) iterate
  // before the broad capitalized-phrase pattern so cap-induced
  // truncation drops the noisiest candidates first.

  it("returns [] when title, keywords, and synopsis are all empty", () => {
    expect(extractEntityCandidates("", "", "")).toEqual([])
  })

  it("returns [] when every input is whitespace-only", () => {
    expect(extractEntityCandidates("   ", "\t", "\n")).toEqual([])
  })

  it("extracts `PR #N` and the embedded `#N` substring as separate candidates", () => {
    // The Set dedup collapses identical strings, but `PR #25750` and
    // `#25750` are different literals — both useful as `Entity contains`
    // probes. The PR pattern fires before the standalone-#N pattern,
    // so `PR #25750` lands first in the result order.
    const result = extractEntityCandidates(
      "Merged PR #25750: outlook label.applied classifier",
      "",
      "",
    )
    expect(result).toContain("PR #25750")
    expect(result).toContain("#25750")
    // PR pattern wins the priority race.
    expect(result.indexOf("PR #25750")).toBeLessThan(result.indexOf("#25750"))
  })

  it("extracts `PR-N` (hyphenated form)", () => {
    const result = extractEntityCandidates("Track PR-25750 review", "", "")
    expect(result).toContain("PR-25750")
  })

  it("extracts standalone `#N` issue references", () => {
    const result = extractEntityCandidates("Closes #1234 finally", "", "")
    expect(result).toContain("#1234")
  })

  it("extracts Jira-style ABC-123 ids (>= 2 uppercase letters)", () => {
    const result = extractEntityCandidates(
      "Fix SENTRY-1234 incident in IOS-25",
      "",
      "",
    )
    expect(result).toContain("SENTRY-1234")
    expect(result).toContain("IOS-25")
  })

  it("rejects single-letter Jira shapes like `A-1` to avoid false positives", () => {
    // `[A-Z]+-\d+` would match `A-1`; we tightened to `{2,}` so
    // hyphenated single-letter prose doesn't pollute the candidate
    // pool. A-1, T-3, B-2 are common in bullet lists.
    const result = extractEntityCandidates("Item A-1 and B-2", "", "")
    expect(result).not.toContain("A-1")
    expect(result).not.toContain("B-2")
  })

  it("extracts URLs (http and https)", () => {
    const result = extractEntityCandidates(
      "See https://example.com/foo and http://bar.test/baz for context",
      "",
      "",
    )
    expect(result).toContain("https://example.com/foo")
    expect(result).toContain("http://bar.test/baz")
  })

  it("extracts 1-3 word capitalized phrases (greedy left-to-right)", () => {
    // The greedy multi-word match consumes adjacent capitalized words
    // starting from the first capital. For "Outlook Mobile App
    // shipped" the regex consumes the 3-word prefix "Outlook Mobile
    // App" as one candidate; downstream lowercase words terminate the
    // phrase. A 1-word fallback ("AuthService" alone) lands when no
    // adjacent capital follows.
    const phrase = extractEntityCandidates(
      "Outlook Mobile App shipped today",
      "",
      "",
    )
    expect(phrase).toContain("Outlook Mobile App")

    const single = extractEntityCandidates("AuthService refactor", "", "")
    expect(single).toContain("AuthService")
  })

  it("combines title + keywords + synopsis as one searchable surface", () => {
    const result = extractEntityCandidates(
      "Shipped feature",
      "PR #25750 OAUTH-12",
      "Closes #88 for AuthService.",
    )
    expect(result).toContain("PR #25750")
    expect(result).toContain("OAUTH-12")
    expect(result).toContain("#88")
  })

  it("caps candidate count at 5 (Notion OR-branch ceiling)", () => {
    // Title with many distinct entity shapes; verify the global cap
    // applies. PR/issue/Jira fill first; the cap must hit before all
    // capitalized phrases sneak in.
    const result = extractEntityCandidates(
      "PR #1 PR #2 PR #3 SENTRY-1 SENTRY-2 SENTRY-3 SENTRY-4 SENTRY-5 SENTRY-6",
      "",
      "",
    )
    expect(result.length).toBeLessThanOrEqual(5)
  })

  it("orders high-precision patterns before capitalized-word matches", () => {
    // A title with both a PR and a capitalized phrase should land the
    // PR candidate FIRST. Cap-induced truncation drops the noisier
    // capitalized phrase if budget is tight.
    const result = extractEntityCandidates(
      "Merged PR #25750 for AuthService refactor",
      "",
      "",
    )
    const prIdx = result.indexOf("PR #25750")
    expect(prIdx).toBe(0)
  })

  it("dedupes identical literal matches across the combined input", () => {
    // Same `PR #25750` in title and keywords — only one candidate emitted.
    const result = extractEntityCandidates(
      "Merged PR #25750",
      "PR #25750",
      "",
    )
    const prCount = result.filter((c) => c === "PR #25750").length
    expect(prCount).toBe(1)
  })

  it("matches `PR#25750` (no space between PR and #) — \\s* lets zero whitespace through", () => {
    // Pinned per reviewer nit. The PR pattern is `\bPR\s*#\d+\b` so
    // both `PR #25750` and `PR#25750` match. `Entity contains "PR#25750"`
    // and `Entity contains "PR #25750"` are different server-side
    // probes — pin both shapes so a tightening of the regex (e.g.
    // requiring exactly one space) is caught loudly.
    const noSpace = extractEntityCandidates("Merged PR#25750 outage", "", "")
    expect(noSpace).toContain("PR#25750")

    const withSpace = extractEntityCandidates("Merged PR #25750 outage", "", "")
    expect(withSpace).toContain("PR #25750")
  })

  it("strips trailing punctuation from URL matches (concern #2)", () => {
    // `https?:\S+` is greedy on `\S` and pulls in trailing `,)/.;`.
    // Post-process strips them so `Entity contains "https://x.com/foo"`
    // matches a real URL entity even when the source memory wrote
    // `See https://x.com/foo, also` or `See https://x.com/foo).`.
    const comma = extractEntityCandidates(
      "See https://x.com/foo, also at github.com",
      "",
      "",
    )
    expect(comma).toContain("https://x.com/foo")
    expect(comma).not.toContain("https://x.com/foo,")

    const paren = extractEntityCandidates("See https://x.com/foo) details", "", "")
    expect(paren).toContain("https://x.com/foo")
    expect(paren).not.toContain("https://x.com/foo)")

    const period = extractEntityCandidates("See https://x.com/foo. End.", "", "")
    expect(period).toContain("https://x.com/foo")
    expect(period).not.toContain("https://x.com/foo.")

    const multi = extractEntityCandidates("Check https://x.com/foo!).", "", "")
    expect(multi).toContain("https://x.com/foo")
    expect(multi).not.toContain("https://x.com/foo!).")
  })

  it("rejects 1-word capitalized matches that are common verb leads (concern #1)", () => {
    // Stop-list of common save-title verbs / connectors. A bare
    // `Entity contains "Merged"` matches every Merged-flavored task
    // entity in the vault — overwhelming noise. The verb is the
    // noise; if there's a real entity in the title, another pattern
    // (PR / Jira / surviving capitalized phrase) catches it.
    const merged = extractEntityCandidates(
      "Merged the OAuth migration",
      "",
      "",
    )
    expect(merged).not.toContain("Merged")

    const found = extractEntityCandidates("Found a regression", "", "")
    expect(found).not.toContain("Found")
    expect(found).not.toContain("Found a")

    const fixed = extractEntityCandidates("Fixed memory leak", "", "")
    expect(fixed).not.toContain("Fixed")

    const reviewing = extractEntityCandidates("Reviewing changes", "", "")
    expect(reviewing).not.toContain("Reviewing")
  })

  it("rejects multi-word matches whose lead is a stop-list verb", () => {
    // "Merged PR" is a real 2-word capitalized match; the leading
    // verb makes it noise even though it's >=2 words. Stop-list
    // applies to phrase leads, not just single-word matches.
    const result = extractEntityCandidates(
      "Merged PR review notes",
      "",
      "",
    )
    expect(result).not.toContain("Merged PR")
    // Sanity: the underlying PR shape would still surface if a number
    // were attached (it's a different pattern, not gated).
  })

  it("rejects 1-word generic capitalized nouns that match too many task entities", () => {
    // `Bug`, `API`, `Mail`, `Issue` — these substring-match too many
    // unrelated task entities. The stoplist drops them.
    const bug = extractEntityCandidates("Triaging Bug report", "", "")
    expect(bug).not.toContain("Bug")

    const api = extractEntityCandidates("Refactor API surface", "", "")
    expect(api).not.toContain("API")

    const mail = extractEntityCandidates("Mail outage at 3pm", "", "")
    expect(mail).not.toContain("Mail")
  })

  it("rejects 1-word matches shorter than 4 chars (PR / IO / OK / etc.)", () => {
    // Bare `PR` (no number attached) is too generic — `Entity
    // contains "PR"` matches every PR-flavored task. The cap-at-3
    // rejects single-word noise without losing entity-shaped tokens
    // (CamelCase identifiers are typically much longer).
    const result = extractEntityCandidates("PR review at 3pm", "", "")
    expect(result).not.toContain("PR")
  })

  it("accepts CamelCase 1-word identifiers (mixed case beyond first letter)", () => {
    // The whole point of the relevance gate is to keep
    // identifier-shaped 1-word matches (`AuthService`, `OAuth`,
    // `WeChat`) while dropping plain-word noise (`Merged`, `Bug`).
    const auth = extractEntityCandidates("AuthService refactor", "", "")
    expect(auth).toContain("AuthService")

    const oauth = extractEntityCandidates("OAuth flow rewritten", "", "")
    expect(oauth).toContain("OAuth")

    const wechat = extractEntityCandidates("WeChat session cookie issue", "", "")
    expect(wechat).toContain("WeChat")
  })

  it("accepts 1-word matches with internal digits (PR1234, V2API)", () => {
    // Digit content alone is enough signal — these are
    // identifier-shaped tokens where another pattern (PR / Jira)
    // didn't fire.
    const pr1234 = extractEntityCandidates("Investigated PR1234 fanout", "", "")
    expect(pr1234).toContain("PR1234")
  })

  it("rejects plain capitalized brand-name 1-word tokens (Outlook, Notion)", () => {
    // Trade-off: we lose `Outlook` / `Notion` / `Slack` as 1-word
    // entity candidates, because `Entity contains "Outlook"` matches
    // every Outlook-related task in the vault. False negative is
    // safer than false positive here — these brands rarely appear
    // alone (usually paired with a service or PR number) and the
    // multi-word pattern catches `Outlook Mail App` / `Notion API`
    // when they do.
    const outlook = extractEntityCandidates("Outlook outage today", "", "")
    expect(outlook).not.toContain("Outlook")

    const notion = extractEntityCandidates("Notion API migration", "", "")
    // "Notion API" is multi-word — but "API" is in the stop-list.
    // "Notion" alone would only land if the multi-word match didn't
    // fire. Here `\bNotion API\b` is a 2-word match starting with a
    // non-stoplisted lead → accepted.
    expect(notion).toContain("Notion API")
    // Bare "Notion" would NOT have surfaced even without the
    // multi-word match — pinned for clarity.
    expect(notion).not.toContain("Notion")
  })

  it("rejects bare-imperative verb leads (Fix / Add / Build / Land / Wrote / Got / etc.)", () => {
    // Empirical concern from review delta: agent-written titles
    // frequently use bare imperatives ("Fix the X", "Add Y", "Land Z")
    // — the past-tense stoplist alone misses these. Pin the
    // imperatives so a future "consolidation" of the stoplist can't
    // drop them silently. The reviewer's adversarial fixtures land
    // verbatim:

    expect(extractEntityCandidates("Fix Outlook Mail bug", "", "")).toEqual([])
    expect(extractEntityCandidates("Add OAuth login", "", "")).toEqual(["OAuth"])
    expect(extractEntityCandidates("Land PR review", "", "")).toEqual([])
    expect(extractEntityCandidates("Build Cache Handler", "", "")).toEqual([])
    expect(extractEntityCandidates("Wrote AuthService refactor", "", "")).toEqual([
      "AuthService",
    ])
    expect(extractEntityCandidates("Got Mail Working", "", "")).toEqual([])
    expect(extractEntityCandidates("Ship feature today", "", "")).toEqual([])
    expect(extractEntityCandidates("Resolve memory leak", "", "")).toEqual([])
    expect(extractEntityCandidates("Refactor AuthService into modules", "", "")).toEqual([
      "AuthService",
    ])
    expect(extractEntityCandidates("Test new pipeline", "", "")).toEqual([])
    expect(extractEntityCandidates("Investigate latency spike", "", "")).toEqual([])
    expect(extractEntityCandidates("Implement OAuth flow", "", "")).toEqual(["OAuth"])
    expect(extractEntityCandidates("Migrate to Notion v5", "", "")).toEqual([])
    expect(extractEntityCandidates("Review changes", "", "")).toEqual([])
    expect(extractEntityCandidates("Decide between OAuth and SAML", "", "")).toEqual([
      "OAuth",
      "SAML",
    ])
  })

  it("rejects bare-scheme URL matches like `https://`", () => {
    // Regex requires `[a-zA-Z0-9]` immediately after `://` so a stub
    // like `Just https://.` (where the `.` is prose punctuation) no
    // longer produces `["https://"]`. `Entity contains "https://"`
    // would substring-hit every URL-bearing task entity in the vault.
    expect(extractEntityCandidates("Just https://.", "", "")).toEqual([])
    expect(extractEntityCandidates("Just https:// today", "", "")).toEqual([])
    expect(extractEntityCandidates("Just http://", "", "")).toEqual([])
    // Sanity: real URLs still match.
    expect(extractEntityCandidates("See https://x.com/foo today", "", "")).toContain(
      "https://x.com/foo",
    )
    expect(extractEntityCandidates("See https://a.b/c", "", "")).toContain("https://a.b/c")
  })

  it("counts per-pattern cap by iteration attempts, not by unique additions (intent pin)", () => {
    // Reviewer nit on line 343: pin the intent. The
    // PER_PATTERN_MATCH_CAP is meant to bound the pattern's scan
    // work, not the Set growth. So a pattern that hits 5 already-
    // present literals stops, even though the Set didn't grow. This
    // protects against a pathological-but-realistic input where the
    // same `PR #25750` repeats 50 times in keywords — without this
    // accounting, the loop would scan all 50 before yielding to
    // later patterns. Empirically: cap is 5 attempts; same literal
    // repeated 6 times still bails after 5.
    const repeated = "PR #1 PR #1 PR #1 PR #1 PR #1 PR #1 PR #1 PR #1"
    const result = extractEntityCandidates(repeated, "", "")
    // Only one unique candidate from the first PR pattern.
    expect(result.filter((c) => c === "PR #1").length).toBe(1)
    // The standalone-#N pattern still gets to run because the per-
    // pattern cap halts the PR pattern after 5 iterations, allowing
    // the remaining patterns to execute. `#1` lands.
    expect(result).toContain("#1")
  })
})

describe("findRelatedActiveTasks", () => {
  it("short-circuits when LORE_DISABLE_TASK_CROSSREF=1 (operator kill-switch)", async () => {
    const listSpy = vi.fn()
    vi.stubEnv("LORE_DISABLE_TASK_CROSSREF", "1")
    try {
      const result = await findRelatedActiveTasks(
        { tasks: { list: listSpy } },
        { memoryTitle: "Merged PR #25750", projectId: "proj-a" },
      )
      expect(result).toEqual([])
      expect(listSpy).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("runs normally when LORE_DISABLE_TASK_CROSSREF is unset / not '1'", async () => {
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    vi.stubEnv("LORE_DISABLE_TASK_CROSSREF", "0")
    try {
      await findRelatedActiveTasks(
        { tasks: { list: listSpy } },
        { memoryTitle: "Merged PR #25750", projectId: "proj-a" },
      )
      expect(listSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("does NOT honor LORE_DISABLE_NEAR_DUPLICATE_PROBE (single-axis kill switches)", async () => {
    // The two probes have different failure modes and an operator may
    // want one but not the other. Pinning this guarantees a future
    // contributor can't "consolidate" the kill switches without a
    // matching design decision.
    const listSpy = vi.fn().mockResolvedValue({ items: [] })
    vi.stubEnv("LORE_DISABLE_NEAR_DUPLICATE_PROBE", "1")
    try {
      await findRelatedActiveTasks(
        { tasks: { list: listSpy } },
        { memoryTitle: "Merged PR #25750", projectId: "proj-a" },
      )
      expect(listSpy).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("returns [] when no entity candidates can be extracted (no Notion call)", async () => {
    // Title / keywords / synopsis with no entity-shaped tokens — the
    // probe degrades to "no cross-reference" rather than firing a
    // tag-only probe that would over-broaden.
    const lister = makeTaskLister([])
    const result = await findRelatedActiveTasks(
      { tasks: lister },
      {
        memoryTitle: "lowercase ramble with no entity hooks",
        memoryKeywords: "",
        memorySynopsis: "",
        projectId: "proj-a",
      },
    )
    expect(result).toEqual([])
    expect(lister.listSpy).not.toHaveBeenCalled()
  })

  it("forwards the candidate set, project, ACTIVE_TASK_STATES, and limit=5 to the lister", async () => {
    const lister = makeTaskLister([])
    await findRelatedActiveTasks(
      { tasks: lister },
      {
        memoryTitle: "Merged PR #25750",
        projectId: "proj-a",
      },
    )
    expect(lister.listSpy).toHaveBeenCalledWith({
      projectId: "proj-a",
      entities: expect.arrayContaining(["PR #25750"]),
      states: ["open", "in-progress", "blocked"],
      limit: 5,
    })
  })

  it("uses title + keywords + synopsis as the entity-extraction surface", async () => {
    const lister = makeTaskLister([])
    await findRelatedActiveTasks(
      { tasks: lister },
      {
        memoryTitle: "Shipped feature",
        memoryKeywords: "PR #25750",
        memorySynopsis: "Closes SENTRY-1234.",
        projectId: "proj-a",
      },
    )
    const call = lister.listSpy.mock.calls[0][0] as { entities: string[] }
    expect(call.entities).toContain("PR #25750")
    expect(call.entities).toContain("SENTRY-1234")
  })

  it("works when synopsis is empty (the agent didn't supply one)", async () => {
    // Pre-#02 deploys are not a runtime concern (#11 hard-deps on #02),
    // but un-supplied synopsis values are: the field is optional on
    // `lore-memory action='save'`. Probe falls back to title + keywords.
    const lister = makeTaskLister([
      makeTaskSummary({ id: "task-1", title: "Track PR #25750" }),
    ])
    const result = await findRelatedActiveTasks(
      { tasks: lister },
      {
        memoryTitle: "Merged PR #25750: classifier",
        memoryKeywords: undefined,
        memorySynopsis: undefined,
        projectId: "proj-a",
      },
    )
    expect(result.map((t) => t.id)).toEqual(["task-1"])
  })

  it("allows undefined projectId — vault-wide cross-ref is well-defined", async () => {
    // Mirrors `findDuplicateActiveTasks`: the underlying TaskService.list
    // honors `projectOrUnscopedFilter` so unscoped probes are valid.
    // A vault-wide save (no resolved project) still benefits from the
    // cross-reference — projectless tasks exist.
    const lister = makeTaskLister([
      makeTaskSummary({ id: "task-1", title: "Track PR #25750" }),
    ])
    const result = await findRelatedActiveTasks(
      { tasks: lister },
      { memoryTitle: "Merged PR #25750" },
    )
    expect(result.map((t) => t.id)).toEqual(["task-1"])
    expect(lister.listSpy).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: undefined }),
    )
  })

  it("swallows list() errors and returns [] (probe failures must not fail the save)", async () => {
    const listSpy = vi.fn().mockRejectedValue(new Error("notion 503"))
    const result = await findRelatedActiveTasks(
      { tasks: { list: listSpy } },
      { memoryTitle: "Merged PR #25750", projectId: "proj-a" },
    )
    expect(result).toEqual([])
  })

  it("invokes onError when the list query throws (operator observability)", async () => {
    const err = new Error("notion 503")
    const listSpy = vi.fn().mockRejectedValue(err)
    const onError = vi.fn()
    const result = await findRelatedActiveTasks(
      { tasks: { list: listSpy } },
      {
        memoryTitle: "Merged PR #25750",
        projectId: "proj-a",
        onError,
      },
    )
    expect(result).toEqual([])
    expect(onError).toHaveBeenCalledWith(err)
  })

  it("isolates synchronous tokenizer throws from the caller (failure-domain wrap)", async () => {
    // Outer try/catch covers BOTH the sync tokenizer and the async
    // list call. Force a sync throw by handing a malformed services
    // object whose property-access triggers a TypeError inside the
    // tokenizer pass — actually, the tokenizer is pure-string, so
    // simulate via an onError observer to confirm the wrap covers
    // any future regex-related throws (catastrophic backtracking,
    // etc.). This test pins the contract: if the helper threw,
    // `Promise.all` would reject and `handleSave` would surface a
    // save error. The wrap means we degrade to `[]`.
    const onError = vi.fn()
    // Hand a list that throws synchronously (no await) — simulates
    // a service implementation that fails to enter the async
    // boundary cleanly.
    const listSpy = vi.fn(() => {
      throw new Error("sync explosion before await")
    })
    const result = await findRelatedActiveTasks(
      { tasks: { list: listSpy as never } },
      {
        memoryTitle: "Merged PR #25750",
        projectId: "proj-a",
        onError,
      },
    )
    expect(result).toEqual([])
    expect(onError).toHaveBeenCalledTimes(1)
  })
})
