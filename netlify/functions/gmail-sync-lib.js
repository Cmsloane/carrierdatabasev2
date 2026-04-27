const DEFAULT_QUERY = 'newer_than:60d ("rate confirmation" OR "rate con" OR "carrier confirmation" OR "load tender") -in:trash -in:spam';
const DEFAULT_MAX_RESULTS = 100;
const DEFAULT_IGNORE_DOMAINS = ['circledelivers.com', 'circlelogistics.com'];

function nowIso() {
  return new Date().toISOString().slice(0, 19);
}

function normalizeList(value) {
  return String(value || '')
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function parseEmails(value) {
  const matches = String(value || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return [...new Set(matches.map(normalizeEmail))];
}

function parsePhones(value) {
  const matches = String(value || '').match(/(?:\+?1[\s.-]*)?(?:\(?\d{3}\)?[\s.-]*)\d{3}[\s.-]*\d{4}(?:\s*(?:x|ext\.?)\s*\d+)?/gi) || [];
  return [...new Set(matches.map((match) => match.replace(/\s+/g, ' ').trim()))];
}

function safeHeaderMap(payload) {
  const headers = payload?.payload?.headers || [];
  return headers.reduce((acc, header) => {
    const key = String(header?.name || '').toLowerCase();
    if (!key) return acc;
    acc[key] = header?.value || '';
    return acc;
  }, {});
}

function decodeBase64Url(value) {
  if (!value) return '';
  const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4 || 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function collectMessageText(part, bucket) {
  if (!part) return;
  const mimeType = String(part.mimeType || '').toLowerCase();
  const data = part.body?.data ? decodeBase64Url(part.body.data) : '';
  if (data) {
    if (mimeType === 'text/plain') bucket.plain.push(data);
    else if (mimeType === 'text/html') bucket.html.push(data);
  }
  (part.parts || []).forEach((child) => collectMessageText(child, bucket));
}

function extractMessageText(payload) {
  const bucket = { plain: [], html: [] };
  collectMessageText(payload?.payload, bucket);
  const plain = bucket.plain.join('\n').trim();
  if (plain) return plain;
  return stripHtml(bucket.html.join('\n'));
}

function cleanText(value) {
  return String(value || '')
    .replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function toIsoDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toISOString();
}

function fmtMoney(value) {
  if (value == null || Number.isNaN(Number(value))) return '';
  return '$' + Number(value).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function ensureGmailSource(sources) {
  const next = Array.isArray(sources) ? sources.slice() : [];
  const existing = next.find((entry) => String(entry?.type || '').toLowerCase() === 'gmail');
  if (existing) {
    if (!existing.label) existing.label = 'Gmail · Rate confirmations';
    return next;
  }
  next.push({ type: 'gmail', label: 'Gmail · Rate confirmations' });
  return next;
}

function gmailConfig(override = {}) {
  return {
    clientId: override.clientId || process.env.GMAIL_CLIENT_ID || '',
    clientSecret: override.clientSecret || process.env.GMAIL_CLIENT_SECRET || '',
    refreshToken: override.refreshToken || process.env.GMAIL_REFRESH_TOKEN || '',
    userEmail: override.userEmail || process.env.GMAIL_USER_EMAIL || 'me',
    query: process.env.GMAIL_SYNC_QUERY || DEFAULT_QUERY,
    labelIds: normalizeList(process.env.GMAIL_SYNC_LABEL_IDS || ''),
    maxResults: Math.max(1, Math.min(Number(process.env.GMAIL_SYNC_MAX_RESULTS || DEFAULT_MAX_RESULTS), 500)),
    ignoreDomains: [...new Set(DEFAULT_IGNORE_DOMAINS.concat(normalizeList(process.env.GMAIL_SYNC_IGNORE_DOMAINS || '')).map((value) => value.toLowerCase()))]
  };
}

export function gmailSyncConfigStatus() {
  const config = gmailConfig();
  const configured = Boolean(config.clientId && config.clientSecret && config.refreshToken);
  return {
    configured,
    userEmail: config.userEmail || 'me',
    query: config.query,
    labelIds: config.labelIds,
    maxResults: config.maxResults,
    ignoreDomains: config.ignoreDomains
  };
}

export function zapierSyncConfigStatus() {
  return {
    configured: Boolean(process.env.ZAPIER_SYNC_SECRET || process.env.GMAIL_SYNC_SECRET),
    endpointPath: '/api/zapier/rate-confirmation',
    secretHeader: 'x-zapier-secret'
  };
}

async function fetchAccessToken(config) {
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: config.refreshToken,
    grant_type: 'refresh_token'
  });
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail token refresh failed (${response.status}): ${text.slice(0, 240)}`);
  }
  const payload = await response.json();
  if (!payload.access_token) {
    throw new Error('Gmail token refresh did not return an access token.');
  }
  return payload.access_token;
}

async function gmailRequest(pathname, accessToken, params) {
  const url = new URL(`https://gmail.googleapis.com/gmail/v1/users/me/${pathname}`);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (Array.isArray(value)) {
      value.forEach((item) => url.searchParams.append(key, item));
      return;
    }
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  });
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json'
    }
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Gmail API request failed (${response.status}): ${text.slice(0, 240)}`);
  }
  return response.json();
}

function buildCarrierEmailIndex(carriers) {
  const emailToCarrierIndexes = new Map();
  (carriers || []).forEach((carrier, index) => {
    parseEmails(carrier?.email || '').forEach((email) => {
      if (!emailToCarrierIndexes.has(email)) emailToCarrierIndexes.set(email, []);
      emailToCarrierIndexes.get(email).push(index);
    });
  });
  return emailToCarrierIndexes;
}

function shouldIgnoreEmail(email, ignoreDomains) {
  const normalized = normalizeEmail(email);
  const domain = normalized.split('@')[1] || '';
  return !normalized || ignoreDomains.includes(domain);
}

function parseDisplayName(fromHeader) {
  const value = String(fromHeader || '').trim();
  if (!value) return '';
  const cleaned = value.replace(/<[^>]+>/g, '').replace(/["']/g, '').trim();
  if (!cleaned || /rate confirmation|dispatch|broker|logistics|team|support|operations/i.test(cleaned)) return '';
  return cleaned;
}

function extractLoadId(text) {
  const patterns = [
    /\bLoad(?:\s*(?:ID|#|Number|No\.?))?\s*[:#-]?\s*([A-Z0-9-]{5,})\b/i,
    /\bOrder(?:\s*(?:#|No\.?))?\s*[:#-]?\s*([A-Z0-9-]{5,})\b/i,
    /\bConfirmation(?:\s*(?:#|No\.?))?\s*[:#-]?\s*([A-Z0-9-]{5,})\b/i,
    /\b(2\d{6})\b/
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return '';
}

function extractMoney(text) {
  const lines = String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    if (!/\b(?:rate|all[\s-]?in|linehaul|line haul|agreed rate|amount due|total rate)\b/i.test(line)) continue;
    if (/rate confirmation/i.test(line) && !/\$/.test(line)) continue;
    const dollarMatch = line.match(/\$([\d,]+(?:\.\d{2})?)/);
    if (dollarMatch?.[1]) {
      const value = Number(String(dollarMatch[1]).replace(/,/g, ''));
      if (!Number.isNaN(value) && value > 0) return value;
    }
    if (/:\s*[\d,]+(?:\.\d{2})?\b/.test(line) && !/rate confirmation/i.test(line)) {
      const numberMatch = line.match(/:\s*([\d,]+(?:\.\d{2})?)\b/);
      if (numberMatch?.[1]) {
        const value = Number(String(numberMatch[1]).replace(/,/g, ''));
        if (!Number.isNaN(value) && value > 0) return value;
      }
    }
  }
  const fallback = text.match(/\$([\d,]+(?:\.\d{2})?)/);
  if (fallback?.[1]) {
    const value = Number(String(fallback[1]).replace(/,/g, ''));
    if (!Number.isNaN(value) && value > 0) return value;
  }
  return null;
}

function extractKeywordDate(text, label) {
  const pattern = new RegExp(`(?:${label})[^\\n\\r]{0,80}?(\\d{1,2}\\/\\d{1,2}\\/\\d{2,4}|[A-Z][a-z]{2,8}\\s+\\d{1,2},?\\s+\\d{4})`, 'i');
  const match = text.match(pattern);
  if (!match?.[1]) return '';
  const date = new Date(match[1]);
  if (Number.isNaN(date.getTime())) return match[1];
  return date.toISOString().slice(0, 10);
}

function extractKeywordLocation(text, label) {
  const pattern = new RegExp(`(?:${label})[\\s\\S]{0,120}?([A-Z][A-Za-z .'-]+,\\s*[A-Z]{2})`, 'i');
  const match = text.match(pattern);
  return match?.[1] ? match[1].trim() : '';
}

// Valid US state codes — used to reject false-positive city/state matches in email text
const US_STATES = new Set(['AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA','KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ','NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC','ON','BC','AB','QC','MB','SK']);

// Known noise words/phrases that appear before or instead of city names in emails
const CITY_NOISE_RE = /^(Location|Located|Location\s+of|Origin\s*:|Pickup\s*:|Delivery\s*:|Destination\s*:|Consignee\s*:|From\s*:|Shipper\s*:|Carrier\s+booked\s+on|booked\s+on|ated\s+outside\s+of|outside\s+of)\s+/gi;
const CITY_GARBAGE_WORDS = /\b(Location|Located|Carrier|Happyrobot|booked|outside|Transportation|Offer|Incorporated|Logistics|Trucking|Express|Freight|Services|Systems)\b/i;

/**
 * Validate and clean a raw "City, ST" string extracted from email text.
 * Returns "City, ST" on success, '' if it doesn't look like a real city/state.
 */
function cleanRouteCity(raw) {
  if (!raw) return '';
  let s = raw.trim();
  // Strip known label prefixes (loop in case multiple stack)
  for (let i = 0; i < 4; i++) {
    const prev = s;
    s = s.replace(CITY_NOISE_RE, '');
    if (s === prev) break;
  }
  // Must be "City words, ST" with a valid state code
  const m = s.match(/^([A-Z][A-Za-z\s.\-']{0,45}),\s*([A-Z]{2})\b/i);
  if (!m) return '';
  const state = m[2].toUpperCase();
  if (!US_STATES.has(state)) return '';           // invalid state code (e.g. "Ap" for April)
  const city = m[1].trim();
  if (city.split(/\s+/).length > 5) return '';    // too many words — probably a sentence
  if (CITY_GARBAGE_WORDS.test(city)) return '';   // contains company/label noise word
  // Normalize to "Title Case City, ST"
  const cleanCity = city.replace(/\b\w/g, ch => ch.toUpperCase());
  return `${cleanCity}, ${state}`;
}

function extractRoute(text) {
  // Try direct "City, ST [sep] City, ST" match — broadest pattern, then clean results
  const CS = '([A-Z][A-Za-z .\'\\-]+,\\s*[A-Z]{2})';
  const SEP = '\\s*(?:→|->|-->|\\bto\\b)\\s*';
  const direct = text.match(new RegExp(CS + SEP + CS, 'i'));
  if (direct?.[1] && direct?.[2]) {
    const pickup = cleanRouteCity(direct[1]);
    const delivery = cleanRouteCity(direct[2]);
    if (pickup && delivery) return { route: `${pickup} → ${delivery}`, pickup, delivery };
    if (pickup) return { route: pickup, pickup, delivery: '' };
  }
  // Keyword fallback: look near "pickup", "origin", "delivery", etc.
  const pickup = cleanRouteCity(extractKeywordLocation(text, 'pickup|origin'));
  const delivery = cleanRouteCity(extractKeywordLocation(text, 'delivery|destination|consignee'));
  if (pickup || delivery) {
    return {
      route: pickup && delivery ? `${pickup} → ${delivery}` : pickup || delivery,
      pickup,
      delivery
    };
  }
  return { route: '', pickup: '', delivery: '' };
}

function looksLikeRateConfirmation(subject, body) {
  const joined = `${subject}\n${body}`;
  const keyword = /\brate\s*conf(?:irmation)?\b|\bcarrier\s*confirmation\b|\bload\s*tender\b|\bdispatch\s*confirmation\b|\bbooking\s*confirmation\b/i.test(joined);
  const routeOrStops = /\bpickup\b/i.test(joined) && /\bdeliver(?:y)?\b/i.test(joined);
  const money = /\$[\d,]+(?:\.\d{2})?/.test(joined);
  return keyword && (routeOrStops || money);
}

function extractMcDot(text) {
  const mcM = text.match(/\bMC[-#\s]*(\d{5,8})\b/i);
  const dotM = text.match(/\bDOT[-#\s]*(\d{5,9})\b/i);
  return {
    mc:  mcM  ? `MC-${mcM[1]}`   : '',
    dot: dotM ? `DOT-${dotM[1]}` : ''
  };
}

function extractEquipment(text) {
  const EQ_TYPES = ['Dry Van', 'Reefer', 'Refrigerated', 'Flatbed', 'Power Only',
                    'Step Deck', 'Lowboy', 'Tanker', 'Conestoga', 'RGN', 'Van'];
  for (const t of EQ_TYPES) {
    if (new RegExp(`\\b${t.replace(/\s/g, '\\s+')}\\b`, 'i').test(text)) {
      return t === 'Refrigerated' ? 'Reefer' : t;
    }
  }
  return '';
}

function buildHistoryDate(pickupDate, deliveryDate, messageDateIso) {
  if (pickupDate && deliveryDate && pickupDate !== deliveryDate) return `${pickupDate} → ${deliveryDate}`;
  if (pickupDate) return pickupDate;
  if (deliveryDate) return deliveryDate;
  return messageDateIso ? messageDateIso.slice(0, 10) : '';
}

function buildParticipants(input, ignoreDomains) {
  return [
    ...parseEmails(input.from),
    ...parseEmails(input.to),
    ...parseEmails(input.cc),
    ...parseEmails(input.bcc),
    ...parseEmails(input.replyTo),
    ...parseEmails(input.deliveredTo),
    ...parseEmails(input.bodyText),
    ...parseEmails(input.snippet)
  ].filter((email, index, items) => items.indexOf(email) === index && !shouldIgnoreEmail(email, ignoreDomains));
}

function normalizeRateConfirmationEvent(input) {
  const subject = cleanText(input.subject || '');
  const bodyText = cleanText([
    input.bodyPlain || '',
    input.bodyText || '',
    input.bodyHtml ? stripHtml(input.bodyHtml) : '',
    input.snippet || ''
  ].filter(Boolean).join('\n'));
  const participants = buildParticipants({ ...input, subject, bodyText }, input.ignoreDomains || []);
  const parsed = extractRateConfirmation({
    subject,
    date: input.date || '',
    from: input.from || ''
  }, bodyText, participants);

  const route = input.route || '';
  const pickup = input.pickup || '';
  const delivery = input.delivery || '';
  const normalized = parsed || {
    loadId: '',
    route: route || (pickup && delivery ? `${pickup}→${delivery}` : pickup || delivery),
    pickupDate: '',
    deliveryDate: '',
    latestMessageAt: toIsoDate(input.date),
    rate: null,
    dispatcher: parseDisplayName(input.from),
    phones: [],
    matchedEmails: participants,
    customer: '',
    subject
  };

  normalized.loadId = input.loadId || normalized.loadId || '';
  normalized.route = route || normalized.route || (pickup && delivery ? `${pickup}→${delivery}` : pickup || delivery);
  normalized.pickupDate = input.pickupDate || normalized.pickupDate || '';
  normalized.deliveryDate = input.deliveryDate || normalized.deliveryDate || '';
  normalized.latestMessageAt = toIsoDate(input.date) || normalized.latestMessageAt || '';
  normalized.rate = input.rate != null && input.rate !== '' ? Number(input.rate) : normalized.rate;
  if (Number.isNaN(normalized.rate)) normalized.rate = null;
  normalized.dispatcher = input.dispatcher || normalized.dispatcher || '';
  normalized.phones = [...new Set([...(normalized.phones || []), ...parsePhones(bodyText), ...parsePhones(input.phone || '')])].slice(0, 3);
  normalized.matchedEmails = participants;
  normalized.customer = input.customer || normalized.customer || '';
  normalized.subject = subject || normalized.subject || '';

  const hasStructuredData = Boolean(
    normalized.loadId || normalized.route || normalized.rate != null || normalized.pickupDate || normalized.deliveryDate
  );
  if (!hasStructuredData && !looksLikeRateConfirmation(subject, bodyText)) return null;
  return normalized;
}

function extractRateConfirmation(headers, body, participants) {
  const subject = cleanText(headers.subject || '');
  const messageDateIso = toIsoDate(headers.date);
  const text = cleanText(`${subject}\n${body}`);
  if (!looksLikeRateConfirmation(subject, text)) return null;

  const route     = extractRoute(text);
  const pickupDate   = extractKeywordDate(text, 'pickup|origin');
  const deliveryDate = extractKeywordDate(text, 'delivery|destination|consignee');
  const rate      = extractMoney(text);
  const dispatcher   = parseDisplayName(headers.from);
  const phones    = parsePhones(text).slice(0, 3);
  const customerMatch = text.match(/\b(?:customer|shipper|bill\s*to)\b[^\n:]{0,15}[:\-]?\s*([^\n]{3,100})/i);
  const { mc, dot }  = extractMcDot(text);
  const equipment    = extractEquipment(text);

  return {
    loadId:   extractLoadId(text),
    route:    route.route,
    pickup:   route.pickup,
    delivery: route.delivery,
    pickupDate,
    deliveryDate,
    latestMessageAt: messageDateIso,
    rate,
    dispatcher,
    phones,
    matchedEmails: participants,
    customer: customerMatch?.[1] ? customerMatch[1].trim() : '',
    subject,
    mc,
    dot,
    equipment
  };
}

function appendUnique(list, values, limit) {
  const next = Array.isArray(list) ? list.slice() : [];
  values.forEach((value) => {
    if (!value || next.includes(value)) return;
    next.unshift(value);
  });
  return typeof limit === 'number' ? next.slice(0, limit) : next;
}

function createAggregate() {
  return {
    messageCount: 0,
    rateConfirmationCount: 0,
    matchedEmails: new Set(),
    recentSubjects: [],
    latestMessageAt: '',
    phones: new Set(),
    dispatchers: new Set(),
    routes: new Map(),
    loadHistory: new Map(),
    rates: [],
    mc: '',
    dot: '',
    equipment: ''
  };
}

function mergeLoadHistory(existingHistory, aggregate) {
  const history = Array.isArray(existingHistory) ? existingHistory.map((entry) => ({ ...entry })) : [];
  const indexByLoadId = new Map();
  history.forEach((entry, index) => {
    const key = String(entry?.load_id || '').trim();
    if (key) indexByLoadId.set(key, index);
  });

  aggregate.loadHistory.forEach((entry, key) => {
    const nextEntry = {
      load_id: key || entry.load_id || '',
      route: entry.route || '',
      date: buildHistoryDate(entry.pickupDate, entry.deliveryDate, entry.latestMessageAt),
      status: 'Completed',
      notes: [
        entry.customer ? `Customer ${entry.customer}` : '',
        entry.rate != null ? `Rate ${fmtMoney(entry.rate)}` : ''
      ].filter(Boolean).join(' · '),
      rate: entry.rate,
      pickup_date: entry.pickupDate || '',
      delivery_date: entry.deliveryDate || '',
      source: 'gmail-rate-confirmation',
      synced_at: nowIso()
    };

    if (indexByLoadId.has(key)) {
      history[indexByLoadId.get(key)] = {
        ...history[indexByLoadId.get(key)],
        ...nextEntry
      };
      return;
    }
    history.unshift(nextEntry);
  });

  return history.slice(0, 30);
}

function summarizeCarrier(carrier, aggregate, syncMeta) {
  const loadHistory = mergeLoadHistory(carrier?.loadHistory, aggregate);
  const completedLoads = loadHistory.filter((entry) => String(entry?.status || '').toLowerCase() === 'completed').length;
  const rates = aggregate.rates.length ? aggregate.rates : loadHistory.map((entry) => Number(entry?.rate)).filter((value) => !Number.isNaN(value) && value > 0);
  const avgRate = rates.length
    ? `Avg RC ${fmtMoney(rates.reduce((sum, value) => sum + value, 0) / rates.length)} (${rates.length} loads)`
    : carrier?.avgRate || '';
  const preferredLanes = [...aggregate.routes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([route]) => route)
    .join(' · ') || carrier?.preferredLanes || '';
  const latestMessageAt = aggregate.latestMessageAt || carrier?.gmailSync?.latestMessageAt || '';
  const carrierEmails = parseEmails(carrier?.email || '');
  const mergedEmails = appendUnique(carrierEmails, [...aggregate.matchedEmails].sort());

  // Only apply email-detected values when the existing field is blank/unknown
  const existingMc  = String(carrier?.mc  || '').trim();
  const existingDot = String(carrier?.dot || '').trim();
  const existingEquip = String(carrier?.equipment || '').trim();
  const blankMc   = !existingMc  || existingMc  === '' || existingMc  === 'MC-';
  const blankDot  = !existingDot || existingDot === '' || existingDot === 'DOT-';
  const blankEquip = !existingEquip || existingEquip === 'Unknown';

  return {
    ...carrier,
    email:     mergedEmails.join(' / '),
    phone:     carrier?.phone     || [...aggregate.phones].join(' / '),
    dispatcher: carrier?.dispatcher || [...aggregate.dispatchers][0] || '',
    mc:        blankMc   && aggregate.mc        ? aggregate.mc        : carrier?.mc        || '',
    dot:       blankDot  && aggregate.dot       ? aggregate.dot       : carrier?.dot       || '',
    equipment: blankEquip && aggregate.equipment ? aggregate.equipment : carrier?.equipment || '',
    lastActive: latestMessageAt ? latestMessageAt.slice(0, 10) : carrier?.lastActive || '',
    preferredLanes,
    avgRate,
    loadsCompleted: Math.max(Number(carrier?.loadsCompleted || 0), completedLoads),
    loadHistory,
    sources: ensureGmailSource(carrier?.sources),
    gmailSync: {
      messageCount: aggregate.messageCount,
      rateConfirmationCount: aggregate.rateConfirmationCount,
      matchedEmails: [...aggregate.matchedEmails].sort(),
      recentSubjects: aggregate.recentSubjects.slice(0, 5),
      latestMessageAt,
      syncedAt: syncMeta.syncedAt,
      query: syncMeta.query,
      labelIds: syncMeta.labelIds
    }
  };
}

export function applyRateConfirmationEvents(carriers, events, options) {
  const ignoreDomains = (options?.ignoreDomains || DEFAULT_IGNORE_DOMAINS).map((value) => value.toLowerCase());
  const carrierEmailIndex = buildCarrierEmailIndex(carriers || []);
  const aggregates = new Map();
  let matchedMessages = 0;
  let rateConfirmationMessages = 0;

  const unmatchedEvents = []; // RC events where no existing carrier email matched

  (events || []).forEach((event) => {
    const extracted = normalizeRateConfirmationEvent({ ...(event || {}), ignoreDomains });
    if (!extracted) return;
    const participants = extracted.matchedEmails || [];
    const carrierIndexes = new Set();
    participants.forEach((email) => {
      (carrierEmailIndex.get(email) || []).forEach((index) => carrierIndexes.add(index));
    });
    if (!carrierIndexes.size) {
      // No existing carrier matched — save for new-carrier discovery
      unmatchedEvents.push({ ...(event || {}), _extracted: extracted });
      return;
    }

    matchedMessages += 1;
    rateConfirmationMessages += 1;
    carrierIndexes.forEach((index) => {
      const aggregate = aggregates.get(index) || createAggregate();
      aggregate.messageCount += 1;
      aggregate.rateConfirmationCount += 1;
      participants.forEach((email) => aggregate.matchedEmails.add(email));
      extracted.phones.forEach((phone) => aggregate.phones.add(phone));
      if (extracted.dispatcher) aggregate.dispatchers.add(extracted.dispatcher);
      if (extracted.subject) aggregate.recentSubjects = appendUnique(aggregate.recentSubjects, [extracted.subject], 5);
      if (extracted.latestMessageAt && (!aggregate.latestMessageAt || extracted.latestMessageAt > aggregate.latestMessageAt)) {
        aggregate.latestMessageAt = extracted.latestMessageAt;
      }
      if (extracted.route) {
        aggregate.routes.set(extracted.route, (aggregate.routes.get(extracted.route) || 0) + 1);
      }
      if (extracted.rate != null) aggregate.rates.push(extracted.rate);
      if (extracted.mc  && !aggregate.mc)  aggregate.mc  = extracted.mc;
      if (extracted.dot && !aggregate.dot) aggregate.dot = extracted.dot;
      if (extracted.equipment && !aggregate.equipment) aggregate.equipment = extracted.equipment;
      if (extracted.loadId || extracted.route) {
        const key = extracted.loadId || `${extracted.route}|${extracted.pickupDate}|${extracted.deliveryDate}`;
        const existing = aggregate.loadHistory.get(key) || {};
        aggregate.loadHistory.set(key, {
          ...existing,
          ...extracted
        });
      }
      aggregates.set(index, aggregate);
    });
  });

  const syncMeta = {
    syncedAt: nowIso(),
    query: options?.query || '',
    labelIds: options?.labelIds || [],
    userEmail: options?.userEmail || '',
    scannedMessages: (events || []).length,
    matchedMessages,
    rateConfirmationMessages,
    matchedCarriers: aggregates.size
  };

  const nextCarriers = (carriers || []).map((carrier, index) => {
    const aggregate = aggregates.get(index);
    if (!aggregate) return carrier;
    return summarizeCarrier(carrier, aggregate, syncMeta);
  });

  return {
    carriers: nextCarriers,
    gmailSync: syncMeta,
    unmatched: unmatchedEvents
  };
}

// ── New-carrier discovery: unmatched rate-con events ─────────────────────────
// Creates minimal carrier records from RC emails where no existing carrier
// email matched. Groups by external email address; derives company name from
// the From: display name or the email domain.
function createCarriersFromUnmatched(unmatchedEvents, existingCarriers, ignoreDomains) {
  const ignDomains = (ignoreDomains || DEFAULT_IGNORE_DOMAINS).map(d => d.toLowerCase());
  const existingNames  = new Set((existingCarriers || []).map(c => (c.company || '').toLowerCase().trim()));
  const existingEmails = new Set((existingCarriers || []).flatMap(c => parseEmails(c.email || '')));
  let maxId = Math.max(100, ...(existingCarriers || []).map(c => Number(c.id) || 0));

  // Group events by the first external participant email (the carrier's email)
  const emailToData = new Map(); // email → { dispatcher, phones, routes, dates, rates, mc, dot, equipment, loadItems, subjects, fromName }

  for (const event of (unmatchedEvents || [])) {
    const extracted = event._extracted || normalizeRateConfirmationEvent({ ...event, ignoreDomains: ignDomains });
    if (!extracted) continue;

    const externalParticipants = (extracted.matchedEmails || [])
      .filter(e => !shouldIgnoreEmail(e, ignDomains) && !existingEmails.has(e));
    if (!externalParticipants.length) continue;

    const repEmail = externalParticipants[0];
    const existing = emailToData.get(repEmail) || {
      dispatcher: '', phones: new Set(), routes: new Map(),
      latestDate: '', rates: [], mc: '', dot: '', equipment: '',
      loadItems: [], subjects: [], fromName: ''
    };

    if (extracted.dispatcher && !existing.dispatcher) existing.dispatcher = extracted.dispatcher;
    // Try display name from From: header
    if (!existing.fromName && event.from) existing.fromName = parseDisplayName(event.from);
    (extracted.phones || []).forEach(p => existing.phones.add(p));
    if (extracted.route) existing.routes.set(extracted.route, (existing.routes.get(extracted.route) || 0) + 1);
    if (extracted.latestMessageAt && (!existing.latestDate || extracted.latestMessageAt > existing.latestDate)) {
      existing.latestDate = extracted.latestMessageAt;
    }
    if (extracted.rate != null) existing.rates.push(extracted.rate);
    if (extracted.mc  && !existing.mc)  existing.mc  = extracted.mc;
    if (extracted.dot && !existing.dot) existing.dot = extracted.dot;
    if (extracted.equipment && !existing.equipment) existing.equipment = extracted.equipment;
    if (extracted.subject) existing.subjects.push(extracted.subject.slice(0, 80));
    if (extracted.loadId || extracted.route) {
      existing.loadItems.push({
        load:         extracted.loadId || '',
        date:         extracted.pickupDate || (extracted.latestMessageAt ? extracted.latestMessageAt.slice(0, 10) : ''),
        origin:       extracted.pickup || '',
        dest:         extracted.delivery || '',
        customer:     extracted.customer || '',
        pickupWindow: '',
        deliveryDate: extracted.deliveryDate || '',
        deliveryWindow: '',
        refNumber:    '',
        status:       'Completed'
      });
    }
    emailToData.set(repEmail, existing);
  }

  const newCarriers = [];
  for (const [repEmail, data] of emailToData) {
    // Build company name: prefer dispatcher / display name, fall back to domain
    let company = data.fromName || data.dispatcher || '';
    if (!company) {
      const domain = repEmail.split('@')[1] || '';
      company = domain
        .replace(/\.(com|net|org|io|us|biz|co)$/, '')
        .replace(/[-_.]/g, ' ')
        .replace(/\b\w/g, ch => ch.toUpperCase());
    }
    const nameLower = company.toLowerCase().trim();
    if (!nameLower || existingNames.has(nameLower)) continue;

    const bestRoute = [...data.routes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
    const avgRateVal = data.rates.length
      ? data.rates.reduce((s, v) => s + v, 0) / data.rates.length
      : null;
    const noteSubjects = data.subjects.slice(0, 2).join(' · ');

    maxId++;
    newCarriers.push({
      id:             maxId,
      company,
      mc:             data.mc || '',
      dot:            data.dot || '',
      equipment:      data.equipment || 'Dry Van',
      hazmat:         'No',
      safetyRating:   'Not Rated',
      dispatcher:     data.dispatcher || '',
      phone:          [...data.phones][0] || '',
      afterHours:     '',
      email:          repEmail,
      preferredLanes: bestRoute,
      homeBase:       '',
      address:        '',
      avgRate:        avgRateVal != null ? `$${avgRateVal.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : 0,
      insurance:      '',
      loadsCompleted: data.loadItems.length,
      otPickup:       0,
      otDelivery:     0,
      claims:         0,
      status:         'Active',
      score:          50,
      region:         '',
      lastActive:     data.latestDate ? data.latestDate.slice(0, 10) : '',
      notes:          `Discovered via rate-con email sync.${noteSubjects ? ' ' + noteSubjects : ''}`,
      issueFlag:      false,
      loadHistory:    data.loadItems.slice(0, 10),
      sources:        [{ type: 'gmail', label: 'Gmail \u00b7 Rate-Con Discovery' }]
    });
    existingNames.add(nameLower);
    existingEmails.add(repEmail);
  }

  return newCarriers;
}

export async function syncCarriersFromGmail(carriers, credentials = null, options = {}) {
  const config = gmailConfig(credentials || {});
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new Error('Gmail sync is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN.');
  }

  const accessToken = await fetchAccessToken(config);
  const events = [];

  // Caller-controlled time window + max results (defaults preserve previous behavior).
  const daysBack = Math.max(1, Math.min(Number(options.daysBack || 90), 730));
  const inboxMax = Math.max(10, Math.min(Number(options.inboxMax  || 100), 500));
  const sentMax  = Math.max(10, Math.min(Number(options.sentMax   || 80),  500));
  // fullFetchCap: how many candidate messages to actually fetch full body for.
  // Bumping this captures more carrier data but eats into the 10s budget.
  const fullFetchCap = Math.max(5, Math.min(Number(options.fullFetchCap || 40), 200));

  // Broader subject phrasing — catches the long tail of carrier confirmations
  // we previously missed (dispatch sheet, freight conf, carrier packet, trip sheet).
  const INBOX_QUERY = `newer_than:${daysBack}d ("rate confirmation" OR "rate con" OR "carrier confirmation" OR "load tender" OR "booking confirmation" OR "dispatch confirmation" OR "load confirmation" OR "carrier agreement" OR "dispatch sheet" OR "carrier packet" OR "freight confirmation" OR "trip sheet" OR "load assignment") -in:trash -in:spam`;
  const SENT_QUERY  = `in:sent newer_than:${daysBack}d ("rate confirmation" OR "rate con" OR "booking confirmation" OR "carrier" OR "load confirmation" OR "dispatch confirmation" OR "trip sheet" OR "carrier packet") -in:trash`;

  const [inboxList, sentList] = await Promise.all([
    gmailRequest('messages', accessToken, { q: INBOX_QUERY, maxResults: inboxMax }),
    gmailRequest('messages', accessToken, { q: SENT_QUERY,  maxResults: sentMax  })
  ]);

  // Deduplicate by message ID
  const seen = new Set();
  const allMessages = [];
  for (const m of [...(inboxList?.messages || []), ...(sentList?.messages || [])]) {
    if (m?.id && !seen.has(m.id)) { seen.add(m.id); allMessages.push(m); }
  }

  // Phase 1: metadata-only fetch to pre-filter by subject / snippet.
  // Broader RC_RE catches more carrier emails including load confirmation variants.
  const RC_RE = /rate\s*conf(?:irmation)?|carrier\s*conf|load\s*tender|dispatch\s*conf|booking\s*conf|load\s*confirm|carrier\s*agree|load\s*#\s*\d{4,}|book\s*now|freight\s*conf|dispatch\s*sheet|carrier\s*packet|trip\s*sheet|load\s*assign|setup\s*packet/i;
  const META_BATCH = 15;
  const candidateIds = [];

  for (let i = 0; i < allMessages.length; i += META_BATCH) {
    const slice = allMessages.slice(i, i + META_BATCH);
    const metas = await Promise.all(slice.map(m =>
      gmailRequest(`messages/${encodeURIComponent(m.id)}`, accessToken, {
        format: 'metadata',
        metadataHeaders: ['Subject', 'From', 'To', 'Date']
      }).catch(() => null)
    ));
    for (const meta of metas) {
      if (!meta?.id) continue;
      const h = safeHeaderMap(meta);
      if (RC_RE.test(h.subject || '') || RC_RE.test(meta.snippet || '')) {
        candidateIds.push(meta.id);
      }
    }
  }

  // Phase 2: full-content fetch for confirmed candidates (configurable cap)
  for (const msgId of candidateIds.slice(0, fullFetchCap)) {
    try {
      const payload = await gmailRequest(`messages/${encodeURIComponent(msgId)}`, accessToken, { format: 'full' });
      const headers = safeHeaderMap(payload);
      const body    = extractMessageText(payload);
      events.push({
        subject:     headers.subject          || '',
        from:        headers.from             || '',
        to:          headers.to               || '',
        cc:          headers.cc               || '',
        bcc:         headers.bcc              || '',
        replyTo:     headers['reply-to']      || '',
        deliveredTo: headers['delivered-to']  || '',
        date:        headers.date             || '',
        bodyPlain:   body,
        snippet:     payload?.snippet         || ''
      });
    } catch (_) { /* skip individual fetch errors */ }
  }

  const rcResult = applyRateConfirmationEvents(carriers, events, {
    query: INBOX_QUERY,
    labelIds: config.labelIds,
    userEmail: config.userEmail || 'me',
    ignoreDomains: config.ignoreDomains
  });

  // Create new carrier records from any unmatched RC events (emails with RC signals
  // but no existing carrier email match — these are carriers not yet in the DB).
  const rawDiscovered = createCarriersFromUnmatched(
    rcResult.unmatched || [],
    rcResult.carriers,
    config.ignoreDomains
  );

  // Enrich each discovered carrier with thread history (MC/DOT, phones, lanes, rates).
  // Cap at 8 new carriers per sync to respect Netlify timeout budget.
  const toEnrich = rawDiscovered.slice(0, 8);
  const enrichedDiscovered = toEnrich.length
    ? await Promise.all(toEnrich.map(c => enrichNewCarrierFromThreads(c, accessToken).catch(() => c)))
    : [];

  return {
    carriers:    [...rcResult.carriers, ...enrichedDiscovered],
    gmailSync:   rcResult.gmailSync,
    newCarriers: enrichedDiscovered
  };
}

// ── Book Now Dispatch email parser ────────────────────────────────────────────
// Parses the structured HTML body of "Book Now Dispatch for Load #XXXXXXX" emails
// sent by noreply@circledelivers.com directly to the dispatcher.
function parseBookNowEmail(rawBody) {
  const text = stripHtml(rawBody || '');

  function field(label) {
    const m = text.match(new RegExp(`^${label}[:\\s]+(.+)$`, 'im'));
    return m ? m[1].trim() : '';
  }

  const company   = field('Carrier');
  const dispatcher = field('Dispatcher');
  const phone     = field('Phone\\s*#?');
  const email     = field('Email');
  const loadId    = field('Load\\s*#?');
  const customer  = field('Customer');

  // Pickup: City, ST - MM/DD/YYYY from HH:MM - HH:MM  OR  at HH:MM
  const puM = text.match(/^Pickup:\s*([^,\n]+),\s*([A-Z]{2})\s*-\s*(\d{2}\/\d{2}\/\d{4})\s*(?:from\s*([\d:]+)\s*[-\u2013]\s*([\d:]+)|at\s*([\d:]+))/im);
  const deM = text.match(/^Delivery:\s*([^,\n]+),\s*([A-Z]{2})\s*-\s*(\d{2}\/\d{2}\/\d{4})\s*(?:from\s*([\d:]+)\s*[-\u2013]\s*([\d:]+)|at\s*([\d:]+))/im);

  function mmddToIso(s) {
    if (!s) return '';
    const [m, d, y] = s.split('/');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  if (!company && !dispatcher) return null;

  return {
    company,
    dispatcher,
    phone,
    email,
    loadId,
    customer,
    origin:        puM ? `${puM[1].trim()}, ${puM[2]}` : '',
    pickupDate:    puM ? mmddToIso(puM[3]) : '',
    pickupWindow:  puM ? (puM[4] ? `${puM[4]}\u2013${puM[5]}` : puM[6] || '') : '',
    dest:          deM ? `${deM[1].trim()}, ${deM[2]}` : '',
    deliveryDate:  deM ? mmddToIso(deM[3]) : '',
    deliveryWindow: deM ? (deM[4] ? `${deM[4]}\u2013${deM[5]}` : deM[6] || '') : ''
  };
}

// Searches Gmail for Book Now Dispatch emails sent directly to the authenticated user,
// creates new carrier records for any carrier not already in the database.
export async function syncNewCarriersFromBookNow(carriers, options = {}) {
  const config = gmailConfig(options.credentials || {});
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new Error('Gmail OAuth is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN in Netlify environment variables.');
  }

  const accessToken = await fetchAccessToken(config);
  const daysBack = Math.max(1, Math.min(Number(options.daysBack || 30), 730));
  const maxResults = Math.max(10, Math.min(Number(options.maxResults || 50), 500));
  // fullFetchCap: how many message bodies to fetch+parse (each ~100ms sequential).
  // Cap stays under Netlify 10s budget. Override via options.fullFetchCap.
  const fullFetchCap = Math.max(5, Math.min(Number(options.fullFetchCap || maxResults), 200));
  // to:me + exact subject phrase targets only emails sent directly to the authenticated
  // user — not forwarded copies in other labels. Emails Conrad books are addressed to him
  // directly from noreply@circledelivers.com; forwarded FW Carrier Sales copies have
  // "FW:" in the subject and won't match "Book Now Dispatch for Load" exactly.
  const query = `from:noreply@circledelivers.com "Book Now Dispatch for Load" to:me newer_than:${daysBack}d`;

  const messageList = await gmailRequest('messages', accessToken, { q: query, maxResults });
  const messages = Array.isArray(messageList?.messages) ? messageList.messages : [];

  // Build lookup sets for existing carriers
  const existingNames  = new Set((carriers || []).map(c => (c.company || '').toLowerCase().trim()));
  const existingEmails = new Set((carriers || []).flatMap(c => parseEmails(c.email || '')));
  let maxId = Math.max(100, ...(carriers || []).map(c => Number(c.id) || 0));

  const newCarriers = [];
  const skipped     = [];

  // Parallel batched fetch — much faster than the prior serial loop, which hit
  // 30s+ for large windows. Process in batches of 10 to avoid rate-limit spikes.
  const toFetch = messages.slice(0, fullFetchCap).filter(m => m?.id);
  const FETCH_BATCH = 10;
  const fetched = [];
  for (let i = 0; i < toFetch.length; i += FETCH_BATCH) {
    const slice = toFetch.slice(i, i + FETCH_BATCH);
    const results = await Promise.all(slice.map(m =>
      gmailRequest(`messages/${encodeURIComponent(m.id)}`, accessToken, { format: 'full' }).catch(() => null)
    ));
    fetched.push(...results.filter(Boolean));
  }

  for (const payload of fetched) {
    if (!payload) continue;
    const body    = extractMessageText(payload);
    const parsed  = parseBookNowEmail(body);
    if (!parsed) continue;

    const nameLower   = (parsed.company || '').toLowerCase().trim();
    const carrierEmails = parseEmails(parsed.email || '');
    const alreadyExists = existingNames.has(nameLower) || carrierEmails.some(e => existingEmails.has(e));

    if (alreadyExists) {
      skipped.push(parsed.company);
      continue;
    }
    if (!nameLower) continue;

    maxId++;
    const carrier = {
      id:             maxId,
      company:        parsed.company,
      mc:             '',
      dot:            '',
      equipment:      'Dry Van',
      hazmat:         'No',
      safetyRating:   'Not Rated',
      dispatcher:     parsed.dispatcher,
      phone:          parsed.phone,
      afterHours:     '',
      email:          parsed.email,
      preferredLanes: parsed.origin && parsed.dest ? `${parsed.origin} \u2192 ${parsed.dest}` : '',
      homeBase:       '',
      address:        '',
      avgRate:        0,
      insurance:      '',
      loadsCompleted: 0,
      otPickup:       0,
      otDelivery:     0,
      claims:         0,
      status:         'Active',
      score:          50,
      region:         '',
      lastActive:     parsed.pickupDate || nowIso().slice(0, 10),
      notes:          parsed.loadId
        ? `Load #${parsed.loadId}: ${parsed.origin} \u2192 ${parsed.dest}, ${parsed.pickupDate}, customer: ${parsed.customer}`
        : '',
      issueFlag:      false,
      loadHistory:    parsed.loadId ? [{
        load:           parsed.loadId,
        date:           parsed.pickupDate,
        origin:         parsed.origin,
        dest:           parsed.dest,
        pickupWindow:   parsed.pickupWindow,
        deliveryDate:   parsed.deliveryDate,
        deliveryWindow: parsed.deliveryWindow,
        customer:       parsed.customer,
        refNumber:      '',
        status:         'Completed'
      }] : [],
      sources: [{ type: 'gmail', label: 'Gmail \u00b7 Book Now Dispatch' }]
    };

    newCarriers.push(carrier);
    existingNames.add(nameLower);
    carrierEmails.forEach(e => existingEmails.add(e));
  }

  // Cross-reference each new carrier's email against sent + inbox threads to
  // pull in MC/DOT, equipment, phones, rates, lanes, and prior contact history.
  // Run all lookups in parallel — one Gmail search + up to 5 full fetches per carrier.
  const enrichedCarriers = newCarriers.length
    ? await Promise.all(newCarriers.map(c => enrichNewCarrierFromThreads(c, accessToken).catch(() => c)))
    : [];

  return { newCarriers: enrichedCarriers, skipped, messagesScanned: messages.length };
}

// ── Thread enrichment for newly-discovered carriers ───────────────────────────
// When a new carrier is found via a Book Now email, this function checks whether
// we already have email history with them (sent or received) and extracts any
// additional data — MC/DOT, equipment, phones, rates, lanes, contact dates.
// Called once per new carrier; runs in parallel across all new carriers.
async function enrichNewCarrierFromThreads(carrier, accessToken) {
  const carrierEmails = parseEmails(carrier.email || '');
  if (!carrierEmails.length) return carrier;

  // Build a query that matches emails where the carrier is sender OR recipient.
  // Gmail's {X Y} syntax means "X OR Y" inside a grouped term.
  const emailParts = carrierEmails.map(e => `{from:${e} to:${e}}`).join(' ');
  const query = `(${emailParts}) newer_than:365d -in:trash -in:spam`;

  let messageList;
  try {
    messageList = await gmailRequest('messages', accessToken, { q: query, maxResults: 8 });
  } catch (_) { return carrier; }

  const msgIds = (messageList?.messages || []).map(m => m.id).filter(Boolean);
  if (!msgIds.length) return carrier;

  // Fetch up to 5 messages in parallel (full format to get body + headers)
  const payloads = await Promise.all(
    msgIds.slice(0, 5).map(id =>
      gmailRequest(`messages/${encodeURIComponent(id)}`, accessToken, { format: 'full' })
        .catch(() => null)
    )
  );

  const enriched = { ...carrier };
  let mostRecentDate = '';
  const contactLogEntries = [];
  const textChunks = [];

  for (const payload of payloads) {
    if (!payload) continue;
    const headers = safeHeaderMap(payload);
    const body    = extractMessageText(payload);
    const dateStr = headers.date || '';
    const ts      = dateStr ? new Date(dateStr) : null;
    const dateIso = ts && !isNaN(ts) ? ts.toISOString().slice(0, 10) : '';
    const subject = (headers.subject || '').slice(0, 120);

    textChunks.push(`${subject}\n${body}`);

    if (dateIso && (!mostRecentDate || dateIso > mostRecentDate)) {
      mostRecentDate = dateIso;
    }

    // Determine direction: did the carrier send it, or did we?
    const fromEmails   = parseEmails(headers.from || '');
    const isFromCarrier = fromEmails.some(e => carrierEmails.includes(e));
    const direction    = isFromCarrier ? 'Reply from carrier' : 'Outreach';
    const noteText     = subject ? `${direction}: "${subject}"` : direction;

    if (dateIso) {
      contactLogEntries.push({ date: dateIso, type: 'Email', notes: noteText, auto: true });
    }
  }

  const combinedText = textChunks.join('\n\n');

  // Extract structured data from all thread text combined
  const { mc, dot } = extractMcDot(combinedText);
  const equipment   = extractEquipment(combinedText);
  const phones      = parsePhones(combinedText);
  const route       = extractRoute(combinedText);
  const rate        = extractMoney(combinedText);

  // Fill in blank fields — never overwrite data that came from the Book Now email
  if (!enriched.mc  && mc)  enriched.mc  = mc;
  if (!enriched.dot && dot) enriched.dot = dot;
  // Override the default 'Dry Van' assumption only when we find something more specific
  if (equipment && equipment !== 'Dry Van' && (!enriched.equipment || enriched.equipment === 'Dry Van')) {
    enriched.equipment = equipment;
  }
  // Add phone from thread if Book Now didn't provide one
  if (!enriched.phone && phones.length) enriched.phone = phones[0];
  // Fill preferred lanes if Book Now route was empty or we found a richer one
  if (route.route && !enriched.preferredLanes) enriched.preferredLanes = route.route;
  // Set avg rate if found
  if (rate && !enriched.avgRate) enriched.avgRate = `$${rate.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

  // Set lastContactedDate from most recent thread
  if (mostRecentDate) enriched.lastContactedDate = mostRecentDate;

  // Merge contact log entries (dedup by date+type, sort newest first)
  if (contactLogEntries.length) {
    const existing = Array.isArray(enriched.contactLog) ? enriched.contactLog : [];
    const merged   = [...existing];
    for (const entry of contactLogEntries) {
      if (!merged.some(e => e.date === entry.date && e.type === entry.type)) {
        merged.push(entry);
      }
    }
    merged.sort((a, b) => b.date.localeCompare(a.date));
    enriched.contactLog = merged;
  }

  // Append a note about the prior thread history
  if (msgIds.length > 0) {
    const threadNote = `${msgIds.length} prior email thread${msgIds.length !== 1 ? 's' : ''} found`;
    enriched.notes = [enriched.notes, threadNote].filter(Boolean).join(' · ');
  }

  return enriched;
}

// ── Sent-mail carrier discovery ───────────────────────────────────────────────
// Scans ALL sent mail for the past 90 days (metadata-only first pass).
// For each sent message with a load-related subject that was addressed to an
// external email address not already in the carrier DB, creates a new carrier
// record and enriches it from thread history.
//
// This catches carriers that were booked outside the formal Book Now / rate-con
// workflow (direct email bookings, follow-up threads, etc.).
export async function syncNewCarriersFromSentMail(carriers, options = {}) {
  const config = gmailConfig(options.credentials || {});
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new Error('Gmail OAuth not configured.');
  }
  const accessToken = await fetchAccessToken(config);
  const daysBack = Math.max(1, Math.min(Number(options.daysBack || 90), 730));
  const maxResults = Math.max(10, Math.min(Number(options.maxResults || 60), 500));

  // Narrow query to load-related sent mail only.
  const SENT_QUERY = `in:sent newer_than:${daysBack}d ("load" OR "carrier" OR "booking" OR "dispatch" OR "rate" OR "trip sheet" OR "freight") -in:trash -in:spam`;
  const sentList = await gmailRequest('messages', accessToken, { q: SENT_QUERY, maxResults });
  const msgIds = (sentList?.messages || []).map(m => m.id).filter(Boolean);
  if (!msgIds.length) return { newCarriers: [], scanned: 0 };

  // Build lookup sets for existing carriers
  const existingNames  = new Set((carriers || []).map(c => (c.company || '').toLowerCase().trim()));
  const existingEmails = new Set((carriers || []).flatMap(c => parseEmails(c.email || '')));
  let maxId = Math.max(100, ...(carriers || []).map(c => Number(c.id) || 0));

  // Subject filter: must look like it's about a specific load or carrier booking
  const LOAD_SUBJECT_RE = /load\s*#?\s*\d{4,}|book\s*now|carrier\s*confirm|rate\s*conf|dispatch\s*conf|booking\s*conf|load\s*confirm|load\s*tender|freight\s*conf/i;

  // Phase 1: metadata scan — find To: addresses in load-related sent emails
  const META_BATCH = 30;
  const candidatesByEmail = new Map(); // email → { latestDate, subject, msgId }

  for (let i = 0; i < msgIds.length; i += META_BATCH) {
    const slice = msgIds.slice(i, i + META_BATCH);
    await Promise.all(slice.map(async (id) => {
      try {
        const msg = await gmailRequest(`messages/${encodeURIComponent(id)}`, accessToken, {
          format: 'metadata',
          metadataHeaders: ['To', 'Cc', 'Subject', 'Date']
        });
        const h = safeHeaderMap(msg);
        const subject = h.subject || msg?.snippet || '';
        if (!LOAD_SUBJECT_RE.test(subject)) return; // skip unrelated sent emails

        const ts = h.date ? new Date(h.date) : null;
        const dateIso = ts && !isNaN(ts) ? ts.toISOString().slice(0, 10) : '';

        const toEmails = [...parseEmails(h.to || ''), ...parseEmails(h.cc || '')];
        for (const email of toEmails) {
          if (shouldIgnoreEmail(email, config.ignoreDomains)) continue;
          if (existingEmails.has(email)) continue;

          const prev = candidatesByEmail.get(email);
          if (!prev || (dateIso && dateIso > prev.latestDate)) {
            candidatesByEmail.set(email, { latestDate: dateIso, subject: subject.slice(0, 120), msgId: id });
          }
        }
      } catch (_) { /* skip */ }
    }));
  }

  if (!candidatesByEmail.size) return { newCarriers: [], scanned: msgIds.length };

  // Phase 2: full fetch for each candidate's best message to extract carrier details.
  // Cap at 5 new carriers per sync to stay well within Netlify timeout.
  const newCarriers = [];
  for (const [email, candidate] of [...candidatesByEmail.entries()].slice(0, 5)) {
    try {
      const payload = await gmailRequest(`messages/${encodeURIComponent(candidate.msgId)}`, accessToken, { format: 'full' });
      const headers = safeHeaderMap(payload);
      const body    = extractMessageText(payload);
      const combined = `${headers.subject || ''}\n${body}`;

      const { mc, dot } = extractMcDot(combined);
      const equipment   = extractEquipment(combined);
      const phones      = parsePhones(combined);
      const route       = extractRoute(combined);
      const rate        = extractMoney(combined);
      const loadId      = extractLoadId(combined);

      // Build company name from email domain
      const domain  = email.split('@')[1] || '';
      const company = domain
        .replace(/\.(com|net|org|io|us|biz|co)$/, '')
        .replace(/[-_.]/g, ' ')
        .replace(/\b\w/g, ch => ch.toUpperCase());

      const nameLower = company.toLowerCase().trim();
      if (!nameLower || existingNames.has(nameLower)) continue;

      maxId++;
      newCarriers.push({
        id:             maxId,
        company,
        mc:             mc || '',
        dot:            dot || '',
        equipment:      equipment || 'Dry Van',
        hazmat:         'No',
        safetyRating:   'Not Rated',
        dispatcher:     '',
        phone:          phones[0] || '',
        afterHours:     '',
        email,
        preferredLanes: route.route || '',
        homeBase:       '',
        address:        '',
        avgRate:        rate ? `$${rate.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}` : 0,
        insurance:      '',
        loadsCompleted: loadId ? 1 : 0,
        otPickup:       0,
        otDelivery:     0,
        claims:         0,
        status:         'Active',
        score:          50,
        region:         '',
        lastActive:     candidate.latestDate,
        notes:          `Found in sent mail. Subject: "${candidate.subject}"${loadId ? ` · Load #${loadId}` : ''}`,
        issueFlag:      false,
        loadHistory:    loadId ? [{
          load:         loadId,
          date:         candidate.latestDate,
          origin:       route.pickup || '',
          dest:         route.delivery || '',
          pickupWindow: '',
          deliveryDate: '',
          deliveryWindow: '',
          customer:     '',
          refNumber:    '',
          status:       'Completed'
        }] : [],
        sources: [{ type: 'gmail', label: 'Gmail \u00b7 Sent Mail Discovery' }]
      });
      existingNames.add(nameLower);
      existingEmails.add(email);
    } catch (_) { /* skip */ }
  }

  // Note: thread enrichment is intentionally skipped here to stay within Netlify's
  // timeout budget (this runs in parallel with Book Now + outreach). The rate-con
  // sync in Step 2 will pick up and enrich these carriers on the same or next run.
  return { newCarriers, scanned: msgIds.length };
}

// ── RC Thread Progress Tracker ───────────────────────────────────────────────
// Reads full "Circle Logistics, Inc - Rate Confirmation for Load #XXXXX" email
// threads and parses carrier REPLIES for load-status signals. Updates each
// carrier's loadHistory[].threadMessages[] so dispatchers can see what the
// carrier said at each stage (pickup confirmed, ETA, delay, issue, delivery).
//
// Signal types (checked in order of severity):
//   issue             — breakdown, flat tire, accident, wrong address, refused delivery
//   delivery_confirmed — delivered, POD signed, dropped off
//   pickup_confirmed  — picked up, on board, just loaded, left shipper
//   delay             — running late, delayed, behind schedule
//   eta_update        — ETA X:XX, will arrive at, en route
//   check_in          — checking in, status update, heads up
//   general           — any other carrier reply
//
// Side effects:
//   - loadHistory item gains: threadId, threadMessages[], loadStatus
//   - carrier.lastContactedDate updated from most recent reply date
//   - carrier.contactLog gets an auto entry for each new date
//   - carrier.issueFlag set to true if issue signal detected

const THREAD_SIGNALS = {
  issue:              /\b(broke?\s*down|breakdown|mechanical\s*(issue|problem|failure)|flat\s*tire?|accident\s*(involved|happened)|lost\s*(load|truck)?|wrong\s*(address|location|dock)|can.?t\s*find|refused?\s*(delivery|to\s*unload)|truck\s*(won.?t\s*start|in\s*the\s*shop)|won.?t\s*deliver)\b/i,
  delivery_confirmed: /\b(delivered|delivery\s*complete|dropped?\s*off|unloaded|consignee\s*(signed|received)|POD|proof\s*of\s*delivery|bill\s*of\s*lading\s*signed|signed\s*for|left\s*at\s*(the\s*)?(dock|receiver|consignee))\b/i,
  pickup_confirmed:   /\b(picked\s*up|on\s*board|just\s*loaded|left\s*the\s*shipper|departed?\s*(from)?\s*(shipper|pickup|facility)?|driver\s*(is\s*)?loaded|we\s*(are|have)\s*loaded|heading\s*to\s*(delivery|consignee|destination))\b/i,
  delay:              /\b(running\s*(late|behind)|delayed?|behind\s*(schedule|eta|time)|will\s*be\s*late|can.?t\s*make\s*(it|the|appointment)?|won.?t\s*make|stuck\s*in\s*traffic|hour[s]?\s*(behind|late|delay)|going\s*to\s*be\s*late)\b/i,
  eta_update:         /\b(eta\s*[\d:]+|estimated\s*(arrival|delivery)|will\s*(arrive|deliver|be\s*there)\s*(at|by|around)|arriving\s*(at|by)|on\s*(my|our)\s*way\s*to\s*(delivery|consignee)?|en\s*route|should\s*be\s*there)\b/i,
  check_in:           /\b(checking\s*in|check\s*in|just\s*(calling|checking)|following\s*up|status\s*update|heads?\s*up|quick\s*update|just\s*wanted\s*to\s*let\s*you\s*know)\b/i,
};

function classifyCarrierMessage(text) {
  const t = String(text || '');
  for (const type of ['issue', 'delivery_confirmed', 'pickup_confirmed', 'delay', 'eta_update', 'check_in']) {
    if (THREAD_SIGNALS[type].test(t)) return type;
  }
  return 'general';
}

function extractEtaMention(text) {
  const m = String(text || '').match(/\b(?:eta|arrive[sd]?\s*(?:at|by|around)?|be\s*there\s*(?:by|at)?)\s*([\d]{1,2}:?[\d]{0,2}\s*(?:am|pm)?)/i);
  return m ? m[1].trim().slice(0, 20) : '';
}

/**
 * syncRCThreadProgress — fetches RC email threads and extracts carrier replies.
 * Wired into the Gmail sync as an optional step per connected user.
 */
export async function syncRCThreadProgress(carriers, options = {}) {
  const config = gmailConfig(options.credentials || {});
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    return { carriers, threadsScanned: 0, updatedCarriers: 0 };
  }

  let accessToken;
  try { accessToken = await fetchAccessToken(config); }
  catch { return { carriers, threadsScanned: 0, updatedCarriers: 0 }; }

  const OUR_DOMAINS = config.ignoreDomains; // ['circledelivers.com', 'circlelogistics.com']
  const emailIndex = buildCarrierEmailIndex(carriers);

  const daysBack   = Math.max(1, Math.min(Number(options.daysBack   || 45), 730));
  const maxResults = Math.max(10, Math.min(Number(options.maxResults || 100), 500));
  const threadCap  = Math.max(5,  Math.min(Number(options.threadCap  || 30), 200));

  // Step 1: Find RC messages by subject — metadata only (fast)
  const msgList = await gmailRequest('messages', accessToken, {
    q: `subject:"Rate Confirmation for Load" newer_than:${daysBack}d -in:trash -in:spam`,
    maxResults
  }).catch(() => ({ messages: [] }));

  const threadIdSet = new Set((msgList?.messages || []).map(m => m.threadId).filter(Boolean));
  const threadIds = [...threadIdSet].slice(0, threadCap);
  if (!threadIds.length) return { carriers, threadsScanned: 0, updatedCarriers: 0 };

  // Clone carriers for safe mutation
  const nextCarriers = carriers.map(c => ({
    ...c,
    loadHistory: (c.loadHistory || []).map(h => ({ ...h }))
  }));
  let updatedCount = 0;

  // Step 2: Fetch and process each thread
  for (const threadId of threadIds) {
    let thread;
    try {
      thread = await gmailRequest(`threads/${encodeURIComponent(threadId)}`, accessToken, { format: 'full' });
    } catch { continue; }

    const msgs = thread?.messages || [];
    if (msgs.length < 2) continue; // nothing to track without a reply

    // Identify the original RC message
    const rcMsg = msgs.find(m => /Rate\s+Confirmation\s+for\s+Load/i.test(safeHeaderMap(m).subject || ''));
    if (!rcMsg) continue;

    const rcH = safeHeaderMap(rcMsg);
    const loadIdMatch = (rcH.subject || '').match(/Load\s+#?(\d{5,})/i);
    const loadId = loadIdMatch?.[1] || '';

    // Carrier = recipient of the RC who is NOT from our domain
    const recipientEmails = [
      ...parseEmails(rcH.to || ''),
      ...parseEmails(rcH.cc || '')
    ].filter(e => !OUR_DOMAINS.includes((e.split('@')[1] || '').toLowerCase()));

    let carrierIdx = -1;
    for (const email of recipientEmails) {
      const idxList = emailIndex.get(email) || [];
      if (idxList.length) { carrierIdx = idxList[0]; break; }
    }
    if (carrierIdx < 0) continue;

    // Carrier reply messages (NOT from our domain)
    const carrierReplies = msgs.filter(m => {
      const fe = (parseEmails(safeHeaderMap(m).from || '')[0] || '');
      return fe && !OUR_DOMAINS.includes((fe.split('@')[1] || '').toLowerCase());
    });
    if (!carrierReplies.length) continue;

    // Parse each carrier reply
    const parsedMessages = carrierReplies.map(m => {
      const headers = safeHeaderMap(m);
      const body = extractMessageText(m);
      const snippet = (m.snippet || '').slice(0, 200);
      const raw = (body || snippet).slice(0, 1200);

      // Strip quoted / forwarded reply blocks before classifying
      const stripped = raw
        .replace(/^(>.*|On\s.{0,100}wrote:|From:\s*.+)$/gim, '')
        .replace(/_{5,}[\s\S]{0,600}$/, '')
        .replace(/\s{3,}/g, '\n')
        .trim();

      const type = classifyCarrierMessage(stripped);
      const eta  = (type === 'eta_update' || type === 'delay') ? extractEtaMention(stripped) : '';
      const ts   = m.internalDate ? new Date(parseInt(m.internalDate)) : null;
      const date = (ts && !isNaN(ts)) ? ts.toISOString().slice(0, 10)
                 : (headers.date ? new Date(headers.date).toISOString().slice(0, 10) : '');

      return {
        date,
        from: parseEmails(headers.from || '')[0] || (headers.from || '').slice(0, 60),
        type,
        ...(eta ? { eta } : {}),
        body: (stripped || snippet).slice(0, 350)
      };
    }).filter(m => m.date);

    if (!parsedMessages.length) continue;

    const c = nextCarriers[carrierIdx];
    const types = parsedMessages.map(m => m.type);
    const hasIssue    = types.includes('issue');
    const hasDelivery = types.includes('delivery_confirmed');
    const hasPickup   = types.includes('pickup_confirmed');

    const loadStatus = hasIssue    ? 'Issue Reported'
      : hasDelivery ? 'Delivered'
      : hasPickup   ? 'In Transit'
      : 'Booked';

    // Update or insert load history entry
    const histIdx = (c.loadHistory || []).findIndex(h =>
      loadId && String(h.load_id || h.load || '') === loadId
    );
    if (histIdx >= 0) {
      c.loadHistory[histIdx] = {
        ...c.loadHistory[histIdx],
        threadId,
        threadMessages: parsedMessages,
        loadStatus,
        ...(hasIssue && !String(c.loadHistory[histIdx].status || '').includes('Issue') ? { status: 'Issue Reported' } : {}),
        ...(hasDelivery ? { status: 'Completed' } : {})
      };
    } else if (loadId) {
      const rcBody = extractMessageText(rcMsg);
      const rcRoute = extractRoute(rcBody || '');
      const rcRate  = extractMoney(rcBody || '');
      if (!c.loadHistory) c.loadHistory = [];
      c.loadHistory.push({
        load_id: loadId,
        route: rcRoute.route || '',
        status: loadStatus,
        ...(rcRate ? { rate: rcRate } : {}),
        source: 'gmail-rc-thread',
        threadId,
        threadMessages: parsedMessages,
        loadStatus,
        synced_at: nowIso()
      });
    }

    // Update lastContactedDate + contactLog from most recent carrier reply
    const mostRecentDate = parsedMessages.map(m => m.date).filter(Boolean).sort().pop() || '';
    if (mostRecentDate && (!c.lastContactedDate || mostRecentDate > c.lastContactedDate)) {
      c.lastContactedDate = mostRecentDate;
      if (!c.contactLog) c.contactLog = [];
      const alreadyLogged = c.contactLog.some(l => l.date === mostRecentDate && l.auto
        && String(l.notes || '').includes(loadId));
      if (!alreadyLogged) {
        c.contactLog.push({
          date: mostRecentDate,
          type: 'Email',
          notes: `RC thread · Load #${loadId} · ${parsedMessages[parsedMessages.length - 1].type.replace(/_/g, ' ')}`,
          auto: true
        });
      }
    }

    if (hasIssue && !c.issueFlag) c.issueFlag = true;
    updatedCount++;
  }

  return { carriers: nextCarriers, threadsScanned: threadIds.length, updatedCarriers: updatedCount };
}

// ── Carrier Outreach Tracker ──────────────────────────────────────────────────
// Scans the authenticated user's sent mail and inbox for emails to/from carriers
// already in the database. Updates lastContactedDate and contactLog automatically
// so dispatchers don't have to log email outreach manually.
//
// Search criteria:
//   Sent:   in:sent newer_than:90d  — emails WE sent to a carrier email address
//   Inbox:  in:inbox newer_than:90d — emails a carrier sent back to us
//
// Dedup: only updates a carrier if the detected date is newer than what is already stored.
// contactLog: appends one "Email" entry per newly-detected date (auto:true flag marks it).
export async function syncCarrierOutreachFromGmail(carriers, options = {}) {
  const config = gmailConfig(options.credentials || {});
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new Error('Gmail OAuth not configured.');
  }
  const accessToken = await fetchAccessToken(config);
  const daysBack = Math.max(1, Math.min(Number(options.daysBack || 90), 730));
  const sentMax  = Math.max(10, Math.min(Number(options.sentMax  || 100), 500));
  const inboxMax = Math.max(10, Math.min(Number(options.inboxMax || 75), 500));

  // Build email → carrier index (normalized email → index in carriers array)
  const emailIndex = new Map();
  (carriers || []).forEach((c, idx) => {
    parseEmails(c.email || '').forEach(e => {
      if (!emailIndex.has(e)) emailIndex.set(e, idx);
    });
  });
  if (emailIndex.size === 0) return { carriers, updated: 0, scanned: 0 };

  // Track the most-recent detected contact per carrier (index → contact object)
  const bestContact = new Map();

  // Fetch metadata for a batch of message IDs and match against carrier emails.
  // direction: 'sent' → check To/Cc fields; 'received' → check From field.
  async function fetchAndMatch(ids, direction) {
    const BATCH = 20;
    for (let i = 0; i < ids.length; i += BATCH) {
      const slice = ids.slice(i, i + BATCH);
      await Promise.all(slice.map(async (id) => {
        try {
          const msg = await gmailRequest(`messages/${encodeURIComponent(id)}`, accessToken, {
            format: 'metadata',
            metadataHeaders: ['To', 'From', 'Cc', 'Date', 'Subject']
          });
          const h = safeHeaderMap(msg);
          const ts = msg?.internalDate ? new Date(parseInt(msg.internalDate)) : null;
          if (!ts || isNaN(ts)) return;

          const candidates = direction === 'sent'
            ? [...parseEmails(h.to || ''), ...parseEmails(h.cc || '')]
            : parseEmails(h.from || '');

          for (const email of candidates) {
            const idx = emailIndex.get(email);
            if (idx == null) continue;
            const prev = bestContact.get(idx);
            if (!prev || ts > prev.date) {
              bestContact.set(idx, {
                date: ts,
                dateIso: ts.toISOString().slice(0, 10),
                subject: (h.subject || '').slice(0, 120),
                direction
              });
            }
            break;
          }
        } catch (_) { /* skip individual message errors */ }
      }));
    }
  }

  // List sent mail and inbox messages (metadata-only — much faster than full format)
  const [sentList, inboxList] = await Promise.all([
    gmailRequest('messages', accessToken, { q: `in:sent newer_than:${daysBack}d -in:trash`, maxResults: sentMax }),
    gmailRequest('messages', accessToken, { q: `in:inbox newer_than:${daysBack}d -in:trash`, maxResults: inboxMax })
  ]);
  const sentIds   = (sentList?.messages  || []).map(m => m.id).filter(Boolean);
  const inboxIds  = (inboxList?.messages || []).map(m => m.id).filter(Boolean);

  await fetchAndMatch(sentIds,  'sent');
  await fetchAndMatch(inboxIds, 'received');

  // Apply updates — only if detected date is newer than what's already stored
  let updated = 0;
  const nextCarriers = (carriers || []).map((c, idx) => {
    const contact = bestContact.get(idx);
    if (!contact) return c;
    if (contact.dateIso <= (c.lastContactedDate || '')) return c; // nothing newer

    updated++;

    // Build a concise log note from the email subject
    const direction  = contact.direction === 'sent' ? 'Outreach' : 'Reply from carrier';
    const noteText   = contact.subject ? `${direction}: "${contact.subject}"` : direction;
    const logEntry   = { date: contact.dateIso, type: 'Email', notes: noteText, auto: true };

    // Don't duplicate if an entry with this exact date + type already exists
    const existingLog = Array.isArray(c.contactLog) ? c.contactLog : [];
    const alreadyLogged = existingLog.some(e => e.date === contact.dateIso && e.type === 'Email');

    return {
      ...c,
      lastContactedDate: contact.dateIso,
      contactLog: alreadyLogged ? existingLog : [...existingLog, logEntry]
    };
  });

  return { carriers: nextCarriers, updated, scanned: sentIds.length + inboxIds.length };
}
