# CarrierDatabaseV2 — Claude Code Instructions

This file is the single source of truth for working on this project. Read it in full before making any changes. It supersedes all previous handoff documents.

**Last updated:** 2026-03-19
**Current live revision:** 13
**Current carrier count:** 96 (IDs 101–202)

---

## Live Production

- **Live site:** https://carrierdatabasev2.netlify.app
- **GitHub repo:** https://github.com/Cmsloane/carrierdatabasev2
- **Deploys:** Automatically on every push to `main` via Netlify
- **Netlify Blobs store:** `carrierdatabasev2-production` — this is ALWAYS the source of truth

---

## Architecture

```
carrier-database.html              ← Single-page frontend (all UI logic, self-contained)
netlify/functions/api.js           ← Netlify Function backend (all API routes)
netlify/functions/gmail-sync-lib.js ← Sold-load / rate-con email parser + Zapier/Gmail helpers
netlify/functions/gmail-sync-cron.js ← Scheduled Gmail sync trigger (not active yet)
netlify.toml                       ← Netlify build/redirect config
backend/data/state.json            ← Seed data ONLY (not live DB — see below)
sync_from_netlify.py               ← Pull live Netlify Blobs state → local state.json
ZAPIER_SETUP.md                    ← Operator guide for Zapier sold-load sync
```

### Data flow

1. User visits live site → frontend calls `GET /api/bootstrap`
2. Backend reads current state from **Netlify Blobs** and returns it
3. Frontend polls `/api/bootstrap` every 5 seconds to stay synced across users
4. Carrier/load edits → `POST /api/state/sync` → saved to Netlify Blobs
5. `state.json` is only used to seed a fresh/empty blob store — it is **not** authoritative

**To update production data: POST to `/api/state/sync`, not by editing state.json.**

---

## Key API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/health` | GET | Backend status, revision, store name, Maps key flag |
| `/api/bootstrap` | GET | Full app state: `{ carriers, loadsData, meta, currentUser, deployment }` |
| `/api/carriers` | GET | Carriers array only |
| `/api/loads` | GET | Loads array only |
| `/api/state/sync` | POST | Bulk sync: `{ carriers, loadsData }` — increments revision |
| `/api/carriers` | POST | Create single carrier |
| `/api/carriers/:id` | PATCH | Update single carrier |
| `/api/loads` | POST | Create single load |
| `/api/loads/:id` | PATCH | Update single load |
| `/api/gmail/status` | GET | Gmail sync status |
| `/api/gmail/sync` | POST | Trigger manual Gmail sync |
| `/api/zapier/status` | GET | Zapier sync status |
| `/api/zapier/rate-confirmation` | POST | Zapier webhook — ingests rate-con email data |

---

## Safe Workflow for Code Changes

Always follow this order:

```bash
# 1. Pull latest live state into local state.json
python3 sync_from_netlify.py

# 2. Make code/data changes

# 3. Validate syntax
npm run check

# 4. Deploy (Netlify auto-deploys on push)
git add -A
git commit -m "describe your change"
git push

# 5. Verify live
curl https://carrierdatabasev2.netlify.app/api/health
```

**Never edit `state.json` and treat it as live data.** It is only a fallback seed. Pull live state first.

**Always include `carriersUpdatedAt` in every `POST /api/state/sync` payload.** The 3 timestamps shown on the site (`#s-carriers-updated`, `#s-loads-synced`, `#ls-synced`) depend on it. Set it to the current ISO timestamp whenever adding/modifying carriers.

---

## Carrier Data Schema

