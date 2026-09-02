# generator/ — Demo / Rebuild Generator

the outreach system (**Ugly-Website Rebuild**). This is the component that turns
**one scraped lead** into a **live, modern rebuild demo** of their business.

```
scraper/ leads-*.csv ─▶ [ generator/ ] ─▶ demos.demo_url + short_url ; leads.status='demo_ready'
                          scrape old site → site.config.json → fill templates/<niche> → deploy Vercel
```

It reads a lead (a `leads-*.csv` row from `scraper/`, or CLI args), fetches and
reads that business's **current (ugly) website**, extracts the real content,
composes a **`site.config.json`** that satisfies
[`templates/_shared/site.config.schema.json`](../templates/_shared/site.config.schema.json)
(the generator↔template contract), fills the matching `templates/<niche>` into a
**ready-to-deploy folder**, and hands it to `deploy-vercel.js`.

> **Contact-neutral.** Building a demo does **not** text or call anyone, so the
> channel gate / consent / kill-switch (which govern *outbound messaging*) are
> enforced later by the n8n workflows — not here. The lead's `Channel` is printed
> for the operator's awareness. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md).

---

## Files

| File | What it does |
|---|---|
| **`build-demo.js`** | Main orchestrator. Lead → fetch old site → `extract` → compose `site.config.json` → build folder → `deploy-vercel`. Emits a `RESULT {…}` JSON line for n8n. |
| **`extract.js`** | Pulls `name, services[], phone, hours, address, emails, testimonials[], primary_color, accent_color, logo_url, tagline, about` from the fetched HTML with regex heuristics. Optional **vision** gap-fill (mShots screenshot + `VISION_*` model) for hard cases. |
| **`deploy-vercel.js`** | Deploys the built folder via the Vercel REST API using `VERCEL_TOKEN`. **No token → graceful no-op** (leaves the static folder + prints where it is). |
| `package.json` | CommonJS, Node ≥ 18, npm scripts. |
| `.gitignore` | Ignores `build/`, `.env.local`, `node_modules/`. |

No dependencies — Node 18+ built-in `fetch` only. Secrets are loaded from
`../.env.local` (git-ignored); nothing is hardcoded.

---

## Usage

```bash
# From a scraper CSV (1-based data row, header excluded)
node build-demo.js --csv ../scraper/leads-SOUTH-Ugly-2026-07-07-1955.csv --row 1

# Select a specific row by phone or place_id, and pass the real Convex lead id
node build-demo.js --csv ../scraper/leads-...csv --phone "(555) 010-0142"
node build-demo.js --csv ../scraper/leads-...csv --place-id ChIJ... --lead-id <convexLeadId>

# From CLI args (no CSV)
node build-demo.js --name "Acme Plumbing" --phone "(555) 123-4567" \
     --website https://acmeplumbing.com --niche plumber --city Phoenix --state AZ

# Build only, don't deploy (great for local preview)
node build-demo.js --csv ../scraper/leads-...csv --row 1 --no-deploy
```

### Flags

| Flag | Meaning |
|---|---|
| `--csv <file>` | Scraper CSV (absolute, or relative to cwd / `scraper/`). |
| `--row N` / `--phone P` / `--place-id ID` | Which CSV row to build (default `--row 1`). |
| `--name / --phone / --website / --niche / --city / --state / --zip / --address` | Build straight from args (no CSV). |
| `--lead-id <id>` | Convex `leads._id` to embed in `tracking` (n8n passes the real one). |
| `--out <dir>` | Output base (default `generator/build`). |
| `--no-deploy` | Build the folder; skip the Vercel call. |
| `--vision` | Allow the `VISION_*` model to gap-fill hard cases (missing name/brand). |

### Output

A folder at `generator/build/<slug>/` containing:

```
<slug>/
├── index.html          ← the niche template, config injected (window.SITE_CONFIG)
├── _shared/            ← bundled runtime (styles.css, render.js, beacon.js) — self-contained
├── site.config.json    ← the composed contract (also read by other pipeline steps)
└── result.json         ← machine-readable build summary
```

`build-demo.js` also prints a single `RESULT {…}` line to stdout with
`demo_url`, `short_url`, `folder`, `lead_id`, `deployed`, etc. — the field n8n
captures to set `demos.demo_url` / `demos.short_url` and flip `leads.status`.

---

## How the template gets filled

The `templates/<niche>` apps render **client-side** from a config object,
resolved as `window.SITE_CONFIG` → inline `<script id="site-config">`. So the
generator, per template niche:

