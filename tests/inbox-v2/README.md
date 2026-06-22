# tests/inbox-v2

Deep test harness for the brains plugin's inbox engine + the
`/inbox/claude` server contract.

```
bun run tests/inbox-v2/run.ts
```

The harness spins up an in-process stub HTTP server that impersonates
the brains MCP `/inbox/claude` endpoint, points the plugin's inbox engine
(`plugins/brains/hooks/lib/brains-inbox.sh`) at it via
`BRAINS_INBOX_URL`, runs each scenario in an isolated temp state dir, and
asserts on stdout + the acks the hook posts.

This avoids needing the full brains backend
running. It tests exactly the contract between server and hook —
the inbox engine's only public surface.

## Coverage

Every scenario drives the plugin's `lib/brains-inbox.sh`. Scenarios 01–24
exercise the shared notification/prompt/context/ack contract:

- 01 notification → banner + auto-ack, NO claude context
- 02 prompt → verbatim body in stdout, NOT auto-acked
- 03 server-supplied `context` field is emitted to stdout
- 04 mode=prompt filters out prompt actions
- 05 mode=stop suppresses stdout entirely (banners still fire)
- 06 mixed pull (notification + prompt) handled correctly
- 07 empty inbox is a no-op
- 08 malformed payload (missing body) silently ignored
- 09 unknown type silently ignored
- 10 device report sent only on startup
- 11 shell metachars in prompt body are NOT evaluated
- 12 utf-8 multibyte content (incl. RTL) survives banner + injection
- 13–24 large/bulk/sequential bodies + context_items ack round-trips

Scenarios 25–31 cover the plugin-only surface — the semver report and the
drift-aware update / auto-update nudge:

- 25 plugin hook reports `plugin_version` + core marker; no drift → no nudge
- 26 drift in devices response → ONE `<!-- brains:update -->` nudge line
- 27 drift nudge fires only on startup, never on prompt/stop
- 28 drift with ONLY non-core sections → NO nudge (no false positive)
- 29 auto-update OFF → nudge once + report `auto_update=false`; 2nd run silent
- 30 auto-update ON → no nudge + report `auto_update=true`
- 31 marketplaces file missing → no nudge + report omits `auto_update`

The plugin scenarios pin `BRAINS_MARKETPLACES_JSON` to a temp path so
auto-update detection never reads the developer's real `~/.claude`.

## Optional end-to-end smoke test with `claude`

`run.ts` is the source of truth. It is **not** wired into CI — run it
manually. For a higher-fidelity check, the standalone scripts in this dir
point a real `claude -p` session at the stub (they cost tokens and are
non-deterministic, so they're manual-only):

```bash
bun run tests/inbox-v2/live-claude.ts                # prompt body reaches the model
bun run tests/inbox-v2/demo-approval-followthrough.ts # approval-ask follow-through rate
bun run tests/inbox-v2/demo-safety-limit.ts           # prompt-injection safety reflex
```

Each wires the plugin's `brains-start.sh` SessionStart hook into a temp
config via `--settings` and redirects hook state to a temp dir via
`BRAINS_STATE_DIR`, leaving the developer's real `~/.claude` untouched.
