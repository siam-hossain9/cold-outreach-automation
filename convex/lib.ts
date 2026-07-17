// ─────────────────────────────────────────────────────────────────────────────
// lib.ts — shared PURE helpers for the Convex functions (no DB / no side effects).
// These are plain functions imported by the query/mutation/action modules so the
// compliance + normalization logic lives in exactly one place.
//
// NOTE: this is NOT a Convex function file — it exports no query/mutation/action,
// so `npx convex dev` ignores it for codegen. It only holds constants + pure logic.
// ─────────────────────────────────────────────────────────────────────────────

import type { Doc } from './_generated/dataModel';

/** Milliseconds — single clock used everywhere so timestamps are consistent. */
export const now = (): number => Date.now();

/** Last-10-digits phone key (mirrors scraper/find-ugly-sites.js `normPhone`). */
export function normalizePhone(raw: unknown): string {
  return String(raw ?? '').replace(/\D/g, '').slice(-10);
}

/** First name / label for message personalization (falls back to business name). */
export function firstToken(name: string): string {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

// ─── Niche normalization ─────────────────────────────────────────────────────
// The scraper searches more niches than the templates support (roofing, fencing,
// general contractor, …). The schema `leads.niche` union only allows the three we
// can actually rebuild, so importing MUST normalize and skip anything else.
export type Niche = 'electrician' | 'hvac' | 'plumber' | 'roofing';

export function normalizeNiche(raw: unknown): Niche | null {
  const s = String(raw ?? '').toLowerCase();
  if (/electric/.test(s)) return 'electrician';
  if (/hvac|heating|cooling|\bair\b|furnace|\ba\/?c\b/.test(s)) return 'hvac';
  if (/plumb/.test(s)) return 'plumber';
  if (/roof/.test(s)) return 'roofing'; // NOTE: no demo template yet — leads load, but can't be built until one exists
  return null; // unsupported niche → caller skips the row
}

// ─── Channel gate (source of truth: scraper/find-ugly-sites.js) ──────────────
// The scraper collapses its three-way gate into the schema's channel union:
//   TEXT_OK  → 'TEXT'      (green-light states)
//   CALL_FIRST + AVOID → 'CALL-ONLY'
//   unknown  → 'REVIEW'
// Because CALL-ONLY merges CALL_FIRST and AVOID, we ALSO keep the raw state lists
// here so the SMS guard can enforce the hard rule "never text an AVOID state" —
// even after a verbal opt-in — using lead.state. (CALL_FIRST states become
// textable once consent_at is stamped; AVOID states never do.)
// MUST stay identical to scraper/find-ugly-sites.js — that file is the source of truth.
// MI moved TEXT_OK → AVOID (2026-07-09) for SB 351 "Super TCPA" ($25k/violation, texts in
// scope). The scraper was updated; these two lists were NOT, so MI leads were still
// resolving to channel='TEXT' and passing canTextCold — the deliberate PAUSE-MI control
// was silently defeated at the one gate that guards every send. Fixed 2026-07-13.
export const TEXT_OK_STATES = ['NC','LA','TN','NM','AL','KY','OH','MS','AR','AZ','MO','GA','KS','ID','WI','WV','MN','MT','WY','IA','NE','SD','ND'];
export const CALL_FIRST_STATES = ['IN','PA','SC','NV','UT','CO','VA'];
export const AVOID_STATES = ['OK','FL','TX','WA','MD','CA','IL','MI'];

export function stateCode(s: unknown): string {
  const m = String(s ?? '').toUpperCase().match(/\b([A-Z]{2})\b/);
  return m ? m[1] : String(s ?? '').toUpperCase().trim();
}

// US state → dominant timezone (ET/CT/MT/PT) for the Close "Timezone" field + send timing.
// A few states straddle zones (FL/IN/KY/MI/TN/TX/…); we use the dominant one — fine for outreach.
const STATE_TZ: Record<string, string> = {
  CT: 'ET', DE: 'ET', FL: 'ET', GA: 'ET', IN: 'ET', KY: 'ET', ME: 'ET', MD: 'ET', MA: 'ET', MI: 'ET',
  NH: 'ET', NJ: 'ET', NY: 'ET', NC: 'ET', OH: 'ET', PA: 'ET', RI: 'ET', SC: 'ET', VT: 'ET', VA: 'ET', WV: 'ET', DC: 'ET',
  AL: 'CT', AR: 'CT', IL: 'CT', IA: 'CT', KS: 'CT', LA: 'CT', MN: 'CT', MS: 'CT', MO: 'CT', NE: 'CT',
  ND: 'CT', OK: 'CT', SD: 'CT', TN: 'CT', TX: 'CT', WI: 'CT',
  AZ: 'MT', CO: 'MT', ID: 'MT', MT: 'MT', NM: 'MT', UT: 'MT', WY: 'MT',
  CA: 'PT', NV: 'PT', OR: 'PT', WA: 'PT', AK: 'PT', HI: 'PT',
};
/** ET/CT/MT/PT for a state, or '' if unknown. */
export function stateTimezone(state: unknown): string {
  return STATE_TZ[stateCode(state)] || '';
}

// ─── TCPA quiet hours (47 CFR 64.1200(c)(1)) ─────────────────────────────────
// No solicitation texts before 8:00am or after 9:00pm at the RECIPIENT's local
// time. Applies with full force to cold outreach (King v. Bon Charge's consent
// defense needs a knowingly-provided number, which scraped leads lack).
const TZ_IANA: Record<string, string> = {
  ET: 'America/New_York', CT: 'America/Chicago', MT: 'America/Denver', PT: 'America/Los_Angeles',
};
// DST-aware fallback offsets (UTC hours) if Intl timezone data is unavailable.
const TZ_OFFSET_DST: Record<string, number> = { ET: -4, CT: -5, MT: -6, PT: -7 };
const TZ_OFFSET_STD: Record<string, number> = { ET: -5, CT: -6, MT: -7, PT: -8 };

/** Recipient-local {hour, minute} for a US state at time `ts`. Unknown state → ET (conservative). */
export function leadLocalTime(state: unknown, ts: number): { hour: number; minute: number } {
  const tz = stateTimezone(state) || 'ET';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ_IANA[tz], hour: 'numeric', minute: 'numeric', hour12: false });
    const parts = fmt.formatToParts(new Date(ts));
    const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? NaN);
    const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
    if (Number.isFinite(hour)) return { hour: hour === 24 ? 0 : hour, minute };
  } catch (_) { /* fall through to fixed offsets */ }
  const d = new Date(ts);
  const month = d.getUTCMonth() + 1; // rough US DST window: Mar–Nov
  const off = (month >= 3 && month <= 11 ? TZ_OFFSET_DST : TZ_OFFSET_STD)[tz];
  const h = ((d.getUTCHours() + off) % 24 + 24) % 24;
  return { hour: h, minute: d.getUTCMinutes() };
}

