#!/usr/bin/env bun

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const PLUGIN = join(ROOT, "plugins", "brains");

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
const turnHook = readFileSync(join(PLUGIN, "hooks", "brains-turn.sh"), "utf8");
const core = readFileSync(join(PLUGIN, "core.md"), "utf8");
const writeSkill = readFileSync(join(PLUGIN, "skills", "brains-write", "SKILL.md"), "utf8");
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
assert(codexMarketplace.plugins[0]?.policy?.authentication === "ON_INSTALL", "Codex auth policy missing");

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

assert(codexMcp.mcpServers?.brains?.type === "http", "Codex brains MCP must be HTTP");
assert(codexMcp.mcpServers?.brains?.url === "https://mcp.mybrains.ai/mcp", "Codex brains MCP URL mismatch");
assert(codexMcp.mcpServers?.brains?.bearer_token_env_var === "BRAINS_API_TOKEN", "Codex token env mismatch");

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

// This public plugin is a sixth model-visible copy of the act contract, outside
// the monorepo's ACT_CONTRACT_COPIES gate. Mirror its four load-bearing rules
// here so a future compaction cannot drift independently again.
assert(writeSkillNormalized.includes("install_id=<…> action_name=<…> input={…}"), "structured action tuple missing");
assert(writeSkillNormalized.includes("call `get_page` on the selected result"), "action discovery must resolve frontmatter");
assert(
  writeSkillNormalized.includes("`requires_confirmation` absent from the frontmatter") &&
    writeSkillNormalized.includes("the outcome cannot be predicted") &&
    writeSkillNormalized.includes("Never assume it will draft"),
  "absent requires_confirmation must remain unknown rather than predict a draft",
);
assert(
  writeSkillNormalized.includes('**`requires_confirmation: false`** → executes inline now, returns') &&
    writeSkillNormalized.includes('{kind:"auto_executed", result, action_record_id}'),
  "requires_confirmation:false must be documented as already executed",
);
assert(writeSkillNormalized.includes("there is no source-enum fallback"), "legacy source-enum fallback must stay removed");
assert(!writeSkillNormalized.includes("Fall back to the legacy source-enum"), "stale legacy fallback pointer must not return");
assert(writeSkillNormalized.includes("action_record_id"), "auto-executed result must expose action_record_id");
assert(!writeSkillNormalized.includes("audit_id"), "stale auto-executed audit_id field must not return");
assert(
  writeSkillNormalized.includes('**`kind:"rate_limited"`** → nothing ran and no upstream call was made'),
  "rate-limited actions must be documented as not attempted",
);
assert(
  writeSkillNormalized.includes("whether an outbound write reached the provider is **unknown**"),
  "auto-failed actions must preserve unknown-outcome guidance",
);
assert(writeSkillNormalized.includes("Never blind-retry"), "auto-failed external writes must not be blindly retried");
assert(writeSkillNormalized.includes("The out-of-band surfaces hold the confirmation capability"), "approval boundary missing");
assert(writeSkillNormalized.includes("Do **not** call `confirm_action`"), "agent self-confirm prohibition missing");
assert(writeSkillNormalized.includes("call `discard_action`"), "agent-side draft discard path missing");
assert(!writeSkillNormalized.includes("never call `discard_action`"), "draft discard guidance must remain actionable");
assert(writeSkillNormalized.includes("remains approvable"), "expired drafts must not be described as inert");
assert(writeSkillNormalized.includes("A bare `source` drafts nothing"), "source-only action fallback must stay prohibited");
assert(!/act_on_integration[^.]{0,200}request=/.test(writeSkillNormalized), "free-form action request must not return");

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
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("plugin contract: PASS");
