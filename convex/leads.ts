// ─────────────────────────────────────────────────────────────────────────────
// leads.ts — lead ingestion + lifecycle for the Ugly-Website Rebuild funnel.
//
//   batchInsert  map scraper leads-*.csv columns → schema fields, dedupe by place_id
//   byStatus     list leads in a given funnel status (n8n / admin)
//   getByPlaceId / get / getLead   lookups
//   setStatus    move a lead through the funnel
//   setConsent   stamp consent_at (the consent trail — call-first opt-in)
//   setCloseLeadId   link a Convex lead to its Close CRM lead
//   recordError  write a row to pipeline_errors (shared error sink)
//
// Field/table names match convex/schema.ts exactly.
// ─────────────────────────────────────────────────────────────────────────────

import { mutation, query, internalQuery, internalMutation } from './_generated/server';
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import {
  now, normalizeNiche, normalizeChannel, coerceNumber,
} from './lib';

// The full status union, reused by validators below.
const statusValidator = v.union(
  v.literal('new'),
  v.literal('opener_sent'),
  v.literal('demo_ready'),
  v.literal('queued_call'),
  v.literal('called'),
  v.literal('opted_in'),
  v.literal('demo_sent'),
  v.literal('interested'),
  v.literal('replied'),
  v.literal('closed_won'),
  v.literal('closed_lost'),
  v.literal('dnc'),
  v.literal('duplicate'),
);

// One incoming row from the scraper CSV. Scores arrive as strings from CSV, so we
// accept string|number and coerce. `niche`/`channel` arrive raw and get normalized.
const csvLead = v.object({
  place_id: v.string(),
  name: v.string(),
  phone: v.string(),
  website: v.string(),
  niche: v.string(),
  city: v.optional(v.string()),
  state: v.optional(v.string()),
  zip: v.optional(v.string()),
  address: v.optional(v.string()),
  maps_url: v.optional(v.string()),
  rating: v.optional(v.union(v.number(), v.string())),
  reviews: v.optional(v.union(v.number(), v.string())),
  channel: v.optional(v.string()),
  ugly_score: v.optional(v.union(v.number(), v.string())),
  rank_score: v.optional(v.union(v.number(), v.string())),
  ugly_reasons: v.optional(v.string()),
  vision_reasons: v.optional(v.string()),
  line_type: v.optional(v.string()),
});

/**
 * Bulk-import scraped leads. Maps the CSV column shape onto schema fields,
 * normalizes niche/channel/scores, and dedupes by place_id (both against the DB
 * and within the batch). Rows with an empty place_id or an unsupported niche
 * (roofing/fencing/… which we have no template for) are skipped, not inserted.
 */
export const batchInsert = mutation({
  args: { leads: v.array(csvLead) },
  returns: v.object({
    inserted: v.number(),
    skipped: v.number(),
    ids: v.array(v.id('leads')),
  }),
  handler: async (ctx, { leads }) => {
    const ids: Array<Doc<'leads'>['_id']> = [];
    const seenInBatch = new Set<string>();
    let skipped = 0;
    const ts = now();

    for (const row of leads) {
      const place_id = String(row.place_id || '').trim();
      if (!place_id || seenInBatch.has(place_id)) { skipped++; continue; }
      seenInBatch.add(place_id);

      // Only rebuild-able niches map to the schema union; skip the rest.
      const niche = normalizeNiche(row.niche);
      if (!niche) { skipped++; continue; }

      // Dedupe against already-imported leads.
      const existing = await ctx.db
        .query('leads')
        .withIndex('by_place_id', (q) => q.eq('place_id', place_id))
        .first();
      if (existing) { skipped++; continue; }

      const state = String(row.state || '').toUpperCase().trim();
      const id = await ctx.db.insert('leads', {
        place_id,
        name: row.name || '',
        phone: row.phone || '',
        website: row.website || '',
        niche,
        city: row.city || '',
        state,
        zip: row.zip || undefined,
        address: row.address || undefined,
        maps_url: row.maps_url || undefined,
        rating: coerceNumber(row.rating),
        reviews: coerceNumber(row.reviews),
        channel: normalizeChannel(row.channel, state),
        ugly_score: coerceNumber(row.ugly_score),
        rank_score: coerceNumber(row.rank_score),
        ugly_reasons: row.ugly_reasons || undefined,
        vision_reasons: row.vision_reasons || undefined,
        line_type: row.line_type || undefined,
        status: 'new',
        created_at: ts,
        updated_at: ts,
      });
      ids.push(id);
    }

    return { inserted: ids.length, skipped, ids };
  },
});

