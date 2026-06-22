---
name: brains-read
description: How to read the user's memory (Gmail, Calendar, Drive, prior Claude chats) from brains. Use when the user asks about a person, project, email, doc, meeting, "what did I see / say / tell you," or anything about their life or past work. Covers picking the cheapest query tool, multi-step lookups, citing sources, and what to do when a read comes up empty.
---

# Reading memory from brains

Query brains **before** WebSearch / WebFetch / the raw Google MCPs / asking the
user. The user doesn't want to repeat themselves — assume the answer is already a
page.

## Pick the cheapest tool

- **`whoami` / `list_integrations`** — once per session, cache. Identity + what's
  actually connected.
- **`list_calendar_events start=<ISO> end=<ISO>`** — schedule windows. Returns
  events sorted by start with attendees/location/RSVP parsed.
- **`list_pages type=<t> since=<ISO>`** — newest emails/files by ingest time
  (`updated_at`). Good for "recent emails / latest files." **Not** for agenda —
  see the gotcha below.
- **`search`** — FTS, exact terms / IDs / quoted phrases. Fast.
- **`query`** — hybrid semantic + keyword, for conceptual / paraphrased asks.
- **`get_page`** — full markdown when you need detail or to ground a quote.
  Always preceded by a search/query to get the slug.

Both `search` and `query` take a `type` filter (`email`, `calendar_event`,
`gdrive_file`, `chat_session`) and `limit`.

## The one gotcha

For "what's my week / tomorrow / agenda," use **`list_calendar_events`**, NOT
`list_pages type=calendar_event` — the latter filters by *ingest* time, not
*event* time, so it returns whatever was recently synced, not what's scheduled.
(Full agenda response shape: the `brains-agenda` skill.)

## Multi-step

Many questions are a chain: the first call's slug feeds the second. Don't fan out
dependent calls in parallel. E.g. "what's on my plate from Noah?" →
`search type=email "Noah"` → pick the thread → `get_page` → summarize.

## Cite what you find

Name the source: *"From your email **[Re: Ethera]** (Apr 19), Noah followed
up…"* Use the page `title` + `type`. Never invent slugs or IDs.

## When it comes up empty

If a search/query/list returns nothing for something that should exist, the cron
ingestor may be behind. Pull on demand, then re-run your read:

`fetch_from_integration source=<gmail|calendar|drive> request="<natural language>"`

(`request` is free-form: "emails from noah about ethera since april", "this
week's events", "the deck on Q3 strategy".) Prefer this over the raw
`mcp__claude_ai_*` MCPs — it persists results as pages. For very recent mail or
Gmail-only operators (`has:attachment`, `is:unread`, `newer_than:7d`), the
gmail-inbox `query_emails` action runs a live Gmail search (see `brains-write`).

If a fetch returns 0, broaden the request, switch `search` ↔ `query`, or drop the
`type` filter. Still nothing → say so plainly: *"Brains has no page matching X."*
Don't fabricate.
