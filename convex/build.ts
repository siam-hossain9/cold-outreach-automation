// ─────────────────────────────────────────────────────────────────────────────
// build.ts — AUTO-BUILD: a positive reply → demo built → demo texted. No human.
//
// CLOUD-NATIVE build: the demo is rendered + hosted by Convex itself (see
// demoTemplates.ts + http.ts /demo/{leadId}), so "building" is instant and needs
// NO external computer, port, or tunnel. buildSimple just confirms a template
// exists for the niche and points a ready demo row at the Convex-served page.
//
//   buildAndSend (internalAction)
//     1. pre-flight gates   (terminal status, DNC, kill switch, already-sent, template exists)
//     2. buildSimple        (instant — mark the demo ready at /demo/{leadId})
//     3. stamp consent_at   (the positive reply IS the consent trail)
//     4. demos.sendDemoSms  (enforces kill switch/DNC/quiet hours/cap + schedules A/C)
//
// (Previously this POSTed a local build-runner over BUILD_RUNNER_URL and blocked
// 1-4 min while it scraped + AI-gated real photos + deployed to Vercel. That path
// needed an always-on host reachable from Convex. The cloud build removes it.)
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from './_generated/server';
import { v } from 'convex/values';
import { api, internal } from './_generated/api';

const TERMINAL = ['dnc', 'closed_won', 'closed_lost'];

export const buildAndSend = internalAction({
  args: { leadId: v.id('leads') },
  returns: v.object({ built: v.boolean(), sent: v.boolean(), reason: v.optional(v.string()) }),
  handler: async (ctx, { leadId }): Promise<{ built: boolean; sent: boolean; reason?: string }> => {
    const bail = async (reason: string, built = false) => {
      await ctx.runMutation(internal.leads.recordError, {
        workflow: 'build.buildAndSend', error: reason, lead_id: leadId,
      });
      return { built, sent: false, reason };
    };

    // ── 1. Pre-flight ────────────────────────────────────────────────────────
    const lead = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return bail('lead not found');
    if (TERMINAL.includes(lead.status)) return bail(`lead is ${lead.status} — not building`);
    if (lead.status === 'demo_sent') return bail('demo already sent — not rebuilding');
    if (await ctx.runQuery(internal.systemFlags.paused, {})) return bail('outbound_paused (kill switch)');
    if (await ctx.runQuery(internal.dnc.checkPhone, { phone: lead.phone })) return bail('phone on DNC list');

    // ── 2. Build (instant, cloud-native — renders + hosts at /demo/{leadId}) ──
    const build = await ctx.runMutation(internal.demoTemplates.buildSimple, { leadId });
    if (!build.ready) return bail(build.reason || 'cloud build failed');

    // ── 3. Consent trail: their positive reply is what authorizes the link ────
    await ctx.runMutation(api.leads.setConsent, { leadId });

    // ── 4. Send. sendDemoSms re-checks every gate and schedules follow-ups A + C.
    const sent = await ctx.runAction(internal.demos.sendDemoSms, { leadId });
    return { built: true, sent: !!sent.sent, reason: sent.reason };
  },
});
