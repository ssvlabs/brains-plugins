#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const PLUGIN = join(ROOT, "plugins", "brains");

// The scope set the Codex MCP server requests at login, and the complete set of keys its
// declaration may carry. Both are pinned because Codex IGNORES keys it does not recognise rather
// than rejecting them: a misspelled `scope` would be dropped silently and the login would fall
// back to requesting every scope the server advertises. Codex does not echo `scopes` back through
// `mcp list` / `mcp get`, so an allow-list on this side is the only defence against a typo.
const CODEX_MCP_SCOPES = ["read", "write"];
const CODEX_MCP_KEYS = ["type", "url", "scopes"];

// The oldest Codex that can run this install, and the command that proves it. The floor is set by
// the `codex plugin` command surface — `codex mcp login` shipped much earlier, so probing the login
// would pass on versions that then fail at `codex plugin marketplace add`.
const CODEX_MIN_VERSION = "0.131";
const CODEX_CAPABILITY_PROBE = "codex plugin --help";

// Claude Code signs itself into the MCP server, so the login command is part of the contract:
// the manifest copy, the README and the drift nudge must all name it WITH its plugin-scoped
// argument. A bare `claude mcp login` is unusable — the CLI requires the server name.
const CLAUDE_MCP_LOGIN = "claude mcp login plugin:brains:brains";
const CLAUDE_MCP_URL = "https://mcp.mybrains.ai/mcp";
const CLAUDE_ENDPOINT = "https://mcp.mybrains.ai";
// Stands in for a user's own brains server in the hook-endpoint check at the bottom of this file.
// A `.test` host can never resolve, so if the fake curl there ever stopped intercepting, the check
// would fail rather than quietly reach something real.
const CLAUDE_SELF_HOSTED = "https://self.example.test";
// The middle branch of the hooks' BASE chain — BRAINS_ENDPOINT — which is the only lever a
// self-hosting Codex user has, since Codex has no userConfig mechanism at all.
const HOOK_ENV_ENDPOINT = "https://envvar-probe.example.test";
const CLAUDE_LOOPBACK = "127.0.0.1";
const CLAUDE_MCP_KEYS = ["type", "url"];
const CLAUDE_OPTIONAL_HEADING = "### Optional:";
// The qualifier the Claude surfaces must carry. It scopes capture and the inbox together, because
// they share one credential gate and one delivery mechanism.
const CAPTURE_QUALIFIER = "hook-driven turn-by-turn capture and inbox delivery";
// Codex's card says it shorter: it qualifies capture and never claimed the inbox, so the same rule
// lands on a different string. Reverting this one word — back to "automatic context and capture
// plus" — was one of the two unpinned surfaces that restored the deleted claim with every gate green.
const CODEX_CAPTURE_QUALIFIER = "hook-driven capture";

// The four product descriptions, pinned VERBATIM. The qualifier check below is a signal, not the
// guarantee: it reads what is LEFT once the approved phrase is removed, so a rewrite that keeps the
// qualifier and then contradicts it — "…capture and inbox delivery — always on, no token or
// configuration needed, in every chat including claude.ai…" — passes it, and so does one that avoids
// both stems: "Every turn is recorded to brains and server messages reach your session on their
// own." Both were demonstrated in review. These constants are what actually hold the copy.
const CLAUDE_MANIFEST_DESCRIPTION =
  "Your memory layer: Gmail, Calendar, Drive, and prior Claude conversations as queryable pages, " +
  "with reflexive recall, hook-driven turn-by-turn capture and inbox delivery, and " +
  "boards/automations/workflows on top.";
const CLAUDE_MARKETPLACE_DESCRIPTION =
  "Your memory layer: Gmail/Calendar/Drive and prior Claude conversations as queryable pages — " +
  "reflexive recall, hook-driven turn-by-turn capture and inbox delivery, and " +
  "boards/automations/workflows on top.";
const CODEX_MANIFEST_DESCRIPTION =
  "Your personal memory layer for Codex: query Gmail, Calendar, Drive, and prior conversations, " +
  "then build boards, automations, and workflows.";
const CODEX_LONG_DESCRIPTION =
  "Query your Gmail, Calendar, Drive, and prior AI conversations from Codex, with automatic context " +
  "and hook-driven capture plus boards, automations, workflows, and feedback flows.";
// The rest of the copy on the same two cards. `shortDescription` is the reason the artifacts below
// are pinned WHOLE rather than field by field: it was not in the inventory, and setting it to
// "Automatic capture, no setup" reached the Codex card with every gate green.
const CODEX_SHORT_DESCRIPTION = "Your personal memory layer";
const CODEX_DISPLAY_NAME = "Brains";
const CLAUDE_MARKETPLACE_BLURB = "The brains memory layer, as a Claude Code plugin.";

