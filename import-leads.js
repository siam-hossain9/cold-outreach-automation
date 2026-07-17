#!/usr/bin/env node
/**
 * import-leads.js  —  GLUE: scraper CSV  →  Convex `leads` table
 * ============================================================================
 * Reads a scraper `leads-*.csv` (produced by scraper/find-ugly-sites.js) and
 * inserts each row into the NEW dedicated Convex database's `leads` table via
 * the Convex HTTP client (CONVEX_URL). This is the hand-off between the finished
 * scraper and the rest of the call-first funnel.
 *
 * WHAT IT DOES
 *   1. Loads secrets from .env.local (never hardcoded).
 *   2. Reads a leads-*.csv (arg, --file, or the newest scraper/leads-*.csv).
 *   3. Maps each CSV column → the exact `leads` schema field (convex/schema.ts):
 *        Lead Name    → name            Website URL   → website
 *        Phone        → phone (E.164)   Niche         → niche (normalised)
 *        City/State/  → city/state/zip  Ugly Score    → ugly_score
 *        ZIP                            Rank Score    → rank_score
 *        Ugly Reasons → ugly_reasons    Vision Reasons→ vision_reasons
 *        place_id     → place_id        Channel       → channel (re-derived, see below)
 *   4. CHANNEL GATE (compliance): re-derives channel from the lead's STATE using
 *      the SAME TEXT_OK / CALL_FIRST / AVOID lists as scraper/find-ugly-sites.js.
 *      AVOID-state leads can never be tagged TEXT — they resolve to CALL-ONLY, so
 *      downstream texting steps (which only ever text channel='TEXT') skip them.
 *      They are still IMPORTED (they're callable in the call-first funnel), just
 *      never textable. This is "skip AVOID from texting by tagging channel".
 *   5. Dedupes by place_id within the batch, and relies on the server mutation to
 *      dedupe by place_id against rows already in Convex (idempotent re-runs).
 *   6. Inserts via a Convex mutation (default `leads:importLead`) over CONVEX_URL.
 *
 * USAGE
 *   node import-leads.js                              # newest scraper/leads-*.csv → Convex
 *   node import-leads.js path/to/leads-XX.csv         # a specific CSV
 *   node import-leads.js --dry-run                    # map + validate, write NOTHING (preview)
 *   node import-leads.js --jsonl out/leads.jsonl      # also emit JSONL for `npx convex import`
 *   node import-leads.js --mutation leads:importLead  # override the mutation reference
 *   node import-leads.js --concurrency 8 --limit 50   # tuning / partial import
 *
 * REQUIRES (in .env.local — copy from .env.example):
 *   CONVEX_URL                 https://<deployment>.convex.cloud   (required)
 *   CONVEX_IMPORT_MUTATION     leads:importLead   (optional; --mutation overrides)
 *
 * SERVER CONTRACT — the Convex mutation this calls (built in convex/leads.ts):
 *   export const importLead = mutation({
 *     args: { place_id, name, phone, website, niche, city, state,
 *             zip?, channel, ugly_score?, rank_score?, ugly_reasons?, vision_reasons? },
 *     handler: async (ctx, a) => {
 *       const dup = await ctx.db.query('leads')
 *         .withIndex('by_place_id', q => q.eq('place_id', a.place_id)).first();
 *       if (dup) return { status: 'duplicate', id: dup._id };
 *       const id = await ctx.db.insert('leads', {
 *         ...a, status: 'new', created_at: Date.now(), updated_at: Date.now() });
 *       return { status: 'inserted', id };
 *     },
 *   });
 *   It MUST dedupe by place_id (the schema's by_place_id index) and set
 *   status='new' + timestamps. import-leads.js sends only the source fields above.
 *
 * Node 18+ (built-in fetch via the convex client). CommonJS.
 */