/** List leads in a given funnel status (indexed). Newest first, capped. */
export const byStatus = query({
  args: { status: statusValidator, limit: v.optional(v.number()) },
  handler: async (ctx, { status, limit }) => {
    const rows = await ctx.db
      .query('leads')
      .withIndex('by_status', (q) => q.eq('status', status))
      .order('desc')
      .take(limit ?? 100);
    return rows;
  },
});

/** Public single-lead fetch (admin / n8n). */
export const get = query({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }) => ctx.db.get(leadId),
});

/** Fetch by the scraper's place_id (used for idempotent re-imports). */
export const getByPlaceId = query({
  args: { place_id: v.string() },
  handler: async (ctx, { place_id }) =>
    ctx.db
      .query('leads')
      .withIndex('by_place_id', (q) => q.eq('place_id', place_id))
      .first(),
});

/** Resolve a lead by its Close lead id (n8n reply handler; indexed). */
export const getByCloseLeadId = query({
  args: { close_lead_id: v.string() },
  handler: async (ctx, { close_lead_id }) =>
    ctx.db
      .query('leads')
      .withIndex('by_close_lead_id', (q) => q.eq('close_lead_id', close_lead_id))
      .first(),
});

/** Resolve a lead by phone (last-10-digit match). Fallback for the reply handler. */
export const getByPhone = query({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const norm = (s: string) => String(s || '').replace(/\D/g, '').slice(-10);
    const want = norm(phone);
    if (!want) return null;
    const rows = await ctx.db.query('leads').order('desc').take(2000);
    return rows.find((r) => norm(r.phone) === want) ?? null;
  },
});

/**
 * Candidates for the text-first opener batch: status 'new' + channel 'TEXT'.
 *
 * Queries the compound index directly rather than take()-then-filter. The old form
 * read the oldest n*3 'new' leads and filtered for TEXT afterwards — but non-TEXT
 * leads (CALL-ONLY / REVIEW) never leave 'new', so they accumulate at the head of the
 * index and starve the batch. Measured live: 486 'new' leads, only 5 reachable, and it
 * would have hit zero permanently while hundreds of textable leads sat behind them.
 */
export const openerCandidates = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const n = limit ?? 40;
    return await ctx.db
      .query('leads')
      .withIndex('by_status_channel', (q) => q.eq('status', 'new').eq('channel', 'TEXT'))
      .take(n);
  },
});

/**
 * Lead inventory: how many leads exist, and how many are ACTUALLY textable.
 * "Scraped 493" is a vanity number — what matters is how many are channel='TEXT'
 * and still uncontacted, because everything else can never receive an opener.
 */
export const inventory = query({
  args: {},
  handler: async (ctx) => {
    const all = await ctx.db.query('leads').collect();
    const byStatus: Record<string, number> = {};
    const byChannel: Record<string, number> = {};
    const newByChannel: Record<string, number> = {};
    const newTextByState: Record<string, number> = {};
    for (const l of all) {
      byStatus[l.status] = (byStatus[l.status] || 0) + 1;
      byChannel[l.channel] = (byChannel[l.channel] || 0) + 1;
      if (l.status === 'new') {
        newByChannel[l.channel] = (newByChannel[l.channel] || 0) + 1;
        if (l.channel === 'TEXT') newTextByState[l.state] = (newTextByState[l.state] || 0) + 1;
      }
    }
    return {
      total: all.length,
      by_status: byStatus,
      by_channel: byChannel,
      uncontacted_by_channel: newByChannel,
      textable_remaining: newByChannel.TEXT || 0,
      textable_by_state: newTextByState,
    };
  },
});

/**
 * Repair leads stuck on channel='REVIEW' whose state IS classifiable.
 *
 * Cause: oh-570-with-website.csv had no "Channel" column, so 487 leads were imported
 * as REVIEW (the safe never-text bucket) even though their state saved correctly as OH
 * — a TEXT_OK state. Result: 470 perfectly textable Ohio leads were invisible to the
 * opener batch, leaving only 5 usable leads out of 493.
 *
 * Re-derives channel from the STORED state using the same gate as the importer. AVOID
 * states (incl. MI) still resolve to CALL-ONLY, so this can never make an off-limits
 * lead textable. Status is never touched — duplicates stay quarantined.
 *
 * DRY RUN by default. Pass { apply: true } to write.
 */
