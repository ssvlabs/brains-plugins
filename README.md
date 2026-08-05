# brains — Codex and Claude Code plugin

Your memory layer for Codex and Claude Code: Gmail, Calendar, Drive, and prior
AI conversations as queryable pages — with reflexive recall, hook-driven
turn-by-turn capture, a server-driven inbox, boards, automations, and workflows
on top. The same server also backs claude.ai, where no hooks run — see
[Install for claude.ai web](#install-for-claudeai-web).

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

No token needed — Claude Code signs itself in.

```sh
claude plugin marketplace add https://github.com/ssvlabs/brains-plugins.git
claude plugin install brains@brains
claude mcp login plugin:brains:brains
```

If Claude Code does not recognise that login name, run `claude mcp list` and use the name it
shows for the brains server.

`claude mcp login plugin:brains:brains` opens your browser to approve the connection. The
approval screen says **An app on this computer** and shows a `127.0.0.1` address whose port
changes every time — that is Claude Code waiting on your machine, and it is expected. Claude
Code stores the credential itself, so there is nothing to copy or keep. Confirm with
`claude mcp list`.

This flow was verified on Claude Code 2.1.220. If `claude mcp login` is not a recognised
command, update Claude Code.

Restart Claude Code or start a new session. The first time the plugin loads, trust the bundled
brains hooks so automatic recall, capture, inbox delivery, and error feedback can run.

For a local checkout under development:

```sh
claude plugin marketplace add /absolute/path/to/brains-plugins
claude plugin install brains@brains
claude mcp login plugin:brains:brains
```

### Optional: conversation capture and the inbox

The tools above work without this. Capture and the inbox are shell hooks that authenticate
separately from the MCP server and cannot read the credential Claude Code keeps internally, so
they need a brains API token of their own — find it in your brains account settings. Without one
they simply stay off.

Set it when you install:

```sh
claude plugin install brains@brains --config token="<your token>"
```

Or change it afterwards with `/plugin` → brains → Configure.

This token is only for capture and the inbox. It is **not** how Claude Code authenticates the
brains tools — that is `claude mcp login plugin:brains:brains` above.

### Already installed?

Plugins added before the sign-in flow carried the token in their MCP declaration and never
logged in. Update, then sign in:

```sh
claude plugin marketplace update brains
claude plugin update brains
claude mcp login plugin:brains:brains
```

Then run `/reload-plugins`.

### Self-hosting

The brains tools connect to `https://mcp.mybrains.ai/mcp`; to point them at your own
server, fork this repo, set the URL in `plugins/brains/.claude-plugin/plugin.json` and
`plugins/brains/.mcp.json`, and add your fork as the marketplace.

That moves the tools only. Conversation capture and the inbox read the `endpoint` option
instead, so set it when you install or they keep sending to `https://mcp.mybrains.ai`:

```sh
claude plugin install brains@brains --config endpoint=https://your-server
```

Changing `endpoint`'s `default` in your fork does not cover this. Claude Code exports
`CLAUDE_PLUGIN_OPTION_ENDPOINT` to the hooks from the value stored in your settings, and
an option you never set has no stored value — so the hooks fall back to
`https://mcp.mybrains.ai` while your tools talk to your own server.

Codex has no such option and runs the same hook scripts, so set `BRAINS_ENDPOINT` wherever
you set `BRAINS_API_TOKEN` above — the shell Codex starts from, or the app's launch
environment. Without it Codex capture keeps sending to `https://mcp.mybrains.ai` too.

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
