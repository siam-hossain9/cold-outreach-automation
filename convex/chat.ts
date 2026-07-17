// chat.ts — chat-session + message state for the AI receptionist widget.
// The /chat httpAction (http.ts) orchestrates; these are its internal helpers.
import { internalMutation, internalQuery } from './_generated/server';
import { v } from 'convex/values';
import { now } from './lib';

/** Get an existing session or start a new one. message_count = assistant replies so far. */
export const ensureSession = internalMutation({
  args: { leadId: v.id('leads'), sessionId: v.optional(v.id('chat_sessions')), fingerprint: v.optional(v.string()) },
  handler: async (ctx, { leadId, sessionId, fingerprint }) => {
    if (sessionId) {
      const s = await ctx.db.get(sessionId);
      if (s) return { sessionId: s._id, message_count: s.message_count, ended: s.ended };
    }
    const id = await ctx.db.insert('chat_sessions', {
      lead_id: leadId, visitor_fingerprint: fingerprint, message_count: 0,
      ended: false, captured: false, started_at: now(), updated_at: now(),
    });
    return { sessionId: id, message_count: 0, ended: false };
  },
});

export const history = internalQuery({
  args: { sessionId: v.id('chat_sessions') },
  handler: async (ctx, { sessionId }) =>
    ctx.db.query('chat_messages').withIndex('by_session_id', (q) => q.eq('session_id', sessionId)).order('asc').take(20),
});

export const appendUser = internalMutation({
  args: { sessionId: v.id('chat_sessions'), leadId: v.id('leads'), content: v.string() },
  handler: async (ctx, { sessionId, leadId, content }) => {
    await ctx.db.insert('chat_messages', { session_id: sessionId, lead_id: leadId, role: 'user', content, created_at: now() });
  },
});

export const appendAssistant = internalMutation({
  args: { sessionId: v.id('chat_sessions'), leadId: v.id('leads'), content: v.string(), ended: v.optional(v.boolean()) },
  handler: async (ctx, { sessionId, leadId, content, ended }) => {
    await ctx.db.insert('chat_messages', { session_id: sessionId, lead_id: leadId, role: 'assistant', content, created_at: now() });
    const s = await ctx.db.get(sessionId);
    if (s) await ctx.db.patch(sessionId, { message_count: s.message_count + 1, updated_at: now(), ended: ended || s.ended });
  },
});

export const markCaptured = internalMutation({
  args: { sessionId: v.id('chat_sessions') },
  handler: async (ctx, { sessionId }) => { const s = await ctx.db.get(sessionId); if (s) await ctx.db.patch(sessionId, { captured: true }); },
});
