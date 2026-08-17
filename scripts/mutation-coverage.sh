#!/usr/bin/env bash
# Mutation coverage over the shipped shell a branch changes.
#
# WHY THIS EXISTS. tests/credential/run.ts carries a mutation gate that proves a
# hand-picked list of mechanisms is load-bearing. That list was demonstrably
# incomplete: two independent readers each found mechanisms outside it that
# could be deleted outright with every suite still green — a server-identity
# guard whose removal let another MCP server's bearer be selected, and the only
# log line the change is justified by. A hand-maintained registry cannot answer
# "what did we miss", because whatever it misses is by definition not on it.
#
# So this derives the list from the DIFF. For every code line the branch adds or
# changes in the shipped hooks, it neuters that line and runs the behavioural
# suites. A line whose removal changes no observable behaviour is either
# unguarded or not load-bearing, and both answers are worth having.
#
# WHAT IT DOES NOT COVER, stated rather than implied:
#   * Lines that cannot be neutered on their own — `fi`, `done`, a `case`
#     pattern, a loop header. Replacing one with `:` is a syntax error, so it is
#     reported as STRUCTURAL and counted, never silently dropped.
#   * tests/plugin-contract/run.ts is deliberately NOT run. Its region pins are
#     verbatim source text, so they kill almost every mutant regardless of
#     whether anything observes the behaviour. Counting them would report full
#     coverage for a suite that never executes the code. They are a drift guard,
#     which is a different job.
#
# It is NOT part of the per-commit gate: one suite run per line is minutes to
# hours. Run it before asking for review on a change to the hooks.
#
# Usage: scripts/mutation-coverage.sh [base-ref] [jobs]
#        scripts/mutation-coverage.sh --list [base-ref]   # just the mutant set
set -u

ROOT=$(cd "$(dirname "$0")/.." && pwd)
LIST_ONLY=0
if [ "${1:-}" = "--list" ]; then LIST_ONLY=1; shift; fi
BASE="${1:-origin/main}"
JOBS="${2:-4}"

SHIPPED='plugins/brains/hooks/*.sh plugins/brains/hooks/lib/*.sh'
WORK=$(mktemp -d "${TMPDIR:-/tmp}/brains-mutcov.XXXXXX") || exit 1
# EXIT only — the same rule the library states as I3. A signal-killed run leaves
# a directory under TMPDIR, which is what TMPDIR is for.
trap 'rm -rf "$WORK" 2>/dev/null' EXIT

# ---- 1. every code line this branch adds or changes in the shipped hooks -----
# -U0 so there is no context to mistake for a change. The awk tracks the NEW
# file's line numbers across hunks.
# shellcheck disable=SC2086
git -C "$ROOT" diff -U0 "$BASE" -- $SHIPPED |
  awk '
    /^\+\+\+ b\// { file = substr($0, 7); next }
    /^\+\+\+ / { file = ""; next }
    /^@@/ {
      split($3, h, ",")
      ln = substr(h[1], 2) + 0
      next
    }
    /^\+/ { if (file != "") { print file "\t" ln }; ln++; next }
  ' > "$WORK/added.tsv"

# Comments and blank lines are not mechanisms. Everything else is a candidate.
: > "$WORK/candidates.tsv"
while IFS=$(printf '\t') read -r file ln; do
  [ -n "$file" ] || continue
  text=$(awk -v n="$ln" 'NR==n{print; exit}' "$ROOT/$file")
  case "$text" in
    ''|[[:space:]]*'#'*|'#'*) continue ;;
  esac
  case "$text" in *[![:space:]]*) ;; *) continue ;; esac
  printf '%s\t%s\t%s\n' "$file" "$ln" "$text" >> "$WORK/candidates.tsv"
done < "$WORK/added.tsv"

# ---- 2. drop the ones that cannot stand alone ------------------------------
# A line replaced by `:` that no longer parses is part of a construct, not a
# mechanism of its own. Counted and reported, never silently skipped.
: > "$WORK/mutable.tsv"
: > "$WORK/structural.tsv"
while IFS=$(printf '\t') read -r file ln text; do
  [ -n "$file" ] || continue
  probe="$WORK/probe.sh"
  awk -v n="$ln" 'NR==n { match($0, /^[ \t]*/); printf "%s:\n", substr($0, 1, RLENGTH); next } { print }' \
    "$ROOT/$file" > "$probe"
  if bash -n "$probe" 2>/dev/null; then
    printf '%s\t%s\t%s\n' "$file" "$ln" "$text" >> "$WORK/mutable.tsv"
  else
    printf '%s\t%s\t%s\n' "$file" "$ln" "$text" >> "$WORK/structural.tsv"
  fi
done < "$WORK/candidates.tsv"

n_cand=$(wc -l < "$WORK/candidates.tsv" | tr -d ' ')
n_mut=$(wc -l < "$WORK/mutable.tsv" | tr -d ' ')
n_str=$(wc -l < "$WORK/structural.tsv" | tr -d ' ')
printf 'mutation coverage vs %s\n' "$BASE"
printf '  %s changed code lines, %s independently mutable, %s structural (part of a construct)\n' \
  "$n_cand" "$n_mut" "$n_str"

