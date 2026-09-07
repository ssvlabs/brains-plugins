---
name: brains-read
description: How to read the user's memory (Gmail, Calendar, Drive, prior AI chats) from brains. Use when the user asks about a person, project, email, doc, meeting, "what did I see / say / tell you," or anything about their life or past work. Covers the SELECT-vs-SEMANTIC choice, picking the right per-arm search tool for the collection (query_pages / query_rows / query_boards / query_mini_sites) and which legs and filters to pass, multi-step lookups, citing sources, and what to do when a read comes up empty.
---

# Reading memory from brains

Query brains **before** WebSearch / WebFetch / the raw Google MCPs / asking the
user. The user doesn't want to repeat themselves — assume the answer is already a
page.

## The retrieval protocol

Where this text and a tool's live schema differ on a parameter name or value,
**the schema is authoritative** — read it, don't guess.

### 1. Decide the kind of question first

- **SELECT** — the answer is pinned by *filters*: a board, an id, a page type,
  a date range, a status. Use a **structured read**. A structured read
  computes no embedding and does no ranking-by-meaning; it returns exactly the
  rows the filters admit. Don't rank what you can select: if you can write the
  filter, write the filter.
  - `query_board_rows` — a board's rows, filtered and sorted.
    `get_board_row` for one you can name.
  - `list_pages` — pages by type and time window. `list_calendar_events` —
    a schedule window (see the gotcha below).
  - `get_page` / `get_board` / `get_mini_site` — one item by its handle.
  - `whoami` / `list_integrations` — once per session, then cache.

- **SEMANTIC** — filters would leave too much to read, or the question is about
  *meaning* ("what was the problem with…", "anything about…"). Use **one ranked
  search**, chosen by the **collection** the answer lives in:

  | the answer is a… | tool |
  |---|---|
  | document (mail, calendar, file, PR, chat, note, …) | `query_pages` |
  | board row (a task, a finding, an item) | `query_rows` |
  | board itself ("which board tracks X") | `query_boards` |
  | published write-up | `query_mini_sites` (`grain:'section'` returns sections, not sites — more, smaller items; it is not a scope) |

  `query_rows` and `query_board_rows` read the same rows: the first ranks by
  meaning, the second selects by filter. Prefer the second whenever it can
  answer.

### 2. One arm per question

Each of the four arms (`query_pages` / `query_rows` / `query_boards` /
`query_mini_sites`) ranks **one** collection. Rankings from different
collections are not comparable and no tool merges them. Call one arm for a
question. Call two only when the question genuinely spans collections ("the
email *and* the board item about X") — issue both in the same turn and merge
the two lists yourself, presenting them as what they are.

### 3. Shape the call: scope first, then legs

- **Scope.** Every filter the tool exposes (a page type, a board) narrows what
  is searched. Common page types: `email`, `calendar_event`, `gdrive_file`,
  `chat_session`, `gh_pr` (not exhaustive — an unknown type returns an empty
  list, not an error). Pass every one you know: a scoped search is more
  complete *and* faster, and the result reports whether it may be incomplete
  (`approximate: true`) — when it is, **scope harder** if the arm has a scope
  (`query_boards` and `query_mini_sites` have none: say the coverage may be
  incomplete instead), don't re-send the same text.
- **Legs.** `legs` selects retrieval strategies. The protocol guarantees:
  - `legs.vec:false` is a **keyword-only** search that makes **no embedding
    call** — the route for an exact identifier (a PR number, a ticket id, a
    quoted phrase). Don't send `cutoff` (or `entity`) with it — they have no
    meaning there; `query_pages` rejects them, the other arms ignore them.
  - Otherwise all legs are on (hybrid). Drop `keyword` for purely conceptual
    text; the entity leg (pages only) needs the semantic leg.
- **`limit`** caps the returned list. **`cutoff:false`** disables the statistical
  trim, so the ranked list is returned up to `limit` instead of only its
  significant head.

### 4. What a response guarantees

Every response from the four arms (`query_pages` / `query_rows` /
`query_boards` / `query_mini_sites`) is `{ items, count, fetch_with, timing_ms, … }`:
`items` in ranked order, `count` = its length, and `fetch_with` naming the tool
and handle that reads one item in full. Some arms add `approximate` (results may
be incomplete under the current scope) and `candidates` (how many were ranked
before the cutoff). Treat any other field as informational, not as contract.

### 5. Compatibility

If `query_pages` / `query_rows` / `query_boards` / `query_mini_sites` are not in
the tool list, the server predates this protocol — fall back to `query` (ranked
across all collections at once) and `search` (pages, keyword — note it takes
`query=`, not `text=`).

## The one gotcha

For "what's my week / tomorrow / agenda," use **`list_calendar_events`**, NOT
`list_pages type=calendar_event` — the latter filters by *ingest* time, not
*event* time, so it returns whatever was recently synced, not what's scheduled.
(Full agenda response shape: the `brains-agenda` skill.)

## Multi-step, and evolve — don't retry

Many questions are a chain: the first call's handle feeds the second. Don't fan
out dependent calls in parallel. E.g. "what's on my plate from Noah?" →
`query_pages type=email text="Noah" legs={vec:false}` → pick the thread →
`get_page` → summarize.

The same call twice against the same data is a bug (re-running after
`fetch_from_integration` is the exception). After a call comes back empty with
nothing clearly relevant, make the next one *different*: turn `vec` back on if
it was keyword-only, relax the cutoff if it was semantic (`query_pages` rejects
`cutoff` on `legs.vec:false`; the other arms ignore it), add or drop a scope, or
switch collection. Say "found nothing" only after the right arm, well scoped,
comes back empty — not after one empty call.

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

If a fetch returns 0, broaden the request, switch legs (`vec:false` ↔ hybrid;
`search` ↔ `query` on a server without the arms), switch collection, or widen
the scope. Still nothing → say so plainly: *"Brains has no page matching X."*
Don't fabricate.
