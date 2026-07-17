// ─────────────────────────────────────────────────────────────────────────────
// stats.ts — the aggregated dashboard payload for the admin/ ops panel.
// One query returns the whole picture of the Ugly-Website Rebuild pipeline;
// one mutation flips the kill switch. Read straight from the schema tables.
//
// Scale note: this collect()s a handful of whole tables (leads, review_website,
// sms_send_log, demos, clicks, view_events, followup_jobs, pipeline_errors).
// Fine at this operation's size (thousands of rows) at a 10s poll; swap for
// counter tables if any single table grows past Convex's per-query read limit.
// ─────────────────────────────────────────────────────────────────────────────
import { query, mutation } from './_generated/server';
import { v } from 'convex/values';
import { inSendWindow } from './lib';

const LEAD_STATUSES = [
  'new', 'opener_sent', 'demo_ready', 'queued_call', 'called', 'opted_in',
  'demo_sent', 'interested', 'replied', 'closed_won', 'closed_lost', 'dnc', 'duplicate',
] as const;
const SMS_STAGES = ['opener', 'opener_nudge_1', 'opener_nudge_2', 'opener_breakup', 'demo_send', 'followup_a', 'followup_b', 'followup_c', 'owner_notification'] as const;
const KILL_KEY = 'outbound_paused';

