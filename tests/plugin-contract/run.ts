#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
const CLAUDE_MCP_URL = "${user_config.endpoint}/mcp";
const CLAUDE_ENDPOINT = "https://mcp.mybrains.ai";
const CLAUDE_LOOPBACK = "127.0.0.1";
const CLAUDE_MCP_KEYS = ["type", "url"];
const CLAUDE_OPTIONAL_HEADING = "### Optional:";

// Approved token copy, pinned verbatim. Hand-written phrasing checks proved both evadable and
// prone to false positives, so the wording itself is the contract; the regex pair further down
// stays only as a backstop.
const CLAUDE_TOKEN_TITLE = "brains API token (optional)";
const CLAUDE_TOKEN_DESCRIPTION =
  "Optional. Enables conversation capture and the inbox, which authenticate separately from the " +
  "MCP server. NOT how the brains tools authenticate — that is `claude mcp login " +
  "plugin:brains:brains`. Find it in your brains account settings; without one, capture and the " +
  "inbox simply stay off.";

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
assert(claudeEvents.includes("PostToolUseFailure"), "Claude failure hook missing");
assert(claudeEvents.includes("SessionEnd"), "Claude session-end hook missing");
assert(codexEvents.includes("PostToolUse"), "Codex tool-result hook missing");
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
// Codex reads that variable from its own process environment at server start and fails hard when
// it is missing, and its presence also switches the OAuth path off entirely — so declaring it
// would both break a plugin install (nothing can set the variable) and block `codex mcp login`.
assert(
  !("bearer_token_env_var" in (codexMcp.mcpServers?.brains ?? {})),
  "Codex brains MCP must not declare bearer_token_env_var — it disables the OAuth login path",
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
// Pin the interpolation, not a resolved URL: hard-coding production here would silently ignore a
// user's configured endpoint, and a broken interpolation would resolve to a 404.
assert(
  claudeManifest.mcpServers.brains.url === CLAUDE_MCP_URL,
  `Claude brains MCP URL must be ${CLAUDE_MCP_URL}`,
);
// A stray key INSIDE the server entry passes `claude plugin validate --strict` in total silence —
// only unknown TOP-LEVEL fields warn — so a `scopes` key copied in good faith from the Codex
// declaration next door would look accepted and do nothing. This allow-list is the only check
// that catches it.
assert(
  JSON.stringify(Object.keys(claudeManifest.mcpServers.brains).sort())
    === JSON.stringify([...CLAUDE_MCP_KEYS].sort()),
  `Claude brains MCP may only declare ${CLAUDE_MCP_KEYS.join(", ")} — got ${Object.keys(claudeManifest.mcpServers.brains).join(", ")}`,
);

// The URL above interpolates this, so it can never be missing or empty.
const claudeEndpointConfig = claudeManifest.userConfig?.endpoint ?? {};
assert(
  typeof claudeEndpointConfig.default === "string" && claudeEndpointConfig.default !== "",
  "Claude endpoint config must keep a non-empty default — the MCP URL interpolates it",
);
assert(
  claudeEndpointConfig.default === CLAUDE_ENDPOINT,
  `Claude endpoint default must be ${CLAUDE_ENDPOINT}`,
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

assert(core.includes("<!-- brains:core:start v=5 -->"), "core marker must be v5");
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
]) {
  assert(coreNormalized.includes(signal), `compact core is missing routing/delegation signal: ${signal}`);
}
assert(core.length < 3_000, "always-loaded core must stay below 3,000 characters");

// The public face is generated from the monorepo capability catalog. Verify its
// immutable artifact digest locally; installation never fetches a mutable copy.
assert(capabilityManifest.schema_version === 1, "capability manifest schema mismatch");
assert(capabilityManifest.catalog_schema_version === 1, "catalog schema mismatch");
assert(capabilityManifest.renderer_version === 2, "catalog renderer mismatch");
assert(capabilityManifest.capability_id === "integration-actions", "capability id mismatch");
assert(
  capabilityManifest.artifact_path === "plugins/brains/skills/brains-write/SKILL.md",
  "generated artifact path mismatch",
);
assert(
  capabilityManifest.artifact_sha256 ===
    createHash("sha256").update(writeSkill, "utf8").digest("hex"),
  "generated brains-write artifact digest mismatch",
);
assert(
  !/automation_secret|adminPool|handler_source|telegram_push|grant_token/.test(writeSkill),
  "public skill leaked an internal-only capability",
);

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

// Same treatment for the Claude Code section, sliced between its own heading and the shared
// layout section. Resolve the end delimiter first for the same reason as above.
const sharedLayoutStart = readme.indexOf("## Shared layout");
assert(sharedLayoutStart >= 0, "README must keep the shared layout section — it ends the Claude slice");
assert(
  sharedLayoutStart > claudeStart,
  "README's shared layout section must follow the Claude Code install — the checks below slice between them",
);
const claudeReadme = readme.slice(claudeStart, sharedLayoutStart);
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
for (const block of claudeShellBlocks) {
  const parsed = spawnSync("bash", ["-n"], { input: block, encoding: "utf8" });
  assert(
    parsed.status === 0,
    `README's Claude shell block is not valid shell:\n${block}\n${parsed.stderr}`,
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
// fake `curl` captures only POST bodies (the inbox GET remains a no-op).
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
    '#!/bin/sh\n[ "${SLOW_CAPTURE:-}" = "1" ] && sleep 0.2\nprev=""\nfor arg in "$@"; do\n  if [ "$prev" = "-d" ]; then printf \'%s\\n\' "$arg" >> "$CAPTURE_FILE"; fi\n  prev="$arg"\ndone\n',
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
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("plugin contract: PASS");
