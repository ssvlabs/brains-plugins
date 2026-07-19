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
    '#!/bin/sh\nprev=""\nfor arg in "$@"; do\n  if [ "$prev" = "-d" ]; then printf \'%s\\n\' "$arg" >> "$CAPTURE_FILE"; fi\n  prev="$arg"\ndone\n',
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
  const payloads = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert(payloads.length === 1, "standalone Codex turn hook must POST exactly one ingest payload");
  assert(payloads[0].client === "codex", "standalone Codex payload must identify Codex");
  assert(payloads[0].client_type === "cli", "standalone Codex payload must identify the CLI surface");
  assert(payloads[0].content === "hello", "standalone Codex payload must preserve the prompt");
} finally {
  rmSync(temp, { recursive: true, force: true });
}

console.log("plugin contract: PASS");
