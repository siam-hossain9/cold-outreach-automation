// ─────────────────────────────────────────────────────────────────────────────
// crons.ts — scheduled maintenance jobs.
//
//   auto-enqueue-ready-leads  every 5m  — push demo_ready leads into the call queue
//   reap-stale-calls          every 15m — requeue calls reserved but never resolved
//
// The follow-up cadence itself is NOT a cron: it uses Convex's durable
// scheduler.runAfter (see demos.ts / clicks.ts) so each nudge fires at a precise,
// per-lead time and survives redeploys.
// ─────────────────────────────────────────────────────────────────────────────

import { cronJobs } from 'convex/server';
import { internal } from './_generated/api';

const crons = cronJobs();

// Cold opener (Touch 1) — one weekday-morning batch. 14:00 UTC is 10am ET / 9am CT /
// 8am MT, inside the 8am–9pm window for our TEXT states; each send still re-checks
// the lead's own quiet hours and defers if needed. Paces the 242 at ~40/day.
crons.cron(
  'opener-batch-daily',
  '0 14 * * 1-5',
  internal.opener.openerBatch,
  { limit: 40 },
);

crons.interval(
  'auto-enqueue-ready-leads',
  { minutes: 5 },
  internal.callQueue.autoEnqueueReady,
  {},
);

crons.interval(
  'reap-stale-calls',
  { minutes: 15 },
  internal.callQueue.reapStale,
  {},
);

// Mirror Close SMS delivery statuses (incl. openers) into sms_delivery so
// carrier-rejected sends surface on the dashboard instead of counting as sent.
crons.interval(
  'sms-delivery-sweep',
  { minutes: 3 },
  internal.smsDelivery.sweep,
  {},
);

// Drop expired dashboard sessions + stale login-lockout rows.
crons.interval(
  'purge-expired-sessions',
  { hours: 1 },
  internal.dashboardAuth.purgeExpired,
  {},
);

export default crons;
