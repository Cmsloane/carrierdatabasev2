#!/usr/bin/env node
/**
 * clean_lanes.js — One-time script to clean up dirty preferredLanes data
 * in the live Netlify Blobs carrier database.
 *
 * Run: node clean_lanes.js
 *
 * What it does:
 *  1. Fetches all carriers from the live API
 *  2. Applies cleanLane() to each carrier's preferredLanes field
 *  3. Reports what changed
 *  4. PATCHes each changed carrier via /api/carriers/:id
 */

const API = 'https://carrierdatabasev2.netlify.app';

// Valid US (and select Canadian) state/province codes
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC','ON','BC','AB','QC','MB','SK'
]);

const CITY_NOISE_RE = /^(Location|Located|Origin\s*:|Pickup\s*:|Delivery\s*:|Destination\s*:|Consignee\s*:|From\s*:|Shipper\s*:|Carrier\s+booked\s+on|booked\s+on|ated\s+outside\s+of|outside\s+of)\s+/gi;
const CITY_GARBAGE = /\b(Location|Located|Carrier|Happyrobot|booked|outside|Transportation|Offer|Incorporated|Logistics|Trucking|Express|Freight|Services|Systems)\b/i;

/**
 * Validate and clean a single "City, ST" string.
 * Returns "City, ST" or '' if invalid.
 */
function cleanRouteCity(raw) {
  if (!raw) return '';
  let s = raw.trim();
  for (let i = 0; i < 4; i++) {
    const prev = s;
    s = s.replace(CITY_NOISE_RE, '');
    if (s === prev) break;
  }
  const m = s.match(/^([A-Z][A-Za-z\s.\-']{0,45}),\s*([A-Z]{2})\b/i);
  if (!m) return '';
  const state = m[2].toUpperCase();
  if (!US_STATES.has(state)) return '';
  const city = m[1].trim();
  if (city.split(/\s+/).length > 5) return '';
  if (CITY_GARBAGE.test(city)) return '';
  return city.replace(/\b\w/g, ch => ch.toUpperCase()) + ', ' + state;
}

/**
 * Clean one lane segment like "Location PORT ALLEN, LA" → "Port Allen, LA"
 * Handles "City, ST → City, ST" format.
 */
function cleanLaneSegment(seg) {
  const arrowMatch = seg.match(/^(.+?)\s*(?:→|->)\s*(.+)$/);
  if (arrowMatch) {
    const orig = cleanRouteCity(arrowMatch[1]);
    const dest = cleanRouteCity(arrowMatch[2]);
    if (orig && dest) return `${orig} → ${dest}`;
    if (orig) return orig;
    if (dest) return dest;
    return ''; // both invalid — drop this segment
  }
  // No arrow — single city/state
  return cleanRouteCity(seg) || seg.trim();
}

/**
 * Clean the full preferredLanes string (may have multiple segments separated by ·)
 */
function cleanLane(raw) {
  if (!raw) return raw;
  const segments = raw.split(/\s*[·•]\s*/);
  const cleaned = segments
    .map(s => cleanLaneSegment(s.trim()))
    .filter(Boolean);
  return cleaned.join(' · ');
}

async function main() {
  console.log('Fetching live carriers…');
  const res = await fetch(`${API}/api/carriers`);
  if (!res.ok) throw new Error(`GET /api/carriers → ${res.status}`);
  const body = await res.json();
  const carriers = Array.isArray(body) ? body : (body.carriers || []);
  console.log(`  ${carriers.length} carriers loaded\n`);

  const toFix = [];
  for (const c of carriers) {
    const orig = c.preferredLanes || '';
    const cleaned = cleanLane(orig);
    if (cleaned !== orig) {
      toFix.push({ id: c.id, company: c.company, orig, cleaned });
    }
  }

  if (!toFix.length) {
    console.log('✓ All carrier lanes are already clean. Nothing to do.');
    return;
  }

  console.log(`Found ${toFix.length} carrier(s) with dirty lane data:\n`);
  toFix.forEach(({ id, company, orig, cleaned }) => {
    console.log(`  [${id}] ${company}`);
    console.log(`    WAS: ${orig.slice(0, 100)}`);
    console.log(`    NOW: ${cleaned.slice(0, 100)}`);
    console.log('');
  });

  // PATCH each carrier
  let ok = 0, fail = 0;
  for (const { id, company, cleaned } of toFix) {
    try {
      const r = await fetch(`${API}/api/carriers/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preferredLanes: cleaned })
      });
      if (r.ok) {
        ok++;
        process.stdout.write(`  ✓ [${id}] ${company}\n`);
      } else {
        fail++;
        process.stdout.write(`  ✗ [${id}] ${company} — HTTP ${r.status}\n`);
      }
    } catch (e) {
      fail++;
      process.stdout.write(`  ✗ [${id}] ${company} — ${e.message}\n`);
    }
  }

  console.log(`\nDone. ${ok} updated, ${fail} failed.`);
}

main().catch(err => { console.error(err); process.exit(1); });
