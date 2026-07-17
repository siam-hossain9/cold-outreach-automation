// ─────────────────────────────────────────────────────────────────────────────
// followups.ts — the tiered nudges A / B / C (adapted from WF-07).
//
//   A  (+3h from demo send) fires only if the lead has NOT clicked and NOT replied
//   B  (+1h from the click)  fires only if the lead VIEWED 30s and has NOT replied
//   C  (+48h from demo send) breakup, fires only if the lead has NOT replied
//
// These are internalActions scheduled by demos.finishDemoSend (A, C) and
// clicks.recordAndScheduleB (B). Crucially, each RE-CHECKS live state at fire time
// — reply/close status, kill switch, DNC, and the consent/channel gate — because
// any of them can change between scheduling and firing. Nothing is texted unless
// every gate still passes. All sending goes through close.ts.
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { api, internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { CF } from './close';
import {
  now, canText, canTextCold, hasRepliedOrDone, FOLLOWUP_BODIES, OPENER_BODIES,
  OPENER_DELAYS_MS, renderBody, inSendWindow, msUntilSendWindow,
} from './lib';

// O1/O2/O3 = opener-anchored (cold, no reply yet). A/B/C = demo-anchored (they replied).
type Stage = 'O1' | 'O2' | 'O3' | 'A' | 'B' | 'C';
type SendResult = { sent: boolean; reason?: string; stage?: Stage };
const isColdStage = (s: Stage): boolean => s[0] === 'O';
const BODY: Record<Stage, string> = { ...OPENER_BODIES, ...FOLLOWUP_BODIES };
const SMS_STAGE = {
  O1: 'opener_nudge_1', O2: 'opener_nudge_2', O3: 'opener_breakup',
  A: 'followup_a', B: 'followup_b', C: 'followup_c',
} as const;

/** Mark a follow-up job skipped and log why (does not send). */
async function skip(ctx: ActionCtx, leadId: Doc<'leads'>['_id'], stage: Stage, reason: string): Promise<SendResult> {
  await ctx.runMutation(internal.followups.markJob, { leadId, stage, status: 'skipped' });
  await ctx.runMutation(internal.leads.recordError, {
    workflow: `followups.send${stage}`, error: `skipped: ${reason}`, lead_id: leadId,
  });
  return { sent: false, reason };
}

/**
 * Shared send path: all the gates every follow-up honors, then the send + finalize.
 * Stage-specific preconditions (A: no click, B: has view) are checked by the caller
 * before this runs.
 */
async function attemptSend(ctx: ActionCtx, lead: Doc<'leads'>, stage: Stage): Promise<SendResult> {
  const leadId = lead._id;

  // Re-check the universal gates at fire time.
  if (hasRepliedOrDone(lead)) return skip(ctx, leadId, stage, `lead already ${lead.status}`);
  // RULE — anyone who REPLIED gets no opener nudge. hasRepliedOrDone catches 'replied'/'dnc',
  // but a hot lead who said yes progresses to 'demo_sent'/'opted_in' (not caught above), so a
  // cold opener nudge may fire ONLY while the lead is still untouched ('opener_sent'). Any
  // progression at all = they engaged = the opener sequence stops.
  if (isColdStage(stage) && lead.status !== 'opener_sent') {
    return skip(ctx, leadId, stage, `lead moved to '${lead.status}' — replied/progressed, opener nudge stopped`);
  }
  if (await ctx.runQuery(internal.systemFlags.paused, {})) return skip(ctx, leadId, stage, 'outbound_paused (kill switch)');
  if (await ctx.runQuery(internal.dnc.checkPhone, { phone: lead.phone })) return skip(ctx, leadId, stage, 'phone on DNC list');
  // Cold (opener) nudges can't require consent_at — it's only stamped once the lead
  // REPLIES (/opt-in). Using canText() here would skip 100% of them. See lib.canTextCold.
  const gate = isColdStage(stage) ? canTextCold(lead) : canText(lead);
  if (!gate.ok) return skip(ctx, leadId, stage, gate.reason);

  // RULE — a lead whose message HARD-ERRORED (landline / dead number) gets no follow-up, on
  // EVERY stage. Texting a follow-up to a number that already bounced is pointless and billed.
  if (await ctx.runQuery(internal.smsDelivery.allOutboundFailed, { leadId })) {
    return skip(ctx, leadId, stage, 'previous send hard-errored (unreachable number) — no follow-up');
  }

  // TCPA quiet hours — never text before 8am / after 9pm in the LEAD's timezone.
  // Instead of skipping, defer the same stage to when their window opens.
  if (!inSendWindow(lead.state, now())) {
    const wait = msUntilSendWindow(lead.state, now());
    const FN = {
      O1: internal.followups.sendO1, O2: internal.followups.sendO2, O3: internal.followups.sendO3,
      A: internal.followups.sendA, B: internal.followups.sendB, C: internal.followups.sendC,
    } as const;
    await ctx.scheduler.runAfter(wait, FN[stage], { leadId });
    await ctx.runMutation(internal.leads.recordError, {
      workflow: `followups.send${stage}`, error: `deferred ${Math.round(wait / 60000)}min: quiet hours (lead-local)`, lead_id: leadId,
    });
    return { sent: false, reason: 'quiet hours — rescheduled to lead-local morning' };
  }

  // Same sticky number the opener/demo used for this lead (assigned once, reused here).
  const { number: from } = await ctx.runMutation(internal.smsNumbers.assignSmsNumber, { leadId });
  if (!from) return skip(ctx, leadId, stage, 'no sending number configured');
  if (await ctx.runQuery(internal.smsNumbers.overDailyCap, { number: from })) return skip(ctx, leadId, stage, `assigned number ${from} at daily cap`);

  let close_lead_id = lead.close_lead_id || '';
  if (!close_lead_id) {
    const res = await ctx.runAction(api.close.createLead, { leadId });
    if (res.duplicate || !res.close_lead_id) return skip(ctx, leadId, stage, 'duplicate — business already in Close (not sent)');
    close_lead_id = res.close_lead_id;
  }

  const text = renderBody(BODY[stage], lead);
  const sms = await ctx.runAction(internal.close.sendSMS, {
    close_lead_id, to: lead.phone, text, from,
  });

  await ctx.runMutation(internal.followups.finishSend, {
    leadId, stage, from: sms.from, to: sms.to, text, activity_id: sms.activity_id,
  });
  await ctx.runAction(internal.close.setCustomFields, {
    leadId, increment: { [CF.MESSAGES_SENT]: 1 },
  });
  return { sent: true, stage };
}

// ─── Opener nudges — the lead got the cold opener and went quiet ─────────────
// Anchored to the opener send (see http.ts /opener-batch). Every one of them dies
// the instant the lead replies: /inbound-sms flips status to 'replied' (or 'dnc'
// on STOP), and attemptSend's hasRepliedOrDone check skips the rest of the chain.

/** Opener nudge 1 — same-day bump (+4h). */
export const sendO1 = internalAction({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }): Promise<SendResult> => {
    const lead: Doc<'leads'> | null = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return skip(ctx, leadId, 'O1', 'lead not found');
    return attemptSend(ctx, lead, 'O1');
  },
});

