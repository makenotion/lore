#!/usr/bin/env node
/**
 * Minimal MCP-shaped env-routing probe.
 *
 * Verifies whether a Codex (or other MCP-host) invocation form routes
 * a sentinel env value into MCP-spawned children. The probe writes a
 * REDACTED env dump to `argv[2]` BEFORE entering the MCP loop so the
 * file lands regardless of whether the host completes the handshake,
 * then implements the minimum MCP server surface (`initialize`,
 * `tools/list`, `tools/call`) so the host's handshake succeeds.
 *
 * Discovery harnesses inspect the dumped env to determine whether a
 * routing form forwarded the sentinel and assert a presence/absence
 * verdict.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * Security contract (cannot persist plaintext bearers on disk)
 * ─────────────────────────────────────────────────────────────────────────
 *
 *   1. **Output path containment.** `argv[2]` must be an absolute path
 *      under either `os.tmpdir()` (resolved via `realpathSync.native`
 *      to defeat symlink escapes) or an explicit
 *      `LORE_BENCH_ENV_DUMP_DIR` allow-rooted directory the caller
 *      controls. The probe rejects paths that fail containment and
 *      paths that contain `..` segments. A future bench-runner bug,
 *      malformed YAML, or hostile fixture cannot redirect the dump
 *      to a write-anywhere primitive.
 *
 *   2. **Restrictive file mode.** The dump file is created mode 0o600
 *      via `openSync(..., "wx", 0o600)` (refuses to clobber an
 *      existing file at the same path so a hostile pre-create cannot
 *      change the mode).
 *
 *   3. **Default redaction.** Values matching bearer-shaped prefixes
 *      (`ntn_`, `development_ntn_`, `secret_`) and values for the
 *      auth-token forward keys (`NOTION_API_TOKEN`) are written as
 *      `"<redacted>"` regardless
 *      of contents. The discovery harness inspects key presence /
 *      absence and a separate sentinel key it sets specifically for
 *      the probe (e.g., `LORE_BENCH_ROUTING_SENTINEL`) — never a real
 *      bearer's value.
 *
 *   4. **Insecure raw-dump opt-in.** Setting
 *      `LORE_EVAL_BENCH_INSECURE_KEEP=1` in the probe's env (NOT the
 *      caller's shell, since Codex sandboxes the MCP-child env) bypasses
 *      redaction and writes the raw env. This exists for one purpose:
 *      direct shell invocation of the probe by an engineer who has
 *      already opted into accepting plaintext bearers on local disk.
 *      A CI run that wants the raw dump must opt in explicitly via
 *      the MCP host's `env={...}` block, which forces a deliberate
 *      operator action.
 *
 *   5. **Cleanup contract.** Consumers of this probe MUST unlink the
 *      dump file after assertions complete. Test harnesses run the
 *      probe under an `afterEach` that calls `fs.rmSync(outPath,
 *      { force: true })`. A failed test that aborts before cleanup
 *      leaves a mode-0600 redacted file under the TMPDIR-rooted
 *      directory — recoverable, but the operator should `rm` it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 */
import { closeSync, openSync, writeFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, basename, join, resolve as resolvePath, sep } from "node:path"
import { createInterface } from "node:readline"

const outPath = process.argv[2]
if (!outPath) {
  process.stderr.write(
    "mcp-env-probe: missing output path argument. " +
      "Usage: mcp-env-probe.mjs <absolute-path-under-tmpdir-or-LORE_BENCH_ENV_DUMP_DIR>\n",
  )
  process.exit(2)
}

// Reject relative paths and paths containing `..` segments outright —
// the containment check below would catch most of these, but failing
// early gives the caller a clearer diagnostic.
if (!isAbsolute(outPath)) {
  process.stderr.write(
    `mcp-env-probe: outPath "${outPath}" is not absolute. ` +
      `Absolute paths under TMPDIR or LORE_BENCH_ENV_DUMP_DIR are required.\n`,
  )
  process.exit(2)
}
if (outPath.split(sep).includes("..")) {
  process.stderr.write(
    `mcp-env-probe: outPath "${outPath}" contains ".." segments. ` +
      `Paths must be normalized to defeat symlink escapes.\n`,
  )
  process.exit(2)
}

/**
 * Resolve the allowlist root via realpathSync on each candidate so a
 * symlinked TMPDIR (common on macOS where `/tmp` → `/private/tmp`)
 * still satisfies containment. Falling back to the unresolved string
 * if `realpath` fails (directory missing) is fine — the containment
 * check then compares against the literal path, which is what the
 * caller passed.
 */
