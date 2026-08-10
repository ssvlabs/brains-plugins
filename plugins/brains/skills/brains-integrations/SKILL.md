---
name: brains-integrations
description: Managing which integrations the user has — listing what's connected (Gmail, Calendar, Drive, Monday, GitHub, …), and installing / upgrading / uninstalling them via codex recipes and the starter-pack bundle. Also covers authoring — publishing your own recipe to the catalog and managing it as a publisher. Use when the user asks "what's connected", "can brains read from X", wants to set up / add / update / remove an integration, or wants to publish a recipe of their own.
---

# Integration lifecycle

## Know what's connected (do this before suggesting a source)

`list_integrations` returns one row per known integration: `name`, `label`,
`connected`, `supports.{fetch,act,adapter}`, `description`. Caching it for the
session is fine, but re-read it after you install / pause / resume / uninstall
anything and after a source call fails on connection state — it's a live read,
and the cache goes stale exactly when it matters. Read it before proposing
`fetch_from_integration` / `act_on_integration`: those tools advertise a
**static** `source` enum listing every registered source whether or not this
user connected it, so presence in the enum proves nothing. No failure comes
either: an unconnected source returns a success-shaped fetch with
`ingested_count: 0` and a `note`, or an action with `kind: "noop"` and a
`reason`. Read those before treating empty as "nothing there" — then re-read
`list_integrations`, get the user to connect or resume at `/integrations`, and
retry. `list_integrations` is the per-user answer, and the canonical one to
"what integrations do I have."

## Browse the catalog

