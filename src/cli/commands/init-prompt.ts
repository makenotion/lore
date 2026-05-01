/**
 * Yes/no confirmation prompt for `lore init`. Lives in its own module
 * so test code can `vi.mock("./init-prompt.js", …)` to intercept
 * `runNoArgInit`'s internal calls without mocking the entire init.ts
 * surface — the declined-prompt branches need coverage but a real-stdin
 * test would block the runner.
 *
 * The `--yes` short-circuit returns true. A non-TTY without `--yes`
 * returns false and emits a stderr "pass --yes" hint so CI invocations
 * that drop into the prompt produce a clear actionable message rather
 * than hanging on stdin. Otherwise reads a line from stdin and treats
 * `[Y/n]` defaults as yes (only an explicit "n" / "no" returns false).
 *
 * Mirrors install.ts's `confirm` helper but doesn't share its
 * readline-lifetime management — each prompt creates and closes its
 * own readline interface.
 */
import { stdin, stdout } from "node:process"
import { createInterface } from "node:readline/promises"

export async function confirmPrompt(message: string, yesFlag: boolean): Promise<boolean> {
  if (yesFlag) return true
  if (!stdin.isTTY) {
    console.error("Non-interactive context detected. Pass --yes to confirm prompts.")
    return false
  }
  const rl = createInterface({ input: stdin, output: stdout })
  try {
    const answer = await rl.question(message)
    const normalized = answer.trim().toLowerCase()
    if (normalized === "") return true
    return normalized === "y" || normalized === "yes"
  } finally {
    rl.close()
  }
}
