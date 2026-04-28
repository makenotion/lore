/**
 * Project-context orchestrator (issue 0.6.0/18).
 *
 * Composes a renderable framing block from an already-resolved `Project`
 * row plus config + cwd state. Used by `lore-context action='wake-up'`,
 * `lore-query action='ask'`, and the shell wake-up hook to answer the
 * "what is this project, and how is it different from its siblings?"
 * question every fresh agent session needs first.
 *
 * Free-function shape, not a `ProjectService` method, by design — see
 * `src/core/AGENTS.md` "Service Class Pattern". The handlers always
 * have a resolved `Project` in hand (returned by `findByPath` / `findByName`
 * or carried on `services.context.project`), so reading the description
 * requires no additional Notion call. `siblings` and `isCatchAllFallback`
 * are config / cwd state — putting them on a service method would entangle
 * Notion-row ownership with config state and force a `projects.getById`
 * round-trip the renderers don't need.
 */

import type { LoreConfig, Project } from "../types.js"
import { formatCatchAllScopeSummary, subProjectNames } from "./context.js"

/**
 * Renderable project-context view returned by `composeProjectContext`.
 *
 * `description` is normalized from the underlying `Project.description`
 * rich_text via trim — the empty / whitespace-only case becomes `null`
 * so renderers can skip the description line without re-implementing
 * the trim.
 *
 * `siblings` is sourced from `subProjectNames(config)` with the resolved
 * project's own name filtered out — the field names *peers*, not the
 * full sub-project list. An empty array means single-project vault (or
 * the resolved project has no peers) and the renderer suppresses the
 * `Siblings:` line.
 *
 * `isCatchAllFallback` is caller-supplied because the orchestrator owns
 * cwd context, the helper does not. Explicit-projectName matches must
 * pass `false` (an explicit pick is never a catch-all fallback); the
 * auto-resolved path mirrors `services.context.isCatchAllFallback`.
 */
export interface ProjectContext {
  projectId: string
  name: string
  path: string | null
  description: string | null
  isCatchAllFallback: boolean
  siblings: string[]
}

/**
 * Compose a renderable framing block from a resolved project, the loaded
 * config, and the catch-all-fallback signal.
 *
 * Returns `null` when no project resolved at the call site (vault-wide
 * scope). Renderers MUST treat `null` as "no context block" — there is
 * no synthetic-filler path.
 *
 * Synchronous: takes an already-resolved `Project`, issues no Notion
 * calls. Pinned by the test that fails the function if it ever takes a
 * `services` argument.
 */
export function composeProjectContext(
  project: Project | null,
  config: LoreConfig,
  isCatchAllFallback: boolean,
): ProjectContext | null {
  if (!project) return null

  const trimmedPath = project.path.trim()
  const trimmedDescription = project.description.trim()

  // Filter the resolved project out of its own peer list. `subProjectNames`
  // returns every non-catch-all entry; before this filter the renderer
  // would print the active project as its own sibling. (On the catch-all
  // branch the catch-all is already excluded by `isCatchAllProject`, so
  // the filter is a no-op there.)
  const siblings = subProjectNames(config).filter((n) => n !== project.name)

  return {
    projectId: project.id,
    name: project.name,
    path: trimmedPath.length > 0 ? trimmedPath : null,
    description: trimmedDescription.length > 0 ? trimmedDescription : null,
    isCatchAllFallback,
    siblings,
  }
}

/**
 * Render the project-context block as markdown lines. Both wake-up
 * surfaces (MCP `handleWakeUp` and the shell hook) and the `ask` framing
 * paragraph share this output so the catch-all warning wording, the
 * description-omitted-when-empty rule, and the no-siblings-line rule
 * stay in lockstep.
 *
 * The catch-all warning's lead-in (`Scoped to catch-all "X"
 * (monorepo-wide). Sub-projects available: ...`) is emitted via the
 * shared `formatCatchAllScopeSummary` helper in `src/core/context.ts`
 * so it stays byte-identical to the save-side warning emitted from
 * `src/mcp/resolve.ts:54-58`. Only the call-to-action tail diverges:
 * read tools accept `projectName` only, save tools accept
 * `projectName | projectNames`.
 *
 * Returns an empty array when `context` is `null`, so callers can
 * unconditionally splat the result into a sections array without a
 * separate null check at the call site.
 */
export function renderProjectContextLines(context: ProjectContext | null): string[] {
  if (!context) return []
  const lines: string[] = []

  if (context.isCatchAllFallback && context.siblings.length > 0) {
    lines.push(
      `> ${formatCatchAllScopeSummary(context.name, context.siblings)} ` +
        `Pass projectName to scope to a specific sub-project.`,
    )
  }

  const pathSuffix = context.path ? ` (${context.path})` : ""
  lines.push(`Project: ${context.name}${pathSuffix}`)

  if (context.description) {
    lines.push(`  ${context.description}`)
  }

  if (context.siblings.length > 0) {
    lines.push(`  Siblings: ${context.siblings.join(", ")}.`)
  }

  return lines
}
