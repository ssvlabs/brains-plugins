#!/usr/bin/env bash
# brains plugin — per-turn hook. Registered on BOTH UserPromptSubmit and Stop.
# One script, branching on the stdin payload:
#
#   UserPromptSubmit  (has .prompt)            -> ingest the USER turn, then run
#                                                 the inbox engine in `prompt`
#                                                 mode (light: notifications +
#                                                 stdout micro-inject) and the
#                                                 operator user hooks. Fires
#                                                 BEFORE the model acts, so any
#                                                 inbox/profile context lands in
#                                                 this turn.
#   Stop              (has .transcript_path)   -> ingest the ASSISTANT turn, then
#                                                 run the inbox engine in `stop`
#                                                 mode (notifications only, no
#                                                 stdout). Fires AFTER the turn.
#
# Ingest is the capture path WHERE IT RUNS. It needs a credential, which now
# comes from lib/brains-credential.sh: an explicitly configured token if there
# is one, otherwise the client's own MCP OAuth store. Where the hooks do not run
# at all (claude.ai web) save_chat_session is the only path.
#
# Claude keeps the existing fire-and-forget delivery. Codex waits for its
# assistant POST during Stop so the hook process cannot finish before the
# response has been handed to the ingest endpoint.
set -u

# The same hook implementation serves both clients. Codex defines PLUGIN_ROOT;
# Claude Code invokes the explicit claude-hooks.json map without it.
CLIENT="claude"
[ -n "${PLUGIN_ROOT:-}" ] && CLIENT="codex"

BASE="${CLAUDE_PLUGIN_OPTION_ENDPOINT:-${BRAINS_ENDPOINT:-https://mcp.mybrains.ai}}"
BASE="${BASE%/}"

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HOOK_DIR/lib/brains-inbox.sh"
CRED_LIB="$HOOK_DIR/lib/brains-credential.sh"

INPUT=$(cat)
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION" ] && exit 0

PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
LAST_ASSISTANT=$(printf '%s' "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null)

STATE_DIR="${BRAINS_STATE_DIR:-${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-$HOME/.claude/brains}}}"

# ---- current time, ahead of the capture gate --------------------------------
# Inject the current LOCAL time, but at MOST once per clock-hour per session
# (first turn of a session + whenever the hour rolls over) — not every turn, so
# the model has an accurate "now" without per-turn noise.
#
# This runs BEFORE any credential work on purpose. It has nothing to do with
# capture, and while it sat behind the credential gate a user without a token
# silently lost accurate time injection as collateral.
if [ -n "$PROMPT" ]; then
  _now_key=$(date '+%Y%m%d%H')
  _now_file="$STATE_DIR/now-$SESSION"
  if [ "$_now_key" != "$(cat "$_now_file" 2>/dev/null)" ]; then
    mkdir -p "$(dirname "$_now_file")" 2>/dev/null && printf '%s' "$_now_key" > "$_now_file" 2>/dev/null
    printf '<!-- brains:now -->now: %s<!-- /brains:now -->\n' "$(date '+%a %Y-%m-%d %H:%M %Z (%z)')"
  fi
fi

# ---- capture credential -----------------------------------------------------
[ -r "$CRED_LIB" ] || exit 0
# shellcheck source=lib/brains-credential.sh
. "$CRED_LIB" || exit 0

BRAINS_CRED_CLIENT="$CLIENT"
# The endpoint set comes from the resolver so both hooks agree on which URLs
# exist; health is keyed by the origin each one resolves to.
brains_resolve_endpoints "$BASE"

LOG="$STATE_DIR/brains.log"
_mode="turn"
[ -n "$PROMPT" ] || _mode="stop"
log() { mkdir -p "$STATE_DIR" 2>/dev/null; printf '[%s] [%s] %s\n' "$(date -u +%FT%TZ)" "$_mode" "$*" >> "$LOG" 2>/dev/null; }

if ! brains_resolve_credential "$BASE"; then
  # No credential, or more than one that could be the right one. Record it so
  # the session-start hook can say so once, then behave exactly as before:
  # no request, no error, no noise on this turn.
  brains_health_note ingest "$BRAINS_URL_INGEST" "$BRAINS_CRED_STATE"
  exit 0
fi

# One line per outcome, and a healthy one only the first time in a session, so
# the log answers "is capture working" without growing by two lines a turn.
# Before this the log had never carried a single line about capture, which is
# why a credential that stopped working went unnoticed for eleven days.
capture_log() {  # role, outcome
  local role outcome marker
  role="$1"; outcome="$2"
  if [ "$outcome" = "ok" ]; then
    marker="$STATE_DIR/capok-$SESSION"
    [ -f "$marker" ] && return 0
    printf '%s' '1' > "$marker" 2>/dev/null
  fi
  log "capture $role: $outcome status=${BRAINS_HTTP_CODE:-none} source=$BRAINS_CRED_SOURCE"
}

ingest_once() {  # role, content
  local role payload outcome
  role="$1"; payload="$2"
  # An explicit ceiling on top of the resolver's default, because this is the
  # one call Codex makes SYNCHRONOUSLY: the Stop hook waits for the assistant
  # POST, so a server that accepts the connection and then never answers would
  # hold up the turn. On Claude the request is backgrounded and an unbounded one
  # would linger instead of exiting.
  if brains_request ingest "$BRAINS_URL_INGEST" --max-time 5 \
       -X POST -H "Content-Type: application/json" -d "$payload"; then
    outcome="ok"
  elif [ "$BRAINS_HTTP_BLOCKED" = "1" ]; then
    outcome="blocked"
  else
    case "${BRAINS_HTTP_CODE:-}" in
      401|403) outcome="rejected" ;;
      ''|000)  outcome="unreachable" ;;
      *)       outcome="error" ;;
    esac
  fi
  capture_log "$role" "$outcome"
}

