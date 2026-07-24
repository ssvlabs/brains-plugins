---
name: brains-write
description: How to take ACTIONS on the user's integrations through brains — send an email, create a calendar event, make a Drive doc, comment on a Monday item, run a live Gmail search, post a message. Use whenever the user wants to send/create/reply/forward/mark/schedule something, or "message/ping/DM" someone. Covers the codex action flow and the draft→confirm gate.
---

# Acting on integrations (writes)

Codex-first. Each connected integration declares its own actions; discover and
dispatch them generically. Fall back to the legacy source-enum only when no codex
action matches.

## The codex path (preferred)

1. **Discover** — `query type=integration_action text="<natural-language intent>"`.
   Returns ranked `integration_action` pages. Each carries, in frontmatter:
   `install_id`, `action_name`, `description`, `input_schema`,
   `requires_confirmation`, and `examples` (strong hints for shaping `input`).
2. **Dispatch** — `act_on_integration install_id=<…> action_name=<…> input={…}`
   (input matches `input_schema`; do not send a free-form `request`).
   Build `input` yourself from the user's words; if the ask is fuzzy, the
   discovery `query` + the action's `examples` tell you which action and shape.

### Two return kinds — know which is the success state

- **`requires_confirmation: false`** → executes inline now, returns
  `{kind:"auto_executed", result, audit_id}`. **Done** — do NOT try to confirm
  it. Read-only / reversible actions live here (gmail `query_emails`,
  `mark_read`, `add_labels`; monday `add_comment`; …).
- **`requires_confirmation: true` (or undefined = default)** → returns
  `{kind:"draft", draft_id, preview, confirm_hint, expires_at}`. Relay the
  `preview` and `confirm_hint`, then stop. The user confirms or discards through
  the real controls in `/inbox` (web/mobile) or Telegram. Do **not** call
  `confirm_action` from this agent loop. Destructive sends (email, calendar
  invite, doc create) live here. Drafts expire in 1 hour.

The out-of-band surfaces hold the confirmation capability; this chat does not.

### Live Gmail search

gmail-inbox ships `query_emails` (`requires_confirmation: false`) — runs native
Gmail search at runtime for mail the ingested pages don't cover. `input={query:
"<gmail syntax>", limit: 1..50}`. Reach for it AFTER `list_pages`/`search` come
up short, not before.

## Legacy structured fallback

If discovery returns a legacy source-bound action, dispatch the same structured
`action_name` + `input` with its `source` instead of `install_id`. Never replace
the tuple with a free-form `request`.

## Routing a generic "message someone"

No hardcoded default channel. For a
generic "send a msg / message X / ping / DM" with no channel named, use the codex
discovery above (`query type=integration_action`) and dispatch to whichever
messaging integration the user actually has connected. Use `gmail` only when they
say "email," give an email address, or are replying to/forwarding a thread.
`calendar`/`drive` only when explicit.

**Always relay a destructive action's preview and confirmation hint, then leave
the decision to the user's out-of-band approval surface.**
