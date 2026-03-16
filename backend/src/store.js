import fs from 'node:fs';
import { Firestore } from '@google-cloud/firestore';
import { Storage } from '@google-cloud/storage';
import { config } from './config.js';
import { exportOfflineHtml, renderOfflineHtml } from './offline-html.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function makeMeta(currentMeta, overrides = {}) {
  return {
    ...(currentMeta || {}),
    ...overrides,
    lastSyncedAt: nowIso(),
    revision: Number(overrides.revision || currentMeta?.revision || 0),
    backend: config.stateBackend
  };
}

function normalizeSeed() {
  if (fs.existsSync(config.statePath)) {
    return readJson(config.statePath);
  }

  if (fs.existsSync(config.carriersPath) && fs.existsSync(config.loadsPath)) {
    const carriersPayload = readJson(config.carriersPath);
    const loadsPayload = readJson(config.loadsPath);
    return {
      carriers: carriersPayload.carriers || carriersPayload,
      loadsData: loadsPayload,
      meta: {
        lastSyncedAt: loadsPayload.synced_at || nowIso(),
        source: 'local_seed',
        revision: 1,
        backend: config.stateBackend
      }
    };
  }

  return {
    carriers: [],
    loadsData: {
      synced_at: nowIso(),
      total_available: 0,
      loads_captured: 0,
      loads: []
    },
    meta: {
      lastSyncedAt: nowIso(),
      source: 'empty_seed',
      revision: 1,
      backend: config.stateBackend
    }
  };
}

class BaseDashboardStore {
  constructor() {
    this.listeners = new Set();
    this.state = null;
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  snapshot() {
    return clone(this.state);
  }
}

export class FileDashboardStore extends BaseDashboardStore {
  constructor() {
    super();
    ensureDir(config.dataDir);
    this.state = this.loadState();
  }

  loadState() {
    const seeded = normalizeSeed();
    if (!seeded.meta) {
      seeded.meta = makeMeta({}, { source: 'seed', revision: 1 });
    }
    if (fs.existsSync(config.statePath)) {
      return seeded;
    }
    this.persist(seeded, { skipBroadcast: true, reason: 'seed' });
    return seeded;
  }

  persist(nextState, { skipBroadcast = false, reason = 'update' } = {}) {
    const nextRevision = Number(nextState.meta?.revision || this.state?.meta?.revision || 0) + 1;
    nextState.meta = makeMeta(nextState.meta, { revision: nextRevision, source: nextState.meta?.source || reason });
    this.state = nextState;
    fs.writeFileSync(config.statePath, JSON.stringify(nextState, null, 2), 'utf8');
    if (config.offlineExportEnabled) {
      exportOfflineHtml({
        templatePath: config.htmlTemplatePath,
        outPath: config.liveHtmlPath,
        carriers: nextState.carriers,
        loadsData: nextState.loadsData
      });
    }
    if (!skipBroadcast) {
      this.emit({ type: reason, revision: nextState.meta.revision, at: nextState.meta.lastSyncedAt });
    }
  }

  async listCarriers() {
    return clone(this.state.carriers);
  }

  async listLoads() {
    return clone(this.state.loadsData.loads || []);
  }

  async bootstrap() {
    return this.snapshot();
  }

  async upsertCarrier(input) {
    const carriers = clone(this.state.carriers);
    const id = input.id || (Math.max(0, ...carriers.map((item) => Number(item.id) || 0)) + 1);
    const index = carriers.findIndex((item) => String(item.id) === String(id));
    const next = { ...(index >= 0 ? carriers[index] : {}), ...input, id };
    if (index >= 0) carriers[index] = next;
    else carriers.push(next);
    this.persist({ ...this.snapshot(), carriers, meta: { ...(this.state.meta || {}), source: 'carrier_upsert' } }, { reason: 'carrier_upsert' });
    return next;
  }

  async upsertLoad(input) {
    const state = this.snapshot();
    const loads = clone(state.loadsData.loads || []);
    const loadId = String(input.load_id || '');
    if (!loadId) throw new Error('load_id is required.');
    const index = loads.findIndex((item) => String(item.load_id) === loadId);
    const next = { ...(index >= 0 ? loads[index] : {}), ...input, load_id: loadId };
    if (index >= 0) loads[index] = next;
    else loads.push(next);
    const loadsData = {
      ...state.loadsData,
      synced_at: nowIso(),
      total_available: loads.length,
      loads_captured: loads.length,
      loads
    };
    this.persist({ ...state, loadsData, meta: { ...(state.meta || {}), source: 'load_upsert' } }, { reason: 'load_upsert' });
    return next;
  }

  async syncState(input) {
    const state = this.snapshot();
    const next = {
      carriers: input.carriers || state.carriers,
      loadsData: input.loadsData || state.loadsData,
      meta: {
        ...(state.meta || {}),
        source: input.source || 'api_sync'
      }
    };
    this.persist(next, { reason: 'state_sync' });
    return this.snapshot();
  }

