#!/usr/bin/env bash
# brains plugin — shared capture-credential resolver and the ONE HTTP call site.
# Sourced (not executed) by brains-turn.sh and by lib/brains-inbox.sh.
#
# Why this file exists: capture and the inbox authenticate with a bearer token
# that, before this, only ever came from explicit configuration. A user who
# never pasted a token had no credential, so both features stayed off with no
# request, no log line and no error. The MCP sign-in the client already performs
# mints a token of the SAME class against the SAME table, so when nothing is
# configured we resolve the credential from the client's own MCP OAuth store.
#
# TWO INVARIANTS carry the safety of this file. Both are structural: they remove
# whole classes of mistake rather than guarding known instances, because each
# class here was found the hard way, one instance at a time.
#
#   I1. THE TOKEN NEVER OCCUPIES A SHELL VARIABLE.
#       Four separate disclosure channels were closed in turn — xtrace, curl's
#       argv, the user's ~/.curlrc, and `set -a` (which exports locals too, so
#       even a function-scoped copy reaches every child's environment). Each fix
#       shielded one channel and the next one appeared. So the value is never
#       assigned: it goes from the store, through jq, into a private curl config
#       file, and from there into curl. Nothing to export, nothing to trace,
#       nothing to inherit, and no fifth channel to discover.
#       `BRAINS_CRED_SOURCE` / `BINDING` / `ORIGIN` / `LOCATOR` are NOT secret
#       and remain ordinary variables.
#
#   I2. UNKNOWN IS THE DEFAULT STATE.
#       Three separate "incomplete enumeration" cases were closed in turn — the
#       candidate cap, an unreadable account, and every account failing at once.
#       Each was a way of reporting "there is no credential" when the truth was
#       "I could not tell", which sends the user to a remedy that cannot work.
#       So the resolver STARTS at indeterminate and only a provably complete
#       enumeration may downgrade it to no-credential. A future failure mode
#       nobody has thought of fails safe without being enumerated.
#
# Beyond those: only brains_request() ever presents the credential, because
# endpoint URLs are env-overridable and a discovered credential must never reach
# a host that did not mint it. And every failure returns "no credential" with
# the caller behaving exactly as it did before this file existed.

# ---------------------------------------------------------------- test hooks
# The suites run on developer machines that hold a REAL credential. Without a
# way to switch the store reads off, a "no token configured" scenario would
# resolve the developer's own token and POST to production. These exist so the
# tests can be hermetic; they are not a user-facing interface.
#   BRAINS_CREDENTIAL_STORE_DISABLED=1  skip every discovery step (4 and 5)
#   BRAINS_CLAUDE_CREDENTIALS_FILE      read the Claude store from this file
#   BRAINS_CODEX_CREDENTIALS_FILE       read the Codex store from this file
#                                       (a JSON array of Codex records)

# The credential DOCUMENT ceiling. This bounds memory; it is not a policy, and
# it must not be small enough to reject a store a real user can accumulate. The
# brains entry is under 1 KB, but the document holds EVERY MCP server the user
# has signed into, and at 256 KiB — roughly a hundred servers — a perfectly
# valid store was rejected and the user was told to remove a duplicate that did
# not exist. 4 MiB is about a thousand servers and still bounded.
BRAINS_CRED_MAX_BYTES=4194304
BRAINS_CRED_MAX_BLOCKS=8192
# The keychain METADATA dump is a different size class entirely and needs its
# own ceiling: measured at 198,137 bytes for 209 items on an ordinary machine,
# which is 76% of the document cap. At ~300 items that cap silently truncates
# the dump, the account list comes back short, and Codex capture turns off with
# no signal. This contains no secrets — it is names and dates — so the only job
# of this limit is to stop a pathological keychain eating memory.
BRAINS_CRED_DUMP_MAX_BYTES=16777216
BRAINS_CRED_DUMP_MAX_BLOCKS=32768
# Wall-clock ceiling on a single store read. `security` answers in ~30ms; this
# only matters when a keychain item carries a restrictive ACL, in which case it
# blocks on a GUI dialog that stdin redirection cannot suppress.
BRAINS_CRED_READ_DEADLINE=1
# ...and a ceiling on ALL of them together. Per-read deadlines do not compose:
# the Codex store is enumerated one account at a time, so N stale entries cost
# N x the per-read deadline, and this hook runs on every prompt and every stop.
BRAINS_CRED_TOTAL_BUDGET=3
BRAINS_CRED_MAX_CANDIDATES=8
_brains_cred_deadline_at=0

# Default network ceilings. These live HERE, not at the call sites, because a
# call site that forgets one is unbounded: ingest lost its `--max-time 5` in
# exactly that way, and ingest is the path Codex runs synchronously during Stop,
# where a server that accepts and never answers hangs the hook forever. curl
# honours the LAST occurrence of a repeated flag, so a caller can still tighten
# either value by passing its own.
BRAINS_CRED_CONNECT_TIMEOUT=5
BRAINS_CRED_MAX_TIME=10

# States: ok | no-credential | indeterminate | blocked.
# See I2 — indeterminate is the starting point, not an error path.
BRAINS_CRED_STATE="indeterminate"
BRAINS_CRED_SOURCE=""
BRAINS_CRED_BINDING=""
BRAINS_CRED_ORIGIN=""
BRAINS_CRED_LOCATOR=""    # which entry won; a key or an account name, never a token
BRAINS_CRED_CONFIG=""     # path to the private curl config holding the header
BRAINS_CRED_COUNT=0       # distinct candidates seen; a count, never a name
BRAINS_CRED_TRUNCATED=0   # an enumeration hit a limit or a read failed
BRAINS_CRED_SAW_ENTRIES=0 # the store held credentials, even if none matched

brains_state_dir() {
  printf '%s' "${BRAINS_STATE_DIR:-${PLUGIN_DATA:-${CLAUDE_PLUGIN_DATA:-$HOME/.claude/brains}}}"
}

# ------------------------------------------------------------- the endpoint set
# One definition of where the four endpoints are, because both hooks need them
# and health is keyed by the origin each one actually resolves to. When the turn
# hook and the inbox engine each built these separately, the session-start
# signal could not find the capture health the turn hook had written.
BRAINS_URL_INGEST=""
BRAINS_URL_INBOX=""
BRAINS_URL_ACK=""
BRAINS_URL_DEVICES=""
brains_resolve_endpoints() {   # base
  local base
  base="${1:-}"
  base="${base%/}"
  BRAINS_URL_INGEST="${BRAINS_INGEST_URL:-$base/ingest/claude}"
  BRAINS_URL_INBOX="${BRAINS_INBOX_URL:-$base/inbox/claude}"
  BRAINS_URL_ACK="${BRAINS_INBOX_ACK_URL:-${BRAINS_URL_INBOX}/ack}"
  BRAINS_URL_DEVICES="${BRAINS_INBOX_DEVICES_URL:-${BRAINS_URL_INBOX}/devices}"
}