export const dashboard = query({
  args: { period: v.optional(v.union(v.literal('24h'), v.literal('7d'), v.literal('all'))) },
  handler: async (ctx, { period }) => {
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    // Rolling windows (not calendar days) — and EVERY panel that uses the period
    // filters BOTH its numerator and denominator, fixing the auto-website bug
    // where all-time errors were subtracted from period-filtered sends.
    const cutoff = period === '24h' ? dayAgo : period === '7d' ? now - 7 * 24 * 60 * 60 * 1000 : 0;

    const flag = await ctx.db.query('system_flags').withIndex('by_key', (q) => q.eq('key', KILL_KEY)).first();
    const outbound_paused = flag ? !!flag.value : false;

    // ── Leads: by status + by niche ──────────────────────────────────────────
    const leads = await ctx.db.query('leads').collect();
    const by_status: Record<string, number> = {}; for (const s of LEAD_STATUSES) by_status[s] = 0;
    const by_niche: Record<string, number> = {};
    let with_number = 0, engaged_flag = 0;
    for (const l of leads) {
      by_status[l.status] = (by_status[l.status] || 0) + 1;
      by_niche[l.niche] = (by_niche[l.niche] || 0) + 1;
      if (l.sms_from_number) with_number++;
    }
    // A lead "reached" (got an opener) = anything past 'new' that isn't a quarantined dup.
    const reached = leads.filter((l) => !['new', 'duplicate'].includes(l.status)).length;

    // ── SMS log — every send this system makes is logged here, INCLUDING the
    //    opener (Touch 1) and the O1/O2/O3 nudges (opener is now Convex-native,
    //    not n8n). Real-time; the delivery STATUS lags via the sms_delivery mirror. ──
    const sms = await ctx.db.query('sms_send_log').collect();
    const sms_by_stage: Record<string, number> = {}; for (const s of SMS_STAGES) sms_by_stage[s] = 0;
    const sms_by_number: Record<string, number> = {};
    let sms_24h = 0;
    // Real-time send truth. sms_send_log is written the instant a text fires, so this
    // is accurate NOW — unlike the 'opener_sent' lead status (set at QUEUE time, before
    // the staggered send actually goes out) and unlike the sms_delivery mirror (lags the
    // Close sync). openers_sent = leads that ACTUALLY received the opener.
    const openerLeadSet = new Set<string>();
    const sendCountByLead = new Map<string, number>();
    for (const m of sms) {
      sms_by_stage[m.stage] = (sms_by_stage[m.stage] || 0) + 1;
      sms_by_number[m.from_number] = (sms_by_number[m.from_number] || 0) + 1;
      if (m.sent_at >= dayAgo) sms_24h++;
      const lk = String(m.lead_id);
      sendCountByLead.set(lk, (sendCountByLead.get(lk) || 0) + 1);
      if (m.stage === 'opener') openerLeadSet.add(lk);
    }
    const openers_sent = openerLeadSet.size;
    const leadsTexted = sendCountByLead.size;
    const leadsFollowedUp = [...sendCountByLead.values()].filter((c) => c >= 2).length;

    // ── Other buckets ────────────────────────────────────────────────────────
    const review_website = (await ctx.db.query('review_website').collect()).length;
    const dnc = (await ctx.db.query('dnc_list').collect()).length;

    const demos = await ctx.db.query('demos').collect();
    let demos_ready = 0, demos_sent = 0;
    for (const d of demos) { if (d.demo_status === 'ready') demos_ready++; if (d.sent_at) demos_sent++; }

    const clicks = await ctx.db.query('clicks').collect();
    const views = await ctx.db.query('view_events').collect();
    const captured = (await ctx.db.query('captured_leads').collect()).length;
    const clickedLeads = new Set(clicks.map((c) => String(c.lead_id)));
    const viewedLeads = new Set(views.map((w) => String(w.lead_id)));
    const rate = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : 0); // percent, 1dp

    const jobs = await ctx.db.query('followup_jobs').collect();
    const followups: Record<string, Record<string, number>> = { A: { scheduled: 0, fired: 0, skipped: 0 }, B: { scheduled: 0, fired: 0, skipped: 0 }, C: { scheduled: 0, fired: 0, skipped: 0 } };
    for (const j of jobs) { if (!followups[j.stage]) followups[j.stage] = { scheduled: 0, fired: 0, skipped: 0 }; followups[j.stage][j.status] = (followups[j.stage][j.status] || 0) + 1; }

    const errs = await ctx.db.query('pipeline_errors').collect();
    errs.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
    const recent = errs.slice(0, 15).map((e) => ({ workflow: e.workflow, error: e.error, lead_id: e.lead_id ? String(e.lead_id) : null, created_at: e.created_at }));

    // ── Delivery health (from the Close mirror; includes n8n-sent openers) ────
    const deliveries = await ctx.db.query('sms_delivery').collect();
    const inWindow = deliveries.filter((d) => d.activity_at >= cutoff);
    const out = inWindow.filter((d) => d.direction === 'outbound');
    const DELIVERED = new Set(['sent', 'delivered', 'completed']);
    const QUEUED = new Set(['outbox', 'scheduled', 'queued', 'sending']);
    let delivered = 0, errored = 0, queued = 0;
    const error_types: Record<string, number> = {};      // full messages (detail)
    const error_cats: Record<string, number> = {};        // plain-English buckets
    // Bucket each carrier error so the dashboard shows WHY texts fail, separated and
    // readable, instead of one truncated string. Landlines dominate a scraped list.
    const categorizeErr = (raw: string): string => {
      const m = raw.toLowerCase();
      if (/unable to receive|landline|land line/.test(m)) return 'Landline — can’t receive texts';
      if (/unknown destination|handset|invalid|not a valid|unallocated|no route|does not exist|disconnected/.test(m)) return 'Invalid / disconnected number';
      if (/filter|spam|block|violat|rejected|carrier/.test(m)) return 'Carrier filtered (spam block)';
      if (/opt|do not|\bstop\b|unsub|blacklist/.test(m)) return 'Opted out / do-not-contact';
      return 'Other';
    };
    for (const d of out) {
      if (d.status === 'error') {
        errored++;
        const full = d.error_message || 'unknown error';
        error_types[full.slice(0, 90)] = (error_types[full.slice(0, 90)] || 0) + 1;
        const cat = categorizeErr(full);
        error_cats[cat] = (error_cats[cat] || 0) + 1;
      }
      else if (DELIVERED.has(d.status)) delivered++;
      else if (QUEUED.has(d.status)) queued++;
    }
    const error_breakdown = Object.entries(error_cats)
      .map(([label, count]) => ({ label, count, pct: errored ? Math.round((count / errored) * 1000) / 10 : 0 }))
      .sort((a, b) => b.count - a.count);
    const lastSync = deliveries.reduce((m, d) => Math.max(m, d.synced_at || 0), 0);
    // Per-lead latest outbound (all-time — powers the campaign table's badge).
    const latestOutByLead = new Map<string, { status: string; error?: string; at: number }>();
    let inboundCount = 0;
    for (const d of deliveries) {
      if (d.direction === 'inbound') { if (d.activity_at >= cutoff) inboundCount++; continue; }
      const k = String(d.lead_id);
      const cur = latestOutByLead.get(k);
      if (!cur || d.activity_at > cur.at) latestOutByLead.set(k, { status: d.status, error: d.error_message, at: d.activity_at });
    }

    // ── Capacity vs carrier limits (T-Mobile cap is per BRAND — all 14 numbers
    //    share it — and resets midnight PT; AT&T caps sends/minute per campaign) ──
    const ptOff = (new Date(now).getUTCMonth() + 1 >= 3 && new Date(now).getUTCMonth() + 1 <= 11) ? -7 : -8;
    const ptDayStart = Math.floor((now + ptOff * 3600e3) / 86400e3) * 86400e3 - ptOff * 3600e3;
    const outboundAll = deliveries.filter((d) => d.direction === 'outbound');
    const todayOut = outboundAll.filter((d) => d.activity_at >= ptDayStart);
    const perMinute = new Map<number, number>();
    for (const d of todayOut) { const m = Math.floor(d.activity_at / 60000); perMinute.set(m, (perMinute.get(m) || 0) + 1); }
    const capacity = {
      today_sends: todayOut.length,
      brand_daily_cap: Number(process.env.TMOBILE_DAILY_CAP || 2000),
      peak_per_minute: Math.max(0, ...perMinute.values()),
      att_tpm_limit: 75,
    };

    // ── Quiet-hours audit (8am–9pm lead-local, 47 CFR 64.1200(c)(1)) ──────────
    const stateByLead = new Map<string, string>();
    for (const l of leads) stateByLead.set(String(l._id), l.state);
    let quietViolations = 0;
    for (const d of outboundAll) {
      const st = stateByLead.get(String(d.lead_id));
      if (st != null && !inSendWindow(st, d.activity_at)) quietViolations++;
    }
    const quiet_hours = { violations: quietViolations, audited: outboundAll.length };

    // ── Per-number health: trailing 7d vs the 7d before it (baseline delta) ───
    const weekAgo = now - 7 * 86400e3, twoWeeksAgo = now - 14 * 86400e3;
    const byNumber = new Map<string, { s7: number; ok7: number; err7: number; okPrev: number; errPrev: number }>();
    for (const d of outboundAll) {
      const n = d.local_phone || '(unknown)';
      if (!byNumber.has(n)) byNumber.set(n, { s7: 0, ok7: 0, err7: 0, okPrev: 0, errPrev: 0 });
      const b = byNumber.get(n)!;
      const ok = ['sent', 'delivered', 'completed'].includes(d.status), bad = d.status === 'error';
      if (d.activity_at >= weekAgo) { b.s7++; if (ok) b.ok7++; if (bad) b.err7++; }
      else if (d.activity_at >= twoWeeksAgo) { if (ok) b.okPrev++; if (bad) b.errPrev++; }
    }
    const pctOr = (a: number, b: number) => (a + b > 0 ? Math.round((a / (a + b)) * 1000) / 10 : null);
    const number_health = [...byNumber.entries()].map(([number, b]) => {
      const rate7 = pctOr(b.ok7, b.err7), prev = pctOr(b.okPrev, b.errPrev);
      return { number, sends_7d: b.s7, errors_7d: b.err7, rate_7d: rate7, rate_prev7d: prev,
        delta: rate7 != null && prev != null ? Math.round((rate7 - prev) * 10) / 10 : null };
    }).sort((a, b) => b.sends_7d - a.sends_7d);

    // ── SMS sequence (sends by touch number, derived from the Close mirror) ──
    // Touch N = the Nth outbound SMS a lead ever received (openers included).
    // Period filters which SENDS count, but touch position is assigned all-time
    // so a follow-up never masquerades as an opener inside a short window.
    const outByLead = new Map<string, { at: number }[]>();
    for (const d of deliveries) {
      if (d.direction !== 'outbound') continue;
      const k = String(d.lead_id);
      if (!outByLead.has(k)) outByLead.set(k, []);
      outByLead.get(k)!.push({ at: d.activity_at });
    }
    const seqCounts = [0, 0, 0, 0]; // touch 1, 2, 3, 4+
    let seqTotal = 0;
    for (const sends of outByLead.values()) {
      sends.sort((a, b) => a.at - b.at);
      sends.forEach((s, i) => {
        if (s.at < cutoff) return;
        seqCounts[Math.min(i, 3)]++;
        seqTotal++;
      });
    }
    const sequence = {
      total: seqTotal,
      touches: [
        { label: 'Opener', count: seqCounts[0] },
        { label: 'Follow-up 1', count: seqCounts[1] },
        { label: 'Follow-up 2', count: seqCounts[2] },
        { label: 'Follow-up 3+', count: seqCounts[3] },
      ].map((t) => ({ ...t, pct: seqTotal ? Math.round((t.count / seqTotal) * 1000) / 10 : 0 })),
    };

    // ── Full pipeline funnel (scraped → won, all-time) ────────────────────────
    const pushedToClose = leads.filter((l) => l.close_lead_id).length;
    // Real-time (sms_send_log), not the lagging sms_delivery mirror.
    const leadsWithSend = leadsTexted;
    const leadsWithFollowup = leadsFollowedUp;
    const hotAllTime = leads.filter((l) => l.reply_intent === 'hot').length;
    const repliedAllTime = leads.filter((l) => l.replied_at || l.status === 'replied').length;

    // ── Reply classification + hot list (period on replied_at) ───────────────
    const repliedLeads = leads.filter((l) => l.reply_intent && (l.replied_at || 0) >= cutoff);
    const replies = { hot: 0, not_interested: 0, generic: 0, dnc: 0 } as Record<string, number>;
    for (const l of repliedLeads) replies[l.reply_intent!] = (replies[l.reply_intent!] || 0) + 1;
    const leadRow = (l: (typeof leads)[number]) => ({
      lead_id: l._id,
      name: l.name, niche: l.niche, city: l.city, state: l.state, phone: l.phone,
      status: l.status, close_lead_id: l.close_lead_id || null,
      replied_at: l.replied_at || null, reply_intent: l.reply_intent || null,
      last_reply_text: l.last_reply_text || null,
    });
    // Speed-to-lead: first outbound AFTER the reply = our response (contact odds
    // drop ~100x between a 5-min and 30-min response — the one timer that matters).
    const responseInfo = (l: (typeof leads)[number]) => {
      if (!l.replied_at) return {};
      const sends = outByLead.get(String(l._id)) || [];
      const first = sends.filter((s) => s.at > l.replied_at!).sort((a, b) => a.at - b.at)[0];
      return first
        ? { responded_in_ms: first.at - l.replied_at }
        : { waiting_ms: now - l.replied_at };
    };
    const hot_leads = repliedLeads
      .filter((l) => l.reply_intent === 'hot')
      .sort((a, b) => (b.replied_at || 0) - (a.replied_at || 0))
      .slice(0, 50).map((l) => ({ ...leadRow(l), ...responseInfo(l) }));
    const responseTimes = repliedLeads
      .map((l) => (responseInfo(l) as any).responded_in_ms).filter((x) => x != null)
      .sort((a: number, b: number) => a - b);
    const median_response_ms = responseTimes.length
      ? responseTimes[Math.floor(responseTimes.length / 2)] : null;

    // ── Per-lead campaign table (contacted leads, NEWEST first) ───────────────
    const clicksByLead = new Map<string, number>();
    for (const c of clicks) { const k = String(c.lead_id); clicksByLead.set(k, (clicksByLead.get(k) || 0) + 1); }
    const viewsByLead = new Map<string, number>();
    for (const w of views) { const k = String(w.lead_id); viewsByLead.set(k, (viewsByLead.get(k) || 0) + 1); }
    const demoUrlByLead = new Map<string, string>();
    for (const d of demos) { const u = d.short_url || d.demo_url; if (u) demoUrlByLead.set(String(d.lead_id), u); }
    const campaign = leads
      .filter((l) => !['new', 'duplicate'].includes(l.status))
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
      .slice(0, 200)
      .map((l) => {
        const k = String(l._id);
        const last = latestOutByLead.get(k);
        return {
          ...leadRow(l),
          from_number: l.sms_from_number || null,
          last_send_status: last ? last.status : null,
          last_send_error: last?.error ? last.error.slice(0, 90) : null,
          last_send_at: last ? last.at : null,
          clicks: clicksByLead.get(k) || 0,
          views: viewsByLead.get(k) || 0,
          demo_url: demoUrlByLead.get(k) || null,
        };
      });

    return {
      period: period || 'all',
      generated_at: now,
      kill_switch: { outbound_paused },
      leads: { total: leads.length, reached, with_number, by_status, by_niche },
      duplicates: by_status.duplicate || 0,
      review_website,
      dnc,
      funnel: {
        new: by_status.new || 0,
        opener_sent: by_status.opener_sent || 0,
        replied: by_status.replied || 0,
        demo_sent: by_status.demo_sent || 0,
        closed_won: by_status.closed_won || 0,
      },
      sms: { logged_total: sms.length, last_24h: sms_24h, by_stage: sms_by_stage, by_number: sms_by_number, openers_sent, leads_texted: leadsTexted, queued: (by_status.opener_sent || 0) - openers_sent },
      demos: { total: demos.length, ready: demos_ready, sent: demos_sent },
      engagement: {
        clicks: clicks.length, unique_clicked: clickedLeads.size,
        views: views.length, unique_viewed: viewedLeads.size,
        captured_leads: captured,
        click_rate: rate(clickedLeads.size, demos_sent),
        view_rate: rate(viewedLeads.size, demos_sent),
      },
      followups,
      errors: { total: errs.length, recent },
      delivery: {
        delivered, errored, queued, inbound: inboundCount,
        rate: delivered + errored > 0 ? Math.round((delivered / (delivered + errored)) * 1000) / 10 : null,
        error_types,
        error_breakdown,
        last_synced: lastSync || null,
        mirrored_total: deliveries.length,
      },
      replies: { ...replies, total: repliedLeads.length },
      hot_leads,
      median_response_ms,
      campaign,
      sequence,
      capacity,
      quiet_hours,
      number_health,
      pipeline: {
        scraped: leads.length,
        pushed_to_close: pushedToClose,
        first_sms: leadsWithSend,
        followup_1: leadsWithFollowup,
        replied: repliedAllTime,
        hot: hotAllTime,
        demos_built: demos.length,
      },
    };
  },
});

