import { join, resolve } from "node:path"
import {
  findConfigFile,
  loadConfig,
  resolveAuth,
  type AuthSource,
} from "../../../config.js"
import {
  ntnEnvBaseUrl,
  ntnEnvFromBaseUrl,
  resolveOperatorBaseUrl,
} from "../../../auth/oauth.js"
import type { BinDispatchShape } from "./types.js"
import { buildClaudeMcpEntry } from "./claude.js"
import { buildCodexMcpSection } from "./codex.js"
import { resolvePkgRoot } from "./env.js"
import { fileExists } from "./utils.js"
import { describeConflictingDevSignal } from "./preflight.js"

export type PrintConfigFormat = "json" | "toml"

export function parsePrintConfigFormat(value: string): PrintConfigFormat | null {
  if (value === "json" || value === "toml") return value
  return null
}

/**
 * Render a paste-ready MCP config snippet as a string.
 *
 * Pure: takes resolved paths in, returns the snippet out. Reuses
 * `buildClaudeMcpEntry` / `buildCodexMcpSection` so the snippet stays
 * byte-identical to what `--client claude` writes to .mcp.json and
 * what `--client codex` writes to .codex/config.toml. Drift between
 * the printed shape and the on-disk shape is the failure mode this
 * reuse exists to prevent.
 */
export function buildPrintConfigOutput(
  format: PrintConfigFormat,
  mcpJsPath: string,
  pkgRoot: string,
  configRoot: string = process.cwd(),
  legacyPaths = false,
  binShape: BinDispatchShape = "bare",
  envSource: NodeJS.ProcessEnv = process.env,
  authSource?: AuthSource,
  notionBaseUrlLiteral?: string
): string {
  void mcpJsPath
  void pkgRoot
  void legacyPaths

  if (format === "json") {
    const entry = buildClaudeMcpEntry(
      binShape,
      configRoot,
      envSource,
      authSource,
      notionBaseUrlLiteral
    )
    return JSON.stringify({ mcpServers: { lore: entry } }, null, 2) + "\n"
  }

  const section = buildCodexMcpSection(
    binShape,
    configRoot,
    envSource,
    authSource,
    notionBaseUrlLiteral
  )
  return section + "\n"
}

/**
 * `--print-config` runtime path. Resolves `pkgRoot` and `mcpJsPath` via the
 * same helpers the install paths use, validates the standalone MCP entry
 * exists (the printed `args[0]` would otherwise point at a non-existent
 * file), and writes the snippet to stdout. No filesystem writes — but
 * `--project` (when present) resolves the configRoot embedded in the
 * snippet's `LORE_CONFIG_ROOT` static so the printed entry points the
 * spawned MCP server at the right .lore.yaml.
 *
 */
export async function runPrintConfig(
  format: PrintConfigFormat,
  binShape: BinDispatchShape,
  projectDir?: string,
  dev?: boolean
): Promise<void> {
  const pkgRoot = resolvePkgRoot()
  const mcpJsPath = join(pkgRoot, "dist", "mcp.js")

  if (!(await fileExists(mcpJsPath))) {
    throw new Error(`dist/mcp.js not found at ${mcpJsPath}. Run 'npm run build' first.`)
  }

  // `--dev` ↔ shell-signal conflict guard. Symmetric to the
  // fail-fast at the top of `ensurePrerequisites`: when `--dev` is
  // set AND the operator's shell carries a base-URL signal that
  // does NOT resolve to dev, abort. The print-config path is itself
  // an MCP-config generation path — under this PR's contract,
  // `lore install --dev` makes dev runtime-effective; without the
  // same guard here, `--print-config --dev` would emit a snippet
  // whose runtime MCP child silently routes to prod via the
  // operator's stale shell signal (and `LORE_NOTION_BASE_URL`
  // outranks the literal `NOTION_BASE_URL` we'd write into the
  // printed entry's `env` block, so even when we plant the literal
  // the operator's shell would still win at MCP-spawn time).
  if (dev) {
    const operatorBaseUrl = resolveOperatorBaseUrl(process.env)
    if (operatorBaseUrl !== undefined && ntnEnvFromBaseUrl(operatorBaseUrl) !== "dev") {
      const conflicting = describeConflictingDevSignal(process.env)
      console.error(
        `--dev was passed but ${conflicting} routes auth to ${operatorBaseUrl}`
      )
      console.error(
        "(not the dev base URL). Lore cannot print a coherent --dev snippet while"
      )
      console.error("the shell carries a conflicting signal — the printed env would be")
      console.error(
        "overridden by the operator's existing shell variable at MCP-spawn time."
      )
      console.error("")
      console.error("Recovery (pick one):")
      console.error("  1. Unset the conflicting shell variable, then re-run.")
      console.error("  2. Drop --dev and re-run to print the prod snippet.")
      // `process.exit(1)` + defensive `return` matches the standing
      // exit-test pattern used across the CLI: a `trapProcessExit`
      // spy records the exit code without throwing, and the
      // defensive `return` keeps execution from falling through
      // into the outer try/catch. Throwing instead would produce a
      // double-print — the action handler's outer try/catch renders
      // `Install failed: <msg>` on any thrown Error, re-emitting a
      // trailing line after the four diagnostic lines we already
      // wrote. The install-time guard above uses `return { ready: false }` for the same
      // reason; this exit-1 path is the print-config analog.
      process.exit(1)
      return
    }
  }

  const projectRoot = resolve(projectDir ?? process.cwd())
  const found = await findConfigFile(projectRoot)
  const configRoot = found?.root ?? projectRoot

  // Best-effort auth-source resolution so the printed snippet matches
  // what `--client claude` / `--client codex` would write to disk:
  // under `ntn-auth-json`, suppress the auth-token placeholders that
  // produce host-validator warnings. Print-config is intentionally
  // non-interactive: auth resolution failure is silently treated as
  // "no opinion" and the conditional-forward shape stands. The catch
  // is narrow because print-config exists for unsupported hosts and a
  // hard failure here would break the escape hatch operators depend on.
  let printConfigAuthSource: AuthSource | undefined
  if (found) {
    try {
      const config = await loadConfig(found.path)
      const auth = await resolveAuth(config, found.root)
      printConfigAuthSource = auth.source
    } catch {
      // Auth unresolvable — fall through to undefined (earlier shape).
    }
  }

  // When `--dev` is set, plant the literal dev URL into the printed
  // snippet's `staticEnv` so unsupported-host operators get the same
  // runtime base-URL contract that `--client {claude,codex,cursor}`
  // already ships: spawned MCP child targets dev regardless of
  // operator shell state. The fail-fast guard above ensures no
  // conflicting shell signal is present at this point.
  const notionBaseUrlLiteral = dev ? ntnEnvBaseUrl("dev") : undefined

  process.stdout.write(
    buildPrintConfigOutput(
      format,
      mcpJsPath,
      pkgRoot,
      configRoot,
      false,
      binShape,
      process.env,
      printConfigAuthSource,
      notionBaseUrlLiteral
    )
  )
}
