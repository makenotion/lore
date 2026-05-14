import { describe, expect, it } from "vitest"
import { composeProjectContext, renderProjectContextLines } from "./project-context.js"
import type { LoreConfig, Project } from "../types.js"

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "proj-1",
    name: "Widget",
    type: "project",
    path: "apps/widget",
    status: "active",
    description: "Widget application.",
    ...overrides,
  }
}

function makeConfig(overrides: Partial<LoreConfig> = {}): LoreConfig {
  return {
    vault: { pageId: "vault-1" },
    projects: [
      { name: "Widget", path: "apps/widget" },
      { name: "Web", path: "apps/web" },
      { name: "Desktop", path: "apps/desktop" },
    ],
    ...overrides,
  }
}

describe("composeProjectContext", () => {
  it("returns null when project is null", () => {
    const ctx = composeProjectContext(null, makeConfig(), false)
    expect(ctx).toBeNull()
  })

  it("populates a complete view from a resolved project (siblings exclude self)", () => {
    const ctx = composeProjectContext(makeProject(), makeConfig(), false)
    expect(ctx).toEqual({
      projectId: "proj-1",
      name: "Widget",
      path: "apps/widget",
      description: "Widget application.",
      isCatchAllFallback: false,
      siblings: ["Web", "Desktop"],
    })
  })

  it("filters the resolved project's own name out of siblings", () => {
    // The field names *peers*, not the full sub-project list. Without
    // this filter the renderer would print the active project as its
    // own sibling — which reads like a typo to anyone who doesn't have
    // the implementation in their head.
    const ctx = composeProjectContext(makeProject({ name: "Web" }), makeConfig(), false)
    expect(ctx?.siblings).toEqual(["Widget", "Desktop"])
  })

  it("normalizes empty description to null", () => {
    // `pageToProject` populates `description` via `extractRichText`,
    // which always returns a string — `""` when the Notion property is
    // missing. The orchestrator collapses empty/whitespace to `null` so
    // the renderer's "omit description line when empty" rule fires
    // without re-implementing the trim at every call site.
    const ctx = composeProjectContext(
      makeProject({ description: "" }),
      makeConfig(),
      false
    )
    expect(ctx?.description).toBeNull()
  })

  it("normalizes whitespace-only description to null", () => {
    const ctx = composeProjectContext(
      makeProject({ description: "   \n\t  " }),
      makeConfig(),
      false
    )
    expect(ctx?.description).toBeNull()
  })

  it("normalizes empty path to null and trims surrounding whitespace", () => {
    const ctx = composeProjectContext(
      makeProject({ path: "  apps/widget  " }),
      makeConfig(),
      false
    )
    expect(ctx?.path).toBe("apps/widget")
    const empty = composeProjectContext(makeProject({ path: "" }), makeConfig(), false)
    expect(empty?.path).toBeNull()
  })

  it("excludes catch-all entries AND self from siblings", () => {
    const config = makeConfig({
      projects: [
        { name: "Monorepo", path: "." },
        { name: "Widget", path: "apps/widget" },
        { name: "Web", path: "apps/web" },
      ],
    })
    const ctx = composeProjectContext(makeProject(), config, false)
    // Catch-all "Monorepo" filtered by `subProjectNames`; self "Widget"
    // filtered by the new self-exclusion in `composeProjectContext`.
    expect(ctx?.siblings).toEqual(["Web"])
  })

  it("returns empty siblings when only the catch-all is configured", () => {
    const config = makeConfig({
      projects: [{ name: "Monorepo", path: "." }],
    })
    const ctx = composeProjectContext(
      makeProject({ name: "Monorepo", path: "." }),
      config,
      true
    )
    expect(ctx?.siblings).toEqual([])
  })

  it("returns empty siblings when the resolved project is the only sub-project", () => {
    // Single-project vault: subProjectNames = ["Widget"], filter self → [].
    // Renderer's "omit Siblings: line when empty" rule should fire.
    const config = makeConfig({
      projects: [{ name: "Widget", path: "apps/widget" }],
    })
    const ctx = composeProjectContext(makeProject(), config, false)
    expect(ctx?.siblings).toEqual([])
  })

  it("propagates caller-supplied isCatchAllFallback verbatim", () => {
    const yes = composeProjectContext(makeProject(), makeConfig(), true)
    const no = composeProjectContext(makeProject(), makeConfig(), false)
    expect(yes?.isCatchAllFallback).toBe(true)
    expect(no?.isCatchAllFallback).toBe(false)
  })

  it("issues no Notion calls — survives a hostile config that throws on every property access", () => {
    // The "no new fetch" premise (issue 0.6.0/18, Risk/notes #1) is what
    // keeps the helper synchronous. A future contributor tempted to
    // thread `services.projects.getById` for "richer description" would
    // have to traverse a service-shaped argument; this test wraps the
    // config in a Proxy that throws on every access except the
    // `projects` array reads `subProjectNames` actually performs, so any
    // unexpected attribute lookup (a Notion-shaped `client` field, a
    // `services` reach-through) trips immediately.
    const allowed = new Set(["projects"])
    const hostileConfig = new Proxy(makeConfig(), {
      get(target, prop) {
        if (typeof prop === "string" && allowed.has(prop)) {
          return target[prop as keyof LoreConfig]
        }
        // Symbol-keyed inspector access (Symbol.toPrimitive,
        // Symbol.toStringTag) is engine-internal, not contributor-facing
        // — let it through so vitest's diff renderer doesn't blow up
        // when an assertion fails on the result.
        if (typeof prop === "symbol") {
          return Reflect.get(target as object, prop)
        }
        throw new Error(`hostile config: unexpected access to "${String(prop)}"`)
      },
    })
    expect(() => composeProjectContext(makeProject(), hostileConfig, false)).not.toThrow()
  })

  it("required-parameter count stays at 3 (no positional services arg)", () => {
    // `Function.prototype.length` counts required parameters before the
    // first default value, rest parameter, or destructured param. This
    // pins the arity so a 4th positional non-optional argument
    // (e.g. `services: LoreServices`) trips the test. A future
    // contributor adding `services?` as an *optional* 4th parameter
    // would still report length 3 — the type system catches that case
    // (no production caller would pass a 4th arg) but the
    // toString() guard below is the second-level scar.
    expect(composeProjectContext.length).toBe(3)
    expect(composeProjectContext.toString()).not.toMatch(/services\b/)
  })
})