'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// ─── Minimal .env.local loader (no dependency) ────────────────────────────────
// Loads KEY=VALUE lines into process.env WITHOUT overriding anything already set
// (so real shell env / CI secrets win). Strips surrounding quotes and inline #… .
function loadEnv(file) {
  let txt;
  try { txt = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key || process.env[key] != null) continue;
    let val = line.slice(eq + 1).trim();
    // strip surrounding quotes; only strip a trailing "# comment" on UNquoted values
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      const h = val.indexOf(' #');
      if (h >= 0) val = val.slice(0, h).trim();
    }
    process.env[key] = val;
  }
}
loadEnv(path.join(ROOT, '.env.local'));

// ─── Args ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const flagVal = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const DRY_RUN = hasFlag('--dry-run');
const JSONL_OUT = flagVal('--jsonl', null);
const MUTATION = flagVal('--mutation', process.env.CONVEX_IMPORT_MUTATION || 'leads:batchInsert');
const CONCURRENCY = Math.max(1, parseInt(flagVal('--concurrency', '5'), 10) || 5);
const LIMIT = parseInt(flagVal('--limit', '0'), 10) || 0;
// first non-flag arg (and not a flag's value) = explicit CSV path
const flagValueIdx = new Set();
['--jsonl', '--mutation', '--concurrency', '--limit', '--file'].forEach(f => {
  const i = args.indexOf(f); if (i >= 0) flagValueIdx.add(i + 1);
});
const positional = args.filter((a, i) => !a.startsWith('--') && !flagValueIdx.has(i));
const CSV_ARG = flagVal('--file', positional[0] || null);

// ─── CSV parser (quote-aware; same behaviour as the scraper's) ───────────────
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

// ─── Field mappers ────────────────────────────────────────────────────────────

// Digits-only → last 10 → E.164 (+1XXXXXXXXXX). Returns '' if not a US 10-digit number.
function toE164(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  const ten = d.length >= 10 ? d.slice(-10) : '';
  return ten ? '+1' + ten : '';
}

// Normalise the CSV niche → the schema union (electrician | hvac | plumber | roofing).
// Any trade WITHOUT a rebuild template (general contractor, fencing, …) is skipped,
// not coerced — we will not pitch a rebuild we cannot actually build.
//
// ROOFING WAS MISSING HERE and was being silently dropped as "unsupported niche" on
// every import, even though convex/schema.ts accepts it and generator/premium has a
// full 02-roofing template + manifest. It cost 12 leads in the 2026-07-13 scrape
// before it was caught. Keep this map in sync with:
//   convex/schema.ts  (niche union)  +  generator/premium/manifests/*.json
const NICHE_MAP = {
  electrician: 'electrician', electric: 'electrician', electrical: 'electrician',
  hvac: 'hvac', 'heating and air': 'hvac', 'heating & air': 'hvac',
  'air conditioning': 'hvac', 'heating': 'hvac', 'ac repair': 'hvac',
  plumber: 'plumber', plumbing: 'plumber',
  roofing: 'roofing', roofer: 'roofing', roof: 'roofing', 'roofing contractor': 'roofing',
};
function mapNiche(raw) {
  const k = String(raw || '').trim().toLowerCase();
  return NICHE_MAP[k] || null;
}

// ─── Channel gate — SAME state lists as scraper/find-ugly-sites.js ───────────
// Source of truth for compliance. AVOID + CALL_FIRST → CALL-ONLY (never textable);
// only TEXT_OK states → TEXT; unknown/blank → REVIEW. Re-derived here (not trusted
// from the CSV) so an AVOID-state lead can never leak into the textable channel.
// MUST match scraper/find-ugly-sites.js + convex/lib.ts. MI is AVOID (SB 351 "Super TCPA",
// $25k/violation, texts in scope) — do not move it back to TEXT_OK.
const TEXT_OK_STATES = ['NC', 'LA', 'TN', 'NM', 'AL', 'KY', 'OH', 'MS', 'AR', 'AZ', 'MO', 'GA', 'KS', 'ID', 'WI', 'WV', 'MN', 'MT', 'WY', 'IA', 'NE', 'SD', 'ND'];
const CALL_FIRST_STATES = ['IN', 'PA', 'SC', 'NV', 'UT', 'CO', 'VA'];
const AVOID_STATES = ['OK', 'FL', 'TX', 'WA', 'MD', 'CA', 'IL', 'MI'];
function stateCode(s) { const m = String(s || '').toUpperCase().match(/\b([A-Z]{2})\b/); return m ? m[1] : String(s || '').toUpperCase().trim(); }
function leadChannel(st) {
  const s = stateCode(st);
  if (TEXT_OK_STATES.includes(s)) return 'TEXT';
  if (CALL_FIRST_STATES.includes(s) || AVOID_STATES.includes(s)) return 'CALL-ONLY';
  return 'REVIEW';
}
function isAvoidState(st) { return AVOID_STATES.includes(stateCode(st)); }

