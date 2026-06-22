# brains — Claude Code plugin

Your memory layer for Claude Code: Gmail, Calendar, Drive, and your prior Claude
conversations as queryable pages — with reflexive recall, turn-by-turn capture,
and a server-driven inbox, plus boards, automations, and workflows on top.

## Install

Guided install (recommended): https://mybrains.ai/install/claude-code

Or add the marketplace directly:

```
claude plugin marketplace add https://github.com/ssvlabs/brains-plugins.git
claude plugin install brains@brains
```

You'll paste your brains API token when prompted — find it in your brains
account settings.

## Layout

- `.claude-plugin/marketplace.json` — the marketplace manifest
- `plugins/brains/` — the plugin (prompt, hooks, skills)

## License

[GPL-3.0](./LICENSE)
