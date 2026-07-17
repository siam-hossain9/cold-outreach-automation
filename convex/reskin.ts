// ─────────────────────────────────────────────────────────────────────────────
// reskin.ts — CLOUD-NATIVE demo fill-in (ported from generator/premium/reskin.js).
//
// This is the "simple" build path: it takes a premium template's HTML + its token
// manifest + a lead's identity and swaps the template's placeholder business
// (e.g. "TrueComfort Heating & Air" in "Kansas City") for the real lead. It is
// PURE STRING WORK — no filesystem, no image downloads, no deploy — so it runs
// inside Convex. The template keeps its own professional imagery (served remotely
// or from Convex file storage), so there are no real photos to fetch.
//
// Kept deliberately faithful to reskin.js's swap ORDER (identity → phones →
// license → geography longest-first → facts → extras → residual guard) so demos
// come out identical to the Node builder, minus the lead's own photos.
// ─────────────────────────────────────────────────────────────────────────────

export type ReskinManifest = {
  niche: string;
  brand: { full: string; fullAliases?: string[]; short: string; shortIsMonogram?: boolean; domain: string; email: string };
  phones: { display: string; href: string; formPlaceholder: string };
  geo: {
    city: string; stateAbbr?: string;
    regionPhrases?: string[]; countyPhrase?: string;
    areasMultiWord?: string[]; areas?: string[];
  };
  license: { sources?: string[] };
  facts?: { credentialSubSource?: string; ownCrewsToken?: string; sinceAnchor?: string };
  extraReplacements?: Array<{ from: string; to: string }>;
  gallerySlots?: Array<{ imgTag: string; caption?: string }>;
  galleryImageDir?: string;
};

export type LeadLike = {
  name: string; phone: string;
  city?: string; state?: string;
  niche?: string;
};

const NICHE_ALIAS: Record<string, string> = {
  electrician: 'electrician', electric: 'electrician', electrical: 'electrician',
  hvac: 'hvac', 'heating-and-air': 'hvac', 'heating & air': 'hvac', ac: 'hvac',
  plumber: 'plumber', plumbing: 'plumber',
  roofing: 'roofing', roofer: 'roofing', roof: 'roofing',
};

export function resolveNiche(raw?: string): string {
  const k = String(raw || '').toLowerCase().trim();
  return NICHE_ALIAS[k] || 'electrician';
}

const esc = (s: unknown) => String(s == null ? '' : s);
const digits = (s: unknown) => String(s || '').replace(/\D/g, '');
function toHref(phoneDisplay: string) { const d = digits(phoneDisplay); return '+' + (d.length === 10 ? '1' + d : d); }
function areaCode(phoneDisplay: string) { const d = digits(phoneDisplay); const t = d.length === 11 ? d.slice(1) : d; return t.slice(0, 3) || '000'; }
function firstWord(name: string) { return String(name || '').trim().split(/\s+/)[0] || 'Demo'; }

const MONO_STOP = new Set(['the', 'and', 'of', 'a', 'an', 'inc', 'llc', 'co', 'corp', 'company', 'ltd', 'services', 'service', 'group']);
function monogramFromName(name: string) {
  const words = String(name || '').replace(/&/g, ' ').split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, '')).filter((w) => w && !MONO_STOP.has(w.toLowerCase()));
  if (!words.length) return 'XX';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
function domainFromName(name: string) { return String(name || 'demo').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '') + '.com'; }

type NormalizedLead = {
  name: string; short: string; monogram: string; domain: string; email: string;
  phoneDisplay: string; phoneHref: string; phonePlaceholder: string;
  city: string; state: string; county: string; regionName: string;
  serviceAreas: string[]; license: string; ownerName: string; ownerTitle: string;
  yearFounded: number | null;
};

