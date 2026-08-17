#!/usr/bin/env bash
# brains plugin — inbox engine (shared lib).
# Called by brains-start.sh / brains-turn.sh / brains-end.sh.
#
# Usage:  brains-inbox.sh <mode> <session_id>
#   mode: startup | prompt | stop
#
# This is the v0.2 inbox dispatcher, adapted for the plugin runtime:
#   - the credential comes from lib/brains-credential.sh: an explicitly
#     configured token if there is one, otherwise the client's own MCP OAuth
#     store. The endpoint comes from Claude userConfig or BRAINS_ENDPOINT.
#   - state (log / device-id / state.json) lives in plugin persistent data
#   - the device "sections" report scans the plugin's core.md (not a CLAUDE.md)
# The HTTP protocol (devices / inbox / ack) is IDENTICAL to the standalone hook.
#
# Two action types only:
#   notification — OS banner. Hook fires it and auto-acks. Nothing reaches
#                  Claude's context.
#   prompt       — server-authored markdown. Hook injects verbatim, wrapped
#                  in <!-- brains:prompt id=… --> markers. Does NOT auto-ack;
#                  the body tells Claude how to ack (mcp__brains__ack_inbox_action).
#
# Per-mode policy:
#   startup  3s  notification + prompt   stdout emitted as session context
#   prompt   2s  notification only       stdout emitted as turn context
#   stop     3s  notification only       stdout discarded (banners still fire)
#
# Never blocks the parent hook beyond its timeout. Exits 0 on any failure.

set -u

MODE="${1:-startup}"
SESSION="${2:-}"
[ -z "$SESSION" ] && exit 0

# --- config: plugin userConfig first, env overrides for tests --------------
BASE="${CLAUDE_PLUGIN_OPTION_ENDPOINT:-${BRAINS_ENDPOINT:-https://mcp.mybrains.ai}}"
BASE="${BASE%/}"  # strip any trailing slash

# --- paths: plugin code dir (ephemeral) vs data dir (persistent) -----------
CODEX_PLUGIN_RUNTIME=0
[ -n "${PLUGIN_ROOT:-}" ] && CODEX_PLUGIN_RUNTIME=1
SELF="${BASH_SOURCE[0]}"
LIB_DIR="$(cd "$(dirname "$SELF")" && pwd)"
PLUGIN_ROOT="$(cd "$LIB_DIR/../.." && pwd)"
CORE_MD="${BRAINS_CORE_MD:-$PLUGIN_ROOT/core.md}"

STATE_DIR="${BRAINS_STATE_DIR:-${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-$HOME/.claude/brains}}}"
mkdir -p "$STATE_DIR" 2>/dev/null || true
LOG="$STATE_DIR/brains.log"
STATE_FILE="$STATE_DIR/brains-state.json"
DEVICE_FILE="$STATE_DIR/brains-device-id"
[ -f "$STATE_FILE" ] || printf '%s\n' '{}' > "$STATE_FILE" 2>/dev/null || true

case "$MODE" in
  startup) TIMEOUT=3; ALLOWED_TYPES="notification prompt"; EMIT_STDOUT=1 ;;
  prompt)  TIMEOUT=2; ALLOWED_TYPES="notification";        EMIT_STDOUT=1 ;;
  stop)    TIMEOUT=3; ALLOWED_TYPES="notification";        EMIT_STDOUT=0 ;;
  *) exit 0 ;;
esac

log() { printf '[%s] [%s] %s\n' "$(date -u +%FT%TZ)" "$MODE" "$*" >> "$LOG" 2>/dev/null; }

# --- credential: the same resolver the turn hook uses ----------------------
# Both scripts used to build their own credential chain, and they disagreed:
# the turn hook scavenged a Codex MCP header and this one did not, so a Codex
# user with header auth had capture ON and the inbox OFF. One resolver, one
# request function, both behaviours identical by construction.
CRED_LIB="$LIB_DIR/brains-credential.sh"
[ -r "$CRED_LIB" ] || exit 0
# shellcheck source=brains-credential.sh
. "$CRED_LIB" || exit 0

