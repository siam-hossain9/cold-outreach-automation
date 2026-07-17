// capturedLeads.ts — a lead the AI receptionist captured on a demo → text the owner.
// This is the pitch's killer moment: the business owner watches a real qualified lead
// land in their SMS from their own demo site.
import { internalMutation, internalQuery, internalAction } from './_generated/server';
import { v } from 'convex/values';
import { internal, api } from './_generated/api';
import { now, inSendWindow, msUntilSendWindow } from './lib';

export const record = internalMutation({
  args: {
    leadId: v.id('leads'),
    source: v.union(v.literal('chat'), v.literal('voice')),
    session_id: v.optional(v.string()),
    visitor_name: v.string(),
    visitor_phone: v.string(),
    service_needed: v.optional(v.string()),
    urgency: v.optional(v.string()),
    summary: v.optional(v.string()),
  },
  handler: async (ctx, a) => {
    const { leadId, ...rest } = a;
    const id = await ctx.db.insert('captured_leads', { lead_id: leadId, ...rest, captured_at: now() });
    await ctx.scheduler.runAfter(0, internal.capturedLeads.notifyOwner, { capturedId: id });
    return { id };
  },
});

export const getCaptured = internalQuery({
  args: { capturedId: v.id('captured_leads') },
  handler: async (ctx, { capturedId }) => ctx.db.get(capturedId),
});

export const markNotified = internalMutation({
  args: { capturedId: v.id('captured_leads') },
  handler: async (ctx, { capturedId }) => { await ctx.db.patch(capturedId, { notified_owner_at: now() }); },
});

/** Log the owner-notification SMS so daily caps + accounting see it. */
export const logOwnerNotification = internalMutation({
  args: { leadId: v.id('leads'), from: v.string(), to: v.string(), body: v.string(), activity_id: v.optional(v.string()) },
  handler: async (ctx, { leadId, from, to, body, activity_id }) => {
    await ctx.db.insert('sms_send_log', {
      from_number: from, to_number: to, lead_id: leadId,
      stage: 'owner_notification', body, close_activity_id: activity_id, sent_at: now(),
    });
  },
});

/** Text the business owner the captured lead's details. Fully gated (kill switch). */
export const notifyOwner = internalAction({
  args: { capturedId: v.id('captured_leads') },
  handler: async (ctx, { capturedId }): Promise<void> => {
    const cap = await ctx.runQuery(internal.capturedLeads.getCaptured, { capturedId });
    if (!cap) return;
    const bctx = await ctx.runQuery(internal.businessContexts.getByLeadId, { leadId: cap.lead_id });
    const ownerPhone = bctx?.owner_phone || '';
    if (!ownerPhone) return;
    // Kill switch — never send while paused.
    if (await ctx.runQuery(internal.systemFlags.paused, {})) return;
    // DNC — the owner phone is usually the pitched lead's own number; a STOP must stick here too.
    if (await ctx.runQuery(internal.dnc.checkPhone, { phone: ownerPhone })) return;

    const lead = await ctx.runQuery(internal.leads.getLead, { leadId: cap.lead_id });
    if (!lead) return;
    // Quiet hours — a 2am demo-visitor shouldn't trigger a 2am text to the owner; defer to morning.
    if (!inSendWindow(lead.state, now())) {
      await ctx.scheduler.runAfter(msUntilSendWindow(lead.state, now()), internal.capturedLeads.notifyOwner, { capturedId });
      return;
    }
    const body =
      `NEW LEAD from your demo site!\n\n` +
      `Name: ${cap.visitor_name}\n` +
      `Phone: ${cap.visitor_phone}\n` +
      `Needs: ${cap.service_needed || '-'}\n` +
      `Urgency: ${cap.urgency || 'routine'}\n\n` +
      `${cap.summary || ''}\n\n` +
      `Text them back within 15 min - they're expecting it.\n` +
      `(Sent by your AI receptionist - this is a demo of what runs 24/7.)`;

    const res = lead.close_lead_id
      ? { close_lead_id: lead.close_lead_id, duplicate: false }
      : await ctx.runAction(api.close.createLead, { leadId: cap.lead_id });
    if (res.duplicate || !res.close_lead_id) return; // quarantined as duplicate → never text
    const close_lead_id = res.close_lead_id;
    // Notify the owner from the same sticky number the rest of this lead's thread uses.
    const { number: from } = await ctx.runMutation(internal.smsNumbers.assignSmsNumber, { leadId: cap.lead_id });
    if (!from) return;
    if (await ctx.runQuery(internal.smsNumbers.overDailyCap, { number: from })) return; // deliverability cap
    const sms = await ctx.runAction(internal.close.sendSMS, { close_lead_id, to: ownerPhone, text: body, from });
    await ctx.runMutation(internal.capturedLeads.logOwnerNotification, {
      leadId: cap.lead_id, from: sms.from, to: sms.to, body, activity_id: sms.activity_id,
    });
    await ctx.runMutation(internal.capturedLeads.markNotified, { capturedId });
  },
});
