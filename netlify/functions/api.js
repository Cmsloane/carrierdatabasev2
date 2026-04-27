import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac, randomBytes } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import {
  gmailSyncConfigStatus,
  zapierSyncConfigStatus,
  syncCarriersFromGmail,
  syncNewCarriersFromBookNow,
  syncCarrierOutreachFromGmail,
  syncNewCarriersFromSentMail,
  syncRCThreadProgress
} from './gmail-sync-lib.js';

const functionFilename = fileURLToPath(import.meta.url);
const functionDir = path.dirname(functionFilename);
const ROOT_DIR = path.resolve(functionDir, '..', '..');
const STATE_SEED_PATH = path.join(ROOT_DIR, 'backend', 'data', 'state.json');
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

// ── SSO / Auth constants ────────────────────────────────────────────────────
const SESSION_SECRET = process.env.SESSION_SECRET || 'cdb-dev-secret-change-in-production';
const ALLOWED_DOMAINS = (process.env.ALLOWED_DOMAINS || 'circledelivers.com,circlelogistics.com')
  .split(',').map(d => d.trim().toLowerCase()).filter(Boolean);
const GOOGLE_CLIENT_ID = process.env.GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';

// ── Session helpers ─────────────────────────────────────────────────────────
function b64u(s) { return Buffer.from(s).toString('base64url'); }
function unb64u(s) { return Buffer.from(s, 'base64url').toString('utf8'); }

