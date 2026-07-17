// ─────────────────────────────────────────────────────────────────────────────
// clicks.ts — demo-link click tracking (the /r/{leadId} short link).
//
//   recordAndScheduleB  (mutation) log the click and, on the FIRST click only,
//                        schedule follow-up B for +1h; also nudges Close.
//   markClicked         (action) bump the Close "clicks" counter.
//   countByLead         (internalQuery) used by follow-up A's "no click" guard.
//
// Idempotency: only the first click schedules B (per WF-06 spec) — a lead
// reopening the link many times must not stack duplicate follow-ups.
// ─────────────────────────────────────────────────────────────────────────────

import { mutation, internalAction, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { CF } from './close';
import { now, FOLLOWUP_DELAYS_MS } from './lib';

export const recordAndScheduleB = mutation({
  args: {
    leadId: v.id('leads'),
    user_agent: v.string(),
    ip_country: v.optional(v.string()),
    demoId: v.optional(v.id('demos')),
  },
  returns: v.object({
    recorded: v.boolean(),
    demo_url: v.optional(v.string()),
    scheduledB: v.boolean(),
  }),
  handler: async (ctx, { leadId, user_agent, ip_country, demoId }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) {
      await ctx.db.insert('pipeline_errors', {
        workflow: 'clicks.recordAndScheduleB', error: 'lead not found', created_at: now(),
      });
      return { recorded: false, demo_url: undefined, scheduledB: false };
    }

    // Resolve the demo (clicks.demo_id is required). Fall back to the latest demo.
    let demo = demoId ? await ctx.db.get(demoId) : null;
    if (!demo) {
      demo = await ctx.db
        .query('demos')
        .withIndex('by_lead_id', (q) => q.eq('lead_id', leadId))
        .order('desc')
        .first();
    }
    if (!demo) {
      await ctx.db.insert('pipeline_errors', {
        workflow: 'clicks.recordAndScheduleB', error: 'no demo for lead',
        lead_id: leadId, created_at: now(),
      });
      return { recorded: false, demo_url: undefined, scheduledB: false };
    }

    // First click? (before inserting this one)
    const priorClicks = await ctx.db
      .query('clicks')
      .withIndex('by_lead_id', (q) => q.eq('lead_id', leadId))
      .take(1);
    const isFirstClick = priorClicks.length === 0;

    const ts = now();
    await ctx.db.insert('clicks', {
      lead_id: leadId, demo_id: demo._id, user_agent, ip_country, clicked_at: ts,
    });

    // Bump the Close clicks counter on every click, and on the FIRST click also tick
    // the "Website Demo - Clicked" flag (best-effort, async).
    await ctx.scheduler.runAfter(0, internal.clicks.markClicked, { leadId, first: isFirstClick });

    // Schedule follow-up B once, +1h from this first click (if not already scheduled).
    let scheduledB = false;
    if (isFirstClick) {
      const existingB = await ctx.db
        .query('followup_jobs')
        .withIndex('by_lead_stage', (q) => q.eq('lead_id', leadId).eq('stage', 'B'))
        .first();
      if (!existingB) {
        const fnB = await ctx.scheduler.runAfter(FOLLOWUP_DELAYS_MS.B, internal.followups.sendB, { leadId });
        await ctx.db.insert('followup_jobs', {
          lead_id: leadId, stage: 'B', scheduled_for: ts + FOLLOWUP_DELAYS_MS.B,
          status: 'scheduled', scheduled_fn_id: fnB,
        });
        scheduledB = true;
      }
    }

    return { recorded: true, demo_url: demo.demo_url, scheduledB };
  },
});

/**
 * Increment the Close "clicks" counter, and on the first click flip
 * "Website Demo - Clicked" → Yes so the flag is visible in Close + smart views.
 */
export const markClicked = internalAction({
  args: { leadId: v.id('leads'), first: v.optional(v.boolean()) },
  handler: async (ctx, { leadId, first }) => {
    await ctx.runAction(internal.close.setCustomFields, {
      leadId,
      increment: { [CF.CLICKS]: 1 },
      ...(first ? { set: { [CF.DEMO_CLICKED]: 'Yes' } } : {}),
    });
    return { ok: true };
  },
});

/** How many times a lead has clicked — follow-up A only fires when this is 0. */
export const countByLead = internalQuery({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }) => {
    const rows = await ctx.db
      .query('clicks')
      .withIndex('by_lead_id', (q) => q.eq('lead_id', leadId))
      .collect();
    return rows.length;
  },
});
