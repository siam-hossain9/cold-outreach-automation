// businessContexts.ts — prompt-ready business info for the AI receptionist widgets.
// Built by the generator at demo time (the "WF-08" step), looked up by the /chat +
// /voice endpoints on every request.
import { mutation, internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { now } from './lib';

const fields = {
  business_name: v.string(),
  niche: v.string(),
  phone: v.string(),
  city: v.string(),
  services: v.array(v.string()),
  service_area: v.optional(v.string()),
  hours: v.optional(v.string()),
  agent_name: v.string(),
  system_prompt: v.string(),
  retell_dynamic_vars: v.optional(v.any()),
  owner_phone: v.string(),
};

/** Generator upserts the business context after a demo is built (idempotent per lead). */
export const upsert = mutation({
  args: { leadId: v.id('leads'), ...fields },
  handler: async (ctx, a) => {
    const { leadId, ...rest } = a;
    const existing = await ctx.db
      .query('business_contexts')
      .withIndex('by_lead_id', (q) => q.eq('lead_id', leadId))
      .first();
    if (existing) { await ctx.db.patch(existing._id, rest); return { id: existing._id, updated: true }; }
    const id = await ctx.db.insert('business_contexts', { lead_id: leadId, ...rest, created_at: now() });
    return { id, updated: false };
  },
});

export const getByLeadId = internalQuery({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }) =>
    ctx.db.query('business_contexts').withIndex('by_lead_id', (q) => q.eq('lead_id', leadId)).first(),
});

/** Blank/override the owner-notify phone (e.g. make a public showcase demo safe). */
export const setOwnerPhone = internalMutation({
  args: { leadId: v.id('leads'), owner_phone: v.string() },
  handler: async (ctx, { leadId, owner_phone }) => {
    const r = await ctx.db.query('business_contexts').withIndex('by_lead_id', (q) => q.eq('lead_id', leadId)).first();
    if (r) await ctx.db.patch(r._id, { owner_phone });
    return { ok: !!r };
  },
});