function signSession(payload) {
  const data = b64u(JSON.stringify(payload));
  const sig = createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifySession(token) {
  try {
    const dot = token.lastIndexOf('.');
    if (dot < 1) return null;
    const data = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = createHmac('sha256', SESSION_SECRET).update(data).digest('base64url');
    if (sig !== expected) return null;
    const payload = JSON.parse(unb64u(data));
    if (payload.exp && Date.now() > payload.exp) return null;
    return payload;
  } catch { return null; }
}

function getSessionUser(request) {
  const cookieHeader = request.headers.get('cookie') || '';
  const match = cookieHeader.match(/(?:^|;\s*)cdb_session=([^;]+)/);
  if (!match) return null;
  return verifySession(decodeURIComponent(match[1]));
}

function makeSessionCookie(user, maxAgeSec = 7 * 24 * 3600) {
  const payload = {
    email: user.email, name: user.name, picture: user.picture || '',
    exp: Date.now() + maxAgeSec * 1000
  };
  const token = signSession(payload);
  return `cdb_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

function clearSessionCookie() {
  return 'cdb_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

// ── Email notifications ──────────────────────────────────────────────────────
async function sendEmailNotification(subject, htmlBody) {
  const toEmail = process.env.NOTIFY_EMAIL || 'conrad.sloane@circledelivers.com';
  const refreshToken = process.env.GMAIL_REFRESH_TOKEN || '';
  if (!refreshToken || !GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) return;

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        refresh_token: refreshToken,
        grant_type: 'refresh_token'
      })
    });
    const { access_token } = await tokenRes.json();
    if (!access_token) return;

    const raw = [
      `To: ${toEmail}`,
      `Subject: ${subject}`,
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=utf-8',
      '',
      htmlBody
    ].join('\r\n');

    await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ raw: Buffer.from(raw).toString('base64url') })
    });
  } catch { /* never block the main flow */ }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function purgePastLoads(loads) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return (loads || []).filter(l => {
    const pd = l.pickup_date || '';
    if (!pd) return true;
    const parts = pd.split('/');
    if (parts.length !== 3) return true;
    const d = new Date(parseInt(parts[2]), parseInt(parts[0]) - 1, parseInt(parts[1]));
    return d >= today;
  });
}

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Content-Type, X-Goog-Authenticated-User-Email, X-Goog-Authenticated-User-Id',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS'
};

function json(statusCode, payload, extraHeaders = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status: statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', ...CORS_HEADERS, ...extraHeaders }
  });
}

function redirect(location, extraHeaders = {}) {
  return new Response(null, {
    status: 302,
    headers: { Location: location, ...CORS_HEADERS, ...extraHeaders }
  });
}

function noContent() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

async function readSeedState() {
  const raw = await readFile(STATE_SEED_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  parsed.meta = parsed.meta || {
    lastSyncedAt: parsed.loadsData?.synced_at || nowIso(),
    source: 'netlify_seed',
    revision: 1,
    backend: 'netlify-blobs'
  };
  return parsed;
}

function sanitizeKeyPart(value) {
  return String(value || 'default').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function getStoreName(request) {
  const explicit = process.env.NETLIFY_SYNC_STORE || 'carrierdatabasev2';
  const hostname = new URL(request.url).hostname.toLowerCase();
  const isProductionHost = hostname === 'carrierdatabasev2.netlify.app';
  const suffix = isProductionHost
    ? 'production'
    : sanitizeKeyPart(process.env.BRANCH || process.env.DEPLOY_ID || hostname || 'preview');
  return sanitizeKeyPart(explicit + '-' + suffix);
}

function currentUser(request) {
  const email = request.headers.get('x-goog-authenticated-user-email') || request.headers.get('x-forwarded-email') || '';
  const userId = request.headers.get('x-goog-authenticated-user-id') || '';
  return {
    authenticated: Boolean(email),
    provider: email ? 'google-iap' : 'netlify-public',
    email: String(email).replace(/^accounts\.google\.com:/, '').trim(),
    userId: String(userId || email || 'netlify-public').replace(/^accounts\.google\.com:/, '').trim()
  };
}

async function getState(store) {
  const existing = await store.get('state', { type: 'json' });
  if (existing) return existing;
  const seeded = await readSeedState();
  await store.setJSON('state', seeded);
  return seeded;
}

async function writeState(store, nextState, source) {
  const revision = Number(nextState?.meta?.revision || 0) + 1;
  const now = nowIso();
  const payload = {
    carriers: nextState.carriers || [],
    loadsData: nextState.loadsData || { synced_at: now, total_available: 0, loads_captured: 0, loads: [] },
    carriersUpdatedAt: nextState.carriersUpdatedAt || now,
    meta: {
      ...(nextState.meta || {}),
      source: source || 'netlify_sync',
      lastSyncedAt: now,
      carriersUpdatedAt: nextState.carriersUpdatedAt || now,
      revision,
      backend: 'netlify-blobs'
    }
  };
  await store.setJSON('state', payload);
  return payload;
}

function parseRoute(pathname) {
  const internalPrefix = '/.netlify/functions/api';
  const publicPrefix = '/api';
  if (pathname.startsWith(internalPrefix)) {
    const route = pathname.slice(internalPrefix.length);
    return route || '/';
  }
  if (pathname.startsWith(publicPrefix)) {
    const route = pathname.slice(publicPrefix.length);
    return route || '/';
  }
  return pathname;
}

function serviceUrl(request) {
  return process.env.URL || new URL(request.url).origin;
}

async function parseBody(request) {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
}

export default async (request) => {
  if (request.method === 'OPTIONS') {
    return noContent();
  }

  const reqUrl = new URL(request.url);
  const pathname = parseRoute(reqUrl.pathname);
  const storeName = getStoreName(request);
  const store = getStore({ name: storeName });
  const user = currentUser(request);

  try {
    if (request.method === 'GET' && pathname === '/health') {
      const state = await getState(store);
      return json(200, {
        ok: true,
        backend: 'netlify-blobs',
        revision: state.meta?.revision || 1,
        store: storeName,
        googleMapsConfigured: Boolean(GOOGLE_MAPS_API_KEY),
        currentUser: user
      });
    }

    if (request.method === 'GET' && pathname === '/me') {
      return json(200, { user });
    }

    if (request.method === 'GET' && pathname === '/bootstrap') {
      const state = await getState(store);
      return json(200, {
        ...state,
        currentUser: user,
        deployment: {
          backend: 'netlify-blobs',
          serviceUrl: serviceUrl(request),
          store: storeName,
          googleMapsApiKey: GOOGLE_MAPS_API_KEY
        }
      });
    }

    if (request.method === 'GET' && pathname === '/carriers') {
      const state = await getState(store);
      return json(200, { carriers: state.carriers || [] });
    }

    if (request.method === 'GET' && pathname === '/loads') {
      const state = await getState(store);
      return json(200, { loads: state.loadsData?.loads || [] });
    }

    if (request.method === 'POST' && pathname === '/state/sync') {
      const body = await parseBody(request);
      const current = await getState(store);
      const incomingLoadsData = body.loadsData || current.loadsData || {};
      const activeLods = purgePastLoads(incomingLoadsData.loads);
      const cleanedLoadsData = { ...incomingLoadsData, loads: activeLods, loads_captured: activeLods.length };
      const synced = await writeState(store, {
        carriers: body.carriers || current.carriers,
        loadsData: cleanedLoadsData,
        carriersUpdatedAt: body.carriersUpdatedAt || nowIso(),
        meta: current.meta
      }, user.email || user.userId || body.source || 'netlify_sync');
      return json(200, synced);
    }

    if (request.method === 'POST' && pathname === '/carriers') {
      const body = await parseBody(request);
      const current = await getState(store);
      const carriers = clone(current.carriers || []);
      const id = body.id || (Math.max(0, ...carriers.map((item) => Number(item.id) || 0)) + 1);
      const index = carriers.findIndex((item) => String(item.id) === String(id));
      const nextCarrier = { ...(index >= 0 ? carriers[index] : {}), ...body, id, updated_by: user.email || user.userId };
      if (index >= 0) carriers[index] = nextCarrier;
      else carriers.push(nextCarrier);
      await writeState(store, { ...current, carriers, carriersUpdatedAt: nowIso() }, 'carrier_upsert');
      return json(201, { carrier: nextCarrier });
    }

    if (request.method === 'PATCH' && pathname.startsWith('/carriers/')) {
      const carrierId = pathname.split('/').pop();
      const body = await parseBody(request);
      const current = await getState(store);
      const carriers = clone(current.carriers || []);
      const index = carriers.findIndex((item) => String(item.id) === String(carrierId));
      const nextCarrier = { ...(index >= 0 ? carriers[index] : {}), ...body, id: Number(carrierId) || carrierId, updated_by: user.email || user.userId };
      if (index >= 0) carriers[index] = nextCarrier;
      else carriers.push(nextCarrier);
      await writeState(store, { ...current, carriers, carriersUpdatedAt: nowIso() }, 'carrier_patch');
      return json(200, { carrier: nextCarrier });
    }

    if (request.method === 'POST' && pathname === '/loads') {
      const body = await parseBody(request);
      const current = await getState(store);
      const loads = clone(current.loadsData?.loads || []);
      const loadId = String(body.load_id || '');
      if (!loadId) return json(400, { error: 'load_id is required.' });
      const index = loads.findIndex((item) => String(item.load_id) === loadId);
      const nextLoad = { ...(index >= 0 ? loads[index] : {}), ...body, load_id: loadId, updated_by: user.email || user.userId };
      if (index >= 0) loads[index] = nextLoad;
      else loads.push(nextLoad);
      const loadsData = {
        ...(current.loadsData || {}),
        synced_at: nowIso(),
        total_available: loads.length,
        loads_captured: loads.length,
        loads
      };
      await writeState(store, { ...current, loadsData }, 'load_upsert');
      return json(201, { load: nextLoad });
    }

    if (request.method === 'PATCH' && pathname.startsWith('/loads/')) {
      const loadId = pathname.split('/').pop();
      const body = await parseBody(request);
      const current = await getState(store);
      const loads = clone(current.loadsData?.loads || []);
      const index = loads.findIndex((item) => String(item.load_id) === String(loadId));
      const nextLoad = { ...(index >= 0 ? loads[index] : {}), ...body, load_id: String(loadId), updated_by: user.email || user.userId };
      if (index >= 0) loads[index] = nextLoad;
      else loads.push(nextLoad);
      const loadsData = {
        ...(current.loadsData || {}),
        synced_at: nowIso(),
        total_available: loads.length,
        loads_captured: loads.length,
        loads
      };
      await writeState(store, { ...current, loadsData }, 'load_patch');
      return json(200, { load: nextLoad });
    }

    if (request.method === 'POST' && pathname === '/export/html') {
      const state = await getState(store);
      await store.setJSON('exports/latest', {
        exportedAt: nowIso(),
        revision: state.meta?.revision || 1,
        state
      });
      return json(200, {
        ok: true,
        exportKey: 'exports/latest',
        revision: state.meta?.revision || 1,
        synced_at: state.meta?.lastSyncedAt || nowIso(),
        note: 'Netlify keeps the live app synced from Blobs. This export stores the latest state payload in Blobs for audit/debug use.'
      });
    }

    if (request.method === 'GET' && pathname === '/events') {
      return new Response('Netlify deployment uses polling instead of SSE.', {
        status: 204,
        headers: {
          'access-control-allow-origin': '*'
        }
      });
    }

    if (request.method === 'GET' && pathname === '/gmail/status') {
      return json(200, { ...gmailSyncConfigStatus(), zapier: zapierSyncConfigStatus(), timestamp: nowIso() });
    }

    if (request.method === 'POST' && pathname === '/gmail/sync') {
      const secret = process.env.GMAIL_SYNC_SECRET || '';
      const provided = request.headers.get('x-gmail-sync-secret') || '';
      if (secret && secret !== provided) return json(401, { error: 'Unauthorized.' });

      const configStatus = gmailSyncConfigStatus();
      if (!configStatus.configured) {
        return json(200, {
          ok: false,
          configured: false,
          message: 'Gmail sync is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN in the Netlify dashboard → Site configuration → Environment variables.'
        });
      }

      // Read sync window from query string OR JSON body. Defaults preserve historic behavior.
      let bodyOpts = {};
      try { bodyOpts = await parseJsonBody(request); } catch {}
      const daysBack = Math.max(1, Math.min(
        Number(reqUrl.searchParams.get('days') || bodyOpts.days || bodyOpts.daysBack || 0) || 0,
        730
      ));
      const syncOpts = daysBack ? {
        daysBack,
        maxResults: Number(reqUrl.searchParams.get('max') || bodyOpts.maxResults || 0) || undefined
      } : {};

      const current = await getState(store);
      let carriers = clone(current.carriers || []);

      // Collect all connected users with refresh tokens
      let connectedUsers = [];
      try {
        const { blobs } = await store.list({ prefix: 'user-' });
        const all = await Promise.all(blobs.map(b => store.get(b.key, { type: 'json' })));
        connectedUsers = all.filter(u => u?.refreshToken);
      } catch {}

      let totalNewCarriers = [];
      let totalSkipped = 0;
      let totalScanned = 0;
      let totalUpdated = 0;
      let totalOutreachUpdated = 0;
      const userSyncResults = [];

      // Step 1: Scan each connected user's Gmail for Book Now emails + outreach threads
      const primaryEmail = process.env.GMAIL_USER_EMAIL || '';
      const coveredEmails = new Set();

      for (const u of connectedUsers) {
        if (coveredEmails.has(u.email)) continue;
        coveredEmails.add(u.email);
        try {
          const creds = { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: u.refreshToken, userEmail: u.email };

          // 1a + 1b + 1c run in parallel:
          //   1a: Book Now emails → new carriers from circledelivers.com dispatch emails
          //   1b: Outreach tracker → updates lastContactedDate on existing carriers
          //   1c: Sent mail scan → new carriers found in load-related sent emails
          const [bookNow, outreachResult, sentMailResult] = await Promise.all([
            syncNewCarriersFromBookNow(carriers, { credentials: creds, ...syncOpts }),
            syncCarrierOutreachFromGmail(carriers, { credentials: creds, ...syncOpts }).catch(err => ({ carriers, updated: 0, scanned: 0, _err: err.message })),
            syncNewCarriersFromSentMail(carriers, { credentials: creds, ...syncOpts }).catch(err => ({ newCarriers: [], scanned: 0, _err: err.message }))
          ]);

          // Merge: apply outreach updates first, then append new carriers from all sources
          const allNewCarriers = [...bookNow.newCarriers, ...(sentMailResult.newCarriers || [])];
          carriers = [...(outreachResult.carriers || carriers), ...allNewCarriers];
          totalNewCarriers.push(...allNewCarriers);
          totalSkipped += bookNow.skipped.length;
          totalScanned += bookNow.messagesScanned + (sentMailResult.scanned || 0);
          const outreachUpdated = outreachResult.updated || 0;
          const outreachScanned = outreachResult.scanned || 0;
          totalOutreachUpdated += outreachUpdated;

          userSyncResults.push({
            email: u.email, name: u.name,
            newCarriers: allNewCarriers.length,
            newFromBookNow: bookNow.newCarriers.length,
            newFromSentMail: (sentMailResult.newCarriers || []).length,
            scanned: bookNow.messagesScanned,
            outreachUpdated, outreachScanned,
            ok: true
          });
          await store.setJSON(`user-${u.email}`, { ...u, lastSync: nowIso() });
        } catch (err) {
          userSyncResults.push({ email: u.email, name: u.name, ok: false, error: err.message });
        }
      }

      // Also scan primary env-var account if not already covered
      if (primaryEmail && !coveredEmails.has(primaryEmail)) {
        try {
          const [bookNow, sentMailResult] = await Promise.all([
            syncNewCarriersFromBookNow(carriers, syncOpts),
            syncNewCarriersFromSentMail(carriers, syncOpts).catch(() => ({ newCarriers: [], scanned: 0 }))
          ]);
          const allNew = [...bookNow.newCarriers, ...(sentMailResult.newCarriers || [])];
          carriers = [...carriers, ...allNew];
          totalNewCarriers.push(...allNew);
          totalSkipped += bookNow.skipped.length;
          totalScanned += bookNow.messagesScanned + (sentMailResult.scanned || 0);
          userSyncResults.push({ email: primaryEmail, newCarriers: allNew.length, newFromBookNow: bookNow.newCarriers.length, newFromSentMail: (sentMailResult.newCarriers || []).length, scanned: bookNow.messagesScanned, ok: true });
        } catch (err) {
          userSyncResults.push({ email: primaryEmail, ok: false, error: err.message });
        }
      }

      // Detect auth failures before going further
      const authFailedAccounts = userSyncResults.filter(u => !u.ok && u.error && (
        u.error.includes('invalid_grant') || u.error.includes('token_revoked') ||
        u.error.includes('Token has been expired') || u.error.includes('token refresh failed')
      ));
      const allAuthFailed = userSyncResults.length > 0 && userSyncResults.every(u => !u.ok);
      const noAccountsAtAll = userSyncResults.length === 0;

      // If all accounts failed due to auth, return early with clear error — don't overwrite state
      if (allAuthFailed) {
        const isAuthErr = authFailedAccounts.length > 0;
        return json(200, {
          ok: false, configured: true,
          authExpired: isAuthErr,
          noAccounts: false,
          error: isAuthErr
            ? 'Gmail token expired or revoked. Re-authorize via Google sign-in to restore sync.'
            : 'All Gmail accounts failed to sync: ' + userSyncResults[0]?.error?.slice(0, 120),
          userResults: userSyncResults,
          accountsScanned: userSyncResults.length
        });
      }

      // If no accounts at all were found (no connected users + no env var email)
      if (noAccountsAtAll) {
        return json(200, {
          ok: false, configured: true,
          noAccounts: true,
          error: 'No Gmail accounts are connected. Sign in with your Circle Google account to connect Gmail.'
        });
      }

      // Step 2: Rate-con enrichment — uses the first connected user with a working token.
      // Also discovers new carriers from inbox RC emails (unmatched events).
      // Falls back to env-var GMAIL_REFRESH_TOKEN only if no connected account is available.
      let rcResult = { carriers, gmailSync: {}, newCarriers: [] };
      const workingUser = connectedUsers.find(u => userSyncResults.find(r => r.email === u.email && r.ok));
      try {
        const rcCreds = workingUser
          ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: workingUser.refreshToken, userEmail: workingUser.email }
          : null; // null → gmailConfig falls back to GMAIL_REFRESH_TOKEN env var
        rcResult = await syncCarriersFromGmail(carriers, rcCreds, syncOpts);
        carriers = rcResult.carriers || carriers;
        // Track any new carriers discovered from unmatched inbox RC events
        if (rcResult.newCarriers?.length) {
          totalNewCarriers.push(...rcResult.newCarriers);
        }
      } catch (rcErr) {
        // Non-fatal — log and continue without rate-con enrichment
        userSyncResults.push({ email: workingUser?.email || 'rate-con-sync', ok: false, error: 'Rate-con: ' + rcErr.message });
      }
      totalUpdated = rcResult.gmailSync?.matchedCarriers || 0;

      // Step 3: RC Thread Progress — reads full "Rate Confirmation for Load #X" threads
      // and parses carrier replies for pickup, ETA, delay, issue, and delivery signals.
      // Updates loadHistory.threadMessages[] so dispatchers see what carriers said.
      let rcThreadResult = { threadsScanned: 0, updatedCarriers: 0 };
      try {
        const rcThreadCreds = workingUser
          ? { clientId: GOOGLE_CLIENT_ID, clientSecret: GOOGLE_CLIENT_SECRET, refreshToken: workingUser.refreshToken, userEmail: workingUser.email }
          : null;
        rcThreadResult = await syncRCThreadProgress(carriers, { credentials: rcThreadCreds, ...syncOpts });
        carriers = rcThreadResult.carriers || carriers;
      } catch (rtErr) {
        // Non-fatal
      }

      const synced = await writeState(store, { ...current, carriers, carriersUpdatedAt: nowIso() }, 'gmail_sync');

      // Auto-snapshot AFTER successful sync — Gmail-independent disaster recovery.
      // Idempotent per day: writes to snapshots/YYYY-MM-DD (overwrites within same day).
      let snapshotKey = '';
      try {
        const dateKey = new Date().toISOString().slice(0, 10);
        snapshotKey = `snapshots/${dateKey}`;
        await store.setJSON(snapshotKey, {
          snapshotAt: nowIso(),
          revision: synced.meta?.revision,
          carrierCount: (synced.carriers || []).length,
          loadCount: ((synced.loadsData?.loads) || synced.loadsData || []).length,
          source: 'gmail_sync_auto',
          state: synced
        });
      } catch (snapErr) { /* non-fatal */ }

      // Identify any partial auth failures
      const partialAuthFail = authFailedAccounts.length > 0 && !allAuthFailed;

      const syncResponse = {
        ok: true, configured: true,
        windowDays: daysBack || 'default',
        newCarriers: totalNewCarriers.length,
        newCarrierNames: totalNewCarriers.map(c => c.company),
        skipped: totalSkipped,
        updatedFromRateCons: totalUpdated,
        outreachUpdated: totalOutreachUpdated,
        messagesScanned: totalScanned + (rcResult.gmailSync?.scannedMessages || 0),
        accountsScanned: userSyncResults.filter(u => u.ok).length,
        partialAuthFail,
        authFailedAccounts: authFailedAccounts.map(u => u.email),
        userResults: userSyncResults,
        revision: synced.meta.revision,
        carriersUpdatedAt: synced.carriersUpdatedAt,
        rcThreadsScanned: rcThreadResult.threadsScanned,
        rcThreadCarriersUpdated: rcThreadResult.updatedCarriers,
        snapshotKey,
        nothingNew: totalNewCarriers.length === 0 && totalUpdated === 0 && totalOutreachUpdated === 0 && rcThreadResult.updatedCarriers === 0
      };

      const userRows = userSyncResults.map(u =>
        `<tr><td>${u.email}</td><td>${u.ok ? '✅' : '❌'}</td><td>${u.newCarriers || 0}</td><td>${u.scanned || 0}</td><td>${u.error || ''}</td></tr>`
      ).join('');
      const newNames = totalNewCarriers.map(c => `<li>${c.company}</li>`).join('') || '<li>(none)</li>';
      await sendEmailNotification('✅ CarrierDB Sync Complete', `
        <h2>Carrier Sync Results</h2>
        <p><strong>New carriers added:</strong> ${totalNewCarriers.length}</p>
        <ul>${newNames}</ul>
        <p><strong>Messages scanned:</strong> ${syncResponse.messagesScanned}</p>
        <p><strong>Carriers updated from rate-cons:</strong> ${totalUpdated}</p>
        <p><strong>Accounts scanned:</strong> ${userSyncResults.length}</p>
        <table border="1" cellpadding="4" cellspacing="0">
          <thead><tr><th>Account</th><th>Status</th><th>New</th><th>Scanned</th><th>Error</th></tr></thead>
          <tbody>${userRows}</tbody>
        </table>
        <p><strong>Revision:</strong> ${synced.meta.revision} &nbsp; <strong>Time:</strong> ${nowIso()}</p>
      `);

      return json(200, syncResponse);
    }

    // ── Backups: snapshot, list, get, export ──────────────────────────────────
    // Disaster recovery — independent of Gmail. Live state always lives in
    // Netlify Blobs; these endpoints add daily snapshots + manual JSON export.
    if (request.method === 'POST' && pathname === '/backup/snapshot') {
      const state = await getState(store);
      const dateKey = new Date().toISOString().slice(0, 10);
      const key = `snapshots/${dateKey}`;
      await store.setJSON(key, {
        snapshotAt: nowIso(),
        revision: state.meta?.revision,
        carrierCount: (state.carriers || []).length,
        loadCount: ((state.loadsData?.loads) || state.loadsData || []).length,
        source: 'manual',
        state
      });
      return json(200, { ok: true, key, revision: state.meta?.revision, snapshotAt: nowIso() });
    }

    if (request.method === 'GET' && pathname === '/backup/list') {
      try {
        const { blobs } = await store.list({ prefix: 'snapshots/' });
        const items = await Promise.all((blobs || []).map(async b => {
          try {
            const meta = await store.get(b.key, { type: 'json' });
            return {
              key: b.key,
              date: b.key.replace(/^snapshots\//, ''),
              snapshotAt: meta?.snapshotAt,
              revision: meta?.revision,
              carrierCount: meta?.carrierCount,
              loadCount: meta?.loadCount,
              source: meta?.source
            };
          } catch { return { key: b.key, error: true }; }
        }));
        items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
        return json(200, { ok: true, count: items.length, snapshots: items });
      } catch (err) {
        return json(500, { ok: false, error: err.message });
      }
    }

    if (request.method === 'GET' && pathname.startsWith('/backup/get/')) {
      const dateKey = pathname.slice('/backup/get/'.length);
      const key = `snapshots/${dateKey}`;
      try {
        const snap = await store.get(key, { type: 'json' });
        if (!snap) return json(404, { ok: false, error: 'Snapshot not found' });
        return json(200, snap);
      } catch (err) {
        return json(500, { ok: false, error: err.message });
      }
    }

    if (request.method === 'GET' && pathname === '/backup/export') {
      const state = await getState(store);
      const filename = `carrierdb-backup-${new Date().toISOString().slice(0, 10)}.json`;
      return new Response(JSON.stringify({
        exportedAt: nowIso(),
        revision: state.meta?.revision,
        carrierCount: (state.carriers || []).length,
        loadCount: ((state.loadsData?.loads) || state.loadsData || []).length,
        carriers: state.carriers || [],
        loadsData: state.loadsData || { loads: [] },
        meta: state.meta || {}
      }, null, 2), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    if (request.method === 'GET' && pathname === '/zapier/status') {
      return json(200, { ...zapierSyncConfigStatus(), timestamp: nowIso() });
    }

    // ── Auth: GET /auth/google — begin OAuth flow ─────────────────────────────
    if (request.method === 'GET' && pathname === '/auth/google') {
      if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
        return redirect('/?auth_error=sso_not_configured');
      }
      const state = randomBytes(16).toString('hex');
      await store.setJSON(`oauth-state-${state}`, { created: Date.now() });
      const origin = serviceUrl(request);
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: `${origin}/api/auth/callback`,
        response_type: 'code',
        scope: 'openid email profile https://www.googleapis.com/auth/gmail.readonly',
        access_type: 'offline',
        prompt: 'consent',
        state
      });
      return redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params}`);
    }

    // ── Auth: GET /auth/callback — OAuth callback ─────────────────────────────
    if (request.method === 'GET' && pathname === '/auth/callback') {
      const url2 = new URL(request.url);
      const code = url2.searchParams.get('code');
      const state = url2.searchParams.get('state');
      const oauthError = url2.searchParams.get('error');
      if (oauthError) return redirect(`/?auth_error=${encodeURIComponent(oauthError)}`);
      if (!code || !state) return redirect('/?auth_error=missing_params');

      // Verify CSRF state
      const storedState = await store.get(`oauth-state-${state}`, { type: 'json' });
      if (!storedState || (Date.now() - storedState.created) > 10 * 60 * 1000) {
        return redirect('/?auth_error=invalid_state');
      }
      try { await store.delete(`oauth-state-${state}`); } catch {}

      // Exchange code for tokens
      const origin = serviceUrl(request);
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          code, client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: `${origin}/api/auth/callback`, grant_type: 'authorization_code'
        })
      });
      const tokens = await tokenRes.json();
      if (!tokenRes.ok || tokens.error) {
        const errMsg = tokens.error_description || tokens.error || 'token_exchange_failed';
        await sendEmailNotification('❌ CarrierDB Login Error', `
          <p>A login attempt failed during token exchange.</p>
          <p><strong>Error:</strong> ${errMsg}</p>
          <p><strong>Time:</strong> ${nowIso()}</p>
        `);
        return redirect(`/?auth_error=${encodeURIComponent(errMsg)}`);
      }

      // Get Google user info
      const userRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
        headers: { Authorization: `Bearer ${tokens.access_token}` }
      });
      const userInfo = await userRes.json();
      if (!userInfo.email) return redirect('/?auth_error=no_email_returned');

      // Enforce domain allowlist
      const domain = (userInfo.email.split('@')[1] || '').toLowerCase();
      if (ALLOWED_DOMAINS.length && !ALLOWED_DOMAINS.includes(domain)) {
        await sendEmailNotification('⚠️ CarrierDB Blocked Login Attempt', `
          <p>Someone tried to sign in with an unauthorized Google account.</p>
          <p><strong>Email attempted:</strong> ${userInfo.email}</p>
          <p><strong>Name:</strong> ${userInfo.name || '(unknown)'}</p>
          <p><strong>Domain:</strong> ${domain}</p>
          <p><strong>Allowed domains:</strong> ${ALLOWED_DOMAINS.join(', ')}</p>
          <p><strong>Time:</strong> ${nowIso()}</p>
        `);
        return redirect(`/?auth_error=unauthorized_domain&hint=${encodeURIComponent(userInfo.email)}`);
      }

      // Load existing user record to preserve refresh token if not re-issued
      const existingUser = await store.get(`user-${userInfo.email}`, { type: 'json' }) || {};
      const userData = {
        email: userInfo.email,
        name: userInfo.name || userInfo.email,
        picture: userInfo.picture || '',
        refreshToken: tokens.refresh_token || existingUser.refreshToken || null,
        scopes: tokens.scope || existingUser.scopes || '',
        connectedAt: existingUser.connectedAt || nowIso(),
        lastSync: existingUser.lastSync || null,
        updatedAt: nowIso()
      };
      await store.setJSON(`user-${userInfo.email}`, userData);

      const isNewUser = !existingUser.connectedAt;
      await sendEmailNotification(
        `🔔 CarrierDB Login: ${userData.name}`,
        `
          <p>${isNewUser ? 'A <strong>new user</strong> just connected their Google account.' : 'A user signed in.'}</p>
          <p><strong>Name:</strong> ${userData.name}</p>
          <p><strong>Email:</strong> ${userData.email}</p>
          <p><strong>Gmail connected:</strong> ${userData.refreshToken ? 'Yes' : 'No'}</p>
          <p><strong>First connected:</strong> ${userData.connectedAt}</p>
          <p><strong>Time:</strong> ${nowIso()}</p>
        `
      );

      const cookie = makeSessionCookie(userData);
      return redirect('/', { 'Set-Cookie': cookie });
    }

    // ── Auth: GET /auth/me — current session info ─────────────────────────────
    if (request.method === 'GET' && pathname === '/auth/me') {
      const sessionUser = getSessionUser(request);
      if (!sessionUser) return json(200, { authenticated: false });
      const userData = await store.get(`user-${sessionUser.email}`, { type: 'json' });
      return json(200, {
        authenticated: true,
        user: { email: sessionUser.email, name: sessionUser.name, picture: sessionUser.picture },
        gmailConnected: !!(userData?.refreshToken),
        lastSync: userData?.lastSync || null,
        connectedAt: userData?.connectedAt || null
      });
    }

    // ── Auth: POST /auth/logout ───────────────────────────────────────────────
    if (request.method === 'POST' && pathname === '/auth/logout') {
      return json(200, { ok: true }, { 'Set-Cookie': clearSessionCookie() });
    }

    // ── Auth: GET /auth/users — list all connected Gmail accounts ─────────────
    if (request.method === 'GET' && pathname === '/auth/users') {
      const sessionUser = getSessionUser(request);
      if (!sessionUser) return json(401, { error: 'Login required.' });
      const { blobs } = await store.list({ prefix: 'user-' });
      const users = await Promise.all(blobs.map(async b => {
        const u = await store.get(b.key, { type: 'json' });
        if (!u) return null;
        return {
          email: u.email, name: u.name, picture: u.picture,
          gmailConnected: !!(u.refreshToken),
          connectedAt: u.connectedAt, lastSync: u.lastSync,
          isCurrentUser: u.email === sessionUser.email
        };
      }));
      return json(200, { users: users.filter(Boolean), currentUserEmail: sessionUser.email });
    }

    // ── Auth: DELETE /auth/users/:email — disconnect a Gmail account ──────────
    if (request.method === 'DELETE' && pathname.startsWith('/auth/users/')) {
      const sessionUser = getSessionUser(request);
      if (!sessionUser) return json(401, { error: 'Login required.' });
      const targetEmail = decodeURIComponent(pathname.slice('/auth/users/'.length));
      if (!targetEmail) return json(400, { error: 'Missing email.' });
      // Users can only disconnect themselves (unless we add admin roles later)
      if (sessionUser.email !== targetEmail) return json(403, { error: 'You can only disconnect your own account.' });
      await store.delete(`user-${targetEmail}`);
      return json(200, { ok: true, 'Set-Cookie': clearSessionCookie() }, { 'Set-Cookie': clearSessionCookie() });
    }

    return json(404, { error: 'Not found.', route: pathname });
  } catch (error) {
    return json(400, { error: error.message || 'Request failed.' });
  }
};
