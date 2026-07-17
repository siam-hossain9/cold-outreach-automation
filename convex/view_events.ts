// ─────────────────────────────────────────────────────────────────────────────
// view_events.ts — the 30-second "actually looked at it" beacon.
//
// Every niche template embeds a script that POSTs to the tracker after 30s on the
// demo page; the tracker relays it here. A view event is the gate for follow-up B
// ("peeped u opened it 👀"), so sendB checks countByLead before firing.
// ─────────────────────────────────────────────────────────────────────────────

import { mutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { now } from './lib';

export const record = mutation({
  args: {
    leadId: v.id('leads'),
    duration_ms: v.number(),
    demoId: v.optional(v.id('demos')),
  },
  returns: v.object({ recorded: v.boolean() }),
  handler: async (ctx, { leadId, duration_ms, demoId }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) {
      await ctx.db.insert('pipeline_errors', {
        workflow: 'view_events.record', error: 'lead not found', created_at: now(),
      });
      return { recorded: false };
    }

    // Resolve the demo (view_events.demo_id is required). Fall back to the latest.
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
        workflow: 'view_events.record', error: 'no demo for lead',
        lead_id: leadId, created_at: now(),
      });
      return { recorded: false };
    }

    await ctx.db.insert('view_events', {
      lead_id: leadId, demo_id: demo._id, duration_ms, viewed_at: now(),
    });
    return { recorded: true };
  },
});

/** Whether a lead has a 30s view on record — follow-up B's precondition. */
export const countByLead = internalQuery({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }) => {
    const rows = await ctx.db
      .query('view_events')
      .withIndex('by_lead_id', (q) => q.eq('lead_id', leadId))
      .collect();
    return rows.length;
  },
});
