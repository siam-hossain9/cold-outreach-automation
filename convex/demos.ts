// ─────────────────────────────────────────────────────────────────────────────
// demos.ts — the pre-built rebuild demo for a lead, plus the FIRST outbound text.
//
//   enqueue        generator queues a build (demos row, status 'queued')
//   setReady       build finished → demo_url + short_url, flip lead to demo_ready
//   setFailed      build failed
//   getByLeadId    latest demo for a lead (tracker / n8n)
//   sendDemoSms    (internalAction) the demo-link text — the FIRST message to a
//                  lead, so it enforces EVERY compliance gate: kill-switch, DNC,
//                  consent trail, channel gate, and the per-number daily cap.
//   finishDemoSend (internalMutation) log the send + schedule follow-ups A & C
//
// The sending number is the lead's sticky, rotating 10DLC line — see smsNumbers.ts
// (assignSmsNumber). Every text to a lead threads on that one number.
//
// Field/table names match convex/schema.ts exactly.
// ─────────────────────────────────────────────────────────────────────────────

import { mutation, query, internalQuery, internalMutation, internalAction } from './_generated/server';
import { v } from 'convex/values';
import { api, internal } from './_generated/api';
import { CF } from './close';
import {
  now, canText, hasRepliedOrDone, demoSmsBody,
  FOLLOWUP_DELAYS_MS, inSendWindow, msUntilSendWindow,
} from './lib';

/** Generator queues a demo build for a lead. */
export const enqueue = mutation({
  args: { leadId: v.id('leads'), scraped_config: v.optional(v.any()) },
  handler: async (ctx, { leadId, scraped_config }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) throw new Error(`lead ${leadId} not found`);
    const demoId = await ctx.db.insert('demos', {
      lead_id: leadId,
      demo_status: 'queued',
      scraped_config,
      created_at: now(),
    });
    return { demoId };
  },
});

/** Build finished — record the live + trackable URLs and mark the lead demo_ready. */
export const setReady = mutation({
  args: {
    demoId: v.id('demos'),
    demo_url: v.string(),
    short_url: v.string(),
    vercel_deployment_id: v.optional(v.string()),
  },
  handler: async (ctx, { demoId, demo_url, short_url, vercel_deployment_id }) => {
    const demo = await ctx.db.get(demoId);
    if (!demo) throw new Error(`demo ${demoId} not found`);
    await ctx.db.patch(demoId, {
      demo_status: 'ready', demo_url, short_url, vercel_deployment_id,
    });
    // Advance the lead — but NEVER out of a terminal state. A build takes minutes,
    // and a lead can text STOP while it runs: without this guard the finished build
    // would silently overwrite 'dnc' with 'demo_ready', resurrecting an opted-out
    // lead and feeding them to the call queue. The demo is still recorded (harmless,
    // it's just a built page); only the lead's status is left alone.
    const lead = await ctx.db.get(demo.lead_id);
    const TERMINAL = ['dnc', 'closed_won', 'closed_lost'];
    if (lead && TERMINAL.includes(lead.status)) {
      await ctx.db.insert('pipeline_errors', {
        workflow: 'demos.setReady',
        error: `lead is ${lead.status} — demo recorded but status NOT advanced (opt-out protected)`,
        lead_id: demo.lead_id, created_at: now(),
      });
      return { ok: true, lead_status_unchanged: true };
    }
    await ctx.db.patch(demo.lead_id, { status: 'demo_ready', updated_at: now() });
    return { ok: true };
  },
});

/** Build failed — record the error for the ops dashboard. */
export const setFailed = mutation({
  args: { demoId: v.id('demos'), error: v.string() },
  handler: async (ctx, { demoId, error }) => {
    await ctx.db.patch(demoId, { demo_status: 'failed', error });
    return { ok: true };
  },
});

/** Latest demo for a lead (public — tracker/beacon + n8n resolve the demo_id here). */
export const getByLeadId = query({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }) =>
    ctx.db
      .query('demos')
      .withIndex('by_lead_id', (q) => q.eq('lead_id', leadId))
      .order('desc')
      .first(),
});

/** Internal latest-demo fetch used by the send action + tracker mutations. */
export const getReadyDemo = internalQuery({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }) =>
    ctx.db
      .query('demos')
      .withIndex('by_lead_id', (q) => q.eq('lead_id', leadId))
      .order('desc')
      .first(),
});

/**
 * The demo-link SMS — sent the moment a lead replies wanting to see it.
 *
 * DO NOT gate this on hasRepliedOrDone(). In the text-first funnel a REPLY is the
 * TRIGGER for this send, not a reason to skip it: /inbound-sms flips the lead to
 * 'replied' and *then* schedules build.buildAndSend → sendDemoSms. Using the
 * follow-up guard here meant every interested lead got a demo built and NEVER got
 * the link — the whole funnel dead-ended at its most valuable moment. Only truly
 * terminal states (opted out / closed) and an already-sent demo may block it.
 */
const DEMO_BLOCKED = ['dnc', 'closed_won', 'closed_lost', 'demo_sent'];

