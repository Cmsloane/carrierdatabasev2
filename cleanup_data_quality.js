#!/usr/bin/env node
/**
 * cleanup_data_quality.js — One-time fixes for misc data mistakes found in
 * the live carrier DB. Targeted, conservative changes:
 *
 *   1. Clean 3 carriers with "Location"-prefix dirty preferredLanes (IDs 201, 273, 275)
 *   2. Fix 14 carriers with malformed lastActive ("2026-03" → "2026-03-01")
 *   3. Fix 2 carriers whose company name is "<dispatcher> via <Company>" artifact
 *      (IDs 279, 285) — set company to parent, move dispatcher to dispatcher field
 *   4. Migrate ~120 carriers from status:"Active" → status:"Approved"
 *      ("Active" is not in the UI status filter dropdown; "Approved" is the
 *      generic equivalent per CLAUDE.md schema docs)
 *
 * Snapshots before AND after via /api/backup/snapshot. Single bulk PATCH via
 * /api/state/sync to keep revision count low.
 */

const API = 'https://carrierdatabasev2.netlify.app';
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','ON','BC','AB','QC','MB','SK'
]);
const NOISE_RE = /^(Location|Located|Origin\s*:|Pickup\s*:|Delivery\s*:|Destination\s*:|Consignee\s*:|From\s*:|Shipper\s*:|Carrier\s+booked\s+on|booked\s+on|ated\s+outside\s+of|outside\s+of)\s+/gi;

function cleanCity(raw) {
  if (!raw) return '';
  let s = raw.trim();
  for (let i = 0; i < 4; i++) {
    const prev = s; s = s.replace(NOISE_RE, '');
    if (s === prev) break;
  }
  const m = s.match(/^([A-Z][A-Za-z\s.\-']{0,45}),\s*([A-Z]{2})\b/i);
  if (!m) return '';
  const state = m[2].toUpperCase();
  if (!US_STATES.has(state)) return '';
  const city = m[1].trim();
  if (city.split(/\s+/).length > 5) return '';
  return city.replace(/\b\w/g, ch => ch.toUpperCase()) + ', ' + state;
}

function cleanSegment(seg) {
  const arrowMatch = seg.match(/^(.+?)\s*(?:→|->)\s*(.+)$/);
  if (arrowMatch) {
    const orig = cleanCity(arrowMatch[1]);
    const dest = cleanCity(arrowMatch[2]);
    if (orig && dest) return orig + ' → ' + dest;
    if (orig) return orig;
    if (dest) return dest;
    return '';
  }
  return cleanCity(seg) || '';
}

function cleanLane(raw) {
  if (!raw) return raw;
  return raw.split(/\s*[·•]\s*/)
    .map(s => cleanSegment(s.trim()))
    .filter(Boolean)
    .join(' · ');
}

async function main() {
  console.log('=== Pre-cleanup snapshot ===');
  const presnap = await fetch(API + '/api/backup/snapshot', { method: 'POST' }).then(r => r.json());
  console.log('  ', presnap);

  console.log('\n=== Loading live state ===');
  const data = await fetch(API + '/api/bootstrap').then(r => r.json());
  const carriers = data.carriers || [];
  const loadsData = data.loadsData || { loads: [] };
  console.log('  Loaded', carriers.length, 'carriers, revision', data.meta && data.meta.revision);

  const changes = [];
  let modified = 0;

  for (const c of carriers) {
    const before = JSON.stringify(c);
    const log = [];

    // FIX 1: dirty preferredLanes
    if (c.preferredLanes && /Location|Happyrobot|booked|outside|ated outside|Carrier booked/i.test(c.preferredLanes)) {
      const cleaned = cleanLane(c.preferredLanes);
      if (cleaned && cleaned !== c.preferredLanes) {
        log.push('preferredLanes: "' + c.preferredLanes.slice(0, 60) + '..." → "' + cleaned.slice(0, 60) + '"');
        c.preferredLanes = cleaned;
      }
    }

    // FIX 2: malformed lastActive ("2026-03" → "2026-03-01")
    if (c.lastActive && /^\d{4}-\d{2}$/.test(c.lastActive)) {
      const next = c.lastActive + '-01';
      log.push('lastActive: "' + c.lastActive + '" → "' + next + '"');
      c.lastActive = next;
    }

    // FIX 3: "<dispatcher> via <Company>" artifact company names
    const viaMatch = c.company && c.company.match(/^([a-z]+(?:\.[a-z]+)?)\s+via\s+(.+)$/i);
    if (viaMatch) {
      const oldCompany = c.company;
      const dispUser = viaMatch[1];
      const parentCo = viaMatch[2].trim();
      c.company = parentCo;
      // Append dispatch user to dispatcher if not already there
      if (!c.dispatcher) c.dispatcher = dispUser;
      else if (!c.dispatcher.toLowerCase().includes(dispUser.toLowerCase())) {
        c.dispatcher = dispUser + ' / ' + c.dispatcher;
      }
      log.push('company: "' + oldCompany + '" → "' + parentCo + '" (dispatcher: "' + c.dispatcher + '")');
    }

    // FIX 4: status:"Active" → "Approved"
    if (c.status === 'Active') {
      c.status = 'Approved';
      log.push('status: "Active" → "Approved"');
    }

    if (JSON.stringify(c) !== before) {
      modified++;
      changes.push({ id: c.id, company: c.company, log });
    }
  }

  console.log('\n=== Changes summary ===');
  console.log('  Modified', modified, 'of', carriers.length, 'carriers');
  console.log('\n  Sample changes:');
  changes.slice(0, 25).forEach(({ id, company, log }) => {
    console.log('    [' + id + '] ' + company);
    log.forEach(l => console.log('       · ' + l));
  });
  if (changes.length > 25) console.log('    ... and ' + (changes.length - 25) + ' more');

  if (modified === 0) {
    console.log('\nNothing to do.');
    return;
  }

  console.log('\n=== Pushing bulk update ===');
  const now = new Date().toISOString();
  const r = await fetch(API + '/api/state/sync', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ carriers, loadsData, carriersUpdatedAt: now })
  });
  const result = await r.json();
  console.log('  Server response:', JSON.stringify(result, null, 2).slice(0, 500));

  console.log('\n=== Post-cleanup snapshot ===');
  const postsnap = await fetch(API + '/api/backup/snapshot', { method: 'POST' }).then(r => r.json());
  console.log('  ', postsnap);

  // Quick re-audit
  console.log('\n=== Re-audit ===');
  const after = await fetch(API + '/api/bootstrap').then(r => r.json());
  const cs2 = after.carriers || [];
  const stillDirty = cs2.filter(c => c.preferredLanes && /Location|Happyrobot|outside|booked/i.test(c.preferredLanes));
  const stillBadDate = cs2.filter(c => c.lastActive && /^\d{4}-\d{2}$/.test(c.lastActive));
  const stillVia = cs2.filter(c => /^\w+\s+via\s+/i.test(c.company || ''));
  const stillActive = cs2.filter(c => c.status === 'Active');
  console.log('  Dirty preferredLanes remaining:', stillDirty.length);
  console.log('  Malformed lastActive remaining:', stillBadDate.length);
  console.log('  "via" company names remaining:', stillVia.length);
  console.log('  status="Active" remaining:    ', stillActive.length);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
