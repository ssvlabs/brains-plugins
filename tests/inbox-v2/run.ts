#!/usr/bin/env bun
// Deep test harness for the brains plugin's inbox engine + the
// /inbox/claude server contract.
//
// Strategy: spin up a stub HTTP server that impersonates the brains MCP
// /inbox/claude endpoint, point the hook at it via BRAINS_INBOX_URL, run
// the hook in a clean per-scenario state dir, capture stdout + the acks
// the hook posts, then assert on each.
//
// All scenarios drive the plugin runtime's inbox engine
// (plugins/brains/hooks/lib/brains-inbox.sh): 01–24 cover the
// shared notification/prompt/context/ack contract; 25–31 cover the
// plugin-only surface (semver report + drift / auto-update nudge).
//
// This avoids needing the full brains backend
// running. It tests exactly the contract between the server and the
// hook, which is the inbox engine's only public surface.
//
// Run:   bun run tests/inbox-v2/run.ts
// Exits: 0 = all green, non-zero = at least one failure

import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
// Every scenario drives the plugin runtime's inbox engine — the shared
// dispatcher the plugin ships at hooks/lib/brains-inbox.sh. It reports the
// plugin semver and surfaces the drift-aware update nudge on top of the core
// notification/prompt/context/ack contract.
const PLUGIN_HOOK_PATH = join(
  REPO_ROOT, "plugins", "brains", "hooks", "lib", "brains-inbox.sh",
);
const PLUGIN_JSON_PATH = join(
  REPO_ROOT, "plugins", "brains", ".claude-plugin", "plugin.json",
);

type Action = {
  id: string;
  type: "notification" | "prompt";
  body: string;
  title?: string;
};
type ContextItem = { kind: string; key: string };
type InboxResponse = { context?: string; context_items?: ContextItem[]; actions?: Action[] };

type AckRecord = {
  applied: string[];
  context_received?: ContextItem[];
  mode: string;
  session_id: string;
  device_id?: string;
};

// -----------------------------------------------------------------------------
// Stub server
// -----------------------------------------------------------------------------

class StubServer {
  private server: ReturnType<typeof Bun.serve> | null = null;
  // Plan: one queued response per (mode) call; tests configure ahead of run.
  // We DO record device-report and ack POSTs for assertions.
  private inboxByMode: Map<string, InboxResponse> = new Map();
  private inboxDelayByMode: Map<string, number> = new Map();
  private acksReceived: AckRecord[] = [];
  private deviceReports: unknown[] = [];
  // Drift the devices-report endpoint echoes back. Default empty = no nudge.
  private deviceDrift: unknown[] = [];

  setInbox(mode: string, resp: InboxResponse) {
    this.inboxByMode.set(mode, resp);
  }
  setInboxDelay(mode: string, ms: number) {
    this.inboxDelayByMode.set(mode, ms);
  }
  setDeviceDrift(drift: unknown[]) {
    this.deviceDrift = drift;
  }
  reset() {
    this.inboxByMode.clear();
    this.inboxDelayByMode.clear();
    this.acksReceived = [];
    this.deviceReports = [];
    this.deviceDrift = [];
  }
  getAcks() { return this.acksReceived; }
  getDeviceReports() { return this.deviceReports; }

  start(): number {
    const srv = Bun.serve({
      port: 0, // random
      fetch: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/inbox/claude" && req.method === "GET") {
          const mode = url.searchParams.get("mode") ?? "startup";
          const delay = this.inboxDelayByMode.get(mode) ?? 0;
          if (delay > 0) await new Promise((r) => setTimeout(r, delay));
          const resp = this.inboxByMode.get(mode) ?? { context: "", actions: [] };
          return new Response(JSON.stringify(resp), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/inbox/claude/ack" && req.method === "POST") {
          const body = (await req.json()) as AckRecord;
          this.acksReceived.push(body);
          return new Response(JSON.stringify({ acked: body.applied?.length ?? 0 }), {
            headers: { "content-type": "application/json" },
          });
        }
        if (url.pathname === "/inbox/claude/devices" && req.method === "POST") {
          const body = await req.json();
          this.deviceReports.push(body);
          return new Response(
            JSON.stringify({
              device_id: "11111111-1111-1111-1111-111111111111",
              reported: 0,
              drift: this.deviceDrift,
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return new Response("not found", { status: 404 });
      },
    });
    this.server = srv;
    return srv.port;
  }
  stop() {
    this.server?.stop();
    this.server = null;
  }
}

// -----------------------------------------------------------------------------
// Scenario runner
// -----------------------------------------------------------------------------

type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

// Run the plugin runtime's inbox engine (plugins/brains). It reads
// its semver from .claude-plugin/plugin.json and its sections from core.md
// (both resolved relative to the script), so we only need to isolate its
// state dir. State (device-id cache, log) lands in BRAINS_STATE_DIR.
async function runPluginHook(opts: {
  mode: "startup" | "prompt" | "stop";
  session: string;
  port: number;
  stateDir: string;
  marketplacesJson?: string;
}): Promise<RunResult> {
  return new Promise((resolveRun) => {
    const env = {
      ...process.env,
      BRAINS_STATE_DIR: opts.stateDir,
      // Pin the marketplaces file so auto-update detection is hermetic and
      // never reads the developer's real ~/.claude. Default to an absent path
      // (= unknown → no nudge, no auto_update field).
      BRAINS_MARKETPLACES_JSON:
        opts.marketplacesJson ?? join(opts.stateDir, "no-such-marketplaces.json"),
      BRAINS_INBOX_URL: `http://127.0.0.1:${opts.port}/inbox/claude`,
      BRAINS_INBOX_ACK_URL: `http://127.0.0.1:${opts.port}/inbox/claude/ack`,
      BRAINS_INBOX_DEVICES_URL: `http://127.0.0.1:${opts.port}/inbox/claude/devices`,
      BRAINS_INBOX_TOKEN: "test-token",
    };
    const proc = spawn("bash", [PLUGIN_HOOK_PATH, opts.mode, opts.session], { env });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => { stdout += d.toString(); });
    proc.stderr.on("data", (d) => { stderr += d.toString(); });
    proc.on("exit", (code) => resolveRun({ stdout, stderr, exitCode: code ?? -1 }));
  });
}

function makeStateDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `brains-plugin-test-${label}-`));
}

