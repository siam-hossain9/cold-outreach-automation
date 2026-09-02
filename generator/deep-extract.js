#!/usr/bin/env node
/**
 * deep-extract.js — DEEP scrape a lead's old site + AI-extract rich, real info.
 * ============================================================================
 * Point 1 (deep scrape): crawl the homepage + the most useful internal pages
 *   (about / services / contact / gallery …), not just one page.
 * Point 3 (AI extraction): feed all that raw text to the vision/LLM model, which
 *   returns clean STRUCTURED JSON — real services, story, hours, service areas,
 *   years, license, real testimonials — using ONLY facts found on the site.
 *
 * The richer this output, the less the demo looks templated. Missing fields come
 * back null so the template's tasteful defaults fill the gaps.
 *
 * USAGE
 *   node generator/deep-extract.js https://example-electric.com/ "Northside Electric Co" electrician
 *
 * Env (.env.local): VISION_BASE_URL, VISION_MODEL, VISION_API_KEY
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

(function loadEnv(f) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { return; }
  for (const l of t.split(/\r?\n/)) { const s = l.trim(); if (!s || s.startsWith('#')) continue; const e = s.indexOf('='); if (e < 0) continue; const k = s.slice(0, e).trim(); if (!k || process.env[k] != null) continue; let v = s.slice(e + 1).trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1); else { const h = v.indexOf(' #'); if (h >= 0) v = v.slice(0, h).trim(); } process.env[k] = v; }
})(path.join(ROOT, '.env.local'));

const V_BASE = (process.env.VISION_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
const V_MODEL = process.env.VISION_MODEL || 'qwen/qwen3.5-397b-a17b';
const V_KEY = process.env.VISION_API_KEY || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

// ─── SSRF guard (block internal hosts) ───────────────────────────────────────
function blockedHost(u) { let h; try { h = new URL(u).hostname.toLowerCase(); } catch (_) { return true; }
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/); if (m) { const a = +m[1], b = +m[2]; if (a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true; } return false; }

async function fetchPage(url, ms = 9000) {
  if (blockedHost(url)) return null;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try { const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA } });
    const ct = r.headers.get('content-type') || ''; if (!r.ok || !/html/i.test(ct)) { clearTimeout(t); return null; }
    const html = (await r.text()).slice(0, 400000); clearTimeout(t); return { html, finalUrl: r.url || url };
  } catch (_) { clearTimeout(t); return null; }
}

// visible text from HTML
function toText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&quot;/g, '"')
    .replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

// internal links, prioritized by usefulness
function findLinks(html, baseUrl) {
  const host = (() => { try { return new URL(baseUrl).hostname; } catch (_) { return ''; } })();
  const out = new Map();
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]+)["']/gi)) {
    let u; try { u = new URL(m[1], baseUrl); } catch (_) { continue; }
    if (u.hostname !== host) continue;
    if (!/^https?:/.test(u.protocol)) continue;
    if (/\.(pdf|jpg|jpeg|png|gif|zip|mp4|webm|svg|css|js|xml)$/i.test(u.pathname)) continue;
    const key = u.origin + u.pathname.replace(/\/$/, '');
    const p = u.pathname.toLowerCase();
    const score = /about|our-?story|company|who-?we/.test(p) ? 5 : /service|what-?we|solution/.test(p) ? 5
      : /gallery|project|work|portfolio/.test(p) ? 4 : /review|testimonial/.test(p) ? 4
      : /contact|area|location/.test(p) ? 3 : /faq|pricing/.test(p) ? 2 : 1;
    if (!out.has(key) || out.get(key).score < score) out.set(key, { url: u.href, score });
  }
  return [...out.values()].sort((a, b) => b.score - a.score).map(x => x.url);
}

// on-domain image URLs (real photos)
function findImages(html, baseUrl) {
  const host = (() => { try { return new URL(baseUrl).hostname; } catch (_) { return ''; } })();
  const imgs = new Set();
  for (const m of html.matchAll(/<img[^>]+src\s*=\s*["']([^"']+)["']/gi)) {
    let u; try { u = new URL(m[1], baseUrl); } catch (_) { continue; }
    if (u.hostname === host && /\.(jpe?g|png|webp)$/i.test(u.pathname) && !/logo|icon|favicon|sprite|placeholder/i.test(u.pathname)) imgs.add(u.href);
  }
  return [...imgs].slice(0, 12);
}

// ─── Deep scrape: homepage + top internal pages ─────────────────────────────
async function deepScrape(startUrl, maxPages = 6) {
  const first = await fetchPage(startUrl);
  if (!first) return { pages: [], combined: '', images: [] };
  const base = first.finalUrl;
  const links = findLinks(first.html, base).filter(u => u.replace(/\/$/, '') !== base.replace(/\/$/, '')).slice(0, maxPages - 1);
  const pages = [{ url: base, text: toText(first.html) }];
  const images = new Set(findImages(first.html, base));
  for (const link of links) {
    const p = await fetchPage(link);
    if (p) { pages.push({ url: link, text: toText(p.html) }); findImages(p.html, base).forEach(i => images.add(i)); }
  }
  // combine, cap for the model context
  let combined = pages.map(p => `## PAGE: ${p.url}\n${p.text}`).join('\n\n').slice(0, 18000);
  return { pages, combined, images: [...images].slice(0, 12) };
}

// ─── AI extraction: raw text → structured JSON (facts only) ──────────────────
const EXTRACT_PROMPT = (name, niche, text) => `You are extracting REAL business facts from a ${niche} company's website to rebuild their site. Use ONLY facts present in the TEXT — never invent. For anything not found, use null (or [] for lists). Return ONLY compact JSON, no markdown:
{
 "business_name": string,
 "tagline": string|null,
 "about": string|null,            // their real story/description, cleaned up, 1-3 sentences
 "years_established": number|null, // the YEAR they started (e.g. 1986), if stated
 "license": string|null,
 "email": string|null,
 "services": [{"name": string, "description": string|null}],  // their REAL services
 "service_areas": [string],       // cities/areas they serve
 "hours": object|null,            // {"mon":"8am-5pm",...} only if stated
 "testimonials": [{"name": string|null, "quote": string, "rating": number|null}],  // real reviews on the site
 "specialties": [string],         // certifications, brands, awards, differentiators
 "primary_color": string|null     // brand hex if obvious
}
Business: "${name}". TEXT:
${text}`;

async function aiExtract(name, niche, text) {
  if (!V_KEY) throw new Error('VISION_API_KEY not set');
  const body = JSON.stringify({ model: V_MODEL, messages: [{ role: 'user', content: EXTRACT_PROMPT(name, niche, text) }], max_tokens: 1200, temperature: 0 });
  for (let a = 1; a <= 3; a++) {
    try {
      const r = await fetch(V_BASE + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + V_KEY, 'Content-Type': 'application/json' }, body });
      const txt = await r.text(); if (!r.ok) throw new Error('AI HTTP ' + r.status + ': ' + txt.slice(0, 150));
      let c = (JSON.parse(txt).choices[0].message.content || '').replace(/```json|```/gi, '').trim();
      const mm = c.match(/\{[\s\S]*\}/); if (!mm) throw new Error('no JSON');
      return JSON.parse(mm[0]);
    } catch (e) { if (a === 3) throw e; await new Promise(r => setTimeout(r, 1500 * a)); }
  }
}

async function extractRich(url, name, niche) {
  const scrape = await deepScrape(url);
  if (!scrape.combined) return { ok: false, error: 'could not scrape site', images: [] };
  const info = await aiExtract(name, niche, scrape.combined);
  return { ok: true, info, images: scrape.images, pagesScraped: scrape.pages.map(p => p.url) };
}

module.exports = { deepScrape, aiExtract, extractRich };

// ─── CLI ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const [url, name, niche] = process.argv.slice(2);
    if (!url) { console.error('usage: node deep-extract.js <url> "<Business Name>" <niche>'); process.exitCode = 1; return; }
    console.log(`\n🕸️  Deep-scraping ${url} …`);
    const scrape = await deepScrape(url);
    console.log(`   pages read: ${scrape.pages.length}`); scrape.pages.forEach(p => console.log('     ·', p.url));
    console.log(`   real photos found: ${scrape.images.length}`);
    console.log(`   text collected: ${scrape.combined.length} chars`);
    if (!scrape.combined) { console.error('   ✗ nothing to extract'); return; }
    console.log(`\n🧠  AI-extracting real info (${V_MODEL}) …`);
    const info = await aiExtract(name || '', niche || 'contractor', scrape.combined);
    console.log('\n────────── EXTRACTED REAL INFO ──────────');
    console.log(JSON.stringify(info, null, 2));
    console.log('\nReal photos:'); scrape.images.forEach(i => console.log('  ·', i));
  })().catch(e => { console.error('Fatal:', e.message); process.exitCode = 1; });
}
