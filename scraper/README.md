# Ugly-Site Lead Scraper

Finds US **trade businesses that already have a website — but an outdated / ugly one** — so
they can be pitched a free rebuild demo. This is **product line 2** of the the outreach model:
the mirror image of the no-website scraper (which sells a *first* site).

> **no-website business → sell a first site** (the outreach, line 1)
> **has an ugly website → sell a rebuild** (this scraper, line 2)

Built from scratch for this project. Cheapest viable stack: **Google Places (free) + raw HTML
heuristics (free)**. Optional Google PageSpeed/Lighthouse (free, same key) for a stronger score.
No paid screenshot/vision service needed.

---

## How it works (two stages, one pass)

```
1. FIND    Google Places (New) Text Search, per niche × area
              keep: has phone + has a REAL website + OPERATIONAL + not a chain/supplier
2. GRADE   fetch each site's HTML → ugliness score 0-100 (LOWER = uglier)
              signals: no HTTPS, no mobile viewport, tables/frames/marquee/<font>,
              Flash, old jQuery, dated fonts, stale copyright, dead site …
              (optional) + PageSpeed mobile perf / best-practices / SEO
           keep only score < uglyThreshold (default 55)  →  leads-*.csv
```

Every lead is tagged **`Channel = TEXT / CALL-ONLY`** by state (from the the outreach legal map),
so downstream you never text a lawsuit state.

## Quick start

```bash
cd "e:/N8N/old website/scraper"

node find-ugly-sites.js --test                 # 1) verify the Google API key
node find-ugly-sites.js --grade https://example.com   # 2) test the grader on any URL (no quota)
node find-ugly-sites.js                          # 3) full scrape+grade per config.local.json
node find-ugly-sites.js --lighthouse             #    same, but also run PageSpeed per site
node find-ugly-sites.js --vision                 #    also run the AI-vision check on ugly leads
node find-ugly-sites.js --grade <url> --vision   #    test HTML + vision on one URL (no quota)
node find-ugly-sites.js "Mesa AZ" electrician    #    override area + niche from CLI
```

Output: `leads-<Area>-Ugly-<date>-<HHMM>.csv`, ugliest first, with `Ugly Score` + `Ugly Reasons`
(the reasons feed the SMS `{ugly_reason}` placeholder).

## Config (`config.local.json`)

| Key | Meaning |
|-----|---------|
| `googleApiKey` | Places API (New) key — also powers PageSpeed. (or env `GOOGLE_API_KEY`) |
| `areas` | sub-areas to search each niche in (ZIPs/suburbs beat Google's 60-result cap) |
| `niches` | trade searches, e.g. `electrician`, `HVAC`, `plumber` |
| `perNiche` | candidates to grade per niche per area (best-reviewed first) |
| `uglyThreshold` | keep leads scoring **below** this (default 55; lower = uglier) |
| `minReviews`/`maxReviews` | review band (5 = drop ghosts; 0 = off) |
| `useLighthouse` | `true` = also run PageSpeed mobile (stronger score, slower) |
| `excludeNames` / `excludeFiles` / `autoDedup` | chain filter + phone dedup vs prior `leads-*.csv` |

## The ugliness rubric

Each site starts at **100** and loses points per ugly signal (kept if final score < threshold):

| Signal | Penalty |
|---|---|
| No HTTPS | −25 |
| No mobile viewport meta | −25 |
| Frames-based layout | −20 |
| Marquee/blink · Flash | −15 each |
| Table-based layout (3+ tables, no semantic tags) | −15 |
| `<font>` tags | −12 |
| No responsive CSS · stale copyright (≥4 yrs old) | −10 each |
| Dated fonts (Times/Comic Sans) | −8 |
| `<center>` · old jQuery · `document.write` | −5/6 each |
| **Dead / unreachable site** | fixed score 20 (flagged) |
| *(with `--lighthouse`)* slow perf / weak best-practices / poor SEO | −6 to −8 each |

## Cost

- **Google Places:** free ~5,000 searches/mo, then ~$32/1k. One search ≈ 20 businesses.
- **HTML grading:** free (plain HTTP GET per site).
- **PageSpeed (optional):** free with key (generous daily quota).
- **≈ $0 per 1,000 leads** within the free tiers.

> Set a **$5 billing budget alert** in Google Cloud and verify real quotas in the Console —
> the free tiers are per-SKU and can change.

## Notes

- `config.local.json` and `leads-*.csv` are git-ignored (keys + business PII). Keep them out of commits.
- Compliance is downstream: only text `Channel=TEXT` leads, honor opt-outs, never text avoid states.
