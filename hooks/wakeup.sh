#!/bin/bash
set -euo pipefail

# Lore wake-up hook for Claude Code
#
# Fires on: UserPromptSubmit (runOnce: true).
# Registration lives in .claude/settings.json (via `lore install`).
# Output is captured by Claude Code and injected into the system prompt.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Output context to stdout — Claude Code captures this
node "$SCRIPT_DIR/../dist/hooks/helpers.js" wakeup 2>/dev/null || true
