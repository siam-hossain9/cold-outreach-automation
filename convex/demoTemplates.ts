// ─────────────────────────────────────────────────────────────────────────────
// demoTemplates.ts — cloud-native demo build + serve (no external computer).
//
//   upsertTemplate      seed/replace a niche's template HTML + manifest
//   getRenderable       (internal) fetch a lead + its niche template for serving
//   buildSimple         mark a lead's demo ready, pointed at /demo/{leadId}
//
// The actual HTML is produced on the fly at serve time (http.ts GET /demo/{leadId})
// by reskin.ts — a pure string swap, fast enough to run per-request. "Building" a
// demo is therefore instant: we just confirm a template exists for the niche and
// flip the demo row to ready with demo_url = the Convex-served page.
// ─────────────────────────────────────────────────────────────────────────────

import { mutation, internalQuery, internalMutation, query } from './_generated/server';
import { v } from 'convex/values';
import { resolveNiche } from './reskin';
import { now } from './lib';

/** Seed or replace a niche's template (called by scripts/seed-templates.js). */
export const upsertTemplate = mutation({
  args: { niche: v.string(), html: v.string(), manifest: v.any() },
  returns: v.object({ niche: v.string(), bytes: v.number(), replaced: v.boolean() }),
  handler: async (ctx, { niche, html, manifest }) => {
    const n = resolveNiche(niche);
    const existing = await ctx.db.query('demo_templates').withIndex('by_niche', (q) => q.eq('niche', n)).first();
    if (existing) {
      await ctx.db.patch(existing._id, { html, manifest, updated_at: now() });
      return { niche: n, bytes: html.length, replaced: true };
    }
    await ctx.db.insert('demo_templates', { niche: n, html, manifest, updated_at: now() });
    return { niche: n, bytes: html.length, replaced: false };
  },
});

/** Which niches currently have a template (for readiness checks / the dashboard). */
export const listTemplates = query({
  args: {},
  returns: v.array(v.object({ niche: v.string(), bytes: v.number(), updated_at: v.number() })),
  handler: async (ctx) => {
    const rows = await ctx.db.query('demo_templates').collect();
    return rows.map((r) => ({ niche: r.niche, bytes: r.html.length, updated_at: r.updated_at }));
  },
});

/** Internal: the lead + its niche template, for the /demo/{leadId} serve route. */
export const getRenderable = internalQuery({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) return null;
    const n = resolveNiche(lead.niche);
    const tpl = await ctx.db.query('demo_templates').withIndex('by_niche', (q) => q.eq('niche', n)).first();
    if (!tpl) return null;
    return {
      lead: { name: lead.name, phone: lead.phone, city: lead.city, state: lead.state, niche: lead.niche },
      html: tpl.html,
      manifest: tpl.manifest,
    };
  },
});

/**
 * "Build" a lead's demo the cloud-native way: verify a template exists for the
 * niche, then upsert a ready demo row pointed at the Convex-served page. Instant —
 * the HTML is rendered per-request at /demo/{leadId}. Returns { ready, demo_url }.
 */
export const buildSimple = internalMutation({
  args: { leadId: v.id('leads') },
  returns: v.object({ ready: v.boolean(), demo_url: v.union(v.string(), v.null()), reason: v.optional(v.string()) }),
  handler: async (ctx, { leadId }) => {
    const lead = await ctx.db.get(leadId);
    if (!lead) return { ready: false, demo_url: null, reason: 'lead not found' };
    const n = resolveNiche(lead.niche);
    const tpl = await ctx.db.query('demo_templates').withIndex('by_niche', (q) => q.eq('niche', n)).first();
    if (!tpl) return { ready: false, demo_url: null, reason: `no template for niche "${n}"` };

    const site = (process.env.CONVEX_SITE_URL || '').replace(/\/$/, '');
    const demo_url = `${site}/demo/${leadId}`;
    const short_url = `${site}/r/${leadId}`;

    const existing = await ctx.db.query('demos').withIndex('by_lead_id', (q) => q.eq('lead_id', leadId)).order('desc').first();
    if (existing) {
      await ctx.db.patch(existing._id, { demo_status: 'ready', demo_url, short_url });
    } else {
      await ctx.db.insert('demos', {
        lead_id: leadId, demo_status: 'ready', demo_url, short_url, created_at: now(),
      });
    }
    return { ready: true, demo_url };
  },
});
