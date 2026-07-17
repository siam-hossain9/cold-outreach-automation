#!/usr/bin/env node
/**
 * admin/server.js — lightweight monitoring + kill-switch server.
 * ============================================================================
 * the "Ugly-Website Rebuild" ops dashboard. It does two things:
 *
 *   GET  /api/stats  → one JSON blob of pipeline stats read from Convex
 *   POST /kill       → flips system_flags.outbound_paused (the kill switch)
 *
 * It talks to Convex over Convex's built-in HTTP function API using Node 18+'s
 * native `fetch`, so the ONLY dependency is express. The two Convex functions it
 * calls (stats:dashboard / stats:setKillSwitch) already live in convex/stats.ts and
 * are deployed — nothing to copy. (admin/convex/adminStats.ts is a DEAD leftover of
 * the abandoned call-first design; do NOT copy it into convex/.)
 *
 * Secrets come from .env.local at the project root (git-ignored) — nothing is
 * hardcoded. See README.md.
 */
'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ─── Tiny .env loader (no dotenv dependency) ────────────────────────────────
// Loads KEY=VALUE lines from the project-root .env.local (shared, git-ignored)
// and an optional admin/.env for local overrides. Real shell env vars always
// win — we only fill in keys that are not already set.
function loadEnvFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    return; // file is optional
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let val = line.slice(eq + 1).trim();
    // Strip surrounding matching quotes if present.
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
}
loadEnvFile(path.join(__dirname, '..', '.env.local'));
loadEnvFile(path.join(__dirname, '.env'));

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = Number(process.env.ADMIN_PORT || process.env.PORT || 8787);
// Bind LOOPBACK ONLY by default. `app.listen(PORT)` with no host binds 0.0.0.0 —
// every network interface — while the startup banner said "http://localhost:8787".
// Combined with an unauthenticated GET /api/stats, anyone on the same network (café,
// coworking, hotel wifi) could pull every lead's name, phone, city and reply text in
// a single request. Set ADMIN_BIND=0.0.0.0 to expose it deliberately — that path now
// REQUIRES an ADMIN_TOKEN (see the guard below).
const BIND = process.env.ADMIN_BIND || '127.0.0.1';
const IS_LOOPBACK = BIND === '127.0.0.1' || BIND === 'localhost' || BIND === '::1';
// Convex deployment origin, e.g. https://your-deployment.convex.cloud
const CONVEX_URL = (process.env.CONVEX_URL || process.env.CONVEX_HTTP_URL || '').replace(/\/$/, '');
// Optional bearer/x-admin-token guard on the state-changing POST /kill route.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// Optional secret forwarded to the Convex mutation (matches ADMIN_MUTATION_SECRET
// set inside the Convex deployment, if you enabled that hardening).
const ADMIN_MUTATION_SECRET = process.env.ADMIN_MUTATION_SECRET || '';

// ─── Convex HTTP helpers ─────────────────────────────────────────────────────
// Convex exposes public query/mutation functions at:
//   POST {CONVEX_URL}/api/query      {"path":"module:fn","args":{},"format":"json"}
//   POST {CONVEX_URL}/api/mutation   (same shape)
// Success →  { "status": "success", "value": <result> }
// Failure →  { "status": "error",   "errorMessage": "..." }
class ConvexError extends Error {
  constructor(message, httpStatus, body) {
    super(message);
    this.name = 'ConvexError';
    this.httpStatus = httpStatus;
    this.body = body;
  }
}

