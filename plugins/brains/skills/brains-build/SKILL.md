---
name: brains-build
description: The catalog of higher-level brains features beyond search — boards, board skills, dataset recipes, dashboards, pages, automations, workflows, mini-sites, the Telegram bot, and the overnight digest. Use when the user wants to track a list, build a tracker/CRM, automate a recurring task, coordinate a goal with a team, publish a deck/one-pager, or asks "what can brains do." Names the right feature and the flow tool to start it.
---

# brains feature catalog

Match the user's shape to a feature, then call **`create_flow({ kind })`** — the
flow returns its own playbook (purpose → structure → create → seed → wrap-up).
Follow the playbook one question per turn. Don't hand-roll the structure here;
the flow carries it. `kind` is one of `'board'`, `'automation'`, `'workflow'`.

| Feature | What it is | Reach for it when… | Start with |
|---|---|---|---|
| **Board** | Spreadsheet-like dataset on a brain; rows are JSON, shared & queryable | "track a list of…", "keep a table/CRM/pipeline of…", "log every X" | `create_flow({ kind: 'board' })` |
| **Board skill** | Named saved LLM action over a board's rows | "every row, do X", "summarize/score/enrich each row", repeated lookup | `create_board_skill` |
| **Automation** (feed board) | An automation that fetches from email/cal/drive on a cron and appends rows | "run this nightly and feed a board", "keep this list fresh from email/cal/drive" | `create_flow({ kind: 'automation' })` |
| **Dashboard** | Live HTML view over a board (stats / charts / table / kanban / tabs …) | "make me a dashboard", "show this as cards/kanban/chart", "change the dashboard" | `get_dashboard` → follow the returned `skill` → `set_dashboard` (`engine_version: "v2"`) |
| **Page** | First-class note in a brain | "save this as a note", "keep this writeup findable" | `create_page` |
| **Automation** | Sandboxed TS program on a cron schedule with a scoped token | "every morning do X", "auto-draft Y when Z", anything re-prompted on a timer | `create_flow({ kind: 'automation' })` |
| **Workflow** | Goal container: charter + KPIs + deadlines + roster + owned board + paused template automations; one status flip pauses/un-pauses all | "ship X by Q3", "coordinate this initiative with a team & deadline" | `create_flow({ kind: 'workflow' })` |
| **Mini-site** | Static sandboxed HTML on a brain — deck, one-pager, dashboard | "build me a deck/one-pager", "render this board visually", "share a link" | `create_mini_site` |
| **Telegram bot** | The brain over Telegram | "text it from my phone", "ping me without the laptop" | (point to the bot) |
| **Overnight digest** | Auto daily/weekly read on what's coming up | "morning brief", "what should I be thinking about" | `get_overnight_digest` |

## Picking among the three that overlap

- **Board** = a list/table tracked by hand.
- **Automation** = one scheduled program doing one thing.
- **Workflow** = a *goal with a deadline and a team* — owns a board + a bundle of
  automations with shared lifecycle. Use it when there's a charter, a finish
  line, and more than one moving part. (Workflow > automation > board when the
  goal-shape is present.)

Always use **`create_flow({ kind })`** for create/setup/scaffold asks — calling
`create_instance({ kind, spec })` directly skips the playbook and yields a
structure that doesn't fit. Reach for `create_instance` only when reproducing an
existing entity verbatim (you already have the full spec in hand) or when the
playbook tells you to.

## Skipping the playbook — `create_instance` spec shapes

`create_instance({ kind, spec, ... })` is kind-dispatched. The `spec` shape:

- **`kind: 'board'`** — `spec: { name, datasets, ... }` (same shape as the old
  `create_board` input).
- **`kind: 'workflow'`** — `spec: { name, charter, kpis, deadlines, roster, ... }`
  (same shape as the old `create_workflow` input).
- **`kind: 'automation'`** — `spec: { name, source, triggers, tool_grants,
  cost_cap_daily_usd?, max_wall_seconds?, max_llm_tokens?,
  egress_cap_daily_mb?, model?, writes_to_boards?, dedupe_target_field?,
  dedupe_key_field?, acknowledged_overlap?, coexistence_note?,
  acknowledged_http_fetch_hosts? }`. Two hard gates the runtime enforces:
  **overlap detection** (if another automation already covers the same source +
  trigger filter, you must set `acknowledged_overlap: true` and pass a
  `coexistence_note`) and **http_fetch host re-confirmation** (if `tool_grants`
  includes `http_fetch`, pass `acknowledged_http_fetch_hosts` listing every
  destination host the program will call). These match the old
  `save_automation_draft` gates — they didn't go away.
- **`kind: 'integration'`** — `spec: { slug, account_id? }`. See the
  `brains-integrations` skill for the OAuth envelope; for boards/automations/
  workflows you almost never want this branch.

Lifecycle siblings — `update_instance({ kind, id, patch })`,
`delete_instance({ kind, id })`, `get_instance({ kind, id })` — are kind-
dispatched too. For paged row reads on a board (filter / projection / offset /
limit), keep using `get_board(board_id, dataset, filter?, fields?, offset?,
limit?)` — that one was kept public because its dataset-paged-read semantics
aren't just metadata.
