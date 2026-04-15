#!/bin/bash
set -euo pipefail

# Lore auto-save hook for Claude Code
#
# Fires on: Stop event.
# Registration lives in .claude/settings.json (via `lore install`).
#
# Stop: sync, stdout passthrough for blocking decisions.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Claude Code delivers event context as JSON on stdin
CONTENT=$(cat)

if [ -z "$CONTENT" ]; then
  exit 0
fi

export LORE_AUTOSAVE_CONTENT="$CONTENT"
export LORE_AGENT_NAME="Claude Code"

# Sync execution — stdout passthrough for blocking decisions
node "$SCRIPT_DIR/../dist/hooks/helpers.js" autosave