BRAINS_CRED_CLIENT="claude"
[ "$CODEX_PLUGIN_RUNTIME" = "1" ] && BRAINS_CRED_CLIENT="codex"
# Same endpoint set the turn hook uses, from the same place — so the
# session-start signal can find the capture health the turn hook wrote.
brains_resolve_endpoints "$BASE"
ENDPOINT="$BRAINS_URL_INBOX"
ACK_ENDPOINT="$BRAINS_URL_ACK"
DEVICES_ENDPOINT="$BRAINS_URL_DEVICES"

if ! brains_resolve_credential "$BASE"; then
  brains_health_note inbox "$ENDPOINT" "$BRAINS_CRED_STATE"
  # Told here rather than after the gate: the whole point is to say something
  # when NO credential resolved, which is exactly when everything below is
  # skipped. Raised on prompt as well as startup, because a token revoked
  # mid-thread would otherwise lose every remaining turn in silence until the
  # next session begins. The once-per-cause claim keeps it to a single mention
  # either way.
  case "$MODE" in startup|prompt) brains_capture_signal ;; esac
  exit 0
fi
case "$MODE" in startup|prompt) brains_capture_signal ;; esac

# Detect IANA timezone — server uses it to populate users.timezone.
detect_tz() {
  local tz=""
  if command -v timedatectl >/dev/null 2>&1; then
    tz=$(timedatectl show -p Timezone --value 2>/dev/null)
  fi
  if [ -z "$tz" ] && [ -L /etc/localtime ]; then
    tz=$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||')
  fi
  if [ -z "$tz" ] && [ -f /etc/timezone ]; then
    tz=$(cat /etc/timezone 2>/dev/null)
  fi
  printf '%s' "$tz"
}
TZ_IANA=$(detect_tz)
TZ_QS=""
[ -n "$TZ_IANA" ] && TZ_QS="&tz=$TZ_IANA"

# Device identity. Each (STATE_DIR, hostname) pair is one device on the server.
# On startup we report the brains-managed sections visible in core.md so the
# server knows which core/skill versions this device has installed.
DEVICE_ID=""
[ -f "$DEVICE_FILE" ] && DEVICE_ID=$(cat "$DEVICE_FILE" 2>/dev/null)

