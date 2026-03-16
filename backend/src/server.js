import fs from 'node:fs';
import http from 'node:http';
import { URL } from 'node:url';
import { getAuthContext } from './auth.js';
import { config } from './config.js';
import { createStore } from './store.js';

const store = await createStore();
const sseClients = new Set();

store.subscribe((event) => {
  const payload = `event: update\ndata: ${JSON.stringify(event)}\n\n`;
  for (const res of sseClients) {
    res.write(payload);
  }
});

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, X-Goog-Authenticated-User-Email, X-Goog-Authenticated-User-Id',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,OPTIONS'
  };
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...corsHeaders()
  });
  res.end(JSON.stringify(payload, null, 2));
}

function sendNoContent(res) {
  res.writeHead(204, corsHeaders());
  res.end();
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8'
  });
  res.end(html);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 5000000) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function requireAuth(req, res) {
  const auth = getAuthContext(req, { allowUnauthenticated: config.allowUnauthenticated });
  if (!auth) {
    sendJson(res, 401, { error: 'Authentication required. In Google Cloud, place this service behind IAP or Cloud Identity-Aware auth.' });
    return null;
  }
  return auth;
}

function notFound(res) {
  sendJson(res, 404, { error: 'Not found.' });
}

function serveFrontend(res) {
  const html = fs.readFileSync(config.liveHtmlPath, 'utf8');
  sendHtml(res, html);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    sendNoContent(res);
    return;
  }

  if (req.method === 'GET' && (pathname === '/' || pathname === '/carrier-database.html')) {
    serveFrontend(res);
    return;
  }

  const auth = requireAuth(req, res);
  if (!auth) return;

  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      const snapshot = await store.snapshot();
      sendJson(res, 200, {
        ok: true,
        service: 'carrier-dashboard-backend',
        revision: snapshot.meta.revision,
        backend: config.stateBackend,
        googleCloudProject: config.googleCloudProject,
        googleMapsConfigured: Boolean(config.googleMapsApiKey),
        currentUser: auth
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/me') {
      sendJson(res, 200, { user: auth });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/bootstrap') {
      sendJson(res, 200, {
        ...(await store.bootstrap()),
        currentUser: auth,
        deployment: {
          backend: config.stateBackend,
          googleCloudProject: config.googleCloudProject,
          googleCloudRegion: config.googleCloudRegion,
          googleMapsApiKey: config.googleMapsApiKey,
          serviceUrl: process.env.SERVICE_URL || ''
        }
      });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/carriers') {
      sendJson(res, 200, { carriers: await store.listCarriers() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/carriers') {
      const body = await parseBody(req);
      sendJson(res, 201, { carrier: await store.upsertCarrier({ ...body, updated_by: auth.email || auth.userId }) });
      return;
    }

    if (req.method === 'PATCH' && pathname.startsWith('/api/carriers/')) {
      const id = pathname.split('/').pop();
      const body = await parseBody(req);
      sendJson(res, 200, { carrier: await store.upsertCarrier({ ...body, id: Number(id) || id, updated_by: auth.email || auth.userId }) });
      return;
    }

    if (req.method === 'GET' && pathname === '/api/loads') {
      sendJson(res, 200, { loads: await store.listLoads() });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/loads') {
      const body = await parseBody(req);
      sendJson(res, 201, { load: await store.upsertLoad({ ...body, updated_by: auth.email || auth.userId }) });
      return;
    }

    if (req.method === 'PATCH' && pathname.startsWith('/api/loads/')) {
      const loadId = pathname.split('/').pop();
      const body = await parseBody(req);
      sendJson(res, 200, { load: await store.upsertLoad({ ...body, load_id: loadId, updated_by: auth.email || auth.userId }) });
      return;
    }

    if (req.method === 'POST' && pathname === '/api/state/sync') {
      const body = await parseBody(req);
      sendJson(res, 200, await store.syncState({ ...body, source: auth.email || auth.userId || 'api_sync' }));
      return;
    }

    if (req.method === 'POST' && pathname === '/api/export/html') {
      sendJson(res, 200, await store.exportHtml());
      return;
    }

    if (req.method === 'GET' && pathname === '/api/events') {
      const snapshot = await store.snapshot();
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*'
      });
      res.write(`event: ready\ndata: ${JSON.stringify({ ok: true, revision: snapshot.meta.revision, user: auth })}\n\n`);
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    notFound(res);
  } catch (error) {
    sendJson(res, 400, { error: error.message || 'Request failed.' });
  }
});

server.listen(config.port, config.host, () => {
  console.log(`carrier-dashboard-backend listening on http://${config.host}:${config.port}`);
});
