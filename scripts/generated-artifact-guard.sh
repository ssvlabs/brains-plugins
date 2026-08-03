#!/usr/bin/env bash
# Generated-artifact + delivery guard (BRNS-CORE-012).
#
# Two failure modes this repo cannot otherwise catch:
#
#   1. A HAND EDIT to a generated artifact. The artifacts under
#      plugins/brains/skills/ named by generated/capability-catalog.json are
#      rendered in ssvlabs/brains from an authored capability catalog. Editing
#      one here is editing a build output — the next regeneration silently
#      reverts it, and until then the published skill disagrees with the server
#      that produced it. The contract test already digest-pins each artifact, so
#      a LONE edit fails there. An edit WITH the digest refreshed to match clears
#      the contract test, and this guard catches it only through rule 2 below —
#      unbumped, it fails as undelivered. Bump alongside it and it passes: the
#      coordinated case the LIMIT below admits.
#
#   2. A CHANGE THAT REACHES NOBODY. Plugin content ships to users only when the
#      plugin version INCREASES — hosts update on version precedence, not on
#      content. A PR that edits published content without a real bump delivers to
#      zero users while looking merged and done. "Published" is the whole
#      plugins/brains/ tree, not just the generated artifacts: scoping the trigger
#      to artifact-or-catalog let a hand-authored SKILL.md, core.md, the hooks and
#      .mcp.json through unbumped, and that is most of what ships.
#
# Usage:  scripts/generated-artifact-guard.sh [base-ref]     (default origin/main)
#
# A guard that cannot fail loudly is not a guard. Three rules keep this one
# honest, each earned from an observed false pass during review:
#
#   * Both revisions are verified up front. A typo'd base ref used to make every
#     `git diff` fail, print `fatal: bad revision`, produce no output, and be
#     read as "nothing changed" -> `guard: OK`, exit 0.
#   * A diff ERROR is distinguished from an EMPTY diff. `git diff | grep -q .`
#     collapses both into "unchanged", and `set -e` is defused inside `if`/`&&`.
#   * The tree must be clean. This compares committed history (`BASE...HEAD`,
#     matching GitHub's PR diff). Run locally with staged-but-uncommitted work
#     and it judged the wrong tree: 8 staged files, HEAD still at the base,
#     `guard: OK`. Rather than silently answer the wrong question, it refuses.
#
# LIMIT, stated rather than implied: this proves artifact <-> manifest <-> version
# consistency. It CANNOT prove the bytes came from the monorepo generator —
# ssvlabs/brains is private and there is no cross-repo automation, so a
# coordinated edit of artifact + manifest + version still passes. That gap is
# accepted and recorded in the monorepo's packages/capability-catalog/AGENTS.md;
# closing it needs published artifacts or a cross-repo credential.
set -euo pipefail

BASE_REF="${1:-origin/main}"
MANIFEST="plugins/brains/generated/capability-catalog.json"
CLAUDE_MANIFEST="plugins/brains/.claude-plugin/plugin.json"
CODEX_MANIFEST="plugins/brains/.codex-plugin/plugin.json"

die() { echo "guard: $*" >&2; exit 1; }

# ---------------------------------------------------------------- preconditions

git rev-parse --verify --quiet "${BASE_REF}^{commit}" >/dev/null \
  || die "base ref '$BASE_REF' does not resolve to a commit. Fetch it first (in CI: git fetch origin <base>)."
git rev-parse --verify --quiet "HEAD^{commit}" >/dev/null \
  || die "HEAD does not resolve to a commit."

# Compare committed history only, so refuse to run on a dirty tree rather than
# judge a state the PR does not contain.
if ! git diff --quiet HEAD -- . 2>/dev/null || ! git diff --cached --quiet HEAD -- . 2>/dev/null; then
  die "working tree has uncommitted changes to tracked files.
This guard compares committed history ($BASE_REF...HEAD), so it would judge the
wrong tree. Commit (or stash) first, then re-run."
fi

# changed <path> -> 0 when the path differs between base and HEAD, 1 when it does
# not. A git FAILURE is fatal, never a quiet "unchanged".
changed() {
  local path="$1" out status
  set +e
  out="$(git diff --name-only "$BASE_REF...HEAD" -- "$path" 2>&1)"
  status=$?
  set -e
  [ "$status" -eq 0 ] || die "git diff failed for '$path' (exit $status): $out"
  [ -n "$out" ]
}

# ------------------------------------------------------------------- artifacts

# Artifact paths come from the manifest itself, so a newly published artifact is
# covered the day it is added — no second list to keep in sync.
# `while read` rather than `mapfile`: mapfile is bash 4+, and macOS ships 3.2.
ARTIFACTS=""
while IFS= read -r line; do
  ARTIFACTS="${ARTIFACTS}${line}
"
done < <(node -e '
  const fs = require("node:fs");
  const m = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const a of m.artifacts ?? []) console.log(a.artifact_path);
' "$MANIFEST")

if [ -z "$(printf %s "$ARTIFACTS" | tr -d '[:space:]')" ]; then
  die "manifest lists no artifacts — refusing to pass vacuously"
fi

artifact_changed=false
for path in $ARTIFACTS; do
  if changed "$path"; then
    artifact_changed=true
    echo "guard: generated artifact changed — $path"
  fi
done

manifest_changed=false
if changed "$MANIFEST"; then manifest_changed=true; fi

