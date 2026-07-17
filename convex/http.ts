// ─────────────────────────────────────────────────────────────────────────────
// http.ts — public HTTP endpoints the tracker + n8n call.
//
// Tracker (browser, no auth — low-risk writes, lead-id scoped):
//   GET  /r/{leadId}   log the click, schedule follow-up B, 302 → demo_url
//   POST /click        same as /r but returns JSON {demo_url} (tracker redirects)
//   POST /beacon       30s view beacon → view_events.record
//
// n8n / admin (auth via x-webhook-secret == CLOSE_WEBHOOK_SECRET):
//   POST /leads/import n8n intake → leads.batchInsert
//   POST /opt-in       WF-R2: stamp consent + status opted_in + send the demo
//   POST /send-demo    trigger the demo SMS for a lead
//   POST /reply        WF-R3 classifier: yes | question | no | unsub → routing
//   POST /status       set a lead's funnel status
//   POST /kill         flip the outbound_paused kill switch
//   GET  /health       liveness
//
// If CLOSE_WEBHOOK_SECRET is unset (local dev) the auth check is skipped.
// ─────────────────────────────────────────────────────────────────────────────

import { httpRouter } from 'convex/server';
import { httpAction } from './_generated/server';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { CF } from './close';
import { reskinHtml } from './reskin';

const http = httpRouter();

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  // x-dashboard-token: the ops dashboard's session token now travels in a header
  // instead of the ?token= query string (query strings leak into proxy logs, browser
  // history and Referer headers — and that token unlocks every lead's PII).
  'Access-Control-Allow-Headers': 'Content-Type, x-webhook-secret, x-dashboard-token',
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });

/**
 * True if the request is authorized for control endpoints (/kill, /opener-batch, …).
 *
 * FAILS CLOSED. This used to `return true` when no secret was configured — and the
 * secret was never set in production, so every control endpoint was open to anyone
 * who knew the Convex URL. That URL is public: it ships inside every /r/{leadId} link
 * we text. Net effect: a stranger could flip the kill switch and halt (or silently
 * un-pause) all outreach. Now: no secret configured ⇒ deny everything.
 *
 * Two accepted credentials, because two very different callers exist:
 *   x-webhook-secret  → CLOSE_WEBHOOK_SECRET   (n8n workflows, server-to-server)
 *   x-dashboard-token → DASHBOARD_TOKEN        (the hosted ops dashboard, browser)
 * A browser can never safely hold CLOSE_WEBHOOK_SECRET, which is why the hosted kill
 * switch could never authenticate and silently no-op'd.
 */
async function authorized(ctx: any, request: Request): Promise<boolean> {
  const secret = process.env.CLOSE_WEBHOOK_SECRET || '';
  const given = request.headers.get('x-webhook-secret') || '';
  if (secret && timingSafeEq(given, secret)) return true;

  // A logged-in dashboard session also authorizes control routes (this is how the
  // hosted kill switch authenticates — a browser can never safely hold the
  // server-to-server secret, which is why that button silently no-op'd before).
  const dashTok = request.headers.get('x-dashboard-token') || '';
  if (dashTok) {
    const ok = await ctx.runQuery(internal.dashboardAuth.validateToken, { token: dashTok });
    if (ok) return true;
  }
  return false; // fail closed — no valid credential (or none configured at all)
}

/** Length-safe, non-short-circuiting string compare (no byte-at-a-time guessing). */
function timingSafeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ─── Tracker: GET /r/{leadId} → click + redirect ─────────────────────────────
http.route({
  pathPrefix: '/r/',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const raw = url.pathname.slice('/r/'.length).split('/')[0];
    if (!raw) return new Response('missing lead id', { status: 400 });
    try {
      const result = await ctx.runMutation(api.clicks.recordAndScheduleB, {
        leadId: raw as Id<'leads'>,
        user_agent: request.headers.get('user-agent') || '',
        ip_country: request.headers.get('x-vercel-ip-country')
          || request.headers.get('cf-ipcountry') || undefined,
      });
      const target = result.demo_url
        || (process.env.PUBLIC_DOMAIN ? `https://${process.env.PUBLIC_DOMAIN}/` : null);
      if (!target) return new Response('demo not found', { status: 404 });
      return new Response(null, { status: 302, headers: { Location: target } });
    } catch (_) {
      return new Response('invalid lead id', { status: 404 });
    }
  }),
});

