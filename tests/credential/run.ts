#!/usr/bin/env bun
// Contract test for the shared capture-credential resolver
// (plugins/brains/hooks/lib/brains-credential.sh).
//
// Capture used to be off for anyone who never pasted a token, with no request,
// no log line and no error to show for it. The resolver removes that state by
// falling back to the credential the client's own MCP sign-in already stored —
// which means this file is now the thing standing between a stored production
// token and the wrong host. Most of what follows is about that, not about the
// happy path.
//
// Everything runs against local stub servers and fixture stores. Nothing here
// may reach a real endpoint or read a real keychain: the assertions below are
// only meaningful if a developer's own credential can never satisfy them.
//
// Run:   bun run tests/credential/run.ts

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..", "..");
const PLUGIN = join(ROOT, "plugins", "brains");
const LIB = join(PLUGIN, "hooks", "lib", "brains-credential.sh");
const TURN = join(PLUGIN, "hooks", "brains-turn.sh");
const INBOX = join(PLUGIN, "hooks", "lib", "brains-inbox.sh");

let passed = 0;
let failed = 0;
// Written to stderr so progress survives a hang: stdout is buffered when it is a
// pipe, and a suite that stalls would otherwise report nothing at all about where.
const say = (line: string) => process.stderr.write(`${line}\n`);
function check(name: string, condition: unknown, detail = ""): void {
  if (condition) {
    passed++;
    say(`  PASS  ${name}`);
  } else {
    failed++;
    say(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title: string): void {
  say(`\n${title}`);
}

const temp = mkdtempSync(join(tmpdir(), "brains-credential-"));
const stateSeq = { n: 0 };
function freshState(): string {
  const dir = join(temp, `state-${++stateSeq.n}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
const readDirNames = (dir: string): string[] => {
  try { return readdirSync(dir); } catch { return []; }
};
function fixture(name: string, body: unknown): string {
  const path = join(temp, `${name}.json`);
  writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  return path;
}

// Run a snippet with the library sourced. Every invocation starts from a scrubbed
// environment: the three explicit token variables are cleared and the store reads
// are pointed at fixtures, so nothing a developer has configured can leak in.
type ShellOpts = { state?: string; env?: Record<string, string>; };
function sh(script: string, opts: ShellOpts = {}): { stdout: string; stderr: string; status: number } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CLAUDE_PLUGIN_OPTION_TOKEN: "",
    BRAINS_API_TOKEN: "",
    BRAINS_INBOX_TOKEN: "",
    BRAINS_STATE_DIR: opts.state ?? freshState(),
    ...(opts.env ?? {}),
  };
  // A hard per-call ceiling. Nothing here should take seconds, and a test suite that
  // hangs teaches nothing — it has to fail loudly at the call that did it.
  const r = spawnSync("bash", ["-c", `set -u\n. ${JSON.stringify(LIB)}\n${script}`], { env, encoding: "utf8", timeout: 20000 });
  if (r.error || r.signal) say(`  (call took too long or died: ${r.signal ?? r.error})`);
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status ?? -1 };
}

// ---------------------------------------------------------------- stub servers
// Served from a child process — see the header of stubs.js for why that is
// required rather than tidy. Receipts come back through a log file, which is
// also what lets an assertion be made about what a server DID NOT receive.
const PRIMARY = 8991;
const OTHER = 8992;
const TRUNCATOR = 8993;
const HITS = join(temp, "hits.jsonl");
writeFileSync(HITS, "");
const stubProc = spawn(
  process.execPath,
  [join(import.meta.dir, "stubs.js"), HITS, String(PRIMARY), String(OTHER), String(TRUNCATOR)],
  { stdio: "ignore" },
);
{
  // Wait for the stubs to actually listen. Racing the first request against
  // startup yields a connection refusal indistinguishable from a real one.
  const deadline = Date.now() + 10000;
  let up = false;
  while (Date.now() < deadline) {
    if (spawnSync("curl", ["-s", "-o", "/dev/null", "-m", "1", `http://127.0.0.1:${PRIMARY}/ping`]).status === 0) {
      up = true;
      break;
    }
    spawnSync("sleep", ["0.1"]);
  }
  if (!up) {
    say("stub servers never came up");
    process.exit(1);
  }
  writeFileSync(HITS, "");
}
type Hit = { port: number; method: string; path: string; auth: string; bodyLen: number };
const readHits = (): Hit[] =>
  readFileSync(HITS, "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));

const ORIGIN = `http://127.0.0.1:${PRIMARY}`;
const NO_STORE = join(temp, "absent-store.json");

function storeFor(url: string, token = "tok-primary"): string {
  return fixture(`store-${Buffer.from(url + token).toString("hex").slice(0, 12)}`, {
    mcpOAuth: { "plugin:brains:brains|h": { accessToken: token, serverUrl: url, serverName: "plugin:brains:brains" } },
  });
}
const PRIMARY_STORE = storeFor(`${ORIGIN}/mcp`);

// =============================================================== canonicalization
section("origin canonicalization — the comparison every binding decision rests on");
const ORIGIN_CASES: Array<[string, string | null]> = [
  [`https://mcp.mybrains.ai/mcp`, "https://mcp.mybrains.ai"],
  [`https://mcp.mybrains.ai:443/mcp`, "https://mcp.mybrains.ai"],
  [`http://example.com:80/x`, "http://example.com"],
  [`http://example.com:8080/x`, "http://example.com:8080"],
  [`HTTPS://MCP.MyBrains.AI/mcp`, "https://mcp.mybrains.ai"],
  [`https://mcp.mybrains.ai./mcp`, "https://mcp.mybrains.ai"],
  [`https://[::1]:8931/mcp`, "https://[::1]:8931"],
  // Refusals. Each of these could otherwise compare equal to something it is not.
  [`https://user:pw@mcp.mybrains.ai/mcp`, null],   // userinfo is not a host
  [`https://mcp.mybrains.ai:/mcp`, null],          // bare colon is malformed
  [`https://mcp.mybrains.ai:abc/mcp`, null],       // non-numeric port
  [`https://::1:8931/mcp`, null],                  // unbracketed IPv6 is ambiguous
  [`https://mü.example.com/mcp`, null],            // IDNA cannot be done correctly in bash 3.2
  [`ftp://example.com/x`, null],
  [`not-a-url`, null],
  [``, null],
];
for (const [input, expected] of ORIGIN_CASES) {
  const r = sh(`if o=$(brains_origin ${JSON.stringify(input)}); then printf 'OK:%s' "$o"; else printf 'REFUSE'; fi`);
  const want = expected === null ? "REFUSE" : `OK:${expected}`;
  check(`${input || "(empty)"} -> ${expected ?? "refused"}`, r.stdout === want, `got ${r.stdout}`);
}

// =============================================================== selection
section("selection — one candidate or none, never a guess");
function resolveWith(storeFile: string, base = ORIGIN, extra: Record<string, string> = {}) {
  return sh(
    `if brains_resolve_credential ${JSON.stringify(base)}; then printf '%s|%s|%s|%s' "$BRAINS_CRED_STATE" "$BRAINS_CRED_SOURCE" "$BRAINS_CRED_LOCATOR" "$BRAINS_CRED_COUNT";` +
      ` else printf '%s||%s|%s' "$BRAINS_CRED_STATE" "" "$BRAINS_CRED_COUNT"; fi`,
    { env: { BRAINS_CLAUDE_CREDENTIALS_FILE: storeFile, ...extra } },
  );
}
check("single matching entry resolves and is labelled claude-oauth",
  resolveWith(PRIMARY_STORE).stdout === "ok|claude-oauth|plugin:brains:brains|h|1");

// Two entries, same origin, DIFFERENT tokens. Neither store records which account a token belongs
// to, so this is not a preference for caution — the information needed to choose does not exist,
// and capturing into the wrong brain is worse than a 401 because a 401 is detectable.
const twoAccounts = fixture("two-accounts", {
  mcpOAuth: {
    "a|1": { accessToken: "tok-A", serverUrl: `${ORIGIN}/mcp`, serverName: "brains" },
    "b|2": { accessToken: "tok-B", serverUrl: `${ORIGIN}/mcp`, serverName: "plugin:brains:brains" },
  },
});
check("two accounts on one origin resolve to nothing, state indeterminate",
  resolveWith(twoAccounts).stdout === "indeterminate|||2", resolveWith(twoAccounts).stdout);

// Two aliases carrying the SAME token are one credential, not an ambiguity. The second entry also
// spells the port explicitly, so this covers canonicalization feeding selection.
const twoAliases = fixture("two-aliases", {
  mcpOAuth: {
    "a|1": { accessToken: "tok-same", serverUrl: `${ORIGIN}/mcp`, serverName: "brains" },
    "b|2": { accessToken: "tok-same", serverUrl: `http://127.0.0.1:${PRIMARY}/mcp`, serverName: "plugin:brains:brains" },
  },
});
check("two aliases sharing one token collapse and resolve",
  resolveWith(twoAliases).stdout.startsWith("ok|claude-oauth|"), resolveWith(twoAliases).stdout);

// A stage credential must never be sent to production. Name matching would pick this one.
const stageOnly = storeFor("https://brains-mcp.stage.example.com/mcp", "tok-stage");
check("a store with credentials but none for this origin is blocked, not absent",
  resolveWith(stageOnly).stdout === "blocked|||0", resolveWith(stageOnly).stdout);

const truncated = fixture("truncated", '{"mcpOAuth":{"a":{"accessToken":"tok-x","serverUrl":"' + ORIGIN + '/mcp"');
check("an unparseable store document is indeterminate, not a clean absence",
  resolveWith(truncated).stdout === "indeterminate|||0", resolveWith(truncated).stdout);
check("a genuinely absent store IS a definite no-credential", resolveWith(NO_STORE).stdout === "no-credential|||0", resolveWith(NO_STORE).stdout);

section("precedence — explicit configuration always outranks discovery");
check("plugin option outranks a store credential",
  resolveWith(PRIMARY_STORE, ORIGIN, { CLAUDE_PLUGIN_OPTION_TOKEN: "tok-explicit" }).stdout === "ok|plugin-option||0");
check("BRAINS_API_TOKEN outranks a store credential",
  resolveWith(PRIMARY_STORE, ORIGIN, { BRAINS_API_TOKEN: "tok-env" }).stdout === "ok|env||0");
check("the hermetic switch disables discovery entirely",
  resolveWith(PRIMARY_STORE, ORIGIN, { BRAINS_CREDENTIAL_STORE_DISABLED: "1" }).stdout === "no-credential|||0");

// =============================================================== profile isolation
section("profile isolation — a profile with no credential must not read another's");
// This is the failure the resolver's own design review caught: a probe that falls back to the bare
// service name lets an isolated CLAUDE_CONFIG_DIR read the DEFAULT profile's real production token.
// There is no keychain in this test, so the file backend stands in for the same rule: the store
// path is derived from the configured profile and nothing else is tried.
{
  const profile = join(temp, "isolated-profile");
  mkdirSync(profile, { recursive: true });
  // The default profile's store exists and is valid; the isolated profile's does not.
  const r = sh(
    `if brains_resolve_credential ${JSON.stringify(ORIGIN)}; then printf 'RESOLVED:%s' "$BRAINS_CRED_LOCATOR"; else printf 'none'; fi`,
    { env: { CLAUDE_CONFIG_DIR: profile, HOME: temp } },
  );
  check("an isolated profile with no store of its own resolves nothing", r.stdout === "none", r.stdout);
}

// =============================================================== binding
section("binding — a discovered credential goes only to the origin that issued it");
{
  const state = freshState();
  const before = readHits().length;
  const r = sh(
    `brains_resolve_credential ${JSON.stringify(ORIGIN)} || exit 1\n` +
      `brains_request ingest "http://127.0.0.1:${OTHER}/ingest/claude" -X POST -d '{}'\n` +
      `printf 'rc=%s blocked=%s state=%s' "$?" "$BRAINS_HTTP_BLOCKED" "$(brains_health_state ingest \"http://127.0.0.1:${OTHER}/ingest/claude\")"`,
    { state, env: { BRAINS_CLAUDE_CREDENTIALS_FILE: PRIMARY_STORE } },
  );
  check("a cross-origin target is refused", r.stdout === "rc=1 blocked=1 state=blocked", r.stdout);
  // Asserted on the RECEIVING server, not on hook internals: the only claim that matters is that
  // no credential reached a host that never issued one.
  check("the other host received no request at all", readHits().length === before,
    `${readHits().length - before} request(s) reached port ${OTHER}`);
}
{
  const state = freshState();
  const r = sh(
    `brains_resolve_credential ${JSON.stringify(ORIGIN)} || exit 1\n` +
      `brains_request ingest "http://127.0.0.1:${OTHER}/ingest/claude" -X POST -d '{}'\n` +
      `printf 'rc=%s blocked=%s' "$?" "$BRAINS_HTTP_BLOCKED"`,
    { state, env: { BRAINS_API_TOKEN: "tok-explicit" } },
  );
  const reached = readHits().filter((h) => h.port === OTHER && h.auth === "Bearer tok-explicit");
  check("an EXPLICIT credential may cross origins — the user chose that pairing",
    r.stdout === "rc=0 blocked=0" && reached.length === 1, `${r.stdout}, reached=${reached.length}`);
}

// =============================================================== transport truth
section("transport truth — curl's exit status, not its status code");
{
  const state = freshState();
  const r = sh(
    `brains_resolve_credential ${JSON.stringify(`http://127.0.0.1:${TRUNCATOR}`)} || exit 1\n` +
      `brains_request devices "http://127.0.0.1:${TRUNCATOR}/x"\n` +
      `printf 'rc=%s code=%s ok=%s body=[%s] state=%s' "$?" "$BRAINS_HTTP_CODE" "$BRAINS_HTTP_OK" "$BRAINS_HTTP_BODY" "$(brains_health_state devices \"http://127.0.0.1:${TRUNCATOR}/x\")"`,
    { state, env: { BRAINS_API_TOKEN: "tok-explicit" } },
  );
  // The body this server sends is complete, parseable JSON with a device_id in it. A wrapper that
  // trusted %{http_code} would cache that id and mark capture healthy off a transfer that failed.
  check("a 200 whose body transfer dies is NOT healthy",
    r.stdout === "rc=1 code=200 ok=0 body=[] state=unreachable", r.stdout);
}
{
  const state = freshState();
  const r = sh(
    `brains_resolve_credential ${JSON.stringify(ORIGIN)} || exit 1\n` +
      `brains_request inbox "${ORIGIN}/forbidden"\n` +
      `printf 'rc=%s code=%s state=%s' "$?" "$BRAINS_HTTP_CODE" "$(brains_health_state inbox \"${ORIGIN}/forbidden\")"`,
    { state, env: { BRAINS_CLAUDE_CREDENTIALS_FILE: PRIMARY_STORE } },
  );
  check("403 is recorded as rejected, distinct from an empty inbox",
    r.stdout === "rc=1 code=403 state=rejected", r.stdout);
}
{
  const state = freshState();
  const r = sh(
    `brains_resolve_credential ${JSON.stringify(ORIGIN)} || exit 1\n` +
      `brains_request devices "${ORIGIN}/inbox/claude/devices" -X POST -d '{}'\n` +
      `printf '%s' "$BRAINS_HTTP_BODY"`,
    { state, env: { BRAINS_CLAUDE_CREDENTIALS_FILE: PRIMARY_STORE } },
  );
  // The response body has to survive: device identity, drift nudges, inbox context and prompt
  // delivery are all parsed out of one. A universal -o /dev/null would have killed every one of
  // them while leaving status-code assertions green.
  check("a successful response body is preserved for the caller to parse",
    JSON.parse(r.stdout || "{}").device_id === "dev-1", r.stdout);
}

// =============================================================== health ordering
section("health — per capability, ordered by logical generation");
{
  const state = freshState();
  // A backgrounded ingest can complete after a newer request. The stale outcome carries the lower
  // generation and must not win, in either completion order.
  const r = sh(
    `U="${ORIGIN}/ingest/claude"\ng1=$(brains_health_begin ingest "$U"); g2=$(brains_health_begin ingest "$U")\n` +
      `brains_health_apply ingest "$U" "$g2" ok\nbrains_health_apply ingest "$U" "$g1" rejected\n` +
      `printf '%s' "$(brains_health_state ingest "$U")"`,
    { state },
  );
  check("a stale completion cannot overwrite a newer one", r.stdout === "ok", r.stdout);
}
{
  const state = freshState();
  const r = sh(
    `U="${ORIGIN}/ingest/claude"\ng1=$(brains_health_begin ingest "$U"); g2=$(brains_health_begin ingest "$U")\n` +
      `brains_health_apply ingest "$U" "$g1" ok\nbrains_health_apply ingest "$U" "$g2" rejected\n` +
      `printf '%s' "$(brains_health_state ingest "$U")"`,
    { state },
  );
  check("the reverse order also lands on the newer outcome", r.stdout === "rejected", r.stdout);
}
{
  const state = freshState();
  const r = sh(
    `U="${ORIGIN}/inbox/claude"\nfor i in 1 2 3 4 5 6 7 8 9 10; do ( g=$(brains_health_begin inbox "$U"); brains_health_apply inbox "$U" "$g" "w$g" ) & done\nwait\n` +
      // Health lives under a per-endpoint namespace, so glob rather than hardcode it.
      `printf '%s/%s' "$(cat "$BRAINS_STATE_DIR"/health/*/inbox/gen)" "$(cat "$BRAINS_STATE_DIR"/health/*/inbox/applied)"`,
    { state },
  );
  check("ten concurrent writers allocate ten distinct generations with none lost",
    r.stdout === "10/10", r.stdout);
}
{
  // The read-scoped token: GET /inbox needs `read`, POST /ingest needs `write`, so this shape
  // returns 200 and 403 on every single turn. A shared health record would let the inbox's success
  // clear capture's failure, which is precisely the silence this whole change exists to remove.
  const state = freshState();
  const r = sh(
    `brains_resolve_credential ${JSON.stringify(ORIGIN)} || exit 1\n` +
      `brains_request ingest "${ORIGIN}/forbidden" -X POST -d '{}'\n` +
      `brains_request inbox "${ORIGIN}/inbox/claude"\n` +
      `printf 'ingest=%s inbox=%s' "$(brains_health_state ingest "${ORIGIN}/forbidden")" "$(brains_health_state inbox "${ORIGIN}/inbox/claude")"`,
    { state, env: { BRAINS_CLAUDE_CREDENTIALS_FILE: PRIMARY_STORE } },
  );
  check("an inbox success does not clear a capture failure",
    r.stdout === "ingest=rejected inbox=ok", r.stdout);
}

// =============================================================== the signal
section("the off-state signal — once per cause, cleared only by an observed success");
{
  const state = freshState();
  const first = sh(`brains_resolve_endpoints "${ORIGIN}"\nbrains_health_note ingest "$BRAINS_URL_INGEST" no-credential\nbrains_capture_signal`, { state });
  const second = sh(`brains_resolve_endpoints "${ORIGIN}"\nbrains_capture_signal`, { state });
  check("the signal names the single command that fixes it",
    first.stdout.includes("<!-- brains:capture -->") && first.stdout.includes("claude mcp login plugin:brains:brains"),
    first.stdout);
  check("it is raised once, not every session", second.stdout.trim() === "", second.stdout);
}
{
  // One missing credential is ONE problem. Keying the claim by capability produced a second
  // warning for the inbox on the following session, for the same cause.
  const state = freshState();
  sh(`brains_resolve_endpoints "${ORIGIN}"\nbrains_health_note ingest "$BRAINS_URL_INGEST" no-credential\nbrains_health_note inbox "$BRAINS_URL_INBOX" no-credential\nbrains_capture_signal`, { state });
  const next = sh(`brains_resolve_endpoints "${ORIGIN}"\nbrains_capture_signal`, { state });
  check("one missing credential raises one warning, not one per capability",
    next.stdout.trim() === "", next.stdout);
}
{
  const state = freshState();
  sh(`brains_resolve_endpoints "${ORIGIN}"\nbrains_health_note ingest "$BRAINS_URL_INGEST" no-credential\nbrains_capture_signal`, { state });
  const afterOk = sh(
    `brains_resolve_endpoints "${ORIGIN}"\ng=$(brains_health_begin ingest "$BRAINS_URL_INGEST"); brains_health_apply ingest "$BRAINS_URL_INGEST" "$g" ok\nbrains_capture_signal`,
    { state },
  );
  check("an observed success re-arms the signal and silences it", afterOk.stdout.trim() === "");
  const broken = sh(`brains_resolve_endpoints "${ORIGIN}"\nbrains_health_note ingest "$BRAINS_URL_INGEST" no-credential\nbrains_capture_signal`, { state });
  check("a later break is announced again — declining once does not mute it forever",
    broken.stdout.includes("<!-- brains:capture -->"), broken.stdout);
}
{
  const state = freshState();
  const amb = sh(`brains_resolve_endpoints "${ORIGIN}"\nbrains_health_note ingest "$BRAINS_URL_INGEST" indeterminate\nbrains_capture_signal`, { state });
  // "Log in again" cannot remove a duplicate server entry, so the remedy has to name the real fix.
  check("the indeterminate state gets a remedy that can actually work",
    amb.stdout.includes("token` option explicitly"), amb.stdout);
}
{
  // core.md tells the agent the note is authoritative and to carry out the one
  // step it names. Every state must therefore actually name a step — and the
  // two that name a SETTING rather than a command are exactly where an agent
  // told to "run the command" could fabricate one and execute it.
  for (const st of ["no-credential", "indeterminate", "rejected", "blocked"]) {
    const state = freshState();
    const r = sh(
      `brains_resolve_endpoints "${ORIGIN}"\nbrains_health_note ingest "$BRAINS_URL_INGEST" ${st}\nbrains_capture_signal`,
      { state },
    );
    const named = /`[^`]+`/.test(r.stdout);
    check(`the ${st} signal names a concrete step`,
      r.stdout.includes("<!-- brains:capture -->") && named, r.stdout.trim().slice(0, 120));
  }
}
{
  // The remedy has to be platform-aware as well as cause-aware. Codex storage
  // on Linux is unverified, so the hooks do not read it there — telling a
  // signed-in Linux user to sign in again is a step they can repeat forever
  // without changing anything. `security` absent stands in for "not macOS".
  const noSecurity = join(temp, "no-security-bin");
  mkdirSync(noSecurity, { recursive: true });
  for (const bin of ["curl", "jq", "shasum", "sleep", "find", "wc", "head", "tr", "sort", "awk", "mkdir", "rmdir", "rm", "cat", "id", "date", "cut", "mv", "grep", "sed", "printf", "bash", "sh", "env", "ls", "touch"]) {
    const which = spawnSync("bash", ["-c", `command -v ${bin} || true`], { encoding: "utf8" }).stdout.trim();
    if (which) writeFileSync(join(noSecurity, bin), `#!/bin/sh\nexec ${which} "$@"\n`), chmodSync(join(noSecurity, bin), 0o755);
  }
  const state = freshState();
  const r = sh(
    `BRAINS_CRED_CLIENT=codex\nbrains_resolve_endpoints "${ORIGIN}"\nbrains_health_note ingest "$BRAINS_URL_INGEST" no-credential\nbrains_capture_signal`,
    { state, env: { PATH: noSecurity } },
  );
  // Codex on Linux is not a supported configuration, so the note says that and
  // names nothing. Offering a token workaround there documented a path the
  // product does not support, and core.md tells the agent to carry out the one
  // step a note names — so a note with no supported step must say so outright
  // rather than leave a gap for the agent to fill.
  check("a Codex host without the macOS keychain is told the platform is unsupported",
    r.stdout.includes("does not support Codex on this platform"), r.stdout.trim().slice(0, 160));
  check("...and is offered no remedy at all",
    !r.stdout.includes("mcp login") && !r.stdout.includes("BRAINS_API_TOKEN"), r.stdout.trim().slice(0, 160));
}

// =============================================================== fail-safe
section("fail-safe — a hostile or broken store degrades to today's behaviour");
{
  const hostile = join(temp, "hostile-bin");
  mkdirSync(hostile, { recursive: true });
  const write = (name: string, body: string) => {
    writeFileSync(join(hostile, name), body);
    chmodSync(join(hostile, name), 0o755);
  };
  // The shapes that broke two earlier versions of the bounded read. The last one is the important
  // one: a leader that exits 0 while a descendant keeps writing held the pipe open in both
  // pipe-based designs, well past the deadline, and returned the bytes written after it.
  const shapes: Array<[string, string]> = [
    ["hangs", "#!/bin/sh\nsleep 30\n"],
    ["prints then hangs", "#!/bin/sh\nprintf PARTIAL\nsleep 30\n"],
    ["exits 0, grandchild appends forever", "#!/bin/sh\nprintf EARLY\n( while :; do printf XXXXXXXXXXXXXXXX; done ) &\nexit 0\n"],
    ["never exits, writes forever", "#!/bin/sh\nwhile :; do printf YYYYYYYYYYYYYYYY; done\n"],
    ["exits non-zero with output", "#!/bin/sh\nprintf JUNK\nexit 3\n"],
  ];
  for (const [label, body] of shapes) {
    write("security", body);
    const started = Date.now();
    const r = sh(
      `if brains_resolve_credential ${JSON.stringify(ORIGIN)}; then printf 'RESOLVED'; else printf 'none'; fi`,
      { env: { PATH: `${hostile}:${process.env.PATH ?? ""}` } },
    );
    const elapsed = Date.now() - started;
    check(`security that ${label}: bounded and yields no credential`,
      r.stdout === "none" && r.status === 0 && elapsed < 8000, `stdout=${r.stdout} status=${r.status} ${elapsed}ms`);
  }
}
{
  // The temp root is derived, validated, and never fallen back from. It also has to survive
  // `set -u`: an unset expansion here would abort the hook, which is the opposite of degrading.
  const linkTarget = join(temp, "link-target");
  mkdirSync(linkTarget, { recursive: true });
  const linkedState = join(temp, "linked-state");
  mkdirSync(linkedState, { recursive: true });
  symlinkSync(linkTarget, join(linkedState, "tmp"));
  const r = sh(
    `if brains_resolve_credential ${JSON.stringify(ORIGIN)}; then printf 'RESOLVED'; else printf 'none'; fi`,
    { state: linkedState, env: { BRAINS_CLAUDE_CREDENTIALS_FILE: PRIMARY_STORE } },
  );
  check("a symlinked temp root is refused rather than used", r.stdout === "none" && r.status === 0,
    `stdout=${r.stdout} status=${r.status}`);

  const readOnly = join(temp, "readonly-state");
  mkdirSync(readOnly, { recursive: true });
  chmodSync(readOnly, 0o500);
  const ro = sh(
    `if brains_resolve_credential ${JSON.stringify(ORIGIN)}; then printf 'RESOLVED'; else printf 'none'; fi`,
    { state: readOnly, env: { BRAINS_CLAUDE_CREDENTIALS_FILE: PRIMARY_STORE } },
  );
  check("a read-only state dir degrades instead of failing the hook",
    ro.status === 0, `status=${ro.status} stderr=${ro.stderr}`);
  chmodSync(readOnly, 0o700);
}
{
  const state = freshState();
  const r = sh(
    `mkdir -p "$BRAINS_STATE_DIR/tmp/r.stale" "$BRAINS_STATE_DIR/tmp/r.fresh"\n` +
      `touch -t 202601010000 "$BRAINS_STATE_DIR/tmp/r.stale"\n` +
      `brains_cred_prune_tmp\n` +
      `printf 'stale=%s fresh=%s' "$([ -d "$BRAINS_STATE_DIR/tmp/r.stale" ] && echo yes || echo no)" "$([ -d "$BRAINS_STATE_DIR/tmp/r.fresh" ] && echo yes || echo no)"`,
    { state },
  );
  check("read directories orphaned by SIGKILL are pruned, recent ones kept",
    r.stdout === "stale=no fresh=yes", r.stdout);
}
{
  // SIGKILL is untrappable and the prune above is the answer to it, but TERM
  // and INT are catchable and far more common — a user hitting ctrl-C. The
  // store document is in that directory in plaintext while the read runs, so
  // the interrupted case has to clean up rather than wait for a later session.
  const trapBin = join(temp, "trap-bin");
  mkdirSync(trapBin, { recursive: true });
  writeFileSync(join(trapBin, "security"), `#!/bin/sh\nprintf '{"mcpOAuth":{}}'\nsleep 60\n`);
  chmodSync(join(trapBin, "security"), 0o755);
  const state = freshState();
  // The read deadline is raised far beyond the observation window and the
  // driver runs in its own process group, signalled as a group. Without both,
  // the ORDINARY deadline path cleans up before the check looks — which made
  // this test pass with the trap deleted, proving nothing at all.
  const driver = join(temp, "trap-driver.sh");
  writeFileSync(driver, `. ${JSON.stringify(LIB)}\nBRAINS_CRED_READ_DEADLINE=45\nbrains_resolve_credential ${JSON.stringify(ORIGIN)}\n`);
  const runner = join(temp, "trap-runner.sh");
  const pidFile = join(temp, "trap.pid");
  writeFileSync(runner,
    `set -m\nbash ${JSON.stringify(driver)} >/dev/null 2>&1 &\nP=$!\nprintf '%s' "$P" > ${JSON.stringify(pidFile)}\nsleep 2\n` +
    `ls -d ${JSON.stringify(state)}/tmp/r.* 2>/dev/null | wc -l\nkill -TERM -"$P" 2>/dev/null\nwait "$P" 2>/dev/null\n`);
  const runOut = spawnSync("bash", [runner], {
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PLUGIN_OPTION_TOKEN: "", BRAINS_API_TOKEN: "", BRAINS_INBOX_TOKEN: "",
      BRAINS_STATE_DIR: state, PATH: `${trapBin}:${process.env.PATH ?? ""}`,
    },
    encoding: "utf8", timeout: 30000,
  });
  const during = Number((runOut.stdout ?? "0").trim());
  spawnSync("sleep", ["1.5"]);
  const after = readDirNames(join(state, "tmp")).filter((d) => d.startsWith("r.")).length;
  check("an interrupted read leaves no credential directory behind",
    during >= 1 && after === 0, `during=${during} after=${after}`);
}
{
  // A leader that forks a sleeping descendant and exits 0: the descendant must
  // not outlive the read. Standing the watchdog down before sweeping the
  // worker's process group is exactly what would orphan it.
  const orphanBin = join(temp, "orphan-bin");
  mkdirSync(orphanBin, { recursive: true });
  writeFileSync(join(orphanBin, "security"), `#!/bin/sh\nprintf '{"mcpOAuth":{}}'\n( sleep 25 ) &\nexit 0\n`);
  chmodSync(join(orphanBin, "security"), 0o755);
  const countSleepers = () =>
    Number((spawnSync("bash", ["-c", "pgrep -f 'sleep 25' | wc -l"], { encoding: "utf8" }).stdout ?? "0").trim());
  const before = countSleepers();
  sh(`brains_resolve_credential ${JSON.stringify(ORIGIN)} || true`,
    { env: { PATH: `${orphanBin}:${process.env.PATH ?? ""}` } });
  spawnSync("sleep", ["1"]);
  const after = countSleepers();
  spawnSync("bash", ["-c", "pkill -f 'sleep 25' 2>/dev/null; true"]);
  check("a forked descendant of the store reader is not orphaned",
    after <= before, `before=${before} after=${after}`);
}

