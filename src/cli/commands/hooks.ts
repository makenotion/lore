import { Command } from "commander"

/**
 * Read `process.stdin` to completion when stdin is piped (i.e., not a
 * TTY). On a TTY return the empty string immediately so `lore hooks
 * wakeup` typed at an interactive prompt doesn't block forever waiting
 * on EOF — the same `[ ! -t 0 ]` guard the legacy `hooks/wakeup.sh`
 * uses.
 *
 * Decoded as utf-8. Hook payloads are JSON; the helpers further down
 * own the parse-and-recover semantics, so we just hand them the raw
 * string.
 */
async function readStdinToString(): Promise<string> {
  if (process.stdin.isTTY) return ""
  process.stdin.setEncoding("utf-8")
  const chunks: string[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as string)
  }
  return chunks.join("")
}

/**
 * `lore hooks <event>` — bin-dispatch hook entry point.
 *
 * Replaces the legacy `hooks/*.sh` shell wrappers that committed
 * absolute paths into consumer assistant config. Each subcommand reads
 * stdin directly and dispatches to the hook helpers via an
 * explicit `{ event }` parameter, skipping the `LORE_AUTOSAVE_CONTENT`
 * / `LORE_WAKEUP_EVENT` env-var indirection the shell wrappers needed
 * to bridge stdin into the Node process.
 *
 * Lazy-imports helpers.js so `lore --help` doesn't pay the helper's
 * eager Notion / Zod boot cost.
 */
export const hooksCommand = new Command("hooks").description(
  "Dispatch a Lore hook event (used by host assistants)"
)

hooksCommand
  .command("wakeup")
  .description("Wake-up hook — fires on UserPromptSubmit")
  .action(async () => {
    const stdin = await readStdinToString()
    const { wakeup } = await import("../../hooks/helpers.js")
    await wakeup({ event: stdin })
  })

hooksCommand
  .command("autosave")
  .description("Autosave hook — fires on Stop")
  .action(async () => {
    const stdin = await readStdinToString()
    // Mirror `hooks/autosave.sh`'s empty-input early-exit: a Stop event
    // with no transcript content has nothing to save and shouldn't
    // emit the `LORE_AUTOSAVE_CONTENT not set` warning the helper
    // would otherwise log.
    if (!stdin) return
    const { runAutosave } = await import("../../hooks/helpers.js")
    await runAutosave({ event: stdin })
  })

hooksCommand
  .command("session-end")
  .description("Session-end shim (compatibility for pre-0.6.0 settings)")
  .action(() => {
    // Matches `hooks/session-end.sh` byte-for-byte: exit 0, no work,
    // no output. Lore does not register a SessionEnd hook; this shim
    // exists so stale Claude Code settings stop emitting "command
    // not found" until the operator reinstalls.
    process.exit(0)
  })