// Number cell → number | undefined (blank/NaN → undefined so optional fields omit).
function num(v) { const s = String(v == null ? '' : v).trim(); if (!s) return undefined; const n = Number(s); return Number.isFinite(n) ? n : undefined; }
function str(v) { const s = String(v == null ? '' : v).trim(); return s || undefined; }

// Map one CSV row (as a header→value object) to a { mutationArgs, fullDoc } pair,
// or to { skip: reason } when the row can't/shouldn't be imported.
function mapRow(get) {
  const place_id = String(get('place_id') || '').trim();
  const name = String(get('Lead Name') || '').trim();
  const phone = toE164(get('Phone'));
  const website = String(get('Website URL') || '').trim();
  const niche = mapNiche(get('Niche'));
  const state = stateCode(get('State'));
  const city = String(get('City') || '').trim();

  if (!place_id) return { skip: 'no place_id (cannot dedupe)' };
  if (!name) return { skip: 'no business name' };
  if (!phone) return { skip: 'phone not a US 10-digit number' };
  if (!website) return { skip: 'no website URL' };
  if (!niche) return { skip: `unsupported niche "${String(get('Niche') || '').trim()}" (no rebuild template)` };

  const channel = leadChannel(state);          // re-derived; AVOID can only be CALL-ONLY
  const csvChannel = String(get('Channel') || '').trim();

  // Source fields for the mutation (server sets status/created_at/updated_at).
  const mutationArgs = {
    place_id,
    name,
    phone,
    website,
    niche,
    city,
    state,
    zip: str(get('ZIP')),
    channel,
    ugly_score: num(get('Ugly Score')),
    rank_score: num(get('Rank Score')),
    ugly_reasons: str(get('Ugly Reasons')),
    vision_reasons: str(get('Vision Reasons')),
  };
  // drop undefined keys so Convex optional() validators are happy
  Object.keys(mutationArgs).forEach(k => mutationArgs[k] === undefined && delete mutationArgs[k]);

  // Full doc shape (adds server-owned fields) for the JSONL / `npx convex import` path.
  const fullDoc = { ...mutationArgs, status: 'new', created_at: Date.now(), updated_at: Date.now() };

  return {
    mutationArgs,
    fullDoc,
    meta: { channel, csvChannel, avoid: isAvoidState(state), state },
  };
}

// ─── Bounded-concurrency runner with retry (network blips only) ──────────────
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, worker));
  return out;
}

