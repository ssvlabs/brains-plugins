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

exit 0
