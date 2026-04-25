#!/bin/bash
set -euo pipefail

# Lore wake-up hook for Claude Code and Codex
#
# Fires on:
#   - Claude Code: UserPromptSubmit (runOnce: true) — delivers the user's
#     prompt as JSON on stdin, including a `prompt` field. P3-05 forwards
#     this to the helper via LORE_WAKEUP_EVENT so wake-up can seed a
#     relevance search from the user's actual question.
#   - Codex: SessionStart (startup|resume) — typically passes empty
#     stdin since no user message exists yet. The helper falls back to
#     unranked output in that case.
# Registration lives in the assistant-specific config written by `lore install`.
# Output is captured and injected into the assistant context.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Capture stdin if any is available. `-t 0` tests whether stdin is a
# terminal: when true (no pipe), skip reading to avoid blocking forever
# on an interactive shell. When stdin is a pipe (host-assistant
# invocation), read it and forward to the helper as an env var so the
# Node process doesn't have to re-plumb stdin while still emitting
# context to its own stdout.
WAKEUP_EVENT=""
if [ ! -t 0 ]; then
  WAKEUP_EVENT="$(cat || true)"
fi

if [ -n "$WAKEUP_EVENT" ]; then
  export LORE_WAKEUP_EVENT="$WAKEUP_EVENT"
fi

# Output context to stdout for the host assistant to capture
node "$SCRIPT_DIR/../dist/hooks/helpers.js" wakeup || true
