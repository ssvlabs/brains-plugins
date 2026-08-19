#!/usr/bin/env bash
# brains plugin — SessionStart hook (the heavy one).
#   1. Inject the always-on core (core.md) as session context.
#   2. Inject the operator's custom layer (.codex/USER.md or .claude/USER.md)
#      if present — this is
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

CODEX_PLUGIN_RUNTIME=0
[ -n "${PLUGIN_ROOT:-}" ] && CODEX_PLUGIN_RUNTIME=1
HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "$HOOK_DIR/.." && pwd)"
LIB="$HOOK_DIR/lib/brains-inbox.sh"
CORE_MD="$PLUGIN_ROOT/core.md"

# 1. Always-on core.
[ -f "$CORE_MD" ] && cat "$CORE_MD"

# 2. Operator custom layer, read explicitly (no @-import). Codex checks its
#    native path first and falls back to the Claude path so one existing custom
#    layer can serve both clients.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
if [ -n "${BRAINS_USER_MD:-}" ]; then
  USER_MD="$BRAINS_USER_MD"
elif [ "$CODEX_PLUGIN_RUNTIME" = "1" ] && [ -f "$PROJECT_DIR/.codex/USER.md" ]; then
  USER_MD="$PROJECT_DIR/.codex/USER.md"
else
  USER_MD="$PROJECT_DIR/.claude/USER.md"
fi
[ -f "$USER_MD" ] && { printf '\n'; cat "$USER_MD"; }

# 3. Operator user hooks (DISABLED — executing workspace-relative scripts is
#    an RCE vector: git preserves exec bits, so any cloned repo could drop a
#    hook that runs automatically with the user's token in env. Removed until
#    we have an out-of-repo allowlist / fingerprint mechanism.)

# 4. Housekeeping. Per-session marker files (now-*, toolerr-seen-*, capok-*)
#    are written by the turn and tool-error hooks and nothing ever removed
#    them, so the data dir grew without bound. Also sweeps read directories
#    orphaned by SIGKILL, which is untrappable and so leaves no other cleanup.
#    Best effort, never fatal, no output.
CRED_LIB="$HOOK_DIR/lib/brains-credential.sh"
STATE_DIR="${BRAINS_STATE_DIR:-${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-$HOME/.claude/brains}}}"
if [ -d "$STATE_DIR" ]; then
  find "$STATE_DIR" -maxdepth 1 -type f \
    \( -name 'now-*' -o -name 'toolerr-seen-*' -o -name 'capok-*' \) \
    -mtime +7 -delete 2>/dev/null
fi
if [ -r "$CRED_LIB" ]; then
  # shellcheck source=lib/brains-credential.sh
  . "$CRED_LIB" 2>/dev/null && brains_cred_prune_tmp
fi

# 5. Inbox engine (device report + full inbox + ack). Emits its own context,
#    including the one-time capture-off signal when no credential resolves.
[ -x "$LIB" ] && "$LIB" startup "$SESSION"

exit 0
