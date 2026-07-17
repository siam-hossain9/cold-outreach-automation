// ─────────────────────────────────────────────────────────────────────────────
// callQueue.ts — the CALL-FIRST manual-dial queue. A human pulls the next lead,
// dials, and works the outreach/call-script to earn a verbal "text me the demo".
//
//   enqueue        add a lead to the queue (priority = rank_score, lower = first)
//   next           reserve the highest-priority waiting lead for a caller
//   listWaiting    peek the queue (admin / n8n WF-R1)
//   recordOutcome  log the call result; on 'opted_in' flip the lead + auto-send
//                  the demo; on 'dnc' suppress the number
//   autoEnqueueReady / reapStale   cron helpers (see crons.ts)
//
// Priority = rank_score from the scraper (vision-based visual-age; LOWER = worse-
// looking = pitch first). Leads with no rank_score sink to the bottom (999).
// ─────────────────────────────────────────────────────────────────────────────

import { mutation, query, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { now, normalizePhone } from './lib';

/** How long a reserved (in_progress) call may sit before it's requeued. */
const STALE_RESERVE_MS = 30 * 60 * 1000;

const outcomeValidator = v.union(
  v.literal('opted_in'),
  v.literal('not_interested'),
  v.literal('no_answer'),
  v.literal('callback'),
  v.literal('dnc'),
);

/** Add a lead to the call queue (idempotent while a live entry exists). */
export const enqueue = mutation({
  args: { leadId: v.id('leads'), priority: v.optional(v.number()) },
  handler: async (ctx, { leadId, priority }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) throw new Error(`lead ${leadId} not found`);
    if (lead.status === 'dnc') return { enqueued: false, reason: 'lead is DNC' };

    // Don't double-queue a lead that already has a live entry.
    const live = await ctx.db
      .query('call_queue')
      .filter((q) => q.eq(q.field('lead_id'), leadId))
      .collect();
    if (live.some((r) => r.state === 'waiting' || r.state === 'in_progress')) {
      return { enqueued: false, reason: 'already queued' };
    }

    const pr = priority ?? lead.rank_score ?? 999; // lower rank_score = higher priority
    const queueId = await ctx.db.insert('call_queue', {
      lead_id: leadId, priority: pr, state: 'waiting', created_at: now(),
    });
    // Reflect queue membership on the lead (only from pre-call statuses).
    if (lead.status === 'new' || lead.status === 'demo_ready') {
      await ctx.db.patch(leadId, { status: 'queued_call', updated_at: now() });
    }
    return { enqueued: true, queueId, priority: pr };
  },
});

/** Reserve the next highest-priority waiting lead for a caller. */
export const next = mutation({
  args: { assigned_to: v.optional(v.string()) },
  handler: async (ctx, { assigned_to }) => {
    const item = await ctx.db
      .query('call_queue')
      .withIndex('by_state_priority', (q) => q.eq('state', 'waiting'))
      .order('asc') // lowest priority number first
      .first();
    if (!item) return null;

    const ts = now();
    await ctx.db.patch(item._id, { state: 'in_progress', assigned_to, called_at: ts });
    const lead = await ctx.db.get(item.lead_id);
    return { queueId: item._id, priority: item.priority, lead };
  },
});

/** Peek the waiting queue without reserving (admin dashboard / WF-R1). */
export const listWaiting = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const items = await ctx.db
      .query('call_queue')
      .withIndex('by_state_priority', (q) => q.eq('state', 'waiting'))
      .order('asc')
      .take(limit ?? 50);
    // Join minimal lead context for the dialer UI.
    const out: Array<Record<string, unknown>> = [];
    for (const it of items) {
      const lead = await ctx.db.get(it.lead_id);
      out.push({
        queueId: it._id,
        priority: it.priority,
        lead_id: it.lead_id,
        name: lead?.name,
        phone: lead?.phone,
        niche: lead?.niche,
        city: lead?.city,
        state: lead?.state,
        channel: lead?.channel,
        ugly_reasons: lead?.ugly_reasons,
        vision_reasons: lead?.vision_reasons,
      });
    }
    return out;
  },
});

/**
 * Record a call outcome and drive the lead's next step.
 *   opted_in       → stamp consent + status 'opted_in' + auto-send the demo SMS
 *   not_interested → status 'closed_lost'
 *   no_answer      → requeue (state back to 'waiting') for a redial
 *   callback       → requeue for a redial
 *   dnc            → suppress the number + status 'dnc' + flag Close
 */
