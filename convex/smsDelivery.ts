// ─────────────────────────────────────────────────────────────────────────────
// smsDelivery.ts — SMS Delivery Health: mirror Close's per-message delivery
// status into our own `sms_delivery` table.
//
// Why: Close accepts an SMS into 'outbox' and only LATER marks it 'error' if the
// carrier rejects it (landline, call-tracking line, filtering). Our send paths
// treat "accepted" as "sent", so without this sweep a failed opener looks
// delivered forever — exactly what happened to 2 of the first 7 campaign leads.
//
//   sweep     (internalAction, cron every 15 min) — for each contacted lead,
//             GET its Close SMS activities and upsert them here (openers included,
//             which never pass through sms_send_log).
//   sweepNow  (public action) — manual trigger: `npx convex run smsDelivery:sweepNow`
//   upsert    (internalMutation) — idempotent by Close activity_id.
//
// READ-ONLY against Close. Writes only to our own table.
// ─────────────────────────────────────────────────────────────────────────────
import { action, internalAction, internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { api, internal } from './_generated/api';
import { now } from './lib';
import { CF } from './close';

const CLOSE_BASE = 'https://api.close.com/api/v1';

/** Carrier-level rejections — the message never reached a handset. */
const DEAD_STATUSES = ['error', 'failed', 'undelivered'];

/**
 * True when we HAVE delivery rows for this lead and EVERY outbound one is a carrier
 * rejection — i.e. the number can't receive SMS at all (landline / call-tracking line).
 * Used to suppress opener nudges: texting "did that come through?" to a landline that
 * already bounced is pointless and still bills.
 *
 * Returns false when we have no rows yet (the 15-min sweep may not have run), so a
 * missing mirror never silently kills a legitimate nudge.
 */
export const allOutboundFailed = internalQuery({
  args: { leadId: v.id('leads') },
  returns: v.boolean(),
  handler: async (ctx, { leadId }) => {
    const rows = await ctx.db
      .query('sms_delivery')
      .withIndex('by_lead_id', (q) => q.eq('lead_id', leadId))
      .collect();
    const outbound = rows.filter((r) => r.direction === 'outbound');
    if (outbound.length === 0) return false;
    return outbound.every((r) => DEAD_STATUSES.includes(String(r.status).toLowerCase()));
  },
});

function authHeader(): string {
  const key = process.env.CLOSE_API_KEY || '';
  if (!key) throw new Error('CLOSE_API_KEY not set');
  return 'Basic ' + btoa(key + ':');
}

export const upsert = internalMutation({
  args: {
    activity_id: v.string(),
    lead_id: v.id('leads'),
    close_lead_id: v.string(),
    direction: v.string(),
    status: v.string(),
    error_message: v.optional(v.string()),
    local_phone: v.optional(v.string()),
    remote_phone: v.optional(v.string()),
    text_preview: v.optional(v.string()),
    activity_at: v.number(),
  },
  handler: async (ctx, a) => {
    const existing = await ctx.db
      .query('sms_delivery')
      .withIndex('by_activity_id', (q) => q.eq('activity_id', a.activity_id))
      .first();
    if (existing) {
      // Status/error are the fields Close updates after the fact.
      await ctx.db.patch(existing._id, { status: a.status, error_message: a.error_message, synced_at: now() });
      return { updated: true };
    }
    await ctx.db.insert('sms_delivery', { ...a, synced_at: now() });
    return { updated: false };
  },
});

async function runSweep(ctx: any, limit: number): Promise<{ leads: number; activities: number; errors: number }> {
  if (!process.env.CLOSE_API_KEY) return { leads: 0, activities: 0, errors: 0 };
  const leads = await ctx.runQuery(internal.leads.contactedWithCloseId, { limit });
  let activities = 0, errors = 0;
  for (const lead of leads) {
    let res: Response;
    try {
      res = await fetch(`${CLOSE_BASE}/activity/sms/?lead_id=${encodeURIComponent(lead.close_lead_id)}&_limit=25`, {
        headers: { Authorization: authHeader() },
      });
    } catch (_) { continue; }
    if (!res.ok) continue;
    const json: any = await res.json().catch(() => ({}));
    let delivered = false, hardErrored = false;   // this lead's outbound outcome, this pass
    for (const a of json.data || []) {
      if (!a.id) continue;
      const status = String(a.status || 'unknown');
      if (status === 'error') errors++;
      if (String(a.direction || 'outbound') === 'outbound') {
        const s = status.toLowerCase();
        if (['sent', 'delivered', 'completed'].includes(s)) delivered = true;
        else if (s === 'error') hardErrored = true;
      }
      await ctx.runMutation(internal.smsDelivery.upsert, {
        activity_id: String(a.id),
        lead_id: lead._id,
        close_lead_id: lead.close_lead_id!,
        direction: String(a.direction || 'outbound'),
        status,
        error_message: a.error_message ? String(a.error_message).slice(0, 200) : undefined,
        local_phone: a.local_phone || undefined,
        remote_phone: a.remote_phone || undefined,
        text_preview: a.text ? String(a.text).slice(0, 90) : undefined,
        activity_at: a.date_created ? Date.parse(a.date_created) : now(),
      });
      activities++;
    }
    // Line type from the delivery result: a text that landed proves the number is
    // textable ('mobile'); one that hard-errored is a 'landline' (or dead number).
    // setLineType is sticky on 'mobile' and no-ops if unchanged, so this only pushes
    // to Close once per lead, when first discovered or when it flips to textable.
    const lineType = delivered ? 'mobile' : hardErrored ? 'landline' : null;
    if (lineType) {
      const r = await ctx.runMutation(internal.leads.setLineType, { leadId: lead._id, lineType });
      if (r.changed) {
        try { await ctx.runAction(internal.close.setCustomFields, { leadId: lead._id, set: { [CF.LINE_TYPE]: lineType } }); } catch (_) { /* best-effort */ }
      }
    }
  }
  return { leads: leads.length, activities, errors };
}

// T-Mobile's brand-level daily cap resets at midnight PACIFIC (per Twilio error-30023
// docs). Rough PT day-start (DST-aware by month) — precision to the hour is plenty.
function ptDayStart(ts: number): number {
  const d = new Date(ts);
  const off = (d.getUTCMonth() + 1 >= 3 && d.getUTCMonth() + 1 <= 11) ? -7 : -8;
  const shifted = ts + off * 3600e3;
  return Math.floor(shifted / 86400e3) * 86400e3 - off * 3600e3;
}

/** Small summary the alerting logic reads after each sweep. */
export const deliverySummary = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('sms_delivery').collect();
    const dayStart = ptDayStart(now());
    const weekAgo = now() - 7 * 86400e3;
    let todaySends = 0, todayDelivered = 0, todayErrored = 0, weekDelivered = 0, weekErrored = 0;
    for (const r of rows) {
      if (r.direction !== 'outbound') continue;
      const ok = ['sent', 'delivered', 'completed'].includes(r.status);
      const bad = r.status === 'error';
      if (r.activity_at >= dayStart) { todaySends++; if (ok) todayDelivered++; if (bad) todayErrored++; }
      if (r.activity_at >= weekAgo && r.activity_at < dayStart) { if (ok) weekDelivered++; if (bad) weekErrored++; }
    }
    const rate = (a: number, b: number) => (a + b > 0 ? (a / (a + b)) * 100 : null);
    return {
      todaySends, todayErrored,
      todayRate: rate(todayDelivered, todayErrored),
      baselineRate: rate(weekDelivered, weekErrored), // trailing 7d EXCLUDING today
    };
  },
});