async function convexCall(kind /* 'query' | 'mutation' */, functionPath, args) {
  if (!CONVEX_URL) {
    throw new ConvexError('CONVEX_URL is not set — add it to .env.local', 0, null);
  }
  const url = `${CONVEX_URL}/api/${kind}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: functionPath, args: args || {}, format: 'json' }),
    });
  } catch (netErr) {
    throw new ConvexError(`Cannot reach Convex at ${CONVEX_URL}: ${netErr.message}`, 0, null);
  }
  const raw = await res.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch (_) {
    throw new ConvexError(
      `Convex ${kind} ${functionPath}: unexpected non-JSON response (HTTP ${res.status})`,
      res.status,
      raw.slice(0, 500)
    );
  }
  if (json && json.status === 'success') return json.value;
  const message = (json && (json.errorMessage || json.error)) || `Convex ${kind} failed (HTTP ${res.status})`;
  throw new ConvexError(message, res.status, json);
}

// Build a helpful hint when the stats functions aren't reachable.
function deployHint(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  const looksMissing =
    (err && err.httpStatus === 404) ||
    msg.includes('could not find') ||
    msg.includes('not found');
  if (looksMissing) {
    // Was: "copy admin/convex/adminStats.ts into convex/" — that file is DEAD (stale
    // call-first schema). The real functions are in convex/stats.ts.
    return "Convex function 'stats:dashboard' not found. Run `npx convex dev --once` from the project root to deploy convex/. Do NOT copy admin/convex/adminStats.ts — it is dead code.";
  }
  if (!CONVEX_URL) {
    return 'Set CONVEX_URL in .env.local to your deployment origin (https://<name>.convex.cloud).';
  }
  return undefined;
}

// ─── Auth guard for the destructive route ───────────────────────────────────
function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/**
 * Guards BOTH the stats read and the kill switch.
 *
 * /api/stats used to have no guard at all — and its payload is not "counts", it is
 * every contacted lead's name, phone, city, close id and the verbatim text of their
 * replies (see stats.ts leadRow → hot_leads/campaign). The README called it
 * "read-only counts, low sensitivity", which was wrong.
 *
 * Token-less is tolerated ONLY on loopback (just you, on this machine). The moment
 * the server is bound to a real interface, a token is mandatory — enforced at boot.
 */
function requireAdminToken(req, res, next) {
  if (!ADMIN_TOKEN && IS_LOOPBACK) return next(); // local-only, single user
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const provided = bearer || req.headers['x-admin-token'] || '';
  if (ADMIN_TOKEN && provided && safeEqual(provided, ADMIN_TOKEN)) return next();
  return res.status(401).json({
    error: 'unauthorized',
    hint: 'Send the admin token as `Authorization: Bearer <token>` or `x-admin-token`.',
  });
}

// ─── App ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '16kb' }));
app.disable('x-powered-by');

// Health / config sanity — safe to expose (no secrets).
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    convex_url_set: !!CONVEX_URL,
    token_required: !!ADMIN_TOKEN,
    time: Date.now(),
  });
});

// The dashboard payload. NOT "low sensitivity" — it contains every contacted lead's
// name, phone, city and the exact text of their replies. Guarded like the kill switch.
app.get('/api/stats', requireAdminToken, async (req, res) => {
  try {
    const period = ['24h', '7d', 'all'].includes(req.query.period) ? req.query.period : 'all';
    const stats = await convexCall('query', 'stats:dashboard', { period });
    res.json(stats);
  } catch (err) {
    res.status(502).json({ error: err.message, hint: deployHint(err) });
  }
});

// The kill switch. Body: { paused?: boolean } (explicit) or { toggle: true }.
// With no body it toggles. Guarded by ADMIN_TOKEN when configured.
app.post('/kill', requireAdminToken, async (req, res) => {
  const body = req.body || {};
  const args = {};
  if (typeof body.paused === 'boolean') args.paused = body.paused;
  if (body.toggle === true) args.toggle = true;
  if (ADMIN_MUTATION_SECRET) args.secret = ADMIN_MUTATION_SECRET;
  try {
    const result = await convexCall('mutation', 'stats:setKillSwitch', args);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: err.message, hint: deployHint(err) });
  }
});

// Static dashboard.
app.use(express.static(path.join(__dirname, 'public')));

// FAIL CLOSED: never serve lead PII to a network without a token.
if (!IS_LOOPBACK && !ADMIN_TOKEN) {
  console.error(
    `\n  REFUSING TO START: ADMIN_BIND=${BIND} exposes this server to the network,\n` +
    '  but no ADMIN_TOKEN is set. /api/stats returns every lead\'s name, phone and\n' +
    '  reply text — that cannot be served unauthenticated to other machines.\n\n' +
    '  Either drop ADMIN_BIND (bind to 127.0.0.1, the default), or set:\n' +
    `    ADMIN_TOKEN=${crypto.randomBytes(24).toString('hex')}\n`
  );
  process.exit(1);
}

app.listen(PORT, BIND, () => {
  console.log(`\n  rebuild admin → http://${IS_LOOPBACK ? 'localhost' : BIND}:${PORT}`);
  console.log(`  Convex:        ${CONVEX_URL || '(CONVEX_URL not set — set it in .env.local)'}`);
  console.log(`  Bound to:      ${BIND}${IS_LOOPBACK ? '  (this machine only — not reachable from the network)' : '  (EXPOSED to the network)'}`);
  console.log(`  Auth:          ${ADMIN_TOKEN ? 'ADMIN_TOKEN required on /api/stats + /kill' : 'none (safe: loopback-only)'}`);
  if (!CONVEX_URL) {
    console.log('  ! CONVEX_URL missing — /api/stats will return a 502 until it is set.');
  }
  console.log('');
});
