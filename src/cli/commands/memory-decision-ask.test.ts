import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { initServices, type LoreServices } from "../../services.js"
import type { Decision, Fact, Memory, Project, TaskSummary } from "../../types.js"
import { INVALID_LIMIT_STRINGS, trapProcessExit } from "../test-helpers.js"
import { readTextSource } from "./common.js"
import { memoryCommand, parseMemorySaveCliOptions, runMemorySave } from "./memory.js"
import {
  decisionCommand,
  parseDecisionCreateCliOptions,
  runDecisionCreate,
} from "./decision.js"
import { askCommand, parseAskCliOptions, runAskCli } from "./ask.js"

vi.mock("../../services.js", () => ({
  initServices: vi.fn(),
}))

const project: Project = {
  id: "p-widget",
  name: "Widget",
  type: "project",
  path: ".",
  status: "active",
  description: "",
}

function makeMemory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m-1",
    title: "Saved note",
    projectIds: ["p-widget"],
    topicId: "topic-1",
    source: "manual",
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
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    taskState: null,
    blockedBy: "",
    entity: "",
    topicKey: "",
    revisionCount: 1,
    comparedWith: [],
    compareNotes: "",
    scope: null,
    pinned: null,
    ...overrides,
  }
}

function makeDecision(overrides: Partial<Decision> = {}): Decision {
  return {
    ...makeMemory({
      id: "d-1",
      title: "Use PAT auth",
      kind: "decision",
      status: "accepted",
      confidence: "likely",
      decidedAt: "2026-05-14",
      content: "Because it is per-user.",
    }),
    kind: "decision",
    ...overrides,
  }
}

function makeFact(overrides: Partial<Fact> = {}): Fact {
  return {
    id: "f-1",
    subject: "Auth",
    predicate: "decided_by",
    object: "d-1",
    projectIds: ["p-widget"],
    validFrom: "2026-05-14",
    validUntil: null,
    reviewBy: null,
    sourceMemoryId: "d-1",
    confidence: "likely",
    confidenceScore: null,
    lastReferencedAt: null,
    createdAt: "2026-05-14T00:00:00.000Z",
    subjectEntityId: null,
    objectEntityId: null,
    scope: null,
    observedAt: null,
    invalidatedAt: null,
    ...overrides,
  }
}

function makeServices(overrides: Partial<LoreServices> = {}): LoreServices {
  return {
    projects: {
      findByName: vi.fn(async (name: string) => (name === "Widget" ? project : null)),
    },
    topics: {
      getOrCreate: vi.fn(async () => ({ id: "topic-1", name: "Auth" })),
    },
    memories: {
      create: vi.fn(async () => makeMemory()),
      getTitleById: vi.fn(async () => null),
      getManyById: vi.fn(async () => []),
      touchOnRead: vi.fn(async () => undefined),
      decrementConfidence: vi.fn(async () => undefined),
    },
    decisions: {
      create: vi.fn(async () => makeDecision()),
      getById: vi.fn(async () => makeDecision()),
      supersede: vi.fn(async () => undefined),
    },
    facts: {
      create: vi.fn(async () => makeFact()),
      queryByEntity: vi.fn(async () => []),
      queryByObject: vi.fn(async () => []),
      queryBySourceMemory: vi.fn(async () => []),
      touchOnRead: vi.fn(async () => undefined),
    },
    entities: {
      resolveOrCreateEntity: vi.fn(async (name: string) => ({
        entity: { id: `e-${name}`, name, aliases: [], kind: "", projectIds: [] },
        ambiguous: false,
        candidates: [],
        created: false,
      })),
    },
    tasks: {
      list: vi.fn(async () => ({ items: [] as TaskSummary[] })),
    },
    context: { project, isCatchAllFallback: false, cwd: process.cwd() },
    config: { projects: [] },
    features: {
      confidenceFactor: true,
      autoMentions: true,
      taskCrossref: true,
      runTool: {
        enabled: false,
        blockEdit: false,
        filterSql: false,
        search: false,
        aggregate: false,
        batchCreates: false,
      },
    },
    ...overrides,
  } as unknown as LoreServices
}

