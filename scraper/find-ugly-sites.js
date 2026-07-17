#!/usr/bin/env node
/**
 * Ugly-Site Lead Finder  —  Website-Rebuild outreach (product line 2)
 * ============================================================================
 * Finds US trade businesses that ALREADY HAVE a website — but an outdated / ugly
 * one worth rebuilding — so they can be pitched a free rebuild demo.
 *
 * This is the INVERSE of the the outreach "no-website" scraper: there we KEEP
 * businesses with no site; here we KEEP businesses WITH a real site, then GRADE
 * that site's ugliness and keep only the rebuild-worthy ones (score < threshold).
 *
 * TWO STAGES, one pass:
 *   1. FIND   Google Places (New) Text Search → keep trade businesses that have
 *             a phone + a REAL website + are operational + pass quality filters.
 *   2. GRADE  Fetch each site's HTML and score its "ugliness" (0-100, LOWER = uglier)
 *             from free heuristics (HTTPS, mobile viewport, legacy markup, dead
 *             site, stale copyright…). Optional Google PageSpeed/Lighthouse pass
 *             (free, same key) for a stronger signal. Keep score < uglyThreshold.
 *
 * Cheapest viable stack: Google Places (free ~5k searches/mo) + raw HTML (free).
 * No paid screenshot/vision service required for v1.
 *
 * USAGE
 *   node find-ugly-sites.js                       # scrape+grade per config.local.json
 *   node find-ugly-sites.js --test                # verify the Google API key (1 call)
 *   node find-ugly-sites.js --grade https://x.com # grade ONE url (no Places quota) — great for testing
 *   node find-ugly-sites.js --lighthouse          # also run PageSpeed/Lighthouse per site
 *   node find-ugly-sites.js "Phoenix AZ" electrician plumber   # override area + niches
 *
 * config.local.json keys:
 *   googleApiKey   "AIza..."   (or env GOOGLE_API_KEY)
 *   city           "AZ"                 batch label / geo fallback
 *   areas          ["Phoenix AZ", ...]  niche × area (beats Google's 60-result cap)
 *   niches         ["electrician","HVAC","plumber", ...]
 *   perNiche       25                   candidates to grade per niche per area
 *   uglyThreshold  55                   keep leads scoring BELOW this (lower = uglier)
 *   minReviews/maxReviews, maxFetchPages, useLighthouse, excludeNames, excludeFiles, autoDedup
 */

'use strict';
const fs = require('fs');
const path = require('path');

// ─── Config ─────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, 'config.local.json');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (_) { /* optional */ }