# ------------------------------------------------------------- xtrace shielding
# I1 keeps the DISCOVERED credential out of every shell variable, but the three
# EXPLICITLY configured tokens arrive as environment variables and there is
# nothing to be done about that — they have to be tested for emptiness and read
# to build the config. Both of those expand the value, and `bash -x`, an
# inherited SHELLOPTS=xtrace, or BASH_XTRACEFD prints it.
#
# So this is not redundant with I1; it covers the half of the precedence chain
# I1 cannot reach. Removing it on the strength of I1 alone reopened the channel
# for all three variables, which is why the leak battery now exercises the
# explicit branches as well as the store branch.
_brains_xtrace_off() {
  case "$-" in
    *x*) BRAINS_CRED_XTRACE=1; set +x ;;
    *)   BRAINS_CRED_XTRACE="" ;;
  esac
}
_brains_xtrace_restore() {
  [ -n "${BRAINS_CRED_XTRACE:-}" ] && set -x
  BRAINS_CRED_XTRACE=""
  return 0
}

# --------------------------------------------------------------- time budget
# One budget for the WHOLE resolution rather than one per read. SECONDS is a
# bash builtin, so checking it costs no fork on a path that runs every turn.
_brains_budget_start() { _brains_cred_deadline_at=$((SECONDS + BRAINS_CRED_TOTAL_BUDGET)); }
_brains_budget_left()  { [ "$SECONDS" -lt "$_brains_cred_deadline_at" ]; }

# --------------------------------------------------------------- private tmp
# Returns 0 and sets BRAINS_CRED_TMP, or returns 1 (caller -> no credential).
# There is deliberately NO fallback to /tmp: a resolver that shops around for a
# usable directory is the same mistake as one that shops around for a usable
# credential store.
BRAINS_CRED_TMP=""
_brains_cred_tmp_root() {
  local root
  root="$(brains_state_dir)/tmp"
  ( umask 077; mkdir -p "$root" ) 2>/dev/null || return 1
  [ -d "$root" ] || return 1
  [ -L "$root" ] && return 1
  [ -O "$root" ] || return 1
  [ -w "$root" ] || return 1
  BRAINS_CRED_TMP="$root"
  return 0
}

# Remove work directories orphaned by SIGKILL, which is untrappable, so nothing
# else can have cleaned up after it.
#
# The bound this provides is honest but weak, and worth stating plainly: it is
# "until the next session start or end", not a wall-clock guarantee. Every other
# path — normal completion, EXIT, INT, TERM, HUP, and the leased background
# subshells — removes its own directory promptly; this only catches SIGKILL.
# Five minutes is far longer than any live directory needs (a lease lives for
# one request, the master config for one hook) while staying clear of anything
# in flight.
brains_cred_prune_tmp() {
  local root
  root="$(brains_state_dir)/tmp"
  [ -d "$root" ] || return 0
  find "$root" -maxdepth 1 -name 'r.*' -type d -mmin +5 -exec rm -rf {} + 2>/dev/null
  return 0
}

# ------------------------------------------------------------- bounded read
# Run a command with a deadline and a size ceiling, and echo the PATH of a file
# holding its stdout. The caller reads that file with a tool — never into a
# shell variable — and removes it. See I1.
#
# The value travels through a private FILE rather than a pipe for a second
# reason too: a pipe read ends only when every write descriptor closes, and a
# descendant we cannot enumerate can hold one open indefinitely. Two earlier
# pipe-based versions hung well past their deadline and returned bytes written
# after it. Reading a regular file ends at EOF, which the reader controls.
#
# The rc file is the success marker: if the command was killed it is never
# written, so partial output is discarded rather than parsed.
_brains_bounded_read_file() {  # deadline, max-bytes, max-blocks, command...
  local deadline maxbytes maxblocks dir rc sz
  deadline="$1"; maxbytes="$2"; maxblocks="$3"; shift 3
  [ -n "$BRAINS_CRED_TMP" ] || return 1
  dir="$BRAINS_CRED_TMP/r.$$.$RANDOM"
  ( umask 077; mkdir "$dir" ) 2>/dev/null || return 1
  (
    # umask INSIDE the subshell that performs the redirect. Scoping it to the
    # mkdir above left the document itself world-readable (-rw-r--r--) for the
    # duration of the read; the 0700 parent made that defense in depth rather
    # than an exposure, but the file should not depend on the directory.
    umask 077
    # A plain cleanup trap, in the subshell that owns the work. An earlier
    # version saved, restored and re-raised in the PARENT — which could never
    # work, because every caller runs this inside a command substitution where
    # trap changes are discarded and `kill $$` targets the wrong shell.
    trap 'rm -rf "$dir" 2>/dev/null' EXIT INT TERM HUP
    set -m
    ( ulimit -f "$maxblocks" 2>/dev/null
      "$@" >"$dir/v" 2>/dev/null
      printf '%s' "$?" >"$dir/rc" ) & _p=$!
    set +m
    ( sleep "$deadline"
      kill -TERM -"$_p" 2>/dev/null
      sleep 0.2
      kill -KILL -"$_p" 2>/dev/null ) >/dev/null 2>&1 & _w=$!
    wait $_p 2>/dev/null
    # Sweep the worker's whole process group BEFORE standing the watchdog down.
    # A leader that forks a sleeping descendant and exits 0 leaves that
    # descendant behind, and the watchdog is the only thing that would reach it.
    kill -TERM -"$_p" 2>/dev/null
    kill $_w 2>/dev/null; wait $_w 2>/dev/null
    trap - EXIT INT TERM HUP
  ) >/dev/null 2>&1
  rc=""
  [ -f "$dir/rc" ] && read -r rc <"$dir/rc" 2>/dev/null
  sz=$(wc -c <"$dir/v" 2>/dev/null | tr -d ' ')
  case "$sz" in ''|*[!0-9]*) sz=0 ;; esac
  if [ "$rc" = "0" ] && [ "$sz" -gt 0 ] && [ "$sz" -le "$maxbytes" ]; then
    printf '%s' "$dir/v"
    return 0
  fi
  rm -rf "$dir" 2>/dev/null
  # Carry the COMMAND'S OWN exit status out, so a caller can tell "the item is
  # not there" (security exits 44) from "the read failed or was killed". This
  # has to be the return value: every call site is a command substitution, and a
  # variable assigned in one never reaches the caller. An earlier version
  # identified that constraint in a comment and then used a variable anyway, so
  # conclusive absence never fired and a fresh install — the first-run path this
  # whole change exists for — was told its store was unreadable.
  case "$rc" in
    ''|0|1) return 1 ;;
    *[!0-9]*) return 1 ;;
    *) [ "$rc" -le 255 ] && return "$rc"; return 1 ;;
  esac
}