if [ "$LIST_ONLY" = "1" ]; then
  printf '\n--- mutable ---\n'
  cat "$WORK/mutable.tsv"
  printf '\n--- structural (not covered by this tool) ---\n'
  cat "$WORK/structural.tsv"
  exit 0
fi

# ---- 3. one mutant per line, in parallel ------------------------------------
# Parallel is safe because the suites bind ephemeral ports. It was not before:
# fixed ports meant two runs shared one stub server, and receipts for one run
# landed in the other's log.
cat > "$WORK/one.sh" <<'WORKER'
#!/usr/bin/env bash
set -u
ROOT="$1"; WORK="$2"; id="$3"; file="$4"; ln="$5"
dir="$WORK/m.$id"
mkdir -p "$dir" || exit 1
cp -R "$ROOT/plugins" "$ROOT/tests" "$dir/" 2>/dev/null || exit 1
awk -v n="$ln" 'NR==n { match($0, /^[ \t]*/); printf "%s:\n", substr($0, 1, RLENGTH); next } { print }' \
  "$ROOT/$file" > "$dir/$file"
# The in-suite gate is neutered IN THE COPY. It mutates the tree itself, so
# running it inside a mutant is a mutation of a mutation, and its verdicts say
# nothing about the line under test — while costing a third of the runtime. The
# anchor is asserted rather than assumed: a silent miss here would quietly turn
# every result into a slower version of the same answer.
gate="$dir/tests/credential/run.ts"
anchor='  for (const m of MUTATIONS) {'
grep -qF "$anchor" "$gate" || { echo "GATE ANCHOR MISS — update scripts/mutation-coverage.sh" >&2; exit 2; }
awk -v a="$anchor" '{ if (index($0, a)) print "  for (const m of MUTATIONS.slice(0, 0)) {"; else print }' \
  "$gate" > "$gate.tmp" && mv "$gate.tmp" "$gate"
# Fail fast: a mutant only has to be killed once, and most are killed early.
out=$(cd "$dir" && BRAINS_FAIL_FAST=1 bun run tests/credential/run.ts 2>&1)
killers=$(printf '%s' "$out" | grep '  FAIL' | sed 's/^ *FAIL  //; s/ — .*//')
if [ -z "$killers" ]; then
  out2=$(cd "$dir" && BRAINS_FAIL_FAST=1 bun run tests/inbox-v2/run.ts 2>&1; \
         cd "$dir" && BRAINS_FAIL_FAST=1 bun run tests/tool-error/run.ts 2>&1)
  killers=$(printf '%s' "$out2" | grep -iE '^\s*(FAIL|✗)' | head -3)
fi
rm -rf "$dir" 2>/dev/null
if [ -z "$killers" ]; then
  printf 'SURVIVED\t%s\t%s\n' "$file" "$ln" >> "$WORK/results.tsv"
else
  printf 'killed\t%s\t%s\t%s\n' "$file" "$ln" "$(printf '%s' "$killers" | head -1)" >> "$WORK/results.tsv"
fi
WORKER
chmod +x "$WORK/one.sh"

: > "$WORK/results.tsv"
i=0
: > "$WORK/jobs.txt"
while IFS=$(printf '\t') read -r file ln text; do
  [ -n "$file" ] || continue
  i=$((i + 1))
  printf '%s\t%s\t%s\n' "$i" "$file" "$ln" >> "$WORK/jobs.txt"
done < "$WORK/mutable.tsv"

printf '  running %s mutants at %s-way parallelism...\n' "$n_mut" "$JOBS"
# shellcheck disable=SC2016
tr '\t' '\n' < "$WORK/jobs.txt" | xargs -P "$JOBS" -n 3 "$WORK/one.sh" "$ROOT" "$WORK"

# ---- 4. report ---------------------------------------------------------------
survivors=$(grep -c '^SURVIVED' "$WORK/results.tsv" 2>/dev/null | tr -d ' ')
[ -n "$survivors" ] || survivors=0
printf '\n  %s killed, %s SURVIVED\n' "$(grep -c '^killed' "$WORK/results.tsv" | tr -d ' ')" "$survivors"
if [ "$survivors" != "0" ]; then
  printf '\n  survivors — removing each of these changed nothing any suite can see:\n'
  while IFS=$(printf '\t') read -r verdict file ln _; do
    [ "$verdict" = "SURVIVED" ] || continue
    printf '    %s:%s  %s\n' "$file" "$ln" "$(awk -v n="$ln" 'NR==n{print; exit}' "$ROOT/$file" | sed 's/^[[:space:]]*//')"
  done < "$WORK/results.tsv"
fi
if [ "$n_str" != "0" ]; then
  printf '\n  (%s structural lines were not mutated — see the header for why)\n' "$n_str"
fi
[ "$survivors" = "0" ]
