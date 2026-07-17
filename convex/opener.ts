// ─────────────────────────────────────────────────────────────────────────────
// opener.ts — CLOUD-NATIVE cold opener (Touch 1). Replaces n8n WF-UW-02.
//
//   openerBatch  (cron, daily weekday morning) — pull up to N new TEXT leads,
//                mark them opener_sent, and stagger a sendOpener for each.
//   sendOpener   — send the Touch-1 opener to one lead through the full gate
//                stack, then arm the Day-2/5/7 nudges (O1/O2/O3).
//
// Every gate the demo/follow-up sends honor is honored here too — with one extra:
// TCPA quiet hours are enforced on the OPENER (n8n's version had none), so a cold
// text never lands before 8am / after 9pm in the lead's own timezone.
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { api, internal } from './_generated/api';
import { CF } from './close';
import { now, canTextCold, inSendWindow, msUntilSendWindow, renderBody, OPENER_TOUCH1 } from './lib';

// The opener may ONLY target a lead still in the cold-opener phase. Anything that
// has progressed (demo_ready/opted_in/…) or ended (dnc/replied/…) is never texted it.
const OPENER_OK = ['new', 'opener_sent'];

/**
 * Send the cold opener to ONE lead, then arm the nudges. Re-checks every gate at
 * fire time; defers (not drops) out-of-window sends to the lead's local morning.
 */
export const sendOpener = internalAction({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }): Promise<{ sent: boolean; reason?: string }> => {
    const skip = async (reason: string) => {
      await ctx.runMutation(internal.leads.recordError, { workflow: 'opener.sendOpener', error: reason, lead_id: leadId });
      return { sent: false, reason };
    };
    const lead = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return skip('lead not found');
    if (!OPENER_OK.includes(lead.status)) return { sent: false, reason: `lead is ${lead.status} — not an opener target` };

    // Gate 1 — kill switch.
    if (await ctx.runQuery(internal.systemFlags.paused, {})) return skip('outbound_paused (kill switch)');
    // Gate 2 — DNC.
    if (await ctx.runQuery(internal.dnc.checkPhone, { phone: lead.phone })) return skip('phone on DNC list');
    // Gate 3 — channel/state gate (cold: no consent_at required).
    const gate = canTextCold(lead);
    if (!gate.ok) return skip(gate.reason);
    // Gate 4 — TCPA quiet hours (8am–9pm lead-local): defer, don't drop.
    if (!inSendWindow(lead.state, now())) {
      const wait = msUntilSendWindow(lead.state, now());
      await ctx.scheduler.runAfter(wait, internal.opener.sendOpener, { leadId });
      return { sent: false, reason: `quiet hours — deferred ${Math.round(wait / 60000)}min` };
    }

    // Ensure the lead exists in Close (dedup gate may quarantine it).
    let close_lead_id = lead.close_lead_id || '';
    if (!close_lead_id) {
      let res;
      try { res = await ctx.runAction(api.close.createLead, { leadId }); }
      catch (_) { return skip('could not reach Close — will retry next batch'); }
      if (res.duplicate || !res.close_lead_id) return skip('duplicate — business already in Close (not texted)');
      close_lead_id = res.close_lead_id;
    }

    // Sticky rotating number + per-number daily cap.
    const { number: from, isNew } = await ctx.runMutation(internal.smsNumbers.assignSmsNumber, { leadId });
    if (!from) return skip('no sending number configured (CLOSE_SMS_NUMBER empty)');
    if (await ctx.runQuery(internal.smsNumbers.overDailyCap, { number: from })) {
      // Defer to this lead's next morning window rather than drop.
      const wait = Math.max(msUntilSendWindow(lead.state, now()), 60 * 60 * 1000);
      await ctx.scheduler.runAfter(wait, internal.opener.sendOpener, { leadId });
      return { sent: false, reason: `number ${from} at daily cap — deferred` };
    }
    if (isNew) { try { await ctx.runAction(internal.close.setCustomFields, { leadId, set: { [CF.SMS_NUMBER]: from } }); } catch (_) {} }

    // Send the opener.
    const text = renderBody(OPENER_TOUCH1, lead);
    const sms = await ctx.runAction(internal.close.sendSMS, { close_lead_id, to: lead.phone, text, from });

    // Log + confirm status + arm the Day-2/5/7 nudges anchored to this send.
    await ctx.runMutation(internal.opener.finishOpener, { leadId, from: sms.from, to: sms.to, text, activity_id: sms.activity_id });
    await ctx.runMutation(internal.followups.scheduleOpenerNudges, { leadId });
    try { await ctx.runAction(internal.close.setCustomFields, { leadId, increment: { [CF.MESSAGES_SENT]: 1 } }); } catch (_) {}
    return { sent: true };
  },
});

