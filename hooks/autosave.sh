#!/bin/bash
set -euo pipefail

# Lore auto-save hook for Claude Code and Codex
#
# Fires on: Stop event.
# Registration lives in the assistant-specific config written by `lore install`.
#
# Stop: sync, stdout passthrough for blocking decisions.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# The host assistant delivers event context as JSON on stdin
CONTENT=$(cat)

if [ -z "$CONTENT" ]; then
  exit 0
fi

export LORE_AUTOSAVE_CONTENT="$CONTENT"

# Sync execution — stdout passthrough for blocking decisions
node "$SCRIPT_DIR/../dist/hooks/helpers.js" autosave