// ─── Tracker: POST /click → JSON (tracker performs its own redirect) ──────────
http.route({
  path: '/click',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await request.json().catch(() => ({}));
    if (!body.leadId) return json({ error: 'leadId required' }, 400);
    try {
      const result = await ctx.runMutation(api.clicks.recordAndScheduleB, {
        leadId: body.leadId as Id<'leads'>,
        user_agent: body.user_agent || request.headers.get('user-agent') || '',
        ip_country: body.ip_country
          || request.headers.get('x-vercel-ip-country')
          || request.headers.get('cf-ipcountry') || undefined,
      });
      return json(result);
    } catch (_) {
      return json({ error: 'invalid lead id' }, 404);
    }
  }),
});

// ─── Tracker: POST /beacon → 30s view ────────────────────────────────────────
http.route({
  path: '/beacon',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await request.json().catch(() => ({}));
    if (!body.leadId) return json({ error: 'leadId required' }, 400);
    try {
      const result = await ctx.runMutation(api.view_events.record, {
        leadId: body.leadId as Id<'leads'>,
        duration_ms: Number(body.duration_ms) || 30000,
        demoId: body.demoId ? (body.demoId as Id<'demos'>) : undefined,
      });
      return json(result);
    } catch (_) {
      return json({ error: 'invalid lead id' }, 404);
    }
  }),
});

// Preflight for the browser POST endpoints.
// NOTE: /dashboard-stats and /dashboard-logout MUST be here. They now carry the
// session in an `x-dashboard-token` header, and a cross-origin request with a custom
// header triggers a CORS preflight — without an OPTIONS route the browser refuses to
// send the real request and the dashboard renders completely empty. (The old
// `?token=` query string needed no preflight, which is why this only broke on the
// switch to headers.)
for (const p of ['/click', '/beacon', '/chat', '/voice/start', '/dashboard-login', '/dashboard-logout', '/dashboard-stats', '/kill']) {
  http.route({
    path: p,
    method: 'OPTIONS',
    handler: httpAction(async () => new Response(null, { status: 204, headers: CORS })),
  });
}

// ─── n8n: POST /leads/import → batchInsert ───────────────────────────────────
http.route({
  path: '/leads/import',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!(await authorized(ctx, request))) return json({ error: 'unauthorized' }, 401);
    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body.leads)) return json({ error: 'leads[] required' }, 400);
    const result = await ctx.runMutation(api.leads.batchInsert, { leads: body.leads });
    return json(result);
  }),
});

// ─── POST /review-import → modern/decent-site leads → the review_website DB ───
// The scraper's -REVIEW.csv (sites too modern for the rebuild funnel) lands here
// instead of being discarded. Kept separate from the rebuild `leads` table.
http.route({
  path: '/review-import',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!(await authorized(ctx, request))) return json({ error: 'unauthorized' }, 401);
    const body = await request.json().catch(() => ({}));
    if (!Array.isArray(body.leads)) return json({ error: 'leads[] required' }, 400);
    const result = await ctx.runMutation(api.reviewWebsite.batchInsert, { leads: body.leads });
    return json(result);
  }),
});