/** Opener nudge 2 — the real nudge (+24h). */
export const sendO2 = internalAction({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }): Promise<SendResult> => {
    const lead: Doc<'leads'> | null = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return skip(ctx, leadId, 'O2', 'lead not found');
    return attemptSend(ctx, lead, 'O2');
  },
});

/** Opener nudge 3 — the breakup (+72h). */
export const sendO3 = internalAction({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }): Promise<SendResult> => {
    const lead: Doc<'leads'> | null = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return skip(ctx, leadId, 'O3', 'lead not found');
    return attemptSend(ctx, lead, 'O3');
  },
});

/** Follow-up A — "did the link come through?" — only if no click yet. */
export const sendA = internalAction({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }): Promise<SendResult> => {
    const lead: Doc<'leads'> | null = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return skip(ctx, leadId, 'A', 'lead not found');
    const clicks = await ctx.runQuery(internal.clicks.countByLead, { leadId });
    if (clicks > 0) return skip(ctx, leadId, 'A', 'lead already clicked — A suppressed (B path)');
    return attemptSend(ctx, lead, 'A');
  },
});

/** Follow-up B — "peeped u opened it" — only if they viewed 30s. */
export const sendB = internalAction({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }): Promise<SendResult> => {
    const lead: Doc<'leads'> | null = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return skip(ctx, leadId, 'B', 'lead not found');
    const views = await ctx.runQuery(internal.view_events.countByLead, { leadId });
    if (views === 0) return skip(ctx, leadId, 'B', 'no 30s view on record — B suppressed');
    return attemptSend(ctx, lead, 'B');
  },
});

