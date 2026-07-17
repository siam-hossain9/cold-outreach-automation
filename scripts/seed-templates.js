#!/usr/bin/env node
'use strict';
/**
 * seed-templates.js — push premium templates + manifests into the Convex
 * `demo_templates` table so Convex can build+serve demos with no external computer.
 *
 *   node scripts/seed-templates.js hvac            # one niche
 *   node scripts/seed-templates.js                 # all self-contained niches
 *
 * A niche is only seeded if its template references NO local images (fully
 * web-hosted), so the Convex-served page is self-contained. Others need their
 * images hosted first (Convex file storage) — reported, not silently shipped.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
(function loadEnv(f) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { return; }
  for (const l of t.split(/\r?\n/)) { const s = l.trim(); if (!s || s.startsWith('#')) continue; const e = s.indexOf('='); if (e < 0) continue; const k = s.slice(0, e).trim(); if (!k || process.env[k] != null) continue; let v = s.slice(e + 1).trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1); process.env[k] = v; }
})(path.join(ROOT, '.env.local'));

const PREM = path.join(ROOT, 'generator', 'premium');
const NICHE_DIR = { electrician: '11-electrical', hvac: '03-hvac', plumber: '01-plumber', roofing: '02-roofing' };

function localImgCount(html) {
  return (html.match(/(?:src|href)=["']img\//g) || []).length
    + (html.match(/url\(['"]?img\//g) || []).length;
}

async function main() {
  const want = process.argv.slice(2).filter(Boolean);
  const niches = want.length ? want : Object.keys(NICHE_DIR);

  const { ConvexHttpClient } = require('convex/browser');
  const { makeFunctionReference } = require('convex/server');
  const CONVEX_URL = process.env.CONVEX_URL;
  if (!CONVEX_URL) throw new Error('CONVEX_URL not set');
  const client = new ConvexHttpClient(CONVEX_URL);

  for (const niche of niches) {
    const dir = NICHE_DIR[niche];
    if (!dir) { console.log(`skip ${niche}: unknown niche`); continue; }
    const htmlPath = path.join(PREM, 'templates', dir, 'layout.html');
    const manPath = path.join(PREM, 'manifests', niche + '.json');
    if (!fs.existsSync(htmlPath) || !fs.existsSync(manPath)) { console.log(`skip ${niche}: template or manifest missing`); continue; }
    const html = fs.readFileSync(htmlPath, 'utf8');
    const manifest = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    const local = localImgCount(html);
    if (local > 0) {
      console.log(`SKIP ${niche}: ${local} local image ref(s) — needs image hosting first (not self-contained).`);
      continue;
    }
    const res = await client.mutation(makeFunctionReference('demoTemplates:upsertTemplate'), { niche, html, manifest });
    console.log(`OK   ${niche}: ${res.replaced ? 'replaced' : 'inserted'} (${res.bytes} bytes) as niche="${res.niche}"`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
