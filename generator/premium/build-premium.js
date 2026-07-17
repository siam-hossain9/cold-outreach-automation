#!/usr/bin/env node
/**
 * build-premium.js — one scraped lead → a live rebuild demo on a PREMIUM template.
 * ============================================================================
 *   lead (CSV row or CLI flags)
 *     → deep-extract the old site (real facts + real photo URLs)   [deep-extract.js]
 *     → gate the photos (junk filter + AI quality, real-or-nothing) [image-gate.js]
 *     → reskin the niche's premium template (identity + facts + photos) [reskin.js]
 *     → deployable folder  → (optional) Vercel                      [deploy-vercel.js]
 *
 * Ground truth (name/phone/city/state) always comes from Google/CSV; the old
 * site only ADDS real colour (services, areas, license, year, photos). Missing
 * facts fall back to the template's tasteful defaults.
 *
 * USAGE
 *   node build-premium.js --name "KDM Electric Inc" --phone "(318) 487-2074" \
 *        --website https://kdmelectricllc.com --niche electrician --city Alexandria --state LA
 *   node build-premium.js --csv ../../scraper/leads-SOUTH-...csv --row 1
 *   (add --no-deploy to build only, --no-vision to skip the AI photo gate)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const { buildPremiumFolder, resolveNiche, normalizeLeadInfo } = require('./reskin');
const { gateAndDownload } = require('./image-gate');
const { extractRich } = require('../deep-extract');

const ROOT = path.resolve(__dirname, '..', '..');
(function loadEnv(f) { let t; try { t = fs.readFileSync(f, 'utf8'); } catch (_) { return; }
  for (const l of t.split(/\r?\n/)) { const s = l.trim(); if (!s || s.startsWith('#')) continue; const e = s.indexOf('='); if (e < 0) continue; const k = s.slice(0, e).trim(); if (!k || process.env[k] != null) continue; let v = s.slice(e + 1).trim(); if ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'"))) v = v.slice(1, -1); else { const h = v.indexOf(' #'); if (h >= 0) v = v.slice(0, h).trim(); } process.env[k] = v; }
})(path.join(ROOT, '.env.local'));

function parseArgs(argv) {
  const f = {}; for (let i = 2; i < argv.length; i++) { const a = argv[i]; if (a.startsWith('--')) { const k = a.slice(2); const v = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : true; f[k] = v; } } return f;
}
function slugify(s) { return String(s || 'demo').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'demo'; }
function hostDomain(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch (_) { return ''; } }

// Build the reskin's leadInfo from Google/CSV ground truth + deep-extract facts.
const US_STATES = new Set(['alabama','alaska','arizona','arkansas','california','colorado','connecticut','delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa','kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan','minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire','new jersey','new mexico','new york','north carolina','north dakota','ohio','oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota','tennessee','texas','utah','vermont','virginia','washington','west virginia','wisconsin','wyoming']);
// drop non-city "areas": the state itself, bare state abbr, or generic words
function cleanAreas(areas, state) {
  const st = String(state || '').toLowerCase();
  return (Array.isArray(areas) ? areas : []).map((a) => String(a || '').trim()).filter((a) => {
    const k = a.toLowerCase();
    if (a.length < 2) return false;
    if (US_STATES.has(k)) return false;
    if (k === st) return false;
    if (/\b(area|county|parish|region|surrounding|nearby|and)\b/i.test(k) && a.split(/\s+/).length <= 1) return false;
    return true;
  });
}

function composeLeadInfo(lead, rich) {
  const info = (rich && rich.ok && rich.info) ? rich.info : {};
  const li = {
    name: lead.name,
    phoneDisplay: lead.phone,
    city: lead.city,
    state: lead.state,
    domain: hostDomain(lead.website) || undefined,
    email: info.email || undefined,
    serviceAreas: cleanAreas(info.service_areas, lead.state),
    license: info.license || '',
    yearFounded: info.years_established || null,
    ownerName: info.owner_name || '',           // deep-extract may add this later
    ownerTitle: info.owner_title || '',
  };
  return li;
}

// Give kept photos captions if the AI didn't, using the lead's real services.
function captionPhotos(kept, info, city) {
  const svc = (info && Array.isArray(info.services) ? info.services : []).map((s) => (s && s.name) || '').filter(Boolean);
  return kept.map((p, i) => {
    if (!p.caption) p.caption = svc[i] ? `${svc[i]}${city ? ' · ' + city : ''}` : (city ? `${city} project` : 'Recent work');
    p.alt = p.alt || p.caption;
    return p;
  });
}

async function buildForLead(lead, opts = {}) {
  const niche = resolveNiche(lead.niche);
  const outBase = opts.out || path.join(__dirname, 'build');
  const slug = opts.slug || slugify(lead.name || lead.phone || 'demo');
  const outDir = path.join(outBase, slug);
  const workDir = path.join(os.tmpdir(), 'premium-photos-' + slug);
  const log = opts.log || (() => {});

  // 1) deep-extract the old site (facts + real photo URLs)
  let rich = { ok: false, images: [] };
  if (lead.website && opts.extract !== false) {
    log('🕸️  deep-extracting ' + lead.website + ' …');
    try { rich = await extractRich(lead.website, lead.name, niche); }
    catch (e) { log('   extract failed: ' + e.message); }
    if (rich.ok) log(`   got ${(rich.info.services || []).length} services, ${rich.images.length} candidate photos`);
  }

  // 2) gate the scraped photos (junk filter + AI quality; real-or-nothing)
  let kept = [];
  if ((rich.images || []).length && opts.vision !== false) {
    log('🖼️  gating ' + rich.images.length + ' candidate photos …');
    const g = await gateAndDownload(niche, rich.images, workDir, opts.maxPhotos || 4);
    kept = captionPhotos(g.kept, rich.info, lead.city);
    log(`   kept ${kept.length}/${g.considered}` + (kept.length ? ' — ' + kept.map((k) => `${k.w}x${k.h}`).join(', ') : ' (using template stock)'));
  }

  // 3) reskin the premium template into a deployable folder
  const leadInfo = composeLeadInfo(lead, rich);
  leadInfo.realPhotos = kept;
  log('🎨  reskinning premium ' + niche + ' template …');
  const built = buildPremiumFolder(niche, leadInfo, outDir);

  // 3b) AI receptionist — build the business context, inject the live widget, push to Convex
  if (opts.receptionist !== false && lead.lead_id) {
    try {
      const bctx = buildReceptionistContext(lead, rich, niche, built.leadInfo || leadInfo);
      const site = (process.env.CONVEX_SITE_URL || '').replace(/\/$/, '');
      if (site) {
        // Same standard widget on EVERY niche (accent tints it to match the template).
        const ACCENTS = { electrician: '#C6F03A', hvac: '#1B83C9', plumber: '#F0682B', roofing: '#D8392B' };
        const cfg = { leadId: lead.lead_id, chatUrl: site + '/chat', businessName: bctx.business_name, agentName: bctx.agent_name, accent: ACCENTS[niche] || '#4ade80' };
        if (process.env.RETELL_API_KEY) cfg.voiceUrl = site + '/voice/start';   // Call button appears only once voice is configured
        const widget = fs.readFileSync(path.join(__dirname, 'receptionist-widget.html'), 'utf8');
        // 30-second "real look" beacon: fires once the lead has genuinely engaged with the
        // page (30s of VISIBLE time, not just an open), and again on exit with the true
        // dwell time. Powers the dashboard's view stats + the "they actually read it" signal.
        const beacon = '<script>(function(){var L=' + JSON.stringify(lead.lead_id) + ',B=' + JSON.stringify(site + '/beacon') + ';'
          + 'if(!L||!B)return;var t=0,last=Date.now(),sent=false;'
          + 'function tick(){if(document.visibilityState==="visible"){t+=Date.now()-last;}last=Date.now();'
          + 'if(!sent&&t>=30000){sent=true;send(t);}}'
          + 'function send(ms){try{var b=JSON.stringify({leadId:L,duration_ms:Math.round(ms)});'
          + 'if(navigator.sendBeacon){navigator.sendBeacon(B,new Blob([b],{type:"application/json"}));}'
          + 'else{fetch(B,{method:"POST",headers:{"Content-Type":"application/json"},body:b,keepalive:true});}}catch(e){}}'
          + 'setInterval(tick,1000);document.addEventListener("visibilitychange",tick);'
          + 'window.addEventListener("pagehide",function(){tick();if(!sent&&t>=5000){sent=true;send(t);}});'
          + '})();</script>\n';
        const inject = '<script>window.__RECEPTIONIST__=' + JSON.stringify(cfg) + ';</script>\n'
          + '<style>#pfbot-root{display:none!important}</style>\n' + widget + '\n' + beacon;   // hide any template-native widget
        const idxPath = path.join(outDir, 'index.html');
        let html = fs.readFileSync(idxPath, 'utf8');
        html = html.replace('</body>', inject + '</body>');
        fs.writeFileSync(idxPath, html, 'utf8');
        await pushBusinessContext(lead.lead_id, bctx, log);
        log('   🤖 AI receptionist wired (' + bctx.agent_name + ', ' + niche + ')' + (cfg.voiceUrl ? ' + voice' : ' — chat only (no Retell key yet)'));
      }
    } catch (e) { log('   receptionist wiring skipped: ' + e.message); }
  }

  // machine-readable summary
  const result = {
    ok: true, niche, template: built.template, slug,
    folder: outDir, index: path.join(outDir, 'index.html'),
    photos_used: built.report.photosPlaced, service_areas: built.report.serviceAreasUsed,
    extracted: rich.ok || false, license: leadInfo.license || null, year_founded: leadInfo.yearFounded || null,
    lead_id: lead.lead_id || lead.place_id || null, channel: lead.channel || null, deployed: false, demo_url: null,
  };

  // 4) optional deploy (public by default — a lead must be able to open the link)
  if (opts.deploy) {
    try {
      const { deployFolder } = require('../deploy-vercel');
      const dep = await deployFolder(outDir, { name: slug, prod: true, log });
      if (dep && dep.deployed) { result.deployed = true; result.demo_url = dep.url || dep.vercelUrl || null; result.deployment_id = dep.deploymentId || null; }
      else if (dep && dep.error) result.deploy_error = dep.error;
    } catch (e) { log('   deploy skipped: ' + e.message); }
  }

  // 5) record the live demo in Convex (enqueue -> setReady -> lead becomes demo_ready)
  if (opts.convex !== false && result.deployed && result.demo_url && lead.lead_id) {
    const cx = await pushDemoToConvex(lead.lead_id, result, log);
    if (cx.pushed) { result.convex = true; result.short_url = cx.short_url; result.demo_id = cx.demoId; }
    else result.convex_error = cx.reason || cx.error;
  }

  fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

// Push the finished demo to Convex: enqueue a demos row, mark it ready with the live
// URL, which flips the lead to demo_ready. Non-fatal — a build is never lost on failure.
async function pushDemoToConvex(leadId, result, log) {
  const CONVEX_URL = process.env.CONVEX_URL;
  if (!CONVEX_URL || /your-new-deployment/.test(CONVEX_URL)) return { pushed: false, reason: 'no CONVEX_URL' };
  let ConvexHttpClient, makeFunctionReference;
  try { ({ ConvexHttpClient } = require('convex/browser')); ({ makeFunctionReference } = require('convex/server')); }
  catch (_) { return { pushed: false, reason: 'convex package not installed' }; }
  try {
    const client = new ConvexHttpClient(CONVEX_URL);
    const enq = await client.mutation(makeFunctionReference('demos:enqueue'), { leadId });
    // The link we TEXT must be the tracked one (/r/{leadId}) — it logs the open, ticks
    // the Close "Demo Clicked" flag, schedules follow-up B, then 302s to the real demo.
    // Prefer a pretty custom domain if configured; otherwise use our Convex site, which
    // serves /r/ natively. Only fall back to the raw (untracked) demo URL if neither exists.
    const dom = process.env.PUBLIC_DOMAIN;
    const site = (process.env.CONVEX_SITE_URL || '').replace(/\/$/, '');
    const short_url = (dom && !/example\.com|your-?domain|your-?deployment/i.test(dom))
      ? `https://${dom}/r/${leadId}`
      : (site ? `${site}/r/${leadId}` : result.demo_url);
    if (short_url === result.demo_url) log('   ⚠ NOT tracked — no CONVEX_SITE_URL/PUBLIC_DOMAIN; clicks will not be recorded');
    await client.mutation(makeFunctionReference('demos:setReady'), {
      demoId: enq.demoId, demo_url: result.demo_url, short_url,
      vercel_deployment_id: result.deployment_id || undefined,
    });
    log('   ✔ Convex: demo recorded → lead is demo_ready');
    return { pushed: true, demoId: enq.demoId, short_url };
  } catch (e) { log('   ⚠ Convex push skipped: ' + e.message); return { pushed: false, error: e.message }; }
}

// ── lead selection (CLI flags, or a CSV row via build-demo's selectLead) ──────
function leadFromFlags(f) {
  return { name: f.name || '', phone: f.phone || '', website: f.website || f.url || '', niche: f.niche || 'electrician', city: f.city || '', state: f.state || '', zip: f.zip || '', address: f.address || '', place_id: f['place-id'] || '', lead_id: f['lead-id'] || '', channel: f.channel || '' };
}

async function main() {
  const f = parseArgs(process.argv);
  let lead;
  if (f.csv) { const { selectLead } = require('../build-demo'); lead = selectLead(f); }
  else lead = leadFromFlags(f);
  if (!lead || !lead.name) { console.error('need a lead: pass --name (+--phone/--website/--niche/--city/--state) or --csv <file> --row N'); process.exitCode = 1; return; }

  const opts = {
    out: f.out ? path.resolve(f.out) : undefined,
    deploy: !(f['no-deploy'] === true),
    vision: !(f['no-vision'] === true),
    extract: !(f['no-extract'] === true),
    convex: !(f['no-convex'] === true),
    slug: f.slug,
    log: (m) => console.log(m),
  };
  const r = await buildForLead(lead, opts);
  console.log('\n✅ built ' + r.template + ' demo for "' + lead.name + '"');
  console.log('   folder:      ' + r.folder);
  console.log('   real photos: ' + r.photos_used + (r.extracted ? '' : ' (old site not readable — identity + stock)'));
  console.log('   deployed:    ' + (r.deployed ? r.demo_url : 'no (open index.html locally, or drop --no-deploy)'));
  console.log('\nRESULT ' + JSON.stringify(r));
}

// ── AI receptionist: build the prompt-ready business context for the widgets ──
// One consistent assistant across every niche (name via ASSISTANT_NAME, default "Alex");
// it's grounded in each lead's own business + niche, not a different persona per sector.
function buildReceptionistContext(lead, rich, niche, leadInfo) {
  const info = (rich && rich.ok && rich.info) ? rich.info : {};
  const name = lead.name || info.business_name || 'the business';
  const city = lead.city || '';
  const phone = lead.phone || '';
  let services = (Array.isArray(info.services) ? info.services : []).map((s) => (s && s.name) || s).filter((x) => typeof x === 'string' && x).slice(0, 10);
  if (!services.length) {
    const DEF = {
      electrician: ['panel upgrades', 'EV charger installs', 'rewiring', 'lighting', 'generators'],
      hvac: ['AC repair', 'heating repair', 'installs', 'tune-ups', 'duct work'],
      plumber: ['drain cleaning', 'water heaters', 'leak repair', 'repiping', 'fixtures'],
      roofing: ['roof replacement', 'storm & hail repair', 'insurance claim help', 'inspections', 'gutters'],
    };
    services = DEF[niche] || ['repairs', 'installs', 'service calls'];
  }
  const serviceArea = (leadInfo && leadInfo.regionName) || (Array.isArray(info.service_areas) && info.service_areas.length ? info.service_areas.join(', ') : '');
  const hours = typeof info.hours === 'string' ? info.hours : (info.hours && typeof info.hours === 'object' ? Object.entries(info.hours).map(([d, h]) => `${d}: ${h}`).join(', ') : '');
  const license = info.license || '';
  const agent = process.env.ASSISTANT_NAME || 'Alex';
  const trade = niche === 'hvac' ? 'HVAC company' : niche;

  const system_prompt =
`You are ${agent}, the friendly AI receptionist for ${name}, a ${trade}${city ? ' in ' + city : ''}${serviceArea ? ' serving ' + serviceArea : ''}.

BUSINESS INFO (only use what's listed; never invent details):
- Phone: ${phone}
- Services: ${services.join(', ')}${hours ? '\n- Hours: ' + hours : ''}${license ? '\n- ' + license : ''}

HOW YOU HELP:
1. Answer visitor questions warmly and BRIEFLY (1-2 sentences), like a real small-business receptionist - never a corporate bot, no jargon.
2. For pricing, give a rough range and add "for an exact quote let's book a quick visit." Never invent exact prices.
3. If the visitor shows ANY service intent (a problem, scheduling, or a price question), offer to help: "Can I grab your name and a good number so the team can text you right back?"
4. The MOMENT you have BOTH a name and a phone number, output EXACTLY this and nothing else:
[[LEAD_CAPTURED:{"name":"<name>","phone":"<phone>","service":"<what they need>","urgency":"emergency|urgent|routine","summary":"one short line"}]]
5. Never make up services, hours, or prices not listed above. Keep every reply short.
6. If asked whether you're real, be honest: you're ${name}'s AI receptionist and you'll pass their info straight to the team.`;

  const retell_dynamic_vars = {
    business_name: name, agent_name: agent, niche: trade, city,
    services: services.join(', '), hours: hours || 'call for hours',
    phone, service_area: serviceArea || city,
  };

  return {
    business_name: name, niche, phone, city, services,
    service_area: serviceArea || undefined, hours: hours || undefined,
    agent_name: agent, system_prompt, retell_dynamic_vars,
    owner_phone: phone,
  };
}

async function pushBusinessContext(leadId, ctx, log) {
  const CONVEX_URL = process.env.CONVEX_URL;
  if (!CONVEX_URL) return { pushed: false };
  let ConvexHttpClient, makeFunctionReference;
  try { ({ ConvexHttpClient } = require('convex/browser')); ({ makeFunctionReference } = require('convex/server')); }
  catch (_) { return { pushed: false, reason: 'convex pkg missing' }; }
  const clean = {}; for (const [k, v] of Object.entries(ctx)) if (v !== undefined) clean[k] = v;
  try {
    const client = new ConvexHttpClient(CONVEX_URL);
    await client.mutation(makeFunctionReference('businessContexts:upsert'), { leadId, ...clean });
    return { pushed: true };
  } catch (e) { if (log) log('   business_context push failed: ' + e.message); return { pushed: false, error: e.message }; }
}

module.exports = { buildForLead, composeLeadInfo, captionPhotos, buildReceptionistContext };

if (require.main === module) main().catch((e) => { console.error('Fatal:', e.message); process.exitCode = 1; });
