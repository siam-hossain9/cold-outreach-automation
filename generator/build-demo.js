#!/usr/bin/env node
'use strict';
/**
 * build-demo.js — DEMO / REBUILD GENERATOR  (Ugly-Website Rebuild, the outreach system)
 * ============================================================================
 * Takes ONE lead (a scraper leads-*.csv row, or CLI args) → fetches & reads its
 * current (ugly) website → extracts the real business content → composes
 * site.config.json (the generator↔template contract, see
 * templates/_shared/site.config.schema.json) → produces a ready-to-deploy folder
 * → hands it to deploy-vercel.js.
 *
 * WHERE IT SITS IN THE FUNNEL (ARCHITECTURE.md):
 *   scraper CSV → [ generator ] → demos.demo_url + short_url ; leads.status='demo_ready'
 * Building a demo is CONTACT-NEUTRAL — it does not text/call anyone, so the
 * channel gate / consent / kill-switch (which govern OUTBOUND messaging) are
 * enforced later by the n8n workflows, not here. We DO surface the lead's
 * channel in the console so the operator sees it.
 *
 * The build folder:
 *   • If templates/<niche> exists → copy it, drop site.config.json in, and run a
 *     {{dot.path}} token-fill over its text files (forward-compatible with the
 *     templates component, which CONSUMES site.config.json).
 *   • Otherwise → render a self-contained, modern, responsive static demo from
 *     the config (so the generator is runnable end-to-end TODAY). Either way the
 *     page embeds the 30s view beacon the tracker expects.
 *
 * FALLBACK: dead/blocked/thin sites are common in the ugly set. Whatever the
 * scrape can't provide is filled from the lead CSV fields, then niche defaults —
 * so we always emit a complete, deployable demo.
 *
 * USAGE
 *   # from a scraper CSV (1-based data row, header excluded)
 *   node build-demo.js --csv ../scraper/leads-SOUTH-Ugly-2026-07-07-1955.csv --row 1
 *   node build-demo.js --csv ../scraper/leads-...csv --phone "(318) 487-2074"
 *   node build-demo.js --csv ../scraper/leads-...csv --place-id ChIJ...   --lead-id <convexLeadId>
 *
 *   # from CLI args (no CSV)
 *   node build-demo.js --name "Acme Plumbing" --phone "(555) 123-4567" \
 *        --website https://acmeplumbing.com --niche plumber --city Phoenix --state AZ
 *
 *   # useful flags
 *   --lead-id <id>     Convex leads._id to embed in tracking (n8n passes the real one)
 *   --out <dir>        output base (default: generator/build)
 *   --no-deploy        build the folder but skip the Vercel call
 *   --vision           allow the VISION_* model to gap-fill hard cases (brand/name)
 */

const fs = require('fs');
const path = require('path');
const { extract } = require('./extract');
const { deployFolder, sanitizeName } = require('./deploy-vercel');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36';
const ROOT = path.join(__dirname, '..');           // project root (e:/N8N/old website)
const TEMPLATES_DIR = path.join(ROOT, 'templates');

// ─── .env.local loader (no dependency — secrets never hardcoded) ───────────────
function loadEnvLocal() {
  for (const f of [path.join(ROOT, '.env.local'), path.join(__dirname, '.env.local')]) {
    try {
      for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
        if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
    } catch (_) { /* .env.local is optional in dev */ }
  }
  return process.env;
}

// ─── CLI arg parsing (--k v / --k=v / --flag) ─────────────────────────────────
function parseArgs(argv) {
  const flags = {}; const _ = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) { flags[a.slice(2, eq)] = a.slice(eq + 1); }
      else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) { flags[a.slice(2)] = argv[++i]; }
      else flags[a.slice(2)] = true;
    } else _.push(a);
  }
  return { flags, _ };
}

// ─── CSV parsing (matches scraper's writer; handles quotes/newlines) ──────────
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
const normPhone = raw => String(raw || '').replace(/\D/g, '').slice(-10);

// Map a scraper CSV data row → our internal lead shape.
function rowToLead(headers, row) {
  const idx = {}; headers.forEach((h, i) => idx[h] = i);
  const g = name => (idx[name] != null ? row[idx[name]] : '') || '';
  return {
    place_id: g('place_id'),
    name: g('Lead Name'),
    phone: g('Phone'),
    website: g('Website URL'),
    niche: g('Niche'),
    city: g('City'),
    state: g('State'),
    zip: g('ZIP'),
    address: g('Address'),
    channel: g('Channel'),
    ugly_score: g('Ugly Score'),
    ugly_reasons: g('Ugly Reasons'),
    vision_reasons: g('Vision Reasons'),
    rating: g('Google Rating'),
    reviews: g('Google Reviews'),
  };
}