export const repairChannels = mutation({
  args: { apply: v.optional(v.boolean()) },
  handler: async (ctx, { apply }) => {
    const rows = await ctx.db
      .query('leads')
      .filter((q) => q.eq(q.field('channel'), 'REVIEW'))
      .collect();

    const plan: Record<string, number> = {};
    const byState: Record<string, string> = {};
    let changed = 0;
    for (const l of rows) {
      const next = normalizeChannel('', l.state); // re-derive purely from state
      byState[l.state] = next;
      const key = `${l.state || '(blank)'} REVIEW -> ${next}`;
      plan[key] = (plan[key] || 0) + 1;
      if (next !== 'REVIEW') {
        changed++;
        if (apply) await ctx.db.patch(l._id, { channel: next, updated_at: now() });
      }
    }
    return {
      applied: !!apply,
      reviewed: rows.length,
      would_change: changed,
      plan,
      note: apply ? 'channels updated' : 'DRY RUN — nothing written. Pass {"apply":true} to commit.',
    };
  },
});

/**
 * Park leads out of the texting pool by flipping channel TEXT → REVIEW (openerCandidates
 * only picks channel='TEXT', so these are skipped). Used to exclude the "MODERN — recheck"
 * leads whose sites aren't actually dated. Only touches 'new' + 'TEXT' leads. Reversible.
 */
export const parkLeads = mutation({
  args: { leadIds: v.array(v.id('leads')) },
  returns: v.object({ parked: v.number(), skipped: v.number() }),
  handler: async (ctx, { leadIds }) => {
    let parked = 0, skipped = 0;
    for (const id of leadIds) {
      const l = await ctx.db.get(id);
      if (l && l.status === 'new' && l.channel === 'TEXT') { await ctx.db.patch(id, { channel: 'REVIEW', updated_at: now() }); parked++; }
      else skipped++;
    }
    return { parked, skipped };
  },
});

/**
 * Record a lead's discovered line type (from the delivery result). 'mobile' is sticky —
 * once a number proves textable it never downgrades to landline on a later hiccup.
 */
export const setLineType = internalMutation({
  args: { leadId: v.id('leads'), lineType: v.string() },
  handler: async (ctx, { leadId, lineType }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) return { changed: false };
    if (lead.line_type === lineType) return { changed: false };
    if (lead.line_type === 'mobile' && lineType === 'landline') return { changed: false }; // never downgrade
    await ctx.db.patch(leadId, { line_type: lineType, updated_at: now() });
    return { changed: true };
  },
});

/** Count leads by Google-review count, with a caller-supplied band. */
export const reviewBand = query({
  args: { min: v.number(), max: v.number() },
  handler: async (ctx, { min, max }) => {
    const all = await ctx.db.query('leads').collect();
    const withReviews = all.filter((l) => typeof l.reviews === 'number');
    const inBand = withReviews.filter((l) => (l.reviews as number) >= min && (l.reviews as number) <= max);
    // textable-only view too (what you can actually run)
    const inBandTextable = inBand.filter((l) => l.channel === 'TEXT' && l.status === 'new');
    const byTrade: Record<string, number> = {};
    for (const l of inBand) byTrade[l.niche] = (byTrade[l.niche] || 0) + 1;
    return {
      total_leads: all.length,
      with_review_data: withReviews.length,
      in_band: inBand.length,
      in_band_textable_new: inBandTextable.length,
      by_trade: byTrade,
      band: `${min}-${max} reviews`,
    };
  },
});

/** Internal single-lead fetch used by actions (followups / close / demos). */
export const getLead = internalQuery({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }) => ctx.db.get(leadId),
});

/**
 * Candidates for the Close duplicate sweep: status 'new' leads that have a phone
 * (the dedup key). Newest first, capped. Used by WF-UW-06 → /dedupe-sweep.
 */
export const duplicateCandidates = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query('leads')
      .withIndex('by_status', (q) => q.eq('status', 'new'))
      .order('desc')
      .take((limit ?? 50) * 2);
    return rows.filter((r) => r.phone).slice(0, limit ?? 50);
  },
});

/**
 * Leads that have been pushed to Close and touched by outreach — the set the
 * delivery sweep re-checks against Close. Newest first (fixes the auto-website
 * repo's oldest-500 freeze bug by design).
 */