// Write a known_marketplaces.json with the "brains" marketplace (the hook's
// off-cache fallback name). `autoUpdate === undefined` writes an entry with no
// autoUpdate key — the "key absent = off" case.
function writeMarketplacesJson(dir: string, autoUpdate: boolean | undefined): string {
  const p = join(dir, "known_marketplaces.json");
  const entry = autoUpdate === undefined ? {} : { autoUpdate };
  writeFileSync(p, JSON.stringify({ brains: entry }, null, 2));
  return p;
}

// -----------------------------------------------------------------------------
// Assertions
// -----------------------------------------------------------------------------

class AssertionError extends Error {}

function assertContains(haystack: string, needle: string, label: string): void {
  if (!haystack.includes(needle)) {
    throw new AssertionError(
      `${label}: expected output to contain ${JSON.stringify(needle)}\n--- actual ---\n${haystack}\n--------------`,
    );
  }
}
function assertNotContains(haystack: string, needle: string, label: string): void {
  if (haystack.includes(needle)) {
    throw new AssertionError(
      `${label}: expected output to NOT contain ${JSON.stringify(needle)}\n--- actual ---\n${haystack}\n--------------`,
    );
  }
}
function assertEqual<T>(actual: T, expected: T, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new AssertionError(`${label}: expected ${e}, got ${a}`);
  }
}

// Wait briefly for the background ack POST to land. The hook fires the ack
// in a backgrounded curl ( ... ) & — we sleep just long enough for it to
// hit the loopback stub, but cap so a missing ack still fails fast.
async function waitForAcks(server: StubServer, expected: number, label: string): Promise<void> {
  const deadline = Date.now() + 1500;
  while (Date.now() < deadline && server.getAcks().reduce((n, a) => n + (a.applied?.length ?? 0), 0) < expected) {
    await new Promise((r) => setTimeout(r, 30));
  }
  const got = server.getAcks().reduce((n, a) => n + (a.applied?.length ?? 0), 0);
  if (got !== expected) {
    throw new AssertionError(`${label}: expected ${expected} acked ids, got ${got} (acks=${JSON.stringify(server.getAcks())})`);
  }
}

// -----------------------------------------------------------------------------
// Scenarios
// -----------------------------------------------------------------------------

type Scenario = {
  name: string;
  run(server: StubServer): Promise<void>;
};