/** Log the opener + ensure status = opener_sent (idempotent). */
export const finishOpener = internalMutation({
  args: { leadId: v.id('leads'), from: v.string(), to: v.string(), text: v.string(), activity_id: v.optional(v.string()) },
  handler: async (ctx, { leadId, from, to, text, activity_id }) => {
    await ctx.db.insert('sms_send_log', {
      from_number: from, to_number: to, lead_id: leadId,
      stage: 'opener', body: text, close_activity_id: activity_id, sent_at: now(),
    });
    const lead = await ctx.db.get(leadId);
    if (lead && OPENER_OK.includes(lead.status)) await ctx.db.patch(leadId, { status: 'opener_sent', updated_at: now() });
    else if (lead) await ctx.db.patch(leadId, { updated_at: now() });
    return { ok: true };
  },
});

/**
 * Daily batch: pull up to `limit` new, textable leads, mark each opener_sent so
 * the next run won't re-pick them, and stagger a sendOpener ~35–70s apart (human
 * pace, not a burst). Each sendOpener still re-checks every gate at fire time.
 */
export const openerBatch = internalAction({
  args: { limit: v.optional(v.number()) },
  returns: v.object({ started: v.number(), paused: v.optional(v.boolean()) }),
  handler: async (ctx, { limit }): Promise<{ started: number; paused?: boolean }> => {
    if (await ctx.runQuery(internal.systemFlags.paused, {})) return { started: 0, paused: true };
    const n = Math.min(limit ?? 40, 300);
    const candidates = await ctx.runQuery(api.leads.openerCandidates, { limit: n });
    let i = 0;
    for (const lead of candidates) {
      // Reserve the lead (won't be re-picked next run) then schedule the staggered send.
      await ctx.runMutation(api.leads.setStatus, { leadId: lead._id, status: 'opener_sent' });
      const delay = i * (10_000 + (i % 4) * 2_000); // ~10–16s apart, deterministic
      await ctx.scheduler.runAfter(delay, internal.opener.sendOpener, { leadId: lead._id });
      i++;
    }
    return { started: i };
  },
});

/**
 * Re-pace the in-flight openers: cancel the pending (not-yet-fired) sendOpener jobs
 * and re-fire the still-untexted opener_sent leads at a tighter spacing. Safe against
 * double-sends: only leads with NO assigned number AND no logged opener are re-queued
 * (a lead that already sent has both), and in-progress sends aren't cancelled.
 */
export const respaceOpeners = internalMutation({
  args: { spacingMs: v.optional(v.number()) },
  returns: v.object({ canceled: v.number(), rescheduled: v.number() }),
  handler: async (ctx, { spacingMs }) => {
    const gap = Math.max(3_000, spacingMs ?? 10_000);
    // 1. Cancel pending sendOpener jobs (leave in-progress + the O1/O2/O3 nudges alone).
    const scheduled = await ctx.db.system.query('_scheduled_functions').collect();
    let canceled = 0;
    for (const s of scheduled) {
      if (s.state.kind === 'pending' && /sendOpener/.test(s.name)) { await ctx.scheduler.cancel(s._id); canceled++; }
    }
    // 2. Untexted queued leads = opener_sent, no number assigned yet, no opener logged.
    const sentLeads = new Set<string>();
    for (const m of await ctx.db.query('sms_send_log').collect()) if (m.stage === 'opener') sentLeads.add(String(m.lead_id));
    const queued = (await ctx.db.query('leads').withIndex('by_status', (q) => q.eq('status', 'opener_sent')).collect())
      .filter((l) => !l.sms_from_number && !sentLeads.has(String(l._id)));
    // 3. Re-fire at the tighter cadence.
    let i = 0;
    for (const l of queued) { await ctx.scheduler.runAfter(i * gap, internal.opener.sendOpener, { leadId: l._id }); i++; }
    return { canceled, rescheduled: i };
  },
});