/** True if `ts` falls inside the recipient's 8am–9pm send window. */
export function inSendWindow(state: unknown, ts: number): boolean {
  const { hour } = leadLocalTime(state, ts);
  return hour >= 8 && hour < 21;
}

/** Ms until the recipient's send window next opens (0 if open now). +5min safety margin. */
export function msUntilSendWindow(state: unknown, ts: number): number {
  const { hour, minute } = leadLocalTime(state, ts);
  if (hour >= 8 && hour < 21) return 0;
  const minsNow = hour * 60 + minute;
  const minsUntil8am = hour < 8 ? (8 * 60 - minsNow) : (24 * 60 - minsNow) + 8 * 60;
  return (minsUntil8am + 5) * 60 * 1000;
}

export type Channel = 'TEXT' | 'CALL-ONLY' | 'REVIEW';

/** Normalize a raw scraper 'Channel' cell to the schema's channel union. */
export function normalizeChannel(raw: unknown, state?: unknown): Channel {
  const s = String(raw ?? '').toUpperCase().replace(/\s+/g, '');
  if (s === 'TEXT') return 'TEXT';
  if (s === 'CALL-ONLY' || s === 'CALLONLY' || s === 'CALL' || s === 'CALL-FIRST' || s === 'CALLFIRST') return 'CALL-ONLY';
  if (s === 'REVIEW') return 'REVIEW';
  // Fall back to deriving from the state if the channel cell was blank/garbage.
  const st = stateCode(state);
  if (TEXT_OK_STATES.includes(st)) return 'TEXT';
  if (CALL_FIRST_STATES.includes(st) || AVOID_STATES.includes(st)) return 'CALL-ONLY';
  return 'REVIEW';
}

