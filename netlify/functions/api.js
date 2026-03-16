import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getStore } from '@netlify/blobs';

const functionFilename = fileURLToPath(import.meta.url);
const functionDir = path.dirname(functionFilename);
const ROOT_DIR = path.resolve(functionDir, '..', '..');
const STATE_SEED_PATH = path.join(ROOT_DIR, 'backend', 'data', 'state.json');
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || '';

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function json(statusCode, payload) {
  return new Response(JSON.stringify(payload, null, 2), {
    status: statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Content-Type, X-Goog-Authenticated-User-Email, X-Goog-Authenticated-User-Id',
      'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS'
    }
  });
}

function noContent() {
  return new Response(null, {
    status: 204,
    headers: {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'Content-Type, X-Goog-Authenticated-User-Email, X-Goog-Authenticated-User-Id',
      'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS'
    }
  });
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
  const payload = {
    carriers: nextState.carriers || [],
    loadsData: nextState.loadsData || { synced_at: nowIso(), total_available: 0, loads_captured: 0, loads: [] },
    meta: {
      ...(nextState.meta || {}),
      source: source || 'netlify_sync',
      lastSyncedAt: nowIso(),
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

  const pathname = parseRoute(new URL(request.url).pathname);
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
      const synced = await writeState(store, {
        carriers: body.carriers || current.carriers,
        loadsData: body.loadsData || current.loadsData,
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
      await writeState(store, { ...current, carriers }, 'carrier_upsert');
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
      await writeState(store, { ...current, carriers }, 'carrier_patch');
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

    return json(404, { error: 'Not found.', route: pathname });
  } catch (error) {
    return json(400, { error: error.message || 'Request failed.' });
  }
};