// ─── CSV discovery ───────────────────────────────────────────────────────────
// Newest scraper/leads-*.csv, excluding the *-REVIEW.csv companions (those are
// blocked/dead sites that were never graded — not import-ready leads).
function newestScraperCsv() {
  const dir = path.join(ROOT, 'scraper');
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { return null; }
  const cands = files
    .filter(f => /^leads-.*\.csv$/i.test(f) && !/-REVIEW\.csv$/i.test(f))
    .map(f => ({ f, m: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  return cands.length ? path.join(dir, cands[0].f) : null;
}

// ─── Slack notification (optional; graceful no-op if no webhook) ─────────────
// Posts "N new leads pushed to Convex" after an import. Uses SLACK_WEBHOOK_URL.
async function notifySlack(text) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url || url.includes('...') || !/^https:\/\/hooks\.slack\.com\//.test(url)) return false;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
    return res.ok;
  } catch (_) { return false; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const csvPath = CSV_ARG
    ? (path.isAbsolute(CSV_ARG) ? CSV_ARG : path.join(process.cwd(), CSV_ARG))
    : newestScraperCsv();

  if (!csvPath || !fs.existsSync(csvPath)) {
    console.error('❌ No CSV found. Pass a path, or run the scraper so scraper/leads-*.csv exists.');
    console.error(`   Looked for: ${csvPath || '(none)'} `);
    process.exitCode = 1; return;
  }
  console.log(`📄 Source CSV: ${csvPath}`);

  const rows = parseCSV(fs.readFileSync(csvPath, 'utf8'));
  if (rows.length < 2) { console.error('❌ CSV has no data rows.'); process.exitCode = 1; return; }
  const header = rows[0].map(h => String(h).trim());
  const idx = {}; header.forEach((h, i) => { idx[h] = i; });
  const need = ['place_id', 'Lead Name', 'Phone', 'Website URL', 'Niche', 'State'];
  const missing = need.filter(h => idx[h] == null);
  if (missing.length) { console.error(`❌ CSV missing expected column(s): ${missing.join(', ')}`); process.exitCode = 1; return; }
  const get = (r) => (name) => (idx[name] != null ? r[idx[name]] : '');

  // Map + validate every row.
  const mapped = [];
  const skipped = [];
  const seen = new Set();                     // in-batch dedupe by place_id
  for (const r of rows.slice(1)) {
    if (!r || r.length <= 1) continue;
    const res = mapRow(get(r));
    if (res.skip) { skipped.push({ name: (r[idx['Lead Name']] || '').trim(), reason: res.skip }); continue; }
    if (seen.has(res.mutationArgs.place_id)) { skipped.push({ name: res.mutationArgs.name, reason: 'duplicate place_id in this CSV' }); continue; }
    seen.add(res.mutationArgs.place_id);
    mapped.push(res);
  }

  const importable = LIMIT > 0 ? mapped.slice(0, LIMIT) : mapped;

  // Report before doing anything irreversible.
  const byChannel = importable.reduce((m, x) => { m[x.meta.channel] = (m[x.meta.channel] || 0) + 1; return m; }, {});
  const avoidCount = importable.filter(x => x.meta.avoid).length;
  const channelMismatch = importable.filter(x => x.meta.csvChannel && x.meta.csvChannel !== x.meta.channel);
  console.log(`\n🧮 Parsed ${rows.length - 1} data row(s) → ${mapped.length} importable, ${skipped.length} skipped.`);
  console.log(`   Channel tags: ${Object.entries(byChannel).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);
  console.log(`   AVOID-state leads tagged CALL-ONLY (never textable): ${avoidCount}`);
  if (channelMismatch.length) console.log(`   ⚠️  ${channelMismatch.length} row(s) had a CSV Channel that disagreed with the state map — used the state-derived (safer) value.`);
  if (skipped.length) {
    const reasons = skipped.reduce((m, s) => { m[s.reason] = (m[s.reason] || 0) + 1; return m; }, {});
    console.log('   Skips:');
    Object.entries(reasons).sort((a, b) => b[1] - a[1]).forEach(([why, n]) => console.log(`     · ${n}× ${why}`));
  }

  // Optional JSONL for the CLI import path (`npx convex import --table leads out.jsonl`).
  if (JSONL_OUT) {
    const outPath = path.isAbsolute(JSONL_OUT) ? JSONL_OUT : path.join(process.cwd(), JSONL_OUT);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, importable.map(x => JSON.stringify(x.fullDoc)).join('\n') + '\n', 'utf8');
    console.log(`\n💾 Wrote ${importable.length} lead(s) → ${outPath}`);
    console.log(`   Import them without a mutation via:`);
    console.log(`     npx convex import --table leads "${outPath}"`);
  }

  if (!importable.length) { console.log('\nNothing to import.'); return; }

  if (DRY_RUN) {
    console.log('\n🅳🆁🆈 --dry-run: no writes. Sample of the first 3 mapped leads:');
    importable.slice(0, 3).forEach(x => console.log('   ' + JSON.stringify(x.mutationArgs)));
    return;
  }

  // ─── Live insert via the Convex HTTP client ─────────────────────────────────
  const CONVEX_URL = process.env.CONVEX_URL;
  if (!CONVEX_URL || /your-new-deployment/.test(CONVEX_URL)) {
    console.error('\n❌ CONVEX_URL is not set (or still the placeholder) in .env.local.');
    console.error('   Create the DB first: `cd convex && npx convex dev`, then copy the URL into .env.local.');
    console.error('   Tip: re-run with --dry-run (no DB needed) or --jsonl out.jsonl to preview the mapping.');
    process.exitCode = 1; return;
  }

  let ConvexHttpClient, makeFunctionReference;
  try {
    ({ ConvexHttpClient } = require('convex/browser'));
    ({ makeFunctionReference } = require('convex/server'));
  } catch (e) {
    console.error('\n❌ The `convex` package is not installed. Run `npm install` at the project root.');
    process.exitCode = 1; return;
  }

  const client = new ConvexHttpClient(CONVEX_URL);
  const mutationRef = makeFunctionReference(MUTATION);
  console.log(`\n🚀 Importing ${importable.length} lead(s) → ${CONVEX_URL}  (mutation: ${MUTATION})`);

  const tally = { inserted: 0, duplicate: 0, error: 0 };
  // leads.batchInsert takes the whole array in one call → { inserted, skipped, ids }.
  // It dedupes by place_id in the DB, so re-runs are idempotent (already-present → skipped).
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await client.mutation(mutationRef, { leads: importable.map((x) => x.mutationArgs) });
      tally.inserted = (res && typeof res.inserted === 'number') ? res.inserted : 0;
      tally.duplicate = (res && typeof res.skipped === 'number') ? res.skipped : 0;
      break;
    } catch (e) {
      const msg = String(e && e.message || e);
      if (attempt < 3 && /fetch failed|network|timeout|aborted|ECONN|ETIMEDOUT|socket|EAI_AGAIN|502|503|504/i.test(msg)) {
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      tally.error = importable.length;
      console.error(`   ✗ batch import failed: ${msg}`);
      if (/could not find|no function named|does not exist/i.test(msg)) {
        console.error(`   → The mutation "${MUTATION}" was not found in the deployment. Check convex/leads.ts is deployed (npx convex dev).`);
      }
      break;
    }
  }

  console.log('\n────────────── IMPORT SUMMARY ──────────────');
  console.log(`  Inserted:  ${tally.inserted}`);
  console.log(`  Duplicate: ${tally.duplicate}  (already in Convex — skipped by place_id)`);
  console.log(`  Errors:    ${tally.error}`);
  console.log(`  Skipped (pre-flight): ${skipped.length}`);
  console.log('────────────────────────────────────────────');

  // 📣 Slack: tell the team how many leads were pushed.
  const slackMsg = `🔍 *Ugly-site leads → Convex*  (\`${path.basename(csvPath)}\`)\n`
    + `✅ *${tally.inserted}* new lead(s) pushed`
    + (tally.duplicate ? `  ·  ${tally.duplicate} already in Convex` : '')
    + (tally.error ? `  ·  ⚠️ ${tally.error} error(s)` : '')
    + `\nChannels: ${Object.entries(byChannel).map(([k, v]) => `${k}=${v}`).join('  ') || '—'}`;
  const slacked = await notifySlack(slackMsg);
  console.log(slacked
    ? '  📣 Slack notified.'
    : '  (no SLACK_WEBHOOK_URL set in .env.local — Slack notification skipped)');

  if (tally.error) process.exitCode = 1;
}

main().catch(e => { console.error('Fatal:', e && e.message || e); process.exitCode = 1; });