```javascript
{
  id,              // Integer, sequential from 101. New carriers: max(id) + 1
  company,         // Full legal company name (include LLC, Inc., etc.)
  mc,              // "MC-XXXXXX" format, or "" if unknown
  dot,             // "DOT-XXXXXXX" format, or "" if unknown
  equipment,       // "Dry Van", "Reefer", "Flatbed", etc.
  hazmat,          // Boolean or "No"
  safetyRating,    // "Satisfactory", "Not Rated", etc.
  dispatcher,      // Full name, or "Name (role) / Name2 (role2)" for multiple contacts
  phone,           // Primary phone, include ext if applicable
  afterHours,      // After-hours phone or email
  email,           // Primary dispatch email
  preferredLanes,  // Human-readable lane summary (e.g. "Midwest → Southeast")
  homeBase,        // City, ST or full address string if city is unknown
  address,         // Full street address if known (separate from homeBase)
  avgRate,         // Dollar string (e.g. "$2,200") or 0 if unknown
  insurance,       // Insurance details if captured
  loadsCompleted,  // Count of completed loads
  otPickup,        // On-time pickup % (0–100)
  otDelivery,      // On-time delivery % (0–100)
  claims,          // Claim count
  status,          // "Active", "Preferred", "Do Not Use", etc.
  score,           // 0–100 reliability score
  region,          // "Midwest", "Southeast", "South", "Northeast", etc.
  lastActive,      // ISO date string "YYYY-MM-DD" or human string "Feb 2026"
  notes,           // Free text. Include load #, lane, customer, address, special info
  issueFlag,       // Boolean — true if carrier had a service failure or escalation
  loadHistory,     // Array of load objects (see below)
  sources          // Array of source metadata objects (auto-populated by Gmail sync)
}
```

### loadHistory item schema

```javascript
{
  load,           // Load # string (e.g. "2336169")
  date,           // Pickup date "YYYY-MM-DD"
  origin,         // "City, ST"
  dest,           // "City, ST"
  pickupWindow,   // Time window string e.g. "08:00–15:00" or "09:00"
  deliveryDate,   // Delivery date "YYYY-MM-DD" if different from pickup date
  deliveryWindow, // Time window string
  customer,       // Customer name (e.g. "Clarios c/o LogiFlow")
  refNumber,      // Reference number if applicable
  status          // "Completed", "Completed — Late (escalated)", "Completed — Tracking issues"
}
```

---

## Current Carrier ID Range

IDs 101–193. **87 carriers total as of 2026-03-18 (revision 8).**

### New carriers added 2026-03-18 (IDs 188–193)

All 6 carriers were sourced from sold load / rate confirmation Gmail threads. Full data:

| ID | Company | MC | Dispatcher | Phone | Email | Lane |
|---|---|---|---|---|---|---|
| 188 | Runwell Inc. | MC-055507 | Silvestras Miskinis (Silva) | 219-285-9700 ext.303 | silva@runwellinc.com | Indianapolis IN → Kernersville NC |
| 189 | JJ Team Transport LLC | — | Adriana Garcia Mata (dispatch) / Jesus Chavez (owner) | 760-638-1264 | jjteamtransportllc@yahoo.com | Baytown TX → North Las Vegas NV |
| 190 | Bogg Express LLC | — | BEK | 513-916-3232 ext.118 | dispatch@boggexpress.com | Levittown PA → Rockford IL |
| 191 | T&N Express Inc. | MC-633676 | Oksana | 708-695-5947 | dispatch@tnnexpress.com | Bensenville IL → Memphis TN |
| 192 | Toska Logistics Inc. | — | Eugen Toska | 904-514-5553 | toskalogistics@gmail.com | Fitzgerald GA → Fredericksburg VA |
| 193 | ZMile Inc. | MC-1067250 | Khan | 630-339-2721 | dispatch@zmile.io | Glen Dale WV → North Kingstown RI |

**Notes on IDs 189 and 191:**
- ID 189 (JJ Team Transport): `issueFlag: true` — Load #2353202 was escalated for late delivery (driver was in El Paso TX, ~700 miles from North Las Vegas NV delivery, past ETA; delay attributed to shipper).
- ID 191 (T&N Express): `issueFlag: true` — Load #2356902 had tracking issues; driver was initially unresponsive to tracking app. Load was threatened with recovery. Delivered 2026-03-18.

