// ─────────────────────────────────────────────────────────────────────────────
// dashboardAuth.ts — login sessions + brute-force lockout for the ops dashboard.
//
// What this replaces:
//   • /dashboard-login used to return one STATIC token (the DASHBOARD_TOKEN env
//     var). Same value forever, for everyone, never expiring. One leak = permanent
//     access to every lead's name, phone, and reply text, revocable only by hand-
//     editing Convex env vars.
//   • It had NO rate limit. Unlimited guesses, at full speed, against password "123".
//
// Now: each login mints its own random 32-byte token with a hard expiry, stored in
// dashboard_sessions and revocable. Failed logins are counted per-IP and lock out.
//
//   checkLockout   (query)    is this IP currently locked out?
//   recordFailure  (mutation) count a bad password; lock the IP after MAX_FAILS
//   createSession  (mutation) mint a session on success; clears the IP's failures
//   validateToken  (query)    is this token a live, unexpired session?
//   revokeToken    (mutation) logout
//   purgeExpired   (mutation) cron cleanup
// ─────────────────────────────────────────────────────────────────────────────

import { internalMutation, internalQuery, mutation } from './_generated/server';
import { v } from 'convex/values';
import { now } from './lib';

const MAX_FAILS = 5;                       // wrong passwords before lockout
const LOCKOUT_MS = 15 * 60 * 1000;         // 15 minutes in the corner
const SESSION_MS = 12 * 60 * 60 * 1000;    // sessions die after 12h

/** True if this IP is locked out right now, plus when it frees up. */
export const checkLockout = internalQuery({
  args: { ip: v.string() },
  returns: v.object({ locked: v.boolean(), retry_in_s: v.number(), fails: v.number() }),
  handler: async (ctx, { ip }) => {
    const row = await ctx.db
      .query('login_attempts')
      .withIndex('by_ip', (q) => q.eq('ip', ip))
      .first();
    if (!row || !row.locked_until || row.locked_until <= now()) {
      return { locked: false, retry_in_s: 0, fails: row ? row.fails : 0 };
    }
    return {
      locked: true,
      retry_in_s: Math.ceil((row.locked_until - now()) / 1000),
      fails: row.fails,
    };
  },
});

/** Count a failed login for this IP; lock it out once MAX_FAILS is hit. */
export const recordFailure = internalMutation({
  args: { ip: v.string() },
  returns: v.object({ fails: v.number(), locked: v.boolean() }),
  handler: async (ctx, { ip }) => {
    const row = await ctx.db
      .query('login_attempts')
      .withIndex('by_ip', (q) => q.eq('ip', ip))
      .first();
    const ts = now();
    if (!row) {
      await ctx.db.insert('login_attempts', { ip, fails: 1, updated_at: ts });
      return { fails: 1, locked: false };
    }
    // A lockout that has already expired resets the counter.
    const expired = row.locked_until && row.locked_until <= ts;
    const fails = (expired ? 0 : row.fails) + 1;
    const locked = fails >= MAX_FAILS;
    await ctx.db.patch(row._id, {
      fails,
      locked_until: locked ? ts + LOCKOUT_MS : undefined,
      updated_at: ts,
    });
    return { fails, locked };
  },
});

/** Mint a fresh, expiring session. Clears this IP's failure count. */
export const createSession = internalMutation({
  args: { token: v.string(), ip: v.string() },
  returns: v.object({ expires_at: v.number() }),
  handler: async (ctx, { token, ip }) => {
    const ts = now();
    const expires_at = ts + SESSION_MS;
    await ctx.db.insert('dashboard_sessions', { token, created_at: ts, expires_at, ip });
    const row = await ctx.db
      .query('login_attempts')
      .withIndex('by_ip', (q) => q.eq('ip', ip))
      .first();
    if (row) await ctx.db.delete(row._id); // successful login clears the lockout
    return { expires_at };
  },
});

/** Is this token a live session? Expired rows are treated as invalid. */
export const validateToken = internalQuery({
  args: { token: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { token }) => {
    if (!token) return false;
    const row = await ctx.db
      .query('dashboard_sessions')
      .withIndex('by_token', (q) => q.eq('token', token))
      .first();
    return !!row && row.expires_at > now();
  },
});

/** Logout — kills this one session. */
export const revokeToken = internalMutation({
  args: { token: v.string() },
  returns: v.boolean(),
  handler: async (ctx, { token }) => {
    const row = await ctx.db
      .query('dashboard_sessions')
      .withIndex('by_token', (q) => q.eq('token', token))
      .first();
    if (!row) return false;
    await ctx.db.delete(row._id);
    return true;
  },
});

/** Cron: drop expired sessions and stale lockout rows so the tables stay small. */
export const purgeExpired = internalMutation({
  args: {},
  handler: async (ctx) => {
    const ts = now();
    let sessions = 0;
    for (const s of await ctx.db.query('dashboard_sessions').collect()) {
      if (s.expires_at <= ts) { await ctx.db.delete(s._id); sessions++; }
    }
    let attempts = 0;
    for (const a of await ctx.db.query('login_attempts').collect()) {
      // clear rows whose lockout lapsed and that haven't been touched in a day
      const stale = (!a.locked_until || a.locked_until <= ts) && a.updated_at < ts - 24 * 60 * 60 * 1000;
      if (stale) { await ctx.db.delete(a._id); attempts++; }
    }
    return { sessions_purged: sessions, attempts_purged: attempts };
  },
});

/** Revoke EVERY session — the "log everyone out" button (e.g. after a leak). */
export const revokeAllSessions = mutation({
  args: {},
  returns: v.number(),
  handler: async (ctx) => {
    const all = await ctx.db.query('dashboard_sessions').collect();
    for (const s of all) await ctx.db.delete(s._id);
    return all.length;
  },
});
