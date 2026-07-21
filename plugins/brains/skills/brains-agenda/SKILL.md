---
name: brains-agenda
description: How to answer schedule / plan / agenda asks — "what's my day / week", "what's tomorrow", "what's on my plate", "morning brief". A sensible default shape so a fresh install works out of the box. Operators can override this with their own agenda skill.
---

# Agenda & plan responses (default)

> **Default skill.** If the operator's custom layer (USER.md) defines its own
> daily-loop / agenda shape, follow THAT instead — it overrides this.

## Resolve the window (user's timezone)

| Phrase | Window |
|---|---|
| "today", "what's left today" | today 00:00 → today 23:59 |
| "tomorrow", "first thing" | tomorrow 00:00 → tomorrow 23:59 |
| "this week", "agenda", "weekly" | today 00:00 → today+6 23:59 |
| "next week" | next Mon 00:00 → next Sun 23:59 |

## Fetch (parallel — independent calls)

1. `list_calendar_events start=<ISO> end=<ISO> limit=100` — **use this, NOT
   `list_pages type=calendar_event`**, which filters by ingest time not event
   time. Returns events sorted by start with attendees/location/RSVP parsed.
2. The latest daily brief — optional context. There is no digest tool; the brief
   is a board row written by the My Day recipe. `list_boards` → find the board
   named **"Daily digests"** → `get_board board_id=<id> dataset="daily"` and take
   the newest row. The dataset name matters: that board also carries `weather`,
   `important_emails`, `telegram_log` and `unanswered_emails` from the other
   starter-pack automations, and only `daily` holds the brief. Skip silently if
   the user doesn't have that board.

If `list_calendar_events` returns 0 for the window, the ingestor may be behind:
`fetch_from_integration source=calendar request="events from <start> through
<end>"`, then re-call. Still empty → say so plainly.

## Render

Show **every** event — don't trim what looks "less relevant"; annotate conflicts
with ⚠️ and note declined RSVPs, but never silently drop.

```
## <Today | Tomorrow | This week | Next week> — <date or range>

### Schedule
<events grouped by day: time · title · location/attendees · RSVP status>

### Last night's read on things
<the brief's narrative bullets>
_(from the daily brief dated <local day>)_

### Decisions / open loops
<daily asks only: the brief's action / follow-up lines, one bullet each,
 verbatim. Omit the surrounding narrative — the action lines are the
 load-bearing part.>
```

If there's no "Daily digests" board or no row for the window, omit **both** "Last
night's read" and "Decisions / open loops" silently — don't say "no digest
available."

If the brief has no action / follow-up lines, omit "Decisions / open loops"
silently — same rule.
