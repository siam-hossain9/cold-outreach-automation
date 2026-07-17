// ─────────────────────────────────────────────────────────────────────────────
// close.ts — thin wrapper around the Close CRM REST API (api.close.com/api/v1).
// Reuses an existing CRM org and sending number (both configured via env).
//
// These are Convex ACTIONS (they make outbound fetch calls). They do NOT enforce
// the compliance gates themselves — the callers (demos.sendDemoSms, followups.*)
// re-check kill-switch / DNC / consent before invoking sendSMS. Keeping this file
// a pure API wrapper means every send path is gated in exactly one obvious place.
//
// Custom-field IDs are taken verbatim from
//   scrap model/WF-MAPS-01-slack-maps-close-sheets.json  (Close "Create Lead" node).
// That workflow maps, in order: Keyword, a Yes/No flag, Address, Rating, Reviews,
// two 0-initialised counters, two more Yes/No flags, and the assigned SMS number.
// The IDs are authoritative; the friendly labels below are our best-guess names
// and can be renamed to match the Close UI without touching call sites.
// ─────────────────────────────────────────────────────────────────────────────

import { action, internalAction } from './_generated/server';
import { v } from 'convex/values';
import { api, internal } from './_generated/api';
import { stateTimezone } from './lib';

// ─── Close custom-field IDs (source: WF-MAPS-01) ─────────────────────────────
export const CF = {
  NICHE:         'cf_u4Hy4gZaeEGKM6hmtoXCvKHqxT5kLAMga9XE6HKa5cG', // <- Keyword/niche
  HAS_WEBSITE:   'cf_Oi24qEqopOXlvCcGFbqi2smvqwP2lbXviohZjiWNGrI', // Yes/No — has an existing site
  ADDRESS:       'cf_FoME7N83pc39pZ45Oa9AgS0n9om7ZnHkPRMiaLE6WXw', // Address
  RATING:        'cf_amnmRrlaPBheatw5a11gKcTHsOEYsXn9y4Q4eRAEfrf', // Google rating
  REVIEWS:       'cf_nyGJLfXTqtB4kTY4Vg1BEe67HRjvpqLXB0DIxGDOlKZ', // Google review count
  MESSAGES_SENT: 'cf_PcdRHPUTgoPxgqczBOFs5eDrhVFAqYcez63lQgCJyJK', // counter, +1 per outbound SMS
  CLICKS:        'cf_Of8vYP82dwic5izkQSJYkyUY41xz5TyG1XqO3i1KHDE', // counter, +1 per demo-link click
  ENGAGED:       'cf_VILBh0ONwUnLrrZ3CUNcrtV6oBNrbNQrqThYaFz6XlE', // Yes/No — replied / engaged
  OPTED_OUT:     'cf_nSiPslggc8beuvwOXfekz76BrmRxu9RX4u7FAe6wFrb', // Yes/No — do-not-contact / unsub
  SMS_NUMBER:    'cf_j6QkeiU0nlzk0kgngkIENCSHEu7LxJ3NsBN0TgvkzKT', // the assigned 10DLC number
  // ── Demo build/send (shared "Website Demo -" family, reused for the rebuild funnel) ──
  WEBSITE_URL:   'cf_puR11MBszpOng7mLQFSl9OJPd4kkYngn2YhBqru2MCv', // the OLD (ugly) site we rebuild
  DEMO_SEND:     'cf_MuBbV1mNj2o47xuMYhTyVYaqwaqaban5s8wxkeYdvZf', // False/True — manual trigger: flip True → build+send
  DEMO_SENT_AT:  'cf_RJaIZqW4kmINDhKvOWUSRe9IZ87VBPFkdGYyzwLSh6w', // datetime the demo was sent
  DEMO_SLUG:     'cf_CLBEEeGPX116lRecdaQX3Zht4Ex0XiCNkLT7BPJlu0Q', // the built demo's URL/slug
  DEMO_CLICKED:  'cf_JJr3nY7RiBitSqZ3ARqmKGGXCH8517mcnL2D8QLKMIn', // No/Yes — lead opened the demo
  DEMO_REBUILD:  'cf_PtpuFWgtGXpYyV5jjv5HOcPIPRulMAKjSgGwwZ4din5', // No/Yes — this is a rebuild lead (our funnel)
  // ── Rest of the standard lead field set (parity with the other product line) ──
  LEAD_TAG:      'cf_bWgM0fxF58n1BO5YElBmJcuTV1CzDw5sIGY3wa3b51u', // "lead" — product-line tag; ours = 'rebuild' (theirs = 'websell')
  CONVEX_ID:     'cf_QaXxtdAmTEByJ8SOBFk4wizgJwrwZF7XtSufDkTCP2x', // our Convex lead _id (links Close↔Convex)
  STATE:         'cf_saFSzrigpdmJraiY8Tj6PC2HYnieWXrxvlZ8ycUd3gp',
  CITY:          'cf_qi2n7BVM6AwYTv9AR4wyNBZDOP2SneLucX5NKNN150o',
  ZIP:           'cf_vqMAlwS6Wftd2Bl0jykhJvDuogQjghng9eeRuceDnpp',
  TIMEZONE:      'cf_BkcfnGTkMu0BnsxogmbuVQ746I4m4vqaTdZkQG5LYsV', // choices CT|ET|MT|PT
  MAPS_URL:      'cf_wOj9YA0SuwimkXa5dDv3UoJJWWeMHBxX5Pqw9qrK9Gb',
  LINE_TYPE:     'cf_CpsUzGm98lRUY7ah9LUhfFGGC6xwYE7ZYsBj1DcPgTf', // mobile/voip/landline — needs a phone lookup (not populated yet)
} as const;