// ── Diagnostic: is the auto-follow-up machine actually scheduled? ────────────
export const followupStatus = query({
  args: {},
  handler: async (ctx) => {
    const jobs = await ctx.db.query('followup_jobs').collect();
    const jobsByStage: Record<string, Record<string, number>> = {};
    for (const j of jobs) {
      (jobsByStage[j.stage] ||= { scheduled: 0, fired: 0, skipped: 0 });
      jobsByStage[j.stage][j.status] = (jobsByStage[j.stage][j.status] || 0) + 1;
    }
    // What Convex's durable scheduler actually has queued right now.
    const sched = await ctx.db.system.query('_scheduled_functions').collect();
    const pending: Record<string, number> = {};
    const nextFire: Record<string, number> = {};
    for (const s of sched) {
      if (s.state.kind !== 'pending') continue;
      const fn = String(s.name).split(/[:/]/).pop() || s.name;
      pending[fn] = (pending[fn] || 0) + 1;
      if (!nextFire[fn] || s.scheduledTime < nextFire[fn]) nextFire[fn] = s.scheduledTime;
    }
    return { followup_jobs: jobsByStage, scheduled_pending: pending, next_fire: nextFire, now: Date.now() };
  },
});

// ── Kill switch — every send path checks system_flags.outbound_paused ────────
export const setKillSwitch = mutation({
  args: { paused: v.optional(v.boolean()), toggle: v.optional(v.boolean()), secret: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const required = process.env.ADMIN_MUTATION_SECRET;
    if (required && args.secret !== required) throw new Error('setKillSwitch: unauthorized');
    const existing = await ctx.db.query('system_flags').withIndex('by_key', (q) => q.eq('key', KILL_KEY)).first();
    const current = existing ? !!existing.value : false;
    const next = typeof args.paused === 'boolean' ? args.paused : !current;
    if (existing) await ctx.db.patch(existing._id, { value: next });
    else await ctx.db.insert('system_flags', { key: KILL_KEY, value: next });
    return { outbound_paused: next, previous: current, changed: next !== current };
  },
});