/** Push a deduped ops alert (at most one per `everyMs` per key). */
async function alertOnce(ctx: any, key: string, everyMs: number, text: string): Promise<void> {
  const last = await ctx.runQuery(api.systemFlags.get, { key });
  if (last && now() - Number(last) < everyMs) return;
  await ctx.runMutation(api.systemFlags.set, { key, value: now() });
  await ctx.runAction(internal.notify.slackAlert, { text });
}

/** Cron target — every 3 min (see crons.ts). Syncs, then checks the 2 push-worthy alerts. */
export const sweep = internalAction({
  args: {},
  handler: async (ctx): Promise<{ leads: number; activities: number; errors: number }> => {
    // 300 (not 100) so an active campaign's full in-flight set gets its delivery
    // status mirrored, not just the newest 100 leads.
    const res = await runSweep(ctx, 300);
    try {
      const s = await ctx.runQuery(internal.smsDelivery.deliverySummary, {});
      const cap = Number(process.env.TMOBILE_DAILY_CAP || 2000);
      // Alert 1 — brand daily volume approaching the T-Mobile cap (cap is per BRAND,
      // shared across ALL numbers; over-cap messages fail but still bill).
      if (s.todaySends >= cap * 0.8) {
        await alertOnce(ctx, 'alert_cap_at', 12 * 3600e3,
          `:rotating_light: *T-Mobile brand cap approaching* — ${s.todaySends} sends today vs cap ${cap} (resets midnight PT). Over-cap messages FAIL but still bill. Pause or spread follow-ups.`);
      }
      // Alert 2 — delivery-rate collapse vs our own trailing baseline (the primary
      // 10DLC filtering signal; absolute error counts alone lag this).
      if (s.todaySends >= 10 && s.todayRate != null && s.baselineRate != null && s.todayRate < s.baselineRate - 20) {
        await alertOnce(ctx, 'alert_delivery_at', 6 * 3600e3,
          `:warning: *Delivery rate collapsed* — today ${s.todayRate.toFixed(0)}% vs 7-day baseline ${s.baselineRate.toFixed(0)}% (${s.todayErrored} errors). Possible carrier filtering — check the number-health table before sending more.`);
      }
    } catch (_) { /* alerting must never break the sync */ }
    return res;
  },
});

/** Manual trigger for ops/testing: `npx convex run smsDelivery:sweepNow '{}'`. */
export const sweepNow = action({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<{ leads: number; activities: number; errors: number }> =>
    runSweep(ctx, Math.min(limit ?? 100, 300)),
});
