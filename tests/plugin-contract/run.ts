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
// The qualifier both card surfaces must carry. It scopes capture and the inbox together, because
// they share one credential gate and one delivery mechanism.
const CAPTURE_QUALIFIER = "hook-driven turn-by-turn capture and inbox delivery";

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
const CLAUDE_HOOK_EVENTS: Record<string, string> = {
  SessionStart: "brains-start.sh",
  UserPromptSubmit: "brains-turn.sh",
  Stop: "brains-turn.sh",
  SessionEnd: "brains-end.sh",
  PostToolUseFailure: "brains-tool-error.sh",
};
const CODEX_HOOK_EVENTS: Record<string, string> = {
  SessionStart: "brains-start.sh",
  UserPromptSubmit: "brains-turn.sh",
  Stop: "brains-turn.sh",
  PostToolUse: "brains-tool-error.sh",
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
  "brains hooks so automatic recall, capture, inbox delivery, and error feedback can run.",
  "",
  "For a local checkout under development:",
  "",
  "```sh",
  "claude plugin marketplace add /absolute/path/to/brains-plugins",
  "claude plugin install brains@brains",
  CLAUDE_MCP_LOGIN,
  "```",
].join("\n");

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
function assertHookEventMap(label: string, config: any, expected: Record<string, string>): void {
  const declared = Object.keys(config.hooks ?? {}).sort();
  const wanted = Object.keys(expected).sort();
  assert(
    JSON.stringify(declared) === JSON.stringify(wanted),
    `${label} hook events must be exactly [${wanted.join(", ")}] — got [${declared.join(", ") || "none"}]. `
      + `Adding or removing one is a two-line edit: this JSON and ${label.toUpperCase()}_HOOK_EVENTS.`,
  );
  for (const [event, script] of Object.entries(expected)) {
    const groups = config.hooks[event];
    assert(
      Array.isArray(groups) && groups.length > 0,
      `${label} ${event} declares no matcher groups — an empty array satisfies a key-existence check and runs nothing`,
    );
    const commands = groups
      .flatMap((group: any) => group.hooks ?? [])
      .map((hook: any) => hook.command as string);
    assert(
      commands.length > 0,
      `${label} ${event} declares no commands — an empty array satisfies a key-existence check and runs nothing`,
    );
    for (const command of commands) {
      assert(
        command.includes(`hooks/${script}`),
        `${label} ${event} must run ${script} — got: ${command}`,
      );
    }
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
const turnHook = readFileSync(join(PLUGIN, "hooks", "brains-turn.sh"), "utf8");
const inboxHook = readFileSync(join(PLUGIN, "hooks", "lib", "brains-inbox.sh"), "utf8");
const readme = readFileSync(join(ROOT, "README.md"), "utf8");
const core = readFileSync(join(PLUGIN, "core.md"), "utf8");
const writeSkill = readFileSync(join(PLUGIN, "skills", "brains-write", "SKILL.md"), "utf8");
const buildSkill = readFileSync(join(PLUGIN, "skills", "brains-build", "SKILL.md"), "utf8");
const capabilityManifest = readJson(join(PLUGIN, "generated", "capability-catalog.json"));
const coreNormalized = core.replace(/\s+/g, " ");
const writeSkillNormalized = writeSkill.replace(/\s+/g, " ");

assert(claudeManifest.name === "brains", "Claude manifest name must be brains");
assert(codexManifest.name === "brains", "Codex manifest name must be brains");
assert(claudeManifest.version === codexManifest.version, "client manifests must stay version-aligned");
assert(claudeManifest.hooks === "./hooks/claude-hooks.json", "Claude must select its event map explicitly");
assert(codexManifest.skills === "./skills/", "Codex must use the shared skills directory");
assert(codexManifest.mcpServers === "./.mcp.json", "Codex must load its MCP declaration");
assert(!("hooks" in codexManifest), "Codex should discover the default hooks/hooks.json");

// Capture AND the inbox are hook-driven and credential-gated: brains-turn.sh and
// brains-inbox.sh carry the same `[ -z "$TOKEN" ] && exit 0`, and neither runs in claude.ai chat.
// Both card surfaces said "hook-driven turn-by-turn capture, a server-driven inbox" — qualifying
// only the first half, which left the inbox asserted flat in exactly the two configurations where
// it is off. Nothing pinned these descriptions, which is how three of them drifted into agreement
// on the same false claim in the first place; pin the qualifier so the next drift fails loudly.
for (const [surface, description] of [
  ["Claude manifest", claudeManifest.description],
  ["Claude marketplace card", claudeMarketplace.plugins[0]?.description],
] as const) {
  assert(
    typeof description === "string" && description.includes(CAPTURE_QUALIFIER),
    `${surface} description must qualify capture AND the inbox as "${CAPTURE_QUALIFIER}" — both are hook-driven and both are off without a credential`,
  );
  assert(
    !/(?<!hook-driven )(?:a |the )?server-driven inbox/i.test(description),
    `${surface} description must not advertise the inbox unqualified — it shares capture's credential gate and runs in no web chat`,
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
};
assert(Array.isArray(capabilityManifest.artifacts), "manifest must carry an artifacts array");
assert(
  capabilityManifest.artifacts.map((a: any) => a.capability_id).sort().join(",") ===
    "brains-features,integration-actions",
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
  assert(
    !/automation_secret|adminPool|handler_source|telegram_push|grant_token/.test(body!),
    `public skill leaked an internal-only capability: ${entry.artifact_path}`,
  );
}

// Eager skill-metadata budget (skills authoring & discovery contract §3): the
// CLI hosts preload EVERY installed skill's name + description for routing, so
// skill count is a budget, not a detail. Education was deliberately rendered
// INTO brains-build rather than added as an eighth skill; pin the count so a
// future addition is a reviewed act, not a silent one.
const skillDirs = readdirSync(join(PLUGIN, "skills"), { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
assert(
  skillDirs.join(",") ===
    "brains-agenda,brains-build,brains-feedback,brains-integrations,brains-nudges,brains-read,brains-write",
  `skill set changed (${skillDirs.join(", ")}) — see the eager-budget rule before adding one`,
);

// Cross-skill trigger disjointness (§1: triggers must be mutually distinct).
// This lives HERE and not in the monorepo generator on purpose: the sibling
// SKILL.md bodies exist only in this repo, so an assertion there would have no
// inputs and pass forever. brains-build's rendered description samples authored
// trigger phrases verbatim; none may be claimed by another skill's description.
const SAMPLED_TRIGGERS = ["track a list of", "every morning do", "build me a deck"];
const buildDescription = /^description:\s*(.+)$/m.exec(buildSkill)?.[1] ?? "";
for (const trigger of SAMPLED_TRIGGERS) {
  assert(
    buildDescription.toLowerCase().includes(trigger),
    `brains-build no longer samples the trigger "${trigger}" — regenerate from the monorepo catalog`,
  );
  for (const dir of skillDirs) {
    if (dir === "brains-build") continue;
    const sibling = readFileSync(join(PLUGIN, "skills", dir, "SKILL.md"), "utf8");
    const siblingDescription = /^description:\s*(.+)$/m.exec(sibling)?.[1] ?? "";
    assert(
      !siblingDescription.toLowerCase().includes(trigger),
      `trigger "${trigger}" is claimed by both brains-build and ${dir} — routing collision`,
    );
  }
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

// This README is the install instructions for anyone who finds the repo directly rather than the
// guided page, so it has to carry the same contract. It documented `export BRAINS_API_TOKEN` as the
// way in long after that stopped being able to work, which is exactly the drift these pin.
// Resolve both delimiters before slicing. A missing end heading yields -1, and
// `slice(start, -1)` would silently widen the region to almost the whole file —
// every assertion below would then pass while reading the wrong section.
const codexStart = readme.indexOf("## Install for Codex");
const claudeStart = readme.indexOf("## Install for Claude Code");
assert(codexStart >= 0, "README must document a Codex install");
assert(claudeStart >= 0, "README must document a Claude Code install");
assert(
  claudeStart > codexStart,
  "README's Claude Code section must follow the Codex one — the Codex checks below slice between them",
);
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
const optionalHeadingIndex = codexReadme.indexOf("### Optional");
assert(optionalHeadingIndex > 0, "README must keep the optional capture/inbox section for Codex");
const codexPrerequisites = codexReadme.slice(0, optionalHeadingIndex);
for (const forbidden of ["BRAINS_API_TOKEN", "launchctl setenv"]) {
  assert(
    !codexPrerequisites.includes(forbidden),
    `README must not present \`${forbidden}\` as a Codex install prerequisite — it belongs under the optional capture/inbox section`,
  );
}
assert(
  codexReadme.slice(optionalHeadingIndex).includes("launchctl setenv"),
  "README's optional section must keep the desktop launchctl path — a desktop app inherits no shell export",
);

// Same treatment for the Claude Code section. It is sliced between its own heading and the
// claude.ai web heading — NOT the shared layout section. The web section sits between the two,
// and letting it fall inside this slice would subject it to the Claude-Code-specific rules below
// (the version-floor bans, the `bash -n` sweep) while leaving its own claims unpinned. Resolve
// both delimiters first, for the same reason as above.
const sharedLayoutStart = readme.indexOf("## Shared layout");
const webStart = readme.indexOf(CLAUDE_WEB_HEADING);
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
const claudeOptionalIndex = claudeReadme.indexOf(CLAUDE_OPTIONAL_HEADING);
assert(claudeOptionalIndex > 0, "README must keep the optional capture/inbox section for Claude Code");
// The whole pre-Optional region is pinned verbatim. Enumerated bans on this region kept losing to
// paraphrase — "prompts during installation for the brains token" walked past a token ban, and
// "or a newer release" walked past a version-floor ban — so the approved copy is the contract.
// Changing it is a deliberate two-line diff: this constant and the README together.
assert(
  normalizeRegion(claudeReadme.slice(0, claudeOptionalIndex)) === CLAUDE_INSTALL_REGION,
  "README's Claude install region must match the approved copy exactly (README and CLAUDE_INSTALL_REGION must be edited together)",
);
// Below the heading "token" is legitimate — it IS the token section — so pinning the copy would
// freeze docs that should stay editable. Ban only version floors here. Best-effort against
// paraphrase; the region pin above carries the strong guarantee.
const claudeOptionalBody = claudeReadme.slice(claudeOptionalIndex);
assert(
  !CLAUDE_VERSION_SHAPE.test(claudeOptionalBody),
  "README's Claude token section must not name a version — no Claude Code floor is verifiable",
);
assert(
  !CLAUDE_FLOOR_VOCAB.test(claudeOptionalBody),
  "README's Claude token section must not imply a minimum Claude Code version",
);
// Every published command gets copied verbatim by someone, so parse them instead of trusting a
// read-through: `--config token=<your token>` looked fine in review and is a syntax error in both
// bash and zsh, because the angle brackets are redirections. Checking the whole block also covers
// the three-command install, where a broken line would strand a user mid-install.
const claudeShellBlocks = [...claudeReadme.matchAll(/```sh\n([\s\S]*?)```/g)].map((match) => match[1]);
assert(claudeShellBlocks.length > 0, "README's Claude install must keep its shell blocks");
// Sweep EVERY shell block in the file, not just this slice. Region-scoped sweeping silently lost
// coverage the moment a block moved: promoting "Self-hosting" past "## Shared layout" took its
// `--config endpoint=…` example outside every slice checked here, and the six Codex blocks were
// never swept at all — so the one command a self-hoster copies, and the whole Codex install, were
// unchecked. The syntax of a published command does not depend on which section it sits in.
//
// Matching more than ```sh is deliberate: a ```bash fence would have slipped past a bare `sh`
// pattern with the comment above still claiming full coverage. The fence-language allow-list below
// closes the same hole from the other side, so a shell dialect nobody thought of fails loudly
// rather than going unswept.
const SWEPT_SHELL_FENCES = ["sh", "bash", "shell", "zsh"];
const fenceLanguages = [...readme.matchAll(/^```([a-zA-Z0-9_-]+)$/gm)].map((match) => match[1]);
for (const language of fenceLanguages) {
  assert(
    !/sh$/i.test(language) || SWEPT_SHELL_FENCES.includes(language.toLowerCase()),
    `README uses a shell fence this sweep does not parse: \`\`\`${language} — add it to SWEPT_SHELL_FENCES`,
  );
}
const readmeShellBlocks = [
  ...readme.matchAll(new RegExp("```(?:" + SWEPT_SHELL_FENCES.join("|") + ")\\n([\\s\\S]*?)```", "g")),
].map((match) => match[1]);
assert(
  readmeShellBlocks.length >= claudeShellBlocks.length,
  "the whole-file shell sweep must cover at least the Claude install's blocks",
);
for (const block of readmeShellBlocks) {
  const parsed = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
  assert(
    parsed.status === 0,
    `README shell block is not valid shell:\n${block}\n${parsed.stderr}`,
  );
}

// A plugin from the header era is registered but logged out, so the migration path has to say
// both halves: update, then sign in.
const claudeMigrationIndex = claudeReadme.indexOf("### Already installed?");
assert(claudeMigrationIndex > 0, "README must tell an existing Claude Code install how to migrate");
const claudeMigration = claudeReadme.slice(claudeMigrationIndex);
assert(
  claudeMigration.includes("claude plugin update brains"),
  "README's Claude migration must update the plugin",
);
assert(
  claudeMigration.includes(CLAUDE_MCP_LOGIN),
  "README's Claude migration must sign in — updating alone leaves the user logged out",
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