# Remove a file produced by _brains_bounded_read_file, and its directory.
#
# This is an `rm -rf` on a path derived from its argument, and arguments here
# have twice turned out to be caller-supplied rather than ours — the Codex
# override path fed it the user's own store directory, and two earlier instances
# fed it the shared Claude snapshot. Scoping each call site fixed each instance
# and left the primitive able to delete anything.
#
# So the primitive refuses: it removes ONLY a directory that is a direct child of
# the temp root this library created. Not the root itself, not anything above it,
# and nothing outside it. A wrong argument is now a silent no-op rather than
# data loss.
_brains_discard() {
  local target parent
  target="${1:-}"
  [ -n "$target" ] || return 0
  [ -n "${BRAINS_CRED_TMP:-}" ] || return 0
  parent=$(dirname "$target" 2>/dev/null) || return 0
  # Must be a direct child of the owned root, and never the root itself.
  case "$parent" in
    "$BRAINS_CRED_TMP"/*/*) return 0 ;;
    "$BRAINS_CRED_TMP"/?*) ;;
    *) return 0 ;;
  esac
  case "$parent" in
    *..*) return 0 ;;
  esac
  rm -rf "$parent" 2>/dev/null
  return 0
}

# ------------------------------------------------------- origin canonical form
# Echo the canonical origin of a URL, or return 1 to refuse it. Refusing is
# always safe: it costs a discovered credential and never sends one anywhere.
brains_origin() {
  local url scheme rest authority host port oldlc bad
  url="${1:-}"
  case "$url" in
    http://*|https://*) ;;
    HTTP://*|HTTPS://*|Http://*|Https://*) ;;
    *) return 1 ;;
  esac
  scheme="${url%%://*}"
  rest="${url#*://}"
  authority="${rest%%/*}"
  [ -n "$authority" ] || return 1
  # Credentials embedded in a hook endpoint are not a shape we support, and
  # normalising them invites confusion between userinfo and host.
  case "$authority" in *@*) return 1 ;; esac
  # Punycode cannot be done correctly here, and a wrong guess would compare two
  # different hosts as equal. Refuse instead.
  oldlc="${LC_ALL-}"
  LC_ALL=C
  case "$authority" in *[!\ -~]*) bad=1 ;; *) bad=0 ;; esac
  if [ -n "$oldlc" ]; then LC_ALL="$oldlc"; else unset LC_ALL; fi
  [ "$bad" = "0" ] || return 1

  case "$authority" in
    \[*\])    host="$authority"; port="" ;;
    \[*\]:*)  host="${authority%%\]:*}]"; port="${authority##*\]:}" ;;
    *:*:*)    return 1 ;;                       # unbracketed IPv6 is ambiguous
    *:*)      host="${authority%:*}"; port="${authority##*:}" ;;
    *)        host="$authority"; port="" ;;
  esac
  [ -n "$host" ] || return 1

  # Fork `tr` only when there is something to fold; hosts and schemes are
  # lowercase in practice, and this runs on every request.
  case "$scheme" in *[A-Z]*) scheme=$(printf '%s' "$scheme" | tr 'A-Z' 'a-z') ;; esac
  case "$host"   in *[A-Z]*) host=$(printf '%s' "$host"   | tr 'A-Z' 'a-z') ;; esac
  case "$host" in
    \[*\]) ;;
    *.)    host="${host%.}"; [ -n "$host" ] || return 1 ;;
  esac

  if [ -n "$port" ]; then
    case "$port" in *[!0-9]*) return 1 ;; esac
    if { [ "$scheme" = "https" ] && [ "$port" = "443" ]; } ||
       { [ "$scheme" = "http" ]  && [ "$port" = "80" ]; }; then
      port=""
    fi
  else
    case "$authority" in *:) return 1 ;; esac
  fi

  if [ -n "$port" ]; then
    printf '%s://%s:%s' "$scheme" "$host" "$port"
  else
    printf '%s://%s' "$scheme" "$host"
  fi
}

# Does this MCP server name identify brains? Origin alone is not enough: another
# MCP server sharing the origin would otherwise have its token selected and sent
# to the brains endpoints as the unique match. Claude names a plugin-provided
# server `plugin:<plugin>:<server>` and a hand-added one just `<server>`, so both
# shapes are accepted and everything else is refused.
_brains_is_brains_server() {
  local name want
  name="${1:-}"
  want="${BRAINS_CRED_SERVER:-brains}"
  [ -n "$name" ] || return 1
  case "$name" in
    "$want"|*:"$want") return 0 ;;
    *) return 1 ;;
  esac
}

# ---------------------------------------------------------- Claude Code store
# The client derives ONE service name and ONE account. We derive the same ones
# and stop. Probing a second name would let a profile that has no credential of
# its own read the default profile's, which silently captures a conversation
# into the wrong account and destroys the isolation the tests depend on.
_brains_claude_service() {
  local dir hash
  if [ -n "${CLAUDE_SECURESTORAGE_CONFIG_DIR+set}" ]; then
    dir="$CLAUDE_SECURESTORAGE_CONFIG_DIR"
  elif [ -n "${CLAUDE_CONFIG_DIR:-}" ]; then
    dir="$CLAUDE_CONFIG_DIR"
  else
    dir=""
  fi
  if [ -z "$dir" ]; then
    printf '%s' 'Claude Code-credentials'
    return 0
  fi
  hash=$(printf '%s' "$dir" | shasum -a 256 2>/dev/null | cut -c1-8)
  [ -n "$hash" ] || return 1
  printf 'Claude Code-credentials-%s' "$hash"
}

_brains_claude_account() {
  local u
  u="${USER:-}"
  [ -n "$u" ] || u=$(id -un 2>/dev/null)
  case "$u" in
    ''|*[!a-zA-Z0-9._-]*) printf '%s' 'claude-code-user' ;;
    *) printf '%s' "$u" ;;
  esac
}

_brains_claude_config_dir() {
  if [ -n "${CLAUDE_SECURESTORAGE_CONFIG_DIR+set}" ]; then
    if [ -n "$CLAUDE_SECURESTORAGE_CONFIG_DIR" ]; then
      printf '%s' "$CLAUDE_SECURESTORAGE_CONFIG_DIR"
    else
      printf '%s' "$HOME/.claude"
    fi
    return 0
  fi
  printf '%s' "${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
}

# Echo the PATH of a file holding the credential document, or return 1. Mirrors
# the client's own keychain-then-file order WITHIN one profile, which is not
# probing: it is the same store with two backends, and it is how Linux (no
# keychain) works at all.
# Returns 0 and echoes a path; 2 when the store is conclusively ABSENT; 1 when
# it exists but could not be read. The distinction has to travel as an exit code
# rather than a variable, because every caller invokes this inside a command
# substitution and a subshell assignment never reaches the parent.
_brains_claude_store_file() {
  local svc acct file out kc_absent
  kc_absent=0
  if [ -n "${BRAINS_CLAUDE_CREDENTIALS_FILE:-}" ]; then
    [ -f "$BRAINS_CLAUDE_CREDENTIALS_FILE" ] || return 2
    _brains_snapshot "$BRAINS_CLAUDE_CREDENTIALS_FILE"
    return $?
  fi
  if command -v security >/dev/null 2>&1; then
    svc=$(_brains_claude_service) || svc=""
    acct=$(_brains_claude_account)
    if [ -n "$svc" ]; then
      out=$(_brains_bounded_read_file "$BRAINS_CRED_READ_DEADLINE" \
              "$BRAINS_CRED_MAX_BYTES" "$BRAINS_CRED_MAX_BLOCKS" \
              security find-generic-password -s "$svc" -a "$acct" -w)
      case "$?" in
        0)  printf '%s' "$out"; return 0 ;;
        # 44 is SecKeychain "item not found" — a conclusive absence, unlike a
        # timeout or an ACL prompt, which tell us nothing.
        44) kc_absent=1 ;;
      esac
    fi
  else
    kc_absent=1
  fi
  file="$(_brains_claude_config_dir)/.credentials.json"
  if [ ! -f "$file" ]; then
    [ "$kc_absent" = "1" ] && return 2
    return 1
  fi
  # M3: snapshot the fallback backend through the bounded reader too. Handing
  # back the live path meant the size ceiling and the deadline applied to the
  # keychain backend only, while the file backend — the whole of Linux — read an
  # arbitrarily large document straight into jq, twice.
  _brains_snapshot "$file"
}

# Copy a file through the bounded reader so the ceiling and deadline apply, and
# so callers always get a private copy they may freely discard.
_brains_snapshot() {
  local out
  out=$(_brains_bounded_read_file "$BRAINS_CRED_READ_DEADLINE" \
          "$BRAINS_CRED_MAX_BYTES" "$BRAINS_CRED_MAX_BLOCKS" cat "$1") || return 1
  printf '%s' "$out"
}

# ---------------------------------------------------------------- Codex store
# Codex keys each entry by <server>|<hash> and the hash is not reconstructible,
# so entries are enumerated and read by their own fields. dump-keychain prints
# metadata only and does not prompt. Narrowing by server name here — on that
# metadata — is what keeps the per-account candidate cap from ever binding.
# Returns 1 when the dump itself could not be read, which the caller must treat
# as an incomplete enumeration rather than an empty one.
_brains_codex_accounts() {
  local dumpfile server
  server="${BRAINS_CRED_SERVER:-brains}"
  dumpfile=$(_brains_bounded_read_file "$BRAINS_CRED_READ_DEADLINE" \
               "$BRAINS_CRED_DUMP_MAX_BYTES" "$BRAINS_CRED_DUMP_MAX_BLOCKS" \
               security dump-keychain) || return 1
  LC_ALL=C awk -v want="$server" '
    /^[[:space:]]*"acct"<blob>=/ {
      acct = $0
      sub(/^[^"]*"acct"<blob>="/, "", acct)
      sub(/".*$/, "", acct)
      last = acct
    }
    /"svce"<blob>="Codex MCP Credentials"/ {
      if (last != "") {
        name = last
        sub(/\|.*$/, "", name)
        if (name == want) print last
      }
    }
  ' "$dumpfile" 2>/dev/null | sort -u
  # A partial awk pass handed back as a COMPLETE enumeration is exactly what I2
  # forbids, so the parse status is checked rather than assumed.
  set -- "${PIPESTATUS[0]}" "${PIPESTATUS[1]}"
  _brains_discard "$dumpfile"
  { [ "$1" = "0" ] && [ "$2" = "0" ]; } || return 1
  return 0
}

# ------------------------------------------------- the credential, never a var
# Write the private curl config holding the Authorization header, straight from
# the store through jq. See I1: at no point is the value assigned to a shell
# variable. jq's @json produces exactly curl's quoted-value escaping — verified
# for quote, backslash, space, percent, hash and tab.
#
# Sets BRAINS_CRED_CONFIG on success. Returns 1 without leaving a config behind
# on failure, so a caller can tell "could not present a credential" from
# "presented one and was refused".
_brains_write_config() {   # source-kind, locator, store-file(optional)
  local kind locator store cfgdir cfg rc
  kind="$1"; locator="${2:-}"; store="${3:-}"
  [ -n "$BRAINS_CRED_TMP" ] || return 1
  cfgdir="$BRAINS_CRED_TMP/r.$$.cfg"
  ( umask 077; mkdir -p "$cfgdir" ) 2>/dev/null || return 1
  cfg="$cfgdir/curl.conf"
  ( umask 077
    case "$kind" in
      plugin-option)
        printf '%s' "${CLAUDE_PLUGIN_OPTION_TOKEN:-}" ;;
      env-api)
        printf '%s' "${BRAINS_API_TOKEN:-}" ;;
      env-inbox)
        printf '%s' "${BRAINS_INBOX_TOKEN:-}" ;;
      codex-header)
        jq -r '(.transport.http_headers.Authorization // .transport.http_headers.authorization // "")
               | select(startswith("Bearer ")) | sub("^Bearer ";"")' "$store" 2>/dev/null ;;
      claude-oauth)
        jq -r --arg k "$locator" '(.mcpOAuth[$k].accessToken // "")' "$store" 2>/dev/null ;;
      codex-oauth)
        jq -r '(.token_response.access_token // "")' "$store" 2>/dev/null ;;
      codex-oauth-array)
        jq -r --argjson i "$locator" '(if type == "array" then .[$i] else . end)
               | (.token_response.access_token // "")' "$store" 2>/dev/null ;;
    esac | jq -Rr 'select(length > 0) | "header = " + (("Authorization: Bearer " + .) | @json)' >"$cfg" 2>/dev/null
  )
  rc=$?
  if [ "$rc" -ne 0 ] || [ ! -s "$cfg" ]; then
    rm -rf "$cfgdir" 2>/dev/null
    return 1
  fi
  BRAINS_CRED_CONFIG="$cfg"
  # The config lives for the rest of the hook, and is removed on exit. Only
  # installed when the sourcing hook has no EXIT trap of its own — replacing a
  # caller's handler is not this library's call to make. None of the hooks set
  # one; if that changes, the caller must invoke brains_cred_release itself.
  [ -z "$(trap -p EXIT 2>/dev/null)" ] &&
    trap 'rm -rf "$BRAINS_CRED_TMP/r.$$.cfg" 2>/dev/null' EXIT INT TERM HUP
  return 0
}

brains_cred_release() { [ -n "$BRAINS_CRED_CONFIG" ] && rm -rf "$(dirname "$BRAINS_CRED_CONFIG")" 2>/dev/null; BRAINS_CRED_CONFIG=""; return 0; }

# A private copy of the config for a request that will outlive this shell.
#
# Two calls are deliberately fire-and-forget — the Claude ingest POST and the
# inbox ack — so the hook exits while curl is still running. The hook's EXIT
# trap would then delete the config out from under it, and the request would go
# out with no credential. A copy taken BEFORE backgrounding, and removed by the
# backgrounded subshell itself, gives the in-flight request a lifetime of its
# own. Waiting for the children instead would put up to five seconds back onto
# the hot path, which is the thing backgrounding exists to avoid.
#
# Echoes the path, or nothing when there is no credential to lease.
brains_cred_lease() {
  local dir
  [ -n "$BRAINS_CRED_CONFIG" ] && [ -s "$BRAINS_CRED_CONFIG" ] || return 1
  [ -n "$BRAINS_CRED_TMP" ] || return 1
  dir="$BRAINS_CRED_TMP/r.$$.lease.$RANDOM"
  ( umask 077; mkdir "$dir" ) 2>/dev/null || return 1
  ( umask 077; cat "$BRAINS_CRED_CONFIG" >"$dir/curl.conf" ) 2>/dev/null || { rm -rf "$dir" 2>/dev/null; return 1; }
  printf '%s' "$dir/curl.conf"
}

brains_cred_return() { [ -n "${1:-}" ] && rm -rf "$(dirname "$1")" 2>/dev/null; return 0; }

# --------------------------------------------------------------- the resolver
# Sets BRAINS_CRED_* and returns 0 when a credential resolved, 1 otherwise.
# $1 is the base URL the caller intends to talk to; a discovered credential is
# admitted only for that origin.
brains_resolve_credential() {
  local rc
  _brains_xtrace_off
  _brains_resolve_credential_impl "$@"
  rc=$?
  _brains_xtrace_restore
  return $rc
}

_brains_resolve_credential_impl() {
  local base want store meta line key url name corigin accts acct seen rec recfile
  local matched matchedfiles count
  base="${1:-}"
  BRAINS_CRED_STATE="indeterminate"      # I2: downgrade only on proof
  BRAINS_CRED_SOURCE=""; BRAINS_CRED_BINDING=""; BRAINS_CRED_ORIGIN=""
  BRAINS_CRED_LOCATOR=""; BRAINS_CRED_COUNT=0; BRAINS_CRED_TRUNCATED=0
  BRAINS_CRED_SAW_ENTRIES=0
  brains_cred_release
  _brains_budget_start

  # 1-3. Explicit configuration. Admitted for any target: a user who sets both a
  # token and an endpoint override chose that pairing.
  if [ -n "${CLAUDE_PLUGIN_OPTION_TOKEN:-}" ]; then
    _brains_cred_tmp_root && _brains_write_config plugin-option || { BRAINS_CRED_STATE="indeterminate"; return 1; }
    BRAINS_CRED_SOURCE="plugin-option"; BRAINS_CRED_BINDING="explicit"; BRAINS_CRED_STATE="ok"; return 0
  fi
  if [ -n "${BRAINS_API_TOKEN:-}" ]; then
    _brains_cred_tmp_root && _brains_write_config env-api || { BRAINS_CRED_STATE="indeterminate"; return 1; }
    BRAINS_CRED_SOURCE="env"; BRAINS_CRED_BINDING="explicit"; BRAINS_CRED_STATE="ok"; return 0
  fi
  # BRAINS_INBOX_TOKEN is the TEST channel, not a documented user option: the
  # suites scrub BRAINS_API_TOKEN from the inherited environment so a
  # developer's real token cannot outrank a fixture, which needs a second name
  # to put the fixture in. Kept for that reason alone.
  if [ -n "${BRAINS_INBOX_TOKEN:-}" ]; then
    _brains_cred_tmp_root && _brains_write_config env-inbox || { BRAINS_CRED_STATE="indeterminate"; return 1; }
    BRAINS_CRED_SOURCE="env"; BRAINS_CRED_BINDING="explicit"; BRAINS_CRED_STATE="ok"; return 0
  fi

  # Discovery switched off is a DEFINITE no-credential: we are not looking.
  if [ "${BRAINS_CREDENTIAL_STORE_DISABLED:-}" = "1" ]; then
    BRAINS_CRED_STATE="no-credential"; return 1
  fi
  command -v jq >/dev/null 2>&1 || return 1          # cannot read anything: stays indeterminate
  want=$(brains_origin "$base") || { BRAINS_CRED_STATE="no-credential"; return 1; }
  _brains_cred_tmp_root || return 1                  # cannot read anything: stays indeterminate

  # 4. A Codex Authorization header the user typed by hand. Explicit in rank,
  # but its audience is known from the same response, so it is bound to it.
  if [ "${BRAINS_CRED_CLIENT:-claude}" = "codex" ] && command -v codex >/dev/null 2>&1; then
    store=$(_brains_bounded_read_file "$BRAINS_CRED_READ_DEADLINE" \
              "$BRAINS_CRED_MAX_BYTES" "$BRAINS_CRED_MAX_BLOCKS" \
              codex mcp get "${BRAINS_CRED_SERVER:-brains}" --json) && {
      url=$(jq -r '.transport.url // ""' "$store" 2>/dev/null)
      corigin=$(brains_origin "$url") || corigin=""
      if [ -n "$corigin" ] && [ "$corigin" = "$want" ] && _brains_write_config codex-header "" "$store"; then
        _brains_discard "$store"
        BRAINS_CRED_SOURCE="codex-header"; BRAINS_CRED_BINDING="bound"
        BRAINS_CRED_ORIGIN="$corigin"; BRAINS_CRED_STATE="ok"; BRAINS_CRED_COUNT=1
        return 0
      fi
      _brains_discard "$store"
    }
  fi

  # 5. The client's own MCP OAuth store, selected by origin AND server identity.
  #    Selection works on METADATA ONLY — keys, names, urls. No token is read
  #    until one entry has won, and then only into the curl config (I1).
  matched=""
  count=0
  if [ "${BRAINS_CRED_CLIENT:-claude}" = "codex" ]; then
    if [ -n "${BRAINS_CODEX_CREDENTIALS_FILE:-}" ]; then
      [ -f "$BRAINS_CODEX_CREDENTIALS_FILE" ] || { BRAINS_CRED_STATE="no-credential"; return 1; }
      # Snapshot into the owned root first, so everything downstream operates on
      # a copy we may freely discard — the same discipline the Claude backend
      # follows. Referencing the live path here is what let the record-cleanup
      # sweep reach the user's own directory.
      store=$(_brains_snapshot "$BRAINS_CODEX_CREDENTIALS_FILE") || return 1
      meta=$(jq -r --arg f "$store" \
             '(if type == "array" then . else [.] end) | to_entries[]
             | select((.value.token_response.access_token // "") != "")
             | [(.key|tostring), (.value.url // ""), (.value.server_name // ""), $f] | @tsv' \
             "$store" 2>/dev/null) || { _brains_discard "$store"; return 1; }
    else
      command -v security >/dev/null 2>&1 || { BRAINS_CRED_STATE="no-credential"; return 1; }
      accts=$(_brains_codex_accounts) || { BRAINS_CRED_TRUNCATED=1; accts=""; }
      meta=""
      seen=0
      while IFS= read -r acct; do
        [ -n "$acct" ] || continue
        if [ "$seen" -ge "$BRAINS_CRED_MAX_CANDIDATES" ] || ! _brains_budget_left; then
          BRAINS_CRED_TRUNCATED=1
          break
        fi
        seen=$((seen + 1))
        rec=$(_brains_bounded_read_file "$BRAINS_CRED_READ_DEADLINE" \
                "$BRAINS_CRED_MAX_BYTES" "$BRAINS_CRED_MAX_BLOCKS" \
                security find-generic-password -s "Codex MCP Credentials" -a "$acct" -w) \
          || { BRAINS_CRED_TRUNCATED=1; continue; }
        # jq exits 0 having selected nothing for a record that simply holds no
        # token — a conclusive answer about that account. It exits non-zero when
        # the document will not parse, which is not conclusive. Collapsing both
        # into "no candidate" understates; collapsing both into "unknown" would
        # let one junk keychain entry disable capture forever.
        line=$(jq -r --arg a "$acct" --arg f "$rec" \
               'select((.token_response.access_token // "") != "")
               | [$a, (.url // ""), (.server_name // ""), $f] | @tsv' "$rec" 2>/dev/null)
        if [ "$?" -ne 0 ]; then
          BRAINS_CRED_TRUNCATED=1
          _brains_discard "$rec"
          continue
        fi
        if [ -n "$line" ]; then
          meta="$meta$line
"
        else
          _brains_discard "$rec"
        fi
      done <<EOF2
$accts
EOF2
    fi
  else
    store=$(_brains_claude_store_file)
    case "$?" in
      0) ;;
      # An ABSENT store is a definite answer — a fresh install that never signed
      # in — and "sign in" is the right remedy for it. An UNREADABLE store is
      # not, and must not be reported as absence.
      2) BRAINS_CRED_STATE="no-credential"; return 1 ;;
      *) return 1 ;;
    esac
    meta=$(jq -r --arg f "$store" '(.mcpOAuth // {}) | to_entries[]
           | select((.value.accessToken // "") != "")
           | [.key, (.value.serverUrl // ""), (.value.serverName // ""), $f] | @tsv' \
           "$store" 2>/dev/null)
    if [ "$?" -ne 0 ]; then
      _brains_discard "$store"
      return 1                                        # unparseable: indeterminate
    fi
  fi

  matchedfiles=""
  while IFS=$(printf '\t') read -r key url name recfile; do
    [ -n "$key" ] || continue
    BRAINS_CRED_SAW_ENTRIES=1
    if ! corigin=$(brains_origin "$url") ||
       [ "$corigin" != "$want" ] ||
       ! _brains_is_brains_server "$name"; then
      # Codex only: on the Claude path every row names the SAME store snapshot,
      # so discarding here on a non-match would delete the document the matching
      # rows still need.
      [ "${BRAINS_CRED_CLIENT:-claude}" = "codex" ] && _brains_discard "$recfile"
      continue
    fi
    matched="$matched$key
"
    matchedfiles="$matchedfiles$recfile
"
    count=$((count + 1))
  done <<EOF2
$meta
EOF2

  # Distinct-credential collapse, for BOTH clients, inside jq against the files
  # — so two aliases carrying the same token never surface it here. The Codex
  # arm skipped this after the restructure, which turned two stale aliases
  # holding one bearer into an ambiguity and switched capture off for a
  # credential that was never ambiguous.
  if [ "$count" -gt 1 ]; then
    if [ "${BRAINS_CRED_CLIENT:-claude}" = "codex" ] && [ -n "${BRAINS_CODEX_CREDENTIALS_FILE:-}" ]; then
      # Array backend: the matched keys are indices into one document.
      count=$(jq -r --argjson keys "$(printf '%s' "$matched" | jq -Rs 'split("\n") | map(select(length>0) | tonumber)')" \
        '(if type == "array" then . else [.] end) as $a
         | [ $keys[] as $i | $a[$i].token_response.access_token ] | unique | length' \
        "$store" 2>/dev/null)
    elif [ "${BRAINS_CRED_CLIENT:-claude}" = "codex" ]; then
      # Keychain backend: one private record file per account.
      count=$(printf '%s' "$matchedfiles" | tr '\n' '\0' | xargs -0 -n 200 \
        jq -s '[.[].token_response.access_token] | unique | length' 2>/dev/null | tail -1)
    else
      count=$(jq -r --argjson keys "$(printf '%s' "$matched" | jq -Rs 'split("\n") | map(select(length>0))')" \
        '[ $keys[] as $k | .mcpOAuth[$k].accessToken ] | unique | length' "$store" 2>/dev/null)
    fi
    # Anything we cannot count is not a clean "one": fall back to ambiguity.
    case "$count" in ''|*[!0-9]*|0) count=2 ;; esac
  fi
  BRAINS_CRED_COUNT="$count"

  # Metadata pass files are no longer needed once counting is done; the winner's
  # is kept just long enough to generate the config below.
  # Codex only: there the retained files are one private record per account. On
  # the Claude path the same column is the single store snapshot, which is
  # discarded on its own — sweeping it here would delete the document out from
  # under config generation.
  _brains_discard_matched() {
    local f keep
    [ "${BRAINS_CRED_CLIENT:-claude}" = "codex" ] || return 0
    keep="${1:-}"
    while IFS= read -r f; do
      [ -n "$f" ] || continue
      [ "$f" = "$keep" ] && continue
      case "$f" in "$BRAINS_CRED_TMP"/*) _brains_discard "$f" ;; esac
    done <<EOF3
$matchedfiles
EOF3
  }

  # ---- the single decision point. I2: indeterminate unless proven otherwise.
  if [ "$BRAINS_CRED_TRUNCATED" = "1" ]; then
    BRAINS_CRED_STATE="indeterminate"
    _brains_discard "${store:-}"; _brains_discard_matched
    return 1
  fi
  if [ "$count" -eq 0 ]; then
    # A complete scan found nothing for this origin. If the store DID hold
    # credentials, the endpoint is the odd one out — a self-hosted `endpoint`
    # with a production sign-in — and telling that user to sign in again just
    # mints another token for the wrong host.
    if [ "$BRAINS_CRED_SAW_ENTRIES" = "1" ]; then
      BRAINS_CRED_STATE="blocked"
    else
      BRAINS_CRED_STATE="no-credential"
    fi
    _brains_discard "${store:-}"; _brains_discard_matched
    return 1
  fi
  if [ "$count" -gt 1 ]; then
    BRAINS_CRED_STATE="indeterminate"
    _brains_discard "${store:-}"; _brains_discard_matched
    return 1
  fi

  key="${matched%%
*}"
  BRAINS_CRED_LOCATOR="$key"
  if [ "${BRAINS_CRED_CLIENT:-claude}" = "codex" ]; then
    # The winning record is already on disk from the metadata pass.
    recfile="${matchedfiles%%
*}"
    _brains_discard_matched "$recfile"
    if [ -n "${BRAINS_CODEX_CREDENTIALS_FILE:-}" ]; then
      _brains_write_config codex-oauth-array "$key" "$recfile" || {
        _brains_discard "$recfile"; BRAINS_CRED_STATE="indeterminate"; return 1; }
    else
      _brains_write_config codex-oauth "" "$recfile" || {
        _brains_discard "$recfile"; BRAINS_CRED_STATE="indeterminate"; return 1; }
    fi
    _brains_discard "$recfile"
    BRAINS_CRED_SOURCE="codex-oauth"
  else
    _brains_write_config claude-oauth "$key" "$store" || {
      _brains_discard "$store"
      BRAINS_CRED_STATE="indeterminate"; return 1
    }
    _brains_discard "$store"
    BRAINS_CRED_SOURCE="claude-oauth"
  fi
  BRAINS_CRED_BINDING="bound"
  BRAINS_CRED_ORIGIN="$want"
  BRAINS_CRED_STATE="ok"
  return 0
}

# ------------------------------------------------------------- health records
# Per capability AND per endpoint, because one capability's success must never
# clear another's failure, and two sessions sharing a state dir can be talking
# to different servers. A read-scoped token returns 200 on the inbox and 403 on
# ingest on every single turn, so a shared record would let the inbox clear a
# warning while capture is completely dead.
#
# Ordering is by LOGICAL GENERATION, allocated at request start under a lock and
# applied only if still the highest. Atomic rename alone is not enough: it makes
# each write torn-free but leaves the read-modify-write open to a lost update.
# No wall clock is read anywhere here, so a clock step cannot reorder anything.
BRAINS_HEALTH_NS="default"
_brains_health_ns_cache_key=""
_brains_health_ns_for() {
  local url origin key
  url="${1:-}"
  if [ "$url" = "$_brains_health_ns_cache_key" ]; then
    printf '%s' "$BRAINS_HEALTH_NS"
    return 0
  fi
  origin=$(brains_origin "$url") || origin="$url"
  key="${BRAINS_CRED_CLIENT:-claude}|$origin"
  BRAINS_HEALTH_NS=$(printf '%s' "$key" | shasum -a 256 2>/dev/null | cut -c1-12)
  [ -n "$BRAINS_HEALTH_NS" ] || BRAINS_HEALTH_NS="default"
  _brains_health_ns_cache_key="$url"
  printf '%s' "$BRAINS_HEALTH_NS"
}

_brains_health_dir() {   # capability, url
  printf '%s/health/%s/%s' "$(brains_state_dir)" "$(_brains_health_ns_for "$2")" "$1"
}

_brains_health_lock() {
  local d i
  d="$1"; i=0
  while [ "$i" -lt 20 ]; do
    if mkdir "$d/.lock" 2>/dev/null; then return 0; fi
    if find "$d/.lock" -maxdepth 0 -mmin +1 2>/dev/null | grep -q .; then
      rmdir "$d/.lock" 2>/dev/null
    fi
    i=$((i + 1))
    sleep 0.05
  done
  return 1
}

_brains_health_unlock() { rmdir "$1/.lock" 2>/dev/null; return 0; }

# Echo a generation for a request that is about to start, or 0 when the lock
# could not be taken. Skipping an update never blocks a turn.
brains_health_begin() {   # capability, url
  local d g
  d=$(_brains_health_dir "$1" "$2")
  mkdir -p "$d" 2>/dev/null || { printf '0'; return 1; }
  _brains_health_lock "$d" || { printf '0'; return 1; }
  g=""
  [ -f "$d/gen" ] && read -r g <"$d/gen" 2>/dev/null
  case "$g" in ''|*[!0-9]*) g=0 ;; esac
  g=$((g + 1))
  printf '%s' "$g" >"$d/gen" 2>/dev/null
  _brains_health_unlock "$d"
  printf '%s' "$g"
}

brains_health_apply() {   # capability, url, generation, outcome
  local cap url gen outcome d a
  cap="$1"; url="$2"; gen="$3"; outcome="$4"
  case "$gen" in ''|*[!0-9]*|0) return 0 ;; esac
  d=$(_brains_health_dir "$cap" "$url")
  mkdir -p "$d" 2>/dev/null || return 0
  _brains_health_lock "$d" || return 0
  a=""
  [ -f "$d/applied" ] && read -r a <"$d/applied" 2>/dev/null
  case "$a" in ''|*[!0-9]*) a=0 ;; esac
  if [ "$gen" -gt "$a" ]; then
    printf '%s' "$outcome" >"$d/state.tmp" 2>/dev/null && mv -f "$d/state.tmp" "$d/state" 2>/dev/null
    printf '%s' "$gen" >"$d/applied" 2>/dev/null
    # A healthy result re-arms the signals this success actually disproves, and
    # only those. An observed 2xx proves a credential resolved and was accepted,
    # so the resolution-level warnings are released; it says nothing about a
    # DIFFERENT capability still being refused.
    if [ "$outcome" = "ok" ]; then
      _brains_signal_release no-credential "$url"
      _brains_signal_release indeterminate "$url"
      _brains_signal_release "rejected-$cap" "$url"
      _brains_signal_release "blocked-$cap" "$url"
    fi
  fi
  _brains_health_unlock "$d"
  return 0
}

brains_health_note() {    # capability, url, outcome
  local cap url outcome gen
  cap="$1"; url="$2"; outcome="$3"
  gen=$(brains_health_begin "$cap" "$url")
  brains_health_apply "$cap" "$url" "$gen" "$outcome"
}

brains_health_state() {   # capability, url
  local d s
  d=$(_brains_health_dir "$1" "$2")
  s=""
  [ -f "$d/state" ] && read -r s <"$d/state" 2>/dev/null
  printf '%s' "$s"
}

# Claims are keyed by CAUSE, not by capability. Nothing-resolved and
# cannot-determine are properties of the credential, so they are one claim
# shared by everything; a refusal or a blocked target is a property of one
# endpoint, so those are per capability.
_brains_signal_dir() { printf '%s/health/%s/.signals' "$(brains_state_dir)" "$(_brains_health_ns_for "$1")"; }

_brains_signal_release() { rmdir "$(_brains_signal_dir "$2")/$1" 2>/dev/null; return 0; }

brains_health_claim_signal() {   # key, url
  local d
  d=$(_brains_signal_dir "$2")
  mkdir -p "$d" 2>/dev/null || return 1
  mkdir "$d/$1" 2>/dev/null || return 1
  return 0
}

# --------------------------------------------------------- the off-state signal
# core.md tells the agent this note is authoritative. It must therefore never
# promise something it does not deliver: two of the four states name a SETTING
# to change rather than a command to run, and an agent told "run the command it
# names" when none is named can invent one and execute it.
#
# Emitted at most once per cause per episode — the claim is released only by an
# OBSERVED success, so declining once does not mute a later break, and a
# credential being rejected on every request cannot mute itself. `unreachable`
# never signals: transient network trouble is not user-actionable, and a warning
# that cries wolf on flaky wifi is how people learn to ignore the one that
# matters.
# Codex reads its MCP sign-in from the macOS keychain, and Codex on Linux is not
# a supported configuration. So on that platform there is no step to name: the
# hooks cannot reach the sign-in, and pointing the user at a token would be
# documenting a path the product does not support. Echoes an empty string, and
# the caller drops the remedy clause rather than inventing one.
_brains_codex_unsupported_here() {
  [ "${BRAINS_CRED_CLIENT:-claude}" = "codex" ] && ! command -v security >/dev/null 2>&1
}

_brains_signin_step() {
  if [ "${BRAINS_CRED_CLIENT:-claude}" = "codex" ]; then
    _brains_codex_unsupported_here && return 0
    printf '%s' 'run `codex mcp login brains` — that sign-in is the credential'
  else
    printf '%s' 'run `claude mcp login plugin:brains:brains` — that sign-in is the credential'
  fi
}

_brains_emit_signal() {  # key, url, label, remedy
  brains_health_claim_signal "$1" "$2" || return 1
  printf '%s\n' '<!-- brains:capture -->'"$3"' is OFF: '"$4"' Offer this to the user once, in one line, and act only if they say yes. Do not repeat it later in the session.<!-- /brains:capture -->'
  return 0
}

brains_capture_signal() {
  local cap url state step label
  step=$(_brains_signin_step)

  # Resolution-level causes first: they explain every capability at once, so
  # they get one message rather than one per endpoint.
  for cap in ingest inbox; do
    [ "$cap" = "ingest" ] && url="$BRAINS_URL_INGEST" || url="$BRAINS_URL_INBOX"
    state=$(brains_health_state "$cap" "$url")
    case "$state" in
      no-credential)
        if _brains_codex_unsupported_here; then
          _brains_emit_signal no-credential "$url" 'Conversation capture and the brains inbox' \
            "brains does not support Codex on this platform, so there is nothing to turn on and nothing to change. Mention it once if it is relevant and do not offer a fix." && return 0
          return 1
        fi
        _brains_emit_signal no-credential "$url" 'Conversation capture and the brains inbox' \
          "no capture credential resolved. To turn it on, $step." && return 0
        return 1 ;;
      indeterminate)
        _brains_emit_signal indeterminate "$url" 'Conversation capture and the brains inbox' \
          "brains could not determine which stored credential belongs to this endpoint — more than one may match it, or the store could not be read in full. Set the plugin's \`token\` option explicitly, or if you have signed into brains twice, remove the duplicate MCP server entry." && return 0
        return 1 ;;
    esac
  done

  # Endpoint-level causes: one capability can be broken while another works.
  for cap in ingest inbox; do
    [ "$cap" = "ingest" ] && url="$BRAINS_URL_INGEST" || url="$BRAINS_URL_INBOX"
    [ "$cap" = "ingest" ] && label="Conversation capture" || label="The brains inbox"
    state=$(brains_health_state "$cap" "$url")
    case "$state" in
      rejected)
        if [ -z "$step" ]; then
          _brains_emit_signal "rejected-$cap" "$url" "$label" \
            "the capture credential was refused by the server." && return 0
          return 1
        fi
        _brains_emit_signal "rejected-$cap" "$url" "$label" \
          "the capture credential was refused by the server. To re-issue it, $step." && return 0 ;;
      blocked)
        _brains_emit_signal "blocked-$cap" "$url" "$label" \
          "this endpoint is a different host from the brains server you are signed into, so the stored credential was not used. Set the plugin's \`token\` option to a token for this endpoint." && return 0 ;;
    esac
  done
  return 1
}

# ------------------------------------------------------------ the ONE request
# Every authenticated call goes through here. Callers pass a capability and a
# URL and read the result out of BRAINS_HTTP_BODY / BRAINS_HTTP_CODE /
# BRAINS_HTTP_OK. The body is deliberately NOT written to stdout: a caller would
# have to wrap the call in a command substitution to capture it, that runs in a
# subshell, and every status variable set here would be discarded with it.
#
# Two things this owns that callers must never re-implement:
#
#   * Binding. A discovered credential is sent ONLY to the origin that minted
#     it. Endpoint URLs are env-overridable, so without this check a token
#     found in the local store could be posted to an unrelated host.
#   * Transport truth. curl writes %{http_code} as soon as headers arrive, so a
#     transfer that dies mid-body still reports 200 — and the truncated body can
#     be perfectly valid JSON. Only curl's EXIT STATUS distinguishes them, so a
#     non-zero exit is a transport failure whatever the code says, the body is
#     not parsed, and health is never advanced to ok.
BRAINS_HTTP_CODE=""
BRAINS_HTTP_BODY=""
BRAINS_HTTP_OK=0
BRAINS_HTTP_BLOCKED=0

brains_request() {
  local rc
  _brains_xtrace_off
  _brains_request_impl "$@"
  rc=$?
  _brains_xtrace_restore
  return $rc
}

_brains_request_impl() {
  local cap url gen resp crc code body outcome origin
  cap="$1"; url="$2"; shift 2
  BRAINS_HTTP_CODE=""; BRAINS_HTTP_BODY=""; BRAINS_HTTP_OK=0; BRAINS_HTTP_BLOCKED=0

  [ "$BRAINS_CRED_STATE" = "ok" ] || return 1
  [ -n "$BRAINS_CRED_CONFIG" ] && [ -s "$BRAINS_CRED_CONFIG" ] || return 1

  if [ "$BRAINS_CRED_BINDING" = "bound" ]; then
    origin=$(brains_origin "$url") || origin=""
    if [ -z "$origin" ] || [ "$origin" != "$BRAINS_CRED_ORIGIN" ]; then
      BRAINS_HTTP_BLOCKED=1
      gen=$(brains_health_begin "$cap" "$url")
      brains_health_apply "$cap" "$url" "$gen" "blocked"
      return 1
    fi
  fi

  gen=$(brains_health_begin "$cap" "$url")
  # -q FIRST, and it must be first for curl to honour it. Without it curl reads
  # the user's ~/.curlrc, and a curlrc carrying `trace-ascii` or `trace` writes
  # outgoing headers — this Authorization line among them — to a file. Measured
  # on curl 8.7.1: the bearer lands in that trace without -q and does not with
  # it. Keeping the header out of argv and out of variables does nothing about a
  # disclosure channel the user's own debugging config opens.
  #
  # Defaults after it, so a caller passing its own --max-time still wins.
  resp=$(curl -q -sS \
           --config "$BRAINS_CRED_CONFIG" \
           --connect-timeout "$BRAINS_CRED_CONNECT_TIMEOUT" \
           --max-time "$BRAINS_CRED_MAX_TIME" \
           -w '\n%{http_code}' \
           "$@" "$url" 2>/dev/null)
  crc=$?
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"

  if [ "$crc" -ne 0 ]; then
    # Transport failure. The body may be a valid JSON prefix of a response that
    # never finished; it is not a response and is not returned.
    BRAINS_HTTP_CODE="$code"
    brains_health_apply "$cap" "$url" "$gen" "unreachable"
    return 1
  fi

  BRAINS_HTTP_CODE="$code"
  case "$code" in
    2*) outcome="ok"; BRAINS_HTTP_OK=1; BRAINS_HTTP_BODY="$body" ;;
    401|403) outcome="rejected" ;;
    000) outcome="unreachable" ;;
    *) outcome="error" ;;
  esac
  brains_health_apply "$cap" "$url" "$gen" "$outcome"
  [ "$BRAINS_HTTP_OK" = "1" ] || return 1
  return 0
}
