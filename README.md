# brains — Codex and Claude Code plugin

Your memory layer for Codex and Claude Code: Gmail, Calendar, Drive, and prior
AI conversations as queryable pages — with reflexive recall, turn-by-turn
capture, a server-driven inbox, boards, automations, and workflows on top.

The Codex and Claude packages share the same seven skills, core prompt, hook
scripts, and inbox engine. Only their manifests, hook event maps, and MCP
authentication declarations are client-specific.

## Install for Codex

Find your brains API token in your brains account settings, then make it
available to Codex as `BRAINS_API_TOKEN`.

```sh
export BRAINS_API_TOKEN="<your token>"
codex plugin marketplace add ssvlabs/brains-plugins
codex plugin add brains@brains
```

The `export` applies to Codex started from that shell. If you use the macOS
desktop app, set the variable for the app's launch environment (for example,
`launchctl setenv BRAINS_API_TOKEN "<your token>"`) before restarting it.

Restart the ChatGPT desktop app or start a new Codex thread. The first time the
plugin loads, open `/hooks` and trust the bundled brains hooks so automatic
recall, capture, inbox delivery, and error feedback can run.

For a local checkout under development:

```sh
codex plugin marketplace add /absolute/path/to/brains-plugins
codex plugin add brains@brains
```

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