export const sendDemoSms = internalAction({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }): Promise<{ sent: boolean; reason?: string }> => {
    const skip = async (reason: string) => {
      await ctx.runMutation(internal.leads.recordError, {
        workflow: 'demos.sendDemoSms', error: reason, lead_id: leadId,
      });
      return { sent: false, reason };
    };

    const lead = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return skip('lead not found');
    if (DEMO_BLOCKED.includes(lead.status)) return { sent: false, reason: `lead already ${lead.status}` };

    // Gate 1 — kill switch.
    if (await ctx.runQuery(internal.systemFlags.paused, {})) return skip('outbound_paused (kill switch)');
    // Gate 2 — DNC.
    if (await ctx.runQuery(internal.dnc.checkPhone, { phone: lead.phone })) return skip('phone on DNC list');
    // Gate 3 — consent + channel gate (never text AVOID / pre-consent / REVIEW).
    const gate = canText(lead);
    if (!gate.ok) return skip(gate.reason);
    // Gate 4 — TCPA quiet hours (8am–9pm lead-local): defer, don't drop.
    if (!inSendWindow(lead.state, now())) {
      const wait = msUntilSendWindow(lead.state, now());
      await ctx.scheduler.runAfter(wait, internal.demos.sendDemoSms, { leadId });
      return { sent: false, reason: `quiet hours — rescheduled in ${Math.round(wait / 60000)}min` };
    }

    // Need a ready, trackable demo to send.
    const demo = await ctx.runQuery(internal.demos.getReadyDemo, { leadId });
    if (!demo || demo.demo_status !== 'ready' || !demo.short_url) return skip('no ready demo / short_url');

    // Ensure the lead exists in Close (dedup gate may quarantine it), then resolve
    // its sticky sending number.
    let close_lead_id = lead.close_lead_id || '';
    if (!close_lead_id) {
      const res = await ctx.runAction(api.close.createLead, { leadId });
      if (res.duplicate || !res.close_lead_id) return skip('duplicate — business already in Close (not sent)');
      close_lead_id = res.close_lead_id;
    }
    const { number: from, isNew } = await ctx.runMutation(internal.smsNumbers.assignSmsNumber, { leadId });
    if (!from) return skip('no sending number configured (CLOSE_SMS_NUMBER empty)');
    if (await ctx.runQuery(internal.smsNumbers.overDailyCap, { number: from })) return skip(`assigned number ${from} at daily cap — deferring`);
    // Mirror a freshly-assigned number onto the Close lead (informational, once).
    if (isNew) await ctx.runAction(internal.close.setCustomFields, { leadId, set: { [CF.SMS_NUMBER]: from } });

    const text = demoSmsBody(lead.name, demo.short_url);
    const sms = await ctx.runAction(internal.close.sendSMS, {
      close_lead_id, to: lead.phone, text, from,
    });

    // Log + advance state + schedule follow-ups (A at +3h, C at +48h).
    await ctx.runMutation(internal.demos.finishDemoSend, {
      leadId, demoId: demo._id, from: sms.from, to: sms.to,
      text, activity_id: sms.activity_id,
    });
    // Bump the Close "messages sent" counter (best-effort).
    await ctx.runAction(internal.close.setCustomFields, {
      leadId, increment: { [CF.MESSAGES_SENT]: 1 },
    });

    return { sent: true };
  },
});

/**
 * Finalize a demo send: write sms_send_log, stamp demo.sent_at, move the lead to
 * demo_sent, and schedule the send-anchored follow-ups (A + C). Click-anchored
 * follow-up B is scheduled separately by clicks.recordAndScheduleB.
 */
export const finishDemoSend = internalMutation({
  args: {
    leadId: v.id('leads'),
    demoId: v.id('demos'),
    from: v.string(),
    to: v.string(),
    text: v.string(),
    activity_id: v.optional(v.string()),
  },
  handler: async (ctx, { leadId, demoId, from, to, text, activity_id }) => {
    const ts = now();
    await ctx.db.insert('sms_send_log', {
      from_number: from,
      to_number: to,
      lead_id: leadId,
      stage: 'demo_send',
      body: text,
      close_activity_id: activity_id,
      sent_at: ts,
    });
    await ctx.db.patch(demoId, { sent_at: ts });
    await ctx.db.patch(leadId, { status: 'demo_sent', updated_at: ts });

    // Schedule follow-ups A and C once (guard against a double send re-scheduling).
    const existingA = await ctx.db
      .query('followup_jobs')
      .withIndex('by_lead_stage', (q) => q.eq('lead_id', leadId).eq('stage', 'A'))
      .first();
    if (!existingA) {
      const fnA = await ctx.scheduler.runAfter(FOLLOWUP_DELAYS_MS.A, internal.followups.sendA, { leadId });
      await ctx.db.insert('followup_jobs', {
        lead_id: leadId, stage: 'A', scheduled_for: ts + FOLLOWUP_DELAYS_MS.A,
        status: 'scheduled', scheduled_fn_id: fnA,
      });
      const fnC = await ctx.scheduler.runAfter(FOLLOWUP_DELAYS_MS.C, internal.followups.sendC, { leadId });
      await ctx.db.insert('followup_jobs', {
        lead_id: leadId, stage: 'C', scheduled_for: ts + FOLLOWUP_DELAYS_MS.C,
        status: 'scheduled', scheduled_fn_id: fnC,
      });
    }
    return { ok: true };
  },
});
