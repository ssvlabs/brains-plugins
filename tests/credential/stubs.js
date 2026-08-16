// Stub endpoints for tests/credential/run.ts.
//
// This runs as a SEPARATE PROCESS, and that is load-bearing rather than
// stylistic. Every assertion in the suite drives the hooks through spawnSync,
// which blocks the test process's event loop — so a stub served from inside
// that process could never answer the request it exists to answer. The suite
// would deadlock rather than fail, and a hang reports nothing at all.
//
// Usage: node stubs.js <hits-log> <primary-port> <other-port> <truncator-port>
const http = require("http"), net = require("net"), fs = require("fs");
const LOG = process.argv[2];
const PRIMARY = Number(process.argv[3]), OTHER = Number(process.argv[4]), TRUNCATOR = Number(process.argv[5]);
const log = (port, req, body) => fs.appendFileSync(LOG, JSON.stringify({
  port, method: req.method, path: (req.url || "").split("?")[0],
  auth: req.headers.authorization || "", bodyLen: body.length,
}) + "\n");
const mk = (port, handler) => http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => { b += c; });
  req.on("end", () => {
    log(port, req, b);
    const r = handler(req.url || "");
    res.writeHead(r.code, { "content-type": "application/json" });
    res.end(r.body);
  });
}).listen(port, "127.0.0.1");
mk(PRIMARY, (p) => {
  if (p.startsWith("/forbidden")) return { code: 403, body: '{"error":"forbidden"}' };
  // Returns something the inbox engine must ACK, so a test can exercise the
  // acknowledgement path — and therefore its credential lease.
  if (p.startsWith("/inbox/ackable")) return { code: 200, body: JSON.stringify({ context_items: [{ kind: "k", key: "v" }], actions: [] }) };
  if (p.startsWith("/inbox/claude/devices")) return { code: 200, body: JSON.stringify({ device_id: "dev-1" }) };
  if (p.startsWith("/inbox/claude")) return { code: 200, body: JSON.stringify({ actions: [] }) };
  return { code: 200, body: '{"ok":true}' };
});
mk(OTHER, () => ({ code: 200, body: '{"ok":true}' }));
// Valid headers plus a COMPLETE, parseable JSON prefix, then the socket dies.
// curl reports 200 for this, because the status is written the moment headers
// arrive — only its exit status reveals that the body never finished.
net.createServer((s) => {
  s.on("data", () => {
    s.write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 400\r\n\r\n");
    s.write('{"device_id":"d1"}');
    setTimeout(() => s.destroy(), 80);
  });
}).listen(TRUNCATOR, "127.0.0.1");