/** Coerce a CSV cell (which is always a string) into a number, or undefined. */
export function coerceNumber(raw: unknown): number | undefined {
  if (raw === '' || raw == null) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

// ─── The single texting-consent gate ─────────────────────────────────────────
// Call-first funnel: a text may go out ONLY when ALL are true:
//   1. consent_at is stamped (verbal opt-in captured on the recorded call), AND
//   2. the state is not an AVOID state (hard channel-gate rule), AND
//   3. channel isn't 'REVIEW' (state we couldn't classify → route to a human).
// Kill-switch + DNC are checked separately (they can change between schedule and
// fire time, so the send actions re-query them live).
export interface TextGate { ok: boolean; reason: string }

export function canText(lead: Doc<'leads'>): TextGate {
  if (!lead.consent_at) return { ok: false, reason: 'no consent_at (never texted before a verbal opt-in)' };
  return canTextCold(lead);
}

// ─── The COLD (opener-stage) gate ────────────────────────────────────────────
// The text-first funnel opens with a cold SMS — by definition there is no
// consent_at yet (it's stamped on /opt-in, when the lead replies wanting the
// demo). So the opener nudges O1/O2/O3 cannot use canText(): it would skip
// 100% of them. They use the SAME gate the opener itself passes through
// (/opener-batch): channel + state + DNC + kill switch + quiet hours + cap.
// A nudge in a thread we already cold-opened is the same legal posture as the
// opener — it adds no new consent category. Everything AFTER a reply (the demo
// link and A/B/C) still requires consent_at via canText().
export function canTextCold(lead: Doc<'leads'>): TextGate {
  const st = stateCode(lead.state);
  if (AVOID_STATES.includes(st)) return { ok: false, reason: `AVOID state (${st}) — channel gate blocks SMS` };
  if (lead.channel === 'REVIEW') return { ok: false, reason: 'channel=REVIEW (state unclassified) — needs manual review' };
  if (lead.channel === 'CALL-ONLY') return { ok: false, reason: 'channel=CALL-ONLY — never textable' };
  return { ok: true, reason: 'ok' };
}

/** Statuses that mean the lead already responded / is closed → stop nudging. */
export const REPLIED_OR_DONE: ReadonlyArray<Doc<'leads'>['status']> = [
  'replied', 'interested', 'closed_won', 'closed_lost', 'dnc',
];
export function hasRepliedOrDone(lead: Doc<'leads'>): boolean {
  return REPLIED_OR_DONE.includes(lead.status);
}

// ─── Follow-up cadence (adapted from ugly-website-outreach-system.md WF-07) ──
export const FOLLOWUP_DELAYS_MS = {
  A: 3 * 60 * 60 * 1000,    // +3h from demo send, if no click + no reply
  B: 1 * 60 * 60 * 1000,    // +1h from the CLICK, if viewed 30s + no reply
  C: 48 * 60 * 60 * 1000,   // +48h from demo send, breakup if no reply
} as const;

// Copy per SMS-SEQUENCE-v2.md (2026-07-13). Path B follow-ups: A/B static, C carries
// {niche_singular}. No em-dashes in send bodies (UCS-2 cost) — ellipsis/comma/hyphen only.
export const FOLLOWUP_BODIES = {
  A: 'that link land ok? sms eats them sometimes. it\'s a 30 second look, promise',
  B: 'saw you had a look 👀 want anything tweaked? colors, photos, whatever. it\'s free either way.',
  C: 'all good if it\'s not for you, closing your file. i\'ll probably rework the design for another {niche_singular} eventually, so it won\'t sit forever. appreciate you even looking 🤝',
} as const;

// ─── Opener nudges (the lead got the cold opener and never replied) ──────────
// Anchored to the OPENER send, not the demo send — a cold lead never gets a demo,
// so A/B/C can never reach them. All three stop dead the moment the lead replies
// (hasRepliedOrDone) or opts out. Day-based cadence per SMS-SEQUENCE-v2.md:
// Day 2 / Day 5 / Day 7 from the opener.
export const OPENER_DELAYS_MS = {
  O1: 24 * 60 * 60 * 1000,    // +24h (Day 2) — the real nudge
  O2: 96 * 60 * 60 * 1000,    // +96h (Day 5) — "last try i promise"
  O3: 144 * 60 * 60 * 1000,   // +144h (Day 7) — one-per-area breakup
} as const;

// Touch 1 — the cold opener (no link). Sent by opener.sendOpener. Per SMS-SEQUENCE-v2.md;
// {Business} is interpolated per-lead by renderBody(). Sender name matches the campaign copy.
export const OPENER_TOUCH1 =
  "Hey. This is Jamison. pulled up {Business}'s site on my phone... looks dated.\n\n"
  + "someone finds you, opens it, it feels like 2012... they hit back and call the next guy. happens every week and you never see it.\n\n"
  + "I already built you a modern version, free to look. want me to send it?";

// {Business}/{city}/{niche_singular} are interpolated per-lead by renderBody().
export const OPENER_BODIES = {
  O1: 'hey, still want that modern rebuild of {Business}\'s site? it\'s done and just sitting here. every day the old one\'s up, it\'s quietly costing you calls.',
  O2: 'last try i promise... somebody in {city} probably needed a {niche_singular} today, opened your site, and called someone else. the new one\'s built. want it?',
  O3: 'alright, i\'ll rework the design for another {niche_singular} in {city} then. I only build one per area, and it was yours first though. cya later alligator 🐊',
} as const;

// Singular trade noun for the "somebody needed a {niche_singular}" lines.
const NICHE_SINGULAR: Record<string, string> = {
  electrician: 'electrician', plumber: 'plumber', roofing: 'roofer', hvac: 'hvac tech',
};
export function nicheSingular(niche?: string): string {
  return (niche && NICHE_SINGULAR[niche]) || 'business';
}

/**
 * Interpolate a send-body template with a lead's data.
 *   {Business}        -> lead.name (fallback "your business")
 *   {niche_singular}  -> nicheSingular(lead.niche) (fallback "business")
 *   {city}            -> lead.city; if absent, " in {city}" is dropped entirely
 * Missing-data fallback matches SMS-SEQUENCE-v2.md so a lead with no city/niche
 * still reads cleanly. Templates with no placeholders pass through unchanged.
 */
export function renderBody(
  template: string,
  lead: { name?: string; city?: string; niche?: string },
): string {
  const business = (lead.name || 'your business').trim();
  const city = (lead.city || '').trim();
  let t = template.replace(/\{niche_singular\}/g, nicheSingular(lead.niche));
  if (city) t = t.replace(/\{city\}/g, city);
  else t = t.replace(/ in \{city\}/g, '').replace(/\{city\}/g, 'your area');
  t = t.replace(/\{Business\}/g, business);
  return t;
}

/** Demo-link SMS — text-first flow: sent after the lead replies wanting to see it. */
export function demoSmsBody(business: string, shortUrl: string): string {
  const b = (business || 'your site').trim();
  return `love it. here's the modern rebuild of ${b}: ${shortUrl}\n\nopen it on your phone first, that's how everyone finds you. lmk what you think, no charge to look.`;
}
