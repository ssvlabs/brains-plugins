# brains — Codex and Claude Code plugin

Your memory layer for Codex and Claude Code: Gmail, Calendar, Drive, and prior
AI conversations as queryable pages — with reflexive recall, turn-by-turn
capture, a server-driven inbox, boards, automations, and workflows on top.

The Codex and Claude packages share the same seven skills, core prompt, hook
scripts, and inbox engine. Only their manifests, hook event maps, and MCP
authentication declarations are client-specific.

## Install for Codex

No token needed — Codex signs itself in.

Needs Codex **0.131** or newer. Check with:

```sh
codex plugin --help
```

If that errors with an unknown subcommand, run `codex update` first.

```sh
codex plugin marketplace add ssvlabs/brains-plugins
codex plugin add brains@brains
codex mcp login brains
```

`codex mcp login brains` opens your browser to approve the connection. The
approval screen says **An app on this computer** and shows a `127.0.0.1` address
whose port changes every time — that is Codex waiting on your machine, and it is
expected. Codex stores the credential itself, so there is nothing to copy or
keep. Confirm with `codex mcp list`: brains should read **OAuth**.

Restart the ChatGPT desktop app or start a new Codex thread. The first time the
plugin loads, open `/hooks` and trust the bundled brains hooks so automatic
recall, capture, inbox delivery, and error feedback can run.

Everyday reading and writing is covered by default. For admin-gated tools or
performance insights, sign in asking for them explicitly (both also need the
matching access on your account):

```sh
codex mcp login brains --scopes read,write,admin
codex mcp login brains --scopes read,write,perf_insights
```

For a local checkout under development:

```sh
codex plugin marketplace add /absolute/path/to/brains-plugins
codex plugin add brains@brains
codex mcp login brains
```

### Optional: conversation capture and the inbox

The tools above work without this. Capture and the inbox are shell hooks that
authenticate separately from the MCP server and cannot read the credential Codex
keeps internally, so they need a brains API token of their own — find it in your
brains account settings. Without one they simply stay off.

```sh
export BRAINS_API_TOKEN="<your token>"
```

That applies to Codex started from that shell. The macOS desktop app never
inherits a shell export, so set it for the app's launch environment instead and
restart the app:

```sh
launchctl setenv BRAINS_API_TOKEN "<your token>"
```

This token is only for capture and the inbox. It is **not** how Codex
authenticates the brains tools — that is `codex mcp login brains` above.

## Install for Claude Code

Guided install (recommended): https://mybrains.ai/install/claude-code

Or add the marketplace directly:

```sh
claude plugin marketplace add https://github.com/ssvlabs/brains-plugins.git
claude plugin install brains@brains
```

Claude Code prompts for the brains API token during installation.

## Shared layout

- `.agents/plugins/marketplace.json` — Codex marketplace
- `.claude-plugin/marketplace.json` — Claude Code marketplace
- `plugins/brains/.codex-plugin/plugin.json` — Codex manifest
- `plugins/brains/.claude-plugin/plugin.json` — Claude Code manifest
- `plugins/brains/.mcp.json` — Codex MCP declaration
- `plugins/brains/skills/` — shared skills
- `plugins/brains/hooks/` — shared scripts plus client-specific event maps

## License

[GPL-3.0](./LICENSE)