// =============================================================== bounded network
section("network calls are bounded — no call site can opt out");
{
  // A socket that accepts and then never answers. This is the shape that hangs
  // a hook rather than failing it, and it is worst on Codex, whose Stop hook
  // waits for the assistant POST. The default belongs inside brains_request
  // precisely because ingest — the one call site outside the inbox lib — is how
  // the original `--max-time 5` came to be dropped in the first place.
  const blackhole = join(temp, "blackhole.js");
  writeFileSync(blackhole, `require("net").createServer(() => {}).listen(8994, "127.0.0.1");\n`);
  const bh = spawn(process.execPath, [blackhole], { stdio: "ignore" });
  spawnSync("sleep", ["0.8"]);
  const bhStore = fixture("blackhole-store", {
    mcpOAuth: { "a|1": { accessToken: "tok-bh", serverUrl: "http://127.0.0.1:8994/mcp", serverName: "brains" } },
  });
  const started = Date.now();
  const r = sh(
    `brains_resolve_credential http://127.0.0.1:8994 || exit 1\n` +
      `brains_request ingest http://127.0.0.1:8994/ingest/claude -X POST -d '{}'\n` +
      `printf 'rc=%s code=%s' "$?" "$BRAINS_HTTP_CODE"`,
    { env: { BRAINS_CLAUDE_CREDENTIALS_FILE: bhStore } },
  );
  const elapsed = Date.now() - started;
  bh.kill();
  check("a server that accepts and never answers cannot hang a request",
    r.stdout.startsWith("rc=1") && elapsed < 15000, `${r.stdout} in ${elapsed}ms`);
  check("brains_request carries default connect and total deadlines",
    /--connect-timeout/.test(readFileSync(LIB, "utf8")) && /--max-time/.test(readFileSync(LIB, "utf8")));
  check("the ingest call site keeps its own explicit ceiling",
    /brains_request ingest [^\n]*--max-time/.test(readFileSync(TURN, "utf8")));
}

