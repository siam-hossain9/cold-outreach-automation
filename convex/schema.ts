// Convex schema — NEW dedicated database for the Ugly-Website Rebuild project.
// Separate from the outreach's a separate deployment. Funnel: CALL-FIRST → opt-in → text demo.
// Create the DB with `npx convex dev` from this folder.
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export default defineSchema({
  // Rebuild leads — a trade business that HAS an outdated site (from the scraper CSV).
  leads: defineTable({
    place_id: v.string(),
    name: v.string(),
    phone: v.string(),
    website: v.string(),                       // their current ugly site
    niche: v.union(v.literal('electrician'), v.literal('hvac'), v.literal('plumber'), v.literal('roofing')),
    city: v.string(),
    state: v.string(),
    zip: v.optional(v.string()),
    address: v.optional(v.string()),           // full street address (for the Close Address field)
    maps_url: v.optional(v.string()),          // Google Maps link
    rating: v.optional(v.number()),            // Google rating
    reviews: v.optional(v.number()),           // Google review count
    channel: v.union(v.literal('TEXT'), v.literal('CALL-ONLY'), v.literal('REVIEW')),  // from scraper channel gate
    ugly_score: v.optional(v.number()),        // HTML score
    rank_score: v.optional(v.number()),        // vision-based (lower = worse-looking)
    ugly_reasons: v.optional(v.string()),
    vision_reasons: v.optional(v.string()),
    line_type: v.optional(v.string()),         // mobile/landline/voip (from scrub)
    sms_from_number: v.optional(v.string()),   // sticky 10DLC sender (assigned once at first touch; all follow-ups reuse it)
    // Call-first funnel state
    status: v.union(
      v.literal('new'),
      v.literal('opener_sent'),                // text-first opener sent, awaiting reply
      v.literal('demo_ready'),                 // rebuild built, waiting to contact
      v.literal('queued_call'),                // in the call queue
      v.literal('called'),
      v.literal('opted_in'),                   // said "text me the demo" → now consented
      v.literal('demo_sent'),
      v.literal('interested'),                 // hot/potential SMS reply — stands out from generic 'replied'
      v.literal('replied'),
      v.literal('closed_won'),
      v.literal('closed_lost'),
      v.literal('dnc'),
      v.literal('duplicate'),                  // already exists in Close → quarantined, never pushed/texted
    ),
    close_lead_id: v.optional(v.string()),
    duplicate_of: v.optional(v.string()),      // if 'duplicate': the existing Close lead id it matched
    // Reply intelligence (set by /inbound-sms when the lead texts back)
    reply_intent: v.optional(v.string()),      // hot | not_interested | generic | dnc
    last_reply_text: v.optional(v.string()),   // most recent inbound message (trimmed)
    replied_at: v.optional(v.number()),
    consent_at: v.optional(v.number()),        // when they verbally agreed to be texted (consent trail)
    created_at: v.number(),
    updated_at: v.number(),
  })
    .index('by_place_id', ['place_id'])
    .index('by_status', ['status'])
    // The opener batch asks for (status='new', channel='TEXT') directly. Without this
    // compound index it had to take() the oldest N rows and filter for TEXT afterwards —
    // and since non-TEXT leads (CALL-ONLY/REVIEW) never leave 'new', they pile up at the
    // head of the index and permanently starve the batch. Measured live: 486 'new' leads,
    // only 5 reachable. This index removes the failure mode entirely.
    .index('by_status_channel', ['status', 'channel'])
    .index('by_close_lead_id', ['close_lead_id']),

  // The pre-built rebuild demo for a lead.
  demos: defineTable({
    lead_id: v.id('leads'),
    demo_status: v.union(v.literal('queued'), v.literal('building'), v.literal('ready'), v.literal('failed')),
    scraped_config: v.optional(v.any()),       // site.config.json blob
    vercel_deployment_id: v.optional(v.string()),
    demo_url: v.optional(v.string()),          // live rebuilt site
    short_url: v.optional(v.string()),         // trackable /r/{lead}
    sent_at: v.optional(v.number()),
    error: v.optional(v.string()),
    created_at: v.number(),
  }).index('by_lead_id', ['lead_id']),

  // Call-first: the manual-dial queue (human dials, earns opt-in).
  call_queue: defineTable({
    lead_id: v.id('leads'),
    priority: v.number(),                       // lower rank_score = higher priority
    state: v.union(v.literal('waiting'), v.literal('in_progress'), v.literal('done'), v.literal('skipped')),
    outcome: v.optional(v.string()),            // opted_in / not_interested / no_answer / callback / dnc
    assigned_to: v.optional(v.string()),
    called_at: v.optional(v.number()),
    created_at: v.number(),
  }).index('by_state_priority', ['state', 'priority']),

  clicks: defineTable({
    lead_id: v.id('leads'),
    demo_id: v.id('demos'),
    user_agent: v.string(),
    ip_country: v.optional(v.string()),
    clicked_at: v.number(),
  }).index('by_lead_id', ['lead_id']),

  view_events: defineTable({
    lead_id: v.id('leads'),
    demo_id: v.id('demos'),
    duration_ms: v.number(),
    viewed_at: v.number(),
  }).index('by_lead_id', ['lead_id']),

  // ── SMS delivery mirror (synced FROM Close by smsDelivery.sweep every 15 min) ──
  // One row per Close SMS activity on OUR leads — including n8n-sent openers that
  // never pass through sms_send_log. This is the delivery-health source of truth:
  // status 'error' here = the carrier rejected it (e.g. landline), even though we
  // "sent" it. The auto-website repo's dashboard needed a 15-min cleanup workflow
  // for exactly this; ours lives as a Convex cron.
  sms_delivery: defineTable({
    activity_id: v.string(),                   // Close activity id (upsert key)
    lead_id: v.id('leads'),
    close_lead_id: v.string(),
    direction: v.string(),                     // inbound | outbound
    status: v.string(),                        // outbox | sent | delivered | error | ...
    error_message: v.optional(v.string()),
    local_phone: v.optional(v.string()),
    remote_phone: v.optional(v.string()),
    text_preview: v.optional(v.string()),
    activity_at: v.number(),                   // Close date_created (ms)
    synced_at: v.number(),
  })
    .index('by_activity_id', ['activity_id'])
    .index('by_lead_id', ['lead_id'])
    .index('by_activity_at', ['activity_at']),

  sms_send_log: defineTable({
    from_number: v.string(),
    to_number: v.string(),
    lead_id: v.id('leads'),
    stage: v.union(
      v.literal('opener'),
      v.literal('opener_nudge_1'), v.literal('opener_nudge_2'), v.literal('opener_breakup'),
      v.literal('demo_send'), v.literal('followup_a'), v.literal('followup_b'), v.literal('followup_c'),
      v.literal('owner_notification'),
    ),
    body: v.string(),
    close_activity_id: v.optional(v.string()),
    sent_at: v.number(),
  })
    .index('by_from_number', ['from_number', 'sent_at'])
    .index('by_lead_id', ['lead_id']),

  // O1/O2/O3 are the OPENER-anchored nudges (cold lead never replied); A/B/C are the
  // DEMO-anchored ones (lead replied, got a link). Both live here, keyed by stage.
  followup_jobs: defineTable({
    lead_id: v.id('leads'),
    stage: v.union(
      v.literal('O1'), v.literal('O2'), v.literal('O3'),
      v.literal('A'), v.literal('B'), v.literal('C'),
    ),
    scheduled_for: v.number(),
    status: v.union(v.literal('scheduled'), v.literal('fired'), v.literal('skipped')),
    scheduled_fn_id: v.optional(v.string()),
  }).index('by_lead_stage', ['lead_id', 'stage']),

  dnc_list: defineTable({
    phone: v.string(),
    reason: v.string(),
    added_at: v.number(),
  }).index('by_phone', ['phone']),

  system_flags: defineTable({
    key: v.string(),
    value: v.any(),
  }).index('by_key', ['key']),

  // ── Ops-dashboard auth ──────────────────────────────────────────────────────
  // Real, expiring sessions. Previously /dashboard-login handed back one STATIC
  // token (the DASHBOARD_TOKEN env var) that never changed and never expired — so a
  // single leak (screenshot, proxy log, shared browser) granted permanent access to
  // every lead's name, phone, and reply text, with no way to revoke short of editing
  // env vars. Each login now mints its own random token with a hard expiry.
  dashboard_sessions: defineTable({
    token: v.string(),
    created_at: v.number(),
    expires_at: v.number(),
    ip: v.optional(v.string()),
  }).index('by_token', ['token']),

  // Brute-force lockout for /dashboard-login. It had NO rate limit: unlimited
  // password guesses at full speed, against a password that was "123", returning a
  // token that unlocks the entire lead database.
  login_attempts: defineTable({
    ip: v.string(),
    fails: v.number(),
    locked_until: v.optional(v.number()),
    updated_at: v.number(),
  }).index('by_ip', ['ip']),

  pipeline_errors: defineTable({
    workflow: v.string(),
    lead_id: v.optional(v.id('leads')),
    error: v.string(),
    payload: v.optional(v.any()),
    created_at: v.number(),
  }),

  // ── AI Receptionist (chat + voice widget on every demo) ─────────────────────
  // Prompt-ready business info, built at demo time; the widgets look this up by lead.
  business_contexts: defineTable({
    lead_id: v.id('leads'),
    business_name: v.string(),
    niche: v.string(),
    phone: v.string(),
    city: v.string(),
    services: v.array(v.string()),
    service_area: v.optional(v.string()),
    hours: v.optional(v.string()),
    agent_name: v.string(),
    system_prompt: v.string(),                 // full system prompt for the chat model
    retell_dynamic_vars: v.optional(v.any()),  // JSON blob passed to Retell on call start
    owner_phone: v.string(),                   // where captured leads get texted
    created_at: v.number(),
  }).index('by_lead_id', ['lead_id']),

  chat_sessions: defineTable({
    lead_id: v.id('leads'),
    visitor_fingerprint: v.optional(v.string()),
    message_count: v.number(),
    ended: v.boolean(),
    captured: v.boolean(),
    started_at: v.number(),
    updated_at: v.number(),
  }).index('by_lead_id', ['lead_id']),

  chat_messages: defineTable({
    session_id: v.id('chat_sessions'),
    lead_id: v.id('leads'),
    role: v.union(v.literal('user'), v.literal('assistant')),
    content: v.string(),
    created_at: v.number(),
  }).index('by_session_id', ['session_id']),

  call_sessions: defineTable({
    lead_id: v.id('leads'),
    retell_call_id: v.string(),
    started_at: v.number(),
    ended_at: v.optional(v.number()),
    duration_s: v.optional(v.number()),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    captured: v.boolean(),
  })
    .index('by_lead_id', ['lead_id'])
    .index('by_retell_call_id', ['retell_call_id']),

  // ── Review-website leads: businesses whose site is ALREADY modern/decent ─────
  // Not a fit for the ugly-rebuild funnel (nothing to rebuild), so instead of
  // discarding them we park them here — a separate "database" for later triage /
  // a different pitch (e.g. the AI receptionist as a standalone add-on).
  review_website: defineTable({
    place_id: v.string(),
    name: v.string(),
    phone: v.string(),
    website: v.string(),
    niche: v.string(),                         // free-form — modern leads can be any trade, not just our 4
    city: v.string(),
    state: v.string(),
    zip: v.optional(v.string()),
    address: v.optional(v.string()),
    maps_url: v.optional(v.string()),
    rating: v.optional(v.number()),
    reviews: v.optional(v.number()),
    ugly_score: v.optional(v.number()),        // their score (≥ threshold = modern/decent)
    ugly_reasons: v.optional(v.string()),
    vision_verdict: v.optional(v.string()),    // 'modern' / '2010' / …
    vision_era: v.optional(v.string()),
    vision_reasons: v.optional(v.string()),
    channel: v.optional(v.string()),
    scrape_batch: v.optional(v.string()),
    reviewed: v.boolean(),                     // human triaged this modern lead yet?
    created_at: v.number(),
  }).index('by_place_id', ['place_id']),

  // ── Cloud-native demo templates ─────────────────────────────────────────────
  // The premium template HTML + its token manifest, stored so Convex can build a
  // demo with NO external computer: /demo/{leadId} loads the lead + the niche's
  // template row, runs reskin.ts (pure string swap), and serves the page live.
  // Seeded from generator/premium/templates/<dir>/layout.html via scripts/seed-templates.js.
  demo_templates: defineTable({
    niche: v.string(),                         // electrician | hvac | plumber | roofing
    html: v.string(),                          // the template layout.html (images already web/Convex-hosted)
    manifest: v.any(),                         // the ReskinManifest (token map)
    updated_at: v.number(),
  }).index('by_niche', ['niche']),

  // Leads the AI receptionist captured on a demo → texted to the business owner.
  captured_leads: defineTable({
    lead_id: v.id('leads'),                    // the pitched business (owner gets notified)
    source: v.union(v.literal('chat'), v.literal('voice')),
    session_id: v.optional(v.string()),
    visitor_name: v.string(),
    visitor_phone: v.string(),
    service_needed: v.optional(v.string()),
    urgency: v.optional(v.string()),
    summary: v.optional(v.string()),
    notified_owner_at: v.optional(v.number()),
    captured_at: v.number(),
  }).index('by_lead_id', ['lead_id']),
});
