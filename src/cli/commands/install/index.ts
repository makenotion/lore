import { Command } from "commander"
import { createInterface } from "node:readline/promises"
import { ntnEnvBaseUrl } from "../../../auth/oauth.js"
import type { BinDispatchShape, InstallClient, InstallContext } from "./types.js"
import {
  ensurePrerequisites,
  prepareInstallContext,
  preflightCodexInstall,
} from "./preflight.js"
import { runClaudeInstall } from "./claude.js"
import { runCodexInstall } from "./codex.js"
import {
  buildCursorGlobalIgnoredNotice,
  resolveCursorMcpPath,
  runCursorInstall,
} from "./cursor.js"
import { parsePrintConfigFormat, runPrintConfig } from "./print-config.js"

export interface InstallRunners {
  claude: (
    context: InstallContext,
    rl: ReturnType<typeof createInterface> | null
  ) => Promise<void>
  codex: (
    context: InstallContext,
    rl: ReturnType<typeof createInterface> | null
  ) => Promise<void>
  cursor: (
    context: InstallContext,
    rl: ReturnType<typeof createInterface> | null,
    cursorMcpPath: string,
    useGlobalScope: boolean
  ) => Promise<void>
}

export const defaultInstallRunners: InstallRunners = {
  claude: runClaudeInstall,
  codex: runCodexInstall,
  cursor: runCursorInstall,
}

/**
 * Options consumed by `dispatchInstall`. A subset of `runInstall`'s opts —
 * the dispatcher only needs the routing target and the Cursor scope flag.
 * Tighter than passing the public `runInstall` shape so tests don't need to
 * synthesize fields the dispatcher won't read.
 */
export interface DispatchOpts {
  client: InstallClient
  cursorGlobal?: boolean
}

/**
 * Run the per-client install steps and aggregate errors. Pure-ish: takes a
 * pre-built `context` and `rl` and dispatches into the supplied `runners`.
 * Caller is responsible for prepping the context, opening/closing the
 * readline, and acting on the returned errors (typically by calling
 * `process.exit(1)`).
 *
 * Splitting this out from `runInstall` lets tests drive orchestration —
 * "did all three runners get called when one threw?" — without needing
 * the standalone MCP entry and the hook scripts on disk.
 */
export async function dispatchInstall(
  context: InstallContext,
  rl: ReturnType<typeof createInterface> | null,
  opts: DispatchOpts,
  runners: InstallRunners
): Promise<Array<{ client: string; error: unknown }>> {
  const errors: Array<{ client: string; error: unknown }> = []
  const cursorMcpPath = resolveCursorMcpPath(context.projectDir, !!opts.cursorGlobal)
  const runWithCapture = async (
    client: string,
    fn: () => Promise<void>
  ): Promise<void> => {
    try {
      await fn()
    } catch (err) {
      if (opts.client === "all") {
        errors.push({ client, error: err })
        console.error(`  ${client}: install failed (${formatInstallError(err)})`)
      } else {
        throw err
      }
    }
  }

  if (opts.client === "claude" || opts.client === "all") {
    await runWithCapture("claude", () => runners.claude(context, rl))
  }
  if (opts.client === "all") console.log()
  if (opts.client === "codex" || opts.client === "all") {
    await runWithCapture("codex", () => runners.codex(context, rl))
  }
  if (opts.client === "all") console.log()
  if (opts.client === "cursor" || opts.client === "all") {
    await runWithCapture("cursor", () =>
      runners.cursor(context, rl, cursorMcpPath, !!opts.cursorGlobal)
    )
  }

  return errors
}

export async function runInstall(
  opts: {
    client: InstallClient
    yes?: boolean
    project?: string
    cursorGlobal?: boolean
    legacyPaths?: boolean
    yarnPnp?: boolean
    ntn?: boolean
    dev?: boolean
  },
  runners: InstallRunners = defaultInstallRunners
): Promise<void> {
  const context = await prepareInstallContext(opts)

  const title =
    opts.client === "claude"
      ? "Claude Code Integration"
      : opts.client === "codex"
        ? "Codex Integration"
        : opts.client === "cursor"
          ? "Cursor Integration"
          : "AI Assistant Integration"

  console.log()
  console.log(`Lore — ${title}`)
  console.log("─".repeat(40))
  console.log(`Project: ${context.projectDir}`)
  console.log()

  const prereqs = await ensurePrerequisites(context, {
    yes: opts.yes,
    ntn: opts.ntn,
    dev: opts.dev,
  })
  if (!prereqs.ready) {
    process.exit(1)
  }
  // Stash the resolved auth source onto the install context so per-client
  // runners can pass it into `buildMcpEnv` and suppress auth-token
  // placeholders on the `ntn-auth-json` path. Mutation is
  // intentional: `prepareInstallContext` returns a fresh `InstallContext`,
  // the field is unset until this point, and only `runInstall` (this
  // function) populates it.
  context.authSource = prereqs.authSource

  // `--dev` runtime effectiveness: stash the literal dev base URL on
  // the context so each runner can pass it to `buildMcpEnv`'s
  // `notionBaseUrlLiteral` option. The MCP child then targets
  // `https://api-dev.notion.com` regardless of whether the operator's
  // shell carries the matching env signal at MCP-spawn time —
  // closing the gap where `--dev` was effective at install-time
  // preflight but silently degraded to prod at runtime. The literal
  // URL is sourced from the same canonical map (`ntnEnvBaseUrl`) the
  // ntn login path uses, so the dev URL is byte-equal to what
  // `NOTION_ENV=dev ntn login` would write into auth.json.
  if (opts.dev) {
    context.notionBaseUrlLiteral = ntnEnvBaseUrl("dev")
  }

  console.log()

  // Codex preflight is gating only when Codex is the sole target — failing
  // before the readline opens keeps the prompt session from spinning up for
  // a config that's going to error anyway. Under `--client all`, the same
  // assertion runs inside `runCodexInstall` and surfaces through the
  // captured-errors path so a bad Codex config doesn't take down Claude or
  // Cursor.
  if (opts.client === "codex") {
    await preflightCodexInstall(context)
  }

  const rl = context.skipPrompts
    ? null
    : createInterface({ input: process.stdin, output: process.stdout })

  let errors: Array<{ client: string; error: unknown }>
  try {
    errors = await dispatchInstall(context, rl, opts, runners)
  } finally {
    rl?.close()
  }

  if (errors.length > 0) {
    // Default summary stays on the `client: message` line — the CLI's
    // clean-output convention. Stack traces gate behind
    // LORE_INSTALL_DEBUG=1 so an expected failure (malformed JSON / TOML,
    // missing build artifact) doesn't drown the operator in V8 frames; an
    // unexpected failure can be re-run with the env var to surface them.
    const showStacks = process.env["LORE_INSTALL_DEBUG"] === "1"
    console.error()
    console.error(`Install completed with ${errors.length} failure(s):`)
    for (const { client, error } of errors) {
      console.error(`  ${client}: ${formatInstallError(error)}`)
      if (showStacks && error instanceof Error && error.stack) {
        console.error(
          error.stack
            .split("\n")
            .slice(1)
            .map((l) => `    ${l}`)
            .join("\n")
        )
      }
    }
    if (!showStacks) {
      console.error()
      console.error("  Re-run with LORE_INSTALL_DEBUG=1 to include stack traces.")
    }
    process.exit(1)
  }
}

