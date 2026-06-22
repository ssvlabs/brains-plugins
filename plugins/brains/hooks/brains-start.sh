#!/usr/bin/env bash
# brains plugin — SessionStart hook (the heavy one).
#   1. Inject the always-on core (core.md) as session context.
#   2. Inject the operator's custom layer (.claude/USER.md) if present — this is
#      read+printed explicitly, NOT via a core.md @-import (which would resolve
#      against the ephemeral plugin cache, not the workspace, and silently fail).
#   3. Run any operator "user hooks" (extension point) so a custom layer can
#      micro-inject its persona/profile pages.
#   4. Run the inbox engine in startup mode: report this device, pull the full
#      inbox (context + notifications + prompts), ack.
# Everything written to stdout becomes additional session context.
set -u

INPUT=$(cat)
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION" ] && exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HOOK_DIR/.." && pwd)"
LIB="$HOOK_DIR/lib/brains-inbox.sh"
CORE_MD="$PLUGIN_ROOT/core.md"

# 1. Always-on core.
[ -f "$CORE_MD" ] && cat "$CORE_MD"

# 2. Operator custom layer: .claude/USER.md, read explicitly (no @-import).
USER_MD="${BRAINS_USER_MD:-${CLAUDE_PROJECT_DIR:-$PWD}/.claude/USER.md}"
[ -f "$USER_MD" ] && { printf '\n'; cat "$USER_MD"; }

# 3. Operator user hooks (DISABLED — executing workspace-relative scripts is
#    an RCE vector: git preserves exec bits, so any cloned repo could drop a
#    hook that runs automatically with the user's token in env. Removed until
#    we have an out-of-repo allowlist / fingerprint mechanism.)

# 4. Inbox engine (device report + full inbox + ack). Emits its own context.
[ -x "$LIB" ] && "$LIB" startup "$SESSION"

exit 0