// Select the lead: from a CSV (row / phone / place-id) or straight CLI args.
function selectLead(flags) {
  if (flags.csv) {
    let file = flags.csv;
    if (!path.isAbsolute(file)) {
      // try cwd, then the scraper folder (where leads-*.csv live)
      const cands = [path.resolve(process.cwd(), file), path.join(ROOT, 'scraper', file), path.join(ROOT, file)];
      file = cands.find(fs.existsSync) || cands[0];
    }
    if (!fs.existsSync(file)) throw new Error('CSV not found: ' + flags.csv);
    const rows = parseCSV(fs.readFileSync(file, 'utf8')).filter(r => r.length > 1);
    const headers = rows[0]; const data = rows.slice(1);
    if (!data.length) throw new Error('CSV has no data rows: ' + file);

    let row;
    if (flags.phone) { const want = normPhone(flags.phone); const idxPhone = headers.indexOf('Phone'); row = data.find(r => normPhone(r[idxPhone]) === want); if (!row) throw new Error('No row with phone ' + flags.phone); }
    else if (flags['place-id']) { const idxP = headers.indexOf('place_id'); row = data.find(r => (r[idxP] || '') === flags['place-id']); if (!row) throw new Error('No row with place_id ' + flags['place-id']); }
    else { const n = Math.max(1, parseInt(flags.row || '1', 10)); if (n > data.length) throw new Error(`--row ${n} out of range (CSV has ${data.length} data rows)`); row = data[n - 1]; }

    return { lead: rowToLead(headers, row), source: `${path.basename(file)}` };
  }

  // CLI-args lead (no CSV)
  if (flags.name || flags.website) {
    return {
      lead: {
        place_id: flags['place-id'] || '',
        name: flags.name || '',
        phone: flags.phone || '',
        website: flags.website || '',
        niche: flags.niche || '',
        city: flags.city || '',
        state: flags.state || '',
        zip: flags.zip || '',
        address: flags.address || '',
        channel: '',
      },
      source: 'cli-args',
    };
  }

  throw new Error('No lead specified. Use --csv <file> [--row N | --phone P | --place-id ID], or --name/--website/... args.');
}

// ─── Niche normalization + rich defaults (fallback content) ───────────────────
function normalizeNiche(raw) {
  const s = String(raw || '').toLowerCase();
  if (/electric/.test(s)) return 'electrician';
  if (/hvac|heating|cooling|\bair\b|furnace|\bac\b/.test(s)) return 'hvac';
  if (/plumb/.test(s)) return 'plumber';
  return null;   // outside the 3 supported template niches
}
const NICHE = {
  electrician: {
    label: 'Electrical', noun: 'Electricians',
    primary: '#1a4d8c', accent: '#f59e0b',
    headline: c => `${c ? c + "'s " : ''}Trusted Licensed Electricians`,
    tagline: 'Fast, safe, code-compliant electrical work — done right the first time.',
    services: ['Panel Upgrades', 'Wiring & Rewiring', 'Lighting Installation', 'EV Charger Installation', 'Generator Installation', 'Electrical Repairs', 'Ceiling Fans', 'Surge Protection'],
    emergency: '24/7 Emergency Electrical Service',
  },
  hvac: {
    label: 'Heating & Cooling', noun: 'HVAC Pros',
    primary: '#0e7490', accent: '#ea580c',
    headline: c => `${c ? c + "'s " : ''}Heating & Air Conditioning Experts`,
    tagline: 'Comfort you can count on — repair, installation, and maintenance.',
    services: ['AC Repair', 'AC Installation', 'Furnace Repair', 'Heating Installation', 'Heat Pumps', 'Duct Cleaning', 'Thermostat Upgrades', 'Seasonal Maintenance'],
    emergency: '24/7 Emergency HVAC Service',
  },
  plumber: {
    label: 'Plumbing', noun: 'Plumbers',
    primary: '#1d4ed8', accent: '#0891b2',
    headline: c => `${c ? c + "'s " : ''}Dependable Local Plumbers`,
    tagline: 'Upfront pricing and quality work — from leaks to water heaters.',
    services: ['Drain Cleaning', 'Water Heater Repair & Install', 'Leak Detection', 'Repiping', 'Sewer Line Service', 'Faucet & Fixture Repair', 'Garbage Disposals', 'Gas Line Service'],
    emergency: '24/7 Emergency Plumbing',
  },
};
const GENERIC = {
  label: 'Home Services', noun: 'Pros',
  primary: '#1a4d8c', accent: '#f59e0b',
  headline: c => `${c ? c + "'s " : ''}Trusted Local Pros`,
  tagline: 'Quality workmanship and friendly service you can rely on.',
  services: ['Free Estimates', 'Repairs & Installation', 'Emergency Service', 'Maintenance', 'Inspections', 'Commercial & Residential'],
  emergency: '24/7 Emergency Service',
};

// ─── Fetch the old site (SSRF-guarded, retrying — mirrors scraper) ────────────
function isBlockedHost(urlStr) {
  let h;
  try { h = new URL(urlStr).hostname.toLowerCase().replace(/^\[|\]$/g, ''); } catch (_) { return true; }
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '::1' || h.startsWith('fe80:') || h.startsWith('fc') || h.startsWith('fd')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) { const a = +m[1], b = +m[2]; if (a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true; }
  return false;
}
async function readCapped(res, maxBytes = 800000) {
  if (!res.body || !res.body.getReader) { const t = await res.text().catch(() => ''); return t.slice(0, maxBytes); }
  const reader = res.body.getReader(), dec = new TextDecoder('utf-8', { fatal: false });
  let received = 0, out = '';
  try {
    while (received < maxBytes) { const { done, value } = await reader.read(); if (done) break; received += value.length; out += dec.decode(value, { stream: true }); }
  } catch (_) { /* partial body is fine */ } finally { try { await reader.cancel(); } catch (_) {} }
  return out;
}
async function fetchSite(url, timeoutMs = 12000) {
  if (!url) return { ok: false, status: 0, finalUrl: '', html: '', error: 'no url' };
  if (isBlockedHost(url)) return { ok: false, status: 0, finalUrl: url, html: '', error: 'blocked host (private/loopback/metadata)' };
  let lastErr = 'no response';
  for (let attempt = 1; attempt <= 3; attempt++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA } });
      const html = await readCapped(res); clearTimeout(t);
      return { ok: res.ok, status: res.status, finalUrl: res.url || url, html };
    } catch (e) { clearTimeout(t); lastErr = e.message; if (attempt < 3) await new Promise(r => setTimeout(r, 1500 * attempt)); }
  }
  return { ok: false, status: 0, finalUrl: url, html: '', error: lastErr };
}

