# CarrierDatabaseV2 Handoff for Claude Code

This is the current project handoff as of March 18, 2026.

The goal is to let Claude Code take over without re-discovering the architecture, sync model, parsing fixes, or the current state of the optional Gmail integration work.

## Live Production

- Production site: [https://carrierdatabasev2.netlify.app](https://carrierdatabasev2.netlify.app)
- Latest known production deploy from this workstream: [https://69b8197de51fb60cca23f8f2--carrierdatabasev2.netlify.app](https://69b8197de51fb60cca23f8f2--carrierdatabasev2.netlify.app)

Important:
- Production is hosted on Netlify.
- The live source of truth is Netlify Blobs.
- `backend/data/state.json` is only a seed/fallback snapshot, not the active production database.

## Core Files

- Frontend: [carrier-database.html](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/carrier-database.html)
- Netlify API backend: [netlify/functions/api.js](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify/functions/api.js)
- Sold-load/rate-confirmation parser + Gmail/Zapier sync helpers: [netlify/functions/gmail-sync-lib.js](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify/functions/gmail-sync-lib.js)
- Scheduled Gmail sync trigger: [netlify/functions/gmail-sync-cron.js](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify/functions/gmail-sync-cron.js)
- Netlify config: [netlify.toml](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify.toml)
- Local sync helper: [sync_from_netlify.py](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/sync_from_netlify.py)
- Claude project instructions: [CLAUDE.md](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/CLAUDE.md)
- Zapier operator guide: [ZAPIER_SETUP.md](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/ZAPIER_SETUP.md)

## Architecture Summary

The project is now a Netlify-hosted static frontend plus Netlify Function backend.

### Frontend

The app is still a single HTML file:
- works as a self-contained HTML fallback
- hydrates from `/api/bootstrap` when the backend is available
- polls `/api/bootstrap` every 5 seconds to stay synced across testers

The user explicitly wanted the HTML fallback behavior preserved. Do not remove that.

### Backend

The Netlify Function backend handles:
- bootstrap state reads
- carrier updates
- load updates
- bulk state sync
- Gmail sync status
- Zapier sync status
- Zapier rate-confirmation ingestion

Shared state is stored in Netlify Blobs.

Production blob store name resolves to:
- `carrierdatabasev2-production`

## Current API Surface

Main endpoints:

- `GET /api/health`
- `GET /api/bootstrap`
- `GET /api/carriers`
- `GET /api/loads`
- `POST /api/state/sync`
- `POST /api/carriers`
- `PATCH /api/carriers/:id`
- `POST /api/loads`
- `PATCH /api/loads/:id`

Email sync related endpoints:

- `GET /api/gmail/status`
- `POST /api/gmail/sync`
- `GET /api/zapier/status`
- `POST /api/zapier/rate-confirmation`

Important:
- A Zapier-based sold-load / rate-confirmation path has been built and deployed.
- It is not active yet.
- It has not been finally chosen as the production sync method.
- Direct Gmail OAuth sync code also still exists in the codebase.

## Email Sync Work In Progress

The original idea was direct Gmail API syncing from the backend.

A Zapier-based sold-load / rate-confirmation path has also been built:

1. Gmail in Zapier catches sold-load / rate-confirmation emails
2. Zapier posts the message to the Netlify webhook endpoint
3. The webhook updates matching carrier records in Netlify Blobs

Built webhook endpoint:
- `POST /api/zapier/rate-confirmation`

Status endpoint:
- `GET /api/zapier/status`

Important:
- this Zapier path is built
- it is deployed
- it is not configured
- it is not active
- the user has not yet decided whether to use it

### Why it was built

- no need to store full Gmail OAuth app credentials inside Netlify
- easier for an operator to manage
- easier to narrow to sold loads only
- works well with the existing Netlify-backed shared database

## Zapier Sync Behavior

The webhook route in [netlify/functions/api.js](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify/functions/api.js) expects a secret header:

- `x-zapier-secret`

The secret value comes from Netlify env:

- `ZAPIER_SYNC_SECRET`

Zapier should post sold-load / rate-confirmation email data to:

- `https://carrierdatabasev2.netlify.app/api/zapier/rate-confirmation`

The parser in [netlify/functions/gmail-sync-lib.js](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify/functions/gmail-sync-lib.js) then tries to extract:

- load id
- route / lane
- pickup date
- delivery date
- rate
- dispatcher
- phone
- carrier emails
- last active timestamp

It is intentionally conservative:

- it updates existing carriers only
- it does not blindly create new carriers from unknown emails
- it is designed around sold-load / rate-confirmation emails, not all inbox traffic

### Fields it tries to update if used

If a sold-load message matches an existing carrier email in the database, the backend tries to update:

- `loadHistory`
- `avgRate`
- `preferredLanes`
- `dispatcher`
- `phone`
- `email`
- `lastActive`
- Gmail source metadata

## Current Zapier Setup Guidance

The current operator guide is in:
- [ZAPIER_SETUP.md](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/ZAPIER_SETUP.md)

The recommended Zap is:

1. `Gmail` → `New Email Matching Search`
2. `Filter by Zapier`
3. `Webhooks by Zapier` → `POST`
4. optional `Gmail` → `Add Label to Email`

Recommended Gmail search:

```text
("rate confirmation" OR "rate con" OR "carrier confirmation" OR "load tender") newer_than:60d -in:trash -in:spam
```

The exact webhook body format is documented in [ZAPIER_SETUP.md](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/ZAPIER_SETUP.md).

## Current Production Caveat

At the time of this handoff:

- the Zapier status endpoint is live
- but `configured` is still `false` until `ZAPIER_SYNC_SECRET` is actually set in Netlify

So:
- the code is deployed
- the webhook path exists
- the operator setup is documented
- but the live Zapier sync is not active
- and the user has not committed to using it yet

## Load Parser / UI Rules

This part remains critical.

### Date and time formatting rules

These strings must never display inside the date/time fields:

- `Priority / OP8`
- `Firm Appointment`

They must appear in the dedicated appointment notes section instead.

### Relevant UI elements

In the load detail panel:

- `#ldp-appointment-section`
- `#ldp-appointment-notes`

### Current schedule parsing behavior

The HTML load parser was fixed to correctly separate date, time, and notes from TransportPro HTML.

It now handles:

- date-only rows
- multiline schedule rows
- one-line date+time rows
- `at HH:MM`
- `before HH:MM`
- `Priority / OP8`
- `Firm Appointment`

The relevant functions live in [carrier-database.html](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/carrier-database.html):

- `parseTransportProHTML(...)`
- `extractScheduleParts(...)`
- `getDisplaySchedule(...)`

Do not regress this behavior.

## Loads Map

The Loads view has a pickup map section.

Behavior:

- groups visible loads by pickup city/state
- places a marker for each pickup market
- clicking a pin shows grouped loads
- clicking a grouped load card opens the normal detail panel

Key frontend areas:

- `mapCtx`
- `ensureLoadsLayout()`
- `renderLoadsMap()`
- `groupLoads()`
- `ensureGoogleMaps()`

Google Maps remains optional:

- if `GOOGLE_MAPS_API_KEY` is missing, the loads table still works
- the map falls back gracefully

At the time of this handoff, production health still reported `googleMapsConfigured: false`.

## Data Flow / Sync Rules

### What is authoritative

Production authority:
- Netlify Blobs

Not authoritative:
- `backend/data/state.json`

`state.json` is only used:
- when a blob store is empty
- when syncing live state back down locally for repo backup purposes

### Local sync helper

Before making data changes locally, Claude should run:

```bash
python3 sync_from_netlify.py
```

That pulls the live Netlify state into:
- [backend/data/state.json](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/backend/data/state.json)

## Suggested Safe Workflow for Claude

Use this order:

1. `python3 sync_from_netlify.py`
2. inspect live state / current docs
3. make code changes
4. run checks
5. deploy
6. verify live endpoints

## Validation Commands

Useful checks:

```bash
npm run check
python3 sync_from_netlify.py --status
curl https://carrierdatabasev2.netlify.app/api/health
curl https://carrierdatabasev2.netlify.app/api/zapier/status
```

## What Not To Break

- Do not remove HTML fallback behavior.
- Do not move appointment notes back into date/time fields.
- Do not treat `backend/data/state.json` as the live production database.
- Do not replace the Zapier webhook path with a general inbox sync path unless explicitly requested.
- Do not assume the Zapier path is already approved for production use.
- Do not assume the Gmail OAuth path is the preferred production design either.

## Shortest Possible Summary for Claude

- The app is a single HTML frontend on Netlify with a Netlify Function backend.
- Shared production state lives in Netlify Blobs.
- The live production URL is `https://carrierdatabasev2.netlify.app`.
- Loads parsing and display were fixed so appointment note strings do not pollute date/time fields.
- The Loads tab includes a Google-map-based pickup map, but Google Maps is optional.
- A Zapier sold-load / rate-confirmation sync path exists at `/api/zapier/rate-confirmation`.
- That Zapier path is deployed but not active, and the user has not decided yet whether to use it.