// ─── n8n WF-UW-02: POST /opener-batch → new TEXT leads for the first opener ───
// Returns a batch of status:'new' + channel:'TEXT' leads (DNC-skipped), ensures each
// exists in Close, and flips them to 'opener_sent' so the next run won't re-pick them.
http.route({
  path: '/opener-batch',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!(await authorized(ctx, request))) return json({ error: 'unauthorized' }, 401);
    // Kill switch gates openers too — /kill must stop ALL outbound, not just demos/follow-ups.
    if (await ctx.runQuery(internal.systemFlags.paused, {})) return json({ leads: [], count: 0, paused: true });
    const body = await request.json().catch(() => ({}));
    const limit = Math.min(Number(body.limit) || 40, 100);
    const candidates = await ctx.runQuery(api.leads.openerCandidates, { limit });
    const out: Array<{ lead_id: string; close_lead_id: string; name: string; phone: string; city: string; niche: string; from: string }> = [];
    for (const lead of candidates) {
      if (await ctx.runQuery(internal.dnc.checkPhone, { phone: lead.phone })) continue; // skip DNC
      let close_lead_id = lead.close_lead_id || '';
      if (!close_lead_id) {
        let res;
        try { res = await ctx.runAction(api.close.createLead, { leadId: lead._id }); }
        catch (_) { continue; } // couldn't reach Close this round → leave 'new', retry next batch
        if (res.duplicate) continue; // already in Close → quarantined + Slacked, don't text
        close_lead_id = res.close_lead_id;
      }
      if (!close_lead_id) continue; // safety: no Close id → skip
      // Assign the sticky, rotating sending number and hand it to n8n as `from`.
      // Rotates every SMS_ROTATE_EVERY leads; sticky so all follow-ups reuse it.
      const { number, isNew } = await ctx.runMutation(internal.smsNumbers.assignSmsNumber, { leadId: lead._id });
      const from = number || (process.env.CLOSE_SMS_NUMBER || '').split(',')[0].trim();
      if (isNew && number) {
        // Mirror onto the Close lead (informational; best-effort — never block the batch).
        try { await ctx.runAction(internal.close.setCustomFields, { leadId: lead._id, set: { [CF.SMS_NUMBER]: number } }); } catch (_) {}
      }
      await ctx.runMutation(api.leads.setStatus, { leadId: lead._id, status: 'opener_sent' });
      // Arm the opener nudges (+4h / +24h / +72h). Without this a cold lead who never
      // replies gets exactly ONE text ever — A/B/C are anchored to the DEMO send, which
      // a non-replying lead never reaches. Each nudge re-checks every gate at fire time
      // and dies the moment the lead replies or opts out.
      await ctx.runMutation(internal.followups.scheduleOpenerNudges, { leadId: lead._id });
      out.push({ lead_id: lead._id, close_lead_id, name: lead.name, phone: lead.phone, city: lead.city, niche: lead.niche, from });
    }
    return json({ leads: out, count: out.length });
  }),
});

// ─── n8n WF-UW-06: POST /dedupe-sweep → quarantine leads already in Close ─────
// Proactive pass BEFORE the opener: for each new lead (with a phone), search Close
// by phone. If the business already exists there, quarantine our Convex lead as
// 'duplicate' and Slack the team — so we never push a duplicate into the shared org.
http.route({
  path: '/dedupe-sweep',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!(await authorized(ctx, request))) return json({ error: 'unauthorized' }, 401);
    const body = await request.json().catch(() => ({}));
    const limit = Math.min(Number(body.limit) || 50, 200);
    const candidates = await ctx.runQuery(api.leads.duplicateCandidates, { limit });
    let checked = 0, duplicates = 0;
    const dupes: Array<{ lead_id: string; name: string; matched: string }> = [];
    for (const lead of candidates) {
      checked++;
      const dup = await ctx.runAction(internal.close.findDuplicateByPhone, { phone: lead.phone });
      if (!dup) continue;
      duplicates++;
      await ctx.runMutation(internal.leads.markDuplicate, { leadId: lead._id, duplicate_of: dup.id });
      await ctx.runAction(internal.notify.slackDuplicate, {
        leadId: lead._id, matched_close_id: dup.id, matched_name: dup.display_name,
      });
      dupes.push({ lead_id: lead._id, name: lead.name, matched: dup.id });
    }
    return json({ checked, duplicates, dupes });
  }),
});

// ─── n8n WF-R2: POST /opt-in → consent + send demo ───────────────────────────
http.route({
  path: '/opt-in',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!(await authorized(ctx, request))) return json({ error: 'unauthorized' }, 401);
    const body = await request.json().catch(() => ({}));
    if (!body.leadId) return json({ error: 'leadId required' }, 400);
    const leadId = body.leadId as Id<'leads'>;
    await ctx.runMutation(api.leads.setConsent, { leadId, at: body.at ? Number(body.at) : undefined });
    await ctx.runMutation(api.leads.setStatus, { leadId, status: 'opted_in' });
    // Send the demo now (sendDemoSms re-checks the demo is ready + all gates).
    await ctx.scheduler.runAfter(0, internal.demos.sendDemoSms, { leadId });
    return json({ ok: true });
  }),
});

