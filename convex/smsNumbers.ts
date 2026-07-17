// ─────────────────────────────────────────────────────────────────────────────
// smsNumbers.ts — which 10DLC number sends to a given lead.
//
// Two rules, working together:
//   • ROTATE — brand-new leads are handed out in blocks across the number pool:
//       leads 1–100 → pool[0], leads 101–200 → pool[1], … (block size = SMS_ROTATE_EVERY).
//     Spreads first-touch volume so no single number carries everything.
//   • STICKY — once a lead is assigned a number it keeps it forever, so every
//     follow-up threads on the SAME number as the opener (one conversation, one line).
//
// The pool is CLOSE_SMS_NUMBER (comma-separated; order = rotation order). A running
// counter in system_flags (`sms_assign_counter`) drives the block rotation. Convex
// mutations are serializable, so the read-then-increment is race-safe (conflicts retry).
// ─────────────────────────────────────────────────────────────────────────────

import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { now } from './lib';

/** Sending-number pool from env (comma-separated). Order defines rotation order. */
export function smsPool(): string[] {
  return (process.env.CLOSE_SMS_NUMBER || '')
    .split(',').map((n) => n.trim()).filter(Boolean);
}

/** Leads per number before rotating to the next (default 100). */
function rotateEvery(): number {
  return Math.max(1, Number(process.env.SMS_ROTATE_EVERY || 100));
}

/** Per-number daily send cap (deliverability backpressure). */
function dailyCap(): number {
  return Number(process.env.SMS_DAILY_CAP || 40);
}

/**
 * Assign (once) and return the sticky sending number for a lead.
 *  - If the lead already has one, return it unchanged (sticky → follow-ups match the opener).
 *  - Otherwise pick the current rotation block's number, store it on the lead, bump the counter.
 * `isNew` is true only on the first assignment, so callers can mirror it to Close exactly once.
 */
export const assignSmsNumber = internalMutation({
  args: { leadId: v.id('leads') },
  returns: v.object({ number: v.union(v.string(), v.null()), isNew: v.boolean() }),
  handler: async (ctx, { leadId }): Promise<{ number: string | null; isNew: boolean }> => {
    const lead = await ctx.db.get(leadId);
    if (!lead) return { number: null, isNew: false };
    if (lead.sms_from_number) return { number: lead.sms_from_number, isNew: false }; // sticky

    const pool = smsPool();
    if (pool.length === 0) return { number: null, isNew: false };

    // Block rotation driven by a monotonic counter of leads assigned so far.
    const row = await ctx.db.query('system_flags')
      .withIndex('by_key', (q) => q.eq('key', 'sms_assign_counter')).first();
    const assigned = Number((row && row.value) || 0);
    const number = pool[Math.floor(assigned / rotateEvery()) % pool.length];
    if (row) await ctx.db.patch(row._id, { value: assigned + 1 });
    else await ctx.db.insert('system_flags', { key: 'sms_assign_counter', value: 1 });

    await ctx.db.patch(leadId, { sms_from_number: number, updated_at: now() });
    return { number, isNew: true };
  },
});

/** True if `number` has hit its per-number daily cap in the last 24h. */
export const overDailyCap = internalQuery({
  args: { number: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { number }): Promise<boolean> => {
    const since = now() - 24 * 60 * 60 * 1000;
    const sends = await ctx.db.query('sms_send_log')
      .withIndex('by_from_number', (q) => q.eq('from_number', number).gte('sent_at', since))
      .collect();
    return sends.length >= dailyCap();
  },
});
