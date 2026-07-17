#!/usr/bin/env node
'use strict';
/**
 * host-and-seed.js — host template image assets on Vercel + seed all niches into Convex.
 *
 *   1. Stage every template's img/ + assets/ into  <tmp>/demo-assets/<niche>/...
 *   2. Deploy that folder to Vercel ONCE  → a stable public base URL
 *   3. Rewrite each layout.html's LOCAL img/ + assets/ refs → <base>/<niche>/...
 *   4. Push the rewritten template + manifest into Convex `demo_templates`
 *
 * After this, Convex serves every niche's demo on the fly at /demo/{leadId}, with
 * all images loading from Vercel's CDN. No per-lead deploy, no external computer.
 *
 *   node scripts/host-and-seed.js
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
(function loadEnv(f) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { return; }
  for (const l of t.split(/\r?\n/)) { const s = l.trim(); if (!s || s.startsWith('#')) continue; const e = s.indexOf('='); if (e < 0) continue; const k = s.slice(0, e).trim(); if (!k || process.env[k] != null) continue; let v = s.slice(e + 1).trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1); process.env[k] = v; }
})(path.join(ROOT, '.env.local'));

const PREM = path.join(ROOT, 'generator', 'premium');
const NICHE_DIR = { electrician: '11-electrical', hvac: '03-hvac', plumber: '01-plumber', roofing: '02-roofing' };
const { deployFolder } = require(path.join(ROOT, 'generator', 'deploy-vercel'));

function copyDir(src, dst) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

// Rewrite LOCAL relative asset refs (img/… , assets/…) to the hosted base URL.
// Anchors on the quote/paren just before the folder so absolute URLs are untouched.
function rewriteAssets(html, base, niche) {
  const p = `${base}/${niche}/`;
  return html
    .split('"img/').join('"' + p + 'img/')
    .split("'img/").join("'" + p + 'img/')
    .split('(img/').join('(' + p + 'img/')
    .split('"assets/').join('"' + p + 'assets/')
    .split("'assets/").join("'" + p + 'assets/')
    .split('(assets/').join('(' + p + 'assets/');
}

async function main() {
  // 1) stage assets
  const stage = path.join(os.tmpdir(), 'voltaris-demo-assets');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  fs.writeFileSync(path.join(stage, 'index.html'), '<!doctype html><title>demo assets</title>ok', 'utf8');
  let staged = 0;
  for (const [niche, dir] of Object.entries(NICHE_DIR)) {
    const tdir = path.join(PREM, 'templates', dir);
    copyDir(path.join(tdir, 'img'), path.join(stage, niche, 'img'));
    copyDir(path.join(tdir, 'assets'), path.join(stage, niche, 'assets'));
    staged++;
  }
  console.log(`staged ${staged} niches → ${stage}`);

  // 2) deploy to Vercel once
  const res = await deployFolder(stage, {
    token: process.env.VERCEL_TOKEN, teamId: process.env.VERCEL_TEAM_ID,
    name: 'voltaris-demo-assets', target: 'production', log: (m) => console.log(m),
  });
  if (!res.deployed || !res.url) throw new Error('Vercel deploy failed: ' + (res.error || res.reason || 'unknown'));
  const base = res.url.replace(/\/$/, '');
  console.log('ASSETS BASE URL:', base);

  // 3) rewrite + seed each niche
  const { ConvexHttpClient } = require('convex/browser');
  const { makeFunctionReference } = require('convex/server');
  const client = new ConvexHttpClient(process.env.CONVEX_URL);
  for (const niche of Object.keys(NICHE_DIR)) {
    const htmlPath = path.join(PREM, 'templates', NICHE_DIR[niche], 'layout.html');
    const manPath = path.join(PREM, 'manifests', niche + '.json');
    if (!fs.existsSync(htmlPath) || !fs.existsSync(manPath)) { console.log(`skip ${niche}: missing`); continue; }
    const html = rewriteAssets(fs.readFileSync(htmlPath, 'utf8'), base, niche);
    const manifest = JSON.parse(fs.readFileSync(manPath, 'utf8'));
    const leftover = (html.match(/(?:src|href|poster)=["']img\//g) || []).length + (html.match(/["']assets\//g) || []).length;
    const r = await client.mutation(makeFunctionReference('demoTemplates:upsertTemplate'), { niche, html, manifest });
    console.log(`OK ${niche}: ${r.replaced ? 'replaced' : 'inserted'} (${r.bytes} bytes), local refs left: ${leftover}`);
  }
  console.log('\nDONE. Every niche now builds + serves from Convex with Vercel-hosted images.');
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