export const contactedWithCloseId = internalQuery({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    // Contacted leads are a small subset — scan the whole table (fine at this
    // scale), then newest-first cap. take(N)-then-filter would miss leads buried
    // under later imports (the exact freeze bug the auto-website repo shipped).
    const rows = await ctx.db.query('leads').collect();
    return rows
      .filter((r) => r.close_lead_id && !['new', 'duplicate'].includes(r.status))
      .sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0))
      .slice(0, limit ?? 100);
  },
});

/** Record an inbound reply's text + classified intent on the lead (for the hot list). */
export const recordReply = internalMutation({
  args: { leadId: v.id('leads'), text: v.string(), intent: v.string() },
  handler: async (ctx, { leadId, text, intent }) => {
    await ctx.db.patch(leadId, {
      last_reply_text: text.slice(0, 300),
      reply_intent: intent,
      replied_at: now(),
      updated_at: now(),
    });
  },
});

/**
 * Quarantine a lead that already exists in Close: status → 'duplicate', record the
 * matched Close lead id. openerCandidates/duplicateCandidates only pick 'new', so a
 * quarantined lead is never pushed to Close or texted again.
 */
export const markDuplicate = internalMutation({
  args: { leadId: v.id('leads'), duplicate_of: v.string() },
  handler: async (ctx, { leadId, duplicate_of }) => {
    await ctx.db.patch(leadId, { status: 'duplicate', duplicate_of, updated_at: now() });
    return { ok: true };
  },
});

/** Move a lead to a new funnel status. */
export const setStatus = mutation({
  args: { leadId: v.id('leads'), status: statusValidator },
  handler: async (ctx, { leadId, status }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) throw new Error(`lead ${leadId} not found`);
    await ctx.db.patch(leadId, { status, updated_at: now() });
    return { ok: true };
  },
});

/**
 * Stamp the consent trail. Called when a lead verbally agrees on the call to be
 * texted the demo. Idempotent: keeps the EARLIEST consent timestamp so the trail
 * reflects when consent was actually first given. Does NOT change status — the
 * caller (callQueue.recordOutcome / WF-R2) owns the status transition.
 */
export const setConsent = mutation({
  args: { leadId: v.id('leads'), at: v.optional(v.number()) },
  handler: async (ctx, { leadId, at }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) throw new Error(`lead ${leadId} not found`);
    const consent_at = lead.consent_at ?? at ?? now();
    await ctx.db.patch(leadId, { consent_at, updated_at: now() });
    return { consent_at };
  },
});

/**
 * Backfill scrape fields (rating/reviews/maps_url/address) onto leads already imported
 * before batchInsert captured them. Matches by place_id; only fills blanks. Idempotent.
 */
export const enrichFromScrape = mutation({
  args: {
    rows: v.array(v.object({
      place_id: v.string(),
      address: v.optional(v.string()),
      maps_url: v.optional(v.string()),
      rating: v.optional(v.union(v.number(), v.string())),
      reviews: v.optional(v.union(v.number(), v.string())),
    })),
  },
  handler: async (ctx, { rows }) => {
    let updated = 0;
    for (const r of rows) {
      const lead = await ctx.db.query('leads').withIndex('by_place_id', (q) => q.eq('place_id', r.place_id)).first();
      if (!lead) continue;
      const patch: Record<string, unknown> = {};
      if (r.address && !lead.address) patch.address = r.address;
      if (r.maps_url && !lead.maps_url) patch.maps_url = r.maps_url;
      const rating = coerceNumber(r.rating); if (rating != null && lead.rating == null) patch.rating = rating;
      const reviews = coerceNumber(r.reviews); if (reviews != null && lead.reviews == null) patch.reviews = reviews;
      if (Object.keys(patch).length) { await ctx.db.patch(lead._id, { ...patch, updated_at: now() }); updated++; }
    }
    return { updated };
  },
});

/** Link a Convex lead to its Close CRM lead id (set by close.createLead). */
export const setCloseLeadId = internalMutation({
  args: { leadId: v.id('leads'), close_lead_id: v.string() },
  handler: async (ctx, { leadId, close_lead_id }) => {
    await ctx.db.patch(leadId, { close_lead_id, updated_at: now() });
  },
});

/** Shared error sink — every workflow/action logs failures here. */
export const recordError = internalMutation({
  args: {
    workflow: v.string(),
    error: v.string(),
    lead_id: v.optional(v.id('leads')),
    payload: v.optional(v.any()),
  },
  handler: async (ctx, { workflow, error, lead_id, payload }) => {
    await ctx.db.insert('pipeline_errors', {
      workflow, error, lead_id, payload, created_at: now(),
    });
  },
});
