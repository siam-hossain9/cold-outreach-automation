#!/usr/bin/env node
/**
 * build-runner.js — the local HTTP bridge n8n (WF-UW-04) calls to build a demo.
 * ============================================================================
 * The n8n instance is remote and cannot run the local generator. This tiny
 * server runs on the machine/box that HAS the repo + .env.local. WF-UW-04 POSTs
 * `{ leadId }`; the runner:
 *   1. fetches the lead from Convex (leads.get)
 *   2. runs build-premium.buildForLead (deep-extract → photo gate → reskin →
 *      deploy PUBLIC → records the demo in Convex via demos.enqueue/setReady)
 *   3. responds { ok, demo_url, template, leadId } (synchronous; ~1-4 min)
 *
 * Then WF-UW-04 calls Convex /opt-in, which sends the demo link + schedules
 * follow-ups (all gating server-side).
 *
 *   node generator/premium/build-runner.js            # listens on :8787
 *   PORT=9000 BUILD_RUNNER_TOKEN=secret node build-runner.js
 * Point WF-UW-04's BUILD_RUNNER_URL at http://<this-host>:8787/  (expose via a
 * tunnel/reverse-proxy so the remote n8n can reach it).
 */
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const { buildForLead } = require('./build-premium');

const ROOT = path.resolve(__dirname, '..', '..');
(function loadEnv(f) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { return; }
  for (const l of t.split(/\r?\n/)) { const s = l.trim(); if (!s || s.startsWith('#')) continue; const e = s.indexOf('='); if (e < 0) continue; const k = s.slice(0, e).trim(); if (!k || process.env[k] != null) continue; let v = s.slice(e + 1).trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1); else { const h = v.indexOf(' #'); if (h >= 0) v = v.slice(0, h).trim(); } process.env[k] = v; }
})(path.join(ROOT, '.env.local'));

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.BUILD_RUNNER_TOKEN || '';
const CONVEX_URL = process.env.CONVEX_URL || '';

// FAIL CLOSED. This endpoint triggers a paid Vercel deploy and writes production
// lead state, and it is meant to be internet-reachable so Convex can call it. Lead
// ids are public (they ride in every texted /r/{leadId} link), so an open runner is
// remotely drivable by anyone who has seen a demo. Refuse to start without a token.
if (!TOKEN) {
  console.error(
    'REFUSING TO START: BUILD_RUNNER_TOKEN is not set.\n' +
    'This endpoint builds + deploys and mutates live leads, and it is exposed to the internet.\n' +
    'Set a long random token in .env.local (and the same value in Convex env BUILD_RUNNER_TOKEN):\n' +
    '  BUILD_RUNNER_TOKEN=' + require('crypto').randomBytes(24).toString('hex')
  );
  process.exit(1);
}

async function fetchLead(leadId) {
  let ConvexHttpClient, makeFunctionReference;
  try { ({ ConvexHttpClient } = require('convex/browser')); ({ makeFunctionReference } = require('convex/server')); }
  catch (_) { throw new Error('convex package not installed (npm i at repo root)'); }
  if (!CONVEX_URL) throw new Error('CONVEX_URL not set');
  const client = new ConvexHttpClient(CONVEX_URL);
  const lead = await client.query(makeFunctionReference('leads:get'), { leadId });
  if (!lead) throw new Error('lead not found: ' + leadId);
  return lead;
}

function send(res, code, obj) { const b = JSON.stringify(obj); res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) }); res.end(b); }

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, service: 'build-runner' });
  if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on('end', async () => {
    try {
      // Constant-time compare so the token can't be guessed a byte at a time.
      const got = String(req.headers['x-runner-token'] || '');
      const a = Buffer.from(got), b = Buffer.from(TOKEN);
      if (a.length !== b.length || !require('crypto').timingSafeEqual(a, b)) {
        return send(res, 401, { ok: false, error: 'unauthorized' });
      }
      const { leadId } = JSON.parse(body || '{}');
      if (!leadId) return send(res, 400, { ok: false, error: 'leadId required' });
      console.log(new Date().toISOString(), 'build request for', leadId);
      const doc = await fetchLead(leadId);
      const lead = {
        name: doc.name, phone: doc.phone, website: doc.website || '',
        niche: doc.niche, city: doc.city, state: doc.state, lead_id: leadId,
      };
      const result = await buildForLead(lead, { deploy: true, log: (m) => console.log('  ', m) });
      console.log('  done:', result.demo_url || '(no url)', '| photos:', result.photos_used);
      return send(res, result.ok ? 200 : 500, {
        ok: !!result.ok, leadId, demo_url: result.demo_url || null,
        template: result.template || null, photos_used: result.photos_used || 0,
        error: result.deploy_error || result.convex_error || null,
      });
    } catch (e) {
      console.error('  build-runner error:', e.message);
      return send(res, 500, { ok: false, error: e.message });
    }
  });
});

server.listen(PORT, () => console.log(`build-runner listening on :${PORT}  (POST / with {leadId}${TOKEN ? ', x-runner-token required' : ''})`));