describe("memory save CLI", () => {
  it("parses content source, tags, dates, and metadata", () => {
    const result = parseMemorySaveCliOptions(
      "Auth note",
      {
        content: "Body",
        project: "Widget",
        topic: "Auth",
        kind: "runbook",
        tags: "backend,testing",
        confidence: "likely",
        reviewBy: "2026-06-01",
        decidedAt: "2026-05-14",
      },
      ["backend", "testing"]
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.kind).toBe("runbook")
      expect(result.value.tags).toEqual(["backend", "testing"])
      expect(result.value.contentSource).toEqual({ kind: "inline", value: "Body" })
    }
  })

  it("rejects missing and duplicate body sources", () => {
    expect(parseMemorySaveCliOptions("Title", {}, ["backend"]).ok).toBe(false)
    expect(
      parseMemorySaveCliOptions("Title", { content: "Body", contentFile: "body.md" }, [
        "backend",
      ]).ok
    ).toBe(false)
  })

  it("reads --content-file - from stdin", async () => {
    const body = await readTextSource(
      { kind: "stdin", value: "-" },
      Readable.from(["from stdin"])
    )

    expect(body).toBe("from stdin")
  })

  it("calls MemoryService.create with resolved project and topic", async () => {
    const services = makeServices()
    const parsed = parseMemorySaveCliOptions(
      "Auth note",
      { content: "Body", project: "Widget", topic: "Auth", tags: "backend" },
      ["backend"]
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const result = await runMemorySave(services, parsed.value, "Body")

    expect(services.topics.getOrCreate).toHaveBeenCalledWith("Auth", ["p-widget"])
    expect(services.memories.create).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Auth note",
        content: "Body",
        projectIds: ["p-widget"],
        topicId: "topic-1",
        source: "manual",
        tags: ["backend"],
      })
    )
    expect(result.data).toEqual(
      expect.objectContaining({
        id: "m-1",
        title: "Saved note",
        url: "https://notion.so/m1",
      })
    )
  })
})

describe("decision create CLI", () => {
  it("parses rationale source, affects, supersedes, tags, and dates", () => {
    const result = parseDecisionCreateCliOptions(
      "Use PAT auth",
      {
        rationale: "Because",
        affects: "Auth, Tokens",
        supersedes: "old-1, old-2",
        tags: "backend",
        reviewBy: "2026-06-01",
      },
      ["backend"]
    )

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.affects).toEqual(["Auth", "Tokens"])
      expect(result.value.supersedesIds).toEqual(["old-1", "old-2"])
      expect(result.value.rationaleSource).toEqual({
        kind: "inline",
        value: "Because",
      })
    }
  })

  it("reads --rationale-file - from stdin", async () => {
    const rationale = await readTextSource(
      { kind: "stdin", value: "-" },
      Readable.from(["rationale stdin"])
    )

    expect(rationale).toBe("rationale stdin")
  })

  it("creates a decision and decided_by facts for affected entities", async () => {
    const services = makeServices()
    const parsed = parseDecisionCreateCliOptions(
      "Use PAT auth",
      {
        rationale: "Because",
        project: "Widget",
        topic: "Auth",
        affects: "AuthService",
        confidence: "likely",
      },
      []
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const result = await runDecisionCreate(services, parsed.value, "Because")

    expect(services.decisions.create).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "Use PAT auth",
        rationale: "Because",
        projectIds: ["p-widget"],
        topicId: "topic-1",
        confidence: "likely",
      })
    )
    expect(services.entities.resolveOrCreateEntity).toHaveBeenCalledWith(
      "AuthService",
      expect.objectContaining({ autoCreate: true, projectIds: ["p-widget"] })
    )
    expect(services.facts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "AuthService",
        predicate: "decided_by",
        object: "d-1",
        sourceMemoryId: "d-1",
        subjectEntityId: "e-AuthService",
      })
    )
    expect(result.data.decidedByFactIds).toEqual(["f-1"])
  })

  it("marks superseded decisions and writes supersession graph facts", async () => {
    const services = makeServices()
    const parsed = parseDecisionCreateCliOptions(
      "Use PAT auth",
      {
        rationale: "Because",
        project: "Widget",
        supersedes: "old-decision",
        confidence: "likely",
      },
      []
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    const result = await runDecisionCreate(services, parsed.value, "Because")

    expect(services.decisions.create).toHaveBeenCalledWith(
      expect.not.objectContaining({
        supersedesIds: expect.any(Array),
      })
    )
    expect(services.decisions.getById).toHaveBeenCalledWith("old-decision")
    expect(services.decisions.supersede).toHaveBeenCalledWith("d-1", "old-decision")
    expect(services.facts.create).toHaveBeenCalledWith(
      expect.objectContaining({
        subject: "d-1",
        predicate: "supersedes_decision",
        object: "old-decision",
        sourceMemoryId: "d-1",
      })
    )
    expect(services.facts.queryBySourceMemory).toHaveBeenCalledWith(
      "old-decision",
      expect.objectContaining({ predicates: ["decided_by"], includeOutOfScope: true })
    )
    expect(services.memories.decrementConfidence).toHaveBeenCalled()
    expect(result.data.superseded).toEqual([
      { id: "old-decision", title: "Use PAT auth" },
    ])
    expect(result.data.supersedesFactIds).toEqual(["f-1"])
  })

  it("does not prewrite supersedes relations before graph steps succeed", async () => {
    const services = makeServices()
    vi.mocked(services.facts.create).mockRejectedValueOnce(new Error("fact write failed"))
    const parsed = parseDecisionCreateCliOptions(
      "Use PAT auth",
      {
        rationale: "Because",
        affects: "AuthService",
        supersedes: "old-decision",
      },
      []
    )
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    await expect(runDecisionCreate(services, parsed.value, "Because")).rejects.toThrow(
      "Pending supersessions not attempted: old-decision"
    )

    expect(services.decisions.create).toHaveBeenCalledWith(
      expect.not.objectContaining({
        supersedesIds: expect.any(Array),
      })
    )
    expect(services.decisions.supersede).not.toHaveBeenCalled()
    expect(services.decisions.getById).not.toHaveBeenCalled()
  })
})