// ─── n8n: POST /send-demo → trigger the demo SMS ─────────────────────────────
http.route({
  path: '/send-demo',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!(await authorized(ctx, request))) return json({ error: 'unauthorized' }, 401);
    const body = await request.json().catch(() => ({}));
    if (!body.leadId) return json({ error: 'leadId required' }, 400);
    await ctx.scheduler.runAfter(0, internal.demos.sendDemoSms, { leadId: body.leadId as Id<'leads'> });
    return json({ ok: true });
  }),
});

// ─── n8n WF-R3: POST /reply → classify + route ───────────────────────────────
http.route({
  path: '/reply',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!(await authorized(ctx, request))) return json({ error: 'unauthorized' }, 401);
    const body = await request.json().catch(() => ({}));
    const sentiment = String(body.sentiment || '').toLowerCase();

    // Resolve the lead by explicit id, else Close lead id, else phone (n8n has these).
    // A supplied close_lead_id is AUTHORITATIVE: if it doesn't resolve to one of our
    // leads we do NOT fall through to a last-10-digit phone match (which could otherwise
    // mis-attribute a foreign op's reply to one of our leads on a phone collision).
    let lead = body.leadId ? await ctx.runQuery(api.leads.get, { leadId: body.leadId as Id<'leads'> }) : null;
    if (!lead && body.close_lead_id) lead = await ctx.runQuery(api.leads.getByCloseLeadId, { close_lead_id: String(body.close_lead_id) });
    else if (!lead && body.phone) lead = await ctx.runQuery(api.leads.getByPhone, { phone: String(body.phone) });
    if (!lead) return json({ error: 'lead not found (leadId, close_lead_id, or phone required)' }, 404);
    const leadId = lead._id;

    if (sentiment === 'unsub') {
      if (lead.phone) await ctx.runMutation(api.dnc.add, { phone: lead.phone, reason: 'sms: unsubscribe' });
      await ctx.runMutation(api.leads.setStatus, { leadId, status: 'dnc' });
      await ctx.scheduler.runAfter(0, internal.close.markDoNotContact, { leadId });
    } else if (sentiment === 'no') {
      await ctx.runMutation(api.leads.setStatus, { leadId, status: 'closed_lost' });
    } else {
      // yes / question → mark replied; WF-UW-03 fires the auto-build for 'yes'.
      await ctx.runMutation(api.leads.setStatus, { leadId, status: 'replied' });
    }
    return json({ ok: true, sentiment, leadId });
  }),
});

// ─── Close inbound-SMS webhook: POST /inbound-sms → status change on reply ────
// Close delivers EVERY activity.sms.created in the shared org here (inbound + our
// own outbound). We: (1) ignore outbound, (2) resolve the lead by its indexed Close
// id and ignore anything that isn't one of ours, (3) STOP → dnc, else → 'replied'
// (engaged) so the follow-up nudges stop and a human/next step can take over.
// Signature check is optional: enforced only if CLOSE_WEBHOOK_SIGNING_KEY is set.
async function verifyCloseSignature(request: Request, rawBody: string): Promise<boolean> {
  const key = process.env.CLOSE_WEBHOOK_SIGNING_KEY || '';
  if (!key) return true; // not configured → accept (matches the org's other webhooks)
  const ts = request.headers.get('close-sig-timestamp') || '';
  const sig = (request.headers.get('close-sig-hash') || '').toLowerCase();
  if (!ts || !sig) return false;
  try {
    const keyBytes = new Uint8Array((key.match(/../g) || []).map((h) => parseInt(h, 16)));
    const ck = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', ck, new TextEncoder().encode(ts + rawBody));
    const hex = Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, '0')).join('');
    return hex === sig;
  } catch (_) { return false; }
}

