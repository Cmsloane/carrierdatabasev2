# CarrierDatabaseV2 Handoff for Claude

This document is the current handoff for the `CarrierDatabaseV2` project as of March 16, 2026.

The goal is to let another AI continue work without re-discovering the architecture, deployment model, parsing fixes, or current production behavior.

## Current Project State

- Frontend entrypoint: [carrier-database.html](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/carrier-database.html)
- Netlify function backend: [netlify/functions/api.js](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify/functions/api.js)
- Netlify config: [netlify.toml](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify.toml)
- Root package used for Netlify deploys: [package.json](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/package.json)
- Historical seed data still exists in: [backend/data/state.json](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/backend/data/state.json)

Production site:
- [https://carrierdatabasev2.netlify.app](https://carrierdatabasev2.netlify.app)

Latest known production deploy from this workstream:
- [https://69b1b0f1eee52728424ee2fa--carrierdatabasev2.netlify.app](https://69b1b0f1eee52728424ee2fa--carrierdatabasev2.netlify.app)

Important: the app is no longer using the original standalone backend server in production. Production is Netlify-hosted and uses a Netlify Function plus Netlify Blobs for shared state.

## High-Level Architecture

The app is now split like this:

1. `carrier-database.html`
- Single-file frontend app.
- Still works in HTML-only fallback mode if backend features are unavailable.
- Handles carriers UI, loads UI, uploads, matching logic, load detail panel, and map rendering.

2. Netlify Function backend
- File: [netlify/functions/api.js](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify/functions/api.js)
- Replaces the old Node/Express deployment path for production hosting.
- Exposes `/api/*` endpoints through Netlify redirects.

3. Shared persistence
- Uses Netlify Blobs, not `state.json`, for production shared state.
- This is why multiple testers on Netlify stay in sync.
- Production blob store name is based on `NETLIFY_SYNC_STORE` and host detection.
- Current production naming logic resolves to `carrierdatabasev2-production`.

4. Fallback seed state
- On a new or empty blob store, the function seeds from [backend/data/state.json](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/backend/data/state.json).
- After that, Netlify Blobs becomes the live source of truth.

## Netlify Backend Behavior

The function in [netlify/functions/api.js](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify/functions/api.js) currently does the following:

- `GET /api/health`
  - health response
  - returns backend type, revision, store name, auth info, Google Maps configured flag

- `GET /api/bootstrap`
  - returns the full app state
  - includes:
    - `carriers`
    - `loadsData`
    - `meta`
    - `currentUser`
    - `deployment`

- `GET /api/carriers`
  - returns carriers only

- `GET /api/loads`
  - returns loads only

- `POST /api/state/sync`
  - bulk shared-state sync endpoint
  - accepts `carriers` and/or `loadsData`
  - if one is missing, the current state is preserved for that side

- `POST /api/carriers`
- `PATCH /api/carriers/:id`
  - create/update carriers in shared storage

- `POST /api/loads`
- `PATCH /api/loads/:id`
  - create/update single loads in shared storage

- `POST /api/export/html`
  - stores exported HTML snapshot metadata in blobs

Notes:
- CORS headers are enabled.
- State revisions are incremented on every write.
- Auth is effectively public in Netlify production unless special upstream headers are supplied.
- `GOOGLE_MAPS_API_KEY` is read from env and returned through `deployment.googleMapsApiKey`.

## Frontend Sync Model

The frontend in [carrier-database.html](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/carrier-database.html) no longer relies on SSE for production sync.

Current behavior:
- On load, it calls `/api/bootstrap`
- It polls `/api/bootstrap` every 5 seconds
- If the shared state changed, the UI updates from the backend payload
- Local edits and uploads can call `/api/state/sync`

This is what keeps multiple people on the hosted site in sync.

## Map Section

A pickup map section was added into the Loads view.

Key behavior:
- Loads are grouped by pickup city/state
- Each pickup group becomes a marker
- Clicking a marker shows the loads in that pickup market
- Clicking a load card in the map results panel selects that load and opens the normal detail panel

Relevant code lives in [carrier-database.html](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/carrier-database.html) around:
- `mapCtx`
- `ensureLoadsLayout()`
- `renderLoadsMap()`
- `groupLoads()`
- `ensureGoogleMaps()`

Important current note:
- The map UI exists and works with the backend wiring
- If `GOOGLE_MAPS_API_KEY` is not set in Netlify env, the map falls back gracefully and the loads table still works
- The code is intentionally written so the HTML app still functions without live Google Maps

## Load Parsing Rules

This area was heavily corrected and is important.

### HTML Import Path

The current HTML importer is:
- `handleLoadsUpload(...)`
- `parseTransportProHTML(htmlText)`

It was specifically fixed so schedule parsing no longer depends on flattened cell text for pickup and delivery windows.

Instead, the importer now reads the actual pickup/delivery cell structure and separates:
- real date
- real time
- appointment notes

### Current Schedule Expectations

These should parse correctly now:

- `03/09/2026` + `08:00 - 15:00`
- `03/12/2026 06:00`
- `03/12/2026 09:00`
- `03/11/2026` + `00:01 - 23:59`
- `03/12/2026` + `before 23:59`
- `03/11/2026` + `at 11:00`
- date-only rows such as `03/31/2026`

### Appointment Notes Handling

The strings below must not appear inside displayed date/time fields:
- `Priority / OP8`
- `Firm Appointment`

Current behavior:
- date field shows only the date
- time field shows only a time/range if one exists
- appointment note strings are shown in the dedicated `Appointment Notes` section of the load detail panel

The detail panel section is:
- `#ldp-appointment-section`
- `#ldp-appointment-notes`

### Current Parser/Data Fields for Loads

Loads may now include:
- `pickup_date`
- `pickup_time`
- `pickup_appointment_note`
- `delivery_date`
- `delivery_time`
- `delivery_appointment_note`

The display helper `getDisplaySchedule(...)` also still sanitizes old polluted values in case legacy rows already contain malformed combined strings.

That means the UI is defensive in two ways:
- future imports should store clean values
- previously malformed values can still be cleaned at render time

## Live Shared Loads Refresh

The production shared Netlify state was refreshed using the newer TransportPro load file:
- `C:\Users\admin\Downloads\dashboard_FrtOps_availLoads.htm`

At the time of the refresh:
- total loads synced: `356`
- production revision observed after sync: `5`

Verified live examples after that refresh included:

- Load `2345838`
  - pickup date `03/09/2026`
  - pickup time `08:00 - 15:00`
  - pickup appointment note `Priority / OP8`
  - delivery date `03/10/2026`
  - delivery time `08:00 - 21:00`

- Load `2342788`
  - pickup date `03/11/2026`
  - pickup time `00:01 - 23:59`
  - delivery date `03/12/2026`
  - delivery time `06:00`
  - appointment note `Firm Appointment`

- Load `2336923`
  - delivery time `before 23:59`

- Load `2345375`
  - date-only `03/31/2026`
  - blank time
  - appointment note `Firm Appointment`

## What Changed in the Frontend

These are the most important front-end changes relative to the older HTML-only version:

1. Loads map added
- pickup markers
- click marker to view grouped loads
- click grouped load card to open detail panel

2. Backend bootstrap/sync added
- frontend fetches shared state from Netlify backend
- periodic polling keeps users synced

3. Appointment notes section added
- separate from general notes
- prevents schedule note strings from polluting date/time display

4. HTML schedule parser rewritten
- pickup/delivery HTML cells are parsed structurally
- date and time extraction now handles one-line and multi-line appointment formats better

5. Legacy display sanitization added
- even if an old row contains bad combined strings, UI tries to split them back into clean display fields

## What Still Exists from the Old Backend Work

There is still a `backend/` folder containing earlier backend work for Google-native hosting.

That work is not the active production path right now.

It includes earlier ideas for:
- Google-native auth
- Firestore/shared state
- Cloud Storage export behavior
- serving the HTML from a Node backend

Right now, production does not depend on that stack. The live deployment path is Netlify.

Claude should treat `backend/` as historical or alternate infrastructure unless the user explicitly wants to move away from Netlify.

## Netlify Deployment Notes

Deployment model in use:
- static site + Netlify Functions
- production deploy command used in this workspace:
  - `npx netlify deploy --prod`

Important files:
- [netlify.toml](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify.toml)
- [package.json](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/package.json)

The CLI is already linked to:
- site name: `carrierdatabasev2`

If Claude deploys again, it should assume:
- project is already linked
- production URL should remain `https://carrierdatabasev2.netlify.app`

## Known Caveats

1. Google Maps key may still be unset
- If map pins do not render live, check Netlify env var:
  - `GOOGLE_MAPS_API_KEY`

2. Production shared state is blob-backed
- Editing the seed file alone will not update live state
- To update production data, write to `/api/state/sync` or use the app’s sync paths

3. Some older UI text may contain character-encoding artifacts in source
- These are mostly cosmetic string remnants from prior edits
- Do not confuse them with parser/data corruption

4. `backend/data/state.json` is not the live production database
- It is only the seed/fallback baseline for a fresh blob store

## Recommended Rules for Future Changes

If Claude makes future changes, these are the safest rules:

1. Do not remove the HTML fallback behavior
- the user explicitly wanted the single HTML app to keep working

2. Do not move appointment notes back into date/time fields
- keep `Priority / OP8` and `Firm Appointment` out of displayed schedule fields

3. Preserve Netlify Blobs as the shared source of truth unless the user requests a backend migration

4. If updating load parsing, test against real TransportPro HTML examples
- especially:
  - one-line date+time
  - `at HH:MM`
  - `before HH:MM`
  - date-only rows
  - note-only secondary lines

5. If updating production data, remember code deploy and shared-state refresh are separate things
- deploy updates the app code
- `/api/state/sync` updates shared live data

## Fast Orientation for Claude

If Claude needs the shortest possible summary:

- The live app is a single HTML frontend hosted on Netlify.
- Shared state lives in Netlify Blobs via [netlify/functions/api.js](C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/netlify/functions/api.js).
- The old `backend/` folder is not the current production runtime.
- The Loads tab has a pickup map and a dedicated Appointment Notes section.
- The HTML load parser was fixed to correctly separate date, time, and notes from TransportPro HTML cells.
- `Priority / OP8` and `Firm Appointment` must never display inside the date/time fields.
- Production shared load data was refreshed from the newer `dashboard_FrtOps_availLoads.htm` file and verified for sample loads.
