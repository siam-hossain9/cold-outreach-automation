// ─────────────────────────────────────────────────────────────────────────────
// reviewWebsite.ts — the "review website" database: leads whose site is already
// modern/decent, so they're NOT a fit for the ugly-rebuild funnel. Instead of
// dropping them, we park them here (the scraper's -REVIEW.csv feeds this).
//
//   batchInsert  bulk-import review leads (dedupe by place_id)
//   list         list them (newest first)
//   count        how many are parked
//   markReviewed flip a lead's reviewed flag
// ─────────────────────────────────────────────────────────────────────────────

import { mutation, query } from './_generated/server';
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { now, coerceNumber } from './lib';

const reviewLead = v.object({
  place_id: v.string(),
  name: v.string(),
  phone: v.optional(v.string()),
  website: v.optional(v.string()),
  niche: v.optional(v.string()),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  zip: v.optional(v.string()),
  address: v.optional(v.string()),
  maps_url: v.optional(v.string()),
  rating: v.optional(v.union(v.number(), v.string())),
  reviews: v.optional(v.union(v.number(), v.string())),
  ugly_score: v.optional(v.union(v.number(), v.string())),
  ugly_reasons: v.optional(v.string()),
  vision_verdict: v.optional(v.string()),
  vision_era: v.optional(v.string()),
  vision_reasons: v.optional(v.string()),
  channel: v.optional(v.string()),
  scrape_batch: v.optional(v.string()),
});

/** Bulk-import modern/decent-site leads. Dedupes by place_id (DB + within batch). */
export const batchInsert = mutation({
  args: { leads: v.array(reviewLead) },
  returns: v.object({ inserted: v.number(), skipped: v.number() }),
  handler: async (ctx, { leads }) => {
    const seen = new Set<string>();
    let inserted = 0, skipped = 0;
    const ts = now();
    for (const row of leads) {
      const place_id = String(row.place_id || '').trim();
      if (!place_id || seen.has(place_id)) { skipped++; continue; }
      seen.add(place_id);
      const existing = await ctx.db.query('review_website').withIndex('by_place_id', (q) => q.eq('place_id', place_id)).first();
      if (existing) { skipped++; continue; }
      await ctx.db.insert('review_website', {
        place_id,
        name: row.name || '',
        phone: row.phone || '',
        website: row.website || '',
        niche: String(row.niche || '').toLowerCase(),
        city: row.city || '',
        state: String(row.state || '').toUpperCase().trim(),
        zip: row.zip || undefined,
        address: row.address || undefined,
        maps_url: row.maps_url || undefined,
        rating: coerceNumber(row.rating),
        reviews: coerceNumber(row.reviews),
        ugly_score: coerceNumber(row.ugly_score),
        ugly_reasons: row.ugly_reasons || undefined,
        vision_verdict: row.vision_verdict || undefined,
        vision_era: row.vision_era || undefined,
        vision_reasons: row.vision_reasons || undefined,
        channel: row.channel || undefined,
        scrape_batch: row.scrape_batch || undefined,
        reviewed: false,
        created_at: ts,
      });
      inserted++;
    }
    return { inserted, skipped };
  },
});

/** List parked review-website leads (newest first, capped). */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }): Promise<Array<Doc<'review_website'>>> =>
    ctx.db.query('review_website').order('desc').take(limit ?? 100),
});

/** How many modern leads are parked. */
export const count = query({
  args: {},
  handler: async (ctx): Promise<number> => (await ctx.db.query('review_website').collect()).length,
});

/** Flag a review lead as triaged. */
export const markReviewed = mutation({
  args: { id: v.id('review_website') },
  handler: async (ctx, { id }) => { await ctx.db.patch(id, { reviewed: true }); return { ok: true }; },
});

/**
 * Empty the parked-leads table.
 *
 * Safe to delete outright — unlike `leads`, nothing here has ever been contacted:
 * the table carries no close_lead_id, no SMS history, no consent trail. So there is
 * no opt-out to preserve and no DNC guard needed (contrast admin.purgeByState, which
 * MUST DNC a lead before destroying a row that has a live SMS thread).
 *
 * DRY RUN by default. Batched — call until remaining === 0.
 */
export const purgeAll = mutation({
  args: { apply: v.optional(v.boolean()), limit: v.optional(v.number()) },
  handler: async (ctx, { apply, limit }) => {
    const rows = await ctx.db.query('review_website').collect();
    if (!apply) {
      return {
        applied: false,
        would_delete: rows.length,
        note: 'DRY RUN — nothing written. Pass {"apply":true} to commit.',
      };
    }
    const slice = rows.slice(0, limit ?? 100);
    for (const r of slice) await ctx.db.delete(r._id);
    return { applied: true, deleted: slice.length, remaining: rows.length - slice.length };
  },
});