---

## Load Data Schema

```javascript
{
  load_id, customer,
  pickup_city, pickup_state, pickup_date, pickup_time, pickup_appointment_note,
  delivery_city, delivery_state, delivery_date, delivery_time, delivery_appointment_note,
  equipment, hazmat, weight_lbs, miles, rate, max_buy,
  commodity, ref_number, assigned_to
}
```

---

## Frontend Rules — Do NOT Break

1. **HTML fallback mode must keep working.** The app must function as a standalone HTML file without any backend connection.
2. **`Priority / OP8` and `Firm Appointment` must NEVER appear in date/time display fields.** They belong only in `#ldp-appointment-section` / `#ldp-appointment-notes`.
3. **Load parser functions must not regress.** Test `parseTransportProHTML()`, `extractScheduleParts()`, and `getDisplaySchedule()` against real TransportPro HTML before changing. Supported formats include: `08:00 - 15:00`, `06:00`, `at 11:00`, `before 23:59`, `00:01 - 23:59`, date-only rows.
4. **Loads map is optional.** If `GOOGLE_MAPS_API_KEY` is not set in Netlify, the loads table must still work (map gracefully degrades).
5. **Do not corrupt the `saveHTMLState()` function.** It must correctly find the script block containing `let carriers=` — not the injected scripts.

---

## Loads Map Feature

Located in the Loads tab. Key functions:
- `mapCtx`, `ensureLoadsLayout()`, `renderLoadsMap()`, `groupLoads()`, `ensureGoogleMaps()`

Behavior: groups loads by pickup city/state → map pins → click pin → load cards → click card → detail panel.

`GOOGLE_MAPS_API_KEY` is read from Netlify env. At last check, production still had `googleMapsConfigured: false` — map will fall back to table-only view until this key is configured in Netlify dashboard.

---

## Gmail / Zapier Sync

### Manual Gmail sync (current method — via Claude Cowork + Gmail MCP)

The current workflow for adding new carriers from sold loads:
1. Search Gmail for `"Book Now Dispatch for Load"` emails (`noreply@circledelivers.com`) — these contain full lane info, dispatcher name/phone, pickup/delivery city+state, time windows, customer name
2. Cross-reference rate confirmation threads (`"Circle Logistics, Inc - Rate Confirmation for Load"`) for MC/DOT numbers and carrier contact details
3. Rates are in PDF attachments only — not readable from email body text
4. Push directly to live Netlify Blobs via `POST /api/state/sync` using `fetch()` in Chrome browser (VM outbound network is blocked, so all Netlify API calls use Chrome JS eval as a proxy)

### Automated Zapier sync (built, deployed, NOT yet active)

A Zapier webhook path exists and is deployed but not configured:
- Endpoint: `POST /api/zapier/rate-confirmation`
- Status endpoint: `GET /api/zapier/status`
- Requires `ZAPIER_SYNC_SECRET` set in Netlify env vars to activate
- Parser is conservative: updates existing carriers by email match only, does NOT create new carriers from unknown senders
- Operator guide: `ZAPIER_SETUP.md`

**The user has not yet decided whether to use the Zapier path.** Do not assume it is the preferred production sync method.

### Gmail OAuth sync (also built, also not active)

Direct Gmail OAuth sync code also exists in `gmail-sync-lib.js` and the scheduled cron function. It is not the current production sync method either.

---

## Netlify Environment Variables