// =============================================================== aggregate budget
section("one budget for the whole resolution, not one per read");
{
  // Per-read deadlines do not compose. The Codex store is enumerated one
  // account at a time, so N stale entries would otherwise cost N x the
  // per-read deadline — twice per prompt, since the turn hook and the inbox
  // engine each resolve independently.
  const budgetBin = join(temp, "budget-bin");
  mkdirSync(budgetBin, { recursive: true });
  const accounts = 40;
  writeFileSync(join(budgetBin, "security"),
    `#!/bin/sh\nif [ "$1" = "dump-keychain" ]; then\n  i=0\n  while [ $i -lt ${accounts} ]; do\n    printf '    "acct"<blob>="brains|%s"\\n' "$i"\n    printf '    "svce"<blob>="Codex MCP Credentials"\\n'\n    i=$((i+1))\n  done\n  exit 0\nfi\nsleep 30\n`);
  chmodSync(join(budgetBin, "security"), 0o755);
  const started = Date.now();
  const r = sh(
    `BRAINS_CRED_CLIENT=codex\n` +
      `if brains_resolve_credential ${JSON.stringify(ORIGIN)}; then printf 'RESOLVED'; else printf 'none'; fi`,
    { env: { PATH: `${budgetBin}:${process.env.PATH ?? ""}` } },
  );
  const elapsed = Date.now() - started;
  check(`${accounts} hanging Codex accounts stay within the aggregate budget`,
    r.stdout === "none" && elapsed < 12000, `${r.stdout} in ${elapsed}ms`);
}

