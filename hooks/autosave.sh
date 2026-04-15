#!/bin/bash
set -euo pipefail

# Lore auto-save hook for Claude Code
#
# Fires on: Stop, PreCompact events.
# Registration lives in .claude/settings.json (via `lore install`).
#
# Stop: sync, stdout passthrough for blocking decisions.
# PreCompact: sync so the save completes before compaction.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Claude Code delivers event context as JSON on stdin
CONTENT=$(cat)

if [ -z "$CONTENT" ]; then
  exit 0
fi

export LORE_AUTOSAVE_CONTENT="$CONTENT"
export LORE_AGENT_NAME="Claude Code"

if echo "$CONTENT" | grep -qE '"Stop"'; then
  # Stop: sync, stdout passthrough for blocking decisions
  node "$SCRIPT_DIR/../dist/hooks/helpers.js" autosave
elif echo "$CONTENT" | grep -qE '"PreCompact"'; then
  # PreCompact: sync so the save completes before compaction
  node "$SCRIPT_DIR/../dist/hooks/helpers.js" autosave 2>/dev/null || true
else
  # Unknown events: background
  node "$SCRIPT_DIR/../dist/hooks/helpers.js" autosave 2>/dev/null &
fi