const CLOSE_BASE = 'https://api.close.com/api/v1';

/** Basic-auth header: Close uses the API key as the username, blank password. */
function authHeader(): string {
  const key = process.env.CLOSE_API_KEY || '';
  if (!key) throw new Error('CLOSE_API_KEY not set (.env.local)');
  // btoa is available in the Convex runtime; API keys are ASCII so this is safe.
  return 'Basic ' + btoa(key + ':');
}

/** First configured sending number (CLOSE_SMS_NUMBER is a comma-separated list). */
function defaultFromNumber(): string {
  return (process.env.CLOSE_SMS_NUMBER || '').split(',')[0].trim();
}

async function closeFetch(pathname: string, method: string, body?: unknown): Promise<any> {
  const res = await fetch(CLOSE_BASE + pathname, {
    method,
    headers: { 'Authorization': authHeader(), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: any = {};
  try { json = text ? JSON.parse(text) : {}; } catch (_) { json = { raw: text }; }
  if (!res.ok) {
    throw new Error(`Close ${method} ${pathname} → ${res.status}: ${(json && (json.error || json['field-errors'] || json)) ? JSON.stringify(json).slice(0, 500) : text.slice(0, 500)}`);
  }
  return json;
}

// ─── Duplicate detection ──────────────────────────────────────────────────────
// Search Close for an existing lead with the same phone (last-10-digit match — the
// most format-agnostic key; Close's search matches regardless of +1 / punctuation).
// Returns the matched Close lead {id, display_name} or null. Read-only.
async function findDuplicateInClose(phone: string): Promise<{ id: string; display_name: string } | null> {
  const last10 = String(phone || '').replace(/\D/g, '').slice(-10);
  if (last10.length < 10) return null; // no reliable key → treat as not-duplicate
  const q = encodeURIComponent(`phone:"${last10}"`);
  const res = await closeFetch(`/lead/?_limit=1&_fields=id,display_name&query=${q}`, 'GET');
  const hit = (res && res.data && res.data[0]) || null;
  return hit ? { id: String(hit.id), display_name: String(hit.display_name || '') } : null;
}

/** Exposed check-only dedup (no create) — used by the /dedupe-sweep batch endpoint. */
export const findDuplicateByPhone = internalAction({
  args: { phone: v.string() },
  returns: v.union(v.null(), v.object({ id: v.string(), display_name: v.string() })),
  handler: async (_ctx, { phone }): Promise<{ id: string; display_name: string } | null> =>
    findDuplicateInClose(phone),
});

// ─── createLead ──────────────────────────────────────────────────────────────
// Creates the Close lead from a Convex lead and writes the close_lead_id back.
// DEDUP GATE: before creating, it checks whether the business is already in Close
// (by phone). If so it does NOT create a second lead — it quarantines the Convex
// lead as 'duplicate', Slacks the team, and returns { duplicate: true }.
export const createLead = action({
  args: { leadId: v.id('leads') },
  handler: async (ctx, { leadId }): Promise<{ close_lead_id: string; duplicate?: boolean }> => {
    const lead = await ctx.runQuery(internal.leads.getLead, { leadId });
    if (!lead) throw new Error(`lead ${leadId} not found`);
    if (lead.close_lead_id) return { close_lead_id: lead.close_lead_id };

    // Dedup gate — never create a duplicate lead in the shared Close org.
    if (lead.phone) {
      const dup = await findDuplicateInClose(lead.phone);
      if (dup) {
        await ctx.runMutation(internal.leads.markDuplicate, { leadId, duplicate_of: dup.id });
        await ctx.runAction(internal.notify.slackDuplicate, {
          leadId, matched_close_id: dup.id, matched_name: dup.display_name,
        });
        return { close_lead_id: '', duplicate: true };
      }
    }

    const custom: Record<string, unknown> = {
      // identity / classification
      [CF.NICHE]: lead.niche,
      [CF.HAS_WEBSITE]: 'Yes',                  // rebuild funnel = the business HAS an (ugly) site
      [CF.LEAD_TAG]: 'rebuild',                 // product-line marker (the other line uses 'websell')
      [CF.CONVEX_ID]: leadId,                   // link back to our Convex lead
      // location
      [CF.ADDRESS]: lead.address || [lead.city, lead.state, lead.zip].filter(Boolean).join(', '),
      [CF.CITY]: lead.city || '',
      [CF.STATE]: lead.state || '',
      [CF.ZIP]: lead.zip || '',
      [CF.TIMEZONE]: stateTimezone(lead.state), // '' if unknown → filtered out below
      [CF.MAPS_URL]: lead.maps_url || '',
      // google signal
      [CF.RATING]: lead.rating,                 // number | undefined → filtered if absent
      [CF.REVIEWS]: lead.reviews,
      // counters / flags
      [CF.MESSAGES_SENT]: 0,
      [CF.CLICKS]: 0,
      [CF.ENGAGED]: 'No',
      [CF.OPTED_OUT]: 'No',
      // SMS_NUMBER (Send Number) intentionally NOT set: Close 400s on an empty custom field at
      // create, and the sticky number is stamped later by smsNumbers.assignSmsNumber.
      // LINE_TYPE also omitted — needs a phone lookup we don't run yet.
      // demo build/send trigger (human-in-the-loop)
      [CF.WEBSITE_URL]: lead.website || '',     // the OLD site link we're rebuilding
      [CF.DEMO_SEND]: 'False',                  // toggle starts OFF — flip to True in Close to build+send
      [CF.DEMO_REBUILD]: 'Yes',                 // marks this as a rebuild-funnel lead (ours)
      [CF.DEMO_CLICKED]: 'No',                  // set Yes when the demo link is opened
    };

    const payload = {
      name: lead.name,
      url: lead.website || undefined,
      contacts: [{
        name: lead.name,
        phones: lead.phone ? [{ phone: lead.phone, type: 'office' }] : [],
      }],
      // Close flattens custom fields as `custom.<id>` keys on create. Skip empty values —
      // Close 400s on an empty-string custom field ("set the value to null to unset").
      ...Object.fromEntries(
        Object.entries(custom)
          .filter(([, val]) => val !== '' && val !== null && val !== undefined)
          .map(([k, val]) => [`custom.${k}`, val]),
      ),
    };

    const created = await closeFetch('/lead/', 'POST', payload);
    const close_lead_id: string = created.id;
    await ctx.runMutation(internal.leads.setCloseLeadId, { leadId, close_lead_id });
    return { close_lead_id };
  },
});

// ─── sendSMS ──────────────────────────────────────────────────────────────────
// Thin wrapper over Close's SMS activity endpoint. Caller supplies the resolved
// close_lead_id + numbers (it has already picked a number under the daily cap).
export const sendSMS = internalAction({
  args: {
    close_lead_id: v.string(),
    to: v.string(),
    text: v.string(),
    from: v.optional(v.string()),
  },
  handler: async (_ctx, { close_lead_id, to, text, from }): Promise<{ activity_id: string; from: string; to: string }> => {
    const local_phone = from || defaultFromNumber();
    if (!local_phone) throw new Error('no sending number (CLOSE_SMS_NUMBER / from)');
    const activity = await closeFetch('/activity/sms/', 'POST', {
      lead_id: close_lead_id,
      direction: 'outbound',
      status: 'outbox',       // hand to Close to actually send
      local_phone,
      remote_phone: to,
      text,
    });
    return { activity_id: activity.id, from: local_phone, to };
  },
});

// ─── setCustomFields ──────────────────────────────────────────────────────────
// PUT custom fields onto a lead. `set` writes values directly; `increment` reads
// current numeric values first and adds the deltas (used for the counter fields).
// Accepts either a Convex leadId (resolves + can create the Close lead) or a raw
// close_lead_id.
export const setCustomFields = internalAction({
  args: {
    leadId: v.optional(v.id('leads')),
    close_lead_id: v.optional(v.string()),
    set: v.optional(v.record(v.string(), v.any())),
    increment: v.optional(v.record(v.string(), v.number())),
  },
  handler: async (ctx, { leadId, close_lead_id, set, increment }): Promise<{ ok: boolean }> => {
    // Resolve the Close lead id.
    let closeId = close_lead_id;
    if (!closeId && leadId) {
      const lead = await ctx.runQuery(internal.leads.getLead, { leadId });
      if (!lead) throw new Error(`lead ${leadId} not found`);
      closeId = lead.close_lead_id
        || (await ctx.runAction(api.close.createLead, { leadId })).close_lead_id;
    }
    if (!closeId) throw new Error('setCustomFields needs leadId or close_lead_id');

    const updates: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(set || {})) updates[`custom.${k}`] = val;

    if (increment && Object.keys(increment).length) {
      // Read current counter values, then add deltas.
      const fields = Object.keys(increment).map((id) => `custom.${id}`).join(',');
      const current = await closeFetch(`/lead/${closeId}/?_fields=${encodeURIComponent(fields)}`, 'GET');
      for (const [id, delta] of Object.entries(increment) as Array<[string, number]>) {
        const cur = Number((current && current[`custom.${id}`]) ?? 0) || 0;
        updates[`custom.${id}`] = cur + Number(delta || 0);
      }
    }

    if (Object.keys(updates).length === 0) return { ok: true };
    await closeFetch(`/lead/${closeId}/`, 'PUT', updates);
    return { ok: true };
  },
});

// ─── markDoNotContact ─────────────────────────────────────────────────────────
// Flags the Close lead as opted-out. Belt-and-suspenders: also append it to the
// Convex dnc_list is handled by the caller (dnc.add) — this only touches Close.
export const markDoNotContact = internalAction({
  args: { leadId: v.optional(v.id('leads')), close_lead_id: v.optional(v.string()) },
  handler: async (ctx, { leadId, close_lead_id }): Promise<{ ok: boolean }> => {
    let closeId = close_lead_id;
    if (!closeId && leadId) {
      const lead = await ctx.runQuery(internal.leads.getLead, { leadId });
      closeId = lead?.close_lead_id || undefined;
    }
    if (!closeId) return { ok: false }; // nothing in Close yet — nothing to flag
    await closeFetch(`/lead/${closeId}/`, 'PUT', { [`custom.${CF.OPTED_OUT}`]: 'Yes' });
    return { ok: true };
  },
});