  async exportHtml() {
    if (!config.offlineExportEnabled) {
      return {
        outPath: config.liveHtmlPath,
        revision: this.state.meta.revision,
        synced_at: this.state.meta.lastSyncedAt,
        skipped: true
      };
    }
    exportOfflineHtml({
      templatePath: config.htmlTemplatePath,
      outPath: config.liveHtmlPath,
      carriers: this.state.carriers,
      loadsData: this.state.loadsData
    });
    return {
      outPath: config.liveHtmlPath,
      revision: this.state.meta.revision,
      synced_at: this.state.meta.lastSyncedAt
    };
  }
}

class FirestoreDashboardStore extends BaseDashboardStore {
  constructor() {
    super();
    this.firestore = new Firestore({ projectId: config.googleCloudProject || undefined });
    this.storage = config.cloudStorageBucket ? new Storage({ projectId: config.googleCloudProject || undefined }) : null;
    this.docRef = this.firestore.collection(config.firestoreCollection).doc(config.firestoreDocumentId);
    this.unsubscribe = null;
  }

  static async create() {
    const store = new FirestoreDashboardStore();
    await store.init();
    return store;
  }

  async init() {
    const snapshot = await this.docRef.get();
    if (snapshot.exists) {
      this.state = snapshot.data();
    } else {
      const seeded = normalizeSeed();
      seeded.meta = makeMeta(seeded.meta, { revision: Number(seeded.meta?.revision || 0) || 1, source: seeded.meta?.source || 'seed' });
      this.state = seeded;
      await this.docRef.set(seeded);
    }

    this.unsubscribe = this.docRef.onSnapshot((doc) => {
      if (!doc.exists) return;
      const next = doc.data();
      const prevRevision = Number(this.state?.meta?.revision || 0);
      this.state = next;
      const nextRevision = Number(next?.meta?.revision || 0);
      if (prevRevision && nextRevision && nextRevision !== prevRevision) {
        this.emit({ type: 'state_sync', revision: nextRevision, at: next?.meta?.lastSyncedAt || nowIso() });
      }
    });
  }

  async listCarriers() {
    return clone(this.state.carriers || []);
  }

  async listLoads() {
    return clone(this.state.loadsData?.loads || []);
  }

  async bootstrap() {
    return this.snapshot();
  }

  async write(mutator, source) {
    const result = await this.firestore.runTransaction(async (tx) => {
      const snapshot = await tx.get(this.docRef);
      const current = snapshot.exists ? snapshot.data() : normalizeSeed();
      const base = clone(current);
      const next = mutator(base);
      const nextRevision = Number(current?.meta?.revision || 0) + 1;
      next.meta = makeMeta(next.meta || current.meta, { revision: nextRevision, source });
      tx.set(this.docRef, next);
      return next;
    });

    this.state = result;
    if (config.offlineExportEnabled) {
      await this.exportHtml();
    }
    return clone(result);
  }

  async upsertCarrier(input) {
    let savedCarrier = null;
    await this.write((state) => {
      const carriers = clone(state.carriers || []);
      const id = input.id || (Math.max(0, ...carriers.map((item) => Number(item.id) || 0)) + 1);
      const index = carriers.findIndex((item) => String(item.id) === String(id));
      const next = { ...(index >= 0 ? carriers[index] : {}), ...input, id };
      if (index >= 0) carriers[index] = next;
      else carriers.push(next);
      savedCarrier = next;
      return { ...state, carriers };
    }, 'carrier_upsert');
    return savedCarrier;
  }

  async upsertLoad(input) {
    const loadId = String(input.load_id || '');
    if (!loadId) throw new Error('load_id is required.');
    const nextState = await this.write((state) => {
      const loads = clone(state.loadsData?.loads || []);
      const index = loads.findIndex((item) => String(item.load_id) === loadId);
      const next = { ...(index >= 0 ? loads[index] : {}), ...input, load_id: loadId };
      if (index >= 0) loads[index] = next;
      else loads.push(next);
      return {
        ...state,
        loadsData: {
          ...(state.loadsData || {}),
          synced_at: nowIso(),
          total_available: loads.length,
          loads_captured: loads.length,
          loads
        }
      };
    }, 'load_upsert');
    return nextState.loadsData.loads.find((item) => String(item.load_id) === loadId);
  }

  async syncState(input) {
    return this.write((state) => ({
      carriers: input.carriers || state.carriers,
      loadsData: input.loadsData || state.loadsData,
      meta: {
        ...(state.meta || {}),
        source: input.source || 'api_sync'
      }
    }), input.source || 'state_sync');
  }

  async exportHtml() {
    const html = renderOfflineHtml({
      templatePath: config.htmlTemplatePath,
      carriers: this.state.carriers,
      loadsData: this.state.loadsData
    });

    if (this.storage && config.cloudStorageBucket) {
      const file = this.storage.bucket(config.cloudStorageBucket).file(config.offlineExportObject);
      await file.save(html, { contentType: 'text/html; charset=utf-8' });
      return {
        bucket: config.cloudStorageBucket,
        object: config.offlineExportObject,
        revision: this.state.meta.revision,
        synced_at: this.state.meta.lastSyncedAt
      };
    }

    fs.writeFileSync(config.liveHtmlPath, html, 'utf8');
    return {
      outPath: config.liveHtmlPath,
      revision: this.state.meta.revision,
      synced_at: this.state.meta.lastSyncedAt,
      fallbackWrite: true
    };
  }
}

export async function createStore() {
  if (config.stateBackend === 'file') {
    return new FileDashboardStore();
  }
  if (config.stateBackend === 'firestore') {
    return FirestoreDashboardStore.create();
  }
  throw new Error(`Unsupported STATE_BACKEND: ${config.stateBackend}`);
}