// =============================================================== health namespace
section("health is scoped to the endpoint, not just the capability");
{
  // Two sessions, one state dir, different servers — production in one window
  // and a self-hosted instance in another. With a capability-only key the
  // healthy one clears the broken one's rejection and releases its claim,
  // putting the self-hosted window back to silently uncaptured.
  const state = freshState();
  const okStore = storeFor(`${ORIGIN}/mcp`, "tok-ok");
  const r = sh(
    `brains_resolve_credential ${JSON.stringify(ORIGIN)} || exit 1\n` +
      `brains_request ingest "${ORIGIN}/forbidden" -X POST -d '{}'\n` +
      `printf 'A=%s ' "$(brains_health_state ingest "${ORIGIN}/forbidden")"\n` +
      `brains_resolve_credential "http://127.0.0.1:${OTHER}" || exit 1\n` +
      `brains_request ingest "http://127.0.0.1:${OTHER}/ingest/claude" -X POST -d '{}'\n` +
      `printf 'B=%s ' "$(brains_health_state ingest "http://127.0.0.1:${OTHER}/ingest/claude")"\n` +
      `brains_resolve_credential ${JSON.stringify(ORIGIN)} || exit 1\n` +
      `printf 'A-again=%s' "$(brains_health_state ingest "${ORIGIN}/forbidden")"`,
    {
      state,
      env: {
        BRAINS_CLAUDE_CREDENTIALS_FILE: fixture("two-origin-store", {
          mcpOAuth: {
            "a|1": { accessToken: "tok-ok", serverUrl: `${ORIGIN}/mcp`, serverName: "brains" },
            "b|1": { accessToken: "tok-other", serverUrl: `http://127.0.0.1:${OTHER}/mcp`, serverName: "brains" },
          },
        }),
      },
    },
  );
  check("a healthy endpoint does not clear another endpoint's rejection",
    r.stdout === "A=rejected B=ok A-again=rejected", r.stdout);
  void okStore;
}

