#!/usr/bin/env bun
// Does Claude actually follow through on an injected "ask the user before
// proceeding" body when the user opens with a generic prompt? Or does it
// just answer the user's prompt and silently drop the brains content?
//
// Runs the same scenario N times against `claude -p` to measure how
// consistent the follow-through is.

import { spawn } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const HOOK_SRC = join(REPO_ROOT, "plugins", "brains", "hooks");
const TEST_DIR = "/tmp/brains-claude-followthrough";
const HOOK_DIR = join(TEST_DIR, "hooks");
const RUNS = 5;

// Mirror the plugin's hooks/ layout: brains-start.sh + lib/brains-inbox.sh.
mkdirSync(join(HOOK_DIR, "lib"), { recursive: true });
copyFileSync(join(HOOK_SRC, "brains-start.sh"), join(HOOK_DIR, "brains-start.sh"));
copyFileSync(join(HOOK_SRC, "lib", "brains-inbox.sh"), join(HOOK_DIR, "lib", "brains-inbox.sh"));

type Action = { id: string; type: "notification" | "prompt"; body: string };
let RESP: { context?: string; actions?: Action[] } = { context: "", actions: [] };

const srv = Bun.serve({
  port: 0,
  fetch: async (req) => {
    const url = new URL(req.url);
    if (url.pathname === "/inbox/claude" && req.method === "GET") return Response.json(RESP);
    if (url.pathname === "/inbox/claude/ack" && req.method === "POST") return Response.json({ acked: 0 });
    if (url.pathname === "/inbox/claude/devices" && req.method === "POST") {
      return Response.json({ device_id: "00000000-0000-0000-0000-000000000000", reported: 0, drift: [] });
    }
    return new Response("not found", { status: 404 });
  },
});
const PORT = srv.port;

const SETTINGS = JSON.stringify({
  hooks: {
    SessionStart: [{
      matcher: "startup",
      hooks: [{ type: "command", command: join(HOOK_DIR, "brains-start.sh") }],
    }],
  },
});

function runClaude(prompt: string): Promise<string> {
  return new Promise((res) => {
    const proc = spawn("claude", ["--settings", SETTINGS, "-p", prompt], {
      env: {
        ...process.env,
        BRAINS_STATE_DIR: HOOK_DIR,
        BRAINS_MARKETPLACES_JSON: join(TEST_DIR, "no-such-marketplaces.json"),
        BRAINS_INBOX_URL: `http://127.0.0.1:${PORT}/inbox/claude`,
        BRAINS_INBOX_ACK_URL: `http://127.0.0.1:${PORT}/inbox/claude/ack`,
        BRAINS_INBOX_DEVICES_URL: `http://127.0.0.1:${PORT}/inbox/claude/devices`,
        BRAINS_INBOX_TOKEN: "test-token",
      },
    });
    let out = "";
    proc.stdout.on("data", (d) => { out += d.toString(); });
    proc.on("exit", () => res(out));
  });
}

// The injected body — realistic brains-authored update asking for approval.
const BODY = `## Update CLAUDE.md plan-shape section

Brains noticed the user's local CLAUDE.md doesn't have the canonical
'Plan / agenda response shape' section under the brains memory layer.
Adding it makes "what's my plan today?" answers consistent.

**Procedure:**

1. Greet the user briefly.
2. Tell them brains has a pending CLAUDE.md update — adding the plan-shape
   section under the brains memory layer.
3. Ask whether to proceed.
4. If they approve, edit \`~/.claude/CLAUDE.md\` to add the new section
   between markers \`<!-- brains:plan-shape:start -->\` and
   \`<!-- brains:plan-shape:end -->\`.
5. If they decline, do nothing further.

After the user has decided either way, call
\`mcp__brains__ack_inbox_action(id="9f4c2a7b-3e0d-4a18-b6e2-71d5b8e7f102",
decision="approved"|"declined")\`.
`;

RESP = {
  context: "",
  actions: [{ id: "9f4c2a7b-3e0d-4a18-b6e2-71d5b8e7f102", type: "prompt", body: BODY }],
};

// User's opening prompt is generic — NOT a question about brains. We're
// measuring whether Claude proactively surfaces the brains ask anyway.
const USER_PROMPT = "hi, let's get started";

console.log(`Running ${RUNS} sessions with the same injected approval-ask body.`);
console.log(`User's first prompt: "${USER_PROMPT}"`);
console.log("");

let surfaced = 0;
let ignored = 0;
let refused = 0;
const results: { run: number; verdict: string; excerpt: string }[] = [];

for (let i = 1; i <= RUNS; i += 1) {
  const out = (await runClaude(USER_PROMPT)).trim();
  const lower = out.toLowerCase();

  // Heuristic verdicts:
  //   refused  — claude flagged injection / safety concerns
  //   surfaced — claude told the user about the pending brains update / asked
  //   ignored  — claude just greeted back, never mentioned brains
  let verdict = "ignored";
  if (lower.includes("injection") || lower.includes("suspicious") || lower.includes("flag")) {
    verdict = "refused";
    refused += 1;
  } else if (lower.includes("brains") || lower.includes("claude.md") || lower.includes("plan-shape") || lower.includes("pending") || lower.includes("update")) {
    verdict = "surfaced";
    surfaced += 1;
  } else {
    ignored += 1;
  }

  const excerpt = out.length > 200 ? out.slice(0, 200) + "…" : out;
  results.push({ run: i, verdict, excerpt });
  console.log(`  [${i}/${RUNS}] ${verdict.padEnd(10)} → ${excerpt.replace(/\n/g, " ")}`);
}

srv.stop();

console.log("\n" + "═".repeat(80));
console.log("Summary");
console.log("═".repeat(80));
console.log(`  surfaced (proactively told the user about the brains update): ${surfaced}/${RUNS}`);
console.log(`  ignored  (just greeted back, no mention of brains):           ${ignored}/${RUNS}`);
console.log(`  refused  (flagged as potential injection):                    ${refused}/${RUNS}`);

if (surfaced === RUNS) {
  console.log("\n✓ Reliable follow-through: every session surfaced the approval ask.");
} else if (ignored > 0 && surfaced > 0) {
  console.log("\n⚠ Inconsistent: the same body produces different behavior across runs.");
  console.log("  This means a v0.2 prompt that requires user approval may be silently");
  console.log("  dropped some fraction of the time when the user's opener is generic.");
}