`list_recipes` enumerates what's installable. `tier` is `'catalog'` (the
default — the public catalog: platform-curated rows plus recipes other users
published publicly, so don't present a row as vetted; `owner_user_id: null` is
what marks a curated one), `'yours'` (the caller's own), or `'community'`
(other users' published ones); `kind` / `category` / `q` narrow it. Each row
carries the slug's current `version`. Use it to find slugs the user doesn't
already know rather than sending them to a browser. `recommend_recipes` picks a
few with an evidenced reason when they have no specific target in mind.
`/recipes` in the web UI is the same catalog with pictures.

## Install / re-install

- **One integration:** `install_integration slug=<recipe>`. none-auth installs
  immediately; api_key installs immediately when you pass `api_key`, and
  otherwise creates **no** install — it returns a `configure_url` for the user
  to enter the key on the web (never collect a key through chat); oauth2 and
  composio recipes return an `authorize_url` to open in a browser. Common
  slugs: `gmail-inbox`, `gcalendar`, `gdrive-files`, `github-issues`,
  `monday-items`. Idempotent — an already-installed recipe returns the existing
  install, and an oauth2 one still awaiting its handshake hands back the
  `authorize_url` again. A composio recipe does **not** replay that link: a
  pending re-call just reports "already installed", so send the user to
  `/integrations` to finish connecting.
- **Anything else, bundles included:** `install_recipe slug=<slug>
  brain_id=<uuid>` — boards, automations, workflows, integrations and bundles,
  missing dependencies auto-installed children-first, never duplicating rows on
  a re-run. Keep installs one-at-a-time — the dedup is a check-then-insert, so
  two overlapping calls can both insert; never retry while a previous call may
  still be running. `slug="starter-pack"` is the full bootstrap: two boards,
  seven automations, and the three Google integrations. Its oauth2 children land
  unauthorized and this call returns no link for them, so follow up with
  `install_integration` per oauth2 child to collect each `authorize_url` — or
  send the user to `/recipes/starter-pack` and let the web UI walk them
  through it.

## Upgrade

`list_installed_versions` returns one row per install — `{slug, name, kind,
version, state}`, `kind` being `automation`, `bundle` or `integration` (narrow
with `kinds`; boards and workflows never appear). Compare `version` against the
matching `list_recipes` row to spot drift, but treat it as a provenance stamp,
not proof of what's running: a re-apply advances it without necessarily
bringing the content along, so never conclude "already current" from equality
alone.

The upgrade itself runs through the web UI; there is no MCP upgrade tool, and
`install_recipe` is not a stand-in. A re-apply reuses the existing entity — it
restamps provenance, writes the automation's state (reviving an uninstalled
one, otherwise matching the template's paused/active), and overwrites an
un-customized board dashboard — but leaves the board's schema, rows,
description and recipe-shipped skills, the automation's intent, model, triggers
and grants, and a workflow's contents entirely, on the old version.

Where to send the user depends on the row's `kind`:

- `integration` → its install page, `/integrations/<install_id>`, whose upgrade
  banner is the authoritative check for this kind.
- `automation` → the recipe's own page, `/recipes/<slug>`, which carries a
  per-entity upgrade banner for a standalone install. Same page for a board or
  workflow you're checking by slug.
- `bundle` → `/recipes/<bundle-slug>`, which fans the upgrade across every
  child.

Children of a bundle deliberately show no upgrade of their own. For a
bundle-sourced integration the install page is authoritative: follow the bundle
link when it renders one, and take the standalone "Upgrade to vN" when it
renders that instead — it means the bundle path is a no-op while the leaf lags.
Never bypass the page by hand-reinstalling.

## Uninstall / manage

Over MCP: `uninstall_integration install_id=<uuid>` (revokes + wipes the
user's secrets for that install), `pause_integration` / `resume_integration`
(stop / restart cron firings), `list_my_integrations` (the user's codex
installs with slug, name, version and state), and `get_integration_status`
(one install's state, config overrides, and a sanitized `last_error`). Get the
`install_id` from `list_my_integrations`.

Tune an install instead of reinstalling it: `set_integration_config`
(installer-side config, e.g. which repos github-issues ingests),
`set_integration_overrides` (per-run / per-month limits — you can only lower
the recipe's caps, higher values are clamped down silently), and
`run_integration_once` for an on-demand test run instead of waiting for cron
(the install must be `active`).

The whole-recipe cascade is callable over MCP too: `preview_uninstall_recipe
slug=<slug> brain_id=<uuid>` shows the blast radius — entities stamped with
the slug, plus deps that would be orphaned — and mutates nothing, then
`uninstall_recipe` does it in one transaction, or takes `entity_id` instead to
drop a single entity. Always preview first for a bundle. Uninstalled boards,
automations and workflows sit in a 7-day recovery window; `list_uninstalled`
answers "what did I just uninstall" before they click Recover. Integration
installs are **not** in that window — uninstall revokes them outright, and
recovering one means installing it again.

## Authoring a recipe

Publishing is blocked on the autonomous surfaces (the web agent and Telegram),
so if the user wants to publish something of their own, here is where it
happens.

- **Start with the playbook, not a blank template.** To author an integration
  recipe, call **`create_integration_flow`** first — it returns the full
  IntegrationTemplate shape (auth, trigger, source, outputs, allowed_origins,
  tool_grants, …) as a playbook to follow. Do NOT hand-roll a template or guess
  at its fields; the spec lives in the playbook, not here.
- **Publish:** `publish_recipe` (kind-agnostic — board / automation / workflow /
  bundle / integration) or `publish_integration_recipe` (integration-specific).
  Both validate the template server-side and write nothing if it's invalid.
  `unpublish_recipe` / `unpublish_integration_recipe` pull a recipe from the
  catalog; existing installs are untouched — uninstall those separately.
- **Versioning is append-only.** A brand-new slug publishes at v1; re-publishing
  a slug you own inserts `max(version)+1`, the old version stays as a
  historical row, and existing installs keep their pinned version. There is no
  in-place edit — fix a mistake by publishing the next version. You cannot
  publish under a slug someone else owns.
- **`private` defaults to TRUE** for a new slug: visible and installable only by
  the author until it's published with `private: false`. Say this out loud
  after publishing, or the user will wonder why nobody can see it. A version
  bump inherits current visibility unless `private` is passed.
- **Manage what you publish:** `list_publisher_recipes` (your integration
  recipes + install counts by state), `get_publisher_recipe` (one recipe's
  detail — auth, limits, recent install errors, publisher-secret *names*), the
  publisher vault via `list_publisher_secrets` / `rotate_publisher_secret` /
  `delete_publisher_secret`, and `bulk_set_integration_state` to move every
  connected (non-revoked, non-pending) install of a recipe you own to active /
  paused / stopped.
