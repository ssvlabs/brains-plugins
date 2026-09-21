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
- `main` requires 1 approving review, signed commits and resolved review threads. A new push dismisses earlier approvals, and the last push needs approval from someone other than its pusher. Copilot reviews every push to a non-draft PR.
- Use conventional commit titles with a scope: `fix(brains): ...`, `feat(brains): ...`, `docs(tests): ...`. Recent plugin changes use scope `brains`. Nothing checks titles.

## Tests

Bun 1.3.8 (the CI version) and Node 22. Run from the repo root:

    bun run tests/plugin-contract/run.ts
    bun run tests/inbox-v2/run.ts
    bun run tests/tool-error/run.ts
    bun run tests/credential/run.ts
    bash scripts/generated-artifact-guard.sh origin/main

- The guard compares committed history, so it refuses uncommitted changes to tracked files. Fetch `origin/main` first.
- The contract test also runs `claude plugin validate --strict` and a Codex install check. Locally each is skipped with a note when that CLI is not on PATH; in CI the Claude check cannot be skipped.
- README.md, core.md, the manifest descriptions and parts of the hooks and skills are pinned verbatim in `tests/plugin-contract/run.ts`. Changing that text means updating the pin in the same PR. Read the comment above the pin first; it records why the text is held.
- `tests/inbox-v2/live-claude.ts` and the two `demo-*.ts` scripts beside it drive a real, signed-in `claude -p`. They spend tokens, are non-deterministic and are not in CI; run them by hand.
- Before asking for review on a hook change, run `scripts/mutation-coverage.sh origin/main`. It is slow and not in CI.

## Public repo

This repo is public. Do not add internal hostnames or cluster names, ticket ids, paths in private repos, roadmap or status wording ("planned", "not yet live"), or secrets and tokens, not even as examples, to committed files. Use placeholders like `<your token>`. The generated headers naming their upstream generator are the one exception. Put ticket references and other traceability in the PR body. CI does not check this; review for it.

## Shipped code runs on users' machines

The hooks, `core.md` and skills under `plugins/brains/` execute on users' machines with their permissions. Hooks run as shell commands on session, prompt and tool events; `core.md` and hook stdout are injected into the agent's context; skills steer what the agent does. Give changes here the highest scrutiny in the repo:

- Read the whole file, not only the diff hunk.
- In the PR body, state what the change makes the agent or hook do on a user's machine.
- Never add a command or agent instruction that changes the user's files outside the plugin's own state directory, or their settings or accounts, without asking the user first.