export const recordOutcome = mutation({
  args: {
    queueId: v.id('call_queue'),
    outcome: outcomeValidator,
    assigned_to: v.optional(v.string()),
  },
  handler: async (ctx, { queueId, outcome, assigned_to }) => {
    const item = await ctx.db.get(queueId);
    if (!item) throw new Error(`call_queue ${queueId} not found`);
    const lead = await ctx.db.get(item.lead_id);
    if (!lead) throw new Error(`lead ${item.lead_id} not found`);
    const ts = now();
    const leadId = item.lead_id;

    switch (outcome) {
      case 'opted_in': {
        await ctx.db.patch(queueId, { state: 'done', outcome, assigned_to, called_at: ts });
        // Consent trail: keep earliest consent if somehow already set.
        await ctx.db.patch(leadId, {
          status: 'opted_in',
          consent_at: lead.consent_at ?? ts,
          updated_at: ts,
        });
        // If the rebuild is already live, send the demo now (else the generator/
        // WF-R2 will trigger sendDemoSms once setReady runs).
        const demo = await ctx.db
          .query('demos')
          .withIndex('by_lead_id', (q) => q.eq('lead_id', leadId))
          .order('desc')
          .first();
        if (demo && demo.demo_status === 'ready' && demo.short_url) {
          await ctx.scheduler.runAfter(0, internal.demos.sendDemoSms, { leadId });
        }
        break;
      }
      case 'not_interested': {
        await ctx.db.patch(queueId, { state: 'done', outcome, assigned_to, called_at: ts });
        await ctx.db.patch(leadId, { status: 'closed_lost', updated_at: ts });
        break;
      }
      case 'no_answer':
      case 'callback': {
        // Leave the lead in the queue for another attempt.
        await ctx.db.patch(queueId, { state: 'waiting', outcome, assigned_to, called_at: ts });
        break;
      }
      case 'dnc': {
        await ctx.db.patch(queueId, { state: 'done', outcome, assigned_to, called_at: ts });
        await ctx.db.patch(leadId, { status: 'dnc', updated_at: ts });
        const key = normalizePhone(lead.phone);
        if (key) {
          const existing = await ctx.db
            .query('dnc_list')
            .withIndex('by_phone', (q) => q.eq('phone', key))
            .first();
          if (!existing) {
            await ctx.db.insert('dnc_list', { phone: key, reason: 'call: do-not-contact', added_at: ts });
          }
        }
        await ctx.scheduler.runAfter(0, internal.close.markDoNotContact, { leadId });
        break;
      }
    }
    return { ok: true, outcome };
  },
});

// ─── Cron helpers ─────────────────────────────────────────────────────────────

/** Auto-queue leads whose rebuild is ready but that aren't queued yet. */
export const autoEnqueueReady = internalMutation({
  args: {},
  handler: async (ctx) => {
    const ready = await ctx.db
      .query('leads')
      .withIndex('by_status', (q) => q.eq('status', 'demo_ready'))
      .take(50);
    let enqueued = 0;
    for (const lead of ready) {
      const live = await ctx.db
        .query('call_queue')
        .filter((q) => q.eq(q.field('lead_id'), lead._id))
        .collect();
      if (live.some((r) => r.state === 'waiting' || r.state === 'in_progress')) continue;
      await ctx.db.insert('call_queue', {
        lead_id: lead._id, priority: lead.rank_score ?? 999, state: 'waiting', created_at: now(),
      });
      await ctx.db.patch(lead._id, { status: 'queued_call', updated_at: now() });
      enqueued++;
    }
    return { enqueued };
  },
});

/** Requeue calls reserved (in_progress) but never resolved — a caller dropped off. */
export const reapStale = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = now() - STALE_RESERVE_MS;
    const stuck = await ctx.db
      .query('call_queue')
      .withIndex('by_state_priority', (q) => q.eq('state', 'in_progress'))
      .collect();
    let requeued = 0;
    for (const it of stuck) {
      if ((it.called_at ?? 0) < cutoff) {
        await ctx.db.patch(it._id, { state: 'waiting', assigned_to: undefined });
        requeued++;
      }
    }
    return { requeued };
  },
});