function realpathOrSelf(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

const allowedRoots = [realpathOrSelf(tmpdir())]
const explicitRoot = process.env["LORE_BENCH_ENV_DUMP_DIR"]
if (typeof explicitRoot === "string" && explicitRoot.length > 0) {
  if (!isAbsolute(explicitRoot)) {
    process.stderr.write(
      `mcp-env-probe: LORE_BENCH_ENV_DUMP_DIR "${explicitRoot}" is not absolute; ignoring.\n`,
    )
  } else {
    allowedRoots.push(realpathOrSelf(explicitRoot))
  }
}

// Resolve the parent dir via realpath so a caller passing a symlinked
// TMPDIR (the common macOS case where `/var/folders/...` → `/private/var/...`)
// still satisfies containment. Resolving the full outPath would fail
// when the file does not yet exist; resolving the parent and reattaching
// the basename works regardless.
const resolvedParent = realpathOrSelf(dirname(resolvePath(outPath)))
const resolvedOut = join(resolvedParent, basename(outPath))
const contained = allowedRoots.some((root) => {
  const withSep = root.endsWith(sep) ? root : root + sep
  return resolvedOut === root || resolvedOut.startsWith(withSep)
})
if (!contained) {
  process.stderr.write(
    `mcp-env-probe: outPath "${resolvedOut}" is not under any allowed root ` +
      `(${allowedRoots.join(", ")}). Refusing to write — would be a ` +
      `write-anywhere primitive.\n`,
  )
  process.exit(2)
}

/**
 * Redact the env block before writing unless the caller opted into the
 * insecure raw-dump path. Default redaction:
 *
 *   - Keys in BEARER_KEYS → value replaced with `"<redacted>"`.
 *   - Values matching BEARER_VALUE_PREFIXES → replaced with `"<redacted>"`.
 *   - All other keys / values written verbatim.
 *
 * The discovery harness's assertion is "key X exists and equals
 * sentinel Y" where sentinel Y is a probe-specific string the harness
 * sets in the MCP host's `env={...}` block (never a real bearer). So
 * the redaction is invisible to the discovery path while closing the
 * "real bearer landed on disk" leak.
 */
const BEARER_KEYS = new Set(["NOTION_API_TOKEN"])
const BEARER_VALUE_PREFIXES = ["ntn_", "development_ntn_", "secret_"]
const INSECURE_KEEP = process.env["LORE_EVAL_BENCH_INSECURE_KEEP"] === "1"

function redactEnv(rawEnv) {
  const out = {}
  for (const [key, value] of Object.entries(rawEnv)) {
    if (typeof value !== "string") {
      out[key] = value
      continue
    }
    if (BEARER_KEYS.has(key)) {
      out[key] = "<redacted>"
      continue
    }
    if (BEARER_VALUE_PREFIXES.some((prefix) => value.startsWith(prefix))) {
      out[key] = "<redacted>"
      continue
    }
    out[key] = value
  }
  return out
}

const envToWrite = INSECURE_KEEP ? process.env : redactEnv(process.env)

// `openSync(..., "wx", 0o600)` refuses to clobber an existing file at
// the same path — a hostile pre-create cannot change the mode by
// landing there first. The probe's contract requires the consumer to
// unlink the file after assertions, so a stale file at the path is a
// caller bug we surface as an error rather than silently overwriting.
let fd
try {
  fd = openSync(resolvedOut, "wx", 0o600)
} catch (err) {
  process.stderr.write(
    `mcp-env-probe: failed to create dump file "${resolvedOut}" with ` +
      `mode 0o600 (${err.message ?? "unknown error"}). If the file ` +
      `exists from a prior run, unlink it first.\n`,
  )
  process.exit(2)
}
try {
  writeFileSync(fd, JSON.stringify(envToWrite, null, 2))
} finally {
  // Explicit close so a future Node behavior change in writeFileSync's
  // implicit-close semantics doesn't leak fds.
  try {
    closeSync(fd)
  } catch {
    // ignore — fd may already be closed
  }
}

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n")
const rl = createInterface({ input: process.stdin })
rl.on("line", (line) => {
  let req
  try {
    req = JSON.parse(line)
  } catch {
    return
  }
  if (req.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "lore-bench-env-probe", version: "0.0.1" },
      },
    })
  } else if (req.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: {
        tools: [
          {
            name: "ping",
            description: "Returns 'pong'.",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    })
  } else if (req.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: req.id,
      result: { content: [{ type: "text", text: "pong" }] },
    })
  } else if (req.id != null) {
    send({
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32601, message: "method not found" },
    })
  }
})