http.route({
  path: '/inbound-sms',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const raw = await request.text();
    if (!(await verifyCloseSignature(request, raw))) return json({ error: 'bad signature' }, 401);
    let body: any = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch (_) { body = {}; }

    // Close nests the object under event.data; accept flat shapes too.
    const d = (body.event && body.event.data) || body.data || body;
    const direction = String(d.direction || body.direction || '').toLowerCase();
    if (direction && direction !== 'inbound') return json({ ok: true, ignored: 'not inbound' });

    const text = String(d.text || d.body || body.text || '').trim();
    const close_lead_id = String(d.lead_id || body.close_lead_id || '');
    const phone = String(d.remote_phone || d.contact_phone || body.phone || '');

    // Resolve ONLY via the indexed close id when present (org-wide volume → keep it cheap);
    // fall back to phone only when there's no close id at all.
    let lead = null;
    if (close_lead_id) lead = await ctx.runQuery(api.leads.getByCloseLeadId, { close_lead_id });
    else if (phone) lead = await ctx.runQuery(api.leads.getByPhone, { phone });
    if (!lead) return json({ ok: true, ignored: 'not one of our leads' });
    const leadId = lead._id;

    // Deterministic opt-out — never rely on a model for compliance. Covers the FCC's
    // seven per-se keywords (47 CFR 64.1200(a)(10): STOP QUIT END REVOKE OPT-OUT
    // CANCEL UNSUBSCRIBE) plus natural-language refusals a reasonable person would
    // read as revocation ("no more texts", "don't text me", "take me off").
    const isStop = /\b(stop|stopall|unsubscribe|cancel|end|quit|revoke|remove me|opt.?out|do not text|don'?t text|no more (texts|messages)|take me off|lose my number|leave me alone)\b/i.test(text);
    if (isStop) {
      await ctx.runMutation(internal.leads.recordReply, { leadId, text, intent: 'dnc' });
      if (lead.phone) await ctx.runMutation(api.dnc.add, { phone: lead.phone, reason: 'sms: STOP reply' });
      await ctx.runMutation(api.leads.setStatus, { leadId, status: 'dnc' });
      await ctx.scheduler.runAfter(0, internal.close.markDoNotContact, { leadId });
      await ctx.scheduler.runAfter(0, internal.notify.slackReply, { leadId, text, intent: 'dnc' });
      return json({ ok: true, leadId, status: 'dnc', reason: 'stop' });
    }

    // Classify the reply (deterministic keyword buckets — check rejections BEFORE
    // interest so "no thanks" never matches the bare "ok/yes" patterns).
    let intent = 'generic';
    if (/(not interested|no thanks|no thank you|\bnope\b|we'?re good|all set|don'?t need|dont need|no need|already have|leave me alone|\bpass\b)/i.test(text)) intent = 'not_interested';
    else if (/\b(yes|yeah|yep|ya|sure|ok(ay)?|interested|send( it)?|see it|show me|link|how much|price|cost|pricing|sounds good|please|go ahead|lets see|let'?s see)\b/i.test(text)) intent = 'hot';
    else if (/(who ?is this|who'?s this|who are you|what is this|wrong number|how did you get)/i.test(text)) intent = 'generic';
    await ctx.runMutation(internal.leads.recordReply, { leadId, text, intent });
    // 🔥 The one reply worth a push: interested → Slack immediately (speed-to-lead).
    if (intent === 'hot') {
      await ctx.scheduler.runAfter(0, internal.notify.slackHotReply, { leadId, text });
      // AUTO-BUILD: a positive reply is the trigger. Build their demo and text the
      // link — no human in the loop. buildAndSend re-checks every gate before and
      // AFTER the build (a lead can text STOP while it runs), stamps the consent
      // trail, then sends via demos.sendDemoSms. No-ops safely if the build runner
      // isn't configured (BUILD_RUNNER_URL unset) — the Slack ping still fires.
      await ctx.scheduler.runAfter(0, internal.build.buildAndSend, { leadId });
    } else {
      // Alert on EVERY other reply too (not_interested / question / generic) —
      // one Slack ping per reply; hot replies already pinged via slackHotReply above.
      await ctx.scheduler.runAfter(0, internal.notify.slackReply, { leadId, text, intent });
    }

    // Any other reply = engagement. Flip to 'replied' (unless already terminal),
    // which halts the A/B/C nudges, and flag ENGAGED in Close.
    const terminal = ['closed_won', 'closed_lost', 'dnc'];
    let status = lead.status;
    if (!terminal.includes(lead.status)) {
      // A 'hot' reply is a potential opportunity → mark 'interested' so it stands out
      // from generic engagement; every other reply is 'replied'. Both halt the nudges.
      status = intent === 'hot' ? 'interested' : 'replied';
      await ctx.runMutation(api.leads.setStatus, { leadId, status });
    }
    await ctx.scheduler.runAfter(0, internal.close.setCustomFields, { leadId, set: { [CF.ENGAGED]: 'Yes' } });
    return json({ ok: true, leadId, status });
  }),
});

// ─── n8n / admin: POST /status → set funnel status ───────────────────────────
http.route({
  path: '/status',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!(await authorized(ctx, request))) return json({ error: 'unauthorized' }, 401);
    const body = await request.json().catch(() => ({}));
    if (!body.leadId || !body.status) return json({ error: 'leadId + status required' }, 400);
    await ctx.runMutation(api.leads.setStatus, { leadId: body.leadId as Id<'leads'>, status: body.status });
    return json({ ok: true });
  }),
});

