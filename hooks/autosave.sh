#!/bin/bash
set -euo pipefail

# Lore auto-save hook for Claude Code
#
# Add to Claude Code settings.json:
# "hooks": {
#   "PostToolUse": [
#     {
#       "matcher": "Stop",
#       "hooks": [{
#         "type": "command",
#         "command": "/path/to/lore/hooks/autosave.sh"
#       }]
#     }
#   ]
# }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Only run if LORE_NOTION_TOKEN is set
if [ -z "${LORE_NOTION_TOKEN:-}" ]; then
  exit 0
fi

# The hook receives context via stdin from Claude Code.
# Extract the conversation summary and save it.
CONTENT=$(cat)

if [ -z "$CONTENT" ]; then
  exit 0
fi

export LORE_AUTOSAVE_CONTENT="$CONTENT"
export LORE_AGENT_NAME="Claude Code"

# Run the helper in the background to not block Claude Code
node "$SCRIPT_DIR/../dist/hooks/helpers.js" autosave &
