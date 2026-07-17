#!/usr/bin/env node
/**
 * image-gate.js — pick which of a lead's SCRAPED photos are good enough to use.
 * ============================================================================
 * Real-or-nothing (operator's rule): NO generation, NO upscaling. We keep the
 * lead's genuine job photos and let the template's stock fill the rest.
 *
 * Pipeline per candidate URL:
 *   1) download (SSRF-guarded, size-capped)
 *   2) junk filter — dimensions / aspect / filesize / filename heuristics kill
 *      logos, icons, banners, clip-art, tiny thumbnails
 *   3) AI quality+relevance gate (Qwen vision, OpenAI-compatible) — "is this a
 *      real photo of {trade} work, good enough for a website?" keep/reject +caption
 *   4) rank keepers, hand back local files ready to drop into gallery slots
 *
 * Dependency-free (built-in fetch + a tiny image-header size sniffer). Vision is
 * OPTIONAL: no VISION_API_KEY (or an error) → junk-filter-only fallback.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');

(function loadEnv(f) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { return; }
  for (const l of t.split(/\r?\n/)) { const s = l.trim(); if (!s || s.startsWith('#')) continue; const e = s.indexOf('='); if (e < 0) continue; const k = s.slice(0, e).trim(); if (!k || process.env[k] != null) continue; let v = s.slice(e + 1).trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1); else { const h = v.indexOf(' #'); if (h >= 0) v = v.slice(0, h).trim(); } process.env[k] = v; }
})(path.join(ROOT, '.env.local'));

const V_BASE = (process.env.VISION_BASE_URL || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '');
const V_MODEL = process.env.VISION_MODEL || 'qwen/qwen3.5-397b-a17b';
const V_KEY = process.env.VISION_API_KEY || '';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36';

// tuneables
const MIN_LONG_EDGE = 380;      // px — smaller than this reads blurry at 600px+ slots
const MIN_BYTES = 9000;         // < ~9KB is almost always an icon/sprite
const MAX_AI_BYTES = 240000;    // skip the vision call on very large payloads (decide by heuristics)
const MAX_ASPECT = 3.2;         // banners / rule strips

// ── SSRF guard ───────────────────────────────────────────────────────────────
function blockedHost(u) { let h; try { h = new URL(u).hostname.toLowerCase(); } catch (_) { return true; }
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/); if (m) { const a = +m[1], b = +m[2]; if (a === 127 || a === 10 || a === 0 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31)) return true; } return false; }

async function fetchImage(url, ms = 10000, maxBytes = 3_000_000) {
  if (blockedHost(url)) return null;
  const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA } });
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (!r.ok || !/image\//.test(ct)) { clearTimeout(t); return null; }
    const ab = await r.arrayBuffer(); clearTimeout(t);
    const buf = Buffer.from(ab);
    if (buf.length > maxBytes) return null;
    return { buffer: buf, contentType: ct };
  } catch (_) { clearTimeout(t); return null; }
}

// ── tiny image dimension sniffer (JPEG/PNG/GIF/WebP), no deps ─────────────────
function imageSize(buf) {
  if (!buf || buf.length < 24) return null;
  // PNG
  if (buf[0] === 0x89 && buf[1] === 0x50) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), type: 'png' };
  // GIF
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8), type: 'gif' };
  // JPEG — walk the markers to the first SOF
  if (buf[0] === 0xFF && buf[1] === 0xD8) {
    let o = 2;
    while (o < buf.length - 8) {
      if (buf[o] !== 0xFF) { o++; continue; }
      const marker = buf[o + 1];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return { h: buf.readUInt16BE(o + 5), w: buf.readUInt16BE(o + 7), type: 'jpg' };
      }
      const len = buf.readUInt16BE(o + 2); if (len < 2) break; o += 2 + len;
    }
    return { w: 0, h: 0, type: 'jpg' };
  }
  // WebP
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const f = buf.toString('ascii', 12, 16);
    try {
      if (f === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff, type: 'webp' };
      if (f === 'VP8L') { const b = buf.slice(21, 25); const w = 1 + (((b[1] & 0x3f) << 8) | b[0]); const h = 1 + (((b[3] & 0xf) << 10) | (b[2] << 2) | ((b[1] & 0xc0) >> 6)); return { w, h, type: 'webp' }; }
      if (f === 'VP8X') return { w: 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16)), h: 1 + (buf[27] | (buf[28] << 16) | (buf[29] << 16)), type: 'webp' };
    } catch (_) {}
    return { w: 0, h: 0, type: 'webp' };
  }
  return null;
}

function extFor(type, ct) { if (type) return type === 'jpg' ? 'jpg' : type; if (/png/.test(ct)) return 'png'; if (/webp/.test(ct)) return 'webp'; if (/gif/.test(ct)) return 'gif'; return 'jpg'; }

// ── junk filter (cheap heuristics) ───────────────────────────────────────────
function junkFilter(url, buf, size) {
  const name = (() => { try { return new URL(url).pathname.toLowerCase(); } catch (_) { return url.toLowerCase(); } })();
  if (/logo|icon|favicon|sprite|banner|badge|placeholder|avatar|header|footer|bg-|background|pattern|divider|spinner|loader/.test(name)) return { ok: false, reason: 'filename looks like UI/branding art' };
  if (buf.length < MIN_BYTES) return { ok: false, reason: `tiny file (${buf.length}B)` };
  if (size && size.w && size.h) {
    const long = Math.max(size.w, size.h), shortE = Math.min(size.w, size.h);
    if (long < MIN_LONG_EDGE) return { ok: false, reason: `too small (${size.w}x${size.h})` };
    if (shortE && long / shortE > MAX_ASPECT) return { ok: false, reason: `banner aspect (${size.w}x${size.h})` };
  }
  if (size && size.type === 'gif') return { ok: false, reason: 'gif (usually icon/animation)' };
  return { ok: true };
}

// ── AI quality + relevance gate (vision) ─────────────────────────────────────
const GATE_PROMPT = (niche) => `You are screening ONE image scraped from a ${niche} company's own website to decide if it can go in the "recent work" gallery of their new website.
Return ONLY compact JSON: {"is_real_photo": bool, "acceptable_quality": bool, "relevant": bool, "keep": bool, "caption": string, "reason": string}
- is_real_photo: a genuine PHOTOGRAPH. false for a logo, icon, clip-art, illustration, graphic, screenshot, map, chart, or text/title banner.
- acceptable_quality: usable on a website. Reject ONLY if SEVERELY blurry, watermarked, pixelated, or distorted. A plain, modestly-sized, or ordinary snapshot IS acceptable.
- relevant: it shows this business's real world — a jobsite, a finished project, a building or storefront they worked on, their premises, crew, vehicle, tools, or equipment. A plain photo of a completed commercial building or job location from their projects page COUNTS as relevant. Reject only clearly-unrelated generic stock (random people, sunsets, memes).
- keep: true if is_real_photo AND acceptable_quality AND relevant.
- caption: if keep, a short 2-5 word caption (e.g. "Commercial build-out"). Else "".
Be lenient on relevance and quality; be strict only about it being a REAL PHOTO (not a graphic).`;

async function aiGate(niche, buffer, contentType) {
  if (!V_KEY) return null;
  const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
  const body = JSON.stringify({
    model: V_MODEL, max_tokens: 300, temperature: 0,
    messages: [{ role: 'user', content: [{ type: 'text', text: GATE_PROMPT(niche) }, { type: 'image_url', image_url: { url: dataUrl } }] }],
  });
  for (let a = 1; a <= 2; a++) {
    try {
      const r = await fetch(V_BASE + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + V_KEY, 'Content-Type': 'application/json' }, body });
      const txt = await r.text(); if (!r.ok) throw new Error('HTTP ' + r.status);
      let c = (JSON.parse(txt).choices[0].message.content || '').replace(/```json|```/gi, '').trim();
      const mm = c.match(/\{[\s\S]*\}/); if (!mm) throw new Error('no json');
      return JSON.parse(mm[0]);
    } catch (e) { if (a === 2) return null; await new Promise((r) => setTimeout(r, 1200)); }
  }
}

/**
 * gateAndDownload — the full pipeline.
 * @returns { kept: [{srcPath,name,caption,alt,w,h,bytes,reason}], considered, rejected: [{url,reason}] }
 */