// ─── admin: POST /kill → flip the kill switch ────────────────────────────────
http.route({
  path: '/kill',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    if (!(await authorized(ctx, request))) return json({ error: 'unauthorized' }, 401);
    const body = await request.json().catch(() => ({}));
    const paused = body.paused === true || body.paused === 'true';
    await ctx.runMutation(api.systemFlags.set, { key: 'outbound_paused', value: paused });
    return json({ ok: true, outbound_paused: paused });
  }),
});

// ─── AI Receptionist: POST /chat → NVIDIA-backed streamed reply (widget) ─────
// Public (browser widget on the demo). Capped at CHAT_MAX_MESSAGES exchanges.
http.route({
  path: '/chat',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await request.json().catch(() => ({}));
    if (!body.leadId || !body.message) return json({ error: 'leadId + message required' }, 400);
    const leadId = body.leadId as Id<'leads'>;

    const bctx = await ctx.runQuery(internal.businessContexts.getByLeadId, { leadId });
    const sess = await ctx.runMutation(internal.chat.ensureSession, {
      leadId, sessionId: body.sessionId || undefined, fingerprint: body.fingerprint,
    });

    const MAX = Number(process.env.CHAT_MAX_MESSAGES || 6);
    if (sess.ended || sess.message_count >= MAX) {
      return json({
        reply: "It's been great chatting! For anything else, give us a call or leave your name + number and we'll reach right out. 🙌",
        sessionId: sess.sessionId, messageCount: sess.message_count, capped: true, ended: true,
      });
    }

    await ctx.runMutation(internal.chat.appendUser, { sessionId: sess.sessionId, leadId, content: String(body.message).slice(0, 800) });
    const hist = await ctx.runQuery(internal.chat.history, { sessionId: sess.sessionId });

    const system = bctx?.system_prompt
      || 'You are a friendly receptionist for a local trade business. Be brief and helpful. If a visitor shows service intent, ask for their name and phone number.';
    const messages = [{ role: 'system', content: system }, ...hist.map((m) => ({ role: m.role, content: m.content }))];

    let reply = '';
    try {
      const r = await fetch((process.env.VISION_BASE_URL || 'https://integrate.api.nvidia.com/v1') + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + (process.env.VISION_API_KEY || ''), 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: process.env.CHAT_MODEL || 'meta/llama-3.1-8b-instruct', max_tokens: 300, temperature: 0.4, messages }),
      });
      const jr = await r.json();
      reply = jr?.choices?.[0]?.message?.content || "Sorry, I didn't catch that — mind rephrasing?";
    } catch (_) {
      reply = "I'm having a brief hiccup — try again in a sec, or call us directly.";
    }

    // Lead capture: the prompt tells the model to emit [[LEAD_CAPTURED:{...}]] once it has name+phone.
    let captured = false;
    const m = reply.match(/\[\[LEAD_CAPTURED:(\{[\s\S]*?\})\]\]/);
    if (m) {
      reply = reply.replace(m[0], '').trim();
      try {
        const cap = JSON.parse(m[1]);
        if (cap.name && cap.phone) {
          await ctx.runMutation(internal.capturedLeads.record, {
            leadId, source: 'chat', session_id: String(sess.sessionId),
            visitor_name: String(cap.name), visitor_phone: String(cap.phone),
            service_needed: cap.service, urgency: cap.urgency, summary: cap.summary,
          });
          await ctx.runMutation(internal.chat.markCaptured, { sessionId: sess.sessionId });
          captured = true;
          if (!reply) reply = `Perfect — I've got your info and ${bctx?.business_name || 'the owner'} will text you back shortly. 🙌`;
        }
      } catch (_) { /* ignore malformed capture */ }
    }

    const willCap = (sess.message_count + 1) >= MAX;
    await ctx.runMutation(internal.chat.appendAssistant, { sessionId: sess.sessionId, leadId, content: reply, ended: willCap });
    return json({ reply, sessionId: sess.sessionId, messageCount: sess.message_count + 1, capped: willCap, captured });
  }),
});

