// callSessions.ts — Retell voice-call session tracking for the AI receptionist.
import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { now } from './lib';

export const create = internalMutation({
  args: { leadId: v.id('leads'), retellCallId: v.string() },
  handler: async (ctx, { leadId, retellCallId }) => {
    const id = await ctx.db.insert('call_sessions', {
      lead_id: leadId, retell_call_id: retellCallId, started_at: now(), captured: false,
    });
    return { id };
  },
});

export const getByRetellId = internalQuery({
  args: { retellCallId: v.string() },
  handler: async (ctx, { retellCallId }) =>
    ctx.db.query('call_sessions').withIndex('by_retell_call_id', (q) => q.eq('retell_call_id', retellCallId)).first(),
});

export const updateFromRetell = internalMutation({
  args: {
    retellCallId: v.string(),
    duration_s: v.optional(v.number()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    captured: v.optional(v.boolean()),
  },
  handler: async (ctx, { retellCallId, duration_s, transcript, summary, captured }) => {
    const cs = await ctx.db.query('call_sessions').withIndex('by_retell_call_id', (q) => q.eq('retell_call_id', retellCallId)).first();
    if (!cs) return;
    await ctx.db.patch(cs._id, {
      ended_at: now(),
      ...(duration_s != null ? { duration_s } : {}),
      ...(transcript ? { transcript } : {}),
      ...(summary ? { summary } : {}),
      ...(captured != null ? { captured } : {}),
    });
  },
});