function normalizeLeadInfo(raw: LeadLike & Record<string, any>): NormalizedLead {
  const name = esc(raw.name).trim() || 'Demo Company';
  const phoneDisplay = esc(raw.phoneDisplay || raw.phone).trim();
  const li: NormalizedLead = {
    name,
    short: esc(raw.short).trim() || firstWord(name),
    monogram: esc(raw.monogram).trim() || monogramFromName(name),
    domain: esc(raw.domain).trim() || domainFromName(name),
    email: esc(raw.email).trim() || ('office@' + domainFromName(name)),
    phoneDisplay,
    phoneHref: esc(raw.phoneHref).trim() || toHref(phoneDisplay),
    phonePlaceholder: esc(raw.phonePlaceholder).trim() || ('(' + areaCode(phoneDisplay) + ') 000-0000'),
    city: esc(raw.city).trim() || 'your area',
    state: esc(raw.state).trim() || '',
    county: esc(raw.county).trim() || '',
    regionName: esc(raw.regionName).trim(),
    serviceAreas: (Array.isArray(raw.serviceAreas) ? raw.serviceAreas : []).map((s: unknown) => esc(s).trim()).filter(Boolean),
    license: esc(raw.license).trim(),
    ownerName: esc(raw.ownerName).trim(),
    ownerTitle: esc(raw.ownerTitle).trim(),
    yearFounded: raw.yearFounded ? parseInt(raw.yearFounded, 10) : null,
  };
  if (!li.regionName) li.regionName = li.city + ' area';
  const seen = new Set([li.city.toLowerCase()]);
  li.serviceAreas = li.serviceAreas.filter((a) => { const k = a.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  return li;
}

/**
 * Reskin a template's HTML for a lead. Pure string transform.
 * Throws if any source identity token survives (a half-reskinned demo never ships).
 */
export function reskinHtml(manifest: ReskinManifest, htmlIn: string, leadRaw: LeadLike): { html: string; report: { niche: string; serviceAreasUsed: string[] } } {
  const li = normalizeLeadInfo(leadRaw);
  const m = manifest;
  let html = htmlIn;
  const swap = (a: string | undefined, b: string) => { if (a) html = html.split(a).join(b); };
  const report = { niche: manifest.niche, serviceAreasUsed: [] as string[] };

  // 1) identity — email, full brand (+alias forms), domain, short brand (order matters)
  swap(m.brand.email, li.email);
  swap(m.brand.full, li.name);
  for (const a of (m.brand.fullAliases || [])) swap(a, li.name);
  swap(m.brand.domain, li.domain);
  swap(m.brand.short, m.brand.shortIsMonogram ? li.monogram : li.short);

  // 2) phones
  swap(m.phones.display, li.phoneDisplay);
  swap(m.phones.href, li.phoneHref);
  swap(m.phones.formPlaceholder, li.phonePlaceholder);

  // 3) license — all sources → one line
  const licenseLine = li.license || 'Licensed and insured';
  for (const src of (m.license.sources || [])) swap(src, licenseLine);

  // 4) geography — phrases LONGEST-first, then areas, city, state
  const phrases: Array<{ from: string; to: string }> = [];
  if (m.geo.countyPhrase) phrases.push({ from: m.geo.countyPhrase, to: li.county || li.regionName });
  for (const rp of (m.geo.regionPhrases || [])) phrases.push({ from: rp, to: rp.startsWith('and ') ? ('and ' + li.regionName) : li.regionName });
  phrases.sort((a, b) => b.from.length - a.from.length);
  for (const p of phrases) swap(p.from, p.to);
  const targets = li.serviceAreas.length ? li.serviceAreas : [li.city];
  const areaSrcs = ([] as string[]).concat(m.geo.areasMultiWord || [], m.geo.areas || []);
  areaSrcs.forEach((src, i) => { const t = targets[i % targets.length]; swap(src, t); if (!report.serviceAreasUsed.includes(t)) report.serviceAreasUsed.push(t); });
  swap(m.geo.city, li.city);
  if (m.geo.stateAbbr && li.state) html = html.replace(new RegExp('\\b' + m.geo.stateAbbr + '\\b', 'g'), li.state);

  // 5) real facts — only when known
  if (li.ownerName && m.facts?.credentialSubSource) {
    const title = li.ownerTitle || 'Owner';
    swap(m.facts.credentialSubSource, `<span>${li.ownerName}, ${title}, bonded and insured.</span>`);
  }
  if (li.yearFounded) {
    if (m.facts?.ownCrewsToken) swap(m.facts.ownCrewsToken, '<b>+</b>Since ' + li.yearFounded);
    if (m.facts?.sinceAnchor) swap(m.facts.sinceAnchor, m.facts.sinceAnchor + ' Serving ' + li.regionName + ' since ' + li.yearFounded + '.');
  }

  // 5b) template-specific extras
  const subst = (s: string) => String(s).replace(/\{city\}/g, li.city).replace(/\{region\}/g, li.regionName).replace(/\{state\}/g, li.state).replace(/\{name\}/g, li.name).replace(/\{short\}/g, li.short).replace(/\{county\}/g, li.county || li.regionName);
  for (const er of (m.extraReplacements || [])) swap(er.from, subst(er.to));

  // 6) residual guard — no source identity token may survive
  const mustBeGone: Array<[string, string | undefined]> = [
    ['brand', m.brand.full], ['brand', m.brand.short], ['domain', m.brand.domain], ['email', m.brand.email],
    ['phone', m.phones.display], ['phoneHref', m.phones.href], ['city', m.geo.city],
    ...(m.geo.areasMultiWord || []).map((a) => ['area', a] as [string, string]),
    ...(m.geo.areas || []).map((a) => ['area', a] as [string, string]),
  ];
  const residuals = mustBeGone.filter(([, tok]) => tok && html.includes(tok)).map(([kind, tok]) => `${kind}:"${tok}"`);
  if (residuals.length) throw new Error('reskin residual tokens survived: ' + residuals.join(', '));

  return { html, report };
}
