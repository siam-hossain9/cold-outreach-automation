#!/usr/bin/env node
/**
 * toggle-build.js — "flip the toggle in Close → OUR demo (with the AI receptionist)".
 * ============================================================================
 * Watches Close for OUR rebuild leads (custom `lead` = "rebuild") whose
 * `Website Demo - Send` toggle is True, and for each one we haven't built yet:
 *   1. runs build-premium.js  → niche demo + the tuned AI receptionist → deploys to Vercel
 *   2. texts the demo link from the lead's sticky sending number
 *   3. stamps Close (our demo URL + Sent At) and flips the Convex lead to demo_sent
 *
 * SCOPED to `lead = rebuild` — it never sees, builds, or texts the other operation's
 * (websell) leads. Guards against double-sends: a lead that already has a Sent-At
 * (e.g. websell already texted it) is skipped, not re-texted.
 *
 * Usage:
 *   node toggle-build.js            # DRY RUN — list what it would build (no side effects)
 *   node toggle-build.js --send     # actually build + deploy + text the pending leads
 *   node toggle-build.js --send --lead lead_XXXX   # just one specific Close lead
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { ConvexHttpClient } = require('convex/browser');
const { anyApi } = require('convex/server');

const ROOT = path.resolve(__dirname, '../..');           // e:/N8N/old website
const env = fs.readFileSync(path.join(ROOT, '.env.local'), 'utf8');
const g = (k) => ((env.match(new RegExp('^' + k + '=(.*)$', 'm')) || [])[1] || '').trim();
const AUTH = 'Basic ' + Buffer.from(g('CLOSE_API_KEY') + ':').toString('base64');
const convex = new ConvexHttpClient(g('CONVEX_URL'));

const CF = {
  LEAD_TAG: 'cf_bWgM0fxF58n1BO5YElBmJcuTV1CzDw5sIGY3wa3b51u',
  SEND:     'cf_MuBbV1mNj2o47xuMYhTyVYaqwaqaban5s8wxkeYdvZf',
  SLUG:     'cf_CLBEEeGPX116lRecdaQX3Zht4Ex0XiCNkLT7BPJlu0Q',
  SENT_AT:  'cf_RJaIZqW4kmINDhKvOWUSRe9IZ87VBPFkdGYyzwLSh6w',
  CONVEX_ID:'cf_QaXxtdAmTEByJ8SOBFk4wizgJwrwZF7XtSufDkTCP2x',
};
const SEND = process.argv.includes('--send');
const ONE = (process.argv[process.argv.indexOf('--lead') + 1] || '').startsWith('lead_')
  ? process.argv[process.argv.indexOf('--lead') + 1] : null;

async function closeFetch(pathname, method, body) {
  const r = await fetch('https://api.close.com/api/v1' + pathname, {
    method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(method + ' ' + pathname + ' → ' + r.status + ' ' + JSON.stringify(j).slice(0, 200));
  return j;
}

/** Our rebuild leads whose demo-send toggle is currently True. */
async function pendingToggles() {
  const query = { negate: false, type: 'and', queries: [
    { condition: { type: 'term', values: ['rebuild'] }, field: { custom_field_id: CF.LEAD_TAG, type: 'custom_field' }, negate: false, type: 'field_condition' },
    { condition: { type: 'term', values: ['True'] }, field: { custom_field_id: CF.SEND, type: 'custom_field' }, negate: false, type: 'field_condition' },
    { negate: false, object_type: 'lead', type: 'object_type' },
  ] };
  const res = await closeFetch('/data/search/', 'POST', { query, _limit: 100, _fields: { lead: ['id', 'display_name'] } });
  let ids = (res.data || []).map((l) => l.id);
  if (ONE) ids = ids.filter((id) => id === ONE);
  return ids;
}

function demoSmsBody(business, url) {
  const b = (business || 'your site').trim();
  return `Awesome — here's that modern rebuild of ${b} I put together: ${url}. Have a look and let me know what you think!`;
}