const SCENARIOS: Scenario[] = [
  {
    name: "01 — notification fires banner, auto-acks, no context injection",
    async run(server) {
      const id = "00000001-0000-0000-0000-000000000001";
      server.setInbox("startup", {
        context: "",
        actions: [{ id, type: "notification", title: "brains", body: "Hello world" }],
      });
      const dir = makeStateDir("01");
      const r = await runPluginHook({ mode: "startup", session: "s01", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "01 exit code");
      assertNotContains(r.stdout, "Hello world", "01 notification body must NOT appear in stdout");
      assertNotContains(r.stdout, id, "01 notification id must NOT appear in stdout");
      await waitForAcks(server, 1, "01");
      assertEqual(server.getAcks()[0]?.applied, [id], "01 ack contains the action id");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "02 — prompt body injected verbatim with id markers, NOT auto-acked",
    async run(server) {
      const id = "00000002-0000-0000-0000-000000000002";
      const body = "Please ask the user about X and then call mcp__brains__ack_inbox_action.";
      server.setInbox("startup", { context: "", actions: [{ id, type: "prompt", body }] });
      const dir = makeStateDir("02");
      const r = await runPluginHook({ mode: "startup", session: "s02", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "02 exit code");
      assertContains(r.stdout, body, "02 prompt body verbatim");
      assertContains(r.stdout, `<!-- brains:prompt id=${id} -->`, "02 start marker with id");
      assertContains(r.stdout, `<!-- brains:prompt end -->`, "02 end marker");
      // Hook must NOT have posted an ack — server-authored body owns ack.
      await new Promise((r) => setTimeout(r, 300));
      assertEqual(server.getAcks().length, 0, "02 hook did NOT auto-ack the prompt");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "03 — context field is emitted to stdout (separate from actions)",
    async run(server) {
      server.setInbox("startup", {
        context: "<!-- brains:context v=1 -->\nbe terse\n<!-- end -->",
        actions: [],
      });
      const dir = makeStateDir("03");
      const r = await runPluginHook({ mode: "startup", session: "s03", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "03 exit code");
      assertContains(r.stdout, "be terse", "03 context body in stdout");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "04 — mode=prompt: notification delivered, prompt filtered out",
    async run(server) {
      const nid = "00000004-0000-0000-0000-000000000004";
      const pid = "00000004-0000-0000-0000-00000000000A";
      server.setInbox("prompt", {
        context: "",
        actions: [
          { id: nid, type: "notification", title: "brains", body: "ping" },
          { id: pid, type: "prompt", body: "should not appear in mode=prompt" },
        ],
      });
      const dir = makeStateDir("04");
      const r = await runPluginHook({ mode: "prompt", session: "s04", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "04 exit code");
      assertNotContains(r.stdout, "should not appear", "04 prompt filtered out in mode=prompt");
      assertNotContains(r.stdout, "ping", "04 notification body still not in stdout");
      // Notification still acked. Prompt was filtered before dispatch, so
      // no ack for it — good (server keeps it for next startup).
      await waitForAcks(server, 1, "04");
      assertEqual(server.getAcks()[0]?.applied, [nid], "04 only notification id acked");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "05 — mode=stop: stdout suppressed; banner side-effect fires; auto-acks",
    async run(server) {
      const id = "00000005-0000-0000-0000-000000000005";
      server.setInbox("stop", {
        context: "should-not-leak-context",
        actions: [{ id, type: "notification", body: "stop-ping" }],
      });
      const dir = makeStateDir("05");
      const r = await runPluginHook({ mode: "stop", session: "s05", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "05 exit code");
      assertEqual(r.stdout, "", "05 stdout suppressed in mode=stop");
      await waitForAcks(server, 1, "05");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "06 — mixed: 1 notification + 1 prompt → both handled correctly",
    async run(server) {
      const nid = "00000006-0000-0000-0000-00000000000B";
      const pid = "00000006-0000-0000-0000-00000000000C";
      server.setInbox("startup", {
        context: "",
        actions: [
          { id: nid, type: "notification", body: "banner-only" },
          { id: pid, type: "prompt", body: "do-the-thing" },
        ],
      });
      const dir = makeStateDir("06");
      const r = await runPluginHook({ mode: "startup", session: "s06", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "06 exit code");
      assertNotContains(r.stdout, "banner-only", "06 notification absent from stdout");
      assertContains(r.stdout, "do-the-thing", "06 prompt body in stdout");
      assertContains(r.stdout, `<!-- brains:prompt id=${pid} -->`, "06 prompt marker");
      await waitForAcks(server, 1, "06");
      assertEqual(server.getAcks()[0]?.applied, [nid], "06 only the notification was acked");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "07 — empty inbox is a no-op; no acks; no stdout",
    async run(server) {
      server.setInbox("startup", { context: "", actions: [] });
      const dir = makeStateDir("07");
      const r = await runPluginHook({ mode: "startup", session: "s07", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "07 exit code");
      assertEqual(r.stdout, "", "07 stdout empty");
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(server.getAcks().length, 0, "07 no acks");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "08 — malformed payload (no body) is silently ignored",
    async run(server) {
      const id = "00000008-0000-0000-0000-000000000008";
      // Server-side validator drops these, but the hook should also be
      // robust if a future server bug surfaces a row without `body`.
      server.setInbox("startup", {
        context: "",
        actions: [{ id, type: "notification" } as Action], // missing body
      });
      const dir = makeStateDir("08");
      const r = await runPluginHook({ mode: "startup", session: "s08", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "08 exit code");
      assertEqual(r.stdout, "", "08 stdout empty");
      await new Promise((r) => setTimeout(r, 200));
      // No body → hook shouldn't have shown banner OR acked.
      assertEqual(server.getAcks().length, 0, "08 no acks");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "09 — unknown type is silently skipped",
    async run(server) {
      const id = "00000009-0000-0000-0000-000000000009";
      server.setInbox("startup", {
        context: "",
        actions: [{ id, type: "patch_claude_md" as Action["type"], body: "legacy" }],
      });
      const dir = makeStateDir("09");
      const r = await runPluginHook({ mode: "startup", session: "s09", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "09 exit code");
      assertEqual(r.stdout, "", "09 stdout empty");
      await new Promise((r) => setTimeout(r, 200));
      assertEqual(server.getAcks().length, 0, "09 no acks");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "10 — device report sent on startup w/ client+client_type; not on prompt/stop",
    async run(server) {
      server.setInbox("startup", { context: "", actions: [] });
      server.setInbox("prompt",  { context: "", actions: [] });
      server.setInbox("stop",    { context: "", actions: [] });

      const dir = makeStateDir("10");
      await runPluginHook({ mode: "startup", session: "s10", port: PORT, stateDir: dir });
      assertEqual(server.getDeviceReports().length, 1, "10 device report on startup");
      const report = server.getDeviceReports()[0] as Record<string, unknown>;
      assertEqual(report.client, "claude", "10 report carries client=claude");
      assertEqual(report.client_type, "cli", "10 report carries client_type=cli");

      await runPluginHook({ mode: "prompt", session: "s10", port: PORT, stateDir: dir });
      assertEqual(server.getDeviceReports().length, 1, "10 no extra report on prompt");

      await runPluginHook({ mode: "stop", session: "s10", port: PORT, stateDir: dir });
      assertEqual(server.getDeviceReports().length, 1, "10 no extra report on stop");

      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "11 — prompt body containing macOS shell metachars is NOT evaluated",
    async run(server) {
      const id = "00000011-0000-0000-0000-000000000011";
      const body = "Run `rm -rf /tmp/ZZZ_should_not_exist`; also $HOME and $(date)";
      server.setInbox("startup", { context: "", actions: [{ id, type: "prompt", body }] });
      const dir = makeStateDir("11");
      const r = await runPluginHook({ mode: "startup", session: "s11", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "11 exit code");
      // Body must appear *literally* in stdout — backticks, $HOME, etc.
      assertContains(r.stdout, "rm -rf /tmp/ZZZ_should_not_exist", "11 backtick text literal");
      assertContains(r.stdout, "$HOME and $(date)", "11 dollar/parens literal");
      // And no rogue evaluation happened (we'd see Date or home paths if so).
      assertNotContains(r.stdout, "/Users/", "11 no $HOME expansion");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "13 — large body (~30KB) flows through hook intact",
    async run(server) {
      const id = "00000013-0000-0000-0000-000000000013";
      // Build a body just under the server's 32KB cap. The hook is a
      // dumb pipe — it must pass every byte through, no truncation.
      const filler = "abcdefghijklmnopqrstuvwxyz0123456789-";
      const body =
        "START_MARKER " +
        filler.repeat(800) +   // ~30KB
        " END_MARKER";
      server.setInbox("startup", { context: "", actions: [{ id, type: "prompt", body }] });
      const dir = makeStateDir("13");
      const r = await runPluginHook({ mode: "startup", session: "s13", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "13 exit code");
      assertContains(r.stdout, "START_MARKER", "13 leading marker present");
      assertContains(r.stdout, "END_MARKER", "13 trailing marker present");
      // Spot-check ~10KB and ~20KB into the body to make sure the middle
      // didn't get clipped.
      const middle1 = body.slice(10000, 10080);
      const middle2 = body.slice(20000, 20080);
      assertContains(r.stdout, middle1, "13 middle slice @ 10KB present");
      assertContains(r.stdout, middle2, "13 middle slice @ 20KB present");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "14 — bulk burst: 10 prompts in one pull, all reach stdout, none acked",
    async run(server) {
      const actions: Action[] = Array.from({ length: 10 }, (_, i) => ({
        id: `00000014-0000-0000-0000-${String(i).padStart(12, "0")}`,
        type: "prompt",
        body: `BULK-MARKER-${i + 1}`,
      }));
      server.setInbox("startup", { context: "", actions });
      const dir = makeStateDir("14");
      const r = await runPluginHook({ mode: "startup", session: "s14", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "14 exit code");
      for (let i = 1; i <= 10; i += 1) {
        assertContains(r.stdout, `BULK-MARKER-${i}`, `14 marker ${i} present`);
        assertContains(r.stdout, actions[i - 1].id, `14 action id ${i} present in marker`);
      }
      // No prompts should be auto-acked.
      await new Promise((r) => setTimeout(r, 300));
      assertEqual(server.getAcks().length, 0, "14 hook did not auto-ack any prompt");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "15 — bulk burst: 10 notifications in one pull, all auto-acked in single POST",
    async run(server) {
      const ids = Array.from({ length: 10 }, (_, i) =>
        `00000015-0000-0000-0000-${String(i).padStart(12, "0")}`,
      );
      server.setInbox("startup", {
        context: "",
        actions: ids.map((id, i) => ({
          id, type: "notification", title: "brains", body: `notif-${i}`,
        })),
      });
      const dir = makeStateDir("15");
      const r = await runPluginHook({ mode: "startup", session: "s15", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "15 exit code");
      // None of the bodies should leak into stdout.
      for (let i = 0; i < 10; i += 1) {
        assertNotContains(r.stdout, `notif-${i}`, `15 notification ${i} body absent`);
      }
      await waitForAcks(server, 10, "15");
      // Hook batches all auto-acks into a single POST.
      assertEqual(server.getAcks().length, 1, "15 single batched ack POST");
      const acked = new Set(server.getAcks()[0]?.applied ?? []);
      for (const id of ids) {
        if (!acked.has(id)) throw new AssertionError(`15 missing ack for ${id}`);
      }
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "16 — sequential pulls: prompt re-surfaces every session until it's acked",
    async run(server) {
      const id = "00000016-0000-0000-0000-000000000016";
      server.setInbox("startup", {
        context: "", actions: [{ id, type: "prompt", body: "PERSISTENT" }],
      });
      // 5 sequential session-starts. The stub doesn't track acks (the real
      // server does), so it keeps serving the same row — we want the hook
      // to keep injecting it, and to keep NOT auto-acking it.
      const dir = makeStateDir("16");
      for (let i = 0; i < 5; i += 1) {
        const r = await runPluginHook({ mode: "startup", session: `s16-${i}`, port: PORT, stateDir: dir });
        assertEqual(r.exitCode, 0, `16 session ${i} exit code`);
        assertContains(r.stdout, "PERSISTENT", `16 session ${i} body present`);
      }
      // No acks ever — hook never auto-acks prompts.
      await new Promise((r) => setTimeout(r, 300));
      assertEqual(server.getAcks().length, 0, "16 no acks across 5 sessions");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "17 — slow server (>3s) doesn't deadlock the startup hook",
    async run(server) {
      const id = "00000017-0000-0000-0000-000000000017";
      // The hook sets a 3s curl timeout for startup. We make the server
      // sleep ~5s before responding — the hook should give up cleanly,
      // exit 0, no stdout, no ack.
      server.setInboxDelay("startup", 5000);
      server.setInbox("startup", {
        context: "", actions: [{ id, type: "prompt", body: "SLOW" }],
      });
      const dir = makeStateDir("17");
      const start = Date.now();
      const r = await runPluginHook({ mode: "startup", session: "s17", port: PORT, stateDir: dir });
      const elapsed = Date.now() - start;
      server.setInboxDelay("startup", 0);
      assertEqual(r.exitCode, 0, "17 hook still exits 0 on timeout");
      if (elapsed >= 5000) throw new AssertionError(`17 hook waited ${elapsed}ms — should have aborted ~3s`);
      assertNotContains(r.stdout, "SLOW", "17 timed-out body must not appear");
      assertEqual(server.getAcks().length, 0, "17 no acks on timeout");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "18 — context_items: server emits, hook echoes back in ack POST",
    async run(server) {
      const items: ContextItem[] = [
        { kind: "demo_kind_a", key: "7" },
        { kind: "demo_kind_b", key: "2026-05-08" },
      ];
      server.setInbox("startup", {
        context: "<!-- bp v=7 -->\nbe terse\n<!-- end -->",
        context_items: items,
        actions: [],
      });
      const dir = makeStateDir("18");
      const r = await runPluginHook({ mode: "startup", session: "s18", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "18 exit code");
      assertContains(r.stdout, "be terse", "18 context surfaced to stdout");
      // Hook should have posted ONE ack carrying both items, even though no
      // actions were applied.
      await new Promise((r) => setTimeout(r, 400));
      assertEqual(server.getAcks().length, 1, "18 single ack POST for context-only");
      const ackCtx = server.getAcks()[0]?.context_received ?? [];
      assertEqual(ackCtx.length, 2, "18 two context_received items");
      assertEqual(
        ackCtx.map((x) => `${x.kind}:${x.key}`).sort(),
        ["demo_kind_a:7", "demo_kind_b:2026-05-08"],
        "18 context items round-trip",
      );
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "19 — context with no context_items: hook posts no ack (nothing to report)",
    async run(server) {
      server.setInbox("startup", {
        context: "<!-- bp -->\nlegacy ambient block, no manifest\n<!-- end -->",
        // context_items intentionally omitted (legacy server)
        actions: [],
      });
      const dir = makeStateDir("19");
      const r = await runPluginHook({ mode: "startup", session: "s19", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "19 exit code");
      assertContains(r.stdout, "legacy ambient block", "19 context still surfaced");
      await new Promise((r) => setTimeout(r, 300));
      assertEqual(server.getAcks().length, 0, "19 no ack when nothing to report");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "20 — mixed pull: notification + prompt + context_items → one ack carries all",
    async run(server) {
      const nid = "00000020-0000-0000-0000-000000000020";
      const pid = "00000020-0000-0000-0000-00000000002A";
      server.setInbox("startup", {
        context: "<!-- bp -->\nrules\n<!-- end -->",
        context_items: [{ kind: "demo_kind_a", key: "9" }],
        actions: [
          { id: nid, type: "notification", body: "ping" },
          { id: pid, type: "prompt",       body: "do-the-thing" },
        ],
      });
      const dir = makeStateDir("20");
      const r = await runPluginHook({ mode: "startup", session: "s20", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "20 exit code");
      assertContains(r.stdout, "do-the-thing", "20 prompt body in stdout");
      assertContains(r.stdout, "rules", "20 ambient context in stdout");
      await waitForAcks(server, 1, "20");
      assertEqual(server.getAcks().length, 1, "20 single ack POST for everything");
      assertEqual(server.getAcks()[0]?.applied, [nid], "20 only notification id acked");
      assertEqual(
        server.getAcks()[0]?.context_received,
        [{ kind: "demo_kind_a", key: "9" }],
        "20 context item also in same ack",
      );
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "21 — 5 consecutive sessions, each acks its own context_items independently",
    async run(server) {
      const dir = makeStateDir("21");
      for (let i = 0; i < 5; i += 1) {
        // Same kind, different key per session — simulates daily morning brief.
        const key = `2026-05-${String(8 + i).padStart(2, "0")}`;
        server.setInbox("startup", {
          context: `briefing for ${key}`,
          context_items: [{ kind: "demo_kind_b", key }],
          actions: [],
        });
        const r = await runPluginHook({ mode: "startup", session: `s21-${i}`, port: PORT, stateDir: dir });
        assertEqual(r.exitCode, 0, `21 session ${i} exit code`);
      }
      await new Promise((r) => setTimeout(r, 600));
      assertEqual(server.getAcks().length, 5, "21 five separate ack POSTs across sessions");
      const keys = server.getAcks()
        .flatMap((a) => a.context_received ?? [])
        .map((x) => x.key)
        .sort();
      assertEqual(
        keys,
        ["2026-05-08", "2026-05-09", "2026-05-10", "2026-05-11", "2026-05-12"],
        "21 each session reports its own day",
      );
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "22 — tiny prompt body (single char) round-trips through hook",
    async run(server) {
      const id = "00000022-0000-0000-0000-000000000022";
      server.setInbox("startup", { context: "", actions: [{ id, type: "prompt", body: "?" }] });
      const dir = makeStateDir("22");
      const r = await runPluginHook({ mode: "startup", session: "s22", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "22 exit code");
      assertContains(r.stdout, `<!-- brains:prompt id=${id} -->`, "22 marker present");
      // The body is just "?" — make sure it's there inside the wrapper.
      assertContains(r.stdout, "begin message", "22 wrapper begin marker");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "23 — sequential pulls with growing prompt sizes (1KB → 5KB → 10KB → 20KB → 30KB)",
    async run(server) {
      const dir = makeStateDir("23");
      const sizes = [1, 5, 10, 20, 30];
      for (let i = 0; i < sizes.length; i += 1) {
        const id = `00000023-0000-0000-0000-${String(i).padStart(12, "3")}`;
        const body =
          `MARK-${sizes[i]}KB-START ` +
          "x".repeat(sizes[i] * 1024 - 40) +
          ` MARK-${sizes[i]}KB-END`;
        server.setInbox("startup", { context: "", actions: [{ id, type: "prompt", body }] });
        const r = await runPluginHook({ mode: "startup", session: `s23-${i}`, port: PORT, stateDir: dir });
        assertEqual(r.exitCode, 0, `23 session ${i} exit code`);
        assertContains(r.stdout, `MARK-${sizes[i]}KB-START`, `23 ${sizes[i]}KB start marker`);
        assertContains(r.stdout, `MARK-${sizes[i]}KB-END`,   `23 ${sizes[i]}KB end marker`);
      }
      // None of the prompts are auto-acked by the hook — only notifications
      // and context items would generate acks, neither was emitted.
      await new Promise((r) => setTimeout(r, 300));
      assertEqual(server.getAcks().length, 0, "23 prompts never auto-acked");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "24 — bursty pull: 5 prompts + 5 notifications + 2 context items → one ack with all",
    async run(server) {
      const promptIds = Array.from({ length: 5 }, (_, i) =>
        `00000024-0000-0000-0000-${String(i).padStart(12, "P")}`.replace(/P/g, "p"),
      );
      const notifIds = Array.from({ length: 5 }, (_, i) =>
        `00000024-0000-0000-0000-${String(i).padStart(12, "N")}`.replace(/N/g, "n"),
      );
      server.setInbox("startup", {
        context: "<!-- bp -->\nrules\n<!-- end -->",
        context_items: [
          { kind: "demo_kind_a", key: "11" },
          { kind: "demo_kind_b", key: "2026-05-08" },
        ],
        actions: [
          ...promptIds.map((id, i) => ({
            id, type: "prompt" as const, body: `BULK24-PROMPT-${i + 1}`,
          })),
          ...notifIds.map((id, i) => ({
            id, type: "notification" as const, body: `BULK24-NOTIF-${i + 1}`,
          })),
        ],
      });
      const dir = makeStateDir("24");
      const r = await runPluginHook({ mode: "startup", session: "s24", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "24 exit code");
      // All five prompt bodies should appear in stdout.
      for (let i = 1; i <= 5; i += 1) {
        assertContains(r.stdout, `BULK24-PROMPT-${i}`, `24 prompt ${i} in stdout`);
      }
      // None of the notification bodies should leak.
      for (let i = 1; i <= 5; i += 1) {
        assertNotContains(r.stdout, `BULK24-NOTIF-${i}`, `24 notif ${i} body absent`);
      }
      await waitForAcks(server, 5, "24");
      assertEqual(server.getAcks().length, 1, "24 single ack POST for the burst");
      const ack = server.getAcks()[0];
      // 5 notifications acked.
      assertEqual((ack?.applied ?? []).length, 5, "24 five notification acks");
      // 2 context items acked.
      assertEqual((ack?.context_received ?? []).length, 2, "24 two context items in ack");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "12 — multibyte UTF-8 body survives banner + injection",
    async run(server) {
      const nid = "00000012-0000-0000-0000-000000000012";
      const pid = "00000012-0000-0000-0000-00000000001A";
      const ntxt = "héllo wörld — 你好 🌐";
      const ptxt = "אהלן — שלום 🙂 מ-brains";
      server.setInbox("startup", {
        context: "",
        actions: [
          { id: nid, type: "notification", body: ntxt },
          { id: pid, type: "prompt", body: ptxt },
        ],
      });
      const dir = makeStateDir("12");
      const r = await runPluginHook({ mode: "startup", session: "s12", port: PORT, stateDir: dir });
      assertEqual(r.exitCode, 0, "12 exit code");
      assertContains(r.stdout, ptxt, "12 prompt body utf-8");
      assertNotContains(r.stdout, ntxt, "12 notification body absent (banner only)");
      await waitForAcks(server, 1, "12");
      rmSync(dir, { recursive: true, force: true });
    },
  },
  {
    name: "25 — plugin hook reports plugin_version + core marker; no drift → no nudge",
    async run(server) {
      server.setInbox("startup", { context: "", actions: [] });
      server.setDeviceDrift([]); // server reports the device is current
      const stateDir = makeStateDir("25");
      const r = await runPluginHook({ mode: "startup", session: "s25", port: PORT, stateDir });
      assertEqual(r.exitCode, 0, "25 exit code");

      // The report carries the manifest semver verbatim.
      assertEqual(server.getDeviceReports().length, 1, "25 one device report on startup");
      const report = server.getDeviceReports()[0] as Record<string, unknown>;
      const manifest = JSON.parse(readFileSync(PLUGIN_JSON_PATH, "utf8")) as { version: string };
      assertEqual(report.plugin_version, manifest.version, "25 plugin_version matches manifest");

      // Sections come from the shipped core.md — the release bumps it to v4.
      const sections = (report.sections ?? []) as Array<{ name: string; version: number }>;
      const core = sections.find((s) => s.name === "core");
      assertEqual(core?.version, 4, "25 core marker reported at v4");

      // No drift → no update nudge in stdout.
      assertNotContains(r.stdout, "brains:update", "25 no update nudge when device is current");
      rmSync(stateDir, { recursive: true, force: true });
    },
  },
  {
    name: "26 — drift in devices response → ONE update nudge line on startup",
    async run(server) {
      server.setInbox("startup", { context: "", actions: [] });
      server.setDeviceDrift([{ section: "core", installed: 2, canonical: 3 }]);
      const stateDir = makeStateDir("26");
      const r = await runPluginHook({ mode: "startup", session: "s26", port: PORT, stateDir });
      assertEqual(r.exitCode, 0, "26 exit code");
      assertContains(r.stdout, "<!-- brains:update -->", "26 nudge open marker");
      assertContains(r.stdout, "<!-- /brains:update -->", "26 nudge close marker");
      assertContains(r.stdout, "core v2 -> v3", "26 version arrow from drift");
      assertContains(
        r.stdout,
        "claude plugin marketplace update brains && claude plugin update brains",
        "26 nudge carries the update command",
      );
      // Exactly one nudge line.
      const count = r.stdout.split("<!-- brains:update -->").length - 1;
      assertEqual(count, 1, "26 exactly one nudge line");
      rmSync(stateDir, { recursive: true, force: true });
    },
  },
  {
    name: "27 — drift nudge fires only on startup, never on prompt/stop",
    async run(server) {
      server.setInbox("startup", { context: "", actions: [] });
      server.setInbox("prompt",  { context: "", actions: [] });
      server.setInbox("stop",    { context: "", actions: [] });
      server.setDeviceDrift([{ section: "core", installed: 2, canonical: 3 }]);
      const stateDir = makeStateDir("27");

      const rp = await runPluginHook({ mode: "prompt", session: "s27", port: PORT, stateDir });
      assertEqual(rp.exitCode, 0, "27 prompt exit code");
      assertNotContains(rp.stdout, "brains:update", "27 no nudge in prompt mode");
      // prompt mode does not report the device either.
      assertEqual(server.getDeviceReports().length, 0, "27 no device report on prompt");

      const rs = await runPluginHook({ mode: "stop", session: "s27", port: PORT, stateDir });
      assertEqual(rs.exitCode, 0, "27 stop exit code");
      assertEqual(rs.stdout, "", "27 stop suppresses stdout entirely");
      rmSync(stateDir, { recursive: true, force: true });
    },
  },
  {
    name: "28 — drift with ONLY non-core sections → NO nudge (no false positive)",
    async run(server) {
      server.setInbox("startup", { context: "", actions: [] });
      // Plugin devices never carry the legacy brains:install / brains:claude-md
      // sections, so the server reports them as perpetually behind. The hook
      // must NOT nudge on those — only on a `core` drift entry.
      server.setDeviceDrift([
        { section: "brains:claude-md", installed: 0, canonical: 5 },
        { section: "brains:install", installed: 0, canonical: 2 },
      ]);
      const stateDir = makeStateDir("28");
      const r = await runPluginHook({ mode: "startup", session: "s28", port: PORT, stateDir });
      assertEqual(r.exitCode, 0, "28 exit code");
      assertNotContains(r.stdout, "brains:update", "28 no nudge marker for non-core drift");
      assertNotContains(r.stdout, "update available", "28 no nudge text for non-core drift");
      rmSync(stateDir, { recursive: true, force: true });
    },
  },
  {
    name: "29 — auto-update OFF → nudge ONCE + report auto_update=false; 2nd run silent",
    async run(server) {
      server.setInbox("startup", { context: "", actions: [] });
      const stateDir = makeStateDir("29");
      const mp = writeMarketplacesJson(stateDir, false); // brains.autoUpdate=false

      const r1 = await runPluginHook({
        mode: "startup", session: "s29a", port: PORT, stateDir, marketplacesJson: mp,
      });
      assertEqual(r1.exitCode, 0, "29 first-run exit code");
      assertContains(r1.stdout, "<!-- brains:autoupdate -->", "29 nudge open marker");
      assertContains(r1.stdout, "<!-- /brains:autoupdate -->", "29 nudge close marker");
      assertContains(r1.stdout, ".brains.autoUpdate = true", "29 nudge names the marketplace jq path");
      // Report carries the flag as a real boolean false.
      const report = server.getDeviceReports()[0] as Record<string, unknown>;
      assertEqual(report.auto_update, false, "29 report auto_update=false when flag off");
      // Marker written so it never fires again on this device.
      if (!existsSync(join(stateDir, "autoupd-nudged"))) {
        throw new AssertionError("29 expected autoupd-nudged marker file to be written");
      }

      // Second startup, same STATE_DIR → marker present → no nudge.
      const r2 = await runPluginHook({
        mode: "startup", session: "s29b", port: PORT, stateDir, marketplacesJson: mp,
      });
      assertEqual(r2.exitCode, 0, "29 second-run exit code");
      assertNotContains(r2.stdout, "brains:autoupdate", "29 nudge fires only once per device");
      rmSync(stateDir, { recursive: true, force: true });
    },
  },
  {
    name: "30 — auto-update ON → no nudge + report auto_update=true",
    async run(server) {
      server.setInbox("startup", { context: "", actions: [] });
      const stateDir = makeStateDir("30");
      const mp = writeMarketplacesJson(stateDir, true); // brains.autoUpdate=true
      const r = await runPluginHook({
        mode: "startup", session: "s30", port: PORT, stateDir, marketplacesJson: mp,
      });
      assertEqual(r.exitCode, 0, "30 exit code");
      assertNotContains(r.stdout, "brains:autoupdate", "30 no nudge when auto-update is on");
      const report = server.getDeviceReports()[0] as Record<string, unknown>;
      assertEqual(report.auto_update, true, "30 report auto_update=true when flag on");
      // No marker written when we didn't nudge.
      if (existsSync(join(stateDir, "autoupd-nudged"))) {
        throw new AssertionError("30 marker must NOT be written when auto-update is on");
      }
      rmSync(stateDir, { recursive: true, force: true });
    },
  },
  {
    name: "31 — marketplaces file missing → no nudge + report omits auto_update",
    async run(server) {
      server.setInbox("startup", { context: "", actions: [] });
      const stateDir = makeStateDir("31");
      // Point at a path that does not exist (unknown state).
      const mp = join(stateDir, "definitely-absent.json");
      const r = await runPluginHook({
        mode: "startup", session: "s31", port: PORT, stateDir, marketplacesJson: mp,
      });
      assertEqual(r.exitCode, 0, "31 exit code");
      assertNotContains(r.stdout, "brains:autoupdate", "31 no nudge when state unknown");
      const report = server.getDeviceReports()[0] as Record<string, unknown>;
      assertEqual(report.auto_update, undefined, "31 auto_update omitted when file missing");
      if (existsSync(join(stateDir, "autoupd-nudged"))) {
        throw new AssertionError("31 marker must NOT be written when state is unknown");
      }
      rmSync(stateDir, { recursive: true, force: true });
    },
  },
];

// -----------------------------------------------------------------------------
// Driver
// -----------------------------------------------------------------------------

const server = new StubServer();
const PORT = server.start();
console.log(`[harness] stub server up on http://127.0.0.1:${PORT}`);

let failed = 0;
let passed = 0;
for (const sc of SCENARIOS) {
  server.reset();
  process.stdout.write(`▶ ${sc.name} ... `);
  try {
    await sc.run(server);
    console.log("PASS");
    passed += 1;
  } catch (e) {
    console.log("FAIL");
    if (e instanceof AssertionError) {
      console.log(`  ${e.message}`);
    } else {
      console.log(`  ${(e as Error).stack ?? e}`);
    }
    failed += 1;
  }
}

server.stop();
console.log(`\n${passed} passed, ${failed} failed (${SCENARIOS.length} total)`);
process.exit(failed === 0 ? 0 : 1);
