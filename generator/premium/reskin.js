#!/usr/bin/env node
/**
 * reskin.js — turn a PREMIUM Web_Project template into a lead's demo.
 * ============================================================================
 * Recipe (locked with the operator): KEEP the template's rich content, swap in
 * the lead's IDENTITY + a few REAL FACTS, and drop the lead's REAL PHOTOS into
 * the gallery slots (real-or-nothing — no generated/upscaled images).
 *
 * Manifest-driven: every source token lives in manifests/<niche>.json, verified
 * against the actual template file, so this engine stays template-agnostic.
 *
 * A hard residual check throws if any brand/city/phone source token survives —
 * a half-reskinned demo (e.g. leftover "Voltline"/"Seattle") never ships.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const PREMIUM_DIR = __dirname;
const TPL_DIR = path.join(PREMIUM_DIR, 'templates');
const MAN_DIR = path.join(PREMIUM_DIR, 'manifests');

const NICHE_ALIAS = {
  electrician: 'electrician', electric: 'electrician', electrical: 'electrician',
  hvac: 'hvac', 'heating-and-air': 'hvac', 'heating & air': 'hvac', ac: 'hvac',
  plumber: 'plumber', plumbing: 'plumber',
  roofing: 'roofing', roofer: 'roofing', roof: 'roofing',
};

function resolveNiche(raw) {
  const k = String(raw || '').toLowerCase().trim();
  return NICHE_ALIAS[k] || 'electrician';
}

function loadManifest(niche) {
  const n = resolveNiche(niche);
  const p = path.join(MAN_DIR, n + '.json');
  if (!fs.existsSync(p)) throw new Error(`no premium manifest for niche "${n}" (${p})`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

// ── small helpers ────────────────────────────────────────────────────────────
const esc = (s) => String(s == null ? '' : s);
function digits(s) { return String(s || '').replace(/\D/g, ''); }
function toHref(phoneDisplay) { const d = digits(phoneDisplay); return '+' + (d.length === 10 ? '1' + d : d); }
function areaCode(phoneDisplay) { const d = digits(phoneDisplay); const t = d.length === 11 ? d.slice(1) : d; return t.slice(0, 3) || '000'; }
function firstWord(name) { return String(name || '').trim().split(/\s+/)[0] || 'Demo'; }
const MONO_STOP = new Set(['the', 'and', 'of', 'a', 'an', 'inc', 'llc', 'co', 'corp', 'company', 'ltd', 'services', 'service', 'group']);
function monogramFromName(name) {
  const words = String(name || '').replace(/&/g, ' ').split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, '')).filter((w) => w && !MONO_STOP.has(w.toLowerCase()));
  if (!words.length) return 'XX';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
function domainFromName(name) { return String(name || 'demo').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '') + '.com'; }

/**
 * Build the full leadInfo the engine needs, filling sane defaults from the
 * minimal fields a lead always has (name, phone, city, state).
 */
