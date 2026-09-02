# Premium Templates — Ugly-Website Rebuild

The trade-specific demo templates the generator reskins into a lead's custom rebuild.
Each is a **single-file cinematic HTML site** (hand-written HTML/CSS/vanilla JS, no
build step, mostly self-contained) vendored from `VoltarisLabs/Web_Project`. Every
template ships with a fictional **demo brand** that the generator swaps out per lead.

> The generator never edits these by hand — it reads `../manifests/<niche>.json`
> (the exact demo-brand tokens, verified against each file) and does a deterministic
> identity + real-facts + real-photos swap. See [`../README.md`](../README.md).

---

## The three templates

### ⚡ `11-electrical` — electrician
- **Demo brand:** Voltline Electric · Seattle, WA · `(206) 555-0117`
- **Archetype:** dark, kinetic-editorial. Near-black `#111110`, warm-bone `#ECE7DB`, one **electric-lime** accent `#C6F03A`, brass stars. Oversized display type.
- **Fonts:** Chakra Petch (display) · Inter (body) · Space Mono (labels)
- **Build:** `layout.html` — the newest build. **Self-hosted images** in `assets/_img/` (10 local JPGs, no hotlinking), plus an **on-page AI assistant widget** (self-contained, no backend).
- **Sections (8):** services · gallery (7-card bento) · credentials/licensing · pricing · reviews · service area · FAQ · booking
- **Real-photo slots:** 4 gallery cards (a lead's real job photos drop in here)
- **Signature:** interactive service rows (hover → photo swaps), 24/7 emergency framing, upfront pricing

### ❄️ `03-hvac` — HVAC
- **Demo brand:** TrueComfort Heating & Air · Kansas City, MO · `(816) 555-0142`
- **Archetype:** comfort-tech polish on a **dark immersive** hero. Cool-blue `#1B83C9` → warm-orange `#EE7A2B` duality expressed as a **thermostat-dial gauge** (inline SVG — the hero is the dial, not a photo).
- **Fonts:** Poppins (display) · Open Sans (body)
- **Build:** `layout.html`. **Fully self-contained via remote assets** (Pexels images + Google Fonts + inline SVG) — no local asset folder.
- **Sections:** utility bar · transparent→solid header · dial hero · stats · Cooling|Heating split services · why-us · **Comfort Club membership** · process timeline · reviews · service area · FAQ · booking
- **Real-photo slots:** 1 (the "why" section photo) — the SVG-dial hero has no photo slot
- **Signature:** thermostat-dial hero, cooling/heating split, membership banner

### 🔧 `01-plumber` — plumber
- **Demo brand:** The Family Plumber · Los Alamitos, CA · `(555) 010-0199`
- **Archetype:** trust-forward family service. Deep-marine `#143A5A` + warm-orange CTA `#F0682B`. Signature **live service-area map** with animated pins.
- **Fonts:** Hanken Grotesk (display) · Inter (body)
- **Build:** `layout.html`. **Self-hosted** local assets in `img/` (hero video + job photos).
- **Sections:** utility bar · hero (split + award badge) · trust bar · scroll-driven services rail · auto-rotating review deck · live service-area map · about (owner monograms) · FAQ · quote · lead-capture chat widget
- **Real-photo slots:** 3 gallery cards
- **Signature:** live map, liquid-glass service cards, monogram logo (uses the lead's initials)

---

## How the generator reskins a template

For a lead it swaps, deterministically (manifest-driven):
1. **Identity** — brand name (all entity forms), short brand / monogram, domain, email, phone (display + `tel:` + form placeholder)
2. **Geography** — city, state, region phrase, and the demo's neighborhoods → the lead's real service areas
3. **Real facts** (when known from the deep-scrape) — license #, owner name/title, "since {year}"
4. **Real photos** — the lead's own job photos, gated by AI (real-or-nothing), into the gallery slots
5. **Residual guard** — throws if any demo-brand token survives, so a half-swapped demo can never ship

Everything else — the template's rich content (reviews, pricing, FAQ, copy) — is **kept**.

---

## Coverage & notes

| Niche | Template | Images | Photo slots | Status |
|---|---|---|---|---|
| electrician | `11-electrical` | self-hosted | 4 | ✅ validated (Northside) |
| hvac | `03-hvac` | remote (Pexels) | 1 | ✅ validated |
| plumber | `01-plumber` | self-hosted | 3 | ✅ validated |

- These are **vendored copies** — re-sync from `VoltarisLabs/Web_Project` when the source
  templates change.
- **Known template quirks** (handled by the manifests): the electrical `layout.html` shipped
  with a leftover plumber phone `(555) 010-0199` (scrubbed); the plumber template has demo
  owner names (Josh/Mike/Rick) generalized to Founder/Co-owner until real owner data.
- **15 more trades** exist in `Web_Project` (roofing, concrete, fencing, landscaping, junk
  removal, …). To add one: vendor the folder, author `../manifests/<niche>.json` against the
  real file, test that the residual guard passes.
