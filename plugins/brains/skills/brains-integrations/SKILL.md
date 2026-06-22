---
name: brains-integrations
description: Managing which integrations the user has — listing what's connected (Gmail, Calendar, Drive, Monday, GitHub, …), and installing / upgrading / uninstalling them via codex recipes and the starter-pack bundle. Use when the user asks "what's connected", "can brains read from X", or wants to set up / add / update / remove an integration.
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
- **Web UI — browse catalog:** for "what's available?" send the user to
  `/recipes` (integrations, boards, automations, workflows, bundles). There's
  no MCP tool to enumerate the catalog, so the web UI is the way to discover
  slugs the user doesn't already know.
- **Web UI — starter pack:** for "set me up" / "install the basics", send the
  user to `/recipes/starter-pack` — one click bootstraps the three Google
  integrations (gmail-inbox, gcalendar, gdrive-files) atomically. Bundle
  cascades only run through the web UI.

## Upgrade

Upgrades run through the web UI (there is no MCP upgrade tool). Each
integration page (`/integrations/<install_id>`) shows a "Newer version
available" banner when an upgrade exists. If the install came via the
starter-pack bundle (`source_bundle_slug` is set), the Upgrade button
redirects to upgrading the **bundle** — don't upgrade bundle-sourced
integrations in isolation.

## Uninstall / manage

Over MCP: `uninstall_integration install_id=<uuid>` (revokes + wipes the
user's secrets for that install), `pause_integration` / `resume_integration`
(stop / restart cron firings), `list_my_integrations` (the user's codex
installs with state + cost), and `get_integration_status` (one install's
health). Get the `install_id` from `list_my_integrations`.

The web UI also exposes Uninstall on each entity page with a 7-day recovery
window; from `/recipes/<slug>` it cascades to every entity whose
`source_recipe_slug` matches (and for a bundle, every child). Use
`list_uninstalled` when the user asks "what did I just uninstall" before they
click Recover.