// ─── Compose site.config.json (the schema contract) ───────────────────────────
// Precedence: authoritative Google/CSV fields win for name/phone/address/geo
// (clean ground truth); scraped-from-site wins for services/hours/brand/copy;
// niche defaults backfill whatever is still missing.
function pick(...vals) { for (const v of vals) { if (Array.isArray(v) ? v.length : (v != null && String(v).trim() !== '')) return v; } return Array.isArray(vals[vals.length - 1]) ? [] : ''; }

function composeConfig(lead, scraped, env, opts) {
  const canonicalNiche = normalizeNiche(lead.niche) || 'electrician';   // schema enum + template dir
  const nd = NICHE[normalizeNiche(lead.niche)] || GENERIC;              // content defaults (generic for off-core trades)
  const city = pick(lead.city, scraped.city);
  const state = pick(lead.state, scraped.state);

  const name = pick(lead.name, scraped.name, 'Your Business');
  const phone = pick(lead.phone, scraped.phone);
  const primary = pick(scraped.primary_color, nd.primary);
  const accent = pick(scraped.accent_color, nd.accent);

  // Services: prefer scraped (real); backfill to niche defaults if too thin.
  let services = Array.isArray(scraped.services) ? scraped.services.filter(Boolean) : [];
  if (services.length < 3) services = [...new Set(services.concat(nd.services))].slice(0, 8);
  else services = services.slice(0, 8);

  // Testimonials: real scraped ones, else clearly-generic placeholders (the demo
  // owner replaces these — documented in README; we never fabricate a named review).
  let testimonials = Array.isArray(scraped.testimonials) ? scraped.testimonials.filter(t => t && t.quote) : [];
  if (!testimonials.length) {
    testimonials = [
      { name: (city ? city + ' Homeowner' : 'Local Homeowner'), quote: 'Showed up on time, explained everything clearly, and the price was fair. Highly recommend.', rating: 5 },
      { name: 'Verified Customer', quote: 'Professional, friendly, and did great work. Would absolutely call them again.', rating: 5 },
    ];
  }

  // Hours: scraped if present, else a soft default (owner tweaks in the demo).
  let hours = (scraped.hours && Object.keys(scraped.hours).length) ? scraped.hours
    : { mon: '8:00 AM - 5:00 PM', tue: '8:00 AM - 5:00 PM', wed: '8:00 AM - 5:00 PM', thu: '8:00 AM - 5:00 PM', fri: '8:00 AM - 5:00 PM', sat: 'By Appointment', sun: 'Closed' };

  const domain = String(env.PUBLIC_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/+$/, '') || 'example.com';
  const leadId = opts.leadId || lead.place_id || ('lead_' + (normPhone(phone) || Date.now()));

  const business = { name, phone };
  const email = pick((scraped.emails || [])[0]);
  if (email) business.email = email;
  const address = pick(lead.address, scraped.address);
  if (address) business.address = address;
  if (city) business.city = city;
  if (state) business.state = state;
  const zip = pick(lead.zip, scraped.zip); if (zip) business.zip = zip;
  business.hours = hours;
  business.service_area = city ? [city + (state ? ', ' + state : ''), 'and surrounding areas'] : [];

  const config = {
    business,
    branding: { primary_color: primary, accent_color: accent, logo_url: pick(scraped.logo_url) },
    content: {
      hero_headline: pick(scraped._headline, nd.headline(city)),
      tagline: pick(scraped.tagline, nd.tagline),
      about: pick(scraped.about, `${name} is a locally owned ${nd.label.toLowerCase()} company${city ? ' proudly serving ' + city + (state ? ', ' + state : '') : ''} and the surrounding area. Licensed, insured, and committed to honest pricing and quality work on every job.`),
      services,
      testimonials,
    },
    cta: {
      phone_button: phone ? 'Call ' + phone : 'Call Now',
      quote_button: 'Get a Free Quote',
    },
    tracking: {
      lead_id: String(leadId),
      beacon_url: `https://${domain}/api/beacon`,
      short_url: `https://${domain}/r/${leadId}`,
    },
    meta: {
      niche: canonicalNiche,
      source_url: pick(scraped._finalUrl, lead.website),
      generated_at: new Date().toISOString(),
    },
  };
  // Stash niche label + emergency line for the built-in renderer (non-schema, dropped before write of pure config? kept — schema allows extra props but we keep it clean by not persisting). We pass via a side object instead:
  config.__render = { nicheLabel: nd.label, emergency: nd.emergency, canonicalNiche };
  return config;
}

