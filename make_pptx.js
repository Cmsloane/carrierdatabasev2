const pptxgen = require("pptxgenjs");
const path = require("path");

const SCREENS = "C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/screenshots";
const OUT = "C:/Users/admin/OneDrive/Desktop/Claude/ChatGPT/CarrierDatabase_TeamGuide.pptx";

// ── Palette ──────────────────────────────────────────────────────────────────
const NAVY   = "0D1B2A";   // deep navy  (dominant dark bg)
const ORANGE = "E8601C";   // Circle orange accent
const WHITE  = "FFFFFF";
const LIGHT  = "F0F4F8";   // light slide bg
const MUTED  = "8A9BB0";   // muted labels
const TEAL   = "00B4D8";   // data callout blue
const GREEN  = "2DC653";   // positive / preferred
const CARD   = "1A2940";   // card bg on dark slides

// ── Helpers ───────────────────────────────────────────────────────────────────
const img = (file) => path.join(SCREENS, file);
const makeShadow = () => ({ type: "outer", blur: 12, offset: 4, angle: 135, color: "000000", opacity: 0.18 });

let pres = new pptxgen();
pres.layout  = "LAYOUT_16x9";
pres.title   = "Circle Logistics · Carrier Database Team Guide";
pres.author  = "Circle Logistics";

