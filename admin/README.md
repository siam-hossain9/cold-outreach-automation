# admin/ — monitoring + kill-switch dashboard

Lightweight ops panel for the **Ugly-Website Rebuild** outreach line (the outreach product 2).
It reads pipeline stats straight from Convex and gives you one big **KILL SWITCH** that
flips `system_flags.outbound_paused` — the flag every send workflow checks before texting
or calling.

Stack: **Node + Express only.** Talks to Convex over its built-in HTTP function API using
Node 18+'s native `fetch`, so there is no Convex client dependency and no build step.

```
admin/
├── server.js              Express server: GET /api/stats, POST /kill, static files
├── public/index.html      Self-contained dashboard (polls stats, kill toggle)
├── convex/adminStats.ts   ⛔ DEAD leftover (stale call-first schema). Do NOT copy it.
├── package.json           express only
└── README.md              this file
```

---

## What it shows

Read live from the Convex tables in `convex/schema.ts` (the locked call-first schema):

- **Kill switch** — current `system_flags.outbound_paused`, with a pause/resume button
- **Leads** — total + count by status (`new → demo_ready → queued_call → called → opted_in → demo_sent → replied → closed_won/lost/dnc`)
- **Call queue** — depth to dial (`waiting` + `in_progress`) plus `done` / `skipped`
- **Demos** — built (`ready`) vs **sent** (`sent_at` set), plus queued / building / failed
- **Engagement** — click rate & 30s-view rate (unique leads ÷ demos sent) + raw totals
- **Follow-up stages** — A / B / C jobs by `scheduled` / `fired` / `skipped`
- **Recent pipeline errors** — the latest 20 rows from `pipeline_errors`

---

## Setup

### 1. Install the Convex functions (one-time)

Nothing to copy. The two functions the dashboard calls — `stats:dashboard` and
`stats:setKillSwitch` — already live in `convex/stats.ts` and are deployed. If the page
shows no data, just push the backend:

```bash
npx convex dev --once      # from the project root
```

> ⛔ **Do NOT copy `admin/convex/adminStats.ts` into `convex/`.** Older versions of this
> README told you to. That file is a dead leftover of the abandoned call-first design —
> its lead statuses and payload shape predate the text-first pivot. Copying it in deploys
> a stale, contradictory second stats module against live data.

No schema changes are needed — it only reads the existing tables (and upserts the one
`system_flags` kill-switch row).

### 2. Configure env

Secrets come from the **project-root `.env.local`** (git-ignored) — the same file the rest
of the stack uses. The admin server reads it automatically. Only one var is required:

| Var | Required | Purpose |
|-----|----------|---------|
| `CONVEX_URL` | ✅ | Convex deployment origin, e.g. `https://your-deployment.convex.cloud` |
| `ADMIN_PORT` / `PORT` | – | Port to listen on (default `8787`) |
| `ADMIN_TOKEN` | – | If set, `POST /kill` requires it (`Authorization: Bearer …` or `x-admin-token`) |
| `ADMIN_MUTATION_SECRET` | – | If you also set this **inside the Convex deployment**, the server forwards it so only holders can flip the switch (see Security) |

`CONVEX_URL` is already in `.env.example`. Nothing is hardcoded.

### 3. Install + run

```bash
cd admin
npm install
npm start           # → http://localhost:8787
# or: npm run dev   (auto-restart on edit)
```

Open the URL. If the backend isn't deployed yet, the page shows a banner telling you to
run `npx convex dev --once`.

**Security:** the server now binds to **`127.0.0.1` only** — it is not reachable from your
network. `GET /api/stats` is no longer public: it returns every contacted lead's name,
phone, city and the verbatim text of their replies, so it is guarded exactly like the kill
switch. If you deliberately expose it (`ADMIN_BIND=0.0.0.0`), an `ADMIN_TOKEN` becomes
mandatory and the server refuses to start without one.

---

## HTTP API

| Method | Route | Body | Returns |
|--------|-------|------|---------|
| `GET` | `/api/stats` | – | Full dashboard JSON (see shape below) |
| `GET` | `/api/health` | – | `{ ok, convex_url_set, token_required, time }` |
| `POST` | `/kill` | `{ "paused": true }` \| `{ "paused": false }` \| `{ "toggle": true }` \| `{}` (toggles) | `{ outbound_paused, previous, changed }` |

`/api/stats` shape:

```json
{
  "generated_at": 1750000000000,
  "kill_switch": { "outbound_paused": false },
  "leads": { "total": 0, "by_status": { "new": 0, "demo_ready": 0, "...": 0 } },
  "call_queue": { "waiting": 0, "in_progress": 0, "done": 0, "skipped": 0, "depth": 0 },
  "demos": { "total": 0, "queued": 0, "building": 0, "ready": 0, "failed": 0, "sent": 0 },
  "engagement": {
    "demos_sent": 0, "clicks_total": 0, "unique_clicked": 0,
    "views_total": 0, "unique_viewed": 0, "click_rate": 0, "view_rate": 0
  },
  "followups": { "A": {"scheduled":0,"fired":0,"skipped":0}, "B": {…}, "C": {…} },
  "pipeline_errors": { "total": 0, "recent": [ { "workflow": "", "error": "", "lead_id": null, "created_at": 0 } ] }
}
```

Toggle from the CLI:

```bash
# pause everything
curl -X POST localhost:8787/kill -H 'content-type: application/json' \
     -H 'x-admin-token: YOUR_TOKEN' -d '{"paused":true}'
# resume
curl -X POST localhost:8787/kill -H 'content-type: application/json' \
     -H 'x-admin-token: YOUR_TOKEN' -d '{"paused":false}'
```

---

## Security notes

This is an internal ops tool. Protections:

0. **Loopback by default.** The server binds `127.0.0.1` — not reachable from your network.
   It used to bind `0.0.0.0` (every interface) while printing `http://localhost:8787`,
   which was misleading. Override with `ADMIN_BIND`, but see the token rule below.

1. **`ADMIN_TOKEN`** guards **both** `POST /kill` **and** `GET /api/stats`.

   > ⚠️ `/api/stats` was previously described here as *"read-only counts, low sensitivity"*
   > and left open. **That was wrong.** It returns each contacted lead's name, phone, city,
   > Close id, and the verbatim text of their replies (up to 200 leads). Anyone who could
   > reach the port — same café wifi, same office LAN — could take the lot in one request.
   > It is now behind the same token as the kill switch, and if you bind to a non-loopback
   > address without an `ADMIN_TOKEN`, **the server refuses to start.**
2. **`ADMIN_MUTATION_SECRET`** (recommended for anything internet-reachable): Convex public
   functions are callable by anyone who knows the deployment URL, which means the kill
   switch could be flipped *around* this server. To close that, set
   `ADMIN_MUTATION_SECRET` as an environment variable **in the Convex deployment**
   (Convex dashboard → Settings → Environment Variables) *and* in `.env.local`. The Convex
   `setKillSwitch` mutation then rejects any call without the matching secret, and this
   server forwards it automatically.

For production, also put the dashboard behind your network/VPN or a reverse proxy with auth,
and consider converting these to Convex internal functions fronted by an authenticated
Convex HTTP action.

---

## How it fits the pipeline

Per `ARCHITECTURE.md`, `admin/` "reads Convex" and "toggles `system_flags.outbound_paused`".
Flipping the switch here halts every outbound path (WF-R2 demo SMS, WF-R4 follow-ups, the
call queue) within ~1s, because they all check that flag before contacting a lead — on top
of the channel gate, consent trail, and DNC checks.
