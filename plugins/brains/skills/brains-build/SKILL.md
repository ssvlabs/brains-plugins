---
name: brains-build
description: The catalog of higher-level brains features beyond search — boards, board skills, dataset recipes, dashboards, pages, automations, workflows, mini-sites, the Telegram bot, and the overnight digest. Use when the user wants to track a list, build a tracker/CRM, automate a recurring task, coordinate a goal with a team, publish a deck/one-pager, bulk-load a big CSV/spreadsheet into a board, or asks "what can brains do." Names the right feature and the flow tool to start it.
---

# brains feature catalog

Match the user's shape to a feature, then call its **`*_flow`** tool — the flow
returns its own playbook (purpose → structure → create → seed → wrap-up). Follow
the playbook one question per turn. Don't hand-roll the structure here; the flow
tools carry it.

| Feature | What it is | Reach for it when… | Start with |
|---|---|---|---|
| **Board** | Spreadsheet-like dataset on a brain; rows are JSON, shared & queryable | "track a list of…", "keep a table/CRM/pipeline of…", "log every X" | `create_board_flow` |
| **Board skill** | Named saved LLM action over a board's rows | "every row, do X", "summarize/score/enrich each row", repeated lookup | `create_board_skill` |
| **Bulk upload** | Load a large or arbitrary-format file (CSV/xlsx/JSON, thousands of rows) into a board *without* reading it into context — a local script streams the rows | "import this big CSV/spreadsheet", "load these N-thousand rows into a board", "bulk-upload my data" | `create_import_grant` → local script → `bulk_append_rows` (see below) |
| **Automation** (feed board) | An automation that fetches from email/cal/drive on a cron and appends rows | "run this nightly and feed a board", "keep this list fresh from email/cal/drive" | `create_automation_flow` |
| **Dashboard** | A live, interactive view of a board — you design and author it as a full HTML app | "make me a dashboard", "show this as cards/kanban/chart", "build me this app on my board", "change the dashboard" | `get_dashboard` → **follow the `skill` it returns** → `set_dashboard` |
| **Page** | First-class note in a brain | "save this as a note", "keep this writeup findable" | `create_page` |
| **Automation** | Sandboxed TS program on a cron schedule with a scoped token | "every morning do X", "auto-draft Y when Z", anything re-prompted on a timer | `create_automation_flow` |
| **Workflow** | Goal container: charter + KPIs + deadlines + roster + owned board + paused template automations; one status flip pauses/un-pauses all | "ship X by Q3", "coordinate this initiative with a team & deadline" | `create_workflow_flow` |
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

Always use the **`*_flow`** tool for create/setup/scaffold asks — using
`create_board` / `create_automation` / `create_workflow` directly skips the
playbook and yields a structure that doesn't fit. Use the bare tools only when
reproducing an existing entity verbatim or when the playbook tells you to.

## Bulk-loading a large file into a board

When the user wants to load a big or messy file (CSV/TSV/xlsx/JSON/NDJSON —
hundreds to thousands of rows) into a board, do **not** read the file into your
context and append row-by-row; that spends tokens on the data itself. Instead:

1. `create_import_grant` for the target board + dataset → an ephemeral `imp_`
   token that can ONLY append to that one board/dataset, for a short TTL.
2. Write a **local script** that parses the file and POSTs the rows to
   `bulk_append_rows` in NDJSON batches (≤5000/call), passing the grant token as
   its Bearer credential. Derive the column mapping once from a small sample.
3. Run the script — the full file never enters your context.

A grant is least-privilege: a leaked one can only append to that single
board/dataset until it expires. Call `bulk_append_rows` with a full token
directly only for a small, already-in-context append.