function formatInstallError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export function parseInstallClient(value: string | undefined): InstallClient | null {
  if (value === undefined) return "all"
  if (value === "claude" || value === "codex" || value === "cursor" || value === "all") {
    return value
  }
  return null
}

export const installCommand = new Command("install")
  .description("Install Lore assistant integrations for the current project")
  .option("--client <assistant>", "Assistant to configure: claude, codex, cursor, or all")
  .option("--project <path>", "Project directory (default: cwd)")
  .option("--cursor-global", "Cursor only: write global Cursor MCP config")
  .option(
    "--print-config <format>",
    "Print JSON/TOML MCP config instead of writing files"
  )
  .option("--yarn-pnp", "Force Yarn PnP launch commands")
  .option("--no-yarn-pnp", "Force bare lore launch commands")
  .option("--ntn", "Use internal ntn login flow")
  .option("--dev", "Target the Notion dev environment")
  .option("-y, --yes", "Skip confirmation prompts")
  .action(
    async (opts: {
      client?: string
      project?: string
      printConfig?: string
      yes?: boolean
      cursorGlobal?: boolean
      yarnPnp?: boolean
      ntn?: boolean
      dev?: boolean
    }) => {
      try {
        if (opts.printConfig != null) {
          const format = parsePrintConfigFormat(opts.printConfig)
          if (!format) {
            // Message intentionally starts with `Install failed:` so the shape
            // matches the outer-catch path's `Install failed: <msg>` rendering;
            // a top-level rethrow would be redundant. Same posture as the
            // `--client` rejection a few lines below.
            console.error(
              `Install failed: --print-config must be 'json' or 'toml', got '${opts.printConfig}'.`
            )
            process.exit(1)
          }
          // --client, --cursor-global, and --ntn are accepted but ignored
          // when --print-config is set. The escape-hatch flag prints to stdout
          // regardless of which assistant the operator nominally targeted;
          // `--ntn` is an internal-engineer install-flow opt-in (auto-install
          // ntn + ntn login), neither of which the print-config path performs.
          // --yarn-pnp / --no-yarn-pnp, --project, AND --dev are honored —
          // they control the shape and contents of the printed snippet so
          // operators can copy-paste the right form for their consumer
          // (bin-dispatch shape default; yarn-wrapped under --yarn-pnp;
          // dev-base-URL literal under --dev). Auto-detection from `.pnp.cjs`
          // is skipped on this path because no project dir is resolved.
          const printBinShape: BinDispatchShape = opts.yarnPnp === true ? "yarn" : "bare"
          // --project resolves the configRoot embedded in the
          // printed snippet's LORE_CONFIG_ROOT so the MCP server
          // spawned from a paste finds the right .lore.yaml. This
          // is a behavior tweak from the prior "accepted but
          // ignored" comment on --project: the file-write path was
          // never meaningful, but the configRoot WAS — so honor it
          // for that one purpose only.
          await runPrintConfig(format, printBinShape, opts.project, !!opts.dev)
          return
        }

        const client = parseInstallClient(opts.client)
        if (!client) {
          console.error(
            "Install failed: --client must be one of claude, codex, cursor, or all."
          )
          process.exit(1)
        }

        const cursorGlobalNotice = buildCursorGlobalIgnoredNotice(
          opts.cursorGlobal,
          client
        )
        if (cursorGlobalNotice) {
          console.warn(cursorGlobalNotice)
        }

        await runInstall({
          client,
          project: opts.project,
          yes: opts.yes,
          cursorGlobal: opts.cursorGlobal,
          yarnPnp: opts.yarnPnp,
          ntn: opts.ntn,
          dev: opts.dev,
        })
      } catch (err) {
        console.error("Install failed:", err instanceof Error ? err.message : err)
        process.exit(1)
      }
    }
  )
