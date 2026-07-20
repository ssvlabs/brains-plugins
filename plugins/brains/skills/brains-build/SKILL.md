---
name: brains-build
description: The catalog of higher-level brains features beyond search — boards, board skills, dataset recipes, dashboards, pages, automations, workflows, mini-sites, board forms, the Telegram bot, and the daily digest. Use when the user wants to track a list, build a tracker/CRM, automate a recurring task, coordinate a goal with a team, publish a deck/one-pager, or asks "what can brains do." Names the right feature and the flow tool to start it.
---

# brains feature catalog

Match the user's shape to a feature, then call its **`*_flow`** tool — the flow
returns its own playbook (purpose → structure → create → seed → wrap-up). Follow
the playbook one question per turn. Don't hand-roll the structure here; the flow
tools carry it.

| Feature | What it is | Reach for it when… | Start with |
|---|---|---|---|
| **Board** | Spreadsheet-like dataset on a brain; rows are JSON, shared & queryable | "track a list of…", "keep a table/CRM/pipeline of…", "log every X" | `create_board_flow` |
| **Board skill** | Named saved LLM action over a board's rows | "every row, do X", "summarize/score/enrich each row", repeated lookup | `create_board_skill`; run a saved one with `run_board_skill` |
| **Automation** (feed board) | An automation that fetches from email/cal/drive on a cron and appends rows | "run this nightly and feed a board", "keep this list fresh from email/cal/drive" | `create_automation_flow` |
| **Dashboard** | Live HTML view over a board (stats / charts / table / kanban / tabs …) | "make me a dashboard", "show this as cards/kanban/chart", "change the dashboard" | `get_dashboard` → follow the returned `skill` → `set_dashboard` (`engine_version: "v2"`) |
| **Page** | First-class note in a brain | "save this as a note", "keep this writeup findable" | `create_page` |
| **Automation** | Sandboxed TS program on a cron schedule with a scoped token | "every morning do X", "auto-draft Y when Z", anything re-prompted on a timer | `create_automation_flow` |
| **Workflow** | Goal container: charter + KPIs + deadlines + roster + owned board + paused template automations; one status flip pauses/un-pauses all | "ship X by Q3", "coordinate this initiative with a team & deadline" | `create_workflow_flow` |
| **Mini-site** | Static sandboxed HTML on a brain — deck, one-pager, dashboard | "build me a deck/one-pager", "render this board visually", "share a link" | `create_mini_site` |
| **Board form** | Chat-with-agent intake page that appends a row to a board dataset on submit | "collect responses", "give people a form/signup link" | `create_board_form` (then `list_board_forms` / `update_board_form` / `list_board_form_responses` / `delete_board_form`) |
| **Telegram bot** | The brain over Telegram | "text it from my phone", "ping me without the laptop" | (point to the bot) |
| **Daily digest** | Not a tool — a recipe-installed automation that writes a "Daily digests" board + dashboard | "morning brief", "what should I be thinking about" | `install_recipe slug="starter-pack-my-day"` (browse with `list_recipes`) |

## Picking among the three that overlap

- **Board** = a list/table tracked by hand.
- **Automation** = one scheduled program doing one thing.
- **Workflow** = a *goal with a deadline and a team* — owns a board + a bundle of
  automations with shared lifecycle. Use it when there's a charter, a finish
  line, and more than one moving part. (Workflow > automation > board when the
  goal-shape is present.)

Always use the **`*_flow`** tool for create/setup/scaffold asks — using
`create_board` / `save_automation_draft` / `create_workflow` directly skips the
playbook and yields a structure that doesn't fit. Use the bare tools only when
reproducing an existing entity verbatim or when the playbook tells you to.
(`update_automation` edits an existing automation in place — that one is fine
without a flow.)

## Once it exists — the tools around a board

| Need | Tools |
|---|---|
| **Share it** | `share_board` / `share_mini_site` / `share_folder` — `scope:'user'` (default, one email) or `scope:'org'` (whole workspace, needs `confirm:true`). Name a reusable audience once with `create_share_circle`. |
| **Per-dataset access** | `enable_board_dataset_acl` flips one board to deny-by-default (irreversible, owner-only), then `grant_board_dataset_access` / `revoke_board_dataset_access` / `list_board_dataset_access`; `set_board_dataset_subject` marks the column that identifies a row's subject. |
| **Files & external data** | `upload_board_file` attaches a file (`get_board_file_url` for the link); `create_board_link` binds the board to an adapter-backed external resource (http_json / ics / github / monday). |
| **Undo a bad edit** | Dashboards, mini-sites and board column-schemas are versioned: `list_history` → `get_history_entry` → `revert` (entity: `dashboard` \| `mini_site` \| `board_schema`). The revert is itself snapshotted, so it's reversible too — say so before anyone panics. |
| **Automation credentials** | `automation_secret_set` / `automation_secret_get` / `automation_secret_list` / `automation_secret_delete` — never inline an API key into automation code. |