const API_KEY = process.env.GOOGLE_API_KEY || cfg.googleApiKey || '';
const LANGUAGE = cfg.languageCode || 'en';
const PER_NICHE = cfg.perNiche || 25;
const MAX_FETCH_PAGES = cfg.maxFetchPages || 3;
const UGLY_THRESHOLD = cfg.uglyThreshold != null ? cfg.uglyThreshold : 55;
const MIN_REVIEWS = cfg.minReviews || 0;
const MAX_REVIEWS = cfg.maxReviews || 0;
const USE_LIGHTHOUSE = !!cfg.useLighthouse || process.argv.includes('--lighthouse');
const GRADE_CONCURRENCY = cfg.gradeConcurrency || 8;
// Optional AI-vision pass (OpenAI-compatible; default = Qwen3.5 on NVIDIA, swappable to Groq/Gemini/Ollama)
const USE_VISION = !!cfg.useVision || process.argv.includes('--vision');
const V = cfg.vision || {};
const V_BASE = (V.baseUrl || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
const V_MODEL = V.model || 'qwen/qwen3.5-397b-a17b';
const V_KEY = process.env.VISION_API_KEY || V.apiKey || '';
const V_W = V.shotWidth || 640, V_H = V.shotHeight || 820;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// Auto-dedup: unless excludeFiles is set, exclude phones from ALL prior leads-*.csv here.
const EXCLUDE_FILES = (cfg.excludeFiles && cfg.excludeFiles.length)
  ? cfg.excludeFiles
  : (cfg.autoDedup === false ? [] : fs.readdirSync(__dirname).filter(f => /^leads-.*\.csv$/i.test(f)));

const args = process.argv.slice(2);
const TEST_MODE = args.includes('--test');
const GRADE_IDX = args.indexOf('--grade');
const GRADE_URL = GRADE_IDX >= 0 ? args[GRADE_IDX + 1] : null;
const REGRADE_IDX = args.indexOf('--regrade');
const REGRADE_FILE = REGRADE_IDX >= 0 ? args[REGRADE_IDX + 1] : null;
const positional = args.filter((a, i) => !a.startsWith('--')
  && !(GRADE_IDX >= 0 && i === GRADE_IDX + 1)
  && !(REGRADE_IDX >= 0 && i === REGRADE_IDX + 1));
const CITY = positional[0] || cfg.city || '';
const NICHES = positional.length > 1 ? positional.slice(1) : (cfg.niches || []);
const AREAS = (cfg.areas && cfg.areas.length) ? cfg.areas : (CITY ? [CITY] : []);

// ─── CSV helpers ──────────────────────────────────────────────────────────────
function parseCSV(t) {
  const rows = []; let f = [], cur = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else {
      if (c === '"') q = true;
      else if (c === ',') { f.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; if (cur !== '' || f.length) { f.push(cur); rows.push(f); f = []; cur = ''; } }
      else cur += c;
    }
  }
  if (cur !== '' || f.length) { f.push(cur); rows.push(f); }
  return rows;
}
const csvCell = v => {
  let s = (v == null) ? '' : String(v);
  // CSV formula-injection guard: a spreadsheet treats a cell starting with = + - @
  // (or a leading tab/CR) as a formula. Scraped names/reasons are untrusted → neutralise.
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
const normPhone = raw => String(raw || '').replace(/\D/g, '').slice(-10);

function parseAddr(formatted) {
  const out = { city: '', state: '', zip: '' };
  const m = String(formatted || '').match(/,\s*([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5})/);
  if (m) { out.city = m[1].trim(); out.state = m[2]; out.zip = m[3]; }
  return out;
}
// Fallback geo from the search-area string ("Phoenix AZ 85001" → city/state/zip).
function areaMeta(area) {
  const s = String(area || '').trim();
  const zip = (s.match(/\b(\d{5})\b/) || [])[1] || '';
  const st = (s.toUpperCase().match(/\b([A-Z]{2})\b/) || [])[1] || '';
  let city = s;
  if (st) { const i = s.toUpperCase().lastIndexOf(' ' + st); if (i > 0) city = s.slice(0, i); }
  city = city.replace(/\b\d{5}\b.*$/, '').replace(/[, ]+$/, '').trim();
  return { city, state: st, zip };
}

function loadExclusion(files) {
  const seen = new Set();
  for (const file of files) {
    const fp = path.join(__dirname, file);
    if (!fs.existsSync(fp)) continue;
    for (const r of parseCSV(fs.readFileSync(fp, 'utf8')).slice(1)) {
      for (const cell of r) { const d = String(cell || '').replace(/\D/g, ''); if (d.length === 10 || d.length === 11) seen.add(d.slice(-10)); }
    }
    console.log(`   deduped against ${file}`);
  }
  return seen;
}

// ─── Website classification + off-target filter ───────────────────────────────
// A social/aggregator link is NOT a real website → that lead belongs to the
// no-website funnel (the outreach), not the rebuild funnel. We only want REAL sites.
const AGG = /business\.site|sites\.google|facebook\.com|fb\.com|instagram\.com|yelp\.com|thumbtack\.com|angi\.|angieslist|nextdoor\.com|booksy\.|linktr\.ee|linktree|calendly\.com|google\.com\/maps|wa\.me|t\.me/i;
function websiteStatus(url) {
  if (!url || !String(url).trim()) return 'None';
  return AGG.test(url) ? 'Aggregator' : 'Real site';
}
const DEFAULT_EXCLUDES = [
  'supply', 'supplies', 'wholesale', 'wholesaler', 'distributor', 'manufacturer', 'depot', 'warehouse',
  'home depot', "lowe's", 'lowes', 'menards', 'ace hardware', 'true value', 'harbor freight',
  'roto-rooter', 'roto rooter', 'mr. rooter', 'mr rooter', 'terminix', 'orkin', 'trugreen',
  'rescue rooter', 'benjamin franklin plumbing', 'one hour heating', 'aire serv', 'servpro', 'rental',
];
const EXCLUDE_NAMES = DEFAULT_EXCLUDES.concat(cfg.excludeNames || []).map(s => String(s).toLowerCase());
function isExcludedName(p) {
  const hay = (((p.displayName && p.displayName.text) || '') + ' ' + ((p.primaryTypeDisplayName && p.primaryTypeDisplayName.text) || '')).toLowerCase();
  return EXCLUDE_NAMES.some(k => hay.includes(k));
}

// Stage-1 finder: keep operational trade businesses that HAVE a real website + phone.
function isCandidate(p) {
  if (!String(p.nationalPhoneNumber || p.internationalPhoneNumber || '').trim()) return false;
  if (p.businessStatus && p.businessStatus !== 'OPERATIONAL') return false;
  if ((p.userRatingCount || 0) < MIN_REVIEWS) return false;
  if (MAX_REVIEWS && (p.userRatingCount || 0) > MAX_REVIEWS) return false;
  if (isExcludedName(p)) return false;
  return websiteStatus(p.websiteUri) === 'Real site';   // ← MUST have a real site (the flip)
}

// ─── Channel gate (the outreach TARGETING.md; updated 2026-07-09 per deep-research on
//     2026 state SMS / mini-TCPA law — see outreach/target-markets-research.md) ────
// MI dropped from TEXT_OK → AVOID: SB 351 "Super TCPA" ($25k/violation, texts in
//   scope) passed the MI Senate 37-0 and sits in the House (Feb 2026).
const TEXT_OK_STATES = ['NC','LA','TN','NM','AL','KY','OH','MS','AR','AZ','MO','GA','KS','ID','WI','WV','MN','MT','WY','IA','NE','SD','ND'];
const CALL_FIRST_STATES = ['IN','PA','SC','NV','UT','CO','VA'];
const AVOID_STATES = ['OK','FL','TX','WA','MD','CA','IL','MI'];
// TEXT_OK but with a caveat to apply BEFORE sending:
const DNC_SCRUB_STATES = ['AZ'];    // HB 2498 (in force): scrub National DNC + honor STOP, or don't text listed numbers
const MONITOR_LAW_STATES = ['TN'];  // SB 868 SMS applicability unresolved — recheck before scaling
function stateCode(s) { const m = String(s || '').toUpperCase().match(/\b([A-Z]{2})\b/); return m ? m[1] : String(s || '').toUpperCase().trim(); }
function leadChannel(st) {
  const s = stateCode(st);
  if (TEXT_OK_STATES.includes(s)) return 'TEXT';
  if (CALL_FIRST_STATES.includes(s) || AVOID_STATES.includes(s)) return 'CALL-ONLY';
  return 'REVIEW';
}
// Compliance caveat for the operator (e.g. 'DNC-SCRUB', 'MONITOR-LAW'); '' when none.
function leadComplianceFlag(st) {
  const s = stateCode(st);
  if (DNC_SCRUB_STATES.includes(s)) return 'DNC-SCRUB';
  if (MONITOR_LAW_STATES.includes(s)) return 'MONITOR-LAW';
  return '';
}

// ─── Google Places (New) — Text Search ────────────────────────────────────────
let apiCalls = 0;
const SATURATED = [];
const FIELD_MASK = [
  'places.id', 'places.displayName', 'places.formattedAddress',
  'places.nationalPhoneNumber', 'places.internationalPhoneNumber',
  'places.websiteUri', 'places.rating', 'places.userRatingCount', 'places.businessStatus',
  'places.primaryTypeDisplayName', 'places.googleMapsUri', 'nextPageToken',
].join(',');

async function placesTextSearch(textQuery, pageToken) {
  apiCalls++;
  const body = { textQuery, languageCode: LANGUAGE, maxResultCount: 20 };
  if (pageToken) body.pageToken = pageToken;
  let lastErr;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch('https://places.googleapis.com/v1/places:searchText', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': API_KEY, 'X-Goog-FieldMask': FIELD_MASK },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json; try { json = JSON.parse(text); } catch (_) { json = {}; }
      if (!res.ok) throw new Error('Places API ' + res.status + ': ' + ((json.error && json.error.message) || text));
      return json;
    } catch (e) {
      lastErr = e;
      // Retry network-level failures (brief internet drop); a Places 4xx won't fix itself.
      if (attempt < 3 && /fetch failed|network|timeout|aborted|ECONN|ETIMEDOUT|socket|EAI_AGAIN/i.test(e.message)) {
        await new Promise(r => setTimeout(r, 2000 * attempt));
      } else break;
    }
  }
  throw lastErr;
}

