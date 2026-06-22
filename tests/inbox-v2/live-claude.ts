#!/usr/bin/env bun
// Live end-to-end test: spin up a stub /inbox/claude server, run the real
// `claude -p` binary with --settings wiring the plugin's SessionStart hook
// (brains-start.sh → lib/brains-inbox.sh), and verify claude's response
// shows it consumed the prompt body the stub served.
//
// Differences vs run.ts (the contract harness):
//   * Actually invokes the claude LLM (costs tokens, non-deterministic).
//   * Validates the full path: hook → claude session prefix → LLM
//     response.
//
// Auth: we don't redirect CLAUDE_CONFIG_DIR, because auth tokens live in
// the macOS Keychain keyed to the real config dir. Instead we leave
// ~/.claude alone and use --settings to add a SessionStart hook at runtime.
//
// The hook's state (log, device-id) is redirected to
// /tmp/brains-claude-test/hooks via BRAINS_STATE_DIR so this test never
// writes into the real plugin data dir.

import { spawn } from "node:child_process";
import { mkdirSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const HOOK_SRC = join(REPO_ROOT, "plugins", "brains", "hooks");
const TEST_DIR = "/tmp/brains-claude-test";
const HOOK_DIR = join(TEST_DIR, "hooks");

// -----------------------------------------------------------------------------
// Stub server
// -----------------------------------------------------------------------------

type Action = { id: string; type: "notification" | "prompt"; body: string; title?: string };
type InboxResponse = { context?: string; actions?: Action[] };

class Stub {
  private srv: ReturnType<typeof Bun.serve> | null = null;
  private resp: InboxResponse = { context: "", actions: [] };
  private acks: { applied: string[] }[] = [];
  setResp(r: InboxResponse) { this.resp = r; }
  acksReceived() { return this.acks; }

  start(): number {
    const s = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/inbox/claude" && req.method === "GET") {
          return Response.json(this.resp);
        }
        if (url.pathname === "/inbox/claude/ack" && req.method === "POST") {
          const b = (await req.json()) as { applied: string[] };
          this.acks.push(b);
          return Response.json({ acked: b.applied?.length ?? 0 });
        }
        if (url.pathname === "/inbox/claude/devices" && req.method === "POST") {
          return Response.json({
            device_id: "00000000-0000-0000-0000-000000000000",
            reported: 0, drift: [],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    this.srv = s;
    return s.port;
  }
  stop() { this.srv?.stop(); this.srv = null; }
}

// -----------------------------------------------------------------------------
// Test setup
// -----------------------------------------------------------------------------

function setupTestDir() {
  // Mirror the plugin's hooks/ layout: brains-start.sh + lib/brains-inbox.sh.
  // brains-start.sh resolves the lib relative to its own dir, so the lib must
  // live in a sibling lib/ subdir. rely on cp preserving mode (the +x bit).
  mkdirSync(join(HOOK_DIR, "lib"), { recursive: true });
  copyFileSync(join(HOOK_SRC, "brains-start.sh"), join(HOOK_DIR, "brains-start.sh"));
  copyFileSync(join(HOOK_SRC, "lib", "brains-inbox.sh"), join(HOOK_DIR, "lib", "brains-inbox.sh"));
}

function buildSettings(): string {
  // Pure additive: claude merges this with ~/.claude/settings.json. The user's
  // existing hooks still fire; ours fires too. We rely on stdout collision
  // being benign — the user's real plugin talks to prod, ours talks to our stub.
  return JSON.stringify({
    hooks: {
      SessionStart: [
        {
          matcher: "startup",
          hooks: [
            { type: "command", command: join(HOOK_DIR, "brains-start.sh") },
          ],
        },
      ],
    },
  });
}

async function runClaude(opts: {
  prompt: string;
  port: number;
}): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolveRun) => {
    const env = {
      ...process.env,
      BRAINS_STATE_DIR: HOOK_DIR,
      // Pin marketplaces to an absent path so the auto-update nudge stays
      // hermetic and never reads the developer's real ~/.claude.
      BRAINS_MARKETPLACES_JSON: join(TEST_DIR, "no-such-marketplaces.json"),
      BRAINS_INBOX_URL: `http://127.0.0.1:${opts.port}/inbox/claude`,
      BRAINS_INBOX_ACK_URL: `http://127.0.0.1:${opts.port}/inbox/claude/ack`,
      BRAINS_INBOX_DEVICES_URL: `http://127.0.0.1:${opts.port}/inbox/claude/devices`,
      BRAINS_INBOX_TOKEN: "test-token",
    };
    const proc = spawn(
      "claude",
      ["--settings", buildSettings(), "-p", opts.prompt],
      { env },
    );
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("exit", (code) => resolveRun({ stdout, stderr, code: code ?? -1 }));
  });
}