if [ "$artifact_changed" = true ] && [ "$manifest_changed" = false ]; then
  cat >&2 <<'MSG'
guard: a generated artifact changed but generated/capability-catalog.json did not.

These artifacts are rendered in ssvlabs/brains; they are not editable here. Do not
hand-edit them. Regenerate from the monorepo at the commit you intend to publish:

  bun run apps/mcp/scripts/generate-capability-catalog.ts \
    --plugin-root /path/to/brains-plugins --source-commit <40-hex sha>
MSG
  exit 1
fi

# -------------------------------------------------------------------- delivery

# Everything under plugins/brains/ ships — skills, core.md, hooks, .mcp.json — so
# delivery watches the whole tree. Watching only the generated artifacts and their
# catalog let a hand-authored SKILL.md edit merge with no bump and reach nobody.
# Both plugin manifests live under this prefix, so a version-only release bump
# trips this trigger and then satisfies it: no deadlock.
published_changed=false
if changed "plugins/brains"; then published_changed=true; fi

# SemVer PRECEDENCE, not inequality. `!=` accepted a downgrade (2.6.0 -> 2.5.1)
# and a build-metadata-only edit (2.6.0 -> 2.6.0+build.1) — both of which leave
# hosts on the old version, which is the reaches-nobody bug this rule exists for.
# Build metadata is ignored for precedence (SemVer §10) and a prerelease ranks
# BELOW its release (§11), both of which this implements.
semver_gt() {
  node -e '
    // The OFFICIAL SemVer 2.0.0 grammar (semver.org). A looser \d+ / [0-9A-Za-z.-]+
    // pattern accepted three things the spec forbids, each of which reached this
    // gate during review: leading-zero core numbers (02.7.0 was READ AS FORWARD),
    // empty prerelease identifiers (alpha..1), and leading-zero numeric
    // prerelease identifiers (alpha.01). A version this script cannot decide must
    // be REFUSED (exit 2), never quietly ranked.
    const RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
    const parse = (v) => {
      const m = RE.exec(v);
      if (!m) { console.error(`not a SemVer version: ${v}`); process.exit(2); }
      // Core numbers stay STRINGS: see cmpNum.
      return { nums: [m[1], m[2], m[3]], pre: m[4] === undefined ? null : m[4].split(".") };
    };
    // Arbitrary-precision compare of two digit strings. Number() silently rounds
    // above 2^53, which let 1.0.0-9007199254740993.1 -> 1.0.0-9007199254740992.2
    // (a DOWNGRADE) pass: the leading identifiers collapsed to the same float, so
    // the comparison fell through to the next one and the smaller version won.
    // The grammar above guarantees no leading zeros, so length-then-lexicographic
    // on the raw digits is exact at any size.
    const cmpNum = (x, y) =>
      x.length !== y.length ? (x.length < y.length ? -1 : 1) : (x === y ? 0 : (x < y ? -1 : 1));
    const cmp = (a, b) => {
      for (let i = 0; i < 3; i++) { const c = cmpNum(a.nums[i], b.nums[i]); if (c !== 0) return c; }
      if (!a.pre && !b.pre) return 0;
      if (!a.pre) return 1;            // release outranks prerelease (SemVer 11.3)
      if (!b.pre) return -1;
      for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
        const x = a.pre[i], y = b.pre[i];
        if (x === undefined) return -1;   // fewer fields ranks lower (11.4.4)
        if (y === undefined) return 1;
        const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
        if (xn && yn) { const c = cmpNum(x, y); if (c !== 0) return c; continue; }
        if (xn !== yn) return xn ? -1 : 1;   // numeric ranks below alphanumeric (11.4.3)
        if (x !== y) return x < y ? -1 : 1;  // ASCII order (11.4.2)
      }
      return 0;
    };
    process.exit(cmp(parse(process.argv[2]), parse(process.argv[1])) > 0 ? 0 : 1);
  ' "$1" "$2"
}

read_version() {
  node -e '
    const fs = require("node:fs");
    const v = JSON.parse(fs.readFileSync(0, "utf8")).version;
    if (typeof v !== "string") { console.error("manifest has no string version"); process.exit(2); }
    console.log(v);
  '
}

if [ "$artifact_changed" = true ] || [ "$manifest_changed" = true ] || [ "$published_changed" = true ]; then
  for manifest in "$CLAUDE_MANIFEST" "$CODEX_MANIFEST"; do
    base_version="$(git show "$BASE_REF:$manifest" | read_version)"
    head_version="$(read_version < "$manifest")"
    set +e
    semver_gt "$base_version" "$head_version"
    precedence=$?
    set -e
    # exit 2 is the parser refusing the input; saying "did not move forward"
    # there would name the wrong cause and send the reader after the wrong fix.
    if [ "$precedence" -eq 2 ]; then
      die "$manifest carries a version that is not SemVer ($base_version -> $head_version) — precedence is undecidable, so delivery cannot be verified."
    fi
    if [ "$precedence" -ne 0 ]; then
      cat >&2 <<MSG
guard: published content changed but $manifest did not move FORWARD ($base_version -> $head_version).

Hosts update on SemVer precedence, so anything that is not a strict increase
delivers to nobody — a downgrade and a build-metadata-only edit both look like a
change here and reach no user. Bump both plugin manifests (the contract test
asserts they stay version-aligned).
MSG
      exit 1
    fi
    echo "guard: $manifest $base_version -> $head_version"
  done
fi

echo "guard: OK"