async function searchNiche(niche, area, seenPhones) {
  const query = area ? `${niche} in ${area}` : niche;
  const kept = [];
  let pageToken = null, page = 0;
  do {
    const data = await placesTextSearch(query, pageToken);
    for (const p of (data.places || [])) {
      if (!isCandidate(p)) continue;
      const key = normPhone(p.nationalPhoneNumber || p.internationalPhoneNumber);
      if (!key || seenPhones.has(key)) continue;
      const dup = kept.find(k => normPhone(k.nationalPhoneNumber || k.internationalPhoneNumber) === key);
      if (dup) { if ((p.userRatingCount || 0) > (dup.userRatingCount || 0)) Object.assign(dup, p); continue; }
      kept.push({ ...p, _niche: niche, _area: area });
    }
    pageToken = data.nextPageToken || null;
    page++;
    if (pageToken && page < MAX_FETCH_PAGES) await new Promise(r => setTimeout(r, 1500));
  } while (pageToken && page < MAX_FETCH_PAGES && kept.length < PER_NICHE * 3);
  if (pageToken || kept.length > PER_NICHE) SATURATED.push({ area, niche, found: kept.length, morePages: !!pageToken });
  kept.sort((a, b) => (b.userRatingCount || 0) - (a.userRatingCount || 0));
  return kept.slice(0, PER_NICHE);
}