async function run() {
  console.log(SEND ? '🔨 toggle-build — LIVE (--send)\n' : '👀 toggle-build — DRY RUN (pass --send to execute)\n');
  const ids = await pendingToggles();
  if (!ids.length) { console.log('no rebuild leads with Website Demo - Send = True.'); return; }

  for (const closeId of ids) {
    const L = await closeFetch('/lead/' + closeId + '/', 'GET');
    const name = L.display_name;
    const convexId = L['custom.' + CF.CONVEX_ID];
    const sentAt = L['custom.' + CF.SENT_AT];
    if (!convexId) { console.log('⏭  ' + name + ' — no Convex ID (not one of ours) — skip'); continue; }

    const lead = await convex.query(anyApi.leads.get, { leadId: convexId });
    if (!lead) { console.log('⏭  ' + name + ' — Convex lead missing — skip'); continue; }

    // already have OUR ready demo? then it's done.
    const demo = await convex.query(anyApi.demos.getByLeadId, { leadId: convexId }).catch(() => null);
    if (demo && demo.demo_status === 'ready' && demo.demo_url) { console.log('✅ ' + name + ' — our demo already built: ' + demo.demo_url); continue; }
    // websell (or anyone) already texted a demo? don't double-contact.
    if (sentAt) { console.log('⏭  ' + name + ' — a demo was already sent (' + String(sentAt).slice(0, 16) + ') — skip to avoid double-text'); continue; }

    if (!SEND) { console.log('• WOULD BUILD → ' + name + ' (' + lead.niche + ', ' + lead.city + ', ' + lead.state + ') → deploy + text ' + lead.phone); continue; }

    // 1) build + deploy with OUR generator (receptionist auto-injected)
    console.log('🔨 building ' + name + ' …');
    const args = ['--name', lead.name, '--phone', lead.phone, '--website', lead.website || '', '--niche', lead.niche,
      '--city', lead.city || '', '--state', lead.state || '', '--zip', lead.zip || '', '--lead-id', convexId];
    const cmd = 'node ' + JSON.stringify(path.join(__dirname, 'build-premium.js')) + ' ' + args.map((a) => JSON.stringify(a)).join(' ');
    const out = execSync(cmd, { cwd: __dirname, encoding: 'utf8', stdio: ['pipe', 'pipe', 'inherit'] });
    const m = out.match(/RESULT (\{[\s\S]*\})\s*$/m) || out.match(/RESULT (\{[\s\S]*?\})/);
    const result = m ? JSON.parse(m[1]) : {};
    const url = result.demo_url || result.short_url;
    if (!url) { console.log('❌ ' + name + ' — build produced no demo URL; skipping text'); continue; }
    console.log('   deployed (with receptionist): ' + url);

    // 2) text the demo link from the lead's sticky number
    const asg = JSON.parse(execSync('npx convex run smsNumbers:assignSmsNumber ' + JSON.stringify(JSON.stringify({ leadId: convexId })), { cwd: ROOT, encoding: 'utf8' }).trim());
    const from = asg.number;
    await closeFetch('/activity/sms/', 'POST', { lead_id: closeId, direction: 'outbound', status: 'outbox', local_phone: from, remote_phone: lead.phone, text: demoSmsBody(lead.name, url) });
    console.log('   texted demo link from ' + from);

    // 3) stamp Close + advance Convex
    await closeFetch('/lead/' + closeId + '/', 'PUT', { ['custom.' + CF.SLUG]: (result.slug || url), ['custom.' + CF.SENT_AT]: new Date().toISOString() });
    await convex.mutation(anyApi.leads.setStatus, { leadId: convexId, status: 'demo_sent' });
    console.log('✅ ' + name + ' — done\n');
  }
  console.log('\ndone.');
}
run().catch((e) => { console.error('FATAL', e.message); process.exitCode = 1; });