// =============================================================== truncation
section("an incomplete enumeration means 'I do not know', never 'here is what I found'");
{
  // A cap that stops early and hands back the first match silently breaks
  // exactly-one-or-nothing: a second matching account past the cutoff is
  // invisible, and the first gets returned as uniquely valid. That is how a
  // conversation ends up captured into the wrong account, with no error.
  const codexBin = join(temp, "trunc-bin");
  mkdirSync(codexBin, { recursive: true });
  const dump = (server: string, count: number) =>
    `  i=0\n  while [ $i -lt ${count} ]; do\n    printf '    "acct"<blob>="${server}|%s"\\n' "$i"\n    printf '    "svce"<blob>="Codex MCP Credentials"\\n'\n    i=$((i+1))\n  done\n`;
  const resolveCodex = `BRAINS_CRED_CLIENT=codex\nif brains_resolve_credential ${JSON.stringify(ORIGIN)}; then printf 'RESOLVED|%s|%s' "$BRAINS_CRED_STATE" "$BRAINS_CRED_TRUNCATED"; else printf 'none|%s|%s' "$BRAINS_CRED_STATE" "$BRAINS_CRED_TRUNCATED"; fi`;

  // 12 matching accounts against a cap of 8, each with a DIFFERENT valid token.
  writeFileSync(join(codexBin, "security"),
    `#!/bin/sh\nif [ "$1" = "dump-keychain" ]; then\n${dump("brains", 12)}  exit 0\nfi\nprintf '{"server_name":"brains","url":"${ORIGIN}/mcp","token_response":{"access_token":"tok-'"$5"'"}}'\n`);
  chmodSync(join(codexBin, "security"), 0o755);
  const truncated = sh(resolveCodex, { env: { PATH: `${codexBin}:${process.env.PATH ?? ""}` } });
  check("a truncated scan refuses instead of returning the first match",
    truncated.stdout === "none|indeterminate|1", truncated.stdout);

  // 40 accounts for OTHER servers plus one for ours: narrowing by server name
  // before any keychain read is what keeps the cap from binding in practice.
  writeFileSync(join(codexBin, "security"),
    `#!/bin/sh\nif [ "$1" = "dump-keychain" ]; then\n${dump("other-server", 40)}  printf '    "acct"<blob>="brains|only"\\n'\n  printf '    "svce"<blob>="Codex MCP Credentials"\\n'\n  exit 0\nfi\nprintf '{"server_name":"brains","url":"${ORIGIN}/mcp","token_response":{"access_token":"tok-only"}}'\n`);
  chmodSync(join(codexBin, "security"), 0o755);
  const narrowed = sh(resolveCodex, { env: { PATH: `${codexBin}:${process.env.PATH ?? ""}` } });
  check("accounts for other servers never consume the candidate budget",
    narrowed.stdout === "RESOLVED|ok|0", narrowed.stdout);

  // An account that cannot be READ is the same hazard as one past the cutoff:
  // it is a targeted candidate for this server, so it may hold a different
  // credential, and returning the readable one as uniquely valid is the
  // exactly-one-or-nothing violation by another route. Note the account arrives
  // as $5 — the call is `-s <service> -a <account> -w`.
  const twoAccounts = `if [ "$1" = "dump-keychain" ]; then\n  printf '    "acct"<blob>="brains|good"\\n'\n  printf '    "svce"<blob>="Codex MCP Credentials"\\n'\n  printf '    "acct"<blob>="brains|second"\\n'\n  printf '    "svce"<blob>="Codex MCP Credentials"\\n'\n  exit 0\nfi\ncase "$5" in\n  'brains|good') printf '{"server_name":"brains","url":"${ORIGIN}/mcp","token_response":{"access_token":"tok-good"}}' ;;\n`;
  const secondAccount = (behaviour: string) => {
    writeFileSync(join(codexBin, "security"), `#!/bin/sh\n${twoAccounts}  'brains|second') ${behaviour} ;;\nesac\n`);
    chmodSync(join(codexBin, "security"), 0o755);
    return sh(resolveCodex, { env: { PATH: `${codexBin}:${process.env.PATH ?? ""}` } }).stdout;
  };
  check("a second account whose read FAILS refuses selection",
    secondAccount("exit 1") === "none|indeterminate|1", secondAccount("exit 1"));
  check("a second account whose read TIMES OUT refuses selection",
    secondAccount("sleep 30") === "none|indeterminate|1");
  check("a second account with MALFORMED json refuses selection",
    secondAccount(`printf '{"token_response":{"access_token":"x"'`) === "none|indeterminate|1");
  // The one case that must not poison the result: parses cleanly, genuinely has
  // no token. Treating this as "unknown" would let a single junk keychain entry
  // disable capture permanently.
  check("a second account that parses and simply has no token resolves cleanly",
    secondAccount(`printf '{"server_name":"brains","url":"${ORIGIN}/mcp","token_response":{}}'`) === "RESOLVED|ok|0");
  // Two stale Codex aliases holding the SAME bearer are one credential, not an
  // ambiguity. The collapse was applied to the Claude path only after the
  // restructure, which turned this into indeterminate and switched capture off
  // for a credential that was never ambiguous.
  check("two Codex accounts carrying the same token collapse and resolve",
    secondAccount(`printf '{"server_name":"brains","url":"${ORIGIN}/mcp","token_response":{"access_token":"tok-good"}}'`) === "RESOLVED|ok|0",
    secondAccount(`printf '{"server_name":"brains","url":"${ORIGIN}/mcp","token_response":{"access_token":"tok-good"}}'`));
}

// =============================================================== explicit tokens
section("the EXPLICIT tokens stay out of a trace too");
{
  // The leak battery below drives the discovered-OAuth path, where I1 keeps the
  // value out of every variable. The three explicitly configured tokens are
  // environment variables — they have to be tested for emptiness and read to
  // build the config, and both expand the value — so they need the xtrace
  // shield, and only these cases can tell whether it is still there. Removing
  // it on the strength of I1 alone reopened the channel for all three, with two
  // trace hits each, and nothing here noticed.
  const CANARY = "XTRACE-CANARY-77x";
  const driver = join(temp, "explicit-driver.sh");
  writeFileSync(driver, `. ${JSON.stringify(LIB)}\nbrains_resolve_credential ${JSON.stringify(ORIGIN)} >/dev/null\n`);
  for (const varName of ["CLAUDE_PLUGIN_OPTION_TOKEN", "BRAINS_API_TOKEN", "BRAINS_INBOX_TOKEN"]) {
    const base: Record<string, string> = {
      ...(process.env as Record<string, string>),
      CLAUDE_PLUGIN_OPTION_TOKEN: "", BRAINS_API_TOKEN: "", BRAINS_INBOX_TOKEN: "",
      BRAINS_STATE_DIR: freshState(),
      [varName]: CANARY,
    };
    const traced = spawnSync("bash", ["-x", driver], { env: base, encoding: "utf8", timeout: 20000 });
    check(`${varName} never appears under bash -x`,
      !`${traced.stdout ?? ""}${traced.stderr ?? ""}`.includes(CANARY));
    const inherited = spawnSync("bash", [driver], {
      env: { ...base, SHELLOPTS: "xtrace" }, encoding: "utf8", timeout: 20000,
    });
    check(`${varName} never appears under an inherited SHELLOPTS=xtrace`,
      !`${inherited.stdout ?? ""}${inherited.stderr ?? ""}`.includes(CANARY));
  }
}

// =============================================================== owned paths only
section("the cleanup primitive cannot touch anything it does not own");
{
  // _brains_discard is an rm -rf on a path derived from its argument, and the
  // argument has twice turned out to be caller-supplied. Rather than scoping a
  // third call site, the primitive itself refuses anything that is not a direct
  // child of the temp root — so a future call site cannot aim it outside.
  const outside = join(temp, "not-ours");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "SENTINEL.txt"), "keep me");
  const state = freshState();
  const r = sh(
    `_brains_cred_tmp_root || exit 1\n` +
      `_brains_discard ${JSON.stringify(join(outside, "some-file"))}\n` +
      `_brains_discard "$BRAINS_CRED_TMP"/x\n` +
      `_brains_discard "$BRAINS_CRED_TMP/a/b/c"\n` +
      `printf 'done'`,
    { state },
  );
  check("discarding an outside path is a no-op",
    existsSync(join(outside, "SENTINEL.txt")) && existsSync(outside), r.stdout);
  check("and the temp root itself is never removed",
    readDirNames(join(state, "tmp")).length >= 0 && existsSync(join(state, "tmp")));

  // The Codex override store is a real file in a real directory. Every outcome
  // — resolved, non-matching, ambiguous, malformed — must leave it alone.
  const cases: Array<[string, unknown, string]> = [
    ["a successful resolve", [{ server_name: "brains", url: `${ORIGIN}/mcp`, token_response: { access_token: "tok-a" } }], "ok"],
    ["a non-matching origin", [{ server_name: "brains", url: "http://127.0.0.1:9999/mcp", token_response: { access_token: "tok-a" } }], "blocked"],
    ["an ambiguous store", [
      { server_name: "brains", url: `${ORIGIN}/mcp`, token_response: { access_token: "tok-a" } },
      { server_name: "brains", url: `${ORIGIN}/mcp`, token_response: { access_token: "tok-b" } },
    ], "indeterminate"],
    ["a malformed store", '[{"server_name":"brains","token_response":{"access_token":', "indeterminate"],
  ];
  for (const [label, body, wantState] of cases) {
    const userdir = join(temp, `codex-userdir-${Buffer.from(label).toString("hex").slice(0, 8)}`);
    mkdirSync(userdir, { recursive: true });
    const storePath = join(userdir, "codex-store.json");
    writeFileSync(storePath, typeof body === "string" ? body : JSON.stringify(body));
    writeFileSync(join(userdir, "SENTINEL.txt"), "keep me");
    const out = sh(
      `BRAINS_CRED_CLIENT=codex\nbrains_resolve_credential ${JSON.stringify(ORIGIN)} >/dev/null 2>&1\nprintf '%s' "$BRAINS_CRED_STATE"`,
      { env: { BRAINS_CODEX_CREDENTIALS_FILE: storePath } },
    );
    check(`${label}: the user's own store directory survives`,
      existsSync(userdir) && existsSync(storePath) && existsSync(join(userdir, "SENTINEL.txt")) && out.stdout === wantState,
      `state=${out.stdout} dir=${existsSync(userdir)} store=${existsSync(storePath)}`);
  }
}