// ─── AI Receptionist: POST /voice/start → mint a Retell web call (widget) ────
http.route({
  path: '/voice/start',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await request.json().catch(() => ({}));
    if (!body.leadId) return json({ error: 'leadId required' }, 400);
    const key = process.env.RETELL_API_KEY || '', agent = process.env.RETELL_DEMO_AGENT_ID || '';
    if (!key || !agent) return json({ error: 'voice not configured yet' }, 503);
    const leadId = body.leadId as Id<'leads'>;
    const bctx = await ctx.runQuery(internal.businessContexts.getByLeadId, { leadId });
    const r = await fetch('https://api.retellai.com/v2/create-web-call', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: agent, retell_llm_dynamic_variables: (bctx && bctx.retell_dynamic_vars) || {}, metadata: { leadId } }),
    });
    const call = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: 'retell error', detail: call }, 502);
    await ctx.runMutation(internal.callSessions.create, { leadId, retellCallId: call.call_id });
    return json({ access_token: call.access_token, call_id: call.call_id, max_seconds: Number(process.env.VOICE_MAX_SECONDS || 60) });
  }),
});

// ─── AI Receptionist: POST /voice/webhook → Retell post-call ─────────────────
http.route({
  path: '/voice/webhook',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const body = await request.json().catch(() => ({}));
    const ev = body.event, data = body.data || body.call || {};
    if (ev === 'call_ended' || ev === 'call_analyzed') {
      const callId = data.call_id;
      const dur = data.duration_ms ? Math.round(data.duration_ms / 1000) : undefined;
      const cap = (data.call_analysis && data.call_analysis.custom_analysis_data) || {};
      const gotLead = !!(cap.visitor_name && cap.visitor_phone);
      await ctx.runMutation(internal.callSessions.updateFromRetell, {
        retellCallId: callId, duration_s: dur,
        transcript: data.transcript, summary: data.call_analysis && data.call_analysis.call_summary, captured: gotLead,
      });
      if (gotLead) {
        const cs = await ctx.runQuery(internal.callSessions.getByRetellId, { retellCallId: callId });
        if (cs) await ctx.runMutation(internal.capturedLeads.record, {
          leadId: cs.lead_id, source: 'voice', session_id: callId,
          visitor_name: String(cap.visitor_name), visitor_phone: String(cap.visitor_phone),
          service_needed: cap.service_needed, urgency: cap.urgency, summary: cap.summary,
        });
      }
    }
    return json({ ok: true });
  }),
});

/** Best-effort client IP, for the login lockout. */
function clientIp(request: Request): string {
  const xff = request.headers.get('x-forwarded-for') || '';
  return (xff.split(',')[0] || request.headers.get('cf-connecting-ip') || 'unknown').trim();
}

/**
 * The dashboard's session token. Read from a HEADER, not the query string.
 *
 * It used to arrive as `?token=…`. URLs are written to proxy logs, browser history,
 * and Referer headers — and this token unlocks every lead's name, phone, and reply
 * text. Headers are not logged that way.
 */
function dashboardToken(request: Request): string {
  return request.headers.get('x-dashboard-token') || '';
}

