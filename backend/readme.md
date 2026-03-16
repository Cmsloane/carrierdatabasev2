# Carrier Dashboard Backend

This backend is now ready for the Google deployment shape your team uses:

- Frontend + API: Cloud Run
- Auth: Google Workspace via IAP / forwarded Google headers
- Shared state: Firestore
- Portable HTML snapshot: Cloud Storage

It still keeps the current file-backed mode for local iteration and preserves the single-file HTML fallback behavior.

## What works now

- `STATE_BACKEND=file` keeps canonical state in `backend/data/state.json`
- `STATE_BACKEND=firestore` stores the shared dashboard state in Firestore
- `POST /api/export/html` renders the offline `carrier-database.html` snapshot
- When `CLOUD_STORAGE_BUCKET` is set in Firestore mode, the exported HTML snapshot is uploaded to Cloud Storage
- `GET /` serves the `carrier-database.html` app directly from the same service
- `GET /api/bootstrap` now includes deployment metadata, including the Google Maps browser key for the pickup map
- Auth context is read from:
  - `X-Goog-Authenticated-User-Email`
  - `X-Goog-Authenticated-User-Id`

## Environment

See [`.env.example`](/C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/backend/.env.example).

Important variables:

- `STATE_BACKEND=file|firestore`
- `GOOGLE_CLOUD_PROJECT`
- `GOOGLE_CLOUD_REGION`
- `GOOGLE_MAPS_API_KEY`
- `FIRESTORE_COLLECTION`
- `FIRESTORE_DOCUMENT_ID`
- `CLOUD_STORAGE_BUCKET`
- `OFFLINE_EXPORT_OBJECT`

## Local run

```powershell
cd C:\Users\admin\OneDrive\Desktop\Claude\ChatGPT\backend
npm.cmd install
npm.cmd start
```

Then open [http://127.0.0.1:3030](http://127.0.0.1:3030).

## Cloud Run deploy

Build from the workspace root so the Docker build can include the frontend HTML file:

```powershell
cd C:\Users\admin\OneDrive\Desktop\Claude\ChatGPT
gcloud builds submit --tag gcr.io/YOUR_PROJECT/carrier-dashboard -f backend/Dockerfile .
gcloud run deploy carrier-dashboard \
  --image gcr.io/YOUR_PROJECT/carrier-dashboard \
  --region us-central1 \
  --set-env-vars STATE_BACKEND=firestore,GOOGLE_CLOUD_PROJECT=YOUR_PROJECT,GOOGLE_CLOUD_REGION=us-central1,GOOGLE_MAPS_API_KEY=YOUR_BROWSER_KEY,FIRESTORE_COLLECTION=carrierDashboard,FIRESTORE_DOCUMENT_ID=primary,CLOUD_STORAGE_BUCKET=YOUR_BUCKET,OFFLINE_EXPORT_OBJECT=exports/carrier-database.html \
  --no-allow-unauthenticated
```

## Recommended Google setup

1. Put the Cloud Run service behind IAP so only approved Google Workspace users can access it.
2. Create a Firestore database in native mode.
3. Create a Cloud Storage bucket for the exported HTML snapshot.
4. Restrict the Google Maps browser key to the Cloud Run domain.
5. If you want stricter local behavior, set `ALLOW_UNAUTHENTICATED=false` outside dev.

## API

- `GET /`
- `GET /api/health`
- `GET /api/me`
- `GET /api/bootstrap`
- `GET /api/carriers`
- `POST /api/carriers`
- `PATCH /api/carriers/:id`
- `GET /api/loads`
- `POST /api/loads`
- `PATCH /api/loads/:id`
- `POST /api/state/sync`
- `POST /api/export/html`
- `GET /api/events`