describe("renderProjectContextLines", () => {
  it("returns an empty array when context is null", () => {
    expect(renderProjectContextLines(null)).toEqual([])
  })

  it("renders a header + description + siblings line", () => {
    const ctx = composeProjectContext(makeProject(), makeConfig(), false)
    expect(renderProjectContextLines(ctx)).toEqual([
      "Project: Widget (apps/widget)",
      "  Widget application.",
      "  Siblings: Web, Desktop.",
    ])
  })

  it("omits the description line when description is null", () => {
    const ctx = composeProjectContext(
      makeProject({ description: "" }),
      makeConfig(),
      false
    )
    expect(renderProjectContextLines(ctx)).toEqual([
      "Project: Widget (apps/widget)",
      "  Siblings: Web, Desktop.",
    ])
  })

  it("omits the siblings line when the resolved project has no peers", () => {
    // Single-project vault: siblings is empty after self-exclusion.
    const config = makeConfig({ projects: [{ name: "Widget", path: "apps/widget" }] })
    const ctx = composeProjectContext(makeProject(), config, false)
    expect(renderProjectContextLines(ctx)).toEqual([
      "Project: Widget (apps/widget)",
      "  Widget application.",
    ])
  })

  it("omits the path suffix when path is null", () => {
    const ctx = composeProjectContext(
      makeProject({ path: "" }),
      makeConfig({ projects: [] }),
      false
    )
    expect(renderProjectContextLines(ctx)?.[0]).toBe("Project: Widget")
  })

  it("prepends a catch-all warning that mirrors the save-side voice", () => {
    // The lead-in (`Scoped to catch-all "X" (monorepo-wide).
    // Sub-projects available: ...`) is byte-identical to the save-side
    // warning emitted from `src/mcp/resolve.ts`. Only the call-to-action
    // tail diverges: read tools accept `projectName` only, save tools
    // accept `projectName | projectNames`.
    const ctx = composeProjectContext(
      makeProject({ name: "Monorepo", path: "." }),
      makeConfig(),
      true
    )
    const lines = renderProjectContextLines(ctx)
    expect(lines[0]).toBe(
      `> Scoped to catch-all "Monorepo" (monorepo-wide). ` +
        `Sub-projects available: Widget, Web, Desktop. ` +
        `Pass projectName to scope to a specific sub-project.`
    )
    expect(lines[1]).toBe("Project: Monorepo (.)")
  })

  it("suppresses the catch-all warning when no siblings are configured (single-project vault)", () => {
    // Catch-all fallback with zero siblings is the degenerate
    // single-project vault case — there is no sub-project to suggest,
    // so the warning would be empty noise.
    const config = makeConfig({ projects: [{ name: "Monorepo", path: "." }] })
    const ctx = composeProjectContext(
      makeProject({ name: "Monorepo", path: "." }),
      config,
      true
    )
    const lines = renderProjectContextLines(ctx)
    expect(lines[0]).toBe("Project: Monorepo (.)")
    expect(lines.find((l) => l.startsWith(">"))).toBeUndefined()
  })
})
