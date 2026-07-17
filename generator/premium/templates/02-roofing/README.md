# Roofing Template 1

> Niche: **Roofing** · Serial: **02** · Slug: `02-roofing`
> Demo brand: **Ridgeline Roofing** (Dallas-Fort Worth), placeholder identity, swap per client.

## Design rationale

A **storm-tough, trust-forward** layout built on a **graphite/charcoal** base (`#1E2A33`) with a confident **storm-red CTA** (`#D8392B`) over warm **sand** neutrals (`#F4F1EC`). Charcoal reads as solid, established, and weatherproof; the red drives urgency on every call-to-action (call now, free inspection). Headings use **Hanken Grotesk**, body uses **Inter**, the same type system as the plumbing template, so the library feels like one brand of quality, while the palette and signature feature make roofing read as its own thing (not a recolored clone).

The page is engineered around two jobs: **get the storm-damage homeowner to call**, and **make them believe this roofer will handle the insurance claim.** That second angle is where roofing money lives, so "Insurance Claims Help" is a first-class service card and a dedicated step in the process section.

## Signature feature, the before/after roof slider

The element that distinguishes this template: an **interactive before/after slider** ("Drag to see the difference"). The homeowner drags a handle to wipe between an aging/storm-worn roof and a brand-new one. It's the roofing equivalent of the plumbing template's live service-area map, the moment that makes the page memorable. Built with a real `<input type="range">` underneath, so it works with **pointer, touch, and keyboard**, and it's user-driven (no looping background motion).

## Minimum-animation build

Per the brief (*simple, premium, professional, minimum background animation*), this template deliberately **drops the perpetual motion** from the plumbing template (no beam rails, glass sheen, auto-rotating review deck, or pulsing map pins). What's left is only meaningful, on-demand motion:

- Hide-on-scroll sticky header
- Subtle IntersectionObserver scroll-reveal (fade-up once, then done)
- FAQ accordion
- The user-driven before/after slider

**Every** animation is wrapped in a `prefers-reduced-motion: reduce` guard.

## Best for

- Residential roofers in a **storm/hail belt** (Texas, Oklahoma, Colorado, the Midwest) who win on storm-damage replacements
- Roofers who **handle insurance claims** (the strongest conversion angle in the niche)
- Shops that want to look **established and trustworthy** more than flashy
- Anyone selling primarily to homeowners **on mobile** (sticky click-to-call, big tap targets)

## Section order

utility bar → header → hero → trust bar → **services** (6-card grid) → why us → **before/after slider** → **process** (4 steps) → reviews → service area → FAQ → quote/CTA → footer → sticky mobile call

## How to reuse for a new client

1. Copy `layout.html` → `sites/{client-slug}/index.html`.
2. Fill the client's facts from their `client-configs/{slug}/business.json` + `content.json`: brand name (search `Ridgeline Roofing`), phone (search `+14695550188` and `(469) 555-0188`), email (`hello@ridgelineroofing.com`), service-area cities, services, FAQ answers, reviews.
3. Replace the **4 Pexels images** with the client's own job photos, especially the before/after pair (use **one real job**, before and after, so the slider is honest).
4. Update the warranty/cert claims (`50-year material warranty`, `licensed & insured`, `18 years`) to the client's real numbers.
5. Run the launch checklist in `DEV2-FULFILLMENT-GUIDE.md` before going live.

## Files

| File | Purpose |
|------|---------|
| `theme.json` | Colors, fonts, spacing, feature list |
| `layout.html` | Full single-file page (the buildable template) |
| `README.md` | This file, design rationale + best-for |
| `preview.png` | Full-page screenshot for client template-selection meetings |

## Honesty notes (read before selling)

- **Reviews are placeholders** (Danielle M. / Robert T. / Sandra A.). Replace with the client's **real, named Google reviews** only, never invent them.
- **Before/after images are illustrative stock** (two different North Texas roofs). The copy is written honestly ("an aging roof on the left, a new roof on the right", it does **not** claim it's the same house). For a real client, swap in **one real job's** before and after so it's true.
- **License, insurance, warranty, cert, and "18 years"** are placeholders, they are **client-supplied facts**. Never ship a roofing site claiming a license or warranty the client doesn't actually have.
- Phone is a safe fictional `(469) 555-0188`. Replace before any deploy.