// ─── Stage 2: the UGLINESS GRADER ─────────────────────────────────────────────
// Score starts at 100 (assume modern) and loses points for each ugly signal.
// LOWER score = uglier = better rebuild target. Keep leads scoring < uglyThreshold.
// SSRF guard — refuse internal/loopback/link-local/metadata targets. Business site
// URLs come from Google, but a listing could point somewhere internal; deny by default.
function isBlockedHost(urlStr) {
  let h;
  try { h = new URL(urlStr).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch (_) { return true; }
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;   // IPv6 loopback/link-local/ULA
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true;
  }
  return false;
}

// Read at most maxBytes of the body so a giant/hostile page can't exhaust memory.
async function readCapped(res, maxBytes = 600000) {
  if (!res.body || !res.body.getReader) { const t = await res.text().catch(() => ''); return t.slice(0, maxBytes); }
  const reader = res.body.getReader(), dec = new TextDecoder('utf-8', { fatal: false });
  let received = 0, out = '';
  try {
    while (received < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.length;
      out += dec.decode(value, { stream: true });
    }
  } catch (_) { /* partial body is fine for scoring */ } finally { try { await reader.cancel(); } catch (_) {} }
  return out;
}

async function fetchSite(url, timeoutMs = 9000) {
  if (isBlockedHost(url)) return { ok: false, status: 0, finalUrl: url, html: '', error: 'blocked host (private/loopback/metadata)' };
  let lastErr = 'no response';
  // Retry transient network failures (up to 3x) so a brief internet blip doesn't
  // mislabel a live site as dead. A real 4xx/5xx returns immediately (not retried here).
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA } });
      const html = await readCapped(res);
      clearTimeout(t);
      return { ok: res.ok, status: res.status, finalUrl: res.url || url, html };
    } catch (e) {
      clearTimeout(t);
      lastErr = e.message;
      if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt));
    }
  }
  return { ok: false, status: 0, finalUrl: url, html: '', error: lastErr };
}