if [ "$MODE" = "startup" ]; then
  SECTIONS_JSON='[]'
  if [ -f "$CORE_MD" ]; then
    SECTIONS_JSON=$(grep -oE '<!-- brains:[a-z][a-z0-9_:-]*:start( v=[0-9]+)? -->' "$CORE_MD" 2>/dev/null \
      | sed -E -e 's|<!-- brains:([a-z][a-z0-9_:-]*):start v=([0-9]+) -->|{"name":"\1","version":\2}|' \
              -e 's|<!-- brains:([a-z][a-z0-9_:-]*):start -->|{"name":"\1","version":0}|' \
      | jq -s '.' 2>/dev/null || printf '%s' '[]')
  fi
  HOSTNAME_VAL=$(hostname 2>/dev/null || printf 'unknown')
  # Plugin semver from the manifest — lets the server tell which release a
  # device runs. Empty/unreadable manifest just omits the field; never fatal.
  if [ "$CODEX_PLUGIN_RUNTIME" = "1" ] && [ -f "$PLUGIN_ROOT/.codex-plugin/plugin.json" ]; then
    CLIENT="codex"
    PLUGIN_VERSION=$(jq -r '.version // empty' "$PLUGIN_ROOT/.codex-plugin/plugin.json" 2>/dev/null || printf '')
  else
    CLIENT="claude"
    PLUGIN_VERSION=$(jq -r '.version // empty' "$PLUGIN_ROOT/.claude-plugin/plugin.json" 2>/dev/null || printf '')
  fi
  # Marketplace auto-update state. The marketplace name is the path segment
  # under plugins/cache/<name>/… ; fall back to "brains" when off-cache.
  # autoUpdate is a per-marketplace boolean (key absent = off); anything we
  # can't parse stays unknown ("") so we neither report nor nudge.
  AUTO_UPDATE=""
  MARKETPLACE="brains"
  if [ "$CLIENT" = "claude" ]; then
    case "$PLUGIN_ROOT" in
      */plugins/cache/*) _mp="${PLUGIN_ROOT#*/plugins/cache/}"; _mp="${_mp%%/*}"; [ -n "$_mp" ] && MARKETPLACE="$_mp" ;;
    esac
    MARKETPLACES_JSON="${BRAINS_MARKETPLACES_JSON:-${CLAUDE_CONFIG_DIR:-$HOME/.claude}/plugins/known_marketplaces.json}"
    [ -f "$MARKETPLACES_JSON" ] && AUTO_UPDATE=$(jq -r --arg m "$MARKETPLACE" \
      'if .[$m].autoUpdate == true then "true" else "false" end' "$MARKETPLACES_JSON" 2>/dev/null || printf '')
  fi
  REPORT_BODY=$(jq -nc \
    --arg h "$HOSTNAME_VAL" \
    --arg pv "$PLUGIN_VERSION" \
    --arg au "$AUTO_UPDATE" \
    --argjson s "$SECTIONS_JSON" \
    --arg client "$CLIENT" \
    '{hostname:$h, sections:$s, client:$client, client_type:"cli"}
     + (if $pv != "" then {plugin_version:$pv} else {} end)
     + (if $au != "" then {auto_update: ($au == "true")} else {} end)')
  REPORT_RESP=""
  if brains_request devices "$DEVICES_ENDPOINT" --max-time 4 -X POST \
       -H "Content-Type: application/json" -d "$REPORT_BODY"; then
    REPORT_RESP="$BRAINS_HTTP_BODY"
  else
    log "device report failed: status=${BRAINS_HTTP_CODE:-none} source=$BRAINS_CRED_SOURCE"
  fi
  NEW_DEVICE_ID=$(printf '%s' "$REPORT_RESP" | jq -r '.device_id // empty' 2>/dev/null)
  if [ -n "$NEW_DEVICE_ID" ]; then
    DEVICE_ID="$NEW_DEVICE_ID"
    printf '%s' "$DEVICE_ID" > "$DEVICE_FILE" 2>/dev/null || true
    log "device reported, id=$DEVICE_ID sections=$(printf '%s' "$SECTIONS_JSON" | jq 'length')"
  fi
  # Drift: catalogued sections this device trails canonical on (server-
  # computed). We nudge ONLY on `core` — plugin devices never carry the
  # legacy brains:install / brains:claude-md sections, so those read as
  # perpetually behind and a fallback would fire a false nudge every session.
  # The line owns the how-to-update text; the hook just shows it. Emitted here
  # (not via the inbox EMIT path below) so a slow/failed inbox pull can't
  # swallow it.
  DRIFT_LINE=$(printf '%s' "$REPORT_RESP" | jq -r '
    (.drift // []) | map(select(.section == "core")) | .[0]
    | if . == null then empty
      else "core v\(.installed // 0) -> v\(.canonical)" end' 2>/dev/null)
  if [ -n "$DRIFT_LINE" ]; then
    if [ "$CLIENT" = "codex" ]; then
      printf '%s\n' '<!-- brains:update -->brains plugin update available ('"$DRIFT_LINE"'): offer to run `codex plugin marketplace upgrade brains && codex plugin add brains@brains`, then start a new thread<!-- /brains:update -->'
    else
      printf '%s\n' '<!-- brains:update -->brains plugin update available ('"$DRIFT_LINE"'): offer to run `claude plugin marketplace update brains && claude plugin update brains && claude mcp login plugin:brains:brains`, then /reload-plugins<!-- /brains:update -->'
    fi
    log "drift nudge: $DRIFT_LINE"
  fi
  # Auto-update OFF → nudge exactly once per device (marker in STATE_DIR), so
  # we never re-raise it even if the user declines. Unknown state never nudges.
  AUTOUPD_MARKER="$STATE_DIR/autoupd-nudged"
  if [ "$CLIENT" = "claude" ] && [ "$AUTO_UPDATE" = "false" ] && [ ! -f "$AUTOUPD_MARKER" ]; then
    printf '%s\n' '<!-- brains:autoupdate -->auto-update is OFF for the brains plugin marketplace. Offer once to enable it (then never raise it again): on yes, set `.'"$MARKETPLACE"'.autoUpdate = true` in ~/.claude/plugins/known_marketplaces.json via jq (back the file up first); if anything fails, tell the user to use /plugin -> Marketplaces -> brains -> Enable auto-update.<!-- /brains:autoupdate -->'
    printf '%s' '1' > "$AUTOUPD_MARKER" 2>/dev/null || true
    log "auto-update nudge emitted (marketplace=$MARKETPLACE)"
  fi
fi

DEVICE_QS=""
[ -n "$DEVICE_ID" ] && DEVICE_QS="&device_id=$DEVICE_ID"

if ! brains_request inbox "$ENDPOINT?session_id=$SESSION&source=$MODE&mode=$MODE$TZ_QS$DEVICE_QS" \
       --max-time "$TIMEOUT"; then
  # A refused credential used to be indistinguishable from an empty inbox: the
  # old code discarded the status, and an empty body was read as "nothing to
  # do". Name the difference, so a revocation is visible the day it happens.
  case "${BRAINS_HTTP_CODE:-}" in
    401|403) log "inbox rejected: status=$BRAINS_HTTP_CODE source=$BRAINS_CRED_SOURCE" ;;
    ''|000)  log "fetch failed" ;;
    *)       log "inbox error: status=$BRAINS_HTTP_CODE" ;;
  esac
  [ "$BRAINS_HTTP_BLOCKED" = "1" ] && log "inbox blocked: endpoint origin does not match the signed-in server"
  exit 0
fi
RESP="$BRAINS_HTTP_BODY"
[ -z "$RESP" ] && exit 0
printf '%s' "$RESP" | jq -e . >/dev/null 2>&1 || { log "invalid json"; exit 0; }

OUT_CONTEXT=$(printf '%s' "$RESP" | jq -r '.context // empty')
CTX_ITEMS_JSON=$(printf '%s' "$RESP" | jq -c '.context_items // []' 2>/dev/null || printf '[]')
OUT_PROMPTS=""
AUTO_ACK_IDS=()

mark_auto_ack() { AUTO_ACK_IDS+=("$1"); }

do_notification() {
  local id="$1" payload="$2" title body
  title=$(printf '%s' "$payload" | jq -r '.title // "brains"')
  body=$(printf '%s' "$payload"  | jq -r '.body  // empty')
  if [ -z "$body" ]; then
    log "$id notification: empty body, skipped"
    return
  fi
  # argv (not env / `system attribute`) — osascript decodes -- args as UTF-8
  # regardless of locale. On non-macOS this no-ops silently.
  if command -v osascript >/dev/null 2>&1; then
    osascript -e 'on run argv' \
              -e 'display notification (item 2 of argv) with title (item 1 of argv)' \
              -e 'end run' -- "$title" "$body" >/dev/null 2>&1 || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "$title" "$body" >/dev/null 2>&1 || true
  fi
  mark_auto_ack "$id"
  log "$id notification: ok title=$title"
}

do_prompt() {
  local id="$1" payload="$2" body
  body=$(printf '%s' "$payload" | jq -r '.body // empty')
  if [ -z "$body" ]; then
    log "$id prompt: empty body, skipped"
    return
  fi
  # Fixed preamble — pushes the model to surface the body to the user. The body
  # itself controls everything (approval, yes/no behavior); the hook just
  # guarantees the user sees it. Intentionally NOT auto-acked.
  OUT_PROMPTS+=$'\n<!-- brains:prompt id='"$id"$' -->\n'
  OUT_PROMPTS+=$'🔔 **Pending brains action — surface this to the user before doing anything else this turn.**\n\n'
  OUT_PROMPTS+=$'Read the message below and present it to the user in your reply. If the message asks for the user\'s approval, ask them and wait for their answer. If it\'s informational, just show it briefly. Do not start on the user\'s task without surfacing this first.\n\n'
  OUT_PROMPTS+=$'When the user has seen it (and decided, if approval was asked), call:\n'
  OUT_PROMPTS+=$'  `mcp__brains__ack_inbox_action(id="'"$id"$'", decision="approved"|"declined"|"auto")`\n'
  OUT_PROMPTS+=$'Use `auto` for purely informational messages where there is no choice.\n\n'
  OUT_PROMPTS+=$'--- begin message ---\n'"$body"$'\n--- end message ---\n'
  OUT_PROMPTS+=$'<!-- brains:prompt end -->\n'
  log "$id prompt: surfaced (len=$(printf %s "$body" | wc -c | tr -d ' '))"
}

dispatch() {
  local action="$1" id type
  id=$(printf '%s' "$action"   | jq -r '.id   // empty')
  type=$(printf '%s' "$action" | jq -r '.type // empty')
  [ -z "$id" ] || [ -z "$type" ] && return
  case " $ALLOWED_TYPES " in
    *" $type "*) ;;
    *) log "skip $id: $type not allowed in mode=$MODE"; return ;;
  esac
  case "$type" in
    notification) do_notification "$id" "$action" ;;
    prompt)       do_prompt       "$id" "$action" ;;
    *) log "skip $id: unknown type $type" ;;
  esac
}

ACTIONS=$(printf '%s' "$RESP" | jq -c '.actions // [] | .[]' 2>/dev/null || true)
if [ -n "$ACTIONS" ]; then
  while IFS= read -r action; do
    [ -z "$action" ] && continue
    dispatch "$action"
  done <<< "$ACTIONS"
fi

if [ "$EMIT_STDOUT" = "1" ]; then
  [ -n "$OUT_CONTEXT" ] && printf '%s\n' "$OUT_CONTEXT"
  [ -n "$OUT_PROMPTS" ] && printf '%s' "$OUT_PROMPTS"
fi

# One ack POST covers lifecycle acks (notification auto-acks) plus delivery
# acks (context_items). Send whenever there's anything to report.
CTX_ITEMS_LEN=$(printf '%s' "$CTX_ITEMS_JSON" | jq 'length' 2>/dev/null || printf '0')
if [ "${#AUTO_ACK_IDS[@]}" -gt 0 ] || [ "$CTX_ITEMS_LEN" -gt 0 ]; then
  if [ "${#AUTO_ACK_IDS[@]}" -gt 0 ]; then
    ids_json=$(printf '%s\n' "${AUTO_ACK_IDS[@]}" | jq -R . | jq -s .)
  else
    ids_json='[]'
  fi
  ack=$(jq -nc \
    --arg s "$SESSION" \
    --arg m "$MODE" \
    --argjson ids "$ids_json" \
    --argjson ctx "$CTX_ITEMS_JSON" \
    --arg d "$DEVICE_ID" \
    'if $d != "" then
        {session_id:$s, mode:$m, applied:$ids, context_received:$ctx, device_id:$d}
     else
        {session_id:$s, mode:$m, applied:$ids, context_received:$ctx}
     end')
  # Leased before backgrounding: see brains_cred_lease. Without it the hook's
  # exit removes the config while this request is still in flight.
  ack_lease=$(brains_cred_lease) || ack_lease=""
  if [ -n "$ack_lease" ]; then
    ( BRAINS_CRED_CONFIG="$ack_lease"
      trap 'brains_cred_return "$ack_lease"' EXIT
      brains_request ack "$ACK_ENDPOINT" --max-time 3 -X POST \
        -H "Content-Type: application/json" -d "$ack" >/dev/null 2>&1
      brains_cred_return "$ack_lease" ) &
  fi
fi

exit 0