describe("ask CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("parses strict limit and as-of date", () => {
    const result = parseAskCliOptions("Auth", {
      limit: "10",
      asOf: "2026-05-14",
      history: true,
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toEqual({
        entity: "Auth",
        projectName: undefined,
        limit: 10,
        asOf: "2026-05-14",
        includeHistory: true,
      })
    }
  })

  it("does not auto-create entities on read", async () => {
    const services = makeServices()

    await runAskCli(services, {
      entity: "Auth",
      projectName: "Widget",
      limit: 5,
      asOf: undefined,
      includeHistory: false,
    })

    expect(services.entities.resolveOrCreateEntity).toHaveBeenCalledWith("Auth", {
      autoCreate: false,
    })
    expect(services.facts.queryByEntity).toHaveBeenCalledWith(
      "Auth",
      expect.objectContaining({
        projectId: "p-widget",
        entityId: "e-Auth",
      })
    )
  })
})

describe("command exit paths", () => {
  let errorSpy: ReturnType<typeof vi.fn>
  let exitTrap: ReturnType<typeof trapProcessExit>
  let tempDirs: string[] = []

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    exitTrap = trapProcessExit()
    errorSpy = vi.fn()
    vi.spyOn(console, "error").mockImplementation(errorSpy)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
    tempDirs = []
  })

  async function tempFile(content: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "lore-cli-exit-"))
    tempDirs.push(dir)
    const file = join(dir, "body.md")
    await writeFile(file, content)
    return file
  }

  function expectSingleExit(prefix: string): void {
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(prefix)
    expect(exitTrap.exitCodes).toEqual([1])
  }

  it("memory save rejects parse failures before initServices", async () => {
    await memoryCommand.parseAsync(["save", "Auth note"], { from: "user" })

    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
    expectSingleExit("Memory save failed:")
  })

  it("memory save rejects empty file bodies before initServices", async () => {
    const file = await tempFile("")

    await memoryCommand.parseAsync(["save", "Auth note", "--content-file", file], {
      from: "user",
    })

    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
    expectSingleExit("Memory save failed:")
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "--content must be a non-empty string"
    )
  })

  it("memory save exits once on initServices failure", async () => {
    vi.mocked(initServices).mockRejectedValue(new Error("notion 503"))

    await memoryCommand.parseAsync(["save", "Auth note", "--content", "Body"], {
      from: "user",
    })

    expect(vi.mocked(initServices)).toHaveBeenCalledTimes(1)
    expectSingleExit("Memory save failed:")
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("notion 503")
  })

  it("decision create rejects parse failures before initServices", async () => {
    await decisionCommand.parseAsync(["create", "Use PAT auth"], { from: "user" })

    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
    expectSingleExit("Decision create failed:")
  })

  it("decision create rejects empty file bodies before initServices", async () => {
    const file = await tempFile("")

    await decisionCommand.parseAsync(
      ["create", "Use PAT auth", "--rationale-file", file],
      { from: "user" }
    )

    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
    expectSingleExit("Decision create failed:")
    expect(errorSpy.mock.calls.flat().join("\n")).toContain(
      "--rationale must be a non-empty string"
    )
  })

  it("decision create exits once on initServices failure", async () => {
    vi.mocked(initServices).mockRejectedValue(new Error("config missing"))

    await decisionCommand.parseAsync(
      ["create", "Use PAT auth", "--rationale", "Because"],
      { from: "user" }
    )

    expect(vi.mocked(initServices)).toHaveBeenCalledTimes(1)
    expectSingleExit("Decision create failed:")
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("config missing")
  })

  it.each(INVALID_LIMIT_STRINGS)(
    "ask rejects malformed --limit %s before initServices",
    async (raw) => {
      await askCommand.parseAsync(["Auth", "--limit", raw], { from: "user" })

      expect(vi.mocked(initServices)).not.toHaveBeenCalled()
      expectSingleExit("Ask failed:")
    }
  )

  it("ask rejects empty --limit before initServices", async () => {
    await askCommand.parseAsync(["Auth", "--limit", ""], { from: "user" })

    expect(vi.mocked(initServices)).not.toHaveBeenCalled()
    expectSingleExit("Ask failed:")
  })

  it("ask exits once on initServices failure", async () => {
    vi.mocked(initServices).mockRejectedValue(new Error("vault missing"))

    await askCommand.parseAsync(["Auth"], { from: "user" })

    expect(vi.mocked(initServices)).toHaveBeenCalledTimes(1)
    expectSingleExit("Ask failed:")
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("vault missing")
  })
})

