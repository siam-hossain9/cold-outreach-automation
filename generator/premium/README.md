# generator/premium/ — Premium-template Demo Generator

Turns **one scraped lead** into a **rebuild demo on one of the operator's premium
Web_Project templates** (single-file cinematic sites), fully automatically.

```
lead (CSV row / CLI / object)
  → deep-extract old site   (real facts + real photo URLs)   ../deep-extract.js
  → gate photos             (junk filter + AI quality, real-or-nothing)  image-gate.js
  → reskin premium template (identity + real facts + real photos)        reskin.js
  → deployable folder → (optional) Vercel                    ../deploy-vercel.js
```

**Recipe (locked with operator):** keep the template's rich content, swap in the
lead's **identity** + a few **real facts** (license, owner, year, service area),
and drop the lead's **real photos** into the gallery. Images are **real-or-nothing**
— no generation, no upscaling; if a lead has no usable photos, the template's
professional stock stays.

## Run

```bash
node build-premium.js --name "KDM Electric Inc" --phone "(318) 487-2074" \
     --website https://kdmelectricllc.com --niche electrician --city Alexandria --state LA --no-deploy

node build-premium.js --csv ../../scraper/leads-SOUTH-...csv --row 1        # from a scraper CSV
```

Flags: `--no-deploy` (build only), `--no-vision` (skip the AI photo gate),
`--no-extract` (skip deep-scrape — identity + stock only), `--out <dir>`, `--slug <s>`.

Output: `build/<slug>/` (`index.html` + `assets/` + `img/` + `result.json`) and a
`RESULT {…}` stdout line for n8n.

## Files

| File | Role |
|---|---|
| `reskin.js` | Manifest-driven reskin engine. Identity + facts + photos, with a **hard residual guard** (throws if any source token like `Voltline`/`Seattle` survives — a half-reskinned demo never ships). |
| `image-gate.js` | Download → junk filter (size/aspect/filename) → **AI quality+relevance gate** (Qwen vision, parallel). Lenient on relevance/quality, strict on "is it a real photo". Vision optional (no key → junk-filter only). |
| `build-premium.js` | Orchestrator + CLI. Ground truth (name/phone/city/state) from Google/CSV; the old site only ADDS colour. |
| `manifests/<niche>.json` | Per-template source tokens, **verified against the actual template file**. |
| `templates/<dir>/` | Vendored premium templates (self-contained, deployable). |

## Niche coverage

| Niche | Template | Manifest | Status |
|---|---|---|---|
| electrician | `11-electrical` (new `layout.html`) | ✅ | **wired + validated** (reproduces KDM; 0 residuals; 4/12 photos kept) |
| hvac | `03-hvac` | ✅ | **wired + validated** (0 leftovers; SVG-dial hero, 1 "why" photo slot; all-remote assets) |
| plumber | `01-plumber` | ✅ | **wired + validated** (0 leftovers; 3 gallery photo slots; monogram logo). Owner-card names generalized (Founder/Co-owner) until real owner data — see note in `manifests/plumber.json`. |

## Adding a niche

1. Vendor the template folder into `templates/`.
2. Author `manifests/<niche>.json` — verify every source token against the file
   (brand full/short/domain/email, phones incl. any leftover master phone, city +
   state + area/neighborhood tokens, license sources longest→shortest, gallery
   `wi-front` img tags + captions, image strategy: self-hosted vs remote Pexels).
3. Test: `node build-premium.js --name … --niche <niche> --no-deploy` and confirm
   the residual guard passes.

## Notes

- **Sync templates:** these are vendored copies of `VoltarisLabs/Web_Project`. Re-copy
  when the operator updates a template there. (The electrical `layout.html` still had a
  leftover plumber phone `(562) 431-1960` upstream — the manifest scrubs it; worth
  fixing at the source too.)
- **Speed:** the vision gate is ~1 min/lead (parallelized, bounded concurrency). Fine
  for the current volume; swap `VISION_MODEL` for a faster one to scale.