// The COMPLETE hook event map per client: event -> the script that must run for it. Pinned as an
// exact set rather than an includes-list because three holes sat under the old assertions, and each
// one let published behaviour reach zero users with the suite green (#14):
//
//   1. AN EVENT COULD BE DELETED. Only PostToolUseFailure and SessionEnd were asserted for Claude —
//      SessionStart, UserPromptSubmit and Stop never were. Deleting SessionStart passed both
//      suites, and SessionStart is the ONLY delivery path for core.md (brains-start.sh:27 cats it).
//      So every verbatim copy pin in this file proved the text was correct while nothing proved it
//      ever loads. Guard-works is not guard-runs.
//   2. AN EVENT COULD BE GUTTED. `includes("PostToolUseFailure")` is satisfied by the KEY existing,
//      so `PostToolUseFailure: []` passed with its own assertion intact — the assertion guaranteed
//      a name, not a hook.
//   3. THE MAPPING WAS UNPINNED. Pointing SessionStart at brains-end.sh passed.
//
// Codex carried all three identically, so both maps are checked the same way. Adding or removing an
// event is now a deliberate two-line edit — this constant and the JSON together — the same shape as
// the copy pins above. The three positive `includes` assertions these replace are gone: exact-set
// equality subsumes them, and keeping per-event positives for some events and not others is how the
// gap formed in the first place.
//
// The value is the COMPLETE declared group array, not a {matcher, command} subset, because three more
// holes sat under a subset check and each one was executed:
//
//   4. THE MATCHER WAS UNPINNED. Narrowing Claude's SessionStart to "resume" — or to a string that
//      matches nothing — deletes core.md from every fresh session while every assertion here stays
//      green. That is hole 1 wearing a different hat.
//   5. THE COMMAND WAS MATCHED BY SUBSTRING. `includes("hooks/brains-start.sh")` is satisfied by a
//      MENTION, so a second hook running something else with `# hooks/brains-start.sh` in a trailing
//      comment passed. Commands are pinned whole, guard prefix included.
//   6. EVERY OTHER KEY WAS INVISIBLE. `"type": "comand"` on Stop and `"timeout": 1` on SessionStart —
//      a documented Claude field, which would cancel brains-start.sh mid-inbox-pull — both survived a
//      subset pin AND `claude plugin validate --strict`. So the whole group array is compared, by
//      canonical JSON: added, removed and retyped keys all fail.
//
// An absent matcher is asserted as an ABSENCE rather than as null: these events must run for EVERY
// occurrence, and both a matcher and an explicit null narrow them.
type HookGroup = {
  matcher?: string;
  hooks: { type: string; command: string; statusMessage?: string }[];
};
const CLAUDE_HOOK_EVENTS: Record<string, HookGroup[]> = {
  SessionStart: [
    {
      matcher: "startup|resume|clear|compact",
      hooks: [
        {
          type: "command",
          command: 'BRAINS_STATE_DIR="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}"/hooks/brains-start.sh',
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        {
          type: "command",
          command: 'BRAINS_STATE_DIR="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}"/hooks/brains-turn.sh',
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: 'BRAINS_STATE_DIR="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}"/hooks/brains-turn.sh',
        },
      ],
    },
  ],
  SessionEnd: [
    {
      hooks: [
        {
          type: "command",
          command: 'BRAINS_STATE_DIR="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}"/hooks/brains-end.sh',
        },
      ],
    },
  ],
  PostToolUseFailure: [
    {
      matcher: "mcp__brains__.*",
      hooks: [
        {
          type: "command",
          command: 'BRAINS_STATE_DIR="${CLAUDE_PLUGIN_DATA}" "${CLAUDE_PLUGIN_ROOT}"/hooks/brains-tool-error.sh',
        },
      ],
    },
  ],
};
const CODEX_HOOK_EVENTS: Record<string, HookGroup[]> = {
  SessionStart: [
    {
      matcher: "startup|resume|clear|compact",
      hooks: [
        {
          type: "command",
          command:
            '[ -x "${PLUGIN_ROOT}/hooks/brains-start.sh" ] || exit 0; ' +
            'BRAINS_STATE_DIR="${PLUGIN_DATA}" "${PLUGIN_ROOT}"/hooks/brains-start.sh',
          statusMessage: "Loading brains memory",
        },
      ],
    },
  ],
  UserPromptSubmit: [
    {
      hooks: [
        {
          type: "command",
          command:
            '[ -x "${PLUGIN_ROOT}/hooks/brains-turn.sh" ] || exit 0; ' +
            'BRAINS_STATE_DIR="${PLUGIN_DATA}" "${PLUGIN_ROOT}"/hooks/brains-turn.sh',
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command:
            '[ -x "${PLUGIN_ROOT}/hooks/brains-turn.sh" ] || exit 0; ' +
            'BRAINS_STATE_DIR="${PLUGIN_DATA}" "${PLUGIN_ROOT}"/hooks/brains-turn.sh',
        },
      ],
    },
  ],
  PostToolUse: [
    {
      matcher: "mcp__brains__.*",
      hooks: [
        {
          type: "command",
          command:
            '[ -x "${PLUGIN_ROOT}/hooks/brains-tool-error.sh" ] || exit 0; ' +
            'BRAINS_STATE_DIR="${PLUGIN_DATA}" "${PLUGIN_ROOT}"/hooks/brains-tool-error.sh',
        },
      ],
    },
  ],
};
const CLAUDE_WEB_HEADING = "## Install for claude.ai web";
// The one URL a web reader needs; the connector dialog takes it verbatim.
const CLAUDE_WEB_GUIDE = "https://app.mybrains.ai/install/claude-web";

// Approved claude.ai capture copy, pinned VERBATIM for the same reason as CLAUDE_INSTALL_REGION
// below: keyword assertions on this section proved evadable in review. A rewrite reading
// "Capture is handled automatically for you — Claude saves your conversations on its own, so
// there is nothing to do. (Early builds fired only sometimes; if you are on one, say 'save this
// chat to brains' or call save_chat_session, and check with list_pages type=chat_session.)"
// satisfied EVERY signal check — each keyword survived inside a parenthetical while the meaning
// was fully reversed. So the wording itself is the contract here too.
//
// What the wording encodes, measured live on claude.ai (2026-08-05): an explicit ask works;
// unprompted capture fired on ONE of five passive trials; one trial announced a save it never
// performed, which is why the copy tells the reader how to verify rather than merely disclaiming.
// The named signal assertions further down are kept as well — they give a precise failure on a
// legitimate edit, ahead of this whole-region diff.
// Pinned WHOLE-SECTION, heading to the shared-layout heading. Pinning only the two capture
// paragraphs left the intro, both install paths and the "Recall works" paragraph keyword-guarded
// only — and that was enough to smuggle the claim back in a paragraph of its own. Appending this
// after "Recall works" passed every check:
//
//   Capture works the same way: once connected, Claude saves your conversations to
//   brains automatically, so there is nothing for you to do.
//
// A partial pin also made the guarantee easy to overstate in review. The section is short and
// changing it is a two-line diff; there is no reason for any of it to be unpinned.
const CLAUDE_WEB_REGION = [
  CLAUDE_WEB_HEADING,
  "",
  "claude.ai does not run this repo's hooks, so the capture that Codex and Claude",
  "Code get from `hooks/` does not happen there. Two ways in, both covered step by",
  "step at <" + CLAUDE_WEB_GUIDE + ">:",
  "",
  "- **Custom connector** — add `" + CLAUDE_MCP_URL + "` and approve the OAuth",
  "  screen. This is the path we verified end to end.",
  "- **Full plugin** — add this repository as a marketplace and install from it.",
  "  Paid plans only; it also brings the skills. The hooks it lists stay inert.",
  "",
  "Recall works: ask about a person, project or past conversation and Claude",
  "reaches for brains on its own.",
  "",
  "**Capture is different — ask for it.** On claude.ai a conversation is saved only",
  "when Claude calls `save_chat_session`. Say \"save this chat to brains\" and it",
  "does; that is the dependable way, and the way to treat anything you want kept.",
  "",
  "With the install guide's instruction block in place Claude also saves on its own",
  "sometimes — but only sometimes, and in testing it once said it was saving",
  "without actually doing so. Don't rely on it, and don't take the sentence in the",
  "chat as proof: `list_pages type=chat_session`, or just ask brains which chats it",
  "has, is the only real confirmation.",
].join("\n");

// Approved token copy, pinned verbatim. Hand-written phrasing checks proved both evadable and
// prone to false positives, so the wording itself is the contract; the regex pair further down
// stays only as a backstop.
const CLAUDE_TOKEN_TITLE = "brains API token (optional)";
const CLAUDE_TOKEN_DESCRIPTION =
  "Optional. Enables conversation capture and the inbox, which authenticate separately from the " +
  "MCP server. NOT how the brains tools authenticate — that is `claude mcp login " +
  "plugin:brains:brains`. Find it in your brains account settings; without one, capture and the " +
  "inbox simply stay off.";

// Approved endpoint copy, pinned for the same reason and against a specific regression: this text
// used to promise that /mcp derived from the endpoint, and it would have gone on saying so after
// that stopped being true. Pinning it forces the copy to move whenever the derivation does — it now
// has to name which halves the setting still governs, and admit which one it does not.
const CLAUDE_ENDPOINT_DESCRIPTION =
  "Base URL of your brains server (no trailing slash). Conversation capture and the inbox derive " +
  "/ingest/claude and /inbox/claude from it. The brains tools connect to " +
  "https://mcp.mybrains.ai/mcp regardless of this setting.";

// Approved README copy. The opener and the version note are pinned individually as well as
// inside the region below, so a reviewer gets a precise failure before the whole-region diff.
const CLAUDE_TOKEN_OPENER = "No token needed — Claude Code signs itself in.";
const CLAUDE_VERSION_NOTE =
  "This flow was verified on Claude Code 2.1.220. If `claude mcp login` is not a recognised\n" +
  "command, update Claude Code.";

// No Claude Code version floor is verifiable — the CLI is closed source and ships no probe for
// a minimum. Below the Optional heading the word "token" is legitimate, so only version floors
// are banned there: a version shape (two OR three components, so `2.1+` cannot slip past a
// semver-only pattern) and the comparative vocabulary that turns a version into a requirement.
const CLAUDE_VERSION_SHAPE = /\bv?\d+\.\d+(\.\d+)?\b/;
const CLAUDE_FLOOR_VOCAB =
  /\b(minimum|at least|no older|requires?|or (a )?(newer|later)|and (later|up)|or above|and above)\b/i;

// The README's opening paragraphs, pinned verbatim. This is a fixed product surface exactly like the
// two cards — it is what a reader sees before any install step — and nothing pinned it, so reverting
// three lines to the pre-PR intro ("reflexive recall, turn-by-turn capture, a server-driven inbox")
// restored the deleted claim with all four gates green.
const README_INTRO_REGION = [
  "# brains — Codex and Claude Code plugin",
  "",
  "Your memory layer for Codex and Claude Code: Gmail, Calendar, Drive, and prior",
  "AI conversations as queryable pages — with reflexive recall, hook-driven",
  "turn-by-turn capture and inbox delivery, boards, automations, and workflows",
  "on top. The same server also backs claude.ai, where no hooks run — see",
  "[Install for claude.ai web](#install-for-claudeai-web).",
  "",
  "The Codex and Claude packages share the same seven skills, core prompt, hook",
  "scripts, and inbox engine. Only their manifests, hook event maps, and MCP",
  "authentication declarations are client-specific.",
].join("\n");

// The entire Codex install region, heading to its Optional heading, pinned verbatim for the same
// reason as the Claude one below. Two literal bans were all that stood here, and a false promise
// paraphrased around them passed the whole suite: "Once trusted, every conversation is captured
// automatically — no token needed." dropped in after the trust paragraph is a claim this PR exists
// to delete, on the surface a Codex user reads while deciding whether to trust the hooks.
const CODEX_INSTALL_REGION = [
  "## Install for Codex",
  "",
  "No token needed — Codex signs itself in.",
  "",
  "Needs Codex **" + CODEX_MIN_VERSION + "** or newer. Check with:",
  "",
  "```sh",
  CODEX_CAPABILITY_PROBE,
  "```",
  "",
  "If that errors with an unknown subcommand, run `codex update` first.",
  "",
  "```sh",
  "codex plugin marketplace add ssvlabs/brains-plugins",
  "codex plugin add brains@brains",
  "codex mcp login brains",
  "```",
  "",
  "`codex mcp login brains` opens your browser to approve the connection. The",
  "approval screen says **An app on this computer** and shows a `127.0.0.1` address",
  "whose port changes every time — that is Codex waiting on your machine, and it is",
  "expected. Codex stores the credential itself, so there is nothing to copy or",
  "keep. Confirm with `codex mcp list`: brains should read **OAuth**.",
  "",
  "Restart the ChatGPT desktop app or start a new Codex thread. The first time the",
  "plugin loads, open `/hooks` and trust the bundled brains hooks — that is what",
  "runs automatic recall and error feedback. Capture and inbox delivery also need a",
  "capture credential — normally the token below.",
  "",
  "Everyday reading and writing is covered by default. For admin-gated tools or",
  "performance insights, sign in asking for them explicitly (both also need the",
  "matching access on your account):",
  "",
  "```sh",
  "codex mcp login brains --scopes read,write,admin",
  "codex mcp login brains --scopes read,write,perf_insights",
  "```",
  "",
  "For a local checkout under development:",
  "",
  "```sh",
  "codex plugin marketplace add /absolute/path/to/brains-plugins",
  "codex plugin add brains@brains",
  "codex mcp login brains",
  "```",
].join("\n");

// The Codex token section, heading line INCLUDED. It was left unpinned on the argument that "token"
// is legitimate here — it IS the token section — so pinning would freeze docs that should stay
// editable. Two executed evasions retired that argument: the heading itself carries copy, and
// rewriting it to "### Optional setup? No — this token is required for every brains feature" left
// the `### Optional` needle counting once while inverting what the section says; and a capture
// promise with neither stem ("Conversation capture is built in. It runs by itself for every
// session, and server updates arrive there too.") passed the canary in the body. Editing stays
// possible; it is now the deliberate two-line diff every other region in this file already demands.
const CODEX_OPTIONAL_REGION = [
  "### Optional: conversation capture and the inbox",
  "",
  "The tools above work without this. Capture and the inbox are shell hooks that",
  "authenticate separately from the MCP server and cannot read the credential Codex",
  "keeps internally, so they need a brains API token of their own — find it in your",
  "brains account settings. Without one they simply stay off.",
  "",
  "```sh",
  'export BRAINS_API_TOKEN="<your token>"',
  "```",
  "",
  "That applies to Codex started from that shell. The macOS desktop app never",
  "inherits a shell export, so set it for the app's launch environment instead and",
  "restart the app:",
  "",
  "```sh",
  'launchctl setenv BRAINS_API_TOKEN "<your token>"',
  "```",
  "",
  "This token is only for capture and the inbox. It is **not** how Codex",
  "authenticates the brains tools — that is `codex mcp login brains` above.",
  "",
  "Running your own brains server? Set `BRAINS_ENDPOINT` alongside it — see",
  "[Self-hosting](#self-hosting).",
].join("\n");

// The entire region from the Claude install heading to the Optional heading, pinned verbatim.
// Enumerated bans on this region kept losing to paraphrase, so the copy IS the contract.
const CLAUDE_INSTALL_REGION = [
  "## Install for Claude Code",
  "",
  CLAUDE_TOKEN_OPENER,
  "",
  "```sh",
  "claude plugin marketplace add https://github.com/ssvlabs/brains-plugins.git",
  "claude plugin install brains@brains",
  CLAUDE_MCP_LOGIN,
  "```",
  "",
  "If Claude Code does not recognise that login name, run `claude mcp list` and use the name it",
  "shows for the brains server.",
  "",
  "`" + CLAUDE_MCP_LOGIN + "` opens your browser to approve the connection. The",
  "approval screen says **An app on this computer** and shows a `127.0.0.1` address whose port",
  "changes every time — that is Claude Code waiting on your machine, and it is expected. Claude",
  "Code stores the credential itself, so there is nothing to copy or keep. Confirm with",
  "`claude mcp list`.",
  "",
  CLAUDE_VERSION_NOTE,
  "",
  "Restart Claude Code or start a new session. The first time the plugin loads, trust the bundled",
  "brains hooks — that is what runs automatic recall and error feedback. Capture and inbox delivery",
  "also need the token below.",
  "",
  "For a local checkout under development:",
  "",
  "```sh",
  "claude plugin marketplace add /absolute/path/to/brains-plugins",
  "claude plugin install brains@brains",
  CLAUDE_MCP_LOGIN,
  "```",
].join("\n");

// The Claude token section and the migration section, heading lines included, pinned for the same
// reason as the Codex one above.
const CLAUDE_OPTIONAL_REGION = [
  "### Optional: conversation capture and the inbox",
  "",
  "The tools above work without this. Capture and the inbox are shell hooks that authenticate",
  "separately from the MCP server and cannot read the credential Claude Code keeps internally, so",
  "they need a brains API token of their own — find it in your brains account settings. Without one",
  "they simply stay off.",
  "",
  "Set it when you install:",
  "",
  "```sh",
  'claude plugin install brains@brains --config token="<your token>"',
  "```",
  "",
  "Or change it afterwards with `/plugin` → brains → Configure.",
  "",
  "This token is only for capture and the inbox. It is **not** how Claude Code authenticates the",
  "brains tools — that is `" + CLAUDE_MCP_LOGIN + "` above.",
].join("\n");
const CLAUDE_MIGRATION_REGION = [
  "### Already installed?",
  "",
  "Plugins added before the sign-in flow carried the token in their MCP declaration and never",
  "logged in. Update, then sign in:",
  "",
  "```sh",
  "claude plugin marketplace update brains",
  "claude plugin update brains",
  CLAUDE_MCP_LOGIN,
  "```",
  "",
  "Then run `/reload-plugins`.",
].join("\n");

// The file inventory and the licence pointer. Neither makes a claim a user acts on, but both are
// pinned anyway so that the composition assert below can cover the WHOLE file: an unpinned region,
// however inert its contents, is somewhere to write a capture promise (one was, in review).
const SHARED_LAYOUT_REGION = [
  "## Shared layout",
  "",
  "- `.agents/plugins/marketplace.json` — Codex marketplace",
  "- `.claude-plugin/marketplace.json` — Claude Code marketplace",
  "- `plugins/brains/.codex-plugin/plugin.json` — Codex manifest",
  "- `plugins/brains/.claude-plugin/plugin.json` — Claude Code manifest",
  "- `plugins/brains/.mcp.json` — Codex MCP declaration",
  "- `plugins/brains/skills/` — shared skills",
  "- `plugins/brains/hooks/` — shared scripts plus client-specific event maps",
].join("\n");
const LICENSE_REGION = ["## License", "", "[GPL-3.0](./LICENSE)"].join("\n");

// The self-hosting section, pinned verbatim. Its claims are load-bearing in exactly the way the
// endpoint config's description is — it names the fallback host by name and says which halves of the
// install the `endpoint` option governs — and the endpoint probes at the bottom of this file prove
// all of that about the CODE while nothing proved the prose still agreed with it. For a self-hoster
// the failure is silent: data going to production, not an error.
const SELF_HOSTING_REGION = [
  "## Self-hosting",
  "",
  "The brains tools connect to `" + CLAUDE_MCP_URL + "`; to point them at your own",
  "server, fork this repo, set the URL in `plugins/brains/.claude-plugin/plugin.json` and",
  "`plugins/brains/.mcp.json`, and add your fork as the marketplace.",
  "",
  "That moves the tools only. Conversation capture and the inbox read the `endpoint` option",
  "instead, so set it when you install or they keep sending to `" + CLAUDE_ENDPOINT + "`:",
  "",
  "```sh",
  "claude plugin install brains@brains --config endpoint=https://your-server",
  "```",
  "",
  "Changing `endpoint`'s `default` in your fork does not cover this. Claude Code exports",
  "`CLAUDE_PLUGIN_OPTION_ENDPOINT` to the hooks from the value stored in your settings, and",
  "an option you never set has no stored value — so the hooks fall back to",
  "`" + CLAUDE_ENDPOINT + "` while your tools talk to your own server.",
  "",
  "Codex has no such option and runs the same hook scripts, so set `BRAINS_ENDPOINT` wherever",
  "you set `BRAINS_API_TOKEN` above — the shell Codex starts from, or the app's launch",
  "environment. Without it Codex capture keeps sending to `" + CLAUDE_ENDPOINT + "` too.",
].join("\n");

// Best-effort canary over the WHOLE README, in the shape of the core.md backstop further down:
// neither sound nor complete, but it catches the canonical regression — capture or the inbox
// presented as unconditional. Every region is pinned now, so its job is no longer to cover unpinned
// prose; it is the backstop for a rewrite that edits a region constant in the same diff, which is
// the one move every verbatim pin in this file is blind to. Kept deliberately weak-but-broad for
// that reason: it caught "Once trusted, every conversation is captured automatically — no token
// needed." while a pin would have been edited around it. It is NOT a substitute for the pins — the
// paraphrase "Conversation capture is built in. It runs by itself for every session." carries
// neither pattern and walked straight past it.
const UNCONDITIONAL_CAPTURE = [
  /captur\w*[^.]{0,60}\bautomatic/i,
  /\bautomatic(ally)?\b[^.]{0,60}captur/i,
  /\b(saves|records|captures)\s+(every|each)\s+(turn|conversation|chat|message)\b/i,
  /\bevery\s+(turn|conversation|chat|message)\b[^.]{0,60}\b(is|are)\s+(captured|recorded|saved)\b/i,
  /(captur\w*|inbox)[^.]{0,80}\b(no token|without a token|nothing to configure|no configuration|always on)\b/i,
  /\b(no token|nothing to configure|always on)\b[^.]{0,80}(captur\w*|inbox)/i,
];

class AssertionError extends Error {}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

async function waitForFile(path: string, timeoutMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return true;
    await Bun.sleep(10);
  }
  return existsSync(path);
}

// Copy pins tolerate re-wrapping: the manifest holds each string on a single JSON line, while the
// constants above are concatenated across source lines to stay readable.
const normalizeCopy = (value: string): string => value.replace(/\s+/g, " ").trim();

// Region pins do NOT tolerate whitespace changes: in Markdown an indented fence opener stops
// opening a fence and two trailing spaces render a hard break, and this repo has no formatter or
// .editorconfig that would ever introduce benign churn. Line endings only.
const normalizeRegion = (value: string): string => value.replace(/\r\n?/g, "\n").replace(/\n+$/, "");

// Key ORDER is not part of a JSON contract; every other difference is. Sorting keys recursively lets
// a shape pin ignore reordering and catch an added, removed or retyped key.
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value, (_key, val) =>
    val !== null && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, (val as any)[k]]))
      : val,
  );

// The named signal ahead of the verbatim description pins: a capture or inbox claim on a fixed
// product surface must carry the hook-driven qualifier, and neither stem may appear outside it.
// This is a SIGNAL, not the guarantee. It reads the RESIDUE — what is left once the approved phrase
// is removed — so it catches the pre-PR copy ("reflexive recall, turn-by-turn capture, a
// server-driven inbox") and a loose stem in any rewording that keeps one, while it is blind to a
// claim that keeps the qualifier and then contradicts it ("…— always on, no token or configuration
// needed…") and to one that avoids both stems ("Every turn is recorded to brains"). Both were
// demonstrated against it in review, which is why every caller pins its copy verbatim as well; this
// says WHICH rule a legitimate edit broke, in one line, before the reader gets a two-string diff.
// The enumerated `server-driven inbox` ban it replaces is folded in — that regex caught exactly that
// one string, and the residue covers it plus every rewording that leaves a stem loose.
// A null qualifier means the surface makes no such claim today and must not start.
function assertCaptureQualified(
  surface: string,
  text: unknown,
  qualifier: string | null,
  alsoAllowed: string[] = [],
): void {
  assert(typeof text === "string" && text !== "", `${surface} must carry a description`);
  const copy = normalizeCopy(text as string);
  if (qualifier !== null) {
    assert(
      copy.includes(qualifier),
      `${surface} must carry the approved qualifier "${qualifier}" — a bare capture or inbox claim is false for every user without a credential, and in every claude.ai chat`,
    );
  }
  let residue = copy;
  for (const approved of [...(qualifier === null ? [] : [qualifier]), ...alsoAllowed]) {
    residue = residue.split(approved).join(" ");
  }
  for (const [claim, pattern] of [["capture", /captur/i], ["the inbox", /\binbox\b/i]] as const) {
    assert(
      !pattern.test(residue),
      `${surface} claims ${claim} outside the approved qualifier — it is hook-driven, credential-gated, and runs in no web chat. Unqualified: ${JSON.stringify(residue)}`,
    );
  }
}