/** Follow-up C — the 48h breakup — only if still no reply. */
export const sendC = internalAction({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }): Promise<SendResult> => {
    const lead: Doc<'leads'> | null = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return skip(ctx, leadId, 'C', 'lead not found');
    return attemptSend(ctx, lead, 'C');
  },
});

// ─── DB finalizers (mutations the actions call) ──────────────────────────────

/** Log the sent follow-up + mark its job fired. */
export const finishSend = internalMutation({
  args: {
    leadId: v.id('leads'),
    stage: v.union(
      v.literal('O1'), v.literal('O2'), v.literal('O3'),
      v.literal('A'), v.literal('B'), v.literal('C'),
    ),
    from: v.string(),
    to: v.string(),
    text: v.string(),
    activity_id: v.optional(v.string()),
  },
  handler: async (ctx, { leadId, stage, from, to, text, activity_id }) => {
    const ts = now();
    await ctx.db.insert('sms_send_log', {
      from_number: from,
      to_number: to,
      lead_id: leadId,
      stage: SMS_STAGE[stage],
      body: text,
      close_activity_id: activity_id,
      sent_at: ts,
    });
    const job = await ctx.db
      .query('followup_jobs')
      .withIndex('by_lead_stage', (q) => q.eq('lead_id', leadId).eq('stage', stage))
      .first();
    if (job) await ctx.db.patch(job._id, { status: 'fired' });
    await ctx.db.patch(leadId, { updated_at: ts });
    return { ok: true };
  },
});

/**
 * Schedule the three opener nudges for a lead we just handed to n8n for the cold
 * opener. Called by /opener-batch at the moment the lead flips to 'opener_sent'.
 * Idempotent per stage — re-running never stacks a second nudge on a lead.
 */
export const scheduleOpenerNudges = internalMutation({
  args: {
    leadId: v.id('leads'),
    anchor: v.optional(v.number()),
    // Which stages to arm. Defaults to all three. Backfilling an already-opened lead
    // passes a subset — replaying a "+4h same-day bump" two days late reads as a bot.
    stages: v.optional(v.array(v.union(v.literal('O1'), v.literal('O2'), v.literal('O3')))),
  },
  returns: v.object({ scheduled: v.array(v.string()) }),
  handler: async (ctx, { leadId, anchor, stages }) => {
    const t0 = anchor ?? now();
    const FN = {
      O1: internal.followups.sendO1,
      O2: internal.followups.sendO2,
      O3: internal.followups.sendO3,
    } as const;
    const scheduled: string[] = [];
    const want = stages ?? (['O1', 'O2', 'O3'] as const);

    for (const stage of want) {
      const existing = await ctx.db
        .query('followup_jobs')
        .withIndex('by_lead_stage', (q) => q.eq('lead_id', leadId).eq('stage', stage))
        .first();
      if (existing) continue; // already queued for this lead — never double-book

      // Backfill-safe: if the anchor is in the past (re-arming an already-opened
      // lead), fire ASAP rather than in the past. runAfter clamps <=0 to immediate,
      // and attemptSend still defers it out of quiet hours.
      const fireAt = t0 + OPENER_DELAYS_MS[stage];
      const wait = Math.max(0, fireAt - now());
      const fnId = await ctx.scheduler.runAfter(wait, FN[stage], { leadId });
      await ctx.db.insert('followup_jobs', {
        lead_id: leadId, stage, scheduled_for: now() + wait,
        status: 'scheduled', scheduled_fn_id: fnId,
      });
      scheduled.push(stage);
    }
    return { scheduled };
  },
});

/** Mark a follow-up job skipped/fired without sending. */
export const markJob = internalMutation({
  args: {
    leadId: v.id('leads'),
    stage: v.union(
      v.literal('O1'), v.literal('O2'), v.literal('O3'),
      v.literal('A'), v.literal('B'), v.literal('C'),
    ),
    status: v.union(v.literal('scheduled'), v.literal('fired'), v.literal('skipped')),
  },
  handler: async (ctx, { leadId, stage, status }) => {
    const job = await ctx.db
      .query('followup_jobs')
      .withIndex('by_lead_stage', (q) => q.eq('lead_id', leadId).eq('stage', stage))
      .first();
    if (job) await ctx.db.patch(job._id, { status });
    return { ok: true };
  },
});
