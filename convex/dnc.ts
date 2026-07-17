// ─────────────────────────────────────────────────────────────────────────────
// dnc.ts — the Do-Not-Contact list. Checked before EVERY outbound contact.
//
// Phones are stored normalized (last 10 digits) so a match works regardless of
// how the number was formatted at the source. `add` is idempotent.
// ─────────────────────────────────────────────────────────────────────────────

import { mutation, query, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { now, normalizePhone } from './lib';

/** Add a phone to the DNC list (idempotent by normalized number). */
export const add = mutation({
  args: { phone: v.string(), reason: v.string() },
  handler: async (ctx, { phone, reason }) => {
    const key = normalizePhone(phone);
    if (!key) throw new Error('cannot add empty phone to DNC');
    const existing = await ctx.db
      .query('dnc_list')
      .withIndex('by_phone', (q) => q.eq('phone', key))
      .first();
    if (existing) return { added: false, phone: key };
    await ctx.db.insert('dnc_list', { phone: key, reason, added_at: now() });
    return { added: true, phone: key };
  },
});

/** Public DNC check (admin / n8n). True if the number is suppressed. */
export const check = query({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const key = normalizePhone(phone);
    if (!key) return false;
    const hit = await ctx.db
      .query('dnc_list')
      .withIndex('by_phone', (q) => q.eq('phone', key))
      .first();
    return !!hit;
  },
});

/** Internal DNC check used by the send actions at fire time. */
export const checkPhone = internalQuery({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const key = normalizePhone(phone);
    if (!key) return false;
    const hit = await ctx.db
      .query('dnc_list')
      .withIndex('by_phone', (q) => q.eq('phone', key))
      .first();
    return !!hit;
  },
});