function normalizeLeadInfo(raw) {
  const name = esc(raw.name).trim() || 'Demo Company';
  const phoneDisplay = esc(raw.phoneDisplay || raw.phone).trim();
  const li = {
    name,
    short: esc(raw.short).trim() || firstWord(name),
    monogram: esc(raw.monogram).trim() || monogramFromName(name),
    domain: esc(raw.domain).trim() || domainFromName(name),
    email: esc(raw.email).trim() || ('office@' + domainFromName(name)),
    phoneDisplay,
    phoneHref: esc(raw.phoneHref).trim() || toHref(phoneDisplay),
    phonePlaceholder: esc(raw.phonePlaceholder).trim() || ('(' + areaCode(phoneDisplay) + ') 000-0000'),
    city: esc(raw.city).trim() || 'your area',
    state: esc(raw.state).trim() || '',
    county: esc(raw.county).trim() || '',
    regionName: esc(raw.regionName).trim(),
    serviceAreas: (Array.isArray(raw.serviceAreas) ? raw.serviceAreas : [])
      .map((s) => esc(s).trim()).filter(Boolean),
    license: esc(raw.license).trim(),
    ownerName: esc(raw.ownerName).trim(),
    ownerTitle: esc(raw.ownerTitle).trim(),
    yearFounded: raw.yearFounded ? parseInt(raw.yearFounded, 10) : null,
    realPhotos: (Array.isArray(raw.realPhotos) ? raw.realPhotos : []),
  };
  if (!li.regionName) li.regionName = li.city + ' area';
  // de-dupe service areas, drop the primary city (it is handled separately)
  const seen = new Set([li.city.toLowerCase()]);
  li.serviceAreas = li.serviceAreas.filter((a) => { const k = a.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  return li;
}

// ── the reskin ───────────────────────────────────────────────────────────────
function reskinHtml(manifest, html, leadInfoRaw) {
  const li = normalizeLeadInfo(leadInfoRaw);
  const m = manifest;
  const swap = (a, b) => { if (a) html = html.split(a).join(b); };
  const report = { niche: manifest.niche, photosPlaced: 0, serviceAreasUsed: [] };

  // 0) real photos FIRST — a gallery <img> tag can carry brand/city tokens in its alt, so
  //    place photos before identity swaps mutate those tokens. Preserve each tag's own
  //    attributes (class/width/height/loading); rewrite only src + alt.
  const galDir = (manifest.galleryImageDir || 'assets/_img').replace(/\/$/, '');
  const slots = manifest.gallerySlots || [];
  const nPlace = Math.min(slots.length, li.realPhotos.length);
  for (let i = 0; i < nPlace; i++) {
    const slot = slots[i]; const photo = li.realPhotos[i];
    const alt = esc(photo.alt || photo.caption || (li.name + ' project')).replace(/"/g, '&quot;');
    let newTag = slot.imgTag.replace(/\bsrc="[^"]*"/, `src="${galDir}/${photo.name}"`);
    newTag = /\balt="[^"]*"/.test(newTag) ? newTag.replace(/\balt="[^"]*"/, `alt="${alt}"`) : newTag.replace('<img', `<img alt="${alt}"`);
    swap(slot.imgTag, newTag);
    if (photo.caption && slot.caption) swap('>' + slot.caption + '<', '>' + photo.caption + '<');
  }
  report.photosPlaced = nPlace;

  // 1) identity — email, full brand (+alias entity forms), domain, short brand (order matters)
  swap(m.brand.email, li.email);
  swap(m.brand.full, li.name);
  for (const a of (m.brand.fullAliases || [])) swap(a, li.name);
  swap(m.brand.domain, li.domain);
  swap(m.brand.short, m.brand.shortIsMonogram ? li.monogram : li.short);

  // 2) phones (display, tel: href, and the form input placeholder)
  swap(m.phones.display, li.phoneDisplay);
  swap(m.phones.href, li.phoneHref);
  swap(m.phones.formPlaceholder, li.phonePlaceholder);

  // 3) license — longest source first (manifest is ordered that way); all → one line
  const licenseLine = li.license || 'Licensed and insured';
  for (const src of (m.license.sources || [])) swap(src, licenseLine);

  // 4) geography — phrases LONGEST-first (combined region forms before bare county/city), then areas, city, state
  const phrases = [];
  if (m.geo.countyPhrase) phrases.push({ from: m.geo.countyPhrase, to: li.county || li.regionName });
  for (const rp of (m.geo.regionPhrases || [])) phrases.push({ from: rp, to: rp.startsWith('and ') ? ('and ' + li.regionName) : li.regionName });
  phrases.sort((a, b) => b.from.length - a.from.length);
  for (const p of phrases) swap(p.from, p.to);
  const targets = li.serviceAreas.length ? li.serviceAreas : [li.city];
  const areaSrcs = [].concat(m.geo.areasMultiWord || [], m.geo.areas || []);
  areaSrcs.forEach((src, i) => { const t = targets[i % targets.length]; swap(src, t); if (!report.serviceAreasUsed.includes(t)) report.serviceAreasUsed.push(t); });
  swap(m.geo.city, li.city);
  if (m.geo.stateAbbr && li.state) html = html.replace(new RegExp('\\b' + m.geo.stateAbbr + '\\b', 'g'), li.state);

  // 5) real facts — owner credential + "since {year}" (only when we actually know them)
  if (li.ownerName && m.facts.credentialSubSource) {
    const title = li.ownerTitle || 'Owner';
    swap(m.facts.credentialSubSource, `<span>${li.ownerName}, ${title}, bonded and insured.</span>`);
  }
  if (li.yearFounded) {
    if (m.facts.ownCrewsToken) swap(m.facts.ownCrewsToken, '<b>+</b>Since ' + li.yearFounded);
    if (m.facts.sinceAnchor) swap(m.facts.sinceAnchor, m.facts.sinceAnchor + ' Serving ' + li.regionName + ' since ' + li.yearFounded + '.');
  }

  // 5b) template-specific extras — leftover demo tokens the generic swaps miss (KC, owner names, …)
  const subst = (s) => String(s).replace(/\{city\}/g, li.city).replace(/\{region\}/g, li.regionName).replace(/\{state\}/g, li.state).replace(/\{name\}/g, li.name).replace(/\{short\}/g, li.short).replace(/\{county\}/g, li.county || li.regionName);
  for (const er of (m.extraReplacements || [])) swap(er.from, subst(er.to));

  // 7) residual guard — no source identity token may survive
  const mustBeGone = [
    ['brand', m.brand.full], ['brand', m.brand.short], ['domain', m.brand.domain], ['email', m.brand.email],
    ['phone', m.phones.display], ['phoneHref', m.phones.href], ['city', m.geo.city],
    ...(m.geo.areasMultiWord || []).map((a) => ['area', a]),
    ...(m.geo.areas || []).map((a) => ['area', a]),
  ];
  const residuals = mustBeGone.filter(([, tok]) => tok && html.includes(tok)).map(([kind, tok]) => `${kind}:"${tok}"`);
  if (residuals.length) throw new Error('reskin residual tokens survived: ' + residuals.join(', '));

  return { html, report, leadInfo: li };
}

// ── assemble a deployable folder ─────────────────────────────────────────────
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

function buildPremiumFolder(niche, leadInfo, outDir) {
  const manifest = loadManifest(niche);
  const tdir = path.join(TPL_DIR, manifest.templateDir);
  const templateFile = path.join(tdir, manifest.file);
  if (!fs.existsSync(templateFile)) throw new Error('template file missing: ' + templateFile);

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });
  for (const ad of (manifest.assetDirs || [])) {
    const s = path.join(tdir, ad);
    if (fs.existsSync(s)) copyDir(s, path.join(outDir, ad));
  }

  // copy the lead's gated real photos into the gallery image dir under their target names
  const galDir = path.join(outDir, (manifest.galleryImageDir || 'assets/_img'));
  fs.mkdirSync(galDir, { recursive: true });
  const photos = (leadInfo.realPhotos || []).filter((p) => p && p.srcPath && p.name);
  for (const p of photos) { try { fs.copyFileSync(p.srcPath, path.join(galDir, p.name)); } catch (e) { p._copyError = e.message; } }

  const html = fs.readFileSync(templateFile, 'utf8');
  const { html: out, report, leadInfo: li } = reskinHtml(manifest, html, leadInfo);
  fs.writeFileSync(path.join(outDir, 'index.html'), out, 'utf8');

  return { outDir, manifest: manifest.niche, template: manifest.templateDir, report, leadInfo: li };
}

module.exports = { resolveNiche, loadManifest, normalizeLeadInfo, reskinHtml, buildPremiumFolder };