ingest() {  # role, content
  local role content payload
  role="$1"; content="$2"
  [ -z "$content" ] && return 0
  payload=$(jq -nc --arg s "$SESSION" --arg r "$role" --arg c "$content" --arg client "$CLIENT" \
    '{session_id:$s, role:$r, content:$c, client:$client, client_type:"cli"}')
  if [ "$CLIENT" = "codex" ] && [ "$role" = "assistant" ]; then
    # Synchronous: Codex Stop must not finish before the response is delivered.
    ingest_once "$role" "$payload"
  else
    # Fire-and-forget, so this request outlives the hook. It takes its own lease
    # on the credential first — the hook's exit would otherwise remove the
    # config while curl was still starting up, and the POST would go out
    # unauthenticated.
    _lease=$(brains_cred_lease) || return 0
    ( BRAINS_CRED_CONFIG="$_lease"
      trap 'brains_cred_return "$_lease"' EXIT INT TERM HUP
      ingest_once "$role" "$payload"
      brains_cred_return "$_lease" ) &
  fi
}

if [ -n "$PROMPT" ]; then
  # ---- UserPromptSubmit: ingest user message, light inbox + user hooks -----
  ingest user "$PROMPT"

  [ -x "$LIB" ] && "$LIB" prompt "$SESSION"

elif [ -n "$LAST_ASSISTANT" ] || [ -n "$TRANSCRIPT" ]; then
  # ---- Stop: ingest the last assistant text block, drain notifications ------
  ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null)
  [ "$ACTIVE" = "true" ] && exit 0
  # Claude keeps its original path: parse the transcript. Codex has no stable
  # transcript format, so outside the Claude runtime (or if the parse yields
  # nothing) use the last_assistant_message field from the payload instead.
  CONTENT=""
  if [ -z "${PLUGIN_ROOT:-}" ] && [ -f "$TRANSCRIPT" ]; then
    CONTENT=$(jq -rs '[.[] | select(.type=="assistant") | .message.content[]? | select(.type=="text") | .text] | last // ""' \
      "$TRANSCRIPT" 2>/dev/null)
  fi
  [ -z "$CONTENT" ] && CONTENT="$LAST_ASSISTANT"
  ingest assistant "$CONTENT"

  [ -x "$LIB" ] && "$LIB" stop "$SESSION"
fi

exit 0
