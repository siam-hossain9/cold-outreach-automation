// ─────────────────────────────────────────────────────────────────────────────
// systemFlags.ts — key/value flags, chiefly the `outbound_paused` kill switch.
//
// Every outbound send (demo SMS + follow-ups) re-reads `outbound_paused` at fire
// time, so flipping it in the admin panel halts all in-flight sends within one
// scheduler tick. Reads default to FALSE (not-paused) when the flag row is absent.
// ─────────────────────────────────────────────────────────────────────────────

import { mutation, query, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { now } from './lib';

const OUTBOUND_PAUSED = 'outbound_paused';

/** Generic flag read. Returns the stored value, or `defaultValue` if unset. */
export const get = query({
  args: { key: v.string(), defaultValue: v.optional(v.any()) },
  handler: async (ctx, { key, defaultValue }) => {
    const row = await ctx.db
      .query('system_flags')
      .withIndex('by_key', (q) => q.eq('key', key))
      .first();
    return row ? row.value : (defaultValue ?? null);
  },
});

/** Generic flag write (upsert by key). Admin panel + n8n toggle through here. */
export const set = mutation({
  args: { key: v.string(), value: v.any() },
  handler: async (ctx, { key, value }) => {
    const row = await ctx.db
      .query('system_flags')
      .withIndex('by_key', (q) => q.eq('key', key))
      .first();
    if (row) {
      await ctx.db.patch(row._id, { value });
    } else {
      await ctx.db.insert('system_flags', { key, value });
    }
    return { key, value };
  },
});

/** Convenience: the kill switch as a boolean (admin UI reads this). */
export const isOutboundPaused = query({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query('system_flags')
      .withIndex('by_key', (q) => q.eq('key', OUTBOUND_PAUSED))
      .first();
    return row ? row.value === true : false;
  },
});

/** Internal boolean read used by the send actions before every send. */
export const paused = internalQuery({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query('system_flags')
      .withIndex('by_key', (q) => q.eq('key', OUTBOUND_PAUSED))
      .first();
    return row ? row.value === true : false;
  },
});

/** Explicit setters for the admin kill switch (thin wrappers over `set`). */
export const pauseOutbound = mutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query('system_flags')
      .withIndex('by_key', (q) => q.eq('key', OUTBOUND_PAUSED))
      .first();
    if (row) await ctx.db.patch(row._id, { value: true });
    else await ctx.db.insert('system_flags', { key: OUTBOUND_PAUSED, value: true });
    return { outbound_paused: true, at: now() };
  },
});

export const resumeOutbound = mutation({
  args: {},
  handler: async (ctx) => {
    const row = await ctx.db
      .query('system_flags')
      .withIndex('by_key', (q) => q.eq('key', OUTBOUND_PAUSED))
      .first();
    if (row) await ctx.db.patch(row._id, { value: false });
    else await ctx.db.insert('system_flags', { key: OUTBOUND_PAUSED, value: false });
    return { outbound_paused: false, at: now() };
  },
});