1. **Copies** `templates/<niche>/*` into the build folder (index.html at root).
2. **Bundles** `templates/_shared/*` as a local `_shared/` and rewrites the
   template's `../_shared/…` references to `_shared/…` so the folder is
   **self-contained** and deployable as a plain static site.
3. **Injects** the composed config two ways (belt-and-suspenders): a
   `window.SITE_CONFIG = {…}` script right before `render.js`, **and** a refresh
   of the inline `#site-config` JSON block. All `<` are escaped so a scraped
   value can never break out of the tag.
4. **Writes** `site.config.json` (the contract artifact).

If `templates/<niche>` is ever missing, the generator renders its own
**built-in modern responsive demo** from the same config (so the pipeline is
never blocked). Either path embeds the **30-second view beacon** the tracker
expects (`tracking.beacon_url` + `tracking.lead_id`).

---

## Data precedence (fallback strategy)

The ugly-site set is full of dead / blocked / placeholder pages, so we always
emit a complete demo by merging three sources:

| Field | Source order |
|---|---|
| `name`, `phone`, `address`, `city`, `state`, `zip` | **Google/CSV** (clean ground truth) → scraped → default |
| `services`, `hours`, `tagline`, `about`, `logo`, `colors`, `testimonials` | **Scraped from site** → CSV → **niche defaults** |
| `hero_headline` | Crafted modern headline from niche + city (we don't reuse the old site's) |

- **Services** fall back to niche defaults if fewer than 3 real ones are found.
- **Testimonials**, when none are scraped, are clearly-generic placeholders
  ("*{City} Homeowner*", "*Verified Customer*") for the demo owner to replace —
  we never fabricate a specific named review.
- **Hours**, when none are found, use a soft Mon–Fri default the owner can tweak.
- **Niche** is normalized to the 3 supported templates (`electrician`/`hvac`/
  `plumber`); off-core trades (roofing, contractor, …) coerce to the nearest
  template and use generic trade copy (a console note is printed).

---

## `extract.js` standalone

```bash
node extract.js https://some-old-electric-site.com            # heuristics only → JSON
node extract.js https://some-old-electric-site.com --vision   # + vision gap-fill (needs VISION_*)
```

The **vision pass** only runs on hard cases (no name / no brand color / thin
services), screenshots the site with free WordPress **mShots**, and asks an
OpenAI-compatible model (`VISION_BASE_URL` / `VISION_MODEL` / `VISION_API_KEY` —
same provider-agnostic pattern as `scraper/find-ugly-sites.js`) to read the
brand. Vision only **fills gaps**; heuristics always win when present.

---

## `deploy-vercel.js`

```bash
node deploy-vercel.js ./build/<slug> --name <slug> --prod            # deploy a folder
node deploy-vercel.js ./build/<slug> --alias <slug>.demo.yourdomain.com
```

- Uploads every file (`POST /v2/files`, deduped by sha1), creates a static
  deployment (`POST /v13/deployments`, `framework: null`), polls to `READY`, and
  optionally attaches a friendly alias (`{slug}.DEMO_SUBDOMAIN_SUFFIX`).
- **No `VERCEL_TOKEN` → no-op**: prints the folder path and returns
  `{ deployed:false }` so the caller keeps the static folder (open `index.html`
  locally, or deploy later). Any API error is caught the same way — the build is
  never lost.

---

## Environment (`../.env.local`)

Loaded automatically (no dependency). Relevant keys (see
[`../.env.example`](../.env.example)):

| Var | Used for |
|---|---|
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | Deploy auth / team scope (missing token = no-op). |
| `PUBLIC_DOMAIN` | Builds `tracking.beacon_url` (`/api/beacon`) and `short_url` (`/r/{lead_id}`). |
| `DEMO_SUBDOMAIN_SUFFIX` | Friendly alias host `{slug}.<suffix>`. |
| `VISION_BASE_URL`, `VISION_MODEL`, `VISION_API_KEY` | Optional vision gap-fill (`--vision`). |

`lead_id` comes from `--lead-id` (the real Convex `leads._id`, passed by n8n);
standalone runs fall back to the lead's `place_id`, then a phone-derived id.

---

## n8n / programmatic use

Everything is exported for `require()`:

```js
const { composeConfig, buildFolder, renderStaticSite, selectLead, fetchSite, normalizeNiche } = require('./build-demo');
const { extract } = require('./extract');
const { deployFolder } = require('./deploy-vercel');
```

For orchestration, the simplest path is to shell out to `build-demo.js` and
parse the `RESULT {…}` stdout line.