// =============================================================== the real hook
section("the turn hook's backgrounded ingest actually carries a credential");
{
  // Driven through the REAL brains-turn.sh with REAL curl against the stub.
  // The other suite that exercises this hook substitutes a fake curl which
  // never reads --config, so it structurally cannot notice a missing
  // credential: remove the lease and it stays green while every POST goes out
  // unauthenticated. This is the only test that can see that.
  const state = freshState();
  const before = readHits().length;
  const store = fixture("turnhook-store", {
    mcpOAuth: { "a|1": { accessToken: "tok-turnhook", serverUrl: `${ORIGIN}/mcp`, serverName: "brains" } },
  });
  const r = spawnSync("bash", [TURN], {
    input: JSON.stringify({ session_id: "turnhook", prompt: "hello" }),
    env: {
      ...(process.env as Record<string, string>),
      CLAUDE_PLUGIN_OPTION_TOKEN: "", BRAINS_API_TOKEN: "", BRAINS_INBOX_TOKEN: "",
      BRAINS_STATE_DIR: state,
      BRAINS_ENDPOINT: ORIGIN,
      BRAINS_CLAUDE_CREDENTIALS_FILE: store,
    },
    encoding: "utf8", timeout: 30000,
  });
  // The POST is fire-and-forget, so wait for it to land rather than sampling once.
  let ingest: Hit[] = [];
  for (let i = 0; i < 40 && ingest.length === 0; i++) {
    spawnSync("sleep", ["0.1"]);
    ingest = readHits().slice(before).filter((h) => h.path === "/ingest/claude");
  }
  check("the hook exits 0", r.status === 0, String(r.status));
  check("a backgrounded ingest POST reaches the endpoint", ingest.length === 1, `${ingest.length} POSTs`);
  check("and it carries the resolved bearer",
    ingest[0]?.auth === "Bearer tok-turnhook", ingest[0]?.auth ?? "(none)");
  // The property the lease exists for, tested deterministically rather than by
  // racing: a backgrounded request must survive the master config being
  // released. Waiting for the race to bite is unreliable — it passed with the
  // lease removed — so this releases the master the instant the child is
  // forked, which is the worst case the hook can actually produce.
  {
    const leaseState = freshState();
    const driver = join(temp, "lease-driver.sh");
    writeFileSync(driver,
      `. ${JSON.stringify(LIB)}\n` +
      `brains_resolve_credential "${ORIGIN}" || exit 1\n` +
      `_l=$(brains_cred_lease) || exit 1\n` +
      `( BRAINS_CRED_CONFIG="$_l"; brains_request ingest "${ORIGIN}/ingest/claude" -X POST -d '{}'; brains_cred_return "$_l" ) &\n` +
      `brains_cred_release\n` +
      `wait\n`);
    const mark = readHits().length;
    spawnSync("bash", [driver], {
      env: {
        ...(process.env as Record<string, string>),
        CLAUDE_PLUGIN_OPTION_TOKEN: "", BRAINS_API_TOKEN: "", BRAINS_INBOX_TOKEN: "",
        BRAINS_STATE_DIR: leaseState, BRAINS_CLAUDE_CREDENTIALS_FILE: store,
      },
      encoding: "utf8", timeout: 30000,
    });
    let leased: Hit[] = [];
    for (let i = 0; i < 40 && leased.length === 0; i++) {
      spawnSync("sleep", ["0.1"]);
      leased = readHits().slice(mark).filter((h) => h.path === "/ingest/claude");
    }
    check("a leased request survives the master config being released",
      leased[0]?.auth === "Bearer tok-turnhook", leased[0]?.auth ?? "(no request arrived)");
  }

  // The lease copy must not outlive the request.
  spawnSync("sleep", ["0.5"]);
  check("no credential file is left behind afterwards",
    readDirNames(join(state, "tmp")).filter((d) => d.startsWith("r.")).length === 0,
    readDirNames(join(state, "tmp")).join(","));
}

// =============================================================== fresh install
section("a fresh install is told to sign in, not that its store is unreadable");
{
  // security exits 44 for "item not found" and there is no fallback file: a
  // brand-new machine that has simply never signed in. That is a CONCLUSIVE
  // absence, and the remedy for it is the sign-in. Reporting indeterminate
  // there sends the primary first-run path to a remedy that cannot apply.
  const freshBin = join(temp, "fresh-bin");
  mkdirSync(freshBin, { recursive: true });
  writeFileSync(join(freshBin, "security"),
    `#!/bin/sh\necho "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain." >&2\nexit 44\n`);
  chmodSync(join(freshBin, "security"), 0o755);
  const home = join(temp, "fresh-home");
  mkdirSync(join(home, ".claude"), { recursive: true });
  const r = sh(
    `if brains_resolve_credential ${JSON.stringify(ORIGIN)}; then printf 'RESOLVED'; else printf '%s' "$BRAINS_CRED_STATE"; fi`,
    { env: { PATH: `${freshBin}:${process.env.PATH ?? ""}`, HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), BRAINS_CLAUDE_CREDENTIALS_FILE: "" } },
  );
  check("keychain item-not-found with no fallback file is a definite no-credential",
    r.stdout === "no-credential", r.stdout);
  const sig = sh(
    `brains_resolve_endpoints "${ORIGIN}"\nbrains_health_note ingest "$BRAINS_URL_INGEST" no-credential\nbrains_capture_signal`,
    {},
  );
  check("and the remedy it gets is the sign-in",
    sig.stdout.includes("mcp login"), sig.stdout.trim().slice(0, 120));
}

// =============================================================== signal delivery
section("a signal during a store read is delivered, not swallowed");
{
  // Replacing INT/TERM with a cleanup-only handler eats the signal: bash
  // resumes afterwards and the caller's handler never runs, so a sourced
  // library would be redefining Ctrl-C for the whole hook.
  const slowBin = join(temp, "signal-bin");
  mkdirSync(slowBin, { recursive: true });
  writeFileSync(join(slowBin, "security"), `#!/bin/sh\nprintf '{"mcpOAuth":{}}'\nsleep 30\n`);
  chmodSync(join(slowBin, "security"), 0o755);
  const state = freshState();
  const env = {
    ...(process.env as Record<string, string>),
    CLAUDE_PLUGIN_OPTION_TOKEN: "", BRAINS_API_TOKEN: "", BRAINS_INBOX_TOKEN: "",
    BRAINS_STATE_DIR: state, PATH: `${slowBin}:${process.env.PATH ?? ""}`,
  };
  // Driven from a bash runner rather than node's spawn/kill: the signal, the
  // wait and the read have to be ordered, and racing them produced an empty
  // capture that looked exactly like a swallowed signal.
  const withHandler = join(temp, "sig-handler.sh");
  writeFileSync(withHandler, `. ${JSON.stringify(LIB)}\ntrap 'echo CALLER-HANDLER-RAN; exit 42' TERM\nbrains_resolve_credential ${JSON.stringify(ORIGIN)}\necho SHOULD-NOT-REACH\n`);
  const handlerRunner = join(temp, "sig-handler-runner.sh");
  const handlerOut = join(temp, "sig-handler.out");
  writeFileSync(handlerRunner, `bash ${JSON.stringify(withHandler)} >${JSON.stringify(handlerOut)} 2>/dev/null &\nP=$!\nsleep 0.8\nkill -TERM $P 2>/dev/null\nwait $P 2>/dev/null\nprintf '%s' "$?"\n`);
  const handlerRun = spawnSync("bash", [handlerRunner], { env, encoding: "utf8", timeout: 20000 });
  const out1 = existsSync(handlerOut) ? readFileSync(handlerOut, "utf8") : "";
  check("the caller's own signal handler still runs",
    out1.includes("CALLER-HANDLER-RAN") && !out1.includes("SHOULD-NOT-REACH"), JSON.stringify(out1));
  check("the caller's handler controls the exit status",
    (handlerRun.stdout ?? "").trim() === "42", (handlerRun.stdout ?? "").trim());

  const noHandler = join(temp, "sig-nohandler.sh");
  writeFileSync(noHandler, `. ${JSON.stringify(LIB)}\nbrains_resolve_credential ${JSON.stringify(ORIGIN)}\necho SHOULD-NOT-REACH\n`);
  const runner = join(temp, "sig-runner.sh");
  writeFileSync(runner, `bash ${JSON.stringify(noHandler)} >/dev/null 2>&1 &\nP=$!\nsleep 0.8\nkill -TERM $P 2>/dev/null\nwait $P 2>/dev/null\nprintf '%s' "$?"\n`);
  const status = spawnSync("bash", [runner], { env, encoding: "utf8", timeout: 20000 });
  // 143 = 128 + SIGTERM: the status a process gets when it is not handling it.
  check("with no handler, the normal terminating status is preserved",
    (status.stdout ?? "").trim() === "143", (status.stdout ?? "").trim());
  // Read the directory rather than shelling out: a quoted glob in `bash -c`
  // never expands, so the shell version was asserting on a path that could not
  // match anything and passed for the wrong reason.
  //
  // Polled, not sampled once. Cleanup is prompt but not synchronous with the
  // parent's exit becoming observable to `wait` — measured at under two seconds
  // — and asserting on the instant after `wait` was reading a directory mid
  // removal. What matters is that nothing is left behind, not the exact moment.
  let remaining = readDirNames(join(state, "tmp")).filter((d) => d.startsWith("r."));
  for (let i = 0; i < 30 && remaining.length > 0; i++) {
    spawnSync("sleep", ["0.1"]);
    remaining = readDirNames(join(state, "tmp")).filter((d) => d.startsWith("r."));
  }
  check("and the credential directory is not left behind", remaining.length === 0, remaining.join(","));
}

// =============================================================== curlrc
section("the user's own curl config cannot capture the bearer");
{
  // -q, and it must be curl's first argument. Without it curl reads ~/.curlrc,
  // and a curlrc carrying `trace-ascii` writes outgoing headers to a file —
  // measured on curl 8.7.1. Keeping the token out of argv and xtrace does
  // nothing about a channel the user's own debugging config opens.
  const fakeHome = join(temp, "curlrc-home");
  mkdirSync(fakeHome, { recursive: true });
  const tracePath = join(temp, "curl-trace.txt");
  writeFileSync(join(fakeHome, ".curlrc"), `trace-ascii ${tracePath}\n`);
  const CANARY = "CURLRCCANARY99";
  const store = fixture("curlrc-store", {
    mcpOAuth: { "a|1": { accessToken: CANARY, serverUrl: `${ORIGIN}/mcp`, serverName: "brains" } },
  });
  sh(
    `brains_resolve_credential ${JSON.stringify(ORIGIN)} || exit 1\n` +
      `brains_request ingest "${ORIGIN}/ingest/claude" -X POST -d '{}'`,
    { env: { BRAINS_CLAUDE_CREDENTIALS_FILE: store, HOME: fakeHome, CURL_HOME: fakeHome } },
  );
  const traced = existsSync(tracePath) ? readFileSync(tracePath, "utf8") : "";
  check("a curlrc that enables tracing never receives the token",
    !traced.includes(CANARY), traced ? "trace file written and contains the canary" : "");
}

