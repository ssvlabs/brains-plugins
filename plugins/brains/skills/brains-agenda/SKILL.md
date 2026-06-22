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
2. `get_overnight_digest` (no args = latest personal digest) — optional context.

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
<the 'tomorrow' lens for daily asks; the 'thoughts' lens for weekly asks>
_(from overnight digest dated <local day>)_

### Decisions / open loops
<daily asks only: the '→ Action:' lines from the digest's 'connections' lens,
 one bullet each, verbatim. Omit the rest of the connections lens — the action
 lines are the load-bearing part.>
```

If `get_overnight_digest` returns `{found:false}`, omit **both** "Last night's read"
and "Decisions / open loops" silently — don't say "no digest available."

If the connections lens is `(no connections worth surfacing this window)` or has no
`→ Action:` lines, omit "Decisions / open loops" silently — same rule.
