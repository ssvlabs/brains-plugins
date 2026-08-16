#!/usr/bin/env bash
# brains plugin — SessionEnd hook. Minimal + clean.
# The faithful protocol has no session-close endpoint, so we don't invent one:
# we just drain any queued notifications via the inbox engine in `stop` mode
# (stdout discarded; banners still fire). Final assistant-turn ingest already
# happened on the last Stop event.
set -u

INPUT=$(cat)
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION" ] && exit 0

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HOOK_DIR/lib/brains-inbox.sh"
[ -x "$LIB" ] && "$LIB" stop "$SESSION"

# Sweep credential work directories orphaned by SIGKILL, which is untrappable so
# nothing else can have cleaned up after it. Pruning here as well as at session
# start is what keeps that backstop from meaning "until someone starts a new
# session". Best effort, never fatal, no output.
CRED_LIB="$HOOK_DIR/lib/brains-credential.sh"
if [ -r "$CRED_LIB" ]; then
  # shellcheck source=lib/brains-credential.sh
  . "$CRED_LIB" 2>/dev/null && brains_cred_prune_tmp
fi

exit 0
