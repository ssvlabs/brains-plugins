# brains — Codex and Claude Code plugin

Your memory layer for Codex and Claude Code: Gmail, Calendar, Drive, and prior
AI conversations as queryable pages — with reflexive recall, hook-driven
turn-by-turn capture and inbox delivery, boards, automations, and workflows
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
plugin loads, open `/hooks` and trust the bundled brains hooks — that is what
runs automatic recall and error feedback. Capture and inbox delivery use the
sign-in above as their credential, so there is nothing further to set.

Capture and the inbox are **macOS only** for Codex: they read the credential
from the macOS keychain, and Codex on Linux is not a supported configuration.
The tools and recall still work there; capture and inbox delivery do not.

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

### Optional: an explicit capture token

You do not need this. Capture and the inbox read the credential `codex mcp login
brains` already stored, so the sign-in above is all they need. To check what has
been captured, ask brains which chats it has, or run
`list_pages type=chat_session`.

Set a token to capture into a different brains account, or to reach an endpoint
your sign-in does not cover — find it in your brains account settings:

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

Running your own brains server? Set `BRAINS_ENDPOINT` alongside it — see
[Self-hosting](#self-hosting).

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
brains hooks — that is what runs automatic recall and error feedback. Capture and inbox delivery
use the sign-in above as their credential, so there is normally nothing further to set. If
`list_pages type=chat_session` shows nothing after a few turns, set the token below.

For a local checkout under development:

```sh
claude plugin marketplace add /absolute/path/to/brains-plugins
claude plugin install brains@brains
claude mcp login plugin:brains:brains
```

### Optional: an explicit capture token

You do not need this. Capture and the inbox read the credential `claude mcp login
plugin:brains:brains` already stored, so the sign-in above is all they need. To check what has
been captured, ask brains which chats it has, or run `list_pages type=chat_session`.

Set a token only to capture into a different brains account, or to reach an endpoint your sign-in
does not cover — find it in your brains account settings:

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

## Install for claude.ai web

claude.ai does not run this repo's hooks, so the capture that Codex and Claude
Code get from `hooks/` does not happen there. Two ways in, both covered step by
step at <https://app.mybrains.ai/install/claude-web>:

- **Custom connector** — add `https://mcp.mybrains.ai/mcp` and approve the OAuth
  screen. This is the path we verified end to end.
- **Full plugin** — add this repository as a marketplace and install from it.
  Paid plans only; it also brings the skills. The hooks it lists stay inert.

Recall works: ask about a person, project or past conversation and Claude
reaches for brains on its own.

**Capture is different — ask for it.** On claude.ai a conversation is saved only
when Claude calls `save_chat_session`. Say "save this chat to brains" and it
does; that is the dependable way, and the way to treat anything you want kept.

With the install guide's instruction block in place Claude also saves on its own
sometimes — but only sometimes, and in testing it once said it was saving
without actually doing so. Don't rely on it, and don't take the sentence in the
chat as proof: `list_pages type=chat_session`, or just ask brains which chats it
has, is the only real confirmation.

## Shared layout

- `.agents/plugins/marketplace.json` — Codex marketplace
- `.claude-plugin/marketplace.json` — Claude Code marketplace
- `plugins/brains/.codex-plugin/plugin.json` — Codex manifest
- `plugins/brains/.claude-plugin/plugin.json` — Claude Code manifest
- `plugins/brains/.mcp.json` — Codex MCP declaration
- `plugins/brains/skills/` — shared skills
- `plugins/brains/hooks/` — shared scripts plus client-specific event maps

## Self-hosting

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

## License

[GPL-3.0](./LICENSE)
