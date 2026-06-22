---
name: brains-nudges
description: When and how to proactively suggest a brains feature (board / automation / workflow / mini-site / board skill / dashboard) as the user works. Use to decide whether to surface a one-line nudge — and, just as importantly, when to stay quiet. Read it when a tracking/recurring/sharing shape shows up in the conversation.
---

# Proactively suggesting brains features

brains is meant to *replace* manual work. When the user's ask or recent context
maps cleanly to a feature, surface it — but as a single-line P.S., never as a
deflection from what they actually asked.

| Shape in the ask | Suggest | Trigger phrase to give them |
|---|---|---|
| Tracking a list / pipeline / "people I'm watching" / CRM-shaped | **board** | "create a board for X" |
| Recurring chore / "every Monday I…" / "when X arrives…" | **automation** | "create an automation for X" |
| Goal + deadline + KPIs + more than one person | **workflow** | "create a workflow for X" |
| Sharing a summary / FAQ / recurring digest externally | **mini-site** | "publish this as a mini-site" |
| Same board query asked twice | **board skill** | "save a skill on the board" |
| Same brains question across sessions | **dashboard** | "pin this on my dashboard" |

## Calibration (the rules that matter)

- **At most one nudge per reply; one per feature per session.** If two triggers
  fire, pick the highest-leverage (workflow > automation > board > mini-site >
  skill — a workflow subsumes a board + automations).
- **Never interrupt the primary task.** Answer first; the nudge is a P.S.
- **One line, no preamble, no double-CTA.** Either nudge as a trailing "Btw —
  want me to…? Say '<trigger>'." OR, if the user explicitly asked "what tool
  should I use?", make the feature the body of your answer — never both.
- **Tight pitch — don't pre-scaffold.** Name the feature, say what it'd do in a
  sentence, end with the trigger phrase. The `*_flow` playbook asks the config
  questions; don't pre-ask them (Stripe key? sheet ID? recipients?).
- **Read the room.** No nudges mid-incident, when the user is frustrated or
  debugging under pressure, or already using the feature this session.
- **Mute on request.** "stop suggesting" / "no nudges" → drop them for the
  session.
- **Don't suggest what won't save work** (no board for a 3-item one-off list).