// ═══════════════════════════════════════════════════════════════════════════
// SLIDE 1 — TITLE
// ═══════════════════════════════════════════════════════════════════════════
{
  let sl = pres.addSlide();
  sl.background = { color: NAVY };

  // Orange left accent bar
  sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 0.18, h: 5.625, fill: { color: ORANGE }, line: { color: ORANGE } });

  // Subtle grid texture — horizontal lines
  for (let i = 0; i < 8; i++) {
    sl.addShape(pres.shapes.LINE, { x: 0.3, y: 0.7 + i * 0.7, w: 9.7, h: 0, line: { color: "1E3050", width: 0.5 } });
  }

  // Logo text
  sl.addText("CIRCLE LOGISTICS", {
    x: 0.45, y: 0.38, w: 5, h: 0.45,
    fontSize: 11, fontFace: "Calibri", bold: true, color: ORANGE,
    charSpacing: 5, margin: 0
  });

  // Main title
  sl.addText("Carrier Database", {
    x: 0.45, y: 0.88, w: 9.2, h: 1.6,
    fontSize: 64, fontFace: "Georgia", bold: true, color: WHITE, margin: 0
  });

  // Subtitle
  sl.addText("Your intelligent carrier management platform — profiles, lane history,\nlive loads, and smart matching in one place.", {
    x: 0.45, y: 2.55, w: 6.2, h: 1.0,
    fontSize: 16, fontFace: "Calibri", color: MUTED, margin: 0
  });

  // Stats bar
  const stats = [
    { n: "96", lbl: "Carriers" },
    { n: "406", lbl: "Active Loads" },
    { n: "100%", lbl: "Real-Time Sync" },
    { n: "5", lbl: "Preferred" },
  ];
  stats.forEach((s, i) => {
    const x = 0.45 + i * 2.3;
    sl.addShape(pres.shapes.RECTANGLE, { x, y: 3.85, w: 2.1, h: 1.2, fill: { color: CARD }, line: { color: "253A55" }, shadow: makeShadow() });
    sl.addText(s.n, { x, y: 3.92, w: 2.1, h: 0.6, fontSize: 34, fontFace: "Georgia", bold: true, color: ORANGE, align: "center", margin: 0 });
    sl.addText(s.lbl, { x, y: 4.52, w: 2.1, h: 0.35, fontSize: 11, fontFace: "Calibri", color: MUTED, align: "center", margin: 0 });
  });

  // URL
  sl.addText("carrierdatabasev2.netlify.app", {
    x: 0.45, y: 5.15, w: 9.2, h: 0.3,
    fontSize: 10, fontFace: "Calibri", color: "3A6A9A", margin: 0
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SLIDE 2 — WHAT IS IT? (screenshot + overview)
// ═══════════════════════════════════════════════════════════════════════════
{
  let sl = pres.addSlide();
  sl.background = { color: LIGHT };

  // Top accent bar
  sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.08, fill: { color: ORANGE }, line: { color: ORANGE } });

  // Section label
  sl.addText("OVERVIEW", { x: 0.5, y: 0.22, w: 3, h: 0.3, fontSize: 9, fontFace: "Calibri", bold: true, color: ORANGE, charSpacing: 4, margin: 0 });

  // Title
  sl.addText("What Is the Carrier Database?", {
    x: 0.5, y: 0.52, w: 9, h: 0.65,
    fontSize: 30, fontFace: "Georgia", bold: true, color: NAVY, margin: 0
  });

  // Screenshot left
  sl.addImage({ path: img("s01_main.png"), x: 0.4, y: 1.3, w: 5.8, h: 3.26, shadow: makeShadow() });

  // Right callout cards
  const bullets = [
    { icon: "📋", hdr: "Central Carrier Hub", body: "All 96 carriers in one searchable, filterable list — MC#, DOT, equipment, lanes, and performance." },
    { icon: "🔄", hdr: "Live & Always Synced", body: "Carriers and loads update in real time. Any team member sees the same data instantly." },
    { icon: "🔍", hdr: "Powerful Search", body: "Search by carrier name, MC#, city, lane, dispatcher name, or load number." },
    { icon: "📊", hdr: "Performance Scoring", body: "Every carrier has an automated reliability score (0–100) based on on-time pickup, delivery, and claims." },
  ];

  bullets.forEach((b, i) => {
    const y = 1.28 + i * 1.05;
    sl.addShape(pres.shapes.RECTANGLE, { x: 6.45, y, w: 3.15, h: 0.92, fill: { color: WHITE }, line: { color: "D9E4EF" }, shadow: makeShadow() });
    sl.addText(b.icon + "  " + b.hdr, { x: 6.6, y: y + 0.06, w: 2.9, h: 0.3, fontSize: 11, fontFace: "Calibri", bold: true, color: NAVY, margin: 0 });
    sl.addText(b.body, { x: 6.6, y: y + 0.36, w: 2.9, h: 0.48, fontSize: 9.5, fontFace: "Calibri", color: "4A5E72", margin: 0, wrap: true });
  });

  // Bottom tag
  sl.addText("Access at: carrierdatabasev2.netlify.app  ·  Sign in with your Circle Google account", {
    x: 0.4, y: 5.22, w: 9.2, h: 0.25, fontSize: 9, fontFace: "Calibri", color: MUTED, margin: 0
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SLIDE 3 — CARRIER PROFILES (top section)
// ═══════════════════════════════════════════════════════════════════════════
{
  let sl = pres.addSlide();
  sl.background = { color: NAVY };

  sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.08, fill: { color: ORANGE }, line: { color: ORANGE } });

  sl.addText("CARRIER PROFILES", { x: 0.5, y: 0.22, w: 4, h: 0.3, fontSize: 9, fontFace: "Calibri", bold: true, color: ORANGE, charSpacing: 4, margin: 0 });
  sl.addText("Click Any Carrier — See Everything", {
    x: 0.5, y: 0.52, w: 9, h: 0.65,
    fontSize: 30, fontFace: "Georgia", bold: true, color: WHITE, margin: 0
  });

  // Screenshot
  sl.addImage({ path: img("s02_carrier_top.png"), x: 0.4, y: 1.28, w: 5.8, h: 3.26, shadow: makeShadow() });

  // Callout annotations
  const callouts = [
    { hdr: "Status Badge", body: "Preferred, Active, Conditional, or Do Not Use — color-coded instantly." },
    { hdr: "Reliability Score", body: "0–100 score with visual bar. Green = go, amber = caution." },
    { hdr: "Contact Info", body: "Dispatcher names, direct extensions, email, and after-hours numbers." },
    { hdr: "Fleet & Compliance", body: "Equipment type, hazmat cert, safety rating, and insurance status." },
    { hdr: "Lane Intelligence", body: "Home base, preferred lanes, region, and average rate anchor." },
    { hdr: "Performance Stats", body: "Loads completed, on-time pickup %, on-time delivery %, and claims." },
  ];

  callouts.forEach((c, i) => {
    const col = i < 3 ? 0 : 1;
    const row = i % 3;
    const x = 6.45 + col * 0;
    const y = 1.28 + row * 1.08;
    const xOff = col === 0 ? 6.45 : 8.1;
    sl.addShape(pres.shapes.RECTANGLE, { x: xOff, y, w: 1.4, h: 0.95, fill: { color: CARD }, line: { color: "253A55" }, shadow: makeShadow() });
    sl.addText(c.hdr, { x: xOff + 0.1, y: y + 0.07, w: 1.2, h: 0.26, fontSize: 9.5, fontFace: "Calibri", bold: true, color: TEAL, margin: 0 });
    sl.addText(c.body, { x: xOff + 0.1, y: y + 0.33, w: 1.2, h: 0.52, fontSize: 8.5, fontFace: "Calibri", color: MUTED, margin: 0, wrap: true });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SLIDE 4 — NOTES, CALL PREP, LOAD HISTORY
// ═══════════════════════════════════════════════════════════════════════════
{
  let sl = pres.addSlide();
  sl.background = { color: LIGHT };

  sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.08, fill: { color: ORANGE }, line: { color: ORANGE } });

  sl.addText("CARRIER PROFILES  ·  INTELLIGENCE LAYER", { x: 0.5, y: 0.22, w: 6, h: 0.3, fontSize: 9, fontFace: "Calibri", bold: true, color: ORANGE, charSpacing: 4, margin: 0 });
  sl.addText("Notes, Call Prep & Load History", {
    x: 0.5, y: 0.52, w: 9, h: 0.65,
    fontSize: 30, fontFace: "Georgia", bold: true, color: NAVY, margin: 0
  });

  sl.addImage({ path: img("s03_carrier_notes.png"), x: 0.4, y: 1.28, w: 5.8, h: 3.26, shadow: makeShadow() });

  const features = [
    { icon: "📝", hdr: "Editable Notes", body: "Click any note field and type — saves automatically on blur via live API patch." },
    { icon: "📞", hdr: "Call Prep Talking Points", body: "Auto-generated from real data: last active date, rate anchor, score tier, and warm relationship cues." },
    { icon: "📦", hdr: "Load History", body: "Every load this carrier has run with Circle — route, date, and status (Completed, Late, Tracking issues)." },
    { icon: "📡", hdr: "Data Source Audit", body: "Shows exactly where the data came from: Gmail rate confirmations, Book Now emails, or manual entry." },
  ];

  features.forEach((f, i) => {
    const y = 1.28 + i * 1.05;
    sl.addShape(pres.shapes.RECTANGLE, { x: 6.45, y, w: 3.15, h: 0.92, fill: { color: WHITE }, line: { color: "D9E4EF" }, shadow: makeShadow() });
    sl.addText(f.icon + "  " + f.hdr, { x: 6.6, y: y + 0.07, w: 2.9, h: 0.28, fontSize: 11, fontFace: "Calibri", bold: true, color: NAVY, margin: 0 });
    sl.addText(f.body, { x: 6.6, y: y + 0.36, w: 2.9, h: 0.48, fontSize: 9.5, fontFace: "Calibri", color: "4A5E72", margin: 0, wrap: true });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SLIDE 5 — CARRIER ↔ LOAD MATCHING (matched loads in profile)
// ═══════════════════════════════════════════════════════════════════════════
{
  let sl = pres.addSlide();
  sl.background = { color: NAVY };

  sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.08, fill: { color: ORANGE }, line: { color: ORANGE } });
  sl.addText("SMART MATCHING", { x: 0.5, y: 0.22, w: 4, h: 0.3, fontSize: 9, fontFace: "Calibri", bold: true, color: ORANGE, charSpacing: 4, margin: 0 });
  sl.addText("Matched Loads Inside Every Carrier Profile", {
    x: 0.5, y: 0.52, w: 9, h: 0.65,
    fontSize: 30, fontFace: "Georgia", bold: true, color: WHITE, margin: 0
  });

  sl.addImage({ path: img("s04_matched_loads.png"), x: 0.4, y: 1.28, w: 5.8, h: 3.26, shadow: makeShadow() });

  sl.addText("How Matching Works", { x: 6.45, y: 1.3, w: 3.15, h: 0.36, fontSize: 13, fontFace: "Calibri", bold: true, color: TEAL, margin: 0 });

  const steps = [
    { n: "1", t: "Lane Alignment", d: "Compares carrier's known origin/destination states against every open load." },
    { n: "2", t: "Equipment Match", d: "Only shows loads the carrier can actually run (Van, Reefer, Flatbed, etc.)." },
    { n: "3", t: "Score Ranking", d: "Results sorted by reliability score — best carriers surface first." },
    { n: "4", t: "Strong / Possible", d: "\"Strong Match\" = same state pair hauled before. \"Possible\" = adjacent lanes." },
  ];

  steps.forEach((s, i) => {
    const y = 1.75 + i * 0.92;
    sl.addShape(pres.shapes.OVAL, { x: 6.45, y: y + 0.18, w: 0.38, h: 0.38, fill: { color: ORANGE }, line: { color: ORANGE } });
    sl.addText(s.n, { x: 6.45, y: y + 0.18, w: 0.38, h: 0.38, fontSize: 12, fontFace: "Calibri", bold: true, color: WHITE, align: "center", valign: "middle", margin: 0 });
    sl.addText(s.t, { x: 6.95, y: y + 0.12, w: 2.65, h: 0.28, fontSize: 10.5, fontFace: "Calibri", bold: true, color: WHITE, margin: 0 });
    sl.addText(s.d, { x: 6.95, y: y + 0.4, w: 2.65, h: 0.4, fontSize: 9, fontFace: "Calibri", color: MUTED, margin: 0, wrap: true });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SLIDE 6 — LOADS TAB
// ═══════════════════════════════════════════════════════════════════════════
{
  let sl = pres.addSlide();
  sl.background = { color: LIGHT };

  sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.08, fill: { color: ORANGE }, line: { color: ORANGE } });
  sl.addText("LOADS TAB", { x: 0.5, y: 0.22, w: 4, h: 0.3, fontSize: 9, fontFace: "Calibri", bold: true, color: ORANGE, charSpacing: 4, margin: 0 });
  sl.addText("Live Freight Board — 406 Active Loads", {
    x: 0.5, y: 0.52, w: 9, h: 0.65,
    fontSize: 30, fontFace: "Georgia", bold: true, color: NAVY, margin: 0
  });

  sl.addImage({ path: img("s05_loads_table.png"), x: 0.4, y: 1.28, w: 9.2, h: 3.38, shadow: makeShadow() });

  const tags = [
    { t: "Route + miles", c: NAVY },
    { t: "Pickup & delivery windows", c: NAVY },
    { t: "Equipment type", c: NAVY },
    { t: "Weight (lbs)", c: NAVY },
    { t: "LBR rate + Max Buy", c: ORANGE },
    { t: "Hazmat flag", c: NAVY },
    { t: "Upload new loads (.htm / .pdf)", c: TEAL },
    { t: "Filter by date, equipment, hazmat", c: NAVY },
  ];

  let tx = 0.4;
  tags.forEach((t, i) => {
    const pill_w = t.t.length * 0.095 + 0.35;
    sl.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: tx, y: 4.9, w: pill_w, h: 0.32, fill: { color: t.c === ORANGE ? "FFF3EC" : t.c === TEAL ? "E8F8FC" : "EEF3F8" }, line: { color: t.c === ORANGE ? "FDDCC4" : t.c === TEAL ? "B2E8F4" : "D0DDE9" }, rectRadius: 0.06 });
    sl.addText(t.t, { x: tx + 0.08, y: 4.9, w: pill_w - 0.16, h: 0.32, fontSize: 9, fontFace: "Calibri", color: t.c === NAVY ? "4A5E72" : t.c, bold: t.c !== NAVY, margin: 0, valign: "middle" });
    tx += pill_w + 0.12;
    if (tx > 9.2) { tx = 0.4; }
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SLIDE 7 — LOAD DETAIL PANEL + CARRIER RECOMMENDATIONS
// ═══════════════════════════════════════════════════════════════════════════
{
  let sl = pres.addSlide();
  sl.background = { color: NAVY };

  sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.08, fill: { color: ORANGE }, line: { color: ORANGE } });
  sl.addText("LOAD DETAIL PANEL", { x: 0.5, y: 0.22, w: 5, h: 0.3, fontSize: 9, fontFace: "Calibri", bold: true, color: ORANGE, charSpacing: 4, margin: 0 });
  sl.addText("Click Any Load — Instant Carrier Recommendations", {
    x: 0.5, y: 0.52, w: 9, h: 0.65,
    fontSize: 28, fontFace: "Georgia", bold: true, color: WHITE, margin: 0
  });

  // Two screenshots side by side
  sl.addImage({ path: img("s06_load_detail_top.png"), x: 0.4, y: 1.28, w: 4.6, h: 2.6, shadow: makeShadow() });
  sl.addImage({ path: img("s07_load_carrier_matches.png"), x: 5.2, y: 1.28, w: 4.4, h: 2.6, shadow: makeShadow() });

  sl.addText("Load details: route, pickup/delivery times,\ncustomer, commodity, weight, miles,\nLBR rate, max buy, spread, and $/mi.", {
    x: 0.4, y: 3.98, w: 4.6, h: 0.7, fontSize: 10.5, fontFace: "Calibri", color: MUTED, margin: 0
  });

  sl.addText("Best carrier matches auto-appear — ranked by\nlane fit and reliability score. Click Highway\nto open their safety profile instantly.", {
    x: 5.2, y: 3.98, w: 4.4, h: 0.7, fontSize: 10.5, fontFace: "Calibri", color: MUTED, margin: 0
  });

  // Bottom highlight row
  const highlights = [
    { n: "LBR vs Max Buy", d: "See your spread instantly" },
    { n: "$/mile", d: "Rate efficiency at a glance" },
    { n: "Top 5 Carriers", d: "Pre-ranked for this exact lane" },
    { n: "Highway Button", d: "1-click compliance check" },
  ];
  highlights.forEach((h, i) => {
    const x = 0.4 + i * 2.38;
    sl.addShape(pres.shapes.RECTANGLE, { x, y: 4.82, w: 2.2, h: 0.62, fill: { color: CARD }, line: { color: "253A55" }, shadow: makeShadow() });
    sl.addText(h.n, { x: x + 0.12, y: 4.85, w: 2.0, h: 0.26, fontSize: 10, fontFace: "Calibri", bold: true, color: TEAL, margin: 0 });
    sl.addText(h.d, { x: x + 0.12, y: 5.1, w: 2.0, h: 0.28, fontSize: 9, fontFace: "Calibri", color: MUTED, margin: 0 });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SLIDE 8 — GMAIL SYNC + TEAM LOGIN
// ═══════════════════════════════════════════════════════════════════════════
{
  let sl = pres.addSlide();
  sl.background = { color: LIGHT };

  sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.08, fill: { color: ORANGE }, line: { color: ORANGE } });
  sl.addText("GMAIL SYNC  ·  TEAM LOGIN", { x: 0.5, y: 0.22, w: 5, h: 0.3, fontSize: 9, fontFace: "Calibri", bold: true, color: ORANGE, charSpacing: 4, margin: 0 });
  sl.addText("Automatic Carrier Data — Straight from Your Inbox", {
    x: 0.5, y: 0.52, w: 9, h: 0.65,
    fontSize: 28, fontFace: "Georgia", bold: true, color: NAVY, margin: 0
  });

  // Two columns
  // LEFT: How sync works
  sl.addShape(pres.shapes.RECTANGLE, { x: 0.4, y: 1.35, w: 4.5, h: 3.8, fill: { color: WHITE }, line: { color: "D9E4EF" }, shadow: makeShadow() });
  sl.addText("How Carrier Sync Works", { x: 0.6, y: 1.48, w: 4.1, h: 0.35, fontSize: 13, fontFace: "Calibri", bold: true, color: NAVY, margin: 0 });

  const syncSteps = [
    { n: "1", t: "\"Book Now Dispatch\" Emails", d: "The system scans emails from Circle's TMS for every new carrier booking — route, dispatcher, phone, lane, pickup/delivery." },
    { n: "2", t: "Rate Confirmation Threads", d: "Cross-references MC numbers and carrier contact details from PDF rate confirmations." },
    { n: "3", t: "Auto-Creates Carrier Profile", d: "New carriers appear in the database automatically. Existing carriers are updated with fresh lane data." },
    { n: "4", t: "Press Carrier Sync Anytime", d: "Hit the blue \"Carrier Sync\" button in the top bar to manually trigger a fresh scan of all connected inboxes." },
  ];

  syncSteps.forEach((s, i) => {
    const y = 1.95 + i * 0.82;
    sl.addShape(pres.shapes.OVAL, { x: 0.6, y: y + 0.05, w: 0.32, h: 0.32, fill: { color: ORANGE }, line: { color: ORANGE } });
    sl.addText(s.n, { x: 0.6, y: y + 0.05, w: 0.32, h: 0.32, fontSize: 10, fontFace: "Calibri", bold: true, color: WHITE, align: "center", valign: "middle", margin: 0 });
    sl.addText(s.t, { x: 1.05, y: y, w: 3.65, h: 0.26, fontSize: 10, fontFace: "Calibri", bold: true, color: NAVY, margin: 0 });
    sl.addText(s.d, { x: 1.05, y: y + 0.26, w: 3.65, h: 0.44, fontSize: 9, fontFace: "Calibri", color: "4A5E72", margin: 0, wrap: true });
  });

  // RIGHT: Team login
  sl.addShape(pres.shapes.RECTANGLE, { x: 5.1, y: 1.35, w: 4.5, h: 3.8, fill: { color: WHITE }, line: { color: "D9E4EF" }, shadow: makeShadow() });
  sl.addText("Team Login — Google SSO", { x: 5.3, y: 1.48, w: 4.1, h: 0.35, fontSize: 13, fontFace: "Calibri", bold: true, color: NAVY, margin: 0 });

  const loginPoints = [
    { icon: "🔐", hdr: "Sign In with Google", body: "Click \"Sign In\" in the top bar. Use your @circledelivers.com or @circlelogistics.com account. No passwords to manage." },
    { icon: "📧", hdr: "Connect Your Gmail", body: "Once signed in, your Gmail is connected. The next Carrier Sync automatically scans your inbox too — more carriers found." },
    { icon: "👥", hdr: "See Who's Connected", body: "Click your avatar → \"Gmail Users\" to see all team members connected and when they last synced." },
    { icon: "🔔", hdr: "Admin Notifications", body: "Conrad receives an email whenever anyone signs in or a sync runs — with a full results summary." },
  ];

  loginPoints.forEach((lp, i) => {
    const y = 1.9 + i * 0.82;
    sl.addText(lp.icon, { x: 5.3, y: y + 0.08, w: 0.38, h: 0.38, fontSize: 18, margin: 0 });
    sl.addText(lp.hdr, { x: 5.8, y: y, w: 3.6, h: 0.26, fontSize: 10, fontFace: "Calibri", bold: true, color: NAVY, margin: 0 });
    sl.addText(lp.body, { x: 5.8, y: y + 0.26, w: 3.6, h: 0.44, fontSize: 9, fontFace: "Calibri", color: "4A5E72", margin: 0, wrap: true });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SLIDE 9 — QUICK START GUIDE
// ═══════════════════════════════════════════════════════════════════════════
{
  let sl = pres.addSlide();
  sl.background = { color: NAVY };

  sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.08, fill: { color: ORANGE }, line: { color: ORANGE } });
  sl.addText("QUICK START", { x: 0.5, y: 0.22, w: 4, h: 0.3, fontSize: 9, fontFace: "Calibri", bold: true, color: ORANGE, charSpacing: 4, margin: 0 });
  sl.addText("How to Use the Carrier Database", {
    x: 0.5, y: 0.52, w: 9, h: 0.65,
    fontSize: 30, fontFace: "Georgia", bold: true, color: WHITE, margin: 0
  });

  const tasks = [
    {
      title: "Find a Carrier",
      steps: ["Go to the Carriers tab", "Type in the search bar: name, MC#, city, or lane", "Use Equipment / Status / Region filters to narrow results", "Click any row to open the full profile"]
    },
    {
      title: "Work a Load",
      steps: ["Click the Loads tab (406 available)", "Filter by equipment, date, or hazmat", "Click a load row → see pickup/delivery, rate, and spread", "Scroll the detail panel — Best Carrier Matches auto-appear"]
    },
    {
      title: "Add a New Carrier",
      steps: ["Click \"+ Add Carrier\" in the top bar", "Fill in the form (MC#, contact, equipment, lanes)", "Save — carrier appears immediately for all team members", "Run Carrier Sync to auto-fill data from Gmail"]
    },
    {
      title: "Verify Carrier Safety",
      steps: ["Open any carrier profile", "Click \"Highway\" to open their vetting dashboard", "Click \"FMCSA\" to check DOT safety record directly", "Status updates live in the profile (Active, DNU, etc.)"]
    },
  ];

  tasks.forEach((t, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const x = 0.4 + col * 4.8;
    const y = 1.35 + row * 2.1;
    sl.addShape(pres.shapes.RECTANGLE, { x, y, w: 4.5, h: 1.95, fill: { color: CARD }, line: { color: "253A55" }, shadow: makeShadow() });
    // Orange top accent strip
    sl.addShape(pres.shapes.RECTANGLE, { x, y, w: 4.5, h: 0.07, fill: { color: ORANGE }, line: { color: ORANGE } });
    sl.addText(t.title, { x: x + 0.18, y: y + 0.12, w: 4.1, h: 0.3, fontSize: 13, fontFace: "Calibri", bold: true, color: ORANGE, margin: 0 });
    sl.addText(t.steps.map(s => s).join("\n"), {
      x: x + 0.18, y: y + 0.48, w: 4.1, h: 1.35,
      fontSize: 10, fontFace: "Calibri", color: MUTED, margin: 0,
      bullet: false
    });
    // Number bullets manually
    t.steps.forEach((s, si) => {
      sl.addShape(pres.shapes.OVAL, { x: x + 0.15, y: y + 0.5 + si * 0.35, w: 0.22, h: 0.22, fill: { color: ORANGE }, line: { color: ORANGE } });
      sl.addText(String(si + 1), { x: x + 0.15, y: y + 0.5 + si * 0.35, w: 0.22, h: 0.22, fontSize: 8, fontFace: "Calibri", bold: true, color: WHITE, align: "center", valign: "middle", margin: 0 });
      sl.addText(s, { x: x + 0.45, y: y + 0.49 + si * 0.35, w: 3.8, h: 0.28, fontSize: 10, fontFace: "Calibri", color: MUTED, margin: 0 });
    });
    // Remove the text block we placed (replace approach — just remove the addText for steps above)
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// SLIDE 10 — CLOSING / ACCESS
// ═══════════════════════════════════════════════════════════════════════════
{
  let sl = pres.addSlide();
  sl.background = { color: NAVY };

  sl.addShape(pres.shapes.RECTANGLE, { x: 0, y: 0, w: 10, h: 0.08, fill: { color: ORANGE }, line: { color: ORANGE } });
  for (let i = 0; i < 8; i++) {
    sl.addShape(pres.shapes.LINE, { x: 0, y: 0.7 + i * 0.7, w: 10, h: 0, line: { color: "1E3050", width: 0.5 } });
  }
  sl.addShape(pres.shapes.RECTANGLE, { x: 9.82, y: 0, w: 0.18, h: 5.625, fill: { color: ORANGE }, line: { color: ORANGE } });

  sl.addText("CIRCLE LOGISTICS", {
    x: 0.5, y: 0.55, w: 9, h: 0.35, fontSize: 10, fontFace: "Calibri", bold: true, color: ORANGE, charSpacing: 5, align: "center", margin: 0
  });

  sl.addText("One platform.\nEvery carrier.\nAlways current.", {
    x: 0.5, y: 1.1, w: 9, h: 2.2, fontSize: 54, fontFace: "Georgia", bold: true, color: WHITE, align: "center", margin: 0
  });

  sl.addText("Sign in now →", {
    x: 0.5, y: 3.55, w: 9, h: 0.5, fontSize: 18, fontFace: "Calibri", color: ORANGE, align: "center", margin: 0
  });

  sl.addText("carrierdatabasev2.netlify.app", {
    x: 0.5, y: 4.1, w: 9, h: 0.4, fontSize: 14, fontFace: "Calibri", color: TEAL, align: "center", margin: 0
  });

  sl.addText("Use your @circledelivers.com or @circlelogistics.com Google account", {
    x: 0.5, y: 4.58, w: 9, h: 0.3, fontSize: 10.5, fontFace: "Calibri", color: MUTED, align: "center", margin: 0
  });

  // Three feature pills at bottom
  const pillText = ["96 Carriers", "406 Live Loads", "Gmail Auto-Sync"];
  pillText.forEach((pt, i) => {
    const x = 2.8 + i * 1.7;
    sl.addShape(pres.shapes.RECTANGLE, { x, y: 5.08, w: 1.5, h: 0.32, fill: { color: "132030" }, line: { color: "253A55" } });
    sl.addText(pt, { x, y: 5.08, w: 1.5, h: 0.32, fontSize: 9, fontFace: "Calibri", bold: true, color: TEAL, align: "center", valign: "middle", margin: 0 });
  });
}

pres.writeFile({ fileName: OUT }).then(() => console.log("DONE: " + OUT));