describe("command JSON output", () => {
  let logSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.mocked(initServices).mockReset()
    logSpy = vi.fn()
    vi.spyOn(console, "log").mockImplementation(logSpy)
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("memory save --json emits id/title/url", async () => {
    vi.mocked(initServices).mockResolvedValue(makeServices())

    await memoryCommand.parseAsync(["save", "Auth note", "--content", "Body", "--json"], {
      from: "user",
    })

    const data = JSON.parse(logSpy.mock.calls[0]![0] as string) as {
      id: string
      title: string
      url: string
    }
    expect(data).toEqual(
      expect.objectContaining({
        id: "m-1",
        title: "Saved note",
        url: "https://notion.so/m1",
      })
    )
  })

  it("decision create --json emits id/decision/url", async () => {
    vi.mocked(initServices).mockResolvedValue(makeServices())

    await decisionCommand.parseAsync(
      ["create", "Use PAT auth", "--rationale", "Because", "--json"],
      { from: "user" }
    )

    const data = JSON.parse(logSpy.mock.calls[0]![0] as string) as {
      id: string
      decision: string
      url: string
    }
    expect(data).toEqual(
      expect.objectContaining({
        id: "d-1",
        decision: "Use PAT auth",
        url: "https://notion.so/d1",
      })
    )
  })

  it("ask --json emits structured facts, tasks, and warnings", async () => {
    vi.mocked(initServices).mockResolvedValue(makeServices())

    await askCommand.parseAsync(["Auth", "--json"], { from: "user" })

    const data = JSON.parse(logSpy.mock.calls[0]![0] as string) as {
      entity: string
      facts: { governance: unknown[]; structure: unknown[] }
      tasks: unknown[]
      warnings: string[]
    }
    expect(data).toEqual(
      expect.objectContaining({
        entity: "Auth",
        facts: { governance: [], structure: [] },
        tasks: [],
        warnings: [],
      })
    )
  })
})
