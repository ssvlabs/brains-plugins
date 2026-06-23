---
name: brains-feedback
description: Report a brains bug or send feedback about brains itself (a bug, idea, UX issue, confusion, praise) to the brains team. Use when the user runs /brains-feedback, accepts an offer to report an error, or clearly wants to give feedback ABOUT BRAINS. Carries the capture → preview → confirm flow, what context to attach (and what never to), and the ID-free acknowledgment.
---

# Reporting a brains bug / feedback

This is feedback about **brains itself** — not the user's work. It goes to a single
shared queue the brains team triages. The `submit_feedback` MCP tool does the filing
and already enforces the contract (consented intake, mandatory preview, hidden
priority, no exposed board/IDs); this skill is about *what to gather, what to attach,
and what never to attach* before you call it.

## Two ways you get here

1. **The user accepts an offer.** A brains tool errored (or they signalled
   frustration) and you offered a one-line report (see core). They reply "yes" / run
   `/brains-feedback` as their next move → this is about **that error**. Attach the
   error context you captured at the moment it happened.
2. **A cold `/brains-feedback`.** They invoked it on their own. It is
   **intent-neutral — attach nothing by default.** Ask once what they want to report.
   *Only* if a relevant error happened very recently (same exchange, still fresh) may
   you ask a single line: *"Is this about [one-line error], or something else?"* —
   never auto-attach it. Picking "something else" drops the error entirely.

> **Never staple stale or unrelated context.** The fastest way to ruin a feedback
> report is to attach an error the user doesn't care about. When unsure, attach
> nothing but their words.

## What to attach (small, redacted, theirs only)

The payload is deliberately tiny:
- **`title`** — one line, the user's summary.
- **`type`** — one of `Bug`, `Improvement`, `UX`, `Feature request`, `Praise`,
  `Confusion`.
- **`description`** — the report in the user's words, lightly cleaned.
- **`agent_notes`** *(optional, ≤8000 chars; only when reporting an error)* —
  agent-generated triage context: repro steps, a root-cause hypothesis, and the
  visible context (page/route, the recent error). Write it so it clearly reads as
  agent-generated. Redacted and this-session-only (see below).
- **`priority`** — internal triage signal only, one of `Urgent`, `High`, `Med`,
  `Low` (default `Med`); set it for the team but **never show or mention it to the
  user**.
- **`surface`** — `cli`.

Redact before filing:
- Strip secrets/tokens/bearer headers, full file paths with usernames, and email
  addresses from the error text.
- Capture **only this session** — the error and what *you* were doing. Never mine the
  user's brain, history, or other pages, and never include another user's data.
- Keep it to error + intent. No transcripts, no surrounding conversation.

## The flow

1. **Gather** — if they haven't described it, ask once (for a bug: expected vs actual
   / how to reproduce). One question, not an interrogation.
2. **Preview — always.** Show exactly what you'll file: title, type, a short summary,
   and, if an error is attached, the redacted error + intent as a clearly-labelled,
   **removable** line (*"Including the error from [what you were doing] — say so if
   that's unrelated and I'll drop it."*). Get an explicit "yes". Never auto-file.
3. **File** — call `submit_feedback` with the fields above. Set `priority` — one of
   `Urgent`, `High`, `Med`, `Low` (default `Med`) — for the team's triage only;
   **never show or mention it to the user**, in the preview or anywhere else.
4. **Acknowledge in one line, ID-free** — *"Thanks — I've passed that to the Brains
   team."* Do **not** show a filing number, a board name, or any internal structure.

## Batching

If several *distinct* errors came up in one session and the user wants to report them,
bundle them into one submission (one per error in `agent_notes`), one preview, one
confirmation — don't file a flurry.

## Don't

- Don't use this for the user's *own* tasks/notes (that's a board/page, not feedback).
- Don't file without the preview + "yes".
- Don't reveal priority, board ids, or a filing number.
- Don't attach anything beyond the error + intent + their words.
