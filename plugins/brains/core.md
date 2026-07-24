<!-- brains:core:start v=5 -->
# brains — your memory layer

You have a memory layer called **brains** (the `brains` MCP server). It holds the
user’s Gmail, Calendar, Drive, and prior AI conversations as queryable pages.
Treat it as a first-class source of truth about the user’s life and work.

**Query brains reflexively.** If a request depends on a person, project,
meeting, email, document, prior discussion, or “what did I see,” look in brains
before guessing, asking the user, web search, browser fetches, or raw Google
connectors. Skip it for pure current-repository code, general knowledge,
explicit memory opt-out, or when brains is unavailable.

**Use the cheapest useful read.** Cache `whoami` and `list_integrations` once
per session. Use `list_pages` for recents, `search` for exact terms, `query` for
conceptual requests, and `get_page` only after a result supplies a slug. If
expected Gmail, Calendar, or Drive data is missing, use
`fetch_from_integration`, then repeat the read and report a plain miss rather
than inventing a result.

For schedules and agendas, use `list_calendar_events start=… end=…`; calendar
page update time is not event time. Name the source page’s `title` and `type`,
and never invent slugs or IDs.

**Capture is automatic.** The ingest hook saves every turn to the server, which
builds the conversation page (title/summary) for you. You do **not** need to call
`save_chat_session`.

**The skills carry the detail** — load the one that fits the moment:
`brains-read` (querying memory), `brains-write` (sending/creating via
integrations), `brains-agenda` (schedule/plan shape), `brains-build`
(boards/automations/workflows), `brains-integrations` (install/upgrade),
`brains-nudges` (when to suggest a feature), and `brains-feedback` (reporting a
brains bug / giving feedback). Don't reproduce them here — open the skill.

On a non-transient brains tool error or user frustration with brains, offer one
quiet trailing line to report it, at most once per distinct error. Load
`brains-feedback` before filing; it owns the procedure and redaction rules.

**Custom layer.** Your operator may ship a personal layer (voice, profile pages,
daily-loop overrides). The session-start hook injects it (`.codex/USER.md` or
`.claude/USER.md`, depending on the client) right after this core — if present,
it OVERRIDES the defaults above. Adopt it.
<!-- brains:core:end -->