// =============================================================== no token escapes
section("the token never leaves brains_request");
{
  const hookSources = [readFileSync(TURN, "utf8"), readFileSync(INBOX, "utf8")];
  for (const [i, src] of hookSources.entries()) {
    const name = i === 0 ? "brains-turn.sh" : "brains-inbox.sh";
    // The hooks may name the config PATH — a backgrounded request has to carry
    // its own lease — but must never touch a token value, read a store, or
    // build an Authorization header. Presenting the credential is
    // brains_request's job alone.
    check(`${name} never handles a credential value`,
      !/Authorization/.test(src) &&
      !/mcpOAuth|find-generic-password|dump-keychain/.test(src),
      "only brains_request may present the credential");
  }
  const lib = readFileSync(LIB, "utf8");
  check("no debug tracing is enabled anywhere in the library", !/^\s*set -x/m.test(lib));
  // Grepping the source for uses of the value proved to be the wrong test: it
  // passes while the token is still being handed to curl as an argument, where
  // any local `ps` can read it, and printed in full by `bash -x` before any
  // redirection this code controls applies. What follows drives the real thing
  // and looks for the bytes, which is the only claim worth making.
  const CANARY = "LEAKCANARY0123456789";
  const leakStore = fixture("leak-store", {
    mcpOAuth: { "a|1": { accessToken: CANARY, serverUrl: `${ORIGIN}/mcp`, serverName: "brains" } },
  });
  const driver = join(temp, "leak-driver.sh");
  writeFileSync(driver, `. ${JSON.stringify(LIB)}\nbrains_resolve_credential ${JSON.stringify(ORIGIN)} || exit 1\nbrains_request ingest ${JSON.stringify(`${ORIGIN}/ingest/claude`)} -X POST -d '{"a":1}'\n`);
  const leakEnv = {
    ...(process.env as Record<string, string>),
    CLAUDE_PLUGIN_OPTION_TOKEN: "",
    BRAINS_API_TOKEN: "",
    BRAINS_INBOX_TOKEN: "",
    BRAINS_STATE_DIR: freshState(),
    BRAINS_CLAUDE_CREDENTIALS_FILE: leakStore,
  };
  const traced = spawnSync("bash", ["-x", driver], { env: leakEnv, encoding: "utf8", timeout: 20000 });
  check("bash -x never prints the token",
    !`${traced.stdout ?? ""}${traced.stderr ?? ""}`.includes(CANARY));
  const inherited = spawnSync("bash", [driver], {
    env: { ...leakEnv, SHELLOPTS: "xtrace" }, encoding: "utf8", timeout: 20000,
  });
  check("an inherited SHELLOPTS=xtrace never prints the token",
    !`${inherited.stdout ?? ""}${inherited.stderr ?? ""}`.includes(CANARY));
  // Tracing belongs to the caller; shielding it must not switch it off for good.
  const restored = spawnSync("bash", ["-x", "-c", `. ${JSON.stringify(driver)} >/dev/null 2>&1; echo AFTER`], {
    env: leakEnv, encoding: "utf8", timeout: 20000,
  });
  check("the caller's tracing is restored afterwards",
    (restored.stderr ?? "").includes("+ echo AFTER"));

  // And off argv, so a local `ps` cannot read it either. The request is run in
  // the background and sampled while it is still in flight.
  const slowDriver = join(temp, "leak-slow.sh");
  writeFileSync(slowDriver, `. ${JSON.stringify(LIB)}\nbrains_resolve_credential ${JSON.stringify(ORIGIN)} || exit 1\nbrains_request ingest ${JSON.stringify(`http://127.0.0.1:${TRUNCATOR}/slow`)} -X POST -d '{"a":1}'\n`);
  const bg = spawn("bash", [slowDriver], { env: leakEnv, stdio: "ignore" });
  let seenInArgv = false;
  for (let i = 0; i < 20; i++) {
    const ps = spawnSync("ps", ["-Ao", "args"], { encoding: "utf8" });
    if ((ps.stdout ?? "").split("\n").some((l) => l.includes(CANARY) && l.includes("curl"))) {
      seenInArgv = true;
      break;
    }
    spawnSync("sleep", ["0.05"]);
  }
  bg.kill();
  check("the token never appears in curl's process arguments", !seenInArgv);
}

// =============================================================== store size
section("a large but valid store still resolves");
{
  // The document ceiling bounds memory; it is not a policy. At 256 KiB — about a
  // hundred signed-in MCP servers — a perfectly valid store was rejected, and
  // the user was then told to remove a duplicate server that did not exist.
  // There is no keychain fallback on Linux, so that is the whole store.
  const entries: Record<string, unknown> = {};
  for (let i = 0; i < 3000; i++) {
    entries[`filler|${i}`] = { accessToken: `t${i}`, serverUrl: `https://other-${i}.example.com/mcp`, serverName: "other" };
  }
  entries["plugin:brains:brains|h"] = { accessToken: "tok-big", serverUrl: `${ORIGIN}/mcp`, serverName: "plugin:brains:brains" };
  const big = fixture("oversize-store", { mcpOAuth: entries });
  const bytes = readFileSync(big, "utf8").length;
  check(`the fixture is genuinely over the old 256 KiB ceiling (${bytes} bytes)`, bytes > 262144);
  check("a store far larger than one credential document still resolves",
    resolveWith(big).stdout.startsWith("ok|claude-oauth|"), resolveWith(big).stdout);
}

// =============================================================== codex arrays
section("duplicate collapse covers the array backend as well as the keychain");
{
  // The keychain backend gets one private file per account; the array backend
  // names the same document on every row, so the slurp-based collapse saw one
  // array and errored, and two aliases holding a single bearer were reported as
  // an ambiguity — capture off for a credential that was never ambiguous.
  const probe = (body: unknown) => {
    const f = fixture(`codex-array-${Buffer.from(JSON.stringify(body)).toString("hex").slice(0, 10)}`, body);
    return sh(
      `BRAINS_CRED_CLIENT=codex\n` +
        `if brains_resolve_credential ${JSON.stringify(ORIGIN)}; then printf 'RESOLVED|%s' "$BRAINS_CRED_COUNT"; else printf 'none|%s|%s' "$BRAINS_CRED_STATE" "$BRAINS_CRED_COUNT"; fi`,
      { env: { BRAINS_CODEX_CREDENTIALS_FILE: f } },
    ).stdout;
  };
  const same = [
    { server_name: "brains", url: `${ORIGIN}/mcp`, token_response: { access_token: "tok-same" } },
    { server_name: "brains", url: `${ORIGIN}/mcp`, token_response: { access_token: "tok-same" } },
  ];
  const diff = [
    { server_name: "brains", url: `${ORIGIN}/mcp`, token_response: { access_token: "tok-a" } },
    { server_name: "brains", url: `${ORIGIN}/mcp`, token_response: { access_token: "tok-b" } },
  ];
  check("two array entries carrying one bearer collapse and resolve",
    probe(same) === "RESOLVED|1", probe(same));
  check("two array entries carrying different bearers stay indeterminate",
    probe(diff) === "none|indeterminate|2", probe(diff));
}

// =============================================================== mutation gate
section("every load-bearing mechanism is proved load-bearing, here, on every run");
// Three rounds in a row shipped a mechanism with no test, and twice a test that
// DID exist quietly decayed into a tautology — the interrupt-cleanup check
// passed with its trap deleted, and the xtrace-restore check passed with the
// shield deleted. Adding another hand-written test does not stop either of
// those; both failure modes look exactly like a green suite.
//
// So the suite mutates the shipped code and requires the damage to show. Each
// entry below neuters one mechanism in a COPY of the plugin tree, runs a small
// probe against that copy, and fails unless the probe's answer changes. A
// mechanism with no observable consequence cannot be registered here, and a
// test that has decayed into a tautology stops passing the moment its mechanism
// is removed. Registering a new mechanism is one table entry.
type Mutation = {
  label: string;
  file: string;              // relative to plugins/brains
  find: string;
  replace: string;
  probe: string;             // shell, with $LIB pointing at the mutated copy
  env?: Record<string, string>;
  stubs?: Record<string, string>;  // written to $STUBS, chmod +x
  requires?: string;         // the unmutated probe MUST return this, or SKIP loudly
};
// A stub keychain tool that enumerates one Codex account, for hosts with none.
const CODEX_DUMP_STUB = [
  "#!/bin/sh",
  'if [ "$1" = "dump-keychain" ]; then',
  '  printf \'    "acct"<blob>="brains|a"\\n\'',
  '  printf \'    "svce"<blob>="Codex MCP Credentials"\\n\'',
  "  exit 0",
  "fi",
  'printf \'{"server_name":"brains","url":"%s/mcp","token_response":{"access_token":"tok-x"}}\' "$ORIGIN"',
  "",
].join("\n");
const MUTATIONS: Mutation[] = [
  {
    // Registered as the PAIR — the trap and the explicit return — and observed
    // on NORMAL completion. Two things forced that. The trap alone is not
    // separately observable: a signal arriving while curl runs is deferred by
    // bash until curl returns, at which point the explicit return runs anyway,
    // so the trap only covers a signal landing BETWEEN commands and that cannot
    // be scheduled. And signalling at all made the probe answer differently run
    // to run — it passed three times and failed the fourth — which certifies
    // nothing. What is deterministic, and is the property that matters: once
    // the backgrounded request has finished, its private copy of the bearer is
    // gone.
    label: "the turn hook's ingest-lease cleanup (trap + explicit return)",
    file: "hooks/brains-turn.sh",
    find: `      trap 'brains_cred_return "$_lease"' EXIT INT TERM HUP\n      ingest_once "$role" "$payload"\n      brains_cred_return "$_lease" ) &`,
    replace: `      ingest_once "$role" "$payload" ) &`,
    // A terminated child must not strand its leased copy of the bearer.
    probe: `bash "$TURNCOPY" <<<'{"session_id":"mut","prompt":"x"}' >/dev/null 2>&1; k=0; while [ $k -lt 80 ]; do [ -z "$(find "$BRAINS_STATE_DIR/tmp" -path "*lease*" -name curl.conf 2>/dev/null)" ] && break; sleep 0.1; k=$((k+1)); done; printf '%s' "$(find "$BRAINS_STATE_DIR/tmp" -path "*lease*" -name curl.conf 2>/dev/null | wc -l | tr -d ' ')"`,
    env: { BRAINS_API_TOKEN: "tok-slow" },
  },
  {
    // Registered as the PAIR — the trap and the explicit return — because they
    // are not separately observable and saying otherwise would be the vacuous
    // certification this gate exists to stop. A signal delivered while curl is
    // running is deferred by bash until curl returns, at which point the
    // explicit return runs anyway; the trap only covers a signal landing
    // BETWEEN commands, which cannot be scheduled deterministically. Mutating
    // either line alone therefore shows no difference, and mutating both shows
    // the lease surviving with the bearer in it. See the report note.
    label: "the inbox engine's ack-lease cleanup (trap + explicit return)",
    file: "hooks/lib/brains-inbox.sh",
    find: `      trap 'brains_cred_return "$ack_lease"' EXIT INT TERM HUP\n      brains_request ack "$ACK_ENDPOINT" --max-time 3 -X POST \\\n        -H "Content-Type: application/json" -d "$ack" >/dev/null 2>&1\n      brains_cred_return "$ack_lease" ) &`,
    replace: `      brains_request ack "$ACK_ENDPOINT" --max-time 3 -X POST \\\n        -H "Content-Type: application/json" -d "$ack" >/dev/null 2>&1 ) &`,
    // Observed on NORMAL completion rather than by signalling. Signalling a
    // backgrounded ack is inherently racy — whether the trap or the explicit
    // return gets to run depends on exactly where the subshell is when the
    // signal lands, and a probe that answers differently run to run certifies
    // nothing. The property that matters and is deterministic: once the ack has
    // finished, its private copy of the bearer is gone.
    probe: `bash "$INBOXCOPY" prompt mut >/dev/null 2>&1; k=0; while [ $k -lt 80 ]; do [ -z "$(find "$BRAINS_STATE_DIR/tmp" -path "*lease*" -name curl.conf 2>/dev/null)" ] && break; sleep 0.1; k=$((k+1)); done; printf '%s' "$(find "$BRAINS_STATE_DIR/tmp" -path "*lease*" -name curl.conf 2>/dev/null | wc -l | tr -d ' ')"`,
    env: {
      BRAINS_API_TOKEN: "tok-slow",
      // The engine only acks when the inbox returns something to acknowledge,
      // and the ack has to still be in flight when the signal arrives.
      BRAINS_INBOX_URL: `${ORIGIN}/inbox/ackable`,
      BRAINS_INBOX_ACK_URL: `${ORIGIN}/inbox/claude/ack`,
    },
  },
  {
    label: "the account-list completeness check (LC_ALL=C + PIPESTATUS)",
    file: "hooks/lib/brains-credential.sh",
    find: `  set -- "\${PIPESTATUS[0]}" "\${PIPESTATUS[1]}"`,
    replace: `  set -- 0 0`,
    // With awk failing, a partial account list must not be treated as complete.
    // Stubs are written from the test rather than by an escaped printf inside
    // the probe: the shell-quoted version worked on macOS and produced a
    // security stub the Linux runner could not use, so the probe answered
    // "no-credential" both with and without the mechanism and the gate — quite
    // correctly — refused to certify it.
    stubs: { security: CODEX_DUMP_STUB, awk: "#!/bin/sh\nexit 2\n" },
    probe: `PATH="$STUBS:$PATH"; unset BRAINS_CLAUDE_CREDENTIALS_FILE
. "$LIB"; BRAINS_CRED_CLIENT=codex; brains_resolve_credential "$ORIGIN" >/dev/null 2>&1
printf '%s/%s' "$BRAINS_CRED_STATE" "$BRAINS_CRED_TRUNCATED"`,
    // The mechanism only exists on the account-enumeration path, which needs a
    // usable security binary. If the stub cannot be made to work, that is recorded
    // out loud — a quietly skipped mutation probe is exactly the vacuous pass
    // this gate exists to prevent.
    requires: "indeterminate/1",
  },
  {
    label: "the session-end prune of SIGKILL leftovers",
    file: "hooks/brains-end.sh",
    find: `  . "$CRED_LIB" 2>/dev/null && brains_cred_prune_tmp`,
    replace: `  :`,
    probe: `mkdir -p "$BRAINS_STATE_DIR/tmp/r.stale"; touch -t 202601010000 "$BRAINS_STATE_DIR/tmp/r.stale"; bash "$ENDCOPY" <<<'{"session_id":"mut"}' >/dev/null 2>&1; printf '%s' "$([ -d "$BRAINS_STATE_DIR/tmp/r.stale" ] && echo present || echo pruned)"`,
  },
  {
    label: "the xtrace shield around the explicit-token branches",
    file: "hooks/lib/brains-credential.sh",
    find: `    *x*) BRAINS_CRED_XTRACE=1; set +x ;;`,
    replace: `    *x*) BRAINS_CRED_XTRACE="" ;;`,
    probe: `printf '%s' "$(bash -x -c '. "$0"; brains_resolve_credential "$1" >/dev/null' "$LIB" "$ORIGIN" 2>&1 | grep -c MUTCANARY)"`,
    env: { BRAINS_API_TOKEN: "MUTCANARY" },
  },
  {
    label: "the discard guard that confines rm -rf to the owned root",
    file: "hooks/lib/brains-credential.sh",
    find: `  case "$parent" in
    "$BRAINS_CRED_TMP"/*/*) return 0 ;;
    "$BRAINS_CRED_TMP"/?*) ;;
    *) return 0 ;;
  esac`,
    replace: "",
    probe: `. "$LIB"; _brains_cred_tmp_root >/dev/null 2>&1; mkdir -p "$OUTSIDE/keep"; _brains_discard "$OUTSIDE/keep/f" 2>/dev/null; printf '%s' "$([ -d "$OUTSIDE/keep" ] && echo intact || echo DELETED)"`,
  },
];
{
  const treeSrc = PLUGIN;
  for (const m of MUTATIONS) {
    const work = mkdtempSync(join(tmpdir(), "brains-mutation-"));
    spawnSync("cp", ["-R", treeSrc, join(work, "brains")]);
    const target = join(work, "brains", m.file);
    const original = readFileSync(target, "utf8");
    if (!original.includes(m.find)) {
      check(`${m.label}: mutation anchor still present in the shipped code`, false,
        "the code moved; update the anchor rather than dropping the mutation");
      rmSync(work, { recursive: true, force: true });
      continue;
    }
    const stubDir = join(work, "stubs");
    if (m.stubs) {
      mkdirSync(stubDir, { recursive: true });
      for (const [name, body] of Object.entries(m.stubs)) {
        writeFileSync(join(stubDir, name), body);
        chmodSync(join(stubDir, name), 0o755);
      }
    }
    const runProbe = (): string => {
      const st = freshState();
      const env: Record<string, string> = {
        ...(process.env as Record<string, string>),
        CLAUDE_PLUGIN_OPTION_TOKEN: "", BRAINS_API_TOKEN: "", BRAINS_INBOX_TOKEN: "",
        BRAINS_STATE_DIR: st,
        BRAINS_ENDPOINT: ORIGIN,
        BRAINS_CLAUDE_CREDENTIALS_FILE: PRIMARY_STORE,
        LIB: join(work, "brains", "hooks", "lib", "brains-credential.sh"),
        TURNCOPY: join(work, "brains", "hooks", "brains-turn.sh"),
        INBOXCOPY: join(work, "brains", "hooks", "lib", "brains-inbox.sh"),
        ENDCOPY: join(work, "brains", "hooks", "brains-end.sh"),
        ORIGIN,
        OUTSIDE: join(work, "outside"),
        STUBS: stubDir,
        ...(m.env ?? {}),
      };
      const r = spawnSync("bash", ["-c", `set -u\n${m.probe}`], { env, encoding: "utf8", timeout: 30000 });
      return (r.stdout ?? "").trim();
    };
    const before = runProbe();
    if (m.requires !== undefined && before !== m.requires) {
      // Loudly, and as a FAILURE of the gate's own preconditions rather than a
      // pass: the mechanism may be fine, but nothing here observed it.
      rmSync(work, { recursive: true, force: true });
      check(`${m.label}: probe precondition not met on this host`, false,
        `expected the unmutated probe to return "${m.requires}", got "${before}" — the probe cannot see its own mechanism, so it certifies nothing`);
      continue;
    }
    writeFileSync(target, original.split(m.find).join(m.replace));
    const after = runProbe();
    rmSync(work, { recursive: true, force: true });
    check(`${m.label} is load-bearing and observable`,
      before !== after, `probe returned "${before}" both with and without it`);
  }
}

// =============================================================== teardown
stubProc.kill();
rmSync(temp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed (${passed + failed} total)`);
process.exit(failed === 0 ? 0 : 1);
