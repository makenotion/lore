#!/bin/bash
set -euo pipefail

# Lore wake-up hook for Claude Code and Codex
#
# Fires on:
#   - Claude Code: UserPromptSubmit (runOnce: true)
#   - Codex: SessionStart (startup|resume)
# Registration lives in the assistant-specific config written by `lore install`.
# Output is captured and injected into the assistant context.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Output context to stdout for the host assistant to capture
node "$SCRIPT_DIR/../dist/hooks/helpers.js" wakeup || true
