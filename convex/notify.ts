// ─────────────────────────────────────────────────────────────────────────────
// notify.ts — Slack alerts for the rebuild pipeline (dedicated channel).
// Posts to SLACK_WEBHOOK_URL (Convex env). No-ops silently if the webhook is unset,
// so a missing/removed webhook never breaks a send path.
// ─────────────────────────────────────────────────────────────────────────────

import { internalAction } from './_generated/server';
import { v } from 'convex/values';
import { internal } from './_generated/api';

/** Post a plain-text message to the Slack webhook. Returns whether it was delivered. */
async function postSlack(text: string): Promise<boolean> {
  const url = process.env.SLACK_WEBHOOK_URL || '';
  if (!url) return false;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    return r.ok;
  } catch (_) {
    return false;
  }
}

/**
 * 🔥 HOT REPLY alert — a lead texted back interested. This is THE push alert that
 * matters (speed-to-lead: contact odds drop ~100x between a 5-min and 30-min
 * response), so it goes to Slack immediately with a one-click Close link.
 */
export const slackHotReply = internalAction({
  args: { leadId: v.id('leads'), text: v.string() },
  returns: v.object({ sent: v.boolean() }),
  handler: async (ctx, { leadId, text }): Promise<{ sent: boolean }> => {
    const lead = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return { sent: false };
    const closeUrl = lead.close_lead_id ? `https://app.close.com/lead/${lead.close_lead_id}/` : '';
    const msg =
      `:fire: *INTERESTED REPLY — respond fast (5-min window)*\n` +
      `*${lead.name}* (${lead.niche} · ${lead.city}, ${lead.state}) texted back:\n` +
      `> ${text.slice(0, 200)}\n` +
      `• Phone: ${lead.phone}\n` +
      (closeUrl ? `• Reply now: ${closeUrl}\n` : '') +
      `_The demo builds on reply — the sooner you answer, the warmer they are._`;
    return { sent: await postSlack(msg) };
  },
});

/**
 * 💬 ANY-REPLY alert — fires for every inbound reply that is NOT classified 'hot'
 * (opt-outs, rejections, questions, generic). Hot replies get the richer, urgent
 * slackHotReply instead, so each reply produces exactly one Slack message.
 */
export const slackReply = internalAction({
  args: { leadId: v.id('leads'), text: v.string(), intent: v.string() },
  returns: v.object({ sent: v.boolean() }),
  handler: async (ctx, { leadId, text, intent }): Promise<{ sent: boolean }> => {
    const lead = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return { sent: false };
    const closeUrl = lead.close_lead_id ? `https://app.close.com/lead/${lead.close_lead_id}/` : '';
    const label =
      intent === 'dnc' ? ':no_entry: *OPT-OUT — STOP reply (lead moved to DNC)*' :
      intent === 'not_interested' ? ':thumbsdown: *Not-interested reply*' :
      ':speech_balloon: *Lead replied*';
    const msg =
      `${label}\n` +
      `*${lead.name}* (${lead.niche} · ${lead.city}, ${lead.state}) texted back:\n` +
      `> ${text.slice(0, 200)}\n` +
      `• Phone: ${lead.phone}\n` +
      (closeUrl ? `• Open in Close: ${closeUrl}\n` : '');
    return { sent: await postSlack(msg) };
  },
});

/** Generic ops alert (delivery collapse, carrier-cap approach, …). */
export const slackAlert = internalAction({
  args: { text: v.string() },
  returns: v.object({ sent: v.boolean() }),
  handler: async (_ctx, { text }): Promise<{ sent: boolean }> => ({ sent: await postSlack(text) }),
});

/**
 * "DUPLICATE LEAD" alert — a scraped lead already exists in Close, so we skipped the
 * push. Includes the Convex id + full lead info + a link to the existing Close lead.
 */
export const slackDuplicate = internalAction({
  args: {
    leadId: v.id('leads'),
    matched_close_id: v.string(),
    matched_name: v.optional(v.string()),
  },
  returns: v.object({ sent: v.boolean() }),
  handler: async (ctx, { leadId, matched_close_id, matched_name }): Promise<{ sent: boolean }> => {
    const lead = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) return { sent: false };
    const closeUrl = `https://app.close.com/lead/${matched_close_id}/`;
    const text =
      `:warning: *DUPLICATE LEAD — not pushed to Close*\n` +
      `*${lead.name || '(no name)'}* is already in Close as _${matched_name || 'an existing lead'}_.\n` +
      `• Convex ID: \`${leadId}\`\n` +
      `• Phone: ${lead.phone || '-'}\n` +
      `• Niche: ${lead.niche}  |  Location: ${lead.city || '-'}, ${lead.state || '-'}\n` +
      `• Website: ${lead.website || '-'}\n` +
      `• Existing Close lead: ${closeUrl}\n` +
      `_Quarantined in Convex as status \`duplicate\` — it will not be pushed or texted._`;
    return { sent: await postSlack(text) };
  },
});
