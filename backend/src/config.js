import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..', '..');
const backendDir = path.join(rootDir, 'backend');

export const config = {
  port: Number(process.env.PORT || 3030),
  host: process.env.HOST || '0.0.0.0',
  rootDir,
  backendDir,
  dataDir: path.join(backendDir, 'data'),
  statePath: path.join(backendDir, 'data', 'state.json'),
  carriersPath: path.join(rootDir, 'carriers.json'),
  loadsPath: path.join(rootDir, 'loads_backup.json'),
  liveHtmlPath: path.join(rootDir, 'carrier-database.html'),
  htmlTemplatePath: path.join(rootDir, 'carrier-database.html'),
  stateBackend: process.env.STATE_BACKEND || 'file',
  allowUnauthenticated: String(process.env.ALLOW_UNAUTHENTICATED || 'true') === 'true',
  offlineExportEnabled: String(process.env.OFFLINE_EXPORT_ENABLED || 'true') === 'true',
  googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT || '',
  googleCloudRegion: process.env.GOOGLE_CLOUD_REGION || 'us-central1',
  googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
  firestoreCollection: process.env.FIRESTORE_COLLECTION || 'carrierDashboard',
  firestoreDocumentId: process.env.FIRESTORE_DOCUMENT_ID || 'primary',
  cloudStorageBucket: process.env.CLOUD_STORAGE_BUCKET || '',
  offlineExportObject: process.env.OFFLINE_EXPORT_OBJECT || 'exports/carrier-database.html'
};