// ─── Ops dashboard login: POST /dashboard-login {id, password} → {token} ─────
// Rate-limited (5 wrong passwords → 15-minute lockout per IP), constant-time
// comparison, and it mints a REAL session that expires in 12h — not the old static
// forever-token. See convex/dashboardAuth.ts.
http.route({
  path: '/dashboard-login',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const ip = clientIp(request);

    const lock = await ctx.runQuery(internal.dashboardAuth.checkLockout, { ip });
    if (lock.locked) {
      return json({ error: `too many attempts — try again in ${Math.ceil(lock.retry_in_s / 60)} min` }, 429);
    }

    const body = await request.json().catch(() => ({}));
    const user = process.env.DASHBOARD_USER || '', pass = process.env.DASHBOARD_PASS || '';
    if (!user || !pass) return json({ error: 'login not configured' }, 503);

    // Constant-time on BOTH fields — never short-circuit on the first wrong byte.
    const okUser = timingSafeEq(String(body.id ?? ''), user);
    const okPass = timingSafeEq(String(body.password ?? ''), pass);
    if (!okUser || !okPass) {
      const f = await ctx.runMutation(internal.dashboardAuth.recordFailure, { ip });
      return json(
        { error: f.locked ? 'too many attempts — locked out for 15 min' : 'wrong ID or password' },
        f.locked ? 429 : 401,
      );
    }

    // Mint a fresh random session token (32 bytes), not a shared constant.
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const token = Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
    const { expires_at } = await ctx.runMutation(internal.dashboardAuth.createSession, { token, ip });
    return json({ token, expires_at });
  }),
});

// ─── Ops dashboard logout: POST /dashboard-logout → kill this session ────────
http.route({
  path: '/dashboard-logout',
  method: 'POST',
  handler: httpAction(async (ctx, request) => {
    const token = dashboardToken(request);
    const revoked = token ? await ctx.runMutation(internal.dashboardAuth.revokeToken, { token }) : false;
    return json({ ok: true, revoked });
  }),
});

// ─── Ops dashboard (hosted build): GET /dashboard-stats → stats:dashboard ────
// FAILS CLOSED. Requires a live, unexpired session token in the x-dashboard-token
// header. The old check was `if (required && token !== required)` — which skipped
// entirely when DASHBOARD_TOKEN was unset, leaving the full lead database (names,
// phones, reply text) world-readable to anyone who knew the Convex URL.
http.route({
  path: '/dashboard-stats',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const ok = await ctx.runQuery(internal.dashboardAuth.validateToken, { token: dashboardToken(request) });
    if (!ok) return json({ error: 'unauthorized — log in again' }, 401);
    const url = new URL(request.url);
    const p = url.searchParams.get('period');
    const period = p === '24h' || p === '7d' || p === 'all' ? p : 'all';
    const stats = await ctx.runQuery(api.stats.dashboard, { period });
    return json(stats);
  }),
});

// ─── Cloud-native demo: GET /demo/{leadId} → render + serve the page ─────────
// No external computer. Loads the lead + its niche template and runs reskin.ts
// (pure string swap) per-request, so a demo "builds" instantly and is hosted by
// Convex itself. This is the target of the tracked /r/{leadId} redirect.
http.route({
  pathPrefix: '/demo/',
  method: 'GET',
  handler: httpAction(async (ctx, request) => {
    const url = new URL(request.url);
    const raw = url.pathname.slice('/demo/'.length).split('/')[0];
    if (!raw) return new Response('missing lead id', { status: 400 });
    let data;
    try {
      data = await ctx.runQuery(internal.demoTemplates.getRenderable, { leadId: raw as Id<'leads'> });
    } catch (_) {
      return new Response('invalid lead id', { status: 404 });
    }
    if (!data) return new Response('demo not available', { status: 404 });
    let out: string;
    try {
      out = reskinHtml(data.manifest, data.html, data.lead).html;
    } catch (e: any) {
      return new Response('demo render error: ' + (e?.message || 'unknown'), { status: 500 });
    }
    return new Response(out, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=300',
        'X-Robots-Tag': 'noindex',
      },
    });
  }),
});

// ─── health ──────────────────────────────────────────────────────────────────
http.route({
  path: '/health',
  method: 'GET',
  handler: httpAction(async () => json({ ok: true, service: 'ugly-rebuild-convex' })),
});

export default http;
