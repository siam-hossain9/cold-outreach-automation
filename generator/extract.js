'use strict';
/**
 * extract.js — pull structured business content out of a scraped "old site" HTML.
 * ============================================================================
 * Part of generator/ (Ugly-Website Rebuild — the outreach system).
 *
 * build-demo.js fetches the lead's current (ugly) website, then hands the raw
 * HTML here. We mine it with regex/DOM-ish heuristics for everything the demo
 * needs — business name, services[], phone, hours, address, emails,
 * testimonials[], primary/accent colors, logo_url, tagline, about — and return
 * a plain object. build-demo.js then merges this over the lead CSV fields and
 * niche defaults to compose site.config.json (per templates/_shared/site.config.schema.json).
 *
 * HARD CASES: when the cheap heuristics come up empty (no name, no brand color,
 * no logo) an OPTIONAL vision pass can be triggered — it screenshots the site
 * with WordPress mShots (free, no key) and asks an OpenAI-compatible vision model
 * (VISION_* env, same pattern as scraper/find-ugly-sites.js) to read the brand.
 * Vision only FILLS GAPS; heuristics always win when present.
 *
 * Nothing here fetches the lead page itself except the small standalone CLI at
 * the bottom (so you can test extraction on a URL without the rest of the pipeline).
 *
 * Usage as a module:
 *   const { extract, extractFromHtml } = require('./extract');
 *   const data = extractFromHtml(html, { url, niche });           // sync, heuristics only
 *   const data = await extract(html, { url, niche, useVision:true, env });  // + vision gap-fill
 *
 * Standalone (fetch + extract + print JSON):
 *   node extract.js https://example-plumber.com
 *   node extract.js https://example-plumber.com --vision
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';

// ─── Small HTML helpers ───────────────────────────────────────────────────────
function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;|&#x27;/gi, "'")
    .replace(/&nbsp;/gi, ' ').replace(/&mdash;/gi, '—').replace(/&ndash;/gi, '–')
    .replace(/&#(\d+);/g, (_, d) => { try { return String.fromCodePoint(+d); } catch (_) { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch (_) { return ''; } });
}
const stripTags = s => decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const clean = s => decodeEntities(String(s || '')).replace(/\s+/g, ' ').trim();

// Remove <script>/<style>/<noscript>/comments so text-mining doesn't read code.
function visibleHtml(html) {
  return String(html || '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');
}

// Grab a <meta> content by name/property (case-insensitive, attr order agnostic).
function meta(html, key) {
  const re = new RegExp(
    '<meta[^>]+(?:name|property|itemprop)\\s*=\\s*["\']' + key.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') +
    '["\'][^>]*>', 'i');
  const tag = (html.match(re) || [])[0];
  if (!tag) return '';
  const c = tag.match(/content\s*=\s*["']([^"']*)["']/i);
  return c ? clean(c[1]) : '';
}

// Resolve a possibly-relative URL against the page's final URL.
function absolutize(href, base) {
  if (!href) return '';
  href = clean(href);
  if (/^data:|^javascript:|^mailto:|^tel:/i.test(href)) return href;
  try { return new URL(href, base).href; } catch (_) { return href; }
}

// ─── Niche knowledge — service keyword dictionaries + fallback content ─────────
// Used to (a) mine likely services out of body text and (b) provide sensible
// defaults when a site is too thin to scrape (dead/placeholder pages are common
// in the ugly-site set). Keys are the 3 canonical template niches.
const NICHE_SERVICE_KEYWORDS = {
  electrician: [
    'panel upgrade', 'panel upgrades', 'electrical panel', 'wiring', 'rewiring', 'ev charger', 'ev charging',
    'lighting', 'lighting installation', 'ceiling fan', 'ceiling fans', 'generator', 'generators', 'surge protection',
    'outlet', 'outlets', 'circuit breaker', 'breaker', 'electrical repair', 'electrical inspection', 'inspections',
    'landscape lighting', 'recessed lighting', 'gfci', 'troubleshooting', 'commercial electrical', 'residential electrical',
  ],
  hvac: [
    'air conditioning', 'ac repair', 'ac installation', 'heating', 'furnace repair', 'furnace installation',
    'heat pump', 'heat pumps', 'ductless', 'mini split', 'mini-split', 'duct cleaning', 'ductwork', 'thermostat',
    'indoor air quality', 'maintenance', 'tune-up', 'tune up', 'boiler', 'ventilation', 'refrigeration',
    'emergency hvac', 'ac tune-up', 'seasonal maintenance', 'commercial hvac', 'residential hvac',
  ],
  plumber: [
    'drain cleaning', 'drain', 'water heater', 'water heaters', 'tankless', 'leak detection', 'leak repair',
    'repiping', 'sewer', 'sewer line', 'sewer repair', 'garbage disposal', 'faucet', 'faucets', 'toilet',
    'toilets', 'sump pump', 'gas line', 'gas lines', 'backflow', 'hydro jetting', 'pipe repair', 'water filtration',
    'emergency plumbing', 'fixture installation', 'commercial plumbing', 'residential plumbing',
  ],
};

// Neutral trade defaults for niches outside the core 3 (roofing, contractor, …).
const GENERIC_SERVICES = ['Free Estimates', 'Repairs & Installation', 'Emergency Service', 'Maintenance', 'Inspections', 'Commercial & Residential'];

function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b([a-z])/g, (m, c) => c.toUpperCase())
    .replace(/\bAc\b/g, 'AC').replace(/\bHvac\b/g, 'HVAC').replace(/\bEv\b/g, 'EV').replace(/\bGfci\b/g, 'GFCI');
}

// ─── Business name ─────────────────────────────────────────────────────────────
const NAME_NOISE = /\b(home|welcome|homepage|official site|official website|index|untitled|new page \d+)\b/i;
function junkNamePart(s) {
  return !s || NAME_NOISE.test(s) || s.length < 2 || s.length > 80;
}
function extractName(html, visible) {
  // 1) og:site_name / application-name — usually the cleanest brand string.
  let n = meta(html, 'og:site_name') || meta(html, 'application-name');
  if (n && !junkNamePart(n)) return n;

  // 2) <title>, minus common " | Home", " - Welcome", trailing taglines.
  const t = clean((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
  if (t) {
    // Split on separators and keep the segment that looks most like a brand name.
    const parts = t.split(/\s*[|–—\-»›:]\s*/).map(clean).filter(Boolean);
    const cand = parts.find(p => !junkNamePart(p)) || parts[0];
    if (cand && !junkNamePart(cand)) return cand;
  }

  // 3) Logo <img alt="...">.
  const logoAlt = (visible.match(/<img[^>]+(?:class|id|src|alt)\s*=\s*["'][^"']*logo[^"']*["'][^>]*>/i) || [])[0];
  if (logoAlt) { const a = logoAlt.match(/alt\s*=\s*["']([^"']+)["']/i); if (a && !junkNamePart(clean(a[1]))) return clean(a[1]); }

  // 4) First <h1>.
  const h1 = clean(stripTags((visible.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || ''));
  if (h1 && !junkNamePart(h1) && h1.length <= 60) return h1;

  return '';
}

// ─── Phone ─────────────────────────────────────────────────────────────────────
const PHONE_RE = /(?:\+?1[\s.-]?)?\(?([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-]?(\d{4})(?!\d)/g;
function fmtPhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').slice(-10);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : clean(raw);
}
function extractPhone(html, visible) {
  // Prefer an explicit tel: link — it is the number the business wants dialed.
  const tel = (html.match(/href\s*=\s*["']tel:([^"']+)["']/i) || [])[1];
  if (tel && String(tel).replace(/\D/g, '').length >= 10) return fmtPhone(tel);
  const m = visible.match(PHONE_RE);
  return m ? fmtPhone(m[0]) : '';
}

// ─── Emails ────────────────────────────────────────────────────────────────────
const EMAIL_JUNK = /(example\.|sentry\.|wixpress\.|\.png|\.jpg|\.gif|\.webp|godaddy|domain|yourdomain|email@|@2x|core-js|schema\.org)/i;
function extractEmails(html) {
  const set = new Set();
  for (const m of html.matchAll(/href\s*=\s*["']mailto:([^"'?]+)/gi)) set.add(clean(m[1]).toLowerCase());
  for (const m of html.matchAll(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g)) set.add(clean(m[0]).toLowerCase());
  return [...set].filter(e => /@/.test(e) && !EMAIL_JUNK.test(e) && e.length <= 60).slice(0, 4);
}

// ─── Address (+ city/state/zip) ────────────────────────────────────────────────
function extractAddress(html, visible) {
  // JSON-LD PostalAddress is the most reliable when present.
  const ld = html.match(/"streetAddress"\s*:\s*"([^"]+)"[\s\S]{0,200}?("addressLocality"\s*:\s*"([^"]+)")?[\s\S]{0,120}?("addressRegion"\s*:\s*"([^"]+)")?[\s\S]{0,120}?("postalCode"\s*:\s*"([^"]+)")?/i);
  if (ld) {
    const street = clean(ld[1]), city = clean(ld[3] || ''), st = clean(ld[5] || ''), zip = clean(ld[7] || '');
    const full = [street, [city, st].filter(Boolean).join(', '), zip].filter(Boolean).join(', ');
    return { address: full, city, state: st, zip };
  }
  // Free-text "123 Main St, City, ST 12345".
  const m = visible.match(/(\d{1,6}\s+[A-Za-z0-9.'\- ]{2,40}(?:st|street|ave|avenue|rd|road|blvd|boulevard|dr|drive|ln|lane|way|hwy|highway|pkwy|ct|court|pl|place|suite|ste|unit)\.?[,\s]+)?([A-Za-z .'\-]{2,30}),\s*([A-Z]{2})\s+(\d{5})/);
  if (m) {
    const address = clean(m[0]);
    return { address, city: clean(m[2] || ''), state: clean(m[3] || ''), zip: clean(m[4] || '') };
  }
  return { address: '', city: '', state: '', zip: '' };
}

// ─── Hours ─────────────────────────────────────────────────────────────────────
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_ALIAS = { sun: 'sun', mon: 'mon', tue: 'tue', tues: 'tue', wed: 'wed', weds: 'wed', thu: 'thu', thur: 'thu', thurs: 'thu', fri: 'fri', sat: 'sat' };
function dayIndex(tok) { const k = DAY_ALIAS[String(tok || '').slice(0, 5).toLowerCase().replace(/[^a-z]/g, '').slice(0, 4)] || DAY_ALIAS[String(tok || '').slice(0, 3).toLowerCase()]; return DAY_KEYS.indexOf(k); }
function extractHours(visible) {
  const text = stripTags(visible);
  const out = {};
  if (/open\s*24\s*(?:hours|\/7|hrs)|24\s*\/\s*7|24\s*hours\s*a\s*day/i.test(text)) {
    for (const d of DAY_KEYS) out[d] = 'Open 24 Hours';
    return out;
  }
  // Day (or day-range) followed by a time range or "Closed".
  const re = /\b(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*\s*(?:(?:[-–to]+)\s*(sun|mon|tue|tues|wed|weds|thu|thur|thurs|fri|sat)[a-z]*)?\s*[:\-–]?\s*(closed|\d{1,2}(?::\d{2})?\s*(?:am|pm)?\s*(?:[-–to]+)\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)?)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = dayIndex(m[1]);
    if (start < 0) continue;
    const end = m[2] ? dayIndex(m[2]) : start;
    const val = /closed/i.test(m[3]) ? 'Closed' : clean(m[3]).replace(/\s*[-–]\s*|\s+to\s+/i, ' - ').replace(/\s+/g, ' ');
    const last = end >= start ? end : DAY_KEYS.length - 1;
    for (let i = start; i <= last; i++) if (!out[DAY_KEYS[i]]) out[DAY_KEYS[i]] = val;
  }
  return out;
}

// ─── Services ──────────────────────────────────────────────────────────────────
function extractServices(visible, niche) {
  const text = stripTags(visible).toLowerCase();
  const found = new Set();

  // 1) Keyword dictionary for the niche — high-precision, pitch-ready labels.
  const kw = NICHE_SERVICE_KEYWORDS[niche] || [];
  for (const k of kw) if (text.includes(k)) found.add(titleCase(k));

  // 2) Nav / list / heading anchors that look like short service names.
  const anchors = [];
  for (const m of visible.matchAll(/<(?:a|li|h2|h3)[^>]*>([\s\S]*?)<\/(?:a|li|h2|h3)>/gi)) {
    const t = stripTags(m[1]);
    if (t && t.length >= 3 && t.length <= 34 && /^[A-Za-z0-9 &'/\-]+$/.test(t)) anchors.push(t);
  }
  const NAVJUNK = /\b(home|about|contact|blog|news|gallery|reviews?|testimonials?|privacy|terms|sitemap|login|menu|search|careers?|faq|book|schedule|quote|call|email|©|copyright)\b/i;
  const SERVICEHINT = /\b(repair|install|installation|service|cleaning|replacement|maintenance|inspection|upgrade|detection|tune|heating|cooling|drain|wiring|panel|heater|sewer|duct|plumb|electric|hvac|ac\b)\b/i;
  for (const a of anchors) {
    if (NAVJUNK.test(a)) continue;
    if (SERVICEHINT.test(a)) found.add(titleCase(a.replace(/\s+/g, ' ')));
    if (found.size >= 10) break;
  }

  return [...found].slice(0, 8);
}

// ─── Testimonials ──────────────────────────────────────────────────────────────
function extractTestimonials(html, visible) {
  const out = [];
  const push = (quote, name, rating) => {
    quote = clean(stripTags(quote));
    if (quote.length < 25 || quote.length > 400) return;
    if (out.some(t => t.quote === quote)) return;
    const t = { quote };
    if (name) t.name = clean(name).slice(0, 40);
    if (rating != null && !isNaN(rating)) t.rating = Math.max(1, Math.min(5, Number(rating)));
    out.push(t);
  };

  // 1) schema.org Review JSON-LD.
  for (const m of html.matchAll(/"reviewBody"\s*:\s*"([^"]{20,400})"/gi)) push(m[1]);

  // 2) <blockquote>…</blockquote>.
  for (const m of visible.matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi)) push(m[1]);

  // 3) Elements whose class hints testimonial/review/quote.
  for (const m of visible.matchAll(/<(?:div|p|figure|section)[^>]+class\s*=\s*["'][^"']*(?:testimonial|review|quote)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|p|figure|section)>/gi)) {
    push(m[1]);
    if (out.length >= 6) break;
  }
  return out.slice(0, 6);
}

// ─── Colors (primary / accent) ─────────────────────────────────────────────────
function hexNorm(h) {
  h = h.toLowerCase();
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return '#' + h;
}
function rgbToHex(r, g, b) { return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join(''); }
function hexToHsl(hex) {
  const m = hex.replace('#', '');
  const r = parseInt(m.slice(0, 2), 16) / 255, g = parseInt(m.slice(2, 4), 16) / 255, b = parseInt(m.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return { h: h * 360, s, l };
}
// Collect brand-candidate colors from inline styles + <style> and rank by frequency,
// filtering out near-white / near-black / greys (chrome, text, borders — not brand).
function extractColors(html) {
  const counts = new Map();
  const add = hex => { if (!hex) return; const key = hex.toLowerCase(); counts.set(key, (counts.get(key) || 0) + 1); };
  for (const m of html.matchAll(/#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g)) add(hexNorm(m[1]));
  for (const m of html.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi)) add(rgbToHex(+m[1], +m[2], +m[3]));

  const ranked = [...counts.entries()]
    .map(([hex, n]) => ({ hex, n, hsl: hexToHsl(hex) }))
    .filter(c => c.hsl.s >= 0.18 && c.hsl.l >= 0.12 && c.hsl.l <= 0.82)   // has real color, not too light/dark
    .sort((a, b) => (b.n - a.n) || (b.hsl.s - a.hsl.s));

  if (!ranked.length) return { primary: '', accent: '' };
  const primary = ranked[0];
  // Accent = the most frequent color whose hue is clearly different from primary.
  const accent = ranked.find(c => Math.abs(c.hsl.h - primary.hsl.h) > 40) || null;
  return { primary: primary.hex, accent: accent ? accent.hex : '' };
}
// theme-color meta wins when present (explicit brand signal).
function extractPrimaryColor(html) {
  const tc = meta(html, 'theme-color') || meta(html, 'msapplication-TileColor');
  if (tc && /^#?[0-9a-fA-F]{3,6}$/.test(tc.replace(/^#/, ''))) return tc.startsWith('#') ? tc : '#' + tc;
  return '';
}

// ─── Logo ──────────────────────────────────────────────────────────────────────
function extractLogo(html, visible, base) {
  // 1) <img> that self-identifies as a logo.
  const img = (visible.match(/<img[^>]*(?:class|id|alt|src)\s*=\s*["'][^"']*logo[^"']*["'][^>]*>/i) || [])[0];
  if (img) { const s = img.match(/\bsrc\s*=\s*["']([^"']+)["']/i); if (s) return absolutize(s[1], base); }
  // 2) OpenGraph image.
  const og = meta(html, 'og:image');
  if (og) return absolutize(og, base);
  // 3) apple-touch-icon / large favicon.
  const at = (html.match(/<link[^>]+rel\s*=\s*["'][^"']*apple-touch-icon[^"']*["'][^>]*>/i) || [])[0];
  if (at) { const h = at.match(/href\s*=\s*["']([^"']+)["']/i); if (h) return absolutize(h[1], base); }
  return '';
}

// ─── Tagline / about ───────────────────────────────────────────────────────────
function extractTagline(html, visible) {
  const desc = meta(html, 'og:description') || meta(html, 'description');
  if (desc && desc.length <= 120) return desc;
  const h2 = clean(stripTags((visible.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i) || [])[1] || ''));
  if (h2 && h2.length <= 120) return h2;
  if (desc) return desc.slice(0, 117).replace(/\s+\S*$/, '') + '…';
  return '';
}
function extractAbout(html, visible) {
  const desc = meta(html, 'description') || meta(html, 'og:description');
  // Prefer a substantial first paragraph that reads like an "about" blurb.
  let best = '';
  for (const m of visible.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
    const t = stripTags(m[1]);
    if (t.length >= 80 && /\b(we|our|family|owned|serving|years|since|专业|licensed|insured|community|customers|proud)\b/i.test(t)) { best = t; break; }
    if (t.length > best.length && t.length <= 600) best = t;
  }
  const about = best || desc || '';
  return about.length > 600 ? about.slice(0, 597).replace(/\s+\S*$/, '') + '…' : about;
}

// ─── Main heuristic extractor (sync) ──────────────────────────────────────────
function extractFromHtml(html, opts = {}) {
  html = String(html || '');
  const base = opts.url || '';
  const niche = opts.niche || '';
  const visible = visibleHtml(html);

  const addr = extractAddress(html, visible);
  const colors = extractColors(html);
  const primaryMeta = extractPrimaryColor(html);

  return {
    name: extractName(html, visible),
    tagline: extractTagline(html, visible),
    about: extractAbout(html, visible),
    services: extractServices(visible, niche),
    phone: extractPhone(html, visible),
    emails: extractEmails(html),
    hours: extractHours(visible),
    address: addr.address,
    city: addr.city,
    state: addr.state,
    zip: addr.zip,
    testimonials: extractTestimonials(html, visible),
    primary_color: primaryMeta || colors.primary || '',
    accent_color: colors.accent || '',
    logo_url: extractLogo(html, visible, base),
  };
}

// ─── Optional VISION gap-fill (hard cases) ─────────────────────────────────────
// Screenshot the live site with WordPress mShots (free, no key), then ask an
// OpenAI-compatible vision model to read the brand. Mirrors the pattern in
// scraper/find-ugly-sites.js (mShots + /chat/completions). VISION_* env only.
async function mshots(url, env, w = 1024, h = 1360) {
  const api = `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=${w}&h=${h}`;
  for (let i = 0; i < 10; i++) {
    try {
      const r = await fetch(api, { headers: { 'User-Agent': UA } });
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 12000) return 'data:image/jpeg;base64,' + buf.toString('base64');  // <12KB = "generating" placeholder
    } catch (_) { /* retry */ }
    await new Promise(res => setTimeout(res, 4000));
  }
  return null;
}
const VISION_PROMPT = 'You are reading a small trade-business website screenshot to extract its brand. Return ONLY compact JSON (no markdown): {"business_name": string, "primary_color": "#hex", "accent_color": "#hex", "tagline": string, "services": ["short", "labels"]}. primary_color = the dominant brand color (buttons/header). Use "" for anything you cannot see. Keep tagline under 12 words and services to 3-6 short items.';
async function visionJudge(dataUri, env) {
  const base = (env.VISION_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
  const model = env.VISION_MODEL || 'qwen/qwen3.5-397b-a17b';
  const key = env.VISION_API_KEY || '';
  if (!key) return null;
  const body = JSON.stringify({
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: VISION_PROMPT }, { type: 'image_url', image_url: { url: dataUri } }] }],
    max_tokens: 400, temperature: 0,
  });
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(base + '/chat/completions', {
        method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body,
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

// Is the heuristic result thin enough to justify a (slower) vision pass?
function needsVision(data) {
  return !data.name || (!data.primary_color) || (data.services.length < 2);
}

async function visionExtract(url, env) {
  const shot = await mshots(url, env || {});
  if (!shot) return null;
  return await visionJudge(shot, env || {});
}

// Full extractor: heuristics, then optional vision to fill ONLY missing fields.
async function extract(html, opts = {}) {
  const data = extractFromHtml(html, opts);
  const env = opts.env || process.env;
  const wantVision = opts.useVision && env.VISION_API_KEY && (opts.forceVision || needsVision(data));
  if (!wantVision || !opts.url) return data;

  try {
    const v = await visionExtract(opts.url, env);
    if (v) {
      if (!data.name && v.business_name && !junkNamePart(clean(v.business_name))) data.name = clean(v.business_name);
      if (!data.tagline && v.tagline) data.tagline = clean(v.tagline).slice(0, 120);
      const hex = s => (s && /^#?[0-9a-fA-F]{3,6}$/.test(String(s).replace(/^#/, ''))) ? (String(s).startsWith('#') ? s : '#' + s) : '';
      if (!data.primary_color) data.primary_color = hex(v.primary_color);
      if (!data.accent_color) data.accent_color = hex(v.accent_color);
      if (data.services.length < 2 && Array.isArray(v.services)) {
        for (const s of v.services) { const t = titleCase(clean(s)); if (t && t.length <= 34 && !data.services.includes(t)) data.services.push(t); }
        data.services = data.services.slice(0, 8);
      }
      data._vision_used = true;
    }
  } catch (_) { /* vision is best-effort; heuristics already returned */ }
  return data;
}

module.exports = {
  extract, extractFromHtml, visionExtract,
  absolutize, decodeEntities, stripTags, titleCase,
  NICHE_SERVICE_KEYWORDS, GENERIC_SERVICES,
};

// ─── Standalone CLI: fetch a URL, extract, print JSON ─────────────────────────
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const url = args.find(a => /^https?:\/\//i.test(a));
    const useVision = args.includes('--vision');
    if (!url) { console.error('Usage: node extract.js <url> [--vision]'); process.exit(1); }

    // Minimal, self-contained fetch (with a basic SSRF guard) so this CLI is
    // testable without the rest of the pipeline. build-demo.js does the real fetch.
    function blocked(u) {
      let h; try { h = new URL(u).hostname.toLowerCase(); } catch (_) { return true; }
      if (h === 'localhost' || h.endsWith('.localhost')) return true;
      const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
      if (m) { const a = +m[1], b = +m[2]; if (a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true; }
      return false;
    }
    if (blocked(url)) { console.error('Refusing to fetch private/loopback host.'); process.exit(1); }

    // Load VISION_* from .env.local if present (no dependency).
    const fs = require('fs'), path = require('path');
    for (const f of [path.join(__dirname, '..', '.env.local'), path.join(__dirname, '.env.local')]) {
      try {
        for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
          const mm = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
          if (mm && !process.env[mm[1]]) process.env[mm[1]] = mm[2].replace(/^["']|["']$/g, '');
        }
      } catch (_) { /* optional */ }
    }

    let html = '';
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'User-Agent': UA } });
      html = (await res.text()).slice(0, 600000);
      clearTimeout(t);
      const finalUrl = res.url || url;
      const niche = (args.find(a => /electric|hvac|plumb/i.test(a)) || '').toLowerCase();
      const data = await extract(html, { url: finalUrl, niche, useVision, env: process.env });
      console.log(JSON.stringify(data, null, 2));
    } catch (e) {
      console.error('Fetch/extract failed:', e.message);
      process.exit(1);
    }
  })();
}
