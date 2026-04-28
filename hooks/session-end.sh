#!/bin/bash
set -euo pipefail

# Compatibility shim for Claude Code settings written before Lore 0.6.0.
#
# 0.6.0 removed active SessionEnd registration: `Stop` is now the only
# autosave lifecycle for both Claude Code and Codex, and auto-digest is
# scheduled off the Stop hook instead. Operators whose `.claude/.../settings.json`
# still references this script must keep getting an exit-0 invocation until
# they re-run `lore install --client claude`, which strips the stale
# registration. Without this shim, every Claude session-end event would
# emit a noisy "command not found" or "unknown hook action" error.
#
# A future release may delete this file once operators have had one release
# cycle to refresh their installs. Do not extend it with new behavior.

exit 0
