---
name: brains-integrations
description: Managing which integrations the user has — listing what's connected (Gmail, Calendar, Drive, Monday, GitHub, …), and installing / upgrading / uninstalling them via codex recipes and the starter-pack bundle. Also covers authoring: publishing your own recipe to the catalog and managing it as a publisher. Use when the user asks "what's connected", "can brains read from X", wants to set up / add / update / remove an integration, or wants to build / publish a recipe of their own.
---

# Integration lifecycle

## Know what's connected (do this before suggesting a source)

`list_integrations` once per session (cache it). One row per known integration:
`name`, `label`, `connected`, `supports.{fetch,act,adapter}`, `description`. Lean
on it before proposing `fetch_from_integration` / `act_on_integration` so you
don't name a source the user hasn't wired up — the `source` enums are filtered
per-user too. It's also the canonical answer to "what integrations do I have."

## Install / re-install

You can install a single integration **from here over MCP** — no need to
bounce the user to the browser for the common case:

- **MCP (preferred for one integration):** `install_integration slug=<recipe>`.
  api_key / none-auth recipes install immediately; oauth2 recipes return an
  `authorize_url` the user opens in a browser to finish the handshake. Common
  slugs: `gmail-inbox`, `gcalendar`, `gdrive-files`, `github-issues`,
  `monday-items`. Idempotent — re-calling for an already-installed recipe
  returns the existing install.
- **Browse the catalog over MCP:** `list_recipes` enumerates installable
  recipes — `tier` is `'catalog'` (curated, default), `'yours'` (the caller's
  own), or `'community'` (other users' published ones), with optional
  `kind` / `category` / `q` filters. Use it to discover slugs the user doesn't
  already know; `recommend_recipes` picks a few with an evidenced reason when
  the user has no specific target in mind. `/recipes` in the web UI is the same
  catalog with pictures.
- **Web UI — starter pack:** for "set me up" / "install the basics", send the
  user to `/recipes/starter-pack` — one click bootstraps the three Google
  integrations (gmail-inbox, gcalendar, gdrive-files) atomically. Bundle
  cascades only run through the web UI.

## Upgrade

Read version drift from here: `list_installed_versions` returns one row per
install (`slug`, `name`, `kind`, `version`, `state`) — the caller's *actual*
pinned versions, so you never have to guess which My Day / starter-pack they're
on. Compare against the catalog's current version from `list_recipes`.

The upgrade itself still runs through the web UI — there's no MCP upgrade tool.
`install_recipe` is idempotent and dedups rather than re-pinning an existing
install, so it is not an upgrade path. Each integration page
(`/integrations/<install_id>`) shows a "Newer version available" banner when an
upgrade exists. If the install came via the starter-pack bundle
(`source_bundle_slug` is set), the Upgrade button redirects to upgrading the
**bundle** — don't upgrade bundle-sourced integrations in isolation.

## Uninstall / manage

Over MCP: `uninstall_integration install_id=<uuid>` (revokes + wipes the
user's secrets for that install), `pause_integration` / `resume_integration`
(stop / restart cron firings), `list_my_integrations` (the user's codex
installs with state + cost), and `get_integration_status` (one install's
health). Get the `install_id` from `list_my_integrations`.

Tune an install without reinstalling it: `set_integration_config` (installer-side
config, e.g. which repos github-issues ingests), `set_integration_overrides`
(tighten per-run / per-month limits — you can only lower the recipe's caps),
and `run_integration_once` for an on-demand test run instead of waiting for
cron. Publishers can flip state across every install of a recipe they own with
`bulk_set_integration_state`.

The whole-recipe cascade is callable over MCP too: `preview_uninstall_recipe
slug=<slug> brain_id=<uuid>` shows the blast radius (entities stamped with the
slug plus deps that would be orphaned) without mutating anything, then
`uninstall_recipe` does it in one transaction — or pass `entity_id` to drop a
single entity. Always preview first for a bundle. The web UI exposes the same
thing per entity page. Everything lands in a 7-day recovery window; use
`list_uninstalled` when the user asks "what did I just uninstall" before they
click Recover.

## Authoring a recipe (plugin-only)

These tools are `pluginOnly` — they exist on this surface and nowhere else, so
if the user wants to *publish* something, this is the only place it can happen.

- **Start with the playbook, not a blank template.** To author an integration
  recipe, call **`create_integration_flow`** first — it returns the full
  IntegrationTemplate shape (auth, trigger, source, outputs, allowed_origins,
  tool_grants, …) as a playbook to follow. Do NOT hand-roll a template or guess
  at its fields; the spec lives in the playbook, not here.
- **Publish:** `publish_recipe` (kind-agnostic — board / automation / workflow /
  bundle / integration) or `publish_integration_recipe` (integration-specific).
  Both validate the template server-side and write nothing if it's invalid.
  `unpublish_recipe` / `unpublish_integration_recipe` pull a recipe from the
  catalog (existing installs are untouched — uninstall those separately).
- **Versioning is append-only.** A brand-new slug publishes at v1; re-publishing
  a slug you own auto-increments to `max(version)+1`, the old version stays as a
  historical row, and existing installs keep their pinned version. There is no
  in-place edit — fix a mistake by publishing the next version.
- **`private` defaults to TRUE** for a new recipe: it's visible and installable
  only by the author until it's published with `private: false`. Say this out
  loud after publishing, or the user will wonder why nobody can see it. A
  version bump inherits current visibility unless `private` is passed.
- **Manage what you publish:** `list_publisher_recipes` (your recipes + install
  counts by state), `get_publisher_recipe` (one recipe's detail — auth, limits,
  recent install errors, publisher-secret *names*), and the publisher vault via
  `list_publisher_secrets` / `rotate_publisher_secret` / `delete_publisher_secret`.
  You cannot publish under a slug someone else owns.