async function gateAndDownload(niche, imageUrls, workDir, maxKeep = 4) {
  fs.mkdirSync(workDir, { recursive: true });
  const urls = [...new Set((imageUrls || []).filter(Boolean))].slice(0, 12);
  const rejected = [];

  // Phase 1 — download + junk filter (fast, sequential)
  const passed = [];
  for (const url of urls) {
    const got = await fetchImage(url);
    if (!got) { rejected.push({ url, reason: 'download failed / not an image' }); continue; }
    const size = imageSize(got.buffer) || { w: 0, h: 0, type: null };
    const jf = junkFilter(url, got.buffer, size);
    if (!jf.ok) { rejected.push({ url, reason: jf.reason }); continue; }
    passed.push({ url, buffer: got.buffer, size, contentType: got.contentType });
  }

  // Phase 2 — AI quality/relevance gate (parallel, bounded concurrency)
  const CONC = 5;
  const survivors = [];
  for (let i = 0; i < passed.length; i += CONC) {
    const batch = passed.slice(i, i + CONC);
    const verdicts = await Promise.all(batch.map(async (p) => {
      if (V_KEY && p.buffer.length <= MAX_AI_BYTES) { const ai = await aiGate(niche, p.buffer, p.contentType); if (ai) return ai; }
      return { keep: true, caption: '', reason: 'heuristic keep (no/skip vision)' };
    }));
    batch.forEach((p, j) => {
      const v = verdicts[j];
      if (!v.keep) { rejected.push({ url: p.url, reason: 'AI: ' + (v.reason || 'rejected') }); return; }
      const long = Math.max(p.size.w, p.size.h) || 0;
      const score = long + (p.size.w >= p.size.h ? 200 : 0) + p.buffer.length / 10000;
      survivors.push({ url: p.url, buffer: p.buffer, size: p.size, contentType: p.contentType, caption: v.caption || '', reason: v.reason || '', score });
    });
  }

  survivors.sort((a, b) => b.score - a.score);
  const kept = [];
  survivors.slice(0, maxKeep).forEach((s, i) => {
    const ext = extFor(s.size.type, s.contentType);
    const name = `lead-photo-${i + 1}.${ext}`;
    const srcPath = path.join(workDir, name);
    fs.writeFileSync(srcPath, s.buffer);
    kept.push({ srcPath, name, caption: s.caption, alt: s.caption || `${niche} project`, w: s.size.w, h: s.size.h, bytes: s.buffer.length, reason: s.reason });
  });
  return { kept, considered: urls.length, rejected };
}

module.exports = { gateAndDownload, fetchImage, imageSize, junkFilter, aiGate };

// ── CLI (debug): node image-gate.js <niche> <url> [url...] ────────────────────
if (require.main === module) {
  (async () => {
    const [niche, ...urls] = process.argv.slice(2);
    if (!urls.length) { console.error('usage: node image-gate.js <niche> <imageUrl> [imageUrl...]'); process.exitCode = 1; return; }
    const wd = path.join(require('os').tmpdir(), 'imggate-' + niche);
    const r = await gateAndDownload(niche, urls, wd, 6);
    console.log(`considered ${r.considered} · kept ${r.kept.length}`);
    r.kept.forEach((k) => console.log(`  KEEP ${k.w}x${k.h} ${Math.round(k.bytes / 1024)}KB "${k.caption}" (${k.reason}) -> ${k.name}`));
    r.rejected.forEach((x) => console.log(`  drop ${x.url.slice(0, 70)} — ${x.reason}`));
  })().catch((e) => { console.error('Fatal:', e.message); process.exitCode = 1; });
}
