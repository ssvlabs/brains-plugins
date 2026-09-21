# AGENTS.md

Conventions for coding agents and contributors in this repo. `CLAUDE.md` is a symlink to this file; edit `AGENTS.md` only.

This repo publishes the brains plugin for Codex and Claude Code. README.md covers what it does and how users install it.

## Generated files

- `plugins/brains/generated/capability-catalog.json` and every file its `artifacts[].artifact_path` lists (today five `plugins/brains/skills/*/SKILL.md` files with a "Do not hand-edit" header) are generated upstream. Do not hand-edit them. They change only through a sync PR that updates the artifacts, the catalog and the version together.
- `tests/plugin-contract/run.ts` pins each artifact's bytes to its `artifact_sha256` in the catalog. `scripts/generated-artifact-guard.sh` fails a PR that changes an artifact without the catalog.
- The rest of `plugins/brains/` (core.md, hooks, the other skills, manifests, .mcp.json) is authored here.

## Versioning

- Content under `plugins/brains/` reaches users only when the plugin version increases. Any PR that changes that tree must raise `version` in both `plugins/brains/.claude-plugin/plugin.json` and `plugins/brains/.codex-plugin/plugin.json` to the same value. The guard requires a strict SemVer increase; the contract test requires the two to match.
- Which digit: `fix` bumps patch, `feat` bumps minor, a breaking change to the plugin contract bumps major. This is convention, not enforced.

## Branches, commits, review

- Branch off `main` and open the PR against `main`; it cannot be pushed to directly.
- `main` requires 1 approving review, signed commits and resolved review threads. A new push dismisses earlier approvals, and the last push needs approval from someone other than its pusher.
- Use conventional commit titles with a scope: `fix(brains): ...`, `feat(brains): ...`, `docs(tests): ...`. Recent plugin changes use scope `brains`. Nothing checks titles.

## Tests

Bun 1.3.8 (the CI version), Node 22 and jq. The hooks parse with jq; without it every suite fails with errors that never name it. Fetch `origin/main`, then run from the repo root:

    bun run tests/plugin-contract/run.ts
    bun run tests/inbox-v2/run.ts
    bun run tests/tool-error/run.ts
    bun run tests/credential/run.ts
    bash scripts/generated-artifact-guard.sh origin/main

- The guard compares committed history, so it refuses uncommitted changes to tracked files.
- The contract test also runs `claude plugin validate --strict` and a Codex install check. Locally each is skipped with a note when that CLI is not on PATH; in CI the Claude check cannot be skipped.
- `tests/plugin-contract/run.ts` pins README.md, core.md and parts of the hooks and skills verbatim, and both plugin manifests and both `marketplace.json` files whole. Only `version` is read from the files rather than pinned. Changing pinned text or adding any field means updating the pin in the same PR. The marketplace files sit outside `plugins/brains/`, so the guard never sees them and this test is their only gate. Read the comment above a pin first; it records why the text is held.
- `tests/inbox-v2/live-claude.ts` and the two `demo-*.ts` scripts beside it drive a real, signed-in `claude -p`. They spend tokens, are non-deterministic and are not in CI; run them by hand.
- Before asking for review on a hook change, run `scripts/mutation-coverage.sh origin/main`. It is slow and not in CI.

## Public repo

This repo is public. Do not add internal hostnames or cluster names, ticket ids, paths in private repos, roadmap or status wording ("planned", "not yet live"), or secrets and tokens, not even as examples, to committed files. Use placeholders like `<your token>`. Existing references to the upstream generator and its paths, in the generated headers, the catalog, the guard and the contract test's comments, stay as they are: do not strip them, and do not add new ones by hand. Ticket references go in the PR title (in square brackets at the end, as recent PRs do) or the PR body, never in committed files. CI does not check this; review for it.

## Shipped code runs on users' machines

The hooks, `core.md` and skills under `plugins/brains/` execute on users' machines with their permissions. Hooks run as shell commands on session, prompt and tool events; `core.md` and hook stdout are injected into the agent's context; skills steer what the agent does. Give changes here the highest scrutiny in the repo:

- Read the whole file, not only the diff hunk.
- In the PR body, state what the change makes the agent or hook do on a user's machine.
- Never add a command or agent instruction that changes the user's files outside the plugin's own state directory, or their settings or accounts, without asking the user first.