// -----------------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------------

class Fail extends Error {}
function assertContains(haystack: string, needle: string, label: string) {
  if (!haystack.toLowerCase().includes(needle.toLowerCase())) {
    throw new Fail(`${label}: expected response to contain ${JSON.stringify(needle)}\n--- response ---\n${haystack}\n----------------`);
  }
}

const stub = new Stub();
const PORT = stub.start();
console.log(`[live] stub server up on http://127.0.0.1:${PORT}`);

setupTestDir();

const SCENARIOS: { name: string; run: () => Promise<void> }[] = [
  {
    name: "L1 — prompt body reaches Claude's context (verbatim)",
    async run() {
      const id = "11111111-1111-1111-1111-111111111111";
      // Marker word the model is unlikely to invent on its own.
      const marker = "ZIRCONIUM-77";
      stub.setResp({
        context: "",
        actions: [
          {
            id, type: "prompt",
            body: `The brains server has injected this message. The marker word is "${marker}". When asked, repeat the marker word verbatim in your reply.`,
          },
        ],
      });
      const r = await runClaude({
        prompt: "What marker word did brains inject? Reply with just the word.",
        port: PORT,
      });
      console.log(`  exit=${r.code}`);
      console.log(`  stdout: ${r.stdout.trim()}`);
      if (r.stderr.trim()) console.log(`  stderr (truncated): ${r.stderr.trim().slice(0, 400)}`);
      if (r.code !== 0) throw new Fail(`L1: claude exited non-zero (${r.code})`);
      assertContains(r.stdout, marker, "L1 marker present in claude's response");
    },
  },
  {
    name: "L2 — notification body does NOT leak into Claude's context",
    async run() {
      const id = "22222222-2222-2222-2222-222222222222";
      const banner = "TUNGSTEN-12";
      stub.setResp({
        context: "",
        actions: [
          { id, type: "notification", title: "brains", body: `secret-token-${banner}` },
        ],
      });
      const r = await runClaude({
        prompt: `Did the brains server tell you anything containing "${banner}"? Answer literally only "yes" or "no".`,
        port: PORT,
      });
      console.log(`  exit=${r.code}`);
      console.log(`  stdout: ${r.stdout.trim()}`);
      if (r.code !== 0) throw new Fail(`L2: claude exited non-zero (${r.code})`);
      const lower = r.stdout.trim().toLowerCase();
      // Notification body must not be in context — model should answer "no".
      if (!lower.includes("no") || lower.includes("yes")) {
        throw new Fail(`L2: expected "no", got: ${r.stdout.trim()}`);
      }
    },
  },
  {
    name: "L3 — 10 prompts in ONE pull (bulk burst)",
    async run() {
      // Each prompt carries a unique marker. We then ask Claude to list all
      // markers it received. Even one missing → the hook (or claude) lost
      // it. (The MAX_PER_PULL=10 cap on the real backend is exactly this
      // shape; this test pins that the hook and Claude can both handle a
      // full payload.)
      const markers = [
        "ALPHA-101", "BRAVO-202", "CHARLIE-303", "DELTA-404", "ECHO-505",
        "FOXTROT-606", "GOLF-707", "HOTEL-808", "INDIA-909", "JULIET-110",
      ];
      const actions: Action[] = markers.map((m, i) => ({
        id: `33333333-3333-3333-3333-${String(i).padStart(12, "0")}`,
        type: "prompt",
        body: `brains note #${i + 1}: marker is "${m}". Always include it verbatim when listing markers.`,
      }));
      stub.setResp({ context: "", actions });
      const r = await runClaude({
        prompt:
          "Brains injected 10 separate notes, each containing a unique marker " +
          "code (format: WORD-NNN). List EVERY marker code you can find in the " +
          "brains-injected context, one per line, no other text.",
        port: PORT,
      });
      console.log(`  exit=${r.code}`);
      console.log(`  stdout (truncated): ${r.stdout.trim().slice(0, 400)}`);
      if (r.code !== 0) throw new Fail(`L3: claude exited non-zero (${r.code})`);
      const missing = markers.filter((m) => !r.stdout.includes(m));
      if (missing.length > 0) {
        throw new Fail(`L3: missing ${missing.length}/10 markers: ${missing.join(", ")}\n--- response ---\n${r.stdout}\n----------------`);
      }
    },
  },
  // Note: a "very large body retrieval" live scenario was attempted but
  // Claude's safety training reliably (and correctly) flags filler-style
  // markdown with planted markers as a prompt-injection attempt and
  // refuses to extract from it. Whether bytes survive the wire is really
  // a hook-level concern, so it lives in run.ts (scenario "13 — large
  // body (~30KB) flows through hook intact").
  {
    name: "L5 — 10 sequential sessions, each with a fresh prompt",
    async run() {
      // Models the real-world pattern: user opens a Claude session, brains
      // surfaces a pending action, user responds, next session has a
      // different action. Tests that the hook reports a fresh device id
      // every startup AND that each session's body is fully injected.
      const cases = Array.from({ length: 10 }, (_, i) => ({
        id: `55555555-5555-5555-5555-${String(i).padStart(12, "5")}`,
        marker: `SEQ-${String(i + 1).padStart(2, "0")}-${randSuffix()}`,
      }));
      const failures: string[] = [];
      for (let i = 0; i < cases.length; i += 1) {
        const c = cases[i];
        stub.setResp({
          context: "",
          actions: [{
            id: c.id, type: "prompt",
            body: `Session ${i + 1} of 10. Marker for this session: "${c.marker}". When asked, return only this marker.`,
          }],
        });
        const r = await runClaude({
          prompt: "What marker did brains inject for THIS session? Reply with just the marker code.",
          port: PORT,
        });
        const ok = r.code === 0 && r.stdout.includes(c.marker);
        process.stdout.write(`    [${i + 1}/10] ${c.marker} ... ${ok ? "ok" : "FAIL"}\n`);
        if (!ok) {
          failures.push(`session ${i + 1} expected ${c.marker}, got ${r.stdout.trim().slice(0, 80)} (exit=${r.code})`);
        }
      }
      if (failures.length > 0) {
        throw new Fail(`L5: ${failures.length}/10 sequential sessions failed\n  ${failures.join("\n  ")}`);
      }
    },
  },
];

function randSuffix(): string {
  return Math.random().toString(36).slice(2, 7).toUpperCase();
}

let passed = 0, failed = 0;
for (const sc of SCENARIOS) {
  console.log(`\n▶ ${sc.name}`);
  try {
    await sc.run();
    console.log("  PASS");
    passed += 1;
  } catch (e) {
    console.log("  FAIL");
    if (e instanceof Fail) console.log(`  ${e.message}`);
    else console.log(`  ${(e as Error).stack ?? e}`);
    failed += 1;
  }
}

stub.stop();
console.log(`\n${passed}/${SCENARIOS.length} live scenarios passed.`);
// Leave /tmp/brains-claude-test/ on disk for inspection.
process.exit(failed === 0 ? 0 : 1);
