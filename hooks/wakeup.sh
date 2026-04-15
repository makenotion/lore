#!/bin/bash
set -euo pipefail

# Lore wake-up hook for Claude Code
#
# Add to Claude Code settings.json:
# "hooks": {
#   "PreToolUse": [
#     {
#       "matcher": "Task",
#       "hooks": [{
#         "type": "command",
#         "command": "/path/to/lore/hooks/wakeup.sh"
#       }]
#     }
#   ]
# }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Only run if LORE_NOTION_TOKEN is set
if [ -z "${LORE_NOTION_TOKEN:-}" ]; then
  exit 0
fi

# Output context to stdout — Claude Code captures this
node "$SCRIPT_DIR/../dist/hooks/helpers.js" wakeup 2>/dev/null
