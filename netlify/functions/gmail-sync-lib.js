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

function extractRoute(text) {
  const direct = text.match(/([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})\s*(?:→|->|-->| to )\s*([A-Z][A-Za-z .'-]+,\s*[A-Z]{2})/i);
  if (direct?.[1] && direct?.[2]) {
    return {
      route: `${direct[1].trim()}→${direct[2].trim()}`,
      pickup: direct[1].trim(),
      delivery: direct[2].trim()
    };
  }
  const pickup = extractKeywordLocation(text, 'pickup|origin');
  const delivery = extractKeywordLocation(text, 'delivery|destination|consignee');
  if (pickup || delivery) {
    return {
      route: pickup && delivery ? `${pickup}→${delivery}` : pickup || delivery,
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

  (events || []).forEach((event) => {
    const extracted = normalizeRateConfirmationEvent({ ...(event || {}), ignoreDomains });
    if (!extracted) return;
    const participants = extracted.matchedEmails || [];
    const carrierIndexes = new Set();
    participants.forEach((email) => {
      (carrierEmailIndex.get(email) || []).forEach((index) => carrierIndexes.add(index));
    });
    if (!carrierIndexes.size) return;

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
    gmailSync: syncMeta
  };
}

export async function syncCarriersFromGmail(carriers, credentials = null) {
  const config = gmailConfig(credentials || {});
  if (!config.clientId || !config.clientSecret || !config.refreshToken) {
    throw new Error('Gmail sync is not configured. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN.');
  }

  const accessToken = await fetchAccessToken(config);
  const events = [];

  // Narrower queries with tighter result limits — we pre-filter by subject before full-fetch.
  const INBOX_QUERY = 'newer_than:60d ("rate confirmation" OR "rate con" OR "carrier confirmation" OR "load tender" OR "booking confirmation" OR "dispatch confirmation") -in:trash -in:spam';
  const SENT_QUERY  = 'in:sent newer_than:60d ("rate confirmation" OR "rate con" OR "booking confirmation" OR "carrier") -in:trash';

  const [inboxList, sentList] = await Promise.all([
    gmailRequest('messages', accessToken, { q: INBOX_QUERY, maxResults: 80 }),
    gmailRequest('messages', accessToken, { q: SENT_QUERY,  maxResults: 60 })
  ]);

  // Deduplicate by message ID
  const seen = new Set();
  const allMessages = [];
  for (const m of [...(inboxList?.messages || []), ...(sentList?.messages || [])]) {
    if (m?.id && !seen.has(m.id)) { seen.add(m.id); allMessages.push(m); }
  }

  // Phase 1: metadata-only fetch to pre-filter by subject / snippet.
  // Full content is only fetched for messages that look like rate confirmations.
  const RC_RE = /rate\s*conf(?:irmation)?|carrier\s*conf|load\s*tender|dispatch\s*conf|booking\s*conf/i;
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

  // Phase 2: full-content fetch for confirmed candidates (cap at 25 to stay within timeout)
  for (const msgId of candidateIds.slice(0, 25)) {
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

  return applyRateConfirmationEvents(carriers, events, {
    query: INBOX_QUERY,
    labelIds: config.labelIds,
    userEmail: config.userEmail || 'me',
    ignoreDomains: config.ignoreDomains
  });
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
  const daysBack = options.daysBack || 30;
  // in:inbox restricts to messages delivered to the primary inbox only —
  // excludes any Book Now emails that were auto-filtered into other labels/folders
  // (e.g. a "FW Carrier Sales" filter) so we only process direct bookings.
  const query = `from:noreply@circledelivers.com "Book Now Dispatch for Load" to:me in:inbox newer_than:${daysBack}d`;

  const messageList = await gmailRequest('messages', accessToken, { q: query, maxResults: 50 });
  const messages = Array.isArray(messageList?.messages) ? messageList.messages : [];

  // Build lookup sets for existing carriers
  const existingNames  = new Set((carriers || []).map(c => (c.company || '').toLowerCase().trim()));
  const existingEmails = new Set((carriers || []).flatMap(c => parseEmails(c.email || '')));
  let maxId = Math.max(100, ...(carriers || []).map(c => Number(c.id) || 0));

  const newCarriers = [];
  const skipped     = [];

  for (const msg of messages) {
    if (!msg?.id) continue;
    const payload = await gmailRequest(`messages/${encodeURIComponent(msg.id)}`, accessToken, { format: 'full' });
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

  return { newCarriers, skipped, messagesScanned: messages.length };
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
  const daysBack = options.daysBack || 90;

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
    gmailRequest('messages', accessToken, { q: `in:sent newer_than:${daysBack}d -in:trash`, maxResults: 100 }),
    gmailRequest('messages', accessToken, { q: `in:inbox newer_than:${daysBack}d -in:trash`, maxResults: 75 })
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