// Every slice boundary in this file resolves through here, at the START OF A LINE. Raw `indexOf`
// takes any occurrence, including one glued mid-line: appending "## Shared layout" with no space to
// the last sentence of the web section ("…confirmation.## Shared layout") moved the boundary onto
// the decoy, left the pinned slice matching exactly, and put every paragraph after it outside all
// regions — while the line-anchored uniqueness count below never saw a second heading.
const headingPattern = (heading: string): RegExp =>
  new RegExp(`^${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gm");
const headingIndex = (scope: string, heading: string): number =>
  headingPattern(heading).exec(scope)?.index ?? -1;

type Fence = { language: string; body: string };

// ONE pass over every fence, because discovery and extraction disagreeing is the bug: the fence
// allow-list lower-cased the language while the extractor did not, so ```Bash was certified as swept
// and then never parsed. Tilde fences and info strings were invisible to both — ```sh title=install
// matched neither the `^```([a-zA-Z0-9_-]+)$` discovery pattern nor the ```sh\n extractor. The lines
// OUTSIDE every fence come back too, so the container-context check further down needs no second scan.
// CommonMark, to the extent this file needs it: an opener is three or more backticks or tildes
// indented at most three spaces, the language is the FIRST word of the info string, and a closer is
// the same character, at least as long, carrying no info string.
function markdownFences(markdown: string): { fences: Fence[]; outside: string[] } {
  const fences: Fence[] = [];
  const outside: string[] = [];
  let open: { marker: string; language: string; body: string[] } | null = null;
  for (const line of markdown.split("\n")) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open) {
      const closes = fence
        && fence[1][0] === open.marker[0]
        && fence[1].length >= open.marker.length
        && fence[2].trim() === "";
      if (closes) {
        fences.push({ language: open.language, body: open.body.map((body) => `${body}\n`).join("") });
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    outside.push(line);
    if (fence) {
      open = { marker: fence[1], language: fence[2].trim().split(/\s+/)[0].toLowerCase(), body: [] };
    }
  }
  assert(open === null, "README has an unclosed code fence — the sweep cannot see inside it");
  return { fences, outside };
}

function hookScripts(config: any): string[] {
  return Object.values(config.hooks ?? {}).flatMap((groups: any) =>
    groups.flatMap((group: any) => group.hooks ?? [])
      .map((hook: any) => hook.command as string),
  );
}

// Deliberately NOT folded into hookScripts(): that helper flattens every event into one command
// list, which is exactly what the callers below want and exactly what loses the event identity this
// check needs. A vacuous `SessionStart: []` contributes nothing to the flattened list and is
// therefore invisible to any assertion built on it — which is how hole 2 survived.
function assertHookEventMap(label: string, config: any, expected: Record<string, HookGroup[]>): void {
  const declared = Object.keys(config.hooks ?? {}).sort();
  const wanted = Object.keys(expected).sort();
  assert(
    JSON.stringify(declared) === JSON.stringify(wanted),
    `${label} hook events must be exactly [${wanted.join(", ")}] — got [${declared.join(", ") || "none"}]. `
      + `Adding or removing one is a two-line edit: this JSON and ${label.toUpperCase()}_HOOK_EVENTS.`,
  );
  for (const [event, groups] of Object.entries(expected)) {
    const declaredGroups = config.hooks[event];
    assert(
      Array.isArray(declaredGroups),
      `${label} ${event} must declare an array of matcher groups — got ${JSON.stringify(declaredGroups)}`,
    );
    assert(
      declaredGroups.length === groups.length,
      `${label} ${event} must declare exactly ${groups.length} matcher group(s) — got ${declaredGroups.length}. `
        + `An empty array satisfies a key-existence check and runs nothing; a second group is a second delivery path, and a duplicate is a doubled one.`,
    );
    groups.forEach((group, index) => {
      const declaredGroup = declaredGroups[index];
      assert(
        declaredGroup !== null && typeof declaredGroup === "object",
        `${label} ${event} group ${index} must be an object — got ${JSON.stringify(declaredGroup)}`,
      );
      if (group.matcher === undefined) {
        assert(
          !("matcher" in declaredGroup),
          `${label} ${event} group ${index} must declare NO matcher — it runs on every ${event}, and both a matcher and an explicit null narrow it`,
        );
      } else {
        assert(
          declaredGroup.matcher === group.matcher,
          `${label} ${event} group ${index} matcher must be exactly "${group.matcher}" — got ${JSON.stringify(declaredGroup.matcher)}. `
            + `Narrowing it drops deliveries silently, and a matcher that matches nothing runs nothing.`,
        );
      }
      const declaredHooks = declaredGroup.hooks;
      assert(
        Array.isArray(declaredHooks),
        `${label} ${event} group ${index} must declare an array of hooks — got ${JSON.stringify(declaredHooks)}`,
      );
      for (const hook of declaredHooks) {
        assert(
          hook !== null && typeof hook === "object" && typeof hook.command === "string",
          `${label} ${event} group ${index} declares a hook with no string command — got ${JSON.stringify(hook)}`,
        );
      }
      const declaredCommands = declaredHooks.map((hook: any) => hook.command as string);
      const wantedCommands = group.hooks.map((hook) => hook.command);
      // Named signal ahead of the two pins below: a mis-mapped event (hole 3) reads as one line here
      // rather than as a two-string diff the reader has to spot for themselves.
      wantedCommands.forEach((command, hookIndex) => {
        const script = command.match(/hooks\/(brains-[a-z-]+\.sh)/)?.[1];
        assert(script, `${label} ${event} expectation names no brains script — fix ${label.toUpperCase()}_HOOK_EVENTS`);
        assert(
          declaredCommands[hookIndex]?.includes(`hooks/${script}`),
          `${label} ${event} must run ${script} — got: ${declaredCommands[hookIndex]}`,
        );
      });
      assert(
        JSON.stringify(declaredCommands) === JSON.stringify(wantedCommands),
        `${label} ${event} group ${index} must run exactly ${JSON.stringify(wantedCommands)} — got ${JSON.stringify(declaredCommands)}`,
      );
    });
    assert(
      canonicalJson(declaredGroups) === canonicalJson(groups),
      `${label} ${event} must declare exactly this shape — a key outside matcher and command changes what runs (type, statusMessage, timeout):\n`
        + `expected ${canonicalJson(groups)}\ngot      ${canonicalJson(declaredGroups)}`,
    );
  }
}

const claudeManifest = readJson(join(PLUGIN, ".claude-plugin", "plugin.json"));
const codexManifest = readJson(join(PLUGIN, ".codex-plugin", "plugin.json"));
const claudeMarketplace = readJson(join(ROOT, ".claude-plugin", "marketplace.json"));
const codexMarketplace = readJson(join(ROOT, ".agents", "plugins", "marketplace.json"));
const claudeHooks = readJson(join(PLUGIN, "hooks", "claude-hooks.json"));
const codexHooks = readJson(join(PLUGIN, "hooks", "hooks.json"));
const codexMcp = readJson(join(PLUGIN, ".mcp.json"));
const claudeManifestSource = readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8");
const claudeHooksSource = readFileSync(join(PLUGIN, "hooks", "claude-hooks.json"), "utf8");
const codexHooksSource = readFileSync(join(PLUGIN, "hooks", "hooks.json"), "utf8");
const turnHook = readFileSync(join(PLUGIN, "hooks", "brains-turn.sh"), "utf8");
const inboxHook = readFileSync(join(PLUGIN, "hooks", "lib", "brains-inbox.sh"), "utf8");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const core = readFileSync(join(PLUGIN, "core.md"), "utf8");
const writeSkill = readFileSync(join(PLUGIN, "skills", "brains-write", "SKILL.md"), "utf8");
const buildSkill = readFileSync(join(PLUGIN, "skills", "brains-build", "SKILL.md"), "utf8");
const boardSkill = readFileSync(join(PLUGIN, "skills", "brains-board", "SKILL.md"), "utf8");
const automationSkill = readFileSync(join(PLUGIN, "skills", "brains-automation", "SKILL.md"), "utf8");
const workflowSkill = readFileSync(join(PLUGIN, "skills", "brains-workflow", "SKILL.md"), "utf8");
const capabilityManifest = readJson(join(PLUGIN, "generated", "capability-catalog.json"));
const coreNormalized = core.replace(/\s+/g, " ");
const writeSkillNormalized = writeSkill.replace(/\s+/g, " ");
const automationSkillNormalized = automationSkill.replace(/\s+/g, " ");

assert(claudeManifest.name === "brains", "Claude manifest name must be brains");
assert(codexManifest.name === "brains", "Codex manifest name must be brains");
assert(claudeManifest.version === codexManifest.version, "client manifests must stay version-aligned");
assert(claudeManifest.hooks === "./hooks/claude-hooks.json", "Claude must select its event map explicitly");
assert(codexManifest.skills === "./skills/", "Codex must use the shared skills directory");
assert(codexManifest.mcpServers === "./.mcp.json", "Codex must load its MCP declaration");
assert(!("hooks" in codexManifest), "Codex should discover the default hooks/hooks.json");

// Capture AND the inbox are hook-driven and credential-gated: brains-turn.sh and
// brains-inbox.sh carry the same `[ -z "$TOKEN" ] && exit 0`, and neither runs in claude.ai chat.
// Both Claude card surfaces said "hook-driven turn-by-turn capture, a server-driven inbox" —
// qualifying only the first half, which left the inbox asserted flat in exactly the two
// configurations where it is off. Nothing pinned any of these descriptions, which is how three of
// them drifted into agreement on the same false claim in the first place.
//
// All four are checked twice: the qualifier signal names which rule broke, then the verbatim pin
// holds the copy. The signal alone is not enough and this was demonstrated, not theorised — a
// description that carries the qualifier and then contradicts it, and one that drops both stems,
// each passed the signal with the meaning reversed. The Codex card is qualified more narrowly
// because it claims less: its longDescription says "hook-driven capture" and its description makes
// no capture or inbox claim at all, so the null arm asserts that it does not start making one.
for (const [surface, description, qualifier, approved] of [
  ["Claude manifest", claudeManifest.description, CAPTURE_QUALIFIER, CLAUDE_MANIFEST_DESCRIPTION],
  ["Claude marketplace", claudeMarketplace.description, null, CLAUDE_MARKETPLACE_BLURB],
  ["Claude marketplace card", claudeMarketplace.plugins[0]?.description, CAPTURE_QUALIFIER, CLAUDE_MARKETPLACE_DESCRIPTION],
  ["Codex manifest", codexManifest.description, null, CODEX_MANIFEST_DESCRIPTION],
  ["Codex manifest interface.longDescription", codexManifest.interface?.longDescription, CODEX_CAPTURE_QUALIFIER, CODEX_LONG_DESCRIPTION],
  ["Codex manifest interface.shortDescription", codexManifest.interface?.shortDescription, null, CODEX_SHORT_DESCRIPTION],
  ["Codex manifest interface.displayName", codexManifest.interface?.displayName, null, CODEX_DISPLAY_NAME],
  ["Codex marketplace interface.displayName", codexMarketplace.interface?.displayName, null, CODEX_DISPLAY_NAME],
] as const) {
  assertCaptureQualified(surface, description, qualifier);
  assert(
    normalizeCopy(description as string) === approved,
    `${surface} description must match the approved copy exactly (the card and its constant at the top of this file must be edited together)`,
  );
}
// The Codex marketplace card carries NO description today. One appearing later would be a fifth
// product surface arriving unpinned — precisely the state the four above were in — so it has to
// arrive with its own constant and its own pin rather than on its own.
assert(
  !("description" in (codexMarketplace.plugins[0] ?? {})),
  "Codex marketplace card must carry no description — a new one is a new product surface and needs its own verbatim pin here",
);
// One plugin per marketplace. Every check that reads `plugins[0]` — the card description above, the
// source and policy checks below — is blind to a second entry, which would ship its own name,
// description and source to the same users.
for (const [label, marketplace] of [
  ["Claude", claudeMarketplace],
  ["Codex", codexMarketplace],
] as const) {
  assert(
    Array.isArray(marketplace.plugins) && marketplace.plugins.length === 1,
    `${label} marketplace must list exactly one plugin — everything here reads plugins[0], so a second entry ships unread (got ${marketplace.plugins?.length ?? "none"})`,
  );
}

// The four published JSON artifacts, pinned WHOLE by canonical JSON. Every assertion above names a
// field somebody thought of; this names the file. `interface.shortDescription` is why: it was in
// neither the copy inventory nor any allow-list, so setting it to "Automatic capture, no setup"
// reached the Codex card with all four gates green. Field-by-field inventories only ever cover the
// fields already known — the same argument that made CORE_BODY the whole file and the README the
// composition of its regions. A key added to any of these now fails here rather than shipping
// unread, and the named assertions above stay ahead to say WHICH rule broke.
//
// `version` is read from the file rather than pinned: bumping it is the delivery guard's business,
// and the two manifests' agreement is already asserted at the top of this file. Everything else —
// author, homepage, keywords, capabilities, defaultPrompt, brandColor, the endpoint config's title,
// the marketplace schema and owner — is copy or contract that reaches a user and nothing else read.
const CLAUDE_MANIFEST = {
  name: "brains",
  description: CLAUDE_MANIFEST_DESCRIPTION,
  version: claudeManifest.version,
  author: { name: "brains (ssvlabs)" },
  homepage: "https://mybrains.ai",
  hooks: "./hooks/claude-hooks.json",
  userConfig: {
    token: {
      type: "string",
      title: CLAUDE_TOKEN_TITLE,
      description: CLAUDE_TOKEN_DESCRIPTION,
      sensitive: true,
      required: false,
    },
    endpoint: {
      type: "string",
      title: "brains endpoint",
      description: CLAUDE_ENDPOINT_DESCRIPTION,
      default: CLAUDE_ENDPOINT,
    },
  },
  mcpServers: { brains: { type: "http", url: CLAUDE_MCP_URL } },
};
const CODEX_MANIFEST = {
  name: "brains",
  version: codexManifest.version,
  description: CODEX_MANIFEST_DESCRIPTION,
  author: { name: "brains (ssvlabs)", url: "https://mybrains.ai" },
  homepage: "https://mybrains.ai",
  repository: "https://github.com/ssvlabs/brains-plugins",
  license: "GPL-3.0",
  keywords: ["memory", "productivity", "gmail", "calendar", "drive", "automation"],
  skills: "./skills/",
  mcpServers: "./.mcp.json",
  interface: {
    displayName: CODEX_DISPLAY_NAME,
    shortDescription: CODEX_SHORT_DESCRIPTION,
    longDescription: CODEX_LONG_DESCRIPTION,
    developerName: "ssvlabs",
    category: "Productivity",
    capabilities: ["Read", "Write", "Automate"],
    websiteURL: "https://mybrains.ai",
    defaultPrompt: [
      "What should I know about today?",
      "Find what I discussed about this project.",
      "Help me build a tracker from my memory.",
    ],
    brandColor: "#6D5EF5",
  },
};
const CLAUDE_MARKETPLACE = {
  $schema: "https://anthropic.com/claude-code/marketplace.schema.json",
  name: "brains",
  description: CLAUDE_MARKETPLACE_BLURB,
  owner: { name: "ssvlabs" },
  plugins: [
    {
      name: "brains",
      description: CLAUDE_MARKETPLACE_DESCRIPTION,
      source: "./plugins/brains",
      category: "productivity",
    },
  ],
};
const CODEX_MARKETPLACE = {
  name: "brains",
  interface: { displayName: CODEX_DISPLAY_NAME },
  plugins: [
    {
      name: "brains",
      source: { source: "local", path: "./plugins/brains" },
      policy: { installation: "AVAILABLE", authentication: "ON_USE" },
      category: "Productivity",
    },
  ],
};
for (const [artifact, declared, approved] of [
  [".claude-plugin/plugin.json", claudeManifest, CLAUDE_MANIFEST],
  [".codex-plugin/plugin.json", codexManifest, CODEX_MANIFEST],
  [".claude-plugin/marketplace.json", claudeMarketplace, CLAUDE_MARKETPLACE],
  [".agents/plugins/marketplace.json", codexMarketplace, CODEX_MARKETPLACE],
] as const) {
  assert(
    canonicalJson(declared) === canonicalJson(approved),
    `${artifact} must match the approved artifact exactly — every field in it is published, so a new or edited one is a new claim:\n`
      + `expected ${canonicalJson(approved)}\ngot      ${canonicalJson(declared)}`,
  );
}

assert(claudeMarketplace.plugins[0]?.source === "./plugins/brains", "Claude marketplace source mismatch");
assert(codexMarketplace.plugins[0]?.source?.path === "./plugins/brains", "Codex marketplace source mismatch");
assert(codexMarketplace.plugins[0]?.policy?.installation === "AVAILABLE", "Codex install policy missing");
// Codex authenticates the MCP server on first use (`codex mcp login brains`), not during
// `plugin add` — its plugin manifest has no field that could carry a credential at install time.
//
// Do NOT flip this back to ON_INSTALL on the observation that the desktop app kicks off a login
// during install: it does (its app-server install handlers start an OAuth login per declared
// server), but the install COMPLETES either way and the CLI performs no login at all, so ON_INSTALL
// would misdescribe the contract this repo documents. The startup auto-update path does not do it,
// which is why a plugin already installed stays logged out until someone runs the login.
assert(codexMarketplace.plugins[0]?.policy?.authentication === "ON_USE", "Codex auth policy must be ON_USE");

const claudeEvents = Object.keys(claudeHooks.hooks).sort();
const codexEvents = Object.keys(codexHooks.hooks).sort();
assertHookEventMap("Claude", claudeHooks, CLAUDE_HOOK_EVENTS);
assertHookEventMap("Codex", codexHooks, CODEX_HOOK_EVENTS);
// One key, one map. The event map is checked key by key above; nothing looked at the object around
// it, so a stray root key would ship unread — the same class the artifact pins below close.
for (const [label, config] of [["Claude", claudeHooks], ["Codex", codexHooks]] as const) {
  assert(
    JSON.stringify(Object.keys(config)) === JSON.stringify(["hooks"]),
    `${label} hooks file may only contain hooks — got ${Object.keys(config).join(", ")}`,
  );
}
// JSON.parse keeps the LAST duplicate key, so the parsed view above is blind to a first
// "SessionStart" block that a later clean one shadows — and to a second root "hooks" object, whose
// shadowed events would still be counted here. Count the declarations in the source, the way the
// Claude manifest's mcpServers is counted below.
for (const [label, source, expected] of [
  ["Claude", claudeHooksSource, CLAUDE_HOOK_EVENTS],
  ["Codex", codexHooksSource, CODEX_HOOK_EVENTS],
] as const) {
  for (const event of Object.keys(expected)) {
    const declarations = (source.match(new RegExp(`"${event}"\\s*:`, "g")) ?? []).length;
    assert(
      declarations === 1,
      `${label} hooks source must declare "${event}" exactly once — JSON.parse keeps the last duplicate, so a shadowed first copy is invisible to every check above (found ${declarations})`,
    );
  }
}
// Kept, and deliberately redundant with the exact-set check above: these two absences are a
// CAPABILITY fact — Codex supports neither event — not a gap waiting to be filled. The set check
// would reject adding them but would report it as a set mismatch; these say why.
assert(!codexEvents.includes("PostToolUseFailure"), "Codex does not support PostToolUseFailure");
assert(!codexEvents.includes("SessionEnd"), "Codex does not support SessionEnd");

for (const command of [...hookScripts(claudeHooks), ...hookScripts(codexHooks)]) {
  const match = command.match(/hooks\/(brains-[a-z-]+\.sh)/);
  assert(match, `hook command does not point at a brains script: ${command}`);
  const script = join(PLUGIN, "hooks", match[1]);
  assert(existsSync(script), `missing hook script ${match[1]}`);
  assert((statSync(script).mode & 0o111) !== 0, `hook script is not executable: ${match[1]}`);
}

// Claude Code auto-loads hooks/hooks.json IN ADDITION to the manifest's hooks
// file, so every Codex command must no-op when the plugin scripts don't resolve
// under ${PLUGIN_ROOT} (unset in the Claude runtime).
for (const command of hookScripts(codexHooks)) {
  assert(
    /^\[ -x "\$\{PLUGIN_ROOT\}\/hooks\/brains-[a-z-]+\.sh" \] \|\| exit 0; /.test(command),
    `Codex hook command must guard against the Claude runtime: ${command}`,
  );
}

// One file, one key, one server. The per-key allow-list below guards what the `brains` entry may
// declare; these two guard the file around it, so a second server — including a stdio `command`
// server, which Codex would launch on the user's machine — cannot ride along unnoticed.
assert(
  JSON.stringify(Object.keys(codexMcp)) === JSON.stringify(["mcpServers"]),
  `Codex MCP file may only contain mcpServers — got ${Object.keys(codexMcp).join(", ")}`,
);
assert(
  JSON.stringify(Object.keys(codexMcp.mcpServers ?? {})) === JSON.stringify(["brains"]),
  `Codex MCP file may only declare the brains server — got ${Object.keys(codexMcp.mcpServers ?? {}).join(", ")}`,
);

assert(codexMcp.mcpServers?.brains?.type === "http", "Codex brains MCP must be HTTP");
assert(codexMcp.mcpServers?.brains?.url === "https://mcp.mybrains.ai/mcp", "Codex brains MCP URL mismatch");

// Codex owns the MCP credential via its own OAuth login. `bearer_token_env_var` must stay ABSENT:
// the plugin ships nothing that sets the variable, and neither state helps. Unset, Codex silently
// drops the server at session start rather than falling back to the stored credential, so even a
// successful `codex mcp login` leaves it unusable. Where a shell exports the variable, that bearer
// is what Codex sends at request time, shadowing the stored credential.
assert(
  !("bearer_token_env_var" in (codexMcp.mcpServers?.brains ?? {})),
  "Codex brains MCP must not declare bearer_token_env_var — unset, Codex drops the server; set, it shadows the OAuth credential",
);
// The scope set requested at login. Baked rather than discovered: with no `scopes` key Codex asks
// for every scope the server advertises, which would mint an admin-carrying token for every user.
assert(
  JSON.stringify(codexMcp.mcpServers?.brains?.scopes) === JSON.stringify(CODEX_MCP_SCOPES),
  `Codex brains MCP scopes must be ${JSON.stringify(CODEX_MCP_SCOPES)}`,
);
assert(
  JSON.stringify(Object.keys(codexMcp.mcpServers?.brains ?? {}).sort())
    === JSON.stringify([...CODEX_MCP_KEYS].sort()),
  `Codex brains MCP may only declare ${CODEX_MCP_KEYS.join(", ")} — got ${Object.keys(codexMcp.mcpServers?.brains ?? {}).join(", ")}`,
);

// Claude Code owns the MCP credential via its own OAuth login, exactly as Codex does. `headers`
// must stay ABSENT: a declared Authorization header disables the OAuth path outright — the CLI
// refuses the login with "authenticates with the `Authorization` header in its configuration, so
// there's no separate login" — so declaring one would make signing in impossible rather than
// merely redundant.
assert(
  !("headers" in (claudeManifest.mcpServers?.brains ?? {})),
  "Claude brains MCP must not declare headers — an Authorization header disables the OAuth login path",
);

// One server, declared inline. The per-key allow-list below guards the `brains` entry; these
// guard the map around it, so a second server cannot ride along unnoticed.
assert(
  typeof claudeManifest.mcpServers === "object" && claudeManifest.mcpServers !== null,
  "Claude manifest must declare mcpServers inline",
);
assert(
  JSON.stringify(Object.keys(claudeManifest.mcpServers)) === JSON.stringify(["brains"]),
  `Claude manifest may only declare the brains server — got ${Object.keys(claudeManifest.mcpServers).join(", ")}`,
);
// JSON.parse keeps the LAST duplicate root key, so the parsed view above is blind to a second
// `mcpServers` block whose final copy happens to be clean. Count the declarations in the source.
assert(
  (claudeManifestSource.match(/"mcpServers"\s*:/g) ?? []).length === 1,
  "Claude manifest source must declare mcpServers exactly once",
);
assert(claudeManifest.mcpServers.brains.type === "http", "Claude brains MCP must be HTTP");
// A LITERAL, never a `${user_config.*}` template. claude.ai reads this declaration to prefill its
// "Add custom connector" dialog, and that surface resolves no user config: a template arrives in
// the URL field verbatim, fails the field's own `https` validation, and the field then rejects
// every edit the user tries — so the connector cannot be added at all. The declared default is no
// help either; nothing substitutes it there. The cost is deliberate and lives in the endpoint copy
// below: this URL no longer follows `userConfig.endpoint`.
assert(
  claudeManifest.mcpServers.brains.url === CLAUDE_MCP_URL,
  `Claude brains MCP URL must be ${CLAUDE_MCP_URL}`,
);
// Shape check independent of the constant above, so editing both in tandem still cannot reintroduce
// a template or a non-https scheme.
assert(
  claudeManifest.mcpServers.brains.url.startsWith("https://")
    && !claudeManifest.mcpServers.brains.url.includes("${"),
  "Claude brains MCP URL must be a literal https URL — claude.ai cannot resolve a template",
);
// Both clients must reach the same server. Scoped claim: this makes the resolved URL invariant
// under the inline-vs-.mcp.json merge (Claude Code 2.1.221 merges the two and prefers the inline
// entry on a key collision), so it no longer matters which source a given client picks. It is NOT a
// guarantee about effective grants — the two entries still differ, `.mcp.json` carrying `scopes`
// and this one not.
assert(
  claudeManifest.mcpServers.brains.url === codexMcp.mcpServers.brains.url,
  `Claude and Codex must declare the same brains MCP URL — got ${claudeManifest.mcpServers.brains.url} and ${codexMcp.mcpServers.brains.url}`,
);
// A stray key INSIDE the server entry passes `claude plugin validate --strict` in total silence —
// only unknown TOP-LEVEL fields warn — so a `scopes` key copied in good faith from the Codex
// declaration next door would look accepted and do nothing. Measured against a local OAuth stub on
// Claude Code 2.1.221: a `scopes` key here is ignored, and so is `.mcp.json`'s — Claude Code asks
// for whatever the server's metadata advertises. Production advertises read and write today, which
// is what the Codex declaration next door asks for, so the key is inert rather than harmful. This
// allow-list is the only check that catches it.
assert(
  JSON.stringify(Object.keys(claudeManifest.mcpServers.brains).sort())
    === JSON.stringify([...CLAUDE_MCP_KEYS].sort()),
  `Claude brains MCP may only declare ${CLAUDE_MCP_KEYS.join(", ")} — got ${Object.keys(claudeManifest.mcpServers.brains).join(", ")}`,
);

// The MCP URL above no longer interpolates this, but conversation capture and the inbox still do —
// they build /ingest/claude and /inbox/claude from it in shell, off CLAUDE_PLUGIN_OPTION_ENDPOINT.
// So the default still has to be present and still has to be production, or a user who never
// configures anything gets capture pointed at nothing. The hook-level proof is at the bottom of this
// file; these two only pin the declaration.
const claudeEndpointConfig = claudeManifest.userConfig?.endpoint ?? {};
assert(
  typeof claudeEndpointConfig.default === "string" && claudeEndpointConfig.default !== "",
  "Claude endpoint config must keep a non-empty default — capture and the inbox derive their URLs from it",
);
assert(
  claudeEndpointConfig.default === CLAUDE_ENDPOINT,
  `Claude endpoint default must be ${CLAUDE_ENDPOINT}`,
);
// The copy has to keep matching what the field actually does. It claimed /mcp derived from the
// endpoint for as long as that was true and would have kept claiming it afterwards.
assert(
  normalizeCopy(claudeEndpointConfig.description ?? "") === CLAUDE_ENDPOINT_DESCRIPTION,
  "Claude endpoint description must match the approved wording exactly",
);
// Narrower backstop for a rewrite that edits the constant above too: the one claim that must never
// come back is that the MCP URL derives from this setting.
assert(
  !/\/mcp\b[^.]{0,40}\bfrom it\b/i.test(claudeEndpointConfig.description ?? ""),
  "Claude endpoint description must not claim /mcp derives from the endpoint — it does not",
);

// Conversation capture and the inbox are OPT-IN now that they are the token's only job. This must
// stay optional for a reason that is invisible from the file: a `required: true` user config left
// unset makes Claude Code DROP the server silently — the install succeeds with a warning and
// `claude mcp list` shows nothing at all, so the tools vanish rather than prompt.
assert("token" in (claudeManifest.userConfig ?? {}), "Claude manifest must keep the token config");
const claudeTokenConfig = claudeManifest.userConfig.token;
assert(claudeTokenConfig.required === false, "Claude token config must be optional (required: false)");
assert(
  /optional/i.test(claudeTokenConfig.title),
  "Claude token title must present the token as optional",
);
for (const signal of ["capture", "inbox", CLAUDE_MCP_LOGIN]) {
  assert(
    claudeTokenConfig.description.includes(signal),
    `Claude token description must name ${signal} — it says what the token is for and where MCP auth actually happens`,
  );
}
assert(
  normalizeCopy(claudeTokenConfig.title) === CLAUDE_TOKEN_TITLE,
  "Claude token title must match the approved wording exactly",
);
assert(
  normalizeCopy(claudeTokenConfig.description) === CLAUDE_TOKEN_DESCRIPTION,
  "Claude token description must match the approved wording exactly",
);
// Best-effort backstop for a rewrite that edits the constants above too. These patterns are
// neither sound nor complete — they cannot see "mandatory for brains tools", and they would
// misfire on some compliant prose — but they do catch the canonical regression of presenting the
// token as how the tools authenticate.
for (const pattern of [
  /requir\w*[\s\S]{0,80}?\b(tools?|mcp)\b/i,
  /\b(tools?|mcp)\b[\s\S]{0,40}?\brequir/i,
]) {
  assert(
    !pattern.test(`${claudeTokenConfig.title} ${claudeTokenConfig.description}`),
    "Claude token copy must not describe the token as required for the tools or MCP — that is `claude mcp login`",
  );
}

// The Claude drift nudge is read aloud to a user mid-session. A plugin from the header era is
// registered but logged out, so updating without signing in leaves the tools unreachable — the
// nudge has to carry the login, with its name argument.
const claudeNudge = inboxHook
  .split("\n")
  .find((line) => line.includes("brains:update") && line.includes("claude plugin update brains"));
assert(claudeNudge, "inbox engine must keep a Claude drift nudge");
assert(
  claudeNudge.includes(CLAUDE_MCP_LOGIN),
  "Claude drift nudge must include the sign-in step — updating alone leaves the user logged out",
);

// Ask a real Codex what it made of the declaration, rather than trusting that the file we wrote is
// the config Codex resolved. This is what catches an upstream change that stops honouring the
// plugin MCP shape: the keys above could all be correct and the server still fail to resolve, or
// resolve onto the bearer path. Skipped with a visible note when Codex is not installed.
const codexOnPath = spawnSync("codex", ["--version"], { encoding: "utf8" }).status === 0;
if (!codexOnPath) {
  console.log("plugin contract: SKIP resolved-config check (codex not on PATH)");
} else {
  const home = mkdtempSync(join(tmpdir(), "brains-plugin-contract-codex-"));
  try {
    const codex = (args: string[]) =>
      spawnSync("codex", args, { encoding: "utf8", env: { ...process.env, CODEX_HOME: home } });
    const added = codex(["plugin", "marketplace", "add", ROOT]);
    assert(added.status === 0, `codex plugin marketplace add failed: ${added.stderr}`);
    const installed = codex(["plugin", "add", "brains@brains"]);
    assert(installed.status === 0, `codex plugin add failed: ${installed.stderr}`);

    const listed = codex(["mcp", "list", "--json"]);
    assert(listed.status === 0, `codex mcp list --json failed: ${listed.stderr}`);
    const servers = JSON.parse(listed.stdout);
    // Assert the whole resolved set, not just that ours is in it — selecting `brains` out of a
    // longer list would hide a sibling the plugin had quietly introduced.
    assert(
      JSON.stringify(servers.map((s: any) => s.name)) === JSON.stringify(["brains"]),
      `codex must resolve exactly one server named brains — got ${servers.map((s: any) => s.name).join(", ") || "none"}`,
    );
    const resolved = servers[0];
    assert(resolved.enabled === true, "resolved brains MCP server must be enabled");
    assert(
      resolved.transport?.type === "streamable_http",
      `resolved transport must be streamable_http, got ${resolved.transport?.type}`,
    );
    assert(
      resolved.transport?.url === codexMcp.mcpServers.brains.url,
      "resolved transport URL must match the declaration",
    );
    assert(
      resolved.transport?.bearer_token_env_var === null,
      "resolved transport must carry no bearer token env var",
    );
    // Not logged in yet, and Codex says so rather than claiming a credential it does not have —
    // which is the whole point of dropping the bearer declaration.
    assert(
      resolved.auth_status === "not_logged_in",
      `resolved auth status must be not_logged_in, got ${resolved.auth_status}`,
    );
    console.log("plugin contract: resolved-config check OK (codex resolved the plugin declaration)");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

// Ask a real Claude Code what it makes of the manifest. `--strict` is what turns an unknown
// TOP-LEVEL field from a warning into a non-zero exit; a stray key inside the server entry stays
// silent even here, which is why the allow-list above exists.
//
// Unlike the Codex mirror this FAILS CLOSED in CI. The workflow installs a pinned
// @anthropic-ai/claude-code, so a missing or non-executing CLI there means the install broke —
// not that validation is unavailable — and skipping would make the job green having validated
// nothing. A visible skip is for local runs only.
const inCI = !["", "0", "false"].includes((process.env.CI ?? "").toLowerCase());
const claudeOnPath = spawnSync("claude", ["--version"], { encoding: "utf8" }).status === 0;
if (!claudeOnPath) {
  assert(!inCI, "claude must be on PATH in CI — the manifest validation cannot be skipped");
  console.log("plugin contract: SKIP claude plugin validate (claude not on PATH)");
} else {
  const claudeHome = mkdtempSync(join(tmpdir(), "brains-plugin-contract-claude-"));
  try {
    const validated = spawnSync("claude", ["plugin", "validate", "--strict", PLUGIN], {
      encoding: "utf8",
      env: { ...process.env, HOME: claudeHome, CLAUDE_CONFIG_DIR: join(claudeHome, "config") },
    });
    const validateOutput = `${validated.stdout ?? ""}${validated.stderr ?? ""}`;
    assert(validated.status === 0, `claude plugin validate --strict failed:\n${validateOutput}`);
    // Belt and braces: if a future CLI drops or renames --strict, a warning could ride along on a
    // zero exit. Reject any warning text regardless of the exit code.
    assert(
      !/⚠|warning/i.test(validateOutput),
      `claude plugin validate reported a warning:\n${validateOutput}`,
    );
    console.log("plugin contract: claude plugin validate --strict OK");
  } finally {
    rmSync(claudeHome, { recursive: true, force: true });
  }
}

assert(core.includes("<!-- brains:core:start v=6 -->"), "core marker must be v6");
for (const signal of [
  "Query brains reflexively",
  "list_calendar_events",
  "calendar page update time is not event time",
  "`search` for exact terms",
  "`query` for conceptual requests",
  "`get_page` only after",
  "fetch_from_integration",
  "report a plain miss",
  "Chain dependent reads; don't fan them out",
  "never invent slugs or IDs",
  "The skills carry the detail",
  "note the error and what you were doing",
  "Do not attach it to unrelated later feedback",
  "Once per session, when natural, mention `brains-feedback`",
  // The capture rule must stay conditional on BOTH axes. Nothing pinned it before, which is
  // how "Capture is automatic … You do not need to call save_chat_session" survived here
  // while being false in two shipped configurations at once:
  //   1. no hooks at all — claude.ai web, on either install path;
  //   2. hooks present but capture unconfigured — brains-turn.sh:43 exits early with no token,
  //      and that token is `required: false`. brains-start.sh:27 cats core.md with NO token
  //      check, so precisely those users are the ones who read the claim.
  // Both axes get a signal: a rewrite dropping either one re-promises capture to a real user
  // who is not getting it.
  "only where a capture credential resolves",
  "never promise capture and never deny it",
  "where the hooks don't run",
  // And the prohibition must stay NARROW. A blanket "do not call save_chat_session" suppressed
  // the tool even when the user asked for it outright — on claude.ai that ask is the one path
  // measured to work reliably.
  "do call it when asked",
]) {
  assert(coreNormalized.includes(signal), `compact core is missing routing/delegation signal: ${signal}`);
}
// The strong guarantee: the capture paragraph, VERBATIM.
//
// The keyword signals above are not sufficient and this was demonstrated, not theorised. This
// paragraph keeps all of them, dodges every literal the old backstop banned, and passed the suite:
//
//   **Capture.** Capture happens automatically for you in Codex and Claude Code —
//   the ingest hook saves each turn (only when the user configured capture, which is
//   the default, so you can assume it is on). Don't call `save_chat_session` there; …
//
// That is the exact false promise this contract exists to delete, restored and green — on the one
// surface a model EXECUTES rather than reads, where a regression is silent capture loss for a real
// user. Verbatim pinning costs nothing here: editing core.md is already a deliberate act because it
// forces the `v=` marker bump and both suites' marker assertions.
const CORE_CAPTURE_REGION = [
  "**Capture.** In Codex and Claude Code the ingest hook saves each turn, but only",
  "where a capture credential resolves — so never promise capture and never deny",
  "it; `list_pages type=chat_session` is the only way to know. Don't call",
  "`save_chat_session` routinely there; do call it when asked, and where the hooks",
  "don't run (claude.ai web) it is the only path.",
].join("\n");
// And the WHOLE injected body, verbatim, with the capture paragraph above composed into it rather
// than pinned twice. brains-start.sh cats this file — all of it, not the capture paragraph — into
// the model's context, so every unpinned line was somewhere to put back the promise the rest of this
// PR deletes, and three ways of doing that were executed against the paragraph-only pin: appending
// "**Capture, in practice.** Treat the ingest hook as reliable: it records each turn for you, so
// there is no need to ask for a save." after the skills pointer; planting a decoy "**The skills
// carry the detail**" that closed the pinned slice early; and reversing an unpinned line ("Treat it
// as a first-class source of truth") with the v= marker left alone. The first stayed under the
// 3,000-character budget at 2,893, so nothing else caught it either.
//
// Pinned as the whole FILE rather than the marker-delimited slice, because `cat` does not read the
// markers: text above the start marker or below the end marker is injected just the same. The marker
// line is inside the pin, so the v= bump both suites assert stays part of the same edit.
const CORE_BODY = [
  "<!-- brains:core:start v=6 -->",
  "# brains — your memory layer",
  "",
  "You have a memory layer called **brains** (the `brains` MCP server). It holds the",
  "user's Gmail, Calendar, Drive, and prior AI conversations as queryable pages.",
  "Treat it as a first-class source of truth about the user's life and work.",
  "",
  "**Query brains reflexively.** If a request depends on a person, project,",
  "meeting, email, document, prior discussion, or \"what did I see,\" look in brains",
  "before guessing, asking the user, web search, browser fetches, or raw Google",
  "connectors. Skip it for pure current-repository code, general knowledge,",
  "explicit memory opt-out, or when brains is unavailable.",
  "",
  "**Use the cheapest useful read.** Cache `whoami` and `list_integrations` once",
  "per session. Use `list_pages` for recents, `search` for exact terms, `query` for",
  "conceptual requests, and `get_page` only after a result supplies a slug. If",
  "expected Gmail, Calendar, or Drive data is missing, use",
  "`fetch_from_integration`, then repeat the read and report a plain miss rather",
  "than inventing a result. Chain dependent reads; don't fan them out.",
  "",
  "For schedules and agendas, use `list_calendar_events start=… end=…`; calendar",
  "page update time is not event time. Name the source page's `title` and `type`,",
  "and never invent slugs or IDs.",
  "",
  CORE_CAPTURE_REGION,
  "",
  "**The skills carry the detail** — load the one that fits the moment:",
  "`brains-read` (querying memory), `brains-write` (sending/creating via",
  "integrations), `brains-agenda` (schedule/plan shape), `brains-build`",
  "(boards/automations/workflows), `brains-integrations` (install/upgrade),",
  "`brains-nudges` (when to suggest a feature), and `brains-feedback` (reporting a",
  "brains bug / giving feedback). Don't reproduce them here — open the skill.",
  "",
  "On a non-transient brains tool error or user frustration with brains, note the",
  "error and what you were doing, then offer one quiet trailing line to report it,",
  "at most once per distinct error. Do not attach it to unrelated later feedback.",
  "Once per session, when natural, mention `brains-feedback`; load the skill before",
  "filing because it owns the procedure and redaction rules.",
  "",
  "**Custom layer.** Your operator may ship a personal layer (voice, profile pages,",
  "daily-loop overrides). The session-start hook injects it (`.codex/USER.md` or",
  "`.claude/USER.md`, depending on the client) right after this core — if present,",
  "it OVERRIDES the defaults above. Adopt it.",
  "<!-- brains:core:end -->",
].join("\n");
const coreCaptureStart = core.indexOf("**Capture.**");
const coreCaptureEnd = core.indexOf("**The skills carry the detail**");
assert(coreCaptureStart > 0, "core must keep its capture paragraph");
assert(
  coreCaptureEnd > coreCaptureStart,
  "core's capture paragraph must precede the skills pointer — the slice below depends on it",
);
assert(
  normalizeRegion(core.slice(coreCaptureStart, coreCaptureEnd)) === CORE_CAPTURE_REGION,
  "core's capture paragraph must match the approved wording exactly (core.md and CORE_CAPTURE_REGION must be edited together, and core.md's v= marker bumped)",
);
assert(
  normalizeRegion(core) === CORE_BODY,
  "core.md must match the approved body exactly — brains-start.sh cats the WHOLE file into the model's context, so every line of it is a published promise (core.md and CORE_BODY must be edited together, and core.md's v= marker bumped)",
);
// Belt and braces for a rewrite that edits the constant above too. Broader than the literals it
// replaces: "Capture happens automatically" walked straight past a `capture is automatic` ban.
assert(
  !/captur\w*[^.]{0,40}automatic|saves every turn\b|assume it is on/i.test(core),
  "core must not promise capture unconditionally — it needs the hooks AND a credential that resolves",
);
assert(core.length < 3_000, "always-loaded core must stay below 3,000 characters");

// The public face is generated from the monorepo capability catalog. Verify its
// immutable artifact digest locally; installation never fetches a mutable copy.
assert(capabilityManifest.schema_version === 2, "capability manifest schema mismatch");
assert(capabilityManifest.catalog_schema_version === 1, "catalog schema mismatch");
assert(capabilityManifest.renderer_version === 3, "catalog renderer mismatch");

// Provenance: the monorepo stamps the commit that rendered these bytes onto the
// PUBLISHED manifest only (its in-repo twin omits it, so its own --check stays
// stable). We can't verify the commit exists — that repo is private — but we can
// refuse a malformed or absent claim, which is what makes the value reviewable.
assert(
  typeof capabilityManifest.source_commit === "string" &&
    /^[0-9a-f]{40}$/.test(capabilityManifest.source_commit),
  "published manifest must carry a 40-hex source_commit",
);
assert(
  capabilityManifest.source_repository === "https://github.com/ssvlabs/brains",
  "source repository mismatch",
);

// Multi-artifact loop. Every published artifact is digest-pinned and carries the
// generated header, so a lone hand edit cannot merge. This walks the manifest
// rather than pinning one entry, so a third artifact is covered the day it lands.
const LOCAL_ARTIFACT: Record<string, string> = {
  "plugins/brains/skills/brains-write/SKILL.md": writeSkill,
  "plugins/brains/skills/brains-build/SKILL.md": buildSkill,
  "plugins/brains/skills/brains-board/SKILL.md": boardSkill,
  "plugins/brains/skills/brains-automation/SKILL.md": automationSkill,
  "plugins/brains/skills/brains-workflow/SKILL.md": workflowSkill,
};
assert(Array.isArray(capabilityManifest.artifacts), "manifest must carry an artifacts array");
assert(
  capabilityManifest.artifacts.map((a: any) => a.capability_id).sort().join(",") ===
    "brains-features,integration-actions,procedure:automation,procedure:board,procedure:workflow",
  "published capability set mismatch",
);
for (const entry of capabilityManifest.artifacts) {
  const body = LOCAL_ARTIFACT[entry.artifact_path];
  assert(body !== undefined, `manifest names an unknown artifact: ${entry.artifact_path}`);
  assert(
    entry.artifact_sha256 === createHash("sha256").update(body!, "utf8").digest("hex"),
    `generated artifact digest mismatch: ${entry.artifact_path}`,
  );
  assert(/^[0-9a-f]{64}$/.test(entry.catalog_sha256), `catalog digest malformed: ${entry.artifact_path}`);
  assert(
    body!.includes("Do not hand-edit"),
    `generated artifact is missing its do-not-hand-edit header: ${entry.artifact_path}`,
  );
  // Internal CODE identifiers, which a published skill can never have a reason to
  // name: a cross-tenant DB pool, a board-form-queries column, an import-grants
  // column. None appears in any published artifact today, which is what makes the
  // denylist shape work here.
  //
  // `automation_secret` and `telegram_push` used to be on this list and were
  // REMOVED, deliberately. They are registered MCP tools —
  // apps/mcp/src/tools/automation.ts (automation_secret_list / _get / _set) and
  // apps/mcp/src/tools/telegram-push.ts — so the list was conflating internal
  // identifiers with user-facing tool names, and naming tools is precisely a
  // public skill's job. The ban was invisible only because the sole published
  // artifacts predated the automation authoring skill; the moment that skill
  // shipped, the ban failed a CORRECT artifact and would have been "fixed" by
  // stripping its secret-hygiene guidance. Do not re-add either name. What those
  // two were reaching for is asserted positively instead, below.
  assert(
    !/adminPool|handler_source|grant_token/.test(body!),
    `public skill leaked an internal-only capability: ${entry.artifact_path}`,
  );
}

// Eager skill-metadata budget (skills authoring & discovery contract §3): the
// CLI hosts preload EVERY installed skill's name + description for routing, so
// skill count is a budget, not a detail. Two decisions live behind this pin, and
// both are still in force:
//
//   1. Education was deliberately rendered INTO brains-build rather than added as
//      its own skill. Unchanged — brains-build is still one skill carrying the
//      whole feature inventory.
//   2. The three authoring procedures ARE separate skills. That is the *_flow
//      playbook migration: a procedure the model must follow turn-by-turn has to
//      be routable on its own trigger vocabulary, which is exactly what an eager
//      description buys. Folding them into brains-build would have made one
//      description claim both "what can brains do" and every build phrase — the
//      routing collision the disjointness check below exists to forbid.
//
// So the budget rule was not abandoned when this went from seven names to ten; it
// was spent, deliberately, on the three procedures. The pin's purpose is that a
// future addition is a reviewed act and not a silent one, and it did its job here:
// this list changing is what forced that review.
const skillDirs = readdirSync(join(PLUGIN, "skills"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
assert(
  skillDirs.join(",") ===
    "brains-agenda,brains-automation,brains-board,brains-build,brains-feedback," +
      "brains-integrations,brains-nudges,brains-read,brains-workflow,brains-write",
  `skill set changed (${skillDirs.join(", ")}) — see the eager-budget rule before adding one`,
);

// Cross-skill trigger disjointness (§1: triggers must be mutually distinct).
// This lives HERE and not in the monorepo generator on purpose: the sibling
// SKILL.md bodies exist only in this repo, so an assertion there would have no
// inputs and pass forever.
//
// It used to sample three phrases from brains-build's description and require no
// sibling to claim them. That inverted when the procedures became skills:
// brains-build no longer advertises build vocabulary at all, it DISCLAIMS it
// ("Yields to brains-board / brains-automation / brains-workflow"), so the old
// check would fail in both directions at once — brains-build missing the phrases
// it no longer wants, and brains-board/-automation legitimately owning them.
//
// The property that actually matters is ownership: each phrase routes to exactly
// one skill. So pin an owner per phrase and sweep every other description,
// brains-build INCLUDED — pinning the yield is the point, since re-claiming a
// build phrase there is the specific regression the recut exists to prevent.
// Phrases are the authored `triggers` arrays in the monorepo's
// packages/capability-catalog/procedure-catalog.ts. brains-build's are NOT from a
// triggers array: they are the literal inventory phrases in
// render-features.ts:renderSkillDescription, education's own vocabulary, none of
// which is a doing verb.
const TRIGGER_OWNERS: Record<string, readonly string[]> = {
  "brains-board": ["track a list of", "keep a table of", "build a tracker", "build a CRM", "log every"],
  "brains-automation": [
    "automate this",
    "every morning do",
    "run this nightly",
    "auto-draft when",
    "when an email from",
  ],
  "brains-workflow": ["ship X by", "coordinate this initiative", "set up a project with KPIs and a team"],
  "brains-build": ["what can brains do", "can brains do", "what else can brains do"],
};
const descriptionOf = (dir: string): string => {
  const body = readFileSync(join(PLUGIN, "skills", dir, "SKILL.md"), "utf8");
  return (/^description:\s*(.+)$/m.exec(body)?.[1] ?? "").toLowerCase();
};
const DESCRIPTIONS = new Map(skillDirs.map((dir) => [dir, descriptionOf(dir)]));
for (const [owner, triggers] of Object.entries(TRIGGER_OWNERS)) {
  const ownerDescription = DESCRIPTIONS.get(owner);
  assert(ownerDescription !== undefined, `trigger owner ${owner} is not an installed skill`);
  for (const trigger of triggers) {
    const phrase = trigger.toLowerCase();
    assert(
      ownerDescription!.includes(phrase),
      `${owner} no longer advertises its own trigger "${trigger}" — regenerate from the monorepo catalog`,
    );
    for (const [dir, description] of DESCRIPTIONS) {
      if (dir === owner) continue;
      assert(
        !description.includes(phrase),
        `trigger "${trigger}" is claimed by both ${owner} and ${dir} — routing collision`,
      );
    }
  }
}

// The yield, asserted positively. brains-build builds this clause from
// PROCEDURE_SKILL_IDS (render-features.ts), so it names all three owners rather
// than merely avoiding their phrases — a recut that dropped the hand-off while
// keeping its own vocabulary clean would pass the sweep above and still leave a
// user asking to build something with nowhere to be sent.
for (const owner of ["brains-board", "brains-automation", "brains-workflow"]) {
  assert(
    DESCRIPTIONS.get("brains-build")!.includes(owner),
    `brains-build must name ${owner} as the owner it yields to`,
  );
}

// brains-build is the education face: it must POINT, not restate. It routes to
// owners and must not carry another skill's procedure vocabulary.
assert(
  !/one question per turn/i.test(buildSkill),
  "brains-build restates a *_flow playbook procedure it should only point at",
);

// No skill may name a tool the monorepo registry does not have. This is the
// class of bug that shipped `get_overnight_digest` in two skills for months.
for (const dir of skillDirs) {
  const body = readFileSync(join(PLUGIN, "skills", dir, "SKILL.md"), "utf8");
  assert(
    !/get_overnight_digest|create_dataset_recipe|refresh_dataset_recipe/.test(body),
    `${dir} names a tool that does not exist in the brains MCP registry`,
  );
}

// Keep independent semantic assertions: digest equality proves provenance, not
// that the canonical source itself kept the load-bearing safety rules.
assert(
  writeSkillNormalized.includes("its `install_id`, `action_name`, and structured `input` in `act_on_integration`") &&
    writeSkillNormalized.includes("this tuple is the only call shape"),
  "structured action tuple missing",
);
assert(writeSkillNormalized.includes("call `get_page` on the selected"), "action discovery must resolve frontmatter");
assert(
  writeSkillNormalized.includes("`requires_confirmation` is absent") &&
    writeSkillNormalized.includes("treat whether it drafts or runs as unknown"),
  "absent requires_confirmation must remain unknown rather than predict a draft",
);
assert(
  writeSkillNormalized.includes("`requires_confirmation:true` drafts for out-of-band approval") &&
    writeSkillNormalized.includes("`requires_confirmation:false` runs inline") &&
    writeSkillNormalized.includes("| `auto_executed` | It already ran; it carries `result` and `action_record_id`."),
  "both requires_confirmation branches must retain their distinct behavior",
);
assert(
  writeSkillNormalized.includes("Partial tuples error") &&
    writeSkillNormalized.includes("only bare legacy `source` returns `clarification`"),
  "partial tuples must error; only the bare legacy source shim may clarify",
);
assert(writeSkillNormalized.includes("there is no source-enum fallback"), "legacy source-enum fallback must stay removed");
assert(!writeSkillNormalized.includes("Fall back to the legacy source-enum"), "stale legacy fallback pointer must not return");
assert(writeSkillNormalized.includes("action_record_id"), "auto-executed result must expose action_record_id");
assert(!writeSkillNormalized.includes("audit_id"), "stale auto-executed audit_id field must not return");
assert(
  writeSkillNormalized.includes("| `rate_limited` | Nothing ran and no upstream call occurred."),
  "rate-limited actions must be documented as not attempted",
);
assert(
  writeSkillNormalized.includes("30 auto-executions/install/60s"),
  "auto-execution rate-limit context missing",
);
assert(writeSkillNormalized.includes("| `clarification` |"), "clarification result kind missing");
assert(writeSkillNormalized.includes("| `noop` |"), "noop result kind missing");
assert(
  writeSkillNormalized.includes("whether an outbound write reached the provider is **unknown**"),
  "auto-failed actions must preserve unknown-outcome guidance",
);
assert(writeSkillNormalized.includes("Don't blind-retry"), "auto-failed external writes must not be blindly retried");
assert(
  writeSkillNormalized.includes("only `draft` carries `confirm_hint`") &&
    writeSkillNormalized.includes("never say it is awaiting approval"),
  "draft and auto-executed reporting gates must remain distinct",
);
assert(
  writeSkillNormalized.includes("`dry_run` suppresses external writes to no-call `[DRY RUN]` drafts"),
  "dry-run external-write suppression missing",
);
assert(writeSkill.endsWith("\n"), "generated public skill must end with a newline");
assert(writeSkillNormalized.includes("out-of-band") && writeSkillNormalized.includes("confirmation secret"), "approval boundary missing");
assert(writeSkillNormalized.includes("never call `confirm_action` yourself"), "agent self-confirm prohibition missing");
assert(writeSkillNormalized.includes("call `discard_action`"), "agent-side draft discard path missing");
assert(!writeSkillNormalized.includes("never call `discard_action`"), "draft discard guidance must remain actionable");
assert(writeSkillNormalized.includes("remains approvable"), "expired drafts must not be described as inert");
assert(writeSkillNormalized.includes("this tuple is the only call shape"), "source-only action fallback must stay prohibited");
assert(!/act_on_integration[^.]{0,200}request=/.test(writeSkillNormalized), "free-form action request must not return");

// Same treatment for brains-automation, and for the same reason: the digest proves
// these bytes came from the catalog, not that the catalog kept the rails. Nothing
// here would notice if a regeneration DELETED the secret-hygiene guidance — the
// digest would move with it and every check above would stay green. These three are
// the rails whose absence is a credential-exposure bug, one per distinct rule:
// don't ask for a bot token, don't solicit a secret value while authoring, and
// don't echo one back if the user pastes it anyway.
//
// Each pins an IMPERATIVE, not the prose explaining it. Rationale sentences get
// reworded editorially and would red this build for no behavioral change; a
// directive cannot be reworded without changing the rule.
//
// COUPLING, stated because it is load-bearing: these substrings live in a
// generated artifact whose source is a different, PRIVATE repo, so an author
// rewording the procedure reds a build in a public repo they may not know exists.
// If that happens, the fix is to re-derive the rail in ssvlabs/brains at
// packages/capability-catalog/procedures/create-automation.md and regenerate.
// Never soften or delete the assertion here — that is the exact outcome it exists
// to prevent.
assert(
  automationSkillNormalized.includes("Never ask the user to paste a Telegram bot token"),
  "brains-automation lost the Telegram bot-token refusal",
);
assert(
  automationSkillNormalized.includes("never solicit the value in chat"),
  "brains-automation lost the rule against soliciting a secret value in chat",
);
assert(
  automationSkillNormalized.includes("do NOT refuse and do NOT echo it back"),
  "brains-automation lost the handling for a secret the user pasted anyway",
);

// This README is the install instructions for anyone who finds the repo directly rather than the
// guided page, so it has to carry the same contract. It documented `export BRAINS_API_TOKEN` as the
// way in long after that stopped being able to work, which is exactly the drift these pin.
// Resolve both delimiters before slicing. A missing end heading yields -1, and
// `slice(start, -1)` would silently widen the region to almost the whole file —
// every assertion below would then pass while reading the wrong section.
const codexStart = headingIndex(readme, "## Install for Codex");
const claudeStart = headingIndex(readme, "## Install for Claude Code");
assert(codexStart >= 0, "README must document a Codex install");
assert(claudeStart >= 0, "README must document a Claude Code install");
assert(
  claudeStart > codexStart,
  "README's Claude Code section must follow the Codex one — the Codex checks below slice between them",
);
// The opening paragraphs, signal then pin. See README_INTRO_REGION for what a revert of them looked
// like. The one allowed exception names a file rather than a promise.
const readmeIntro = readme.slice(0, codexStart);
assertCaptureQualified("README intro", readmeIntro, CAPTURE_QUALIFIER, [
  // The shared-components sentence names the `inbox engine` — hooks/lib/brains-inbox.sh, a file both
  // packages carry — not a promise that anything is delivered.
  "inbox engine",
]);
assert(
  normalizeRegion(readmeIntro) === README_INTRO_REGION,
  "README's intro must match the approved copy exactly (README and README_INTRO_REGION must be edited together)",
);
// The canary, over the whole file rather than only the regions no constant pins. See
// UNCONDITIONAL_CAPTURE for what it is for and what it cannot do.
for (const pattern of UNCONDITIONAL_CAPTURE) {
  const match = pattern.exec(readme);
  assert(
    !match,
    `README presents capture or the inbox as unconditional — both are hook-driven, credential-gated, and run in no web chat (matched: ${JSON.stringify(match?.[0])})`,
  );
}

const codexReadme = readme.slice(codexStart, claudeStart);
assert(
  codexReadme.includes("codex mcp login brains"),
  "README's Codex install must sign Codex in with `codex mcp login brains`",
);
assert(
  codexReadme.includes(CODEX_MIN_VERSION) && codexReadme.includes(CODEX_CAPABILITY_PROBE),
  `README's Codex install must state the ${CODEX_MIN_VERSION} floor and the \`${CODEX_CAPABILITY_PROBE}\` check`,
);
// The token is still documented, but only under the optional capture/inbox heading — never in the
// install sequence itself. Anything above that heading claiming a token is how you get in is the
// regression this catches.
const optionalHeadingIndex = headingIndex(codexReadme, "### Optional");
assert(optionalHeadingIndex > 0, "README must keep the optional capture/inbox section for Codex");
const codexPrerequisites = codexReadme.slice(0, optionalHeadingIndex);
for (const forbidden of ["BRAINS_API_TOKEN", "launchctl setenv"]) {
  assert(
    !codexPrerequisites.includes(forbidden),
    `README must not present \`${forbidden}\` as a Codex install prerequisite — it belongs under the optional capture/inbox section`,
  );
}
// The whole pre-Optional region, verbatim, for the same reason as the Claude one below: the two
// literal bans above were the only thing standing here, and a false promise that named neither
// literal walked straight past them.
assert(
  normalizeRegion(codexPrerequisites) === CODEX_INSTALL_REGION,
  "README's Codex install region must match the approved copy exactly (README and CODEX_INSTALL_REGION must be edited together)",
);
const codexOptional = codexReadme.slice(optionalHeadingIndex);
assert(
  codexOptional.includes("launchctl setenv"),
  "README's optional section must keep the desktop launchctl path — a desktop app inherits no shell export",
);
assert(
  normalizeRegion(codexOptional) === CODEX_OPTIONAL_REGION,
  "README's Codex token section must match the approved copy exactly (README and CODEX_OPTIONAL_REGION must be edited together)",
);

// Same treatment for the Claude Code section. It is sliced between its own heading and the
// claude.ai web heading — NOT the shared layout section. The web section sits between the two,
// and letting it fall inside this slice would subject it to the Claude-Code-specific rules below
// (the version-floor bans, the `bash -n` sweep) while leaving its own claims unpinned. Resolve
// both delimiters first, for the same reason as above.
const sharedLayoutStart = headingIndex(readme, "## Shared layout");
const webStart = headingIndex(readme, CLAUDE_WEB_HEADING);
assert(sharedLayoutStart >= 0, "README must keep the shared layout section — it ends the web slice");
assert(webStart >= 0, `README must document the claude.ai web install ("${CLAUDE_WEB_HEADING}")`);
assert(
  webStart > claudeStart,
  "README's claude.ai web section must follow the Claude Code install — the checks below slice between them",
);
assert(
  sharedLayoutStart > webStart,
  "README's shared layout section must follow the claude.ai web install — the web checks slice between them",
);
const claudeReadme = readme.slice(claudeStart, webStart);

// Every delimiter this file slices on, in one place, counted the way the manifest's mcpServers is
// counted above. A boundary is taken from the FIRST match, so a second copy of a delimiter silently
// redraws the regions around it, and both halves of that were executed: a second
// "## Install for claude.ai web" later in the file carries its content OUTSIDE the pinned web
// region, and a decoy "## Shared layout" planted where the approved region ends truncates that
// region to nothing. Each entry is the exact string its boundary resolves on, and each is scoped to
// the text it is resolved in — "### Optional" is legitimately once per client section, not once per
// file.
//
// KEPT, though the composition assert at the end of this section is now the guarantee and subsumes
// it: a duplicated heading fails here naming the heading, one line, instead of arriving as a
// whole-file diff. Same reason the per-region pins sit ahead of composition. What it does NOT cover
// is a mid-line delimiter — that is handled at the source now, by resolving every boundary at a line
// start, so a glued copy is not a boundary at all and the text around it fails composition.
for (const [scopeLabel, scope, delimiter] of [
  ["README", readme, "## Install for Codex"],
  ["README", readme, "## Install for Claude Code"],
  ["README", readme, CLAUDE_WEB_HEADING],
  ["README", readme, "## Shared layout"],
  ["README", readme, "## Self-hosting"],
  ["README", readme, "## License"],
  ["README's Codex section", codexReadme, "### Optional"],
  ["README's Claude Code section", claudeReadme, CLAUDE_OPTIONAL_HEADING],
  ["README's Claude Code section", claudeReadme, "### Already installed?"],
] as const) {
  const pattern = new RegExp(`^${delimiter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "gm");
  const occurrences = (scope.match(pattern) ?? []).length;
  assert(
    occurrences === 1,
    `${scopeLabel} must contain "${delimiter}" exactly once at the start of a line — every region here is sliced on its FIRST occurrence, so a second copy silently moves the boundary (found ${occurrences})`,
  );
}

// Pinned individually so a single dropped element names itself, ahead of the whole-region pin.
for (const pinned of [
  "claude plugin marketplace add https://github.com/ssvlabs/brains-plugins.git",
  "claude plugin install brains@brains",
  CLAUDE_MCP_LOGIN,
  "claude mcp list",
  "An app on this computer",
  CLAUDE_LOOPBACK,
  CLAUDE_TOKEN_OPENER,
  CLAUDE_VERSION_NOTE,
]) {
  assert(claudeReadme.includes(pinned), `README's Claude install must keep: ${pinned}`);
}
const claudeOptionalIndex = headingIndex(claudeReadme, CLAUDE_OPTIONAL_HEADING);
assert(claudeOptionalIndex > 0, "README must keep the optional capture/inbox section for Claude Code");
const claudeMigrationIndex = headingIndex(claudeReadme, "### Already installed?");
assert(claudeMigrationIndex > claudeOptionalIndex, "README must tell an existing Claude Code install how to migrate, after the token section");
const claudeMigration = claudeReadme.slice(claudeMigrationIndex);
// The whole pre-Optional region is pinned verbatim. Enumerated bans on this region kept losing to
// paraphrase — "prompts during installation for the brains token" walked past a token ban, and
// "or a newer release" walked past a version-floor ban — so the approved copy is the contract.
// Changing it is a deliberate two-line diff: this constant and the README together.
assert(
  normalizeRegion(claudeReadme.slice(0, claudeOptionalIndex)) === CLAUDE_INSTALL_REGION,
  "README's Claude install region must match the approved copy exactly (README and CLAUDE_INSTALL_REGION must be edited together)",
);
// The token section, kept as NAMED signals ahead of its own pin. These two bans used to be all that
// stood here, on the argument that "token" is legitimate below the heading — see
// CODEX_OPTIONAL_REGION for the two evasions that retired that argument.
const claudeOptionalBody = claudeReadme.slice(claudeOptionalIndex, claudeMigrationIndex);
assert(
  !CLAUDE_VERSION_SHAPE.test(claudeOptionalBody),
  "README's Claude token section must not name a version — no Claude Code floor is verifiable",
);
assert(
  !CLAUDE_FLOOR_VOCAB.test(claudeOptionalBody),
  "README's Claude token section must not imply a minimum Claude Code version",
);
assert(
  normalizeRegion(claudeOptionalBody) === CLAUDE_OPTIONAL_REGION,
  "README's Claude token section must match the approved copy exactly (README and CLAUDE_OPTIONAL_REGION must be edited together)",
);
// Every published command gets copied verbatim by someone, so parse them instead of trusting a
// read-through: `--config token=<your token>` looked fine in review and is a syntax error in both
// bash and zsh, because the angle brackets are redirections. Checking the whole block also covers
// the three-command install, where a broken line would strand a user mid-install.
// Sweep EVERY shell block in the file, not just this slice. Region-scoped sweeping silently lost
// coverage the moment a block moved: promoting "Self-hosting" past "## Shared layout" took its
// `--config endpoint=…` example outside every slice checked here, and the six Codex blocks were
// never swept at all — so the one command a self-hoster copies, and the whole Codex install, were
// unchecked. The syntax of a published command does not depend on which section it sits in.
//
// Every fence is one of three kinds and there is no fourth: SWEPT (parsed with `bash -n` below),
// NOT_SHELL (a data or output block, excluded on purpose), or PROMPTED (rejected). An unclassified
// language fails, because the coverage claim above is only true if adding a fence forces a decision
// about it — a ```console block was neither swept nor refused, and a ```Bash block was certified as
// swept by an allow-list that lower-cased the language and then skipped by an extractor that did not.
const SWEPT_SHELL_FENCES = ["sh", "bash", "shell", "zsh"];
// Deliberately NOT parsed. Empty today: every fence in this README is a shell block. A data or
// output block lands here WITH its reason, so excluding one stays a visible act rather than a gap.
const NOT_SHELL_FENCES: string[] = [];
// Prompt transcripts, rejected rather than allow-listed: every command in this file exists to be
// copied verbatim, `bash -n` cannot parse `$ claude plugin install …`, and stripping the prompts to
// make it parse would sweep a body no reader copies — so this would become the one fence an author
// could reach for to publish an unchecked command. There are none today, so the ban costs nothing.
const PROMPTED_SHELL_FENCES = ["console", "shell-session", "shellsession", "sh-session", "terminal"];
const { fences: readmeFences, outside: readmeOutsideFences } = markdownFences(readme);
for (const { language } of readmeFences) {
  assert(
    language !== "",
    "README has a fence with no language — label it `sh` so the sweep parses it, or add its language to NOT_SHELL_FENCES with a reason",
  );
  assert(
    !PROMPTED_SHELL_FENCES.includes(language),
    `README fence \`\`\`${language} is a prompt transcript this sweep cannot parse — publish the commands in a \`\`\`sh block so they get parsed`,
  );
  assert(
    SWEPT_SHELL_FENCES.includes(language) || NOT_SHELL_FENCES.includes(language),
    `README uses a fence this sweep does not classify: \`\`\`${language} — add it to SWEPT_SHELL_FENCES (parsed with bash -n) or to NOT_SHELL_FENCES (data or output, deliberately not parsed)`,
  );
}
// A fence is not the only way to publish a copyable command, and the other ways are invisible to
// the scanner: an indented code block (four spaces or a tab) needs no fence at all, and a fence
// opened inside a blockquote or a list item starts with `> ` or `- `, which is not a fence opener by
// the rule that scanner implements. The list form was executed: `- ```sh` followed by a two-space
// indented broken command renders as a shell block (an unclosed fence closes at the end of the list
// item) while every line of it read as ordinary prose here, two-space indents and all. None of these
// exist in this file today; each would render as code and go unswept, so each is refused by name
// rather than parsed — the same call as the prompt fences above, for the same reason.
for (const line of readmeOutsideFences) {
  assert(
    !/^( {4,}|\t)/.test(line),
    `README has an indented code block outside any fence — it renders as code and this sweep cannot parse it; publish it as a top-level \`\`\`sh block: ${line}`,
  );
  assert(
    !/^\s*>/.test(line),
    `README has a blockquoted line — a fence inside a blockquote is not swept; publish commands as a top-level \`\`\`sh block: ${line}`,
  );
  assert(
    !/^ {0,3}([-*+]|\d{1,9}[.)])\s+(`{3,}|~{3,})/.test(line),
    `README opens a code fence inside a list item — it renders as code and this sweep does not parse it; publish it as a top-level \`\`\`sh block: ${line}`,
  );
}
const readmeShellBlocks = readmeFences
  .filter((fence) => SWEPT_SHELL_FENCES.includes(fence.language))
  .map((fence) => fence.body);
const claudeShellBlocks = markdownFences(claudeReadme).fences
  .filter((fence) => SWEPT_SHELL_FENCES.includes(fence.language))
  .map((fence) => fence.body);
assert(claudeShellBlocks.length > 0, "README's Claude install must keep its shell blocks");
// Containment, not a count comparison: `readmeShellBlocks.length >= claudeShellBlocks.length` holds
// for any two files — the whole-file sweep is a superset by construction — so it proved nothing.
// Both sides come from the same scanner, so the bodies compare byte for byte.
for (const block of claudeShellBlocks) {
  assert(
    readmeShellBlocks.includes(block),
    `the whole-file shell sweep missed a block from the Claude install section — it is published unparsed:\n${block}`,
  );
}
for (const block of readmeShellBlocks) {
  const parsed = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
  assert(
    parsed.status === 0,
    `README shell block is not valid shell:\n${block}\n${parsed.stderr}`,
  );
}

// A plugin from the header era is registered but logged out, so the migration path has to say
// both halves: update, then sign in. Named signals, then the region.
assert(
  claudeMigration.includes("claude plugin update brains"),
  "README's Claude migration must update the plugin",
);
assert(
  claudeMigration.includes(CLAUDE_MCP_LOGIN),
  "README's Claude migration must sign in — updating alone leaves the user logged out",
);
assert(
  normalizeRegion(claudeMigration) === CLAUDE_MIGRATION_REGION,
  "README's Claude migration section must match the approved copy exactly (README and CLAUDE_MIGRATION_REGION must be edited together)",
);

// The claude.ai web section, sliced between its own heading and the shared layout section.
//
// This section exists because the rest of this README describes hook-driven capture, and a web
// reader gets none of it: hooks are inert in claude.ai chat on BOTH install paths — the custom
// connector and the full marketplace-sync plugin (support article 13837440). What replaces them
// was measured live rather than assumed (claude.ai, 2026-08-05): an explicit "save this chat to brains"
// works, while unprompted capture fired on ONE of five passive trials — including a trial that
// announced a save it never performed. The assertions below pin that distinction, because the
// tempting edit is to collapse the two into one reassuring sentence, and the whole finding is
// that they are not the same promise.
const webReadme = readme.slice(webStart, sharedLayoutStart);
assert(
  webReadme.includes(CLAUDE_WEB_GUIDE),
  `README's web section must link the install guide (${CLAUDE_WEB_GUIDE}) — it owns the procedure and the instruction block, which must not be forked into this file`,
);
assert(
  webReadme.includes(CLAUDE_MCP_URL),
  `README's web section must name ${CLAUDE_MCP_URL} — it is what the connector dialog asks for`,
);
// Both install paths. Naming only the connector would strand paid users on the route that
// carries the skills; naming only the plugin would exclude every Free-tier reader.
for (const path of ["Custom connector", "Full plugin"]) {
  assert(
    webReadme.includes(path),
    `README's web section must name both claude.ai install paths — missing: ${path}`,
  );
}
assert(
  webReadme.includes("save_chat_session"),
  "README's web section must name save_chat_session — it is the only capture path on claude.ai",
);
// The measured shape, in both directions. Dropping either half re-creates the bug this ticket
// fixed: without the explicit path the section reads as "capture is broken", and without the
// unreliability caveat it reads as "capture just works".
assert(
  /save this chat to brains/i.test(webReadme),
  "README's web section must give the user the explicit phrasing that actually works",
);
assert(
  /only sometimes/i.test(webReadme),
  "README's web section must keep unprompted capture marked unreliable — it fired on one of five measured passive trials",
);
assert(
  /list_pages type=chat_session|which chats it\s+has/i.test(webReadme),
  "README's web section must tell the user how to VERIFY a save — a model has been observed claiming a save it did not perform",
);
// The regression that would pass every check above: re-asserting hook-driven capture on the one
// surface whose whole purpose is to say the hooks are absent.
assert(
  !/\bcapture is automatic\b/i.test(webReadme),
  "README's web section must not claim automatic capture — no hooks run on claude.ai, on either install path",
);
// And the strong guarantee the keyword checks above cannot give: the WHOLE section, verbatim.
// Every assertion above passed a rewrite that reversed the meaning, twice over — once inside the
// capture paragraphs and once in a new paragraph beside them (see the constant's own comment).
// Changing this copy is a deliberate two-line diff: CLAUDE_WEB_REGION and the README together.
assert(
  webReadme.includes("**Capture is different"),
  "README's web section must keep its capture paragraphs — they are what a web user needs most",
);
assert(
  normalizeRegion(webReadme) === CLAUDE_WEB_REGION,
  "README's claude.ai section must match the approved copy exactly (README and CLAUDE_WEB_REGION must be edited together)",
);

// The self-hosting section, sliced between its own heading and the licence. See SELF_HOSTING_REGION
// for why this copy is pinned and the shared layout above it is not.
const selfHostingStart = headingIndex(readme, "## Self-hosting");
const licenseStart = headingIndex(readme, "## License");
assert(
  selfHostingStart > sharedLayoutStart,
  "README's self-hosting section must follow the shared layout — the slice below depends on it",
);
assert(
  licenseStart > selfHostingStart,
  "README must keep the licence section after self-hosting — it ends the self-hosting slice",
);
assert(
  normalizeRegion(readme.slice(sharedLayoutStart, selfHostingStart)) === SHARED_LAYOUT_REGION,
  "README's shared layout section must match the approved copy exactly (README and SHARED_LAYOUT_REGION must be edited together)",
);
assert(
  normalizeRegion(readme.slice(selfHostingStart, licenseStart)) === SELF_HOSTING_REGION,
  "README's self-hosting section must match the approved copy exactly (README and SELF_HOSTING_REGION must be edited together)",
);
assert(
  normalizeRegion(readme.slice(licenseStart)) === LICENSE_REGION,
  "README's licence section must match the approved copy exactly (README and LICENSE_REGION must be edited together)",
);

// The WHOLE file, composed from the regions above, in order. Each pin holds its own text; until now
// nothing held the SEAMS between them, and both kinds of seam were executed. Text GLUED to a
// region's last line: "## Shared layout" appended with no space to the web section's final sentence
// moved the boundary onto the decoy, left the pinned slice matching exactly, and put every paragraph
// after it inside no region at all. Text in a region nobody had pinned: a capture promise with
// neither stem, dropped into the Codex token section, passed every check including the canary.
// Composition removes the class rather than the two instances — every published byte now belongs to
// exactly one approved constant, so there is no seam left to write in. This is what CORE_BODY does
// for core.md. The per-region pins stay AHEAD of it as named signals: this one can only report that
// the file no longer composes, which is true but tells the reader nothing about where.
const README_REGIONS = [
  README_INTRO_REGION,
  CODEX_INSTALL_REGION,
  CODEX_OPTIONAL_REGION,
  CLAUDE_INSTALL_REGION,
  CLAUDE_OPTIONAL_REGION,
  CLAUDE_MIGRATION_REGION,
  CLAUDE_WEB_REGION,
  SHARED_LAYOUT_REGION,
  SELF_HOSTING_REGION,
  LICENSE_REGION,
];
assert(
  normalizeRegion(readme) === README_REGIONS.join("\n\n"),
  "README must be exactly the approved regions, in order, with nothing between them — every byte this file publishes belongs to one constant here, so text added at a seam or in a section no pin covers fails right here",
);

assert(
  turnHook.includes('CLIENT="claude"'),
  "shared turn hook must default Claude Code captures to the Claude CLI",
);
assert(
  turnHook.includes('[ -n "${PLUGIN_ROOT:-}" ] && CLIENT="codex"'),
  "shared turn hook must identify the Codex plugin runtime as the Codex CLI",
);
assert(
  turnHook.includes('client:$client, client_type:"cli"'),
  "turn ingest payload must include the detected client and CLI type",
);
assert(
  turnHook.includes("codex mcp get brains --json"),
  "Codex turn capture must reuse persisted MCP authentication when no token env is present",
);
assert(
  turnHook.includes(".transport.http_headers.Authorization"),
  "Codex turn capture must read the configured MCP Authorization header",
);

// Exercise the standalone Codex path without a token env. The fake `codex`
// exposes the same persisted Authorization shape as `codex mcp get`, while the
// fake `curl` captures POST bodies and, when URL_FILE is set, every request
// target as well (the inbox GET returns nothing either way).
const temp = mkdtempSync(join(tmpdir(), "brains-plugin-contract-"));
try {
  const bin = join(temp, "bin");
  const capture = join(temp, "payloads.jsonl");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "codex"),
    '#!/bin/sh\nprintf \'%s\\n\' \'{"transport":{"http_headers":{"Authorization":"Bearer configured-token"}}}\'\n',
  );
  writeFileSync(
    join(bin, "curl"),
    '#!/bin/sh\n[ "${SLOW_CAPTURE:-}" = "1" ] && sleep 0.2\nprev=""\nfor arg in "$@"; do\n  if [ "$prev" = "-d" ]; then printf \'%s\\n\' "$arg" >> "$CAPTURE_FILE"; fi\n  case "$arg" in\n    http://*|https://*) [ -n "${URL_FILE:-}" ] && printf \'%s\\n\' "$arg" >> "$URL_FILE" ;;\n  esac\n  prev="$arg"\ndone\n',
  );
  chmodSync(join(bin, "codex"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);

  // core.md's copy is pinned above; this proves it is DELIVERED. Deleting brains-start.sh's
  // `cat "$CORE_MD"` line passed all three suites — SessionStart is the core prompt's ONLY delivery
  // path, and nothing in CI read what that hook actually emits, so every copy pin above proved the
  // text was right while nothing proved a model ever sees it. Guard-works is not guard-runs (#14).
  // No credential resolves here, so the inbox engine exits silently and stdout is the injected
  // context alone; the empty project dir keeps a stray .claude/USER.md on the runner out of it.
  const emptyProject = join(temp, "empty-project");
  mkdirSync(emptyProject);
  const coreDelivery = spawnSync("bash", [join(PLUGIN, "hooks", "brains-start.sh")], {
    input: JSON.stringify({ session_id: "core-delivery-probe" }),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CLAUDE_PROJECT_DIR: emptyProject,
      CLAUDE_PLUGIN_OPTION_TOKEN: "",
      BRAINS_API_TOKEN: "",
      BRAINS_INBOX_TOKEN: "",
      BRAINS_STATE_DIR: join(temp, "state-core"),
    },
  });
  assert(coreDelivery.status === 0, `SessionStart hook failed: ${coreDelivery.stderr.toString()}`);
  assert(
    normalizeRegion(coreDelivery.stdout.toString()).includes(CORE_BODY),
    "SessionStart hook must inject core.md — it is the only delivery path for the core prompt, and the pins above prove the text is right, not that it reaches a model",
  );

  const result = spawnSync("bash", [join(PLUGIN, "hooks", "brains-turn.sh")], {
    input: JSON.stringify({ session_id: "codex-session", prompt: "hello" }),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PLUGIN_ROOT: PLUGIN,
      BRAINS_API_TOKEN: "",
      BRAINS_INBOX_TOKEN: "",
      CLAUDE_PLUGIN_OPTION_TOKEN: "",
      BRAINS_STATE_DIR: join(temp, "state"),
      CAPTURE_FILE: capture,
    },
  });
  assert(result.status === 0, `standalone Codex turn hook failed: ${result.stderr.toString()}`);
  assert(await waitForFile(capture), "asynchronous Codex user ingest POST did not complete");
  const payloads = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert(payloads.length === 1, "standalone Codex turn hook must POST exactly one ingest payload");
  assert(payloads[0].client === "codex", "standalone Codex payload must identify Codex");
  assert(payloads[0].client_type === "cli", "standalone Codex payload must identify the CLI surface");
  assert(payloads[0].content === "hello", "standalone Codex payload must preserve the prompt");

  // Codex Stop must not return before its assistant POST has completed. The
  // delayed fake curl makes the old fire-and-forget implementation return
  // before the capture file exists; synchronous delivery leaves the assistant
  // payload present as soon as the hook exits.
  const assistantCapture = join(temp, "assistant-payloads.jsonl");
  const stopResult = spawnSync("bash", [join(PLUGIN, "hooks", "brains-turn.sh")], {
    input: JSON.stringify({
      session_id: "codex-session",
      hook_event_name: "Stop",
      last_assistant_message: "hello from codex",
      stop_hook_active: false,
    }),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PLUGIN_ROOT: PLUGIN,
      BRAINS_API_TOKEN: "",
      BRAINS_INBOX_TOKEN: "",
      CLAUDE_PLUGIN_OPTION_TOKEN: "",
      BRAINS_STATE_DIR: join(temp, "state"),
      CAPTURE_FILE: assistantCapture,
      SLOW_CAPTURE: "1",
    },
  });
  assert(stopResult.status === 0, `standalone Codex Stop hook failed: ${stopResult.stderr.toString()}`);
  const assistantPayloads = readFileSync(assistantCapture, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert(assistantPayloads.length === 1, "Codex Stop must complete exactly one assistant ingest POST");
  assert(assistantPayloads[0].role === "assistant", "Codex Stop payload must use the assistant role");
  assert(assistantPayloads[0].client === "codex", "Codex Stop payload must identify Codex");
  assert(assistantPayloads[0].content === "hello from codex", "Codex Stop payload must preserve the response");

  // Conversation capture and the inbox are OPT-IN: the MCP server authenticates itself, so a user
  // who never sets a token still gets a working plugin. Both hooks must therefore no-op silently
  // when no credential resolves — exit 0, no output, no request — rather than erroring or hanging.
  // `codexless` shadows `codex` with a failing stub so the turn hook's config scavenge finds
  // nothing, which is the state of a plugin install that has only ever done `codex mcp login`.
  const codexless = join(temp, "codexless");
  mkdirSync(codexless);
  writeFileSync(join(codexless, "codex"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(codexless, "codex"), 0o755);
  const noTokenCapture = join(temp, "no-token-payloads.jsonl");
  const noTokenEnv = {
    ...process.env,
    PATH: `${codexless}:${bin}:${process.env.PATH ?? ""}`,
    PLUGIN_ROOT: PLUGIN,
    BRAINS_API_TOKEN: "",
    BRAINS_INBOX_TOKEN: "",
    CLAUDE_PLUGIN_OPTION_TOKEN: "",
    BRAINS_STATE_DIR: join(temp, "state-no-token"),
    CAPTURE_FILE: noTokenCapture,
  };
  const turnNoToken = spawnSync("bash", [join(PLUGIN, "hooks", "brains-turn.sh")], {
    input: JSON.stringify({ session_id: "codex-session", prompt: "hello" }),
    env: noTokenEnv,
  });
  assert(turnNoToken.status === 0, "turn hook must exit 0 with no token available");
  assert(
    turnNoToken.stdout.toString() === "" && turnNoToken.stderr.toString() === "",
    "turn hook must stay silent with no token available",
  );
  assert(!existsSync(noTokenCapture), "turn hook must not POST anything with no token available");

  const inboxNoToken = spawnSync(
    "bash",
    [join(PLUGIN, "hooks", "lib", "brains-inbox.sh"), "startup", "codex-session"],
    { env: noTokenEnv },
  );
  assert(inboxNoToken.status === 0, "inbox engine must exit 0 with no token available");
  assert(
    inboxNoToken.stdout.toString() === "" && inboxNoToken.stderr.toString() === "",
    "inbox engine must stay silent with no token available",
  );

  // The MCP URL is a literal now, so `userConfig.endpoint` governs capture and the inbox and
  // nothing else. That makes this the one check standing between a self-hosted user and silence:
  // pin the request TARGETS, not just the bodies. Nothing pinned them before — the fake curl only
  // recorded `-d` payloads, so a hook that started posting captures to the hardcoded production
  // host would have passed every assertion above it.
  //
  // Runs the Claude path deliberately (no PLUGIN_ROOT), because claude-hooks.json is what this
  // guards, and in `prompt` mode the engine makes exactly one inbox GET with no device report.
  const endpointCapture = join(temp, "endpoint-payloads.jsonl");
  const endpointUrls = join(temp, "endpoint-urls.txt");
  const endpointRun = spawnSync("bash", [join(PLUGIN, "hooks", "brains-turn.sh")], {
    input: JSON.stringify({ session_id: "claude-session", prompt: "hello" }),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CLAUDE_PLUGIN_OPTION_TOKEN: "endpoint-probe-token",
      CLAUDE_PLUGIN_OPTION_ENDPOINT: CLAUDE_SELF_HOSTED,
      BRAINS_API_TOKEN: "",
      BRAINS_INBOX_TOKEN: "",
      BRAINS_STATE_DIR: join(temp, "state-endpoint"),
      CAPTURE_FILE: endpointCapture,
      URL_FILE: endpointUrls,
    },
  });
  assert(endpointRun.status === 0, `configured-endpoint turn hook failed: ${endpointRun.stderr.toString()}`);
  // Gate on the payload file, not the URL file: the user ingest POST is backgrounded, and the fake
  // curl writes a request's URL before its body — so a present body means the URL landed already.
  assert(await waitForFile(endpointCapture), "configured-endpoint ingest POST did not complete");
  const requestedUrls = readFileSync(endpointUrls, "utf8").trim().split("\n");
  assert(
    requestedUrls.includes(`${CLAUDE_SELF_HOSTED}/ingest/claude`),
    `capture must POST to the configured endpoint — got ${requestedUrls.join(", ")}`,
  );
  assert(
    requestedUrls.some((url) => url.startsWith(`${CLAUDE_SELF_HOSTED}/inbox/claude`)),
    `the inbox must poll the configured endpoint — got ${requestedUrls.join(", ")}`,
  );
  assert(
    !requestedUrls.some((url) => url.startsWith(CLAUDE_ENDPOINT)),
    `no hook request may reach ${CLAUDE_ENDPOINT} when an endpoint is configured — got ${requestedUrls.join(", ")}`,
  );

  // The same hook with the option NEVER SET — the case a self-hoster actually lands in, and the
  // one the README's self-hosting section now documents. Claude Code exports
  // CLAUDE_PLUGIN_OPTION_<KEY> from the value STORED in settings, and a declared `default` is not
  // by itself a stored value: observed on 2.1.221, installing without `--config endpoint=…` wrote
  // no `pluginConfigs` entry and exported nothing, so these hooks fell through to their own literal
  // fallback. Verified against a real `claude -p` run whose manifest carried a sentinel default
  // that never appeared in the hook environment. Scope of that observation: the non-interactive
  // install path only — `/plugin configure` was not exercised and may prefill and store the
  // default, which would leave a configured value behind like any other.
  //
  // Pinned because the README now promises this fallback host by name. Changing the fallback
  // chain in either hook would make that documentation wrong with nothing else to catch it — and
  // for a self-hoster the failure is data going to the wrong backend, not an error.
  const unsetEnv: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of ["CLAUDE_PLUGIN_OPTION_ENDPOINT", "BRAINS_ENDPOINT", "BRAINS_INGEST_URL", "BRAINS_INBOX_URL"]) {
    delete unsetEnv[key];
  }
  const defaultCapture = join(temp, "default-payloads.jsonl");
  const defaultUrls = join(temp, "default-urls.txt");
  const defaultRun = spawnSync("bash", [join(PLUGIN, "hooks", "brains-turn.sh")], {
    input: JSON.stringify({ session_id: "claude-session", prompt: "hello" }),
    env: {
      ...unsetEnv,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CLAUDE_PLUGIN_OPTION_TOKEN: "endpoint-probe-token",
      BRAINS_API_TOKEN: "",
      BRAINS_INBOX_TOKEN: "",
      BRAINS_STATE_DIR: join(temp, "state-default"),
      CAPTURE_FILE: defaultCapture,
      URL_FILE: defaultUrls,
    },
  });
  assert(defaultRun.status === 0, `unconfigured-endpoint turn hook failed: ${defaultRun.stderr.toString()}`);
  assert(await waitForFile(defaultCapture), "unconfigured-endpoint ingest POST did not complete");
  const defaultRequestedUrls = readFileSync(defaultUrls, "utf8").trim().split("\n");
  assert(
    defaultRequestedUrls.includes(`${CLAUDE_ENDPOINT}/ingest/claude`),
    `with no endpoint configured, capture must POST to ${CLAUDE_ENDPOINT} — got ${defaultRequestedUrls.join(", ")}`,
  );
  assert(
    defaultRequestedUrls.some((url) => url.startsWith(`${CLAUDE_ENDPOINT}/inbox/claude`)),
    `with no endpoint configured, the inbox must poll ${CLAUDE_ENDPOINT} — got ${defaultRequestedUrls.join(", ")}`,
  );

  // The middle branch of the same chain: no plugin option, but BRAINS_ENDPOINT set in the
  // environment. This is the ONLY lever a self-hosting Codex user has — Codex runs these same
  // scripts and has no userConfig mechanism, so `--config` is not available to it and the README
  // sends Codex users here instead. Untested until now: the two cases above cover the option branch
  // and the literal fallback, which between them would stay green even if the env branch were
  // dropped entirely and every Codex capture silently went to production.
  const envCapture = join(temp, "env-payloads.jsonl");
  const envUrls = join(temp, "env-urls.txt");
  const envRun = spawnSync("bash", [join(PLUGIN, "hooks", "brains-turn.sh")], {
    input: JSON.stringify({ session_id: "claude-session", prompt: "hello" }),
    env: {
      ...unsetEnv,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      CLAUDE_PLUGIN_OPTION_TOKEN: "endpoint-probe-token",
      BRAINS_ENDPOINT: HOOK_ENV_ENDPOINT,
      BRAINS_API_TOKEN: "",
      BRAINS_INBOX_TOKEN: "",
      BRAINS_STATE_DIR: join(temp, "state-env"),
      CAPTURE_FILE: envCapture,
      URL_FILE: envUrls,
    },
  });
  assert(envRun.status === 0, `BRAINS_ENDPOINT turn hook failed: ${envRun.stderr.toString()}`);
  assert(await waitForFile(envCapture), "BRAINS_ENDPOINT ingest POST did not complete");
  const envRequestedUrls = readFileSync(envUrls, "utf8").trim().split("\n");
  assert(
    envRequestedUrls.includes(`${HOOK_ENV_ENDPOINT}/ingest/claude`),
    `capture must follow BRAINS_ENDPOINT — got ${envRequestedUrls.join(", ")}`,
  );
  assert(
    envRequestedUrls.some((url) => url.startsWith(`${HOOK_ENV_ENDPOINT}/inbox/claude`)),
    `the inbox must follow BRAINS_ENDPOINT — got ${envRequestedUrls.join(", ")}`,
  );
  assert(
    !envRequestedUrls.some((url) => url.startsWith(CLAUDE_ENDPOINT)),
    `no hook request may reach ${CLAUDE_ENDPOINT} when BRAINS_ENDPOINT is set — got ${envRequestedUrls.join(", ")}`,
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("plugin contract: PASS");