// ─── HTML escaping for the built-in renderer ──────────────────────────────────
const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const safeUrl = u => (/^https?:\/\//i.test(String(u || '')) ? String(u) : '');
const telHref = p => 'tel:+1' + normPhone(p);

// ─── Built-in modern static template (fallback when templates/<niche> absent) ──
function renderStaticSite(config) {
  const r = config.__render || { nicheLabel: 'Home Services', emergency: '24/7 Emergency Service' };
  const b = config.business, c = config.content, br = config.branding, t = config.tracking;
  const primary = /^#|^rgb/i.test(br.primary_color) ? br.primary_color : '#1a4d8c';
  const accent = /^#|^rgb/i.test(br.accent_color) ? br.accent_color : '#f59e0b';
  const logo = safeUrl(br.logo_url);
  const phone = b.phone || '';
  const dayNames = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };

  const servicesHtml = (c.services || []).map(s =>
    `<div class="card"><div class="card-ic">&#9889;</div><h3>${esc(s)}</h3><p>Professional ${esc(r.nicheLabel.toLowerCase())} service you can rely on.</p></div>`).join('\n');

  const testimonialsHtml = (c.testimonials || []).map(tt => {
    const stars = '★'.repeat(Math.round(tt.rating || 5)) + '☆'.repeat(5 - Math.round(tt.rating || 5));
    return `<figure class="quote"><div class="stars">${stars}</div><blockquote>${esc(tt.quote)}</blockquote>${tt.name ? `<figcaption>— ${esc(tt.name)}</figcaption>` : ''}</figure>`;
  }).join('\n');

  const hoursHtml = (b.hours && Object.keys(b.hours).length)
    ? '<ul class="hours">' + Object.keys(dayNames).filter(d => b.hours[d]).map(d => `<li><span>${dayNames[d]}</span><span>${esc(b.hours[d])}</span></li>`).join('') + '</ul>'
    : '';

  const addressLine = [b.address].filter(Boolean).join('') || [b.city, b.state, b.zip].filter(Boolean).join(', ');
  const configJson = JSON.stringify({ tracking: t }).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${esc(primary)}">
<title>${esc(b.name)} — ${esc(r.nicheLabel)}${b.city ? ' in ' + esc(b.city) : ''}</title>
<meta name="description" content="${esc(c.tagline || (b.name + ' — ' + r.nicheLabel))}">
<style>
  :root{--primary:${esc(primary)};--accent:${esc(accent)};--ink:#0f172a;--muted:#64748b;--bg:#ffffff;--soft:#f1f5f9;--line:#e2e8f0}
  *{box-sizing:border-box;margin:0;padding:0}
  html{scroll-behavior:smooth}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--ink);line-height:1.6;background:var(--bg)}
  a{color:inherit;text-decoration:none}
  .wrap{max-width:1120px;margin:0 auto;padding:0 20px}
  .btn{display:inline-flex;align-items:center;gap:8px;padding:14px 22px;border-radius:10px;font-weight:700;font-size:16px;transition:transform .15s ease,box-shadow .15s ease;cursor:pointer;border:0}
  .btn-primary{background:var(--accent);color:#0b1220;box-shadow:0 6px 20px rgba(0,0,0,.18)}
  .btn-primary:hover{transform:translateY(-2px)}
  .btn-ghost{background:rgba(255,255,255,.14);color:#fff;border:1.5px solid rgba(255,255,255,.5)}
  .btn-ghost:hover{background:rgba(255,255,255,.24)}
  /* header */
  header{position:sticky;top:0;z-index:40;background:rgba(255,255,255,.92);backdrop-filter:saturate(180%) blur(8px);border-bottom:1px solid var(--line)}
  .nav{display:flex;align-items:center;justify-content:space-between;height:68px}
  .brand{display:flex;align-items:center;gap:12px;font-weight:800;font-size:20px;color:var(--primary)}
  .brand img{height:40px;width:auto;border-radius:6px}
  .brand .mark{display:inline-flex;align-items:center;justify-content:center;width:40px;height:40px;border-radius:9px;background:var(--primary);color:#fff;font-size:18px}
  .nav-cta{display:flex;align-items:center;gap:14px}
  .nav-cta .phone{font-weight:800;color:var(--primary);font-size:18px}
  @media(max-width:640px){.nav-cta .phone{display:none}}
  /* hero */
  .hero{position:relative;color:#fff;background:linear-gradient(135deg,var(--primary),color-mix(in srgb,var(--primary) 62%,#000));padding:76px 0 84px;overflow:hidden}
  .hero:after{content:"";position:absolute;inset:0;background:radial-gradient(1200px 400px at 80% -10%,rgba(255,255,255,.18),transparent)}
  .hero .wrap{position:relative;z-index:1;max-width:760px}
  .pill{display:inline-block;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.35);padding:6px 14px;border-radius:999px;font-size:13px;font-weight:700;letter-spacing:.3px;margin-bottom:18px}
  .hero h1{font-size:clamp(32px,5vw,52px);line-height:1.08;font-weight:800;letter-spacing:-.5px}
  .hero p.tag{font-size:clamp(17px,2.2vw,21px);opacity:.94;margin:16px 0 28px;max-width:620px}
  .hero .cta{display:flex;gap:14px;flex-wrap:wrap}
  /* trust bar */
  .trust{background:var(--soft);border-bottom:1px solid var(--line)}
  .trust .wrap{display:flex;gap:26px;flex-wrap:wrap;justify-content:center;padding:16px 20px;color:var(--muted);font-weight:600;font-size:14px}
  .trust span{display:inline-flex;align-items:center;gap:8px}
  /* sections */
  section.block{padding:72px 0}
  .eyebrow{color:var(--accent);font-weight:800;letter-spacing:1px;text-transform:uppercase;font-size:13px}
  h2.title{font-size:clamp(26px,3.4vw,36px);font-weight:800;margin:8px 0 10px;letter-spacing:-.3px}
  .lead{color:var(--muted);max-width:640px;font-size:17px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px;margin-top:36px}
  .card{background:#fff;border:1px solid var(--line);border-radius:14px;padding:26px 22px;transition:box-shadow .2s ease,transform .2s ease}
  .card:hover{box-shadow:0 12px 30px rgba(2,6,23,.09);transform:translateY(-3px)}
  .card-ic{width:44px;height:44px;border-radius:11px;background:color-mix(in srgb,var(--primary) 12%,#fff);color:var(--primary);display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:14px}
  .card h3{font-size:18px;margin-bottom:6px}
  .card p{color:var(--muted);font-size:15px}
  .about{display:grid;grid-template-columns:1.2fr .8fr;gap:40px;align-items:center}
  @media(max-width:820px){.about{grid-template-columns:1fr}}
  .about .panel{background:linear-gradient(135deg,var(--primary),color-mix(in srgb,var(--primary) 60%,#000));color:#fff;border-radius:18px;padding:30px}
  .about .panel h3{font-size:20px;margin-bottom:12px}
  .about .panel .em{font-size:15px;opacity:.92;margin-top:14px;padding-top:14px;border-top:1px solid rgba(255,255,255,.25)}
  .quotes{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:22px;margin-top:36px}
  .quote{background:#fff;border:1px solid var(--line);border-radius:14px;padding:26px}
  .stars{color:var(--accent);font-size:18px;letter-spacing:2px;margin-bottom:10px}
  .quote blockquote{font-size:16px;font-style:italic;color:#1e293b}
  .quote figcaption{margin-top:12px;font-weight:700;color:var(--muted);font-size:14px}
  .contact{background:var(--soft)}
  .contact .cols{display:grid;grid-template-columns:1fr 1fr;gap:34px;margin-top:30px}
  @media(max-width:720px){.contact .cols{grid-template-columns:1fr}}
  .hours{list-style:none}
  .hours li{display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px dashed var(--line);font-size:15px}
  .hours li span:first-child{font-weight:700;color:var(--muted)}
  .info p{margin:8px 0;font-size:16px}
  .info .k{font-weight:800;color:var(--primary);display:block;font-size:13px;text-transform:uppercase;letter-spacing:.6px}
  .band{background:linear-gradient(135deg,var(--primary),color-mix(in srgb,var(--primary) 60%,#000));color:#fff;text-align:center;padding:60px 20px}
  .band h2{font-size:clamp(24px,3.2vw,34px);font-weight:800}
  .band p{opacity:.9;margin:10px 0 24px}
  footer{background:#0b1220;color:#94a3b8;padding:34px 20px;text-align:center;font-size:14px}
  footer .fbrand{color:#fff;font-weight:800;font-size:18px;margin-bottom:6px}
  footer .disclaimer{margin-top:14px;font-size:12px;color:#64748b}
  .fab{position:fixed;right:18px;bottom:18px;z-index:50;background:var(--accent);color:#0b1220;font-weight:800;padding:14px 20px;border-radius:999px;box-shadow:0 10px 26px rgba(0,0,0,.28);display:none}
  @media(max-width:640px){.fab{display:inline-flex;align-items:center;gap:8px}}
</style>
</head>
<body>
<header>
  <div class="wrap nav">
    <a class="brand" href="#top">
      ${logo ? `<img src="${esc(logo)}" alt="${esc(b.name)} logo">` : `<span class="mark">${esc((b.name || '?').trim().charAt(0).toUpperCase())}</span>`}
      <span>${esc(b.name)}</span>
    </a>
    <div class="nav-cta">
      ${phone ? `<a class="phone" href="${esc(telHref(phone))}">${esc(phone)}</a>` : ''}
      ${phone ? `<a class="btn btn-primary" href="${esc(telHref(phone))}">&#9742; Call Now</a>` : `<a class="btn btn-primary" href="#contact">Get a Quote</a>`}
    </div>
  </div>
</header>

<a id="top"></a>
<section class="hero">
  <div class="wrap">
    <span class="pill">${esc(r.emergency)}</span>
    <h1>${esc(c.hero_headline)}</h1>
    <p class="tag">${esc(c.tagline)}</p>
    <div class="cta">
      ${phone ? `<a class="btn btn-primary" href="${esc(telHref(phone))}">&#9742; ${esc(config.cta.phone_button)}</a>` : ''}
      <a class="btn btn-ghost" href="#contact">${esc(config.cta.quote_button)}</a>
    </div>
  </div>
</section>

<div class="trust">
  <div class="wrap">
    <span>&#10003; Licensed &amp; Insured</span>
    <span>&#10003; Free Estimates</span>
    <span>&#10003; Upfront Pricing</span>
    <span>&#10003; Locally Owned</span>
  </div>
</div>

<section class="block">
  <div class="wrap">
    <div class="eyebrow">What We Do</div>
    <h2 class="title">Our ${esc(r.nicheLabel)} Services</h2>
    <p class="lead">Full-service ${esc(r.nicheLabel.toLowerCase())} for homes and businesses${b.city ? ' across ' + esc(b.city) : ''}.</p>
    <div class="grid">
      ${servicesHtml}
    </div>
  </div>
</section>

<section class="block" style="background:var(--soft);border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
  <div class="wrap about">
    <div>
      <div class="eyebrow">About Us</div>
      <h2 class="title">Why ${esc(b.name)}</h2>
      <p class="lead" style="max-width:none">${esc(c.about)}</p>
    </div>
    <div class="panel">
      <h3>${esc(r.emergency)}</h3>
      <p>When something goes wrong, you need a pro who answers. Call us and we'll make it right — fast.</p>
      ${phone ? `<a class="btn btn-primary" style="margin-top:16px" href="${esc(telHref(phone))}">&#9742; ${esc(phone)}</a>` : ''}
      <div class="em">Trusted by neighbors${b.city ? ' in ' + esc(b.city) : ''} for quality workmanship.</div>
    </div>
  </div>
</section>

${(c.testimonials && c.testimonials.length) ? `<section class="block">
  <div class="wrap">
    <div class="eyebrow">Reviews</div>
    <h2 class="title">What Customers Say</h2>
    <div class="quotes">
      ${testimonialsHtml}
    </div>
  </div>
</section>` : ''}

<section class="block contact" id="contact">
  <div class="wrap">
    <div class="eyebrow">Get In Touch</div>
    <h2 class="title">Request Your Free Quote</h2>
    <div class="cols">
      <div class="info">
        ${phone ? `<p><span class="k">Phone</span><a href="${esc(telHref(phone))}" style="color:var(--primary);font-weight:700">${esc(phone)}</a></p>` : ''}
        ${b.email ? `<p><span class="k">Email</span><a href="mailto:${esc(b.email)}" style="color:var(--primary)">${esc(b.email)}</a></p>` : ''}
        ${addressLine ? `<p><span class="k">Service Area</span>${esc(addressLine)}</p>` : ''}
        ${(b.service_area && b.service_area.length) ? `<p><span class="k">We Serve</span>${esc(b.service_area.join(' '))}</p>` : ''}
      </div>
      <div class="info">
        ${hoursHtml ? `<p><span class="k">Hours</span></p>${hoursHtml}` : `<p><span class="k">Hours</span>Call anytime — ${esc(r.emergency.toLowerCase())}.</p>`}
      </div>
    </div>
  </div>
</section>

<div class="band">
  <h2>Ready to get started?</h2>
  <p>${esc(b.name)} is here to help${b.city ? ' in ' + esc(b.city) : ''}. Reach out for a free, no-obligation quote.</p>
  ${phone ? `<a class="btn btn-primary" href="${esc(telHref(phone))}">&#9742; ${esc(config.cta.phone_button)}</a>` : `<a class="btn btn-primary" href="#contact">${esc(config.cta.quote_button)}</a>`}
</div>

<footer>
  <div class="fbrand">${esc(b.name)}</div>
  <div>${esc(r.nicheLabel)}${b.city ? ' &middot; ' + esc(b.city) : ''}${b.state ? ', ' + esc(b.state) : ''}${phone ? ' &middot; ' + esc(phone) : ''}</div>
  <div class="disclaimer">This is a free rebuild concept created to show what a modern site could look like.</div>
</footer>

${phone ? `<a class="fab" href="${esc(telHref(phone))}">&#9742; Call ${esc(b.name.split(' ')[0])}</a>` : ''}

<script id="site-config" type="application/json">${configJson}</script>
<script>
  // 30-second view beacon — tells the tracker the lead actually looked at the demo.
  (function(){
    try{
      var cfg = JSON.parse(document.getElementById('site-config').textContent).tracking || {};
      if(!cfg.beacon_url || !cfg.lead_id) return;
      setTimeout(function(){
        var url = cfg.beacon_url + (cfg.beacon_url.indexOf('?')>=0?'&':'?') + 'leadId=' + encodeURIComponent(cfg.lead_id);
        try{
          if(navigator.sendBeacon){ navigator.sendBeacon(url); }
          else{ fetch(url,{method:'POST',keepalive:true,mode:'no-cors'}); }
        }catch(e){}
      }, 30000);
    }catch(e){}
  })();
</script>
</body>
</html>`;
}

// ─── Build the ready-to-deploy folder ─────────────────────────────────────────
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch (_) {} }
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
// Resolve {{a.b.c}} tokens (arrays joined, objects JSON) against the config.
// (Forward-compat: current templates render from SITE_CONFIG, not {{tokens}} —
// this only fires if a template ever uses placeholder tokens.)
function fillTokens(text, config) {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, pathStr) => {
    let v = config;
    for (const k of pathStr.split('.')) { if (v == null) break; v = v[k]; }
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(x => typeof x === 'object' ? JSON.stringify(x) : x).join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  });
}

// The niche templates load their shared runtime from a sibling ../_shared/ dir.
// When we flatten the template into a single deploy folder (index.html at root),
// _shared becomes a subfolder → rewrite the relative refs so they still resolve.
function rewriteSharedPaths(text) {
  return text.replace(/\.\.\/_shared\//g, '_shared/').replace(/\.\/_shared\//g, '_shared/');
}

// Inject the composed config into a template's index.html two robust ways:
//   (a) define window.SITE_CONFIG BEFORE _shared/render.js  (render.js/beacon.js prefer it)
//   (b) replace the inline <script id="site-config"> sample JSON
// Both `<` are escaped to < so a scraped value can't break out of the tag.
function injectConfigIntoHtml(html, cleanConfig) {
  const compact = JSON.stringify(cleanConfig).replace(/</g, '\\u003c');
  const pretty = JSON.stringify(cleanConfig, null, 2).replace(/</g, '\\u003c');
  const injectTag = `<script>window.SITE_CONFIG = ${compact};</script>\n  `;

  let out = html;
  // (a) place window.SITE_CONFIG immediately before render.js (function-form
  //     replacement so `$` inside the JSON is never treated as a backreference)
  const renderRe = /<script\s+src=["'][^"']*_shared\/render\.js["'][^>]*><\/script>/i;
  if (renderRe.test(out)) out = out.replace(renderRe, m => injectTag + m);
  else if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, () => injectTag + '</body>');

  // (b) refresh the inline sample block so standalone-open also shows this business
  const inlineRe = /<script\s+id=["']site-config["'][^>]*>[\s\S]*?<\/script>/i;
  if (inlineRe.test(out)) out = out.replace(inlineRe, () => `<script id="site-config" type="application/json">\n${pretty}\n</script>`);

  return out;
}

const FILLABLE = /\.(html?|css|js|mjs|json|md|txt|svg|xml|webmanifest)$/i;

function buildFolder(config, outBase, slug, log) {
  const folder = path.join(outBase, slug);
  rmrf(folder);
  fs.mkdirSync(folder, { recursive: true });

  const niche = (config.__render && config.__render.canonicalNiche) || config.meta.niche;
  const templateDir = path.join(TEMPLATES_DIR, niche);
  const sharedDir = path.join(TEMPLATES_DIR, '_shared');
  const hasTemplate = fs.existsSync(templateDir) && fs.statSync(templateDir).isDirectory()
    && fs.readdirSync(templateDir).length > 0;

  // site.config.json to persist = the schema-clean config (drop our private __render helper).
  const cleanConfig = JSON.parse(JSON.stringify(config)); delete cleanConfig.__render;

  if (hasTemplate) {
    log(`   using template: templates/${niche}`);
    // 1) copy the niche template files (index.html, its sample site.config.json, …)
    copyDir(templateDir, folder);
    // 2) bundle the shared runtime as a LOCAL _shared/ so the folder is self-contained
    if (fs.existsSync(sharedDir)) copyDir(sharedDir, path.join(folder, '_shared'));
    else log('   ⚠ templates/_shared missing — template may not render');

    // 3) write the real config artifact (the contract file other pipeline steps read)
    fs.writeFileSync(path.join(folder, 'site.config.json'), JSON.stringify(cleanConfig, null, 2), 'utf8');

    // 4) process top-level template files: rewrite ../_shared refs, fill any tokens,
    //    and inject the config into index.html. (We leave _shared/ runtime untouched.)
    for (const e of fs.readdirSync(folder, { withFileTypes: true })) {
      if (e.isDirectory() || !FILLABLE.test(e.name) || e.name === 'site.config.json') continue;
      const p = path.join(folder, e.name);
      let txt;
      try { txt = fs.readFileSync(p, 'utf8'); } catch (_) { continue; }
      txt = rewriteSharedPaths(txt);
      if (txt.includes('{{')) txt = fillTokens(txt, cleanConfig);
      if (/\.html?$/i.test(e.name)) txt = injectConfigIntoHtml(txt, cleanConfig);
      fs.writeFileSync(p, txt, 'utf8');
    }

    // 5) safety net: guarantee a servable root document
    if (!fs.existsSync(path.join(folder, 'index.html'))) {
      fs.writeFileSync(path.join(folder, 'index.html'), renderStaticSite(config), 'utf8');
    }
  } else {
    log(`   templates/${niche} not present → rendering built-in static demo`);
    fs.writeFileSync(path.join(folder, 'index.html'), renderStaticSite(config), 'utf8');
    fs.writeFileSync(path.join(folder, 'site.config.json'), JSON.stringify(cleanConfig, null, 2), 'utf8');
  }
  return { folder, cleanConfig, usedTemplate: hasTemplate };
}

// slug for folder + Vercel project name (business + niche + short id).
function makeSlug(config, lead) {
  const base = sanitizeName(config.business.name + '-' + config.meta.niche);
  const sid = (lead.place_id || normPhone(config.business.phone) || '').slice(-4).replace(/[^a-z0-9]/gi, '') || String(Date.now()).slice(-4);
  return sanitizeName(base + '-' + sid).slice(0, 60);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const env = loadEnvLocal();
  const { flags } = parseArgs(process.argv.slice(2));

  let picked;
  try { picked = selectLead(flags); }
  catch (e) { console.error('❌ ' + e.message); process.exitCode = 1; return; }
  const lead = picked.lead;
  // Ensure the site URL has a scheme so the SSRF guard's new URL() parses it.
  if (lead.website && !/^https?:\/\//i.test(lead.website)) lead.website = 'http://' + lead.website.replace(/^\/+/, '');

  const canonicalNiche = normalizeNiche(lead.niche);
  console.log(`\n🏗  Building demo for: ${lead.name || '(unnamed)'}  [${lead.niche || '?'}${canonicalNiche ? '' : ' → coerced to electrician template'}]`);
  console.log(`   source: ${picked.source}${lead.website ? '  ·  site: ' + lead.website : ''}`);
  if (lead.channel) console.log(`   channel gate: ${lead.channel}  (applies at SEND time, not build)`);

  // 1) Fetch + read the old site
  let scraped = {};
  if (lead.website) {
    process.stdout.write('   fetching old site … ');
    const r = await fetchSite(lead.website);
    if (r.ok && r.html) {
      console.log(`ok (HTTP ${r.status}, ${r.html.length} bytes)`);
      const useVision = !!flags.vision && !!env.VISION_API_KEY;
      scraped = await extract(r.html, { url: r.finalUrl, niche: canonicalNiche || '', useVision, env });
      scraped._finalUrl = r.finalUrl;
      if (scraped._vision_used) console.log('   (vision gap-fill used)');
    } else {
      console.log(`unreachable (${r.error || 'HTTP ' + r.status}) → using CSV + niche defaults`);
    }
  } else {
    console.log('   no website on lead → using CSV + niche defaults');
  }

  // 2) Compose config (schema contract) with fallback fill
  const config = composeConfig(lead, scraped, env, { leadId: flags['lead-id'] });

  // 3) Build the ready-to-deploy folder
  const outBase = flags.out ? (path.isAbsolute(flags.out) ? flags.out : path.resolve(process.cwd(), flags.out)) : path.join(__dirname, 'build');
  const slug = makeSlug(config, lead);
  console.log('   composing site.config.json …');
  const { folder, usedTemplate } = buildFolder(config, outBase, slug, s => console.log(s));
  console.log(`   ✔ folder ready: ${folder}`);

  // 4) Deploy (or graceful no-op)
  let deploy = { deployed: false, reason: 'skipped (--no-deploy)', localPath: folder };
  if (!flags['no-deploy']) {
    const suffix = String(env.DEMO_SUBDOMAIN_SUFFIX || '').replace(/^https?:\/\//, '').replace(/\/+$/, '');
    deploy = await deployFolder(folder, {
      token: env.VERCEL_TOKEN, teamId: env.VERCEL_TEAM_ID,
      name: slug,
      aliasHost: suffix ? `${slug}.${suffix}` : '',
      log: s => console.log(s),
    });
  } else {
    console.log('   (--no-deploy) skipping Vercel; folder left on disk.');
  }

  // 5) Result summary (machine-readable line for n8n to capture)
  const demoUrl = deploy.deployed ? deploy.url : '';
  const result = {
    lead: { name: config.business.name, niche: config.meta.niche, phone: config.business.phone, place_id: lead.place_id, channel: lead.channel || '' },
    lead_id: config.tracking.lead_id,
    folder,
    used_template: usedTemplate,
    config_path: path.join(folder, 'site.config.json'),
    demo_url: demoUrl,
    short_url: config.tracking.short_url,
    deployment_id: deploy.deploymentId || '',
    deployed: !!deploy.deployed,
    deploy_note: deploy.reason || deploy.error || '',
    generated_at: config.meta.generated_at,
  };
  try { fs.writeFileSync(path.join(folder, 'result.json'), JSON.stringify(result, null, 2), 'utf8'); } catch (_) {}

  console.log('\n────────────── DEMO BUILT ──────────────');
  console.log(`  Business:   ${result.lead.name}`);
  console.log(`  Niche:      ${result.lead.niche}`);
  console.log(`  Folder:     ${result.folder}`);
  console.log(`  Config:     ${result.config_path}`);
  console.log(`  Demo URL:   ${demoUrl || '(not deployed — see note)'}`);
  console.log(`  Short URL:  ${result.short_url}`);
  if (result.deploy_note) console.log(`  Note:       ${result.deploy_note}`);
  console.log('────────────────────────────────────────');
  console.log('RESULT ' + JSON.stringify(result));   // <-- n8n / orchestration parses this line
}

// Export the building blocks so n8n / other components can require() them.
module.exports = { composeConfig, buildFolder, renderStaticSite, selectLead, fetchSite, normalizeNiche, makeSlug, NICHE };

// ── SUPERSEDED CLI ───────────────────────────────────────────────────────────
// This file's *exports* are still live — generator/premium/build-premium.js imports
// selectLead() from here. But its command-line builder is the OLD path: it fills the
// legacy templates/<niche> apps and wires click tracking through the standalone
// tracker/ Next.js app, whose /track/* routes no longer exist in convex/http.ts
// (a link built this way logs no click and redirects wrong). The live builder is
// generator/premium/build-premium.js (Convex-native /r/ + /beacon). Running THIS
// file directly is disabled so nobody rebuilds the broken path by accident.
// To deliberately use the legacy builder, call runLegacyMain() below.
async function runLegacyMain() { return main(); }
module.exports.runLegacyMain = runLegacyMain;

if (require.main === module) {
  console.error(
    'build-demo.js is the SUPERSEDED builder (legacy templates + the retired tracker/ app,\n' +
    'whose /track/* routes no longer exist — links built here are NOT tracked).\n' +
    'Use the live builder instead:  node generator/premium/build-premium.js --lead-id <id>\n' +
    '(exports like selectLead are still used by build-premium.js and remain intact.)'
  );
  process.exitCode = 2;
}
