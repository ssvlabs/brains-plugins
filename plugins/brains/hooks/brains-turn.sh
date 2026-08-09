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
# Ingest is the capture path WHERE IT RUNS, and it is credential-gated: with a
# TOKEN (see the gate below) every turn POSTs to /ingest/claude and the server
# builds the chat_session page. Without one this hook exits silently, and where
# the hooks do not run at all (claude.ai web) save_chat_session is the only path.
# Claude keeps the existing fire-and-forget delivery. Codex waits for its
# assistant POST during Stop so the hook process cannot finish before the
# response has been handed to the ingest endpoint.
set -u

# The same hook implementation serves both clients. Codex defines PLUGIN_ROOT;
# Claude Code invokes the explicit claude-hooks.json map without it.
CLIENT="claude"
[ -n "${PLUGIN_ROOT:-}" ] && CLIENT="codex"

TOKEN="${CLAUDE_PLUGIN_OPTION_TOKEN:-${BRAINS_API_TOKEN:-${BRAINS_INBOX_TOKEN:-}}}"
# Desktop-launched Codex receives BRAINS_API_TOKEN directly. A standalone
# Codex CLI can instead have an authenticated MCP transport with a persisted
# Authorization header, so reuse that same credential for automatic capture.
# `codex mcp get` is a local config read; its output is never logged.
if [ -z "$TOKEN" ] && [ "$CLIENT" = "codex" ] && command -v codex >/dev/null 2>&1; then
  AUTH_HEADER=$(codex mcp get brains --json 2>/dev/null \
    | jq -r '.transport.http_headers.Authorization // .transport.http_headers.authorization // empty' 2>/dev/null)
  case "$AUTH_HEADER" in
    "Bearer "*) TOKEN="${AUTH_HEADER#Bearer }" ;;
  esac
  unset AUTH_HEADER
fi
[ -z "$TOKEN" ] && exit 0
BASE="${CLAUDE_PLUGIN_OPTION_ENDPOINT:-${BRAINS_ENDPOINT:-https://mcp.mybrains.ai}}"
BASE="${BASE%/}"
INGEST="${BRAINS_INGEST_URL:-$BASE/ingest/claude}"

HOOK_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HOOK_DIR/lib/brains-inbox.sh"

INPUT=$(cat)
SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$SESSION" ] && exit 0

PROMPT=$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null)
TRANSCRIPT=$(printf '%s' "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
LAST_ASSISTANT=$(printf '%s' "$INPUT" | jq -r '.last_assistant_message // empty' 2>/dev/null)

ingest() {  # role, content
  local role="$1" content="$2"
  [ -z "$content" ] && return 0
  local payload
  payload=$(jq -nc --arg s "$SESSION" --arg r "$role" --arg c "$content" --arg client "$CLIENT" \
    '{session_id:$s, role:$r, content:$c, client:$client, client_type:"cli"}')
  if [ "$CLIENT" = "codex" ] && [ "$role" = "assistant" ]; then
    curl -s --max-time 5 -X POST "$INGEST" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "$payload" >/dev/null 2>&1 || true
  else
    ( curl -s --max-time 5 -X POST "$INGEST" \
        -H "Authorization: Bearer $TOKEN" \
        -H "Content-Type: application/json" \
        -d "$payload" >/dev/null 2>&1 || true ) &
  fi
}

if [ -n "$PROMPT" ]; then
  # ---- UserPromptSubmit: ingest user message, light inbox + user hooks -----
  # Inject the current LOCAL time, but at MOST once per clock-hour per session
  # (first turn of a session + whenever the hour rolls over) — not every turn, so
  # the model has an accurate "now" without per-turn noise.
  _now_key=$(date '+%Y%m%d%H')
  _now_file="${BRAINS_STATE_DIR:-$HOME/.brains}/now-$SESSION"
  if [ "$_now_key" != "$(cat "$_now_file" 2>/dev/null)" ]; then
    mkdir -p "$(dirname "$_now_file")" 2>/dev/null && printf '%s' "$_now_key" > "$_now_file" 2>/dev/null
    printf '<!-- brains:now -->now: %s<!-- /brains:now -->\n' "$(date '+%a %Y-%m-%d %H:%M %Z (%z)')"
  fi
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
