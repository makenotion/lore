#!/bin/bash
set -euo pipefail

# Lore session-end hook for Claude Code
#
# Fires on: SessionEnd event.
# Registration lives in .claude/settings.json (via `lore install`).
#
# Non-blocking: spawns a background claude -p process for structured saves
# when the Stop hook did not already handle the session. Never prevents exit.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Claude Code delivers event context as JSON on stdin
CONTENT=$(cat)

if [ -z "$CONTENT" ]; then
  exit 0
fi

export LORE_SESSION_END_CONTENT="$CONTENT"
export LORE_AGENT_NAME="Claude Code"

# Non-blocking: fail-open, stderr preserved for diagnostics
node "$SCRIPT_DIR/../dist/hooks/helpers.js" session-end || true
