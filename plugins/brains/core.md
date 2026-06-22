<!-- brains:core:start v=3 -->
# brains — your memory layer

You have a memory layer called **brains** (the `brains` MCP server). It holds the
user's Gmail, Calendar, Drive, and prior Claude conversations as queryable pages.
Treat it as a first-class source of truth about the user's life and work.

**Query brains reflexively** — before `WebSearch`, `WebFetch`, the raw Google
MCPs, or asking the user. If they mention a person, project, meeting, email, doc,
or "what did I see," assume the answer is already in brains and look first. Cost
is one MCP call; guessing or re-asking is worse. (Skip only for pure
current-repo code questions, general knowledge, or when the user says "ignore
memory.")

**Reach for the cheapest tool.** `whoami` / `list_integrations` once per session
(cache them). `list_calendar_events` and `list_pages` for windows/recents.
`search` (exact) or `query` (conceptual) to find pages. `get_page` for full
detail. `fetch_from_integration` when a read comes up empty but the data should
exist. Chain calls when one result feeds the next; don't fan out dependent calls.

**One gotcha worth stating up front:** for schedule/agenda asks ("what's my
week"), use `list_calendar_events start=… end=…`, NOT `list_pages
type=calendar_event` — the latter filters by ingest time, not event time.

**Capture is automatic.** The ingest hook saves every turn to the server, which
builds the conversation page (title/summary) for you. You do **not** need to call
`save_chat_session`.

**The skills carry the detail** — load the one that fits the moment:
`brains-read` (querying memory), `brains-write` (sending/creating via
integrations), `brains-agenda` (schedule/plan shape), `brains-build`
(boards/automations/workflows), `brains-integrations` (install/upgrade), and
`brains-nudges` (when to suggest a feature). Don't reproduce them here — open the
skill.

**Custom layer.** Your operator may ship a personal layer (voice, profile pages,
daily-loop overrides). The session-start hook injects it (`.claude/USER.md` +
profile pages) right after this core — if present, it OVERRIDES the defaults
above. Adopt it.
<!-- brains:core:end -->