| Variable | Required | Purpose |
|---|---|---|
| `GOOGLE_MAPS_API_KEY` | Optional | Enables pickup map pins on Loads tab |
| `ZAPIER_SYNC_SECRET` | Optional | Activates Zapier rate-con webhook |
| `GMAIL_CLIENT_ID` | Optional | Direct Gmail OAuth sync |
| `GMAIL_CLIENT_SECRET` | Optional | Direct Gmail OAuth sync |
| `GMAIL_REFRESH_TOKEN` | Optional | Direct Gmail OAuth sync |
| `GMAIL_USER_EMAIL` | Optional | Gmail user, defaults to `me` |
| `GMAIL_SYNC_SECRET` | Optional | Protects manual Gmail sync endpoint |
| `NETLIFY_SYNC_STORE` | Optional | Override blob store name (default: auto-detected) |

---

## Local Files Reference

| File | Purpose |
|---|---|
| `carrier-database.html` | Main frontend app — edit for UI changes |
| `netlify/functions/api.js` | Netlify Function backend — edit for API/logic changes |
| `netlify/functions/gmail-sync-lib.js` | Email parser + Zapier/Gmail sync helpers |
| `netlify/functions/gmail-sync-cron.js` | Scheduled sync trigger |
| `netlify.toml` | Netlify routing + build config |
| `backend/data/state.json` | Seed/fallback data — **not the live DB** — revision 8 as of 2026-03-18 |
| `sync_from_netlify.py` | Pull live Blobs state → local state.json |
| `CLAUDE.md` | This file |
| `ZAPIER_SETUP.md` | Zapier operator setup guide |
| `AI_HANDOFF_2026-03-10.md` | Codex/ChatGPT handoff — Google/Firestore backend work (historical) |
| `AI_HANDOFF_2026-03-16.md` | Claude Cowork handoff — Netlify deployment, map feature, parser fixes |
| `AI_HANDOFF_2026-03-18.md` | Claude Cowork handoff — Gmail/Zapier sync work, carrier additions |

### The `backend/` folder

The `backend/` folder contains earlier work targeting a Google Cloud Run + Firestore + Cloud Storage deployment. **This is not the current production runtime.** Production is Netlify. Treat `backend/` as historical unless the user explicitly requests a migration away from Netlify.

---

## Direct Live Data Push (Chrome JS workaround)

The VM where Claude Cowork runs has outbound network blocked (403 proxy). Netlify API calls are made via `fetch()` inside a Chrome browser tab pointed at `carrierdatabasev2.netlify.app`. Pattern:

```javascript
// Pull current live state
fetch('https://carrierdatabasev2.netlify.app/api/bootstrap')
  .then(r => r.json())
  .then(data => {
    window._liveCarriers = data.carriers;
    window._liveLoadsData = data.loadsData || [];
    window._liveRevision = data.meta?.revision;
  });

// After modifying window._liveCarriers, push back:
fetch('https://carrierdatabasev2.netlify.app/api/state/sync', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ carriers: window._liveCarriers, loadsData: window._liveLoadsData })
}).then(r => r.json()).then(result => { window._syncResult = result; });
```

Use `.then()` chains — not `await` — because the Chrome JS eval context does not support top-level await.

**Claude Code running locally does not need this workaround.** Use `curl` or Python `requests` to call the API directly.

---

## Quick Reference

```bash
# Always start here — sync live state to local
python3 sync_from_netlify.py

# Check what's live right now
curl https://carrierdatabasev2.netlify.app/api/health
curl https://carrierdatabasev2.netlify.app/api/bootstrap | python3 -m json.tool | grep revision

# Validate code before deploying
npm run check

# Deploy
git add -A && git commit -m "your change" && git push

# Live site
open https://carrierdatabasev2.netlify.app
```

---

## What Not to Break (Summary)

- HTML fallback mode — the app must work as a self-contained HTML file
- `Priority / OP8` and `Firm Appointment` must never appear in date/time display fields
- `state.json` is not the live database — always sync before using it
- Netlify Blobs is the live source of truth
- The Zapier sync path is built but not approved for production use
- The `backend/` folder is historical — not the active production path
- Load parser regression: test `parseTransportProHTML()` before touching parsing code
- Carrier IDs are sequential — new carriers always start at `max(id) + 1`