function scoreHtml(r) {
  const reasons = [];
  let score = 100;
  const pen = (n, why) => { score -= n; reasons.push(why); };

  const html = r.html || '';

  if (!/^https:/i.test(r.finalUrl)) pen(25, 'no HTTPS (insecure)');
  if (!/<meta[^>]+name=["']?viewport/i.test(html)) pen(25, 'not mobile-friendly (no viewport)');
  if (/<frameset|<frame\b/i.test(html)) pen(20, 'frames-based layout');
  if (/<marquee|<blink/i.test(html)) pen(15, 'marquee/blink animation');
  if (/\.swf\b|shockwave-flash|x-shockwave/i.test(html)) pen(15, 'Flash content');
  if (/<font\b/i.test(html)) pen(12, '1990s <font> tags');
  if (/<center\b/i.test(html)) pen(6, '<center> tags (dated markup)');

  const tableCount = (html.match(/<table\b/gi) || []).length;
  const hasSemantic = /<(section|article|header|footer|nav|main)\b/i.test(html);
  if (tableCount >= 3 && !hasSemantic) pen(15, 'table-based layout');

  if (/font-family\s*:\s*[^;"'}]*(times new roman|comic sans)/i.test(html)) pen(8, 'dated fonts (Times/Comic Sans)');

  const jqm = html.match(/jquery[-.]?(\d+)\.(\d+)/i);
  if (jqm && +jqm[1] < 3) pen(6, `old jQuery (${jqm[1]}.${jqm[2]})`);
  if (/document\.write\s*\(/i.test(html)) pen(5, 'legacy document.write');

  if (!/@media|display\s*:\s*(flex|grid)|max-width\s*:/i.test(html) && !/<meta[^>]+name=["']?viewport/i.test(html))
    pen(10, 'no responsive CSS');

  const years = (html.match(/(?:©|&copy;|copyright)[\s\S]{0,25}?((?:19|20)\d{2})/gi) || [])
    .map(s => +((s.match(/((?:19|20)\d{2})/) || [])[1])).filter(Boolean);
  if (years.length) {
    const newest = Math.max(...years), cur = new Date().getFullYear();
    if (newest <= cur - 4) pen(10, `stale copyright (${newest})`);
  }
  if (!/charset/i.test(html)) pen(3, 'no charset declared');
  if (html.length < 1500) pen(6, 'very thin / placeholder page');

  return { score: Math.max(0, Math.min(100, score)), reasons };
}

// Classify a fetch outcome. Only 'graded' sites get a real ugliness score; the rest
// (anti-bot blocks, dead, errors) can't be judged server-side → sent to manual review,
// NEVER auto-labelled ugly (a Cloudflare 403 is usually a MODERN site protecting itself).
const CHALLENGE_RE = /just a moment|checking your browser|cf-browser-verification|enable javascript and cookies|attention required|access denied/i;
function classifyFetch(r) {
  if (r.error) return 'unreachable';
  const s = r.status;
  if (s === 401 || s === 403 || s === 429 || s === 503) return 'blocked';
  if (s === 404 || s === 410) return 'missing';
  if (s >= 500) return 'error';
  if (s >= 200 && s < 400 && r.html) {
    if (CHALLENGE_RE.test(r.html.slice(0, 4000))) return 'blocked';
    return 'graded';
  }
  return 'error';
}

// Optional PageSpeed/Lighthouse (mobile) — free with the Google key. Blends in.
async function pagespeed(url) {
  const api = 'https://www.googleapis.com/pagespeedonline/v5/runPagespeed'
    + `?url=${encodeURIComponent(url)}&strategy=mobile`
    + '&category=performance&category=best-practices&category=seo'
    + `&key=${API_KEY}`;
  const res = await fetch(api);
  if (!res.ok) throw new Error('PSI HTTP ' + res.status);
  const cats = ((await res.json()).lighthouseResult || {}).categories || {};
  const g = c => (cats[c] && typeof cats[c].score === 'number') ? Math.round(cats[c].score * 100) : null;
  return { performance: g('performance'), bestPractices: g('best-practices'), seo: g('seo') };
}

async function gradeLead(p) {
  const r = await fetchSite(p.websiteUri);
  const outcome = classifyFetch(r);
  p._status = outcome;
  if (outcome !== 'graded') {
    p._score = null;
    p._reasons = [{
      blocked: `anti-bot / blocked (HTTP ${r.status || '—'}) — open in a browser to judge`,
      missing: `page not found (HTTP ${r.status}) — dead or stale listing URL`,
      error: `server error (HTTP ${r.status || '—'}) — may be down`,
      unreachable: `unreachable (${r.error || 'no response'}) — may be dead or blocking`,
    }[outcome]];
    return p;
  }
  const g = scoreHtml(r);
  p._score = g.score; p._reasons = g.reasons;
  if (USE_LIGHTHOUSE) {
    try {
      const lh = await pagespeed(r.finalUrl || p.websiteUri);
      p._lh = lh;
      if (lh.performance != null && lh.performance < 50) { p._score -= 8; p._reasons.push(`slow (perf ${lh.performance})`); }
      if (lh.bestPractices != null && lh.bestPractices < 70) { p._score -= 6; p._reasons.push(`weak best-practices (${lh.bestPractices})`); }
      if (lh.seo != null && lh.seo < 70) { p._score -= 6; p._reasons.push(`poor SEO (${lh.seo})`); }
      p._score = Math.max(0, Math.min(100, p._score));
    } catch (_) { /* PSI is best-effort */ }
  }
  return p;
}

// Bounded-concurrency map so we grade many sites at once without hammering.
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0, done = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); if (++done % 20 === 0) process.stdout.write(`   graded ${done}/${items.length}\r`); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}

// ─── Optional vision pass (provider-agnostic, OpenAI-compatible) ───────────────
// Runs ONLY on rebuild-worthy leads. Screenshots the site (free, no key, WordPress
// mShots) → a vision model judges the LOOK. Catches "old-code but visually-redesigned"
// false positives AND adds human, pitch-ready reasons ("dated serif fonts, clip-art").
async function visionShot(url) {
  const api = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=${V_W}&h=${V_H}`;
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(api, { headers: { 'User-Agent': UA } });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 12000) return 'data:image/jpeg;base64,' + buf.toString('base64');  // else = "generating" placeholder
    } catch (_) { /* retry */ }
    await new Promise(res => setTimeout(res, 4000));
  }
  return null;
}
const V_PROMPT = 'You are a strict website design critic. Look at this screenshot of a small-business website and return ONLY a compact JSON object (no markdown, no prose): {"outdated": true|false, "era_guess": "1998"|"2005"|"2012"|"modern", "reasons": ["2-5 very short reasons"]}. Judge it OUTDATED if it looks like: no mobile layout, tiny/dense text, cluttered navigation, dated fonts/colors, boxy table-like layout, clip-art, low-quality images, or a generic 2000s template.';
async function visionJudge(dataUri) {
  const body = JSON.stringify({
    model: V_MODEL,
    messages: [{ role: 'user', content: [{ type: 'text', text: V_PROMPT }, { type: 'image_url', image_url: { url: dataUri } }] }],
    max_tokens: 300, temperature: 0,
  });
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(V_BASE + '/chat/completions', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + V_KEY, 'Content-Type': 'application/json' }, body,
      });
      const txt = await r.text();
      if (!r.ok) throw new Error('vision HTTP ' + r.status);
      let c = (JSON.parse(txt).choices[0].message.content || '').replace(/```json|```/gi, '').trim();
      const m = c.match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('no JSON in reply');
    } catch (_) { await new Promise(res => setTimeout(res, 2000 * a)); }
  }
  return null;
}
async function visionOne(url) {
  const shot = await visionShot(url);
  if (!shot) return { error: 'no screenshot' };
  return (await visionJudge(shot)) || { error: 'no verdict' };
}
async function visionPass(leads) {
  if (!V_KEY) { console.log('\n👁  useVision is on but vision.apiKey is empty — skipped.'); return; }
  console.log(`\n👁  Vision check on ${leads.length} rebuild-worthy lead(s) via ${V_MODEL} ...`);
  let done = 0;
  for (const p of leads) {                       // sequential = respects free-tier rate limits (the ugly set is small)
    p._vision = await visionOne(p.websiteUri);
    process.stdout.write(`   ${++done}/${leads.length}\r`);
  }
  console.log('');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function batchTag() {
  const iso = new Date().toISOString();
  const place = (CITY || 'all').replace(/[^A-Za-z0-9]+/g, '-');
  return `${place}-Ugly-${iso.split('T')[0]}-${iso.split('T')[1].slice(0, 5).replace(':', '')}`;
}

// Map a vision verdict → 0-100 "visual age" (LOWER = older/cheaper-LOOKING). This is what
// we RANK by, because how a site looks matches the human eye far better than its code flags.
function visionScore(p) {
  const v = p._vision;
  if (!v || v.error) return null;               // no vision verdict → fall back to the HTML score
  if (v.outdated === false) return 100;         // vision says it looks modern → rank last (recheck before pitching)
  const era = { '1998': 5, '2005': 25, '2012': 50, 'modern': 100 };
  return era[v.era_guess] != null ? era[v.era_guess] : 40;   // outdated, unknown era
}
// Combined rank (LOWER = worse-looking = pitch first): vision leads, HTML is the fallback.
function rankScore(p) {
  const vs = visionScore(p);
  return vs != null ? vs : (p._score == null ? 999 : p._score);
}

// Bucket graded candidates → write leads CSV (ugly) + REVIEW CSV, run vision, print summary.
// Shared by the normal scrape and the --regrade salvage path.
async function finalize(candidates) {
  const graded = candidates.filter(p => p._status === 'graded');
  const ugly = graded.filter(p => p._score < UGLY_THRESHOLD);
  const modern = graded.filter(p => p._score >= UGLY_THRESHOLD);
  const review = candidates.filter(p => p._status !== 'graded');

  if (USE_VISION && ugly.length) await visionPass(ugly);

  // Rank by what the site LOOKS like (vision era), not just its code (HTML). Vision matches
  // the eye far better; the HTML score is the tiebreaker / fallback when vision is off or failed.
  ugly.sort((a, b) => (rankScore(a) - rankScore(b)) || ((a._score == null ? 999 : a._score) - (b._score == null ? 999 : b._score)));

  const tag = batchTag(), today = new Date().toISOString().split('T')[0];
  const rec = p => {
    const a = parseAddr(p.formattedAddress), m = areaMeta(p._area);
    const state = a.state || m.state;
    return {
      'Lead Name': (p.displayName && p.displayName.text) || '',
      'Phone': p.nationalPhoneNumber || p.internationalPhoneNumber || '',
      'Address': p.formattedAddress || '', 'City': a.city || m.city, 'State': state, 'ZIP': a.zip || m.zip,
      'Niche': p._niche,
      'Website URL': p.websiteUri || '',
      'Ugly Score': p._score == null ? '' : p._score,
      'Rank Score': rankScore(p),
      'Ugly Reasons': (p._reasons || []).join('; '),
      'Grade Status': p._status,
      'Vision Verdict': p._vision ? (p._vision.error ? p._vision.error : (p._vision.outdated ? 'outdated' : 'MODERN — recheck')) : '',
      'Vision Era': (p._vision && p._vision.era_guess) || '',
      'Vision Reasons': (p._vision && Array.isArray(p._vision.reasons)) ? p._vision.reasons.join('; ') : '',
      'LH Perf': p._lh ? p._lh.performance : '', 'LH BestPractices': p._lh ? p._lh.bestPractices : '', 'LH SEO': p._lh ? p._lh.seo : '',
      'Google Rating': p.rating || '', 'Google Reviews': p.userRatingCount || 0,
      'place_id': p.id || '', 'Maps URL': p.googleMapsUri || '',
      'Channel': leadChannel(state), 'Compliance Flag': leadComplianceFlag(state), 'Scrape Batch': tag, 'Date Scraped': today,
    };
  };
  const headers = ['Lead Name','Phone','Address','City','State','ZIP','Niche','Website URL','Ugly Score','Rank Score','Ugly Reasons','Grade Status','Vision Verdict','Vision Era','Vision Reasons','LH Perf','LH BestPractices','LH SEO','Google Rating','Google Reviews','place_id','Maps URL','Channel','Compliance Flag','Scrape Batch','Date Scraped'];
  const toCsv = rows => [headers.map(csvCell).join(',')].concat(rows.map(r => headers.map(h => csvCell(r[h])).join(','))).join('\n');

  const outFile = path.join(__dirname, `leads-${tag}.csv`);
  fs.writeFileSync(outFile, toCsv(ugly.map(rec)), 'utf8');
  // Modern (score >= threshold) are NOT a rebuild fit — but instead of discarding them,
  // save them so they can be loaded into the `review_website` Convex DB (→ /review-import).
  let modernFile = '';
  if (modern.length) { modernFile = path.join(__dirname, `leads-${tag}-MODERN.csv`); fs.writeFileSync(modernFile, toCsv(modern.map(rec)), 'utf8'); }
  let reviewFile = '';
  if (review.length) { reviewFile = path.join(__dirname, `leads-${tag}-REVIEW.csv`); fs.writeFileSync(reviewFile, toCsv(review.map(rec)), 'utf8'); }

  console.log('\n────────────── SUMMARY ──────────────');
  console.log(`  Websites processed:   ${candidates.length}`);
  console.log(`  Successfully graded:  ${graded.length}`);
  console.log(`  ✅ Rebuild-worthy:    ${ugly.length}  (loaded & score < ${UGLY_THRESHOLD})  → ${path.basename(outFile)}`);
  console.log(`  🌐 Modern (→ review): ${modern.length}${modernFile ? `  → ${path.basename(modernFile)}` : ''}`);
  console.log(`  🔎 Needs review:      ${review.length}  (blocked/dead/anti-bot — check by hand)${reviewFile ? `  → ${path.basename(reviewFile)}` : ''}`);
  console.log(`  Google searches used: ${apiCalls}`);
  console.log('─────────────────────────────────────');
  if (SATURATED.length) console.log(`\n⚠️  ${SATURATED.length} niche×area queries maxed out — split those areas finer for more leads.`);
  if (ugly.length) {
    console.log('\nUgliest leads (ranked by vision — worst-LOOKING first):');
    ugly.slice(0, 15).forEach((p, i) => {
      const era = (p._vision && !p._vision.error) ? p._vision.era_guess : '—';
      console.log(`  ${String(i + 1).padStart(2)}. [${p._niche}] ${(p.displayName && p.displayName.text) || ''} | rank ${rankScore(p)} (html ${p._score}, looks ${era}) | ${p.websiteUri}`);
    });
  }
}

// Rebuild lead objects from a prior leads-*.csv so their sites can be re-graded
// (used by --regrade to salvage a run whose grading failed on a network drop).
function csvToCandidates(file) {
  const rows = parseCSV(fs.readFileSync(file, 'utf8'));
  const hdr = rows[0], idx = {}; hdr.forEach((h, i) => idx[h] = i);
  const g = (r, name) => (idx[name] != null ? r[idx[name]] : '') || '';
  return rows.slice(1).filter(r => r.length > 1).map(r => ({
    websiteUri: g(r, 'Website URL'),
    _niche: g(r, 'Niche'),
    _area: `${g(r, 'City')} ${g(r, 'State')} ${g(r, 'ZIP')}`.trim(),
    displayName: { text: g(r, 'Lead Name') },
    nationalPhoneNumber: g(r, 'Phone'),
    formattedAddress: g(r, 'Address'),
    id: g(r, 'place_id'),
    googleMapsUri: g(r, 'Maps URL'),
    rating: g(r, 'Google Rating'),
    userRatingCount: Number(g(r, 'Google Reviews')) || 0,
  })).filter(p => p.websiteUri);
}

async function main() {
  if (!API_KEY) { console.error('❌ No API key (config.local.json "googleApiKey" or env GOOGLE_API_KEY).'); process.exitCode = 1; return; }

  // Re-grade an existing leads CSV (salvage a run that failed grading, no Places quota).
  if (REGRADE_FILE) {
    const fp = path.isAbsolute(REGRADE_FILE) ? REGRADE_FILE : path.join(__dirname, REGRADE_FILE);
    if (!fs.existsSync(fp)) { console.error('❌ Not found: ' + REGRADE_FILE); process.exitCode = 1; return; }
    const candidates = csvToCandidates(fp);
    console.log(`\n♻️  Re-grading ${candidates.length} businesses from ${path.basename(fp)} (no Places quota) ...`);
    await mapLimit(candidates, USE_LIGHTHOUSE ? 4 : GRADE_CONCURRENCY, gradeLead);
    process.stdout.write('\n');
    await finalize(candidates);
    return;
  }

  if (TEST_MODE) {
    console.log('🔌 Testing Google Places API key...');
    try { const d = await placesTextSearch('coffee shop in New York', null); console.log(`✅ Key works — returned ${(d.places || []).length} place(s).`); return; }
    catch (e) { console.error('❌ API test failed:', e.message); process.exitCode = 1; return; }
  }

  // Single-URL grader — test the ugliness scoring with no Places quota spend.
  if (GRADE_URL) {
    console.log(`🔎 Grading ${GRADE_URL}${USE_LIGHTHOUSE ? ' (+Lighthouse)' : ''} ...`);
    const p = { websiteUri: GRADE_URL };
    await gradeLead(p);
    if (p._status !== 'graded') {
      console.log(`\n   🔎 NEEDS REVIEW (${p._status}) — could not grade: ${(p._reasons || []).join(', ')}`);
    } else {
      const verdict = p._score < UGLY_THRESHOLD ? '✅ REBUILD-WORTHY' : '❌ too modern, skip';
      console.log(`\n   Ugly score: ${p._score}/100   (lower = uglier; keep < ${UGLY_THRESHOLD} → ${verdict})`);
      console.log(`   Reasons: ${p._reasons.length ? p._reasons.join(', ') : '(none — looks modern)'}`);
      if (p._lh) console.log(`   Lighthouse (mobile): perf ${p._lh.performance} · best-practices ${p._lh.bestPractices} · seo ${p._lh.seo}`);
    }
    if (USE_VISION) {
      process.stdout.write('   👁  vision ... ');
      const v = await visionOne(GRADE_URL);
      console.log(v.error ? `(${v.error})` : `${v.outdated ? 'OUTDATED' : 'MODERN'} · ${v.era_guess} · ${(v.reasons || []).join(', ')}`);
    }
    return;
  }

  if (!CITY || NICHES.length === 0) { console.error('❌ Need a city/area and at least one niche (config.local.json or CLI args).'); process.exitCode = 1; return; }

  console.log(`\n🔎 Area(s): ${AREAS.length} (${AREAS.join(', ')})`);
  console.log(`🔎 Niches:  ${NICHES.length} (${NICHES.join(', ')})  ·  ${PER_NICHE}/niche/area`);
  console.log(`🔎 Ugly threshold: keep score < ${UGLY_THRESHOLD}  ·  Lighthouse: ${USE_LIGHTHOUSE ? 'ON' : 'off'}\n`);
  const seenPhones = loadExclusion(EXCLUDE_FILES);
  if (seenPhones.size) console.log(`   → ${seenPhones.size} known phones will be skipped\n`);

  // Stage 1 — FIND candidates with a real website
  const candidates = [];
  for (const area of AREAS) {
    console.log(`📍 ${area}`);
    for (const niche of NICHES) {
      process.stdout.write(`  • ${niche} ... `);
      try {
        const found = await searchNiche(niche, area, seenPhones);
        for (const l of found) { seenPhones.add(normPhone(l.nationalPhoneNumber || l.internationalPhoneNumber)); candidates.push(l); }
        console.log(`${found.length} with a website`);
      } catch (e) { console.log(`ERROR: ${e.message}`); }
    }
  }
  console.log(`\n🧮 Stage 1: ${candidates.length} businesses WITH a real website.`);
  if (!candidates.length) { console.log('Nothing to grade — done.'); return; }

  // Stage 2 — GRADE their websites
  console.log(`🎨 Stage 2: grading ${candidates.length} sites${USE_LIGHTHOUSE ? ' (+Lighthouse, slower)' : ''} ...`);
  await mapLimit(candidates, USE_LIGHTHOUSE ? 4 : GRADE_CONCURRENCY, gradeLead);
  process.stdout.write('\n');

  await finalize(candidates);
}

main().catch(e => { console.error('Fatal:', e.message); process.exitCode = 1; });
