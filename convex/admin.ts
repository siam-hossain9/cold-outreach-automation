// admin.ts — maintenance/test-hygiene utilities (internal only).
import { internalMutation } from './_generated/server';
import { v } from 'convex/values';
import { now } from './lib';

/**
 * Purge every lead in a given state, with a compliance guard.
 *
 * Why the guard: a lead we have ALREADY TEXTED has a live SMS thread in Close. If we
 * delete it from Convex, /inbound-sms can no longer resolve that phone to one of our
 * leads — so a later "STOP" from them is answered with "not one of our leads" and is
 * silently DROPPED. The opt-out is never recorded, and if that business is scraped
 * again later it gets texted as if brand new. So: every contacted lead's phone goes on
 * the DNC list BEFORE its row is destroyed. dnc_list survives the purge and is checked
 * on every send, so they can never be contacted again.
 *
 * Also cancels any scheduled follow-up jobs (they would otherwise fire against a lead
 * that no longer exists) and cleans the tables deleteLeadCascade misses: followup_jobs,
 * sms_delivery, call_queue.
 *
 * DRY RUN by default. Batched — call repeatedly until remaining === 0.
 */
export const purgeByState = internalMutation({
  args: {
    state: v.string(),
    apply: v.optional(v.boolean()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, { state, apply, limit }) => {
    const batch = limit ?? 60;
    const all = await ctx.db.query('leads').collect();
    const targets = all.filter((l) => String(l.state).toUpperCase() === state.toUpperCase());
    const contacted = targets.filter((l) => l.close_lead_id);

    if (!apply) {
      return {
        applied: false,
        would_delete: targets.length,
        of_which_contacted: contacted.length,
        would_dnc: contacted.map((l) => ({ name: l.name, phone: l.phone })),
        keeping: all.length - targets.length,
        note: 'DRY RUN — nothing written. Pass {"apply":true} to commit.',
      };
    }

    const slice = targets.slice(0, batch);
    let dnced = 0;
    const counts: Record<string, number> = {};
    const bump = (k: string, n: number) => { counts[k] = (counts[k] || 0) + n; };

    for (const lead of slice) {
      // 1. COMPLIANCE FIRST — a texted lead can never be silently forgotten.
      if (lead.close_lead_id && lead.phone) {
        const norm = (s: string) => String(s || '').replace(/\D/g, '').slice(-10);
        const want = norm(lead.phone);
        const existing = await ctx.db.query('dnc_list').collect();
        if (!existing.some((r) => norm(r.phone) === want)) {
          await ctx.db.insert('dnc_list', {
            phone: lead.phone,
            reason: 'lead purged from Convex while an SMS thread was open — blocked from all future contact',
            added_at: now(),
          });
          dnced++;
        }
      }

      // 2. Cancel any pending scheduled follow-ups for this lead.
      const jobs = await ctx.db
        .query('followup_jobs')
        .withIndex('by_lead_stage', (q) => q.eq('lead_id', lead._id))
        .collect();
      for (const j of jobs) {
        if (j.status === 'scheduled' && j.scheduled_fn_id) {
          try { await ctx.scheduler.cancel(j.scheduled_fn_id as any); } catch (_) { /* already ran */ }
        }
        await ctx.db.delete(j._id);
      }
      bump('followup_jobs', jobs.length);

      // 3. Cascade every child table.
      const wipe = async (rows: { _id: any }[], key: string) => {
        for (const r of rows) await ctx.db.delete(r._id);
        bump(key, rows.length);
      };
      await wipe(await ctx.db.query('business_contexts').withIndex('by_lead_id', (q) => q.eq('lead_id', lead._id)).collect(), 'business_contexts');
      await wipe(await ctx.db.query('chat_sessions').withIndex('by_lead_id', (q) => q.eq('lead_id', lead._id)).collect(), 'chat_sessions');
      await wipe(await ctx.db.query('call_sessions').withIndex('by_lead_id', (q) => q.eq('lead_id', lead._id)).collect(), 'call_sessions');
      await wipe(await ctx.db.query('captured_leads').withIndex('by_lead_id', (q) => q.eq('lead_id', lead._id)).collect(), 'captured_leads');
      await wipe(await ctx.db.query('demos').withIndex('by_lead_id', (q) => q.eq('lead_id', lead._id)).collect(), 'demos');
      await wipe(await ctx.db.query('clicks').withIndex('by_lead_id', (q) => q.eq('lead_id', lead._id)).collect(), 'clicks');
      await wipe(await ctx.db.query('view_events').withIndex('by_lead_id', (q) => q.eq('lead_id', lead._id)).collect(), 'view_events');
      await wipe(await ctx.db.query('sms_send_log').withIndex('by_lead_id', (q) => q.eq('lead_id', lead._id)).collect(), 'sms_send_log');
      await wipe(await ctx.db.query('sms_delivery').withIndex('by_lead_id', (q) => q.eq('lead_id', lead._id)).collect(), 'sms_delivery');

      // call_queue has no by_lead index — scan it (it is tiny).
      const cq = (await ctx.db.query('call_queue').collect()).filter((r: any) => r.lead_id === lead._id);
      await wipe(cq, 'call_queue');

      await ctx.db.delete(lead._id);
      bump('leads', 1);
    }

    const remaining = targets.length - slice.length;
    return { applied: true, deleted_this_batch: slice.length, dnc_added: dnced, counts, remaining };
  },
});

/**
 * Delete child rows whose lead no longer exists. Leftovers accumulate from ad-hoc test
 * cleanups that predate purgeByState's full cascade. Harmless (a scheduled job on a
 * missing lead just no-ops) but they skew the dashboard's counts.
 */
export const purgeOrphans = internalMutation({
  args: { apply: v.optional(v.boolean()) },
  handler: async (ctx, { apply }) => {
    const alive = new Set((await ctx.db.query('leads').collect()).map((l) => String(l._id)));
    const counts: Record<string, number> = {};
    const sweep = async (table: any) => {
      const rows = await ctx.db.query(table).collect();
      let n = 0;
      for (const r of rows as any[]) {
        if (r.lead_id && !alive.has(String(r.lead_id))) {
          if (apply) await ctx.db.delete(r._id);
          n++;
        }
      }
      if (n) counts[table] = n;
    };
    for (const t of ['demos', 'clicks', 'view_events', 'followup_jobs', 'sms_send_log',
      'sms_delivery', 'call_queue', 'business_contexts', 'chat_sessions', 'call_sessions',
      'captured_leads'] as const) {
      await sweep(t);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { applied: !!apply, orphans: total, counts, note: apply ? 'deleted' : 'DRY RUN' };
  },
});

/** Remove a phone from the DNC list (re-opt-in, or test cleanup). Last-10-digit match. */
export const removeDncByPhone = internalMutation({
  args: { phone: v.string() },
  handler: async (ctx, { phone }) => {
    const norm = (s: string) => String(s || '').replace(/\D/g, '').slice(-10);
    const want = norm(phone);
    const rows = await ctx.db.query('dnc_list').collect();
    let removed = 0;
    for (const r of rows) if (norm(r.phone) === want) { await ctx.db.delete(r._id); removed++; }
    return { removed };
  },
});

/** Delete a lead and everything hanging off it. Used to clean up test leads. */
export const deleteLeadCascade = internalMutation({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }) => {
    const counts: Record<string, number> = {};
    const wipe = async (rows: { _id: any }[], key: string) => { for (const r of rows) await ctx.db.delete(r._id); counts[key] = rows.length; };

    await wipe(await ctx.db.query('business_contexts').withIndex('by_lead_id', (q) => q.eq('lead_id', leadId)).collect(), 'business_contexts');
    await wipe(await ctx.db.query('chat_sessions').withIndex('by_lead_id', (q) => q.eq('lead_id', leadId)).collect(), 'chat_sessions');
    await wipe(await ctx.db.query('call_sessions').withIndex('by_lead_id', (q) => q.eq('lead_id', leadId)).collect(), 'call_sessions');
    await wipe(await ctx.db.query('captured_leads').withIndex('by_lead_id', (q) => q.eq('lead_id', leadId)).collect(), 'captured_leads');
    await wipe(await ctx.db.query('demos').withIndex('by_lead_id', (q) => q.eq('lead_id', leadId)).collect(), 'demos');
    await wipe(await ctx.db.query('clicks').withIndex('by_lead_id', (q) => q.eq('lead_id', leadId)).collect(), 'clicks');
    await wipe(await ctx.db.query('view_events').withIndex('by_lead_id', (q) => q.eq('lead_id', leadId)).collect(), 'view_events');
    await wipe(await ctx.db.query('sms_send_log').withIndex('by_lead_id', (q) => q.eq('lead_id', leadId)).collect(), 'sms_send_log');

    const msgs = await ctx.db.query('chat_messages').collect();
    let m = 0; for (const r of msgs) if (r.lead_id === leadId) { await ctx.db.delete(r._id); m++; }
    counts['chat_messages'] = m;

    await ctx.db.delete(leadId);
    counts['leads'] = 1;
    return { deleted: counts };
  },
});
